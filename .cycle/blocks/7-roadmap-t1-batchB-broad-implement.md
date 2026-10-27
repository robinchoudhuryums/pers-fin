---BROAD SCAN IMPLEMENTATION SUMMARY---
Findings implemented: None (roadmap work, not scan findings) — closes three Known Open Issues follow-ons (Batch 10: charts don't redraw after a sync + the category-month selector keeps the first aggregate; Batch 10: a one-time budget for another month can't be seen or edited; Batch 15: rename rules can't be edited)
New capabilities (G/ST): Roadmap T1.5 Batch B —
  B1 dashboard charts + Spending-by-Category selector refresh from the fresh spending summary after a sync / detection / shared-split change
  B2 Budgets page month navigation (‹ month ›, This month, ?month= deep link), "One month only" defaults to the viewed month, one-month budgets in other months listed as links (GET /api/budgets/one-time)
  B3 PATCH /api/merchant-rename-rules/:id (rename_to, is_active) + Settings → Rules Edit / Turn off / Turn on
Files modified: teller/views/dashboard.ejs, teller/routes/budgets.js, teller/views/budgets.ejs, teller/routes/merchant-rename.js, teller/public/settings-rules.js, tests/roadmap-t1-quickwins.test.js (new), tests/contract/quickwins.contract.test.js (new)

CHANGES:
B1 | teller/views/dashboard.ejs | loadCharts keeps its two Chart instances (replaceChart destroys the previous one — Chart.js refuses a second chart on a used canvas) and no longer replaces the canvas with an empty-state div (setChartEmpty hides the canvas and shows a sibling .chart-empty note), so it can redraw; refreshSpending() = loadSpendingSummary() (fresh fetch) then loadCharts() (reuses that response), called by Sync Transactions, Run Detection and the shared-split change; the category table moved to renderCategoryRows / renderCategoryMonth reading latestCategoryData (the change handler used to close over the first response), options rebuilt on every load keeping a still-listed choice, a sequence number so a slow month fetch can't overwrite a later choice
B2 | teller/routes/budgets.js | GET /api/budgets/one-time → { budgets: [{ id, category, monthly_limit, effective_month }] } for every one-month budget (a separate route — GET /api/budgets stays an array; see deviation)
B2 | teller/views/budgets.ejs | month nav (prev / next / This month, aria-labelled, ?month= via replaceState), GET /api/budgets?month=<viewed>, "Spent in <Month>" label, empty-state text per month, the Add form's one-month default = the viewed month, "One-month budgets in other months" link list (.other-months[hidden] rule — the flex container would otherwise beat [hidden])
B3 | teller/routes/merchant-rename.js | updateRenameRule(id, { renameTo, isActive }): validates (400 none / non-boolean / 1-200 chars, 404 unknown); OFF reverts the rule's rows like DELETE and keeps the rule (detection rows untouched, like DELETE); a new name on an active rule or turning it ON goes through createRenameRule (rows follow the name, detection re-keyed with user state, then redetect); a name on a rule that stays off is only stored; unchanged active name = no-op. PATCH /api/merchant-rename-rules/:id (strict integer id) + export
B3 | teller/public/settings-rules.js | per-rule Edit (prompt) and Turn off / Turn on (confirm before off, aria-pressed), off rules dimmed with "off ·", writeOk reporting, list reloaded after each change
Tests | tests/roadmap-t1-quickwins.test.js (15: the real loadCharts redrawn twice with destroy + the empty-state round trip, the real renderCategoryMonth in a vm — latest aggregate + slow-fetch race, wiring pins; the one-time route, month arithmetic in a vm, page pins; updateRenameRule paths with a fake db, the route's id check, the Settings UI), tests/contract/quickwins.contract.test.js (4: one-time listing; a new name renames rows + re-keys the subscription with its notes while a hand-renamed row stays; off reverts + keeps the rule, on re-applies; 400s / 404)

TEST RESULTS: npm test 1879/1879 (15 new); contract 160/160 (4 new); Playwright 57/57; no schema change (migrations not re-run). Mutation checks: dropping the old chart's destroy() turns the redraw test red; passing the old name in the PATCH path turns 2 contract tests red.
REGRESSION RISKS:
- The dashboard's empty chart state is now a hidden canvas + a note instead of replacing the canvas; the e2e page run covers the dashboard with seeded data.
- The Budgets page's month comes from the browser's local date, while GET /api/budgets without ?month= uses APP_TIMEZONE — for a few hours at a month boundary the page's "This month" can differ from the server's (it now always sends ?month=).
- Turning a rename rule off leaves the detected subscription keyed on the rule's name (same as DELETE); the next detection run creates a row under the bank name.
INVARIANTS AT RISK: None (INV-124 kept: a rule still only fills NULL names and a hand rename wins — pinned by the contract test; INV-89: every new write goes through writeOk; INV-90: no new modal; INV-73: GET /api/budgets unchanged)
NET SCORE: 0 production fixes − 0 new failure modes = 0 (the three items are known follow-ons / new capability; the off-rule detection behaviour matches Delete and is documented)

Deviation from the plan: the plan put other_months on GET /api/budgets's response; that endpoint returns an array read by the dashboard, the Budgets page, and several unit / contract tests, so the list is a separate GET /api/budgets/one-time instead.

OPERATOR ACTIONS / DEPLOY:
- None | BLOCKS DEPLOY: N
Deploy: Web UI / Financial Analytics / Detection & Categorization: Render auto-deploys on push to `main` (PR robinchoudhuryums/pers-fin#133).

(Not complete in production until blocking operator actions are done AND
the deploy step is confirmed.)

FOLLOW-ON ITEMS:
- Turning a rename rule off (or deleting it) doesn't re-key or re-run detection, so the next detection creates a second subscription row under the bank name (pre-existing Delete behaviour, now also reachable via Turn off).
- A rename rule's pattern / match type still can't be edited (delete + re-create).
- The Budgets month picker uses the browser's month; an APP_TIMEZONE-aware "this month" would need the server's month in the page.
- The credit-score and AI-insights widgets still have no Settings toggle (Batch 10 follow-on, not in this batch).

DOCUMENTATION UPDATES NEEDED:
- CLAUDE.md: budgets.js entry + Commands (GET /api/budgets/one-time), merchant-rename.js entry + Commands (PATCH /api/merchant-rename-rules/:id), Features (Budget rollover → month navigation; Merchant rename rules → Edit / off / on; Dashboard → charts redraw), Known Open Issues (remove the three resolved follow-ons; add the Batch B follow-ons), test counts (1879 / 92 files / Perfin 1345, contract 160) + the two test-file descriptions.
- README: counts.
---END BROAD SCAN IMPLEMENTATION SUMMARY---
