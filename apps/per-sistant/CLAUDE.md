# CLAUDE.md — Project Context for Claude Code

## Project Overview
Personal assistant tool for task management, email scheduling, and note-taking.
Companion app to **Perfin** (personal finance tracker) — same design system, cross-linked navigation.

## Architecture
- **Entry point**: `server.js` (Express, port 3001, bound to 0.0.0.0) — slim ~180 lines
- **Config**: `config.js` (constants, env parsing, validation arrays)
- **Database**: `db.js` (pool + migrations), Neon PostgreSQL (schema in `db/`)
- **Middleware**: `middleware.js` (auth, CSRF, rate limiting, session)
- **AI**: `ai.js` (Anthropic Claude client, model helpers, caching) — 11 features with per-feature model selection (incl. Knowledge Q&A + Job Fit). Also hosts the monthly **AI cost cap** (`ai_usage` ledger + `getAiBudgetCents`/`recordAiUsage` + `callAIWithUsage`), introduced by Job Radar.
- **Helpers**: `helpers.js` (recurrence, webhooks, Slack, automations)
- **Views**: `views.js` + `views/css.js` + `views/js.js` (shared HTML/CSS/JS helpers)
- **Routes**: `routes/` (23 route modules + the `housing-due.js` helper — auth, todos, emails, notes, contacts, settings, rag, health, jobs, etc.)
- **Pages**: `pages/` (11 page modules — dashboard, todos, emails, notes, contacts, calendar, review, analytics, settings, knowledge, health, jobs)
- **Knowledge / RAG**: `routes/rag.js` + `services/embeddings.js` (Voyage) +
  `services/vault-sync.js` (Obsidian-vault ingest, GitHub API) + `pages/knowledge.js`.
  Personal knowledge base — pgvector semantic retrieval over the vault + notes
  (keyword fallback), Citations, answer cache, structured facts with temporal
  validity, Mermaid diagrams, capture-to-vault, never-sent-to-AI "secret" tier,
  and cross-app finance grounding from Perfin (read-only `perfinPool`). Migrations
  `db/013`–`db/019`. Full detail in the Knowledge block under **Database** below.
- **Email**: nodemailer (SMTP) with scheduled sending via node-cron. The
  scheduler atomically CLAIMS due emails before sending, ONE row per loop
  iteration (≤`MAX_PER_RUN` = 100 per tick) — `UPDATE emails SET status='sent'
  WHERE id = (SELECT id … ORDER BY scheduled_at, id LIMIT 1 FOR UPDATE SKIP
  LOCKED) RETURNING *` (PD-8: claiming the whole due batch at once meant a
  sleep/redeploy mid-run left every not-yet-sent row marked 'sent' — reported
  delivered, never sent; per-row claims shrink that window to the one in-flight
  send), reverting to `'failed'` if the send throws — so a slow SMTP send overlapping
  the next tick (or a second runner) can't double-send the same row (PS-2,
  at-most-once delivery). The manual `POST /api/emails/:id/send` claims the row
  the same way (`UPDATE … WHERE id = $1 AND status <> 'sent' RETURNING`) so a
  double-click / retry returns 409 instead of re-sending (PB-4).
- **Tests**: `tests/` (node:test runner, `npm test`, 622 tests (api + integration + cycle-fixes + knowledge + health + jobs + scan-sept-fixes/batch5/batch6/batch8/batch9/batch11/batch14 + model-upgrade))
- **Deployment**: `Dockerfile`, `fly.toml` (Fly.io), `render.yaml` (Render)

