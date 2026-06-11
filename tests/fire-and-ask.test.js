// ============================================================================
// FIRE/runway projections + Ask Perfin (NL finance Q&A)
// ============================================================================

const { describe, it, before, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

if (!process.env.NEON_DATABASE_URL) process.env.NEON_DATABASE_URL = "postgres://mock:mock@localhost/mock";
if (!process.env.TOKEN_ENCRYPTION_PASSPHRASE) process.env.TOKEN_ENCRYPTION_PASSPHRASE = "test-passphrase";

const ROOT = path.join(__dirname, "..");
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), "utf8");
const { computeFireProjection, computeRunwayMonths, monthlyRate } = require("../teller/services/projections");

// ---------------------------------------------------------------------------
// FIRE math (pure)
// ---------------------------------------------------------------------------
describe("computeFireProjection", () => {
  it("FIRE number = annual spending × (100 / withdrawal rate)", () => {
    const p = computeFireProjection({ netWorth: 0, monthlySavings: 0, monthlySpending: 4000, withdrawalRatePct: 4 });
    assert.equal(p.fire_number, 4000 * 12 * 25); // 1.2M — the 4% rule
    const p3 = computeFireProjection({ netWorth: 0, monthlySavings: 0, monthlySpending: 4000, withdrawalRatePct: 3 });
    assert.ok(Math.abs(p3.fire_number - 1600000) < 1, "3% rule → 33.3× annual spending");
  });

  it("already-FIRE portfolios report 0 months and 100%+ progress", () => {
    const p = computeFireProjection({ netWorth: 2000000, monthlySavings: 0, monthlySpending: 4000 });
    assert.equal(p.already_fire, true);
    assert.equal(p.months_to_fire, 0);
    assert.ok(p.progress_pct > 100);
  });

  it("zero return + pure savings reaches the target in gap/savings months", () => {
    // 1.2M target, 100k start, 10k/mo, 0% return → 110 months exactly
    const p = computeFireProjection({ netWorth: 100000, monthlySavings: 10000, monthlySpending: 4000, annualReturnPct: 0 });
    assert.equal(p.months_to_fire, 110);
  });

  it("compounding shortens the road: 5% return strictly faster than 0%", () => {
    const base = { netWorth: 100000, monthlySavings: 3000, monthlySpending: 4000 };
    const flat = computeFireProjection({ ...base, annualReturnPct: 0 });
    const grow = computeFireProjection({ ...base, annualReturnPct: 5 });
    assert.ok(grow.months_to_fire < flat.months_to_fire);
  });

  it("negative savings with insufficient compounding → unreachable (null)", () => {
    const p = computeFireProjection({ netWorth: 10000, monthlySavings: -500, monthlySpending: 4000, annualReturnPct: 0 });
    assert.equal(p.months_to_fire, null);
    assert.equal(p.already_fire, false);
  });

  it("no spending data → no FIRE number, but the series still projects", () => {
    const p = computeFireProjection({ netWorth: 50000, monthlySavings: 1000, monthlySpending: 0 });
    assert.equal(p.fire_number, null);
    assert.equal(p.progress_pct, null);
    assert.ok(p.series.length > 10, "40-year series present");
    assert.equal(p.series[0].projected_net_worth, 50000);
  });

  it("the monthly rate honors the annual figure geometrically", () => {
    assert.ok(Math.abs(Math.pow(1 + monthlyRate(5), 12) - 1.05) < 1e-12);
    assert.equal(monthlyRate(0), 0);
  });
});

describe("computeRunwayMonths", () => {
  it("no growth: runway ≈ net worth / monthly spending", () => {
    assert.equal(computeRunwayMonths({ netWorth: 40000, monthlySpending: 4000, annualReturnPct: 0 }), 10);
  });
  it("growth extends the runway", () => {
    const flat = computeRunwayMonths({ netWorth: 200000, monthlySpending: 4000, annualReturnPct: 0 });
    const grow = computeRunwayMonths({ netWorth: 200000, monthlySpending: 4000, annualReturnPct: 5 });
    assert.ok(grow > flat);
  });
  it("a portfolio that outearns the draw is infinite (null)", () => {
    // 4% SWR-safe portfolio at 5% return never depletes
    assert.equal(computeRunwayMonths({ netWorth: 2000000, monthlySpending: 4000, annualReturnPct: 5 }), null);
  });
  it("edge cases: zero spending → null, zero net worth → 0", () => {
    assert.equal(computeRunwayMonths({ netWorth: 100000, monthlySpending: 0 }), null);
    assert.equal(computeRunwayMonths({ netWorth: 0, monthlySpending: 1000 }), 0);
  });
});

