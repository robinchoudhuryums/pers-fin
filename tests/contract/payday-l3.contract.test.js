// Real-Postgres contract test for roadmap T2.2 L3 — payday alerts through the
// real income streams, post-sync chain, notification log and settings route:
//  - PATCH /api/settings switches them on and moves the landed watermark (time
//    and, since cycle-8 E2c, id) to now
//  - a biweekly paycheck 4 days overdue on a Plaid connection that synced cleanly
//    today → one "Payday missed?" notification; again → unchanged / deduped;
//    the same stream on a connection that hasn't synced since → nothing
//  - a new matching deposit through runPostSyncSteps → one "Paycheck landed"; a
//    second pass adds nothing; a one-off direct deposit isn't announced; after
//    the paycheck the missed check finds nothing
const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const supertest = require("supertest");
const { SKIP, perfinDb, perfinApp } = require("./_setup");

describe("Payday alerts (T2.2 L3) on real Postgres", { skip: SKIP }, () => {
  let pool, app, pa, enr, today, add;
  const q = (s, p) => pool.query(s, p);
  const count = async (re) => (await q("SELECT count(*)::int AS n FROM notification_log WHERE type ~ $1", [re])).rows[0].n;
  const dep = (id, acct, source, amount, date) => q(
    "INSERT INTO transactions (account_id, transaction_id, amount, date, merchant_name, name, pending) VALUES ($1,$2,$3,$4,$5,$5,false)",
    [acct, id, -amount, date, source]);

  before(async () => {
    pool = await perfinDb("payday_l3");
    app = perfinApp();
    pa = require("../../teller/services/payday-alerts");
    enr = require("../../teller/routes/enrollments");
    today = require("../../teller/services/financial-queries").todayStr();
    add = (n) => require("../../teller/services/cadence").addDaysStr(today, n);
    const item = async (key, synced) => (await q(
      "INSERT INTO plaid_items (item_id, institution_name, access_token_enc, status, last_synced_at) VALUES ($1,$1,'x','GOOD',$2) RETURNING id",
      [key, synced])).rows[0].id;
    const fresh = await item("fresh_bank", new Date());
    const stale = await item("stale_bank", new Date(Date.now() - 10 * 86400000));
    await q("INSERT INTO linked_accounts (plaid_item_id, account_id, name, type, subtype, current_balance) VALUES ($1,'chk','Checking','depository','checking',1000), ($2,'chk2','Other','depository','checking',1000)", [fresh, stale]);
    // ACME biweekly into the fresh connection, last 18 days ago → due 4 days ago.
    for (const n of [18, 32, 46, 60, 74]) await dep("acme" + n, "chk", "ACME PAYROLL", 2100, add(-n));
    // Globex biweekly into the stale connection, the same rhythm.
    for (const n of [18, 32, 46, 60, 74]) await dep("glx" + n, "chk2", "GLOBEX PAYROLL", 1500, add(-n));
    await q("UPDATE user_settings SET last_txn_sync_at = now() WHERE id = 1");
  });
  after(async () => { if (pool) await pool.end(); });

  it("PATCH switches them on and moves the landed watermark to now", async () => {
    await supertest(app).patch("/api/settings").send({ payday_alerts_enabled: "on" }).expect(400);
    await supertest(app).patch("/api/settings").send({ payday_alerts_enabled: true }).expect(200);
    const s = (await q("SELECT payday_alerts_enabled, last_income_alert_at, last_income_alert_txn_id::int AS txn_id, (SELECT MAX(id) FROM transactions) AS max_id FROM user_settings WHERE id = 1")).rows[0];
    assert.equal(s.payday_alerts_enabled, true);
    assert.ok(Date.now() - new Date(s.last_income_alert_at).getTime() < 60000);
    assert.equal(s.txn_id, s.max_id, "and the id watermark to the newest transaction (cycle-8 E2c)");
  });

  it("a missed payday on a freshly synced connection notifies once; a stale connection doesn't", async () => {
    pa._reset();
    const r = await pa.runPaydayMissed(pool);
    assert.deepEqual([r.status, r.notified, r.checked], ["done", 1, 2]);
    assert.equal(await count("^payday-missed-.*-" + add(-4) + "$"), 1);
    const row = (await q("SELECT title, body FROM notification_log WHERE type ~ '^payday-missed-'")).rows[0];
    assert.equal(row.title, "Payday missed?");
    assert.match(row.body, /^Your biweekly pay from ACME PAYROLL \(about \$2,100\.00\) was expected on /);
    assert.equal((await pa.runPaydayMissed(pool)).status, "unchanged");
    pa._reset();
    await pa.runPaydayMissed(pool);
    assert.equal(await count("^payday-missed-"), 1, "deduped through notification_log");
  });

  it("a matching deposit through the post-sync chain → one Paycheck landed; a one-off isn't announced", async () => {
    await dep("acme_new", "chk", "ACME PAYROLL", 2095, today);
    await dep("bonus", "chk", "INITECH DIRECT DEP", 300, today);
    await enr.runPostSyncSteps(2);
    const landed = (await q("SELECT body FROM notification_log WHERE title = 'Paycheck landed'")).rows;
    assert.equal(landed.length, 1);
    assert.match(landed[0].body, /^\$2,095\.00 from ACME PAYROLL \(biweekly\) on /);
    await enr.runPostSyncSteps(1);
    assert.equal((await q("SELECT count(*)::int AS n FROM notification_log WHERE title = 'Paycheck landed'")).rows[0].n, 1, "the watermark moved past it");
    // The paycheck arrived, so the missed check finds nothing new for ACME.
    pa._reset();
    await q("DELETE FROM notification_log WHERE type ~ '^payday-missed-'");
    const r = await pa.runPaydayMissed(pool);
    assert.equal(r.notified, 0);
  });
});
