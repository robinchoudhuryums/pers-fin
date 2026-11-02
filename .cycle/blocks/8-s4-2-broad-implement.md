---BROAD SCAN IMPLEMENTATION SUMMARY---
Findings implemented: S4-2 (from .cycle/plan-seams4.md / Seams & Invariants audit #4)
- B1 — every scheduled run has a deadline (one hung run no longer stops every job); the runner's own queries too; Plaid calls time out after 90 s
- B5 — shutdown waits (up to 7 s) for the job in progress before the pools close
- B6 — bank auto-sync records the time its run STARTED, so the cadence no longer slips by a check interval (an hourly sync ran every 2 h)
- B4 — the PIN operator check says "shorter than 6" / "6 or longer", never the exact length (INV-126)
- A3 — the shared-database refusal also compares the databases themselves (name + oid + server start time), before either app migrates
New capabilities (G/ST): None
Files modified: teller/services/job-runner.js, teller/startup.js, teller/services/plaid-client.js, shell/index.js,
  shell/boot-checks.js, teller/services/operator-checks.js, tests/cycle8-e2a.test.js, tests/scan-oct-batch3.test.js,
  tests/roadmap-t2-2-cash-l2.test.js, tests/roadmap-t4-1-a4.test.js, tests/seams-audit-4.test.js (new),
  tests/contract/seams4-s4-2.contract.test.js (new)

CHANGES:
B1 | teller/services/job-runner.js | register({ timeoutMs }) (validated; default runTimeoutMs 15 min); each run is raced against a deadline (injected setDeadline / clearDeadline, unref'd by default) — past it the runner logs, calls onTimeout(name, ms), returns it in check()'s timed_out and moves on; the abandoned run stays in inFlight until it settles and a due job still in flight is skipped (no claim, never started twice); the job_runs read, the claim and its follow-up read go through query() with a 1-minute deadline (a timed-out read → every job due, a timed-out claim → run anyway, as for any failed query); list() adds timeoutMs.
B1 | teller/startup.js | onTimeout records jobHealth.result(name, { ok: false, error: "didn't finish within N minutes" }) — Sync Health shows it and the uptime heartbeat pings /fail; LONG_JOB_TIMEOUT_MS gives bank-auto-sync, self-healing-reconcile and insights-auto-trigger 30 minutes.
B1 | teller/services/plaid-client.js | Configuration baseOptions.timeout = PLAID_TIMEOUT_MS (90 s) — the SDK spreads baseOptions into every axios request (checked: client.configuration.baseOptions.timeout).
B5 | shell/index.js | shutdown keeps stopBackgroundJobs()'s promise and awaits waitForJobs(it, SHUTDOWN_JOB_WAIT_MS = 7 s) before the error-log flush and the pools close (inside the existing 10 s forced exit); a timeout or rejection is logged.
B6 | teller/startup.js | runBankAutoSyncTick captures startedAt when it decides the run is due and stamps last_auto_sync_at = startedAt (a parameter) after the run, instead of now() at the end; due = now − lastSync ≥ interval − 2 min (AUTO_SYNC_DUE_SLACK_MS, covering the runner's claim landing a moment before the stamp); setNextDue from startedAt.
B4 | teller/services/operator-checks.js | local:shell-pin detail: "SHELL_PIN is shorter than 6 characters …" (warn) / "SHELL_PIN is 6 characters or longer." (ok).
A3 | shell/boot-checks.js | IDENTITY_SQL (current_database(), its pg_database oid, pg_postmaster_start_time()), databaseIdentity(pool) (null on a failed / empty read), poolsShareDatabase(a, b) (true / false / null; no query when a pool is missing), sharedDatabaseIdentityProblem({ perfinPool, persistentPool, env }) (ALLOW_SHARED_DATABASE skips it).
A3 | shell/index.js | start() runs sharedDatabaseIdentityProblem over perfin.pool / persistent.pool after the URL check and before either app's start() (migrations), throwing on a shared database.
A3 | teller/services/operator-checks.js | goLiveChecks' local:databases also warns when poolsShareDatabase(pool, persistentPool) is true (an unreadable identity counts as separate).
Tests | tests/seams-audit-4.test.js (11) + tests/cycle8-e2a.test.js (3 new deadline tests, registration) + list() shape in three tests (scan-oct-batch3, cash-l2, t4-1-a4 — Category A, the new timeoutMs field) + tests/contract/seams4-s4-2 (2: one scratch database under localhost and 127.0.0.1 is one, the scratch and admin databases are two, an unreachable one unknown).

TEST RESULTS: npm test 3149/3149 (was 3135, +14; one run hit the known node:test IPC flake in roadmap-t2-4-x2a, which passes alone and on the rerun); contract 332/332 (+2); e2e 91/91 (the shell's boot runs the identity check). Red check: the new unit tests fail 13 times with the six production files reverted.
REGRESSION RISKS:
- B1: a run past its deadline is abandoned, not stopped — it keeps running (its writes still land) while later jobs run; a bank sync that legitimately takes over 30 minutes now records a failed run (the heartbeat pings /fail) though it finishes.
- B1: a Plaid call slower than 90 s now fails (retried by the next sync / the step's own error path).
- A3: boot now makes one query on each database before the migrations (a connection problem surfaces there instead of in the migrations).
- B6: last_auto_sync_at now means "the last completed run started at" — Sync Health / the global freshness basis read a time a few minutes earlier than before.
INVARIANTS AT RISK: None broken. INV-126 holds again for the PIN check (B4); INV-77 / INV-105 (a timed-out job records a failed outcome; jobs still run when due); INV-134 (the heartbeat now pings /fail on a timed-out job — failingJobs); INV-155 / INV-156 candidates extended (the runner's deadline; the identity check).
NET SCORE: 2 − 1 = +1 (production fixes this month: B6 — every auto-sync run when it's switched on; B4 — the length shown whenever SHELL_PIN is set. B1 / B5 / A3 need a hang, a deploy mid-job or an aliased URL — NO this month. New failure mode: a legitimately long run reported failed (Low).)

OPERATOR ACTIONS / DEPLOY:
- None | BLOCKS DEPLOY: N
Deploy: Platform, Shell & Auth — Render auto-deploys on push to main.

FOLLOW-ON ITEMS:
- There is no "the runner itself stopped checking" signal (a check that throws outside a run is logged and the next check is scheduled; with the query deadlines a check can no longer hang) — no heartbeat check for it.
- The Teller client already has a 30 s timeout; the Anthropic SDK's own default timeout (10 min) bounds the insights run, under the 30-minute deadline.
- The rest of audit #4: S4-3, S4-4, S4-5 (.cycle/plan-seams4.md).

DOCUMENTATION UPDATES NEEDED:
- CLAUDE.md: job-runner.js (timeoutMs, runTimeoutMs, onTimeout, inFlight, the query deadline), the Scheduled Tasks "Due-based runner" paragraph, plaid-client.js (90 s timeout), shell/index.js shutdown (waits for the job, 7 s), boot-checks.js (the identity check) + the PERSISTENT_DATABASE_URL env note, operator-checks.js (PIN detail wording, local:databases identity), the bank auto-sync paragraph (last_auto_sync_at = start time), the audit #4 Known Open Issues entry (S4-2 done), test counts (3149 / 172 files, contract 332); candidates INV-155 / INV-156 to fold in.
---END BROAD SCAN IMPLEMENTATION SUMMARY---
