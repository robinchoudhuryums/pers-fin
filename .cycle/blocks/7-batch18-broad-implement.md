---BROAD SCAN IMPLEMENTATION SUMMARY---
Findings implemented:
- Batch 3 follow-on — weekly-reconcile / knowledge-reindex / job-radar exited silently on a curl timeout; they now report it through check_status (absorbed into Batch 18 by `.cycle/plan-cycle7-expansion.md`)
New capabilities (G/ST):
- ST1 — asynchronous sync for the backstops: POST /api/sync, /api/sync-balances and /api/sync/reconcile accept `background: true` (202 + job id), GET /api/sync/status?kind= reports the outcome, and the daily / weekly workflows start background runs and poll instead of holding one request open
Files modified:
- teller/routes/enrollments.js
- .github/workflows/daily-sync.yml, .github/workflows/weekly-reconcile.yml, .github/workflows/knowledge-reindex.yml, .github/workflows/job-radar.yml
- tests: tests/scan-oct-batch18.test.js (new, 15), tests/contract/async-sync.contract.test.js (new, 2); pins updated in tests/scan-oct-batch3.test.js (daily-sync's curl / check_status counts — two calls now go through run_background) and tests/scan-sept-batch12.test.js (the reconcile push reads `job.error` — the job lives in the shared tracker)

CHANGES:
ST1 | enrollments.js | One in-memory tracker, bgJobs keyed by kind (sync / sync-balances / reconcile) with { kind, id, running, phase, started_at, finished_at, result, error }; startBgJob / finishBgJob; the reconcile job moved into it (reconcileJob removed — /api/sync/reconcile/status returns bgJobs.reconcile, the 202 now carries kind + id + started_at)
ST1 | enrollments.js | runTransactionSync / runBalanceSync — the old route bodies, returning { status, body, failure }; sharedRun(key, fn) route-level single-flight so a manual POST during a run (background or manual) shares it — one sync, one last_sync_result write; startBackground(res, kind, run) → 202 { started, running, kind, id, started_at }, 409 { running, kind, id, started_at } while that kind runs; the status's error is a fixed sentence ("Nothing synced: the Teller sync failed and Plaid did not succeed." / "The Teller balance sync failed." / an internal-error line) — never an exception message (a Teller error carries the response body)
ST1 | enrollments.js | GET /api/sync/status?kind= (default sync; unknown kind → 400); without `background` both POSTs answer exactly as before
ST1 | daily-sync.yml | job env SERVER_URL / API_KEY from secrets; RUN_BACKGROUND helper (run_background <label> <path> <kind> <out> <body>): POST with {"background": true} (409 → follows the running job), polls /perfin/api/sync/status every BG_POLL_SECONDS (15) up to BG_DEADLINE_SECONDS (1200), fails on the job's error / a lost run (id gone — restart) / the deadline / a failed start, never printing the job's error text; both sync steps use it and print only allowlisted result.* keys via SUMMARY_JS
ST1 | weekly-reconcile.yml | the same helper over the background reconcile ({"days": 90, "provider": "teller", "background": true}); CHECK_STATUS added
B3 follow-on | knowledge-reindex.yml, job-radar.yml | CHECK_STATUS (expected-status list, default 200) + `--max-time` + `|| true`, so a timeout or unreachable server is an ::error:: annotation, not a silent `bash -e` exit

TEST RESULTS: passed — npm test 1807/1807 (+15); contract suite 146/146 (+2, local Postgres without pgvector); migrations run twice cleanly; Playwright 35/35. run_background is executed in bash against a fake server (done / server error / lost run / down server / deadline / 409-follow / unreachable). Mutation check: dropping sharedRun from the synchronous /api/sync turns the shared-run test red. Two pre-existing pins updated for the new shape (counts and the reconcile push expression), intent unchanged.
REGRESSION RISKS:
- Two concurrent manual POST /api/sync (or sync-balances) calls now share one run and one answer instead of each recording a result — strictly fewer writes; syncAllTransactions was already single-flight.
- The background job slots are in memory: a restart mid-run loses the job; the workflow reports it as "lost" (red) even if the work had finished before the restart.
- The reconcile status after completion now has phase null (it used to stay "Finalizing"); Settings reads phase only while running.
- The daily-sync polling deadline is 20 minutes per step (was 7 / 4 minutes per request) — a hung sync holds the Actions runner longer.
INVARIANTS AT RISK: None. INV-67 holds (both paths call syncAllTransactions once); INV-68 holds (recordSyncResult unchanged — verified on real Postgres); INV-103 holds (only allowlisted counts printed; the job's error text never printed; the helper's errors are fixed strings); INV-53 strengthened (the backstops no longer fail on request timeouts).
NET SCORE: 1 − 1 = 0 (production fix: the silent curl-timeout exits in three workflows — the Oct 2026 scan found nine timed-out daily syncs and the other workflows had the same failure mode without a report. ST1 is new capability. New failure mode: a server restart during a background run reads as "lost" and fails the step although the next run recovers.)

OPERATOR ACTIONS / DEPLOY:
- None required. The workflows ship with the push; they need the same SERVER_URL / API_KEY secrets as before. Deploy the server BEFORE the next scheduled daily-sync run — an old server ignores `background` and answers 200, which run_background reports as "expected 202" | BLOCKS DEPLOY: N
Deploy: Platform, Shell & Auth — Render auto-deploys on push to `main` (no migration). The workflow files take effect from the default branch.

(Not complete in production until blocking operator actions are done AND the deploy step is confirmed.)

FOLLOW-ON ITEMS:
- The net-worth snapshot and detection steps in daily-sync still hold one request open (shorter, but the same failure mode in principle).
- knowledge-reindex.yml prints `{reindex, vault}` JSON when a reindex fails — the vault block can carry repo / file names (an INV-103 gap predating this batch).
- Background job slots don't survive a restart (in memory); a persisted job table would let a poller tell "finished then restarted" from "lost".
- The Settings "Sync now" buttons still use the synchronous calls (fine for the browser, which has no 420 s limit).
DOCUMENTATION UPDATES NEEDED:
- CLAUDE.md: POST /api/sync + /api/sync-balances `background` mode + GET /api/sync/status (Commands), the reconcile 202 shape, the workflow-hygiene paragraph (run_background, check_status in every workflow, the 20-minute deadline), Scheduled Tasks backstop text, Known Open Issues (remove the Batch 3 "exit silently on a curl timeout" bullet part; Batch 18 follow-ons; expansion progress), new INV (background runs: fixed error strings, shared single-flight, poll-by-id), counts (1807 tests / 87 files; contract 146).
- README: counts.
---END BROAD SCAN IMPLEMENTATION SUMMARY---
