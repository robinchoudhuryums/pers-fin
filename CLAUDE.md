# CLAUDE.md — Project Context for Claude Code

## Project Overview
Personal finance tracker that detects recurring charges, compares spending to benchmarks,
tracks financial goals, and provides AI-powered insights. Uses **Teller API** (primary) and
Plaid (legacy/investments) for bank account linking via mTLS. Companion app to **Per-sistant**
(personal assistant/task manager) — shared design system, cross-app SSO, webhook integration,
and combined weekly summary email.

## Architecture (Modular)
The server is split into focused modules under `teller/`:

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
                           keyword-filtered income) — single source of truth used by
                           AI insights so the numbers match the dashboard
  routes/
    enrollments.js       — POST /api/enroll, POST /api/sync, GET /api/items,
                           DELETE /api/enrollments/:id, GET /api/accounts,
                           PATCH /api/accounts/:id, PATCH /api/accounts/:id/shared,
                           POST /api/sync-balances, GET /api/spending-summary,
                           GET /api/cash-flow, GET /api/savings-rate,
                           GET /api/spending-yoy
    subscriptions.js     — GET/POST /api/subscriptions, PATCH dismiss/undismiss/cancel/
                           uncancel/category, GET /api/transactions,
                           GET /api/transactions/search, POST /api/detect,
                           POST /api/import-csv, GET /api/csv-imports, POST /api/cleanup,
                           GET /api/recurring-transfers, POST /api/detect-transfers,
                           PATCH /api/recurring-transfers/:id/dismiss|undismiss|type
    goals.js             — GET/POST/PATCH/DELETE /api/goals, POST /api/net-worth/snapshot,
                           GET /api/net-worth/history, GET /api/context-export,
                           GET/POST /api/investment-accounts
    budgets.js           — GET/POST/PATCH/DELETE /api/budgets, POST /api/budgets/suggest,
                           POST /api/budgets/accept, GET /api/budgets/alerts
    settings.js          — GET/PATCH /api/settings, POST /api/sheets/sync,
                           POST /api/sheets/dashboard, GET /api/export
    insights.js          — GET/POST /api/insights, GET /api/insights/status,
                           GET /api/insights/usage, POST /api/insights/reset,
                           POST /api/insights/rebuild, GET/PATCH /api/tax-deductions
    categorize.js        — POST /api/categorize, GET /api/categorize/status,
                           PATCH /api/transactions/:id/category,
                           PATCH /api/transactions/bulk-category
                           (ML categorization via Claude tool_use structured output)
    investments.js       — GET /api/plaid/status, POST /api/plaid/link-token,
                           POST /api/plaid/exchange, POST /api/plaid/sync-holdings,
                           GET /api/plaid/holdings (Plaid investment accounts)
    notifications.js     — GET /api/notifications/vapid, POST/DELETE /api/notifications/subscribe,
                           POST /api/notifications/test (Web Push notifications)
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
    calendar.js          — Bill calendar page showing upcoming subscription charges
    login.js             — PIN pad or password login page (with materialize animation)
    settings.js          — Settings page (theme, AI insights, keep-alive, Per-sistant, exports)
    pwa.js               — PWA manifest.json + icon generation (icons cached at startup)
  public/
    logo.svg             — Iron Man helmet SVG logo (traced from PNG, used as nav icon, PWA icon)
    sw.js                — Service worker (network-first with offline cache fallback for static assets;
                           `/api/*` is intentionally NOT cached — stale balances are worse than a clear
                           network error. Precaches CSS/JS/SVG on install. Push notifications.)
    perfin-shared.css    — Shared styles (variables, nav, cards, animations, responsive, focus-visible,
                           skip-link, WCAG AA contrast-compliant text-muted colors)
    perfin-shared.js     — Shared JavaScript (apiFetch, theme, nav helpers, asyncAction, btnLoading)
  views/
    dashboard.ejs        — Dashboard template with 3D financial wellness pyramid
    transactions.ejs     — Transaction search/filter template
    calendar.ejs         — Bill calendar template
    login.ejs            — Login template with helmet materialize animation on success
    partials/head.ejs    — HTML head (meta, PWA manifest, apple-touch-icon, theme, skip-link)
    partials/nav.ejs     — Top navigation bar with helmet logo icon, <main> landmark
    partials/foot.ejs    — Footer partial (closes <main>)
