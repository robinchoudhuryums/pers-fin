---BROAD SCAN IMPLEMENTATION SUMMARY---
Findings implemented: None (roadmap work, not scan findings)
New capabilities (G/ST): Roadmap T2.4 X2a — Perfin's side of linked tasks: the linked_tasks_* settings and computeLinkedTasks, the pure computation of which Per-sistant tasks should be open (rent & utilities due, utility amounts to enter, manual bills). Nothing is written to Per-sistant yet (X2b).
Files modified:
  teller/services/linked-tasks.js (new), teller/services/database.js (four user_settings columns),
  teller/routes/settings.js (GET defaults, PATCH validation), teller/routes/housing.js (periodDueDate /
  rentReminderOpen / utilityAmountDue shared with runHousingReminders; getConfig exported),
  tests/roadmap-t2-4-x2a.test.js (new), tests/contract/linked-tasks-perfin.contract.test.js (new),
  CLAUDE.md, README.md, .cycle/plan-t2-4-crossapp-automation.md, .cycle/STATE.md

CHANGES:
T2.4-X2a | teller/services/database.js | user_settings.linked_tasks_enabled BOOLEAN NOT NULL DEFAULT false, linked_tasks_sources JSONB NOT NULL DEFAULT {still_charging, housing, utility_amount: true; bills: false} (decision 5), linked_tasks_bill_lead_days INT NOT NULL DEFAULT 3, linked_tasks_state JSONB (written by the X2b runner). Idempotent ADD COLUMN IF NOT EXISTS; reset-fresh resets user_settings to a default row, so they return to their defaults
T2.4-X2a | teller/routes/settings.js | GET returns the four with defaults; PATCH (INV-59): linked_tasks_enabled a strict boolean, linked_tasks_sources an object of the known sources → strict booleans (anything else a 400), merged over the stored map (`||`), linked_tasks_bill_lead_days an integer 0–14
T2.4-X2a | teller/services/linked-tasks.js | computeLinkedTasks(pool, { sources, bill_lead_days }, today = todayStr()) → { ok_kinds, desired, errors }. Housing: one task per unpaid period of the configured payee with known amounts inside the payment-due window or overdue (rentReminderOpen), next month's rent before its row exists unless removed (nextRentInLeadWindow + the skip), "Pay <payee> for <Mon YYYY>", "$X owed: Rent $…, Gas $…", due on the period's rent due date, high / urgent once overdue, /housing. Utility amount: a pending_amount row whose bill should have arrived (utilityAmountDue), "Enter the <label> amount for <Mon YYYY>", medium, /housing#pending. Manual bills: manualBillOccurrences in [today − 30, today + lead] without a bill_payments row (bill_source 'manual', that date), "Pay <name>", medium / high once overdue, /calendar. Each source in its own try/catch (a fixed error, left out of ok_kinds); a source switched off isn't read; a ledger that isn't set up reads as nothing due
T2.4-X2a | teller/routes/housing.js | the payment-due and missing-amount reminders now read their windows through the shared pure helpers (periodDueDate, rentReminderOpen — date-based, so rent due the 31st opens lead days before the clamped Feb 28 rather than never inside February's window; utilityAmountDue); nextRentInLeadWindow uses periodDueDate. Otherwise identical (pinned by the existing housing tests, all green)
T2.4-X2a | (plan refinements) | the utility-amount task is due on the date its bill was due, not "today" (a due date that moved every day could never show as overdue); computeLinkedTasks skips switched-off sources itself (the plan had the X2b runner filter them) so a disabled source costs no query

TEST RESULTS: passed — npm test 2187/2187 (Perfin 1553 + Per-sistant 634; 16 new); contract suite 220/220 (3 new: computeLinkedTasks on real rows — the payee's unpaid periods with known amounts, a paid period / another payee / a pending amount left out, an overdue period urgent, a utility amount until PATCH enters it, next month's rent until DELETE records its skip, a 31st manual bill on the 30th until POST /api/bill-payments marks it paid and a subscription payment with the same id not counting; the settings defaults, the sources merge and a 400 that writes nothing); migration test (scripts/ci-migration-test.js, both apps twice) passed. Playwright not run — no page changed. Mutation checks, each turning a test red: no window filter, never urgent, the utility due-day off by one, paid bills kept, any bill_source counting as paid, the payee scope dropped, the skip ignored, a failed source counted in ok_kinds, a UTC "today", the window edge `<`, a switched-off source read, the sources map replaced instead of merged, a non-boolean source accepted, the utility source dropped.
REGRESSION RISKS:
  - runHousingReminders' payment-due window is now date-based: identical except when the rent due day is past the month's last day (due the 31st: Feb's window opens on the 25th with lead 3, where before it opened on the 28th only if 31 − lead ≤ 28).
  - GET /api/settings returns four more fields; nothing reads them yet.
INVARIANTS AT RISK: None — INV-59 extended (the three settings 400); INV-72 (single-payee ledger) — the computation is payee-scoped and honors the removal skip; INV-70 (one manual-bill placement rule) — manualBillOccurrences reused, not re-derived; INV-121 (timezone lint, canonical helpers) — today from todayStr(), the scan green; INV-106 — no bare catch added. INV-144 is written in X3b.
NET SCORE: 0 production fixes − 0 new failure modes = 0 (one new capability, not yet wired)

OPERATOR ACTIONS / DEPLOY:
- None (the columns auto-migrate; the feature stays off until X2c's Settings switch) | BLOCKS DEPLOY: N
Deploy: Platform, Shell & Auth: Render auto-deploys on push to `main` (after the PR merges).

(Not complete in production until blocking operator actions are done AND
the deploy step is confirmed.)

FOLLOW-ON ITEMS:
- A ledger switched off (housing_config.enabled false) reads as "nothing due", so once X2b runs, its open rent / utility tasks close as resolved.
- A rent task groups the period's utilities under the RENT due date (the ledger is paid as one transfer); a utility due later in the month is in the total early.
- manualBillOccurrences projects a series backwards from its creation month, so a bill created recently can produce a task for an occurrence (up to 30 days back) before it existed — the calendar shows the same occurrence.

DOCUMENTATION UPDATES NEEDED:
- None (folded into this batch)
---END BROAD SCAN IMPLEMENTATION SUMMARY---
