---BROAD SCAN IMPLEMENTATION SUMMARY---
Findings implemented:
- F44 — a push held for quiet hours expires 12 hours after the quiet window ENDS, not 12 hours after it was made (with a window of 12 hours or more, everything held early in it was never pushed)
- F34 — the rent reminder's window, dedup tag and item follow the oldest unpaid month (last month's unpaid rent got no push from the 1st until this month's window opened, and the push named the wrong month)
- F45 — a Per-sistant linked task stands in for a reminder only while it is showing (due today or earlier); during the rent lead window the reminder reached no one
- F47 — `GET /api/settings` answers 500 on a failed read; the two toggle maps are merged server-side and the page sends one key; ten switches and the idle timeout parse strictly
- F46 — a push that failed on every device is kept and retried by the release job
- F48 — reopening an auto-closed linked task by hand clears `auto_closed`
- F49 — a non-string SSO token is a 400 instead of a crash (standalone); the wait to the end of quiet hours is right on a night the clocks change
New capabilities (G/ST): None
Files modified:
- teller/routes/notifications.js
- teller/services/notify-prefs.js
- teller/services/database.js (CHECK_LISTS: push_state gains `retry`)
- teller/views/partials/nav.ejs
- teller/routes/housing.js
- teller/routes/settings.js
- teller/views/settings.ejs
- teller/routes/persistent.js
- apps/per-sistant/services/linked-tasks.js
- apps/per-sistant/routes/housing-due.js
- apps/per-sistant/db/030_linked_tasks.sql
- tests/cycle9-b5.test.js (new, 46 tests)
- apps/per-sistant/tests/cycle9-b5.test.js (new, 10 tests)
- tests/contract/c9-batch5.contract.test.js (new, 14 tests)
- tests/cycle8-e3a.test.js, tests/cycle8-e3b.test.js, tests/cycle8-e3d.test.js, tests/seams-audit-4-s4.test.js, tests/roadmap-t2-4-x2a.test.js, apps/per-sistant/tests/broad-scan-c8-batch5.test.js, apps/per-sistant/tests/roadmap-t2-4-x1a.test.js, tests/contract/linked-tasks.contract.test.js, tests/contract/seams4-s4-4.contract.test.js (doubles and pins that encoded the old SQL / behaviour)
- .cycle/STATE.md, .cycle/blocks/9-batch5-broad-implement.md

