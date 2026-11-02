// ============================================================================
// Cycle-8 broad scan, Batch 1 — scheduler + auth safety
// ============================================================================
//   F27  every scheduled job also runs once shortly after boot (staggered) —
//        since cycle-8 E2b the job runner's, pinned in tests/cycle8-e2b.test.js
//   F29  bank auto-sync / self-healing reconcile / insights trigger skip their
//        settings read while off or not due; a Settings change looks again
//   F25  safeReturnTo refuses control characters (the biometric open redirect)
//   F26  the shell refuses to boot without a separate Per-sistant database
//   F2   a DISCONNECTED Teller enrollment is restored to GOOD only when Teller
//        actually answered for one of its accounts
//   F28  the pre-auth biometric probes are rate-limited; outstanding challenges
//        are capped
//   F30  the x-api-key limiter counts wrong keys, not valid-key 4xx answers
// ============================================================================

if (!process.env.NEON_DATABASE_URL) process.env.NEON_DATABASE_URL = "postgres://mock:mock@localhost/mock";
if (!process.env.TOKEN_ENCRYPTION_PASSPHRASE) process.env.TOKEN_ENCRYPTION_PASSPHRASE = "test-passphrase";

const { describe, it, before, after, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const express = require("express");
const supertest = require("supertest");

const ROOT = path.join(__dirname, "..");
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), "utf8");
const dbModule = require("../teller/services/database");
const jobHealth = require("../teller/services/job-health");
const startup = require("../teller/startup");

const originalQuery = dbModule.pool.query;
const originalConnect = dbModule.pool.connect;

// ---------------------------------------------------------------------------
// F27's one-shot boot runs were replaced by the due-based job runner in cycle-8
// E2b: every job still runs shortly after a boot when it is due — pinned with
// the runner's scheduling in tests/cycle8-e2b.test.js.

