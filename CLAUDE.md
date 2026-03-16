# CLAUDE.md — Project Context for Claude Code

## Project Overview
Personal finance tracker that detects recurring charges, compares spending to benchmarks,
tracks financial goals, and provides AI-powered insights. Uses **Teller API** (primary) and
Plaid (legacy/investments) for bank account linking via mTLS.

## Architecture (Modular)
The server was modularized from a single 4,931-line file into focused modules:

```
teller/
  server.js              — Bootstrap, middleware, auth, route mounting (190 lines)
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
                           PATCH /api/accounts/:id, POST /api/sync-balances,
                           GET /api/spending-summary
    subscriptions.js     — GET/POST /api/subscriptions, PATCH dismiss/undismiss/cancel/
                           uncancel/category, GET /api/transactions, POST /api/detect,
                           POST /api/import-csv, GET /api/csv-imports, POST /api/cleanup
    goals.js             — GET/POST/PATCH/DELETE /api/goals, POST /api/net-worth/snapshot,
                           GET /api/net-worth/history, GET /api/context-export,
                           GET/POST /api/investment-accounts
    budgets.js           — GET/POST/PATCH/DELETE /api/budgets, POST /api/budgets/suggest,
                           POST /api/budgets/accept
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
  pages/
    dashboard.js         — Dashboard page (Chart.js charts, 3D pyramid, account list, balances)
    subscriptions.js     — Subscription/utility management page
    accounts.js          — Teller Connect enrollment + CSV import page
    goals.js             — Financial goals tracking page
    budgets.js           — Budget tracking page with AI suggestions
    login.js             — PIN pad or password login page (with materialize animation)
    settings.js          — Settings page (theme, AI insights, keep-alive, exports)
    pwa.js               — PWA manifest.json + service worker + icon generation
  public/
    logo.svg             — Iron Man helmet SVG logo (traced from PNG, used as nav icon, PWA icon)
    perfin-shared.css    — Shared styles (variables, nav, cards, animations, responsive)
    perfin-shared.js     — Shared JavaScript (apiFetch, theme, nav helpers)
  views/
    dashboard.ejs        — Dashboard template with 3D financial wellness pyramid
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
- `tests/` — 97 tests (node:test runner, `npm test`)
- `Dockerfile`, `fly.toml`, `render.yaml` — Deployment configs

## Features
- **Bank linking**: Teller Connect UI + mTLS API for transaction sync
- **Investment accounts**: Plaid API integration for brokerage/retirement/crypto holdings
- **CSV import**: Auto-detect Chase, Capital One, Discover, Wells Fargo, Schwab formats
- **Subscription detection**: Automatic recurring charge identification (30/60/90/365-day cadences)
- **Utility separation**: Utilities tracked separately from optional subscriptions
- **Dashboard**: Monthly spending trend (line chart), category breakdown (doughnut), account balances,
  3D financial wellness pyramid (CSS 3D with true frustum geometry, configurable data sources)
- **3D Financial Pyramid**: Interactive spinning pyramid with 4 frustum layers, neon wireframe edges,
  holographic effects. Layers computed by JS (`buildPyramidGeometry()`) with proper taper geometry.
  Configurable data sources: wellness, debt payoff, goal progress, etc. Mobile-optimized (reduced
  filters/shadows on small screens, `prefers-reduced-motion` support).
- **Financial goals**: Track progress toward savings/investment targets with compound interest projections
- **Net worth tracking**: Periodic snapshots with trend history
- **Credit utilization**: Derived credit limit display, utilization percentages
- **ML categorization**: Claude-powered smart transaction categorization (POST /api/categorize)
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
- **Tax deduction persistence**: Flagged deductions stored in `tax_deductions` table, accumulated year-round
- **Context export**: Structured financial data (markdown/JSON) for pasting into Claude chat deep-dives
- **Authentication**: SESSION_PASSWORD (text) or SESSION_PIN (numeric PIN pad), configurable timeout
- **Login animation**: Iron Man helmet materialize effect on successful login (stroke-draw → fill → redirect)
- **Branding**: Iron Man helmet logo (SVG traced from PNG) — nav bar icon (CSS mask), PWA icon, login page
- **Dark/Light theme**: Toggle in Settings, persisted to DB + localStorage
- **PWA**: Installable home screen app (manifest.json + service worker, helmet icon on home screen)
- **Web Push notifications**: VAPID-based push notifications for alerts
- **Keep-alive**: Timezone-aware self-ping to prevent Render free tier sleep
- **Per-model cost tracking**: Usage history with dynamic pricing (Haiku/Sonnet/Opus)

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
- 97 tests passing

## Commands
```bash
cd teller && npm install && node server.js    # Run locally
npm test                                       # Run 97 tests

# Key API endpoints
POST /api/enroll           # store Teller access token after Connect
POST /api/sync             # pull transactions for all enrollments
POST /api/sync-balances    # fetch latest account balances
POST /api/detect           # run subscription detection
GET  /api/transactions     # list transactions (query: months, limit, offset)
GET  /api/subscriptions    # list detected subscriptions
GET  /api/accounts         # list linked accounts with balances
GET  /api/spending-summary # monthly trends, categories, top merchants
GET  /api/goals            # list financial goals with projections
POST /api/goals            # create a financial goal
GET  /api/investment-accounts # list manual investment accounts
POST /api/investment-accounts # add manual investment account
GET  /api/net-worth/history # net worth snapshots over time
GET  /api/context-export   # structured data dump for Claude chat
GET  /api/tax-deductions   # accumulated tax-deductible transactions
GET  /api/settings         # retrieve user settings
PATCH /api/settings        # update user settings
POST /api/insights         # generate new AI insights
GET  /api/insights/status  # AI API config + usage stats
POST /api/insights/reset   # clear long-term AI context
POST /api/insights/rebuild # rebuild context from all history
POST /api/categorize       # ML categorize transactions via Claude
GET  /api/categorize/status # ML categorization status
POST /api/import-csv       # import bank CSV file
GET  /api/export           # download transactions/subscriptions CSV
POST /api/sheets/sync      # sync to Google Sheets
GET  /api/plaid/status     # Plaid investment API status
POST /api/plaid/link-token # create Plaid Link token for investments
POST /api/plaid/exchange   # exchange public token for access token
POST /api/plaid/sync-holdings # sync investment holdings
GET  /api/plaid/holdings   # list investment holdings
GET  /api/notifications/vapid # get VAPID public key for push
POST /api/notifications/subscribe # register push subscription
POST /api/notifications/test # send test push notification
GET  /dashboard            # main dashboard UI
GET  /subscriptions        # subscription management
GET  /goals                # financial goals page
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

## Database
- Auto-migration runs on server startup — no manual SQL needed
- Schema files in `db/` for reference only
- Key tables: `teller_enrollments`, `linked_accounts`, `transactions`, `detected_subscriptions`,
  `user_settings` (single-row), `financial_insights`, `financial_goals`, `net_worth_snapshots`,
  `tax_deductions`, `csv_imports`
- `user_settings`: single-row pattern (CHECK id = 1) for app preferences

## Git
- Default branch: `claude/subscription-tracker-plaid-WeQTA`
- PEM files and `.env` are in `.gitignore`

## Priority Next Features
1. **Investment accounts** — Track brokerage/retirement accounts
2. **ML categorization** — Smart transaction categorization beyond keyword matching
3. **Push notifications** — Alerts for anomalies, upcoming charges, goal milestones
