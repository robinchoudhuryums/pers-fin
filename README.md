# Personal Subscription Tracker

Detect recurring charges across your bank accounts using Plaid, n8n, and Neon Postgres. Get a weekly email digest of all your subscriptions.

## Architecture

```
┌─────────────┐     ┌──────────────────┐     ┌──────────────┐
│ Plaid Link  │────▶│  Express Server  │────▶│ Neon Postgres│
│  (browser)  │     │  (token exchange)│     │  (pgBouncer) │
└─────────────┘     └──────────────────┘     └──────┬───────┘
                                                     │
                    ┌──────────────────┐              │
                    │   n8n Workflows  │──────────────┘
                    │  • Daily sync    │
                    │  • Weekly digest │
                    └──────────────────┘
```

## Files

| Path | Description |
|------|-------------|
| `db/001_schema.sql` | Postgres schema — run this first |
| `plaid/server.js` | Express server for Plaid Link + token exchange |
| `plaid/package.json` | Dependencies for the Link server |
| `n8n-workflows/transaction-sync.json` | n8n workflow: daily Plaid sync |
| `n8n-workflows/weekly-digest.json` | n8n workflow: Monday email digest |
| `scripts/detect-subscriptions.js` | Recurring charge detection algorithm |
| `scripts/retention-cleanup.sql` | Data retention queries for Neon free tier |

## Setup

### 1. Environment

```bash
cp .env.example .env
# Fill in your Plaid, Neon, and email credentials
```

### 2. Database

Run the schema against your Neon database:

```bash
psql "$NEON_DATABASE_URL" -f db/001_schema.sql
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
6. Set these n8n environment variables: `PLAID_CLIENT_ID`, `PLAID_SECRET_DEV`, `TOKEN_ENCRYPTION_PASSPHRASE`, `ALERT_EMAIL`, `NEON_DATABASE_URL`
7. Activate both workflows

### 5. Detection Script

The detection script needs `pg` and `dotenv`:

```bash
cd scripts && npm init -y && npm install pg dotenv
```

Or test it standalone:

```bash
NEON_DATABASE_URL="..." node scripts/detect-subscriptions.js
```

## How Detection Works

1. Pulls all non-pending debit transactions from the last 12 months
2. Groups by `merchant_name` (falls back to normalized `name` when null)
3. For each merchant, checks if 3+ charges appear at ~30, ~60, or ~90 day intervals
4. Allows ±25% tolerance on timing and ±10% on amount (catches price creep)
5. Upserts results into `detected_subscriptions` with next expected date

## Neon Free Tier Notes

The `transactions` table is the only unbounded-growth table. At Plaid Development limits (~500 txns/Item), storage stays well under 0.5 GB. The retention cleanup script (`scripts/retention-cleanup.sql`) prunes data older than 18 months — run it weekly via n8n or `pg_cron`.

## Plaid Development Environment Notes

**Important considerations for your 5 institutions:**

- **Item limit**: Dev supports up to 100 Items (you need 5 — no issue)
- **Transaction depth**: Each Item gets up to 500 live transactions. For high-activity accounts this may not cover the full 12-month lookback the detection algorithm prefers. If detection seems to miss subscriptions, this is likely why
- **Capital One**: May require OAuth redirect URI configuration in the Plaid dashboard, even in Development. If Link fails for Cap One, register `http://localhost:3000/oauth-callback` as a redirect URI and uncomment `PLAID_REDIRECT_URI` in `.env`
- **Connection stability**: Capital One and some other institutions can drop connections periodically. The sync workflow catches `LOGIN_REQUIRED` errors and sends you an email alert so you can re-link
- **Rate limits**: Development has generous rate limits for personal use. The daily sync schedule won't come close
- **No production data concerns**: Dev environment uses real credentials but is not subject to Plaid's production compliance requirements. Fine for personal use; not suitable if you ever share this tool
