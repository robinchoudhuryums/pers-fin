// ============================================================================
// Routes: "What changed since last sync" / "Since you last looked"
// ============================================================================
// Aggregates events that happened since the user last viewed the dashboard,
// pulling from the existing freshness timestamps and event tables:
//   - transactions.created_at since last_dashboard_view_at      → new txns
//     (capped + ordered, doesn't dump months of data)
//   - account_balance_snapshots oldest-vs-latest in window      → balance deltas
//   - detected_subscriptions.created_at since                   → new subscriptions
//   - notification_log.created_at since                         → new notifications
//
// `last_dashboard_view_at` defaults to "24h ago" on first load so a brand-new
// installation returns one day of context rather than an empty card.
//
// POST /api/whats-new/seen advances the watermark — call this from the
// dashboard once the user has acknowledged the panel.
//
// gatherWhatsNew(since) is the shared aggregator — used by the HTTP route
// (with the user_settings watermark) and by the daily-digest helper (#19,
// with a 24h-fixed lookback) so the dashboard widget and the email always
// see the same data shape.

const express = require("express");
const router = express.Router();
const { pool } = require("../services/database");

const DEFAULT_LOOKBACK_HOURS = 24;
const NEW_TXN_LIMIT = 25;
const NEW_NOTIF_LIMIT = 20;
const NEW_SUB_LIMIT = 10;

async function getWatermark() {
  const r = await pool.query(
    "SELECT last_dashboard_view_at FROM user_settings WHERE id = 1"
  );
  const stored = r.rows[0]?.last_dashboard_view_at;
  if (stored) return new Date(stored);
  return new Date(Date.now() - DEFAULT_LOOKBACK_HOURS * 60 * 60 * 1000);
}

async function gatherWhatsNew(since) {
  const [newTxns, newSubs, newNotifs, balanceWindow] = await Promise.all([
    pool.query(
      `SELECT t.transaction_id, t.date, t.amount,
              COALESCE(t.user_merchant_name, t.merchant_name, t.name) AS merchant,
              COALESCE(t.user_category, t.category[1]) AS category,
              la.name AS account_name
       FROM transactions t
       LEFT JOIN linked_accounts la ON la.account_id = t.account_id
       WHERE t.created_at > $1 AND t.pending = false
       ORDER BY t.date DESC, t.created_at DESC
       LIMIT $2`,
      [since, NEW_TXN_LIMIT]
    ),
    pool.query(
      `SELECT id, display_name, amount, cadence_days, category, first_seen
       FROM detected_subscriptions
       WHERE created_at > $1
         AND is_active = true
         AND is_dismissed = false
       ORDER BY created_at DESC
       LIMIT $2`,
      [since, NEW_SUB_LIMIT]
    ),
    pool.query(
      `SELECT id, type, title, body, data, is_read, created_at
       FROM notification_log
       WHERE created_at > $1
       ORDER BY created_at DESC
       LIMIT $2`,
      [since, NEW_NOTIF_LIMIT]
    ),
    // For each account that has a snapshot before AND on/after the
    // watermark, compute the delta. CTE picks the latest snapshot at or
    // before `since` (the baseline) and the latest overall (the current).
    pool.query(
      `WITH baselines AS (
         SELECT DISTINCT ON (source, source_id)
                source, source_id, balance AS baseline_balance
         FROM account_balance_snapshots
         WHERE snapshot_date <= $1::date
         ORDER BY source, source_id, snapshot_date DESC
       ),
       currents AS (
         SELECT DISTINCT ON (source, source_id)
                source, source_id, balance AS current_balance,
                snapshot_date AS current_date
         FROM account_balance_snapshots
         ORDER BY source, source_id, snapshot_date DESC
       )
       SELECT c.source, c.source_id, c.current_date,
              b.baseline_balance, c.current_balance,
              COALESCE(la.name, ia.name) AS account_name,
              (c.current_balance - b.baseline_balance) AS delta
       FROM currents c
       JOIN baselines b ON b.source = c.source AND b.source_id = c.source_id
       LEFT JOIN linked_accounts     la ON c.source = 'linked'     AND la.id = c.source_id
       LEFT JOIN investment_accounts ia ON c.source = 'investment' AND ia.id = c.source_id
       WHERE c.current_date > $1::date
         AND ABS(c.current_balance - b.baseline_balance) >= 0.01
         -- Drop the Plaid brokerage phantom: a brokerage linked via the combined
         -- flow lives in BOTH linked_accounts and investment_accounts, so without
         -- this it surfaces as two balance-change rows for one account. The
         -- investment_accounts row is authoritative (parallels getNetWorth, F19).
         AND (c.source <> 'linked' OR NOT EXISTS (
                SELECT 1 FROM investment_accounts ia2
                WHERE ia2.plaid_account_id = la.account_id AND ia2.is_active = true))
       ORDER BY ABS(c.current_balance - b.baseline_balance) DESC
       LIMIT 10`,
      [since]
    ),
  ]);

  return {
    since: since.toISOString(),
    counts: {
      transactions: newTxns.rows.length,
      subscriptions: newSubs.rows.length,
      notifications: newNotifs.rows.length,
      balance_changes: balanceWindow.rows.length,
    },
    transactions: newTxns.rows,
    subscriptions: newSubs.rows,
    notifications: newNotifs.rows,
    balance_changes: balanceWindow.rows.map(r => ({
      account_name: r.account_name,
      source: r.source,
      baseline_balance: parseFloat(r.baseline_balance),
      current_balance: parseFloat(r.current_balance),
      delta: parseFloat(r.delta),
    })),
  };
}

router.get("/api/whats-new", async (_req, res) => {
  try {
    const since = await getWatermark();
    const data = await gatherWhatsNew(since);
    res.json(data);
  } catch (err) {
    console.error("/api/whats-new error:", err.message);
    res.status(500).json({ error: "An internal error occurred." });
  }
});

// POST /api/whats-new/seen — advance the watermark to "now". Called from
// the dashboard so the panel reflects only changes since the user's last
// visit. Idempotent.
router.post("/api/whats-new/seen", async (_req, res) => {
  try {
    await pool.query(
      "UPDATE user_settings SET last_dashboard_view_at = now() WHERE id = 1"
    );
    res.json({ ok: true });
  } catch (err) {
    console.error("/api/whats-new/seen error:", err.message);
    res.status(500).json({ error: "An internal error occurred." });
  }
});

module.exports = router;
module.exports.gatherWhatsNew = gatherWhatsNew;