CHANGES:
F44 | teller/routes/notifications.js | The release job reads the waiting rows with their created_at and decides expiry per row in code: a row's base is its creation time plus what was left of the quiet hours it was created in (by today's settings), or its creation time when it wasn't created in quiet hours. It expires once it has waited more than 12 hours past that base. The SQL expiry (created_at older than 12 hours) is gone.
F46 | teller/routes/notifications.js, teller/services/database.js, teller/views/partials/nav.ejs | New push_state `retry`. When a push reaches no device and at least one send failed for a reason that can pass (a push-service 5xx / timeout, or the subscription read itself), sendToAll marks the row `retry` and opens the release gate; `logged` is unchanged. No subscription, or only dead ones (404 / 410, now counted as `gone`), is still `none`. The release job picks up `held` and `retry` rows alike, pushes one as itself and several as one summary ("N notifications waiting" when any is a retry), and gives up on a retry after 12 hours. The bell says "Push failed — trying again".
F34 | teller/routes/housing.js | The unpaid-balance read also returns MIN(period). The payment-due window is tested for that month; the item is that month's (`housing:<oldest>`), which is the month the linked task and Per-sistant's line name. The dedup tag is next month's when next month's rent is being announced, else the oldest month's.
F45 | apps/per-sistant/services/linked-tasks.js, apps/per-sistant/routes/housing-due.js, teller/routes/notifications.js | openLinkedItems takes `surfacingOn` ('YYYY-MM-DD'): only tasks due that day or earlier. Perfin's itemCovered (the push, and a held push at release) and Per-sistant's housingTaskOpen / housingDueUnlessTask (the notification check and the briefing's rent line) pass the APP_TIMEZONE day. A task due later, or with no due date, no longer covers.
F47 | teller/routes/settings.js | GET: a failed read is logged and answered 500 `{ error: "Your settings couldn't be read — try again." }`. PATCH: `insight_modules` and `dashboard_widgets` are merged over the stored map (`col || $n::jsonb`); the ten plain switches (insights_enabled, keep_alive_enabled, sheets_auto_sync_enabled, auto_sync_enabled, csv_reminder_enabled, persistent_webhook_enabled, sync_notifications_enabled, weekly_digest_enabled, daily_digest_enabled, critical_alert_emails_enabled) take only true / false — a 400 before any query otherwise; the idle timeout must be an integer (7.5 was a 500).
F47 | teller/views/settings.ejs | The module and widget toggles send only the key that changed and no longer read the settings first. A failed settings load shows "Your settings couldn't be loaded — reload the page before changing anything."
F48 | apps/per-sistant/db/030_linked_tasks.sql | The detach trigger's function also sets `auto_closed := false`. One repair statement clears it on rows that are both detached and auto_closed (the sync never produces that pair; a second run matches nothing).
F49 | teller/routes/persistent.js | POST /api/sso/validate answers 400 "Token must be a string." for a non-string token.
F49 | teller/services/notify-prefs.js | minutesUntilQuietEnd checks where its wall-clock guess lands and corrects by the difference, so it returns real minutes: 480 on the spring-forward night (it was 540), 600 on the fall-back night.

TEST RESULTS: passed.
- `npm test`: 3410 / 3410 (56 new; 183 test files; Perfin 2657, Per-sistant 753).
- Route contract suite on a local Postgres 16: 370 / 370 (14 new).
- Playwright: 93 / 93 (smoke, every-page with the click sweep, behaviour).
- The two new unit files and nine neighbouring files under five shifted clocks (2026-12-31, 2027-01-31, 2027-03-14 — a spring-forward night, 2027-11-07 — a fall-back night, 2028-02-29): 181 / 181 each. The contract file was not run under a shifted clock (the database keeps the real date).
- Mutation check: against the pre-fix code the new files fail 36 of 46 (Perfin unit), 5 of 10 (Per-sistant unit) and 14 of 14 (contract).
- Regression scenarios: S4 (embedded auth gate + cross-pool wiring) — PASS by the contract suites that wire both pools and the e2e run; S1, S2, S3, S5, S6, SK1–SK5 — not applicable to the files changed.

REGRESSION RISKS:
- A push subscription that fails with a lasting error other than 404 / 410 (for example a 403 from a VAPID key mismatch) now turns each notification into a 12-hour retry, and the notify-release job reports a failed run every 15 minutes while one is waiting — Sync Health shows it and the uptime heartbeat pings /fail. Before, the row was quietly marked `none`.
- After an outage several notifications come back as one summary push, not one each.
- A retry is not counted by Per-sistant as "Perfin pushed it", so Per-sistant may raise its own browser notification and Perfin's retry may then succeed too — two interruptions for one item.
- Moving a linked task's due date later (snoozing it) now lets Perfin's push and Per-sistant's rent line through again: the task only stands in while it is due.
- With Per-sistant Tasks on, the rent push comes back during the lead window (one per 72 hours), and an unpaid earlier month is now pushed every 72 hours all month.
- A script or client that sent `1`, `"true"` or `"false"` for one of the ten switches now gets a 400. The Settings page sends booleans for all ten.
- A client can no longer remove a key from `insight_modules` / `dashboard_widgets` by leaving it out (the map is merged).
- Any page that treated `GET /api/settings` as always-200 would now see a 500 on a database error; every caller in the repo checks `res.ok`.

INVARIANTS AT RISK: None broken. Wording to update at /sync-docs: INV-153 (a task covers only while it is due today or earlier; `retry`; expiry counted from the end of the quiet window), INV-59 (the ten switches and the idle timeout are strict), INV-149 (a hand change clears auto_closed). INV-17 holds (the repair statement is re-runnable; the migration test and contract re-run pass). INV-77 holds (the release job's gate is still in memory). INV-89 holds (the toggles still go through updateSetting and put the control back on a refused save). The new CHECK value went into CHECK_LISTS, as the Database rules require.
NET SCORE: 1 − 2 = −1
- Production fixes this month: 1, likely rather than confirmed — F45: with Per-sistant Tasks on and a reminder lead of a day or more, each month's rent lead-time reminder reached no one. The others need a setting or event I can't see: a quiet window of 12 hours or more (F44), an unpaid earlier month (F34), a failed settings read or two toggles in the same second (F47), a push-service failure (F46), a hand reopen of an auto-closed task (F48), a standalone deployment or the March clock change (F49).
- New failure modes: 2 — a lasting push failure is now a repeating failed job for up to 12 hours per notification (Low-Medium; it was silent before); snoozing a linked task un-covers its reminder (Low).

OPERATOR ACTIONS / DEPLOY:
- None required. If the notify-release job shows as failing in Settings → Sync Health after this deploys, a device's push subscription is being refused: remove and re-register push on that device (Settings → notifications). | BLOCKS DEPLOY: N
Deploy: Settings, Notifications & Cross-app / Financial Analytics / Per-sistant Backend / Platform, Shell & Auth — Render auto-deploys on push to `main` (this work is on `claude/gracious-maxwell-li0vm7`; no PR opened). The boot migrations add `retry` to the push_state CHECK (Perfin) and replace the trigger function and repair old rows (Per-sistant).

(Not complete in production until blocking operator actions are done AND
the deploy step is confirmed.)

FOLLOW-ON ITEMS:
- The dashboard's Debt Payoff pyramid mode overwrites the stored debt baseline with today's debt when its settings read fails (`teller/views/dashboard.ejs` — the same "failed read, then write" shape as F47, in a file F47 didn't name).
- A retry that gives up shows in the bell as "Held for quiet hours — not pushed" (the one wording for `expired`).
- A push that is never held (PIN lockout, the test notification) and fails during quiet hours is retried only once quiet hours end.
- A lasting push error (403) isn't told apart from a passing one (5xx); it is retried for the full 12 hours.
- A row's quiet window is worked out from today's quiet-hours settings, not the ones in force when it was held.
- Per-sistant's own `PATCH /api/settings` was not part of F47 and is unchanged.
- With several months owed, only the oldest month's task is consulted for the cover.

DOCUMENTATION UPDATES NEEDED:
- CLAUDE.md: the notifications.js entry and the Web Push / notification-center sections (`retry`, the release job's waiting rows, per-row expiry from the window's end, covered only while the task is due, the bell wording); notify-prefs.js (real minutes to the quiet end); the housing.js entry and the Rent & Utilities reminder text (oldest unpaid month; tag and item); the Per-sistant tasks feature and the linked-tasks entries in both CLAUDE.md files (`surfacingOn`; a hand change clears auto_closed; db/030); the settings.js entry, the `PATCH /api/settings` notes and the Settings layout note (500 on a failed read, merged maps, strict switches, the idle timeout); `notification_log.push_state` and CHECK_LISTS under Database; the Security note on SSO; the test list (tests/cycle9-b5.test.js, apps/per-sistant/tests/cycle9-b5.test.js, tests/contract/c9-batch5) and counts (3410 tests, 183 files, Perfin 2657, Per-sistant 753; contract 370); the cycle-9 Known Open Issues entry (Batch 5 done, follow-ons); INV-59 / INV-149 / INV-153 wording.
- apps/per-sistant/CLAUDE.md: the linked-tasks and housing-due entries, the notification-check text, db/030, the test count (753).
- README: test counts.
---END BROAD SCAN IMPLEMENTATION SUMMARY---
