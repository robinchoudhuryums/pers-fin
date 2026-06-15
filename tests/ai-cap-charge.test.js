// ============================================================================
// Behavioral AI cap-charge tests — Ask + Categorize (S3 / INV-14)
// ============================================================================
// Closes the test-quality gap T3: the shared monthly-budget enforcement on the
// /api/ask tool loop and the /api/categorize AI loop was previously pinned ONLY
// by source-string assertions (assert.match(src, /status\(429\)/), /MAX_TOOL_ROUNDS/).
// The @anthropic-ai/sdk isn't installed at the repo root, which is why those
// paths were never exercised at runtime.
//
// Here we inject a FAKE @anthropic-ai/sdk via Module._load (CI-safe — no disk
// pollution, no production change, isolated to this worker) plus a mock pool,
// then assert real behavior:
//   - Ask charges exactly one entry_type='ask' usage row on success
//   - Ask returns 429 (no Claude call, no charge) once the cap is reached
//   - Ask's bounded tool loop actually runs a tool round and charges the
//     ACCUMULATED tokens across rounds
//   - Categorize charges an entry_type='categorize' usage row and writes
//     user_category (source 'ai') on a successful batch
//   - Categorize returns 429 once the cap is hit, while the FREE rule path
//     still applied for free (no Claude call)

if (!process.env.NEON_DATABASE_URL) process.env.NEON_DATABASE_URL = "postgres://mock:mock@localhost/mock";
if (!process.env.TOKEN_ENCRYPTION_PASSPHRASE) process.env.TOKEN_ENCRYPTION_PASSPHRASE = "test-passphrase";

