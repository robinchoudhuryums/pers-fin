// ============================================================================
// Cycle 8 E2b (ST1) — teller/startup.js schedules through the job runner
// ============================================================================
// The registry: every watched job (JOB_INTERVALS_MS) registered at its cadence,
// plus the watchdog; the activity-gated jobs carry a `when` gate and the away
// channels (INV-77) none; no setInterval / boot timer left. Under node:test
// mock timers over a fake pool: nothing before the first check; on a first
// boot (no job_runs history) the watchdog then every job claimed and run once,
// one at a time 20 s apart, lightest first; a restart right after a run makes
// only the one job_runs read; a stop before the first check queries nothing;
// the runner ticks each watched job on every check; a second
// startBackgroundJobs replaces the runner. The database-backed half is
// tests/contract/scheduler-e2b.contract.test.js.
// ============================================================================
if (!process.env.NEON_DATABASE_URL) process.env.NEON_DATABASE_URL = "postgres://mock:mock@localhost/mock";
if (!process.env.TOKEN_ENCRYPTION_PASSPHRASE) process.env.TOKEN_ENCRYPTION_PASSPHRASE = "test-passphrase";

const { describe, it, beforeEach, afterEach, mock } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const dbModule = require("../teller/services/database");
const jobHealth = require("../teller/services/job-health");
const startup = require("../teller/startup");
const { CLAIM_SQL, LOAD_SQL, DEFAULTS } = require("../teller/services/job-runner");

const HOUR = 60 * 60 * 1000;
const read = (...p) => fs.readFileSync(path.join(__dirname, "..", ...p), "utf8");
const originalQuery = dbModule.pool.query;
const settle = async (n = 30) => { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)); };

const LIGHTEST_FIRST = [
  "job-watchdog", "cash-alerts", "linked-tasks", "advice-plan", "budget-alerts", "housing-ledger", "csv-reminder",
  "daily-digest", "weekly-digest", "goal-milestones", "budget-snapshot", "net-worth-snapshot", "sheets-auto-sync",
  "self-healing-reconcile", "bank-auto-sync", "insights-auto-trigger",
];
const GATED = ["job-watchdog", "goal-milestones", "budget-snapshot", "net-worth-snapshot", "sheets-auto-sync"];

function registry() {
  startup.startBackgroundJobs();
  const list = startup._scheduler.runner().list();
  startup.stopBackgroundJobs();
  return list;
}

