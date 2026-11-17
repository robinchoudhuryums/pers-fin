// ============================================================================
// Cycle 9 Batch 2 — pre-auth and scheduler safety
// ============================================================================
// F3   a non-string session cookie ("j:{}" — cookie-parser makes it an object)
//      and a PIN that isn't a string or number never make an async shell
//      handler throw: a redirect / 401, no unhandled rejection
// F2   the "Scheduled jobs missed" push can fire: the outage is judged from the
//      runner's first read of job_runs.last_ran_at (before this process claimed
//      anything), not from heartbeats the watchdog has just written
// F5   a failed outcome doesn't stick once the job stops running its body: a
//      job that finds itself switched off, a quiet-hours release that ran
//      clean, a watchdog pass that finished
// F4   standalone Perfin: a path under /api never skips the PIN gate for
//      ending in .js / .css
// F10  keep-alive: a failed settings read is never cached; keep-alive.yml fails
//      when its schedule call is rejected or never answered (run in bash)
// F11  stop() ends the runner's gap between two jobs at once
// ============================================================================
if (!process.env.NEON_DATABASE_URL) process.env.NEON_DATABASE_URL = "postgres://mock:mock@localhost/mock";
if (!process.env.TOKEN_ENCRYPTION_PASSPHRASE) process.env.TOKEN_ENCRYPTION_PASSPHRASE = "test-passphrase";
const PIN = "246810";
process.env.SHELL_PIN = PIN;
process.env.SHELL_SECRET = "cycle9-b2-test-secret";
// F4: a standalone Perfin with a PIN and NO API key.
process.env.SESSION_PIN = "4321";
delete process.env.SESSION_PASSWORD;
delete process.env.API_KEY;
delete process.env.NODE_ENV;
delete process.env.ANTHROPIC_API_KEY;

const { describe, it, before, after, beforeEach, afterEach, mock } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFile, execFileSync } = require("child_process");
const express = require("express");
const supertest = require("supertest");

const ROOT = path.join(__dirname, "..");
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), "utf8");
const HOUR = 60 * 60 * 1000;
const settle = async (n = 30) => { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)); };

const dbModule = require("../teller/services/database");
const originalQuery = dbModule.pool.query;
const auth = require("../shell/middleware/auth");
const jobHealth = require("../teller/services/job-health");
const { createJobRunner, CLAIM_SQL, LOAD_SQL, LAST_RAN_SQL, DEFAULTS } = require("../teller/services/job-runner");
const startup = require("../teller/startup");

function resetJobHealth() {
  jobHealth._memoryTicks.clear();
  jobHealth._memoryResults.clear();
  jobHealth._latestOutcomes.clear();
  jobHealth._flushedTicks.clear();
  jobHealth._resetBootGap();
}

// Collects unhandled rejections while fn runs.
async function noRejections(fn) {
  const rejections = [];
  const onRej = (r) => rejections.push(r);
  process.on("unhandledRejection", onRej);
  try {
    await fn();
    await settle(5);
  } finally {
    process.off("unhandledRejection", onRej);
  }
  assert.deepEqual(rejections.map((r) => String(r && r.message)), [], "no unhandled rejection");
}

