// ============================================================================
// Payday alerts (roadmap T2.2 L3) — off by default (payday_alerts_enabled)
// ============================================================================
// runPaydayLanded(pool, { today, deps }) — "Paycheck landed". The third step of
// runPostSyncSteps (routes/enrollments.js), so it follows every transaction
// sync that added rows — syncAllTransactions and the webhook per-item /
// per-enrollment syncs — and never a reconcile (which runs no post-sync steps).
//   - Candidates: settled income deposits (INCOME_PREDICATE, amount < 0)
//     created after user_settings.last_income_alert_at and dated within
//     LANDED_MAX_AGE_DAYS of today (a newly linked account's two years of
//     history must not announce old paychecks).
//   - Only a deposit that matches a LIVE income stream (getLiveIncomeStreams —
//     same source, amount within ±10%) notifies: one-off income, refunds and a
//     first paycheck from a new job (a stream needs two deposits) don't.
//   - One push per deposit (tag payday-<hash of its id>). New = an id
//     watermark with an overlap rescan (services/txn-watermark.js, cycle-8
//     E2c): rows above last_income_alert_txn_id, plus rows at or below it
//     created within LANDED_OVERLAP_HOURS of the previous check
//     (last_income_alert_at) — a CSV import commits all its rows at once with
//     ids taken before a check that ran mid-import (F51). An overlap deposit
//     whose tag is already in notification_log is skipped. The watermark
//     moves to the mark read before the candidates (never backwards); a send
//     that isn't logged stops the run with the watermark just before that
//     deposit, so the next sync retries it (the anomaly-watermark rule). With
//     no watermark yet (just switched on) it is set to the newest id and
//     nothing older is announced.
//
// runPaydayMissed(pool, { now, today, deps }) — "Payday missed?". Run by the
// hourly "cash-alerts" away job (startup.js) next to the low cash alert.
//   - For each live stream, its latest expected payday after its last deposit
//     whose grace (GRACE_DAYS) has fully passed and that is at most
//     MISSED_LOOKBACK_DAYS old.
//   - Missed only when NO deposit from that source (any amount — a raise forms
//     a new amount cluster) is dated on or after expected − GRACE_DAYS, AND the
//     account the stream's last deposit landed in belongs to a connection
//     (Teller enrollment / Plaid item, not CSV or manual) whose own
//     last_synced_at — stamped only by a complete, error-free sync — falls
//     after the grace window. A stale or failing connection never reads as a
//     missed paycheck.
//   - One push + the opt-in critical-alert email per (stream, expected date),
//     deduped through notification_log (sentRecently); the email only when the
//     push was logged (the F24 rule).
//   - Evaluates when a sync stamp moved or on a new local day (in-memory memo);
//     off → no further DB read that day (invalidate() from PATCH /api/settings).
// ============================================================================
const crypto = require("crypto");
const { INCOME_PREDICATE, getLiveIncomeStreams, todayStr, APP_TIMEZONE } = require("./financial-queries");
const { addDaysStr, incomeEventsBetween, parseYmd } = require("./cadence");
const { readMark, windowSql, advanceSql } = require("./txn-watermark");

const LANDED_MAX_AGE_DAYS = 5;
const GRACE_DAYS = 3;
const MISSED_LOOKBACK_DAYS = 14;
const AMOUNT_TOLERANCE = 0.10;
// The landed check re-reads rows at or below its id watermark created this
// long before the previous check (cycle-8 F51 / E2c): a CSV import commits
// all its rows at once, with ids allocated before a check that ran
// mid-import. A deposit in the overlap that was already announced (its tag in
// notification_log) is skipped.
const LANDED_OVERLAP_HOURS = 24;
const LANDED_DEDUPE_DAYS = 30;

