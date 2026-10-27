// Cycle-8 broad scan Batch 4 on real Postgres — a row stamped by a transaction
// that commits AFTER a check has run (an overlapping sync, a long CSV import):
//  - F1: the anomaly check still sees it on the next run, and only once
//  - F51: "Paycheck landed" still announces it on the next run, and only once
const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { SKIP, perfinDb } = require("./_setup");

describe("cycle-8 Batch 4 on real Postgres", { skip: SKIP }, () => {
  let pool, enr, pa, add, today;
  const q = (s, p) => pool.query(s, p);
  const tx = (db, id, amt, merchant, date) => db.query(
    "INSERT INTO transactions (account_id, transaction_id, amount, date, merchant_name, name, pending) VALUES ('chk',$1,$2,$3,$4,$4,false)",
    [id, amt, date, merchant]);
  const notes = async (title) => (await q("SELECT type, body FROM notification_log WHERE title = $1", [title])).rows;
  const pause = () => new Promise((r) => setTimeout(r, 20));

  before(async () => {
    pool = await perfinDb("c8_batch4");
    const fq = require("../../teller/services/financial-queries");
    today = fq.todayStr();
    add = (n) => require("../../teller/services/cadence").addDaysStr(today, n);
    enr = require("../../teller/routes/enrollments");
    pa = require("../../teller/services/payday-alerts");
    await q("INSERT INTO linked_accounts (account_id, name, type, subtype, is_manual) VALUES ('chk','Checking','depository','checking',true)");
  });
  after(async () => { if (pool) await pool.end(); });

  // ---------------------------------------------------------------- F1
  it("F1: a charge committed after a check, stamped before it, is checked on the next run — once", async () => {
    for (const n of [60, 45, 30, 20]) await tx(pool, "cof" + n, 10, "COFFEECO", add(-n));
    await enr.runAnomalyCheck(); // the baseline rows set the first watermark
    await pause();

    const slow = await pool.connect(); // a sync whose insert commits late
    try {
      await slow.query("BEGIN");
      await tx(slow, "cof_big", 100, "COFFEECO", today); // created_at = this transaction's start
      await pause();
      await tx(pool, "other1", 12, "BOOKSTORE", today); // committed, newer
      await enr.runAnomalyCheck(); // the big charge isn't visible yet
      assert.equal((await notes("Unusual charge detected")).length, 0);
      await slow.query("COMMIT");
    } finally { slow.release(); }

    await enr.runAnomalyCheck();
    const n = await notes("Unusual charge detected");
    assert.equal(n.length, 1, "the late-committed charge is checked");
    assert.match(n[0].body, /COFFEECO: \$100\.00/);
    await enr.runAnomalyCheck();
    assert.equal((await notes("Unusual charge detected")).length, 1, "and only once");
  });

  // ---------------------------------------------------------------- F51
  it("F51: a paycheck committed after the payday check, stamped before it, is announced next run — once", async () => {
    for (const n of [70, 56, 42, 28]) await tx(pool, "pay" + n, -2100, "ACME PAYROLL", add(-n));
    await q("UPDATE user_settings SET payday_alerts_enabled = true, last_income_alert_at = now() WHERE id = 1");
    await pause();

    const imp = await pool.connect(); // a CSV import: one transaction for the file
    try {
      await imp.query("BEGIN");
      await tx(imp, "pay_now", -2100, "ACME PAYROLL", add(-1));
      await pause();
      await tx(pool, "gift1", -40, "GRANDMA DEPOSIT", add(-1)); // income, no stream — committed, newer
      const first = await pa.runPaydayLanded(pool, { today });
      assert.equal(first.notified, 0);
      await imp.query("COMMIT");
    } finally { imp.release(); }

    const second = await pa.runPaydayLanded(pool, { today });
    assert.equal(second.notified, 1, "the import's paycheck is announced");
    assert.equal((await notes("Paycheck landed")).length, 1);
    const third = await pa.runPaydayLanded(pool, { today });
    assert.equal(third.notified, 0, "an overlap row already announced is skipped");
    assert.equal((await notes("Paycheck landed")).length, 1);
  });
});
