// ============================================================================
// Routes: ML Transaction Categorization (Claude-powered)
// ============================================================================

const express = require("express");
const router = express.Router();
const { pool } = require("../services/database");
const { MODEL_MAP, estimateCostUsd, estimateCostGranular } = require("../data/reference-data");

let Anthropic;
try {
  Anthropic = require("@anthropic-ai/sdk").default || require("@anthropic-ai/sdk");
} catch {
  Anthropic = null;
}

const {
  CATEGORIES,
  CATEGORY_DESCRIPTIONS,
  TELLER_CATEGORY_MAP,
  OUR_CATEGORIES_PG,
} = require("./categorize-helpers");

// GET /api/categorize/status — how many uncategorized transactions exist
//
// "Uncategorized" here means the transaction's current category isn't
// one of our 21 standard categories — that includes Teller-provided
// buckets like 'general'/'dining'/'transport'. The categorize flow can
// handle these via Teller-map (no AI cost), user rules, or AI fallback.
router.get("/api/categorize/status", async (_req, res) => {
  try {
    const result = await pool.query(
      `SELECT COUNT(*) AS uncategorized
       FROM transactions
       WHERE (
         user_category IS NULL
         AND (category IS NULL
              OR category = '{}'
              OR NOT (category[1] = ANY($1::text[])))
       )
         AND pending = false AND amount > 0`,
      [OUR_CATEGORIES_PG]
    );
    res.json({
      uncategorized: parseInt(result.rows[0].uncategorized),
      ai_available: !!(Anthropic && process.env.ANTHROPIC_API_KEY),
    });
  } catch (err) {
    res.status(500).json({ error: "An internal error occurred." });
  }
});

