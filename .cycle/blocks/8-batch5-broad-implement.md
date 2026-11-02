---BROAD SCAN IMPLEMENTATION SUMMARY---
Findings implemented:
- F16 — a linked task deleted for good (permanent delete, Empty Trash, the 30-day purge) is never recreated: db/031's BEFORE DELETE trigger keeps its key in linked_task_tombstones and the sync's insert skips a listed key (it used to come back on the next sync, re-firing automations, webhooks and Slack)
- F17 — an unpaid manual-bill task older than the 30-day creation window stays open until the bill is marked paid: Perfin passes those keys as `retain` (it used to drop them, which closed the task as completed on day 31)
- F18 — a task the sync closes is not your completion: no todo_completed automation / webhook / Slack post, and analytics, the weekly review (and so its AI summary), Ask's totals and /api/stats "done" leave auto-closed tasks out
- F19 — a linked task's outbound webhook and Slack payload carry only a kind label ("Perfin task: rent & utilities due"), its dates and state — never the title, description or snapshot with Perfin's amounts, payees and merchants
- F20 — one linked-task sync at a time across processes: each run is one transaction holding pg_advisory_xact_lock(727274010), and creations are announced only after COMMIT
- F22 — PATCH /api/housing/config and the manual-bill POST / PATCH / DELETE kick the linked-task refresh, and the housing ledger tick kicks when it generated obligations
- F23 — the notification check's housing_due entry and the briefing's rent line step aside while a housing linked task is open (the task is the reminder)
- F21 — the hourly linked-task tick runs once a local day: after a clean run it reads neither database until the next local day, a kick, Run now or invalidate(); a partial run is retried the next hour
New capabilities (G/ST): None
Files modified:
- apps/per-sistant/db/031_linked_task_tombstones.sql (new)
- apps/per-sistant/services/linked-tasks.js
- apps/per-sistant/helpers.js
- apps/per-sistant/routes/analytics.js
- apps/per-sistant/routes/review.js
- apps/per-sistant/routes/ai.js
- apps/per-sistant/routes/settings.js
- apps/per-sistant/routes/housing-due.js
- apps/per-sistant/routes/notifications.js
- teller/services/linked-tasks.js
- teller/routes/housing.js
- teller/routes/subscriptions.js
- teller/startup.js
- apps/per-sistant/tests/broad-scan-c8-batch5.test.js (new)
- apps/per-sistant/tests/_linked-tasks-fake.js
- apps/per-sistant/tests/roadmap-t2-4-x1a.test.js
- apps/per-sistant/tests/health.test.js
- apps/per-sistant/tests/scan-sept-batch6.test.js
- tests/broad-scan-c8-batch5.test.js (new)
- tests/contract/c8-batch5.contract.test.js (new)
- tests/roadmap-t2-4-x2b.test.js

CHANGES:
F16 | apps/per-sistant/db/031_linked_task_tombstones.sql, apps/per-sistant/services/linked-tasks.js | linked_task_tombstones (source_key PK, deleted_at); trg_todos_tombstone_linked BEFORE DELETE ON todos WHEN OLD.source_key IS NOT NULL inserts the key (ON CONFLICT DO NOTHING; DROP TRIGGER IF EXISTS first). INSERT_SQL is INSERT … SELECT … WHERE NOT EXISTS (tombstone) ON CONFLICT DO NOTHING — covers syncLinkedTasks and ensureLinkedTask. Keys are kept for good.
F17 | teller/services/linked-tasks.js, apps/per-sistant/services/linked-tasks.js | billTasks → { desired, retain }: retain = unpaid occurrences from the bill's created_at month to the day before the 30-day window (payments read from the earliest creation month); computeLinkedTasks returns retain; runOnce passes it. syncLinkedTasks(…, retain): keys of listed kinds join the keep set of the close step only — never created, reopened or refreshed.
F18 | apps/per-sistant/services/linked-tasks.js, routes/analytics.js, routes/review.js, routes/ai.js, routes/settings.js | the close step no longer calls announceTodoEvent; analytics' completed-by-day / avg time / day-of-week / heatmap add NOT auto_closed, the completion rate and category breakdown leave auto-closed rows out of both sides; the review's completed list, Ask's todos_done and /api/stats done exclude them; Ask's sample line says "closed by Perfin".
F19 | apps/per-sistant/helpers.js | fireWebhooks replaces a todo_* event's data for a row with a source_key by linkedTaskWebhookData: { id, title: "<App> task: <kind label>", linked, source_app, kind, priority, due_date, completed } — the webhook body and the Slack line both read it.
F20 | apps/per-sistant/services/linked-tasks.js | syncLinkedTasks takes a client: BEGIN → SELECT pg_advisory_xact_lock(LINKED_TASKS_LOCK_KEY = 727274010) → inserts / reopen / refresh / close → COMMIT (ROLLBACK + rethrow on a failure), client released in finally; todo_created announced after COMMIT.
F22 | teller/routes/housing.js, teller/routes/subscriptions.js, teller/startup.js | linkedTasks.kick("housing-config") after the config PATCH's COMMIT; kick on manual-bill add / edit / delete; runHousingLedgerTick kicks "housing-generate" when generateHousingObligations returned generated > 0.
F23 | apps/per-sistant/routes/housing-due.js, routes/notifications.js, routes/ai.js | housingTaskOpen(pool) (an open, untrashed todo with source_key LIKE 'perfin:housing:%'; fail-soft false) and housingDueUnlessTask(perfinPool, pool, today) → null while one is open; the notification check and the briefing use it.
F21 | teller/services/linked-tasks.js, teller/startup.js | runLinkedTasks(…, { scheduled }) → { status: "fresh", ran: false } with no read when scheduled, nothing is running and the last clean run (status ok) was today (_freshDay); invalidate() and _reset() clear it; runLinkedTasksTick passes scheduled: true.
Tests | apps/per-sistant/tests/broad-scan-c8-batch5.test.js, tests/broad-scan-c8-batch5.test.js, tests/contract/c8-batch5.contract.test.js + four updated doubles / pins | 14 Per-sistant unit tests (tombstone skip + db/031 shape, retain keeps / never creates / unlisted kind ignored, a quiet close, the count queries, the reduced payload + Slack line, BEGIN → lock → COMMIT with announce after COMMIT, ROLLBACK + nothing announced, housingDueUnlessTask open / closed / fail-soft and both callers) + 10 Perfin unit tests (retain from the creation month with a paid occurrence left out, the runner passing retain, the once-a-day tick — fresh, next day, kick, invalidate, partial retried — and the kick pins) + 5 contract tests on both real databases (permanent delete and Empty Trash not recreated with the tombstone row, a sync blocked behind another lock holder, stats / analytics / review counting only the hand completion, housing_due hidden while the task is open and back after it is done, an aged unpaid bill open until paid and a switched-off bill's task closed by the route's own refresh). The shared fake models connect / BEGIN / lock / COMMIT and tombstones; x1a expects no announce on a close and counts UPDATEs; x2b's sync args carry retain; the health and batch6 pins follow the renamed call and the done filter. Mutation checks 10/10 red.

