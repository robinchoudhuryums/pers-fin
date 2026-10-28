// ============================================================================
// "Tell me when my plan changes" (roadmap T4.1 A4, plan decision 8)
// ============================================================================
// runAdviceAlerts(pool, { now, today, deps }) — called hourly by the
// "advice-plan" away job (startup.js; not activity-gated, INV-77). Off by
// default (user_settings.advice_alerts_enabled).
//
//   1. At most once a local (APP_TIMEZONE) day: the last evaluation's day is
//      advice_state.checked_on, and an in-memory memo skips even the settings
//      read for the rest of that day. Off → one settings read a day.
//   2. Works out the plan (services/advice.js getAdvicePlan — the dashboard
//      card's plan). A plan that can't be worked out changes nothing.
//   3. Compares it with the plan last notified (or, the first time, the
//      baseline it records without notifying): it notifies when the headline
//      step changes, when a debt step's target debt changes, or when the
//      amount per period (per paycheck, else per month) moves by at least
//      AMOUNT_SHARE (20%) AND AMOUNT_MIN ($50). Push only, never email.
//   4. The signature advances only when the notification was LOGGED; an
//      unlogged one leaves the day unchecked so the next tick retries.
//
// State (user_settings.advice_state JSONB):
//   { signature: { step, target, unit, amount, amount_monthly, at } | null,
//     checked_on, notified_at?, last_check: { at, outcome } }
// ============================================================================
const { todayStr } = require("./financial-queries");

const AMOUNT_SHARE = 0.2;
const AMOUNT_MIN = 50;
const TAG = "advice-plan";
const DEBT_STEPS = new Set(["high_interest_debt", "medium_interest_debt"]);

// Off → no settings read for the rest of the local day; checked today → no
// read either. A Settings change to advice_alerts_enabled clears both.
let _disabledDay = null;
let _doneDay = null;
function invalidate() { _disabledDay = null; _doneDay = null; }

function usd(n) {
  return "$" + Math.round(Math.abs(Number(n) || 0)).toLocaleString("en-US");
}

// The debt a debt step pays down first (the avalanche's first row with an
// extra payment, else its first row); null for the other steps.
function planTarget(plan) {
  if (!DEBT_STEPS.has(plan.headline.step)) return null;
  const rows = (plan.allocation && plan.allocation.debts) || [];
  const first = rows.find((r) => Number(r.extra_monthly) > 0) || rows[0];
  return first ? first.name : null;
}

function signatureOf(plan, at) {
  const unit = plan.period && plan.period.unit === "paycheck" ? "paycheck" : "month";
  const monthly = Number(plan.headline.amount_monthly) || 0;
  const per = plan.headline.amount_per_period;
  return {
    step: plan.headline.step,
    target: planTarget(plan),
    unit,
    amount: per != null ? Number(per) : monthly,
    amount_monthly: monthly,
    at,
  };
}

// Pure: what changed between the last notified signature and this one?
// → null (nothing worth a push) or { kind: "step" | "target" | "amount" }.
function planChange(prev, next) {
  if (!prev) return null;
  if (prev.step !== next.step) return { kind: "step" };
  if (DEBT_STEPS.has(next.step) && prev.target && next.target && prev.target !== next.target) return { kind: "target" };
  // Compare in the same unit: per period when it didn't change, else monthly.
  const sameUnit = prev.unit === next.unit;
  const before = sameUnit ? Number(prev.amount) || 0 : Number(prev.amount_monthly) || 0;
  const after = sameUnit ? Number(next.amount) || 0 : Number(next.amount_monthly) || 0;
  const delta = Math.abs(after - before);
  if (delta >= AMOUNT_MIN && delta >= AMOUNT_SHARE * before) return { kind: "amount" };
  return null;
}

// "puts $250 per paycheck toward the emergency fund" — the new plan in words.
function planPhrase(plan, sig) {
  const amt = `${usd(sig.amount)} per ${sig.unit}`;
  switch (sig.step) {
    case "starter_buffer": return `puts ${amt} toward a starter cash buffer`;
    case "emergency_fund": return `puts ${amt} toward the emergency fund`;
    case "high_interest_debt": return `puts ${amt} toward ${sig.target || "your highest-interest debt"}`;
    case "medium_interest_debt": return `splits ${amt} between ${sig.target || "your debt"} and investing`;
    case "invest": return `puts ${amt} toward investing`;
    default: return null;
  }
}

