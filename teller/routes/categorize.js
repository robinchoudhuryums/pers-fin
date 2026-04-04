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

    const settingsRow = await pool.query(
      "SELECT insights_model FROM user_settings WHERE id = 1"
    ).catch(() => ({ rows: [{ insights_model: "haiku" }] }));

    // Use user's preferred model for categorization (default haiku — cheaper)
    const userModel = settingsRow.rows[0]?.insights_model || "haiku";
    const modelId = MODEL_MAP[userModel] || MODEL_MAP.haiku;

    const txnList = result.rows.map((t, i) =>
      (i + 1) + ". " + t.merchant + " — $" + parseFloat(t.amount).toFixed(2) + " on " + t.date
    ).join("\n");

    const client = new Anthropic();
    const message = await client.messages.create({
      model: modelId, max_tokens: 2000,
      system: [{ type: "text", text:
        "Categorize each transaction into exactly one category from this list:\n" +
        CATEGORIES.join(", ") + "\n\n" +
        "Respond ONLY with a JSON array of objects with keys: index (number, 1-based), category (string from the list above). " +
        "No markdown, no extra text — just the JSON array.",
        cache_control: { type: "ephemeral" },
      }],
      messages: [{ role: "user", content: "Transactions:\n" + txnList }],
    });

    const tokensUsed = (message.usage?.input_tokens || 0) + (message.usage?.output_tokens || 0);
    let categories;
    try {
      let text = message.content[0].text.trim();
      // Strip markdown fences if Claude wraps the JSON
      const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
      if (fenceMatch) text = fenceMatch[1].trim();
      categories = JSON.parse(text);
    } catch (e) {
      console.error("AI response parse error:", e.message, "| Raw:", message.content[0]?.text?.slice(0, 500));
      return res.status(500).json({ error: "Failed to parse AI response" });
    }

    // Validate response schema: must be an array of {index, category}
    if (!Array.isArray(categories)) {
      console.error("AI response not an array:", typeof categories);
      return res.status(500).json({ error: "AI returned unexpected format (expected JSON array)" });
    }

    // Apply categories to transactions
    let updated = 0;
    for (const cat of categories) {
      if (!cat || typeof cat.index !== "number" || typeof cat.category !== "string") continue;
      const idx = cat.index - 1;
      if (idx < 0 || idx >= result.rows.length) continue;
      if (!CATEGORIES.includes(cat.category)) continue;
      const txn = result.rows[idx];
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

    // Check how many remain
    const remaining = await pool.query(
      `SELECT COUNT(*) AS uncategorized
       FROM transactions
       WHERE (category IS NULL OR category = '{}' OR category[1] = 'Uncategorized')
         AND pending = false AND amount > 0`
    );

    res.json({
      categorized: updated,
      tokens_used: tokensUsed,
      remaining: parseInt(remaining.rows[0].uncategorized),
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

module.exports = router;