TEST RESULTS: passed — npm test 2650/2650; contract suite 269/269 (local Postgres 16, no pgvector); Playwright 72/72 (scratch config → preinstalled Chromium).
REGRESSION RISKS:
- F18: an automation, webhook or Slack integration that relied on todo_completed when Perfin closed a linked task no longer fires; analytics / stats totals drop by the auto-closed tasks.
- F19: an outside webhook consumer that read a linked task's title now gets the kind label.
- F20: a failing statement now rolls back the whole run (before, the creates and closes done so far stayed); a sync waits without a timeout while another holds the lock (only another sync takes it).
- F21: a change that reaches the sources without a kicking route (a direct database edit, a future write path that forgets to kick) waits until the next local day's tick; the memo is per process.
- F16: a task deleted for good can't come back — there is no "un-delete the key" path short of the database.
- F17: a manual bill paid by autopay and never marked paid keeps its tasks open indefinitely (they used to close as "completed" after 30 days); the retain list grows with such occurrences (bills is off by default).
- F23: any open housing task hides the housing_due line, even when the balance also includes an older period whose task you completed by hand.
INVARIANTS AT RISK: None violated. Touched: INV-77 (linked tasks stay an away channel but the hourly tick now acts once a local day after a clean run — its wording needs the change), INV-103 (its outside-party rule now covers Per-sistant's webhooks / Slack for linked tasks), INV-25 / INV-35 (housing-due still reads perfinPool read-only; the new lookup reads Per-sistant's own pool), INV-117 (no page writes changed), INV-81 (db/031 is a Per-sistant table; reset-fresh classifies Perfin's tables only).
NET SCORE: 0 − 2 = -2 (production fixes: none with evidence this month — linked tasks are off by default (linked_tasks_enabled) and shipped this cycle; manual bills are off by default even then. New failure modes: F20's whole-run rollback / unbounded lock wait, F21's day-long wait for a change that doesn't kick)

OPERATOR ACTIONS / DEPLOY:
- None (db/031 auto-migrates at boot)
Deploy: Settings, Notifications & Cross-app / Per-sistant Backend / Financial Analytics — Render auto-deploys on push to `main` (configured in the Render dashboard).

(Not complete in production until blocking operator actions are done AND
the deploy step is confirmed.)

FOLLOW-ON ITEMS:
- There is no UI to clear a linked-task tombstone (F16) — a task deleted for good by mistake stays gone while its item is open.
- The scan's G2 (quiet hours + per-type mute, one real-world item deduped across Perfin push, Per-sistant notifications and linked tasks) — F23 covers only housing_due and the briefing line; Perfin's own payment-due push still fires alongside the task.
- tests/roadmap-t2-4-x2a.test.js's intermittent node:test IPC failure (pre-existing; not seen this run).
DOCUMENTATION UPDATES NEEDED:
- CLAUDE.md teller/services/linked-tasks.js entry (retain, the once-a-day scheduled run), the Per-sistant Tasks feature note, the Linked tasks scheduled-task bullet and INV-77 (F17 / F21 / F22).
- CLAUDE.md + apps/per-sistant/CLAUDE.md: the "a trashed task's key frees up only at the 30-day purge" claims → tombstones (F16); db/031; the services/linked-tasks.js entry (retain, lock, quiet close); analytics / review / Ask / stats excluding auto-closed tasks (F18); the webhooks note and INV-103 (F19); housing_due / briefing stepping aside (F23).
- Test counts (2626 → 2650 tests, 137 → 139 files; Per-sistant 683 → 697; contract 264 → 269), the new test files, and the cycle-8 Known Open Issues section (Batch 5 done + follow-ons).
---END BROAD SCAN IMPLEMENTATION SUMMARY---
