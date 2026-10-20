// Real-Postgres contract tests for the cycle-7 Batch 10 budget write (F39):
// re-saving a category from the Add form (category + limit only) keeps its
// rollover, one-time type, month and notes; sent fields are stored; and a
// one-time budget shows only in its own month.
const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const supertest = require("supertest");
const { SKIP, perfinDb, perfinApp } = require("./_setup");

describe("Budget writes on real Postgres", { skip: SKIP }, () => {
  let pool, app, thisMonth;
  const q = (s, p) => pool.query(s, p);

  before(async () => {
    pool = await perfinDb("uiwrites");
    app = perfinApp();
    thisMonth = require("../../teller/services/financial-queries").currentMonth();
  });
  after(async () => { if (pool) await pool.end(); });

  it("F39: the Add form re-saving a category keeps its rollover and notes", async () => {
    await supertest(app).post("/api/budgets").send({ category: "Dining", monthly_limit: 300, rollover_enabled: true, notes: "date nights" }).expect(200);
    await supertest(app).post("/api/budgets").send({ category: "Dining", monthly_limit: 350 }).expect(200);
    const row = (await q("SELECT monthly_limit::float AS l, rollover_enabled, budget_type, notes FROM budgets WHERE category = 'Dining'")).rows[0];
    assert.deepEqual(row, { l: 350, rollover_enabled: true, budget_type: "recurring", notes: "date nights" });
  });

  it("F39: a one-time budget keeps its month across a re-save and shows only in that month", async () => {
    const [y, m] = thisMonth.split("-").map(Number);
    const next = m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, "0")}`;
    await supertest(app).post("/api/budgets").send({ category: "Gifts", monthly_limit: 200, budget_type: "one_time", effective_month: next }).expect(200);
    await supertest(app).post("/api/budgets").send({ category: "Gifts", monthly_limit: 250 }).expect(200);
    const row = (await q("SELECT budget_type, effective_month FROM budgets WHERE category = 'Gifts'")).rows[0];
    assert.deepEqual(row, { budget_type: "one_time", effective_month: next });
    const now = (await supertest(app).get("/api/budgets").expect(200)).body.map((b) => b.category);
    assert.ok(!now.includes("Gifts"), "not in this month's list");
    const then = (await supertest(app).get("/api/budgets?month=" + next).expect(200)).body.map((b) => b.category);
    assert.ok(then.includes("Gifts"));
    // Sending the type explicitly switches it back to recurring and clears the month.
    await supertest(app).post("/api/budgets").send({ category: "Gifts", monthly_limit: 250, budget_type: "recurring" }).expect(200);
    const back = (await q("SELECT budget_type, effective_month FROM budgets WHERE category = 'Gifts'")).rows[0];
    assert.deepEqual(back, { budget_type: "recurring", effective_month: null });
  });

  it("F39: the rollover toggle (PATCH) turns it off and on", async () => {
    const id = (await q("SELECT id FROM budgets WHERE category = 'Dining'")).rows[0].id;
    await supertest(app).patch("/api/budgets/" + id).send({ rollover_enabled: false }).expect(200);
    assert.equal((await q("SELECT rollover_enabled FROM budgets WHERE id = $1", [id])).rows[0].rollover_enabled, false);
  });
});
