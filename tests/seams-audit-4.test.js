// Seams & Invariants audit #4, batch S4-2 (scheduler & operator hardening):
//   B4 — the PIN check never states SHELL_PIN's length (INV-126);
//   B5 — shutdown waits (bounded) for the scheduled job in progress before the
//        pools close;
//   B6 — bank auto-sync records the time its run STARTED, so a long run doesn't
//        double the cadence;
//   A3 — the shared-database refusal also compares the databases themselves
//        (name + oid + server start time), so one database reached under two
//        addresses is caught before either app migrates;
//   B1 — every Plaid call has a timeout (the runner's deadlines are in
//        tests/cycle8-e2a.test.js).
// The database-backed half of A3 is tests/contract/seams4-s4-2.contract.test.js.
process.env.NEON_DATABASE_URL = process.env.NEON_DATABASE_URL || "postgres://test:test@127.0.0.1:1/test";
process.env.TOKEN_ENCRYPTION_PASSPHRASE = process.env.TOKEN_ENCRYPTION_PASSPHRASE || "test-passphrase";
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const ROOT = path.join(__dirname, "..");
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), "utf8");

describe("B4 — the PIN check never states SHELL_PIN's length", () => {
  const oc = require("../teller/services/operator-checks");
  const pinCheck = (pin) => oc.localChecks({ SHELL_PIN: pin }).find((c) => c.id === "local:shell-pin");

  it("short → warn, long enough → ok, and neither names the length", () => {
    for (const pin of ["1", "1234", "12345"]) {
      const c = pinCheck(pin);
      assert.equal(c.status, "warn");
      assert.match(c.detail, /shorter than 6 characters/);
      assert.ok(!c.detail.includes(String(pin.length) + " characters"), pin);
    }
    for (const pin of ["123456", "12345678", "1234567890123"]) {
      const c = pinCheck(pin);
      assert.equal(c.status, "ok");
      assert.equal(c.detail, "SHELL_PIN is 6 characters or longer.");
    }
  });
});

describe("B5 — shutdown waits for the running job, bounded", () => {
  const src = read("shell", "index.js");
  const fnSrc = src.slice(src.indexOf("function waitForJobs("), src.indexOf("async function start()"));
  const errors = [];
  const ctx = { setTimeout, clearTimeout, Promise, console: { error: (...a) => errors.push(a.join(" ")) } };
  vm.runInNewContext(fnSrc + "\nthis.waitForJobs = waitForJobs;", ctx);

  it("a job that finishes → done; one that rejects → error, logged; one that never settles → timeout after ms", async () => {
    assert.equal(await ctx.waitForJobs(Promise.resolve(), 50), "done");
    assert.equal(await ctx.waitForJobs(Promise.reject(new Error("boom")), 50), "error");
    assert.ok(errors.some((e) => /Perfin job stop error: boom/.test(e)));
    const t = Date.now();
    assert.equal(await ctx.waitForJobs(new Promise(() => {}), 30), "timeout");
    assert.ok(Date.now() - t < 1000);
    assert.ok(errors.some((e) => /still running at shutdown/.test(e)));
  });

  it("shutdown keeps stopBackgroundJobs' promise and awaits it before the pools close, inside the 10 s forced exit", () => {
    const fn = src.slice(src.indexOf("function shutdown(signal)"));
    assert.match(fn, /jobsStopped = Promise\.resolve\(perfin\.stopBackgroundJobs\(\)\)/);
    const wait = fn.indexOf("await waitForJobs(jobsStopped, SHUTDOWN_JOB_WAIT_MS)");
    assert.ok(wait > -1 && wait < fn.indexOf("perfin.pool.end()"));
    assert.match(src, /const SHUTDOWN_JOB_WAIT_MS = 7000;/);
    assert.match(fn, /process\.exit\(1\); \}, 10000\)/);
  });
});

