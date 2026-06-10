// ============================================================================
// New feature tests — categorization rules, manual bills, bill payments,
// budget snapshots/rollover, notification log
// ============================================================================

if (!process.env.NEON_DATABASE_URL) process.env.NEON_DATABASE_URL = "postgres://mock:mock@localhost/mock";
if (!process.env.TOKEN_ENCRYPTION_PASSPHRASE) process.env.TOKEN_ENCRYPTION_PASSPHRASE = "test-passphrase";

const { describe, it, before } = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const supertest = require("supertest");

// ---------------------------------------------------------------------------
// Mock database pool (same pattern as e2e.test.js)
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

function setupMockDb(pool) {
  const dbModule = require("../teller/services/database");
  dbModule.pool.query = pool.query;
  dbModule.pool.connect = pool.connect;
}

function buildApp(router) {
  const app = express();
  app.use(express.json());
  app.use(router);
  return app;
}

// ---------------------------------------------------------------------------
// Categorization Rules API
// ---------------------------------------------------------------------------
describe("Categorization Rules API", () => {
  let app, pool;

  before(() => {
    pool = createMockPool({
      "SELECT": (sql) => {
        if (sql.includes("categorization_rules")) {
          return { rows: [
            { id: 1, merchant_pattern: "Amazon", category: "Shopping", match_type: "contains", is_active: true, times_applied: 5 },
          ] };
        }
        if (sql.includes("uncategorized") || sql.includes("COUNT")) {
          return { rows: [{ uncategorized: "10" }] };
        }
        if (sql.includes("COALESCE(user_merchant_name")) {
          return { rows: [{ merchant: "Amazon.com" }] };
        }
        return { rows: [] };
      },
      "INSERT": { rows: [{ id: 2, merchant_pattern: "Netflix", category: "Entertainment", match_type: "contains", is_active: true, times_applied: 0 }] },
      "DELETE": { rows: [], rowCount: 1 },
      "UPDATE": { rows: [], rowCount: 3 },
    });
    setupMockDb(pool);
    // Clear require cache to pick up fresh mock
    const catPath = require.resolve("../teller/routes/categorize");
    delete require.cache[catPath];
    const catRouter = require("../teller/routes/categorize");
    app = buildApp(catRouter);
  });

  it("GET /api/categorization-rules returns rules list", async () => {
    const res = await supertest(app).get("/api/categorization-rules").expect(200);
    assert.ok(Array.isArray(res.body));
    assert.equal(res.body[0].merchant_pattern, "Amazon");
  });

  it("POST /api/categorization-rules requires merchant_pattern and category", async () => {
    await supertest(app)
      .post("/api/categorization-rules")
      .send({ merchant_pattern: "" })
      .expect(400);
  });

  it("POST /api/categorization-rules rejects invalid category", async () => {
    await supertest(app)
      .post("/api/categorization-rules")
      .send({ merchant_pattern: "Netflix", category: "InvalidCat" })
      .expect(400);
  });

  it("POST /api/categorization-rules creates a rule with valid input", async () => {
    const res = await supertest(app)
      .post("/api/categorization-rules")
      .send({ merchant_pattern: "Netflix", category: "Entertainment", match_type: "contains" })
      .expect(200);
    assert.ok(res.body.id);
    assert.equal(res.body.category, "Entertainment");
  });

  it("DELETE /api/categorization-rules/:id deletes a rule", async () => {
    await supertest(app).delete("/api/categorization-rules/1").expect(200);
  });

  it("POST /api/categorization-rules/apply applies rules and returns count", async () => {
    const res = await supertest(app)
      .post("/api/categorization-rules/apply")
      .expect(200);
    assert.ok("applied" in res.body);
  });

  it("POST /api/categorization-rules/from-transaction requires transaction_id and category", async () => {
    await supertest(app)
      .post("/api/categorization-rules/from-transaction")
      .send({ transaction_id: "" })
      .expect(400);
  });

  it("POST /api/categorization-rules/from-transaction creates rule from valid transaction", async () => {
    const res = await supertest(app)
      .post("/api/categorization-rules/from-transaction")
      .send({ transaction_id: "txn_123", category: "Shopping" })
      .expect(200);
    assert.ok(res.body.id);
  });
});

