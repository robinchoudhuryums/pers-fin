---BROAD SCAN IMPLEMENTATION SUMMARY---
Findings implemented: Design pass D1 (`.cycle/plan-design-ux.md`) — the bugs on screen:
- items 1–2: the dashboard Review Uncategorized widget's raw ISO timestamps and risky defaults;
- item 3: the top nav breaking on narrow pages;
- item 4: `fmt()` printing negatives as "$-X";
- items 5–6: Per-sistant's missing Job Radar icon and its stat tiles coloured by tile;
- item 7: the legacy attachment copy running before the migrations on a fresh database.
New capabilities (G/ST): None
Files modified:
- teller/views/dashboard.ejs
- teller/public/perfin-shared.js
- teller/public/perfin-shared.css
- teller/views/budgets.ejs
- teller/views/goals.ejs
- teller/views/accounts.ejs
- teller/views/tax.ejs
- teller/views/settings.ejs
- teller/views/calendar.ejs
- teller/views/transactions.ejs
- teller/views/account-history.ejs
- teller/views/login.ejs
- apps/per-sistant/views.js
- apps/per-sistant/pages/dashboard-script.js
- apps/per-sistant/views/css-pages.js
- apps/per-sistant/routes/attachments.js
- apps/per-sistant/server.js
- tests/design-d1.test.js (new)
- apps/per-sistant/tests/design-d1.test.js (new)
- tests/roadmap-t2-2-cash-l1.test.js
- tests/cycle-fixes.test.js
- e2e/pages.spec.js
- CLAUDE.md
- apps/per-sistant/CLAUDE.md
- README.md
- .cycle/plan-design-ux.md
- .cycle/STATE.md

CHANGES:
D1-1/2 | teller/views/dashboard.ejs | `renderReviewQueue`:
  - the date goes through `fmtDate` ("Oct 24", a calendar day under any timezone) instead of `esc(t.date)` (the raw "2026-10-24T00:00:00.000Z");
  - a row with no `suggested_category` starts on a disabled "Choose a category" option, its Apply is `disabled` until one is picked (a delegated `change` handler enables it) and "Remember" starts unticked;
  - a row with a suggestion selects it and ticks Remember;
  - a suggestion outside REVIEW_CATEGORIES is offered as an option instead of silently falling back to the first category;
  - Apply returns without a value;
  - a disabled Apply is styled as disabled (opacity 0.4, not-allowed) — its own style is inline.
D1-3 | teller/public/perfin-shared.css + 9 page views + login.ejs | `.container` (which holds the top nav) is one width everywhere (1060px). Each page's width moved from `.container { max-width }` to `#main-content { max-width }`:
  - default 960;
  - Accounts 640, Budgets / Goals 720, Tax 820, Settings 860 (100% ≤640px), Calendar 960, Account History 980, Dashboard / Activity 1060.
  Login (no nav) keeps 960 on its container. This replaces the plan's "nav shell outside the container" (same result, much smaller change). The nav now renders identically on every page.
D1-4 | teller/public/perfin-shared.js | `fmt()` rounds to cents first, then writes "-$24.29" for a negative and "$0.00" (never "-$0.00") for a value that rounds to zero; thousands separators as before.
D1-4 | teller/views/dashboard.ejs, teller/views/goals.ejs | The two hand-built money strings that could go negative now follow the same sign rule:
  - the investment return (`sign + fmt(total_return)` — was "$+12.00" / "$-12.00", now "+$12.00" / "-$12.00");
  - the Goals FIRE card's `fmtMoney` (net worth / savings below 0 read "$-1,234").
  The other `'$' +` concatenations take non-negative values or already handle the sign.
D1-5 | apps/per-sistant/views.js | A `case 'jobs'` icon (a briefcase) in `navIcon` — the only sidebar entry without one.
D1-6 | apps/per-sistant/pages/dashboard-script.js, views/css-pages.js | `statTileClass(kind, value)` / `statTiles(stats)`:
  - a tile is red only for urgent / overdue work that exists, green only for completed work, plain otherwise and at 0;
  - a missing count shows 0, not "undefined";
  - `.top-cards` is two columns (smaller padding and value) at ≤480px — it was one per row, ~1000px of tiles before the first task.
