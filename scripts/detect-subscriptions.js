// ============================================================================
// Recurring Charge Detection Script
// ============================================================================
// Queries the transactions table and identifies recurring charges by grouping
// on merchant + similar amount at ~30/60/90 day intervals (±10% variance).
//
// Usage:
//   - As a standalone script: TOKEN_ENCRYPTION_PASSPHRASE=... NEON_DATABASE_URL=... node detect-subscriptions.js
//   - In-process: routes/subscriptions.js runSubscriptionDetection (the scheduler
//     and POST /api/detect) calls detectSubscriptions(pool).
//
// Algorithm:
//   1. Pull all non-pending transactions from the last 36 months
//   2. Group by merchant key (merchant_name || normalized name)
//   3. For each merchant group, sort by date and compute inter-charge gaps
//   4. If enough charges exist with consistent gaps, flag it as a subscription:
//      30-day cadence needs 3+ charges; 60/90/365-day cadences need only 2+
//      (1 matching gap) — same ≥60-day rule the transfer detector uses (F2)
//   5. Upsert into detected_subscriptions
// ============================================================================

const { Pool } = require("pg");
const { pgSsl } = require("./pg-ssl");
const { nextOccurrence, parseYmd } = require("../teller/services/cadence");
// The transfer detector's own classifier (cycle-9 F20): a row it takes is not
// a subscription charge. (detect-transfers.js requires THIS module, so the
// shared lists live in a third file.)
const { classifyTransfer, classifyTransferTxn } = require("./transfer-keywords");

// Stale gate (DC-2): a series whose last charge is older than
// max(120 days, 1.5 × cadence) has stopped. Detection reads 36 months of
// history, so without this a subscription cancelled at the merchant two years
// ago was re-detected — and upserted ACTIVE — on every run, feeding the
// calendar, ICS, forecasts, cash flow and the AI audit. Same threshold as the
// stale sweep below.
function isStale(lastDate, cadenceDays, today = new Date()) {
  const p = parseYmd(lastDate);
  if (!p) return false;
  const last = new Date(Date.UTC(p.y, p.m, p.d));
  const t0 = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
  const staleDays = Math.max(120, cadenceDays * 1.5);
  return (t0 - last.getTime()) / 86400000 > staleDays;
}

// Anchor amount (DC-7): prefer the MOST RECENT amount cluster when it has
// enough charges to stand on its own, so a price increase (18 × $15.49 then
// 6 × $17.99) is reported at the new price instead of the old mode — the
// global mode hid exactly the price-creep signal this feature exists for.
// Falls back to the global mode when the latest charge is a one-off.
function findAnchorAmount(sortedTxns, tolerance, minCluster) {
  if (!sortedTxns.length) return null;
  const amounts = sortedTxns.map(t => parseFloat(t.amount));
  const latest = amounts[amounts.length - 1];
  const recentCluster = amounts.filter(a => Math.abs(a - latest) / Math.max(latest, 0.01) <= tolerance).length;
  if (recentCluster >= minCluster) return latest;
  return findModeAmount(amounts, tolerance);
}

// Two amounts that are the same price (a cent, or half a percent for tax).
function samePrice(a, b) {
  return Math.abs(a - b) <= Math.max(0.01, 0.005 * Math.max(Math.abs(b), 0.01));
}

// Cycle-9 F21: is `newAmount` another plan billed under the same merchant key
// rather than a new price? One row holds a (merchant, cadence), so a key that
// carries two plans (Apple, Google: $0.99 storage and $10.99 music) re-anchors
// on whichever charged last, and every upward flip read as "went up". A real
// price change REPLACES the old price; a second plan was already being charged
// while the old price still was — within the two cadences up to the old
// price's most recent charge.
function isOtherPlan(merchantTxns, oldAmount, newAmount, cadenceDays) {
  if (!(oldAmount > 0) || !(newAmount > 0) || samePrice(oldAmount, newAmount)) return false;
  let lastOld = null;
  for (const t of merchantTxns) {
    if (samePrice(parseFloat(t.amount), oldAmount)) {
      const d = new Date(t.date).getTime();
      if (lastOld === null || d > lastOld) lastOld = d;
    }
  }
  if (lastOld === null) return false;
  const from = lastOld - 2 * cadenceDays * 86400000;
  return merchantTxns.some((t) => {
    const d = new Date(t.date).getTime();
    return d <= lastOld && d >= from && samePrice(parseFloat(t.amount), newAmount);
  });
}

