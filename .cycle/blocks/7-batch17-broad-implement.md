---BROAD SCAN IMPLEMENTATION SUMMARY---
Findings implemented: None (Batch 17 is expansion work — `.cycle/plan-cycle7-expansion.md`)
New capabilities (G/ST):
- G1 (remaining) — the app reads the repository's GitHub Actions state with a read-only token: a disabled or failing backstop workflow, no successful backup in 36h, missing workflow secrets (names only) and a public repository become checks
- ST4 — operator doctor: those checks plus local ones (compromised Teller cert — moved here from data-health, TOKEN_ENCRYPTION_PASSPHRASE, SHELL_PIN length, timezone / push / calendar-feed notes) and the Knowledge index's parse version, shown in Settings → Sync Health, raised in /api/data-health, notified once per change in the failing set
Files modified:
- teller/services/github-ops.js (new), teller/services/operator-checks.js (new)
- teller/routes/settings.js, teller/routes/persistent.js, teller/startup.js, teller/services/database.js, teller/views/settings.ejs
- apps/per-sistant/services/vault-sync.js, apps/per-sistant/db/029_vault_parse_version.sql (new)
- tests: tests/scan-oct-batch17.test.js (new, 16), apps/per-sistant/tests/scan-oct-batch17.test.js (new, 3), tests/contract/operator-checks.contract.test.js (new, 2); test double updated in tests/sync-durability.test.js (the "everything healthy" data-health case now allows the operator info line)

