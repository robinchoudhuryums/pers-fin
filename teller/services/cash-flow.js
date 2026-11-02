// ============================================================================
// Cash-flow forecast (roadmap T2.2 L1)
// ============================================================================
// The day-by-day projection behind GET /api/cash-flow, moved out of the route so
// the low-balance / payday alerts (T2.2 L2–L4) read the SAME numbers as the
// dashboard widget:
//
//   getCashFlowInputs(pool, { today })   — the queries: live income streams
//     (getLiveIncomeStreams, F34), the bill schedule (active subscriptions +
//     outgoing recurring transfers), spendable cash (depository, non-investment
//     — FAN-5) and the 60-day spending averages without subscription merchants
//     (DD-4).
//   projectCashFlow(inputs, { days })    — PURE: walks today+1 … today+days on
//     calendar dates and returns the route's response fields plus the daily
//     `projection` and `lowest` ({ date, balance } of the lowest projected day).
//   firstBelow(projection, threshold)    — the first projected day below a floor.
//   getCashFlowForecast(pool, { days, today })
//
// "Today" is the APP_TIMEZONE date (todayStr — F11); the route used to take it
// from `now.toISOString()` (UTC), so west of UTC an evening forecast started a
// day late. The 60-day average windows stay CURRENT_DATE lookbacks (documented
// rolling windows — a few hours of skew is immaterial there).
//
// Charge-level on purpose (F35): refunds are not netted here.
//
// Cycle-8 E1a (G1): the user can correct the bill schedule. A recurring
// transfer's forecast_treatment — 'auto' (the heuristics below), 'bill' (always
// billed, whatever they say), 'internal' / 'ignore' (never billed) — and a
// subscription's forecast_ignore. Forecast-only: nothing else reads them.
// getCashFlowInputs returns every candidate as `bills` (each with source, id
// and why: auto | user) or `left_out` (with a reason: card_autopay |
// internal | user_internal | user_ignored); projectCashFlow bills only `bills`
// and reports both lists as `forecast_items`.
// ============================================================================
const { seriesOccurrences, incomeEventsBetween, addDaysStr, parseYmd } = require("./cadence");
const { NOT_TRANSFER, SPLIT_AMOUNT, INVESTMENT_ACCOUNT_TYPES, getLiveIncomeStreams, todayStr } = require("./financial-queries");

const CADENCE_DAYS = { weekly: 7, biweekly: 14, semimonthly: 15, monthly: 30 };

// DD-4: CARD autopays are skipped — the card purchases they pay off are already
// in the daily spending average, so billing the autopay too double-counted card
// spending ($2k of card purchases + a $2k autopay projected $4k/month). Loan /
// mortgage payments stay: their outflow isn't in the average (NOT_TRANSFER
// excludes it). Cycle-8 F8: EVERY non-loan bill_payment used to be skipped, so a
// utility or insurance "AUTOPAY" from checking — kept out of the average by
// NOT_TRANSFER and out of subscription detection by its exclusion list — was
// projected nowhere. A bill_payment is a card autopay when its latest debit was
// paid into a linked credit card (paid_linked_card) or its name says it is a
// card payment / names a card issuer.
const CARD_PAYMENT_RE = /\b(credit\s*card|card\s*(?:payment|pmt|autopay|auto\s*pay|epay|services)|cardmember|crd\s*(?:pmt|epay|autopay)|amex|american\s+express|discover|capital\s*one|citi(?:\s*card)?|chase|barclays|synchrony|apple\s+card)\b/i;
function isCardAutopay(tr) {
  if (tr.transfer_type !== "bill_payment") return false;
  const name = tr.display_name || "";
  if (/\b(loan|mortgage)\b/i.test(name)) return false;
  return !!tr.paid_linked_card || CARD_PAYMENT_RE.test(name);
}

// Cycle-8 F7: a transfer between two of your own spendable accounts (checking →
// a linked savings account) moves money inside the starting balance, which
// already sums every depository account, so billing it understated the
// projection by the transfer every cycle — and could raise a false "Low cash
// ahead". Such a transfer is recognised by its latest debit having a credit of
// the same amount, within 5 days, on ANOTHER spendable (depository,
// non-investment) account (moved_between_cash_accounts). A savings transfer to
// an account you haven't linked, a brokerage contribution or a rent "transfer
// to" someone else has no such credit and is still billed.
function isInternalMove(tr) {
  return !!tr.moved_between_cash_accounts;
}

