---BROAD SCAN IMPLEMENTATION SUMMARY---
Findings implemented:
- PSC-1 (+DD-7): auto-sync now respects the sync-notifications toggle and stays silent unless something actually changed.
- PSC-3: the away-from-app channels (budget push and critical email, weekly digest, daily digest, CSV reminder) no longer depend on recent Perfin activity.
- PSC-2: the keep-alive schedule check no longer counts as user activity and no longer queries the DB on every ping.
- PSC-12: single-flight guards on syncAllTransactions, syncAllBalances and runCategorize.
- DD-5: "since you last looked" and the daily digest now catch balance changes made later on the same day.
- DD-6: balance-change colour and sign now account for card and loan debt; digest money formatting fixed.
- PB-1: every notification-check type reaches the user (browser notification plus an in-page Reminders widget).
- PB-3: POST /api/jobs/refresh honors job_radar_enabled; the page button sends ?force=1.
- PB-11: skip-recurring is atomic and idempotent.
- PB-12: bulk "complete" keeps recurring series alive.
- PD-3: completing or skipping a late recurring task schedules the next one after today.
- PD-8: the email scheduler claims one row per iteration.

Files modified:
teller/routes/enrollments.js, teller/routes/categorize.js, teller/startup.js,
teller/services/database.js, teller/services/job-health.js,
teller/services/keep-alive.js, teller/server.js, teller/routes/settings.js,
teller/routes/insights.js, teller/routes/whats-new.js,
teller/routes/insights-email.js, teller/views/dashboard.ejs,
apps/per-sistant/helpers.js, apps/per-sistant/routes/todos.js,
apps/per-sistant/routes/bulk.js, apps/per-sistant/server.js,
apps/per-sistant/routes/jobs.js, apps/per-sistant/pages/jobs.js,
apps/per-sistant/pages/dashboard.js, apps/per-sistant/pages/dashboard-script.js,
tests/ops-and-alerts.test.js, tests/scan-sept-batch6.test.js,
apps/per-sistant/tests/cycle-fixes.test.js,
NEW tests/scan-sept-batch8.test.js, NEW apps/per-sistant/tests/scan-sept-batch8.test.js

CHANGES:
PSC-1/DD-7 | startup.js, enrollments.js | The bank-auto-sync SELECT now reads sync_notifications_enabled, so the Settings toggle works. syncAllBalances' UPDATE is now a `WITH prev AS (...) UPDATE ... RETURNING (prev.* IS DISTINCT FROM ROUND($n::numeric,2)) AS changed` and returns a new `accounts_changed` count. `accounts_updated` keeps its meaning for the API. The "anything changed" notification gate uses txnsAdded > 0 || accounts_changed > 0.
PSC-3 | startup.js, database.js, job-health.js, insights.js | Budget alerts, the weekly digest, the daily digest and the CSV reminder moved into module-level tick functions with no isUserActive gate. They rely on their watermarks plus a per-local-day in-memory "settled" memo (localDay(), APP_TIMEZONE), so at most about one cheap DB read per job per day once settled. Before DAILY_DIGEST_HOUR the daily digest makes no DB call. The CSV reminder now ticks hourly, gated by the new `user_settings.last_csv_reminder_at` (auto-migrated) and a 24h minimum gap. Job-health interval: csv-reminder is 1h. insights.js exports DAILY_DIGEST_HOUR. Exported as `_awayJobs` for tests.
PSC-2 | keep-alive.js, server.js, settings.js | touchActivity skips /api/keep-alive-schedule. The schedule route and the self-ping read getKeepAliveConfigCached() (6h TTL). PATCH /api/settings invalidates that cache when any keep_alive_* key changes.
PSC-12 | enrollments.js, categorize.js | Module-level in-flight promise guards: a concurrent caller shares the running run's promise and result. None of these helpers take arguments.
DD-5 | whats-new.js | The baseline is the newest snapshot strictly BEFORE the watermark's day, and the current snapshot may be from that same day (`>=`).
DD-6 | whats-new.js, insights-email.js, dashboard.ejs | Rows now carry account_type, is_debt and favorable (for debt, a decrease is good). The email HTML and text and the dashboard widget colour by favorable, add " owed" for debt, and format negatives as -$X rather than $-X.
PB-1 | dashboard-script.js, dashboard.js | Browser notifications now cover overdue, due_today, streak_at_risk, habit_streak_at_risk, reminder, job_radar, fact_upcoming within 7 days, and housing_due when due today, overdue or within 3 days, each with a per-type prefix. A new "reminders" dashboard widget renders the full check list whether or not Notification permission is granted.
PB-3 | routes/jobs.js, pages/jobs.js | The refresh endpoint returns {ok, skipped:'disabled'} when the feature is off. The page button sends ?force=1. The cron and the Actions backstop now respect the flag.
PB-11/PD-3 | routes/todos.js, helpers.js | Complete and skip now share completeRecurringTodo / skipRecurringTodo: a transaction with SELECT ... AND deleted_at IS NULL FOR UPDATE, then 404 / "Not a recurring task." / "Task already completed.". The next due date comes from the new helpers.nextDueAfter(todo, today), which keeps the anchor day and advances past today. Skip keeps its carried counters.
PB-12 | routes/bulk.js | Recurring incomplete ids go through completeRecurringTodo. The plain UPDATE excludes them with NOT (id = ANY($2::int[])).
PD-8 | server.js | processScheduledEmails loops up to MAX_PER_RUN=100. Each iteration claims one row with `WHERE id = (SELECT ... ORDER BY scheduled_at, id LIMIT 1 FOR UPDATE SKIP LOCKED)`.