const hash = (s) => crypto.createHash("sha256").update(String(s)).digest("hex").slice(0, 12);
function money(n) {
  return "$" + Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function dayLabel(d) {
  const p = parseYmd(d);
  return new Date(Date.UTC(p.y, p.m, p.d)).toLocaleDateString("en-US", { timeZone: "UTC", weekday: "short", month: "short", day: "numeric" });
}
function localDayOf(ts) {
  try { return new Date(ts).toLocaleDateString("en-CA", { timeZone: APP_TIMEZONE }); }
  catch { return new Date(ts).toISOString().slice(0, 10); }
}
function matchStream(streams, source, amount) {
  return streams.find((s) => s.source === source && Math.abs(amount - s.amount) <= s.amount * AMOUNT_TOLERANCE) || null;
}
const defaultSend = (p) => require("../routes/notifications").sendToAll(p);

// ---------------------------------------------------------------------------
async function runPaydayLanded(pool, { today = todayStr(), deps = {} } = {}) {
  const sendToAll = deps.sendToAll || defaultSend;
  const s = (await pool.query("SELECT payday_alerts_enabled, last_income_alert_txn_id::text AS last_income_alert_txn_id, last_income_alert_at::text AS last_income_alert_at FROM user_settings WHERE id = 1")).rows[0];
  if (!s || !s.payday_alerts_enabled) return { status: "disabled", notified: 0 };
  // The mark comes before the candidates, which stop at it: a deposit
  // committed after it waits for the next check.
  const mark = await readMark(pool);
  if (!s.last_income_alert_at) {
    await pool.query(advanceSql("last_income_alert_txn_id", "last_income_alert_at"), [mark.id, mark.at]);
    return { status: "initialized", notified: 0 };
  }
  // No id yet (the backfill found no row before the stored time) → nothing
  // was announced before it, so every row counts as new.
  const watermark = s.last_income_alert_txn_id || "0";
  const win = windowSql({ alias: "", watermark: "$1", since: "$2", mark: "$3", overlapHours: LANDED_OVERLAP_HOURS });
  const { rows } = await pool.query(`
    SELECT id::text AS id, transaction_id, COALESCE(user_merchant_name, merchant_name, name) AS source,
           ABS(amount) AS amount, to_char(date, 'YYYY-MM-DD') AS date,
           ${win.inOverlap} AS in_overlap
      FROM transactions
     WHERE amount < 0 AND pending = false
       AND ${win.where}
       AND date >= $4::date
       AND ${INCOME_PREDICATE}
     ORDER BY id`,
    [watermark, s.last_income_alert_at, mark.id, addDaysStr(today, -LANDED_MAX_AGE_DAYS)]);
  if (!rows.length) {
    await pool.query(advanceSql("last_income_alert_txn_id", "last_income_alert_at"), [mark.id, mark.at]);
    return { status: "none", notified: 0 };
  }

  const streams = await getLiveIncomeStreams(pool, today);
  const tagOf = (r) => "payday-" + hash(r.transaction_id);
  // Which overlap deposits were already announced — one read (F51). A failure
  // here throws: the run stops with the watermark where it was.
  const overlapTags = rows.filter((r) => r.in_overlap && matchStream(streams, r.source, parseFloat(r.amount))).map(tagOf);
  const announced = new Set();
  if (overlapTags.length) {
    const seen = await pool.query(
      `SELECT DISTINCT type FROM notification_log
        WHERE type = ANY($1::text[]) AND created_at > now() - make_interval(days => ${LANDED_DEDUPE_DAYS})`,
      [overlapTags]);
    for (const x of seen.rows) announced.add(x.type);
  }
  let notified = 0, heldAt = null;
  for (const r of rows) {
    const amount = parseFloat(r.amount);
    const stream = matchStream(streams, r.source, amount);
    if (stream && !(r.in_overlap && announced.has(tagOf(r)))) {
      // sendToAll doesn't throw — it reports { logged: false } when the
      // notification_log row (the in-app record and the dedup marker) didn't
      // land (cycle-8 F10: only a throw held the watermark back, so a failed
      // log write lost the alert for good). Either way the watermark stays
      // before this deposit and the next sync retries it — the F24 rule the
      // cash and missed-payday alerts already follow.
      let sent;
      try {
        sent = await sendToAll({
          title: "Paycheck landed",
          body: `${money(amount)} from ${r.source} (${stream.cadence}) on ${dayLabel(r.date)}.`,
          tag: tagOf(r),
          data: { url: "/dashboard" },
        });
      } catch (e) {
        sent = { logged: false, error: e.message };
      }
      if (!sent || !sent.logged) {
        console.error("Payday alert not logged — will retry after the next sync:", (sent && sent.error) || "notification_log write failed");
        heldAt = r;
        break;
      }
      notified++;
    }
  }
  // Never backwards (GREATEST): the overlap rows sit below the stored id. Held
  // at a deposit → the id just before it (its own row is retried; the rows
  // before it in id order were all handled), and the time stays where it was.
  if (heldAt) {
    await pool.query(advanceSql("last_income_alert_txn_id", "last_income_alert_at"), [String(BigInt(heldAt.id) - 1n), s.last_income_alert_at]);
  } else {
    await pool.query(advanceSql("last_income_alert_txn_id", "last_income_alert_at"), [mark.id, mark.at]);
  }
  return { status: heldAt ? "held_back" : "done", notified, considered: rows.length };
}

// ---------------------------------------------------------------------------
let _disabledDay = null;
let _lastEval = null; // "<local day>|<newest sync stamp>"
function invalidate() { _disabledDay = null; _lastEval = null; }

// Pure: the latest expected payday after the stream's last deposit whose grace
// has fully passed (expected + GRACE_DAYS < today), within the lookback — or null.
function overduePayday(stream, today) {
  const from = addDaysStr(stream.last, 1);
  const to = addDaysStr(today, -(GRACE_DAYS + 1));
  if (!from || from > to) return null;
  const due = incomeEventsBetween(stream, from, to).filter((d) => d > stream.last && d >= addDaysStr(today, -MISSED_LOOKBACK_DAYS));
  return due.length ? due[due.length - 1] : null;
}

async function runPaydayMissed(pool, { now = new Date(), today = todayStr(), deps = {} } = {}) {
  if (_disabledDay === today) return { status: "disabled", ran: false };
  const sendToAll = deps.sendToAll || defaultSend;
  const sentRecently = deps.sentRecently || ((t, h) => require("../routes/notifications").sentRecently(t, h));
  const sendEmail = deps.sendEmail || ((t, b) => require("../routes/persistent").sendCriticalAlertEmail(t, b));

  const s = (await pool.query(`
    SELECT payday_alerts_enabled,
           GREATEST(last_txn_sync_at,
                    (SELECT max(last_synced_at) FROM plaid_items),
                    (SELECT max(last_synced_at) FROM teller_enrollments)) AS sync_at
      FROM user_settings WHERE id = 1`)).rows[0];
  if (!s || !s.payday_alerts_enabled) { _disabledDay = today; return { status: "disabled", ran: false }; }
  const evalKey = today + "|" + (s.sync_at ? new Date(s.sync_at).toISOString() : "");
  if (_lastEval === evalKey) return { status: "unchanged", ran: false };

  const streams = await getLiveIncomeStreams(pool, today);
  const due = streams.map((st) => ({ stream: st, expected: overduePayday(st, today) })).filter((x) => x.expected);
  let notified = 0, unlogged = 0;
  for (const { stream, expected } of due) {
    const since = addDaysStr(expected, -GRACE_DAYS);
    const arrived = await pool.query(
      `SELECT 1 FROM transactions
        WHERE amount < 0 AND pending = false AND date >= $1::date
          AND COALESCE(user_merchant_name, merchant_name, name) = $2 LIMIT 1`, [since, stream.source]);
    if (arrived.rows.length) continue;

    // The connection that carries this pay, and when it last synced cleanly.
    const conn = (await pool.query(
      `SELECT COALESCE(te.last_synced_at, pi.last_synced_at) AS synced_at
         FROM transactions t
         JOIN linked_accounts la ON la.account_id = t.account_id
         LEFT JOIN teller_enrollments te ON te.id = la.teller_enrollment_id AND te.status = 'GOOD'
         LEFT JOIN plaid_items pi ON pi.id = la.plaid_item_id AND pi.status = 'GOOD'
        WHERE t.amount < 0 AND t.pending = false AND t.date = $1::date
          AND COALESCE(t.user_merchant_name, t.merchant_name, t.name) = $2
        ORDER BY 1 DESC NULLS LAST LIMIT 1`, [stream.last, stream.source])).rows[0];
    const syncedAt = conn && conn.synced_at;
    if (!syncedAt || localDayOf(syncedAt) <= addDaysStr(expected, GRACE_DAYS)) continue;

    const tag = "payday-missed-" + hash(stream.source + "|" + stream.amount) + "-" + expected;
    if (await sentRecently(tag, 24 * 60)) continue;
    const body = `Your ${stream.cadence} pay from ${stream.source} (about ${money(stream.amount)}) was expected on ${dayLabel(expected)} and hasn't arrived — your bank connection synced after that.`;
    const r = await sendToAll({ title: "Payday missed?", body, tag, data: { url: "/transactions" } });
    if (!(r && r.logged)) { unlogged++; continue; }
    notified++;
    try { await sendEmail("Payday missed?", body); }
    catch (e) { console.error("Payday missed email error:", e.message); }
  }
  // An unlogged push isn't deduped — leave the memo unset so the next tick retries.
  if (!unlogged) _lastEval = evalKey;
  return { status: unlogged ? "unlogged" : "done", ran: true, notified, checked: due.length };
}

module.exports = {
  runPaydayLanded, runPaydayMissed, overduePayday, invalidate,
  LANDED_MAX_AGE_DAYS, GRACE_DAYS, MISSED_LOOKBACK_DAYS, LANDED_OVERLAP_HOURS,
  _reset() { _disabledDay = null; _lastEval = null; },
};