// ---------------------------------------------------------------------------
// Manual Bills API
// ---------------------------------------------------------------------------
describe("Manual Bills API", () => {
  let app, pool;

  before(() => {
    pool = createMockPool({
      "SELECT": { rows: [
        { id: 1, name: "Rent", amount: "1500.00", due_day: 1, cadence: "monthly", category: "housing", is_active: true },
      ] },
      "INSERT": { rows: [{ id: 2, name: "Internet", amount: "79.99", due_day: 15, cadence: "monthly", category: "utility", is_active: true }] },
      "UPDATE": { rows: [{ id: 1, name: "Rent", amount: "1550.00" }] },
      "DELETE": { rows: [], rowCount: 1 },
    });
    setupMockDb(pool);
    const subsPath = require.resolve("../teller/routes/subscriptions");
    delete require.cache[subsPath];
    const subsRouter = require("../teller/routes/subscriptions");
    app = buildApp(subsRouter);
  });

  it("GET /api/manual-bills returns active bills", async () => {
    const res = await supertest(app).get("/api/manual-bills").expect(200);
    assert.ok(Array.isArray(res.body));
    assert.equal(res.body[0].name, "Rent");
  });

  it("POST /api/manual-bills requires name, amount, and due_day", async () => {
    await supertest(app)
      .post("/api/manual-bills")
      .send({ name: "Rent" })
      .expect(400);
  });

  it("POST /api/manual-bills rejects invalid due_day", async () => {
    await supertest(app)
      .post("/api/manual-bills")
      .send({ name: "Rent", amount: 1500, due_day: 32 })
      .expect(400);
  });

  it("POST /api/manual-bills rejects non-positive amount", async () => {
    await supertest(app)
      .post("/api/manual-bills")
      .send({ name: "Rent", amount: -5, due_day: 1 })
      .expect(400);
  });

  it("POST /api/manual-bills creates a bill with valid input", async () => {
    const res = await supertest(app)
      .post("/api/manual-bills")
      .send({ name: "Internet", amount: 79.99, due_day: 15, cadence: "monthly", category: "utility" })
      .expect(200);
    assert.ok(res.body.id);
    assert.equal(res.body.name, "Internet");
  });

  it("DELETE /api/manual-bills/:id deletes a bill", async () => {
    await supertest(app).delete("/api/manual-bills/1").expect(200);
  });
});

// ---------------------------------------------------------------------------
// Bill Payments API
// ---------------------------------------------------------------------------
describe("Bill Payments API", () => {
  let app, pool;

  before(() => {
    pool = createMockPool({
      "SELECT": { rows: [
        { id: 1, bill_source: "manual", bill_id: 1, paid_date: "2026-04-01", paid_amount: "1500.00" },
      ] },
      "INSERT": { rows: [{ id: 2, bill_source: "subscription", bill_id: 5, paid_date: "2026-04-15" }] },
      "DELETE": { rows: [], rowCount: 1 },
    });
    setupMockDb(pool);
    const subsPath = require.resolve("../teller/routes/subscriptions");
    delete require.cache[subsPath];
    const subsRouter = require("../teller/routes/subscriptions");
    app = buildApp(subsRouter);
  });

  it("POST /api/bill-payments requires bill_source, bill_id, and paid_date", async () => {
    await supertest(app)
      .post("/api/bill-payments")
      .send({ bill_source: "manual" })
      .expect(400);
  });

  it("POST /api/bill-payments rejects invalid bill_source", async () => {
    await supertest(app)
      .post("/api/bill-payments")
      .send({ bill_source: "invalid", bill_id: 1, paid_date: "2026-04-01" })
      .expect(400);
  });

  it("POST /api/bill-payments marks a bill as paid", async () => {
    const res = await supertest(app)
      .post("/api/bill-payments")
      .send({ bill_source: "subscription", bill_id: 5, paid_date: "2026-04-15" })
      .expect(200);
    assert.ok(res.body.id);
  });

  it("GET /api/bill-payments returns payments for a month", async () => {
    const res = await supertest(app)
      .get("/api/bill-payments?year=2026&month=4")
      .expect(200);
    assert.ok(Array.isArray(res.body));
  });

  it("DELETE /api/bill-payments/:id unmarks a payment", async () => {
    await supertest(app).delete("/api/bill-payments/1").expect(200);
  });
});

