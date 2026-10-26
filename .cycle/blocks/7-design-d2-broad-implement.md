---BROAD SCAN IMPLEMENTATION SUMMARY---
Findings implemented: Design pass D2 (`.cycle/plan-design-ux.md`) — the Perfin foundation:
- items 10 / 14 (decisions 10–11): buttons in sentence case with a filled primary; one pair of money colours;
- item 13 (decision 12): an `emptyState()` helper, with each listed Perfin empty state moved onto it.
New capabilities (G/ST): None
Files modified:
- teller/public/perfin-shared.css
- teller/public/perfin-shared.js
- teller/public/transactions.js
- teller/views/dashboard.ejs
- teller/views/accounts.ejs
- teller/views/budgets.ejs
- teller/views/calendar.ejs
- teller/views/goals.ejs
- teller/views/housing.ejs
- teller/views/login.ejs
- teller/views/settings.ejs
- teller/views/subscriptions.ejs
- teller/views/transactions.ejs
- tests/design-d2.test.js (new)
- tests/design-d1.test.js
- tests/roadmap-t2-2-cash-l1.test.js
- tests/scan-oct-batch10.test.js
- tests/scan-sept-batch15.test.js
- CLAUDE.md
- README.md
- .cycle/plan-design-ux.md
- .cycle/STATE.md

