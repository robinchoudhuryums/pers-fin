// ============================================================================
// Job runner — scheduled jobs run when they are DUE (cycle-8 E2a, ST1)
// ============================================================================
// Each registered job has a cadence (everyMs). A job is due when it hasn't run
// for that long — whether the process just woke, restarted or has been up for
// days. Today's setInterval set (teller/startup.js) instead ran a job one full
// interval after boot (plus one boot run, cycle-8 F27): a short restart re-ran
// every job, and a sleeping host ran the 3- and 6-hour jobs only at boot.
//
// Database use is kept to what a run needs, so an idle Neon still suspends:
//   - start: nothing. The FIRST check (firstCheckMs after start) reads the
//     registered jobs' job_runs.last_ran_at once. A failed read treats every
//     job as due (a missed run is worse than an extra one — every job body is
//     gated by its own watermark / dedup / due time).
//   - every check (checkEveryMs): an in-memory comparison only. No query
//     unless a job is due.
//   - a due job: one claim (a conditional UPSERT of last_ran_at — below), then
//     its run(). Claims make two processes (a deploy overlap) run a job once;
//     a claim another process already took refreshes the in-memory time from
//     the row instead. A claim that fails (database down) runs the job anyway.
//
// A job's `when()` gate (e.g. "the user was active in the last 15 minutes") is
// checked BEFORE the claim, in memory: a gated-off job stays due and costs no
// query, and runs at the first check after the gate opens — not a full
// interval later. A gate that throws counts as closed.
//
// Due jobs run one at a time, oldest-due first (the time each became due;
// registration order breaks a tie), with gapMs between them so a check that
// finds many due (a boot after a long sleep) doesn't hit the database with all
// of them at once. A check never overlaps another. A run that throws is logged
// and the next job runs; the job counts as run (its next run is a cadence
// later — a failing job isn't retried every few minutes; its own outcome goes
// to job-health from its body).
//
// Not wired into teller/startup.js yet — E2b moves the jobs onto it.

const MINUTE = 60 * 1000;
const DEFAULTS = {
  checkEveryMs: 5 * MINUTE,
  firstCheckMs: 1 * MINUTE,
  gapMs: 20 * 1000,
  // A claim succeeds when the stored last run is at least this share of the
  // cadence ago — slack for clock skew between the app and the database.
  claimFactor: 0.9,
};

// The claim: take the job when its stored last run is old enough (or there is
// none), in one statement. Returns the row only when THIS call took it; `prev`
// is the stored time before (the CTE sees the snapshot before the upsert).
const CLAIM_SQL = `
  WITH prev AS (SELECT last_ran_at FROM job_runs WHERE job_name = $1)
  INSERT INTO job_runs (job_name, last_run_at, last_ran_at, updated_at)
  VALUES ($1, now(), now(), now())
  ON CONFLICT (job_name) DO UPDATE SET last_ran_at = now(), updated_at = now()
    WHERE job_runs.last_ran_at IS NULL
       OR job_runs.last_ran_at <= now() - make_interval(secs => $2::float8)
  RETURNING (SELECT (EXTRACT(EPOCH FROM last_ran_at) * 1000)::float8 FROM prev) AS prev_ms`;
const LAST_RAN_SQL = `SELECT (EXTRACT(EPOCH FROM last_ran_at) * 1000)::float8 AS ran_ms FROM job_runs WHERE job_name = $1`;
const LOAD_SQL = `SELECT job_name, (EXTRACT(EPOCH FROM last_ran_at) * 1000)::float8 AS ran_ms
                  FROM job_runs WHERE job_name = ANY($1::text[])`;

