// ============================================================================
// Teller integration tests — against the REAL code (TQ-1, Sept 2026 Batch 15)
// ============================================================================
// These used to test inline copies of the logic (an amount normalizer, an auth
// header builder, a field mapper and an env mapper written inside the test),
// so a production change could never fail them. They now drive the production
// paths: syncAllEnrollments (amount sign, pending skip, merchant fallback,
// category literal), POST /api/enroll (required fields, institution default),
// tellerRequest (the Basic auth header actually sent) and the TELLER_ENV
// export. The pool and the Teller HTTP client are stubbed; nothing hits a
// network or a database.
// ============================================================================

if (!process.env.NEON_DATABASE_URL) process.env.NEON_DATABASE_URL = "postgres://mock:mock@localhost/mock";
if (!process.env.TOKEN_ENCRYPTION_PASSPHRASE) process.env.TOKEN_ENCRYPTION_PASSPHRASE = "test-passphrase";

const { describe, it, after, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const supertest = require("supertest");
const https = require("https");
const { EventEmitter } = require("events");

const dbModule = require("../teller/services/database");
const tellerApi = require("../teller/services/teller-api");
const originalPoolQuery = dbModule.pool.query;
const originalConnect = dbModule.pool.connect;
const originalTellerRequest = tellerApi.tellerRequest;

function freshEnrollments() {
  delete require.cache[require.resolve("../teller/routes/enrollments")];
  return require("../teller/routes/enrollments");
}

afterEach(() => {
  dbModule.pool.query = originalPoolQuery;
  dbModule.pool.connect = originalConnect;
  tellerApi.tellerRequest = originalTellerRequest;
});
after(() => { delete require.cache[require.resolve("../teller/routes/enrollments")]; });

// ---------------------------------------------------------------------------
describe("Teller transaction mapping (syncAllEnrollments)", () => {
  const PAGE = [
    { id: "t_debit", amount: "-15.99", date: "2026-06-10", description: "NETFLIX.COM", status: "posted",
      details: { category: "entertainment", counterparty: { name: "Netflix" } } },
    { id: "t_credit", amount: "42.50", date: "2026-06-09", description: "REFUND - SHOP", status: "posted", details: {} },
    { id: "t_pending", amount: "-20.00", date: "2026-06-09", description: "HOLD", status: "pending" },
    { id: "t_nocp", amount: "-8.50", date: "2026-06-08", description: "POS PURCHASE - LOCAL SHOP", status: "posted" },
  ];
  let inserts;

  async function run() {
    tellerApi.tellerRequest = async (endpoint) => (endpoint.includes("from_id") ? [] : PAGE.slice());
    const { syncAllEnrollments } = freshEnrollments();
    inserts = [];
    dbModule.pool.query = async (sql, params) => {
      if (sql.includes("FROM teller_enrollments te") && sql.includes("status != 'SUSPENDED'")) {
        return { rows: [{ id: 1, enrollment_id: "enr_1", institution_name: "Bank", access_token: "tok", last_synced_txn_date: null }] };
      }
      if (sql.includes("FROM linked_accounts WHERE teller_enrollment_id")) return { rows: [{ account_id: "acc_1" }] };
      if (sql.includes("INSERT INTO transactions") && sql.includes("RETURNING (xmax = 0)")) {
        inserts.push(params);
        return { rows: [{ inserted: true }] };
      }
      if (sql.includes("last_anomaly_check_at FROM user_settings")) return { rows: [{ last_anomaly_check_at: new Date() }] };
      return { rows: [] };
    };
    return syncAllEnrollments();
  }

  it("stores debits positive and credits negative (Teller's sign flipped to the Plaid convention)", async () => {
    await run();
    const byId = Object.fromEntries(inserts.map((p) => [p[1], p]));
    assert.equal(byId.t_debit[2], 15.99);
    assert.equal(byId.t_credit[2], -42.5);
  });

  it("skips pending transactions", async () => {
    const r = await run();
    assert.ok(!inserts.some((p) => p[1] === "t_pending"));
    assert.equal(r.transactions_added, 3);
  });

  it("merchant = counterparty name, falling back to the description; name = description; category as a text[] literal", async () => {
    await run();
    const byId = Object.fromEntries(inserts.map((p) => [p[1], p]));
    assert.equal(byId.t_debit[4], "Netflix");
    assert.equal(byId.t_nocp[4], "POS PURCHASE - LOCAL SHOP");
    assert.equal(byId.t_debit[5], "NETFLIX.COM");
    assert.equal(byId.t_debit[6], "{entertainment}");
    assert.equal(byId.t_credit[6], null);
    assert.equal(byId.t_debit[3], "2026-06-10");
  });
});

// ---------------------------------------------------------------------------
describe("POST /api/enroll", () => {
  function app() {
    const a = express();
    a.use(express.json());
    a.use(freshEnrollments());
    return a;
  }

  it("400s without accessToken or enrollment.id", async () => {
    await supertest(app()).post("/api/enroll").send({ enrollment: { id: "enr_1" } }).expect(400);
    await supertest(app()).post("/api/enroll").send({ accessToken: "tok" }).expect(400);
  });

  it("stores the institution name, defaulting to 'Unknown'", async () => {
    const calls = [];
    const client = {
      query: async (sql, params) => {
        calls.push({ sql, params });
        if (/INSERT INTO teller_enrollments/.test(sql)) return { rows: [{ id: 7 }] };
        return { rows: [] };
      },
      release() {},
    };
    dbModule.pool.connect = async () => client;
    dbModule.pool.query = async () => ({ rows: [] });
    tellerApi.tellerRequest = async () => [];
    await supertest(app()).post("/api/enroll").send({ accessToken: "tok", enrollment: { id: "enr_a", institution: { name: "Chase" } } });
    await supertest(app()).post("/api/enroll").send({ accessToken: "tok", enrollment: { id: "enr_b" } });
    const names = calls.filter((c) => /INSERT INTO teller_enrollments/.test(c.sql)).map((c) => c.params[1]);
    assert.deepEqual(names, ["Chase", "Unknown"]);
  });
});

// ---------------------------------------------------------------------------
describe("tellerRequest sends HTTP Basic auth with the token as the user and an empty password", () => {
  const originalRequest = https.request;
  afterEach(() => { https.request = originalRequest; });

  it("Authorization: Basic base64('<token>:')", async () => {
    let seen = null;
    https.request = (opts, cb) => {
      seen = opts;
      const req = new EventEmitter();
      req.write = () => {}; req.setTimeout = () => {}; req.destroy = () => {};
      req.end = () => {
        const res = new EventEmitter();
        res.statusCode = 200; res.headers = {};
        cb(res);
        res.emit("data", Buffer.from("[]"));
        res.emit("end");
      };
      return req;
    };
    // getTlsAgent needs a cert; give it a throwaway in-memory one via env.
    const prevCert = process.env.TELLER_CERT, prevKey = process.env.TELLER_KEY;
    process.env.TELLER_CERT = Buffer.from("x").toString("base64");
    process.env.TELLER_KEY = Buffer.from("y").toString("base64");
    try {
      delete require.cache[require.resolve("../teller/services/teller-api")];
      const api = require("../teller/services/teller-api");
      const out = await api.tellerRequest("/accounts", "test_token_abc123");
      assert.deepEqual(out, []);
    } finally {
      if (prevCert === undefined) delete process.env.TELLER_CERT; else process.env.TELLER_CERT = prevCert;
      if (prevKey === undefined) delete process.env.TELLER_KEY; else process.env.TELLER_KEY = prevKey;
      delete require.cache[require.resolve("../teller/services/teller-api")];
    }
    const decoded = Buffer.from(seen.headers.Authorization.replace(/^Basic /, ""), "base64").toString();
    assert.equal(decoded, "test_token_abc123:");
    assert.equal(seen.hostname, "api.teller.io");
    assert.equal(seen.path, "/accounts");
  });
});

// ---------------------------------------------------------------------------
describe("TELLER_ENV", () => {
  function envFor(value) {
    const prev = process.env.TELLER_ENV;
    if (value === undefined) delete process.env.TELLER_ENV; else process.env.TELLER_ENV = value;
    try {
      delete require.cache[require.resolve("../teller/services/teller-api")];
      return require("../teller/services/teller-api").TELLER_ENV;
    } finally {
      if (prev === undefined) delete process.env.TELLER_ENV; else process.env.TELLER_ENV = prev;
      delete require.cache[require.resolve("../teller/services/teller-api")];
    }
  }
  it("defaults to sandbox and lower-cases the configured value", () => {
    assert.equal(envFor(undefined), "sandbox");
    assert.equal(envFor("PRODUCTION"), "production");
    assert.equal(envFor("development"), "development");
  });
});
