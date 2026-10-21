// ============================================================================
// Oct 2026 broad scan (cycle 7) — Batch 13: Per-sistant platform + test quality
// ============================================================================
// Behavioural tests for code that only had source-regex pins (F138/F139):
// the migration runner's lock / rollback / retry rules (PS-1 + F10) and the
// standalone login gate (requireAuth + POST /api/login). The database-backed
// half (schema, analytics, scheduled-email at-most-once, reindex) lives in
// tests/contract/persistent-batch13.contract.test.js.
process.env.SESSION_PIN = "13579";
process.env.SESSION_SECRET = process.env.SESSION_SECRET || "batch13-secret";
process.env.PERSISTENT_DATABASE_URL = process.env.PERSISTENT_DATABASE_URL || "postgres://test:test@127.0.0.1:1/test";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const session = require("express-session");
const supertest = require("supertest");

const db = require("../db");

function fakeDb(failOn) {
  const calls = { queries: [], releases: 0, connects: 0 };
  const client = {
    query: async (sql) => {
      calls.queries.push(String(sql).slice(0, 80));
      const err = failOn(String(sql), calls);
      if (err) throw err;
      return { rows: [] };
    },
    release: () => { calls.releases++; },
  };
  return { calls, db: { connect: async () => { calls.connects++; return client; } } };
}
const lockErr = () => Object.assign(new Error("lock timeout"), { code: "55P03" });
const isMigrationFile = (sql) => /CREATE TABLE/i.test(sql);

describe("F10 / PS-1: runMigrations — one transaction, locks first, fatal except a lock timeout", () => {
  it("BEGIN, advisory lock, lock_timeout, the files, COMMIT", async () => {
    const { calls, db: fake } = fakeDb(() => null);
    await db.runMigrations({ db: fake });
    assert.equal(calls.queries[0], "BEGIN");
    assert.match(calls.queries[1], /pg_advisory_xact_lock/);
    assert.match(calls.queries[2], /SET LOCAL lock_timeout/);
    assert.equal(calls.queries.at(-1), "COMMIT");
    assert.equal(calls.releases, 1);
  });

  it("a failing migration file rolls back and rethrows without a retry", async () => {
    let slept = 0;
    const { calls, db: fake } = fakeDb((sql) => (isMigrationFile(sql) ? new Error("syntax error") : null));
    await assert.rejects(db.runMigrations({ db: fake, sleep: async () => { slept++; } }), /syntax error/);
    assert.equal(calls.queries.at(-1), "ROLLBACK");
    assert.ok(!calls.queries.includes("COMMIT"));
    assert.equal(calls.connects, 1);
    assert.equal(slept, 0);
  });

  it("a lock timeout is retried and a later clean run commits", async () => {
    const delays = [];
    const { calls, db: fake } = fakeDb((sql, c) => (isMigrationFile(sql) && c.connects === 1 ? lockErr() : null));
    await db.runMigrations({ db: fake, sleep: async (ms) => { delays.push(ms); } });
    assert.equal(calls.connects, 2);
    assert.deepEqual(delays, [2000]);
    assert.equal(calls.queries.filter((q) => q === "ROLLBACK").length, 1);
    assert.equal(calls.queries.at(-1), "COMMIT");
  });
});

describe("F139: the standalone login gate, run for real", () => {
  const { requireAuth } = require("../middleware");
  const views = require("../views");
  const config = require("../config");
  const pool = { query: async () => ({ rows: [{ session_timeout_minutes: 15 }] }) };

  function makeApp({ embedded = false } = {}) {
    const app = express();
    if (embedded) app.set("embedded", true);
    app.use(express.json());
    app.use(session({ secret: "t", resave: false, saveUninitialized: false }));
    app.use(requireAuth);
    app.use(require("../routes/auth")({ pool, views, config }));
    app.get("/api/thing", (req, res) => res.json({ ok: true }));
    app.post("/api/perfin/webhook", (req, res) => res.json({ reached: true }));
    return app;
  }

  it("an API call without a session is a 401; a page redirects to /login", async () => {
    const app = makeApp();
    await supertest(app).get("/api/thing").expect(401);
    const r = await supertest(app).get("/todos");
    assert.equal(r.status, 302);
    assert.equal(r.headers.location, "/login");
  });

  it("a wrong PIN is refused; the right PIN opens a session that reaches the API", async () => {
    const agent = supertest.agent(makeApp());
    await agent.post("/api/login").send({ password: "00000" }).expect(401);
    await agent.post("/api/login").send({ password: "1357" }).expect(401); // different length
    await agent.post("/api/login").send({}).expect(400);
    await agent.post("/api/login").send({ password: "13579" }).expect(200);
    await agent.get("/api/thing").expect(200);
    await agent.post("/api/logout").expect(200);
    await agent.get("/api/thing").expect(401);
  });

  it("an expired session is refused", async () => {
    const app = express();
    app.use(express.json());
    app.use(session({ secret: "t", resave: false, saveUninitialized: true }));
    app.use((req, res, next) => { req.session.authenticated = true; req.session.lastActivity = Date.now() - 16 * 60e3; req.session.timeoutMinutes = 15; next(); });
    app.use(requireAuth);
    app.get("/api/thing", (req, res) => res.json({ ok: true }));
    await supertest(app).get("/api/thing").expect(401);
  });

  it("embedded under the shell, the per-app gate is skipped (INV-25)", async () => {
    await supertest(makeApp({ embedded: true })).get("/api/thing").expect(200);
  });

  it("only POST /api/perfin/webhook passes without a session (PB-15)", async () => {
    const app = makeApp();
    await supertest(app).post("/api/perfin/webhook").send({}).expect(200);
    await supertest(app).get("/api/perfin/webhook").expect(401);
  });
});
