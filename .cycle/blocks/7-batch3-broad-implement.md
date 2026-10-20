---BROAD SCAN IMPLEMENTATION SUMMARY---
Findings implemented:
- F3   Database Backup never produced a backup (both secrets unset — confirmed from the run log) — operator action; the workflow now names missing secrets in its FIRST step (before the 15 s client install) and documents the inactivity-disable
- F4   Four backstop workflows disabled for inactivity (INV-53 false in production) — operator action (no tool here can re-enable a workflow); documented in the backup workflow header. Detection in-app is G1 (expansion, not in scope)
- F5   daily-sync.yml: one failed/timed-out call skipped every later backstop — balance sync, snapshot, detection and the subscription check run with `if: ${{ !cancelled() }}`; a curl timeout ("000") is an error annotation instead of a silent `bash -e` exit; sync max-time 240 → 420 s
- F8   Heartbeats said "ticked", never "succeeded" — jobHealth.result(name, {ok, error}) records each run's outcome (last_status / last_error); data-health flushes in-memory ticks before reading (no false "stale" after time away) and raises failed jobs; housing-ledger is watched
- F23  Wholesale sync failures recorded as clean — recordSyncResult turns `{ok:false, error}` (no errors[]) into an error entry and skips "Plaid not configured"; the auto-sync, the weekly reconcile and POST /api/sync-balances record a THROWN step
- F69  A failed audit-finding INSERT still stamped the run clean — the run is marked audit_incomplete
- F73  A failed settings read ran insights on "sonnet" with empty memory and overwrote the stored summary — generateInsights fails before the Claude call
- F63  With the cap exhausted the full sync chain re-ran every 6 h; an insight whose INSERT failed was never charged — cap checked before the chain, every attempt stamped (user_settings.insights_last_attempt_at), a failed attempt retried at most once per 24 h; a failed insight INSERT charges an 'insight_unsaved' usage row
- F14  Compromised-cert warning was a log line on the first Teller call — tellerCertStatus() (no network, no throw) → data-health issue + a boot log line
- F15  Rent/utility reminders were activity-gated — runHousingLedgerTick is an away job (INV-77 pattern: not activity-gated, per-local-day settled memo)
- F16  Hygiene: every workflow has a least-privilege `permissions:` block (csv-import keeps write); backups are gpg AES-256 (integrity-checked) and VERIFIED (decrypt + pg_restore --list); /api/notifications/test answers a generic error; shell shutdown stops both apps' scheduled jobs (Perfin intervals + Per-sistant node-cron tasks); CLAUDE.md no longer claims Per-sistant uses Express v5
- Policy (cycle-6 Silent Degradation response): empty-catch scan — server code may not gain a bare catch; KNOWN_GAPS lists the remaining per-file counts with reasons and fails on growth AND on a stale (shrunk) count. Fixed 9 bare catches in the files this batch touched (scheduler notifications, freshness/reconcile stamps, audit alert)
New capabilities (G/ST): None
Files modified:
- teller/services/job-health.js, teller/startup.js, teller/routes/settings.js, teller/routes/enrollments.js, teller/routes/insights.js, teller/routes/notifications.js, teller/services/ai-audit.js, teller/services/teller-api.js, teller/services/database.js, teller/server.js
- shell/index.js, apps/per-sistant/server.js
- .github/workflows/{daily-sync,db-backup,ci,job-radar,keep-alive,knowledge-reindex,weekly-reconcile}.yml
- CLAUDE.md (Express v4 claim only)
- tests/scan-oct-batch3.test.js (new), tests/broad-scan-fixes.test.js, tests/scan-sept-batch2.test.js

