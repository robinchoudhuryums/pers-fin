---BROAD SCAN IMPLEMENTATION SUMMARY---
Findings implemented:
- F109 — Per-sistant DATE values (due dates, the review week, analytics days, Perfin next_expected) rendered a day early west of UTC and a task due on the 1st fell off the calendar; shared parseCalDate / fmtCalDate
- F113 — ~70 client writes ignored failures (Schedule email / Save task closed the modal on a 400 and lost the input; Undo offered after failed deletes); shared writeOk / tryFetch on every write
- F111 — a double-click on Send Now created and sent two emails; guardPending + disabled button
- F110 — last month's unpaid rent went silent from the 1st until this month's lead window; the oldest unpaid obligation's period drives "overdue"
- F112 — failed emails (incl. Perfin digests) never surfaced and perfin_webhook_recipient wasn't validated; email_failed notification + recipient 400
- F114 — the Job Radar "new roles" nudge counted saved listings and re-fired every 12h; new-only count, keyed to the newest lead, a week's client window
- F115 — note reminders used the UTC date and /api/stats overdue used UTC CURRENT_DATE; APP_TIMEZONE day for both
- F116 — the email_sent / note_created / reminder_due webhook events and Slack never fired; wired (user decision: wire up), plus a reminder_due cron with a once-per-reminder claim
- F117 — Job Radar refresh had no single-flight and the backstop workflow ran the same minute as the cron; single-flight, backstop moved to 09:47 and skipped when a refresh ran in the last 6h
- F118 — Ask counted from a 50-row sample with no warning; real totals over all data in the prompt
- F119 — the weekly review left out tasks due later in the current week; upcoming starts today
- F120 — "Save Draft" on a sent email turned it back into a draft; a PATCH to 'scheduled' without a time was accepted; sent is final (409), status settable only to draft/scheduled, scheduled needs a time
- F121 — attachments lived on Render's ephemeral disk and rows/links were orphaned on permanent delete; bytes in Postgres (user decision), legacy files copied at boot, leftovers purged with their entity — and the download route, shadowed by /:entityType/:entityId, never worked (found by the new contract test, fixed here)
- F122 — no 30-day trash purge despite the UI promising one; daily purgeTrash cron
- F123 — the general rate limiter applied under the shell; skipped when embedded (parity with PSC-8)
- F124 — parse-todo: APP_TIMEZONE "today", validated/normalized fields, escaped preview; webhook last_status 0 shown; automation/webhook parity for bulk complete, create-todo from note/email, template apply; streak_milestone fires once per day; literal search; PIN longer than 8 digits; calendar projections not capped at 100 steps; undo of a late recurring completion restores the old streak
New capabilities (G/ST): None (F116's wiring is a fix of advertised-but-dead options, not a G/ST item)
Files modified:
- apps/per-sistant/views/js.js, pages/{analytics,calendar,contacts,dashboard-script,emails,health,knowledge,notes,review,settings-script,today,todos-script-1,todos-script-2}.js
- apps/per-sistant/routes/{ai,attachments,auth,bulk,calendar,emails,health,housing-due,jobs,links,notes,notifications,review,search,settings,todoTemplates,todos,trash}.js
- apps/per-sistant/{helpers,middleware,server}.js
- apps/per-sistant/db/025_attachments_data.sql, 026_note_reminder_fired.sql, 027_streak_before_completion.sql (new)
- .github/workflows/job-radar.yml
- apps/per-sistant/tests/scan-oct-batch11.test.js (new), tests/contract/persistent-batch11.contract.test.js (new), tests/scan-oct-batch3.test.js (helpers.js bare-catch count 4 → 3)

CHANGES:
F109 | views/js.js, dashboard-script/review/today/todos-script-1/calendar/analytics | parseCalDate (string-only parse — template-literal module), fmtCalDate, ymdOfLocal; calendar reads todo event_date as a DATE, email/note times as timestamps
F113 | views/js.js + 12 page scripts | writeOk(res, what) (toast via showUndo 'info', never an Undo), tryFetch; saves keep their modal on failure; deletes offer Undo only after success; bulk, subtasks, templates, webhooks, automations, trash, contacts, habits, fact verify, layout all report
F111 | views/js.js, pages/emails.js | guardPending(key, fn); sendNow wrapped + button disabled
F110 | routes/housing-due.js | computeHousingDue(…, oldest {period, due_day}) → overdue from an earlier month's due date (clamped); housingDue selects the oldest unpaid row
F112 | routes/settings.js, routes/notifications.js, pages/dashboard-script.js | perfin_webhook_recipient EMAIL_REGEX (400); failedEmails (status 'failed', ≤14 days) → email_failed notifications + count; client prefix, browser notify, /emails link
F114 | routes/jobs.js, routes/notifications.js, pages/dashboard-script.js | counts.main_new / top_new / newest_first_seen; job_radar id = newest first_seen; NOTIFY_WINDOW_BY_TYPE job_radar 7d (ledger prune per type)
F115 | routes/notifications.js, routes/settings.js | (reminder_at AT TIME ZONE $tz)::date = today; /api/stats overdue due_date <= todayStr()
F116 | helpers.js, routes/emails.js, routes/notes.js, server.js, db/026 | slackLineFor + fireWebhooks posts to Slack (logs instead of a bare catch); email_sent on manual + cron send; note_created (no note text in the payload); processDueReminders (claim via reminder_fired_at, last day only) on a 10-minute cron
F117 | routes/jobs.js, job-radar.yml | runRefresh single-flight (shared promise); non-forced refresh skipped ('recent') when a listing was seen in the last 6h; workflow cron 47 9 * * 1
F118 | routes/ai.js | totals query (open / overdue / due today / done tasks, emails by status, notes) in the prompt; lists labelled samples; APP_TIMEZONE today
F119 | routes/review.js | upcoming = due_date >= todayStr() AND < week end + 7
F120 | routes/emails.js | PATCH: status only draft|scheduled (400), scheduled_at must parse, sent row → 409 (re-checked in the UPDATE), effective scheduled needs a time
F121 | routes/attachments.js, routes/trash.js, db/025 | memoryStorage → attachments.data BYTEA (10MB); lists/uploads return META_COLUMNS (+ stored), never bytes; download from the row, legacy disk fallback, clear 404 when gone; migrateDiskAttachments at boot; download route declared before the generic list route; purgeEntityLeftovers (attachments + entity_links + note chunks) on permanent delete / empty
F122 | routes/trash.js, server.js | purgeTrash(pool, olderThanDays) shared by Empty Trash and a daily 03:41 APP_TIMEZONE cron (TRASH_RETENTION_DAYS 30)
F123 | middleware.js | generalLimiter skip when req.app.get("embedded")
F124 | routes/ai.js, pages/todos-script-2.js, pages/settings-script.js, routes/{bulk,links,todoTemplates,health,search,auth,calendar,todos}.js, helpers.js, db/027 | normalizeParsedTodo + todayStr; escaped preview; last_status != null; announceTodoEvent (automations + webhooks) on bulk complete / create-todo / template apply; dayAlreadyMet milestone guard; LIKE escape; PIN cap 64; projection bound 5000; streak_before_completion stored and restored on undo

TEST RESULTS: passed — npm test 1678/1678 (+29 apps/per-sistant/tests/scan-oct-batch11.test.js); contract 99/99 (+9 persistent-batch11); migrations twice (27 Per-sistant files); Playwright 35/35. Every new test fails without the fixes (29/29 unit, 9/9 contract).
REGRESSION RISKS:
- F121: attachment bytes now count against the Per-sistant database size (Neon's free tier is 0.5 GB); a 10MB-per-file cap is the only bound.
- F117: a manual workflow_dispatch of job-radar.yml within 6 hours of a refresh is skipped ('recent'); the page's Refresh (force=1) still runs.
- F116: Slack (when a URL is set) now receives every event, including each task created/completed — chattier than nothing.
- F120: PATCH on a sent email is a 409; any client path that edited a sent email now gets an error toast.
- F124: a template apply / create-todo / bulk complete now runs automations (could create follow-up todos users didn't expect from those paths).
INVARIANTS AT RISK: None — INV-96 (routers still destructure only deps; helpers required as modules), INV-97 (no new regex in client template literals — parseCalDate uses string methods; batch15 guard green), INV-19 (attachments / trash / ai helpers attached after the factory), INV-52/66 (fail-soft aggregators unchanged), INV-106 (bare-catch count shrank, map updated) checked.
NET SCORE: 6 − 2 = 4 (production fixes: F109, F113, F110, F119, F121, F123; new failure modes: F121 database growth, F117 skipped manual backstop runs)

OPERATOR ACTIONS / DEPLOY:
- None — db/025–027 auto-migrate; on first boot the attachments router copies any files still on the instance's uploads/ disk into Postgres (files already wiped by earlier deploys can't be recovered; their downloads say so) | BLOCKS DEPLOY: N
Deploy: Platform, Shell & Auth — Render auto-deploys on push to `main` (alt: `fly deploy`).

(Not complete in production until blocking operator actions are done AND
the deploy step is confirmed.)

FOLLOW-ON ITEMS:
- Quick Add's LOCAL parser still builds the due date with toISOString() (UTC) — the existing Per-sistant Known Issue (only the AI parse-todo "today" was in scope).
- PATCH /api/settings still stores session_timeout_minutes and default_horizon unvalidated (existing Known Issue).
- Email attachments are stored but never attached when the email is sent.
- A failed email has no one-click Retry (open it and press Send now); the Emails list doesn't show error_message.
- The palette / mode / collapsed-nav preference PATCHes (views.js, settings-patch.js) still ignore failures — localStorage-first by design.
- The 90-day heatmaps and SQL CURRENT_DATE range windows remain UTC (documented residual).
(or "None")

DOCUMENTATION UPDATES NEEDED:
- apps/per-sistant/CLAUDE.md: attachments in Postgres (File Attachments bullet, db list 025–027, Attachments API — download route order), trash purge (Trash/Undo — the 30 days are now real), webhooks/Slack firing (Webhooks + Slack bullets, reminder_due cron), email PATCH rules (Backend Validation / Email Drafting), Send Now single-flight, writeOk/tryFetch/guardPending/parseCalDate in views/js.js (CSRF/fetch-wrapper bullet + a client-kit note), notification check email_failed + note reminder tz (Notification System, APP_TIMEZONE), Job Radar new-only nudge + refresh single-flight/skip-recent + workflow time, Ask totals, review upcoming, rate limiter skip (Rate Limiting), housing-due oldest unpaid, PIN length, calendar projection bound, undo streak restore, milestone once, literal search, parse-todo validation, perfin_webhook_recipient validation (Database note), Known Open Issues (shrink: Quick Add unchanged), test count (+29).
- CLAUDE.md (root): counts (1678 across 78 files; Per-sistant 485; contract 99), the persistent-batch11 contract file, Known Issues (remove F123 limiter + the Review-summary? no — keep; add Batch 11 follow-ons), INV entries (writeOk class for Per-sistant, attachments in Postgres), e2e KNOWN_GAPS note on F123 if referenced.
- README: counts + Batch 11 summary.
---END BROAD SCAN IMPLEMENTATION SUMMARY---
