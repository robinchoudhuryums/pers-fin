// ============================================================================
// Manual cash entry (routes/transactions.js) + settle-up log (subscriptions.js)
// ============================================================================
// Stubbed-pool + supertest, no DB. Covers POST /api/transactions/manual
// validation + insert, and the GET/POST/DELETE settlement-log endpoints.

if (!process.env.NEON_DATABASE_URL) process.env.NEON_DATABASE_URL = "postgres://mock:mock@localhost/mock";
if (!process.env.TOKEN_ENCRYPTION_PASSPHRASE) process.env.TOKEN_ENCRYPTION_PASSPHRASE = "test-passphrase";

const { describe, it, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const supertest = require("supertest");

const dbModule = require("../teller/services/database");
const txnRouter = require("../teller/routes/transactions");
const subsRouter = require("../teller/routes/subscriptions");
const originalQuery = dbModule.pool.query;

function appWith(router) {
  const app = express();
  app.use(express.json());
  app.use(router);
  return app;
}

afterEach(() => { dbModule.pool.query = originalQuery; });

// ---- POST /api/transactions/manual ----------------------------------------
describe("POST /api/transactions/manual", () => {
  const app = appWith(txnRouter);

  it("rejects missing account_id / bad amount / bad date", async () => {
    dbModule.pool.query = async () => ({ rows: [] });
    assert.equal((await supertest(app).post("/api/transactions/manual").send({ amount: 5, date: "2026-06-01" })).status, 400);
    assert.equal((await supertest(app).post("/api/transactions/manual").send({ account_id: "manual_x", amount: -5, date: "2026-06-01" })).status, 400);
    assert.equal((await supertest(app).post("/api/transactions/manual").send({ account_id: "manual_x", amount: 5, date: "06/01/2026" })).status, 400);
  });

  it("404s when the account doesn't exist", async () => {
    dbModule.pool.query = async (sql) => {
      if (/FROM linked_accounts WHERE account_id/.test(sql)) return { rows: [] };
      return { rows: [] };
    };
    const res = await supertest(app).post("/api/transactions/manual")
      .send({ account_id: "manual_missing", amount: 5, date: "2026-06-01" });
    assert.equal(res.status, 404);
  });

  it("inserts a POSITIVE-amount expense with a manual_ id and chosen category", async () => {
    let insertParams = null;
    dbModule.pool.query = async (sql, params) => {
      if (/FROM linked_accounts WHERE account_id/.test(sql)) return { rows: [{ account_id: "manual_cash" }] };
      if (/INSERT INTO transactions/.test(sql)) {
        insertParams = params;
        return { rows: [{ transaction_id: params[1], amount: params[2], category: params[5] }] };
      }
      return { rows: [] };
    };
    const res = await supertest(app).post("/api/transactions/manual")
      .send({ account_id: "manual_cash", amount: 12.5, date: "2026-06-10", merchant_name: "Coffee", category: "Food & Drink", notes: "latte" });
    assert.equal(res.status, 200);
    // params: [account_id, txnId, amount, date, merchant, category, notes]
    assert.equal(insertParams[0], "manual_cash");
    assert.match(insertParams[1], /^manual_/);
    assert.equal(insertParams[2], 12.5);          // stored positive (expense)
    assert.equal(insertParams[4], "Coffee");
    assert.equal(insertParams[5], "{Food & Drink}");
  });

  it("defaults merchant to 'Cash' and category to null when omitted", async () => {
    let insertParams = null;
    dbModule.pool.query = async (sql, params) => {
      if (/FROM linked_accounts WHERE account_id/.test(sql)) return { rows: [{ account_id: "manual_cash" }] };
      if (/INSERT INTO transactions/.test(sql)) { insertParams = params; return { rows: [{}] }; }
      return { rows: [] };
    };
    await supertest(app).post("/api/transactions/manual")
      .send({ account_id: "manual_cash", amount: 3, date: "2026-06-10" });
    assert.equal(insertParams[4], "Cash");
    assert.equal(insertParams[5], null);
  });
});

// ---- Settle-up log ---------------------------------------------------------
describe("settle-up log endpoints", () => {
  const app = appWith(subsRouter);

  it("GET /api/settlement returns settled:false when no row", async () => {
    dbModule.pool.query = async () => ({ rows: [] });
    const res = await supertest(app).get("/api/settlement?month=2026-06");
    assert.equal(res.status, 200);
    assert.equal(res.body.settled, false);
    assert.equal(res.body.period, "2026-06");
  });

  it("GET /api/settlement returns the stored record", async () => {
    dbModule.pool.query = async () => ({ rows: [{ period: "2026-06", net_amount: "135.00", direction: "partner_sends_you", note: null, settled_at: new Date() }] });
    const res = await supertest(app).get("/api/settlement?month=2026-06");
    assert.equal(res.body.settled, true);
    assert.equal(res.body.net_amount, 135);
    assert.equal(res.body.direction, "partner_sends_you");
  });

  it("POST /api/settlement/settle validates month + upserts with a clamped direction", async () => {
    let upsertParams = null;
    dbModule.pool.query = async (sql, params) => { if (/INSERT INTO settlements/.test(sql)) upsertParams = params; return { rows: [] }; };
    assert.equal((await supertest(app).post("/api/settlement/settle").send({ month: "2026-13" })).status, 400);
    const res = await supertest(app).post("/api/settlement/settle")
      .send({ month: "2026-06", net_amount: 135, direction: "bogus" });
    assert.equal(res.status, 200);
    assert.equal(upsertParams[0], "2026-06");
    assert.equal(upsertParams[1], 135);
    assert.equal(upsertParams[2], "square"); // invalid direction coerced
  });

  it("DELETE /api/settlement/:period unsettles", async () => {
    let deleted = null;
    dbModule.pool.query = async (sql, params) => { if (/DELETE FROM settlements/.test(sql)) deleted = params[0]; return { rows: [] }; };
    const res = await supertest(app).delete("/api/settlement/2026-06");
    assert.equal(res.status, 200);
    assert.equal(res.body.settled, false);
    assert.equal(deleted, "2026-06");
  });
});
