# Cycle 8 E2 — scheduler and watermark groundwork (plan, 2026-10-29)

Status: done — E2a, E2b, E2c, E2d (2026-10-29).

Scope: ST1 and ST3 from the cycle-8 expansion plan (`.cycle/plan-cycle8-expansion.md`).

Goal: a scheduled job runs because it is DUE (its last run is older than its cadence),
whether the process just woke, restarted or has been up for days (ST1); and the three
"what's new since X" checks never skip a row that committed late (ST3).

## What exists (read for this plan)
- **The scheduler** (`teller/startup.js` startBackgroundJobs): 16 `setInterval`s (1 h / 3 h /
  6 h) plus the watchdog (a 2-minute timeout, then 6 h), and since cycle-8 F27
  `scheduleBootRuns` — every job once, 60 s after boot then one per 20 s. Consequences:
  a host that sleeps between requests runs a job only at boot or when it stays up a full
  interval; a short restart (deploy, crash) re-runs every job at boot even when each ran
  minutes ago; an activity-gated job that finds the user away waits a full interval rather
  than running when they come back. Each job body keeps its own gates — activity
  (`isUserActive`, 15 min), the away channels' per-local-day settled memo
  (`awaySettledToday`), the not-due memo (`notDueYet` / `setNextDue`, F29) and its own
  watermark / dedup. `startup._awayJobs` / `_boot` are test seams.
- **Job health** (`teller/services/job-health.js`): `tick(name)` (in memory — "the scheduler
  fired"), `result(name, { ok, error })` (when the body ran), `flush(pool)` (UPSERT
  `job_runs` — only what changed; deliberately not on every tick so Neon can suspend),
  `checkMissedJobs` (36 h+ stale → one push per signature), `failingJobs()` (the uptime
  heartbeat). `JOB_INTERVALS_MS` is a second copy of the cadences in startup.js.
  `job_runs` = (job_name PK, last_run_at = last TICK, last_status, last_error, updated_at);
  nothing records when a job's body last ran.
- **Anomaly watermark** (`routes/enrollments.js` runAnomalyCheck, F1):
  `user_settings.last_anomaly_check_at` (text, µs kept) set to a high-water mark read before
  the candidates — `LEAST(MAX(created_at), MIN(xact_start) − 1µs of other backends holding
  an xid)`. Needs pg_stat_activity rights (else the writer bound is NULL and ignored) and
  stalls behind any long-open transaction (Batch 4 follow-on). Its push tag is per MERCHANT
  (`anomaly-<merchant>`), so notification_log can't tell which charge was announced.
- **Payday landed** (`services/payday-alerts.js` runPaydayLanded, F10 / F51):
  `last_income_alert_at` + a 24 h overlap rescan, deduped by its per-deposit tag
  (`payday-<hash>`) in notification_log. Already the overlap pattern ST3 wants, on
  created_at.
- **Since you last looked** (`routes/whats-new.js`): `last_dashboard_view_at`, set to `now()`
  by `POST /api/whats-new/seen` 4 s after the widget renders — a row committed between the
  GET and the POST is never shown; `gatherWhatsNew(since)` is shared with the daily digest
  (which passes its previous send time). New transactions = `created_at > since AND NOT
  pending`.
- `transactions.id` is a SERIAL. An id is allocated at INSERT, not at COMMIT, so a
  long-open transaction can make a LOWER id visible after a higher one — an id watermark
  alone has the same late-commit gap as created_at. What closes it is the overlap rescan
  with a per-row "already announced" check; the id makes the watermark exact (no clock,
  no µs truncation) and cheap (the PK index).

## Decisions (proposed; confirm at the first /broad-implement)
1. **One job registry** (`teller/services/job-runner.js`): `register({ name, everyMs, run })`;
   `JOB_INTERVALS_MS` is derived from it (one source for the cadences). startup.js
   registers its jobs instead of creating intervals; each `run` keeps its body's own gates
   unchanged.
2. **Due is decided in memory**: at start the runner reads `job_runs` ONCE (fail-soft — a
   failed read treats every job as due); after that a check every `CHECK_EVERY_MS` (5 min,
   unref'd) compares each job's last run with its cadence in memory — no database call when
   nothing is due, so Neon still suspends. Due jobs run one at a time (never two bodies of
   the same job at once), oldest-due first; a boot runs only what is due, so a 10-minute
   restart doesn't re-run every hourly job (replaces `scheduleBootRuns`; the boot spacing
   stays — the first check 60 s after start). (E2a: the `job_runs` read happens at that first check, not
   at start.)
3. **"Last run" is persisted when a job runs**: new `job_runs.last_ran_at TIMESTAMPTZ` (when
   the runner last STARTED the job's check — distinct from `last_run_at`, the heartbeat
   tick). Written by the runner's claim (decision 4) — one write per run, never per check.
4. **A claim, so two processes don't double-run** (a deploy overlap): the runner runs a job
   only after `UPDATE job_runs SET last_ran_at = now() WHERE job_name = $1 AND (last_ran_at
   IS NULL OR last_ran_at <= now() − everyMs × 0.9)` (an INSERT for a job with no row)
   returns a row; otherwise another process ran it — the in-memory time is refreshed from
   the row. A failed claim query runs the job anyway (fail-open: a missed run is worse than
   a duplicate; every body is idempotent / deduped).
