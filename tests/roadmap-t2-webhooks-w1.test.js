// ============================================================================
// Roadmap T2.1 — W1: bank webhook receivers and event log
// ============================================================================
//  - POST /api/webhooks/plaid and /api/webhooks/teller answer 503 and record
//    nothing until a verifier is configured (none is, in W1)
//  - the pipeline (run with injected verifiers / handlers): body required +
//    capped, 401 with a fixed message on a bad signature (failures limited per
//    IP), the event recorded under a provider dedupe key, a duplicate answered
//    200 and not processed again, 200 BEFORE the detached handler runs, the
//    row finished done / ignored / failed, the body never stored or logged,
//    the 30-day prune at most once a day
//  - the shell lets exactly these two POSTs past the cookie gate; Perfin
//    mounts the router before session / auth / CSRF / API-key / activity
// The database-backed half is tests/contract/webhooks-w1.contract.test.js.
const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const express = require("express");
const supertest = require("supertest");

if (!process.env.NEON_DATABASE_URL) process.env.NEON_DATABASE_URL = "postgres://mock:mock@localhost/mock";
if (!process.env.TOKEN_ENCRYPTION_PASSPHRASE) process.env.TOKEN_ENCRYPTION_PASSPHRASE = "test-passphrase";
process.env.SHELL_PIN = process.env.SHELL_PIN || "135790";
process.env.SHELL_SECRET = process.env.SHELL_SECRET || "w1-test-secret";

const ROOT = path.join(__dirname, "..");
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), "utf8");
const dbModule = require("../teller/services/database");
const webhooks = require("../teller/routes/webhooks");

const BODY = { webhook_type: "TRANSACTIONS", webhook_code: "SYNC_UPDATES_AVAILABLE", item_id: "item-1", secret_field: "VERY-SECRET-TXN-DATA" };

function appWith(router) {
  const app = express();
  app.use(express.json({ limit: "1mb", verify: (req, _res, buf) => { req.rawBody = buf; } }));
  app.use(router);
  return app;
}

function fakeDb({ insertRows = [{ id: 7 }], insertThrows = false } = {}) {
  const calls = [];
  return {
    calls,
    query: async (sql, params) => {
      calls.push({ sql, params });
      if (/INSERT INTO webhook_events/.test(sql)) {
        if (insertThrows) throw new Error("db down");
        return { rows: insertRows };
      }
      return { rows: [], rowCount: 1 };
    },
  };
}

const goodVerifier = (dedupeKey = "evt-1") => ({
  configured: () => true,
  verify: async () => ({ ok: true, dedupeKey, event: { type: "TRANSACTIONS", code: "SYNC_UPDATES_AVAILABLE", subject: "item-1" } }),
});
const badVerifier = { configured: () => true, verify: async () => ({ ok: false }) };

function captureConsole() {
  const lines = [];
  const orig = { log: console.log, warn: console.warn, error: console.error };
  for (const k of Object.keys(orig)) console[k] = (...a) => { lines.push({ level: k, text: a.map(String).join(" ") }); };
  return { lines, restore: () => Object.assign(console, orig) };
}

// ---------------------------------------------------------------------------
describe("W1 — the production router answers 503 and records nothing", () => {
  const realQuery = dbModule.pool.query;
  const calls = [];
  before(() => { dbModule.pool.query = async (sql) => { calls.push(sql); return { rows: [] }; }; });
  after(() => { dbModule.pool.query = realQuery; });

  it("both providers: 503 with no database write", async () => {
    const app = appWith(webhooks);
    for (const p of ["plaid", "teller"]) {
      const r = await supertest(app).post(`/api/webhooks/${p}`).send(BODY).expect(503);
      assert.match(r.body.error, /not configured/);
    }
    assert.deepEqual(calls, []);
    assert.deepEqual(webhooks.WEBHOOK_PATHS, ["/api/webhooks/plaid", "/api/webhooks/teller"]);
  });

  it("an unknown provider is a 404; a GET doesn't reach the receiver", async () => {
    const app = appWith(webhooks);
    await supertest(app).post("/api/webhooks/stripe").send(BODY).expect(404);
    await supertest(app).get("/api/webhooks/plaid").expect(404);
  });
});

