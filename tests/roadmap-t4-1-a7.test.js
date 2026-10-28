// Roadmap T4.1 A7 — idle cash and rebalancing directions (services/advice.js,
// services/allocation.js): assetAllocation / normalizeTargets (shares, drift,
// a targeted class with no holdings) and GET /api/investments/performance
// reading them unchanged; checkingLow (the lowest summed checking balance over
// 60 days with each account's last snapshot carried forward, not enough
// history → null, today's balance); idleDestinations (a savings account, a
// brokerage that isn't tax-advantaged); rebalanceMoves (drift over 5 points,
// paired largest to largest, rounded to $100, classes only); idle cash in the
// plan (the plan's order — Visa first on the debt step, the emergency fund to
// savings, investing only to a brokerage — under $500 or nowhere to move it →
// none, the floor cap on money leaving cash, a failing read null with its
// sentence); the readers' SQL; the card, the prompt block and Ask.
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
const al = require("../teller/services/allocation");

const TODAY = "2026-10-28"; // the window starts 2026-08-29
const MONTHS = ["2026-06", "2026-07", "2026-08", "2026-09", "2026-10"].map((m) => ({ month: m, income: 6000, spending: 2800 }));
const VISA = { id: 1, account_id: "c1", name: "Visa", type: "credit", current_balance: "3000", apr: "24.99", minimum_payment: "90" };
const CHK = (over = {}) => ({ id: 10, name: "Checking", type: "depository", subtype: "checking", current_balance: 12000, is_investment: false, ...over });
const SAV = { id: 11, name: "High-Yield Savings", type: "depository", subtype: "savings", current_balance: 0, is_investment: false };
const snaps = (id, list) => list.map(([date, balance]) => ({ id, date, balance }));
const NO_ALLOC = { total_value: 0, has_targets: false, classes: [] };

function inputs(over = {}) {
  return {
    today: TODAY, errors: [],
    months: MONTHS, streams: [],
    cash: { starting_balance: 15000, lowest: { date: "2026-11-20", balance: 14000 } },
    settings: { cash_alert_threshold: "500" },
    debts: [VISA], activity: [{ account_id: "c1", txns: 3, interest: true }],
    transfers: [], goals: [], deposits: [], categories: [],
    idle: { accounts: [CHK(), SAV], investments: [], snapshots: snaps(10, [["2026-08-20", 9000], ["2026-09-15", 7000], ["2026-10-20", 12000]]) },
    allocation: NO_ALLOC,
    subscriptions: { subs: [], bills: [], activity: [] },
    ...over,
  };
}
const plan = (over) => a.buildAdvicePlan(inputs(over));

// ---------------------------------------------------------------------------
describe("T4.1 A7 — the shared allocation", () => {
  const rows = [
    { current_value: "11000", cost_basis: "9000", security_type: "Equity" },
    { current_value: "9000", cost_basis: null, security_type: "bond" },
  ];

  it("normalizeTargets: lowercased keys, numbers, a JSON string, junk dropped", () => {
    assert.deepEqual(al.normalizeTargets({ Equity: "70", bond: 30, x: "abc" }), { equity: 70, bond: 30 });
    assert.deepEqual(al.normalizeTargets('{"cash": 5}'), { cash: 5 });
    assert.deepEqual(al.normalizeTargets("{oops"), {});
    assert.deepEqual(al.normalizeTargets(null), {});
  });

  it("assetAllocation: shares, drift, the known-basis value, a targeted class with none at 0%", () => {
    const r = al.assetAllocation(rows, { equity: 70, bond: 25, cash: 5 });
    assert.equal(r.total_value, 20000);
    assert.equal(r.has_targets, true);
    const r6 = (n) => (n == null ? n : Math.round(n * 1e6) / 1e6);
    assert.deepEqual(r.classes.map((c) => [c.security_type, r6(c.pct_of_portfolio), r6(c.drift_pct)]), [["equity", 55, -15], ["bond", 45, 20], ["cash", 0, -5]]);
    assert.equal(r.classes[1].value_with_basis, 0, "an unknown basis isn't a known-basis value (BSI-5)");
    assert.equal(al.assetAllocation(rows, {}).classes[0].drift_pct, undefined);
  });

  describe("GET /api/investments/performance reads it", () => {
    const db = require("../teller/services/database");
    const orig = db.pool.query;
    afterEach(() => { db.pool.query = orig; });
    it("the card's drift is the helper's", async () => {
      db.pool.query = async (sql) => {
        if (sql.includes("target_allocation_pct")) return { rows: [{ target_allocation_pct: { equity: 70, bond: 25, cash: 5 } }] };
        return { rows };
      };
      delete require.cache[require.resolve("../teller/routes/investments")];
      const app = express(); app.use(express.json()); app.use(require("../teller/routes/investments"));
      const res = await supertest(app).get("/api/investments/performance").expect(200);
      const helper = al.assetAllocation(rows, al.normalizeTargets({ equity: 70, bond: 25, cash: 5 })).classes;
      assert.deepEqual(res.body.by_asset_class.map((c) => [c.security_type, c.pct_of_portfolio, c.target_pct, c.drift_pct]),
        helper.map((c) => [c.security_type, c.pct_of_portfolio, c.target_pct, c.drift_pct]));
      assert.deepEqual(res.body.by_asset_class.map((c) => [c.return, c.return_pct]), [[2000, 2000 / 9000 * 100], [0, null], [0, null]]);
      assert.match(read("teller/routes/investments.js"), /assetAllocation\(holdings\.rows, targetMap\)/);
    });
  });
});