CHANGES:
G1 | github-ops.js | runGithubChecks({ env, fetchImpl, now }): GITHUB_OPS_TOKEN + GITHUB_OPS_REPO (owner/repo); GET-only, 10s timeout, Promise.all over repo / workflows / secrets / last successful db-backup run / latest runs of the six backstops (BACKSTOPS: daily-sync, weekly-reconcile, db-backup critical; knowledge-reindex, keep-alive, job-radar optional). Checks: workflow:<file> (disabled → fail if critical else warn; latest COMPLETED run failed → warn; none → warn; older than max(2×cadence, 6h) → warn), backup:recent (no success ever or >36h → fail), secrets:workflows (missing required names → fail, optional ones noted), repo:visibility (public → warn). Fail-soft: not configured → no calls; 401/404 on the repo → one reason, no checks; any other failure → that check "unknown" with a reason. Errors carry only the HTTP status — never the token or the response body
ST4 | operator-checks.js | getOperatorChecks({ persistentPool, force, cachedOnly }): GitHub part cached 6h + single-flight (cachedOnly never waits — starts a background refresh); localChecks(env) (teller cert fail with the F14 wording, passphrase fail, SHELL_PIN <6 warn when set, APP_TIMEZONE UTC / no VAPID / no CALENDAR_FEED_TOKEN → info); knowledgeCheck(persistentPool) — vault configured and vault_parse_version NULL or < VAULT_PARSE_VERSION → warn "run one full reindex"; omitted without Per-sistant or a vault. toIssues → warning issues tagged source:'operator' (+ one info line when GitHub isn't configured / a warning when it can't authenticate). notifyIfChanged(pool, result, { sendToAll }) — one push (tag operator-checks, /settings#sync-health) per change in the failing-id set stored in user_settings.operator_checks_signature; skipped while any GitHub check is unknown; a failed send keeps the old signature; recovery is silent
ST4 | settings.js | /api/data-health uses getOperatorChecks({ cachedOnly: true, persistentPool: req.app.get('persistentPool') }) in place of the direct cert check, appends toIssues, returns operator_checks; new GET /api/operator-checks (?refresh=1 forces)
ST4 | startup.js, persistent.js | the 6-hour watchdog (activity-gated) refreshes the checks and calls notifyIfChanged; persistent.js exports getEmbeddedPersistentPool() for it
ST4 | database.js | user_settings.operator_checks_signature TEXT
ST4 | settings.ejs | Sync Health: "Operator Checks" row with "Check now" + a sorted list (status dot, detail, fix); the data-health issue list leaves out source:'operator' entries (no duplicate)
ST4 | vault-sync.js, db/029 | VAULT_PARSE_VERSION = 2 (the F132 rules); a successful FULL sync stamps user_settings.vault_parse_version (fail-soft); the result carries `full`

TEST RESULTS: passed — npm test 1792/1792 (+19); contract suite 144/144 (+2, local Postgres without pgvector); migrations run twice cleanly (29 Per-sistant files); Playwright 35/35. Mutation checks: not stamping the parse version, or ignoring a disabled workflow, turns operator-checks.contract red. One pre-existing test (sync-durability "reports ok with no provider issues") asserted zero issues and now sees the operator info line — updated to count non-operator issues (and require info-only), intent unchanged.
REGRESSION RISKS:
- /api/data-health issues now include operator warnings, so the dashboard sync strip shows them too: with a short SHELL_PIN (<6) there is a standing "App PIN length" warning (dismissible per session), and once the GitHub token is set every disabled backstop / missing backup / public repo shows there until fixed. Without the token, only an info line is added (the strip shows warnings only).
- The Knowledge check warns on every existing configured vault until one full reindex runs (intended — Batch 12's pending operator step).
- data-health and the response shape are additive (operator_checks; issue.source / issue.check); the cert issue's text is now prefixed "Teller certificate: ".
INVARIANTS AT RISK: None. INV-25 holds (the Knowledge check reads Per-sistant read-only through the wired pool); INV-36 holds (the stamp runs inside the locked sync); INV-103 holds (no workflow change; the token is never logged or returned); INV-53 gains a monitor rather than a change.
NET SCORE: 0 − 1 = −1 (G1 / ST4 are new capability. New failure mode: a standing dashboard warning for a SHELL_PIN under 6 characters, and GitHub-sourced warnings that persist until the operator acts — noise if the operator chooses to keep, e.g., keep-alive disabled.)

OPERATOR ACTIONS / DEPLOY:
- Create a fine-grained GitHub token for this repo with read-only Actions, Metadata and Secrets permissions; set GITHUB_OPS_TOKEN and GITHUB_OPS_REPO (owner/repo) on Render | BLOCKS DEPLOY: N (without them the GitHub checks read "off")
- Then fix what the list reports (backup secrets + enable Database Backup, re-enable the disabled backstops, make the repo private, run one full Knowledge reindex) | BLOCKS DEPLOY: N
Deploy: Platform, Shell & Auth — Render auto-deploys on push to `main` (Per-sistant db/029 and the Perfin column auto-migrate). No Apps Script change.

(Not complete in production until blocking operator actions are done AND the deploy step is confirmed.)

FOLLOW-ON ITEMS:
- The keep-alive / job-radar / knowledge-reindex workflow checks don't know whether those features are wanted (keep_alive_enabled, job_radar_enabled, vault configured) — a deliberately-off feature still warns when its workflow is disabled.
- Secrets are checked for presence only; a wrong SERVER_URL / API_KEY shows up only as failing runs.
- /api/rag/status and the Knowledge page don't show the parse version; the dashboard strip has no per-check deep link (it goes to Sync Health).
- github.com only (the API base is fixed — no GitHub Enterprise host).
DOCUMENTATION UPDATES NEEDED:
- CLAUDE.md: new files (services/github-ops.js, services/operator-checks.js), GET /api/operator-checks + data-health's operator_checks / issue.source, user_settings.operator_checks_signature, Sync Health card, the watchdog step, env vars GITHUB_OPS_TOKEN / GITHUB_OPS_REPO, Operator state (item 5 "the app cannot see a disabled workflow yet (G1)" → now it can with the token; item 3's one-full-reindex note → surfaced by the Knowledge check), Known Open Issues (G1), new INV (operator checks fail-soft + read-only, token never stored / logged / returned, no secret value requested), counts (1792 tests / 86 files; contract 144).
- apps/per-sistant/CLAUDE.md: db/029 + VAULT_PARSE_VERSION (bump on parsing change), test count 527.
- README: counts.
---END BROAD SCAN IMPLEMENTATION SUMMARY---