// ---------------------------------------------------------------------------
describe("F3 — pre-auth input can't make an async shell handler throw", () => {
  function shellApp() {
    const app = express();
    app.use(require("cookie-parser")());
    app.use(express.json());
    app.post("/login", auth.handleLogin);
    app.post("/logout", auth.handleLogout);
    app.use(auth.requireAuth);
    app.get("/perfin/dashboard", (_req, res) => res.send("in"));
    app.get("/perfin/api/thing", (_req, res) => res.json({ ok: true }));
    return app;
  }
  afterEach(() => auth._resetPinFailures());

  it("cookie-parser really turns shell_session=j:{} into an object", async () => {
    const app = express();
    app.use(require("cookie-parser")());
    app.get("/", (req, res) => res.json({ type: typeof req.cookies.shell_session }));
    const res = await supertest(app).get("/").set("Cookie", "shell_session=j:{}");
    assert.equal(res.body.type, "object");
  });

  it("a page request with the object cookie is redirected to the login, an API request gets 401", async () => {
    await noRejections(async () => {
      const page = await supertest(shellApp()).get("/perfin/dashboard").set("Accept", "text/html")
        .set("Cookie", "shell_session=j:{}").timeout(5000);
      assert.equal(page.status, 302);
      assert.match(page.headers.location, /^\/login\?return_to=/);
      const api = await supertest(shellApp()).get("/perfin/api/thing").set("Accept", "application/json")
        .set("Cookie", 'shell_session=j:{"a":1}').timeout(5000);
      assert.equal(api.status, 401);
    });
  });

  it("Sign Out Everywhere with the object cookie is a 401", async () => {
    await noRejections(async () => {
      const res = await supertest(shellApp()).post("/logout?everywhere=1").set("Cookie", "shell_session=j:[1]").timeout(5000);
      assert.equal(res.status, 401);
    });
  });

  it("isValidSession is false for every non-string value", () => {
    for (const v of [{}, [], 7, true, null, undefined, { lastIndexOf: 1 }]) assert.equal(auth.isValidSession(v), false);
    assert.equal(auth.isValidSession(auth.makeSession(60000)), true, "a real session still verifies");
  });

  it("a PIN object whose toString is null is a 401 — it used to throw in String()", async () => {
    assert.throws(() => String({ toString: null }), TypeError, "the input that used to reach String()");
    await noRejections(async () => {
      const res = await supertest(shellApp()).post("/login").send({ pin: { toString: null } }).timeout(5000);
      assert.equal(res.status, 401);
      assert.equal(res.body.error, "Incorrect PIN.");
    });
  });

  it("an array or boolean PIN is never read as text; a string or number PIN still logs in", async () => {
    const asArray = await supertest(shellApp()).post("/login").send({ pin: [PIN] }).timeout(5000);
    assert.equal(asArray.status, 401, "String([PIN]) equals the PIN — an array must not log in");
    const asBool = await supertest(shellApp()).post("/login").send({ pin: true }).timeout(5000);
    assert.equal(asBool.status, 401);
    auth._resetPinFailures();
    const asString = await supertest(shellApp()).post("/login").send({ pin: PIN });
    assert.equal(asString.status, 200);
    assert.equal(asString.body.ok, true);
    assert.match(String(asString.headers["set-cookie"]), /shell_session=/);
    const asNumber = await supertest(shellApp()).post("/login").send({ pin: Number(PIN) });
    assert.equal(asNumber.status, 200);
  });
});

