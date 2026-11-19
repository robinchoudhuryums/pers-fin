---BROAD SCAN IMPLEMENTATION SUMMARY---
Findings implemented:
- F73 — Settle Up treated a failed request as $0 and still offered "Mark settled"; the Accounts net total dropped investments the same way
- F74 — editing a card's limit and tabbing to APR re-rendered the accounts grid and wiped the half-typed field
- F75 — the `hidden` attribute was overridden by the element's own `display` rule (a failed summary left skeleton cards pulsing; the generic-CSV sign select showed for every file)
- F76 — the Perfin entry overlay had no back / forward-cache handler
- F77 — missing `res.ok` checks and unhandled rejections: Upcoming Charges "undefined charges", Resolve stuck disabled after a network error, "Link account" doing nothing
- F78 — double-submit windows: Enter on Ask sent a second paid call; a Quick Add Bill double tap inserted two bills
- F79 — smaller items: light-theme row separators invisible; the account-history range select unlabeled; Per-sistant controls with an unassociated label; Per-sistant modals not trapping Tab; Per-sistant list pages showing "No notes yet" on a 500; money written without `fmt()`; "Enable push" spinning forever with no registered worker
New capabilities (G/ST): None
Files modified:
- teller/views/dashboard.ejs, settings.ejs, goals.ejs, budgets.ejs, accounts.ejs, account-history.ejs
- teller/public/perfin-shared.css, teller/public/transactions.js
- shell/public/perfin-materialize.js
- apps/per-sistant/views/js.js
- apps/per-sistant/pages/notes.js, emails.js, contacts.js, todos-script-1.js
- tests: tests/cycle9-b9.test.js (new, 29), apps/per-sistant/tests/cycle9-b9.test.js (new, 13), e2e/pages.spec.js (1 new test), tests/design-d2.test.js (one pin)
- .cycle/STATE.md, .cycle/blocks/9-batch9-broad-implement.md

CHANGES:
F73 | teller/views/dashboard.ejs | Settle Up: each of its three requests goes through `settleLeg` → `{ ok, data }`; `settleLoadState` names what failed. With a money leg missing the headline reads "Net not available" (never the other leg alone), there is no Mark settled / Undo, and a "Try again" button reloads; when only the settled / not-settled read failed the net still shows, without the button. A widget that was never shown stays hidden on a failed first load. Accounts grid: a failed `/api/investment-accounts` request lists what loaded, adds "Investment accounts couldn't be loaded, so the net balance isn't shown", and the Net Balance card shows "—" with a title (`setNetBalance`, `accountsInvFailedHtml`).
F74 | teller/views/dashboard.ejs | The limit / APR / payment saves go through `saveAccountField`; the grid reload (`reloadAccountsSoon`) waits while a save is in flight or a grid input has focus and runs once focus leaves (a `focusout` listener). The sync, manual-balance and shared-split reloads use it too.
F75 | teller/public/perfin-shared.css | `[hidden] { display: none !important; }` — one rule for every Perfin page.
F76 | shell/public/perfin-materialize.js | A `pageshow` listener removes the overlay's `active` class when the page is restored from the back / forward cache (`ev.persisted`).
F77 | teller/views/dashboard.ejs, settings.ejs, goals.ejs | `loadForecast` returns on a non-OK answer or a body without a charge count; the Recent errors Resolve handler catches a rejected request (message + button re-enabled); `linkAccount` checks the funding-options answer through `writeOk` and tolerates missing lists.
F78 | teller/views/dashboard.ejs | Ask keeps an `asking` flag (Enter and the button share it); Quick Add Bill keeps `qabSaving` and leaves Save disabled after a success until the page reloads (a refused save re-enables it).
F79 | teller/public/perfin-shared.css, teller/views/account-history.ejs, budgets.ejs, accounts.ejs, settings.ejs, teller/public/transactions.js, apps/per-sistant/views/js.js, apps/per-sistant/pages/notes.js, emails.js, contacts.js, todos-script-1.js | Perfin: `[data-theme="light"] td` gets a visible separator; `<label for="range-select">`; the Budgets cards and summary, the manual-account list and the split-total line format money with `fmt()`; `pushRegistration()` asks for the registration first and gives `serviceWorker.ready` an 8-second deadline — Enable reports the reason instead of spinning, and the status check leaves the button usable. Per-sistant: `fetchList(url)` (the array, or null on any failure) + `loadFailedHtml(what)`, used by the Notes, Emails, Contacts and To-Dos loads; `associateLabels(root)` ties a bare label to the input / select / textarea that follows it (at load and when a dialog opens); the shared keydown handler keeps Tab inside the top-most open modal.

