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
- **Dragon**: `dragon-svg.js` (Haku dragon SVG paths + mask, converted from PNG reference)
- **Routes**: `routes/` (21 route modules — auth, todos, emails, notes, contacts, settings, etc.)
- **Pages**: `pages/` (9 page modules — dashboard, todos, emails, notes, contacts, calendar, review, analytics, settings)
- **Email**: nodemailer (SMTP) with scheduled sending via node-cron
- **Tests**: `tests/` (node:test runner, `npm test`, 181 unit tests + integration tests)
- **Deployment**: `Dockerfile`, `fly.toml` (Fly.io), `render.yaml` (Render)

## Current State (as of March 2026)
- Modular Express server with separated routes, pages, and middleware (matches Perfin aesthetic exactly)
- **Authentication**: Set `SESSION_PASSWORD` (text) or `SESSION_PIN` (numeric PIN pad) env var
- **Dark/Light theme**: Toggle in Settings, persisted to DB + localStorage
- **To-Do Lists**: Short/medium/long-term horizons, 4 priority levels, categories, due dates
- **Todo Categories**: Preset categories (work, personal, health, finance, errands, home, learning) + custom; filterable on todos page and dashboard
- **Dashboard Task Views**: All / By Category / By Urgency / Due Soon tabs
- **Recurring Tasks**: Daily, weekly, monthly, yearly, weekdays + custom intervals (every N days/weeks/months) with auto-generation, streak/habit tracking, skip, and snooze
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
- **Notes**: Color-coded, pinnable, with optional reminders, tags, and Markdown support (bold, italic, lists, checkboxes, links, quotes, headings)
- **Task Dependencies**: Blocking/blocked-by relationships between tasks with circular dependency prevention
- **Streak Tracking**: Recurring tasks track completion streaks (current + best) with on-time detection
- **Contacts**: Name→email lookup for quick email addressing
- **Dashboard**: Customizable widget layout (drag-to-reorder, show/hide widgets), overview cards, task views, AI briefing, smart suggestions, natural language AI query, scheduled emails, Perfin widget, global search
- **AI Smart Suggestions**: AI-powered productivity coaching based on task priorities, due dates, and streaks
- **AI Natural Language Query**: Ask questions about your data ("what did I do last week?", "how many tasks are overdue?")
- **Automations/Rules Engine**: Create trigger→action rules (e.g., "when task created with category=work, set priority=high"), configurable in Settings
- **File Attachments**: Upload files (up to 10MB) to tasks, emails, and notes via local storage
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
- **Backend Validation**: Server-side enum validation for priority, horizon, recurrence rules, note colors, email format
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
- **Webhooks**: Configure external webhook endpoints to receive event notifications (task created/completed, email sent, streak milestones); test webhooks from Settings
- **Slack Integration**: Add Slack Incoming Webhook URL in Settings for notifications
- **AI API Optimization**: Singleton client reuse, prompt caching via system prompts with `cache_control`, response caching for briefing (10min) and suggestions (5min)
- **Helmet CSP**: Content Security Policy via helmet with strict directives; all inline event handlers migrated to CSP-safe event delegation (`bindEvents()`/`onDelegate()` pattern)
- **Event Delegation**: All pages use `bindEvents()` for static elements and `onDelegate()` for dynamic content — zero inline `onclick`/`onchange` attributes; enables `script-src-attr: 'none'` CSP
- **Constant-Time Auth**: `crypto.timingSafeEqual` for password/PIN comparison; PIN pad shows fixed 8-dot display regardless of actual PIN length
- **Dashboard Visuals**: Animated isometric bonsai tree with cherry blossoms, falling petals, moss, and energy pulse effects; Haku dragon (converted from PNG reference) sleeping beside tree with breathing animation, zzz indicators, glow aura, and streak-based glow; SVG mountain landscape background with parallax layers and trees
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
- `views.js` — pageHead, navBar, themeScript (imports from `views/`)
- `dragon-svg.js` — Haku dragon SVG paths (112 body paths, 1 mask cutout, converted from PNG)
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
- `tests/api.test.js` — unit test suite (181 tests, 52 suites)
- `tests/integration.test.js` — integration tests (requires DB, auto-skips without)
- `Dockerfile` / `docker-compose.yml` — container deployment
- `fly.toml` — Fly.io config
- `render.yaml` — Render blueprint

## Commands
```bash
# Install & run locally
npm install && node server.js

# Run tests (181 tests)
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

## Database
- Auto-migration runs on server startup — no manual SQL execution needed
- `user_settings` table: single-row pattern (CHECK id = 1), includes ai_model_* columns
- Tables: `todos`, `emails`, `notes`, `contacts`, `user_settings`, `subtasks`, `email_templates`, `todo_templates`, `weekly_reviews`, `task_dependencies`, `automations`, `attachments`

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

## Dashboard Visuals (Bonsai Tree + Haku Dragon)
- **Bonsai tree**: Isometric animated SVG on dashboard — cherry blossom canopy, moss on branches, falling petals, energy pulse trunk animation; sits on an isometric platform with pot
- **Haku dragon**: Sleeping beside the bonsai tree (to the right, above); converted from user-provided PNG reference image to SVG paths in `dragon-svg.js`; uses SVG mask to cut out background gaps between limbs; has breathing animation, zzz sleep indicators, glow aura, and streak-based golden glow
- **Dragon positioning**: `translate(188,68) scale(0.17)` in a 280x280 viewBox with `overflow: visible` on container; original dragon dimensions 900x835
- **Dragon colors**: Body is white/gray (#E3E3E3, #C7CACF, etc.), green tail feathers (#3FB3A0 main, #299687 details), teal accents (#49B6A6, #41B2A0), blue details (#0961A5, #1065A6)
- **Background**: SVG mountain landscape with 6 parallax layers (far peaks, mid-range hills, rolling foothills, tree line with polygon trees, foreground ridge); dark theme uses navy blues, light theme uses muted grays at lower opacity
- **Tree particles**: CSS-animated floating particles and falling cherry blossom petals via `.tree-particle` and `.falling-petal` classes
- **All visuals in**: `pages/dashboard.js` (SVG markup + JS interaction), `views/css.js` (animations, styles, background SVG), `dragon-svg.js` (dragon paths)

## Companion App
- **Perfin**: Personal finance tracker (separate repo: `pers-fin`)
- Same design system, same deployment approach
- Cross-linked via navigation bar
- Dashboard widget shows Perfin subscription data when `PERFIN_URL` is set

## Git
- Default branch: `claude/personal-assistant-tool-KdEYQ`
