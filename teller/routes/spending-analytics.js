// ============================================================================
// Routes: Spending & income analytics (read-only aggregations)
// ============================================================================
// Extracted from routes/enrollments.js (route-file split). Mounted by
// enrollments.js, so every endpoint path is unchanged:
//   /api/spending-summary, /api/spending-categories, /api/cash-flow,
//   /api/spending-yoy, /api/savings-rate, /api/income-summary
// All aggregations import SPLIT_AMOUNT / NOT_TRANSFER / INCOME_PREDICATE from
// services/financial-queries.js (INV-07/INV-10 — never re-inline copies).

const express = require("express");
const router = express.Router();
const { pool } = require("../services/database");
const { INCOME_PREDICATE, NOT_TRANSFER, SPLIT_AMOUNT, getMonthlySpending, getMonthlyIncome, getCategorySpendingForMonth } = require("../services/financial-queries");

// INCOME_PREDICATE writes its outer column references UNQUALIFIED (so it works
// however the caller aliases `transactions`) — which breaks the one query here
// that JOINs linked_accounts: `name` exists on both tables and Postgres
// rejects the ambiguity (this 500'd /api/income-summary in production; found
// by the e2e harness's live boot). Derive a t.-qualified variant in place —
// same convention as insights' NOT_TRANSFER.replace(/\bt\./, "t2.") — leaving
// the predicate's internal __t2.* subquery references untouched.
const INCOME_PREDICATE_T = INCOME_PREDICATE.replace(
  /(?<!__t2\.)\b(merchant_name|name|account_id|amount|date|user_category|category)\b/g,
  "t.$1"
);

// GET /api/spending-categories?month=YYYY-MM — per-month category breakdown
// for the dashboard's "Spending by Category" month selector. Uses the shared
// getCategorySpendingForMonth helper (splits-replacement, reimbursed
// exclusion, shared-card split_pct) so the figures match budgets/snapshots.
router.get("/api/spending-categories", async (req, res) => {
  const month = String(req.query.month || "");
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) {
    return res.status(400).json({ error: "month must be 'YYYY-MM'" });
  }
  try {
    const rows = await getCategorySpendingForMonth(pool, month);
    rows.sort((a, b) => parseFloat(b.spent) - parseFloat(a.spent));
    res.json({ month, categories: rows });
  } catch (err) {
    console.error("spending-categories error:", err.message);
    res.status(500).json({ error: "An internal error occurred." });
  }
});

