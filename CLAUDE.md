# CLAUDE.md — Project Context for Claude Code

## Project Overview
Single Node process that hosts two related personal tools behind one PIN gate:

- **Perfin** — finance tracker. Detects recurring charges, compares spending to
  benchmarks, tracks financial goals, runs AI-powered insights via Claude. Uses
  **Teller API** for bank links via mTLS, plus Plaid for investment holdings.
- **Per-sistant** — personal assistant. Tasks, scheduled emails, notes,
  calendar, AI daily briefing.

A `shell/` Express app authenticates the user with `SHELL_PIN`, renders a tile
picker landing page, then mounts each sub-app under its own URL prefix:
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
  services/
    database.js          — Postgres pool + transactional auto-migrations with schema versioning
    teller-api.js        — mTLS HTTP client for Teller API (retry with exponential backoff)
    keep-alive.js        — Self-ping to prevent Render free tier sleep (with fetch timeout)
    financial-queries.js — Shared income/spending SQL helpers (split-adjusted spending,
                           keyword-filtered income, current-month per-category spending
                           that honors transaction_splits) — single source of truth used
                           by AI insights and budgets so the numbers match the dashboard
    ai-audit.js        — Post-generation insight auditing (4 tiers: arithmetic
                           validation, entity existence, trend direction, consistency).
                           Stores results in ai_audit_log table.
  routes/
    enrollments.js       — POST /api/enroll, POST /api/sync, GET /api/items,
                           DELETE /api/enrollments/:id, GET /api/accounts,
                           PATCH /api/accounts/:id, PATCH /api/accounts/:id/shared,
                           POST /api/sync-balances, GET /api/spending-summary,
                           GET /api/cash-flow, GET /api/savings-rate,
                           GET /api/spending-yoy.
                           Also exports `syncAllEnrollments` and `syncAllBalances` for
                           the scheduled bank-auto-sync task in `server.js` (in-process,
                           no HTTP self-fetch).
    subscriptions.js     — GET/POST /api/subscriptions, PATCH dismiss/undismiss/cancel/
                           uncancel/category, GET /api/transactions,
                           GET /api/transactions/search, POST /api/detect,
                           POST /api/import-csv, GET /api/csv-imports, POST /api/cleanup,
                           GET /api/recurring-transfers, POST /api/detect-transfers,
                           PATCH /api/recurring-transfers/:id/dismiss|undismiss|type,
                           PATCH /api/transactions/:id (merchant_name, notes, is_reimbursed),
                           GET/POST/DELETE /api/transactions/:id/splits,
                           GET/POST/PATCH/DELETE /api/manual-bills,
                           GET/POST/DELETE /api/bill-payments
    goals.js             — GET/POST/PATCH/DELETE /api/goals, GET /api/goals/funding-options,
                           POST /api/net-worth/snapshot, GET /api/net-worth/history,
                           GET /api/context-export, GET/POST /api/investment-accounts
    budgets.js           — GET/POST/PATCH/DELETE /api/budgets, POST /api/budgets/suggest,
                           POST /api/budgets/accept, GET /api/budgets/alerts,
                           POST /api/budgets/snapshot, GET /api/budgets/history
    settings.js          — GET/PATCH /api/settings, POST /api/sheets/sync,
                           POST /api/sheets/dashboard, GET /api/export,
                           GET /api/data-freshness
    insights.js          — GET/POST /api/insights, GET /api/insights/status,
                           GET /api/insights/usage, POST /api/insights/reset,
                           POST /api/insights/rebuild, GET /api/insights/audit,
                           GET/PATCH /api/tax-deductions
    categorize.js        — POST /api/categorize, GET /api/categorize/status,
                           PATCH /api/transactions/:id/category,
                           PATCH /api/transactions/bulk-category,
                           GET/POST/DELETE /api/categorization-rules,
                           POST /api/categorization-rules/apply,
                           POST /api/categorization-rules/from-transaction
                           (ML categorization via Claude tool_use structured output,
                           with user-defined rules applied first before AI)
    investments.js       — GET /api/plaid/status, POST /api/plaid/link-token,
                           POST /api/plaid/exchange, POST /api/plaid/sync-holdings,
                           GET /api/plaid/holdings (Plaid investment accounts).
                           GET /api/investments returns the unified picture
                           across Teller-linked, manual, and Plaid sources.
    notifications.js     — GET /api/notifications/vapid, POST/DELETE /api/notifications/subscribe,
                           POST /api/notifications/test, GET /api/notifications,
                           PATCH /api/notifications/:id/read, POST /api/notifications/read-all
                           (Web Push notifications + in-app notification log)
    persistent.js        — Per-sistant integration: webhooks, SSO, productivity context
                           POST /api/persistent/webhook/test, POST /api/persistent/webhook/send,
                           GET /api/persistent/status, GET /api/persistent/productivity-context,
                           POST /api/sso/generate, POST /api/sso/validate
  pages/
    dashboard.js         — Dashboard page (Chart.js charts, 3D pyramid, account list, balances,
                           savings rate widget, cash flow widget, Per-sistant widget)
    subscriptions.js     — Subscription/utility management page
    accounts.js          — Teller Connect enrollment + CSV import page
    goals.js             — Financial goals tracking page
    budgets.js           — Budget tracking page with AI suggestions and alerts
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
    sw.js                — Service worker (cache `perfin-v4`, network-first with offline
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
    goals.ejs            — Financial goals template with progress and projections
    settings.ejs         — Settings template (theme, AI, keep-alive, sync, exports)
    subscriptions.ejs    — Subscription/utility management template
    accounts.ejs         — Teller Connect enrollment + CSV import template
    login.ejs            — Login template with helmet materialize animation on success
    partials/head.ejs    — HTML head (meta, PWA manifest, apple-touch-icon, viewport-fit,
                           dual light/dark theme-color, skip-link)
    partials/nav.ejs     — Top navigation bar with helmet logo icon, "Synced Xm ago"
                           badge with color-coded staleness (green/yellow/red) and per-source
                           tooltip, notification bell with unread count + dropdown panel,
                           <main> landmark
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
    transition.css             — Cosmic mask-reveal transition (Per-sistant
                                 entry from landing tile + Perfin nav's
                                 cross-app icon). Scoped under .atrans-*.
    transition.js              — Auto-init module: scans for [data-atrans]
                                 triggers, populates twinkling stars +
                                 rising particles in any .atrans-overlay,
                                 binds click→activate→navigate.
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
- `scripts/sheets-sync.js` — Google Sheets sync (7 tabs: Transactions, Subscriptions,
  Utilities, AI Insights, Recurring Transfers, Tax Deductions, Dashboard)
- `scripts/import-csv-cli.js` — Standalone CLI for importing bank CSVs (mirror of the
  `/api/import-csv` route — note format detection drift between the two; see audit H8)
- `scripts/retention-cleanup.sql` — Reference SQL for the manual cleanup queries
  exposed by `POST /api/cleanup`
- `apps-script/Code.gs` — Google Sheets Apps Script (standalone + server sync)
- `tests/` — 241 tests across 11 files (node:test runner, `npm test`).
  Includes `tests/audit-regressions.test.js` which pins documented behavior
  for auth, SSO, template hygiene, and exclusion rules. Run `npm install`
  at the repo root before `npm test` (root `package.json` declares the
  test-time deps separately from `teller/`).
- `.github/workflows/ci.yml` — CI pipeline (single `npm ci` at root via npm workspaces, then `npm test`)
- `.claude/commands/` — Project slash-command prompts: `/broad-scan`, `/broad-implement`,
  `/test-sync`, `/sync-docs`
- `Dockerfile`, `fly.toml`, `render.yaml` — Deployment configs (the Dockerfile
  installs all workspaces and boots `node shell/index.js`; render.yaml uses
  `npm install` + `npm start` and bypasses the Dockerfile)

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
  - **Manual**: user-entered via `POST /api/investment-accounts`. Stored in
    `investment_accounts` with no `plaid_account_id`.
- **CSV import**: Auto-detect Chase, Capital One, Discover, Wells Fargo, Schwab formats
- **Transaction deduplication**: SHA256-based duplicate detection across CSV imports and API syncs
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
  The upsert respects user state via an `is_active` CASE: if the user cancelled a subscription
  (`cancelled_at IS NOT NULL`) or dismissed it (`is_dismissed = true`), detection will not
  re-activate it even if the merchant charges again.
- **Recurring transfer detection**: Auto-detect Zelle, Venmo, bill payments, savings transfers,
  investment contributions, ACH/wire (7/14/30/60/90/365-day cadences, outgoing/incoming split)
- **Utility separation**: Utilities tracked separately from optional subscriptions
- **Shared accounts**: Joint/shared card support with configurable spending split percentage
  (`is_shared`, `spending_split_pct` on linked_accounts, applied in all spending queries via SQL JOIN)
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
- **Tax deduction persistence**: Flagged deductions stored in `tax_deductions` table, accumulated year-round
- **Manual bills**: User-created expected charges for the bill calendar (name, amount,
  due_day 1-31, cadence monthly/quarterly/yearly, category). CRUD via
  `/api/manual-bills`. Integrated into `/api/bill-calendar` alongside detected
  subscriptions.
- **Bill payment tracking**: Mark bills (both detected subscriptions and manual) as paid
  for specific dates via `/api/bill-payments`. Calendar shows paid state with
  strikethrough + checkmark. Click to toggle paid/unpaid.
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
  headers — Cash (depository), Credit, Investments, Other — using the
  `is_investment` flag returned from `GET /api/accounts`. Teller-linked
  brokerage / IRA / 401k accounts surface under their own header instead of
  being mixed in with checking/savings.
- **Investments widget**: Total invested across all sources, per-source
  breakdown (Teller / Plaid / Manual), and per-account cards with inline SVG
  sparklines (computed client-side from `/api/accounts/:id/balance-history`,
  no Chart.js dependency). Each card has a "View history →" link to the
  full chart page at `/accounts/:id/history`. Auto-hides when no investment
  accounts exist. Toggleable from Settings (key: `investments`, default on).
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
- **Budget alerts** (`GET /api/budgets/alerts`): Spending velocity/pacing warnings with severity levels — `critical` ≥100% (over budget), `warning` ≥80% (approaching limit), `info` when pace > 1.2× and ≥50% (spending faster than the month's progress). The 3-hour scheduled push-notification path uses the same 80% / 100% thresholds; the in-app `info`/pace heuristic is intentionally not pushed (too noisy as a notification).

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
  - Anomaly detection (transactions 2x+ above merchant average for AI analysis;
    3x+ threshold for real-time push alerts during sync. Baseline excludes the
    trailing 7 days so the candidate doesn't inflate its own baseline.
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
    Persistent year-round accumulation in `tax_deductions` for tax filing.
  - Goal tracking (with real-world economic context)
  - Recurring transfers (Zelle, bill payments, savings, investment patterns)
- **AI context enrichment**: Insights prompt includes month-over-month trend deltas,
  current budget status (spent vs limits), and recurring transfer data.
  Module tracking: all enabled modules are registered in `activeModules` when their
  system prompt instructions are added (not conditionally when data queries succeed).
  This ensures `max_tokens` is correctly allocated and `modules_used` in the response
  reflects all enabled modules even if a module's data query fails silently.
- **Auto-trigger**: Insights auto-generate based on `insights_cadence_days` setting (checked every 6 hours)
- **Cost tracking**: Granular token-level pricing — `input_tokens` from Anthropic's API (already excludes cache tokens) is multiplied by the input rate; `cache_read_input_tokens` and `cache_creation_input_tokens` are billed separately at their own rates. This restores accurate `INSIGHTS_MONTHLY_BUDGET_CENTS` enforcement when prompt caching is active. The monthly budget is shared between `/api/insights` and `/api/categorize` — both check the same cap before calling Claude AND `/api/categorize` writes a `financial_insights` row with `entry_type='categorize'` after each AI call so its spend counts toward the cap (not just the read side). Display queries that surface "AI Insights" filter `entry_type='insight'` to keep categorize tracking rows out of the user-facing feed.
- **Insight inputs are split-adjusted**: AI insights see the same `spending_split_pct`-adjusted monthly spend totals and the same keyword-filtered income that the dashboard and `/api/savings-rate` show, via `services/financial-queries.js`.
- **Structured running summary**: AI long-term memory is structured JSON, not plain text. `POST /api/insights` uses Anthropic tool_use (`generate_financial_insight` tool, forced via `tool_choice`) to return BOTH the user-facing `insights_text` AND a typed `summary` object with four arrays: `trends`, `completed_goals`, `pending_actions`, `alerts`. The summary is saved to `user_settings.insights_running_summary_json` (JSONB); the legacy `insights_running_summary` TEXT column gets a human-readable rendering for backward-compat callers. `sanitizeStructuredSummary` enforces shape/length bounds (max items per array, string lengths, enum values) so a pathological tool response can't pollute long-term memory. The response includes `summary_status` — `"updated"` (normal), `"preserved_due_to_truncation"` (tool block missing because hit max_tokens), `"preserved_no_tool_block"` (model didn't comply with tool_choice — rare), or `"preserved_validation_failed"` (sanitizer rejected the shape) — so callers can surface when long-term memory didn't advance. `GET /api/insights/status` returns the full `running_summary` object plus a `running_summary_counts` block (`{trends, completed_goals, pending_actions, alerts}`) so dashboards can show "tracking 3 trends · 2 goals · 5 actions · 1 alert" without a second fetch.
- **AI insight auditing**: Post-generation validation via `services/ai-audit.js`. Four tiers:
  (1) arithmetic — dollar amounts and percentages compared to actual DB data, critical >20% off,
  warning >5%; (2) entity existence — merchant/goal/subscription names verified against DB,
  hallucinated entities flagged; (3) trend direction — "X is up/down" claims compared to actual
  month-over-month data; (4) consistency — detects self-contradictions within the same report.
  Results stored in `ai_audit_log` table. Critical findings trigger in-app notification.
  Module auto-disable requires user confirmation. `GET /api/insights/audit` returns
  `{ findings, stats, accuracy }`; `GET /api/insights/status` includes an
  `audit_accuracy` block — both surfaced via `getAuditAccuracy(days=90)`, which
  returns `{ total_audited_runs, clean_runs, accuracy_pct, findings_by_severity,
  findings_by_tier }` over the trailing 90 days. "Clean" = zero critical findings.
- **Insight email via Per-sistant**: After each scheduled insight generation, Perfin sends
  an `insights_generated` webhook to Per-sistant with `{ subject, html_body, plain_text }`.
  HTML email is pre-rendered in Perfin with app-matching dark theme (gold/amber accents,
  Arc Reactor branding). Includes audit findings section if critical issues detected.
  Per-sistant receives the webhook and forwards to its email service. If
  `persistent_webhook_secret_enc` is unset, `sendPerSistantWebhook` hard-refuses
  to dispatch (returns `{ sent: false, reason: "missing_secret" }`) — the
  receiver was already rejecting unsigned posts, so failures are now visible
  to the caller instead of being warned-and-dropped opaquely.
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
- **Status messages**: `.status-msg` (Perfin shared sheet + Per-sistant
  shared sheet) renders as a fixed-position toast in the top-right
  corner, with the existing `slideDown` keyframe. Visible regardless of
  page scroll so feedback from buttons low on long pages (e.g. Settings →
  "Run detection") doesn't require scrolling back up.
- **Dark/Light theme**: Toggle in Settings, persisted to DB + localStorage
- **PWA**: Installable home screen app (manifest.json + service worker, helmet icon centered on home screen).
  Service worker (cache `perfin-v4`) uses network-first, caches successful same-origin
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
- **"Last synced" nav badge** (Phase D): top nav shows "Synced 47m ago" with color-coded
  staleness: green (<6h), yellow (6-24h), red (>24h). Tooltip shows per-source
  freshness (transactions, balances, auto-sync). Populated from the most recent of
  `last_auto_sync_at`, `last_txn_sync_at`, `last_balance_sync_at`.
- **Unified notification center**: In-app notification history via `notification_log`
  table. Nav bar bell icon shows unread count badge. Clicking opens a dropdown panel
  listing recent notifications with timestamps. Click to mark read, "Mark all read"
  button. `sendToAll()` logs every push notification to the table, so notifications
  are preserved even if the user hasn't enabled push or dismissed the browser alert.
  API: `GET /api/notifications`, `PATCH /api/notifications/:id/read`,
  `POST /api/notifications/read-all`.
- **Data freshness API**: `GET /api/data-freshness` returns per-source timestamps
  (transactions, balances, auto-sync, insights) with `age_seconds`, a boolean
  `stale` flag (>24h), and an explicit `level` (`"fresh"` <6h / `"aging"` 6-24h /
  `"stale"` >24h or never synced). The response also includes a top-level
  `thresholds: { fresh_seconds, stale_seconds }` block so the nav badge's
  green/yellow/red mapping doesn't need to repeat threshold constants.
  `POST /api/sync` updates `last_txn_sync_at`; `POST /api/sync-balances`
  updates `last_balance_sync_at`.
- **Web Push notifications**: VAPID-based push notifications for anomalies, budget alerts,
  goal milestones
- **Accessibility**: Skip-to-content link, `<main>` landmark, chart aria-labels, :focus-visible
  styles, WCAG AA contrast-compliant text colors
- **CSP nonces**: Per-request cryptographic nonces for all inline scripts (no `'unsafe-inline'` in `scriptSrc`). Style policy is split: `styleSrcElem` is nonce-gated for `<style>` blocks while `styleSrcAttr` keeps `'unsafe-inline'` for inline `style=""` attributes.
- **Keep-alive**: Timezone-aware self-ping to prevent Render free tier sleep (10s timeout)
- **Per-model cost tracking**: Usage history with granular pricing (Haiku/Sonnet/Opus)
- **Google Sheets sync**: Auto-sync to 7 tabs — Transactions, Subscriptions,
  Utilities, AI Insights, Recurring Transfers, Tax Deductions, Dashboard (with
  net worth, budgets, goals, conditional formatting for over-budget categories).
  The Utilities tab consolidates auto-detected utility subscriptions and
  user-entered manual_bills with `category='utility'`, with a TOTAL roll-up
  row showing combined active monthly + yearly spend.

### Per-sistant Integration (Companion App)
Under the unified shell both apps run in the same Node process, so most of
what used to be a network/HMAC integration is now a function call or a
shared session cookie. Cross-app surface area today:
- **Shared auth**: shell PIN gate fronts both apps; sub-app `requireAuth`
  bails on `req.app.get("embedded")`.
- **Cross-app navigation**: in-nav "switch to other tool" link in each app's
  layout, only rendered when embedded. Same-origin, in-app navigation.
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
   to happen out-of-band.
2. **`TOKEN_ENCRYPTION_PASSPHRASE`** — used by `pgp_sym_encrypt` to store
   Teller access tokens, Plaid access tokens, and the Per-sistant webhook
   HMAC secret. Rotating it invalidates all stored ciphertext; the
   remediation is to re-link affected institutions (Teller Connect re-run
   for Teller items, Plaid Link re-run for Plaid items). After a rotation
   mismatch, `POST /api/plaid/sync-holdings` will surface
   `errors: [{ institution, error: "decryption_failed" }]` per affected
   item rather than silently returning zero accounts.

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
- 241 tests passing across 11 test files

## Commands
```bash
cd teller && npm install && node server.js    # Run locally
npm install                                    # ALSO required at repo root for tests
npm test                                       # Run 241 tests

# Key API endpoints
POST /api/enroll           # store Teller access token after Connect
POST /api/sync             # pull transactions for all enrollments
POST /api/sync-balances    # fetch latest account balances
POST /api/detect           # run subscription detection
POST /api/detect-transfers # run recurring transfer detection
GET  /api/recurring-transfers # list recurring transfers (query: filter=active|dismissed|all)
PATCH /api/recurring-transfers/:id/dismiss   # dismiss a recurring transfer
PATCH /api/recurring-transfers/:id/undismiss # restore a dismissed transfer
PATCH /api/recurring-transfers/:id/type      # reclassify transfer type
GET  /api/transactions     # list transactions (query: months, limit, offset)
GET  /api/transactions/search # search/filter (query: q, category, account_id, min/max_amount, start/end_date)
GET  /api/transactions/duplicates # find candidate duplicate transactions across accounts
PATCH /api/transactions/:id # user overrides: merchant_name, notes, is_reimbursed (Phase B1/B2)
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
GET  /api/csv-reminder     # list manual accounts overdue for a CSV refresh
GET  /api/subscriptions    # list detected subscriptions
GET  /api/accounts         # list linked accounts with balances (includes is_shared, spending_split_pct)
PATCH /api/accounts/:id    # update account details
PATCH /api/accounts/:id/shared # mark account as shared/joint (body: is_shared, spending_split_pct)
PATCH /api/accounts/:id/balance # update balance fields (current_balance, available_balance, credit_limit)
POST /api/accounts/manual  # create a manual (non-Teller, non-Plaid) account
DELETE /api/accounts/manual/:id # delete a manual account
GET  /api/spending-summary # monthly trends, categories, top merchants (split-adjusted)
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
POST /api/goals            # create a financial goal
GET  /api/investment-accounts # list manual investment accounts (manual + Plaid-synced rows in investment_accounts)
POST /api/investment-accounts # add manual investment account
GET  /api/investments         # unified investment list across Teller-linked + Plaid + manual sources
                              # (returns total_value, by_source totals, accounts[] with source/supports_holdings flags)
GET  /api/net-worth/history # net worth snapshots over time
GET  /api/context-export   # structured data dump for Claude chat
GET  /api/tax-deductions   # accumulated tax-deductible transactions
GET  /api/settings         # retrieve user settings
PATCH /api/settings        # update user settings
GET  /api/data-freshness   # per-source sync timestamps with staleness flags
GET  /api/budgets          # list budgets with current spending (query: month=YYYY-MM)
POST /api/budgets          # create budget (body: rollover_enabled, budget_type, effective_month)
PATCH /api/budgets/:id     # update budget
DELETE /api/budgets/:id    # delete budget
POST /api/budgets/suggest  # AI budget suggestions
POST /api/budgets/accept   # accept AI-suggested budget
GET  /api/budgets/alerts   # spending velocity warnings (critical/warning/info)
POST /api/budgets/snapshot # create monthly snapshot + compute rollovers (body: month=YYYY-MM, 01-12)
GET  /api/budgets/history  # budget snapshots for trend analysis (query: months)
POST /api/insights         # generate new AI insights
GET  /api/insights/status  # AI API config + usage stats + audit_accuracy (90d clean-run %)
                           # + running_summary (structured JSON) + running_summary_counts
GET  /api/insights/usage   # AI usage history
POST /api/insights/reset   # clear long-term AI context
POST /api/insights/rebuild # rebuild context from all history
GET  /api/insights/audit   # audit log + per-module stats + 90-day accuracy summary
POST /api/categorize       # ML categorize transactions (rules first, then Claude AI)
GET  /api/categorize/status # ML categorization status
GET  /api/categorize/review-queue # candidates the next AI categorize would send to Claude
POST /api/categorize/review # apply a single user decision (sets user_category, optionally creates rule)
PATCH /api/transactions/:id/category # manually set transaction category — writes user_category
PATCH /api/transactions/bulk-category # bulk update categories — writes user_category
GET  /api/categorization-rules       # list all categorization rules
POST /api/categorization-rules       # create a rule (body: merchant_pattern, category, match_type)
DELETE /api/categorization-rules/:id # delete a rule
POST /api/categorization-rules/apply # apply all active rules to uncategorized transactions
POST /api/categorization-rules/from-transaction # create rule from a manual categorization
POST /api/import-csv       # import bank CSV file (with deduplication)
GET  /api/csv-imports      # list CSV import history
GET  /api/export           # download transactions/subscriptions CSV
POST /api/sheets/sync      # sync to Google Sheets
POST /api/sheets/dashboard # sync dashboard data to Sheets
GET  /api/plaid/status     # Plaid investment API status
POST /api/plaid/link-token # create Plaid Link token for investments
POST /api/plaid/exchange   # exchange public token for access token
POST /api/plaid/sync-holdings # sync investment holdings
                               # Response: { accounts_updated, holdings_updated, errors[]? }
                               # Per-item failures (including NULL access_token from a
                               # pgp_sym_decrypt mismatch) surface as
                               # `errors: [{ institution, error: "decryption_failed" | ... }]`
GET  /api/plaid/holdings   # list investment holdings
GET  /api/notifications/vapid # get VAPID public key for push
POST /api/notifications/subscribe # register push subscription
DELETE /api/notifications/subscribe # unregister push subscription
POST /api/notifications/test # send test push notification
GET  /api/notifications      # list notification log (query: limit, unread=true)
PATCH /api/notifications/:id/read # mark notification as read
POST /api/notifications/read-all  # mark all notifications as read

# Tax export
GET  /api/export/tax-report # year-end deduction summary (query: year, format=csv|json)

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
GET  /dashboard                 # main dashboard UI
GET  /subscriptions             # subscription management
GET  /transactions              # transaction search/filter page
GET  /calendar                  # bill calendar page
GET  /goals                     # financial goals page
GET  /budgets                   # budget tracking page
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
```

`PATCH /api/settings` accepts a new `shell_idle_timeout_minutes` field
(integer, 5-10080 minutes) that drives the shell's sliding-window auth.
After the PATCH a hook fires `auth.invalidateIdleCache()` so the new
value applies on the very next request, not after the 60s cache lag.

## Environment Variables

### Shell (unified PIN gate)
- `SHELL_PIN` — unified PIN that fronts both apps. Constant-time compare with a 750ms throttle on incorrect attempts.
- `SHELL_SECRET` — random ~32+ char string (`openssl rand -hex 32`). Signs the shell session cookie. Rotating it invalidates every active session.
- `SHELL_PORT` — optional listener port override (defaults to `PORT` or `3000`)

### Databases (one per sub-app)
- `NEON_DATABASE_URL` — Perfin's Neon PostgreSQL connection string
- `PERSISTENT_DATABASE_URL` — Per-sistant's Neon DB (separate). Falls back to `NEON_DATABASE_URL` for standalone Per-sistant deployments.
- `TOKEN_ENCRYPTION_PASSPHRASE` — passphrase for encrypting access tokens at rest

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
- `INSIGHTS_MONTHLY_BUDGET_CENTS` — monthly API spending cap (default 50 = $0.50); shared between `/api/insights` and `/api/categorize`

### Push notifications (Perfin)
- `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` — Web Push keypair (`npx web-push generate-vapid-keys`); without these `/api/notifications/*` returns 501
- `VAPID_EMAIL` — contact `mailto:` URL (default `mailto:admin@perfin.app`)

### Keep-alive (Perfin / shell)
- `RENDER_EXTERNAL_URL` — auto-set by Render; the keep-alive self-ping uses it as the target URL when present, falling back to `http://localhost:PORT` for local runs. Operators don't set this manually.

### Investments (Perfin, optional)
- `PLAID_CLIENT_ID`, `PLAID_SECRET_SANDBOX|DEV|PROD` — Plaid investment-account linking
- `PLAID_ENV` — `sandbox` (default), `development`, or `production`; selects which `PLAID_SECRET_*` is used

### SMTP (Per-sistant — email scheduling)
- `SMTP_HOST` / `SMTP_PORT` / `SMTP_USER` / `SMTP_PASS` / `SMTP_FROM`

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
- Schema versioning via `schema_migrations` table exists (current value: 2) but is
  effectively dormant — every migration step uses `IF NOT EXISTS` / `IF NOT EXISTS`
  guards and runs unconditionally. The `schema_migrations` row is recorded for
  observability only; it does not gate any migration logic today.
- Schema files in `db/` for reference only
- Key tables: `teller_enrollments`, `linked_accounts`, `transactions`,
  `transaction_splits`, `detected_subscriptions`, `recurring_transfers`,
  `user_settings` (single-row), `financial_insights`, `financial_goals`,
  `net_worth_snapshots`, `tax_deductions`, `csv_imports`, `budgets`, `budget_snapshots`,
  `push_subscriptions`, `webauthn_credentials`, `investment_accounts`, `investment_holdings`,
  `plaid_investment_items`, `plaid_items`, `sync_cursors`, `schema_migrations`,
  `categorization_rules`, `manual_bills`, `bill_payments`, `notification_log`,
  `ai_audit_log`, `account_balance_snapshots`
- `user_settings`: single-row pattern (CHECK id = 1) for app preferences
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
  Phase B4: `user_category TEXT` holds manual category overrides. `PATCH
  /api/transactions/:id/category` and bulk-category write here (NOT
  `category`), so a Teller re-sync — which UPSERTs `category = EXCLUDED.category`
  — can't overwrite user choices. Display layers use
  `COALESCE(user_category, category[1])` everywhere, including the rules-apply
  candidate filter so user-overridden rows aren't re-categorized.
- `transaction_splits` (Phase B3): subdivides a single Teller transaction into
  multiple `(amount, category, merchant_name, notes)` rows that REPLACE the
  parent in per-category aggregations. `parent_transaction_id` references
  `transactions(transaction_id)` with `ON DELETE CASCADE`. Indexed by parent.
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
- `user_settings` data freshness: `last_txn_sync_at TIMESTAMPTZ` (updated by
  `POST /api/sync`), `last_balance_sync_at TIMESTAMPTZ` (updated by
  `POST /api/sync-balances`). The nav badge uses the most recent of these plus
  `last_auto_sync_at` to display staleness.
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
- `bill_payments`: tracks which bills have been paid. Columns: `bill_source`
  (subscription or manual), `bill_id`, `paid_date`, `paid_amount`, `notes`.
  UNIQUE on (bill_source, bill_id, paid_date). Calendar shows paid state.
- `notification_log`: in-app notification history. Columns: `type`, `title`, `body`,
  `data` (JSONB), `is_read`. `sendToAll()` inserts here on every push notification.
  Indexed on (is_read, created_at DESC) for fast unread queries.
- `ai_audit_log`: post-generation insight validation results. Columns: `insight_id`
  (FK to financial_insights), `module`, `severity` (critical/warning/info),
  `check_type` (tier1-4), `claim_text`, `expected_value`, `actual_value`.
  Indexed on (insight_id, severity).
- `financial_insights.entry_type TEXT NOT NULL DEFAULT 'insight'`: discriminator
  that lets `/api/categorize` write its AI usage rows to the same table without
  shadowing the user-facing "AI Insights" feed. Display queries (`GET
  /api/insights`, the previous-insight reference inside `POST /api/insights`,
  `/api/insights/rebuild`) filter `entry_type = 'insight'`. The shared monthly-
  budget cost queries do NOT filter — both `'insight'` and `'categorize'` rows
  count toward `INSIGHTS_MONTHLY_BUDGET_CENTS`. Without this, categorize was
  read-only against the cap (checked it but never charged itself).
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
- Cadences ≥60 days (bi-monthly, quarterly, yearly) require only 2+ occurrences;
  shorter cadences (7/14/30) require 3+ occurrences
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

An idempotent cleanup runs on every startup as part of the migration step:
it deactivates any subscription/transfer row whose `merchant_key` matches
`transactions.merchant_name` AND whose underlying transactions have a
differing `user_merchant_name` override set. This auto-retires the orphans
without waiting for the 120-day staleness sweep. The UPDATE is a no-op when
no orphans exist, so the migration stays cheap. Users who still see
duplicates after a restart (e.g. orphans without matching transaction rows)
can dismiss them from the UI or run `POST /api/cleanup`.

## Security
- **CSP nonces**: Per-request `crypto.randomBytes(16)` nonce for all inline scripts.
  No `'unsafe-inline'` in `scriptSrc`. Nonce passed via `res.locals.nonce` to EJS templates.
  Style policy is split (CSP Level 3): `styleSrcElem` requires the nonce on
  `<style>` blocks (the only such block lives in `partials/head.ejs` and now
  carries `nonce="<%= nonce %>"`). `styleSrcAttr` keeps `'unsafe-inline'` so the
  hundreds of inline `style="..."` attributes across templates continue to
  work; migrating each one is out of scope for now.
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
  SSO validate (10/15min)
- **SSO replay protection**: Each SSO token embeds a 24-byte random nonce; validate tracks
  used nonces in an in-memory Map (2-minute TTL cleanup) and rejects duplicates. Nonce is
  consumed after signature verification so timing attacks can't burn legitimate nonces.
  Additionally, the nonce is *reserved* immediately before HMAC verification (atomic
  check-and-set) to prevent concurrent requests with the same token from both passing.
  If signature verification fails, the reservation is released so legitimate nonces
  aren't burned by bad signatures.
- **WebAuthn rpID**: Derived per-request from `req.hostname` (not cached at module scope),
  so deployments behind proxies with multiple hostnames or DNS changes work correctly.
- **Biometric registration UI**: Settings → Security → "Biometric Login"
  section lists registered credentials and provides Register / Remove
  buttons via the existing `/api/webauthn/*` endpoints. Section auto-hides
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
All run automatically after server startup. Per-app jobs live in
`teller/startup.js`; keep-alive runs at the shell layer (`shell/index.js`)
under the unified shell so the timezone-aware self-ping fires regardless of
which sub-app owns its own listener (sub-app `startKeepAlive` is no-op in
embedded mode).
- **Keep-alive ping** (shell layer): every 14 min (timezone-aware active hours, 10s timeout); reads `keep_alive_enabled` and active-hours from Perfin's `user_settings` each tick
- **Sheets auto-sync**: every 1 hour (daily/weekly/monthly cadence from settings)
- **Net worth snapshot**: every 1 hour (`ON CONFLICT (snapshot_date) DO UPDATE` so a same-day re-run rewrites the row with the latest balances — late-arriving syncs are reflected immediately)
- **Goal milestones**: every 6 hours (push notifications at 25/50/75/100%)
- **AI insights auto-trigger**: every 6 hours (respects `insights_cadence_days` setting).
  Pre-analysis sync chain: syncAllEnrollments → syncAllBalances → detect subscriptions →
  detect transfers → categorize → generate insights → audit → email webhook.
  Ensures AI analyzes freshest data. Auto-categorization runs as part of this pipeline.
- **Budget alerts**: every 3 hours (push notifications at 80% and 100%+ thresholds, aligned with the in-app `/api/budgets/alerts` `warning`/`critical` levels). The in-app `info`/pace heuristic is intentionally not pushed (too noisy as a notification).
- **Budget snapshot auto-trigger**: every 6 hours, checks if today is the 1st of the
  month. If so, creates a snapshot for the previous month (spending + rollover amounts)
  so budget rollover advances automatically. Idempotent — skips if snapshot already exists.
- **Bank auto-sync** (Phase A): every 1 hour, checks `auto_sync_enabled` and whether
  `auto_sync_interval_hours` has elapsed since `last_auto_sync_at`. When due, calls
  `syncAllEnrollments()` then `syncAllBalances()` in-process — never via HTTP self-fetch,
  so API_KEY-protected deployments don't 401 against themselves. Updates
  `last_auto_sync_at` on every check (success or partial failure).
  Push notification only fires when at least one transaction was added, at
  least one balance was updated, or a sync failed — silent successful syncs
  no longer produce hourly notification noise. Failed syncs still notify
  under "Auto-sync issue" so the user knows the data isn't fresh.
  Note: on Render free tier, scheduled syncs only fire while the process is awake;
  enable `keep_alive_enabled` if you need guaranteed cadence.
- **CSV import reminders**: every 24 hours, checks manual (CSV-only) accounts
  whose most recent CSV import is older than `csv_reminder_days` setting.
  Sends notification listing specific account names needing a fresh upload.

## Shared Account Spending Split
All spending queries apply the split percentage for shared/joint accounts via SQL JOIN:
```sql
t.amount * COALESCE(la.spending_split_pct, 100) / 100.0
```
This affects: spending-summary (monthly_trend, byCategory, topMerchants), savings-rate,
spending-yoy, budgets, budget alerts, and cash flow.

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
  `spending_split_pct`-adjusted spending that honors transaction_splits.
  AI insights routes through it so Claude sees the same numbers the
  dashboard shows. Helpers:
  - `getMonthlyIncome(pool, months)` — keyword-filtered income, last N months
  - `getMonthlySpending(pool, months)` — split-adjusted spending, last N months
  - `getCategorySpendingThisMonth(pool)` — current-month per-category spend
    (anchored to Postgres `CURRENT_DATE` so month-end semantics match the SQL)
  - `getCategorySpendingForMonth(pool, monthStr)` — same shape, but for an
    arbitrary `'YYYY-MM'` month; used by `GET /api/budgets?month=...`,
    `POST /api/budgets/snapshot`, and the budget-snapshot auto-trigger so
    snapshots record the correct month's spending instead of always-this-month.
  Constants: `INCOME_PREDICATE`, `NOT_TRANSFER`, `SPLIT_AMOUNT`, `NOT_REIMBURSED`.
  `/api/savings-rate` calls `getMonthlyIncome` + `getMonthlySpending`;
  `/api/cash-flow` uses `INCOME_PREDICATE`; `/api/budgets/alerts` and the
  scheduled budget-alert push use `getCategorySpendingThisMonth`. The
  spending-summary monthly-trend path still inlines equivalent SQL — any new
  financial endpoint should use this module instead of re-inlining.
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
  `user_category` (manual category overrides set via `PATCH
  /api/transactions/:id/category`): every display query — including the
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
- **Categorization rules first, then AI.** When `POST /api/categorize` is
  called, user-defined rules from `categorization_rules` are applied first
  (free, instant, pattern matching) before sending remaining uncategorized
  transactions to Claude (paid API call). This means a user who creates a
  rule for "Amazon" → "Shopping" will never pay for AI to categorize Amazon
  transactions. Rules are matched against `COALESCE(user_merchant_name,
  merchant_name, name)` so user-renamed merchants are also handled.
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
  and stored in `budget_snapshots`. `GET /api/budgets` adds the most recent
  snapshot's `rollover_amount` to the base `monthly_limit` to produce
  `effective_limit`. One-time budgets (`budget_type = 'one_time'`) share the
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
  - `routes/enrollments.js` → `syncAllEnrollments`, `syncAllBalances`
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
  enum-style string (`"not_configured"`, `"missing_secret"`) so callers
  can branch on the specific failure mode rather than parsing logs.
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
- **Status messages render as fixed-position toasts.** `.status-msg`
  (Perfin shared + Per-sistant) is `position: fixed; top: 16px; right:
  16px;` so action feedback for buttons low on a long page (Settings →
  "Run detection") shows up regardless of scroll position. No JS change
  — every existing `showStatus(...)` call site keeps working.

## Git
- Render deploys from `main` (configured in the Render dashboard, not in `render.yaml`)
- PEM files and `.env` are in `.gitignore`

## Companion App: Per-sistant
- **Location**: `apps/per-sistant/` (subtree-merged into this repo; original
  per-sistant history preserved). Originally lived at `github.com/robinchoudhuryums/per-sistant`.
- **Purpose**: Personal assistant — task management, email scheduling, notes,
  AI productivity briefings, calendar.
- **Integration under unified shell**: see "Per-sistant Integration" section
  above. Sub-app mounts at `/per-sistant/*`, shares the shell's session cookie,
  runs its own migrations against `PERSISTENT_DATABASE_URL`.
- **Per-app docs**: `apps/per-sistant/CLAUDE.md` for route-by-route architecture,
  `apps/per-sistant/README.md` for a public overview.
- **Standalone fallback**: `npm run start:persistent` boots it on its own
  port (3001) using the legacy `NEON_DATABASE_URL` fallback, useful for
  isolated debugging.

## Priority Next Features
1. **Mobile app** — React Native or Capacitor wrapper for native experience
2. **Multi-user support** — Shared household finance tracking with role-based access
3. **Onboarding flow** — Guided "Getting Started" checklist (link account → sync →
   categorize → set budgets) visible until all steps complete
4. **Investment performance & allocation** — Plaid syncs holdings (qty, cost basis,
   current value); compute returns, asset allocation, and goal-vs-portfolio drift