// ---------------------------------------------------------------------------
describe("F2 — the missed-job watchdog judges the outage from the boot snapshot", () => {
  beforeEach(resetJobHealth);
  afterEach(resetJobHealth);

  // job_runs as the watchdog sees it: an upsert is recorded, the read answers
  // with what was upserted (as Postgres would) plus any seeded rows.
  function watchdogPool({ rows = [] } = {}) {
    const stored = new Map(rows.map((r) => [r.job_name, r]));
    const calls = [];
    return {
      calls, stored,
      query: async (sql, params) => {
        calls.push({ sql, params });
        if (/^\s*INSERT INTO job_runs/i.test(sql)) {
          // heartbeat: [name, tick ms, status, error]; signature: [_watchdog, status, signature]
          const [name, a, b, c] = params;
          if (name === "_watchdog") stored.set(name, { job_name: name, last_run_at: new Date().toISOString(), last_error: b });
          else stored.set(name, { job_name: name, last_run_at: new Date(a).toISOString(), last_error: b === "error" ? c : null });
          return { rows: [] };
        }
        if (/^\s*SELECT job_name/i.test(sql)) return { rows: [...stored.values()] };
        return { rows: [] };
      },
    };
  }
  const jobs = (...gated) => Object.keys(jobHealth.JOB_INTERVALS_MS).map((name) => ({ name, gated: gated.includes(name) }))
    .concat([{ name: "job-watchdog", gated: true }]);

  it("the old flush-then-read alone finds nothing after an outage: the heartbeats it reads were just written", async () => {
    // Production order: the runner ticks every job, then the watchdog runs.
    const staleAt = new Date(Date.now() - 72 * HOUR).toISOString();
    const pool = watchdogPool({ rows: Object.keys(jobHealth.JOB_INTERVALS_MS).map((job_name) => ({ job_name, last_run_at: staleAt, last_error: null })) });
    for (const name of Object.keys(jobHealth.JOB_INTERVALS_MS)) jobHealth.tick(name);
    const sent = [];
    const { missed } = await jobHealth.checkMissedJobs(pool, { sendToAll: async (p) => sent.push(p) });
    assert.deepEqual(missed, [], "without a boot snapshot nothing is missed — which is why the snapshot exists");
    assert.equal(sent.length, 0);
  });

  it("noteBootSnapshot: an ungated job last claimed 40 h ago is missed; gated, never-claimed and recent ones aren't", () => {
    const at = Date.now();
    const lastRan = new Map([
      ["cash-alerts", at - 40 * HOUR],
      ["bank-auto-sync", at - 37 * HOUR],
      ["budget-alerts", at - 35 * HOUR], // under the 36 h floor
      ["net-worth-snapshot", at - 90 * HOUR], // activity-gated
      ["notify-release", at - 400 * HOUR], // gated on a hold
      ["daily-digest", at - 2 * HOUR],
      // linked-tasks: never claimed
    ]);
    const found = jobHealth.noteBootSnapshot({ at, lastRan, jobs: jobs("net-worth-snapshot", "notify-release", "goal-milestones", "budget-snapshot", "sheets-auto-sync") });
    assert.deepEqual(found, [{ job: "cash-alerts", stale_hours: 40 }, { job: "bank-auto-sync", stale_hours: 37 }]
      .sort((a, b) => Object.keys(jobHealth.JOB_INTERVALS_MS).indexOf(a.job) - Object.keys(jobHealth.JOB_INTERVALS_MS).indexOf(b.job)));
  });

  it("a normal night asleep (12 h) and an unwatched job are never a gap", () => {
    const at = Date.now();
    assert.deepEqual(jobHealth.noteBootSnapshot({ at, lastRan: new Map([["cash-alerts", at - 12 * HOUR], ["job-watchdog", at - 99 * HOUR]]), jobs: jobs() }), []);
    assert.deepEqual(jobHealth.noteBootSnapshot({}), [], "an empty snapshot is harmless");
  });

  it("after a 40-hour outage the watchdog notifies once, with fresh heartbeats in memory, then resets silently", async () => {
    const at = Date.now();
    const pool = watchdogPool();
    jobHealth.noteBootSnapshot({ at, lastRan: new Map([["cash-alerts", at - 40 * HOUR], ["csv-reminder", at - 41 * HOUR]]), jobs: jobs() });
    for (const name of Object.keys(jobHealth.JOB_INTERVALS_MS)) jobHealth.tick(name); // the runner's onCheck
    const sent = [];
    const sendToAll = async (p) => sent.push(p);

    const first = await jobHealth.checkMissedJobs(pool, { sendToAll });
    assert.deepEqual(first.missed.map((m) => m.job).sort(), ["cash-alerts", "csv-reminder"]);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].tag, "jobs-missed");
    assert.match(sent[0].body, /^2 background job\(s\) haven't run: /);
    assert.match(sent[0].body, /cash-alerts \(40h\)/);
    assert.equal(pool.stored.get("_watchdog").last_error, "cash-alerts|csv-reminder", "the signature is stored");

    // Six hours on, same process: the gap was reported, nothing is missed.
    const second = await jobHealth.checkMissedJobs(pool, { sendToAll });
    assert.deepEqual(second.missed, []);
    assert.equal(sent.length, 1, "no second push");
    assert.equal(pool.stored.get("_watchdog").last_error, "", "the signature resets, so the next outage notifies again");
  });

  it("the same outage found by a second boot doesn't notify twice; a later runner start can't erase an unreported gap", async () => {
    const at = Date.now();
    const pool = watchdogPool({ rows: [{ job_name: "_watchdog", last_run_at: new Date().toISOString(), last_error: "cash-alerts" }] });
    jobHealth.noteBootSnapshot({ at, lastRan: new Map([["cash-alerts", at - 50 * HOUR]]), jobs: jobs() });
    // A second runner started in this process reads fresh stamps.
    assert.deepEqual(jobHealth.noteBootSnapshot({ at, lastRan: new Map([["cash-alerts", at - 1000]]), jobs: jobs() }), []);
    const sent = [];
    const { missed } = await jobHealth.checkMissedJobs(pool, { sendToAll: async (p) => sent.push(p) });
    assert.deepEqual(missed.map((m) => m.job), ["cash-alerts"], "the first gap is still reported");
    assert.equal(sent.length, 0, "an unchanged signature doesn't re-notify");
  });

  it("the runner hands over its first read before it claims anything, once", async () => {
    const t0 = Date.UTC(2026, 10, 17, 12);
    const store = new Map([["a", t0 - 40 * HOUR], ["b", t0 - 30 * 60 * 1000]]);
    const order = [];
    const pool = {
      query: async (sql, params) => {
        if (sql === LOAD_SQL) { order.push("load"); return { rows: params[0].filter((n) => store.has(n)).map((n) => ({ job_name: n, ran_ms: store.get(n) })) }; }
        if (sql === CLAIM_SQL) { order.push("claim:" + params[0]); store.set(params[0], t0); return { rows: [{ prev_ms: null }] }; }
        if (sql === LAST_RAN_SQL) return { rows: [] };
        throw new Error("unexpected " + sql);
      },
    };
    const snapshots = [];
    const runner = createJobRunner({
      pool, now: () => t0, sleep: async () => {}, log: { error() {} },
      onLoad: (s) => { order.push("onLoad"); snapshots.push(s); },
    });
    runner.register({ name: "a", everyMs: HOUR, run: async () => {} });
    runner.register({ name: "b", everyMs: HOUR, run: async () => {}, when: () => true });
    runner.register({ name: "c", everyMs: HOUR, run: async () => {} });
    await runner.check();
    await runner.check();
    assert.deepEqual(order.slice(0, 3), ["load", "onLoad", "claim:c"], "the snapshot comes before the first claim (c never ran, so it is first)");
    assert.equal(snapshots.length, 1, "one read, one snapshot");
    assert.equal(snapshots[0].at, t0);
    assert.deepEqual([...snapshots[0].lastRan], [["a", t0 - 40 * HOUR], ["b", t0 - 30 * 60 * 1000]], "the stored times, not this process's claims");
    assert.deepEqual(snapshots[0].jobs.map((j) => [j.name, j.gated]), [["a", false], ["b", true], ["c", false]]);
    snapshots[0].lastRan.set("a", 1);
    assert.notEqual(runner._lastRan.get("a"), 1, "the snapshot is a copy");
  });

  it("a failed job_runs read hands over nothing; a throwing onLoad never stops the check", async () => {
    let called = 0;
    const failing = createJobRunner({
      pool: { query: async (sql) => { if (sql === LOAD_SQL) throw new Error("down"); return { rows: [{ prev_ms: null }] }; } },
      sleep: async () => {}, log: { error() {} }, onLoad: () => { called++; },
    });
    failing.register({ name: "a", everyMs: HOUR, run: async () => {} });
    await failing.check();
    assert.equal(called, 0);

    const ran = [];
    const throwing = createJobRunner({
      pool: { query: async (sql) => (sql === LOAD_SQL ? { rows: [] } : { rows: [{ prev_ms: null }] }) },
      sleep: async () => {}, log: { error() {} }, onLoad: () => { throw new Error("boom"); },
    });
    throwing.register({ name: "a", everyMs: HOUR, run: async () => { ran.push("a"); } });
    await throwing.check();
    assert.deepEqual(ran, ["a"]);
  });

  it("startup.js passes the snapshot to job-health", () => {
    assert.match(read("teller", "startup.js"), /onLoad: \(snapshot\) => jobHealth\.noteBootSnapshot\(snapshot\)/);
  });
});