// GET /api/spending-summary
router.get("/api/spending-summary", async (req, res) => {
  const months = parseInt(req.query.months) || 6;
  try {
    const monthlyTrend = await pool.query(
      `SELECT TO_CHAR(t.date, 'YYYY-MM') AS month,
              ROUND(SUM(${SPLIT_AMOUNT}), 2) AS total_spend,
              COUNT(*) AS txn_count,
              ROUND(AVG(${SPLIT_AMOUNT}), 2) AS avg_transaction
       FROM transactions t
       LEFT JOIN linked_accounts la ON la.account_id = t.account_id
       WHERE t.amount > 0 AND t.pending = false AND COALESCE(t.is_reimbursed, false) = false
         AND ${NOT_TRANSFER}
         AND t.date >= CURRENT_DATE - ($1 || ' months')::INTERVAL
       GROUP BY TO_CHAR(t.date, 'YYYY-MM')
       ORDER BY month DESC`,
      [months]
    );

    // Category breakdown honors transaction_splits (Phase B3): when a
    // transaction has splits, each split contributes to its own category
    // instead of the parent row's category. Parents without splits contribute
    // the full amount to the parent's category[1].
    const byCategory = await pool.query(
      `WITH parent_no_splits AS (
         SELECT COALESCE(t.user_category, t.category[1], 'Uncategorized') AS category,
                ${SPLIT_AMOUNT} AS amount,
                1 AS line_count
         FROM transactions t
         LEFT JOIN linked_accounts la ON la.account_id = t.account_id
         WHERE t.amount > 0 AND t.pending = false AND COALESCE(t.is_reimbursed, false) = false
           AND ${NOT_TRANSFER}
           AND t.date >= CURRENT_DATE - ($1 || ' months')::INTERVAL
           AND NOT EXISTS (SELECT 1 FROM transaction_splits s WHERE s.parent_transaction_id = t.transaction_id)
       ),
       from_splits AS (
         SELECT COALESCE(s.category, t.user_category, t.category[1], 'Uncategorized') AS category,
                ${SPLIT_AMOUNT.replace(/t\.amount/g, "s.amount")} AS amount,
                1 AS line_count
         FROM transaction_splits s
         JOIN transactions t ON t.transaction_id = s.parent_transaction_id
         LEFT JOIN linked_accounts la ON la.account_id = t.account_id
         WHERE t.amount > 0 AND t.pending = false AND COALESCE(t.is_reimbursed, false) = false
           AND ${NOT_TRANSFER}
           AND t.date >= CURRENT_DATE - ($1 || ' months')::INTERVAL
       ),
       all_lines AS (
         SELECT * FROM parent_no_splits UNION ALL SELECT * FROM from_splits
       )
       SELECT category, ROUND(SUM(amount), 2) AS total, SUM(line_count) AS txn_count
       FROM all_lines
       GROUP BY category
       ORDER BY total DESC
       LIMIT 15`,
      [months]
    );

    // Exclusion list uses word-boundary regex (\y) so short tokens like "atm",
    // "pymt", and "epay" can't substring-match legitimate merchants (AT&T,
    // Atmos Energy, etc.). Multi-word phrases still work because \y anchors
    // at the phrase edges, not inside the phrase.
    // Group by the user's overridden merchant name when set, so renames like
    // "AMAZON MKTP*4321" -> "Amazon" collapse multiple rows into one merchant.
    // Reimbursed transactions are excluded from the total (Phase B2).
    const topMerchants = await pool.query(
      `SELECT COALESCE(t.user_merchant_name, t.merchant_name, t.name) AS merchant,
              ROUND(SUM(${SPLIT_AMOUNT}), 2) AS total_spent,
              COUNT(*) AS txn_count
       FROM transactions t
       LEFT JOIN linked_accounts la ON la.account_id = t.account_id
       WHERE t.amount > 0 AND t.pending = false AND COALESCE(t.is_reimbursed, false) = false
             AND t.merchant_name IS NOT NULL
             AND ${NOT_TRANSFER}
             AND t.date >= CURRENT_DATE - ($1 || ' months')::INTERVAL
       GROUP BY COALESCE(t.user_merchant_name, t.merchant_name, t.name)
       ORDER BY total_spent DESC
       LIMIT 10`,
      [months]
    );

    const upcoming = await pool.query(
      `SELECT display_name, amount, cadence_days, next_expected,
              ROUND(amount * (30.0 / NULLIF(cadence_days, 0)), 2) AS monthly_cost
       FROM detected_subscriptions
       WHERE is_active = true AND is_dismissed = false AND cancelled_at IS NULL
       ORDER BY next_expected ASC
       LIMIT 10`
    );

    const recentTxns = await pool.query(
      `SELECT COALESCE(user_merchant_name, merchant_name, name) AS description,
              amount, date, pending, is_reimbursed,
              COALESCE(user_category, category[1], 'Uncategorized') AS category
       FROM transactions
       ORDER BY date DESC, created_at DESC
       LIMIT 10`
    );

    res.json({
      monthly_trend: monthlyTrend.rows,
      by_category: byCategory.rows,
      top_merchants: topMerchants.rows,
      upcoming_subscriptions: upcoming.rows,
      recent_transactions: recentTxns.rows,
    });
  } catch (err) {
    console.error("spending-summary error:", err.message);
    res.status(500).json({ error: "An internal error occurred." });
  }
});