CHANGES:
F3   | .github/workflows/db-backup.yml | "Check secrets" first step lists every missing secret as an ::error:: annotation; header documents F3/F4
F4   | .github/workflows/db-backup.yml | header: re-enable under Actions, keep the repo private (GitHub disables a public repo's schedules after 60 idle days)
F5   | .github/workflows/daily-sync.yml | CHECK_STATUS helper (000 → "no response (timed out or server unreachable)"), `|| true` on each curl so the step reports, `if: ${{ !cancelled() }}` on the 4 backstop steps, sync --max-time 420, detect --max-time 240 + status check, snapshot status check
F8   | job-health.js, startup.js, settings.js | result(); flush writes $3/$4 outcome (CASE keeps the stored one on a tick-only flush) and skips jobs with nothing new; "housing-ledger" in JOB_INTERVALS_MS; every job reports an outcome; data-health flushes first, returns jobs[].last_status/last_error and an issue per failed job
F23  | enrollments.js, startup.js | flattenSyncErrors handles ok:false/failed without errors[]; isNotConfigured skip; thrownSyncResult (exported); auto-sync `threw` map + orThrew(); reconcile catch records teller_reconcile; sync-balances isolates a Teller throw (Plaid still runs, still 500)
F69  | ai-audit.js | finding INSERT catch logs and sets incomplete = true
F73  | insights.js | the settings read in generateInsights has no default fallback
F63  | startup.js, insights.js, database.js | runInsightsAutoTriggerTick (extracted): cadence gate, INSIGHTS_RETRY_MS (24 h) attempt gate, cap pre-check, attempt stamp, step() isolation + outcome; insight INSERT try/catch → 'insight_unsaved' usage row + 500; ADD COLUMN insights_last_attempt_at
F14  | teller-api.js, settings.js, startup.js | loadCertMaterial() shared by getTlsAgent + tellerCertStatus() (cached); COMPROMISED_CERT_WARNING; data-health issue; boot check after migrations
F15  | startup.js | runHousingLedgerTick (away job, settled per local day, outcome recorded), interval calls it
F16  | workflows, notifications.js, shell/index.js, teller/server.js, apps/per-sistant/server.js, CLAUDE.md | permissions blocks; gpg + verify (BACKUP_FN, set -o pipefail); generic test-notification error; cronTasks + stopJobs(), stopBackgroundJobs export, shutdown calls both first; Express v4 doc fix
Policy | tests/scan-oct-batch3.test.js, startup.js, enrollments.js, insights.js | empty-catch scan + KNOWN_GAPS (16 files, 38 catches); 9 bare catches replaced by logged ones

TEST RESULTS: passed — npm test 1547/1547, 0 todo (+30: 29 in tests/scan-oct-batch3.test.js, 1 backup-verify pin in broad-scan-fixes; all 29 new-file tests fail against the pre-fix code). Contract suite 44/44 on local PG16. scripts/ci-migration-test.js passes (both apps, twice). The job_runs flush SQL was checked on real Postgres (insert → tick-only keep → success clears). The backup function was run end-to-end against the scratch DB (dump → gpg → verify OK; empty passphrase fails; a flipped byte fails to decrypt). Updated pins: scan-sept-batch2 (pre-insights step() call, orThrew plaid_flows), broad-scan-fixes (gpg instead of openssl, .dump.gpg upload).
REGRESSION RISKS:
- A failed auto-insight attempt now waits 24 h before retrying (was 6 h) — the cost of not re-running the paid chain every tick.
- A transient settings-read error now fails an insights run instead of running it degraded (with the backoff: the next attempt is ~24 h later for the scheduler; a manual run can retry at once).
- POST /api/sync-balances with a Teller throw now still refreshes Plaid before answering 500 (it used to stop at Teller).
- The Rent/utilities job now runs while the user is away (≤ 1 settled pass per local day) — one extra short DB wake per day.
- GET /api/data-health writes changed heartbeats on read (only jobs with a new tick/outcome).
- Backups are now .dump.gpg (restore with `gpg --decrypt`); no openssl-format backup ever existed, so nothing old needs the old command.
INVARIANTS AT RISK: None violated. INV-77 extended (housing reminders are now an away channel). INV-53 still false in production until the operator re-enables the workflows and sets the backup secrets. INV-14 strengthened ('insight_unsaved' charged). INV-24 untouched. INV-18 kept (all in-process helpers).
NET SCORE: 3 − 1 = 2 (production fixes that fired this month and are fixed by code: F5 (nine timed-out runs skipped every backstop), F8 (housing-ledger unwatched; false "stale" after time away), F15 (rent reminders silent while away). F3 and F4 fired but need the operator. F23/F69/F73/F63/F14/F16 had no evidence of firing. New failure mode: the 24 h retry back-off delays an auto-insight after a transient failure.)

OPERATOR ACTIONS / DEPLOY:
- Add repository secrets NEON_DATABASE_URL and BACKUP_ENCRYPTION_PASSPHRASE (+ PERSISTENT_DATABASE_URL) under Settings → Secrets and variables → Actions; keep a copy of the passphrase outside GitHub | BLOCKS DEPLOY: N
- Re-enable Database Backup, Weekly Reconcile, Keep Alive and Job Radar Refresh (Actions → each workflow → "Enable workflow"), then run Database Backup once by hand and do one restore drill (`gpg --decrypt` → pg_restore into a throwaway Neon branch) | BLOCKS DEPLOY: N
- Make the repo private (also stops GitHub's 60-day inactivity disable for scheduled workflows) and delete old Actions logs | BLOCKS DEPLOY: N
- If Settings → Sync Health shows the compromised-certificate issue after deploy, rotate the Teller cert (new TELLER_CERT / TELLER_KEY) | BLOCKS DEPLOY: N
Deploy: Platform, Shell & Auth — Render auto-deploys on push to `main` (merge the PR); alt `fly deploy`.

(Not complete in production until blocking operator actions are done AND the deploy step is confirmed.)

FOLLOW-ON ITEMS:
- /api/insights/rebuild still falls back to "sonnet" when its settings read fails (the F73 pattern, model only — it doesn't touch memory on the fallback path); fix with the same no-fallback read.
- Weekly-reconcile.yml, knowledge-reindex.yml and job-radar.yml use the same `STATUS=$(curl …)` shape as daily-sync did: a timeout exits the step without a message. Port CHECK_STATUS if they're kept.
- The self-healing reconcile doesn't stamp last_reconcile_at when reconcileTeller throws, so a persistent throw retries hourly (it is now recorded and visible).
- KNOWN_GAPS (empty-catch scan) still lists 38 bare catches in 16 server files, mostly Per-sistant fire-and-forget webhooks/automations — shrink it over Batches 11/13.
- G1 (expansion) would let the app SEE a disabled/failing backstop workflow; until then F4 is visible only on GitHub.
- Batches 4–13 of the cycle-7 plan remain (see .cycle/STATE.md).
DOCUMENTATION UPDATES NEEDED:
- CLAUDE.md: job-health (outcomes via result(), flush on data-health, changed-only flush, housing-ledger watched) in the architecture entry, Scheduled Tasks (watchdog/outcome text, housing ledger NOT activity-gated, insights auto-trigger cap pre-check + attempt stamp + 24 h back-off), INV-77 (+ housing), user_settings.insights_last_attempt_at DB bullet, 'insight_unsaved' entry_type in the cost-tracking text, data-health endpoint (jobs[].last_status/last_error, failed-job + cert issues), last_sync_result text (wholesale/thrown failures recorded, "Plaid not configured" skipped), teller-api (tellerCertStatus, boot check) + Operator state item 1, db-backup operator item (gpg format, verify, restore command), INV-53 / Known Open Issues (backup + workflow items now operator-only), CI/workflow notes (permissions blocks, daily-sync independent steps + 420 s), shell shutdown, test counts 1547 / 70 files (Perfin 1091) + scan-oct-batch3 description, the empty-catch policy (KNOWN_GAPS) in Key Design Decisions / INV library (new INV candidate).
- README.md: counts; backup format.
---END BROAD SCAN IMPLEMENTATION SUMMARY---
