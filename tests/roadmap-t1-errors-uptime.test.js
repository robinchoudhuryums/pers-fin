// ============================================================================
// Roadmap T1.4 — in-app error log + uptime (Batch A)
// ============================================================================
// error-log.js: console.error is wrapped by the shell; every call is grouped
// by a fingerprint, counted in memory, written once a minute to app_errors and
// announced once per new / reopened fingerprint (≤5 a day). Recording never
// throws and never recurses. uptime.js: GET /health/deep (SELECT 1 on both
// databases, bounded, cached, yes/no fields only) and the optional
// HEARTBEAT_URL ping (/fail while a scheduled job's last run failed). The
// database-backed half is tests/contract/error-log.contract.test.js.
// ============================================================================

const { describe, it, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

if (!process.env.NEON_DATABASE_URL) process.env.NEON_DATABASE_URL = "postgres://mock:mock@localhost/mock";
if (!process.env.TOKEN_ENCRYPTION_PASSPHRASE) process.env.TOKEN_ENCRYPTION_PASSPHRASE = "test-passphrase";

// error-log requires ../routes/notifications lazily; give it a recording stub.
const sent = [];
require.cache[require.resolve("../teller/routes/notifications")] = {
  id: "stub", loaded: true, exports: { sendToAll: async (n) => { sent.push(n); } },
};

const errorLog = require("../teller/services/error-log");
const uptime = require("../teller/services/uptime");
const jobHealth = require("../teller/services/job-health");
const oc = require("../teller/services/operator-checks");

const ROOT = path.join(__dirname, "..");
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), "utf8");

// A mock pool recording queries; `answer(sql, params)` decides each result.
function mockPool(answer = () => ({ rows: [] })) {
  const calls = [];
  return {
    calls,
    async query(sql, params) { calls.push({ sql, params }); return answer(sql, params); },
  };
}

beforeEach(() => { errorLog._reset(); sent.length = 0; });

describe("T1.4 error log — capture", () => {
  it("one fingerprint for the same error with different numbers, ids and quoted values; another per source", () => {
    const fp = errorLog._fingerprint;
    const a = fp("perfin", 'sync error for item 1234: relation "x" does not exist (id 9f8e7d6c5b4a)');
    const b = fp("perfin", 'sync error for item 98: relation "y" does not exist (id 0a1b2c3d4e5f)');
    assert.equal(a, b);
    assert.notEqual(a, fp("per-sistant", 'sync error for item 1: relation "x" does not exist (id 9f8e7d6c5b4a)'));
    assert.notEqual(a, fp("perfin", "a different error"));
    assert.match(a, /^[0-9a-f]{16}$/);
  });

  it("describes an Error with its stack, other values as JSON, and survives a circular object", () => {
    const err = new Error("boom");
    const d = errorLog._describe(["Plaid sync failed:", err]);
    assert.equal(d.message, "Plaid sync failed: boom");
    assert.match(d.sample, /^Error: boom\n\s+at /);
    assert.equal(errorLog._describe(["x", { a: 1 }]).message, 'x {"a":1}');
    const circ = {}; circ.self = circ;
    assert.doesNotThrow(() => errorLog._describe(["loop", circ]));
    assert.equal(errorLog._describe([]).message, "(empty error message)");
  });

  it("reads the source app from the caller's frame", () => {
    const stack = (file) => `Error\n    at capture (/app/teller/services/error-log.js:1:1)\n    at errorWithLog (/app/teller/services/error-log.js:2:2)\n    at fn (${file}:3:3)`;
    assert.equal(errorLog._sourceOf(stack("/app/apps/per-sistant/routes/ai.js")), "per-sistant");
    assert.equal(errorLog._sourceOf(stack("/app/teller/routes/enrollments.js")), "perfin");
    assert.equal(errorLog._sourceOf(stack("/app/shell/index.js")), "shell");
    assert.equal(errorLog._sourceOf("Error\n    at node:internal/x:1:1"), "app");
  });

  it("the wrapper still prints, groups repeats into one counted entry, and uninstalls", () => {
    const printed = [];
    const original = (...a) => printed.push(a);
    const target = { error: original };
    const uninstall = errorLog.install(target);
    try {
      target.error("Job X failed:", new Error("timeout 1"));
      target.error("Job X failed:", new Error("timeout 2"));
      target.error("[error-log] its own report is not recorded");
      assert.equal(printed.length, 3, "every call is still printed");
      assert.equal(errorLog._buffer.size, 1);
      const [entry] = errorLog._buffer.values();
      assert.equal(entry.count, 2);
      assert.equal(entry.message, "Job X failed: timeout 2");
      assert.equal(errorLog.install(target)(), undefined, "a second install is a no-op");
    } finally { uninstall(); }
    assert.equal(target.error, original, "the original function is back");
  });

  it("never throws or recurses, and caps the distinct errors held between flushes", () => {
    const evil = { toJSON() { throw new Error("nope"); } };
    assert.doesNotThrow(() => errorLog.capture(["bad", evil], { source: "perfin" }));
    errorLog._state.capturing = true;
    errorLog.capture(["while capturing"], { source: "perfin" });
    errorLog._state.capturing = false;
    assert.equal([...errorLog._buffer.values()].some((e) => e.message === "while capturing"), false);
    for (let i = 0; i < 150; i++) errorLog.capture([`distinct ${"x".repeat(i)}`], { source: "perfin" });
    assert.equal(errorLog._buffer.size, 100);
    assert.ok(errorLog._state.dropped > 0);
  });
});