// GET /api/cash-flow — Rolling 60/90-day cash flow projection
router.get("/api/cash-flow", async (req, res) => {
  const days = Math.min(Math.max(parseInt(req.query.days) || 90, 30), 180);
  try {
    // Get recent income patterns (last 3 months) — strict keyword match only,
    // no amount threshold (catches transfers/card payments as false income)
    // Uses INCOME_PREDICATE from services/financial-queries.js so the keyword
    // filter is shared with /api/savings-rate and AI insights (eliminates drift).
    const incomeResult = await pool.query(`
      SELECT COALESCE(merchant_name, name) AS source,
             ABS(amount) AS amount,
             date,
             EXTRACT(DAY FROM date::timestamp) AS day_of_month
      FROM transactions
      WHERE amount < 0 AND pending = false
        AND date >= CURRENT_DATE - INTERVAL '3 months'
        AND ${INCOME_PREDICATE}
      ORDER BY date DESC
    `);

    // Detect recurring income (group by similar amounts ±10%)
    const incomeByAmount = {};
    for (const row of incomeResult.rows) {
      const amt = parseFloat(row.amount);
      let matched = false;
      for (const key of Object.keys(incomeByAmount)) {
        if (Math.abs(amt - parseFloat(key)) / parseFloat(key) < 0.1) {
          incomeByAmount[key].push(row);
          matched = true;
          break;
        }
      }
      if (!matched) incomeByAmount[amt.toFixed(2)] = [row];
    }

    // Find recurring income (2+ occurrences)
    const recurringIncome = [];
    for (const [amount, entries] of Object.entries(incomeByAmount)) {
      if (entries.length >= 2) {
        const days_between = [];
        for (let i = 1; i < entries.length; i++) {
          const diff = (new Date(entries[i-1].date) - new Date(entries[i].date)) / 86400000;
          days_between.push(Math.round(diff));
        }
        const avgInterval = days_between.reduce((s, d) => s + d, 0) / days_between.length;
        const cadence = avgInterval <= 10 ? 7 : avgInterval <= 20 ? 14 : 30;
        recurringIncome.push({
          source: entries[0].source,
          amount: parseFloat(amount),
          cadence_days: cadence,
          last_date: entries[0].date,
          typical_day: Math.round(entries.reduce((s, e) => s + parseInt(e.day_of_month), 0) / entries.length),
        });
      }
    }

    // Get upcoming bills from subscriptions + recurring transfers
    const [subsResult, transfersResult] = await Promise.all([
      pool.query(`
        SELECT display_name, amount, cadence_days, next_expected
        FROM detected_subscriptions
        WHERE is_active = true AND is_dismissed = false AND cancelled_at IS NULL
          AND next_expected IS NOT NULL
      `),
      pool.query(`
        SELECT display_name, amount, cadence_days, next_expected, transfer_type, direction
        FROM recurring_transfers
        WHERE is_active = true AND is_dismissed = false
          AND next_expected IS NOT NULL AND direction = 'outgoing'
      `),
    ]);

    // Combine subscriptions and outgoing recurring transfers into bill schedule
    const allBills = [...subsResult.rows, ...transfersResult.rows];

    // Pre-compute next occurrence for each bill (once, not per-day)
    const now = new Date();
    const billSchedule = allBills.map(sub => {
      let nextDate = new Date(sub.next_expected);
      const cadence = parseInt(sub.cadence_days);
      while (nextDate < now) nextDate = new Date(nextDate.getTime() + cadence * 86400000);
      const occurrences = [];
      const endDate = new Date(now.getTime() + (days + 1) * 86400000);
      while (nextDate <= endDate) {
        occurrences.push(nextDate.toISOString().split("T")[0]);
        nextDate = new Date(nextDate.getTime() + cadence * 86400000);
      }
      return { name: sub.display_name, amount: parseFloat(sub.amount), dates: new Set(occurrences) };
    });

    // Get current balances
    const balResult = await pool.query(`
      SELECT SUM(CASE WHEN type != 'credit' THEN COALESCE(available_balance, current_balance, 0) ELSE 0 END) AS cash,
             SUM(CASE WHEN type = 'credit' THEN COALESCE(current_balance, 0) ELSE 0 END) AS debt
      FROM linked_accounts
      WHERE available_balance IS NOT NULL OR current_balance IS NOT NULL
    `);
    let runningBalance = parseFloat(balResult.rows[0]?.cash || 0);

    // Get average daily discretionary spending (last 60 days, excluding subscription bills)
    // Also apply spending split for shared accounts
    const avgSpendResult = await pool.query(`
      SELECT COALESCE(AVG(daily_total), 0) AS avg_daily
      FROM (
        SELECT t.date, ROUND(SUM(${SPLIT_AMOUNT}), 2) AS daily_total
        FROM transactions t
        LEFT JOIN linked_accounts la ON la.account_id = t.account_id
        WHERE t.amount > 0 AND t.pending = false
          AND COALESCE(t.is_reimbursed, false) = false
          AND ${NOT_TRANSFER}
          AND t.date >= CURRENT_DATE - INTERVAL '60 days'
        GROUP BY t.date
      ) daily
    `);
    const avgDailySpend = parseFloat(avgSpendResult.rows[0]?.avg_daily || 0);

    // Get per-day-of-week spending averages for more realistic variation.
    // Generate every date in the 60-day window so that days with zero spending
    // are still included in each DOW's average — otherwise days with no debits
    // would skew the per-DOW means upward.
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

    let totalIncome = 0;
    let totalBills = 0;
    let totalDiscretionary = 0;
    const projection = [];

    for (let d = 0; d < days; d++) {
      const date = new Date(now.getTime() + (d + 1) * 86400000);
      const dateStr = date.toISOString().split("T")[0];
      const dayOfMonth = date.getDate();
      const dow = date.getDay();
      let dayIncome = 0;
      let dayBills = 0;

      // Check for income
      for (const inc of recurringIncome) {
        if (inc.cadence_days === 30) {
          // Clamp the typical pay-day to the month's last day so a paycheck
          // whose typical_day is 29-31 still projects in shorter months (Feb,
          // 30-day months) instead of being silently skipped (BS-7).
          const daysInMonth = new Date(date.getFullYear(), date.getMonth() + 1, 0).getDate();
          const payDay = Math.min(inc.typical_day, daysInMonth);
          if (dayOfMonth === payDay) dayIncome += inc.amount;
        } else if (inc.cadence_days === 14) {
          const lastDate = new Date(inc.last_date);
          const daysSinceLast = Math.round((date - lastDate) / 86400000);
          if (daysSinceLast > 0 && daysSinceLast % 14 === 0) dayIncome += inc.amount;
        } else if (inc.cadence_days === 7) {
          const lastDate = new Date(inc.last_date);
          const daysSinceLast = Math.round((date - lastDate) / 86400000);
          if (daysSinceLast > 0 && daysSinceLast % 7 === 0) dayIncome += inc.amount;
        }
      }

      // Check for bills (using pre-computed schedule)
      for (const bill of billSchedule) {
        if (bill.dates.has(dateStr)) dayBills += bill.amount;
      }

      // Use day-of-week spending average if available, else overall average
      const daySpend = dowSpend[dow] !== undefined ? dowSpend[dow] : avgDailySpend;

      runningBalance += dayIncome - dayBills - daySpend;
      totalIncome += dayIncome;
      totalBills += dayBills;
      totalDiscretionary += daySpend;

      projection.push({
        date: dateStr,
        income: Math.round(dayIncome * 100) / 100,
        bills: Math.round(dayBills * 100) / 100,
        discretionary: Math.round(daySpend * 100) / 100,
        balance: Math.round(runningBalance * 100) / 100,
      });
    }

    // Weekly summary
    const byWeek = [];
    for (let w = 0; w < Math.ceil(days / 7); w++) {
      const weekSlice = projection.slice(w * 7, (w + 1) * 7);
      byWeek.push({
        week: w + 1,
        start_date: weekSlice[0]?.date,
        income: Math.round(weekSlice.reduce((s, d) => s + d.income, 0) * 100) / 100,
        bills: Math.round(weekSlice.reduce((s, d) => s + d.bills, 0) * 100) / 100,
        discretionary: Math.round(weekSlice.reduce((s, d) => s + d.discretionary, 0) * 100) / 100,
        end_balance: weekSlice[weekSlice.length - 1]?.balance || 0,
      });
    }

    res.json({
      forecast_days: days,
      starting_balance: parseFloat(balResult.rows[0]?.cash || 0),
      avg_daily_spend: Math.round(avgDailySpend * 100) / 100,
      total_projected_income: Math.round(totalIncome * 100) / 100,
      total_projected_bills: Math.round(totalBills * 100) / 100,
      total_projected_discretionary: Math.round(totalDiscretionary * 100) / 100,
      ending_balance: projection[projection.length - 1]?.balance || 0,
      surplus_shortfall: Math.round((totalIncome - totalBills - totalDiscretionary) * 100) / 100,
      recurring_income: recurringIncome,
      by_week: byWeek,
    });
  } catch (err) {
    console.error("cash-flow error:", err.message);
    res.status(500).json({ error: "An internal error occurred." });
  }
});

