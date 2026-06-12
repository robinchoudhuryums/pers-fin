# .cycle/STATE.md — In-Progress Cycle State

Tracks the *currently running* cycle so work can be resumed across sessions.
Read first by `/cycle-status` and `/cycle-resume`. When a cycle completes, its
results move to `PROJECT_HEALTH.md` + `.cycle/metrics.csv` and this file resets
to the "none in progress" state.

---

## Current Cycle

- **Status:** /broad-scan + /broad-implement (H1/M5/M2/M3/M1 + Tier-1 M6/M4/L2) + /sync-docs; then /targeted-audit+implement of Knowledge/RAG (A1–A4); Detection & Categorization (A1–A4); AI Insights & Audit (A1–A2) — all on branch `claude/sweet-brahmagupta-3uwc4r`; awaiting review/deploy. Tests now 760 (was 745, +15 AIA1 classification cases).

### Broad-scan + broad-implement (June 2026 session, branch `claude/exciting-albattani-ug1gjv`)
Full 3-stage /broad-scan completed (4 subsystem deep-dives + gap-fill on Web UI/A11y,
Export Fidelity, Notification Correctness, Income Classification). Implemented F1-F5:
- **F1** `.github/workflows/db-backup.yml` — nightly pg_dump of both Neon DBs from
  GitHub Actions, AES-256 artifacts, 90-day retention, restore runbook in header.
  README "Backups" section. OPERATOR: set NEON_DATABASE_URL, PERSISTENT_DATABASE_URL,
  BACKUP_ENCRYPTION_PASSPHRASE repo secrets; do one restore drill.
- **F2** database.js — missing TOKEN_ENCRYPTION_PASSPHRASE now fatal at boot
  (ALLOW_MISSING_TOKEN_PASSPHRASE=true escape hatch). Test files set mock passphrase.
- **F3** teller-api.js — boot warning when loaded Teller cert matches the compromised
  fingerprint (d58d1d12...0954) from git history. OPERATOR (still open): rotate cert in
  Teller dashboard, then scrub history (git filter-repo).
- **F4** services/job-health.js + job_runs table + ticks in every startup.js interval +
  6-hourly/post-boot watchdog ("jobs-missed" notification, signature-deduped, 36h+ threshold).
- **F5** notifications.sentRecently(tag, hours) — budget alerts max 1/category/severity/24h.
Tests: 779 pass (764 -> 779, +15 in tests/broad-scan-fixes.test.js).
**Open follow-ons:** F6 Code.gs splits divergence; F7 Per-sistant CSP nonces; F8 notif-panel
a11y + contrast; F9 recurrence_interval CHECK; F10 insights-email escaping audit; docs drift
(test count 745 -> 779 in CLAUDE.md x3 + README) -> /sync-docs.
**Where I left off:** F1-F5 committed + pushed on `claude/exciting-albattani-ug1gjv`; awaiting
review/merge + the three operator actions above.

### Broad-implement F6-F10 + /sync-docs (same session, same branch)
/sync-docs applied (test counts, job_runs, watchdog, backup secrets, fail-fast passphrase,
stale README 663/17 table entry, per-sistant 257->343). Then implemented F6-F10:
- **F6** Code.gs buildDashboard prefers GET /api/spending-summary (canonical splits/
  reimbursed/split_pct numbers) when SERVER_URL set; local sheet aggregation = standalone
  fallback. Dead sortedMonths/sortedCats opts removed. DEPLOY: clasp push + new Apps
  Script version (per Deploy Command).
- **F7** Per-sistant CSP nonce migration (PB-3 closed): nonce in views.basePathMiddleware
  -> res.locals.cspNonce + ALS; helmet scriptSrc nonce directive, 'unsafe-inline' removed;
  nonceAttr() on all inline scripts (views.js x5, 11 pages, routes/auth.js login).
