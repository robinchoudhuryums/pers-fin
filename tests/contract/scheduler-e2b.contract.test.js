// Real-Postgres contract test for cycle-8 E2b (ST1) — teller/startup.js's real
// job registry on a real (fresh) database:
//  - the first check runs every registered job once (the real bodies, on an
//    empty database) and stamps each one's job_runs.last_ran_at
//  - a restart (a new runner) right after runs nothing
//  - a second process's runner checking at the same moment runs nothing twice
//  - a job whose stored run is older than its cadence runs again; one that ran
//    10 minutes ago doesn't
const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { SKIP, perfinDb } = require("./_setup");

describe("The scheduler on the job runner (cycle-8 E2b) on real Postgres", { skip: SKIP }, () => {
  let pool, startup, jobHealth;
  const q = (s, p) => pool.query(s, p);
  // Never let the runner's own timer fire during the test; checks are called directly.
  const runnerOptions = { gapMs: 0, firstCheckMs: 24 * 60 * 60 * 1000 };

  before(async () => {
    pool = await perfinDb("scheduler_e2b");
    startup = require("../../teller/startup");
    jobHealth = require("../../teller/services/job-health");
  });
  after(async () => {
    if (startup) await startup.stopBackgroundJobs();
    if (pool) await pool.end();
  });

  const names = () => ["job-watchdog", ...Object.keys(jobHealth.JOB_INTERVALS_MS)].sort();

  it("the first check runs every registered job once and stamps last_ran_at", async () => {
    const quiet = console.error;
    console.error = () => {};
    let out;
    try {
      startup.startBackgroundJobs({ runnerOptions });
      out = await startup._scheduler.runner().check();
    } finally { console.error = quiet; }
    assert.deepEqual([...out.ran].sort(), names());
    const rows = (await q("SELECT job_name FROM job_runs WHERE last_ran_at IS NOT NULL ORDER BY job_name")).rows.map((r) => r.job_name);
    assert.deepEqual(rows, names());
  });

  it("a restart right after runs nothing, and neither does a second runner checking at the same moment", async () => {
    await startup.stopBackgroundJobs();
    startup.startBackgroundJobs({ runnerOptions });
    const { createJobRunner } = require("../../teller/services/job-runner");
    const other = createJobRunner({ pool, gapMs: 0, log: { error: () => {} } });
    let otherRan = 0;
    for (const j of startup._scheduler.runner().list()) other.register({ name: j.name, everyMs: j.everyMs, run: async () => { otherRan++; } });
    const [a, b] = await Promise.all([startup._scheduler.runner().check(), other.check()]);
    assert.deepEqual(a.ran, []);
    assert.deepEqual(b.ran, []);
    assert.equal(otherRan, 0);
  });

  it("a job whose stored run is older than its cadence runs again; one that ran 10 minutes ago doesn't", async () => {
    await q("UPDATE job_runs SET last_ran_at = now() - interval '2 hours' WHERE job_name = 'cash-alerts'");
    await q("UPDATE job_runs SET last_ran_at = now() - interval '10 minutes' WHERE job_name = 'csv-reminder'");
    await startup.stopBackgroundJobs();
    const quiet = console.error;
    console.error = () => {};
    let out;
    try {
      startup.startBackgroundJobs({ runnerOptions });
      out = await startup._scheduler.runner().check();
    } finally { console.error = quiet; }
    assert.deepEqual(out.ran, ["cash-alerts"]);
  });
});
