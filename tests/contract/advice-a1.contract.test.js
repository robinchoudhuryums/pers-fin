// Real-Postgres contract test for roadmap T4.1 A1 — the advice engine on real
// rows, the app's own migrations (and, since A2, GET /api/advice through the
// production mount order answering the same plan):
//  - getAdviceInputs reads every source with no error (the income / spending
//    months, the pay stream, the cash forecast, the floor, the cards and
//    loans, card activity and the savings transfers)
//  - a card charged interest (by its statement wording, and one by Plaid's
//    PFC) is carried; a card paid in full is not debt
//  - the plan: 3 completed months each well over the bar, the savings transfer
//    and the card minimums taken off first, the whole recommendation to the
//    highest-APR card, per (monthly) paycheck rounded down to $25
const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const supertest = require("supertest");
const { SKIP, perfinDb, perfinApp } = require("./_setup");

describe("Advice engine (T4.1 A1) on real Postgres", { skip: SKIP }, () => {
  let pool, today, advice, keys;
  const q = (s, p) => pool.query(s, p);

  before(async () => {
    pool = await perfinDb("advice_a1");
    advice = require("../../teller/services/advice");
    today = require("../../teller/services/financial-queries").todayStr();
    keys = advice.completedMonthKeys(today); // the 3 completed months, oldest first

    const acct = (id, type, subtype, bal, extra = {}) => q(
      `INSERT INTO linked_accounts (account_id, name, type, subtype, is_manual, current_balance, apr, minimum_payment, last_payment_amount, credit_limit)
       VALUES ($1,$2,$3,$4,true,$5,$6,$7,$8,$9)`,
      [id, extra.name || id, type, subtype, bal, extra.apr ?? null, extra.min ?? null, extra.last ?? null, extra.limit ?? null]);
    await acct("chk", "depository", "checking", 20000, { name: "Checking" });
    await acct("visa", "credit", "credit card", 3000, { name: "Visa", apr: 24.99, min: 90, limit: 5000 });
    await acct("store", "credit", "credit card", 600, { name: "Store card" });
    await acct("amex", "credit", "credit card", 1200, { name: "Amex", apr: 21, min: 40, last: 1500, limit: 8000 });

    const txn = (id, account, amount, date, name, extra = {}) => q(
      `INSERT INTO transactions (account_id, transaction_id, amount, date, merchant_name, name, pending, category, personal_finance_category)
       VALUES ($1,$2,$3,$4,$5,$5,false,$6,$7)`,
      [account, id, amount, date, name, extra.category ? [extra.category] : null, extra.pfc ? JSON.stringify(extra.pfc) : null]);
    for (const m of keys) {
      await txn("pay-" + m, "chk", -5000, m + "-15", "ACME PAYROLL");
      await txn("food-" + m, "chk", 3000, m + "-10", "WHOLE FOODS", { category: "Groceries" });
    }
    const daysAgo = (n) => require("../../teller/services/cadence").addDaysStr(today, -n);
    // Visa: the statement's interest line. Store card: Plaid's PFC only.
    await txn("visa-int", "visa", 61.23, daysAgo(12), "INTEREST CHARGE ON PURCHASES");
    await txn("store-int", "store", 11.5, daysAgo(20), "Charge", { pfc: { primary: "BANK_FEES", detailed: "BANK_FEES_INTEREST_CHARGE" } });
    // Amex: everyday purchases, paid in full (last payment well over the minimum).
    await txn("amex-buy", "amex", 85, daysAgo(5), "CAFE");

    await q(`INSERT INTO recurring_transfers (merchant_key, display_name, amount, cadence_days, first_seen, last_transferred, next_expected, is_active, transfer_type, direction)
             VALUES ('to savings','TRANSFER TO SAVINGS',200,30,$1,$2,$3,true,'savings','outgoing')`, [daysAgo(120), daysAgo(10), require("../../teller/services/cadence").addDaysStr(today, 20)]);
  });
  after(async () => { if (pool) await pool.end(); });

  it("every source reads cleanly on the real schema", async () => {
    const inputs = await advice.getAdviceInputs(pool, { today });
    assert.deepEqual(inputs.errors, []);
    assert.equal(inputs.cash.starting_balance, 20000, "only the checking account is spendable");
    assert.deepEqual(inputs.debts.map((d) => d.name), ["Visa", "Store card", "Amex"]);
    const act = Object.fromEntries(inputs.activity.map((r) => [r.account_id, r.interest]));
    assert.deepEqual(act, { visa: true, store: true, amex: false });
    assert.equal(inputs.settings.cash_alert_threshold, "500.00");
  });

  it("the plan: the whole recommendation to the highest-APR carried card", async () => {
    const plan = await advice.getAdvicePlan(pool, { today });
    assert.equal(plan.ok, true);
    assert.deepEqual(plan.surplus.months.map((m) => [m.month, m.income, m.spending, m.net, m.ok]),
      keys.map((k) => [k, 5000, 3000, 2000, true]));
    const byName = Object.fromEntries(plan.debts.map((d) => [d.name, d]));
    assert.equal(byName.Visa.carry_reason, "interest_charged");
    assert.equal(byName["Store card"].carry_reason, "interest_charged");
    assert.equal(byName["Store card"].apr, 22, "no APR on file → assumed 22%");
    assert.equal(byName.Amex.carried, false, "paid in full isn't debt");

    // 2000 − 200 savings − (90 + 25) minimums = 1685 × 60% = 1011 → $1,000.
    assert.equal(plan.surplus.existing_transfers_monthly, 200);
    assert.equal(plan.surplus.required_minimums_monthly, 115);
    assert.equal(plan.headline.step, "high_interest_debt");
    assert.equal(plan.headline.amount_per_period, 1000);
    assert.equal(plan.headline.text, "Pay down Visa first: $1,000.00 per paycheck on top of its minimum.");
    assert.deepEqual(plan.allocation.debts.map((d) => d.name), ["Visa", "Store card"]);
    assert.equal(plan.allocation.debts[0].extra_monthly, 1000);
    assert.ok(plan.allocation.debts[0].interest_saved > 0);
    assert.equal(plan.period.unit, "paycheck");
    assert.equal(plan.period.cadence, "monthly");
  });

  it("A2: GET /api/advice answers the same plan through the production mount order", async () => {
    const res = await supertest(perfinApp()).get("/api/advice");
    assert.equal(res.status, 200);
    const plan = await advice.getAdvicePlan(pool);
    assert.deepEqual(res.body, JSON.parse(JSON.stringify(plan)));
    assert.equal(res.body.headline.text, "Pay down Visa first: $1,000.00 per paycheck on top of its minimum.");
  });
});
