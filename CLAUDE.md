# CLAUDE.md — Project Context for Claude Code

## Project Overview
Personal finance subscription tracker that detects recurring charges from bank transactions.
Uses **Teller API** (primary) and Plaid (legacy) for bank account linking via mTLS.

## Architecture
- **Teller server**: `teller/server.js` (Express, port 3000, bound to 0.0.0.0)
- **Plaid server**: `plaid/server.js` (legacy, still functional)
- **Database**: Neon PostgreSQL (schema in `db/`)
- **Detection**: `scripts/detect-subscriptions.js` (recurring pattern detection)
- **Google Sheets sync**: `scripts/sheets-sync.js`
- **Automation**: n8n workflows in `n8n-workflows/`
- **Tests**: `tests/` (node:test runner, run with `npm test`)
- **Alternative**: `apps-script/Code.gs` (self-contained Google Sheets version)

## Current State (as of March 2026)
- Teller integration is fully implemented and configured
- PEM files (`certificate.pem`, `private_key.pem`) are in project root, gitignored
- `.env` is configured with all credentials (Teller, Plaid, Neon DB, Google Sheets)
- Teller Application ID: `app_pplg2et45b7bl1scna000`
- Server runs and responds correctly on localhost
- **Blocker**: Codespace port forwarding doesn't work in this environment — need to run locally or find alternative hosting

## Next Steps
1. **Run the server locally** (on user's Mac) to test Teller Connect bank linking in browser
   - Clone repo, copy PEM files from `~/Downloads/`, create `.env`, `npm install`, `node teller/server.js`
   - Open `http://localhost:3000` to link a bank account via Teller Connect
2. After linking a bank account, test transaction sync (`POST /api/sync`)
3. Run subscription detection (`POST /api/detect`)
4. Verify dashboard at `/dashboard`
5. Test Google Sheets sync if service account key is configured

## Key Files
- `.env` — all secrets (never commit)
- `.env.example` — template with setup instructions
- `certificate.pem` / `private_key.pem` — Teller mTLS certs (gitignored)
- `teller/server.js` — main server (1349 lines)
- `db/001_schema.sql` — core schema
- `db/003_teller.sql` — Teller-specific migrations

## Commands
```bash
# Install & run
cd teller && npm install && node server.js

# Run tests
npm test

# Key API endpoints
POST /api/enroll          # store Teller access token after Connect
POST /api/sync            # pull transactions for all enrollments
POST /api/detect          # run subscription detection
GET  /api/subscriptions   # list detected subscriptions
GET  /dashboard           # subscription dashboard UI
POST /api/sheets/sync     # sync to Google Sheets
```

## Git
- Branch: `claude/subscription-tracker-plaid-WeQTA`
- Always commit and push to this branch
- PEM files and `.env` are in `.gitignore`