```

**Other key files:**
- `plaid/server.js` — Legacy Plaid server (still functional)
- `scripts/detect-subscriptions.js` — Recurring subscription detection (30/60/90/365-day cadences)
- `scripts/detect-transfers.js` — Recurring transfer detection (7/14/30/60/90/365-day cadences,
  6 transfer types: peer_transfer, bill_payment, savings, investment, internal, other)
- `scripts/sheets-sync.js` — Google Sheets sync (6 tabs: Transactions, Subscriptions,
  AI Insights, Recurring Transfers, Tax Deductions, Dashboard)
- `scripts/import-csv-cli.js` — Standalone CLI for importing bank CSVs (mirror of the
  `/api/import-csv` route — note format detection drift between the two; see audit H8)
- `scripts/retention-cleanup.sql` — Reference SQL for the manual cleanup queries
  exposed by `POST /api/cleanup`
- `apps-script/Code.gs` — Google Sheets Apps Script (standalone + server sync)
- `tests/` — 139 tests across 7 files (node:test runner, `npm test`).
  Includes `tests/audit-regressions.test.js` which pins documented behavior
  for auth, SSO, template hygiene, and exclusion rules. Run `npm install`
  at the repo root before `npm test` (root `package.json` declares the
  test-time deps separately from `teller/`).
- `.github/workflows/ci.yml` — CI pipeline (runs `npm ci` at root + `teller/`, then `npm test`)
- `.claude/commands/` — Project slash-command prompts: `/broad-scan`, `/broad-implement`,
  `/test-sync`, `/sync-docs`
- `Dockerfile`, `fly.toml`, `render.yaml` — Deployment configs

## Features

### Core Financial
- **Bank linking**: Teller Connect UI + mTLS API for transaction sync
- **Investment accounts**: Plaid API integration for brokerage/retirement/crypto holdings
- **CSV import**: Auto-detect Chase, Capital One, Discover, Wells Fargo, Schwab formats
- **Transaction deduplication**: SHA256-based duplicate detection across CSV imports and API syncs
- **Subscription detection**: Automatic recurring charge identification (30/60/90/365-day cadences)
- **Recurring transfer detection**: Auto-detect Zelle, Venmo, bill payments, savings transfers,
  investment contributions, ACH/wire (7/14/30/60/90/365-day cadences, outgoing/incoming split)
- **Utility separation**: Utilities tracked separately from optional subscriptions
- **Shared accounts**: Joint/shared card support with configurable spending split percentage
  (`is_shared`, `spending_split_pct` on linked_accounts, applied in all spending queries via SQL JOIN)
- **Financial goals**: Track progress toward savings/investment targets with compound interest projections
  (logarithmic formula), milestone push notifications at 25/50/75/100%
- **Net worth tracking**: Automated daily snapshots with trend history
- **Credit utilization**: Derived credit limit display, utilization percentages
- **Tax deduction persistence**: Flagged deductions stored in `tax_deductions` table, accumulated year-round

### Dashboard & Views
- **Dashboard**: Monthly spending trend (line chart), category breakdown (doughnut), account balances,
  3D financial wellness pyramid, savings rate widget, cash flow forecast widget, Per-sistant productivity widget
- **3D Financial Pyramid**: Interactive spinning pyramid with 4 frustum layers, neon wireframe edges,
  holographic effects. Layers computed by JS (`buildPyramidGeometry()`) with proper taper geometry.
  Configurable data sources: wellness, debt payoff, goal progress, etc. Mobile-optimized (reduced
  filters/shadows on small screens, `prefers-reduced-motion` support).
- **Transaction search**: Full-text search with filters — category, account, amount range, date range
  (GET /api/transactions/search)
- **Bill calendar**: Monthly calendar view of upcoming subscription/bill charges projected from cadences
- **Cash flow forecast**: Rolling 30–180 day projection with day-of-week spending averages,
  income detection (keyword matching, excludes transfers/payments/refunds), bill scheduling
- **Savings rate**: Income vs spending analysis with configurable lookback (default 3 months)
- **Year-over-year comparisons**: Month-by-month spending comparison vs prior year
- **Budget alerts** (`GET /api/budgets/alerts`): Spending velocity/pacing warnings with severity levels — `critical` ≥100% (over budget), `warning` ≥80% (approaching limit), `info` when pace > 1.2× and ≥50% (spending faster than the month's progress). The 3-hour scheduled push-notification path uses the same 80% / 100% thresholds; the in-app `info`/pace heuristic is intentionally not pushed (too noisy as a notification).

### AI & Intelligence
- **ML categorization**: Claude-powered smart transaction categorization via tool_use structured
  output (POST /api/categorize). Respects user's model preference from settings.
- **AI budget suggestions**: Claude suggests budgets based on 3-month spending history via tool_use.
- **AI Insights** (12 toggleable modules, auto-triggered based on cadence setting):
  - Utility rate comparison (vs state/national averages, requires ZIP)
  - Spending benchmarks (vs BLS Consumer Expenditure Survey)
  - Savings & wealth-building suggestions
  - Subscription audit (overlaps, alternatives)
  - Anomaly detection (transactions 2x+ above merchant average; baseline excludes the trailing 7 days so the candidate doesn't inflate its own baseline)
  - Seasonal forecasting (24-month pattern analysis)
  - Debt payoff optimizer (avalanche vs snowball, credit score projections)
  - Bill negotiation tips
  - Income & savings rate analysis
  - Tax deduction flags (word-boundary keyword matching to avoid substring false positives like "interest"→"internet"; persistent year-round accumulation for tax filing)
  - Goal tracking (with real-world economic context)
  - Recurring transfers (Zelle, bill payments, savings, investment patterns)
- **AI context enrichment**: Insights prompt includes month-over-month trend deltas,
  current budget status (spent vs limits), and recurring transfer data
- **Auto-trigger**: Insights auto-generate based on `insights_cadence_days` setting (checked every 6 hours)
- **Cost tracking**: Granular token-level pricing — `input_tokens` from Anthropic's API (already excludes cache tokens) is multiplied by the input rate; `cache_read_input_tokens` and `cache_creation_input_tokens` are billed separately at their own rates. This restores accurate `INSIGHTS_MONTHLY_BUDGET_CENTS` enforcement when prompt caching is active.
- **Insight inputs are split-adjusted**: AI insights see the same `spending_split_pct`-adjusted monthly spend totals and the same keyword-filtered income that the dashboard and `/api/savings-rate` show, via `services/financial-queries.js`.
- **Running-summary truncation handling**: When the model hits its `max_tokens` ceiling mid-response, the prior `insights_running_summary` is preserved rather than overwritten with a partial update. `POST /api/insights` returns `stop_reason` (from Anthropic) and `summary_status` (`"updated"`, `"preserved_due_to_truncation"`, or `"preserved_no_delimiter"`) so callers can surface when long-term memory didn't advance.
- **Context export**: Structured financial data (markdown/JSON) for pasting into Claude chat deep-dives
- **Real-time anomaly alerts**: Push notifications for charges 3x+ above merchant average during sync
- **Budget threshold alerts**: Push notifications at 80% (warning) and 100%+ (exceeded) every 3 hours

### UI & UX
- **Authentication**: SESSION_PASSWORD (text) or SESSION_PIN (numeric PIN pad), configurable timeout
- **Login animation**: Iron Man helmet materialize effect on successful login (gold-amber stroke-draw → fill → redirect)
- **Branding**: Iron Man helmet logo (SVG traced from PNG) — nav bar icon (CSS mask), PWA icon, login page
- **Dark/Light theme**: Toggle in Settings, persisted to DB + localStorage
- **PWA**: Installable home screen app (manifest.json + service worker, helmet icon centered on home screen).
  Service worker uses network-first, caches successful same-origin static GETs, and explicitly
  skips `/api/*` so the dashboard never serves stale balances when offline.
- **Web Push notifications**: VAPID-based push notifications for anomalies, budget alerts,
  goal milestones
- **Accessibility**: Skip-to-content link, `<main>` landmark, chart aria-labels, :focus-visible
  styles, WCAG AA contrast-compliant text colors
- **CSP nonces**: Per-request cryptographic nonces for all inline scripts (no 'unsafe-inline')
- **Keep-alive**: Timezone-aware self-ping to prevent Render free tier sleep (10s timeout)
- **Per-model cost tracking**: Usage history with granular pricing (Haiku/Sonnet/Opus)
- **Google Sheets sync**: Auto-sync to 6 tabs — Transactions, Subscriptions, AI Insights,
  Recurring Transfers, Tax Deductions, Dashboard (with net worth, budgets, goals, conditional
  formatting for over-budget categories)

### Per-sistant Integration (Companion App)
- **Cross-app SSO**: HMAC-signed token exchange (60-second expiry) for seamless auth between apps
- **Webhook system**: HMAC-signed event notifications (anomaly_detected, budget_exceeded,
  new_subscription, goal_milestone, csv_reminder) sent to Per-sistant
- **Productivity context**: Fetches task/review stats from Per-sistant for AI enrichment
- **Combined weekly summary**: Single email combining finances + productivity (sent by Per-sistant,
  with fallback — if one data source fails, the other still sends)
- **Navigation**: Cross-linked nav bars between apps when URLs configured

## Deployment

### Render (Free, recommended — currently deployed)
1. Connect GitHub repo in Render dashboard
2. Create Web Service from `render.yaml` blueprint
3. Provide the Teller mTLS cert via env vars (this is what `render.yaml` configures —
   `services/teller-api.js` reads them directly, no Secret-Files step needed):
   - `TELLER_CERT` = `base64 < certificate.pem`
   - `TELLER_KEY`  = `base64 < private_key.pem`
   *(Alternative: upload as Render Secret Files and set
   `TELLER_CERT_PATH=/etc/secrets/certificate.pem` and `TELLER_KEY_PATH=/etc/secrets/private_key.pem` —
   the code defaults to `./certificate.pem` so the path env vars are required if you go this route.)*
4. Set remaining env vars (see Environment Variables below)
5. Access at `https://pers-fin-tracker.onrender.com`

### Fly.io (~$2/mo)
```bash
fly launch --name pers-fin-tracker
fly secrets set NEON_DATABASE_URL="postgres://..." TOKEN_ENCRYPTION_PASSPHRASE="..."
fly secrets set TELLER_APPLICATION_ID="app_pplg2et45b7bl1scna000" TELLER_ENV="development"
fly secrets set TELLER_CERT=$(base64 < certificate.pem) TELLER_KEY=$(base64 < private_key.pem)
fly deploy
```

### Local
```bash
cd teller && npm install && node server.js
# Open http://localhost:3000
```

## Current Status
- Deployed on Render (free tier, sleeps after 15 min idle)
- Render deploys from `claude/subscription-tracker-plaid-WeQTA` (configured in Render dashboard).
  Active development happens on `claude/audit-documentation-SX9kS`.
- Env vars configured in Render dashboard
- Teller mTLS cert provided via base64 env vars (`TELLER_CERT` / `TELLER_KEY`); `services/teller-api.js`
  reads them directly. Secret-Files path also supported if `TELLER_CERT_PATH` env vars are set.
- Teller Application ID: `app_pplg2et45b7bl1scna000`
- 139 tests passing across 7 test files

## Commands
```bash
cd teller && npm install && node server.js    # Run locally
npm install                                    # ALSO required at repo root for tests
npm test                                       # Run 139 tests

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
DELETE /api/transactions/:id # delete a single transaction (deduplication tool)
GET  /api/forecast         # 7-90 day projection of recurring subscription charges
GET  /api/bill-calendar    # monthly calendar of expected charges + recurring income (query: year, month)
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
GET  /api/spending-yoy     # year-over-year comparison (query: month, year)
GET  /api/goals            # list financial goals with projections
POST /api/goals            # create a financial goal
GET  /api/investment-accounts # list manual investment accounts
POST /api/investment-accounts # add manual investment account
GET  /api/net-worth/history # net worth snapshots over time
GET  /api/context-export   # structured data dump for Claude chat
GET  /api/tax-deductions   # accumulated tax-deductible transactions
GET  /api/settings         # retrieve user settings
PATCH /api/settings        # update user settings
GET  /api/budgets          # list budgets with current spending (split-adjusted)
POST /api/budgets          # create budget
PATCH /api/budgets/:id     # update budget
DELETE /api/budgets/:id    # delete budget
POST /api/budgets/suggest  # AI budget suggestions
POST /api/budgets/accept   # accept AI-suggested budget
GET  /api/budgets/alerts   # spending velocity warnings (critical/warning/info)
POST /api/insights         # generate new AI insights
GET  /api/insights/status  # AI API config + usage stats
GET  /api/insights/usage   # AI usage history
POST /api/insights/reset   # clear long-term AI context
POST /api/insights/rebuild # rebuild context from all history
POST /api/categorize       # ML categorize transactions via Claude (tool_use structured output)
GET  /api/categorize/status # ML categorization status
PATCH /api/transactions/:id/category # manually set transaction category
PATCH /api/transactions/bulk-category # bulk update categories
POST /api/import-csv       # import bank CSV file (with deduplication)
GET  /api/csv-imports      # list CSV import history
GET  /api/export           # download transactions/subscriptions CSV
POST /api/sheets/sync      # sync to Google Sheets
POST /api/sheets/dashboard # sync dashboard data to Sheets
GET  /api/plaid/status     # Plaid investment API status
POST /api/plaid/link-token # create Plaid Link token for investments
POST /api/plaid/exchange   # exchange public token for access token
POST /api/plaid/sync-holdings # sync investment holdings
GET  /api/plaid/holdings   # list investment holdings
GET  /api/notifications/vapid # get VAPID public key for push
POST /api/notifications/subscribe # register push subscription
DELETE /api/notifications/subscribe # unregister push subscription
POST /api/notifications/test # send test push notification

# Tax export
GET  /api/export/tax-report # year-end deduction summary (query: year, format=csv|json)

# WebAuthn / biometric login
POST /api/webauthn/register-options    # generate registration challenge (auth required)
POST /api/webauthn/register            # verify and store new credential (auth required)
POST /api/webauthn/authenticate-options # generate auth challenge (no session needed)
POST /api/webauthn/authenticate        # verify biometric and create session
GET  /api/webauthn/credentials         # list registered credentials (auth required)
DELETE /api/webauthn/credentials/:id   # remove a credential (auth required)

# Per-sistant integration endpoints
POST /api/persistent/webhook/test  # test webhook connectivity to Per-sistant
POST /api/persistent/webhook/send  # manually trigger webhook event
GET  /api/persistent/status        # Per-sistant connection health check
GET  /api/persistent/productivity-context # fetch task/review stats from Per-sistant
POST /api/sso/generate             # create HMAC-signed SSO token (60s expiry)
POST /api/sso/validate             # validate SSO token, create session

# Pages
GET  /dashboard            # main dashboard UI
GET  /subscriptions        # subscription management
GET  /transactions         # transaction search/filter page
GET  /calendar             # bill calendar page
GET  /goals                # financial goals page
GET  /budgets              # budget tracking page
GET  /settings             # settings page
GET  /login                # login page (if auth enabled)
GET  /health               # health check
```

## Environment Variables
- `NEON_DATABASE_URL` — Neon PostgreSQL connection string
- `TOKEN_ENCRYPTION_PASSPHRASE` — passphrase for encrypting access tokens at rest
- `TELLER_APPLICATION_ID` — Teller app ID
- `TELLER_ENV` — Teller environment (sandbox/development/production)
- `TELLER_CERT` / `TELLER_KEY` — base64-encoded mTLS PEMs (Render)
- `TELLER_CERT_PATH` / `TELLER_KEY_PATH` — file paths (default `./certificate.pem` / `./private_key.pem`)
- `TELLER_CERT_CONTENT` / `TELLER_KEY_CONTENT` — raw PEM contents written to disk by `docker-entrypoint.sh` at container start
- `SESSION_PASSWORD` — text password for login (omit to disable auth)
- `SESSION_PIN` — numeric PIN for PIN pad login (alternative to password)
- `SESSION_SECRET` — session cookie secret (auto-generated if not set)
- `ANTHROPIC_API_KEY` — enables AI financial insights via Claude
- `INSIGHTS_MONTHLY_BUDGET_CENTS` — monthly API spending cap (default: 50 = $0.50)
- `API_KEY` — optional API key for /api/* endpoints (dev mode if not set)
- `ALLOWED_ORIGINS` — comma-separated CORS origins
- `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` — Web Push keypair (generate via `npx web-push generate-vapid-keys`); without these `/api/notifications/*` returns 501
- `VAPID_EMAIL` — contact `mailto:` URL for the Web Push subscriber (default `mailto:admin@perfin.app`)
- `PLAID_CLIENT_ID`, `PLAID_SECRET_SANDBOX|DEV|PROD` — optional, enables Plaid investment-account linking via `routes/investments.js`
- `PERSISTENT_URL` — URL of companion Per-sistant instance (also stored in user_settings)
- `PERSISTENT_WEBHOOK_SECRET` — HMAC secret for signing webhook payloads to Per-sistant
- `SSO_SECRET` — shared HMAC secret for cross-app SSO token exchange. **Required** if Per-sistant integration is in use; both apps must set the same value. Endpoints return 500 if unset.

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
- Key tables: `teller_enrollments`, `linked_accounts`, `transactions`, `detected_subscriptions`,
  `recurring_transfers`, `user_settings` (single-row), `financial_insights`, `financial_goals`,
  `net_worth_snapshots`, `tax_deductions`, `csv_imports`, `budgets`, `push_subscriptions`,
  `webauthn_credentials`, `investment_accounts`, `investment_holdings`, `plaid_investment_items`,
  `schema_migrations`
- `user_settings`: single-row pattern (CHECK id = 1) for app preferences
- `linked_accounts` columns include: `is_shared BOOLEAN`, `spending_split_pct INT DEFAULT 100`,
  `is_manual BOOLEAN` — constraint `chk_account_source` allows `plaid_item_id IS NOT NULL OR
  teller_enrollment_id IS NOT NULL OR is_manual = true`
- `user_settings` includes Per-sistant config: `persistent_url TEXT`,
  `persistent_webhook_secret_enc BYTEA` (encrypted at rest with `pgp_sym_encrypt`,
  same passphrase as Teller/Plaid tokens), `persistent_webhook_enabled BOOLEAN`
- `user_settings.last_anomaly_check_at TIMESTAMPTZ` — watermark used by the post-sync
  anomaly notifier (`POST /api/sync`) to dedupe push notifications. Only transactions
  whose `created_at > last_anomaly_check_at` are considered candidates, so the same
  anomaly never re-pushes on subsequent syncs.

## Recurring Transfer Detection
Transfers are identified by keyword matching on merchant_name/name fields:
- **peer_transfer**: zelle, venmo, cash app, paypal
- **bill_payment**: autopay, minimum payment, credit card payment, loan payment, mortgage payment
- **savings**: savings, emergency fund
- **investment**: vanguard, fidelity, schwab, robinhood, betterment, 401k
- **internal**: funds transfer, ach transfer, wire transfer, online transfer
- Detection algorithm reuses subscription detection gap analysis (findModeAmount, addDays)
  with wider 15% amount tolerance and 7/14-day cadences for weekly/biweekly patterns
- Cadences ≥60 days (bi-monthly, quarterly, yearly) require only 2+ occurrences;
  shorter cadences (7/14/30) require 3+ occurrences
- Outgoing and incoming transactions analyzed as separate streams
- Outgoing recurring transfers integrated into cash flow forecast

## Security
- **CSP nonces**: Per-request `crypto.randomBytes(16)` nonce for all inline scripts.
  No `'unsafe-inline'` in `scriptSrc`. Nonce passed via `res.locals.nonce` to EJS templates.
- **CORS**: Rejects cross-origin requests when `ALLOWED_ORIGINS` not configured
- **API key**: Header-only (`X-API-Key`), no query string support
- **Token encryption**: pgcrypto `pgp_sym_encrypt` for Teller/Plaid access tokens AND the Per-sistant webhook HMAC secret (`persistent_webhook_secret_enc`) at rest, all keyed by `TOKEN_ENCRYPTION_PASSPHRASE`
- **Session**: Secure cookies, pgSession store, configurable timeout, CSRF custom header check
- **Rate limiting**: General (100/15min), tight (5/1min) for sync/detect, login (10/15min),
  SSO validate (10/15min)
- **Teller API**: mTLS client certificates, retry with exponential backoff (1s/2s/4s), 30s timeout
- **Subscription matching**: Word boundary regex to prevent false positives

## Scheduled Tasks (server.js intervals)
All run automatically after server startup:
- **Keep-alive ping**: every 14 min (timezone-aware active hours, 10s timeout)
- **Sheets auto-sync**: every 1 hour (daily/weekly/monthly cadence from settings)
- **Net worth snapshot**: every 1 hour (one per day, skips if exists)
- **Goal milestones**: every 6 hours (push notifications at 25/50/75/100%)
- **AI insights auto-trigger**: every 6 hours (respects `insights_cadence_days` setting)
- **Budget alerts**: every 3 hours (push notifications at 80% and 100%+ thresholds, aligned with the in-app `/api/budgets/alerts` `warning`/`critical` levels). The in-app `info`/pace heuristic is intentionally not pushed (too noisy as a notification).

## Shared Account Spending Split
All spending queries apply the split percentage for shared/joint accounts via SQL JOIN:
```sql
t.amount * COALESCE(la.spending_split_pct, 100) / 100.0
```
This affects: spending-summary (monthly_trend, byCategory, topMerchants), savings-rate,
spending-yoy, budgets, budget alerts, and cash flow.

## Income Detection
Income is identified by keyword matching on transaction descriptions (NOT amount thresholds):
- Matches: payroll, direct dep, salary, wage, employer name patterns
- Excludes: payment, transfer, pymt, zelle, venmo, paypal, cash app, refund, credit, reversal
- Used in: cash flow projection, savings rate calculation

## Key Design Decisions
- **Test deps live in two places.** `teller/package.json` holds runtime deps;
  the repo-root `package.json` re-declares the subset that tests directly import
  (`pg`, `express`, `multer`, `csv-parse`, `supertest`). CI runs `npm ci` in
  both. Local devs must `npm install` at the root before `npm test`.
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
  `spending_split_pct`-adjusted spending. AI insights routes through it so
  Claude sees the same numbers the dashboard shows. Existing inline copies
  of the same logic in `routes/enrollments.js` (`/api/savings-rate`,
  `/api/cash-flow`) and the spending-summary path are equivalent today —
  any new financial endpoint should use this module instead of re-inlining.
- **Substring-safe keyword exclusions.** All merchant/transaction keyword
  filters use word-boundary matching — `\b` in JavaScript regex, `\y` in
  Postgres regex (`~*` / `!~*`). The reason: short tokens like `atm`,
  `pymt`, `interest`, `epay`, and `vision` previously substring-matched
  legitimate merchants (AT&T, Atmos Energy, internet ISPs, television-
  related merchants) and either hid them from dashboards or persisted false
  tax deductions. Multi-word phrases still work because `\b` / `\y` anchor
  at phrase edges, not inside the phrase. Sites that follow this pattern:
  `scripts/detect-subscriptions.js` `isExcludedMerchant`,
  `teller/data/reference-data.js` `categorizeSubscription` /
  `findCancelUrl`, `routes/insights.js` tax-deduction regex,
  `routes/enrollments.js` top-merchants exclusion. **When adding a new
  keyword filter, do not use `LIKE '%kw%'` or `SIMILAR TO '%kw%'`** — use
  `~*` / `!~*` with `\y(kw1|kw2|...)\y`.

## Git
- Active development branch: `claude/audit-documentation-SX9kS`
- Render's deploy branch (in `render.yaml` / Render dashboard): `claude/subscription-tracker-plaid-WeQTA`
- PEM files and `.env` are in `.gitignore`

## Companion App: Per-sistant
- **Repo**: `/home/user/per-sistant` (or `per-sistant` on GitHub)
- **Purpose**: Personal assistant — task management, email scheduling, notes, AI productivity
- **Integration**: Webhooks (HMAC-signed), SSO, combined weekly summary email, calendar bill projection,
  AI context enrichment (Per-sistant AI queries include financial data from Perfin)
- **Config**: Set `PERSISTENT_URL` env var or configure in Settings page
- See Per-sistant's CLAUDE.md for its full architecture

## Priority Next Features
1. **Mobile app** — React Native or Capacitor wrapper for native experience
2. **Multi-user support** — Shared household finance tracking with role-based access
3. **AI recommendation tracking** — Track which past suggestions were implemented/dismissed,
   create feedback loop for future insights
4. **Structured running summary** — Replace plain-text AI memory with categorized JSON
   (trends, completed goals, pending actions, alerts)
