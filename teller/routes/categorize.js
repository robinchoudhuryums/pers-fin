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

// Max rows sent to Claude per categorize call. The free rule + Teller-map
// sweep above is unbounded (pure SQL over the whole backlog); only this paid
// AI batch is capped — both for token/latency limits and because the shared
// INSIGHTS_MONTHLY_BUDGET_CENTS cap throttles total AI spend anyway.
const AI_BATCH = 50;
// Max rows AI-categorized per runCategorize call. The loop processes AI_BATCH
// rows at a time up to this ceiling (or until the budget cap / backlog runs
// out), so one click makes a real dent in a large backlog. Budget-capped, so
// this is a latency/sanity ceiling, not a cost control.
const AI_MAX_PER_RUN = 300;

// Live progress for the running categorize pass (single-operator, single
// process → one pass at a time). Polled by GET /api/categorize/progress so the
// UI can show "Categorized N so far…" instead of a blind spinner.
let catProgress = { running: false, phase: null, by_rules: 0, by_teller_map: 0, by_ai: 0, ai_batches: 0, remaining: null, started_at: null };

// runCategorize — orchestration extracted from POST /api/categorize so the
// scheduler in startup.js can invoke it in-process. Returns:
//   { ok: false, status: 501|429|500, error }            — early bail
//   { ok: true, categorized, categorized_by_rules, ... } — normal result
// The route handler maps this to an HTTP response.
async function runCategorize() {
  if (!Anthropic || !process.env.ANTHROPIC_API_KEY) {
    return { ok: false, status: 501, error: "Set ANTHROPIC_API_KEY to enable ML categorization." };
  }
  catProgress = { running: true, phase: "free", by_rules: 0, by_teller_map: 0, by_ai: 0, ai_batches: 0, remaining: null, started_at: Date.now() };
  try {
    // -----------------------------------------------------------------
    // FREE deterministic sweep — runs over the ENTIRE uncategorized backlog,
    // not a 50-row page. User rules and the Teller/Plaid category map cost
    // nothing (pure SQL), so the old `LIMIT 50` on the whole batch made one
    // "Categorize" click barely move a large backlog. Only the paid AI call
    // further down stays bounded. The shared predicate keys on $1 = our
    // 21-category list (Postgres array param).
    // -----------------------------------------------------------------
    const uncatPredicate = `
      user_category IS NULL
      AND (category IS NULL OR category = '{}'
           OR NOT (category[1] = ANY($1::text[])))
      AND pending = false AND amount > 0`;

    const countRemaining = async () => {
      const c = await pool.query(
        `SELECT COUNT(*) AS uncategorized FROM transactions WHERE ${uncatPredicate}`,
        [OUR_CATEGORIES_PG]
      );
      return parseInt(c.rows[0].uncategorized);
    };

    // FREE PATH 1 — user-defined rules, bulk-applied across the whole backlog.
    const rules = await pool.query(
      "SELECT * FROM categorization_rules WHERE is_active = true ORDER BY times_applied DESC"
    ).catch(() => ({ rows: [] }));
    let ruleApplied = 0;
    for (const rule of rules.rows) {
      // M1: escape LIKE metacharacters (\ % _) in the user-supplied pattern so a
      // pattern containing '%' or '_' can't act as a wildcard and mis-categorize
      // unrelated transactions. The trailing/leading '%' we append stay OUTSIDE
      // the escaped expression so they remain the intended wildcards. (SQL
      // produced: REPLACE(REPLACE(REPLACE(LOWER($2),'\','\\'),'%','\%'),'_','\_')
      // with ESCAPE '\'.)
      const escPat = "REPLACE(REPLACE(REPLACE(LOWER($2), '\\', '\\\\'), '%', '\\%'), '_', '\\_')";
      const cond = rule.match_type === "exact"
        ? "LOWER(COALESCE(user_merchant_name, merchant_name, name, '')) = LOWER($2)"
        : rule.match_type === "starts_with"
        ? `LOWER(COALESCE(user_merchant_name, merchant_name, name, '')) LIKE ${escPat} || '%' ESCAPE '\\'`
        : `LOWER(COALESCE(user_merchant_name, merchant_name, name, '')) LIKE '%' || ${escPat} || '%' ESCAPE '\\'`;
      // Write to user_category (scalar TEXT), NOT category[] — a Teller/Plaid
      // re-sync does `category = EXCLUDED.category` and would clobber the latter.
      const r = await pool.query(
        `UPDATE transactions SET user_category = $3, user_category_source = 'rule',
           category_verified_at = NULL, category_was_correct = NULL
         WHERE ${uncatPredicate} AND ${cond}
         RETURNING transaction_id`,
        [OUR_CATEGORIES_PG, rule.merchant_pattern, rule.category]
      );
      if (r.rowCount > 0) {
        ruleApplied += r.rowCount;
        await pool.query(
          "UPDATE categorization_rules SET times_applied = times_applied + $1, updated_at = now() WHERE id = $2",
          [r.rowCount, rule.id]
        ).catch(() => {});
      }
    }

    // FREE PATH 2 — deterministic Teller/Plaid category map, bulk-applied.
    // One cheap UPDATE per source category (~dozens) instead of per-row JS.
    let tellerMapped = 0;
    for (const [tellerCat, ourCat] of Object.entries(TELLER_CATEGORY_MAP)) {
      if (!CATEGORIES.includes(ourCat)) continue;
      const r = await pool.query(
        `UPDATE transactions SET user_category = $3, user_category_source = 'teller_map',
           category_verified_at = NULL, category_was_correct = NULL
         WHERE ${uncatPredicate} AND LOWER(category[1]) = $2
         RETURNING transaction_id`,
        [OUR_CATEGORIES_PG, tellerCat, ourCat]
      );
      tellerMapped += r.rowCount;
    }

    // -----------------------------------------------------------------
    // PAID AI path — LOOP bounded batches until the backlog is cleared, the
    // per-run cap (AI_MAX_PER_RUN) is hit, or the monthly budget is exhausted.
    // Looping (vs a single 50-row batch) means one "Categorize" click makes a
    // real dent in a large backlog instead of nibbling 50 rows at a time.
    // -----------------------------------------------------------------
    catProgress.by_rules = ruleApplied;
    catProgress.by_teller_map = tellerMapped;
    catProgress.phase = "ai";

    // Nothing left for AI after the free sweep.
    if ((await countRemaining()) === 0) {
      catProgress.remaining = 0;
      return {
        ok: true,
        categorized: ruleApplied + tellerMapped,
        categorized_by_rules: ruleApplied,
        categorized_by_teller_map: tellerMapped,
        categorized_by_ai: 0,
        tokens_used: 0,
        remaining: 0,
        estimated_cost: 0,
      };
    }

    // Shared monthly-spend computation (cap is shared with /api/insights).
    const budgetCents = parseInt(process.env.INSIGHTS_MONTHLY_BUDGET_CENTS) || 50;
    const monthSpendCents = async () => {
      const u = await pool.query(
        "SELECT tokens_used, model_used, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens FROM financial_insights WHERE created_at >= date_trunc('month', CURRENT_DATE)"
      );
      let cents = 0;
      u.rows.forEach(r => {
        const cost = r.input_tokens
          ? estimateCostGranular({ input_tokens: r.input_tokens, output_tokens: r.output_tokens, cache_read_input_tokens: r.cache_read_tokens || 0, cache_creation_input_tokens: r.cache_creation_tokens || 0 }, r.model_used)
          : estimateCostUsd(r.tokens_used || 0, r.model_used);
        cents += cost * 100;
      });
      return cents;
    };

    // Already over the cap before any AI work → explicit 429 with the
    // raise-the-cap message (free paths still applied above).
    if ((await monthSpendCents()) >= budgetCents) {
      return {
        ok: false,
        status: 429,
        error: `Monthly AI budget reached (of $${(budgetCents / 100).toFixed(2)} cap). Rules/Teller-map applied ${ruleApplied + tellerMapped} transactions. Raise INSIGHTS_MONTHLY_BUDGET_CENTS to continue with AI.`,
        categorized_by_rules: ruleApplied,
        categorized_by_teller_map: tellerMapped,
      };
    }

    const settingsRow = await pool.query(
      "SELECT insights_model FROM user_settings WHERE id = 1"
    ).catch(() => ({ rows: [{ insights_model: "haiku" }] }));
    const userModel = settingsRow.rows[0]?.insights_model || "haiku";
    const modelId = MODEL_MAP[userModel] || MODEL_MAP.haiku;
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

    // The system prompt is the big quality lever here. Listing categories with
    // concrete examples cuts Haiku's "Other" rate dramatically and teaches it
    // the boundary cases. It's cache_control'd, so re-sending it each batch is
    // cheap (cache reads, not fresh input).
    const systemPrompt =
      "You classify personal finance transactions into exactly one of these categories. " +
      "Pick the BEST fit based on the merchant name and bank hint. Use \"Other\" only when " +
      "no category below clearly applies — every other choice is better than \"Other\".\n\n" +
      "CATEGORIES:\n" + CATEGORY_DESCRIPTIONS + "\n\n" +
      "Return your results via the categorize_transactions tool.";

    let aiUpdated = 0, aiTokens = 0, aiProcessed = 0, budgetHit = false;
    // M2: when a usage-row insert fails we can't account for that batch's spend,
    // so monthSpendCents() would under-count and the loop could overshoot the
    // shared budget cap. We still apply the categories we already paid for in
    // that batch, then stop the loop rather than keep calling Claude uncapped.
    let usageRecordFailed = false;
    while (aiProcessed < AI_MAX_PER_RUN) {
      // Re-check the cap before each paid call so a mid-run exhaustion stops
      // cleanly (returning what we got so far, not a 429).
      if ((await monthSpendCents()) >= budgetCents) { budgetHit = true; break; }

      const batchRes = await pool.query(
        `SELECT transaction_id, COALESCE(merchant_name, name) AS merchant, amount, date, category
         FROM transactions
         WHERE ${uncatPredicate}
         ORDER BY date DESC
         LIMIT ${AI_BATCH}`,
        [OUR_CATEGORIES_PG]
      );
      const batch = batchRes.rows;
      if (batch.length === 0) break;

      const txnList = batch.map((t, i) => {
        const hint = Array.isArray(t.category) && t.category[0] ? " [bank hint: " + t.category[0] + "]" : "";
        return (i + 1) + ". " + t.merchant + " — $" + parseFloat(t.amount).toFixed(2) + " on " + t.date + hint;
      }).join("\n");

      const message = await client.messages.create({
        model: modelId, max_tokens: 2000,
        system: [{ type: "text", text: systemPrompt, cache_control: { type: "ephemeral" } }],
        tools: [categorizeTool],
        tool_choice: { type: "tool", name: "categorize_transactions" },
        messages: [{ role: "user", content: "Transactions:\n" + txnList }],
      });

      // Record token usage BEFORE applying categories (DC-2) so the spend counts
      // against the cap even if the apply loop throws partway.
      const usage = message.usage || {};
      aiTokens += (usage.input_tokens || 0) + (usage.output_tokens || 0);
      const toolBlock = message.content.find(b => b.type === "tool_use");
      const catCount = toolBlock && toolBlock.input && Array.isArray(toolBlock.input.categories) ? toolBlock.input.categories.length : 0;
      try {
        await pool.query(
          `INSERT INTO financial_insights
             (insight_text, model_used, tokens_used, input_tokens, output_tokens,
              cache_read_tokens, cache_creation_tokens, entry_type)
           VALUES ($1, $2, $3, $4, $5, $6, $7, 'categorize')`,
          [
            `[ML Categorization] AI returned ${catCount} categorization(s)`,
            message.model || modelId,
            (usage.input_tokens || 0) + (usage.output_tokens || 0),
            usage.input_tokens || 0, usage.output_tokens || 0,
            usage.cache_read_input_tokens || 0, usage.cache_creation_input_tokens || 0,
          ]
        );
      } catch (err) {
        // Spend was incurred but couldn't be recorded — flag so we stop after
        // applying this (already-paid-for) batch instead of looping uncapped (M2).
        console.error("categorize usage tracking insert failed — will stop AI loop to respect the budget cap:", err.message);
        usageRecordFailed = true;
      }

      if (!toolBlock || !toolBlock.input || !Array.isArray(toolBlock.input.categories)) {
        console.error("AI did not return expected tool_use block — stopping loop");
        break;
      }
      for (const cat of toolBlock.input.categories) {
        if (!cat || typeof cat.index !== "number" || typeof cat.category !== "string") continue;
        const idx = cat.index - 1;
        if (idx < 0 || idx >= batch.length) continue;
        if (!CATEGORIES.includes(cat.category)) continue;
        await pool.query(
          // user_category (scalar) survives re-sync; source='ai' + cleared
          // verification feeds the accuracy sampler.
          `UPDATE transactions SET user_category = $1, user_category_source = 'ai',
             category_verified_at = NULL, category_was_correct = NULL
           WHERE transaction_id = $2`,
          [cat.category, batch[idx].transaction_id]
        );
        aiUpdated++;
      }
      aiProcessed += batch.length;
      catProgress.by_ai = aiUpdated;
      catProgress.ai_batches += 1;
      catProgress.remaining = await countRemaining();
      // Stop if this batch's spend couldn't be recorded (M2) — the categories
      // we paid for are applied above, but continuing would spend uncapped.
      if (usageRecordFailed) { budgetHit = true; break; }
      // Backlog drained (last page was short) → stop.
      if (batch.length < AI_BATCH) break;
    }

    const remaining = await countRemaining();
    catProgress.remaining = remaining;
    return {
      ok: true,
      categorized: aiUpdated + ruleApplied + tellerMapped,
      categorized_by_rules: ruleApplied,
      categorized_by_teller_map: tellerMapped,
      categorized_by_ai: aiUpdated,
      tokens_used: aiTokens,
      remaining,
      estimated_cost: parseFloat(estimateCostUsd(aiTokens, modelId).toFixed(4)),
      budget_hit: budgetHit || undefined,
    };
  } catch (err) {
    console.error("Categorize error:", err.message);
    return { ok: false, status: 500, error: "An internal error occurred." };
  } finally {
    catProgress.running = false;
    catProgress.phase = "done";
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

// GET /api/categorize/progress — live progress of the running categorize pass,
// polled by the Settings UI so the button shows "Categorized N so far…".
router.get("/api/categorize/progress", (_req, res) => {
  res.json(catProgress);
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
      `UPDATE transactions SET user_category = $1, user_category_source = 'review',
         category_verified_at = NULL, category_was_correct = NULL
       WHERE transaction_id = $2
       RETURNING transaction_id, COALESCE(user_merchant_name, merchant_name, name) AS merchant`,
      [category, transaction_id]
    );
    if (!upd.rows.length) return res.status(404).json({ error: "Transaction not found" });
    const merchant = upd.rows[0].merchant;

    let ruleCreated = false;
    if (create_rule && merchant) {
      // ON CONFLICT DO UPDATE so re-applying the same merchant→category pair
      // doesn't error. DC3: do NOT overwrite match_type here — this is an
      // implicit "remember" path, so silently widening an existing rule's scope
      // (e.g. flipping an exact rule to contains) would surprise the user. Only
      // the explicit POST /api/categorization-rules honors a chosen match_type.
      await pool.query(
        `INSERT INTO categorization_rules (merchant_pattern, category, match_type)
         VALUES ($1, $2, $3)
         ON CONFLICT (merchant_pattern, category) DO UPDATE SET
           is_active = true, updated_at = now()`,
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
      `UPDATE transactions SET user_category = $1, user_category_source = 'manual',
         category_verified_at = NULL, category_was_correct = NULL
       WHERE transaction_id = $2 RETURNING transaction_id, user_category`,
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
      `UPDATE transactions SET user_category = $1, user_category_source = 'manual',
         category_verified_at = NULL, category_was_correct = NULL
       WHERE transaction_id = ANY($2) RETURNING transaction_id`,
      [category, transaction_ids]
    );
    res.json({ updated: result.rowCount });
  } catch (err) {
    console.error("bulk category error:", err.message);
    res.status(500).json({ error: "An internal error occurred." });
  }
});

// ============================================================================
// ML Categorization accuracy — sample AI-assigned categories for verification
// ============================================================================
// The only categorizations whose "accuracy" is meaningful are the AI-assigned
// ones (`user_category_source = 'ai'`) — rules and the Teller-map are
// deterministic. The sampler surfaces unverified AI rows; the user confirms or
// corrects each, and the verdicts drive a running accuracy %.

// GET /api/categorize/accuracy — running accuracy over verified AI rows.
router.get("/api/categorize/accuracy", async (_req, res) => {
  try {
    const r = await pool.query(
      `SELECT
         COUNT(*) FILTER (WHERE user_category_source = 'ai') AS ai_total,
         COUNT(*) FILTER (WHERE user_category_source = 'ai' AND category_verified_at IS NOT NULL) AS verified,
         COUNT(*) FILTER (WHERE user_category_source = 'ai' AND category_was_correct = true) AS correct
       FROM transactions`
    );
    const row = r.rows[0] || {};
    const aiTotal = parseInt(row.ai_total) || 0;
    const verified = parseInt(row.verified) || 0;
    const correct = parseInt(row.correct) || 0;
    res.json({
      ai_total: aiTotal,
      verified,
      correct,
      unverified: aiTotal - verified,
      accuracy_pct: verified > 0 ? Math.round((correct / verified) * 1000) / 10 : null,
    });
  } catch (err) {
    console.error("categorize accuracy error:", err.message);
    res.status(500).json({ error: "An internal error occurred." });
  }
});

// GET /api/categorize/accuracy-sample?limit=N — a random sample of AI-assigned
// categorizations the user hasn't verified yet.
router.get("/api/categorize/accuracy-sample", async (req, res) => {
  const limit = Math.max(1, Math.min(parseInt(req.query.limit) || 8, 25));
  try {
    const result = await pool.query(
      `SELECT transaction_id,
              COALESCE(user_merchant_name, merchant_name, name) AS merchant,
              amount, date, user_category
       FROM transactions
       WHERE user_category_source = 'ai'
         AND category_verified_at IS NULL
         AND user_category IS NOT NULL
       ORDER BY random()
       LIMIT $1`,
      [limit]
    );
    res.json({
      transactions: result.rows.map(t => ({
        transaction_id: t.transaction_id,
        merchant: t.merchant,
        amount: parseFloat(t.amount),
        date: t.date,
        ai_category: t.user_category,
      })),
      categories: CATEGORIES,
    });
  } catch (err) {
    console.error("accuracy-sample error:", err.message);
    res.status(500).json({ error: "An internal error occurred." });
  }
});

// POST /api/categorize/accuracy-review — record a verdict on a sampled AI row.
// Body: { transaction_id, correct: bool, corrected_category?, create_rule?: bool }.
// correct=true  → mark verified-correct, leave the category as-is.
// correct=false → set user_category to corrected_category (required), mark
//                 verified-incorrect, and optionally create a rule so the same
//                 merchant is auto-categorized correctly next time.
router.post("/api/categorize/accuracy-review", async (req, res) => {
  const { transaction_id, correct, corrected_category, create_rule } = req.body;
  if (!transaction_id || typeof correct !== "boolean") {
    return res.status(400).json({ error: "transaction_id and boolean correct are required" });
  }
  if (!correct) {
    if (!corrected_category) return res.status(400).json({ error: "corrected_category is required when correct=false" });
    if (!CATEGORIES.includes(corrected_category)) {
      return res.status(400).json({ error: `Invalid category. Must be one of: ${CATEGORIES.join(", ")}` });
    }
  }
  try {
    let merchant = null;
    if (correct) {
      // Keep the AI category; just stamp the verdict. Source stays 'ai' so the
      // row still counts toward the AI accuracy denominator.
      const upd = await pool.query(
        `UPDATE transactions
           SET category_verified_at = now(), category_was_correct = true
         WHERE transaction_id = $1 AND user_category_source = 'ai'
         RETURNING COALESCE(user_merchant_name, merchant_name, name) AS merchant`,
        [transaction_id]
      );
      if (!upd.rows.length) return res.status(404).json({ error: "AI-categorized transaction not found" });
      merchant = upd.rows[0].merchant;
    } else {
      // Correct the category but PRESERVE source='ai' and record the miss, so
      // the AI accuracy stats reflect the original (wrong) AI assignment. The
      // user's corrected_category still wins everywhere via user_category.
      const upd = await pool.query(
        `UPDATE transactions
           SET user_category = $2, category_verified_at = now(), category_was_correct = false
         WHERE transaction_id = $1 AND user_category_source = 'ai'
         RETURNING COALESCE(user_merchant_name, merchant_name, name) AS merchant`,
        [transaction_id, corrected_category]
      );
      if (!upd.rows.length) return res.status(404).json({ error: "AI-categorized transaction not found" });
      merchant = upd.rows[0].merchant;
    }

    let ruleCreated = false;
    if (!correct && create_rule && merchant) {
      await pool.query(
        // DC3: implicit accuracy-review "remember" path — reactivate on conflict
        // but keep the existing rule's match_type (don't silently widen scope).
        `INSERT INTO categorization_rules (merchant_pattern, category, match_type)
         VALUES ($1, $2, 'contains')
         ON CONFLICT (merchant_pattern, category) DO UPDATE SET
           is_active = true, updated_at = now()`,
        [merchant.trim(), corrected_category]
      );
      ruleCreated = true;
    }
    res.json({ ok: true, transaction_id, correct, rule_created: ruleCreated });
  } catch (err) {
    console.error("accuracy-review error:", err.message);
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
      // M1: escape LIKE metacharacters in the user pattern so '%'/'_' can't act
      // as wildcards (parallel to runCategorize). exact uses '=', no escaping.
      const escPat = "REPLACE(REPLACE(REPLACE(LOWER($1), '\\', '\\\\'), '%', '\\%'), '_', '\\_')";
      let condition;
      if (rule.match_type === "exact") {
        condition = "LOWER(COALESCE(t.user_merchant_name, t.merchant_name, t.name, '')) = LOWER($1)";
      } else if (rule.match_type === "starts_with") {
        condition = `LOWER(COALESCE(t.user_merchant_name, t.merchant_name, t.name, '')) LIKE ${escPat} || '%' ESCAPE '\\'`;
      } else {
        condition = `LOWER(COALESCE(t.user_merchant_name, t.merchant_name, t.name, '')) LIKE '%' || ${escPat} || '%' ESCAPE '\\'`;
      }
      // Same scheme-aware predicate as POST /api/categorize. Skip rows where
      // the user has manually set user_category — their choice wins.
      const result = await pool.query(
        // Write to user_category (scalar TEXT) so a Teller/Plaid re-sync (which
        // does `category = EXCLUDED.category`) can't clobber the applied rule.
        `UPDATE transactions t SET user_category = $2, user_category_source = 'rule',
           category_verified_at = NULL, category_was_correct = NULL
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
      // DC3: from-transaction is an implicit "create rule from this manual
      // categorization" path — reactivate on conflict but keep the existing
      // rule's match_type rather than silently widening it.
      `INSERT INTO categorization_rules (merchant_pattern, category, match_type)
       VALUES ($1, $2, $3)
       ON CONFLICT (merchant_pattern, category) DO UPDATE SET
         is_active = true, updated_at = now()
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
