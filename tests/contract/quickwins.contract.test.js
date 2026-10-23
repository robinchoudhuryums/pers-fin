// Real-Postgres contract tests for roadmap T1.5 Batch B:
//  B2 — GET /api/budgets/one-time lists one-month budgets with their month (and
//    not recurring ones), so the Budgets page can link to another month.
//  B3 — PATCH /api/merchant-rename-rules/:id: a new name renames the rows the
//    rule renamed and its detected subscription (one row, notes kept), a
//    hand-renamed row stays; turning the rule off reverts its rows and keeps the
//    rule; turning it back on re-applies it.
const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const supertest = require("supertest");
const { SKIP, perfinDb, perfinApp } = require("./_setup");

const daysAgo = (n) => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);

describe("Roadmap T1.5 Batch B on real Postgres", { skip: SKIP }, () => {
  let pool, app;
  const q = (s, p) => pool.query(s, p);
  const names = async () => Object.fromEntries((await q("SELECT transaction_id, user_merchant_name FROM transactions WHERE transaction_id LIKE 'sp%'")).rows
    .map((x) => [x.transaction_id, x.user_merchant_name]));
  const subRows = () => q("SELECT merchant_key, notes FROM detected_subscriptions WHERE merchant_key IN ('SPOTIFY USA', 'Spotify', 'Spotify Family') ORDER BY merchant_key").then((r) => r.rows);

  before(async () => {
    pool = await perfinDb("quickwins");
    app = perfinApp();
    await q("INSERT INTO plaid_items (item_id, institution_name, access_token_enc, status) VALUES ('i1','Bank','x','GOOD')");
    const item = (await q("SELECT id FROM plaid_items")).rows[0].id;
    await q(`INSERT INTO linked_accounts (plaid_item_id, account_id, name, type, subtype, current_balance)
             VALUES ($1,'card','card','credit','credit card',0)`, [item]);
    const tx = (id, amount, date, user) => q(
      `INSERT INTO transactions (account_id, transaction_id, amount, date, merchant_name, name, user_merchant_name, pending)
       VALUES ('card', $1, $2, $3, 'SPOTIFY USA', 'SPOTIFY USA', $4, false)`, [id, amount, date, user || null]);
    await tx("sp1", 16.99, daysAgo(90));
    await tx("sp2", 16.99, daysAgo(60));
    await tx("sp3", 16.99, daysAgo(30));
    await tx("sp_hand", 40, daysAgo(10), "Concert tickets");
    await supertest(app).post("/api/detect").expect(200);
    await q("UPDATE detected_subscriptions SET notes = 'family plan' WHERE merchant_key = 'SPOTIFY USA'");
  });
  after(async () => { if (pool) await pool.end(); });

  it("B2: GET /api/budgets/one-time lists one-month budgets only", async () => {
    await supertest(app).post("/api/budgets").send({ category: "Gifts", monthly_limit: 200, budget_type: "one_time", effective_month: "2031-12" }).expect(200);
    await supertest(app).post("/api/budgets").send({ category: "Groceries", monthly_limit: 400 }).expect(200);
    const list = (await supertest(app).get("/api/budgets/one-time").expect(200)).body.budgets;
    assert.deepEqual(list.map((b) => [b.category, b.effective_month]), [["Gifts", "2031-12"]]);
    // ...and the viewed month's GET still serves it there, an array as before.
    const dec = (await supertest(app).get("/api/budgets?month=2031-12").expect(200)).body;
    assert.ok(Array.isArray(dec));
    assert.ok(dec.some((b) => b.category === "Gifts"));
  });

  let id;
  it("B3: a new name follows the rule's rows and its subscription, keeping notes", async () => {
    const created = await supertest(app).patch("/api/transactions/sp3").send({ merchant_name: "Spotify", apply_to_all: true }).expect(200);
    id = created.body.rename_rule.id;
    assert.deepEqual(await subRows(), [{ merchant_key: "Spotify", notes: "family plan" }]);

    const r = await supertest(app).patch("/api/merchant-rename-rules/" + id).send({ rename_to: "Spotify Family" }).expect(200);
    assert.equal(r.body.rule.rename_to, "Spotify Family");
    assert.equal(r.body.redetected, true);
    assert.deepEqual(await names(), { sp1: "Spotify Family", sp2: "Spotify Family", sp3: "Spotify Family", sp_hand: "Concert tickets" });
    assert.deepEqual(await subRows(), [{ merchant_key: "Spotify Family", notes: "family plan" }], "one row, re-keyed, notes kept");
  });

  it("B3: turning the rule off reverts its rows and keeps the rule; on re-applies it", async () => {
    const off = await supertest(app).patch("/api/merchant-rename-rules/" + id).send({ is_active: false }).expect(200);
    assert.equal(off.body.reverted, 3);
    assert.deepEqual(await names(), { sp1: null, sp2: null, sp3: null, sp_hand: "Concert tickets" });
    const list = (await supertest(app).get("/api/merchant-rename-rules").expect(200)).body.rules;
    assert.deepEqual(list.map((x) => [x.id, x.is_active]), [[id, false]]);

    await supertest(app).patch("/api/merchant-rename-rules/" + id).send({ is_active: true }).expect(200);
    assert.deepEqual(await names(), { sp1: "Spotify Family", sp2: "Spotify Family", sp3: "Spotify Family", sp_hand: "Concert tickets" });
    assert.deepEqual(await subRows(), [{ merchant_key: "Spotify Family", notes: "family plan" }]);
  });

  it("B3: rejects bad bodies and unknown rules", async () => {
    await supertest(app).patch("/api/merchant-rename-rules/" + id).send({}).expect(400);
    await supertest(app).patch("/api/merchant-rename-rules/" + id).send({ is_active: "no" }).expect(400);
    await supertest(app).patch("/api/merchant-rename-rules/" + id).send({ rename_to: "" }).expect(400);
    await supertest(app).patch("/api/merchant-rename-rules/999999").send({ rename_to: "X" }).expect(404);
  });
});
