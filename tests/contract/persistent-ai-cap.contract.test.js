// Real-Postgres contract test for roadmap T2.3 C2 / C3 — Per-sistant's AI cost
// cap through the real routers, the real cap reads and the real ai_usage
// ledger (only the model calls themselves are stubbed):
//  - a Knowledge answer and an email draft each charge one ai_usage row with
//    their entry_type, counted in the APP_TIMEZONE month (a row from just before
//    the zone's month start is not)
//  - with the month's spend at the budget, /api/rag/query answers sources-only
//    with ai_cap and /api/ai/draft-email answers 429 — neither calls the model
//    or adds a row
const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const supertest = require("supertest");
const { SKIP, persistentDb, persistentApp } = require("./_setup");

describe("Per-sistant AI cost cap (T2.3 C2 / C3) on real Postgres", { skip: SKIP }, () => {
  let pool, app, ai;
  const calls = [];
  const saved = {};
  const q = (s, p) => pool.query(s, p);
  const rows = async () => (await q("SELECT entry_type, model, cost_cents FROM ai_usage ORDER BY id")).rows;

  before(async () => {
    for (const k of ["ANTHROPIC_API_KEY", "APP_TIMEZONE", "VOYAGE_API_KEY", "PERSISTENT_AI_BUDGET_CENTS"]) saved[k] = process.env[k];
    process.env.ANTHROPIC_API_KEY = "test-key";
    process.env.APP_TIMEZONE = "Pacific/Kiritimati"; // a month start that differs from UTC's
    delete process.env.VOYAGE_API_KEY;
    delete process.env.PERSISTENT_AI_BUDGET_CENTS;
    pool = await persistentDb("ai_cap");
    ai = require("../../apps/per-sistant/ai");
    ai.answerWithCitations = async () => {
      calls.push("citations");
      return { text: "It is red [1].", citedIndexes: [0], stop_reason: "end_turn", usage: { input_tokens: 4000, output_tokens: 300 } };
    };
    ai.callAIWithUsage = async () => {
      calls.push("callAI");
      return { text: '{"subject":"Hi","body":"Hello"}', usage: { input_tokens: 1000, output_tokens: 200 }, stop_reason: "end_turn" };
    };
    await q("UPDATE user_settings SET ai_model_rag = 'sonnet', ai_model_email_draft = 'haiku', ai_monthly_budget_cents = 100 WHERE id = 1");
    await q("INSERT INTO notes (title, content) VALUES ('Bike', 'my bike is red')");
    app = persistentApp(pool);
  });
  after(async () => {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    if (pool) await pool.end();
  });

  it("each feature charges one ai_usage row, counted in the APP_TIMEZONE month", async () => {
    const r = await supertest(app).post("/api/rag/query").send({ query: "what colour is my bike" }).expect(200);
    assert.equal(r.body.answer, "It is red [1].");
    const d = await supertest(app).post("/api/ai/draft-email").send({ prompt: "say hi" }).expect(200);
    assert.equal(d.body.subject, "Hi");
    const charged = await rows();
    assert.deepEqual(charged.map((x) => [x.entry_type, x.model]), [["rag_query", "sonnet"], ["email_draft", "haiku"]]);
    const total = charged.reduce((s, x) => s + parseFloat(x.cost_cents), 0);
    assert.ok(total > 0);
    assert.ok(Math.abs((await ai.monthlyAiSpendCents(pool)) - total) < 1e-9);
    // A row from a minute before the zone's month start is last month's.
    const { month_start, tz } = ai.aiMonthStart();
    await q("INSERT INTO ai_usage (entry_type, model, input_tokens, output_tokens, cost_cents, created_at) VALUES ('old', 'haiku', 0, 0, 50, ($1::date::timestamp AT TIME ZONE $2) - interval '1 minute')", [month_start, tz]);
    assert.ok(Math.abs((await ai.monthlyAiSpendCents(pool)) - total) < 1e-9, "last month's row is not counted");
  });

  it("at the budget: the Knowledge answer is sources-only and the draft a 429, with no model call or row", async () => {
    await q("INSERT INTO ai_usage (entry_type, model, input_tokens, output_tokens, cost_cents) VALUES ('job_fit', 'haiku', 0, 0, 100)");
    const before = (await rows()).length;
    calls.length = 0;
    const r = await supertest(app).post("/api/rag/query").send({ query: "is my bike red" }).expect(200);
    assert.equal(r.body.answer, null);
    assert.equal(r.body.ai_cap, true);
    assert.ok(r.body.sources.length >= 1);
    assert.match(r.body.note, /^Monthly AI budget reached/);
    const d = await supertest(app).post("/api/ai/draft-email").send({ prompt: "say hi" }).expect(429);
    assert.equal(d.body.ai_cap, true);
    assert.deepEqual(calls, []);
    assert.equal((await rows()).length, before);
  });
});
