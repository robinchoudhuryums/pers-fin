// ============================================================================
// Roadmap T2.2 L1 — the cash-flow forecast as a shared service
// ============================================================================
// services/cash-flow.js: the pure projection over canned inputs (calendar-date
// stepping across a month end, weekday averages + the overall fallback, a
// monthly bill, income, the lowest day, firstBelow, weekly totals), the inputs'
// queries over a mock pool (card autopays skipped, loans kept, `today` threaded
// into the income streams), GET /api/cash-flow as a thin wrapper (old fields +
// lowest_balance / lowest_balance_date, no daily series) and the dashboard's
// "Lowest projected" line run in a vm.
//
// Runs with an APP_TIMEZONE whose date DIFFERS from UTC's (UTC−12 before noon
// UTC, UTC+14 after — the scan-sept-batch6-tz recipe), so a forecast anchored
// on the UTC date fails.
// ============================================================================
const utcHour = new Date().getUTCHours();
process.env.APP_TIMEZONE = utcHour < 12 ? "Etc/GMT+12" : "Pacific/Kiritimati";
if (!process.env.NEON_DATABASE_URL) process.env.NEON_DATABASE_URL = "postgres://mock:mock@localhost/mock";
if (!process.env.TOKEN_ENCRYPTION_PASSPHRASE) process.env.TOKEN_ENCRYPTION_PASSPHRASE = "test-passphrase";