// ---------------------------------------------------------------------------
describe("W1 — the pipeline", () => {
  it("a body is required and capped", async () => {
    const db = fakeDb();
    const app = appWith(webhooks.createWebhookRouter({ verifiers: { plaid: goodVerifier() }, db, defer: () => {} }));
    await supertest(app).post("/api/webhooks/plaid").expect(400);
    const big = { pad: "x".repeat(webhooks.MAX_BODY_BYTES + 10) };
    await supertest(app).post("/api/webhooks/plaid").send(big).expect(413);
    assert.equal(db.calls.length, 0);
  });

  it("a bad signature is a 401 with a fixed message, logged as a warning, nothing recorded", async () => {
    const db = fakeDb();
    const app = appWith(webhooks.createWebhookRouter({ verifiers: { plaid: badVerifier }, db, defer: () => {} }));
    const c = captureConsole();
    let r;
    try { r = await supertest(app).post("/api/webhooks/plaid").send(BODY).expect(401); } finally { c.restore(); }
    assert.equal(r.body.error, "Signature verification failed.");
    assert.equal(db.calls.length, 0);
    assert.ok(c.lines.some((l) => l.level === "warn" && /rejected/.test(l.text)));
    assert.ok(!c.lines.some((l) => l.level === "error"), "not a server error (keeps the in-app error log clean)");
  });

  it("a verifier that throws counts as a failed signature", async () => {
    const db = fakeDb();
    const throwing = { configured: () => true, verify: async () => { throw new Error("key fetch failed"); } };
    const app = appWith(webhooks.createWebhookRouter({ verifiers: { teller: throwing }, db, defer: () => {} }));
    const c = captureConsole();
    try { await supertest(app).post("/api/webhooks/teller").send(BODY).expect(401); } finally { c.restore(); }
    assert.equal(db.calls.length, 0);
  });

  it("a verified event is recorded, answered 200, then handled detached and marked done", async () => {
    const db = fakeDb();
    const deferred = [];
    const seen = [];
    const handlers = { plaid: async (event, ctx) => { seen.push({ event, ctx }); return { status: "done" }; } };
    const app = appWith(webhooks.createWebhookRouter({ verifiers: { plaid: goodVerifier("jwt-hash-1") }, handlers, db, defer: (fn) => deferred.push(fn) }));
    const r = await supertest(app).post("/api/webhooks/plaid").send(BODY).expect(200);
    assert.deepEqual(r.body, { ok: true });
    assert.equal(seen.length, 0, "the handler runs after the response");
    const ins = db.calls.find((c) => /INSERT INTO webhook_events/.test(c.sql));
    assert.match(ins.sql, /ON CONFLICT \(provider, dedupe_key\) DO NOTHING/);
    assert.deepEqual(ins.params, ["plaid", "TRANSACTIONS", "SYNC_UPDATES_AVAILABLE", "item-1", "jwt-hash-1"]);
    for (const fn of deferred) await fn();
    await new Promise((res) => setImmediate(res));
    assert.equal(seen.length, 1);
    assert.deepEqual(seen[0].ctx, { id: 7, provider: "plaid" });
    const done = db.calls.find((c) => /SET status = \$2/.test(c.sql));
    assert.deepEqual(done.params.slice(0, 3), [7, "done", null]);
  });

  it("no handler → ignored; a throwing handler → failed with a fixed error (the 200 already sent)", async () => {
    for (const [handlers, want, err] of [
      [{}, "ignored", null],
      [{ teller: async () => { throw new Error("Teller 500: {\"body\":\"secret\"}"); } }, "failed", "The event's sync failed — see the server log."],
    ]) {
      const db = fakeDb();
      const deferred = [];
      const app = appWith(webhooks.createWebhookRouter({ verifiers: { teller: goodVerifier("evt-9") }, handlers, db, defer: (fn) => deferred.push(fn) }));
      await supertest(app).post("/api/webhooks/teller").send(BODY).expect(200);
      const c = captureConsole();
      try { for (const fn of deferred) await fn(); await new Promise((res) => setImmediate(res)); } finally { c.restore(); }
      const fin = db.calls.find((x) => /SET status = \$2/.test(x.sql));
      assert.deepEqual(fin.params.slice(1, 3), [want, err]);
    }
  });

  it("a duplicate delivery is answered 200 and not processed again", async () => {
    const db = fakeDb({ insertRows: [] });
    const deferred = [];
    const app = appWith(webhooks.createWebhookRouter({ verifiers: { plaid: goodVerifier() }, handlers: { plaid: async () => { throw new Error("must not run"); } }, db, defer: (fn) => deferred.push(fn) }));
    const r = await supertest(app).post("/api/webhooks/plaid").send(BODY).expect(200);
    assert.deepEqual(r.body, { ok: true, duplicate: true });
    assert.equal(deferred.length, 0);
  });

  it("a failed record is a 500 (not acknowledged) and nothing runs", async () => {
    const db = fakeDb({ insertThrows: true });
    const deferred = [];
    const app = appWith(webhooks.createWebhookRouter({ verifiers: { plaid: goodVerifier() }, db, defer: (fn) => deferred.push(fn) }));
    const c = captureConsole();
    try { await supertest(app).post("/api/webhooks/plaid").send(BODY).expect(500); } finally { c.restore(); }
    assert.equal(deferred.length, 0);
  });

  it("the request body is never stored or logged", async () => {
    const db = fakeDb();
    const deferred = [];
    const handlers = { plaid: async () => { throw new Error("boom"); } };
    const app = appWith(webhooks.createWebhookRouter({ verifiers: { plaid: goodVerifier() }, handlers, db, defer: (fn) => deferred.push(fn) }));
    const c = captureConsole();
    try {
      await supertest(app).post("/api/webhooks/plaid").send(BODY).expect(200);
      for (const fn of deferred) await fn();
      await new Promise((res) => setImmediate(res));
    } finally { c.restore(); }
    const everything = JSON.stringify(db.calls) + c.lines.map((l) => l.text).join("\n");
    assert.ok(!everything.includes("VERY-SECRET-TXN-DATA"));
  });

  it("failed verifications are limited per IP; 503s and successes don't count", async () => {
    const unconfigured = appWith(webhooks.createWebhookRouter({ db: fakeDb(), defer: () => {} }));
    for (let i = 0; i < 25; i++) await supertest(unconfigured).post("/api/webhooks/plaid").send(BODY).expect(503);

    const app = appWith(webhooks.createWebhookRouter({ verifiers: { plaid: badVerifier }, db: fakeDb(), defer: () => {} }));
    const c = captureConsole();
    try {
      for (let i = 0; i < 20; i++) await supertest(app).post("/api/webhooks/plaid").send(BODY).expect(401);
      await supertest(app).post("/api/webhooks/plaid").send(BODY).expect(429);
    } finally { c.restore(); }
  });

  it("old events are pruned after 30 days, at most once a day", async () => {
    let t = 1_000_000_000_000;
    const db = fakeDb();
    const deferred = [];
    const app = appWith(webhooks.createWebhookRouter({ verifiers: { plaid: goodVerifier() }, db, defer: (fn) => deferred.push(fn), now: () => t }));
    const run = async () => {
      await supertest(app).post("/api/webhooks/plaid").send(BODY).expect(200);
      while (deferred.length) await deferred.shift()();
      await new Promise((res) => setImmediate(res));
    };
    const prunes = () => db.calls.filter((c) => /DELETE FROM webhook_events/.test(c.sql));
    await run();
    assert.equal(prunes().length, 1);
    assert.deepEqual(prunes()[0].params, [webhooks.RETENTION_DAYS]);
    t += 60 * 60 * 1000; await run();
    assert.equal(prunes().length, 1, "not again within a day");
    t += 24 * 60 * 60 * 1000; await run();
    assert.equal(prunes().length, 2);
  });
});

