// Real-Postgres contract tests (TQ-2): per-transaction writes and CSV import,
// through EVERY Perfin router mounted in teller/server.js order. Regression
// class: DC-1 — PATCH /api/transactions/:id (an earlier module) captured
// /api/transactions/bulk-category and 400'd every bulk recategorize; a test
// that mounts one module at a time can't see route shadowing.
const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const supertest = require("supertest");
const { SKIP, perfinDb, perfinApp } = require("./_setup");

describe("transaction writes + CSV import on real Postgres (full mount order)", { skip: SKIP }, () => {
  let pool, app, cm;
  const q = (s, p) => pool.query(s, p);

  before(async () => {
    pool = await perfinDb("txn");
    app = perfinApp();
    cm = require("../../teller/services/financial-queries").currentMonth();
    await q("INSERT INTO plaid_items (item_id, institution_name, access_token_enc, status) VALUES ('g','Bank','x','GOOD')");
    const item = (await q("SELECT id FROM plaid_items")).rows[0].id;
    await q("INSERT INTO linked_accounts (plaid_item_id, account_id, name, type, subtype) VALUES ($1,'card','Card','credit','credit card')", [item]);
    for (const [id, amt, m] of [["a", 20, "SHOP A"], ["b", 35, "SHOP B"], ["c", 120, "TARGET"]]) {
      await q("INSERT INTO transactions (account_id, transaction_id, amount, date, merchant_name, name, pending) VALUES ('card',$1,$2,$3,$4,$4,false)", [id, amt, cm + "-01", m]);
    }
  });
  after(async () => { if (pool) await pool.end(); });

  it("bulk-category is reachable (not shadowed by PATCH /api/transactions/:id) and writes user_category", async () => {
    const r = await supertest(app).patch("/api/transactions/bulk-category").send({ transaction_ids: ["a", "b"], category: "Groceries" });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const rows = (await q("SELECT transaction_id, user_category, category FROM transactions WHERE transaction_id IN ('a','b') ORDER BY 1")).rows;
    assert.deepEqual(rows.map((x) => x.user_category), ["Groceries", "Groceries"]);
    assert.equal(rows[0].category, null, "the provider category column is untouched (INV-12)");
  });

  it("PATCH /api/transactions/:id keeps user overrides in user_* columns", async () => {
    await supertest(app).patch("/api/transactions/a").send({ merchant_name: "Corner Shop", notes: "gift", is_reimbursed: true }).expect(200);
    const row = (await q("SELECT merchant_name, user_merchant_name, user_notes, is_reimbursed FROM transactions WHERE transaction_id='a'")).rows[0];
    assert.deepEqual(row, { merchant_name: "SHOP A", user_merchant_name: "Corner Shop", user_notes: "gift", is_reimbursed: true });
  });

  it("splits: sum must match the parent ±$0.01; stored splits replace the parent per category", async () => {
    await supertest(app).post("/api/transactions/c/splits").send({ splits: [{ amount: 70, category: "Groceries" }, { amount: 40, category: "Household" }] }).expect(400);
    await supertest(app).post("/api/transactions/c/splits").send({ splits: [{ amount: 70, category: "Groceries" }, { amount: 50, category: "Household" }] }).expect(200);
    const got = (await supertest(app).get("/api/transactions/c/splits").expect(200)).body;
    assert.equal((got.splits || got).length, 2);
    const cats = (await supertest(app).get("/api/spending-categories?month=" + cm).expect(200)).body;
    const s = JSON.stringify(cats);
    assert.ok(s.includes("Household") && !s.includes("TARGET"), "the split lines, not the parent, are categorized");
    await supertest(app).delete("/api/transactions/c/splits").expect(200);
  });

  it("manual cash entry needs a manual account and stores a text[] category verbatim (DC-14/DC-15)", async () => {
    await supertest(app).post("/api/transactions/manual").send({ account_id: "card", amount: 9, date: cm + "-01" }).expect(400);
    const acct = (await supertest(app).post("/api/accounts/manual").send({ name: "Cash", type: "depository", subtype: "cash" }).expect(200)).body;
    const m = (await supertest(app).post("/api/transactions/manual")
      .send({ account_id: acct.account_id, amount: 9, date: cm + "-01", category: 'Travel, "Air" {x}', notes: "taxi" }).expect(200)).body;
    const row = (await q("SELECT amount, category, user_notes FROM transactions WHERE transaction_id=$1", [m.transaction_id])).rows[0];
    assert.equal(parseFloat(row.amount), 9);
    assert.deepEqual(row.category, ['Travel, "Air" {x}']);
    assert.equal(row.user_notes, "taxi");
  });

  it("CSV preview → import → re-import dedups, with the same IDs the preview predicted", async () => {
    const CSV = ["Transaction Date,Post Date,Description,Category,Type,Amount",
      "08/15/2026,08/16/2026,Grocer,Groceries,Sale,-50.00",
      "08/15/2026,08/16/2026,Grocer,Groceries,Sale,-50.00",
      "09/10/2026,09/11/2026,Cafe,Food & Drink,Sale,-20.00",
      "bad row"].join("\n");
    const prev = (await supertest(app).post("/api/import-csv/preview").attach("file", Buffer.from(CSV), "chase.csv").expect(200)).body;
    assert.equal(prev.rows_new, 3, "two identical same-day rows are distinct (F1)");
    const imp = (await supertest(app).post("/api/import-csv").attach("file", Buffer.from(CSV), "chase.csv").expect(200)).body;
    assert.equal(imp.rows_imported, 3);
    assert.equal(imp.rows_skipped, prev.rows_skipped, "preview and commit agree on unparseable rows");
    const again = (await supertest(app).post("/api/import-csv").attach("file", Buffer.from(CSV), "chase.csv").expect(200)).body;
    assert.equal(again.rows_imported, 0);
    assert.equal(again.rows_duplicate, 3);
    const hist = (await supertest(app).get("/api/csv-imports").expect(200)).body;
    assert.ok((hist.imports || hist).length >= 2);
  });
});
