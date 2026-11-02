// Real-Postgres contract test for cycle-8 E1c (G5) — undoing a whole
// CSV-overlap Resolve through the real routes:
//  - Resolve tags every tombstone with one batch id and returns it; GET
//    /api/deleted-transactions lists the batch with its count
//  - restoring the batch brings every row back with its notes and splits in
//    one go; a row the bank removed meanwhile stays deleted and is listed
//  - a second restore restores nothing; an emptied batch is a 404
//  - a single delete afterwards is not part of any batch
const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const supertest = require("supertest");
const { SKIP, perfinDb, perfinApp } = require("./_setup");

describe("Resolve undo (cycle-8 E1c) on real Postgres", { skip: SKIP }, () => {
  let pool, app, add, batchId;
  const q = (s, p) => pool.query(s, p);
  const tx = (id, acct, amt, merchant, date) => q(
    "INSERT INTO transactions (account_id, transaction_id, amount, date, merchant_name, name, pending) VALUES ($1,$2,$3,$4,$5,$5,false)",
    [acct, id, amt, date, merchant]);

  before(async () => {
    pool = await perfinDb("resolve_undo_e1c");
    app = perfinApp();
    const today = require("../../teller/services/financial-queries").todayStr();
    add = (n) => require("../../teller/services/cadence").addDaysStr(today, n);
    const pass = process.env.TOKEN_ENCRYPTION_PASSPHRASE;
    await q("INSERT INTO plaid_items (item_id, institution_name, access_token_enc, status) VALUES ('pi','Card', pgp_sym_encrypt('t', $1), 'GOOD')", [pass]);
    await q("INSERT INTO plaid_items (item_id, institution_name, access_token_enc, status) VALUES ('csv','Chase', 'x', 'CSV')");
    const pItem = (await q("SELECT id FROM plaid_items WHERE item_id='pi'")).rows[0].id;
    const cItem = (await q("SELECT id FROM plaid_items WHERE item_id='csv'")).rows[0].id;
    await q("INSERT INTO linked_accounts (plaid_item_id, account_id, name, type, subtype) VALUES ($1,'pc','Card','credit','credit card')", [pItem]);
    await q("INSERT INTO linked_accounts (plaid_item_id, account_id, name, type, subtype) VALUES ($1,'cc','Chase Account','credit','credit card')", [cItem]);
    for (const [i, m] of ["SAFEWAY 1234", "SHELL OIL 5", "TARGET T-99", "COSTCO WHSE 7"].entries()) {
      await tx("csv_r" + i, "cc", 20 + i, m, add(-10 - i));
      await tx("p_r" + i, "pc", 20 + i, m.split(" ")[0], add(-10 - i));
    }
    await q("UPDATE transactions SET user_notes = 'weekly shop' WHERE transaction_id = 'csv_r0'");
    await q("INSERT INTO transaction_splits (parent_transaction_id, amount, category) VALUES ('csv_r0', 12, 'Groceries'), ('csv_r0', 8, 'Household')");
  });
  after(async () => { if (pool) await pool.end(); });

  const ids = async () => (await q("SELECT id, account_id FROM linked_accounts WHERE account_id IN ('pc','cc')")).rows;

  it("Resolve tags every tombstone with one batch id, and the list shows the batch", async () => {
    const a = await ids();
    const res = await supertest(app).post("/api/transactions/csv-overlap/resolve")
      .send({ csv_account_id: a.find((r) => r.account_id === "cc").id, synced_account_id: a.find((r) => r.account_id === "pc").id }).expect(200);
    assert.equal(res.body.deleted, 4);
    batchId = res.body.batch_id;
    assert.match(batchId, /^resolve_[a-z0-9]+_[a-f0-9]+$/);
    const tombs = (await q("SELECT transaction_id, batch_id FROM deleted_transactions ORDER BY transaction_id")).rows;
    assert.deepEqual(tombs.map((t) => [t.transaction_id, t.batch_id]), [0, 1, 2, 3].map((i) => ["csv_r" + i, batchId]));
    const list = (await supertest(app).get("/api/deleted-transactions").expect(200)).body;
    assert.deepEqual(list.batches.map((b) => [b.batch_id, b.count]), [[batchId, 4]]);
    assert.ok(list.items.every((i) => i.batch_id === batchId));
  });

  it("restoring the batch brings the rows back with notes and splits; a bank-removed row stays deleted", async () => {
    await q("UPDATE deleted_transactions SET bank_removed_at = now() WHERE transaction_id = 'csv_r3'");
    const res = await supertest(app).post(`/api/deleted-transactions/batches/${batchId}/restore`).expect(200);
    assert.equal(res.body.restored, 3);
    assert.equal(res.body.already_present, 0);
    assert.equal(res.body.splits, 2);
    assert.deepEqual(res.body.skipped.map((s) => [s.transaction_id, s.reason]), [["csv_r3", "removed_by_bank"]]);

    const back = (await q("SELECT transaction_id, user_notes FROM transactions WHERE account_id = 'cc' ORDER BY transaction_id")).rows;
    assert.deepEqual(back.map((r) => r.transaction_id), ["csv_r0", "csv_r1", "csv_r2"]);
    assert.equal(back[0].user_notes, "weekly shop");
    const splits = (await q("SELECT amount::float AS amount, category FROM transaction_splits WHERE parent_transaction_id = 'csv_r0' ORDER BY amount")).rows;
    assert.deepEqual(splits, [{ amount: 8, category: "Household" }, { amount: 12, category: "Groceries" }]);
    const left = (await q("SELECT transaction_id, batch_id FROM deleted_transactions")).rows;
    assert.deepEqual(left, [{ transaction_id: "csv_r3", batch_id: batchId }]);
    const list = (await supertest(app).get("/api/deleted-transactions").expect(200)).body;
    assert.deepEqual(list.batches.map((b) => [b.batch_id, b.count]), [[batchId, 1]]);
  });

  it("a second restore restores nothing; an emptied batch is a 404", async () => {
    const again = await supertest(app).post(`/api/deleted-transactions/batches/${batchId}/restore`).expect(200);
    assert.equal(again.body.restored, 0);
    assert.equal(again.body.skipped.length, 1);
    assert.equal((await q("SELECT COUNT(*)::int AS n FROM transactions WHERE account_id = 'cc'")).rows[0].n, 3, "nothing duplicated");
    await q("DELETE FROM deleted_transactions WHERE transaction_id = 'csv_r3'");
    await supertest(app).post(`/api/deleted-transactions/batches/${batchId}/restore`).expect(404);
    await supertest(app).post("/api/deleted-transactions/batches/not-a-batch/restore").expect(400);
  });

  it("a single delete afterwards belongs to no batch", async () => {
    await supertest(app).delete("/api/transactions/csv_r1").expect(200);
    const t = (await q("SELECT batch_id FROM deleted_transactions WHERE transaction_id = 'csv_r1'")).rows[0];
    assert.equal(t.batch_id, null);
    const list = (await supertest(app).get("/api/deleted-transactions").expect(200)).body;
    assert.deepEqual(list.batches, []);
  });
});
