// Real-Postgres contract test for the cycle-8 E1 follow-ons:
//  - the migration gives a pre-E1c Resolve's tombstones (2+ csv snapshot
//    tombstones sharing one deleted_at, no batch id) one deterministic batch
//    id that the batch route accepts; a single delete and a re-run are left
//    alone
//  - GET /api/deleted-transactions' batches count the restorable rows (not a
//    bank-removed one, not one whose account is gone)
//  - a rename rule that folds a transfer / subscription into an existing row
//    carries the user's forecast setting onto it
//  - PATCH …/forecast on an incoming transfer is a 400 that changes nothing
const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const supertest = require("supertest");
const { SKIP, perfinDb, perfinApp } = require("./_setup");

describe("E1 follow-ons on real Postgres", { skip: SKIP }, () => {
  let pool, app, database, add;
  const q = (s, p) => pool.query(s, p);

  before(async () => {
    pool = await perfinDb("e1_followons");
    app = perfinApp();
    database = require("../../teller/services/database");
    const today = require("../../teller/services/financial-queries").todayStr();
    add = (n) => require("../../teller/services/cadence").addDaysStr(today, n);
    await q("INSERT INTO linked_accounts (account_id, name, type, subtype, is_manual) VALUES ('chk','Checking','depository','checking',true)");
  });
  after(async () => { if (pool) await pool.end(); });

  const snap = (id, account) => JSON.stringify({ row: { account_id: account, transaction_id: id, amount: 5, date: "2026-10-01", merchant_name: "Cafe", name: "CAFE", pending: false }, splits: [] });

  it("the migration gives a pre-E1c Resolve one batch id; singles and a re-run are left alone", async () => {
    const at = "2026-09-01T10:00:00.123456Z";
    for (const [id, acct] of [["csv_a", "chk"], ["csv_b", "chk"], ["csv_c", "gone"]]) {
      await q("INSERT INTO deleted_transactions (transaction_id, snapshot, source, deleted_at) VALUES ($1,$2::jsonb,'csv',$3)", [id, snap(id, acct), at]);
    }
    await q("INSERT INTO deleted_transactions (transaction_id, snapshot, source, deleted_at) VALUES ('csv_single',$1::jsonb,'csv','2026-09-02T00:00:00Z')", [snap("csv_single", "chk")]);
    await q("INSERT INTO deleted_transactions (transaction_id, snapshot, source, deleted_at) VALUES ('txn_x',$1::jsonb,'teller',$2)", [snap("txn_x", "chk"), at]);
    await database.runMigrations();
    const rows = (await q("SELECT transaction_id, batch_id FROM deleted_transactions ORDER BY transaction_id")).rows;
    const by = Object.fromEntries(rows.map((r) => [r.transaction_id, r.batch_id]));
    assert.ok(by.csv_a && by.csv_a === by.csv_b && by.csv_b === by.csv_c, JSON.stringify(by));
    assert.match(by.csv_a, require("../../teller/routes/transactions").BATCH_ID_RE);
    assert.match(by.csv_a, /_legacy$/);
    assert.equal(by.csv_single, null);
    assert.equal(by.txn_x, null);
    await database.runMigrations();
    const again = (await q("SELECT transaction_id, batch_id FROM deleted_transactions ORDER BY transaction_id")).rows;
    assert.deepEqual(again, rows, "a re-run changes nothing");
  });

  it("the list counts the restorable rows, and Restore all brings those back", async () => {
    const batch = (await q("SELECT batch_id FROM deleted_transactions WHERE transaction_id = 'csv_a'")).rows[0].batch_id;
    await q("UPDATE deleted_transactions SET bank_removed_at = now() WHERE transaction_id = 'csv_b'");
    const list = (await supertest(app).get("/api/deleted-transactions").expect(200)).body;
    const b = list.batches.find((x) => x.batch_id === batch);
    assert.equal(b.count, 3);
    assert.equal(b.restorable, 1, "csv_b removed by the bank, csv_c's account gone");
    const res = await supertest(app).post(`/api/deleted-transactions/batches/${batch}/restore`).expect(200);
    assert.equal(res.body.restored, 1);
    assert.deepEqual(res.body.skipped.map((s) => [s.transaction_id, s.reason]), [["csv_b", "removed_by_bank"], ["csv_c", "account_gone"]]);
  });

  it("a rename that folds a transfer and a subscription into existing rows keeps their forecast settings", async () => {
    const txn = (id, amount, date, merchant) => q(
      "INSERT INTO transactions (account_id, transaction_id, amount, date, merchant_name, name, pending) VALUES ('chk',$1,$2,$3,$4,$4,false)",
      [id, amount, date, merchant]);
    for (const [i, d] of [95, 65, 35, 5].entries()) {
      await txn("rentA" + i, 1500, add(-d), "Zelle to Jane Roe");
      await txn("rentB" + i, 1500, add(-d + 1), "Zelle to J Roe");
      await txn("tvA" + i, 15.49, add(-d), "Streamflix");
      await txn("tvB" + i, 15.49, add(-d + 1), "STREAMFLIX.COM");
    }
    await require("../../scripts/detect-subscriptions").detectSubscriptions(pool);
    await require("../../scripts/detect-transfers").detectRecurringTransfers(pool);
    const tr = (await q("SELECT id, merchant_key FROM recurring_transfers WHERE is_active AND direction = 'outgoing' AND merchant_key ILIKE '%roe%' ORDER BY merchant_key")).rows;
    const subs = (await q("SELECT id, merchant_key FROM detected_subscriptions WHERE is_active AND merchant_key ILIKE '%streamflix%' ORDER BY merchant_key")).rows;
    assert.equal(tr.length, 2, JSON.stringify(tr));
    assert.equal(subs.length, 2, JSON.stringify(subs));
    // The user corrects the rows the rename is about to retire.
    const oldTr = tr.find((r) => /j roe/i.test(r.merchant_key));
    const oldSub = subs.find((r) => /\.com/i.test(r.merchant_key));
    await supertest(app).patch(`/api/recurring-transfers/${oldTr.id}/forecast`).send({ treatment: "ignore" }).expect(200);
    await supertest(app).patch(`/api/subscriptions/${oldSub.id}/forecast`).send({ ignore: true }).expect(200);

    const mr = require("../../teller/routes/merchant-rename");
    const r1 = await mr.createRenameRule({ pattern: "Zelle to J Roe", matchType: "exact", renameTo: "Zelle to Jane Roe" }, pool);
    const r2 = await mr.createRenameRule({ pattern: "STREAMFLIX.COM", matchType: "exact", renameTo: "Streamflix" }, pool);
    assert.ok(!r1.error && !r2.error, JSON.stringify({ r1, r2 }));

    const keptTr = (await q("SELECT forecast_treatment FROM recurring_transfers WHERE is_active AND direction = 'outgoing' AND merchant_key ILIKE '%roe%'")).rows;
    assert.deepEqual(keptTr, [{ forecast_treatment: "ignore" }]);
    const keptSub = (await q("SELECT forecast_ignore FROM detected_subscriptions WHERE is_active AND merchant_key ILIKE '%streamflix%'")).rows;
    assert.deepEqual(keptSub, [{ forecast_ignore: true }]);
  });

  it("an incoming transfer's forecast setting is a 400 that changes nothing", async () => {
    const id = (await q(
      `INSERT INTO recurring_transfers (merchant_key, display_name, amount, cadence_days, first_seen, last_transferred, next_expected, is_active, transfer_type, direction)
       VALUES ('acme payroll','ACME PAYROLL',2000,14,$1,$2,$3,true,'other','incoming') RETURNING id`, [add(-60), add(-3), add(11)])).rows[0].id;
    await supertest(app).patch(`/api/recurring-transfers/${id}/forecast`).send({ treatment: "bill" }).expect(400);
    assert.equal((await q("SELECT forecast_treatment FROM recurring_transfers WHERE id = $1", [id])).rows[0].forecast_treatment, "auto");
  });
});
