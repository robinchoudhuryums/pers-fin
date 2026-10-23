---BROAD SCAN IMPLEMENTATION SUMMARY---
Findings implemented: None (roadmap work, not scan findings)
New capabilities (G/ST): Roadmap T2.2 (low-balance and payday alerts), batch L1 of L1–L4 (.cycle/plan-t2-2-cash-alerts.md) —
  L1 the cash-flow forecast as a shared service: services/cash-flow.js (queries + a pure day-by-day projection + the lowest projected day + firstBelow), "today" on the APP_TIMEZONE date, GET /api/cash-flow a thin wrapper adding lowest_balance / lowest_balance_date, the dashboard's "Lowest projected" figure. Docs folded in.
Files modified: teller/services/cash-flow.js (new), teller/routes/spending-analytics.js, teller/views/dashboard.ejs, tests/roadmap-t2-2-cash-l1.test.js (new), tests/contract/cash-flow-l1.contract.test.js (new), tests/scan-sept-batch4.test.js, tests/cycle-fixes.test.js, tests/scan-oct-batch14.test.js, CLAUDE.md, README.md, .cycle/plan-t2-2-cash-alerts.md, .cycle/STATE.md

CHANGES:
L1 | teller/services/cash-flow.js | getCashFlowInputs(pool, { today }) — the route's five reads moved verbatim (getLiveIncomeStreams now given `today`; subscriptions + outgoing recurring transfers with card autopays dropped by isCardAutopay — DD-4; depository non-investment cash — FAN-5; the 60-day overall + weekday averages without subscription merchants — DD-4). projectCashFlow(inputs, { days }) is PURE: walks today+1 … today+days with cadence.addDaysStr (calendar dates, weekday from Date.UTC — no server-zone or toISOString dependence), bills via seriesOccurrences and income via incomeEventsBetween over [today, today+days], the same running balance / rounding / weekly totals as before, plus `projection` (daily) and `lowest` (the earliest lowest day). firstBelow(projection, threshold) — the first day strictly below a floor, or null. getCashFlowForecast(pool, { days, today = todayStr() })
L1 | teller/routes/spending-analytics.js | GET /api/cash-flow → getCashFlowForecast(pool, { days }); returns every old field plus lowest_balance / lowest_balance_date, never the daily series; same 30–180 clamp and 500 text. The inline projection (and its UTC `now.toISOString()` today / per-day dates) removed with the now-unused imports
L1 | teller/views/dashboard.ejs | loadCashFlow's summary line adds "Lowest projected: $X on <date>" (red below $0, else warm) when the response has a lowest day
Tests | tests/roadmap-t2-2-cash-l1.test.js (18), tests/contract/cash-flow-l1.contract.test.js (2), tests/scan-sept-batch4.test.js, tests/cycle-fixes.test.js, tests/scan-oct-batch14.test.js | Unit (the file forces an APP_TIMEZONE whose date differs from UTC's): the pure projection over a hand-worked fixture (month-end dates, exact balances, totals, the hidden mid-period low, firstBelow strictness, weekly shape, weekday vs overall average, semimonthly income, no days → no lowest); the inputs over a mock pool (autopay skipped, loan / investment transfers kept, today threaded into stream liveness, FAN-5 / DD-4 SQL); the route as a wrapper (exact key set, equal to the service, lowest = −290 on the last day, starting the day after todayStr(), the clamp, no toISOString anchor left in the analytics routes); the dashboard line run from dashboard.ejs (red / warm, absent without a lowest day). Contract: route = service on real rows (2000 spendable of 4 accounts, Netflix + loan billed and the autopay not, a biweekly payroll stream, ending 4584.51), lowest 2584.51 on today+5, firstBelow. Three older source pins repointed from the route to the service
Docs | CLAUDE.md, README.md | Architecture (services/cash-flow.js), the Cash flow forecast feature text, the /api/cash-flow endpoint note, counts 2026 / 102 files / Perfin 1475, contract 191 + test-file descriptions, Financial Analytics subsystem list, Known Open Issues (T2.2 in progress, L1 follow-ons)

TEST RESULTS: npm test 2026/2026 (18 new); contract 191/191 (2 new); Playwright 57/57 (the dashboard changed); no schema change (migration test not re-run). Mutation checks: a UTC default `today`, firstBelow with <=, or the lowest day taken from week ends each turn tests red.
REGRESSION RISKS:
- With APP_TIMEZONE set to a non-UTC zone, /api/cash-flow's days shift by one during the hours the local date differs from UTC's (intended — it now matches the user's day); with the default UTC nothing moves.
- Bill / income occurrences are now gathered over [today, today+days] instead of [today, now+days+1]; the extra day was never projected, so totals are unchanged.
- The weekday of each projected day is computed from the calendar date rather than the server clock's `getDay()` — identical on a UTC server, correct on any other.
INVARIANTS AT RISK: None. INV-07 (SPLIT_AMOUNT imported, moved not re-inlined — seams scan green), INV-48, INV-70 (seriesOccurrences), INV-110 (getLiveIncomeStreams), INV-122 (still charge-level — pinned on the service too), INV-121 (no new UTC anchor; one removed).
NET SCORE: 0 production fixes − 0 new failure modes = 0 (new capability; the UTC-today shift only fires with a non-UTC APP_TIMEZONE)

OPERATOR ACTIONS / DEPLOY:
- None
Deploy: Financial Analytics / Web UI — Render auto-deploys on push to `main` (PR robinchoudhuryums/pers-fin#133).

(Not complete in production until blocking operator actions are done AND
the deploy step is confirmed.)

FOLLOW-ON ITEMS:
- The 60-day spending averages still read Postgres CURRENT_DATE (a documented rolling window, left as is).
- The projection is one total across depository accounts; per-account floors are L4.
- The timezone lint misses `now.toISOString()` on a Date held in a variable (noted in seams audit #3); this batch removed one such case from the analytics routes.

DOCUMENTATION UPDATES NEEDED:
- None beyond this batch (docs folded in).
---END BROAD SCAN IMPLEMENTATION SUMMARY---
