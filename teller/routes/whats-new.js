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
// Cycle-8 E2d (ST3): GET returns `seen_token` — the newest transaction id and
// the database time, read BEFORE its queries (services/txn-watermark.readMark)
// — and the widget posts it back to /seen, which stores them as
// last_dashboard_view_txn_id / last_dashboard_view_at (forward only). /seen
// used to stamp now() 4 s after the render, so anything that arrived in
// between was never shown. New transactions are read by id (above the stored
// id, up to the mark); subscriptions, notifications and balance changes stay
// on the time. With no stored id yet, transactions use the time too.
//
// gatherWhatsNew(since) is the shared aggregator — used by the HTTP route
// (with the user_settings watermark) and by the daily-digest helper (#19,
// with a 24h-fixed lookback) so the dashboard widget and the email always
// see the same data shape.

const express = require("express");
const router = express.Router();
const { pool } = require("../services/database");
const { readMark } = require("../services/txn-watermark");

const DEFAULT_LOOKBACK_HOURS = 24;
const NEW_TXN_LIMIT = 25;
const NEW_NOTIF_LIMIT = 20;
const NEW_SUB_LIMIT = 10;

async function getWatermark() {
  const r = await pool.query(
    "SELECT last_dashboard_view_at, last_dashboard_view_txn_id::text AS last_dashboard_view_txn_id FROM user_settings WHERE id = 1"
  );
  const stored = r.rows[0]?.last_dashboard_view_at;
  const since = stored ? new Date(stored) : new Date(Date.now() - DEFAULT_LOOKBACK_HOURS * 60 * 60 * 1000);
  return { since, sinceTxnId: r.rows[0]?.last_dashboard_view_txn_id || null };
}

// The token GET hands out and /seen takes back: "<id>|<timestamptz text>".
const SEEN_TOKEN_RE = /^(\d{1,18})\|(\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}(?::?\d{2})?))$/;
function seenToken(mark) {
  return mark.id + "|" + (mark.at || new Date().toISOString());
}
function parseSeenToken(token) {
  const m = typeof token === "string" ? SEEN_TOKEN_RE.exec(token) : null;
  return m ? { id: m[1], at: m[2] } : null;
}