// ---------------------------------------------------------------------------
describe("F2 / F5 — the real registry after an outage (mock timers)", () => {
  const notifications = require("../teller/routes/notifications");
  const originalSend = notifications.sendToAll;
  let queries, ranMs, quiet, sent;
  beforeEach(() => {
    quiet = console.error;
    console.error = () => {};
    queries = [];
    sent = [];
    resetJobHealth();
    startup._awayJobs.reset();
    startup.touchActivity(); // the watchdog is activity-gated; a boot counts
    notifications.sendToAll = async (p) => { sent.push(p); return { logged: true }; };
    dbModule.pool.query = async (sql, params) => {
      queries.push({ sql, params });
      if (sql === LOAD_SQL) return { rows: ranMs == null ? [] : params[0].map((n) => ({ job_name: n, ran_ms: ranMs })) };
      if (sql === CLAIM_SQL) return { rows: [{ prev_ms: null }] };
      return { rows: [] };
    };
    mock.timers.enable({ apis: ["setTimeout"] });
  });
  afterEach(async () => {
    await startup.stopBackgroundJobs();
    mock.timers.reset();
    await settle();
    dbModule.pool.query = originalQuery;
    notifications.sendToAll = originalSend;
    console.error = quiet;
    resetJobHealth();
    startup._awayJobs.reset();
  });
  async function firstCheck() {
    const total = DEFAULTS.firstCheckMs + 20 * DEFAULTS.gapMs;
    for (let t = 0; t < total; t += 1000) { mock.timers.tick(1000); await settle(); }
  }
  const UNGATED = ["cash-alerts", "linked-tasks", "advice-plan", "budget-alerts", "housing-ledger", "csv-reminder",
    "daily-digest", "weekly-digest", "self-healing-reconcile", "bank-auto-sync", "insights-auto-trigger"];

  it("every job last ran 40 hours ago → one \"Scheduled jobs missed\" push naming the ungated jobs", async () => {
    ranMs = Date.now() - 40 * HOUR;
    startup.startBackgroundJobs();
    await firstCheck();
    const missed = sent.filter((p) => p.tag === "jobs-missed");
    assert.equal(missed.length, 1, "the push that could never fire");
    assert.match(missed[0].body, new RegExp("^" + UNGATED.length + " background job\\(s\\) haven't run: "));
    assert.match(missed[0].body, /\(40h\)/);
    const sig = queries.find((q) => /INSERT INTO job_runs/.test(q.sql) && q.params[0] === "_watchdog");
    assert.deepEqual(sig.params[2].split("|"), [...UNGATED].sort(), "the stored signature is exactly the ungated watched jobs");
  });

  it("every job ran 2 hours ago → no push", async () => {
    ranMs = Date.now() - 2 * HOUR;
    startup.startBackgroundJobs();
    await firstCheck();
    assert.deepEqual(sent.filter((p) => p.tag === "jobs-missed"), []);
  });

  it("F5: a watchdog pass that finished clears the deadline failure recorded for an earlier one", async () => {
    jobHealth.result("job-watchdog", { ok: false, error: "didn't finish within 15 minutes" });
    assert.deepEqual(jobHealth.failingJobs(), ["job-watchdog"]);
    ranMs = null; // a first boot: the watchdog runs first
    startup.startBackgroundJobs();
    await firstCheck();
    assert.ok(!jobHealth.failingJobs().includes("job-watchdog"), "the heartbeat no longer pings /fail for it");
  });
});