// GET /api/spending-yoy — Year-over-year spending comparison
router.get("/api/spending-yoy", async (req, res) => {
  const month = parseInt(req.query.month) || new Date().getMonth() + 1;
  const year = parseInt(req.query.year) || new Date().getFullYear();
  try {
    // Phase B3: honor transaction_splits for per-category breakdowns.
    const result = await pool.query(`
      WITH parent_no_splits AS (
        SELECT t.date, COALESCE(t.user_category, t.category[1], 'Uncategorized') AS category,
               ${SPLIT_AMOUNT} AS amount
        FROM transactions t
        LEFT JOIN linked_accounts la ON la.account_id = t.account_id
        WHERE t.amount > 0 AND t.pending = false
          AND COALESCE(t.is_reimbursed, false) = false
          AND ${NOT_TRANSFER}
          AND EXTRACT(MONTH FROM t.date) = $1
          AND EXTRACT(YEAR FROM t.date) >= $2 - 2
          AND NOT EXISTS (SELECT 1 FROM transaction_splits s WHERE s.parent_transaction_id = t.transaction_id)
      ),
      from_splits AS (
        SELECT t.date, COALESCE(s.category, t.user_category, t.category[1], 'Uncategorized') AS category,
               ${SPLIT_AMOUNT.replace(/t\.amount/g, "s.amount")} AS amount
        FROM transaction_splits s
        JOIN transactions t ON t.transaction_id = s.parent_transaction_id
        LEFT JOIN linked_accounts la ON la.account_id = t.account_id
        WHERE t.amount > 0 AND t.pending = false
          AND COALESCE(t.is_reimbursed, false) = false
          AND ${NOT_TRANSFER}
          AND EXTRACT(MONTH FROM t.date) = $1
          AND EXTRACT(YEAR FROM t.date) >= $2 - 2
      ),
      all_lines AS (SELECT * FROM parent_no_splits UNION ALL SELECT * FROM from_splits)
      SELECT TO_CHAR(date, 'YYYY') AS year,
             TO_CHAR(date, 'MM') AS month,
             category,
             ROUND(SUM(amount), 2) AS total,
             COUNT(*) AS txn_count
      FROM all_lines
      GROUP BY TO_CHAR(date, 'YYYY'), TO_CHAR(date, 'MM'), category
      ORDER BY year DESC, total DESC
    `, [month, year]);

    // Group by year
    const byYear = {};
    for (const row of result.rows) {
      if (!byYear[row.year]) byYear[row.year] = { total: 0, txn_count: 0, categories: {} };
      byYear[row.year].total += parseFloat(row.total);
      byYear[row.year].txn_count += parseInt(row.txn_count);
      byYear[row.year].categories[row.category] = parseFloat(row.total);
    }

    // Calculate changes
    const years = Object.keys(byYear).sort().reverse();
    const comparisons = [];
    for (let i = 0; i < years.length - 1; i++) {
      const curr = byYear[years[i]];
      const prev = byYear[years[i + 1]];
      comparisons.push({
        current_year: years[i],
        previous_year: years[i + 1],
        current_total: Math.round(curr.total * 100) / 100,
        previous_total: Math.round(prev.total * 100) / 100,
        change_amount: Math.round((curr.total - prev.total) * 100) / 100,
        change_percent: prev.total > 0 ? Math.round(((curr.total - prev.total) / prev.total) * 10000) / 100 : null,
        category_changes: Object.keys({...curr.categories, ...prev.categories}).map(cat => ({
          category: cat,
          current: Math.round((curr.categories[cat] || 0) * 100) / 100,
          previous: Math.round((prev.categories[cat] || 0) * 100) / 100,
          change: Math.round(((curr.categories[cat] || 0) - (prev.categories[cat] || 0)) * 100) / 100,
        })).sort((a, b) => Math.abs(b.change) - Math.abs(a.change)),
      });
    }

    const monthNames = ['January','February','March','April','May','June','July','August','September','October','November','December'];
    res.json({
      month: month,
      month_name: monthNames[month - 1],
      by_year: byYear,
      comparisons,
    });
  } catch (err) {
    console.error("yoy error:", err.message);
    res.status(500).json({ error: "An internal error occurred." });
  }
});

