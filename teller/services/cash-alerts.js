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
//   5. Per-account floors (L4, checked first, under the same switch and the same
//      "something new" gate): a spendable account with low_balance_floor set
//      whose current balance (available, else current) is below it pushes
//      "Low balance: <name>" once per account per 24 h (sentRecently); an
//      account whose own balance is older than 36 h is skipped. Push only.
//
// State (user_settings.cash_alert_state JSONB):
//   { alert: { breach_date, low_date, low_balance, notified_at } | null,
//     last_check: { at, outcome, reason?, breach_date?, floors_below } }
// ============================================================================
const { INVESTMENT_ACCOUNT_TYPES, todayStr, APP_TIMEZONE } = require("./financial-queries");
const { addDaysStr, parseYmd } = require("./cadence");

const STALE_BALANCE_HOURS = 36;
const RENOTIFY_HOURS = 72;
const EARLIER_DAYS = 3;
const TAG = "cash-low";
const FLOOR_TAG = "balance-floor-";
const FLOOR_RENOTIFY_HOURS = 24;

// A disabled feature costs no DB read for the rest of the local day; a Settings
// change to any cash_alert_* field — or an account floor — clears this
// (routes/settings.js, PATCH /api/accounts/:id). It also forces the next tick
// to evaluate (cycle-8 F12): the "nothing new since the last check" gate used
// to hold a raised threshold, a longer horizon or a new floor until the next
// bank sync or local day.
let _disabledDay = null;
let _forceNext = false;
function invalidate() { _disabledDay = null; _forceNext = true; }

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

// Pure: does this breach warrant a (new) notification? `alert` is the current
// breach's record, or — after a "clear" — the last one notified (cycle-8 F11:
// a projection hovering around the floor, $498 → $503 → $497, used to wipe the
// record on the clear and announce the next dip at once, several times a day).
// So a dip that comes back within RENOTIFY_HOURS of the last notification is
// held unless it is EARLIER_DAYS earlier, exactly like a breach that never
// cleared.
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
  const sendEmail = deps.sendEmail || ((t, b, o) => require("../routes/persistent").sendCriticalAlertEmail(t, b, o));
  const sentRecently = deps.sentRecently || ((t, h) => require("../routes/notifications").sentRecently(t, h));

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
  // Off: nothing to force (switching it on invalidates again).
  if (!s || !s.cash_alert_enabled) { _disabledDay = today; _forceNext = false; return { status: "disabled", ran: false }; }

  const checkedAt = s.cash_alerts_checked_at ? new Date(s.cash_alerts_checked_at) : null;
  const dataAt = s.data_at ? new Date(s.data_at) : null;
  if (!_forceNext && checkedAt && localDayOf(checkedAt) === today && !(dataAt && dataAt > checkedAt)) {
    return { status: "unchanged", ran: false };
  }

  const state = (s.cash_alert_state && typeof s.cash_alert_state === "object") ? s.cash_alert_state : {};
  const at = now.toISOString();

  // Per-account floors first (L4) — each on its own balance's freshness.
  const floors = await checkFloors(pool, { now, sendToAll, sentRecently });
  const proj = await checkProjection(s, state, { now, at, forecast, sendToAll, sendEmail });

  // An unlogged push isn't deduped, so the check stays unstamped and the next
  // tick retries; the projection's own state is still saved when ITS push was
  // logged (otherwise a retry would announce it twice).
  const stamp = !(proj.unlogged || floors.unlogged);
  if (proj.next) {
    const next = { ...proj.next, last_check: { ...proj.next.last_check, floors_below: floors.below } };
    await pool.query(
      `UPDATE user_settings SET cash_alert_state = $1::jsonb,
              cash_alerts_checked_at = CASE WHEN $3::boolean THEN $2::timestamptz ELSE cash_alerts_checked_at END
        WHERE id = 1`,
      [JSON.stringify(next), at, stamp]);
  }
  // Evaluated (a throw above leaves the force in place for the next tick).
  _forceNext = false;
  const { next, unlogged, ...result } = proj;
  return { ...result, status: stamp ? result.status : "unlogged", ran: true, floors };
}