// Whether a recurring transfer's latest debit (from a spendable account) has a
// credit of the same amount within 5 days on another linked account matching
// `destination` (an SQL condition on la2). The transfer's rows are found by
// the transfer detector's own merchant key.
function mirroredCredit(destination) {
  return `EXISTS (
        SELECT 1 FROM transactions t
        JOIN linked_accounts la ON la.account_id = t.account_id
        JOIN transactions t2 ON t2.account_id <> t.account_id AND t2.pending = false
          AND t2.amount = -t.amount AND t2.date BETWEEN t.date - 5 AND t.date + 5
        JOIN linked_accounts la2 ON la2.account_id = t2.account_id
        WHERE COALESCE(t.user_merchant_name, t.merchant_name, LOWER(REGEXP_REPLACE(t.name, '[^a-zA-Z0-9 ]', '', 'g'))) = rt.merchant_key
          AND t.amount > 0 AND t.pending = false AND t.date = rt.last_transferred
          AND la.type = 'depository' AND NOT ${INVESTMENT_ACCOUNT_TYPES}
          AND ${destination}
      )`;
}

// A recurring transfer's place in the forecast: { bill: true, why } or
// { bill: false, reason }. The user's treatment wins over the heuristics.
function transferTreatment(tr) {
  const t = tr.forecast_treatment || "auto";
  if (t === "bill") return { bill: true, why: "user" };
  if (t === "internal") return { bill: false, reason: "user_internal" };
  if (t === "ignore") return { bill: false, reason: "user_ignored" };
  if (isCardAutopay(tr)) return { bill: false, reason: "card_autopay" };
  if (isInternalMove(tr)) return { bill: false, reason: "internal" };
  return { bill: true, why: "auto" };
}

// Split the candidate rows into the bills the forecast projects and the ones it
// leaves out, each tagged with where it came from.
function classifyBills(subs, transfers) {
  const bills = [], left_out = [];
  for (const s of subs || []) {
    const row = { ...s, source: "subscription", treatment: s.forecast_ignore ? "ignore" : "auto" };
    if (s.forecast_ignore) left_out.push({ ...row, reason: "user_ignored" });
    else bills.push({ ...row, why: "auto" });
  }
  for (const tr of transfers || []) {
    const row = { ...tr, source: "transfer", treatment: tr.forecast_treatment || "auto" };
    const t = transferTreatment(tr);
    if (t.bill) bills.push({ ...row, why: t.why });
    else left_out.push({ ...row, reason: t.reason });
  }
  return { bills, left_out };
}

