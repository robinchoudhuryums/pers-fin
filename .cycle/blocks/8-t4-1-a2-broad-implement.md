---BROAD SCAN IMPLEMENTATION SUMMARY---
Findings implemented: None (roadmap work, not scan findings)
New capabilities (G/ST): Roadmap T4.1 A2 — GET /api/advice, the dashboard "Your plan" card (widget key `advice`, on by default, between Review Uncategorized and the charts), and Ask's get_cash_plan tool
Files modified: teller/routes/advice.js (new), teller/server.js, teller/public/perfin-shared.js, teller/views/dashboard.ejs, teller/routes/ask.js, tests/roadmap-t4-1-a2.test.js (new), tests/contract/advice-a1.contract.test.js, tests/design-d4.test.js, tests/cycle-fixes.test.js

CHANGES:
T4.1 A2 | teller/routes/advice.js, teller/server.js | GET /api/advice → services/advice.getAdvicePlan(pool) as JSON (a plan that can't be worked out is still 200 { ok: false, error, disclaimer }); a throw is logged and a fixed 500. Mounted after dashboard-summary.
T4.1 A2 | teller/public/perfin-shared.js | DASHBOARD_WIDGETS gains { key: 'advice', label: 'Your Plan', selector: '#advice-section' } in page order (after reviewQueue, before charts) — 21 keys.
T4.1 A2 | teller/views/dashboard.ejs | The "Your plan" section (aria-labelledby, skeleton + aria-busy while loading): the headline; the why line; the steps as an <ol> with the current one aria-current="step" and visually hidden Done / Now / Later text; a responsive-cards debt table (APR — "22% (assumed)" for an assumed one — balance, pay per paycheck / month, payoff month, interest saved, "—" for a debt on its minimum; "Minimum never pays it off" in .amt-bad, the only red); the snowball and 30%-utilization tips; the notes; the disclaimer on every state. No history and no debts → emptyState ("Link an account" → /accounts); ok:false → its sentence; a failed load → "Your plan couldn't be loaded." CSS in extraStyles (no backslash escapes). loadAdvice() runs after loadForecast().
T4.1 A2 | teller/routes/ask.js | get_cash_plan (8th tool): the engine's plan trimmed (ok, disclaimer, period, headline, why, steps, surplus, cash, allocation, notes, debts as { name, type, balance, apr, apr_assumed, minimum, carried, tier, utilization_pct, utilization_tip text }); ok:false passes its sentence + disclaimer. The system prompt sends extra-money / debt / emergency-fund / investing questions to it, says to give its figures as they are, call it educational and never name a security or fund.
T4.1 A2 | tests | 17 new unit tests (route, card in a vm over a real buildAdvicePlan, loader, markup + widget key, the Ask tool and prompt); 1 new contract test (GET /api/advice through perfinApp() equals getAdvicePlan on the seeded rows); design-d4's page order + 21 keys; cycle-fixes' responsive-cards count 4 → 5.

TEST RESULTS: npm test 2767/2767 (17 new); contract 275/275 (1 new); mutation 2/2 red (aria-current dropped, the tool's executor key renamed). Playwright not run (browser build missing in the container).
REGRESSION RISKS: The dashboard makes one more request on load, whose seven reads include a second 60-day cash forecast (the summary computes a 30-day one) — a few queries. A browser that cached perfin-shared.js before the deploy lacks the advice key (only the Settings toggle is missing until it reloads; the card shows regardless).
INVARIANTS AT RISK: None — INV-116 (DASHBOARD_WIDGETS the one list, page order kept), INV-148 (red only for "never pays off", no inline colours, emptyState for the empty state), INV-14 / INV-55 (Ask's cap path unchanged; the tool makes no model call), INV-147 untouched (the plan isn't a summary part).
NET SCORE: 0 − 0 = 0 (new capability)

OPERATOR ACTIONS / DEPLOY:
- None
Deploy: Platform, Shell & Auth — Render auto-deploys on push to `main`.

FOLLOW-ON ITEMS:
- The A1 choices stand unchanged (minimum-sized last payment as the carry test; loans ≥ 8% in the high step; the cash cap only on money leaving cash; minimums off the surplus before the 60%).
- The card isn't in AI insights yet (A3) and has no "tell me when my plan changes" option (A4).
- The card's figures are fetched separately from the Summary card; the two cash figures use different horizons (30 vs 60 days) and can differ.
- Settings lists the toggle as "Your Plan" (Title Case, like the other widget labels).

DOCUMENTATION UPDATES NEEDED:
- CLAUDE.md: routes/advice.js in the Architecture tree and the Financial Analytics subsystem list; GET /api/advice in the endpoint list; the dashboard order (Your plan after Review Uncategorized); DASHBOARD_WIDGETS 21 keys; ask.js 8 tools incl. get_cash_plan; Known Open Issues (T4.1 A2 done, follow-ons); counts 2767 / 147 / contract 275 with the new test file.
- README: count + a T4.1 A2 clause.
---END BROAD SCAN IMPLEMENTATION SUMMARY---
