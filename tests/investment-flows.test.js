// ============================================================================
// Investment flows — TWR/XIRR + Plaid flow classification + manual CRUD
// ============================================================================
//   - classifyPlaidFlow: external flows vs return components vs internal churn
//     (Plaid sign convention: cash inflow = negative amount)
//   - computeTWR: daily chain-linked, flow-adjusted (exact, no Dietz approx)
//   - computeXIRR: annualized money-weighted return via bisection
//   - POST/DELETE /api/investment-flows: validation, sign normalization,
//     plaid-row delete protection
//   - GET /api/investments/performance-history: scoped TWR/XIRR + coverage
//   - scheduler wiring + sync idempotency (source-pinned)
// ============================================================================

const { describe, it, before, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

if (!process.env.NEON_DATABASE_URL) process.env.NEON_DATABASE_URL = "postgres://mock:mock@localhost/mock";
if (!process.env.TOKEN_ENCRYPTION_PASSPHRASE) process.env.TOKEN_ENCRYPTION_PASSPHRASE = "test-passphrase";

const ROOT = path.join(__dirname, "..");
const inv = require("../teller/routes/investments");

// ---------------------------------------------------------------------------
// classifyPlaidFlow
// ---------------------------------------------------------------------------
describe("classifyPlaidFlow", () => {
  it("cash deposits/contributions are positive flows regardless of amount sign", () => {
    // Plaid reports inflows as negative — but sign comes from the subtype.
    assert.deepEqual(inv.classifyPlaidFlow({ type: "cash", subtype: "deposit", amount: -500 }),
      { amount: 500, flow_type: "contribution" });
    assert.deepEqual(inv.classifyPlaidFlow({ type: "cash", subtype: "contribution", amount: 500 }),
      { amount: 500, flow_type: "contribution" });
  });

  it("cash withdrawals are negative flows", () => {
    assert.deepEqual(inv.classifyPlaidFlow({ type: "cash", subtype: "withdrawal", amount: 250 }),
      { amount: -250, flow_type: "withdrawal" });
    assert.deepEqual(inv.classifyPlaidFlow({ type: "cash", subtype: "withdrawal", amount: -250 }),
      { amount: -250, flow_type: "withdrawal" });
  });

  it("dividends, interest, and other cash return-components are NOT flows", () => {
    assert.equal(inv.classifyPlaidFlow({ type: "cash", subtype: "dividend", amount: -12.5 }), null);
    assert.equal(inv.classifyPlaidFlow({ type: "cash", subtype: "interest", amount: -1.2 }), null);
    assert.equal(inv.classifyPlaidFlow({ type: "cash", subtype: "long-term capital gain", amount: -9 }), null);
    assert.equal(inv.classifyPlaidFlow({ type: "cash", subtype: "tax withheld", amount: 3 }), null);
  });

  it("buys, sells, fees, cancels are internal — never flows", () => {
    assert.equal(inv.classifyPlaidFlow({ type: "buy", subtype: "buy", amount: 1000 }), null);
    assert.equal(inv.classifyPlaidFlow({ type: "sell", subtype: "sell", amount: -1000 }), null);
    assert.equal(inv.classifyPlaidFlow({ type: "fee", subtype: "management fee", amount: 5 }), null);
    assert.equal(inv.classifyPlaidFlow({ type: "cancel", subtype: "cancel", amount: 1 }), null);
  });

  it("in-kind transfers use the Plaid amount sign (inflow-negative → negated)", () => {
    // Securities transferred IN: Plaid inflow = negative → +flow
    assert.deepEqual(inv.classifyPlaidFlow({ type: "transfer", subtype: "transfer", amount: -2000 }),
      { amount: 2000, flow_type: "transfer_in" });
    assert.deepEqual(inv.classifyPlaidFlow({ type: "transfer", subtype: "send", amount: 800 }),
      { amount: -800, flow_type: "transfer_out" });
  });

  it("corporate actions and unknown transfer subtypes are conservatively skipped", () => {
    assert.equal(inv.classifyPlaidFlow({ type: "transfer", subtype: "merger", amount: 100 }), null);
    assert.equal(inv.classifyPlaidFlow({ type: "transfer", subtype: "spin off", amount: 100 }), null);
    assert.equal(inv.classifyPlaidFlow({ type: "transfer", subtype: "mystery", amount: 100 }), null);
  });

  it("zero / NaN amounts are never flows", () => {
    assert.equal(inv.classifyPlaidFlow({ type: "cash", subtype: "deposit", amount: 0 }), null);
    assert.equal(inv.classifyPlaidFlow({ type: "cash", subtype: "deposit", amount: "abc" }), null);
  });
});

// ---------------------------------------------------------------------------
// computeTWR
// ---------------------------------------------------------------------------
describe("computeTWR", () => {
  it("equals the simple return when there are no flows", () => {
    const series = [
      { date: "2026-01-01", value: 100 },
      { date: "2026-02-01", value: 105 },
      { date: "2026-03-01", value: 110 },
    ];
    assert.ok(Math.abs(inv.computeTWR(series, {}) - 10) < 1e-9);
  });

  it("a deposit-funded jump is NOT return: 100 → 200 via a $100 deposit = 0% TWR", () => {
    const series = [
      { date: "2026-01-01", value: 100 },
      { date: "2026-01-02", value: 200 },
    ];
    assert.ok(Math.abs(inv.computeTWR(series, { "2026-01-02": 100 })) < 1e-9);
  });

  it("a withdrawal is added back: 200 → 110 after a $100 withdrawal = +5% TWR", () => {
    const series = [
      { date: "2026-01-01", value: 200 },
      { date: "2026-01-02", value: 110 },
    ];
    // (110 − (−100)) / 200 − 1 = 0.05
    assert.ok(Math.abs(inv.computeTWR(series, { "2026-01-02": -100 }) - 5) < 1e-9);
  });

  it("chains across sub-periods: +10% then deposit then +10% = +21% TWR", () => {
    const series = [
      { date: "2026-01-01", value: 100 },
      { date: "2026-02-01", value: 110 },   // +10%
      { date: "2026-02-02", value: 210 },   // $100 deposit, no growth
      { date: "2026-03-01", value: 231 },   // +10%
    ];
    assert.ok(Math.abs(inv.computeTWR(series, { "2026-02-02": 100 }) - 21) < 1e-6);
  });

  it("returns null for short or zero-based series", () => {
    assert.equal(inv.computeTWR([{ date: "2026-01-01", value: 100 }], {}), null);
    assert.equal(inv.computeTWR([], {}), null);
    assert.equal(inv.computeTWR(null, {}), null);
    // all-zero base days are skipped → nothing usable
    assert.equal(inv.computeTWR([
      { date: "2026-01-01", value: 0 },
      { date: "2026-01-02", value: 0 },
    ], {}), null);
  });
});

// ---------------------------------------------------------------------------
// computeXIRR
// ---------------------------------------------------------------------------
describe("computeXIRR", () => {
  it("-1000 then +1100 one year later ≈ +10%/yr", () => {
    const x = inv.computeXIRR([
      { date: "2025-01-01", amount: -1000 },
      { date: "2026-01-01", amount: 1100 },
    ]);
    assert.ok(Math.abs(x - 10) < 0.1, "got " + x);
  });

  it("-1000 then +1000 one year later ≈ 0%/yr", () => {
    const x = inv.computeXIRR([
      { date: "2025-01-01", amount: -1000 },
      { date: "2026-01-01", amount: 1000 },
    ]);
    assert.ok(Math.abs(x) < 0.1, "got " + x);
  });

  it("handles a mid-period contribution sensibly (rate between leg returns)", () => {
    // 1000 grows to 1100 over a year, plus 1000 added at 6 months that also
    // ends in the final 2150 value → blended annualized rate around 9-11%.
    const x = inv.computeXIRR([
      { date: "2025-01-01", amount: -1000 },
      { date: "2025-07-01", amount: -1000 },
      { date: "2026-01-01", amount: 2150 },
    ]);
    assert.ok(x > 5 && x < 15, "got " + x);
  });

  it("returns null when no root can be bracketed", () => {
    assert.equal(inv.computeXIRR([
      { date: "2025-01-01", amount: -100 },
      { date: "2026-01-01", amount: -100 },
    ]), null, "all-negative flows");
    assert.equal(inv.computeXIRR([{ date: "2025-01-01", amount: -100 }]), null, "single flow");
    assert.equal(inv.computeXIRR(null), null);
  });
});

// ---------------------------------------------------------------------------
// Manual flow CRUD (behavioral, mock pool)
// ---------------------------------------------------------------------------
describe("manual investment-flow CRUD", () => {
  const supertest = require("supertest");
  const express = require("express");
  let dbModule, originalPoolQuery, app;

  before(() => {
    dbModule = require("../teller/services/database");
    originalPoolQuery = dbModule.pool.query;
    app = express();
    app.use(express.json());
    app.use(inv);
  });

  afterEach(() => { dbModule.pool.query = originalPoolQuery; });

  it("POST normalizes the sign from flow_type (withdrawal always stored negative)", async () => {
    let inserted;
    dbModule.pool.query = async (sql, params) => {
      if (/SELECT 1 FROM investment_accounts/i.test(sql)) return { rows: [{ "?column?": 1 }] };
      if (/INSERT INTO investment_flows/i.test(sql)) { inserted = params; return { rows: [{ id: 1 }] }; }
      return { rows: [] };
    };
    await supertest(app).post("/api/investment-flows")
      .send({ source_id: 3, flow_date: "2026-06-01", amount: 500, flow_type: "withdrawal" })
      .expect(200);
    assert.equal(inserted[3], -500, "withdrawal stored negative even when submitted positive");
    assert.equal(inserted[0], "investment", "source defaults to investment");
  });

  it("POST rejects bad dates, types, amounts, and unknown accounts", async () => {
    dbModule.pool.query = async (sql) => {
      if (/SELECT 1 FROM/i.test(sql)) return { rows: [] }; // account not found
      return { rows: [] };
    };
    await supertest(app).post("/api/investment-flows")
      .send({ source_id: 1, flow_date: "junk", amount: 5, flow_type: "contribution" }).expect(400);
    await supertest(app).post("/api/investment-flows")
      .send({ source_id: 1, flow_date: "2026-06-01", amount: 5, flow_type: "dividend" }).expect(400);
    await supertest(app).post("/api/investment-flows")
      .send({ source_id: 1, flow_date: "2026-06-01", amount: 0, flow_type: "contribution" }).expect(400);
    await supertest(app).post("/api/investment-flows")
      .send({ source_id: 99, flow_date: "2026-06-01", amount: 5, flow_type: "contribution" }).expect(400);
  });

  it("DELETE refuses plaid-provenance rows (404 — they'd resurrect on next sync)", async () => {
    let capturedSql;
    dbModule.pool.query = async (sql) => {
      capturedSql = sql;
      return { rows: [] }; // no manual row matched
    };
    await supertest(app).delete("/api/investment-flows/7").expect(404);
    assert.match(capturedSql, /provenance = 'manual'/);
  });
});

// ---------------------------------------------------------------------------
// performance-history TWR/XIRR integration (mock pool)
// ---------------------------------------------------------------------------
describe("performance-history flow-adjusted figures", () => {
  const supertest = require("supertest");
  const express = require("express");
  const benchmarks = require("../teller/services/benchmarks");
  let dbModule, originalPoolQuery, originalEnsure, originalGetSeries, app;

  before(() => {
    dbModule = require("../teller/services/database");
    originalPoolQuery = dbModule.pool.query;
    originalEnsure = benchmarks.ensureBenchmark;
    originalGetSeries = benchmarks.getBenchmarkSeries;
    app = express();
    app.use(inv);
  });

  afterEach(() => {
    dbModule.pool.query = originalPoolQuery;
    benchmarks.ensureBenchmark = originalEnsure;
    benchmarks.getBenchmarkSeries = originalGetSeries;
  });

  it("deposit-funded growth: +100% value return but 0% TWR, full coverage", async () => {
    dbModule.pool.query = async (sql) => {
      if (/FROM account_balance_snapshots/i.test(sql)) return { rows: [
        { snapshot_date: "2026-06-01", source: "investment", source_id: 1, balance: "100" },
        { snapshot_date: "2026-06-02", source: "investment", source_id: 1, balance: "200" },
      ]};
      if (/plaid_account_id IS NOT NULL AND is_active = true/i.test(sql)) return { rows: [{ id: 1 }] };
      if (/SELECT DISTINCT source, source_id FROM investment_flows/i.test(sql)) return { rows: [] };
      if (/FROM investment_flows/i.test(sql)) return { rows: [
        { source: "investment", source_id: 1, flow_date: "2026-06-02", amount: "100" },
      ]};
      return { rows: [] };
    };
    benchmarks.ensureBenchmark = async () => false;
    benchmarks.getBenchmarkSeries = async () => [];

    const res = await supertest(app).get("/api/investments/performance-history").expect(200);
    assert.ok(Math.abs(res.body.portfolio_return_pct - 100) < 1e-9, "value return +100%");
    assert.ok(Math.abs(res.body.twr_pct) < 1e-9, "TWR 0% — the jump was a deposit");
    assert.ok(Math.abs(res.body.xirr_pct) < 0.5, "XIRR ~0%/yr");
    assert.equal(res.body.flow_coverage.scope, "all");
    assert.equal(res.body.flow_coverage.flows_count, 1);
    assert.equal(res.body.flow_coverage.net_flows, 100);
  });

  it("uncovered accounts are excluded from TWR scope (partial coverage label)", async () => {
    dbModule.pool.query = async (sql) => {
      if (/FROM account_balance_snapshots/i.test(sql)) return { rows: [
        // covered Plaid account: flat
        { snapshot_date: "2026-06-01", source: "investment", source_id: 1, balance: "100" },
        { snapshot_date: "2026-06-02", source: "investment", source_id: 1, balance: "100" },
        // uncovered Teller account: jumps (untracked contribution)
        { snapshot_date: "2026-06-01", source: "linked", source_id: 9, balance: "100" },
        { snapshot_date: "2026-06-02", source: "linked", source_id: 9, balance: "300" },
      ]};
      if (/plaid_account_id IS NOT NULL AND is_active = true/i.test(sql)) return { rows: [{ id: 1 }] };
      if (/SELECT DISTINCT source, source_id FROM investment_flows/i.test(sql)) return { rows: [] };
      if (/FROM investment_flows/i.test(sql)) return { rows: [] };
      return { rows: [] };
    };
    benchmarks.ensureBenchmark = async () => false;
    benchmarks.getBenchmarkSeries = async () => [];

    const res = await supertest(app).get("/api/investments/performance-history").expect(200);
    assert.ok(Math.abs(res.body.twr_pct) < 1e-9, "TWR measures only the covered (flat) account");
    assert.equal(res.body.flow_coverage.scope, "partial");
    assert.ok(res.body.flow_coverage.coverage_pct < 50, "covered 100 of 400 total");
  });

  it("no covered accounts → twr/xirr null, no flow_coverage block", async () => {
    dbModule.pool.query = async (sql) => {
      if (/FROM account_balance_snapshots/i.test(sql)) return { rows: [
        { snapshot_date: "2026-06-01", source: "linked", source_id: 9, balance: "100" },
        { snapshot_date: "2026-06-02", source: "linked", source_id: 9, balance: "110" },
      ]};
      return { rows: [] };
    };
    benchmarks.ensureBenchmark = async () => false;
    benchmarks.getBenchmarkSeries = async () => [];
    const res = await supertest(app).get("/api/investments/performance-history").expect(200);
    assert.equal(res.body.twr_pct, null);
    assert.equal(res.body.xirr_pct, null);
    assert.equal(res.body.flow_coverage, null);
  });
});

// ---------------------------------------------------------------------------
// Wiring + sync idempotency (source-pinned)
// ---------------------------------------------------------------------------
describe("investment-flows wiring", () => {
  it("both scheduler chains call syncAllPlaidInvestmentFlows", () => {
    const src = fs.readFileSync(path.join(ROOT, "teller", "startup.js"), "utf8");
    const hits = src.match(/syncAllPlaidInvestmentFlows\(\)/g) || [];
    assert.ok(hits.length >= 2, "auto-sync AND pre-insights chains must sync flows");
  });

  it("POST /api/sync-balances refreshes flows too", () => {
    const src = fs.readFileSync(path.join(ROOT, "teller", "routes", "enrollments.js"), "utf8");
    assert.match(src, /syncAllPlaidInvestmentFlows/);
    assert.match(src, /flows_added/);
  });

  it("the Plaid sync is idempotent (ON CONFLICT on the Plaid txn id) with a page guard", () => {
    const src = fs.readFileSync(path.join(ROOT, "teller", "routes", "investments.js"), "utf8");
    assert.match(src, /ON CONFLICT \(plaid_investment_transaction_id\) DO NOTHING/);
    assert.match(src, /FLOW_MAX_PAGES/);
    assert.match(src, /investmentsTransactionsGet/);
  });
});
