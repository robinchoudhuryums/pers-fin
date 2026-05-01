# Personal Finance Tracker (Perfin) + Personal Assistant (Per-sistant)

Single Node process that hosts two related personal tools behind one PIN gate:

- **Perfin** — finance tracker. Detects recurring charges, compares spending to benchmarks, tracks financial goals, runs AI-powered insights via Claude. Uses **Teller API** for bank links via mTLS, plus Plaid for investment holdings.
- **Per-sistant** — personal assistant. Tasks, scheduled emails, notes, calendar, and an AI daily briefing.

A small **shell** authenticates the user with a unified PIN, renders a tile picker, then routes traffic to whichever sub-app is selected. Both sub-apps mount under their own URL prefix (`/perfin` and `/per-sistant`) and continue to keep their own databases, routes, and migrations.

## Architecture

```
┌────────────────────────────────────────────────────────────┐
│  shell/index.js  (Express; PIN auth + landing tile picker) │
│      │                                                      │
│      ├── /perfin       ─►  teller/server.js                │
│      │                          │                          │
│      │                          ├──► Teller API (mTLS)     │
│      │                          ├──► Plaid (investments)   │
│      │                          ├──► Claude API (insights) │
│      │                          ├──► Google Sheets (sync)  │
│      │                          └──► Neon Postgres         │
│      │                                                      │
│      └── /per-sistant  ─►  apps/per-sistant/server.js      │
│                                 │                          │
│                                 ├──► Claude API (briefing) │
│                                 ├──► SMTP (email schedule) │
│                                 └──► Neon Postgres (sep DB)│
└────────────────────────────────────────────────────────────┘
```

Every sub-app remains independently runnable for local debug — `node teller/server.js` and `node apps/per-sistant/server.js` still start standalone listeners. The shell just imports them as modules and hands them traffic via Express's sub-app mount mechanism. Sub-apps detect they're running embedded via an `app.get("embedded")` flag and bypass their own auth gates accordingly.

Under the unified shell the cross-app integration endpoints (Per-sistant's Perfin widget, Perfin's productivity-context enrichment, status checks) query each other's database directly via cross-pool wiring (`req.app.get("perfinPool")` / `("persistentPool")`); HTTP self-fetches are preserved as the standalone fallback path only.

## Files

| Path | Description |
|------|-------------|
| `shell/index.js` | Unified PIN gate, landing tile picker, sub-app mounts |
| `shell/middleware/auth.js` | HMAC-signed cookie session (SHELL_PIN + SHELL_SECRET) |
| `shell/views/login.ejs` | PIN entry screen |
| `shell/views/landing.ejs` | Post-login tile picker |
| `shell/public/manifest.json` | Unified PWA manifest |
| `package.json` | npm workspaces declaration; `npm start` runs the shell |
| `teller/server.js` | Perfin sub-app: middleware, auth, route mounting |
| `teller/startup.js` | Migrations, cron jobs, listener, shutdown (extracted from server.js) |
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
| `teller/routes/insights.js` | AI insights (12 modules), tax deductions |
| `teller/routes/categorize.js` | ML transaction categorization via Claude |
| `teller/routes/categorize-helpers.js` | Categories, descriptions, Teller→ours map |
| `teller/routes/investments.js` | Plaid investment accounts (holdings, sync) |
| `teller/routes/notifications.js` | Web Push notifications (VAPID) |
| `teller/pages/*.js` | HTML page generators (dashboard, subscriptions, etc.) |
| `teller/public/transactions.js` | Transactions page client (Edit modal w/ "remember merchant") |
| `teller/public/settings-rules.js` | Categorization rules panel (collapsible) on Settings |
| `teller/public/perfin-shared.js` | Shared client utilities (esc, apiFetch, withBase, ...) |
| `teller/public/perfin-shared.css` | Shared styles (variables, nav, cards, animations) |
| `teller/public/sw.js` | Perfin Service Worker (network-first, offline fallback) |
| `teller/public/chart.umd.js` | Bundled Chart.js (committed copy; served at /vendor/chart.umd.js) |
| `teller/views/*.ejs` | EJS templates (dashboard, login, partials) |
| `apps/per-sistant/server.js` | Per-sistant sub-app: routes + page handlers + cron jobs |
| `apps/per-sistant/db.js` | Postgres pool — uses PERSISTENT_DATABASE_URL when set |
| `apps/per-sistant/middleware.js` | Session, auth, CSRF, security, rate limiting |
| `apps/per-sistant/views.js` | Shared HTML helpers (pageHead, navBar, themeScript) |
| `apps/per-sistant/routes/*.js` | API routes (todos, emails, notes, AI, calendar, ...) |
| `apps/per-sistant/pages/*.js` | Page handlers (template literal HTML) |
| `apps/per-sistant/routes/pwa.js` | Per-sistant manifest + Service Worker (basePath-aware) |
| `plaid/server.js` | Legacy standalone Plaid server (still functional) |
| `scripts/detect-subscriptions.js` | Recurring charge detection algorithm |
| `scripts/sheets-sync.js` | Google Sheets sync + dashboard builder |
| `apps-script/Code.gs` | Google Sheets Apps Script (standalone + server sync) |
| `tests/` | Test suite (node:test, 241 tests across 11 files) |
| `Dockerfile` | Container build |
| `render.yaml` | Render deployment blueprint (unified shell) |
| `fly.toml` | Fly.io deployment config |

