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

  it("A6: a raise, a bonus on a joint account at your share, and creeping spending from real rows", async () => {
    const { addDaysStr } = require("../../teller/services/cadence");
    const daysAgo = (n) => addDaysStr(today, -n);
    const ins = (id, account, amount, date, name, extra = {}) => q(
      `INSERT INTO transactions (account_id, transaction_id, amount, date, merchant_name, name, pending, category)
       VALUES ($1,$2,$3,$4,$5,$5,$6,$7)`,
      [account, id, amount, date, name, !!extra.pending, extra.category ? [extra.category] : null]);
    await q(`INSERT INTO linked_accounts (account_id, name, type, subtype, is_manual, is_shared, spending_split_pct)
             VALUES ('joint', 'Joint', 'depository', 'checking', true, true, 50)`);
    // BETA pays every two weeks: $1,800 until 70 days ago, then $2,000.
    for (let d = 196; d >= 14; d -= 14) await ins("beta-" + d, "chk", d > 70 ? -1800 : -2000, daysAgo(d), "BETA CORP PAYROLL");
    // A $6,000 bonus into the joint account (yours: half); a pending one never counts.
    await ins("beta-bonus", "joint", -6000, daysAgo(10), "BETA CORP PAYROLL");
    await ins("beta-pending", "chk", -9000, daysAgo(1), "BETA CORP PAYROLL", { pending: true });
    // Dining: $100 a month for three months, then $650 with a $150 refund in one month.
    const six = advice.completedMonthKeys(today, advice.CREEP_MONTHS);
    for (const [i, m] of six.entries()) await ins("bistro-" + m, "chk", i < 3 ? 100 : 650, m + "-05", "BISTRO", { category: "Dining" });
    await ins("bistro-refund", "chk", -150, six[5] + "-20", "BISTRO");

    const plan = await advice.getAdvicePlan(pool);
    assert.equal(plan.ok, true);
    assert.deepEqual(plan.errors, []);
    const [r] = plan.raises;
    assert.equal(r.source, "BETA CORP PAYROLL");
    assert.equal(r.from, 1800);
    assert.equal(r.to, 2000);
    assert.equal(r.since, daysAgo(70));
    assert.equal(r.deposits_per_year, 26);
    assert.deepEqual(plan.bonuses.map((b) => [b.source, b.date, b.amount]), [["BETA CORP PAYROLL", daysAgo(10), 3000]]);
    assert.ok(plan.bonuses[0].split.length > 0);
    const dining = plan.spending_creep.find((c) => c.category === "Dining");
    assert.equal(dining.prior_monthly, 100);
    assert.equal(dining.recent_monthly, 600);
    const res = await supertest(perfinApp()).get("/api/advice").expect(200);
    assert.deepEqual(res.body.raises, JSON.parse(JSON.stringify(plan.raises)));
    assert.deepEqual(res.body.spending_creep, JSON.parse(JSON.stringify(plan.spending_creep)));
  });

  it("A7: idle checking moved only to accounts that exist, and rebalancing drift equal to the Investments card's", async () => {
    const { addDaysStr } = require("../../teller/services/cadence");
    const daysAgo = (n) => addDaysStr(today, -n);
    const idOf = async (accountId) => (await q("SELECT id FROM linked_accounts WHERE account_id = $1", [accountId])).rows[0].id;
    const snap = (id, date, bal) => q(
      `INSERT INTO account_balance_snapshots (source, source_id, snapshot_date, balance) VALUES ('linked', $1, $2, $3)
       ON CONFLICT (source, source_id, snapshot_date) DO UPDATE SET balance = EXCLUDED.balance`, [id, date, bal]);
    // Checking dipped to $9,000 a month ago; the joint checking held $0 the whole time.
    const chk = await idOf("chk"), joint = await idOf("joint");
    await snap(chk, daysAgo(70), 20000);
    await snap(chk, daysAgo(30), 9000);
    await snap(chk, daysAgo(5), 20000);
    await snap(joint, daysAgo(70), 0);
    await q(`INSERT INTO linked_accounts (account_id, name, type, subtype, is_manual, current_balance)
             VALUES ('sav', 'Savings', 'depository', 'savings', true, 0)`);
    // A taxable brokerage (holdings 55% equity / 45% bond) and its $0 linked phantom.
    await q(`INSERT INTO investment_accounts (name, account_type, balance, plaid_account_id) VALUES ('Taxable', 'brokerage', 20000, 'pb1')`);
    await q(`INSERT INTO linked_accounts (account_id, name, type, subtype, is_manual, current_balance)
             VALUES ('pb1', 'Taxable phantom', 'investment', 'brokerage', true, 0)`);
    await q(`INSERT INTO investment_holdings (plaid_account_id, security_id, ticker, name, current_value, cost_basis, security_type)
             VALUES ('pb1', 's1', 'VTI', 'Total market', 11000, 9000, 'equity'), ('pb1', 's2', 'BND', 'Bond fund', 9000, NULL, 'bond')`);
    await supertest(perfinApp()).patch("/api/settings").send({ target_allocation_pct: { equity: 70, bond: 30 } }).expect(200);

    const plan = await advice.getAdvicePlan(pool);
    assert.equal(plan.ok, true);
    assert.deepEqual(plan.errors, []);
    const idle = plan.idle_cash;
    assert.equal(idle.checking_low, 9000);
    assert.equal(idle.keep, plan.cash.starter_target);
    assert.ok(idle.amount <= idle.checking_low - idle.keep);
    const debts = new Set(plan.debts.map((d) => d.name));
    for (const m of idle.moves) {
      assert.ok(debts.has(m.to) || m.to === "Savings (emergency fund)" || m.to === "Taxable (investing)", m.to);
    }
    assert.equal(JSON.stringify(idle).includes("phantom"), false);
    assert.deepEqual(plan.rebalance.moves.map((m) => [m.from, m.to, m.amount]), [["bond", "equity", 3000]]);
    assert.doesNotMatch(JSON.stringify(plan.rebalance), /VTI|BND|Bond fund|Total market/);
    const perf = (await supertest(perfinApp()).get("/api/investments/performance").expect(200)).body;
    const card = Object.fromEntries(perf.by_asset_class.map((c) => [c.security_type, Math.round(c.drift_pct * 10) / 10]));
    assert.deepEqual(Object.fromEntries(plan.rebalance.drifting.map((c) => [c.security_type, c.drift_pct])), card);
    const res = await supertest(perfinApp()).get("/api/advice").expect(200);
    assert.deepEqual(res.body.idle_cash, JSON.parse(JSON.stringify(idle)));
    assert.deepEqual(res.body.rebalance, JSON.parse(JSON.stringify(plan.rebalance)));
  });

  it("A8: a card's statement date in its tip and its carried test, and a loan's extra $100 a month, from real rows", async () => {
    const { addDaysStr } = require("../../teller/services/cadence");
    const { addMonthsYmd, computeLoanPayoff } = require("../../teller/services/projections");
    const daysAgo = (n) => addDaysStr(today, -n);
    // Amex: $3,000 of an $8,000 limit, its last statement ($1,400) paid in full after it closed.
    await q(`UPDATE linked_accounts SET current_balance = 3000, last_statement_balance = 1400, last_statement_issue_date = $1,
               last_payment_amount = 1400, last_payment_date = $2 WHERE account_id = 'amex'`, [daysAgo(20), daysAgo(5)]);
    await q(`INSERT INTO linked_accounts (account_id, name, type, subtype, is_manual, current_balance, apr, monthly_payment)
             VALUES ('car', 'Car Loan', 'loan', 'auto', true, 18000, 6.5, 400)`);

    const plan = await advice.getAdvicePlan(pool);
    assert.equal(plan.ok, true);
    assert.deepEqual(plan.errors, []);
    const amex = plan.debts.find((d) => d.name === "Amex");
    assert.equal(amex.carried, false);
    assert.equal(amex.carry_reason, "statement_paid");
    const next = addMonthsYmd(daysAgo(20), 1);
    assert.deepEqual(amex.statement, { last_date: daysAgo(20), last_balance: 1400, reported_pct: 18, next_date: next });
    assert.equal(amex.utilization_tip.basis, "statement");
    assert.equal(amex.utilization_tip.by, next);
    assert.equal(amex.utilization_tip.pay, 600);

    assert.notEqual(plan.headline.step, "medium_interest_debt");
    const car = plan.loan_extra.find((l) => l.name === "Car Loan");
    const now = computeLoanPayoff({ balance: 18000, aprPct: 6.5, monthlyPayment: 400, today });
    const more = computeLoanPayoff({ balance: 18000, aprPct: 6.5, monthlyPayment: 500, today });
    assert.equal(car.months_sooner, now.months_to_payoff - more.months_to_payoff);
    assert.equal(car.interest_saved, Math.round((now.total_interest - more.total_interest) * 100) / 100);
    const res = await supertest(perfinApp()).get("/api/advice").expect(200);
    assert.deepEqual(res.body.loan_extra, JSON.parse(JSON.stringify(plan.loan_extra)));
  });

  it("A9: sinking funds from a yearly subscription and a quarterly manual bill, an overlap, and an unused membership, from real rows", async () => {
    const { addDaysStr, seriesOccurrences, manualBillOccurrences } = require("../../teller/services/cadence");
    const daysAgo = (n) => addDaysStr(today, -n), inDays = (n) => addDaysStr(today, n);
    const sub = (key, name, amount, cad, last, next, extra = "") => q(
      `INSERT INTO detected_subscriptions (merchant_key, display_name, amount, cadence_days, first_seen, last_charged, next_expected, is_active${extra ? ", " + extra : ""})
       VALUES ($1,$2,$3,$4,$5,$6,$7,true${extra ? ", " + (extra === "cancelled_at" ? "now()" : "true") : ""})`,
      [key, name, amount, cad, daysAgo(400), last, next]);
    await sub("insurer", "Car Insurance", 450, 90, daysAgo(30), inDays(60));
    await sub("netflix", "Netflix", 15.49, 30, daysAgo(10), inDays(20));
    await sub("hulu", "Hulu", 7.99, 30, daysAgo(10), inDays(20));
    await sub("disney", "Disney+", 13.99, 30, daysAgo(10), inDays(20), "cancelled_at"); // cancelled — left out
    await sub("prime", "Amazon Prime", 139, 365, daysAgo(100), inDays(265));
    await sub("costco", "Costco Membership", 65, 365, daysAgo(200), inDays(165));
    await q(`INSERT INTO manual_bills (name, amount, due_day, cadence, category, created_at) VALUES ('Water', 180, 20, 'quarterly', 'utility', $1::date)`, [daysAgo(50)]);
    await q(`INSERT INTO manual_bills (name, amount, due_day, cadence, category) VALUES ('Gym', 400, 5, 'monthly', 'bill')`);
    // A Costco purchase in the window (not the fee); Amazon only the fee itself.
    await q(`INSERT INTO transactions (account_id, transaction_id, amount, date, merchant_name, name, pending)
             VALUES ('chk', 'costco-buy', 212.4, $1, 'COSTCO WHSE #123', 'COSTCO WHSE #123', false),
                    ('chk', 'prime-fee', 139, $2, 'Amazon Prime', 'AMZN PRIME', false)`, [daysAgo(12), daysAgo(100)]);

    const plan = await advice.getAdvicePlan(pool);
    assert.equal(plan.ok, true);
    assert.deepEqual(plan.errors, []);
    const byName = Object.fromEntries(plan.sinking_funds.bills.map((b) => [b.name, b]));
    assert.deepEqual(Object.keys(byName).sort(), ["Amazon Prime", "Car Insurance", "Water"]);
    assert.equal(byName["Car Insurance"].due, seriesOccurrences(daysAgo(30), inDays(60), 90, today, inDays(400))[0]);
    const water = (await q("SELECT * FROM manual_bills WHERE name = 'Water'")).rows[0];
    assert.equal(byName.Water.due, manualBillOccurrences(water, today, inDays(400))[0]);
    assert.equal(byName.Water.per_year, 4);
    assert.deepEqual(plan.subscription_review.overlaps.map((o) => o.services.map((x) => x.name)), [["Netflix", "Hulu"]]);
    assert.deepEqual(plan.subscription_review.unused.map((u) => u.name), ["Amazon Prime"]);
    const res = await supertest(perfinApp()).get("/api/advice").expect(200);
    assert.deepEqual(res.body.sinking_funds, JSON.parse(JSON.stringify(plan.sinking_funds)));
    assert.deepEqual(res.body.subscription_review, JSON.parse(JSON.stringify(plan.subscription_review)));
  });
});
