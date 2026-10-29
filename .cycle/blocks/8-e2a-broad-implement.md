---BROAD SCAN IMPLEMENTATION SUMMARY---
Findings implemented: None (E2a is new capability)
New capabilities (G/ST): ST1 (part 1 of 2, E2a) — a due-based job runner, `teller/services/job-runner.js`: a job runs when its last run is older than its cadence, decided in memory every 5 minutes after one job_runs read; a claim on job_runs.last_ran_at so two processes run a due job once. Not wired into teller/startup.js yet (E2b).
Files modified: teller/services/job-runner.js (new), teller/services/database.js, tests/cycle8-e2a.test.js (new), tests/contract/job-runner-e2a.contract.test.js (new), .cycle/plan-e2-scheduler-watermarks.md, .cycle/STATE.md

CHANGES:
ST1 (E2a) | teller/services/job-runner.js | createJobRunner({ pool, now, setTimer, clearTimer, sleep, onCheck, log, checkEveryMs = 5 min, firstCheckMs = 1 min, gapMs = 20 s, claimFactor = 0.9 }) → { register({ name, everyMs, run, when? }), start, stop, check, list }. The FIRST check reads the registered jobs' job_runs.last_ran_at once (a failed read → every job due); every check after is an in-memory comparison (no query unless a job is due). Due jobs run one at a time, oldest-due first (registration order on a tie), gapMs apart; a check never overlaps another (a second call shares the promise). A `when()` gate is checked in memory BEFORE the claim — closed or throwing → no query, the job stays due and runs at the first check after the gate opens. The claim is one conditional UPSERT (`ON CONFLICT … DO UPDATE SET last_ran_at = now() WHERE last_ran_at IS NULL OR last_ran_at <= now() − 90% of the cadence`); no row back → another process ran it, its time is read into memory; a failed claim runs the job anyway (fail-open). A throwing run is logged and counts as run (next run a cadence later). onCheck(name) is called for every registered job on each check (job-health's tick in E2b). Timers unref'd; stop() ends scheduling and stops a check in progress after its current job.
ST1 (E2a) | teller/services/database.js | `ALTER TABLE job_runs ADD COLUMN IF NOT EXISTS last_ran_at TIMESTAMPTZ` (when the runner last claimed the job — distinct from last_run_at, the heartbeat)
Plan | .cycle/plan-e2-scheduler-watermarks.md | decision 5 changed at E2a: an activity-gated job registers a `when()` gate checked before the claim instead of its body returning `{ skipped: 'away' }` and releasing the claim (that would have cost two writes per 5-minute check while the user was away and kept Neon awake); the job_runs read is at the first check, not at start

TEST RESULTS: npm test 2990/2990 (18 new in tests/cycle8-e2a.test.js — registration, due checks over a fake job_runs with one clock, the claim taken by another process, a failed read / claim, gates, a throwing run, no overlap, onCheck, start / stop incl. a stop mid-check, unref'd timers, the SQL and the migration, "not wired yet"). Contract 298/299 — new job-runner-e2a 3/3 (two runners at once run each job once; a restart right after a run runs nothing and a 2-hour-old run is due again; the claim and job-health's flush leave each other's columns alone); the 1 failure is tests/contract/cash-alerts-l2's date-dependent seed (pre-existing, documented). Mutation: dropping the claim's WHERE turns all three contract tests red. E2e not run (no UI or route change).
REGRESSION RISKS: None in production — the runner isn't wired; the only live change is a nullable column on job_runs (job-health's INSERT / UPSERT doesn't name it, so its flush is unchanged — pinned by the contract test). A database whose clock is far ahead of the app's could deny claims until the app catches up (90% slack covers small skew).
INVARIANTS AT RISK: INV-77 (away channels never gated on isUserActive) — the runner's `when` gate is opt-in per job; E2b must register the away channels without one. INV-105 (every job records its outcome via result) — the runner doesn't call result (bodies do); unchanged. INV-17 (migrations) — an idempotent ADD COLUMN IF NOT EXISTS. None violated.
NET SCORE: 0 − 0 = 0 (new capability, not wired; no new failure mode in production)

OPERATOR ACTIONS / DEPLOY:
- None | BLOCKS DEPLOY: N
Deploy: Platform, Shell & Auth: Render auto-deploys on push to `main`.

FOLLOW-ON ITEMS:
- E2b: register the 15 jobs + the watchdog with today's cadences (activity-gated ones with `when: isUserActive`, the away channels without), remove the intervals and scheduleBootRuns, derive JOB_INTERVALS_MS from the registry, onCheck = jobHealth.tick, stopBackgroundJobs → runner.stop()
- A failing job waits a full cadence before its next run (as with setInterval today); a faster retry for a failed body is not in scope
- tests/contract/cash-alerts-l2's seed is still date-dependent (fails in a 31-day month)

DOCUMENTATION UPDATES NEEDED:
- CLAUDE.md: the Architecture tree (services/job-runner.js, not yet wired), Database (job_runs.last_ran_at), the Platform, Shell & Auth subsystem file list (teller/services/job-runner.js), test counts (2990 / 160 files / Perfin 2269; contract 299), the new test entries; Known Open Issues (E2a done, E2b–E2d queued)
---END BROAD SCAN IMPLEMENTATION SUMMARY---