const { describe, it, before, after, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const Module = require("module");
const express = require("express");
const supertest = require("supertest");

const dbModule = require("../teller/services/database");
const originalPoolQuery = dbModule.pool.query;

// --- Fake @anthropic-ai/sdk ------------------------------------------------
// Configurable response queue. Each entry is a message object, OR an Error to
// throw (to model a mid-loop API failure). `new Anthropic()` yields a client
// whose .messages.create shifts the queue.
let anthropicQueue = [];
let anthropicCalls = 0;
class FakeAnthropic {
  constructor() {
    this.messages = {
      create: async () => {
        anthropicCalls++;
        const r = anthropicQueue.shift();
        if (r instanceof Error) throw r;
        if (!r) throw new Error("FakeAnthropic: response queue empty");
        return r;
      },
    };
  }
}

const originalLoad = Module._load;

before(() => {
  process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || "test-key";
  Module._load = function (request, parent, isMain) {
    if (request === "@anthropic-ai/sdk") return FakeAnthropic; // .default undefined → falls to the class
    return originalLoad.apply(this, arguments);
  };
  // Re-require the route modules under the patched loader so their top-level
  // `require("@anthropic-ai/sdk")` binds to the fake (truthy → past the 501 gate).
  delete require.cache[require.resolve("../teller/routes/ask")];
  delete require.cache[require.resolve("../teller/routes/categorize")];
});

after(() => {
  Module._load = originalLoad;
  delete require.cache[require.resolve("../teller/routes/ask")];
  delete require.cache[require.resolve("../teller/routes/categorize")];
});

afterEach(() => {
  dbModule.pool.query = originalPoolQuery;
  anthropicQueue = [];
  anthropicCalls = 0;
});

// ---------------------------------------------------------------------------
// POST /api/ask
// ---------------------------------------------------------------------------
describe("POST /api/ask cap enforcement + charging (S3 / INV-14)", () => {
  let app, state;

  function makeApp() {
    const ask = require("../teller/routes/ask");
    const a = express();
    a.use(express.json());
    a.use(ask);
    return a;
  }

  beforeEach(() => {
    state = { budget: 5000, usageRows: [], inserts: [] };
    dbModule.pool.query = async (sql, params) => {
      if (sql.includes("ai_monthly_budget_cents")) return { rows: [{ ai_monthly_budget_cents: state.budget }] };
      if (sql.includes("FROM financial_insights") && sql.includes("date_trunc('month'")) return { rows: state.usageRows };
      if (sql.includes("insights_model")) return { rows: [{ insights_model: "haiku" }] };
      if (sql.includes("INSERT INTO financial_insights")) { state.inserts.push({ sql, params }); return { rows: [] }; }
      return { rows: [] }; // tool executors (getNetWorth etc.) degrade gracefully
    };
    app = makeApp();
  });

  it("charges exactly one entry_type='ask' usage row on a successful answer", async () => {
    anthropicQueue = [
      { usage: { input_tokens: 100, output_tokens: 50 }, stop_reason: "end_turn", content: [{ type: "text", text: "Your net worth is $1,000." }] },
    ];
    const res = await supertest(app).post("/api/ask").send({ question: "what is my net worth?" });
    assert.equal(res.status, 200);
    assert.match(res.body.answer, /net worth/i);
    assert.equal(anthropicCalls, 1);
    assert.equal(state.inserts.length, 1, "exactly one usage row written");
    assert.match(state.inserts[0].sql, /'ask'/, "usage row charged with entry_type='ask'");
    assert.equal(state.inserts[0].params[3], 100, "input_tokens charged");
    assert.equal(state.inserts[0].params[4], 50, "output_tokens charged");
    assert.equal(state.inserts[0].params[2], 150, "tokens_used = input + output");
  });

  it("returns 429 without calling Claude or charging once the monthly cap is reached", async () => {
    state.budget = 1; // 1 cent cap
    state.usageRows = [{ input_tokens: 1_000_000_000, output_tokens: 0, model_used: "claude-haiku-4-5", tokens_used: 1_000_000_000 }];
    const res = await supertest(app).post("/api/ask").send({ question: "anything" });
    assert.equal(res.status, 429);
    assert.equal(anthropicCalls, 0, "no Claude call once the cap is blown");
    assert.equal(state.inserts.length, 0, "no usage row written on the 429 path");
  });

  it("runs the bounded tool loop and charges the ACCUMULATED tokens across rounds", async () => {
    anthropicQueue = [
      { usage: { input_tokens: 80, output_tokens: 20 }, stop_reason: "tool_use", content: [{ type: "tool_use", id: "tu1", name: "get_net_worth", input: {} }] },
      { usage: { input_tokens: 120, output_tokens: 40 }, stop_reason: "end_turn", content: [{ type: "text", text: "Net worth: $1,234." }] },
    ];
    const res = await supertest(app).post("/api/ask").send({ question: "net worth?" });
    assert.equal(res.status, 200);
    assert.equal(anthropicCalls, 2, "two rounds: tool_use then final answer");
    assert.ok(res.body.tools_used.includes("get_net_worth"), "the tool was actually invoked");
    assert.match(res.body.answer, /1,234/);
    assert.equal(state.inserts.length, 1);
    assert.equal(state.inserts[0].params[3], 200, "accumulated input tokens (80+120)");
    assert.equal(state.inserts[0].params[4], 60, "accumulated output tokens (20+40)");
  });

  // F1 (FIXED): a throw on a LATER tool round spends round-1 tokens; ask.js now
  // charges them via a finally block so the spend still counts against the cap.
  it("charges the cap even when a later tool round throws (F1)", async () => {
    anthropicQueue = [
      { usage: { input_tokens: 80, output_tokens: 20 }, stop_reason: "tool_use", content: [{ type: "tool_use", id: "tu1", name: "get_net_worth", input: {} }] },
      new Error("network blip on round 2"),
    ];
    const res = await supertest(app).post("/api/ask").send({ question: "net worth?" });
    assert.equal(res.status, 500, "the failed round still surfaces as a 500 to the caller");
    assert.equal(state.inserts.length, 1, "round-1 spend must still be charged to the cap");
    assert.match(state.inserts[0].sql, /'ask'/);
    assert.equal(state.inserts[0].params[3], 80, "the consumed input tokens are charged");
    assert.equal(state.inserts[0].params[4], 20, "the consumed output tokens are charged");
  });
});

// ---------------------------------------------------------------------------
// runCategorize() — direct helper call (the scheduler's entry point)
// ---------------------------------------------------------------------------
describe("runCategorize cap enforcement + charging (S3 / INV-13 / INV-14)", () => {
  let runCategorize;

  before(() => { runCategorize = require("../teller/routes/categorize").runCategorize; });

  it("charges an entry_type='categorize' usage row and writes user_category (source 'ai')", async () => {
    const state = { uncat: 1, inserts: [], aiUpdates: [] };
    dbModule.pool.query = async (sql, params) => {
      if (sql.includes("SELECT COUNT(*) AS uncategorized")) return { rows: [{ uncategorized: state.uncat }] };
      if (sql.includes("FROM categorization_rules WHERE is_active")) return { rows: [] };
      if (sql.includes("ai_monthly_budget_cents")) return { rows: [{ ai_monthly_budget_cents: 5000 }] };
      if (sql.includes("FROM financial_insights") && sql.includes("date_trunc('month'")) return { rows: [] };
      if (sql.includes("AS merchant") && sql.includes("ORDER BY date DESC")) {
        return { rows: [{ transaction_id: "tx1", merchant: "Foo Store", amount: 10, date: "2026-06-01", category: null }] };
      }
      if (sql.includes("INSERT INTO financial_insights")) { state.inserts.push({ sql, params }); return { rows: [] }; }
      if (sql.includes("user_category_source = 'ai'")) { state.aiUpdates.push(params); state.uncat = 0; return { rowCount: 1, rows: [] }; }
      if (sql.includes("user_category_source = 'teller_map'")) return { rowCount: 0, rows: [] };
      return { rows: [], rowCount: 0 };
    };
    anthropicQueue = [
      { model: "claude-haiku-4-5", usage: { input_tokens: 200, output_tokens: 30 }, content: [{ type: "tool_use", id: "c1", name: "categorize_transactions", input: { categories: [{ index: 1, category: "Shopping" }] } }] },
    ];
    const result = await runCategorize();
    assert.equal(result.ok, true);
    assert.equal(result.categorized_by_ai, 1);
    assert.equal(anthropicCalls, 1);
    assert.equal(state.aiUpdates.length, 1, "the AI categorization was applied to user_category");
    assert.equal(state.aiUpdates[0][0], "Shopping");
    assert.equal(state.aiUpdates[0][1], "tx1");
    assert.equal(state.inserts.length, 1);
    assert.match(state.inserts[0].sql, /'categorize'/, "usage row charged with entry_type='categorize'");
  });

  it("returns 429 (no Claude call) once the cap is hit, while free rules still applied", async () => {
    const state = { ruleApplied: false };
    dbModule.pool.query = async (sql, params) => {
      if (sql.includes("SELECT COUNT(*) AS uncategorized")) return { rows: [{ uncategorized: 1 }] };
      if (sql.includes("FROM categorization_rules WHERE is_active")) {
        return { rows: [{ id: 1, merchant_pattern: "foo", category: "Shopping", match_type: "contains", is_active: true }] };
      }
      if (sql.includes("user_category_source = 'rule'")) { state.ruleApplied = true; return { rowCount: 1, rows: [{ transaction_id: "tx1" }] }; }
      if (sql.includes("UPDATE categorization_rules SET times_applied")) return { rows: [] };
      if (sql.includes("user_category_source = 'teller_map'")) return { rowCount: 0, rows: [] };
      if (sql.includes("ai_monthly_budget_cents")) return { rows: [{ ai_monthly_budget_cents: 1 }] }; // 1 cent cap
      if (sql.includes("FROM financial_insights") && sql.includes("date_trunc('month'")) {
        return { rows: [{ input_tokens: 1_000_000_000, output_tokens: 0, model_used: "claude-haiku-4-5", tokens_used: 1_000_000_000 }] };
      }
      return { rows: [], rowCount: 0 };
    };
    const result = await runCategorize();
    assert.equal(result.ok, false);
    assert.equal(result.status, 429);
    assert.equal(anthropicCalls, 0, "no paid Claude call once the cap is blown");
    assert.equal(state.ruleApplied, true, "the FREE rule path still categorized before the cap blocked AI (S3)");
  });
});
