# Design & UX pass — both apps (plan, 2026-10-26)

Goal: fix the design problems found in the 2026-10-26 review and make the two apps read as
one product. The review used screenshots of every main page at 1280px and 390px wide, with
the e2e seed data loaded. The operator agreed with every point; this plan covers all of them.

No server behaviour changes except:
- one new read-only endpoint (D4);
- the landing page's status lines (D7);
- a startup-ordering fix (D1).

No schema change.

## What the review found (checked against the code)

**Bugs visible on screen**

1. **Raw timestamps in the dashboard's Review Uncategorized widget.**
   - Rows read `2026-10-24T00:00:00.000Z · $12.50`.
   - `teller/views/dashboard.ejs` `renderReviewQueue` does `esc(t.date)`. Every other page
     goes through `fmtDate` / `parseCalDate` (WUI-2).

2. **The same widget invites one-click mistakes.**
   - Without a suggestion, the select defaults to `REVIEW_CATEGORIES[0]` ("Food & Drink").
   - "Remember" is `checked` on every row.
   - So pressing Apply on CITY PHARMACY creates an exact rule that files it as Food & Drink
     forever.

3. **The top nav breaks on narrow pages.**
   - The nav lives inside `.container` (opened in `partials/head.ejs`), and each page sets
     its own container width: Accounts 640, Budgets / Goals 720, Tax 820, Settings 860,
     Calendar 960, Dashboard / Activity 1060.
   - The F94 wrap rule is keyed to the viewport (641–960px), not the container. At a full
     desktop width the Budgets nav wraps into three rows: logo, then links, then icons
     scattered.

4. **`fmt()` prints negatives as `$-24.29`.**
   - `perfin-shared.js` does `'$' + parseFloat(n).toLocaleString(…)`.
   - Every negative it formats shows that way: the cash-flow table's 13 weekly balances,
     "Lowest projected" and others.
   - `tests/roadmap-t2-2-cash-l1.test.js` pins the wrong output (`\$-50\.00`).

5. **Per-sistant: Job Radar has no nav icon.**
   - `NAV` in `apps/per-sistant/views.js` lists it, but `navIcon()` has no `case 'jobs'`.

6. **Per-sistant dashboard stat tiles colour by tile, not by value.**
   - `pages/dashboard-script.js` gives "Urgent" `red` always and "Overdue 0" `green`, so a
     zero is orange-red in one tile and green in the next.
   - At ≤480px `.top-cards` is one column (`views/css-pages.js`), so eight 125px tiles fill
     ~1000px before any task.

7. **A fresh database logs a server error at boot.**
   - `routes/attachments.js` runs `migrateDiskAttachments(pool)` when the router is BUILT,
     i.e. before `runMigrations` has created `attachments`.
   - On a new database (CI, the e2e run, a VPS rehearsal) that logs
     `attachment migrate error: relation "attachments" does not exist`.
   - The error log turns it into "1 server error(s) in the last 24 hours" on the dashboard
     strip — the "Sync needs attention" banner in the e2e screenshots.
   - Production isn't affected (the table exists), but it is a startup-ordering bug.

**Not a bug (dropped).** The review said Per-sistant's sidebar background stops at ~900px.
It is `position: fixed; height: 100vh`, so it always fills the window. A full-page
screenshot paints fixed elements once, at the top. That was a screenshot artefact.

**Design**

8. **The Perfin dashboard has no hierarchy.**
   - It is ~5000px tall at 1280px wide, with ~20 sections of equal weight
     (`DASHBOARD_WIDGETS` lists 20 keys).
   - The decorative pyramid takes the first screen, and on a phone it fills the whole of it.
   - There is no answer to "am I OK this month?" at the top.
   - The cash-flow table is 13 rows of mostly `$0.00` income.
   - A one-month trend chart is a lone dot on an empty axis.

