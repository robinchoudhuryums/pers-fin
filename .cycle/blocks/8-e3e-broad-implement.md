---BROAD SCAN IMPLEMENTATION SUMMARY---
Findings implemented: None (E3e is an expansion batch)
New capabilities (G/ST): ST2 (Per-sistant half) — the notification check names each entry's real-world item, raises no browser notification for an item Perfin already pushed in the last 12 hours, and steps the rent line aside only for its own item's open task
Files modified: apps/per-sistant/routes/notifications.js, apps/per-sistant/routes/housing-due.js, apps/per-sistant/services/linked-tasks.js, apps/per-sistant/tests/broad-scan-c8-batch5.test.js, apps/per-sistant/tests/cycle8-e3e.test.js (new), tests/contract/notify-e3e.contract.test.js (new)

CHANGES:
ST2 | apps/per-sistant/routes/notifications.js | GET /api/notifications/check: due_today / overdue entries for a linked task carry `item` (source_key without "perfin:"); housing_due carries housing.item. perfinPushedItems(perfinPool, items) — read-only, the items with a notification_log row push_state 'sent' in the last 12 h (PUSHED_WINDOW_HOURS); standalone / failed read → none. annotateNotify(list, prefs, now, pushed) sets notify:false for a pushed item (the entry stays in the list). Exports perfinPushedItems, PUSHED_WINDOW_HOURS.
ST2 | apps/per-sistant/services/linked-tasks.js | openLinkedItems(pool, items, { app }) — the items with an open, untrashed task (source_key = ANY), fail-soft to an empty set.
ST2 | apps/per-sistant/routes/housing-due.js | housingItem(h, today) = housing:<month of the line's due date> (the oldest unpaid month when that one is overdue, else this month; this month when unscheduled). housingTaskOpen(pool, item) checks that item's task (it was any 'perfin:housing:%' task); housingDueUnlessTask returns the line with its `item`, or null while that item's task is open — the general "an open linked task covers its item" rule (also behind the AI briefing's rent line).
Test double | apps/per-sistant/tests/broad-scan-c8-batch5.test.js | the F23 fake answers the item query (perfin:housing:2026-10) instead of the LIKE; the fail-soft cases pass an item and quiet the logged error.
Not done (by plan — "noted, not invented") | — | bills and tax-doc linked tasks have no Perfin push today, so no caller gained a key for them.

TEST RESULTS: npm test 3095/3095 (9 new). Contract 321/322 — 3 new (notify-e3e) pass; the one failure is the pre-existing date-dependent cash-alerts-l2 (31-day month). e2e 74/74.
REGRESSION RISKS: (1) housing_due used to hide while ANY housing task was open; now only its own month's task hides it. When linked tasks run, the oldest unpaid month always has a task (rent tasks are made for every unpaid period in the window or overdue), so the line and a task should still not double up; a period whose task was trashed or deleted for good now lets the line show again (it was hidden before). (2) The check makes one more Perfin read (notification_log by item_key, no index on the column) when any entry has an item. (3) A rent push released from quiet hours keeps its original created_at, so its 12 h window starts at the hold, not at the push.
INVARIANTS AT RISK: INV-153 (entries kept, notify:false rather than dropped) — held; INV-149 (linked tasks only read) — held; INV-25 / INV-35 (perfinPool read-only, no HTTP) — held; F23's one-rent-reminder rule — narrowed to the item, see risk (1).
NET SCORE: 0 production fixes − 0 new failure modes = 0 (ST2 is a new capability)

OPERATOR ACTIONS / DEPLOY:
- None
Deploy: Platform, Shell & Auth: Render auto-deploys on push to `main` (no Deploy Command beyond the merge).

(Not complete in production until blocking operator actions are done AND the deploy step is confirmed.)

FOLLOW-ON ITEMS:
- notification_log.item_key has no index; the check's 12 h lookup scans by item_key (small table, retention-pruned).
- A rent push released after quiet hours is dated by its hold (created_at), so the 12 h window can end sooner than 12 h after the actual push.
- The dashboard's localStorage ledger and snooze stay as a per-device layer (by plan).
- Pre-existing: tests/contract/cash-alerts-l2 fails in 31-day months.

DOCUMENTATION UPDATES NEEDED:
- CLAUDE.md: Per-sistant Integration "Quiet hours and mutes for Per-sistant" bullet (item + pushed-in-12h), Per-sistant Tasks bullet (housing_due steps aside for its own item), E3 Known Issues (E3e done → ST2 complete, E3 complete) + follow-ons, INV-153 / INV-149 verify lists, test counts (3095 / 169 files; contract 322).
- apps/per-sistant/CLAUDE.md: Notification System (item, perfinPushedItems), housing-due key file (housingItem, item-specific task check), services/linked-tasks.js (openLinkedItems), test count 740 + the new test file.
- .cycle/plan-e3-notifications.md: E3e status and E3 done.
---END BROAD SCAN IMPLEMENTATION SUMMARY---