describe("B6 — bank auto-sync records when its run started", () => {
  const src = read("teller", "startup.js");
  const body = src.slice(src.indexOf("async function runBankAutoSyncTick()"), src.indexOf("async function runSelfHealingReconcileTick()"));

  it("the stamp is the start time, written once the run is over, and due counts from it with a small slack", () => {
    assert.match(src, /const AUTO_SYNC_DUE_SLACK_MS = 2 \* 60 \* 1000;/);
    assert.match(body, /\(now - lastSync\) < dueMs - AUTO_SYNC_DUE_SLACK_MS/);
    assert.match(body, /const startedAt = now;/);
    const stamp = body.indexOf('UPDATE user_settings SET last_auto_sync_at = $1::timestamptz WHERE id = 1", [startedAt.toISOString()]');
    assert.ok(stamp > body.indexOf("await syncAllTransactions()"), "written after the run");
    assert.ok(!/last_auto_sync_at = now\(\)/.test(body), "never the end time");
    assert.match(body, /setNextDue\("bank-auto-sync", startedAt\.getTime\(\) \+ dueMs - AUTO_SYNC_DUE_SLACK_MS\)/);
  });

  it("the long jobs get 30 minutes before the runner moves on; the rest the default", () => {
    const startup = require("../teller/startup");
    startup.startBackgroundJobs({ runnerOptions: { firstCheckMs: 1e9 } });
    try {
      const list = Object.fromEntries(startup._scheduler.runner().list().map((j) => [j.name, j.timeoutMs]));
      for (const name of ["bank-auto-sync", "self-healing-reconcile", "insights-auto-trigger"]) assert.equal(list[name], 30 * 60 * 1000, name);
      assert.equal(list["budget-alerts"], 15 * 60 * 1000);
      assert.match(src, /onTimeout: \(name, ms\) => jobHealth\.result\(name, \{ ok: false, error: `didn't finish within \$\{Math\.round\(ms \/ 60000\)\} minutes` \}\)/);
    } finally {
      startup.stopBackgroundJobs();
    }
  });
});

