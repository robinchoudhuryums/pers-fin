// Design pass D3 (Perfin dashboard, part 1: the summary) — `.cycle/plan-design-ux.md`,
// decision 5. GET /api/dashboard/summary (teller/routes/dashboard-summary.js) and
// the Summary card + Needs-attention list at the top of the dashboard.
// - gatherDashboardSummary over a fake pool with every reader injected as a spy:
//   every field, each failing reader isolated with its fixed sentence, the
//   attention items' rules and links, and no figure re-derived (INV-147);
// - the helpers the summary shares with their own screens: getBillsDue (the
//   forecast + the calendar's manual-bill rule, paid ones left out),
//   ledgerTotals / getHousingOwed, countUncategorized, gatherDataHealth;
// - the card and list renderers run in a vm from dashboard.ejs.
// The real-Postgres half is tests/contract/dashboard-summary.contract.test.js.
"use strict";

const { describe, it, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const express = require("express");
const supertest = require("supertest");

if (!process.env.NEON_DATABASE_URL) process.env.NEON_DATABASE_URL = "postgres://mock:mock@localhost/mock";
if (!process.env.TOKEN_ENCRYPTION_PASSPHRASE) process.env.TOKEN_ENCRYPTION_PASSPHRASE = "test-passphrase";

const ROOT = path.join(__dirname, "..");
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), "utf8");
function slice(src, start, end) {
  const i = src.indexOf(start);
  const j = src.indexOf(end, i + start.length);
  assert.ok(i >= 0 && j > i, "slice markers: " + start);
  return src.slice(i, j);
}

const dbModule = require("../teller/services/database");
const originalQuery = dbModule.pool.query;
afterEach(() => { dbModule.pool.query = originalQuery; });

const summary = require("../teller/routes/dashboard-summary");
const { gatherDashboardSummary, spendingFrom, ERRORS } = summary;

// A fake pool that answers only the two net-worth reads; anything else fails
// the test (the summary must not run its own SQL for the other figures).
function nwPool({ latest = null, first = null } = {}) {
  const calls = [];
  return {
    calls,
    async query(sql, params) {
      calls.push({ sql, params });
      if (/FROM net_worth_snapshots ORDER BY snapshot_date DESC/.test(sql)) return { rows: latest ? [latest] : [] };
      if (/FROM net_worth_snapshots WHERE snapshot_date >= \$1/.test(sql)) return { rows: first ? [first] : [] };
      throw new Error("unexpected query: " + sql);
    },
  };
}

function spy(impl) {
  const fn = async (...args) => { fn.calls.push(args); return impl(...args); };
  fn.calls = [];
  return fn;
}

function happyDeps(over = {}) {
  return Object.assign({
    getBudgetStatus: spy(() => [
      { category: "Food & Drink", spent: 412.5, effective_limit: 500 },
      { category: "Shopping", spent: 260.25, effective_limit: 200 },
    ]),
    getCashFlowForecast: spy(() => ({ starting_balance: 3200.4, lowest: { date: "2026-11-14", balance: 845.123 }, projection: [] })),
    getBillsDue: spy(() => [
      { name: "Netflix", amount: 15.49, date: "2026-10-28" },
      { name: "Water", amount: 60, date: "2026-10-30" },
    ]),
    getHousingOwed: spy(() => ({ configured: true, payee: "Sam Lee", balance: 1850, awaiting_count: 1, unpaid_count: 2 })),
    countUncategorized: spy(() => 7),
    gatherDataHealth: spy(() => ({ issues: [
      { severity: "warning", message: "a" }, { severity: "info", message: "b" }, { severity: "warning", message: "c" },
    ] })),
    todayStr: () => { throw new Error("today is passed in"); },
  }, over);
}

const quiet = async (fn) => {
  const orig = console.error;
  const logged = [];
  console.error = (...a) => logged.push(a.join(" "));
  try { return { result: await fn(), logged }; } finally { console.error = orig; }
};