describe("T1.4 error log — flush, notify, read", () => {
  it("writes one batched upsert per fingerprint, announces a new error once, and marks it notified", async () => {
    errorLog.capture(["Sheets sync failed:", new Error("quota")], { source: "perfin" });
    errorLog.capture(["Sheets sync failed:", new Error("quota")], { source: "perfin" });
    const pool = mockPool((sql) => {
      if (/INSERT INTO app_errors/.test(sql)) return { rows: [{ inserted: true, reopened: false }] };
      if (/count\(\*\)::int AS n FROM app_errors WHERE notified_at/.test(sql)) return { rows: [{ n: 0 }] };
      return { rows: [], rowCount: 1 };
    });
    errorLog._state.pool = pool;
    const r = await errorLog.flush();
    assert.equal(r.written, 1);
    const upsert = pool.calls.find((c) => /INSERT INTO app_errors/.test(c.sql));
    assert.equal(upsert.params[1], "perfin");
    assert.equal(upsert.params[4], 2, "the count of both occurrences");
    assert.equal(sent.length, 1);
    assert.equal(sent[0].title, "New server error");
    assert.match(sent[0].tag, /^app-error-[0-9a-f]{16}$/);
    assert.equal(sent[0].data.url, "/settings#recent-errors");
    assert.ok(pool.calls.some((c) => /UPDATE app_errors SET notified_at = now\(\)/.test(c.sql)));
    assert.equal(errorLog._buffer.size, 0);
  });

  it("a reopened error is announced as back; at 5 notifications in 24h nothing more is sent", async () => {
    errorLog.capture(["one"], { source: "perfin" });
    let n = 0;
    errorLog._state.pool = mockPool((sql) => {
      if (/INSERT INTO app_errors/.test(sql)) return { rows: [{ inserted: false, reopened: true }] };
      if (/WHERE notified_at/.test(sql)) return { rows: [{ n }] };
      return { rows: [] };
    });
    await errorLog.flush();
    assert.equal(sent[0].title, "A server error is back");
    sent.length = 0; n = errorLog.NOTIFY_PER_DAY;
    errorLog.capture(["two"], { source: "perfin" });
    await errorLog.flush();
    assert.equal(sent.length, 0);
  });

  it("an existing, unresolved error is not announced again", async () => {
    errorLog.capture(["again"], { source: "perfin" });
    errorLog._state.pool = mockPool((sql) => (/INSERT INTO app_errors/.test(sql) ? { rows: [{ inserted: false, reopened: false }] } : { rows: [] }));
    await errorLog.flush();
    assert.equal(sent.length, 0);
  });

  it("a failed write keeps the unwritten errors for the next flush and never throws", async () => {
    errorLog.capture(["first"], { source: "perfin" });
    errorLog.capture(["second"], { source: "perfin" });
    errorLog._state.pool = mockPool(() => { throw new Error("db down"); });
    const r = await errorLog.flush();
    assert.equal(r.written, 0);
    assert.equal(errorLog._buffer.size, 2);
    assert.equal(errorLog._state.flushing, false);
  });

  it("flush does nothing before start() gives it a pool", async () => {
    errorLog.capture(["early"], { source: "perfin" });
    assert.deepEqual(await errorLog.flush(), { written: 0 });
    assert.equal(errorLog._buffer.size, 1);
  });

  it("resolve validates the id; list clamps its limit", async () => {
    assert.equal((await errorLog.resolveError(mockPool(), "../etc")).status, 400);
    const missing = await errorLog.resolveError(mockPool(() => ({ rows: [], rowCount: 0 })), "0123456789abcdef");
    assert.equal(missing.status, 404);
    const pool = mockPool(() => ({ rows: [] }));
    await errorLog.listErrors(pool, { limit: "5000" });
    assert.equal(pool.calls[0].params[0], 100);
    assert.match(pool.calls[0].sql, /WHERE resolved_at IS NULL/);
    await errorLog.listErrors(pool, { includeResolved: true });
    assert.doesNotMatch(pool.calls[1].sql, /WHERE resolved_at IS NULL/);
  });
});

