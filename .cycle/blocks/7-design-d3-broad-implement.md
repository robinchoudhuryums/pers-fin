---BROAD SCAN IMPLEMENTATION SUMMARY---
Findings implemented: Design pass D3 (`.cycle/plan-design-ux.md`, decision 5) — Perfin dashboard, part 1: the summary.
- `GET /api/dashboard/summary` in a new `routes/dashboard-summary.js`; each part is fail-soft with a fixed sentence.
- The Summary card (net worth + change, spent vs effective budget with a bar, lowest projected cash with its date) and the Needs-attention list at the top of the dashboard; skeletons while loading; a failed load is one line and the rest of the page loads.
- INV-147 (one definition per summary figure).
New capabilities (G/ST): None
Files modified:
- teller/routes/dashboard-summary.js (new)
- teller/routes/subscriptions.js
- teller/routes/categorize.js
- teller/routes/housing.js
- teller/routes/settings.js
- teller/server.js
- teller/views/dashboard.ejs
- tests/design-d3.test.js (new)
- tests/contract/dashboard-summary.contract.test.js (new)
- tests/roadmap-t1-errors-uptime.test.js
- tests/vps-hosting.test.js
- e2e/pages.spec.js
- CLAUDE.md
- README.md
- .cycle/plan-design-ux.md
- .cycle/STATE.md

CHANGES:
D3-helpers | subscriptions.js, categorize.js, housing.js, settings.js | Route bodies were moved into exported helpers, so the summary reads exactly what each screen reads. Every route keeps its output unchanged.
  - `forecastCharges(db, today, endStr)`: the /api/forecast projection, now with `bill_source` / `bill_id`. The route maps it back to its old five fields.
  - `getBillsDue(db, { today, days })`: forecastCharges plus every manual-bill occurrence by the calendar's `manualBillOccurrences`, less occurrences in `bill_payments` (the calendar's `paidKey`).
  - `countUncategorized(db)`: the /api/categorize/status count.
  - `ledgerTotals(rows)` / `getHousingOwed(db)`: the ledger's balance and counts over the configured payee's rows; `{ configured: false }` while the ledger is off.
  - `gatherDataHealth(db, { persistentPool })`: the whole /api/data-health body. The route is a thin wrapper.
D3-route | teller/routes/dashboard-summary.js, server.js | `GET /api/dashboard/summary` → `gatherDashboardSummary(pool, { deps, today, persistentPool })`. It is mounted after the tax routes and is the shared entry point D7 reuses.
  - net_worth: the latest `net_worth_snapshots` row, and its change since the month's first snapshot (null when that snapshot is today's or there is none).
  - spending: getBudgetStatus summed — spent vs effective limits, percent, over_count.
  - cash: getCashFlowForecast over 30 days → its lowest day.
  - attention.items, in this order, each `{ kind, text, href, amount?, count }`:
    - rent owed (`/housing`), only when configured and > 0;
    - bills due in 7 days (`/calendar`);
    - transactions to categorize (`/dashboard#review-queue-section`);
    - Sync Health warnings, severity 'warning' only (`/settings#sync-health`).
  - Unrated insights are not an item (decision 5).
  - A failing reader (sync or async throw) becomes `{ ok: false, error: <fixed sentence> }`, or one `attention.errors` entry, and is logged once; the error text never reaches the response.
  - The only SQL in the module is the two net-worth reads.
D3-ui | teller/views/dashboard.ejs | A `<section id="dash-summary">` sits after the title, before the tax-season link, the sync strip and the widgets.
  - Three cards:
    - Net worth: "Not yet" until a snapshot exists; the change in green when up, plain when down.
    - Spent vs budget: "of $X", a bar (role=img, labelled, red and capped at 100% when over), "N% of M budgets · K over"; "No budgets" with a link to /budgets.
    - Lowest cash, next 30 days: red below $0, "On <date>".
  - The Needs-attention list: same-app hrefs through `withBase` only, amounts through `fmt`, "✓ Nothing needs attention" only when no source failed.
  - Each part that failed shows "—" and its sentence. Skeletons (pulse off under reduced motion) and aria-busy while loading.
  - A failed request hides both and shows one line; the rest of the page loads as before. It is loaded first in Initialize.
D3-tests | tests/design-d3.test.js (23) | 
  - gatherDashboardSummary over a fake pool with every reader injected as a spy:
    - every field;
    - each helper called with the pool and the summary's own day / month;
    - each failing reader isolated, its fixed sentence returned, logged once, never the error text;
    - a sync throw and a failed net-worth read contained;
    - net worth none / same-day / earlier / down;
    - attention rules and hrefs, and singular text.
  - spendingFrom.
  - A source scan: the module's only SQL reads net_worth_snapshots.
  - The route answers 200 with every part failed when the database is down.
  - The shared helpers over fake pools:
    - getBillsDue (a subscription, two manual bills, a paid one left out);
    - /api/forecast's shape;
    - ledgerTotals / getHousingOwed (payee-scoped, no ledger read while off);
    - countUncategorized and gatherDataHealth behind their routes.
  - The renderers in a vm with perfin-shared.js's own esc / withBase / fmt / fmtDate:
    - figures;
    - the red capped bar;
    - not-yet and failed states, escaped;
    - same-app links only;
    - the quiet tick, and never when a source failed;
    - the page markup and the load-failure path.
