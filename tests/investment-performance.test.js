// ============================================================================
// Investment performance history vs S&P 500 benchmark (roadmap #4 completion)
// ============================================================================
//   - services/benchmarks.js: Stooq CSV parsing, graceful fetch failure,
//     once-per-day fetch gate
//   - routes/investments.buildPortfolioSeries: per-account forward-fill + sum
//   - GET /api/investments/performance-history: series + benchmark + excess,
//     benchmark drops out gracefully, months clamped
// ============================================================================

const { describe, it, before, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");

if (!process.env.NEON_DATABASE_URL) process.env.NEON_DATABASE_URL = "postgres://mock:mock@localhost/mock";
if (!process.env.TOKEN_ENCRYPTION_PASSPHRASE) process.env.TOKEN_ENCRYPTION_PASSPHRASE = "test-passphrase";

const benchmarks = require("../teller/services/benchmarks");

// ---------------------------------------------------------------------------
// parseStooqCsv
// ---------------------------------------------------------------------------
describe("benchmarks.parseStooqCsv", () => {
  it("parses a valid Stooq daily CSV", () => {
    const csv = "Date,Open,High,Low,Close,Volume\n" +
      "2026-06-01,5900.1,5950.2,5890.0,5940.55,123456\n" +
      "2026-06-02,5941.0,5980.0,5930.0,5975.25,234567\n";
    const rows = benchmarks.parseStooqCsv(csv);
    assert.equal(rows.length, 2);
    assert.deepEqual(rows[0], { date: "2026-06-01", close: 5940.55 });
    assert.deepEqual(rows[1], { date: "2026-06-02", close: 5975.25 });
  });

  it("returns [] for garbage, empty, and header-only bodies", () => {
    assert.deepEqual(benchmarks.parseStooqCsv("<html>No data</html>"), []);
    assert.deepEqual(benchmarks.parseStooqCsv(""), []);
    assert.deepEqual(benchmarks.parseStooqCsv(null), []);
    assert.deepEqual(benchmarks.parseStooqCsv("Date,Open,High,Low,Close,Volume\n"), []);
  });

  it("skips malformed rows but keeps good ones", () => {
    const csv = "Date,Open,High,Low,Close,Volume\n" +
      "not-a-date,1,2,3,4,5\n" +
      "2026-06-01,1,2,3,abc,5\n" +
      "2026-06-02,1,2,3,0,5\n" +          // zero close rejected
      "2026-06-03,1,2,3,5000.5,5\n";
    const rows = benchmarks.parseStooqCsv(csv);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].date, "2026-06-03");
  });
});

// ---------------------------------------------------------------------------
// ensureBenchmark
// ---------------------------------------------------------------------------
describe("benchmarks.ensureBenchmark", () => {
  beforeEach(() => benchmarks._resetFetchGate());

  function mockPool({ coverage = { min_d: null, max_d: null } } = {}) {
    const calls = [];
    return {
      calls,
      query: async (sql, params) => {
        calls.push({ sql, params });
        if (/MIN\(price_date\)/i.test(sql)) return { rows: [coverage] };
        return { rows: [] };
      },
    };
  }

  it("returns false (never throws) when the fetch fails and nothing is cached", async () => {
    const pool = mockPool();
    const ok = await benchmarks.ensureBenchmark(pool, 12, {
      fetchImpl: async () => { throw new Error("network down"); },
    });
    assert.equal(ok, false);
  });

  it("upserts parsed closes and returns true on a successful fetch", async () => {
    const pool = mockPool();
    const csv = "Date,Open,High,Low,Close,Volume\n2026-06-01,1,2,3,5900,5\n2026-06-02,1,2,3,5950,5\n";
    const ok = await benchmarks.ensureBenchmark(pool, 12, {
      fetchImpl: async () => ({ ok: true, text: async () => csv }),
    });
    assert.equal(ok, true);
    const upserts = pool.calls.filter(c => /INSERT INTO benchmark_prices/i.test(c.sql));
    assert.equal(upserts.length, 2);
    assert.match(upserts[0].sql, /ON CONFLICT \(symbol, price_date\)/i);
  });

  it("skips the network entirely when coverage is fresh", async () => {
    const today = new Date();
    const pool = mockPool({ coverage: {
      min_d: new Date(today.getTime() - 400 * 86400000),
      max_d: today,
    }});
    let fetched = false;
    const ok = await benchmarks.ensureBenchmark(pool, 12, {
      fetchImpl: async () => { fetched = true; return { ok: true, text: async () => "" }; },
    });
    assert.equal(ok, true);
    assert.equal(fetched, false, "fresh + covered cache must not refetch");
  });

  it("attempts the fetch at most once per day even after a failure", async () => {
    let attempts = 0;
    const failing = { fetchImpl: async () => { attempts++; throw new Error("down"); } };
    await benchmarks.ensureBenchmark(mockPool(), 12, failing);
    await benchmarks.ensureBenchmark(mockPool(), 12, failing);
    assert.equal(attempts, 1, "second call in the same day must not re-stall on the dead source");
  });
});