// GET /api/savings-rate — Income detection + savings rate calculation
// Uses shared helpers from services/financial-queries.js so numbers agree
// with insights and the dashboard (eliminates inline SQL drift).
router.get("/api/savings-rate", async (req, res) => {
  const months = parseInt(req.query.months) || 3;
  try {
    const [incomeRows, spendRows] = await Promise.all([
      getMonthlyIncome(pool, months),
      getMonthlySpending(pool, months),
    ]);

    const incomeMap = {};
    for (const r of incomeRows) incomeMap[r.month] = parseFloat(r.total_income);
    const spendMap = {};
    for (const r of spendRows) spendMap[r.month] = parseFloat(r.total_spend);

    const allMonths = [...new Set([...Object.keys(incomeMap), ...Object.keys(spendMap)])].sort().reverse();
    const monthly = allMonths.map(m => {
      const income = incomeMap[m] || 0;
      const spending = spendMap[m] || 0;
      const saved = income - spending;
      const rate = income > 0 ? Math.round((saved / income) * 10000) / 100 : 0;
      return { month: m, income: Math.round(income * 100) / 100, spending: Math.round(spending * 100) / 100, saved: Math.round(saved * 100) / 100, savings_rate: rate };
    });

    // Average over COMPLETED months only — the current month is partial-to-date
    // and including it drags the average down mid-month (F7). This matches the
    // FIRE projection (goals.js) and the documented getMonthly* "current month
    // is partial" semantics. The current month still appears in `months` for the
    // trend; only the averages exclude it. Fall back to all rows if the only
    // data is the current month (brand-new user) so averages aren't 0.
    const thisMonth = new Date().toISOString().slice(0, 7);
    const avgBase = monthly.filter(m => m.month !== thisMonth);
    const base = avgBase.length ? avgBase : monthly;
    const totalIncome = base.reduce((s, m) => s + m.income, 0);
    const totalSpending = base.reduce((s, m) => s + m.spending, 0);
    const avgIncome = base.length ? totalIncome / base.length : 0;
    const avgSpending = base.length ? totalSpending / base.length : 0;
    const avgSaved = avgIncome - avgSpending;
    const avgRate = avgIncome > 0 ? Math.round((avgSaved / avgIncome) * 10000) / 100 : 0;

    // 50/30/20 analysis
    const needsRatio = avgIncome > 0 ? Math.round((avgSpending * 0.5 / avgIncome) * 10000) / 100 : 0;

    res.json({
      months: monthly,
      averages: {
        income: Math.round(avgIncome * 100) / 100,
        spending: Math.round(avgSpending * 100) / 100,
        saved: Math.round(avgSaved * 100) / 100,
        savings_rate: avgRate,
      },
      recommendation: avgRate >= 20 ? "Excellent! You're saving 20%+ of income." :
                       avgRate >= 10 ? "Good savings rate. Try to reach 20% for long-term wealth building." :
                       avgRate > 0 ? "You're saving, but aim for at least 10-20% of income." :
                       "Spending exceeds detected income. Review expenses or add income sources.",
    });
  } catch (err) {
    console.error("savings-rate error:", err.message);
    res.status(500).json({ error: "An internal error occurred." });
  }
});