// ---------------------------------------------------------------------------
describe("F5 — a failed outcome doesn't outlive the job's last reason to fail", () => {
  const jobs = startup._awayJobs;
  const notifications = require("../teller/routes/notifications");
  const originalRelease = notifications.releaseHeldNotifications;
  let quiet;
  beforeEach(() => {
    quiet = console.error;
    console.error = () => {};
    resetJobHealth();
    jobs.reset();
    // Noon UTC (APP_TIMEZONE defaults to UTC): past the digests' 07:00 gate.
    mock.timers.enable({ apis: ["Date"], now: Date.UTC(2026, 5, 15, 12) });
  });
  afterEach(() => {
    mock.timers.reset();
    dbModule.pool.query = originalQuery;
    notifications.releaseHeldNotifications = originalRelease;
    console.error = quiet;
    resetJobHealth();
    jobs.reset();
  });
  const failed = (job) => jobHealth.result(job, { ok: false, error: "earlier failure" });
  const failing = (job) => jobHealth.failingJobs().includes(job);
  const pending = (job) => jobHealth._memoryResults.get(job);

  // Every settings read answers a row with nothing switched on.
  const everythingOff = () => { dbModule.pool.query = async () => ({ rows: [{}] }); };

  for (const [job, tick] of [
    ["weekly-digest", "runWeeklyDigestTick"],
    ["csv-reminder", "runCsvReminderTick"],
    ["bank-auto-sync", "runBankAutoSyncTick"],
    ["cash-alerts", "runCashAlertsTick"],
    ["advice-plan", "runAdvicePlanTick"],
    ["linked-tasks", "runLinkedTasksTick"],
    ["insights-auto-trigger", "runInsightsAutoTriggerTick"],
  ]) {
    it(`${job}: failed, then switched off → the failure is cleared (and written as ok at the next flush)`, async () => {
      failed(job);
      assert.equal(failing(job), true);
      everythingOff();
      await jobs[tick]();
      assert.equal(failing(job), false, "the uptime heartbeat stops pinging /fail");
      assert.deepEqual(pending(job), { status: "ok", error: null }, "Sync Health's last_status is rewritten");
    });
  }

  it("insights-auto-trigger: with an API key, a switched-off setting clears it too", async () => {
    process.env.ANTHROPIC_API_KEY = "test-key";
    try {
      failed("insights-auto-trigger");
      everythingOff();
      await jobs.runInsightsAutoTriggerTick();
      assert.equal(failing("insights-auto-trigger"), false);
    } finally { delete process.env.ANTHROPIC_API_KEY; }
  });

  it("a job that is merely not due keeps its failure — the last real run still failed", async () => {
    failed("bank-auto-sync");
    dbModule.pool.query = async () => ({ rows: [{ auto_sync_enabled: true, auto_sync_interval_hours: 6, last_auto_sync_at: new Date(Date.now() - HOUR).toISOString() }] });
    await jobs.runBankAutoSyncTick();
    assert.equal(failing("bank-auto-sync"), true);
    // and the weekly digest on a day that isn't its weekday
    failed("weekly-digest");
    const weekday = new Date(Date.now()).getUTCDay();
    dbModule.pool.query = async () => ({ rows: [{ weekly_digest_enabled: true, weekly_digest_day: (weekday + 3) % 7 }] });
    await jobs.runWeeklyDigestTick();
    assert.equal(failing("weekly-digest"), true);
  });

  it("notify-release: a failed push, then a run with nothing left to push → cleared", async () => {
    notifications.releaseHeldNotifications = async () => ({ ok: false, outcome: "failed", error: "The held notifications couldn't be pushed — they'll be retried." });
    await jobs.runNotifyReleaseTick();
    assert.equal(failing("notify-release"), true);
    // Quiet hours began again: nothing was attempted, the failure stands.
    notifications.releaseHeldNotifications = async () => ({ ok: true, outcome: "quiet", released: 0, expired: 0 });
    await jobs.runNotifyReleaseTick();
    assert.equal(failing("notify-release"), true, "quiet attempted nothing");
    // The subscription that failed was pruned / the holds expired.
    for (const outcome of ["none", "expired", "released"]) {
      failed("notify-release");
      notifications.releaseHeldNotifications = async () => ({ ok: true, outcome, released: 0, expired: 0 });
      await jobs.runNotifyReleaseTick();
      assert.equal(failing("notify-release"), false, outcome);
    }
  });

  it("the watchdog records a clean outcome when its pass finishes", () => {
    const src = read("teller", "startup.js");
    const body = src.slice(src.indexOf("const runWatchdog = async () => {"), src.indexOf("// The job runner (cycle-8 E2a / E2b, ST1)."));
    assert.match(body, /jobHealth\.result\("job-watchdog", \{ ok: true \}\);\n  \};/);
  });
});

