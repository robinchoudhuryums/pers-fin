// ============================================================================
// Financial Queries — shared, consistent income/spending SQL
// ============================================================================
// Centralizes the keyword-based income filter and the shared-account spending
// split so every endpoint that reports "income", "spending", or "savings rate"
// agrees on the numbers. Previously each endpoint inlined its own SQL and
// drifted out of alignment:
//   - /api/savings-rate and /api/cash-flow used a strict payroll/direct-dep
//     keyword filter for income and applied spending_split_pct
//   - /api/insights inlined its own loose `amount < 0` (all credits = income)
//     for the income_savings module and never applied the split for the
//     monthly-spending trend it sent to Claude
// As a result the AI was advising on different numbers than the dashboard
// showed. This module is the single source of truth.
// ============================================================================

// Income identification — mix of strict keyword matching, explicit user-
// authorized patterns, and Plaid's own "Income" category.
//
// Structured as three OR branches so each branch is independently gated:
//   (a) Strict keyword match (payroll/direct-dep/salary/deposit/ach-credit)
//       AND NOT excluded by the transfer/payment/refund negative filter.
//       Keeps unknown transfers and card payments out of income.
//   (b) User-authorized specific patterns that BYPASS the negative filter.
//       Needed when income flows through a named transfer (e.g. paycheck
//       lands in brokerage, user then transfers to checking, leaving a
//       "Funds transfer from brokerage" credit that's the real paycheck
//       from the user's perspective). The pattern must be specific enough
//       that it won't accidentally match unrelated transfers.
//   (c) Plaid's own category hierarchy tagging the txn as Income.
//
// To add another known-good income pattern, add it to (b). Keep patterns
// narrow — "transfer from X" with X specific. A permissive "transfer from"
// would re-classify intra-account moves as income and double-count.
//
// Double-counting mitigation: branch (b) used to fire any time the
// "funds transfer from brokerage" merchant string appeared, which double-
// counted income when both ends of the transfer were linked (the original
// payroll deposit on brokerage already matched branch (a); the later
// brokerage→checking transfer matched branch (b) on the destination side).
// Now branch (b) ALSO requires NO matching debit (positive amount) on a
// different account within ±2 days of the credit. The subquery's outer
// references (`account_id`, `amount`, `date`) resolve to the outer
// transactions row whether the caller aliases it as `t` or uses bare
// `transactions`, because they're unqualified and only the outer query has
// those columns in scope.
const INCOME_PREDICATE = `
  (
    (COALESCE(merchant_name, name, '') ~* '\\y(payroll|direct dep|direct deposit|dir dep|salary|employer|deposit|ach credit)\\y'
      AND COALESCE(merchant_name, name, '') !~* '\\y(payment|transfer|pymt|zelle|venmo|paypal|cash app|refund|reversal|atm|withdrawal|bill pay)\\y')
    OR (
      COALESCE(merchant_name, name, '') ~* 'funds transfer from brokerage'
      AND NOT EXISTS (
        SELECT 1 FROM transactions __t2
        WHERE __t2.account_id <> account_id
          AND __t2.amount = ABS(amount)
          AND __t2.pending = false
          AND __t2.date BETWEEN date - INTERVAL '2 days' AND date + INTERVAL '2 days'
      )
    )
    OR COALESCE(user_category, category[1]) = 'Income'
  )
`;

// Spending exclusion — filters out inter-account transfers and credit card
// payments that would double-count spending. Applied to ALL spending
// aggregations so monthly trends, category breakdowns, budgets, and cash
// flow all agree on what counts as "real spending".
//
// Excludes: credit card payments (Chase, Capital One, Discover, Amex, etc.),
// bank transfers (ACH, wire, Zelle, Venmo), loan/mortgage payments,
// ATM transactions, and other non-spending movements.
const NOT_TRANSFER = `
  COALESCE(t.user_merchant_name, t.merchant_name, t.name, '') !~*
    '\\y(payment thank|pymt|autopay|auto pay|minimum payment|directpay|automatic payment|interest|int charge|finance charge|funds tran|funds transfer|transfer to|transfer from|ach transfer|wire transfer|internal transfer|zelle|venmo|paypal|cash app|cashapp|square cash|bank of america|wells fargo|chase|citi|citibank|capital one|discover|amex|american express|us bank|pnc bank|td bank|ally bank|truist|boa transfer|online transfer|mobile transfer|bill pay|epay|credit card payment|card payment|cc payment|loan payment|mortgage payment|deposit|direct dep|atm|withdrawal)\\y'
`;

// Spending split SQL fragment — multiplies each transaction's amount by the
// account's spending_split_pct (defaults to 100 = 100%). Apply consistently in
// every spending aggregation so shared/joint accounts are counted at the
// configured share.
const SPLIT_AMOUNT = "t.amount * COALESCE(la.spending_split_pct, 100) / 100.0";

