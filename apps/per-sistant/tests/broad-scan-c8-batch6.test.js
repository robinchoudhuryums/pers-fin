// ============================================================================
// Cycle-8 broad scan Batch 6 — AI trust and privacy, Per-sistant's side
// ============================================================================
// F49: a quoted frontmatter key (`"sensitivity": secret`) is read, and a line
// the parser can't read that starts with a privacy key fails closed (private);
// VAULT_PARSE_VERSION moved to 3 so the operator checks ask for one full
// reindex. F24: a model refusal on a routes/ai.js feature is charged, then
// answered 422 { ai_refusal } — never an empty 200 (adjust-tone's empty body
// used to overwrite the draft) — and Ask says it couldn't answer. The Perfin
// half is the root tests/broad-scan-c8-batch6.test.js.
// ============================================================================
const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const supertest = require("supertest");

const vault = require("../services/vault-sync");
const ai = require("../ai");
const db = require("../db");
const { todayStr } = require("../routes/health");

// ---------------------------------------------------------------- F49
describe("F49 — quoted keys and unreadable privacy lines fail closed", () => {
  const level = (fm) => vault.resolveSensitivity(vault.parseFrontmatter("---\n" + fm + "\n---\nbody").meta);

  it("a quoted key is a key", () => {
    assert.equal(level('"sensitivity": secret'), "secret");
    assert.equal(level("'sensitivity': private"), "private");
    assert.equal(level('"embed": false'), "private");
    assert.equal(level("'private': true"), "private");
    assert.equal(vault.parseFrontmatter('---\n"title": Trip\n---\n').meta.title, "Trip");
    assert.equal(level('"sensitivity": normal'), "normal");
  });

  it("a line it can't read that starts with a privacy key is private", () => {
    assert.equal(level("  sensitivity: secret"), "private", "indented");
    assert.equal(level("sensitivity secret"), "private", "no colon");
    assert.equal(level("meta:\n  private: true"), "private", "nested");
    assert.equal(level('"sensitivity: secret'), "private", "unbalanced quote");
  });

  it("ordinary lines that merely mention the words stay normal", () => {
    assert.equal(level("title: x"), "normal");
    assert.equal(level("description: how to embed a video"), "normal");
    assert.equal(level("tags: [private, work]"), "normal");
    assert.equal(level("tags:\n  - private\n  - work"), "normal", "a list item is an item");
  });

  it("the parse version moved, so a full reindex is asked for", () => {
    assert.equal(vault.VAULT_PARSE_VERSION, 3);
  });
});

// ---------------------------------------------------------------- F24
describe("F24 — a refusal is a 422, not an empty 200", () => {
  const saved = { b: ai.getAiBudgetCents, s: ai.monthlyAiSpendCents, r: ai.recordAiUsage, c: ai.callAIWithUsage, q: db.pool.query, key: process.env.ANTHROPIC_API_KEY };
  let charged, stop;
  beforeEach(() => {
    charged = []; stop = "refusal";
    process.env.ANTHROPIC_API_KEY = "test-key";
    db.pool.query = async () => ({ rows: [{ model: "haiku" }] });
    ai.getAiBudgetCents = async () => 100;
    ai.monthlyAiSpendCents = async () => 0;
    ai.recordAiUsage = async (_p, row) => { charged.push(row); return 0; };
    ai.callAIWithUsage = async () => ({ text: stop === "refusal" ? "" : "Fine.", usage: { input_tokens: 9, output_tokens: 1 }, stop_reason: stop });
    ai.setCache(`briefing_${todayStr()}`, null);
  });
  afterEach(() => {
    ai.getAiBudgetCents = saved.b; ai.monthlyAiSpendCents = saved.s; ai.recordAiUsage = saved.r; ai.callAIWithUsage = saved.c;
    db.pool.query = saved.q;
    if (saved.key === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = saved.key;
  });
  const app = () => {
    const a = express();
    a.use(express.json());
    a.use(require("../routes/ai")({ pool: { query: async () => ({ rows: [], rowCount: 0 }) } }));
    return a;
  };

  it("adjust-tone, review-summary and the briefing answer 422 and are still charged", async () => {
    for (const [method, url, body, entry] of [
      ["post", "/api/ai/adjust-tone", { body: "hey", tone: "more formal" }, "email_tone"],
      ["post", "/api/ai/review-summary", { stats: { tasks_completed: 1 } }, "review_summary"],
      ["get", "/api/ai/daily-briefing", null, "daily_briefing"],
    ]) {
      charged = [];
      const req = supertest(app())[method](url);
      const r = await (body ? req.send(body) : req);
      assert.equal(r.status, 422, url);
      assert.equal(r.body.ai_refusal, true);
      assert.ok(!("body" in r.body) && !("summary" in r.body) && !("briefing" in r.body), "no empty text field");
      assert.deepEqual(charged.map((c) => c.entry_type), [entry], "the spent tokens are charged");
    }
  });

  it("a refused briefing isn't cached", async () => {
    await supertest(app()).get("/api/ai/daily-briefing").expect(422);
    stop = "end_turn";
    const r = await supertest(app()).get("/api/ai/daily-briefing").expect(200);
    assert.equal(r.body.briefing, "Fine.");
  });

  it("Ask answers that it couldn't process the question", async () => {
    const r = await supertest(app()).post("/api/ai/query").send({ query: "anything?" }).expect(200);
    assert.match(r.body.answer, /couldn't process/);
    assert.equal(charged.length, 1);
  });
});
