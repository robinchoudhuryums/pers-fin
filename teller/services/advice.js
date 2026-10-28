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
// security or a fund (decision 10). A5–A8 add the secondary advisors (the
// emergency tracker, goal catch-up, raises / bonuses / spending creep, idle
// cash / rebalancing, and A8's statement-date utilization tip and loan extra
// payments), each computed here too.

const { todayStr, previousMonthKey, incomePredicate, INCOME_AMOUNT, spendLinesCTE, NET_CATEGORY_MONTHS, INVESTMENT_ACCOUNT_TYPES } = require("./financial-queries");
const { addMonthsYm, addMonthsYmd, computeLoanPayoff } = require("./projections");

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
// Roadmap T4.1 A6 — raises, bonuses and spending creep.
const DEPOSIT_LOOKBACK_DAYS = 240; // deposits read for raise / bonus detection (~8 months)
const RAISE_MIN_BEFORE = 3;       // steady deposits needed before the step up …
const RAISE_MIN_AFTER = 2;        // … and at the new level
const RAISE_CLUSTER = 0.10;       // deposits within ±10% of their median are one level (the streams' tolerance)
const RAISE_MIN_SHARE = 0.03;     // the new level at least 3% above the old …
const RAISE_MIN_MONTHLY = 50;     // … and at least $50 a month more
const RAISE_RECENT_DAYS = 90;     // the first raised deposit within this many days
const RAISE_LIVE_DAYS = 45;       // the latest deposit within this many days
const RAISE_SHARE = 0.5;          // of the raise, toward the plan's current step
const BONUS_RECENT_DAYS = 45;     // a bonus that landed within this many days
const BONUS_MIN = 500;            // a bonus is at least $500 …
const BONUS_MULTIPLE = 1.5;       // … and 1.5× the payer's usual deposit
const BONUS_ONE_OFF_MIN = 1000;   // a payer with no other deposit: at least $1,000
const CREEP_MONTHS = 6;           // completed months compared: the last 3 against the 3 before
const CREEP_WINDOW = 3;
const CREEP_MIN_BASE = 50;        // a category spending at least $50 a month before …
const CREEP_MIN_INCREASE = 50;    // … that rose by at least $50 a month …
const CREEP_MARGIN = 0.15;        // … and 15 points faster than income
const CREEP_MAX = 3;              // categories listed
const CREEP_SKIP = new Set(["uncategorized"]);
// Roadmap T4.1 A7 — idle cash and rebalancing directions.
const IDLE_DAYS = 60;             // checking has stayed above the line this long …
const IDLE_PAD_DAYS = 31;         // … (snapshots read this far before the window for its first day)
const IDLE_MIN = 500;             // at least this much to move
const IDLE_ROUND_TO = 100;        // rounded down to $100
const SAVINGS_SUBTYPES = new Set(["savings", "money market", "money_market", "cash management", "cash_management"]);
const REBALANCE_DRIFT = 5;        // a class more than 5 points off its target
const REBALANCE_ROUND_TO = 100;   // moves rounded to the nearest $100 …
const REBALANCE_MIN = 100;        // … and listed from $100
// Roadmap T4.1 A8.
const STATEMENT_MAX_AGE_DAYS = 62; // a last statement older than this is too stale to project the next close from
const STATEMENT_PAID_SHARE = 0.95; // a payment after the statement under 95% of it = the balance was carried
const LOAN_EXTRA_MONTHLY = 100;   // "an extra $100 a month on <loan>"
const REBALANCE_NOTE = "Directions only — pick the holdings yourself. Selling in a taxable account can create a taxable gain; new contributions can move the mix without selling.";

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
  deposits: "Recent paychecks couldn't be read.",
  categories: "Spending by category couldn't be read.",
  idle: "Your account balance history couldn't be read.",
  allocation: "Your investment allocation couldn't be read.",
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
         la.minimum_payment, la.monthly_payment, la.last_payment_amount,
         la.last_payment_date::text AS last_payment_date,
         la.last_statement_balance, la.last_statement_issue_date::text AS last_statement_issue_date
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

// Roadmap T4.1 A6: income deposits (the canonical predicate, at your share —
// INV-110) for raise / bonus detection, and net spending per category for the
// completed months the creep check compares (spend_lines — INV-122).
const DEPOSITS_SQL = `
  SELECT t.date::text AS date, COALESCE(t.user_merchant_name, t.merchant_name, t.name) AS source,
         ROUND(${INCOME_AMOUNT}, 2) AS amount
  FROM transactions t
  LEFT JOIN linked_accounts la ON la.account_id = t.account_id
  WHERE t.amount < 0 AND t.pending = false
    AND t.date >= $1::date - ${DEPOSIT_LOOKBACK_DAYS} AND t.date <= $1::date
    AND ${incomePredicate("t")}
  ORDER BY t.date, t.transaction_id`;
