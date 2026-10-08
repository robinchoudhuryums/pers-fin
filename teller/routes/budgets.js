// ============================================================================
// Routes: Budget Tracking
// ============================================================================

const express = require("express");
const router = express.Router();
const { pool } = require("../services/database");
const { getCategorySpendingForMonth, getBudgetStatus, previousMonthKey, currentMonth, todayStr } = require("../services/financial-queries");
const { MODEL_MAP } = require("../data/reference-data");

let Anthropic;
try {
  Anthropic = require("@anthropic-ai/sdk").default || require("@anthropic-ai/sdk");
} catch {
  Anthropic = null;
}

// Current month key (YYYY-MM), tz-aware (APP_TIMEZONE; default UTC) so the
// "this month" budget figures honor the operator's wall-clock month (F11).
function currentMonthKey() {
  return currentMonth();
}

// previousMonthKey (services/financial-queries.js): the rollover that applies
// to month M is the unused budget from month M-1, stored in the budget_snapshots
// row keyed by M-1. Readers look up the PRIOR month's snapshot (FA-1) — via the
// shared getBudgetStatus, which every budget-status reader now uses (AIN-6).

const MONTH_KEY_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

// GET /api/budgets — list all budgets with current month spending
router.get("/api/budgets", async (req, res) => {
  const queryMonth = req.query.month || currentMonthKey();
  // Same validator as POST /api/budgets/snapshot — reject 9999-99 etc. so
  // getCategorySpendingForMonth doesn't 500 on a malformed date string.
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(queryMonth)) {
    return res.status(400).json({ error: "month must be 'YYYY-MM' with month 01-12" });
  }
  try {
    // Shared helper: spending FOR the queried month, rollover from the PRIOR
    // month's snapshot (FA-1), one-time budgets only in their effective_month.
    const result = await getBudgetStatus(pool, queryMonth);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: "An internal error occurred." });
  }
});

// POST /api/budgets — create or update a budget
router.post("/api/budgets", async (req, res) => {
  const { category, monthly_limit, notes, rollover_enabled, budget_type, effective_month } = req.body;
  if (!category || monthly_limit == null) return res.status(400).json({ error: "category and monthly_limit are required" });
  const parsedLimit = parseFloat(monthly_limit);
  if (isNaN(parsedLimit) || parsedLimit < 0) return res.status(400).json({ error: "monthly_limit must be a non-negative number" });
  const validTypes = ["recurring", "one_time"];
  const type = validTypes.includes(budget_type) ? budget_type : "recurring";
  try {
    const result = await pool.query(
      `INSERT INTO budgets (category, monthly_limit, notes, rollover_enabled, budget_type, effective_month)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (category) DO UPDATE SET monthly_limit = $2, notes = $3, is_ai_suggested = false,
         rollover_enabled = $4, budget_type = $5, effective_month = $6, updated_at = now()
       RETURNING *`,
      [category, parsedLimit, notes || null, !!rollover_enabled, type, type === "one_time" ? (effective_month || currentMonthKey()) : null]
    );
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: "An internal error occurred." });
  }
});

// PATCH /api/budgets/:id — update a budget
router.patch("/api/budgets/:id", async (req, res) => {
  const { monthly_limit, notes, rollover_enabled, budget_type, effective_month } = req.body;
  const updates = []; const values = []; let idx = 1;
  // Same validation as POST (FAN-14): a non-numeric limit used to be stored as
  // NaN (NUMERIC accepts 'NaN'), negatives were accepted, and a malformed
  // effective_month ("2026-9") meant a one-time budget never matched any month.
  if (monthly_limit !== undefined) {
    const n = parseFloat(monthly_limit);
    if (!Number.isFinite(n) || n < 0) return res.status(400).json({ error: "monthly_limit must be a non-negative number" });
    updates.push("monthly_limit = $" + idx++); values.push(n);
  }
  if (budget_type !== undefined && !["recurring", "one_time"].includes(budget_type)) {
    return res.status(400).json({ error: "budget_type must be 'recurring' or 'one_time'" });
  }
  if (effective_month !== undefined && effective_month !== null && effective_month !== "" && !MONTH_KEY_RE.test(String(effective_month))) {
    return res.status(400).json({ error: "effective_month must be 'YYYY-MM' with month 01-12" });
  }
  if (notes !== undefined) { updates.push("notes = $" + idx++); values.push(notes); }
  if (rollover_enabled !== undefined) { updates.push("rollover_enabled = $" + idx++); values.push(!!rollover_enabled); }
  if (budget_type !== undefined && ["recurring", "one_time"].includes(budget_type)) {
    updates.push("budget_type = $" + idx++); values.push(budget_type);
  }
  if (effective_month !== undefined) { updates.push("effective_month = $" + idx++); values.push(effective_month || null); }
  if (!updates.length) return res.status(400).json({ error: "No valid fields" });
  updates.push("is_ai_suggested = false", "updated_at = now()");
  values.push(req.params.id);
  try {
    const result = await pool.query(
      "UPDATE budgets SET " + updates.join(", ") + " WHERE id = $" + idx + " RETURNING *",
      values
    );
    if (!result.rows.length) return res.status(404).json({ error: "Not found" });
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: "An internal error occurred." });
  }
});

