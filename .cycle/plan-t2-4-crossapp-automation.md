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

## Decisions (accepted with /broad-implement X1)
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
| X1 | **Per-sistant: the linked-task store.**<br>• `db/030_linked_tasks.sql`: `todos.source_app`, `source_key` (UNIQUE partial index WHERE NOT NULL — covers trashed rows), `source_url`, `source_snapshot JSONB`, `auto_closed BOOLEAN NOT NULL DEFAULT false`. Idempotent.<br>• `services/linked-tasks.js` `syncLinkedTasks(pool, { app, kinds, desired, today })`:<br>&nbsp;&nbsp;– create missing tasks (`INSERT … ON CONFLICT (source_key) DO NOTHING RETURNING`, then `announceTodoEvent('todo_created')`);<br>&nbsp;&nbsp;– refresh unedited fields of open tasks (decision 3);<br>&nbsp;&nbsp;– close open tasks of the given kinds whose key left `desired` (completed, `completed_at`, `auto_closed`);<br>&nbsp;&nbsp;– reopen auto-closed ones that came back;<br>&nbsp;&nbsp;– returns `{ created, updated, closed, reopened }`.<br>&nbsp;&nbsp;`ensureLinkedTask(pool, task)` handles the one-off still-charging event.<br>• Completing a task by hand clears `auto_closed`; a manual edit isn't overwritten.<br>• UI: a "Perfin" chip linking `source_url` on the To-Dos list, the dashboard task cards and the edit modal.<br>• Tests: the sync over a fake pool (create once, re-run no-op, close, reopen only auto-closed, user completion final, a trashed row not recreated, an edited title kept, only listed kinds closed). Contract on real Postgres: the migration, the unique key, automations firing on a linked create. | PLANNED |
| X2 | **Perfin: the sources, the job and Settings.**<br>• Settings `linked_tasks_enabled` (strict boolean), `linked_tasks_sources` (`sanitizeBoolMap`), `linked_tasks_bill_lead_days` (integer 0–14) — INV-59 400s — plus `linked_tasks_state` JSONB (last run: when, counts, per-source error). reset-fresh classification (INV-81).<br>• `services/linked-tasks.js`: `computeLinkedTasks(pool, cfg, today)`, each source isolated, returning `{ ok_kinds, desired }`; housing per period from `payee_obligations` (payee-scoped, lead window as `runHousingReminders`); utility amount; manual bills via `manualBillOccurrences` minus `bill_payments`. `runLinkedTasks(pool, persistentPool)` is single-flight, a no-op without `persistentPool` or with the switch off, and calls Per-sistant's `syncLinkedTasks` (lazy require).<br>• An hourly away job `linked-tasks` in startup.js: NOT activity-gated, `JOB_INTERVALS_MS`, `jobHealth` tick + result, settings read once a local day while off.<br>• Immediate refresh (fire-and-forget, single-flight) after the housing payment / obligation / generate writes and the bill-payment writes.<br>• Still-charging: `ensureLinkedTask` in `runSubscriptionWatchdog` after `sent.logged`.<br>• Settings → Notifications "Per-sistant tasks": the switch, per-source boxes, lead days, the last run line; "Available under the unified shell" when standalone.<br>• Tests: compute over canned rows (lead window, overdue, a paid period absent, a removed utility absent, a bill paid absent, a failed source excluded from `ok_kinds`), the job's gating / outcome, the hooks, the PATCH 400s. Contract with both real databases (as `ai-usage-c4`): rent due → one task; a payment → closed; undo → reopened; a hand-completed task stays done; a utility amount entered → closed; a bill marked paid → closed; switched off → nothing written; no `persistentPool` → no-op. | PLANNED |
| X3 | **Unified search + docs.**<br>• `GET /api/search` adds `finance` results under the shell (decision 7). Each query is fail-soft, so a Perfin error leaves the Per-sistant results.<br>• The renderer is moved into views/js.js and shared by the dashboard widget and the new `/search` page (`?q=`, the "/" shortcut). Perfin nav and Per-sistant nav get a search link.<br>• New invariant; both CLAUDE.md files; README; Known Open Issues.<br>• Playwright: the `/search` page in `pages.spec` and its sweep; a seeded linked task's chip.<br>• Tests: the finance queries (escaped LIKE, user share, the 10-row cap, the links), the renderer in a vm, fail-soft. Contract: a seeded transaction found through Per-sistant's search on real Postgres. | PLANNED |

Each batch runs npm test, the contract suite, the migration test (X1 and X2 change
schemas), Playwright (X1–X3 change pages) and mutation checks.

## New invariant (X3)
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

Subsystem: Settings, Notifications & Cross-app / Per-sistant Backend. Verify: the X1–X3
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
