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

// Income identification — keyword match on merchant/name, plus exclusions for
// transfers/payments/refunds. Mirrors the strict filter previously inlined in
// /api/savings-rate (routes/enrollments.js) and /api/cash-flow.
//
// Detected as income:   payroll, direct dep, salary, employer, or category[1]='Income'
// Explicitly excluded:  payment, transfer, pymt, zelle, venmo, paypal,
//                       cash app, refund, credit, reversal
const INCOME_PREDICATE = `
  (LOWER(COALESCE(merchant_name, name, '')) LIKE '%payroll%'
    OR LOWER(COALESCE(merchant_name, name, '')) LIKE '%direct dep%'
    OR LOWER(COALESCE(merchant_name, name, '')) LIKE '%salary%'
    OR LOWER(COALESCE(merchant_name, name, '')) LIKE '%employer%'
    OR category[1] = 'Income')
  AND LOWER(COALESCE(merchant_name, name, '')) NOT SIMILAR TO
    '%(payment|transfer|pymt|zelle|venmo|paypal|cash app|refund|credit|reversal)%'
`;

// Spending split SQL fragment — multiplies each transaction's amount by the
// account's spending_split_pct (defaults to 100 = 100%). Apply consistently in
// every spending aggregation so shared/joint accounts are counted at the
// configured share.
const SPLIT_AMOUNT = "t.amount * COALESCE(la.spending_split_pct, 100) / 100.0";

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

module.exports = {
  INCOME_PREDICATE,
  SPLIT_AMOUNT,
  getMonthlySpending,
  getMonthlyIncome,
  getMonthlyIncomeAndSpending,
};
