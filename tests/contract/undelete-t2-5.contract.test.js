// Real-Postgres contract tests for roadmap T2.5 U1 — transaction undelete.
// A deleted Teller / Plaid / CSV transaction keeps its snapshot, stays deleted
// through a reconcile, a re-delivery and a CSV re-import, and comes back with
// its category, notes and splits through POST /api/deleted-transactions/:id/
// restore — once, never duplicated by the next sync. Only Teller's HTTP client
// and a Plaid client object are stubbed.
const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const supertest = require("supertest");
const { SKIP, perfinDb, perfinApp } = require("./_setup");

describe("transaction undelete on real Postgres", { skip: SKIP }, () => {
  let pool, app, enrollments, investments, today;
  const q = (s, p) => pool.query(s, p);
  const PASS = () => process.env.TOKEN_ENCRYPTION_PASSPHRASE;
  const daysAgo = (n) => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);
  let tellerTxns = [];

  before(async () => {
    pool = await perfinDb("undelete");
    today = require("../../teller/services/financial-queries").todayStr();
    const tellerApi = require("../../teller/services/teller-api");
    tellerApi.tellerRequest = async (endpoint) => {
      if (endpoint === "/accounts") return [{ id: "tchk", name: "Checking", type: "depository", subtype: "checking", last_four: "1111" }];
      if (endpoint.endsWith("/balances")) return { account_id: "tchk", ledger: "100.00", available: "100.00" };
      if (endpoint.includes("/transactions")) return endpoint.includes("from_id") ? [] : tellerTxns;
      return {};
    };
    enrollments = require("../../teller/routes/enrollments");
    investments = require("../../teller/routes/investments");
    app = perfinApp();
    await q("INSERT INTO teller_enrollments (enrollment_id, institution_name, access_token_enc, status) VALUES ('e1','Bank', pgp_sym_encrypt('tok', $1), 'GOOD')", [PASS()]);
    const enr = (await q("SELECT id FROM teller_enrollments")).rows[0].id;
    await q("INSERT INTO linked_accounts (teller_enrollment_id, account_id, name, type, subtype) VALUES ($1,'tchk','Checking','depository','checking')", [enr]);
    await q("INSERT INTO plaid_items (item_id, institution_name, access_token_enc, status) VALUES ('pi1','Card', pgp_sym_encrypt('ptok', $1), 'GOOD')", [PASS()]);
    const pItem = (await q("SELECT id FROM plaid_items WHERE item_id='pi1'")).rows[0].id;
    await q("INSERT INTO linked_accounts (plaid_item_id, account_id, name, type, subtype) VALUES ($1,'pcard','Card','credit','credit card')", [pItem]);
  });
  after(async () => { if (pool) await pool.end(); });

  it("a Teller row keeps its snapshot, survives the reconcile, and restores with its edits and splits — once", async () => {
    tellerTxns = [
      { id: "t_cafe", amount: "-12.00", date: daysAgo(3), description: "CAFE 42", status: "posted", details: { counterparty: { name: "Cafe" } } },
      { id: "t_keep", amount: "-30.00", date: daysAgo(3), description: "GROCER", status: "posted", details: { counterparty: { name: "Grocer" } } },
    ];
    await enrollments.syncAllEnrollments();
    await supertest(app).patch("/api/transactions/t_cafe").send({ merchant_name: "Corner Cafe", notes: "with Sam" }).expect(200);
    await supertest(app).patch("/api/transactions/t_cafe/category").send({ category: "Food & Drink" }).expect(200);
    await supertest(app).post("/api/transactions/t_cafe/splits")
      .send({ splits: [{ amount: 8, category: "Dining" }, { amount: 4, category: "Gifts", notes: "card" }] }).expect(200);

    await supertest(app).delete("/api/transactions/t_cafe").expect(200);
    const tomb = (await q("SELECT source, snapshot FROM deleted_transactions WHERE transaction_id='t_cafe'")).rows[0];
    assert.equal(tomb.source, "teller");
    assert.equal(tomb.snapshot.row.user_category, "Food & Drink");
    assert.equal(tomb.snapshot.splits.length, 2);
    assert.equal((await q("SELECT 1 FROM transaction_splits WHERE parent_transaction_id='t_cafe'")).rows.length, 0, "splits went with the row");

    await enrollments.reconcileTeller(90);
    assert.equal((await q("SELECT 1 FROM transactions WHERE transaction_id='t_cafe'")).rows.length, 0, "still deleted");

    const r = await supertest(app).post("/api/deleted-transactions/t_cafe/restore").expect(200);
    assert.deepEqual(r.body, { restored: true, transaction_id: "t_cafe", already_present: false, splits: 2 });
    const back = (await q(`SELECT amount, date::text AS date, user_merchant_name, user_notes, user_category, account_id
                           FROM transactions WHERE transaction_id='t_cafe'`)).rows[0];
    assert.deepEqual(back, { amount: "12.00", date: daysAgo(3), user_merchant_name: "Corner Cafe", user_notes: "with Sam", user_category: "Food & Drink", account_id: "tchk" });
    const splits = (await q("SELECT amount, category, notes FROM transaction_splits WHERE parent_transaction_id='t_cafe' ORDER BY amount DESC")).rows;
    assert.deepEqual(splits, [{ amount: "8.00", category: "Dining", notes: null }, { amount: "4.00", category: "Gifts", notes: "card" }]);
    assert.equal((await q("SELECT 1 FROM deleted_transactions WHERE transaction_id='t_cafe'")).rows.length, 0);

    // The next sync updates it like any row and doesn't duplicate it.
    await enrollments.reconcileTeller(90);
    const after = (await q("SELECT COUNT(*)::int AS n, MAX(user_category) AS cat FROM transactions WHERE transaction_id='t_cafe'")).rows[0];
    assert.deepEqual(after, { n: 1, cat: "Food & Drink" });
    await supertest(app).post("/api/deleted-transactions/t_cafe/restore").expect(404);
  });

  it("a Plaid row is skipped by a re-delivery while deleted and restored after", async () => {
    const item = (await q("SELECT id FROM plaid_items WHERE item_id='pi1'")).rows[0].id;
    const page = { added: [
      { account_id: "pcard", transaction_id: "p_spot", amount: 9.99, date: today, name: "SPOTIFY", merchant_name: "Spotify", pending: false, category: ["Service", "Music"] },
    ], modified: [], removed: [], next_cursor: "c1", has_more: false };
    const client = { transactionsSync: async () => ({ data: page }) };
    await investments.syncPlaidItemTransactions(client, item, "ptok");
    await supertest(app).delete("/api/transactions/p_spot").expect(200);
    assert.equal((await q("SELECT source FROM deleted_transactions WHERE transaction_id='p_spot'")).rows[0].source, "plaid");
    await q("UPDATE sync_cursors SET cursor = '' WHERE plaid_item_id = $1", [item]);
    assert.equal((await investments.syncPlaidItemTransactions(client, item, "ptok")).added, 0);

    await supertest(app).post("/api/deleted-transactions/p_spot/restore").expect(200);
    const row = (await q("SELECT category, merchant_name FROM transactions WHERE transaction_id='p_spot'")).rows[0];
    assert.deepEqual(row, { category: ["Service", "Music"], merchant_name: "Spotify" }, "the text[] category survives the round trip");
    await q("UPDATE sync_cursors SET cursor = '' WHERE plaid_item_id = $1", [item]);
    assert.equal((await investments.syncPlaidItemTransactions(client, item, "ptok")).added, 0, "not counted as new, not duplicated");
    assert.equal((await q("SELECT COUNT(*)::int AS n FROM transactions WHERE transaction_id='p_spot'")).rows[0].n, 1);
  });

  it("a re-imported CSV file skips a deleted row until it's restored", async () => {
    const CSV = [
      "Transaction Date,Post Date,Description,Category,Type,Amount",
      "09/10/2026,09/11/2026,Bakery,Food & Drink,Sale,-6.50",
      "09/12/2026,09/13/2026,Bookstore,Shopping,Sale,-18.00",
    ].join("\n");
    const imp = await supertest(app).post("/api/import-csv").attach("file", Buffer.from(CSV), "chase.csv").expect(200);
    assert.equal(imp.body.rows_imported, 2);
    const id = (await q("SELECT transaction_id FROM transactions WHERE merchant_name='Bakery'")).rows[0].transaction_id;
    await supertest(app).delete("/api/transactions/" + encodeURIComponent(id)).expect(200);
    assert.equal((await q("SELECT source FROM deleted_transactions WHERE transaction_id=$1", [id])).rows[0].source, "csv");

    const prev = await supertest(app).post("/api/import-csv/preview").attach("file", Buffer.from(CSV), "chase.csv").expect(200);
    assert.deepEqual([prev.body.rows_new, prev.body.rows_duplicate, prev.body.rows_deleted], [0, 1, 1]);
    const again = await supertest(app).post("/api/import-csv").attach("file", Buffer.from(CSV), "chase.csv").expect(200);
    assert.deepEqual([again.body.rows_imported, again.body.rows_duplicate, again.body.rows_deleted], [0, 1, 1]);
    assert.equal((await q("SELECT 1 FROM transactions WHERE transaction_id=$1", [id])).rows.length, 0);

    await supertest(app).post("/api/deleted-transactions/" + encodeURIComponent(id) + "/restore").expect(200);
    const third = await supertest(app).post("/api/import-csv").attach("file", Buffer.from(CSV), "chase.csv").expect(200);
    assert.deepEqual([third.body.rows_imported, third.body.rows_duplicate, third.body.rows_deleted], [0, 2, 0]);
  });

  it("restore is refused, changing nothing, once the account is gone", async () => {
    const acct = await supertest(app).post("/api/accounts/manual").send({ name: "Cash", type: "depository" }).expect(200);
    const m = await supertest(app).post("/api/transactions/manual")
      .send({ account_id: acct.body.account_id, amount: 15, date: today, merchant_name: "Farmers market" }).expect(200);
    await supertest(app).delete("/api/transactions/" + m.body.transaction_id).expect(200);
    assert.equal((await q("SELECT source FROM deleted_transactions WHERE transaction_id=$1", [m.body.transaction_id])).rows[0].source, "manual");
    await supertest(app).delete("/api/accounts/manual/" + acct.body.id).expect(200);
    const r = await supertest(app).post("/api/deleted-transactions/" + m.body.transaction_id + "/restore").expect(409);
    assert.match(r.body.error, /no longer connected/);
    assert.equal((await q("SELECT 1 FROM deleted_transactions WHERE transaction_id=$1", [m.body.transaction_id])).rows.length, 1);
    assert.equal((await q("SELECT 1 FROM transactions WHERE transaction_id=$1", [m.body.transaction_id])).rows.length, 0);
  });

  it("lists newest first across pages, and lifts a legacy tombstone with how the row returns", async () => {
    await q("INSERT INTO deleted_transactions (transaction_id, deleted_at) VALUES ('csv_legacy', now() - interval '30 days')");
    const first = await supertest(app).get("/api/deleted-transactions?limit=1").expect(200);
    assert.equal(first.body.items.length, 1);
    assert.ok(first.body.next);
    const all = [first.body.items[0]];
    let next = first.body.next;
    for (let guard = 0; next; guard++) {
      assert.ok(guard < 20, "the cursor moves forward");
      const page = await supertest(app).get("/api/deleted-transactions?limit=1&before=" + encodeURIComponent(next)).expect(200);
      all.push(...page.body.items);
      next = page.body.next;
    }
    assert.equal(new Set(all.map((x) => x.transaction_id)).size, all.length, "no row repeated across pages");
    const legacy = all[all.length - 1];
    assert.deepEqual([legacy.transaction_id, legacy.legacy, legacy.source, legacy.restorable], ["csv_legacy", true, "csv", true]);
    const manual = all.find((x) => x.source === "manual");
    assert.deepEqual([manual.merchant, manual.amount, manual.account_name, manual.legacy], ["Farmers market", 15, null, false]);

    const r = await supertest(app).post("/api/deleted-transactions/csv_legacy/restore").expect(200);
    assert.deepEqual(r.body, { restored: false, cleared: true, transaction_id: "csv_legacy", source: "csv", returns_on: "csv_reimport" });
    assert.equal((await q("SELECT 1 FROM deleted_transactions WHERE transaction_id='csv_legacy'")).rows.length, 0);
  });
});