function createJobRunner({
  pool,
  now = () => Date.now(),
  setTimer = (fn, ms) => setTimeout(fn, ms),
  clearTimer = (h) => clearTimeout(h),
  sleep = (ms) => new Promise((resolve) => { const h = setTimeout(resolve, ms); if (h && h.unref) h.unref(); }),
  onCheck = null, // (name) — called for every registered job on each check (job-health's tick, E2b)
  log = console,
  ...opts
} = {}) {
  const cfg = { ...DEFAULTS, ...opts };
  const jobs = new Map(); // name → { name, everyMs, run, when, order }
  const lastRan = new Map(); // name → epoch ms of the last run (memory)
  let loaded = false;
  let timer = null;
  let running = false; // started and not stopped
  let stopped = false; // stop() called — a check in progress runs no more jobs
  let checking = null; // the promise of the check in progress

  function register({ name, everyMs, run, when = null }) {
    if (typeof name !== "string" || !name) throw new Error("job name required");
    if (!Number.isFinite(everyMs) || everyMs <= 0) throw new Error(`job ${name}: everyMs must be a positive number`);
    if (typeof run !== "function") throw new Error(`job ${name}: run must be a function`);
    if (jobs.has(name)) throw new Error(`job ${name} registered twice`);
    jobs.set(name, { name, everyMs, run, when, order: jobs.size });
  }

  async function load() {
    loaded = true;
    try {
      const r = await pool.query(LOAD_SQL, [[...jobs.keys()]]);
      for (const row of r.rows) {
        if (row.ran_ms != null && jobs.has(row.job_name)) lastRan.set(row.job_name, Number(row.ran_ms));
      }
    } catch (err) {
      log.error("job runner: could not read job_runs — every job counts as due:", err.message);
    }
  }

  function dueAt(job) {
    const at = lastRan.get(job.name);
    return at == null ? -Infinity : at + job.everyMs;
  }

  function gateOpen(job) {
    if (!job.when) return true;
    try { return !!job.when(); } catch (err) {
      log.error(`job runner: ${job.name}'s gate threw:`, err.message);
      return false;
    }
  }

  // Returns true when this process should run the job now.
  async function claim(job) {
    try {
      const r = await pool.query(CLAIM_SQL, [job.name, (job.everyMs * cfg.claimFactor) / 1000]);
      if (r.rows.length) return true;
      // Another process ran it: take its time so this one waits a cadence.
      try {
        const cur = await pool.query(LAST_RAN_SQL, [job.name]);
        const ms = cur.rows[0] && cur.rows[0].ran_ms;
        lastRan.set(job.name, ms != null ? Number(ms) : now());
      } catch { lastRan.set(job.name, now()); } // its claim proved it ran recently
      return false;
    } catch (err) {
      log.error(`job runner: claim for ${job.name} failed — running it anyway:`, err.message);
      return true;
    }
  }

  async function runCheck() {
    if (!loaded) await load();
    const all = [...jobs.values()];
    if (onCheck) for (const job of all) { try { onCheck(job.name); } catch { /* a heartbeat must never stop the check */ } }
    const t = now();
    const due = all
      .filter((job) => dueAt(job) <= t)
      .sort((a, b) => (dueAt(a) - dueAt(b)) || (a.order - b.order));
    const ran = [];
    let first = true;
    for (const job of due) {
      if (stopped) break;
      if (!gateOpen(job)) continue; // stays due; no query
      if (!first && cfg.gapMs > 0) await sleep(cfg.gapMs);
      if (stopped) break;
      first = false;
      if (!(await claim(job))) continue;
      lastRan.set(job.name, now());
      ran.push(job.name);
      try {
        await job.run();
      } catch (err) {
        log.error(`job runner: ${job.name} failed:`, err && err.message ? err.message : err);
      }
    }
    return { ran };
  }

  // One check: run the due jobs. A check called while one is in progress
  // returns that one's promise (never two at once).
  function check() {
    if (checking) return checking;
    checking = runCheck().finally(() => { checking = null; });
    return checking;
  }

  function schedule(ms) {
    if (!running) return;
    timer = setTimer(async () => {
      timer = null;
      try { await check(); } catch (err) { log.error("job runner: check failed:", err.message); }
      schedule(cfg.checkEveryMs);
    }, ms);
    if (timer && timer.unref) timer.unref();
  }

  function start() {
    if (running) return;
    running = true;
    stopped = false;
    schedule(cfg.firstCheckMs);
  }

  // Stop scheduling; a check in progress finishes its current job and runs no
  // more. Returns the in-progress check's promise (or a resolved one).
  function stop() {
    running = false;
    stopped = true;
    if (timer) clearTimer(timer);
    timer = null;
    return checking || Promise.resolve();
  }

  function list() {
    return [...jobs.values()].sort((a, b) => a.order - b.order).map(({ name, everyMs, when }) => ({ name, everyMs, gated: !!when }));
  }

  return {
    register, start, stop, check, list,
    // test seams
    _lastRan: lastRan,
    _isLoaded: () => loaded,
  };
}

module.exports = { createJobRunner, DEFAULTS, CLAIM_SQL, LOAD_SQL, LAST_RAN_SQL };
