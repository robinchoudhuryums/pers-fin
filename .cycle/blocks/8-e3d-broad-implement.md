---BROAD SCAN IMPLEMENTATION SUMMARY---
Findings implemented: None (E3d is an expansion batch)
New capabilities (G/ST): ST2 (core) — one real-world item, one alert: a Perfin push about an item Perfin also keeps as an open Per-sistant linked task is logged "covered" (read, not pushed); item_key recorded on every item-bearing push
Files modified: teller/routes/notifications.js, teller/routes/housing.js, teller/routes/subscriptions.js, teller/services/linked-tasks.js, teller/views/partials/nav.ejs, tests/cycle8-e3b.test.js, tests/cycle8-e3d.test.js (new), tests/contract/notify-e3d.contract.test.js (new)

CHANGES:
ST2 | teller/routes/notifications.js | sendToAll takes payload.item (the linked-task key without "perfin:" — validated by itemKey: kind:id shape, no "perfin:" prefix, else ignored). itemCovered(item) reads Per-sistant's todos through the shell-wired pool (persistent.getEmbeddedPersistentPool) — an open (not completed, not trashed, not detached) task with source_key 'perfin:'+item; standalone or a failed read → not covered (fail-soft, logged). Order: muted → covered → held → sent; covered beats "push not configured". The row is written with item_key and is_read = (covered); `logged` keeps its meaning; a covered push isn't sent; the push payload no longer carries `item`. releaseHeldNotifications marks a held row covered (and read) when its item's task opened since, pushing the rest. itemCovered exported.
ST2 | teller/routes/housing.js | runHousingReminders: the rent reminder carries item housing:<the tag's period>; the missing-utility-amount reminder utility-amount:<obligation id>.
ST2 | teller/services/linked-tasks.js + teller/routes/subscriptions.js | stillChargingItem(sub) — the one definition of a still-charging item (ensureStillChargingTask's key = "perfin:" + it); the watchdog's push carries it. The task is made after the push, so the first alert per charge is always pushed (a still-charging task has no due date and never interrupts on its own).
ST2 | teller/views/partials/nav.ejs | the bell says "Your Per-sistant task covers it — not pushed" for a covered row.
Test double | tests/cycle8-e3b.test.js | the fake notification_log reads the new INSERT params (item_key, is_read), the release SELECT's new column and the covered UPDATE's is_read.

TEST RESULTS: npm test 3086/3086 (11 new in tests/cycle8-e3d.test.js). Contract 318/319 — 3 new (notify-e3d) pass; the one failure is the pre-existing date-dependent cash-alerts-l2 (fails in a 31-day month — October). e2e not run (no page changed beyond one bell string; covered by the unit vm test). Mutation check not run (the sandbox refused the edit-and-restore command); the tests assert the covered state directly.
REGRESSION RISKS: (1) A rent / utility reminder now depends on a Per-sistant read when linked tasks exist — fail-soft to a push. (2) A covered reminder still counts as sent (`logged`), so the 72 h dedup holds the next reminder; if the task is completed by hand without paying, the next push comes after the 72 h window (by design: detached tasks don't cover). (3) The housing reminder's item is the tag's period; when the balance spans several months only that period's task is consulted. (4) Linked tasks are refreshed by a fire-and-forget kick after generation, so a housing tick's first reminder for a new period can run before its task exists → pushed once, covered afterwards.
INVARIANTS AT RISK: INV-153 (extended: covered acts on the interruption only — row written, `logged` unchanged) — held; INV-149 (linked tasks unchanged, only read) — held; INV-25 / INV-35 (cross-app reads through the wired pool, never HTTP) — held; INV-77 (the away reminders still run ungated) — held; INV-123 (watchdog marks only a logged alert) — held, a covered push is logged.
NET SCORE: 0 production fixes − 0 new failure modes = 0 (ST2 core is a new capability)

OPERATOR ACTIONS / DEPLOY:
- None
Deploy: Platform, Shell & Auth: Render auto-deploys on push to `main` (no Deploy Command needed for this change beyond the merge).

(Not complete in production until blocking operator actions are done AND the deploy step is confirmed.)

FOLLOW-ON ITEMS:
- E3e (queued): Per-sistant's half of ST2 — leave out a check entry whose item Perfin pushed in the last 12 h, and generalize housingDueUnlessTask.
- Only the housing / utility-amount / still-charging pushes carry an item; manual-bill and tax-document tasks have no matching Perfin push today, so nothing to cover.
- A still-charging alert is never covered on its first send (the task is made after it); a covered re-send only happens if the alert is forced again for the same charge.
- The covered lookup is one Per-sistant query per item-bearing push (no cache); fine at the reminders' 72 h cadence.
- Pre-existing: tests/contract/cash-alerts-l2 fails in 31-day months.

DOCUMENTATION UPDATES NEEDED:
- CLAUDE.md: notifications.js entry (item / covered / release recheck), Web Push + notification center bullets (the covered word), INV-153 (covered + the e3d tests), E3 Known Issues (E3d done + follow-ons), notification_log.item_key note (written since E3d), test counts (3086 / 168 files; contract 319) and the new test files.
- .cycle/plan-e3-notifications.md: E3d status (done here).
- README: Web Push paragraph — one alert per item when linked tasks are on.
---END BROAD SCAN IMPLEMENTATION SUMMARY---