TEST RESULTS: passed. npm test 1426/1426 (Perfin 908 + Per-sistant 518; 58 files).
- New: tests/scan-sept-batch8.test.js (17) and apps/per-sistant/tests/scan-sept-batch8.test.js (13). No new test passes against the old source (worktree run).
- Test doubles updated for the new behaviour: ops-and-alerts csv-reminder threshold (36h floor), batch6 weekday pin → localDay(), Per-sistant cycle-fixes lock regex (deleted_at guard).
- Real-Postgres checks (both migrations run twice, which also covers last_csv_reminder_at):
  - Balance CTE: unchanged, sub-cent rounding, changed, to-null, null-unchanged and unknown-account cases.
  - gatherWhatsNew: a same-day change on a depository and a credit account gives the right delta, is_debt and favorable.
  - runCsvReminderTick: stamps the watermark and logs one notification.
  - Per-sistant: the one-row email claim takes rows in order and skips future ones; complete/skip on a week-late daily task are due tomorrow; re-skip and skip of a completed task return 400 with no extra instance; a concurrent double-skip yields one next instance; bulk complete continues the series.
- Dashboard EJS inline scripts and the emitted Per-sistant dashboard bundle pass node --check. e2e 8/8.

REGRESSION RISKS:
- Budget alerts now run every 3h while the process is awake, even when the user is idle. That is a short DB query and can wake Neon up to 8 times a day. It is deliberate (PSC-3: the alert matters most when away), but it costs some Neon compute.
- Single-flight: a manual POST /api/sync or /api/categorize that overlaps a scheduled run returns that run's result, including its errors, instead of starting a second run.
- DD-5: a change earlier on the watermark's own day can be reported again on the next view.
- Daily digest: once it settles on nothing_new for the local day, a later same-day change waits for tomorrow's digest (which covers the gap).
- PSC-2 fixes the DB/activity side only. keep-alive.yml still wakes Render every 14 minutes, around the clock.
- complete-recurring now 404s for a trashed (deleted_at) row; before, it completed it. Skip now carries the catch-up due date.

INVARIANTS AT RISK: None.
- INV-18 holds: the away jobs call in-process helpers.
- INV-19 holds: the new exports are attached after module.exports = router.
- INV-17 holds: ADD COLUMN IF NOT EXISTS runs in the migration transaction.
- INV-54 holds: the sync helpers are unchanged inside; a single-flight only shares a run.
- INV-64/65/66 hold: refresh still uses cappedCall and the same dedup.
- INV-74 strengthened: nextDueAfter keeps the anchor day.

NET SCORE:
- Fired in production this month: PSC-1, PSC-3, PSC-2, DD-5, DD-6, PB-1, PB-3, PB-11, PB-12, PD-3 = YES. PSC-12 = NO (needs a collision at the boundary). PD-8 = NO (needs a backlog plus a restart).
- New failure modes: none (the trade-offs above are documented choices).
- Score: 10 − 0 = 10.

OPERATOR ACTIONS / DEPLOY:
- None required. The last_csv_reminder_at column auto-migrates. | BLOCKS DEPLOY: N
Deploy: Platform, Shell & Auth — Render auto-deploys on push to `main` (alt: `fly deploy`).

FOLLOW-ON ITEMS:
- keep-alive.yml still pings every 14 min around the clock. Move the active-hours schedule into a repo variable, or serve it pre-auth from the shell, so the workflow skips calls outside active hours (the Render wake side of PSC-2).
- Plaid balance changes aren't counted in accounts_changed (syncAllPlaidBalances has no changed count). This is pre-existing; Plaid balances never fed the gate.
- The complete-recurring response still returns the pre-update row (completed:false), as it did before.
- The Reminders widget has no per-item dismiss.

DOCUMENTATION UPDATES NEEDED:
- CLAUDE.md Scheduled Tasks: budget alerts, weekly/daily digest and CSV reminder are no longer activity-gated (watermark + per-day memo); CSV reminder is hourly with last_csv_reminder_at; the bank-auto-sync notification gate uses accounts_changed and sync_notifications_enabled; single-flight guards.
- CLAUDE.md: keep-alive config cache, and /api/keep-alive-schedule not counted as activity.
- CLAUDE.md: whats-new baseline rule plus account_type / is_debt / favorable fields; the digest renderers.
- CLAUDE.md Database: user_settings.last_csv_reminder_at.
- CLAUDE.md: test counts 1426 / 58 (Perfin 908 + Per-sistant 518).
- apps/per-sistant/CLAUDE.md: Reminders widget and notification types, refresh ?force=1, nextDueAfter catch-up, shared complete/skip used by bulk, one-row email claim.
---END BROAD SCAN IMPLEMENTATION SUMMARY---