// Pure: the notification body. A debt the old plan targeted that has no
// balance left in the new one leads it ("Card X is paid off — …").
function changeText(prev, sig, plan, change) {
  const phrase = sig.amount > 0 ? planPhrase(plan, sig) : null;
  if (!phrase) return plan.headline.text;
  const debts = Array.isArray(plan.debts) ? plan.debts : [];
  const prevTarget = prev && prev.target;
  // Paid off = no longer a carried balance (a card now paid in full each
  // month still shows a balance, but it isn't debt any more).
  const stillOwed = prevTarget && debts.some((d) => d.name === prevTarget && d.carried !== false && Number(d.balance) > 0);
  if (prevTarget && !stillOwed && change.kind !== "amount") {
    return `${prevTarget} is paid off — your plan now ${phrase}.`;
  }
  if (change.kind === "amount") {
    const was = prev.unit === sig.unit ? `${usd(prev.amount)} per ${sig.unit}` : `${usd(prev.amount_monthly)} a month`;
    return `Your plan now ${phrase} (was ${was}).`;
  }
  return `Your plan changed — it now ${phrase}.`;
}

async function runAdviceAlerts(pool, { now = new Date(), today = todayStr(), deps = {} } = {}) {
  if (_disabledDay === today || _doneDay === today) return { status: _disabledDay === today ? "disabled" : "checked", ran: false };
  const getPlan = deps.getPlan || (() => require("./advice").getAdvicePlan(pool, { today }));
  const sendToAll = deps.sendToAll || ((p) => require("../routes/notifications").sendToAll(p));

  const { rows } = await pool.query("SELECT advice_alerts_enabled, advice_state FROM user_settings WHERE id = 1");
  const s = rows[0];
  if (!s || !s.advice_alerts_enabled) { _disabledDay = today; return { status: "disabled", ran: false }; }
  const state = (s.advice_state && typeof s.advice_state === "object") ? s.advice_state : {};
  if (state.checked_on === today) { _doneDay = today; return { status: "checked", ran: false }; }

  const at = now.toISOString();
  const save = (next) => pool.query("UPDATE user_settings SET advice_state = $1::jsonb WHERE id = 1", [JSON.stringify(next)]);
  const plan = await getPlan();
  if (!plan || !plan.ok || !plan.headline) {
    await save({ ...state, checked_on: today, last_check: { at, outcome: "no_plan" } });
    _doneDay = today;
    return { status: "no_plan", ran: true };
  }

  const sig = signatureOf(plan, at);
  const prev = state.signature || null;
  if (!prev) {
    await save({ ...state, signature: sig, checked_on: today, last_check: { at, outcome: "baseline" } });
    _doneDay = today;
    return { status: "baseline", ran: true, signature: sig };
  }
  const change = planChange(prev, sig);
  if (!change) {
    await save({ ...state, checked_on: today, last_check: { at, outcome: "unchanged" } });
    _doneDay = today;
    return { status: "unchanged", ran: true, signature: prev };
  }

  const body = changeText(prev, sig, plan, change);
  const r = await sendToAll({ title: "Your plan changed", body, tag: TAG, data: { url: "/dashboard" } });
  if (!(r && r.logged)) {
    // Not deduped → the day stays unchecked and the next tick retries.
    console.error("Plan alert: notification not logged — will retry on the next tick.");
    return { status: "unlogged", ran: true, change };
  }
  await save({ signature: sig, checked_on: today, notified_at: at, last_check: { at, outcome: "notified", kind: change.kind } });
  _doneDay = today;
  return { status: "notified", ran: true, change, body };
}

module.exports = {
  runAdviceAlerts, planChange, changeText, signatureOf, planTarget, invalidate,
  AMOUNT_SHARE, AMOUNT_MIN, TAG,
  _reset() { _disabledDay = null; _doneDay = null; },
};