async function detectSubscriptions(externalPool) {
  const ownPool = !externalPool;
  const pool = externalPool || new Pool({
    connectionString: process.env.NEON_DATABASE_URL,
    ssl: pgSsl(),
    max: 2,
    connectionTimeoutMillis: 10000,
  });

  try {
    // ------------------------------------------------------------------
    // 1. Fetch recent transactions grouped by merchant
    // ------------------------------------------------------------------
    // Group by the user's overridden merchant name when set so renames the user
    // has applied (e.g. "AMAZON MKTP*4321" -> "Amazon") collapse multi-variant
    // transactions into a single subscription detection. Same pattern the
    // display layers use — the previous query grouped by raw merchant_name and
    // re-fragmented user-merged merchants on every detect run.
    const { rows: txns } = await pool.query(`
      SELECT
        transaction_id,
        COALESCE(user_merchant_name, merchant_name, LOWER(REGEXP_REPLACE(name, '[^a-zA-Z0-9 ]', '', 'g'))) AS merchant_key,
        COALESCE(user_merchant_name, merchant_name, name) AS display_name,
        -- F49: the raw description, read only when the user hasn't renamed
        -- the row (a rename stays the escape hatch, as in NOT_TRANSFER).
        CASE WHEN user_merchant_name IS NULL THEN name END AS raw_description,
        amount,
        date
      FROM transactions
      WHERE pending = false
        AND amount > 0
        AND date >= CURRENT_DATE - INTERVAL '36 months'
      ORDER BY merchant_key, date
    `);

    // Cycle-9 F20: a merchant whose recurring TRANSFER the user dismissed
    // ("this isn't a transfer") stays a subscription candidate — otherwise
    // dismissing the duplicate would have left the series in neither list.
    let dismissedTransferKeys = new Set();
    try {
      const d = await pool.query(
        "SELECT merchant_key FROM recurring_transfers WHERE is_dismissed = true AND direction = 'outgoing'");
      dismissedTransferKeys = new Set(((d && d.rows) || []).map((r) => r.merchant_key));
    } catch (err) {
      console.error("detect-subscriptions: could not read dismissed transfers:", err.message);
    }
    const isTransferRow = (key, rawDescription) =>
      !dismissedTransferKeys.has(key) && !!classifyTransferTxn(key, rawDescription);

    // ------------------------------------------------------------------
    // 2. Group by merchant_key
    // ------------------------------------------------------------------
    const groups = {};
    for (const txn of txns) {
      const key = txn.merchant_key?.trim();
      if (!key) continue;
      // F49: a payment/transfer whose raw description says so ("ZELLE TO JOHN
      // SMITH", counterparty "John Smith") is never a subscription charge —
      // the merchant key alone made monthly rent via Zelle a "John Smith"
      // subscription (the DD-2 class).
      if (isExcludedDescription(txn.raw_description)) continue;
      // F20: a row the transfer detector takes (a mortgage payment, a brokerage
      // contribution, a savings transfer) belongs to it alone — both detectors
      // used to keep it, and the forecast billed the series twice.
      if (isTransferRow(key, txn.raw_description)) continue;
      if (!groups[key]) groups[key] = [];
      groups[key].push(txn);
    }

    // ------------------------------------------------------------------
    // 3. Analyze each group for recurring patterns
    // ------------------------------------------------------------------
    const CADENCES = [30, 60, 90, 365]; // target intervals in days
    const TOLERANCE = 0.25;        // ±25% tolerance on interval (e.g. 30 ± 7.5 days)
    const AMOUNT_TOLERANCE = 0.10; // ±10% for "similar amount" (catches price creep)
    const MIN_OCCURRENCES = 3;     // short cadences (30d) need at least 3 charges
    const MIN_OCCURRENCES_LONG = 2; // 60+ day cadences (bi-monthly/quarterly/yearly) only need 2

    const detected = [];

    // The stored price of each series, to tell a price change from a second
    // plan under the same key (F21).
    const storedAmount = new Map();
    try {
      const st = await pool.query("SELECT merchant_key, cadence_days, amount FROM detected_subscriptions");
      for (const r of (st && st.rows) || []) storedAmount.set(r.merchant_key + "|" + r.cadence_days, parseFloat(r.amount));
    } catch (err) {
      console.error("detect-subscriptions: could not read stored prices:", err.message);
    }

    for (const [merchantKey, merchantTxns] of Object.entries(groups)) {
      // Skip merchant groups that match non-subscription patterns
      if (isExcludedMerchant(merchantKey)) continue;
      if (merchantTxns.length < MIN_OCCURRENCES_LONG) continue;

      // Sort by date ascending
      merchantTxns.sort((a, b) => new Date(a.date) - new Date(b.date));

      // Try each cadence
      for (const targetCadence of CADENCES) {
        // 60+ day cadences (bi-monthly/quarterly/yearly) are confident at 2
        // occurrences (1 matching gap); only short 30-day cadences need 3 — same
        // ≥60-day rule the recurring-transfer detector uses (F2). Previously this
        // gated on ≥365, so quarterly/bi-monthly subscriptions were never
        // detected until a third charge (~9 months of history).
        const minOcc = targetCadence >= 60 ? MIN_OCCURRENCES_LONG : MIN_OCCURRENCES;
        const minGap = targetCadence * (1 - TOLERANCE);
        const maxGap = targetCadence * (1 + TOLERANCE);

        // Anchor on the most recent amount cluster, else the mode (DC-7).
        const modeAmount = findAnchorAmount(merchantTxns, AMOUNT_TOLERANCE, minOcc);
        if (modeAmount === null) continue;

        // Filter to transactions with similar amounts
        const filtered = merchantTxns.filter((t) => {
          const amt = parseFloat(t.amount);
          return Math.abs(amt - modeAmount) / modeAmount <= AMOUNT_TOLERANCE;
        });

        if (filtered.length < minOcc) continue;
        // Two-charge detection (≥60-day cadences) needs a near-EXACT repeat
        // amount (±2%, DC-8): two restaurant meals of $45.00 and $48.10 55 days
        // apart are not a subscription.
        if (filtered.length === 2) {
          const a0 = parseFloat(filtered[0].amount), a1 = parseFloat(filtered[1].amount);
          if (Math.abs(a0 - a1) / Math.max(a0, a1, 0.01) > 0.02) continue;
        }

        // Compute inter-charge gaps
        const gaps = [];
        for (let i = 1; i < filtered.length; i++) {
          const daysDiff =
            (new Date(filtered[i].date) - new Date(filtered[i - 1].date)) /
            (1000 * 60 * 60 * 24);
          gaps.push(daysDiff);
        }

        // Count how many gaps fall within our cadence tolerance
        const matchingGaps = gaps.filter((g) => g >= minGap && g <= maxGap);

        // A true majority of gaps must match (ceil, DC-8 — floor let 1 of 2 or
        // 1 of 3 through) AND the LATEST gap must match, so an old coincidence
        // followed by irregular purchases isn't a live subscription. For
        // ≥60-day cadences a single matching gap (2 charges) is still enough.
        const minMatchingGaps = targetCadence >= 60 ? 1 : 2;
        const latestGap = gaps[gaps.length - 1];
        const latestGapMatches = latestGap >= minGap && latestGap <= maxGap;
        if (latestGapMatches && matchingGaps.length >= Math.ceil(gaps.length * 0.5) && matchingGaps.length >= minMatchingGaps) {
          const lastTxn = filtered[filtered.length - 1];
          const firstTxn = filtered[0];
          // DC-2: a series that stopped is not re-detected (and so never
          // re-activated by the upsert); the stale sweep below retires it.
          if (isStale(lastTxn.date, targetCadence)) break;
          const latestAmount = parseFloat(lastTxn.amount);
          // Prior amount = the previous charge of THIS series (cycle-9 F21).
          // It used to be the merchant's previous charge of any amount, so a
          // new subscription at a merchant with other purchases (an $80 order,
          // then a $14.99 plan) was first stored as "went up from …" and
          // alerted at once. It is only used for a NEW row; an existing row's
          // prior price is its stored amount (the upsert below).
          const priorAmount = filtered.length >= 2
            ? parseFloat(filtered[filtered.length - 2].amount)
            : null;
          // A stored price that is still being charged beside the new anchor
          // is a second plan under this key, not a price change (F21).
          const stored = storedAmount.get(merchantKey + "|" + targetCadence);
          const otherPlan = stored != null && isOtherPlan(merchantTxns, stored, latestAmount, targetCadence);

          detected.push({
            merchant_key: merchantKey,
            display_name: lastTxn.display_name,
            amount: latestAmount,
            prior_amount: priorAmount,
            cadence_days: targetCadence,
            first_seen: firstTxn.date,
            last_charged: lastTxn.date,
            // Calendar-month stepping for month-scale cadences (DC-9) — a
            // fixed +30 days drifted and could double-book a month.
            next_expected: nextOccurrence(lastTxn.date, targetCadence),
            is_active: true,
            amount_changed:
              priorAmount !== null &&
              Math.abs(latestAmount - priorAmount) > 0.01,
            other_plan: otherPlan,
          });

          // Don't check longer cadences for the same merchant if 30-day matched
          break;
        }
      }
    }

    // ------------------------------------------------------------------
    // 4. Upsert detected subscriptions
    // ------------------------------------------------------------------
    // Mark subscriptions inactive if they're past their expected next charge + buffer
    // Use cadence-aware threshold: max(120 days, cadence_days * 1.5)
    await pool.query(`
      UPDATE detected_subscriptions
      SET is_active = false, updated_at = now()
      WHERE last_charged < CURRENT_DATE - GREATEST(INTERVAL '120 days', (cadence_days * 1.5) * INTERVAL '1 day')
        AND source != 'manual'
        AND is_active = true -- cycle-9 F27: only rows this changes (every stale row's updated_at was rewritten each run)
    `);

    // F20: rows detected before the detectors shared one classifier — a
    // subscription keyed on a transfer merchant (and not one whose transfer
    // the user dismissed) is retired, so the forecast stops billing it beside
    // its recurring-transfer row. User state (notes, cancelled) is kept.
    try {
      const live = await pool.query(
        "SELECT id, merchant_key FROM detected_subscriptions WHERE is_active = true AND source != 'manual'");
      const overlap = ((live && live.rows) || [])
        .filter((r) => !dismissedTransferKeys.has(r.merchant_key) && classifyTransfer(r.merchant_key))
        .map((r) => r.id);
      if (overlap.length) {
        await pool.query(
          "UPDATE detected_subscriptions SET is_active = false, updated_at = now() WHERE id = ANY($1::int[])", [overlap]);
        console.log(`Retired ${overlap.length} subscription row(s) that are recurring transfers.`);
      }
    } catch (err) {
      console.error("detect-subscriptions: could not retire transfer rows:", err.message);
    }

    for (const sub of detected) {
      await pool.query(
        `INSERT INTO detected_subscriptions
           (merchant_key, display_name, amount, prior_amount, cadence_days,
            first_seen, last_charged, next_expected, is_active, is_new, amount_changed)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, true, $10)
         ON CONFLICT (merchant_key, cadence_days)
         DO UPDATE SET
           display_name   = EXCLUDED.display_name,
           -- A price change is recorded when the price CHANGES and kept until a
           -- later charge at the same price arrives (cycle-8 F46): every run
           -- re-upserts each series, so "prior = stored, changed = differs"
           -- erased the change on the next run with no new charge — the
           -- watchdog's failed price-rise alert was never retried and the
           -- PRICE UP badge lasted one detection run.
           -- $11 (cycle-9 F21): the new anchor is another plan billed under
           -- the same key, still charged beside the stored one — the amount
           -- follows the latest charge, but it is not a price change.
           prior_amount   = CASE WHEN EXCLUDED.amount <> detected_subscriptions.amount AND NOT $11::boolean
                                 THEN detected_subscriptions.amount
                                 ELSE detected_subscriptions.prior_amount END,
           amount         = EXCLUDED.amount,
           last_charged   = EXCLUDED.last_charged,
           next_expected  = EXCLUDED.next_expected,
           -- Respect user-driven state: don't reactivate cancelled or
           -- dismissed subscriptions. If the user marked it cancelled
           -- (cancelled_at IS NOT NULL) it stays inactive even if the
           -- merchant charges again. If the user dismissed it, keep it
           -- inactive rather than silently reactivating.
           is_active      = CASE
                              WHEN detected_subscriptions.cancelled_at IS NOT NULL THEN false
                              WHEN detected_subscriptions.is_dismissed = true THEN false
                              ELSE true
                            END,
           amount_changed = CASE WHEN EXCLUDED.amount <> detected_subscriptions.amount THEN NOT $11::boolean
                                 WHEN EXCLUDED.last_charged > detected_subscriptions.last_charged THEN false
                                 ELSE detected_subscriptions.amount_changed END,
           is_new         = false,
           updated_at     = now()`,
        [
          sub.merchant_key,
          sub.display_name,
          sub.amount,
          sub.prior_amount,
          sub.cadence_days,
          sub.first_seen,
          sub.last_charged,
          sub.next_expected,
          sub.is_active,
          sub.amount_changed,
          !!sub.other_plan,
        ]
      );
    }

    console.log(`Detected ${detected.length} recurring subscriptions.`);
    return detected;
  } finally {
    if (ownPool) await pool.end();
  }
}