// runCategorize — orchestration extracted from POST /api/categorize so the
// scheduler in startup.js can invoke it in-process. Returns:
//   { ok: false, status: 501|429|500, error }            — early bail
//   { ok: true, categorized, categorized_by_rules, ... } — normal result
// The route handler maps this to an HTTP response.
async function runCategorize() {
  if (!Anthropic || !process.env.ANTHROPIC_API_KEY) {
    return { ok: false, status: 501, error: "Set ANTHROPIC_API_KEY to enable ML categorization." };
  }
  try {
    // Pull up to 50 rows that aren't in our 21-category scheme. This
    // includes Teller-tagged rows ('general', 'dining', etc.) so they
    // can be re-mapped — most of them via the deterministic Teller map
    // below (no AI call).
    const result = await pool.query(
      `SELECT transaction_id,
              COALESCE(merchant_name, name) AS merchant,
              amount, date,
              category,
              personal_finance_category
       FROM transactions
       WHERE (
         user_category IS NULL
         AND (category IS NULL
              OR category = '{}'
              OR NOT (category[1] = ANY($1::text[])))
       )
         AND pending = false AND amount > 0
       ORDER BY date DESC
       LIMIT 50`,
      [OUR_CATEGORIES_PG]
    );

    if (result.rows.length === 0) {
      return { ok: true, categorized: 0, message: "No uncategorized transactions found." };
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
            // Write to user_category (scalar TEXT), NOT category[]. The Teller/
            // Plaid upserts do `category = EXCLUDED.category` on conflict, so a
            // re-sync would clobber a categorization written to `category`.
            // Display layers read COALESCE(user_category, category[1]).
            "UPDATE transactions SET user_category = $1 WHERE transaction_id = $2",
            [rule.category, txn.transaction_id]
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

    // Teller-map fast path: any row whose current category[1] maps
    // deterministically into our scheme is assigned without calling AI.
    // Handles the bulk of real-world rows (dining, groceries, transport…).
    let tellerMapped = 0;
    const afterTellerMap = [];
    for (const txn of remaining) {
      const tellerCat = Array.isArray(txn.category) && txn.category[0]
        ? String(txn.category[0]).toLowerCase()
        : null;
      const mapped = tellerCat ? TELLER_CATEGORY_MAP[tellerCat] : null;
      if (mapped && CATEGORIES.includes(mapped)) {
        await pool.query(
          // Write to user_category (scalar) so a Teller/Plaid re-sync can't clobber it.
          "UPDATE transactions SET user_category = $1 WHERE transaction_id = $2",
          [mapped, txn.transaction_id]
        );
        tellerMapped++;
      } else {
        afterTellerMap.push(txn);
      }
    }

    // If everything was handled by rules + Teller-map, skip the AI call.
    if (afterTellerMap.length === 0) {
      const leftover = await pool.query(
        `SELECT COUNT(*) AS uncategorized FROM transactions
         WHERE (
           category IS NULL
           OR category = '{}'
           OR NOT (category[1] = ANY($1::text[]))
         )
           AND pending = false AND amount > 0`,
        [OUR_CATEGORIES_PG]
      );
      return {
        ok: true,
        categorized: ruleApplied + tellerMapped,
        categorized_by_rules: ruleApplied,
        categorized_by_teller_map: tellerMapped,
        tokens_used: 0,
        remaining: parseInt(leftover.rows[0].uncategorized),
        estimated_cost: 0,
      };
    }

    // Check monthly AI budget before calling Claude (shared cap with /api/insights)
    const budgetCents = parseInt(process.env.INSIGHTS_MONTHLY_BUDGET_CENTS) || 50;
    const usageResult = await pool.query(
      "SELECT tokens_used, model_used, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens FROM financial_insights WHERE created_at >= date_trunc('month', CURRENT_DATE)"
    );
    let estimatedCostCents = 0;
    usageResult.rows.forEach(r => {
      const cost = r.input_tokens
        ? estimateCostGranular({ input_tokens: r.input_tokens, output_tokens: r.output_tokens, cache_read_input_tokens: r.cache_read_tokens || 0, cache_creation_input_tokens: r.cache_creation_tokens || 0 }, r.model_used)
        : estimateCostUsd(r.tokens_used || 0, r.model_used);
      estimatedCostCents += cost * 100;
    });
    if (estimatedCostCents >= budgetCents) {
      return {
        ok: false,
        status: 429,
        error: `Monthly AI budget reached ($${(estimatedCostCents / 100).toFixed(2)} of $${(budgetCents / 100).toFixed(2)} cap). Rules applied ${ruleApplied} transactions. Raise INSIGHTS_MONTHLY_BUDGET_CENTS to continue with AI.`,
        categorized_by_rules: ruleApplied,
      };
    }

    const settingsRow = await pool.query(
      "SELECT insights_model FROM user_settings WHERE id = 1"
    ).catch(() => ({ rows: [{ insights_model: "haiku" }] }));

    // Use user's preferred model for categorization (default haiku — cheaper)
    const userModel = settingsRow.rows[0]?.insights_model || "haiku";
    const modelId = MODEL_MAP[userModel] || MODEL_MAP.haiku;

    // Build the per-txn prompt lines. Include the bank's original category
    // hint when present — it often disambiguates cryptic merchant strings
    // (e.g. "SQ *MERCHANT" with hint "dining" is obviously Food & Drink).
    const txnList = afterTellerMap.map((t, i) => {
      const hint = Array.isArray(t.category) && t.category[0]
        ? " [bank hint: " + t.category[0] + "]"
        : "";
      return (i + 1) + ". " + t.merchant + " — $" + parseFloat(t.amount).toFixed(2) + " on " + t.date + hint;
    }).join("\n");

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

    // The system prompt is the big quality lever here. Listing categories
    // with concrete examples cuts Haiku's "Other" rate dramatically and
    // teaches it the boundary cases (Transfer vs Income, Food & Drink vs
    // Groceries, Entertainment vs Subscription).
    const systemPrompt =
      "You classify personal finance transactions into exactly one of these categories. " +
      "Pick the BEST fit based on the merchant name and bank hint. Use \"Other\" only when " +
      "no category below clearly applies — every other choice is better than \"Other\".\n\n" +
      "CATEGORIES:\n" + CATEGORY_DESCRIPTIONS + "\n\n" +
      "Return your results via the categorize_transactions tool.";

    const message = await client.messages.create({
      model: modelId, max_tokens: 2000,
      system: [{ type: "text", text: systemPrompt, cache_control: { type: "ephemeral" } }],
      tools: [categorizeTool],
      tool_choice: { type: "tool", name: "categorize_transactions" },
      messages: [{ role: "user", content: "Transactions:\n" + txnList }],
    });

    const tokensUsed = (message.usage?.input_tokens || 0) + (message.usage?.output_tokens || 0);

    // Extract structured output from tool_use block
    const toolBlock = message.content.find(b => b.type === "tool_use");
    if (!toolBlock || !toolBlock.input || !Array.isArray(toolBlock.input.categories)) {
      console.error("AI did not return expected tool_use block");
      return { ok: false, status: 500, error: "AI returned unexpected format" };
    }
    const categories = toolBlock.input.categories;

    // Apply AI-assigned categories to the rows that made it past the
    // Teller-map fast path (afterTellerMap is the list Claude saw).
    let updated = 0;
    for (const cat of categories) {
      if (!cat || typeof cat.index !== "number" || typeof cat.category !== "string") continue;
      const idx = cat.index - 1;
      if (idx < 0 || idx >= afterTellerMap.length) continue;
      if (!CATEGORIES.includes(cat.category)) continue;
      const txn = afterTellerMap[idx];
      await pool.query(
        // Write to user_category (scalar) so a Teller/Plaid re-sync can't clobber it.
        "UPDATE transactions SET user_category = $1 WHERE transaction_id = $2",
        [cat.category, txn.transaction_id]
      );
      updated++;
    }

    // Record token usage so the categorize spend counts against the shared
    // INSIGHTS_MONTHLY_BUDGET_CENTS cap. Earlier code skipped the write to
    // avoid shadowing the user-facing "AI Insights" feed — but the cap was
    // checked-not-charged, so categorize was effectively uncapped. The
    // entry_type discriminator lets the dashboard hide these rows while the
    // cost-cap queries still see them.
    const usage = message.usage || {};
    const tokensUsedForRow = (usage.input_tokens || 0) + (usage.output_tokens || 0);
    const actualModel = message.model || modelId;
    await pool.query(
      `INSERT INTO financial_insights
         (insight_text, model_used, tokens_used, input_tokens, output_tokens,
          cache_read_tokens, cache_creation_tokens, entry_type)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'categorize')`,
      [
        `[ML Categorization] ${updated} txn(s) categorized by AI`,
        actualModel,
        tokensUsedForRow,
        usage.input_tokens || 0,
        usage.output_tokens || 0,
        usage.cache_read_input_tokens || 0,
        usage.cache_creation_input_tokens || 0,
      ]
    ).catch(err => console.error("categorize usage tracking insert failed:", err.message));

    const leftoverCount = await pool.query(
      `SELECT COUNT(*) AS uncategorized FROM transactions
       WHERE (
         user_category IS NULL
         AND (category IS NULL
              OR category = '{}'
              OR NOT (category[1] = ANY($1::text[])))
       )
         AND pending = false AND amount > 0`,
      [OUR_CATEGORIES_PG]
    );
    return {
      ok: true,
      categorized: updated + ruleApplied + tellerMapped,
      categorized_by_rules: ruleApplied,
      categorized_by_teller_map: tellerMapped,
      categorized_by_ai: updated,
      tokens_used: tokensUsed,
      remaining: parseInt(leftoverCount.rows[0].uncategorized),
      estimated_cost: parseFloat(estimateCostUsd(tokensUsed, modelId).toFixed(4)),
    };
  } catch (err) {
    console.error("Categorize error:", err.message);
    return { ok: false, status: 500, error: "An internal error occurred." };
  }
}

// POST /api/categorize — HTTP wrapper around runCategorize().
router.post("/api/categorize", async (_req, res) => {
  const result = await runCategorize();
  if (!result.ok) {
    const { status, ...body } = result;
    return res.status(status || 500).json(body);
  }
  const { ok, ...body } = result;
  res.json(body);
});

// GET /api/categorize/review-queue — Surfaces transactions that would otherwise
// go to AI on the next /api/categorize call. Engagement-loop entry point: the
// user reviews 5-10 uncertain rows, optionally creates rules, and the rule
// base grows. Future AI calls cost less because more rows hit the rule path
// before reaching Claude.
//
// Returns: { transactions: [{ transaction_id, merchant, amount, date,
//                              suggested_category, hint }], count }
// `suggested_category` is filled from the deterministic Teller-map when
// available (so the user sees a sensible default in the dropdown); `hint` is
// the raw Teller category[0] for context.
router.get("/api/categorize/review-queue", async (req, res) => {
  const limit = Math.max(1, Math.min(parseInt(req.query.limit) || 10, 50));
  try {
    const result = await pool.query(
      `SELECT transaction_id,
              COALESCE(user_merchant_name, merchant_name, name) AS merchant,
              amount, date, category, personal_finance_category
       FROM transactions
       WHERE user_category IS NULL
         AND (category IS NULL
              OR category = '{}'
              OR NOT (category[1] = ANY($1::text[])))
         AND pending = false AND amount > 0
       ORDER BY date DESC
       LIMIT $2`,
      [OUR_CATEGORIES_PG, limit]
    );
    // Fold the Teller-map fast path into a `suggested_category` so the UI
    // can show a sensible default in the dropdown without a second round-trip.
    const transactions = result.rows.map(t => {
      const tellerCat = Array.isArray(t.category) && t.category[0]
        ? String(t.category[0]).toLowerCase()
        : null;
      const mapped = tellerCat ? TELLER_CATEGORY_MAP[tellerCat] : null;
      return {
        transaction_id: t.transaction_id,
        merchant: t.merchant,
        amount: parseFloat(t.amount),
        date: t.date,
        suggested_category: mapped && CATEGORIES.includes(mapped) ? mapped : null,
        hint: tellerCat,
      };
    });
    res.json({ transactions, count: transactions.length });
  } catch (err) {
    console.error("review-queue error:", err.message);
    res.status(500).json({ error: "An internal error occurred." });
  }
});

// POST /api/categorize/review — Apply a single user-driven categorization
// decision. Atomically sets user_category on the transaction and (optionally)
// creates a categorization_rules row so the same merchant pattern is auto-
// categorized next time. This is the "remember this merchant" workflow.
//
// Body: { transaction_id, category, create_rule?: bool, match_type?: 'contains'|'exact'|'starts_with' }
router.post("/api/categorize/review", async (req, res) => {
  const { transaction_id, category, create_rule, match_type } = req.body;
  if (!transaction_id || !category) {
    return res.status(400).json({ error: "transaction_id and category are required" });
  }
  if (!CATEGORIES.includes(category)) {
    return res.status(400).json({ error: `Invalid category. Must be one of: ${CATEGORIES.join(", ")}` });
  }
  const validTypes = ["contains", "exact", "starts_with"];
  const ruleType = validTypes.includes(match_type) ? match_type : "contains";
  try {
    // Set user_category — the same path PATCH /api/transactions/:id/category uses.
    const upd = await pool.query(
      "UPDATE transactions SET user_category = $1 WHERE transaction_id = $2 RETURNING transaction_id, COALESCE(user_merchant_name, merchant_name, name) AS merchant",
      [category, transaction_id]
    );
    if (!upd.rows.length) return res.status(404).json({ error: "Transaction not found" });
    const merchant = upd.rows[0].merchant;

    let ruleCreated = false;
    if (create_rule && merchant) {
      // Same insert path as POST /api/categorization-rules. ON CONFLICT DO UPDATE
      // so re-applying the same merchant→category pair doesn't error.
      await pool.query(
        `INSERT INTO categorization_rules (merchant_pattern, category, match_type)
         VALUES ($1, $2, $3)
         ON CONFLICT (merchant_pattern, category) DO UPDATE SET
           match_type = $3, is_active = true, updated_at = now()`,
        [merchant.trim(), category, ruleType]
      );
      ruleCreated = true;
    }
    res.json({ ok: true, transaction_id, category, rule_created: ruleCreated });
  } catch (err) {
    console.error("review apply error:", err.message);
    res.status(500).json({ error: "An internal error occurred." });
  }
});

// PATCH /api/transactions/:id/category — manually set a transaction's category.
// User overrides go to `user_category` (NOT `category`) so a subsequent Teller
// re-sync — which UPSERTs `category = EXCLUDED.category` — can't overwrite the
// user's choice. Display layers use COALESCE(user_category, category[1]).
router.patch("/api/transactions/:id/category", async (req, res) => {
  const { category } = req.body;
  if (!category) return res.status(400).json({ error: "category is required" });
  if (!CATEGORIES.includes(category)) return res.status(400).json({ error: `Invalid category. Must be one of: ${CATEGORIES.join(", ")}` });
  try {
    const result = await pool.query(
      "UPDATE transactions SET user_category = $1 WHERE transaction_id = $2 RETURNING transaction_id, user_category",
      [category, req.params.id]
    );
    if (!result.rows.length) return res.status(404).json({ error: "Transaction not found" });
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: "An internal error occurred." });
  }
});

