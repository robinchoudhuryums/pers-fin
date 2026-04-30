# Per-sistant

Personal assistant tool for task management, email scheduling, and note-taking. Companion app to **[Perfin](https://github.com/robinchoudhuryums/pers-fin)** (personal finance tracker) — same design system, cross-linked navigation.

## Architecture

```
┌──────────────────┐     ┌──────────────────┐     ┌──────────────────┐
│   Browser (PWA)  │────>│  Express Server  │────>│  Claude API      │
│  Tasks / Emails  │     │  (port 3001)     │     │  (9 AI features) │
│  Notes / Calendar│     └────────┬─────────┘     └──────────────────┘
│  Analytics       │              │
└──────────────────┘     ┌────────┴────────┐
                         │ Neon PostgreSQL  │
                         │  (todos, emails, │
                         │   notes, etc.)   │
                         └────────┬────────┘
                                  │
                  ┌───────────────┼───────────────┐
                  │               │               │
         ┌────────┴────────┐  ┌──┴───────┐  ┌────┴──────┐
         │    node-cron    │  │  SMTP    │  │ Webhooks  │
         │ (email + tasks) │  │  Server  │  │ / Slack   │
         └─────────────────┘  └──────────┘  └───────────┘
```

## Features

### To-Do Lists
- **Three horizons**: Short-term, medium-term, long-term
- **Four priorities**: Low, medium, high, urgent
- **Categories**: Preset categories (work, personal, health, finance, errands, home, learning) + custom categories with dropdown selector
- **Due dates**: With overdue detection and visual indicators
- **Filters**: By horizon, status (pending/completed), priority, and category
- **Drag-and-drop**: Reorder tasks by dragging
- **Natural language Quick Add**: Type "Buy groceries tomorrow urgent" and it auto-detects priority, horizon, and due date (AI-enhanced when enabled)

### Recurring Tasks
- **Eight recurrence rules**: Daily, weekly, monthly, yearly, weekdays, custom_days, custom_weeks, custom_months
- **Custom intervals**: "Every 3 days", "every 2 weeks", "every 6 months" via configurable interval
- **Auto-generation**: When a recurring task is completed, the next instance is automatically created
- **Skip**: Skip a recurring instance without breaking your streak
- **Snooze**: Push a task's due date to a later date
- **Streak tracking**: Current and best streaks tracked per recurring task with on-time detection
- **Daily processor**: Cron job at midnight handles overdue recurring tasks

### Subtasks
- **Checklists**: Add subtasks within any todo
- **AI Task Breakdown**: Click "AI Breakdown" to auto-generate subtasks from a task title
- **Progress tracking**: Visual progress bar showing completion percentage
- **Inline management**: Add, check off, and delete subtasks without leaving the todo view

### Email Drafting & Scheduling
- **Compose**: Full email editor with recipient, subject, body
- **Schedule**: Set a specific date/time for automatic sending
- **Quick Send**: Natural language input — *"Send an email to Mom Tuesday morning at 9AM about dinner plans"*
- **AI Drafting**: Claude-powered email composition — describe what you want and AI writes the email
- **AI Tone Adjustment**: One-click rewrite — make any email more formal, casual, shorter, friendlier, or more direct
- **Email Templates**: Save and reuse common email formats
- **Contact lookup**: Type a name, auto-fills the email address
- **SMTP**: Sends via any SMTP provider (Gmail, Outlook, etc.)
- **Scheduler**: Checks every minute for due scheduled emails

### Notes
- **Quick notes**: Title + content, color-coded cards
- **Markdown support**: Bold, italic, lists, checkboxes, links, quotes, headings
- **Pin important notes**: Pinned notes stay at the top
- **Colors**: Default, warm, teal, green, blue
- **Tags**: Add tags manually or use AI auto-tagging to suggest tags based on content
- **Reminders**: Optional datetime reminders on notes
- **Create todo from note**: Convert a note into a task with automatic cross-entity linking

### Contacts
- **Name→email mapping**: For quick email addressing
- **Lookup API**: Used by email composer and Quick Send
- **Environment contacts**: Set `CONTACTS` env var for static contacts
- **CSV import**: Bulk import contacts from a CSV file (name,email format)

### Dashboard
- **Overview cards**: Task counts, email stats, note totals
- **Customizable layout**: Drag-to-reorder widgets, show/hide individual widgets
- **Task overview tabs**: All / By Category / By Urgency / Due Soon views
- **AI Daily Briefing**: AI-generated summary of your day's priorities and schedule
- **AI Smart Suggestions**: AI-powered productivity coaching based on priorities, due dates, and streaks
- **AI Natural Language Query**: Ask questions about your data ("what did I do last week?")
- **Notification center**: Browser notifications for due tasks, overdue items, and streak-at-risk alerts
- **Upcoming tasks**: Next due items at a glance
- **Scheduled emails**: Pending sends
- **Global search**: Search across all todos, emails, and notes
- **Perfin widget**: Shows subscription data from linked Perfin instance
- **Inline actions**: Complete tasks and send emails directly from the dashboard

### Calendar View
- **Monthly calendar**: Visual overview of all events
- **Recurring projections**: Future recurring task instances shown as dashed entries
- **Color-coded**: Tasks, emails, and notes shown with distinct colors
- **Navigate**: Browse months with previous/next controls

### Weekly Review
- **Stats cards**: Tasks completed, created, emails sent, notes added
- **AI Weekly Summary**: AI-generated narrative of your week's accomplishments and what needs attention
- **Completed tasks list**: What you accomplished this week
- **Overdue items**: Tasks needing attention
- **Upcoming**: What's coming next week

### Cross-Entity Links
- **Link anything**: Connect todos, emails, and notes to each other
- **Create todo from note/email**: One-click conversion with automatic linking
- **Bidirectional**: Links show on both sides of the relationship

### Analytics & Insights Dashboard
- **Productivity score**: Weighted composite score (completion rate, streaks, volume, speed)
- **Completion trends**: Visual bar charts of tasks completed over time
- **Activity heatmap**: GitHub-style 90-day activity heatmap
- **Productivity by day**: See which days of the week you're most productive
- **Priority breakdown**: Distribution of tasks across priority levels
- **Category breakdown**: How your work splits across categories
- **Period filters**: View analytics for the past week, month, quarter, or year
- **Emails sent / notes created**: Tracked per period
- **CSS-rendered charts**: No external charting library needed

### Webhooks & Integrations
- **Webhook CRUD**: Create, test, enable/disable webhooks in Settings
- **Event subscriptions**: Subscribe to todo_created, todo_completed, email_sent, note_created events
- **Custom headers**: Set auth headers for webhook endpoints
- **Test webhooks**: Send test payloads from Settings
- **Slack integration**: Incoming webhook URL for Slack notifications on key events

### Notification System
- **Browser push notifications**: For due tasks, overdue items, and streak-at-risk alerts
- **Notification preferences**: Toggle notifications per category in Settings
- **Real-time checks**: Dashboard polls for pending notifications on load

### Task Dependencies
- **Blocking/blocked-by**: Define relationships between tasks
- **Circular dependency prevention**: Server validates dependency chains
- **Visual indicators**: See blocked/blocking status on task cards

### Automations / Rules Engine
- **Trigger→action rules**: e.g., "when task created with category=work, set priority=high"
- **Configurable in Settings**: Create, enable/disable, delete rules

### File Attachments
- **Upload files**: Up to 10MB per file on tasks, emails, and notes
- **Download/delete**: Manage attachments per entity

### Offline Support
- **Service worker**: Caches pages and API responses
- **Mutation queue**: Queues changes for sync when back online
- **Offline banner**: Visual indicator when disconnected

### Voice Input
- **Web Speech API**: Microphone button on Quick Add and notes (Chrome/Edge)

### Todo Templates
- **Save task structures**: Create reusable templates from existing tasks (with subtasks)
- **Apply templates**: One-click task creation from saved templates
- **Template management**: Create, browse, and delete templates from the todos page

### Quick Actions from Search
- **Complete tasks**: Mark tasks done directly from search results
- **Send emails**: Send scheduled emails from search results
- **Pin/unpin notes**: Toggle note pins from search results

### Undo for More Actions
- **Undo complete**: Revert task completion
- **Undo send**: Revert sent email to draft status
- **Undo delete**: Restore deleted items from trash (existing)

### Health Check & Monitoring
- **`/api/health`**: Returns server status, uptime, memory usage, DB connectivity (no auth required)

### Location-Based Reminders
- **Geofencing**: Set location (name + coordinates + radius) on tasks
- **Periodic checking**: Browser-based geofence monitoring with notifications

### Dashboard Visuals
- **Animated bonsai tree**: Isometric cherry blossom tree with energy pulse trunk, moss on branches, and falling petal animations
- **Haku dragon**: Sleeping dragon beside the bonsai tree (converted from PNG reference to SVG paths) with breathing animation, zzz indicators, and streak-based golden glow
- **SVG mountain landscape**: Multi-layered parallax background with mountain peaks, rolling hills, tree line, and foreground ridge (dark/light theme variants)
- **Floating particles**: CSS-animated cherry blossom petals and light particles

### AI Features (9 total)
All AI features are optional and independently configurable. Choose **Haiku** (fast, ~$0.0003/call), **Sonnet** (smarter, ~$0.002/call), or **Off** for each feature in Settings.

| Feature | Description | Default |
|---------|-------------|---------|
| Email Drafting | Compose emails from a prompt | Haiku |
| Task Breakdown | Auto-generate subtasks from task title | Haiku |
| Smart Quick Add | AI-parse natural language into structured tasks | Off |
| Weekly Review Summary | Narrative summary of your week | Haiku |
| Email Tone Adjustment | Rewrite emails (formal/casual/shorter/etc.) | Haiku |
| Daily Briefing | Dashboard summary of today's priorities | Off |
| Note Auto-Tagging | Suggest tags for notes based on content | Off |
| Smart Suggestions | AI productivity coaching based on your tasks | Off |
| Natural Language Query | Ask questions about your data in plain English | Off |

### Authentication
Two login modes — set one in your environment variables:
- **`SESSION_PASSWORD`** — text password, shows a standard password input
- **`SESSION_PIN`** — numeric PIN, shows a PIN pad with dot indicators

Sessions expire after a configurable timeout (default 15 minutes, adjustable in Settings).

### Dark/Light Theme
Toggle between Night Mode (default) and Day Mode in Settings. Identical to Perfin's theme system.

### Keyboard Shortcuts
- **n** — New todo
- **e** — New email
- **/** — Focus search
- **t** — Go to Todos
- **d** — Go to Dashboard
- **?** — Show shortcuts reference (in Settings)

### Browser Notifications
Optional push notifications for task reminders. Enable in Settings.

### Perfin Integration
- Set `PERFIN_URL` to add a **Perfin** link in the navigation bar
- Dashboard widget shows subscription data from Perfin
- Both apps share the same design language and color palette

### Mobile App (PWA)
Installable as a home screen icon:
- **iPhone**: Open in Safari → Share → "Add to Home Screen"
- **Android**: Chrome → Menu → "Install app"
- **Mobile-optimized**: Bottom navigation bar, hamburger menu, swipe between pages, floating action button
- **Offline support**: Service worker caches pages and API responses, queues mutations for sync

### Security
- **Helmet CSP**: Content Security Policy with strict directives — all inline event handlers eliminated via event delegation pattern (`bindEvents()`/`onDelegate()`), enabling `script-src-attr: 'none'`
- **CSRF protection**: State-changing requests require `X-Requested-With` header or JSON/multipart content-type; auto-injected by client-side fetch wrapper
- **Postgres-backed sessions**: `connect-pg-simple` stores sessions in the database (survives restarts/deploys), auto-creates session table, prunes expired sessions every 15 minutes
- **Constant-time auth**: `crypto.timingSafeEqual` for password and PIN comparison
- **PIN length obfuscation**: PIN pad displays fixed 8-dot indicator regardless of actual PIN length
- **Rate limiting**: General (200/15min), auth (10/15min), AI (20/min) rate limiters
- **Secure cookies**: httpOnly, sameSite=lax, secure in production

### Keep-Alive
- **Self-ping**: 14-minute interval pings `/api/health` to prevent Render free tier from sleeping

## Setup

### 1. Environment

```bash
cp .env.example .env
# Fill in your Neon DB URL, auth, and SMTP credentials
```

### 2. Run Locally

```bash
npm install && node server.js
# Open http://localhost:3001
```

The server runs **auto-migration on startup** — all required tables are created automatically.

### 3. Deployment

**Render (free):** See `render.yaml` — set env vars in dashboard.

**Fly.io (~$2/mo):**
```bash
fly launch --name per-sistant
fly secrets set NEON_DATABASE_URL="postgres://..."
fly secrets set SESSION_PASSWORD="..."
fly deploy
```

**Docker:**
```bash
docker compose up --build
```

## Running Tests

```bash
npm test
```

181 tests across 52 suites covering: time parsing, input validation, data structures, sorting, security, CSRF protection, recurring tasks, custom recurrence intervals, skip/snooze, subtasks, email templates, natural language parsing, global search, calendar, weekly review, drag-and-drop, keyboard shortcuts, AI model selection, AI task breakdown, AI tone adjustment, todo categories, note tags, dashboard views, task dependencies, streaks, bulk actions, trash/undo, automations, attachments, location reminders, cross-entity links, webhooks, Slack integration, notifications, analytics, productivity score, heatmap, todo templates, batch contact import, quick search actions, undo actions, calendar projections, pagination, health check, rate limiting, and AI API optimization.

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/` | Dashboard |
| `GET` | `/todos` | To-do list page |
| `GET` | `/emails` | Email management page |
| `GET` | `/notes` | Notes page |
| `GET` | `/contacts` | Contact management page |
| `GET` | `/settings` | Settings page |
| `GET` | `/calendar` | Calendar view |
| `GET` | `/review` | Weekly review page |
| `GET` | `/analytics` | Analytics & insights dashboard |
| `GET` | `/login` | Authentication |
| `GET` | `/api/todos` | List todos (query: horizon, priority, completed, category) |
| `POST` | `/api/todos` | Create todo |
| `PATCH` | `/api/todos/:id` | Update todo |
| `DELETE` | `/api/todos/:id` | Delete todo |
| `POST` | `/api/todos/reorder` | Reorder todos (drag-and-drop) |
| `POST` | `/api/todos/:id/complete-recurring` | Complete recurring task & create next |
| `POST` | `/api/todos/:id/skip-recurring` | Skip recurring instance (preserves streak) |
| `POST` | `/api/todos/:id/snooze` | Snooze task to a later date |
| `GET` | `/api/todos/:id/dependencies` | Get task dependencies |
| `POST` | `/api/todos/:id/dependencies` | Add task dependency |
| `DELETE` | `/api/dependencies/:id` | Remove dependency |
| `GET` | `/api/streaks` | Get streak stats for recurring tasks |
| `GET` | `/api/emails` | List emails (query: status) |
| `POST` | `/api/emails` | Create email |
| `PATCH` | `/api/emails/:id` | Update email |
| `DELETE` | `/api/emails/:id` | Delete email |
| `POST` | `/api/emails/:id/send` | Send email now |
| `GET` | `/api/notes` | List notes |
| `POST` | `/api/notes` | Create note |
| `PATCH` | `/api/notes/:id` | Update note |
| `DELETE` | `/api/notes/:id` | Delete note |
| `GET` | `/api/contacts` | List contacts |
| `POST` | `/api/contacts` | Add contact |
| `PATCH` | `/api/contacts/:id` | Update contact |
| `DELETE` | `/api/contacts/:id` | Delete contact |
| `GET` | `/api/contacts/lookup/:name` | Lookup contact by name |
| `GET` | `/api/settings` | Get settings |
| `PATCH` | `/api/settings` | Update settings |
| `GET` | `/api/stats` | Dashboard statistics |
| `GET` | `/api/subtasks/:todoId` | List subtasks for a todo |
| `POST` | `/api/subtasks/:todoId` | Create subtask |
| `PATCH` | `/api/subtasks/:id` | Update subtask |
| `DELETE` | `/api/subtasks/:id` | Delete subtask |
| `GET` | `/api/email-templates` | List email templates |
| `POST` | `/api/email-templates` | Create template |
| `PUT` | `/api/email-templates/:id` | Update template |
| `DELETE` | `/api/email-templates/:id` | Delete template |
| `GET` | `/api/todo-categories` | List all categories (defaults + custom) |
| `GET` | `/api/todo-templates` | List todo templates |
| `POST` | `/api/todo-templates` | Create todo template |
| `PATCH` | `/api/todo-templates/:id` | Update todo template |
| `DELETE` | `/api/todo-templates/:id` | Delete todo template |
| `POST` | `/api/todo-templates/:id/apply` | Create todo from template |
| `POST` | `/api/contacts/import` | Batch import contacts (JSON array) |
| `GET` | `/api/health` | Health check (no auth required) |
| `GET` | `/api/trash` | List all trashed items |
| `POST` | `/api/trash/:type/:id/restore` | Restore item from trash |
| `DELETE` | `/api/trash/:type/:id` | Permanently delete trashed item |
| `POST` | `/api/bulk/todos` | Bulk action on todos |
| `POST` | `/api/bulk/emails` | Bulk action on emails |
| `POST` | `/api/bulk/notes` | Bulk action on notes |
| `GET` | `/api/links/:type/:id` | Get cross-entity links |
| `POST` | `/api/links` | Create cross-entity link |
| `DELETE` | `/api/links/:id` | Delete cross-entity link |
| `POST` | `/api/notes/:id/create-todo` | Create todo from note |
| `POST` | `/api/emails/:id/create-todo` | Create todo from email |
| `GET` | `/api/webhooks` | List webhooks |
| `POST` | `/api/webhooks` | Create webhook |
| `PATCH` | `/api/webhooks/:id` | Update webhook |
| `DELETE` | `/api/webhooks/:id` | Delete webhook |
| `POST` | `/api/webhooks/:id/test` | Test webhook |
| `GET` | `/api/automations` | List automation rules |
| `POST` | `/api/automations` | Create automation rule |
| `PATCH` | `/api/automations/:id` | Update automation rule |
| `DELETE` | `/api/automations/:id` | Delete automation rule |
| `GET` | `/api/attachments/:type/:id` | List attachments for entity |
| `POST` | `/api/attachments/:type/:id` | Upload file attachment |
| `DELETE` | `/api/attachments/:id` | Delete attachment |
| `GET` | `/api/notifications/check` | Check pending notifications |
| `GET` | `/api/analytics` | Analytics data (query: period) |
| `GET` | `/api/calendar.ics` | iCal export |
| `POST` | `/api/ai/draft-email` | AI-powered email drafting |
| `POST` | `/api/ai/task-breakdown` | Generate subtasks from task title |
| `POST` | `/api/ai/parse-todo` | Parse natural language into structured todo |
| `POST` | `/api/ai/review-summary` | Generate weekly review narrative |
| `POST` | `/api/ai/adjust-tone` | Rewrite email in different tone |
| `GET` | `/api/ai/daily-briefing` | Generate daily task briefing |
| `POST` | `/api/ai/suggest-tags` | Suggest tags for note content |
| `GET` | `/api/ai/smart-suggestions` | AI productivity coaching |
| `POST` | `/api/ai/query` | Natural language data query |
| `GET` | `/api/ai/models` | Get per-feature model preferences |
| `PATCH` | `/api/ai/models` | Update per-feature model preferences |
| `GET` | `/api/search` | Global search (query: q) |
| `GET` | `/api/calendar` | Calendar events (query: month, year) |
| `GET` | `/api/review` | Weekly review stats |
| `GET` | `/api/perfin/stats` | Proxy to Perfin API |

## Environment Variables

| Variable | Description |
|----------|-------------|
| `NEON_DATABASE_URL` | Neon PostgreSQL connection string |
| `SESSION_PASSWORD` | Text password for login (optional) |
| `SESSION_PIN` | Numeric PIN for PIN pad login (optional) |
| `SESSION_SECRET` | Session cookie secret (auto-generated if not set) |
| `SMTP_HOST` | SMTP server hostname |
| `SMTP_PORT` | SMTP port (default: 587) |
| `SMTP_USER` | SMTP username |
| `SMTP_PASS` | SMTP password |
| `SMTP_FROM` | From email address |
| `CONTACTS` | JSON map of name→email |
| `ANTHROPIC_API_KEY` | Claude API key for all 9 AI features (optional) |
| `PERFIN_URL` | URL to linked Perfin instance |
