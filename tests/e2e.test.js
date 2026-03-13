// ============================================================================
// E2E-style tests using supertest with mock database
// ============================================================================
// Tests Express route modules by mounting them on a test Express app with
// a mock database pool. No real Postgres required.
// ============================================================================

const { describe, it, before, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const supertest = require("supertest");

// ---------------------------------------------------------------------------
// Mock database pool
// ---------------------------------------------------------------------------
function createMockPool(queryResults = {}) {
  const calls = [];
  const pool = {
    calls,
    query: async (sql, params) => {
      calls.push({ sql, params });
      for (const [key, result] of Object.entries(queryResults)) {
        if (sql.trim().toUpperCase().startsWith(key.toUpperCase())) {
          if (typeof result === "function") return result(sql, params);
          return result;
        }
      }
      return { rows: [], rowCount: 0 };
    },
    connect: async () => ({
      query: pool.query,
      release: () => {},
    }),
  };
  return pool;
}

// Override the database module before requiring routes
function setupMockDb(pool) {
  const dbModule = require("../teller/services/database");
  dbModule.pool.query = pool.query;
  dbModule.pool.connect = pool.connect;
}

// ---------------------------------------------------------------------------
// Helper to build a test app with JSON parsing and a router
// ---------------------------------------------------------------------------
function buildApp(router) {
  const app = express();
  app.use(express.json());
  app.use(router);
  return app;
}

// ---------------------------------------------------------------------------
// Goals API tests
// ---------------------------------------------------------------------------
describe("Goals API", () => {
  let app, pool;

  before(() => {
    pool = createMockPool({
      "SELECT": { rows: [
        { id: 1, name: "House Fund", type: "savings", target_amount: "400000",
          current_amount: "25000", monthly_contribution: "500", interest_rate: "7",
          target_date: null, notes: null, is_active: true }
      ] },
      "INSERT": { rows: [{ id: 2, name: "Car Fund" }] },
      "UPDATE": { rows: [{ id: 1, name: "House Fund", target_amount: "500000" }] },
      "DELETE": { rows: [], rowCount: 1 },
    });
    setupMockDb(pool);
    const goalsRouter = require("../teller/routes/goals");
    app = buildApp(goalsRouter);
  });

  it("GET /api/goals returns goals with computed fields", async () => {
    const res = await supertest(app).get("/api/goals").expect(200);
    assert.ok(Array.isArray(res.body));
    assert.equal(res.body[0].name, "House Fund");
    assert.ok("percent_complete" in res.body[0]);
    assert.ok("remaining" in res.body[0]);
  });

  it("POST /api/goals requires name and target_amount", async () => {
    await supertest(app)
      .post("/api/goals")
      .send({ name: "" })
      .expect(400);
  });

  it("POST /api/goals creates a goal", async () => {
    const res = await supertest(app)
      .post("/api/goals")
      .send({ name: "Car Fund", target_amount: 30000 })
      .expect(200);
    assert.ok(res.body.id);
  });

  it("PATCH /api/goals/:id rejects empty update", async () => {
    await supertest(app)
      .patch("/api/goals/1")
      .send({})
      .expect(400);
  });

  it("DELETE /api/goals/:id deletes", async () => {
    await supertest(app)
      .delete("/api/goals/1")
      .expect(200);
  });
});

// ---------------------------------------------------------------------------
// Budgets API tests
// ---------------------------------------------------------------------------
describe("Budgets API", () => {
  let app, pool;

  before(() => {
    pool = createMockPool({
      "SELECT": { rows: [
        { id: 1, category: "Food & Drink", monthly_limit: "500", is_ai_suggested: false, notes: null }
      ] },
      "INSERT": { rows: [{ id: 2, category: "Entertainment", monthly_limit: "200" }] },
      "UPDATE": { rows: [{ id: 1, monthly_limit: "600" }] },
      "DELETE": { rows: [], rowCount: 1 },
    });
    setupMockDb(pool);
    const budgetsRouter = require("../teller/routes/budgets");
    app = buildApp(budgetsRouter);
  });

  it("GET /api/budgets returns budgets with spending data", async () => {
    const res = await supertest(app).get("/api/budgets").expect(200);
    assert.ok(Array.isArray(res.body));
  });

  it("POST /api/budgets requires category and monthly_limit", async () => {
    await supertest(app)
      .post("/api/budgets")
      .send({ category: "" })
      .expect(400);
  });

  it("POST /api/budgets creates a budget", async () => {
    const res = await supertest(app)
      .post("/api/budgets")
      .send({ category: "Entertainment", monthly_limit: 200 })
      .expect(200);
    assert.ok(res.body.id);
  });

  it("POST /api/budgets/accept validates input", async () => {
    await supertest(app)
      .post("/api/budgets/accept")
      .send({ budgets: [] })
      .expect(400);
  });

  it("DELETE /api/budgets/:id works", async () => {
    await supertest(app)
      .delete("/api/budgets/1")
      .expect(200);
  });
});

// ---------------------------------------------------------------------------
// Categorize API tests
// ---------------------------------------------------------------------------
describe("Categorize API", () => {
  let app, pool;

  before(() => {
    pool = createMockPool({
      "SELECT COUNT": { rows: [{ uncategorized: "15" }] },
    });
    setupMockDb(pool);
    const catRouter = require("../teller/routes/categorize");
    app = buildApp(catRouter);
  });

  it("GET /api/categorize/status returns uncategorized count", async () => {
    const res = await supertest(app).get("/api/categorize/status").expect(200);
    assert.equal(res.body.uncategorized, 15);
    assert.ok("ai_available" in res.body);
  });

  it("POST /api/categorize returns 501 without API key", async () => {
    const origKey = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    await supertest(app).post("/api/categorize").expect(501);
    if (origKey) process.env.ANTHROPIC_API_KEY = origKey;
  });
});

// ---------------------------------------------------------------------------
// Forecast API tests
// ---------------------------------------------------------------------------
describe("Forecast API", () => {
  let app, pool;

  before(() => {
    const nextWeek = new Date(Date.now() + 7 * 86400000).toISOString().split("T")[0];
    pool = createMockPool({
      "SELECT": { rows: [
        { display_name: "Netflix", amount: "15.99", cadence_days: 30, next_expected: nextWeek, category: "streaming" },
        { display_name: "Spotify", amount: "9.99", cadence_days: 30, next_expected: nextWeek, category: "streaming" },
      ] },
    });
    setupMockDb(pool);
    const subsRouter = require("../teller/routes/subscriptions");
    app = buildApp(subsRouter);
  });

  it("GET /api/forecast returns predicted charges", async () => {
    const res = await supertest(app).get("/api/forecast?days=30").expect(200);
    assert.ok(res.body.charge_count >= 0);
    assert.ok("total_expected" in res.body);
    assert.ok(Array.isArray(res.body.charges));
  });
});

// ---------------------------------------------------------------------------
// Notifications API tests
// ---------------------------------------------------------------------------
describe("Notifications API", () => {
  let app;

  before(() => {
    const pool = createMockPool();
    setupMockDb(pool);
    const notifRouter = require("../teller/routes/notifications");
    app = buildApp(notifRouter);
  });

  it("GET /api/notifications/vapid returns 501 without VAPID keys", async () => {
    const origPub = process.env.VAPID_PUBLIC_KEY;
    const origPriv = process.env.VAPID_PRIVATE_KEY;
    delete process.env.VAPID_PUBLIC_KEY;
    delete process.env.VAPID_PRIVATE_KEY;
    await supertest(app).get("/api/notifications/vapid").expect(501);
    if (origPub) process.env.VAPID_PUBLIC_KEY = origPub;
    if (origPriv) process.env.VAPID_PRIVATE_KEY = origPriv;
  });

  it("POST /api/notifications/subscribe validates input", async () => {
    await supertest(app)
      .post("/api/notifications/subscribe")
      .send({})
      .expect(400);
  });
});

// ---------------------------------------------------------------------------
// Investment API tests
// ---------------------------------------------------------------------------
describe("Investment API", () => {
  let app;

  before(() => {
    const pool = createMockPool({
      "SELECT": { rows: [] },
    });
    setupMockDb(pool);
    const invRouter = require("../teller/routes/investments");
    app = buildApp(invRouter);
  });

  it("GET /api/plaid/status returns configuration status", async () => {
    const res = await supertest(app).get("/api/plaid/status").expect(200);
    assert.ok("configured" in res.body);
    assert.ok("environment" in res.body);
  });

  it("GET /api/plaid/holdings returns array", async () => {
    const res = await supertest(app).get("/api/plaid/holdings").expect(200);
    assert.ok(Array.isArray(res.body));
  });
});
