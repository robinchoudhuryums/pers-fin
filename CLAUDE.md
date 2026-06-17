# CLAUDE.md — Project Context for Claude Code

## Project Overview
Single Node process that hosts two related personal tools behind one PIN gate:

- **Perfin** — finance tracker. Detects recurring charges, compares spending to
  benchmarks, tracks financial goals, runs AI-powered insights via Claude. Uses
  **Teller API** for bank links via mTLS, plus Plaid for investment holdings
  and transaction syncing for banks Teller doesn't cover (Capital One,
  Discover, Schwab, etc.).
- **Per-sistant** — personal assistant. Tasks, scheduled emails, notes,
  calendar, AI daily briefing, a **health/habits tracker** (read-time streaks,
  7-day grid + heatmap, measurements; nudges via the notification check and
  daily briefing), and a **personal Knowledge base** — RAG over an
  Obsidian vault (pgvector semantic retrieval): source-cited Q&A, structured
  facts with temporal validity, Mermaid diagrams, capture-to-vault, a
  never-sent-to-AI "secret" tier, and cross-app finance grounding from Perfin.

A `shell/` Express app authenticates the user with `SHELL_PIN` (successful
login lands directly in Per-sistant — the tile-picker landing is still served
at `/` but skipped as the default destination, `DEFAULT_POST_LOGIN` in
shell/middleware/auth.js), and mounts each sub-app under its own URL prefix:
`/perfin/*` → `teller/server.js`, `/per-sistant/*` → `apps/per-sistant/server.js`.
Each sub-app keeps its own database, routes, and migrations; the shell just
owns the listener, the auth gate, and the cross-app navigation. Sub-apps
detect they're running embedded via `req.app.get("embedded")` and skip their
own auth checks. Each can still boot standalone for local debug
(`npm run start:perfin`, `npm run start:persistent`).

See README.md for the full unified-shell architecture diagram and rationale.

## Architecture (Modular)
The Perfin sub-app is split into focused modules under `teller/`:

