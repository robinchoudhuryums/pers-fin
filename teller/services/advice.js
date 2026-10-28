// "Where should my extra money go?" — the advice engine (roadmap T4.1 A1,
// .cycle/plan-t4-1-advisory.md).
//
// getAdviceInputs(pool) reads each source once (fail-soft: a failing read is
// null plus a fixed-sentence error); buildAdvicePlan(inputs) is PURE and
// computes every figure (decision 1 — the insight module and Ask only word its
// output, and the dashboard card costs no AI spend). The plan walks the steps
// in order (decision 2) and the first that applies is the headline:
//   1. minimum payments on every card and loan        (always first)
//   2. a starter cash buffer: floor + 1 month of spending
//   3. high-interest debt (APR ≥ 8%): the whole surplus, avalanche order
//   4. an emergency fund of 3 months of spending
//   5. medium-interest debt (APR 4–8%): the surplus split 50/50 with investing
//   6. invest
// The surplus counts only when each of the last 3 COMPLETED months netted at
// least max($200, 10% of income) (decision 5); 60% of the median is
// recommended, rounded down to $25 per paycheck (decision 6). Every threshold
// is a named constant here, not a setting (decision 9). Nothing names a
// security or a fund (decision 10).

const { todayStr, previousMonthKey } = require("./financial-queries");
const { addMonthsYm } = require("./projections");

const DISCLAIMER = "Educational, based on your data — not financial advice.";

const HIGH_APR = 8;               // debt at or above this APR takes the whole surplus
const MEDIUM_APR = 4;             // 4–8% shares the surplus 50/50 with investing
const UNKNOWN_CARD_APR = 22;      // a carried card with no APR on file
const SURPLUS_MONTHS = 3;         // completed months that must each clear the bar
const SURPLUS_MIN = 200;          // the bar: at least this much net …
const SURPLUS_MIN_SHARE = 0.10;   // … or this share of that month's income, whichever is larger
const RECOMMEND_SHARE = 0.60;     // of the surplus; the rest is slack
const ROUND_TO = 25;              // per paycheck, rounded down
const STARTER_BUFFER_MONTHS = 1;  // floor + this many months of spending
const EMERGENCY_MONTHS = 3;
const CASH_LOOKAHEAD_DAYS = 60;   // the lowest projected cash day must stay ≥ the floor
const DEFAULT_CASH_FLOOR = 500;   // user_settings.cash_alert_threshold's default
const CARRY_LOOKBACK_DAYS = 60;   // an interest charge this recent = a carried balance
const MIN_PAYMENT_FLOOR = 25;     // an estimated minimum: max($25, 1% + a month's interest)
const MIN_PAYMENT_PRINCIPAL = 0.01;
const MINIMUM_ONLY_TOLERANCE = 1.10; // a last payment within 10% of the minimum = paying the minimum
const UTILIZATION_TARGET = 0.30;
const MEDIUM_DEBT_SHARE = 0.5;
const SIM_CAP_MONTHS = 600;
const PAYCHECKS_PER_YEAR = { weekly: 52, biweekly: 26, semimonthly: 24, monthly: 12 };
const GOAL_CATCHUP_MIN = 5;       // a goal is behind when it needs at least this much more a month

// The plan needs these; without one it isn't worked out at all (a missing debt
// or transfer read would otherwise say "invest" over a 24% card).
const CRITICAL_SOURCES = ["months", "cash", "debts", "activity", "transfers"];
const SOURCE_ERRORS = {
  months: "Recent income and spending couldn't be read.",
  streams: "Your pay schedule couldn't be read.",
  cash: "The cash forecast couldn't be worked out.",
  settings: "Your cash floor couldn't be read.",
  debts: "Your cards and loans couldn't be read.",
  activity: "Recent card activity couldn't be read.",
  transfers: "Your recurring savings transfers couldn't be read.",
  goals: "Your goals couldn't be read.",
};
const PLAN_ERROR = "Your plan couldn't be worked out — part of your data couldn't be read.";

// A card's interest charge: Plaid's PFC, or the statement wording (word
// boundaries — INV-10). COALESCEd so a row with no PFC is false, not NULL.
const INTEREST_CHARGE_SQL = `(t.amount > 0 AND (
  COALESCE(t.personal_finance_category->>'detailed', '') = 'BANK_FEES_INTEREST_CHARGE'
  OR CONCAT_WS(' ', t.merchant_name, t.name) ~* '\\y(interest charge|interest charged|purchase interest|cash advance interest|finance charge)\\y'))`;

