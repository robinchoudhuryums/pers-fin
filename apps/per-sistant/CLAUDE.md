# CLAUDE.md — Project Context for Claude Code

## Project Overview
Personal assistant tool for task management, email scheduling, and note-taking.
Companion app to **Perfin** (personal finance tracker) — same design system, cross-linked navigation.

## Architecture
- **Entry point**: `server.js` (Express, port 3001, bound to 0.0.0.0) — slim ~180 lines
- **Config**: `config.js` (constants, env parsing, validation arrays)
- **Database**: `db.js` (pool + migrations), Neon PostgreSQL (schema in `db/`)
- **Middleware**: `middleware.js` (auth, CSRF, rate limiting, session)
- **AI**: `ai.js` (Anthropic Claude client, model helpers, caching) — 9 features with per-feature model selection
- **Helpers**: `helpers.js` (recurrence, webhooks, Slack, automations)
- **Views**: `views.js` + `views/css.js` + `views/js.js` (shared HTML/CSS/JS helpers)
- **Routes**: `routes/` (21 route modules — auth, todos, emails, notes, contacts, settings, etc.)
- **Pages**: `pages/` (9 page modules — dashboard, todos, emails, notes, contacts, calendar, review, analytics, settings)
- **Email**: nodemailer (SMTP) with scheduled sending via node-cron. The
  scheduler atomically CLAIMS due emails before sending — `UPDATE emails SET
  status='sent' WHERE id IN (SELECT … FOR UPDATE SKIP LOCKED) RETURNING *`,
  reverting to `'failed'` if the send throws — so a slow SMTP send overlapping
  the next tick (or a second runner) can't double-send the same row (PS-2,
  at-most-once delivery). The manual `POST /api/emails/:id/send` claims the row
  the same way (`UPDATE … WHERE id = $1 AND status <> 'sent' RETURNING`) so a
  double-click / retry returns 409 instead of re-sending (PB-4).
- **Tests**: `tests/` (node:test runner, `npm test`, 257 tests (api + integration + cycle-fixes))
- **Deployment**: `Dockerfile`, `fly.toml` (Fly.io), `render.yaml` (Render)

