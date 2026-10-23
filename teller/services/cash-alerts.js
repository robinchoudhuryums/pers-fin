// ============================================================================
// Low projected cash alert (roadmap T2.2 L2)
// ============================================================================
// runCashAlerts(pool, { now, today, deps }) — called hourly by the "cash-alerts"
// away job (startup.js; not activity-gated, INV-77). Off by default
// (user_settings.cash_alert_enabled).
//
//   1. Evaluates only when there is something new: the newest data stamp
//      (a spendable account's balance_updated_at, last_txn_sync_at,
//      last_balance_sync_at, any Plaid item's / Teller enrollment's
//      last_synced_at) is newer than cash_alerts_checked_at, or the last check
//      was on an earlier APP_TIMEZONE day. Otherwise → "unchanged", no write.
//   2. Freshness gate: no alert when the newest spendable-account balance is
//      older than STALE_BALANCE_HOURS (or unknown) — an old balance must not
//      read as "your cash is about to run out" → "skipped".
//   3. Projects cash_alert_horizon_days ahead with the dashboard's forecast
//      (services/cash-flow.js) and looks for the first day below
//      cash_alert_threshold. None → "clear" (any earlier alert state is dropped;
//      recovery is silent).
//   4. Dedup: a breach notifies when no alert is on record, when it moved at
//      least EARLIER_DAYS earlier than the one notified, or RENOTIFY_HOURS after
//      the last notification while it persists → "notified"; else "held".
//      The state advances only when the notification was LOGGED (the F24 rule),
//      and only then is the opt-in critical-alert email sent; an unlogged one
//      leaves cash_alerts_checked_at alone so the next tick retries.
//
// State (user_settings.cash_alert_state JSONB):
//   { alert: { breach_date, low_date, low_balance, notified_at } | null,
//     last_check: { at, outcome, reason?, breach_date? } }
// ============================================================================
const { INVESTMENT_ACCOUNT_TYPES, todayStr, APP_TIMEZONE } = require("./financial-queries");
const { addDaysStr, parseYmd } = require("./cadence");

const STALE_BALANCE_HOURS = 36;
const RENOTIFY_HOURS = 72;
const EARLIER_DAYS = 3;
const TAG = "cash-low";

// A disabled feature costs no DB read for the rest of the local day; a Settings
// change to any cash_alert_* field clears this (routes/settings.js).
let _disabledDay = null;
function invalidate() { _disabledDay = null; }

function money(n) {
  const abs = Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return (n < 0 ? "-$" : "$") + abs;
}
function dayLabel(ymd) {
  const p = parseYmd(ymd);
  return new Date(Date.UTC(p.y, p.m, p.d)).toLocaleDateString("en-US", { timeZone: "UTC", weekday: "short", month: "short", day: "numeric" });
}
function localDayOf(ts) {
  try { return new Date(ts).toLocaleDateString("en-CA", { timeZone: APP_TIMEZONE }); }
  catch { return new Date(ts).toISOString().slice(0, 10); }
}

// Pure: does this breach warrant a (new) notification?
function shouldNotify(breach, alert, now) {
  if (!alert || !alert.breach_date) return true;
  if (breach.date <= addDaysStr(alert.breach_date, -EARLIER_DAYS)) return true;
  const last = alert.notified_at ? new Date(alert.notified_at).getTime() : 0;
  return now.getTime() - last >= RENOTIFY_HOURS * 3600e3;
}

function alertText(threshold, breach, lowest) {
  return `Your cash is projected to fall below ${money(threshold)} on ${dayLabel(breach.date)}` +
    (lowest ? ` — lowest ${money(lowest.balance)} on ${dayLabel(lowest.date)}` : "") +
    ". The forecast counts your bills, paychecks and usual spending.";
}