// ---------------------------------------------------------------------------
// Exclusion patterns — recurring charges that aren't subscriptions
// ---------------------------------------------------------------------------

// Keywords that indicate non-subscription recurring charges
const EXCLUSION_PATTERNS = {
  interest: ["interest", "int charge", "finance charge", "apr charge"],
  fees: ["late fee", "late charge", "overdraft fee", "nsf fee", "service fee", "maintenance fee", "annual fee"],
  fast_food_retail: [
    "walgreens", "cvs pharmacy", "rite aid", "dollar general", "dollar tree", "7-eleven", "7 eleven",
    "mcdonald", "mcdonalds", "burger king", "wendy", "taco bell", "chick-fil-a", "chickfila",
    "subway", "chipotle", "popeye", "sonic drive", "jack in the box", "five guys",
    "dutch bros", "starbucks", "dunkin", "peet", "tim horton",
    "walmart", "target", "costco gas", "sam's club", "kroger", "safeway", "albertson",
    "publix", "heb", "h-e-b", "aldi", "trader joe", "whole foods", "food lion",
    "wawa", "sheetz", "quiktrip", "racetrac", "circle k", "shell", "chevron", "exxon", "bp",
  ],
  debt_payments: [
    "directpay", "minimum payment", "autopay", "auto pay", "payment thank you",
    "credit card payment", "loan payment", "debt payment",
  ],
  transfers: [
    "funds tran", "funds transfer", "transfer to", "transfer from",
    "zelle", "venmo", "cash app", "paypal transfer",
    "ach transfer", "wire transfer", "internal transfer",
  ],
};