const DEBTS_SQL = `
  SELECT la.id, la.account_id, la.name, la.mask, la.type, la.subtype,
         la.current_balance, la.available_balance, la.credit_limit, la.apr,
         la.minimum_payment, la.monthly_payment, la.last_payment_amount, la.last_payment_date
  FROM linked_accounts la
  WHERE la.type IN ('credit', 'loan') AND la.current_balance > 0
  ORDER BY la.id`;

const ACTIVITY_SQL = `
  SELECT t.account_id, COUNT(*)::int AS txns, bool_or(${INTEREST_CHARGE_SQL}) AS interest
  FROM transactions t
  JOIN linked_accounts la ON la.account_id = t.account_id
  WHERE la.type = 'credit' AND t.date >= $1::date - ${CARRY_LOOKBACK_DAYS}
  GROUP BY t.account_id`;

// Money already moved to savings / investments every month (decision 5 — the
// same money isn't counted twice).
const TRANSFERS_SQL = `
  SELECT display_name, amount, cadence_days, transfer_type
  FROM recurring_transfers
  WHERE is_active = true AND is_dismissed = false AND direction = 'outgoing'
    AND transfer_type IN ('savings', 'investment')`;

// Active goals with what deriveGoalProgress needs (INV-11 — a funding-linked
// goal is balance − baseline, the Goals page's figure). Roadmap T4.1 A5.
const GOALS_SQL = `
  SELECT g.id, g.name, g.target_amount, g.current_amount, g.monthly_contribution,
         g.target_date::text AS target_date, g.interest_rate,
         g.funding_account_id, g.funding_investment_id, g.goal_baseline_amount,
         COALESCE(la.available_balance, la.current_balance) AS funding_account_balance,
         la.name AS funding_account_name,
         ia.balance AS funding_investment_balance,
         ia.name AS funding_investment_name
  FROM financial_goals g
  LEFT JOIN linked_accounts     la ON la.id = g.funding_account_id
  LEFT JOIN investment_accounts ia ON ia.id = g.funding_investment_id
  WHERE g.is_active = true
  ORDER BY g.target_date NULLS LAST, g.id`;

// Whole days from a to b ('YYYY-MM-DD').
const dayGap = (a, b) => Math.round((Date.parse(b + "T00:00:00Z") - Date.parse(a + "T00:00:00Z")) / 86400000);
const money = (x) => Math.round((Number(x) || 0) * 100) / 100;
function num(v) {
  if (v === null || v === undefined || v === "") return null;
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : null;
}
const fmt = (n) => (n < 0 ? "-$" : "$") + Math.abs(money(n)).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// ---------------------------------------------------------------- inputs

async function getAdviceInputs(pool, { today = todayStr(), deps = {} } = {}) {
  const fq = require("./financial-queries");
  const cf = require("./cash-flow");
  const readers = {
    months: () => fq.getMonthlyIncomeAndSpending(pool, SURPLUS_MONTHS + 1),
    streams: () => fq.getLiveIncomeStreams(pool, today),
    cash: async () => {
      const f = await cf.getCashFlowForecast(pool, { days: CASH_LOOKAHEAD_DAYS, today });
      return { starting_balance: f.starting_balance, lowest: f.lowest };
    },
    settings: async () => (await pool.query("SELECT cash_alert_threshold FROM user_settings WHERE id = 1")).rows[0] || {},
    debts: async () => (await pool.query(DEBTS_SQL)).rows,
    activity: async () => (await pool.query(ACTIVITY_SQL, [today])).rows,
    transfers: async () => (await pool.query(TRANSFERS_SQL)).rows,
    goals: async () => {
      const { deriveGoalProgress } = require("../routes/goals");
      return (await pool.query(GOALS_SQL)).rows.map((g) => ({
        id: g.id,
        name: g.name,
        target: num(g.target_amount) || 0,
        current: money(deriveGoalProgress(g).current),
        monthly_contribution: num(g.monthly_contribution) || 0,
        target_date: g.target_date ? String(g.target_date).slice(0, 10) : null,
        interest_rate: num(g.interest_rate) || 0,
      }));
    },
    ...deps,
  };
  const errors = [];
  const out = { today, errors };
  await Promise.all(Object.keys(SOURCE_ERRORS).map(async (key) => {
    try {
      out[key] = await readers[key]();
    } catch (err) {
      out[key] = null;
      errors.push({ source: key, error: SOURCE_ERRORS[key] });
      console.error(`[advice] ${key} read failed:`, err && err.message);
    }
  }));
  errors.sort((a, b) => (a.source < b.source ? -1 : 1));
  return out;
}