async function runCashAlerts(pool, { now = new Date(), today = todayStr(), deps = {} } = {}) {
  if (_disabledDay === today) return { status: "disabled", ran: false };
  const forecast = deps.forecast || ((days) => require("./cash-flow").getCashFlowForecast(pool, { days, today }));
  const sendToAll = deps.sendToAll || ((p) => require("../routes/notifications").sendToAll(p));
  const sendEmail = deps.sendEmail || ((t, b) => require("../routes/persistent").sendCriticalAlertEmail(t, b));

  const { rows } = await pool.query(`
    SELECT s.cash_alert_enabled, s.cash_alert_threshold, s.cash_alert_horizon_days,
           s.cash_alert_state, s.cash_alerts_checked_at,
           b.balances_at,
           GREATEST(b.balances_at, s.last_txn_sync_at, s.last_balance_sync_at,
                    (SELECT max(last_synced_at) FROM plaid_items),
                    (SELECT max(last_synced_at) FROM teller_enrollments)) AS data_at
      FROM user_settings s
     CROSS JOIN (SELECT max(la.balance_updated_at) AS balances_at
                   FROM linked_accounts la
                  WHERE la.type = 'depository' AND NOT ${INVESTMENT_ACCOUNT_TYPES}) b
     WHERE s.id = 1`);
  const s = rows[0];
  if (!s || !s.cash_alert_enabled) { _disabledDay = today; return { status: "disabled", ran: false }; }

  const checkedAt = s.cash_alerts_checked_at ? new Date(s.cash_alerts_checked_at) : null;
  const dataAt = s.data_at ? new Date(s.data_at) : null;
  if (checkedAt && localDayOf(checkedAt) === today && !(dataAt && dataAt > checkedAt)) {
    return { status: "unchanged", ran: false };
  }

  const state = (s.cash_alert_state && typeof s.cash_alert_state === "object") ? s.cash_alert_state : {};
  const at = now.toISOString();
  const save = (next) => pool.query(
    "UPDATE user_settings SET cash_alert_state = $1::jsonb, cash_alerts_checked_at = $2 WHERE id = 1",
    [JSON.stringify(next), at]);

  const balancesAt = s.balances_at ? new Date(s.balances_at) : null;
  if (!balancesAt || now.getTime() - balancesAt.getTime() > STALE_BALANCE_HOURS * 3600e3) {
    await save({ alert: state.alert || null, last_check: { at, outcome: "skipped", reason: balancesAt ? "stale_balances" : "no_balances" } });
    return { status: "skipped", ran: true, reason: balancesAt ? "stale_balances" : "no_balances" };
  }

  const threshold = parseFloat(s.cash_alert_threshold);
  const days = parseInt(s.cash_alert_horizon_days, 10) || 14;
  const f = await forecast(days);
  const { firstBelow } = require("./cash-flow");
  const breach = firstBelow(f.projection, threshold);
  if (!breach) {
    await save({ alert: null, last_check: { at, outcome: "clear" } });
    return { status: "clear", ran: true };
  }

  const prev = state.alert || null;
  if (!shouldNotify(breach, prev, now)) {
    await save({ alert: prev, last_check: { at, outcome: "held", breach_date: breach.date } });
    return { status: "held", ran: true, breach };
  }

  const body = alertText(threshold, breach, f.lowest);
  const r = await sendToAll({ title: "Low cash ahead", body, tag: TAG, data: { url: "/dashboard" } });
  if (!(r && r.logged)) {
    // Not recorded → not deduped: leave the check unstamped so the next tick retries.
    console.error("Cash alert: notification not logged — will retry on the next tick.");
    return { status: "unlogged", ran: true, breach };
  }
  try { await sendEmail("Low cash ahead", body); }
  catch (e) { console.error("Cash alert email error:", e.message); }
  await save({
    alert: { breach_date: breach.date, low_date: f.lowest ? f.lowest.date : breach.date,
             low_balance: f.lowest ? f.lowest.balance : breach.balance, notified_at: at },
    last_check: { at, outcome: "notified", breach_date: breach.date },
  });
  return { status: "notified", ran: true, breach };
}

module.exports = {
  runCashAlerts, shouldNotify, alertText, invalidate,
  STALE_BALANCE_HOURS, RENOTIFY_HOURS, EARLIER_DAYS, TAG,
  _reset() { _disabledDay = null; },
};
