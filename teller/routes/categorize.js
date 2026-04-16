// ============================================================================
// Routes: ML Transaction Categorization (Claude-powered)
// ============================================================================

const express = require("express");
const router = express.Router();
const { pool } = require("../services/database");
const { MODEL_MAP, estimateCostUsd } = require("../data/reference-data");

let Anthropic;
try {
  Anthropic = require("@anthropic-ai/sdk").default || require("@anthropic-ai/sdk");
} catch {
  Anthropic = null;
}

// Standard categories for classification
const CATEGORIES = [
  "Food & Drink", "Groceries", "Transportation", "Gas & Fuel",
  "Shopping", "Entertainment", "Health & Fitness", "Healthcare",
  "Housing", "Utilities", "Insurance", "Education",
  "Travel", "Personal Care", "Gifts & Donations", "Fees & Charges",
  "Transfer", "Income", "Investment", "Subscription",
  "Other",
];

// GET /api/categorize/status — how many uncategorized transactions exist
router.get("/api/categorize/status", async (_req, res) => {
  try {
    const result = await pool.query(
      `SELECT COUNT(*) AS uncategorized
       FROM transactions
       WHERE (category IS NULL OR category = '{}' OR category[1] = 'Uncategorized')
         AND pending = false AND amount > 0`
    );
    res.json({
      uncategorized: parseInt(result.rows[0].uncategorized),
      ai_available: !!(Anthropic && process.env.ANTHROPIC_API_KEY),
    });
  } catch (err) {
    res.status(500).json({ error: "An internal error occurred." });
  }
});

// POST /api/categorize — batch-categorize uncategorized transactions using Claude
router.post("/api/categorize", async (_req, res) => {
  if (!Anthropic || !process.env.ANTHROPIC_API_KEY) {
    return res.status(501).json({ error: "Set ANTHROPIC_API_KEY to enable ML categorization." });
  }
  try {
    // Get uncategorized transactions in batches of 50
    const result = await pool.query(
      `SELECT transaction_id, COALESCE(merchant_name, name) AS merchant, amount, date
       FROM transactions
       WHERE (category IS NULL OR category = '{}' OR category[1] = 'Uncategorized')
         AND pending = false AND amount > 0
       ORDER BY date DESC
       LIMIT 50`
    );

    if (result.rows.length === 0) {
      return res.json({ categorized: 0, message: "No uncategorized transactions found." });
    }

    // Apply user-defined categorization rules first (cheaper than AI)
    const rules = await pool.query(
      "SELECT * FROM categorization_rules WHERE is_active = true ORDER BY times_applied DESC"
    ).catch(() => ({ rows: [] }));
    let ruleApplied = 0;
    const remaining = [];
    for (const txn of result.rows) {
      const merchant = (txn.merchant || "").toLowerCase();
      let matched = false;
      for (const rule of rules.rows) {
        const pattern = rule.merchant_pattern.toLowerCase();
        const isMatch = rule.match_type === "exact" ? merchant === pattern
          : rule.match_type === "starts_with" ? merchant.startsWith(pattern)
          : merchant.includes(pattern);
        if (isMatch) {
          await pool.query(
            "UPDATE transactions SET category = $1 WHERE transaction_id = $2",
            [`{${rule.category}}`, txn.transaction_id]
          );
          await pool.query(
            "UPDATE categorization_rules SET times_applied = times_applied + 1, updated_at = now() WHERE id = $1",
            [rule.id]
          );
          ruleApplied++;
          matched = true;
          break;
        }
      }
      if (!matched) remaining.push(txn);
    }

    // If all were handled by rules, return early (no AI cost)
    if (remaining.length === 0) {
      const leftover = await pool.query(
        `SELECT COUNT(*) AS uncategorized FROM transactions
         WHERE (category IS NULL OR category = '{}' OR category[1] = 'Uncategorized')
           AND pending = false AND amount > 0`
      );
      return res.json({
        categorized: ruleApplied,
        categorized_by_rules: ruleApplied,
        tokens_used: 0,
        remaining: parseInt(leftover.rows[0].uncategorized),
        estimated_cost: 0,
      });
    }

    const settingsRow = await pool.query(
      "SELECT insights_model FROM user_settings WHERE id = 1"
    ).catch(() => ({ rows: [{ insights_model: "haiku" }] }));

    // Use user's preferred model for categorization (default haiku — cheaper)
    const userModel = settingsRow.rows[0]?.insights_model || "haiku";
    const modelId = MODEL_MAP[userModel] || MODEL_MAP.haiku;

    const txnList = remaining.map((t, i) =>
      (i + 1) + ". " + t.merchant + " — $" + parseFloat(t.amount).toFixed(2) + " on " + t.date
    ).join("\n");

    const client = new Anthropic();

    // Use tool_use for structured output — guarantees valid JSON schema
    const categorizeTool = {
      name: "categorize_transactions",
      description: "Assign a category to each transaction",
      input_schema: {
        type: "object",
        properties: {
          categories: {
            type: "array",
            items: {
              type: "object",
              properties: {
                index: { type: "number", description: "1-based transaction index" },
                category: { type: "string", enum: CATEGORIES },
              },
              required: ["index", "category"],
            },
          },
        },
        required: ["categories"],
      },
    };

    const message = await client.messages.create({
      model: modelId, max_tokens: 2000,
      system: [{ type: "text", text:
        "Categorize each transaction into exactly one category. Use the categorize_transactions tool to return your results.",
        cache_control: { type: "ephemeral" },
      }],
      tools: [categorizeTool],
      tool_choice: { type: "tool", name: "categorize_transactions" },
      messages: [{ role: "user", content: "Transactions:\n" + txnList }],
    });

    const tokensUsed = (message.usage?.input_tokens || 0) + (message.usage?.output_tokens || 0);

    // Extract structured output from tool_use block
    const toolBlock = message.content.find(b => b.type === "tool_use");
    if (!toolBlock || !toolBlock.input || !Array.isArray(toolBlock.input.categories)) {
      console.error("AI did not return expected tool_use block");
      return res.status(500).json({ error: "AI returned unexpected format" });
    }
    const categories = toolBlock.input.categories;

    // Apply categories to transactions
    let updated = 0;
    for (const cat of categories) {
      if (!cat || typeof cat.index !== "number" || typeof cat.category !== "string") continue;
      const idx = cat.index - 1;
      if (idx < 0 || idx >= remaining.length) continue;
      if (!CATEGORIES.includes(cat.category)) continue;
      const txn = remaining[idx];
      await pool.query(
        "UPDATE transactions SET category = $1 WHERE transaction_id = $2",
        [`{${cat.category}}`, txn.transaction_id]
      );
      updated++;
    }

    // Track cost in insights table for usage monitoring
    await pool.query(
      "INSERT INTO financial_insights (insight_text, model_used, tokens_used) VALUES ($1, $2, $3)",
      ["[ML Categorization] Categorized " + updated + " transactions", message.model || modelId, tokensUsed]
    ).catch(() => {});

    const leftoverCount = await pool.query(
      `SELECT COUNT(*) AS uncategorized FROM transactions
       WHERE (category IS NULL OR category = '{}' OR category[1] = 'Uncategorized')
         AND pending = false AND amount > 0`
    );
    res.json({
      categorized: updated + ruleApplied,
      categorized_by_rules: ruleApplied,
      categorized_by_ai: updated,
      tokens_used: tokensUsed,
      remaining: parseInt(leftoverCount.rows[0].uncategorized),
      estimated_cost: parseFloat(estimateCostUsd(tokensUsed, modelId).toFixed(4)),
    });
  } catch (err) {
    console.error("Categorize error:", err.message);
    res.status(500).json({ error: "An internal error occurred." });
  }
});