// ---------------------------------------------------------------------------
// Budget Snapshots & Rollover API
// ---------------------------------------------------------------------------
describe("Budget Snapshots API", () => {
  let app, pool;

  before(() => {
    pool = createMockPool({
      "SELECT": (sql) => {
        if (sql.includes("budget_snapshots")) {
          return { rows: [{ id: 1, budget_id: 1, month: "2026-03", monthly_limit: "500", spent: "400", rollover_amount: "100", category: "Food & Drink" }] };
        }
        return { rows: [
          { id: 1, category: "Food & Drink", monthly_limit: "500", rollover_enabled: true, budget_type: "recurring",
            effective_month: null, is_ai_suggested: false, notes: null },
        ] };
      },
      "INSERT": (sql) => {
        if (sql.includes("budget_snapshots")) {
          return { rows: [{ id: 1 }], rowCount: 1 };
        }
        return { rows: [{ id: 2, category: "Entertainment", monthly_limit: "200", rollover_enabled: false, budget_type: "one_time", effective_month: "2026-04" }] };
      },
      "UPDATE": { rows: [{ id: 1 }] },
      "DELETE": { rows: [], rowCount: 1 },
    });
    setupMockDb(pool);
    const budgetPath = require.resolve("../teller/routes/budgets");
    delete require.cache[budgetPath];
    const budgetRouter = require("../teller/routes/budgets");
    app = buildApp(budgetRouter);
  });

  it("POST /api/budgets with rollover_enabled and budget_type", async () => {
    const res = await supertest(app)
      .post("/api/budgets")
      .send({ category: "Entertainment", monthly_limit: 200, rollover_enabled: false, budget_type: "one_time", effective_month: "2026-04" })
      .expect(200);
    assert.ok(res.body.id);
  });

  it("POST /api/budgets/snapshot creates snapshots and returns count", async () => {
    const res = await supertest(app)
      .post("/api/budgets/snapshot")
      .send({ month: "2026-03" })
      .expect(200);
    assert.ok("snapshots_created" in res.body);
    assert.equal(res.body.month, "2026-03");
  });

  it("GET /api/budgets/history returns snapshot data", async () => {
    const res = await supertest(app)
      .get("/api/budgets/history?months=6")
      .expect(200);
    assert.ok(Array.isArray(res.body));
  });

  it("GET /api/budgets accepts ?month query parameter", async () => {
    const res = await supertest(app)
      .get("/api/budgets?month=2026-03")
      .expect(200);
    assert.ok(Array.isArray(res.body));
  });
});

// ---------------------------------------------------------------------------
// Notification Log API
// ---------------------------------------------------------------------------
describe("Notification Log API", () => {
  let app, pool;

  before(() => {
    pool = createMockPool({
      "SELECT": (sql) => {
        if (sql.includes("COUNT")) {
          return { rows: [{ count: "3" }] };
        }
        return { rows: [
          { id: 1, type: "anomaly", title: "Unusual charge", body: "Amazon: $500", is_read: false, created_at: "2026-04-15T10:00:00Z" },
          { id: 2, type: "budget", title: "Budget warning", body: "Food & Drink at 85%", is_read: true, created_at: "2026-04-14T10:00:00Z" },
        ] };
      },
      "UPDATE": { rows: [], rowCount: 1 },
    });
    setupMockDb(pool);
    const notifPath = require.resolve("../teller/routes/notifications");
    delete require.cache[notifPath];
    const notifRouter = require("../teller/routes/notifications");
    app = buildApp(notifRouter);
  });

  it("GET /api/notifications returns notifications with unread count", async () => {
    const res = await supertest(app).get("/api/notifications").expect(200);
    assert.ok("notifications" in res.body);
    assert.ok("unread_count" in res.body);
    assert.ok(Array.isArray(res.body.notifications));
    assert.equal(res.body.unread_count, 3);
  });

  it("GET /api/notifications respects limit param", async () => {
    const res = await supertest(app).get("/api/notifications?limit=5").expect(200);
    assert.ok(res.body.notifications);
  });

  it("PATCH /api/notifications/:id/read marks notification as read", async () => {
    await supertest(app).patch("/api/notifications/1/read").expect(200);
  });

  it("POST /api/notifications/read-all marks all as read", async () => {
    await supertest(app).post("/api/notifications/read-all").expect(200);
  });
});
