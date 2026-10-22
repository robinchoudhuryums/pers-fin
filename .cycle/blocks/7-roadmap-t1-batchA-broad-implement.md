---BROAD SCAN IMPLEMENTATION SUMMARY---
Findings implemented: None (roadmap work, not scan findings)
New capabilities (G/ST): Roadmap T1.4 Batch A —
  A1 in-app error log: every console.error (both apps, the shell, unhandled rejections) is recorded, grouped by fingerprint, shown in Settings → Sync Health → Recent errors with Resolve, raised by data-health, and announced once per new / reopened error (≤5 a day)
  A2 uptime: public GET /health/deep (SELECT 1 on both databases, 3s, cached 60s, yes/no fields only); optional HEARTBEAT_URL pinged every 30 minutes (/fail while a scheduled job's last run failed); Operator Checks info line when unset; runbook Monitoring section
Files modified: teller/services/error-log.js (new), teller/services/uptime.js (new), teller/services/job-health.js, teller/services/database.js, teller/services/operator-checks.js, teller/routes/settings.js, teller/views/settings.ejs, shell/index.js, scripts/reset-fresh.js, deploy/vps/RUNBOOK.md, deploy/vps/app.env.example, tests/roadmap-t1-errors-uptime.test.js (new), tests/contract/error-log.contract.test.js (new), tests/scan-oct-batch17.test.js

CHANGES:
A1 | teller/services/error-log.js | install() wraps console.error (still prints); capture() groups by fingerprint (source app from the caller's frame + first line with numbers / hex ids / quoted values blanked), re-entrancy guarded, never throws, ignore list, ≤100 distinct per minute; flush() batches one UPSERT per fingerprint into app_errors (count, first / last seen, sample stack), reopens a resolved row whose new occurrence is later, re-buffers unwritten entries on a write failure, announces new / reopened errors via sendToAll (≤5 notified in 24h, tag app-error-<fp>, deep link /settings#recent-errors), prunes daily (resolved >30d, any >90d); listErrors / recentUnresolvedCount / resolveError
A1 | teller/services/database.js | app_errors table + last_seen index
A1 | shell/index.js | errorLog.install() before the sub-apps load; errorLog.start({ pool: perfin.pool }) after both apps' migrations; stop + final flush (no notify) on shutdown
A1 | teller/routes/settings.js | GET /api/errors (flushes first; ?all=1 incl. resolved), POST /api/errors/:fingerprint/resolve (400 on a malformed id, 404 unknown); data-health warning "N server error(s) in the last 24 hours" linking /settings#recent-errors
A1 | teller/views/settings.ejs | Sync Health → Recent errors list (source, message, count, first / last seen, Details with the sample, Resolve)
A1 | scripts/reset-fresh.js | app_errors in UNTOUCHED_TABLES (INV-81)
A2 | teller/services/uptime.js | deepHealth / deepHealthHandler (bounded SELECT 1 per pool, null for an unwired pool, single-flight 60s cache, Cache-Control no-store, 503 when down); heartbeatUrl (http(s) only) / pingHeartbeat (<url> or <url>/fail, redirect manual, 10s timeout, never throws) / startHeartbeat (30-minute tick, NOT activity-gated, no database call)
A2 | teller/services/job-health.js | latestOutcomes (kept across flushes) + failingJobs() for the heartbeat
A2 | shell/index.js | GET /health/deep mounted before the auth gate; uptime.startHeartbeat({ failingJobs }) after migrations; stopHeartbeat on shutdown
A2 | teller/services/operator-checks.js | local:heartbeat info check when HEARTBEAT_URL is unset
A2 | deploy/vps/RUNBOOK.md + app.env.example | Monitoring section (uptime monitor on /health/deep on the VPS, shallow /health on Render + Neon; heartbeat; Recent errors); HEARTBEAT_URL in the template
Tests | tests/roadmap-t1-errors-uptime.test.js (19), tests/contract/error-log.contract.test.js (4), tests/scan-oct-batch17.test.js (fully configured env now sets HEARTBEAT_URL)

TEST RESULTS: npm test 1864/1864 (19 new); contract 156/156 (4 new — a mutation keeping a resolved row resolved turns the reopen test red); migrations twice OK; Playwright 57/57 (the Settings click sweep now includes the Recent errors list)
REGRESSION RISKS:
- console.error now also captures a stack per call — negligible cost, errors are rare; the wrapper never throws.
- GET /api/data-health does one error-log flush + one count query per call.
- /health/deep is public: it can reveal only that a database is down (yes/no), and the 60s cache bounds its load.
INVARIANTS AT RISK: None (INV-81 reset-fresh classification and INV-106 bare-catch scan both pass; no workflow touched — INV-103)
NET SCORE: 0 production fixes − 1 new failure mode (benign errors already logged with console.error — e.g. "AI not configured" — now notify; Resolve reopens on the next occurrence, so a recurring benign error can re-announce up to the 5/day cap) = −1

Deviation from the plan: the heartbeat runs on its own 30-minute tick instead of the 6-hourly job watchdog — the watchdog is activity-gated, so it would stop pinging (a false alarm) whenever the user is away. The tick reads in-memory job outcomes only, so it doesn't keep Neon awake.

OPERATOR ACTIONS / DEPLOY:
- Optional: an uptime monitor (UptimeRobot / Better Stack) on https://<host>/health while on Render + Neon, /health/deep after the VPS move | BLOCKS DEPLOY: N
- Optional: HEARTBEAT_URL (healthchecks.io, period 1h, grace 1h) — only on an always-on host or with keep-alive on | BLOCKS DEPLOY: N
Deploy: Platform, Shell & Auth: Render auto-deploys on push to `main` (PR robinchoudhuryums/pers-fin#133). Planned VPS: .github/workflows/deploy-vps.yml once VPS_DEPLOY_ENABLED is true.

(Not complete in production until blocking operator actions are done AND
the deploy step is confirmed.)

FOLLOW-ON ITEMS:
- A "Mute" (ignore permanently) action for a known-benign error, so Resolve isn't the only option for a recurring one; or an ignore pattern editable from Settings.
- Per-sistant's expected "AI not configured" 500s (T1.5 Batch C3) will stop feeding the log once those routes answer 501 without logging.
- Standalone Perfin / Per-sistant (no shell) don't install the wrapper — only the shell deployment records errors.
- Error messages can include merchant or account names; they stay in the app's own database, but the push notification body carries the first 120 characters.

DOCUMENTATION UPDATES NEEDED:
- CLAUDE.md: error-log.js + uptime.js in the services list, app_errors in the Database section, GET /api/errors + resolve + /health/deep in Commands, HEARTBEAT_URL in Environment Variables, the Recent errors list in Sync Health, the heartbeat tick in Scheduled Tasks, test counts, new invariants (recording never throws or recurses; /health/deep exposes yes/no fields only).
- README: monitoring + error log mention; test counts.
---END BROAD SCAN IMPLEMENTATION SUMMARY---
