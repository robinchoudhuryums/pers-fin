---BROAD SCAN IMPLEMENTATION SUMMARY---
Findings implemented:
- PB-4 — a job-profile text change clears the cached profile embedding and the fit scores ranked against it
- PB-5 — trust re-scored for every live listing each refresh (ghost decay applies), fit backfilled for unscored live listings, stale "new" listings dropped, an unscored fit is "verify first", embeds batched and fail-soft per batch
- PB-6 — a 'scam' verdict is hidden; 'suspect' goes to verify-first (never main / top pick)
- PB-7 (+PD-10) — removing an ATS company deactivates it, so the boot seed can't bring it back
- PB-9 — dismissing no longer lowers the whole source's trust; a nudge fires only on a genuine status change
- PB-17 — service worker: an offline write is a 503 (never ok:true), send/refresh/AI/auth/secret writes aren't queued, secret-lookup responses aren't cached, replay keeps 401/408/429/5xx/network failures, drops successes and >24h entries
- PB-19 — Job Radar board fetches (15s) and the keep-alive ping (10s) time out
- PD-5 — todo location fields saved on create (validated) and carried to every next recurring instance (complete, skip, midnight roll)
- PD-6 — automations: only runnable triggers/actions accepted, action_data validated (and per trigger entity), note/email creation and recurring completion fire their rules, each rule isolated
- PD-7 — Ask and Smart Suggestions have their own model settings (db/024; Ask defaults on) with Settings rows
- PD-9 — recipient is exactly one address: EMAIL_REGEX tightened, validated on email PATCH, contacts POST/PATCH, and the scheduled-send cron (marks failed)
- PD-11 — iCal: RFC 5545 escaping, DTSTAMP, all-day DTEND = next day, local DATE getters, 75-octet folding
- PD-12 — trashed blockers no longer block; any-length dependency cycle refused (recursive CTE)
- PD-13 — templates validated like todos (rule, interval, priority, horizon, subtasks); apply is one transaction
- PD-14 — weekly review "overdue" = open tasks due before today (APP_TIMEZONE)
- PUI-3 — no "Undo" after sending email; undo on a recurring completion removes the generated next instance (new POST /api/todos/:id/undo-complete-recurring)
- PUI-4 — Job Radar page: error states, Radar/Saved/Applied/Dismissed views (GET /api/jobs/list) with move-back actions, Refresh disabled while running, failed saves revert/announce, re-score prompt after a profile edit
- PUI-5 — keyboard access (role + tabindex + Enter/Space) on the task/subtask checks, note cards, metric cards, template rows; Esc closes modals; modals become role="dialog" with focus in/restore; habit day toggles carry aria-pressed
- PUI-6 — webhook events validated on PATCH; events/last_status/trigger/action types escaped in Settings
- PUI-7 — only http(s) apply links are ingested and rendered
- PUI-8 — keep-alive controls hidden under the shell with a pointer to Perfin's setting
Files modified:
apps/per-sistant/config.js, helpers.js, server.js, services/keep-alive.js, views/js.js,
routes/{ai,automations,calendar,contacts,emails,jobs,notes,pwa,review,todoTemplates,todos,webhooks}.js,
pages/{dashboard-script,emails,health,jobs,notes,settings,settings-script,today,todos-script-1,todos-script-2}.js,
db/024_ask_suggestion_models.sql (new), tests/scan-sept-batch14.test.js (new),
tests/jobs.test.js, tests/scan-sept-fixes.test.js

