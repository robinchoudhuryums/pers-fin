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
// configured share. The CASE branches honor per-transaction personal_for
// overrides ONLY on shared accounts: a row marked personal_for='self' counts
// 100% (full amount, since the user owes it all); 'partner' counts 0%
// (entirely the other cardholder's). NULL falls back to spending_split_pct.
const SPLIT_AMOUNT = `(
  CASE
    WHEN la.is_shared AND t.personal_for = 'self' THEN t.amount
    WHEN la.is_shared AND t.personal_for = 'partner' THEN 0
    ELSE t.amount * COALESCE(la.spending_split_pct, 100) / 100.0
  END
)`;

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
       -- Whole-month window (FA-4): floor to the 1st of the month so the
       -- oldest bucket is a FULL month, not a partial one — callers (savings-
       -- rate, context-export, AI trends) treat each returned month as complete.
       AND t.date >= date_trunc('month', CURRENT_DATE) - make_interval(months => $1 - 1)
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
       -- Whole-month window (FA-4) — see getMonthlySpending.
       AND date >= date_trunc('month', CURRENT_DATE) - make_interval(months => $1 - 1)
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
  // accepts the YYYY-MM-DD literal here. Reject impossible months (9999-99 etc.)
  // at the helper boundary so a careless caller can't hand Postgres a malformed
  // date and get a 500.
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(String(monthStr || ""))) {
    throw new Error("getCategorySpendingForMonth: month must be 'YYYY-MM' with month 01-12");
  }
  const monthStart = monthStr + "-01";
  const result = await pool.query(`
    WITH bounds AS (
      SELECT $1::date AS month_start,
             ($1::date + INTERVAL '1 month')::date AS month_end
    ),
    parent_no_splits AS (
      SELECT COALESCE(t.user_category, t.category[1], 'Uncategorized') AS category,
             ${SPLIT_AMOUNT} AS amount
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
             (CASE WHEN la.is_shared AND t.personal_for = 'self' THEN s.amount WHEN la.is_shared AND t.personal_for = 'partner' THEN 0 ELSE s.amount * COALESCE(la.spending_split_pct, 100) / 100.0 END) AS amount
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
             ${SPLIT_AMOUNT} AS amount
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
             (CASE WHEN la.is_shared AND t.personal_for = 'self' THEN s.amount WHEN la.is_shared AND t.personal_for = 'partner' THEN 0 ELSE s.amount * COALESCE(la.spending_split_pct, 100) / 100.0 END) AS amount
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

// getNetWorth — single source of truth for the net-worth computation.
// Previously three call sites (startup.js hourly snapshot, goals.js
// POST /api/net-worth/snapshot, enrollments.js syncAllBalances) each
// computed this inline and DISAGREED: the balance-sync writer summed
// linked_accounts only (omitting investments), while the other two summed
// linked_accounts + investment_accounts — so the same daily
// net_worth_snapshots row oscillated depending on which job ran last, and
// a Plaid brokerage linked via the combined transactions+investments flow
// (which lives in BOTH linked_accounts and investment_accounts) was counted
// twice. This helper always includes investments and dedupes the
// Plaid-in-both-tables brokerage so each account is counted exactly once.
//
// DEDUP DIRECTION (H1): a Plaid brokerage linked via the combined flow lands
// in BOTH linked_accounts (often $0 — Schwab et al. report balances.current=0
// at the account level and put the real value in holdings) AND
// investment_accounts (correct holdings-sum balance). The CORRECT side to keep
// is investment_accounts — matching GET /api/investments (`la.plaid_item_id IS
// NULL`) and the dashboard accounts grid (drop the linked_accounts row whose
// account_id matches an investment_accounts.plaid_account_id). So we drop the
// linked_accounts phantom whenever an active investment_accounts row exists for
// it, and count the investment_accounts value. Previously the dedup kept the
// $0 linked_accounts side and dropped the real investment_accounts value, so
// net worth understated by the full brokerage value. Manual investment_accounts
// (no plaid_account_id) never match a linked_accounts row, so they're
// unaffected; Teller-linked brokerages (no investment_accounts row) still count
// via linked_accounts.
async function getNetWorth(pool) {
  const [accountsRes, investmentsRes] = await Promise.all([
    pool.query(
      `SELECT la.name, la.type, la.available_balance, la.current_balance
       FROM linked_accounts la
       WHERE (la.available_balance IS NOT NULL OR la.current_balance IS NOT NULL)
         AND NOT EXISTS (
           SELECT 1 FROM investment_accounts ia
           WHERE ia.plaid_account_id = la.account_id AND ia.is_active = true
         )`
    ),
    pool.query(
      `SELECT ia.name, ia.account_type, ia.balance
       FROM investment_accounts ia
       WHERE ia.is_active = true AND ia.balance != 0`
    ),
  ]);

  let totalAssets = 0;
  let totalLiabilities = 0;
  const breakdown = { accounts: [], investments: [] };

  for (const a of accountsRes.rows) {
    // Liabilities: credit cards AND loans (mortgage / student / auto). Plaid
    // sets type='loan' for all debt subtypes, and its current_balance is the
    // outstanding principal owed. Counting a loan in the asset branch (the old
    // `else`) inflated net worth by ~2× the loan balance (F1).
    if (a.type === "credit" || a.type === "loan") {
      const owed = parseFloat(a.current_balance || 0);
      totalLiabilities += owed;
      breakdown.accounts.push({ name: a.name, type: a.type, amount: -owed });
    } else {
      const bal = parseFloat(a.available_balance || a.current_balance || 0);
      totalAssets += bal;
      breakdown.accounts.push({ name: a.name, type: a.type, amount: bal });
    }
  }
  for (const inv of investmentsRes.rows) {
    const bal = parseFloat(inv.balance);
    totalAssets += bal;
    breakdown.investments.push({ name: inv.name, type: inv.account_type, amount: bal });
  }

  return {
    total_assets: totalAssets,
    total_liabilities: totalLiabilities,
    net_worth: totalAssets - totalLiabilities,
    breakdown,
  };
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
  getNetWorth,
};
