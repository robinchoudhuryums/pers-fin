// ============================================================================
// Integration tests for the S1/S3/S4 endpoints
// ============================================================================
// Pattern: monkey-patch the shared `pool` exported from services/database.js so
// the route modules pick up our stubbed query function, then exercise the
// routes via supertest. No real database; SQL is captured for assertion.
//
// These complement the source-pinned regression tests in audit-regressions —
// those check that the patterns/strings are present in source; these check
// runtime behavior under realistic inputs.

if (!process.env.NEON_DATABASE_URL) process.env.NEON_DATABASE_URL = "postgres://mock:mock@localhost/mock";

const { describe, it, before, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const supertest = require("supertest");

// Shared pool stub — each test rebinds .query/.connect before exercising.
let dbModule;

function loadRouter(routePath) {
  // Clear require cache so a re-import picks up freshly-stubbed dbModule.
  delete require.cache[require.resolve(routePath)];
  return require(routePath);
}

function makeApp(routePath) {
  const router = loadRouter(routePath);
  const app = express();
  app.use(express.json());
  app.use(router);
  return app;
}

before(() => {
  dbModule = require("../teller/services/database");
});

// ---------------------------------------------------------------------------
// PATCH /api/insights/:id/feedback (S1)
// ---------------------------------------------------------------------------
describe("PATCH /api/insights/:id/feedback", () => {
  let app, captured;

  beforeEach(() => {
    captured = { sql: null, params: null };
    dbModule.pool.query = async (sql, params) => {
      captured.sql = sql; captured.params = params;
      if (sql.includes("UPDATE financial_insights")) {
        return { rows: [{ id: 7, user_feedback: params[0], user_feedback_text: params[1], user_feedback_at: new Date() }] };
      }
      return { rows: [] };
    };
    app = makeApp("../teller/routes/insights");
  });

  it("rejects unknown feedback enum values", async () => {
    const res = await supertest(app)
      .patch("/api/insights/7/feedback")
      .send({ feedback: "lol" });
    assert.equal(res.status, 400);
  });

  it("accepts positive/negative/mixed and null", async () => {
    for (const fb of ["positive", "negative", "mixed", null]) {
      const res = await supertest(app)
        .patch("/api/insights/7/feedback")
        .send({ feedback: fb });
      assert.equal(res.status, 200, `feedback=${fb} should succeed`);
      assert.equal(res.body.user_feedback, fb,
        `response should echo feedback=${fb}`);
    }
  });

  it("accepts an optional correction note and truncates pathologically long ones", async () => {
    const longNote = "x".repeat(5000);
    await supertest(app)
      .patch("/api/insights/7/feedback")
      .send({ feedback: "negative", text: longNote })
      .expect(200);
    // params[1] is the note; should be clamped to <= 2000
    assert.ok(captured.params[1].length <= 2000,
      `note should be clamped (got ${captured.params[1].length})`);
  });

  it("rejects non-numeric ids without touching the DB", async () => {
    let called = false;
    dbModule.pool.query = async () => { called = true; return { rows: [] }; };
    const res = await supertest(app)
      .patch("/api/insights/abc/feedback")
      .send({ feedback: "positive" });
    assert.equal(res.status, 400);
    assert.equal(called, false, "DB should not be hit on invalid id");
  });
});

// ---------------------------------------------------------------------------
// GET /api/insights/feedback-summary (S1)
// ---------------------------------------------------------------------------
describe("GET /api/insights/feedback-summary", () => {
  it("returns zeroed counts when no feedback exists", async () => {
    dbModule.pool.query = async () => ({ rows: [] });
    const app = makeApp("../teller/routes/insights");
    const res = await supertest(app).get("/api/insights/feedback-summary").expect(200);
    assert.equal(res.body.positive, 0);
    assert.equal(res.body.negative, 0);
    assert.equal(res.body.mixed, 0);
    assert.equal(res.body.total, 0);
    assert.equal(res.body.window_days, 90);
  });

  it("aggregates counts by enum and respects the days query param", async () => {
    let capturedParams;
    dbModule.pool.query = async (sql, params) => {
      capturedParams = params;
      return { rows: [
        { user_feedback: "positive", cnt: "5" },
        { user_feedback: "negative", cnt: "2" },
        { user_feedback: "mixed", cnt: "1" },
      ]};
    };
    const app = makeApp("../teller/routes/insights");
    const res = await supertest(app).get("/api/insights/feedback-summary?days=30").expect(200);
    assert.equal(res.body.positive, 5);
    assert.equal(res.body.negative, 2);
    assert.equal(res.body.mixed, 1);
    assert.equal(res.body.total, 8);
    assert.equal(res.body.window_days, 30);
    assert.deepEqual(capturedParams, [30]);
  });

  it("clamps absurd days values", async () => {
    let capturedParams;
    dbModule.pool.query = async (sql, params) => { capturedParams = params; return { rows: [] }; };
    const app = makeApp("../teller/routes/insights");
    await supertest(app).get("/api/insights/feedback-summary?days=99999").expect(200);
    assert.ok(capturedParams[0] <= 365, "days should be clamped to <= 365");
  });
});

// ---------------------------------------------------------------------------
// GET /api/whats-new + POST /api/whats-new/seen (S3)
// ---------------------------------------------------------------------------
describe("/api/whats-new", () => {
  it("returns counts + arrays for all four sources", async () => {
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
    let callCount = 0;
    dbModule.pool.query = async (sql) => {
      callCount++;
      if (sql.includes("last_dashboard_view_at")) {
        return { rows: [{ last_dashboard_view_at: since }] };
      }
      if (sql.includes("transactions")) {
        return { rows: [{ transaction_id: "t1", merchant: "Coffee", amount: "5.00", date: "2026-05-15", category: "Food", account_name: "Chase" }] };
      }
      if (sql.includes("detected_subscriptions")) {
        return { rows: [{ id: 1, display_name: "Netflix", amount: "15.99", cadence_days: 30, category: "subscription", first_seen: "2026-05-01" }] };
      }
      if (sql.includes("notification_log")) {
        return { rows: [{ id: 1, type: "anomaly", title: "Big charge", body: "$200", data: {}, is_read: false, created_at: new Date() }] };
      }
      if (sql.includes("baselines")) {
        return { rows: [{ source: "linked", source_id: 1, baseline_balance: "1000.00", current_balance: "1250.00", delta: "250.00", account_name: "Savings" }] };
      }
      return { rows: [] };
    };

    const app = makeApp("../teller/routes/whats-new");
    const res = await supertest(app).get("/api/whats-new").expect(200);
    assert.equal(res.body.counts.transactions, 1);
    assert.equal(res.body.counts.subscriptions, 1);
    assert.equal(res.body.counts.notifications, 1);
    assert.equal(res.body.counts.balance_changes, 1);
    assert.equal(res.body.balance_changes[0].delta, 250);
    assert.equal(res.body.balance_changes[0].account_name, "Savings");
    assert.ok(res.body.since, "should include `since` ISO timestamp");
  });

  it("falls back to a 24h lookback when no watermark stored", async () => {
    let watermarkUsed;
    dbModule.pool.query = async (sql, params) => {
      if (sql.includes("last_dashboard_view_at") && !sql.includes("UPDATE")) {
        return { rows: [{ last_dashboard_view_at: null }] };
      }
      if (params && params[0] instanceof Date) {
        watermarkUsed = params[0];
      }
      return { rows: [] };
    };
    const app = makeApp("../teller/routes/whats-new");
    await supertest(app).get("/api/whats-new").expect(200);
    const ageMs = Date.now() - watermarkUsed.getTime();
    // Should be ~24h (allow 1 min skew for test execution).
    assert.ok(Math.abs(ageMs - 24 * 60 * 60 * 1000) < 60 * 1000,
      `fallback should be ~24h ago, got ${ageMs}ms ago`);
  });

  it("POST /seen advances the watermark idempotently", async () => {
    let updateCalled = 0;
    dbModule.pool.query = async (sql) => {
      if (sql.includes("UPDATE") && sql.includes("last_dashboard_view_at")) {
        updateCalled++;
      }
      return { rows: [] };
    };
    const app = makeApp("../teller/routes/whats-new");
    await supertest(app).post("/api/whats-new/seen").expect(200);
    await supertest(app).post("/api/whats-new/seen").expect(200);
    assert.equal(updateCalled, 2, "both calls should UPDATE; SQL is idempotent at the DB layer");
  });
});

// ---------------------------------------------------------------------------
// GET /api/investments/performance (S4 + #8 target allocation)
// ---------------------------------------------------------------------------
describe("/api/investments/performance", () => {
  it("returns zeroed totals when no holdings exist", async () => {
    dbModule.pool.query = async (sql) => {
      if (sql.includes("target_allocation_pct")) return { rows: [{ target_allocation_pct: {} }] };
      return { rows: [] };
    };
    const app = makeApp("../teller/routes/investments");
    const res = await supertest(app).get("/api/investments/performance").expect(200);
    assert.equal(res.body.holdings_count, 0);
    assert.equal(res.body.total_value, 0);
    assert.equal(res.body.total_return, 0);
    assert.equal(res.body.total_return_pct, null);
    assert.deepEqual(res.body.by_asset_class, []);
  });

  it("aggregates returns + asset-class breakdown", async () => {
    dbModule.pool.query = async (sql) => {
      if (sql.includes("target_allocation_pct")) return { rows: [{ target_allocation_pct: {} }] };
      return { rows: [
        { name: "Vanguard 500", ticker: "VOO", quantity: "10", cost_basis: "3000", current_value: "4000", security_type: "etf", plaid_account_id: "p1", account_name: "Brokerage" },
        { name: "Apple", ticker: "AAPL", quantity: "5", cost_basis: "500", current_value: "750", security_type: "equity", plaid_account_id: "p1", account_name: "Brokerage" },
        { name: "Treasury 10Y", ticker: null, quantity: "20", cost_basis: "1000", current_value: "950", security_type: "bond", plaid_account_id: "p1", account_name: "Brokerage" },
      ]};
    };
    const app = makeApp("../teller/routes/investments");
    const res = await supertest(app).get("/api/investments/performance").expect(200);
    assert.equal(res.body.holdings_count, 3);
    assert.equal(res.body.accounts_count, 1);
    assert.equal(res.body.total_value, 5700);
    assert.equal(res.body.total_cost_basis, 4500);
    assert.equal(res.body.total_return, 1200);
    // 1200/4500 ≈ 26.67%
    assert.ok(Math.abs(res.body.total_return_pct - 26.667) < 0.1);
    // 3 distinct asset classes, sorted by value DESC
    assert.equal(res.body.by_asset_class.length, 3);
    assert.equal(res.body.by_asset_class[0].security_type, "etf");
    // Top winners ordered by return_pct DESC: equity (+50%) > etf (~33%) > bond (-5%)
    assert.equal(res.body.top_winners[0].ticker, "AAPL");
    assert.equal(res.body.top_losers[0].name, "Treasury 10Y");
  });

  it("attaches target_pct + drift_pct when user has configured targets (#8)", async () => {
    dbModule.pool.query = async (sql) => {
      if (sql.includes("target_allocation_pct")) {
        return { rows: [{ target_allocation_pct: { equity: 70, etf: 20, bond: 10 } }] };
      }
      return { rows: [
        { name: "ETF", ticker: "VOO", quantity: 1, cost_basis: 100, current_value: 600, security_type: "etf", plaid_account_id: "p1", account_name: "B" },
        { name: "Stock", ticker: "AAPL", quantity: 1, cost_basis: 100, current_value: 400, security_type: "equity", plaid_account_id: "p1", account_name: "B" },
      ]};
    };
    const app = makeApp("../teller/routes/investments");
    const res = await supertest(app).get("/api/investments/performance").expect(200);
    // total = 1000, etf = 60%, equity = 40%, bond = 0% (configured but absent)
    const etf = res.body.by_asset_class.find(c => c.security_type === "etf");
    const equity = res.body.by_asset_class.find(c => c.security_type === "equity");
    const bond = res.body.by_asset_class.find(c => c.security_type === "bond");
    assert.equal(etf.target_pct, 20);
    assert.ok(Math.abs(etf.drift_pct - 40) < 0.1, "etf should be +40 drift");
    assert.equal(equity.target_pct, 70);
    assert.ok(Math.abs(equity.drift_pct - (-30)) < 0.1, "equity should be -30 drift");
    assert.ok(bond, "bond should appear in by_asset_class even with zero holdings");
    assert.equal(bond.target_pct, 10);
    assert.equal(bond.drift_pct, -10);
    assert.equal(bond.value, 0);
  });

  it("omits drift fields when no targets configured", async () => {
    dbModule.pool.query = async (sql) => {
      if (sql.includes("target_allocation_pct")) return { rows: [{ target_allocation_pct: {} }] };
      return { rows: [
        { name: "ETF", ticker: "VOO", quantity: 1, cost_basis: 100, current_value: 200, security_type: "etf", plaid_account_id: "p1", account_name: "B" },
      ]};
    };
    const app = makeApp("../teller/routes/investments");
    const res = await supertest(app).get("/api/investments/performance").expect(200);
    assert.equal(res.body.by_asset_class[0].target_pct, undefined,
      "target_pct should be absent when no targets configured");
    assert.equal(res.body.by_asset_class[0].drift_pct, undefined,
      "drift_pct should be absent when no targets configured");
  });
});