describe("T1.4 uptime", () => {
  const okPool = { query: async () => ({ rows: [{ "?column?": 1 }] }) };
  const badPool = { query: async () => { throw new Error("connection refused 10.0.0.5"); } };
  const hangPool = { query: () => new Promise(() => {}) };
  const fakeRes = () => {
    const r = { code: null, body: null, headers: {} };
    r.status = (c) => { r.code = c; return r; };
    r.json = (b) => { r.body = b; return r; };
    r.set = (k, v) => { r.headers[k] = v; return r; };
    return r;
  };

  it("deep health: both databases answer → ok; one fails or hangs → not ok, yes/no fields only", async () => {
    assert.deepEqual(await uptime.deepHealth({ perfinPool: okPool, persistentPool: okPool }), { ok: true, perfin_db: true, persistent_db: true });
    const bad = await uptime.deepHealth({ perfinPool: okPool, persistentPool: badPool });
    assert.deepEqual(bad, { ok: false, perfin_db: true, persistent_db: false });
    assert.doesNotMatch(JSON.stringify(bad), /refused|10\.0\.0/, "no error text in the response");
    const hung = await uptime.deepHealth({ perfinPool: hangPool, persistentPool: okPool, timeoutMs: 30 });
    assert.equal(hung.perfin_db, false);
    assert.equal((await uptime.deepHealth({ perfinPool: okPool })).persistent_db, null, "an unwired pool is not a failure");
  });

  it("the handler answers 503 when down and caches its probe", async () => {
    let queries = 0;
    const counting = { query: async () => { queries++; throw new Error("down"); } };
    const handler = uptime.deepHealthHandler({ perfinPool: counting, persistentPool: okPool, cacheMs: 60000 });
    const r1 = fakeRes(); await handler({}, r1);
    const r2 = fakeRes(); await handler({}, r2);
    assert.equal(r1.code, 503);
    assert.equal(r2.code, 503);
    assert.equal(queries, 1, "the second request is served from the cache");
    assert.equal(r1.headers["Cache-Control"], "no-store");
  });

  it("heartbeat: off without a valid URL; pings the URL, or <url>/fail while a job's last run failed; never throws", async () => {
    assert.equal(uptime.heartbeatUrl({ HEARTBEAT_URL: "hc-ping.com/abc" }), null);
    assert.equal(uptime.heartbeatUrl({ HEARTBEAT_URL: "https://hc-ping.com/abc/" }), "https://hc-ping.com/abc");
    assert.deepEqual(await uptime.pingHeartbeat({ env: {} }), { sent: false, reason: "not_configured" });
    const urls = [];
    const fetchImpl = async (url) => { urls.push(url); return { ok: true, status: 200 }; };
    const env = { HEARTBEAT_URL: "https://hc-ping.com/abc" };
    await uptime.pingHeartbeat({ env, fetchImpl, failingJobs: () => [] });
    await uptime.pingHeartbeat({ env, fetchImpl, failingJobs: () => ["sheets-auto-sync"] });
    assert.deepEqual(urls, ["https://hc-ping.com/abc", "https://hc-ping.com/abc/fail"]);
    const r = await uptime.pingHeartbeat({ env, fetchImpl: async () => { throw new Error("dns"); } });
    assert.equal(r.sent, false);
  });

  it("job-health keeps each job's latest outcome for the heartbeat (no database)", () => {
    jobHealth.result("sheets-auto-sync", { ok: false, error: "quota" });
    jobHealth.result("budget-alerts", { ok: true });
    assert.deepEqual(jobHealth.failingJobs(), ["sheets-auto-sync"]);
    jobHealth._memoryResults.clear(); // a flush clears these — the latest outcome stays
    assert.deepEqual(jobHealth.failingJobs(), ["sheets-auto-sync"]);
    jobHealth.result("sheets-auto-sync", { ok: true });
    assert.deepEqual(jobHealth.failingJobs(), []);
  });

  it("Operator Checks notes a missing heartbeat", () => {
    const without = oc.localChecks({ TOKEN_ENCRYPTION_PASSPHRASE: "x" });
    assert.equal(without.find((c) => c.id === "local:heartbeat").status, "info");
    const withUrl = oc.localChecks({ TOKEN_ENCRYPTION_PASSPHRASE: "x", HEARTBEAT_URL: "https://hc-ping.com/abc" });
    assert.equal(withUrl.find((c) => c.id === "local:heartbeat"), undefined);
  });
});

