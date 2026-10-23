// Real-Postgres contract tests for the cycle-7 Batch 7 categorization fixes:
// rule order + superseded rules (F46), the AI never overwriting a category the
// user set mid-run (F47), the minimum rule-pattern length (F48) and rows the AI
// left unanswered not being re-sent (F54). Only the Anthropic SDK is stubbed.
const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const Module = require("module");
const supertest = require("supertest");
const { SKIP, perfinDb, perfinApp } = require("./_setup");

const anthropicQueue = [];
let anthropicCalls = 0;
class FakeAnthropic {
  constructor() {
    this.messages = { create: async (params) => {
      anthropicCalls++;
      const r = anthropicQueue.shift();
      if (!r) throw new Error("FakeAnthropic: response queue empty");
      return typeof r === "function" ? r(params) : r;
    } };
  }
}
const toolReply = (input) => ({
  content: [{ type: "tool_use", id: "tu_1", name: "categorize_transactions", input }],
  stop_reason: "tool_use",
  usage: { input_tokens: 800, output_tokens: 100 },
});

describe("categorization rules + AI on real Postgres", { skip: SKIP }, () => {
  let pool, app, categorize, originalLoad, today;
  const q = (s, p) => pool.query(s, p);
  const tx = (id, merchant, extra = {}) => q(
    `INSERT INTO transactions (account_id, transaction_id, amount, date, merchant_name, name, pending)
     VALUES ('acc', $1, $2, $3, $4, $4, false)`, [id, extra.amount || 10, extra.date || today, merchant]);

  before(async () => {
    process.env.ANTHROPIC_API_KEY = "contract-test-key";
    originalLoad = Module._load;
    Module._load = function (request) {
      if (request === "@anthropic-ai/sdk") return FakeAnthropic;
      return originalLoad.apply(this, arguments);
    };
    pool = await perfinDb("catrules");
    today = require("../../teller/services/financial-queries").todayStr();
    categorize = require("../../teller/routes/categorize");
    app = perfinApp();
    await q("INSERT INTO linked_accounts (account_id, name, type, subtype, is_manual) VALUES ('acc','Card','credit','credit card',true)");
  });
  after(async () => {
    if (originalLoad) Module._load = originalLoad;
    if (pool) await pool.end();
  });

  // ---------------------------------------------------------------- F48
  it("F48: a blank or 1–2 character contains / starts_with rule is refused; a stored one is skipped", async () => {
    await supertest(app).post("/api/categorization-rules").send({ merchant_pattern: "a", category: "Shopping" }).expect(400);
    await supertest(app).post("/api/categorization-rules").send({ merchant_pattern: "  ", category: "Shopping" }).expect(400);
    await supertest(app).post("/api/categorization-rules").send({ merchant_pattern: "ab", category: "Shopping", match_type: "starts_with" }).expect(400);
    await supertest(app).post("/api/categorization-rules").send({ merchant_pattern: "QT", category: "Gas & Fuel", match_type: "exact" }).expect(200);
    // A legacy short rule written before validation existed.
    await q("INSERT INTO categorization_rules (merchant_pattern, category, match_type) VALUES ('e', 'Shopping', 'contains')");
    await tx("f48_a", "Netflix");
    await tx("f48_b", "Whole Foods");
    await supertest(app).post("/api/categorization-rules/apply").expect(200);
    const n = (await q("SELECT COUNT(*)::int AS n FROM transactions WHERE transaction_id LIKE 'f48_%' AND user_category IS NOT NULL")).rows[0].n;
    assert.equal(n, 0, "the 1-character 'e' rule didn't sweep every merchant containing an e");
    await q("DELETE FROM categorization_rules WHERE merchant_pattern = 'e'");
  });

  // ---------------------------------------------------------------- F46
  it("F46: a newer, more specific rule beats an older busy one; re-pointing a merchant deactivates the old rule", async () => {
    await q(`INSERT INTO categorization_rules (merchant_pattern, category, match_type, times_applied, created_at, updated_at)
             VALUES ('shell', 'Travel', 'contains', 50, now() - interval '1 year', now() - interval '1 year')`);
    await supertest(app).post("/api/categorization-rules").send({ merchant_pattern: "Shell Oil 57444", category: "Gas & Fuel", match_type: "exact" }).expect(200);
    await tx("f46_gas", "Shell Oil 57444");
    await tx("f46_other", "Shell Beach Hotel");
    await supertest(app).post("/api/categorization-rules/apply").expect(200);
    const cats = Object.fromEntries((await q("SELECT transaction_id, user_category FROM transactions WHERE transaction_id LIKE 'f46_%'")).rows.map((r) => [r.transaction_id, r.user_category]));
    assert.deepEqual(cats, { f46_gas: "Gas & Fuel", f46_other: "Travel" });

    await supertest(app).post("/api/categorization-rules").send({ merchant_pattern: "Costco", category: "Groceries", match_type: "exact" }).expect(200);
    await supertest(app).post("/api/categorization-rules").send({ merchant_pattern: "costco", category: "Shopping", match_type: "exact" }).expect(200);
    const rules = (await q("SELECT category, is_active FROM categorization_rules WHERE LOWER(merchant_pattern) = 'costco' ORDER BY category")).rows;
    assert.deepEqual(rules, [{ category: "Groceries", is_active: false }, { category: "Shopping", is_active: true }]);
  });

  // ---------------------------------------------------------------- F47 / F54
  it("F47 + F54: a category set mid-run wins; an unanswered row isn't re-sent", async () => {
    await tx("ai_user", "Mystery One");
    await tx("ai_ok", "Mystery Two");
    await tx("ai_skip", "Mystery Three");
    anthropicQueue.push(async (params) => {
      // The user categorizes a row while the batch is with the model.
      await q("UPDATE transactions SET user_category = 'Travel', user_category_source = 'manual' WHERE transaction_id = 'ai_user'");
      const lines = params.messages[0].content.split("\n").slice(1);
      const idx = (m) => lines.findIndex((l) => l.includes(m)) + 1;
      return toolReply({ categories: [
        { index: idx("Mystery One"), category: "Shopping" },
        { index: idx("Mystery Two"), category: "Entertainment" },
      ] });
    });
    const r1 = await categorize.runCategorize();
    assert.equal(r1.ok, true, JSON.stringify(r1));
    const rows = Object.fromEntries((await q("SELECT transaction_id, user_category, user_category_source, ai_skipped_at IS NOT NULL AS skipped FROM transactions WHERE transaction_id LIKE 'ai_%'")).rows.map((x) => [x.transaction_id, x]));
    assert.equal(rows.ai_user.user_category, "Travel", "the user's mid-run choice wasn't overwritten");
    assert.equal(rows.ai_user.user_category_source, "manual");
    assert.equal(rows.ai_ok.user_category, "Entertainment");
    assert.equal(rows.ai_skip.user_category, null);
    assert.equal(rows.ai_skip.skipped, true);
    assert.equal(r1.categorized_by_ai, 1, "only the row actually written counts");

    const callsBefore = anthropicCalls;
    const r2 = await categorize.runCategorize();
    assert.equal(r2.ok, true, JSON.stringify(r2));
    assert.equal(anthropicCalls, callsBefore, "the unanswered row was not sent to the model again");
  });
});
