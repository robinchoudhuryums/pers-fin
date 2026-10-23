# Roadmap T2.4 — Cross-app automation (plan, 2026-10-23)

Goal: things Perfin already knows you have to act on become Per-sistant tasks, and
they close themselves when Perfin sees them done. Cases: a cancelled subscription
that charged again, rent and utilities due, a utility bill whose amount you haven't
entered, and (opt-in) a manual bill coming due. Recording the rent payment closes its
task. Plus one search that covers both apps. Roadmap estimate: M–L, about 2 weeks.
Everything is off by default, and only works under the unified shell, where both
databases are wired.

## What exists (read for this plan)
- **Perfin's sources, which today end in a push notification only:**
  - `runSubscriptionWatchdog` (routes/subscriptions.js) — "<name> charged $X after you
    cancelled it": once per post-cancel charge (`still_charging_txn`), marked only
    after `sendToAll` logged it (INV-123).
  - `runHousingReminders` (routes/housing.js, the 6-hourly away job) — "Rent/utilities
    due to <payee>": while the payee's unpaid balance is inside the lead window, deduped
    `sentRecently(…, 72)`. Also "Enter <label> amount" for a `pending_amount` utility
    whose bill should have arrived.
  - Manual bills (`manual_bills`, placed by `cadence.manualBillOccurrences`) with
    `bill_payments` marking an occurrence paid. They have no reminder at all today.
- **Writes that resolve those sources:**
  - Housing: `POST` / `DELETE /api/housing/payments`, `PATCH` / `DELETE
    /api/housing/obligations/:id`, `POST /api/housing/generate`.
  - Bills: `POST` / `DELETE /api/bill-payments`.
- **Cross-app precedents:**
  - Perfin writes Per-sistant's `emails` table under the shell
    (`deliverDigestInProcess`).
  - Per-sistant reads Perfin read-only (`housingDue`, the Knowledge finance snapshot,
    `perfinAiSpend`).
  - Each app lazily requires the other's module only when the other's pool is wired:
    `getNetWorth`, `persistentAiSpend`.
  - Never an HTTP self-fetch (INV-25 / INV-35).
- **Per-sistant todos:**
  - `POST /api/todos` inserts the row, then `announceTodoEvent` (helpers.js) runs
    automations and webhooks.
  - `GET /api/todos` selects `t.*`, so new columns reach the pages.
  - `finance` is a preset category.
  - The trash soft-deletes (`deleted_at`) and purges after 30 days.
- **Search:**
  - Per-sistant's `GET /api/search` covers todos, emails, notes and contacts. It's used
    only by the dashboard's search widget (the "/" shortcut), which can be hidden.
  - Perfin has the Activity page's transaction search and no global search.

## Decisions (accepted with /broad-implement X1a)
1. **Perfin decides, Per-sistant stores.**
   - Perfin computes which tasks should exist, since it owns the facts.
   - Writes go through ONE Per-sistant module, `apps/per-sistant/services/
     linked-tasks.js`. Perfin requires it lazily, only when `persistentPool` is wired —
     the same posture as `persistentAiSpend`.
   - So a linked task is created like any other: the same row shape, plus Per-sistant's
     automations and webhooks through `announceTodoEvent`.
   - Standalone Perfin does nothing, and its Settings section says so.
2. **Reconcile to a desired set; the still-charging task is the one event.**
   - Each run computes the set of tasks that should be open, keyed by `source_key`:
     `perfin:housing:<period>`, `perfin:utility-amount:<obligation id>`,
     `perfin:bill:<manual bill id>:<date>`.
   - The sync creates missing tasks, closes open ones whose key left the set, and
     reopens auto-closed ones whose key came back. Re-running changes nothing.
   - Only sources whose query succeeded this run can close anything. A failed query
     never reads as "resolved".
   - Switching the feature or a source off leaves existing tasks as they are.
   - The still-charging case has no resolved state to reconcile against. Its task
     (`perfin:still-charging:<sub id>:<txn>`) is created once, inside the watchdog,
     next to the notification it already sends, and is never auto-closed.
3. **Who wins.**
   - Your completion is final: a task you completed is never reopened.
   - An auto-closed task reopens if its source comes back (an undone payment).
   - A deleted task isn't recreated while its row exists: the unique `source_key`
     index covers trashed rows. After the 30-day purge, a still-open item can come back.
   - Your edits win. Title, description, due date and priority are refreshed only while
     they still equal what the sync last wrote (`source_snapshot`).
