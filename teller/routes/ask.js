// ============================================================================
// Routes: Ask Perfin — natural-language finance Q&A via Claude tool use
// ============================================================================
// POST /api/ask { question } → Claude answers using READ-ONLY tools that call
// the same shared helpers as the dashboard (getCategorySpendingForMonth,
// getMonthlyIncome/Spending, getNetWorth, the FIRE projection), so every
// number it cites matches the UI by construction — the model never writes
// SQL, only structured tool arguments bound to parameterized queries.
//
// Cost: shares the monthly AI cap with insights/categorize/rebuild (INV-14 —
// resolved via insights.getAiBudgetCents) and writes a financial_insights
// usage row with entry_type='ask' so its spend charges the cap. The tool loop
// is bounded (MAX_TOOL_ROUNDS) and every tool result is size-capped.

const express = require("express");
const router = express.Router();
const { pool } = require("../services/database");
const {
  getMonthlyIncome, getMonthlySpending, getNetWorth,
  getCategorySpendingForMonth, SPLIT_AMOUNT, NOT_REIMBURSED,
} = require("../services/financial-queries");
const { MODEL_MAP, estimateCostGranular } = require("../data/reference-data");

let Anthropic;
try {
  Anthropic = require("@anthropic-ai/sdk").default || require("@anthropic-ai/sdk");
} catch {
  Anthropic = null;
}

const MAX_TOOL_ROUNDS = 6;
const MAX_QUESTION_CHARS = 500;

// ---------------------------------------------------------------------------
// Tool executors — pure read paths. Each takes validated args + returns a
// JSON-serializable result. Exported for tests.
// ---------------------------------------------------------------------------
const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

async function toolMonthlyOverview(args) {
  const months = Math.min(24, Math.max(1, parseInt(args.months) || 6));
  const [income, spending] = await Promise.all([
    getMonthlyIncome(pool, months),
    getMonthlySpending(pool, months),
  ]);
  return { months, income, spending };
}

async function toolCategorySpending(args) {
  const month = String(args.month || "");
  if (!MONTH_RE.test(month)) return { error: "month must be 'YYYY-MM'" };
  const rows = await getCategorySpendingForMonth(pool, month);
  rows.sort((a, b) => parseFloat(b.spent) - parseFloat(a.spent));
  return { month, categories: rows };
}

// Parameterized transaction search. Returns up to `limit` rows PLUS the
// split-adjusted, reimbursed-excluded total over ALL matches, so "how much
// did I spend at X" answers use the same arithmetic as the dashboard even
// when the row list is truncated.
async function toolSearchTransactions(args) {
  const clauses = ["t.pending = false"];
  const params = [];
  let i = 1;
  if (args.merchant) {
    clauses.push(`COALESCE(t.user_merchant_name, t.merchant_name, t.name) ILIKE $${i++}`);
    params.push("%" + String(args.merchant).slice(0, 80) + "%");
  }
  if (args.category) {
    clauses.push(`COALESCE(t.user_category, t.category[1]) = $${i++}`);
    params.push(String(args.category).slice(0, 50));
  }
  if (args.start_date) {
    if (!DATE_RE.test(args.start_date)) return { error: "start_date must be YYYY-MM-DD" };
    clauses.push(`t.date >= $${i++}`);
    params.push(args.start_date);
  }
  if (args.end_date) {
    if (!DATE_RE.test(args.end_date)) return { error: "end_date must be YYYY-MM-DD" };
    clauses.push(`t.date <= $${i++}`);
    params.push(args.end_date);
  }
  if (args.min_amount !== undefined && Number.isFinite(Number(args.min_amount))) {
    clauses.push(`ABS(t.amount) >= $${i++}`);
    params.push(Number(args.min_amount));
  }
  const where = clauses.join(" AND ");
  const limit = Math.min(50, Math.max(1, parseInt(args.limit) || 25));

  const [rows, totals] = await Promise.all([
    pool.query(
      `SELECT t.date::text AS date,
              COALESCE(t.user_merchant_name, t.merchant_name, t.name) AS merchant,
              t.amount, COALESCE(t.user_category, t.category[1], 'Uncategorized') AS category,
              t.is_reimbursed
       FROM transactions t
       WHERE ${where}
       ORDER BY t.date DESC
       LIMIT ${limit}`,
      params
    ),
    pool.query(
      `SELECT COUNT(*) AS match_count,
              ROUND(SUM(CASE WHEN t.amount > 0 THEN ${SPLIT_AMOUNT} ELSE 0 END), 2) AS total_spent_adjusted
       FROM transactions t
       LEFT JOIN linked_accounts la ON la.account_id = t.account_id
       WHERE ${where} AND ${NOT_REIMBURSED}`,
      params
    ),
  ]);
  return {
    match_count: parseInt(totals.rows[0].match_count),
    total_spent_adjusted: totals.rows[0].total_spent_adjusted,
    note: "total_spent_adjusted is split/shared-card adjusted and excludes reimbursed rows (matches the dashboard); the row list shows raw amounts.",
    transactions: rows.rows,
  };
}