CHANGES:
D2-buttons | teller/public/perfin-shared.css, accounts.ejs, login.ejs, dashboard.ejs | No `text-transform: uppercase` on any Perfin button rule:
  - `.btn`, `.btn-sm`, `.actions button`;
  - the Accounts page's `button` and `.btn-unlink`;
  - the standalone login's submit and Face ID buttons;
  - the dashboard pyramid mode buttons.
  Section labels keep their small caps.
  - `.btn.primary`, `.btn-sm.primary` and `.actions button.primary` are FILLED gold with a new `--on-warm` ink (#1a1206, defined for both themes — white on the light-theme gold was ~3.7:1).
  - One dimmed disabled rule covers `.btn`, `.btn-sm` and `.actions button`.
  - `.btn.danger` is unchanged.
D2-labels | 10 Perfin views + their `btnLoading` restores | No label was written in caps in the markup ("+ Add cash transaction" was caps only through the CSS). 32 Title Case labels were rewritten in sentence case: "Sync transactions", "Register this device", "+ Add goal", "Net worth" and others. Proper nouns are kept (Plaid, AI). The labels the JS restores after loading follow suit: "Save bill", "Edit split", "Mark shared".
D2-review | teller/views/dashboard.ejs | The D1 follow-on: the Review widget's Apply button uses `class="btn-sm primary"` instead of inline styles. The page-local disabled rule is gone; the shared one covers it.
D2-money | perfin-shared.css + dashboard / transactions.js / calendar / housing / accounts | Decision 11. `.amt-in` (green) and `.amt-bad` (red) are the one pair of money classes.
  - Activity: a charge is the default colour; a credit reads "+$X" in green. The page's gold-debit / green-credit CSS is removed.
  - Dashboard: the Monthly Spending, Category, Top Merchants and Upcoming Charges tables, the forecast, the spend / subscriptions / YoY value cards and the savings-rate spending column lose their gold or teal. The forecast now goes through `fmt`.
  - Dashboard, savings rate: income and a positive saved figure are green; a negative saved figure is red.
  - Dashboard, cash flow: red only for a balance below $0 (`badIf`) — the weekly Bills column is no longer red.
  - Dashboard, Upcoming Bills widget: income green, a bill plain, both through `fmt`.
  - Dashboard, Net Balance: plain, red when negative.
  - Account cards: a debt reads "-$X owed" in the default colour. Red only for an overdrawn cash account; positive balances are no longer green.
  - Accounts page manual list: the same rule — owed is no longer red.
  - Calendar: a bill is a neutral chip (it was red), income green, net flow green / red.
  - Rent page: an unpaid item turns red once it is past its due day (`isOverdue`, browser-local date). The utility trend's % is muted instead of gold / green.
D2-empty | perfin-shared.js / .css, dashboard, goals, budgets, subscriptions, settings | `emptyState({ title, text, action })`:
  - everything is escaped;
  - `action { label, href }` becomes a link through `withBase`, only for a same-app path (never `//host` or `javascript:`);
  - `action { label, click: <button id> }` renders a button that a delegated document handler turns into a click on the page's EXISTING button, so no new write path exists.
  Applied to:
  - Upcoming Bills → "+ Add bill" (the Quick Add button);
  - AI Insights → "Generate in Settings" (`/settings#ai-insights` — a new `id` on that section);
  - Goals → "+ Add goal" and Budgets → "+ Add budget" (their form toggles; another month's empty budget list has no action);
  - Subscriptions → "Run detection".
  The Monthly Spend and Avg Daily cards read "Not yet" / "after your first full month" instead of "--" / "no complete month yet". On the first screenshot pass, "After 1 month" wrapped onto two lines at stat-card size.
D2-tests | tests/design-d2.test.js (20) | Real code in a vm:
  - `emptyState` (escaping, the href through withBase standalone and under /perfin, only same-app paths linked, no control without an action or label) and `emptyStateClick` (presses the named button, ignores a missing one);
  - each empty state's action, and the anchor it links to;
  - no uppercase on the button rules (incl. Accounts and the pyramid);
  - the filled primary and `--on-warm` in both themes, and the disabled rule;
  - a scan for Title Case or caps button labels in every Perfin view and public script;
  - the Activity row renderer sliced from transactions.js (a charge plain, a credit "+$12.50" green);
  - the dashboard / Accounts / Calendar money classes and `badIf`;
  - the Rent page's `isOverdue` (an earlier month, past the due day, due today not overdue, next month).
D2-tests | tests/design-d1.test.js | The Review Apply pins moved to the class markup. The "disabled Apply looks disabled" pin now reads the shared CSS rule.
D2-tests | tests/roadmap-t2-2-cash-l1.test.js | The Lowest projected pin was `style="color:var(--red)"` / `var(--warm)`. It is now `class="amt-bad"` for a negative and a plain `<strong>` for a positive.
D2-tests | tests/scan-oct-batch10.test.js | The F105 title no longer says "in red". The assertion (`isDebt` covers loans) is unchanged.
D2-tests | tests/scan-sept-batch15.test.js | The mount-base guard skips a line holding an `emptyState` href action (`action: { label: …, href: '/…' }`), since the helper joins withBase itself. A mutation widening that exemption to any `href` is caught.

TEST RESULTS:
- npm test 2413/2413 (20 new). The first full run had 2 failures, both old pins of the changed markup (the cash-flow colour and the mount-base guard on the new href action), updated as above.
- Contract suite not re-run: no server, SQL or route change.
- Playwright 68/68 (full run).
  - Three small edits came after the full run: the pyramid buttons' uppercase, the "Not yet" text and a test pin. They are CSS or text only; the dashboard tests were re-run, 3/3.
- Mutation checks 18/18 caught:
  - the uppercase back on .btn; an outlined primary; `--on-warm` missing in light;
  - a Title Case label;
  - a credit without green or without "+"; every negative balance red again; `badIf` at 0;
  - overdue on the due day; overdue never for an earlier month;
  - a red calendar bill;
  - an unescaped empty-state title; an href without withBase; any href linked; a click action that does nothing; the bills empty state without its action; the Settings anchor removed;
  - the guard exemption widened.
- Screenshots, after vs. D1's set (1280 and 390, both apps), show:
  - "Sync transactions" filled gold, its siblings outlined;
  - the Search button filled;
  - Activity "$12.50" plain and "+$2,000.00" / "+$16.00" green;
  - the Calendar's Rent chip neutral;
  - account cards plain.
REGRESSION RISKS:
- Every Perfin `.btn.primary` is now filled — about 30 buttons across Settings, Budgets, Goals, Tax, Subscriptions and the dashboard. Settings has one per row, so a page of filled buttons is heavier. That follows decision 10; D3 / D5 can demote secondary actions.
- Button label text changed case. No test, e2e selector or server code matched the old labels (checked). The e2e destructive-label filter is case-insensitive. An external script that clicks by exact text would differ (none known).
- The dashboard account grid no longer colours positive balances green. That is intended (decision 11), but it is a visible change.
- The Rent page's overdue red uses the browser's date, as the page's other defaults do. Near midnight in another timezone it can show a day early or late.
- The Calendar's Net Cash Flow stays green / red. A month whose bills exceed its income is shown as "wrong".
- `emptyState`'s document-level click listener is installed on every Perfin page. It only acts on `[data-empty-click]`.
INVARIANTS AT RISK: None.
- INV-89 (writes report outcomes): no write path changed. The empty-state buttons click existing buttons whose handlers already go through writeOk.
- INV-90 (dialogs / `var(--x)` defined): `--on-warm` is defined in both themes; the var guard and the IF-3 label scan pass (no new form controls).
- INV-95 (guards only shrink): one exemption was added to the mount-base guard, scoped to the emptyState action shape and mutation-checked; KNOWN_GAPS is untouched.
- INV-23 / INV-61: untouched.
- INV-116: DASHBOARD_WIDGETS is unchanged.
NET SCORE: 6 production fixes − 0 new failure modes = 6
  (a) Would it have fired in production this month? YES, for all six, on every load:
  - all-caps buttons;
  - outlined "primary" buttons indistinguishable from the rest;
  - gold charges and red bills read as warnings;
  - debts in red;
  - bare "nothing here" empty states;
  - "--" Monthly Spend.
  (b) New failure modes: none found.

OPERATOR ACTIONS / DEPLOY:
- None. | BLOCKS DEPLOY: N
Deploy: Render auto-deploys on push to `main` (Web UI ships with the main deploy); no Apps Script change.

(Not complete in production until blocking operator actions are done AND
the deploy step is confirmed.)

FOLLOW-ON ITEMS:
- Many inline-styled buttons keep their own colours and don't use the shared classes:
  - the Rent page's teal "Record payment" and Scan / 📷 / Set;
  - the dashboard's teal "+ Add bill" and "Save bill";
  - the account cards' "Update balance" / "Mark shared";
  - the Accounts page's gold-outlined `button` rule.
  They are sentence case now but don't follow decision 10's filled-primary / outlined split. D3 / D5 (page-level polish) can move them onto `.btn` classes.
- The Settle Up widget still colours its amounts teal / gold by party, not by in / out. Its semantics ("you send" vs "partner sends") need a design call before decision 11 applies.
- The YoY card keeps green for a decrease and red for an increase in spending. Spending more than last year isn't "wrong" under decision 11, but the arrow reads as a trend. Left for the dashboard pass.
- The savings-rate % keeps its green / yellow / gold / red scale. Gold is used there as a level, not as money.
- JS-built button labels (`'Edit split'` etc.) aren't covered by the Title Case scan, which reads static `<button>…</button>` text only.
DOCUMENTATION UPDATES NEEDED:
- None (done in this batch):
  - CLAUDE.md: the shared CSS / JS entries (`--on-warm`, `.amt-*`, `emptyState`), the loan display, new "Money colours", "Buttons" and "Empty states" UI bullets, the test file entry and counts;
  - README: count;
  - plan: D2 DONE.
---END BROAD SCAN IMPLEMENTATION SUMMARY---
