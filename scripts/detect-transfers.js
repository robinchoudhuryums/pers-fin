// ============================================================================
// Recurring Transfer Detection Script
// ============================================================================
// Identifies recurring transfers between accounts — Zelle, Venmo, ACH,
// bill payments, savings transfers, investment contributions, etc.
//
// Complements detect-subscriptions.js which explicitly EXCLUDES transfers.
// This script analyzes the same transactions but focuses on transfer patterns.
//
// Transfer types:
//   - peer_transfer: Zelle, Venmo, Cash App, PayPal
//   - bill_payment: credit card, loan, mortgage, autopay
//   - savings: savings account, emergency fund transfers
//   - investment: brokerage, 401k, IRA contributions
//   - internal: between own accounts (ACH, wire, internal)
//   - other: unclassified recurring transfers
// ============================================================================

const { Pool } = require("pg");
const { findModeAmount, addDays } = require("./detect-subscriptions");

// Transfer keyword patterns — inverse of subscription exclusion
const TRANSFER_PATTERNS = {
  peer_transfer: [
    "zelle", "venmo", "cash app", "cashapp", "square cash", "paypal",
  ],
  bill_payment: [
    "directpay", "minimum payment", "autopay", "auto pay", "payment thank",
    "credit card payment", "loan payment", "debt payment", "mortgage payment",
    "bill pay", "epay", "automatic payment",
  ],
  savings: [
    "savings", "emergency fund", "rainy day",
  ],
  investment: [
    "vanguard", "fidelity", "schwab", "etrade", "e*trade", "robinhood",
    "betterment", "wealthfront", "acorns", "401k", "ira contribution",
    "brokerage",
  ],
  internal: [
    "funds tran", "funds transfer", "transfer to", "transfer from",
    "ach transfer", "wire transfer", "internal transfer",
    "online transfer", "mobile transfer",
    "boa transfer",
  ],
};

function classifyTransfer(merchantKey) {
  if (!merchantKey) return null;
  const lower = merchantKey.toLowerCase();
  for (const [type, keywords] of Object.entries(TRANSFER_PATTERNS)) {
    if (keywords.some(kw => lower.includes(kw))) return type;
  }
  return null;
}

function isTransferMerchant(merchantKey) {
  return classifyTransfer(merchantKey) !== null;
}