D3-tests | tests/roadmap-t1-errors-uptime.test.js, tests/vps-hosting.test.js | Two source pins named the moved data-health body's `pool`. They now accept `db`, the same calls.
D3-contract | tests/contract/dashboard-summary.contract.test.js (4) | On real rows the summary equals, to the cent:
  - GET /api/budgets (spent / effective_limit sums);
  - /api/cash-flow?days=30 (lowest day, starting balance);
  - the latest net-worth snapshot and the change since the month's first;
  - /api/forecast?days=7 plus the bill calendar's unpaid manual bills in the window (a paid one and one past the window excluded);
  - /api/housing/ledger's balance (another payee's unpaid row not counted);
  - /api/categorize/status;
  - /api/data-health's warnings.
  With the ledger off and nothing due, no rent / bills / uncategorized items.
D3-e2e | e2e/pages.spec.js (+1) | The dashboard opens on three summary cards with no skeleton and no error line. The seeded rent item links to /perfin/housing and opens it.

TEST RESULTS:
- npm test 2436/2436 (23 new). The first full run had 2 failures, the two old source pins above, updated.
- Contract suite 253/253 (4 new).
- Playwright 69/69 (full run).
- Mutation checks 17/17 caught:
  - rent with nothing owed;
  - sync counting every issue;
  - the bills window at 14 days; the cash window at 90;
  - the budget for the wrong month; the base limit instead of the effective one;
  - no failure log;
  - a change on the same day;
  - paid bills kept; rent not payee-scoped (both also caught by the contract);
  - a link without withBase; any href linked;
  - all clear despite errors;
  - the bar uncapped;
  - unescaped attention text;
  - a failed load leaving the skeletons;
  - the route not mounted.
- Screenshots (1280 and 390, seeded data) vs D2's set: the Summary card and Needs attention at the top. Desktop shows three cards side by side; the phone stacks them.
  - "Not yet" net worth (the seed has no snapshot);
  - $60.20 of $300.00;
  - a red -$115.32 lowest cash;
  - "Owed to E2E Landlord $1,500.00", "5 transactions to categorize", and on the phone "1 Sync Health warning".
REGRESSION RISKS:
- The dashboard now loads /api/data-health twice: once for the summary and once for the sync strip. Each also runs the cached operator checks and the webhook status — a few more queries per load.
- The summary adds six reads plus a 30-day forecast to every dashboard load. They run in parallel.
- A Sync Health warning now shows in two places, the Needs-attention list and the sync strip just below. D4 can retire the strip or have it read the summary.
- On a phone the summary pushes the rest of the dashboard down about one screen. That is intended (decision 5), and D4 reorders the rest.
- The route bodies moved into helpers return the same output.
  - /api/forecast: the same five fields, shape-checked.
  - /api/data-health: the same object, contract suite green.
  - /api/categorize/status and the ledger: the same values.
  - A caller that requires these modules sees only new exports.
- "Bills due" counts a subscription charge the user marked paid on the calendar ahead of time, because /api/forecast doesn't know about payments. It is excluded for manual bills.
INVARIANTS AT RISK: None.
- INV-147 is new.
- INV-73: budget status still has one definition (getBudgetStatus).
- INV-70: manual bills use manualBillOccurrences; subscriptions use seriesOccurrences via forecastCharges.
- INV-72: the rent figure is payee-scoped.
- INV-105 / INV-126 / INV-141: data-health is unchanged, only moved.
- INV-116: DASHBOARD_WIDGETS unchanged.
- INV-89: no new writes.
- INV-95: no guard exemptions added; KNOWN_GAPS untouched.
NET SCORE: 1 production fix − 0 new failure modes = 1
  (a) YES: the dashboard had no "am I OK this month?" answer at the top. Net worth, budget position, a projected cash dip and what needs doing were spread over the page or on other screens, on every load. It is a capability-shaped design item, counted once.
  (b) No new failure mode: each part is fail-soft, and a whole-request failure leaves the page as it was. The doubled data-health load is listed above as a cost, not a failure.

OPERATOR ACTIONS / DEPLOY:
- None. | BLOCKS DEPLOY: N
Deploy: Render auto-deploys on push to `main` (Platform / Web UI ship with the main deploy); no Apps Script change.

(Not complete in production until blocking operator actions are done AND
the deploy step is confirmed.)

FOLLOW-ON ITEMS:
- The housing dashboard widget still colours its balance gold / green, a D2 miss. Its figure now duplicates the summary's rent item; D4 can drop or merge it.
- The sync strip and Needs attention both show Sync Health warnings (D4).
- getBillsDue counts a subscription charge marked paid early, as /api/forecast does. Excluding it there would change /api/forecast's meaning, so it is left for a design call.
- The summary isn't a Settings widget toggle, by design until D4 reorders DASHBOARD_WIDGETS.
- The net-worth card says "Not yet" until the hourly snapshot job (or a balance sync) writes the first row, even when accounts have balances. That is decision 5's choice of the latest snapshot.
DOCUMENTATION UPDATES NEEDED:
- None (done in this batch):
  - CLAUDE.md:
    - the routes/dashboard-summary.js entry and the gatherDataHealth note;
    - the Dashboard feature line;
    - Commands;
    - the Financial Analytics subsystem list;
    - INV-147;
    - the test file entry, counts, the contract list and the Playwright count.
  - README: count and a summary line.
  - Plan: D3 DONE.
---END BROAD SCAN IMPLEMENTATION SUMMARY---