async function toolNetWorth() {
  const nw = await getNetWorth(pool);
  return { total_assets: nw.total_assets, total_liabilities: nw.total_liabilities, net_worth: nw.net_worth };
}

async function toolSubscriptions() {
  const r = await pool.query(
    `SELECT display_name, amount, cadence_days, next_expected::text AS next_expected,
            ROUND(amount * (30.0 / NULLIF(cadence_days, 0)), 2) AS monthly_cost
     FROM detected_subscriptions
     WHERE is_active = true AND is_dismissed = false AND cancelled_at IS NULL
     ORDER BY monthly_cost DESC NULLS LAST LIMIT 50`
  );
  const total = r.rows.reduce((s, x) => s + parseFloat(x.monthly_cost || 0), 0);
  return { total_monthly_cost: Math.round(total * 100) / 100, subscriptions: r.rows };
}

async function toolBudgetStatus() {
  const { getCategorySpendingThisMonth } = require("../services/financial-queries");
  const [budgets, spending] = await Promise.all([
    pool.query("SELECT category, monthly_limit, rollover_enabled FROM budgets"),
    getCategorySpendingThisMonth(pool),
  ]);
  const spendMap = {};
  for (const s of spending) spendMap[s.category] = parseFloat(s.spent);
  return {
    month: new Date().toISOString().slice(0, 7),
    budgets: budgets.rows.map(b => ({
      category: b.category,
      monthly_limit: parseFloat(b.monthly_limit),
      spent_this_month: spendMap[b.category] || 0,
    })),
  };
}

async function toolFireProjection() {
  const { computeFireProjection, computeRunwayMonths } = require("../services/projections");
  const [nw, income, spending, sRow] = await Promise.all([
    getNetWorth(pool),
    getMonthlyIncome(pool, 7),
    getMonthlySpending(pool, 7),
    pool.query("SELECT fire_expected_return_pct, fire_withdrawal_rate_pct, fire_monthly_spending_override FROM user_settings WHERE id = 1"),
  ]);
  const s = sRow.rows[0] || {};
  const thisMonth = new Date().toISOString().slice(0, 7);
  const avg = (rows, key) => {
    const v = rows.filter(r => String(r.month).slice(0, 7) !== thisMonth).map(r => parseFloat(r[key]) || 0);
    return v.length ? v.reduce((a, b) => a + b, 0) / v.length : 0;
  };
  const monthlySpending = s.fire_monthly_spending_override != null
    ? parseFloat(s.fire_monthly_spending_override) : avg(spending, "total_spend");
  const proj = computeFireProjection({
    netWorth: nw.net_worth,
    monthlySavings: avg(income, "total_income") - avg(spending, "total_spend"),
    monthlySpending,
    annualReturnPct: s.fire_expected_return_pct != null ? parseFloat(s.fire_expected_return_pct) : 5,
    withdrawalRatePct: s.fire_withdrawal_rate_pct != null ? parseFloat(s.fire_withdrawal_rate_pct) : 4,
  });
  delete proj.series; // too large for a tool result; the page has the chart
  proj.runway_months = computeRunwayMonths({
    netWorth: nw.net_worth, monthlySpending,
    annualReturnPct: s.fire_expected_return_pct != null ? parseFloat(s.fire_expected_return_pct) : 5,
  });
  return proj;
}

const TOOL_EXECUTORS = {
  get_monthly_overview: toolMonthlyOverview,
  get_category_spending: toolCategorySpending,
  search_transactions: toolSearchTransactions,
  get_net_worth: toolNetWorth,
  get_subscriptions: toolSubscriptions,
  get_budget_status: toolBudgetStatus,
  get_fire_projection: toolFireProjection,
};

const TOOLS = [
  { name: "get_monthly_overview", description: "Monthly income and spending totals for the last N months (split-adjusted, matches the dashboard).", input_schema: { type: "object", properties: { months: { type: "integer", description: "1-24, default 6" } } } },
  { name: "get_category_spending", description: "Per-category spending for one month (splits-aware, reimbursed-excluded).", input_schema: { type: "object", properties: { month: { type: "string", description: "YYYY-MM" } }, required: ["month"] } },
  { name: "search_transactions", description: "Search transactions by merchant substring, category, date range, or minimum amount. Returns matching rows plus a dashboard-consistent adjusted spending total over ALL matches.", input_schema: { type: "object", properties: { merchant: { type: "string" }, category: { type: "string" }, start_date: { type: "string", description: "YYYY-MM-DD" }, end_date: { type: "string", description: "YYYY-MM-DD" }, min_amount: { type: "number" }, limit: { type: "integer", description: "max 50" } } } },
  { name: "get_net_worth", description: "Current net worth: assets, liabilities, total.", input_schema: { type: "object", properties: {} } },
  { name: "get_subscriptions", description: "Active detected subscriptions with monthly costs.", input_schema: { type: "object", properties: {} } },
  { name: "get_budget_status", description: "This month's budgets and spending against them.", input_schema: { type: "object", properties: {} } },
  { name: "get_fire_projection", description: "FIRE number, progress, time to FIRE, and spending runway under the user's saved assumptions.", input_schema: { type: "object", properties: {} } },
];