// DELETE /api/budgets/:id
router.delete("/api/budgets/:id", async (req, res) => {
  try {
    await pool.query("DELETE FROM budgets WHERE id = $1", [req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: "An internal error occurred." });
  }
});

// POST /api/budgets/suggest — AI-suggested budgets based on spending history
router.post("/api/budgets/suggest", async (_req, res) => {
  if (!Anthropic || !process.env.ANTHROPIC_API_KEY) {
    return res.status(501).json({ error: "Set ANTHROPIC_API_KEY to enable AI budget suggestions." });
  }
  try {
    // Shared monthly AI cap (INV-14, AIN-10): this call used to be uncapped
    // and uncharged — past the cap every "Suggest budgets" click still spent
    // (on the user's model, possibly Opus) and never showed up in usage.
    const { getAiBudgetCents, monthAiSpendCents } = require("./insights");
    const budgetCents = await getAiBudgetCents();
    if ((await monthAiSpendCents(pool)) >= budgetCents) {
      return res.status(429).json({ error: `Monthly AI budget reached ($${(budgetCents / 100).toFixed(2)} cap). Raise it under Settings → AI Insights.` });
    }

    // Pull the trailing 3 months of per-category spend through the SAME helper
    // GET /api/budgets uses, so suggestions are measured against the split-
    // adjusted, reimbursed-excluded, transfer-filtered, spending_split_pct-aware
    // numbers the user later sees as "spent" — not a raw SUM(amount) that
    // includes transfers/credit-card payments and over-counts shared cards (F11).
    // The three most recent COMPLETE months (FAN-8): the partial current
    // month dragged the average down (on the 3rd, $20 of dining averaged in
    // with two $600 months → a ~$350 suggestion). String month math anchored
    // on the tz-aware currentMonth() — no Date overflow on the 29th-31st (F3).
    const monthKeys = [];
    let mk = currentMonthKey();
    for (let i = 0; i < 3; i++) { mk = previousMonthKey(mk); monthKeys.push(mk); }
    const [perMonthSpending, settingsRow, existingBudgets] = await Promise.all([
      Promise.all(monthKeys.map(m => getCategorySpendingForMonth(pool, m))),
      pool.query("SELECT insights_model FROM user_settings WHERE id = 1").catch(() => ({ rows: [{ insights_model: "haiku" }] })),
      pool.query("SELECT category, monthly_limit FROM budgets"),
    ]);

    // Group by category → array of monthly totals (only months the category appears in)
    const categories = {};
    for (const monthRows of perMonthSpending) {
      for (const r of monthRows) {
        if (!categories[r.category]) categories[r.category] = [];
        categories[r.category].push(parseFloat(r.spent));
      }
    }

    if (Object.keys(categories).length === 0) {
      return res.status(400).json({ error: "Not enough transaction data. Sync some transactions first." });
    }

    const existingMap = {};
    for (const b of existingBudgets.rows) existingMap[b.category] = parseFloat(b.monthly_limit);

    const catSummary = Object.entries(categories).map(([cat, totals]) => {
      const avg = totals.reduce((s, t) => s + t, 0) / totals.length;
      const months = totals; // alias kept for the message below
      const existing = existingMap[cat];
      return cat + ": avg $" + avg.toFixed(2) + "/mo over " + months.length + " months" +
        (existing ? " (current budget: $" + existing.toFixed(2) + ")" : "");
    }).join("\n");

    const modelId = MODEL_MAP[settingsRow.rows[0]?.insights_model] || MODEL_MAP.haiku;
    const client = new Anthropic();

    // Use tool_use for structured output — guarantees valid JSON schema
    const suggestTool = {
      name: "suggest_budgets",
      description: "Suggest monthly budgets for spending categories",
      strict: true, // schema-valid input (tool_choice is "auto" on the 5.5 models)
      input_schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          suggestions: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                category: { type: "string" },
                monthly_limit: { type: "number" },
                notes: { type: "string" },
              },
              required: ["category", "monthly_limit", "notes"],
            },
          },
        },
        required: ["suggestions"],
      },
    };

    const { createToolCall, effortParams } = require("../services/claude");
    const message = await createToolCall(client, {
      model: modelId, max_tokens: 4000,
      ...effortParams("extract"),
      system: [{ type: "text", text:
        "You are a personal finance advisor. Based on the user's spending history by category, " +
        "suggest reasonable monthly budgets for each category.\n\n" +
        "Rules:\n" +
        "- For essential categories (food, utilities, transportation), suggest budgets close to or slightly above the average\n" +
        "- For discretionary categories (entertainment, shopping, dining), suggest budgets 10-20% below the average to encourage savings\n" +
        "- Round to the nearest $5 or $10 for cleanliness\n" +
        "- Skip categories with very low spending (<$10/mo avg)\n\n" +
        "Use the suggest_budgets tool to return your results.",
        cache_control: { type: "ephemeral" },
      }],
      tools: [suggestTool],
      messages: [{ role: "user", content: "Spending history (last 3 complete months):\n" + catSummary }],
    }, "suggest_budgets");

    // Charge the cap BEFORE any validation early-return, so a malformed reply
    // still counts the tokens it consumed (parity with rebuild, AIA2).
    const usage = message.usage || {};
    await pool.query(
      `INSERT INTO financial_insights
         (insight_text, model_used, tokens_used, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, entry_type)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'suggest')`,
      ["[Suggest] budget suggestions", modelId,
        (usage.input_tokens || 0) + (usage.output_tokens || 0),
        usage.input_tokens || 0, usage.output_tokens || 0,
        usage.cache_read_input_tokens || 0, usage.cache_creation_input_tokens || 0]
    ).catch((e) => console.error("Budget suggest usage-row write failed:", e.message));

    // Extract structured output from tool_use block
    const toolBlock = message.content.find(b => b.type === "tool_use");
    if (!toolBlock || !toolBlock.input || !Array.isArray(toolBlock.input.suggestions)) {
      console.error("Budget AI did not return expected tool_use block");
      return res.status(500).json({ error: "AI returned unexpected format" });
    }
    let suggestions = toolBlock.input.suggestions.filter(s =>
      s && typeof s.category === "string" && typeof s.monthly_limit === "number"
      && s.monthly_limit >= 0 && s.monthly_limit <= 100000 && isFinite(s.monthly_limit)
    );

    res.json({ suggestions, tokens_used: (message.usage?.input_tokens || 0) + (message.usage?.output_tokens || 0) });
  } catch (err) {
    console.error("Budget suggest error:", err.message);
    res.status(500).json({ error: "An internal error occurred." });
  }
});