- **F8** Perfin notification a11y (button bell + role=dialog + focus mgmt + keyboard rows +
  toast aria-live + surfaced mark-read failures) + AA contrast tokens (muted 0.70/0.75,
  light teal #336363).
- **F9** recurrence_interval >= 1: todos POST/PATCH validation, db/018 clamp+CHECK
  (todos + todo_templates), advanceRecurrence floor.
- **F10** email renderers audited — already consistently escaped; pinned with behavioral
  hostile-string tests (finding effectively retracted-on-close-read, now regression-proof).
Tests: 796 pass across 26 files. Both waves committed on `claude/exciting-albattani-ug1gjv`.
**Remaining follow-ons:** N+1 goal milestones; unread badge 9+ cap; per-sistant CLAUDE.md
still says script-src carries 'unsafe-inline' (now stale — fixed in parent docs sweep? NO:
update apps/per-sistant/CLAUDE.md Helmet CSP paragraph next /sync-docs); job_runs surface
in /api/data-health (optional).

### Roadmap update + investment-performance implementation (same session, same branch)
Roadmap: DROPPED multi-user + onboarding by operator decision (documented in CLAUDE.md
Priority Next Features with rationale); roadmap #4 (investment performance) IMPLEMENTED:
- services/benchmarks.js + benchmark_prices table — S&P 500 closes from Stooq (keyless),
  lazy fetch, once/day gate, graceful failure (benchmark:null, never errors).
- GET /api/investments/performance-history (months 3-60) — portfolio value series from
  account_balance_snapshots (investment-source + Teller-linked investment types, Plaid
  phantom-twin dedupe same direction as getNetWorth, per-account forward-fill via
  exported buildPortfolioSeries) + benchmark trimmed to window + excess return.
- Dashboard: "Value vs S&P 500" sub-card (3M/6M/12M, dual-line normalized SVG) —
  independent of Plaid holdings; cost-basis Total return row now holdings-gated.
- DESIGN NOTE: value-based point-to-point return (contributions count as growth) — true
  TWR deliberately scoped out (flows not reliably attributable from snapshots alone);
  the contribution-adjusted figure remains /performance's cost-basis return.
Tests: 812 pass across 27 files (+16 tests/investment-performance.test.js).

### TWR/XIRR implementation (same session, same branch)
investment_flows table + classifyPlaidFlow (subtype-driven signs; dividends/cap-gains =
return, not flows) + syncAllPlaidInvestmentFlows (full-window idempotent, wired into
auto-sync + pre-insights + sync-balances chains) + manual flow CRUD
(GET/POST/DELETE /api/investment-flows, plaid rows delete-protected) + computeTWR (daily
chain-linked exact) + computeXIRR (bisection) on performance-history with flow_coverage
scoping {coverage_pct, scope all|partial|none}. Dashboard: TWR/XIRR line + log-flow form
(Plaid accounts excluded from dropdown). Tests: 837 across 28 files (+25
tests/investment-flows.test.js).

### PWA Phase-0 fixes + polish (same session, same branch)
Phase-0 PWA testing surfaced: (1) biometric registration 401'd under the shell —
register endpoints checked Perfin's standalone session, never written when embedded;
fixed with the INV-25 embedded bail (tests pin both guards). (2) VAPID keys were never
generated — operator set all three on Render (resolved, no code). (3) AI budget cap
\$0.512/\$0.50 = documented check-then-charge overshoot, working as designed; added
Settings-tunable cap (user_settings.ai_monthly_budget_cents, getAiBudgetCents() single
resolver, INV-14). (4) PWA polish: pull-to-refresh in both apps' shared JS
(standalone-only, passive, overlay/pyramid/canvas exclusions) + safe-area pass (Perfin
body pads env(safe-area-inset-*) under viewport-fit=cover — the notch collision was
structural, not per-page; shell login/landing same; Per-sistant deliberately untouched,
auto-insets, pinned by test). Native iOS app DEFERRED: no APNs without \$99/yr, web push
doesn't run in native WebViews, free-signing loses notifications vs the PWA.
Tests: 856 across 30 files (+9 budget-cap-webauthn, +10 pwa-polish).

### Native iOS wrapper scaffold (same session, same branch)
mobile/ Capacitor workspace (NOT in root npm workspaces): remote-URL mode at the Render
deployment, iOS project generated + icons from the mask-crop artwork, Teller/Plaid
allowNavigation, offline stub, free-signing runbook + Phase-2 device checklist in
mobile/README.md. PTR gate widened to window.Capacitor. Coexistence design: PWA stays
installed alongside (separate session; web push keeps flowing through the PWA — native
free-signed build has no APNs; notification taps open the PWA). Operator next: on the
Mac — cd mobile && npm install && npx cap sync ios && npx cap open ios, personal-team
signing, run on device. Tests: 859 across 30 files (+3 scaffold pins).

### UI polish round 2 (field-testing feedback, same branch)
Opaque floating chrome (--surface-solid token; toasts/notif-panel/nav-drawer were 3-10%
alpha — content bled through, screenshot-confirmed). Recent Transactions removed from
dashboard → Activity page is the surface: mobile filters collapse behind a toggle,
rows use new txn-compact 2-line grid (~3x density vs responsive-cards). Dashboard:
4 sections collapsible (localStorage-persisted), Spending by Category month selector
backed by new GET /api/spending-categories (getCategorySpendingForMonth). Updated 2
stale cycle-fixes pins that encoded the old layout. Tests: 870 across 31 files
(+11 ui-polish).

### Login default + icon particle transition (same branch)
Post-login default → /per-sistant (DEFAULT_POST_LOGIN in shell auth.js; landing still at
/; safeReturnTo open-redirect guard unchanged, fallback destination updated incl. the
biometric path in login.ejs — sync-durability pins updated). transition.js rewritten
around a canvas particle engine: samples the PWA icon img into ~3k colored particles,
assemble 950ms → shimmer 280ms → burst 520ms → navigate; prefers-reduced-motion =
instant nav; CSS-mask-reveal kept as fallback. Tests: 874 across 31 files.

### Ops & alerts batch (broad-implement round 3, same branch)
1) CI migration test: ci.yml 'migrations' job (pgvector/pgvector:pg16 service container)
runs both apps' migrations twice via scripts/ci-migration-test.js; pools honor
PGSSLMODE=disable (CI-only escape hatch). 2) Out-of-process scheduling: daily-sync.yml
+= sync-balances + net-worth snapshot; new weekly-reconcile.yml (Teller 90d, Sundays).
3) RAG v2: hybrid retrieval (RRF fuseRetrieval, INV-29 text updated) + semantic answer
cache (db/019 query_embedding, cosine>=0.97, INV-32 updated); token-aware chunking
DEFERRED (full re-embed churn vs marginal gain). 4) Critical-alert emails (opt-in
critical_alert_emails_enabled; budget-exceeded shares 24h dedup; anomaly = one summary
email/run, never holds watermark) + bill-calendar .ics (buildBillCalendarIcs + shell
public /calendar.ics gated on new CALENDAR_FEED_TOKEN env — the one sanctioned query
credential). 5) Small fry: badge 99+, integer-cent split sum, milestone N+1 removed,
data-health jobs[] surface. Tests: 901 across 33 files (+27).
OPERATOR (new): optionally set CALENDAR_FEED_TOKEN (long random) to enable the calendar
feed; subscribe iOS Calendar to https://<host>/calendar.ics?token=<token>.
**Where I left off:** everything committed + pushed on `claude/exciting-albattani-ug1gjv`.
Remaining my-court items: custom income keywords UI only.

