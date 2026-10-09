---BROAD SCAN IMPLEMENTATION SUMMARY---
Findings implemented:
- WD-4 — dashboard pyramid: Wellness reads /api/subscriptions' { subscriptions } and cancelled_at; Spending Health builds its buckets from by_category (it was a constant 75)
- WD-5 — pyramid Net Worth uses the latest net_worth_snapshots row (getNetWorth's figure); Debt Payoff counts loans, with the baseline raised to the current debt when debt exceeds it
- WUI-6 — writes check the response and toast failures: Mark settled / Undo, the shared-split prompt, manual balance edit, calendar mark-paid/unpaid, housing amount / undo payment; a 0% share is kept (client and server)
- WD-12 — deleteManualAccount, watchlist toggle/delete, biometric removal and the debt-baseline save report failures; prompt amounts are validated (no NaN→null)
- WD-7 — CSV "Auto-detect" (default) sends no institution/label so the server derives them (CLI parity); the Accounts page previews before importing
- WD-8 — the unused Plaid pre-build (link token on every Accounts visit, shared sessionStorage key, endless retry) is removed
- WD-9 — "+ Add Goal" opens on the first click
- WD-11 — manual loan accounts can be created from the Accounts page
- WD-13 — WebAuthn registration sends the authenticator's transports
- WD-15 — account history: day labels, debt-aware colours/labels, cards reset on a short range, error text not sticky
- IF-1 — shared dialog helper (openDialog / watchDialog: role/aria-modal, focus into dialog, Tab trap, Esc, focus restore) on every modal and the notification panel
- IF-2 — calendar bills are buttons (aria-pressed, keyboard), "+N more" expands the day
- IF-3 — accessible names on the unlabeled controls (filters, modals, split rows, row checkboxes, APR/limit/payment, housing, calendar, budgets)
- IF-4 — the six undefined CSS tokens are defined
- IF-5 — light theme: --on-teal (white) for text on teal, themed option lists, opaque modal boxes
- IF-6 — PIN pad: no 8-digit cap; Enter on another focused control (biometric) is left to it
- IF-7 — a bell notification with data.url opens it (same-app paths, basePath-prefixed)
Files modified:
- teller/public/perfin-shared.js
- teller/public/perfin-shared.css
- teller/public/transactions.js
- teller/routes/enrollments.js
- teller/views/dashboard.ejs
- teller/views/accounts.ejs
- teller/views/calendar.ejs
- teller/views/housing.ejs
- teller/views/goals.ejs
- teller/views/settings.ejs
- teller/views/transactions.ejs
- teller/views/budgets.ejs
- teller/views/account-history.ejs
- teller/views/partials/nav.ejs
- shell/views/login.ejs
- tests/scan-sept-batch13.test.js (new, 30 tests)

CHANGES:
WD-4 | dashboard.ejs | Wellness unwraps subBody.subscriptions (array tolerated) and counts is_dismissed || cancelled_at. Spending Health maps by_category rows into a lower-cased category→total map; buckets cover the app's categories (Food & Drink, Gas & Fuel, Subscription, …) and raw provider ones (dining, subscriptions, …); no data → score 0 "No spending data yet".
WD-5 | dashboard.ejs | Net Worth mode reads total_assets / total_liabilities / net_worth from the latest /api/net-worth/history row (empty → "Net worth appears after the next balance sync"); growth tier = latest vs first in window. Debt Payoff includes type 'loan'; if current debt > stored baseline, the baseline is raised to the current debt (PATCH) so progress restarts instead of sitting at 0%. Debt button tooltip says "Card and loan".
WUI-6 | perfin-shared.js, dashboard.ejs, calendar.ejs, housing.ejs, enrollments.js | New shared writeOk(res, what) (2xx → true, else toast "<what>: <server error>") and parseAmountInput(raw). Settle / Undo, toggleShared, editManualBalance (the duplicate definition removed), calendar paid toggle (each request checked; a missing payment is reported), housing setAmount/undoPayment (try/catch for network errors). PATCH /api/accounts/:id/shared: spending_split_pct must be an integer 0–100 (400 otherwise) — `parseInt(x) || 100` turned 0 into 100; the prompt validates the same.
WD-12 | accounts.ejs, settings.ejs, goals.ejs, dashboard.ejs | deleteManualAccount / watchlist toggle+delete / biometric remove / debt-baseline save check the response and toast; updateInvestment and goal updateAmount use parseAmountInput and refuse non-numbers; goal unlink uses writeOk.
WD-7 | dashboard.ejs, accounts.ejs | "Auto-detect from the file" is the first, default option; csvFormData appends institution / account_label only when chosen or typed. The Accounts form is two-step: Preview (/api/import-csv/preview: format, account, new / already-imported / skipped) → "Import N new"; any input change resets to Preview.
WD-8 | accounts.ejs | prebuildPlaidHandler, linkPlaidTransactions, _plaidHandler state and the 800ms timer deleted; buildPlaidHandler kept for handlePlaidOAuthReturn.
WD-9 | goals.ejs | Toggle reads getComputedStyle; aria-expanded/aria-controls; focuses the first field on open.
WD-11 | accounts.ejs | "Loan (auto, personal, student)" type option; balance label notes "amount still owed".
WD-13 | settings.ejs | response.transports = attestation.response.getTransports() when available.
WD-15 | account-history.ejs | Labels String(snapshot_date).slice(0,10); balances parseFloat'd; isDebt (credit/loan) from the title load (run before history) flips colours and relabels cards "Owed now" / "Owed at range start" / "Change in debt"; < 2 points resets every card and destroys the chart; the empty message is set each time.
IF-1 | perfin-shared.js + all modal pages, nav.ejs | openDialog(box, {label|labelledBy, onClose, initialFocus, restoreFocus}) → handle.close(); one capture-phase keydown handler: topmost dialog only, auto-release when removed/hidden, Esc → onClose, Tab/Shift+Tab wrap. watchDialog(overlay, opts) opens/closes via a MutationObserver on style/hidden/class. Wired: dashboard Quick-add + CSV, housing Pay, calendar Add Bill, transactions Cash (watchDialog), Split + Edit (openDialog; edit's four removeChild sites → closeEdit), notification panel (openDialog with restoreFocus:false; bell focus kept).
IF-2 | calendar.ejs | Payable events render as <button type="button" class="cal-event"> with aria-pressed and a descriptive aria-label; non-payable stay divs; "+N more" is a button (aria-expanded) toggling expandedDays and re-rendering from the cached response (renderGrid split out of loadCalendar); button chrome reset in CSS.
IF-3 | transactions.ejs/js, dashboard.ejs, housing.ejs, accounts.ejs, goals.ejs, calendar.ejs, budgets.ejs | label for= added where a visible label existed (34 by script + manual); aria-label on range inputs, select-all/header/row checkboxes, bulk select, split rows, Edit modal fields, APR/limit/payment, review-queue selects, Quick-add/CSV/credit-score/flow inputs, housing hz-lbl fields and utility rows, calendar Add Bill, budget suggestions.
IF-4 | perfin-shared.css | --card (surface-2), --card-border (border), --bg-elevated (surface-solid), --text-primary, --text-secondary, --accent (teal) defined on :root (light inherits the aliases).
IF-5 | perfin-shared.css, dashboard/housing/calendar.ejs, accounts.ejs, transactions.ejs | --on-teal (#000 dark / #fff light) replaces color:#000 on solid-teal buttons; `select option` and `.actions select option` use --surface-solid; dashboard modal boxes, the transactions .modal and the calendar dialog card are opaque (--surface-solid).
IF-6 | shell/views/login.ejs | MAX_PIN 64 (dots stay an 8-wide mask); Enter is ignored by the pad when another button/link/field outside the pad has focus; Ctrl/Meta/Alt combos ignored.
IF-7 | nav.ejs | Rows carry data-url when n.data.url is a same-app path (/^\/(?!\/)/); activating marks read then navigates via withBase(url); aria-label says "activate to open".

TEST RESULTS: passed. npm test 1602/1602 (Perfin 1025 + Per-sistant 577; 64 files). New tests/scan-sept-batch13.test.js (30 tests; 29 fail on the pre-fix code — the exception is a server-route guard that already held). The pyramid tests run the real PYRAMID_MODES block against canned responses; writeOk/parseAmountInput are extracted and run; the shared-split route runs over a mock pool; IF-3/IF-4 are repo scans (unlabeled controls; undefined var(--x)). Browser (Playwright, temporary spec): 10 Perfin pages load with no page/CSP errors; the Quick-add dialog has role/aria-modal, Tab stays inside over 12 presses, Esc closes and focus returns to its button; light theme gives white text on the teal button; "+ Add Goal" opens on one click; Accounts CSV defaults to Auto-detect, a Chase checking file previews as chase_checking / "Chase Checking Account" / "Import 2 new" and imports 2; the loan option exists; the PIN pad takes 10 digits. Standard e2e 8/8.
REGRESSION RISKS:
- Debt Payoff now includes loans; an existing baseline below the new total is raised automatically (progress restarts from today's debt). A user-entered baseline below current debt is also raised on the next view.
- PATCH /api/accounts/:id/shared 400s a non-integer share (e.g. 50.5) that used to be truncated; the UI only sends integers.
- Pyramid Net Worth shows "appears after the next balance sync" until the first net_worth_snapshots row exists (written hourly and by every balance sync).
- Clicking a notification that has a link now navigates (it only marked read before).
- Removing the Plaid pre-build: the in-page Link modal path no longer exists; "Link via Plaid" (hosted) was already the only bound entry point, and the OAuth return path is kept.
- The dialog helper's capture-phase keydown handles Esc for the topmost dialog; pages' own Esc handlers become no-ops for those modals (they check visibility).
INVARIANTS AT RISK: None violated. INV-61 (apiFetch unchanged; writeOk only reads the Response), INV-23 (no SW change), INV-25 (no auth change), INV-07/48 (no aggregation changed; the pyramid now reads server figures), INV-60 (logout untouched). CSP: no new inline <style>/<script>; all added script code is inside existing nonced blocks or static files. Candidates: every page write reports its outcome via writeOk; modals go through openDialog/watchDialog; no undefined CSS variable (scan).
NET SCORE: 9 − 0 = 9 (production: WD-4 (pyramid modes every view), WD-5 (net worth/debt with a loan + brokerage), WUI-6 (any failed write), WD-7 (any CSV upload without touching the dropdown), WD-8 (a link token minted on every Accounts visit), WD-9 (every Add Goal), WD-15 (labels/colours on every debt history view), IF-4 (Settle Up cards/feedback textarea), IF-5 (light theme); not this month: WD-11, WD-12, WD-13, IF-1/2/3 (keyboard/screen-reader use), IF-6 (PIN > 8 digits), IF-7 (behaviour gap rather than a defect))

OPERATOR ACTIONS / DEPLOY:
- None required (no schema or env changes). | BLOCKS DEPLOY: N
Deploy: Platform, Shell & Auth: Render auto-deploys on push to `main` (the Web UI and shell login ship in the same service).

(Not complete in production until blocking operator actions are done AND
the deploy step is confirmed.)

FOLLOW-ON ITEMS:
- The Spending Health "Savings" tier is really "share of spending outside the named buckets" (other/uncategorized count as savings) — the formula predates this batch; out of scope.
- Settings page inputs were not part of IF-3's list and were not audited for labels; the IF-3 scan test covers transactions/housing/accounts/goals/budgets/calendar only.
- Other un-checked writes may remain on pages outside the listed findings (e.g. subscriptions/budgets actions); writeOk is available for a sweep.
- The calendar paid toggle re-renders the grid, so keyboard focus returns to the page start after toggling (no focus restore to the same event).
DOCUMENTATION UPDATES NEEDED:
- CLAUDE.md: UI & UX — shared writeOk/parseAmountInput and openDialog/watchDialog (perfin-shared.js) as the conventions for writes and modals; CSV import (Auto-detect default, Accounts preview flow); pyramid modes (server net worth, loans in Debt Payoff, baseline high-water mark); /api/accounts/:id/shared validation; manual loan from the UI; account-history debt display; calendar keyboard access; --on-teal and the defined token aliases; PIN pad > 8 digits; notification click navigation; WebAuthn transports now stored; test counts 1602/64 (Perfin 1025) + batch13 description; possible invariants for the candidates above.
- README.md: counts 1602/64 + Batch 13 coverage.
---END BROAD SCAN IMPLEMENTATION SUMMARY---