## Setup

### 1. Environment

```bash
cp .env.example .env
# Required: SHELL_PIN, SHELL_SECRET, NEON_DATABASE_URL,
#           PERSISTENT_DATABASE_URL, TELLER_APPLICATION_ID, TELLER_CERT*
# Optional: ANTHROPIC_API_KEY, GOOGLE_SHEETS_ID, SMTP_*, VAPID_*, etc.
```

### 2. Databases

Each sub-app runs its own auto-migrations against its own Neon database on startup:

- `NEON_DATABASE_URL` — Perfin's database
- `PERSISTENT_DATABASE_URL` — Per-sistant's database (separate)

No manual SQL execution needed.

### 3. Install + Run

```bash
npm install        # walks all three workspaces (shell, teller, apps/per-sistant)
npm start          # boots the unified shell (node shell/index.js)
# Open http://localhost:3000 → PIN screen → tile picker → either app
```

Standalone mode for local debugging:

```bash
npm run start:perfin      # legacy: just the Perfin app on its own port
npm run start:persistent  # legacy: just the Per-sistant app on its own port
```

The Teller mTLS certificate (`certificate.pem`, `private_key.pem`) lives in the project root.

### 4. Google Sheets Integration (Optional)

1. Create a Google Cloud project and enable the **Google Sheets API**
2. Create a **Service Account** and download the JSON key file
3. Share your spreadsheet with the service account email (as Editor)
4. Set `GOOGLE_SHEETS_ID` and `GOOGLE_SERVICE_ACCOUNT_KEY` in `.env`

The sync writes six tabs: **Transactions**, **Subscriptions**, **AI Insights**, **Recurring Transfers**, **Tax Deductions**, and **Dashboard**.

### 5. Deployment

**Render (free tier):** see `render.yaml`. The shell takes one Render service; the build is `npm install` and the start command is `npm start`. Set `SHELL_PIN`, `SHELL_SECRET`, `PERSISTENT_DATABASE_URL`, plus the existing Perfin env vars in the dashboard.

**Fly.io (~$2/mo):** see `fly.toml` — set secrets via `fly secrets set`.

**Docker:**
```bash
docker compose up --build
```

## Running Tests

```bash
npm test
```

241 tests across 11 files covering detection, CSV parsing, date handling, API logic, cost calculations, financial-queries semantics, AI-audit pattern extraction, and pinned regression tests for auth/SSO/template/exclusion behavior. No database required — all tests run against pure functions and mock data.

## API Endpoints

When mounted under the unified shell, all of these are accessed via the `/perfin` prefix (e.g. `/perfin/api/sync`). Standalone Perfin keeps the unprefixed paths.

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
| `POST` | `/api/insights` | Generate new AI insights via Claude (12 modules) |
| `GET` | `/api/insights/status` | AI API config + budget stats |
| `POST` | `/api/insights/reset` | Clear long-term AI context memory |
| `POST` | `/api/insights/rebuild` | Rebuild AI context from all history |
| `POST` | `/api/categorize` | ML categorize transactions via Claude |
| `GET` | `/api/categorize/status` | ML categorization status |
| `GET/POST/DELETE` | `/api/categorization-rules` | Persistent merchant→category rules |
| `POST` | `/api/categorization-rules/from-transaction` | Create rule from a transaction (used by Edit modal "Remember") |
| `POST` | `/api/categorization-rules/apply` | Run all active rules against uncategorized rows |
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
| `GET` | `/dashboard` | Main dashboard UI |
| `GET` | `/subscriptions` | Subscription management |
| `GET` | `/transactions` | Transactions page (search + edit + categorize) |
| `GET` | `/goals` | Financial goals page |
| `GET` | `/budgets` | Budget tracking page |
| `GET` | `/settings` | Settings page (incl. collapsible Categorization Rules) |
| `GET` | `/health` | Health check |

Per-sistant exposes its own set of routes (todos, emails, notes, AI briefing, calendar, etc.) under `/per-sistant/...`. See `apps/per-sistant/CLAUDE.md` for the per-app reference.

## Features

### Authentication

The unified shell owns the only login screen and authenticates via PIN:

- **`SHELL_PIN`** — numeric PIN that fronts both apps. Validated against a constant-time compare with a soft 750ms throttle on incorrect attempts.
- **`SHELL_SECRET`** — random ~32+ char string. Signs the shell session cookie. Rotating it invalidates every active session.

