// ============================================================================
// Job health — scheduled-task heartbeats + missed-job watchdog (F4)
// ============================================================================
// Every background interval in teller/startup.js calls tick(name) at the top
// of its callback — BEFORE any activity/settings gate — so a heartbeat means
// "the scheduler ticked", independent of whether the job's body chose to run.
//
// Ticks are recorded IN MEMORY and flushed to the job_runs table only when
// the watchdog runs (which is itself activity-gated). This deliberately
// avoids writing to Postgres on every tick: the idle-gate in startup.js
// exists so Neon can auto-suspend when nobody's around, and an hourly
// heartbeat UPDATE would keep it awake 24/7.
//
// The watchdog (checkMissedJobs) flushes memory, then compares each job's
// last persisted heartbeat against a generous threshold. Because in-process
// ticks are always fresh, the only way a job goes stale is a gap where the
// process wasn't running at all (Render free-tier sleep with keep-alive off,
// a crash loop, a wedged deploy) — exactly the silent-failure mode this
// exists to surface. Thresholds are sized so normal overnight sleeps don't
// alarm; only a 36h+ outage does.
//
// Alert dedup: the sorted list of missed job names is the signature, stored
// on the job_runs row `_watchdog`. A persisting outage notifies once; a
// recovery (empty signature) silently resets so the next outage notifies
// again.
//
// Outcomes (cycle-7 F8): a tick only says the scheduler fired. A job that
// actually ran its body also reports result(name, { ok, error }), so
// job_runs.last_status / last_error say whether the last run SUCCEEDED
// (last_status used to be hard-coded 'ok'). Like ticks, results stay in
// memory until a flush — the watchdog's, or GET /api/data-health's, which
// flushes before reading so a user returning after time away doesn't see
// fresh in-process jobs reported as stale.

// Expected tick interval per job (ms). Keys must match the tick() names used
// in startup.js. A job is "missed" when now - last_run_at exceeds
// max(MISSED_FACTOR × interval, MIN_THRESHOLD_MS).
const HOUR = 60 * 60 * 1000;
const JOB_INTERVALS_MS = {
  "sheets-auto-sync": 1 * HOUR,
  "net-worth-snapshot": 1 * HOUR,
  "goal-milestones": 6 * HOUR,
  "insights-auto-trigger": 6 * HOUR,
  "budget-alerts": 3 * HOUR,
  "budget-snapshot": 6 * HOUR,
  "bank-auto-sync": 1 * HOUR,
  "self-healing-reconcile": 1 * HOUR,
  "weekly-digest": 1 * HOUR,
  "daily-digest": 1 * HOUR,
  "csv-reminder": 1 * HOUR, // hourly tick, watermark-gated (PSC-3)
  "housing-ledger": 6 * HOUR, // ticked since FAN-3 but never watched (F8)
};
const MISSED_FACTOR = 4;
const MIN_THRESHOLD_MS = 36 * HOUR;
const WATCHDOG_ROW = "_watchdog";

// In-memory tick log: job_name → epoch ms of the most recent tick.
const memoryTicks = new Map();
// In-memory outcome log: job_name → { status: 'ok'|'error', error } of the most
// recent run that got past its gates. Absent = no run since the last flush.
const memoryResults = new Map();
// job_name → the tick time last written, so a flush only writes what changed
// (GET /api/data-health flushes on every dashboard load).
const flushedTicks = new Map();

function tick(jobName) {
  memoryTicks.set(jobName, Date.now());
}

// Record how a job's run went. Call it only when the body actually ran — a
// gated skip (user away, not due, disabled) is neither a success nor a failure.
function result(jobName, { ok = true, error = null } = {}) {
  memoryResults.set(jobName, {
    status: ok ? "ok" : "error",
    error: ok ? null : String(error || "failed").slice(0, 300),
  });
}

function thresholdMs(jobName) {
  const interval = JOB_INTERVALS_MS[jobName] || HOUR;
  return Math.max(MISSED_FACTOR * interval, MIN_THRESHOLD_MS);
}