// POST /api/budgets/accept — accept AI-suggested budgets (bulk upsert)
router.post("/api/budgets/accept", async (req, res) => {
  const { budgets } = req.body;
  if (!Array.isArray(budgets) || budgets.length === 0) {
    return res.status(400).json({ error: "budgets array is required" });
  }
  try {
    // Validate monthly_limit (parity with POST /api/budgets + /suggest): finite,
    // non-negative, bounded — so a tampered/malformed array can't persist a
    // negative/NaN/absurd limit that yields a negative effective_limit and
    // nonsensical alert math downstream (F21).
    const valid = budgets.filter(b => {
      if (!b.category || b.monthly_limit == null) return false;
      const n = parseFloat(b.monthly_limit);
      return Number.isFinite(n) && n >= 0 && n <= 100000;
    });
    if (valid.length === 0) return res.status(400).json({ error: "No valid budgets in array" });

    // Build batch upsert
    const placeholders = [];
    const values = [];
    let idx = 1;
    for (const b of valid) {
      placeholders.push(`($${idx++}, $${idx++}, true, $${idx++})`);
      values.push(b.category, parseFloat(b.monthly_limit), b.notes || null);
    }
    const result = await pool.query(
      `INSERT INTO budgets (category, monthly_limit, is_ai_suggested, notes)
       VALUES ${placeholders.join(", ")}
       ON CONFLICT (category) DO UPDATE SET monthly_limit = EXCLUDED.monthly_limit, is_ai_suggested = true, notes = EXCLUDED.notes, updated_at = now()
       RETURNING *`,
      values
    );
    res.json({ accepted: result.rows.length, budgets: result.rows });
  } catch (err) {
    res.status(500).json({ error: "An internal error occurred." });
  }
});