CHANGES:
PB-4 | routes/jobs.js, pages/jobs.js | PATCH /api/job-profile: when resume_text/preferences_text is sent, separate fail-soft UPDATEs NULL job_profile.profile_embedding and the fit_score/fit_rationale of new/saved listings; response carries rescore_needed (page says "Refresh to re-score")
PB-5 | routes/jobs.js | STALE_DAYS=14 relative to MAX(last_seen); liveListingIds(); runRefresh trust-passes newIds ∪ live ids and fit-passes newIds ∪ unscored live ids; trust UPDATE keeps a Claude verdict (legitimacy_reasons set); fit pass embeds only `embedding IS NULL` rows in groups of 64 (per-group try/catch) and scores only `fit_score IS NULL` candidates; aggregator requires a non-null fit ≥65 for main and drops stale non-saved rows
PB-6 | routes/jobs.js | aggregator SQL excludes legitimacy='scam'; loop skips scam and routes suspect to verify_first
PB-7 | routes/jobs.js | DELETE /api/job-companies/:id → UPDATE active=false; GET lists active only (POST re-activates)
PB-9 | routes/jobs.js | applyFeedbackToSource(pool, id, status, prevStatus): dismiss delta 0, no-op when unchanged; PATCH /api/jobs/:id returns prev_status via an UPDATE … FROM subquery
PB-17 | routes/pwa.js | cache v8; NO_CACHE/NO_QUEUE path lists (string matching — template literal); offline response 503 {ok:false, offline, queued, error}; only r.ok GETs cached; queue entries carry queued_at; replay keeps retryable failures, drops successes, permanent 4xx and entries >24h; 'synced' posted only when something replayed
PB-19 | routes/jobs.js, services/keep-alive.js | AbortSignal.timeout(15000) on httpJson; 10s on the keep-alive ping
PD-5 | routes/todos.js, helpers.js | parseLocationFields (lat/lng/radius ranges → 400); POST inserts location_*; INSERT_NEXT + rollMissedRecurring carry location_* (appended params)
PD-6 | config.js, helpers.js, routes/automations.js, routes/notes.js, routes/emails.js, routes/todos.js, pages/settings-script.js | VALID_TRIGGERS/ACTIONS drop schedule/send_notification; validateAutomationRule (entity/action fit, required value, priority/horizon enums) on POST and merged PATCH; runAutomations validates and try/catches per rule, matches entity type; note_created/email_created/recurring todo_completed fired; Settings shows the server's error
PD-7 | db/024_ask_suggestion_models.sql, routes/ai.js, pages/settings.js, pages/settings-script.js | new columns (inherit once from daily_briefing; Ask → haiku when the briefing was off), /api/ai/query + smart-suggestions read their own column (and report AI-not-configured), models GET/PATCH + Settings rows
PD-9 | config.js, routes/emails.js, routes/contacts.js, server.js | EMAIL_REGEX excludes , ; < > " ' ( ); PATCH + contacts validate; cron marks an invalid recipient failed and continues
PD-11 | routes/calendar.js | icsEscape/icsFold/icsDate/icsUtc; DTSTAMP on every VEVENT; DTEND next day; exported helpers
PD-12 | routes/todos.js | dependency lists filter t.deleted_at IS NULL; POST uses WITH RECURSIVE reachability (UNION) for cycle refusal
PD-13 | routes/todoTemplates.js | validateTemplateFields (config enums) on POST/PATCH and on apply (legacy rows 400 with the reason); apply in BEGIN/COMMIT via pool.connect
PD-14 | routes/review.js | overdue query uses todayStr() from routes/health
PUI-3 | views/js.js, routes/todos.js, pages/todos-script-2.js, pages/dashboard-script.js, pages/today.js | showUndo 'info' mode (send toasts), 'complete-recurring' undo with next id; undoCompleteRecurringTodo (lock, delete the untouched next instance in the chain created <1 day ago, reopen with streak −1, 409 if changed); callers check r.ok
PUI-4 | pages/jobs.js, routes/jobs.js | rewritten page script (views, errors, actions by status, disabled Refresh, revert toggle); GET /api/jobs/list?status=
PUI-5 | views/js.js, pages/todos-script-1.js, pages/notes.js, pages/health.js, pages/emails.js | roles/tabindex/aria-labels; global keydown (Enter/Space → click on role controls; Esc closes top modal); MutationObserver dialog wiring (role, aria-modal, aria-label, focus in/restore)
PUI-6 | routes/webhooks.js, pages/settings-script.js | validEvents on POST/PATCH; esc() on events/last_status/trigger/action
PUI-7 | routes/jobs.js, pages/jobs.js | isHttpUrl filter at ingest; safeUrl on render
PUI-8 | pages/settings.js | embedded: controls container display:none (kept in the DOM for the script) + note pointing to Perfin

