---BROAD SCAN IMPLEMENTATION SUMMARY---
Findings implemented: None (E2b is new capability)
New capabilities (G/ST): ST1 (part 2 of 2, E2b) — teller/startup.js schedules every background job through the due-based job runner (services/job-runner.js, E2a): a job runs when its last run (job_runs.last_ran_at) is older than its cadence, instead of on a setInterval plus a one-shot boot run.
Files modified: teller/startup.js, teller/services/job-runner.js, tests/cycle8-e2b.test.js (new), tests/contract/scheduler-e2b.contract.test.js (new), tests/broad-scan-c8-batch1.test.js, tests/roadmap-t2-2-cash-l2.test.js, tests/roadmap-t4-1-a4.test.js, tests/scan-oct-batch3.test.js, tests/cycle8-e2a.test.js, .cycle/plan-e2-scheduler-watermarks.md, .cycle/STATE.md

CHANGES:
ST1 (E2b) | teller/startup.js | the 15 setIntervals, the watchdog's 2-minute timeout + 6-hour interval and scheduleBootRuns / bootRunPlan / BOOT_* (F27) removed; startBackgroundJobs({ runnerOptions }) builds one runner (replacing any earlier one) with onCheck = jobHealth.tick for each watched job, registers "job-watchdog" (WATCHDOG_EVERY_MS 6 h) then the 15 jobs lightest first at their JOB_INTERVALS_MS cadences (unchanged: 1 h / 3 h / 6 h) — the activity-gated ones (goal milestones, budget snapshot, net-worth snapshot, Sheets auto-sync, the watchdog) with `when: isUserActive`, the away channels and the ungated syncs (INV-77) without — and starts it. Job bodies unchanged (their own tick, gates, memos, outcomes). stopBackgroundJobs() stops the runner and returns the in-progress check's promise; start() no longer returns intervalHandles. Test seam `_scheduler` { runner(), WATCHDOG_EVERY_MS } replaces `_boot`.
ST1 (E2b) | teller/services/job-runner.js | list() also reports `gated` (whether a job has a when() gate)
Tests | tests/broad-scan-c8-batch1.test.js | the F27 boot-run describe removed (a pointer to cycle8-e2b); its unused mock / settle dropped
Tests | tests/roadmap-t2-2-cash-l2.test.js, tests/roadmap-t4-1-a4.test.js, tests/scan-oct-batch3.test.js | the `setInterval(() => runXTick(), …)` source pins replaced by the live registry (name, cadence, no gate)
Tests | tests/cycle8-e2a.test.js | list()'s `gated`; "not wired yet" → startup.js requires the runner

TEST RESULTS: npm test 2996/2996 (9 new in tests/cycle8-e2b.test.js — the registry equal to JOB_INTERVALS_MS + the watchdog at today's cadences, lightest first; only the five activity-gated jobs gated; no setInterval / boot timer left; under mock timers: nothing before the first check, then the job_runs read and every job claimed once 20 s apart in order, every watched job ticked, nothing queried by the next checks; a restart right after a run → only the read; a stop before the first check → nothing; a second start replacing the runner; runnerOptions passed through. 3 F27 boot-run tests removed). Contract 301/302 — new scheduler-e2b 3/3 (the real registry's first check runs all 16 real job bodies on a fresh database and stamps last_ran_at; a restart and a concurrent second runner run nothing; a 2-hour-old run is due again, a 10-minute-old one isn't); the 1 failure is tests/contract/cash-alerts-l2's date-dependent seed (pre-existing). Mutation: dropping the Sheets auto-sync gate turns the registry test red. E2e: 73/73 (PW_CHROMIUM_PATH).
REGRESSION RISKS: (1) Jobs now run one at a time — a long body (a bank auto-sync, an insights run) delays the jobs behind it by its duration (they used to run concurrently on their own timers). (2) The runner ticks every watched job on each 5-minute check (they ticked hourly), so a job-health flush (the watchdog's, or GET /api/data-health's on a dashboard load) writes up to 15 job_runs rows when ≥ 5 minutes have passed — only while the process is awake; ticks stay in memory otherwise. (3) A job's body that throws synchronously before its own try (none today) is logged by the runner rather than left unhandled. (4) A deploy overlap with the old code: the old process doesn't claim, so a job can run in both once.
INVARIANTS AT RISK: INV-77 — the away channels carry no gate (pinned by the registry test). INV-18 — in-process helpers, unchanged. INV-105 — every job body still records its outcome; the registry is pinned equal to JOB_INTERVALS_MS. INV-53 — the out-of-process backstops are unchanged. None violated.
NET SCORE: 0 − 0 = 0 (new capability; the regression risks above are trade-offs of the design, documented, not defects)

OPERATOR ACTIONS / DEPLOY:
- None | BLOCKS DEPLOY: N
Deploy: Platform, Shell & Auth: Render auto-deploys on push to `main`.

FOLLOW-ON ITEMS:
- A failing job waits a full cadence before its next run (unchanged from setInterval)
- The Batch 1 follow-on "the watchdog's boot timeout isn't cleared by stopBackgroundJobs" is gone with the timeout (closed by this batch)
- tests/contract/cash-alerts-l2's seed is still date-dependent

DOCUMENTATION UPDATES NEEDED:
- CLAUDE.md: the startup.js / job-runner.js / job-health.js Architecture entries (wired; ticks every check), the Scheduled Tasks section (the "Boot run (cycle-8 F27)" paragraph → the runner; each job's "every N hours" now its cadence; jobs one at a time), INV-77's boot-run clause, Known Open Issues (E2b done; Batch 1's watchdog boot-timeout follow-on closed), counts (2996 / 161 files / Perfin 2275; contract 302), the new test entries
---END BROAD SCAN IMPLEMENTATION SUMMARY---