// ---------------------------------------------------------------------------
describe("W1 — wiring", () => {
  it("the shell lets exactly the two webhook POSTs past the cookie gate", async () => {
    const auth = require("../shell/middleware/auth");
    const app = express();
    app.use(require("cookie-parser")());
    app.use(express.json());
    app.use(auth.requireAuth);
    app.post("/*", (req, res) => res.json({ ok: true }));
    app.get("/*", (req, res) => res.json({ ok: true }));
    for (const p of ["/perfin/api/webhooks/plaid", "/perfin/api/webhooks/teller", "/per-sistant/api/perfin/webhook"]) {
      await supertest(app).post(p).send({}).expect(200);
    }
    for (const p of ["/perfin/api/webhooks/plaidx", "/perfin/api/webhooks", "/perfin/api/webhooks/plaid/extra", "/perfin/api/sync"]) {
      const r = await supertest(app).post(p).set("Accept", "application/json").send({});
      assert.equal(r.status, 401, p);
    }
    const g = await supertest(app).get("/perfin/api/webhooks/plaid").set("Accept", "application/json");
    assert.equal(g.status, 401);
  });

  it("Perfin keeps the raw body and mounts the router before session, auth, CSRF, API key and the activity touch", () => {
    const src = read("teller", "server.js");
    assert.match(src, /app\.use\(express\.json\(\{ verify: \(req, _res, buf\) => \{ req\.rawBody = buf; \} \}\)\);/);
    const at = src.indexOf('app.use(require("./routes/webhooks"));');
    assert.ok(at > 0);
    for (const later of ["touchActivity();", "app.use(session(sessionConfig));", "app.use(requireAuth);", "CSRF validation failed", "Unauthorized: invalid or missing API key"]) {
      assert.ok(src.indexOf(later) > at, later);
    }
  });

  it("webhook_events is created by the migrations and left alone by reset-fresh", () => {
    assert.match(read("teller", "services", "database.js"), /CREATE TABLE IF NOT EXISTS webhook_events \([\s\S]*UNIQUE \(provider, dedupe_key\)/);
    assert.ok(require("../scripts/reset-fresh").UNTOUCHED_TABLES.includes("webhook_events"));
  });
});