// The low projected cash check. Returns { status, breach?, reason?, unlogged?,
// next } — `next` is the state to save (absent when its push wasn't logged).
async function checkProjection(s, state, { now, at, forecast, sendToAll, sendEmail }) {
  const balancesAt = s.balances_at ? new Date(s.balances_at) : null;
  if (!balancesAt || now.getTime() - balancesAt.getTime() > STALE_BALANCE_HOURS * 3600e3) {
    const reason = balancesAt ? "stale_balances" : "no_balances";
    return { status: "skipped", reason, next: { alert: state.alert || null, last_notified: state.last_notified || null, last_check: { at, outcome: "skipped", reason } } };
  }

  const threshold = parseFloat(s.cash_alert_threshold);
  const days = parseInt(s.cash_alert_horizon_days, 10) || 14;
  const f = await forecast(days);
  const { firstBelow } = require("./cash-flow");
  const breach = firstBelow(f.projection, threshold);
  // Clear: the alert is dropped, but the last notification is remembered
  // (last_notified) so a dip right after it doesn't notify again (F11).
  const lastNotified = state.alert && state.alert.notified_at
    ? { breach_date: state.alert.breach_date, notified_at: state.alert.notified_at }
    : (state.last_notified || null);
  if (!breach) return { status: "clear", next: { alert: null, last_notified: lastNotified, last_check: { at, outcome: "clear" } } };

  const prev = state.alert || lastNotified;
  if (!shouldNotify(breach, prev, now)) {
    return { status: "held", breach, next: { alert: state.alert || null, last_notified: lastNotified, last_check: { at, outcome: "held", breach_date: breach.date } } };
  }

  const body = alertText(threshold, breach, f.lowest);
  const r = await sendToAll({ title: "Low cash ahead", body, tag: TAG, data: { url: "/dashboard" } });
  if (!(r && r.logged)) {
    console.error("Cash alert: notification not logged — will retry on the next tick.");
    return { status: "unlogged", breach, unlogged: true };
  }
  try { await sendEmail("Low cash ahead", body, { tag: TAG }); }
  catch (e) { console.error("Cash alert email error:", e.message); }
  return {
    status: "notified", breach,
    next: {
      alert: { breach_date: breach.date, low_date: f.lowest ? f.lowest.date : breach.date,
               low_balance: f.lowest ? f.lowest.balance : breach.balance, notified_at: at },
      last_notified: { breach_date: breach.date, notified_at: at },
      last_check: { at, outcome: "notified", breach_date: breach.date },
    },
  };
}

// Per-account current-balance floors (roadmap T2.2 L4): every spendable
// account with a low_balance_floor whose balance (available, else current) is
// below it pushes "Low balance: <name>" — once per account per FLOOR_RENOTIFY_HOURS
// (sentRecently on tag balance-floor-<id>). An account whose balance is older
// than STALE_BALANCE_HOURS is skipped, never alerted.
async function checkFloors(pool, { now, sendToAll, sentRecently }) {
  const { rows } = await pool.query(`
    SELECT la.id, la.name, COALESCE(la.available_balance, la.current_balance) AS balance,
           la.low_balance_floor AS floor, la.balance_updated_at
      FROM linked_accounts la
     WHERE la.low_balance_floor IS NOT NULL
       AND la.type = 'depository' AND NOT ${INVESTMENT_ACCOUNT_TYPES}
       AND COALESCE(la.available_balance, la.current_balance) IS NOT NULL
     ORDER BY la.id`);
  const out = { checked: rows.length, below: 0, notified: 0, unlogged: 0, stale: 0 };
  for (const a of rows) {
    const updated = a.balance_updated_at ? new Date(a.balance_updated_at).getTime() : 0;
    if (!updated || now.getTime() - updated > STALE_BALANCE_HOURS * 3600e3) { out.stale++; continue; }
    const balance = parseFloat(a.balance), floor = parseFloat(a.floor);
    if (!(balance < floor)) continue;
    out.below++;
    const tag = FLOOR_TAG + a.id;
    if (await sentRecently(tag, FLOOR_RENOTIFY_HOURS)) continue;
    const r = await sendToAll({
      title: "Low balance: " + a.name,
      body: `${a.name} is at ${money(balance)}, below your ${money(floor)} floor.`,
      tag, data: { url: "/dashboard" },
    });
    if (r && r.logged) out.notified++;
    else { out.unlogged++; console.error("Balance floor alert: notification not logged — will retry on the next tick."); }
  }
  return out;
}

module.exports = {
  runCashAlerts, shouldNotify, alertText, invalidate,
  STALE_BALANCE_HOURS, RENOTIFY_HOURS, EARLIER_DAYS, TAG, FLOOR_TAG, FLOOR_RENOTIFY_HOURS,
  _reset() { _disabledDay = null; },
};
