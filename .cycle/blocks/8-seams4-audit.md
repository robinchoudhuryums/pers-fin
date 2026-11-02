---SEAMS & INVARIANTS AUDIT #4 SUMMARY---
Date: 2026-11-02 (after cycle 8 reflect; counter was 1 — run on request, not cadence)
Scope: four parallel read-only reviews of the seams cycle 8 added — cross-app (notifications ↔
linked tasks ↔ Per-sistant check, shell boot / landing, DATE values across the pools), scheduler +
ops + migrations (job runner, job-health, CHECK_LISTS, reset-fresh, workflows, operator checks),
shared sources of truth (cash-flow bill decision, the advice plan, txn watermarks, freshness,
restore batches, SPLIT/NOT_TRANSFER copies) and client ↔ server (dashboard / settings / nav / tax
page / Per-sistant dashboard + search + AI budget). Every finding below was re-verified against
the code by the session (S2 also on real Postgres). READ-ONLY: nothing fixed in this session.
Also found while PR #134's CI ran: two contract tests that failed on date and timing — fixed in
d33cb7f (advice-a1 seeded card charges landing in the last completed month early in a month;
webhooks-w1 / w2 sleeping a fixed 50 ms for a detached handler).

FINDINGS (session-local IDs):
B1 | Medium | High (mechanism) / Low (a real hang unconfirmed) | teller/services/job-runner.js runCheck
   + schedule; teller/services/plaid-client.js | each job is awaited with no deadline and the next
   check is scheduled only after the current one ends, so ONE run that never settles (a Plaid call —
   the client sets no timeout; the linked-task advisory-lock wait) stops every job, the watchdog
   included, while the heartbeat (failingJobs = stored outcomes) still reports ok | per-run deadline
   in the runner + a "runner last checked" heartbeat check + a Plaid axios timeout
B2 | Medium | High | job-runner.js CLAIM_SQL; startup.js onCheck (ticks only JOB_INTERVALS_MS names);
   routes/settings.js gatherDataHealth (only '_watchdog' excluded, thresholdMs falls back to 1 h →
   36 h) | the "job-watchdog" row's last_run_at is set once at insert and never moves, so ~36 h
   after deploy Sync Health, the dashboard strip and Needs attention permanently show "Scheduled
   job(s) haven't run recently: job-watchdog" (the missed-jobs PUSH only walks JOB_INTERVALS_MS, so
   no push) | tick every registered job, or read GREATEST(last_run_at, last_ran_at), or exclude it
B3 | Medium | High | .github/workflows/db-backup.yml (Per-sistant step skips when
   PERSISTENT_DATABASE_URL is unset; the stamp step still runs); operator-checks backupCheck | on the
   shell (which now requires a separate Per-sistant database — F26) a missing secret means that
   database is never dumped, yet last_backup_at is stamped and local:backup reads ok | fail the step
   under the shell, or stamp which databases were dumped and check that
B4 | Low | High | teller/services/operator-checks.js:88-90 | the PIN check's detail states SHELL_PIN's
   exact length (ok and warn) in /api/operator-checks and data-health — INV-126 says never more of a
   secret's length than "shorter than N" | "shorter than 6 characters" / "long enough"
B5 | Low | High | shell/index.js shutdown | stopBackgroundJobs() returns the running check's promise
   but isn't awaited; pool.end() runs under the job, whose claim already set last_ran_at, so a job
   killed by a deploy waits a full cadence (1 h–6 h) | await it with a bound, or release the claim
B6 | Low | High (pre-existing) | startup.js bank-auto-sync | stamps last_auto_sync_at at the END of
   its run while the runner times from the claim at the start; a run longer than ~5 min at a 1 h
   interval finds itself "not due" next time — the real cadence becomes ~2 h | stamp at the start
S1 | Low | High | teller/services/cash-flow.js mirroredCredit + NOT_SUBSCRIPTION vs the detectors'
   trimmed merchant_key (merchant-rename.js DETECT_KEY) | the forecast rebuilds the key without
   TRIM; for a row with no merchant_name whose raw name ends in punctuation ("HULU *" → "hulu ")
   the key never matches — a subscription's charges stay in the spending average AND are billed,
   and an internal move / linked-card autopay isn't recognised | TRIM both, or share DETECT_KEY
S2 | Medium | High (confirmed on Postgres) | teller/routes/merchant-rename.js rekeyDetectedRows +
   createRenameRule (no transaction) | a contains / starts_with rule covering two raw merchants that
   each have a detected row at the same cadence moves both to (new key, cadence) in one UPDATE →
   unique violation → 500 after the rule is stored and the rows renamed; detection rows never
   re-keyed, the forecast carry skipped, and the next detection makes a fresh row without user state
   (a cancelled / left-out subscription comes back) | one survivor per cadence (DISTINCT ON), the
   rest deactivated first; run createRenameRule in one transaction
S3 | Low | High | cash-flow.js projectCashFlow | the bill schedule includes today but the projection
   starts tomorrow: "What's in this forecast" counts a bill due today (occurrences, total, next_date
   = today) that the totals and lowest day leave out | one window for both
