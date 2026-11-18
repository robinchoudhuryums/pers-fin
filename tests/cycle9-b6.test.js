// ============================================================================
// Cycle 9 Batch 6 — the cash plan (F30 F31 F32 F33 F37 F38), against the real
// modules:
//   - F30  detectRaises with paychecks that differ by cents (one raised deposit
//          is not a raise; two are, at full size, dated to the first raised
//          deposit); the alert key by payer + the day the level began, stable
//          across later deposits; a raise announced under the old key isn't
//          announced again
//   - F31  a loan with a known APR of 8%+ and no monthly payment stays in the
//          high-interest step (its payoff figures blank), on the card and in
//          the insight prompt; a 6% or no-APR loan without a payment does not
//   - F32  the spending average over the months that have data; the emergency
//          date in the starter-buffer step counting the debt step between
//   - F33  fireAverages: income and spending over the same months, behind the
//          Goals route and Ask's tool
//   - F37  the headline never promises a debt more than it can take (the rest
//          goes to the next debt / the emergency fund / investing, every figure
//          known to the audit); idle cash lines not rounded unless the cash cap
//          cuts them; only announced windfalls are marked seen
//   - F38  avg_daily_spend is what the projection uses; the payday candidates
//          ordered by the numeric id; whats-new's uncapped count; a year-end
//          investment transaction cancelled in January
// Every plan is built with an explicit `today`; the route tests derive their
// months from the clock the code reads (cycle-9 F59).
// The database-backed half is tests/contract/c9-batch6.contract.test.js.
// ============================================================================
if (!process.env.NEON_DATABASE_URL) process.env.NEON_DATABASE_URL = "postgres://localhost/test";
if (!process.env.TOKEN_ENCRYPTION_PASSPHRASE) process.env.TOKEN_ENCRYPTION_PASSPHRASE = "test-passphrase";

