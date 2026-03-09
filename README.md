# Personal Subscription Tracker

Detect recurring charges across your bank accounts using Plaid, n8n, and Neon Postgres. Get a weekly email digest of all your subscriptions. Sync transactions to Google Sheets with a polished finance dashboard.

## Architecture

```
┌─────────────┐     ┌──────────────────┐     ┌──────────────┐
│ Plaid Link  │────>│  Express Server  │────>│ Neon Postgres│
│  (browser)  │     │  (token exchange)│     │  (pgBouncer) │
└─────────────┘     └──────────────────┘     └──────┬───────┘
                                                     │
                    ┌──────────────────┐              │
                    │   n8n Workflows  │──────────────┘
                    │  • Daily sync    │
                    │  • Weekly digest │
                    │  • Retention     │
                    └──────────────────┘
                                                     │
                    ┌──────────────────┐              │
                    │  Google Sheets   │<─────────────┘
                    │  • Transactions  │
                    │  • Subscriptions │
                    │  • Dashboard     │
                    └──────────────────┘
```

## Files

| Path | Description |
|------|-------------|
| `db/001_schema.sql` | Postgres schema — run this first |
| `db/002_csv_import.sql` | CSV import tracking table |
| `db/003_dashboard_features.sql` | Dashboard feature columns |
| `plaid/server.js` | Express server for Plaid Link + API |
| `plaid/package.json` | Server dependencies |
| `scripts/detect-subscriptions.js` | Recurring charge detection algorithm |
| `scripts/sheets-sync.js` | Google Sheets sync + dashboard builder |
| `scripts/retention-cleanup.sql` | Data retention queries |
| `n8n-workflows/transaction-sync.json` | n8n workflow: daily Plaid sync |
| `n8n-workflows/weekly-digest.json` | n8n workflow: Monday email digest |
| `n8n-workflows/retention-cleanup.json` | n8n workflow: weekly data pruning |
| `tests/` | Test suite (node:test) |
| `Dockerfile` | Container build |
| `docker-compose.yml` | Docker Compose config |

## Setup

### 1. Environment

```bash
cp .env.example .env
# Fill in your Plaid, Neon, email, and Google Sheets credentials
```

### 2. Database

Run the schemas against your Neon database:

```bash
psql "$NEON_DATABASE_URL" -f db/001_schema.sql
psql "$NEON_DATABASE_URL" -f db/002_csv_import.sql
psql "$NEON_DATABASE_URL" -f db/003_dashboard_features.sql
```

### 3. Plaid Link Server

```bash
cd plaid
npm install
npm start
# Open http://localhost:3000 to link your institutions
```

Link each institution one at a time: Capital One, Chase, Schwab, Discover, Wells Fargo.

### 4. n8n Workflows

1. Open your n8n instance
2. Create a **Postgres credential** named "Neon Postgres" using your pgBouncer connection string
3. Create an **SMTP credential** for email sending
4. Import `n8n-workflows/transaction-sync.json` — update credential IDs
5. Import `n8n-workflows/weekly-digest.json` — update credential IDs and the script path in "Run Detection Script"
6. Import `n8n-workflows/retention-cleanup.json` — update credential IDs
7. Set these n8n environment variables: `PLAID_CLIENT_ID`, `PLAID_SECRET_DEV`, `TOKEN_ENCRYPTION_PASSPHRASE`, `ALERT_EMAIL`, `NEON_DATABASE_URL`
8. Activate all three workflows

### 5. Google Sheets Integration

1. Create a Google Cloud project and enable the **Google Sheets API**
2. Create a **Service Account** and download the JSON key file
3. Share your spreadsheet with the service account email (as Editor)
4. Set `GOOGLE_SHEETS_ID` and `GOOGLE_SERVICE_ACCOUNT_KEY` in `.env`

The sync creates three sheets:
- **Transactions** — all transactions with formatting, filters, and alternating row colors
- **Subscriptions** — detected + manual subscriptions with status, cost breakdowns, and conditional formatting
- **Dashboard** — polished summary with monthly trends, category breakdown, top merchants, and upcoming charges

Trigger a sync from the dashboard UI ("Sync to Sheets" button) or via API:

```bash
curl -X POST http://localhost:3000/api/sheets/sync
```

Or run standalone:

```bash
node scripts/sheets-sync.js           # full sync
node scripts/sheets-sync.js --dashboard  # rebuild dashboard only
```

### 6. Docker

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
| `POST` | `/api/create_link_token` | Generate Plaid Link token |
| `POST` | `/api/exchange_token` | Exchange public token for access token |
| `GET` | `/api/items` | List linked institutions |
| `POST` | `/api/import-csv` | Import bank CSV export |
| `GET` | `/api/csv-imports` | List CSV import history |
| `GET` | `/api/subscriptions` | List subscriptions (filter: active/dismissed/cancelled/all) |
| `POST` | `/api/subscriptions` | Add manual subscription |
| `PATCH` | `/api/subscriptions/:id/dismiss` | Dismiss a subscription |
| `PATCH` | `/api/subscriptions/:id/undismiss` | Restore dismissed |
| `PATCH` | `/api/subscriptions/:id/cancel` | Mark as cancelled |
| `PATCH` | `/api/subscriptions/:id/uncancel` | Undo cancellation |
| `POST` | `/api/detect` | Trigger subscription detection |
| `POST` | `/api/sheets/sync` | Sync all data to Google Sheets |
| `POST` | `/api/sheets/dashboard` | Rebuild Sheets dashboard only |
| `POST` | `/api/cleanup` | Manual retention cleanup |
| `GET` | `/` | Plaid Link + CSV import UI |
| `GET` | `/dashboard` | Subscription dashboard |

## How Detection Works

1. Pulls all non-pending debit transactions from the last 12 months
2. Groups by `merchant_name` (falls back to normalized `name` when null)
3. For each merchant, checks if 3+ charges appear at ~30, ~60, or ~90 day intervals
4. Allows ±25% tolerance on timing and ±10% on amount (catches price creep)
5. Upserts results into `detected_subscriptions` with next expected date

## Neon Free Tier Notes

The `transactions` table is the only unbounded-growth table. At Plaid Development limits (~500 txns/Item), storage stays well under 0.5 GB. The retention cleanup runs automatically via n8n every Sunday at 3 AM, pruning transactions older than 18 months and inactive subscriptions older than 6 months.

## Plaid Development Environment Notes

**Important considerations for your 5 institutions:**

- **Item limit**: Dev supports up to 100 Items (you need 5 — no issue)
- **Transaction depth**: Each Item gets up to 500 live transactions. For high-activity accounts this may not cover the full 12-month lookback the detection algorithm prefers. If detection seems to miss subscriptions, this is likely why
- **Capital One**: May require OAuth redirect URI configuration in the Plaid dashboard, even in Development. If Link fails for Cap One, register `http://localhost:3000/oauth-callback` as a redirect URI and uncomment `PLAID_REDIRECT_URI` in `.env`
- **Connection stability**: Capital One and some other institutions can drop connections periodically. The sync workflow catches `LOGIN_REQUIRED` errors and sends you an email alert so you can re-link
- **Rate limits**: Development has generous rate limits for personal use. The daily sync schedule won't come close
- **No production data concerns**: Dev environment uses real credentials but is not subject to Plaid's production compliance requirements. Fine for personal use; not suitable if you ever share this tool