4. **No reverse writes.** Completing a linked task never records a payment or changes
   Perfin. The task links to the Perfin page that resolves it (`source_url`).
5. **Sources and defaults.**
   - Master switch `linked_tasks_enabled` is off by default.
   - Per source (`linked_tasks_sources`), with these defaults:
     - still-charging: on.
     - housing due: on. One task per unpaid period inside the reminder lead window or
       overdue — the same window `runHousingReminders` uses.
     - utility amount: on. A `pending_amount` row whose bill should have arrived.
     - manual bills: OFF. An occurrence inside `linked_tasks_bill_lead_days` (default
       3, 0–14) with no `bill_payments` row, kept open up to 30 days overdue. Off
       because an autopaid bill nobody marks paid would leave a task open.
6. **Task shape.**
   - Category `finance`.
   - Priority:
     - still-charging: high.
     - housing: high, or urgent once overdue.
     - utility amount: medium.
     - bill: medium, or high once overdue.
   - Due date: the item's own due date; for a utility amount, today.
   - Short horizon.
   - The task card shows a "Perfin" chip linking to `/perfin/<page>`.
7. **The unified search lives in Per-sistant.**
   - `GET /api/search` adds a `finance` group under the shell, read-only through
     `perfinPool`:
     - transactions by display merchant / notes / category: the 10 newest, the user's
       share;
     - active subscriptions;
     - manual bills;
     - goals;
     - account names.
   - Each result links to the Perfin page that shows it; a transaction opens Activity
     with `?q=`.
   - A small `/search` page in Per-sistant uses the same renderer as the dashboard
     widget (moved into views/js.js), and accepts `?q=`.
   - Perfin's nav gets a search link to it. Per-sistant's nav gets one too, so search no
     longer depends on the dashboard widget being shown.
   - No model call. LIKE metacharacters are escaped (F124). Secret-note rules are
     unchanged.

## Batches (broad-implement sized)

