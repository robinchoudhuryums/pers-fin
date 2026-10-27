---BROAD SCAN IMPLEMENTATION SUMMARY---
Findings implemented:
- F91 — dashboard charts drew raw transactions (transfers, reimbursed, no split) and labelled months one early west of UTC; they now draw /api/spending-summary with local month labels
- F94 — the nav overflowed (horizontal page scroll) between 641 and ~960px; it now wraps, links on their own row
- F95 — a long calendar event widened its 1fr column and pushed "+ Add Bill" off a 390px screen; minmax(0, 1fr) + wrapping month nav
- F96 — Settings and the dashboard kept different widget-key lists (five toggles hid nothing; whatsNew / investmentReturns / settlement had no toggle); one shared DASHBOARD_WIDGETS list + class-based hiding
- F97 — "1,200" typed into the budget-edit / manual-balance prompts saved $1; parseAmountInput + writeOk
- F98 — goal target/estimated dates and credit-score dates showed a day early west of UTC; parseCalDate
- F99 — five writes ignored failures (push subscribe, Remember-merchant rule, Review Apply, insight modules_failed / summary_status, housing generate); each reports it now
- F100 — "+ Add Budget" / "+ Add Manual" needed two clicks; computed display
- F101 — ~23 Settings controls, 5 on Subscriptions, the Goals link picker and .inv-remove had no accessible name; labels added and the IF-3 scan extended to Settings + Subscriptions
- F39 — rollover / one-time budgets had no UI and the Add form's upsert reset them; type / month / rollover controls + a rollover toggle, and the POST upsert keeps fields it isn't sent
- F102 — the session-expiry redirect dropped the page; it now passes return_to
- F103 — the Split modal opened empty when its GET failed (saving wiped the real splits) and dropped each split's merchant_name; it stops on a failed read and keeps merchant_name
- F104 — paid Upcoming Bills rows had two style attributes (layout lost); one attribute
- F105 — the Accounts page showed a manual loan as a green positive; shown as "-$X owed" in red
- F106 — the accuracy panel wrote error text into innerHTML unescaped; esc()
- F107 — the service-worker cache grew with every ?v= and could store login HTML under an asset URL; path-only keys, no redirected / stray-HTML responses, cache v7
- F108 — the dashboard tables and Settings AI usage stayed on "Loading..." when their API failed; they say it could not load
New capabilities (G/ST): None
Files modified:
- teller/public/perfin-shared.css, teller/public/perfin-shared.js, teller/public/sw.js, teller/public/transactions.js
- teller/routes/budgets.js
- teller/views/accounts.ejs, budgets.ejs, calendar.ejs, dashboard.ejs, goals.ejs, housing.ejs, settings.ejs, subscriptions.ejs
- tests/scan-oct-batch10.test.js (new), tests/contract/ui-writes.contract.test.js (new), tests/scan-oct-batch2.test.js (cache v7 pin), tests/scan-sept-batch13.test.js (IF-3 file list)