// GET /api/income-summary — Monthly income trend + top sources + by-account.
// Symmetric to /api/spending-summary so the dashboard can show income with
// the same depth as spending (previously only /api/savings-rate exposed
// income, and only as an aggregate). Uses the shared INCOME_PREDICATE so the
// numbers agree with cash-flow, savings-rate, and AI insights.
router.get("/api/income-summary", async (req, res) => {
  const months = Math.max(1, Math.min(parseInt(req.query.months) || 6, 24));
  try {
    const [monthlyTrend, bySource, byAccount] = await Promise.all([
      pool.query(
        `SELECT TO_CHAR(date, 'YYYY-MM') AS month,
                ROUND(SUM(ABS(amount)), 2) AS total_income,
                COUNT(*) AS deposit_count
         FROM transactions
         WHERE amount < 0 AND pending = false
           AND date >= CURRENT_DATE - make_interval(months => $1)
           AND ${INCOME_PREDICATE}
         GROUP BY TO_CHAR(date, 'YYYY-MM')
         ORDER BY month`,
        [months]
      ),
      pool.query(
        `SELECT COALESCE(merchant_name, name) AS source,
                ROUND(SUM(ABS(amount)), 2) AS total_income,
                COUNT(*) AS deposit_count,
                MAX(date) AS last_seen
         FROM transactions
         WHERE amount < 0 AND pending = false
           AND date >= CURRENT_DATE - make_interval(months => $1)
           AND ${INCOME_PREDICATE}
         GROUP BY COALESCE(merchant_name, name)
         ORDER BY total_income DESC
         LIMIT 10`,
        [months]
      ),
      pool.query(
        `SELECT la.name AS account_name,
                COALESCE(te.institution_name, pi.institution_name, la.institution_name_manual) AS institution_name,
                ROUND(SUM(ABS(t.amount)), 2) AS total_income,
                COUNT(*) AS deposit_count
         FROM transactions t
         JOIN linked_accounts la ON la.account_id = t.account_id
         LEFT JOIN teller_enrollments te ON te.id = la.teller_enrollment_id
         LEFT JOIN plaid_items pi ON pi.id = la.plaid_item_id
         WHERE t.amount < 0 AND t.pending = false
           AND t.date >= CURRENT_DATE - make_interval(months => $1)
           AND ${INCOME_PREDICATE_T}
         GROUP BY la.id, la.name, te.institution_name, pi.institution_name, la.institution_name_manual
         ORDER BY total_income DESC`,
        [months]
      ),
    ]);

    const totalIncome = monthlyTrend.rows.reduce((s, r) => s + parseFloat(r.total_income), 0);
    const avgMonthly = monthlyTrend.rows.length > 0 ? totalIncome / monthlyTrend.rows.length : 0;

    res.json({
      months,
      total_income: Math.round(totalIncome * 100) / 100,
      avg_monthly_income: Math.round(avgMonthly * 100) / 100,
      monthly_trend: monthlyTrend.rows,
      top_sources: bySource.rows,
      by_account: byAccount.rows,
    });
  } catch (err) {
    console.error("income-summary error:", err.message);
    res.status(500).json({ error: "An internal error occurred." });
  }
});

module.exports = router;
