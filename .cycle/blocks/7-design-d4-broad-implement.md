---BROAD SCAN IMPLEMENTATION SUMMARY---
Findings implemented: Design pass D4 (`.cycle/plan-design-ux.md`, decisions 6, 7, 15) — Perfin dashboard, part 2: order and density.
- Decision 6:
  - the dashboard in the new order, with `DASHBOARD_WIDGETS` reordered to match;
  - the pyramid below the charts, collapsible, and collapsed by default on a phone.
- Decision 15: the pyramid's mode tabs are one scrollable row on a phone.
- Decision 7:
  - Cash Flow summarised (the lowest day first, 4 weeks + "Show all", "—" for a $0 income / bills cell);
  - Savings Rate summarised (the latest month + "Show all");
  - the trend chart is a sentence until there are 3 months of history.
New capabilities (G/ST): None
Files modified:
- teller/views/dashboard.ejs
- teller/public/perfin-shared.js
- tests/design-d4.test.js (new)
- tests/design-d2.test.js
- tests/roadmap-t1-quickwins.test.js
- tests/roadmap-t2-2-cash-l1.test.js
- tests/scan-oct-batch10.test.js
- tests/ui-polish.test.js
- e2e/pages.spec.js
- CLAUDE.md
- README.md
- .cycle/plan-design-ux.md
- .cycle/STATE.md

CHANGES:
D4-order | teller/views/dashboard.ejs | The markup between the summary and the Quick Links was cut into 22 blocks and reassembled in the decision-6 order. A sorted-line diff against the previous file is identical: nothing was added, lost or edited by the move.
  - New order:
    1. the summary;
    2. the sync strip, the tax-season link, and the CSV-reminder and budget-alert banners;
    3. Since you last looked;
    4. Review Uncategorized;
    5. the charts;
    6. the sync buttons, stat cards and Accounts;
    7. Cash Flow, Upcoming Bills (+ its Quick Add modal) and the 30-day forecast;
    8. the four spending tables;
    9. Settle Up, Rent & Utilities, Investments, Savings Rate and YoY;
    10. the pyramid;
    11. Ask Perfin, AI Insights, AI Memory and Credit Score.
  - The plan doesn't name the CSV-reminder and budget-alert banners. They are alerts, so they sit with the sync strip.
D4-widgets | teller/public/perfin-shared.js | `DASHBOARD_WIDGETS` is in page order, so Settings lists the toggles as they appear. The same 20 entries, unchanged otherwise; the summary is not a toggle.
D4-pyramid | dashboard.ejs | The pyramid is `class="wellness-section collapsible" data-collapse-key="pyramid" data-collapse-phone="1"`, and its h3 is the toggle.
  - CSS: a chevron, and everything but the h3 hidden while collapsed.
  - `initCollapsibles` also takes `.wellness-section.collapsible` and an h2 / h3 child heading.
  - `collapsedFromStore(stored, phoneDefault, isPhone)`: '1' means collapsed and '0' means open. With nothing stored, a section is collapsed only when it is phone-default and the screen is ≤640px.
  - Opening a phone-default section stores '0', so it stays open; the four tables keep their old behaviour (remove the key).
D4-tabs | dashboard.ejs | Decision 15: at ≤640px the mode switcher is one `flex-wrap: nowrap; overflow-x: auto` row with no visible scrollbar.
  - `scrollActiveTab(row)` centres the active tab by setting the row's own scrollLeft, never scrolling the page. It does nothing when the row fits or is missing.
  - It runs when the mode changes and when the pyramid is opened.
D4-cashflow | dashboard.ejs | The section's rendering is now pure helpers, and loadCashFlow just fetches and calls them: `badIf` (now a function), `cashCell`, `extraRowAttrs`, `showAllButton`, `cashFlowSummaryHtml`, `cashFlowTableHtml`, `toggleShowAll`.
  - The summary leads with "Lowest projected: $X on <date>" on its own line; starting / end / discretionary / income sources follow.
  - The first `CASHFLOW_WEEKS_SHOWN` (4) weeks are shown. The rest are `data-extra` rows, hidden, behind "Show all N weeks" (aria-expanded, which becomes "Show fewer").
  - A $0.00 income or bills cell is a muted "—" (aria-label "none"). Spending and the balance always show a figure.
  - One delegated click listener serves every "Show all" button.