// POST /api/ask — single-turn NL question over the user's finance data.
router.post("/api/ask", async (req, res) => {
  if (!Anthropic || !process.env.ANTHROPIC_API_KEY) {
    return res.status(501).json({ error: "AI not configured. Set ANTHROPIC_API_KEY." });
  }
  const question = String((req.body && req.body.question) || "").trim().slice(0, MAX_QUESTION_CHARS);
  if (!question) return res.status(400).json({ error: "question is required" });

  try {
    // Shared monthly cap (INV-14): same resolver + month-spend computation
    // family as insights/categorize; this endpoint both checks AND charges.
    const { getAiBudgetCents } = require("./insights");
    const budgetCents = await getAiBudgetCents();
    const u = await pool.query(
      "SELECT tokens_used, model_used, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens FROM financial_insights WHERE created_at >= date_trunc('month', CURRENT_DATE)"
    );
    let spendCents = 0;
    u.rows.forEach(r => {
      const { estimateCostUsd } = require("../data/reference-data");
      const cost = r.input_tokens
        ? estimateCostGranular({ input_tokens: r.input_tokens, output_tokens: r.output_tokens, cache_read_input_tokens: r.cache_read_tokens || 0, cache_creation_input_tokens: r.cache_creation_tokens || 0 }, r.model_used)
        : estimateCostUsd(r.tokens_used || 0, r.model_used);
      spendCents += cost * 100;
    });
    if (spendCents >= budgetCents) {
      return res.status(429).json({ error: `Monthly AI budget reached ($${(budgetCents / 100).toFixed(2)} cap). Raise it under Settings → AI Insights.` });
    }

    const settingsRow = await pool.query("SELECT insights_model FROM user_settings WHERE id = 1");
    const modelId = MODEL_MAP[settingsRow.rows[0]?.insights_model] || MODEL_MAP.haiku;

    const client = new Anthropic();
    const system =
      "You are Perfin's finance assistant answering questions about the user's own financial data. " +
      "ALWAYS use the tools for any number — never estimate or invent figures. The tools return the same " +
      "split-adjusted, reimbursed-excluded values the dashboard shows. Be concise and concrete; state the " +
      "period a figure covers. If the data can't answer the question, say so plainly. " +
      `Today's date is ${new Date().toISOString().slice(0, 10)}.`;

    const messages = [{ role: "user", content: question }];
    const toolCalls = [];
    let totalUsage = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
    let answer = null;

    for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
      const msg = await client.messages.create({
        model: modelId,
        max_tokens: 1024,
        system,
        tools: TOOLS,
        messages,
      });
      if (msg.usage) {
        totalUsage.input_tokens += msg.usage.input_tokens || 0;
        totalUsage.output_tokens += msg.usage.output_tokens || 0;
        totalUsage.cache_read_input_tokens += msg.usage.cache_read_input_tokens || 0;
        totalUsage.cache_creation_input_tokens += msg.usage.cache_creation_input_tokens || 0;
      }

      const toolUses = msg.content.filter(b => b.type === "tool_use");
      if (msg.stop_reason !== "tool_use" || toolUses.length === 0 || round === MAX_TOOL_ROUNDS) {
        answer = msg.content.filter(b => b.type === "text").map(b => b.text).join("\n").trim();
        break;
      }
      messages.push({ role: "assistant", content: msg.content });
      const results = [];
      for (const tu of toolUses) {
        let result;
        try {
          const exec = TOOL_EXECUTORS[tu.name];
          result = exec ? await exec(tu.input || {}) : { error: "unknown tool" };
        } catch (e) {
          result = { error: "tool failed: " + e.message };
        }
        toolCalls.push({ tool: tu.name, input: tu.input });
        results.push({
          type: "tool_result",
          tool_use_id: tu.id,
          content: JSON.stringify(result).slice(0, 12000),
        });
      }
      messages.push({ role: "user", content: results });
    }

    // Charge the cap (entry_type='ask' — counted by the cap queries, filtered
    // out of the user-facing insights feed which selects entry_type='insight').
    await pool.query(
      `INSERT INTO financial_insights
         (insight_text, model_used, tokens_used, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, entry_type)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'ask')`,
      [
        `[Ask] ${question.slice(0, 120)}`,
        modelId,
        totalUsage.input_tokens + totalUsage.output_tokens,
        totalUsage.input_tokens, totalUsage.output_tokens,
        totalUsage.cache_read_input_tokens, totalUsage.cache_creation_input_tokens,
      ]
    );

    res.json({
      answer: answer || "I couldn't produce an answer — try rephrasing.",
      tools_used: toolCalls.map(t => t.tool),
      estimated_cost_usd: Math.round(estimateCostGranular(totalUsage, modelId) * 10000) / 10000,
    });
  } catch (err) {
    console.error("ask error:", err.message);
    res.status(500).json({ error: "An internal error occurred." });
  }
});

module.exports = router;
module.exports.TOOL_EXECUTORS = TOOL_EXECUTORS;
module.exports.TOOLS = TOOLS;