// PATCH /api/transactions/:id/category — manually set a transaction's category
router.patch("/api/transactions/:id/category", async (req, res) => {
  const { category } = req.body;
  if (!category) return res.status(400).json({ error: "category is required" });
  if (!CATEGORIES.includes(category)) return res.status(400).json({ error: `Invalid category. Must be one of: ${CATEGORIES.join(", ")}` });
  try {
    const result = await pool.query(
      "UPDATE transactions SET category = $1 WHERE transaction_id = $2 RETURNING transaction_id, category",
      [`{${category}}`, req.params.id]
    );
    if (!result.rows.length) return res.status(404).json({ error: "Transaction not found" });
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: "An internal error occurred." });
  }
});

// PATCH /api/transactions/bulk-category — Bulk update categories
router.patch("/api/transactions/bulk-category", async (req, res) => {
  const { transaction_ids, category } = req.body;
  if (!Array.isArray(transaction_ids) || !transaction_ids.length || !category) {
    return res.status(400).json({ error: "transaction_ids array and category are required" });
  }
  // Validate against the whitelist so user input can't slip unexpected strings
  // into the Postgres array literal `{<value>}`. Matches the single-PATCH guard
  // at the endpoint above.
  if (!CATEGORIES.includes(category)) {
    return res.status(400).json({ error: `Invalid category. Must be one of: ${CATEGORIES.join(", ")}` });
  }
  if (transaction_ids.length > 200) {
    return res.status(400).json({ error: "Maximum 200 transactions per batch" });
  }
  try {
    const result = await pool.query(
      `UPDATE transactions SET category = $1 WHERE transaction_id = ANY($2) RETURNING transaction_id`,
      [`{${category}}`, transaction_ids]
    );
    res.json({ updated: result.rowCount });
  } catch (err) {
    console.error("bulk category error:", err.message);
    res.status(500).json({ error: "An internal error occurred." });
  }
});

// ============================================================================
// Categorization Rules Engine — persistent merchant→category rules
// ============================================================================