D1-7 | apps/per-sistant/routes/attachments.js, apps/per-sistant/server.js | `migrateDiskAttachments` moved from the router factory (it ran when the router was BUILT, before `runMigrations` created the table) to `start()`, right after `await runMigrations()`, still fail-soft and not awaited. A fresh database (CI, e2e, a VPS rehearsal) no longer logs "attachment migrate error: relation "attachments" does not exist", which the error log turned into the dashboard's "1 server error" strip.
D1 | tests/design-d1.test.js (16) + apps/per-sistant/tests/design-d1.test.js (7) | Real code in a vm:
  - `fmt` (-$X, separators, never -$0.00);
  - the investment-return line and the Goals `fmtMoney`;
  - `renderReviewQueue` (a calendar date under TZ=America/Los_Angeles, the placeholder + disabled Apply + unticked Remember, a suggestion selected + ticked, an unlisted suggestion offered once, the change handler, the disabled style, Apply's guard);
  - the page-width rule (one `.container` width, no nav page sets its own, the narrow pages on `#main-content`, nav before `<main>`);
  - every Per-sistant sidebar entry has an svg icon;
  - `statTileClass` / `statTiles`, the two-column phone grid;
  - the attachments router factory making no query;
  - `start()` copying only after `runMigrations`.
D1 | tests/roadmap-t2-2-cash-l1.test.js | Its fmt was a stub of the OLD shape and pinned "$-50.00". It now runs the real `fmt` sliced from perfin-shared.js and expects "-$50.00".
D1 | tests/cycle-fixes.test.js | The "fmt uses toLocaleString" source pin matched the old one-line body; it now checks the new body for the separators and no toFixed (behaviour in design-d1).
D1 | e2e/pages.spec.js | Two targeted tests:
  - the top nav is one row (logo and bell on one line) with the same box on Dashboard, Budgets, Accounts, Settings and Tax at 1280px;
  - no "attachment migrate" entry in `/perfin/api/errors` after the fresh boot + seed.

TEST RESULTS:
- npm test 2393/2393 (23 new).
- Contract 249/249.
- Playwright 68/68 (2 new).
  - The first run failed twice. (a) My nav-height threshold was too tight: one row is exactly 80px (20px padding around a 40px row), so the test now checks the logo and bell share a line, height ≤90, equal boxes. (b) A knock-on re-seed 409 after that failure restarted the worker.
- Mutation checks 19/19 caught (unit) + 1/1 (e2e: Budgets back on `.container { max-width: 720px }` fails the nav test, the bell 66px below the logo).
- Screenshots after the batch (1280 / 390, both apps) confirm:
  - the one-row Budgets nav;
  - "Oct 24" dates and "Choose a category" in the review widget;
  - "-$346.59" in Cash Flow;
  - plain zero tiles two to a row on Per-sistant's phone dashboard.
REGRESSION RISKS:
- `fmt()` output for negatives changed shape everywhere it's used (68 call sites). Every caller that prefixes a sign passes a non-negative value (checked: settings.ejs 1871, dashboard 972), so nothing double-signs. Any external consumer screen-scraping "$-" would differ (none known).
- Page content widths are unchanged, but `.container` is now 1060px on every page. Anything inside `.container` and outside `<main>` (the top nav; the fixed bottom bar, notification panel, overlays and toasts don't depend on it) is wider on the narrow pages. That's the intent.
- The review widget no longer pre-selects a category, so applying an unsuggested row takes one more click.
- On a deployment that still has legacy disk attachments, the copy now runs at `start()` rather than at module load. It is still not awaited, so boot timing is unchanged.
INVARIANTS AT RISK: None.
- INV-61 / INV-89: writes are unchanged — Apply still goes through writeOk.
- INV-90: `var(--x)` usages unchanged; the IF-3 label scan passes (the select keeps its aria-label).
- INV-95: source guards pass.
- INV-97: no regex in the Per-sistant template modules.
- INV-129: no hand-rolled pending toggle.
- INV-17 / INV-28: migrations are untouched; the copy runs after them.
- INV-118: attachments are still stored in Postgres; only the legacy copy's timing moved.
NET SCORE: 7 production fixes − 0 new failure modes = 7
  (a) Would it have fired in production this month?
  - YES: the review timestamps, the review defaults, the nav on Budgets / Goals / Accounts / Tax / Settings, "$-X" in cash flow / FIRE / investment returns, the Job Radar icon, the tile colours / phone grid.
  - NO in production (the table exists there), YES on every fresh database: the attachment copy.
  (b) New failure modes: none found.

OPERATOR ACTIONS / DEPLOY:
- None. | BLOCKS DEPLOY: N
Deploy: Render auto-deploys on push to `main` (Web UI / Per-sistant ship with the main deploy); no Apps Script change.

(Not complete in production until blocking operator actions are done AND
the deploy step is confirmed.)

FOLLOW-ON ITEMS:
- The review widget's Corner Cafe row shows the provider hint "[food & dining]" but no `suggested_category`. The server-side mapping (`/api/categorize/review-queue` → `mapCategoryFor`) apparently doesn't map Teller's "food & dining" for a CSV row; a server gap, not D1's.
- The review widget's Apply / select styles are inline (the disabled rule had to target it by attribute). D2's button classes should replace them.
- Two dashboard money strings still skip `fmt` for non-negative values (debt / baseline in whole dollars). They're correct, but D2's money pass can fold them in.
- Per-sistant's sidebar "bug" from the review was a screenshot artefact (fixed sidebar, 100vh) — dropped, as the plan says.

DOCUMENTATION UPDATES NEEDED:
- None (done in this batch):
  - CLAUDE.md: the Review widget defaults, the money formatting rule, a "Page width" note, test counts, the e2e description;
  - Per-sistant CLAUDE.md: the dashboard tiles, the attachment copy after migrations, the test file and count;
  - README: count;
  - plan: D1 DONE.
---END BROAD SCAN IMPLEMENTATION SUMMARY---