Sessions last 7 days by default (configurable in `shell/middleware/auth.js`). Standalone Perfin still supports its legacy `SESSION_PASSWORD` / `SESSION_PIN` modes plus biometric login (WebAuthn) — those are bypassed when running embedded under the shell.

### Cross-app navigation

Each sub-app has a small "switch to the other tool" link in its global nav. From Perfin, the link sits in the topnav next to the notification bell. From Per-sistant, it's in the appbar's top-right (where the Light/Dark toggle used to live, which is now in the sidebar foot). Both stay in-app because the destination is same-origin.

### Dark/Light Theme

Toggle between Night Mode (default) and Day Mode in Settings. Preference is stored in the database and persisted via localStorage.

### Dashboard

Two interactive charts (Chart.js):
- **Monthly Spending Trend** — line chart of total spending over the last 6 months
- **Spending by Category** — doughnut chart of top 8 spending categories
- **3D Financial Wellness Pyramid** — interactive CSS 3D pyramid with 4 frustum layers, neon wireframe edges, holographic effects. Mobile-optimized with `prefers-reduced-motion` support.

### Transactions page (manual categorization with memory)

The Edit modal includes a category dropdown plus a "Remember this merchant" checkbox. Setting a category and ticking the box creates a persistent merchant→category rule (stored in `categorization_rules`); future imports of the same merchant auto-categorize without an AI call. Saved rules are visible/manageable in **Settings → Categorization Rules** (collapsible).

### Investment Accounts

Track brokerage, retirement, and crypto holdings via Plaid API integration. Holdings sync with market values.

### ML Transaction Categorization

Three-tier categorization pipeline:
1. **User rules** (saved from the "Remember" checkbox) — free, instant.
2. **Teller-tag fast path** — deterministic mapping from Teller's own categories (`dining` → `Food & Drink`, etc.) — free, instant.
3. **AI fallback** — Claude classifies anything left over with rich category descriptions and the bank's own hint as context.

### Web Push Notifications

VAPID-based push notifications for alerts (anomalies, upcoming charges, goal milestones). Requires `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_EMAIL`.

### AI Financial Insights (12 Toggleable Modules)

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
12. **Recurring transfers** — analyze Zelle, bill payments, savings, and investment patterns

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

Iron Man helmet logo (SVG traced from PNG) used throughout Perfin:
- **Nav bar** — teal helmet icon via CSS mask
- **PWA icon** — helmet on dark background for home screen
- **Login** — helmet materialize animation (now sits behind the unified shell's PIN screen for standalone Perfin only)

### Mobile App (PWA)

The unified shell installs as a single PWA with its own icon and start URL (`/`). Each sub-app's manifest still works under its prefix if you want to install it separately, but the recommended install is the shell.
- **iPhone**: Open in Safari → Share → "Add to Home Screen"
- **Android**: Chrome → Menu → "Install app"

## How Subscription Detection Works

1. Pulls all non-pending debit transactions from the last 36 months
2. Groups by `merchant_name` (falls back to normalized `name` when null)
3. For each merchant, checks if 3+ charges appear at ~30, ~60, ~90, or ~365 day intervals
4. Allows ±25% tolerance on timing and ±10% on amount (catches price creep)
5. Upserts results into `detected_subscriptions` with next expected date

## Environment Variables

| Variable | Description |
|----------|-------------|
| `SHELL_PIN` | Unified PIN that fronts both apps (set on the Render service) |
| `SHELL_SECRET` | Random ~32+ char string; signs the shell session cookie |
| `NEON_DATABASE_URL` | Perfin's Neon PostgreSQL connection string |
| `PERSISTENT_DATABASE_URL` | Per-sistant's Neon PostgreSQL connection string (separate DB) |
| `TOKEN_ENCRYPTION_PASSPHRASE` | Encrypts stored access tokens |
| `TELLER_APPLICATION_ID` | Teller app ID for Connect widget |
| `TELLER_ENV` | Teller environment (development/production) |
| `TELLER_CERT_PATH` / `TELLER_KEY_PATH` | Local file paths for mTLS PEMs (or use base64 vars under Render) |
| `SESSION_PASSWORD` / `SESSION_PIN` / `SESSION_SECRET` | Legacy standalone-Perfin auth (bypassed when embedded under the shell) |
| `ANTHROPIC_API_KEY` | Enables AI features in both apps |
| `INSIGHTS_MONTHLY_BUDGET_CENTS` | Perfin AI spending cap, default 50 = $0.50/month |
| `GOOGLE_SHEETS_ID` | Google Sheets spreadsheet ID (Perfin sync, optional) |
| `GOOGLE_SERVICE_ACCOUNT_KEY` | Google service account JSON key (Perfin sync, optional) |
| `SMTP_HOST` / `SMTP_PORT` / `SMTP_USER` / `SMTP_PASS` / `SMTP_FROM` | Per-sistant email scheduling |
| `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` / `VAPID_EMAIL` | Push notifications (Perfin) |