function isExcludedMerchant(merchantKey) {
  if (!merchantKey) return false;
  const lower = merchantKey.toLowerCase();
  for (const keywords of Object.values(EXCLUSION_PATTERNS)) {
    if (keywords.some(kw => {
      // Multi-word keywords: substring match is fine (low false-positive risk).
      if (kw.includes(" ")) return lower.includes(kw);
      // Single-word keywords: word-boundary match so e.g. "interest" doesn't
      // also match "internet" and exclude legitimate ISP charges.
      const re = new RegExp("\\b" + kw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\b");
      return re.test(lower);
    })) return true;
  }
  return false;
}

// F49: the categories safe to match against a raw bank description. The
// retail list is merchant-only — a raw description names a processor or a
// location ("SHELL OIL 1234 …") too loosely to exclude on.
const RAW_DESCRIPTION_EXCLUSIONS = ["interest", "fees", "debt_payments", "transfers"];
function isExcludedDescription(description) {
  if (!description) return false;
  const lower = String(description).toLowerCase();
  return RAW_DESCRIPTION_EXCLUSIONS.some((group) => EXCLUSION_PATTERNS[group].some((kw) => {
    if (kw.includes(" ")) return lower.includes(kw);
    const re = new RegExp("\\b" + kw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\b");
    return re.test(lower);
  }));
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function findModeAmount(amounts, tolerance) {
  if (amounts.length === 0) return null;
  // Simple: pick the amount that has the most "similar" peers
  let bestAmount = amounts[0];
  let bestCount = 0;
  for (const candidate of amounts) {
    const count = amounts.filter(
      (a) => Math.abs(a - candidate) / Math.max(candidate, 0.01) <= tolerance
    ).length;
    if (count > bestCount) {
      bestCount = count;
      bestAmount = candidate;
    }
  }
  return bestAmount;
}

function addDays(date, days) {
  const result = new Date(date);
  result.setDate(result.getDate() + days);
  return result;
}

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------
if (require.main === module) {
  require("dotenv").config({ path: require("path").resolve(__dirname, "../.env") });
  detectSubscriptions()
    .then((subs) => {
      console.table(
        subs.map((s) => ({
          merchant: s.display_name,
          amount: `$${s.amount}`,
          cadence: `${s.cadence_days}d`,
          next: s.next_expected,
        }))
      );
    })
    .catch((err) => {
      console.error("Detection failed:", err);
      process.exit(1);
    });
}

module.exports = { detectSubscriptions, findModeAmount, findAnchorAmount, isStale, addDays, isExcludedMerchant, isExcludedDescription, isOtherPlan, samePrice, EXCLUSION_PATTERNS };