async function detectRecurringTransfers(externalPool) {
  const ownPool = !externalPool;
  const pool = externalPool || new Pool({
    connectionString: process.env.NEON_DATABASE_URL,
    ssl: { rejectUnauthorized: true },
    max: 2,
    connectionTimeoutMillis: 10000,
  });

  try {
    // Fetch all non-pending transactions from last 36 months
    // Include both positive (outgoing) and negative (incoming) transfers
    const { rows: txns } = await pool.query(`
      SELECT
        transaction_id,
        COALESCE(merchant_name, LOWER(REGEXP_REPLACE(name, '[^a-zA-Z0-9 ]', '', 'g'))) AS merchant_key,
        COALESCE(merchant_name, name) AS display_name,
        amount,
        date
      FROM transactions
      WHERE pending = false
        AND date >= CURRENT_DATE - INTERVAL '36 months'
      ORDER BY merchant_key, date
    `);

    // Group by merchant_key
    const groups = {};
    for (const txn of txns) {
      const key = txn.merchant_key?.trim();
      if (!key) continue;
      // Only include transactions that match transfer patterns
      if (!isTransferMerchant(key)) continue;
      if (!groups[key]) groups[key] = [];
      groups[key].push(txn);
    }

    // Detection parameters (same as subscription detection)
    const CADENCES = [7, 14, 30, 60, 90, 365];
    const TOLERANCE = 0.25;
    const AMOUNT_TOLERANCE = 0.15; // Slightly more tolerant for transfers (amounts vary more)
    const MIN_OCCURRENCES = 3;
    const MIN_OCCURRENCES_LONG = 2; // For 60+ day cadences (bi-monthly, quarterly, yearly)

    const detected = [];

    for (const [merchantKey, merchantTxns] of Object.entries(groups)) {
      // Split into outgoing (positive) and incoming (negative) streams
      const outgoing = merchantTxns.filter(t => parseFloat(t.amount) > 0);
      const incoming = merchantTxns.filter(t => parseFloat(t.amount) < 0);

      for (const [direction, stream] of [["outgoing", outgoing], ["incoming", incoming]]) {
        if (stream.length < MIN_OCCURRENCES_LONG) continue;

        // Sort by date
        stream.sort((a, b) => new Date(a.date) - new Date(b.date));

        for (const targetCadence of CADENCES) {
          const minOcc = targetCadence >= 60 ? MIN_OCCURRENCES_LONG : MIN_OCCURRENCES;
          const minGap = targetCadence * (1 - TOLERANCE);
          const maxGap = targetCadence * (1 + TOLERANCE);

          // Find dominant amount
          const amounts = stream.map(t => Math.abs(parseFloat(t.amount)));
          const modeAmount = findModeAmount(amounts, AMOUNT_TOLERANCE);
          if (modeAmount === null) continue;

          // Filter to similar amounts
          const filtered = stream.filter(t => {
            const amt = Math.abs(parseFloat(t.amount));
            return Math.abs(amt - modeAmount) / modeAmount <= AMOUNT_TOLERANCE;
          });

          if (filtered.length < minOcc) continue;

          // Compute inter-transfer gaps
          const gaps = [];
          for (let i = 1; i < filtered.length; i++) {
            const daysDiff = (new Date(filtered[i].date) - new Date(filtered[i - 1].date)) / 86400000;
            gaps.push(daysDiff);
          }

          // Count matching gaps
          const matchingGaps = gaps.filter(g => g >= minGap && g <= maxGap);
          const minMatchingGaps = targetCadence >= 90 ? 1 : 2;

          if (matchingGaps.length >= Math.floor(gaps.length * 0.5) && matchingGaps.length >= minMatchingGaps) {
            const lastTxn = filtered[filtered.length - 1];
            const firstTxn = filtered[0];
            const latestAmount = Math.abs(parseFloat(lastTxn.amount));
            const priorAmount = filtered.length >= 2
              ? Math.abs(parseFloat(filtered[filtered.length - 2].amount))
              : null;

            detected.push({
              merchant_key: merchantKey,
              display_name: lastTxn.display_name,
              amount: latestAmount,
              prior_amount: priorAmount,
              cadence_days: targetCadence,
              first_seen: firstTxn.date,
              last_transferred: lastTxn.date,
              next_expected: addDays(new Date(lastTxn.date), targetCadence).toISOString().split("T")[0],
              is_active: true,
              transfer_type: classifyTransfer(merchantKey) || "other",
              direction,
              amount_changed: priorAmount !== null && Math.abs(latestAmount - priorAmount) > 0.01,
            });

            break; // Don't check longer cadences
          }
        }
      }
    }

    // Mark old transfers inactive
    await pool.query(`
      UPDATE recurring_transfers
      SET is_active = false, updated_at = now()
      WHERE last_transferred < CURRENT_DATE - GREATEST(INTERVAL '120 days', (cadence_days * 1.5) * INTERVAL '1 day')
    `);

    // Upsert detected transfers
    for (const t of detected) {
      await pool.query(
        `INSERT INTO recurring_transfers
           (merchant_key, display_name, amount, prior_amount, cadence_days,
            first_seen, last_transferred, next_expected, is_active, transfer_type,
            direction, amount_changed)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
         ON CONFLICT (merchant_key, cadence_days, direction)
         DO UPDATE SET
           display_name = EXCLUDED.display_name,
           prior_amount = recurring_transfers.amount,
           amount = EXCLUDED.amount,
           last_transferred = EXCLUDED.last_transferred,
           next_expected = EXCLUDED.next_expected,
           is_active = true,
           transfer_type = EXCLUDED.transfer_type,
           amount_changed = (EXCLUDED.amount != recurring_transfers.amount),
           updated_at = now()`,
        [
          t.merchant_key, t.display_name, t.amount, t.prior_amount,
          t.cadence_days, t.first_seen, t.last_transferred, t.next_expected,
          t.is_active, t.transfer_type, t.direction, t.amount_changed,
        ]
      );
    }

    console.log(`Detected ${detected.length} recurring transfers.`);
    return detected;
  } finally {
    if (ownPool) await pool.end();
  }
}

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------
if (require.main === module) {
  require("dotenv").config({ path: require("path").resolve(__dirname, "../.env") });
  detectRecurringTransfers()
    .then((transfers) => {
      console.table(
        transfers.map((t) => ({
          merchant: t.display_name,
          amount: `$${t.amount}`,
          type: t.transfer_type,
          direction: t.direction,
          cadence: `${t.cadence_days}d`,
          next: t.next_expected,
        }))
      );
    })
    .catch((err) => {
      console.error("Detection failed:", err);
      process.exit(1);
    });
}

module.exports = { detectRecurringTransfers, classifyTransfer, isTransferMerchant, TRANSFER_PATTERNS };
