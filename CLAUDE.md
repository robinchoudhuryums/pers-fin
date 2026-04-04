# CLAUDE.md — Project Context for Claude Code

## Project Overview
Personal finance tracker that detects recurring charges, compares spending to benchmarks,
tracks financial goals, and provides AI-powered insights. Uses **Teller API** (primary) and
Plaid (legacy/investments) for bank account linking via mTLS. Companion app to **Per-sistant**
(personal assistant/task manager) — shared design system, cross-app SSO, webhook integration,
and combined weekly summary email.

## Architecture (Modular)
The server was modularized from a single 4,931-line file into focused modules:

```
teller/
  server.js              — Bootstrap, middleware, auth, route mounting (~200 lines)
  data/
    reference-data.js    — Static lookup tables: electricity rates, ZIP→state, spending
                           benchmarks, cancel URLs, category rules, AI model costs,
                           insight module definitions
    csv-formats.js       — CSV format detection (Chase, CapOne, Discover, WF, Schwab, generic)
  services/
    database.js          — Postgres pool + auto-migrations (all tables/columns)
    teller-api.js        — mTLS HTTP client for Teller API
    keep-alive.js        — Self-ping to prevent Render free tier sleep
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
                           POST /api/import-csv, GET /api/csv-imports, POST /api/cleanup
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
                           PATCH /api/transactions/:id/category (ML categorization via Claude)
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
    pwa.js               — PWA manifest.json + service worker + icon generation
  public/
    logo.svg             — Iron Man helmet SVG logo (traced from PNG, used as nav icon, PWA icon)
    perfin-shared.css    — Shared styles (variables, nav, cards, animations, responsive)
    perfin-shared.js     — Shared JavaScript (apiFetch, theme, nav helpers)
  views/
    dashboard.ejs        — Dashboard template with 3D financial wellness pyramid
    transactions.ejs     — Transaction search/filter template
    calendar.ejs         — Bill calendar template
    login.ejs            — Login template with helmet materialize animation on success
    partials/head.ejs    — HTML head (meta, PWA manifest, apple-touch-icon, theme)
    partials/nav.ejs     — Top navigation bar with helmet logo icon
    partials/foot.ejs    — Footer partial
```

**Other key files:**
- `plaid/server.js` — Legacy Plaid server (still functional)
- `scripts/detect-subscriptions.js` — Recurring pattern detection (30/60/90/365-day cadences)
- `scripts/sheets-sync.js` — Google Sheets sync (server-side push)
- `apps-script/Code.gs` — Google Sheets Apps Script (standalone + server sync)
- `tests/` — 128 tests across 5 files (node:test runner, `npm test`)
- `Dockerfile`, `fly.toml`, `render.yaml` — Deployment configs

## Features

### Core Financial
- **Bank linking**: Teller Connect UI + mTLS API for transaction sync
- **Investment accounts**: Plaid API integration for brokerage/retirement/crypto holdings
- **CSV import**: Auto-detect Chase, Capital One, Discover, Wells Fargo, Schwab formats
- **Transaction deduplication**: SHA256-based duplicate detection across CSV imports and API syncs
- **Subscription detection**: Automatic recurring charge identification (30/60/90/365-day cadences)
- **Utility separation**: Utilities tracked separately from optional subscriptions
- **Shared accounts**: Joint/shared card support with configurable spending split percentage
  (`is_shared`, `spending_split_pct` on linked_accounts, applied in all spending queries via SQL JOIN)
- **Financial goals**: Track progress toward savings/investment targets with compound interest projections
- **Net worth tracking**: Periodic snapshots with trend history
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
- **Budget alerts**: Spending velocity/pacing warnings with severity levels (critical >100%, warning >90%, info >75%)

### AI & Intelligence
- **ML categorization**: Claude-powered smart transaction categorization with bulk mode (POST /api/categorize)
- **AI Insights** (11 toggleable modules):
  - Utility rate comparison (vs state/national averages, requires ZIP)
  - Spending benchmarks (vs BLS Consumer Expenditure Survey)
  - Savings & wealth-building suggestions
  - Subscription audit (overlaps, alternatives)
  - Anomaly detection (transactions 2x+ above merchant average)
  - Seasonal forecasting (24-month pattern analysis)
  - Debt payoff optimizer (avalanche vs snowball, credit score projections)
  - Bill negotiation tips
  - Income & savings rate analysis
  - Tax deduction flags (persistent year-round accumulation for tax filing)
  - Goal tracking (with real-world economic context)