// Reimbursed exclusion — use inside any spending aggregation so transactions
// the user has flagged as reimbursed don't count against their budgets/cash
// flow/savings rate. Column lives on transactions, so table alias is optional;
// callers that don't alias the transactions table can use NOT_REIMBURSED_UNALIASED.
const NOT_REIMBURSED = "COALESCE(t.is_reimbursed, false) = false";
const NOT_REIMBURSED_UNALIASED = "COALESCE(is_reimbursed, false) = false";

// Investment-account detection — covers Teller-linked accounts enrolled as
// brokerage / IRA / 401k / 529 / HSA / pension / etc. Teller's API doesn't
// expose holdings or cost basis like Plaid does (only account-level balance),
// so the analytics surface is shallower for Teller-linked investments — but
// they participate fully in net worth, goal funding, and balance sync.
//
// Use this fragment with `linked_accounts` aliased as `la` (the convention
// across the rest of this codebase) or pass the alias via .replace().
const INVESTMENT_ACCOUNT_TYPES = `(
  la.type = 'investment'
  OR LOWER(COALESCE(la.subtype, '')) IN (
    'brokerage', 'ira', '401k', '403b', '529', 'roth_ira', 'retirement',
    'hsa', 'sep_ira', 'simple_ira', 'pension', 'investment'
  )
)`;

/**
 * Monthly spending totals for the last N months, split-adjusted.
 * Returns rows: { month: 'YYYY-MM', total_spend: NUMERIC, txn_count: INT }
 */
async function getMonthlySpending(pool, months = 6) {
  const result = await pool.query(
    `SELECT TO_CHAR(t.date, 'YYYY-MM') AS month,
            ROUND(SUM(${SPLIT_AMOUNT}), 2) AS total_spend,
            COUNT(*) AS txn_count
     FROM transactions t
     LEFT JOIN linked_accounts la ON la.account_id = t.account_id
     WHERE t.amount > 0 AND t.pending = false
       AND COALESCE(t.is_reimbursed, false) = false
       AND ${NOT_TRANSFER}
       AND t.date >= CURRENT_DATE - make_interval(months => $1)
     GROUP BY TO_CHAR(t.date, 'YYYY-MM')
     ORDER BY month`,
    [months]
  );
  return result.rows;
}

/**
 * Monthly income totals for the last N months. Uses the keyword predicate;
 * transfers and refunds are excluded.
 * Returns rows: { month: 'YYYY-MM', total_income: NUMERIC }
 */
async function getMonthlyIncome(pool, months = 6) {
  const result = await pool.query(
    `SELECT TO_CHAR(date, 'YYYY-MM') AS month,
            SUM(ABS(amount)) AS total_income
     FROM transactions
     WHERE amount < 0 AND pending = false
       AND date >= CURRENT_DATE - make_interval(months => $1)
       AND ${INCOME_PREDICATE}
     GROUP BY TO_CHAR(date, 'YYYY-MM')
     ORDER BY month`,
    [months]
  );
  return result.rows;
}

/**
 * Combined per-month income + (split-adjusted) spending for the last N months.
 * Used by the insights `income_savings` module so the AI sees the same
 * numbers as /api/savings-rate.
 * Returns rows: { month: 'YYYY-MM', income: NUMBER, spending: NUMBER }
 */
async function getMonthlyIncomeAndSpending(pool, months = 6) {
  const [income, spending] = await Promise.all([
    getMonthlyIncome(pool, months),
    getMonthlySpending(pool, months),
  ]);
  const incMap = {};
  for (const r of income) incMap[r.month] = parseFloat(r.total_income);
  const spendMap = {};
  for (const r of spending) spendMap[r.month] = parseFloat(r.total_spend);
  const allMonths = [...new Set([...Object.keys(incMap), ...Object.keys(spendMap)])].sort();
  return allMonths.map(m => ({
    month: m,
    income: incMap[m] || 0,
    spending: spendMap[m] || 0,
  }));
}

/**
 * Spending-by-category for an arbitrary month (YYYY-MM). When a transaction
 * has splits, each split contributes its own category/amount (replacing the
 * parent row); when it has none, the parent row's `category[1]` is used.
 * Honors spending_split_pct and the reimbursed exclusion on both paths.
 *
 * Returns rows: { category: TEXT, spent: NUMERIC }
 */