// ---------------------------------------------------------------------------
// buildPortfolioSeries
// ---------------------------------------------------------------------------
describe("investments.buildPortfolioSeries", () => {
  const { buildPortfolioSeries } = require("../teller/routes/investments");

  it("returns [] for no rows", () => {
    assert.deepEqual(buildPortfolioSeries([]), []);
    assert.deepEqual(buildPortfolioSeries(null), []);
  });

  it("sums multiple accounts per day", () => {
    const s = buildPortfolioSeries([
      { snapshot_date: "2026-06-01", source: "investment", source_id: 1, balance: "100.00" },
      { snapshot_date: "2026-06-01", source: "linked", source_id: 9, balance: "50.00" },
    ]);
    assert.deepEqual(s, [{ date: "2026-06-01", value: 150 }]);
  });

  it("forward-fills an account that missed a day (no phantom dip)", () => {
    const s = buildPortfolioSeries([
      { snapshot_date: "2026-06-01", source: "investment", source_id: 1, balance: "100" },
      { snapshot_date: "2026-06-01", source: "investment", source_id: 2, balance: "200" },
      // account 1 missing on the 2nd — its 100 must carry forward
      { snapshot_date: "2026-06-02", source: "investment", source_id: 2, balance: "210" },
      { snapshot_date: "2026-06-03", source: "investment", source_id: 1, balance: "105" },
      { snapshot_date: "2026-06-03", source: "investment", source_id: 2, balance: "220" },
    ]);
    assert.deepEqual(s, [
      { date: "2026-06-01", value: 300 },
      { date: "2026-06-02", value: 310 },
      { date: "2026-06-03", value: 325 },
    ]);
  });

  it("a late-joining account starts contributing from its first snapshot only", () => {
    const s = buildPortfolioSeries([
      { snapshot_date: "2026-06-01", source: "investment", source_id: 1, balance: "100" },
      { snapshot_date: "2026-06-02", source: "investment", source_id: 1, balance: "100" },
      { snapshot_date: "2026-06-02", source: "linked", source_id: 5, balance: "1000" },
    ]);
    assert.deepEqual(s, [
      { date: "2026-06-01", value: 100 },
      { date: "2026-06-02", value: 1100 },
    ]);
  });

  it("does not collide accounts with the same id across sources", () => {
    const s = buildPortfolioSeries([
      { snapshot_date: "2026-06-01", source: "investment", source_id: 7, balance: "100" },
      { snapshot_date: "2026-06-01", source: "linked", source_id: 7, balance: "40" },
    ]);
    assert.deepEqual(s, [{ date: "2026-06-01", value: 140 }]);
  });
});