// GET /api/categorization-rules — list all rules
router.get("/api/categorization-rules", async (_req, res) => {
  try {
    const result = await pool.query(
      "SELECT * FROM categorization_rules ORDER BY times_applied DESC, created_at DESC"
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: "An internal error occurred." });
  }
});

// POST /api/categorization-rules — create a rule
router.post("/api/categorization-rules", async (req, res) => {
  const { merchant_pattern, category, match_type } = req.body;
  if (!merchant_pattern || !category) {
    return res.status(400).json({ error: "merchant_pattern and category are required" });
  }
  if (!CATEGORIES.includes(category)) {
    return res.status(400).json({ error: `Invalid category. Must be one of: ${CATEGORIES.join(", ")}` });
  }
  const validTypes = ["contains", "exact", "starts_with"];
  const type = validTypes.includes(match_type) ? match_type : "contains";
  try {
    const result = await pool.query(
      `INSERT INTO categorization_rules (merchant_pattern, category, match_type)
       VALUES ($1, $2, $3)
       ON CONFLICT (merchant_pattern, category) DO UPDATE SET
         match_type = $3, is_active = true, updated_at = now()
       RETURNING *`,
      [merchant_pattern.trim(), category, type]
    );
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: "An internal error occurred." });
  }
});

// DELETE /api/categorization-rules/:id — delete a rule
router.delete("/api/categorization-rules/:id", async (req, res) => {
  try {
    await pool.query("DELETE FROM categorization_rules WHERE id = $1", [req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: "An internal error occurred." });
  }
});

// POST /api/categorization-rules/apply — apply all active rules to uncategorized transactions
router.post("/api/categorization-rules/apply", async (_req, res) => {
  try {
    const rules = await pool.query(
      "SELECT * FROM categorization_rules WHERE is_active = true ORDER BY times_applied DESC"
    );
    if (rules.rows.length === 0) {
      return res.json({ applied: 0, message: "No active rules." });
    }
    let totalApplied = 0;
    for (const rule of rules.rows) {
      const pattern = rule.merchant_pattern;
      let condition;
      if (rule.match_type === "exact") {
        condition = "LOWER(COALESCE(t.user_merchant_name, t.merchant_name, t.name, '')) = LOWER($1)";
      } else if (rule.match_type === "starts_with") {
        condition = "LOWER(COALESCE(t.user_merchant_name, t.merchant_name, t.name, '')) LIKE LOWER($1) || '%'";
      } else {
        condition = "LOWER(COALESCE(t.user_merchant_name, t.merchant_name, t.name, '')) LIKE '%' || LOWER($1) || '%'";
      }
      const result = await pool.query(
        `UPDATE transactions t SET category = $2
         WHERE (category IS NULL OR category = '{}' OR category[1] = 'Uncategorized')
           AND pending = false AND amount > 0
           AND ${condition}
         RETURNING transaction_id`,
        [pattern, `{${rule.category}}`]
      );
      if (result.rowCount > 0) {
        totalApplied += result.rowCount;
        await pool.query(
          "UPDATE categorization_rules SET times_applied = times_applied + $1, updated_at = now() WHERE id = $2",
          [result.rowCount, rule.id]
        );
      }
    }
    res.json({ applied: totalApplied });
  } catch (err) {
    console.error("apply rules error:", err.message);
    res.status(500).json({ error: "An internal error occurred." });
  }
});

// POST /api/categorization-rules/from-transaction — create rule from a manual categorization
// This is the "remember this" feature: when a user manually sets a category,
// they can also create a persistent rule from it.
router.post("/api/categorization-rules/from-transaction", async (req, res) => {
  const { transaction_id, category, match_type } = req.body;
  if (!transaction_id || !category) {
    return res.status(400).json({ error: "transaction_id and category are required" });
  }
  if (!CATEGORIES.includes(category)) {
    return res.status(400).json({ error: `Invalid category. Must be one of: ${CATEGORIES.join(", ")}` });
  }
  try {
    const txn = await pool.query(
      "SELECT COALESCE(user_merchant_name, merchant_name, name) AS merchant FROM transactions WHERE transaction_id = $1",
      [transaction_id]
    );
    if (!txn.rows.length) return res.status(404).json({ error: "Transaction not found" });
    const merchant = txn.rows[0].merchant;
    if (!merchant) return res.status(400).json({ error: "Transaction has no merchant name" });

    const validTypes = ["contains", "exact", "starts_with"];
    const type = validTypes.includes(match_type) ? match_type : "contains";

    const result = await pool.query(
      `INSERT INTO categorization_rules (merchant_pattern, category, match_type)
       VALUES ($1, $2, $3)
       ON CONFLICT (merchant_pattern, category) DO UPDATE SET
         match_type = $3, is_active = true, updated_at = now()
       RETURNING *`,
      [merchant.trim(), category, type]
    );
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: "An internal error occurred." });
  }
});

module.exports = router;
