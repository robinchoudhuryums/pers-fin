// ============================================================================
// Routes: Budget Tracking
// ============================================================================

const express = require("express");
const router = express.Router();
const { pool } = require("../services/database");
const { MODEL_MAP } = require("../data/reference-data");

let Anthropic;
try {
  Anthropic = require("@anthropic-ai/sdk").default || require("@anthropic-ai/sdk");
} catch {
  Anthropic = null;
}

// GET /api/budgets — list all budgets with current month spending
router.get("/api/budgets", async (_req, res) => {
  try {
    const [budgets, spending] = await Promise.all([
      pool.query("SELECT * FROM budgets ORDER BY monthly_limit DESC"),
      pool.query(
        `SELECT COALESCE(t.category[1], 'Uncategorized') AS category,
                ROUND(SUM(t.amount * COALESCE(la.spending_split_pct, 100) / 100.0), 2) AS spent
         FROM transactions t
         LEFT JOIN linked_accounts la ON la.account_id = t.account_id
         WHERE t.amount > 0 AND t.pending = false
           AND t.date >= date_trunc('month', CURRENT_DATE)
           AND t.date < date_trunc('month', CURRENT_DATE) + INTERVAL '1 month'
         GROUP BY COALESCE(t.category[1], 'Uncategorized')`
      ),
    ]);
    const spendMap = {};
    for (const r of spending.rows) spendMap[r.category] = parseFloat(r.spent);
    const result = budgets.rows.map(b => ({
      ...b,
      spent: spendMap[b.category] || 0,
      remaining: parseFloat(b.monthly_limit) - (spendMap[b.category] || 0),
      percent_used: parseFloat(b.monthly_limit) > 0
        ? Math.round(((spendMap[b.category] || 0) / parseFloat(b.monthly_limit)) * 100)
        : 0,
    }));
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: "An internal error occurred." });
  }
});

// POST /api/budgets — create or update a budget
router.post("/api/budgets", async (req, res) => {
  const { category, monthly_limit, notes } = req.body;
  if (!category || monthly_limit == null) return res.status(400).json({ error: "category and monthly_limit are required" });
  const parsedLimit = parseFloat(monthly_limit);
  if (isNaN(parsedLimit) || parsedLimit < 0) return res.status(400).json({ error: "monthly_limit must be a non-negative number" });
  try {
    const result = await pool.query(
      `INSERT INTO budgets (category, monthly_limit, notes)
       VALUES ($1, $2, $3)
       ON CONFLICT (category) DO UPDATE SET monthly_limit = $2, notes = $3, is_ai_suggested = false, updated_at = now()
       RETURNING *`,
      [category, parsedLimit, notes || null]
    );
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: "An internal error occurred." });
  }
});

// PATCH /api/budgets/:id — update a budget
router.patch("/api/budgets/:id", async (req, res) => {
  const { monthly_limit, notes } = req.body;
  const updates = []; const values = []; let idx = 1;
  if (monthly_limit !== undefined) { updates.push("monthly_limit = $" + idx++); values.push(parseFloat(monthly_limit)); }
  if (notes !== undefined) { updates.push("notes = $" + idx++); values.push(notes); }
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
    const [spendingData, settingsRow, existingBudgets] = await Promise.all([
      pool.query(
        `SELECT COALESCE(category[1], 'Uncategorized') AS category,
                TO_CHAR(date, 'YYYY-MM') AS month,
                SUM(amount) AS total,
                COUNT(*) AS txn_count
         FROM transactions
         WHERE amount > 0 AND pending = false
           AND date >= CURRENT_DATE - INTERVAL '3 months'
         GROUP BY COALESCE(category[1], 'Uncategorized'), TO_CHAR(date, 'YYYY-MM')
         ORDER BY category, month`
      ),
      pool.query("SELECT insights_model FROM user_settings WHERE id = 1").catch(() => ({ rows: [{ insights_model: "haiku" }] })),
      pool.query("SELECT category, monthly_limit FROM budgets"),
    ]);

    if (spendingData.rows.length === 0) {
      return res.status(400).json({ error: "Not enough transaction data. Sync some transactions first." });
    }

    // Group by category
    const categories = {};
    for (const r of spendingData.rows) {
      if (!categories[r.category]) categories[r.category] = [];
      categories[r.category].push({ month: r.month, total: parseFloat(r.total), txns: r.txn_count });
    }

    const existingMap = {};
    for (const b of existingBudgets.rows) existingMap[b.category] = parseFloat(b.monthly_limit);

    const catSummary = Object.entries(categories).map(([cat, months]) => {
      const avg = months.reduce((s, m) => s + m.total, 0) / months.length;
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
      input_schema: {
        type: "object",
        properties: {
          suggestions: {
            type: "array",
            items: {
              type: "object",
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

    const message = await client.messages.create({
      model: modelId, max_tokens: 1000,
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
      tool_choice: { type: "tool", name: "suggest_budgets" },
      messages: [{ role: "user", content: "Spending history (last 3 months):\n" + catSummary }],
    });

    // Extract structured output from tool_use block
    const toolBlock = message.content.find(b => b.type === "tool_use");
    if (!toolBlock || !toolBlock.input || !Array.isArray(toolBlock.input.suggestions)) {
      console.error("Budget AI did not return expected tool_use block");
      return res.status(500).json({ error: "AI returned unexpected format" });
    }
    let suggestions = toolBlock.input.suggestions.filter(s =>
      s && typeof s.category === "string" && typeof s.monthly_limit === "number" && s.monthly_limit >= 0
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
    const valid = budgets.filter(b => b.category && b.monthly_limit != null);
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
    const [budgets, spending] = await Promise.all([
      pool.query("SELECT * FROM budgets ORDER BY monthly_limit DESC"),
      pool.query(
        `SELECT COALESCE(t.category[1], 'Uncategorized') AS category,
                ROUND(SUM(t.amount * COALESCE(la.spending_split_pct, 100) / 100.0), 2) AS spent
         FROM transactions t
         LEFT JOIN linked_accounts la ON la.account_id = t.account_id
         WHERE t.amount > 0 AND t.pending = false
           AND t.date >= date_trunc('month', CURRENT_DATE)
           AND t.date < date_trunc('month', CURRENT_DATE) + INTERVAL '1 month'
         GROUP BY COALESCE(t.category[1], 'Uncategorized')`
      ),
    ]);

    const today = new Date();
    const daysInMonth = new Date(today.getFullYear(), today.getMonth() + 1, 0).getDate();
    const dayOfMonth = today.getDate();
    const daysRemaining = daysInMonth - dayOfMonth;
    const monthProgress = dayOfMonth / daysInMonth;

    const spendMap = {};
    for (const r of spending.rows) spendMap[r.category] = parseFloat(r.spent);

    const alerts = [];
    for (const b of budgets.rows) {
      const spent = spendMap[b.category] || 0;
      const limit = parseFloat(b.monthly_limit);
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

module.exports = router;