describe("the registry", () => {
  it("every watched job at its JOB_INTERVALS_MS cadence, plus the watchdog every 6 hours, lightest first", () => {
    const list = registry();
    assert.deepEqual(list.map((j) => j.name), LIGHTEST_FIRST);
    for (const j of list) {
      if (j.name === "job-watchdog") assert.equal(j.everyMs, 6 * HOUR);
      else assert.equal(j.everyMs, jobHealth.JOB_INTERVALS_MS[j.name], j.name);
    }
    assert.deepEqual(new Set(list.map((j) => j.name).filter((n) => n !== "job-watchdog")), new Set(Object.keys(jobHealth.JOB_INTERVALS_MS)),
      "the registry and the watched set are the same jobs");
    assert.equal(startup._scheduler.WATCHDOG_EVERY_MS, 6 * HOUR);
  });

  it("today's cadences are kept", () => {
    const every = Object.fromEntries(registry().map((j) => [j.name, j.everyMs / HOUR]));
    assert.deepEqual(every, {
      "job-watchdog": 6, "cash-alerts": 1, "linked-tasks": 1, "advice-plan": 1, "budget-alerts": 3, "housing-ledger": 6,
      "csv-reminder": 1, "daily-digest": 1, "weekly-digest": 1, "goal-milestones": 6, "budget-snapshot": 6,
      "net-worth-snapshot": 1, "sheets-auto-sync": 1, "self-healing-reconcile": 1, "bank-auto-sync": 1, "insights-auto-trigger": 6,
    });
  });

  it("only the activity-gated jobs carry a gate; the away channels and the ungated syncs don't (INV-77)", () => {
    const gated = registry().filter((j) => j.gated).map((j) => j.name);
    assert.deepEqual(gated.sort(), [...GATED].sort());
  });

  it("no setInterval or boot timer is left in startup.js", () => {
    const src = read("teller", "startup.js");
    assert.doesNotMatch(src, /setInterval\(/);
    assert.doesNotMatch(src, /scheduleBootRuns|BOOT_FIRST_DELAY_MS|intervalHandles/);
    assert.match(src, /onCheck: \(name\) => \{ if \(name in jobHealth\.JOB_INTERVALS_MS\) jobHealth\.tick\(name\); \}/);
  });
});

describe("scheduling (mock timers)", () => {
  let queries, ranMs, quiet;
  beforeEach(() => {
    quiet = console.error;
    console.error = () => {};
    queries = [];
    ranMs = null;
    jobHealth._memoryTicks.clear();
    startup._awayJobs.reset();
    // job_runs answers from ranMs; a claim succeeds; every other read is empty —
    // each job body finds nothing to do (or is switched off) and returns.
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
    console.error = quiet;
    jobHealth._memoryTicks.clear();
    startup._awayJobs.reset();
  });
  const claims = () => queries.filter((q) => q.sql === CLAIM_SQL).map((q) => q.params[0]);
  async function advance(ms, step = 1000) {
    for (let t = 0; t < ms; t += step) { mock.timers.tick(step); await settle(); }
  }

  it("a first boot: nothing before the first check, then every job claimed and run once, 20 s apart, lightest first", async () => {
    startup.startBackgroundJobs();
    await advance(DEFAULTS.firstCheckMs - 1000);
    assert.equal(queries.length, 0, "no query before the first check");
    await advance(1000);
    assert.equal(queries[0].sql, LOAD_SQL, "the first check reads job_runs once");
    assert.deepEqual(claims(), ["job-watchdog"], "one job, then a 20 s gap");
    await advance(DEFAULTS.gapMs);
    assert.deepEqual(claims(), ["job-watchdog", "cash-alerts"]);
    await advance(DEFAULTS.gapMs * (LIGHTEST_FIRST.length - 2));
    assert.deepEqual(claims(), LIGHTEST_FIRST);
    for (const job of Object.keys(jobHealth.JOB_INTERVALS_MS)) assert.ok(jobHealth._memoryTicks.has(job), `${job} ticked`);
    assert.ok(!jobHealth._memoryTicks.has("job-watchdog"), "the watchdog isn't one of the watched jobs");
    // Nothing is due again within the hour: the 5-minute checks query nothing.
    const n = queries.length;
    await advance(DEFAULTS.checkEveryMs * 2, 10 * 1000);
    assert.equal(queries.length, n);
  });

  it("a restart right after the jobs ran makes only the one job_runs read", async () => {
    ranMs = Date.now() - 5 * 60 * 1000;
    startup.startBackgroundJobs();
    await advance(DEFAULTS.firstCheckMs + DEFAULTS.checkEveryMs, 10 * 1000);
    assert.deepEqual(queries.map((q) => q.sql), [LOAD_SQL]);
  });

  it("stopping before the first check queries nothing", async () => {
    startup.startBackgroundJobs();
    await startup.stopBackgroundJobs();
    await advance(15 * 60 * 1000, 30 * 1000);
    assert.equal(queries.length, 0);
    assert.equal(startup._scheduler.runner(), null);
  });

  it("a second startBackgroundJobs replaces the runner (one first check, not two)", async () => {
    startup.startBackgroundJobs();
    startup.startBackgroundJobs();
    ranMs = Date.now();
    await advance(DEFAULTS.firstCheckMs, 10 * 1000);
    assert.equal(queries.filter((q) => q.sql === LOAD_SQL).length, 1);
  });

  it("runnerOptions reach the runner (the contract test's short gap)", async () => {
    startup.startBackgroundJobs({ runnerOptions: { firstCheckMs: 5000 } });
    ranMs = Date.now();
    await advance(5000);
    assert.equal(queries.filter((q) => q.sql === LOAD_SQL).length, 1);
  });
});