```
teller/
  server.js              — Bootstrap, middleware, auth, route mounting, scheduled tasks
                           (insights auto-trigger, net worth snapshots, budget alerts,
                           goal milestones, Sheets auto-sync)
  data/
    reference-data.js    — Static lookup tables: electricity rates, ZIP→state, spending
                           benchmarks, cancel URLs, category rules, AI model costs,
                           insight module definitions
    csv-formats.js       — CSV format detection (Chase, CapOne, Discover, WF, Schwab, generic)
                           + parseMoney() money normalization (strips $ / thousands
                           separators, handles parenthesized negatives, NaN on blank).
                           Used by EVERY bank-format parser incl. Schwab + generic (F6)
                           so a "(45.00)" row is imported as -45, not silently skipped.
                           Schwab's Amount+Type variant preserves the signed amount
                           (negate to debit-positive — BS-2), not Math.abs. WF detection
                           requires the first field to look like a date + the second to
                           parse as money so an arbitrary 5-col CSV isn't parsed with WF's
                           positional columns (BS-3).
  services/
    database.js          — Postgres pool + transactional auto-migrations with schema versioning
    teller-api.js        — mTLS HTTP client for Teller API (retry with exponential backoff)
    plaid-client.js      — Plaid client factory (shared by investments.js +
                           investment-performance.js so the two route modules
                           don't need a circular require)
    keep-alive.js        — Self-ping to prevent Render free tier sleep (with fetch timeout)
    job-health.js        — Scheduled-job heartbeats + missed-job watchdog. Every
                           startup.js interval calls tick(name) BEFORE its activity
                           gate (in-memory only — preserves the Neon idle-gate);
                           the watchdog flushes ticks to job_runs and pushes a
                           signature-deduped "Scheduled jobs missed" notification
                           when any job hasn't ticked for 36h+ (process asleep
                           with keep-alive off, crash loops)
    financial-queries.js — Shared income/spending SQL helpers (split-adjusted spending,
                           keyword-filtered income, current-month per-category spending
                           that honors transaction_splits) — single source of truth used
                           by AI insights and budgets so the numbers match the dashboard
    projections.js       — FIRE/runway/loan math (pure): computeFireProjection
                           (FIRE number = annual spend × 100/withdrawal-rate,
                           monthly geometric compounding, 40-yr series) +
                           computeRunwayMonths (no-income depletion with
                           growth) + computeLoanPayoff (iterative amortization
                           — months/interest/payoff-date, insufficient-payment
                           flag). Consumed by GET /api/fire-projection
                           (goals.js), the ask.js get_fire_projection tool,
                           and the insights debt-optimizer loan block; the
                           dashboard loan card inlines a pinned mirror.
    benchmarks.js        — S&P 500 benchmark closes for portfolio comparison.
                           Stooq daily-close CSV (keyless), cached in
                           benchmark_prices, fetched lazily — at most once/day
                           on SUCCESS, but a transient fetch FAILURE only
                           throttles retries ~30 min (FAIL_RETRY_MS) instead of
                           suppressing the benchmark all day (F10) — and only
                           the missing range; every failure path
                           degrades to "no benchmark line" rather than erroring
    ai-audit.js        — Post-generation insight auditing (4 tiers: arithmetic
                           validation, entity existence, trend direction, consistency).
                           Stores results in ai_audit_log table.
  routes/
    enrollments.js       — POST /api/enroll, POST /api/sync, GET /api/items,
                           DELETE /api/enrollments/:id, GET /api/accounts,
                           PATCH /api/accounts/:id, PATCH /api/accounts/:id/shared,
                           POST /api/sync-balances, reconcile endpoints, the
                           Teller sync engine, and account management. Mounts
                           spending-analytics.js (route-file split).
    spending-analytics.js — split from enrollments.js: the six read-only
                           aggregation endpoints — /api/spending-summary,
                           /api/spending-categories, /api/cash-flow,
                           /api/spending-yoy, /api/savings-rate,
                           /api/income-summary. Includes INCOME_PREDICATE_T,
                           the t.-qualified predicate derivation for the one
                           query that JOINs linked_accounts (unqualified
                           `name` was ambiguous and 500'd /api/income-summary
                           — found by the e2e harness's live boot).
                           Also exports `syncAllEnrollments` and `syncAllBalances` for
                           the scheduled bank-auto-sync task in `server.js` (in-process,
                           no HTTP self-fetch).
    subscriptions.js     — GET/POST /api/subscriptions, PATCH dismiss/undismiss/cancel/
                           uncancel/category, POST /api/detect, CSV import,
                           recurring transfers, manual bills, bill payments,
                           bill-calendar (+ICS builder), settlement. Mounts
                           transactions.js (route-file split).
    transactions.js      — split from subscriptions.js: per-transaction
                           endpoints — GET /api/transactions (+/search,
                           /duplicates, /csv-overlap +resolve),
                           PATCH/DELETE /api/transactions/:id,
                           GET/POST/DELETE /api/transactions/:id/splits.
                           (Original subscriptions.js entry continues:)
                           GET /api/transactions, GET /api/transactions/search, POST /api/detect,
                           POST /api/import-csv, GET /api/csv-imports, POST /api/cleanup,
                           GET /api/recurring-transfers, POST /api/detect-transfers,
                           PATCH /api/recurring-transfers/:id/dismiss|undismiss|type,
                           PATCH /api/transactions/:id (merchant_name, notes,
                           is_reimbursed, personal_for),
                           GET/POST/DELETE /api/transactions/:id/splits,
                           GET/POST/PATCH/DELETE /api/manual-bills,
                           GET/POST/DELETE /api/bill-payments,
                           GET /api/shared-settlement (+ /:account_id/transactions),
                           GET /api/transactions/csv-overlap (+ /resolve)
    goals.js             — GET/POST/PATCH/DELETE /api/goals, GET /api/goals/funding-options,
                           POST /api/net-worth/snapshot, GET /api/net-worth/history,
                           GET /api/context-export, GET/POST /api/investment-accounts
    budgets.js           — GET/POST/PATCH/DELETE /api/budgets, POST /api/budgets/suggest,
                           POST /api/budgets/accept, GET /api/budgets/alerts,
                           POST /api/budgets/snapshot, GET /api/budgets/history
    housing.js           — Rent & Utilities payee ledger: GET/PATCH /api/housing/config,
                           GET /api/housing/ledger, POST /api/housing/generate,
                           POST/PATCH/DELETE /api/housing/obligations, POST/DELETE
                           /api/housing/payments. Exports generateHousingObligations
                           + runHousingReminders for the scheduled task (INV-18/19).
    settings.js          — GET/PATCH /api/settings, POST /api/sheets/sync,
                           POST /api/sheets/dashboard, GET /api/export,
                           GET /api/data-freshness
    insights.js          — GET/POST /api/insights, GET /api/insights/status,
                           GET /api/insights/usage, POST /api/insights/reset,
                           POST /api/insights/rebuild, GET /api/insights/audit,
                           PATCH /api/insights/:id/feedback,
                           GET /api/insights/feedback-summary,
                           GET /api/insights/trust-overview,
                           GET/PATCH /api/tax-deductions
                           (also exports runWeeklyDigest + runDailyDigest
                           helpers used by the digest scheduled tasks in
                           startup.js)
    categorize.js        — POST /api/categorize, GET /api/categorize/status,
                           PATCH /api/transactions/:id/category,
                           PATCH /api/transactions/bulk-category,
                           GET/POST/DELETE /api/categorization-rules,
                           POST /api/categorization-rules/apply,
                           POST /api/categorization-rules/from-transaction
                           (ML categorization via Claude tool_use structured output,
                           with user-defined rules applied first before AI)
    investments.js       — AGGREGATOR for the investment routes: mounts
                           investment-performance.js and re-exports its helpers
                           (route-file split — import paths unchanged).
                           GET /api/plaid/status, POST /api/plaid/link-token,
                           POST /api/plaid/exchange, POST /api/plaid/sync-holdings,
                           GET /api/plaid/holdings (Plaid investment accounts).
                           POST /api/plaid/link-token-transactions,
                           POST /api/plaid/exchange-transactions,
                           POST /api/plaid/sync-transactions (Plaid transaction
                           syncing for banks Teller doesn't cover — Capital One,
                           Discover, Schwab, etc. Combined link token requests
                           both Transactions + Investments in one session).
                           GET /api/investments returns the unified picture
                           across Teller-linked, manual, and Plaid sources.
                           GET /api/investments/performance aggregates returns,
                           asset-class allocation, and top winners/losers from
                           Plaid-tracked holdings only (Teller-linked lacks
                           cost basis from Teller's API).
                           Also exports `syncAllPlaidTransactions`,
                           `syncAllPlaidBalances`, and `syncAllPlaidHoldings`
                           (UPSERTs investment_accounts; holdings-sum balance
                           fallback for null-balance brokerages) for the
                           scheduled auto-sync and `POST /api/sync-balances`
                           (in-process).
                           GET /api/investments excludes Plaid-linked accounts
                           from its linked_accounts branch (la.plaid_item_id IS
                           NULL) so Plaid investments come only from
                           investment_accounts — no $0 double-listing.
    investment-performance.js — split from investments.js: investment_flows
                           CRUD + Plaid flow sync (classifyPlaidFlow,
                           syncAllPlaidInvestmentFlows), TWR/XIRR math, and
                           GET /api/investments/performance-history
    insights-email.js    — split from insights.js: the pure email renderers
                           (renderInsightEmail, weekly/daily digest HTML+text,
                           escapeHtml); insights.js imports + re-exports them
    credit-scores.js     — GET/POST/DELETE /api/credit-scores
                           (manual credit score tracking with trend computation)
    notifications.js     — GET /api/notifications/vapid, POST/DELETE /api/notifications/subscribe,
                           POST /api/notifications/test, GET /api/notifications,
                           PATCH /api/notifications/:id/read, POST /api/notifications/read-all
                           (Web Push notifications + in-app notification log)
    persistent.js        — Per-sistant integration: webhooks, SSO, productivity context
                           POST /api/persistent/webhook/test, POST /api/persistent/webhook/send,
                           GET /api/persistent/status, GET /api/persistent/productivity-context,
                           POST /api/sso/generate, POST /api/sso/validate
    ask.js               — POST /api/ask: NL finance Q&A via Claude tool use.
                           7 READ-ONLY tools bound to the shared helpers
                           (monthly overview, category spending, transaction
                           search w/ split-adjusted totals, net worth,
                           subscriptions, budget status, FIRE projection) so
                           cited numbers match the dashboard by construction —
                           the model never writes SQL. Bounded tool loop
                           (MAX_TOOL_ROUNDS=6); shares the monthly AI cap
                           (getAiBudgetCents) and charges it via an
                           entry_type='ask' usage row. The charge runs in a
                           `finally` (idempotent via a `charged` flag), so a
                           throw on a LATER tool round still records the tokens
                           already consumed instead of letting the spend escape
                           the cap — parity with rebuild (AIA2) / categorize
                           (M2) (F1). Dashboard "Ask Perfin" widget (key: ask).
    whats-new.js         — GET /api/whats-new, POST /api/whats-new/seen
                           ("since you last looked" dashboard widget feed —
                           new transactions, balance deltas, new subscriptions,
                           and recent notifications since last_dashboard_view_at).
                           Also exports gatherWhatsNew(since) — the shared
                           aggregator used by both the HTTP route and the
                           daily-digest runner in insights.js so the dashboard
                           widget and email digest see the same data shape.
    watchlist.js         — GET/POST /api/watchlist, PATCH/DELETE /api/watchlist/:id
                           (user-curated merchant/category/keyword monitor.
                           Items rendered into the Watchlist sheet tab + matching
                           transactions over the last 90 days)
  pages/
    dashboard.js         — Dashboard page (Chart.js charts, 3D pyramid, account list, balances,
                           savings rate widget, cash flow widget, Per-sistant widget)
    subscriptions.js     — Subscription/utility management page
    accounts.js          — Teller Connect enrollment + CSV import page
    goals.js             — Financial goals tracking page
    budgets.js           — Budget tracking page with AI suggestions and alerts
    housing.js           — Rent & Utilities ledger page (balance owed, obligations,
                           record-payment modal, payment history, config)
    transactions.js      — Transaction search/filter page with full-text search
    calendar.js          — Bill calendar page with subscription charges, manual bills,
                           and click-to-mark-paid functionality
    account-history.js   — `/accounts/:id/history` page — Chart.js line chart backed
                           by GET /api/accounts/:id/balance-history (linked or investment source)
    login.js             — PIN pad or password login page (with materialize animation)
    settings.js          — Settings page (theme, AI insights, keep-alive, Per-sistant, exports)
    pwa.js               — PWA manifest.json + icon generation (icons cached at startup)
  public/
    logo.svg             — Iron Man helmet SVG logo (traced from PNG). Used as the
                           Perfin nav icon (CSS-masked, gold-tinted), the standalone
                           Perfin PWA icon, and the source of the helmet shape that
                           perfin-materialize.js inlines for the tile-click animation.
                           NOT the unified-shell PWA icon — that's the mask-crop PNG
                           served from shell/public/manifest.json.
    offline.html         — Branded offline fallback page served by the SW when navigation
                           fails and no cache hit exists
    sw.js                — Service worker (cache `perfin-v5`, network-first with offline
                           fallback. Precaches CSS/JS/SVG/offline.html on install. `/api/*`
                           is intentionally NOT cached — stale balances are worse than a
                           clear network error. Push notifications.)
    perfin-shared.css    — Shared styles (variables, nav, cards, animations, responsive,
                           focus-visible, skip-link, WCAG AA contrast text colors,
                           40/44px touch-target minimums on buttons)
    perfin-shared.js     — Shared JavaScript (apiFetch, theme, nav helpers, asyncAction,
                           btnLoading, beforeinstallprompt capture + perfinPromptInstall /
                           perfinIsInstalled exports)
  views/
    dashboard.ejs        — Dashboard template with 3D financial wellness pyramid
    transactions.ejs     — Transaction search/filter template, per-row Split modal
                           (Phase B3) and REIMBURSED badge (Phase B2)
    calendar.ejs         — Bill calendar template with Add Bill modal and paid-state toggling
    account-history.ejs  — Per-account balance history chart (range selector, summary cards)
    budgets.ejs          — Budget tracking template with progress bars and alerts
    housing.ejs          — Rent & Utilities ledger template (balance, obligations,
                           record-payment modal, config form, payment history)
    goals.ejs            — Financial goals template with progress and projections
    settings.ejs         — Settings template (theme, AI, keep-alive, sync, exports)
    subscriptions.ejs    — Subscription/utility management template
    accounts.ejs         — Teller Connect enrollment + CSV import template
    login.ejs            — Login template with helmet materialize animation on success
    partials/head.ejs    — HTML head (meta, PWA manifest, apple-touch-icon, viewport-fit,
                           dual light/dark theme-color, skip-link)
    partials/nav.ejs     — Top navigation bar with helmet logo icon, "Synced Xm ago"
                           badge with color-coded staleness (green/yellow/red) and per-source
                           tooltip (hidden on mobile to free up nav width — same data
                           available in Settings + the notification log), notification
                           bell with unread count + dropdown panel (drops down on
                           desktop, slides up as a bottom sheet with backdrop on
                           mobile ≤640px), <main> landmark
    partials/foot.ejs    — Footer partial (closes <main>)
```

The unified shell adds:

```
shell/
  index.js                     — PIN gate, sub-app mounts, cross-pool wiring,
                                 keep-alive, graceful shutdown, public PWA-icon
                                 + /health routes mounted before the auth gate
  middleware/
    auth.js                    — Shell auth: HMAC-signed cookie session
                                 (SHELL_PIN + SHELL_SECRET) with sliding-window
                                 idle timeout (default 60 min, tunable from
                                 Settings via user_settings.shell_idle_timeout_minutes,
                                 60s in-memory cache). Also honors `x-api-key`
                                 against process.env.API_KEY for cron / CI
                                 clients. Exports init({pool}), requireAuth,
                                 handleLogin, handleLogout, invalidateIdleCache,
                                 makeSession, setSessionCookie, isValidSession,
                                 COOKIE_NAME, DEFAULT_IDLE_MS.
    webauthn.js                — Shell-side biometric login: hosts
                                 `/api/shell/webauthn/{available,authenticate-options,authenticate}`
                                 mounted BEFORE requireAuth; reads
                                 `webauthn_credentials` from Perfin's pool;
                                 sets the shell session cookie on success
  views/
    login.ejs                  — PIN form + biometric button (feature-detected)
    landing.ejs                — Post-login tile picker
  public/
    landing.css                — Shell-only styles
    manifest.json              — Unified PWA manifest (mask-crop PNG icons,
                                 not the placeholder SVG it had originally)
    transition.css             — Per-sistant entry transition (landing tile +
                                 Perfin nav's cross-app icon). Scoped under
                                 .atrans-*; cosmic star/nebula backdrop +
                                 particle-canvas mode styles.
    transition.js              — Auto-init module: scans for [data-atrans]
                                 triggers, binds click→activate→navigate.
                                 Primary effect: particle assembly/disassembly
                                 of the PWA icon — samples the overlay's
                                 .atrans-art <img> via canvas getImageData
                                 (96×96 grid → ~2.5px particles, capped at
                                 7500 with uniform thinning, dpr-aware up to
                                 3x) that fly in to assemble the icon, then
                                 the REAL image crossfades in at full
                                 resolution (drawImage sharpen — the finale
                                 is never just the particle mosaic), holds,
                                 and bursts apart as the image fades back out
                                 (assemble 950ms / hold 430ms / disperse
                                 520ms; navigates ~90ms before the end).
                                 Honors prefers-reduced-motion (instant
                                 navigation); falls back to the original CSS
                                 mask reveal if the image isn't ready or the
                                 canvas is tainted. HYBRID by device
                                 (prefersLightTransition): desktop (fine
                                 pointer + wide viewport) runs the particle
                                 assembly; mobile/touch (coarse pointer OR
                                 ≤768px) takes the lighter CSS mask reveal —
                                 the particle field felt heavy on phones.
    perfin-materialize.css     — Iron Man helmet stroke-draw + fill + pulse
                                 ring + particle burst + HUD scan animation
                                 (Perfin entry from landing tile + Per-sistant
                                 nav's cross-app icon). Mirrors the standalone
                                 Perfin login animation but scoped under
                                 .materialize-overlay so the two never collide.
    perfin-materialize.js      — Auto-init module: scans for
                                 [data-perfin-materialize] triggers, builds
                                 the helmet-SVG overlay lazily on first click.
```

**Other key files:**
- `plaid/server.js` — Legacy Plaid server (still functional)
- `scripts/detect-subscriptions.js` — Recurring subscription detection (30/60/90/365-day cadences)
- `scripts/detect-transfers.js` — Recurring transfer detection (7/14/30/60/90/365-day cadences,
  6 transfer types: peer_transfer, bill_payment, savings, investment, internal, other)
- `scripts/sheets-sync.js` — Google Sheets sync (16+ tabs). `syncAll` runs each
  tab in isolation (per-step try/catch) and returns an `errors[]` array, so one
  failing tab no longer aborts the rest mid-run and leaves a half-updated sheet.
  Core 7: Transactions (with splits inline + Source/Reimbursed columns),
  Subscriptions (with Days Until countdown), Utilities, AI Insights
  (with structured running summary + user feedback), Recurring Transfers,
  Tax Deductions, Dashboard (with category sparklines + heatmap).
  Strategic adds: Investments, Net Worth History (monthly), Income,
  AI Trust, Categorization Rules, Manual Bills (all categories),
  Bill Payments Log, Important Dates (90-day upcoming), Watchlist
  (user-curated merchant/category/keyword monitor). Plus immutable
  per-month archive tabs (`YYYY-MM Transactions`) created once per
  completed month. Intentionally standalone — does not import the
  route/services layer, so `INCOME_PREDICATE` is duplicated from
  `services/financial-queries.js` (single-source-of-truth comment
  flags the drift risk).
- `scripts/import-csv-cli.js` — Standalone CLI for importing bank CSVs. Shares
  the route's logic via `teller/data/csv-formats.js`: content-only
  `detectCsvFormat` (no filename heuristic), the same `makeCsvTxnIdGenerator`
  dedup-ID generator (wrapping `csvTransactionId`), AND the same
  `INSTITUTION_LABELS` map. Both derive the
  default account label (`"<institution> Account"`) from the detected format,
  so when the caller doesn't supply an explicit label the CLI and the
  `/api/import-csv` route produce **identical** dedup IDs for the same row
  (F2). The generator assigns a DETERMINISTIC per-tuple occurrence index so two
  genuinely-distinct rows sharing (label, date, amount, merchant) within one
  file — e.g. two identical same-day coffees — get distinct IDs instead of the
  second silently deduping against the first (F1). Occurrence 0 hashes
  byte-identically to the legacy single-arg `csvTransactionId`, so existing
  csv_* IDs stay stable and re-importing the same file still deduplicates
  against itself. The route still honors an explicitly-provided `institution` /
  `account_label` (e.g. the web dropdown) — those are intentionally separate
  accounts. (Earlier the CLI used a divergent, row-index-based ID and
  filename-based format detection — audit H8/F29/F31, now resolved.)
- `scripts/retention-cleanup.sql` — Reference SQL for the manual cleanup queries
  exposed by `POST /api/cleanup`
- `scripts/reset-fresh.js` — Guarded fresh-start reset (`npm run reset:fresh`).
  Wipes all historical data + user config (transactions, insights, goals,
  budgets, rules, snapshots, watchlist, …) and resets `user_settings` to a
  single default row, but PRESERVES the bank-connection layer
  (`teller_enrollments`, `plaid_items`, `plaid_investment_items`,
  `linked_accounts`, `sync_cursors`) and device auth (`webauthn_credentials`,
  `push_subscriptions`) so no re-linking/re-registration is needed. Resets the
  sync watermarks (Plaid cursors → '', Teller `last_synced_txn_date` → NULL) so
  the next sync re-pulls full clean history. Dry-run by default (prints per-table
  row counts); only mutates with `--yes` / `CONFIRM_RESET=YES`; runs in one
  transaction.
- `apps-script/Code.gs` — Google Sheets Apps Script (standalone + server sync)
- `tests/` — Perfin test suite (node:test runner). Includes
  `tests/audit-regressions.test.js` which pins documented behavior for
  auth, SSO, template hygiene, exclusion rules, and the S1-S4 / #8 / #19
  feature contracts, and `tests/new-endpoints.integration.test.js` which
  uses a mock-pool + supertest pattern to exercise the feedback, whats-new,
  performance, and trust-overview endpoints end-to-end. Run `npm install`
  at the repo root before `npm test` (root `package.json` declares the
  test-time deps separately from `teller/`). `npm test` now runs both
  Perfin and Per-sistant test files (1040 tests as of latest); use
  `npm run test:perfin` or `npm run test:persistent` for scoped runs.
  Current count: 1040 tests across 41 test files (incl.
  `tests/cycle-fixes.test.js` + `apps/per-sistant/tests/cycle-fixes.test.js`
  — regression tests pinning the net-worth single-source-of-truth,
  budget-rollover month-keying, the AI-audit completion marker, and the
  Tier 1/Tier 2 broad-scan fixes: webhook replay/expiry, markdown-link &
  attachment-header sanitization, email status validation, CSV dedup-ID
  parity, Plaid balance-sync status filter, categorize cap-charge ordering,
  tax user-merchant override, decryption_failed surfacing, recurring-cron
  atomic claim — and `tests/broad-scan-fixes.test.js`, pinning the June 2026
  broad-scan fixes: backup workflow shape, fail-fast token passphrase,
  compromised-cert fingerprint check, job-health watchdog, budget-alert
  24h dedup — and `tests/seams-audit.test.js` (seams audit #2 pins: the
  repo-wide SPLIT_AMOUNT never-re-inlined scan, INV-48, and the
  EMAIL_EVENTS↔receiver symmetry check, INV-49) — plus
  tests/investment-performance.test.js (benchmark fetch +
  portfolio series), tests/investment-flows.test.js (TWR/XIRR + Plaid flow
  classification), tests/budget-cap-webauthn.test.js (tunable AI cap +
  embedded biometric registration + webauthn transports, INV-50),
  tests/pwa-polish.test.js (pull-to-refresh + safe-area pins),
  tests/sync-idempotency.test.js (BEHAVIORAL S1/INV-01/03/04: runs Teller
  syncAllEnrollments + Plaid syncPlaidItemTransactions TWICE over the same
  mock fixtures and asserts the 2nd run adds 0 with no dupes + stable
  watermark — previously source-string-pinned only), and
  tests/ai-cap-charge.test.js (BEHAVIORAL S3/INV-13/14 via a Module._load
  fake @anthropic-ai/sdk: /api/ask + runCategorize charge their usage rows,
  429 once the cap is hit, ask charges accumulated tokens AND still charges
  on a mid-loop failure — F1).
- `.github/workflows/ci.yml` — CI pipeline: `npm ci` + `npm test`, PLUS a `migrations` job that runs both apps' auto-migrations twice against a real empty Postgres (pgvector/pgvector:pg16 service container, `scripts/ci-migration-test.js`) — catches non-idempotent/fresh-DB migration failures before deploy. Both pools honor `PGSSLMODE=disable` solely for this plaintext container. PLUS an `e2e` job: Playwright browser smokes (`npm run test:e2e`, e2e/) — real Chromium login flow (wrong+right PIN, post-login default), both apps' core pages, and the calendar-feed gate, against a scratch DB booted by `e2e/boot-server.js`.
- `.claude/commands/` — Project slash-command prompts: `/broad-scan`, `/broad-implement`,
  `/test-sync`, `/sync-docs`
- `Dockerfile`, `fly.toml`, `render.yaml` — Deployment configs (the Dockerfile
  installs all workspaces and boots `node shell/index.js`; render.yaml uses
  `npm install` + `npm start` and bypasses the Dockerfile)
- `mobile/` — Capacitor iOS wrapper (remote-URL mode: the WebView loads the
  live Render deployment, so server deploys ARE app updates; no bundled web
  build). Deliberately NOT in the root npm workspaces so server deploys never
  install native tooling. Free-signing build (7-day re-sign from Xcode, NO
  APNs push — notifications keep flowing through the installed PWA, which
  coexists as a separate icon/session for A/B comparison). Pull-to-refresh in
  both apps' shared JS also activates under `window.Capacitor` (the WebView
  reports display-mode: browser). Build runbook + Phase-2 device checklist:
  `mobile/README.md`. Teller/Plaid domains are allowlisted in
  `capacitor.config.json` server.allowNavigation so bank-link flows stay
  in-WebView.

## Features

### Core Financial
- **Bank linking**: Teller Connect UI + mTLS API for transaction sync
- **Bank auto-sync** (Phase A): opt-in scheduled sync every 1/3/6/12/24 hours.
  Settings toggle drives an in-process scheduler that calls `syncAllEnrollments`
  + `syncAllBalances` directly (no HTTP self-fetch). Default: disabled.
- **Investment accounts** (three sources, unified via `GET /api/investments`):
  - **Teller-linked** brokerage / IRA / 401k / 403b / 529 / HSA / Roth IRA /
    pension accounts enrolled via Teller Connect. Live in `linked_accounts`
    (the standard Teller table). Account-level balance only — Teller's API
    does NOT expose holdings or cost basis. Detection list:
    `services/financial-queries.js INVESTMENT_ACCOUNT_TYPES`. Shows up in
    goal funding-options, contributes to net worth, syncs balance via the
    standard `syncAllBalances` path.
  - **Plaid-linked**: full holdings sync (qty / cost basis / current value
    per security). Stored in `investment_accounts` + `investment_holdings`.
    Endpoints: `/api/plaid/{status,link-token,exchange,sync-holdings,holdings}`.
    Holdings sync (`syncAllPlaidHoldings`) UPSERTs `investment_accounts` so the
    rows survive a reset/wipe, and uses the sum of an account's holdings as the
    balance when Plaid returns a null OR zero account-level balance (Schwab
    reports `balances.current === 0` and puts the value in holdings) so
    brokerages don't show $0 — the balance pick uses `||`, not `??`, precisely
    so a reported 0 falls through to the holdings-sum. It runs automatically (auto-sync + AI pre-insights
    chains + `POST /api/sync-balances`), not just at link time.
    Plaid also syncs **transactions** for banks Teller doesn't cover
    (Capital One, Discover, Schwab, Amex, credit unions) via
    `/api/plaid/{link-token-transactions,exchange-transactions,sync-transactions}`.
    The link token requests both `Products.Transactions` and
    `Products.Investments` in one session with `days_requested: 730`
    (2 years; some banks cap lower). Transactions land in the same
    `transactions` table as Teller-synced ones so the entire pipeline
    works without changes. Uses Plaid's cursor-based `transactionsSync`
    (not the deprecated `transactionsGet`); Capital One doesn't support
    `/transactions/refresh` but cursor-based sync handles it.
  - **Manual**: user-entered via `POST /api/investment-accounts`. Stored in
    `investment_accounts` with no `plaid_account_id`.
- **CSV import**: Auto-detect Chase, Capital One, Discover, Wells Fargo, Schwab formats.
  The dashboard CSV modal is **preview-and-confirm**: it first POSTs `POST
  /api/import-csv/preview` (a dry-run that detects the format and classifies every
  row new/duplicate/skipped against existing `transaction_id`s WITHOUT writing,
  using the SAME `makeCsvTxnIdGenerator` the commit uses), shows the counts + a
  sample table, then the user confirms to `POST /api/import-csv`. Both routes share
  the `parseCsvUpload()` helper (in `routes/subscriptions.js`) so format detection,
  account-label derivation, and dedup IDs can't drift between preview and commit.
- **Transaction deduplication**: SHA256-based duplicate detection across CSV imports and API syncs.
  CSV dedup IDs fold in a deterministic per-file occurrence index, so two genuinely-distinct rows
  sharing (account, date, amount, merchant) on the same day no longer collide and silently drop the
  second (F1); re-importing the same file still deduplicates against itself. `POST /api/import-csv`
  returns `rows_duplicate` (true re-imports of already-present rows) alongside `rows_imported` /
  `rows_skipped`.
- **Transaction editing** (Phase B1): rename merchants and add notes via
  `PATCH /api/transactions/:id`. User overrides live in `user_merchant_name` /
  `user_notes` columns so re-syncs from Teller don't clobber edits. The display
  layer uses `COALESCE(user_merchant_name, merchant_name, name)` everywhere,
  so renames also collapse duplicate merchant rows in top-merchants ranking.
  The Transactions page provides an Edit modal per row (merchant name, notes,
  reimbursed toggle) that calls the same PATCH endpoint.
- **Reimbursed flag** (Phase B2): mark transactions as reimbursed (work travel,
  medical, friend-paid bills) via the same PATCH endpoint. Excluded from every
  spending aggregation: `/api/spending-summary`, `/api/budgets`,
  `/api/budgets/alerts`, `/api/cash-flow`, `/api/spending-yoy`,
  `/api/savings-rate`, AI insights seasonal/tax/budget-status, scheduled
  budget-alert push, and `getCategorySpendingThisMonth`. Anomaly detection
  baselines deliberately still include reimbursed rows (a reimbursed charge
  is still a valid "what's typical for this merchant" data point).
- **Split transactions** (Phase B3): subdivide a single transaction into N
  `(amount, category, merchant_name, notes)` lines via
  `POST /api/transactions/:id/splits` (max 20 per parent, sum must match parent
  ±$0.01). Splits REPLACE the parent row in per-category aggregations; total
  amounts (monthly trend, cash flow, savings rate) are unchanged because splits
  sum to the parent. Powered by `getCategorySpendingThisMonth` in
  `services/financial-queries.js`.
- **Subscription detection**: Automatic recurring charge identification (30/60/90/365-day cadences).
  The 30-day cadence requires 3+ charges; 60/90/365-day cadences need only 2+
  (1 matching gap) — the same `>= 60` relaxation the recurring-transfer detector
  uses, so quarterly/bi-monthly subscriptions are detected without waiting for a
  third charge (F2; previously gated on `>= 365`).
  The upsert respects user state via an `is_active` CASE: if the user cancelled a subscription
  (`cancelled_at IS NOT NULL`) or dismissed it (`is_dismissed = true`), detection will not
  re-activate it even if the merchant charges again.
- **Recurring transfer detection**: Auto-detect Zelle, Venmo, bill payments, savings transfers,
  investment contributions, ACH/wire (7/14/30/60/90/365-day cadences, outgoing/incoming split)
- **Utility separation**: Utilities tracked separately from optional subscriptions
- **Shared accounts**: Joint/shared card support with two layers of split:
  account-level (`is_shared`, `spending_split_pct` on `linked_accounts`,
  applied in all spending queries via SQL JOIN — default 50/50 on a shared
  card) AND per-transaction override (`transactions.personal_for`, enum
  `'self' | 'partner' | NULL`, only honored when the account is_shared).
  `'self'` = user owes 100%; `'partner'` = the other cardholder owes 100%;
  `NULL` = use the account-level split. Powers the Shared Card Settlement
  dashboard widget, MINE/PARTNER badges on the Transactions page, and the
  `/api/shared-settlement` endpoints.
- **Financial goals**: Track progress toward savings/investment targets with compound interest projections
  (logarithmic formula), milestone push notifications at 25/50/75/100%
- **Goal funding from accounts** (Phase C): link a goal to a depository or
  investment account; `current_amount` is auto-derived as
  `account_balance - goal_baseline_amount` so the goal advances without manual
  edits. Linking infers the baseline so existing progress is preserved
  (a $3k-saved-of-$4k goal linked to a $5k savings account stays at 75%).
  CHECK constraint enforces only one funding source per goal. The original
  manually-entered value still surfaces as `current_amount_manual`.
- **Net worth tracking**: Automated daily snapshots with trend history
- **Credit utilization**: Derived credit limit display, utilization percentages
- **Credit score tracking**: Manual-entry credit score log (300-850, FICO /
  VantageScore / other). Dashboard widget shows current score color-coded
  (740+=green, 670+=teal, 580+=yellow, <580=red), delta vs prior entry,
  delta vs ~6 months ago, collapsible history, and inline log form.
  Synced to a Google Sheets "Credit Scores" tab with per-entry change
  column. The last 6 score entries + trajectory are injected into the
  AI insights prompt so Claude can correlate score changes with spending
  behavior (e.g. reduced utilization → score improvement).
- **Tax deduction persistence**: Flagged deductions stored in `tax_deductions` table, accumulated year-round
- **Manual bills**: User-created expected charges for the bill calendar (name, amount,
  due_day 1-31, cadence monthly/quarterly/yearly, category). CRUD via
  `/api/manual-bills`. Integrated into `/api/bill-calendar` alongside detected
  subscriptions.
- **Bill payment tracking**: Mark bills (both detected subscriptions and manual) as paid
  for specific dates via `/api/bill-payments`. Calendar shows paid state with
  strikethrough + checkmark. Click to toggle paid/unpaid.
- **Rent & Utilities ledger** (`/housing` page, `routes/housing.js`): a
  single-payee accounts-payable ledger for the common "we pay a person for rent +
  utilities via bank transfer" case. Models it as **obligations** (rent = fixed;
  a utility starts `pending_amount` with a NULL amount until the mailed bill
  arrives and you enter it) + **payments** (a transfer that settles a BATCH of
  obligations with a memo). The running **balance owed** = sum of `unpaid`
  obligations. Config (payee, monthly rent, due day, utilities + cadence,
  reminder lead days) lives in `user_settings.housing_config` (JSONB); a 6-hour
  scheduled task auto-**generates** each month's rent (`unpaid`) + per-utility
  placeholders (`pending_amount`) from `start_month`→current, idempotently, then
  fires two deduped reminders: **payment-due** (balance owed near the rent due
  day) and **missing-utility-amount** (a placeholder whose bill should have
  arrived). Recording a payment ticks the unpaid obligations being settled,
  auto-sums the amount, and **auto-derives the memo** by collapsing consecutive
  months into ranges (`deriveMemo` → "Jan–Mar 2026 Rent, Jan 2026 Electricity");
  obligations link back via `paid_payment_id` (FK-by-convention) and an
  Undo reverts them. Unpaid obligations with a known amount also surface on the
  **bill calendar** (`bill_source='housing'`, display-only — settled via the Rent
  page, not the calendar's `bill_payments` toggle) AND on the public token-gated
  `/calendar.ics` feed (unpaid, known-amount obligations as all-day VEVENTs with
  a stable `housing-<id>@perfin` UID). The Rent page also shows a **per-utility
  trend** section — an inline-SVG amount sparkline per utility with a
  vs-same-month-last-year (falling back to vs-previous) % delta, computed
  client-side from the ledger's obligation history (no extra endpoint). A
  **dashboard widget** (`#housing-widget-section`, toggle key `housing`, default
  on) shows the current balance owed + unpaid/awaiting counts, auto-hiding when
  the ledger isn't configured. A **landlord-ready export** (`GET
  /api/housing/export?year=&format=csv|pdf|json`) lists a year's payments with
  memos + covered months + total (PDF via pdfkit, mirroring the tax-report
  exporter). Under the unified shell, Per-sistant's **AI daily briefing** also
  weaves in a rent line ("$X owed to [payee], due in N days") read READ-ONLY
  from the wired `perfinPool` (`payee_obligations` + `housing_config`),
  fail-soft (INV-25/35). **Bill OCR**: each awaiting-bill row has a "Scan"
  button → `POST /api/housing/scan-bill` runs the bill image/PDF through Claude
  vision (tool_use forcing a `report_bill` tool) and SUGGESTS `{amount, period,
  label}` for the user to confirm before the existing amount-PATCH writes it —
  it never auto-writes, and the image is processed then discarded. Shares the
  monthly AI cap (`entry_type='scan'`; 501 without `ANTHROPIC_API_KEY`). The
  missing-utility-amount reminder deep-links to `/housing#pending` so entering
  the figure is one tap. Tables: `payee_obligations`, `payee_payments`.
- **Merchant categorization rules**: Persistent merchant→category rules applied before
  AI categorization to reduce API costs. CRUD via `/api/categorization-rules`.
  Match types: `contains`, `exact`, `starts_with`. `POST /api/categorize` applies
  rules first, then sends only unmatched transactions to Claude. Rules can be
  created from a manual categorization via `POST /api/categorization-rules/from-transaction`.
  `POST /api/categorization-rules/apply` bulk-applies all active rules.
- **Budget rollover**: Budgets can enable `rollover_enabled` to carry unused budget
  to the next month. `budget_type` can be `recurring` (perpetual) or `one_time`
  (applies only to `effective_month`). Monthly snapshots via `POST /api/budgets/snapshot`
  capture spending + rollover amounts. History via `GET /api/budgets/history`.
  `GET /api/budgets` returns `effective_limit` (base + rollover) and accepts
  `?month=YYYY-MM` query parameter.

### Dashboard & Views
- **Dashboard**: Monthly spending trend (line chart), category breakdown (doughnut), account balances,
  3D financial wellness pyramid, savings rate widget, cash flow forecast widget, Per-sistant productivity widget
- **Grouped accounts grid**: The dashboard accounts list groups under section
  headers — Cash (depository), Credit, Loans, Investments, Other — using the
  `is_investment` flag returned from `GET /api/accounts` plus the raw `type`.
  Teller-linked brokerage / IRA / 401k accounts surface under their own header
  instead of being mixed in with checking/savings. A Plaid brokerage linked via
  the combined flow lands in BOTH `linked_accounts` (often $0 from accountsGet)
  and `investment_accounts` (correct balance from holdings sync), so the grid
  drops any `linked_accounts` row whose `account_id` matches an
  `investment_accounts.plaid_account_id` — only the correct card shows, no $0
  phantom twin (parallels the `la.plaid_item_id IS NULL` dedupe in
  `GET /api/investments`).
- **Loan accounts (auto loans etc.)**: `type='loan'` rows (Plaid-linked via the
  combined flow — credit-union auto loans arrive from accountsGet — or created
  via `POST /api/accounts/manual` with `type:"loan"`, subtype defaults `auto`)
  are first-class DEBT: the dashboard renders the balance negative/red under a
  Loans group header (an $18k loan never shows as +$18k), the grid net total
  subtracts it, and `getNetWorth` counts it as a liability (F1). Plaid's
  Liabilities product does NOT cover auto loans (any issuer — only
  credit/student/mortgage), so **APR and monthly payment are manual fields on
  the loan card** (→ `PATCH /api/accounts/:id { apr, monthly_payment }`), same
  pattern as the manual Discover credit limit. With both set, the card shows a
  payoff projection — months remaining, payoff date, interest remaining — via
  `services/projections.js computeLoanPayoff` (iterative amortization at
  APR/12, exact partial final month; flags a payment below monthly interest
  instead of showing a bogus horizon; the dashboard inlines a pinned mirror of
  the iteration since the browser can't require the services layer). Loan
  accounts (with payoff figures when known) feed the AI debt-optimizer module
  alongside credit cards, with instructions to treat them as installment (no
  revolving-utilization advice). Loan payments are auto-detected as recurring
  transfers (`bill_payment` type, "loan payment" keyword) for the bill
  calendar; balance refreshes ride the normal accountsGet sync.
- **Investments widget**: Total invested across all sources, per-source
  breakdown (Teller / Plaid / Manual), and per-account cards with inline SVG
  sparklines (computed client-side from `/api/accounts/:id/balance-history`,
  no Chart.js dependency). Each card has a "View history →" link to the
  full chart page at `/accounts/:id/history`. Auto-hides when no investment
  accounts exist. Toggleable from Settings (key: `investments`, default on).
  When Plaid holdings exist, a **performance sub-card** renders inside the
  widget showing total return ($ + %), per-asset-class allocation bars
  (security_type → % of portfolio), and top winners/losers by return_pct
  (collapsible). Backed by `GET /api/investments/performance`. Auto-hides
  for users with no Plaid holdings since Teller-linked accounts don't
  expose cost basis. Toggleable (key: `investmentReturns`, default on).
  When the user has set target weights via Settings → Target Allocation,
  per-asset-class rows also carry `target_pct` + `drift_pct` (actual −
  target); under-weight classes the user wants exposure to but doesn't
  hold are surfaced as synthetic zero-holding rows.
  The card also renders a **"Value vs S&P 500" history chart** (3M/6M/12M
  range buttons, dual-line normalized-to-100 inline SVG — solid portfolio
  line, dashed benchmark) backed by `GET /api/investments/performance-history`.
  This sub-section is INDEPENDENT of Plaid holdings — Teller-linked and
  manual investment accounts have snapshot history too, so it lights up the
  card even when the cost-basis "Total return" row stays hidden. The
  benchmark line + "vs market" excess figure drop out gracefully when the
  benchmark source (Stooq, keyless) is unreachable. Portfolio line is
  value-based (contributions count as growth); below it the card shows the
  flow-adjusted figures — **TWR** (cumulative for the window) and **XIRR**
  (annualized) — computed over flow-covered accounts, with a "(covers N% of
  portfolio)" label when coverage is partial. A "Log contribution /
  withdrawal" form (collapsed) posts manual flows for Teller-linked/manual
  accounts; Plaid-linked accounts get their flows synced automatically and
  are excluded from the dropdown so manual entry can't double-count.
- **Target Allocation editor** (Settings → Target Allocation): per-
  asset-class target weights as `{security_type: pct}` rows the user
  can add/edit/remove. Sum indicator turns green at ≈100%, red above
  100%, muted otherwise (the API doesn't require sum = 100). Saved to
  `user_settings.target_allocation_pct` via PATCH /api/settings. Drives
  the drift fields on `GET /api/investments/performance`.
- **Shared Card Settlement widget**: For each is_shared account, shows
  "You owe $X" + "{partner_name} owes $Y" for the selected month, broken
  down as `(split_pct × shared_total) + your_personal_total` per side.
  Month dropdown defaults to the prior month when the user opens it in
  the first week (reconciliation usually happens after the statement
  closes). "Review →" link jumps to the Transactions page filtered to
  that account + month. Auto-hides when no is_shared accounts exist.
  Backed by `GET /api/shared-settlement`. Toggleable from Settings
  (widget key: `settlement`, default on). Partner display name set via
  Settings → Partner Name (`user_settings.partner_name`); defaults to
  "Partner" until set.
- **Since-you-last-looked widget**: aggregates new transactions, balance
  deltas (oldest snapshot ≤ watermark vs latest, dropped if |Δ| < $0.01),
  new subscriptions, and recent notifications since `last_dashboard_view_at`.
  Backed by `GET /api/whats-new`; advances the watermark 4 s after first
  render via `POST /api/whats-new/seen` so a quick nav-away doesn't lose
  the unseen state. Auto-hides when nothing's new. Toggleable
  (key: `whatsNew`, default on).
- **Review Uncategorized widget** (engagement loop): Surfaces 5-8 transactions
  that would otherwise be sent to Claude on the next AI categorize call.
  Each row has a category dropdown (pre-filled with the deterministic
  Teller-map suggestion when available) + "Remember" checkbox + Apply
  button. Apply sets `user_category` and (when "Remember" is checked)
  inserts a `categorization_rules` row. Auto-hides when the queue is empty.
  Toggleable (key: `reviewQueue`).
- **Per-account history chart page** (`/accounts/:id/history`): Chart.js line
  chart with range selector (3 / 6 / 12 / 24 / 60 months) + 5 summary cards
  (current, range start, change $, change %, snapshot count). Reads from
  `account_balance_snapshots` via `GET /api/accounts/:id/balance-history`.
  Empty state when fewer than 2 snapshots exist (history accumulates daily
  on every balance sync).
- **AI audit-accuracy card**: Settings → AI shows the percentage of insight
  runs (last 90 days) with zero critical findings, color-coded green/yellow/red,
  with severity counts. Backed by `/api/insights/status.audit_accuracy`.
- **Insight feedback loop**: dashboard's AI Insights widget grew per-insight
  thumbs-up / thumbs-down / mixed buttons plus an optional correction
  textarea. The last 5 rated insights are pulled into the next
  `generateInsights()` call as a `=== USER FEEDBACK ON RECENT INSIGHTS ===`
  section so Claude can adjust tone or double-check claims the user
  flagged. The feedback is NOT written into `insights_running_summary_json`
  — Claude sees the raw user signals each run and decides whether to act
  on them. Endpoints: `PATCH /api/insights/:id/feedback` (set
  positive/negative/mixed + optional text), `GET /api/insights/feedback-summary`
  (counts over a configurable day window, default 90).
- **AI Memory widget**: Renders the structured running summary's actual
  contents (not just counts) on the dashboard — four cards for Trends (with
  up/down/stable arrows + magnitude + since_when), Pending Actions
  (urgency-colored), Alerts (severity-colored), and Completed Goals. Backed
  by `/api/insights/status.running_summary`. Auto-hides when the summary is
  empty. Toggleable from Settings (`aiMemory` widget key, default on).
- **Quick Add Bill modal** (Upcoming Bills widget): "+ Add Bill" button on
  the dashboard's Upcoming Bills widget header opens an inline modal with
  five fields (name, amount, due_day, cadence, category) and POSTs to
  `/api/manual-bills`. Mobile-first: 44px tap targets, full-width inputs,
  numeric `inputmode` hints, autofocus on first field, click-outside + Esc
  to dismiss. Defaults to `category=utility` since utilities are the most
  common manual entry. Triggers a page reload on save so the new bill
  surfaces in the widget immediately; the next Sheets sync picks it up via
  the existing one-way DB-as-source-of-truth flow. Distinct from the
  Calendar page's existing Add Bill modal — both write to the same
  `manual_bills` table.
- **3D Financial Pyramid**: Interactive spinning pyramid with 4 frustum layers, neon wireframe edges,
  holographic effects. Layers computed by JS (`buildPyramidGeometry()`) with proper taper geometry.
  Configurable data sources: wellness, debt payoff, goal progress, etc. Mobile-optimized (reduced
  filters/shadows on small screens, `prefers-reduced-motion` support).
- **Transaction search**: Full-text search with filters — category, account, amount range, date range
  (GET /api/transactions/search)
- **Bill calendar**: Monthly calendar view of upcoming charges — detected subscriptions
  projected from cadences, user-created manual bills, and detected income. Click events
  to toggle paid/unpaid status. "Add Bill" modal for creating manual expected charges.
- **Cash flow forecast**: Rolling 30–180 day projection with day-of-week spending averages,
  income detection (keyword matching, excludes transfers/payments/refunds), bill scheduling
- **Savings rate**: Income vs spending analysis with configurable lookback (default 3 months)
- **Year-over-year comparisons**: Month-by-month spending comparison vs prior year
- **Budget alerts** (`GET /api/budgets/alerts`): Spending velocity/pacing warnings with severity levels — `critical` ≥100% (over budget), `warning` ≥80% (approaching limit), `info` when pace > 1.2× and ≥50% (spending faster than the month's progress). Alerts compare spending against the **effective limit** (base `monthly_limit` + this month's `rollover_amount` from `budget_snapshots`) and skip one-time budgets outside their `effective_month` — matching `GET /api/budgets`. The 3-hour scheduled push-notification path uses the same effective-limit logic and 80% / 100% thresholds; the in-app `info`/pace heuristic is intentionally not pushed (too noisy as a notification).

### AI & Intelligence
- **ML categorization**: Claude-powered smart transaction categorization via tool_use structured
  output (POST /api/categorize). User-defined categorization rules are applied first
  (free, instant) before sending remaining uncategorized transactions to Claude (paid).
  Response includes `categorized_by_rules` and `categorized_by_ai` counts.
  Respects user's model preference from settings.
  Model ID mapping (`data/reference-data.js`): haiku → `claude-haiku-4-5`,
  sonnet → `claude-sonnet-4-6`, opus → `claude-opus-4-6`.
  Shares the `INSIGHTS_MONTHLY_BUDGET_CENTS` cap with `/api/insights` — returns 429
  when the monthly AI budget is exhausted (rules still apply for free).
- **AI budget suggestions**: Claude suggests budgets based on 3-month spending history via tool_use.
- **AI Insights** (12 toggleable modules, auto-triggered based on cadence setting):
  - Utility rate comparison (vs state/national averages, requires ZIP)
  - Spending benchmarks (vs BLS Consumer Expenditure Survey)
  - Savings & wealth-building suggestions
  - Subscription audit (overlaps, alternatives)
  - Anomaly detection (for AI analysis a candidate must be both 2x+ above the
    merchant average AND above mean + 2·stddev — the stddev gate suppresses
    false positives on naturally high-variance merchants; 3x+ threshold for
    real-time push alerts during sync. Baseline excludes the
    trailing 7 days so the candidate doesn't inflate its own baseline; the
    candidate window matches that 7-day exclusion (F7) so a charge dated up to
    a week ago but only just synced — caught via `created_at > watermark` — is
    still eligible. Deliberately evaluates the PARENT transaction amount, not
    `transaction_splits` shares (AI-13): anomaly asks "was this CHARGE unusually
    large?", and the merchant billed the full amount regardless of how the user
    later split it across categories.
    Merchant grouping uses `LOWER(COALESCE(user_merchant_name, merchant_name, name))`
    so user-merged merchant variants share a single baseline. Both the AI
    insights candidate query and the real-time post-sync push baseline apply
    `NOT_TRANSFER` (the same negative filter the rest of the spending pipeline
    uses) so transfer/payment merchants don't skew their own baselines. The
    AI insights candidate query also joins `linked_accounts` to apply
    `spending_split_pct` on both the baseline AVG and the candidate amount,
    and excludes reimbursed candidates — so the dollar figures shown to Claude
    match the dashboard.)
  - Seasonal forecasting (24-month pattern analysis)
  - Debt payoff optimizer (avalanche vs snowball, credit score projections)
  - Bill negotiation tips
  - Income & savings rate analysis
  - Tax deduction flags — word-boundary keyword matching with a multi-word-phrase
    preference: bare ambiguous keywords (`office`, `interest`, `mortgage`, `vision`,
    `business`, `education`, `student`, `supplies`) were dropped in favor of
    specific phrases (`mortgage interest`, `student loan interest`, `home office`,
    `office supplies`, `office depot`, `business expense`). This eliminates
    false positives where credit-card finance charges flagged as `interest`
    deductions and Box-Office tickets flagged as `office` deductions.
    Matches/groups on `COALESCE(user_merchant_name, merchant_name, name)` so a
    user-renamed merchant is flagged under the name the dashboard shows (AI-7).
    Persistent year-round accumulation in `tax_deductions` for tax filing —
    this persistence is INTENTIONALLY independent of AI success (AI-8): the rows
    are a deterministic keyword-matched view of real YTD transactions (not model
    output), idempotently UPSERTed, so they accumulate even on a run that later
    hits the token cap or errors.
  - Goal tracking (with real-world economic context)
  - Recurring transfers (Zelle, bill payments, savings, investment patterns)
- **AI context enrichment**: Insights prompt includes month-over-month trend deltas,
  current budget status (spent vs limits), and recurring transfer data.
  Module tracking: all enabled modules are registered in `activeModules` when their
  system prompt instructions are added (not conditionally when data queries succeed),
  so `max_tokens` is correctly allocated for every enabled module. However, if a
  dynamic module's data query throws, that module is recorded in a `failedModules`
  set and dropped from the response's `modules_used`, surfacing instead in a new
  `modules_failed` array — so a swallowed query error no longer reports a module as
  analyzed when Claude actually received no data for it.
- **Auto-trigger**: Insights auto-generate based on `insights_cadence_days` setting (checked every 6 hours)
- **Cost tracking**: Granular token-level pricing — `input_tokens` from Anthropic's API (already excludes cache tokens) is multiplied by the input rate; `cache_read_input_tokens` and `cache_creation_input_tokens` are billed separately at their own rates. This restores accurate `INSIGHTS_MONTHLY_BUDGET_CENTS` enforcement when prompt caching is active. The monthly budget is shared between `/api/insights`, `/api/categorize`, and `/api/insights/rebuild` — all check the same cap before calling Claude AND each writes a `financial_insights` usage row after its AI call (`entry_type='categorize'` / `'rebuild'` / `'ask'` / `'scan'` for the housing bill-OCR) so its spend counts toward the cap (not just the read side). `/api/insights/rebuild` records that usage row IMMEDIATELY after the Claude call — before its tool-block validation early-returns and the summary UPDATE — so a rebuild that truncated or failed validation (which 500s) still charges the cap for the spend it already incurred (AIA2); `/api/categorize` likewise stops its AI loop if a usage-row write fails rather than spending uncapped (M2). Display queries that surface "AI Insights" filter `entry_type='insight'` to keep categorize/rebuild tracking rows out of the user-facing feed. The cap is checked-then-charged; for the insight path the insight row IS the usage row (atomic — a failed write loses the insight and its charge together), and the only gap (two concurrent generate calls both passing the pre-check) is accepted for a single-operator app rather than guarded with a provisional reservation (AI-11). `/api/insights/status` rounds the accumulated cost once and derives `budget_remaining_cents` from it so estimated + remaining == budget (AI-10).
- **Insight inputs are split-adjusted**: AI insights see the same `spending_split_pct`-adjusted monthly spend totals and the same keyword-filtered income that the dashboard and `/api/savings-rate` show, via `services/financial-queries.js`.
- **Structured running summary**: AI long-term memory is structured JSON, not plain text. `POST /api/insights` uses Anthropic tool_use (`generate_financial_insight` tool, forced via `tool_choice`) to return BOTH the user-facing `insights_text` AND a typed `summary` object with four arrays: `trends`, `completed_goals`, `pending_actions`, `alerts`. The summary is saved to `user_settings.insights_running_summary_json` (JSONB); the legacy `insights_running_summary` TEXT column gets a human-readable rendering for backward-compat callers. `sanitizeStructuredSummary` enforces shape/length bounds (max items per array, string lengths, enum values) so a pathological tool response can't pollute long-term memory. The response includes `summary_status` — `"updated"` (normal), `"preserved_due_to_truncation"` (tool block missing because hit max_tokens), `"preserved_no_tool_block"` (model didn't comply with tool_choice — rare), or `"preserved_validation_failed"` (sanitizer rejected the shape) — so callers can surface when long-term memory didn't advance. `GET /api/insights/status` returns the full `running_summary` object plus a `running_summary_counts` block (`{trends, completed_goals, pending_actions, alerts}`) so dashboards can show "tracking 3 trends · 2 goals · 5 actions · 1 alert" without a second fetch.
- **AI insight auditing**: Post-generation validation via `services/ai-audit.js`. Four tiers:
  (1) arithmetic — dollar amounts/percentages compared to actual DB data; a claim is matched to a
  category name by **word boundary** (not substring, so `car` ≠ `Carmax`) and emits at most ONE
  finding per dollar claim (the single longest/most-specific match) — critical >20% off, warning >5%
  (AI-2/AI-3). The per-category + subscription-total dollar actuals are THIS-MONTH figures
  (`getCategorySpendingThisMonth` / monthly sub total), so a claim whose context signals a
  non-current-month window (annual / multi-month / YTD / projected / running-average, matched by
  `CROSS_PERIOD_RE`) is SKIPPED rather than mis-compared — otherwise an annualized figure (×12) read
  near a category name false-flagged CRITICAL, spamming the audit notification and deflating the
  `audit_accuracy` % (AIA1). `CROSS_PERIOD_RE` also matches explicit other-month / trailing / YoY /
  estimate phrasings (`last|previous|prior month`, `N months ago`, `year-over-year`, `trailing`,
  `estimate(d)` — F6). It treats "average" as cross-period only when PERIOD-qualified (running /
  rolling / monthly / N-month average, or the verb "averaging") — a bare benchmark comparator like
  "above the national average" no longer suppresses the check, and an explicit "this month"/
  "month-to-date" qualifier (`THIS_MONTH_RE`) OVERRIDES any cross-period match, so a genuine
  this-month hallucination adjacent to the word "average" is still caught instead of silently
  inflating `audit_accuracy` in the false-negative direction (F7). It deliberately does NOT skip
  bare/unqualified or `per month` claims, which AIA1 still checks against this-month. this-month +
  unqualified claims (which refer to the data the model was given) are still checked.
  (2) entity existence — merchant/goal/subscription names verified against DB via
  whole-word match with a ≥4-char min, so a tiny known entity (a "Car" goal) can't wildcard-match
  every claimed name and let hallucinations pass (AI-4); (3) trend direction — only **total/overall**
  spending claims are checked against the monthly total; category-specific claims are skipped rather
  than mis-flagged against the total baseline (AI-1); (4) consistency — detects self-contradictions
  within the same report. Results stored in `ai_audit_log` table. Critical findings trigger an in-app
  notification, deduped to at most one per 24h via `sentRecently('audit-alert', 24)` (F5) so a
  steady-state critical finding doesn't re-push on every 6-hour auto-insight tick (parity with the
  budget-alert dedup; fail-open if the dedup check errors).
  Module auto-disable requires user confirmation. `GET /api/insights/audit` returns
  `{ findings, stats, accuracy }`; `GET /api/insights/status` includes an
  `audit_accuracy` block — both surfaced via `getAuditAccuracy(days=90)`, which
  returns `{ total_audited_runs, clean_runs, incomplete_runs, accuracy_pct,
  findings_by_severity, findings_by_tier }` over the trailing 90 days. "Clean" =
  zero critical findings. The denominator counts ONLY runs that were genuinely
  audited to completion (`financial_insights.audited_at IS NOT NULL AND NOT
  audit_incomplete`); runs that were never audited or whose tiers silently
  threw are reported separately as `incomplete_runs` and excluded — so a
  swallowed-tier failure or an un-audited insert no longer masquerades as a
  "clean" run and inflates the accuracy % (AI-5/AI-6).
- **Insight email via Per-sistant**: After each scheduled insight generation, Perfin sends
  an `insights_generated` webhook to Per-sistant with `{ subject, html_body, plain_text }`.
  HTML email is pre-rendered in Perfin with app-matching dark theme (gold/amber accents,
  Arc Reactor branding). Includes audit findings section if critical issues detected.
  Per-sistant receives the webhook and forwards to its email service. If
  `persistent_webhook_secret_enc` is unset, `sendPerSistantWebhook` hard-refuses
  to dispatch (returns `{ sent: false, reason: "missing_secret" }`) — the
  receiver was already rejecting unsigned posts, so failures are now visible
  to the caller instead of being warned-and-dropped opaquely.
  **Under the unified shell, delivery is IN-PROCESS** — the shell calls
  `persistent.setEmbeddedPersistentPool(persistent.pool)` (in `routes/persistent.js`),
  and `sendPerSistantWebhook` short-circuits the three email events
  (`insights_generated`, `weekly_summary`, `daily_summary`) through
  `deliverDigestInProcess`, which INSERTs straight into Per-sistant's `emails`
  table (recipient = `perfin_webhook_recipient` → `SMTP_FROM` → `SMTP_USER` →
  draft) — no `persistent_url`/secret/HMAC needed. The HTTP webhook path remains
  the standalone fallback, and the `test` event always uses HTTP (it exists to
  probe the webhook config). `GET /api/settings` returns `embedded` so the
  Settings UI suppresses the "configure the webhook" digest prereq warning when
  embedded.
- **Weekly digest email**: standing once-per-week Monday-morning channel
  (independent of `insights_cadence_days`). Fires the `weekly_summary`
  webhook event with `{ subject, html_body, plain_text }`, rendered by
  `renderWeeklyDigestEmail()` directly from `insights_running_summary_json`
  — no AI call. The HTML lists trends (with up/down arrows), pending
  actions (urgency-colored), active alerts (severity-colored), and
  recently completed goals. Opt-in: Settings → AI Insights → "Weekly
  Digest Email" toggle (default off); day-of-week configurable
  (`weekly_digest_day`, default Monday). The scheduler ticks hourly but
  `runWeeklyDigest` itself gates with a 6-day window from
  `last_weekly_digest_at` so the daily-aligned check is idempotent.
  Requires Per-sistant webhook configured (same path as
  `insights_generated`); without it `sendPerSistantWebhook` short-circuits
  and the digest is a no-op.
- **Daily activity digest**: opt-in once-per-day digest of yesterday's
  new transactions, balance deltas, new subscriptions, and notifications.
  Fires the `daily_summary` webhook event with `{ subject, html_body,
  plain_text }`, rendered by `renderDailyDigestEmail()` from
  `gatherWhatsNew(now - 24h)` — same aggregator the dashboard's "Since
  you last looked" widget uses, so both surfaces see the same data shape.
  No AI call. Opt-in: Settings → AI Insights → "Daily Activity Digest"
  toggle (default off). Hourly scheduler; `runDailyDigest` dedupes via
  a 20-hour gate from `last_daily_digest_at` and skips silently when
  `gatherWhatsNew` returns zero counts.
- **Critical-alert emails** (opt-in, Settings → AI Insights/Notifications →
  "Critical Alert Emails", `user_settings.critical_alert_emails_enabled`,
  default off): budget-exceeded (100%+, shares the push path's 24h
  `sentRecently` dedup) and 3x-anomaly charges (one summary email per sync
  run; email failure never holds the anomaly push watermark) email
  immediately via the digest channel (`critical_alert` event —
  `sendCriticalAlertEmail` in routes/persistent.js; in-process under the
  shell, HTTP webhook standalone).
- `user_settings.last_reconcile_at TIMESTAMPTZ`: watermark for the weekly
  self-healing reconcile and the manual `POST /api/sync/reconcile`. The
  scheduler runs the trailing-window Teller backfill at most once per 7-day
  window from this timestamp. Same Per-sistant prereq as
  weekly digest — without webhook config, it's a no-op.
- **Context export**: Structured financial data (markdown/JSON) for pasting into Claude chat deep-dives
- **Real-time anomaly alerts**: Push notifications for charges 3x+ above merchant average during sync
  (case-insensitive merchant grouping; separate from the 2x AI analysis threshold)
- **Budget threshold alerts**: Push notifications at 80% (warning) and 100%+ (exceeded) every 3 hours

### UI & UX
- **Authentication (standalone)**: SESSION_PASSWORD (text) or SESSION_PIN
  (numeric PIN pad), configurable timeout. Bypassed under the unified shell.
- **Authentication (unified shell)**: SHELL_PIN with sliding-window idle
  timeout (default 60 min, tunable from Settings → Security → "App Idle
  Timeout"). Cookie refreshed on every authenticated request so an active
  user never times out mid-use; idle past the window → re-prompted.
  Brute-force protection: a 750ms wrong-PIN delay plus IP rate limiters —
  `authLimiter` (10 failed/15min) on `/login` + biometric authenticate, and
  `apiKeyLimiter` (20 failed/15min) on the `x-api-key` path (counts only
  failed key attempts, so browser/cron traffic is unaffected).
- **Login animation (standalone Perfin)**: Iron Man helmet materialize on
  successful login (gold-amber stroke-draw → fill → particle burst → HUD
  scan → redirect). Lives inline in `teller/views/login.ejs`.
- **Tile-click + cross-app transition animations (unified shell)**: the
  same Iron Man materialize plays when entering Perfin from the landing
  tile or from Per-sistant's nav cross-app icon; a parallel cosmic mask-
  crop reveal (scan-line + nebula + rising particles) plays when entering
  Per-sistant from the landing tile or Perfin's nav cross-app icon.
  Implemented as shared shell static modules (`shell/public/
  perfin-materialize.{css,js}` and `transition.{css,js}`) wired via
  `data-perfin-materialize` / `data-atrans="cosmic"` attributes.
- **Branding (Perfin)**: Iron Man helmet logo (SVG traced from PNG) — nav
  bar icon (CSS mask), standalone Perfin PWA icon, login animation source.
- **Branding (unified shell PWA)**: mask-crop PNG (1024×1024). Served from
  shell at root paths so iOS auto-discovers from any page. Distinct from
  Perfin's per-app icon — adding from a Perfin page still gets the helmet
  bookmark.
- **Status messages (toast stack)**: `showMsg(text, ok)` pushes onto a
  `#toast-stack` container (auto-created on first call) instead of
  overwriting a single per-page element. Stack caps at 5 visible toasts;
  identical consecutive messages dedupe (timer bump, no pile-up). Each
  toast auto-dismisses after 5 s (success) / 10 s (error); tap to dismiss
  early. Desktop: anchored top-right with slide-down. Mobile (≤640px):
  bottom-right `column-reverse` with slide-up so the newest is at thumb
  level and doesn't compete with the iOS notch / Dynamic Island. Legacy
  per-page `.status-msg` divs are now `display: none !important` but kept
  in templates so any direct DOM writes are silent no-ops.
- **Dark/Light theme**: Toggle in Settings, persisted to DB + localStorage
- **PWA**: Installable home screen app (manifest.json + service worker, helmet icon centered on home screen).
  Service worker (cache `perfin-v5`) uses network-first, caches successful same-origin
  static GETs, and explicitly skips `/api/*` so the dashboard never serves stale balances
  when offline.
- **Offline fallback page** (Phase D): when navigation fails and no cache hit exists,
  the SW serves `/offline.html` — a branded "You're offline" page with a Retry
  button — instead of the browser's generic error.
- **Install prompt** (Phase D): `perfin-shared.js` captures `beforeinstallprompt`;
  Settings shows an "Install App" section with a button when the browser is ready,
  hides itself when already installed (`display-mode: standalone`), and falls back
  to iOS Add-to-Home-Screen instructions when neither path is available.
- **Mobile polish** (Phase D): viewport-fit=cover for iOS notch, dual light/dark
  `theme-color` meta, 40/44px (desktop/mobile) touch-target minimums on buttons.
- **Safe-area pass + pull-to-refresh** (PWA Phase-0 follow-up): Perfin's body
  (and the shell login/landing) pad by `env(safe-area-inset-*)` so the top nav
  clears the iPhone status bar/notch under viewport-fit=cover (Per-sistant
  deliberately omits viewport-fit and auto-insets — don't "fix" the asymmetry).
  Both apps' shared JS ship `initPullToRefresh`: standalone-display-mode-only,
  passive-listener drag-down-from-top → ring indicator → reload, with
  overlay/pyramid/canvas exclusions (iOS home-screen PWAs have no native
  pull-to-refresh gesture).
- **Mobile navigation**: at ≤640px the 7-link top nav collapses behind a
  **hamburger** (drawer drops under a single-row bar; closes on link tap /
  outside click / Esc) and a fixed **bottom tab bar** surfaces the 5 primary
  destinations (Home/Activity/Subs/Budgets/Settings) thumb-reachable. Both are
  in `partials/nav.ejs` + `perfin-shared.css`; desktop is unchanged (both
  hidden). Body gets bottom padding and the toast stack lifts above the bar.
- **Responsive tables → cards**: wide data tables opt into a shared
  `responsive-cards` pattern (`perfin-shared.css`) — at ≤640px the header row is
  visually hidden and each `<td>` (with a `data-label`) renders as a label:value
  line inside a card. Special cells: `cell-primary` (full-width title),
  `cell-actions` (wrap row of 40px-min buttons), `cell-check`, `empty`/`empty-msg`.
  Applied to the Subscriptions list AND the four dashboard mini-tables
  (Monthly Spending, Spending by Category, Top Merchants, Upcoming Charges).
  The Transactions (Activity) page uses a denser variant instead —
  `txn-compact` (perfin-shared.css): a two-line CSS-grid row (merchant +
  amount / date · category · actions, account hidden) at ~⅓ the height of a
  responsive-card, with the filter bar collapsed behind a "Filters" toggle on
  mobile so the recent-transactions list sits at the top of the page (the
  dashboard's Recent Transactions section was removed in favor of it). The
  four dashboard mini-table sections are collapsible (h2 toggles, chevron,
  state persisted per-section in localStorage `perfin_collapse_<key>`), and
  Spending by Category has a month selector ("Recent months" aggregate
  default, or any month from the trend — backed by GET
  /api/spending-categories, which uses getCategorySpendingForMonth so the
  per-month figures match budgets/snapshots). Floating chrome (toasts,
  notification panel, mobile nav drawer) sits on the opaque
  `--surface-solid` token — the translucent 4%-alpha `--surface` is for
  in-flow cards only; anything floating OVER content needs full opacity or
  the page bleeds through. New wide tables should add
  `class="responsive-cards"` + `data-label`s rather than relying on horizontal
  scroll.
- **Money formatting**: the shared global `fmt()` (`perfin-shared.js`) renders
  thousands separators (`$22,199.52`); stat-card `.value` font uses `clamp()` +
  `overflow-wrap` so large amounts never overflow narrow 2-up mobile cards.
- **"Last synced" nav badge** (Phase D): top nav shows "Synced 47m ago" with color-coded
  staleness: green (<6h), yellow (6-24h), red (>24h). Tooltip shows per-source
  freshness (transactions, balances, auto-sync). Populated from the most recent of
  `last_auto_sync_at`, `last_txn_sync_at`, `last_balance_sync_at`. Hidden on
  mobile (≤640px) to free up nav width — same data lives in Settings and the
  notification log.
- **Unified notification center**: In-app notification history via `notification_log`
  table. Nav bar bell icon shows unread count badge. Desktop: clicking opens a
  drop-down panel (`.notif-panel`) anchored top-right. Mobile (≤640px): the panel
  becomes a full-width bottom sheet with a grab-handle hint + dim backdrop
  (`#notif-backdrop`); tap the backdrop, click outside, or press ESC to dismiss.
  Show/hide uses the HTML `hidden` attribute so CSS animations are declarative.
  Sticky header keeps the title + "Mark all read" pinned while scrolling the
  list. `sendToAll()` logs every push notification to the table, so
  notifications are preserved even if the user hasn't enabled push or dismissed
  the browser alert. API: `GET /api/notifications`, `PATCH /api/notifications/:id/read`,
  `POST /api/notifications/read-all`.
- **Data freshness API**: `GET /api/data-freshness` returns per-source timestamps
  (transactions, balances, auto-sync, insights) with `age_seconds`, a boolean
  `stale` flag (>24h), and an explicit `level` (`"fresh"` <6h / `"aging"` 6-24h /
  `"stale"` >24h or never synced). The response also includes a top-level
  `thresholds: { fresh_seconds, stale_seconds }` block so the nav badge's
  green/yellow/red mapping doesn't need to repeat threshold constants.
  `POST /api/sync` updates `last_txn_sync_at`; `POST /api/sync-balances`
  updates `last_balance_sync_at`.
- **Sync Health card** (Settings): renders `GET /api/data-health` — per-source
  freshness dots (green/yellow/red), Teller/Plaid connection status, a derived
  `issues[]` list (disconnected links, stale balances, never-synced, plus the
  per-item errors from the most recent sync run — see `last_sync_result` below),
  and the last reconcile time — plus a "Reconcile Now" button that POSTs
  `/api/sync/reconcile` to recover any dropped transactions.
- **Sync-degradation strip** (dashboard): a banner (`#sync-health-strip`) fetches
  `GET /api/data-health` on load and surfaces its warning-level `issues[]`
  (disconnected links, stale sync, `decryption_failed`, stale scheduled jobs) at
  the top of the dashboard — so silent degradation is visible without opening
  Settings → Sync Health (deep-links there via the `#sync-health` anchor).
  Dismissible per-session (`sessionStorage`), so a persistent issue re-appears on
  the next visit rather than being permanently silenced. Hidden when healthy;
  best-effort — a failed probe never blocks the dashboard.
- **Web Push notifications**: VAPID-based push notifications for anomalies, budget alerts,
  goal milestones
- **Accessibility**: Skip-to-content link, `<main>` landmark, chart aria-labels, :focus-visible
  styles, WCAG AA contrast-compliant text colors
- **CSP nonces**: Per-request cryptographic nonces for all inline scripts (no `'unsafe-inline'` in `scriptSrc`). Style policy is split: `styleSrcElem` is nonce-gated for `<style>` blocks while `styleSrcAttr` keeps `'unsafe-inline'` for inline `style=""` attributes.
- **Keep-alive**: Timezone-aware self-ping to prevent Render free tier sleep (10s timeout)
- **Per-model cost tracking**: Usage history with granular pricing (Haiku/Sonnet/Opus)
- **Google Sheets sync**: Auto-sync to 16+ tabs. Core 7 plus strategic
  additions render every aspect of the DB into Sheets-native views.
  - **Transactions**: split rows interleaved below their parent via CTE
    UNION; `Source` column (user / auto / split); `Reimbursed` columns;
    italic-tan formatting on splits; green tint on reimbursed.
  - **Subscriptions**: `Days Until` countdown column (Sheets `=DAYS`
    formula so it stays accurate when reopened); imminent ≤7 day
    highlight; warning-only sheet protection.
  - **Utilities**: auto-detected utility subscriptions + `manual_bills`
    with `category='utility'`, TOTAL roll-up combining monthly + yearly.
  - **AI Insights**: main grid (date / model / tokens / feedback /
    feedback note / insight) + four sub-tables below from the structured
    `insights_running_summary_json` (Trends, Pending Actions, Active
    Alerts, Completed Goals); per-feedback row coloring.
  - **Recurring Transfers**: warning-only protection.
  - **Tax Deductions**: warning-only protection.
  - **Dashboard**: net worth, budgets, goals, over-budget conditional
    formatting; SPENDING BY CATEGORY section gained 6 per-month columns
    + SPARKLINE Trend column + gradient heatmap conditional formatting
    over the month cells; "Synced [day, time]" banner restyled.
  - **Investments** (new): Plaid holdings with cost basis, current
    value, return $, return % (green positive / red negative), grand
    total. Teller-linked accounts excluded (no Teller cost-basis API).
  - **Net Worth History** (new): one row per month (last snapshot per
    YYYY-MM via DISTINCT ON), month-over-month delta column.
  - **Income** (new): monthly totals (24mo) + top sources (12mo) using
    the canonical `INCOME_PREDICATE` (inlined to keep the script
    standalone — sole intentional duplication).
  - **AI Trust** (new): 50 most-recent `ai_audit_log` findings
    (severity-colored) + 50 most-recent user feedback ratings on
    insights (feedback-colored).
  - **Categorization Rules** (new): user merchant→category map sorted
    by `times_applied`; inactive rules greyed out.
  - **Manual Bills** (new): all categories (not just utility), with
    monthly-equivalent TOTAL (quarterly /3, yearly /12).
  - **Bill Payments Log** (new): joins `bill_payments` to both
    `detected_subscriptions` and `manual_bills` depending on
    `bill_source`; variance column flags >10% deviation.
  - **Important Dates** (new): 90-day upcoming-events view UNIONing
    subscription next-charge dates, manual-bill due dates (computed
    from `due_day` + `cadence` with month-end safety via
    `LEAST(due_day, 28)`), recurring-transfer projections
    (`last_transferred + cadence_days`), and goal `target_date`. Days Away is
    a Sheets formula. Today=red, ≤7 days=amber.
  - **Watchlist** (new): user-curated merchant / category / keyword
    monitor backed by the `watchlist_items` DB table. Tab shows each
    item + its last-90-day matching transactions. Items edited via
    Settings → Watchlist; the tab itself is read-only with warning-only
    protection. Empty-state writes a guidance row.
  - **Per-month archive tabs** (new): once a month is complete (not the
    current month), `syncMonthArchives()` creates a dedicated
    `YYYY-MM Transactions` tab with all that month's transactions +
    totals, then never touches it again (idempotent via tab-existence
    check; warning-only protected). Immutable audit trail per month for
    disputes / taxes / historical lookups.

  Triggered by:
  - Scheduled `sheets-auto-sync` job (configurable cadence: daily / weekly
    / monthly via `sheets_auto_sync_interval`).
  - `POST /api/sheets/sync` (full syncAll — ~30-60s on a large
    spreadsheet).
  - `POST /api/sheets/sync-transactions` — partial-sync endpoint that
    only refreshes the Transactions tab (~5s). Called by the dashboard
    CSV upload modal so users see uploaded transactions in Sheets
    quickly.
  - `POST /api/sheets/dashboard` — Dashboard tab only.

### Per-sistant Integration (Companion App)
Under the unified shell both apps run in the same Node process, so most of
what used to be a network/HMAC integration is now a function call or a
shared session cookie. Cross-app surface area today:
- **Shared auth**: shell PIN gate fronts both apps; sub-app `requireAuth`
  bails on `req.app.get("embedded")`.
- **Cross-app navigation**: in-nav "switch to other tool" link in each app's
  layout, only rendered when embedded. Same-origin, in-app navigation.
- **Knowledge → Perfin finance grounding** (new seam): Per-sistant's Knowledge
  feature (`apps/per-sistant/routes/rag.js`) reads Perfin's pool **read-only**
  (`linked_accounts`, `detected_subscriptions`) via the wired `perfinPool` to
  ground finance-flavored questions ("can I afford my renewal?"). Owned by the
  Knowledge / RAG subsystem; finance queries only; no Perfin schema changes;
  never an HTTP self-fetch (INV-35). This is why a Perfin-side audit should know
  Per-sistant consumes those tables.
- **Cross-pool wiring**: `shell/index.js` does
  `perfin.app.set("persistentPool", persistent.pool)` and the reverse, so
  routes in either app can query the other's database directly via
  `req.app.get("perfinPool")` / `("persistentPool")` instead of HTTP
  self-fetching. Self-fetches 401 through the shell auth gate (the
  in-process fetch carries no shell session cookie), so the wired-pool
  path is the load-bearing design under the unified shell.
- **Insight email pipeline**: Perfin's scheduled insight generation sends an
  `insights_generated` event with `{ subject, html_body, plain_text }` to
  Per-sistant's webhook receiver, which forwards to its email service.
  Code: `teller/routes/persistent.js` (`sendPerSistantWebhook()`). Still
  goes via HTTP because Per-sistant's webhook receiver is HMAC-verified and
  the verification path expects a real HTTP request shape.
- **Productivity context** (`GET /api/persistent/productivity-context`):
  Perfin fetches task/review stats from Per-sistant for AI insights prompt
  enrichment. Embedded fast-path queries Per-sistant's pool directly via
  `queryPersistentStats` / `queryPersistentReview`; HTTP fetch is the
  standalone fallback.
- **Per-sistant's Perfin widget** (`GET /api/perfin/stats`): symmetric — the
  embedded fast-path queries Perfin's `detected_subscriptions` directly;
  HTTP fetch is the standalone fallback. The fallback now correctly
  unwraps Perfin's `{subscriptions, summary}` response shape (an earlier
  version assumed a bare array and crashed silently, so the widget always
  showed "not connected" in standalone Per-sistant deployments).

**Legacy two-services integration** (still in code as standalone fallback):
- **Cross-app SSO**: HMAC-signed token exchange (60s expiry, per-token nonce
  for replay protection). Format: `sso:<timestamp>:<nonce>:<signature>`.
  Required `SSO_SECRET` set on both apps. Unused under the unified shell.
- **Webhook system**: HMAC-signed event notifications (anomaly_detected,
  budget_exceeded, new_subscription, goal_milestone, csv_reminder). Now
  in-process; signing layer remains for the standalone fallback. Dispatch
  is refused (`{ sent: false, reason: "missing_secret" }`) when the shared
  secret isn't configured so misconfiguration surfaces immediately rather
  than being silently rejected at the receiver.

## Deployment

### Operator state to provide manually
Two pieces of secret state are NOT version-controlled and must be placed
on the operator's machine (or fed via env vars) before the app boots:

1. **Teller mTLS PEMs** — `certificate.pem` and `private_key.pem` at the
   repo root (or `TELLER_CERT_PATH` / `TELLER_KEY_PATH` env vars; or
   base64'd `TELLER_CERT` / `TELLER_KEY` env vars on Render). These
   files used to be checked in but were `git rm --cached`'d. The old
   committed copies remain in earlier git history (merge 08ff2ff) and
   should be **considered compromised** — rotate the cert in the Teller
   dashboard before relying on them, and treat scrubbing history
   (`git filter-repo` / BFG) as a one-time destructive action that needs
   to happen out-of-band. Until the rotation happens, `getTlsAgent()`
   (`teller/services/teller-api.js`) logs a loud `*** SECURITY WARNING ***`
   at cert load when the loaded cert's DER SHA-256 matches the
   known-compromised fingerprint from history — the warning disappearing
   is the signal that the rotation took effect.
2. **`TOKEN_ENCRYPTION_PASSPHRASE`** — used by `pgp_sym_encrypt` to store
   Teller access tokens, Plaid access tokens, and the Per-sistant webhook
   HMAC secret. **Missing it is FATAL at boot** (`services/database.js`
   exits 1, same posture as a missing `NEON_DATABASE_URL`) — booting
   without it used to only warn and then surface later as scattered
   `decryption_failed` errors. For local debugging without any bank links,
   set `ALLOW_MISSING_TOKEN_PASSPHRASE=true` to downgrade the failure to
   the old warning. Rotating it invalidates all stored ciphertext; the
   remediation is to re-link affected institutions (Teller Connect re-run
   for Teller items, Plaid Link re-run for Plaid items). After a rotation
   mismatch, `POST /api/plaid/sync-holdings` will surface
   `errors: [{ institution, error: "decryption_failed" }]` per affected
   item rather than silently returning zero accounts. The Teller sync paths
   (`syncAllEnrollments` / `syncAllBalances`) do the same: a NULL decrypted
   token is reported as `decryption_failed` and the enrollment is skipped
   rather than 401-ing against Teller and being silently marked DISCONNECTED
   (which would wrongly demand a Teller Connect re-run on a mere passphrase
   mismatch).
3. **Per-sistant Knowledge / RAG operator state** (all optional — the feature
   degrades to keyword-only without them; nothing blocks app boot):
   - `VOYAGE_API_KEY` — Voyage embeddings for semantic retrieval. Without it,
     Knowledge serves keyword search only. (`VOYAGE_MODEL` optional, default
     `voyage-3.5`; dimension 1024 is baked into `chunks.embedding vector(1024)`.)
   - `VAULT_GITHUB_TOKEN` — **read-only** fine-grained PAT for the private
     Obsidian-vault repo (sync/ingest). Repo + branch are set in Settings →
     Knowledge, not env.
   - `VAULT_GITHUB_WRITE_TOKEN` — **separate write-scoped** PAT (Contents
     read+write) used ONLY by capture-to-vault; capture returns 400 until set.
     Kept distinct from the read-only sync token (least privilege).
   - **pgvector** — verify `CREATE EXTENSION vector` succeeds on the Neon DB
     before relying on semantic search. The migration is defensive (degrades to
     keyword if the extension is unavailable) so it won't crash boot, but
     semantic retrieval needs the extension present (Neon supports it).
   - **`knowledge-reindex.yml` GitHub Action secrets** — `SERVER_URL` +
     `API_KEY` repo secrets so the scheduled reindex can reach
     `/per-sistant/api/rag/reindex` (via the shell's x-api-key path) while the
     Render free tier sleeps.
4. **`db-backup.yml` GitHub Action secrets** — `NEON_DATABASE_URL`,
   `PERSISTENT_DATABASE_URL` (optional), and `BACKUP_ENCRYPTION_PASSPHRASE`
   repo secrets for the nightly encrypted backup workflow (pg_dump of both
   DBs → AES-256 artifacts, 90-day retention; runs from GitHub's runners so
   it works while Render sleeps). Keep a copy of the backup passphrase
   OUTSIDE GitHub — the artifacts are unreadable without it. The restore
   runbook lives in the workflow file's header; do one restore drill into a
   throwaway Neon branch before you need it for real.

Both the **weekly digest** (Settings → AI Insights → "Weekly Digest
Email") and the **daily activity digest** ("Daily Activity Digest"
toggle) have a soft prerequisite: Per-sistant must be configured with
`persistent_url` and a webhook secret. Without those, the schedulers
still run but `sendPerSistantWebhook` short-circuits with
`{ sent: false, reason: "not_configured" | "missing_secret" }` and the
digests are a no-op. The weekly toggle surfaces an inline warning when
the prereq is missing; the daily toggle inherits the same constraint.
Operators enabling either should verify the Per-sistant integration
first under Settings → Integrations.

**Plaid** (optional — for banks Teller doesn't cover): create a Plaid
account at dashboard.plaid.com. New accounts after April 2026 get the
**Trial Plan** (10 free Production Items — enough for personal use).
Set `PLAID_CLIENT_ID`, `PLAID_SECRET_PROD`, and `PLAID_ENV=production`
in the Render dashboard. The old Development environment was
decommissioned June 2024; Trial Plan replaced it. Access tokens never
expire; re-auth only needed if the user changes their bank password.

**Gotcha — Plaid Liabilities coverage is issuer-dependent.** Some issuers
(observed with **Discover**) do NOT return APR or `balances.limit` through
Plaid's Liabilities product even after a fresh re-link with Liabilities
requested — so APR stays blank and utilization shows "—". A re-link will NOT
fix this (and burns a precious Trial-Plan Item), so do NOT recommend re-linking
to chase APR/limit. Instead use the **manual credit-limit + APR fields** on the
dashboard credit card (limit → `PATCH /api/accounts/:id/balance { credit_limit }`,
APR → `PATCH /api/accounts/:id { apr }`), which drive real utilization with no
Plaid dependency. `syncAllPlaidBalances` surfaces an actionable
"re-link this card to enable Plaid Liabilities" message ONLY when the item lacks
the Liabilities product entirely (PRODUCTS_NOT_SUPPORTED) AND carries a credit
account — it stays silent when Liabilities is present but the issuer simply
returns no APR/limit data, which is the un-fixable Discover case.

**Gotcha — Plaid Liabilities never covers auto loans (any issuer).** The
product supports only credit cards, student loans, and mortgages, so an auto
loan's APR/term/payment will NEVER arrive from Plaid — do not chase it with a
re-link. The loan's balance DOES sync via plain accountsGet. APR and monthly
payment are manual fields on the dashboard loan card (`PATCH /api/accounts/:id
{ apr, monthly_payment }`), which drive the payoff projection.

### Render (Free, recommended — currently deployed)
1. Connect GitHub repo in Render dashboard
2. Create Web Service from `render.yaml` blueprint
3. Build/start commands (the YAML defaults are correct under the unified shell):
   - **Build**: `npm install` (workspace-aware install at the root; walks
     shell/, teller/, apps/per-sistant/ in one pass)
   - **Start**: `npm start` → `node shell/index.js`
4. Provide the Teller mTLS cert via env vars:
   - `TELLER_CERT` = `base64 < certificate.pem`
   - `TELLER_KEY`  = `base64 < private_key.pem`
   *(Alternative: Render Secret Files + `TELLER_CERT_PATH` / `TELLER_KEY_PATH` env vars.)*
5. Set the unified-shell env vars (`SHELL_PIN`, `SHELL_SECRET`,
   `PERSISTENT_DATABASE_URL`) plus the existing Perfin/Per-sistant ones
   (see Environment Variables below)
6. Access at `https://pers-fin-tracker.onrender.com` — lands on the PIN
   page, then the tile picker

### Fly.io (~$2/mo)
```bash
fly launch --name pers-fin-tracker
fly secrets set SHELL_PIN="1234" SHELL_SECRET="$(openssl rand -hex 32)"
fly secrets set NEON_DATABASE_URL="postgres://..." \
                PERSISTENT_DATABASE_URL="postgres://..." \
                TOKEN_ENCRYPTION_PASSPHRASE="..."
fly secrets set TELLER_APPLICATION_ID="app_pplg2et45b7bl1scna000" TELLER_ENV="development"
fly secrets set TELLER_CERT=$(base64 < certificate.pem) TELLER_KEY=$(base64 < private_key.pem)
fly deploy
```

### Local
```bash
npm install            # walks all three workspaces
npm start              # boots the unified shell (node shell/index.js)
# Open http://localhost:3000 → PIN → tile picker → either app

# Standalone debug (skip the shell entirely):
npm run start:perfin       # node teller/server.js
npm run start:persistent   # node apps/per-sistant/server.js
```

## Current Status
- Deployed on Render (free tier, sleeps after 15 min idle) — single service
  hosting both apps via `node shell/index.js`
- Render deploys from `main`
- Env vars configured in Render dashboard, including `SHELL_PIN`,
  `SHELL_SECRET`, `PERSISTENT_DATABASE_URL`
- Teller mTLS cert provided via base64 env vars (`TELLER_CERT` / `TELLER_KEY`)
- Teller Application ID: `app_pplg2et45b7bl1scna000`
- 1040 tests passing across 41 test files (Perfin 647 + Per-sistant 393), plus 8 Playwright browser smokes (CI `e2e` job; not in `npm test`)

## Commands
```bash
cd teller && npm install && node server.js    # Run locally
npm install                                    # ALSO required at repo root for tests
npm test                                       # Run all tests (Perfin + Per-sistant)
npm run test:e2e                               # Playwright browser smokes (needs local Postgres; see e2e/boot-server.js)
npm run test:perfin                            # Perfin tests only (tests/*.test.js)
npm run test:persistent                        # Per-sistant tests only
npm run reset:fresh                            # DRY RUN: print what a fresh-start reset would wipe/keep
npm run reset:fresh -- --yes                   # perform the reset (wipes data+config, keeps bank links)

# Key API endpoints
POST /api/enroll           # store Teller access token after Connect
POST /api/sync             # pull transactions for all enrollments
POST /api/sync-balances    # fetch latest account balances. Refreshes Teller
                           # (`syncAllBalances`), Plaid balances + credit limit
                           # + liabilities/APR (`syncAllPlaidBalances`), AND
                           # Plaid investment holdings (`syncAllPlaidHoldings`)
                           # in one call — no transactionsSync rerun.
                           # Response: { accounts_updated, errors?,
                           # plaid_accounts_updated, plaid_errors?,
                           # holdings_updated, holdings_accounts_updated,
                           # holdings_errors?, flows_added, flows_errors? }.
                           # Also re-pulls investment cash flows
                           # (syncAllPlaidInvestmentFlows) for TWR/XIRR. plaid_errors now also carries
                           # surfaced liabilities failures ("liabilities: <code>")
                           # so a card whose APR/limit won't load is visible.
POST /api/detect           # run subscription detection
POST /api/sync/reconcile   # backfill/reconcile to recover dropped transactions
                           # (body: days=1-365 default 90, provider=teller|plaid|all,
                           # background?=bool). Teller re-fetches the trailing window
                           # watermark-independently (idempotent upserts, no watermark
                           # advance, anomaly push suppressed); Plaid resets each
                           # item's cursor and re-walks transactionsSync. Stamps
                           # last_reconcile_at. SYNCHRONOUS by default — returns
                           # { days, provider, teller?, plaid? } per-provider
                           # summaries inline (the contract API/CLI callers rely on).
                           # With background:true the work runs detached: returns 202
                           # { started, running, provider, days } immediately and
                           # pushes a "Reconcile complete" notification on finish
                           # (409 if one is already running). The Sync Health UI uses
                           # background mode + polling since the Plaid leg re-walks up
                           # to 2 years of history and can take a minute.
GET  /api/sync/reconcile/status # poll the background reconcile job
                           # { running, started_at, finished_at, provider, days,
                           #   result, error }
POST /api/detect-transfers # run recurring transfer detection
GET  /api/recurring-transfers # list recurring transfers (query: filter=active|dismissed|all)
PATCH /api/recurring-transfers/:id/dismiss   # dismiss a recurring transfer
PATCH /api/recurring-transfers/:id/undismiss # restore a dismissed transfer
PATCH /api/recurring-transfers/:id/type      # reclassify transfer type
GET  /api/transactions     # list transactions (query: months, limit, offset)
GET  /api/transactions/search # search/filter (query: q, category, account_id, min/max_amount, start/end_date)
GET  /api/transactions/duplicates # find candidate duplicate transactions across accounts
GET  /api/transactions/csv-overlap         # CSV virtual accounts whose transactions
                                           # overlap with Plaid/Teller-synced accounts
                                           # (same amount, date ±2 days, ≥3 matches).
                                           # Common after linking a previously
                                           # CSV-only bank via Plaid — historical
                                           # CSV rows + 2yr Plaid history double-count.
POST /api/transactions/csv-overlap/resolve # delete CSV-side rows that have a matching
                                           # Plaid/Teller row (body: csv_account_id,
                                           # synced_account_id, dry_run?). Keeps the
                                           # synced account as canonical going forward.
PATCH /api/transactions/:id # user overrides: merchant_name, notes, is_reimbursed
                            # (Phase B1/B2), personal_for ('self'|'partner'|null —
                            # shared-card settlement override; invalid values
                            # silently coerced to NULL)
DELETE /api/transactions/:id # delete a single transaction (deduplication tool)
GET  /api/transactions/:id/splits # list splits for a transaction (Phase B3)
POST /api/transactions/:id/splits # replace splits, validates sum matches parent ±$0.01
DELETE /api/transactions/:id/splits # clear all splits, revert to parent-row aggregation
GET  /api/forecast         # 7-90 day projection of recurring subscription charges
GET  /api/bill-calendar    # monthly calendar of expected charges + recurring income (query: year, month)
GET  /api/manual-bills     # list all active manual bills
POST /api/manual-bills     # create a manual bill (body: name, amount, due_day, cadence, category)
PATCH /api/manual-bills/:id # update a manual bill
DELETE /api/manual-bills/:id # delete a manual bill
GET  /api/bill-payments    # list payments for a month (query: year, month)
POST /api/bill-payments    # mark a bill as paid (body: bill_source, bill_id, paid_date)
DELETE /api/bill-payments/:id # unmark a bill payment
GET  /api/housing/config   # rent/utilities ledger config (payee, rent, due day, utilities)
PATCH /api/housing/config  # replace config (validated/normalized; 400 if enabling w/o payee)
GET  /api/housing/ledger   # balance owed + obligations + payment history (with covered months)
POST /api/housing/generate # generate current/missing months' obligations from config (idempotent)
POST /api/housing/obligations # add an ad-hoc obligation (body: label, period, amount?, category?, due_day?)
PATCH /api/housing/obligations/:id # set amount (bill arrived → unpaid), notes, due_day, label
DELETE /api/housing/obligations/:id # remove an obligation
POST /api/housing/payments # settle a batch of unpaid obligations (body: obligation_ids[],
                           # paid_date?, amount? (default=sum), memo? (default=derived)); marks paid
DELETE /api/housing/payments/:id # undo a payment, reverting its obligations to unpaid/pending_amount
GET  /api/housing/export   # landlord-ready record of a year's payments (query: year,
                           # format=csv|pdf|json) — memos + covered months + total (pdfkit PDF)
POST /api/housing/scan-bill # OCR a utility-bill image/PDF via Claude vision → SUGGEST
                           # { amount, period, label } WITHOUT writing (user confirms +
                           # PATCHes). Shares the AI cap (entry_type='scan'); 501 w/o
                           # ANTHROPIC_API_KEY, 429 past the cap. Image discarded, not stored.
GET  /api/csv-reminder     # list manual accounts overdue for a CSV refresh
GET  /api/subscriptions    # list detected subscriptions
GET  /api/accounts         # list linked accounts with balances (includes is_shared, spending_split_pct)
PATCH /api/accounts/:id    # update account details (apr 0-99.99; monthly_payment > 0
                           # or null — the manual loan fields driving the payoff projection)
PATCH /api/accounts/:id/shared # mark account as shared/joint (body: is_shared, spending_split_pct)
PATCH /api/accounts/:id/balance # update balance fields (current_balance, available_balance, credit_limit)
POST /api/accounts/manual  # create a manual (non-Teller, non-Plaid) account
                           # (type: depository | credit | loan — loan subtype defaults 'auto')
DELETE /api/accounts/manual/:id # delete a manual account
GET  /api/shared-settlement # who-owes-who on shared cards for a given month
                            # (query: month=YYYY-MM, account_id?). Returns per-
                            # account { total_charges, shared_total, your/partner
                            # personal totals + counts, your_share, partner_share }
                            # plus the user's configured partner_name.
GET  /api/shared-settlement/:account_id/transactions # flat list of every charge on a
                            # shared account in the given month with each row's
                            # personal_for state, for reconciliation.
GET  /api/spending-summary # monthly trends, categories, top merchants (split-adjusted)
GET  /api/spending-categories # per-month category breakdown (query: month=YYYY-MM;
                           # splits/reimbursed/share-adjusted via getCategorySpendingForMonth)
GET  /api/cash-flow        # rolling cash flow projection (query: days, default 90)
GET  /api/savings-rate     # income vs spending analysis (query: months, default 3)
GET  /api/income-summary   # income trend + top sources + by_account (query: months, default 6)
GET  /api/spending-yoy     # year-over-year comparison (query: month, year)
GET  /api/accounts/:id/balance-history # daily balance series for an account (query: source=linked|investment, months)
GET  /api/goals            # list financial goals with projections; each goal includes
                           # `suggested_transfers[]` matching active recurring transfers
                           # whose type aligns with the funding source and whose monthly
                           # amount is within ±25% of monthly_contribution (current_amount is
                           # derived from the funding account when one is linked).
                           # Response also carries `funding_status` (linked|orphaned|none)
                           # and `current_amount_manual` — when the FK is set but the
                           # account is gone (orphaned), current_amount falls back to
                           # current_amount_manual so pre-link progress is preserved.
GET  /api/goals/funding-options # depository + investment accounts a goal can link to (Phase C)
GET  /api/fire-projection  # FIRE number/progress/time-to-FIRE + spending runway.
                           # Inputs: getNetWorth + trailing COMPLETED months'
                           # income/spending averages (partial month excluded) +
                           # fire_* assumption settings (real return % default 5,
                           # withdrawal rate % default 4, optional monthly-spending
                           # override). Goals page card with inline assumptions +
                           # 40-yr projection SVG. Math: services/projections.js.
POST /api/ask              # NL finance Q&A (body: { question, <=500 chars }).
                           # 501 without ANTHROPIC_API_KEY; 429 past the shared
                           # monthly AI cap; charges the cap (entry_type='ask').
POST /api/goals            # create a financial goal
GET  /api/investment-accounts # list manual investment accounts (manual + Plaid-synced rows in investment_accounts)
POST /api/investment-accounts # add manual investment account
GET  /api/investments         # unified investment list across Teller-linked + Plaid + manual sources
                              # (returns total_value, by_source totals, accounts[] with source/supports_holdings flags)
GET  /api/net-worth/history # net worth snapshots over time
GET  /api/context-export   # structured data dump for Claude chat
GET  /api/tax-deductions   # accumulated tax-deductible transactions
GET  /api/settings         # retrieve user settings
PATCH /api/settings        # update user settings. Accepts: theme,
                           # dashboard_months, insights_*, keep_alive_*,
                           # zip_code, partner_name (shared-card settlement
                           # widget display name, max 50 chars),
                           # pyramid_*, debt_baseline_amount,
                           # shell_idle_timeout_minutes, target_allocation_pct,
                           # weekly/daily digest toggles,
                           # fire_expected_return_pct (0-20),
                           # fire_withdrawal_rate_pct (1-10),
                           # fire_monthly_spending_override (>=0 or null),
                           # ai_monthly_budget_cents (1-10000 cents or null
                           # to fall back to env), etc.
GET  /api/data-freshness   # per-source sync timestamps with staleness flags
GET  /api/data-health      # operator health surface — per-source freshness,
                           # Teller/Plaid connection status, scheduled-job
                           # heartbeats (jobs[] with per-job staleness from
                           # job_runs + thresholdMs), derived issues[]
                           # (disconnected links, stale balances, never-synced,
                           # + per-item errors from last_sync_result), recent sync
                           # notifications, last_reconcile_at, last_sync_result, and
                           # a top-level `ok` flag. Does NOT live-decrypt tokens to
                           # probe a passphrase mismatch (pgp_sym_decrypt throws on a
                           # wrong key); that condition surfaces here via
                           # last_sync_result.errors (decryption_failed) instead (D).
GET  /api/budgets          # list budgets with current spending (query: month=YYYY-MM)
POST /api/budgets          # create budget (body: rollover_enabled, budget_type, effective_month)
PATCH /api/budgets/:id     # update budget
DELETE /api/budgets/:id    # delete budget
POST /api/budgets/suggest  # AI budget suggestions
POST /api/budgets/accept   # accept AI-suggested budget
GET  /api/budgets/alerts   # spending velocity warnings (critical/warning/info)
POST /api/budgets/snapshot # create monthly snapshot + compute rollovers (body: month=YYYY-MM, 01-12)
GET  /api/budgets/history  # budget snapshots for trend analysis (query: months)
POST /api/insights         # generate new AI insights. Response includes
                           # modules_used and modules_failed (dynamic modules
                           # whose data query threw — dropped from modules_used)
GET  /api/insights/status  # AI API config + usage stats + audit_accuracy (90d clean-run %)
                           # + running_summary (structured JSON) + running_summary_counts
GET  /api/insights/usage   # AI usage history
POST /api/insights/reset   # clear long-term AI context
POST /api/insights/rebuild # rebuild context from all history
GET  /api/insights/audit   # audit log + per-module stats + 90-day accuracy summary
PATCH /api/insights/:id/feedback # set thumbs-up/down/mixed + optional correction note
                                  # (body: { feedback: 'positive'|'negative'|'mixed'|null, text? })
GET  /api/insights/feedback-summary # positive/negative/mixed counts (query: days, default 90)
GET  /api/insights/trust-overview # merged audit_accuracy + user_feedback for the Settings AI card
                                   # (query: days, default 90 — clamped 1-365)
POST /api/categorize       # ML categorize transactions (rules first, then Claude AI)
GET  /api/categorize/status # ML categorization status
GET  /api/categorize/review-queue # candidates the next AI categorize would send to Claude
POST /api/categorize/review # apply a single user decision (sets user_category, optionally creates rule)
GET  /api/categorize/progress # live progress of the running categorize pass
                            # { running, phase, by_rules, by_teller_map, by_ai, ai_batches, remaining }
GET  /api/categorize/accuracy # running ML accuracy over verified AI rows
                            # { ai_total, verified, correct, unverified, accuracy_pct }
GET  /api/categorize/accuracy-sample # random unverified AI-categorized rows to review
                            # (query: limit 1-25 default 8) → { transactions[], categories[] }
POST /api/categorize/accuracy-review # record a verdict on a sampled AI row
                            # (body: transaction_id, correct: bool,
                            # corrected_category? (required when wrong), create_rule?).
                            # Preserves source='ai' so the miss still counts in stats;
                            # the corrected category still wins via user_category.
PATCH /api/transactions/:id/category # manually set transaction category — writes user_category
PATCH /api/transactions/bulk-category # bulk update categories — writes user_category
GET  /api/categorization-rules       # list all categorization rules
POST /api/categorization-rules       # create a rule (body: merchant_pattern, category, match_type)
DELETE /api/categorization-rules/:id # delete a rule
POST /api/categorization-rules/apply # apply all active rules to uncategorized transactions
POST /api/categorization-rules/from-transaction # create rule from a manual categorization
POST /api/import-csv/preview # dry-run a CSV import: detect format + classify each
                           # row new/duplicate/skipped vs existing transaction_ids,
                           # WITHOUT writing. Returns { format_detected, account_label,
                           # rows_total, rows_parseable, rows_skipped, rows_new,
                           # rows_duplicate, sample[] }. Backs the two-step upload modal.
POST /api/import-csv       # import bank CSV file (with deduplication). Returns
                           # { rows_imported, rows_skipped, rows_duplicate, format_detected }
GET  /api/csv-imports      # list CSV import history
GET  /api/export           # download transactions/subscriptions CSV
POST /api/sheets/sync      # full sync to Google Sheets (all 16+ tabs, ~30-60s)
POST /api/sheets/sync-transactions # partial sync — Transactions tab only (~5s); called from CSV upload modal
POST /api/sheets/dashboard # sync dashboard data to Sheets
GET  /api/watchlist        # list watchlist items (merchant/category/keyword)
POST /api/watchlist        # add watchlist item (body: type, value, notes?)
PATCH /api/watchlist/:id   # toggle is_active or update notes
DELETE /api/watchlist/:id  # remove watchlist item
GET  /api/credit-scores    # credit score history + computed trend (query: limit, score_type)
POST /api/credit-scores    # log a score (body: score 300-850, score_type?, source?, notes?, checked_at?)
DELETE /api/credit-scores/:id # remove an entry
GET  /api/plaid/status     # Plaid API config status (configured + environment)
POST /api/plaid/link-token # create Plaid Link token for investments only
POST /api/plaid/exchange   # exchange public token for investment accounts
POST /api/plaid/sync-holdings # sync investment holdings (thin wrapper around the
                              # exported syncAllPlaidHoldings helper; UPSERTs
                              # investment_accounts so wiped rows are re-created)
POST /api/plaid/link-token-transactions # create combined Transactions+Investments link token
                                        # (730-day history request; one Plaid Link session links
                                        # both checking + brokerage for banks like Schwab)
POST /api/plaid/exchange-transactions   # exchange token, store in plaid_items, fetch accounts
                                        # into linked_accounts, run initial transaction sync,
                                        # auto-detect + sync investment holdings if present
POST /api/plaid/sync-transactions       # cursor-based sync for all plaid_items (added/modified/removed)
                               # Response: { accounts_updated, holdings_updated, errors[]? }
                               # Per-item failures (including NULL access_token from a
                               # pgp_sym_decrypt mismatch) surface as
                               # `errors: [{ institution, error: "decryption_failed" | ... }]`
GET  /api/plaid/holdings   # list investment holdings
GET  /api/investments/performance # portfolio returns + asset-class allocation + top winners/losers
                                  # (Plaid holdings only; auto-hides on dashboard when empty)
GET  /api/investments/performance-history # portfolio value series vs S&P 500
                                  # (query: months=3-60 default 12). Portfolio = daily
                                  # account_balance_snapshots summed across ALL investment
                                  # accounts (investment-source rows + Teller-linked
                                  # investment types, Plaid phantom twins deduped same
                                  # direction as getNetWorth), per-account forward-filled.
                                  # Benchmark from benchmark_prices (services/benchmarks.js);
                                  # response carries benchmark:null gracefully when the
                                  # source is unavailable. portfolio_return_pct is
                                  # point-to-point on VALUE (contributions count as
                                  # growth); the response ALSO carries flow-adjusted
                                  # figures: twr_pct (true time-weighted return — daily
                                  # chain-linked, exact since valuations are daily) and
                                  # xirr_pct (annualized money-weighted return), both
                                  # computed over FLOW-COVERED accounts only (Plaid-synced
                                  # + any account with manual flows) with a flow_coverage
                                  # block ({coverage_pct, flows_count, net_flows, scope:
                                  # all|partial|none}) so partial coverage is explicit
                                  # rather than silently wrong.
POST /api/plaid/sync-flows # sync external cash flows (deposits/withdrawals/in-kind
                           # transfers) from Plaid investmentsTransactionsGet into
                           # investment_flows. Full ~24-month window every run, idempotent
                           # via UNIQUE plaid_investment_transaction_id (no watermark —
                           # a newly linked item can't silently lose history). Dividends,
                           # interest, capital gains, buys/sells/fees are RETURN
                           # components, never flows (classifyPlaidFlow).
GET  /api/investment-flows # list flows (query: months default 24) with account names
POST /api/investment-flows # log a manual flow for accounts Plaid can't see
                           # (body: source 'investment'|'linked', source_id, flow_date,
                           # amount, flow_type contribution|withdrawal — sign derived
                           # from flow_type regardless of submitted sign)
DELETE /api/investment-flows/:id # delete a MANUAL flow (plaid rows 404 — they'd
                           # resurrect on the next sync)
GET  /api/whats-new        # "since you last looked" feed — new transactions, balance deltas,
                           # new subscriptions, and recent notifications since last_dashboard_view_at
POST /api/whats-new/seen   # advance last_dashboard_view_at to now (idempotent)
GET  /api/notifications/vapid # get VAPID public key for push
POST /api/notifications/subscribe # register push subscription
DELETE /api/notifications/subscribe # unregister push subscription
POST /api/notifications/test # send test push notification
GET  /api/notifications      # list notification log (query: limit, unread=true)
PATCH /api/notifications/:id/read # mark notification as read
POST /api/notifications/read-all  # mark all notifications as read

# Tax export
GET  /api/export/tax-report # year-end deduction summary (query: year, format=csv|json|pdf)
                            # PDF format renders via pdfkit with per-category breakdown
                            # and grand-total summary

# WebAuthn / biometric login — Perfin sub-app endpoints (registration always
# happens here; standalone deployments also use these for the auth flow).
POST /api/webauthn/register-options    # generate registration challenge (auth required)
POST /api/webauthn/register            # verify and store new credential (auth required)
POST /api/webauthn/authenticate-options # generate auth challenge (no session needed)
POST /api/webauthn/authenticate        # verify biometric and create session (standalone)
GET  /api/webauthn/credentials         # list registered credentials (auth required)
DELETE /api/webauthn/credentials/:id   # remove a credential (auth required)

# Shell-layer biometric login (unified-shell deployments). Mounted BEFORE the
# shell's PIN gate so users can authenticate via FaceID/passkey without first
# entering the PIN. Reads `webauthn_credentials` from Perfin's pool via the
# cross-pool wiring; on successful verify, sets the shell signed-cookie session.
GET  /api/shell/webauthn/available             # does any credential exist? (drives login UI)
POST /api/shell/webauthn/authenticate-options  # generate auth challenge
POST /api/shell/webauthn/authenticate          # verify + set shell session cookie

# Per-sistant integration endpoints
POST /api/persistent/webhook/test  # test webhook connectivity to Per-sistant
POST /api/persistent/webhook/send  # manually trigger webhook event
GET  /api/persistent/status        # Per-sistant connection health check
GET  /api/persistent/productivity-context # fetch task/review stats from Per-sistant
POST /api/sso/generate             # create HMAC-signed SSO token (60s expiry)
POST /api/sso/validate             # validate SSO token, create session

# Pages
GET  /                          # redirects to /dashboard (post-login entry point;
                                # baseUrl-aware so it lands in the right mount
                                # under the unified shell)
GET  /accounts                  # Teller Connect enrollment + CSV import page
GET  /dashboard                 # main dashboard UI
GET  /subscriptions             # subscription management
GET  /transactions              # transaction search/filter page
GET  /calendar                  # bill calendar page
GET  /goals                     # financial goals page
GET  /budgets                   # budget tracking page
GET  /housing                   # Rent & Utilities ledger page
GET  /settings                  # settings page
GET  /accounts/:id/history      # per-account balance chart (query: source=linked|investment, months)
GET  /login                     # login page (if auth enabled)
GET  /health                    # health check (Perfin standalone) — also
                                # served by the shell at the same path; the
                                # shell version is public (pre-auth) and
                                # doesn't touch the DB

# Shell-level public endpoints (no auth, mounted before requireAuth):
GET  /health                              # process-up probe (shell, JSON)
GET  /manifest.json                       # unified-shell PWA manifest
GET  /apple-touch-icon.png                # iOS home-screen icon (mask-crop PNG)
GET  /apple-touch-icon-precomposed.png    # older-iOS probe path; same bytes
GET  /android-chrome-192x192.png          # PWA icon, 192 (mask-crop PNG)
GET  /android-chrome-512x512.png          # PWA icon, 512 (mask-crop PNG)
GET  /calendar.ics                        # bill-calendar iCalendar feed (subscribe from
                                          # iOS/Google Calendar). Token-gated via
                                          # ?token=CALENDAR_FEED_TOKEN — the ONE sanctioned
                                          # query-string credential (calendar apps send no
                                          # headers/cookies); read-only, single-purpose,
                                          # deliberately separate from API_KEY (which stays
                                          # header-only). Unset env = 404/feature off.
                                          # Events: detected-subscription charges projected
                                          # by cadence + manual bills (monthly = all in
                                          # window; quarterly/yearly = next occurrence) +
                                          # unpaid Rent & Utilities obligations (known
                                          # amount, on their period's due day),
                                          # 90 days default (?days=7-365). Builder:
                                          # subscriptions.buildBillCalendarIcs.
```

`PATCH /api/settings` accepts a new `shell_idle_timeout_minutes` field
(integer, 5-10080 minutes) that drives the shell's sliding-window auth.
After the PATCH a hook fires `auth.invalidateIdleCache()` so the new
value applies on the very next request, not after the 60s cache lag.

The `insight_modules` and `dashboard_widgets` toggle maps are coerced to a
flat `{ string: boolean }` object via `sanitizeBoolMap` before persisting
(rejects arrays / nested objects, caps key length, `!!`-coerces values) so a
pathological body can't be stored verbatim — parity with the `target_allocation_pct`
validation (SN-5).

## Environment Variables

### Shell (unified PIN gate)
- `SHELL_PIN` — unified PIN that fronts both apps. Constant-time compare with a 750ms throttle on incorrect attempts, backed by an IP rate limiter (10 failed attempts / 15 min) on `/login` and the biometric authenticate endpoints.
- `SHELL_SECRET` — random ~32+ char string (`openssl rand -hex 32`). Signs the shell session cookie. Rotating it invalidates every active session.
- `SHELL_PORT` — optional listener port override (defaults to `PORT` or `3000`)
- `CALENDAR_FEED_TOKEN` — optional long random token enabling the public `/calendar.ics` bill feed (unset = feature off)

### Databases (one per sub-app)
- `NEON_DATABASE_URL` — Perfin's Neon PostgreSQL connection string
- `PERSISTENT_DATABASE_URL` — Per-sistant's Neon DB (separate). Falls back to `NEON_DATABASE_URL` for standalone Per-sistant deployments.
- `TOKEN_ENCRYPTION_PASSPHRASE` — passphrase for encrypting access tokens at rest. **Required — boot fails without it** (escape hatch: `ALLOW_MISSING_TOKEN_PASSPHRASE=true` for local debug with no bank links).

### Teller (Perfin)
- `TELLER_APPLICATION_ID` — Teller app ID
- `TELLER_ENV` — Teller environment (sandbox/development/production)
- `TELLER_CERT` / `TELLER_KEY` — base64-encoded mTLS PEMs (Render)
- `TELLER_CERT_PATH` / `TELLER_KEY_PATH` — file paths (default `./certificate.pem` / `./private_key.pem`)
- `TELLER_CERT_CONTENT` / `TELLER_KEY_CONTENT` — raw PEM contents written to disk by `docker-entrypoint.sh` at container start

### Per-app auth (mostly bypassed when embedded under shell)
- `SESSION_PASSWORD` — text password for standalone Perfin login
- `SESSION_PIN` — numeric PIN for standalone Perfin PIN pad login
- `SESSION_SECRET` — session cookie secret (auto-generated if not set)
- `API_KEY` — `X-API-Key` for non-browser clients (cron, GitHub Actions like
  daily-sync.yml and keep-alive.yml). Under the unified shell, the shell's
  `requireAuth` itself validates the header (constant-time compare) as an
  alternate credential path parallel to the PIN cookie — sub-apps then see
  `req.app.get("embedded")=true` and skip their own check, trusting the
  shell. Browsers don't need it; they use the shell session cookie.
- `ALLOWED_ORIGINS` — comma-separated CORS origins (Perfin)

### AI / Insights (Perfin)
- `ANTHROPIC_API_KEY` — enables AI features in both apps
- `INSIGHTS_MONTHLY_BUDGET_CENTS` — monthly API spending cap fallback (default 50 = $0.50); shared between `/api/insights`, `/api/categorize`, `/api/insights/rebuild`, and `/api/ask`. Overridable at runtime from Settings → AI Insights → Monthly Budget Cap (`user_settings.ai_monthly_budget_cents`, resolved by `getAiBudgetCents()` in routes/insights.js — the single cap reader)

### Push notifications (Perfin)
- `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` — Web Push keypair (`npx web-push generate-vapid-keys`); without these `/api/notifications/*` returns 501
- `VAPID_EMAIL` — contact `mailto:` URL (default `mailto:admin@perfin.app`)

### Keep-alive (Perfin / shell)
- `RENDER_EXTERNAL_URL` — auto-set by Render; the keep-alive self-ping uses it as the target URL when present, falling back to `http://localhost:PORT` for local runs. Operators don't set this manually.

### Plaid (Perfin — investments + transactions for banks Teller doesn't cover)
- `PLAID_CLIENT_ID`, `PLAID_SECRET_SANDBOX|DEV|PROD` — Plaid API credentials
- `PLAID_ENV` — `sandbox` (default), `development`, or `production`; selects which `PLAID_SECRET_*` is used.
  **For real bank connections set `PLAID_ENV=production`** with a Trial Plan
  account (10 free Production Items, no cost). The old Development
  environment was decommissioned June 2024; Trial Plan (created after
  April 2026) is the replacement.

### SMTP (Per-sistant — email scheduling)
- `SMTP_HOST` / `SMTP_PORT` / `SMTP_USER` / `SMTP_PASS` / `SMTP_FROM`

### Per-sistant Health & Habits
- `APP_TIMEZONE` — IANA zone (e.g. `America/New_York`) for the Health & Habits
  day-math (streaks / due-today / 7-day grid / future-log guard). Server and
  injected client both resolve "today" in this zone so they agree. Default
  `UTC` (unchanged behavior); set it to your zone or evening logs west of UTC
  land on the wrong day (F11). See `apps/per-sistant/CLAUDE.md`.

### Cross-app integration (legacy, two-Render-services era)
Unused under the unified shell — both apps run in-process. Documented as the
standalone-mode fallback if either app is run on its own Render service.
- `PERSISTENT_URL` — URL of standalone Per-sistant instance
- `PERSISTENT_WEBHOOK_SECRET` — HMAC secret for signing webhook payloads
- `SSO_SECRET` — shared HMAC secret for cross-app SSO token exchange

## Database
- Auto-migration runs on server startup in a transaction (BEGIN/COMMIT/ROLLBACK) — no
  manual SQL needed. Migration failures are now fatal (the process throws and exits)
  rather than logging a "non-fatal" warning while leaving the schema half-applied.
- Migration creates base tables (`plaid_items`, `teller_enrollments`, `linked_accounts`,
  `sync_cursors`, `transactions`, `detected_subscriptions`, `csv_imports`) idempotently
  via `CREATE TABLE IF NOT EXISTS` before the per-feature `ALTER TABLE` steps.
- Schema versioning via `schema_migrations` table (current value: 3). Most
  migration steps use `IF NOT EXISTS` / `CREATE OR REPLACE` guards and run
  unconditionally, so the version is largely observability — with ONE exception:
  the detection-key orphan cleanup (see "Detection-key migration window") is
  gated on `currentVersion < 3` so it runs exactly once during the v3 upgrade
  instead of on every boot (PSA1). New one-shot cleanups should follow the same
  `currentVersion < N` gating rather than running unconditionally.
- Schema files in `db/` for reference only
- Key tables: `teller_enrollments`, `linked_accounts`, `transactions`,
  `transaction_splits`, `detected_subscriptions`, `recurring_transfers`,
  `user_settings` (single-row), `financial_insights`, `financial_goals`,
  `net_worth_snapshots`, `tax_deductions`, `csv_imports`, `budgets`, `budget_snapshots`,
  `push_subscriptions`, `webauthn_credentials`, `investment_accounts`, `investment_holdings`,
  `plaid_investment_items`, `plaid_items`, `sync_cursors`, `schema_migrations`,
  `categorization_rules`, `manual_bills`, `bill_payments`,
  `payee_obligations`, `payee_payments` (Rent & Utilities ledger), `notification_log`,
  `ai_audit_log`, `account_balance_snapshots`, `watchlist_items`, `credit_scores`,
  `job_runs` (scheduled-job heartbeats — one row per background job, UPSERTed by
  `services/job-health.js`; the `_watchdog` row stores the last-notified
  missed-job signature), `investment_flows` (external cash flows for
  TWR/XIRR — polymorphic (source, source_id) like account_balance_snapshots,
  signed amount (positive = into the portfolio), provenance 'plaid' (UNIQUE
  plaid_investment_transaction_id) or 'manual'), `benchmark_prices` (S&P 500 daily closes cached from
  Stooq by `services/benchmarks.js` — PK (symbol, price_date); read by
  `GET /api/investments/performance-history`)
- `user_settings`: single-row pattern (CHECK id = 1) for app preferences
- `linked_accounts` loan/debt columns: `apr NUMERIC(5,2)` (manual — also used by
  credit cards) and `monthly_payment NUMERIC(12,2)` (manual, loans) drive the
  loan payoff projection; Plaid Liabilities never reports auto-loan terms.
- `linked_accounts` columns include: `is_shared BOOLEAN`, `spending_split_pct INT DEFAULT 100`,
  `is_manual BOOLEAN` — constraint `chk_account_source` allows `plaid_item_id IS NOT NULL OR
  teller_enrollment_id IS NOT NULL OR is_manual = true`
- `transactions` user-edit columns (Phase B1/B2/B4): `user_merchant_name TEXT` and
  `user_notes TEXT` hold user overrides separately from the raw Teller fields so a
  re-sync doesn't clobber them; `is_reimbursed BOOLEAN DEFAULT false` and
  `reimbursed_at TIMESTAMPTZ` flag transactions that the user (or an employer)
  paid back, which excludes them from every spending aggregation.
  Index `idx_transactions_reimbursed` is partial (only indexes rows where
  is_reimbursed = true) to keep the common false case cheap.
  Phase B4: `user_category TEXT` holds category overrides. `PATCH
  /api/transactions/:id/category`, bulk-category, AND every `/api/categorize`
  write path — user rules, the Teller-map fast path, the AI fallback, and
  `POST /api/categorization-rules/apply` — write here (NOT `category`), so a
  Teller/Plaid re-sync — which UPSERTs `category = EXCLUDED.category` — can't
  overwrite them. (Writing to scalar `user_category` means the rule/AI values
  are stored as plain strings, not the `category[]` array literal.) Display
  layers use `COALESCE(user_category, category[1])` everywhere, including the
  categorize candidate filter so already-categorized rows aren't re-sent to AI.
  Categorization provenance + accuracy: `user_category_source TEXT`
  (`'ai'|'rule'|'teller_map'|'manual'|'review'`) records HOW `user_category`
  was set; `category_verified_at TIMESTAMPTZ` + `category_was_correct BOOLEAN`
  capture the user's verdict when reviewing a sampled AI categorization. The
  accuracy sampler (`GET /api/categorize/accuracy[-sample]`,
  `POST /api/categorize/accuracy-review`) targets `user_category_source = 'ai'`
  (partial index `idx_txn_cat_source_ai`) and a "wrong" verdict keeps the row
  `'ai'`-sourced so the miss counts in the running accuracy %, while the
  corrected category still wins via `user_category`. Re-categorizing a row
  clears the prior verdict.
- `transaction_splits` (Phase B3): subdivides a single Teller transaction into
  multiple `(amount, category, merchant_name, notes)` rows that REPLACE the
  parent in per-category aggregations. `parent_transaction_id` references
  `transactions(transaction_id)` with `ON DELETE CASCADE`. Indexed by parent.
- `transactions.personal_for TEXT` (CHECK `personal_for IS NULL OR
  personal_for IN ('self','partner')`): per-transaction settlement override
  for shared cards. `NULL` = use the account's `spending_split_pct`;
  `'self'` = user owes 100% of the charge; `'partner'` = the other
  cardholder owes 100%. Only honored when the linked account is
  `is_shared = true`; on non-shared accounts the SPLIT_AMOUNT formula
  falls back to the spending_split_pct path regardless of value. Set
  via `PATCH /api/transactions/:id { personal_for: 'self'|'partner'|null }`
  (invalid values silently coerced to NULL).
- `user_settings.partner_name TEXT`: display name for the other
  cardholder on a shared card. Surfaces in the Settlement widget
  ("Sarah owes you $X" rather than "Partner owes you $X") and is
  returned by `GET /api/shared-settlement`. NULL/empty falls back to
  literal "Partner". Set via `PATCH /api/settings { partner_name }`,
  max 50 chars.
- `financial_goals` funding columns (Phase C): `funding_account_id INT REFERENCES
  linked_accounts(id)`, `funding_investment_id INT REFERENCES investment_accounts(id)`,
  `goal_baseline_amount NUMERIC(14,2)`. CHECK `chk_goal_funding_exclusive`
  enforces that at most one of the two FK columns is non-null. When a funding
  source is linked, GET `/api/goals` computes `current_amount =
  account_balance - goal_baseline_amount` instead of returning the stored value.
- `user_settings` Phase A auto-sync: `auto_sync_enabled BOOLEAN DEFAULT false`,
  `auto_sync_interval_hours INT DEFAULT 6`, `last_auto_sync_at TIMESTAMPTZ`.
  Drives the in-process scheduled sync task in `server.js`.
- `user_settings` includes Per-sistant config: `persistent_url TEXT`,
  `persistent_webhook_secret_enc BYTEA` (encrypted at rest with `pgp_sym_encrypt`,
  same passphrase as Teller/Plaid tokens), `persistent_webhook_enabled BOOLEAN`
- `user_settings.last_anomaly_check_at TIMESTAMPTZ` — watermark used by the post-sync
  anomaly notifier (`POST /api/sync`) to dedupe push notifications. Only transactions
  whose `created_at > last_anomaly_check_at` are considered candidates, so the same
  anomaly never re-pushes on subsequent syncs. If the notify dispatch throws,
  the watermark is held back so the next sync re-considers the same candidates —
  a transient `sendToAll` error no longer permanently silences the anomaly.
- `user_settings.last_dashboard_view_at TIMESTAMPTZ` — watermark for the
  "Since you last looked" dashboard widget. Read by `GET /api/whats-new`
  to scope the response (new txns / new subs / balance deltas /
  notifications since this timestamp). Bumped by `POST /api/whats-new/seen`,
  which the widget fires 4 s after first render so a quick nav-away
  doesn't lose the unseen state. Defaults to "24 h ago" on first load
  so brand-new installations return one day of context rather than
  an empty card.
- `user_settings.weekly_digest_enabled BOOLEAN NOT NULL DEFAULT false`,
  `weekly_digest_day INT NOT NULL DEFAULT 1` (0=Sun..6=Sat),
  `last_weekly_digest_at TIMESTAMPTZ`: opt-in standing weekly-summary
  email channel (S2). Independent of the per-insight
  `insights_generated` email. Toggle + day selector live in Settings →
  AI Insights. The hourly scheduler in `startup.js` calls `runWeeklyDigest()`
  on the configured day; the helper gates on a 6-day window from
  `last_weekly_digest_at` to dedupe multiple ticks within the day.
- `user_settings.daily_digest_enabled BOOLEAN NOT NULL DEFAULT false`,
  `last_daily_digest_at TIMESTAMPTZ`: opt-in once-per-day "yesterday's
  activity" email channel (#19). Toggle in Settings → AI Insights. The
  hourly scheduler calls `runDailyDigest()`; the helper dedupes with a
  20-hour gate from `last_daily_digest_at` and skips silently when
  `gatherWhatsNew(now - 24h)` returns zero counts.
- `user_settings.target_allocation_pct JSONB NOT NULL DEFAULT '{}'::jsonb`:
  per-asset-class target weights for the Investments performance card.
  Keys are lowercase `security_type` (etf, equity, bond, etc.); values
  are 0-100 numeric. `GET /api/investments/performance` joins these to
  the actual portfolio breakdown and emits `target_pct` + `drift_pct`
  per asset class. Empty `{}` → no drift fields on the response. Set
  via Settings → Target Allocation form.
- `user_settings` FIRE assumptions: `fire_expected_return_pct NUMERIC(5,2)`
  (annual real return, 0-20, default 5 when NULL),
  `fire_withdrawal_rate_pct NUMERIC(5,2)` (safe withdrawal rate, 1-10,
  default 4 when NULL), `fire_monthly_spending_override NUMERIC(12,2)`
  (optional retirement-spending override; NULL = use trailing completed-month
  average). Read by `GET /api/fire-projection` (goals.js) and the ask.js
  `get_fire_projection` tool; editable inline on the Goals-page FIRE card
  via `PATCH /api/settings`.
- `user_settings` data freshness: `last_txn_sync_at TIMESTAMPTZ` (updated by
  `POST /api/sync`), `last_balance_sync_at TIMESTAMPTZ` (updated by
  `POST /api/sync-balances`). The nav badge uses the most recent of these plus
  `last_auto_sync_at` to display staleness.
- `user_settings.last_sync_result JSONB` — structured summary of the most recent
  sync run (any path): `{ at, errors: [{ provider, institution, error }] }`.
  Written by `recordSyncResult()` (`routes/enrollments.js`) from `POST /api/sync`,
  `POST /api/sync-balances`, and the bank auto-sync scheduler (the comprehensive,
  all-provider writer). Surfaced by `GET /api/data-health` as `issues[]` + the
  raw `last_sync_result`, so a per-item error that does NOT disconnect an
  enrollment — notably `decryption_failed` (passphrase mismatch) — is visible in
  the Sync Health card instead of staying silent on scheduled runs (addition D).
  A PARTIAL Teller failure (one account in an enrollment fetched cleanly, a
  sibling threw, so the watermark was held back per INV-02) surfaces as
  `partial_sync_incomplete` here too, instead of the enrollment reporting a clean
  success — `enrollments_synced` counts it as synced (it did connect) but the
  errors[] entry flags that a range still needs a retry (F15).
  The auto-sync fires a one-shot "Sync error" notification only when the error
  signature CHANGES, so a persistent mismatch doesn't spam hourly. A *wholesale*
  Plaid balance/holdings throw inside `POST /api/sync-balances` (vs. the per-item
  errors the helpers collect) is also captured into `last_sync_result` now, so a
  total Plaid failure surfaces on the Sync Health card instead of only the log
  (BS-6).
- `user_settings.shell_idle_timeout_minutes INT NOT NULL DEFAULT 60`: how
  many minutes of inactivity before the unified-shell PIN is required again
  (sliding window — every authenticated request resets the timer). Read by
  `shell/middleware/auth.js` with a 60s in-memory cache; the cache is
  invalidated on `PATCH /api/settings` via a hook the shell registers on
  Perfin's Express app. Bounded 5–10080 minutes (5 min … 7 days) at the
  PATCH layer.
- `budgets` rollover columns: `rollover_enabled BOOLEAN DEFAULT false`,
  `budget_type TEXT DEFAULT 'recurring'` (recurring or one_time),
  `effective_month TEXT` (YYYY-MM, only used for one_time budgets).
- `budget_snapshots`: monthly spending snapshots per budget for trend analysis.
  Columns: `budget_id`, `month` (YYYY-MM), `monthly_limit`, `spent`, `rollover_amount`.
  UNIQUE on (budget_id, month). Created via `POST /api/budgets/snapshot`.
- `categorization_rules`: persistent merchant→category rules. Columns: `merchant_pattern`,
  `category`, `match_type` (contains/exact/starts_with), `is_active`, `times_applied`.
  UNIQUE on (merchant_pattern, category). Applied before AI in `POST /api/categorize`.
- `manual_bills`: user-created expected charges for the bill calendar. Columns: `name`,
  `amount`, `due_day` (1-31), `cadence` (monthly/quarterly/yearly), `category`,
  `is_active`, `notes`. Integrated into `/api/bill-calendar`.
- `watchlist_items`: user-curated list of merchants / categories /
  keywords to monitor. Columns: `type` (CHECK enum: `merchant`,
  `category`, `keyword`), `value`, `notes`, `is_active`. UNIQUE
  on (type, value) so POSTing an existing item re-activates it
  rather than failing. Edited via Settings → Watchlist; rendered
  into the Watchlist sheet tab with the last 90 days of matching
  transactions on each Sheets sync.
- `credit_scores`: manual-entry credit score history. Columns: `score` (INT,
  CHECK 300-850), `score_type` (CHECK: fico/vantagescore/other), `source`,
  `notes`, `checked_at` (DATE). UNIQUE on (checked_at, score_type) so
  same-day re-entry upserts. Dashboard widget renders current + trend;
  AI insights sees the last 6 entries. Synced to Google Sheets "Credit
  Scores" tab with per-entry Change column.
- `bill_payments`: tracks which bills have been paid. Columns: `bill_source`
  (subscription or manual), `bill_id`, `paid_date`, `paid_amount`, `notes`.
  UNIQUE on (bill_source, bill_id, paid_date). Calendar shows paid state.
- `payee_obligations`: Rent & Utilities ledger rows. Columns: `payee`,
  `category` (CHECK rent/utility/other), `label` ('Rent', 'Electricity', …),
  `period` (YYYY-MM), `amount NUMERIC(12,2)` (NULL = awaiting bill),
  `due_day` (1-31), `status` (CHECK `pending_amount`/`unpaid`/`paid`),
  `paid_payment_id` (FK-by-convention to `payee_payments` — the route reverts
  status on payment delete, no DB cascade), `notes`, `auto_generated`. UNIQUE
  (payee, period, category, label) so monthly generation is idempotent.
  Balance owed = SUM(amount) WHERE status='unpaid'.
- `payee_payments`: a transfer settling a batch of obligations. Columns:
  `payee`, `paid_date`, `amount`, `memo` (auto-derived from covered months when
  blank). Obligations point back via `paid_payment_id`.
- `user_settings.housing_config JSONB NOT NULL DEFAULT '{}'`: Rent & Utilities
  config — `{ enabled, payee_name, rent_amount, rent_due_day, reminder_lead_days,
  start_month, utilities: [{label, cadence_months, due_day, anchor}] }`. Read by
  `routes/housing.js getConfig()`; drives monthly obligation generation +
  reminders. `start_month` is preserved across edits so the generation window
  doesn't shift.
- `notification_log`: in-app notification history. Columns: `type`, `title`, `body`,
  `data` (JSONB), `is_read`. `sendToAll()` inserts here on every push notification.
  Indexed on (is_read, created_at DESC) for fast unread queries.
- `ai_audit_log`: post-generation insight validation results. Columns: `insight_id`
  (FK to financial_insights), `module`, `severity` (critical/warning/info),
  `check_type` (tier1-4), `claim_text`, `expected_value`, `actual_value`.
  Indexed on (insight_id, severity).
- `financial_insights.entry_type TEXT NOT NULL DEFAULT 'insight'`: discriminator
  that lets `/api/categorize` (`'categorize'`) and `/api/insights/rebuild`
  (`'rebuild'`) write their AI usage rows to the same table without
  shadowing the user-facing "AI Insights" feed. Display queries (`GET
  /api/insights`, the previous-insight reference inside `POST /api/insights`,
  the `/api/insights/rebuild` source timeline) filter `entry_type = 'insight'`.
  The shared monthly-budget cost queries do NOT filter — `'insight'`,
  `'categorize'`, AND `'rebuild'` rows all count toward
  `INSIGHTS_MONTHLY_BUDGET_CENTS`. Without this, categorize and rebuild were
  read-only against the cap (checked it but never charged themselves).
- `financial_insights.user_feedback TEXT`, `user_feedback_text TEXT`,
  `user_feedback_at TIMESTAMPTZ`: per-row trust-loop signal set by the
  dashboard's thumbs-up/down/mixed buttons. `user_feedback` is enum-guarded
  via `CHECK (user_feedback IS NULL OR user_feedback IN ('positive',
  'negative', 'mixed'))`. `generateInsights()` pulls the latest 5 rated
  insights and renders them into the next prompt under a
  `=== USER FEEDBACK ON RECENT INSIGHTS ===` block so Claude can adjust.
  Cleared by passing `feedback: null` to `PATCH /api/insights/:id/feedback`.
- `financial_insights.audited_at TIMESTAMPTZ`, `audit_incomplete BOOLEAN NOT
  NULL DEFAULT false`: per-run audit completion marker (AI-5/AI-6). `auditInsight`
  stamps `audited_at = now()` after running all four tiers and sets
  `audit_incomplete = true` when any tier's DB query threw (and thus produced
  no findings). `getAuditAccuracy` counts only `audited_at IS NOT NULL AND NOT
  audit_incomplete` runs in its clean/total tally, so a genuinely-clean run
  (audited, zero findings) is distinguishable from one that was never audited
  or failed silently — the latter surface as `incomplete_runs`.
- `user_settings.insights_running_summary_json JSONB`: structured AI long-term
  memory — `{ trends, completed_goals, pending_actions, alerts }`. Replaces the
  legacy plain-text `insights_running_summary` (TEXT column still populated
  with a human-readable rendering for backward compat). Written by every
  successful POST `/api/insights` and cleared by POST `/api/insights/reset`.
  Validated through `sanitizeStructuredSummary` (max items per array, string
  length caps, enum guardrails) so a pathological tool response can't pollute
  long-term memory.
- `account_balance_snapshots`: daily per-account balance history for charting
  performance over time. Columns: `source TEXT CHECK IN ('linked','investment')`,
  `source_id INT`, `snapshot_date DATE`, `balance NUMERIC(14,2)`,
  `available_balance`, `current_balance`. UNIQUE (source, source_id,
  snapshot_date) so intra-day re-syncs upsert one row per account per day.
  Polymorphic source — `'linked'` references `linked_accounts.id` (covers
  Teller-linked accounts), `'investment'` references `investment_accounts.id`
  (covers manual + Plaid). Lack of FK is deliberate — both source tables
  exist independently. Written from `syncAllBalances` and the Plaid
  `/api/plaid/sync-holdings` path; read by `GET /api/accounts/:id/balance-history`.
  Plaid sync collects its per-account snapshot rows during the sync loop and
  flushes them as a single batched INSERT … ON CONFLICT DO UPDATE so either
  all of today's Plaid snapshots land or none do; Teller's `syncAllBalances`
  still inserts per-row.

## Recurring Transfer Detection
Transfers are identified by keyword matching on merchant_name/name fields:
- **peer_transfer**: zelle, venmo, cash app, paypal
- **bill_payment**: autopay, minimum payment, credit card payment, loan payment, mortgage payment
- **savings**: savings, emergency fund
- **investment**: vanguard, fidelity, schwab, robinhood, betterment, 401k
- **internal**: funds transfer, ach transfer, wire transfer, online transfer
- Merchant grouping uses `COALESCE(user_merchant_name, merchant_name, name)`
  (parallel to subscription detection) so user-merged merchant variants share a
  single recurring-transfer entry instead of fragmenting across raw merchant strings.
- Detection algorithm reuses subscription detection gap analysis (findModeAmount, addDays)
  with wider 15% amount tolerance and 7/14-day cadences for weekly/biweekly patterns
- Cadences ≥60 days (bi-monthly, quarterly, yearly) require only 2+ occurrences
  (1 matching gap); shorter cadences (7/14/30) require 3+ occurrences. Both the
  occurrence floor and the matching-gap threshold gate on `>= 60` — previously
  the gap threshold was `>= 90`, so a 60-day transfer still demanded 3 occurrences
  and the 2-occurrence allowance was unreachable (F4).
- Outgoing and incoming transactions analyzed as separate streams
- Outgoing recurring transfers integrated into cash flow forecast
- User-dismissed transfers are preserved across detection runs: the upsert's
  `is_active` CASE checks `is_dismissed` and keeps dismissed transfers inactive,
  mirroring the subscription detection logic

### Detection-key migration window
Subscription and transfer detection now key on
`COALESCE(user_merchant_name, merchant_name, name)`. Pre-existing rows in
`detected_subscriptions` and `recurring_transfers` keyed by the raw
`merchant_name` will not match the new key, so on the first detection run
after the upgrade a user with active `user_merchant_name` overrides may see
a parallel duplicate row appear under the new (merged) name.

A one-time cleanup runs ONCE during the v3 schema upgrade (gated on
`currentVersion < 3`, PSA1 — previously it ran on every startup): it
deactivates any subscription/transfer row whose `merchant_key` matches
`transactions.merchant_name` AND whose underlying transactions have a
differing `user_merchant_name` override set. This auto-retires the orphans
without waiting for the 120-day staleness sweep. It's gated to run once
because the predicate could otherwise deactivate an unrelated active row if
two distinct merchants share a raw `merchant_name` and one is renamed — and
the orphans only ever arose from the one-time raw→COALESCE key migration, so
re-running it every boot bought nothing but that re-exposure. Users who still
see duplicates after the upgrade (e.g. orphans without matching transaction
rows) can dismiss them from the UI or run `POST /api/cleanup`.

## Security
- **CSP nonces**: Per-request `crypto.randomBytes(16)` nonce for all inline scripts.
  No `'unsafe-inline'` in `scriptSrc`. Nonce passed via `res.locals.nonce` to EJS templates.
  Style policy is split (CSP Level 3): `styleSrcElem` requires the nonce on
  `<style>` blocks (the only such block lives in `partials/head.ejs` and now
  carries `nonce="<%= nonce %>"`). `styleSrcAttr` keeps `'unsafe-inline'` so the
  hundreds of inline `style="..."` attributes across templates continue to
  work; migrating each one is out of scope for now.
- **Shell-layer CSP + clickjacking guard (W1)**: the unified shell (`shell/index.js`)
  mounts its OWN `helmet` so its routes — the PIN `login`, the landing tile picker,
  icons, `/health` — get a nonce-based CSP + `frame-ancestors 'none'` + `X-Frame-Options`
  (previously the shell sent NO security headers, leaving the auth page framable). The
  shell nonce flows to `res.locals.nonce`; the two inline `<script>`s in
  `shell/views/login.ejs` carry `nonce="<%= nonce %>"`. **COOP/CORP/COEP are explicitly
  disabled** in the shell helmet because that middleware runs for sub-app requests too and
  `Cross-Origin-Opener-Policy: same-origin` breaks the Plaid/Teller Link popup/iframe flows
  (which rely on cross-origin `window.opener` postMessage) on Perfin's accounts page. Each
  sub-app still sets its own stricter, vendor-allowlisted CSP, which overwrites this baseline
  for its responses. `helmet` is declared in `shell/package.json` (not just hoisted) so the
  shell boot doesn't depend on a sub-app keeping the dep.
- **Logout clears the shell session (W2)**: Perfin's "Sign Out" POSTs the ROOT `/logout`
  (shell-owned `auth.handleLogout`, clears the `shell_session` cookie) and redirects to the
  root `/login` — both un-prefixed, never basePath'd. The earlier `/api/logout` + basePath'd
  redirect 404'd and left the shell session intact, so Sign Out didn't actually sign out.
- **Client session-expiry handling (W3)**: `apiFetch` (`perfin-shared.js`) redirects once to
  `/login` on a 401 or a followed `302→/login` (loop-guarded), so a mid-session idle timeout
  sends the user to re-auth instead of silently rendering a blank/error UI.
- **CORS**: Rejects cross-origin requests when `ALLOWED_ORIGINS` not configured
- **API key**: Header-only (`X-API-Key`), no query string support
- **Token encryption**: pgcrypto `pgp_sym_encrypt` for Teller/Plaid access tokens AND the Per-sistant webhook HMAC secret (`persistent_webhook_secret_enc`) at rest, all keyed by `TOKEN_ENCRYPTION_PASSPHRASE`
- **Session**: Secure cookies, configurable timeout, CSRF custom header check.
  The pgSession store only attaches when `AUTH_SECRET` is set
  (`SESSION_PASSWORD` or `SESSION_PIN` configured). Under the unified shell
  (where the shell PIN gate handles auth) and standalone-without-auth
  configurations, the per-app session never gets written, so the in-memory
  default suffices and the `session` table is no longer maintained for nothing.
- **Rate limiting**: General (100/15min), tight (5/1min) for sync/detect, login (10/15min),
  SSO validate (10/15min). Shell layer (the sole auth gate): `authLimiter`
  (10 failed/15min, `skipSuccessfulRequests`) on `POST /login` and the
  biometric `authenticate`/`authenticate-options` endpoints, plus `apiKeyLimiter`
  (20/15min) that counts only FAILED `x-api-key` attempts (skips header-less
  browser traffic and successful cron requests). Replaces the prior
  defenseless single 750ms delay.
- **Shell login redirect guard**: `auth.safeReturnTo()` only allows same-origin
  absolute paths for the post-login `return_to` — it rejects scheme-relative
  `//host` targets and backslash paths, so the login endpoint can't be turned
  into an open redirect (a naive `startsWith("/")` would have let `//evil.com`
  through).
- **SSO replay protection**: Each SSO token embeds a 12-byte (96-bit) random nonce; validate tracks
  used nonces in an in-memory Map (2-minute TTL cleanup) and rejects duplicates. Nonce is
  consumed after signature verification so timing attacks can't burn legitimate nonces.
  Additionally, the nonce is *reserved* immediately before HMAC verification (atomic
  check-and-set) to prevent concurrent requests with the same token from both passing.
  If signature verification fails, the reservation is released so legitimate nonces
  aren't burned by bad signatures.
- **WebAuthn rpID**: Derived per-request from `req.hostname` (not cached at module scope),
  so deployments behind proxies with multiple hostnames or DNS changes work correctly.
  The shell verify path pins `requireUserVerification: true` on
  `verifyAuthenticationResponse` (matching the `userVerification:"required"` it
  requests) — @simplewebauthn v11 already defaults it true, so this is a
  defense-in-depth pin against a future SDK-default flip (PSA2).
- **WebAuthn transports**: registration persists the authenticator's
  `transports` (`webauthn_credentials.transports TEXT[]`), but BOTH
  authenticate-options endpoints (shell + standalone) deliberately advertise
  `transports: ['internal']` ONLY in `allowCredentials` at login. Registration
  pins `authenticatorAttachment: 'platform'`, so every credential lives on the
  same device — and echoing the authenticator's `'hybrid'` transport (which
  iCloud/synced passkeys report) is exactly what made browsers surface the
  cross-device "use a phone" QR option instead of going straight to Touch/Face
  ID. Internal-only suppresses that QR path and sends the browser to the local
  biometric. (Earlier this echoed the stored transports with an
  `['internal','hybrid']` fallback, which kept the QR option visible — the
  `'hybrid'` advert was the bug.) The real transports are still stored at
  registration; they're just not used as the login hint. Pinned by
  tests/budget-cap-webauthn.test.js.
- **Biometric registration UI**: Settings → Security → "Biometric Login"
  section lists registered credentials and provides Register / Remove
  buttons via the existing `/api/webauthn/*` endpoints. The register
  endpoints accept shell-authenticated requests (`req.app.get("embedded")`,
  INV-25) — they previously checked only Perfin's own session, which is never
  written under the unified shell, so registration always 401'd for shell
  users (found during PWA Phase-0 testing). Section auto-hides
  on browsers without `window.PublicKeyCredential` or when the WebAuthn
  SDK isn't installed (server returns 501). Works under both standalone
  and unified-shell deployments — registration always happens against
  Perfin's webauthn_credentials table; the shell-layer login endpoints
  read from that same pool.
- **Teller API**: mTLS client certificates, retry with exponential backoff (1s/2s/4s), 30s timeout
- **AI prompt sanitization**: Two layers, with different scopes. First,
  `sanitizeForPrompt()` in `routes/insights.js` strips `---RUNNING_SUMMARY---`
  patterns and consecutive dashes from user-controlled strings (merchant
  names, goal names, transfer display names) before interpolating them into
  the AI prompt. It is **not** a general prompt-injection defense — payloads
  like "ignore previous instructions" pass through unchanged. Its only job
  is neutralizing structural markers that could mimic a parsed delimiter,
  in case the tool_use-replaced delimiter-parsing path ever re-enters the
  codebase. Perfin is a single-operator app, so the only attacker is the
  operator. Second, `sanitizeStructuredSummary()` enforces hard shape/length
  bounds (max items per array, string length caps, enum guardrails) on the
  structured summary the AI returns via tool_use, so a pathological tool
  response can't pollute long-term memory. When validation fails the prior
  summary is preserved and the response carries
  `summary_status: "preserved_validation_failed"`.
- **Subscription matching**: Word boundary regex to prevent false positives

## Scheduled Tasks (intervals)
All run automatically after server startup — and the CRITICAL ones are
additionally guaranteed out-of-process by GitHub Actions cron (so Render
free-tier sleep can't skip them): `daily-sync.yml` (transactions + balances/
holdings/flows + net-worth snapshot + detection, daily 7AM UTC) and
`weekly-reconcile.yml` (Teller 90-day reconcile, Sundays). Both hit the
x-api-key'd endpoints; all writes are idempotent so overlap with the
in-process jobs is harmless. Per-app jobs live in
`teller/startup.js`; keep-alive runs at the shell layer (`shell/index.js`)
under the unified shell so the timezone-aware self-ping fires regardless of
which sub-app owns its own listener (sub-app `startKeepAlive` is no-op in
embedded mode).
- **Keep-alive ping** (shell layer): every 14 min (timezone-aware active hours, 10s timeout); reads `keep_alive_enabled` and active-hours from Perfin's `user_settings` each tick
- **Sheets auto-sync**: every 1 hour (daily/weekly/monthly cadence from settings)
- **Net worth snapshot**: every 1 hour (`ON CONFLICT (snapshot_date) DO UPDATE` so a same-day re-run rewrites the row with the latest balances — late-arriving syncs are reflected immediately). Computes the figure via the shared `getNetWorth()` helper, so this job, `syncAllBalances`, and `POST /api/net-worth/snapshot` all write the same investment-deduped value (F1)
- **Goal milestones**: every 6 hours (push notifications at 25/50/75/100%)
- **AI insights auto-trigger**: every 6 hours (respects `insights_cadence_days` setting).
  Pre-analysis sync chain: syncAllEnrollments → syncAllPlaidTransactions →
  syncAllPlaidHoldings → syncAllBalances → detect subscriptions →
  detect transfers → categorize → generate insights → audit → email webhook.
  Ensures AI analyzes freshest data. Auto-categorization runs as part of this pipeline.
- **Budget alerts**: every 3 hours (push notifications at 80% and 100%+ thresholds, aligned with the in-app `/api/budgets/alerts` `warning`/`critical` levels). Like the endpoint, the push compares against the effective limit (base + current-month rollover) and skips one-time budgets outside their `effective_month`. The in-app `info`/pace heuristic is intentionally not pushed (too noisy as a notification). **Deduped to at most one notification per category+severity per 24h** via `sentRecently(tag, 24)` (`routes/notifications.js`, backed by `notification_log`) — previously a category that stayed over budget re-logged a notification on every 3-hour tick for the rest of the month. Escalation (warn → over) still fires immediately because the two severities use distinct tags.
- **Budget snapshot auto-trigger**: every 6 hours, creates a snapshot for the
  previous (now-complete) month (spending + rollover amounts) so budget rollover
  advances automatically. Idempotent — skips if a snapshot for that month already
  exists. Runs on EVERY tick (not only the 1st) so a snapshot missed because the
  process was asleep/inactive on the 1st is caught up on any later tick that
  month (M5) — the prior month is complete regardless of which day it runs, so
  timing within the month doesn't matter. Gated on user activity.
- **Bank auto-sync** (Phase A): every 1 hour, checks `auto_sync_enabled` and whether
  `auto_sync_interval_hours` has elapsed since `last_auto_sync_at`. When due, calls
  `syncAllEnrollments()` (Teller) then `syncAllPlaidTransactions()` (Plaid) then
  `syncAllPlaidHoldings()` (Plaid investments) then `syncAllPlaidInvestmentFlows()`
  (external cash flows for TWR/XIRR) then
  `syncAllBalances()` then `runCategorize()` in-process — never via HTTP
  self-fetch, so API_KEY-protected deployments don't 401 against themselves.
  The trailing `runCategorize()` step gives a categorization sweep on every
  sync (free rule + Teller-map paths over the whole backlog + a bounded AI
  batch) so the uncategorized count doesn't pile up between the 30-day AI-
  insights cadence runs. Updates `last_auto_sync_at` on every
  check (success or partial failure).
  Push notification only fires when at least one transaction was added, at
  least one balance was updated, or a sync failed — silent successful syncs
  no longer produce hourly notification noise. Failed syncs still notify
  under "Auto-sync issue" so the user knows the data isn't fresh.
  Note: on Render free tier, scheduled syncs only fire while the process is awake;
  enable `keep_alive_enabled` if you need guaranteed cadence.
- **CSV import reminders**: every 24 hours, checks manual (CSV-only) accounts
  whose most recent CSV import is older than `csv_reminder_days` setting.
  Sends notification listing specific account names needing a fresh upload.
- **Rent & Utilities ledger**: every 6 hours (activity-gated). Calls
  `generateHousingObligations()` (idempotently create this/missing months' rent
  + utility placeholders from `housing_config`) then `runHousingReminders()`
  (payment-due + missing-utility-amount push notifications, deduped via
  `sentRecently` to ≤1 per ~3 days). No-op when the ledger isn't configured.
  In-process helpers (INV-18).
- **Self-healing reconcile**: every 1 hour, acts at most weekly (gated on
  `last_reconcile_at`). Runs `reconcileTeller(90)` — re-fetches the trailing
  90 days from every Teller enrollment regardless of the incremental
  watermark, recovering any transactions a prior sync dropped (same-day late
  arrivals, a failed-sibling-account skip) via idempotent upserts. Teller
  only (free, cheap); Plaid reconcile is heavier (full cursor re-walk) and
  stays a manual `POST /api/sync/reconcile` action. Not gated on user
  activity — a weekly background heal should run even while the user is away.
- **Weekly digest**: every 1 hour, checks `weekly_digest_enabled` and that
  today matches `weekly_digest_day` (0=Sun..6=Sat). When both match,
  invokes `runWeeklyDigest()` in `routes/insights.js`, which itself gates
  on a 6-day window from `last_weekly_digest_at` (so multiple hourly
  ticks on the configured day are idempotent). On success, fires the
  `weekly_summary` webhook to Per-sistant and bumps the watermark. No
  AI call — body is rendered from `insights_running_summary_json`.
- **Daily digest**: every 1 hour, invokes `runDailyDigest()` in
  `routes/insights.js`. The helper bails if `daily_digest_enabled` is
  false, dedupes via a 20-hour window from `last_daily_digest_at` (so
  one digest per "day" lands regardless of clock-edge ticks), and skips
  silently when `gatherWhatsNew(now - 24h)` returns zero counts (no
  point mailing an empty "yesterday" digest). On send, fires the
  `daily_summary` webhook to Per-sistant. No AI call.
- **Missed-job watchdog**: ~2 minutes after boot, then every 6 hours
  (activity-gated). Every scheduled interval above calls
  `jobHealth.tick(name)` as its first statement — BEFORE the activity
  gate, recorded in memory only so the Neon idle-gate stays intact. The
  watchdog flushes ticks to the `job_runs` table and pushes a
  "Scheduled jobs missed" notification (tag `jobs-missed`) when any
  job's last persisted tick is older than max(4× its interval, 36h) —
  i.e. the process wasn't running at all (free-tier sleep with
  keep-alive off, crash loop). Alerts once per outage: the sorted
  missed-job list is a signature stored on the `_watchdog` row, and an
  unchanged signature doesn't re-notify. Normal overnight sleeps stay
  under the 36h floor by design. Jobs with no row yet (fresh install)
  never alarm.

## Shared Account Spending Split
All spending queries apply the `SPLIT_AMOUNT` SQL fragment from
`services/financial-queries.js`. As of the Settlement feature it's a CASE
expression with two layers — per-transaction `personal_for` override
(only on shared accounts) on top of the account-level `spending_split_pct`:
```sql
(CASE
   WHEN la.is_shared AND t.personal_for = 'self'    THEN t.amount
   WHEN la.is_shared AND t.personal_for = 'partner' THEN 0
   ELSE t.amount * COALESCE(la.spending_split_pct, 100) / 100.0
 END)
```
Non-shared accounts always fall through to the spending_split_pct branch
(which defaults to 100 = full amount). `routes/spending-analytics.js`
(spending-summary monthly/category/merchants, cash-flow daily/DOW averages,
spending-yoy), `routes/insights.js` (anomaly baseline + candidate, seasonal
patterns), and `routes/subscriptions.js` (bill-calendar income) **IMPORT**
`SPLIT_AMOUNT` / `NOT_TRANSFER` / `INCOME_PREDICATE` from
`financial-queries.js` and template-interpolate them — they are NOT
independent copies and cannot drift. Aliased variants are derived in place,
never re-typed: the split-row variant via `SPLIT_AMOUNT.replace(/t\.amount/g,
"s.amount")`, insights' anomaly-baseline subquery via `SPLIT_AMOUNT_2 =
SPLIT_AMOUNT.replace(/\bla\./g, "la2.").replace(/\bt\./g, "t2.")` and
`NOT_TRANSFER.replace(/\bt\./g, "t2.")`. (The June 2026 seams audit found and
converted the last literal copies — two in cash-flow, seven in insights
anomaly/seasonal; `tests/seams-audit.test.js` now scans every route/service
file and fails on any future re-inlining. The settlement endpoint's per-bucket
`FILTER (WHERE t.personal_for = …)` clauses are NOT copies of this CASE — they
implement the deliberately different who-owes-who bucket math.) The only place
that holds a TRUE inline copy (because it can't `require` the services layer)
is the standalone `scripts/sheets-sync.js` (verified byte-matching the
canonical) and the legacy Apps Script `apps-script/Code.gs` fork.
The standalone `scripts/sheets-sync.js` `buildDashboard` also
inlines a `SPLIT_AMT` + `NOT_TRANSFER` + reimbursed-exclusion copy (it can't
import the services layer). As of M4 it ALSO mirrors splits-REPLACEMENT for its
per-category surfaces — a splits-aware `cat_lines` CTE (parent_no_splits ∪
from_splits) backs the Spending-by-Category, category×month pivot, and Budget
Status queries, so per-category Sheets totals now match the in-app category
totals. Total aggregations (monthly trend, 6-month totals) and Top Merchants
stay parent-keyed by design — splits sum to their parent, so those totals are
unchanged either way. Any new spending aggregation should import `SPLIT_AMOUNT`
rather than re-inline.

This affects: spending-summary (monthly_trend, byCategory, topMerchants),
savings-rate, spending-yoy, budgets, budget alerts, cash flow, AI insights
anomaly detection + seasonal, and the Settlement widget.

## Income Detection
Income is identified via three OR'd branches in
`services/financial-queries.js INCOME_PREDICATE`. All matching uses Postgres
word-boundary regex (`\y`) on transaction `merchant_name` / `name` (NOT amount
thresholds). Each branch is independently gated:

**Branch (a) — strict keyword match with negative filter.** Matches deposits
that look like payroll/direct-dep traffic AND are NOT excluded as transfers:
- Includes: `\y(payroll|direct dep|direct deposit|dir dep|salary|employer|deposit|ach credit)\y`
- Excludes: `\y(payment|transfer|pymt|zelle|venmo|paypal|cash app|refund|reversal|atm|withdrawal|bill pay)\y`

**Branch (b) — user-authorized brokerage transfer pattern.** Matches the
specific case of paychecks landing in a brokerage account and the user then
transferring to checking, leaving a "Funds transfer from brokerage" credit
that's the real paycheck from the user's perspective. To avoid double-
counting when both ends are linked, branch (b) requires NO matching debit
on a different account within ±2 days (subquery uses `__t2` alias and
unqualified outer references so it works regardless of how the caller
aliases the outer `transactions` table).

**Branch (c) — explicit category match.** `COALESCE(user_category, category[1]) = 'Income'`
covers Plaid's own taxonomy AND any row the user manually overrode to
'Income' via `PATCH /api/transactions/:id/category`.

Constants exported from the same module: `INCOME_PREDICATE` (full predicate),
`NOT_TRANSFER` (the negative-filter list reused by spending queries),
`SPLIT_AMOUNT`, `NOT_REIMBURSED`, `INVESTMENT_ACCOUNT_TYPES`. Used by
`/api/cash-flow`, `/api/savings-rate`, `/api/income-summary`, AI insights
income module, and bill-calendar income detection.

## Key Design Decisions
- **Test-time devDeps re-declared at the root.** Tests in `tests/` directly
  `require('express')`, `require('pg')`, etc., so the repo-root `package.json`
  re-declares the subset that tests directly import (`pg`, `express`,
  `multer`, `csv-parse`, `supertest`). The root's `express` is pinned to v4
  to match `teller/` so tests run against the same Express version the
  primary tested module uses at runtime; `apps/per-sistant/` declares v5 in
  its own workspace. CI runs a single `npm ci` at the root — npm workspaces
  walks shell/, teller/, and apps/per-sistant/ in one pass. Local devs must
  `npm install` at the root before `npm test`.
- **Source-pinned regression tests.** `tests/audit-regressions.test.js` includes
  smoke tests that read source files with `fs.readFileSync` and assert against
  patterns (e.g., `persistent.js` references `process.env.SSO_SECRET` and never
  the legacy `SESSION_SECRET + AUTH_SECRET`). These are intentionally weaker
  than runtime tests but they avoid pulling `express-rate-limit` and other
  deps that aren't installed at the repo root, while still catching the most
  common regression: a code reviewer reverting a fix.
- **Service worker excludes `/api/*`.** The SW caches static assets but never
  API responses. A stale balance shown after the network drops would mislead
  the user worse than a clear "offline" error.
- **API key authenticates external tools, not browser users.** Browsers
  authenticate via session cookie; the `X-API-Key` header path exists for
  cron and external integrations. The dashboard never injects the key into
  the DOM and never appends it to a URL.
- **Shared financial queries.** `services/financial-queries.js` is the
  source of truth for "income" and "spending" computations: keyword-filtered
  payroll/direct-dep income (excluding transfers/payments/refunds) and
  split-adjusted spending that honors `transaction_splits`, the
  account-level `spending_split_pct`, AND the per-transaction `personal_for`
  override on shared accounts (`SPLIT_AMOUNT` is a CASE expression — see
  the Shared Account Spending Split section). AI insights routes through
  it so Claude sees the same numbers the dashboard shows. Helpers:
  - `getMonthlyIncome(pool, months)` — keyword-filtered income, last N months
  - `getMonthlySpending(pool, months)` — split-adjusted spending, last N months.
    Both use a WHOLE-month window (floored to the 1st via `date_trunc`), so the
    oldest bucket is a full month rather than a partial one — callers (savings-
    rate, context-export, AI trends) treat each returned month as complete (FA-4).
    The current month is still included (partial-to-date, as expected in-progress).
  - `getCategorySpendingThisMonth(pool)` — current-month per-category spend
    (anchored to Postgres `CURRENT_DATE` so month-end semantics match the SQL)
  - `getCategorySpendingForMonth(pool, monthStr)` — same shape, but for an
    arbitrary `'YYYY-MM'` month; used by `GET /api/budgets?month=...`,
    `POST /api/budgets/snapshot`, and the budget-snapshot auto-trigger so
    snapshots record the correct month's spending instead of always-this-month.
  - `getNetWorth(pool)` — the single source of truth for net worth (assets,
    liabilities, net_worth, breakdown). For a Plaid brokerage that appears in
    BOTH `linked_accounts` and `investment_accounts`, it keeps the
    `investment_accounts` value (the correct holdings-sum) and drops the
    `linked_accounts` phantom (often $0 from accountsGet) — see the net-worth
    Key Design Decision below. Always includes investments.
  Constants: `INCOME_PREDICATE`, `NOT_TRANSFER`, `SPLIT_AMOUNT`, `NOT_REIMBURSED`.
  `/api/savings-rate` calls `getMonthlyIncome` + `getMonthlySpending`;
  `/api/cash-flow` uses `INCOME_PREDICATE`; `/api/budgets/alerts` and the
  scheduled budget-alert push use `getCategorySpendingThisMonth`;
  `/api/budgets/suggest` uses `getCategorySpendingForMonth` over the trailing 3
  months; `/api/context-export` uses `getMonthlySpending` — so AI suggestions
  and the Claude-chat export see the same split-adjusted numbers as the
  dashboard. The spending-summary monthly-trend path still inlines equivalent
  SQL — any new financial endpoint should use this module instead of re-inlining.
- **Net worth is computed by one shared helper, not re-derived per writer.**
  `getNetWorth(pool)` in `services/financial-queries.js` is the single source of
  truth, used by all three `net_worth_snapshots` writers — the hourly snapshot
  job (`startup.js`), `POST /api/net-worth/snapshot` (`goals.js`), and
  `syncAllBalances` (`enrollments.js`). It sums depository (non-credit, non-loan)
  `linked_accounts` as assets, credit AND loan accounts as liabilities (Plaid
  sets `type='loan'` for all debt subtypes — counting a loan as an asset
  inflated net worth ~2× the loan balance, F1), and active `investment_accounts`
  — but **dedupes the Plaid brokerage that exists in BOTH tables**. A brokerage
  linked via the combined Plaid transactions+investments flow lands in
  `linked_accounts` (often $0 — Schwab et al. report `balances.current=0` at the
  account level and put the real value in holdings) AND `investment_accounts`
  (correct holdings-sum balance). **`investment_accounts` is authoritative**: the
  `linked_accounts` query drops any row whose `account_id` matches an active
  `investment_accounts.plaid_account_id` (`NOT EXISTS (… ia.plaid_account_id =
  la.account_id AND ia.is_active)`), and the `investment_accounts` query is NOT
  filtered against `linked_accounts`. This matches `GET /api/investments`
  (`la.plaid_item_id IS NULL`) and the dashboard accounts grid. Earlier the dedup
  ran the OTHER way (kept the $0 `linked_accounts` phantom, dropped the real
  `investment_accounts` value), so net worth understated by the full brokerage
  value (H1); before THAT (F1), the three writers disagreed — the balance-sync
  writer summed `linked_accounts` only (omitting investments) while the other two
  double-counted the Plaid brokerage. New net-worth surfaces MUST call
  `getNetWorth` rather than re-inlining the assets/liabilities sum.
- **Substring-safe keyword exclusions.** All merchant/transaction keyword
  filters use word-boundary matching — `\b` in JavaScript regex, `\y` in
  Postgres regex (`~*` / `!~*`). The reason: short tokens like `atm`,
  `pymt`, `interest`, `epay`, and `vision` previously substring-matched
  legitimate merchants (AT&T, Atmos Energy, internet ISPs, television-
  related merchants) and either hid them from dashboards or persisted false
  tax deductions. Multi-word phrases still work because `\b` / `\y` anchor
  at phrase edges, not inside the phrase. Sites that follow this pattern:
  `services/financial-queries.js` `INCOME_PREDICATE`,
  `scripts/detect-subscriptions.js` `isExcludedMerchant`,
  `scripts/detect-transfers.js` `classifyTransfer`,
  `teller/data/reference-data.js` `categorizeSubscription` /
  `findCancelUrl`, `routes/insights.js` tax-deduction regex,
  `routes/enrollments.js` top-merchants exclusion. **When adding a new
  keyword filter, do not use `LIKE '%kw%'` or `SIMILAR TO '%kw%'`** — use
  `~*` / `!~*` with `\y(kw1|kw2|...)\y`.
- **User overrides on synced transactions live in `user_*` columns.**
  When a user edits the merchant name or notes on a Teller-sourced
  transaction, the override goes to `transactions.user_merchant_name` /
  `user_notes`; the raw Teller fields are never touched. Display layers use
  `COALESCE(user_merchant_name, merchant_name, name)`. The next sync from
  Teller therefore can't fight the user — `INSERT … ON CONFLICT … DO
  UPDATE SET merchant_name = EXCLUDED.merchant_name` only updates the raw
  field and leaves the user override intact. The same pattern applies to
  `user_category` (category overrides set via `PATCH
  /api/transactions/:id/category`, bulk-category, AND the `/api/categorize`
  rule/Teller-map/AI/rules-apply paths): every display query — including the
  in-app routes (`/api/transactions`, `/api/spending-summary`,
  `/api/spending-yoy`, the financial-queries helpers) AND the Google Sheets
  exporter (`scripts/sheets-sync.js`) — reads the override via
  `COALESCE(user_category, category[1])` so a Teller re-sync can't clobber
  manual categorizations.
- **Goal `current_amount` is derived when funding-linked.** If a goal has
  `funding_account_id` (or `funding_investment_id`) set, GET `/api/goals`
  computes `current_amount = account_balance - goal_baseline_amount` rather
  than reading the stored value. Don't write to `current_amount` directly
  on linked goals — it'll be overwritten on next read. The stored value
  surfaces as `current_amount_manual` for transparency. Linking infers a
  baseline (`account_balance - existing_current_amount`) so the user's
  pre-link progress is preserved. If baseline inference fails (account
  not found, DB error), the funding link is silently dropped from the
  PATCH to prevent `current_amount = balance - 0` from inflating progress.
- **Transaction splits replace parent in category aggregations.** When
  `transaction_splits` rows exist for a parent, every per-category SQL
  aggregation in budgets/spending-summary/scheduled-push uses the splits'
  `(amount, category)` instead of the parent row. Total aggregations
  (monthly trend, cash flow, savings rate) are unchanged because splits
  sum to the parent's amount. New per-category endpoints should call
  `getCategorySpendingThisMonth(pool)` rather than re-implementing the
  CTE — that helper already handles splits + reimbursed + spending-split.
- **Categorization rules first, then AI — free paths sweep the whole backlog,
  only AI is batched.** When `POST /api/categorize` (or `runCategorize`) runs,
  the two FREE deterministic paths — user `categorization_rules` and the
  deterministic Teller/Plaid `TELLER_CATEGORY_MAP` — are applied as **bulk
  `UPDATE … RETURNING` over the ENTIRE uncategorized backlog** (no row cap),
  because they're pure SQL and cost nothing. The paid Claude call **loops** in
  `AI_BATCH` (50)-row pages up to `AI_MAX_PER_RUN` (300) rows per invocation,
  re-checking the shared `INSIGHTS_MONTHLY_BUDGET_CENTS` cap before each page and
  stopping early when the cap is hit (returns `budget_hit: true`) or the backlog
  drains — so one click makes a real dent instead of nibbling 50 rows.
  (Earlier the whole batch — rules + Teller-map + AI — shared a single
  `LIMIT 50`, so one "Categorize" click barely moved a large backlog and the
  uncategorized count looked stuck.) Live progress is published to a module
  tracker polled by `GET /api/categorize/progress` so the Settings button shows
  "AI categorizing… N done" instead of a blind spinner. A user who creates a rule for
  "Amazon" → "Shopping" will never pay for AI to categorize Amazon
  transactions. Rules are matched against `COALESCE(user_merchant_name,
  merchant_name, name)` so user-renamed merchants are also handled. All writes
  go to `user_category` so a Teller/Plaid re-sync can't clobber them. The
  HTTP route still returns 501 when `ANTHROPIC_API_KEY` is unset (the Settings
  button is disabled without it), so the free sweep runs as part of an
  AI-enabled call, not standalone.
- **Categorization engagement loop drives AI cost down.** The dashboard's
  "Review Uncategorized" widget (`GET /api/categorize/review-queue`) shows
  the same set of transactions that would otherwise go to Claude on the
  next AI run. The user picks a category (with a Teller-map suggestion
  pre-filled), optionally checks "Remember" to create a `categorization_rules`
  row via `POST /api/categorize/review`, and the rule base grows. Each rule
  added means future AI cost drops because more rows hit the rule path
  before reaching Claude. Long-term, the AI is reserved for genuinely
  novel merchants.
- **Goal-funding suggestions surface auto-link opportunities.** `GET /api/goals`
  returns `suggested_transfers[]` per goal — the top 5 active recurring
  outgoing transfers whose `transfer_type` matches the goal's funding-source
  kind (savings or investment) and whose monthly amount is within ±25% of
  `monthly_contribution`. Suggestion only — the UI can prompt "Auto-link
  this $500/mo Schwab transfer to House Down Payment?" without auto-linking.
- **Per-account balance history is polymorphic.** `account_balance_snapshots`
  uses a `(source, source_id)` polymorphic reference instead of two parallel
  tables. `source='linked'` rows reference `linked_accounts.id` (Teller-linked
  accounts including investments); `source='investment'` rows reference
  `investment_accounts.id` (Plaid + manual). The lack of FK is deliberate —
  both source tables exist with their own lifecycles, and a polymorphic
  UNIQUE keeps lookups O(1) per (source, source_id, date). Snapshots are
  written from `syncAllBalances` and Plaid `sync-holdings`; one row per
  account per day via `ON CONFLICT DO UPDATE`.
- **Budget rollover uses snapshots, not running totals.** The rollover
  amount is computed by `POST /api/budgets/snapshot` as `MAX(0, limit - spent)`
  and stored in `budget_snapshots` keyed by the month that just ended. The
  rollover that applies to month M is the unused budget from month M-1, so the
  readers (`GET /api/budgets`, `GET /api/budgets/alerts`, and the scheduled
  budget-alert push) add the **prior** month's snapshot `rollover_amount` to the
  base `monthly_limit` to produce `effective_limit` — via `previousMonthKey()`
  (FA-1). (They previously read the *current* month's snapshot, which doesn't
  exist yet or holds this month's own circular underspend, so the carried-over
  amount was silently never applied.) One-time budgets (`budget_type = 'one_time'`) share the
  `UNIQUE(category)` constraint with recurring budgets — you can't have both
  a recurring and one-time budget for the same category. Convert via PATCH.
- **Notification log as audit trail.** `sendToAll()` always writes to
  `notification_log` even when push isn't configured. This means the in-app
  notification center works independently of web push — users who haven't
  granted push permissions or whose push subscriptions expired still see
  their anomaly alerts, budget warnings, and goal milestones in the nav
  bell dropdown. The log is append-only; old notifications are never deleted
  automatically.
- **The scheduler calls helpers in-process, not via HTTP self-fetch.**
  Every route module that the scheduler invokes exports a callable helper
  alongside its Express router:
  - `routes/enrollments.js` → `syncAllEnrollments`, `syncAllBalances`, `reconcileTeller`, `recordSyncResult`
  - `routes/investments.js` → `syncAllPlaidTransactions`, `syncAllPlaidBalances`, `syncAllPlaidHoldings`, `syncAllPlaidInvestmentFlows`, `reconcilePlaidTransactions`
  - `routes/subscriptions.js` → `runSubscriptionDetection`
  - `routes/categorize.js` → `runCategorize`
  - `routes/insights.js` → `generateInsights`
  The HTTP route handlers are thin wrappers around the helpers. The whole
  AI-insights chain (detect → detect-transfers → categorize → insights →
  audit → email webhook) runs in-process from `teller/startup.js`. Earlier
  versions of the auto-trigger used HTTP self-fetches that 401'd through
  the API_KEY middleware (in standalone mode) and through the shell auth
  gate (in embedded mode); the helper-export pattern fixes both. Future
  scheduled tasks that need to invoke route logic should follow the same
  "extract handler into helper, export, reuse" pattern. Helpers return a
  `{ ok, status?, ...body }` discriminated union so HTTP wrappers can map
  to `res.status().json()` and direct callers can branch on `result.ok`.
  Outbound HTTP helpers (`sendPerSistantWebhook`) follow a parallel
  contract: `{ sent: bool, status?, reason?, error? }`. `reason` is an
  enum-style string (`"not_configured"`, `"missing_secret"`,
  `"decryption_failed"`, `"config_error"`) so callers can branch on the specific
  failure mode rather than parsing logs. `getPersistentConfig` decrypts the webhook secret
  in a separate query from the url/enabled read, so a `TOKEN_ENCRYPTION_PASSPHRASE`
  mismatch surfaces as `"decryption_failed"` instead of masquerading as
  `"not_configured"` (SN-3); likewise a DB error on the url/enabled read itself
  returns `{ configError: true }` → reason `"config_error"` rather than the
  misleading `"not_configured"` (F23).
- **"Since last X" watermarks live in `user_settings`, not in cookies.**
  The anomaly notifier (`last_anomaly_check_at`) and the "since you last
  looked" dashboard widget (`last_dashboard_view_at`) both use a single
  TIMESTAMPTZ column on the single-row `user_settings` table to scope
  their respective queries. Storing server-side keeps the dedup logic
  intact across devices and across PIN re-logins, and the single-user
  app design means we never need a per-user dimension. New "since last X"
  features should follow the same pattern instead of inventing a cookie
  or local-storage equivalent.
- **AI user feedback feeds the next prompt, not the running summary.**
  When the user thumbs-down an insight via `PATCH /api/insights/:id/feedback`,
  the rating + optional note are stored on the `financial_insights` row.
  `generateInsights()` pulls the last 5 rated rows and renders a
  `=== USER FEEDBACK ON RECENT INSIGHTS ===` section into the prompt for
  the next run; the structured `insights_running_summary_json` is **not**
  rewritten. Rationale: the summary is Claude's representation of the
  state of the user's finances; user feedback is a meta-signal about
  Claude's outputs. Mixing the two would let one bad insight permanently
  pollute long-term memory. If feedback should ever start retracting
  alerts or pending_actions, that's a separate tool-use schema change.
- **Dashboard widget and email digest share one aggregator.**
  `gatherWhatsNew(since)` in `routes/whats-new.js` is the single source
  of "what changed since X". The HTTP `GET /api/whats-new` route calls
  it with the `last_dashboard_view_at` watermark for the dashboard
  widget; `runDailyDigest()` in `routes/insights.js` calls it with
  `now - 24h` for the daily email digest. Both surfaces always agree
  on what counts as "new" because there's only one query. Any change
  to scope (e.g. capping txn count) lands in one place.
- **Sliding-window shell session, idle window read from DB.** The shell
  PIN cookie's `maxAge` is refreshed on every authenticated request to
  `now + idleMs`. An active session never times out mid-use; an idle one
  expires after the configured window. `idleMs` comes from
  `user_settings.shell_idle_timeout_minutes` via a 60s in-memory cache
  that `PATCH /api/settings` invalidates so changes take effect on the
  next request. Falls back to a 60-minute default if the DB lookup blips
  (fail-open: better to keep an active user signed in on a transient
  error than fail-closed and force re-login). Replaces an earlier fixed
  7-day cookie TTL that gave no idle behavior at all.
- **Shell auth honors `x-api-key` as an alternate credential.** Non-
  browser clients (cron, GitHub Actions like daily-sync.yml and
  keep-alive.yml) send `x-api-key: $API_KEY`. The shell's `requireAuth`
  short-circuits on a valid header (constant-time compare against
  `process.env.API_KEY`) before checking the PIN cookie. Sub-apps still
  skip their own API_KEY check in embedded mode — the shell already
  enforced it, so the request is trusted past the gate. This is also
  why `/perfin/api/sync` works from cron even though it's behind the
  shell auth gate.
- **Cross-app transition animations are auto-init modules.** Both the
  cosmic mask reveal (Per-sistant entry) and the Iron Man materialize
  (Perfin entry) live as CSS+JS pairs under `shell/public/`. Each JS
  file scans for a marker attribute on init (`[data-atrans]` for cosmic,
  `[data-perfin-materialize]` for Iron Man), populates per-overlay
  decorations once, and binds click handlers that activate the overlay
  then navigate. Pages that want the animation just add the attribute
  to the link — no inline `<script>`. Loaded from `/shell-static/*`
  which is mounted before the auth gate.
- **`/shell-static/*` uses `maxAge: 0 + ETag`, not a long cache.** An
  earlier 1-day cache caused stale transition.css/transition.js after
  prod deploys. ETag revalidation keeps the per-request cost tiny
  (~100B for a 304) and avoids the need to bump `?v=` on every edit.
- **Shell serves PWA icons at root paths.** `/apple-touch-icon.png`,
  `/apple-touch-icon-precomposed.png`, `/android-chrome-192x192.png`,
  `/android-chrome-512x512.png` mounted before the auth gate, sourcing
  bytes from `apps/per-sistant/*.png` so there's one copy. iOS Safari's
  "Add to Home Screen" auto-discovers `/apple-touch-icon.png` from any
  origin path — so from `/login`, the landing, or any Perfin/Per-sistant
  page, the unified-shell PWA always installs with the mask-crop icon.
  Perfin's own pages still declare `<link rel="apple-touch-icon">`
  pointing at its helmet SVG, so an "Add to Home Screen" tap from deep
  inside Perfin still gets the helmet bookmark (different visual identity
  per app — a feature, not a bug).
- **Toast stack replaces single status element.** `showMsg(text, ok)` in
  `perfin-shared.js` pushes onto a `#toast-stack` container (auto-created
  on first call) rather than overwriting one shared `#status-msg` div.
  Stack caps at 5 visible toasts; identical consecutive messages dedupe
  (timer bump, no pile-up). Tap to dismiss; auto-dismiss after 5 s
  success / 10 s error. Desktop anchors top-right; mobile (≤640px)
  flips to bottom-right with `column-reverse` + slide-up so toasts are
  thumb-reachable and don't fight the iOS Dynamic Island. Per-page
  `.status-msg` divs are now `display: none !important` — kept in
  templates for backward compat with any direct DOM writes (silent
  no-op). The Accounts page's bespoke `#status` element was retired
  along the same path — its local `showStatus` now delegates to the
  shared `showMsg`.
- **Notification panel becomes a bottom sheet on mobile.** At ≤640px,
  `.notif-panel` flips from a 340 px-wide drop-down (`top: 56 px; right:
  12 px`) to a full-width bottom sheet (`bottom: 0`, `border-radius:
  16 px 16 px 0 0`) with a grab-handle hint (`.notif-grabber`) + dim
  backdrop (`#notif-backdrop`). Show/hide is controlled via the HTML
  `hidden` attribute (not `style.display`) so CSS animations are
  declarative; the backdrop, click-outside, and `Esc` key all dismiss.
  The nav sync badge is hidden in the same media query to free up
  width — the same data is in Settings and the notification log.
- **Per-transaction shared-card settlement override.** On is_shared
  accounts, the per-row `personal_for` column overrides the account-level
  `spending_split_pct` ('self' = 100% user, 'partner' = 100% other
  cardholder, NULL = use account default). Honored by the SPLIT_AMOUNT
  CASE expression in `services/financial-queries.js` (and every inline
  copy across enrollments.js / insights.js — see the Shared Account
  Spending Split section). The settlement endpoint (`GET
  /api/shared-settlement`) groups charges into three buckets — shared,
  your_personal, partner_personal — and computes per-person obligations
  as `(split_pct × shared_total) + personal_total`. Reimbursed rows are
  excluded entirely (they net to neither party). The dashboard widget
  and the Transactions-page Edit modal share one source of truth: the
  `personal_for` column. New "who owes what" surfaces should compute
  obligations from the settlement endpoint rather than re-deriving them.
- **Plaid balance refresh is a standalone helper.** `syncAllPlaidBalances`
  in `routes/investments.js` calls `accountsGet` on every linked
  Plaid item **with `status = 'GOOD'`** (so CSV virtual `plaid_items`
  — `status='CSV'`, placeholder token — aren't sent to Plaid every balance
  sync, which would 400 and surface as recurring spurious errors; matches the
  filter `syncAllPlaidTransactions` applies, F3) and writes `current_balance` /
  `available_balance` / `credit_limit` to `linked_accounts` + a daily snapshot
  row, then
  refreshes liabilities (APR / minimum payment / due date via
  `syncPlaidLiabilities`, failing gracefully when unsupported) — no
  transactionsSync involved. `credit_limit` is sourced from the liabilities
  response's `accounts[].balances.limit` (Plaid's `CreditCardLiability` has no
  credit-limit field, so the old per-card read was always undefined — Discover
  fix); APR/limit only populate once `liabilitiesGet` succeeds, so an item that
  predates the Liabilities product needs a Plaid Link re-auth. The dashboard
  only derives a card's limit from `owed + available` when an available figure
  exists — otherwise it shows utilization as "—" rather than a misleading 100%,
  and offers a **manual credit-limit input** (→ `PATCH /api/accounts/:id/balance
  { credit_limit }`) next to the existing manual APR field so issuers Plaid never
  reports a limit for (e.g. Discover) still get real utilization. `POST /api/sync-balances` calls it
  alongside Teller's `syncAllBalances` AND `syncAllPlaidHoldings`, so one
  "Sync Balances" click freshens balances + credit limits + APR +
  investment holdings across both providers without triggering Plaid's
  transaction sync (which would add duplicate rows during overlap with
  prior CSV imports). The auto-sync loop still calls
  `syncAllPlaidTransactions` for transaction history; the helpers exist
  in parallel for different cost/duplication profiles.
- **Plaid holdings sync re-creates accounts, not just updates them.**
  `syncAllPlaidHoldings` in `routes/investments.js` UPSERTs
  `investment_accounts` (`ON CONFLICT (plaid_account_id)`) rather than a
  bare UPDATE, so the account rows are RE-CREATED when the table has been
  cleared (e.g. after a `scripts/reset-fresh.js` run) — the old UPDATE-only
  path inserted holdings but left `investment_accounts` empty, so
  investments stayed blank after any wipe. Account balance falls back to
  the sum of the account's holdings (`sumHoldingsByAccount`) when Plaid
  returns a null OR zero account-level `balances.current` (Schwab et al.),
  via `|| acctValue` (not `??`, so a reported 0 falls through), so
  brokerages don't persist as $0. The items query UNIONs the dedicated
  `plaid_investment_items` registry with any `status='GOOD'` `plaid_items`
  that have an `INVESTMENT_ACCOUNT_TYPES` account in `linked_accounts`
  (DISTINCT ON item_id, registry preferred) — because Plaid often doesn't
  surface a brokerage as an investment account at link time, so
  `exchange-transactions` never registered it in `plaid_investment_items`
  and its holdings stayed permanently un-synced ($0) even though the
  account itself linked fine. `investmentsHoldingsGet` no-ops for items with
  no holdings, so the extra items are cheap. The helper runs in the bank
  auto-sync chain, the AI pre-insights chain, and `POST /api/sync-balances`;
  the `POST /api/plaid/sync-holdings` route is a thin wrapper around it.
- **Plaid sync advances the cursor only on a fully-successful page.**
  `syncPlaidItemTransactions` processes each `transactionsSync` page, and if
  ANY row in the page fails to upsert it halts WITHOUT advancing the cursor —
  Plaid's contract is "everything ≤ cursor is durably processed," so stepping
  past a failed row would lose it forever. The cursor is persisted
  progressively after each clean page (so a later page's failure can't discard
  earlier progress), and re-processing a page is safe because all writes are
  idempotent (`ON CONFLICT` upserts / idempotent deletes). `modified`
  transactions are UPSERTED (not bare-UPDATEd) so a pending→posted re-delivery
  with no existing row is inserted rather than dropped. The helper returns
  `incomplete: true` when it halted early or hit `MAX_PAGES`.
- **Sync "added" counts genuine inserts, not updates.** Both the Teller and
  Plaid transaction upserts `RETURNING (xmax = 0) AS inserted` and increment
  their `added`/`transactions_added` counters only when the row was a fresh
  insert (`xmax = 0`). `ON CONFLICT DO UPDATE` returns `rowCount = 1` for both
  inserts and updates, so the old `rowCount > 0` check inflated the count on
  every re-sync and reconcile — which drove false "new activity" auto-sync
  notifications and unnecessary anomaly passes. `modified`/`removed` are tracked
  separately and unaffected.
- **Teller incremental sync never steps over a failed account.** In
  `syncEnrollment`, the enrollment-level `last_synced_txn_date` watermark is
  advanced ONLY when every account in the enrollment fetched cleanly — if any
  account's fetch throws, the watermark is held back so the next sync retries
  that range instead of permanently skipping a failed sibling account's older
  transactions. The incremental filter uses `>=` (not `>`) against the
  day-granular watermark so a transaction that posts on the watermark day after
  a sync ran isn't dropped; re-including the whole watermark day is safe because
  the `ON CONFLICT (transaction_id)` upsert dedups the re-processed rows.
  Pagination is **page-size-independent** (BS-1): the loop requests an explicit
  `?count=500` and pages via `from_id` until Teller returns an empty page (or the
  floor date is crossed), with a `MAX_PAGES=100` runaway guard. The earlier
  `txns.length < 500` stop hard-coded a 500-row page assumption — if Teller's
  default page size were smaller, the first full page satisfied `< 500`, `from_id`
  pagination never advanced, and history was capped at one page while the
  watermark stepped past everything older.
- **Reconcile/backfill is watermark-independent and idempotent.**
  `reconcileTeller(days)` re-fetches the trailing window from every Teller
  enrollment by passing `{ backfillDays }` to `syncAllEnrollments`, which sets a
  `backfillFrom` floor used in place of `last_synced_txn_date` — it does NOT
  advance the incremental watermark and suppresses the anomaly push (re-upserting
  historical rows would otherwise look like a flood of new activity). All writes
  are `ON CONFLICT` upserts so it only recovers dropped rows, never duplicates.
  `reconcilePlaidTransactions()` resets every `sync_cursors.cursor` to '' and
  re-walks `transactionsSync` (Plaid's cursor is all-or-nothing, so reconcile is
  a full re-pull). Driven by `POST /api/sync/reconcile` and the weekly
  self-healing scheduler (Teller only; Plaid stays manual).
- **Named route helpers are attached AFTER `module.exports = router`.** In
  modules that export an Express router AND helper functions (e.g.
  `routes/investments.js`), the helper attachments (`module.exports.syncAll… = …`)
  must come AFTER the `module.exports = router` line — otherwise the router
  assignment replaces the default exports object and silently drops the helpers
  to `undefined`. (This had left `syncAllPlaidTransactions` / `syncAllPlaidBalances`
  unexported, so the scheduler's Plaid steps were no-ops caught by try/catch.)
  All such helpers are hoisted `async function` declarations, so attaching them
  at the very end works.

## Git
- Render deploys from `main` (configured in the Render dashboard, not in `render.yaml`)
- PEM files and `.env` are in `.gitignore`

## Companion App: Per-sistant
- **Location**: `apps/per-sistant/` (subtree-merged into this repo; original
  per-sistant history preserved). Originally lived at `github.com/robinchoudhuryums/per-sistant`.
- **Purpose**: Personal assistant — task management, email scheduling, notes,
  AI productivity briefings, calendar, and a **personal Knowledge base**
  (vault-backed RAG: cited Q&A, structured facts, diagrams, capture, secret
  tier; grounds finance questions on Perfin data). See the Knowledge / RAG
  subsystem in the Cycle Workflow Config and the Knowledge section of
  `apps/per-sistant/CLAUDE.md`.
- **Integration under unified shell**: see "Per-sistant Integration" section
  above. Sub-app mounts at `/per-sistant/*`, shares the shell's session cookie,
  runs its own migrations against `PERSISTENT_DATABASE_URL`.
- **Per-app docs**: `apps/per-sistant/CLAUDE.md` for route-by-route architecture,
  `apps/per-sistant/README.md` for a public overview.
- **Standalone fallback**: `npm run start:persistent` boots it on its own
  port (3001) using the legacy `NEON_DATABASE_URL` fallback, useful for
  isolated debugging.

## Priority Next Features
1. **Mobile app (operator step)** — the Capacitor iOS wrapper is scaffolded in
   `mobile/` (remote-URL mode, coexists with the PWA); what remains is the
   free-signing Xcode build on the operator's Mac per `mobile/README.md`.

Shipped (June 2026): **Investment performance & allocation** — cost-basis
returns + asset-class allocation + target-drift
(`GET /api/investments/performance`) and portfolio value history vs S&P 500
benchmark (`GET /api/investments/performance-history`). **FIRE/runway
projections** — `GET /api/fire-projection` + Goals-page card
(`services/projections.js`). **Ask Perfin** — NL finance Q&A via Claude tool
use (`POST /api/ask`, dashboard widget). **Health/habits tracker** — built as
a Per-sistant expansion per the June 2026 decision (NOT a third shell sub-app:
Per-sistant already owned streaks/notifications/briefing; a third sub-app
costs a new DB + migration chain + nav/PWA identity). Shape as planned:
`apps/per-sistant/routes/health.js` + `pages/health.js` + 3 tables (db/020 —
habits, habit_logs, health_metrics), read-time streak computation, nudges via
the notification check + AI daily briefing. Escape hatch if it outgrows
Per-sistant: extract via the proven route-split + identity re-export recipe.

Dropped by design (June 2026): **multi-user support** — the single-user
assumption (single-row `user_settings`, server-side watermarks, no tenancy
dimension in queries) is a load-bearing simplification, not a gap; and
**onboarding flow** — single operator, already onboarded.

## Cycle Workflow Config

### Test Command
npm test

### Health Dimensions
Financial Data Accuracy, Sync Integrity & Idempotency, Income/Spending Classification,
AI Output Trustworthiness, Auth & Session Security, Secret & Token Handling,
Scheduler Reliability, Data Freshness & Reconciliation, Migration Safety,
Notification Correctness, Cross-app Integration Integrity, UI/UX & Accessibility,
External Export Fidelity, Knowledge Retrieval & Grounding, Test Coverage Quality

### Horizontal (Axis B) Categories
Silent Degradation Posture | failures that swallow errors and look like success
Startup Ordering Guarantees | migrations/cron/pool-wiring race or run out of order
Operator-Only State Gaps | undocumented manual setup (PEMs, passphrase, env vars)
Parallel Source-of-Truth Drift | SPLIT_AMOUNT/INCOME_PREDICATE copies diverging across files
Money / Precision Drift | NUMERIC rounding, split-sum ±$0.01, parseMoney edge cases
Test Coverage Quality | tests that pass regardless of the code under test

### Subsystems
Bank Sync & Ingestion:
  teller/routes/enrollments.js, teller/routes/investments.js,
  teller/routes/investment-performance.js, teller/services/plaid-client.js,
  teller/services/teller-api.js, teller/services/benchmarks.js,
  teller/data/csv-formats.js, scripts/import-csv-cli.js
  (Teller and Plaid are co-equal, first-class linking paths — both write the
   same transactions/linked_accounts tables. Plaid additionally covers banks
   Teller doesn't, plus investment holdings.)
Detection & Categorization:
  teller/routes/subscriptions.js, teller/routes/transactions.js,
  teller/routes/categorize.js,
  teller/routes/categorize-helpers.js, teller/data/reference-data.js,
  scripts/detect-subscriptions.js, scripts/detect-transfers.js
Financial Analytics:
  teller/services/financial-queries.js, teller/routes/spending-analytics.js,
  teller/services/projections.js, teller/routes/budgets.js,
  teller/routes/goals.js, teller/routes/credit-scores.js,
  teller/routes/whats-new.js, teller/routes/watchlist.js
AI Insights & Audit:
  teller/routes/insights.js, teller/routes/insights-email.js,
  teller/routes/ask.js, teller/services/ai-audit.js
Settings, Notifications & Cross-app:
  teller/routes/settings.js, teller/routes/notifications.js,
  teller/routes/persistent.js
  (Seam: the matching Per-sistant integration files —
   apps/per-sistant/routes/perfin.js + routes/webhooks.js — are audited
   together with this subsystem from both sides.)
Platform, Shell & Auth:
  shell/index.js, shell/middleware/auth.js, shell/middleware/webauthn.js,
  teller/server.js, teller/startup.js, teller/services/database.js,
  teller/services/keep-alive.js, teller/services/job-health.js,
  scripts/reset-fresh.js, db/*.sql
Web UI (Perfin):
  teller/pages/*.js, teller/views/*.ejs, teller/views/partials/*.ejs,
  teller/public/*.js, teller/public/*.css, teller/public/sw.js,
  shell/views/*.ejs, shell/public/*
Sheets & External Export:
  scripts/sheets-sync.js, scripts/retention-cleanup.sql, apps-script/Code.gs
Per-sistant Backend:
  apps/per-sistant/server.js, apps/per-sistant/ai.js, apps/per-sistant/config.js,
  apps/per-sistant/db.js, apps/per-sistant/errors.js, apps/per-sistant/helpers.js,
  apps/per-sistant/middleware.js, apps/per-sistant/routes/*.js,
  apps/per-sistant/services/keep-alive.js, apps/per-sistant/db/*.sql
  (Subtree-merged companion app, governed by THIS config to keep the two apps
   in lockstep — not a separate cycle. routes/perfin.js + routes/webhooks.js
   are the cross-app synergy seam shared with Perfin's Settings/Notifications/
   Cross-app subsystem.)
Per-sistant Web UI:
  apps/per-sistant/views.js, apps/per-sistant/views/*.js, apps/per-sistant/pages/*.js
Knowledge / RAG (Per-sistant):
  apps/per-sistant/routes/rag.js, apps/per-sistant/services/embeddings.js,
  apps/per-sistant/services/vault-sync.js, apps/per-sistant/pages/knowledge.js,
  apps/per-sistant/db/013_knowledge.sql, apps/per-sistant/db/014_vault_vectors.sql,
  apps/per-sistant/db/015_rag_cache.sql, apps/per-sistant/db/016_facts.sql,
  .github/workflows/knowledge-reindex.yml
  (Personal knowledge base: Obsidian-vault ingest + pgvector semantic retrieval,
   Citations, answer cache, structured facts + temporal validity, cross-app
   finance grounding, Mermaid diagrams, capture-to-vault, proactive surfacing.
   NOTE: embeddings.js + vault-sync.js are owned HERE, not by Per-sistant
   Backend (whose subsystem list names services/keep-alive.js explicitly, not
   services/*.js). Seam files shared with other subsystems: routes/notifications.js
   (fact_upcoming), routes/settings.js (vault config), ai.js (answerWithCitations),
   pages/settings.js + settings-script.js + pages/dashboard-script.js, server.js
   (vault-sync cron). CROSS-APP SEAM: rag.js reads Perfin's perfinPool
   (linked_accounts, detected_subscriptions) read-only — a new seam between
   Knowledge and Perfin's Bank Sync & Ingestion / Financial Analytics.)

### Invariant Library
INV-01 | Sync "added" counts only genuine inserts (RETURNING xmax=0), never updates | Subsystem: Bank Sync & Ingestion | Verify: tests/sync-durability.test.js
INV-02 | Teller watermark advances only when every account in the enrollment fetched cleanly | Subsystem: Bank Sync & Ingestion | Verify: code read syncEnrollment
INV-03 | Teller incremental filter uses >= against the day-granular watermark | Subsystem: Bank Sync & Ingestion | Verify: code read
INV-04 | Plaid cursor advances only after a fully-successful page; persisted progressively | Subsystem: Bank Sync & Ingestion | Verify: code read syncPlaidItemTransactions
INV-05 | Reconcile is watermark-independent + idempotent; anomaly push suppressed | Subsystem: Bank Sync & Ingestion | Verify: reconcileTeller / tests/sync-durability.test.js
INV-06 | User overrides never clobbered by re-sync; display uses COALESCE | Subsystem: Bank Sync & Ingestion
INV-07 | Every spending aggregation applies SPLIT_AMOUNT | Subsystem: Financial Analytics | Verify: tests/financial-queries.test.js
INV-08 | Reimbursed transactions excluded from all spending aggregations | Subsystem: Financial Analytics
INV-09 | transaction_splits replace parent in per-category totals; sum matches parent ±$0.01 | Subsystem: Financial Analytics
INV-10 | Keyword filters use word-boundary regex, never LIKE '%kw%' | Subsystem: Financial Analytics | Verify: tests/audit-regressions.test.js
INV-11 | Goal current_amount derived (balance − baseline) when funding-linked | Subsystem: Financial Analytics
INV-12 | Categorization writes user_category, never category | Subsystem: Detection & Categorization
INV-13 | Categorization rules applied before AI; only unmatched rows sent to Claude | Subsystem: Detection & Categorization
INV-14 | INSIGHTS_MONTHLY_BUDGET_CENTS enforced across insight+categorize+rebuild+ask | Subsystem: AI Insights & Audit
INV-15 | Insight cost uses granular token pricing (input + cache_read + cache_creation) | Subsystem: AI Insights & Audit
INV-16 | sanitizeStructuredSummary bounds the summary; failure preserves prior | Subsystem: AI Insights & Audit
INV-17 | Migrations run in one transaction; failure is fatal | Subsystem: Platform, Shell & Auth
INV-18 | Scheduler invokes route logic via in-process helpers, never HTTP self-fetch | Subsystem: Platform, Shell & Auth
INV-19 | Named helper exports attached AFTER module.exports = router | Subsystem: Platform, Shell & Auth
INV-20 | Shell requireAuth honors x-api-key; embedded sub-apps skip own check | Subsystem: Platform, Shell & Auth | Verify: tests/audit-regressions.test.js
INV-21 | Shell safeReturnTo allows only same-origin absolute paths | Subsystem: Platform, Shell & Auth
INV-22 | Tokens + webhook secret encrypted at rest; mismatch surfaces as decryption_failed | Subsystem: Platform, Shell & Auth
INV-23 | Service worker never caches /api/* | Subsystem: Web UI
INV-24 | sheets-sync.syncAll isolates each tab (per-tab try/catch + errors[]) | Subsystem: Sheets & External Export
INV-25 | Embedded sub-apps detect req.app.get("embedded") and skip their own auth; cross-app calls use the wired pool (perfinPool/persistentPool), never HTTP self-fetch | Subsystem: Per-sistant Backend / Platform, Shell & Auth
INV-26 | Teller transaction pagination terminates on an empty page (count-explicit + from_id), never a hard-coded page-size compare | Subsystem: Bank Sync & Ingestion | Verify: tests/cycle-fixes.test.js (BS-1 block)
INV-27 | Only sensitivity='normal' docs/facts are embedded AND retrieved; private/secret are never embedded or sent to AI | Subsystem: Knowledge / RAG | Verify: tests/knowledge.test.js (buildRetrievalQuery), tests/knowledge-facts.test.js
INV-28 | pgvector objects are created defensively (only if the `vector` extension is available); the migration succeeds and Knowledge degrades to keyword retrieval rather than failing boot | Subsystem: Knowledge / RAG | Verify: code read db/014_vault_vectors.sql + vault-sync.vectorReady
INV-29 | Retrieval is HYBRID (vector + keyword legs fused via Reciprocal Rank Fusion, dedupe on kind:id) — either leg failing degrades to the other alone; /query & /diagram degrade to sources-only / null when AI is off or unavailable | Subsystem: Knowledge / RAG | Verify: tests/knowledge.test.js, apps/per-sistant/tests/rag-v2.test.js
INV-30 | Embedding dimension (1024) matches chunks.embedding vector(1024); a provider/dimension change is a re-embed migration, not a config flip | Subsystem: Knowledge / RAG | Verify: code read services/embeddings.js EMBED_DIM
INV-31 | embed_state content-hash skip prevents re-embedding unchanged sources | Subsystem: Knowledge / RAG | Verify: code read vault-sync.embedSource
INV-32 | Answer cache keyed on query+model+corpus_version (notes+documents+facts+fact_verifications max(updated_at)+count — F14 folds in fact_verifications so verify/unverify invalidates), with a SEMANTIC fallback layer (query-embedding cosine >= 0.97, same model+corpus_version+TTL — RAG v2, db/019); a SEMANTIC hit returns sources_from_similar_query=true (the cached sources reflect the original query's retrieval and the answer's [n] links are tied to that ordering, so they're kept, not re-retrieved — the Knowledge page caveats it; F12); finance-grounded answers bypass both layers | Subsystem: Knowledge / RAG | Verify: tests/knowledge-cache.test.js + apps/per-sistant/tests/rag-v2.test.js + routes/rag.js useCache gate
INV-33 | Vault sync is read-only (VAULT_GITHUB_TOKEN); capture writes only with the separate write-scoped VAULT_GITHUB_WRITE_TOKEN (400 until set) | Subsystem: Knowledge / RAG | Verify: tests/knowledge-capture.test.js
INV-34 | Citations enabled all-or-none per request; incompatible with structured outputs (unused here) | Subsystem: Knowledge / RAG | Verify: tests/knowledge.test.js (answerWithCitations)
INV-35 | Cross-app finance grounding reads perfinPool read-only, only on finance queries, never an HTTP self-fetch (parallels INV-25) | Subsystem: Knowledge / RAG | Verify: tests/knowledge-crossapp.test.js
INV-36 | Single in-process vault-sync lock (isSyncing) prevents overlapping cron/reindex/GH-Action runs — BOTH syncVault AND syncNotes acquire it (busy→no-op), so the cron's notes phase can't overlap a concurrent reindex (K4); vault_last_sha advances only on success (errors stamp vault_last_error) | Subsystem: Knowledge / RAG | Verify: code read vault-sync.syncVault + syncNotes
INV-37..47 | RETIRED — assigned by the cycle-3 reflect but their definitions were never written into the repo and are unrecoverable; numbers burned, never reuse (their subject matter — the cycle-3 fixes — is test-pinned via tests/cycle-fixes.test.js + audit-regressions) | — | Verify: n/a
INV-48 | SPLIT_AMOUNT / INCOME_PREDICATE are never re-inlined: every spending aggregation imports from financial-queries.js (aliased variants derived in place via .replace); the only permitted literal copies are scripts/sheets-sync.js (byte-pinned) + apps-script/Code.gs | Subsystem: Financial Analytics (seam) | Verify: tests/seams-audit.test.js repo-wide literal-CASE scan
INV-49 | Every member of Perfin's EMAIL_EVENTS set is accepted AND named (sendNameByEvent) by Per-sistant's HTTP webhook receiver — an unrecognized email event is 200-and-dropped in standalone deployments | Subsystem: Settings, Notifications & Cross-app (seam) | Verify: tests/seams-audit.test.js symmetry pin
INV-50 | WebAuthn auth-options advertise transports ['internal'] ONLY in allowCredentials (NOT 'hybrid') — registration pins authenticatorAttachment:'platform' so credentials are same-device; advertising the cross-device 'hybrid' transport is what surfaced the "use a phone" QR option instead of local Touch/Face ID, so internal-only suppresses the QR path; both shell and standalone auth-options endpoints comply (transports still persisted at registration, just not used as the login hint) | Subsystem: Platform, Shell & Auth | Verify: tests/budget-cap-webauthn.test.js
INV-51 | Habit streaks are computed at read time from habit_logs (a backfilled log retroactively repairs a streak; an unlogged today never breaks one); no stored streak counters exist for habits | Subsystem: Per-sistant Backend | Verify: apps/per-sistant/tests/health.test.js backfill-repair test
INV-52 | Health consumers (notification check, AI daily briefing) call gatherHealthSummary fail-soft (.catch) — a health-tables error degrades to "no habit data", never 500s those surfaces | Subsystem: Per-sistant Backend | Verify: apps/per-sistant/tests/health.test.js integration pins
INV-53 | CRITICAL scheduled jobs (transaction/balance sync + snapshot + detection; weekly reconcile; backups; knowledge reindex) have out-of-process GitHub-Actions backstops hitting x-api-key endpoints with idempotent writes, so Render free-tier sleep can't skip them | Subsystem: Platform, Shell & Auth | Verify: .github/workflows/{daily-sync,weekly-reconcile,db-backup,knowledge-reindex}.yml exist + idempotent-write invariants INV-01/05
INV-54 | Re-sync is BEHAVIORALLY idempotent: syncAllEnrollments (Teller) + syncPlaidItemTransactions (Plaid) run twice over identical inputs add 0 on the 2nd run, no duplicate rows, watermark/cursor stable (not merely source-string-pinned) | Subsystem: Bank Sync & Ingestion | Verify: tests/sync-idempotency.test.js
INV-55 | /api/ask charges the shared AI cap even on a mid-tool-loop failure — the usage row is written in a `finally` (idempotent `charged` flag) when tokens were consumed, so a throw on a later round doesn't let spend escape the cap (parity with rebuild AIA2 / categorize M2) | Subsystem: AI Insights & Audit | Verify: tests/ai-cap-charge.test.js
INV-56 | The dashboard's inlined loanPayoff() is NUMERICALLY identical to services/projections.computeLoanPayoff across scenarios (months / total_interest ±$0.01 / insufficient flag), not merely string-equal | Subsystem: Web UI ↔ Financial Analytics (seam) | Verify: tests/loan-support.test.js (extract-and-run parity test)
INV-57 | The critical-audit notification is deduped to ≤1 per 24h via sentRecently('audit-alert', 24), fail-open — a steady-state critical finding doesn't re-push on every 6h auto-insight tick | Subsystem: AI Insights & Audit / Notification Correctness | Verify: code read routes/insights.js audit-alert gate
INV-58 | A kind='quantity' habit always has a non-null target_value, enforced on POST AND on PATCH against the MERGED post-update state (so switching to quantity without a target, or nulling a quantity habit's target, 400s instead of silently degrading meetsTarget) | Subsystem: Per-sistant Backend | Verify: apps/per-sistant/tests/health.test.js (F9 PATCH tests)
INV-59 | Bounded settings (target_allocation_pct, shell_idle_timeout_minutes, fire_*, ai_monthly_budget_cents) reject invalid input with 400 — never silent-drop + 200 | Subsystem: Settings, Notifications & Cross-app | Verify: tests/budget-cap-webauthn.test.js (PATCH /api/settings validation)
INV-60 | Perfin "Sign Out" clears the SHELL session via the root POST /logout under the unified shell (not a basePath'd /api/logout); redirect target is the root /login — both un-prefixed | Subsystem: Web UI ↔ Platform, Shell & Auth (seam) | Verify: code read teller/views/settings.ejs logout() + shell POST /logout (auth.handleLogout)
INV-61 | apiFetch redirects once to /login on a 401 or a followed 302→/login (session expiry), loop-guarded, while returning the Response unchanged to callers — idle timeout never leaves a blank/error UI | Subsystem: Web UI | Verify: code read teller/public/perfin-shared.js apiFetch
INV-62 | The shell sets a nonce CSP + frame-ancestors 'none' + X-Frame-Options on its own routes (login/landing), with COOP/CORP/COEP DISABLED so the global middleware doesn't break sub-app Plaid/Teller Link popups; helmet is a declared shell dependency | Subsystem: Platform, Shell & Auth | Verify: header assertion on GET /login (frame-ancestors none, COOP/CORP absent, login scripts nonced)
INV-63 | Per-sistant's shared fetch wrapper (apps/per-sistant/views/js.js) redirects once to the root /login on a 401 or a followed 302→/login (session expiry), loop-guarded, returning the Response unchanged to callers — parity with Perfin INV-61, so an idle-timeout never leaves a blank/error page. The check uses indexOf('/login'), NOT a regex, because the module is one backtick template literal that eats regex backslashes (see Per-sistant CLAUDE.md gotcha) | Subsystem: Per-sistant Web UI | Verify: code read views/js.js fetch wrapper

### Policy Configuration
Policy threshold: 6/10
Consecutive cycles: 2

### Seams Audit Cadence
every 3 subsystem cycles

### Regression Scenarios
S1 | Re-sync is idempotent | Subsystem: Bank Sync & Ingestion
  Steps:
    - Run a Teller + Plaid sync, note transactions_added
    - Run the same sync again with no new bank activity
  Expected: second run reports 0 added; no duplicate rows; watermark/cursor unchanged on the no-op
S2 | Shared-card settlement math | Subsystem: Financial Analytics
  Steps:
    - Mark an account is_shared at 50%; set one charge personal_for='self', one 'partner'
    - Open the Settlement widget for that month
  Expected: your_share = 50%×shared_total + self_total; partner mirror; reimbursed rows excluded
S3 | AI budget cap enforced | Subsystem: AI Insights & Audit
  Steps:
    - Set INSIGHTS_MONTHLY_BUDGET_CENTS low; trigger insights, then categorize
  Expected: 429 once cap hit; rules still categorize for free; usage rows written for both entry_types
S4 | Embedded auth gate + cross-pool wiring | Subsystem: Platform, Shell & Auth
  Steps:
    - Hit /perfin/api/spending-summary with no shell cookie, then with a valid x-api-key
    - Load the Per-sistant Perfin widget while embedded
  Expected: 401/redirect without creds; 200 with valid key; widget reads Perfin's pool directly (no self-fetch 401)
S5 | Sheets partial-failure isolation | Subsystem: Sheets & External Export
  Steps:
    - Force one tab's query to throw during syncAll
  Expected: other tabs still update; errors[] names the failed tab; run doesn't abort mid-way
S6 | Offline navigation fallback | Subsystem: Web UI
  Steps:
    - Install PWA, go offline, navigate to an uncached route
  Expected: branded /offline.html served; no stale /api/* data shown
SK1 | Vault sync idempotent | Subsystem: Knowledge / RAG
  Steps:
    - Configure the vault; run a sync, then run it again with no repo changes
  Expected: second run reports 0 changed; content-hash skips re-embedding; vault_last_sha unchanged
SK2 | Knowledge privacy | Subsystem: Knowledge / RAG
  Steps:
    - Mark a fact/doc private (embed:false / sensitivity: private|secret); ask a question that would match it
  Expected: it is never embedded and never returned by /query or /search (and never sent to the model)
SK3 | pgvector unavailable | Subsystem: Knowledge / RAG
  Steps:
    - Boot against a Postgres without the `vector` extension available
  Expected: migration still succeeds (no boot crash); Knowledge serves keyword retrieval
SK4 | Capture write-gating | Subsystem: Knowledge / RAG
  Steps:
    - POST /api/rag/capture with VAULT_GITHUB_WRITE_TOKEN unset, then set
  Expected: 400 with a clear message when unset; a single committed file when set
SK5 | Temporal validity | Subsystem: Knowledge / RAG
  Steps:
    - Create a fact with valid_to in the past; ask about it
  Expected: it is NOT injected into the answer; GET /api/rag/facts?all=1 still lists it

### Frozen Subsystems
- Legacy standalone Plaid server (plaid/server.js) — the LEGACY standalone process only. The active, co-equal Plaid linking path lives in teller/routes/investments.js and is NOT frozen. This file is kept solely for isolated standalone Plaid debugging; unfreeze if the in-app Plaid path is ever extracted to a standalone service.
- n8n workflows (n8n-workflows/*.json) — superseded by in-process scheduled tasks in teller/startup.js. Unfreeze only if scheduling moves back out-of-process.

### Deploy Command
Platform, Shell & Auth: Render auto-deploys on push to `main` (configured in the Render dashboard, not via CLI). Alt: `fly deploy` (Dockerfile-based).
Sheets & External Export: Apps Script side deploys via clasp — `clasp push` from apps-script/, then Apps Script editor → Deploy → New version. (Server-side sheets-sync.js ships with the main Render deploy.)

### Cycle Rotation Plan
Recommended first subsystem: Bank Sync & Ingestion (widest blast radius — every downstream number depends on correct transaction data; most invariants; richest recent bug history).
Recommended order (frozen excluded): Bank Sync & Ingestion → Financial Analytics → Detection & Categorization → AI Insights & Audit → Knowledge / RAG (Per-sistant) → Platform, Shell & Auth → Settings, Notifications & Cross-app → Sheets & External Export → Web UI (Perfin) → Per-sistant Backend → Per-sistant Web UI.
Seams audit frequency: every 3 subsystem cycles (focus: enrollments.js, subscriptions.js, settings.js, financial-queries.js, notifications.js, the Per-sistant integration seam routes/perfin.js + routes/webhooks.js, and the Knowledge↔Perfin seam — rag.js's read-only perfinPool use of linked_accounts/detected_subscriptions).
Confidence: Bank Sync, Analytics, Detection, AI, Platform = High; Integrations, Sheets, Web UI, Per-sistant Backend, Per-sistant Web UI, Knowledge / RAG = Medium (Knowledge: new code, heavily tested, but unexercised against a live vault/Voyage/pgvector).
