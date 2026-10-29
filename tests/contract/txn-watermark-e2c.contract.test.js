// Real-Postgres contract test for cycle-8 E2c (ST3) — the anomaly check and
// "Paycheck landed" on an id watermark with an overlap rescan:
//  - a charge and a paycheck inserted by a transaction that started before a
//    check (so their ids are BELOW the mark that check took) but committed
//    after it are each announced by the next run — once; the anomaly
//    notification carries the charge's transaction_id
//  - a long-open transaction elsewhere on the database no longer holds a new
//    charge back (cycle-8 F1's created_at mark stopped at its start)
//  - the migration backfills each id from its time watermark, once
const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { SKIP, perfinDb } = require("./_setup");

describe("id watermarks with an overlap rescan (cycle-8 E2c) on real Postgres", { skip: SKIP }, () => {
  let pool, database, enr, pa, add, today;
  const q = (s, p) => pool.query(s, p);
  const tx = (db, id, amt, merchant, date) => db.query(
    "INSERT INTO transactions (account_id, transaction_id, amount, date, merchant_name, name, pending) VALUES ('chk',$1,$2,$3,$4,$4,false) RETURNING id",
    [id, amt, date, merchant]);
  const notes = async (title) => (await q("SELECT type, body, data FROM notification_log WHERE title = $1 ORDER BY id", [title])).rows;
  const settings = async () => (await q("SELECT last_anomaly_txn_id::int AS anomaly_id, last_income_alert_txn_id::int AS income_id FROM user_settings WHERE id = 1")).rows[0];

  before(async () => {
    pool = await perfinDb("txn_watermark_e2c");
    database = require("../../teller/services/database");
    const fq = require("../../teller/services/financial-queries");
    today = fq.todayStr();
    add = (n) => require("../../teller/services/cadence").addDaysStr(today, n);
    enr = require("../../teller/routes/enrollments");
    pa = require("../../teller/services/payday-alerts");
    await q("INSERT INTO linked_accounts (account_id, name, type, subtype, is_manual) VALUES ('chk','Checking','depository','checking',true)");
  });
  after(async () => { if (pool) await pool.end(); });

  it("a charge with a lower id committed after a check is announced by the next run — once, with its transaction_id", async () => {
    for (const n of [60, 45, 30, 20]) await tx(pool, "cof" + n, 10, "COFFEECO", add(-n));
    await enr.runAnomalyCheck(); // the baseline rows: no anomaly, the watermark set
    const slow = await pool.connect();
    let bigId;
    try {
      await slow.query("BEGIN");
      bigId = (await tx(slow, "cof_big", 100, "COFFEECO", today)).rows[0].id; // its id is taken now
      const other = (await tx(pool, "book1", 12, "BOOKSTORE", today)).rows[0].id; // committed, higher id
      assert.ok(other > bigId);
      await enr.runAnomalyCheck();
      assert.equal((await notes("Unusual charge detected")).length, 0, "not visible yet");
      assert.equal((await settings()).anomaly_id, other, "the watermark passed the uncommitted id");
      await slow.query("COMMIT");
    } finally { slow.release(); }

    await enr.runAnomalyCheck();
    const n = await notes("Unusual charge detected");
    assert.equal(n.length, 1, "found through the overlap");
    assert.match(n[0].body, /COFFEECO: \$100\.00/);
    assert.equal(n[0].type, "anomaly-coffeeco");
    assert.equal(n[0].data.transaction_id, "cof_big");
    await enr.runAnomalyCheck();
    await enr.runAnomalyCheck();
    assert.equal((await notes("Unusual charge detected")).length, 1, "and never again");
  });

  it("a long-open transaction elsewhere doesn't hold a new charge back", async () => {
    for (const n of [50, 40, 35, 25]) await tx(pool, "tea" + n, 5, "TEAHOUSE", add(-n));
    await enr.runAnomalyCheck();
    const idle = await pool.connect();
    try {
      await idle.query("BEGIN");
      await idle.query("INSERT INTO credit_scores (score, checked_at) VALUES (700, CURRENT_DATE)"); // holds an xid
      await tx(pool, "tea_big", 60, "TEAHOUSE", today);
      await enr.runAnomalyCheck();
      const n = await notes("Unusual charge detected");
      assert.ok(n.some((x) => x.data.transaction_id === "tea_big"), "announced while the other transaction is still open");
    } finally { await idle.query("ROLLBACK"); idle.release(); }
  });

  it("a paycheck with a lower id committed after the payday check is announced next run — once", async () => {
    for (const n of [70, 56, 42, 28]) await tx(pool, "pay" + n, -2100, "ACME PAYROLL", add(-n));
    await q("UPDATE user_settings SET payday_alerts_enabled = true, last_income_alert_at = NULL, last_income_alert_txn_id = NULL WHERE id = 1");
    assert.equal((await pa.runPaydayLanded(pool, { today })).status, "initialized");
    const imp = await pool.connect(); // a CSV import: one transaction for the file
    try {
      await imp.query("BEGIN");
      await tx(imp, "pay_now", -2100, "ACME PAYROLL", add(-1));
      await tx(pool, "gift1", -40, "GRANDMA DEPOSIT", add(-1)); // committed, higher id
      const first = await pa.runPaydayLanded(pool, { today });
      assert.equal(first.notified, 0);
      await imp.query("COMMIT");
    } finally { imp.release(); }

    assert.equal((await pa.runPaydayLanded(pool, { today })).notified, 1, "the import's paycheck is announced");
    assert.equal((await pa.runPaydayLanded(pool, { today })).notified, 0, "an overlap row already announced is skipped");
    assert.equal((await notes("Paycheck landed")).length, 1);
  });

  it("the migration backfills each id from its time watermark once — the newest id stamped at or before it", async () => {
    const ids = (await q("SELECT id, created_at::text AS at FROM transactions ORDER BY id")).rows;
    const cut = ids[3];
    await q("UPDATE user_settings SET last_anomaly_txn_id = NULL, last_anomaly_check_at = $1::timestamptz, last_income_alert_txn_id = NULL, last_income_alert_at = $1::timestamptz WHERE id = 1", [cut.at]);
    const expected = (await q("SELECT MAX(id)::int AS id FROM transactions WHERE created_at <= $1::timestamptz", [cut.at])).rows[0].id;
    await database.runMigrations();
    assert.deepEqual(await settings(), { anomaly_id: expected, income_id: expected });
    await q("UPDATE user_settings SET last_anomaly_txn_id = 3 WHERE id = 1");
    await database.runMigrations();
    assert.equal((await settings()).anomaly_id, 3, "a stored id is left alone");
  });
});
