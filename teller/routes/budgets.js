// ============================================================================
// Routes: Budget Tracking
// ============================================================================

const express = require("express");
const router = express.Router();
const { pool } = require("../services/database");
const { getCategorySpendingThisMonth, getCategorySpendingForMonth } = require("../services/financial-queries");
const { MODEL_MAP } = require("../data/reference-data");

let Anthropic;
try {
  Anthropic = require("@anthropic-ai/sdk").default || require("@anthropic-ai/sdk");
} catch {
  Anthropic = null;
}

// Current month key (YYYY-MM)
function currentMonthKey() {
  const d = new Date();
  return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0");
}

// Previous-month key for a given 'YYYY-MM'. The rollover that applies to
// month M is the unused budget from month M-1, which the snapshot job stores
// in the budget_snapshots row keyed by M-1 (prevMonth). Readers must look up
// the PRIOR month's snapshot, not the current month's (FA-1) — the current
// month's row either doesn't exist yet or holds this month's own (circular)
// underspend, so the carried-over amount was previously never applied.
function previousMonthKey(monthKey) {
  const [y, m] = monthKey.split("-").map(Number);
  const d = new Date(y, m - 1, 1); // first day of monthKey
  d.setMonth(d.getMonth() - 1);
  return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0");
}

// GET /api/budgets — list all budgets with current month spending
router.get("/api/budgets", async (req, res) => {
  const queryMonth = req.query.month || currentMonthKey();
  // Same validator as POST /api/budgets/snapshot — reject 9999-99 etc. so
  // getCategorySpendingForMonth doesn't 500 on a malformed date string.
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(queryMonth)) {
    return res.status(400).json({ error: "month must be 'YYYY-MM' with month 01-12" });
  }
  try {
    const [budgets, spending, snapshots] = await Promise.all([
      pool.query("SELECT * FROM budgets ORDER BY monthly_limit DESC"),
      // Pull spending FOR the queried month so ?month=YYYY-MM compares the right
      // numbers — the previous helper always returned the current month, which
      // gave nonsense data when callers asked for a historical month.
      getCategorySpendingForMonth(pool, queryMonth),
      // Rollover for queryMonth comes from the PRIOR month's snapshot (FA-1).
      pool.query("SELECT * FROM budget_snapshots WHERE month = $1", [previousMonthKey(queryMonth)]),
    ]);
    const spendMap = {};
    for (const r of spending) spendMap[r.category] = parseFloat(r.spent);
    const snapMap = {};
    for (const s of snapshots.rows) snapMap[s.budget_id] = s;

    const result = budgets.rows.map(b => {
      const spent = spendMap[b.category] || 0;
      const limit = parseFloat(b.monthly_limit);
      // If rollover is enabled and there's a snapshot, add rollover to effective limit
      const snap = snapMap[b.id];
      const rollover = (b.rollover_enabled && snap) ? parseFloat(snap.rollover_amount || 0) : 0;
      const effectiveLimit = limit + rollover;
      // One-time budgets only apply to their effective_month
      if (b.budget_type === "one_time" && b.effective_month && b.effective_month !== queryMonth) {
        return null; // Don't show one-time budgets for other months
      }
      return {
        ...b,
        spent,
        remaining: effectiveLimit - spent,
        percent_used: effectiveLimit > 0
          ? Math.round((spent / effectiveLimit) * 100) : 0,
        rollover_amount: rollover,
        effective_limit: effectiveLimit,
      };
    }).filter(Boolean);
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
  if (monthly_limit !== undefined) { updates.push("monthly_limit = $" + idx++); values.push(parseFloat(monthly_limit)); }
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
    // Pull the trailing 3 months of per-category spend through the SAME helper
    // GET /api/budgets uses, so suggestions are measured against the split-
    // adjusted, reimbursed-excluded, transfer-filtered, spending_split_pct-aware
    // numbers the user later sees as "spent" — not a raw SUM(amount) that
    // includes transfers/credit-card payments and over-counts shared cards (F11).
    const monthKeys = [0, 1, 2].map(i => {
      const d = new Date();
      d.setMonth(d.getMonth() - i);
      return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0");
    });
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
    const month = currentMonthKey();
    const [budgets, spending, snapshots] = await Promise.all([
      pool.query("SELECT * FROM budgets ORDER BY monthly_limit DESC"),
      getCategorySpendingThisMonth(pool), // Phase B3: honors splits
      // Rollover applied to this month is the prior month's unused budget (FA-1).
      pool.query("SELECT budget_id, rollover_amount FROM budget_snapshots WHERE month = $1", [previousMonthKey(month)]),
    ]);

    const today = new Date();
    const daysInMonth = new Date(today.getFullYear(), today.getMonth() + 1, 0).getDate();
    const dayOfMonth = today.getDate();
    const daysRemaining = daysInMonth - dayOfMonth;
    const monthProgress = dayOfMonth / daysInMonth;

    const spendMap = {};
    for (const r of spending) spendMap[r.category] = parseFloat(r.spent);
    const snapMap = {};
    for (const s of snapshots.rows) snapMap[s.budget_id] = s;

    const alerts = [];
    for (const b of budgets.rows) {
      // One-time budgets only apply to their effective month — don't alert on a
      // past vacation budget every month (mirrors GET /api/budgets) (F18).
      if (b.budget_type === "one_time" && b.effective_month && b.effective_month !== month) continue;
      const spent = spendMap[b.category] || 0;
      // Compare against the effective limit (base + this month's rollover), the
      // same number GET /api/budgets shows — not the bare monthly_limit (F18).
      const snap = snapMap[b.id];
      const rollover = (b.rollover_enabled && snap) ? parseFloat(snap.rollover_amount || 0) : 0;
      const limit = parseFloat(b.monthly_limit) + rollover;
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
    const [budgets, spending] = await Promise.all([
      pool.query("SELECT * FROM budgets"),
      // Snapshot the spending IN the requested month, not always-this-month.
      getCategorySpendingForMonth(pool, month),
    ]);
    const spendMap = {};
    for (const r of spending) spendMap[r.category] = parseFloat(r.spent);

    let created = 0;
    for (const b of budgets.rows) {
      const spent = spendMap[b.category] || 0;
      const limit = parseFloat(b.monthly_limit);
      const rollover = b.rollover_enabled ? Math.max(0, limit - spent) : 0;

      await pool.query(
        `INSERT INTO budget_snapshots (budget_id, month, monthly_limit, spent, rollover_amount)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (budget_id, month) DO UPDATE SET
           monthly_limit = $3, spent = $4, rollover_amount = $5`,
        [b.id, month, limit, spent, rollover]
      );
      created++;
    }
    res.json({ snapshots_created: created, month });
  } catch (err) {
    console.error("budget snapshot error:", err.message);
    res.status(500).json({ error: "An internal error occurred." });
  }
});

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