// since: the time watermark. opts.sinceTxnId / opts.untilTxnId (the dashboard
// widget, E2d): new transactions are id > sinceTxnId AND id <= untilTxnId
// instead of created_at > since. The daily digest passes only `since`.
async function gatherWhatsNew(since, opts = {}) {
  const byId = opts.sinceTxnId != null && opts.untilTxnId != null;
  const [newTxns, newSubs, newNotifs, balanceWindow] = await Promise.all([
    pool.query(
      `SELECT t.transaction_id, t.date, t.amount,
              COALESCE(t.user_merchant_name, t.merchant_name, t.name) AS merchant,
              COALESCE(t.user_category, t.category[1]) AS category,
              la.name AS account_name
       FROM transactions t
       LEFT JOIN linked_accounts la ON la.account_id = t.account_id
       WHERE ${byId ? "t.id > $1::bigint AND t.id <= $3::bigint" : "t.created_at > $1"} AND t.pending = false
       ORDER BY t.date DESC, t.created_at DESC
       LIMIT $2`,
      byId ? [opts.sinceTxnId, NEW_TXN_LIMIT, opts.untilTxnId] : [since, NEW_TXN_LIMIT]
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
    // For each account that has a snapshot before the watermark's day AND one
    // on/after it, compute the delta. The baseline is the latest snapshot dated
    // BEFORE the watermark's day and the current may be from that same day
    // (DD-5): snapshots are one row per account per day, overwritten by every
    // later sync that day, so a "baseline ≤ watermark day / current > watermark
    // day" pair silently dropped a same-day change (a 2pm paycheck after an 8am
    // view) — and by the next day it was already in the baseline, so it never
    // showed. Trade-off: a change earlier on the watermark's own day can repeat.
    pool.query(
      `WITH baselines AS (
         SELECT DISTINCT ON (source, source_id)
                source, source_id, balance AS baseline_balance
         FROM account_balance_snapshots
         WHERE snapshot_date < $1::date
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
              -- DD-6: the account type decides whether an increase is good
              -- (assets) or bad (credit / loan balances are amounts owed).
              CASE WHEN c.source = 'investment' THEN 'investment' ELSE la.type END AS account_type,
              (c.current_balance - b.baseline_balance) AS delta
       FROM currents c
       JOIN baselines b ON b.source = c.source AND b.source_id = c.source_id
       LEFT JOIN linked_accounts     la ON c.source = 'linked'     AND la.id = c.source_id
       LEFT JOIN investment_accounts ia ON c.source = 'investment' AND ia.id = c.source_id
       WHERE c.current_date >= $1::date
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
    balance_changes: balanceWindow.rows.map(r => {
      const delta = parseFloat(r.delta);
      const isDebt = r.account_type === "credit" || r.account_type === "loan";
      return {
        account_name: r.account_name,
        source: r.source,
        // The widget labels an unnamed account "Account #<id>" — it read
        // source_id, which wasn't sent ("Account #undefined"; seams audit #3).
        source_id: r.source_id,
        account_type: r.account_type || null,
        is_debt: isDebt,
        // Paying a card/loan down (balance owed ↓) is the GOOD direction (DD-6).
        favorable: isDebt ? delta <= 0 : delta >= 0,
        baseline_balance: parseFloat(r.baseline_balance),
        current_balance: parseFloat(r.current_balance),
        delta,
      };
    }),
  };
}

router.get("/api/whats-new", async (_req, res) => {
  try {
    // The mark comes first: a row committed after it is left for the next visit.
    const mark = await readMark(pool);
    const { since, sinceTxnId } = await getWatermark();
    const data = await gatherWhatsNew(since, sinceTxnId != null ? { sinceTxnId, untilTxnId: mark.id } : {});
    data.seen_token = seenToken(mark);
    res.json(data);
  } catch (err) {
    console.error("/api/whats-new error:", err.message);
    res.status(500).json({ error: "An internal error occurred." });
  }
});

// POST /api/whats-new/seen — advance the watermark. Called from the dashboard
// so the panel reflects only changes since the user's last visit. With the
// GET's seen_token (E2d) it moves to what that GET read — capped at the
// current newest id / now(), never backwards; a malformed token is a 400.
// Without one (a page loaded before E2d) it moves to "now" as before.
// Idempotent.
const SEEN_SQL = `UPDATE user_settings
    SET last_dashboard_view_txn_id = GREATEST(COALESCE(last_dashboard_view_txn_id, 0), LEAST($1::bigint, (SELECT COALESCE(MAX(id), 0) FROM transactions))),
        last_dashboard_view_at = GREATEST(last_dashboard_view_at, LEAST($2::timestamptz, now()))
  WHERE id = 1`;
const SEEN_NOW_SQL = `UPDATE user_settings
    SET last_dashboard_view_txn_id = GREATEST(COALESCE(last_dashboard_view_txn_id, 0), (SELECT COALESCE(MAX(id), 0) FROM transactions)),
        last_dashboard_view_at = now()
  WHERE id = 1`;
router.post("/api/whats-new/seen", async (req, res) => {
  const raw = req.body && req.body.seen_token;
  const token = raw === undefined || raw === null ? null : parseSeenToken(raw);
  if (raw !== undefined && raw !== null && !token) return res.status(400).json({ error: "seen_token is malformed" });
  try {
    if (token) await pool.query(SEEN_SQL, [token.id, token.at]);
    else await pool.query(SEEN_NOW_SQL);
    res.json({ ok: true });
  } catch (err) {
    console.error("/api/whats-new/seen error:", err.message);
    res.status(500).json({ error: "An internal error occurred." });
  }
});

module.exports = router;
module.exports.gatherWhatsNew = gatherWhatsNew;
module.exports.parseSeenToken = parseSeenToken;
module.exports.SEEN_SQL = SEEN_SQL;
module.exports.SEEN_NOW_SQL = SEEN_NOW_SQL;
