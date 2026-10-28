// Real-Postgres contract test for roadmap T4.1 A1 — the advice engine on real
// rows, the app's own migrations (and, since A2, GET /api/advice through the
// production mount order answering the same plan; since A3 the insight
// prompt's CASH PLAN block and the audit's plan figures):
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

  it("A3: the insight prompt's CASH PLAN block and the audit's plan figures from the same rows", async () => {
    const plan = await advice.getAdvicePlan(pool);
    const block = require("../../teller/routes/insights").cashPlanPromptBlock(plan);
    assert.match(block, /\nHeadline: Pay down Visa first: \$1,000\.00 per paycheck on top of its minimum\.\n/);
    assert.match(block, /\n- Visa: APR 24\.99%, balance \$3,000\.00, pay \$1,090\.00 per paycheck/);
    const f = require("../../teller/services/ai-audit").planFigures(plan);
    assert.ok(f.perPeriod.includes(1000));
    assert.deepEqual(f.debts.visa.per_period, [1090, 1000]);
  });

  it("A4: switched on through PATCH, a silent baseline, then one push when Visa is paid off", async () => {
    const aa = require("../../teller/services/advice-alerts");
    aa._reset();
    const pushes = async () => (await q("SELECT title, body, data FROM notification_log WHERE type = 'advice-plan'")).rows;
    assert.equal((await aa.runAdviceAlerts(pool, { today })).status, "disabled"); // off by default
    await supertest(perfinApp()).patch("/api/settings").send({ advice_alerts_enabled: "yes" }).expect(400);
    await supertest(perfinApp()).patch("/api/settings").send({ advice_alerts_enabled: true }).expect(200);
    const base = await aa.runAdviceAlerts(pool, { today });
    assert.equal(base.status, "baseline");
    assert.equal(base.signature.target, "Visa");
    assert.equal((await aa.runAdviceAlerts(pool, { today })).status, "checked"); // once a local day
    assert.equal((await pushes()).length, 0);

    // Visa paid off: no balance, no interest. Pretend the check was yesterday.
    await q("UPDATE linked_accounts SET current_balance = 0 WHERE account_id = 'visa'");
    await q("DELETE FROM transactions WHERE transaction_id = 'visa-int'");
    await q("UPDATE user_settings SET advice_state = jsonb_set(advice_state, '{checked_on}', '\"2000-01-01\"') WHERE id = 1");
    aa._reset();
    const r = await aa.runAdviceAlerts(pool, { today });
    assert.equal(r.status, "notified");
    const rows = await pushes();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].title, "Your plan changed");
    assert.match(rows[0].body, /^Visa is paid off — your plan now puts \$[\d,]+ per paycheck toward Store card\.$/);
    assert.equal(rows[0].data.url, "/dashboard");
    const state = (await q("SELECT advice_state FROM user_settings WHERE id = 1")).rows[0].advice_state;
    assert.equal(state.signature.target, "Store card");
    assert.equal(state.checked_on, today);

    // Switching off and on again starts from a fresh baseline.
    await supertest(perfinApp()).patch("/api/settings").send({ advice_alerts_enabled: false }).expect(200);
    await supertest(perfinApp()).patch("/api/settings").send({ advice_alerts_enabled: true }).expect(200);
    assert.equal((await q("SELECT advice_state FROM user_settings WHERE id = 1")).rows[0].advice_state, null);
    assert.equal((await aa.runAdviceAlerts(pool, { today })).status, "baseline");
    assert.equal((await pushes()).length, 1);
  });

  it("A5: the emergency tracker and a funding-linked goal's catch-up from real rows", async () => {
    const { addMonthsYmd } = require("../../teller/services/projections");
    const chk = (await q("SELECT id FROM linked_accounts WHERE account_id = 'chk'")).rows[0].id;
    // $20,000 in checking − a $15,000 baseline = $5,000 toward $30,000 in 10 months at $1,000 a month.
    await q(`INSERT INTO financial_goals (name, target_amount, current_amount, monthly_contribution, target_date, funding_account_id, goal_baseline_amount)
             VALUES ('House', 30000, 0, 1000, $1, $2, 15000)`, [addMonthsYmd(today, 10), chk]);
    await q(`INSERT INTO financial_goals (name, target_amount, current_amount, monthly_contribution, target_date)
             VALUES ('Trip', 1200, 600, 200, $1)`, [addMonthsYmd(today, 6)]);
    await q(`INSERT INTO financial_goals (name, target_amount, current_amount, is_active) VALUES ('Old', 500, 0, false)`);
    const plan = await advice.getAdvicePlan(pool);
    assert.equal(plan.ok, true);
    assert.deepEqual(plan.errors, []);
    const e = plan.emergency;
    assert.equal(e.have, plan.cash.spendable);
    assert.equal(e.months_covered, Math.floor((e.have / plan.cash.avg_monthly_spending) * 10) / 10);
    assert.equal(e.reached, e.have >= e.target);
    const byName = Object.fromEntries(plan.goals.map((g) => [g.name, g]));
    assert.deepEqual(Object.keys(byName).sort(), ["House", "Trip"]);
    assert.equal(byName.House.current, 5000);
    assert.equal(byName.House.status, "behind");
    assert.equal(byName.House.required_monthly, 2500);
    assert.equal(byName.House.add_monthly, 1500);
    assert.equal(byName.Trip.status, "on_track");
    // The same plan through the route, the card's source.
    const res = await supertest(perfinApp()).get("/api/advice").expect(200);
    assert.deepEqual(res.body.goals, JSON.parse(JSON.stringify(plan.goals)));
  });
});