D4-savings | dashboard.ejs | Savings Rate shows the latest month (the API sends newest first). The others are hidden behind "Show all N months".
D4-charts | dashboard.ejs | `trendChartNote(n)` (placed after loadCharts so the existing harnesses' slice includes it):
  - "No spending data yet" at 0 months;
  - "Spending trends appear after 3 months of history — N so far" at 1–2 months, where the trend chart is not drawn;
  - '' (draw the chart) at 3 or more.
  The category chart is unchanged.
D4-tests | tests/design-d4.test.js (18) |
  - the decision-6 order on the page;
  - `DASHBOARD_WIDGETS` in DOM order (every selector found, 20 keys, no summary toggle);
  - `applyDashboardWidgets` hiding exactly one switched-off key;
  - the pyramid markup and CSS; `collapsedFromStore` across six cases; opening storing '0';
  - the no-wrap tab row; `scrollActiveTab` in a vm;
  - Cash Flow: 13 weeks → 4 shown + "Show all 13 weeks"; ≤4 → nothing hidden; "—" for $0 and ~$0 income / bills; the lowest line first; Show all ↔ Show fewer; one listener;
  - Savings Rate through the real loader;
  - the real `loadCharts` with 1, 2, 3 and 0 months;
  - dashboard.ejs rendered through EJS, standalone and under /perfin.
D4-tests | design-d2, roadmap-t1-quickwins, roadmap-t2-2-cash-l1, scan-oct-batch10, ui-polish | Old pins of the previous markup and behaviour, updated:
  - `badIf` read as a function;
  - the chart redraw fixtures given 3 months, since 1–2 is now a sentence;
  - the L1 harness slices from the section comment (the helpers now sit above loadCharts' neighbour);
  - the F96 selector check accepts a multi-class attribute;
  - the persisted-state pin follows `collapsedFromStore`.
  The assertions' intent is unchanged.
D4-e2e | e2e/pages.spec.js (+1) | At 390×844:
  - the first summary card is on the first screen;
  - the pyramid is collapsed with its switcher hidden, and sits below the first screen;
  - one click opens it, with the switcher computed as nowrap / overflow-x auto;
  - after a reload it stays open.

TEST RESULTS:
- npm test 2454/2454 (18 new). The first run after the change had 8 failures, all old pins of the reordered or summarised markup, updated as above.
- Playwright: the first full run failed. The dashboard returned 500: the pyramid chevron's CSS `'\25be'` sits inside the head partial's extraStyles JS template literal, where it is an octal escape. The `--` / `:` path didn't matter; EJS refused to compile. It was fixed to `'\\25be'`, and an EJS render of dashboard.ejs was added to design-d4 so `npm test` catches this class. Re-run 70/70.
- Mutation checks 15/15 caught:
  - widgets out of page order; a widget dropped;
  - the pyramid not phone-collapsed; the phone default ignored; opening not remembered;
  - tabs wrapping; the active tab not centred;
  - all weeks shown; a zero cell as $0.00; the lowest line dropped; all savings months shown; Show all's text stuck;
  - the trend chart at 2 months; no empty state at 0 months;
  - the octal escape back.
- Contract suite not re-run: no server or SQL change.
- Screenshots (1280 and 390, seeded data), each matching the decision-6 order:
  - desktop: summary → banners → Since you last looked → Review → charts (the one-month trend is the sentence) → stat cards / accounts → Cash Flow (the lowest day first, 4 weeks, "—" cells, "Show all 13 weeks") → bills → tables → Rent → Savings → the pyramid → Ask / Insights / Credit;
  - phone: the pyramid shows only "Financial wellness ▸".
REGRESSION RISKS:
- The order change is visible on every load. Anyone used to the pyramid at the top now finds it two-thirds of the way down. That is decision 6's choice, stated in the plan's trade-offs.
- A phone user who has never touched the pyramid sees it collapsed. Opening it once stores '0' per browser (localStorage). Private mode or cleared storage collapses it again.
- The trend chart no longer draws for a user with 1–2 months of data. That is intended (decision 7). The category chart still draws.
- Cash Flow's weekly income figures for weeks 5–13 are a click away. The projected low, which is what matters, is now the first line.
- `scrollActiveTab` uses offsetLeft relative to the switcher's offsetParent. A future `position` on the switcher would change that base; the result would be only a slightly off-centre tab, never a page scroll.
- Settings' widget toggle list changes order, which is visible. No key or label changed.
INVARIANTS AT RISK: None.
- INV-116 (one widget list): still one list, now in page order — strengthened by the new DOM-order pin.
- INV-147: the summary is untouched.
- INV-89 / INV-90: no writes or dialogs added. The "Show all" buttons are plain `<button type="button">` with visible labels.
- INV-95: no guard exemptions.
- INV-23 / INV-61: untouched.
NET SCORE: 2 production fixes − 0 new failure modes = 2
  (a) YES for both:
  - the pyramid took the whole first screen on a phone, and the page had no hierarchy (decision 6);
  - Cash Flow was 13 rows of mostly $0.00 and a one-month trend chart was a lone dot (decision 7).
  Both appear on every load.
  (b) No new failure modes. The dashboard 500 was introduced and fixed within the batch, and is now pinned by a unit test.

OPERATOR ACTIONS / DEPLOY:
- None. | BLOCKS DEPLOY: N
Deploy: Render auto-deploys on push to `main` (Web UI ships with the main deploy); no Apps Script change.

(Not complete in production until blocking operator actions are done AND
the deploy step is confirmed.)

FOLLOW-ON ITEMS:
- No unit test renders the other Perfin views through EJS (scan-oct-batch2 renders account-history and budgets). The extraStyles template-literal octal trap applies to every page with `extraStyles`; a render-every-view test would catch the class repo-wide.
- The sync strip still repeats the summary's Sync Health warning (D3 follow-on).
- The housing widget's gold / green balance and its duplication of the summary's rent line (D3 follow-on).
- The stat-card row (Net Balance … Linked Accounts) now sits with Accounts. It overlaps the summary (Monthly Spend vs Spent vs budget) and could be trimmed in a later pass. Out of D4's scope (decision 6 doesn't mention it).
- "Show all" state isn't remembered across loads, by design (the summary is the point).
DOCUMENTATION UPDATES NEEDED:
- None (done in this batch):
  - CLAUDE.md: the Dashboard feature's order and density paragraph; the DASHBOARD_WIDGETS page-order note; the collapsible sections line; the test file entry and counts; the Playwright description;
  - README: count and line;
  - Plan: D4 DONE.
---END BROAD SCAN IMPLEMENTATION SUMMARY---