// Roadmap T4.1 A7: the accounts idle cash can move between (no Plaid
// brokerage phantom — the getNetWorth dedupe), the active investment
// accounts, and the checking accounts' daily balances over the window.
const IDLE_ACCOUNTS_SQL = `
  SELECT la.id, la.name, la.type, LOWER(COALESCE(la.subtype, '')) AS subtype, la.current_balance,
         ${INVESTMENT_ACCOUNT_TYPES} AS is_investment
  FROM linked_accounts la
  WHERE (la.type = 'depository' OR ${INVESTMENT_ACCOUNT_TYPES})
    AND NOT EXISTS (SELECT 1 FROM investment_accounts ia WHERE ia.plaid_account_id = la.account_id AND ia.is_active)
  ORDER BY la.id`;
const IDLE_INVESTMENTS_SQL = `
  SELECT id, name, account_type FROM investment_accounts WHERE is_active = true ORDER BY id`;
const IDLE_SNAPSHOTS_SQL = `
  SELECT s.source_id AS id, s.snapshot_date::text AS date, s.balance
  FROM account_balance_snapshots s
  JOIN linked_accounts la ON la.id = s.source_id
  WHERE s.source = 'linked' AND la.type = 'depository' AND LOWER(COALESCE(la.subtype, '')) = 'checking'
    AND NOT ${INVESTMENT_ACCOUNT_TYPES}
    AND s.snapshot_date >= $1::date - ${IDLE_DAYS + IDLE_PAD_DAYS} AND s.snapshot_date <= $1::date
  ORDER BY s.snapshot_date, s.source_id`;