// GET /api/budgets/alerts — Spending velocity / pacing warnings
router.get("/api/budgets/alerts", async (_req, res) => {
  try {
    const month = currentMonthKey();
    const budgets = await getBudgetStatus(pool, month);

    // Day math in APP_TIMEZONE (FAN-13): the month comes from currentMonth(),
    // so the day-of-month must too — server `new Date()` (UTC) on the evening
    // of the 30th in Los Angeles read "day 1 of next month" against this
    // month's spending ("30 days left", pacing disabled).
    const today = todayStr();
    const [ty, tm] = month.split("-").map(Number);
    const daysInMonth = new Date(Date.UTC(ty, tm, 0)).getUTCDate();
    const dayOfMonth = parseInt(today.slice(8, 10), 10);
    const daysRemaining = daysInMonth - dayOfMonth;
    const monthProgress = dayOfMonth / daysInMonth;

    const alerts = [];
    // getBudgetStatus already drops one-time budgets outside this month (F18)
    // and compares against the effective limit (base + prior-month rollover).
    for (const b of budgets) {
      const spent = b.spent;
      const limit = b.effective_limit;
      const pctUsed = limit > 0 ? (spent / limit) * 100 : 0;
      // Don't calculate pace for the first few days — too unreliable with little data
      const pace = monthProgress >= 0.1 ? pctUsed / (monthProgress * 100) : 0;

      if (pctUsed >= 100) {
        alerts.push({
          category: b.category,
          type: "over_budget",
          severity: "critical",
          message: `${b.category}: Over budget by $${(spent - limit).toFixed(2)}`,
          spent: Math.round(spent * 100) / 100,
          limit: Math.round(limit * 100) / 100,
          percent_used: Math.round(pctUsed),
          days_remaining: daysRemaining,
        });
      } else if (pctUsed >= 80) {
        alerts.push({
          category: b.category,
          type: "approaching_limit",
          severity: "warning",
          message: `${b.category}: ${Math.round(pctUsed)}% spent with ${daysRemaining} days left`,
          spent: Math.round(spent * 100) / 100,
          limit: Math.round(limit * 100) / 100,
          percent_used: Math.round(pctUsed),
          days_remaining: daysRemaining,
          daily_budget_remaining: daysRemaining > 0 ? Math.round((limit - spent) / daysRemaining * 100) / 100 : 0,
        });
      } else if (pace > 1.2 && pctUsed >= 50) {
        alerts.push({
          category: b.category,
          type: "fast_pace",
          severity: "info",
          message: `${b.category}: Spending faster than budget pace (${Math.round(pctUsed)}% used at ${Math.round(monthProgress * 100)}% through month)`,
          spent: Math.round(spent * 100) / 100,
          limit: Math.round(limit * 100) / 100,
          percent_used: Math.round(pctUsed),
          pace: Math.round(pace * 100) / 100,
          projected_total: Math.round(spent / monthProgress * 100) / 100,
        });
      }
    }

    alerts.sort((a, b) => {
      const sev = { critical: 0, warning: 1, info: 2 };
      return (sev[a.severity] || 3) - (sev[b.severity] || 3);
    });

    res.json({
      alerts,
      month_progress: Math.round(monthProgress * 10000) / 100,
      days_remaining: daysRemaining,
      day_of_month: dayOfMonth,
      days_in_month: daysInMonth,
    });
  } catch (err) {
    console.error("budget alerts error:", err.message);
    res.status(500).json({ error: "An internal error occurred." });
  }
});