// ---------------------------------------------------------------------------
// GET /api/investments/performance-history (behavioral, mock pool)
// ---------------------------------------------------------------------------
describe("GET /api/investments/performance-history", () => {
  const supertest = require("supertest");
  const express = require("express");
  let dbModule, originalPoolQuery, app;
  let originalEnsure, originalGetSeries;

  before(() => {
    dbModule = require("../teller/services/database");
    originalPoolQuery = dbModule.pool.query;
    originalEnsure = benchmarks.ensureBenchmark;
    originalGetSeries = benchmarks.getBenchmarkSeries;
    app = express();
    app.use(require("../teller/routes/investments"));
  });

  afterEach(() => {
    dbModule.pool.query = originalPoolQuery;
    benchmarks.ensureBenchmark = originalEnsure;
    benchmarks.getBenchmarkSeries = originalGetSeries;
  });

  function stubSnapshots(rows) {
    dbModule.pool.query = async (sql, params) => {
      if (/FROM account_balance_snapshots/i.test(sql)) return { rows };
      return { rows: [] };
    };
  }

  it("returns the portfolio series with benchmark:null when the source is unavailable", async () => {
    stubSnapshots([
      { snapshot_date: "2026-05-01", source: "investment", source_id: 1, balance: "100" },
      { snapshot_date: "2026-06-01", source: "investment", source_id: 1, balance: "110" },
    ]);
    benchmarks.ensureBenchmark = async () => false;
    benchmarks.getBenchmarkSeries = async () => [];

    const res = await supertest(app).get("/api/investments/performance-history?months=6").expect(200);
    assert.equal(res.body.months, 6);
    assert.equal(res.body.portfolio.length, 2);
    assert.equal(res.body.benchmark, null);
    assert.equal(res.body.excess_return_pct, null);
    assert.ok(Math.abs(res.body.portfolio_return_pct - 10) < 1e-9, "+10% point-to-point");
  });

  it("computes benchmark + excess return over the portfolio's window", async () => {
    stubSnapshots([
      { snapshot_date: "2026-05-01", source: "investment", source_id: 1, balance: "100" },
      { snapshot_date: "2026-06-01", source: "investment", source_id: 1, balance: "110" },
    ]);
    benchmarks.ensureBenchmark = async () => true;
    benchmarks.getBenchmarkSeries = async () => [
      { date: "2026-04-20", close: 3900 },   // outside window — must be trimmed
      { date: "2026-05-01", close: 4000 },
      { date: "2026-06-01", close: 4200 },
    ];

    const res = await supertest(app).get("/api/investments/performance-history").expect(200);
    assert.equal(res.body.benchmark.series.length, 2, "benchmark trimmed to portfolio window");
    assert.ok(Math.abs(res.body.benchmark.return_pct - 5) < 1e-9, "+5% benchmark");
    assert.ok(Math.abs(res.body.excess_return_pct - 5) < 1e-9, "+10% − +5% = +5% excess");
  });

  it("clamps months to 3-60", async () => {
    stubSnapshots([]);
    benchmarks.ensureBenchmark = async () => false;
    benchmarks.getBenchmarkSeries = async () => [];
    const hi = await supertest(app).get("/api/investments/performance-history?months=999").expect(200);
    assert.equal(hi.body.months, 60);
    const lo = await supertest(app).get("/api/investments/performance-history?months=1").expect(200);
    assert.equal(lo.body.months, 3);
  });

  it("excludes Plaid phantom twins via the dedupe subquery (same direction as getNetWorth)", async () => {
    let captured;
    dbModule.pool.query = async (sql) => {
      if (/FROM account_balance_snapshots/i.test(sql)) { captured = sql; return { rows: [] }; }
      return { rows: [] };
    };
    benchmarks.ensureBenchmark = async () => false;
    benchmarks.getBenchmarkSeries = async () => [];
    await supertest(app).get("/api/investments/performance-history").expect(200);
    assert.match(captured, /NOT EXISTS/i, "linked rows must be deduped against investment_accounts");
    assert.match(captured, /ia\.plaid_account_id = la\.account_id/i);
    assert.match(captured, /is_active = true/i);
  });
});