const { describe, it, before, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const ROOT = path.join(__dirname, "..");
const read = (f) => fs.readFileSync(path.join(ROOT, f), "utf8");
const a = require("../teller/services/advice");
const aa = require("../teller/services/advice-alerts");
const fq = require("../teller/services/financial-queries");

const TODAY = "2026-10-28";
const addDays = (d, n) => new Date(Date.parse(d + "T00:00:00Z") + n * 86400000).toISOString().slice(0, 10);
const MONTHS = ["2026-07", "2026-08", "2026-09"].map((m) => ({ month: m, income: 4333, spending: 2800 }));
const STREAM = [{ source: "ACME PAYROLL", cadence: "biweekly", amount: 2000 }];
function inputs(over = {}) {
  return {
    today: TODAY, errors: [], months: MONTHS, streams: STREAM,
    cash: { starting_balance: 15000, lowest: { date: "2026-11-20", balance: 14000 } },
    settings: { cash_alert_threshold: "500" },
    debts: [], activity: [], transfers: [], goals: [], deposits: [], categories: [],
    idle: { accounts: [], investments: [], snapshots: [] }, allocation: { total_value: 0, has_targets: false, classes: [] },
    subscriptions: { subs: [], bills: [], activity: [] }, contributions: { limits: {}, accounts: [], flows: [] },
    ...over,
  };
}
const plan = (over) => a.buildAdvicePlan(inputs(over));
const VISA_SMALL = { id: 1, account_id: "c1", name: "Visa", type: "credit", current_balance: "300", apr: "24.99", minimum_payment: "35" };
const VISA = { ...VISA_SMALL, current_balance: "3000", minimum_payment: "90" };
const MC = { id: 3, account_id: "c2", name: "Mastercard", type: "credit", current_balance: "4000", apr: "19.99", minimum_payment: "100" };
const CARRIED = [{ account_id: "c1", txns: 3, interest: true }, { account_id: "c2", txns: 3, interest: true }];
const LOAN = { id: 2, account_id: "l1", name: "Personal loan", type: "loan", current_balance: "6000", apr: "11.5" };

// ---------------------------------------------------------------------------
describe("F30 — a raise among paychecks that differ by cents", () => {
  // Six old-level paychecks a few cents apart — the last the highest of them,
  // which is what let it open the "raised" run — then the raise.
  const OLD = [[98, 2000.00], [84, 1999.85], [70, 2000.12], [56, 2000.05], [42, 2000.31], [28, 2000.45]];
  const deposits = (extra) => [...OLD, ...extra].map(([ago, amount]) => ({ date: addDays(TODAY, -ago), source: "ACME PAYROLL", amount }));

  it("one raised deposit is not a raise yet (it was reported as half its size, dated to an old-level paycheck)", () => {
    assert.deepEqual(a.detectRaises(deposits([[14, 2140.30]]), TODAY, STREAM), []);
  });

  it("two raised deposits: the full raise, dated to the first of them", () => {
    const [r] = a.detectRaises(deposits([[14, 2140.30], [0, 2140.10]]), TODAY, STREAM);
    assert.equal(r.since, addDays(TODAY, -14), "the first deposit at the new level, not the paycheck before it");
    assert.equal(r.to, 2140.2);
    assert.ok(r.raise_per_deposit > 139 && r.raise_per_deposit < 141, "about $140 a deposit, got " + r.raise_per_deposit);
    assert.ok(r.raise_monthly > 300, "about $303 a month");
  });

  it("every deposit of the run is at the new level: one that is back at the old level ends it", () => {
    // raised, old-level (a few cents above every earlier one), raised
    const rows = deposits([[28 - 14, 2140.30], [0, 2140.10]]);
    rows.splice(rows.length - 1, 0, { date: addDays(TODAY, -7), source: "ACME PAYROLL", amount: 2000.6 });
    for (const r of a.detectRaises(rows, TODAY, STREAM)) {
      assert.ok(r.raise_per_deposit > 100, "never a part-raise built from an old-level deposit: " + JSON.stringify(r));
    }
  });

  it("clean pay still detects as before", () => {
    const rows = [];
    for (let ago = 140; ago >= 0; ago -= 14) rows.push({ date: addDays(TODAY, -ago), source: "ACME PAYROLL", amount: ago <= 42 ? 2200 : 2000 });
    const [r] = a.detectRaises(rows, TODAY, STREAM);
    assert.deepEqual({ from: r.from, to: r.to, raise_per_deposit: r.raise_per_deposit, since: r.since },
      { from: 2000, to: 2200, raise_per_deposit: 200, since: addDays(TODAY, -42) });
  });

  it("the alert key is the payer and the day the level began — the same after the next paycheck", () => {
    const two = plan({ deposits: deposits([[14, 2140.30], [0, 2140.10]]) });
    const later = a.buildAdvicePlan(inputs({ today: addDays(TODAY, 14), months: MONTHS,
      deposits: deposits([[14, 2140.30], [0, 2140.10], [-14, 2140.55]]) }));
    assert.equal(two.raises.length, 1);
    assert.equal(later.raises.length, 1);
    assert.notEqual(two.raises[0].to, later.raises[0].to, "the level (a median) moved by cents — the old key's ingredient");
    const k1 = aa.windfallsOf(two).map((w) => w.key);
    const k2 = aa.windfallsOf(later).map((w) => w.key);
    assert.deepEqual(k1, ["raise:acme payroll:" + addDays(TODAY, -14)]);
    assert.deepEqual(k2, k1);
  });

  it("a raise announced under the old key (payer + level) is not announced again", async () => {
    aa._reset();
    const p = plan({ deposits: deposits([[14, 2140.30], [0, 2140.10]]) });
    const state = { signature: aa.signatureOf(p, "x"), windfalls_seen: ["raise:acme payroll:" + p.raises[0].to], checked_on: addDays(TODAY, -1) };
    const writes = [];
    const pool = { async query(sql, params) {
      if (/^SELECT advice_alerts_enabled/.test(sql)) return { rows: [{ advice_alerts_enabled: true, advice_state: state }] };
      if (/^UPDATE user_settings SET advice_state/.test(sql)) { writes.push(JSON.parse(params[0])); return { rows: [] }; }
      throw new Error("unexpected SQL: " + sql);
    } };
    let sent = 0;
    const r = await aa.runAdviceAlerts(pool, { now: new Date(TODAY + "T15:00:00Z"), today: TODAY, deps: { getPlan: async () => p, sendToAll: async () => { sent++; return { logged: true }; } } });
    assert.equal(r.status, "unchanged");
    assert.equal(sent, 0);
  });
});

// ---------------------------------------------------------------------------
describe("F31 — a high-APR loan with no monthly payment on file", () => {
  it("stays in the high-interest step; its payoff figures are blank, not wrong", () => {
    const p = plan({ debts: [LOAN] });
    assert.equal(p.headline.step, "high_interest_debt", "it used to drop out and the plan said Invest");
    assert.equal(p.headline.text, "Pay down Personal loan first: $400.00 per paycheck on top of its regular payment.");
    const [row] = p.allocation.debts;
    assert.equal(row.name, "Personal loan");
    assert.equal(row.minimum_unknown, true);
    assert.equal(row.minimum_monthly, 0);
    assert.equal(row.extra_monthly, 866.67);
    assert.equal(row.per_period, 400);
    assert.deepEqual([row.months_to_payoff, row.payoff_month, row.interest, row.interest_saved], [null, null, null, null]);
    assert.equal(row.minimum_never_pays_off, false, "unknown isn't 'never pays off'");
    assert.equal(p.surplus.required_minimums_monthly, 0);
    assert.ok(p.notes.includes("Personal loan: monthly payment unknown — set it on the loan card."));
    assert.equal(p.steps.find((s) => s.key === "high_interest_debt").remaining, 6000);
  });

  it("beside a card: avalanche order by APR, no snowball line, the card's own figures intact", () => {
    const p = plan({ debts: [LOAN, VISA], activity: CARRIED });
    assert.deepEqual(p.allocation.debts.map((d) => d.name), ["Visa", "Personal loan"]);
    assert.equal(p.allocation.snowball, null);
    const visa = p.allocation.debts[0];
    assert.equal(visa.minimum_unknown, undefined);
    assert.ok(visa.months_to_payoff > 0 && visa.payoff_month);
    assert.equal(p.surplus.required_minimums_monthly, 90, "only the card's minimum is a known commitment");
  });

  it("with no surplus it still leads the plan", () => {
    const p = plan({ debts: [LOAN], months: MONTHS.map((m) => ({ ...m, spending: 4300 })) });
    assert.equal(p.headline.step, "high_interest_debt");
    assert.equal(p.headline.text, "Pay down Personal loan first (11.5% APR) once there's a surplus.");
  });

  it("a 6% loan or a loan with no APR, without a payment, is not pulled in", () => {
    assert.equal(plan({ debts: [{ ...LOAN, apr: "6" }] }).headline.step, "invest");
    assert.equal(plan({ debts: [{ ...LOAN, apr: null }] }).headline.step, "invest");
    assert.equal(plan({ debts: [{ ...LOAN, apr: "6" }] }).allocation.debts.length, 0);
  });

  it("a loan WITH a payment is unchanged: no flag, a payoff month", () => {
    const [row] = plan({ debts: [{ ...LOAN, monthly_payment: "200" }] }).allocation.debts;
    assert.equal(row.minimum_unknown, undefined);
    assert.equal(row.minimum_monthly, 200);
    assert.ok(row.months_to_payoff > 0);
  });

  it("the card says to set the payment (not a red 'never pays off'); the prompt block says there is no payoff date", () => {
    const p = plan({ debts: [LOAN] });
    const dash = read("teller/views/dashboard.ejs");
    const from = dash.indexOf("    var ADVICE_DISCLAIMER");
    const to = dash.indexOf("    // Design D3: the Summary card + Needs attention");
    assert.ok(from > 0 && to > from);
    const ctx = {
      esc: (s) => String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"),
      fmt: (n) => (Number(n) < 0 ? "-$" : "$") + Math.abs(Number(n)).toFixed(2),
      emptyState: (o) => "EMPTY(" + JSON.stringify(o) + ")", Number, String, Date, JSON,
    };
    vm.runInNewContext(dash.slice(from, to), ctx);
    const html = ctx.adviceDebtRows(p);
    assert.match(html, /data-label="Paid off">Set its monthly payment<\/td>/);
    assert.doesNotMatch(html, /amt-bad/);
    const withPayment = ctx.adviceDebtRows(plan({ debts: [{ ...LOAN, monthly_payment: "200" }] }));
    assert.doesNotMatch(withPayment, /Set its monthly payment/);

    const block = require("../teller/routes/insights").cashPlanPromptBlock(p);
    assert.match(block, /- Personal loan: APR 11\.5%, balance \$6,?000\.00, pay \$400\.00 per paycheck on top of its regular payment \(\$866\.67 a month extra; its monthly payment isn't on file, so there is no payoff date\)/);
    assert.doesNotMatch(block, /\$0\.00 minimum/);
  });
});

// ---------------------------------------------------------------------------
describe("F32 — the spending average and the emergency date", () => {
  it("one month of data is averaged over one month, not three", () => {
    const p = plan({ months: [{ month: "2026-09", income: 4333, spending: 3000 }], cash: { starting_balance: 3200, lowest: null } });
    assert.equal(p.cash.avg_monthly_spending, 3000, "it read $1,000 — a third");
    assert.equal(p.cash.spending_months, 1);
    assert.equal(p.cash.starter_target, 3500);
    assert.equal(p.cash.emergency_target, 9000);
    assert.equal(p.emergency.reached, false, "$3,200 against $9,000 — it used to read as reached ($3,000 target)");
    assert.equal(p.emergency.months_covered, 1);
    assert.equal(p.headline.step, "starter_buffer");
    assert.ok(p.notes.includes("Your average spending is from 1 complete month of history, so the cash targets may move as more arrives."));
  });

  it("two months: their mean; three months: unchanged and no note", () => {
    const two = plan({ months: [{ month: "2026-08", income: 4000, spending: 2000 }, { month: "2026-09", income: 4000, spending: 3000 }] });
    assert.equal(two.cash.avg_monthly_spending, 2500);
    assert.ok(two.notes.some((n) => /from 2 complete months of history/.test(n)));
    const three = plan();
    assert.equal(three.cash.avg_monthly_spending, 2800);
    assert.equal(three.cash.spending_months, 3);
    assert.ok(!three.notes.some((n) => /complete month/.test(n)));
  });

  it("a month outside the last three completed ones doesn't count; no data at all says so", () => {
    const p = plan({ months: [{ month: "2026-05", income: 4000, spending: 9000 }, { month: "2026-10", income: 4000, spending: 9000 }] });
    assert.equal(p.cash.spending_months, 0);
    assert.equal(p.cash.avg_monthly_spending, 0);
    assert.ok(p.notes.includes("No complete month of spending is on record yet, so the cash targets are your floor alone."));
  });

  it("in the starter-buffer step with high-interest debt, the emergency date counts the buffer, the debt payoff, then the rest", () => {
    const p = plan({ debts: [VISA], activity: CARRIED, cash: { starting_balance: 2000, lowest: null } });
    assert.equal(p.headline.step, "starter_buffer");
    const rec = p.surplus.recommended_monthly;
    assert.equal(rec, 812.5);
    const payoff = a.allocateDebts(a.normalizeDebts([VISA], CARRIED, TODAY), rec, TODAY, 26).rows[0].months_to_payoff;
    const expected = Math.ceil(1300 / rec) + payoff + Math.ceil((8400 - 3300) / rec);
    assert.equal(payoff, 4);
    assert.equal(expected, 13);
    assert.deepEqual(p.emergency.projection, { months: 13, month: "2027-11" }, "it was 8 months — as if the card didn't come first");
    assert.equal(p.emergency.note, "It comes after your starter buffer and your high-interest debt.");
  });

  it("without high-interest debt the buffer-step date is as before; a debt whose payoff is unknown gives no date", () => {
    const none = plan({ cash: { starting_balance: 2000, lowest: null } });
    assert.equal(none.headline.step, "starter_buffer");
    assert.deepEqual(none.emergency.projection, { months: Math.ceil(6400 / none.surplus.recommended_monthly), month: "2027-" + String(10 + Math.ceil(6400 / none.surplus.recommended_monthly) - 12).padStart(2, "0") });
    assert.equal(none.emergency.note, null);
    const unknown = plan({ debts: [LOAN], cash: { starting_balance: 2000, lowest: null } });
    assert.equal(unknown.headline.step, "starter_buffer");
    assert.equal(unknown.emergency.projection, null);
    assert.equal(unknown.emergency.note, "It comes after your starter buffer and your high-interest debt.");
  });
});

// ---------------------------------------------------------------------------
describe("F33 — FIRE averages income and spending over the same months", () => {
  const { fireAverages } = require("../teller/services/projections");
  const supertest = require("supertest");
  const express = require("express");
  let dbModule, originalQuery;
  before(() => { dbModule = require("../teller/services/database"); originalQuery = dbModule.pool.query; });
  afterEach(() => { dbModule.pool.query = originalQuery; });

  it("income paid in 1 month of 3 is divided by 3, like the spending", () => {
    const r = fireAverages(
      [{ month: "2026-08", total_income: "9000" }],
      [{ month: "2026-07", total_spend: "3000" }, { month: "2026-08", total_spend: "3000" }, { month: "2026-09", total_spend: "3000" }],
      "2026-10");
    assert.deepEqual(r, { months: 3, avg_income: 3000, avg_spending: 3000 });
  });

  it("the month in progress is left out of both; a month with only income counts for both; no rows → zeros", () => {
    const r = fireAverages(
      [{ month: "2026-09", total_income: "4000" }, { month: "2026-10", total_income: "99999" }],
      [{ month: "2026-08", total_spend: "1000" }, { month: "2026-10", total_spend: "99999" }],
      "2026-10");
    assert.deepEqual(r, { months: 2, avg_income: 2000, avg_spending: 500 });
    assert.deepEqual(fireAverages([], [], "2026-10"), { months: 0, avg_income: 0, avg_spending: 0 });
    assert.deepEqual(fireAverages(null, undefined, "2026-10"), { months: 0, avg_income: 0, avg_spending: 0 });
  });

  // Months derived from the clock the route reads.
  const m1 = fq.previousMonthKey(fq.currentMonth());
  const m2 = fq.previousMonthKey(m1);
  const m3 = fq.previousMonthKey(m2);
  const stub = () => {
    dbModule.pool.query = async (sql) => {
      if (/fire_expected_return_pct/.test(sql)) return { rows: [{ fire_expected_return_pct: "5", fire_withdrawal_rate_pct: "4", fire_monthly_spending_override: null }] };
      if (/total_income/i.test(sql)) return { rows: [{ month: m2, total_income: "9000" }, { month: fq.currentMonth(), total_income: "50000" }] };
      if (/total_spend/i.test(sql)) return { rows: [m3, m2, m1].map((month) => ({ month, total_spend: "2000" })) };
      if (/FROM linked_accounts/i.test(sql)) return { rows: [] };
      return { rows: [{ id: 1, name: "Brokerage", balance: "100000", account_type: "brokerage", is_active: true }] };
    };
  };

  it("GET /api/fire-projection: $9,000 in one of three months is $3,000 a month, so $1,000 saved — not $7,000", async () => {
    stub();
    const app = express();
    app.use(require("../teller/routes/goals"));
    const body = (await supertest(app).get("/api/fire-projection").expect(200)).body;
    assert.equal(body.data_basis.completed_months_used, 3);
    assert.equal(body.data_basis.avg_monthly_income, 3000);
    assert.equal(body.data_basis.avg_monthly_spending, 2000);
    assert.equal(body.data_basis.monthly_savings, 1000);
  });

  it("Ask's get_fire_projection agrees with the route", async () => {
    stub();
    const app = express();
    app.use(require("../teller/routes/goals"));
    const route = (await supertest(app).get("/api/fire-projection").expect(200)).body;
    const tool = await require("../teller/routes/ask").TOOL_EXECUTORS.get_fire_projection({});
    assert.equal(tool.months_to_fire, route.months_to_fire);
    assert.equal(tool.fire_number, route.fire_number);
    assert.equal(tool.runway_months, route.runway_months);
  });

  it("neither caller averages on its own any more", () => {
    for (const f of ["teller/routes/goals.js", "teller/routes/ask.js"]) {
      const src = read(f);
      assert.match(src, /fireAverages\(/, f);
      assert.doesNotMatch(src, /vals\.length \? vals\.reduce|v\.length \? v\.reduce/, f);
    }
  });
});

// ---------------------------------------------------------------------------
describe("F37 — the headline, idle cash and windfalls", () => {
  const { planFigures } = require("../teller/services/ai-audit");

  it("one small high-interest debt: the headline names what finishes it and where the rest goes", () => {
    const p = plan({ debts: [VISA_SMALL], activity: CARRIED });
    const [visa] = p.allocation.debts;
    assert.equal(visa.payment_monthly, 306.25, "$300 + a month's interest");
    assert.equal(visa.extra_monthly, 271.25);
    assert.equal(p.headline.text, "Pay off Visa: $125.19 per paycheck on top of its minimum finishes it; the rest of your $400.00 per paycheck goes to investing.");
    assert.equal(p.headline.amount_per_period, 400, "the plan's amount is unchanged — no plan-change push for the last payment");
    assert.equal(p.allocation.debt_extra_monthly, 271.25);
    assert.equal(p.allocation.invest_monthly, 595.42);
    assert.equal(Math.round((p.allocation.debt_extra_monthly + p.allocation.invest_monthly) * 100), Math.round(p.surplus.recommended_monthly * 100), "every dollar is placed");
  });

  it("the rest goes to the emergency fund while that isn't reached", () => {
    const p = plan({ debts: [VISA_SMALL], activity: CARRIED, cash: { starting_balance: 5000, lowest: { date: "2026-11-20", balance: 4000 } } });
    assert.match(p.headline.text, /the rest of your \$400\.00 per paycheck goes to your emergency fund\.$/);
    assert.equal(p.allocation.emergency_monthly, 595.42);
    assert.equal(p.allocation.invest_monthly, 0);
    assert.equal(p.allocation.emergency_per_period, 274.81);
  });

  it("with a second high-interest debt the overflow goes to it and nothing is left over", () => {
    const p = plan({ debts: [VISA_SMALL, MC], activity: CARRIED });
    assert.equal(p.headline.text, "Pay off Visa: $125.19 per paycheck on top of its minimum finishes it; the rest of your $375.00 per paycheck goes to Mastercard.");
    assert.equal(p.allocation.debt_extra_monthly, p.surplus.recommended_monthly);
    assert.equal(p.allocation.invest_monthly, 0);
    assert.equal(p.allocation.emergency_monthly, 0);
    assert.equal(p.allocation.debts[1].extra_monthly, 541.25, "$812.50 − Visa's $271.25");
  });

  it("a debt the amount doesn't finish keeps the old headline and the whole amount", () => {
    const p = plan({ debts: [VISA], activity: CARRIED });
    assert.equal(p.headline.text, "Pay down Visa first: $375.00 per paycheck on top of its minimum.");
    assert.equal(p.allocation.debt_extra_monthly, p.surplus.recommended_monthly);
    assert.equal(p.allocation.invest_monthly, 0);
  });

  it("the medium step: the debt half a small loan can't take is invested", () => {
    const car = { id: 5, account_id: "l5", name: "Car loan", type: "loan", current_balance: "150", apr: "6", monthly_payment: "50" };
    const p = plan({ debts: [car] });
    assert.equal(p.headline.step, "medium_interest_debt");
    const [row] = p.allocation.debts;
    assert.equal(p.allocation.debt_extra_monthly, row.extra_monthly);
    assert.equal(Math.round((p.allocation.debt_extra_monthly + p.allocation.invest_monthly) * 100), Math.round(p.surplus.recommended_monthly * 100));
    assert.ok(p.allocation.invest_monthly > p.surplus.recommended_monthly / 2, "more than half is invested");
    assert.match(p.headline.text, /^Split your extra: \$\d+\.\d\d per paycheck to Car loan, \$\d+\.\d\d per paycheck to investing\.$/);
  });

  it("every per-paycheck figure in a capped headline is one the audit knows", () => {
    for (const p of [plan({ debts: [VISA_SMALL], activity: CARRIED }), plan({ debts: [VISA_SMALL, MC], activity: CARRIED })]) {
      const known = planFigures(p).perPeriod;
      const stated = [...p.headline.text.matchAll(/\$([\d,]+\.\d\d) per paycheck/g)].map((m) => Number(m[1].replace(/,/g, "")));
      assert.ok(stated.length >= 2);
      for (const v of stated) assert.ok(known.some((k) => Math.abs(k - v) < 0.005), v + " isn't among " + JSON.stringify(known));
    }
  });

  // Idle cash: checking never under $12,000 in 60 days, a card of $1,234.56
  // and one of $80, a brokerage to invest in.
  const CHK = { id: 10, name: "Checking", type: "depository", subtype: "checking", current_balance: 15000, is_investment: false };
  const BRK = { id: 4, name: "Brokerage", account_type: "brokerage" };
  const snaps = [{ id: 10, date: addDays(TODAY, -80), balance: 12000 }];
  const C1 = { id: 1, account_id: "c1", name: "Visa", type: "credit", current_balance: "1234.56", apr: "24.99", minimum_payment: "40" };
  const C2 = { id: 3, account_id: "c2", name: "Store card", type: "credit", current_balance: "80", apr: "27", minimum_payment: "25" };
  const idle = { accounts: [CHK], investments: [BRK], snapshots: snaps };

  it("an idle-cash debt line is the debt's balance, a debt under $100 isn't dropped, and the lines add up", () => {
    const p = plan({ debts: [C1, C2], activity: CARRIED, idle });
    assert.ok(p.idle_cash, "idle cash found");
    const by = Object.fromEntries(p.idle_cash.moves.map((m) => [m.to, m.amount]));
    assert.equal(by["Visa"], 1234.56, "it was rounded down to $1,200");
    assert.equal(by["Store card"], 80, "it was rounded down to $0 and dropped");
    const total = p.idle_cash.moves.reduce((t, m) => t + m.amount, 0);
    assert.equal(Math.round(total * 100), Math.round(p.idle_cash.amount * 100));
    // $12,000 − the $3,300 buffer = $8,700 idle; $2,100 of it is the emergency fund's
    // (no savings account → it stays in checking); the rest moves, to the cent.
    assert.equal(by["Brokerage (investing)"], 5285.44, "$8,700 − $2,100 − the two cards");
    assert.equal(p.idle_cash.amount, 6600, "nothing lost to rounding (it moved $6,400)");
  });

  it("a line the cash cap cuts is still rounded down to $100", () => {
    const p = plan({ debts: [C1, C2], activity: CARRIED, idle, cash: { starting_balance: 15000, lowest: { date: "2026-11-20", balance: 1950 } } });
    // Room above the $500 floor: $1,450 — the store card ($80, 27% first), then $1,370 of Visa's $1,234.56 fits, then $135.44 → $100 of investing.
    assert.deepEqual(p.idle_cash.moves.map((m) => [m.to, m.amount]), [["Store card", 80], ["Visa", 1234.56], ["Brokerage (investing)", 100]]);
  });

  describe("windfalls", () => {
    beforeEach(() => aa._reset());
    const three = { ok: true, headline: { step: "invest", text: "Invest $400.00 per paycheck more.", amount_monthly: 866.67, amount_per_period: 400 },
      period: { unit: "paycheck", paychecks_per_year: 26 }, allocation: { debts: [] }, debts: [],
      bonuses: [1, 2, 3].map((n) => ({ source: "Payer " + n, date: "2026-10-2" + n, amount: 1000 * n, text: "Bonus " + n + "." })), raises: [] };

    it("only the windfalls a push names are marked seen; the third goes out the next day", async () => {
      let state = { signature: aa.signatureOf(three, "x"), windfalls_seen: [], checked_on: addDays(TODAY, -1) };
      const pool = { async query(sql, params) {
        if (/^SELECT advice_alerts_enabled/.test(sql)) return { rows: [{ advice_alerts_enabled: true, advice_state: state }] };
        if (/^UPDATE user_settings SET advice_state/.test(sql)) { state = JSON.parse(params[0]); return { rows: [] }; }
        throw new Error("unexpected SQL: " + sql);
      } };
      const pushes = [];
      const deps = { getPlan: async () => three, sendToAll: async (p) => { pushes.push(p.body); return { logged: true }; } };
      const first = await aa.runAdviceAlerts(pool, { now: new Date(TODAY + "T15:00:00Z"), today: TODAY, deps });
      assert.equal(first.status, "notified");
      assert.equal(first.windfalls, aa.WINDFALLS_PER_PUSH);
      assert.equal(pushes[0], "Bonus 1. Bonus 2.");
      assert.equal(state.windfalls_seen.length, 2, "the third used to be marked seen here — and was never announced");
      aa._reset();
      const next = addDays(TODAY, 1);
      const second = await aa.runAdviceAlerts(pool, { now: new Date(next + "T15:00:00Z"), today: next, deps });
      assert.equal(second.status, "notified");
      assert.equal(pushes[1], "Bonus 3.");
      assert.equal(state.windfalls_seen.length, 3);
      aa._reset();
      const third = await aa.runAdviceAlerts(pool, { now: new Date(addDays(TODAY, 2) + "T15:00:00Z"), today: addDays(TODAY, 2), deps });
      assert.equal(third.status, "unchanged");
      assert.equal(pushes.length, 2);
    });
  });
});

// ---------------------------------------------------------------------------
describe("F38 — smaller items", () => {
  const cf = require("../teller/services/cash-flow");

  it("avg_daily_spend is the average of what the projection takes off each day", () => {
    // Weekday averages that count the days with no spending: $20 on weekdays, $0 at weekends —
    // while the inputs' own 60-day figure (spending days only) says $60.
    const r = cf.projectCashFlow({ today: "2026-11-01", incomeStreams: [], bills: [], left_out: [], startingBalance: 5000,
      avgDailySpend: 60, dowSpend: { 0: 0, 1: 20, 2: 20, 3: 20, 4: 20, 5: 20, 6: 0 } }, { days: 28 });
    assert.equal(r.total_projected_discretionary, 400, "20 weekdays × $20");
    assert.equal(r.avg_daily_spend, Math.round((400 / 28) * 100) / 100, "what the forecast uses — it showed $60");
    assert.equal(Math.round(r.avg_daily_spend * 28), r.total_projected_discretionary);
  });

  it("without weekday averages it is still the fallback figure", () => {
    const r = cf.projectCashFlow({ today: "2026-11-01", incomeStreams: [], bills: [], left_out: [], startingBalance: 100, avgDailySpend: 10, dowSpend: {} }, { days: 30 });
    assert.equal(r.avg_daily_spend, 10);
  });

  it("the payday candidates are ordered by the numeric id column, not the text alias", () => {
    const src = read("teller/services/payday-alerts.js");
    assert.match(src, /SELECT id::text AS id,/);
    assert.match(src, /ORDER BY transactions\.id`/);
    assert.doesNotMatch(src, /ORDER BY id`/);
  });

  describe("whats-new", () => {
    let dbModule, originalQuery;
    before(() => { dbModule = require("../teller/services/database"); originalQuery = dbModule.pool.query; });
    afterEach(() => { dbModule.pool.query = originalQuery; });
    const whatsNew = require("../teller/routes/whats-new");
    const run = async (txnRows) => {
      const sqls = [];
      dbModule.pool.query = async (sql) => {
        sqls.push(sql);
        if (/FROM transactions t/.test(sql)) return { rows: txnRows };
        return { rows: [] };
      };
      return { out: await whatsNew.gatherWhatsNew(new Date("2026-10-28T09:00:00Z")), sqls };
    };

    it("60 new transactions read 60, though the list holds 25; the helper column isn't sent", async () => {
      const rows = Array.from({ length: 25 }, (_, i) => ({ transaction_id: "t" + i, date: "2026-10-27", amount: "5", merchant: "M", category: null, account_name: "Checking", total_count: "60" }));
      const { out, sqls } = await run(rows);
      assert.equal(out.counts.transactions, 60);
      assert.equal(out.transactions.length, 25);
      assert.ok(out.transactions.every((t) => !("total_count" in t)));
      const txnSql = sqls.find((s) => /FROM transactions t/.test(s));
      assert.match(txnSql, /COUNT\(\*\) OVER\(\) AS total_count/);
      assert.match(txnSql, /LIMIT \$2/);
    });

    it("none → 0; a row with no total (an older double) counts the rows", async () => {
      assert.equal((await run([])).out.counts.transactions, 0);
      assert.equal((await run([{ transaction_id: "a" }, { transaction_id: "b" }])).out.counts.transactions, 2);
    });
  });

  describe("a year-end investment transaction cancelled in January", () => {
    const tax = require("../teller/services/tax-investments");
    let seq = 0;
    const tx = (o) => ({
      plaid_investment_transaction_id: o.id || "x" + (++seq), investment_account_id: 1, txn_date: o.date, type: o.type,
      subtype: o.subtype || o.type, security_id: "AAA", ticker: "AAA", security_name: "Alpha Fund",
      quantity: o.qty, amount: o.amount, fees: 0, cancel_transaction_id: o.cancels || null,
    });
    const poolWith = (rows) => {
      const calls = [];
      return { calls, query: async (sql, params) => {
        calls.push({ sql, params });
        if (/FROM investment_accounts/.test(sql)) return { rows: [{ id: 1, name: "Brokerage", institution: "Schwab", account_type: "brokerage", is_active: true }] };
        return { rows };
      } };
    };

    it("the cancel row is read and the December sale and dividend it cancels leave the year", async () => {
      const rows = [
        tx({ date: "2025-01-02", type: "buy", qty: 10, amount: 1000 }),
        tx({ id: "sale-dec", date: "2026-12-30", type: "sell", qty: -10, amount: -1500 }),
        tx({ id: "div-dec", date: "2026-12-31", type: "cash", subtype: "dividend", qty: 0, amount: -40 }),
        tx({ date: "2026-06-01", type: "cash", subtype: "dividend", qty: 0, amount: -15 }),
        // January of the next year: the cancels, and an unrelated January dividend
        tx({ date: "2027-01-04", type: "cancel", qty: 10, amount: 1500, cancels: "sale-dec" }),
        tx({ date: "2027-01-04", type: "cancel", qty: 0, amount: 40, cancels: "div-dec" }),
      ];
      const pool = poolWith(rows);
      const d = await tax.getInvestmentTaxData(pool, 2026);
      const call = pool.calls.find((c) => /FROM investment_transactions/.test(c.sql) && /ORDER BY txn_date/.test(c.sql));
      assert.deepEqual(call.params, ["2027-01-01"]);
      assert.match(call.sql, /OR \(cancel_transaction_id IS NOT NULL AND cancel_transaction_id IN \(\s*SELECT plaid_investment_transaction_id FROM investment_transactions WHERE txn_date < \$1::date\)\)/);
      assert.equal(d.realized_gains.sales.length, 0, "the cancelled December sale");
      assert.equal(d.investment_income.totals.dividends, 15, "the June dividend only");
    });

    it("without the cancel the same rows count; a later-year row that cancels nothing is never part of the year", async () => {
      const rows = [
        tx({ date: "2025-01-02", type: "buy", qty: 10, amount: 1000 }),
        tx({ id: "sale-dec2", date: "2026-12-30", type: "sell", qty: -10, amount: -1500 }),
        // would only be returned by a careless query; the code must not use it
        tx({ date: "2027-01-10", type: "cash", subtype: "dividend", qty: 0, amount: -999 }),
        tx({ date: "2027-01-11", type: "buy", qty: 5, amount: 1 }),
      ];
      const d = await tax.getInvestmentTaxData(poolWith(rows), 2026);
      assert.equal(d.realized_gains.sales.length, 1);
      assert.equal(d.realized_gains.sales[0].gain, 500);
      assert.equal(d.investment_income.totals.dividends, 0);
    });
  });
});