describe("T1.4 wiring", () => {
  it("the shell installs the wrapper before loading the apps, starts it after their migrations, and flushes on shutdown", () => {
    const shell = read("shell", "index.js");
    assert.ok(shell.indexOf("errorLog.install();") > 0);
    assert.ok(shell.indexOf("errorLog.install();") < shell.indexOf('require("../teller/server")'));
    const started = shell.indexOf("errorLog.start({ pool: perfin.pool });");
    assert.ok(started > shell.indexOf("await persistent.start({ standalone: false });"));
    assert.match(shell, /uptime\.startHeartbeat\(\{ failingJobs: jobHealth\.failingJobs \}\)/);
    assert.match(shell, /await errorLog\.flush\(\{ notify: false, drain: true \}\)/);
    const deep = shell.indexOf('app.get("/health/deep"');
    assert.ok(deep > 0 && deep < shell.indexOf("app.use(auth.requireAuth)"), "public, mounted before the auth gate");
  });

  it("Settings lists recent errors with Resolve; data-health raises unresolved errors from the last 24h", () => {
    const settings = read("teller", "routes", "settings.js");
    assert.match(settings, /router\.get\("\/api\/errors"/);
    assert.match(settings, /router\.post\("\/api\/errors\/:fingerprint\/resolve"/);
    assert.match(settings, /recentUnresolvedCount\(pool, 24\)[\s\S]*?link: "\/settings#recent-errors"/);
    const view = read("teller", "views", "settings.ejs");
    assert.match(view, /id="recent-errors"/);
    assert.match(view, /apiFetch\('\/api\/errors\?limit=20'\)/);
    assert.match(view, /data-resolve-error=/);
    assert.match(view, /loadRecentErrors\(\);/);
  });

  it("the table is migrated, left alone by reset-fresh, and the VPS template documents the heartbeat", () => {
    assert.match(read("teller", "services", "database.js"), /CREATE TABLE IF NOT EXISTS app_errors \(/);
    assert.ok(require("../scripts/reset-fresh").UNTOUCHED_TABLES.includes("app_errors"));
    assert.match(read("deploy", "vps", "app.env.example"), /^HEARTBEAT_URL=$/m);
    assert.match(read("deploy", "vps", "RUNBOOK.md"), /## Monitoring[\s\S]*\/health\/deep/);
  });
});