9. **Settings is one ~9300px page with 20 sections** (`settings.ejs`: Appearance, Pyramid,
   Install, Security, Biometric, AI Insights, Categorization, API Usage, Push, Cash Alerts,
   Per-sistant Tasks, Keep-Alive, CSV Reminders, Bank Auto-Sync, Sync Health, Sheets,
   Dashboard Widgets, Target Allocation, Watchlist, Data). There is no index.

10. **The two apps look like different products.**
    - Perfin: cool glass, teal / gold, sentence-case labels, top nav.
    - Per-sistant: warm paper, monospace letter-spaced caps (`.section h2`, `.btn`, card
      labels), sidebar.
    - Status colours, radius, type scale and button shapes differ for no reason.

11. **The landing tile picker is bare** — two cards on an empty page. It matters more than
    it looks: the shell manifest's `start_url` is `/`, so a signed-in user opening the
    home-screen app lands on it every time.

12. **Too much is in all caps.**
    - Both apps' `.btn` use `text-transform: uppercase` (perfin-shared.css,
      css-components.js).
    - The primary and secondary buttons are both outlined and look almost identical.

13. **Empty states only say "nothing here".**
    - "No upcoming bills this month."
    - "No insights yet — generate from Settings."
    - "Monthly spend --" with "no complete month yet".
    - "No goals yet. Add one above."
    - "No subscriptions found…"
    - Per-sistant's "No scheduled emails" / "No events on this day".
    - None offers the next step as a button.

14. **Money colours carry two meanings.** Charges render gold (the brand accent), money in
    green — but green also means "on track", and red is used both for debt and for "over".

15. **Phone polish:**
    - the Activity page's Filters toggle (`.btn-sm`) is shorter than the "+ Add cash
      transaction" button beside it;
    - the dashboard pyramid's five mode tabs wrap, leaving "Net Worth" alone on a second line;
    - Rent and Tax have no thumb-reachable home.

## Decisions (to accept with /broad-implement D1)

1. **The sidebar item is dropped** (see "Not a bug" above).

2. **The nav gets its own width.**
   - The top nav renders in a `.nav-shell` at one fixed max width (1060px — the widest page),
     outside the page's `.container`, so every page's nav is identical.
   - Pages keep their own content width.
   - The F94 641–960px wrap rule and the ≤640px hamburger stay as they are.

3. **`fmt()` writes a negative as `-$24.29`.**
   - The hand-built money strings that already handle the sign (dashboard
     `2325` / `2605` …) are left alone.
   - The tests that pinned `$-` are corrected, not loosened.

4. **Review widget defaults.**
   - With no suggestion, the select starts on a disabled "Choose a category" option and
     Apply stays disabled until one is picked.
   - "Remember" starts ticked only when the row HAS a suggestion (the user then confirms a
     known mapping). Otherwise it starts unticked.