- **Context export**: Structured financial data (markdown/JSON) for pasting into Claude chat deep-dives

### UI & UX
- **Authentication**: SESSION_PASSWORD (text) or SESSION_PIN (numeric PIN pad), configurable timeout
- **Login animation**: Iron Man helmet materialize effect on successful login (gold-amber stroke-draw → fill → redirect)
- **Branding**: Iron Man helmet logo (SVG traced from PNG) — nav bar icon (CSS mask), PWA icon, login page
- **Dark/Light theme**: Toggle in Settings, persisted to DB + localStorage
- **PWA**: Installable home screen app (manifest.json + service worker, helmet icon centered on home screen)
- **Web Push notifications**: VAPID-based push notifications for alerts
- **Keep-alive**: Timezone-aware self-ping to prevent Render free tier sleep
- **Per-model cost tracking**: Usage history with dynamic pricing (Haiku/Sonnet/Opus)
- **Google Sheets sync**: Auto-sync transactions and dashboard data to Google Sheets

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
3. Add Secret Files: `/etc/secrets/certificate.pem`, `/etc/secrets/private_key.pem`
4. Set env vars (see Environment Variables below)
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
- Render deploys from default branch (`claude/subscription-tracker-plaid-WeQTA`)
- Env vars configured in Render dashboard
- PEM files added as Secret Files in Render
- Teller Application ID: `app_pplg2et45b7bl1scna000`
- 128 tests passing across 5 test files

## Commands
```bash
cd teller && npm install && node server.js    # Run locally
npm test                                       # Run 128 tests

# Key API endpoints
POST /api/enroll           # store Teller access token after Connect
POST /api/sync             # pull transactions for all enrollments
POST /api/sync-balances    # fetch latest account balances
POST /api/detect           # run subscription detection
GET  /api/transactions     # list transactions (query: months, limit, offset)
GET  /api/transactions/search # search/filter (query: q, category, account_id, min/max_amount, start/end_date)
GET  /api/subscriptions    # list detected subscriptions
GET  /api/accounts         # list linked accounts with balances (includes is_shared, spending_split_pct)
PATCH /api/accounts/:id    # update account details
PATCH /api/accounts/:id/shared # mark account as shared/joint (body: is_shared, spending_split_pct)
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
POST /api/categorize       # ML categorize transactions via Claude (bulk support)
GET  /api/categorize/status # ML categorization status
PATCH /api/transactions/:id/category # manually set transaction category
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
- `SESSION_PASSWORD` — text password for login (omit to disable auth)
- `SESSION_PIN` — numeric PIN for PIN pad login (alternative to password)
- `SESSION_SECRET` — session cookie secret (auto-generated if not set)
- `ANTHROPIC_API_KEY` — enables AI financial insights via Claude
- `INSIGHTS_MONTHLY_BUDGET_CENTS` — monthly API spending cap (default: 50 = $0.50)
- `API_KEY` — optional API key for /api/* endpoints (dev mode if not set)
- `ALLOWED_ORIGINS` — comma-separated CORS origins
- `PERSISTENT_URL` — URL of companion Per-sistant instance (also stored in user_settings)
- `PERSISTENT_WEBHOOK_SECRET` — HMAC secret for signing webhook payloads to Per-sistant
- `SSO_SECRET` — shared HMAC secret for cross-app SSO token exchange

## Database
- Auto-migration runs on server startup — no manual SQL needed
- Schema files in `db/` for reference only
- Key tables: `teller_enrollments`, `linked_accounts`, `transactions`, `detected_subscriptions`,
  `user_settings` (single-row), `financial_insights`, `financial_goals`, `net_worth_snapshots`,
  `tax_deductions`, `csv_imports`
- `user_settings`: single-row pattern (CHECK id = 1) for app preferences
- `linked_accounts` columns include: `is_shared BOOLEAN`, `spending_split_pct INT DEFAULT 100`,
  `is_manual BOOLEAN` — constraint `chk_account_source` allows `plaid_item_id IS NOT NULL OR
  teller_enrollment_id IS NOT NULL OR is_manual = true`
- `user_settings` includes Per-sistant config: `persistent_url TEXT`, `persistent_webhook_secret TEXT`,
  `persistent_webhook_enabled BOOLEAN`

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

## Git
- Default branch: `claude/subscription-tracker-plaid-WeQTA`
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
2. **Recurring transfer tracking** — Auto-detect and categorize recurring transfers between accounts
3. **Multi-user support** — Shared household finance tracking with role-based access