// ---------------------------------------------------------------------------
describe("F4 — standalone Perfin: nothing under /api skips the PIN gate by its suffix", () => {
  let app, queries;
  before(() => {
    dbModule.pool.query = async (sql, params) => { queries.push({ sql, params }); return { rows: [] }; };
    app = require("../teller/server").app;
  });
  beforeEach(() => { queries = []; });
  after(() => { dbModule.pool.query = originalQuery; });
  const xhr = (req) => req.set("X-Requested-With", "XMLHttpRequest").set("Accept", "application/json");

  it("DELETE /api/watchlist/1.js without a session is a 401 and never reaches the handler", async () => {
    const res = await xhr(supertest(app).delete("/api/watchlist/1.js"));
    assert.equal(res.status, 401);
    assert.deepEqual(queries.filter((q) => /watchlist/i.test(q.sql)), [], "no watchlist query ran");
  });

  it("so are the other spellings: .css, an upper-case /API, a GET", async () => {
    assert.equal((await xhr(supertest(app).delete("/api/watchlist/1.css"))).status, 401);
    assert.equal((await xhr(supertest(app).get("/api/transactions/x.js"))).status, 401);
    // Express routes case-insensitively, so /API/… reaches the same handlers:
    // the gate must hold there too (it answers with its login redirect).
    for (const res of [
      await xhr(supertest(app).delete("/API/watchlist/1.js")),
      await xhr(supertest(app).patch("/Api/settings.js").send({ theme: "light" })),
    ]) {
      assert.equal(res.status, 302);
      assert.equal(res.headers.location, "/login");
    }
    assert.deepEqual(queries.filter((q) => /watchlist|UPDATE user_settings/i.test(q.sql)), []);
  });

  it("the pages' own scripts and styles still load signed out", async () => {
    const js = await supertest(app).get("/perfin-shared.js");
    assert.equal(js.status, 200);
    const css = await supertest(app).get("/perfin-shared.css");
    assert.equal(css.status, 200);
    const missing = await supertest(app).get("/no-such-file.js");
    assert.notEqual(missing.status, 401, "a missing asset is a 404, not a login redirect");
    assert.notEqual(missing.status, 302);
  });

  it("the exemption is written against /api in any case", () => {
    assert.match(read("teller", "server.js"), /if \(!\/\^\\\/api\(\\\/\|\$\)\/i\.test\(req\.path\) && \(req\.path\.endsWith\("\.css"\) \|\| req\.path\.endsWith\("\.js"\)\)\) return next\(\);/);
  });
});

// ---------------------------------------------------------------------------
describe("F10 — keep-alive: a failed settings read is never cached", () => {
  const ka = require("../teller/services/keep-alive");
  const ON = { keep_alive_enabled: true, keep_alive_start: 6, keep_alive_end: 0, keep_alive_timezone: "UTC" };
  let warn;
  beforeEach(() => { warn = console.warn; console.warn = () => {}; ka.invalidateKeepAliveCache(); });
  afterEach(() => { console.warn = warn; mock.timers.reset(); dbModule.pool.query = originalQuery; ka.invalidateKeepAliveCache(); });

  it("one failed read answers \"off\" once; the next probe reads again", async () => {
    let q = 0;
    dbModule.pool.query = async () => { q++; if (q === 1) throw new Error("connection terminated"); return { rows: [ON] }; };
    assert.equal((await ka.getKeepAliveConfigCached()).keep_alive_enabled, false, "nothing better to offer yet");
    assert.equal((await ka.getKeepAliveConfigCached()).keep_alive_enabled, true, "it used to stay off for 6 hours");
    assert.equal(q, 2);
    await ka.getKeepAliveConfigCached();
    assert.equal(q, 2, "a good read is cached as before");
  });

  it("when a refresh fails, the last good schedule is served — and the read is retried", async () => {
    mock.timers.enable({ apis: ["Date"], now: Date.UTC(2026, 5, 15, 12) });
    let q = 0, fail = false;
    dbModule.pool.query = async () => { q++; if (fail) throw new Error("down"); return { rows: [ON] }; };
    await ka.getKeepAliveConfigCached();
    mock.timers.setTime(Date.UTC(2026, 5, 15, 19)); // 7 hours on: the cache is stale
    fail = true;
    const stale = await ka.getKeepAliveConfigCached();
    assert.equal(stale.keep_alive_enabled, true, "not \"disabled\"");
    await ka.getKeepAliveConfigCached();
    assert.equal(q, 3, "each probe retries until a read succeeds");
    fail = false;
    await ka.getKeepAliveConfigCached();
    await ka.getKeepAliveConfigCached();
    assert.equal(q, 4, "then the cache holds again");
  });

  it("loadKeepAliveConfig keeps its shape for Per-sistant-style callers", async () => {
    dbModule.pool.query = async () => { throw new Error("down"); };
    assert.deepEqual(await ka.loadKeepAliveConfig(), { keep_alive_enabled: false, keep_alive_start: 6, keep_alive_end: 0, keep_alive_timezone: "America/New_York" });
    dbModule.pool.query = async () => ({ rows: [] });
    assert.equal((await ka.loadKeepAliveConfig()).keep_alive_enabled, false);
  });
});