describe("T4.1 A7 — checkingLow / idleDestinations", () => {
  it("the lowest summed balance in the window, each account carried forward", () => {
    assert.equal(a.checkingLow(inputs().idle, TODAY), 7000);
    const two = {
      accounts: [CHK({ current_balance: null }), CHK({ id: 12, name: "Joint checking", current_balance: null })],
      snapshots: [...snaps(10, [["2026-08-01", 5000], ["2026-09-10", 3000]]), ...snaps(12, [["2026-08-25", 2000], ["2026-10-01", 4500]])],
    };
    assert.equal(a.checkingLow(two, TODAY), 5000, "3000 + 2000 from Sep 10 until Oct 1");
  });

  it("no balance known at the window's start → null; no checking → null", () => {
    assert.equal(a.checkingLow({ accounts: [CHK()], snapshots: snaps(10, [["2026-09-01", 9000]]) }, TODAY), null);
    assert.equal(a.checkingLow({ accounts: [CHK(), CHK({ id: 12 })], snapshots: snaps(10, [["2026-08-01", 9000]]) }, TODAY), null);
    assert.equal(a.checkingLow({ accounts: [SAV], snapshots: [] }, TODAY), null);
  });

  it("today's balance counts when it is lower; savings and investments don't", () => {
    assert.equal(a.checkingLow({ accounts: [CHK({ current_balance: 4000 }), SAV], snapshots: snaps(10, [["2026-08-01", 9000]]) }, TODAY), 4000);
  });

  it("destinations: a savings account and a brokerage that isn't tax-advantaged", () => {
    const ira = { id: 20, name: "IRA", type: "investment", subtype: "ira", is_investment: true };
    const brk = { id: 21, name: "Brokerage", type: "investment", subtype: "brokerage", is_investment: true };
    assert.deepEqual(a.idleDestinations({ accounts: [CHK(), SAV, ira], investments: [] }), { savings: SAV, brokerage: null });
    assert.equal(a.idleDestinations({ accounts: [CHK(), ira, brk], investments: [] }).brokerage, brk);
    const d = a.idleDestinations({ accounts: [CHK()], investments: [{ id: 3, name: "401(k)", account_type: "401k" }, { id: 4, name: "Taxable", account_type: "brokerage" }] });
    assert.deepEqual(d, { savings: null, brokerage: { id: 4, name: "Taxable", account_type: "brokerage" } });
    assert.equal(a.idleDestinations({ accounts: [CHK({ subtype: "money market" })], investments: [] }).savings.name, "Checking");
  });
});

describe("T4.1 A7 — rebalanceMoves", () => {
  const alloc = (rows, targets) => al.assetAllocation(rows, targets);

  it("a 20-point overweight moved to the underweight class, rounded to $100", () => {
    const r = a.rebalanceMoves(alloc([{ current_value: 11000, security_type: "equity" }, { current_value: 9000, security_type: "bond" }], { equity: 70, bond: 30 }));
    assert.deepEqual(r.moves, [{ from: "bond", to: "equity", amount: 3000, text: "Move about $3,000.00 from bond (45% now, target 30%) to equity (55% now, target 70%)." }]);
    assert.deepEqual(r.drifting.map((c) => [c.security_type, c.drift_pct]), [["equity", -15], ["bond", 15]]);
    assert.equal(r.note, a.REBALANCE_NOTE);
  });

  it("within 5 points: no moves; no targets or holdings: null", () => {
    const r = a.rebalanceMoves(alloc([{ current_value: 6600, security_type: "equity" }, { current_value: 3400, security_type: "bond" }], { equity: 70, bond: 30 }));
    assert.deepEqual(r.moves, []);
    assert.equal(r.note, null);
    assert.equal(a.rebalanceMoves(alloc([{ current_value: 100, security_type: "equity" }], {})), null);
    assert.equal(a.rebalanceMoves(alloc([], { equity: 100 })), null);
  });

  it("pairs largest to largest across classes; never names a holding", () => {
    const r = a.rebalanceMoves(alloc([
      { current_value: 5000, security_type: "bond", ticker: "BND", name: "Bond fund" },
      { current_value: 3000, security_type: "cash" },
      { current_value: 2000, security_type: "equity", ticker: "VTI" },
    ], { equity: 60, bond: 30, cash: 10 }));
    assert.deepEqual(r.moves.map((m) => [m.from, m.to, m.amount]), [["bond", "equity", 2000], ["cash", "equity", 2000]]);
    assert.doesNotMatch(JSON.stringify(r), /BND|VTI|Bond fund/);
  });
});