const CATEGORY_MONTHS_SQL = `
  WITH ${spendLinesCTE("t.date >= $1::date AND t.date < $2::date")},
  ${NET_CATEGORY_MONTHS}
  SELECT month, category, ROUND(spent, 2) AS spent
  FROM net_category_months
  ORDER BY month, category`;

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
    // One extra month for the month to date; A6's creep check compares 6 completed months.
    months: () => fq.getMonthlyIncomeAndSpending(pool, Math.max(SURPLUS_MONTHS, CREEP_MONTHS) + 1),
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
    deposits: async () => (await pool.query(DEPOSITS_SQL, [today])).rows
      .map((r) => ({ date: String(r.date).slice(0, 10), source: r.source, amount: num(r.amount) || 0 }))
      .filter((r) => r.source && r.amount > 0),
    idle: async () => {
      const [accounts, investments, snapshots] = await Promise.all([
        pool.query(IDLE_ACCOUNTS_SQL), pool.query(IDLE_INVESTMENTS_SQL), pool.query(IDLE_SNAPSHOTS_SQL, [today]),
      ]);
      return {
        accounts: accounts.rows.map((r) => ({ id: r.id, name: r.name, type: r.type, subtype: r.subtype || "", current_balance: num(r.current_balance), is_investment: !!r.is_investment })),
        investments: investments.rows.map((r) => ({ id: r.id, name: r.name, account_type: r.account_type })),
        snapshots: snapshots.rows.map((r) => ({ id: r.id, date: String(r.date).slice(0, 10), balance: num(r.balance) })),
      };
    },
    allocation: async () => {
      const al = require("./allocation");
      const [holdings, settings] = await Promise.all([
        pool.query(al.HOLDINGS_SQL),
        pool.query("SELECT target_allocation_pct FROM user_settings WHERE id = 1"),
      ]);
      return al.assetAllocation(holdings.rows, al.normalizeTargets(settings.rows[0] && settings.rows[0].target_allocation_pct));
    },
    categories: async () => {
      const keys = completedMonthKeys(today, CREEP_MONTHS);
      return (await pool.query(CATEGORY_MONTHS_SQL, [keys[0] + "-01", today.slice(0, 7) + "-01"])).rows
        .map((r) => ({ month: r.month, category: r.category, spent: num(r.spent) || 0 }));
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
// it was charged interest in the last 60 days, or its last payment — made after
// its last statement (roadmap T4.1 A8) — was smaller than that statement. With
// no statement to compare, a last payment about the minimum while more was
// owed stands in for it. No activity and no payment data → unknown, treated as
// not carried and said so.
function carryStatus(row, activity) {
  const balance = num(row.current_balance) || 0;
  if (activity && activity.interest) return { carried: true, reason: "interest_charged" };
  const last = num(row.last_payment_amount);
  const min = num(row.minimum_payment);
  const stmt = num(row.last_statement_balance);
  const stmtDate = row.last_statement_issue_date ? String(row.last_statement_issue_date).slice(0, 10) : null;
  const payDate = row.last_payment_date ? String(row.last_payment_date).slice(0, 10) : null;
  if (stmt != null && stmt > 0 && last != null && stmtDate && payDate && payDate >= stmtDate) {
    return last < stmt * STATEMENT_PAID_SHARE
      ? { carried: true, reason: "statement_not_paid" }
      : { carried: false, reason: "statement_paid" };
  }
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

// Roadmap T4.1 A8: the day a card's next statement closes — the balance
// reported to the credit bureaus — stepped by calendar month from the last
// statement Plaid reported (its day kept, clamped to the month). Null without
// a statement, or with one older than STATEMENT_MAX_AGE_DAYS.
function nextStatementDate(row, today) {
  const last = row.last_statement_issue_date ? String(row.last_statement_issue_date).slice(0, 10) : null;
  if (!last || !/^\d{4}-\d{2}-\d{2}$/.test(last) || last > today || dayGap(last, today) > STATEMENT_MAX_AGE_DAYS) return null;
  for (let k = 1; k <= 3; k++) {
    const d = addMonthsYmd(last, k);
    if (d > today) return d;
  }
  return null;
}

// "Nov 5" for a 'YYYY-MM-DD'.
function dayLabel(ymd) {
  const [y, m, d] = ymd.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString("en-US", { timeZone: "UTC", month: "short", day: "numeric" });
}

function normalizeDebts(rows, activityRows, today = todayStr()) {
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
    if (isCard) {
      // Roadmap T4.1 A8: the last statement and when the next one closes.
      const stmt = num(r.last_statement_balance);
      const next = nextStatementDate(r, today);
      debt.statement = {
        last_date: r.last_statement_issue_date ? String(r.last_statement_issue_date).slice(0, 10) : null,
        last_balance: stmt == null ? null : money(stmt),
        reported_pct: stmt != null && limit ? Math.round((stmt / limit) * 100) : null,
        next_date: next,
      };
    }
    // Decision 4's optional tip: what brings a card under 30%. With a statement
    // date known (A8) the deadline is the day the next statement closes — the
    // balance the card reports — else its due date.
    if (limit && balance > limit * UTILIZATION_TARGET) {
      const pay = Math.ceil(balance - limit * UTILIZATION_TARGET);
      const pct = Math.round(UTILIZATION_TARGET * 100);
      const next = debt.statement && debt.statement.next_date;
      debt.utilization_tip = next
        ? { pay, by: next, basis: "statement", text: `Paying ${fmt(pay)} on ${r.name} before ${dayLabel(next)}, when its next statement closes, keeps the balance it reports under ${pct}% of its limit.` }
        : { pay, by: null, basis: "due_date", text: `Paying ${fmt(pay)} on ${r.name} before its due date brings it under ${pct}% of its limit.` };
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

// ---------------------------------------------------------------- A6

// Deposits grouped by payer (case-insensitive), each list oldest first.
function depositsBySource(deposits) {
  const by = new Map();
  for (const d of deposits || []) {
    if (!d || !d.source || !(Number(d.amount) > 0)) continue;
    const key = String(d.source).toLowerCase();
    if (!by.has(key)) by.set(key, []);
    by.get(key).push({ date: String(d.date).slice(0, 10), source: d.source, amount: money(d.amount) });
  }
  for (const list of by.values()) list.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  return by;
}

// Deposits a year from a payer: its live stream's cadence (the one nearest the
// amount), else the median gap between its deposits.
function depositsPerYear(key, list, streams, amount) {
  const matches = (streams || []).filter((s) => s && String(s.source || "").toLowerCase() === key && PAYCHECKS_PER_YEAR[s.cadence]);
  if (matches.length) {
    matches.sort((a, b) => Math.abs((Number(a.amount) || 0) - amount) - Math.abs((Number(b.amount) || 0) - amount));
    return PAYCHECKS_PER_YEAR[matches[0].cadence];
  }
  const gaps = [];
  for (let i = 1; i < list.length; i++) gaps.push(dayGap(list[i - 1].date, list[i].date));
  const g = median(gaps.filter((x) => x > 0));
  if (!g) return null;
  return g <= 10 ? 52 : g <= 17 ? 26 : g <= 45 ? 12 : null;
}

const within = (x, center, share) => Math.abs(x - center) <= share * center;

// Pure: a payer whose deposits stepped up to a new, steady level — the last
// RAISE_MIN_AFTER+ deposits each above every one of the RAISE_MIN_BEFORE steady
// deposits before them, at least RAISE_MIN_SHARE and RAISE_MIN_MONTHLY a month
// more, first seen within RAISE_RECENT_DAYS.
function detectRaises(deposits, today, streams) {
  const out = [];
  for (const [key, all] of depositsBySource(deposits)) {
    const list = all.filter((_, i) => !standsAlone(all, i)); // a bonus isn't a pay level
    const n = list.length;
    for (let s = RAISE_MIN_BEFORE; s <= n - RAISE_MIN_AFTER; s++) {
      const run = list.slice(s);
      const before = list.slice(0, s).slice(-RAISE_MIN_BEFORE);
      const from = median(list.slice(0, s).slice(-2 * RAISE_MIN_BEFORE).map((d) => d.amount));
      const to = median(run.map((d) => d.amount));
      if (!before.every((d) => within(d.amount, from, RAISE_CLUSTER))) continue;
      if (!run.every((d) => within(d.amount, to, RAISE_CLUSTER))) continue;
      if (Math.min(...run.map((d) => d.amount)) <= Math.max(...before.map((d) => d.amount))) continue;
      if (to < from * (1 + RAISE_MIN_SHARE)) continue;
      if (dayGap(run[0].date, today) > RAISE_RECENT_DAYS || dayGap(run[run.length - 1].date, today) > RAISE_LIVE_DAYS) continue;
      const ppy = depositsPerYear(key, list, streams, to);
      if (!ppy) continue;
      const perDeposit = money(to - from);
      const monthly = money((perDeposit * ppy) / 12);
      if (monthly < RAISE_MIN_MONTHLY) continue;
      out.push({ source: list[n - 1].source, from: money(from), to: money(to), raise_per_deposit: perDeposit, deposits_per_year: ppy, raise_monthly: monthly, since: run[0].date });
      break; // the earliest step that fits is this payer's raise
    }
  }
  return out.sort((a, b) => b.raise_monthly - a.raise_monthly);
}

// Pure: a deposit that landed within BONUS_RECENT_DAYS and stands alone — at
// least BONUS_MIN and BONUS_MULTIPLE× the payer's usual deposit (no other
// deposit near its size), or BONUS_ONE_OFF_MIN from a payer seen only once.
// A deposit at least BONUS_MIN and BONUS_MULTIPLE× the payer's usual deposit
// with no other deposit near its size (a level, not a one-off).
function standsAlone(list, i) {
  const d = list[i];
  const others = list.filter((_, j) => j !== i);
  if (!others.length) return false;
  if (d.amount < Math.max(BONUS_MIN, BONUS_MULTIPLE * median(others.map((o) => o.amount)))) return false;
  return !others.some((o) => within(o.amount, d.amount, RAISE_CLUSTER));
}

function detectBonuses(deposits, today) {
  const out = [];
  for (const list of depositsBySource(deposits).values()) {
    list.forEach((d, i) => {
      if (dayGap(d.date, today) > BONUS_RECENT_DAYS || dayGap(d.date, today) < 0) return;
      if (list.length === 1) {
        if (d.amount >= BONUS_ONE_OFF_MIN) out.push({ date: d.date, source: d.source, amount: d.amount, typical: null, one_off: true });
        return;
      }
      if (!standsAlone(list, i)) return;
      const typical = money(median(list.filter((_, j) => j !== i).map((o) => o.amount)));
      out.push({ date: d.date, source: d.source, amount: d.amount, typical, one_off: false });
    });
  }
  return out.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}

// Pure: split a lump sum in the plan's order (decision 2) — the starter buffer,
// high-interest debt (avalanche), the emergency fund, medium-interest debt
// shared 50/50 with investing, then investing. `state` is updated so a second
// lump fills what the first left.
function splitWindfall(amount, state) {
  let rest = money(amount);
  const lines = [];
  const add = (key, name, x) => {
    const v = money(Math.min(rest, Math.max(0, x)));
    if (v <= 0) return 0;
    rest = money(rest - v);
    const prev = lines.find((l) => l.key === key && l.name === name);
    if (prev) prev.amount = money(prev.amount + v); else lines.push({ key, name, amount: v });
    return v;
  };
  state.buffer_gap = money(state.buffer_gap - add("buffer", "your starter cash buffer", state.buffer_gap));
  for (const d of state.high) d.balance = money(d.balance - add("debt", d.name, d.balance));
  state.emergency_gap = money(state.emergency_gap - add("emergency", "your emergency fund", state.emergency_gap));
  if (rest > 0 && state.medium.some((d) => d.balance > 0)) {
    let half = money(rest * MEDIUM_DEBT_SHARE);
    for (const d of state.medium) {
      const v = add("debt", d.name, Math.min(d.balance, half));
      d.balance = money(d.balance - v);
      half = money(half - v);
    }
  }
  add("invest", "investing", rest);
  return lines;
}

// Pure: categories whose last-3-month average grew at least CREEP_MARGIN faster
// than income's over the CREEP_MONTHS completed months (both from the shared
// spending / income definitions). Needs every one of those months on record.
function spendingCreep(categoryRows, monthRows, today) {
  const keys = completedMonthKeys(today, CREEP_MONTHS);
  const priorKeys = new Set(keys.slice(0, CREEP_WINDOW));
  const recentKeys = new Set(keys.slice(CREEP_WINDOW));
  const byMonth = new Map((monthRows || []).map((r) => [r.month, r]));
  if (!keys.every((k) => byMonth.has(k))) return [];
  const avg = (set, f) => [...set].reduce((t, k) => t + f(k), 0) / set.size;
  const incomePrior = avg(priorKeys, (k) => num(byMonth.get(k).income) || 0);
  const incomeRecent = avg(recentKeys, (k) => num(byMonth.get(k).income) || 0);
  const incomeGrowth = incomePrior > 0 ? (incomeRecent - incomePrior) / incomePrior : 0;
  const cats = new Map();
  for (const r of categoryRows || []) {
    if (!r || !r.category || CREEP_SKIP.has(String(r.category).toLowerCase())) continue;
    if (!cats.has(r.category)) cats.set(r.category, new Map());
    cats.get(r.category).set(r.month, (cats.get(r.category).get(r.month) || 0) + (num(r.spent) || 0));
  }
  const out = [];
  for (const [category, m] of cats) {
    const prior = money(avg(priorKeys, (k) => m.get(k) || 0));
    const recent = money(avg(recentKeys, (k) => m.get(k) || 0));
    const increase = money(recent - prior);
    if (prior < CREEP_MIN_BASE || increase < CREEP_MIN_INCREASE) continue;
    const growth = increase / prior;
    if (growth - incomeGrowth < CREEP_MARGIN) continue;
    out.push({ category, prior_monthly: prior, recent_monthly: recent, increase_monthly: increase,
      growth_pct: Math.round(growth * 100), income_growth_pct: Math.round(incomeGrowth * 100) });
  }
  return out.sort((a, b) => b.increase_monthly - a.increase_monthly).slice(0, CREEP_MAX);
}

// ---------------------------------------------------------------- A7

// Pure: the lowest total the checking accounts held on any day of the last
// IDLE_DAYS (each account's latest snapshot carried forward), or null when an
// account has no balance known at the window's start (not enough history).
function checkingLow(idle, today) {
  const checking = (idle.accounts || []).filter((a) => a.type === "depository" && a.subtype === "checking" && !a.is_investment);
  if (!checking.length) return null;
  const start = new Date(Date.parse(today + "T00:00:00Z") - IDLE_DAYS * 86400000).toISOString().slice(0, 10);
  const series = new Map(checking.map((a) => [a.id, []]));
  for (const snap of idle.snapshots || []) if (series.has(snap.id) && snap.balance != null) series.get(snap.id).push(snap);
  for (const list of series.values()) {
    list.sort((x, y) => (x.date < y.date ? -1 : x.date > y.date ? 1 : 0));
    if (!list.length || list[0].date > start) return null;
  }
  // The days that matter: the window's start and every snapshot day in it.
  const days = new Set([start]);
  for (const list of series.values()) for (const snap of list) if (snap.date > start) days.add(snap.date);
  let low = Infinity;
  for (const day of days) {
    let total = 0;
    for (const list of series.values()) {
      let bal = null;
      for (const snap of list) { if (snap.date <= day) bal = snap.balance; else break; }
      total += bal || 0;
    }
    low = Math.min(low, total);
  }
  // Today's balance too, when it's lower than the last snapshot.
  const now = checking.reduce((t, a) => t + (a.current_balance || 0), 0);
  if (checking.every((a) => a.current_balance != null)) low = Math.min(low, now);
  return money(low);
}

// The accounts idle cash can move to: a savings account, and a brokerage that
// isn't tax-advantaged (cash can't simply go into an IRA or 401(k)).
function idleDestinations(idle) {
  const { accountTaxAdvantaged } = require("./tax-investments");
  const accounts = idle.accounts || [];
  const savings = accounts.find((a) => a.type === "depository" && !a.is_investment && SAVINGS_SUBTYPES.has(a.subtype)) || null;
  const linkedBroker = accounts.find((a) => a.is_investment && a.subtype && !accountTaxAdvantaged(a.subtype));
  const broker = linkedBroker || (idle.investments || []).find((i) => !accountTaxAdvantaged(i.account_type)) || null;
  return { savings, brokerage: broker };
}

// Pure: target-allocation drift beyond REBALANCE_DRIFT points, paired
// largest-overweight to largest-underweight. Asset classes only — never a
// security. null without targets or holdings.
function rebalanceMoves(alloc) {
  if (!alloc || !alloc.has_targets || !(alloc.total_value > 0)) return null;
  const total = alloc.total_value;
  const off = alloc.classes.filter((c) => c.drift_pct !== undefined && Math.abs(c.drift_pct) > REBALANCE_DRIFT);
  const over = off.filter((c) => c.drift_pct > 0).map((c) => ({ c, left: (c.drift_pct / 100) * total })).sort((a, b) => b.left - a.left);
  const under = off.filter((c) => c.drift_pct < 0).map((c) => ({ c, left: (-c.drift_pct / 100) * total })).sort((a, b) => b.left - a.left);
  const pct = (n) => Math.round(n);
  const moves = [];
  let i = 0, j = 0;
  while (i < over.length && j < under.length) {
    const amount = Math.min(over[i].left, under[j].left);
    const rounded = Math.round(amount / REBALANCE_ROUND_TO) * REBALANCE_ROUND_TO;
    if (rounded >= REBALANCE_MIN) {
      const from = over[i].c, to = under[j].c;
      moves.push({
        from: from.security_type, to: to.security_type, amount: rounded,
        text: `Move about ${fmt(rounded)} from ${from.security_type} (${pct(from.pct_of_portfolio)}% now, target ${pct(from.target_pct)}%) to ${to.security_type} (${pct(to.pct_of_portfolio)}% now, target ${pct(to.target_pct)}%).`,
      });
    }
    over[i].left -= amount;
    under[j].left -= amount;
    if (over[i].left <= 0.005) i++;
    if (under[j].left <= 0.005) j++;
  }
  return {
    total_value: money(total),
    drifting: off.map((c) => ({ security_type: c.security_type, pct: Math.round(c.pct_of_portfolio * 10) / 10, target_pct: c.target_pct, drift_pct: Math.round(c.drift_pct * 10) / 10 })),
    moves,
    note: moves.length ? REBALANCE_NOTE : null,
  };
}

// Where the plan's current step sends money, in words.
// Roadmap T4.1 A8: what LOAN_EXTRA_MONTHLY more a month does to each loan with
// a known APR and payment (computeLoanPayoff — the loan card's own math): the
// interest saved and how many months sooner it's paid off. A loan the plan
// already sends extra to is left out (its row in the debt table shows that).
function loanExtraPayments(debts, allocationRows, today) {
  const funded = new Set((allocationRows || []).filter((r) => r.extra_monthly > 0).map((r) => r.id));
  const out = [];
  for (const d of debts || []) {
    if (d.type !== "loan" || !d.carried || funded.has(d.id) || !(d.apr > 0) || !(d.minimum > 0)) continue;
    const now = computeLoanPayoff({ balance: d.balance, aprPct: d.apr, monthlyPayment: d.minimum, today });
    const more = computeLoanPayoff({ balance: d.balance, aprPct: d.apr, monthlyPayment: d.minimum + LOAN_EXTRA_MONTHLY, today });
    if (now.months_to_payoff == null || more.months_to_payoff == null) continue;
    const sooner = now.months_to_payoff - more.months_to_payoff;
    const saved = money(now.total_interest - more.total_interest);
    if (sooner < 1 || saved <= 0) continue;
    let text = `An extra ${fmt(LOAN_EXTRA_MONTHLY)} a month on ${d.name} would save about ${fmt(saved)} in interest and pay it off ` +
      `${sooner} month${sooner === 1 ? "" : "s"} sooner (${monthLabel(more.payoff_date)} instead of ${monthLabel(now.payoff_date)}).`;
    if (d.tier === "low") text += ` At ${d.apr}% APR it's low-interest debt, so your plan keeps it on its minimum.`;
    out.push({
      id: d.id,
      name: d.name,
      apr: d.apr,
      tier: d.tier,
      balance: d.balance,
      payment_monthly: d.minimum,
      extra_monthly: LOAN_EXTRA_MONTHLY,
      months_now: now.months_to_payoff,
      months_with_extra: more.months_to_payoff,
      months_sooner: sooner,
      payoff_month_now: now.payoff_date,
      payoff_month_with_extra: more.payoff_date,
      interest_saved: saved,
      text,
    });
  }
  return out;
}

function stepTarget(stepKey, debtName) {
  switch (stepKey) {
    case "minimums": return "your minimum payments";
    case "starter_buffer": return "your starter cash buffer";
    case "high_interest_debt": return debtName || "your highest-interest debt";
    case "medium_interest_debt": return (debtName || "your debt") + " and investing";
    case "emergency_fund": return "your emergency fund";
    default: return "investing";
  }
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
  const all = normalizeDebts(inputs.debts, inputs.activity, today);
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

  // Roadmap T4.1 A6: a raise, a bonus and spending creep, each pointed at the
  // plan's current step (decision 2's order).
  const stepKey = minimumsShort ? "minimums" : current.key;
  const topOf = (list) => [...list].sort(AVALANCHE)[0];
  const targetDebt = current.key === "high_interest_debt" ? topOf(high) : current.key === "medium_interest_debt" ? topOf(medium) : null;
  const target = stepTarget(stepKey, targetDebt && targetDebt.name);
  const raises = inputs.deposits == null ? null : detectRaises(inputs.deposits, today, inputs.streams).map((r) => {
    // From the yearly raise (per deposit × deposits a year), so a rounded monthly figure can't cost a step.
    const suggestPer = Math.floor(((r.raise_per_deposit * r.deposits_per_year * RAISE_SHARE) / ppy) / ROUND_TO) * ROUND_TO;
    let text = `Your pay from ${r.source} went up from ${fmt(r.from)} to ${fmt(r.to)} a deposit in ${monthLabel(r.since.slice(0, 7))} (about ${fmt(r.raise_monthly)} a month more).`;
    if (suggestPer > 0) text += ` Put ${fmt(suggestPer)} per ${unit} of it toward ${target}.`;
    return { ...r, toward: stepKey, suggest_monthly: money((suggestPer * ppy) / 12), suggest_per_period: suggestPer, text };
  });
  let bonuses = null;
  if (inputs.deposits != null) {
    const found = detectBonuses(inputs.deposits, today);
    // The bonus is likely in spendable cash already, so the gaps are measured without it.
    const baseCash = money(spendable - found.reduce((t, b) => t + b.amount, 0));
    const state = {
      buffer_gap: money(Math.max(0, starterTarget - baseCash)),
      emergency_gap: money(Math.max(0, emergencyTarget - Math.max(baseCash, starterTarget))),
      high: [...high].sort(AVALANCHE).map((d) => ({ name: d.name, balance: d.balance })),
      medium: [...medium].sort(AVALANCHE).map((d) => ({ name: d.name, balance: d.balance })),
    };
    bonuses = found.map((b) => {
      const split = splitWindfall(b.amount, state);
      const kind = b.one_off ? "a one-off deposit" : `a bonus (your usual deposit from them is ${fmt(b.typical)})`;
      const text = `${fmt(b.amount)} from ${b.source} on ${b.date} looks like ${kind}. Your plan would split it: ` +
        split.map((l) => `${fmt(l.amount)} to ${l.name}`).join(", ") + ".";
      return { ...b, split, text };
    });
  }
  const creep = inputs.categories == null ? null : spendingCreep(inputs.categories, inputs.months, today).map((c) => {
    const inc = c.income_growth_pct;
    const incomeText = inc > 0 ? `rose ${inc}%` : inc < 0 ? `fell ${-inc}%` : "stayed flat";
    const freed = perPeriod(c.increase_monthly);
    return { ...c, increase_per_period: freed,
      text: `${c.category} spending rose from ${fmt(c.prior_monthly)} to ${fmt(c.recent_monthly)} a month (+${c.growth_pct}%) over the last 3 months, while your income ${incomeText}. Bringing it back would free ${fmt(freed)} per ${unit}.` };
  });

  // Roadmap T4.1 A7: checking that held more than the floor + a month of
  // spending (the starter buffer) for IDLE_DAYS, moved in the plan's order —
  // only to an account that exists, and never more out of cash than keeps the
  // lowest projected day at the floor.
  let idleCash = null;
  if (inputs.idle != null) {
    const low = checkingLow(inputs.idle, today);
    const dest = idleDestinations(inputs.idle);
    const amount = low == null ? 0 : Math.floor((low - starterTarget) / IDLE_ROUND_TO) * IDLE_ROUND_TO;
    if (amount >= IDLE_MIN && (dest.savings || dest.brokerage)) {
      const base = money(spendable - amount);
      const state = {
        buffer_gap: money(Math.max(0, starterTarget - base)),
        emergency_gap: money(Math.max(0, emergencyTarget - Math.max(base, starterTarget))),
        high: [...high].sort(AVALANCHE).map((d) => ({ name: d.name, balance: d.balance })),
        medium: [...medium].sort(AVALANCHE).map((d) => ({ name: d.name, balance: d.balance })),
      };
      let moves = splitWindfall(amount, state).map((l) => {
        if (l.key === "debt") return { ...l, to: l.name, leaves_cash: true };
        if (l.key === "invest") return dest.brokerage ? { ...l, to: `${dest.brokerage.name} (investing)`, leaves_cash: true } : null;
        if (l.key === "emergency" && dest.savings) return { ...l, to: `${dest.savings.name} (emergency fund)`, leaves_cash: false };
        return null; // the buffer, an emergency fund with no savings account, investing with no brokerage: stays in checking
      }).filter(Boolean);
      // Money leaving cash keeps the lowest projected day at the floor (decision 5's cap).
      if (lowest) {
        let room = Math.max(0, num(lowest.balance) - floor);
        moves = moves.map((m) => {
          if (!m.leaves_cash) return m;
          const v = Math.floor(Math.min(m.amount, room) / IDLE_ROUND_TO) * IDLE_ROUND_TO;
          room -= v;
          return { ...m, amount: v };
        }).filter((m) => m.amount > 0);
      }
      const moved = money(moves.reduce((t, m) => t + m.amount, 0));
      if (moved >= IDLE_MIN) {
        idleCash = {
          checking_low: low,
          keep: starterTarget,
          amount: moved,
          days: IDLE_DAYS,
          moves: moves.map(({ key, to, amount: v }) => ({ key, to, amount: v })),
          text: `Your checking hasn't dropped below ${fmt(low)} in ${IDLE_DAYS} days — more than the ${fmt(starterTarget)} your plan keeps there (your floor plus a month of spending). Move ${fmt(moved)}: ` +
            moves.map((m) => `${fmt(m.amount)} to ${m.to}`).join(", ") + ".",
        };
      }
    }
  }
  const rebalance = inputs.allocation == null ? null : rebalanceMoves(inputs.allocation);
  const loanExtra = loanExtraPayments(all, allocation.debts, today);

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
    raises,
    bonuses,
    spending_creep: creep,
    idle_cash: idleCash,
    rebalance,
    loan_extra: loanExtra,
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
  detectRaises,
  detectBonuses,
  splitWindfall,
  spendingCreep,
  checkingLow,
  idleDestinations,
  rebalanceMoves,
  nextStatementDate,
  loanExtraPayments,
  DEBTS_SQL,
  STATEMENT_MAX_AGE_DAYS,
  STATEMENT_PAID_SHARE,
  LOAN_EXTRA_MONTHLY,
  IDLE_ACCOUNTS_SQL,
  IDLE_INVESTMENTS_SQL,
  IDLE_SNAPSHOTS_SQL,
  IDLE_DAYS,
  IDLE_PAD_DAYS,
  IDLE_MIN,
  IDLE_ROUND_TO,
  SAVINGS_SUBTYPES,
  REBALANCE_DRIFT,
  REBALANCE_ROUND_TO,
  REBALANCE_MIN,
  REBALANCE_NOTE,
  DEPOSITS_SQL,
  CATEGORY_MONTHS_SQL,
  DEPOSIT_LOOKBACK_DAYS,
  RAISE_MIN_BEFORE,
  RAISE_MIN_AFTER,
  RAISE_CLUSTER,
  RAISE_MIN_SHARE,
  RAISE_MIN_MONTHLY,
  RAISE_RECENT_DAYS,
  RAISE_LIVE_DAYS,
  RAISE_SHARE,
  BONUS_RECENT_DAYS,
  BONUS_MIN,
  BONUS_MULTIPLE,
  BONUS_ONE_OFF_MIN,
  CREEP_MONTHS,
  CREEP_WINDOW,
  CREEP_MIN_BASE,
  CREEP_MIN_INCREASE,
  CREEP_MARGIN,
  CREEP_MAX,
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
