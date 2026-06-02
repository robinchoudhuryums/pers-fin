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

const { describe, it, before, after, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const supertest = require("supertest");

// Shared pool stub — each test rebinds .query/.connect before exercising.
// The original `pool.query` is restored in afterEach so test files that
// load this file's modules concurrently (node:test runs files in parallel
// worker threads by default — each file gets its own module cache — but
// belt-and-suspenders) don't leak stubs into each other's runs.
let dbModule;
let originalPoolQuery;

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

afterEach(() => {
  // Restore the singleton's query after every test so nothing leaks into
  // a sibling test (or — under parallel execution — a sibling file that
  // happens to share the same module-cache scope).
  if (dbModule && originalPoolQuery) {
    dbModule.pool.query = originalPoolQuery;
  }
});

before(() => {
  dbModule = require("../teller/services/database");
  originalPoolQuery = dbModule.pool.query;
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
// GET /api/insights/trust-overview (follow-on combo endpoint)
// ---------------------------------------------------------------------------
describe("GET /api/insights/trust-overview", () => {
  it("merges audit accuracy + feedback counts into one payload", async () => {
    dbModule.pool.query = async (sql) => {
      if (sql.includes("financial_insights") && sql.includes("user_feedback")) {
        return { rows: [
          { user_feedback: "positive", cnt: "8" },
          { user_feedback: "negative", cnt: "2" },
        ]};
      }
      if (sql.includes("ai_audit_log")) {
        // getAuditAccuracy queries audit log + insights inside the helper —
        // returning empty rows is enough to drive it to the zero-state path.
        return { rows: [] };
      }
      return { rows: [] };
    };
    const app = makeApp("../teller/routes/insights");
    const res = await supertest(app).get("/api/insights/trust-overview").expect(200);
    assert.equal(res.body.window_days, 90);
    assert.ok(res.body.audit_accuracy);
    assert.equal(res.body.user_feedback.positive, 8);
    assert.equal(res.body.user_feedback.negative, 2);
    assert.equal(res.body.user_feedback.total, 10);
  });

  it("honors ?days query and clamps absurd values", async () => {
    let capturedDays;
    dbModule.pool.query = async (sql, params) => {
      if (sql.includes("user_feedback") && Array.isArray(params)) {
        capturedDays = params[0];
      }
      return { rows: [] };
    };
    const app = makeApp("../teller/routes/insights");
    await supertest(app).get("/api/insights/trust-overview?days=99999").expect(200);
    assert.ok(capturedDays <= 365, `days should be clamped (got ${capturedDays})`);
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

// ---------------------------------------------------------------------------
// GET/POST/DELETE /api/credit-scores
// ---------------------------------------------------------------------------
describe("/api/credit-scores", () => {
  it("POST rejects scores outside 300-850 range", async () => {
    dbModule.pool.query = async () => ({ rows: [] });
    const app = makeApp("../teller/routes/credit-scores");
    await supertest(app).post("/api/credit-scores")
      .send({ score: 200 }).expect(400);
    await supertest(app).post("/api/credit-scores")
      .send({ score: 900 }).expect(400);
    await supertest(app).post("/api/credit-scores")
      .send({ score: "abc" }).expect(400);
  });

  it("POST accepts valid score and passes correct params to DB", async () => {
    let capturedParams;
    dbModule.pool.query = async (sql, params) => {
      capturedParams = params;
      return { rows: [{ id: 1, score: params[0], score_type: params[1], source: params[2], checked_at: "2026-05-27" }] };
    };
    const app = makeApp("../teller/routes/credit-scores");
    const res = await supertest(app).post("/api/credit-scores")
      .send({ score: 745, score_type: "fico", source: "Chase", notes: "monthly check" })
      .expect(200);
    assert.equal(res.body.score, 745);
    assert.equal(capturedParams[0], 745);
    assert.equal(capturedParams[1], "fico");
    assert.equal(capturedParams[2], "Chase");
  });

  it("POST defaults to vantagescore when score_type is omitted", async () => {
    let capturedParams;
    dbModule.pool.query = async (sql, params) => {
      capturedParams = params;
      return { rows: [{ id: 1, score: params[0], score_type: params[1] }] };
    };
    const app = makeApp("../teller/routes/credit-scores");
    await supertest(app).post("/api/credit-scores")
      .send({ score: 720 }).expect(200);
    assert.equal(capturedParams[1], "vantagescore");
  });

  it("GET returns scores + trend with delta computations", async () => {
    dbModule.pool.query = async () => ({
      rows: [
        { id: 3, score: 760, score_type: "vantagescore", source: "Discover", checked_at: "2026-05-15", created_at: new Date() },
        { id: 2, score: 745, score_type: "vantagescore", source: "Discover", checked_at: "2026-04-15", created_at: new Date() },
        { id: 1, score: 730, score_type: "vantagescore", source: "Discover", checked_at: "2025-11-15", created_at: new Date() },
      ],
    });
    const app = makeApp("../teller/routes/credit-scores");
    const res = await supertest(app).get("/api/credit-scores").expect(200);
    assert.equal(res.body.scores.length, 3);
    assert.equal(res.body.trend.current, 760);
    assert.equal(res.body.trend.delta_vs_prior, 15);
    assert.equal(res.body.trend.six_month_ago, 730);
    assert.equal(res.body.trend.delta_vs_6mo, 30);
  });

  it("DELETE returns 404 for non-existent id", async () => {
    dbModule.pool.query = async () => ({ rows: [] });
    const app = makeApp("../teller/routes/credit-scores");
    await supertest(app).delete("/api/credit-scores/999").expect(404);
  });
});

// ---------------------------------------------------------------------------
// GET/POST/PATCH/DELETE /api/watchlist
// ---------------------------------------------------------------------------
describe("/api/watchlist", () => {
  it("POST rejects invalid type enum", async () => {
    dbModule.pool.query = async () => ({ rows: [] });
    const app = makeApp("../teller/routes/watchlist");
    await supertest(app).post("/api/watchlist")
      .send({ type: "invalid", value: "test" }).expect(400);
  });

  it("POST accepts valid merchant/category/keyword types", async () => {
    let capturedParams;
    dbModule.pool.query = async (sql, params) => {
      capturedParams = params;
      return { rows: [{ id: 1, type: params[0], value: params[1], is_active: true }] };
    };
    const app = makeApp("../teller/routes/watchlist");
    for (const type of ["merchant", "category", "keyword"]) {
      const res = await supertest(app).post("/api/watchlist")
        .send({ type, value: "Test Value" }).expect(200);
      assert.equal(res.body.type, type);
    }
  });

  it("POST rejects empty value", async () => {
    dbModule.pool.query = async () => ({ rows: [] });
    const app = makeApp("../teller/routes/watchlist");
    await supertest(app).post("/api/watchlist")
      .send({ type: "merchant", value: "   " }).expect(400);
  });

  it("PATCH toggles is_active", async () => {
    let capturedSql;
    dbModule.pool.query = async (sql, params) => {
      capturedSql = sql;
      return { rows: [{ id: 1, is_active: params[0] }] };
    };
    const app = makeApp("../teller/routes/watchlist");
    const res = await supertest(app).patch("/api/watchlist/1")
      .send({ is_active: false }).expect(200);
    assert.equal(res.body.is_active, false);
    assert.ok(capturedSql.includes("is_active"));
  });

  it("DELETE returns 404 for non-existent id", async () => {
    dbModule.pool.query = async () => ({ rows: [] });
    const app = makeApp("../teller/routes/watchlist");
    await supertest(app).delete("/api/watchlist/999").expect(404);
  });
});

// ---------------------------------------------------------------------------
// Plaid transaction endpoints (surface-level — can't mock Plaid SDK itself)
// ---------------------------------------------------------------------------
describe("Plaid transaction endpoints", () => {
  it("POST /api/plaid/exchange-transactions rejects missing public_token", async () => {
    dbModule.pool.query = async () => ({ rows: [] });
    const app = makeApp("../teller/routes/investments");
    const res = await supertest(app).post("/api/plaid/exchange-transactions")
      .send({}).expect(400);
    assert.ok(res.body.error.includes("public_token"));
  });

  it("POST /api/plaid/link-token-transactions returns 501 when Plaid not configured", async () => {
    dbModule.pool.query = async () => ({ rows: [] });
    const app = makeApp("../teller/routes/investments");
    const res = await supertest(app).post("/api/plaid/link-token-transactions");
    assert.ok([501, 500].includes(res.status),
      "Should return 501 or 500 when Plaid env vars not set");
  });

  it("POST /api/plaid/sync-transactions returns error when Plaid not configured", async () => {
    dbModule.pool.query = async () => ({ rows: [] });
    const app = makeApp("../teller/routes/investments");
    const res = await supertest(app).post("/api/plaid/sync-transactions");
    assert.ok([501, 500].includes(res.status));
  });

  it("GET /api/plaid/status reports configured state", async () => {
    const app = makeApp("../teller/routes/investments");
    const res = await supertest(app).get("/api/plaid/status").expect(200);
    assert.equal(typeof res.body.configured, "boolean");
    assert.equal(typeof res.body.environment, "string");
  });
});

// ---------------------------------------------------------------------------
// Idle-gate (touchActivity export)
// ---------------------------------------------------------------------------
describe("Idle-gate utility", () => {
  it("touchActivity is exported and callable", () => {
    const startup = require("../teller/startup");
    assert.equal(typeof startup.touchActivity, "function");
    startup.touchActivity(); // should not throw
  });
});

// ---------------------------------------------------------------------------
// gatherWhatsNew shared aggregator (used by both HTTP route and daily digest)
// ---------------------------------------------------------------------------
describe("gatherWhatsNew shared aggregator", () => {
  it("returns structured data with counts + arrays on empty DB", async () => {
    dbModule.pool.query = async () => ({ rows: [] });
    delete require.cache[require.resolve("../teller/routes/whats-new")];
    const whatsNew = require("../teller/routes/whats-new");
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const result = await whatsNew.gatherWhatsNew(since);
    assert.ok(result.since, "should include since ISO timestamp");
    assert.ok(result.counts, "should include counts object");
    assert.equal(result.counts.transactions, 0);
    assert.equal(result.counts.subscriptions, 0);
    assert.equal(result.counts.notifications, 0);
    assert.equal(result.counts.balance_changes, 0);
    assert.ok(Array.isArray(result.transactions));
    assert.ok(Array.isArray(result.balance_changes));
  });

  it("populates counts from DB rows", async () => {
    dbModule.pool.query = async (sql) => {
      if (sql.includes("transactions") && !sql.includes("baselines")) {
        return { rows: [{ transaction_id: "t1", merchant: "X", amount: "5.00", date: "2026-05-27", category: "Food", account_name: "A" }] };
      }
      if (sql.includes("detected_subscriptions")) {
        return { rows: [{ id: 1, display_name: "Netflix", amount: "15.99", cadence_days: 30, category: "sub", first_seen: "2026-01-01" }] };
      }
      return { rows: [] };
    };
    delete require.cache[require.resolve("../teller/routes/whats-new")];
    const whatsNew = require("../teller/routes/whats-new");
    const result = await whatsNew.gatherWhatsNew(new Date(Date.now() - 86400000));
    assert.equal(result.counts.transactions, 1);
    assert.equal(result.counts.subscriptions, 1);
    assert.equal(result.transactions[0].merchant, "X");
  });
});

// ---------------------------------------------------------------------------
// GET /api/shared-settlement
// ---------------------------------------------------------------------------
describe("GET /api/shared-settlement", () => {
  let app;

  beforeEach(() => {
    dbModule.pool.query = async (sql, params) => {
      // partner_name lookup
      if (sql.includes("partner_name") && sql.includes("user_settings")) {
        return { rows: [{ partner_name: "Sarah" }] };
      }
      // settlement aggregate
      if (sql.includes("FILTER (WHERE t.personal_for IS NULL)")) {
        return {
          rows: [
            {
              account_id: 7,
              account_name: "Capital One Quicksilver",
              split_pct: 50,
              txn_count: 50,
              total_charges: "2400.00",
              shared_total: "2000.00",
              shared_count: 45,
              your_personal_total: "200.00",
              your_personal_count: 3,
              partner_personal_total: "200.00",
              partner_personal_count: 2,
            },
          ],
        };
      }
      return { rows: [] };
    };
    app = makeApp("../teller/routes/subscriptions");
  });

  it("returns split math for a shared account (50/50 + personals)", async () => {
    const res = await supertest(app).get("/api/shared-settlement?month=2026-05").expect(200);
    assert.equal(res.body.month, "2026-05");
    assert.equal(res.body.partner_name, "Sarah");
    assert.equal(res.body.accounts.length, 1);
    const a = res.body.accounts[0];
    // 50% of $2000 shared + $200 personal = $1200
    assert.equal(a.your_share, 1200);
    assert.equal(a.partner_share, 1200);
    assert.equal(a.total_charges, 2400);
  });

  it("defaults to current month when query string omitted", async () => {
    const res = await supertest(app).get("/api/shared-settlement").expect(200);
    assert.match(res.body.month, /^\d{4}-(0[1-9]|1[0-2])$/);
  });

  it("rejects malformed month and falls back to current", async () => {
    const res = await supertest(app).get("/api/shared-settlement?month=2026-13").expect(200);
    // Falls back to current month silently — the regex guards against SQL injection
    assert.match(res.body.month, /^\d{4}-(0[1-9]|1[0-2])$/);
    assert.notEqual(res.body.month, "2026-13");
  });
});

describe("PATCH /api/transactions/:id accepts personal_for", () => {
  let app, captured;

  beforeEach(() => {
    captured = null;
    dbModule.pool.query = async (sql, params) => {
      captured = { sql, params };
      return { rows: [{ transaction_id: "t1", personal_for: params[0] }] };
    };
    app = makeApp("../teller/routes/subscriptions");
  });

  it("writes 'self' through", async () => {
    await supertest(app).patch("/api/transactions/t1")
      .send({ personal_for: "self" }).expect(200);
    assert.match(captured.sql, /personal_for = \$1/);
    assert.equal(captured.params[0], "self");
  });

  it("writes 'partner' through", async () => {
    await supertest(app).patch("/api/transactions/t1")
      .send({ personal_for: "partner" }).expect(200);
    assert.equal(captured.params[0], "partner");
  });

  it("clears the override on null / empty / 'shared'", async () => {
    await supertest(app).patch("/api/transactions/t1")
      .send({ personal_for: null }).expect(200);
    assert.equal(captured.params[0], null);
    await supertest(app).patch("/api/transactions/t1")
      .send({ personal_for: "" }).expect(200);
    assert.equal(captured.params[0], null);
    await supertest(app).patch("/api/transactions/t1")
      .send({ personal_for: "shared" }).expect(200);
    assert.equal(captured.params[0], null);
  });

  it("rejects garbage values by storing null (not the bad string)", async () => {
    await supertest(app).patch("/api/transactions/t1")
      .send({ personal_for: "DROP TABLE transactions" }).expect(200);
    assert.equal(captured.params[0], null);
  });
});
