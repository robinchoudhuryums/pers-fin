# Personal Subscription Tracker

Detect recurring charges across your bank accounts using **Teller API** (primary) or Plaid (legacy), with Neon Postgres. Features a web dashboard with spending charts, dark/light theme, PIN/password-protected sessions, optional AI financial insights, and installable as a mobile home-screen app (PWA).

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
| `teller/server.js` | Main Express server (Teller API + dashboard + settings) |
| `teller/package.json` | Server dependencies |
| `plaid/server.js` | Legacy Plaid server (still functional) |
| `db/001_schema.sql` | Core Postgres schema |
| `db/002_csv_import.sql` | CSV import tracking table |
| `db/003_teller.sql` | Teller-specific migrations |
| `db/005_settings.sql` | User settings + AI insights tables |
| `db/006_insights_memory.sql` | Long-term AI insights memory column |
| `scripts/detect-subscriptions.js` | Recurring charge detection algorithm |
| `scripts/sheets-sync.js` | Google Sheets sync + dashboard builder |
| `scripts/retention-cleanup.sql` | Data retention queries |
| `apps-script/Code.gs` | Google Sheets Apps Script (standalone + server sync) |
| `n8n-workflows/` | n8n automation workflows |
| `tests/` | Test suite (node:test, 60 tests) |
| `Dockerfile` | Container build |
| `render.yaml` | Render deployment blueprint |
| `fly.toml` | Fly.io deployment config |
| `manifest.json` | PWA manifest |

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
| `POST` | `/api/detect` | Run subscription detection |
| `GET` | `/api/transactions` | List transactions (query: months, limit, offset) |
| `GET` | `/api/subscriptions` | List subscriptions (filter: active/dismissed/cancelled/all) |
| `POST` | `/api/subscriptions` | Add manual subscription |
| `PATCH` | `/api/subscriptions/:id/dismiss` | Dismiss a subscription |
| `PATCH` | `/api/subscriptions/:id/undismiss` | Restore dismissed |
| `PATCH` | `/api/subscriptions/:id/cancel` | Mark as cancelled |
| `PATCH` | `/api/subscriptions/:id/uncancel` | Undo cancellation |
| `POST` | `/api/import-csv` | Import bank CSV export |
| `POST` | `/api/sheets/sync` | Sync all data to Google Sheets |
| `GET` | `/dashboard` | Subscription dashboard (with charts) |
| `GET` | `/settings` | Settings page |
| `GET` | `/login` | PIN pad or password login |
| `POST` | `/api/login` | Authenticate session |
| `POST` | `/api/logout` | End session |
| `GET` | `/api/settings` | Retrieve user settings |
| `PATCH` | `/api/settings` | Update user settings |
| `GET` | `/api/insights` | Stored AI financial insights |
| `POST` | `/api/insights` | Generate new AI insights via Claude |
| `GET` | `/api/insights/status` | AI API config + usage stats |
| `GET` | `/api/insights/usage` | Historical usage breakdown |
| `POST` | `/api/insights/reset` | Clear long-term AI context memory |
| `POST` | `/api/insights/rebuild` | Rebuild AI context from all history |
| `GET` | `/manifest.json` | PWA manifest |
| `GET` | `/sw.js` | Service worker |

## Features

### Authentication
Two login modes — set one in your environment variables:
- **`SESSION_PASSWORD`** — text password, shows a standard password input
- **`SESSION_PIN`** — numeric PIN (any length), shows a PIN pad with dot indicators

Sessions expire after a configurable timeout (default 15 minutes, adjustable in Settings from 1–1440 minutes). Omit both to run without authentication (dev mode).

### Dark/Light Theme
Toggle between Night Mode (default) and Day Mode in Settings. Preference is stored in the database and persisted via localStorage.

### Dashboard Charts
Two interactive charts (Chart.js):
- **Monthly Spending Trend** — line chart of total spending over the last 6 months
- **Spending by Category** — doughnut chart of top 8 spending categories

### AI Financial Insights
Set `ANTHROPIC_API_KEY` in `.env` to enable AI-powered financial analysis via Claude.

The AI maintains a **persistent running summary** across analyses — a cumulative memory of your spending baselines, trends, and progress on past recommendations. Insights improve over time as the AI tracks changes month-to-month.

- **Model selector**: Haiku (~$0.005/run), Sonnet (~$0.02/run), or Opus (~$0.10/run) — always uses the latest version
- **Cadence**: Weekly, biweekly, monthly, every 2 months, or quarterly
- **Reset/Rebuild**: Clear or regenerate long-term memory from Settings

### Mobile App (PWA)
Installable as a home screen icon:
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
