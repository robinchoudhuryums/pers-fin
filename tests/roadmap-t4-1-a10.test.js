// Roadmap T4.1 A10 — contribution room and what-if (services/advice.js):
// normalizeLimits / contributionRoom (a limit you entered against this
// calendar year's contributions in investment_flows, the per-paycheck amount
// that fills it by Dec 31 rounded up, a reached limit, a Plaid account whose
// flows haven't synced, a limit naming a gone account left out, no account
// type assumed); applyWhatIf / whatIfPlan (the same engine on changed inputs:
// an extra payment on one carried debt, income / spending up or down a month,
// the lowest projected day moved with them, the before / after comparison and
// its text, every refusal); the readers' SQL; PATCH /api/settings
// contribution_limits; the Settings editor run in a vm; the card, the prompt
// block and Ask's get_cash_plan with overrides.
if (!process.env.NEON_DATABASE_URL) process.env.NEON_DATABASE_URL = "postgres://localhost/test";
if (!process.env.TOKEN_ENCRYPTION_PASSPHRASE) process.env.TOKEN_ENCRYPTION_PASSPHRASE = "test-passphrase";

const { describe, it, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const express = require("express");
const supertest = require("supertest");

const ROOT = path.join(__dirname, "..");
const read = (f) => fs.readFileSync(path.join(ROOT, f), "utf8");
const a = require("../teller/services/advice");
const dbModule = require("../teller/services/database");
const originalQuery = dbModule.pool.query;
afterEach(() => { dbModule.pool.query = originalQuery; });

const TODAY = "2026-10-28";
const MONTHS = ["2026-06", "2026-07", "2026-08", "2026-09", "2026-10"].map((m) => ({ month: m, income: 6000, spending: 2800 }));
const STREAMS = [{ source: "ACME PAYROLL", cadence: "biweekly", median_amount: 2769, last_date: "2026-10-24" }];
const DEBTS = () => [
  { id: 1, account_id: "v", name: "Visa", mask: "4242", type: "credit", current_balance: "4000", apr: "24.99", minimum_payment: "100", credit_limit: "10000", last_payment_amount: "100" },
  { id: 2, account_id: "c", name: "Car Loan", type: "loan", current_balance: "12000", apr: "6.5", monthly_payment: "350" },
];
const CONTRIB = () => ({
  limits: { "investment:3": 7000, "linked:9": 23000, "investment:99": 5000 },
  accounts: [
    { key: "investment:3", name: "Roth IRA", plaid: true, flows_synced: true },
    { key: "linked:9", name: "Work 401k", plaid: false, flows_synced: false },
    { key: "investment:4", name: "Brokerage", plaid: true, flows_synced: false },
  ],
  flows: [{ key: "investment:3", contributed: 2500, count: 5 }, { key: "investment:4", contributed: 900, count: 2 }],
});

function inputs(over = {}) {
  return {
    today: TODAY, errors: [],
    months: MONTHS, streams: STREAMS,
    cash: { starting_balance: 15000, lowest: { date: "2026-11-27", balance: 14000 } },
    settings: { cash_alert_threshold: "500" },
    debts: DEBTS(), activity: [{ account_id: "v", txns: 5, interest: true }], transfers: [], goals: [], deposits: [], categories: [],
    idle: { accounts: [], investments: [], snapshots: [] },
    allocation: { total_value: 0, has_targets: false, classes: [] },
    subscriptions: { subs: [], bills: [], activity: [] },
    contributions: CONTRIB(),
    ...over,
  };
}
const plan = (over) => a.buildAdvicePlan(inputs(over));

// ---------------------------------------------------------------------------
describe("T4.1 A10 — contribution room", () => {
  it("normalizeLimits keeps valid keys and values only, a JSON string parsed", () => {
    assert.deepEqual(a.normalizeLimits({ "investment:3": "7000", "linked:9": 23000.456, "brokerage:1": 5, "investment:0": 5, "investment:4": -1, "investment:5": 2000000, "investment:6": "x" }),
      { "investment:3": 7000, "linked:9": 23000.46 });
    assert.deepEqual(a.normalizeLimits('{"investment:3": 6500}'), { "investment:3": 6500 });
    for (const v of [null, undefined, "not json", [], 5]) assert.deepEqual(a.normalizeLimits(v), {});
  });

  it("periods left this year: paychecks (or months) after today, at least one", () => {
    assert.equal(a.periodsLeftInYear(TODAY, 26), 4);
    assert.equal(a.periodsLeftInYear(TODAY, 12), 2);
    assert.equal(a.periodsLeftInYear("2026-01-01", 26), 25);
    assert.equal(a.periodsLeftInYear("2026-12-31", 26), 1);
  });

  it("each limit against this year's contributions, the per-paycheck amount rounded up, most room first", () => {
    const r = a.contributionRoom(CONTRIB(), TODAY, { unit: "paycheck", ppy: 26 });
    assert.equal(r.year, 2026);
    assert.deepEqual(r.accounts.map((x) => [x.name, x.limit, x.contributed, x.room, x.per_period, x.reached]), [
      ["Work 401k", 23000, 0, 23000, 5750, false],
      ["Roth IRA", 7000, 2500, 4500, 1125, false],
    ]);
    assert.equal(r.room_total, 27500);
    assert.equal(r.accounts[1].text, "Roth IRA: $2,500.00 of your $7,000.00 limit for 2026 contributed — $4,500.00 of room left. $1,125.00 per paycheck would fill it by Dec 31. Only contributions recorded as investment flows count — log any others under Investments.");
    assert.equal(r.accounts[1].flows, 5);
    const odd = a.contributionRoom({ ...CONTRIB(), limits: { "investment:3": 7001 } }, TODAY, { unit: "paycheck", ppy: 26 });
    assert.equal(odd.accounts[0].per_period, 1126, "rounded up, so it fills the room");
  });

  it("a limit naming a gone account or set to $0 is left out; no account type is assumed (an account without a limit is never listed)", () => {
    const r = a.contributionRoom({ ...CONTRIB(), limits: { "investment:99": 5000, "investment:3": 0 } }, TODAY, {});
    assert.deepEqual(r.accounts, []);
    assert.equal(a.contributionRoom({ limits: {}, accounts: CONTRIB().accounts, flows: CONTRIB().flows }, TODAY, {}).accounts.length, 0);
  });

  it("reached; a Plaid account whose flows haven't synced says so; per month without a paycheck", () => {
    const src = { limits: { "investment:3": 2000, "investment:4": 6000 }, accounts: CONTRIB().accounts, flows: CONTRIB().flows };
    const r = a.contributionRoom(src, TODAY, { unit: "month", ppy: 12 });
    const roth = r.accounts.find((x) => x.name === "Roth IRA");
    assert.equal(roth.room, 0);
    assert.equal(roth.reached, true);
    assert.match(roth.text, /^Roth IRA: \$2,500\.00 of your \$2,000\.00 limit for 2026 contributed — the limit is reached\./);
    const brk = r.accounts.find((x) => x.name === "Brokerage");
    assert.equal(brk.contributions_unknown, true);
    assert.equal(brk.per_period, 2550);
    assert.match(brk.text, /\$2,550\.00 per month would fill it by Dec 31\. Its contributions haven't synced from Plaid yet, so this may be low\.$/);
  });

  it("in the plan: points the investing step here; null when the read failed", () => {
    const debtStep = plan();
    assert.equal(debtStep.headline.step, "high_interest_debt");
    assert.doesNotMatch(debtStep.contribution_room.accounts[0].text, /Your plan's investing/);
    const invest = plan({ debts: [], activity: [] });
    assert.equal(invest.headline.step, "invest");
    assert.match(invest.contribution_room.accounts[0].text, /Your plan's investing could go here first\./);
    assert.equal(plan({ contributions: null }).contribution_room, null);
    assert.equal(plan({ contributions: null }).ok, true);
  });
});

// ---------------------------------------------------------------------------
describe("T4.1 A10 — what-if", () => {
  it("an extra payment raises that debt's minimum on the same engine; the surplus falls by it", () => {
    const applied = a.applyWhatIf(inputs(), { extra_payment: { debt: "visa", amount_monthly: 300 } });
    assert.equal(applied.ok, true);
    assert.equal(applied.inputs.debts.find((d) => d.id === 1).what_if_extra_monthly, 300);
    assert.equal(applied.inputs.debts.find((d) => d.id === 2).what_if_extra_monthly, undefined);
    const after = a.buildAdvicePlan(applied.inputs);
    assert.equal(after.debts.find((d) => d.name === "Visa").minimum, 400);
    assert.equal(after.surplus.required_minimums_monthly, plan().surplus.required_minimums_monthly + 300);
    assert.deepEqual(after.what_if, applied.changes);
    assert.equal(plan().what_if, null);
  });

  it("the comparison: the step, the amount per paycheck and each debt whose payment or payoff moved", () => {
    const w = a.whatIfPlan(inputs(), { extra_payment: { debt: "Car Loan", amount_monthly: 200 } });
    assert.equal(w.ok, true);
    assert.equal(w.disclaimer, a.DISCLAIMER);
    assert.deepEqual(w.changes, [{ kind: "extra_payment", debt: "Car Loan", amount_monthly: 200, text: "$200.00 a month more on Car Loan" }]);
    assert.deepEqual([w.before.step, w.after.step], ["high_interest_debt", "high_interest_debt"]);
    assert.deepEqual([w.before.amount_per_period, w.after.amount_per_period], [750, 700]);
    const car = w.debts.find((d) => d.name === "Car Loan");
    assert.deepEqual(car.payment_monthly, { before: 350, after: 550 });
    assert.ok(car.payoff_month.after < car.payoff_month.before);
    assert.ok(car.interest_change < 0);
    const base = a.buildAdvicePlan(inputs());
    const baseCar = base.allocation.debts.find((d) => d.name === "Car Loan");
    assert.equal(car.payoff_month.before, baseCar.payoff_month);
    assert.equal(car.interest.before, baseCar.interest);
    assert.equal(w.text, "If $200.00 a month more on Car Loan: your plan's step stays \"pay off high-interest debt (APR 8% or more)\"; its amount goes from $750.00 to $700.00 per paycheck; Visa's payment goes from $1,725.00 to $1,616.67 a month, costing about $6.82 in interest; Car Loan's payment goes from $350.00 to $550.00 a month, paid off in Oct 2028 instead of Jan 2030, saving about $505.50 in interest.");
    assert.equal(w.plan.ok, true);
    assert.equal(w.plan.headline.amount_per_period, 700);
  });

  it("spending or income a month: every month the surplus reads moves, the targets with it", () => {
    const applied = a.applyWhatIf(inputs(), { spending_change_monthly: 150, income_change_monthly: "-50" });
    assert.deepEqual(applied.inputs.months.map((m) => [m.income, m.spending]), MONTHS.map(() => [5950, 2950]));
    assert.deepEqual(applied.changes.map((c) => c.text), ["income down $50.00 a month", "spending up $150.00 a month"]);
    const after = a.buildAdvicePlan(applied.inputs);
    assert.equal(after.cash.avg_monthly_spending, 2950);
    assert.equal(after.cash.emergency_target, 8850);
    assert.equal(after.surplus.median_net, 3000);
    // the lowest projected day moves by the change a month until it (30 days → one month)
    assert.equal(applied.inputs.cash.lowest.balance, 14000 - 200);
    assert.equal(inputs().cash.lowest.balance, 14000, "the inputs aren't changed in place");
  });

  it("a step change is named; the emergency fund's month when it moves", () => {
    const noDebt = inputs({ debts: [], activity: [], cash: { starting_balance: 6000, lowest: { date: "2026-11-27", balance: 5500 } } });
    const w = a.whatIfPlan(noDebt, { spending_change_monthly: 3000 });
    assert.equal(w.before.step, "emergency_fund");
    assert.equal(w.after.step, "starter_buffer");
    assert.match(w.text, /your plan's step moves from "build an emergency fund of 3 months of spending" to "keep a starter cash buffer"/);
    const w2 = a.whatIfPlan(noDebt, { income_change_monthly: 1000 });
    assert.ok(w2.after.emergency_month < w2.before.emergency_month);
    assert.match(w2.text, /the emergency fund is reached around \w{3} \d{4} instead of \w{3} \d{4}\.$/);
  });

  it("matching the debt: exact name or mask first, else one partial match", () => {
    assert.equal(a.applyWhatIf(inputs(), { extra_payment: { debt: "4242", amount_monthly: 50 } }).changes[0].debt, "Visa");
    assert.equal(a.applyWhatIf(inputs(), { extra_payment: { debt: " CAR ", amount_monthly: 50 } }).changes[0].debt, "Car Loan");
    const two = inputs({ debts: [...DEBTS(), { id: 3, account_id: "v2", name: "Visa Signature", type: "credit", current_balance: "900", apr: "19", minimum_payment: "35", last_payment_amount: "35" }],
      activity: [{ account_id: "v", txns: 5, interest: true }, { account_id: "v2", txns: 3, interest: true }] });
    assert.equal(a.applyWhatIf(two, { extra_payment: { debt: "visa", amount_monthly: 50 } }).changes[0].debt, "Visa", "the exact name wins");
    assert.match(a.applyWhatIf(two, { extra_payment: { debt: "vis", amount_monthly: 50 } }).error, /^"vis" matches more than one debt \(Visa, Visa Signature\) — name one\.$/);
  });

  it("refusals: an unknown or paid-in-full debt, a loan without a payment, bad amounts, nothing asked", () => {
    const err = (o, i = inputs()) => a.applyWhatIf(i, o).error;
    assert.equal(err({ extra_payment: { debt: "Amex", amount_monthly: 300 } }), "\"Amex\" isn't one of your carried debts: Visa, Car Loan.");
    const paid = inputs({ activity: [{ account_id: "v", txns: 5, interest: false }], debts: [{ ...DEBTS()[0], last_payment_amount: "900" }, DEBTS()[1]] });
    assert.equal(err({ extra_payment: { debt: "Visa", amount_monthly: 300 } }, paid), "\"Visa\" isn't one of your carried debts: Car Loan.");
    const noPay = inputs({ debts: [DEBTS()[0], { ...DEBTS()[1], monthly_payment: null }] });
    assert.equal(err({ extra_payment: { debt: "Car Loan", amount_monthly: 100 } }, noPay), "Car Loan has no monthly payment on file — set it on the loan card first.");
    assert.equal(err({ extra_payment: { debt: "", amount_monthly: 100 } }), "extra_payment.debt must name one of your carried debts: Visa, Car Loan.");
    for (const amt of [0, -5, "abc", 100001, null, NaN]) assert.match(err({ extra_payment: { debt: "Visa", amount_monthly: amt } }), /^extra_payment\.amount_monthly must be a number above 0 up to \$100,000\.00 a month\.$/);
    for (const v of ["12abc", 100001, -100001, Infinity, true]) assert.match(err({ spending_change_monthly: v }), /^spending_change_monthly must be a number up to/);
    assert.equal(err({ extra_payment: "Visa" }), "extra_payment must be { debt, amount_monthly }.");
    assert.equal(err({}), "Say what changes: extra_payment, income_change_monthly or spending_change_monthly.");
    assert.equal(err({ spending_change_monthly: 0 }), "Say what changes: extra_payment, income_change_monthly or spending_change_monthly.");
    assert.equal(err([]), "The what-if changes must be an object.");
    const w = a.whatIfPlan(inputs(), { extra_payment: { debt: "Amex", amount_monthly: 1 } });
    assert.deepEqual(w, { ok: false, error: "\"Amex\" isn't one of your carried debts: Visa, Car Loan.", disclaimer: a.DISCLAIMER });
    assert.equal(a.whatIfPlan(inputs({ debts: null }), { spending_change_monthly: 1 }).ok, false);
  });
});

// ---------------------------------------------------------------------------
describe("T4.1 A10 — the reader, Settings and the surfaces", () => {
  it("the reader: the limits, the GET /api/investments accounts, this calendar year's contributions", async () => {
    const seen = [];
    const pool = { query: async (sql, params) => {
      seen.push({ sql: sql.replace(/\s+/g, " "), params });
      if (/contribution_limits/.test(sql)) return { rows: [{ contribution_limits: { "investment:3": "7000", bad: 1 } }] };
      if (/UNION ALL/.test(sql)) return { rows: [{ source: "investment", id: 3, name: "Roth IRA", flows_synced_at: "2026-10-01", plaid: true }, { source: "linked", id: 9, name: "401k", flows_synced_at: null, plaid: false }] };
      if (/FROM investment_flows/.test(sql)) return { rows: [{ source: "investment", source_id: 3, contributed: "2500.00", flows: 5 }] };
      return { rows: [] };
    } };
    const deps = Object.fromEntries(Object.keys(a.SOURCE_ERRORS).filter((k) => k !== "contributions").map((k) => [k, async () => (k === "cash" ? { starting_balance: 0 } : [])]));
    const out = await a.getAdviceInputs(pool, { today: TODAY, deps });
    assert.deepEqual(out.errors, []);
    assert.deepEqual(out.contributions, {
      limits: { "investment:3": 7000 },
      accounts: [{ key: "investment:3", name: "Roth IRA", plaid: true, flows_synced: true }, { key: "linked:9", name: "401k", plaid: false, flows_synced: false }],
      flows: [{ key: "investment:3", contributed: 2500, count: 5 }],
    });
    const accts = seen.find((q) => /UNION ALL/.test(q.sql)).sql;
    assert.match(accts, /FROM linked_accounts la WHERE \( la\.type = 'investment'.*\) AND la\.plaid_item_id IS NULL/);
    assert.match(accts, /FROM investment_accounts ia WHERE ia\.is_active = true/);
    const flows = seen.find((q) => /FROM investment_flows/.test(q.sql));
    assert.deepEqual(flows.params, ["2026-01-01", TODAY]);
    assert.match(flows.sql, /WHERE flow_type = 'contribution' AND flow_date >= \$1::date AND flow_date <= \$2::date GROUP BY source, source_id/);
  });

  it("a failing read is null with its sentence; the plan still worked out", async () => {
    const pool = { query: async () => { throw new Error("relation does not exist"); } };
    const deps = Object.fromEntries(Object.keys(a.SOURCE_ERRORS).filter((k) => k !== "contributions").map((k) => [k, async () => inputs()[k]]));
    const quiet = console.error; console.error = () => {};
    let out;
    try { out = await a.getAdviceInputs(pool, { today: TODAY, deps }); } finally { console.error = quiet; }
    assert.equal(out.contributions, null);
    assert.deepEqual(out.errors, [{ source: "contributions", error: "Your investment contributions couldn't be read." }]);
    const p = a.buildAdvicePlan(out);
    assert.equal(p.ok, true);
    assert.equal(p.contribution_room, null);
  });

  const app = () => { const x = express(); x.use(express.json()); x.use(require("../teller/routes/settings")); return x; };

  it("PATCH contribution_limits: replaces the map, cents-rounded; 400 on a bad shape, key or value with nothing written", async () => {
    const writes = [];
    dbModule.pool.query = async (s, params) => { if (/^UPDATE user_settings SET/.test(s)) writes.push({ s, params }); return { rows: [{}] }; };
    await supertest(app()).patch("/api/settings").send({ contribution_limits: { "investment:3": 7000.456, "linked:9": "23000" } }).expect(200);
    assert.match(writes[0].s, /contribution_limits = \$1/);
    assert.deepEqual(JSON.parse(writes[0].params[0]), { "investment:3": 7000.46, "linked:9": 23000 });
    await supertest(app()).patch("/api/settings").send({ contribution_limits: null }).expect(200);
    assert.equal(writes[1].params[0], "{}");
    const before = writes.length;
    for (const bad of [[1], "x", 5, { "brokerage:1": 5 }, { "investment:0": 5 }, { "investment:3": -1 }, { "investment:3": 1000001 }, { "investment:3": "" }, { "investment:3": "7k" }, { "investment:3": true }]) {
      await supertest(app()).patch("/api/settings").send({ contribution_limits: bad }).expect(400);
    }
    assert.equal(writes.length, before);
  });

  it("GET defaults it to {}; the migration adds the column", async () => {
    dbModule.pool.query = async () => ({ rows: [{ theme: "dark" }] });
    assert.deepEqual((await supertest(app()).get("/api/settings").expect(200)).body.contribution_limits, {});
    assert.match(read("teller/services/database.js"), /ADD COLUMN IF NOT EXISTS contribution_limits JSONB NOT NULL DEFAULT '\{\}'::jsonb/);
    assert.match(read("teller/routes/settings.js"), /target_allocation_pct, contribution_limits, partner_name/);
  });

  it("the Settings editor: one labelled box per investment account, blank = no limit, a bad value refused", () => {
    const src = read("teller/views/settings.ejs");
    assert.match(src, /<div class="setting-row" id="contrib-limits"/);
    assert.ok(src.indexOf('id="contrib-limits"') > src.indexOf('id="target-allocation-section"') && src.indexOf('id="contrib-limits"') < src.indexOf('id="watchlist-section"'), "inside Target Allocation (no new section)");
    const i = src.indexOf("    function contribKey"), j = src.indexOf("    async function loadContribAccounts");
    const ctx = { esc: (s) => String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"), Number, String, Math };
    vm.runInNewContext(src.slice(i, j), ctx);
    const html = ctx.renderContribLimits([{ source: "teller", id: 9, name: "Work <401k>" }, { source: "plaid", id: 3, name: "Roth IRA" }, { source: "manual", id: 4, name: "HSA" }], { "investment:3": 7000 });
    assert.match(html, /data-contrib-key="linked:9" aria-label="Yearly contribution limit for Work &lt;401k&gt;"/);
    assert.match(html, /value="7000" placeholder="no limit" data-contrib-key="investment:3"/);
    assert.match(html, /value="" placeholder="no limit" data-contrib-key="investment:4"/);
    assert.match(ctx.renderContribLimits(null, {}), /couldn't be loaded/);
    assert.match(ctx.renderContribLimits([], {}), /No investment accounts yet/);
    const box = (key, value) => ({ value, getAttribute: () => key });
    const rows = (list) => ({ querySelectorAll: () => list });
    assert.deepEqual(JSON.parse(JSON.stringify(ctx.readContribLimits(rows([box("investment:3", "6500.555"), box("linked:9", " "), box("investment:4", "0")])))), { limits: { "investment:3": 6500.56, "investment:4": 0 }, bad: null });
    const bad = box("investment:3", "-1");
    assert.equal(ctx.readContribLimits(rows([box("linked:9", "100"), bad])).bad, bad);
    assert.match(src, /body: JSON\.stringify\(\{ contribution_limits: read\.limits \}\)[\s\S]{0,80}if \(await writeOk\(res, 'Saving contribution limits'\)\)/);
    assert.match(src, /CONTRIB_LIMITS = cl \|\| \{\};\n        loadContribAccounts\(\);/);
  });

  it("the card lists the room, escaped", () => {
    const dash = read("teller/views/dashboard.ejs");
    const i = dash.indexOf("    var ADVICE_DISCLAIMER"), j = dash.indexOf("    // Design D3: the Summary card + Needs attention");
    const ctx = {
      esc: (s) => String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"),
      fmt: (n) => "$" + Number(n).toFixed(2), emptyState: () => "EMPTY", Number, String, Date, JSON,
    };
    vm.runInNewContext(dash.slice(i, j), ctx);
    const c = CONTRIB();
    c.accounts[0].name = "Roth <IRA>";
    const html = ctx.renderAdvice(plan({ contributions: c }));
    assert.match(html, /<li>Roth &lt;IRA&gt;: \$2,500\.00 of your \$7,000\.00 limit for 2026 contributed/);
    assert.match(html, /<li>Work 401k: \$0\.00 of your \$23,000\.00 limit/);
    assert.doesNotMatch(ctx.renderAdvice(plan({ contributions: null })), /limit for 2026/);
  });

  it("the insight prompt block carries the room", () => {
    const block = require("../teller/routes/insights").cashPlanPromptBlock(plan());
    assert.match(block, /\nContribution room \(yearly limits the user entered\):\n- Work 401k: \$0\.00 of your \$23,000\.00 limit.*\n- Roth IRA: /);
    assert.doesNotMatch(require("../teller/routes/insights").cashPlanPromptBlock(plan({ contributions: null })), /Contribution room/);
  });

  it("Ask: the plan with its room; with overrides, the same engine on the changed inputs and the comparison", async () => {
    const realPlan = a.getAdvicePlan, realInputs = a.getAdviceInputs;
    const p = plan();
    let inputReads = 0;
    a.getAdvicePlan = async () => p;
    a.getAdviceInputs = async () => { inputReads++; return inputs(); };
    try {
      const ask = require("../teller/routes/ask");
      const exec = (ask._TOOL_EXECUTORS || ask.TOOL_EXECUTORS).get_cash_plan;
      const plain = await exec({});
      assert.deepEqual(plain.contribution_room, p.contribution_room);
      assert.equal(plain.what_if, undefined);
      assert.equal(inputReads, 0);
      const out = await exec({ extra_payment: { debt: "Car Loan", amount_monthly: 200 } });
      const w = a.whatIfPlan(inputs(), { extra_payment: { debt: "Car Loan", amount_monthly: 200 } });
      assert.deepEqual(out.what_if, { changes: w.changes, before: w.before, after: w.after, debts: w.debts, text: w.text });
      assert.equal(out.headline.amount_per_period, 700);
      assert.equal(out.disclaimer, a.DISCLAIMER);
      const refused = await exec({ spending_change_monthly: "lots" });
      assert.deepEqual(refused, { ok: false, error: "spending_change_monthly must be a number up to $100,000.00 a month.", disclaimer: a.DISCLAIMER });
    } finally { a.getAdvicePlan = realPlan; a.getAdviceInputs = realInputs; }
  });

  it("Ask's tool takes the three overrides, and the prompt sends what-if questions to it", () => {
    const src = read("teller/routes/ask.js");
    const tool = src.slice(src.indexOf('{ name: "get_cash_plan"'), src.indexOf("} } },", src.indexOf('{ name: "get_cash_plan"')));
    assert.match(tool, /extra_payment: \{ type: "object".*required: \["debt", "amount_monthly"\]/);
    assert.match(tool, /income_change_monthly: \{ type: "number"/);
    assert.match(tool, /spending_change_monthly: \{ type: "number"/);
    assert.match(tool, /the room left under each yearly contribution limit/);
    assert.match(src, /"For \\"what if\\" questions about paying more on a debt or income \/ spending changing, call " \+\n\s+"get_cash_plan with that change and give its what_if comparison\. "/);
  });
});
