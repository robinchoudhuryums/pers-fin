---BROAD SCAN IMPLEMENTATION SUMMARY---
Findings implemented: D7 (`.cycle/plan-design-ux.md` — Landing + phone polish + close-out):
- the landing page's status lines (decision 13);
- the phone drawer's Tax link, January–April (decision 14);
- the Activity page's Filters toggle at the button height beside "+ Add cash transaction" (review item 15);
- the pass's docs, including INV-148.
New capabilities (G/ST): None (design-plan batch)
Files modified:
- shell/landing-status.js (new), shell/index.js, shell/views/landing.ejs, shell/public/landing.css
- teller/routes/dashboard-summary.js
- apps/per-sistant/routes/settings.js
- teller/views/partials/nav.ejs, teller/public/perfin-shared.css, teller/views/transactions.ejs
- tests/design-d7.test.js (new), e2e/smoke.spec.js, e2e/pages.spec.js
- CLAUDE.md, README.md, apps/per-sistant/CLAUDE.md, .cycle/plan-design-ux.md, .cycle/STATE.md

CHANGES:
D7 | shell/landing-status.js, shell/index.js, shell/views/landing.ejs, shell/public/landing.css | `landingStatus({ perfinPool, persistentPool, deps, timeoutMs })` → `{ perfin, persistent }`. Each line runs in-process against its wired pool with its own 1.5s budget (Promise.race). A throw or a timeout makes that line null and logs a console.warn (not console.error, so the error log doesn't count it); the function never throws. Perfin's line: "$X owed to <payee> · N bills due this week · N to review", "Nothing needs attention" when every source was read and none has anything, and null when a source failed and nothing was found. Per-sistant's line: "N tasks due today · N overdue", or "Nothing due today". `GET /` (behind requireAuth) awaits it and renders each line, EJS-escaped, under the tile's description with a divider.
D7 | teller/routes/dashboard-summary.js | `gatherDashboardSummary(db, { parts })` reads only the named parts and leaves the others out of the result; without `parts` the output is unchanged. The landing asks for rent / bills / uncategorized only, so it doesn't run the net-worth, budget, cash-forecast or data-health reads. Exported `PARTS`. INV-147: one definition.
D7 | apps/per-sistant/routes/settings.js | New exported `taskDueCounts(pool, today = todayStr())` → `{ due_today, overdue }` over open, untrashed todos; overdue means due before today. `/api/stats` is unchanged (its "overdue" includes today).
D7 | teller/views/partials/nav.ejs, teller/public/perfin-shared.css | `<a id="nav-tax-link" class="nav-tax-link" hidden>Tax</a>` after Rent in the drawer list. The nav script (through whenShared) un-hides it when `taxSeason(localTodayStr()).season`. At ≥641px `.nav-tax-link { display: none }`, so the desktop top nav never shows it. The bottom tab bar keeps five items.
D7 | teller/views/transactions.ejs | "+ Add cash transaction" and the Filters toggle sit in one `.txn-actions` flex row (centred, gap 8px). On a phone both buttons get `min-height: var(--btn-h-touch)` and the toggle's label is centred. Measured at 390px: both 44px tall at the same top. Before, the toggle sat 12.5px lower with its label top-aligned; the inline `margin-bottom:8px` was dropped.
D7 | e2e/smoke.spec.js, e2e/pages.spec.js | The smoke test's `/` check also sees both tiles' `.tile-status`. pages.spec gets a new test: on the seeded run the Perfin line names the rent ("$1,500.00 owed to E2E Landlord"), the Per-sistant line is visible, and there are no page or console errors.
D7 | tests/design-d7.test.js | 16 tests:
  - both lines, each line fail-soft (sync and async throws), a slow read cut off while the other line shows, nothing when both fail, no read without a pool;
  - the `parts` option (only named readers called, other fields absent; every part without it);
  - the `taskDueCounts` SQL and parameters;
  - landing.ejs with lines (escaped), with one line, and with no status; the shell route behind the gate; no fetch in the module;
  - the Tax link run in a vm with the real `taxSeason` (shown Jan–Apr, hidden May–Dec), its markup and the desktop CSS rule;
  - the Filters row and touch-height rules; transactions.ejs rendered through EJS standalone and under /perfin.
D7 | CLAUDE.md, README.md, apps/per-sistant/CLAUDE.md | Docs:
  - Landing page bullet; the Mobile navigation bullet (Tax in the drawer); the Tax package note; the Activity Filters row;
  - shell tree entry for landing-status.js; Platform subsystem list;
  - test counts 2561 / 133 (Perfin 1878) and Playwright 72; the design-d7 test entry; the ci.yml e2e note;
  - INV-148 (tokens parity, `fmt`, money colours, sentence-case buttons, emptyState); INV-147's landing clause;
  - Known Open Issues: the pass's follow-ons gathered from D1–D7;
  - README count + summary line; Per-sistant `/api/stats` note on `taskDueCounts`.

TEST RESULTS: npm test 2561/2561 passed (16 new). Contract suite 253/253 passed. Playwright 72/72 passed (1 new). Mutation checks 9/9 caught:
- no parts passed;
- no timeout;
- a failed source read as "nothing";
- a throw escaping;
- parts ignored;
- season ignored;
- no touch height;
- overdue including today;
- unescaped line.
Final screenshot set, desktop + phone, both apps: the landing lines, the Activity row, and the dashboard / Per-sistant pages unchanged from D6.
REGRESSION RISKS:
- `gatherDashboardSummary`'s default output is unchanged (the D3 tests and contract pass). Only the landing passes `parts`.
- The landing now awaits up to 1.5s per line before rendering, run in parallel, so at most ~1.5s. The landing is no longer the default post-login page, but it is the home-screen app's start_url.
- A slow line's query keeps running after the page renders (it can't be cancelled).
- The Activity page's add-cash button sits 4px further from the list on desktop (row margin 12px instead of 8px).
INVARIANTS AT RISK:
- INV-147: the landing reuses the summary function and re-derives nothing — preserved and extended.
- INV-25: in-process wired pools, no HTTP self-fetch (the test scans for fetch) — preserved.
- INV-77 / INV-133: the landing logs console.warn, which the error log ignores, so a slow line is never a "server error".
- INV-148: new.
None violated.
NET SCORE: 1 production fix (the misaligned Filters toggle, visible on every phone visit to Activity) − 0 new failure modes = 1. The landing lines and the Tax drawer link are planned capability, not fixes.