// ---------------------------------------------------------------------------
describe("F29 — the ungated jobs skip their settings read while off or not due", () => {
  let reads, row, prevKey;
  before(() => { prevKey = process.env.ANTHROPIC_API_KEY; process.env.ANTHROPIC_API_KEY = "test-key"; });
  after(() => { if (prevKey === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = prevKey; });
  beforeEach(() => {
    reads = { bank: 0, reconcile: 0, insights: 0 };
    row = {};
    startup._awayJobs.reset();
    dbModule.pool.query = async (sql) => {
      if (/auto_sync_enabled, auto_sync_interval_hours/.test(sql)) { reads.bank++; return { rows: [row] }; }
      if (/SELECT last_reconcile_at FROM user_settings/.test(sql)) { reads.reconcile++; return { rows: [row] }; }
      if (/insights_last_attempt_at FROM user_settings/.test(sql)) { reads.insights++; return { rows: [row] }; }
      return { rows: [] };
    };
  });
  afterEach(() => {
    dbModule.pool.query = originalQuery;
    startup._awayJobs.reset();
    jobHealth._memoryResults.clear();
  });

  it("bank auto-sync off: one read, then none for the rest of the local day; invalidate looks again", async () => {
    row = { auto_sync_enabled: false };
    await startup._awayJobs.runBankAutoSyncTick();
    await startup._awayJobs.runBankAutoSyncTick();
    assert.equal(reads.bank, 1);
    startup.invalidateJobMemos(["bank-auto-sync"]);
    await startup._awayJobs.runBankAutoSyncTick();
    assert.equal(reads.bank, 2);
  });

  it("bank auto-sync not due: no read until its due time", async () => {
    row = { auto_sync_enabled: true, auto_sync_interval_hours: 6, last_auto_sync_at: new Date(Date.now() - 3600e3) };
    await startup._awayJobs.runBankAutoSyncTick();
    await startup._awayJobs.runBankAutoSyncTick();
    assert.equal(reads.bank, 1, "due in ~5 hours → the second tick reads nothing");
  });

  it("self-healing reconcile not due: one read, then none until the week is up", async () => {
    row = { last_reconcile_at: new Date(Date.now() - 86400e3) };
    await startup._awayJobs.runSelfHealingReconcileTick();
    await startup._awayJobs.runSelfHealingReconcileTick();
    assert.equal(reads.reconcile, 1);
  });

  it("insights auto-trigger: off settles for the day; not due remembers the due time", async () => {
    row = { insights_enabled: false };
    await startup._awayJobs.runInsightsAutoTriggerTick();
    await startup._awayJobs.runInsightsAutoTriggerTick();
    assert.equal(reads.insights, 1);
    startup._awayJobs.reset();
    row = { insights_enabled: true, insights_cadence_days: 30, insights_last_run: new Date(Date.now() - 2 * 86400e3) };
    await startup._awayJobs.runInsightsAutoTriggerTick();
    await startup._awayJobs.runInsightsAutoTriggerTick();
    assert.equal(reads.insights, 2);
  });

  it("PATCH /api/settings on an auto-sync or insights field drops that job's memo", async () => {
    row = { auto_sync_enabled: false };
    await startup._awayJobs.runBankAutoSyncTick();
    const base = dbModule.pool.query;
    dbModule.pool.query = async (sql, p) => (/^UPDATE user_settings SET/.test(sql) ? { rows: [{ id: 1 }] } : base(sql, p));
    const app = express(); app.use(express.json()); app.use(require("../teller/routes/settings"));
    await supertest(app).patch("/api/settings").send({ auto_sync_enabled: true }).expect(200);
    await startup._awayJobs.runBankAutoSyncTick();
    assert.equal(reads.bank, 2, "the switch changed → the next tick reads again");
  });
});

// ---------------------------------------------------------------------------
describe("F25 — safeReturnTo refuses control characters", () => {
  const auth = require("../shell/middleware/auth");
  it("a tab / CR / LF / DEL anywhere falls back to the default destination", () => {
    for (const t of ["/\t/evil.example", "/\n/evil.example", "/\r/evil.example", "/a\u007fb", "/\u0000x"]) {
      assert.equal(auth.safeReturnTo(t), auth.DEFAULT_POST_LOGIN, JSON.stringify(t));
      assert.equal(auth.loginReturnTo(t), "", JSON.stringify(t));
    }
  });
  it("a browser resolving the accepted target stays on this origin", () => {
    for (const t of ["/perfin/housing?x=1#y", "/per-sistant/search?q=a%09b", "/%09/evil.example"]) {
      const out = auth.safeReturnTo(t);
      assert.equal(out, t);
      assert.equal(new URL(out, "https://app.example").origin, "https://app.example");
    }
  });
  it("the existing refusals still hold", () => {
    for (const t of ["//evil.example", "/\\evil.example", "https://evil.example", "evil"]) {
      assert.equal(auth.safeReturnTo(t), auth.DEFAULT_POST_LOGIN);
    }
  });
});

// ---------------------------------------------------------------------------
describe("F26 — the shell refuses to share one database between the two apps", () => {
  const { sharedDatabaseProblem, sameDatabase } = require("../shell/boot-checks");
  const perfin = "postgres://u:p@db.example:5432/perfin?sslmode=require";
  it("PERSISTENT_DATABASE_URL unset → refused", () => {
    assert.match(sharedDatabaseProblem({ NEON_DATABASE_URL: perfin }), /PERSISTENT_DATABASE_URL is not set/);
  });
  it("the same host, port and database under another user or options → refused", () => {
    assert.match(sharedDatabaseProblem({ NEON_DATABASE_URL: perfin, PERSISTENT_DATABASE_URL: "postgres://other:x@DB.example/perfin" }), /same database/);
    assert.equal(sameDatabase("postgres://a@h:5433/x", "postgres://a@h/x"), false, "another port is another server");
  });
  it("a separate database passes; ALLOW_SHARED_DATABASE=true opts in", () => {
    assert.equal(sharedDatabaseProblem({ NEON_DATABASE_URL: perfin, PERSISTENT_DATABASE_URL: "postgres://u:p@db.example:5432/persistent" }), null);
    assert.equal(sharedDatabaseProblem({ NEON_DATABASE_URL: perfin, ALLOW_SHARED_DATABASE: "true" }), null);
  });
  it("shell start() runs the check before either sub-app starts", () => {
    const src = read("shell", "index.js");
    const start = src.slice(src.indexOf("async function start()"));
    assert.ok(start.indexOf("sharedDatabaseProblem(process.env)") > -1);
    assert.ok(start.indexOf("sharedDatabaseProblem(process.env)") < start.indexOf("await perfin.start("));
  });
});

// ---------------------------------------------------------------------------
describe("F2 — a DISCONNECTED Teller enrollment is restored only after Teller answered", () => {
  const tellerApi = require("../teller/services/teller-api");
  const originalTellerRequest = tellerApi.tellerRequest;
  let enr, log, accounts, teller;
  before(() => {
    tellerApi.tellerRequest = (endpoint, token) => teller(endpoint, token);
    delete require.cache[require.resolve("../teller/routes/enrollments")];
    enr = require("../teller/routes/enrollments");
  });
  after(() => {
    tellerApi.tellerRequest = originalTellerRequest;
    delete require.cache[require.resolve("../teller/routes/enrollments")];
  });
  beforeEach(() => {
    log = [];
    dbModule.pool.query = async (sql, params) => {
      log.push(sql);
      if (sql.includes("FROM teller_enrollments te") && sql.includes("status != 'SUSPENDED'")) {
        return { rows: [{ id: 7, enrollment_id: "enr_7", institution_name: "TestBank", access_token: "tok", last_synced_txn_date: null, status: "DISCONNECTED" }] };
      }
      if (sql.includes("FROM linked_accounts WHERE teller_enrollment_id")) return { rows: accounts.map((a) => ({ account_id: a })) };
      if (sql.includes("INSERT INTO transactions") && sql.includes("RETURNING (xmax = 0)")) return { rows: [{ inserted: true }] };
      if (sql.includes("last_anomaly_check_at FROM user_settings")) return { rows: [{ last_anomaly_check_at: new Date() }] };
      return { rows: [] };
    };
    dbModule.pool.connect = async () => ({ query: dbModule.pool.query, release() {} });
  });
  afterEach(() => { dbModule.pool.query = originalQuery; dbModule.pool.connect = originalConnect; });
  const restored = () => log.filter((s) => /SET status = 'GOOD'/.test(s)).length;
  const quietly = async (fn) => { const q = console.error; console.error = () => {}; try { return await fn(); } finally { console.error = q; } };

  it("every account's fetch failed with a 5xx / timeout → stays DISCONNECTED", async () => {
    accounts = ["a1", "a2"];
    teller = async () => { throw Object.assign(new Error("Teller API error 503"), { status: 503 }); };
    await quietly(() => enr.syncAllEnrollments());
    assert.equal(restored(), 0);
  });

  it("an enrollment with no linked accounts proves nothing → stays DISCONNECTED", async () => {
    accounts = [];
    teller = async () => [];
    await enr.syncAllEnrollments();
    assert.equal(restored(), 0);
  });

  it("one account answered (even with no new rows) → restored to GOOD", async () => {
    accounts = ["a1", "a2"];
    teller = async (ep) => {
      if (ep.includes("a2")) throw Object.assign(new Error("timeout"), { status: undefined });
      return [];
    };
    await quietly(() => enr.syncAllEnrollments());
    assert.equal(restored(), 1);
  });
});

// ---------------------------------------------------------------------------
describe("F28 — the pre-auth biometric probes", () => {
  it("authenticate-options and /available sit behind a plain per-IP limiter (every request counts)", () => {
    const src = read("shell", "index.js");
    const def = src.slice(src.indexOf("const webauthnProbeLimiter = rateLimit({"));
    const body = def.slice(0, def.indexOf("});"));
    assert.doesNotMatch(body, /skipSuccessfulRequests/);
    assert.match(src, /app\.use\("\/api\/shell\/webauthn\/authenticate-options", webauthnProbeLimiter\)/);
    assert.match(src, /app\.use\("\/api\/shell\/webauthn\/available", webauthnProbeLimiter\)/);
    assert.match(src, /app\.use\("\/api\/shell\/webauthn\/authenticate", authLimiter\)/);
    assert.ok(src.indexOf('app.use("/api/shell/webauthn/available", webauthnProbeLimiter)') < src.indexOf("webauthn.attach(app, perfin.pool)"),
      "the limiter must run before the probe handlers");
  });

  it("outstanding challenges never exceed MAX_CHALLENGES", async () => {
    let simplewebauthn;
    try { simplewebauthn = require("@simplewebauthn/server"); } catch { return; }
    assert.ok(simplewebauthn);
    const webauthn = require("../shell/middleware/webauthn");
    webauthn._challenges.clear();
    const app = express();
    const fakePool = { query: async () => ({ rows: [{ credential_id: "AAAA", transports: null }] }) };
    webauthn.attach(app, fakePool);
    for (let i = 0; i < webauthn.MAX_CHALLENGES + 5; i++) {
      await supertest(app).post("/api/shell/webauthn/authenticate-options").expect(200);
    }
    assert.equal(webauthn._challenges.size, webauthn.MAX_CHALLENGES);
    webauthn._challenges.clear();
  });
});

// ---------------------------------------------------------------------------
describe("F30 — the x-api-key limiter counts wrong keys only", () => {
  it("success is a valid key, not an HTTP status below 400", () => {
    const src = read("shell", "index.js");
    const def = src.slice(src.indexOf("const apiKeyLimiter = rateLimit({"));
    assert.match(def.slice(0, def.indexOf("});")), /requestWasSuccessful: \(req\) => auth\.isValidApiKey\(req\)/);
  });
  it("isValidApiKey is exported and compares the header with API_KEY", () => {
    const auth = require("../shell/middleware/auth");
    const prev = process.env.API_KEY;
    process.env.API_KEY = "k-123";
    try {
      assert.equal(auth.isValidApiKey({ headers: { "x-api-key": "k-123" } }), true);
      assert.equal(auth.isValidApiKey({ headers: { "x-api-key": "nope" } }), false);
      assert.equal(auth.isValidApiKey({ headers: {} }), false);
    } finally { if (prev === undefined) delete process.env.API_KEY; else process.env.API_KEY = prev; }
  });
});