## Current State (as of June 2026)
- Modular Express server with separated routes, pages, and middleware (matches Perfin aesthetic exactly)
- **Authentication**: Set `SESSION_PASSWORD` (text) or `SESSION_PIN` (numeric PIN pad) env var
- **Dark/Light theme**: Toggle in Settings, persisted to DB + localStorage
- **To-Do Lists**: Short/medium/long-term horizons, 4 priority levels, categories, due dates
- **Todo Categories**: Preset categories (work, personal, health, finance, errands, home, learning) + custom; filterable on todos page and dashboard
- **Dashboard Task Views**: All / By Category / By Urgency / Due Soon tabs
- **Recurring Tasks**: Daily, weekly, monthly, yearly, weekdays + custom intervals (every N days/weeks/months) with auto-generation, streak/habit tracking, skip, and snooze. The midnight auto-roll cron atomically CLAIMS each overdue recurring row (`UPDATE … WHERE id = $1 AND completed = false RETURNING`) before generating the next instance, so it can't race the manual complete-recurring path into a double-generated instance (PS-11). The roll lives in `helpers.rollMissedRecurring(db, today)` and the cron runs at LOCAL midnight (`{ timezone: APP_TIMEZONE }`, today = `todayStr()` — it used to fire at UTC midnight, i.e. 5pm in Los Angeles). A rolled instance is marked **missed** (`completed = true` so it leaves the active list, but `missed = true` + `completed_at = NULL`), so analytics completion rate / category breakdown and `/api/stats` "done" no longer count it as finished (PB-10); the next instance is the first occurrence on/after today. Monthly/yearly chains keep their ORIGINAL day-of-month (`todos.recurrence_anchor_day`, db/022): `advanceRecurrence(date, rule, interval, anchorDay)` steps on the month index and clamps the day — Jan 31 → Feb 28 → Mar 31, Feb 29 yearly → Feb 28 … → Feb 29 (PD-2; setMonth used to drift Jan 31 → Mar 3 → Apr 3 forever). complete-recurring / skip-recurring / the roll carry the anchor to the new instance; a manual due-date edit resets it. **complete-recurring and skip-recurring share one implementation** (`completeRecurringTodo` / `skipRecurringTodo`, exported from `routes/todos.js`): one transaction that locks the row (`SELECT … WHERE id = $1 AND deleted_at IS NULL FOR UPDATE`) and refuses a non-recurring (400), already-completed (400 — so a double-tapped Skip or a Skip racing the midnight roll can't create two next instances, PB-11) or trashed (404) row. The next due date is `helpers.nextDueAfter(todo, today)` — step from the due date, then keep stepping until it is AFTER today, anchor day kept (PD-3: finishing a task a week late used to create a next instance that was already overdue, which the next midnight roll then marked missed and reset the streak). Bulk "complete" (`POST /api/bulk/todos`) routes recurring ids through `completeRecurringTodo` (next instance + streak + webhook) and plain-completes only the rest (PB-12 — it used to end the series).
- **Subtasks**: Checklists within tasks with progress tracking — a progress bar with a `%` label on the To-Dos page, and a compact `done/total` progress bar on the dashboard task cards (counts come from `subtask_total`/`subtask_done` on `GET /api/todos`, so no per-card N+1 fetch)
- **Natural Language Quick Add**: Create todos from natural language with auto-detected priority/horizon/due date (AI-enhanced when enabled)
- **Email Drafting**: Compose, schedule, send; natural language "Quick Send" parser. "Save Draft" always stores a DRAFT (the client sends `status:'draft'`; `POST /api/emails` honors an explicit `draft|scheduled` status and only infers `scheduled` from `scheduled_at` when none is sent) — a filled-in schedule time no longer turns a saved draft into a cron-sent email (PD-1). "Send now" saves the form first, so edits aren't dropped (PUI-2). Schedule/reminder `datetime-local` fields are filled via the shared `toLocalDatetimeInput(iso)` (views/js.js) in browser-local time, so open+save never shifts the time by the UTC offset (PUI-1).
- **AI Email Drafting**: Claude-powered email composition (requires `ANTHROPIC_API_KEY`)
- **AI Email Tone Adjustment**: Rewrite emails as formal/casual/shorter/friendlier/direct
- **AI Task Breakdown**: Auto-generate subtasks from task title/description
- **AI Daily Briefing**: Dashboard summary of your day's priorities
- **AI Weekly Review Summary**: Narrative summary of your week's accomplishments
- **AI Note Auto-Tagging**: Suggest tags for notes based on content
- **AI Model Selection**: Per-feature choice of Haiku (fast/cheap), Sonnet (smarter), or Off — configurable in Settings
- **Email Templates**: Save and reuse common email formats
- **Notes**: Color-coded, pinnable, with optional reminders, tags, and Markdown support (bold, italic, lists, checkboxes, links, quotes, headings). The client-side `renderMd` link rule scheme-validates hrefs (`http(s):`/`mailto:` only, else neutralized to `#`) and quote-escapes the URL, so a `[x](javascript:…)` note can't render a clickable script URL (PS-4).
- **Task Dependencies**: Blocking/blocked-by relationships between tasks with circular dependency prevention — a cycle of ANY length is refused (`WITH RECURSIVE` reachability over `task_dependencies`; only a direct A↔B pair used to be caught) and a trashed task neither blocks nor is blocked (both dependency lists filter `t.deleted_at IS NULL`) (PD-12)
- **Streak Tracking**: Recurring tasks track completion streaks (current + best) with on-time detection — "on time" compares the APP_TIMEZONE date (`todayStr()`) with the due date read via local getters (`ymdLocal`), so a completion on the due date's local evening west of UTC no longer resets the streak (PD-4)
- **Contacts**: Name→email lookup for quick email addressing (POST/PATCH validate the address — PD-9)
- **Dashboard**: Customizable widget layout (drag-to-reorder, show/hide widgets), overview cards, task views (with subtask progress bars), AI briefing, smart suggestions, scheduled emails, Perfin widget, global search, a "Snooze reminders" button. (The "Ask your assistant" card was retired — it's now the top-bar **Ask** button, available on every page; saved layouts still listing `ai_query` are pruned in `loadLayout()`.)
- **AI Smart Suggestions**: AI-powered productivity coaching based on task priorities, due dates, and streaks. Its own model setting (`ai_model_smart_suggestions`, db/024 — PD-7; it used to follow the Daily Briefing model)
- **AI Natural Language Query**: Ask questions about your data ("what did I do last week?", "how many tasks are overdue?"). Surfaced as the **Ask** button in the top bar (appbar `ui-controls` slot, next to the Perfin cross-app link) — a global popover wired in `views/js.js`, reachable from every page, posting to `POST /api/ai/query`. Its own model setting `ai_model_natural_language_query` (default haiku, db/024 — PD-7): it used to be gated on the Daily Briefing model, which defaults to off, so Ask answered "AI is not enabled" on a fresh install; without `ANTHROPIC_API_KEY` it now says so.
- **Knowledge base (RAG)**: a personal master knowledge store on the Knowledge page.
  Indexes an Obsidian vault (private GitHub repo) + your notes into pgvector for
  source-cited semantic Q&A (keyword fallback when embeddings are off); structured
  facts (`type: fact` frontmatter) with temporal validity for precise "current X?"
  lookups; Mermaid diagrams; capture-to-vault (write-scoped token); a "secret" tier
  that's findable locally but never embedded/sent to AI; proactive renewal/expiry
  surfacing via the notification check; and cross-app finance grounding that reads
  Perfin data read-only. Answers carry a grounded/trust signal + per-fact verify.
- **Health & Habits tracker**: Health page (`/health`) with habit definitions
  (check-off or quantity-vs-target; daily / weekdays / specific-days /
  N-times-per-week schedules), one-log-per-day upserts, streaks **computed at
  read time** from `habit_logs` (a backfilled log retroactively repairs a
  streak; an unlogged *today* never breaks one) in the `APP_TIMEZONE` zone
  (default UTC — see Environment Variables; set it to your zone so day-math
  matches your local calendar, F11), a clickable 7-day grid, a
  90-day consistency heatmap, and a measurements time series (weight, sleep,
  mood, custom…) with inline trend charts. Routes: `routes/health.js`
  (exports `gatherHealthSummary` + pure `computeStreaks`/`isDueOn` helpers);
  tables: `habits`, `habit_logs`, `health_metrics` (db/020). Habit streaks at
  risk feed the notification check and the AI daily briefing (both fail-soft);
  `streak_milestone` webhooks fire at 7/30/100/365-day streaks. DELETE
  archives (history kept) — restore from the page's Archived section.
- **Job Radar**: a personal job-listing radar (`/jobs` page) built INTO
  Per-sistant (the Health & Habits module recipe — `db/021_jobs.sql` +
  `routes/jobs.js` + `pages/jobs.js` + `tests/jobs.test.js`). Pulls listings
  from sanctioned APIs (Adzuna aggregator + direct ATS boards —
  Greenhouse/Lever/Ashby/Workable — over a curated, UI-editable
  `job_target_companies` allowlist; seeded with one example), normalizes them,
  and **dedups on a `content_hash`** (re-fetch hashes identically → upsert →
  2nd run adds 0). A **trust pass** (`job_sources.trust_weight` + ghost-job
  freshness decay from our own `first_seen` — never the source's claimed
  `posted_at` — + cross-source corroboration + apply-domain check + word-
  boundary regex scam heuristics → `trust_score` + `legitimacy`). A **fit pass**
  (Voyage embed the listing as a `document`, cosine vs the single `job_profile`
  row's `query` embedding, then a per-feature **Job Fit** Claude pass → 0-100
  `fit_score` + one-line rationale) and a **legitimacy pass** (borderline
  `suspect` rows → Claude `{legitimacy, reasons[]}`) — both **cap-charged**
  (see the AI cost cap below; charge in a `finally`, 429-when-capped) and
  fully fail-soft (no Voyage / no pgvector / AI off → degrade, never throw).
  A single fail-soft `gatherJobRadarSummary(pool)` aggregator (the
  `gatherHealthSummary` mirror) splits a **main** bucket (trust ≥ 60 AND a real
  fit score ≥ 65 AND not 'suspect') from a **"verify first"** bucket (trust
  40-59, OR not fit-scored yet, OR a 'suspect' verdict — PB-5/PB-6: a NULL fit
  used to count as passing, so "N new high-fit roles" fired with no profile at
  all). A `legitimacy='scam'` listing is hidden, and a 'new' listing whose
  `last_seen` is more than `STALE_DAYS` (14) behind the NEWEST `last_seen` (the
  latest refresh — not wall-clock, so skipped runs don't blank the page) is
  dropped as a ghost; saved listings stay. It feeds three surfaces: the
  `/jobs` page, the **notification check** (`job_radar` entry, weekly cadence
  from the refresh, gated on `job_radar_enabled`), and **one AI daily-briefing
  line** — there is NO email digest (D3: Per-sistant's proactive surface is the
  notification check). Saving/applying/dismissing a listing **archives** it
  (status change, never a row delete); saving/applying nudges its source's
  trust once per genuine status change — dismiss means "not interested", so it
  no longer lowers the trust of the whole source (PB-9). Each refresh
  (`runRefresh`) re-scores trust for EVERY live (new/saved, not stale) listing so
  the first_seen ghost decay actually applies, keeping a Claude legitimacy
  verdict (`legitimacy_reasons` set), and backfills fit for live listings with
  no `fit_score` (`liveListingIds`); the fit pass embeds only rows with no
  embedding, in groups of 64 with per-group try/catch, and Claude-scores only
  unscored candidates (still ≤ `maxFit` = 12 per run) (PB-5). Editing the
  profile's resume/preferences text clears `job_profile.profile_embedding` and
  the new/saved listings' fit scores (separate fail-soft statements — the column
  only exists with pgvector) and returns `rescore_needed`, so the next refresh
  re-ranks against the NEW profile (PB-4). Removing a target company sets
  `active = false` instead of deleting it — db/021 re-runs its seed every boot
  with `ON CONFLICT DO NOTHING`, so a deleted seed row used to come straight
  back (PB-7). Only `http(s)` apply links are ingested (`isHttpUrl`) or rendered
  (`safeUrl`, PUI-7); board fetches time out after 15 s (PB-19). The page has
  Radar / Saved / Applied / Dismissed views (`GET /api/jobs/list?status=`) with
  per-status actions (Unsave, Move back to radar), error states for failed loads
  and writes, a Refresh button disabled while running, and an Enabled toggle
  that reverts when its save fails (PUI-4). Weekly refresh via in-process node-cron (Mon 07:23 UTC, no
  heartbeat — D2: Per-sistant crons don't tick; gated on `job_radar_enabled`) +
  `POST /api/jobs/refresh` + the `.github/workflows/job-radar.yml` backstop.
  The endpoint ALSO honors `job_radar_enabled` — returns `{ ok: true, skipped:
  "disabled" }` while the feature is off, so the Monday Actions backstop no
  longer ingests/embeds/charges the AI cap for a disabled feature (PB-3); the
  `/jobs` page's Refresh button sends `?force=1` (an explicit user action).
  Retention strips old `description`s from unsaved/dismissed rows while keeping
  the hash+status tombstone. Default OFF — enable on the `/jobs` page. New env:
  `ADZUNA_APP_ID` / `ADZUNA_APP_KEY` (free tier; ATS-only without them); reuses
  `VOYAGE_API_KEY` + `ANTHROPIC_API_KEY`.
- **Automations/Rules Engine**: Create trigger→action rules (e.g., "when task created with category=work, set priority=high"), configurable in Settings. Triggers: `todo_created`, `todo_completed` (incl. completing a recurring task), `note_created`, `email_created` — all four fire now (notes/emails never called `runAutomations`). Actions: `set_priority` / `set_category` / `set_horizon` (todo triggers only — on a note/email trigger they would have rewritten the todo sharing that id), `add_tag` (notes), `create_todo` (any). `schedule` and `send_notification` were removed from `VALID_TRIGGERS`/`VALID_ACTIONS` (nothing ever ran them). `helpers.validateAutomationRule` checks the trigger/action pair, the required value and the priority/horizon enums on POST and on the merged PATCH (400), and `runAutomations` skips (logs) a stored rule that fails it and runs each rule in its own try/catch, so one bad rule no longer aborts the rest (PD-6).
- **File Attachments**: Upload files (up to 10MB) to tasks, emails, and notes via local storage. The download route sanitizes the stored `original_name` in the `Content-Disposition` header (strips quotes/backslashes/control chars) and emits RFC 5987 `filename*=UTF-8''…`, so a crafted filename can't inject/spoof a header (PS-5).
- **iCal Export**: Export tasks and scheduled emails as .ics file for Google Calendar, Outlook, etc. RFC 5545 output (PD-11): text is escaped by `icsEscape` (backslash, `;`, `,`, newline → `\n`, CR dropped — it used to print "Line1 nLine2" and a newline in a title broke the file), every VEVENT has a `DTSTAMP`, all-day tasks end the NEXT day (`DTEND == DTSTART` is a zero-length event Outlook rejects), DATE values use local getters, and lines are folded at 75 octets (`icsFold`).
- **Voice Input**: Web Speech API microphone button on Quick Add and notes (Chrome/Edge)
- **Location-Based Reminders**: Set location (name + coordinates + radius) on tasks, periodic geofence checking with browser notifications. `POST /api/todos` stores `location_*` (it used to drop them) and every next recurring instance (complete, skip, midnight roll) carries them; lat/lng/radius are range-checked (`parseLocationFields`, 400 instead of a CHECK-constraint 500) (PD-5).
- **Mobile-Optimized**: Bottom navigation bar, hamburger menu, swipe between pages, floating action button, horizontal-scroll filters, responsive layouts, pull-to-refresh in standalone PWA mode (views/js.js `initPullToRefresh` — passive listeners, overlay exclusions; the shared-JS module is one exported template literal, so the PTR block must stay backtick-free). **GOTCHA — `views/js.js` is one backtick template literal**, so beyond backticks, any `\` inside it is consumed by the template string: a regex literal like `/\/login(\?|#)/` emits `//login(?|#)/` (a `//` line comment) and silently breaks the whole client bundle. Use `indexOf`/`String` methods, or DOUBLE-escape (`\\/`, `\\?`), for any regex in this module — and `node --check` the EMITTED bundle (`require('./views/js.js')` → write to a file → `node --check`) after editing it, since the source file parses fine while the emitted string does not.
- **Offline Support**: Service worker caches pages and API responses, queues mutations for sync when back online, offline banner indicator. A write made offline returns **503** `{ ok:false, offline:true, queued, error }` — never `ok:true`, so "Email sent!"-style UI can't claim success. Writes whose late replay would surprise (`/send`, `/refresh`, `/api/ai/`, `/api/rag/`, auth, `/reindex`, `/sync`) are never queued, `/api/rag/secret*` and auth responses are never cached (Cache Storage persists them), and only `r.ok` GETs are cached. Replay keeps an entry on a network error / 401 / 408 / 429 / 5xx, drops it on success or a permanent 4xx, and drops entries older than 24 h (PB-17). The path lists use string matching (`routes/pwa.js` is a template literal). Cache `per-sistant-v8`.
- **Global Search**: Search across todos, emails, and notes
- **Calendar View**: Monthly calendar with iCal export, showing tasks, emails, and notes by date
- **Weekly Review**: Stats summary + AI narrative of completed tasks, emails sent, notes created. "Overdue" = open tasks due before TODAY (APP_TIMEZONE `todayStr()`), not before the week's start — a task due Monday and still open on Wednesday used to be in neither list nor the AI summary's count (PD-14).
- **Keyboard Shortcuts**: Global shortcuts (n=new todo, e=new email, /=search, etc.)
- **Keyboard access + dialogs** (PUI-5): custom controls rendered as divs — the task and subtask complete checks (`role="checkbox"` + `aria-checked`), note cards, metric cards and email-template rows (`role="button"`) — carry `tabindex="0"` and an `aria-label`; a global keydown in `views/js.js` turns Enter/Space on such an element into a click (so the existing delegation handles it) and Esc closes the top-most `.modal-overlay.active` (same as a backdrop click). A MutationObserver gives every `.modal` `role="dialog"` + `aria-modal` + an `aria-label` from its heading, moves focus inside when its overlay gains `active`, and restores focus when it closes or is removed — pages keep toggling `active` themselves. Habit day toggles carry `aria-pressed`.
- **Drag-and-Drop**: Reorder todos by dragging
- **Browser Notifications**: Optional notification permission for reminders
- **PWA**: Installable as home screen app
- **Auto-migration**: Server runs all DB migrations on startup
- **Perfin Integration**: Dashboard widget showing subscription data, cross-link navigation
- **Trash/Undo**: Soft-delete with undo toast, restore from Settings trash, 30-day retention. Permanently deleting a note (or emptying the trash) also purges its Knowledge `chunks`/`embed_state` (fail-soft), and vector retrieval requires the note row to exist, so a hard-deleted note is never retrieved or sent to Claude (KR-6).
- **Dashboard Inline Actions**: Complete tasks and send emails directly from dashboard
- **Bulk Actions**: Multi-select mode on todos, emails, and notes for batch operations
- **System Theme Auto-Detection**: Auto option follows OS dark/light preference via prefers-color-scheme
- **Backend Validation**: Server-side enum validation for priority, horizon, recurrence rules, note colors, email format. The email `PATCH` validates `status` against `VALID_EMAIL_STATUSES` too (not just `POST`), so a client can't force `status='scheduled'` with a past `scheduled_at` to inject a cron-pickable row (PS-7). A recipient must be exactly ONE address (PD-9): `EMAIL_REGEX` also rejects `, ; < > " ' ( )` (nodemailer reads "a@x.com,b.com" or "Name <a@x.com>" as a list/display form), it is checked on the email `PATCH` and contacts POST/PATCH too, and the scheduled-send cron marks a row with an invalid recipient `failed` instead of sending. Webhook `events` are validated on PATCH as on POST and escaped in the Settings list (PUI-6).
- **Cross-Entity Links**: Link todos, emails, and notes to each other; create todos from notes or emails with auto-linking
- **Notification System**: Centralized notification check for due tasks, overdue items, streaks at risk, and note reminders; browser push notifications on dashboard load. Every check type reaches the user (PB-1 — the client used to drop all but overdue / streak_at_risk / near facts): browser notifications fire for `overdue`, `due_today`, `streak_at_risk`, `habit_streak_at_risk`, `reminder`, `job_radar`, `vault_sync_error` (the Knowledge vault sync's last run left an error — KR-11; links to /knowledge), `fact_upcoming` within 7 days and `housing_due` when due today / overdue / within 3 days, each with a per-type title prefix (`REMINDER_PREFIX` / `isImportantReminder` in `pages/dashboard-script.js`); and a **Reminders** dashboard widget (`data-widget="reminders"`, in the default layouts) renders the FULL check list (≤12, linked) whether or not Notification permission was granted. A client-side **dedup ledger** (`localStorage['ps-notify-ledger']`, keyed by `type|id|title`) suppresses re-firing the same reminder within a 12h window (`NOTIFY_WINDOW_MS`), and a **snooze** affordance (`ps-notify-snooze-until`, 8h via the dashboard "Snooze reminders" button) mutes all reminder notifications for a while.
- **Analytics Dashboard**: Productivity insights with completion trends, day-of-week analysis, priority/category breakdowns, average completion time, streak leaderboard, productivity score, activity heatmap (90 days), emails sent/notes created counts; filterable by week/month/quarter/year
- **Todo Templates**: Save task structures (with subtasks) as reusable templates; apply from templates list; "Save as Template" from edit modal. Validated like todos (`validateTemplateFields`: recurrence rule, interval 1–365, priority, horizon, a title on every subtask) on POST/PATCH, and re-checked on apply so a legacy bad row 400s with the reason; apply runs in ONE transaction, so a failing subtask no longer leaves the todo half-created (PD-13).
- **Batch Contact Import**: CSV upload for bulk contact import with validation and error reporting
- **Quick Actions from Search**: Complete tasks, send emails, pin/unpin notes directly from search results
- **Undo for More Actions**: Undo task completion and delete (not just delete). Sending an email shows a plain toast with NO Undo (`showUndo(…, 'info')`) — the old "undo send" set a delivered email back to draft, so the next Send mailed it twice. Undo on a RECURRING completion calls `POST /api/todos/:id/undo-complete-recurring { next_id }`: it re-opens the task, deletes the next instance that completion generated (only while it is untouched — same chain, open, created < 1 day ago; 409 otherwise) and steps the streak back by one (best_streak / last_streak_date are not rolled back) (PUI-3).
- **Recurring Task Calendar Projections**: Calendar shows future recurring task instances as dashed entries
- **Health Check Endpoint**: `/api/health` returns server status, uptime, memory, DB connectivity (no auth required)
- **API Pagination**: `limit` and `offset` query params on todos, emails, and notes list endpoints
- **Performance Indexes**: Database indexes on common query patterns (completed, due_date, priority, category, recurring, etc.)
- **Rate Limiting**: General (200/15min), auth (10/15min), and AI (20/min) rate limiters
- **CSRF Protection**: State-changing requests require `X-Requested-With` or JSON/multipart content-type; auto-injected by the shared-JS `window.fetch` wrapper (`views/js.js`), which ALSO prepends `BASE_PATH` and (INV-63) redirects once to the root `/login` on a 401 / followed `302→/login` so a mid-session idle timeout sends the user to re-auth instead of leaving a blank/error page (loop-guarded; Response returned unchanged to callers)
- **Postgres Sessions**: `connect-pg-simple` stores sessions in DB (survives restarts/deploys), auto-creates table, prunes expired sessions every 15 min
- **Webhooks**: Configure external webhook endpoints to receive event notifications (task created/completed, email sent, streak milestones); test webhooks from Settings. Both the webhook URLs AND the Slack URL (`config.isValidWebhookUrl`) are SSRF-validated at write-time (on create/PATCH) AND re-validated before each outbound send (`helpers.sendWebhook` + `sendSlackNotification`, PSB2): `http(s)` only, and private/loopback/link-local ranges are blocked — including `169.254.0.0/16` (the cloud metadata endpoint `169.254.169.254`), the full `127.0.0.0/8`, RFC-1918, and bracketed IPv6 loopback/ULA (PB-1/PB-5). Since PB-14 the check is a real CIDR match (`config.isPrivateAddress`, node's built-in `net.BlockList`: 0/8, 10/8, 100.64/10, 127/8, 169.254/16, 172.16/12, 192.0.0/24, 192.168/16, 198.18/15, 224/4, 240/4, ::/96, 64:ff9b::/96, fc00::/7, fe80::/10, ff00::/8) with IPv4-mapped/compatible IPv6 unwrapped first — `http://[::ffff:169.254.169.254]/` normalizes to `[::ffff:a9fe:a9fe]` and used to pass the string-prefix checks. At SEND time `config.resolveSafeWebhookTarget(url)` also DNS-resolves the hostname and rejects it if ANY address is private (fails closed on a DNS error), and both senders fetch with `redirect: "manual"` so a public URL can't 30x to an internal one (a redirect is recorded as its 3xx status). A rebinding race between that lookup and fetch's own remains possible.
- **Slack Integration**: Add Slack Incoming Webhook URL in Settings for notifications (SSRF-validated — see Webhooks above)
- **AI API Optimization**: Singleton client reuse, prompt caching via system prompts with `cache_control`, response caching for briefing (10min) and suggestions (5min)
- **Helmet CSP**: Content Security Policy via helmet, **nonce-based** (PB-3 closed — parity with Perfin). `views.basePathMiddleware` generates a per-request `crypto.randomBytes(16)` nonce (it runs BEFORE `middleware.setup` installs helmet), exposing it as `res.locals.cspNonce` for the helmet `scriptSrc` directive function and via AsyncLocalStorage for view helpers. Every inline `<script>` — the 4 in `pageHead`, `themeScript`, all 11 pages, and the login page in `routes/auth.js` — carries `nonceAttr()` (exported from views.js). `script-src` has NO `'unsafe-inline'`; `https://cdn.jsdelivr.net` stays allowlisted for Mermaid on the Knowledge page. `script-src-attr` remains EXPLICITLY `'none'` (PWUI5) so inline `onclick`/`onchange` are blocked — all UI uses event delegation. Output-escaping (`renderMd` scheme-validation PS-4, `esc()` for element text, `escAttr()` for attribute contexts) remains the first line of defense; the nonce CSP is now the backstop. New inline scripts MUST use `<script${nonceAttr()}>` — a bare `<script>` will be refused by the browser (pinned by `tests/broad-scan-fixes.test.js`).
- **Internal error handling**: route 500s go through `errors.serverError(res, err)`, which logs the real error server-side and returns a generic `"An internal error occurred."` — raw DB/constraint/internal text is never echoed to the client (PB-2, matching Perfin's convention).
- **Event Delegation**: All pages use `bindEvents()` for static elements and `onDelegate()` for dynamic content — zero inline `onclick`/`onchange` attributes; enables `script-src-attr: 'none'` CSP
- **Constant-Time Auth**: `crypto.timingSafeEqual` for password/PIN comparison; PIN pad shows fixed 8-dot display regardless of actual PIN length
- **Keep-Alive**: Self-ping system to prevent Render free tier from sleeping (14-minute interval, 10 s fetch timeout — PB-19). Embedded under the shell the ping is the shell's and reads PERFIN's keep-alive settings, so the Settings section hides its controls (kept in the DOM for the script) and points to Perfin → Settings → Keep-Alive (PUI-8).

## Key Files
- `.env` — all secrets (never commit)
- `.env.example` — template with setup instructions
- `server.js` — entry point (~180 lines: wires modules, starts server, cron jobs)
- `config.js` — constants, validation arrays, env var parsing
- `db.js` — database pool and migration runner
- `ai.js` — Anthropic client, callAI, answerWithCitations, model helpers, response caching
- `middleware.js` — session, auth, CSRF, helmet, rate limiting
- `helpers.js` — advanceRecurrence (anchor-day aware), recurrenceAnchorDay, ymdLocal, rollMissedRecurring (the midnight missed-instance roll), webhooks, Slack, automations
- `routes/rag.js` — Knowledge / RAG API (search, query, diagram, capture, facts,
  facts/verify, secret-lookup, status, reindex) + retrieval/cache/facts/finance helpers
- `services/embeddings.js` — Voyage embeddings (one swappable `embed()`)
- `services/vault-sync.js` — Obsidian-vault ingest (GitHub API), chunking, frontmatter,
  facts extraction, capture commit
- `pages/knowledge.js` — Knowledge page (ask / search / diagram / capture / facts / secret)
- `routes/health.js` — Health & Habits API (habits CRUD, daily logs, metrics,
  summary/heatmap) + pure streak helpers (`computeStreaks`, `isDueOn`) and the
  shared `gatherHealthSummary` aggregator (notification check + AI briefing)
- `routes/housing-due.js` — shared Rent & Utilities due state (PB-2): pure
  `computeHousingDue(cfg, balance, n, today)` (day-granular on APP_TIMEZONE
  'YYYY-MM-DD' strings, due day clamped to the real month length; statuses
  upcoming / due_today / overdue / unscheduled — an OVERDUE balance surfaces
  every day until paid) + `housingDue(perfinPool)` (reads Perfin read-only,
  balance scoped to the configured payee, fail-soft → null) + `housingDueSuffix`.
  The ONLY copy of this math — used by both the notification check and the AI
  daily briefing (the old per-file copies went silent ON the due day and while
  rent was overdue). Not mounted as a router.
- `tests/scan-sept-batch5.test.js` — Sept 2026 broad-scan Batch 5 pins for the
  housingDue helper (due today, overdue, month-length clamp, payee scoping,
  notification-check integration)
- `pages/health.js` — Health page (today check-offs, 7-day grid, heatmap, measurements)
- `db/020_health.sql` — habits, habit_logs, health_metrics tables
- `routes/jobs.js` — Job Radar API (ingest/dedup/trust/fit/legitimacy passes,
  `runRefresh`, profile + allowlist CRUD, status PATCH) + the shared
  `gatherJobRadarSummary` aggregator + pure helpers (content hash, scam, domain,
  trust, near-dup, normalizers) and the `cappedCall` AI-cap guard
- `pages/jobs.js` — Job Radar page (enable toggle, top-matches + verify-first
  lists, profile + companies modals)
- `db/021_jobs.sql` — job_sources, job_target_companies, job_listings,
  job_profile + the `ai_usage` AI-cost-cap ledger
- `db/022_recurrence_anchor_missed.sql` — `todos.recurrence_anchor_day` (CHECK 1–31) + `todos.missed` (PD-2 / PB-10; additive, idempotent)
- `db/023_vault_sync_attempt.sql` — `user_settings.vault_last_attempt_at` (KR-11: `vault_last_synced_at` now means last SUCCESSFUL sync; additive, idempotent)
- `db/024_ask_suggestion_models.sql` — `user_settings.ai_model_natural_language_query` (default haiku) + `ai_model_smart_suggestions` (default off); existing rows inherit once from `ai_model_daily_briefing` (Ask → haiku when the briefing was off). Only NULLs are updated, so re-runs change nothing (PD-7)
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
- `tests/api.test.js` — unit test suite (the bulk of the 622 per-sistant tests; NOTE: it tests inline copies of the logic and imports no production module — see TQ-1 in the Sept 2026 broad scan)
- `tests/scan-sept-fixes.test.js` — Sept 2026 broad-scan Batch 1 pins (Save Draft status, Send-now save, local datetime fill, fail-closed vault sensitivity, vault mark-and-sweep, trash chunk purge)
- `tests/scan-sept-batch11.test.js` — Batch 11 Knowledge pins (ingest without embeddings + backfill, Voyage retry, per-file isolation, lock, ranking, finance snapshot vs getNetWorth, capture sensitivity, sync-failure visibility, citation fallback, cache prune, attribute word segments, vault_repo validation)
- `tests/scan-sept-batch14.test.js` — Batch 14 pins: Job Radar profile-edit reset, live re-score / fit backfill / stale + scam buckets / batched embeds, company deactivate, dismiss nudge, fetch timeouts, http(s) apply links, Jobs views; the service worker run in a vm against fake caches (503, no secret caching, replay rules); task location on create + recurrence; automation validation / wiring / isolation; Ask model column + db/024; single-recipient validation; iCal escaping/DTSTAMP/DTEND/folding; dependency cycles + trashed blockers; template validation + transactional apply; review overdue; recurring undo; keyboard/dialog wiring; webhook events; embedded keep-alive
- `tests/integration.test.js` — integration tests (requires DB, auto-skips without)
- `Dockerfile` / `docker-compose.yml` — container deployment
- `fly.toml` — Fly.io config
- `render.yaml` — Render blueprint

## Commands
```bash
# Install & run locally
npm install && node server.js

# Run tests (622 tests)
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
POST   /api/todos/:id/complete-recurring  # Complete recurring task & generate next (with streak tracking;
                                          # locked, next due after today — PD-3)
POST   /api/todos/:id/undo-complete-recurring  # Undo a recurring completion (body: next_id): re-open it and
                                          # delete the untouched generated instance; 409 if it changed (PUI-3)
POST   /api/todos/:id/skip-recurring     # Skip recurring task (preserves streak; locked + idempotent —
                                          # 400 on an already-completed row, PB-11)
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

POST   /api/bulk/todos       # Bulk action on todos (complete, delete, set_priority, set_horizon);
                             # complete routes recurring ids through complete-recurring (PB-12)
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
POST   /api/automations            # Create automation rule (validated — 400 on an unrunnable rule, PD-6)
PATCH  /api/automations/:id        # Update automation rule (validated against the merged row)
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
GET    /api/notifications/check    # Check for due tasks, overdue, streaks at risk (todos AND
                                   # habits), reminders, upcoming facts, rent/utilities due
                                   # (housing_due — cross-app via perfinPool, read-only, fail-soft;
                                   # carries status upcoming|due_today|overdue|unscheduled from
                                   # routes/housing-due.js),
                                   # AND Job Radar high-fit leads (job_radar — gated on
                                   # job_radar_enabled, fail-soft), AND vault_sync_error while
                                   # the Knowledge vault sync's last run left an error (KR-11)

# Job Radar API
GET    /jobs                       # Job Radar page (enable toggle, top matches + verify-first)
GET    /api/jobs                   # gatherJobRadarSummary — main + verify_first buckets + top_pick
GET    /api/jobs/list              # one status view (query: status=new|saved|applied|dismissed; ≤200 rows) — PUI-4
POST   /api/jobs/refresh           # run the pipeline (ingest → dedup → trust → fit → legitimacy →
                                   #   retention); also hit by the weekly cron + job-radar.yml backstop.
                                   #   { ok, skipped:"disabled" } while job_radar_enabled is off unless
                                   #   ?force=1 (the page button) — PB-3
PATCH  /api/jobs/:id               # set status new|saved|applied|dismissed (ARCHIVE — never deletes;
                                   #   save/apply nudges the source's trust once per change; dismiss
                                   #   never does — PB-9; returns prev_status). Invalid status/id → 400
GET    /api/job-profile            # single-row resume/preferences/min_salary/locations/remote_pref
PATCH  /api/job-profile            # update the profile (validated; bad min_salary/remote_pref → 400). A resume/
                                   #   preferences change clears the profile embedding + fit scores and
                                   #   returns rescore_needed:true (PB-4)
GET    /api/job-companies          # list the curated ATS allowlist
POST   /api/job-companies          # add/re-activate a company (body: slug, ats greenhouse|lever|
                                   #   ashby|workable, display_name?; bad ats/slug → 400)
DELETE /api/job-companies/:id      # stop polling a company — sets active=false (PB-7; GET lists active ones,
                                   #   POST re-activates)

# Health & Habits API
GET    /api/habits                 # Active habits + streaks + 7-day grid (?all=1 adds archived)
POST   /api/habits                 # Create habit (name, kind, target_value, unit, schedule,
                                   #   schedule_days, times_per_week)
PATCH  /api/habits/:id             # Update habit; is_active toggles archive/restore
DELETE /api/habits/:id             # ARCHIVE (history kept — no hard delete via API)
POST   /api/habits/:id/log         # Upsert a day's log (body: date?, value?, note?; future 400);
                                   #   returns recomputed current/best streak; fires
                                   #   streak_milestone webhook at 7/30/100/365
DELETE /api/habits/:id/log/:date   # Remove a day's log
GET    /api/habits/:id/history     # Log series (query: days, default 180, max 730)
GET    /api/health/summary         # Due/done today, streaks at risk, latest metrics
                                   #   (shared gatherHealthSummary — same data the
                                   #   notification check + AI briefing see)
GET    /api/health/heatmap         # Per-day count of habits that met their bar (query: days)
GET    /api/health/metrics         # Latest per metric; ?metric=&days= for one series
POST   /api/health/metrics         # Upsert a measurement (metric, value, unit?, date?, note?)
DELETE /api/health/metrics/:id     # Remove a measurement

# Analytics
GET    /api/analytics              # Productivity analytics (query: period=week|month|quarter|year)

# Calendar Export
GET    /api/calendar.ics           # iCal export of tasks and scheduled emails (RFC 5545 escaping, DTSTAMP — PD-11)

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
POST   /api/todo-templates/:id/apply  # Create todo from template (one transaction; 400 on an invalid legacy template)

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
GET    /api/rag/status             # vault config (last_synced_at = last SUCCESS, last_attempt_at, last_error) +
                                   #   index counts + embeddings/vector readiness + reindex state (incl. ok)
POST   /api/rag/reindex            # background full reindex (vault re-walk + notes); 202, poll status (reindex.ok —
                                   #   the knowledge-reindex Action fails on ok:false); 409 if running
GET    /api/rag/facts              # browse current structured facts (query: entity, all=1 to include expired); includes `verified`
POST   /api/rag/facts/verify       # mark/unmark a fact verified (body: entity, attribute, value, verified?)
GET    /api/rag/secret-lookup       # local exact match over sensitivity='secret' items; never embedded/sent to AI
POST   /api/rag/diagram            # generate a Mermaid diagram from the knowledge base (facts+finance+prose)
POST   /api/rag/capture            # structure raw text into a note/fact and COMMIT it to the vault repo
                                   #   (needs VAULT_GITHUB_WRITE_TOKEN; 400 if unset). body: text, sensitivity?
                                   #   normal|private|secret (400 otherwise) — private/secret skip the AI step

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
- `APP_TIMEZONE` — IANA timezone name (e.g. `America/New_York`) used for the
  Health & Habits day-math: the server's `todayStr()` and the injected client
  `todayLocal()` both resolve "today" in this zone so streaks, due-today, the
  7-day grid, and the future-log guard match the user's LOCAL calendar day
  (F11). Default `UTC` (reproduces the prior behavior exactly). Set it to your
  zone or an evening log west of UTC lands on the wrong day. The same zone
  also drives the recurring-task midnight roll (cron `timezone`), the
  complete-recurring on-time check, the notification check's / AI briefing's
  "today" (PB-13) and the Knowledge answer-cache date stamp. (Residual: the
  90-day heatmap grid + the SQL `CURRENT_DATE` range windows are still UTC —
  cosmetic 1-day edge only.)
- `VOYAGE_API_KEY` — Voyage AI key for Knowledge embeddings (optional). Without
  it (or without pgvector), the vault is still synced — documents and facts are
  ingested and keyword-searchable; adding the key later backfills embeddings
  (≤200 documents per sync, KR-3). Voyage 429/5xx/network errors are retried:
  3 times while indexing, once for an interactive query (Retry-After honored, KR-7).
- `VOYAGE_MODEL` — embedding model (default `voyage-3.5`, 1024-dim — must match
  the `chunks.embedding vector(1024)` column)
- `VAULT_GITHUB_TOKEN` — read-only fine-grained GitHub PAT for the private
  Obsidian-vault repo. Used to pull changed markdown via the GitHub API (no
  clone). Never stored in the DB; repo/branch are set in Settings → Knowledge.
- `VAULT_GITHUB_WRITE_TOKEN` — SEPARATE write-scoped PAT (Contents read+write)
  for "Capture to vault" (`POST /api/rag/capture`). Kept distinct from the
  read-only sync token (least privilege); capture is disabled until it's set.
- `ADZUNA_APP_ID` / `ADZUNA_APP_KEY` — Adzuna API credentials for the Job Radar
  aggregator ingest (free tier — register at developer.adzuna.com). Optional:
  without them Job Radar ingests ATS boards only (fail-soft per source).
- `PERSISTENT_AI_BUDGET_CENTS` — monthly AI budget fallback (cents, default 100 =
  $1.00) for the Job Fit + legitimacy passes. Overridden at runtime by
  `user_settings.ai_monthly_budget_cents`. Caps the `ai_usage` ledger spend.

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
- Tables: `todos`, `emails`, `notes`, `contacts`, `user_settings`, `subtasks`, `email_templates`, `todo_templates`, `weekly_reviews`, `task_dependencies`, `automations`, `attachments`, `documents`, `chunks`, `embed_state`, `rag_answer_cache`, `facts`, `fact_verifications`, `habits`, `habit_logs`, `health_metrics`, `job_sources`, `job_target_companies`, `job_listings`, `job_profile`, `ai_usage`
- **Job Radar** (`db/021_jobs.sql`): `job_sources` (provider registry +
  `trust_weight`; seeded ATS=90 / Adzuna=70), `job_target_companies` (curated,
  UI-editable ATS allowlist, UNIQUE(ats, slug), seeded with one example),
  `job_listings` (normalized + deduped on `content_hash` UNIQUE; `trust_score` /
  `legitimacy` / `fit_score` / `fit_rationale` / `embedding vector(1024)` [added
  defensively behind the db/014 `pg_available_extensions` guard] / `status`
  new|saved|applied|dismissed; HNSW cosine index), `job_profile` (single row:
  resume/preferences + `profile_embedding`). `ai_usage` (entry_type / model /
  tokens / `cost_cents`) is the AI-cost-cap ledger; `user_settings` gains
  `ai_model_job_fit` (default haiku), `job_radar_enabled` (default false), and
  `ai_monthly_budget_cents`.
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
    re-embedded each sync. An empty-body source records an `embed_state` row with
    `chunk_count = 0` (not just a chunk delete) so the hash-skip engages for it
    too instead of re-clearing every sync (K5).
  - `user_settings.ai_model_rag` (default sonnet) + `vault_enabled` /
    `vault_repo` / `vault_branch` / `vault_last_sha` / `vault_last_synced_at` /
    `vault_last_error`. The vault GitHub token is the `VAULT_GITHUB_TOKEN` env
    var, never a DB column.
  - Chunking is TOKEN-AWARE (RAG v2): budgets in estimated tokens
    (max(words×1.32, chars/4) — no tokenizer dep), cascade heading →
    paragraph → sentence → word so chunks never break mid-word; default 480
    tokens with 60-token word-boundary overlap. `CHUNKING_VERSION` is baked
    into the embed_state content hash, so bumping it (any future chunker
    change) invalidates every hash and forces a clean re-embed on the next
    sync — shipped while the vault was empty, so v2 itself cost nothing.
  - Sync: `services/vault-sync.js` (GitHub Contents/Trees/compare API, no clone;
    frontmatter `embed:false`/`private:true`/`sensitivity:` honored — and
    resolved FAIL-CLOSED (KR-2): trailing ` # comments` are stripped (quote a
    value that must contain " #"), Obsidian block lists (`key:` + `- item`) are
    parsed, yes/no/on/off are understood, the MOST restrictive signal wins, and
    any unrecognized sensitivity/embed/private value resolves to `private`).
    A FULL sync mark-and-sweeps: vault documents/facts whose file is absent
    from the (untruncated, well-formed) tree are removed, so deleted/renamed
    vault files stop being retrieved (KR-1). An incremental sync falls back to
    full when the compare base is gone (404/422, force-push) or GitHub caps the
    diff at 300 files; changing `vault_repo`/`vault_branch` in Settings NULLs
    `vault_last_sha` so the next sync is a full walk + sweep. After deploying a
    parsing/sync change, run one full reindex so existing rows are re-filed. Hourly
    in-process cron + `POST /api/rag/reindex` (also driven by the
    `knowledge-reindex.yml` GitHub Action via `x-api-key`). Embeddings via
    `services/embeddings.js` (Voyage, native fetch). Retrieval is HYBRID (RAG v2):
    vector + keyword legs fused via Reciprocal Rank Fusion (fuseRetrieval,
    dedupe on kind:id) — either leg failing degrades to the other alone.
    Ranking (KR-4): each leg counts once per distinct source (one long document's
    many chunks no longer add up); the vector leg fetches 4× chunks and keeps the
    best one per source; keyword terms drop function-word stopwords ("what",
    "the" — content words like "will"/"may"/"list" are kept) via `searchTerms`,
    shared with the facts query; keyword hits send the passage around the first
    match (`matchingWindow`), not the document's first 1500 characters.
    **Sync lifecycle (Batch 11):** the vault is ingested even without
    Voyage/pgvector (documents + facts; `embeddings: false` in the result) and a
    backfill embeds normal vault documents that have no `embed_state` row once
    embeddings work; an embedding of unchanged text is kept while Voyage is off
    (KR-3). The lock is claimed before the first await (KR-8). Removals run
    first and every file (and every note in syncNotes) is isolated in its own
    try/catch — one failing file no longer aborts the sync; when anything failed
    the result is `{ ok:false, partial:true, failed, failures[] }`, `vault_last_error`
    names the first failure, and neither `vault_last_sha` nor `vault_last_synced_at`
    advances, so the next sync retries the range (KR-7). `vault_last_attempt_at`
    stamps every run (db/023, KR-11). The reindex endpoint still returns 202;
    `/api/rag/status` carries `reindex.ok` (`reindexOutcome`: not_configured /
    not_ready are not failures) and the GitHub Action polls it and goes red on a
    failed reindex. A failing sync raises the `vault_sync_error` reminder.
  - **Citations (Phase 2):** `POST /api/rag/query` answers via the Anthropic
    Citations feature (`ai.answerWithCitations` — each retrieved source is a
    plain-text document block with citations enabled; response flags each
    source `cited:true/false`). Falls back to prompt-cite `callAI` if the
    citations call throws; that answer's inline `[n]` / `[2][3]` / `[1, 4]` markers
    are parsed back into cited sources (`parseInlineCitations`, KR-12), so a
    fallback answer that cites isn't flagged "ungrounded". Citations are incompatible with structured outputs
    (unused here).
  - **Answer cache (Phase 2):** `rag_answer_cache` — exact-match, keyed by
    normalized query + model + a corpus-version stamp (`"<APP_TIMEZONE date>|"` +
    `max(updated_at)` + active row count over notes+documents+facts+fact
    verifications), 24h freshness. The date prefix (KR-5) expires cached answers
    at local midnight so a fact whose `valid_from`/`valid_to` boundary passed
    isn't served from a stale answer; the facts validity filter itself compares
    against that tz date as a `$N::date` parameter (not `CURRENT_DATE`). Vault
    re-syncs no longer churn the version: `upsertVaultDocument` only rewrites a
    row whose title/content/tags/sensitivity/deleted_at changed (`IS DISTINCT
    FROM`), and `upsertFacts` skips the delete + re-insert when a file's fact set
    is unchanged (order-independent `factSetSignature`) — every full reindex used
    to bump `updated_at` on everything and flush the cache twice a day. Auto-invalidates when
    the corpus changes; survives restarts (unlike the in-memory ai.js cache).
    Helpers in `routes/rag.js` swallow errors so a pre-migration/missing table
    degrades to "no cache". Semantic (paraphrase) caching shipped (RAG v2, db/019): rag_answer_cache
    rows carry the query embedding; a paraphrase hits at cosine >= 0.97 with
    the same model + corpus version + TTL. One Voyage call per /query serves
    retrieval AND the cache (embedQuerySafe). Pre-019 / no-pgvector schemas
    degrade to exact-match only. Pruned on every write (KR-13): rows whose
    corpus version isn't current or that are past the 24h TTL are deleted (they
    can never hit again).
  - **Structured facts (Phase 2c):** `facts` — precise, supersedable
    `(entity, attribute, value)` rows with `valid_from`/`valid_to` (NULL = still
    current) and `sensitivity`. Authored as flat frontmatter in vault "fact
    files" (`type: fact`): reserved keys (type/entity/valid_from/valid_to/
    sensitivity/tags/title/embed/private/context) are metadata, every other key
    becomes a fact row; `services/vault-sync.extractFacts` + `upsertFacts`
    replace all facts for a file on each sync. The fact lifecycle is symmetric:
    converting a file prose→fact removes its prior prose document
    (`removeVaultDocument`), and converting fact→prose (dropping `type: fact`)
    clears its prior fact rows (`clearFacts` in the prose branch, K1) — so a
    converted file never leaves orphaned facts being injected as authoritative.
    `POST /api/rag/query` injects the
    matching CURRENT, `normal`-sensitivity facts (`buildFactsQuery` +
    `factsToDocument`) as an authoritative "Known facts (current)" document
    listed first and cited — so precise lookups ("current deductible") don't
    depend on fuzzy vector recall. Browse via `GET /api/rag/facts`. Only the
    active validity window is injected (historical/superseded facts are not
    surfaced in answers).
  - **Cross-app finance grounding (Phase 3):** for finance-flavored questions
    (`looksFinancial` keyword gate), `POST /api/rag/query` pulls a READ-ONLY
    snapshot from Perfin (`perfinFinanceSnapshot` over the shell-wired
    `perfinPool`; INV-25, never an HTTP self-fetch) and injects it as a cited
    "Finances (from Perfin)" source. Net worth, accounts and investments come from
    Perfin's own `getNetWorth` (`teller/services/financial-queries.js`, required
    lazily — no Perfin code → no finance source), so the snapshot matches the
    dashboard: no $0 Plaid brokerage phantom, investment_accounts included, card
    and loan balances shown as "-$X owed" (KR-9). Card limits come from a small
    query; subscriptions are summed as monthly equivalents (amount × 30 /
    cadence_days, Perfin's rule — annual/quarterly ones used to be left out). Only fires on finance queries (non-finance queries never
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
    until set. Unique paths mean it's always a create. A Sensitivity choice
    (normal / private / secret) on the capture form is written as
    `sensitivity:` frontmatter, and a private/secret capture is NEVER sent to the
    AI for structuring — it is committed as a raw note/fact (KR-10). Fields the
    model returns can't write reserved keys (`type`, `sensitivity`, `embed`,
    `private`, `valid_*`, …), so they can't turn a fact into a note or relax its
    sensitivity. Kicks a background
    syncVault so the capture is searchable soon. Capture box on the Knowledge page.
  - **Proactive surfacing (Phase 3):** `routes/rag.upcomingFacts(pool, days)`
    finds facts with an upcoming date — the validity window ending (`valid_to`)
    or a date-valued attribute (`renew`/`expir`/`due`/`deadline`/…, matched as
    whole snake_case/space segments — "trial_ends" yes, "friends"/"residue" no,
    KR-14). `GET
    /api/notifications/check` includes these as `fact_upcoming` notifications (+
    a count) over a 30-day lookahead; the dashboard browser-notifies the
    imminent ones (≤7 days). Schema-drift safe (errors → no upcoming facts).
    Per-sistant has no email digest (that's Perfin) — the notification check is
    the proactive surface.
  - **Trust/audit (Phase 4):** `POST /api/rag/query` returns `grounded`
    (true/false) — whether the cited-answer actually cited a provided source;
    the Knowledge page shows an "ungrounded — double-check" caution when false.
    Fact verification loop: `fact_verifications` is keyed by CONTENT
    (entity, attribute, value), NOT row id, so a verification survives vault
    re-sync (which replaces fact rows) and resets when the value changes. Facts
    queries expose `verified` via an EXISTS subquery; `factsToDocument`
    annotates verified facts `[verified]`; `POST /api/rag/facts/verify`
    sets/clears it; the Knowledge "Your facts" list has per-fact Verify toggles.
  - **Secret tier (Phase 4):** items flagged `sensitivity: secret` (vault
    frontmatter `sensitivity: secret`, or `embed:false`/`private:true` →
    private) are stored but NEVER embedded and NEVER sent to any AI — the AI
    retrieval builders (`buildRetrievalQuery`, `buildFactsQuery`,
    `perfinFinanceSnapshot`) all require `sensitivity='normal'`. `GET
    /api/rag/secret-lookup` is the only path that surfaces secret items: a pure
    local DB substring match returned verbatim to the user, no model call. UI:
    "Secret lookup" box on the Knowledge page. (Stored in your own Neon DB; the
    tier's guarantee is "never sent to a third-party AI," not "never persisted.")

## Embedded Mode (under the unified shell)
When loaded by `shell/index.js` instead of run standalone, the Per-sistant app
runs as an Express sub-app mounted at `/per-sistant`. Three things change:

- **Signed-webhook exemption (PB-15).** `POST /api/perfin/webhook` is exempt from
  `requireAuth` in standalone mode too (and from the shell's cookie gate at
  `/per-sistant/api/perfin/webhook`): Perfin's HMAC-signed digest POST carries
  no session, and the receiver authenticates it itself (signature over the raw
  body + timestamp replay window, 503 without a secret). It used to 401 every
  delivery on a standalone deployment with SESSION_PIN set. `requireAuth` is
  exported from `middleware.js` for tests.
- **Log Out (PB-21).** The Settings "Log Out" is shown whenever embedded (or
  AUTH_SECRET is set). Embedded, it POSTs the ROOT `/logout` (the shell's
  handler) via `location.origin + '/logout'` — an absolute URL so the fetch
  wrapper doesn't prefix BASE_PATH — then goes to `/login`; standalone it still
  uses `POST /api/logout`.
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
- 11 AI features (Ask and Smart Suggestions each have their own model setting since db/024), each independently configurable: Haiku (fast/cheap), Sonnet (smarter), or Off
- Models: `claude-haiku-5-5`, `claude-sonnet-5-5` (`AI_MODELS` in ai.js — the current model of each line, no date suffix)
- Both models think by default (adaptive thinking; thinking tokens are billed as output and count against `max_tokens`). Every call goes through `sizedParams(maxTokens, effort)`: an explicit `output_config.effort` (`low` for the short assistant features; `medium` for Knowledge Q&A in `answerWithCitations`) and `max_tokens = maxTokens + 2048` thinking headroom (capped 16000; `maxTokens` sizes the REPLY). Text is read by block TYPE (`responseText` — `content[0]` can be a thinking block). A safety decline (`stop_reason: "refusal"`) makes `callAI` / `answerWithCitations` throw a `REFUSAL` error (callers' catch paths report AI unavailable); `callAIWithUsage` returns empty text instead so the spend is still charged.
- Never send `temperature` / `top_p` / `top_k`, an assistant prefill, or a forced `tool_choice` — the 5.5 models reject them (400).
- Features: email drafting, task breakdown, smart quick add, weekly review summary, email tone adjustment, daily briefing, note auto-tagging, smart suggestions, natural language query, **Knowledge Q&A** (`ai_model_rag`, default sonnet — the RAG answer/diagram/capture model), **Job Fit** (`ai_model_job_fit`, default haiku — the Job Radar fit + legitimacy scoring model)
- Configuration stored in `user_settings` table (ai_model_* columns)
- Settings page provides per-feature dropdowns
- **AI cost cap** (introduced by Job Radar, reusable by other features): the
  Job Fit + legitimacy passes are checked-then-charged against a monthly budget.
  `ai.js getAiBudgetCents()` resolves `user_settings.ai_monthly_budget_cents` →
  env `PERSISTENT_AI_BUDGET_CENTS` → default ($1.00); `monthlyAiSpendCents()`
  sums the `ai_usage` ledger for the current month; over-budget → the call
  throws `{ code: "CAP" }` (the pass stops, 429-equivalent). `callAIWithUsage`
  returns token usage so `recordAiUsage()` can charge a row in a `finally`
  (idempotent) when tokens were consumed. The 10 pre-existing AI features still
  use the uncapped `callAI` (unchanged) — the cap is opt-in per call site.
  `estimateCostCents` prices the 5.5 models (`AI_PRICING`, cents per token):
  Haiku 5.5 $0.10 / $0.50 per MTok (a prompt over 100K tokens uses the
  $0.50 / $2.50 card), Sonnet 5.5 $2 / $10; cache reads are charged at 0.1x
  input and cache writes at 1.25x (callAIWithUsage passes the cache counters
  through). `ai_usage.cost_cents` is fixed at write time, so older rows keep the
  price they were charged at.

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
