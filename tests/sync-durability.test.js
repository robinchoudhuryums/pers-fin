// ============================================================================
// Durability & hardening tests
// ============================================================================
// Covers the sync-reliability and shell-hardening work:
//   - parseMoney: CSV amount normalization (F28) — the silent-corruption path.
//   - classifyTransfer: word-boundary matching (F32).
//   - safeReturnTo: shell open-redirect guard (F17).
//   - GET /api/data-health: the operator health surface (derived issues).
//   - POST /api/sync/reconcile: backfill endpoint shape + day clamping.
//
// Endpoint tests use the mock-pool + supertest pattern from
// new-endpoints.integration.test.js: monkeypatch the shared pool's `query`,
// exercise the router, restore afterward.

if (!process.env.NEON_DATABASE_URL) process.env.NEON_DATABASE_URL = "postgres://mock:mock@localhost/mock";

const { describe, it, before, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const supertest = require("supertest");

const { parseMoney } = require("../teller/data/csv-formats");
const { classifyTransfer, isTransferMerchant } = require("../scripts/detect-transfers");
const auth = require("../shell/middleware/auth");

// ---------------------------------------------------------------------------
// parseMoney (F28) — the silent-corruption path
// ---------------------------------------------------------------------------
describe("parseMoney (CSV amount normalization)", () => {
  it("strips thousands separators", () => {
    assert.equal(parseMoney("1,234.56"), 1234.56);
    assert.equal(parseMoney("12,000"), 12000);
  });
  it("strips currency symbols", () => {
    assert.equal(parseMoney("$1,234.56"), 1234.56);
    assert.equal(parseMoney("$45.00"), 45);
  });
  it("treats parenthesized values as negative", () => {
    assert.equal(parseMoney("(45.00)"), -45);
    assert.equal(parseMoney("($1,200.00)"), -1200);
  });
  it("returns NaN for blank/garbage so callers can skip the row", () => {
    assert.ok(Number.isNaN(parseMoney("")));
    assert.ok(Number.isNaN(parseMoney("   ")));
  });
  it("does NOT truncate a 4-digit amount to 1 (the original bug)", () => {
    assert.notEqual(parseMoney("1,234.56"), 1);
  });
});

// ---------------------------------------------------------------------------
// classifyTransfer word-boundary matching (F32)
// ---------------------------------------------------------------------------
describe("classifyTransfer word-boundary matching", () => {
  it("does not substring-match single-word keywords inside unrelated merchants", () => {
    assert.equal(classifyTransfer("Almira Restaurant"), null); // contains "ira"
    assert.equal(classifyTransfer("Telepayments Inc"), null);  // contains "epay"
    assert.equal(isTransferMerchant("Almira Restaurant"), false);
  });
  it("still classifies genuine transfers", () => {
    assert.equal(classifyTransfer("Zelle to Bob"), "peer_transfer");
    assert.equal(classifyTransfer("VANGUARD BUY"), "investment");
    assert.equal(classifyTransfer("ACH Transfer"), "internal");
  });
  it("matches multi-word keywords as phrases", () => {
    assert.equal(classifyTransfer("Cash App payment"), "peer_transfer");
  });
});

// ---------------------------------------------------------------------------
// safeReturnTo — shell open-redirect guard (F17)
// ---------------------------------------------------------------------------
describe("auth.safeReturnTo (open-redirect guard)", () => {
  it("allows same-origin absolute paths", () => {
    assert.equal(auth.safeReturnTo("/perfin/dashboard"), "/perfin/dashboard");
    assert.equal(auth.safeReturnTo("/"), "/");
  });
  it("rejects scheme-relative //host targets", () => {
    assert.equal(auth.safeReturnTo("//evil.com/path"), "/");
  });
  it("rejects backslash targets and non-absolute / non-string input", () => {
    assert.equal(auth.safeReturnTo("/\\evil.com"), "/");
    assert.equal(auth.safeReturnTo("https://evil.com"), "/");
    assert.equal(auth.safeReturnTo("evil"), "/");
    assert.equal(auth.safeReturnTo(undefined), "/");
    assert.equal(auth.safeReturnTo(null), "/");
  });
});

// ---------------------------------------------------------------------------
// Endpoint tests (mock pool + supertest)
// ---------------------------------------------------------------------------
let dbModule, originalPoolQuery;

before(() => {
  dbModule = require("../teller/services/database");
  originalPoolQuery = dbModule.pool.query;
});
afterEach(() => {
  if (dbModule && originalPoolQuery) dbModule.pool.query = originalPoolQuery;
});

function makeApp(routePath) {
  delete require.cache[require.resolve(routePath)];
  const router = require(routePath);
  const app = express();
  app.use(express.json());
  app.use(router);
  return app;
}

describe("GET /api/data-health", () => {
  it("derives issues from provider status and freshness", async () => {
    dbModule.pool.query = async (sql) => {
      if (/FROM user_settings/.test(sql)) {
        // Fresh transactions so only the disconnected-enrollment issue fires.
        return { rows: [{ last_txn_sync_at: new Date(), last_balance_sync_at: new Date(), last_auto_sync_at: new Date(), insights_last_run: null, last_reconcile_at: null }] };
      }
      if (/FROM teller_enrollments/.test(sql)) return { rows: [{ total: 2, disconnected: 1 }] };
      if (/FROM plaid_items/.test(sql)) return { rows: [{ total: 0, not_good: 0 }] };
      if (/FROM notification_log/.test(sql)) return { rows: [] };
      return { rows: [] };
    };
    const app = makeApp("../teller/routes/settings");
    const res = await supertest(app).get("/api/data-health");
    assert.equal(res.status, 200);
    assert.equal(res.body.ok, false);
    assert.equal(res.body.providers.teller.disconnected, 1);
    assert.ok(res.body.issues.some(i => /disconnected/i.test(i.message) && i.severity === "warning"));
    assert.equal(res.body.freshness.transactions.level, "fresh");
  });

  it("reports ok with no provider issues when everything is fresh and connected", async () => {
    dbModule.pool.query = async (sql) => {
      if (/FROM user_settings/.test(sql)) {
        return { rows: [{ last_txn_sync_at: new Date(), last_balance_sync_at: new Date(), last_auto_sync_at: new Date(), insights_last_run: new Date(), last_reconcile_at: new Date() }] };
      }
      if (/FROM teller_enrollments/.test(sql)) return { rows: [{ total: 1, disconnected: 0 }] };
      if (/FROM plaid_items/.test(sql)) return { rows: [{ total: 1, not_good: 0 }] };
      if (/FROM notification_log/.test(sql)) return { rows: [] };
      return { rows: [] };
    };
    const app = makeApp("../teller/routes/settings");
    const res = await supertest(app).get("/api/data-health");
    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true);
    assert.equal(res.body.issues.length, 0);
  });
});

describe("POST /api/sync/reconcile", () => {
  it("runs with no enrollments, clamps days, and returns per-provider summaries", async () => {
    dbModule.pool.query = async () => ({ rows: [] }); // no enrollments, updates no-op
    const app = makeApp("../teller/routes/enrollments");
    const res = await supertest(app).post("/api/sync/reconcile").send({ days: 999, provider: "all" });
    assert.equal(res.status, 200);
    assert.equal(res.body.days, 365);            // clamped from 999
    assert.equal(res.body.provider, "all");
    assert.equal(res.body.teller.transactions_added, 0);
    // Plaid not configured in the test env → helper returns ok:false
    assert.equal(res.body.plaid.ok, false);
  });

  it("defaults to 90 days and teller-only when requested", async () => {
    dbModule.pool.query = async () => ({ rows: [] });
    const app = makeApp("../teller/routes/enrollments");
    const res = await supertest(app).post("/api/sync/reconcile").send({ provider: "teller" });
    assert.equal(res.status, 200);
    assert.equal(res.body.days, 90);
    assert.equal(res.body.provider, "teller");
    assert.ok(res.body.teller);
    assert.equal(res.body.plaid, undefined);     // teller-only → no plaid key
  });
});