// PATCH /api/transactions/bulk-category — Bulk update categories.
// Same user-override semantics as the single PATCH above.
router.patch("/api/transactions/bulk-category", async (req, res) => {
  const { transaction_ids, category } = req.body;
  if (!Array.isArray(transaction_ids) || !transaction_ids.length || !category) {
    return res.status(400).json({ error: "transaction_ids array and category are required" });
  }
  if (!CATEGORIES.includes(category)) {
    return res.status(400).json({ error: `Invalid category. Must be one of: ${CATEGORIES.join(", ")}` });
  }
  if (transaction_ids.length > 200) {
    return res.status(400).json({ error: "Maximum 200 transactions per batch" });
  }
  try {
    const result = await pool.query(
      `UPDATE transactions SET user_category = $1 WHERE transaction_id = ANY($2) RETURNING transaction_id`,
      [category, transaction_ids]
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
      // Same scheme-aware predicate as POST /api/categorize. Skip rows where
      // the user has manually set user_category — their choice wins.
      const result = await pool.query(
        // Write to user_category (scalar TEXT) so a Teller/Plaid re-sync (which
        // does `category = EXCLUDED.category`) can't clobber the applied rule.
        `UPDATE transactions t SET user_category = $2
         WHERE user_category IS NULL
           AND (
             category IS NULL
             OR category = '{}'
             OR NOT (category[1] = ANY($3::text[]))
           )
           AND pending = false AND amount > 0
           AND ${condition}
         RETURNING transaction_id`,
        [pattern, rule.category, OUR_CATEGORIES_PG]
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
module.exports.runCategorize = runCategorize;
