# Personal Finance Tracker (Perfin)

Personal finance tracker that detects recurring charges, compares spending to benchmarks, tracks financial goals, and provides AI-powered insights. Uses **Teller API** (primary) and Plaid (legacy/investments) for bank account linking via mTLS. Features a web dashboard with spending charts, 3D financial wellness pyramid, dark/light theme, PIN/password-protected sessions with Iron Man helmet branding, and installable as a mobile home-screen app (PWA).

## Architecture

```
┌──────────────┐     ┌──────────────────┐     ┌──────────────┐
│Teller Connect│────>│  Express Server  │────>│ Neon Postgres│
│  (browser)   │     │  (mTLS + API)    │     │  (pgBouncer) │
└──────────────┘     └──────────────────┘     └──────┬───────┘
                              │                       │
                     ┌────────┴────────┐              │
                     │  Claude API     │              │
                     │  (AI Insights)  │              │
                     └─────────────────┘              │
                                                      │
                     ┌──────────────────┐             │
                     │  Google Sheets   │<────────────┘
                     │  • Transactions  │
                     │  • Subscriptions │
                     │  • Dashboard     │
                     └──────────────────┘
```

## Files

| Path | Description |
|------|-------------|
| `teller/server.js` | Bootstrap: middleware, auth, route mounting (190 lines) |
| `teller/data/reference-data.js` | Static lookups: electricity rates, categories, AI costs |
| `teller/data/csv-formats.js` | CSV format detection (Chase, CapOne, Discover, WF, Schwab) |
| `teller/services/database.js` | Postgres pool + auto-migrations |
| `teller/services/teller-api.js` | mTLS HTTP client for Teller API |
| `teller/services/keep-alive.js` | Self-ping for Render free tier |
| `teller/routes/enrollments.js` | Enrollment, sync, items, accounts, balances |
| `teller/routes/subscriptions.js` | Subscription CRUD, transactions, detection, CSV import |
| `teller/routes/goals.js` | Financial goals, net worth, context export, investment accounts |
| `teller/routes/budgets.js` | Budget CRUD, AI suggestions, accept |
| `teller/routes/settings.js` | User settings, sheets sync, CSV export |
| `teller/routes/insights.js` | AI insights (11 modules), tax deductions |
| `teller/routes/categorize.js` | ML transaction categorization via Claude |
| `teller/routes/investments.js` | Plaid investment accounts (holdings, sync) |
| `teller/routes/notifications.js` | Web Push notifications (VAPID) |
| `teller/pages/*.js` | HTML page generators (dashboard, subscriptions, etc.) |
| `teller/public/logo.svg` | Iron Man helmet SVG logo (nav icon, PWA icon) |
| `teller/public/perfin-shared.css` | Shared styles (variables, nav, cards, animations) |
| `teller/views/*.ejs` | EJS templates (dashboard, login, partials) |
| `plaid/server.js` | Legacy Plaid server (still functional) |
| `scripts/detect-subscriptions.js` | Recurring charge detection algorithm |
| `scripts/sheets-sync.js` | Google Sheets sync + dashboard builder |
| `apps-script/Code.gs` | Google Sheets Apps Script (standalone + server sync) |
| `tests/` | Test suite (node:test, 97 tests) |
| `Dockerfile` | Container build |
| `render.yaml` | Render deployment blueprint |
| `fly.toml` | Fly.io deployment config |

## Setup

### 1. Environment

```bash
cp .env.example .env
# Fill in Teller, Neon, and optional credentials (Anthropic, Google Sheets)
```

### 2. Database

The server runs **auto-migration on startup** — all required tables and columns are created automatically. No manual SQL execution needed.

### 3. Teller Server (Primary)

```bash
cd teller && npm install && node server.js
# Open http://localhost:3000
```

Requires Teller mTLS certificate files (`certificate.pem`, `private_key.pem`) in the project root.

### 4. Google Sheets Integration (Optional)

1. Create a Google Cloud project and enable the **Google Sheets API**
2. Create a **Service Account** and download the JSON key file
3. Share your spreadsheet with the service account email (as Editor)
4. Set `GOOGLE_SHEETS_ID` and `GOOGLE_SERVICE_ACCOUNT_KEY` in `.env`

The sync creates three sheets: **Transactions**, **Subscriptions**, and **Dashboard**.

### 5. Deployment

**Render (free):** See `render.yaml` — add PEM files as Secret Files, set env vars in dashboard.

**Fly.io (~$2/mo):** See `fly.toml` — set secrets via `fly secrets set`.