OPERATOR ACTIONS / DEPLOY:
- None
Deploy:
- Platform, Shell & Auth: Render auto-deploys on push to `main` (configured in the Render dashboard). Alt: `fly deploy`.
- The Sheets & External Export deploy command doesn't apply (no Sheets files touched).

(Not complete in production until blocking operator actions are done AND the deploy step is confirmed.)

FOLLOW-ON ITEMS:
- The landing reads both databases on every visit. A slow line is dropped, not filled in later.
- Per-sistant's `/api/stats` "overdue" still counts a task due today. The landing's `taskDueCounts` splits them; aligning /api/stats would change the dashboard tile's meaning.
- The drawer's Tax link (like the dashboard's tax-season link) follows the browser's date, not APP_TIMEZONE.
- Every open design follow-on from D1–D6 is collected in CLAUDE.md → Known Open Issues:
  - inline-styled buttons;
  - Settle Up / YoY / savings-rate / housing-widget colours;
  - the duplicated Sync Health warning;
  - no test renders every Perfin view through EJS;
  - Per-sistant primary contrast and Title Case selects / modal titles;
  - literal font sizes on the token scale.
- The screenshot run's dashboard shows "1 server error(s) in the last 24 hours". It comes from the sandbox having no network ("Benchmark refresh error: fetch failed"), not from D7; the e2e "no server error after a fresh boot" check runs before any benchmark fetch.

DOCUMENTATION UPDATES NEEDED:
- None (folded in: CLAUDE.md, README.md, apps/per-sistant/CLAUDE.md, STATE, plan)
---END BROAD SCAN IMPLEMENTATION SUMMARY---