## Current State (as of March 2026)
- Modular Express server with separated routes, pages, and middleware (matches Perfin aesthetic exactly)
- **Authentication**: Set `SESSION_PASSWORD` (text) or `SESSION_PIN` (numeric PIN pad) env var
- **Dark/Light theme**: Toggle in Settings, persisted to DB + localStorage
- **To-Do Lists**: Short/medium/long-term horizons, 4 priority levels, categories, due dates
- **Todo Categories**: Preset categories (work, personal, health, finance, errands, home, learning) + custom; filterable on todos page and dashboard
- **Dashboard Task Views**: All / By Category / By Urgency / Due Soon tabs
- **Recurring Tasks**: Daily, weekly, monthly, yearly, weekdays + custom intervals (every N days/weeks/months) with auto-generation, streak/habit tracking, skip, and snooze. The midnight auto-roll cron atomically CLAIMS each overdue recurring row (`UPDATE … WHERE id = $1 AND completed = false RETURNING`) before generating the next instance, so it can't race the manual complete-recurring path into a double-generated instance (PS-11).
- **Subtasks**: Checklists within tasks with progress tracking
- **Natural Language Quick Add**: Create todos from natural language with auto-detected priority/horizon/due date (AI-enhanced when enabled)
- **Email Drafting**: Compose, schedule, send; natural language "Quick Send" parser
- **AI Email Drafting**: Claude-powered email composition (requires `ANTHROPIC_API_KEY`)
- **AI Email Tone Adjustment**: Rewrite emails as formal/casual/shorter/friendlier/direct
- **AI Task Breakdown**: Auto-generate subtasks from task title/description
- **AI Daily Briefing**: Dashboard summary of your day's priorities
- **AI Weekly Review Summary**: Narrative summary of your week's accomplishments
- **AI Note Auto-Tagging**: Suggest tags for notes based on content
- **AI Model Selection**: Per-feature choice of Haiku (fast/cheap), Sonnet (smarter), or Off — configurable in Settings
- **Email Templates**: Save and reuse common email formats
- **Notes**: Color-coded, pinnable, with optional reminders, tags, and Markdown support (bold, italic, lists, checkboxes, links, quotes, headings). The client-side `renderMd` link rule scheme-validates hrefs (`http(s):`/`mailto:` only, else neutralized to `#`) and quote-escapes the URL, so a `[x](javascript:…)` note can't render a clickable script URL (PS-4).
- **Task Dependencies**: Blocking/blocked-by relationships between tasks with circular dependency prevention
- **Streak Tracking**: Recurring tasks track completion streaks (current + best) with on-time detection
- **Contacts**: Name→email lookup for quick email addressing
- **Dashboard**: Customizable widget layout (drag-to-reorder, show/hide widgets), overview cards, task views, AI briefing, smart suggestions, natural language AI query, scheduled emails, Perfin widget, global search
- **AI Smart Suggestions**: AI-powered productivity coaching based on task priorities, due dates, and streaks
- **AI Natural Language Query**: Ask questions about your data ("what did I do last week?", "how many tasks are overdue?")
- **Automations/Rules Engine**: Create trigger→action rules (e.g., "when task created with category=work, set priority=high"), configurable in Settings
- **File Attachments**: Upload files (up to 10MB) to tasks, emails, and notes via local storage. The download route sanitizes the stored `original_name` in the `Content-Disposition` header (strips quotes/backslashes/control chars) and emits RFC 5987 `filename*=UTF-8''…`, so a crafted filename can't inject/spoof a header (PS-5).
- **iCal Export**: Export tasks and scheduled emails as .ics file for Google Calendar, Outlook, etc.
- **Voice Input**: Web Speech API microphone button on Quick Add and notes (Chrome/Edge)
- **Location-Based Reminders**: Set location (name + coordinates + radius) on tasks, periodic geofence checking with browser notifications
- **Mobile-Optimized**: Bottom navigation bar, hamburger menu, swipe between pages, floating action button, horizontal-scroll filters, responsive layouts
- **Offline Support**: Service worker caches pages and API responses, queues mutations for sync when back online, offline banner indicator
- **Global Search**: Search across todos, emails, and notes
- **Calendar View**: Monthly calendar with iCal export, showing tasks, emails, and notes by date
- **Weekly Review**: Stats summary + AI narrative of completed tasks, emails sent, notes created
- **Keyboard Shortcuts**: Global shortcuts (n=new todo, e=new email, /=search, etc.)
- **Drag-and-Drop**: Reorder todos by dragging
- **Browser Notifications**: Optional notification permission for reminders
- **PWA**: Installable as home screen app
- **Auto-migration**: Server runs all DB migrations on startup
- **Perfin Integration**: Dashboard widget showing subscription data, cross-link navigation
- **Trash/Undo**: Soft-delete with undo toast, restore from Settings trash, 30-day retention
- **Dashboard Inline Actions**: Complete tasks and send emails directly from dashboard
- **Bulk Actions**: Multi-select mode on todos, emails, and notes for batch operations
- **System Theme Auto-Detection**: Auto option follows OS dark/light preference via prefers-color-scheme
- **Backend Validation**: Server-side enum validation for priority, horizon, recurrence rules, note colors, email format. The email `PATCH` validates `status` against `VALID_EMAIL_STATUSES` too (not just `POST`), so a client can't force `status='scheduled'` with a past `scheduled_at` to inject a cron-pickable row (PS-7).
- **Cross-Entity Links**: Link todos, emails, and notes to each other; create todos from notes or emails with auto-linking
- **Notification System**: Centralized notification check for due tasks, overdue items, streaks at risk, and note reminders; browser push notifications on dashboard load
- **Analytics Dashboard**: Productivity insights with completion trends, day-of-week analysis, priority/category breakdowns, average completion time, streak leaderboard, productivity score, activity heatmap (90 days), emails sent/notes created counts; filterable by week/month/quarter/year
- **Todo Templates**: Save task structures (with subtasks) as reusable templates; apply from templates list; "Save as Template" from edit modal
- **Batch Contact Import**: CSV upload for bulk contact import with validation and error reporting
- **Quick Actions from Search**: Complete tasks, send emails, pin/unpin notes directly from search results
- **Undo for More Actions**: Undo task completion, email send, and delete (not just delete)
- **Recurring Task Calendar Projections**: Calendar shows future recurring task instances as dashed entries
- **Health Check Endpoint**: `/api/health` returns server status, uptime, memory, DB connectivity (no auth required)
- **API Pagination**: `limit` and `offset` query params on todos, emails, and notes list endpoints
- **Performance Indexes**: Database indexes on common query patterns (completed, due_date, priority, category, recurring, etc.)
- **Rate Limiting**: General (200/15min), auth (10/15min), and AI (20/min) rate limiters
- **CSRF Protection**: State-changing requests require `X-Requested-With` or JSON/multipart content-type; auto-injected by fetch wrapper in shared JS
- **Postgres Sessions**: `connect-pg-simple` stores sessions in DB (survives restarts/deploys), auto-creates table, prunes expired sessions every 15 min
- **Webhooks**: Configure external webhook endpoints to receive event notifications (task created/completed, email sent, streak milestones); test webhooks from Settings. Both webhook URLs (on create) AND the Slack URL (`config.isValidWebhookUrl`, at write-time + before each send) are SSRF-validated: `http(s)` only, and private/loopback/link-local ranges are blocked — including `169.254.0.0/16` (the cloud metadata endpoint `169.254.169.254`), the full `127.0.0.0/8`, RFC-1918, and bracketed IPv6 loopback/ULA (PB-1/PB-5).
- **Slack Integration**: Add Slack Incoming Webhook URL in Settings for notifications (SSRF-validated — see Webhooks above)
- **AI API Optimization**: Singleton client reuse, prompt caching via system prompts with `cache_control`, response caching for briefing (10min) and suggestions (5min)
- **Helmet CSP**: Content Security Policy via helmet. Inline event handlers are migrated to CSP-safe event delegation and `script-src-attr` defaults to `'none'` (via helmet) so inline `onclick`/`onchange` are blocked. NOTE: `script-src` still carries `'unsafe-inline'` because the page templates emit inline `<script>` blocks — so the CSP is NOT yet an XSS backstop the way Perfin's nonce-based policy is (known gap PB-3; removing `'unsafe-inline'` needs a per-request-nonce migration across all inline scripts). Rely on output-escaping (e.g. `renderMd` scheme-validation, PS-4) for XSS defense meanwhile.
- **Internal error handling**: route 500s go through `errors.serverError(res, err)`, which logs the real error server-side and returns a generic `"An internal error occurred."` — raw DB/constraint/internal text is never echoed to the client (PB-2, matching Perfin's convention).
- **Event Delegation**: All pages use `bindEvents()` for static elements and `onDelegate()` for dynamic content — zero inline `onclick`/`onchange` attributes; enables `script-src-attr: 'none'` CSP
- **Constant-Time Auth**: `crypto.timingSafeEqual` for password/PIN comparison; PIN pad shows fixed 8-dot display regardless of actual PIN length
- **Keep-Alive**: Self-ping system to prevent Render free tier from sleeping (14-minute interval)

## Key Files
- `.env` — all secrets (never commit)
- `.env.example` — template with setup instructions
- `server.js` — entry point (~180 lines: wires modules, starts server, cron jobs)
- `config.js` — constants, validation arrays, env var parsing
- `db.js` — database pool and migration runner
- `ai.js` — Anthropic client, callAI, model helpers, response caching
- `middleware.js` — session, auth, CSRF, helmet, rate limiting
- `helpers.js` — advanceRecurrence, webhooks, Slack, automations
- `errors.js` — `serverError(res, err)` shared 500 responder (logs real error, returns generic message; PB-2)
- `views.js` — pageHead, navBar, themeScript (imports from `views/`)
- `routes/` — 21 API route modules (auth, todos, emails, notes, contacts, etc.)
- `pages/` — 9 page rendering modules (dashboard, todos, emails, notes, etc.)
- `db/001_schema.sql` — database schema (todos, emails, notes, contacts, settings)
- `db/002_features.sql` — enhancement migration (recurring, subtasks, templates, reviews)
- `db/003_ai_features.sql` — AI model preferences & note tags migration
- `db/004_soft_delete.sql` — soft delete columns for trash/undo
- `db/005_dependencies_streaks_markdown.sql` — task dependencies, streak tracking, note format migration
- `db/006_dashboard_automations.sql` — dashboard layout, automations, attachments, location reminders
- `db/007_enhancements.sql` — custom recurrence, entity links, webhooks, notification preferences
- `db/008_templates_performance.sql` — todo templates table, performance indexes
- `uploads/` — local file attachment storage
- `tests/api.test.js` — unit test suite (the bulk of the 256 per-sistant tests)
- `tests/integration.test.js` — integration tests (requires DB, auto-skips without)
- `Dockerfile` / `docker-compose.yml` — container deployment
- `fly.toml` — Fly.io config
- `render.yaml` — Render blueprint

## Commands
```bash
# Install & run locally
npm install && node server.js

# Run tests (257 tests)
npm test

# Pages
GET  /                     # Dashboard
GET  /todos                # To-do list page
GET  /emails               # Email management page
GET  /notes                # Notes page
GET  /contacts             # Contact management page
GET  /settings             # Settings page
GET  /calendar             # Calendar view
GET  /review               # Weekly review page
GET  /analytics            # Analytics/insights dashboard
GET  /login                # Authentication

# Core API
GET    /api/todos           # List todos (query: horizon, priority, completed, category)
POST   /api/todos           # Create todo
PATCH  /api/todos/:id       # Update todo
DELETE /api/todos/:id       # Delete todo
POST   /api/todos/reorder   # Reorder todos (drag-and-drop)
POST   /api/todos/:id/complete-recurring  # Complete recurring task & generate next (with streak tracking)
POST   /api/todos/:id/skip-recurring     # Skip recurring task (preserves streak)
POST   /api/todos/:id/snooze             # Snooze task (postpone due date)
GET    /api/todo-categories  # List all categories (defaults + custom)
GET    /api/todos/:id/dependencies  # Get task dependencies (blocked_by + blocking)
POST   /api/todos/:id/dependencies  # Add dependency (depends_on_id)
DELETE /api/dependencies/:id         # Remove dependency
GET    /api/streaks                  # Get streak stats for recurring tasks

GET    /api/emails          # List emails (query: status)
POST   /api/emails          # Create email (draft or scheduled)
PATCH  /api/emails/:id      # Update email
DELETE /api/emails/:id      # Delete email
POST   /api/emails/:id/send # Send email now

GET    /api/notes           # List notes (includes tags, format)
POST   /api/notes           # Create note (with optional tags array, format: plain/markdown)
PATCH  /api/notes/:id       # Update note (including format)
DELETE /api/notes/:id       # Delete note

GET    /api/trash            # List all trashed items
POST   /api/trash/:type/:id/restore  # Restore item from trash
DELETE /api/trash/:type/:id  # Permanently delete trashed item
POST   /api/trash/empty      # Empty all trash

POST   /api/bulk/todos       # Bulk action on todos (complete, delete, set_priority, set_horizon)
POST   /api/bulk/emails      # Bulk action on emails (delete)
POST   /api/bulk/notes       # Bulk action on notes (delete)

GET    /api/contacts        # List contacts
POST   /api/contacts        # Add contact
PATCH  /api/contacts/:id    # Update contact
DELETE /api/contacts/:id    # Delete contact
GET    /api/contacts/lookup/:name  # Lookup by name

GET    /api/settings        # Get settings
PATCH  /api/settings        # Update settings (including dashboard_layout)
GET    /api/stats           # Dashboard statistics

# Automations API
GET    /api/automations            # List automation rules
POST   /api/automations            # Create automation rule
PATCH  /api/automations/:id        # Update automation rule
DELETE /api/automations/:id        # Delete automation rule

# Attachments API
GET    /api/attachments/:type/:id       # List attachments for entity
POST   /api/attachments/:type/:id       # Upload file attachment (multipart)
GET    /api/attachments/download/:id    # Download attachment
DELETE /api/attachments/:id             # Delete attachment

# Cross-Entity Links
GET    /api/links/:type/:id        # Get links for an entity
POST   /api/links                  # Create a link between entities
DELETE /api/links/:id              # Remove a link
POST   /api/notes/:id/create-todo  # Create todo from note (with auto-link)
POST   /api/emails/:id/create-todo # Create todo from email (with auto-link)

# Webhooks API
GET    /api/webhooks               # List webhooks
POST   /api/webhooks               # Create webhook
PATCH  /api/webhooks/:id           # Update webhook
DELETE /api/webhooks/:id           # Delete webhook
POST   /api/webhooks/:id/test      # Test a webhook

# Notifications
GET    /api/notifications/check    # Check for due tasks, overdue, streaks at risk, reminders

# Analytics
GET    /api/analytics              # Productivity analytics (query: period=week|month|quarter|year)

# Calendar Export
GET    /api/calendar.ics           # iCal export of tasks and scheduled emails

# Enhancement API
GET    /api/subtasks/:todoId       # List subtasks for a todo
POST   /api/subtasks/:todoId       # Create subtask
PATCH  /api/subtasks/:id           # Update subtask
DELETE /api/subtasks/:id           # Delete subtask

GET    /api/email-templates        # List email templates
POST   /api/email-templates        # Create template
PUT    /api/email-templates/:id    # Update template
DELETE /api/email-templates/:id    # Delete template

GET    /api/todo-templates          # List todo templates
POST   /api/todo-templates          # Create todo template
PATCH  /api/todo-templates/:id      # Update todo template
DELETE /api/todo-templates/:id      # Delete todo template
POST   /api/todo-templates/:id/apply  # Create todo from template

POST   /api/contacts/import         # Batch import contacts (JSON array)

GET    /api/health                  # Health check (no auth, returns uptime/db status)

GET    /api/search                 # Global search (query: q, with quick action fields)
GET    /api/calendar               # Calendar events (query: month, year)
GET    /api/review                 # Weekly review stats
GET    /api/perfin/stats           # Proxy to Perfin API

# AI API (each respects per-feature model selection)
POST   /api/ai/draft-email         # AI-powered email drafting
POST   /api/ai/task-breakdown      # Generate subtasks from task title
POST   /api/ai/parse-todo          # Parse natural language into structured todo
POST   /api/ai/review-summary      # Generate weekly review narrative
POST   /api/ai/adjust-tone         # Rewrite email in different tone
GET    /api/ai/daily-briefing      # Generate daily task briefing
POST   /api/ai/suggest-tags        # Suggest tags for note content
GET    /api/ai/smart-suggestions   # AI productivity coaching suggestions
POST   /api/ai/query               # Natural language query about your data
GET    /api/ai/models              # Get per-feature model preferences
PATCH  /api/ai/models              # Update per-feature model preferences

# Knowledge / RAG API (personal knowledge base Q&A)
GET    /api/rag/search             # retrieval only (vector if configured, else keyword); zero LLM cost
POST   /api/rag/query              # source-grounded answer via the Citations feature (each source
                                   #   flagged cited:true/false); exact-match answer cache (free repeats)
GET    /api/rag/status             # vault config + index counts + embeddings/vector readiness + reindex state
POST   /api/rag/reindex            # background full reindex (vault re-walk + notes); 202, poll status; 409 if running
GET    /api/rag/facts              # browse current structured facts (query: entity, all=1 to include expired)
POST   /api/rag/diagram            # generate a Mermaid diagram from the knowledge base (facts+finance+prose)
POST   /api/rag/capture            # structure raw text into a note/fact and COMMIT it to the vault repo
                                   #   (needs VAULT_GITHUB_WRITE_TOKEN; 400 if unset)

POST   /api/login           # Authenticate
POST   /api/logout          # End session
GET    /manifest.json       # PWA manifest
GET    /sw.js               # Service worker
```

## Environment Variables
- `NEON_DATABASE_URL` — Neon PostgreSQL connection string
- `SESSION_PASSWORD` — text password for login (optional)
- `SESSION_PIN` — numeric PIN for PIN pad login (optional)
- `SESSION_SECRET` — session cookie secret (auto-generated if not set)
- `SMTP_HOST` — SMTP server for sending emails
- `SMTP_PORT` — SMTP port (default 587)
- `SMTP_USER` — SMTP username
- `SMTP_PASS` — SMTP password
- `SMTP_FROM` — From email address
- `CONTACTS` — JSON map of name→email (e.g. `{"mom":"mom@email.com"}`)
- `ANTHROPIC_API_KEY` — Claude API key for AI features (optional)
- `PERFIN_URL` — URL to linked Perfin instance (for navigation + dashboard integration)
- `VOYAGE_API_KEY` — Voyage AI key for Knowledge embeddings (optional). Without
  it, Knowledge falls back to keyword retrieval over notes/documents.
- `VOYAGE_MODEL` — embedding model (default `voyage-3.5`, 1024-dim — must match
  the `chunks.embedding vector(1024)` column)
- `VAULT_GITHUB_TOKEN` — read-only fine-grained GitHub PAT for the private
  Obsidian-vault repo. Used to pull changed markdown via the GitHub API (no
  clone). Never stored in the DB; repo/branch are set in Settings → Knowledge.
- `VAULT_GITHUB_WRITE_TOKEN` — SEPARATE write-scoped PAT (Contents read+write)
  for "Capture to vault" (`POST /api/rag/capture`). Kept distinct from the
  read-only sync token (least privilege); capture is disabled until it's set.

## Database
- Auto-migration runs on server startup — no manual SQL execution needed.
  All migration files run inside ONE transaction (`BEGIN`/`COMMIT`); a failure
  is FATAL: `runMigrations` rolls back and rethrows, and `start()` exits
  non-zero rather than booting against a half-applied schema (PS-1, mirrors
  Perfin's migration guarantee). Migrations are gated on
  `PERSISTENT_DATABASE_URL || NEON_DATABASE_URL` — the same connection string
  the pool uses — so a pure-standalone deployment with only
  `PERSISTENT_DATABASE_URL` set still runs them (previously gated on
  `NEON_DATABASE_URL` alone, which silently skipped migrations in that config).
  Because PS-1 made re-runs fatal, every statement MUST be idempotent. Most use
  `IF NOT EXISTS` / `CREATE OR REPLACE` / `DO $$ … IF NOT EXISTS(pg_constraint)`,
  but `CREATE TRIGGER` has no `IF NOT EXISTS` form, so each trigger is preceded
  by `DROP TRIGGER IF EXISTS <name> ON <table>;` (001_schema.sql, 002_features.sql).
  A bare `CREATE TRIGGER` would throw "already exists" on the second deploy,
  abort the whole transaction, and crash the shell on boot — pinned by
  `tests/cycle-fixes.test.js` "every CREATE TRIGGER is idempotent".
- `user_settings` table: single-row pattern (CHECK id = 1), includes ai_model_* columns
- `user_settings.perfin_webhook_recipient TEXT`: destination email address for
  inbound `insights_generated` webhooks from Perfin. `routes/perfin.js` reads
  this to decide who to mail the rendered insight HTML to; falls back to
  `SMTP_FROM` / `SMTP_USER` if unset, or saves the email as a draft if no
  destination resolves.
- Perfin also emits `weekly_summary` and `daily_summary` webhooks
  (different event names, same `{ subject, html_body, plain_text }`
  payload shape) for the opt-in weekly + daily digest channels.
  `routes/perfin.js` routes all three (`insights_generated`,
  `weekly_summary`, `daily_summary`) through the same email-store
  handler — they share `recipient_email` selection (from
  `perfin_webhook_recipient` → SMTP_FROM → SMTP_USER → draft), differ
  only on the `recipient_name` label and fallback subject.
- **Inbound webhook replay/expiry guard** (SN-1): after the HMAC signature
  check, `routes/perfin.js` rejects payloads whose signed `timestamp` is
  outside a ±5-minute window, and tracks recently-seen signatures in a
  self-cleaning TTL map so a captured signed POST can't be replayed to
  re-queue digest emails. Mirrors the SSO nonce-replay protection on the
  Perfin side.

## Express version
Per-sistant is pinned to **express v4** (^4.21.0) to align with the
Perfin sub-app and the shell. Do not introduce v5-only idioms (`req.host`,
`app.del`, removed wildcard path patterns, etc.) — the workspace install
hoists v4 across all sub-apps and a v5 idiom would break under the
hoisted version.
- Tables: `todos`, `emails`, `notes`, `contacts`, `user_settings`, `subtasks`, `email_templates`, `todo_templates`, `weekly_reviews`, `task_dependencies`, `automations`, `attachments`, `documents`, `chunks`, `embed_state`, `rag_answer_cache`, `facts`
- **Knowledge / RAG** (`db/013_knowledge.sql`, `db/014_vault_vectors.sql`):
  - `documents` — personal knowledge corpus (`source` manual/vault/note,
    `source_ref`, `sensitivity` normal/private/secret). Filled by the Obsidian
    vault sync (`source='vault'`). Only `sensitivity='normal'` is embedded +
    retrievable; private/secret are stored but never embedded/returned.
  - `chunks` — polymorphic (`source_kind` note/document, `source_id`) with
    `embedding vector(1024)`, HNSW cosine index. **Created defensively** — the
    migration only builds it when the `vector` extension is available, so an
    unsupported Postgres degrades to keyword retrieval instead of failing the
    (fatal) migration and crashing the shell. `services/vault-sync.vectorReady`
    + `routes/rag.js` gate on its existence.
  - `embed_state` — per-source content hash so unchanged notes/docs aren't
    re-embedded each sync.
  - `user_settings.ai_model_rag` (default sonnet) + `vault_enabled` /
    `vault_repo` / `vault_branch` / `vault_last_sha` / `vault_last_synced_at` /
    `vault_last_error`. The vault GitHub token is the `VAULT_GITHUB_TOKEN` env
    var, never a DB column.
  - Sync: `services/vault-sync.js` (GitHub Contents/Trees/compare API, no clone;
    frontmatter `embed:false`/`private:true`/`sensitivity:` honored). Hourly
    in-process cron + `POST /api/rag/reindex` (also driven by the
    `knowledge-reindex.yml` GitHub Action via `x-api-key`). Embeddings via
    `services/embeddings.js` (Voyage, native fetch). Retrieval is vector-first
    with keyword fallback.
  - **Citations (Phase 2):** `POST /api/rag/query` answers via the Anthropic
    Citations feature (`ai.answerWithCitations` — each retrieved source is a
    plain-text document block with citations enabled; response flags each
    source `cited:true/false`). Falls back to prompt-cite `callAI` if the
    citations call throws. Citations are incompatible with structured outputs
    (unused here).
  - **Answer cache (Phase 2):** `rag_answer_cache` — exact-match, keyed by
    normalized query + model + a corpus-version stamp (`max(updated_at)` + active
    row count over notes+documents+facts), 24h freshness. Auto-invalidates when
    the corpus changes; survives restarts (unlike the in-memory ai.js cache).
    Helpers in `routes/rag.js` swallow errors so a pre-migration/missing table
    degrades to "no cache". Semantic (paraphrase) caching is deferred.
  - **Structured facts (Phase 2c):** `facts` — precise, supersedable
    `(entity, attribute, value)` rows with `valid_from`/`valid_to` (NULL = still
    current) and `sensitivity`. Authored as flat frontmatter in vault "fact
    files" (`type: fact`): reserved keys (type/entity/valid_from/valid_to/
    sensitivity/tags/title/embed/private/context) are metadata, every other key
    becomes a fact row; `services/vault-sync.extractFacts` + `upsertFacts`
    replace all facts for a file on each sync. `POST /api/rag/query` injects the
    matching CURRENT, `normal`-sensitivity facts (`buildFactsQuery` +
    `factsToDocument`) as an authoritative "Known facts (current)" document
    listed first and cited — so precise lookups ("current deductible") don't
    depend on fuzzy vector recall. Browse via `GET /api/rag/facts`. Only the
    active validity window is injected (historical/superseded facts are not
    surfaced in answers).
  - **Cross-app finance grounding (Phase 3):** for finance-flavored questions
    (`looksFinancial` keyword gate), `POST /api/rag/query` pulls a READ-ONLY
    snapshot from Perfin (`perfinFinanceSnapshot` over the shell-wired
    `perfinPool` — `linked_accounts` balances + active `detected_subscriptions`;
    INV-25, never an HTTP self-fetch) and injects it as a cited "Finances (from
    Perfin)" source. Only fires on finance queries (non-finance queries never
    touch perfinPool) and is schema-drift safe (any error → no finance context).
    No Perfin schema changes. Standalone (no perfinPool) → silently skipped.
  - **Diagrams (Phase 3):** `POST /api/rag/diagram` retrieves like `/query`
    (facts+finance+prose) and asks the model for Mermaid only
    (`stripMermaidFences` cleans stray code fences). Generative, so no Citations
    and no answer-cache. Rendered client-side on the Knowledge page via Mermaid
    from cdn.jsdelivr.net (already in the CSP `scriptSrc` allowlist),
    `securityLevel:'strict'`; the Mermaid source is shown in a `<details>` and
    used as the fallback when render fails.
  - **Capture-to-vault (Phase 3):** `POST /api/rag/capture` structures raw text
    (pasted email, dictation) into a note or fact (AI when available, else a
    raw note) and COMMITs it to the vault repo at `captures/<date>-<slug>-<rand>.md`
    via `vault-sync.commitVaultFile`. Outward write gated on a SEPARATE
    write-scoped `VAULT_GITHUB_WRITE_TOKEN` (the sync token stays read-only); 400
    until set. Unique paths mean it's always a create. Kicks a background
    syncVault so the capture is searchable soon. Capture box on the Knowledge page.
  - **Proactive surfacing (Phase 3):** `routes/rag.upcomingFacts(pool, days)`
    finds facts with an upcoming date — the validity window ending (`valid_to`)
    or a date-valued attribute (`renew`/`expir`/`due`/`deadline`/…). `GET
    /api/notifications/check` includes these as `fact_upcoming` notifications (+
    a count) over a 30-day lookahead; the dashboard browser-notifies the
    imminent ones (≤7 days). Schema-drift safe (errors → no upcoming facts).
    Per-sistant has no email digest (that's Perfin) — the notification check is
    the proactive surface.

## Embedded Mode (under the unified shell)
When loaded by `shell/index.js` instead of run standalone, the Per-sistant app
runs as an Express sub-app mounted at `/per-sistant`. Three things change:

- **Auth bails early.** `middleware.requireAuth` returns immediately when
  `req.app.get("embedded")` is true; the shell's PIN gate has already
  authenticated the user.
- **Cross-pool wiring.** The shell does
  `persistent.app.set("perfinPool", perfin.pool)`, so any route can
  `req.app.get("perfinPool")` to query Perfin's database directly. The Perfin
  widget at `routes/perfin.js` uses this for an embedded fast-path; the HTTP
  fetch path is preserved only as the standalone fallback.
- **basePath middleware.** `views.basePathMiddleware` (in `server.js`) makes
  `req.baseUrl` available to view helpers via AsyncLocalStorage so emitted
  URLs gain the `/per-sistant` prefix without each helper threading the
  parameter through manually.

Migrations and cron jobs run in both modes; only the listener, keep-alive,
and signal handlers are owned by the shell when embedded.

## AI Features & Models
- 9 AI features, each independently configurable: Haiku (fast/cheap), Sonnet (smarter), or Off
- Models: `claude-haiku-4-5-20251001`, `claude-sonnet-4-6-20250415`
- Features: email drafting, task breakdown, smart quick add, weekly review summary, email tone adjustment, daily briefing, note auto-tagging, smart suggestions, natural language query
- Configuration stored in `user_settings` table (ai_model_* columns)
- Settings page provides per-feature dropdowns

## Design System (shared with Perfin)
- Font: Inter (300/400/500/600/700)
- Dark theme: `#080b12` bg, `#f0ebe3` text, warm palette (`#d4a574`, `#c8856c`)
- Light theme: `#f5f2ed` bg, `#1a1a2e` text
- Accent colors: warm, teal, green, red, yellow, blue
- Glassmorphism cards with backdrop-filter blur
- Radial gradient ambient lighting effects

## Companion App
- **Perfin**: Personal finance tracker (separate repo: `pers-fin`)
- Same design system, same deployment approach
- Cross-linked via navigation bar
- Dashboard widget shows Perfin subscription data when `PERFIN_URL` is set

## Git
- Branch management lives at the parent `pers-fin` repo level under the
  unified shell. The historical `claude/personal-assistant-tool-KdEYQ`
  branch was the standalone Per-sistant default before subtree-merge.
  See the parent CLAUDE.md "Git" section for the current active branch.