describe("gatherDashboardSummary — every field from its shared helper", () => {
  it("net worth, spending, cash and the attention list", async () => {
    const db = nwPool({
      latest: { net_worth: "52000.456", snapshot_date: "2026-10-25" },
      first: { net_worth: "50000", snapshot_date: "2026-10-01" },
    });
    const deps = happyDeps();
    const persistentPool = { marker: true };
    const s = await gatherDashboardSummary(db, { deps, today: "2026-10-26", persistentPool });
    assert.equal(s.today, "2026-10-26");
    assert.equal(s.month, "2026-10");
    assert.deepEqual(s.net_worth, { ok: true, value: 52000.46, as_of: "2026-10-25", change: 2000.46, change_since: "2026-10-01" });
    assert.deepEqual(db.calls[1].params, ["2026-10-01"], "the month's first snapshot, APP_TIMEZONE month");
    assert.deepEqual(s.spending, { ok: true, month: "2026-10", budget_count: 2, spent: 672.75, budget: 700, percent: 96, over_count: 1 });
    assert.deepEqual(s.cash, { ok: true, days: 30, starting_balance: 3200.4, lowest_balance: 845.12, lowest_date: "2026-11-14" });

    // Each helper called once, with the pool and the summary's own day / month.
    assert.deepEqual(deps.getBudgetStatus.calls, [[db, "2026-10"]]);
    assert.deepEqual(deps.getCashFlowForecast.calls, [[db, { days: 30, today: "2026-10-26" }]]);
    assert.deepEqual(deps.getBillsDue.calls, [[db, { today: "2026-10-26", days: 7 }]]);
    assert.deepEqual(deps.getHousingOwed.calls, [[db]]);
    assert.deepEqual(deps.countUncategorized.calls, [[db]]);
    assert.deepEqual(deps.gatherDataHealth.calls, [[db, { persistentPool }]]);

    assert.deepEqual(s.attention, {
      items: [
        { kind: "rent", text: "Owed to Sam Lee", amount: 1850, count: 2, href: "/housing" },
        { kind: "bills", text: "2 bills due in the next 7 days", amount: 75.49, count: 2, href: "/calendar" },
        { kind: "uncategorized", text: "7 transactions to categorize", count: 7, href: "/dashboard#review-queue-section" },
        { kind: "sync_health", text: "2 Sync Health warnings", count: 2, href: "/settings#sync-health" },
      ],
      errors: [],
    });
  });

  it("the default today is todayStr() (APP_TIMEZONE)", async () => {
    const deps = happyDeps({ todayStr: () => "2026-03-31" });
    const s = await gatherDashboardSummary(nwPool(), { deps });
    assert.equal(s.today, "2026-03-31");
    assert.equal(s.month, "2026-03");
    assert.deepEqual(deps.getBudgetStatus.calls[0][1], "2026-03");
  });

  it("net worth: none yet, one snapshot this month only, and the first-of-month change", async () => {
    const none = await gatherDashboardSummary(nwPool(), { deps: happyDeps(), today: "2026-10-26" });
    assert.deepEqual(none.net_worth, { ok: true, value: null, as_of: null, change: null, change_since: null });

    const same = await gatherDashboardSummary(nwPool({
      latest: { net_worth: "100", snapshot_date: "2026-10-03" }, first: { net_worth: "100", snapshot_date: "2026-10-03" },
    }), { deps: happyDeps(), today: "2026-10-26" });
    assert.equal(same.net_worth.change, null, "no earlier snapshot this month — no change");
    assert.equal(same.net_worth.change_since, null);

    const older = await gatherDashboardSummary(nwPool({
      latest: { net_worth: "-1200.5", snapshot_date: "2026-09-20" }, first: null,
    }), { deps: happyDeps(), today: "2026-10-26" });
    assert.deepEqual(older.net_worth, { ok: true, value: -1200.5, as_of: "2026-09-20", change: null, change_since: null });

    const down = await gatherDashboardSummary(nwPool({
      latest: { net_worth: "900", snapshot_date: "2026-10-20" }, first: { net_worth: "1000.10", snapshot_date: "2026-10-01" },
    }), { deps: happyDeps(), today: "2026-10-26" });
    assert.equal(down.net_worth.change, -100.1);
  });

  it("each failing reader is isolated with its fixed sentence — never the error text", async () => {
    const secret = "relation \"x\" does not exist at Acme Bank 4421";
    const boom = () => { throw new Error(secret); };
    const cases = [
      ["spending", { getBudgetStatus: spy(boom) }],
      ["cash", { getCashFlowForecast: spy(boom) }],
      ["bills", { getBillsDue: spy(boom) }],
      ["rent", { getHousingOwed: spy(boom) }],
      ["uncategorized", { countUncategorized: spy(boom) }],
      ["sync_health", { gatherDataHealth: spy(boom) }],
    ];
    for (const [key, over] of cases) {
      const { result: s, logged } = await quiet(() => gatherDashboardSummary(
        nwPool({ latest: { net_worth: "10", snapshot_date: "2026-10-25" } }), { deps: happyDeps(over), today: "2026-10-26" }));
      assert.ok(!JSON.stringify(s).includes(secret), key + ": the error text never reaches the response");
      assert.equal(logged.length, 1, key + ": logged once");
      assert.match(logged[0], new RegExp("dashboard summary " + key + " failed"));
      if (["spending", "cash"].includes(key)) {
        assert.deepEqual(s[key], { ok: false, error: ERRORS[key] });
      } else {
        assert.deepEqual(s.attention.errors, [{ source: key, error: ERRORS[key] }]);
        assert.ok(!s.attention.items.some((i) => i.kind === (key === "sync_health" ? "sync_health" : key)), key + " item left out");
      }
      // Everything else still answered.
      assert.equal(s.net_worth.ok, true, key);
      if (key !== "spending") assert.equal(s.spending.ok, true, key);
      if (key !== "cash") assert.equal(s.cash.ok, true, key);
      assert.equal(s.attention.items.length, ["spending", "cash"].includes(key) ? 4 : 3, key + ": the other items stay");
    }
  });

  it("a synchronous throw and a failing net-worth read are contained too", async () => {
    const deps = happyDeps({ getBudgetStatus: () => { throw new Error("sync"); } });
    const failing = { query: async () => { throw new Error("db down"); } };
    const { result: s } = await quiet(() => gatherDashboardSummary(failing, { deps, today: "2026-10-26" }));
    assert.deepEqual(s.net_worth, { ok: false, error: ERRORS.net_worth });
    assert.deepEqual(s.spending, { ok: false, error: ERRORS.spending });
    assert.equal(s.cash.ok, true);
  });

  it("attention rules: rent only when configured and owed; sync health counts warnings only; nothing → empty", async () => {
    const quietDeps = happyDeps({
      getBillsDue: spy(() => []),
      getHousingOwed: spy(() => ({ configured: false })),
      countUncategorized: spy(() => 0),
      gatherDataHealth: spy(() => ({ issues: [{ severity: "info", message: "x" }] })),
    });
    const s = await gatherDashboardSummary(nwPool(), { deps: quietDeps, today: "2026-10-26" });
    assert.deepEqual(s.attention, { items: [], errors: [] });

    const settled = await gatherDashboardSummary(nwPool(), {
      deps: happyDeps({ getHousingOwed: spy(() => ({ configured: true, payee: "Sam", balance: 0, unpaid_count: 0 })) }),
      today: "2026-10-26",
    });
    assert.ok(!settled.attention.items.some((i) => i.kind === "rent"), "nothing owed → no rent item");

    const one = await gatherDashboardSummary(nwPool(), {
      deps: happyDeps({
        getBillsDue: spy(() => [{ name: "Gym", amount: 40, date: "2026-10-27" }]),
        countUncategorized: spy(() => 1),
        gatherDataHealth: spy(() => ({ issues: [{ severity: "warning" }] })),
      }),
      today: "2026-10-26",
    });
    const texts = one.attention.items.map((i) => i.text);
    assert.ok(texts.includes("1 bill due in the next 7 days"));
    assert.ok(texts.includes("1 transaction to categorize"));
    assert.ok(texts.includes("1 Sync Health warning"));
    for (const it of one.attention.items) assert.match(it.href, /^\/[a-z]/, "a same-app path the page joins with withBase");
  });

  it("spendingFrom: no budgets → percent null; over counts spent > limit", () => {
    assert.deepEqual(spendingFrom([], "2026-10"), { month: "2026-10", budget_count: 0, spent: 0, budget: 0, percent: null, over_count: 0 });
    assert.deepEqual(spendingFrom([{ spent: "100", effective_limit: "100" }, { spent: 0.1, effective_limit: 0 }], "2026-10"),
      { month: "2026-10", budget_count: 2, spent: 100.1, budget: 100, percent: 100, over_count: 1 });
  });

  it("no figure is re-derived: the only SQL in the module reads net_worth_snapshots", () => {
    const src = read("teller", "routes", "dashboard-summary.js");
    const sql = src.match(/(SELECT|INSERT|UPDATE|DELETE)\s[^"`]*/g) || [];
    assert.equal(sql.length, 2);
    for (const q of sql) assert.match(q, /FROM net_worth_snapshots/);
    assert.doesNotMatch(src, /FROM transactions|FROM budgets|SPLIT_AMOUNT|INCOME_PREDICATE|payee_obligations|detected_subscriptions|manual_bills/);
    for (const name of ["getBudgetStatus", "getCashFlowForecast", "getBillsDue", "getHousingOwed", "countUncategorized", "gatherDataHealth"]) {
      assert.match(src, new RegExp(name + ":"), name + " comes from defaultDeps");
    }
  });
});

describe("GET /api/dashboard/summary", () => {
  it("answers 200 with every part reported failed when the database is down", async () => {
    dbModule.pool.query = async () => { throw new Error("connection refused"); };
    const app = express();
    app.use(summary);
    const { result: res } = await quiet(() => supertest(app).get("/api/dashboard/summary"));
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.net_worth, { ok: false, error: ERRORS.net_worth });
    assert.deepEqual(res.body.spending, { ok: false, error: ERRORS.spending });
    assert.deepEqual(res.body.cash, { ok: false, error: ERRORS.cash });
    assert.deepEqual(res.body.attention.items, []);
    assert.deepEqual(res.body.attention.errors.map((e) => e.source).sort(), ["bills", "rent", "sync_health", "uncategorized"]);
    assert.ok(!JSON.stringify(res.body).includes("connection refused"));
  });

  it("is mounted in server.js and gathers through the shared function", () => {
    assert.match(read("teller", "server.js"), /app\.use\(require\("\.\/routes\/dashboard-summary"\)\)/);
    const src = read("teller", "routes", "dashboard-summary.js");
    assert.match(src, /router\.get\("\/api\/dashboard\/summary"[\s\S]{0,120}gatherDashboardSummary\(pool/);
  });
});

describe("the helpers the summary shares with their own screens", () => {
  it("getBillsDue: the forecast's charges + manual-bill occurrences, paid ones left out, date order", async () => {
    const { getBillsDue } = require("../teller/routes/subscriptions");
    const db = {
      async query(sql, params) {
        if (/FROM detected_subscriptions/.test(sql)) {
          return { rows: [
            { id: 4, display_name: "Netflix", amount: "15.49", cadence_days: 30, next_expected: "2026-10-30", last_charged: "2026-09-30", category: "Entertainment" },
            { id: 5, display_name: "Annual", amount: "99", cadence_days: 365, next_expected: "2027-03-01", last_charged: "2026-03-01", category: "Other" },
          ] };
        }
        if (/FROM manual_bills/.test(sql)) {
          return { rows: [
            { id: 9, name: "Water", amount: "60.00", due_day: 28, cadence: "monthly", created_at: "2026-01-05", category: "utility" },
            { id: 10, name: "Rent box", amount: "20", due_day: 27, cadence: "monthly", created_at: "2026-01-05", category: "other" },
            { id: 11, name: "Insurance", amount: "300", due_day: 1, cadence: "quarterly", created_at: "2026-02-01", category: "insurance" },
          ] };
        }
        if (/FROM bill_payments/.test(sql)) {
          assert.deepEqual(params, ["2026-10-26", "2026-11-02"]);
          return { rows: [{ bill_source: "manual", bill_id: 10, paid_date: "2026-10-27" }] };
        }
        throw new Error("unexpected " + sql);
      },
    };
    const bills = await getBillsDue(db, { today: "2026-10-26", days: 7 });
    assert.deepEqual(bills.map((b) => [b.bill_source, b.name, b.date, b.amount, b.days_away]), [
      ["manual", "Water", "2026-10-28", 60, 2],
      ["subscription", "Netflix", "2026-10-30", 15.49, 4],
      ["manual", "Insurance", "2026-11-01", 300, 6],
    ]);
  });

  it("/api/forecast still answers the same shape through forecastCharges", async () => {
    dbModule.pool.query = async (sql) => {
      if (/FROM detected_subscriptions/.test(sql)) {
        return { rows: [{ id: 4, display_name: "Netflix", amount: "15.49", cadence_days: 30, next_expected: "2099-01-31", last_charged: "2098-12-31", category: "Entertainment" }] };
      }
      return { rows: [] };
    };
    const app = express();
    app.use(require("../teller/routes/subscriptions"));
    const res = await supertest(app).get("/api/forecast?days=7");
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.body.charges));
    for (const f of res.body.charges) assert.deepEqual(Object.keys(f).sort(), ["amount", "category", "date", "days_away", "name"]);
    assert.match(read("teller", "routes", "subscriptions.js"), /router\.get\("\/api\/forecast"[\s\S]{0,300}forecastCharges\(pool, today, endStr\)/);
  });

  it("ledgerTotals / getHousingOwed: the ledger's own totals, payee-scoped, nothing when not set up", async () => {
    const { ledgerTotals, getHousingOwed } = require("../teller/routes/housing");
    assert.deepEqual(ledgerTotals([
      { status: "unpaid", amount: "1500.10" }, { status: "unpaid", amount: "120.21" },
      { status: "pending_amount", amount: null }, { status: "paid", amount: "999" },
    ]), { balance: 1620.31, awaiting_count: 1, unpaid_count: 2 });

    const cfgPool = (cfg, obligations = []) => ({
      calls: [],
      async query(sql, params) {
        this.calls.push({ sql, params });
        if (/housing_config FROM user_settings/.test(sql)) return { rows: [{ housing_config: cfg }] };
        if (/FROM payee_obligations/.test(sql)) return { rows: obligations };
        throw new Error("unexpected " + sql);
      },
    });
    const off = cfgPool({ enabled: false, payee_name: "Sam" });
    assert.deepEqual(await getHousingOwed(off), { configured: false });
    assert.equal(off.calls.length, 1, "no ledger read while it's off");
    assert.deepEqual(await getHousingOwed(cfgPool({ enabled: true, payee_name: "" })), { configured: false });

    const on = cfgPool({ enabled: true, payee_name: "Sam Lee", rent_amount: 1500, rent_due_day: 1 }, [{ status: "unpaid", amount: "1500" }]);
    assert.deepEqual(await getHousingOwed(on), { configured: true, payee: "Sam Lee", balance: 1500, awaiting_count: 0, unpaid_count: 1 });
    assert.deepEqual(on.calls[1].params, ["Sam Lee"]);
    assert.match(read("teller", "routes", "housing.js"), /router\.get\("\/api\/housing\/ledger"[\s\S]{0,2500}ledgerTotals\(/);
  });

  it("countUncategorized backs /api/categorize/status", async () => {
    const { countUncategorized } = require("../teller/routes/categorize");
    const db = { async query(sql) { assert.match(sql, /user_category IS NULL/); return { rows: [{ uncategorized: "12" }] }; } };
    assert.equal(await countUncategorized(db), 12);
    assert.match(read("teller", "routes", "categorize.js"), /uncategorized: await countUncategorized\(pool\)/);
  });

  it("gatherDataHealth backs GET /api/data-health", () => {
    const settings = require("../teller/routes/settings");
    assert.equal(typeof settings.gatherDataHealth, "function");
    assert.match(read("teller", "routes", "settings.js"),
      /router\.get\("\/api\/data-health"[\s\S]{0,200}res\.json\(await gatherDataHealth\(pool, \{ persistentPool: req\.app\.get\("persistentPool"\) \|\| null \}\)\)/);
  });
});

// ---------------------------------------------------------------------------
// The renderers, run in a vm from dashboard.ejs with perfin-shared.js's own
// esc / withBase / fmt / fmtDate.
// ---------------------------------------------------------------------------
const shared = read("teller", "public", "perfin-shared.js");
const dash = read("teller", "views", "dashboard.ejs");

function loadRenderers(basePath) {
  const ctx = { win: { BASE_PATH: basePath } };
  vm.runInNewContext(
    slice(shared, "function esc(s)", "// --- Empty states") +
      slice(shared, "function fmt(n)", "// TODAY as 'YYYY-MM-DD'") +
      slice(dash, "function summaryCard(", "async function loadDashboardSummary()") +
      "\nthis.renderSummaryCards = renderSummaryCards; this.renderAttention = renderAttention;",
    ctx);
  return ctx;
}

const fullSummary = () => ({
  net_worth: { ok: true, value: 52000.46, as_of: "2026-10-25", change: 2000.46, change_since: "2026-10-01" },
  spending: { ok: true, month: "2026-10", budget_count: 2, spent: 672.75, budget: 700, percent: 96, over_count: 1 },
  cash: { ok: true, days: 30, starting_balance: 3200.4, lowest_balance: 845.12, lowest_date: "2026-11-14" },
});

describe("the Summary card (dashboard.ejs, in a vm)", () => {
  it("renders the three figures with their dates", () => {
    const { renderSummaryCards } = loadRenderers("");
    const html = renderSummaryCards(fullSummary());
    assert.match(html, /<div class="label">Net worth<\/div><div class="value"><span>\$52,000\.46<\/span><\/div>/);
    assert.match(html, /<span class="amt-in">\+\$2,000\.46<\/span> since Oct 1/);
    assert.match(html, /\$672\.75 <span [^>]*>of \$700\.00<\/span>/);
    assert.match(html, /role="img" aria-label="96% of this month's budget used"><span style="width:96%;"><\/span>/);
    assert.match(html, /96% of 2 budgets · <span class="amt-bad">1 over<\/span>/);
    assert.match(html, /Lowest cash, next 30 days<\/div><div class="value"><span>\$845\.12<\/span><\/div><div class="sub">On Nov 14<\/div>/);
  });

  it("a fall in net worth is plain, a negative is red, over budget turns the bar red and caps it at 100%", () => {
    const { renderSummaryCards } = loadRenderers("");
    const s = fullSummary();
    s.net_worth.value = -1200.5; s.net_worth.change = -50;
    s.spending = { ok: true, budget_count: 1, spent: 300, budget: 200, percent: 150, over_count: 1 };
    s.cash.lowest_balance = -20;
    const html = renderSummaryCards(s);
    assert.match(html, /<span class="amt-bad">-\$1,200\.50<\/span>/);
    assert.match(html, /<span>-\$50\.00<\/span> since/);
    assert.match(html, /<span class="amt-bad" style="width:100%;"><\/span>/);
    assert.match(html, /150% of 1 budget ·/);
    assert.match(html, /<span class="amt-bad">-\$20\.00<\/span>/);
  });

  it("the not-yet states and a failed part (escaped, a dash)", () => {
    const { renderSummaryCards } = loadRenderers("/perfin");
    const html = renderSummaryCards({
      net_worth: { ok: true, value: null },
      spending: { ok: true, budget_count: 0, spent: 0, budget: 0, percent: null },
      cash: { ok: false, error: "<b>The cash forecast</b>" },
    });
    assert.match(html, /Net worth<\/div><div class="value">Not yet<\/div><div class="sub">Appears after the next balance sync/);
    assert.match(html, /No budgets<\/div><div class="sub"><a href="\/perfin\/budgets">Set a budget<\/a>/);
    assert.match(html, /Lowest cash, next 30 days<\/div><div class="value">—<\/div><div class="sub">&lt;b&gt;The cash forecast&lt;\/b&gt;/);
    const noCash = renderSummaryCards(Object.assign(fullSummary(), { cash: { ok: true, days: 30, lowest_balance: null } }));
    assert.match(noCash, /No checking or savings balance yet/);
  });
});

describe("Needs attention (dashboard.ejs, in a vm)", () => {
  it("each item links through withBase with its amount; text is escaped", () => {
    const { renderAttention } = loadRenderers("/perfin");
    const html = renderAttention({ items: [
      { kind: "rent", text: "Owed to <Sam & Co>", amount: 1850, href: "/housing" },
      { kind: "uncategorized", text: "7 transactions to categorize", href: "/dashboard#review-queue-section" },
    ], errors: [] });
    assert.match(html, /<li><a href="\/perfin\/housing">Owed to &lt;Sam &amp; Co&gt;<\/a><span class="amount">\$1,850\.00<\/span><\/li>/);
    assert.match(html, /<li><a href="\/perfin\/dashboard#review-queue-section">7 transactions to categorize<\/a><\/li>/);
  });

  it("only a same-app path becomes a link", () => {
    const { renderAttention } = loadRenderers("");
    for (const href of ["javascript:alert(1)", "//evil.example/x", "https://evil.example", "housing", null]) {
      const html = renderAttention({ items: [{ text: "X", href }], errors: [] });
      assert.doesNotMatch(html, /<a /, String(href));
      assert.match(html, /<li>X<\/li>/);
    }
  });

  it("nothing to show → a quiet tick; a failed source → its sentence, and no all-clear", () => {
    const { renderAttention } = loadRenderers("");
    assert.match(renderAttention({ items: [], errors: [] }), /<div class="all-clear"><span class="tick" aria-hidden="true">✓<\/span>Nothing needs attention<\/div>/);
    assert.match(renderAttention(undefined), /Nothing needs attention/);
    const failed = renderAttention({ items: [], errors: [{ source: "rent", error: "The rent <ledger>" }] });
    assert.doesNotMatch(failed, /Nothing needs attention/, "a source we couldn't check isn't 'nothing'");
    assert.match(failed, /<div class="note">The rent &lt;ledger&gt;<\/div>/);
  });

  it("the page: summary first, skeletons while loading, one line when the load fails", () => {
    assert.match(dash, /<section class="dash-summary" id="dash-summary" aria-label="This month at a glance">/);
    assert.match(dash, /id="dash-summary-cards"[^>]*aria-busy="true"/);
    assert.match(dash, /id="dash-attention"[^>]*aria-busy="true"/);
    assert.match(dash, /class="skel/);
    assert.match(dash, /id="dash-summary-error" role="status" hidden/);
    const load = slice(dash, "async function loadDashboardSummary()", "// Initialize");
    assert.match(load, /catch \(e\) \{[\s\S]*cards\.hidden = true;[\s\S]*att\.hidden = true;[\s\S]*The summary couldn\\'t be loaded/);
    assert.match(load, /finally \{[\s\S]*removeAttribute\('aria-busy'\)/);
    const init = dash.slice(dash.indexOf("// Initialize"));
    assert.match(init, /^\/\/ Initialize\s+loadDashboardSummary\(\);\s+loadAccounts\(\);/, "loaded first; the rest of the page still loads");
    // The summary sits above the sync strip and the widgets.
    assert.ok(dash.indexOf('id="dash-summary"') < dash.indexOf('id="sync-health-strip"'));
    // Not a toggleable widget yet (D4 reorders the widgets).
    assert.doesNotMatch(shared, /dash-summary/);
  });

  it("the review-queue anchor the uncategorized item links to exists", () => {
    assert.match(dash, /id="review-queue-section"/);
    assert.match(read("teller", "views", "settings.ejs"), /id="sync-health"/);
  });
});
