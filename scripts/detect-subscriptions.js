// ============================================================================
// Recurring Charge Detection Script
// ============================================================================
// Queries the transactions table and identifies recurring charges by grouping
// on merchant + similar amount at ~30/60/90 day intervals (±10% variance).
//
// Usage:
//   - As a standalone script: TOKEN_ENCRYPTION_PASSPHRASE=... NEON_DATABASE_URL=... node detect-subscriptions.js
//   - Paste the detectSubscriptions() function body into an n8n Code node
//     (the n8n variant is at the bottom of this file).
//
// Algorithm:
//   1. Pull all non-pending transactions from the last 12 months
//   2. Group by merchant key (merchant_name || normalized name)
//   3. For each merchant group, sort by date and compute inter-charge gaps
//   4. If 3+ charges exist with consistent gaps (~30, ~60, or ~90 days),
//      flag it as a subscription
//   5. Upsert into detected_subscriptions
// ============================================================================

const { Pool } = require("pg");

async function detectSubscriptions(externalPool) {
  const ownPool = !externalPool;
  const pool = externalPool || new Pool({
    connectionString: process.env.NEON_DATABASE_URL,
    ssl: { rejectUnauthorized: true },
    max: 2,
    connectionTimeoutMillis: 10000,
  });

  try {
    // ------------------------------------------------------------------
    // 1. Fetch recent transactions grouped by merchant
    // ------------------------------------------------------------------
    const { rows: txns } = await pool.query(`
      SELECT
        transaction_id,
        COALESCE(merchant_name, LOWER(REGEXP_REPLACE(name, '[^a-zA-Z0-9 ]', '', 'g'))) AS merchant_key,
        COALESCE(merchant_name, name) AS display_name,
        amount,
        date
      FROM transactions
      WHERE pending = false
        AND amount > 0
        AND date >= CURRENT_DATE - INTERVAL '36 months'
      ORDER BY merchant_key, date
    `);

    // ------------------------------------------------------------------
    // 2. Group by merchant_key
    // ------------------------------------------------------------------
    const groups = {};
    for (const txn of txns) {
      const key = txn.merchant_key?.trim();
      if (!key) continue;
      if (!groups[key]) groups[key] = [];
      groups[key].push(txn);
    }

    // ------------------------------------------------------------------
    // 3. Analyze each group for recurring patterns
    // ------------------------------------------------------------------
    const CADENCES = [30, 60, 90, 365]; // target intervals in days
    const TOLERANCE = 0.25;        // ±25% tolerance on interval (e.g. 30 ± 7.5 days)
    const AMOUNT_TOLERANCE = 0.10; // ±10% for "similar amount" (catches price creep)
    const MIN_OCCURRENCES = 3;     // need at least 3 charges to call it recurring
    const MIN_OCCURRENCES_YEARLY = 2; // yearly subs only need 2 charges

    const detected = [];

    for (const [merchantKey, merchantTxns] of Object.entries(groups)) {
      if (merchantTxns.length < MIN_OCCURRENCES_YEARLY) continue;

      // Sort by date ascending
      merchantTxns.sort((a, b) => new Date(a.date) - new Date(b.date));

      // Try each cadence
      for (const targetCadence of CADENCES) {
        const minOcc = targetCadence >= 365 ? MIN_OCCURRENCES_YEARLY : MIN_OCCURRENCES;
        const minGap = targetCadence * (1 - TOLERANCE);
        const maxGap = targetCadence * (1 + TOLERANCE);

        // Find the dominant amount (mode by ~10% buckets)
        const amounts = merchantTxns.map((t) => parseFloat(t.amount));
        const modeAmount = findModeAmount(amounts, AMOUNT_TOLERANCE);
        if (modeAmount === null) continue;

        // Filter to transactions with similar amounts
        const filtered = merchantTxns.filter((t) => {
          const amt = parseFloat(t.amount);
          return Math.abs(amt - modeAmount) / modeAmount <= AMOUNT_TOLERANCE;
        });

        if (filtered.length < minOcc) continue;

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

        // If >50% of gaps match this cadence, it's recurring
        // For yearly cadence, a single matching gap (2 charges ~365 days apart) is sufficient
        const minMatchingGaps = targetCadence >= 365 ? 1 : 2;
        if (matchingGaps.length >= Math.floor(gaps.length * 0.5) && matchingGaps.length >= minMatchingGaps) {
          const lastTxn = filtered[filtered.length - 1];
          const firstTxn = filtered[0];
          const latestAmount = parseFloat(lastTxn.amount);
          const priorAmount =
            filtered.length >= 2
              ? parseFloat(filtered[filtered.length - 2].amount)
              : null;

          detected.push({
            merchant_key: merchantKey,
            display_name: lastTxn.display_name,
            amount: latestAmount,
            prior_amount: priorAmount,
            cadence_days: targetCadence,
            first_seen: firstTxn.date,
            last_charged: lastTxn.date,
            next_expected: addDays(new Date(lastTxn.date), targetCadence)
              .toISOString()
              .split("T")[0],
            is_active: true,
            amount_changed:
              priorAmount !== null &&
              Math.abs(latestAmount - priorAmount) > 0.01,
          });

          // Don't check longer cadences for the same merchant if 30-day matched
          break;
        }
      }
    }

    // ------------------------------------------------------------------
    // 4. Upsert detected subscriptions
    // ------------------------------------------------------------------
    // Mark all existing as potentially inactive, then re-activate matched ones
    await pool.query(`
      UPDATE detected_subscriptions
      SET is_active = false, updated_at = now()
      WHERE last_charged < CURRENT_DATE - INTERVAL '120 days'
    `);

    for (const sub of detected) {
      await pool.query(
        `INSERT INTO detected_subscriptions
           (merchant_key, display_name, amount, prior_amount, cadence_days,
            first_seen, last_charged, next_expected, is_active, is_new, amount_changed)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, true, $10)
         ON CONFLICT (merchant_key, cadence_days)
         DO UPDATE SET
           display_name   = EXCLUDED.display_name,
           prior_amount   = detected_subscriptions.amount,
           amount         = EXCLUDED.amount,
           last_charged   = EXCLUDED.last_charged,
           next_expected  = EXCLUDED.next_expected,
           is_active      = true,
           amount_changed = (EXCLUDED.amount != detected_subscriptions.amount),
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

module.exports = { detectSubscriptions, findModeAmount, addDays };