// POST /api/budgets/snapshot — create monthly snapshot and compute rollovers
// Typically called at month-end (or auto-triggered by scheduler).
router.post("/api/budgets/snapshot", async (req, res) => {
  const month = req.body.month || currentMonthKey();
  // Reject '9999-99' and other shape-valid-but-impossible months;
  // getCategorySpendingForMonth would otherwise build a malformed date string.
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) {
    return res.status(400).json({ error: "month must be 'YYYY-MM' with month 01-12" });
  }
  try {
    const created = await writeBudgetSnapshot(pool, month, { overwrite: true });
    res.json({ snapshots_created: created, month });
  } catch (err) {
    console.error("budget snapshot error:", err.message);
    res.status(500).json({ error: "An internal error occurred." });
  }
});

// Snapshot a month's spending + rollover for every budget. `overwrite` = DO
// UPDATE (refresh) vs DO NOTHING (create-if-missing). Returns rows written.
async function writeBudgetSnapshot(db, month, { overwrite }) {
  const [budgets, spending] = await Promise.all([
    db.query("SELECT * FROM budgets"),
    // Snapshot the spending IN the requested month, not always-this-month.
    getCategorySpendingForMonth(db, month),
  ]);
  const spendMap = {};
  for (const r of spending) spendMap[r.category] = parseFloat(r.spent);
  let written = 0;
  for (const b of budgets.rows) {
    const spent = spendMap[b.category] || 0;
    const limit = parseFloat(b.monthly_limit);
    const rollover = b.rollover_enabled ? Math.max(0, limit - spent) : 0;
    const r = await db.query(
      `INSERT INTO budget_snapshots (budget_id, month, monthly_limit, spent, rollover_amount)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (budget_id, month) ${overwrite ? "DO UPDATE SET monthly_limit = $3, spent = $4, rollover_amount = $5" : "DO NOTHING"}`,
      [b.id, month, limit, spent, rollover]
    );
    written += r.rowCount || 0;
  }
  return written;
}

// Days into a month during which the scheduled snapshot of the PRIOR month is
// re-taken (FAN-7): charges dated the 29th–31st commonly post/sync on the 1st–
// 3rd, so a snapshot frozen on the first tick after midnight lost them forever
// (a $500 budget with $480 real spend snapshotted $420 and carried $80, not $20).
const SNAPSHOT_REFRESH_DAYS = 5;

// Scheduled prior-month snapshot (startup.js, every 6h). Months and days are
// APP_TIMEZONE-anchored (FAN-13 — the job used UTC month keys while spending
// used the tz month). Days 1..SNAPSHOT_REFRESH_DAYS: refresh (DO UPDATE) so
// late-posting charges land; afterwards: create-if-missing only (the M5
// catch-up for a month whose snapshot was never taken).
async function runBudgetSnapshot(db = pool, today = todayStr()) {
  const prevMonth = previousMonthKey(today.slice(0, 7));
  const refresh = parseInt(today.slice(8, 10), 10) <= SNAPSHOT_REFRESH_DAYS;
  if (!refresh) {
    const existing = await db.query("SELECT 1 FROM budget_snapshots WHERE month = $1 LIMIT 1", [prevMonth]);
    if (existing.rows.length > 0) return { month: prevMonth, mode: "exists", written: 0 };
  }
  const written = await writeBudgetSnapshot(db, prevMonth, { overwrite: refresh });
  return { month: prevMonth, mode: refresh ? "refresh" : "catch_up", written };
}

// GET /api/budgets/history — get budget snapshots for trend analysis
router.get("/api/budgets/history", async (req, res) => {
  const months = Math.max(1, Math.min(parseInt(req.query.months) || 6, 24));
  try {
    const result = await pool.query(
      `SELECT bs.*, b.category FROM budget_snapshots bs
       JOIN budgets b ON b.id = bs.budget_id
       WHERE bs.month >= TO_CHAR(CURRENT_DATE - make_interval(months => $1), 'YYYY-MM')
       ORDER BY bs.month DESC, b.category`,
      [months]
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: "An internal error occurred." });
  }
});

module.exports = router;
// Exported for unit testing the rollover month-keying (FA-1). Attached AFTER
// `module.exports = router` so the router assignment doesn't drop it (INV-19).
module.exports.previousMonthKey = previousMonthKey;
module.exports.runBudgetSnapshot = runBudgetSnapshot;
module.exports.SNAPSHOT_REFRESH_DAYS = SNAPSHOT_REFRESH_DAYS;