// ---------------------------------------------------------------------------
describe("T4.1 A7 — idle cash in the plan", () => {
  it("on the high-interest step it pays the card first (the plan's order)", () => {
    // Low $7,000 − keep $3,300 ($500 floor + $2,800 a month) = $3,700; no brokerage, so nothing to invest.
    const p = plan();
    assert.equal(p.headline.step, "high_interest_debt");
    assert.deepEqual(p.idle_cash, {
      checking_low: 7000, keep: 3300, amount: 3000, days: 60,
      moves: [{ key: "debt", to: "Visa", amount: 3000 }],
      text: "Your checking hasn't dropped below $7,000.00 in 60 days — more than the $3,300.00 your plan keeps there (your floor plus a month of spending). Move $3,000.00: $3,000.00 to Visa.",
    });
  });

  it("toward the emergency fund it moves to savings", () => {
    const p = plan({ debts: [], activity: [], cash: { starting_balance: 6000, lowest: null },
      idle: { accounts: [CHK({ current_balance: 6000 }), SAV], investments: [], snapshots: snaps(10, [["2026-08-01", 6000]]) } });
    assert.equal(p.headline.step, "emergency_fund");
    assert.deepEqual(p.idle_cash.moves, [{ key: "emergency", to: "High-Yield Savings (emergency fund)", amount: 2700 }]);
  });

  it("past the emergency fund: the gap to savings, the rest to the brokerage — capped by the projected low", () => {
    const idle = { accounts: [CHK({ current_balance: 15000 }), SAV], investments: [{ id: 4, name: "Brokerage", account_type: "brokerage" }], snapshots: snaps(10, [["2026-08-01", 12000]]) };
    const p = plan({ debts: [], activity: [], idle, cash: { starting_balance: 15000, lowest: { date: "2026-11-20", balance: 14000 } } });
    assert.equal(p.headline.step, "invest");
    assert.deepEqual(p.idle_cash.moves, [
      { key: "emergency", to: "High-Yield Savings (emergency fund)", amount: 2100 },
      { key: "invest", to: "Brokerage (investing)", amount: 6600 },
    ]);
    const capped = plan({ debts: [], activity: [], idle, cash: { starting_balance: 15000, lowest: { date: "2026-11-20", balance: 3050 } } });
    assert.deepEqual(capped.idle_cash.moves.map((m) => m.amount), [2100, 2500], "$3,050 − the $500 floor, rounded down");
  });

  it("nothing to show: under $500, nowhere to move it, not enough history, a failing read", async () => {
    assert.equal(plan({ idle: { accounts: [CHK(), SAV], investments: [], snapshots: snaps(10, [["2026-08-01", 3700]]) } }).idle_cash, null);
    assert.equal(plan({ debts: [], activity: [], idle: { accounts: [CHK()], investments: [], snapshots: snaps(10, [["2026-08-01", 12000]]) } }).idle_cash, null, "no savings or brokerage");
    assert.equal(plan({ idle: { accounts: [CHK()], investments: [], snapshots: snaps(10, [["2026-08-01", 12000]]) } }).idle_cash, null, "a card to pay but no savings or brokerage");
    // Toward the emergency fund with only a brokerage: the money stays in checking.
    assert.equal(plan({ debts: [], activity: [], cash: { starting_balance: 6000, lowest: null },
      idle: { accounts: [CHK({ current_balance: 6000 })], investments: [{ id: 4, name: "Brokerage", account_type: "brokerage" }], snapshots: snaps(10, [["2026-08-01", 6000]]) } }).idle_cash, null);
    assert.equal(plan({ idle: { accounts: [CHK(), SAV], investments: [], snapshots: snaps(10, [["2026-09-01", 9000]]) } }).idle_cash, null);
    const quietly = async (fn) => { const e = console.error; console.error = () => {}; try { return await fn(); } finally { console.error = e; } };
    const deps = Object.fromEntries(Object.entries(inputs()).filter(([k]) => a.SOURCE_ERRORS[k]).map(([k, v]) => [k, async () => v]));
    deps.idle = async () => { throw new Error("x"); };
    deps.allocation = async () => { throw new Error("y"); };
    const p = a.buildAdvicePlan(await quietly(() => a.getAdviceInputs({}, { today: TODAY, deps })));
    assert.equal(p.ok, true);
    assert.equal(p.idle_cash, null);
    assert.equal(p.rebalance, null);
    assert.deepEqual(p.errors, [
      { source: "allocation", error: "Your investment allocation couldn't be read." },
      { source: "idle", error: "Your account balance history couldn't be read." },
    ]);
  });

  it("the readers: no brokerage phantom, checking snapshots over 91 days, the shared holdings query", async () => {
    const seen = [];
    const pool = { query: async (sql, params) => { seen.push({ sql: sql.replace(/\s+/g, " "), params }); return { rows: [] }; } };
    await a.getAdviceInputs(pool, { today: TODAY, deps: { months: async () => [], streams: async () => [], cash: async () => ({ starting_balance: 0 }) } });
    const acc = seen.find((q) => /la\.type = 'depository' OR/.test(q.sql));
    assert.match(acc.sql, /NOT EXISTS \(SELECT 1 FROM investment_accounts ia WHERE ia\.plaid_account_id = la\.account_id AND ia\.is_active\)/);
    const sn = seen.find((q) => /account_balance_snapshots/.test(q.sql));
    assert.deepEqual(sn.params, [TODAY]);
    assert.match(sn.sql, /s\.source = 'linked' AND la\.type = 'depository' AND LOWER\(COALESCE\(la\.subtype, ''\)\) = 'checking'/);
    assert.match(sn.sql, /s\.snapshot_date >= \$1::date - 91 AND s\.snapshot_date <= \$1::date/);
    assert.ok(seen.some((q) => q.sql === al.HOLDINGS_SQL.replace(/\s+/g, " ")));
    assert.ok(seen.some((q) => /^SELECT id, name, account_type FROM investment_accounts WHERE is_active = true/.test(q.sql.trim())));
  });
});