**Docker:**
```bash
docker compose up --build
```

## Running Tests

```bash
npm test
```

Tests cover the detection algorithm, CSV parsing, date handling, API logic, and cost calculations. No database required — all tests run against pure functions and mock data.

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/enroll` | Store Teller access token after Connect |
| `POST` | `/api/sync` | Pull transactions for all enrollments |
| `POST` | `/api/sync-balances` | Fetch latest account balances + auto net worth snapshot |
| `POST` | `/api/detect` | Run subscription detection |
| `GET` | `/api/transactions` | List transactions (query: months, limit, offset) |
| `GET` | `/api/accounts` | List linked accounts with balances |
| `GET` | `/api/spending-summary` | Monthly trends, categories, top merchants |
| `GET` | `/api/subscriptions` | List subscriptions (filter: active/dismissed/cancelled/all) |
| `POST` | `/api/subscriptions` | Add manual subscription |
| `PATCH` | `/api/subscriptions/:id/dismiss` | Dismiss a subscription |
| `PATCH` | `/api/subscriptions/:id/cancel` | Mark as cancelled |
| `PATCH` | `/api/subscriptions/:id/category` | Reclassify as subscription/utility |
| `POST` | `/api/import-csv` | Import bank CSV export |
| `GET/POST/PATCH/DELETE` | `/api/goals` | Financial goals CRUD |
| `POST` | `/api/net-worth/snapshot` | Manual net worth snapshot |
| `GET` | `/api/net-worth/history` | Net worth snapshots over time |
| `GET` | `/api/context-export` | Structured data dump for Claude chat (markdown/JSON) |
| `GET` | `/api/tax-deductions` | Accumulated tax-deductible transactions (by year) |
| `GET/PATCH` | `/api/settings` | Retrieve/update user settings |
| `POST` | `/api/insights` | Generate new AI insights via Claude (11 modules) |
| `GET` | `/api/insights/status` | AI API config + budget stats |
| `POST` | `/api/insights/reset` | Clear long-term AI context memory |
| `POST` | `/api/insights/rebuild` | Rebuild AI context from all history |
| `POST` | `/api/categorize` | ML categorize transactions via Claude |
| `GET` | `/api/categorize/status` | ML categorization status |
| `PATCH` | `/api/transactions/:id/category` | Update transaction category |
| `GET/POST/PATCH/DELETE` | `/api/budgets` | Budget CRUD |
| `POST` | `/api/budgets/suggest` | AI budget suggestions |
| `POST` | `/api/budgets/accept` | Accept AI-suggested budget |
| `GET` | `/api/investment-accounts` | List manual investment accounts |
| `POST` | `/api/investment-accounts` | Add manual investment account |
| `GET` | `/api/plaid/status` | Plaid investment API status |
| `POST` | `/api/plaid/link-token` | Create Plaid Link token for investments |
| `POST` | `/api/plaid/exchange` | Exchange public token for access token |
| `POST` | `/api/plaid/sync-holdings` | Sync investment holdings |
| `GET` | `/api/plaid/holdings` | List investment holdings |
| `GET` | `/api/notifications/vapid` | Get VAPID public key for push |
| `POST` | `/api/notifications/subscribe` | Register push subscription |
| `POST` | `/api/notifications/test` | Send test push notification |
| `POST` | `/api/sheets/sync` | Sync all data to Google Sheets |
| `GET` | `/api/export` | Download transactions/subscriptions CSV |
| `POST` | `/api/login` | Authenticate session |
| `GET` | `/dashboard` | Main dashboard UI |
| `GET` | `/subscriptions` | Subscription management |
| `GET` | `/goals` | Financial goals page |
| `GET` | `/budgets` | Budget tracking page |
| `GET` | `/settings` | Settings page |
| `GET` | `/health` | Health check |

## Features

### Authentication
Two login modes — set one in your environment variables:
- **`SESSION_PASSWORD`** — text password, shows a standard password input
- **`SESSION_PIN`** — numeric PIN (any length), shows a PIN pad with dot indicators

Sessions expire after a configurable timeout (default 15 minutes, adjustable in Settings from 1–1440 minutes). Omit both to run without authentication (dev mode).

### Dark/Light Theme
Toggle between Night Mode (default) and Day Mode in Settings. Preference is stored in the database and persisted via localStorage.

### Dashboard
Two interactive charts (Chart.js):
- **Monthly Spending Trend** — line chart of total spending over the last 6 months
- **Spending by Category** — doughnut chart of top 8 spending categories
- **3D Financial Wellness Pyramid** — interactive CSS 3D pyramid with 4 frustum layers, neon wireframe edges, holographic effects. Mobile-optimized with `prefers-reduced-motion` support.

### Investment Accounts
Track brokerage, retirement, and crypto holdings via Plaid API integration. Holdings sync with market values.

### ML Transaction Categorization
Claude-powered smart categorization beyond keyword matching (POST /api/categorize).

### Web Push Notifications
VAPID-based push notifications for alerts (anomalies, upcoming charges, goal milestones).

### AI Financial Insights (11 Toggleable Modules)
Set `ANTHROPIC_API_KEY` in `.env` to enable AI-powered financial analysis via Claude.

The AI maintains a **persistent running summary** across analyses — a cumulative memory of your spending baselines, trends, and progress on past recommendations. Insights improve over time as the AI tracks changes month-to-month.

**Modules** (each can be toggled on/off in Settings):
1. **Utility rate comparison** — compare bills to state/national averages (requires ZIP)
2. **Spending benchmarks** — compare to BLS Consumer Expenditure Survey averages
3. **Savings & wealth-building** — actionable tips with dollar projections
4. **Subscription audit** — flag overlaps and suggest cheaper alternatives
5. **Anomaly detection** — flag transactions 2x+ above merchant average
6. **Seasonal forecasting** — predict upcoming spend from 24-month patterns
7. **Debt payoff optimizer** — avalanche vs snowball strategies, credit score projections
8. **Bill negotiation tips** — identify negotiable bills with typical savings estimates
9. **Income & savings rate** — track savings rate vs 50/30/20 rule
10. **Tax deduction flags** — flag deductible transactions, persist year-round for tax filing
11. **Goal tracking** — progress assessment with real-world economic context

- **Model selector**: Haiku (~$0.005/run), Sonnet (~$0.02/run), or Opus (~$0.10/run)
- **Cadence**: Weekly, biweekly, monthly, every 2 months, or quarterly
- **Reset/Rebuild**: Clear or regenerate long-term memory from Settings

### Financial Goals
Track progress toward savings targets (house, car, retirement, etc.) with compound interest projections, monthly contribution tracking, and AI-powered progress assessment.

### Net Worth Tracking
Automatic snapshots after balance sync, with historical trend data.

### Context Export
Export all financial data as structured markdown or JSON — paste into Claude chat for deep-dive questions about your finances.

### Tax Deduction Tracking
AI-flagged deductions are accumulated year-round in a persistent table, available for review at tax filing time.

### Branding
Iron Man helmet logo (SVG traced from PNG) used throughout:
- **Nav bar** — teal helmet icon via CSS mask
- **PWA icon** — helmet on dark background for home screen
- **Login** — helmet materialize animation (stroke-draw → fill → redirect) on successful PIN/password entry

### Mobile App (PWA)
Installable as a home screen icon with Iron Man helmet branding:
- **iPhone**: Open in Safari → Share → "Add to Home Screen"
- **Android**: Chrome → Menu → "Install app"

## How Detection Works

1. Pulls all non-pending debit transactions from the last 12 months
2. Groups by `merchant_name` (falls back to normalized `name` when null)
3. For each merchant, checks if 3+ charges appear at ~30, ~60, ~90, or ~365 day intervals
4. Allows ±25% tolerance on timing and ±10% on amount (catches price creep)
5. Upserts results into `detected_subscriptions` with next expected date

## Environment Variables

| Variable | Description |
|----------|-------------|
| `NEON_DATABASE_URL` | Neon PostgreSQL connection string |
| `TOKEN_ENCRYPTION_PASSPHRASE` | Encrypts stored access tokens |
| `TELLER_APPLICATION_ID` | Teller app ID for Connect widget |
| `TELLER_ENV` | Teller environment (development/production) |
| `SESSION_PASSWORD` | Text password for login (optional) |
| `SESSION_PIN` | Numeric PIN for PIN pad login (optional) |
| `SESSION_SECRET` | Session cookie secret (auto-generated if not set) |
| `ANTHROPIC_API_KEY` | Enables AI financial insights via Claude (optional) |
| `INSIGHTS_MONTHLY_BUDGET_CENTS` | Monthly API spending cap, default 50 = $0.50 |
| `GOOGLE_SHEETS_ID` | Google Sheets spreadsheet ID (optional) |
| `GOOGLE_SERVICE_ACCOUNT_KEY` | Google service account JSON key (optional) |