async function getCashFlowInputs(pool, { today = todayStr() } = {}) {
  const incomeStreams = await getLiveIncomeStreams(pool, today);

  const [subsResult, transfersResult] = await Promise.all([
    pool.query(`
      SELECT id, display_name, amount, cadence_days, next_expected, last_charged AS last_date, forecast_ignore
      FROM detected_subscriptions
      WHERE is_active = true AND is_dismissed = false AND cancelled_at IS NULL
        AND next_expected IS NOT NULL
    `),
    pool.query(`
      SELECT rt.id, rt.display_name, rt.amount, rt.cadence_days, rt.next_expected, rt.last_transferred AS last_date,
             rt.transfer_type, rt.direction, rt.forecast_treatment,
             ${mirroredCredit("la2.type = 'depository' AND NOT " + INVESTMENT_ACCOUNT_TYPES.replace(/\bla\./g, "la2."))} AS moved_between_cash_accounts,
             ${mirroredCredit("la2.type = 'credit'")} AS paid_linked_card
      FROM recurring_transfers rt
      WHERE rt.is_active = true AND rt.is_dismissed = false
        AND rt.next_expected IS NOT NULL AND rt.direction = 'outgoing'
    `),
  ]);
  const { bills, left_out } = classifyBills(subsResult.rows, transfersResult.rows);

  // Spendable cash = DEPOSITORY accounts only (FAN-5). `type != 'credit'`
  // counted loans (+$18k for an $18k auto loan) and Teller-linked brokerage /
  // IRA balances as cash, inflating every projected balance.
  const balResult = await pool.query(`
    SELECT SUM(CASE WHEN la.type = 'depository' AND NOT ${INVESTMENT_ACCOUNT_TYPES}
                    THEN COALESCE(la.available_balance, la.current_balance, 0) ELSE 0 END) AS cash,
           SUM(CASE WHEN la.type = 'credit' THEN COALESCE(la.current_balance, 0) ELSE 0 END) AS debt
    FROM linked_accounts la
    WHERE la.available_balance IS NOT NULL OR la.current_balance IS NOT NULL
  `);

  // Detected subscriptions are projected as scheduled bills, so their charges
  // must NOT also sit in the daily average (DD-4). Same key expression and same
  // filter as detection's merchant_key / the bill-schedule query.
  const NOT_SUBSCRIPTION = `NOT EXISTS (
        SELECT 1 FROM detected_subscriptions ds
        WHERE ds.is_active = true AND ds.is_dismissed = false AND ds.cancelled_at IS NULL
          AND ds.next_expected IS NOT NULL
          AND ds.merchant_key = COALESCE(t.user_merchant_name, t.merchant_name, LOWER(REGEXP_REPLACE(t.name, '[^a-zA-Z0-9 ]', '', 'g')))
      )`;

  // Average daily discretionary spending (last 60 days, excluding subscription
  // bills), at the shared-card share.
  const avgSpendResult = await pool.query(`
    SELECT COALESCE(AVG(daily_total), 0) AS avg_daily
    FROM (
      SELECT t.date, ROUND(SUM(${SPLIT_AMOUNT}), 2) AS daily_total
      FROM transactions t
      LEFT JOIN linked_accounts la ON la.account_id = t.account_id
      WHERE t.amount > 0 AND t.pending = false
        AND COALESCE(t.is_reimbursed, false) = false
        AND ${NOT_TRANSFER}
        AND ${NOT_SUBSCRIPTION}
        AND t.date >= CURRENT_DATE - INTERVAL '60 days'
      GROUP BY t.date
    ) daily
  `);

  // Per-day-of-week averages for more realistic variation. Every date in the
  // 60-day window is generated so that days with zero spending still count in
  // each weekday's average — otherwise the per-DOW means skew upward.
  const dowSpendResult = await pool.query(`
    WITH date_series AS (
      SELECT d::date AS date
      FROM generate_series(CURRENT_DATE - INTERVAL '60 days', CURRENT_DATE, '1 day'::interval) d
    ),
    daily_totals AS (
      SELECT t.date,
             SUM(${SPLIT_AMOUNT}) AS daily_total
      FROM transactions t
      LEFT JOIN linked_accounts la ON la.account_id = t.account_id
      WHERE t.amount > 0 AND t.pending = false
        AND COALESCE(t.is_reimbursed, false) = false
        AND ${NOT_TRANSFER}
        AND ${NOT_SUBSCRIPTION}
        AND t.date >= CURRENT_DATE - INTERVAL '60 days'
      GROUP BY t.date
    )
    SELECT EXTRACT(DOW FROM ds.date) AS dow,
           COALESCE(AVG(COALESCE(dt.daily_total, 0)), 0) AS avg_daily
    FROM date_series ds
    LEFT JOIN daily_totals dt USING (date)
    GROUP BY EXTRACT(DOW FROM ds.date)
  `);
  const dowSpend = {};
  for (const r of dowSpendResult.rows) dowSpend[parseInt(r.dow)] = parseFloat(r.avg_daily);

  return {
    today,
    incomeStreams,
    bills,
    left_out,
    startingBalance: parseFloat((balResult.rows[0] && balResult.rows[0].cash) || 0),
    avgDailySpend: parseFloat((avgSpendResult.rows[0] && avgSpendResult.rows[0].avg_daily) || 0),
    dowSpend,
  };
}

// Day of week (0 = Sunday) of a calendar date — independent of the server zone.
function weekdayOf(ymd) {
  const p = parseYmd(ymd);
  return new Date(Date.UTC(p.y, p.m, p.d)).getUTCDay();
}

const cents = (n) => Math.round(n * 100) / 100;

