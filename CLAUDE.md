# CLAUDE.md — Project Context for Claude Code

## Project Overview
Personal finance subscription tracker that detects recurring charges from bank transactions.
Uses **Teller API** (primary) and Plaid (legacy) for bank account linking via mTLS.

## Architecture
- **Teller server**: `teller/server.js` (Express, port 3000, bound to 0.0.0.0)
- **Plaid server**: `plaid/server.js` (legacy, still functional)
- **Database**: Neon PostgreSQL (schema in `db/`)
- **Detection**: `scripts/detect-subscriptions.js` (recurring pattern detection, 30/60/90/365-day cadences)
- **Google Sheets sync**: `scripts/sheets-sync.js` (server-side push to Sheets via API)
- **Apps Script**: `apps-script/Code.gs` (standalone or server-synced Google Sheets version)
- **Automation**: n8n workflows in `n8n-workflows/`
- **Tests**: `tests/` (node:test runner, run with `npm test`, 60 tests)
- **Deployment**: `Dockerfile`, `fly.toml` (Fly.io), `render.yaml` (Render)

## Current State (as of March 2026)
- Teller integration is fully implemented and configured
- PEM files (`certificate.pem`, `private_key.pem`) are in project root, gitignored
- `.env` is configured with all credentials (Teller, Plaid, Neon DB, Google Sheets)
- Teller Application ID: `app_pplg2et45b7bl1scna000`
- Server runs and responds correctly on localhost
- Apps Script supports both CSV import and server sync modes
- Yearly subscription detection (365-day cadence, 2 occurrences minimum)
- **Password protection**: Set `SESSION_PASSWORD` env var to enable login screen (configurable timeout)
- **Settings page**: `/settings` — theme, session timeout, dashboard range, AI insights toggle, data export
- **Dark/Light theme**: Toggle in Settings, persisted to DB + localStorage
- **Dashboard charts**: Monthly spending trend (line) and category breakdown (doughnut) via Chart.js
- **AI Insights**: Optional financial analysis via Claude API (`ANTHROPIC_API_KEY`, ~$0.02/month) with persistent long-term memory (running summary), reset/rebuild controls, and usage history
- **PWA**: Installable as home screen app on iPhone/Android (manifest.json + service worker)
- **Blocker**: Codespace port forwarding doesn't work — deploy to Render/Fly.io or run locally

## Deployment Options

### Option A: Render (Free, recommended for $0)
1. Connect GitHub repo in Render dashboard
2. Create Web Service from `render.yaml` blueprint
3. Add Secret Files in dashboard:
   - `/etc/secrets/certificate.pem` → paste PEM content
   - `/etc/secrets/private_key.pem` → paste PEM content
4. Set env vars: `NEON_DATABASE_URL`, `TOKEN_ENCRYPTION_PASSPHRASE`, `TELLER_APPLICATION_ID`
5. Access at `https://pers-fin-tracker.onrender.com`
- Note: Free tier sleeps after 15 min idle (~60s cold start)

### Option B: Fly.io (~$2/mo)
```bash
fly launch --name pers-fin-tracker
fly secrets set NEON_DATABASE_URL="postgres://..."
fly secrets set TOKEN_ENCRYPTION_PASSPHRASE="..."
fly secrets set TELLER_APPLICATION_ID="app_pplg2et45b7bl1scna000"
fly secrets set TELLER_ENV="development"
fly secrets set TELLER_CERT=$(base64 < certificate.pem)
fly secrets set TELLER_KEY=$(base64 < private_key.pem)
fly deploy
```
- PEM files mounted via `[[files]]` in `fly.toml`
- Auto-stop when idle, ~2-5s cold start

### Option C: Local (for development/testing)
```bash
cd teller && npm install && node server.js
# Open http://localhost:3000
```

## Next Steps
1. **Deploy to Render or Fly.io** to get a public HTTPS URL for Teller Connect
2. Link a bank account via Teller Connect in the browser
3. Test transaction sync (`POST /api/sync`)
4. Run subscription detection (`POST /api/detect`)
5. Verify dashboard at `/dashboard`
6. Set `CONFIG.SERVER_URL` in Apps Script to the deployed URL for Sheets sync
7. Test Google Sheets sync if service account key is configured

## Key Files
- `.env` — all secrets (never commit)
- `.env.example` — template with setup instructions
- `certificate.pem` / `private_key.pem` — Teller mTLS certs (gitignored)
- `teller/server.js` — main server
- `scripts/detect-subscriptions.js` — subscription detection (30/60/90/365-day cadences)
- `scripts/sheets-sync.js` — Google Sheets sync (Plaid + Teller + CSV)
- `apps-script/Code.gs` — Google Sheets Apps Script (standalone + server sync)
- `db/001_schema.sql` — core schema
- `db/003_teller.sql` — Teller-specific migrations
- `db/005_settings.sql` — user settings + financial insights tables
- `db/006_insights_memory.sql` — long-term AI insights memory column
- `Dockerfile` / `docker-entrypoint.sh` — container deployment
- `fly.toml` — Fly.io config
- `render.yaml` — Render blueprint

## Commands
```bash
# Install & run locally
cd teller && npm install && node server.js

# Run tests (60 tests)
npm test

# Key API endpoints
POST /api/enroll          # store Teller access token after Connect
POST /api/sync            # pull transactions for all enrollments
POST /api/detect          # run subscription detection
GET  /api/transactions    # list transactions (query: months, limit, offset)
GET  /api/subscriptions   # list detected subscriptions
GET  /dashboard           # subscription dashboard UI (with charts)
GET  /settings            # settings page
GET  /login               # password login (if SESSION_PASSWORD set)
POST /api/login           # authenticate session
POST /api/logout          # end session
GET  /api/settings        # retrieve user settings
PATCH /api/settings       # update user settings
GET  /api/insights        # stored AI insights
POST /api/insights        # generate new AI insights
GET  /api/insights/status # AI API config check + usage stats
GET  /api/insights/usage  # historical usage breakdown
POST /api/insights/reset  # clear long-term AI context
POST /api/insights/rebuild # rebuild context from all history
POST /api/sheets/sync     # sync to Google Sheets
GET  /manifest.json       # PWA manifest
GET  /sw.js               # service worker
```

## Environment Variables (new)
- `SESSION_PASSWORD` — password for login screen (omit to disable auth)
- `SESSION_SECRET` — session cookie secret (auto-generated if not set)
- `ANTHROPIC_API_KEY` — enables AI financial insights via Claude

## Git
- Branch: `claude/subscription-tracker-plaid-WeQTA`
- Always commit and push to this branch
- PEM files and `.env` are in `.gitignore`