5. **The dashboard gets a summary endpoint, not more client fetches.**
   - `GET /api/dashboard/summary` returns:
     - net worth (the latest `net_worth_snapshots` row — getNetWorth — plus its change since
       the first snapshot of the month);
     - this month's spending against the effective budget total (getBudgetStatus);
     - the lowest projected cash day (getCashFlowForecast, 30 days);
     - an `attention` list. Each item is `{ kind, text, href, count }`:
       - bills due in the next 7 days (the forecast + manual bills via the calendar's rule);
       - rent owed (the housing ledger, payee-scoped);
       - uncategorized transactions (the review-queue count);
       - Sync Health warnings (data-health's warning issues);
       - unrated insights is NOT included (noise).
   - Each field is fail-soft (`null` + a fixed sentence); one failing read never 500s the
     route.
   - Every figure comes from the helper the rest of the app uses (INV-147). No new SQL
     re-derives a figure.

6. **Dashboard order and the pyramid.**
   - The new order:
     1. Summary card + Needs-attention list (new);
     2. the sync strip;
     3. Since You Last Looked;
     4. Review Uncategorized;
     5. the two charts;
     6. Accounts;
     7. Cash Flow + Upcoming Bills;
     8. Budgets-related tables (Monthly Spending / Categories / Merchants / Upcoming);
     9. Settle Up, Rent & Utilities, Investments, Savings Rate, YoY;
     10. the pyramid;
     11. Ask Perfin, AI Insights, AI Memory, Credit Score.
   - The pyramid stays on by default but moves below the charts. On ≤640px it starts
     collapsed (the existing `perfin_collapse_<key>` mechanism, so a user who opens it keeps
     it open).
   - `DASHBOARD_WIDGETS` is re-ordered to match the page, so Settings lists the toggles in
     page order.

7. **Long blocks summarise.**
   - Cash Flow shows the projected-low line, then the first 4 weeks, then "Show all 13
     weeks".
   - A `$0.00` cell in its Income / Bills columns renders "—".
   - Savings Rate shows the latest month plus "Show all".
   - With fewer than 3 months of data, a trend chart is replaced by one sentence
     ("Spending trends appear after 3 months of history — N so far").

8. **Settings stays one page, grouped, with an index.**
   - The 20 sections are put under 7 group headings:
     - Appearance & Dashboard;
     - Security;
     - AI;
     - Alerts & Notifications;
     - Sync & Connections (incl. Sync Health);
     - Planning (Target Allocation, Watchlist);
     - Data & Exports.
   - A sticky index on desktop (≥961px, left column) and a "Jump to…" select on narrower
     screens.
   - Sync Health is NOT split onto its own page. Notifications, the dashboard strip and the
     data-health issue links deep-link to `/settings#sync-health`, `#deleted-transactions`,
     `#recent-errors`, `#cash-alerts-section` and `#linked-tasks-section`, and every one of
     those anchors keeps working.

9. **Shared design tokens are a spec plus a parity test, not a shared runtime file.**
   - Perfin serves static CSS; Per-sistant inlines CSS from JS template modules under a
     nonce. A shared runtime stylesheet would mean a new cross-app static route and a CSP
     change in both apps.
   - Instead, `design/tokens.json` lists the SHARED values:
     - the status colours (ok / warn / danger / info, dark and light);
     - the type scale (12 / 13 / 14 / 16 / 20 / 28);
     - spacing (4 / 8 / 12 / 16 / 24 / 32);
     - radius (card, control, pill);
     - button heights (32 / 40 desktop, 44 mobile).
   - Each app declares them under its own variable names. `tests/design-tokens.test.js`
     reads both CSS sources and fails on a mismatch.
   - App-specific values — accent, surfaces, fonts — are listed as `app_specific` and not
     compared. Perfin keeps teal / gold glass; Per-sistant keeps its palettes and paper.

10. **Casing.**
    - Buttons are sentence case in both apps.
    - The small section labels (`.section h2`, card labels) stay small caps — they are
      labels, not actions.
    - Per-sistant's monospace stays for numbers and labels only, not for buttons.
    - `.btn.primary` is FILLED (accent background, `--on-teal` / accent-ink text) in both
      apps; `.btn` is outlined; `.btn.danger` is outlined red.
    - The e2e sweep's destructive-label filter is case-insensitive already, so it is
      unaffected.

11. **Money colours.**
    - A charge renders in the default text colour.
    - Money in renders green.
    - Red is for something wrong: overdue, over budget, a projected balance below $0, a debt
      that rose.
    - Gold stays the brand accent (logo, active nav, primary buttons, focus) and stops
      meaning "a charge".
    - A debt balance keeps its "-$X owed" wording and is NOT red merely for being a debt.
      It is red only when it rose (the DD-6 rule already used by the whats-new widget).

12. **Empty states have a next step.**
    - One helper per app: Perfin `emptyState({ title, text, action: { label, href | onclick-id } })`
      in perfin-shared.js; Per-sistant the same in `views/primitives.js`.
    - Returns escaped markup with an optional `.btn` link or button.
    - Applied to every empty state listed in item 13.
    - An action that writes, e.g. "Generate insights", reuses the existing button's handler
      — no new write paths.

13. **The landing page stays and gets one status line per tile.**
    - Why: it is the home-screen app's first screen.
    - Server-rendered by the shell at request time from the wired pools, read-only, each
      line fail-soft with a 1.5s budget. A failed or slow read leaves the tile with its
      description.
    - Perfin's line: "$X owed to <payee>" and/or "N bills due this week" and/or "N to
      review". It reuses the D4 summary function, required in-process — never an HTTP
      self-fetch (INV-25).
    - Per-sistant's line: "N tasks due today · N overdue" (its `/api/stats` queries, as a
      function).
    - Nothing sensitive beyond what the apps show behind the same gate. The landing is
      behind requireAuth like today.

14. **Tax on phones.**
    - From January to April (`taxSeason`) the hamburger drawer lists "Tax" after "Rent".
    - The bottom tab bar keeps its five items — a sixth makes every target smaller.
    - Rent is already in the drawer.

15. **Pyramid mode tabs on phones** become one horizontally scrollable row (no wrap), with
    the active tab scrolled into view.

## Batches (broad-implement sized)

| # | Batch | Status |
|---|---|---|
| D1 | **Bugs on screen + quick fixes (both apps).**<br>• The Review widget: dates through `fmtDate`; the decision-4 defaults (placeholder option, Apply disabled until chosen, Remember ticked only with a suggestion).<br>• `fmt()` negatives → `-$X` (decision 3); fix the L1 test's pinned `$-50.00`; grep the views for other `'$' +` concatenations of possibly-negative values and route them through `fmt`.<br>• The nav shell (decision 2): `partials/head.ejs` / `partials/nav.ejs` render the nav outside the page container at one width; every Perfin page checked at 1280 / 900 / 390.<br>• Per-sistant: a Job Radar nav icon; dashboard stat tiles neutral at 0 and coloured only for a non-zero value that means something (Urgent / Overdue red, Completed green); `.top-cards` two columns at ≤480px.<br>• Per-sistant: `migrateDiskAttachments` runs after `runMigrations` in `server.js`'s startup, not at router construction (item 7).<br>• Tests:<br>&nbsp;&nbsp;– `renderReviewQueue` in a vm (a DATE rendered as a calendar day under a west-of-UTC TZ, no preselected category, Remember only with a suggestion, Apply disabled until a choice);<br>&nbsp;&nbsp;– `fmt` for −0.5 / −1234.5 / 0 / null;<br>&nbsp;&nbsp;– the nav partial outside `.container` on every page view;<br>&nbsp;&nbsp;– `navIcon('jobs')`;<br>&nbsp;&nbsp;– the stat-tile colour rule in a vm;<br>&nbsp;&nbsp;– the attachments migration not called before migrations (a fake `runMigrations` order check).<br>• Playwright: the existing suite, plus a check that no server error is logged on a fresh boot (the error log is empty after the seed). | DONE (2026-10-26 — block `.cycle/blocks/7-design-d1-broad-implement.md`) |
| D2 | **Perfin foundation: buttons, money colours, empty states.**<br>• `.btn` / `.btn-sm` sentence case; `.btn.primary` filled; `.btn.danger` unchanged; every Perfin button's label read for case — labels written in caps in the markup (e.g. "+ ADD CASH TRANSACTION") rewritten.<br>• Money colours (decision 11) on Activity, the dashboard tables, Subscriptions, Calendar, the Rent page and the Accounts grid; one pair of classes (`.amt-in`, `.amt-bad`) in perfin-shared.css instead of inline colours.<br>• `emptyState()` (decision 12) and each Perfin empty state in item 13 moved onto it.<br>• Tests: `emptyState` in a vm (escaping, action link through `withBase`, no action); a scan that Perfin `.btn` CSS has no uppercase transform; the money-class rule on the Activity row renderer; the IF-3 label scan and the `var(--x)` guard still pass.<br>• Playwright: full run + the screenshot pass (before / after) attached to the block. | DONE (2026-10-26 — block `.cycle/blocks/7-design-d2-broad-implement.md`) |
| D3 | **Perfin dashboard, part 1: the summary.**<br>• `GET /api/dashboard/summary` (decision 5) in a new `routes/dashboard-summary.js`, mounted with the other read routes; each field fail-soft with a fixed sentence.<br>• The Summary card (net worth + change, spent vs effective budget with a bar, lowest projected cash with its date) and the Needs-attention list (each item a link through `withBase`, or "Nothing needs attention" with a quiet tick) at the top of the dashboard; skeletons while loading; a failed load says so in one line and the rest of the page loads.<br>• Tests: the route over a fake pool (every field, each failing read isolated, the attention items' rules and links, no field re-derived — the helpers are spied); the card and list renderers in a vm.<br>• Contract: the summary on real rows agrees with `GET /api/budgets`, `/api/cash-flow` and the latest net-worth snapshot to the cent; bills due in 7 days match `/api/forecast` + the calendar's manual bills.<br>• INV-147 (one definition per summary figure). | DONE (2026-10-26 — block `.cycle/blocks/7-design-d3-broad-implement.md`) |
| D4 | **Perfin dashboard, part 2: order and density.**<br>• The decision-6 order in `dashboard.ejs`; `DASHBOARD_WIDGETS` reordered to match.<br>• The pyramid moved and collapsible (collapsed by default ≤640px); its mode tabs a scrollable row (decision 15).<br>• Cash Flow and Savings Rate summarised (decision 7); the "—" zero cells.<br>• The fewer-than-3-months chart sentence (decision 7) inside `loadCharts`, keeping the existing empty state for zero months.<br>• Tests: `loadCharts` with 1 / 2 / 3 months (the T1.5 B and Batch 10 harnesses); the Cash Flow renderer (4 rows + "Show all", "—" for zero); `DASHBOARD_WIDGETS` order equals the page's DOM order (a new pin); `applyDashboardWidgets` unchanged.<br>• Playwright: dashboard load + sweep; a phone-width check that the first screen shows the Summary card, not the pyramid. | |
| D5 | **Settings: groups + index.**<br>• The decision-8 groups in `settings.ejs` (markup moves only — every section's ids, handlers and scripts unchanged); the sticky index (≥961px) and the "Jump to…" select (narrower), both built from the group headings so they can't drift; opening a deep-linked anchor scrolls to it under the sticky nav.<br>• Tests: every anchor that something links to (a scan of the code for `/settings#…` targets) still exists in the page; the index lists every group; the jump select's labels (IF-3).<br>• Playwright: `/settings#sync-health`, `#deleted-transactions` and `#recent-errors` land on their sections; the sweep. | |
| D6 | **Per-sistant alignment + shared tokens.**<br>• `design/tokens.json` (decision 9) and the matching declarations in `perfin-shared.css` and Per-sistant's `views/css.js` / `css-palette.js` (status colours, type scale, spacing, radius, button heights — values unified where they differ today).<br>• Per-sistant buttons sentence case, `.btn.primary` filled, monospace off buttons (decision 10); its empty states on its own `emptyState` (decision 12): dashboard Scheduled Emails, calendar day, To-Dos / Notes / Contacts / Job Radar lists.<br>• Tests: `tests/design-tokens.test.js` (both apps against the spec; an app-specific key never compared); Per-sistant's `emptyState` in a vm from the emitted bundle; INV-97 (no single-escaped regex in the template modules) and the `var(--x)` guard still pass.<br>• Playwright: full run + the screenshot pass for both apps. | |
| D7 | **Landing + phone polish + close-out.**<br>• The landing status lines (decision 13): a shell `landingStatus({ perfinPool, persistentPool })` with per-line timeouts, rendered into `landing.ejs`; the e2e smoke test that reaches `/` updated to see a line.<br>• The Tax drawer link January–April (decision 14); the Activity Filters toggle at the button height beside it.<br>• Docs:<br>&nbsp;&nbsp;– CLAUDE.md: UI & UX (nav shell, buttons, money colours, empty states, dashboard order + summary, Settings groups, landing, tokens), Commands (`GET /api/dashboard/summary`), Known Open Issues (the pass's follow-ons);<br>&nbsp;&nbsp;– README;<br>&nbsp;&nbsp;– STATE;<br>&nbsp;&nbsp;– INV-148 (tokens parity + the money/`fmt` rule).<br>• Tests: `landingStatus` over fake pools (each line fail-soft, a slow read timed out, nothing when both fail); the drawer link only in season; the Filters toggle's height rule.<br>• Playwright: full run + the final screenshot set (desktop + phone, both apps). | |

Seven batches, each one /broad-implement session, in order D1 → D7:
- D2 before D3 / D4, because the dashboard uses its buttons, money classes and empty states;
- D3 before D4, because D4 places the summary;
- D6 after the Perfin work, so the tokens spec matches what Perfin settled on;
- D7 last, because the landing reuses D3's summary function.

Each batch runs npm test and Playwright, plus:
- the contract suite (D1, D3, D7 — server code changes);
- mutation checks on its new logic;
- the screenshot pass — the scratch screenshot spec from the review: log in, seed, capture
  key pages at 1280 and 390, compare before / after.

Each folds in the docs for what it adds.

## New invariants

**INV-147 (D3)** | The dashboard summary has one definition per figure:
- net worth = the latest `net_worth_snapshots` row (`getNetWorth`);
- spent / budget = `getBudgetStatus`;
- lowest projected cash = `getCashFlowForecast`;
- bills due = the forecast + `manualBillOccurrences`;
- rent owed = the payee-scoped ledger;
- uncategorized = the review-queue count;
- warnings = data-health's issues.

Each field is fail-soft with a fixed sentence and the route never 500s on one failing read.
The landing's Perfin line reads the same function in-process.

Subsystem: Web UI / Financial Analytics.
Verify: D3 tests + contract `dashboard-summary`.

**INV-148 (D7)** | Shared design values have one spec, `design/tokens.json` (status colours,
type scale, spacing, radius, button heights). Both apps declare them with equal values, and
the parity test fails on drift.

Every Perfin amount is rendered through `fmt` (a negative is `-$X`). Colour carries meaning:
- money in is green;
- red marks something wrong (overdue, over budget, below $0, a debt that rose);
- a charge is the default text colour;
- gold is the brand accent only.

Subsystem: Web UI / Per-sistant Web UI.
Verify: `tests/design-tokens.test.js` + the D1 / D2 tests.

## Trade-offs to state in the docs

- **The pyramid is still on by default.** Only its position changes, plus collapsed on
  phones. Someone who never scrolls won't see it.
- **The summary's net worth is the latest snapshot**, as the pyramid's Net Worth mode
  already is. It moves when balances sync (hourly snapshot job), not live.
- **The landing reads both databases on every visit** (a few small queries with a 1.5s
  budget). On Render + Neon an idle Neon wakes for it — the same as opening either app.
- **Token parity covers shared values only.** Each app keeps its own fonts, accent and
  surfaces, so the apps match in structure (status colours, sizes, buttons) but not in
  palette.
- **Settings is still one long page.** The index and groups make it navigable without
  breaking a deep link.

## Out of scope

- A redesign of individual pages beyond the items above (Goals, Calendar, Investments
  layouts).
- A light-theme pass. Both themes keep working through the tokens, but light isn't
  re-reviewed.
- Per-sistant's sidebar / Perfin's top nav asymmetry. Two navigation models are fine; only
  the details are aligned.
- Animations, the materialize / cosmic transitions, the login page.
- New dashboard features (net worth chart on the summary, goal progress there). Possible
  follow-ons.