| # | Batch | Status |
|---|---|---|
| X1a | **Per-sistant: schema + sync core.**<br>• `db/030_linked_tasks.sql`: `todos.source_app`, `source_key` (UNIQUE partial index WHERE NOT NULL — covers trashed rows), `source_url`, `source_snapshot JSONB`, `auto_closed BOOLEAN NOT NULL DEFAULT false`. Idempotent (run twice by the migration test).<br>• `services/linked-tasks.js`:<br>&nbsp;&nbsp;– `syncLinkedTasks(pool, { app, kinds, desired })` creates missing tasks (`INSERT … ON CONFLICT (source_key) DO NOTHING RETURNING`, then `announceTodoEvent('todo_created')`), closes open tasks of the listed kinds whose key left `desired` (completed, `completed_at`, `auto_closed`), and reopens auto-closed ones whose key came back. Returns `{ created, closed, reopened }`.<br>&nbsp;&nbsp;– `ensureLinkedTask(pool, task)` for a one-off event (the still-charging case): create once, never close.<br>&nbsp;&nbsp;– Input checked: a key must start with `<app>:` and its kind must be in `kinds`; title / description / url bounded; priority from the enum.<br>• Completing a task by hand (PATCH, bulk complete) clears `auto_closed`, so it is never reopened.<br>• No UI yet; nothing calls the module yet.<br>• Tests: the sync over a fake pool (create once, a re-run changes nothing, close, reopen only auto-closed, hand completion final, a trashed row not recreated, only listed kinds closed, a bad key refused). Contract on real Postgres: the migration, the unique key across a trashed row, an automation firing on a linked create, close → reopen. | DONE (2026-10-23 — hand completion via a trigger-set `source_detached` instead of clearing auto_closed per route; block `7-roadmap-t2-4-x1a`) |
| X1b | **Per-sistant: edits win + the task UI.**<br>• `source_snapshot` holds what the sync last wrote. The sync refreshes title, description, due date and priority of an OPEN task only where the current value still equals the snapshot (decision 3), then updates the snapshot. Returns `updated`. A hand edit stays, and the fields you didn't touch keep refreshing.<br>• UI: a "Perfin" chip linking `source_url` (through the mount base, so `/perfin/…` under the shell) on the To-Dos list, the dashboard task cards and the edit modal, with an aria-label. Template-literal rules: no single-escaped regexes (INV-97); chip markup through `esc` / `escAttr`.<br>• Playwright: `e2e/seed.js` inserts one linked task directly (as it does the Job Radar listing — no route creates one), and the To-Dos page and its click sweep show the chip.<br>• Docs for X1 (both CLAUDE.md files' test counts and the todos columns; Per-sistant CLAUDE.md "Linked tasks" paragraph).<br>• Tests: per-field refresh (edited title kept, untouched due date refreshed, snapshot advanced), the chip rendered in a vm from the emitted page script with an escaped title and a `javascript:` url refused, the emitted bundles parse. Contract: an edited task keeps its title across two syncs. | DONE (2026-10-23 — source_url is a path inside the source app, joined with its mount by the chip via window.LINKED_APP_BASES; block `7-roadmap-t2-4-x1b`) |
| X2a | **Perfin: settings + the computation.**<br>• `user_settings`: `linked_tasks_enabled` (strict boolean), `linked_tasks_sources` JSONB (`sanitizeBoolMap`, the decision-5 defaults), `linked_tasks_bill_lead_days` (integer 0–14, default 3), `linked_tasks_state` JSONB (written in X2b). INV-59 400s on PATCH; GET defaults; reset-fresh classification (INV-81 — user_settings is reset).<br>• `services/linked-tasks.js` `computeLinkedTasks(pool, cfg, today)` → `{ ok_kinds, desired, errors }`, each source in its own try/catch:<br>&nbsp;&nbsp;– housing: one task per unpaid period, payee-scoped, inside the reminder lead window or overdue (the same rule as `runHousingReminders` — shared, not copied), with the period's amount and due date;<br>&nbsp;&nbsp;– utility amount: a `pending_amount` row whose bill should have arrived;<br>&nbsp;&nbsp;– manual bills: occurrences from `manualBillOccurrences` in [today − 30, today + lead] with no `bill_payments` row.<br>&nbsp;&nbsp;Task shape per decision 6; `source_url` a Perfin path; today = `todayStr()` (APP_TIMEZONE).<br>• Pure computation — nothing is written to Per-sistant yet.<br>• Tests: canned rows (lead window edge, overdue period, a paid period absent, a removed utility absent, an entered amount absent, a bill paid absent, a 31st bill in a 30-day month, a failing source excluded from `ok_kinds` while the others stay), a forced zone west of UTC, the PATCH 400s, reset-fresh lists. Contract: `computeLinkedTasks` on real rows. | DONE (2026-10-23 — a utility-amount task is due on its bill's date, not today; switched-off sources are skipped inside computeLinkedTasks; the reminder now shares periodDueDate / rentReminderOpen / utilityAmountDue; block `7-roadmap-t2-4-x2a`) |
| X2b | **Perfin: the runner, the job and the hooks.**<br>• `runLinkedTasks(pool, persistentPool, { today })`: single-flight; no-op without `persistentPool` or with the switch off; computes, keeps only enabled sources, calls Per-sistant's `syncLinkedTasks` (lazy require, only when the pool is wired); writes `linked_tasks_state` (`at`, counts, per-source error — fixed text).<br>• Away job `linked-tasks` in startup.js: hourly, NOT activity-gated (INV-77), `JOB_INTERVALS_MS`, `jobHealth` tick + result, settings read once a local day while off (`invalidate()` from the settings PATCH).<br>• Immediate refresh, fire-and-forget, after `POST` / `DELETE /api/housing/payments`, `PATCH` / `DELETE /api/housing/obligations/:id`, `POST /api/housing/obligations`, `POST /api/housing/generate`, `POST` / `DELETE /api/bill-payments` — a failure logged, never failing the route.<br>• Still-charging: `ensureLinkedTask` in `runSubscriptionWatchdog` after `sent.logged`, when the switch and the source are on; a failure never un-marks the alert.<br>• Tests: gating (off, no pool, a source off), single-flight, the state record, the job's outcome, each hook calling the refresher and a throwing refresher leaving the route's 200, the watchdog hook. Contract with both real databases (as `ai-usage-c4`): rent due → one task; a payment → closed; undo → reopened; a hand-completed task stays done after undo; a utility amount entered → closed; a bill marked paid → closed; a still-charging alert → one task across two watchdog runs; switched off → nothing written. | DONE (2026-10-23 — a call during a run makes it go round once more; block `7-roadmap-t2-4-x2b`) |
| X2c | **Perfin: the Settings section + X2 docs.**<br>• Settings → Notifications "Per-sistant tasks": the switch, a box per source (bills marked "off by default — autopaid bills nobody marks paid stay open"), lead days, a "Last run …: N open, N closed" line from `linked_tasks_state` with any source error, and a "Run now" button (`POST /api/linked-tasks/run`, x-api-key / session, 409 while running). Standalone (`GET /api/settings` `embedded` false): the section says "Available under the unified shell" and its controls are hidden.<br>• Labels and `writeOk` per the Perfin UI rules (IF-3, INV-89).<br>• Playwright: the Perfin Settings page and its sweep (the Run now button is not destructive — swept).<br>• Docs: CLAUDE.md Features / Database / Scheduled Tasks / Commands entries for X2, the README line.<br>• Tests: the section's save run in a vm (each field sent, a 400 shown), the standalone note, the run route (gating, 409, the result shape). | DONE (2026-10-23 — the line says "outstanding"; block `7-roadmap-t2-4-x2c`) |
| X3a | **Unified search: the finance results.**<br>• `GET /api/search` adds a `finance` group under the shell, read-only through `perfinPool`, each query fail-soft (a Perfin error leaves the Per-sistant results and logs once): transactions by display merchant / user notes / category — the 10 newest, the user's share (`SPLIT_AMOUNT`), reimbursed shown as such; active subscriptions; manual bills; goals; account names. LIKE metacharacters escaped (F124 / INV-10); `q` ≥ 2 and ≤ 200 characters.<br>• Each result carries `type` (`transaction` / `subscription` / `bill` / `goal` / `account`), a label, a short detail (amount, date) and a `url` — the Perfin page that shows it (a transaction: Activity with `?q=` and its month).<br>• Standalone: no `finance` group, no Perfin query.<br>• The dashboard widget renders the new types (links into Perfin, no inline actions).<br>• Tests: each query's SQL (escaped pattern, share, cap), the url per type, fail-soft, standalone. Contract with both databases: a seeded transaction, subscription and goal found through Per-sistant's search; a `%` query matched literally. | PLANNED |
| X3b | **Unified search: the page, the links + T2.4 close-out.**<br>• The result renderer moves into views/js.js (`renderSearchResults`), shared by the dashboard widget and a new `/search` page (`?q=`, focus on load, the "/" shortcut). The Perfin nav and the Per-sistant nav get a labelled search link to `/per-sistant/search` (Perfin's only under the shell).<br>• INV-144; both CLAUDE.md files; README; Known Open Issues: T2.4 DONE with its follow-ons; STATE.<br>• Playwright: `/per-sistant/search` in `pages.spec` (loads clean, a seeded transaction found) and its sweep; the Perfin nav link.<br>• Tests: the renderer run in a vm (each type, escaping, a `javascript:` url refused), the page's `?q=` prefill, the nav links (base-aware — INV-95's root-relative guard). | PLANNED |

Seven batches, each one /broad-implement session: X1a → X1b → X2a → X2b → X2c → X3a →
X3b (each depends on the one before, except X3a, which needs only X1b). Each runs npm
test, the contract suite, the migration test when its schema changes (X1a, X2a),
Playwright when a page changes (X1b, X2c, X3a, X3b) and mutation checks, and folds in
the docs for what it adds.

## New invariant (X3b)
INV-144 | Perfin turns finance items into Per-sistant tasks only through Per-sistant's
linked-tasks module over the wired `persistentPool` (never an HTTP self-fetch, never
standalone):
- one task per `source_key`, unique across trashed rows;
- re-running the sync changes nothing;
- only sources whose query succeeded may close tasks;
- a task the user completed is never reopened, and only auto-closed tasks reopen;
- user edits are never overwritten;
- completing a task never writes to Perfin;
- the unified search reads Perfin read-only, without a model call.

Subsystem: Settings, Notifications & Cross-app / Per-sistant Backend. Verify: the X1a–X3b
test files + contract `linked-tasks` + `crossapp-search`.

## Trade-offs to state in the docs
- A task follows its source within the hour. A payment, utility amount or bill payment
  recorded in the app updates it at once; a change that arrives by bank sync waits for
  the next run.
- A deleted task can return after the 30-day trash purge if its item is still open.
- Manual-bill tasks are off by default: an autopaid bill nobody marks paid would keep a
  task open.
- The amount in a task's title is refreshed only while you haven't edited it.
- Search queries Perfin's database on each debounced keystroke (300 ms), with at most
  10 rows per group.

## Out of scope
- Reverse writes (completing a task records a payment).
- Tasks from other Perfin alerts: budget, anomaly, low cash, payday, price rise.
- A standalone (HTTP) variant.
- Search inside Perfin's own nav, with inline results.
- AI in search.
- Per-sistant items becoming Perfin entries.
