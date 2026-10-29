---BROAD SCAN IMPLEMENTATION SUMMARY---
Findings implemented: None (E1b is expansion work)
New capabilities (G/ST): G1 (UI half, cycle-8 E1b) — a "What's in this forecast" list in the dashboard's Cash Flow section: every projected bill and every item left out (with the reason in words), each with a labelled setting the user can change.
Files modified: teller/views/dashboard.ejs, tests/cycle8-e1b.test.js (new), e2e/pages.spec.js

CHANGES:
G1 | teller/views/dashboard.ejs | Markup: a collapsed `<details id="cashflow-items-wrap">` "What's in this forecast" inside #cashflow-section (only its body #cashflow-items is re-rendered, so its open state survives reloads). Script (in the Cash Flow section): FORECAST_REASONS (card_autopay / internal / user_internal / user_ignored → a sentence), cadenceWords, forecastSelectHtml (transfer: Automatic / Always a bill / Between my accounts / Leave out; subscription: Include / Leave out; class fi-select, data-fi-source / -id / -prev, aria-label "Forecast setting for <name>", escaped), forecastItemRow (an item without a source / id gets no select), forecastItemsHtml ("Projected bills": "N in the next D days, $total · next <date>", "· you set it as a bill" for why=user, "Not due in the next D days"; "Left out" with the reason; a note when both lists are empty), renderForecastItems (called by loadCashFlow with forecast_days; keeps focus on the changed select), onForecastItemChange (disabled while saving; PATCH …/recurring-transfers/:id/forecast { treatment } or …/subscriptions/:id/forecast { ignore }; writeOk "Could not save the forecast setting", a network throw toasted; success → data-fi-prev updated, loadCashFlow() then loadDashboardSummary(); failure → the select put back, nothing reloaded), wireForecastItems (one delegated change listener, wired at Initialize after loadAdvice()).
G1 | tests/cycle8-e1b.test.js | 14 tests, the section run in a vm with the real fmt / esc: both lists' text, every reason, the selects' options / selected / labels, escaping, no select without a source, the empty states, cadence words, loadCashFlow rendering + focus kept, each PATCH and body, reloads on success only, a refused and a failed save putting the select back, the delegated listener, the markup (collapsed, wired after loadAdvice()).
G1 | e2e/pages.spec.js | the seeded dashboard: open the list, the seeded Streamflix subscription's labelled setting, Leave out → "You left it out", Include again.

TEST RESULTS: npm test 2948/2948 (14 new). e2e 73/73 (1 new) — run in this container with Playwright's launchOptions.executablePath pointed at /opt/pw-browsers/chromium through a throwaway local config (not committed). One full-suite run made while the e2e server was busy failed tests/roadmap-t3-3-k2.test.js at file level; it passes alone and in the quiet re-run (load, not this change). Contract suite not affected (no server change). Mutation checks: no revert on failure (2 fail), unescaped aria-label (1), no summary reload (1), a reason's words changed (1).
REGRESSION RISKS: The Cash Flow section's other output is unchanged (pinned by roadmap-t2-2-cash-l1 and design-d4, both green). A select change reloads the section and the summary card — two requests. The e2e click sweep presses the new <summary>; selects aren't swept.
INVARIANTS AT RISK: INV-89 (every write through writeOk — yes), INV-90 (no new dialog; the select is labelled), INV-148 (amounts through fmt; no new colour), INV-147 (the summary reloads from its own endpoint; nothing re-derived). None violated.
NET SCORE: 0 production fixes − 0 new failure modes = 0 (G1 is a new capability)

OPERATOR ACTIONS / DEPLOY:
- None | BLOCKS DEPLOY: N
Deploy: Platform, Shell & Auth: Render auto-deploys on push to `main`.

(Not complete in production until blocking operator actions are done AND
the deploy step is confirmed.)

FOLLOW-ON ITEMS:
- e2e CAN run in the cloud container: launch with executablePath '/opt/pw-browsers/chromium' (an env-gated launchOptions in e2e/playwright.config.js would make `npm run test:e2e` work here without a local config) — corrects the cycle-8 Batch 1 follow-on.
- The list shows only recurring transfers and subscriptions; manual bills and income streams aren't in it (nor correctable).
- A user set "Always a bill" on a transfer that later goes inactive keeps the setting silently (no list entry while inactive).
- Still open from E1a: tests/contract/cash-flow-l1's date-dependent seed.

DOCUMENTATION UPDATES NEEDED:
- CLAUDE.md: the Cash flow forecast feature and the dashboard section (the "What's in this forecast" list), test counts (npm 2948 / 157 files; e2e 73) + the new test entries; Known Open Issues (E1 follow-ons; the e2e-in-container note).
- .cycle/plan-e1-forecast-corrections.md: E1b row done.
---END BROAD SCAN IMPLEMENTATION SUMMARY---
