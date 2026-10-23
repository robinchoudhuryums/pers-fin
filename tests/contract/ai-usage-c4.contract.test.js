// Real-Postgres contract test for roadmap T2.3 C4 — the AI budget made visible,
// with both apps' real databases wired the way the shell wires them:
//  - GET /per-sistant /api/ai/usage reports this month's ai_usage rows grouped
//    by feature, with spent_cents equal to the cap's own monthlyAiSpendCents
//    (a row from before the APP_TIMEZONE month start left out)
//  - PATCH /api/settings ai_monthly_budget_cents sets the cap (source
//    "settings"), a bad value is a 400 that changes nothing, null goes back
//    to the default — and the cap the wrappers enforce follows it
//  - the usage carries Perfin's month spend + cap (perfinPool), and Perfin's
//    GET /api/insights/status carries Per-sistant's (persistentPool)
const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const supertest = require("supertest");
const { SKIP, perfinDb, persistentDb, perfinApp, persistentApp } = require("./_setup");

describe("Per-sistant AI usage + budget (T2.3 C4) on real Postgres", { skip: SKIP }, () => {
  let psPool, pfPool, psApp, pfApp, ai;
  const saved = {};
  const q = (s, p) => psPool.query(s, p);

  before(async () => {
    for (const k of ["APP_TIMEZONE", "PERSISTENT_AI_BUDGET_CENTS", "INSIGHTS_MONTHLY_BUDGET_CENTS"]) saved[k] = process.env[k];
    process.env.APP_TIMEZONE = "Pacific/Kiritimati"; // a month start that differs from UTC's
    delete process.env.PERSISTENT_AI_BUDGET_CENTS;
    process.env.INSIGHTS_MONTHLY_BUDGET_CENTS = "75";
    psPool = await persistentDb("ai_usage");
    pfPool = await perfinDb("ai_usage");
    ai = require("../../apps/per-sistant/ai");
    psApp = persistentApp(psPool);
    psApp.set("perfinPool", pfPool);
    pfApp = perfinApp();
    pfApp.set("persistentPool", psPool);
    const { month_start, tz } = ai.aiMonthStart();
    const ins = "INSERT INTO ai_usage (entry_type, model, input_tokens, output_tokens, cost_cents, created_at) VALUES ($1, 'haiku', 0, 0, $2, $3)";
    await q(ins, ["rag_query", 10.5, new Date()]);
    await q(ins, ["rag_query", 4.25, new Date()]);
    await q(ins, ["email_draft", 1.125, new Date()]);
    // A minute before the zone's month start: last month's.
    await q("INSERT INTO ai_usage (entry_type, model, input_tokens, output_tokens, cost_cents, created_at) VALUES ('old', 'haiku', 0, 0, 99, ($1::date::timestamp AT TIME ZONE $2) - interval '1 minute')", [month_start, tz]);
    // Perfin: one insight usage row this month (priced at read time).
    await pfPool.query("INSERT INTO financial_insights (insight_text, model_used, tokens_used, input_tokens, output_tokens, entry_type) VALUES ('x', 'claude-haiku-5-5', 300000, 200000, 100000, 'ask')");
  });
  after(async () => {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    if (psPool) await psPool.end();
    if (pfPool) await pfPool.end();
  });

  it("GET /api/ai/usage: this month's rows by feature, matching the cap's own spend", async () => {
    const r = await supertest(psApp).get("/api/ai/usage").expect(200);
    assert.equal(r.body.month, ai.aiMonthStart().month_start.slice(0, 7));
    assert.deepEqual(r.body.by_feature, [
      { entry_type: "rag_query", calls: 2, cents: 14.75 },
      { entry_type: "email_draft", calls: 1, cents: 1.13 },
    ]);
    assert.equal(r.body.spent_cents, 15.88);
    assert.ok(Math.abs((await ai.monthlyAiSpendCents(psPool)) - 15.875) < 1e-9);
    assert.equal(r.body.budget_cents, 100);
    assert.equal(r.body.budget_source, "default");
  });

  it("PATCH sets the cap the wrappers enforce; a bad value is a 400; null resets", async () => {
    await supertest(psApp).patch("/api/settings").send({ ai_monthly_budget_cents: 15 }).expect(200);
    let u = (await supertest(psApp).get("/api/ai/usage").expect(200)).body;
    assert.equal(u.budget_cents, 15);
    assert.equal(u.budget_source, "settings");
    // 15.875 spent ≥ 15 → the wrapper refuses before any model call.
    await assert.rejects(ai.cappedAI(psPool, { entry_type: "email_draft", model: "haiku", prompt: "hi", maxTokens: 10 }), (e) => e.code === "CAP");
    await supertest(psApp).patch("/api/settings").send({ ai_monthly_budget_cents: 1.5 }).expect(400);
    assert.equal((await q("SELECT ai_monthly_budget_cents FROM user_settings WHERE id = 1")).rows[0].ai_monthly_budget_cents, 15);
    await supertest(psApp).patch("/api/settings").send({ ai_monthly_budget_cents: null }).expect(200);
    u = (await supertest(psApp).get("/api/ai/usage").expect(200)).body;
    assert.deepEqual([u.budget_cents, u.budget_source], [100, "default"]);
  });

  it("side by side: Perfin's spend in Per-sistant's usage, Per-sistant's in Perfin's status", async () => {
    const u = (await supertest(psApp).get("/api/ai/usage").expect(200)).body;
    assert.ok(u.perfin, "perfin figures present when perfinPool is wired");
    assert.equal(u.perfin.budget_cents, 75);
    assert.ok(u.perfin.spent_cents > 0);
    const insights = require("../../teller/routes/insights");
    assert.ok(Math.abs(u.perfin.spent_cents - Math.round((await insights.monthAiSpendCents(pfPool)) * 100) / 100) < 1e-9);
    const st = (await supertest(pfApp).get("/api/insights/status").expect(200)).body;
    assert.deepEqual(st.persistent_ai, { spent_cents: 15.88, budget_cents: 100 });
  });
});