const { describe, it, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const express = require("express");
const supertest = require("supertest");

const dbModule = require("../teller/services/database");
const originalQuery = dbModule.pool.query;
afterEach(() => { dbModule.pool.query = originalQuery; });

const fq = require("../teller/services/financial-queries");
const { addDaysStr } = require("../teller/services/cadence");
const cf = require("../teller/services/cash-flow");

function mountApp(mod) {
  const app = express();
  app.use(express.json());
  app.use(require(mod));
  return app;
}

// A fixture whose balance path is worked out by hand below.
//   start 1600, $10/day spending (overall average — no weekday data),
//   Rent $1500 monthly (last 2026-01-01 → 02-01 and 03-01),
//   Pay $2000 monthly (anchor 2026-01-15 → 02-15).
//   01-31 1590 · 02-01 80 · … 02-09 0 · 02-10 −10 · … 02-14 −50 ·
//   02-15 1940 · … 02-28 1810 · 03-01 300
function fixture(extra = {}) {
  return {
    today: "2026-01-30",
    startingBalance: 1600,
    avgDailySpend: 10,
    dowSpend: {},
    bills: [{ display_name: "Rent", amount: "1500", cadence_days: 30, next_expected: "2026-02-01", last_date: "2026-01-01" }],
    incomeStreams: [{ source: "Acme", amount: 2000, cadence: "monthly", days: null, anchor: "2026-01-15", last: "2026-01-15" }],
    ...extra,
  };
}

describe("projectCashFlow (pure)", () => {
  const out = cf.projectCashFlow(fixture(), { days: 30 });
  const byDate = Object.fromEntries(out.projection.map((p) => [p.date, p]));

  it("walks today+1 … today+days on calendar dates across a month end", () => {
    assert.equal(out.projection.length, 30);
    assert.equal(out.projection[0].date, "2026-01-31");
    assert.equal(out.projection[1].date, "2026-02-01");
    assert.equal(out.projection[29].date, "2026-03-01");
  });

  it("bills, income and spending land on their days; the running balance is exact", () => {
    assert.equal(byDate["2026-01-31"].balance, 1590);
    assert.equal(byDate["2026-02-01"].bills, 1500);
    assert.equal(byDate["2026-02-01"].balance, 80);
    assert.equal(byDate["2026-02-15"].income, 2000);
    assert.equal(byDate["2026-02-15"].balance, 1940);
    assert.equal(byDate["2026-03-01"].bills, 1500);
    assert.equal(out.ending_balance, 300);
    assert.equal(out.total_projected_bills, 3000);
    assert.equal(out.total_projected_income, 2000);
    assert.equal(out.total_projected_discretionary, 300);
    assert.equal(out.surplus_shortfall, -1300);
    assert.equal(out.starting_balance, 1600);
  });

  it("reports the lowest projected day, which the weekly end balances hide", () => {
    assert.deepEqual(out.lowest, { date: "2026-02-14", balance: -50 });
    assert.ok(out.by_week.every((w) => w.end_balance > -50), "no week ends at the low");
  });

  it("firstBelow finds the first day under a floor (strictly below), or null", () => {
    assert.deepEqual(cf.firstBelow(out.projection, 0), { date: "2026-02-10", balance: -10 });
    assert.deepEqual(cf.firstBelow(out.projection, 100), { date: "2026-02-01", balance: 80 });
    assert.equal(cf.firstBelow(out.projection, -1000), null);
    assert.equal(cf.firstBelow(null, 0), null);
  });

  it("weekly totals and the recurring-income list keep the route's shape", () => {
    assert.equal(out.by_week.length, 5);
    assert.deepEqual(out.by_week[0], { week: 1, start_date: "2026-01-31", income: 0, bills: 1500, discretionary: 70, end_balance: 30 });
    assert.equal(out.by_week[4].start_date, "2026-02-28");
    assert.deepEqual(out.recurring_income, [{ source: "Acme", amount: 2000, cadence: "monthly", cadence_days: 30, last_date: "2026-01-15" }]);
    assert.equal(out.forecast_days, 30);
  });

  it("uses the weekday average when there is one, else the overall average", () => {
    // 2026-01-31 is a Saturday (6), 2026-02-01 a Sunday (0).
    const w = cf.projectCashFlow(fixture({ dowSpend: { 6: 40 }, bills: [], incomeStreams: [] }), { days: 2 });
    assert.equal(w.projection[0].discretionary, 40);
    assert.equal(w.projection[1].discretionary, 10);
  });

  it("projects a semimonthly stream on both of its days", () => {
    const s = cf.projectCashFlow(fixture({
      bills: [], avgDailySpend: 0,
      incomeStreams: [{ source: "Initech", amount: 1000, cadence: "semimonthly", days: [1, 15], anchor: "2026-01-15", last: "2026-01-15" }],
    }), { days: 30 });
    assert.deepEqual(s.projection.filter((p) => p.income > 0).map((p) => p.date), ["2026-02-01", "2026-02-15", "2026-03-01"]);
    assert.deepEqual(s.recurring_income[0].days_of_month, [1, 15]);
  });

  it("no projection → no lowest day", () => {
    assert.equal(cf.projectCashFlow(fixture(), { days: 0 }).lowest, null);
  });
});

describe("getCashFlowInputs (mock pool)", () => {
  function pool(sqls, { incomeRows = [] } = {}) {
    return {
      query: async (sql, params) => {
        sqls.push({ sql, params });
        if (/FROM recurring_transfers/.test(sql)) {
          return { rows: [
            { display_name: "CHASE CREDIT CARD AUTOPAY", amount: "2000", cadence_days: 30, next_expected: "2030-07-01", last_date: "2030-06-01", transfer_type: "bill_payment", direction: "outgoing" },
            { display_name: "AUTO LOAN PAYMENT", amount: "300", cadence_days: 30, next_expected: "2030-07-01", last_date: "2030-06-01", transfer_type: "bill_payment", direction: "outgoing" },
            { display_name: "Vanguard", amount: "500", cadence_days: 30, next_expected: "2030-07-01", last_date: "2030-06-01", transfer_type: "investment", direction: "outgoing" },
          ] };
        }
        if (/FROM detected_subscriptions\s+WHERE/.test(sql)) return { rows: [{ display_name: "Netflix", amount: "15.49", cadence_days: 30, next_expected: "2030-07-05", last_date: "2030-06-05" }] };
        if (/AS cash/.test(sql)) return { rows: [{ cash: "5000.25", debt: "100" }] };
        if (/AS avg_daily\s+FROM \(/.test(sql)) return { rows: [{ avg_daily: "42.5" }] };
        if (/EXTRACT\(DOW/.test(sql)) return { rows: [{ dow: "1", avg_daily: "20" }, { dow: "6", avg_daily: "60" }] };
        if (/FROM transactions\s+WHERE amount < 0/.test(sql)) return { rows: incomeRows };
        return { rows: [] };
      },
    };
  }

  it("skips card autopays, keeps loan and other outgoing transfers and subscriptions", async () => {
    const inputs = await cf.getCashFlowInputs(pool([]), { today: "2030-06-30" });
    assert.deepEqual(inputs.bills.map((b) => b.display_name).sort(), ["AUTO LOAN PAYMENT", "Netflix", "Vanguard"]);
    assert.equal(inputs.startingBalance, 5000.25);
    assert.equal(inputs.avgDailySpend, 42.5);
    assert.deepEqual(inputs.dowSpend, { 1: 20, 6: 60 });
    assert.equal(inputs.today, "2030-06-30");
  });

  it("threads `today` into the income streams' liveness", async () => {
    const incomeRows = ["2030-05-03", "2030-05-17", "2030-05-31", "2030-06-14", "2030-06-28"]
      .map((date) => ({ source: "Acme", date, amount: "2100" }));
    const live = await cf.getCashFlowInputs(pool([], { incomeRows }), { today: "2030-06-30" });
    assert.equal(live.incomeStreams.length, 1);
    assert.equal(live.incomeStreams[0].cadence, "biweekly");
    const stale = await cf.getCashFlowInputs(pool([], { incomeRows }), { today: "2030-09-01" });
    assert.equal(stale.incomeStreams.length, 0, "a stream 65 days quiet isn't projected");
  });

  it("keeps the forecast's query rules (FAN-5 cash, DD-4 no subscriptions in the averages)", async () => {
    const sqls = [];
    await cf.getCashFlowInputs(pool(sqls), { today: "2030-06-30" });
    const bal = sqls.find((s) => /AS cash/.test(s.sql)).sql;
    assert.match(bal, /la\.type = 'depository' AND NOT \(\s*la\.type = 'investment'/);
    const avgs = sqls.filter((s) => /INTERVAL '60 days'/.test(s.sql) && /daily_total/.test(s.sql));
    assert.equal(avgs.length, 2);
    for (const a of avgs) assert.match(a.sql, /NOT EXISTS \(\s*SELECT 1 FROM detected_subscriptions ds/);
  });

  it("isCardAutopay: a bill_payment without loan / mortgage in its name", () => {
    assert.equal(cf.isCardAutopay({ transfer_type: "bill_payment", display_name: "AMEX EPAYMENT" }), true);
    assert.equal(cf.isCardAutopay({ transfer_type: "bill_payment", display_name: "Mortgage payment" }), false);
    assert.equal(cf.isCardAutopay({ transfer_type: "peer_transfer", display_name: "Zelle" }), false);
  });
});

describe("GET /api/cash-flow — a thin wrapper over the service", () => {
  function routePool() {
    const tomorrow = addDaysStr(fq.todayStr(), 1);
    return async (sql) => {
      if (/FROM detected_subscriptions\s+WHERE/.test(sql)) return { rows: [{ display_name: "Gym", amount: "40", cadence_days: 30, next_expected: tomorrow, last_date: addDaysStr(tomorrow, -30) }] };
      if (/AS cash/.test(sql)) return { rows: [{ cash: "500", debt: "0" }] };
      if (/AS avg_daily\s+FROM \(/.test(sql)) return { rows: [{ avg_daily: "25" }] };
      return { rows: [] };
    };
  }

  it("returns the old fields plus the lowest projected day, never the daily series", async () => {
    dbModule.pool.query = routePool();
    const res = await supertest(mountApp("../teller/routes/spending-analytics")).get("/api/cash-flow?days=30").expect(200);
    assert.deepEqual(Object.keys(res.body).sort(), [
      "avg_daily_spend", "by_week", "ending_balance", "forecast_days", "forecast_items", "lowest_balance", "lowest_balance_date",
      "recurring_income", "starting_balance", "surplus_shortfall", "total_projected_bills",
      "total_projected_discretionary", "total_projected_income",
    ]);
    const svc = await cf.getCashFlowForecast(dbModule.pool, { days: 30 });
    assert.equal(res.body.lowest_balance, svc.lowest.balance);
    assert.equal(res.body.lowest_balance_date, svc.lowest.date);
    assert.equal(res.body.ending_balance, svc.ending_balance);
    assert.deepEqual(res.body.by_week, svc.by_week);
    // 500 − 40 (tomorrow's bill) − 25/day for 30 days → lowest on the last day.
    assert.equal(res.body.lowest_balance, -290);
    assert.equal(res.body.lowest_balance_date, addDaysStr(fq.todayStr(), 30));
  });

  it("starts the day after the APP_TIMEZONE date, not the UTC date", async () => {
    dbModule.pool.query = routePool();
    const res = await supertest(mountApp("../teller/routes/spending-analytics")).get("/api/cash-flow?days=30").expect(200);
    assert.notEqual(fq.todayStr(), new Date().toISOString().slice(0, 10), "fixture: the forced zone's date differs from UTC's");
    assert.equal(res.body.by_week[0].start_date, addDaysStr(fq.todayStr(), 1));
    assert.equal(res.body.by_week[0].bills, 40, "tomorrow's bill falls in week 1");
  });

  it("clamps days to 30–180 as before", async () => {
    dbModule.pool.query = routePool();
    const app = mountApp("../teller/routes/spending-analytics");
    assert.equal((await supertest(app).get("/api/cash-flow?days=5").expect(200)).body.forecast_days, 30);
    assert.equal((await supertest(app).get("/api/cash-flow?days=999").expect(200)).body.forecast_days, 180);
  });

  it("the route no longer carries the projection inline", () => {
    const sa = fs.readFileSync(path.join(__dirname, "../teller/routes/spending-analytics.js"), "utf8");
    assert.match(sa, /getCashFlowForecast\(pool, \{ days \}\)/);
    assert.doesNotMatch(sa, /toISOString\(\)\.(slice|split)/, "no UTC date anchors left in the analytics routes");
  });
});

describe("dashboard Cash Flow line", () => {
  const dash = fs.readFileSync(path.join(__dirname, "../teller/views/dashboard.ejs"), "utf8");
  // The section's helpers (design D4) and loadCashFlow.
  const start = dash.indexOf("    // --- Cash Flow Projection ---");
  const end = dash.indexOf("    // --- Year-over-Year Comparison ---");

  // The REAL fmt from perfin-shared.js (a stub of the old "$-50.00" shape
  // pinned the bug — design pass D1).
  const shared = fs.readFileSync(path.join(__dirname, "..", "teller", "public", "perfin-shared.js"), "utf8");
  const fmtSrc = shared.slice(shared.indexOf("function fmt(n) {"), shared.indexOf("// Calendar dates (DATE columns)"));
  const realFmt = new Function(fmtSrc + "\nreturn fmt;")();
  async function render(data) {
    const els = {};
    const document = { getElementById: (id) => (els[id] = els[id] || { style: {}, innerHTML: "" }) };
    const fn = new Function("apiFetch", "document", "fmt", "fmtDate", "esc",
      dash.slice(start, end) + "\nreturn loadCashFlow;")(
      async () => ({ ok: true, json: async () => data }), document,
      realFmt, (d) => "D(" + d + ")", (s) => String(s));
    await fn();
    return els["cashflow-summary"].innerHTML;
  }
  const base = { starting_balance: 500, ending_balance: 300, avg_daily_spend: 25, surplus_shortfall: -200, recurring_income: [], by_week: [{ week: 1, start_date: "2026-02-01", income: 0, bills: 0, discretionary: 0, end_balance: 300 }] };

  it("shows the lowest projected balance and its date (red when negative)", async () => {
    const html = await render({ ...base, lowest_balance: -50, lowest_balance_date: "2026-02-14" });
    assert.match(html, /Lowest projected: <strong class="amt-bad">-\$50\.00<\/strong> on D\(2026-02-14\)/);
    // Design D2: a non-negative figure is the default colour (no gold).
    const pos = await render({ ...base, lowest_balance: 120, lowest_balance_date: "2026-02-03" });
    assert.match(pos, /Lowest projected: <strong>\$120\.00<\/strong> on D\(2026-02-03\)/);
  });

  it("leaves the line out when the response has no lowest day", async () => {
    assert.doesNotMatch(await render(base), /Lowest projected/);
  });
});