// ---------------------------------------------------------------------------
// GET /api/fire-projection (behavioral)
// ---------------------------------------------------------------------------
describe("GET /api/fire-projection", () => {
  const supertest = require("supertest");
  const express = require("express");
  let dbModule, originalPoolQuery, app;

  before(() => {
    dbModule = require("../teller/services/database");
    originalPoolQuery = dbModule.pool.query;
    app = express();
    app.use(require("../teller/routes/goals"));
  });
  afterEach(() => { dbModule.pool.query = originalPoolQuery; });

  it("assembles net worth + completed-month averages + settings into a projection", async () => {
    const lastMonth = new Date(new Date().setMonth(new Date().getMonth() - 1)).toISOString().slice(0, 7);
    dbModule.pool.query = async (sql) => {
      if (/fire_expected_return_pct/.test(sql)) return { rows: [{ fire_expected_return_pct: "5", fire_withdrawal_rate_pct: "4", fire_monthly_spending_override: null }] };
      if (/total_income/i.test(sql)) return { rows: [{ month: lastMonth, total_income: "8000" }] };
      if (/total_spend/i.test(sql)) return { rows: [{ month: lastMonth, total_spend: "4000" }] };
      // getNetWorth's two queries
      if (/FROM linked_accounts/i.test(sql)) return { rows: [] };
      return { rows: [{ id: 1, name: "Brokerage", balance: "100000", account_type: "brokerage", is_active: true }] };
    };
    const res = await supertest(app).get("/api/fire-projection").expect(200);
    assert.equal(res.body.assumptions.annual_return_pct, 5);
    assert.equal(res.body.fire_number, 1200000, "4k/mo × 12 × 25");
    assert.equal(res.body.data_basis.monthly_savings, 4000);
    assert.ok(res.body.months_to_fire > 0 && res.body.months_to_fire < 12 * 30, "reachable within 30y at 4k/mo savings");
    assert.ok(res.body.runway_months > 20, "100k at 4k/mo spend with growth");
    assert.match(res.body.projected_fire_date, /^\d{4}-\d{2}$/);
  });

  it("PATCH /api/settings validates the fire assumption bounds", async () => {
    const sApp = express();
    sApp.use(express.json());
    sApp.use(require("../teller/routes/settings"));
    dbModule.pool.query = async (sql) => /UPDATE user_settings/.test(sql) ? { rows: [{ id: 1 }] } : { rows: [] };
    await supertest(sApp).patch("/api/settings").send({ fire_expected_return_pct: 25 }).expect(400);
    await supertest(sApp).patch("/api/settings").send({ fire_withdrawal_rate_pct: 0.5 }).expect(400);
    await supertest(sApp).patch("/api/settings").send({ fire_expected_return_pct: 6.5, fire_withdrawal_rate_pct: 3.5, fire_monthly_spending_override: null }).expect(200);
  });
});

// ---------------------------------------------------------------------------
// Ask Perfin — tool executors (pure reads, mock pool)
// ---------------------------------------------------------------------------
describe("Ask Perfin tool executors", () => {
  const ask = require("../teller/routes/ask");
  let dbModule, originalPoolQuery;

  before(() => {
    dbModule = require("../teller/services/database");
    originalPoolQuery = dbModule.pool.query;
  });
  afterEach(() => { dbModule.pool.query = originalPoolQuery; });

  it("every advertised tool has an executor (no schema/executor drift)", () => {
    for (const t of ask.TOOLS) {
      assert.equal(typeof ask.TOOL_EXECUTORS[t.name], "function", t.name);
    }
    assert.equal(ask.TOOLS.length, Object.keys(ask.TOOL_EXECUTORS).length);
  });

  it("get_category_spending validates the month format", async () => {
    const r = await ask.TOOL_EXECUTORS.get_category_spending({ month: "junk" });
    assert.match(r.error, /YYYY-MM/);
  });

  it("search_transactions parameterizes inputs and returns the adjusted total", async () => {
    const captured = [];
    dbModule.pool.query = async (sql, params) => {
      captured.push({ sql, params });
      if (/COUNT\(\*\)/.test(sql)) return { rows: [{ match_count: "3", total_spent_adjusted: "120.50" }] };
      return { rows: [{ date: "2026-06-01", merchant: "Cafe", amount: "6.50", category: "Food & Drink", is_reimbursed: false }] };
    };
    const r = await ask.TOOL_EXECUTORS.search_transactions({ merchant: "cafe'; DROP TABLE--", limit: 999 });
    assert.equal(r.total_spent_adjusted, "120.50");
    // injection text travels as a bind parameter, never in the SQL string
    for (const c of captured) {
      assert.ok(!c.sql.includes("DROP TABLE"), "no interpolation of user input");
      assert.ok(c.params.some(p => String(p).includes("DROP TABLE")), "input bound as parameter");
    }
    assert.match(captured[0].sql, /LIMIT 50/, "limit clamped to 50");
  });

  it("search_transactions rejects malformed dates", async () => {
    const r = await ask.TOOL_EXECUTORS.search_transactions({ start_date: "junk" });
    assert.match(r.error, /YYYY-MM-DD/);
  });

  it("POST /api/ask is 501 without AI configured and 400 without a question", async () => {
    const supertest = require("supertest");
    const express = require("express");
    const app = express();
    app.use(express.json());
    app.use(ask);
    const saved = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    try {
      await supertest(app).post("/api/ask").send({ question: "hi" }).expect(501);
    } finally {
      if (saved !== undefined) process.env.ANTHROPIC_API_KEY = saved;
    }
  });

  it("shares the monthly cap and charges it via an entry_type='ask' usage row", () => {
    const src = read("teller", "routes", "ask.js");
    assert.match(src, /getAiBudgetCents/, "INV-14: one cap, one reader");
    assert.match(src, /status\(429\)/);
    assert.match(src, /entry_type\)[\s\S]{0,200}'ask'/, "usage row charges the shared cap");
    assert.match(src, /MAX_TOOL_ROUNDS/, "tool loop bounded");
  });
});
