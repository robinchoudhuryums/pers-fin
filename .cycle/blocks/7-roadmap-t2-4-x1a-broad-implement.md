---BROAD SCAN IMPLEMENTATION SUMMARY---
Findings implemented: None (roadmap work, not scan findings)
New capabilities (G/ST): Roadmap T2.4 X1a — the linked-task store in Per-sistant: db/030 (source columns, a unique source_key covering trashed rows, a detach trigger) and services/linked-tasks.js (syncLinkedTasks / ensureLinkedTask). Decisions 1–8 of the T2.4 plan accepted. Nothing calls the module yet (Perfin wires it in X2).
Files modified:
  apps/per-sistant/db/030_linked_tasks.sql (new), apps/per-sistant/services/linked-tasks.js (new),
  apps/per-sistant/tests/roadmap-t2-4-x1a.test.js (new), tests/contract/linked-tasks.contract.test.js (new),
  CLAUDE.md, apps/per-sistant/CLAUDE.md, README.md, .cycle/plan-t2-4-crossapp-automation.md, .cycle/STATE.md

CHANGES:
T2.4-X1a | apps/per-sistant/db/030_linked_tasks.sql | todos.source_app, source_key, source_url, source_snapshot JSONB, auto_closed BOOLEAN NOT NULL DEFAULT false, source_detached BOOLEAN NOT NULL DEFAULT false; UNIQUE index uq_todos_source_key ON todos (source_key) WHERE source_key IS NOT NULL (no deleted_at filter — a trashed linked task keeps its key, so it isn't recreated until the 30-day purge); trigger trg_todos_detach_linked (BEFORE UPDATE OF completed) sets source_detached when a linked task's completed changes WITHOUT auto_closed changing in the same UPDATE. Every statement re-runnable (DROP TRIGGER IF EXISTS before CREATE TRIGGER)
T2.4-X1a | apps/per-sistant/services/linked-tasks.js | syncLinkedTasks(pool, { app, kinds, desired }) → { created, closed, reopened, skipped }: INSERT … ON CONFLICT (source_key) DO NOTHING RETURNING (category finance, short horizon, the snapshot of title / description / due_date / priority) + announceTodoEvent('todo_created'); reopens auto_closed tasks whose key came back; closes open tasks of the LISTED kinds whose key left the set (auto_closed, completed_at, announced todo_completed); never a detached or trashed task; no listed kind → no UPDATE at all. ensureLinkedTask(pool, { app, task }) → { created, id } creates a one-off event task once. Input checked: app /^[a-z][a-z0-9-]{0,30}$/, key '<app>:<kind>:<id>' with the kind in kinds, title ≤300, description ≤2000, url a same-app path (no //, scheme or backslash, ≤500), due_date a real YYYY-MM-DD, priority from VALID_PRIORITIES (default medium); a bad item is skipped and logged, but its well-formed key still counts as desired so a bad field never reads as "resolved"
T2.4-X1a | (plan refinement) | The plan said "completing by hand (PATCH, bulk complete) clears auto_closed". Implemented instead as the source_detached column set by a DB trigger: it covers EVERY completion path (PATCH, bulk, recurring paths, any future route) without each route knowing, and it also respects a hand REOPEN after an auto-close (the sync never re-closes it). One column more than the plan's five
T2.4-X1a | CLAUDE.md / apps/per-sistant/CLAUDE.md / README.md | counts, test descriptions, db/030 + services/linked-tasks.js key-file entries, services/linked-tasks.js in the Per-sistant Backend subsystem, Known Open Issues: T2.4 in progress + the X1a follow-ons

TEST RESULTS: passed — npm test 2163/2163 (Perfin 1537 + Per-sistant 626; 16 new); contract suite 216/216 (10 new: db/030 re-run with its columns / index / trigger; a linked create running a todo_created automation; close → reopen with source_detached untouched; PATCH and bulk completion detaching and never reopened; an auto-closed task reopened then completed by hand staying completed; a hand reopen never re-closed; a trashed task — open or auto-closed — not reopened or recreated; only listed kinds closed; ensureLinkedTask once; an ordinary task untouched); migration test (scripts/ci-migration-test.js, both apps twice on a fresh database) passed. Playwright not run — no page changed. Mutation checks, each turning a test red: reopen ignoring source_detached (first survived the unit + contract tests — added the reopen-then-complete-by-hand contract case), close ignoring source_detached, close ignoring kinds, an invalid item's key not kept desired, a // url accepted, an UPDATE sent with no kinds, reopen reaching a trashed row (first survived — added the trashed auto-closed case), the trigger detaching the sync's own changes, the trigger never firing, the unique index skipping trashed rows, no todo_created announce. The fake pool models the statements' intent, so the SQL predicates are pinned on real Postgres (the first three mutations survive the unit file alone by design).
REGRESSION RISKS:
  - db/030 adds a BEFORE UPDATE trigger on todos; it fires only when the UPDATE sets completed, and its WHEN clause skips every row with no source_key — ordinary tasks are unaffected (contract-checked).
  - GET /api/todos (SELECT t.*) now returns the six new columns; no client reads them yet.
INVARIANTS AT RISK: None — INV-119 (every todo create / complete announces) holds for the sync's creates and closes (announceTodoEvent); INV-93 (automations validated and isolated) unchanged — a linked create runs them like any other; INV-17 (migrations in one transaction, fatal on failure) — db/030 idempotent, run twice; INV-106 (no new bare catch) — none added; INV-10 (no LIKE '%kw%') — none. INV-144 is written in X3b.
NET SCORE: 0 production fixes − 0 new failure modes = 0 (one new capability, not yet wired)

OPERATOR ACTIONS / DEPLOY:
- None (db/030 auto-migrates at boot) | BLOCKS DEPLOY: N
Deploy: Platform, Shell & Auth: Render auto-deploys on push to `main` (after the PR merges).

(Not complete in production until blocking operator actions are done AND
the deploy step is confirmed.)

FOLLOW-ON ITEMS:
- A task reopened by hand after an auto-close is detached for good — the sync never closes it again, even once the item is resolved (by design: your action wins).
- A trashed linked task's key frees up only at the 30-day purge, after which a still-open item comes back as a new task (decision 3).
- X1b: the snapshot refresh (edits win), the "Perfin" chip, the e2e seed.

DOCUMENTATION UPDATES NEEDED:
- None (folded into this batch)
---END BROAD SCAN IMPLEMENTATION SUMMARY---