// Persist all in-memory ticks and outcomes. Never throws. A job with a tick
// but no new outcome keeps its stored last_status / last_error; a recorded
// outcome is cleared from memory once written, so it's persisted exactly once.
async function flush(pool) {
  for (const [name, at] of memoryTicks) {
    const outcome = memoryResults.get(name) || null;
    if (!outcome && flushedTicks.get(name) === at) continue; // nothing new
    try {
      await pool.query(
        `INSERT INTO job_runs (job_name, last_run_at, last_status, last_error, updated_at)
         VALUES ($1, to_timestamp($2 / 1000.0), $3, $4, now())
         ON CONFLICT (job_name) DO UPDATE SET
           last_run_at = GREATEST(job_runs.last_run_at, EXCLUDED.last_run_at),
           last_status = CASE WHEN $3::text IS NULL THEN job_runs.last_status ELSE $3::text END,
           last_error = CASE WHEN $3::text IS NULL THEN job_runs.last_error ELSE $4::text END,
           updated_at = now()`,
        [name, at, outcome ? outcome.status : null, outcome ? outcome.error : null]
      );
      if (outcome && memoryResults.get(name) === outcome) memoryResults.delete(name);
      flushedTicks.set(name, at);
    } catch (err) {
      console.error("job-health flush error (" + name + "):", err.message);
      return; // table missing / DB blip — try again next watchdog pass
    }
  }
}

// Flush heartbeats, find jobs whose last persisted tick is older than their
// threshold, and notify (via the injected sendToAll) when the missed-set
// signature changes. Returns { missed: [{ job, stale_hours }] }.
async function checkMissedJobs(pool, { sendToAll } = {}) {
  await flush(pool);

  let rows;
  try {
    const r = await pool.query(
      "SELECT job_name, last_run_at, last_error FROM job_runs"
    );
    rows = r.rows;
  } catch (err) {
    console.error("job-health read error:", err.message);
    return { missed: [] };
  }

  const byName = {};
  for (const row of rows) byName[row.job_name] = row;

  const now = Date.now();
  const missed = [];
  for (const job of Object.keys(JOB_INTERVALS_MS)) {
    const row = byName[job];
    // No row yet = the job has never ticked in any process (fresh install or
    // brand-new job name). Nothing to compare against — skip, don't alarm.
    if (!row || !row.last_run_at) continue;
    const ageMs = now - new Date(row.last_run_at).getTime();
    if (ageMs > thresholdMs(job)) {
      missed.push({ job, stale_hours: Math.round(ageMs / HOUR) });
    }
  }

  const signature = missed.map((m) => m.job).sort().join("|");
  const prevSignature = byName[WATCHDOG_ROW] ? (byName[WATCHDOG_ROW].last_error || "") : "";

  if (signature !== prevSignature) {
    if (signature && typeof sendToAll === "function") {
      try {
        const detail = missed
          .slice(0, 5)
          .map((m) => `${m.job} (${m.stale_hours}h)`)
          .join(", ");
        await sendToAll({
          title: "Scheduled jobs missed",
          body: `${missed.length} background job(s) haven't run: ${detail}. ` +
            "The server was likely asleep — check keep-alive in Settings.",
          tag: "jobs-missed",
          data: { url: "/settings" },
        });
      } catch (err) {
        console.error("job-health notify error:", err.message);
      }
    }
    try {
      await pool.query(
        `INSERT INTO job_runs (job_name, last_run_at, last_status, last_error, updated_at)
         VALUES ($1, now(), $2, $3, now())
         ON CONFLICT (job_name) DO UPDATE SET
           last_run_at = now(), last_status = $2, last_error = $3, updated_at = now()`,
        [WATCHDOG_ROW, signature ? "missed" : "ok", signature]
      );
    } catch (err) {
      console.error("job-health signature write error:", err.message);
    }
  }

  return { missed };
}

module.exports = {
  tick,
  result,
  flush,
  checkMissedJobs,
  thresholdMs,
  JOB_INTERVALS_MS,
  // exported for tests
  _memoryTicks: memoryTicks,
  _memoryResults: memoryResults,
  _flushedTicks: flushedTicks,
};