// ---------------------------------------------------------------------------
function have(cmd, args) { try { execFileSync(cmd, args, { stdio: "ignore" }); return true; } catch { return false; } }
const NO_SHELL_TOOLS = !(have("bash", ["-c", "true"]) && have("curl", ["--version"]) && have("python3", ["--version"]))
  ? "bash, curl and python3 are needed to run the workflow step" : false;

// A workflow `key: |` block, with its own indentation removed.
function blockOf(yaml, key) {
  const lines = yaml.split("\n");
  const i = lines.findIndex((l) => l.trim() === key + ": |");
  assert.ok(i >= 0, key + " not found");
  const indent = lines[i].length - lines[i].trimStart().length + 2;
  const out = [];
  for (const l of lines.slice(i + 1)) {
    if (l.trim() === "") out.push("");
    else if (l.length - l.trimStart().length >= indent) out.push(l.slice(indent));
    else break;
  }
  return out.join("\n");
}

describe("F10 — keep-alive.yml, its step run in bash against a fake server", { skip: NO_SHELL_TOOLS }, () => {
  const yaml = read(".github", "workflows", "keep-alive.yml");
  const script = blockOf(yaml, "run");
  let server, base, mode, hits, tmp;

  before(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "c9b2-"));
    const a = express();
    a.get("/perfin/api/keep-alive-schedule", (req, res) => {
      hits.schedule++;
      hits.key = req.get("x-api-key");
      if (mode === "rejected") return res.status(401).json({ error: "Authentication required", secret_detail: "LEAK-ME" });
      if (mode === "down") return res.status(503).send("LEAK-ME upstream unavailable");
      if (mode === "waking" && hits.schedule < 3) return res.status(502).send("LEAK-ME starting");
      if (mode === "html") return res.status(200).send("<html>LEAK-ME</html>");
      if (mode === "off") return res.json({ enabled: false });
      res.json({ enabled: true, start: 0, end: 0, timezone: "UTC" }); // 24/7
    });
    a.get("/health", (_req, res) => { hits.health++; res.status(mode === "sick" ? 500 : 200).json({ status: "ok" }); });
    await new Promise((resolve) => { server = a.listen(0, "127.0.0.1", resolve); });
    base = "http://127.0.0.1:" + server.address().port;
  });
  after(() => { server.close(); fs.rmSync(tmp, { recursive: true, force: true }); });
  beforeEach(() => { hits = { schedule: 0, health: 0, key: null }; });

  function run(m, env = {}) {
    mode = m;
    return new Promise((resolve) => {
      execFile("bash", ["--noprofile", "--norc", "-eo", "pipefail", "-c", script], {
        env: {
          PATH: process.env.PATH, RUNNER_TEMP: tmp, SERVER_URL: base, API_KEY: "the-key",
          CHECK_STATUS: blockOf(yaml, "CHECK_STATUS"), FETCH_SCHEDULE: blockOf(yaml, "FETCH_SCHEDULE"),
          SCHEDULE_RETRY_SECONDS: "0", SCHEDULE_MAX_TIME: "5", ...env,
        },
        timeout: 30000,
      }, (err, stdout, stderr) => resolve({ code: err ? (err.code ?? 1) : 0, out: stdout + stderr }));
    });
  }

  it("a rejected schedule call (wrong API_KEY secret) fails the run and says which secret — it used to read as \"disabled\"", async () => {
    const r = await run("rejected");
    assert.equal(r.code, 1);
    assert.match(r.out, /::error::Keep-alive: the server rejected the schedule call — check that the API_KEY repository secret/);
    assert.match(r.out, /::error::Keep-alive schedule failed with HTTP 401/);
    assert.doesNotMatch(r.out, /disabled in settings/);
    assert.equal(hits.schedule, 1, "a rejection is not retried");
    assert.equal(hits.health, 0);
    assert.equal(hits.key, "the-key");
  });

  it("a server that stays down fails the run after three tries", async () => {
    const r = await run("down");
    assert.equal(r.code, 1);
    assert.match(r.out, /::error::Keep-alive schedule failed with HTTP 503/);
    assert.equal(hits.schedule, 3);
  });

  it("an unreachable server fails the run", async () => {
    const r = await run("ok", { SERVER_URL: "http://127.0.0.1:9", SCHEDULE_MAX_TIME: "2" });
    assert.equal(r.code, 1);
    assert.match(r.out, /::error::Keep-alive schedule: no response \(timed out or server unreachable\)/);
  });

  it("a host that is still waking is retried, then pinged", async () => {
    const r = await run("waking");
    assert.equal(r.code, 0, r.out);
    assert.equal(hits.schedule, 3);
    assert.match(r.out, /Keep-alive schedule: HTTP 200/);
    assert.match(r.out, /Ping: HTTP 200/);
    assert.equal(hits.health, 1);
  });

  it("keep-alive switched off is still a quiet, green skip", async () => {
    const r = await run("off");
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /Keep-alive disabled in settings, skipping/);
    assert.equal(hits.health, 0);
  });

  it("a 200 that isn't the app's JSON fails the run", async () => {
    const r = await run("html");
    assert.equal(r.code, 1);
    assert.match(r.out, /::error::Keep-alive: the schedule reply was not JSON/);
  });

  it("a failing health ping fails the run with a message", async () => {
    const r = await run("sick");
    assert.equal(r.code, 1);
    assert.match(r.out, /::error::Ping failed with HTTP 500/);
  });

  it("no response body is ever printed (INV-103); no secret set is still a skip", async () => {
    for (const m of ["rejected", "down", "waking", "html", "ok"]) {
      const r = await run(m);
      assert.doesNotMatch(r.out, /LEAK-ME|Authentication required|"enabled"/, m);
    }
    const r = await run("ok", { SERVER_URL: "" });
    assert.equal(r.code, 0);
    assert.match(r.out, /SERVER_URL secret not set, skipping/);
  });

  it("the workflow keeps the shared check_status and never inlines the key", () => {
    assert.match(yaml, /check_status\(\) \{/);
    assert.match(yaml, /eval "\$CHECK_STATUS"/);
    assert.match(yaml, /API_KEY: \$\{\{ secrets\.API_KEY \}\}/);
    assert.doesNotMatch(script, /secrets\./, "secrets reach the script through env only");
    assert.doesNotMatch(script, /\|\| echo '\{\}'/, "the old swallow-everything fallback is gone");
  });
});