function projectCashFlow(inputs, { days }) {
  const { today, incomeStreams = [], bills = [], left_out = [], startingBalance = 0, avgDailySpend = 0, dowSpend = {} } = inputs;
  const end = addDaysStr(today, days);

  const recurringIncome = incomeStreams.map((s) => ({
    source: s.source,
    amount: s.amount,
    cadence: s.cadence,
    cadence_days: CADENCE_DAYS[s.cadence] || null,
    last_date: s.last,
    ...(s.days ? { days_of_month: s.days } : {}),
  }));

  // Occurrences step by CALENDAR MONTH for month-scale cadences (DC-9) — a
  // fixed 30-day step drifted and could double-bill a month.
  const billSchedule = bills.map(b => ({
    name: b.display_name,
    amount: parseFloat(b.amount),
    dates: new Set(seriesOccurrences(b.last_date, b.next_expected, b.cadence_days, today, end)),
  }));
  // What the schedule held and what it left out (E1a) — the dashboard's
  // "What's in this forecast" list.
  const itemOf = (b) => ({
    source: b.source || null,
    id: b.id == null ? null : Number(b.id),
    name: b.display_name,
    amount: cents(parseFloat(b.amount) || 0),
    cadence_days: b.cadence_days == null ? null : Number(b.cadence_days),
    treatment: b.treatment || "auto",
    ...(b.source === "transfer" ? { transfer_type: b.transfer_type || null } : {}),
  });
  const forecastItems = {
    bills: bills.map((b, i) => {
      const dates = [...billSchedule[i].dates].sort();
      return { ...itemOf(b), why: b.why || "auto", next_date: dates[0] || null,
        occurrences: dates.length, projected_total: cents(dates.length * billSchedule[i].amount) };
    }),
    left_out: left_out.map((b) => ({ ...itemOf(b), reason: b.reason })),
  };
  const incomeByDate = new Map();
  for (const stream of incomeStreams) {
    for (const date of incomeEventsBetween(stream, today, end)) {
      incomeByDate.set(date, (incomeByDate.get(date) || 0) + stream.amount);
    }
  }

  let runningBalance = startingBalance;
  let totalIncome = 0, totalBills = 0, totalDiscretionary = 0;
  const projection = [];
  for (let d = 1; d <= days; d++) {
    const date = addDaysStr(today, d);
    const dayIncome = incomeByDate.get(date) || 0;
    let dayBills = 0;
    for (const bill of billSchedule) if (bill.dates.has(date)) dayBills += bill.amount;
    const dow = weekdayOf(date);
    const daySpend = dowSpend[dow] !== undefined ? dowSpend[dow] : avgDailySpend;

    runningBalance += dayIncome - dayBills - daySpend;
    totalIncome += dayIncome;
    totalBills += dayBills;
    totalDiscretionary += daySpend;
    projection.push({
      date,
      income: cents(dayIncome),
      bills: cents(dayBills),
      discretionary: cents(daySpend),
      balance: cents(runningBalance),
    });
  }

  const byWeek = [];
  for (let w = 0; w < Math.ceil(days / 7); w++) {
    const slice = projection.slice(w * 7, (w + 1) * 7);
    byWeek.push({
      week: w + 1,
      start_date: slice[0] && slice[0].date,
      income: cents(slice.reduce((s, d) => s + d.income, 0)),
      bills: cents(slice.reduce((s, d) => s + d.bills, 0)),
      discretionary: cents(slice.reduce((s, d) => s + d.discretionary, 0)),
      end_balance: (slice[slice.length - 1] && slice[slice.length - 1].balance) || 0,
    });
  }

  // The lowest projected day (the earliest one on a tie) — a mid-week dip the
  // weekly end balances hide.
  let lowest = null;
  for (const p of projection) if (!lowest || p.balance < lowest.balance) lowest = { date: p.date, balance: p.balance };

  return {
    forecast_days: days,
    starting_balance: startingBalance,
    avg_daily_spend: cents(avgDailySpend),
    total_projected_income: cents(totalIncome),
    total_projected_bills: cents(totalBills),
    total_projected_discretionary: cents(totalDiscretionary),
    ending_balance: (projection[projection.length - 1] && projection[projection.length - 1].balance) || 0,
    surplus_shortfall: cents(totalIncome - totalBills - totalDiscretionary),
    recurring_income: recurringIncome,
    by_week: byWeek,
    forecast_items: forecastItems,
    projection,
    lowest,
  };
}

// The first projected day whose balance is below `threshold`, or null.
function firstBelow(projection, threshold) {
  for (const p of projection || []) if (p.balance < threshold) return { date: p.date, balance: p.balance };
  return null;
}

async function getCashFlowForecast(pool, { days, today = todayStr() } = {}) {
  return projectCashFlow(await getCashFlowInputs(pool, { today }), { days });
}

module.exports = { getCashFlowInputs, projectCashFlow, firstBelow, getCashFlowForecast, isCardAutopay, isInternalMove, transferTreatment, classifyBills, CARD_PAYMENT_RE, CADENCE_DAYS };