TEST RESULTS: passed — `npm test` 3648 / 3648 (191 files; Perfin 2815, Per-sistant 833; 42 new). Contract suite 402 / 402 (no server code changed). Playwright 94 / 94 (1 new — the hidden-attribute check in a real browser; every click sweep passes with the global `[hidden]` rule). The new files under five shifted clocks: 62 / 62 each. Mutation check against the pre-fix source: 29 of 29 Perfin and 12 of 13 Per-sistant tests fail. Regression scenarios: S6 (offline fallback) PASS via e2e; S4 PASS via e2e; S1–S3, S5, SK1–SK5 not applicable (no server, sync, AI, Sheets or Knowledge file changed).
REGRESSION RISKS:
- F74: while a field in the accounts grid has focus, the grid isn't re-rendered — after a sync it keeps showing the earlier figures until focus leaves the field.
- F75: `[hidden]` now always wins. Anything that relied on being visible despite a `hidden` attribute would disappear; the e2e sweeps of every Perfin page found none.
- F73: when the settled / not-settled read fails, "Mark settled" isn't offered until "Try again" succeeds.
- F79: the Budgets summary shows cents (it was whole dollars); a Per-sistant modal with no visible control swallows Tab while it is open.
INVARIANTS AT RISK: None. INV-89 (writes report their outcome) and INV-148 (money through `fmt`) are extended; INV-90 (dialogs) is untouched on Perfin and Per-sistant's dialogs gain the Tab trap; INV-97 (no single-escaped regex / backslash in Per-sistant client template literals) and INV-129 (no hand-rolled pending toggle in Per-sistant pages) pass their guards; INV-130 (the e2e page run) holds — the new test routes one request to a 500 on purpose and doesn't use the page-problem watcher for that page.
NET SCORE: 2 − 1 = +1 (F75's sign select showed on every Accounts page load; F79's unassociated labels, raw money strings and light-theme separators were present on every load. New failure mode: F74's deferred re-render can show earlier figures while a grid field has focus.)

OPERATOR ACTIONS / DEPLOY:
- None
Deploy: Render auto-deploys on push to `main` (this work is on `claude/gracious-maxwell-li0vm7`; no PR opened).

(Not complete in production until blocking operator actions are done AND
the deploy step is confirmed.)

FOLLOW-ON ITEMS:
- F76 was not reproduced in the scan and can't be exercised here (it needs Safari's back / forward cache) — try Back from Perfin on an iPhone once.
- Settle Up: a failed FIRST load of a widget that was hidden stays hidden with nothing said (it can't tell "nothing to settle" from "couldn't ask").
- F74 covers the dashboard grid only; the Accounts page's lists still re-render after each save.
- F79 leftovers: whole-dollar money on the Calendar chips and the pyramid, and the AI cost line's three decimals, are still built by hand (deliberate formats); the dashboard keeps its own `fmtMoney` beside `fmt`; `associateLabels` handles a label directly followed by its control — a label followed by a wrapper element stays unassociated; Per-sistant's Health, Jobs, Knowledge and dashboard loads still read a failed request as empty; a service worker that fails to register is only reported when Enable is pressed.
- The Accounts net total is also "—" when no account has a balance yet (unchanged), with no tooltip.

DOCUMENTATION UPDATES NEEDED:
- CLAUDE.md: the dashboard notes (Settle Up widget, accounts grid / manual limit + APR flow, Ask, Quick Add Bill), perfin-shared.css (`[hidden]`, light separators), perfin-materialize.js (pageshow), Web Push (pushRegistration), the test list (tests/cycle9-b9.test.js), counts (3648 / 191 files, Perfin 2815, Per-sistant 833, Playwright 94), Known Open Issues (Batch 9 done + follow-ons; "Still open" starts at Batch 10).
- apps/per-sistant/CLAUDE.md: `fetchList` / `loadFailedHtml`, `associateLabels`, the modal Tab trap, the new test file and count (833), Known Open Issues.
- README.md: test counts.
---END BROAD SCAN IMPLEMENTATION SUMMARY---
