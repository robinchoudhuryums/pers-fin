---BROAD SCAN IMPLEMENTATION SUMMARY---
Findings implemented:
- F27 — every scheduled job also runs once shortly after boot (staggered 60s + 20s steps, lightest first)
- F29 — bank auto-sync, the self-healing reconcile and the insights auto-trigger skip their settings read while off (rest of the local day) or not due (until the due time); a Settings change to their fields drops the memo
- F25 — safeReturnTo refuses control characters and any target that doesn't stay same-origin when a browser resolves it (the biometric-login open redirect)
- F26 — the shell refuses to boot without a PERSISTENT_DATABASE_URL distinct from NEON_DATABASE_URL (ALLOW_SHARED_DATABASE=true opts in)
- F2 — a DISCONNECTED Teller enrollment is restored to GOOD only when Teller answered for at least one of its accounts
- F28 — the pre-auth biometric probes (authenticate-options, /available) sit behind a plain 30/min per-IP limiter; outstanding challenges are capped at 1000
- F30 — the x-api-key limiter counts wrong keys only (requestWasSuccessful = a valid key), not valid-key 4xx answers
New capabilities (G/ST): None
Files modified:
- teller/startup.js
- teller/routes/settings.js
- teller/routes/enrollments.js
- shell/index.js
- shell/boot-checks.js (new)
- shell/middleware/auth.js
- shell/middleware/webauthn.js
- tests/broad-scan-c8-batch1.test.js (new)
- tests/scan-oct-batch3.test.js

CHANGES:
F27 | teller/startup.js | The four inline job closures in startBackgroundJobs became named locals (runSheetsAutoSyncTick, runNetWorthSnapshotTick, runGoalMilestonesTick, runBudgetSnapshotTick); bank auto-sync and the reconcile moved to module-level runBankAutoSyncTick / runSelfHealingReconcileTick. scheduleBootRuns schedules one unref'd setTimeout per job (bootRunPlan: 60s, then every 20s; 14 jobs end at ~5.3 min), and stopBackgroundJobs clears pending ones. Exposed for tests as _boot.
F29 | teller/startup.js, teller/routes/settings.js | New _nextDueAt memo with notDueYet / setNextDue / invalidateJobMemos. Bank auto-sync: off → markAwaySettled, not due → next due = last_auto_sync_at + interval, after a run → now + interval. Reconcile: not due → last + 7 days, after a run → now + 7 days. Insights trigger: off → settled for the day, not due → last_run + cadence (or last attempt + 24h). PATCH /api/settings calls invalidateJobMemos for auto_sync_* / insights_enabled / insights_cadence_days. _awayJobs.reset() clears both memos.
F25 | shell/middleware/auth.js | safeReturnTo also refuses [\x00-\x1f\x7f] and checks new URL(target, dummy origin).origin is unchanged.
F26 | shell/boot-checks.js, shell/index.js | sharedDatabaseProblem(env) (missing PERSISTENT_DATABASE_URL, or the same host + port + database name as NEON_DATABASE_URL → a reason; ALLOW_SHARED_DATABASE=true → null). start() throws it before either sub-app starts.
F2 | teller/routes/enrollments.js | syncEnrollment counts accounts whose first transactions request succeeded and returns authenticated; syncOneTellerEnrollment self-heals only when result.authenticated.
F28 | shell/index.js, shell/middleware/webauthn.js | webauthnProbeLimiter (60s window, 30, no skipSuccessfulRequests) on /api/shell/webauthn/authenticate-options and /available; /authenticate keeps authLimiter. MAX_CHALLENGES = 1000, oldest dropped first.
F30 | shell/index.js, shell/middleware/auth.js | apiKeyLimiter gets requestWasSuccessful: (req) => auth.isValidApiKey(req); isValidApiKey exported.
Tests | tests/broad-scan-c8-batch1.test.js, tests/scan-oct-batch3.test.js | 22 new tests (mock-timer boot run over every JOB_INTERVALS_MS job, memos, the PATCH invalidation through the real settings router, safeReturnTo payloads, the database check, the self-heal via the real Teller engine, the challenge cap through the real webauthn router, the limiter wiring). The F63 insights test's setup() now resets the memo between setups. Mutation checks 6/6 red.