S4 | Low | High | routes/settings.js gatherDataHealth | "Transactions / Balances haven't synced in
   over 24h" still read the global stamps while connections exist (E4b moved the badge to the
   connections), so a webhook-only setup can show a green badge and a stale Sync Health warning |
   derive them from connectionFreshness when connections exist
S5 | Low | High | routes/transactions.js GET /api/deleted-transactions | a row's `restorable` ignores
   bank_removed_at and a gone account (the batch count applies both) — Settings offers a Restore the
   server refuses | the batch query's rule per row
S6 | Low | High | services/cash-alerts.js | the stale-balance gate reads the NEWEST spendable
   balance; another account's days-old balance still feeds the projection (INV-142 "never on stale
   data") | gate on the oldest, or leave stale accounts out
C1 | Low-Medium | High | teller/views/settings.ejs contribution limits | when GET /api/investments
   fails the editor shows no boxes but Save stays enabled and sends {} — every stored limit is
   wiped ("Contribution limits saved"); a limit for an account no longer listed is dropped on any
   save | refuse while accounts are unknown; merge over the stored map
C2 | Low | High | settings.ejs selects / number inputs through updateSetting | a refused save toasts
   but the control keeps the refused value (only switches revert — INV-157 partial) | remember and
   restore the stored value
C3 | Low | High | dashboard.ejs adviceEmergency | the plan's note ("It comes after your high-interest
   debt is paid off.") is dropped when a projection is also present | show both
C4 | Low | High | dashboard.ejs loadDashboardSummary (re-run after a forecast change, E1b) | after a
   failed first load a later successful reload never un-hides the cards; a failed reload hides a
   good summary | un-hide on success, keep the old cards on a failed reload
C5 | Low | High (pre-existing) | dashboard.ejs Since-you-last-looked rows | amounts built with
   '$' + toFixed — "$-24.29", no thousands separator; a falling checking balance coloured red
   (INV-148) | fmt + the money classes
C6 | Low | Medium (pre-existing) | apps/per-sistant/routes/analytics.js heatmap | DATE(completed_at)
   buckets in the database's zone (UTC), so an evening completion west of UTC lands on tomorrow,
   off the grid | AT TIME ZONE APP_TIMEZONE
A1 | Medium | High | teller/routes/notifications.js sendToAll / release vs apps/per-sistant
   perfinPushedItems | push_state 'sent' is written before delivery; with VAPID keys set but no live
   subscription (logins land in Per-sistant, so Perfin push may never be enabled) nothing is
   delivered, yet Per-sistant sees 'sent' and raises no browser notification for that item for 12 h
   — the rent / utility reminder reaches no one | record 'none' when r.sent === 0
A2 | Low | High | Per-sistant openLinkedItems vs Perfin itemCovered | "open task" differs on
   source_detached: a hand-reopened (detached) housing task hides housing_due while Perfin still
   pushes | one predicate
A3 | Low | Medium | shell/boot-checks.js sameDatabase | compares hostnames, so one database named
   two ways (Neon "-pooler" host vs direct, localhost vs 127.0.0.1) passes the shared-database
   refusal and the go-live check | compare the database's identity once both pools are up
A4 | Low | Medium | apps/per-sistant/routes/perfin.js embedded widget | next_expected leaves as a
   JS Date (already a Batch 8 follow-on); the follow-on text still names finance search, which is
   fixed (::text) — doc drift | ::text / ymdOf; trim the follow-on
A5 | Low | High | teller/routes/persistent.js queryPersistentStats | counts auto-closed linked tasks
   and missed instances as done and overdue on UTC CURRENT_DATE (Per-sistant's /api/stats doesn't)
   — no UI caller | mirror the F18 filters
A6 | Low | Medium | release timing | between quiet hours ending and the 15-minute release, a
   Per-sistant load raises an item Perfin then pushes — two interruptions | count 'held' items too

INVARIANTS (code-read): INV-17, 25, 35, 48, 61, 63, 77 (see B1), 81, 89, 90, 103, 105, 110, 116, 117,
129, 133, 134, 143, 144, 147, 149, 150, 152 PASS. FAIL: INV-124 (S2), INV-126 (B4). PARTIAL: INV-142
(S6), INV-145 (S5 — the per-row flag), INV-148 (C5), INV-151 (S1, S2's lost carry), INV-153 (A1 —
"pushed" means attempted, not delivered), INV-154 (S4). Candidates from the cycle-8 reflect:
INV-155 (job-runner claim) PASS with B1 / B2; INV-156 (shared-database refusal) PASS except A3;
INV-157 (a Settings save's result through every wrapper) PASS for switches, PARTIAL for selects /
inputs (C2).

TOP PRIORITIES:
Impact: A1, B2, S2, B3
High-leverage: B1 (one deadline protects every job), B2 + A1 (each a few lines)
Deploy note: none of the findings blocks merging PR #134 — B2 and A1 come from cycle-8 code in it,
so fixing them soon after it merges keeps the false Sync Health warning from appearing (~36 h).
---END SEAMS & INVARIANTS AUDIT #4 SUMMARY---
