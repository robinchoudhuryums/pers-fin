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
const { getCashFlowForecast } = require("../services/cash-flow");
const { INCOME_AMOUNT, incomePredicate, spendLinesCTE, NET_CATEGORY_MONTHS, getMonthlySpending, getMonthlyIncome, getCategorySpendingForMonth, currentMonth, todayStr } = require("../services/financial-queries");

// The one query here that JOINs linked_accounts must qualify its column refs
// (`name` exists on both tables — the unqualified form 500'd /api/income-summary
// in production; found by the e2e harness's live boot). incomePredicate(alias)
// qualifies every outer reference with the caller's alias (FAN-2), so this is
// the "t" build of the same canonical predicate, not a regex-derived copy.
const INCOME_PREDICATE_T = incomePredicate("t");

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
// The summary's whole-month window over spend_lines ($1 = months, $2 = the
// APP_TIMEZONE month start).
const SUMMARY_WINDOW = "t.date >= date_trunc('month', $2::date) - make_interval(months => $1 - 1)";

router.get("/api/spending-summary", async (req, res) => {
  const months = parseInt(req.query.months) || 6;
  try {
    // Whole-month window (FAN-6 — the FA-4 fix, which this path had missed):
    // floor to the 1st so `months=6` returns 6 buckets (5 complete + the
    // current month-to-date), not 7 with a partial OLDEST month that dragged
    // the dashboard's "Avg Monthly" down. tz-aware anchor (F11).
    // F35: total_spend is net of refunds (each month's categories floored at
    // $0 — the same spend_lines every spending surface reads); txn_count and
    // avg_transaction describe the month's CHARGES.
    const monthlyTrend = await pool.query(
      `WITH ${spendLinesCTE(SUMMARY_WINDOW)},
       ${NET_CATEGORY_MONTHS},
       charges AS (
         SELECT month, COUNT(DISTINCT transaction_id) AS txn_count, SUM(amount) AS gross
         FROM spend_lines WHERE NOT is_refund GROUP BY month
       )
       SELECT n.month, ROUND(SUM(n.spent), 2) AS total_spend,
              MAX(c.txn_count) AS txn_count,
              ROUND(MAX(c.gross) / NULLIF(MAX(c.txn_count), 0), 2) AS avg_transaction
       FROM net_category_months n
       JOIN charges c ON c.month = n.month
       GROUP BY n.month
       ORDER BY n.month DESC`,
      [months, currentMonth() + "-01"]
    );
    // Averages over COMPLETED months only (FAN-6, as savings-rate does): the
    // current month is month-to-date, so including it understated the average.
    // Daily average uses the real day count of those months, not length × 30.
    const curMonth = currentMonth();
    const completeMonths = monthlyTrend.rows.filter(m => m.month !== curMonth);
    const completeTotal = completeMonths.reduce((sum, m) => sum + parseFloat(m.total_spend || 0), 0);
    const completeDays = completeMonths.reduce((sum, m) => {
      const [y, mo] = m.month.split("-").map(Number);
      return sum + new Date(Date.UTC(y, mo, 0)).getUTCDate();
    }, 0);
    const averages = {
      avg_monthly_spend: completeMonths.length ? Math.round((completeTotal / completeMonths.length) * 100) / 100 : null,
      avg_daily_spend: completeDays ? Math.round((completeTotal / completeDays) * 100) / 100 : null,
      avg_months: completeMonths.length,
    };

    // Category and merchant windows are the SAME whole APP_TIMEZONE months as
    // the trend (F41) — they used a rolling UTC `CURRENT_DATE - N months`, so
    // the category total disagreed with the trend's total for the same N.
    // Category breakdown honors transaction_splits (Phase B3): when a
    // transaction has splits, each split contributes to its own category
    // instead of the parent row's category. Parents without splits contribute
    // the full amount to the parent's category[1].
    // F35: refunds net per (month, category), floored at $0, then summed
    // across the window — so the breakdown adds up to the trend.
    const byCategory = await pool.query(
      `WITH ${spendLinesCTE(SUMMARY_WINDOW)},
       ${NET_CATEGORY_MONTHS}
       SELECT category, ROUND(SUM(spent), 2) AS total, SUM(charge_lines) AS txn_count
       FROM net_category_months
       GROUP BY category
       ORDER BY total DESC
       LIMIT 15`,
      [months, curMonth + "-01"]
    );

    // Exclusion list uses word-boundary regex (\y) so short tokens like "atm",
    // "pymt", and "epay" can't substring-match legitimate merchants (AT&T,
    // Atmos Energy, etc.). Multi-word phrases still work because \y anchors
    // at the phrase edges, not inside the phrase.
    // Group by the user's overridden merchant name when set, so renames like
    // "AMAZON MKTP*4321" -> "Amazon" collapse multiple rows into one merchant.
    // Reimbursed transactions are excluded from the total (Phase B2).
    // F35: a merchant's refunds net against its charges (floored at $0).
    const topMerchants = await pool.query(
      `WITH ${spendLinesCTE(SUMMARY_WINDOW)}
       SELECT merchant,
              ROUND(GREATEST(SUM(amount), 0), 2) AS total_spent,
              COUNT(DISTINCT transaction_id) FILTER (WHERE NOT is_refund) AS txn_count
       FROM spend_lines
       WHERE merchant IS NOT NULL
       GROUP BY merchant
       HAVING COUNT(*) FILTER (WHERE NOT is_refund) > 0
       ORDER BY total_spent DESC
       LIMIT 10`,
      [months, curMonth + "-01"]
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
      ...averages,
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

// GET /api/cash-flow — Rolling 30–180-day cash flow projection. The projection
// lives in services/cash-flow.js (roadmap T2.2 L1) so the cash alerts read the
// same numbers; this route returns its fields (not the daily series) plus the
// lowest projected day.
router.get("/api/cash-flow", async (req, res) => {
  const days = Math.min(Math.max(parseInt(req.query.days) || 90, 30), 180);
  try {
    const { projection, lowest, ...forecast } = await getCashFlowForecast(pool, { days });
    res.json({
      ...forecast,
      lowest_balance: lowest ? lowest.balance : null,
      lowest_balance_date: lowest ? lowest.date : null,
    });
  } catch (err) {
    console.error("cash-flow error:", err.message);
    res.status(500).json({ error: "An internal error occurred." });
  }
});

// GET /api/spending-yoy — Year-over-year spending comparison
router.get("/api/spending-yoy", async (req, res) => {
  // Defaults from the APP_TIMEZONE date (FAN-13).
  const today = todayStr();
  const month = parseInt(req.query.month) || parseInt(today.slice(5, 7), 10);
  const year = parseInt(req.query.year) || parseInt(today.slice(0, 4), 10);
  // DD-11: when the month being compared is the CURRENT (in-progress) month,
  // cap every year at today's day-of-month so month-to-date is compared with
  // the same days of prior years — not with a whole prior month (on the 3rd the
  // widget used to show "↓ ~90%"). 31 = no cap.
  const isCurrentMonth = year === parseInt(today.slice(0, 4), 10) && month === parseInt(today.slice(5, 7), 10);
  const throughDay = isCurrentMonth ? parseInt(today.slice(8, 10), 10) : 31;
  try {
    // Phase B3: honor transaction_splits for per-category breakdowns.
    // F35: refunds net per (year, category) within the compared month,
    // floored at $0; txn_count counts charges.
    const result = await pool.query(`
      WITH ${spendLinesCTE(`EXTRACT(MONTH FROM t.date) = $1
          AND EXTRACT(YEAR FROM t.date) BETWEEN $2 - 2 AND $2
          AND EXTRACT(DAY FROM t.date) <= $3`)}
      SELECT TO_CHAR(date, 'YYYY') AS year,
             TO_CHAR(date, 'MM') AS month,
             category,
             ROUND(GREATEST(SUM(amount), 0), 2) AS total,
             COUNT(*) FILTER (WHERE NOT is_refund) AS txn_count
      FROM spend_lines
      GROUP BY TO_CHAR(date, 'YYYY'), TO_CHAR(date, 'MM'), category
      HAVING COUNT(*) FILTER (WHERE NOT is_refund) > 0
      ORDER BY year DESC, total DESC
    `, [month, year, throughDay]);

    // Group by year
    const byYear = {};
    for (const row of result.rows) {
      if (!byYear[row.year]) byYear[row.year] = { total: 0, txn_count: 0, categories: {} };
      byYear[row.year].total += parseFloat(row.total);
      byYear[row.year].txn_count += parseInt(row.txn_count);
      byYear[row.year].categories[row.category] = parseFloat(row.total);
    }

    // Calculate changes
    // Compare only CONSECUTIVE years (DD-11): a missing year used to be
    // silently skipped, so "2026 vs 2024" was presented as year-over-year.
    const years = Object.keys(byYear).sort().reverse();
    const comparisons = [];
    for (let i = 0; i < years.length; i++) {
      const prevKey = String(parseInt(years[i], 10) - 1);
      if (!byYear[prevKey]) continue;
      const curr = byYear[years[i]];
      const prev = byYear[prevKey];
      comparisons.push({
        current_year: years[i],
        previous_year: prevKey,
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
      // Day-of-month every year is capped at (null = whole month) — DD-11.
      through_day: throughDay < 31 ? throughDay : null,
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
    const thisMonth = currentMonth();
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
    // Window anchored on the APP_TIMEZONE month (FAN-13) — date_trunc('month',
    // CURRENT_DATE) is the UTC month, which flips early west of UTC.
    const cm = currentMonth();
    const monthStart = cm + "-01";
    const [monthlyTrend, bySource, byAccount] = await Promise.all([
      pool.query(
        `SELECT TO_CHAR(t.date, 'YYYY-MM') AS month,
                ROUND(SUM(${INCOME_AMOUNT}), 2) AS total_income,
                COUNT(*) AS deposit_count
         FROM transactions t
         LEFT JOIN linked_accounts la ON la.account_id = t.account_id
         WHERE t.amount < 0 AND t.pending = false
           -- Whole-month window (FA-4): floor to the 1st so the oldest bucket is
           -- a FULL month, matching getMonthlyIncome — otherwise avg_monthly_income
           -- divides a rolling-window total by a count that includes a partial month.
           AND t.date >= $2::date - make_interval(months => $1 - 1)
           AND ${INCOME_PREDICATE_T}
         GROUP BY TO_CHAR(t.date, 'YYYY-MM')
         ORDER BY month`,
        [months, monthStart]
      ),
      pool.query(
        `SELECT COALESCE(t.merchant_name, t.name) AS source,
                ROUND(SUM(${INCOME_AMOUNT}), 2) AS total_income,
                COUNT(*) AS deposit_count,
                MAX(t.date) AS last_seen
         FROM transactions t
         LEFT JOIN linked_accounts la ON la.account_id = t.account_id
         WHERE t.amount < 0 AND t.pending = false
           -- Whole-month window (FA-4): floor to the 1st so the oldest bucket is
           -- a FULL month, matching getMonthlyIncome — otherwise avg_monthly_income
           -- divides a rolling-window total by a count that includes a partial month.
           AND t.date >= $2::date - make_interval(months => $1 - 1)
           AND ${INCOME_PREDICATE_T}
         GROUP BY COALESCE(t.merchant_name, t.name)
         ORDER BY total_income DESC
         LIMIT 10`,
        [months, monthStart]
      ),
      pool.query(
        `SELECT la.name AS account_name,
                COALESCE(te.institution_name, pi.institution_name, la.institution_name_manual) AS institution_name,
                ROUND(SUM(${INCOME_AMOUNT}), 2) AS total_income,
                COUNT(*) AS deposit_count
         FROM transactions t
         JOIN linked_accounts la ON la.account_id = t.account_id
         LEFT JOIN teller_enrollments te ON te.id = la.teller_enrollment_id
         LEFT JOIN plaid_items pi ON pi.id = la.plaid_item_id
         WHERE t.amount < 0 AND t.pending = false
           AND t.date >= $2::date - make_interval(months => $1 - 1)
           AND ${INCOME_PREDICATE_T}
         GROUP BY la.id, la.name, te.institution_name, pi.institution_name, la.institution_name_manual
         ORDER BY total_income DESC`,
        [months, monthStart]
      ),
    ]);

    const totalIncome = monthlyTrend.rows.reduce((s, r) => s + parseFloat(r.total_income), 0);
    // Average over COMPLETED months only (FAN-13): the partial current month
    // dragged avg_monthly_income down early in every month. Falls back to all
    // months when only the current month has data.
    const completed = monthlyTrend.rows.filter((r) => r.month !== cm);
    const avgBase = completed.length ? completed : monthlyTrend.rows;
    const avgMonthly = avgBase.length > 0
      ? avgBase.reduce((s, r) => s + parseFloat(r.total_income), 0) / avgBase.length : 0;

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