### Chunking + splits + browser smokes (broad-implement round 4, same branch)
1) Token-aware chunking SHIPPED (vault empty = zero re-embed cost): estimated-token
budgets (max(words×1.32, chars/4)), heading→paragraph→sentence→word cascade (no
mid-word slicing), CHUNKING_VERSION salts the embed_state hash so future chunker
changes auto-re-embed. 2) Route splits (interface-preserving, helpers re-exported BY
IDENTITY): investments.js 2153→1649 (+ routes/investment-performance.js 503 + shared
services/plaid-client.js); insights.js 1622→1376 (+ routes/insights-email.js 264).
3) Playwright smokes: e2e/ harness (boot-server.js scratch DBs → shell boot), 8 specs
(login wrong/right incl. /per-sistant default, both apps' pages, feed gate), CI 'e2e'
job, npm run test:e2e (kept out of npm test). REAL local verification: started the
sandbox's Postgres 16 — scripts/ci-migration-test.js passed clean (both apps × 2, all
19 per-sistant migrations, keyword-degraded path), and the harness booted the full
shell with every smoke flow verified over HTTP. Chromium itself couldn't download
(sandbox CDN allowlist) — browser layer executes in CI. Tests: 911 across 33 files.

### Final route splits (round 5, same branch) — user merging after this
enrollments.js 1555→992 (+ routes/spending-analytics.js 589: the six read-only
aggregation endpoints); subscriptions.js 1510→1069 (+ routes/transactions.js 467:
per-transaction search/list/duplicates/csv-overlap/PATCH/splits/DELETE). Mount-based,
paths unchanged, helper exports stayed put; 2 stale pins relocated. BONUS REAL BUG
found by the live e2e boot: /api/income-summary 500'd ('column reference name is
ambiguous' — INCOME_PREDICATE unqualified outer refs × linked_accounts JOIN); fixed
via INCOME_PREDICATE_T t.-qualified derivation (insights' t2-rewrite convention),
live-verified 200. All moved endpoints live-verified against a real boot. Subsystem
lists updated (spending-analytics → Financial Analytics; transactions → Detection &
Categorization). Tests: 915 across 33 files.
### Post-merge features (round 6, same branch — new PR needed)
FIRE/runway projections: services/projections.js (pure math: FIRE number = annual spend
× 100/SWR, geometric monthly compounding, 40-yr series; runway w/ growth), GET
/api/fire-projection (completed-month averages, fire_* settings w/ PATCH bounds), Goals
page card (stats + SVG + inline assumptions). Ask Perfin NL Q&A: routes/ask.js — Claude
tool use over 7 read-only tools bound to shared helpers (numbers match dashboard;
parameterized only, injection-tested), bounded loop, shared AI cap (429) + entry_type=
'ask' usage row; dashboard widget (key 'ask'). Caught my own alias bug in test
(total_spend not total_spent). Live-verified: fire 200 graceful-empty, ask 501-gated,
both UI surfaces render. Tests: 934 across 34 files (+19).
DECISION RECORDED: health/habits tracker → expand Per-sistant (streaks/analytics/
notifications already there), extract to third sub-app only if it outgrows a page.
### Health/habits tracker built (round 7, same branch)
Implemented per the decision: db/020_health.sql (habits, habit_logs UNIQUE(habit_id,
log_date), health_metrics UNIQUE(metric, recorded_on)); routes/health.js (CRUD + log
upsert + summary/heatmap/metrics; READ-TIME streaks — computeStreaks/isDueOn pure +
exported, INV-19 attach-after-factory; DELETE archives, never hard-deletes; future-date
400; streak_milestone webhook at 7/30/100/365); pages/health.js (/health: today list w/
quantity steppers, clickable 7-day backfill grid, 90-day heatmap, measurements + SVG
trend; backtick-free page JS, nonceAttr, zero inline handlers); NAV + heart icon;
notification check gained habit_streak_at_risk + habits_due counts (fail-soft .catch);
AI daily briefing gained habits line (fail-soft). gatherHealthSummary is the ONE
aggregator shared by page/notifications/briefing. Live-verified on scratch PG16:
migration fresh + idempotent (2nd boot "20 files"), streak build 0→2→3 incl. backfill
repair, quantity 5/8 not-met → 8 met, future 400, metrics upsert+lowercase, heatmap,
notification counts, archive/restore. Tests: 963 across 35 files (+29 in
apps/per-sistant/tests/health.test.js). Docs synced (both CLAUDE.mds, both READMEs,
roadmap → Shipped).

**PRIOR MERGE DONE; this round needs a fresh merge** —  (pre-merge: confirm
TOKEN_ENCRYPTION_PASSPHRASE in Render; watch the first CI run's 3 jobs). Operator items unchanged (merge w/ passphrase check, backup secrets+drill,
cert rotation, clasp push, VAPID done).
**Where I left off:** everything committed + pushed on `claude/exciting-albattani-ug1gjv`
(F1-F10 + docs + investment performance + TWR/XIRR); awaiting review/merge + operator actions
(Render passphrase check BLOCKS DEPLOY; backup secrets; cert rotation; clasp push for
Code.gs F6). Remaining follow-ons unchanged otherwise.

### AI Insights & Audit targeted cycle (this session)
Audited; 3 findings (1 Medium AIA1, 2 Low AIA2/AIA3). Implemented A1–A2, deferred A3:
- **A1 (AIA1)** ai-audit.js: Tier-1 dollar-claim arithmetic now SKIPS claims whose context signals a non-current-month window (annual / multi-month / YTD / projected / average — `CROSS_PERIOD_RE`), since the only per-category + subscription actuals it has are this-month. Stops false-positive CRITICAL findings (audit-alert notification spam + deflated audit_accuracy%) on annualized advice. this-month/unqualified claims still checked. Exported `CROSS_PERIOD_RE` + added 15 classification tests.
- **A2 (AIA2)** insights.js /api/insights/rebuild: moved the `entry_type='rebuild'` usage-row INSERT to immediately after the Claude call — BEFORE the tool-block validation early-returns and the summary UPDATE — so a rebuild that truncates/fails-validation (previously 500'd before the insert) still records its already-incurred spend against the shared monthly cap. Failure now logged loudly.
- **Deferred:** A3 (AIA3 — empty insight_text row reaches the feed when the model returns neither tool nor text block; cosmetic, rare with tool_choice forced).

### Seams audit (this session) — COMPLETE, clean
Audited the cross-subsystem boundaries. No Critical/High/Medium. Verified OK:
webhook event shape (in-process deliverDigestInProcess + HTTP receiver insert
identical emails columns + identical recipient resolution; status CHECK allows
draft/scheduled); perfinPool read contract (all linked_accounts/detected_subscriptions
columns rag.js + the Perfin widget assume exist today, INV-35); productivity-context
(todos/emails/notes/weekly_reviews columns exist; standalone fallback unwraps /api/review
shape); embedded-auth + pool wiring (no HTTP self-fetch except documented standalone
fallbacks + the test event, INV-25); settings↔shell idle-cache (shellAuthInvalidator
wired callback, sanitizeBoolMap + bounds, SN-5).
Findings:
- **SEAM-1 (Low, doc/impl drift — FIXED this session):** CLAUDE.md said enrollments.js/insights.js hold "inline copies" of SPLIT_AMOUNT; they actually IMPORT it from financial-queries.js and template-interpolate (safe `.replace` alias transforms), so they can't drift. Only sheets-sync.js (byte-matching) + Apps Script Code.gs (stale fork, broad-scan L1) are true copies. Corrected the Shared-Account-Spending-Split doc section.
- **SEAM-2 (Low, accepted):** cross-app perfinPool reads + the Perfin widget swallow ALL errors (→ null / connected:false), so a FUTURE Perfin column rename degrades silently. Documented INV-35 posture; intentional. No action.

### Platform, Shell & Auth targeted cycle (this session)
Audited the full subsystem (shell/index.js, auth.js, webauthn.js, server.js, startup.js, database.js, keep-alive.js, reset-fresh.js). Strong shape — 0 Critical/High/Medium, 4 Low. Implemented A1–A2, deferred A3/A4:
- **A1 (PSA1)** database.js: version-gated the detection-key orphan cleanup (bumped SCHEMA_VERSION 2→3; wrapped the two UPDATEs in `if (currentVersion < 3)`) so it runs ONCE instead of every boot — stops the recurring rare false-deactivation (two distinct merchants sharing a raw name, one renamed) and makes "one-shot" true. schema_migrations now gates one step (was observability-only).
- **A2 (PSA2)** shell/webauthn.js: pinned `requireUserVerification: true` on verifyAuthenticationResponse. NOTE: @simplewebauthn/server v11 ALREADY defaults this to true (verified in node_modules), so this is a defense-in-depth PIN against a future SDK-default flip, NOT a live-vuln fix — the audit finding overstated it.
- **Deferred:** A3 (reset-fresh CASCADE FK-topology guard — latent), A4 (shell shutdown doesn't stop sub-app cron — cosmetic).
- Tests 760, 0 fail.

### Settings, Notifications & Cross-app targeted cycle (this session)
Audited settings.js, notifications.js, persistent.js + the cross-app seam. Mostly clean — 0 Critical/High, 1 Medium, 2 Low. Implemented A1–A2, deferred A3/A4:
- **A1 (SETT1, Medium)** settings.js: `/api/export` (transaction CSV) and `/api/export/tax-report` (CSV + summary) now quote-escape EVERY interpolated text field (account, institution, category in the txn export; category, deduction_type, summary-category in the tax report). Previously only merchant/notes were escaped, so a `"` in the others silently misaligned the CSV columns.
- **A2 (SETT2, Low)** settings.js: `data-freshness` `stale` boolean uses `age >= STALE_SEC` so it agrees with `level==="stale"` at the exact 24h boundary (was `>`, off by a 1-second window).
- **Deferred:** A3 (CSV formula-injection prefix-guard `= + - @` — single-operator own-data, low priority), A4 (log inside cross-app read catch so a future Perfin schema rename isn't fully silent — accepted INV-35 posture / SEAM-2).
- Tests 760, 0 fail. notifications.js + persistent.js (SSO/productivity-context/webhook) verified clean; cross-app contracts confirmed by the seams audit.

### Per-sistant Web UI targeted cycle (this session)
Audited views.js + views/*.js + pages/*.js (XSS-sink scan). Cross-module follow-on from Knowledge/RAG CLOSED: renderMd escapes &<> first → safe backstop. Severity recalibrated from the scan's 3 Medium → 5 Low: CSP `script-src-attr:'none'` (confirmed via helmet defaults) blocks inline-handler execution + no javascript:-href sink, so the escaping gaps are correctness/defense-in-depth, not live XSS. Implemented A1–A2, deferred A3:
- **A1 (PWUI1-4)** added `escAttr()` (encodes & < > " ') to views/js.js; used it for the `title=`/`<option value=` attribute contexts (todos-script-1.js:40,46,86-87,89) and added `esc()` to the option text + automation condition key/value (settings-script.js:161). esc() alone can't neutralize the `"` breakout in attribute context.
- **A2 (PWUI5)** middleware.js: explicitly pinned `scriptSrcAttr: ["'none'"]` so the inline-handler block doesn't depend on helmet's implicit default (effective header unchanged — was already 'none' via default).
- **Deferred:** A3 (remove `'unsafe-inline'` from script-src via per-request-nonce migration — the real PB-3 fix, L effort).
- Tests 760, 0 fail. Emitted client JS bodies verified to parse.

### Per-sistant Backend targeted cycle (this session)
Audited server.js, ai.js, config.js, db.js, errors.js, helpers.js, middleware.js, keep-alive.js, db/*.sql, routes/* (excl. rag/perfin/webhooks). Heavily hardened — 1 Medium, 4 Low. Implemented A1–A2, deferred A3/A4/A5:
- **A1 (PSB1, Medium)** db.js: flipped `ssl.rejectUnauthorized` false→true so the Neon TLS cert is verified (was MITM-exposed; inconsistent with Perfin which already verifies). Deploy-sensitive but Perfin connects to Neon with verification successfully → strong evidence the cert is trusted.
- **A2 (PSB2, Low)** helpers.js: `sendWebhook` now re-validates the URL via isValidWebhookUrl at SEND time (mirrors sendSlackNotification) — closes the SSRF defense-in-depth gap + matches the documented invariant.
- **Deferred:** A3 (config.js IPv6-mapped SSRF regex misses ::ffff:192.168./172.16-31. — single-operator), A4 (integer-:id guards + bulk/import element validation — robustness, parameterized so no security risk), A5 (recurring streak on-time UTC-boundary tz edge).
- Tests 760, 0 fail. Verified clean: PS-1/2/11, PB-1/2/4/5, constant-time auth, CSRF+sameSite:lax, AI model resolution (whitelisted, no stale opus), no SQLi.

### Sheets & External Export targeted cycle (this session)
Audited sheets-sync.js, retention-cleanup.sql, Code.gs. 3 Low. Implemented A1–A3, deferred A4:
- **A1 (SX2-email)** Code.gs: added `escapeHtml_` + escaped a.service/a.detail/u.service/u.date in the subscription-alert email HTML. Requires a separate clasp/Apps Script deploy.
- **A2 (SX1)** retention-cleanup.sql + subscriptions.js POST /api/cleanup + api.test.js: bumped retention 18mo→36mo (must be ≥ the longest analytical window — detection 36mo / seasonal 24mo — so cleanup doesn't silently truncate them; size-safe ~18k rows). Fixed the stale n8n header in the reference SQL. Kept the reference SQL + live endpoint in lockstep.
- **A3 (SX3)** tests/audit-regressions.test.js: new source-pinned `pin()` block asserting sheets-sync's inlined NOT_TRANSFER / INCOME include+exclude keywords / SPLIT_AMOUNT CASE byte-match financial-queries.js canonical (4 pins, all green → confirms no current drift).
- **Deferred:** A4 (Code.gs standalone CSV path: rowIndex dedup-ID / filename-first detection / loose WF — recommend DEPRECATE the standalone path, header already steers to "Sync from Server", rather than perpetually port).
- Tests 764 (+4), 0 fail.

### Rotation status — COMPLETE
Every non-frozen subsystem audited+implemented this cycle: Bank Sync, Financial Analytics, broad pass, Knowledge/RAG, Detection & Categorization, AI Insights & Audit (+seams audit), Platform/Shell & Auth, Settings/Notifications/Cross-app, Per-sistant Web UI, Per-sistant Backend, Sheets & External Export. (Web UI (Perfin) was covered by the broad-scan Web UI agent; not given a standalone targeted cycle.) Frozen excluded: plaid/server.js, n8n-workflows. Next: run `/reflect` to record metrics + promote candidate invariants, and a Health Synthesis; consider a fresh `/broad-scan` next cycle. Open PR: none (all on branch claude/sweet-brahmagupta-3uwc4r).

### Doc drift to sync (NEXT /sync-docs)
- Per-sistant CLAUDE.md Webhooks line — DONE (commit 3a5c45d). No outstanding doc drift from the Sheets cycle (no doc stated the 18-month window).

### Doc drift to sync (NEXT /sync-docs)
- Per-sistant CLAUDE.md "Helmet CSP" feature line says `script-src-attr` "defaults to 'none' (via helmet)" — now set EXPLICITLY (A2/PWUI5). Optionally note `escAttr()` as the attribute-context escaper alongside the PS-4 renderMd note.

### Doc drift to sync (NEXT /sync-docs)
- CLAUDE.md Database section says "schema_migrations ... recorded for observability only; it does not gate any migration logic today" AND the "Detection-key migration window" section says the cleanup "runs on every startup" — both now STALE after A1 (the cleanup is version-gated to run once via `currentVersion < 3`). Correct both.
- Optionally note A2's `requireUserVerification: true` pin in the WebAuthn/biometric section.

### Detection & Categorization targeted cycle (this session)
Audited; 7 findings, all Low (3 prior broad-scan items here — M1 LIKE-escaping, M2 cap-escape, L2 CSV balance match — already fixed earlier this cycle). Implemented A1–A4, deferred A5/A6:
- **A1 (DC1)** detect-subscriptions.js: `"bp "` → `"bp"` so the gas-station exclusion word-boundary-matches `BP` instead of substring-matching `"bp "` mid-word.
- **A2 (DC2)** detect-subscriptions.js: header comment "last 12 months" → "36 months" (matches the query window).
- **A3 (DC3)** categorize.js: the three IMPLICIT rule-creation paths (review, accuracy-review, from-transaction) no longer overwrite `match_type` on conflict — they reactivate the existing rule but keep its match semantics. The EXPLICIT `POST /api/categorization-rules` (where the user deliberately chooses match_type) is intentionally unchanged.
- **A4 (DC6)** subscriptions.js: split-sum validation now compares integer cents (`round(x*100)`) — honors the documented "within $0.01" exactly AND is float-safe (replaces the `> 0.011` FP padding).
- **Deferred:** A5 (DC5/DC4 — Schwab parser return NaN not 0 on no-valid-amount; needs a CapOne CSV sample to settle the both-columns-0.00 case), A6 (DC7 — stale `MODEL_MAP.opus` → claude-opus-4-6; belongs to the AI Insights model-config cycle).

### Rotation status
Cycles done: 1 Bank Sync, 2 Financial Analytics, + broad pass, + Knowledge/RAG, + Detection & Categorization. Next per rotation: AI Insights & Audit (4). Seams audit is due after this (every 3 subsystem cycles).

### Knowledge / RAG targeted cycle (this session)
Audited Knowledge/RAG; 6 findings (1 Medium, 5 Low). Implemented A1–A4, deferred A5/A6:
- **A1 (K1, Medium)** vault-sync.js syncVault prose branch: `await clearFacts(pool, path)` so a fact-file→prose conversion drops orphaned facts that were still being injected into answers (asymmetry with prose→fact, which already cleared the doc).
- **A2 (K2, Low)** rag.js upcomingFacts: `value::date` → `to_date(value,'YYYY-MM-DD')` so one date-shaped-but-invalid fact value (e.g. 2025-02-30) can't throw and silently disable ALL upcoming-fact notifications.
- **A3 (K4, Low)** vault-sync.js syncNotes: now holds the `_syncing` single-flight lock (busy→no-op) so the hourly cron's notes phase and a concurrent reindex can't overlap-embed. Strengthens INV-36 (previously the notes leg was unlocked).
- **A4 (K5, Low)** vault-sync.js embedSource: empty-body sources now upsert `embed_state` (chunk_count 0) instead of just clearSource, so the content-hash skip engages instead of re-clearing every sync.
- **Deferred:** A5 (K3 — parse inline [n] in the Citations fallback so `grounded` isn't always false on that path), A6 (K6 — allow capture into private/secret tier). Plus cross-module follow-on: verify Per-sistant's shared `renderMd` escapes raw HTML (not just link schemes) since the Knowledge answer renders via `renderMd` into innerHTML under a CSP that still has `script-src 'unsafe-inline'` (PB-3).
- **Phase:** implemented — not yet Health-Synthesized (broad-scan Axis-A scores recorded in the session report, not yet promoted to PROJECT_HEALTH.md).
- **Subsystem audited:** broad pass across all subsystems (cycle 3, broad). Prior: Bank Sync (cycle 1), Financial Analytics (cycle 2).
- **Started:** 2026-06-09
- **Findings gathered (broad scan):** H1 (High — getNetWorth dedup direction drops Plaid brokerage value), M1–M6 + ~15 Low. Top-5: H1, M5, M2, M3, M1.
- **Implementation progress (this session):** H1, M5, M2, M3, M1 committed + pushed (commit f871cef); docs synced (92c080c); then Tier-1 follow-up M6, M4, L2 implemented + tested (745 pass, 0 fail).

### Findings implemented this session
- **H1** `getNetWorth` (financial-queries.js): flipped dedup direction — drop the $0 Plaid `linked_accounts` phantom when an active `investment_accounts` row exists; `investment_accounts` is authoritative (matches /api/investments + dashboard grid). Updated the two cycle-fixes.test.js getNetWorth mocks (they routed on a bare `/investment_accounts/` substring that now also matches the linked query's NOT EXISTS subquery — routed on `FROM linked_accounts` instead).
- **M5** budget-snapshot auto-trigger (startup.js): removed the `getDate()===1` gate so a missed prior-month snapshot is caught up on any later tick (idempotent via the existing-snapshot short-circuit). Fixes silent rollover loss on free-tier sleep.
- **M2** categorize AI loop (categorize.js): a swallowed usage-row INSERT no longer lets spend escape the cap — on insert failure we apply the already-paid batch, then stop the loop (`budgetHit=true`).
- **M3** sheets buildDashboard (sheets-sync.js): budget-join category expression now matches the SPENDING BY CATEGORY query (adds `personal_finance_category->>'primary'`), so the budget tab's "Spent" agrees with the breakdown on the same sheet.
- **M1** categorization-rule LIKE (categorize.js, both runCategorize + /apply): escape `\ % _` in user patterns with `REPLACE(...) ESCAPE '\'` so a `%`/`_` in a pattern can't act as a wildcard. exact (`=`) unchanged.

### Tier 1 follow-up implemented (this session, after the H1/M5/M2/M3/M1 batch)
- **M6** shell/index.js: added a `verify` hook to the shell's `express.json` so `req.rawBody` is captured under the unified shell — the embedded Per-sistant webhook receiver now HMAC-verifies the exact signed bytes instead of falling back to re-stringifying `req.body`.
- **M4** scripts/sheets-sync.js: `buildDashboard` now routes the three per-category queries (categorySummary, categoryByMonth, budgetData) through a splits-aware `cat_lines` CTE (parent_no_splits ∪ from_splits) mirroring getCategorySpendingForMonth, so per-category Sheets totals match the app for users who split transactions. Total queries (monthlySummary, totals) + topMerchants intentionally left parent-keyed.
- **L2** teller/routes/subscriptions.js: CSV-import balance auto-update now matches the user's manual account by EXACT institution name OR EXACT account label (was a `name LIKE '%institution%'` substring that could overwrite the wrong account).

### Still deferred (in broad-scan report)
- L1 (Apps Script Code.gs stale fork), L3 (split tolerance 0.011), L4 (detection-key cleanup runs every boot / "one-shot" comment), L5 ($0 CSV skip), L6 (ephemeral SESSION_SECRET, embedded-irrelevant), L7 (syncNotes outside _syncing lock), L8 (empty-doc embed_state), L9 (return_to on requireAuth redirect). Plus Tier-3 effectiveness/completeness items.

### Next concrete step
- Review + deploy (Render auto-deploys on merge to `main`). Then `/sync-docs` to fix CLAUDE.md's getNetWorth Key Design Decision (it documents the OLD/wrong dedup direction). Optionally `/reflect` to record broad-scan metrics + a candidate invariant for the net-worth dedup direction.

### Decisions made this cycle (cycle 2 — Financial Analytics)
- **A1/F1** liability set = `type IN ('credit','loan')` (Plaid's two debt types cover all loan subtypes); return shape of `getNetWorth` unchanged so its 3 snapshot writers + dashboard + context-export need no caller changes.
- **A2/F2** extracted `deriveGoalProgress()` shared by GET /api/goals + context-export to kill the parallel-source-of-truth drift (was an inline duplicate).
- **A4/F4** trend scoped to the latest entry's score_type; added `score_type` to the trend object (additive).

### Decisions made cycle 1 (Bank Sync & Ingestion)

### Decisions made this cycle
- **BS-1** judged advisable despite Teller's default `count` being undocumented:
  the fix is page-size-independent (paginate until empty page / floor), so it is
  correct under any default. Sets `count=500` (documented Teller param) to bound
  round-trips; MAX_PAGES=100 runaway guard.
- **BS-2** Schwab Amount-column sign assumed negative=debit (parity with the
  Chase format + this format's Withdrawal→positive mapping). One-line flip if a
  real Schwab Amount export proves the opposite convention.
- **BS-4** Plaid cursor (INV-04) + xmax counting (INV-01) pinned via
  source-pinned tests rather than live-client behavioral tests
  (`syncPlaidItemTransactions` is not exported; behavioral would need a
  module-surface change out of scope).

### Residual / follow-on
- BS-1 MAX_PAGES break advances the watermark even if a >50k-txn account wasn't
  fully paged (warns to console). Beyond single-operator scale; revisit only if
  the warn ever fires.
- BS-1 depends on Teller accepting `count=500` (documented param; standard
  clamp expected). Watch the first post-deploy Teller sync.

## Where I left off
Cycle 2 (Financial Analytics) A1–A5 implemented on `claude/pensive-davinci-JhKFb`;
tests green at 666. Cycle 1 (Bank Sync, BS-1..BS-8) is in open PR #108. No cycle
work outstanding — next is `/reflect` (promote INV-27, record cycle-2 metrics)
then rotate to Detection & Categorization.

---

## Rotation Plan

1. ~~Bank Sync & Ingestion~~ ✅ audited + fixed (cycle 1)
2. ~~Financial Analytics~~ ✅ audited + fixed (cycle 2)
3. **Detection & Categorization**  ← recommended next
4. AI Insights & Audit
5. Platform, Shell & Auth
6. Settings, Notifications & Cross-app
7. Sheets & External Export
8. Web UI (Perfin)
9. Per-sistant Backend
10. Per-sistant Web UI

- **Seams audit:** every 3 subsystem cycles.
- **Subsystem cycles since last Seams audit:** 0 (June 2026 Seams & Invariants audit COMPLETE — see record below).
- **Last subsystem audited:** Sheets & External Export
- **Cycles completed:** rotation complete this session (broad-scan + 8 targeted + 1 seams); reflect recorded (cycle 3, net +4); Health Synthesis still pending.

### Seams & Invariants audit #2 (June 2026, round 8 — counter reset to 0)
Scope: all documented seams + the seams NEW since audit #1 (4 route-file splits,
ask.js cap seam, health.js→notifications/briefing, webauthn transports contract,
critical_alert event, whats-new↔daily-digest, job-health name map). 14 invariants
code-read-verified (INV-02/03/04/06/08/12/14/17/18/21/23/26/27/33/36): ALL PASS.
Route splits: all 4 structurally sound (mounts, no duplicate paths, identity
re-exports resolve, INV-19 ordering, no require cycles). Cross-app contracts:
email-insert columns/status/recipient-chain identical across in-process + HTTP
paths; rag.js perfinPool columns all exist; widget fallback unwraps the real
shape; productivity-context columns exist; cross-pool wiring null-checked.
Findings (all FIXED this session):
- **SEAMS-1 (Medium):** Per-sistant's HTTP webhook receiver didn't recognize
  `critical_alert` (Perfin's EMAIL_EVENTS sends it) — standalone deployments
  200-and-dropped critical alert emails; embedded in-process path unaffected.
  Added to the receiver condition + fallbackSubject + sendNameByEvent.
- **SEAMS-2 (Low, drift):** cash-flow (spending-analytics.js ×4 sites incl. the
  yoy splits-CTE pair) and insights.js anomaly+seasonal (×7 sites) held LITERAL
  copies of the SPLIT_AMOUNT CASE while CLAUDE.md claimed "cannot drift" (seams
  audit #1's SEAM-1 under-counted). All converted to `${SPLIT_AMOUNT}` +
  in-place derivations (new SPLIT_AMOUNT_2 = la2./t2. rewrite). Live-verified:
  cash-flow/yoy/summary 200 against real PG; anomaly+seasonal SQL EXPLAIN-valid.
- **SEAMS-3 (Trivial):** getAiBudgetCents comment named 3 cap sharers; now 4
  (added /api/ask). Settlement FILTER buckets confirmed NOT copies (by design).
New pins: tests/seams-audit.test.js — repo-wide literal-CASE scan (fails on any
future re-inlining) + EMAIL_EVENTS↔receiver symmetry (every sender event must be
accepted + named by the receiver). Tests: 971 across 36 files (+4).