CHANGES:
F91 | dashboard.ejs | getSpendingSummary(fresh) — one /api/spending-summary request shared by the tables (always fresh) and loadCharts (reuses the latest); trend = monthly_trend reversed, labels from new Date(y, m-1, 1); doughnut = by_category top 8
F94 | perfin-shared.css | .topnav flex-wrap; @media 641–960px: .nav-links order 10, flex-basis 100%, wrap, gap 8px 18px
F95 | calendar.ejs | grid repeat(7, minmax(0, 1fr)) (both breakpoints), .cal-day min-width 0, .month-nav wraps; ≤640px smaller title, no 180px min
F96 | perfin-shared.js, perfin-shared.css, settings.ejs, dashboard.ejs | DASHBOARD_WIDGETS [{key,label,selector}] + applyDashboardWidgets (toggles .widget-off = display:none !important); Settings renders from it; dashboard calls it
F97 | budgets.ejs, accounts.ejs | editBudget / updateManualBalance parse with parseAmountInput, refuse a non-number, report via writeOk
F98 | goals.ejs, dashboard.ejs | parseCalDate for estimated_date / target_date / checked_at
F99 | settings.ejs, dashboard.ejs, housing.ejs, transactions.js | push POST/DELETE via writeOk (a failed POST unsubscribes the browser); insights toast for modules_failed / summary_status; Review Apply writeOk + rule_error toast; from-transaction rule via writeOk; housing generate via writeOk (no silent catch)
F100 | budgets.ejs, subscriptions.ejs | getComputedStyle(...).display === 'none'
F101 | settings.ejs, subscriptions.ejs, goals.ejs, dashboard.ejs, tests | aria-label on 22 Settings controls + template-built cat-fix-select / target-% input / remove button; Subscriptions <label for> + ids; Goals picker + .inv-remove aria-label; IF-3 scan covers settings.ejs + subscriptions.ejs
F39 | routes/budgets.js, budgets.ejs | POST validates budget_type / effective_month (400); upsert COALESCEs rollover_enabled / budget_type / notes and keeps effective_month unless a type is sent; page: Type (every month / one month only), Month, "Carry unused budget" checkbox, badges, "Roll over unused / Stop rollover" (PATCH)
F102 | perfin-shared.js | '/login?return_to=' + encodeURIComponent(pathname + search)
F103 | transactions.js | a failed splits GET stops with a toast; merchant_name kept on load and save
F104 | dashboard.ejs | paid styles merged into the one style attribute
F105 | accounts.ejs | isDebt = credit || loan → "-$X owed", red
F106 | settings.ejs | esc() on d.error / e.message in the accuracy panel
F107 | sw.js | cacheKey(u) = origin + pathname (put + match); shouldCache skips !ok, non-basic, redirected, and text/html unless a navigation; CACHE perfin-v7
F108 | dashboard.ejs, settings.ejs | failed spending load replaces the four tables' Loading rows; AI usage says "Could not load AI usage"

TEST RESULTS: passed — npm test 1649/1649 (+24 scan-oct-batch10, +2 IF-3 files); contract 90/90 (+3 ui-writes); Playwright 35/35; an ad-hoc browser check showed no horizontal scroll at 800 / 700 / 390 / 1280px and "+ Add Bill" inside a 390px screen. Every new test fails without the fixes (22 unit failures; 2 of 3 contract tests — the PATCH toggle passes pre-fix by design).
REGRESSION RISKS:
- F96: a widget key stored as false that used to do nothing (monthlySpend, categories, merchants, upcoming, calendar) now hides that widget — switch it back on in Settings.
- F107: a page's cached offline copy is keyed by path, so /transactions?q=a and ?q=b share one entry (offline only).
- F91: the charts are no longer redrawn after a sync (they weren't before either).
INVARIANTS AT RISK: None — INV-23 (/api/* still never cached), INV-61 (one loop-guarded redirect, now with return_to), INV-89 (more writes through writeOk), INV-90 (no new CSS variables) checked.
NET SCORE: 8 − 1 = 7 (production fixes: F91, F94, F95, F96, F98, F100, F102, F104; new failure mode: F96 dormant "off" toggles take effect)

OPERATOR ACTIONS / DEPLOY:
- None | BLOCKS DEPLOY: N
Deploy: Platform, Shell & Auth — Render auto-deploys on push to `main` (alt: `fly deploy`). The service worker moves to cache perfin-v7 on first load after deploy.

(Not complete in production until blocking operator actions are done AND
the deploy step is confirmed.)

FOLLOW-ON ITEMS:
- GET /api/budgets leaves out a one-time budget outside the current month and the Budgets page has no month selector, so a one-time budget for a later month can't be seen or edited until that month.
- The dashboard's category-month selector keeps the first response's aggregate (a refresh after sync doesn't update the "Recent months" option); the charts don't redraw after a sync.
- The credit-score and AI-insights dashboard widgets have no Settings toggle.
(or "None")

DOCUMENTATION UPDATES NEEDED:
- CLAUDE.md: sw.js cache perfin-v7 + path keys + shouldCache (teller/public entry, PWA bullet); dashboard charts from /api/spending-summary; DASHBOARD_WIDGETS / applyDashboardWidgets / .widget-off (perfin-shared.js entry + the widget-key mentions); budget rollover / one-time UI + POST keeping unsent fields (Budget rollover bullet + POST /api/budgets endpoint; the F39 Known Issues line); apiFetch return_to (Security W3 + INV-61); Split modal; nav wrap; IF-3 scan files (Accessibility bullet); counts (1649 across 77 files, Perfin 1193; contract 90); Known Issues (Batch 10 follow-ons).
- README: counts + Batch 10 summary.
---END BROAD SCAN IMPLEMENTATION SUMMARY---
