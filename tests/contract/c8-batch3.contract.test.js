// Real-Postgres contract test for the cycle-8 broad scan, Batch 3 — detection,
// rename and restore integrity:
//  - F41: a specific rename rule created over rows a broad rule already owns
//    takes those rows; the broad rule's cancelled subscription keeps its key
//    and state, and detection doesn't re-create it as active
//  - F46: a price change survives a detection run with no new charge
//  - F47: a charge more than 10% above the subscription's price alerts once
//    (not for a utility, not for a 2x charge)
//  - F4: CSV-overlap Resolve tombstones (with snapshots) the rows it deletes
//  - F5: a restored row drops the rename of a rule deleted while it was gone,
//    and takes a renamed rule's current name
//  - F6: a Plaid id the bank removed while deleted isn't restored; one the
//    bank changed is restored and flagged stale
//  - F54: /api/income-summary groups a renamed payroll source under its name
const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const supertest = require("supertest");
const { SKIP, perfinDb, perfinApp } = require("./_setup");

describe("cycle-8 Batch 3 on real Postgres", { skip: SKIP }, () => {
  let pool, app, rename, subs, investments, detect, add, today;
  const q = (s, p) => pool.query(s, p);
  const PASS = () => process.env.TOKEN_ENCRYPTION_PASSPHRASE;
  const tx = (id, acct, amt, merchant, date) => q(
    "INSERT INTO transactions (account_id, transaction_id, amount, date, merchant_name, name, pending) VALUES ($1,$2,$3,$4,$5,$5,false)",
    [acct, id, amt, date, merchant]);
  const nameOf = async (id) => (await q("SELECT user_merchant_name, user_merchant_rule_id FROM transactions WHERE transaction_id = $1", [id])).rows[0];

  before(async () => {
    pool = await perfinDb("c8_batch3");
    const fq = require("../../teller/services/financial-queries");
    today = fq.todayStr();
    add = (n) => require("../../teller/services/cadence").addDaysStr(today, n);
    rename = require("../../teller/routes/merchant-rename");
    subs = require("../../teller/routes/subscriptions");
    investments = require("../../teller/routes/investments");
    detect = require("../../scripts/detect-subscriptions");
    app = perfinApp();
    await q("INSERT INTO linked_accounts (account_id, name, type, subtype, is_manual) VALUES ('chk','Checking','depository','checking',true)");
  });
  after(async () => { if (pool) await pool.end(); });

  // ---------------------------------------------------------------- F41
  it("F41: a specific rule takes rows a broad rule owns; the broad rule's cancelled subscription stays put", async () => {
    for (const n of [95, 65, 35, 5]) await tx("prime" + n, "chk", 14.99, "AMAZON PRIME", add(-n));
    await tx("mkt1", "chk", 42.10, "AMAZON MKTPLACE", add(-20));
    await tx("mkt2", "chk", 8.75, "AMAZON MKTPLACE", add(-12));
    const broad = await rename.createRenameRule({ pattern: "amazon", matchType: "contains", renameTo: "Amazon" });
    assert.ok(!broad.error, broad.error);
    assert.equal((await nameOf("prime5")).user_merchant_name, "Amazon");
    // The user cancelled the "Amazon" subscription (the Prime series under the broad name).
    await q(`INSERT INTO detected_subscriptions (merchant_key, display_name, amount, cadence_days, first_seen, last_charged, next_expected, is_active, cancelled_at)
             VALUES ('Amazon','Amazon',14.99,30,$1,$2,$3,false,now())`, [add(-95), add(-5), add(25)]);

    const out = await rename.createRuleFromTransaction("prime5", "Amazon Prime");
    assert.ok(!out.error, out.error);
    for (const n of [95, 65, 35, 5]) {
      const r = await nameOf("prime" + n);
      assert.equal(r.user_merchant_name, "Amazon Prime", "every Prime row follows the specific rule");
      assert.equal(r.user_merchant_rule_id, out.rule.id);
    }
    assert.equal((await nameOf("mkt1")).user_merchant_name, "Amazon", "the broad rule keeps its other rows");
    const amazon = (await q("SELECT is_active, cancelled_at FROM detected_subscriptions WHERE merchant_key = 'Amazon'")).rows;
    assert.equal(amazon.length, 1, "the 'Amazon' key still has rows, so it isn't re-keyed");
    assert.ok(amazon[0].cancelled_at, "its cancelled state is kept");
    assert.equal(amazon[0].is_active, false, "and detection doesn't revive it");
  });

  it("F41: a rule over unnamed rows still re-keys their subscription to the new name (the plain case)", async () => {
    for (const n of [70, 40, 10]) await tx("nf" + n, "chk", 15.49, "NETFLIX.COM", add(-n));
    await q(`INSERT INTO detected_subscriptions (merchant_key, display_name, amount, cadence_days, first_seen, last_charged, next_expected, is_active, notes)
             VALUES ('NETFLIX.COM','NETFLIX.COM',15.49,30,$1,$2,$3,true,'family plan')`, [add(-70), add(-10), add(20)]);
    const out = await rename.createRenameRule({ pattern: "NETFLIX.COM", matchType: "exact", renameTo: "Netflix" });
    assert.equal(out.rekeyed.subscriptions, 1);
    const r = (await q("SELECT notes FROM detected_subscriptions WHERE merchant_key = 'Netflix'")).rows;
    assert.deepEqual(r.map((x) => x.notes), ["family plan"]);
  });

  // ---------------------------------------------------------------- F46
  it("F46: a price change survives a detection run with no new charge", async () => {
    for (const [i, n] of [240, 210, 180, 150, 120].entries()) await tx("sp" + i, "chk", 9.99, "SPOTIFYUSA", add(-n));
    await detect.detectSubscriptions(pool);
    for (const [i, n] of [90, 60, 30].entries()) await tx("spn" + i, "chk", 11.99, "SPOTIFYUSA", add(-n));
    await detect.detectSubscriptions(pool);
    const first = (await q("SELECT amount, prior_amount, amount_changed FROM detected_subscriptions WHERE merchant_key = 'SPOTIFYUSA'")).rows[0];
    assert.equal(Number(first.amount), 11.99);
    assert.equal(Number(first.prior_amount), 9.99);
    assert.equal(first.amount_changed, true);
    await detect.detectSubscriptions(pool);
    const again = (await q("SELECT amount, prior_amount, amount_changed FROM detected_subscriptions WHERE merchant_key = 'SPOTIFYUSA'")).rows[0];
    assert.equal(Number(again.prior_amount), 9.99, "the prior price is kept");
    assert.equal(again.amount_changed, true, "the flag stays until a later charge at the new price");
  });

  // ---------------------------------------------------------------- F47
  it("F47: a charge 10–50% above the price alerts once; not for a utility or a 2x charge", async () => {
    const sub = (key, amount, category = "subscription") => q(
      `INSERT INTO detected_subscriptions (merchant_key, display_name, amount, cadence_days, first_seen, last_charged, next_expected, is_active, category)
       VALUES ($1,$1,$2,30,$3,$4,$5,true,$6)`, [key, amount, add(-120), add(-31), add(-1), category]);
    await subs.runSubscriptionWatchdog(pool); // settle the earlier tests' rows (F46's price change alerts here)
    await sub("HULU", 15.49);
    await sub("PGANDE", 100, "utility");
    await sub("GYMCO", 40);
    await tx("hulu_new", "chk", 17.99, "HULU", add(-1));
    await tx("pge_new", "chk", 140, "PGANDE", add(-1));
    await tx("gym_big", "chk", 80, "GYMCO", add(-1));
    const r1 = await subs.runSubscriptionWatchdog(pool);
    assert.equal(r1.price_rises, 1);
    const hulu = (await q("SELECT price_alerted_amount FROM detected_subscriptions WHERE merchant_key='HULU'")).rows[0];
    assert.equal(Number(hulu.price_alerted_amount), 17.99);
    const note = (await q("SELECT title FROM notification_log WHERE title LIKE 'HULU went up%'")).rows;
    assert.equal(note.length, 1);
    assert.match(note[0].title, /from \$15\.49 to \$17\.99/);
    assert.equal((await subs.runSubscriptionWatchdog(pool)).price_rises, 0, "once per price");
  });

  // ---------------------------------------------------------------- F4
  it("F4: CSV-overlap Resolve tombstones the CSV rows it deletes, with a restorable snapshot", async () => {
    await q("INSERT INTO plaid_items (item_id, institution_name, access_token_enc, status) VALUES ('pi4','Card', pgp_sym_encrypt('t', $1), 'GOOD')", [PASS()]);
    await q("INSERT INTO plaid_items (item_id, institution_name, access_token_enc, status) VALUES ('csv4','Chase', 'x', 'CSV')");
    const pItem = (await q("SELECT id FROM plaid_items WHERE item_id='pi4'")).rows[0].id;
    const cItem = (await q("SELECT id FROM plaid_items WHERE item_id='csv4'")).rows[0].id;
    await q("INSERT INTO linked_accounts (plaid_item_id, account_id, name, type, subtype) VALUES ($1,'pc4','Card','credit','credit card')", [pItem]);
    await q("INSERT INTO linked_accounts (plaid_item_id, account_id, name, type, subtype) VALUES ($1,'cc4','Chase Account','credit','credit card')", [cItem]);
    for (const [i, m] of ["SAFEWAY 1234", "SHELL OIL 5", "TARGET T-99"].entries()) {
      await tx("csv_ov" + i, "cc4", 20 + i, m, add(-10 - i));
      await tx("p_ov" + i, "pc4", 20 + i, m.split(" ")[0], add(-10 - i));
    }
    const ids = (await q("SELECT id, account_id FROM linked_accounts WHERE account_id IN ('pc4','cc4')")).rows;
    const csvId = ids.find((r) => r.account_id === "cc4").id, syncedId = ids.find((r) => r.account_id === "pc4").id;
    const res = await supertest(app).post("/api/transactions/csv-overlap/resolve").send({ csv_account_id: csvId, synced_account_id: syncedId }).expect(200);
    assert.equal(res.body.deleted, 3);
    const tomb = (await q("SELECT transaction_id, source, snapshot->'row'->>'merchant_name' AS m FROM deleted_transactions WHERE transaction_id LIKE 'csv_ov%' ORDER BY 1")).rows;
    assert.deepEqual(tomb.map((t) => [t.transaction_id, t.source]), [["csv_ov0", "csv"], ["csv_ov1", "csv"], ["csv_ov2", "csv"]]);
    assert.equal(tomb[0].m, "SAFEWAY 1234");
    await supertest(app).post("/api/deleted-transactions/csv_ov0/restore").expect(200);
    assert.equal((await q("SELECT 1 FROM transactions WHERE transaction_id='csv_ov0'")).rows.length, 1);
  });

  // ---------------------------------------------------------------- F5
  it("F5: a restored row drops a deleted rule's rename and takes a renamed rule's current name", async () => {
    await tx("dd1", "chk", 5, "DOORDASH*TACO", add(-3));
    await tx("dd2", "chk", 6, "UBER *EATS", add(-3));
    const r1 = await rename.createRenameRule({ pattern: "DOORDASH*TACO", matchType: "exact", renameTo: "DoorDash" });
    const r2 = await rename.createRenameRule({ pattern: "UBER *EATS", matchType: "exact", renameTo: "Uber Eats" });
    await supertest(app).delete("/api/transactions/dd1").expect(200);
    await supertest(app).delete("/api/transactions/dd2").expect(200);
    await supertest(app).delete("/api/merchant-rename-rules/" + r1.rule.id).expect(200);
    await rename.updateRenameRule(r2.rule.id, { renameTo: "Uber Eats (food)" });
    await supertest(app).post("/api/deleted-transactions/dd1/restore").expect(200);
    await supertest(app).post("/api/deleted-transactions/dd2/restore").expect(200);
    assert.deepEqual(await nameOf("dd1"), { user_merchant_name: null, user_merchant_rule_id: null });
    assert.deepEqual(await nameOf("dd2"), { user_merchant_name: "Uber Eats (food)", user_merchant_rule_id: r2.rule.id });
  });

  // ---------------------------------------------------------------- F6
  it("F6: a Plaid id the bank removed while deleted isn't restored; one it changed is restored, flagged stale", async () => {
    const item = (await q("SELECT id FROM plaid_items WHERE item_id='pi4'")).rows[0].id;
    const t = (id, amount) => ({ account_id: "pc4", transaction_id: id, amount, date: add(-2), name: "BISTRO", merchant_name: "Bistro", pending: false });
    let page = { added: [t("p_gone", 30), t("p_tip", 40)], modified: [], removed: [], next_cursor: "c1", has_more: false };
    const client = { transactionsSync: async () => ({ data: page }) };
    await investments.syncPlaidItemTransactions(client, item, "t");
    await supertest(app).delete("/api/transactions/p_gone").expect(200);
    await supertest(app).delete("/api/transactions/p_tip").expect(200);
    page = { added: [], modified: [t("p_tip", 46)], removed: [{ transaction_id: "p_gone" }], next_cursor: "c2", has_more: false };
    await investments.syncPlaidItemTransactions(client, item, "t");
    const gone = await supertest(app).post("/api/deleted-transactions/p_gone/restore").expect(409);
    assert.equal(gone.body.reason, "removed_by_bank");
    assert.equal((await q("SELECT 1 FROM transactions WHERE transaction_id='p_gone'")).rows.length, 0);
    const tip = await supertest(app).post("/api/deleted-transactions/p_tip/restore").expect(200);
    assert.equal(tip.body.stale, true);
  });

  // ---------------------------------------------------------------- F54
  it("F54: /api/income-summary lists a renamed payroll source under its name, once", async () => {
    for (const [i, raw] of ["ACME CORP PAYROLL", "ACME CORP DIR DEP"].entries()) {
      await tx("pay" + i, "chk", -2000, raw, add(-5 - i * 14));
      await q("UPDATE transactions SET user_merchant_name = 'Acme salary' WHERE transaction_id = $1", ["pay" + i]);
    }
    const body = (await supertest(app).get("/api/income-summary?months=3").expect(200)).body;
    const acme = body.top_sources.filter((s) => /acme/i.test(s.source));
    assert.deepEqual(acme.map((s) => s.source), ["Acme salary"]);
    assert.equal(Number(acme[0].total_income), 4000);
  });
});
