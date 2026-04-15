# Implementation Plan: Steps 4-7 + Google Sheets Integration

> **STATUS: HISTORICAL — COMPLETED.** This document captures the original
> n8n + Plaid build plan from before the project pivoted to a Teller-first
> architecture with a richer Express dashboard. The steps below have all
> shipped (with substantial rework). Refer to **CLAUDE.md** and **README.md**
> for the current architecture and feature set; treat this file as a
> reference for *why* things look the way they do, not as the active plan.

## Step 4: Email Digest Template
**Status: Already complete.** The `n8n-workflows/weekly-digest.json` Build Digest Email node already has a full HTML template with:
- Monthly cost summary
- New subscription callouts (green box)
- Price change alerts (orange box)
- Full subscription table with amounts, cycle, next charge
- Flag reset SQL for is_new/amount_changed

**No work needed** — just needs SMTP + Neon credential IDs configured in n8n.

---

## Step 5: Automated Retention Cleanup

Add a new n8n workflow (`n8n-workflows/retention-cleanup.json`) that runs weekly (Sunday 3 AM) and executes the two DELETE queries from `scripts/retention-cleanup.sql`:
- Delete transactions older than 18 months
- Delete inactive subscriptions older than 6 months

Also add a `/api/cleanup` endpoint in server.js for manual triggering.

---

## Step 6: Tests

Add tests using Node's built-in `node:test` runner (no extra deps needed):

**`tests/detect-subscriptions.test.js`** — Unit tests for detection algorithm:
- Monthly subscription detection (3+ charges ~30 days apart)
- Quarterly detection (~90 days)
- Amount tolerance (±10% still matches)
- Interval tolerance (±25% still matches)
- Rejects non-recurring charges (random gaps)
- Rejects groups with < 3 charges
- Price change detection
- `findModeAmount` helper

**`tests/csv-parsing.test.js`** — CSV format detection and parsing:
- Chase format detection and parsing
- Capital One format detection and parsing
- Generic format fallback
- Date parsing (MM/DD/YYYY, YYYY-MM-DD)

**`tests/api.test.js`** — API endpoint integration tests:
- POST /api/subscriptions (manual add)
- GET /api/subscriptions (list with filters)
- PATCH dismiss/undismiss/cancel/uncancel
- POST /api/detect

Add `"test": "node --test tests/"` script to root package.json.

---

## Step 7: Deployment (Docker)

**`Dockerfile`** — Multi-stage build:
- Node 20 alpine base
- Copy package files, install deps
- Copy source code
- Expose port 3000
- Run `node plaid/server.js`

**`docker-compose.yml`** — Single service with env_file for `.env`.

**`.dockerignore`** — Exclude node_modules, .env, .git.

---

## Step 8: Google Sheets Integration

### Approach
Use the `googleapis` npm package with a Google Service Account to:
1. Sync Plaid transactions to a "Transactions" sheet
2. Sync detected subscriptions to a "Subscriptions" sheet
3. Create a polished "Dashboard" sheet with formulas and formatting

### New files
- **`scripts/sheets-sync.js`** — Core sync module:
  - Authenticate via service account JSON key file
  - `syncTransactions()` — Query recent transactions from Neon, write to "Transactions" sheet (date, merchant, amount, account, category). Uses batch update to clear and rewrite. Adds headers with formatting.
  - `syncSubscriptions()` — Write active subscriptions to "Subscriptions" sheet with monthly/yearly cost columns.
  - `buildDashboard()` — Create/update a "Dashboard" sheet with:
    - Summary section: total monthly spend, total yearly spend, active subscription count
    - Spending by category (using Sheets formulas like SUMIF)
    - Monthly spending trend (last 6 months)
    - Top merchants by total spend
    - Upcoming subscription charges
    - Conditional formatting (red for high amounts, green for low)
  - All sheets get professional formatting: bold headers, frozen rows, column widths, number formats, alternating row colors

### Server integration
- **New API endpoints** in `server.js`:
  - `POST /api/sheets/sync` — Trigger full sync (transactions + subscriptions + dashboard)
  - `GET /api/sheets/status` — Show last sync time

### New env vars
- `GOOGLE_SHEETS_ID` — The spreadsheet ID from the Google Sheets URL
- `GOOGLE_SERVICE_ACCOUNT_KEY` — Path to the service account JSON key file

### n8n automation
- Add Sheets sync step to the existing `transaction-sync.json` workflow (after transactions are synced from Plaid, also push to Sheets)
- Or create a separate daily workflow

### Dashboard sheet layout
```
Row 1:  PERSONAL FINANCE DASHBOARD (merged, large font)
Row 2:  Last updated: [timestamp]
Row 3:  (blank)
Row 4:  [Monthly Spend]  [Yearly Spend]  [Active Subs]  [Avg Daily Spend]
Row 5:  $X,XXX.XX        $XX,XXX.XX      XX             $XX.XX
Row 6:  (blank)
Row 7:  MONTHLY SPENDING TREND (last 6 months)
Row 8:  Month | Total Spend | # Transactions | Avg Transaction
Row 9+: [data rows]
Row N:  (blank)
Row N+1: TOP SPENDING CATEGORIES
Row N+2: Category | Total | % of Spend
Row N+3+: [data rows]
Row M:  SUBSCRIPTIONS
Row M+1: Service | Amount | Cycle | Monthly Cost | Next Charge | Status
Row M+2+: [data rows]
```
