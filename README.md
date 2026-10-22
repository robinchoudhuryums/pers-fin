# Personal Finance Tracker (Perfin) + Personal Assistant (Per-sistant)

Single Node process that hosts two related personal tools behind one PIN gate:

- **Perfin** — finance tracker. Detects recurring charges, compares spending to benchmarks, tracks financial goals, runs AI-powered insights via Claude. Uses **Teller API** for bank links via mTLS, plus Plaid for investment holdings + transaction syncing for banks Teller doesn't cover.
- **Per-sistant** — personal assistant. Tasks, scheduled emails, notes, calendar, an AI daily briefing, and a personal **Knowledge base** — RAG over an Obsidian vault with cited Q&A, structured facts, and a never-sent-to-AI secret tier.

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
│                                 ├──► Claude API (briefing, │
│                                 │      Knowledge RAG + cite)│
│                                 ├──► Voyage + GitHub vault  │
│                                 │      (Knowledge / RAG)    │
│                                 ├──► SMTP (email schedule) │
│                                 └──► Neon Postgres + pgvec  │
└────────────────────────────────────────────────────────────┘
```

Every sub-app remains independently runnable for local debug — `node teller/server.js` and `node apps/per-sistant/server.js` still start standalone listeners. The shell just imports them as modules and hands them traffic via Express's sub-app mount mechanism. Sub-apps detect they're running embedded via an `app.get("embedded")` flag and bypass their own auth gates accordingly.

Under the unified shell the cross-app integration endpoints (Per-sistant's Perfin widget, Perfin's productivity-context enrichment, status checks) query each other's database directly via cross-pool wiring (`req.app.get("perfinPool")` / `("persistentPool")`); HTTP self-fetches are preserved as the standalone fallback path only.

## Files

| Path | Description |
|------|-------------|
| `shell/index.js` | Unified PIN gate, landing tile picker, sub-app mounts |
| `shell/middleware/auth.js` | HMAC-signed cookie session (SHELL_PIN + SHELL_SECRET), global PIN-failure lockout, return_to carry-through |
| `shell/middleware/error-handler.js` | Last-resort error handler — status + short message, never a stack trace |
| `shell/views/login.ejs` | PIN entry screen |
| `shell/views/landing.ejs` | Post-login tile picker |
| `shell/public/manifest.json` | Unified PWA manifest (mask-crop PNG icons) |
| `shell/public/landing.css` | Shell-only styles (login + landing tiles) |
| `shell/public/transition.css` | Cosmic mask-reveal transition (Per-sistant entry) |
| `shell/public/transition.js` | Auto-init module for `[data-atrans]` triggers |
| `shell/public/perfin-materialize.css` | Iron Man helmet materialize transition (Perfin entry) |
| `shell/public/perfin-materialize.js` | Auto-init module for `[data-perfin-materialize]` triggers |
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
| `teller/routes/housing.js` | Rent & Utilities ledger (obligations, payments, OCR, landlord export, partner split) |
| `teller/routes/notifications.js` | Web Push notifications (VAPID) |
| `teller/pages/*.js` | HTML page generators (dashboard, subscriptions, etc.) |
| `teller/public/transactions.js` | Transactions page client (Edit modal w/ "remember merchant") |
| `teller/public/settings-rules.js` | Categorization rules panel (collapsible) on Settings |
| `teller/public/perfin-shared.js` | Shared client utilities (esc, apiFetch, withBase, ...) |
| `teller/public/perfin-shared.css` | Shared styles (variables, nav, cards, animations) |
| `teller/public/sw.js` | Perfin Service Worker (network-first, offline fallback served with a `<base>` for the mount) |
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
| `tests/` | Test suite (node:test, 1944 tests across 97 files incl. apps/per-sistant/tests; `tests/contract/` = real-Postgres route contract suite, `npm run test:contract`) |
| `Dockerfile` | Container build — installs all workspaces and boots `node shell/index.js` |
| `render.yaml` | Render deployment blueprint (unified shell) |
| `fly.toml` | Fly.io deployment config |
| `mobile/` | Capacitor iOS wrapper (remote-URL mode; coexists with the PWA — see mobile/README.md) |

## Setup

### 1. Environment

```bash
cp .env.example .env
# Required: SHELL_PIN, SHELL_SECRET, NEON_DATABASE_URL,
#           PERSISTENT_DATABASE_URL, TELLER_APPLICATION_ID, TELLER_CERT*
# Optional: ANTHROPIC_API_KEY, GOOGLE_SHEETS_ID, SMTP_*, VAPID_*,
#           APP_TIMEZONE (IANA zone for Health & Habits day-math; default UTC), etc.
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

The Teller mTLS certificate (`certificate.pem`, `private_key.pem`) is **not** committed — place them in the project root before booting, or set `TELLER_CERT_PATH` / `TELLER_KEY_PATH` env vars (or base64-encoded `TELLER_CERT` / `TELLER_KEY` env vars on Render). Earlier git history still contains the original PEMs from before they were un-tracked; treat them as compromised and rotate the cert in the Teller dashboard if relying on this repo's history.

### 4. Google Sheets Integration (Optional)

1. Create a Google Cloud project and enable the **Google Sheets API**
2. Create a **Service Account** and download the JSON key file
3. Share your spreadsheet with the service account email (as Editor)
4. Set `GOOGLE_SHEETS_ID` and `GOOGLE_SERVICE_ACCOUNT_KEY` in `.env`

The sync writes **16+ tabs**:

- **Core 7**: Transactions (splits inline + categorization Source column + Reimbursed columns), Subscriptions (with Days Until countdown), Utilities, AI Insights (with structured running-summary sub-tables + per-insight feedback), Recurring Transfers, Tax Deductions, Dashboard (with category sparklines + heatmap).
- **Strategic adds**: Investments (Plaid holdings + returns), Net Worth History (monthly), Income (monthly totals + top sources), AI Trust (audit findings + ratings), Categorization Rules, Manual Bills (all categories), Bill Payments Log (with variance flagging), Important Dates (90-day upcoming events), Watchlist (user-curated merchant/category/keyword monitor).
- **Per-month archives**: as each month completes, an immutable `YYYY-MM Transactions` tab is created. Never overwritten on subsequent syncs.

Subscriptions / Tax Deductions / Recurring Transfers / Per-month archives / Watchlist are protected with a warning-only confirmation prompt so accidental edits surface a confirmation (sync still overwrites on next run). Dashboard CSV upload uses a partial-sync endpoint (`/api/sheets/sync-transactions`) so new transactions appear in Sheets in ~5s instead of the full ~30-60s `syncAll`.

### 5. Deployment

**Render (free tier):** see `render.yaml`. The shell takes one Render service; the build is `npm install` and the start command is `npm start`. Set `SHELL_PIN`, `SHELL_SECRET`, `PERSISTENT_DATABASE_URL`, plus the existing Perfin env vars in the dashboard.

**Fly.io (~$2/mo):** see `fly.toml` — set secrets via `fly secrets set`.

**Single VPS (always on, own Postgres — draft, not yet live):** `deploy/vps/` —
Docker Compose with the app, Postgres + pgvector and Caddy (automatic HTTPS), a
deploy workflow (`.github/workflows/deploy-vps.yml`, inert until the
`VPS_DEPLOY_ENABLED` repository variable is `true`), a nightly encrypted
on-server backup and the Render + Neon → VPS migration runbook
(`deploy/vps/RUNBOOK.md`). The server sets `PUBLIC_URL`, `ALWAYS_ON=true` (no
keep-alive ping) and `SERVER_BACKUPS=true` (Operator Checks reads the time
`backup.sh` records instead of expecting the GitHub backup workflow).

**Monitoring:** server errors from both apps are recorded in the app's own
database and listed in Settings → Sync Health → Recent errors (Resolve hides one
until it happens again; a new one notifies, at most 5 a day). For uptime, point
a free monitor at `/health` (Render + Neon) or `/health/deep` (both databases —
on the VPS), and optionally set `HEARTBEAT_URL` to a healthchecks.io check.
See `deploy/vps/RUNBOOK.md` → Monitoring.

**Docker:**
```bash
docker compose up --build
```

### 6. Backups

`.github/workflows/db-backup.yml` runs nightly (and on manual dispatch): it
`pg_dump`s both Neon databases, encrypts each dump with AES-256 (gpg, which
also detects a damaged or altered file), checks that each encrypted file
decrypts into a readable archive, and uploads them as GitHub Actions artifacts
with 90-day retention. It runs entirely from GitHub's runners, so backups happen
even while the Render free tier sleeps. If a secret is missing, the first step
says which one.

Set three repository secrets: `NEON_DATABASE_URL`, `PERSISTENT_DATABASE_URL`
(optional), and `BACKUP_ENCRYPTION_PASSPHRASE` (keep a copy in a password
manager — the artifacts are unreadable without it). Restore starts with
`gpg --decrypt`; the full runbook is in the workflow file's header comment. Do
one restore drill into a throwaway Neon branch so the procedure isn't first
attempted mid-emergency. GitHub disables a public repo's scheduled workflows
after 60 days without activity — if Actions shows the workflow as disabled,
re-enable it there.

## Running Tests

```bash
npm test                  # full suite: Perfin + Per-sistant
npm run test:perfin       # Perfin tests only
npm run test:persistent   # Per-sistant tests only
```

1944 tests covering detection, CSV parsing, date handling, API logic, cost calculations, financial-queries semantics (incl. the net-worth single-source-of-truth + the $0-brokerage dedupe direction), AI-audit pattern extraction, pinned regression tests for auth/SSO/template/exclusion behavior and the latest cycle fixes (net-worth dedupe, budget-rollover month-keying, webhook replay/expiry, XSS/header sanitization, CSV dedup-ID parity, Plaid balance-sync status filter, Plaid holdings-items UNION + liabilities unlink-and-link hint, categorize bulk-sweep/loop + auto-sweep + accuracy sampler, in-process digest delivery, background reconcile, login→dashboard redirect, $0-brokerage dedupe, page-size-independent Teller pagination, Schwab CSV sign preservation, Wells Fargo CSV detection tightening, Plaid sync observability, and the June 2026 broad-scan fixes: backup workflow, fail-fast token passphrase, compromised-cert detection, missed-job watchdog, budget-alert dedup, CSV occurrence-indexed dedup, quarterly/bi-monthly subscription detection, stricter/recency-aware detection + calendar-month cadence stepping + cadence-based calendar income (Sept 2026 Batch 4), Rent & Utilities trailing generation + rename carry-over + Settle Up refund/awaiting-bill handling (Batch 5), one shared budget-status helper + prior-month snapshot refresh + APP_TIMEZONE date anchors + local calendar-date rendering + month-end-safe date math + Per-sistant recurrence anchor/missed instances + knowledge-cache churn fixes (Batch 6), AI audit precision + model-ID pricing + capped budget suggestions + summary-preservation + the tax report computed from transactions (Batch 7), re-runnable Sheets formatting + persisted Sheets sync outcome + settled-month archives + spreadsheet formula-injection guards + ISO-dated CSV/context exports (Batch 10), Knowledge sync without embeddings + failure visibility + better hybrid ranking + net-worth-consistent finance grounding + capture sensitivity (Batch 11), sold-holding pruning + unknown-cost-basis handling + mid-window account entry flows in TWR/XIRR + funding-option phantom dedupe + CSV CR/DR / trailing-minus amounts and the Chase checking format (Batch 12), pyramid modes on the real API shapes + server net worth, write-failure toasts, CSV auto-detect, accessible dialogs / labels / calendar buttons and defined theme tokens (Batch 13), Per-sistant Job Radar bucket/re-score/backfill fixes + a service worker that never fakes success + validated, fully-wired automations + task location on create/recurrence + RFC 5545 iCal + dependency-cycle and template-apply safety + recurring undo + keyboard-accessible controls and dialogs (Batch 14), source guards for style nonces / mount-base navigation / undefined CSS variables plus the Teller and Per-sistant API tests rewritten to run the real code instead of inline replicas (Batch 15), and the fixes for what those tests exposed — the Per-sistant calendar error with recurring tasks, Quick Add's priority/date detection, the palette picker under the shell, the undo toast / offline banner colours and settings validation, the Claude 5.5 model upgrade (no forced tool_choice, explicit effort, text read by block type), audit cross-period "average" narrowing, and timezone-aware habit streaks), the Oct 2026 Batch 1 exposure fixes (a login input that crashed the server, workflow logs that printed balances, a standalone API-key bypass, the pinned Mermaid CDN path, Per-sistant CSRF and integration-URL validation, a deduped lockout alert), the Oct 2026 Batch 2 broken-page fixes (the Rent page with a utility configured, account history, the nav sync badge + bell count, the toast-burst freeze, Web Push delivery to stored subscriptions, insight feedback, the offline page under the shell), the Oct 2026 Batch 3 backstop fixes (scheduled jobs record whether they succeeded, sync failures that used to be recorded as clean, the AI-insights auto-run's cap check and retry back-off, a compromised-certificate warning in Sync Health, rent reminders while away, independent daily-sync steps, verified backups), the Oct 2026 Batch 4 bank-sync durability fixes (a wrong-passphrase token no longer fails every sync, a duplicate Plaid link is refused instead of doubling transactions, the CSV workflow keeps files that failed to import, safer CSV manual-balance roll-forward, removed investment accounts stay removed, investments-only unlink, serialized Plaid sync/reconcile, honest TWR/XIRR coverage, quiet liabilities skips and a kept 0% APR, NaN balance rejection, correct snapshot dates), the Oct 2026 Batch 5 money-accuracy fixes (PayPal-prefixed purchases, Citi Bike and similar no longer hidden as transfers, Transfer/Investment categories excluded from spending, Zelle rent no longer a subscription, Plaid legacy categories re-categorized, cash-flow income on the calendar's income streams, joint-account income at your share, a 0% Settle Up split, unknown card limits in the context export, removed rent placeholders that stay removed, next month's rent reminder, budget snapshots only while a budget exists, budget push thresholds, consistent Spending Summary windows, a literal Sheets Watchlist match), the Oct 2026 Batch 6 delete-integrity fixes (deleted transactions no longer return on the next sync or reconcile, the CSV-overlap tool pairs rows one-to-one on similar merchants, rent due late in the month lands on its real day in the calendar feed, folded calendar-feed lines, Undismiss restoring an item, 400s instead of 500s for impossible dates and months, literal transaction search), the Oct 2026 Batch 7 categorization fixes (rules applied most-specific first, a re-pointed merchant's old rule switched off, 1–2 character rules refused, a category you set mid-run never overwritten by the AI, unanswered rows not re-sent to the AI every run, semimonthly pay that lands at month-end recognized), the Oct 2026 Batch 8 AI-trust fixes (the audit no longer flags a claim about another month or one beside an earlier "annual" figure, reads "$1.2k" correctly and catches a made-up merchant listed with a real one; Ask answers on its last round, charges reliably and uses your local date; the goal prompt shows funding-linked progress; budget suggestions stay on real categories and Accept handles a repeat; ISO dates in prompts; completed goals in the weekly digest text and a working dashboard link in the insight email), the Oct 2026 Batch 9 Sheets and cross-app fixes (Sheets average spend over completed months, utility and important-date rows on the app's own bill and transfer dates, re-runnable formatting on three more tabs, one Sheets sync at a time, negative numbers kept as numbers, the Apps Script formula guard, a digest with no recipient reported as a draft instead of sent, Per-sistant's Perfin widget using monthly equivalents and counting a charge due today, settings that reject bad values, failed partial Sheets syncs recorded, old read notifications pruned, credit-score changes per score type), the Oct 2026 Batch 10 Perfin UI fixes (dashboard charts that match the tables and label the right month, no sideways scroll on mid-width screens or the phone calendar, Settings widget toggles that all work, "1,200" read as $1,200, goal and credit-score dates on the right day, failed saves that say so, one-click Add forms, labelled Settings and Subscriptions controls, rollover and one-month budgets in the UI without resets, back to the same page after a session timeout, a safer Split editor, manual loans shown as owed, an offline cache that no longer grows or stores the login page), the Batch 11 Per-sistant fixes (task and calendar dates on the right day west of UTC, rent overdue from the oldest unpaid month, Send Now that can't double-send, a validated digest recipient plus a reminder when an email fails, failed saves that say so, a Job Radar nudge that counts only new roles and a refresh that can't run twice, note reminders and "overdue" on your local day, webhooks and Slack that actually fire for every offered event, Ask totals over all your data, a weekly review that lists what's coming, email edits that can't reopen a sent email, attachments kept in the database so a deploy no longer loses them, a real 30-day trash purge, and no rate-limit errors under the shell), the Batch 12 Knowledge ingest fixes (cut-off or empty answers no longer cached, a too-large vault file list or a force-pushed history no longer skipping files silently, files over 1 MB read in full, timeouts on GitHub and Voyage calls, rate limits and length caps on Knowledge questions, upcoming-fact reminders only for current facts on your local day, stricter privacy frontmatter, and a fact capture with no fields saved as a note), the Batch 13 platform hardening (Plaid/Teller sign-in popups no longer cut off, migrations that wait for each other and give up on a stuck lock instead of freezing the app, a "Sign Out Everywhere" that revokes every session, a writable uploads folder in the Docker image) and tests that run the real migration runner, start-up checks, single-send email scheduler, SSO replay guard, token decryption, reindex and login gate, plus guards that stop new UTC-date anchors and re-derived net-worth / budget / income / AI-spend figures, the Batch 14 refund-aware spending (a refund nets against its category in the month it posts, taking the merchant's earlier category, never below $0 — budgets, the dashboard, savings rate, AI insights, Ask and Sheets alike), the Batch 15 subscription watchdog (an alert when a cancelled subscription charges again or a price goes up) and merchant rename rules ("apply to all past and future", folding a split subscription back together), the Batch 16 imports, exports and privacy work (a charges / deposits choice for a CSV in no known bank format, an Insight Emails switch, month archive tabs in Sheets rebuilt when their month's rows change, and a normal / private / secret tier for Per-sistant notes that keeps private notes away from the AI), the Batch 17 operator checks (Settings → Sync Health shows disabled or failing GitHub backstop workflows, a missing backup, missing workflow secrets and a public repository through a read-only GitHub token, plus the compromised Teller certificate, a short PIN and a Knowledge index that needs one full reindex), the Batch 18 background syncs (the daily and weekly backstop workflows start a sync in the background and poll for its outcome instead of timing out, and every workflow reports a timeout instead of exiting silently — the polling script is run in bash against a fake server), the Batch 19 Plaid Link update mode (Re-authenticate and Add accounts on an existing Plaid connection keep the same connection, its transactions and your edits — no more unlink + link — plus a duplicate-link guard on the investments-only link and a re-auth notification that opens the Accounts page), the Batch 20 Per-sistant busy-button helper (one shared way to disable a button while its action runs, with a guard against hand-rolled copies), the roadmap T1.4 error log and uptime checks (server errors grouped in Settings → Sync Health → Recent errors with Resolve and a capped notification, a database-backed /health/deep and an optional healthchecks.io heartbeat), the roadmap T1.5 Perfin quick wins (dashboard charts redrawn after a sync, a month picker on the Budgets page, editable and switchable merchant rename rules), the roadmap T1.5 Per-sistant quick wins (email attachments actually sent, a failed email's error and Retry, AI routes answering "not configured" without a key), the Seams & Invariants audit #3 fixes (biometric login credential ids, manual accounts no longer listed as a bank connection, one reconcile at a time, a whole first month in the AI seasonal history, digests sent to a valid address when SMTP_FROM is a display name, a charge due today in Knowledge's finance answers, no cached login page in Per-sistant's offline cache), the roadmap T2.1 bank webhook receivers so far (Plaid's signed JWT and Teller's HMAC verified, each event recorded once, never its body — nothing acts on an event yet), a scan that stops new silently swallowed errors in server code, BEHAVIORAL sync-idempotency tests (Teller + Plaid synced twice over the same fixtures → 0 added, no dupes, stable watermark) and AI cap-charge tests (/api/ask + categorize charge their usage rows and 429 at the cap; ask charges even on a mid-loop failure), and integration tests for the feedback, whats-new, performance, and trust-overview endpoints. `npm test` needs no database — it runs against pure functions and mock pools. A separate real-Postgres route contract suite (`tests/contract/`, `CONTRACT_DATABASE_URL=… npm run test:contract`, run in CI's migrations job) mounts every router in the real server.js order against a scratch database: financial queries, housing + settle-up, calendar + exports, transaction writes + CSV import, the Teller and Plaid sync engines, bank-sync durability (wrong-key tokens, duplicate links, CSV roll-forward), money classification (spending filter, income split, housing removals, detectors), delete integrity and feeds (deleted transactions, CSV overlap, ICS clamp and folding), categorization rules (rule order, superseded and short rules, the AI write and skip back-off), AI trust (goal prompt, audit periods and entities, spend month, Accept de-dup), Sheets and cross-app (utility and important-date placement, credit-score change, notification retention, digest drafts), budget writes (rollover and one-time budgets kept across a re-save), Per-sistant Batch 11 (database attachments, trash purge, reminders, email edits, Job Radar nudges, streak undo), Knowledge ingest edges (current-fact reminders, fail-closed frontmatter, large files, truncated and force-pushed vault histories), platform checks (the Perfin popup header, SSO replay, token decryption, migration locking, session revocation), Per-sistant schema / analytics / single-send email / reindex, Sheets budget status matching the app, refunds netting into budgets and the dashboard, subscription watchdog alerts and merchant rename rules, the CSV sign choice, the insight-email switch, archive fingerprints, the notes privacy tier, the operator checks (Knowledge reindex version, GitHub problems reaching Sync Health with one notification), background syncs recording their outcome, Plaid update mode (a re-authenticated connection keeping its transactions and edits, new accounts registered, a duplicate investments link refused), editing and switching off a merchant rename rule, Per-sistant emails sent with their attachments and retried after a failure, signed bank webhooks recorded once (replays and forgeries add nothing), categorize and insight generation (Anthropic SDK stubbed), the Knowledge pipeline (vault sync through a fake GitHub API) and Per-sistant routes. CI's e2e job (`npm run test:e2e`) adds Playwright browser tests: the login flow plus every Perfin and Per-sistant page loaded in a real browser over seeded data (accounts, a refund and a split, budgets, goals, housing, notes in each privacy tier, habits, tasks, a job listing), failing on page errors, console errors or server errors — and a click sweep that presses every non-destructive control on every page.

## API Endpoints

When mounted under the unified shell, all of these are accessed via the `/perfin` prefix (e.g. `/perfin/api/sync`). Standalone Perfin keeps the unprefixed paths.

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/enroll` | Store Teller access token after Connect |
| `POST` | `/api/sync` | Pull transactions from Teller AND Plaid, then run one unusual-charge check over both (also the daily-sync.yml backstop) |
| `DELETE` | `/api/items/:id` | Unlink a Plaid bank (releases the Item at Plaid, removes its accounts/transactions, deactivates its investments) |
| `POST` | `/api/plaid/link-token-update` | Plaid Link update-mode token for an existing connection (Re-authenticate / Add accounts) |
| `POST` | `/api/plaid/update-complete` | After update-mode Link: register new accounts, clear the re-auth flag, sync that connection |
| `POST` | `/api/sync-balances` | Fetch latest account balances + auto net worth snapshot |
| `POST` | `/api/sync/reconcile` | Backfill/recover dropped transactions (body: days, provider, `background: true` for detached run) |
| `GET` | `/api/sync/reconcile/status` | Poll the background reconcile job |
| `POST` | `/api/detect` | Run subscription detection |
| `GET` | `/api/transactions` | List transactions (query: months, limit, offset) |
| `GET` | `/api/accounts` | List linked accounts with balances |
| `GET` | `/api/spending-summary` | Monthly trends, categories, top merchants |
| `GET` | `/api/income-summary` | Income trend + top sources + by_account (query: months) |
| `GET` | `/api/accounts/:id/balance-history` | Daily balance series (query: source=linked\|investment, months) |
| `GET` | `/api/investments` | Unified investment list across Teller-linked + Plaid + manual sources |
| `GET` | `/api/subscriptions` | List subscriptions (filter: active/dismissed/cancelled/all) |
| `POST` | `/api/subscriptions` | Add manual subscription |
| `PATCH` | `/api/subscriptions/:id/dismiss` | Dismiss a subscription |
| `PATCH` | `/api/subscriptions/:id/cancel` | Mark as cancelled |
| `PATCH` | `/api/subscriptions/:id/category` | Reclassify as subscription/utility |
| `POST` | `/api/import-csv` | Import bank CSV export |
| `GET/POST/PATCH/DELETE` | `/api/goals` | Financial goals CRUD |
| `GET` | `/api/fire-projection` | FIRE number/progress/time-to-FIRE + spending runway (assumptions from settings) |
| `POST` | `/api/ask` | Ask Perfin — NL finance Q&A via Claude tool use (body: `{ question }`, ≤500 chars) |
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
| `GET` | `/api/categorize/review-queue` | Candidates the next AI categorize would send to Claude |
| `POST` | `/api/categorize/review` | Apply user decision (sets user_category, optionally creates rule) |
| `GET` | `/api/categorize/progress` | Live progress of the running categorize pass (rules/map/AI counts + phase) |
| `GET` | `/api/categorize/accuracy` | Running ML accuracy over verified AI rows |
| `GET` | `/api/categorize/accuracy-sample` | Random unverified AI-categorized rows to review |
| `POST` | `/api/categorize/accuracy-review` | Record a correct/wrong verdict on a sampled AI row |
| `GET/POST/DELETE` | `/api/categorization-rules` | Persistent merchant→category rules |
| `POST` | `/api/categorization-rules/from-transaction` | Create rule from a transaction (used by Edit modal "Remember") |
| `POST` | `/api/categorization-rules/apply` | Run all active rules against uncategorized rows |
| `PATCH` | `/api/transactions/:id/category` | Update transaction category |
| `GET/POST/PATCH/DELETE` | `/api/budgets` | Budget CRUD |
| `POST` | `/api/budgets/suggest` | AI budget suggestions |
| `POST` | `/api/budgets/accept` | Accept AI-suggested budget |
| `GET` | `/api/budgets/one-time` | One-month budgets with their month (Budgets page other-month links) |
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
| `GET` | `/` | Redirects to `/dashboard` (the post-login entry point) |
| `GET` | `/dashboard` | Main dashboard UI |
| `GET` | `/accounts` | Teller Connect enrollment + CSV import page |
| `GET` | `/accounts/:id/history` | Per-account balance chart (query: source=linked\|investment, months) |
| `GET` | `/api/shell/webauthn/available` | Probe whether biometric credentials exist (shell-layer, pre-auth) |
| `POST` | `/api/shell/webauthn/authenticate-options` | Start biometric auth flow (shell-layer, pre-auth) |
| `POST` | `/api/shell/webauthn/authenticate` | Verify biometric + set shell session cookie |
| `GET` | `/subscriptions` | Subscription management |
| `GET` | `/transactions` | Transactions page (search + edit + categorize) |
| `GET` | `/goals` | Financial goals page |
| `GET` | `/budgets` | Budget tracking page |
| `GET` | `/settings` | Settings page (incl. collapsible Categorization Rules) |
| `GET` | `/health` | Health check (Perfin standalone; the unified shell also serves a separate `/health` at root, public, no DB hit) |

Shell-level public endpoints (no auth, mounted before the PIN gate):

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/health` | Process-up probe — returns `{"ok": true}` without touching the DB |
| `GET` | `/manifest.json` | Unified-shell PWA manifest (mask-crop icons) |
| `GET` | `/apple-touch-icon.png` | iOS home-screen icon — mask-crop PNG |
| `GET` | `/apple-touch-icon-precomposed.png` | Older-iOS probe path, same bytes |
| `GET` | `/android-chrome-192x192.png` | PWA icon, 192px |
| `GET` | `/android-chrome-512x512.png` | PWA icon, 512px |

`PATCH /api/settings` accepts an additional `shell_idle_timeout_minutes` (5–10080) that drives the shell's sliding-window auth.

Per-sistant exposes its own set of routes (todos, emails, notes, AI briefing, calendar, health/habits, etc.) under `/per-sistant/...`. See `apps/per-sistant/CLAUDE.md` for the per-app reference.

## Features

### Authentication

The unified shell owns the only login screen and authenticates via PIN:

- **`SHELL_PIN`** — numeric PIN that fronts both apps (use at least 6 digits — boot warns otherwise). Validated against a constant-time digest compare (a malformed PIN can't crash the server) with a soft 750ms throttle on incorrect attempts, per-IP rate limits, and a global ceiling: 30 failed PINs within an hour lock PIN login for 30 minutes (biometric and API-key access keep working) and send a "PIN login locked" notification (at most one every 6 hours).
- **`SHELL_SECRET`** — random ~32+ char string. Signs the shell session cookie. Rotating it invalidates every active session. Required: the shell refuses to start without it.

Sessions use a sliding idle window — the cookie's expiration is refreshed on every authenticated request. The default idle window is **60 minutes** and is configurable from Settings → Security → "App Idle Timeout" (5–10080 minutes, stored in `user_settings.shell_idle_timeout_minutes`). An active user never times out mid-use; an idle one is re-prompted after the window. Non-browser clients (cron, GitHub Actions) can authenticate via `x-api-key: $API_KEY` instead of the PIN cookie. Standalone Perfin still supports its legacy `SESSION_PASSWORD` / `SESSION_PIN` auth modes — those are bypassed when running embedded under the shell. Biometric login (WebAuthn) is supported in both deployments: standalone Perfin hosts `/api/webauthn/*` directly, and the unified shell hosts its own `/api/shell/webauthn/*` endpoints (mounted before the PIN gate) that read from the same `webauthn_credentials` table via Perfin's pool.

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

### Loan Accounts (Auto Loans etc.)

Loans linked via Plaid (e.g. a credit-union auto loan) — or added manually — are first-class debt: they render under a **Loans** group on the dashboard with a negative balance, count as liabilities in net worth, and feed the AI debt-payoff optimizer alongside credit cards. Plaid never reports auto-loan APR/terms (its Liabilities product covers only credit/student/mortgage), so the loan card has **manual APR + monthly payment fields**; with both set it shows a payoff projection — months remaining, payoff date, and interest left to pay. Loan payments are auto-detected as recurring transfers for the bill calendar.

### Rent & Utilities Ledger

A single-payee accounts-payable tracker (`/housing`) for the common "we pay a person for rent + utilities by bank transfer" case. It models **obligations** (rent = a fixed monthly charge; each utility starts as an "awaiting bill" placeholder until the mailed amount arrives) and **payments** (one transfer settles a batch of obligations, with the memo auto-derived from the covered months, e.g. "Jan–Mar 2026 Rent, Jan 2026 Electricity"). The running **balance owed** is the sum of unpaid obligations. A scheduled job generates each month's rows idempotently from the config and fires two deduped reminders — payment-due and missing-utility-amount.

Extras:
- **Bill OCR** — snap a photo or PDF of a utility bill and Claude vision *suggests* `{amount, period, label}` for you to confirm before it's saved. The image is processed in memory and **never stored** (no disk write, no DB row); only the confirmed number is persisted. Shares the monthly AI budget cap.
- **Landlord-ready export** — `GET /api/housing/export?year=&format=csv|pdf|json` produces a year's payment record with memos, covered months, and total.
- **Calendar + dashboard** — unpaid known-amount obligations appear on the bill calendar and the public `/calendar.ics` feed; a dashboard widget shows the current balance owed, auto-hiding when the ledger isn't configured.
- **Per-utility trend** — an inline-SVG sparkline per utility with a year-over-year % delta.
- **Partner even-up split** — for the arrangement where your partner sends the full payee payment and you pay the car separately: you reimburse the partner `(rent + utilities − car) / 2` so each of you bears half of the total (the direction flips when the car exceeds rent+utilities). The car amount auto-pulls from a selected loan account's monthly payment (or a fixed fallback). This folds into the dashboard's combined **Settle Up** widget alongside the shared-card settlement, showing one net "send/collect $X with [partner]" figure per month with an expandable breakdown.

### ML Transaction Categorization

Three-tier categorization pipeline:
1. **User rules** (saved from the "Remember" checkbox) — free, instant, applied in bulk over the **entire** uncategorized backlog.
2. **Teller-tag fast path** — deterministic mapping from Teller's own categories (`dining` → `Food & Drink`, etc.) — free, instant, also bulk over the whole backlog.
3. **AI fallback** — Claude classifies anything left over with rich category descriptions and the bank's own hint as context. The AI step **loops** 50-row pages up to 300 rows per click, re-checking the shared monthly budget cap before each page (stops early when the cap is hit), so one click makes a real dent instead of nibbling 50 rows.

Categorization also runs **automatically on the bank auto-sync cadence** (not just the 30-day AI-insights run), and `GET /api/categorize/progress` powers a live "categorizing… N done" indicator on the Settings button. An **accuracy sampler** (Settings → AI Accuracy) surfaces random AI-assigned categories to confirm or correct, tracking a running accuracy %; a "wrong" verdict fixes the category (optionally creating a rule) while still counting the miss.

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

- **Model selector**: Haiku, Sonnet, or Opus — Claude Haiku 5.5 ($0.10 / $0.50 per million tokens), Sonnet 5.5 ($2 / $10) or Opus 5.5 ($4 / $20); each run's actual cost is tracked against the monthly AI cap
- **Cadence**: Weekly, biweekly, monthly, every 2 months, or quarterly
- **Reset/Rebuild**: Clear or regenerate long-term memory from Settings

### Ask Perfin (NL Finance Q&A)

A dashboard widget (`POST /api/ask`) that answers natural-language questions about your own data ("how much did I spend on dining last month?", "when do I hit FIRE?") via Claude tool use. Seven read-only tools — monthly overview, category spending, transaction search, net worth, subscriptions, budget status, FIRE projection — are bound to the same shared query helpers the dashboard uses, so cited numbers match the UI by construction; the model never writes SQL. The tool loop is bounded (6 rounds), spend shares the monthly AI budget cap (429 once exhausted, charged via an `entry_type='ask'` usage row), and each answer shows the tools used + cost. Typical questions cost well under a cent on Haiku.

### Financial Goals

Track progress toward savings targets (house, car, retirement, etc.) with compound interest projections, monthly contribution tracking, and AI-powered progress assessment.

### FIRE / Runway Projections

The Goals page carries a FIRE card backed by `GET /api/fire-projection`: FIRE number (annual spending × 100/withdrawal-rate), progress %, projected FIRE date, a 40-year net-worth projection chart, and a spending runway (how long net worth covers spending with no income, growth included). Inputs are the deduped `getNetWorth()` figure plus averages over **completed** months of income/spending — the current partial month never drags the averages. Three assumptions are editable inline and persisted to settings: expected annual return (default 5%), withdrawal rate (default 4%), and an optional monthly-spending override for "my retirement spending won't match today's". Pure math lives in `teller/services/projections.js`.

### Net Worth Tracking

Automatic snapshots after balance sync, with historical trend data.

### Context Export

Export all financial data as structured markdown or JSON — paste into Claude chat for deep-dive questions about your finances.

### Tax Deduction Tracking

AI-flagged deductions are accumulated year-round in a persistent table, available for review at tax filing time.

### Branding

**Perfin** — Iron Man helmet logo (SVG traced from PNG):
- **Nav bar** — gold helmet icon via CSS mask
- **Standalone PWA icon** — helmet on dark background for home screen
- **Login animation (standalone)** — helmet materialize sequence (gold-amber stroke-draw → fill → particle burst → HUD scan)
- **Tile-click + cross-app entry (unified shell)** — same materialize animation plays when entering Perfin from the landing tile or Per-sistant's nav cross-app icon. Lives at `shell/public/perfin-materialize.{css,js}`, wired via `data-perfin-materialize` attribute on the link.

**Per-sistant** — favicon.io-generated artwork (`android-chrome-mask-crop.png`):
- **Sidebar brand glyph** + **iOS home-screen icon** + **PWA icon**
- **Login animation (standalone)** — cosmic mask reveal: clip-path top-down scan-line reveal of the mask-crop image, layered over a purple/gold nebula + slow rotating ring + twinkling starfield + 60 rising particles in a mixed warm/cosmic palette
- **Tile-click + cross-app entry (unified shell)** — the same cosmic reveal plays when entering Per-sistant from the landing tile or Perfin's nav cross-app icon. Lives at `shell/public/transition.{css,js}`, wired via `data-atrans="cosmic"`.

**Unified-shell PWA icon** — `apps/per-sistant/android-chrome-mask-crop.png`, served by the shell at root paths (`/apple-touch-icon.png` etc.) before the auth gate so iOS Safari's "Add to Home Screen" auto-discovers it from any page on the origin. Adding from a Perfin page still gets the helmet bookmark — Perfin's own pages declare their own apple-touch-icon.

### Mobile App (PWA)

The unified shell installs as a single PWA with its own icon and start URL (`/`). Each sub-app's manifest still works under its prefix if you want to install it separately, but the recommended install is the shell.
- **iPhone**: Open in Safari → Share → "Add to Home Screen"
- **Android**: Chrome → Menu → "Install app"

A native iOS wrapper (Capacitor, remote-URL mode) is scaffolded in `mobile/` and deliberately coexists with the PWA as a separate icon/session for A/B comparison — build runbook in `mobile/README.md` (free signing, no APNs; notifications keep flowing through the PWA).

### Personal Knowledge Base / RAG (Per-sistant)

A private "master journal/database" on Per-sistant's Knowledge page. It indexes a
local-first **Obsidian vault** (a private GitHub repo, the source of truth) plus
your notes into **Neon + pgvector**, and answers questions across all of it with
**source citations**:

- **Semantic Q&A** — vector retrieval (Voyage embeddings) with automatic keyword
  fallback; answers cite the documents they used (Anthropic Citations) and carry a
  grounded/trust signal.
- **Structured facts + temporal validity** — `type: fact` vault frontmatter →
  precise `(entity, attribute, value)` records with `valid_from`/`valid_to`, so
  "what's my *current* deductible?" is an exact lookup, not fuzzy recall. Per-fact
  verify loop.
- **Mermaid diagrams** generated from your data.
- **Capture-to-vault** — paste an email / dictate → structured note or fact
  committed back to the vault (separate write-scoped token).
- **"Secret" tier** — items flagged `sensitivity: secret` are stored and locally
  searchable but **never embedded and never sent to any AI**. Sensitivity
  parsing fails closed: an unrecognized or ambiguous value is treated as private.
- **Proactive surfacing** — upcoming renewals/expirations via the notification check.
- **Cross-app finance grounding** — finance questions read Perfin's accounts +
  subscriptions (read-only) so "can I afford my renewal?" is answerable.

Optional setup: `VOYAGE_API_KEY` (semantic search), `VAULT_GITHUB_TOKEN`
(read-only vault sync), `VAULT_GITHUB_WRITE_TOKEN` (capture), and the `vector`
extension on Neon. Without Voyage/pgvector, Knowledge degrades to keyword search
(over notes, plus vault documents and facts when the vault token is set — they're
embedded later if Voyage is added).
Full detail: `apps/per-sistant/CLAUDE.md` (Knowledge block) and the Knowledge / RAG
subsystem in `CLAUDE.md`'s Cycle Workflow Config.

### Health & Habits Tracker (Per-sistant)

Daily habits and measurements on Per-sistant's Health page — check-off or
quantity-vs-target habits on daily / weekdays / specific-days / N-per-week
schedules, with streaks **computed at read time** from the log history (a
backfilled day retroactively repairs a streak; an unlogged *today* never breaks
one). One-tap today list, clickable 7-day backfill grid, 90-day consistency
heatmap, and a measurements time series (weight, sleep, mood, custom) with
inline trend charts. Habit streaks at risk surface in the notification check
and the AI daily briefing. No setup required — three tables ride Per-sistant's
existing migration chain.

### Job Radar (Per-sistant)

A personal job-listing radar on Per-sistant's `/jobs` page. Pulls listings from
sanctioned APIs — the **Adzuna** aggregator plus direct **ATS boards**
(Greenhouse / Lever / Ashby / Workable) over a curated, UI-editable company
allowlist — dedups them on a content hash, then scores each for **trust**
(source weight + ghost-job freshness decay + cross-source corroboration +
apply-domain check + scam-pattern heuristics) and **fit** (a Voyage embedding
cosine vs your single job profile, then a Claude "Job Fit" pass → 0–100 score +
rationale), with a Claude legitimacy pass on borderline rows. High-fit /
high-trust roles surface on the page (with a smaller "verify first" bucket so a
strict filter never silently eats a real lead), in the notification check, and
as one AI daily-briefing line. Saving / applying / dismissing a role archives it
(never deletes) and tunes the source's trust. Weekly refresh via in-process
cron + a GitHub Actions backstop. The Claude passes are charged against a
monthly **AI cost cap** (Per-sistant's first — also reusable by other AI
features). Off by default — enable it on the `/jobs` page. Optional
`ADZUNA_APP_ID` / `ADZUNA_APP_KEY` (free tier) widen ingest beyond the ATS
boards; reuses `VOYAGE_API_KEY` + `ANTHROPIC_API_KEY`.

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
| `SHELL_SECRET` | Random ~32+ char string; signs the shell session cookie (required — boot fails without it) |
| `NEON_DATABASE_URL` | Perfin's Neon PostgreSQL connection string |
| `PERSISTENT_DATABASE_URL` | Per-sistant's Neon PostgreSQL connection string (separate DB) |
| `TOKEN_ENCRYPTION_PASSPHRASE` | Encrypts stored access tokens |
| `TELLER_APPLICATION_ID` | Teller app ID for Connect widget |
| `TELLER_ENV` | Teller environment (development/production) |
| `TELLER_CERT_PATH` / `TELLER_KEY_PATH` | Local file paths for mTLS PEMs (or use base64 vars under Render) |
| `SESSION_PASSWORD` / `SESSION_PIN` / `SESSION_SECRET` | Legacy standalone-Perfin auth (bypassed when embedded under the shell) |
| `API_KEY` | `x-api-key` for non-browser clients (cron, GitHub Actions daily-sync.yml + keep-alive.yml). Honored by the shell's `requireAuth` as an alternate credential parallel to the PIN cookie |
| `ANTHROPIC_API_KEY` | Enables AI features in both apps |
| `INSIGHTS_MONTHLY_BUDGET_CENTS` | Perfin AI spending cap fallback (default 50 = $0.50/month) — overridable at runtime in Settings → AI Insights → Monthly Budget Cap |
| `GOOGLE_SHEETS_ID` | Google Sheets spreadsheet ID (Perfin sync, optional) |
| `GOOGLE_SERVICE_ACCOUNT_KEY` | Google service account JSON key (Perfin sync, optional) |
| `SMTP_HOST` / `SMTP_PORT` / `SMTP_USER` / `SMTP_PASS` / `SMTP_FROM` | Per-sistant email scheduling |
| `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` / `VAPID_EMAIL` | Push notifications (Perfin) |
| `ADZUNA_APP_ID` / `ADZUNA_APP_KEY` | Job Radar aggregator ingest (Per-sistant, optional — ATS boards work without them) |
| `PERSISTENT_AI_BUDGET_CENTS` | Per-sistant monthly AI cap fallback (default 100 = $1.00/month) — overridable via `user_settings.ai_monthly_budget_cents` |