async function getCategorySpendingForMonth(pool, monthStr) {
  // monthStr is 'YYYY-MM'. The first-of-month date is the inclusive lower bound;
  // the upper bound is the first of the following month (exclusive). Postgres
  // accepts the YYYY-MM-DD literal here.
  if (!/^\d{4}-\d{2}$/.test(String(monthStr || ""))) {
    throw new Error("getCategorySpendingForMonth: month must be 'YYYY-MM'");
  }
  const monthStart = monthStr + "-01";
  const result = await pool.query(`
    WITH bounds AS (
      SELECT $1::date AS month_start,
             ($1::date + INTERVAL '1 month')::date AS month_end
    ),
    parent_no_splits AS (
      SELECT COALESCE(t.user_category, t.category[1], 'Uncategorized') AS category,
             t.amount * COALESCE(la.spending_split_pct, 100) / 100.0 AS amount
      FROM transactions t
      LEFT JOIN linked_accounts la ON la.account_id = t.account_id
      CROSS JOIN bounds b
      WHERE t.amount > 0 AND t.pending = false
        AND COALESCE(t.is_reimbursed, false) = false
        AND ${NOT_TRANSFER}
        AND t.date >= b.month_start
        AND t.date <  b.month_end
        AND NOT EXISTS (SELECT 1 FROM transaction_splits s WHERE s.parent_transaction_id = t.transaction_id)
    ),
    from_splits AS (
      SELECT COALESCE(s.category, t.user_category, t.category[1], 'Uncategorized') AS category,
             s.amount * COALESCE(la.spending_split_pct, 100) / 100.0 AS amount
      FROM transaction_splits s
      JOIN transactions t ON t.transaction_id = s.parent_transaction_id
      LEFT JOIN linked_accounts la ON la.account_id = t.account_id
      CROSS JOIN bounds b
      WHERE t.amount > 0 AND t.pending = false
        AND COALESCE(t.is_reimbursed, false) = false
        AND ${NOT_TRANSFER}
        AND t.date >= b.month_start
        AND t.date <  b.month_end
    ),
    all_lines AS (
      SELECT category, amount FROM parent_no_splits
      UNION ALL
      SELECT category, amount FROM from_splits
    )
    SELECT category, ROUND(SUM(amount), 2) AS spent
    FROM all_lines
    GROUP BY category
  `, [monthStart]);
  return result.rows;
}

/**
 * Spending-by-category for the current month. Anchored to Postgres CURRENT_DATE
 * (not JS Date) so the boundary at month-end stays consistent with the rest of
 * the SQL in this codebase. Used by /api/insights, /api/budgets/alerts, and the
 * scheduled budget-alert push — all of which mean "this calendar month, now".
 *
 * Kept structurally identical to its pre-existing implementation; the new
 * `getCategorySpendingForMonth` exists alongside it for callers that need to
 * snapshot a specific historical month.
 */
async function getCategorySpendingThisMonth(pool) {
  const result = await pool.query(`
    WITH parent_no_splits AS (
      SELECT COALESCE(t.user_category, t.category[1], 'Uncategorized') AS category,
             t.amount * COALESCE(la.spending_split_pct, 100) / 100.0 AS amount
      FROM transactions t
      LEFT JOIN linked_accounts la ON la.account_id = t.account_id
      WHERE t.amount > 0 AND t.pending = false
        AND COALESCE(t.is_reimbursed, false) = false
        AND ${NOT_TRANSFER}
        AND t.date >= date_trunc('month', CURRENT_DATE)
        AND t.date <  date_trunc('month', CURRENT_DATE) + INTERVAL '1 month'
        AND NOT EXISTS (SELECT 1 FROM transaction_splits s WHERE s.parent_transaction_id = t.transaction_id)
    ),
    from_splits AS (
      SELECT COALESCE(s.category, t.user_category, t.category[1], 'Uncategorized') AS category,
             s.amount * COALESCE(la.spending_split_pct, 100) / 100.0 AS amount
      FROM transaction_splits s
      JOIN transactions t ON t.transaction_id = s.parent_transaction_id
      LEFT JOIN linked_accounts la ON la.account_id = t.account_id
      WHERE t.amount > 0 AND t.pending = false
        AND COALESCE(t.is_reimbursed, false) = false
        AND ${NOT_TRANSFER}
        AND t.date >= date_trunc('month', CURRENT_DATE)
        AND t.date <  date_trunc('month', CURRENT_DATE) + INTERVAL '1 month'
    ),
    all_lines AS (
      SELECT category, amount FROM parent_no_splits
      UNION ALL
      SELECT category, amount FROM from_splits
    )
    SELECT category, ROUND(SUM(amount), 2) AS spent
    FROM all_lines
    GROUP BY category
  `);
  return result.rows;
}

module.exports = {
  INCOME_PREDICATE,
  SPLIT_AMOUNT,
  NOT_REIMBURSED,
  NOT_REIMBURSED_UNALIASED,
  NOT_TRANSFER,
  INVESTMENT_ACCOUNT_TYPES,
  getMonthlySpending,
  getMonthlyIncome,
  getMonthlyIncomeAndSpending,
  getCategorySpendingThisMonth,
  getCategorySpendingForMonth,
};
