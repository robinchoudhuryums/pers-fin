---BROAD SCAN IMPLEMENTATION SUMMARY---
Findings implemented: None (E1a is expansion work)
New capabilities (G/ST): G1 (server half, cycle-8 E1a) — the user can correct how the cash-flow forecast treats a recurring transfer (automatic / always a bill / between my accounts / leave out) or leave a subscription out of it; the forecast reports what it billed and what it left out, with a reason.
Files modified: teller/services/database.js, teller/services/cash-flow.js, teller/routes/subscriptions.js, tests/roadmap-t2-2-cash-l1.test.js, tests/cycle8-e1a.test.js (new), tests/contract/forecast-e1a.contract.test.js (new)

CHANGES:
G1 | teller/services/database.js | CHECK_LISTS.recurring_transfers.forecast_treatment = auto / bill / internal / ignore; `recurring_transfers.forecast_treatment TEXT NOT NULL DEFAULT 'auto'` with its CHECK interpolated from CHECK_LISTS (constraint recurring_transfers_forecast_treatment_check, kept in step by syncInListChecks — cycle-8 F31 policy); `detected_subscriptions.forecast_ignore BOOLEAN NOT NULL DEFAULT false`. Both added before the CHECK sync.
G1 | teller/services/cash-flow.js | transferTreatment(tr): the user's treatment wins (bill → billed, why "user"; internal / ignore → left out, user_internal / user_ignored), else the existing isCardAutopay → card_autopay, isInternalMove → internal, else billed. classifyBills(subs, transfers) → { bills, left_out }, each row tagged source / id / treatment and why or reason; a subscription with forecast_ignore is left out (user_ignored). getCashFlowInputs selects the ids + the two columns and returns `left_out` beside `bills`. projectCashFlow (still pure, bills only `bills`) adds `forecast_items` { bills: [{ source, id, name, amount, cadence_days, treatment, transfer_type?, why, next_date, occurrences, projected_total }], left_out: [{ …, reason }] }; GET /api/cash-flow carries it (the route spreads the forecast). Exports transferTreatment + classifyBills.
G1 | teller/routes/subscriptions.js | PATCH /api/recurring-transfers/:id/forecast { treatment } (one of the CHECK's own list, read at request time) and PATCH /api/subscriptions/:id/forecast { ignore } (strict boolean): a malformed id (not 1..int4) or value is a 400 before any query, unknown id a 404, else the column is written, the row's id / name / setting returned and cash-alerts.invalidate() called (fail-soft, logged) so the next hourly check re-evaluates.
G1 | tests/roadmap-t2-2-cash-l1.test.js | the response-keys pin gains forecast_items.
G1 | tests/cycle8-e1a.test.js | 17 tests: the treatment matrix over the autopay / internal / plain shapes, classifyBills' tags, getCashFlowInputs' SQL + bills / left_out over a fake pool, totals moving with the settings, canned inputs without the new fields, GET /api/cash-flow's forecast_items, both routes' 400s (before any query), writes, 404s, invalidate (and a throwing invalidate leaving the 200), every CHECK value accepted, the migration pins, no detector / rename code writing the columns.
G1 | tests/contract/forecast-e1a.contract.test.js | 5 tests on real Postgres with detector-found rows: automatic reasons (card_autopay / internal), the four PATCHes moving each item and the totals = the items' projected totals, the dashboard summary's lowest day equal to the service and moved, re-running both detectors keeping the settings, back to automatic, 404s, the CHECK refusing 'sometimes'.

TEST RESULTS: npm test 2934/2934 (17 new). Contract 285/288 run: forecast-e1a 5/5; 1 failure + 2 cancelled are pre-existing and date-dependent — cash-alerts-l2 (known) and cash-flow-l1, whose seed inserts a transfer due in 2 days with last_transferred = the same day a month earlier, NULL when that day doesn't exist (run on Oct 29: Oct 31 → no Sep 31); it fails identically with this batch's changes stashed. Mutation checks: the user's "bill" checked after the heuristics (unit 3 fail, contract 1 fail), forecast_ignore ignored (unit 2 fail), the invalidate dropped (unit 3 fail).
REGRESSION RISKS: projectCashFlow's output and GET /api/cash-flow gain one field (forecast_items) — other callers (dashboard summary, cash alerts, advice) read named fields only. getCashFlowInputs' rows carry extra properties (source / id / treatment / why); the projection reads only display_name / amount / dates. A transfer set to "bill" that really is a card autopay now double-counts card spending — the user's choice. No change while every row is 'auto' / false (the defaults).
INVARIANTS AT RISK: INV-17 (a new CHECK through CHECK_LISTS — the c8-batch8 interpolation pin passes), INV-70 (unchanged — occurrences still from seriesOccurrences), INV-71 (the detectors never write the new columns — pinned), INV-142 (the alerts read the same forecast; invalidate makes the next check re-evaluate). None violated.
NET SCORE: 0 production fixes − 0 new failure modes = 0 (G1 is a new capability)

OPERATOR ACTIONS / DEPLOY:
- None (the columns auto-migrate) | BLOCKS DEPLOY: N
Deploy: Platform, Shell & Auth: Render auto-deploys on push to `main`.

(Not complete in production until blocking operator actions are done AND
the deploy step is confirmed.)

FOLLOW-ON ITEMS:
- tests/contract/cash-flow-l1's seed is date-dependent (its CHASE CARD AUTOPAY row uses next = today + 2 without the month-before loop the other rows use) — fails on days whose +2 has no same day a month earlier; test-only fix (like cash-alerts-l2's).
- A rename rule's re-key that deactivates the old transfer / subscription row loses its forecast setting (as it loses its other user state).
- The settings apply to an incoming transfer too but have no effect there (incoming transfers aren't in the bill schedule).
- No UI yet — E1b.

DOCUMENTATION UPDATES NEEDED:
- CLAUDE.md: cash-flow.js entry (the treatments, bills / left_out, forecast_items), the Cash flow forecast feature, the two PATCH routes in Commands + GET /api/cash-flow's forecast_items, the Database section (the two columns, CHECK_LISTS gains recurring_transfers), INV-142 or a new invariant for the treatment, test counts + the new test entries, Known Open Issues (E1a follow-ons, the cash-flow-l1 date bug).
- .cycle/plan-e1-forecast-corrections.md: E1a row done.
---END BROAD SCAN IMPLEMENTATION SUMMARY---