5. **Gates stay in the bodies, with one change**: an activity-gated job (sheets auto-sync,
   net-worth snapshot, goal milestones, budget snapshot, the watchdog) registers a `when()`
   gate (`isUserActive`) that the runner checks IN MEMORY before the claim: a closed gate
   costs no query and keeps the job due — it runs at the first check after the user returns
   instead of a full interval later. (Decided at E2a: the plan first had the body return
   `{ skipped: 'away' }` and release its claim, which would have cost two writes per check
   while the user was away and kept Neon awake.)
6. **tick / result stay**: the runner calls `tick(name)` on every check that considers the
   job (the watchdog's "scheduler alive" signal is unchanged) and the body still calls
   `result`. `stopBackgroundJobs` stops the runner; shutdown unchanged.
7. **ST3 — id watermarks with an overlap rescan, one helper**: `services/txn-watermark.js`
   `newRows(db, { watermarkId, overlapHours = 24, extraWhere })` → the rows with `id >
   watermark` PLUS the rows created in the last `overlapHours` with `id <= watermark`; the
   caller drops the ones it already announced. The new watermark is `MAX(id)` read BEFORE
   the candidates (never moved backwards). No pg_stat_activity read.
   - **Anomaly**: `user_settings.last_anomaly_txn_id BIGINT` (migration: set from
     `MAX(id) WHERE created_at <= last_anomaly_check_at`); each push also records
     `data.transaction_id`, and an overlap row whose transaction_id is already in
     notification_log (type anomaly, 30 days) is skipped. (E2c: the helper became a SQL-fragment
     builder — `windowSql` — and the overlap is measured from the previous check's time, not now().) The tag stays per merchant (push
     collapsing). `last_anomaly_check_at` stays, written for display only.
   - **Payday landed**: `last_income_alert_txn_id BIGINT` beside the existing
     `last_income_alert_at`; candidates through the helper; the existing per-deposit tag
     lookup is the dedup. Switching the alerts on sets the id to the current MAX(id).
   - **Since you last looked**: GET /api/whats-new returns `seen_token` — the MAX(id) and the
     server time read before its queries; the widget POSTs it back to /seen, which stores
     `last_dashboard_view_txn_id` and `last_dashboard_view_at` from the token (GREATEST,
     never backwards; a POST without a token keeps today's `now()` behaviour for an older
     page). New transactions = `id > watermark id` (no overlap — a row shown twice is
     harmless here, a row never shown isn't; see follow-ons). Subscriptions and
     notifications stay on time, from the token's time. The daily digest keeps
     `gatherWhatsNew(since)` by time (its window is a whole day; out of scope).
8. **Out of scope**: Per-sistant's node-cron jobs; the shell's error-log flush and uptime
   heartbeat (not Perfin jobs); making any job's body cheaper; a pending row that settles
   later keeps its original id/created_at, so "Since you last looked" still won't list it
   (its pending=false filter) — a follow-on.

## Batches
| Batch | Scope | Est. | Status |
|-------|-------|------|--------|
| E2a | The runner (`services/job-runner.js`): registry, the one `job_runs` read at start, in-memory due checks every 5 min, one job at a time oldest-due first, the claim (decision 4) incl. its fail-open path, `{ skipped: 'away' }` keeping a job due and releasing its claim, stop(); the `job_runs.last_ran_at` migration; unit tests under node:test mock timers over a fake pool (nothing due → no query after start; due at start → runs once; a second process's claim → not run, time refreshed; a failed read → all due, staggered; an away skip → runs on the next check once active; stop). Not wired yet | 5h | done (2026-10-29) |
| E2b | Wire startup.js onto the runner: the 16 jobs + the watchdog registered with today's cadences, `scheduleBootRuns` / the intervals removed, `JOB_INTERVALS_MS` derived from the registry, the activity-gated bodies returning `{ skipped: 'away' }`, `stopBackgroundJobs` stopping it; rework `tests/broad-scan-c8-batch1.test.js` (every job runs once after boot when due; a restart right after a run runs nothing; none after stop) and the other startup pins; a contract test (two runners on one real database → each due job runs once; a job that ran 10 minutes ago isn't re-run by a new process) | 5h | done (2026-10-29) |
| E2c | ST3 for the anomaly and payday checks: `services/txn-watermark.js`, the two BIGINT columns + their backfill, runAnomalyCheck on it (pg_stat_activity read removed, `data.transaction_id`, the overlap dedup), runPaydayLanded on it (the tag dedup kept); unit tests over a fake pool and a contract test (an open transaction commits an anomaly charge and a paycheck with lower ids after a check ran — each announced once by the next run, never twice; replaces `tests/contract/c8-batch4`'s pg_stat_activity case) | 4h | done (2026-10-29) |
| E2d | ST3 for "Since you last looked": the `seen_token` on GET, /seen storing it (GREATEST; the token-less fallback), new transactions by id, the dashboard posting the token back; vm test of the widget's POST, unit tests of the route, a contract test (a row committed between the GET and /seen shows on the next visit), the e2e dashboard still clean | 2–3h | done (2026-10-29) |

Order: E2a → E2b; E2c / E2d are independent of the runner and of each other (either can run
first). Total ≈ 16–17h.

## Risks to watch
- E2b changes when every job runs — the one batch here that can silently stop a job. Its
  test must assert every registered job is reachable (registry ⊇ the old interval set) and
  the watchdog still ticks each one.
- The claim adds one write per job run; with ~16 jobs mostly hourly that is ≤ ~16 writes an
  hour while the process is awake — and only when a job is due, so an idle Neon still
  suspends between checks (the in-memory check makes no query).
- Changing the anomaly watermark's unit (time → id) must not re-announce history on the
  first run: the backfill sets the id from the existing time watermark.