describe("A3 — one database under two addresses", () => {
  const bc = require("../shell/boot-checks");
  const fakePool = (row, { throws = false } = {}) => ({
    seen: [],
    async query(sql) {
      this.seen.push(sql);
      if (throws) throw new Error("connection refused");
      assert.equal(sql, bc.IDENTITY_SQL);
      return { rows: row ? [row] : [] };
    },
  });
  const id = (db, oid = "16384", started = "2026-11-02 10:00:00.123456+00") => ({ db, oid, started });

  it("databaseIdentity: name | oid | start time; a failed or empty read → null", async () => {
    assert.equal(await bc.databaseIdentity(fakePool(id("neondb"))), "neondb|16384|2026-11-02 10:00:00.123456+00");
    assert.equal(await bc.databaseIdentity(fakePool(null)), null);
    assert.equal(await bc.databaseIdentity(fakePool(id("x"), { throws: true })), null);
    assert.equal(await bc.databaseIdentity(null), null);
  });

  it("poolsShareDatabase: same identity → true; any part different → false; unknown → null without querying a missing pool", async () => {
    assert.equal(await bc.poolsShareDatabase(fakePool(id("neondb")), fakePool(id("neondb"))), true);
    assert.equal(await bc.poolsShareDatabase(fakePool(id("perfin")), fakePool(id("persistent"))), false);
    assert.equal(await bc.poolsShareDatabase(fakePool(id("neondb", "16384")), fakePool(id("neondb", "16390"))), false);
    assert.equal(await bc.poolsShareDatabase(fakePool(id("neondb", "1", "a")), fakePool(id("neondb", "1", "b"))), false, "another server / branch");
    assert.equal(await bc.poolsShareDatabase(fakePool(id("neondb")), fakePool(null, { throws: true })), null);
    const p = fakePool(id("neondb"));
    assert.equal(await bc.poolsShareDatabase(null, p), null);
    assert.equal(p.seen.length, 0);
  });

  it("sharedDatabaseIdentityProblem: refuses the same database, allows separate / unknown / the opt-in", async () => {
    const msg = await bc.sharedDatabaseIdentityProblem({ perfinPool: fakePool(id("neondb")), persistentPool: fakePool(id("neondb")), env: {} });
    assert.match(msg, /reach the same database \(under different addresses\) — refusing to start/);
    assert.match(msg, /ALLOW_SHARED_DATABASE=true/);
    assert.equal(await bc.sharedDatabaseIdentityProblem({ perfinPool: fakePool(id("a")), persistentPool: fakePool(id("b")), env: {} }), null);
    assert.equal(await bc.sharedDatabaseIdentityProblem({ perfinPool: fakePool(id("a")), persistentPool: fakePool(null, { throws: true }), env: {} }), null);
    const shared = fakePool(id("neondb"));
    assert.equal(await bc.sharedDatabaseIdentityProblem({ perfinPool: shared, persistentPool: fakePool(id("neondb")), env: { ALLOW_SHARED_DATABASE: "true" } }), null);
    assert.equal(shared.seen.length, 0, "the opt-in reads nothing");
  });

  it("the shell runs it after the URL check and before either app migrates", () => {
    const src = read("shell", "index.js");
    const start = src.slice(src.indexOf("async function start()"));
    const url = start.indexOf("sharedDatabaseProblem(process.env)");
    const ident = start.indexOf("await sharedDatabaseIdentityProblem({ perfinPool: perfin.pool, persistentPool: persistent.pool, env: process.env })");
    assert.ok(url > -1 && ident > url);
    assert.ok(ident < start.indexOf("await perfin.start("));
    assert.match(start, /if \(identityProblem\) throw new Error\(identityProblem\);/);
  });

  it("Operator Checks' local:databases warns on the same identity under different URLs; separate and unknown stay ok", async () => {
    const oc = require("../teller/services/operator-checks");
    const env = { NEON_DATABASE_URL: "postgres://u:p@ep-x-pooler.example/neondb", PERSISTENT_DATABASE_URL: "postgres://u:p@ep-x.example/neondb", ALLOW_SHARED_DATABASE: "true" };
    const check = async (a, b) => (await oc.goLiveChecks({ pool: a, persistentPool: b, env })).find((c) => c.id === "local:databases");
    const same = await check(fakePool(id("neondb")), fakePool(id("neondb")));
    assert.equal(same.status, "warn");
    assert.match(same.detail, /share one database/);
    assert.equal((await check(fakePool(id("perfin")), fakePool(id("persistent")))).status, "ok");
    assert.equal((await check(fakePool(id("perfin")), fakePool(null, { throws: true }))).status, "ok", "unknown counts as separate");
  });
});

describe("B1 — every Plaid call has a timeout", () => {
  it("the client's axios options carry PLAID_TIMEOUT_MS (90 s)", () => {
    const saved = { id: process.env.PLAID_CLIENT_ID, s: process.env.PLAID_SECRET_SANDBOX, env: process.env.PLAID_ENV };
    process.env.PLAID_CLIENT_ID = "test-client";
    process.env.PLAID_SECRET_SANDBOX = "test-secret";
    delete process.env.PLAID_ENV;
    try {
      const pc = require("../teller/services/plaid-client");
      assert.equal(pc.PLAID_TIMEOUT_MS, 90 * 1000);
      const client = pc.getPlaidClient();
      assert.equal(client.configuration.baseOptions.timeout, 90 * 1000);
    } finally {
      for (const [k, v] of [["PLAID_CLIENT_ID", saved.id], ["PLAID_SECRET_SANDBOX", saved.s], ["PLAID_ENV", saved.env]]) {
        if (v === undefined) delete process.env[k]; else process.env[k] = v;
      }
    }
  });
});