// ---------------------------------------------------------------- pieces

// The last N completed month keys before today's month, oldest first.
function completedMonthKeys(today, n = SURPLUS_MONTHS) {
  const keys = [];
  let k = today.slice(0, 7);
  for (let i = 0; i < n; i++) { k = previousMonthKey(k); keys.unshift(k); }
  return keys;
}

function median(values) {
  const s = [...values].sort((a, b) => a - b);
  if (!s.length) return 0;
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

// Decision 5's bar, month by month.
function surplusMonths(rows, today) {
  const byMonth = new Map((rows || []).map((r) => [r.month, r]));
  return completedMonthKeys(today).map((month) => {
    const r = byMonth.get(month);
    const income = money(r ? r.income : 0);
    const spending = money(r ? r.spending : 0);
    const net = money(income - spending);
    const bar = money(Math.max(SURPLUS_MIN, income * SURPLUS_MIN_SHARE));
    return { month, income, spending, net, bar, has_data: !!r, ok: !!r && net >= bar };
  });
}

// A card's limit: credit_limit, else owed + available when available is known
// (AIN-7) — otherwise unknown.
function cardLimit(row) {
  const cl = num(row.credit_limit);
  if (cl != null && cl > 0) return cl;
  if (row.available_balance == null) return null;
  const derived = (num(row.current_balance) || 0) + (num(row.available_balance) || 0);
  return derived > 0 ? derived : null;
}

// Decision 3: a card paid in full every month is not debt. It's carried when
// it was charged interest in the last 60 days, or its last payment was about
// the minimum while more was owed. (The plan's "last payment smaller than the
// balance it was paying" needs the statement balance, which isn't stored until
// A8 — so a minimum-sized payment stands in for it.) No activity and no
// payment data → unknown, treated as not carried and said so.
function carryStatus(row, activity) {
  const balance = num(row.current_balance) || 0;
  if (activity && activity.interest) return { carried: true, reason: "interest_charged" };
  const last = num(row.last_payment_amount);
  const min = num(row.minimum_payment);
  if (last != null && min != null && min > 0 && last <= min * MINIMUM_ONLY_TOLERANCE && balance > last) {
    return { carried: true, reason: "minimum_payments" };
  }
  if (last == null && !(activity && activity.txns > 0)) return { carried: false, reason: "unknown" };
  return { carried: false, reason: "paid_in_full" };
}

function tierOf(apr) {
  if (apr == null) return "unknown";
  if (apr >= HIGH_APR) return "high";
  if (apr >= MEDIUM_APR) return "medium";
  return "low";
}

function normalizeDebts(rows, activityRows) {
  const activity = new Map((activityRows || []).map((a) => [a.account_id, a]));
  return (rows || []).map((r) => {
    const balance = money(num(r.current_balance) || 0);
    const isCard = r.type === "credit";
    const aprStored = num(r.apr);
    const carry = isCard ? carryStatus(r, activity.get(r.account_id)) : { carried: true, reason: "installment" };
    let apr = aprStored;
    let aprAssumed = false;
    if (apr == null && isCard && carry.carried) { apr = UNKNOWN_CARD_APR; aprAssumed = true; }
    let minimum = null, minimumEstimated = false;
    if (isCard) {
      const stored = num(r.minimum_payment);
      if (stored != null && stored > 0) minimum = Math.min(stored, balance);
      else {
        const est = Math.max(MIN_PAYMENT_FLOOR, balance * MIN_PAYMENT_PRINCIPAL + balance * (apr || 0) / 1200);
        minimum = Math.min(money(est), balance);
        minimumEstimated = true;
      }
    } else {
      const pay = num(r.monthly_payment);
      if (pay != null && pay > 0) minimum = Math.min(pay, balance);
    }
    const limit = isCard ? cardLimit(r) : null;
    const debt = {
      id: r.id,
      name: r.name,
      mask: r.mask || null,
      type: r.type,
      balance,
      apr: apr == null ? null : money(apr),
      apr_assumed: aprAssumed,
      minimum: minimum == null ? null : money(minimum),
      minimum_estimated: minimumEstimated,
      carried: carry.carried,
      carry_reason: carry.reason,
      tier: carry.carried ? tierOf(apr) : "paid_in_full",
      limit: limit == null ? null : money(limit),
      utilization_pct: limit ? Math.round((balance / limit) * 100) : null,
      utilization_tip: null,
    };
    // Decision 4's optional tip: what brings a card under 30% before its due date.
    if (limit && balance > limit * UTILIZATION_TARGET) {
      const pay = Math.ceil(balance - limit * UTILIZATION_TARGET);
      debt.utilization_tip = { pay, text: `Paying ${fmt(pay)} on ${r.name} before its due date brings it under ${Math.round(UTILIZATION_TARGET * 100)}% of its limit.` };
    }
    return debt;
  });
}

// One step of the simulation order: avalanche = highest APR first, a tie to
// the smaller balance; snowball = smallest balance first.
const AVALANCHE = (a, b) => (b.apr || 0) - (a.apr || 0) || a.balance - b.balance;
const SNOWBALL = (a, b) => a.balance - b.balance || (b.apr || 0) - (a.apr || 0);

// Month by month: interest, every minimum, then `extra` (plus the minimums of
// debts already paid off) to the first debt in `order`, overflow to the next.
function simulatePayoff(debts, extra, order) {
  const st = [...debts].sort(order).map((d) => ({ id: d.id, b: d.balance, r: (d.apr || 0) / 1200, min: d.minimum, interest: 0, months: null, firstPayment: 0 }));
  for (let month = 1; month <= SIM_CAP_MONTHS && st.some((s) => s.months == null); month++) {
    let pool = extra;
    for (const s of st) {
      if (s.months != null) { pool += s.min; continue; }
      const i = s.b * s.r;
      s.b += i;
      s.interest += i;
      const pay = Math.min(s.min, s.b);
      s.b -= pay;
      pool += s.min - pay;
      if (month === 1) s.firstPayment += pay;
    }
    for (const s of st) {
      if (s.months != null || pool <= 0) continue;
      const pay = Math.min(pool, s.b);
      s.b -= pay;
      pool -= pay;
      if (month === 1) s.firstPayment += pay;
    }
    for (const s of st) if (s.months == null && s.b <= 0.005) { s.months = month; s.b = 0; }
  }
  return st;
}

// A debt paid at its minimum alone: total interest, or null when the minimum
// never pays it off (it doesn't cover the interest, or takes 50+ years).
function minimumOnlyInterest(d) {
  const st = simulatePayoff([d], 0, AVALANCHE)[0];
  return st.months == null ? null : st.interest;
}

function allocateDebts(debts, extraMonthly, today, ppy) {
  if (!debts.length) return { rows: [], snowball: null };
  const av = simulatePayoff(debts, extraMonthly, AVALANCHE);
  const byId = new Map(av.map((s) => [s.id, s]));
  const rows = [...debts].sort(AVALANCHE).map((d) => {
    const s = byId.get(d.id);
    const minOnly = minimumOnlyInterest(d);
    const thisMonth = money(s.firstPayment);
    return {
      id: d.id,
      name: d.name,
      apr: d.apr,
      apr_assumed: d.apr_assumed,
      balance: d.balance,
      minimum_monthly: d.minimum,
      extra_monthly: money(Math.max(0, thisMonth - d.minimum)),
      payment_monthly: thisMonth,
      per_period: money((thisMonth * 12) / ppy),
      months_to_payoff: s.months,
      payoff_month: s.months == null ? null : addMonthsYm(today, s.months),
      interest: s.months == null ? null : money(s.interest),
      interest_saved: minOnly == null || s.months == null ? null : money(Math.max(0, minOnly - s.interest)),
      minimum_never_pays_off: minOnly == null,
    };
  });
  let snowball = null;
  if (debts.length > 1 && av.every((s) => s.months != null)) {
    const sb = simulatePayoff(debts, extraMonthly, SNOWBALL);
    if (sb.every((s) => s.months != null)) {
      const cost = money(sb.reduce((t, s) => t + s.interest, 0) - av.reduce((t, s) => t + s.interest, 0));
      snowball = {
        extra_cost: Math.max(0, cost),
        text: cost > 0.5
          ? `Paying the smallest balance first instead (the "snowball" order) would cost about ${fmt(cost)} more in interest.`
          : "Paying the smallest balance first instead (the \"snowball\" order) would cost about the same in interest.",
      };
    }
  }
  return { rows, snowball };
}

// "Mar 2027" for a 'YYYY-MM'.
function monthLabel(ym) {
  const [y, m] = ym.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString("en-US", { timeZone: "UTC", month: "short", year: "numeric" });
}

// Whole calendar months from today until the target date's month — a target
// later this month is 0, a target next month 1 (roadmap T4.1 A5).
function monthsUntil(today, target) {
  const [y, m] = today.split("-").map(Number);
  const [ty, tm] = target.split("-").map(Number);
  return (ty - y) * 12 + (tm - m);
}

// The monthly deposit that reaches `target` from `current` in `n` months at
// `ratePct` a year compounded monthly (the Goals page's interest model).
function requiredMonthly(target, current, n, ratePct) {
  if (n <= 0) return Math.max(0, target - current);
  const r = (ratePct || 0) / 1200;
  if (r <= 0) return Math.max(0, (target - current) / n);
  const g = Math.pow(1 + r, n);
  return Math.max(0, ((target - current * g) * r) / (g - 1));
}

// Roadmap T4.1 A5: each goal with a target date, measured against it. A goal
// whose monthly contribution falls GOAL_CATCHUP_MIN or more short of what
// finishes it on time is "behind" — "add $X per paycheck" (rounded UP to the
// dollar, so it's enough). A goal past (or in) its target month with money to
// go is "overdue" / "due". Goals with no date or no target, or already
// reached, are "no_date" / "reached".
function goalCatchUps(goals, today, { unit, perPeriod }) {
  return (goals || []).map((g) => {
    const remaining = money(Math.max(0, g.target - g.current));
    const out = {
      id: g.id, name: g.name, target: money(g.target), current: money(g.current), remaining,
      target_date: g.target_date, monthly_contribution: money(g.monthly_contribution),
      status: null, months_left: null, required_monthly: null, add_monthly: null, add_per_period: null, text: null,
    };
    if (!(g.target > 0) || remaining <= 0) { out.status = "reached"; return out; }
    if (!g.target_date) { out.status = "no_date"; return out; }
    const n = monthsUntil(today, g.target_date);
    out.months_left = Math.max(0, n);
    if (n <= 0) {
      out.status = g.target_date < today ? "overdue" : "due";
      out.text = g.target_date < today
        ? `${g.name} is past its target date with ${fmt(remaining)} to go.`
        : `${g.name} is due this month with ${fmt(remaining)} to go.`;
      return out;
    }
    const required = money(requiredMonthly(g.target, g.current, n, g.interest_rate));
    out.required_monthly = required;
    const short = required - g.monthly_contribution;
    if (short < GOAL_CATCHUP_MIN) { out.status = "on_track"; return out; }
    out.status = "behind";
    out.add_monthly = money(short);
    out.add_per_period = Math.ceil(perPeriod(short));
    out.text = `Add ${fmt(out.add_per_period)} per ${unit} to ${g.name} to finish by ${monthLabel(g.target_date.slice(0, 7))}.`;
    return out;
  });
}

// Decision 6: the main pay stream sets "per paycheck"; without one, per month.
function payPeriod(streams) {
  let best = null;
  for (const s of streams || []) {
    const ppy = PAYCHECKS_PER_YEAR[s.cadence];
    if (!ppy) continue;
    const yearly = (Number(s.amount) || 0) * ppy;
    if (!best || yearly > best.yearly) best = { yearly, ppy, cadence: s.cadence, source: s.source };
  }
  return best
    ? { unit: "paycheck", paychecks_per_year: best.ppy, cadence: best.cadence, source: best.source }
    : { unit: "month", paychecks_per_year: 12, cadence: null, source: null };
}

// ---------------------------------------------------------------- the plan

function buildAdvicePlan(inputs) {
  const today = inputs.today || todayStr();
  const errors = inputs.errors || [];
  const base = { generated_on: today, disclaimer: DISCLAIMER, errors };
  if (CRITICAL_SOURCES.some((k) => inputs[k] == null)) return { ok: false, ...base, error: PLAN_ERROR };

  const notes = [];
  const period = payPeriod(inputs.streams);
  if (inputs.streams == null) notes.push("Your pay schedule couldn't be read, so amounts are shown per month.");
  else if (period.unit === "month") notes.push("No regular paycheck was found, so amounts are shown per month.");
  const ppy = period.paychecks_per_year;
  const perPeriod = (monthly) => money((monthly * 12) / ppy);

  // Cash and the targets.
  const floorStored = inputs.settings ? num(inputs.settings.cash_alert_threshold) : null;
  const floor = floorStored != null ? floorStored : DEFAULT_CASH_FLOOR;
  const months = surplusMonths(inputs.months, today);
  const avgSpending = money(months.reduce((t, m) => t + m.spending, 0) / months.length);
  const spendable = money(num(inputs.cash.starting_balance) || 0);
  const starterTarget = money(floor + STARTER_BUFFER_MONTHS * avgSpending);
  const emergencyTarget = money(Math.max(EMERGENCY_MONTHS * avgSpending, starterTarget));
  const lowest = inputs.cash.lowest || null;

  // Debts.
  const all = normalizeDebts(inputs.debts, inputs.activity);
  const debts = all.filter((d) => d.carried);
  for (const d of all) {
    if (d.apr_assumed) notes.push(`${d.name}: APR unknown — assumed ${UNKNOWN_CARD_APR}%; set it on the card.`);
    if (d.type === "loan" && d.apr == null) notes.push(`${d.name}: APR unknown — set it on the loan card to include it in the plan.`);
    if (d.type === "loan" && d.minimum == null) notes.push(`${d.name}: monthly payment unknown — set it on the loan card.`);
    if (d.carry_reason === "unknown") notes.push(`${d.name}: no recent activity, so it's treated as paid in full each month.`);
  }
  const planned = debts.filter((d) => d.minimum != null);
  const required = money(planned.reduce((t, d) => t + d.minimum, 0));
  const high = planned.filter((d) => d.tier === "high");
  const medium = planned.filter((d) => d.tier === "medium");

  // The surplus (decision 5).
  const transfersMonthly = money((inputs.transfers || []).reduce((t, r) => {
    const days = num(r.cadence_days);
    return days > 0 ? t + (num(r.amount) || 0) * 30 / days : t;
  }, 0));
  const failed = months.filter((m) => !m.ok).length;
  const withData = months.filter((m) => m.has_data).length;
  const medianNet = money(median(months.map((m) => m.net)));
  const afterCommitments = money(medianNet - transfersMonthly - required);
  let sustained = failed === 0;
  let reason = null;
  if (withData < SURPLUS_MONTHS) {
    sustained = false;
    reason = `Your plan needs ${SURPLUS_MONTHS} complete months of history (${withData} so far).`;
  } else if (failed > 0) {
    reason = `${failed} of the last ${SURPLUS_MONTHS} months left less than ${fmt(SURPLUS_MIN)} (or ${Math.round(SURPLUS_MIN_SHARE * 100)}% of that month's income) after spending.`;
  } else if (afterCommitments <= 0) {
    sustained = false;
    reason = `After minimum payments (${fmt(required)} a month) and the ${fmt(transfersMonthly)} a month you already move to savings, nothing is left over.`;
  }

  // The steps (decision 2), first not done = current.
  const minimumsShort = withData === SURPLUS_MONTHS && medianNet < required;
  const steps = [
    { key: "minimums", title: "Cover every minimum payment", done: !minimumsShort, target: required },
    { key: "starter_buffer", title: "Keep a starter cash buffer", done: spendable >= starterTarget, target: starterTarget, remaining: money(Math.max(0, starterTarget - spendable)) },
    { key: "high_interest_debt", title: `Pay off high-interest debt (APR ${HIGH_APR}% or more)`, done: high.length === 0, remaining: money(high.reduce((t, d) => t + d.balance, 0)) },
    { key: "emergency_fund", title: `Build an emergency fund of ${EMERGENCY_MONTHS} months of spending`, done: spendable >= emergencyTarget, target: emergencyTarget, remaining: money(Math.max(0, emergencyTarget - spendable)) },
    { key: "medium_interest_debt", title: `Split extra between medium-interest debt (APR ${MEDIUM_APR}–${HIGH_APR}%) and investing`, done: medium.length === 0, remaining: money(medium.reduce((t, d) => t + d.balance, 0)) },
    { key: "invest", title: "Invest the rest", done: false },
  ];
  const current = steps.find((s) => !s.done);
  for (const s of steps) s.status = s.done ? "done" : s === current ? "current" : "upcoming";

  // Money that leaves spendable cash (debt, investing) must keep the lowest
  // projected day at or above the floor; money that builds the buffer or the
  // emergency fund stays in cash, so it isn't capped.
  const outflow = ["high_interest_debt", "medium_interest_debt", "invest"].includes(current.key);
  let available = sustained ? afterCommitments : 0;
  let cashCap = null;
  if (outflow && lowest && available > 0) {
    const monthsToLow = Math.max(1, Math.ceil(dayGap(today, lowest.date) / 30));
    cashCap = money(Math.max(0, (num(lowest.balance) - floor) / monthsToLow));
    if (cashCap < available) {
      available = cashCap;
      if (cashCap <= 0) reason = `Your cash is projected to dip to ${fmt(lowest.balance)} on ${lowest.date}, near your ${fmt(floor)} floor, so nothing more goes out for now.`;
    }
  }
  // 60%, rounded down to $25 a paycheck (decisions 5 and 6).
  const recommendedPer = available > 0 ? Math.floor((available * RECOMMEND_SHARE * 12 / ppy) / ROUND_TO) * ROUND_TO : 0;
  const recommended = money((recommendedPer * ppy) / 12);
  if (sustained && recommended <= 0 && !reason) reason = `The surplus is under ${fmt(ROUND_TO)} a ${period.unit} once ${Math.round((1 - RECOMMEND_SHARE) * 100)}% is kept as slack.`;

  // The allocation for the current step.
  const allocation = { debts: [], snowball: null, buffer_monthly: 0, emergency_monthly: 0, invest_monthly: 0, debt_extra_monthly: 0 };
  let headline;
  const unit = period.unit;
  const per = (m) => `${fmt(perPeriod(m))} per ${unit}`;
  // Debts outside the current step pay their minimum alone (no rollover).
  const minimumRows = (list) => list.map((d) => allocateDebts([d], 0, today, ppy).rows[0]);
  if (current.key === "starter_buffer" || current.key === "emergency_fund") {
    const key = current.key === "starter_buffer" ? "buffer_monthly" : "emergency_monthly";
    allocation[key] = recommended;
    current.months_to_finish = recommended > 0 ? Math.ceil(current.remaining / recommended) : null;
    allocation.debts = minimumRows(planned);
    headline = current.key === "starter_buffer"
      ? `Build a starter cash buffer: keep ${fmt(starterTarget)} in spendable cash (you have ${fmt(spendable)})`
      : `Grow your emergency fund to ${fmt(emergencyTarget)} — ${EMERGENCY_MONTHS} months of spending (you have ${fmt(spendable)})`;
    if (recommended > 0) headline += `: put ${per(recommended)} toward it.`;
    else headline += ".";
  } else if (current.key === "high_interest_debt") {
    allocation.debt_extra_monthly = recommended;
    const a = allocateDebts(high, recommended, today, ppy);
    allocation.debts = [...a.rows, ...minimumRows(planned.filter((d) => d.tier !== "high"))];
    allocation.snowball = a.snowball;
    const top = a.rows[0];
    headline = recommended > 0
      ? `Pay down ${top.name} first: ${per(recommended)} on top of its minimum.`
      : `Pay down ${top.name} first (${top.apr}% APR) once there's a surplus.`;
  } else if (current.key === "medium_interest_debt") {
    const debtShare = money(recommended * MEDIUM_DEBT_SHARE);
    allocation.debt_extra_monthly = debtShare;
    allocation.invest_monthly = money(recommended - debtShare);
    const a = allocateDebts(medium, debtShare, today, ppy);
    allocation.debts = [...a.rows, ...minimumRows(planned.filter((d) => d.tier !== "medium"))];
    allocation.snowball = a.snowball;
    headline = recommended > 0
      ? `Split your extra: ${per(debtShare)} to ${a.rows[0].name}, ${per(allocation.invest_monthly)} to investing.`
      : `Split extra between ${a.rows[0].name} and investing once there's a surplus.`;
  } else {
    allocation.invest_monthly = recommended;
    allocation.debts = minimumRows(planned);
    headline = recommended > 0 ? `Invest ${per(recommended)} more.` : "Invest the rest once there's a surplus.";
  }
  // Roadmap T4.1 A5: the emergency-fund tracker — months of spending covered,
  // progress to the target and, when money is going toward it, when it gets
  // there (after the high-interest debt when that step comes first).
  const emergencyRemaining = money(Math.max(0, emergencyTarget - spendable));
  const emergency = {
    months_covered: avgSpending > 0 ? Math.floor((spendable / avgSpending) * 10) / 10 : null,
    target_months: EMERGENCY_MONTHS,
    target: emergencyTarget,
    have: spendable,
    remaining: emergencyRemaining,
    pct: emergencyTarget > 0 ? Math.min(100, Math.floor((Math.max(0, spendable) / emergencyTarget) * 100)) : 100,
    reached: emergencyRemaining <= 0,
    projection: null,
    note: null,
  };
  if (!emergency.reached) {
    if (minimumsShort || recommended <= 0) {
      emergency.note = "Nothing is going toward it right now.";
    } else if (current.key === "starter_buffer" || current.key === "emergency_fund") {
      const m = Math.ceil(emergencyRemaining / recommended);
      emergency.projection = { months: m, month: addMonthsYm(today, m) };
    } else if (current.key === "high_interest_debt") {
      const highIds = new Set(high.map((d) => d.id));
      const payoffs = allocation.debts.filter((r) => highIds.has(r.id)).map((r) => r.months_to_payoff);
      if (payoffs.length && payoffs.every((x) => x != null)) {
        const m = Math.max(...payoffs) + Math.ceil(emergencyRemaining / recommended);
        emergency.projection = { months: m, month: addMonthsYm(today, m) };
      }
      emergency.note = "It comes after your high-interest debt is paid off.";
    }
  }
  const goals = inputs.goals == null ? null : goalCatchUps(inputs.goals, today, { unit, perPeriod });

  if (minimumsShort) {
    headline = `Your recent months don't cover your ${fmt(required)} of monthly minimum payments.`;
    reason = reason || `Your recent months netted ${fmt(medianNet)} a month — less than your minimum payments.`;
  }

  return {
    ok: true,
    ...base,
    period,
    headline: {
      step: minimumsShort ? "minimums" : current.key,
      text: headline,
      amount_monthly: recommended,
      amount_per_period: recommendedPer,
    },
    why: reason,
    steps: steps.map(({ done, ...s }) => s),
    surplus: {
      sustained: sustained && recommended > 0,
      months,
      median_net: medianNet,
      existing_transfers_monthly: transfersMonthly,
      required_minimums_monthly: required,
      after_commitments_monthly: afterCommitments,
      cash_cap_monthly: cashCap,
      recommended_monthly: recommended,
      recommended_per_period: recommendedPer,
      slack_monthly: money(Math.max(0, (sustained ? afterCommitments : 0) - recommended)),
    },
    cash: {
      spendable,
      floor: money(floor),
      avg_monthly_spending: avgSpending,
      starter_target: starterTarget,
      emergency_target: emergencyTarget,
      lowest: lowest ? { date: lowest.date, balance: money(lowest.balance) } : null,
    },
    debts: all,
    allocation: {
      ...allocation,
      buffer_per_period: perPeriod(allocation.buffer_monthly),
      emergency_per_period: perPeriod(allocation.emergency_monthly),
      invest_per_period: perPeriod(allocation.invest_monthly),
      debt_extra_per_period: perPeriod(allocation.debt_extra_monthly),
    },
    emergency,
    goals,
    notes,
  };
}

async function getAdvicePlan(pool, opts = {}) {
  return buildAdvicePlan(await getAdviceInputs(pool, opts));
}

module.exports = {
  getAdviceInputs,
  buildAdvicePlan,
  getAdvicePlan,
  // pieces, for tests and A2–A10
  surplusMonths,
  completedMonthKeys,
  carryStatus,
  normalizeDebts,
  simulatePayoff,
  allocateDebts,
  payPeriod,
  goalCatchUps,
  requiredMonthly,
  monthsUntil,
  INTEREST_CHARGE_SQL,
  GOALS_SQL,
  GOAL_CATCHUP_MIN,
  SOURCE_ERRORS,
  PLAN_ERROR,
  CRITICAL_SOURCES,
  DISCLAIMER,
  HIGH_APR,
  MEDIUM_APR,
  UNKNOWN_CARD_APR,
  SURPLUS_MONTHS,
  SURPLUS_MIN,
  SURPLUS_MIN_SHARE,
  RECOMMEND_SHARE,
  ROUND_TO,
  STARTER_BUFFER_MONTHS,
  EMERGENCY_MONTHS,
  CASH_LOOKAHEAD_DAYS,
  DEFAULT_CASH_FLOOR,
  CARRY_LOOKBACK_DAYS,
  MIN_PAYMENT_FLOOR,
  MIN_PAYMENT_PRINCIPAL,
  MINIMUM_ONLY_TOLERANCE,
  UTILIZATION_TARGET,
  MEDIUM_DEBT_SHARE,
  PAYCHECKS_PER_YEAR,
};
