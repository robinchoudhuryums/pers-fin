// Real-Postgres contract test for roadmap T2.2 L1 — the cash-flow forecast as a
// shared service, the production routers mounted in server.js order:
//  - GET /api/cash-flow and services/cash-flow getCashFlowForecast agree on a
//    real schema (spendable cash only, card autopay not billed, a biweekly
//    payroll stream, a subscription and a loan payment on their days)
//  - the lowest projected day is reported and firstBelow finds a floor crossing
const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const supertest = require("supertest");
const { SKIP, perfinDb, perfinApp } = require("./_setup");

describe("Cash-flow forecast service (T2.2 L1) on real Postgres", { skip: SKIP }, () => {
  let pool, app, today, add, loanIn;
  const q = (s, p) => pool.query(s, p);

  before(async () => {
    pool = await perfinDb("cashflow_l1");
    app = perfinApp();
    today = require("../../teller/services/financial-queries").todayStr();
    add = (n) => require("../../teller/services/cadence").addDaysStr(today, n);

    const acct = (id, type, subtype, bal) => q(
      "INSERT INTO linked_accounts (account_id, name, type, subtype, is_manual, current_balance) VALUES ($1,$1,$2,$3,true,$4)",
      [id, type, subtype, bal]);
    await acct("chk", "depository", "checking", 2000);
    await acct("brk", "depository", "brokerage", 50000);
    await acct("card", "credit", "credit card", 500);
    await acct("auto", "loan", "auto", 18000);

    // Biweekly payroll, the latest 13 days ago → paydays on today+1, +15, +29.
    for (const n of [13, 27, 41, 55, 69]) {
      await q("INSERT INTO transactions (account_id, transaction_id, amount, date, merchant_name, name, pending) VALUES ('chk',$1,-1000,$2,'ACME PAYROLL','ACME PAYROLL',false)",
        ["pay" + n, add(-n)]);
    }
    // Bills step by CALENDAR month from their last charge (DC-9), so each sits
    // on a day exactly one month after its last charge (a day the previous
    // month has): Netflix from day 3 (so its next charge, ≥ 28 days on, is
    // past the 30-day window), the loan payment after it — whatever today is.
    const monthBefore = (ymd) => {
      const [y, m, d] = ymd.split("-").map(Number);
      const py = m === 1 ? y - 1 : y, pm = m === 1 ? 12 : m - 1;
      if (d > new Date(Date.UTC(py, pm, 0)).getUTCDate()) return null;
      return `${py}-${String(pm).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
    };
    let netflixIn = 3;
    while (!monthBefore(add(netflixIn))) netflixIn++;
    loanIn = netflixIn + 1;
    while (!monthBefore(add(loanIn))) loanIn++;
    await q(`INSERT INTO detected_subscriptions (merchant_key, display_name, amount, cadence_days, first_seen, last_charged, next_expected, is_active)
             VALUES ('netflix','Netflix',15.49,30,$1,$2,$3,true)`, [add(-90), monthBefore(add(netflixIn)), add(netflixIn)]);
    const xfer = (key, name, amt, next, type) => q(
      `INSERT INTO recurring_transfers (merchant_key, display_name, amount, cadence_days, first_seen, last_transferred, next_expected, is_active, transfer_type, direction)
       VALUES ($1,$2,$3,30,$4,$5,$6,true,$7,'outgoing')`, [key, name, amt, add(-90), monthBefore(add(next)), add(next), type]);
    await xfer("loan", "AUTO LOAN PAYMENT", 400, loanIn, "bill_payment");
    await xfer("autopay", "CHASE CARD AUTOPAY", 1500, 2, "bill_payment");
  });
  after(async () => { if (pool) await pool.end(); });

  it("the route and the service return the same forecast on real rows", async () => {
    const body = (await supertest(app).get("/api/cash-flow?days=30").expect(200)).body;
    const svc = await require("../../teller/services/cash-flow").getCashFlowForecast(pool, { days: 30 });
    assert.equal(body.starting_balance, 2000, "brokerage, card and loan aren't spendable cash");
    assert.equal(body.total_projected_bills, 415.49, "Netflix + the loan payment; the card autopay isn't billed");
    assert.equal(body.total_projected_income, 3000);
    assert.equal(body.total_projected_discretionary, 0);
    assert.deepEqual(body.recurring_income.map((s) => [s.source, s.cadence, s.amount]), [["ACME PAYROLL", "biweekly", 1000]]);
    assert.deepEqual(body.by_week, svc.by_week);
    assert.equal(body.ending_balance, svc.ending_balance);
    assert.equal(body.ending_balance, 4584.51);
    assert.equal(body.by_week[0].start_date, add(1));
  });

  it("reports the lowest projected day; firstBelow finds the crossing", async () => {
    const body = (await supertest(app).get("/api/cash-flow?days=30").expect(200)).body;
    // 2000 → +1000 (day 1) → −15.49 (Netflix, day 3-6) → −400 (the loan, day 4-7)
    // = 2584.51, until the next payday on day 15.
    assert.equal(body.lowest_balance, 2584.51);
    assert.equal(body.lowest_balance_date, add(loanIn));
    const cf = require("../../teller/services/cash-flow");
    const { projection } = await cf.getCashFlowForecast(pool, { days: 30 });
    assert.deepEqual(cf.firstBelow(projection, 2600), { date: add(loanIn), balance: 2584.51 });
    assert.equal(cf.firstBelow(projection, 2000), null);
  });
});
