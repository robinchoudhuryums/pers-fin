---BROAD SCAN IMPLEMENTATION SUMMARY---
Findings implemented: S4-4 (from .cycle/plan-seams4.md / Seams & Invariants audit #4)
- A2 — Perfin's "is this item's linked task open?" is Per-sistant's own predicate (openLinkedItems): a task you reopened by hand now covers Perfin's push, as it already hid Per-sistant's own line
- A6 — Per-sistant counts a Perfin push HELD for quiet hours as Perfin's, so a dashboard load between quiet hours ending and Perfin's release doesn't raise the item twice
- A5 — Perfin's embedded productivity stats (queryPersistentStats) use Per-sistant's /api/stats filters: no missed or auto-closed task counted done; overdue against the APP_TIMEZONE day
- A4 — the Per-sistant Perfin widget reads next_expected as its calendar-day text (a Perfin-pool Date serialized a day early east of UTC)
New capabilities (G/ST): None
Files modified: teller/routes/notifications.js, apps/per-sistant/routes/notifications.js, teller/routes/persistent.js,
  apps/per-sistant/routes/perfin.js, tests/cycle8-e3d.test.js, apps/per-sistant/tests/cycle8-e3e.test.js,
  tests/seams-audit-4-s4.test.js (new), tests/contract/seams4-s4-4.contract.test.js (new)

CHANGES:
A2 | teller/routes/notifications.js | itemCovered calls apps/per-sistant/services/linked-tasks.openLinkedItems(pp, [item]) (not completed, not trashed — no source_detached filter) instead of its own todos query; still no pool / a failed read → not covered. Decision (the plan's recommendation): a detached task counts as open — it is what the user sees in To-Dos.
A6 | apps/per-sistant/routes/notifications.js | perfinPushedItems: push_state IN ('sent', 'held') (an expired, muted, covered or none row isn't counted, so after a hold expires the entry notifies again).
A5 | teller/routes/persistent.js | queryPersistentStats(pool, today = todayStr()): done = completed AND NOT missed AND NOT auto_closed; overdue = due_date <= $1::date — the same SQL string as Per-sistant's /api/stats (pinned); exported.
A4 | apps/per-sistant/routes/perfin.js | the embedded query selects next_expected::text AS next_expected (widgetFigures' ymdOf already read a string).
Tests | tests/seams-audit-4-s4.test.js (7) + tests/contract/seams4-s4-4 (4: a hand-reopened task covered in Perfin and open in Per-sistant, a trashed one neither; held / sent counted, expired / muted not; Perfin's embedded stats equal /api/stats with a missed, an auto-closed and a due-today task; the widget's date equal to the stored day) + Category A updates (cycle8-e3d's fake Per-sistant pool answers openLinkedItems' query and its log text; cycle8-e3e's SQL pin reads the held state).

TEST RESULTS: npm test 3171/3172 — the one failure is tests/roadmap-t3-3-k2.test.js, the known node:test IPC flake (file-level "not ok"; 24/24 alone), not this change; contract 339/339 (+4); e2e 91/91. Red check: with the four production files reverted, 6 of the 7 new unit tests and all 4 contract tests fail.
REGRESSION RISKS:
- A2: a linked task you reopened by hand (detached — Perfin's sync no longer closes it) now keeps covering Perfin's push for that item until you complete or trash it; before, Perfin pushed beside it. The rent reminder's own 72 h dedup is unchanged.
- A2: Perfin's notifications route now requires a Per-sistant module (apps/per-sistant/services/linked-tasks.js) at lookup time, only when the shell wired a Per-sistant pool — a standalone Perfin never loads it (the existing linked-tasks runner already does the same).
- A6: if Perfin's release job never runs (the host asleep past quiet hours), Per-sistant stays quiet for that item until the hold expires (≤ 12 h) — before it notified at once.
INVARIANTS AT RISK: None broken. INV-153 / INV-149 now hold across both apps (one open-task predicate; a held push counted), INV-25 (perfinPool reads stay read-only).
NET SCORE: 0 − 1 = −1 (production fixes this month: none — A2 needs a hand-reopened rent / utility task with linked tasks on, A6 a dashboard load in the ≤15-minute window after quiet hours end, A5 has no UI caller, A4 a server east of UTC (Render is UTC). New failure mode: A6's quiet-until-expiry when the release job doesn't run (Low).)

OPERATOR ACTIONS / DEPLOY:
- None | BLOCKS DEPLOY: N
Deploy: Settings, Notifications & Cross-app / Per-sistant Backend — Render auto-deploys on push to main.

FOLLOW-ON ITEMS:
- queryPersistentReview (the same productivity-context route) still counts auto-closed tasks as completed this week and uses the server's local week — not in A5's finding.
- Per-sistant's housingDue reads Perfin's DATEs through perfinPool as node-pg Dates (the Batch 8 follow-on, minus the widget now).
- The rest of audit #4: S4-5 (.cycle/plan-seams4.md).

DOCUMENTATION UPDATES NEEDED:
- CLAUDE.md: notifications.js (itemCovered = Per-sistant's openLinkedItems, detached counts), Per-sistant's E3e check (sent or held), queryPersistentStats' filters, the Batch 8 follow-on (drop "the Perfin widget"; finance search already reads ::text — A4's doc drift), the audit #4 Known Open Issues entry (S4-4 done), INV-153 wording, test counts; apps/per-sistant/CLAUDE.md: the linked-tasks paragraph ("an open, untrashed, undetached task" → open and untrashed), the E3e notification paragraph (sent or held).
---END BROAD SCAN IMPLEMENTATION SUMMARY---
