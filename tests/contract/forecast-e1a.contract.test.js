// Real-Postgres contract test for cycle-8 E1a (G1) — correcting the cash-flow
// forecast through the real routes:
//  - a card autopay and an internal-looking savings transfer set to "bill" are
//    billed; a rent transfer set to "ignore" isn't; a subscription left out
//  - GET /api/cash-flow's forecast_items, the totals and the dashboard
//    summary's lowest day move with each setting
//  - re-running both detectors keeps the settings
//  - the CHECK refuses a value outside its list
const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const supertest = require("supertest");
const { SKIP, perfinDb, perfinApp } = require("./_setup");

describe("Forecast corrections (cycle-8 E1a) on real Postgres", { skip: SKIP }, () => {
  let pool, app, add;
  const q = (s, p) => pool.query(s, p);
  const ids = {};

  before(async () => {
    pool = await perfinDb("forecast_e1a");
    app = perfinApp();
    const today = require("../../teller/services/financial-queries").todayStr();
    add = (n) => require("../../teller/services/cadence").addDaysStr(today, n);

    const acct = (id, type, subtype, bal) => q(
      "INSERT INTO linked_accounts (account_id, name, type, subtype, is_manual, current_balance) VALUES ($1,$1,$2,$3,true,$4)",
      [id, type, subtype, bal]);
    await acct("chk", "depository", "checking", 6000);
    await acct("sav", "depository", "savings", 1000);
    await acct("card", "credit", "credit card", 400);

    const txn = (id, account, amount, date, merchant) => q(
      "INSERT INTO transactions (account_id, transaction_id, amount, date, merchant_name, name, pending) VALUES ($1,$2,$3,$4,$5,$5,false)",
      [account, id, amount, date, merchant]);
    // Four monthly occurrences of each, so both detectors find them.
    for (const [i, d] of [95, 65, 35, 5].entries()) {
      await txn("sav" + i, "chk", 300, add(-d), "Online Transfer to Savings");
      await txn("savc" + i, "sav", -300, add(-d + 1), "Online Transfer from Checking");
      await txn("card" + i, "chk", 800, add(-d), "CHASE CARD AUTOPAY");
      await txn("cardc" + i, "card", -800, add(-d + 2), "PAYMENT THANK YOU");
      await txn("rent" + i, "chk", 1500, add(-d), "Zelle to Jane Roe");
      await txn("nf" + i, "card", 15.49, add(-d), "Netflix");
    }
    await require("../../scripts/detect-subscriptions").detectSubscriptions(pool);
    await require("../../scripts/detect-transfers").detectRecurringTransfers(pool);
    const rows = (await q("SELECT id, merchant_key, forecast_treatment FROM recurring_transfers WHERE is_active AND direction = 'outgoing'")).rows;
    for (const r of rows) {
      if (/savings/i.test(r.merchant_key)) ids.savings = r.id;
      else if (/chase/i.test(r.merchant_key)) ids.card = r.id;
      else if (/jane/i.test(r.merchant_key)) ids.rent = r.id;
    }
    ids.netflix = (await q("SELECT id FROM detected_subscriptions WHERE merchant_key ILIKE 'netflix%' AND is_active")).rows[0]?.id;
    assert.ok(ids.savings && ids.card && ids.rent && ids.netflix, JSON.stringify({ ids, rows }));
    assert.ok(rows.every((r) => r.forecast_treatment === "auto"), "every new row starts automatic");
  });
  after(async () => { if (pool) await pool.end(); });

  const flow = async () => (await supertest(app).get("/api/cash-flow?days=30").expect(200)).body;
  const byKey = (list) => Object.fromEntries(list.map((b) => [b.source + ":" + b.id, b]));

  it("automatic: rent and Netflix billed; the card autopay and the savings move left out with reasons", async () => {
    const body = await flow();
    const bills = byKey(body.forecast_items.bills);
    const out = byKey(body.forecast_items.left_out);
    assert.ok(bills["transfer:" + ids.rent], JSON.stringify(body.forecast_items));
    assert.ok(bills["subscription:" + ids.netflix]);
    assert.equal(out["transfer:" + ids.card].reason, "card_autopay");
    assert.equal(out["transfer:" + ids.savings].reason, "internal");
    assert.equal(bills["transfer:" + ids.rent].why, "auto");
  });

  it("the user's settings move each item, and the totals and the summary's lowest day with them", async () => {
    const before = await flow();
    const summaryBefore = (await supertest(app).get("/api/dashboard/summary").expect(200)).body.cash;

    await supertest(app).patch(`/api/recurring-transfers/${ids.card}/forecast`).send({ treatment: "bill" }).expect(200);
    await supertest(app).patch(`/api/recurring-transfers/${ids.savings}/forecast`).send({ treatment: "bill" }).expect(200);
    await supertest(app).patch(`/api/recurring-transfers/${ids.rent}/forecast`).send({ treatment: "ignore" }).expect(200);
    await supertest(app).patch(`/api/subscriptions/${ids.netflix}/forecast`).send({ ignore: true }).expect(200);

    const after = await flow();
    const bills = byKey(after.forecast_items.bills);
    const out = byKey(after.forecast_items.left_out);
    assert.equal(bills["transfer:" + ids.card].why, "user");
    assert.equal(bills["transfer:" + ids.savings].treatment, "bill");
    assert.equal(out["transfer:" + ids.rent].reason, "user_ignored");
    assert.equal(out["subscription:" + ids.netflix].reason, "user_ignored");

    // The totals equal what the items say.
    const sum = (list) => Math.round(list.reduce((t, b) => t + b.projected_total, 0) * 100) / 100;
    assert.equal(after.total_projected_bills, sum(after.forecast_items.bills));
    assert.equal(before.total_projected_bills, sum(before.forecast_items.bills));
    assert.notEqual(after.total_projected_bills, before.total_projected_bills);

    const summaryAfter = (await supertest(app).get("/api/dashboard/summary").expect(200)).body.cash;
    assert.equal(summaryAfter.ok, true);
    const svc = await require("../../teller/services/cash-flow").getCashFlowForecast(pool, { days: 30 });
    assert.equal(summaryAfter.lowest_balance, svc.lowest.balance);
    assert.notEqual(summaryAfter.lowest_balance, summaryBefore.lowest_balance);
  });

  it("re-running both detectors keeps the settings", async () => {
    await require("../../scripts/detect-subscriptions").detectSubscriptions(pool);
    await require("../../scripts/detect-transfers").detectRecurringTransfers(pool);
    const t = (await q("SELECT id, forecast_treatment FROM recurring_transfers WHERE id = ANY($1::int[]) ORDER BY id", [[ids.card, ids.savings, ids.rent]])).rows;
    assert.deepEqual(Object.fromEntries(t.map((r) => [r.id, r.forecast_treatment])), { [ids.card]: "bill", [ids.savings]: "bill", [ids.rent]: "ignore" });
    assert.equal((await q("SELECT forecast_ignore FROM detected_subscriptions WHERE id = $1", [ids.netflix])).rows[0].forecast_ignore, true);
  });

  it("back to automatic restores the heuristics; an unknown id is a 404", async () => {
    await supertest(app).patch(`/api/recurring-transfers/${ids.card}/forecast`).send({ treatment: "auto" }).expect(200);
    const out = byKey((await flow()).forecast_items.left_out);
    assert.equal(out["transfer:" + ids.card].reason, "card_autopay");
    await supertest(app).patch("/api/recurring-transfers/999999/forecast").send({ treatment: "bill" }).expect(404);
    await supertest(app).patch("/api/subscriptions/999999/forecast").send({ ignore: false }).expect(404);
  });

  it("the CHECK refuses a value outside its list", async () => {
    await assert.rejects(q("UPDATE recurring_transfers SET forecast_treatment = 'sometimes' WHERE id = $1", [ids.rent]), /check constraint/);
    const def = (await q("SELECT pg_get_constraintdef(oid) AS d FROM pg_constraint WHERE conname = 'recurring_transfers_forecast_treatment_check'")).rows[0].d;
    assert.match(def, /'auto'.*'bill'.*'internal'.*'ignore'/);
  });
});