// ---------------------------------------------------------------------------
describe("T4.1 A7 — the surfaces", () => {
  const full = () => plan({
    idle: { accounts: [CHK(), SAV], investments: [], snapshots: snaps(10, [["2026-08-20", 9000], ["2026-09-15", 7000]]) },
    allocation: al.assetAllocation([{ current_value: 11000, security_type: "equity <x>" }, { current_value: 9000, security_type: "bond" }], { "equity <x>": 70, bond: 30 }),
  });

  it("the card: the idle line, each move and the note, escaped", () => {
    const dash = read("teller/views/dashboard.ejs");
    const i = dash.indexOf("    var ADVICE_DISCLAIMER"), j = dash.indexOf("    // Design D3: the Summary card + Needs attention");
    const ctx = {
      esc: (s) => String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"),
      fmt: (n) => "$" + Number(n).toFixed(2), emptyState: () => "EMPTY", Number, String, Date, JSON,
    };
    vm.runInNewContext(dash.slice(i, j), ctx);
    const html = ctx.renderAdvice(full());
    assert.match(html, /<li>Your checking hasn't dropped below \$7,000\.00 in 60 days/);
    assert.match(html, /<li>Move about \$3,000\.00 from bond \(45% now, target 30%\) to equity &lt;x&gt; \(55% now, target 70%\)\.<\/li><li>Directions only/);
    assert.doesNotMatch(ctx.renderAdvice(plan()), /Directions only/);
  });

  it("the insight prompt block carries both, with the no-security instruction", () => {
    const block = require("../teller/routes/insights").cashPlanPromptBlock(full());
    assert.match(block, /\nIdle cash: Your checking hasn't dropped below \$7,000\.00 in 60 days.*\$3,000\.00 to Visa\.\n/);
    assert.match(block, /\nRebalancing \(directions between asset classes — never name a security or fund\):\n- Move about \$3,000\.00 from bond .*\n- Directions only/);
  });

  it("Ask's get_cash_plan carries them", async () => {
    const real = a.getAdvicePlan;
    const p = full();
    a.getAdvicePlan = async () => p;
    try {
      const ask = require("../teller/routes/ask");
      const out = await (ask._TOOL_EXECUTORS || ask.TOOL_EXECUTORS).get_cash_plan({});
      assert.deepEqual(out.idle_cash, p.idle_cash);
      assert.deepEqual(out.rebalance, p.rebalance);
    } finally { a.getAdvicePlan = real; }
  });
});
