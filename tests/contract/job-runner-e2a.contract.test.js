// Real-Postgres contract test for cycle-8 E2a (ST1) — the job runner's claim
// on the real job_runs table:
//  - two runners (a deploy overlap) checking at once run each due job once
//  - a new runner (a restart) right after a run reads last_ran_at and runs
//    nothing; once a job's stored run is older than its cadence it runs again
//  - the claim leaves the heartbeat columns job-health writes alone, and a
//    job-health flush leaves last_ran_at alone
const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { SKIP, perfinDb } = require("./_setup");

describe("Job runner claims (cycle-8 E2a) on real Postgres", { skip: SKIP }, () => {
  let pool;
  const q = (s, p) => pool.query(s, p);
  const { createJobRunner } = require("../../teller/services/job-runner");
  const quiet = { error: () => {} };

  function runner(counts) {
    const r = createJobRunner({ pool, gapMs: 0, log: quiet });
    for (const name of ["e2a-cash", "e2a-digest"]) {
      r.register({ name, everyMs: 60 * 60 * 1000, run: async () => { counts[name] = (counts[name] || 0) + 1; await new Promise((res) => setTimeout(res, 20)); } });
    }
    return r;
  }

  before(async () => { pool = await perfinDb("job_runner_e2a"); });
  after(async () => { if (pool) await pool.end(); });

  it("two runners checking at once run each due job once", async () => {
    const counts = {};
    const [a, b] = [runner(counts), runner(counts)];
    const [ra, rb] = await Promise.all([a.check(), b.check()]);
    assert.deepEqual(counts, { "e2a-cash": 1, "e2a-digest": 1 });
    assert.deepEqual([...ra.ran, ...rb.ran].sort(), ["e2a-cash", "e2a-digest"]);
    const rows = (await q("SELECT job_name, last_ran_at IS NOT NULL AS ran, last_status FROM job_runs WHERE job_name LIKE 'e2a-%' ORDER BY job_name")).rows;
    assert.deepEqual(rows, [{ job_name: "e2a-cash", ran: true, last_status: null }, { job_name: "e2a-digest", ran: true, last_status: null }]);
  });

  it("a restarted runner reads last_ran_at and runs nothing; an old enough run is due again", async () => {
    const counts = {};
    const c = runner(counts);
    assert.deepEqual((await c.check()).ran, []);
    assert.deepEqual(counts, {});
    await q("UPDATE job_runs SET last_ran_at = now() - interval '2 hours' WHERE job_name = 'e2a-cash'");
    const d = runner(counts);
    assert.deepEqual((await d.check()).ran, ["e2a-cash"]);
    // 55 minutes ago is past the claim's 90% slack but not the runner's own
    // cadence — a fresh runner doesn't consider it due, so nothing queries.
    await q("UPDATE job_runs SET last_ran_at = now() - interval '55 minutes' WHERE job_name = 'e2a-digest'");
    assert.deepEqual((await runner(counts).check()).ran, []);
  });

  it("the claim and job-health's flush leave each other's columns alone", async () => {
    const jobHealth = require("../../teller/services/job-health");
    const before = (await q("SELECT last_ran_at FROM job_runs WHERE job_name = 'e2a-cash'")).rows[0].last_ran_at;
    jobHealth.tick("e2a-cash");
    jobHealth.result("e2a-cash", { ok: false, error: "boom" });
    await jobHealth.flush(pool);
    const row = (await q("SELECT last_ran_at, last_status, last_error FROM job_runs WHERE job_name = 'e2a-cash'")).rows[0];
    assert.equal(row.last_ran_at.getTime(), before.getTime());
    assert.equal(row.last_status, "error");
    await q("UPDATE job_runs SET last_ran_at = now() - interval '2 hours' WHERE job_name = 'e2a-cash'");
    const counts = {};
    await runner(counts).check();
    const after = (await q("SELECT last_status, last_error FROM job_runs WHERE job_name = 'e2a-cash'")).rows[0];
    assert.deepEqual(after, { last_status: "error", last_error: "boom" }, "the claim doesn't touch the outcome");
  });
});
