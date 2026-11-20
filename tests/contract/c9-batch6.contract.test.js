// Real-Postgres contract test for cycle 9 Batch 6 — the cash plan's fixes on
// real rows, the app's own migrations and the production mount order:
//  - F32 / F31: with ONE completed month on record the plan's spending average
//    is that month's (not a third of it), so the emergency fund isn't "reached";
//    a loan with an APR of 11.5% and no monthly payment keeps the
//    high-interest step open, through GET /api/advice
//  - F33: income paid in one of three completed months is averaged over the
//    three, like the spending, through GET /api/fire-projection
//  - F38: "Since you last looked" counts every new transaction though it lists
//    25; the payday check walks its candidates in NUMERIC id order (ids 99 and
//    100 — as text, "100" sorts first); a December investment sale cancelled
//    in January leaves December's year
// Dates are derived from the clock the code reads (cycle-9 F59).
const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const supertest = require("supertest");
const { SKIP, perfinDb, perfinApp } = require("./_setup");

describe("Cycle 9 Batch 6 (cash plan) on real Postgres", { skip: SKIP }, () => {
  let pool, app, fq, cadence, advice, today, keys;
  const q = (s, p) => pool.query(s, p);
  const txn = (id, account, amount, date, name, category) => q(
    `INSERT INTO transactions (account_id, transaction_id, amount, date, merchant_name, name, pending, category)
     VALUES ($1,$2,$3,$4,$5,$5,false,$6)`, [account, id, amount, date, name, category ? [category] : null]);

  before(async () => {
    pool = await perfinDb("c9_batch6");
    app = perfinApp();
    fq = require("../../teller/services/financial-queries");
    cadence = require("../../teller/services/cadence");
    advice = require("../../teller/services/advice");
    today = fq.todayStr();
    keys = advice.completedMonthKeys(today); // the 3 completed months, oldest first
    await q(`INSERT INTO linked_accounts (account_id, name, type, subtype, is_manual, current_balance, apr)
             VALUES ('chk','Checking','depository','checking',true,3200,NULL),
                    ('loan','Personal loan','loan','personal',true,6000,11.5)`);
    // ONE completed month on record: the latest.
    await txn("pay-1", "chk", -9000, keys[2] + "-15", "INITECH PAYROLL");
    await txn("food-1", "chk", 3000, keys[2] + "-10", "WHOLE FOODS", "Groceries");
  });
  after(async () => { if (pool) await pool.end(); });

  it("F32 + F31: one month of history is averaged over one month; the 11.5% loan with no payment stays in the plan", async () => {
    const body = (await supertest(app).get("/api/advice").expect(200)).body;
    assert.equal(body.ok, true);
    assert.equal(body.cash.avg_monthly_spending, 3000, "it read $1,000 — the month divided by 3");
    assert.equal(body.cash.spending_months, 1);
    assert.equal(body.cash.emergency_target, 9000);
    assert.equal(body.emergency.reached, false, "$3,200 against $9,000");
    assert.equal(body.headline.step, "starter_buffer", "$3,200 is under the $500 floor + a month of spending");
    const step = body.steps.find((s) => s.key === "high_interest_debt");
    assert.equal(step.status, "upcoming", "the loan used to drop out, so this step read 'done'");
    assert.equal(step.remaining, 6000);
    const row = body.allocation.debts.find((d) => d.name === "Personal loan");
    assert.ok(row, "the loan is in the plan's debts");
    assert.equal(row.minimum_unknown, true);
    assert.equal(row.payoff_month, null);
    assert.ok(body.notes.includes("Personal loan: monthly payment unknown — set it on the loan card."));
    assert.ok(body.notes.some((n) => /from 1 complete month of history/.test(n)));
  });

  it("F33: $9,000 of income in one of three months is $3,000 a month, beside spending averaged over the same three", async () => {
    await txn("food-2", "chk", 2000, keys[1] + "-10", "WHOLE FOODS", "Groceries");
    await txn("food-3", "chk", 2000, keys[0] + "-10", "WHOLE FOODS", "Groceries");
    const body = (await supertest(app).get("/api/fire-projection").expect(200)).body;
    assert.equal(body.data_basis.completed_months_used, 3);
    assert.equal(body.data_basis.avg_monthly_income, 3000, "it read $9,000 — averaged over its one month");
    assert.equal(body.data_basis.avg_monthly_spending, 2333.33);
    assert.equal(body.data_basis.monthly_savings, 666.67);
    // The plan now sees three months of spending.
    const plan = (await supertest(app).get("/api/advice").expect(200)).body;
    assert.equal(plan.cash.spending_months, 3);
    assert.equal(plan.cash.avg_monthly_spending, 2333.33);
  });

  it("F38: 'Since you last looked' counts every new transaction, though it lists 25", async () => {
    for (let i = 0; i < 30; i++) await txn("coffee-" + i, "chk", 4.5, today, "CAFE " + i, "Food & Drink");
    const expected = (await q("SELECT count(*)::int AS n FROM transactions WHERE pending = false")).rows[0].n;
    assert.ok(expected > 25);
    const body = (await supertest(app).get("/api/whats-new").expect(200)).body;
    assert.equal(body.transactions.length, 25);
    assert.equal(body.counts.transactions, expected, "it read 25");
    assert.ok(body.transactions.every((t) => !("total_count" in t)));
  });

  it("F38: the payday check walks deposits in numeric id order — 99 before 100", async () => {
    const pa = require("../../teller/services/payday-alerts");
    const add = (n) => cadence.addDaysStr(today, n);
    for (const n of [14, 28, 42, 56]) {
      await txn("acme-" + n, "chk", -2100, add(-n), "ACME PAYROLL");
      await txn("glx-" + n, "chk", -1500, add(-n), "GLOBEX PAYROLL");
    }
    await q(`UPDATE user_settings SET payday_alerts_enabled = true, last_income_alert_at = now(),
                    last_income_alert_txn_id = (SELECT MAX(id) FROM transactions) WHERE id = 1`);
    await q("SELECT setval(pg_get_serial_sequence('transactions', 'id'), 98)");
    await txn("acme-new", "chk", -2100, today, "ACME PAYROLL");
    await txn("glx-new", "chk", -1500, today, "GLOBEX PAYROLL");
    const ids = (await q("SELECT transaction_id, id FROM transactions WHERE transaction_id IN ('acme-new','glx-new') ORDER BY transactions.id")).rows;
    assert.deepEqual(ids.map((r) => [r.transaction_id, r.id]), [["acme-new", 99], ["glx-new", 100]]);

    // The second deposit's notification isn't logged: the run holds there.
    const sent = [];
    const hold = await pa.runPaydayLanded(pool, { today, deps: { sendToAll: async (p) => { sent.push(p.body); return { logged: !/GLOBEX/.test(p.body) }; } } });
    assert.equal(sent.length, 2);
    assert.match(sent[0], /ACME PAYROLL/, "id 99 first — as text, \"100\" sorted before \"99\" and the run stopped before reaching it");
    assert.match(sent[1], /GLOBEX PAYROLL/);
    assert.deepEqual([hold.status, hold.notified], ["held_back", 1]);
    const mark = (await q("SELECT last_income_alert_txn_id::int AS id FROM user_settings WHERE id = 1")).rows[0].id;
    assert.equal(mark, 99, "held just before the deposit that wasn't logged");
  });

  it("F38: a December sale cancelled in January leaves December's year", async () => {
    const tax = require("../../teller/services/tax-investments");
    const Y = Number(today.slice(0, 4)) - 1;
    const acct = (await q("INSERT INTO investment_accounts (name, institution, account_type, balance, plaid_account_id) VALUES ('Brokerage','Taxbroker','brokerage',5000,'brk') RETURNING id")).rows[0].id;
    const itx = (id, date, type, subtype, qty, amount, cancels = null) => q(
      `INSERT INTO investment_transactions (plaid_investment_transaction_id, investment_account_id, txn_date, type, subtype, security_id, ticker, quantity, amount, cancel_transaction_id)
       VALUES ($1,$2,$3,$4,$5,'sec','VTI',$6,$7,$8)`, [id, acct, date, type, subtype, qty, amount, cancels]);
    await itx("b1", `${Y - 2}-03-01`, "buy", "buy", 20, 2000);
    await itx("s-may", `${Y}-05-01`, "sell", "sell", -10, -1500);
    await itx("s-dec", `${Y}-12-30`, "sell", "sell", -10, -1800);
    await itx("d-dec", `${Y}-12-31`, "cash", "dividend", 0, -40);
    await itx("d-jun", `${Y}-06-30`, "cash", "dividend", 0, -15);

    const before = await tax.getInvestmentTaxData(pool, Y);
    assert.equal(before.realized_gains.sales.length, 2);
    assert.equal(before.investment_income.totals.dividends, 55);

    // The broker reverses the two December rows in January.
    await itx("c-sale", `${Y + 1}-01-04`, "cancel", "cancel", 10, 1800, "s-dec");
    await itx("c-div", `${Y + 1}-01-04`, "cancel", "cancel", 0, 40, "d-dec");
    const d = await tax.getInvestmentTaxData(pool, Y);
    assert.deepEqual(d.realized_gains.sales.map((s) => s.gain), [500], "the May sale only — the December one was cancelled");
    assert.equal(d.investment_income.totals.dividends, 15);
    // The next year sees neither the cancelled rows nor the cancels as activity.
    const next = await tax.getInvestmentTaxData(pool, Y + 1);
    assert.equal(next.realized_gains.sales.length, 0);
    assert.equal(next.investment_income.totals.dividends, 0);
  });
});