TEST RESULTS: passed — npm test 2583/2583 (was 2560/2561 with one test-runner IPC flake, "Unable to deserialize cloned data", in tests/roadmap-t2-4-x2a.test.js — pre-existing, passes 3/3 alone); contract suite 253/253 against local Postgres 16 (no pgvector); Playwright 72/72 (run through a scratch config pointing at the preinstalled Chromium — the project's Playwright pins a browser build this container doesn't have; repo config unchanged). The boot runs fired during the e2e run without breaking a page.
REGRESSION RISKS:
- Every process start now runs every job once within ~5 minutes. Each job is gated by its own watermark / dedup / due time, but the activity-gated ones (sheets, net worth, goal milestones, budget snapshot) also run when the wake came from a backstop workflow or keep-alive request, since boot counts as activity — a few extra queries per boot.
- The not-due memo can hold a job past an out-of-band change made while the process runs (a hand edit of last_reconcile_at / insights_last_run in SQL, a reset:fresh): at most one cadence, cleared by a restart or a Settings change.
- A deployment that deliberately used ONE database for both apps now refuses to boot until ALLOW_SHARED_DATABASE=true is set.
- A DISCONNECTED Teller enrollment with no linked accounts now stays DISCONNECTED (it used to flip to GOOD); it needs a re-link.
INVARIANTS AT RISK: None violated. Touched: INV-77 (away channels now also run at boot — strengthened), INV-105 (every moved job still records its outcome — scan-oct-batch3 green), INV-21 (safeReturnTo tightened), INV-20 / INV-53 (the x-api-key limiter no longer locks out valid backstop requests), INV-143 (protected by F26).
NET SCORE: 2 − 1 = 1 (production fixes: F27, F29; new failure mode: F26's refusal for a one-database deployment without the flag)

OPERATOR ACTIONS / DEPLOY:
- Confirm Render's PERSISTENT_DATABASE_URL is set and points at a different database from NEON_DATABASE_URL (CLAUDE.md says it is); if a deployment intentionally runs both apps in one database, set ALLOW_SHARED_DATABASE=true first | BLOCKS DEPLOY: Y (the shell refuses to start otherwise)
Deploy: Platform, Shell & Auth — Render auto-deploys on push to `main` (configured in the Render dashboard).

(Not complete in production until blocking operator actions are done AND
the deploy step is confirmed.)

FOLLOW-ON ITEMS:
- The weekly digest, daily digest, CSV reminder and housing ledger settle for the local day once they find themselves off, and PATCH /api/settings doesn't drop that memo — switching one on takes effect the next local day (pre-existing; same shape as F29's invalidation).
- The watchdog's 2-minute boot setTimeout (bootCheck) isn't cleared by stopBackgroundJobs (pre-existing; unref'd, harmless at exit).
- tests/roadmap-t2-4-x2a.test.js failed once with a node:test runner IPC error (pre-existing flake).
- The e2e suite can't run in the cloud container as configured (Playwright pins a browser build that isn't preinstalled); a PW_EXECUTABLE_PATH-style hook in e2e/playwright.config.js would let it.
DOCUMENTATION UPDATES NEEDED:
- CLAUDE.md Scheduled Tasks: every job also runs once ~1–5.3 minutes after boot (scheduleBootRuns, lightest first); bank auto-sync / reconcile / insights trigger skip their read while off or not due (invalidated by PATCH /api/settings); the startup header's "heavy DB jobs are gated" wording.
- CLAUDE.md INV-77: add the boot run.
- CLAUDE.md Environment Variables (Shell / Databases): PERSISTENT_DATABASE_URL is required under the shell and must differ from NEON_DATABASE_URL; ALLOW_SHARED_DATABASE.
- CLAUDE.md Security: safeReturnTo refuses control characters and cross-origin resolution; the biometric probe limiter (30/min) + MAX_CHALLENGES; the apiKeyLimiter counts wrong keys only.
- CLAUDE.md Teller self-heal (Key Design Decisions, BSI-9 paragraph + the W5 note): restored only after Teller answered for an account.
- CLAUDE.md test counts (2561 → 2583, 133 → 134 files) and the new tests/broad-scan-c8-batch1.test.js entry; shell/boot-checks.js in the shell file list.
---END BROAD SCAN IMPLEMENTATION SUMMARY---