// ---------------------------------------------------------------------------
describe("F11 — stop() ends the gap between two jobs", () => {
  function gapRunner() {
    const ran = [];
    const sleeps = [];
    const runner = createJobRunner({
      pool: { query: async (sql) => (sql === LOAD_SQL ? { rows: [] } : { rows: [{ prev_ms: null }] }) },
      // The gap as production has it: a timer that takes 20 s.
      sleep: (ms) => new Promise((resolve) => { sleeps.push(ms); const h = setTimeout(resolve, ms); h.unref(); }),
      log: { error() {} },
    });
    for (const name of ["a", "b", "c"]) runner.register({ name, everyMs: HOUR, run: async () => { ran.push(name); } });
    return { runner, ran, sleeps };
  }
  const within = (promise, ms) => Promise.race([
    promise.then(() => "done"),
    new Promise((resolve) => { const h = setTimeout(() => resolve("still waiting"), ms); h.unref(); }),
  ]);

  it("a stop during the 20-second gap resolves at once and runs no further job", async () => {
    const { runner, ran, sleeps } = gapRunner();
    const check = runner.check();
    await settle();
    assert.deepEqual(ran, ["a"]);
    assert.deepEqual(sleeps, [DEFAULTS.gapMs], "the check is in its gap");
    assert.equal(await within(runner.stop(), 500), "done", "the shell's 7-second wait no longer times out on a sleeping check");
    assert.deepEqual((await check).ran, ["a"]);
    assert.deepEqual(ran, ["a"], "b and c never start");
  });

  it("the gap still separates jobs when nothing stops the runner", async () => {
    const ran = [];
    const sleeps = [];
    const runner = createJobRunner({
      pool: { query: async (sql) => (sql === LOAD_SQL ? { rows: [] } : { rows: [{ prev_ms: null }] }) },
      sleep: async (ms) => { sleeps.push(ms); },
      log: { error() {} },
    });
    for (const name of ["a", "b", "c"]) runner.register({ name, everyMs: HOUR, run: async () => { ran.push(name); } });
    assert.deepEqual((await runner.check()).ran, ["a", "b", "c"]);
    assert.deepEqual(sleeps, [DEFAULTS.gapMs, DEFAULTS.gapMs]);
  });

  it("a stop before any check, and a second stop, are harmless", async () => {
    const { runner } = gapRunner();
    assert.equal(await within(runner.stop(), 200), "done");
    assert.equal(await within(runner.stop(), 200), "done");
  });
});