TEST RESULTS: npm test 1647/1647 (Perfin 1025 + Per-sistant 622; 65 files). New apps/per-sistant/tests/scan-sept-batch14.test.js (45 tests; 42 fail on the pre-fix tree — the 3 that pass assert pre-existing behavior, e.g. the db/021 seed form and the bundle parsing). Two test doubles updated for new behavior: jobs.test.js (NULL fit no longer main; dismiss no longer nudges), scan-sept-fixes.test.js (emails router helpers stub gains runAutomations). Real Postgres: both apps' migrations ×2 incl. db/024 (settings row inherits haiku/off); aggregator buckets incl. stale/scam/saved, Claude verdict survives re-score, status PATCH prev_status, profile edit clears fits, seed stays inactive, location on POST + next instance, A→B→C→A refused, trashed blocker unblocks, recurring undo + second-undo refusal, template bad rule 400 / legacy bad subtask 400 / good apply with subtasks, note_created automation tags the note while an invalid legacy rule is skipped, email PATCH list 400, review, ICS DTSTAMP/DTEND. Browser (temporary Playwright spec, removed): Space on a task check completes a recurring task, Undo leaves exactly one open instance; profile modal is role=dialog, focus moves in, Esc closes and returns focus; Jobs views toggle aria-pressed; embedded Settings hides keep-alive; no page errors. All 13 Per-sistant pages (standalone + embedded) render and their 156 inline scripts pass node --check; the emitted views/js.js and sw.js bundles parse.
REGRESSION RISKS:
- Job Radar main bucket now needs a real fit score: installs without Voyage/pgvector or with Job Fit off see every listing under "Verify first" and the notification/briefing "high-fit" line stops firing (intended per PB-5; documented in the page subtitle).
- Fit backfill is still capped at maxFit (12) Claude calls per refresh, so a large unscored backlog drains over several refreshes.
- EMAIL_REGEX is stricter (rejects quotes/parentheses/commas/semicolons/angle brackets): an address with a quoted local part can no longer be saved (also affects contacts CSV import).
- Automations: stored rules with schedule/send_notification triggers/actions or invalid action_data are now skipped (logged) instead of silently ignored; set_* actions on note/email triggers no longer run (they used to rewrite a todo sharing the id).
- Recurring undo approximates the prior streak (streak −1) and does not roll back best_streak / last_streak_date; an already-fired todo_completed webhook isn't undone.
- The global Esc handler removes `active` from the top modal (the tpl-modal is removed) — same effect as a backdrop click; a page with unsaved modal input loses it on Esc as it already did on backdrop click.
- Service worker cache name bumped (v8): clients re-fetch cached pages once.
INVARIANTS AT RISK:
- INV-64 (Job Radar cap) — unchanged path; backfill only adds candidates to the same cappedCall loop. Holds.
- INV-65 (content_hash idempotency) — dedupPersist untouched. Holds.
- INV-66 (aggregator fail-soft, archive-not-delete) — still one try/catch; DELETE of companies now also archives. Holds (strengthened).
- INV-63 (fetch wrapper) — views/js.js edited elsewhere; emitted bundle parses, wrapper untouched. Holds.
- INV-74 (anchor day / missed) — INSERT_NEXT and the roll keep their params; location columns appended. Holds.
- INV-80 (SSRF) — webhook route still validates URLs; only events validation added. Holds.
NET SCORE: production fixes (would fire this month): PB-4 Y, PB-5 Y, PB-6 Y, PB-7 Y, PB-9 Y, PB-17 Y, PB-19 N, PD-5 Y, PD-6 Y, PD-7 Y, PD-9 N, PD-11 Y, PD-12 Y, PD-13 N, PD-14 Y, PUI-3 Y, PUI-4 Y, PUI-5 Y, PUI-6 N, PUI-7 N, PUI-8 Y = 16; new failure modes: 1 (stricter EMAIL_REGEX rejects quoted local parts — documented, accepted) → 16 − 1 = 15

OPERATOR ACTIONS / DEPLOY:
- None required. db/024 auto-migrates (additive, idempotent; existing installs inherit their Smart Suggestions model from the daily briefing and Ask turns on with Haiku if the briefing was off — Ask is user-initiated and uncapped like the other pre-existing features; switch it off in Settings → AI Models if unwanted) | BLOCKS DEPLOY: N
Deploy: Platform, Shell & Auth: Render auto-deploys on push to `main` (alt: `fly deploy`). Sheets & External Export: N/A (not touched).

(Not complete in production until blocking operator actions are done AND
the deploy step is confirmed.)

FOLLOW-ON ITEMS:
- PRE-EXISTING BUG (found by the browser run, not a Batch 14 finding): `apps/per-sistant/routes/calendar.js` takes `advanceRecurrence` from its factory argument, but server.js passes `deps = { pool, config, helpers, views }`, so `GET /api/calendar` 500s ("advanceRecurrence is not a function") whenever an open recurring todo with a due date exists — the Calendar page and the dashboard mini-calendar break. One-line fix (fall back to helpers.advanceRecurrence) + a test mounting the router with the server.js deps shape.
- Job Radar: no explicit "report scam" action (PB-9's other option) and no company-scoped trust signal; a scam report would need a status or table.
- Recurring undo can't restore best_streak / last_streak_date exactly (no prior-value column).
- Notes POST doesn't fire the `note_created` webhook (VALID_WEBHOOK_EVENTS lists it).
- Client: todo form sends `parseFloat(lat) || null`, so a 0 latitude/longitude is dropped.
- Weekly review: open tasks due later THIS week (today..week end) appear in neither overdue nor upcoming (upcoming is next week).
- Other Per-sistant pages still ignore failed writes (dashboard complete-recurring, skip, subtask toggles, bulk) — only the Batch 14 paths check r.ok.
- PB-8, PB-16, PB-18, PB-20 deferred per the batch plan.
DOCUMENTATION UPDATES NEEDED:
- apps/per-sistant/CLAUDE.md: Job Radar (main needs a fit score; verify-first semantics; stale exclusion; re-score every refresh; profile edit clears fit; company remove = deactivate; dismiss no longer nudges; GET /api/jobs/list; page views/errors), Offline Support (503, exclusions, replay rules), Automations (valid triggers/actions, validation, wired triggers), AI features (Ask/Smart Suggestions own models, db/024), recipient validation, iCal export (escaping/DTSTAMP/DTEND), dependencies (trashed, cycles), templates (validation, transactional apply), weekly review overdue, Undo (no send undo; recurring undo endpoint), keyboard/dialog access, keep-alive embedded, location on create/recurrence, Key Files (db/024, batch14 test), counts (622).
- Root CLAUDE.md: test counts (1647 / 65 files, Per-sistant 622), batch14 test description, possibly new invariants (aggregator main requires a fit score + scam hidden; SW never reports a queued write as success; automations validated per rule).
- README: counts + Batch 14 line.
---END BROAD SCAN IMPLEMENTATION SUMMARY---
