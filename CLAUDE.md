# CLAUDE.md — Project Context for Claude Code

## Project Overview
Single Node process that hosts two related personal tools behind one PIN gate:

- **Perfin** — finance tracker. Detects recurring charges, compares spending to
  benchmarks, tracks financial goals, runs AI-powered insights via Claude. Uses
  **Teller API** for bank links via mTLS, plus Plaid for investment holdings
  and transaction syncing for banks Teller doesn't cover (Capital One,
  Discover, Schwab, etc.).
- **Per-sistant** — personal assistant. Tasks, scheduled emails, notes,
  calendar, AI daily briefing, a **health/habits tracker** (read-time streaks,
  7-day grid + heatmap, measurements; nudges via the notification check and
  daily briefing), and a **personal Knowledge base** — RAG over an
  Obsidian vault (pgvector semantic retrieval): source-cited Q&A, structured
  facts with temporal validity, Mermaid diagrams, capture-to-vault, a
  never-sent-to-AI "secret" tier, and cross-app finance grounding from Perfin.

A `shell/` Express app authenticates the user with `SHELL_PIN` (successful
login lands directly in Per-sistant — the tile-picker landing is still served
at `/` but skipped as the default destination, `DEFAULT_POST_LOGIN` in
shell/middleware/auth.js), and mounts each sub-app under its own URL prefix:
`/perfin/*` → `teller/server.js`, `/per-sistant/*` → `apps/per-sistant/server.js`.
Each sub-app keeps its own database, routes, and migrations; the shell just
owns the listener, the auth gate, and the cross-app navigation. Sub-apps
detect they're running embedded via `req.app.get("embedded")` and skip their
own auth checks. Each can still boot standalone for local debug
(`npm run start:perfin`, `npm run start:persistent`).

See README.md for the full unified-shell architecture diagram and rationale.

## Architecture (Modular)
The Perfin sub-app is split into focused modules under `teller/`:

```
teller/
  server.js              — Bootstrap, middleware, auth, route mounting, scheduled tasks
                           (insights auto-trigger, net worth snapshots, budget alerts,
                           goal milestones, Sheets auto-sync)
  data/
    reference-data.js    — Static lookup tables: electricity rates, ZIP→state, spending
                           benchmarks, cancel URLs, category rules, AI model
                           tiers (MODEL_MAP → the 5.5 models) + per-model-ID
                           prices (MODEL_RATES_BY_ID / modelRates — previous
                           models kept so stored usage rows re-price; Haiku 5.5
                           long-prompt card above 100K),
                           insight module definitions
    csv-formats.js       — CSV format detection (Chase card, Chase checking, CapOne,
                           Discover, WF, Schwab, generic)
                           + parseMoney() money normalization (strips $ / thousands
                           separators, handles parenthesized negatives, a trailing
                           minus "45.00-" and CR/DR suffixes — CR → negative, DR →
                           positive in the debit-positive convention (BSI-16) — NaN
                           on blank). chase_checking ("Details, Posting Date, …,
                           Amount, Type, Balance") reads the Posting Date and negates
                           the signed Amount; Type is not used as a category.
                           Used by EVERY bank-format parser incl. Schwab + generic (F6)
                           so a "(45.00)" row is imported as -45, not silently skipped.
                           Schwab's Amount+Type variant preserves the signed amount
                           (negate to debit-positive — BS-2), not Math.abs. WF detection
                           requires the first field to look like a date + the second to
                           parse as money so an arbitrary 5-col CSV isn't parsed with WF's
                           positional columns (BS-3). The GENERIC parser takes
                           opts.positiveMeans ('charges' default / 'deposits' —
                           negated) and guessGenericSign(rows) reads a file's sign
                           (inflow keywords, else a negative majority → deposits);
                           known formats keep their fixed sign (cycle-7 F26).
  services/
    database.js          — Postgres pool + transactional auto-migrations with schema versioning
    teller-api.js        — mTLS HTTP client for Teller API (retry with exponential backoff;
                           5xx/network AND 429 — Retry-After honored, capped 10s).
                           tellerCertStatus() reads the configured cert without
                           throwing or touching the network (cached) and reports
                           whether it is the compromised one from git history —
                           raised as a data-health issue + logged at boot (F14) —
                           and its expiry (expires_at, certExpiresAt — X509 validTo,
                           null when unreadable; cycle-8 E4a)
    plaid-client.js      — Plaid client factory (shared by investments.js +
                           investment-performance.js so the two route modules
                           don't need a circular require)
    keep-alive.js        — Self-ping to prevent Render free tier sleep (with fetch timeout)
    job-health.js        — Scheduled-job heartbeats + missed-job watchdog. Every
                           startup.js job calls tick(name) BEFORE its activity
                           gate, and since cycle-8 E2b the job runner ticks each
                           watched job on every 5-minute check (in-memory only —
                           preserves the Neon idle-gate); JOB_INTERVALS_MS is the
                           one copy of the jobs' cadences (the runner registers
                           from it);
                           the watchdog flushes ticks to job_runs and pushes a
                           signature-deduped "Scheduled jobs missed" notification
                           when any job hasn't ticked for 36h+ (process asleep
                           with keep-alive off, crash loops). A job whose body
                           ran also reports result(name, {ok, error}) — stored
                           as job_runs.last_status / last_error (cycle-7 F8: the
                           status used to be hard-coded 'ok'). flush() writes
                           only jobs with a new tick or outcome; GET
                           /api/data-health flushes before it reads, so a user
                           back from time away doesn't see every job "stale"
    job-runner.js        — Due-based job runner (cycle-8 E2a / E2b, ST1 — every
                           startup.js job runs through it, see Scheduled Tasks):
                           createJobRunner({ pool, … }) → register({ name, everyMs,
                           run, when? }) / start / stop / check / list. The first
                           check (1 min after start) reads the registered jobs'
                           job_runs.last_ran_at once (a failed read → every job
                           due); every 5-minute check after is in memory — no
                           query unless a job is due. Due jobs run one at a time,
                           oldest-due first, 20 s apart; checks never overlap. A
                           run is claimed with a conditional UPSERT of last_ran_at
                           (≥ 90% of the cadence old), so two processes run a due
                           job once; a failed claim runs it anyway. A when() gate
                           (e.g. isUserActive) is checked in memory before the
                           claim — closed → no query, the job stays due. list()
                           reports { name, everyMs, gated }
    txn-watermark.js     — Transaction id watermarks with an overlap rescan (cycle-8
                           E2c, ST3) for the "what's new since the last check" reads
                           (runAnomalyCheck, runPaydayLanded): readMark(db) → { id:
                           MAX(transactions.id) (0 when empty), at: now() } as text,
                           read BEFORE the candidates; windowSql({ alias, watermark,
                           since, mark, overlapHours = 24 }) → id <= mark AND (id >
                           watermark OR created_at > since − overlap) + inOverlap (id
                           <= watermark) — an id is allocated at INSERT, so a
                           transaction open at the last check can commit a LOWER id
                           later; the overlap is measured from the PREVIOUS check's
                           time; the caller drops overlap rows it already announced
                           (notification_log). advanceSql(idCol, atCol) moves both
                           forward only (GREATEST). Replaced F1's pg_stat_activity-
                           bounded created_at mark
    github-ops.js        — Read-only GitHub Actions checks (cycle-7 G1):
                           runGithubChecks over GITHUB_OPS_TOKEN + GITHUB_OPS_REPO —
                           each backstop workflow's state + latest COMPLETED run
                           (BACKSTOPS: daily-sync / weekly-reconcile / db-backup
                           critical, knowledge-reindex / keep-alive / job-radar
                           optional), the last successful db-backup run (≤36h),
                           workflow secret NAMES, repo visibility. GET-only, 10s
                           timeout, fail-soft ("unknown" + reason; a 401 / 404 on
                           the repo = one reason, no checks); errors carry only
                           the HTTP status, never the token or a response body
    webhook-verify.js    — Bank webhook signatures (roadmap T2.1, W2):
                           createPlaidVerifier — the Plaid-Verification ES256
                           JWT (alg must be ES256; key by kid via
                           webhookVerificationKeyGet, cached 24h, an expired_at
                           key refused; iat within 5 min, 1 min skew ahead;
                           request_body_sha256 = SHA-256 of req.rawBody; dedupe
                           key "jwt:" + hash of the token — Plaid events carry no
                           id and SYNC_UPDATES_AVAILABLE bodies repeat). Cycle-8
                           F3: the kid must match [A-Za-z0-9_-]{1,128}; iat and
                           the body hash are checked BEFORE any key lookup (the
                           signature after); a kid Plaid has no key for (a null
                           key or a 4xx) is cached as a miss for an hour
                           (KEY_MISS_CACHE_MS); at most KEY_FETCH_LIMIT (20)
                           uncached lookups reach Plaid an hour per process —
                           over it a cached key still verifies; one lookup in
                           flight per kid; the cache holds ≤200 kids.
                           createTellerVerifier — "t=…,v1=…" HMAC-SHA256 over
                           "<t>.<raw body>" against every TELLER_WEBHOOK_SECRET
                           (comma-separated, for rotation), digest compares,
                           t within 5 min; dedupe key "evt:" + event id (or the
                           signature hash). Configured = Plaid credentials set /
                           a Teller secret set. The Teller format is from its
                           docs as remembered — re-check before switching it on.
                           A Plaid event also carries error.error_code as
                           event.error_code (W4 — the ITEM / ERROR code; nothing
                           else of the error object); a Teller event carries
                           payload.reason and the DISTINCT account ids of
                           payload.transactions (≤50) — never the transactions (W5)
    webhook-status.js    — Bank webhook visibility (roadmap T2.1 W6):
                           getWebhookStatus(pool, { env }) reads webhook_events per
                           provider (last event + status, 24h count + failures —
                           never a body), the Plaid registration (GOOD items +
                           investments-only Items whose webhook_url starts with
                           hosting.webhookBaseUrl and ends /api/webhooks/plaid) and
                           the non-suspended Teller enrollment count; fail-soft
                           (error: true). webhookChecks(status) → the operator checks
                           webhooks:plaid (info while PUBLIC_URL is unset, WARN while
                           a connection isn't registered at it, info after 7 quiet
                           days, else ok) and webhooks:teller (info without a secret
                           or after 7 quiet days, else ok); each omitted when nothing
                           of that provider is connected
    webauthn-ids.js      — WebAuthn credential ids (seams audit #3, INV-136):
                           legacyCredentialId spots a double-encoded stored id
                           (registration used to re-encode the already-base64url
                           credential.id); repairCredentialIds rewrites them in
                           the migration transaction (a duplicate is removed)
    hosting.js           — What the host provides (VPS move): publicUrl (PUBLIC_URL,
                           else RENDER_EXTERNAL_URL), alwaysOn (ALWAYS_ON — no
                           keep-alive ping), serverBackups (SERVER_BACKUPS —
                           backup.sh stamps user_settings.last_backup_at),
                           webhookBaseUrl (PUBLIC_URL ONLY — the opt-in for bank
                           webhooks, roadmap T2.1 W4)
    error-log.js         — In-app error log (roadmap T1.4): install() wraps
                           console.error in the shell (still prints); capture()
                           groups each call by fingerprint (source app from the
                           caller's frame + first line with numbers / hex ids /
                           quoted values blanked), re-entrancy guarded, never
                           throws, ≤100 distinct per minute; flush() writes one
                           batched UPSERT per fingerprint into app_errors each
                           minute, reopens a resolved row on a later occurrence,
                           announces new / reopened errors (≤5 notified in 24h,
                           tag app-error-<fp>) and prunes (resolved >30d, any
                           >90d — at most daily, in a quiet minute too: cycle-8
                           F32); listErrors / recentUnresolvedCount / resolveError
    uptime.js            — Uptime (roadmap T1.4): deepHealthHandler for GET
                           /health/deep (SELECT 1 per database, 3s, single-flight
                           60s cache, 200 / 503 with yes/no fields only) and the
                           optional HEARTBEAT_URL ping (30-minute tick, NOT
                           activity-gated, no database call — <url>/fail while
                           job-health.failingJobs() is non-empty)
    operator-checks.js   — The operator doctor (cycle-7 ST4): getOperatorChecks
                           = the GitHub checks (cached 6h, single-flight;
                           cachedOnly never waits — it starts a background
                           refresh) + localChecks (the compromised Teller cert,
                           F14 — moved here from data-health, TOKEN_ENCRYPTION_
                           PASSPHRASE, SHELL_PIN < 6, info notes for APP_TIMEZONE
                           UTC / no VAPID / no CALENDAR_FEED_TOKEN) + knowledgeCheck
                           (Per-sistant's vault_parse_version < VAULT_PARSE_VERSION
                           → "run one full reindex", read-only via persistentPool).
                           Each check { id, label, status ok|info|warn|fail|
                           unknown, detail, fix }. toIssues (warn/fail → data-health
                           warnings tagged source:'operator') and notifyIfChanged
                           (one push per change in the failing-id set, stored in
                           user_settings.operator_checks_signature; skipped while a
                           GitHub check is unknown). Also the bank-webhook
                           checks (roadmap T2.1 W6 — webhook-status.js, when a
                           pool or a precomputed webhookStatus is passed).
                           Cycle-8 E4a (ST5): localChecks' cert check also reads
                           the expiry (expired → fail, within 30 days → warn —
                           CERT_EXPIRY_WARN_MS); goLiveChecks({ pool,
                           persistentPool, env }) — token-free, env + databases
                           only, never a secret's value, each check fail-soft (a
                           failed count omits it): local:teller-cert fail while
                           non-SUSPENDED Teller enrollments exist and no cert is
                           configured; local:databases (under the shell) warn when
                           PERSISTENT_DATABASE_URL is unset or the same database
                           (boot-checks.sameDatabase); local:public-url (info
                           unset, warn when not a bare https origin); local:api-key
                           (warn unset or < 24 chars); local:shell-secret (< 32);
                           local:plaid-config (with PLAID_CLIENT_ID: fail without
                           PLAID_ENV's PLAID_SECRET_*, warn on an unknown env or
                           sandbox with GOOD items); local:teller-webhook-secret
                           (a part < 16). backupCheck (local:backup, replaced
                           serverBackupCheck) runs under SERVER_BACKUPS AND whenever
                           the GitHub checks are off: user_settings.last_backup_at
                           + last_backup_source (server / github) — missing or > 36h
                           → fail, else ok naming the source
    financial-queries.js — Shared income/spending SQL helpers (split-adjusted spending,
                           getIncomeForYear(pool, year) — a calendar year's income on
                           incomePredicate + INCOME_AMOUNT by source / kind (wages /
                           interest / dividends / other — Plaid's detailed PFC, else
                           the description) / institution / month (roadmap T3.3 K2),
                           getTaxDeductionReport(pool, year) — the deduction report's
                           rows (getTaxDeductionTransactions annotated by the
                           tax_deductions merchant notes, sorted by category then
                           date; behind /api/export/tax-report AND the tax package,
                           T3.3 K3), keyword-filtered income, current-month per-category spending
                           that honors transaction_splits) — single source of truth used
                           by AI insights and budgets so the numbers match the dashboard.
                           Refunds (cycle-7 F35): REFUND_PREDICATE (settled, non-
                           reimbursed credit passing NOT_TRANSFER and NOT income — the
                           income test COALESCEd, it is NULL for non-Plaid rows),
                           spendLinesCTE(window) (charges + split lines + refund lines;
                           a refund takes the merchant's latest earlier charge category)
                           and NET_CATEGORY_MONTHS (per month + category floored at $0)
                           are the ONE spending-line source every spending surface reads
    cash-flow.js         — The cash-flow forecast (roadmap T2.2 L1), moved out of
                           GET /api/cash-flow so the cash alerts read the same
                           numbers: getCashFlowInputs(pool, { today }) (live income
                           streams, active subscriptions + outgoing recurring
                           transfers minus card autopays — DD-4, isCardAutopay: a
                           bill_payment into a linked card (paid_linked_card) or with
                           a card phrase / issuer name, never a utility autopay
                           (cycle-8 F8) — and minus transfers between your own
                           spendable accounts (moved_between_cash_accounts: the
                           latest debit's same-amount credit within 5 days on
                           another depository, non-investment account — F7),
                           spendable cash — FAN-5 — and the 60-day weekday / overall spending
                           averages without subscription merchants), the PURE
                           projectCashFlow(inputs, { days }) (today+1 … today+days
                           on calendar dates; the route's fields + the daily
                           `projection` + `lowest` { date, balance }), firstBelow
                           (projection, threshold) and getCashFlowForecast. "Today"
                           is todayStr() (APP_TIMEZONE — the route used the UTC
                           date). Charge-level (no refund netting, F35).
                           Cycle-8 E1a (G1): the user's corrections win —
                           transferTreatment(tr) reads recurring_transfers.
                           forecast_treatment (bill → billed whatever the
                           heuristics say; internal / ignore → never), else
                           isCardAutopay / isInternalMove; a subscription's
                           forecast_ignore leaves it out. classifyBills splits the
                           candidates into `bills` (source / id / treatment / why
                           auto | user) and `left_out` (reason card_autopay |
                           internal | user_internal | user_ignored);
                           projectCashFlow bills only `bills` and returns both as
                           `forecast_items` (each bill's occurrences, projected
                           total and next date in the window)
    cash-alerts.js       — The low projected cash alert (roadmap T2.2 L2):
                           runCashAlerts(pool, { now, today, deps }), run hourly
                           by the "cash-alerts" away job. Off by default (and then
                           no DB read for the rest of the local day — invalidate()
                           from PATCH /api/settings); evaluates only when a data
                           stamp (a spendable account's balance_updated_at,
                           last_txn_sync_at, last_balance_sync_at, a Plaid item's /
                           Teller enrollment's last_synced_at) is newer than
                           cash_alerts_checked_at or on a new local day; never on
                           balances older than 36 h (STALE_BALANCE_HOURS) or none;
                           projects cash_alert_horizon_days with getCashFlowForecast
                           and notifies on the first day below cash_alert_threshold
                           ("Low cash ahead", tag cash-low, /dashboard) + the opt-in
                           critical-alert email — once, again when the breach moves
                           3+ days earlier or after 72 h; recovery silent, but the
                           last notification is remembered across it (last_notified,
                           cycle-8 F11 — a forecast hovering at the floor used to
                           re-notify on every clear → dip). State in
                           user_settings.cash_alert_state, advanced only when the
                           notification was logged (else retried next tick).
                           invalidate() also forces the next tick to evaluate (F12 —
                           a raised threshold or a new floor waited for new data).
                           Account floors (T2.2 L4, checkFloors — same switch and
                           gate, checked first): a spendable account with
                           linked_accounts.low_balance_floor whose balance
                           (available, else current) is below it pushes "Low
                           balance: <name>" (tag balance-floor-<id>, /dashboard)
                           once per account per 24 h (sentRecently); an account
                           whose own balance is older than 36 h is skipped; push
                           only. last_check.floors_below counts them; an unlogged
                           floor push leaves cash_alerts_checked_at unstamped
    linked-tasks.js      — Linked tasks, Perfin's side (roadmap T2.4 X2a):
                           computeLinkedTasks(pool, { sources, bill_lead_days }, today)
                           → { ok_kinds, desired, retain, errors } — the Per-sistant tasks that
                           should be open now, keyed perfin:<kind>:<id>: rent & utilities
                           per unpaid period of the configured payee inside the
                           payment-due window or overdue (housing.rentReminderOpen —
                           the reminder's own rule; next month's rent before its row
                           exists, unless removed), a utility amount whose bill should
                           have arrived (housing.utilityAmountDue), manual-bill
                           occurrences 30 days back to the lead with no bill_payments
                           row (manualBillOccurrences) — an unpaid occurrence older than
                           that window goes in `retain` (from the bill's creation month):
                           its open task stays open, nothing is created (cycle-8 F17;
                           it used to close as completed on day 31) — and (roadmap T3.3 K2,
                           taxDocumentTasks) each open tax_documents row past its
                           expected_by — "Find your <year> <form> from <issuer>",
                           perfin:tax-doc:<id>, /tax#documents. Each source isolated; only the
                           kinds read (ok_kinds) may close tasks; a source switched off
                           isn't read; today = todayStr(). SOURCES / DEFAULT_SOURCES
                           (manual bills off). X2b: runLinkedTasks(pool, persistentPool
                           = the embedded Per-sistant pool) — nothing without that pool
                           (standalone) or while linked_tasks_enabled is off (then no
                           settings read for the rest of the local day; invalidate()
                           from the settings PATCH); computes, then Per-sistant's
                           syncLinkedTasks with ONLY ok_kinds (lazy require), and stores
                           { at, desired, created, updated, closed, reopened, skipped,
                           errors } in user_settings.linked_tasks_state (fixed
                           sentences, never exception text). One run at a time — a call
                           during a run shares its promise and makes it go round once
                           more. The hourly tick passes scheduled: true and acts once a
                           local day: after a clean run (status ok) it returns "fresh"
                           with no read of either database until the next local day, a
                           kick, Run now or invalidate() (cycle-8 F21; a partial run is
                           retried the next hour). kick(reason) / refreshSoon: the
                           fire-and-forget refresh the housing (incl. the config PATCH),
                           bill-payment, manual-bill and tax-document routes call after a
                           write, and the housing ledger tick when it generated
                           obligations (F22); never throws or rejects. stillChargingItem(sub) — the
                           still-charging item ("still-charging:<sub>:<txn>"), also the
                           watchdog push's item (cycle-8 E3d). ensureStillChargingTask(pool, sub): the
                           watchdog's one-off task perfin:still-charging:<sub>:<txn>
                           (switch + source on), never closed by a sync. isRunning()
                           (X2c) backs the run route's 409
    payday-alerts.js     — Payday alerts (roadmap T2.2 L3; off by default —
                           payday_alerts_enabled). runPaydayLanded (the third
                           runPostSyncSteps step — never a reconcile): settled
                           income deposits (INCOME_PREDICATE) new since the last check —
                           an id watermark (last_income_alert_txn_id) with a
                           LANDED_OVERLAP_HOURS (24) overlap rescan measured from
                           last_income_alert_at (services/txn-watermark.js, cycle-8
                           E2c) — dated within 5 days that match a LIVE income stream
                           (same source, ±10%) → "Paycheck landed" (tag
                           payday-<hash>); an overlap deposit whose tag is already in
                           notification_log (30 days) is skipped (a CSV import commits
                           its rows, ids taken earlier, after a check — cycle-8 F51).
                           The watermark advances to the mark read before the
                           candidates (also when nothing was found), held just before a
                           send that isn't logged (sendToAll's { logged: false }, or a
                           throw — cycle-8 F10) and never moved backwards (GREATEST);
                           no watermark yet → set to the newest id and now, nothing
                           older announced. runPaydayMissed (the hourly cash-alerts
                           job): a live stream's latest expected payday after its
                           last deposit whose 3-day grace has passed (≤ 14 days old,
                           overduePayday) with NO deposit from that source (any
                           amount) since expected − 3 days, on an account whose
                           connection (GOOD Teller enrollment / Plaid item — never CSV
                           or manual) last synced cleanly after the grace window →
                           "Payday missed?" + the opt-in critical-alert email, once
                           per (stream, expected date) via sentRecently; an in-memory
                           (local day + sync stamp) memo, off → no DB read that day
    notify-prefs.js      — Notification kinds, quiet hours and mutes (cycle-8 E3a,
                           G2; .cycle/plan-e3-notifications.md): NOTIFY_KINDS — 15
                           user-facing kinds (spending, cash, bills, plan, goals,
                           accounts, system, tasks, habits, knowledge, jobs, email,
                           security, test, other), each with its Perfin tags / tag
                           prefixes and Per-sistant check types; kindOf(tag) (exact,
                           then the longest prefix, else "other" — mutable) /
                           kindOfCheckType (housing_due → bills, the kind of Perfin's
                           rent push); catalog(); normalizePrefs(row); isQuiet(now,
                           quiet, tz) on the APP_TIMEZONE wall clock (end before start
                           wraps past midnight, start inclusive, end exclusive);
                           decide({ kind, prefs, now, tz, covered }) → muted → covered
                           (an open linked task — ST2) → held (quiet hours) → sent;
                           security and test are never muted or held;
                           parseQuietHours / parseMutedKinds (PATCH /api/settings);
                           minutesUntilQuietEnd (E3b). Pure; routes/notifications.js
                           delivers through it since E3b
    advice.js            — "Where should my extra money go?" (roadmap T4.1 A1,
                           .cycle/plan-t4-1-advisory.md; read by routes/advice.js and
                           Ask's get_cash_plan since A2):
                           getAdviceInputs(pool, { today, deps }) reads eight sources
                           once each, fail-soft (a fixed sentence per source in
                           errors[]): getMonthlyIncomeAndSpending, getLiveIncomeStreams,
                           getCashFlowForecast (60 days), the cash floor
                           (cash_alert_threshold), credit + loan accounts with a
                           balance, 60 days of card activity with an interest test
                           (Plaid PFC BANK_FEES_INTEREST_CHARGE or "interest charge /
                           finance charge" wording) and the outgoing savings /
                           investment recurring transfers. buildAdvicePlan(inputs) is
                           PURE and computes every figure: no plan (ok: false) while a
                           critical source (months, cash, debts, activity, transfers)
                           is missing; the steps minimums → starter buffer (floor + 1
                           month of spending) → debt at APR ≥ 8% (cards and loans) →
                           emergency fund (3 months) → debt at 4–8% (50/50 with
                           investing) → invest, the first not done the headline; a card
                           is carried when charged interest in 60 days or its last
                           payment was within 10% of its minimum, else paid in full (not
                           debt); an unknown card APR is 22%; the surplus counts only
                           after 3 completed months each over max($200, 10% of income),
                           its median less savings transfers and minimums, capped (money
                           leaving cash only) so the 60-day low stays ≥ the floor, × 60%,
                           rounded down to $25 per paycheck of the largest pay stream; an
                           avalanche simulation (overflow, rollover) gives each debt's
                           payment, payoff month and interest saved, plus a snowball
                           line; a 30%-utilization tip; every threshold a named constant;
                           the disclaimer on every plan; no security or fund named.
                           Roadmap T4.1 A5: the eighth, NON-critical source is the
                           active goals (GOALS_SQL, each through routes/goals.
                           deriveGoalProgress — a failure is goals null + a sentence,
                           the plan still worked out); the plan adds `emergency` (months
                           of spending covered floored to a tenth, target, have, pct,
                           reached, projection { months, month } at the plan's pace —
                           after the high-interest debts' payoff months during that
                           step, with a note — or "Nothing is going toward it") and
                           `goals` (goalCatchUps: per goal reached / no_date / due /
                           overdue / on_track / behind — behind = the contribution
                           $5+ a month (GOAL_CATCHUP_MIN) short of requiredMonthly, the
                           Goals page's monthly compounding; "Add $X per paycheck to
                           <goal> to finish by <Mon YYYY>", rounded UP to the dollar).
                           Roadmap T4.1 A6: two more NON-critical sources — deposits
                           (DEPOSITS_SQL: settled income deposits on incomePredicate("t")
                           at INCOME_AMOUNT, your share, 240 days) and categories
                           (CATEGORY_MONTHS_SQL: spendLinesCTE + NET_CATEGORY_MONTHS over
                           the 6 completed months); the months read covers 7. The plan
                           adds `raises` (detectRaises: a payer's deposits stepping up to
                           a new steady level — ≥ 2 deposits above each of the 3 steady
                           ones before, +3% and +$50 a month, first seen within 90 days,
                           a stand-alone bonus left out — with half of it, rounded down
                           to $25 per paycheck, toward the current step), `bonuses`
                           (detectBonuses: a deposit within 45 days ≥ $500 and 1.5× the
                           payer's usual with no other near its size, or ≥ $1,000 from a
                           payer seen once; splitWindfall splits it buffer → high debt by
                           APR → emergency → medium 50/50 with investing → investing, the
                           gaps measured without the bonuses) and `spending_creep`
                           (spendingCreep: a category's last-3-month average up ≥ $50 from
                           a ≥ $50 base and 15 points faster than income, top 3,
                           Uncategorized skipped, all 6 months on record) — each null when
                           its read failed. Roadmap T4.1 A7: two more NON-critical
                           sources — idle (IDLE_ACCOUNTS_SQL: depository + investment
                           linked accounts minus the Plaid brokerage phantom; the active
                           investment_accounts; IDLE_SNAPSHOTS_SQL: the checking accounts'
                           balance snapshots over 60 + 31 days) and allocation (the
                           holdings + target_allocation_pct through services/allocation.js).
                           The plan adds `idle_cash` (checkingLow: the lowest summed
                           checking balance over 60 days, each account's last snapshot
                           carried forward — null without a balance known at the window's
                           start; the excess over the starter buffer, rounded down to
                           $100, ≥ $500, moved through splitWindfall's order to accounts
                           that exist — a card, the emergency fund to a savings account,
                           investing to a brokerage that isn't tax-advantaged
                           (idleDestinations) — money leaving cash capped so the 60-day low
                           stays ≥ the floor; null with no savings / brokerage) and
                           `rebalance` (rebalanceMoves: target-allocation classes more than
                           5 points off, overweight paired with underweight largest first,
                           rounded to $100 — asset classes only, never a security — with
                           REBALANCE_NOTE; null without targets or holdings). Roadmap T4.1
                           A8: the card read also carries last_statement_balance /
                           last_statement_issue_date (stored by the Plaid liabilities
                           sync); nextStatementDate (the last statement + k calendar
                           months, day clamped; null when older than 62 days); a card's
                           debt row gains `statement` { last_date, last_balance,
                           reported_pct, next_date } and its 30% tip names the day the
                           next statement closes (else its due date); carryStatus reads
                           the statement first (a payment on / after it under 95% →
                           carried, else paid in full; interest still decides first); the
                           plan adds `loan_extra` (loanExtraPayments: each carried loan with
                           an APR > 0 and a payment the plan doesn't already fund — an extra
                           $100 a month through computeLoanPayoff: interest saved, months
                           sooner, a low-APR note). Roadmap T4.1 A9: a thirteenth,
                           NON-critical source `subscriptions` (SUBSCRIPTIONS_SQL: active
                           detected subscriptions not dismissed or cancelled;
                           SINKING_BILLS_SQL: active quarterly / yearly manual bills;
                           MEMBERSHIP_ACTIVITY_SQL: 90 days of settled debits whose display
                           merchant names a membership store, word boundaries). The plan
                           adds `sinking_funds` (sinkingFunds: each subscription billed
                           every 90+ days and each quarterly / yearly manual bill of $100+,
                           its next date by cadence.seriesOccurrences / manualBillOccurrences,
                           the set-aside per month until then rounded up to the dollar and
                           the steady amount after, soonest first, at most 8; total_monthly
                           = the steady sum) and `subscription_review` (subscriptionReview:
                           OVERLAP_GROUPS — video / music streaming, cloud storage, VPN,
                           password manager, a service counted in its first group — with two
                           or more members → what keeping one saves; MEMBERSHIPS — Amazon
                           Prime (not Prime Video), Costco, Walmart+, Instacart, DashPass,
                           Uber One, Grubhub — 90+ days old with no other purchase from the
                           store in 90 days, a charge within 50 cents of the fee not counted;
                           monthly = amount × 30 / cadence days) — each null when the read
                           failed. Roadmap T4.1 A10: a fourteenth, NON-critical source
                           `contributions` (user_settings.contribution_limits through
                           normalizeLimits; CONTRIBUTION_ACCOUNTS_SQL: the GET
                           /api/investments list — a Teller-linked investment account
                           without a Plaid item as linked:<id>, an active investment_accounts
                           row as investment:<id>, with its flows_synced_at;
                           CONTRIBUTION_FLOWS_SQL: flow_type 'contribution' from Jan 1 of
                           today's year to today per account). The plan adds
                           `contribution_room` (contributionRoom: per account with a limit
                           you entered — no account type assumed, a $0 limit or a gone
                           account left out — contributed, room, the per-paycheck amount
                           that fills it by Dec 31 rounded UP to the dollar
                           (periodsLeftInYear), reached, contributions_unknown for a Plaid
                           account whose flows haven't synced, most room first). What-if:
                           applyWhatIf(inputs, { extra_payment: { debt, amount_monthly },
                           income_change_monthly, spending_change_monthly }) changes the
                           inputs — the matched CARRIED debt's raw row gets
                           what_if_extra_monthly (normalizeDebts adds it to the minimum,
                           capped at the balance; exact name / mask first, else one partial
                           match), every month row's income / spending moves, the lowest
                           projected cash day moves by the net change a month until it;
                           ±$100,000 (WHAT_IF_MAX), each refusal a sentence — and
                           whatIfPlan runs buildAdvicePlan on both and returns before /
                           after (step, headline, amount per period, the emergency fund's
                           month), each debt whose payment or payoff moved with its interest
                           change, a worded text and the changed plan
    advice-alerts.js     — "Tell me when my plan changes" (roadmap T4.1 A4, plan
                           decision 8): runAdviceAlerts(pool, { now, today, deps }), run
                           hourly by the "advice-plan" away job. Off by default
                           (advice_alerts_enabled; then one settings read a local day —
                           invalidate() from PATCH /api/settings); at most one evaluation
                           a local day (advice_state.checked_on + a memo); the first run
                           records a baseline without notifying; planChange (pure) →
                           a new headline step, a debt step's new target debt, or the
                           amount per period (per paycheck, else per month — a unit
                           change compared monthly) moving ≥ 20% AND ≥ $50, always
                           against the LAST NOTIFIED signature; changeText (pure) →
                           "<card> is paid off — your plan now puts $X per paycheck
                           toward …" when the old target is no longer a carried balance;
                           "Your plan changed" (tag advice-plan, /dashboard), push only,
                           never email; the signature advances only when the push was
                           logged (an unlogged one leaves the day unchecked → retried).
                           Since A6 a new raise or bonus (windfallsOf — a bonus keyed by
                           payer + day + amount, a raise by payer + level; the baseline
                           records them silently, advice_state.windfalls_seen ≤ 30) is
                           pushed once: "New money for your plan" with the signature
                           kept, or inside the plan-change push
    allocation.js        — Asset-class allocation (roadmap T4.1 A7), the ONE definition
                           behind GET /api/investments/performance's by_asset_class and
                           the cash plan's rebalancing: HOLDINGS_SQL (investment_holdings
                           on active / unmatched investment accounts), normalizeTargets
                           (target_allocation_pct → { class: number }, keys lowercased, a
                           JSON string parsed) and assetAllocation(rows, targets) (per
                           class value / known-basis value / share / target_pct /
                           drift_pct; a targeted class with no holdings at 0%)
    tax-investments.js   — Investment tax figures (roadmap T3.3 K1), from
                           investment_transactions: realizedGains (FIFO lots per
                           account + security; cost = the buy's |amount|, fees in;
                           a sale beyond known lots or from a transfer-in lot has a
                           NULL basis, never $0 — basis_coverage full / partial /
                           none; short / long by "held more than a year", a sale
                           across both is "mixed" and split pro rata in the totals;
                           cancels dropped; split / merger / spin-off / stock
                           distribution flag the security (corporate_action) and
                           leave its lots alone; "sell short" and its "buy to cover"
                           not modelled — cycle-8 F15), investmentIncome (dividends —
                           qualified separately — interest, capital-gain
                           distributions, tax withheld, per taxable account; a `fee`
                           row is never income — margin interest charged, a dividend
                           paid on a short — F9), retirementDistributions (cash
                           withdrawals / distributions from TAX_ADVANTAGED accounts:
                           IRA / Roth / 401k / 403b / 457b / 529 / HSA / pension …),
                           getInvestmentTaxData(pool, year) (calendar year, an
                           integer 2000-9999 — throws otherwise; every row before the
                           year's end so earlier buys are the lots). Tax-advantaged
                           accounts never reach gains or income. Pure apart from the
                           one read; nothing stored, nothing sent to AI
    tax-documents.js     — The tax documents checklist (roadmap T3.3 K2): FORMS
                           (the tax_documents CHECK list), parseTaxYear (an integer
                           2000..this APP_TIMEZONE year, else null), expectedBy (Jan 31
                           of the next year, Feb 15 for a 1099-B), computeSuggestions
                           (pool, year, deps) — a W-2 per payroll source, a 1099-INT
                           per institution at ≥ $10 (the larger of bank interest from
                           getIncomeForYear and brokerage interest — never their sum),
                           a 1099-DIV at ≥ $10 of dividends + capital-gain
                           distributions, a 1099-B per brokerage with a sale, a 1099-R
                           per retirement distribution, a 1098 / 1098-E / 1098-T from
                           the deduction rows (mortgage interest / student loan
                           interest / tuition); one per form + issuer
                           case-insensitively; each source isolated (a fixed-sentence
                           error), reasons returned, not stored —
                           suggestTaxDocuments (INSERT … ON CONFLICT (tax_year, form,
                           (LOWER(issuer))) DO NOTHING, so a received / dismissed /
                           hand-added row is never changed) and listTaxDocuments (form
                           order, each row's state received / dismissed / overdue /
                           waiting). No AI
    tax-package.js       — The year-end tax package (roadmap T3.3 K3), computed on
                           request, never stored: gatherTaxPackage(pool, year, deps)
                           → { year, generated_on, disclaimer, overview, income,
                           investment_income, realized_gains, retirement, deductions,
                           rent_paid, documents, notes } from the shared definitions
                           (getIncomeForYear, getInvestmentTaxData — read once for
                           three sections — getTaxDeductionReport, getHousingPayments,
                           listTaxDocuments). Each section is fail-soft ({ ok: false,
                           error: SECTION_ERRORS[…] }, a fixed sentence; the others
                           render; overview.sections_failed names them). A CSV per
                           section (taxReportCsv IS /api/export/tax-report's CSV,
                           rent_paid.csv the landlord export's; an unknown basis a
                           blank cell, never 0.00; text through csvText, dates through
                           csvDate — documents.csv's dismissed day in APP_TIMEZONE,
                           cycle-8 F13), renderPackagePdf (pdfkit → Buffer: a bookmark per
                           section, the disclaimer on the first and last page) and
                           buildPackageZip (ZIP_FILES: summary.pdf, deductions /
                           income / investment_income / realized_gains / retirement /
                           rent_paid / documents .csv, package.json). No AI
    zip-store.js         — A STORE-only ZIP writer (roadmap T3.3 K3): crc32 (table-
                           driven, not zlib.crc32), createZip([{ name, data }], { date })
                           — local headers, central directory, end record; DOS time
                           from the date's UTC fields; printable-ASCII relative names
                           only (no "..", no leading "/", no backslash), no duplicates,
                           no ZIP64 (a file / archive past 4 GB or 65535 entries
                           throws). No dependency
    projections.js       — FIRE/runway/loan math (pure): computeFireProjection
                           (FIRE number = annual spend × 100/withdrawal-rate,
                           monthly geometric compounding, 40-yr series) +
                           computeRunwayMonths (no-income depletion with
                           growth) + computeLoanPayoff (iterative amortization
                           — months/interest/payoff-date, insufficient-payment
                           flag; payoff month anchored on a `today` arg) +
                           month-end-safe addMonthsYm / addMonthsYmd (month-
                           index math, day clamped — FAN-15: setMonth(+n) on
                           the 29th–31st skipped a month; used for the payoff,
                           goal estimated_date and FIRE dates). Consumed by GET /api/fire-projection
                           (goals.js), the ask.js get_fire_projection tool,
                           and the insights debt-optimizer loan block; the
                           dashboard loan card inlines a pinned mirror.
    cadence.js           — Recurring-date math (pure, DC-9/DC-10/DC-15):
                           month-scale cadences (30/60/90/365 days) step by
                           1/2/3/12 CALENDAR MONTHS keeping the anchor day
                           clamped per month (Jan 31 → Feb 28 → Mar 31);
                           7/14 step in days. seriesOccurrences anchors a
                           detected sub/transfer on its REAL last charge with
                           next_expected as the lower bound (a clamped stored
                           next_expected must not shift a 31st biller to the
                           30th); manualBillOccurrences (creation month +
                           due_day, real month-length clamp) is the ONE manual-
                           bill rule for the calendar AND the ICS feed;
                           buildIncomeStreams / incomeEventsBetween classify
                           deposits into weekly/biweekly/semimonthly/monthly
                           streams for the bill calendar (semimonthly days-of-
                           month are clustered circularly when the linear test
                           fails — a "1st" paid on the 29th–31st stays [1, 15],
                           cycle-7 F52). Used by both
                           detectors, /api/forecast, /api/bill-calendar,
                           /calendar.ics, the cash-flow bill schedule and
                           POST /api/subscriptions. Requireable from scripts/.
                           isValidYmd(s) checks a real calendar date, not just
                           the YYYY-MM-DD shape (cycle-7 F57).
    benchmarks.js        — S&P 500 benchmark closes for portfolio comparison.
                           Stooq daily-close CSV (keyless), cached in
                           benchmark_prices, fetched lazily — at most once/day
                           on SUCCESS, but a transient fetch FAILURE only
                           throttles retries ~30 min (FAIL_RETRY_MS) instead of
                           suppressing the benchmark all day (F10) — and only
                           the missing range; every failure path
                           degrades to "no benchmark line" rather than erroring
    ai-audit.js        — Post-generation insight auditing (4 tiers: arithmetic
                           validation, entity existence, trend direction, consistency).
                           Stores results in ai_audit_log table. Since roadmap T4.1 A3
                           auditInsight(text, id, { plan }) also checks the cash plan's
                           figures in tier 1 (planFigures / planClaimFinding, module
                           "cash_plan"); since A5 a goal's catch-up amount is one of
                           the plan's per-paycheck figures, since A6 a raise's share,
                           the raise per deposit and creep's freed amount too, since A8
                           a loan's extra $100 a month and its payment with it (that
                           loan's monthly figures)
    claude.js          — Claude 5.5 call helpers: createToolCall (tool_choice
                           "auto" + strict tool + ONE append-only re-ask when the
                           model answered in prose; usage summed so the cap
                           charges both calls — Opus/Sonnet 5.5 reject a forced
                           tool_choice), effortParams ("extract" = low effort,
                           "analyze" = medium — the 5.5 models think by
                           default), textOf / toolUseOf (read blocks by type).
                           Used by every Perfin model call.
    csv-export.js        — Shared CSV cell helpers for every Perfin CSV
                           download (/api/export, the tax-report CSV, the
                           housing landlord export, the tax package's CSVs — T3.3 K3): csvText (quote-escapes AND
                           prefixes "'" to a cell starting = + - @ tab/CR so a
                           merchant name can't run as a spreadsheet formula —
                           SXE-13) and csvDate / isoDate (a DATE as plain
                           'YYYY-MM-DD', never a JS Date toString — SXE-8/PSC-10)
  routes/
    enrollments.js       — POST /api/enroll, POST /api/sync, GET /api/items,
                           DELETE /api/enrollments/:id, DELETE /api/items/:id,
                           GET /api/accounts,
                           PATCH /api/accounts/:id, PATCH /api/accounts/:id/shared,
                           POST /api/sync-balances, reconcile endpoints, the
                           Teller sync engine, and account management. Also
                           hosts syncAllTransactions (the single Teller+Plaid
                           transaction-sync entry point) + runAnomalyCheck +
                           runPostSyncSteps(added) (rename rules then ONE anomaly
                           check, then the "Paycheck landed" alert — T2.2 L3 —
                           serialized — shared with the Plaid webhook's
                           per-item sync, roadmap T2.1 W3). Teller per-enrollment
                           sync (roadmap T2.1 W5): syncOneTellerEnrollment
                           (enrollment, { backfillFrom }) is one enrollment's whole
                           sync + bookkeeping (decryption check, DISCONNECTED on a
                           401/403 everywhere + the self-heal to GOOD, the partial
                           error, teller_enrollments.last_synced_at on a clean run)
                           — syncAllEnrollments loops it; syncTellerEnrollment(id)
                           syncs ONE non-suspended enrollment incrementally,
                           coalesced per enrollment, recording nothing global.
                           Background jobs (cycle-7 ST1): bgJobs, one in-memory
                           slot per kind (sync / sync-balances / reconcile, each
                           with an id); runTransactionSync / runBalanceSync are
                           the route bodies, shared through sharedRun (a POST
                           during a run joins it) and startBackground (202 +
                           id, 409 while running); GET /api/sync/status.
                           Mounts spending-analytics.js (route-file split).
    spending-analytics.js — split from enrollments.js: the six read-only
                           aggregation endpoints — /api/spending-summary,
                           /api/spending-categories, /api/cash-flow,
                           /api/spending-yoy, /api/savings-rate,
                           /api/income-summary. Includes INCOME_PREDICATE_T =
                           incomePredicate("t"), the t.-aliased build of the
                           canonical predicate for the one query that JOINs
                           linked_accounts (unqualified `name` was ambiguous
                           and 500'd /api/income-summary — found by the e2e
                           harness's live boot).
                           Also exports `syncAllEnrollments` and `syncAllBalances` for
                           the scheduled bank-auto-sync task in `server.js` (in-process,
                           no HTTP self-fetch).
    subscriptions.js     — GET/POST /api/subscriptions, PATCH dismiss/undismiss/cancel/
                           uncancel/category/forecast (+ PATCH /api/recurring-
                           transfers/:id/forecast — cycle-8 E1a), POST /api/detect, CSV import,
                           recurring transfers, manual bills, bill payments,
                           bill-calendar (+ICS builder), settlement. Mounts
                           transactions.js (route-file split). Also the
                           subscription watchdog (runSubscriptionWatchdog —
                           still-charging-after-cancel + price-rise alerts, run
                           after every detection; cycle-7 F53 / G5 — a logged
                           still-charging alert also creates its linked task, T2.4 X2b;
                           POST / DELETE /api/bill-payments and the manual-bill POST /
                           PATCH / DELETE kick the linked-task refresh — the latter since
                           cycle-8 F22).
    transactions.js      — split from subscriptions.js: per-transaction
                           endpoints — GET /api/transactions (+/search,
                           /duplicates, /csv-overlap +resolve),
                           PATCH/DELETE /api/transactions/:id,
                           GET/POST/DELETE /api/transactions/:id/splits.
                           The CSV-overlap pairing helpers (merchantsSimilar,
                           pairOverlaps — cycle-7 F21) are exported for tests.
                           (Original subscriptions.js entry continues:)
                           GET /api/transactions, GET /api/transactions/search, POST /api/detect,
                           POST /api/import-csv, GET /api/csv-imports, POST /api/cleanup,
                           GET /api/recurring-transfers, POST /api/detect-transfers,
                           PATCH /api/recurring-transfers/:id/dismiss|undismiss|type,
                           PATCH /api/transactions/:id (merchant_name, notes,
                           is_reimbursed, personal_for),
                           GET/POST/DELETE /api/transactions/:id/splits,
                           GET/POST/PATCH/DELETE /api/manual-bills,
                           GET/POST/DELETE /api/bill-payments,
                           GET /api/shared-settlement (+ /:account_id/transactions),
                           GET /api/transactions/csv-overlap (+ /resolve)
    goals.js             — GET/POST/PATCH/DELETE /api/goals, GET /api/goals/funding-options,
                           POST /api/net-worth/snapshot, GET /api/net-worth/history,
                           GET /api/context-export, GET/POST /api/investment-accounts
    budgets.js           — GET/POST/PATCH/DELETE /api/budgets, POST /api/budgets/suggest,
                           POST /api/budgets/accept, GET /api/budgets/alerts,
                           POST /api/budgets/snapshot, GET /api/budgets/history,
                           GET /api/budgets/one-time (roadmap T1.5 — every
                           one-month budget with its month, for the Budgets
                           page's other-month links)
    webhooks.js          — Bank webhook receivers (roadmap T2.1, W1–W6):
                           POST /api/webhooks/plaid + /api/webhooks/teller,
                           mounted in server.js BEFORE session / auth / CSRF /
                           API key / activity. Body required + 512 KB cap; 503
                           while the provider's verifier isn't configured; 401
                           (fixed text, console.warn) on a bad signature, ≤20
                           failures per IP per 15 min; a verified event goes into
                           webhook_events under its dedupe key (a re-delivery →
                           200 { duplicate: true }, not processed), the route
                           answers 200, then the provider's handler runs detached
                           and the row ends done / ignored / failed (fixed text).
                           Handlers: plaid-webhook-events.js (W3–W4) and
                           teller-webhook-events.js (W5).
                           The body is never stored or logged. 30-day prune, at
                           most daily. createWebhookRouter({ verifiers, handlers,
                           db, defer, now }) for tests
    plaid-webhook-events.js — the Plaid webhook handler (roadmap T2.1 W3–W4).
                           The item_id is looked up in GOOD plaid_items and the
                           investments-only registry. TRANSACTIONS /
                           SYNC_UPDATES_AVAILABLE → that item synced now (investments.
                           syncPlaidItem) then runPostSyncSteps(added); a failed item
                           sync fails the event (after the post-sync steps for any
                           rows it added). ITEM (W4): ERROR with a re-auth code,
                           PENDING_EXPIRATION, PENDING_DISCONNECT and
                           USER_PERMISSION_REVOKED set plaid_items.last_error_code
                           (setPlaidItemErrorCode — one notification on a new code);
                           LOGIN_REPAIRED clears it; NEW_ACCOUNTS_AVAILABLE notifies
                           "Add accounts" (≤1/day per item); an outage ERROR, other
                           ITEM codes and an investments-only Item's re-auth events
                           → 'ignored'. HOLDINGS / DEFAULT_UPDATE →
                           syncAllPlaidHoldings({ itemId }); INVESTMENTS_TRANSACTIONS
                           / DEFAULT_UPDATE | HISTORICAL_UPDATE →
                           syncAllPlaidInvestmentFlows({ itemId }) (a failed or
                           partly failed sync fails the event). An unknown item and
                           every other event → 'ignored'. A trigger, not data —
                           never reads the payload's transactions.
                           createPlaidEventHandler({ db, syncItem, postSync,
                           setErrorCode, isReauthCode, syncHoldings, syncFlows,
                           notify, sentRecently })
    teller-webhook-events.js — the Teller webhook handler (roadmap T2.1 W5):
                           transactions.processed → the enrollment(s) it names
                           (payload enrollment_id, else those owning its account
                           ids; never SUSPENDED) synced now (enrollments.
                           syncTellerEnrollment) then ONE runPostSyncSteps over the
                           combined count; a failed sync fails the event after the
                           post-sync steps. enrollment.disconnected → a GOOD
                           enrollment set DISCONNECTED (Sync Health's disconnected
                           link) + ONE "Bank connection disconnected … connect it
                           again with Teller Connect" notification (tag
                           teller-disconnected-<id>, /accounts, the reason in words
                           — reasonText); already DISCONNECTED / SUSPENDED → nothing.
                           webhook.test → 'done'. Anything else / unknown → 'ignored'.
                           createTellerEventHandler({ db, syncEnrollment, postSync,
                           notify })
    housing.js           — Rent & Utilities payee ledger: GET/PATCH /api/housing/config,
                           GET /api/housing/ledger, POST /api/housing/generate,
                           POST/PATCH/DELETE /api/housing/obligations, POST/DELETE
                           /api/housing/payments. Exports generateHousingObligations
                           + runHousingReminders for the scheduled task (INV-18/19),
                           and the pure periodDueDate / rentReminderOpen /
                           utilityAmountDue the reminder shares with the linked tasks
                           (roadmap T2.4 X2a — the payment-due window is now date-based,
                           so rent due the 31st opens lead days before Feb 28). Since
                           X2b, generate, the obligation writes and the payment writes
                           kick the linked-task refresh after they commit (the config
                           PATCH too since cycle-8 F22). Since
                           roadmap T3.3 K3, getHousingPayments(year, db) (a year's
                           payments with what each covered + the payee and total) and
                           housingPaymentsCsv — the landlord export and the tax
                           package share both.
    tax.js               — The year-end tax package routes (roadmap T3.3): K2's
                           documents checklist — GET / POST /api/tax/documents,
                           PATCH / DELETE /api/tax/documents/:id, POST
                           /api/tax/documents/suggest. The year rule (a 400), an id
                           above int4 a 400 (cycle-8 F14), strict
                           booleans, a duplicate a 409, a suggested row's DELETE a 409
                           (dismiss it instead); every write kicks the linked-task
                           refresh. K3's GET /api/tax/package?year=&format=json|pdf|zip
                           (json default; pdf / zip as attachments
                           perfin_tax_package_<year>.<ext>, Cache-Control no-store; a
                           bad year or format a 400 before any read; a fixed 500); K4's
                           format=csv&section=<deductions|income|investment_income|
                           realized_gains|retirement|rent_paid|documents> — that
                           section's CSV, the file the ZIP holds (an unknown section a
                           400 before any read)
    advice.js            — GET /api/advice (roadmap T4.1 A2): services/advice.
                           getAdvicePlan(pool) as JSON — a plan that can't be worked
                           out is still 200 { ok: false, error, disclaimer }; a throw a
                           fixed 500. Behind the dashboard's "Your plan" card
    dashboard-summary.js — GET /api/dashboard/summary (design D3, decision 5): the
                           top of the dashboard in one request — net_worth (the
                           latest net_worth_snapshots row + its change since the
                           month's first), spending (getBudgetStatus summed: spent vs
                           the effective limits, percent, over_count), cash (the
                           lowest projected day of getCashFlowForecast over 30 days)
                           and attention.items [{ kind, text, href, amount?, count }]
                           — rent owed (getHousingOwed, only when configured and > 0,
                           /housing), bills due in 7 days (getBillsDue, /calendar),
                           transactions to categorize (countUncategorized,
                           /dashboard#review-queue-section) and Sync Health warnings
                           (gatherDataHealth's severity 'warning' issues,
                           /settings#sync-health). Unrated insights are not an item.
                           Each part is fail-soft — a failing read is { ok: false,
                           error: <fixed sentence> } (an attention source one entry in
                           attention.errors) and logged once; only the net-worth reads
                           are SQL here (INV-147). gatherDashboardSummary(pool, { deps,
                           today, persistentPool }) is the shared entry point (design D7
                           reuses it for the landing page)
    settings.js          — GET/PATCH /api/settings, POST /api/sheets/sync,
                           POST /api/sheets/dashboard, GET /api/export,
                           GET /api/data-freshness, POST /api/linked-tasks/run
                           (Settings' "Run now" for the linked tasks — T2.4 X2c).
                           GET /api/data-health's body is gatherDataHealth(db,
                           { persistentPool }) (design D3 — the dashboard summary
                           counts its warnings)
    insights.js          — GET/POST /api/insights, GET /api/insights/status,
                           GET /api/insights/usage, POST /api/insights/reset,
                           POST /api/insights/rebuild, GET /api/insights/audit,
                           PATCH /api/insights/:id/feedback,
                           GET /api/insights/feedback-summary,
                           GET /api/insights/trust-overview,
                           GET/PATCH /api/tax-deductions
                           (also exports runWeeklyDigest + runDailyDigest
                           helpers used by the digest scheduled tasks in
                           startup.js). Since roadmap T4.1 A3 the cash_plan
                           module: cashPlanPromptBlock(plan) puts the advice
                           engine's plan in the prompt and seedPlanActions keeps
                           its current step as one "Plan (<step>): …" pending
                           action (both exported)
    categorize.js        — POST /api/categorize, GET /api/categorize/status,
                           PATCH /api/transactions/:id/category,
                           PATCH /api/transactions/bulk-category,
                           GET/POST/DELETE /api/categorization-rules,
                           POST /api/categorization-rules/apply,
                           POST /api/categorization-rules/from-transaction
                           (ML categorization via Claude tool_use structured output,
                           with user-defined rules applied first before AI)
    merchant-rename.js   — merchant rename rules (cycle-7 F55 / ST2):
                           GET/POST /api/merchant-rename-rules,
                           POST /api/merchant-rename-rules/apply,
                           PATCH /api/merchant-rename-rules/:id (roadmap T1.5 —
                           rename_to / is_active), DELETE
                           /api/merchant-rename-rules/:id. Exports
                           applyRenameRules (run by syncAllTransactions, both
                           reconciles — cycle-8 F43 — the CSV import, manual entry
                           and a restore — F5), createRenameRule (takes the rows
                           another rule renamed that it also matches and re-keys
                           only the detection keys it fully vacated — F41),
                           createRuleFromTransaction (PATCH /api/transactions/:id
                           apply_to_all), updateRenameRule and ruleCondition
    investments.js       — AGGREGATOR for the investment routes: mounts
                           investment-performance.js and re-exports its helpers
                           (route-file split — import paths unchanged).
                           GET /api/plaid/status, POST /api/plaid/link-token,
                           POST /api/plaid/exchange, POST /api/plaid/sync-holdings,
                           GET /api/plaid/holdings (Plaid investment accounts).
                           POST /api/plaid/link-token-transactions,
                           POST /api/plaid/exchange-transactions,
                           POST /api/plaid/sync-transactions (Plaid transaction
                           syncing for banks Teller doesn't cover — Capital One,
                           Discover, Schwab, etc. Combined link token requests
                           both Transactions + Investments in one session).
                           Link UPDATE MODE (cycle-7 G3): POST /api/plaid/
                           link-token-update + POST /api/plaid/update-complete
                           (loadUpdateItem; re-authenticate / add accounts on the
                           SAME Item). Duplicate guards: findDuplicatePlaidItem
                           (F18) + findDuplicateInvestmentItem (the investments-
                           only exchange; investment_accounts.mask).
                           GET /api/investments returns the unified picture
                           across Teller-linked, manual, and Plaid sources.
                           GET /api/investments/performance aggregates returns,
                           asset-class allocation, and top winners/losers from
                           Plaid-tracked holdings only (Teller-linked lacks
                           cost basis from Teller's API); its per-class rows come
                           from services/allocation.js (shared with the cash plan's
                           rebalancing since roadmap T4.1 A7).
                           Per-item Plaid sync (roadmap T2.1 W3): syncOnePlaidItem
                           (client, item) is one item's whole sync (register new
                           accounts, cursor walk, clear the re-auth code, stamp
                           plaid_items.last_synced_at when the walk reached the end,
                           liabilities — incl. a card's last statement balance + date
                           since roadmap T4.1 A8 — balances) — syncAllPlaidTransactions loops
                           it; syncPlaidItem(id) syncs ONE GOOD item under
                           withPlaidTxnLock, coalesced per item (a request during
                           its run makes it go round once more and shares its
                           promise), recording nothing global.
                           Webhook registration (roadmap T2.1 W4): plaidWebhookUrl
                           (req) = hosting.webhookBaseUrl() (PUBLIC_URL only) +
                           /perfin when embedded + /api/webhooks/plaid, null without
                           PUBLIC_URL; the four linkTokenCreate calls (link-token,
                           link-token-transactions, hosted-link, link-token-update)
                           carry it as `webhook` only then; the exchanges record it
                           in webhook_url (noteItemWebhook); POST
                           /api/plaid/webhooks/register re-points every Item.
                           PLAID_ADVANCE_WARNINGS (PENDING_EXPIRATION /
                           PENDING_DISCONNECT): a clean sync clears the re-auth code
                           with keepWarnings, so only a re-authentication clears them.
                           Also exports `syncAllPlaidTransactions`,
                           `syncAllPlaidBalances`, and `syncAllPlaidHoldings`
                           (UPSERTs investment_accounts; holdings-sum balance
                           fallback for null-balance brokerages) for the
                           scheduled auto-sync and `POST /api/sync-balances`
                           (in-process).
                           GET /api/investments excludes Plaid-linked accounts
                           from its linked_accounts branch (la.plaid_item_id IS
                           NULL) so Plaid investments come only from
                           investment_accounts — no $0 double-listing.
    investment-performance.js — split from investments.js: investment_flows
                           CRUD + Plaid flow sync (classifyPlaidFlow,
                           syncAllPlaidInvestmentFlows({ itemId }) — one Item for a
                           webhook, T2.1 W4), TWR/XIRR math, and
                           GET /api/investments/performance-history. The flow sync
                           also stores EVERY Plaid investment transaction of a
                           tracked account (storeInvestmentTransaction → the
                           investment_transactions table, roadmap T3.3 K1; returns
                           transactions_stored; a failed store is one
                           investment_transactions_not_stored error per Item and
                           never holds the flows back)
    insights-email.js    — split from insights.js: the pure email renderers
                           (renderInsightEmail, weekly/daily digest HTML+text,
                           escapeHtml); insights.js imports + re-exports them
    credit-scores.js     — GET/POST/DELETE /api/credit-scores
                           (manual credit score tracking with trend computation)
    notifications.js     — GET /api/notifications/vapid, POST/DELETE /api/notifications/subscribe,
                           POST /api/notifications/test, GET /api/notifications,
                           PATCH /api/notifications/:id/read, POST /api/notifications/read-all
                           (Web Push notifications + in-app notification log).
                           Since cycle-8 E3b (G2) sendToAll(payload, { now }?) reads the
                           quiet hours + muted kinds (readNotifyPrefs — cached 60 s; a
                           failed read holds and mutes nothing) and decides through
                           notify-prefs: the notification_log row is written as before
                           plus push_state (sent / held / muted / none) and `logged`
                           keeps its meaning; held → not pushed (a hold whose row didn't
                           write is pushed at once); muted → never pushed.
                           releaseHeldNotifications({ now }) — the notify-release job:
                           nothing while still quiet; holds older than 12 h
                           (HOLD_MAX_HOURS) expire (stay in the bell); a kind muted since
                           → muted; one hold pushed as itself, several as ONE summary
                           ("N notifications during quiet hours", tag quiet-summary, the
                           newest's link); marked sent only after the push went out.
                           releaseDue() is the job's in-memory gate (open at boot, on a
                           hold, after quiet hours end); invalidateNotifyPrefs() from
                           PATCH /api/settings. Since cycle-8 E3d (ST2) a payload may carry
                           `item` (the linked-task key without "perfin:" — housing:<period>,
                           utility-amount:<id>, still-charging:<sub>:<txn>; a malformed one
                           is ignored): while Per-sistant has an OPEN task for it (not
                           completed / trashed / detached — itemCovered, read through the
                           wired Per-sistant pool, fail-soft: standalone or a failed read
                           pushes) the row is written push_state covered, is_read true, with
                           item_key, and nothing is pushed (`logged` unchanged); order muted
                           → covered → held → sent, covered also beating "push not
                           configured". The release job marks a held row covered when its
                           item's task opened since
    persistent.js        — Per-sistant integration: webhooks, SSO, productivity context
                           POST /api/persistent/webhook/test, POST /api/persistent/webhook/send,
                           GET /api/persistent/status, GET /api/persistent/productivity-context,
                           POST /api/sso/generate, POST /api/sso/validate
    ask.js               — POST /api/ask: NL finance Q&A via Claude tool use.
                           8 READ-ONLY tools bound to the shared helpers
                           (monthly overview, category spending, transaction
                           search w/ adjusted totals — the total applies
                           the dashboard spending filters: shared-card split,
                           reimbursed AND NOT_TRANSFER excluded, matching
                           refunds netted and floored at $0 (F35); match_count
                           counts the listed rows; LIKE metacharacters escaped
                           (AIN-13) — net worth,
                           subscriptions, budget status, FIRE projection, and
                           since roadmap T4.1 A2 get_cash_plan — the advice plan,
                           trimmed (raises / bonuses / spending creep since A6, idle
                           cash / rebalancing since A7, loan extra payments and each
                           card's next statement date since A8, sinking funds and the
                           subscription review since A9, contribution room since A10 —
                           and A10's what-if overrides: extra_payment / income_change_monthly
                           / spending_change_monthly run services/advice.whatIfPlan and add
                           a what_if comparison); the prompt sends extra-money and what-if questions to it,
                           says it is educational and names no security or fund) so
                           cited numbers match the dashboard by construction —
                           the model never writes SQL. Bounded tool loop
                           (MAX_TOOL_ROUNDS=6); shares the monthly AI cap
                           (getAiBudgetCents) and charges it via an
                           entry_type='ask' usage row. The charge runs in a
                           `finally` (idempotent via a `charged` flag), so a
                           throw on a LATER tool round still records the tokens
                           already consumed instead of letting the spend escape
                           the cap — parity with rebuild (AIA2) / categorize
                           (M2) (F1); `charged` is set only after the row is
                           written, so a failed write is retried there
                           (cycle-7 F64); a failed write on the success path is
                           logged and the finished answer still returned —
                           the finally retries the charge (cycle-8 F44). The last round is sent
                           tool_choice "none" so it answers in text (F65);
                           the system prompt's "today" is the APP_TIMEZONE
                           date and the usage row records the model that
                           served the call (`msg.model`, F66). Dashboard
                           "Ask Perfin" widget (key: ask).
    whats-new.js         — GET /api/whats-new, POST /api/whats-new/seen
                           ("since you last looked" dashboard widget feed —
                           new transactions, balance deltas, new subscriptions,
                           and recent notifications since last_dashboard_view_at).
                           Since cycle-8 E2d (ST3) the GET reads txn-watermark's mark
                           first and returns it as seen_token ("<id>|<time>"); /seen
                           stores it (SEEN_SQL — forward only, capped at the newest id /
                           now(); a malformed token a 400; none → SEEN_NOW_SQL, "now");
                           with a stored last_dashboard_view_txn_id new transactions
                           are id > it AND id <= the mark, else created_at.
                           Also exports gatherWhatsNew(since, opts?) — the shared
                           aggregator used by both the HTTP route and the
                           daily-digest runner in insights.js so the dashboard
                           widget and email digest see the same data shape.
    watchlist.js         — GET/POST /api/watchlist, PATCH/DELETE /api/watchlist/:id
                           (user-curated merchant/category/keyword monitor.
                           Items rendered into the Watchlist sheet tab + matching
                           transactions over the last 90 days)
  pages/
    dashboard.js         — Dashboard page (Chart.js charts, 3D pyramid, account list, balances,
                           savings rate widget, cash flow widget, Per-sistant widget)
    subscriptions.js     — Subscription/utility management page
    accounts.js          — Teller Connect enrollment + CSV import page
    goals.js             — Financial goals tracking page
    budgets.js           — Budget tracking page with AI suggestions and alerts
    housing.js           — Rent & Utilities ledger page (balance owed, obligations,
                           record-payment modal, payment history, config)
    tax.js               — The Tax page, /tax (roadmap T3.3 K4) — renders views/tax.ejs;
                           public/tax-page.js does the rest
    transactions.js      — Transaction search/filter page with full-text search
    calendar.js          — Bill calendar page with subscription charges, manual bills,
                           and click-to-mark-paid functionality
    account-history.js   — `/accounts/:id/history` page — Chart.js line chart backed
                           by GET /api/accounts/:id/balance-history (linked or investment source)
    login.js             — PIN pad or password login page (with materialize animation)
    settings.js          — Settings page (theme, AI insights, keep-alive, Per-sistant, exports)
    pwa.js               — PWA manifest.json + icon generation (icons cached at startup)
  public/
    logo.svg             — Iron Man helmet SVG logo (traced from PNG). Used as the
                           Perfin nav icon (CSS-masked, gold-tinted), the standalone
                           Perfin PWA icon, and the source of the helmet shape that
                           perfin-materialize.js inlines for the tile-click animation.
                           NOT the unified-shell PWA icon — that's the mask-crop PNG
                           served from shell/public/manifest.json.
    offline.html         — Branded offline fallback page served by the SW when navigation
                           fails and no cache hit exists. No inline handlers (CSP) —
                           Retry + logo-error live in offline.js; assets are relative
                           (`logo.svg`), so they resolve under the /perfin mount (F92)
    offline.js           — The offline page's Retry (location.reload) + hide-logo-on-error
    tax-page.js          — The Tax page's script (roadmap T3.3 K4), loaded after
                           perfin-shared.js: the year (?year= when 2000..this year, else
                           taxSeason — last year January–April), GET /api/tax/package for
                           a card per section with its totals and a CSV link
                           (format=csv&section=, through withBase; a failed section shows
                           its sentence, no CSV link) + an overview card, GET
                           /api/tax/documents for the checklist (Mark received / Not
                           received, Dismiss / Restore, notes + Save notes, Delete only
                           on a manual row — data-e2e-skip — each control aria-labelled
                           with its form), Add form and "Suggest from my data"; every write
                           through writeOk and reloading only on success; a load for an
                           older year never overwrites a newer one. window.TaxPage for tests
    sw.js                — Service worker (cache `perfin-v7`, network-first with offline
                           fallback. Precaches CSS/JS/SVG/offline.html/offline.js on
                           install. Entries are keyed by origin + path, query dropped
                           (`cacheKey`), so a new `?v=` replaces the old copy instead
                           of piling up; `shouldCache` stores only an ok, same-origin,
                           NON-redirected response, and HTML only for a page
                           navigation — an expired session's login page can't be
                           stored as an asset (cycle-7 F107). The offline page is served through offlineResponse(),
                           which injects `<base href="<mount>/">` (keeps the CSP headers,
                           drops content-length) so its relative assets resolve from any
                           failed URL (F92). `/api/*` is intentionally NOT cached — stale
                           balances are worse than a clear network error. Push
                           notifications.)
    perfin-shared.css    — Shared styles (variables, nav, cards, animations, responsive,
                           focus-visible, skip-link, WCAG AA contrast text colors,
                           40/44px touch-target minimums on buttons). Defines every
                           token the views use: --card / --card-border / --bg-elevated /
                           --text-primary / --text-secondary / --accent are aliases of the
                           base palette (IF-4 — they were used with no definition), and
                           --on-teal is the text colour on a solid --teal button (#000
                           dark, #fff light — black on the light teal was ~3.1:1, IF-5).
                           `select option` lists and modal boxes use the opaque
                           --surface-solid. Design D2: --on-warm (#1a1206, both themes) is
                           the ink on a FILLED primary button (.btn.primary / .btn-sm.primary /
                           .actions button.primary — gold background); buttons are sentence
                           case (no uppercase transform); .amt-in / .amt-bad are the ONE pair
                           of money colours; .empty-state* style emptyState().
    perfin-shared.js     — Shared JavaScript (apiFetch, theme, nav helpers, asyncAction,
                           btnLoading, beforeinstallprompt capture + perfinPromptInstall /
                           perfinIsInstalled exports). Calendar-date helpers (WUI-2):
                           parseCalDate turns a DATE value ('YYYY-MM-DD' or node-pg's
                           UTC-midnight 'YYYY-MM-DDT00:00:00.000Z') into a LOCAL-midnight
                           Date for that day (fmtDate uses it — dates used to render one
                           day early west of UTC); localTodayStr(offsetDays) /
                           localDateStr(d) give browser-local 'YYYY-MM-DD' for date-input
                           defaults and "is today" checks (never toISOString()).
                           emptyState({ title, text, action }) (design D2) — the one
                           empty-state block: escaped, action { label, href } (a same-app
                           path only, through withBase) or { label, click: <button id> }
                           (a delegated handler clicks the page's existing button — no new
                           write path).
                           taxSeason(today) (roadmap T3.3 K4) → { year, season }: last
                           year from January to April, else this year — the Tax page's
                           default year and the dashboard's January–April Tax link.
                           Write + dialog conventions (Batch 13): writeOk(res, what)
                           — true on 2xx, else toasts "<what>: <server error>" — is how
                           every page reports a write's outcome (WUI-6: writes used to
                           await apiFetch and assume success); parseAmountInput(raw)
                           parses a prompt amount ("$1,234.50") or returns NaN so a typo
                           is refused instead of sent as null (WD-12). openDialog(box,
                           {label, onClose}) gives a modal role="dialog" aria-modal,
                           focus-in, a Tab trap, Esc → onClose and focus restore on
                           handle.close(); watchDialog(overlay, opts) applies it to an
                           overlay the page shows/hides itself (MutationObserver on
                           style/hidden/class). Every Perfin modal and the bell panel
                           use one of them (IF-1).
                           DASHBOARD_WIDGETS ([{key, label, selector}]) is the ONE
                           dashboard widget-key list: Settings renders a toggle per
                           entry and the dashboard calls applyDashboardWidgets(map),
                           which toggles `.widget-off` (display:none !important, so a
                           loader showing its section can't undo it) on each switched-
                           off key's element (cycle-7 F96 — the two pages kept separate
                           lists and five toggles hid nothing). Add a new widget there,
                           in PAGE ORDER (design D4 — Settings lists the toggles as
                           they appear; tests/design-d4.test.js pins the order)
  views/
    dashboard.ejs        — Dashboard template with 3D financial wellness pyramid
    transactions.ejs     — Transaction search/filter template, per-row Split modal
                           (Phase B3) and REIMBURSED badge (Phase B2)
    calendar.ejs         — Bill calendar template with Add Bill modal and paid-state toggling
    account-history.ejs  — Per-account balance history chart (range selector, summary cards).
                           ONE document: the head partial (extraStyles widens .container
                           to 980px) + the nav partial with `activePage` — it used to nest
                           its own <html>/<head> and omit activePage, so every load 500'd
                           (F88)
    budgets.ejs          — Budget tracking template with progress bars and alerts
    housing.ejs          — Rent & Utilities ledger template (balance, obligations,
                           record-payment modal, config form, payment history)
    tax.ejs              — The Tax page (roadmap T3.3 K4): the year select, PDF / ZIP
                           download links, the section cards' container and the
                           documents checklist (`<section id="documents">` — the linked
                           task's /tax#documents; Suggest, a labelled Form + Issuer add
                           form). Loads public/tax-page.js through the mount base
    goals.ejs            — Financial goals template with progress and projections
    settings.ejs         — Settings template (theme, AI, keep-alive, sync, exports).
                           Design D5 (decision 8): the sections sit in seven
                           `<section class="settings-group">` groups — Appearance &
                           Dashboard, Security, AI, Alerts & Notifications (Quiet
                           Hours & Muting since cycle-8 E3c), Sync & Connections
                           (Sync Health), Planning (Target Allocation, Watchlist),
                           Data & Exports; every section keeps its id.
                           buildSettingsIndex fills the sticky index (≥961px, a left
                           column) and the "Jump to" select (narrower) from the group
                           headings; revealHashTarget lands a deep link
                           (#sync-health, #deleted-transactions, #recent-errors, …)
                           on its section, opening a closed <details> first, and
                           again once the page has settled unless you've scrolled
                           since; tests/design-d5.test.js pins the groups and anchors
    subscriptions.ejs    — Subscription/utility management template
    accounts.ejs         — Teller Connect enrollment + CSV import template
    login.ejs            — Login template with helmet materialize animation on success
    partials/head.ejs    — HTML head (meta, PWA manifest, apple-touch-icon, viewport-fit,
                           dual light/dark theme-color, skip-link)
    partials/nav.ejs     — Top navigation bar with helmet logo icon, "Synced Xm ago"
                           badge with color-coded staleness (green/yellow/red) and per-source
                           tooltip (hidden on mobile to free up nav width — same data
                           available in Settings + the notification log), notification
                           bell with unread count + dropdown panel (drops down on
                           desktop, slides up as a bottom sheet with backdrop on
                           mobile ≤640px), <main> landmark. The nav renders BEFORE
                           perfin-shared.js loads, so its load-time apiFetch calls (sync
                           badge, unread count) go through `whenShared(fn)` — run now if
                           window.apiFetch exists, else on DOMContentLoaded (F90: they
                           threw, so the badge and bell count never loaded)
    partials/foot.ejs    — Footer partial (closes <main>)
```

The unified shell adds:

```
shell/
  index.js                     — PIN gate, sub-app mounts, cross-pool wiring,
                                 keep-alive, graceful shutdown (stops Perfin's
                                 job runner + Per-sistant's node-cron tasks
                                 before draining the pools — F16), public PWA-icon
                                 + /health + /health/deep routes mounted before
                                 the auth gate. Installs the error-log
                                 console.error wrapper before either sub-app
                                 loads and starts its flush + the uptime
                                 heartbeat after both apps' migrations
                                 (roadmap T1.4); a final flush on shutdown.
                                 start() refuses to boot without a separate
                                 Per-sistant database (boot-checks.js, cycle-8 F26)
  middleware/
    auth.js                    — Shell auth: HMAC-signed cookie session
                                 (SHELL_PIN + SHELL_SECRET) with sliding-window
                                 idle timeout (default 60 min, tunable from
                                 Settings via user_settings.shell_idle_timeout_minutes,
                                 60s in-memory cache). Also honors `x-api-key`
                                 against process.env.API_KEY for cron / CI
                                 clients. Exports init({pool, onLockout}),
                                 requireAuth, handleLogin, handleLogout,
                                 invalidateIdleCache, makeSession,
                                 setSessionCookie, cookieSecure, isValidSession,
                                 safeReturnTo, loginReturnTo, pinLockedForMs,
                                 isValidApiKey,
                                 COOKIE_NAME, DEFAULT_IDLE_MS, currentEpoch.
                                 Also owns the global PIN-failure ceiling
                                 (PSC-14), the return_to carry-through (PSC-9)
                                 and the session epoch (cycle-7 F12): the
                                 cookie signs "<expires>:<epoch>" and is valid
                                 only while the epoch equals
                                 user_settings.shell_session_epoch (read with
                                 the idle window; a legacy "<expires>" cookie
                                 is epoch 0; a DB blip keeps the last epoch).
                                 POST /logout?everywhere=1 (valid session
                                 required) bumps it — "Sign Out Everywhere".
    webauthn.js                — Shell-side biometric login: hosts
                                 `/api/shell/webauthn/{available,authenticate-options,authenticate}`
                                 mounted BEFORE requireAuth; reads
                                 `webauthn_credentials` from Perfin's pool;
                                 sets the shell session cookie on success
    error-handler.js           — Last middleware (PSC-4): status + short
                                 message, 5xx logged, never a stack trace
                                 (malformed pre-auth JSON → 400 JSON)
  landing-status.js            — The landing tiles' status lines (design D7):
                                 landingStatus({ perfinPool, persistentPool })
                                 → { perfin, persistent } — Perfin's line from
                                 gatherDashboardSummary (parts rent / bills /
                                 uncategorized), Per-sistant's from taskDueCounts,
                                 in-process, each with a 1.5s budget (null when it
                                 fails or runs over); never throws. Each read is
                                 single-flight and kept 30 s per pool (sharedRead,
                                 CACHE_MS — cycle-8 F33: a read past its budget
                                 isn't started again by the next visit, which gets
                                 its line once it finishes; a failure is kept too)
  boot-checks.js               — Boot-time config checks (cycle-8 F26):
                                 sharedDatabaseProblem(env) — a reason to refuse
                                 to start when PERSISTENT_DATABASE_URL is unset or
                                 names the same host + port + database as
                                 NEON_DATABASE_URL (Per-sistant would fall back to /
                                 share Perfin's database, merging the two
                                 user_settings rows and the two AI caps);
                                 ALLOW_SHARED_DATABASE=true opts in
  views/
    login.ejs                  — PIN form + biometric button (feature-detected)
    landing.ejs                — Tile picker (the home-screen app's start page), one
                                 status line per tile (design D7)
  public/
    landing.css                — Shell-only styles
    manifest.json              — Unified PWA manifest (mask-crop PNG icons,
                                 not the placeholder SVG it had originally)
    transition.css             — Per-sistant entry transition (landing tile +
                                 Perfin nav's cross-app icon). Scoped under
                                 .atrans-*; cosmic star/nebula backdrop +
                                 particle-canvas mode styles.
    transition.js              — Auto-init module: scans for [data-atrans]
                                 triggers, binds click→activate→navigate.
                                 Primary effect: particle assembly/disassembly
                                 of the PWA icon — samples the overlay's
                                 .atrans-art <img> via canvas getImageData
                                 (96×96 grid → ~2.5px particles, capped at
                                 7500 with uniform thinning, dpr-aware up to
                                 3x) that fly in to assemble the icon, then
                                 the REAL image crossfades in at full
                                 resolution (drawImage sharpen — the finale
                                 is never just the particle mosaic), holds,
                                 and bursts apart as the image fades back out
                                 (assemble 950ms / hold 430ms / disperse
                                 520ms; navigates ~90ms before the end).
                                 Honors prefers-reduced-motion (instant
                                 navigation); falls back to the original CSS
                                 mask reveal if the image isn't ready or the
                                 canvas is tainted. HYBRID by device
                                 (prefersLightTransition): desktop (fine
                                 pointer + wide viewport) runs the particle
                                 assembly; mobile/touch (coarse pointer OR
                                 ≤768px) takes the lighter CSS mask reveal —
                                 the particle field felt heavy on phones.
    perfin-materialize.css     — Iron Man helmet stroke-draw + fill + pulse
                                 ring + particle burst + HUD scan animation
                                 (Perfin entry from landing tile + Per-sistant
                                 nav's cross-app icon). Mirrors the standalone
                                 Perfin login animation but scoped under
                                 .materialize-overlay so the two never collide.
    perfin-materialize.js      — Auto-init module: scans for
                                 [data-perfin-materialize] triggers, builds
                                 the helmet-SVG overlay lazily on first click.
```

**Other key files:**
- `design/tokens.json` — the shared design values both apps declare (design pass D6, decision 9 —
  see Shared design tokens under UI & UX; `tests/design-tokens.test.js` checks both stylesheets)
- `plaid/server.js` — Legacy Plaid server (still functional)
- `scripts/detect-subscriptions.js` — Recurring subscription detection (30/60/90/365-day cadences)
- `scripts/detect-transfers.js` — Recurring transfer detection (7/14/30/60/90/365-day cadences,
  6 transfer types: peer_transfer, bill_payment, savings, investment, internal, other)
- `scripts/sheets-sync.js` — Google Sheets sync (16+ tabs). `syncAll` runs each
  tab in isolation (per-step try/catch) and returns an `errors[]` array, so one
  failing tab no longer aborts the rest mid-run and leaves a half-updated sheet.
  Core 7: Transactions (with splits inline + Source/Reimbursed columns),
  Subscriptions (with Days Until countdown), Utilities, AI Insights
  (with structured running summary + user feedback), Recurring Transfers,
  Tax Deductions YYYY (one tab per year), Dashboard (with category sparklines + heatmap).
  Strategic adds: Investments, Net Worth History (monthly), Income,
  AI Trust, Categorization Rules, Manual Bills (all categories),
  Bill Payments Log, Important Dates (90-day upcoming), Watchlist
  (user-curated merchant/category/keyword monitor). Plus per-month
  archive tabs (`YYYY-MM Transactions`) created once a month is settled
  and rebuilt when its content fingerprint changes (cycle-7 F85). Intentionally standalone — does not import the
  route/services layer, so `incomePredicate` / `NOT_TRANSFER` /
  `SPLIT_AMOUNT` are duplicated from `services/financial-queries.js` —
  their full structure is byte-pinned (whitespace-normalized) by SX3 in
  `tests/audit-regressions.test.js`, so a drift fails CI.
- `scripts/import-csv-cli.js` — Standalone CLI for importing bank CSVs. Shares
  the route's logic via `teller/data/csv-formats.js`: content-only
  `detectCsvFormat` (no filename heuristic), the same `makeCsvTxnIdGenerator`
  dedup-ID generator (wrapping `csvTransactionId`), AND the same
  `INSTITUTION_LABELS` map. Both derive the
  default account label (`"<institution> Account"`) from the detected format,
  so when the caller doesn't supply an explicit label the CLI and the
  `/api/import-csv` route produce **identical** dedup IDs for the same row
  (F2). The generator assigns a DETERMINISTIC per-tuple occurrence index so two
  genuinely-distinct rows sharing (label, date, amount, merchant) within one
  file — e.g. two identical same-day coffees — get distinct IDs instead of the
  second silently deduping against the first (F1). Occurrence 0 hashes
  byte-identically to the legacy single-arg `csvTransactionId`, so existing
  csv_* IDs stay stable and re-importing the same file still deduplicates
  against itself. The route still honors an explicitly-provided `institution` /
  `account_label` (e.g. the web dropdown) — those are intentionally separate
  accounts. (Earlier the CLI used a divergent, row-index-based ID and
  filename-based format detection — audit H8/F29/F31, now resolved.)
  Each row INSERT runs under `SAVEPOINT csv_row`, so one bad row is skipped
  instead of silently rolling the whole file back; the CLI exits 1 when ANY
  file failed and writes the files it did import to `$CSV_IMPORTED_LIST`
  (cycle-7 F19). `--positive-means=charges|deposits` sets a GENERIC file's
  sign (default charges, the route's default too); the CLI warns when its
  guess differs but never applies the guess unasked (cycle-7 F26).
- `scripts/retention-cleanup.sql` — Reference SQL for the manual cleanup queries
  exposed by `POST /api/cleanup`
- `scripts/reset-fresh.js` — Guarded fresh-start reset (`npm run reset:fresh`).
  Wipes all historical data + user config (transactions, insights, goals,
  budgets, rules, snapshots, watchlist, …) and resets `user_settings` to a
  single default row (keeping the backup record — `last_backup_at` / `last_backup_source`,
  cycle-8 E4a), but PRESERVES the bank-connection layer
  (`teller_enrollments`, `plaid_items`, `plaid_investment_items`,
  `linked_accounts`, `sync_cursors`) and device auth (`webauthn_credentials`,
  `push_subscriptions`) so no re-linking/re-registration is needed. Resets the
  sync watermarks (Plaid cursors → '', Teller `last_synced_txn_date` → NULL) so
  the next sync re-pulls full clean history. Dry-run by default (prints per-table
  row counts); only mutates with `--yes` / `CONFIRM_RESET=YES`; runs in one
  transaction. Three exported lists: `WIPE_TABLES` (incl. `investment_flows`,
  `payee_obligations`, `payee_payments`, `settlements`, `payee_obligation_skips`,
  `deleted_transactions`, `merchant_rename_rules`, `investment_transactions` (re-synced
  from Plaid like transactions, roadmap T3.3 K1), `tax_documents` (T3.3 K2) — PSC-6: missing them left
  flows pointing at re-used `investment_accounts` ids after `RESTART IDENTITY`),
  `KEEP_TABLES`, and `UNTOUCHED_TABLES` (`schema_migrations`, `job_runs`,
  `benchmark_prices`, `app_errors`, `webhook_events`). `tests/scan-sept-batch9.test.js` asserts every table the
  migrations create is in exactly one list — add a new table to one of them.
- `apps-script/Code.gs` — Google Sheets Apps Script (standalone + server sync).
  Its column-index writes assume the script's own tab layout, so
  `assertScriptLayout_` checks the Transactions / Subscriptions headers before
  writing and throws on a server-sync layout instead of corrupting it (SXE-15) —
  point it at a SEPARATE spreadsheet from the server `GOOGLE_SHEETS_ID`. Its
  category column prefers the app category over Plaid's PFC
  (`txn.category || txn.pfc_primary`). Every data `setValues` / `appendRow`
  goes through `guardRows_` / `guardCell_` (cycle-7 F84 — the server script's
  formula guard, ported: text starting `= + - @` tab/CR is `'`-prefixed, plain
  signed numbers pass); only the fixed header rows are written unguarded. Ships
  via clasp, not the Render deploy.
- `tests/` — Perfin test suite (node:test runner). Includes
  `tests/audit-regressions.test.js` which pins documented behavior for
  auth, SSO, template hygiene, exclusion rules, and the S1-S4 / #8 / #19
  feature contracts, and `tests/new-endpoints.integration.test.js` which
  uses a mock-pool + supertest pattern to exercise the feedback, whats-new,
  performance, and trust-overview endpoints end-to-end. Run `npm install`
  at the repo root before `npm test` (root `package.json` declares the
  test-time deps separately from `teller/`). `npm test` now runs both
  Perfin and Per-sistant test files (3109 tests as of latest); use
  `npm run test:perfin` or `npm run test:persistent` for scoped runs.
  Current count: 3109 tests across 170 test files (incl.
  `tests/cycle8-e4a.test.js` — cycle-8 E4a (ST5): certExpiresAt on a fixture certificate, localChecks' expiry branches
  (expired → fail, within 30 days → warn, the compromised cert first), each goLiveChecks branch over an injected env and
  a fake pool (the Teller cert missing with live / suspended enrollments, the shared database under the shell only,
  PUBLIC_URL's shape, API_KEY / SHELL_SECRET strength, Plaid env ↔ secret and sandbox with GOOD items, the Teller
  webhook secret's parts), no secret value in any output, a failing read omitting its check, backupCheck's modes (no
  token / SERVER_BACKUPS / a token without it → none), getOperatorChecks → toIssues, db-backup.yml's stamp step last and
  silent, and backup.sh / the migration / reset-fresh keeping the record;
  `apps/per-sistant/tests/cycle8-e3e.test.js` — cycle-8 E3e (ST2), Per-sistant's half of one alert per item:
  perfinPushedItems (standalone / no items → no query; only push_state sent within 12 h for these items; a failed read
  → none), annotateNotify marking an item Perfin pushed notify:false while keeping the entry, housingItem (the month of
  the line's due date), openLinkedItems (open untrashed tasks for these keys, fail-soft) and housingDueUnlessTask hiding
  the line only for its own month's task, and GET /api/notifications/check (housing_due with its item and notify:false
  once Perfin pushed it; left out while its task is open, the task's own entry carrying the item);
  `tests/cycle8-e3d.test.js` — cycle-8 E3d (ST2): sendToAll with an item over a fake notification_log and a fake
  Per-sistant pool wired as the shell wires it (an open linked task → covered, logged read with its item_key, `logged`
  true, nothing pushed; a closed task, a failed lookup or standalone → pushed; muted before any lookup; no item or a
  malformed / "perfin:"-prefixed one → no lookup; covered beating quiet hours and push not configured; the release job
  covering a held row whose task opened since), stillChargingItem equal to the still-charging task's key, the watchdog
  and runHousingReminders passing housing:<period> / utility-amount:<id>, and the bell's covered words in a vm;
  `tests/cycle8-e3c.test.js` — cycle-8 E3c (G2): Settings → Quiet Hours & Muting run in a vm from settings.ejs (the
  switch, times and zone filled from GET /api/settings, a box per mutable kind grouped by app — Per-sistant's only under
  the shell, security / test never listed, escaped — every save through PATCH + writeOk with a refused or failed save put
  back, an empty or equal pair of times refused before any request, the labelled markup in Alerts & Notifications before
  Cash Alerts and its wiring) and the bell naming a held / expired / muted push (nav.ejs renderList in a vm) — with
  `apps/per-sistant/tests/cycle8-e3c.test.js` (annotateNotify, perfinNotifyPrefs read-only and fail-soft, the check's
  kind / notify / quiet, no browser notification for notify:false while the Reminders list keeps it, the Settings link);
  `tests/cycle8-e3b.test.js` — cycle-8 E3b (G2): sendToAll over a stateful fake notification_log + a stubbed web-push
  (outside quiet hours sent, inside held with the gate open at the end, a muted kind logged and never pushed, security /
  test never held or muted, a failed settings read holding nothing, a hold whose row didn't write pushed at once, push not
  configured → none, the 60 s prefs cache and invalidateNotifyPrefs), releaseHeldNotifications (still quiet, one as itself,
  several as one summary, the 12 h expiry, a kind muted since, a failed push left held, a hold during a release keeping the
  gate open, quiet hours switched off), the critical-alert email's mute and every caller's kind, the settings PATCH, the
  notify-release job's cadence, gate and outcome;
  `tests/cycle8-e3a.test.js` — cycle-8 E3a (G2): the kind catalog (unique keys, security / test unmutable), kindOf over
  today's tags, a source scan that every tag literal a notification is sent with and every Per-sistant check type maps to
  a named kind, isQuiet (the midnight wrap and its edges, a same-day window, off / malformed, another zone, an invalid zone,
  both 01:30s of the night clocks go back), decide's order, normalizePrefs, the PATCH parsers, PATCH /api/settings
  refusing or storing both fields and GET's normalized fields + catalog, the migration;
  `tests/cycle8-e2d.test.js` — cycle-8 E2d (ST3): parseSeenToken's accepted / refused shapes; GET /api/whats-new reading
  the mark first and returning seen_token, by id with a stored id, by created_at without one and for the daily digest;
  /seen storing the token (capped, forward only), a malformed token a 400 with no write, the token-less fallback; the
  migration; the widget run in a vm from dashboard.ejs posting the token as JSON 4 s after rendering;
  `tests/cycle8-e2c.test.js` — cycle-8 E2c (ST3): services/txn-watermark.js's mark, window (and its overlap-hours guard)
  and never-backwards advance; runAnomalyCheck on it (the mark read before the candidates, the window's parameters, the
  transaction_id dedupe in the candidate SQL, data.transaction_id on the push, an unlogged or thrown push holding the
  watermark, an empty table, no pg_stat_activity read left); runPaydayLanded's overlap (an unannounced overlap deposit
  announced, an announced one skipped, an unlogged overlap deposit leaving the id put) and the migrations' backfill SQL —
  F1 / F51's created_at tests in broad-scan-c8-batch4 were replaced by it;
  `tests/cycle8-e2b.test.js` — cycle-8 E2b (ST1): startup.js's registry (every JOB_INTERVALS_MS job at its cadence plus
  the watchdog, lightest first; only the five activity-gated jobs gated; no setInterval or boot timer left) and its
  scheduling under mock timers (nothing before the first check, then the job_runs read and every job claimed once 20 s
  apart, every watched job ticked; a restart right after a run → only the read; a stop before the first check → nothing;
  a second start replacing the runner) — F27's boot-run tests in broad-scan-c8-batch1 were replaced by it;
  `tests/cycle8-e2a.test.js` — cycle-8 E2a (ST1): the job runner over a fake job_runs with one clock — registration
  checks, the one read at the first check and no query when nothing is due, due jobs run once oldest-due first with the
  gap, a time loaded from job_runs respected, another process's claim (not run, its time taken), a failed read / claim,
  a closed or throwing gate (no query, still due, run once open), a throwing run, no overlapping checks, onCheck,
  start / stop incl. a stop mid-check, unref'd timers, the SQL and the migration;
  `tests/cycle8-e1-followons.test.js` — the cycle-8 E1 follow-ons: an incoming transfer's forecast setting a 400 apart
  from an unknown one's 404, the rename re-key copying a forecast setting onto the surviving row before the old row is
  deactivated, the batch restore counting a lifted legacy tombstone as `cleared` and a legacy manual entry as
  `unrestorable`, the batches' `restorable` and Settings' header for a partly restorable batch in a vm, the legacy
  batch backfill's SQL and ids, and the e2e config's PW_CHROMIUM_PATH;
  `tests/cycle8-e1c.test.js` — cycle-8 E1c (G5): the batch id's format, Resolve tagging its tombstones and a single
  delete clearing it, the batch restore over a fake client (400 before connecting, 404 + rollback, restored / already
  present / account gone / removed by the bank with only the restored tombstones lifted and the rules once, a throw
  rolled back), the list's batch_id + batches and Settings' "Restore all N" in a vm (labelled, escaped, the message,
  the reload, a refusal / network failure re-enabling it);
  `tests/cycle8-e1b.test.js` — cycle-8 E1b (G1): "What's in this forecast" run in a vm from dashboard.ejs (both lists'
  text, each reason in words, the labelled selects per transfer / subscription, escaping, the empty states, the PATCH
  per source through writeOk, the section + summary reloaded on success only, a refused / failed save reverting, focus
  kept, the delegated listener, the collapsed markup);
  `tests/cycle8-e1a.test.js` — cycle-8 E1a (G1): the treatment matrix over the card-autopay / internal-move / plain
  shapes, classifyBills' tags, getCashFlowInputs' SQL + bills / left_out, the totals moving with the settings, GET
  /api/cash-flow's forecast_items, both PATCH routes' 400s / writes / 404s / invalidate, the CHECK_LISTS migration and
  no detector writing the columns;
  `tests/roadmap-t4-1-a10.test.js` — roadmap T4.1 A10: normalizeLimits / periodsLeftInYear, contributionRoom (a
  limit against this year's contributions, the per-paycheck amount rounded up, reached, a Plaid account whose flows
  haven't synced, a gone account or $0 limit left out, the investing-step pointer), applyWhatIf / whatIfPlan (an extra
  payment raising that debt's minimum, income / spending moving every month row and the lowest projected day, the
  step / amount / payoff / interest comparison and its text, matching by exact name / mask then one partial match,
  every refusal), the reader's SQL and a failing read, PATCH /api/settings contribution_limits, the Settings editor in
  a vm, the card, the cash_plan block and Ask's overrides;
  `tests/roadmap-t4-1-a9.test.js` — roadmap T4.1 A9: sinkingFunds (each quarterly / yearly bill of $100+, its date
  equal to cadence.seriesOccurrences / manualBillOccurrences — a stale next_expected projected from today — the
  set-aside rounded up until then and the steady amount after, a bill due within a month, soonest first, at most 8;
  monthly / small bills left out), subscriptionReview (an overlap's save range, word boundaries, the monthly
  equivalent, a bundle counted in its first group; a membership with no other store purchase in 90 days — the fee
  itself, a new membership and Prime Video not flagged), the plan's fields and a failing read, the readers' SQL, the
  card, the cash_plan block and Ask;
  `tests/roadmap-t4-1-a8.test.js` — roadmap T4.1 A8: the liabilities sync writing a card's last statement balance
  and date ($0 kept) and the migration's columns; nextStatementDate (a month on, the day clamped — Jan 31 → Feb 28 →
  Mar 31 — stale / future / malformed → null); the carried test reading the statement (under 95% after it carried, at
  or above paid in full, a payment before it → the minimum rule, interest first); the tip naming the close date, else
  the due date; loan extra payments equal to computeLoanPayoff (a low-APR note; a funded loan, no APR / 0%, no payment,
  a payment that never pays off → none); the card, the cash_plan block, Ask and the audit's loan figures;
  `tests/roadmap-t4-1-a7.test.js` — roadmap T4.1 A7: normalizeTargets / assetAllocation (shares, drift, the
  known-basis value, a targeted class with none at 0%) and GET /api/investments/performance reading the helper's
  drift; checkingLow (the lowest summed balance with each account carried forward, not enough history → null,
  today's lower balance); idleDestinations (savings by subtype, a brokerage that isn't tax-advantaged); rebalanceMoves
  (a 20-point overweight moved, within 5 points no move, largest-to-largest pairing, no holding named); idle cash per
  step (Visa first on the debt step, the emergency fund to savings, investing only to a brokerage, the projected-low
  cap, under $500 / nowhere to move it / not enough history / a failing read → none); the readers' SQL; the card,
  the cash_plan block and Ask;
  `tests/roadmap-t4-1-a6.test.js` — roadmap T4.1 A6: detectRaises over canned deposits (a biweekly step-up with its
  cadence from the stream or the gaps, noisy pay, too small / too old / one raised deposit, a bonus inside the run),
  detectBonuses (1.5× and $500, a one-off at $1,000, a level of two big deposits, the 45-day window), splitWindfall in
  the plan's order (the state carried to a second lump), spendingCreep (15 points faster than income and $50, the
  base, Uncategorized, a missing month, the top 3), the plan's texts (toward the current step, the bonus measured
  without itself, a failing read null with its sentence), the readers' SQL, the card in a vm, the cash_plan block,
  the audit's plan figures, Ask, and the plan-change push naming a new raise or bonus once;
  `tests/roadmap-t4-1-a5.test.js` — roadmap T4.1 A5: monthsUntil / requiredMonthly (the annuity deposit at the
  goal's rate), goalCatchUps (behind with the per-paycheck amount rounded up and its text, on track within $5,
  interest lowering the need, due / overdue / reached / no date, per month without a paycheck), the emergency
  tracker in each step (the emergency step's and the starter buffer's pace, after the high-interest debt with
  its note, reached, nothing going toward it), the goals source (its SQL and deriveGoalProgress on a funding-
  linked goal; a failing read still a plan), the "Your plan" card in a vm (the labelled progress bar, the pace,
  only behind / overdue goals, escaped), the cash_plan block, the audit counting a goal's catch-up and Ask's
  get_cash_plan;
  `tests/roadmap-t4-1-a4.test.js` — roadmap T4.1 A4: planChange (no change without a baseline or when nothing moved, a
  new step, a debt step's new target, the amount needing both 20% and $50, a paycheck/month unit change compared
  monthly), signatureOf / changeText over real buildAdvicePlan plans ("Visa is paid off — your plan now puts $450 per
  paycheck toward the emergency fund.", the next debt taking over, a card now paid in full counting as paid off, a
  still-owed target, an amount move with what it was, a $0 amount or the minimums step using the plan's headline),
  runAdviceAlerts over a fake pool (off → one settings read a day until invalidate(), the silent baseline, at most one
  evaluation a local day, unchanged, one push with tag advice-plan and no email, an unlogged push retried, no plan, a
  slow drift compared with the last notified plan), the advice-plan job's outcome and wiring, and Settings (400s, the
  baseline reset on switch-on, the memo cleared, GET's default, the migration, the labelled checkbox);
  `tests/roadmap-t4-1-a3.test.js` — roadmap T4.1 A3: the cash_plan module, cashPlanPromptBlock over a real
  buildAdvicePlan (headline, steps, per-debt amounts per paycheck, the assumed APR, surplus, snowball, tips,
  notes, disclaimer, sanitizeForPrompt, "none sustained", a plan that couldn't be worked out),
  seedPlanActions (first, urgency by step, replacing an earlier entry and the model's copy,
  first_recommended kept for the same step, the 10-item cap, no plan → untouched), the audit's
  planFigures / planClaimFinding (a matching figure, >20% critical, 5–20% warning, a named debt's monthly
  figures, hypotheticals and figures without a period not plan claims, no plan → nothing) and auditInsight
  with and without the plan, and generateInsights end to end (the block and instructions, the debt
  optimizer pointed at the plan, the seeded summary, the cash_plan finding, a throwing read in
  modules_failed, ok:false, a truncated run unseeded, cash_plan:false unchanged);
  `tests/roadmap-t4-1-a2.test.js` — roadmap T4.1 A2: GET /api/advice (the plan, ok:false still 200, a fixed
  500, mounted after dashboard-summary), the "Your plan" card run in a vm over a real buildAdvicePlan (the
  headline, the current step aria-current, the per-debt table per paycheck / per month, an assumed APR, "—"
  for a debt on its minimum, red only for a minimum that never pays off, the tips, notes and disclaimer, the
  empty state, the ok:false line), its loader (success, refusal, network failure), the markup between Review
  Uncategorized and the charts with its widget key, and Ask's get_cash_plan (executor, trimmed debts, ok:false,
  the prompt line);
  `tests/roadmap-t4-1-a1.test.js` — roadmap T4.1 A1: services/advice.js over canned inputs — each step as
  the headline (invest, the starter buffer ahead of a 24% card and uncapped by the floor, high-interest
  debt, the emergency fund, medium debt 50/50, minimums not covered), the avalanche (APR order and its
  tie, overflow, rollover, the snowball line, a minimum that never pays off), APRs / minimums / carried
  balances (an assumed 22%, an estimated minimum, a 0% card, every carry case, a paid-in-full card's
  utilization tip, a card with no activity, a loan with no APR / payment, a ≥ 8% loan), the surplus (the
  bar over completed months only, a month under it, a short history, savings transfers taken off,
  nothing left, the cash cap and its months, the default floor), per paycheck (the largest stream,
  rounding down, biweekly, per month without a stream) and the fail-soft reads (one read per source, a
  non-critical failure still a plan with no error text, each critical source → no plan, the readers'
  SQL) — the database-backed half is `tests/contract/advice-a1`;
  `tests/broad-scan-c8-batch8.test.js` — cycle-8 broad scan Batch 8, Perfin's side: `checkValues` over
  stored definitions, `syncInListChecks` over a fake client (an unchanged CHECK untouched in any order, a
  new value replaced NOT VALID, a missing one added, a quote escaped) and the CREATE TABLEs interpolating
  `CHECK_LISTS`; the error log's prune on an empty buffer (once a day, no other query); `sharedRead`
  (single-flight, the 30 s cache, a failure kept, per pool) and a landing read past its budget shared by
  the next visit — with `apps/per-sistant/tests/broad-scan-c8-batch8.test.js` (the pool's DATE parser,
  `calDate` / `ymdOf`, the calendar's ICS day and a month-end projection under Asia/Tokyo and
  America/Los_Angeles in child processes);
  `tests/broad-scan-c8-batch7.test.js` — cycle-8 broad scan Batch 7, Perfin's side: the Tax page script
  in a vm over a list that parses its markup (notes typed in another row and the focused control carried
  across a reload, a vanished button handing focus to its row's notes box, an older reply for the same
  year dropped, a double tap on a row button / Add / Suggest sending one request), Show more re-enabled
  after a failed load, updateSetting's true / false and saveToggle / toggleModule putting a refused
  switch back, the account-floor Save's network failure and single save, the collapsible heading's
  keydown ignoring its select, the Undo toast paused while hovered / focused, closed only by Undo /
  Dismiss, focus moved by action.focus, and the Accounts rows' institution-named buttons and one Plaid
  update per double tap — with `apps/per-sistant/tests/broad-scan-c8-batch7.test.js` (search Pin /
  Unpin sending the opposite state, the widget and /search page dropping a stale reply — before and
  after its body — and the widget's error line, the fetch wrapper's return_to, the Health / Analytics
  heatmaps' days under America/Los_Angeles in a child process);
  `tests/broad-scan-c8-batch6.test.js` — cycle-8 broad scan Batch 6, Perfin's side: the audit's
  CROSS_PERIOD_RE over year / week / quarter phrasings (and the this-month and unqualified claims
  it leaves checked, "a quarter of your spending" among them), namesOtherMonth / claimNamesOtherMonth
  for this month's name in another year ("last November", "November 2025", a bare "In 2025" — never
  an amount like "$2025"), creditScoreSummary's same-type delta and range with the other types
  listed, and the weekly digest tick's 07:00 gate (no DB read before it, the day not settled) — with
  `apps/per-sistant/tests/broad-scan-c8-batch6.test.js` (quoted frontmatter keys, an unreadable
  privacy-key line private, VAULT_PARSE_VERSION 3, a refusal a charged 422 on adjust-tone /
  review-summary / the briefing and never cached, Ask's "couldn't process") and Ask's charge failure
  in `tests/ai-cap-charge.test.js` — the database-backed half is `tests/contract/c8-batch6`;
  `tests/broad-scan-c8-batch5.test.js` — cycle-8 broad scan Batch 5, Perfin's side of the linked
  tasks: computeLinkedTasks' manual-bill `retain` (every unpaid occurrence from the bill's creation
  month up to the 30-day window, a paid one left out, payments read from the earliest creation
  month) and the runner handing it to Per-sistant, the hourly tick's once-a-day gate (fresh with no
  read after a clean run, the next day / a kick / Run now / invalidate() running, a partial run
  retried) and the kick pins (housing config, manual bills, generated obligations) — with
  `apps/per-sistant/tests/broad-scan-c8-batch5.test.js` (a tombstoned key never inserted + db/031's
  trigger, retain keeping a task open and never creating, a quiet auto-close, the completion counts
  without auto-closed tasks, the linked-task webhook / Slack payload, BEGIN → lock → COMMIT with
  creations announced after COMMIT and a failure rolled back, housingDueUnlessTask) — the
  database-backed half is `tests/contract/c8-batch5`;
  `tests/broad-scan-c8-batch4.test.js` — cycle-8 broad scan Batch 4: runAnomalyCheck over a fake
  pool (the text watermark, the high-water mark read before the candidates with its writer bound,
  the candidates bounded by it, the never-backwards text update, no read or update with nothing
  new, a failed push holding the watermark), runPaydayLanded's 24 h overlap (an unannounced overlap
  paycheck announced, an announced one skipped through one notification_log read, the GREATEST
  update, no read without a stream match) and the Plaid verifier's key lookups (the miss cache and
  its expiry, the 20-an-hour cap with a cached key still verifying, one lookup per kid, a malformed
  kid / stale iat / wrong body hash refused before any lookup, a 4xx cached and a 5xx not) — the
  concurrency half is `tests/contract/c8-batch4`;
  `tests/broad-scan-c8-batch3.test.js` — cycle-8 broad scan Batch 3: restore over a fake client
  (a bank-removed row a 409 with nothing written, a bank-changed one restored stale, an active
  rule's current name applied, a deleted / switched-off rule's rename cleared, a hand rename kept
  and every rule applied on the client), the stale restore toast run in a vm, createRenameRule
  releasing another rule's rows and re-keying only the vacated keys, reconcileTeller renaming the
  rows it recovered through the real Teller engine without the anomaly check, and source pins for
  the detection upsert's prior_amount / amount_changed, the watchdog's early rise, the Plaid
  tombstone hooks, Resolve's tombstones and the income sources' grouping — the SQL half is
  `tests/contract/c8-batch3`;
  `tests/broad-scan-c8-batch2.test.js` — cycle-8 broad scan Batch 2: the forecast's two transfer
  flags through getCashFlowInputs (internal moves and linked-card payments left out, a transfer to
  someone else, a brokerage contribution and a utility autopay billed) and the card / utility
  names, fee rows not netted against income and a dividend reversal still netted, a buy to cover
  not a lot, an unlogged "Paycheck landed" holding the watermark, the low-cash alert's notify →
  clear → held / 72 h / 3-days-earlier memory, the forced evaluation after invalidate() (kept
  after a throw), documents.csv's dismissed day under America/Los_Angeles and the int4 id 400
  before any query — the SQL half is `tests/contract/c8-batch2`;
  `tests/broad-scan-c8-batch1.test.js` — cycle-8 broad scan Batch 1: every job in
  `job-health.JOB_INTERVALS_MS` run once after boot under node:test mock timers (none before
  the first boot delay, all once the stagger has passed, none after stopBackgroundJobs), the
  boot plan's stagger, the not-due / off memos for bank auto-sync, the reconcile and the
  insights trigger and PATCH /api/settings dropping them through the real router,
  `safeReturnTo` against tab / CR / LF / DEL payloads, `sharedDatabaseProblem`, the Teller
  self-heal through the real engine (all fetches failing or no accounts → stays
  DISCONNECTED; one answered → GOOD), the webauthn challenge cap through the real router and
  the two limiters' wiring;
  `tests/design-d7.test.js` — design pass D7 (decisions 13 / 14): `landingStatus` over injected
  readers (both lines, each fail-soft on a sync or async throw, a slow read cut off at its budget
  while the other line shows, nothing when both fail, no read without a pool; the Perfin line from
  gatherDashboardSummary with parts rent / bills / uncategorized only), the summary's `parts` option
  (only the named readers called, the rest left out; every part without it), Per-sistant's
  `taskDueCounts` SQL, landing.ejs rendered with and without lines (escaped) and the shell route
  behind the gate, the drawer's Tax link run in a vm with the real `taxSeason` (January–April only,
  never on the desktop nav), the Activity Filters toggle's row and touch height, transactions.ejs
  rendered through EJS;
  `tests/design-tokens.test.js` — design pass D6 (decision 9): `design/tokens.json` against both
  apps' CSS — every shared value (status colours per theme, type scale, spacing, radius, button
  heights) declared with the spec's value under each app's own name and in the right scope
  (Perfin :root / [data-theme="light"], Per-sistant :root / body[data-mode="dark"] + the legacy
  html[data-theme="dark"] body), the app-specific names present but never compared, no palette
  setting its own status colour, both apps' card radius the shared one and the buttons on the
  height / radius tokens — with `apps/per-sistant/tests/design-d6.test.js` (Per-sistant's
  `emptyState` run in a vm from the emitted primitives bundle — escaping, BASE_PATH, a same-app
  path only, the delegated click — each listed empty state's next step and its button on the
  page, no uppercase / monospace button rule, the filled primary, and a Title Case label scan);
  `tests/design-d5.test.js` — design pass D5: the seven Settings groups in order with each
  section in its group, every pre-D5 id still on the page once, every `/settings#…` anchor the
  code links to present, buildSettingsIndex run in a vm (every titled group in the index and the
  Jump to select, escaped, an untitled one left out), revealHashTarget (a closed <details>
  opened, scrolled to, its group marked; an unknown / empty / malformed hash ignored), the
  labelled select (IF-3), the CSS (sticky index and hidden select only at ≥961px, the anchors'
  scroll margin, D1's 860px) and settings.ejs rendered through EJS standalone and under /perfin;
  `tests/design-d4.test.js` — design pass D4: the decision-6 section order on the page and
  `DASHBOARD_WIDGETS` in that same DOM order (every selector found, 21 keys since T4.1 A2, the summary not a
  toggle), `applyDashboardWidgets` hiding exactly the switched-off key; the pyramid's
  collapsible markup, `collapsedFromStore` (a stored choice wins, phone-collapsed only for a
  phone-default section) and opening storing '0'; the tabs' no-wrap scroll row and
  `scrollActiveTab` run in a vm (centred, a row that fits untouched, no row); Cash Flow's
  4 weeks + "Show all 13 weeks", "—" for a $0 income / bills cell, the lowest day first and
  Show all / Show fewer; Savings Rate's latest month + "Show all 3 months" run through the real
  loader; the real `loadCharts` with 1 / 2 / 3 / 0 months; and dashboard.ejs rendered through
  EJS standalone and under /perfin (a CSS escape inside the extraStyles template literal is an
  octal escape that 500s the page);
  `tests/design-d3.test.js` — design pass D3: gatherDashboardSummary over a fake pool with every
  reader injected as a spy (every field, each helper called with the pool and the summary's own
  day / month, each failing reader isolated with its fixed sentence and logged once — never the
  error text — a synchronous throw contained, the net-worth none / same-day / change cases, the
  attention rules and hrefs), a source scan that the module's only SQL reads net_worth_snapshots,
  the route answering 200 with every part failed when the database is down, the shared helpers
  (getBillsDue — forecast + manual bills, a paid one left out; /api/forecast's shape through
  forecastCharges; ledgerTotals / getHousingOwed payee-scoped and unread while off;
  countUncategorized and gatherDataHealth behind their routes) and the Summary card / Needs
  attention renderers run in a vm from dashboard.ejs (figures, the red over-budget bar capped at
  100%, the not-yet and failed states escaped, same-app links through withBase only, the quiet
  tick, a failed source never "Nothing needs attention", the one-line load failure);
  `tests/design-d2.test.js` — design pass D2: `emptyState` run in a vm (escaping, an href through
  `withBase`, only a same-app path linked, no control without an action, the click action pressing the
  page's existing button), each listed empty state's action and the `#ai-insights` anchor, no uppercase
  transform on any Perfin button rule, the filled primary + `--on-warm` in both themes, a scan for Title
  Case button labels, the Activity row renderer run in a vm (a charge plain, a credit `+$X` green), the
  dashboard / Accounts / Calendar / cash-flow money classes and the Rent page's `isOverdue` in a vm;
  `tests/design-d1.test.js` — design pass D1 (`.cycle/plan-design-ux.md`): the real `fmt` in a vm
  (-$X, thousands separators, never -$0.00), the investment return and the Goals FIRE formatter's
  sign, the dashboard Review widget's `renderReviewQueue` in a vm (a calendar date under a west-of-UTC
  TZ, "Choose a category" + Apply disabled + Remember unticked without a suggestion, the suggestion
  selected + Remember ticked with one, an unlisted suggestion offered, the change handler enabling
  Apply, a disabled Apply styled as disabled, Apply's empty-category guard) and the page width (one `.container` width, no page view with
  the nav setting its own, the narrow pages on `#main-content`) — with
  `apps/per-sistant/tests/design-d1.test.js` (every sidebar entry has an icon, the dashboard stat
  tiles coloured by value in a vm, two tiles per row on a phone, the legacy attachment copy after
  `runMigrations` and never at router construction);
  `tests/roadmap-t3-3-k4.test.js` — roadmap T3.3 K4: taxSeason run in a vm (January–April → last
  year, in season; May–December → this year); public/tax-page.js run in a vm over a fake DOM — the
  default year by month, ?year= (2000..this year, an older one still listed), the downloads and URL
  following the select, a card per section with a CSV link through the mount base and none for a
  failed section (its sentence, the overview's "Not available"), escaping, the checklist's labelled
  controls and Delete only on a manual row (data-e2e-skip), every write through writeOk (received /
  dismissed / notes / add / suggest / delete after a confirm) reloading only on success, the list's
  click delegation, both halves' failed loads, a slower older-year load never overwriting a newer one;
  the dashboard's January–April link run in a vm, the Settings link, the view (script after
  perfin-shared.js, the #documents anchor) and the mounted page route; GET /api/tax/package's section
  CSV equal to the ZIP's file — tax.ejs also joins the IF-3 label scan;
  `tests/roadmap-t3-3-k3.test.js` — roadmap T3.3 K3: crc32 against the standard check values and a
  bitwise second implementation, createZip read back by a parser in the test (local headers against the
  central directory, the end record, each file's CRC, names, bytes, the DOS date / time) and its name
  refusals, the DOS time from UTC under a forced west-of-UTC zone; /api/export/tax-report and
  /api/housing/export CSV + JSON byte-identical to snapshots taken before the refactor, each route reading
  through the shared definition, getTaxDeductionReport unannotated when the annotation read fails and
  getHousingPayments naming the configured payee over a payment's; gatherTaxPackage over injected
  readers (every section, the investment read shared by three, each failing reader marking only its
  section(s) with its fixed sentence — never the error text — a synchronous throw contained, the year
  rule) and with the REAL readers over a SQL-routed fake pool; every section's CSV (the formula guard
  on a `=HYPERLINK(…)` merchant / source / security / issuer / memo, an unknown basis blank, deductions.csv
  = taxReportCsv, rent_paid.csv = housingPaymentsCsv, a failed section's sentence); the PDF (%PDF, a
  bookmark per section, the disclaimer on the first and last page, a failed section's sentence); the ZIP's
  nine files; GET /api/tax/package's 400s before any read, json / pdf / zip types and names, a fixed 500;
  `tests/roadmap-t3-3-k2.test.js` — roadmap T3.3 K2: parseTaxYear / expectedBy, computeSuggestions with
  each source injected (a W-2 per payroll source and one per issuer in any case, a 1099-INT at $10 —
  the larger of bank and brokerage interest, never their sum — a 1099-DIV at $10 of dividends +
  distributions, a 1099-B per brokerage with its sales, a 1099-R, the 1098 family, a failing source a
  fixed sentence while the others suggest), suggestTaxDocuments' ON CONFLICT DO NOTHING (never DO
  UPDATE) counting only new rows, listTaxDocuments' order and states (a form due today still
  waiting), getIncomeForYear's SQL (the year's DATE bounds, INCOME_AMOUNT, the canonical predicate) and
  aggregation, the routes (the year 400s before any read, form / issuer / date / notes 400s, a
  manual row with the usual deadline, a duplicate 409, strict booleans, received stamping today, 404s,
  a suggested row's DELETE a 409, the refresh kicked only on a change, a fixed 500), the tax_documents
  linked tasks (past expected_by only, Per-sistant's checks, on by default, isolated, unread when off),
  GET /api/settings showing the new source on, the Settings checkbox, the migration's form list and
  reset-fresh — the database-backed half is `tests/contract/tax-documents`;
  `tests/roadmap-t3-3-k1.test.js` — roadmap T3.3 K1: realizedGains over canned rows (FIFO across
  lots with a mixed short / long sale, a partly used lot, the "more than a year" edges incl. Feb 29,
  a dividend-reinvestment lot, a sale beyond known lots → NULL basis + partial / none coverage, an
  in-kind transfer in (unknown cost) and out, a cancel pair dropped, a split / reverse split flagged
  with the lots untouched, a short sale left out, same-day buy-before-sell, lots per account +
  security, the year filter), investmentIncome / retirementDistributions (a 401(k) left out of income,
  its withdrawal listed), the tax-advantaged list, getInvestmentTaxData over a fake pool (the
  year-end parameter, an invalid year rejected) and the flow sync storing each row once with its
  security (exact parameters, lowercased subtype, transactions_stored, a store failure keeping the
  flows with one error per Item), the migration and reset-fresh — the database-backed half is
  `tests/contract/tax-investments`;
  `tests/roadmap-t2-5-h1.test.js` — roadmap T2.5 H1: link-token-update's hosted request (hosted_link
  + redirect_uri on top of the update-mode body, a strict `hosted: true`, a missing redirect_uri a 400
  before anything is read), updateSessionState over session shapes, update-complete's link_token
  check (the session read first; exited / unfinished / none a 400 and a Plaid error a fixed 502 with
  nothing written and no accountsGet; a non-string token a 400; no token → no session read) and the
  Accounts page in a vm — prefersHostedPlaidLink over iPhone / iPad / touch-Mac / Mac / Windows /
  Android / standalone / Capacitor, updatePlaidItem's hosted (state saved, redirect) and in-page paths,
  handlePlaidUpdateReturn (state removed and URL cleaned before the call, the link_token sent, a
  refusal toasted, bad state reported), the OAuth return handler leaving an update return alone and
  the buttons data-e2e-skip;
  `tests/roadmap-t2-5-u2.test.js` — roadmap T2.5 U2: restoreTransaction / restoreMessage run in a vm
  from perfin-shared.js (the POST, each outcome's message, a refusal through writeOk, a network
  failure), showMsg's action button over a small fake DOM (labelled, 10 s, closes the toast and runs
  once without the toast's own click, never merged; plain toasts unchanged), the Settings → Sync Health
  → Deleted transactions section in a vm (snapshot / legacy / unrestorable rows, escaping and labels, a
  credit as -$X, Show more's cursor, Restore dropping the row and a refusal keeping it, a failed load
  and a failed Show more) and the Activity delete's Undo (restore then reload only on success, a
  refused delete without Undo, the delete buttons data-e2e-skip) — the browser half is
  `e2e/pages.spec.js` (a seeded deletion restored from Settings, the toast's Undo);
  `tests/roadmap-t2-5-u1.test.js` — roadmap T2.5 U1: the DELETE snapshotting the row + splits and
  its source under FOR UPDATE before the tombstone (404 writes nothing), restoreDeleted over a fake
  client (only current non-id columns, the splits, the tombstone lifted, an already-present row not
  duplicated, a gone account a 409 with nothing written, a pre-U1 tombstone lifted with returns_on and
  a pre-U1 manual entry a 409), the route's COMMIT / ROLLBACK / fixed 500, the list's 400s, mapping and
  keyset cursor, and the CSV preview / import / CLI skipping a tombstoned id — the database-backed half
  is `tests/contract/undelete-t2-5`;
  `apps/per-sistant/tests/roadmap-t2-4-x3b.test.js` — roadmap T2.4 X3b: renderSearchResults run in a
  vm from the emitted bundle (each Per-sistant type through BASE_PATH, the done label, the inline
  actions only when asked and never on a Perfin row, Perfin rows through linkedAppHref — a
  javascript: / protocol-relative url or base as text, an http(s) base in a new tab — escaping, an
  unknown type left out, empty / non-array "No results"); the /search page rendered under the shell
  and its script in a vm (?q= prefilled + searched, focus on load, the count, a refused query's
  message, a short query, the URL following the query, "/" focusing the box, a slower older search
  never overwriting a newer one); the Search nav entry + route; Perfin's nav link only under the
  shell; the dashboard widget on the shared renderer;
  `apps/per-sistant/tests/roadmap-t2-4-x3a.test.js` — roadmap T2.4 X3a: GET /api/search over fake
  pools (standalone no Perfin query; under the shell five read-only queries sharing the escaped
  pattern, each capped at 10; the transaction query on the display merchant / notes / category at
  Perfin's own SPLIT_AMOUNT, newest first; each result's type, detail and url; a failing query
  dropping only its results and logging once; a throw while building SQL never rejecting; q over
  200 characters a 400) and the dashboard widget's finance rows run in a vm from the emitted
  bundles (linked through Perfin's mount, escaped, no actions, plain text without a safe link, a
  non-array reply "No results") — the database-backed half is `tests/contract/finance-search`;
  `tests/roadmap-t2-4-x2c.test.js` — roadmap T2.4 X2c: POST /api/linked-tasks/run (501 standalone
  with nothing read, 409 while a run is going without starting another, 400 while off with
  the off-for-today memo cleared first, the record's shape without internal fields, a thrown
  run a fixed 500, the app's Per-sistant pool handed over, isRunning over a real run) and the
  Settings → Per-sistant Tasks section run in a vm (the last-run line with a source error by
  name, the standalone note hiding the controls, the embedded render, each field's PATCH, a
  refused save shown and its box put back, lead days refused outside 0-14, Run now's POST +
  line + message and a 409 shown; labels and wiring);
  `tests/roadmap-t2-4-x2b.test.js` — roadmap T2.4 X2b: runLinkedTasks over a fake pool with
  the computation and Per-sistant's sync injected (nothing without a Per-sistant pool; off →
  no further read that day until invalidate(), and the settings PATCH invalidates; the sync
  given only ok_kinds + desired; the state record with counts and fixed-sentence errors,
  never exception text; a call during a run sharing its promise and causing one more round),
  the hourly job's outcome (nothing when it didn't run), ensureStillChargingTask (key, shape,
  the switch / source / pool gates), every hooked route kicking the refresher, a throwing
  refresher leaving each route's 200, refreshSoon never rejecting, and the watchdog creating
  the task after marking the alert with a failure never un-marking it — the cross-database
  half is `tests/contract/linked-tasks-crossapp`;
  `tests/roadmap-t2-4-x2a.test.js` — roadmap T2.4 X2a: computeLinkedTasks over canned rows
  (rent & utilities per unpaid period inside the payment-due window — the lead edge, an
  overdue period urgent, next month's not-yet-generated rent, a skipped one left out; a
  utility amount from its due day, a past period always; manual bills from 30 days back to
  the lead — a 31st bill on the 30th, a paid occurrence left out, an overdue one high; a
  failing source out of ok_kinds while the others stay; a source switched off never read; a
  ledger not set up read as nothing due; every task passing Per-sistant's checkTask), the
  default today in a forced zone whose date differs from UTC's, the housing helpers the
  payment-due reminder now shares, PATCH /api/settings 400s + the sources merge, GET
  defaults, the migration and reset-fresh — the database-backed half is
  `tests/contract/linked-tasks-perfin`;
  `apps/per-sistant/tests/roadmap-t2-4-x1b.test.js` — roadmap T2.4 X1b: the sync's per-field
  refresh over the shared fake pool (`tests/_linked-tasks-fake.js` — an edited title kept
  across two syncs while the untouched due date / priority / url follow the source, the
  snapshot advanced, a re-run writing nothing, a detached task left alone);
  linkedTaskChip run in a vm from the emitted bundle (the mount base joined, the title and
  href attribute-escaped, an http(s) base opened in a new tab with its trailing slash
  trimmed, a javascript: / protocol-relative / backslash / relative url, an empty or
  protocol-relative base and an unknown app all plain text, no chip on an ordinary task);
  pageHead's LINKED_APP_BASES embedded vs standalone; the chip wired into the To-Dos list,
  the edit modal and both dashboard task lists; the bundles parse;
  `apps/per-sistant/tests/roadmap-t2-4-x1a.test.js` — roadmap T2.4 X1a: syncLinkedTasks over a
  fake pool (a desired key created once with the finance shape + snapshot and announced, a
  re-run changing nothing, a key that left the set closed as auto_closed and reopened when it
  comes back, a detached task never reopened or closed, a trashed row not recreated, only the
  listed kinds closed — none listed sends no UPDATE — a malformed key / another app's key / an
  unlisted kind refused, a bad title / description / url / due date / priority skipped with its
  key still desired), ensureLinkedTask once and never closed, db/030 idempotent — the
  database-backed half is `tests/contract/linked-tasks`;
  `apps/per-sistant/tests/roadmap-t2-3-cap-c4.test.js` — roadmap T2.3 C4: getAiBudgetInfo's
  sources (settings → env → $1.00, read from the pool it is given; an unreadable setting
  logged and falling back) and checkAiCap passing its pool; GET /api/ai/usage (the
  APP_TIMEZONE month's ai_usage rows by feature, spent / budget / source, a ledger error a
  500, Perfin's spend through a stubbed perfinPool and null when that read fails); the AI
  limiter skipping only GET /api/ai/usage + /models; PATCH /api/settings
  ai_monthly_budget_cents (1–10000 or null; 0, 1.5, "6abc", "", true, [100] a 400 with
  nothing written); the Settings usage card run in a vm (spend, source, breakdown, the
  Perfin line, "budget reached", a failed load, Save in whole cents / a local refusal /
  Use default → null) and the pages showing the over-cap message (dashboard briefing +
  suggestions, Today, the Review summary — never as the week's theme — and the Knowledge
  capture note), each emitted script parsed;
  `tests/roadmap-t2-3-cap-c4.test.js` — roadmap T2.3 C4, Perfin's side: persistentAiSpend
  (null standalone, Per-sistant's own spend + cap read through the pool it is given, null
  on a failure), GET /api/insights/status's persistent_ai embedded / standalone, and the
  Settings AI card's Per-sistant line — the database-backed half is
  `tests/contract/ai-usage-c4`;
  `apps/per-sistant/tests/roadmap-t2-3-cap-c3.test.js` — roadmap T2.3 C3: Knowledge on the
  capped wrappers (/api/rag/query charging one rag_query row, a refused Citations call
  charged and its prompt-cite fallback a second row, over the cap the matching sources with
  ai_cap and a note — no model call, no fallback attempt, nothing cached — an unreadable
  spend the same with ai_cap_check_failed, a cached answer free even over the cap;
  /diagram's rag_diagram row, 429 / 503 and its 400 first; /capture's rag_capture row, the
  raw note committed with ai_cap over the cap, a secret capture never reading the cap) —
  the database-backed half is `tests/contract/persistent-ai-cap`;
  `apps/per-sistant/tests/roadmap-t2-3-cap-c2.test.js` — roadmap T2.3 C2: the nine
  routes/ai.js features on ai.cappedAI (each charging its own entry_type under the cap; over
  it the seven action routes 429 with no data query and no model call — their 400s and the
  501 first — an unreadable spend 503, Ask / Smart Suggestions keeping their 200 shapes with
  ai_cap; cached briefings / suggestions free even over the cap; a cap reached between the
  gate and the call still a 429; Smart Suggestions' date and weekday in APP_TIMEZONE, run in
  child processes) and the source guard that no routes/*.js file names callAI /
  answerWithCitations (KNOWN_GAPS empty since C3);
  `apps/per-sistant/tests/roadmap-t2-3-cap-c1.test.js` — roadmap T2.3 C1: Per-sistant's
  capped AI wrappers (cappedAI / cappedCitations over a fake client — under the cap one
  call and one row with all four token counters, at / over it CAP with the figures and no
  call, a refusal charged, a thrown call not, a failed charge keeping the answer, an
  unreadable spend CAP_CHECK_FAILED with no call), monthlyAiSpendCents from the
  APP_TIMEZONE month start (two zones whose dates differ from UTC's, an invalid zone → UTC)
  throwing on a read error, and Job Radar's cappedCall delegating to cappedAI;
  `tests/roadmap-t2-2-cash-l4.test.js` — roadmap T2.2 L4: the per-account floor check
  through runCashAlerts (below → one push with the exact text and no email, at the floor
  not below, a recent alert deduped, a stale or unknown balance skipped, a negative
  balance as -$X, an unlogged floor push leaving the check unstamped, the spendable-only
  floor SQL, off → no floor read); PATCH /api/accounts/:id low_balance_floor (400s, cents,
  null clears without a type filter, a non-spendable account a 400 and a missing one a
  404, the memo reset only for a floor edit); the migration, GET /api/accounts and
  reset-fresh keeping linked_accounts; the Settings last-check text and the floor list
  run in a vm — the database-backed half is `tests/contract/cash-floors-l4`;
  `tests/roadmap-t2-2-cash-l3.test.js` — roadmap T2.2 L3: overduePayday (the grace, the
  latest within 14 days, none right after a payday); runPaydayLanded over a fake pool (off,
  the first switch-on initialising the watermark, a stream-matched deposit announced with
  its exact text and a one-off not, the watermark moving to the newest processed as text,
  a throwing send holding it back, the 5-day window, INCOME_PREDICATE) and its place as
  the third post-sync step (after the anomaly check, a failure never rejecting);
  runPaydayMissed (push + email, a deposit of any amount cancelling it, no connection /
  no clean sync after the grace never alerting, dedup, the day + sync-stamp memo, an
  unlogged push retried, off → no DB read until invalidate()); the shared tick running
  both checks in isolation; PATCH 400s, the watermark CASE on switch-on, the memo reset,
  GET default and the Settings toggle — the database-backed half is `tests/contract/payday-l3`;
  `tests/roadmap-t2-2-cash-l2.test.js` — roadmap T2.2 L2: runCashAlerts over a fake pool
  (off → no further DB read that day until invalidate(), nothing new → unchanged, a new
  day or new data → evaluates, stale / no balances → skipped, the horizon, a breach
  notifying with the exact text + opt-in email + state, held within 72 h, re-notified 3+
  days earlier or after 72 h, clear dropping the alert, a balance AT the floor not below,
  an unlogged push retried with no email or state, a failing email harmless), the job's
  outcome recording (nothing when it didn't evaluate, an unlogged push as an error),
  hourly + watched + not activity-gated, PATCH /api/settings 400s + cents rounding + the
  memo reset, GET defaults and the Settings form — the database-backed half is
  `tests/contract/cash-alerts-l2`;
  `tests/roadmap-t2-2-cash-l1.test.js` — roadmap T2.2 L1: projectCashFlow over canned
  inputs (calendar dates across a month end, a monthly bill and pay, the exact running
  balance, the lowest day the weekly end balances hide, firstBelow, weekday vs overall
  averages, a semimonthly stream), getCashFlowInputs over a mock pool (card autopay
  skipped, `today` threaded into the streams' liveness, the FAN-5 / DD-4 query rules),
  GET /api/cash-flow as a thin wrapper (old fields + lowest_balance / lowest_balance_date,
  no daily series, 30–180 clamp) starting the day after the APP_TIMEZONE date (the file
  forces a zone whose date differs from UTC's), and the dashboard's "Lowest projected"
  line run from dashboard.ejs — the database-backed half is `tests/contract/cash-flow-l1`;
  `tests/roadmap-t2-webhooks-w6.test.js` — roadmap T2.1 W6: getWebhookStatus (per-provider
  events, the PUBLIC_URL-prefix registration SQL, the Teller count, RENDER_EXTERNAL_URL
  never counting, fail-soft parts), every webhookChecks branch, getOperatorChecks reusing a
  passed status + the warn reaching toIssues and the failing signature, GET /api/data-health's
  webhooks / connections / failed-event issue and fail-soft blocks, and the Sync Health
  Webhooks line, Register button (data-e2e-skip) and Connections list run in a vm — the
  database-backed half is `tests/contract/webhooks-w6`;
  `tests/roadmap-t2-webhooks-w5.test.js` — roadmap T2.1 W5: the Teller handler
  (transactions.processed by enrollment id or by account ids, one post-sync pass, gone /
  empty ignored, a failed sync failing the event; enrollment.disconnected's GOOD-only
  update + one notification with the reason in words, already-disconnected / lost-race /
  unknown silent; webhook.test done), syncTellerEnrollment over the REAL Teller engine
  (only that enrollment, last_synced_at only on a clean run, nothing global, not_found,
  coalescing), syncAllEnrollments unchanged through syncOneTellerEnrollment, and the
  verifier's reason + account ids without the transactions — the database-backed half
  is `tests/contract/webhooks-w5`;
  `tests/roadmap-t2-webhooks-w4.test.js` — roadmap T2.1 W4: the handler's ITEM events
  (a re-auth ERROR / PENDING_* / USER_PERMISSION_REVOKED set the signal, LOGIN_REPAIRED
  clears it, an outage ERROR / other codes / investments-only re-auth ignored),
  NEW_ACCOUNTS_AVAILABLE once a day, HOLDINGS / INVESTMENTS_TRANSACTIONS one Item's
  sync (a failed one fails the event); keepWarnings and the per-code notification text;
  the verifier's error_code; the URL from PUBLIC_URL only (+ /perfin embedded), the four
  link tokens carrying it only then, the exchanges recording it, the register route
  (400 / 501, per-item update, codes only, no undecryptable token sent) and the flow
  sync's one-Item filter — the database-backed half is `tests/contract/webhooks-w4`;
  `tests/roadmap-t2-webhooks-w3.test.js` — roadmap T2.1 W3: syncPlaidItem syncing only
  the named GOOD item behind the Plaid lock, stamping its last_synced_at only after a
  complete walk and writing nothing global, the per-item coalescing (one extra round,
  shared promise, other items not coalesced), syncAllPlaidTransactions through
  syncOnePlaidItem, runPostSyncSteps (nothing for 0 rows, rename before the check, two
  at once serialized), the handler's done / ignored / failed paths and a verified event
  through the production router — the database-backed half is
  `tests/contract/webhooks-w3`;
  `tests/roadmap-t2-webhooks-w1.test.js` + `tests/roadmap-t2-webhooks-w2.test.js` —
  roadmap T2.1 W1–W2: the receivers answering 503 and writing nothing while
  unconfigured, 400 / 413 / 404, a bad or throwing verification a 401 logged as a
  warning, record → 200 → detached handler → done / ignored / failed, a duplicate not
  processed, a failed insert a 500, the body never stored or logged, the failed-
  verification limiter, the daily prune, the shell's exact exemption and the server.js
  mount order; Plaid JWTs signed with a local P-256 key (tampered body, stale / future
  iat, alg none / HS256 with no key fetch, unknown / expired / wrong key, malformed
  tokens, the key cache) and Teller HMACs (wrong secret, rotation, stale t, tampered
  body, id-less events, garbage headers), both through the production router — the
  database-backed halves are `tests/contract/webhooks-w1` / `webhooks-w2`;
  `tests/seams-audit-3.test.js` + `apps/per-sistant/tests/seams-audit-3.test.js` —
  Seams & Invariants audit #3: WebAuthn credential ids stored as given +
  `repairCredentialIds` (a double-encoded row rewritten, a duplicate dropped,
  idempotent), GET /api/items leaving manual accounts out, one reconcile at a time
  (either route 409s while one runs, a synchronous run never writes the job slot, the
  weekly heal skips) with a fixed-sentence background error, `recordSyncResult`
  serialized (two at once keep both providers), rename rules after a single-Item
  Plaid sync, the seasonal window's whole oldest month, the APP_TIMEZONE tax year,
  goal milestones through `deriveGoalProgress`, the first VALID digest recipient,
  whats-new `source_id`, the digest key compares; Per-sistant: the finance snapshot
  listing a charge due today, the SW's `!r.redirected` + `per-sistant-v9`, the
  knowledge-reindex 409 skip + count-only failure line, the standalone login digest
  compare — the database-backed half is `tests/contract/seams3.contract.test.js`;
  `apps/per-sistant/tests/roadmap-t1-batchc.test.js` — roadmap T1.5 Batch C:
  loadEmailAttachments (order + shape, a legacy disk file, a missing file, the 20MB
  cap, none), both senders' wiring, Send Now's 400 without a claim, the Emails page's
  error line + single-flight Retry (data-e2e-skip), every model-calling AI route's
  501 without a key (a 400 still first), the Review page's AI gate and the removed
  e2e gap — the database-backed half is `tests/contract/persistent-batchc.contract.test.js`;
  `tests/roadmap-t1-quickwins.test.js` — roadmap T1.5 Batch B: the real loadCharts
  redrawn twice (the old charts destroyed) and the empty-state round trip, the real
  renderCategoryMonth in a vm (the latest aggregate, a slow month fetch never
  overwriting a later choice), the refreshSpending wiring; GET /api/budgets/one-time,
  the Budgets page's month arithmetic in a vm and its month / other-month wiring;
  updateRenameRule's validation / off / name-only / no-op paths and the Settings
  Edit + Turn off / on controls — the database-backed half is
  `tests/contract/quickwins.contract.test.js`;
  `tests/roadmap-t1-errors-uptime.test.js` — roadmap T1.4 Batch A: the error log's
  fingerprinting / describe / source frame, the wrapper (still prints, groups, uninstalls,
  never throws or recurses, the 100-entry cap), flush (one batched upsert, announce new /
  reopened once, the 5-per-24h cap, re-buffer on a failed write), resolve / list
  validation, /health/deep (ok, failing, hanging, unwired, 503 + cache), the heartbeat
  (off / <url> / <url>/fail, never throws), job-health failingJobs, the Operator Checks
  heartbeat note and the shell / Settings / migration wiring — the database-backed half
  is `tests/contract/error-log.contract.test.js`;
  `tests/vps-hosting.test.js` — the VPS-move hosting facts: PUBLIC_URL over
  RENDER_EXTERNAL_URL, ALWAYS_ON (no keep-alive ping, schedule reports disabled,
  Settings note), SERVER_BACKUPS (no GitHub backup check, the Database Backup /
  Keep Alive workflows read as "not needed" info, their secrets not required, the
  on-server backup check on user_settings.last_backup_at, backup.sh's stamp after
  the verified loop);
  `apps/per-sistant/tests/scan-oct-batch20.test.js` — the cycle-7 expansion Batch 20 pin
  (ST3): `withPending` run in a vm from the EMITTED client bundle (busy state + restore,
  single-flight per key, restore on a throw, button lists / null / an already-disabled
  button) and a guard counting hand-rolled pending toggles (`.disabled = false` /
  `aria-busy` outside the helper) in `pages/*.js` + `views/*.js` against a shrinking
  KNOWN_GAPS map (empty) — the browser half of Batch 20 (G2) is `e2e/pages.spec.js`;
  `tests/scan-oct-batch19.test.js` — the cycle-7 expansion Batch 19 pins (G3): the
  update-mode token request (the item's own access_token, no products, account selection
  on), the decryption_failed 409 / 400 / 404 / CSV-item refusals, update-complete
  registering a new account BEFORE the cursor walk, clearing last_error_code and syncing
  only that item (a re-auth error keeps the flag, 409), the investments kind's one-Item
  holdings sync, the investments-only exchange's duplicate 409 (via a Transactions link or
  an earlier investments-only Item by mask) + release + mask write, the once-per-new-code
  re-auth notification to /accounts, the data-health issue link, and the Accounts page's
  REAL loadItems run in a vm (Re-authenticate / Add accounts per item kind) — the
  database-backed half is `tests/contract/plaid-update.contract.test.js`;
  `tests/scan-oct-batch18.test.js` — the cycle-7 expansion Batch 18 pins (ST1): POST
  /api/sync {background:true} → 202 + id, status running → done, a second start a 409 on
  the same id; a manual POST during a background run sharing it (one sync, one record); the
  fixed status error (never exception text); the synchronous path unchanged; sync-balances
  and the reconcile in the same tracker; the unknown-kind 400; daily-sync's run_background
  helper EXECUTED in bash against a fake server (done / server error / lost run / down
  server / deadline / 409-follow / unreachable, the job's error text never printed); the
  workflow wiring and check_status in every workflow that calls the app — the
  database-backed half is `tests/contract/async-sync.contract.test.js`;
  `tests/scan-oct-batch17.test.js` — the cycle-7 expansion Batch 17 pins (G1 + ST4): the
  GitHub checks against a fake API (healthy repo, disabled critical vs optional workflow,
  failing / stale / missing runs, no or old backup, missing secrets, a public repo, a 401 /
  403 / timeout fail-soft with the token never echoed), the local and Knowledge checks, the
  6h cache + force + cachedOnly, toIssues, notifyIfChanged's once-per-change / unreadable /
  failed-send rules, data-health not waiting on GitHub, GET /api/operator-checks and the
  Settings / watchdog wiring — with `apps/per-sistant/tests/scan-oct-batch17.test.js` (a
  successful FULL vault sync stamps VAULT_PARSE_VERSION; incremental / failed syncs don't);
  the database-backed half is `tests/contract/operator-checks.contract.test.js`;
  `tests/scan-oct-batch16.test.js` — the Oct 2026 (cycle 7) Batch 16 pins: guessGenericSign
  and the generic parser's positiveMeans, the preview's sign_guess / positive_means + the
  400 on both routes + a known format ignoring it, one parseOpts for preview and commit, the
  CLI flag and both upload forms (F26); the insight-email skip, the strict-boolean PATCH and
  the Settings toggle + corrected webhook text (F81); archiveMarker with a fingerprint,
  ARCHIVE_MONTHS_SQL, and a stateful fake Sheets API rebuilding exactly the changed or
  legacy month (F85) — with `apps/per-sistant/tests/scan-oct-batch16.test.js` (the notes
  privacy tier, F134 / ST5: db/028, route validation, chunks dropped on leaving normal,
  syncNotes / retrieval / Ask / AI tagging limited to normal notes, masked secret text) —
  the database-backed halves are `tests/contract/batch16-perfin.contract.test.js` and
  `batch16-persistent.contract.test.js`;
  `tests/scan-oct-batch15.test.js` — the Oct 2026 (cycle 7) Batch 15 pins (F53 / G5 and
  F55 / ST2): the watchdog run fail-soft after detection, its 7-day grace / ±25% / 5%-or-$1
  constants, the detector's merchant key mirrored, one alert per charge / price and no mark
  without a logged notification, the STILL CHARGING / PRICE UP badges and columns; rename
  rules matching the RAW merchant with LIKE escaping, most-specific-first order, a too-short
  rule skipped, only NULL names filled, applied after a sync (before the anomaly check),
  inside the CSV import transaction and after a manual entry, a hand rename clearing the rule
  link, apply_to_all needing a name, and the Edit-dialog / Settings UI — the database-backed
  half lives in `tests/contract/watchdog-rename.contract.test.js`;
  `tests/scan-oct-batch14.test.js` — the Oct 2026 (cycle 7) Batch 14 refund-aware spending
  pins (F35 / G4): REFUND_PREDICATE (NULL-safe income test), spendLinesCTE's three legs +
  window, NET_CATEGORY_MONTHS's floor, every spending surface reading spend_lines (helpers,
  spending-summary, spending-yoy, the insights seasonal block, Ask's search total, the
  Sheets Dashboard), cash flow staying gross, and refund lines defined only in
  financial-queries.js + the SX3-pinned Sheets mirror — the database-backed half lives in
  `tests/contract/refunds.contract.test.js` (+ refund rows in `budget-parity`);
  `tests/scan-oct-batch13.test.js` — the Oct 2026 (cycle 7) Batch 13 platform / test-quality
  pins that need no database: runMigrations against fake clients (BEGIN → advisory lock →
  lock_timeout, rollback + no retry on an ordinary error, 55P03 retried with backoff, give-up
  after N — F10/PS-1), teller/services/database booted in a child process (exit 1 without
  TOKEN_ENCRYPTION_PASSPHRASE / NEON_DATABASE_URL — F138), the pgvector guards (F10), the
  Sign Out Everywhere wiring (F12), the Dockerfile uploads chown (F13), a scan that no test
  opens a pool on NEON/PERSISTENT_DATABASE_URL (F136), and two POLICY guards with shrinking
  KNOWN_GAPS — a timezone lint (no new `new Date().toISOString()` today/month slice or
  `date_trunc('month', CURRENT_DATE | now())` in server code) and a canonical-helper scan
  (net_worth_snapshots writers call getNetWorth; budget_snapshots, income streams, the AI
  spend and the effective budget limit are each read/derived in one place);
  `apps/per-sistant/tests/scan-oct-batch13.test.js` — Per-sistant runMigrations with a fake
  `db` (PS-1 + F10) and the standalone login gate run for real (requireAuth + POST
  /api/login, expiry, embedded skip, webhook exemption — F139); the database-backed half of
  Batch 13 lives in `tests/contract/platform-batch13`, `persistent-batch13` and
  `budget-parity`;
  `apps/per-sistant/tests/scan-oct-batch12.test.js` — the Oct 2026 (cycle 7) Batch 12
  Knowledge ingest pins that need no database: an empty or max_tokens answer never cached +
  the truncated flag and callAI's `meta.stop_reason` (F126), a truncated tree reported with
  the SHA held (F127), the blobs-API fallback for a file over 1 MB (F128), timeout signals
  on GitHub + Voyage fetches (F129), the AI limiter on the RAG model endpoints + the
  1000 / 20000-character caps (F130), upcomingFacts' validity window + APP_TIMEZONE date
  (F131), "--- " delimiters + repeated privacy keys failing closed (F132), a diverged compare
  forcing a full walk (F133) and a field-less fact capture written as a note (F135) — the
  database-backed half lives in `tests/contract/knowledge-batch12.contract.test.js`;
  `apps/per-sistant/tests/scan-oct-batch11.test.js` — the Oct 2026 (cycle 7) Batch 11
  Per-sistant correctness pins that need no database: parseCalDate / fmtCalDate run in a vm
  under TZ=America/Los_Angeles + no page splitting a DATE with `new Date(…)` (F109),
  computeHousingDue's oldest-unpaid overdue (F110), Send Now single-flight (F111), the
  recipient 400 + email_failed notification (F112), every page write through
  writeOk(tryFetch(…)) (F113), the Job Radar new-only nudge + 7-day window (F114), the
  APP_TIMEZONE note-reminder / overdue days (F115), the webhook + Slack wiring and the
  reminder claim (F116), refresh single-flight + skip-recent + the workflow time (F117),
  Ask totals (F118), the review's upcoming list (F119), the email PATCH rules (F120),
  attachments in Postgres + the download route order (F121), the trash purge (F122), the
  limiter skip under the shell (F123) and the F124 group — the database-backed half lives
  in `tests/contract/persistent-batch11.contract.test.js`;
  `tests/scan-oct-batch10.test.js` — the Oct 2026 (cycle 7) Batch 10 Perfin UI pins: the
  REAL loadCharts run against a canned spending summary and a fake Chart, incl. a
  west-of-UTC month label under TZ=America/Los_Angeles (F91), the nav wrap and calendar
  minmax (F94/F95), DASHBOARD_WIDGETS — every selector present on the dashboard, every
  settings default key covered, applyDashboardWidgets run in a vm (F96), parseAmountInput /
  parseCalDate / writeOk on the listed paths (F97/F98/F99), the computed-display Add
  forms (F100), the budget POST keeping unsent fields + its 400s (F39), return_to,
  the Split modal, the one style attribute, loans as owed, escaped error text (F102–F106),
  sw.js `cacheKey` / `shouldCache` run in a vm (F107) and the failed-load states (F108) —
  the database-backed half lives in `tests/contract/ui-writes.contract.test.js`;
  `tests/scan-oct-batch9.test.js` — the Oct 2026 (cycle 7) Batch 9 Sheets / cross-app
  pins that need no database: completed-month Sheets averages (F75), resetFormats on
  Income / AI Trust / Watchlist and `singleFlight` (F77/F78), the guard's plain-number
  pass-through (F83), Code.gs's `guardRows_` run in a vm + every data write guarded
  (F84), Per-sistant's `widgetFigures` (F80), the in-process draft reported not sent +
  the daily tick settling on it (F79), the settings 400s / dashboard env check /
  partial-sync failure record / once-a-day notification prune (F86) and the
  income-predicate comment (F44) — the database-backed half lives in
  `tests/contract/sheets-crossapp.contract.test.js`;
  `tests/scan-oct-batch8.test.js` — the Oct 2026 (cycle 7) Batch 8 AI-trust pins that
  need no database: named other months + the sentence/clause period window + k/M
  amounts (F61/F68), bounded entity capture (F67), Ask's last round without tools /
  charge after the write / APP_TIMEZONE date + served model and the APP_TIMEZONE
  spend month (F64/F65/F66), the suggest category enum + Accept de-dup (F70), ISO
  prompt dates (F71), the goal prompt's `deriveGoalProgress` (F62) and the weekly
  digest text + dashboard link (F72) — the database-backed half lives in
  `tests/contract/ai-trust.contract.test.js`;
  `tests/scan-oct-batch7.test.js` — the Oct 2026 (cycle 7) Batch 7 categorization /
  income-cadence pins that need no database: the circular semimonthly clustering
  (F52), `RULE_ORDER_SQL` + `deactivateSupersededRules` + times_applied not bumping
  updated_at (F46), `rulePatternError` + the POST 400 (F48), the AI write's
  `user_category IS NULL` guard (F47) and the `ai_skipped_at` back-off (F54) — the
  database-backed half lives in `tests/contract/categorize-rules.contract.test.js`;
  `tests/scan-oct-batch6.test.js` — the Oct 2026 (cycle 7) Batch 6 delete-integrity
  / feed pins that need no database: both provider upserts skipping
  `deleted_transactions` + the DELETE recording it (F20), `merchantsSimilar` /
  `pairOverlaps` (F21), `icsFold` (F59), `isValidYmd` + the route 400s and the
  literal search LIKE (F57), Undismiss re-activating (F56) and the removed dead
  artifacts (F58) — the database-backed half lives in
  `tests/contract/delete-feeds.contract.test.js`;
  `tests/scan-oct-batch5.test.js` — the Oct 2026 (cycle 7) Batch 5 money-accuracy
  pins that need no database: the budget push on getBudgetStatus with unrounded
  thresholds (F40), the context export's unknown card limit (F36),
  `nextRentInLeadWindow` (F43), the detectors' raw-description helpers (F49),
  `mapCategoryFor` + the uncategorized predicates for Plaid rows (F50), the
  dashboard's 0% split (F31), the NOT_TRANSFER brand/exemption shape (F32/F51),
  the Sheets `INCOME_AMOUNT` mirror (F37) and the Rent page's Remove button +
  reset-fresh classification (F33) — the database-backed half lives in
  `tests/contract/money-classification.contract.test.js`;
  `tests/scan-oct-batch4.test.js` — the Oct 2026 (cycle 7) Batch 4 bank-sync
  durability pins that need no database: every token read through
  `perfin_try_decrypt` (F17), the CSV CLI's non-zero exit + imported-file
  manifest + per-row savepoint and the workflow removing only listed files
  (F19), the roll-forward savepoint keeping the import (F25), a Plaid
  reconcile waiting for an in-flight sync + the bounded lock (F27), liabilities
  skipped for a checking-only Item + the skip codes (F28), `snapshotDay` (F30)
  and the unlink-then-link guidance (F18) — the database-backed half lives in
  `tests/contract/bank-durability.contract.test.js`;
  `tests/scan-oct-batch3.test.js` — the Oct 2026 (cycle 7) Batch 3 backstop /
  outcome / operator-state pins: job outcomes via jobHealth.result + the
  changed-only flush + data-health flushing first and raising failed jobs (F8),
  the housing ledger as an away job (F15), the insights auto-trigger's cap
  pre-check / attempt stamp / 24 h back-off and the 'insight_unsaved' charge
  (F63), no settings fallback in generateInsights (F73), wholesale + thrown sync
  failures in last_sync_result (F23), audit_incomplete on a failed finding
  insert (F69), tellerCertStatus + the data-health cert issue (F14), daily-sync's
  independent steps + timeout report and every workflow's permissions block
  (F5/F16), the generic test-notification error and shutdown stopping jobs
  (F16), and the empty-catch scan — a per-file KNOWN_GAPS count of bare catches
  in server code that fails on growth AND on a stale entry;
  `tests/scan-oct-batch2.test.js` — the Oct 2026 (cycle 7) Batch 2 broken-page /
  dead-channel pins: Web Push to a JSONB (object) subscription + 410 pruning via a
  stubbed web-push (F74), the toast cap run in a vm with a timeout (F89), the
  account-history page rendered as one document standalone and under /perfin
  (F88), the Rent page's utility-row markup assignment (F87), the nav's
  `whenShared` deferral (F90), the relative logo mask (F93), and the offline
  page's external script + the SW's `<base>` injection (F92);
  `tests/scan-oct-batch1.test.js` — the Oct 2026 (cycle 7) broad-scan Batch 1
  exposure / pre-auth pins: a multibyte PIN is a 401 rather than an unhandled
  rejection + `safeEqual` + the ICS route's digest compare + the shell's
  unhandledRejection logger (F1), no workflow prints a response body, the
  SUMMARY_JS helper run on a body with balances, and csv-import's public-repo
  guard (F2), the standalone x-api-key / numeric-password login fixes (F6), the
  deduped lockout alert (F7), persistent_url validation + no redirect following
  + no `*_enc` in the settings PATCH response (F82), and the pinned Mermaid path
  in the served CSP (F125);
  `apps/per-sistant/tests/batch15-followons.test.js` — the fixes for the bugs
  Batch 15's real-code tests exposed: the calendar router built with server.js's
  real deps + a guard that every `routes/*.js` factory only destructures keys
  server.js passes ({pool, config, helpers, views}) (FO-1), a guard that no
  client template-literal module (`pages/*.js`, `views/*.js` exporting a string)
  carries a single-escaped regex + the emitted Quick Add `\b` (FO-2), the palette
  picker run in a vm under /per-sistant/settings (FO-3), current theme tokens in
  views/js.js (FO-4) and theme / perfin_url validation (FO-5);
  `tests/scan-sept-batch15.test.js` — the Sept 2026 broad-scan Batch 15
  test-quality guards: contract-suite wiring (script, CI step, per-file skip +
  unique scratch DB, the server.js route-order regexes still matching), no
  un-nonced `<style>` reaching Perfin's nonce-only styleSrcElem, root-relative
  client navigation always carrying the mount base, and every `var(--x)` defined
  (shell + Per-sistant). Pre-existing offenders are listed in a `KNOWN_GAPS`
  array with reasons; the guards fail on a NEW offender AND on a stale entry, so
  the lists only shrink. `tests/teller.test.js` and
  `apps/per-sistant/tests/api.test.js` were rewritten (TQ-1) to drive the REAL
  production code — they used to test inline copies written inside the test, so
  no production change could fail them (−244 replica/tautology tests, +58 real
  ones; that is why the count dropped from 1647). Real bugs those tests exposed
  were recorded as node:test `todo`s and then fixed by the follow-on batch (no
  `todo`s remain);
  `tests/contract/` — the real-Postgres ROUTE CONTRACT suite (TQ-2, NOT in
  `npm test`; `npm run test:contract`, gated on `CONTRACT_DATABASE_URL`, every
  suite skips without it). `_setup.js` creates one scratch database per file
  (`contract_perfin_<name>` / `contract_persistent_<name>`, DROP … WITH (FORCE)),
  runs the app's own migrations, and mounts EVERY router in the order parsed out
  of `teller/server.js` / `apps/per-sistant/server.js` (with Per-sistant's real
  `{pool, config, helpers, views}` deps), so route shadowing and missing deps
  show up. Files: financial-queries (income predicate incl. the FAN-2 guard,
  splits / reimbursed / shared split, getNetWorth, getBudgetStatus + budgets,
  the spending-analytics endpoints, tax candidates), housing-settle (config,
  generation, amount PATCH, payments + memo + undo + export, split guard,
  shared-settlement, settle/undo), calendar-exports (manual bills, calendar,
  forecast, ICS, CSV / tax / context exports), transactions (bulk-category via
  the real mount order, user_* overrides, splits, manual cash, CSV preview →
  import → re-import) and persistent (todo location, dependency cycles,
  recurring complete/undo, templates, automations, email validation, review,
  iCal, Job Radar, GET /api/calendar), sync-ai (the Teller and Plaid SYNC
  ENGINES — syncAllEnrollments signs / pending skip / watermark / re-sync adds 0,
  reconcileTeller, syncAllBalances + snapshots + accounts_changed,
  syncAllTransactions, syncPlaidItemTransactions insert / re-delivery /
  modified-upsert / removed / cursor — plus POST /api/categorize and
  generateInsights + audit, with only Teller's HTTP client, a Plaid client
  object and the Anthropic SDK stubbed; generateInsights must report
  `modules_failed: []` with ≥8 modules run), bank-durability (cycle-7 Batch 4:
  a real wrong-key token reported as `decryption_failed` instead of failing the
  sync, the duplicate-Item 409, the CSV loan roll-forward + label-over-institution
  match, a removed investment account staying removed, the investments-only
  unlink, flow coverage via `flows_synced_at`, a 0% APR, NaN balance rejection
  and a comma in a Teller category), money-classification (cycle-7 Batch 5:
  NOT_TRANSFER brand words / exemptions / Transfer-Investment categories,
  joint-account income + reimbursement credits, a 0% Settle Up split, the
  categorize queue for Plaid legacy categories, a removed housing placeholder
  staying removed, next month's rent reminder, whole-month Spending Summary
  windows, budget snapshots outside a budget's life, Zelle rent as a peer
  transfer, semimonthly cash-flow income, and the Sheets Watchlist),
  delete-feeds (cycle-7 Batch 6: a deleted transaction surviving a Teller
  reconcile and a Plaid re-delivery, the one-to-one / similar-merchant CSV
  overlap, a 30th-of-month rent in the ICS feed, folded UTF-8 summaries,
  Undismiss, and the F57 400s + literal search), categorize-rules (cycle-7 Batch 7:
  short rules refused / skipped, a specific rule beating an older busy one, a
  re-pointed merchant deactivating its old rule, a category set mid-run surviving
  the AI write, an unanswered row not re-sent), ai-trust (cycle-7 Batch 8: the goal
  prompt on funding-derived progress with ISO dates, the audit on real spending —
  a named other month, an earlier sentence's period word, "$1.2k", a hallucinated
  merchant next to a known one — the AI spend month and Accept with a repeated
  category), sheets-crossapp (cycle-7 Batch 9, a recording fake Sheets API: a
  yearly utility's next due on its anniversary, every monthly manual-bill
  occurrence in Important Dates + a month-end transfer stepped by calendar month,
  the Credit Scores change per score type, notification_log retention, and the
  in-process digest draft reported not sent), ui-writes (cycle-7 Batch 10: an Add-form
  re-save keeping a budget's rollover / notes, a one-time budget keeping its month and
  showing only in it, the rollover PATCH), persistent-batch11 (cycle-7 Batch 11, Per-sistant: an attachment
  stored in its row, downloaded without a disk file and purged with its email + links,
  the 30-day trash purge, a note reminder claimed once, a sent email refusing edits and
  'scheduled' needing a time, the recipient 400 + email_failed notification, the Job Radar
  new-only nudge + skip-recent refresh, Undo restoring a reset streak, literal search +
  bulk-complete automations, and the review's upcoming list), knowledge-batch12 (cycle-7 Batch 12:
  only current facts announced against a given day, a "--- " file with a repeated sensitivity
  key stored as secret, a 1 MB fact file read through the blobs API keeping its facts, a
  truncated tree reported with the SHA held, and a force-pushed history removing a file from
  the dropped commits), platform-batch13 (cycle-7 Batch 13: Perfin's COOP header from the
  real app, SSO replay refused + a forged signature not burning the nonce, perfin_try_decrypt
  NULL for a wrong key, concurrent migration runs + a held table lock → 55P03 → retry,
  session-epoch revocation through the real handleLogout / requireAuth), persistent-batch13
  (the schema checks ported from the deleted integration.test.js, GET /api/analytics, two
  concurrent scheduled-email runners sending each email once, POST /api/rag/reindex → status,
  concurrent migrations), budget-parity (the Sheets Dashboard's Budget Status rows equal
  getBudgetStatus to the cent — with refund rows since Batch 14), refunds (cycle-7 Batch 14:
  a refund nets and inherits its merchant's category, a larger one floors at $0, a 50%
  shared-card refund, refund-only categories / merchants unlisted, budgets / spending-summary /
  spending-yoy agreeing with the helpers, and payroll / card-payment / Zelle / reimbursed /
  pending credits never counted as refunds), watchdog-rename (cycle-7 Batch 15: a charge
  15 days after cancelling alerts once and a new charge again, one inside the 7-day grace
  doesn't, a price rise alerts once and a 2% / $0.20 change doesn't, POST /api/detect runs
  the watchdog; "Apply to all" renames past rows, keeps a hand-renamed row and folds the
  cancelled subscription onto the new name with its notes, a later row is renamed and a
  hand edit wins, a too-short contains rule is a 400, deleting the rule reverts only its
  rows), batch16-perfin (cycle-7 Batch 16: a generic CSV imported with
  positive_means=deposits stored with charges positive + its preview's duplicates only
  under the same choice, an insight run emailing by default and not when switched off,
  and archive fingerprints on the real schema — a backfilled row and a rename rebuild
  exactly their months), operator-checks (cycle-7 Batch 17: the Knowledge check asking for
  a reindex until a real full vault sync stamps vault_parse_version, and GitHub problems
  reaching /api/operator-checks + data-health with one notification per failing set),
  async-sync (cycle-7 Batch 18: a background /api/sync and /api/sync-balances finishing and
  recording last_txn_sync_at / last_balance_sync_at + last_sync_result per provider),
  plaid-update (cycle-7 Batch 19: a flagged Plaid item with edited transactions through
  update-complete — flag cleared, a new account registered under the same Item, no
  duplicate rows, every edit intact, the cursor continued; GET /api/items' last_error_code;
  the investments-only exchange refusing an earlier investments-only Item by mask; the
  investments kind syncing one Item's holdings; a stale token's 409),
  batch16-persistent (the notes privacy tier: the CHECK, keyword
  retrieval returning normal notes only, search masking a secret note, chunks +
  embed_state dropped when a note turns private) and knowledge (syncVault through a
  fake GitHub API via its `fetchImpl`, syncNotes, keyword search never returning
  secret text, secret-lookup, facts current vs `all=1` + verify, /api/rag/query
  without AI, an incremental compare that removes a deleted file) plus insight
  feedback set / change / clear (the F60 `$1::text` cast), and error-log (roadmap
  T1.4: captured errors grouped and counted in app_errors, one "New server error"
  notification, GET /api/errors + the data-health warning, Resolve and a later
  recurrence reopening it as "back", /health/deep 200 on the real database and 503
  when it can't connect), and quickwins (roadmap T1.5 Batch B: the one-time budget
  listing; a rename rule's new name renaming its rows and re-keying its subscription
  with the notes kept while a hand-renamed row stays; off reverting its rows and
  keeping the rule, on re-applying it; the PATCH 400s / 404), and persistent-batchc
  (roadmap T1.5 Batch C: Send Now carrying two stored attachments, a missing one a 400
  that leaves a draft, the scheduler marking it failed with the reason + the failed
  list, Retry after removing it sending once and a second Retry 409, review-summary
  501), and seams3 (Seams audit #3: GET /api/items without a manual account's null
  item; repairCredentialIds on the real table), and webhooks-w1 / webhooks-w2 (roadmap
  T2.1: the webhook_events CHECKs, one row per delivery and per provider, a failed
  handler's fixed error, the 30-day prune, the production router writing nothing while
  unconfigured; a signed Plaid event recorded once under its JWT key with a replay and
  a forgery adding nothing, a Teller event re-signed later still one row), and webhooks-w3
  (roadmap T2.1 W3: a signed SYNC_UPDATES_AVAILABLE syncing only that item with the real
  engine — new row, cursor, balances, the item's last_synced_at, the anomaly watermark,
  'done', last_txn_sync_at / last_sync_result untouched; a second delivery adding
  nothing; a CSV / unknown item 'ignored'), and webhooks-w4 (roadmap T2.1 W4: a re-auth
  ERROR setting last_error_code with one notification and an outage ERROR changing
  nothing, PENDING_EXPIRATION surviving a clean webhook sync until LOGIN_REPAIRED,
  NEW_ACCOUNTS_AVAILABLE notifying once, HOLDINGS writing an investments-only Item's
  holdings, register recording webhook_url on every Item and a 400 without PUBLIC_URL),
  and webhooks-w5 (roadmap T2.1 W5: a signed transactions.processed naming only an
  account id syncing just its enrollment — row, watermark, last_synced_at, the anomaly
  watermark, nothing global — enrollment.disconnected setting DISCONNECTED with one
  notification across two deliveries, webhook.test done, unknown enrollments ignored),
  and webhooks-w6 (roadmap T2.1 W6: data-health's per-provider webhook status — last
  status, 24h count / failures with an older row not counted — the failed-event issue,
  per-connection freshness without CSV items or suspended enrollments and with the
  re-auth state; the not-registered warning for an Item registered at another address,
  gone after Register; Teller without a secret as info), and cash-flow-l1 (roadmap T2.2
  L1: GET /api/cash-flow and getCashFlowForecast agreeing on real rows — brokerage, card and
  loan not spendable, the card autopay not billed, a biweekly payroll stream, a
  subscription and a loan payment on their days — the lowest projected day and
  firstBelow), and cash-alerts-l2 (roadmap T2.2 L2: off by default, switched on through
  PATCH /api/settings with bad values refused, a projected dip notifying once into
  notification_log, unchanged without new data, held after new data, re-notified 72 h on,
  clear after more cash, skipped on a 40-hour-old balance), and payday-l3 (roadmap T2.2
  L3: the switch-on moving the watermark; a biweekly paycheck 4 days overdue on a freshly
  synced Plaid connection notifying once and a stale connection's not; a matching deposit
  through runPostSyncSteps announced once and a one-off direct deposit not; nothing missed
  after the paycheck), and cash-floors-l4 (roadmap T2.2 L4: a floor stored in cents only on
  a checking / savings account — a card or brokerage a 400, a missing account a 404 — and
  returned by GET /api/accounts; a balance below its floor alerting once into
  notification_log with last_check.floors_below, a 40-hour-old balance skipped, a second
  evaluation within 24 h adding nothing; null clearing it), and persistent-ai-cap (roadmap
  T2.3 C2 / C3: a Knowledge answer and an email draft each charging one ai_usage row with
  its entry_type through the real routers and cap reads, counted in the APP_TIMEZONE
  month with a row from just before the zone's month start left out; with the month's
  spend at the budget /api/rag/query sources-only with ai_cap and /api/ai/draft-email a
  429, neither calling the model or adding a row), and ai-usage-c4 (roadmap T2.3 C4, both
  apps' real databases wired as the shell wires them: GET /api/ai/usage's per-feature rows
  and spent_cents equal to monthlyAiSpendCents with last month's row left out; PATCH
  ai_monthly_budget_cents setting the cap the wrappers enforce — a 1.5 a 400 that changes
  nothing, null back to the default; Perfin's spend in Per-sistant's usage and
  Per-sistant's in Perfin's /api/insights/status), and linked-tasks (roadmap T2.4 X1a: db/030
  re-run cleanly with its columns, unique source_key and detach trigger; a linked create
  running a todo_created automation; close → reopen with source_detached untouched by the
  sync; a hand completion through PATCH or bulk complete, and an auto-closed task reopened
  and completed by hand, never reopened; a hand reopen never re-closed; a trashed task —
  auto-closed or open — not reopened or recreated; only the listed kinds closed;
  ensureLinkedTask once; an ordinary task untouched; X1b: a title edited through PATCH kept
  across two syncs while the due date, priority and url follow, nothing written on a no-op
  run, a hand-reopened task not refreshed), and linked-tasks-perfin (roadmap T2.4 X2a:
  computeLinkedTasks on real rows — the configured payee's unpaid periods with known
  amounts, a paid period / another payee / a pending amount left out, an overdue period
  urgent, a utility amount until PATCH enters it, next month's rent until DELETE records
  its skip, a 31st manual bill on the 30th until POST /api/bill-payments marks it paid and
  a subscription payment with the same id not counting; the settings defaults, the
  sources merge and a 400 that writes nothing), and linked-tasks-crossapp (roadmap T2.4
  X2b, both apps' real databases wired as the shell wires them: switched off a run writes
  nothing; rent due → one Per-sistant task, a payment through Perfin's route closing it by the
  route's own refresh, undo reopening it, a task completed by hand staying done across a
  payment and its undo; a utility amount entered and a manual bill marked paid closing
  theirs; a still-charging alert making one task across two watchdog runs that a sync
  never closes; the run's record stored; X2c: Run now a 400 while off, then the run's record
  — desired equal to Perfin's computation — stored as linked_tasks_state), and
  finance-search (roadmap T2.4 X3a, both apps' real databases wired as the shell wires them:
  Per-sistant's search finding a 50%-shared-card transaction by merchant, note and category at
  the user's share with its Activity link, an active subscription / bill / goal / account but
  not a cancelled subscription or the Plaid brokerage phantom, "100%" matched literally, and
  nothing from Perfin standalone), and undelete-t2-5 (roadmap T2.5 U1: a Teller row with a rename,
  notes, a category and two splits deleted — snapshot + source kept — skipped by a reconcile, then
  restored with all of them and updated, not duplicated, by the next reconcile; a Plaid row skipped by
  a re-delivery and restored with its text[] category; a re-imported CSV file skipping the deleted row
  until it's restored; a restore after the account was removed a 409 that changes nothing; the list
  paged newest first by its cursor and a pre-U1 tombstone lifted with returns_on), and
  tax-investments (roadmap T3.3 K1: the flow sync over a stubbed Plaid client storing a brokerage's and
  a 401(k)'s investment transactions once — a re-sync adding none, the flows unchanged — and
  getInvestmentTaxData on those rows: one mixed-term FIFO sale, the 401(k) sale and dividend left out,
  qualified dividends and interest, the 401(k) withdrawal under retirement, an earlier year empty), and
  tax-documents (roadmap T3.3 K2, both apps' real databases wired as the shell wires them:
  getIncomeForYear on last year's rows — by kind, a joint account at 50%, the year before left out;
  Suggest adding a W-2 per employer, a 1099-INT for a bank's $12.50 of interest but not a credit
  union's $2, a 1099-B and a 1099-R from K1 rows and a 1098-T from tuition; a received W-2 and a
  dismissed 1099-INT unchanged by a second Suggest; a manual duplicate in another case a 409 and a
  suggested row's DELETE a 409; a task per open form past its date, closed by marking it received or
  dismissed through Perfin's route), and tax-package (roadmap T3.3 K3: on real rows — four deductions
  with a reimbursed and an earlier-year one left out and a merchant annotation, two rent payments, two
  paychecks and a joint deposit, a FIFO sale and a qualified dividend, a W-2 on the checklist —
  gatherTaxPackage's deductions equal /api/export/tax-report?format=json to the cent and the ZIP's
  deductions.csv is that export's CSV; rent paid equals /api/housing/export?format=json and rent_paid.csv
  its CSV; income equals getIncomeForYear; the sale, dividend and document come through; an empty year
  renders every section).
  Since roadmap T2.5 H1 plaid-update also sends the hosted token request and a hosted update whose
  Link session exited (flag, cursor and accounts unchanged) before the finished one. Since design D3,
  dashboard-summary (the summary on real rows equal to GET /api/budgets, /api/cash-flow's lowest day,
  the latest net-worth snapshot, /api/forecast + the calendar's unpaid manual bills, the ledger balance,
  /api/categorize/status and /api/data-health's warnings). Since cycle-8 Batch 2, c8-batch2 (the
  forecast's bills on real rows: checking → a linked savings account and a payment into the linked
  card left out; a brokerage contribution, a transfer to someone else, a utility autopay and a
  same-amount credit 9 days later billed). Since cycle-8 Batch 3, c8-batch3 (a specific rename rule
  taking a broad rule's rows while the broad rule's cancelled subscription stays put, a fully vacated
  key re-keyed; a price change surviving a detection run with no new charge; an early rise alerting
  once and not for a utility or a 2x charge; Resolve tombstoning with a restorable snapshot; a restore
  taking its rule's current name; a bank-removed Plaid id refused and a changed one restored stale;
  a renamed payroll source as one income-summary row). Since cycle-8 Batch 4, c8-batch4 (an
  open transaction committing an anomaly charge and a paycheck after a check has run — each
  caught by the next run, once). Since cycle-8 Batch 5, c8-batch5 (both apps' real databases:
  a linked task deleted for good — permanently and by Empty Trash — not recreated with its
  tombstone row; a sync blocked behind another holder of the linked-tasks lock; stats / analytics /
  the review counting only a hand completion; housing_due hidden while a housing task is open; an
  aged unpaid bill's task open until it is paid and a switched-off bill's task closed by the route's
  own refresh). Since cycle-8 Batch 6, c8-batch6 (the audit on real spending: a prior-year
  same-month claim, "last year", "last week" and "last quarter" skipped while the same claim about
  this month is still flagged CRITICAL). Since cycle-8 Batch 8, c8-batch8 (a stale tax_documents form
  CHECK refusing 1099-K until the next migration run replaces it, an unchanged run replacing nothing;
  Per-sistant's DATE read as 'YYYY-MM-DD' and served so by GET /api/todos while Perfin's pool keeps its
  Date). Since roadmap T4.1 A1, advice-a1 (every advice source read on the real schema — spendable =
  checking only, interest found by statement wording and by Plaid's PFC — and the plan on real rows: 3
  completed months over the bar, the savings transfer and minimums off, $1,000 a paycheck to the 24.99%
  card, a paid-in-full card not debt, a PFC-only card at an assumed 22%; since A2 GET /api/advice through the
  production mount order answering the same plan; since A3 the insight prompt's CASH PLAN block and the
  audit's plan figures from the same rows; since A4 the plan-change alert switched on through PATCH, a silent
  baseline, then one notification_log row when Visa is paid off and a fresh baseline after off / on; since A5 the
  emergency tracker on the real cash and a funding-linked goal behind by $1,500 a month — an inactive goal left out —
  through GET /api/advice; since A6 a biweekly raise, a joint-account bonus at 50%, a pending deposit ignored and
  Dining creep net of a refund; since A7 a $9,000 checking dip moved only to real destinations — never the $0
  brokerage phantom — a bond → equity $3,000 move, and the plan's drift equal to GET /api/investments/performance's;
  since A8 a card's statement paid in full after it closed — not carried, its tip naming the next close — and a car
  loan's extra $100 a month equal to computeLoanPayoff, through GET /api/advice; since A9 a quarterly subscription, a
  quarterly manual bill and a yearly membership as sinking funds on the cadence helpers' dates — a monthly bill and a
  cancelled service left out — a Netflix + Hulu overlap and an Amazon Prime with no other purchase, through GET /api/advice;
  since A10 limits set through PATCH and contributions logged through POST /api/investment-flows — last year's and a
  withdrawal left out — as contribution room through GET /api/advice, and a what-if on the real inputs). Since
  cycle-8 E1a, forecast-e1a (detector-found rows: a card autopay and a savings move left out with their reasons until
  set to "bill", a rent transfer ignored and a subscription left out through the PATCH routes, the totals equal to the
  items', the dashboard summary's lowest day following, re-detection keeping the settings, the CHECK refusing another
  value). Since E1c, resolve-undo-e1c (a real Resolve's batch id on every tombstone and in the list; the batch restored
  with notes and splits while a bank-removed row stays; a second restore duplicating nothing; an emptied batch a 404; a
  later single delete in no batch). Since the E1 follow-ons, e1-followons (the migration batching a pre-E1c Resolve's
  tombstones and leaving a single delete and a re-run alone; a batch's restorable count without a bank-removed row or one
  whose account is gone; a rename rule folding a transfer and a subscription into existing rows keeping their forecast
  settings; an incoming transfer's setting a 400 that changes nothing). Since E2a, job-runner-e2a (two runners checking at
  once run each due job once; a restart right after a run runs nothing and a 2-hour-old run is due again; the claim and
  job-health's flush leave each other's columns alone). Since E2b, scheduler-e2b (the real registry's first check running
  all 16 real job bodies on a fresh database and stamping last_ran_at; a restart and a concurrent second runner running
  nothing; a 2-hour-old run due again, a 10-minute-old one not). Since E2c, txn-watermark-e2c (a charge and a paycheck
  whose ids sit below a check's mark, committed after it, each announced by the next run once — the anomaly notification
  carrying transaction_id; a long-open transaction elsewhere no longer holding a new charge back; each id backfilled once
  from its time watermark). Since E2d, whats-new-e2d (a transaction and a notification arriving between the widget's GET
  and /seen shown on the next visit and not again; an older token not moving the watermark back; a future / too-high
  token capped and a malformed one a 400; a token-less /seen meaning "seen up to now"). Since E3b, notify-e3b (quiet hours
  and mutes set through PATCH /api/settings: a push held inside quiet hours and pushed once after them, pin-lockout pushed
  during them, a muted kind logged muted with its email skipped, a fresh process releasing rows held before it, a 13-hour-old
  hold expired on the real SQL, the push_state CHECK). Since E3d, notify-e3d (both apps' real databases wired as the
  shell wires them: with linked tasks off the rent and utility-amount reminders pushed with their item_key; on, one task
  each and both reminders logged covered and read — the bell's unread count 0 — with nothing pushed; the rent task
  completed by hand → the next rent reminder pushed again). Since E3e, notify-e3e (both apps' real databases wired as
  the shell wires them: with linked tasks off Perfin pushes the rent reminder and Per-sistant's check lists housing_due
  with its item and notify:false — notifying again once that push is 13 hours old; on, Perfin's push covered, housing_due
  left out and the task's own entry carrying the item and notifying). Since E4a, operator-freshness-e4a (a fresh
  database failing local:backup without a GitHub token, cleared by db-backup.yml's own statement read out of the
  workflow and failing again at 40 h; reset-fresh's to_jsonb read on the real schema; a GOOD Plaid item under sandbox
  warning — a CSV item not counted — and a Teller enrollment without a certificate failing until SUSPENDED, through GET
  /api/operator-checks and data-health).
  325 tests, run
  with and without pgvector; mutation checks (dropping the FAN-1 `::numeric`
  cast, swapping the DC-1 mount order, raw export dates, Plaid counting every
  upsert as an insert, dropping the sensitivity filter from keyword retrieval)
  turn it red;
  `apps/per-sistant/tests/scan-sept-batch14.test.js` — the Sept 2026 broad-scan
  Batch 14 Per-sistant pins: Job Radar profile-edit reset (PB-4), live re-score /
  fit backfill / stale + scam + unscored buckets / batched embeds (PB-5/PB-6),
  company deactivate (PB-7), dismiss nudge (PB-9), fetch timeouts (PB-19), the
  service worker run in a vm against fake caches — 503, no secret caching,
  replay rules (PB-17), task location (PD-5), automation validation / wiring /
  isolation (PD-6), Ask model column + db/024 (PD-7), one-recipient validation
  (PD-9), iCal escaping (PD-11), dependency cycles (PD-12), template apply
  transaction (PD-13), review overdue (PD-14), recurring undo (PUI-3), Jobs views
  (PUI-4), keyboard/dialog wiring (PUI-5), webhook events (PUI-6), http(s) apply
  links (PUI-7) and embedded keep-alive (PUI-8);
  `tests/scan-sept-batch13.test.js` — the Sept 2026 broad-scan Batch 13 Perfin UI
  pins: the real PYRAMID_MODES block run against canned responses (WD-4/WD-5),
  writeOk / parseAmountInput + the 0%-share route + each named write (WUI-6/WD-12),
  CSV Auto-detect / Accounts preview / no Plaid pre-build (WD-7/WD-8), Add Goal,
  loan option, transports, account history (WD-9/11/13/15), dialog wiring (IF-1),
  calendar buttons (IF-2), a scan for unlabeled controls (IF-3), a scan for
  undefined `var(--x)` (IF-4), --on-teal / opaque modals (IF-5), the PIN pad (IF-6)
  and notification links (IF-7);
  `tests/scan-sept-batch12.test.js` — the Sept 2026 broad-scan Batch 12
  investment pins: sold-holding prune scoped to the response's accounts (BSI-4),
  NULL cost basis + known-basis return + coverage + the nullable column (BSI-5),
  winners/losers by sign (WD-17), mid-window account entry flows in TWR/XIRR
  (BSI-6), the sparkline history source (WD-2), the funding-options phantom
  dedupe + orphan warning (WD-10), the empty-range chart + reconcile leg errors
  (WD-17), and parseMoney CR/DR/trailing minus + chase_checking + the
  trailing-comma preview (BSI-16);
  `apps/per-sistant/tests/scan-sept-batch11.test.js` — the Sept 2026 broad-scan
  Batch 11 Knowledge pins: vault ingest without Voyage/pgvector + embedding
  backfill + unchanged-embedding retention (KR-3), stopwords / per-source vector
  ranking / matching-passage window (KR-4), Voyage retry + per-file isolation +
  removals first + sha hold (KR-7), the lock claimed before the first await
  (KR-8), the finance snapshot vs getNetWorth (KR-9), capture reserved keys +
  sensitivity with no AI call for private/secret (KR-10), success-only
  last_synced_at + attempt stamp + reindex outcome + vault_sync_error reminder +
  the polling Action (KR-11), inline-citation parsing (KR-12), cache prune
  (KR-13) and word-segment attribute matching + vault_repo validation (KR-14);
  `tests/scan-sept-batch10.test.js` — the Sept 2026 broad-scan Batch 10
  Sheets/export pins, driven against a stateful fake Sheets API: persisted
  sync outcome + signature-deduped alert + data-health issue + "Partial" UI
  (SXE-1/WD-6), re-runnable formatting (banding/conditional rules deleted
  before re-adding, Dashboard format reset — SXE-2), the sheet-id cache +
  429-only POST retry (SXE-14), archive delay / completion marker / rebuild /
  per-run cap (SXE-3), derived goal amounts (SXE-5), the app category
  expression (SXE-6), the KPI count format (SXE-10), the formula-injection
  guard for Sheets + CSV (SXE-13), ISO dates + user merchant names in
  /api/export (SXE-8/PSC-10), context-export real insights / investments / no
  phantom / debts as owed (SXE-9) and the Code.gs layout check (SXE-15);
  `tests/scan-sept-batch9.test.js` + `apps/per-sistant/tests/scan-sept-batch9.test.js`
  — the Sept 2026 broad-scan Batch 9 platform pins: Secure cookie via req.secure
  + no stack traces (PSC-4), SHELL_SECRET fail-fast (PSC-11), global PIN ceiling
  + lockout alert (PSC-14), 1mb body limit (PSC-7), return_to carry-through
  (PSC-9), limiter skips (PSC-8), guarded constraints (PSC-13), reset-fresh
  schema classification (PSC-6), shell deps / csv-import workflow / settings 400s
  (PSC-15), standalone Sign Out (WD-16), and Per-sistant's resolving SSRF check
  (PB-14), signed-webhook auth exemption (PB-15) and embedded Log Out (PB-21);
  `tests/scan-sept-batch8.test.js` + `apps/per-sistant/tests/scan-sept-batch8.test.js`
  — the Sept 2026 broad-scan Batch 8 scheduler/notification pins: auto-sync
  notification gate on real balance changes + the sync-notifications toggle
  (PSC-1/DD-7), away-from-app channels driven by watermarks rather than recent
  activity (PSC-3), the keep-alive config cache (PSC-2), single-flight sync /
  categorize (PSC-12), same-day "since you last looked" balance changes +
  debt-aware colours (DD-5/DD-6), and the Per-sistant notification types +
  Reminders widget (PB-1), Job Radar refresh flag (PB-3), locked complete/skip +
  catch-up due date + bulk complete (PB-11/PB-12/PD-3) and one-row email
  claims (PD-8);
  `tests/model-upgrade.test.js` + `apps/per-sistant/tests/model-upgrade.test.js`
  — the Claude 5.5 upgrade pins: MODEL_MAP / AI_MODELS IDs, 5.5 prices incl.
  Haiku's long-prompt card, a repo-wide scan for forced tool_choice, an explicit
  effort on every model call, closed strict-tool schemas, createToolCall's
  re-ask/usage-sum/no-retry-on-refusal rules, and Per-sistant text-by-type +
  refusal handling; `tests/scan-sept-batch7.test.js` — the Sept 2026 broad-scan
  Batch 7 AI pins: ID-keyed prices (AIN-9), capped+charged budget suggestions and
  the shared monthAiSpendCents (AIN-10), an 18-statement audit false-positive set
  plus true-positive checks (AIN-1/2/3), partial-month prompt labels (AIN-4),
  anomaly self-exclusion (AIN-5), unknown-limit utilization (AIN-7), summary
  preservation / strict tool / empty insight (AIN-8), module toggle + digest
  colours + empty digest (AIN-11/14/16), and the tax report computed from
  transactions (SXE-7/AIN-12);
  `tests/scan-sept-batch6.test.js` + `tests/scan-sept-batch6-tz.test.js` +
  `apps/per-sistant/tests/scan-sept-batch6.test.js` — the Sept 2026 broad-scan
  Batch 6 date/month/budget pins: prior-month snapshot refresh window (FAN-7),
  the shared getBudgetStatus helper (AIN-6/SXE-4/WUI-5), complete-month budget
  suggestions + PATCH validation (FAN-8/FAN-14), wall-clock daily digest
  (AIN-15), Sheets tz windows + ICS overdue rent (SXE-12), income-summary
  completed-month average + YoY same-day cap (FAN-13/DD-11), local calendar-date
  parsing (WUI-2), month-end-safe month addition (FAN-15), Per-sistant recurrence
  anchor day / missed instances / tz streak check (PD-2/PB-10/PD-4) and the
  knowledge-cache corpus version + unchanged-row skip (KR-5); the `-tz` file
  forces an APP_TIMEZONE whose date differs from UTC's so UTC anchors fail;
  `tests/scan-sept-batch5.test.js` + `apps/per-sistant/tests/scan-sept-batch5.test.js`
  — the Sept 2026 broad-scan Batch 5 Rent/Utilities/Settle Up pins: trailing
  24-month generation (FAN-3), rename carry-over + payee scoping (FAN-4),
  awaiting-bill gate (FAN-9), merchant-pattern double-count guard (FAN-10),
  prior-month default (FAN-11), refund-netted / pending-free settlement
  (FAN-12), basePath links + Activity deep-link filters (WUI-3), and the shared
  day-granular Per-sistant housingDue helper (PB-2);
  `tests/scan-sept-batch4.test.js` — the Sept 2026 broad-scan Batch 4
  detection/calendar/bookkeeping pins, run against the REAL detectors over a
  mock pool: stale series never re-detected (DC-2), latest-gap + ceil-majority
  + ±2% two-charge rules (DC-8), recent-price anchor (DC-7), calendar-month
  stepping anchored on the last charge (DC-9), cadence-based calendar income
  (DC-10), user-set transfer_type (DC-4), CSV-overlap via status='CSV' (DC-5),
  manual-balance roll-forward (DC-6), default paid_amount (SXE-11), manual-bill
  PATCH validation / manual-cash is_manual / rows_skipped / shared calendar+ICS
  manual-bill placement (DC-15); `tests/detect-subscriptions.test.js` likewise
  drives the real `detectSubscriptions` (it used to test an inline copy);
  `tests/scan-sept-batch3.test.js` — the Sept 2026 broad-scan Batch 3
  income/spending-classification pins: alias-qualified incomePredicate
  (FAN-2), raw-description matching (DD-2), Plaid PFC income/transfer +
  free PFC map + credit→Income pass (DD-3), depository-only cash-flow balance
  + subscription/autopay de-duplication (FAN-5/DD-4), completed-month
  spending averages (FAN-6), Teller map fixes (DC-12), exact "remember" rules
  (DC-13), text[] category params (DC-14), Ask total filters (AIN-13);
  `tests/scan-sept-batch2.test.js` — the Sept 2026 broad-scan Batch 2
  BEHAVIORAL sync pins (mock pool + stubbed Teller/Plaid clients): unified
  Teller+Plaid /api/sync with one anomaly check, Plaid new-account
  registration / mutation-restart / re-auth code, Teller insert-failure
  watermark hold / 7-day lookback / DISCONNECTED + self-restore / re-link
  re-point / new-account registration, per-provider last_sync_result merge,
  Plaid unlink cleanup;
  `tests/scan-sept-fixes.test.js` + `apps/per-sistant/tests/scan-sept-fixes.test.js`
  — the Sept 2026 broad-scan Batch 1 pins: housing PATCH typed param,
  bulk-category route order in the real server.js mount order, calendar
  paid-state key, basePath tax links, no un-nonced `<style>`, fail-closed
  vault sensitivity, vault mark-and-sweep, hard-deleted-note retrieval
  guard, Save-Draft/Send-now/local-datetime email fixes;
  `tests/cycle-fixes.test.js` + `apps/per-sistant/tests/cycle-fixes.test.js`
  — regression tests pinning the net-worth single-source-of-truth,
  budget-rollover month-keying, the AI-audit completion marker, and the
  Tier 1/Tier 2 broad-scan fixes: webhook replay/expiry, markdown-link &
  attachment-header sanitization, email status validation, CSV dedup-ID
  parity, Plaid balance-sync status filter, categorize cap-charge ordering,
  tax user-merchant override, decryption_failed surfacing, recurring-cron
  atomic claim — and `tests/broad-scan-fixes.test.js`, pinning the June 2026
  broad-scan fixes: backup workflow shape, fail-fast token passphrase,
  compromised-cert fingerprint check, job-health watchdog, budget-alert
  24h dedup — and `tests/seams-audit.test.js` (seams audit #2 pins: the
  repo-wide SPLIT_AMOUNT never-re-inlined scan, INV-48, and the
  EMAIL_EVENTS↔receiver symmetry check, INV-49) — plus
  tests/investment-performance.test.js (benchmark fetch +
  portfolio series), tests/investment-flows.test.js (TWR/XIRR + Plaid flow
  classification), tests/budget-cap-webauthn.test.js (tunable AI cap +
  embedded biometric registration + webauthn transports, INV-50),
  tests/pwa-polish.test.js (pull-to-refresh + safe-area pins),
  tests/sync-idempotency.test.js (BEHAVIORAL S1/INV-01/03/04: runs Teller
  syncAllEnrollments + Plaid syncPlaidItemTransactions TWICE over the same
  mock fixtures and asserts the 2nd run adds 0 with no dupes + stable
  watermark — previously source-string-pinned only), and
  tests/ai-cap-charge.test.js (BEHAVIORAL S3/INV-13/14 via a Module._load
  fake @anthropic-ai/sdk: /api/ask + runCategorize charge their usage rows,
  429 once the cap is hit, ask charges accumulated tokens AND still charges
  on a mid-loop failure — F1).
- `.github/workflows/ci.yml` — CI pipeline: `npm ci` + `npm test`, PLUS a `migrations` job that runs both apps' auto-migrations twice against a real empty Postgres (pgvector/pgvector:pg16 service container, `scripts/ci-migration-test.js`) — catches non-idempotent/fresh-DB migration failures before deploy. Both pools honor `PGSSLMODE=disable` solely for this plaintext container. PLUS an `e2e` job: Playwright browser smokes (`npm run test:e2e`, e2e/) — real Chromium login flow (wrong+right PIN, post-login default), both apps' core pages, and the calendar-feed gate, against a scratch DB booted by `e2e/boot-server.js` — plus `e2e/pages.spec.js` (cycle-7 F137): every Perfin and Per-sistant page loaded in a real browser, failing on an uncaught page error or a non-501 5xx (logs in once and reuses the cookie so Per-sistant's limiter isn't tripped; a `KNOWN_GAPS` map tolerates filed gaps and must only shrink — empty since roadmap T1.5 Batch C fixed the Review page's review-summary 500), with targeted checks for the Rent page utility row (F87), account history (F88), the toast cap (F89), the nav badge + bell + logo (F90/F93) and the offline page (F92). Since cycle-7 Batch 20 (G2) the run is SEEDED (`e2e/seed.js`, in the spec's beforeAll — through the apps' own routes: housing config + generated obligations, a manual account + manual expense, a generic CSV with a refund row and a split, a rollover budget, a goal, a subscription, a credit score, one transaction deleted through the route, a Plaid-free tax year — a paycheck and a pharmacy charge on a CSV account and a 1099-NEC on the checklist, T3.3 K4; Per-sistant notes in each privacy tier, a habit with logs, a todo with subtasks; one Job Radar listing and one linked task inserted directly, since no route creates either), a `console.error` fails a page (the browser's "Failed to load resource" line is left to the response check), and a CLICK SWEEP per page presses every visible, enabled `button / [role=button|checkbox|tab] / summary` counted on load (≤80) that isn't `data-e2e-skip` or labelled destructive (delete / remove / unlink / send / empty / sign out / log out / reset / purge / disconnect / archive / trash / revoke / cancel subscription / mark settled), dismissing dialogs and returning to the page between presses; a failure names the control pressed, and `SWEEP_KNOWN_GAPS` must only shrink. Mark a new destructive, off-app (an external SDK) or device-permission control (microphone) `data-e2e-skip`. 74 tests (24 of them sweeps, ~230 controls pressed — plus the linked-task chip on the To-Dos page and in its edit modal, T2.4 X1b, the unified search: Perfin's nav link to /per-sistant/search, a seeded Perfin transaction found there and its link opening Activity filtered, T2.4 X3b, and undelete: the seeded deletion listed in Settings → Sync Health → Deleted transactions and brought back by Restore, and a toast's Undo button, T2.5 U2, the top nav one row at the same size on five Perfin pages and no attachments-migration error after a fresh boot, design D1, and the dashboard (design D3 / D4): the Summary card and Needs attention with the rent item opening the Rent page, and on a phone the summary on the first screen with the pyramid collapsed until opened (then kept open, its tabs a no-wrap scroll row), Settings (design D5): /settings#sync-health, #deleted-transactions (opened) and #recent-errors landing on their sections with Sync & Connections marked in the sticky index, and on a phone the Jump to select, and the Tax page: its sections for the seeded Plaid-free year,
a form added through the page and marked received, and the ZIP download, T3.3 K4, and the landing page (design D7): each tile's status line, the Perfin one naming the seeded rent, and the Cash Flow section's "What's in this forecast" list (cycle-8 E1b): the seeded subscription's setting switched to Leave out and back, and Settings → Quiet Hours & Muting (cycle-8 E3c): quiet hours and a mute saved and read back, and Per-sistant's Settings link to it). The `migrations` job ALSO runs the route contract suite (`npm run test:contract`, step "Route contract tests against real Postgres", `CONTRACT_DATABASE_URL` = the same service container; the Postgres user must be able to CREATE/DROP DATABASE).
- `.claude/commands/` — Project slash-command prompts, generated from the
  claude-workflow-tools templates (synced to v1.43.0 via `/sync-commands`):
  the cycle commands (`/broad-scan`, `/broad-implement`, `/targeted-audit`,
  `/targeted-implement`, `/audit`, `/plan`, `/implement`, `/regression`,
  `/reflect`, `/health-pulse`, `/pr-review`, …), navigation (`/cycle-status`,
  `/cycle-resume`, `/cycle-init`), and maintenance (`/test-sync`,
  `/sync-docs`, `/sync-commands`, `/setup-cycle`, `/systems-map`, `/roadmap`).
  Summary blocks for fresh-session consumption land in `.cycle/blocks/`.
- `deploy/vps/` — DRAFT single-VPS deployment (not live; the app still runs on
  Render + Neon): `docker-compose.yml` (app from GHCR + `pgvector/pgvector` +
  Caddy; Postgres unpublished, the app runs `PGSSLMODE=disable` on the compose
  network), `postgres-init/01-databases.sh` (the `app` role, `perfin` +
  `persistent` databases, pgcrypto + vector as superuser), `Caddyfile`,
  `.env.example` / `app.env.example` (compose settings vs the app's environment —
  the VPS template sets `PUBLIC_URL`, `ALWAYS_ON=true` and `SERVER_BACKUPS=true`
  — `services/hosting.js`), `deploy.sh` (the
  forced-command target of `.github/workflows/deploy-vps.yml`: validates the tag,
  pulls, restarts, waits for the image healthcheck, rolls back to the previous
  tag on failure), `backup.sh` (nightly gpg-AES256 dumps in db-backup.yml's
  format, verified with `pg_restore --list`, rclone offsite, healthchecks ping)
  and `RUNBOOK.md` (harden → rehearse → cutover from Neon with `pg_dump` /
  `pg_restore -L` minus extension entries, `--role=app` → verify counts + token
  decryption → repoint → rollback → decommission). `backup.sh` stamps
  `user_settings.last_backup_at` (and `last_backup_source = 'server'`) after each
  verified run; with `SERVER_BACKUPS` Operator Checks reads that stamp (no GitHub
  token needed) and lists the Database Backup / Keep Alive workflows as "not
  needed" instead of warning. (Since cycle-8 E4a `db-backup.yml` writes the same
  stamp with source `github`.)
- `Dockerfile`, `fly.toml`, `render.yaml` — Deployment configs (the Dockerfile
  installs all workspaces and boots `node shell/index.js`; render.yaml uses
  `npm install` + `npm start` and bypasses the Dockerfile). The Dockerfile sets
  `ENV NODE_ENV=production` AFTER the install and fly.toml sets it in `[env]`
  (PSC-4); render.yaml deliberately does NOT (Render passes envVars to the build
  too, and NODE_ENV=production makes `npm install` skip devDependencies) — the
  shell's Secure-cookie and error-handler behaviour don't depend on it. The
  Dockerfile creates and chowns `apps/per-sistant/uploads` to `appuser` before
  `USER appuser` (cycle-7 F13 — it was root-owned; only the legacy disk-attachment
  migration reads it now).
- Workflow hygiene (cycle-7 F5/F16): every workflow declares `permissions:
  contents: read` (only csv-import has `write`). In `daily-sync.yml` the steps
  after "Sync transactions" are independent backstops — each runs with `if:
  ${{ !cancelled() }}`, so one failed or timed-out call no longer skips the
  balance sync, snapshot and detection — and a `CHECK_STATUS` helper turns a
  curl timeout ("000") into an `::error::` annotation instead of a silent
  `bash -e` exit (each `curl` ends `|| true`). Since cycle-7 Batch 18 (ST1) every
  workflow that calls the app defines `check_status` (weekly-reconcile,
  knowledge-reindex and job-radar used to exit silently on a timeout; it takes an
  expected-status list, default 200), and daily-sync's two sync steps and
  weekly-reconcile run IN THE BACKGROUND through a `RUN_BACKGROUND` helper:
  `run_background <label> <path> <kind> <out> <body>` POSTs `{"background": true}`
  (409 → follows the job already running), polls `/perfin/api/sync/status?kind=` by
  job id every `BG_POLL_SECONDS` (15) for up to `BG_DEADLINE_SECONDS` (1200), and
  fails the step on the job's error, a lost run (its id gone — a restart), a failed
  start or the deadline — never printing the job's error text; the final status is
  printed only through `SUMMARY_JS` (`result.*` keys). The job env carries
  `SERVER_URL` / `API_KEY` from secrets for it.
- `.github/workflows/csv-import.yml` — imports CSVs pushed to `csv-uploads/`
  (scripts/import-csv-cli.js → Sheets), then `git rm`s them (PSC-15: they used to
  be archived under `csv-uploads/processed/`, keeping raw bank statements in every
  checkout) and pushes. It removes ONLY the files listed in the CLI's
  `CSV_IMPORTED_LIST` manifest, and runs that step after a partial failure too,
  so a file that failed to import stays for a retry (F19 — the CLI used to exit
  0 on a failed file and the step `git rm`'d every CSV) — hence its `permissions: contents: write`. Its FIRST
  step fails the run while the repository is public (cycle-7 F2): a CSV pushed
  to a public repo is published the moment it lands, so `git rm` afterwards
  can't take it back — use the in-app CSV import instead.
- `mobile/` — Capacitor iOS wrapper (remote-URL mode: the WebView loads the
  live Render deployment, so server deploys ARE app updates; no bundled web
  build). Deliberately NOT in the root npm workspaces so server deploys never
  install native tooling. Free-signing build (7-day re-sign from Xcode, NO
  APNs push — notifications keep flowing through the installed PWA, which
  coexists as a separate icon/session for A/B comparison). Pull-to-refresh in
  both apps' shared JS also activates under `window.Capacitor` (the WebView
  reports display-mode: browser). Build runbook + Phase-2 device checklist:
  `mobile/README.md`. Teller/Plaid domains are allowlisted in
  `capacitor.config.json` server.allowNavigation so bank-link flows stay
  in-WebView.

## Features

### Core Financial
- **Bank linking**: Teller Connect UI + mTLS API for transaction sync
- **Bank auto-sync** (Phase A): opt-in scheduled sync every 1/3/6/12/24 hours.
  Settings toggle drives an in-process scheduler that calls `syncAllEnrollments`
  + `syncAllBalances` directly (no HTTP self-fetch). Default: disabled.
- **Investment accounts** (three sources, unified via `GET /api/investments`):
  - **Teller-linked** brokerage / IRA / 401k / 403b / 529 / HSA / Roth IRA /
    pension accounts enrolled via Teller Connect. Live in `linked_accounts`
    (the standard Teller table). Account-level balance only — Teller's API
    does NOT expose holdings or cost basis. Detection list:
    `services/financial-queries.js INVESTMENT_ACCOUNT_TYPES`. Shows up in
    goal funding-options, contributes to net worth, syncs balance via the
    standard `syncAllBalances` path.
  - **Plaid-linked**: full holdings sync (qty / cost basis / current value
    per security). Stored in `investment_accounts` + `investment_holdings`.
    **Link update mode (cycle-7 G3):** a connected Plaid item is repaired or
    extended IN PLACE from the Accounts page — "Re-authenticate" (shown while
    `plaid_items.last_error_code` is set) and "Add accounts" (every Plaid item,
    incl. investments-only) open Plaid Link with an update-mode token, then
    `POST /api/plaid/update-complete` registers new accounts, clears the flag and
    syncs that one Item. The Item, its transactions and the edits on them stay
    (it used to take unlink + link). An item that NEWLY gets a re-auth code sends
    one "Bank connection needs re-authentication" notification (tag
    `plaid-reauth-<id>`, deep link `/accounts`). On iOS / iPadOS, in the
    home-screen app and in the Capacitor wrapper (`prefersHostedPlaidLink()` —
    an iPhone / iPad UA or a Mac UA with touch points, `display-mode: standalone`
    / `navigator.standalone`, `window.Capacitor`) the buttons go through Plaid's
    HOSTED page instead of the in-page Link, whose popup OAuth doesn't come back
    there (roadmap T2.5 H1): the token request carries `hosted: true` +
    `redirect_uri`, the page keeps `{ item_id, kind, name, link_token }` in
    sessionStorage (`perfin_plaid_update`) and redirects; back on the Accounts
    page `handlePlaidUpdateReturn` removes that state and cleans the URL, then
    sends the `link_token` to update-complete, which reads the Link session
    (`linkTokenGet`) first and changes nothing unless one finished without an exit.
    Endpoints: `/api/plaid/{status,link-token,exchange,sync-holdings,holdings}`.
    Holdings sync (`syncAllPlaidHoldings`) UPSERTs `investment_accounts` so the
    rows survive a reset/wipe, and uses the sum of an account's holdings as the
    balance when Plaid returns a null OR zero account-level balance (Schwab
    reports `balances.current === 0` and puts the value in holdings) so
    brokerages don't show $0 — the balance pick uses `||`, not `??`, precisely
    so a reported 0 falls through to the holdings-sum. It runs automatically (auto-sync + AI pre-insights
    chains + `POST /api/sync-balances`), not just at link time. Every holdings
    write (the sync and both exchange paths) goes through `writePlaidHoldings`,
    which upserts the returned holdings and then DELETES that response's
    accounts' holdings Plaid no longer returns — sold or transferred-out
    positions used to stay forever (BSI-4; only accounts present in the
    response are touched). An unknown cost basis is stored NULL
    (`investment_holdings.cost_basis` is nullable), never $0 (BSI-5).
    Plaid also syncs **transactions** for banks Teller doesn't cover
    (Capital One, Discover, Schwab, Amex, credit unions) via
    `/api/plaid/{link-token-transactions,exchange-transactions,sync-transactions}`.
    The link token requests both `Products.Transactions` and
    `Products.Investments` in one session with `days_requested: 730`
    (2 years; some banks cap lower). Transactions land in the same
    `transactions` table as Teller-synced ones so the entire pipeline
    works without changes. Uses Plaid's cursor-based `transactionsSync`
    (not the deprecated `transactionsGet`); Capital One doesn't support
    `/transactions/refresh` but cursor-based sync handles it.
  - **Manual**: user-entered via `POST /api/investment-accounts`. Stored in
    `investment_accounts` with no `plaid_account_id`.
- **CSV import**: Auto-detect Chase (card + checking), Capital One, Discover, Wells Fargo, Schwab formats.
  The header parse uses `relax_column_count` (route + CLI) because Chase checking
  exports end every data row with a trailing comma, which used to fail the whole
  file with "Invalid Record Length" (BSI-16).
  The dashboard CSV modal is **preview-and-confirm**: it first POSTs `POST
  /api/import-csv/preview` (a dry-run that detects the format and classifies every
  row new/duplicate/skipped against existing `transaction_id`s WITHOUT writing,
  using the SAME `makeCsvTxnIdGenerator` the commit uses), shows the counts + a
  sample table, then the user confirms to `POST /api/import-csv`. Both routes share
  the `parseCsvUpload()` helper (in `routes/subscriptions.js`) so format detection,
  account-label derivation, and dedup IDs can't drift between preview and commit.
  The Accounts page uses the same two steps (Preview → "Import N new"), and both forms
  default the bank dropdown to **"Auto-detect from the file"**, which sends NO
  `institution` / `account_label` so the route derives them from the detected format —
  the CLI's default, so the two produce the same dedup IDs (WD-7: the dropdown used to
  default to "Chase" and always send it, filing a Discover file under "Chase Account"
  and duplicating every row a CLI import had added).
  **Generic-file sign (cycle-7 F26):** a file in no known bank format may write
  deposits positive. The preview returns `sign_guess` (`guessGenericSign`) and
  `positive_means` (what it applied); both forms then show a "Positive amounts in
  this file are charges / deposits" select (generic files only), pre-set to the
  guess — re-previewing with it — and send `positive_means` with the preview and
  the import through the shared `parseCsvUpload`. With nothing sent the route
  reads positives as charges (the old behaviour), so an earlier import keeps its
  dedup IDs; choosing the opposite sign for an already-imported file makes new IDs,
  which the preview shows as "new" rows. Known formats ignore it.
- **Transaction deduplication**: SHA256-based duplicate detection across CSV imports and API syncs.
  CSV dedup IDs fold in a deterministic per-file occurrence index, so two genuinely-distinct rows
  sharing (account, date, amount, merchant) on the same day no longer collide and silently drop the
  second (F1); re-importing the same file still deduplicates against itself. `POST /api/import-csv`
  returns `rows_duplicate` (true re-imports of already-present rows) alongside `rows_imported` /
  `rows_skipped` — and `rows_skipped` counts ONLY unparseable rows (DC-15; it used to include the
  duplicates too, so it disagreed with the preview). The `csv_imports` history row keeps its
  "not imported" meaning (skipped + duplicates), same as the CLI.
  **A deleted transaction stays deleted (cycle-7 F20):** `DELETE /api/transactions/:id` records
  the id in `deleted_transactions` (same transaction as the delete), and the Teller and Plaid
  upserts are `INSERT … SELECT … WHERE NOT EXISTS (deleted_transactions)` — the 7-day lookback,
  the weekly reconcile and a Plaid reconcile used to re-insert a row the duplicate cleanup had
  removed. A skipped row is neither inserted nor counted and isn't a failed page. **Undelete
  (roadmap T2.5 U1):** the DELETE also keeps the row and its splits as they were
  (`deleted_transactions.snapshot`) and the connection it came from (`source`: teller / plaid /
  csv / manual); `POST /api/deleted-transactions/:id/restore` puts the snapshot back (category,
  notes, rename, splits — only the columns `transactions` still has, a new id) and lifts the
  tombstone in one transaction, never duplicating a row already there, and refuses (409,
  nothing changed) once the account is gone. A tombstone written before U1 has no snapshot:
  Restore lifts it and says how the row returns (`returns_on`: reconcile / csv_reimport), and
  a manual entry deleted before U1 can't be restored. CSV imports honour the tombstone too
  (preview, import and CLI — `rows_deleted`), so re-importing a file no longer brings back a
  row you deleted. **The undelete UI (T2.5 U2):** Settings → Sync Health → **Deleted
  transactions** (collapsible, `#deleted-transactions`) lists them newest first, 50 at a time
  with Show more — date, merchant, amount, account and split count from the snapshot, or the id
  alone for a row deleted before U1 — each with a labelled Restore button (none for a pre-U1
  manual entry); the Activity page's delete toast offers **Undo**. Both go through
  `restoreTransaction` (perfin-shared.js), which toasts the outcome — for a pre-U1 row, how it
  returns ("Reconcile Now" / "import its CSV file again"). **The bank's later changes (cycle-8
  F6, Plaid only):** a Plaid `modified` delivery for a tombstoned id stamps
  `deleted_transactions.bank_changed_at`, a `removed` one `bank_removed_at`; a restore refuses a
  removed row (409 `reason: "removed_by_bank"`, nothing changed) and returns `stale: true` for a
  changed one (the toast says to run a Plaid Reconcile Now — Plaid won't send it again). A restored
  row takes its rename rule's CURRENT name, or loses the rename of a rule deleted or switched off
  while it was gone, then every rule applies (F5). CSV-overlap **Resolve** tombstones (with a
  snapshot and source) the rows it deletes, in the same transaction (F4), so they can be restored
  and a CSV re-import skips them. **One Resolve is one batch (cycle-8 E1c, G5):** its tombstones
  share a `batch_id` (returned by Resolve), and Settings → Sync Health → Deleted transactions shows
  "Removed by a CSV overlap resolve — N rows" with **Restore all N** (`POST
  /api/deleted-transactions/batches/:batch_id/restore`): every row back in one transaction with its
  notes and splits, the rename rules run once; a row whose account is gone or that the bank removed
  stays deleted and is named in the message. The header counts only the rows that can come back and
  says how many can't; a Resolve made before E1c is grouped by the migration (its tombstones share one
  deleted_at) under a `resolve_<hash>_legacy` id. **CSV-overlap (F21)** pairs a CSV row with a synced row one-to-one, only
  when the merchants look alike (a shared word of 3+ letters, or a ≥4-letter prefix, noise words
  ignored; the synced row's raw description is tried too), closest date first — amount + date
  alone matched two different $4.50 coffees and let one synced row claim every same-amount CSV
  row near it, so Resolve could delete genuine rows. GET and Resolve share the same pairs.
- **CSV import → manual account balance** (DC-6): when the import's institution/label exactly
  matches a manual account, that account's KNOWN balance is ROLLED FORWARD by only the rows this
  import genuinely inserted that are dated after its `balance_updated_at` (credit: + net spend;
  depository: − net spend). An account with no known balance is left alone. (It used to be
  OVERWRITTEN with the net of every CSV row ever imported — a partial statement history, not a
  balance.) Matching (cycle-7 F25): an exact account-label match beats an institution match,
  and when the best level matches more than one account nothing is rolled; a **loan** rolls like
  a credit card (an amount owed); the as-of date is `balance_updated_at`'s APP_TIMEZONE day, and
  the new balance is stamped as of the newest included row (local noon), not "now". The step runs
  under `SAVEPOINT csv_balance` and logs a failure — the import itself still commits.
- **Manual cash entry**: a one-off expense the bank never sees (cash spending),
  added via `POST /api/transactions/manual` and an "+ Add cash transaction"
  modal on the Transactions page. Requires an existing `is_manual` (depository)
  account — the route 400s a synced (Teller/Plaid/CSV) account (DC-15; before,
  only existence was checked) — make a "Cash" account via `POST /api/accounts/manual` first; the
  modal lists only those and links to the Accounts page when none exist. Stores
  the amount POSITIVE (the spending sign every aggregation sums on `amount > 0`),
  category in `category` (a one-element `text[]` parameter, DC-14), notes in `user_notes`, and a
  unique `manual_<ts>_<rand>` transaction_id so it's distinct and untouched by
  re-sync. Flows through every spending query like any other transaction.
  Expense-only by design (cash income is a rare follow-on).
- **Transaction editing** (Phase B1): rename merchants and add notes via
  `PATCH /api/transactions/:id`. User overrides live in `user_merchant_name` /
  `user_notes` columns so re-syncs from Teller don't clobber edits. The display
  layer uses `COALESCE(user_merchant_name, merchant_name, name)` everywhere,
  so renames also collapse duplicate merchant rows in top-merchants ranking.
  The Transactions page provides an Edit modal per row (merchant name, notes,
  reimbursed toggle) that calls the same PATCH endpoint.
- **Merchant rename rules** (cycle-7 F55 / ST2): renaming one transaction used to
  split its merchant (detection keys on the display name, so a subscription
  fragmented into two rows). The Edit dialog's **"Apply to all past and future"**
  (`PATCH /api/transactions/:id { merchant_name, apply_to_all: true }`) saves an
  EXACT rule on the row's RAW merchant (`COALESCE(merchant_name, name)`) in
  `merchant_rename_rules`, renames every past row from it, re-keys the existing
  `detected_subscriptions` / `recurring_transfers` rows from the old merchant keys
  to the new name KEEPING their user state (cancelled, dismissed, category, notes —
  an old-key row whose new key already exists is deactivated instead), then re-runs
  both detectors. Rules fill `user_merchant_name` only where it is NULL and tag the
  row with `user_merchant_rule_id`, so a hand rename always wins (a hand edit clears
  the tag) and deleting a rule reverts exactly its rows. They apply most specific
  first (`RULE_ORDER_SQL`) with the categorization rules' 3-character minimum for
  contains / starts_with, and run after every `syncAllTransactions` (before the
  anomaly check), after a Teller or Plaid reconcile that recovered rows (cycle-8 F43 —
  never the anomaly check), inside the CSV import transaction (`SAVEPOINT csv_rename`),
  after a manual entry and on a restored row (F5). A NEW rule releases the rows
  ANOTHER rule renamed that it also matches, so all rules re-apply most specific
  first, and re-keys only the detection keys no transaction still carries — a
  specific "AMAZON PRIME" rule no longer moves the broad "Amazon" rule's cancelled
  subscription to the new name (cycle-8 F41). Settings → Rules lists them with Edit, Turn off / Turn on
  and Delete (`/api/merchant-rename-rules`). Since roadmap T1.5, `PATCH
  /api/merchant-rename-rules/:id` (`updateRenameRule`) takes a new `rename_to`
  (the rows the rule renamed and the detected subscription / transfer keyed on the
  old name follow it, user state kept, then both detectors re-run) and/or
  `is_active` (off undoes the rule's renames exactly as Delete does but keeps the
  rule; on re-applies it through `createRenameRule`). A new name on a rule that
  stays off is only stored. The pattern and match type are not editable.
- **Reimbursed flag** (Phase B2): mark transactions as reimbursed (work travel,
  medical, friend-paid bills) via the same PATCH endpoint. Excluded from every
  spending aggregation: `/api/spending-summary`, `/api/budgets`,
  `/api/budgets/alerts`, `/api/cash-flow`, `/api/spending-yoy`,
  `/api/savings-rate`, AI insights seasonal/tax/budget-status, scheduled
  budget-alert push, and `getCategorySpendingThisMonth`. Anomaly detection
  baselines deliberately still include reimbursed rows (a reimbursed charge
  is still a valid "what's typical for this merchant" data point).
- **Split transactions** (Phase B3): subdivide a single transaction into N
  `(amount, category, merchant_name, notes)` lines via
  `POST /api/transactions/:id/splits` (max 20 per parent, sum must match parent
  ±$0.01). Splits REPLACE the parent row in per-category aggregations; total
  amounts (monthly trend, cash flow, savings rate) are unchanged because splits
  sum to the parent. Powered by `getCategorySpendingThisMonth` in
  `services/financial-queries.js`. The Activity page's Split modal refuses to
  open when it can't read the existing splits (an empty editor saved over
  them) and carries each split's `merchant_name` through a save (cycle-7 F103).
- **Refunds reduce spending** (cycle-7 F35 / G4): a refund — a settled,
  non-reimbursed credit that `NOT_TRANSFER` keeps (so not a card payment or
  transfer) and that is not income — nets against its category in the month it
  POSTS, and each (month, category) is floored at $0, so a refund never makes a
  month or category negative. Credits are never categorized, so an uncategorized
  refund takes the category of the same display merchant's latest earlier charge
  (180 days), then its own provider category, then "Uncategorized". It counts at
  the shared-card share like the charge. Applies to budgets / alerts / push /
  snapshots, `/api/spending-summary` (trend, categories, top merchants — a
  merchant's refunds net against it), `/api/spending-yoy`, savings rate, FIRE,
  the context export, Ask, the insights trend / seasonal / budget blocks and the
  Sheets Dashboard. A category or merchant with only refunds that month is not
  listed; month `txn_count` counts charges. Charge-level on purpose: the cash-flow
  forecast, anomaly detection, the tax report and Settle Up (which nets
  same-month refunds itself, FAN-12). Trade-off: a credit the filters don't
  recognise as income or a transfer (side income without a payroll keyword, a
  cashback credit) reduces spending too — the floor bounds it.
- **Subscription detection**: Automatic recurring charge identification (30/60/90/365-day cadences).
  The 30-day cadence requires 3+ charges; 60/90/365-day cadences need only 2+
  (1 matching gap) — the same `>= 60` relaxation the recurring-transfer detector
  uses, so quarterly/bi-monthly subscriptions are detected without waiting for a
  third charge (F2; previously gated on `>= 365`).
  The upsert respects user state via an `is_active` CASE: if the user cancelled a subscription
  (`cancelled_at IS NOT NULL`) or dismissed it (`is_dismissed = true`), detection will not
  re-activate it even if the merchant charges again. "Undismiss" re-activates the
  row (unless cancelled) — detection had kept it inactive, so it used to vanish
  from both lists until the next detection run (cycle-7 F56).
  Matching rules (Sept 2026 Batch 4):
  - **Raw description (cycle-7 F49)**: a row whose raw description (`name`, read
    only when the user hasn't renamed the row) carries a payment/transfer phrase
    (the interest / fees / debt_payments / transfers exclusion lists —
    `isExcludedDescription`; the retail list stays merchant-only) is dropped before
    grouping, so monthly "ZELLE TO JOHN SMITH" rent (counterparty "John Smith") is
    not a subscription.
  - **Recency (DC-2)**: a pattern whose last charge is past the stale window
    (`isStale` — the same `max(120d, 1.5×cadence)` the stale sweep uses) is skipped,
    so the upsert can't re-activate a row the sweep just retired. Before, 36 months
    of history kept long-cancelled subscriptions "active" forever.
  - **Strictness (DC-8)**: the LATEST gap must fit the cadence, a TRUE majority of
    gaps must match (`Math.ceil(gaps × 0.5)` — `floor` let 1-of-2 / 1-of-3 through),
    and 2-charge (≥60-day) detection needs amounts within ±2% — two similar
    restaurant meals 55 days apart are no longer a "60-day subscription". Trade-off:
    a charge more than 25% of the cadence late (7.5 days for monthly) isn't
    re-matched on that run (the row just isn't refreshed until the next on-time charge).
  - **Price anchor (DC-7)**: `findAnchorAmount` anchors on the most recent ±10% amount
    cluster when it has ≥ minOcc charges (else the global mode), so 18 × $15.49 then
    6 × $17.99 is reported at $17.99; the persisted row flags the change via the
    upsert's `amount_changed` (and `prior_amount` = the old price) — since cycle-8 F46 both
    are KEPT until a later charge (`last_charged` moves) instead of being recomputed from
    the unchanged amount, so PRICE UP and the watchdog's rise outlast the next run.
  - `next_expected` steps by calendar month (`services/cadence.js`, DC-9).
  DC-7/DC-8 apply to subscriptions only; the transfer detector keeps the
  floor-majority + global-mode amount.
  **Watchdog (cycle-7 F53 / G5)**: `runSubscriptionWatchdog()` runs after every
  detection (fail-soft; `POST /api/detect` returns its counts as `watchdog`).
  **Still charging** — a CANCELLED subscription charged more than 7 days after
  `cancelled_at` (`STILL_CHARGING_GRACE_DAYS`) by the same merchant key at ±25% of
  its amount pushes "<name> charged you after you cancelled" (tag
  `sub-still-charging-<id>`, deep link `/subscriptions`) plus a critical-alert
  email, once per charge (`still_charging_txn`). **Price rise** — an active
  subscription whose amount rose ≥5% or ≥$1 over `prior_amount` within 45 days
  pushes once per new price (`price_alerted_amount`, tag `sub-price-<id>`). Since cycle-8
  F47 a charge 10–50% above the stored price (settled, after `last_charged`, within 45 days)
  pushes "<name> went up from $X to $Y" before detection re-anchors the price (which takes
  three charges at the new price) — not for a utility, once per charged amount. A row
  is marked only when the notification was logged, so a failed send retries. The
  Subscriptions page shows "STILL CHARGING" and "PRICE UP $X" badges.
- **Recurring transfer detection**: Auto-detect Zelle, Venmo, bill payments, savings transfers,
  investment contributions, ACH/wire (7/14/30/60/90/365-day cadences, outgoing/incoming split).
  Stale patterns are skipped (DC-2) and a user-set `transfer_type` survives
  re-detection (DC-4) — see Recurring Transfer Detection below.
- **Utility separation**: Utilities tracked separately from optional subscriptions
- **Shared accounts**: Joint/shared card support with two layers of split:
  account-level (`is_shared`, `spending_split_pct` on `linked_accounts`,
  applied in all spending queries via SQL JOIN — NULL means 100%; the dashboard
  prompt suggests 50 when marking a card shared, and 0 is a real share — all the
  partner's, kept as 0 by Settle Up and the account card since cycle-7 F31) AND
  per-transaction override (`transactions.personal_for`, enum
  `'self' | 'partner' | NULL`, only honored when the account is_shared).
  `'self'` = user owes 100%; `'partner'` = the other cardholder owes 100%;
  `NULL` = use the account-level split. Powers the Shared Card Settlement
  dashboard widget, MINE/PARTNER badges on the Transactions page, and the
  `/api/shared-settlement` endpoints.
- **Financial goals**: Track progress toward savings/investment targets with compound interest projections
  (logarithmic formula), milestone push notifications at 25/50/75/100%
- **Goal funding from accounts** (Phase C): link a goal to a depository or
  investment account; `current_amount` is auto-derived as
  `account_balance - goal_baseline_amount` so the goal advances without manual
  edits. Linking infers the baseline so existing progress is preserved
  (a $3k-saved-of-$4k goal linked to a $5k savings account stays at 75%).
  CHECK constraint enforces only one funding source per goal. The original
  manually-entered value still surfaces as `current_amount_manual`.
- **Net worth tracking**: Automated daily snapshots with trend history
- **Credit utilization**: Derived credit limit display, utilization percentages
- **Credit score tracking**: Manual-entry credit score log (300-850, FICO /
  VantageScore / other). Dashboard widget shows current score color-coded
  (740+=green, 670+=teal, 580+=yellow, <580=red), delta vs prior entry,
  delta vs ~6 months ago, collapsible history, and inline log form.
  Synced to a Google Sheets "Credit Scores" tab with per-entry change
  column (vs the previous entry of the SAME score type — cycle-7 F86: a FICO
  row used to be compared with an interleaved VantageScore). The last 6 score entries + trajectory are injected into the
  AI insights prompt so Claude can correlate score changes with spending
  behavior (e.g. reduced utilization → score improvement) — through
  `creditScoreSummary(rows)` (routes/insights.js): the delta and range compare entries of the
  latest entry's score type, and each other type is listed with its latest score (cycle-8 F50 —
  the prompt still diffed across types).
- **Tax deduction report**: computed at EXPORT time from the transactions ledger
  (SXE-7) by `getTaxDeductionTransactions(pool, year)` in
  `services/financial-queries.js` — one row per matching transaction with its
  date, the whole calendar year, no LIMIT, the user's share of a shared-card
  charge (`SPLIT_AMOUNT > 0`), reimbursed + pending excluded, matched on the
  display merchant against `TAX_REGEX` (word-boundary `TAX_KEYWORD_GROUPS`;
  `taxCategoryFor` picks the group of the LONGEST matching phrase — medical /
  charity / education / business / tax). The `tax_deductions` table is the
  ANNOTATION layer: per-merchant confirm / notes / category (via
  `PATCH /api/tax-deductions/:id`) apply to that merchant's rows; it never
  supplies amounts. (The export used to list those per-merchant rows directly —
  frozen at the last insights run, top 15 merchants only, renamed merchants
  double-counted, Date column blank.) The annotated rows are
  `getTaxDeductionReport(pool, year)` (roadmap T3.3 K3), which the year-end tax
  package reads too.
- **Tax documents checklist** (roadmap T3.3 K2; on the Tax page since K4): per
  calendar year, the forms you're waiting for — W-2, 1099-INT / DIV / B / R / NEC / MISC / K /
  G, 1098 / 1098-E / 1098-T, 1095, other — each with its issuer, the usual "arrives by" date
  (Jan 31; Feb 15 for a 1099-B), received / dismissed and notes. "Suggest from my data"
  (`POST /api/tax/documents/suggest`) adds what the year's data points to (payroll → W-2,
  ≥ $10 of interest → 1099-INT, ≥ $10 of dividends → 1099-DIV, a sale → 1099-B, a retirement
  withdrawal → 1099-R, mortgage interest / student loan interest / tuition → 1098 / 1098-E /
  1098-T) and never touches a row you received, dismissed or added; a suggested row is
  dismissed, not deleted, so it isn't suggested again. A form still missing after its date
  opens a Per-sistant task when linked tasks are on (source `tax_documents`, default on).
- **Year-end tax package** (roadmap T3.3 K3 + K4): `GET
  /api/tax/package?year=&format=json|pdf|zip|csv` gathers, for one calendar year, income (by source,
  kind and month, at your share), investment income per taxable account, realized gains (FIFO over
  stored lots, an estimate — the broker's 1099-B is the authority; a sale without a known basis has
  no gain), retirement distributions, the deduction report, rent and utilities paid, and the
  documents checklist, plus the caveats. Computed on request, never stored, no AI; each figure is the
  same one its existing export shows (deductions = the tax report, rent = the landlord export). A
  section whose read fails says so and the rest still render. The PDF is one summary document (a
  bookmark per section, "for informational purposes only" on the first and last page); the ZIP holds
  that PDF, a CSV per section (formula-guarded) and `package.json`, uncompressed;
  `format=csv&section=<name>` serves one section's CSV. **The Tax page** (`/tax`, K4): a year select
  (last year from January to April, else this year; `?year=`), Download PDF / ZIP, an overview card
  and a card per section with its totals and a CSV link, and the documents checklist (`#documents` —
  Mark received, Dismiss, notes, Delete for a hand-added row, an Add form and "Suggest from my
  data"; a reload keeps notes typed in other rows and the focused control, reloads are sequenced and
  each write is single-flight — cycle-8 F35 / F39). Linked from Settings → Data & Exports ("Open the Tax page") and, from January to April
  only, from the top of the dashboard ("Tax season: your <year> tax package is ready to review");
  the top nav has no link — on a phone the hamburger drawer lists "Tax" after "Rent" from January
  to April (design D7).
- **Manual bills**: User-created expected charges for the bill calendar (name, amount,
  due_day 1-31, cadence monthly/quarterly/yearly, category). CRUD via
  `/api/manual-bills`. Integrated into `/api/bill-calendar` alongside detected
  subscriptions. POST 400s a non-integer due_day (it passed `NaN < 1` and 500'd,
  cycle-7 F57).
- **Bill payment tracking**: Mark bills (both detected subscriptions and manual) as paid
  for specific dates via `/api/bill-payments`. Calendar shows paid state with
  strikethrough + checkmark. Click to toggle paid/unpaid. A payment recorded
  without an amount (the calendar's click-to-mark-paid sends none) defaults
  `paid_amount` to the bill's own amount (SXE-11 — the NULL amount made the
  Sheets Payments Log flag every row −100%). Manual-bill `PATCH` 400s a
  non-numeric/≤0 amount or an out-of-range due_day (it used to store `NaN`).
- **Rent & Utilities ledger** (`/housing` page, `routes/housing.js`): a
  single-payee accounts-payable ledger for the common "we pay a person for rent +
  utilities via bank transfer" case. Models it as **obligations** (rent = fixed;
  a utility starts `pending_amount` with a NULL amount until the mailed bill
  arrives and you enter it) + **payments** (a transfer that settles a BATCH of
  obligations with a memo). The running **balance owed** = sum of `unpaid`
  obligations. Config (payee, monthly rent, due day, utilities + cadence,
  reminder lead days) lives in `user_settings.housing_config` (JSONB); a 6-hour
  scheduled task auto-**generates** each month's rent (`unpaid`) + per-utility
  placeholders (`pending_amount`) over the TRAILING 24 months ending this month
  (never earlier than `start_month` — FAN-3: the cap used to count forward from
  the pinned start_month, so generation silently stopped two years after setup),
  idempotently (a period that already has a rent row under any payee, or a
  same-label utility row, is skipped — FAN-4 — and so is one the user REMOVED:
  deleting an auto-generated row records it in `payee_obligation_skips`, keyed
  (period, category, label); adding the item back via `POST
  /api/housing/obligations` clears it — cycle-7 F33. Awaiting-bill rows have a
  **Remove** button for a bill that won't come), then
  fires two deduped reminders: **payment-due** (balance owed near the rent due
  day — and, inside the lead window for NEXT month's due day, next month's rent
  while its row isn't generated yet: `nextRentInLeadWindow`, tag
  `housing-due-<next month>`, cycle-7 F43) and **missing-utility-amount** (a
  placeholder whose bill should have arrived). Recording a payment ticks the unpaid obligations being settled,
  auto-sums the amount, and **auto-derives the memo** by collapsing consecutive
  months into ranges (`deriveMemo` → "Jan–Mar 2026 Rent, Jan 2026 Electricity");
  **Renames carry history over (FAN-4)**: the ledger is single-payee, so saving
  a changed `payee_name` renames the stored obligations + payments to it (a
  landlord SWITCH is therefore not modeled — the old history follows the new
  name), and each utility row sends `rename_from` (the label it loaded with) so
  a label edit renames its rows and keeps its cadence anchor; a brand-new
  utility is anchored at the current month (it used to backfill a placeholder +
  reminder for every past cycle). Pure `planConfigUpdate` computes the plan;
  `PATCH /api/housing/config` applies it in one transaction. The ledger
  balance and the even-up are scoped to the configured payee.
  obligations link back via `paid_payment_id` (FK-by-convention) and an
  Undo reverts them. Unpaid obligations with a known amount also surface on the
  **bill calendar** (`bill_source='housing'`, display-only — settled via the Rent
  page, not the calendar's `bill_payments` toggle) AND on the public token-gated
  `/calendar.ics` feed (unpaid, known-amount obligations as all-day VEVENTs with
  a stable `housing-<id>@perfin` UID, on the due day clamped to the period's real
  month length — the old 28-day cap moved rent due on the 30th to the 28th and
  flagged it OVERDUE before it was due, cycle-7 F45). The Rent page also shows a **per-utility
  trend** section — an inline-SVG amount sparkline per utility with a
  vs-same-month-last-year (falling back to vs-previous) % delta, computed
  client-side from the ledger's obligation history (no extra endpoint). A
  **dashboard widget** (`#housing-widget-section`, toggle key `housing`, default
  on) shows the current balance owed + unpaid/awaiting counts, auto-hiding when
  the ledger isn't configured. A **landlord-ready export** (`GET
  /api/housing/export?year=&format=csv|pdf|json`) lists a year's payments with
  memos + covered months + total (PDF via pdfkit, mirroring the tax-report
  exporter). Under the unified shell, Per-sistant's **AI daily briefing** also
  weaves in a rent line ("$X owed to [payee] (due in N days | due today | overdue
  by N days)") read READ-ONLY from the wired `perfinPool` (`payee_obligations` +
  `housing_config`), fail-soft (INV-25/35) — via the same day-granular,
  APP_TIMEZONE, payee-scoped helper as the Per-sistant `housing_due`
  notification (`apps/per-sistant/routes/housing-due.js`, PB-2: the old copies
  went silent ON the due day and while rent was overdue). **Bill OCR**: each awaiting-bill row has a "Scan"
  button (upload a photo/PDF) AND a "📷" button (camera-direct via a `capture`
  input — straight to the rear camera on mobile); both feed the same handler →
  `POST /api/housing/scan-bill` runs the bill image/PDF through Claude
  vision (tool_use forcing a `report_bill` tool) and SUGGESTS `{amount, period,
  label}` for the user to confirm before the existing amount-PATCH writes it —
  it never auto-writes, and the image is processed in memory then discarded
  (never written to disk or a DB row). Shares the
  monthly AI cap (`entry_type='scan'`; 501 without `ANTHROPIC_API_KEY`). The
  missing-utility-amount reminder deep-links to `/housing#pending` so entering
  the figure is one tap. **Partner split** (`GET /api/housing/split`,
  `housing_config.split`): an even-up calculator for the case where the partner
  sends the full payee payment and the operator pays the car separately —
  `you send the partner = (rent+utilities − car) / 2`, so each bears half of the
  total (sign flips to "partner sends you" when the car exceeds rent+utilities).
  The car amount auto-pulls from a selected Perfin loan account's
  `monthly_payment` (or a fixed fallback). Surfaced as an "Even up with [partner]"
  card on the Rent page. Tables: `payee_obligations`, `payee_payments`.
- **Merchant categorization rules**: Persistent merchant→category rules applied before
  AI categorization to reduce API costs. CRUD via `/api/categorization-rules`.
  Match types: `contains`, `exact`, `starts_with`. `POST /api/categorize` applies
  rules first, then sends only unmatched transactions to Claude. Rules can be
  created from a manual categorization via `POST /api/categorization-rules/from-transaction`.
  `POST /api/categorization-rules/apply` bulk-applies all active rules.
  The IMPLICIT "remember" paths — the dashboard Review widget
  (`POST /api/categorize/review`), the accuracy review, and from-transaction —
  default to **`exact`** match (DC-13: a `contains` rule from a short merchant
  like "ARCO" also caught "Marco's Pizza"); an explicit `match_type` is still
  honored, and the explicit `POST /api/categorization-rules` keeps its
  `contains` default. Rules apply MOST SPECIFIC FIRST (`RULE_ORDER_SQL` in
  categorize-helpers.js: exact → starts_with → contains, then longer pattern, then
  newer rule) — they used to run by `times_applied`, so an old busy "shell" contains
  rule beat a newer exact "Shell Oil 57444" one (cycle-7 F46); applying a rule no
  longer bumps its `updated_at`. Saving a rule (POST, from-transaction, Review
  "Remember", accuracy review) DEACTIVATES that merchant's active rules for other
  categories (`deactivateSupersededRules`, case-insensitive pattern, any match type),
  so re-pointing a merchant doesn't leave the old rule winning. A blank pattern, or a
  contains / starts_with pattern under 3 characters (`MIN_PATTERN_LENGTH`,
  `rulePatternError`), is a 400 — a 1-character "e" rule swept every merchant
  (F48); the Review path still applies the category and returns `rule_error`
  instead of creating the rule, and a short rule stored earlier is skipped (logged).
  CSV-import, manual-entry and Teller-sync categories are stored via a
  one-element `text[]` parameter, never a concatenated `{…}` literal (DC-14 — a
  comma split the category and a quote/brace 500'd the whole import).
- **Budget rollover**: Budgets can enable `rollover_enabled` to carry unused budget
  to the next month. `budget_type` can be `recurring` (perpetual) or `one_time`
  (applies only to `effective_month`). The Budgets page sets both (cycle-7 F39):
  the Add form has Type (Every month / One month only) + Month + "Carry unused
  budget into next month", each card shows "<month> only" / "Rolls over" badges
  and a "Roll over unused / Stop rollover" button (PATCH). Since roadmap T1.5 the
  page has ‹ month › navigation (This month, a `?month=` deep link) and asks
  `GET /api/budgets?month=` for the viewed month; "One month only" defaults to the
  viewed month, and one-month budgets set for OTHER months are listed as links
  ("Dec 2026 · Gifts", `GET /api/budgets/one-time`) — a later month's one-time
  budget used to be invisible until its month. The page's month is the browser's
  local month. `POST /api/budgets`
  upserts by category and KEEPS any field it isn't sent (rollover_enabled,
  budget_type + effective_month, notes — COALESCE), so re-saving a category from
  the Add form no longer resets its rollover or clears its notes; an unknown
  `budget_type` or malformed `effective_month` is a 400. Monthly snapshots via `POST /api/budgets/snapshot`
  capture spending + rollover amounts. History via `GET /api/budgets/history`.
  `GET /api/budgets` returns `effective_limit` (base + rollover) and accepts
  `?month=YYYY-MM` query parameter. Budget status has ONE definition,
  `getBudgetStatus(pool, month)` in `services/financial-queries.js` (AIN-6/SXE-4/WUI-5):
  spending via `getCategorySpendingForMonth`, `effective_limit = monthly_limit +` the
  PRIOR month's snapshot `rollover_amount` (when `rollover_enabled`), one-time budgets
  only in their `effective_month`. `GET /api/budgets`, `/api/budgets/alerts`, the AI
  insights prompt, the Ask `get_budget_status` tool and the Budgets page all read it
  (the prompt/Ask/page used the bare `monthly_limit`, so a rolled-over budget read as
  overspent and a June one-time budget showed in September); the Sheets Budget Status
  query mirrors it in SQL. The scheduled prior-month snapshot (`runBudgetSnapshot`) is
  RE-TAKEN on days 1–5 of the month (`SNAPSHOT_REFRESH_DAYS`, DO UPDATE) so month-end
  charges that post on the 1st–3rd reach the rollover (FAN-7), then create-if-missing.
  A snapshot is written only for months a budget was in effect — not for a one-time
  budget outside its `effective_month`, nor for a month before the budget was created
  (APP_TIMEZONE; cycle-7 F38 — a budget made on Oct 3 used to get a September
  snapshot that carried its whole limit into October).
  `PATCH /api/budgets/:id` 400s a non-finite/negative limit, an unknown `budget_type`
  or a malformed `effective_month` (FAN-14).

### Dashboard & Views
- **Dashboard**: Monthly spending trend (line chart), category breakdown (doughnut), account balances,
  3D financial wellness pyramid, savings rate widget, cash flow forecast widget, Per-sistant productivity widget.
  **Summary + Needs attention (design D3):** the top of the page answers "am I OK this
  month?" from `GET /api/dashboard/summary` — a Summary card (net worth and its change
  since the month's first snapshot, spent vs the effective budget total with a bar — red
  when over — and the lowest projected cash day in the next 30 days) and a Needs-attention
  list (rent owed, bills due in 7 days, transactions to categorize, Sync Health warnings —
  each a link through `withBase`, or "✓ Nothing needs attention"). Skeletons while it
  loads; a failed load is one line ("The summary couldn't be loaded — the rest of the
  dashboard is below.") and the rest of the page loads as before; a part that failed
  shows its own sentence. Not a Settings widget toggle.
  **Order and density (design D4, decisions 6 / 7 / 15):** top to bottom — the summary,
  the sync strip (and the CSV-reminder / budget-alert banners), Since you last looked,
  Review Uncategorized, Your plan (roadmap T4.1 A2), the two charts, Accounts (the sync buttons and stat cards with
  them), Cash Flow + Upcoming Bills + the 30-day forecast, the spending tables, Settle
  Up / Rent & Utilities / Investments / Savings Rate / YoY, the pyramid, then Ask Perfin /
  AI Insights / AI Memory / Credit Score. Cash Flow leads with the lowest projected day,
  shows the first 4 weeks ("Show all 13 weeks" for the rest) and writes a $0.00 income or
  bills cell as "—"; Savings Rate shows the latest month ("Show all N months"); the trend
  chart is a sentence ("Spending trends appear after 3 months of history — N so far")
  until there are 3 months (0 months keeps "No spending data yet"). The pyramid is still
  on by default but sits below the charts and is collapsible (`perfin_collapse_pyramid`);
  on a phone (≤640px) it starts collapsed until it's opened once (opening stores '0', so
  it stays open), and its mode tabs are one horizontally scrollable row with the active
  tab scrolled into view (within the row, never the page).
  The two charts draw `GET /api/spending-summary` (`monthly_trend` / `by_category`) —
  the same request as the tables beside them (`getSpendingSummary`; the tables
  fetch fresh, the charts reuse the latest) — so transfers, reimbursed rows and
  the shared-card split are handled identically; month labels are built from a
  local date (cycle-7 F91 — they summed raw `/api/transactions` rows and labelled
  each month as the previous one west of UTC). A failed load replaces the
  tables' "Loading..." rows (F108). After Sync Transactions, Run Detection or a
  shared-split change, `refreshSpending()` reloads the tables and REDRAWS both
  charts from the same fresh response (roadmap T1.5 — `replaceChart` destroys the
  previous Chart.js instance; the empty state hides the canvas and shows a
  `.chart-empty` note instead of replacing it), and the Spending by Category month
  selector reads the latest response and rebuilds its months on each load.
- **Grouped accounts grid**: The dashboard accounts list groups under section
  headers — Cash (depository), Credit, Loans, Investments, Other — using the
  `is_investment` flag returned from `GET /api/accounts` plus the raw `type`.
  Teller-linked brokerage / IRA / 401k accounts surface under their own header
  instead of being mixed in with checking/savings. A Plaid brokerage linked via
  the combined flow lands in BOTH `linked_accounts` (often $0 from accountsGet)
  and `investment_accounts` (correct balance from holdings sync), so the grid
  drops any `linked_accounts` row whose `account_id` matches an
  `investment_accounts.plaid_account_id` — only the correct card shows, no $0
  phantom twin (parallels the `la.plaid_item_id IS NULL` dedupe in
  `GET /api/investments`).
- **Loan accounts (auto loans etc.)**: `type='loan'` rows (Plaid-linked via the
  combined flow — credit-union auto loans arrive from accountsGet — or created
  via `POST /api/accounts/manual` with `type:"loan"`, subtype defaults `auto` — the
  Accounts page's manual-account form offers a Loan type, WD-11)
  are first-class DEBT: the dashboard renders the balance as "-$X owed" under a
  Loans group header (an $18k loan never shows as +$18k; the Accounts page's
  manual list shows it as "-$X owed" since cycle-7 F105 — neither is red since
  design D2: a debt isn't "wrong"), the grid net total
  subtracts it, and `getNetWorth` counts it as a liability (F1). Plaid's
  Liabilities product does NOT cover auto loans (any issuer — only
  credit/student/mortgage), so **APR and monthly payment are manual fields on
  the loan card** (→ `PATCH /api/accounts/:id { apr, monthly_payment }`), same
  pattern as the manual Discover credit limit. With both set, the card shows a
  payoff projection — months remaining, payoff date, interest remaining — via
  `services/projections.js computeLoanPayoff` (iterative amortization at
  APR/12, exact partial final month; flags a payment below monthly interest
  instead of showing a bogus horizon; the dashboard inlines a pinned mirror of
  the iteration since the browser can't require the services layer). Loan
  accounts (with payoff figures when known) feed the AI debt-optimizer module
  alongside credit cards, with instructions to treat them as installment (no
  revolving-utilization advice). Loan payments are auto-detected as recurring
  transfers (`bill_payment` type, "loan payment" keyword) for the bill
  calendar; balance refreshes ride the normal accountsGet sync.
- **Investments widget**: Total invested across all sources, per-source
  breakdown (Teller / Plaid / Manual), and per-account cards with inline SVG
  sparklines (computed client-side from `/api/accounts/:id/balance-history`,
  no Chart.js dependency) — from the account's own source (`linked` for a
  Teller-linked account, `investment` otherwise; WD-2). Each card has a "View history →" link to the
  full chart page at `/accounts/:id/history`. Auto-hides when no investment
  accounts exist. Toggleable from Settings (key: `investments`, default on).
  When Plaid holdings exist, a **performance sub-card** renders inside the
  widget showing total return ($ + %), per-asset-class allocation bars
  (security_type → % of portfolio), and top winners/losers by return_pct
  (collapsible; winners are only gains and losers only losses — WD-17). The
  return covers only holdings with a KNOWN cost basis (value of those minus
  their basis); the line says "cost known for N of M holdings" when some are
  missing (`cost_basis_coverage`, BSI-5 — an unknown basis used to count as $0,
  so a transferred-in lot showed as 100% gain). Backed by `GET /api/investments/performance`. Auto-hides
  for users with no Plaid holdings since Teller-linked accounts don't
  expose cost basis. Toggleable (key: `investmentReturns`, default on).
  When the user has set target weights via Settings → Target Allocation,
  per-asset-class rows also carry `target_pct` + `drift_pct` (actual −
  target); under-weight classes the user wants exposure to but doesn't
  hold are surfaced as synthetic zero-holding rows.
  The card also renders a **"Value vs S&P 500" history chart** (3M/6M/12M
  range buttons, dual-line normalized-to-100 inline SVG — solid portfolio
  line, dashed benchmark) backed by `GET /api/investments/performance-history`.
  This sub-section is INDEPENDENT of Plaid holdings — Teller-linked and
  manual investment accounts have snapshot history too, so it lights up the
  card even when the cost-basis "Total return" row stays hidden. The
  benchmark line + "vs market" excess figure drop out gracefully when the
  benchmark source (Stooq, keyless) is unreachable. Portfolio line is
  value-based (contributions count as growth); below it the card shows the
  flow-adjusted figures — **TWR** (cumulative for the window) and **XIRR**
  (annualized) — computed over flow-covered accounts (a Plaid account counts
  only once its flows have completed a sync — `flows_synced_at`, F24; Items
  without the Investments product are skipped quietly), with a "(covers N% of
  portfolio)" label when coverage is partial. An account that first appears
  partway through the window enters as an opening INFLOW on its first date
  (its own flows on/before that date are part of that balance), so linking a
  second account no longer reads as a +100% return (BSI-6). A range with
  fewer than 2 points clears the chart to an empty state instead of leaving
  the previous range on screen (WD-17). A "Log contribution /
  withdrawal" form (collapsed) posts manual flows for Teller-linked/manual
  accounts; Plaid-linked accounts get their flows synced automatically and
  are excluded from the dropdown so manual entry can't double-count.
- **Target Allocation editor** (Settings → Target Allocation): per-
  asset-class target weights as `{security_type: pct}` rows the user
  can add/edit/remove. Sum indicator turns green at ≈100%, red above
  100%, muted otherwise (the API doesn't require sum = 100). Saved to
  `user_settings.target_allocation_pct` via PATCH /api/settings. Drives
  the drift fields on `GET /api/investments/performance` and, since roadmap T4.1
  A7, the "Your plan" rebalancing directions — both through `services/allocation.js`.
  Since roadmap T4.1 A10 the section also has a **Yearly contribution limits** row: one
  labelled box per GET /api/investments account (blank = no limit), saved with "Save
  limits" (PATCH `contribution_limits` through writeOk) — "Your plan" shows the room left.
- **Settle Up widget** (formerly "Shared Card Settlement"): a single net
  "settle up with {partner}" figure for the selected month that COMBINES two
  independent sources — the shared-card settlement AND the Rent & Utilities
  partner even-up — with an expandable "Show breakdown". Net convention:
  positive = partner owes you (you collect), negative = you owe (you send). The
  shared-card leg contributes `Σ partner_share` (you pay the statement, the
  partner reimburses their share); the housing leg contributes the even-up
  `transfer` signed by its `direction` (`you_send_partner` = money out). The
  headline shows the net; the breakdown lists the housing even-up card plus a
  per-shared-account card. For each is_shared account the card shows "You owe $X"
  + "{partner_name} owes $Y" broken down as `(split_pct × shared_total) +
  your_personal_total` per side. Both legs are fetched for the SAME month
  (`?month=`), so the periods align; the housing even-up defaults its partner
  name to `user_settings.partner_name` so the two legs name the same person.
  Month dropdown defaults to the prior month when opened in the first week
  (reconciliation usually happens after the statement closes; FAN-11 — the old
  selection expression picked nothing in days 1–7, so it showed the current
  month). The shared-card leg nets same-month REFUNDS (credits that pass
  `NOT_TRANSFER`, so card payments stay out) against their `personal_for`
  bucket and excludes PENDING charges (FAN-12). When a utility for the month is
  still awaiting its bill, the widget shows a "Waiting on …" note linking to
  `/housing#pending` and **disables "Mark settled"** until it's entered (enter 0
  or Remove the placeholder for a bill that won't come — FAN-9; a removal sticks
  since cycle-7 F33). Its links
  (Rent page, per-card "Review →" → the Activity page filtered by
  `?account_id=<account_key>&month=`) carry the basePath (WUI-3). Auto-hides when
  there are no is_shared accounts AND the housing split isn't configured.
  Backed by `GET /api/shared-settlement` + `GET /api/housing/split`. Toggleable
  from Settings (widget key: `settlement`, default on). Partner display name set
  via Settings → Partner Name (`user_settings.partner_name`); defaults to
  "Partner" until set. (Double-count caveat: the two legs are assumed disjoint —
  the car pays via its own loan account and rent/utilities via the payee
  transfer, neither on a shared card; if a utility ever lands on the shared card
  it would appear in both legs. A **double-count guard** detects this: when both
  legs combine, `GET /api/housing/split` returns `double_count_warning` listing
  any shared-card charge that month whose merchant matches the payee name or a
  utility's **statement merchant names** (`utilities[].merchant_patterns`, set
  per utility on the Rent page, e.g. "PG&E, Pacific Gas"; the label is the
  fallback — FAN-10: a bare label like "Gas" flagged "SHELL GAS" and missed the
  real PG&E charge) — word-boundary `~*` match (INV-10), fail-soft — and the widget shows an
  inline ⚠ note so you can adjust before settling.) A **"Mark settled"** button records that the
  month was squared (the client-computed net + direction → `settlements` table
  via `POST /api/settlement/settle`); once settled the headline dims and shows
  "✓ Settled on <date>" with an Undo (`DELETE /api/settlement/:period`). This is
  display-only bookkeeping — it never alters the shared-card or housing math.
- **Since-you-last-looked widget**: aggregates new transactions, balance
  deltas (baseline = the newest snapshot dated BEFORE the watermark's day, vs
  the latest snapshot, which may be from that same day — DD-5: snapshots are one
  row per account per day, overwritten by later syncs, so the old "≤ watermark
  day vs later day" pair silently dropped a same-day change; trade-off: a change
  made earlier on the watermark's own day can show again; dropped if
  |Δ| < $0.01). Each balance row carries `account_type`, `is_debt` (credit /
  loan) and `favorable` (for debt a DECREASE is good — DD-6), which the widget
  and both digest renderers use for colour, sign and an " owed" suffix
  (negatives print as `-$X`, not `$-X`),
  new subscriptions, and recent notifications since `last_dashboard_view_at`.
  Backed by `GET /api/whats-new`; advances the watermark 4 s after first
  render via `POST /api/whats-new/seen` so a quick nav-away doesn't lose
  the unseen state — to what the GET read (its `seen_token`: the newest
  transaction id and the time, cycle-8 E2d), not to the moment of the POST,
  so a transaction or notification arriving in those 4 seconds shows on the
  next visit; new transactions are counted by id once one is stored. Auto-hides when nothing's new. Toggleable
  (key: `whatsNew`, default on).
- **Review Uncategorized widget** (engagement loop): Surfaces 5-8 transactions
  that would otherwise be sent to Claude on the next AI categorize call.
  Each row has a category dropdown (pre-filled with the deterministic
  Teller-map or Plaid-PFC suggestion when available, `mapCategoryFor`) + "Remember" checkbox (exact-match rule, DC-13) + Apply
  button. Apply sets `user_category` and (when "Remember" is checked)
  inserts a `categorization_rules` row. Auto-hides when the queue is empty.
  Toggleable (key: `reviewQueue`). Since design pass D1 a row WITHOUT a
  suggestion starts on a disabled "Choose a category" option with Apply
  disabled until one is picked, and "Remember" starts ticked only for a row
  WITH a suggestion (one Apply used to file a pharmacy under the first
  category, "Food & Drink", as a permanent rule); the date is a calendar day
  (`fmtDate`), not the raw ISO timestamp.
- **Per-account history chart page** (`/accounts/:id/history`): Chart.js line
  chart with range selector (3 / 6 / 12 / 24 / 60 months) + 5 summary cards
  (current, range start, change $, change %, snapshot count). Reads from
  `account_balance_snapshots` via `GET /api/accounts/:id/balance-history`.
  Empty state when fewer than 2 snapshots exist (history accumulates daily
  on every balance sync) — every card resets to "—" for that range. Axis labels
  are the day (`snapshot_date` arrives as an ISO timestamp). For a credit card or
  loan the cards read "Owed now / Owed at range start / Change in debt" and a
  RISING balance is red (WD-15 — it showed rising debt as a green "+").
- **AI audit-accuracy card**: Settings → AI shows the percentage of insight
  runs (last 90 days) with zero critical findings, color-coded green/yellow/red,
  with severity counts. Backed by `/api/insights/status.audit_accuracy`.
- **Audit confidence badge** (dashboard): the AI Insights widget header shows a
  per-insight badge for the latest insight's own post-generation audit result —
  green "✓ Verified" (audited, no critical/warning findings), yellow "N
  caution(s)" (warnings), red "⚠ N issue(s) flagged" (critical), or muted "audit
  incomplete" (a tier threw). `GET /api/insights` now returns
  `audit_critical_count` / `audit_warning_count` per row (subqueries over
  `ai_audit_log`) alongside the existing `audited_at` / `audit_incomplete`. Hidden
  until the insight has been audited. Per-insight parity with the Settings
  90-day audit-accuracy card.
- **Insight feedback loop**: dashboard's AI Insights widget grew per-insight
  thumbs-up / thumbs-down / mixed buttons plus an optional correction
  textarea. The last 5 rated insights are pulled into the next
  `generateInsights()` call as a `=== USER FEEDBACK ON RECENT INSIGHTS ===`
  section so Claude can adjust tone or double-check claims the user
  flagged. The feedback itself is NOT stored in `insights_running_summary_json`
  — Claude sees the raw user signals each run and decides whether to act
  on them; the prompt does let it OMIT a pending_action/alert the feedback
  shows was wrong (the emitted summary replaces the prior one wholesale, so
  omission is the retraction path — AIN-16). Endpoints: `PATCH /api/insights/:id/feedback` (set
  positive/negative/mixed + optional text), `GET /api/insights/feedback-summary`
  (counts over a configurable day window, default 90).
- **AI Memory widget**: Renders the structured running summary's actual
  contents (not just counts) on the dashboard — four cards for Trends (with
  up/down/stable arrows + magnitude + since_when), Pending Actions
  (urgency-colored), Alerts (severity-colored), and Completed Goals. Backed
  by `/api/insights/status.running_summary`. Auto-hides when the summary is
  empty. Toggleable from Settings (`aiMemory` widget key, default on).
- **Quick Add Bill modal** (Upcoming Bills widget): "+ Add Bill" button on
  the dashboard's Upcoming Bills widget header opens an inline modal with
  five fields (name, amount, due_day, cadence, category) and POSTs to
  `/api/manual-bills`. Mobile-first: 44px tap targets, full-width inputs,
  numeric `inputmode` hints, autofocus on first field, click-outside + Esc
  to dismiss. Defaults to `category=utility` since utilities are the most
  common manual entry. Triggers a page reload on save so the new bill
  surfaces in the widget immediately; the next Sheets sync picks it up via
  the existing one-way DB-as-source-of-truth flow. Distinct from the
  Calendar page's existing Add Bill modal — both write to the same
  `manual_bills` table.
- **3D Financial Pyramid**: Interactive spinning pyramid with 4 frustum layers, neon wireframe edges,
  holographic effects. Layers computed by JS (`buildPyramidGeometry()`) with proper taper geometry.
  Configurable data sources: wellness, debt payoff, goal progress, etc. Mobile-optimized (reduced
  filters/shadows on small screens, `prefers-reduced-motion` support). Mode data (Batch 13):
  Wellness's Subs tier reads `/api/subscriptions`' `{ subscriptions }` and `cancelled_at`;
  Spending Health buckets `/api/spending-summary`'s `by_category` (WD-4 — both read shapes
  the API never returned, so Subs was always 0 and Spending always 75); Net Worth shows
  the latest `net_worth_snapshots` row (getNetWorth — loans as debt, investments included,
  WD-5) and says it "appears after the next balance sync" until one exists; Debt Payoff
  counts credit cards AND loans, and the stored `debt_baseline_amount` acts as a high-water
  mark — when current debt is above it, it is raised to the current debt.
- **Transaction search**: Full-text search with filters — category, account, amount range, date range
  (GET /api/transactions/search). The Activity page has an Account filter and
  pre-fills its filters from the query string (`q`, `category`, `account_id`,
  `month=YYYY-MM` → that month's date range, `start_date`, `end_date`,
  `min_amount`, `max_amount`) so deep links like the Settle Up "Review →" open
  already filtered (WUI-3).
- **Bill calendar**: Monthly calendar view of upcoming charges — detected subscriptions
  projected from cadences, user-created manual bills, and detected income. Click events
  to toggle paid/unpaid status — payable events are `<button>`s with `aria-pressed`, so
  this works by keyboard and screen reader, and "+N more" expands the day (IF-2). "Add
  Bill" modal for creating manual expected charges.
  Subscriptions step by CALENDAR MONTH from their last real charge (DC-9 — a fixed
  30-day step drifted ~5 days/yr and could place a Sep-1 bill on both Oct 1 and
  Oct 31); manual bills use the same creation-anchored, month-length-clamped rule as
  the ICS feed (`manualBillOccurrences`, DC-15). **Income** (DC-10): the last 4
  months of income deposits (`INCOME_PREDICATE`, source =
  `COALESCE(user_merchant_name, merchant_name, name)`) are clustered per source by
  amount (±10%, so cents-varying paychecks stay one stream), each stream's cadence is
  classified from its gaps — weekly (median ≤10d), biweekly, semimonthly (gaps not a
  steady 13–15 AND days-of-month form two tight clusters — circularly, so a 1st that
  posts on the 29th–31st still counts, cycle-7 F52), monthly (≤45d; longer is
  not projected) — and projected into the month at the median amount; a stream
  whose last deposit is >35 days old (>50 for monthly) is dropped. (It used to show
  ONE averaged-day event per month per exact amount, so biweekly pay read ~50% low.)
  The query + clustering is `getLiveIncomeStreams(pool)` in
  `services/financial-queries.js`, shared with the cash-flow forecast (F34).
- **Cash flow forecast**: Rolling 30–180 day projection with day-of-week spending averages,
  income, bill scheduling. Income = the bill calendar's live streams
  (`getLiveIncomeStreams` → `services/cadence.js`, cycle-7 F34): per-source
  clusters with a weekly / biweekly / semimonthly / monthly cadence, stale streams
  dropped, renames honored, projected with `incomeEventsBetween` (it used an
  older inline classifier with no semimonthly cadence and no staleness check);
  `recurring_income[]` carries `{source, amount, cadence, cadence_days, last_date,
  days_of_month?}`. Stream amounts are full deposits (cash into the account).
  Starting balance = **depository, non-investment** cash only (FAN-5 — loans and
  Teller brokerage/IRA balances used to count as spendable). Nothing is counted
  twice (DD-4): active detected-subscription merchants are excluded from the
  60-day daily/DOW spending averages (they're projected as scheduled bills), and
  card **autopays** are NOT billed — the card purchases they pay off are already in
  the average. Since cycle-8 F8 that means a `bill_payment` whose latest debit was paid
  into a linked credit card, or whose name says card payment or names a card issuer — a
  utility or insurance AUTOPAY from checking (kept out of the average by NOT_TRANSFER and
  out of subscription detection) is billed; it used to be projected nowhere. Loan/mortgage
  payments are always billed. A transfer between two of your own spendable accounts
  (its latest debit has a same-amount credit within 5 days on another depository,
  non-investment account — checking → a linked savings account) isn't billed either
  (F7): the starting balance already holds both accounts. A transfer to an account you
  haven't linked, to a brokerage or to someone else still is. Bill dates step by
  calendar month from each bill's last real charge (`seriesOccurrences`, DC-9).
  The projection lives in `services/cash-flow.js` (roadmap T2.2 L1 — shared with the
  cash alerts), starts the day after the APP_TIMEZONE date (it used the UTC date, so
  west of UTC an evening forecast started a day late) and reports the lowest projected
  day (`lowest_balance` / `lowest_balance_date`), which the weekly table hides; the
  dashboard Cash Flow line shows "Lowest projected: $X on <date>" (red below $0).
  **Corrections (cycle-8 E1a / E1b, G1):** the card-autopay and internal-move rules are
  guesses, so each recurring transfer has a forecast setting — Automatic (the rules),
  Always a bill, Between my accounts or Leave out — and each subscription can be left
  out of the forecast (still a subscription everywhere else). Forecast-only: the cash
  plan's savings transfers, goals, insights, Sheets and the detectors don't read them,
  and re-detection keeps them. The dashboard's Cash Flow section has a collapsed
  "What's in this forecast" list: each projected bill (how many times in the window,
  the total, the next date) and each item left out with the reason in words, with a
  labelled setting per item; a change saves (PATCH …/forecast) and reloads the section
  and the summary card, and the next hourly cash-alert check re-evaluates. The low-cash
  alert, the dashboard summary's lowest day and the cash plan all follow it.
- **Low cash alert** (roadmap T2.2 L2, opt-in — Settings → Cash Alerts): a push
  ("Low cash ahead", tag `cash-low`, opens the dashboard) when the forecast's
  spendable cash is projected to fall below a floor (`cash_alert_threshold`, default
  $500) within a look-ahead (`cash_alert_horizon_days`, 7–60, default 14), plus the
  opt-in critical-alert email. Checked hourly when new bank data arrived, else once a
  local day; never on balances more than 36 hours old. Once per breach, again when it
  moves 3+ days earlier or after 72 hours; recovery is silent, and a dip that returns
  within 72 h of the last alert is held too unless it is 3+ days earlier (cycle-8 F11).
  Changing a Cash Alerts setting or an account floor makes the next hourly check run
  (F12) (`services/cash-alerts.js`).
  **Account floors** (T2.2 L4, Settings → Cash Alerts → Account Floors, needs the Low
  Cash Alert switch): a floor per checking / savings account; while its current balance
  (available, else current — not a projection) is below it, "Low balance: <name>" is
  pushed once a day per account (no email; skipped on a balance older than 36 hours).
  The section also shows the last evaluation ("Last checked …: no dip below your floor
  in the look-ahead · 1 account(s) below their floor", or why it was skipped).
- **Payday alerts** (roadmap T2.2 L3, opt-in — Settings → Cash Alerts → Payday Alerts):
  "Paycheck landed" right after the sync that brings in a deposit matching a pay
  pattern seen at least twice (a live income stream, ±10%) — with webhooks on, within
  minutes — and "Payday missed?" (+ the opt-in critical-alert email) when an expected
  payday is 3 days past with no deposit from that source, only once that account's
  bank connection has completed a clean sync since (CSV / manual accounts never alert).
  Switching them on doesn't announce deposits from before (`services/payday-alerts.js`).
  Each check also re-reads rows created within 24 hours of the previous check and skips a
  paycheck already announced, so one a long CSV import committed after a check is still
  announced, once (cycle-8 F51; an id watermark since E2c).
- **Plan-change alert** (roadmap T4.1 A4, opt-in — Settings → Cash Alerts → Plan Changes):
  "Your plan changed" when the dashboard's "Your plan" moves to a new step, moves on to
  another debt, or its amount per paycheck moves by 20% and at least $50 — e.g. "Visa is
  paid off — your plan now puts $450 per paycheck toward the emergency fund." Checked once
  a local day; the first check (and the first after switching it back on) only records the
  plan; push only, never email (`services/advice-alerts.js`). Since A6 it also names a raise
  or bonus the plan hasn't announced yet, once ("New money for your plan" — the bonus with its
  split in the plan's order).
- **Per-sistant tasks** (roadmap T2.4 X2, opt-in — Settings → Alerts & Notifications →
  Per-sistant Tasks; unified shell only — standalone the section says so and hides its
  controls): Perfin opens a Per-sistant To-Do for rent & utilities due, a utility amount to
  enter, a subscription still charging after you cancelled, a tax form that hasn't arrived
  by its usual date (roadmap T3.3 K2) and (off by default — an autopaid bill nobody marks
  paid would stay open) a manual bill due within the lead days, and closes it once the
  payment / amount / bill payment is recorded in Perfin (the form marked received or
  dismissed). Your edits
  to a task win, and a task you complete or reopen by hand is left alone. A task you
  delete for good stays deleted (its key is kept — cycle-8 F16); a manual bill's task stays
  open until the bill is marked paid, however old (F17); a task the sync closes is not your
  completion — no todo_completed automation / webhook / Slack post, and Per-sistant's
  analytics, weekly review, Ask and stats leave it out (F18); webhooks and Slack get only a
  kind label for a linked task, never its amounts or payee (F19); while the owed month's rent task is open,
  Per-sistant's housing_due notification and briefing rent line stay quiet (F23; that month's
  task only since cycle-8 E3e), while any task is open Perfin's own push for the same item is
  not sent (cycle-8 E3d), and Per-sistant raises no browser notification for an item Perfin
  pushed in the last 12 hours (E3e). Checked
  hourly but run once a local day unless something changed (F21), right after a housing,
  housing-config, bill-payment, manual-bill or tax-document write, and on "Run now" (`POST
  /api/linked-tasks/run`); the section shows "Last run …: N outstanding, N closed" with any
  source error (`services/linked-tasks.js` here, `apps/per-sistant/services/linked-tasks.js`
  there).
- **Savings rate**: Income vs spending analysis with configurable lookback (default 3 months)
- **Year-over-year comparisons**: Month-by-month spending comparison vs prior year.
  For the CURRENT (in-progress) month every year is capped at today's day-of-month,
  so month-to-date is compared with the same days of prior years (response
  `through_day`; the widget labels "days 1–N of each"); only CONSECUTIVE years are
  compared — a missing year is no longer bridged as "year-over-year" (DD-11).
- **Budget alerts** (`GET /api/budgets/alerts`): Spending velocity/pacing warnings with severity levels — `critical` ≥100% (over budget), `warning` ≥80% (approaching limit), `info` when pace > 1.2× and ≥50% (spending faster than the month's progress). Alerts compare spending against the **effective limit** (base `monthly_limit` + the PRIOR month's `rollover_amount` from `budget_snapshots`) and skip one-time budgets outside their `effective_month` — via the same `getBudgetStatus` as `GET /api/budgets`. Day-of-month / days-in-month come from the APP_TIMEZONE date (FAN-13). The 3-hour scheduled push-notification path uses the same effective-limit logic and 80% / 100% thresholds; the in-app `info`/pace heuristic is intentionally not pushed (too noisy as a notification).

### AI & Intelligence
- **ML categorization**: Claude-powered smart transaction categorization via tool_use structured
  output (POST /api/categorize). User-defined categorization rules are applied first
  (free, instant) before sending remaining uncategorized transactions to Claude (paid).
  Response includes `categorized_by_rules` and `categorized_by_ai` counts.
  Respects user's model preference from settings.
  Model ID mapping (`data/reference-data.js` MODEL_MAP): haiku → `claude-haiku-5-5`,
  sonnet → `claude-sonnet-5-5`, opus → `claude-opus-5-5` (the current model of
  each line). Called through `services/claude.js` `createToolCall` (strict tool,
  `tool_choice` auto — the 5.5 Opus/Sonnet reject a forced one) at low effort.
  Shares the `INSIGHTS_MONTHLY_BUDGET_CENTS` cap with `/api/insights` — returns 429
  when the monthly AI budget is exhausted (rules still apply for free).
- **AI budget suggestions**: Claude suggests budgets based on the last 3 COMPLETE months of spending via tool_use (the partial current month is excluded — FAN-8). The tool's `category` is an enum of the categories sent and replies are filtered to them, once each; Accept keeps one row per (trimmed) category, the last entry winning — a repeated category used to 500 the whole accept ("ON CONFLICT DO UPDATE cannot affect row a second time", cycle-7 F70). Shares the monthly AI cap: 429 past it, and an `entry_type='suggest'` usage row is written right after the call, before tool validation (AIN-10 — it used to be uncapped and uncharged).
- **AI Insights** (13 toggleable modules, auto-triggered based on cadence setting):
  - Utility rate comparison (vs state/national averages, requires ZIP)
  - Spending benchmarks (vs BLS Consumer Expenditure Survey)
  - Savings & wealth-building suggestions
  - Subscription audit (overlaps, alternatives)
  - Anomaly detection (for AI analysis a candidate must be both 2x+ above the
    merchant average AND above mean + 2·stddev — the stddev gate suppresses
    false positives on naturally high-variance merchants; 3x+ threshold for
    real-time push alerts during sync. The AI-insights baseline is a per-
    candidate `CROSS JOIN LATERAL` that EXCLUDES the candidate's own row
    (`t2.transaction_id <> t.transaction_id`, ≥3 other rows, 12 months back to
    7 days ago — AIN-5: candidates reach back 2 months, so a charge 8–60 days
    old used to sit inside its own AVG/STDDEV and, by Samuelson's inequality,
    a merchant with ≤5 rows could never pass the 2σ gate). The post-sync push
    baseline still excludes the trailing 7 days, and its candidate window
    matches that 7-day exclusion (F7) so a charge dated up to a week ago but
    only just synced — caught via `created_at > watermark` — is still eligible. Deliberately evaluates the PARENT transaction amount, not
    `transaction_splits` shares (AI-13): anomaly asks "was this CHARGE unusually
    large?", and the merchant billed the full amount regardless of how the user
    later split it across categories.
    Merchant grouping uses `LOWER(COALESCE(user_merchant_name, merchant_name, name))`
    so user-merged merchant variants share a single baseline. Both the AI
    insights candidate query and the real-time post-sync push baseline apply
    `NOT_TRANSFER` (the same negative filter the rest of the spending pipeline
    uses) so transfer/payment merchants don't skew their own baselines. The
    AI insights candidate query also joins `linked_accounts` to apply
    `spending_split_pct` on both the baseline AVG and the candidate amount,
    and excludes reimbursed candidates — so the dollar figures shown to Claude
    match the dashboard.)
  - Seasonal forecasting (24-month pattern analysis — COMPLETE months only;
    the month to date is excluded, AIN-4)
  - Your plan for extra money (`cash_plan`, roadmap T4.1 A3) — `services/advice.js`'s plan
    (`advice.getAdvicePlan`, the dashboard card's figures) goes in the prompt as a CASH PLAN
    block (`cashPlanPromptBlock`: headline, why, steps, each debt's APR / balance / payment per
    paycheck and per month / payoff month / interest saved, surplus, snowball line, tips, notes,
    disclaimer); the model is told to state one bullet with those figures exactly, call it
    educational and name no security or fund. A plan that can't be worked out says so; a read
    that throws goes in `modules_failed`. After a summary that is being written, its current step
    is kept as ONE pending action "Plan (<step>): <headline>" (`seedPlanActions` — replaces an
    earlier plan entry and the model's own copy, `first_recommended` carried while the step is
    the same, urgency by step, the 10-item cap kept). The audit checks its figures (below).
    Since A5 the block also carries the emergency-fund tracker ("Emergency fund: N of 3 months
    of spending covered ($have of $target, P%), reaches it around YYYY-MM at this pace") and
    "Goals behind their target dates" (behind / overdue / due goals' catch-up lines); since A6
    "Raises:", "Bonuses / one-off deposits:" (each with its split) and "Spending growing faster
    than income:" lines; since A7 "Idle cash:" and "Rebalancing (directions between asset
    classes — never name a security or fund):" lines; since A8 "Loan extra payments:" lines (the
    statement-date utilization tip rides the "Utilization tips:" lines); since A9 "Sinking funds
    (quarterly / yearly bills):" and "Subscriptions to review:" lines; since A10 "Contribution room
    (yearly limits the user entered):" lines
  - Debt payoff optimizer (avalanche vs snowball, credit score projections — while `cash_plan`
    is on, the payoff order, amounts and interest saved come from the plan instead).
    A card's limit is `credit_limit` (Plaid or manual), else owed + available
    when an available figure exists, else UNKNOWN — the prompt then says
    "Limit unknown, Utilization unknown" (never 100%), and the total limit /
    overall utilization cover only cards with a known limit (AIN-7)
  - Bill negotiation tips
  - Income & savings rate analysis
  - Tax deduction flags — word-boundary keyword matching with a multi-word-phrase
    preference: bare ambiguous keywords (`office`, `interest`, `mortgage`, `vision`,
    `business`, `education`, `student`, `supplies`) were dropped in favor of
    specific phrases (`mortgage interest`, `student loan interest`, `home office`,
    `office supplies`, `office depot`, `business expense`). This eliminates
    false positives where credit-card finance charges flagged as `interest`
    deductions and Box-Office tickets flagged as `office` deductions.
    Matches/groups on `COALESCE(user_merchant_name, merchant_name, name)` so a
    user-renamed merchant is flagged under the name the dashboard shows (AI-7).
    Uses the shared `getTaxDeductionTransactions` (same list + query as the
    export and Sheets — SXE-7); the PROMPT gets the top 15 merchants, while
    EVERY matching merchant is UPSERTed into `tax_deductions` (the annotation
    layer) and this year's `ai_detected` rows that are unconfirmed, have no
    notes and no longer match (renamed merchant's old name, now reimbursed, an
    old keyword list) are PRUNED (AIN-12). This persistence is INTENTIONALLY
    independent of AI success (AI-8): the rows are a deterministic keyword-matched
    view of real YTD transactions (not model output), so they accumulate even on
    a run that later hits the token cap or errors.
  - Goal tracking (with real-world economic context) — a funding-linked goal is
    shown at balance − baseline via the shared `deriveGoalProgress` (goals.js;
    cycle-7 F62 — the prompt read the stale stored `current_amount`). Dates in the
    prompt (goal target, card due date, anomaly date, credit-score date) are
    written `YYYY-MM-DD` via `isoDate` (F71 — not a JS Date string)
  - Recurring transfers (Zelle, bill payments, savings, investment patterns) —
    honors its Settings toggle (AIN-11; it used to run regardless)
- **Partial current month (AIN-4)**: the prompt labels the month to date
  "YYYY-MM (partial, through day DD)" in the Monthly Spending and income/savings
  blocks, and month-over-month trend deltas use COMPLETE months only (a run on
  the 5th used to report a "-78%" drop).
- **Model calls (5.5 models)**: generate + rebuild run through `createToolCall`
  at "analyze" (medium) effort with thinking headroom in `max_tokens`
  (generate `min(16000, 6000 + 400 × modules)`, rebuild 8000); Ask runs at
  medium effort with `max_tokens` 4096; categorize / budget suggestions / bill
  OCR at low effort. A `stop_reason: "refusal"` reply has no tool call / text and
  takes each caller's existing no-result path (charged, nothing written).
- **AI context enrichment**: Insights prompt includes month-over-month trend deltas,
  current budget status (spent vs limits), and recurring transfer data.
  Module tracking: all enabled modules are registered in `activeModules` when their
  system prompt instructions are added (not conditionally when data queries succeed),
  so `max_tokens` is correctly allocated for every enabled module. However, if a
  dynamic module's data query throws, that module is recorded in a `failedModules`
  set and dropped from the response's `modules_used`, surfacing instead in a new
  `modules_failed` array — so a swallowed query error no longer reports a module as
  analyzed when Claude actually received no data for it.
- **Auto-trigger**: Insights auto-generate based on `insights_cadence_days` setting (checked every 6 hours).
  The monthly AI cap is checked BEFORE the pre-insights sync chain, every attempt
  is stamped in `insights_last_attempt_at`, and a failed attempt is retried at most
  once per 24 h (`INSIGHTS_RETRY_MS`) — cycle-7 F63: a cap-exhausted or failing run
  used to re-run the whole Teller+Plaid chain every 6 hours. A failed settings read
  fails the run before the model call (F73) instead of running on "sonnet" with an
  empty memory and overwriting the stored summary. A manual `POST /api/insights`
  is never held back by the back-off.
- **Cost tracking**: Granular token-level pricing — `input_tokens` from Anthropic's API (already excludes cache tokens) is multiplied by the input rate; `cache_read_input_tokens` and `cache_creation_input_tokens` are billed separately at their own rates (thinking tokens arrive inside `output_tokens`). Rates are keyed by MODEL ID (`MODEL_RATES_BY_ID` / `modelRates` in `data/reference-data.js`, AIN-9): Haiku 5.5 $0.10/$0.50 per MTok (cache read $0.01, write $0.125; a prompt over 100K tokens uses the $0.50/$2.50 card), Sonnet 5.5 $2/$10 (read $0.20), Opus 5.5 $4/$20 (read $0.20); the previous models (Haiku 4.5 $1/$5, Sonnet 4.6 $3/$15, Opus 4.6 $5/$25, older IDs) keep their own rates because usage rows are re-priced at READ time from their stored tokens + `model_used`. This restores accurate `INSIGHTS_MONTHLY_BUDGET_CENTS` enforcement when prompt caching is active. Under the shell, Settings → AI Insights → Monthly Budget Cap also shows Per-sistant's month spend and its own, separate cap (one read-only line — roadmap T2.3 C4; the two apps never share a budget). The monthly budget is shared between `/api/insights`, `/api/categorize`, `/api/insights/rebuild`, `/api/ask`, `/api/housing/scan-bill` and `/api/budgets/suggest` — all check the same cap before calling Claude, via ONE spend reader (`monthAiSpendCents()` in routes/insights.js, AIN-10 — it used to be copy-pasted in six places; it counts from the APP_TIMEZONE month start, cycle-7 F66 — it was UTC's), AND each writes a `financial_insights` usage row after its AI call (`entry_type='categorize'` / `'rebuild'` / `'ask'` / `'scan'` for the housing bill-OCR / `'suggest'` / `'insight_empty'` for an insight run that produced no text /
`'insight_unsaved'` for an insight whose own row failed to write — cycle-7 F63) so its spend counts toward the cap (not just the read side). `/api/insights/rebuild` records that usage row IMMEDIATELY after the Claude call — before its tool-block validation early-returns and the summary UPDATE — so a rebuild that truncated or failed validation (which 500s) still charges the cap for the spend it already incurred (AIA2); `/api/categorize` likewise stops its AI loop if a usage-row write fails rather than spending uncapped (M2). Display queries that surface "AI Insights" filter `entry_type='insight'` to keep categorize/rebuild tracking rows out of the user-facing feed. The cap is checked-then-charged; for the insight path the insight row IS the usage row (if that INSERT fails, an `'insight_unsaved'` usage row still charges the call and the run returns 500 — F63), and the only gap (two concurrent generate calls both passing the pre-check) is accepted for a single-operator app rather than guarded with a provisional reservation (AI-11). `/api/insights/status` rounds the accumulated cost once and derives `budget_remaining_cents` from it so estimated + remaining == budget (AI-10).
- **Insight inputs are split-adjusted**: AI insights see the same `spending_split_pct`-adjusted monthly spend totals and the same keyword-filtered income that the dashboard and `/api/savings-rate` show, via `services/financial-queries.js`.
- **Structured running summary**: AI long-term memory is structured JSON, not plain text. `POST /api/insights` uses Anthropic tool_use (the `generate_financial_insight` tool — `strict: true` with `additionalProperties: false` on every object, requested with `tool_choice` auto via `createToolCall`) to return BOTH the user-facing `insights_text` AND a typed `summary` object with four arrays: `trends`, `completed_goals`, `pending_actions`, `alerts`. The summary is saved to `user_settings.insights_running_summary_json` (JSONB); the legacy `insights_running_summary` TEXT column gets a human-readable rendering for backward-compat callers. `sanitizeStructuredSummary` (exported) enforces shape/length bounds (max items per array, string lengths, enum values) AND returns null unless all four keys are ARRAYS in the raw input, so a pathological, empty (`summary: {}`) or partial tool response can't wipe long-term memory (AIN-8). The response includes `summary_status` — `"updated"` (normal), `"preserved_due_to_truncation"` (`stop_reason` was `max_tokens` — with or without a tool block, since a cut-off tool input may be partially parsed), `"preserved_no_tool_block"` (no tool call even after the re-ask, or a refusal), or `"preserved_validation_failed"` (sanitizer rejected the shape) — so callers can surface when long-term memory didn't advance. A run with NO insight text is charged as an `'insight_empty'` usage row but not stored as an insight, audited or emailed; it returns 502. `/api/insights/rebuild` returns 500 without writing on a `max_tokens` stop (after charging the cap). `GET /api/insights/status` returns the full `running_summary` object plus a `running_summary_counts` block (`{trends, completed_goals, pending_actions, alerts}`) so dashboards can show "tracking 3 trends · 2 goals · 5 actions · 1 alert" without a second fetch.
- **AI insight auditing**: Post-generation validation via `services/ai-audit.js`. Four tiers:
  (1) arithmetic — dollar amounts/percentages compared to actual DB data; a claim is matched to a
  category name by **word boundary** (not substring, so `car` ≠ `Carmax`) and emits at most ONE
  finding per dollar claim (the single longest/most-specific match) — critical >20% off, warning >5%
  (AI-2/AI-3). The per-category + subscription-total dollar actuals are THIS-MONTH figures
  (`getCategorySpendingThisMonth` / monthly sub total), so a claim whose context signals a
  non-current-month window (annual / multi-month / YTD / projected / running-average, matched by
  `CROSS_PERIOD_RE`) is SKIPPED rather than mis-compared — otherwise an annualized figure (×12) read
  near a category name false-flagged CRITICAL, spamming the audit notification and deflating the
  `audit_accuracy` % (AIA1). `CROSS_PERIOD_RE` also matches explicit other-month / trailing / YoY /
  estimate phrasings (`last|previous|prior month`, `N months ago`, `year-over-year`, `trailing`,
  `estimate(d)` — F6). It treats "average" as cross-period only when PERIOD-qualified (running /
  rolling / monthly / N-month average, or the verb "averaging") — a bare benchmark comparator like
  "above the national average" no longer suppresses the check, and an explicit "this month"/
  "month-to-date" qualifier (`THIS_MONTH_RE`) OVERRIDES any cross-period match, so a genuine
  this-month hallucination adjacent to the word "average" is still caught instead of silently
  inflating `audit_accuracy` in the false-negative direction (F7). It deliberately does NOT skip
  bare/unqualified or `per month` claims, which AIA1 still checks against this-month. this-month +
  unqualified claims (which refer to the data the model was given) are still checked.
  **Attribution (AIN-1)**: each dollar figure is judged on its OWN clause (`claimSegments` — from the
  previous figure / sentence break to the figure, plus the trailing span to the next clause break) and
  compared only with the category it is the NEAREST amount of (`attributeCategory`: the name ≤30 chars
  before it with no open parenthetical, or "$X on|for|in <category>"). A figure in a budget / limit /
  target / goal / average / benchmark / national / typical / save / cut / reduce / cancel / switch /
  "could|would|instead" clause (`SKIP_WINDOW_RE`), or followed by a comparator ("$120 over …",
  `DELTA_AFTER_RE`), is skipped — per-item prices ("cancel Hulu ($17.99)"), benchmark figures and
  budget limits used to be compared with the category / subscription TOTAL and flagged CRITICAL on
  correct insights. The subscription TOTAL is checked only when the clause names subscriptions AND
  phrases the figure as a total (`SUB_TOTAL_RE`: total / all / combined / "N subscriptions").
  **Period window (cycle-7 F68)**: `CROSS_PERIOD_RE` / `THIS_MONTH_RE` read the claim's own
  sentence up to the figure plus the rest of its clause (`claimPeriodWindow`) — the old ±80/40
  characters reached into neighbouring sentences ("Your annual subscriptions cost $1,200. Dining
  hit $450." skipped the $450) — and `$1.2k` / `$1.5M` are scaled (they read as $1).
  **Named months (F61)**: a figure about a month that isn't this one — named before it in its
  sentence ("In September, Dining hit $450", "2026-09") or attached right after it ("$210 in
  August") — is cross-period and skipped (`claimNamesOtherMonth`; case-sensitive names, so the
  verb "may" doesn't count); a month named later in the clause belongs to another figure.
  Trade-off: "September was quiet while Dining hit $450" without "this month" is skipped.
  **Other years, weeks and quarters (cycle-8 F42)**: `CROSS_PERIOD_RE` also covers last / previous /
  prior year, "years ago", "same month last year", "last <season>", last / past / previous / this
  week, per week, "/week", weekly, "a week", last / previous / this quarter, per quarter and
  quarterly ("a quarter of your spending" is not a period); and this month's NAME is another
  month when "last" / "previous" / "prior" precedes it or another year follows it ("Last
  November Shopping hit $800", "$800 in November 2025"), as is a bare other year ("In 2025, …"
  — never an amount like "$2025"). They were compared with this month's actuals — a false
  CRITICAL on every seasonal comparison. Trade-off: a sentence that says "weekly" or names another
  year is skipped unless it also says "this month".
  **Savings rate (AIN-3)**: checked against COMPLETE months — the closer of the last complete month
  and the complete-month average; only an explicit "this month" claim uses the month to date.
  (2) entity existence — merchant/goal/subscription names verified against DB via
  whole-word match with a ≥4-char min, so a tiny known entity (a "Car" goal) can't wildcard-match
  every claimed name and let hallucinations pass (AI-4). Category names are part of the known set;
  months, weekdays and generic finance nouns (`isGenericName` — "Spending trend", "Emergency fund",
  "March was") are not entity claims, and a "- **Heading**:" bullet is captured only when a `$`
  amount follows (AIN-2). A name after at/from/to/for/cancel is a run of Capitalized words (or
  "&") and "A and|or|vs B" is split into two claims, so "Fakemart and Amazon" no longer passes
  because it contains a known name (cycle-7 F67); (3) trend direction — only **total/overall**
  spending claims are checked, against the last two COMPLETE months (AIN-3 — the month to date
  always read "down"); category-specific claims are skipped rather
  than mis-flagged against the total baseline (AI-1); (4) consistency — detects self-contradictions
  within the same report. Results stored in `ai_audit_log` table. Critical findings trigger an in-app
  notification, deduped to at most one per 24h via `sentRecently('audit-alert', 24)` (F5) so a
  steady-state critical finding doesn't re-push on every 6-hour auto-insight tick (parity with the
  budget-alert dedup; fail-open if the dedup check errors).
  **Cash plan figures (roadmap T4.1 A3)**: given the plan (`auditInsight(text, id, { plan })`),
  tier 1 first judges plan claims — a figure stated "per paycheck" (a per-paycheck plan) must be
  one of the plan's per-paycheck amounts (that debt's when the clause names one of its debts), and
  "a month" / "/mo" / "monthly" next to a plan debt one of that debt's monthly amounts; the nearest
  within 5% passes, >20% off is critical, else a warning (module `cash_plan`); a hypothetical
  clause (cancel / switch / instead / could / would / if you / by cutting) isn't a plan claim, and
  a plan claim skips the this-month spending checks. Since A5 a goal's catch-up amount
  (`add_per_period`) is one of the plan's per-paycheck figures, and since A6 a raise's share and
  per-deposit amount and a creeping category's freed amount are too; since A8 a loan's extra $100 a
  month and its payment with it are that loan's monthly figures. Trade-off: a plan amount stated
  without a period isn't checked (a goal's catch-up stated per month included).
  Module auto-disable requires user confirmation. `GET /api/insights/audit` returns
  `{ findings, stats, accuracy }`; `GET /api/insights/status` includes an
  `audit_accuracy` block — both surfaced via `getAuditAccuracy(days=90)`, which
  returns `{ total_audited_runs, clean_runs, incomplete_runs, accuracy_pct,
  findings_by_severity, findings_by_tier }` over the trailing 90 days. "Clean" =
  zero critical findings. The denominator counts ONLY runs that were genuinely
  audited to completion (`financial_insights.audited_at IS NOT NULL AND NOT
  audit_incomplete`); runs that were never audited or whose tiers silently
  threw are reported separately as `incomplete_runs` and excluded — so a
  swallowed-tier failure or an un-audited insert no longer masquerades as a
  "clean" run and inflates the accuracy % (AI-5/AI-6).
- **Insight email via Per-sistant**: After each insight generation (scheduled OR a manual
  `POST /api/insights` run — AIN-16; a run that produced no insight text sends nothing), Perfin sends
  an `insights_generated` webhook to Per-sistant with `{ subject, html_body, plain_text }`.
  HTML email is pre-rendered in Perfin with app-matching dark theme (gold/amber accents,
  Arc Reactor branding). Its "Open Dashboard" link is the real dashboard URL
  (`perfinDashboardUrl()` in routes/persistent.js: `PUBLIC_URL` / `RENDER_EXTERNAL_URL` + `/perfin` under the
  shell) and is left out when that address isn't known (cycle-7 F72 — it was `href="#"`). Includes audit findings section if critical issues detected.
  Settings → AI Insights → **Insight Emails** (`user_settings.insight_emails_enabled`,
  default on) turns it off — `generateInsights` then skips the send (cycle-7 F81).
  Per-sistant receives the webhook and forwards to its email service. If
  `persistent_webhook_secret_enc` is unset, `sendPerSistantWebhook` hard-refuses
  to dispatch (returns `{ sent: false, reason: "missing_secret" }`) — the
  receiver was already rejecting unsigned posts, so failures are now visible
  to the caller instead of being warned-and-dropped opaquely.
  **Under the unified shell, delivery is IN-PROCESS** — the shell calls
  `persistent.setEmbeddedPersistentPool(persistent.pool)` (in `routes/persistent.js`),
  and `sendPerSistantWebhook` short-circuits the three email events
  (`insights_generated`, `weekly_summary`, `daily_summary`) through
  `deliverDigestInProcess`, which INSERTs straight into Per-sistant's `emails`
  table (recipient = `perfin_webhook_recipient` → `SMTP_FROM` → `SMTP_USER` →
  draft) — no `persistent_url`/secret/HMAC needed. The recipient must look like
  an address; with none (or an invalid one) the email is still stored as a draft
  but the call returns `{ sent: false, stored: "draft", reason:
  "no_recipient_configured" | "invalid_recipient" }` (cycle-7 F79 — a draft used
  to be reported `sent: true`). The weekly / daily digest ticks treat those two
  reasons as settled for the local day (no hourly drafts) and record the run as
  a failed job, so Sync Health shows it. The HTTP webhook path remains
  the standalone fallback, and the `test` event always uses HTTP (it exists to
  probe the webhook config). `GET /api/settings` returns `embedded` so the
  Settings UI suppresses the "configure the webhook" digest prereq warning when
  embedded.
- **Weekly digest email**: standing once-per-week Monday-morning channel
  (independent of `insights_cadence_days`). Fires the `weekly_summary`
  webhook event with `{ subject, html_body, plain_text }`, rendered by
  `renderWeeklyDigestEmail()` directly from `insights_running_summary_json`
  — no AI call. The HTML lists trends (with up/down arrows), pending
  actions (urgency-colored), active alerts (severity-colored), and
  recently completed goals. Opt-in: Settings → AI Insights → "Weekly
  Digest Email" toggle (default off); day-of-week configurable
  (`weekly_digest_day`, default Monday), not before 07:00 APP_TIMEZONE
  (`DAILY_DIGEST_HOUR`, cycle-8 F53 — it went out with the first hourly tick, at about midnight).
  The scheduler ticks hourly but `runWeeklyDigest` itself gates with a 6-day window from
  `last_weekly_digest_at` so the daily-aligned check is idempotent, and
  skips (`empty_summary`) when all four summary arrays are empty (AIN-16).
  Alerts are coloured by their own critical/warning/info map (AIN-14). The
  plain-text version lists Recently Completed goals like the HTML one (F72).
  Under the shell it's delivered in-process (needs a recipient address — else
  a draft, reported not sent, F79); a STANDALONE Perfin needs the Per-sistant
  webhook configured (same path as `insights_generated`); without it
  `sendPerSistantWebhook` short-circuits and the digest is a no-op.
- **Daily activity digest**: opt-in once-per-day digest of yesterday's
  new transactions, balance deltas, new subscriptions, and notifications.
  Fires the `daily_summary` webhook event with `{ subject, html_body,
  plain_text }`, rendered by `renderDailyDigestEmail()` from
  `gatherWhatsNew(since)` — same aggregator the dashboard's "Since
  you last looked" widget uses, so both surfaces see the same data shape.
  No AI call. Opt-in: Settings → AI Insights → "Daily Activity Digest"
  toggle (default off). Hourly scheduler; `runDailyDigest(now)` is
  wall-clock anchored (AIN-15): at most once per LOCAL date
  (APP_TIMEZONE), never before 07:00 local (`DAILY_DIGEST_HOUR`), covering
  everything since the previous send (floored at 72h; a first send covers
  24h) and stamping `last_daily_digest_at = now`. (The old 20-hour gate
  crept 3–4h earlier every day and its fixed now−24h window repeated
  transactions.) Skips silently when `gatherWhatsNew` returns zero counts.
- **Critical-alert emails** (opt-in, Settings → AI Insights/Notifications →
  "Critical Alert Emails", `user_settings.critical_alert_emails_enabled`,
  default off): budget-exceeded (100%+, shares the push path's 24h
  `sentRecently` dedup) and 3x-anomaly charges (one summary email per sync
  run; email failure never holds the anomaly push watermark) email
  immediately via the digest channel (`critical_alert` event —
  `sendCriticalAlertEmail` in routes/persistent.js; in-process under the
  shell, HTTP webhook standalone). Its `{ tag | kind }` option names the alert's
  kind — a kind muted in Settings sends no email (`reason: "muted"`, cycle-8 E3b;
  every caller passes it); quiet hours never hold an email.
- `user_settings.last_reconcile_at TIMESTAMPTZ`: watermark for the weekly
  self-healing reconcile and the manual `POST /api/sync/reconcile`. The
  scheduler runs the trailing-window Teller backfill at most once per 7-day
  window from this timestamp. Same Per-sistant prereq as
  weekly digest — without webhook config, it's a no-op.
- **Context export**: Structured financial data (markdown/JSON) for pasting into Claude chat deep-dives.
  Accounts drop the Plaid brokerage phantom (`NOT EXISTS` an active
  `investment_accounts.plaid_account_id` — the same dedupe as `getNetWorth`),
  `investment_accounts` are listed (markdown section + JSON `investment_accounts`),
  credit/loan balances render as `-$X owed` (JSON rows carry `is_liability`), the
  "latest insight" is a real insight (`entry_type = 'insight'`, not a categorize /
  rebuild usage row), and dates are ISO `YYYY-MM-DD` (SXE-9). A card's limit
  follows the AIN-7 rule (credit_limit, else owed + available when available is
  known, else unknown — JSON `credit_limit` / `utilization_pct` null, markdown
  "limit unknown"; cycle-7 F36: an unknown limit read as 100% utilized).
- **Real-time anomaly alerts**: Push notifications for charges 3x+ above merchant average during sync
  (case-insensitive merchant grouping; separate from the 2x AI analysis threshold).
  Covers Teller AND Plaid rows: `runAnomalyCheck()` (routes/enrollments.js) runs ONCE
  per `syncAllTransactions` over the combined added count — it reads the transactions
  table, not a provider result. Previously it lived inside the Teller sync and was gated
  on the Teller count, so Plaid charges never alerted (DD-1). Reconcile never runs it.
  New = an id watermark with a 24 h overlap rescan (`services/txn-watermark.js`, cycle-8
  E2c): rows above `last_anomaly_txn_id` (the newest id read before the candidates) plus
  rows at or below it created within 24 h of the previous check — a row an overlapping
  sync or CSV import committed after a check, with an id taken before it, is still
  checked; a charge already announced (its `transaction_id` in an anomaly notification's
  data) is skipped. It replaced F1's `created_at` mark, which stopped at the start of any
  open transaction on the database and so held every later alert back.
- **Budget threshold alerts**: Push notifications at 80% (warning) and 100%+ (exceeded) every 3 hours

### UI & UX
- **Authentication (standalone)**: SESSION_PASSWORD (text) or SESSION_PIN
  (numeric PIN pad), configurable timeout. Bypassed under the unified shell.
- **Authentication (unified shell)**: SHELL_PIN with sliding-window idle
  timeout (default 60 min, tunable from Settings → Security → "App Idle
  Timeout"). Cookie refreshed on every authenticated request so an active
  user never times out mid-use; idle past the window → re-prompted.
  Brute-force protection: a 750ms wrong-PIN delay plus IP rate limiters —
  `authLimiter` (10 failed/15min) on `/login` + biometric authenticate, and
  `apiKeyLimiter` (20 failed/15min) on the `x-api-key` path (counts only
  failed key attempts, so browser/cron traffic is unaffected) — plus a GLOBAL
  ceiling across all IPs (PSC-14): 30 failed PINs within an hour locks PIN login
  for 30 minutes (429, even for the right PIN; biometric and x-api-key still
  work) and pushes a "PIN login locked" notification (tag `pin-lockout`) — at
  most one per 6 hours (`makeLockoutNotifier`, `sentRecently('pin-lockout', 6)`,
  cycle-7 F7; a sustained guesser re-trips the lockout every 30 minutes). The
  counter is in memory (a restart clears it — which is why the PIN compare must
  never be able to crash the process, cycle-7 F1). Trade-off: anyone can trigger that
  30-minute PIN lockout. Boot warns when `SHELL_PIN` is shorter than 6 characters.
  The login keypad's 8 dots are only a mask — a longer PIN can be typed (it used to cap
  at 8) — and Enter is left to another focused control such as the biometric button
  (IF-6).
  A page requested while signed out (e.g. a notification deep link after the
  idle timeout) is carried through login (PSC-9): `requireAuth` redirects to
  `/login?return_to=<path>` (validated by `safeReturnTo`), the form keeps it as a
  hidden field (also on a failed/locked re-render), and both the PIN and the
  biometric path land there. (The `#fragment` doesn't reach the server.)
- **Login animation (standalone Perfin)**: Iron Man helmet materialize on
  successful login (gold-amber stroke-draw → fill → particle burst → HUD
  scan → redirect). Lives inline in `teller/views/login.ejs`.
- **Landing page (unified shell, design pass D7, decision 13)**: `/` — the tile
  picker the home-screen app opens on (the manifest's `start_url`; a PIN login
  still lands in Per-sistant) — gives each tile one status line, read when the
  page is served (`shell/landing-status.js`): Perfin "$X owed to <payee> · N
  bills due this week · N to review" (or "Nothing needs attention") from
  Perfin's own `gatherDashboardSummary` with just its rent / bills /
  uncategorized parts (INV-147), Per-sistant "N tasks due today · N overdue"
  (or "Nothing due today") from its `taskDueCounts`. In-process over the wired
  pools (INV-25), read-only, behind the PIN gate; each line has a 1.5s budget,
  and a failed or slow one leaves the tile with its description. It reads both
  databases at most once per 30 s (an idle Neon wakes, as opening either app does);
  visits in between share the running read or its result, so a line can be up to
  30 s old (cycle-8 F33).
- **Tile-click + cross-app transition animations (unified shell)**: the
  same Iron Man materialize plays when entering Perfin from the landing
  tile or from Per-sistant's nav cross-app icon; a parallel cosmic mask-
  crop reveal (scan-line + nebula + rising particles) plays when entering
  Per-sistant from the landing tile or Perfin's nav cross-app icon.
  Implemented as shared shell static modules (`shell/public/
  perfin-materialize.{css,js}` and `transition.{css,js}`) wired via
  `data-perfin-materialize` / `data-atrans="cosmic"` attributes.
- **Branding (Perfin)**: Iron Man helmet logo (SVG traced from PNG) — nav
  bar icon (CSS mask), standalone Perfin PWA icon, login animation source.
- **Branding (unified shell PWA)**: mask-crop PNG (1024×1024). Served from
  shell at root paths so iOS auto-discovers from any page. Distinct from
  Perfin's per-app icon — adding from a Perfin page still gets the helmet
  bookmark.
- **Status messages (toast stack)**: `showMsg(text, ok)` pushes onto a
  `#toast-stack` container (auto-created on first call) instead of
  overwriting a single per-page element. Stack caps at 5 visible toasts;
  identical consecutive messages dedupe (timer bump, no pile-up). An optional
  third argument `{ action: { label, run, focus? } }` adds a button (`.toast-action` —
  the Activity page's "Undo", T2.5 U2): pressing it closes the toast and calls
  `run`; such a toast stays 10 s and is never merged with an earlier one. Since
  cycle-8 F56 an action toast closes only through its buttons (Undo or a labelled
  "Dismiss" ×, `.toast-close` — a tap on its text no longer dismisses it), its
  timer waits while it is hovered or holds focus, and `focus: true` moves focus to
  the action button (the Activity delete passes it; its text also names Settings →
  Sync Health → Deleted transactions). The cap
  counts only toasts that aren't already leaving and removes the excess
  immediately (F89 — counting leaving toasts made the sixth message loop
  forever and freeze the tab). Each
  toast auto-dismisses after 5 s (success) / 10 s (error); tap to dismiss
  early. Desktop: anchored top-right with slide-down. Mobile (≤640px):
  bottom-right `column-reverse` with slide-up so the newest is at thumb
  level and doesn't compete with the iOS notch / Dynamic Island. Legacy
  per-page `.status-msg` divs are now `display: none !important` but kept
  in templates so any direct DOM writes are silent no-ops.
- **Dark/Light theme**: Toggle in Settings, persisted to DB + localStorage
- **PWA**: Installable home screen app (manifest.json + service worker, helmet icon centered on home screen).
  Service worker (cache `perfin-v7`) uses network-first, caches successful same-origin
  static GETs (keyed by path, never a redirected response or stray HTML — F107), and
  explicitly skips `/api/*` so the dashboard never serves stale balances when offline.
- **Offline fallback page** (Phase D): when navigation fails and no cache hit exists,
  the SW serves `/offline.html` — a branded "You're offline" page with a Retry
  button — instead of the browser's generic error. Served with an injected
  `<base href="<mount>/">` and an external `offline.js`, so the logo and Retry
  work under the shell's mount and CSP (F92).
- **Install prompt** (Phase D): `perfin-shared.js` captures `beforeinstallprompt`;
  Settings shows an "Install App" section with a button when the browser is ready,
  hides itself when already installed (`display-mode: standalone`), and falls back
  to iOS Add-to-Home-Screen instructions when neither path is available.
- **Mobile polish** (Phase D): viewport-fit=cover for iOS notch, dual light/dark
  `theme-color` meta, 40/44px (desktop/mobile) touch-target minimums on buttons.
- **Safe-area pass + pull-to-refresh** (PWA Phase-0 follow-up): Perfin's body
  (and the shell login/landing) pad by `env(safe-area-inset-*)` so the top nav
  clears the iPhone status bar/notch under viewport-fit=cover (Per-sistant
  deliberately omits viewport-fit and auto-insets — don't "fix" the asymmetry).
  Both apps' shared JS ship `initPullToRefresh`: standalone-display-mode-only,
  passive-listener drag-down-from-top → ring indicator → reload, with
  overlay/pyramid/canvas exclusions (iOS home-screen PWAs have no native
  pull-to-refresh gesture).
- **Mobile navigation**: at ≤640px the 7-link top nav collapses behind a
  **hamburger** (drawer drops under a single-row bar; closes on link tap /
  outside click / Esc) and a fixed **bottom tab bar** surfaces the 5 primary
  destinations (Home/Activity/Subs/Budgets/Settings) thumb-reachable. From
  January to April (`taxSeason`) the drawer also lists **Tax** after Rent
  (`#nav-tax-link`, shown by the nav script; never in the desktop top nav, and
  the tab bar keeps five items — design D7, decision 14). Both are
  in `partials/nav.ejs` + `perfin-shared.css`; desktop is unchanged (both
  hidden). Body gets bottom padding and the toast stack lifts above the bar.
  Between 641 and 960px the top bar wraps and the links take their own
  full-width row (cycle-7 F94 — eight links + badge + bell scrolled the page
  sideways); the bill calendar's columns are `minmax(0, 1fr)` so a long event
  name can't widen the page (F95).
- **Responsive tables → cards**: wide data tables opt into a shared
  `responsive-cards` pattern (`perfin-shared.css`) — at ≤640px the header row is
  visually hidden and each `<td>` (with a `data-label`) renders as a label:value
  line inside a card. Special cells: `cell-primary` (full-width title),
  `cell-actions` (wrap row of 40px-min buttons), `cell-check`, `empty`/`empty-msg`.
  Applied to the Subscriptions list AND the four dashboard mini-tables
  (Monthly Spending, Spending by Category, Top Merchants, Upcoming Charges).
  The Transactions (Activity) page uses a denser variant instead —
  `txn-compact` (perfin-shared.css): a two-line CSS-grid row (merchant +
  amount / date · category · actions, account hidden) at ~⅓ the height of a
  responsive-card, with the filter bar collapsed behind a "Filters" toggle on
  mobile — in one row with "+ Add cash transaction" at the same touch height
  (`.txn-actions`, design D7) — so the recent-transactions list sits at the top of the page (the
  dashboard's Recent Transactions section was removed in favor of it). The
  four dashboard mini-table sections (and, since design D4, the pyramid — its h3 toggles
  it) are collapsible (h2 toggles, chevron,
  state persisted per-section in localStorage `perfin_collapse_<key>`), and
  Spending by Category has a month selector ("Recent months" aggregate
  default, or any month from the trend — backed by GET
  /api/spending-categories, which uses getCategorySpendingForMonth so the
  per-month figures match budgets/snapshots). Floating chrome (toasts,
  notification panel, mobile nav drawer) sits on the opaque
  `--surface-solid` token — the translucent 4%-alpha `--surface` is for
  in-flow cards only; anything floating OVER content needs full opacity or
  the page bleeds through. New wide tables should add
  `class="responsive-cards"` + `data-label`s rather than relying on horizontal
  scroll.
- **Money formatting**: the shared global `fmt()` (`perfin-shared.js`) renders
  thousands separators (`$22,199.52`) and a negative as `-$24.29` (design pass D1 —
  it printed `$-24.29`; a value that rounds to zero is `$0.00`); the investment
  return line and the Goals page's FIRE card follow the same sign rule. Stat-card
  `.value` font uses `clamp()` + `overflow-wrap` so large amounts never overflow
  narrow 2-up mobile cards.
- **Money colours (design pass D2)**: a charge, a balance and a debt are the
  default text colour; money coming in is green (`.amt-in` — an Activity credit
  also reads "+$X"); red (`.amt-bad`) only for something wrong — an overdue Rent
  item, a balance projected below $0, an overdrawn cash account, a negative net;
  gold is the brand (logo, active nav, primary buttons, focus), never money. Use the
  two classes in `perfin-shared.css`, not inline colours. The Calendar shows a bill
  as a neutral chip.
- **Shared design tokens (design pass D6, decision 9)**: `design/tokens.json` is the spec for
  what both apps share — the status colours (ok / warn / danger / info, dark and light), the type
  scale (12 / 13 / 14 / 16 / 20 / 28), spacing (4 / 8 / 12 / 16 / 24 / 32), radius (card 12,
  control 8, pill 999) and button heights (32 / 40 desktop, 44 on a phone). Each app declares them
  in its own CSS under its own names (Perfin `perfin-shared.css`: `--green` / `--yellow` / `--red`
  / `--blue`, `--fs-*`, `--space-*`, `--radius-card|control|pill`, `--btn-h-sm|-h|-touch`;
  Per-sistant `views/css.js`: `--status-ok|warn|danger|info` and the same other names) and
  `tests/design-tokens.test.js` fails on drift. Accent, surfaces and fonts are `app_specific` —
  Perfin keeps teal / gold glass, Per-sistant its palettes and paper. Change a shared value in the
  spec AND both apps. Per-sistant's status colours are now the same in every palette (`--good` /
  `--warn` resolve on `body` from them) and its cards are 12px-rounded like Perfin's.
- **Buttons (design pass D2)**: sentence case everywhere (no `text-transform:
  uppercase` on `.btn` / `.btn-sm` / `.actions button`; labels written "Sync
  transactions", not "Sync Transactions" — `tests/design-d2.test.js` scans for
  Title Case); `.primary` is FILLED gold with `--on-warm` ink, other buttons are
  outlined; a disabled button is dimmed.
- **Empty states (design pass D2)**: `emptyState()` (perfin-shared.js) — a title,
  one line and the next step as a button: Upcoming Bills ("+ Add bill" — the Quick
  Add button), AI Insights ("Generate in Settings" → `/settings#ai-insights`),
  Goals / Budgets ("+ Add goal" / "+ Add budget" — the form toggle), Subscriptions
  ("Run detection"); the Monthly Spend / Avg Daily cards read "Not yet" ("after your
  first full month") until a whole month is synced.
- **Page width (design pass D1)**: `.container` — which holds the top nav — is one
  width on every page (1060px); a page narrows its CONTENT with `#main-content {
  max-width: … }` in its `extraStyles` (default 960px; Accounts 640, Budgets / Goals
  720, Tax 820, Settings 860 — 1080 at ≥961px, where its group index takes a left
  column, design D5). A per-page `.container` width used to squeeze the nav:
  on Budgets it wrapped into three rows at a desktop width. Don't set a page's
  `.container` width — `tests/design-d1.test.js` fails on it.
- **Settings layout (design pass D5, decision 8)**: one page, seven groups — Appearance &
  Dashboard; Security; AI; Alerts & Notifications (push, Quiet Hours & Muting, Cash Alerts,
  Per-sistant Tasks, CSV reminders); Sync & Connections (Sync Health, auto-sync, Sheets, keep-alive); Planning (Target
  Allocation, Watchlist); Data & Exports. At ≥961px a sticky index of the groups sits in a left
  column; narrower, a "Jump to" select. Both are built from the group headings, so a new group
  lists itself — add a `<section class="settings-group" id="group-…">` with an `h3.settings-group-title`
  and keep each section's id (deep links: `#sync-health`, `#deleted-transactions`,
  `#recent-errors`, `#quiet-hours-section`, `#cash-alerts-section`, `#linked-tasks-section`,
  `#ai-insights`).
  Every switch saved through `updateSetting` goes through `saveToggle(box, key)`: a save the server
  refused or that never reached it puts the switch back (cycle-8 F38 — it stayed flipped); the
  insight-module and dashboard-widget switches revert the same way.
- **"Last synced" nav badge** (Phase D): top nav shows "Synced 47m ago" with color-coded
  staleness: green (<6h), yellow (6-24h), red (>24h). Tooltip shows per-source
  freshness (transactions, balances, auto-sync). Populated from the most recent of
  `last_auto_sync_at`, `last_txn_sync_at`, `last_balance_sync_at`. Hidden on
  mobile (≤640px) to free up nav width — same data lives in Settings and the
  notification log.
- **Unified notification center**: In-app notification history via `notification_log`
  table. Nav bar bell icon shows unread count badge. Desktop: clicking opens a
  drop-down panel (`.notif-panel`) anchored top-right. Mobile (≤640px): the panel
  becomes a full-width bottom sheet with a grab-handle hint + dim backdrop
  (`#notif-backdrop`); tap the backdrop, click outside, or press ESC to dismiss.
  Show/hide uses the HTML `hidden` attribute so CSS animations are declarative.
  Sticky header keeps the title + "Mark all read" pinned while scrolling the
  list. `sendToAll()` logs every push notification to the table, so
  notifications are preserved even if the user hasn't enabled push or dismissed
  the browser alert. API: `GET /api/notifications`, `PATCH /api/notifications/:id/read`,
  `POST /api/notifications/read-all`. Activating a notification marks it read and, when
  its `data.url` is a same-app path (`/x`, never `//host`), opens it via `withBase`
  (IF-7 — e.g. the missing-utility reminder lands on `/housing#pending`). A row whose push
  didn't go out says so after its time (`push_state`, cycle-8 E3c): "Held for quiet hours",
  "Held for quiet hours — not pushed" (expired), "Muted — not pushed" or (cycle-8 E3d) "Your
  Per-sistant task covers it — not pushed" (covered — such a row is written read).
- **Data freshness API**: `GET /api/data-freshness` returns per-source timestamps
  (transactions, balances, auto-sync, insights) with `age_seconds`, a boolean
  `stale` flag (>24h), and an explicit `level` (`"fresh"` <6h / `"aging"` 6-24h /
  `"stale"` >24h or never synced). The response also includes a top-level
  `thresholds: { fresh_seconds, stale_seconds }` block so the nav badge's
  green/yellow/red mapping doesn't need to repeat threshold constants.
  `POST /api/sync` (Teller + Plaid) updates `last_txn_sync_at`;
  `POST /api/sync-balances` updates `last_balance_sync_at`. A reconcile stamps
  `last_txn_sync_at` only when every leg completed (BSI-11).
- **Sync Health card** (Settings): renders `GET /api/data-health` — per-source
  freshness dots (green/yellow/red), Teller/Plaid connection status (the Plaid
  count EXCLUDES `status='CSV'` virtual items; "need re-auth" = a non-GOOD item or
  one with `plaid_items.last_error_code` set — BSI-10; that issue carries
  `link: "/accounts"`, which Sync Health and the dashboard strip render as a link
  to the Re-authenticate button — G3), a derived
  `issues[]` list (disconnected links, stale balances, never-synced, plus the
  per-item errors from the most recent sync run — see `last_sync_result` below),
  scheduled jobs whose last run FAILED (jobs[].last_status / last_error — F8)
  and the operator checks' warnings (cycle-7 G1 + ST4 — tagged `source:'operator'`
  and listed in their own section instead),
  and the last reconcile time — plus a "Reconcile Now" button that POSTs
  `/api/sync/reconcile` to recover any dropped transactions, and an **Operator
  Checks** list (`GET /api/operator-checks`, "Check now" = `?refresh=1`): each check
  with a status dot, detail and fix text — backstop workflows disabled / failing /
  stale, no successful backup in 36h, missing workflow secrets, a public repo (these
  need `GITHUB_OPS_TOKEN` + `GITHUB_OPS_REPO`; without them the list says GitHub checks
  are off), the compromised Teller cert, the token passphrase, a SHELL_PIN under 6
  characters, timezone / push / calendar-feed notes, bank webhooks (roadmap T2.1 W6 — a
  Plaid connection not registered at PUBLIC_URL is a warning; webhooks off or quiet for
  7 days are info), a Knowledge index needing one full reindex, and (cycle-8 E4a, no token
  needed) the go-live checks — a Teller cert missing while Teller connections exist or
  expiring within 30 days, both apps on one database, a PUBLIC_URL that isn't a bare https
  origin, a missing / short API_KEY, a short SHELL_SECRET, PLAID_ENV without its secret or
  sandbox with real connections, a short Teller webhook secret — and, whenever the GitHub
  checks are off, the last backup recorded by db-backup.yml or backup.sh (none or older
  than 36h → fail). Warn / fail checks also reach the dashboard strip, and the 6-hour
  watchdog pushes one "Operator checks: N need attention" notification (tag
  `operator-checks`) per change in the failing set. Below them, **Recent errors**
  (roadmap T1.4, anchor `#recent-errors`, `GET /api/errors`): the in-app error
  log's unresolved errors from both apps — source, message, count, first / last
  seen, the sample stack under Details and a Resolve button
  (`POST /api/errors/:fingerprint/resolve`; it reopens on the next occurrence).
  Data-health raises "N server error(s) in the last 24 hours" while any are
  unresolved, and each new or reopened error notifies once (≤5 a day).
  **Webhooks + connections (roadmap T2.1 W6)**: under the provider counts the card
  shows a Webhooks line per provider — "off — set PUBLIC_URL / TELLER_WEBHOOK_SECRET",
  or the last event's age and status, the last 24 hours' count and failures — a
  "Register Plaid webhooks" button (`POST /api/plaid/webhooks/register`,
  `data-e2e-skip`; shown while PUBLIC_URL is set and Plaid connections exist, with
  "N of M registered at <url>") and a collapsible Connections list: each Teller
  enrollment / Plaid item with a freshness dot from its own `last_synced_at` ("no
  complete sync recorded yet" until one stamps it) and a re-auth / disconnected
  state. Data-health raises "N <provider> webhook event(s) failed in the last 24
  hours".
- **Sync-degradation strip** (dashboard): a banner (`#sync-health-strip`) fetches
  `GET /api/data-health` on load and surfaces its warning-level `issues[]`
  (disconnected links, stale sync, `decryption_failed`, stale scheduled jobs) at
  the top of the dashboard — so silent degradation is visible without opening
  Settings → Sync Health (deep-links there via the `#sync-health` anchor).
  Dismissible per-session (`sessionStorage`), so a persistent issue re-appears on
  the next visit rather than being permanently silenced. Hidden when healthy;
  best-effort — a failed probe never blocks the dashboard.
- **Web Push notifications**: VAPID-based push notifications for anomalies, budget alerts,
  goal milestones. `push_subscriptions.keys` is JSONB, which node-pg returns as an
  OBJECT — `subscriptionFromRow` accepts an object or a JSON string (F74: the old
  `JSON.parse(row.keys)` threw on every row, so no push was ever delivered and dead
  subscriptions were never pruned). A 410/404 prunes the subscription; any other
  send failure is logged. **Quiet hours and mutes (cycle-8 E3b, G2):** `sendToAll`
  holds a push during quiet hours (`notify_quiet_hours`, APP_TIMEZONE) and never pushes
  a muted kind (`notify_muted_types`) — the bell row is written either way, with its
  `push_state`. Held pushes go out once quiet hours end (the notify-release job — one
  summary for several); a hold not released within 12 hours stays in the bell only.
  PIN lockout and the test notification are never held or muted. Settings → Alerts &
  Notifications → **Quiet Hours & Muting** (`#quiet-hours-section`, cycle-8 E3c) sets both: a
  switch and two times (Save times; an empty or equal pair is refused before any request) on the
  APP_TIMEZONE clock, and a checkbox per mutable kind grouped by app (Per-sistant's kinds only
  under the shell); every save goes through `PATCH /api/settings` + `writeOk` and a refused one
  puts the control back. Under the shell the settings cover Per-sistant too (see the Per-sistant
  Integration section). **One item, one alert (cycle-8 E3d, ST2):** the rent, utility-amount
  and still-charging pushes name their item; while Per-sistant has an open linked task for it
  (Per-sistant Tasks on), the push isn't sent — the bell row is written read as "covered".
  The other way round (cycle-8 E3e): Per-sistant raises no browser notification for an item
  Perfin pushed in the last 12 hours.
- **Accessibility**: Skip-to-content link, `<main>` landmark, chart aria-labels, :focus-visible
  styles, WCAG AA contrast-compliant text colors. Modals and the bell panel go through the
  shared `openDialog` / `watchDialog` (focus trap, Esc, focus restore — IF-1); form controls
  carry a `<label for>` or `aria-label` (IF-3, scan-pinned for the Activity, Rent, Accounts,
  Goals, Budgets, Calendar, Settings and Subscriptions pages — the last two since cycle-7
  F101, with the template-built Goals link picker and investment remove buttons named too).
- **CSP nonces**: Per-request cryptographic nonces for all inline scripts (no `'unsafe-inline'` in `scriptSrc`). Style policy is split: `styleSrcElem` is nonce-gated for `<style>` blocks while `styleSrcAttr` keeps `'unsafe-inline'` for inline `style=""` attributes.
- **Keep-alive**: Timezone-aware self-ping to prevent Render free tier sleep (10s timeout)
- **Per-model cost tracking**: Usage history with granular pricing (Haiku/Sonnet/Opus)
- **Google Sheets sync**: Auto-sync to 16+ tabs. Core 7 plus strategic
  additions render every aspect of the DB into Sheets-native views.
  - **Transactions**: split rows interleaved below their parent via CTE
    UNION; `Source` column (user / auto / split); `Reimbursed` columns;
    italic-tan formatting on splits; green tint on reimbursed.
  - **Subscriptions**: `Days Until` countdown column (Sheets `=DAYS`
    formula so it stays accurate when reopened); imminent ≤7 day
    highlight; warning-only sheet protection.
  - **Utilities**: auto-detected utility subscriptions + `manual_bills`
    with `category='utility'`, TOTAL roll-up combining monthly + yearly.
    A manual bill's Next Due comes from `cadence.manualBillOccurrences` (the
    app's creation-anchored, month-length-clamped rule, APP_TIMEZONE today) —
    cycle-7 F76: the SQL put a yearly bill next month and capped the day at 28.
    Rows are sorted in JS (Active first, then Next Due, blanks last). (The old
    SQL `ORDER BY CASE … ` on a UNION failed the tab on every sync — Sept 2026
    Batch 6.)
  - **AI Insights**: main grid (date / model / tokens / feedback /
    feedback note / insight) + four sub-tables below from the structured
    `insights_running_summary_json` (Trends, Pending Actions, Active
    Alerts, Completed Goals); per-feedback row coloring.
  - **Recurring Transfers**: warning-only protection.
  - **Tax Deductions YYYY**: computed from TRANSACTIONS at sync time (SXE-7)
    — one row per matching transaction (Merchant, Amount, Category, Type,
    Confirmed, Notes, Date), the inlined copy of `TAX_KEYWORD_GROUPS` + the
    `getTaxDeductionTransactions` query (pinned to the canonical by
    tests/scan-sept-batch7.test.js), merchant annotations from
    `tax_deductions`. Through April the PRIOR year's tab is refreshed too
    (December charges posting in January, late confirmations); a past year
    with no rows gets no tab. Warning-only protection.
  - **Dashboard**: net worth, budgets, goals, over-budget conditional
    formatting (every spending figure net of refunds through a mirrored
    `refund_lines` + `net_cat_months`, SX3-pinned — cycle-7 F35); SPENDING BY CATEGORY section gained 6 per-month columns
    + SPARKLINE Trend column + gradient heatmap conditional formatting
    over the month cells; "Synced [day, time]" banner restyled. Budget Status
    compares against the EFFECTIVE limit (base + prior-month rollover, one-time
    budgets only in their month — SXE-4, parity with `getBudgetStatus`). All
    month windows are whole APP_TIMEZONE months and the banner timestamp is in
    APP_TIMEZONE (SXE-12 — it was hard-wired to America/New_York); the script's
    `SHEETS_TZ` / `sheetsTodayStr()` / `sheetsMonth(offset)` also anchor the
    Income windows, the tax year and the month-archive "current month".
    Avg Monthly / Avg Daily Spend are over COMPLETED months with real month
    lengths (`completedMonthAverages`, cycle-7 F75 — parity with FAN-6; it was
    the 6-month window ÷ 6 incl. the month to date), blank until a month is
    complete.
  - **Investments** (new): Plaid holdings with cost basis, current
    value, return $, return % (green positive / red negative), grand
    total. Teller-linked accounts excluded (no Teller cost-basis API).
    A holding with an unknown basis has blank Cost Basis / Return cells and
    the total return covers known-basis holdings only (BSI-5).
  - **Net Worth History** (new): one row per month (last snapshot per
    YYYY-MM via DISTINCT ON), month-over-month delta column.
  - **Income** (new): monthly totals (24mo) + top sources (12mo) using
    the canonical income predicate (inlined `incomePredicate` to keep the
    script standalone; its full structure is SX3-pinned to the canonical).
  - **AI Trust** (new): 100 most-recent `ai_audit_log` findings
    (severity-colored) + 50 most-recent user feedback ratings on
    insights (feedback-colored).
  - **Categorization Rules** (new): user merchant→category map sorted
    by `times_applied`; inactive rules greyed out.
  - **Manual Bills** (new): all categories (not just utility), with
    monthly-equivalent TOTAL (quarterly /3, yearly /12).
  - **Bill Payments Log** (new): joins `bill_payments` to both
    `detected_subscriptions` and `manual_bills` depending on
    `bill_source`; variance column flags >10% deviation. A payment with no
    recorded amount (legacy calendar clicks) shows Paid Amount + Variance
    blank instead of −100% (SXE-11).
  - **Important Dates** (new): 90-day upcoming-events view (from the
    APP_TIMEZONE today) of subscription next-charge dates and goal
    `target_date`s (SQL), EVERY manual-bill occurrence in the window
    (`cadence.manualBillOccurrences` — day clamped to the real month length,
    no 28 cap) and each recurring transfer's next date stepped by calendar
    month from its last transfer (`cadence.seriesOccurrences`) — cycle-7 F76:
    `last_transferred + cadence_days` dropped a month-end transfer and the
    SQL listed one bill date. A subscription still shows only its stored
    `next_expected`. Days Away is a Sheets formula. Today=red, ≤7 days=amber.
  - **Watchlist** (new): user-curated merchant / category / keyword
    monitor backed by the `watchlist_items` DB table. Tab shows each
    item + its last-90-day matching transactions. Items edited via
    Settings → Watchlist; the tab itself is read-only with warning-only
    protection. Empty-state writes a guidance row. A value is matched
    literally (LIKE `\ % _` escaped, INV-10) and the "90-Day Spend (your
    share)" column is a separate aggregate of debits, reimbursed excluded,
    the shared-card split applied (cycle-7 F42 — it summed the raw signed
    amounts of ≤100 listed rows).
  - **Per-month archive tabs** (new): `syncMonthArchives()` creates a
    dedicated `YYYY-MM Transactions` tab with all that month's transactions +
    totals once the month is SETTLED — 10 days after month-end
    (`archiveReadyOn`, SXE-3: archiving on the 1st froze the month before
    late-posting charges and pending→posted re-deliveries landed). A finished
    archive carries a completion marker (protection description
    `Perfin archive complete — YYYY-MM · <fp>`, `archiveMarker(month, fp)`);
    `<fp>` is the first 12 hex of an md5 over the month's archived rows (id,
    amount, date, account, display merchant + category, reimbursed, notes),
    computed for every month by ONE grouped query per run (`ARCHIVE_MONTHS_SQL`).
    A tab whose marker doesn't match the live fingerprint — a row backfilled into
    the month later (a long Plaid history, a reconcile) or an edit to an archived
    row — is cleared and rebuilt, and so is a tab with no marker (a run that died
    mid-write) or a legacy marker without a fingerprint (cycle-7 F85: a finished
    archive used to be final forever). At most `MAX_ARCHIVES_PER_RUN` (6) archives
    per run, so a first sync over years of history doesn't blow the Sheets quota.
    A per-month record for disputes / taxes / historical lookups that follows
    later edits — it is not a frozen copy of what was exported at the time.

  **Re-runnable formatting (SXE-2).** Every tab's formatting goes through
  `formatSheet(sheets, sheetId, requests, {resetFormats})`, which DELETES the
  tab's existing banding and conditional-format rules before re-adding them —
  `addBanding` on an already-banded range throws ("cannot add alternating
  background colors"), which used to fail every tab's second sync. The
  Dashboard, Income, AI Trust and Watchlist (whose row layouts shift between
  runs — cycle-7 F77 for the last three) also reset cell formats first, so a
  shorter run doesn't leave stale colours on rows that now hold other data. **Quota (SXE-14):** sheet ids come from a per-client cache
  (`sheetIdMap`, one `spreadsheets.get` per run instead of one per tab), and
  the client's `retryConfig` retries 429s (any method, honoring Retry-After,
  else 15s × attempt ≤ 60s) but NEVER retries a POST on a 5xx (a
  non-idempotent append could double-write). **Formula guard (SXE-13):** the
  client is wrapped by `guardSheetsWrites`, which prefixes `'` to any string
  cell starting with `= + - @` tab/CR or shaped like `1/2` / `3-4` (Sheets
  would parse it as a date), so a merchant name can never execute as a
  formula; the script's own formulas are wrapped in `sheetFormula()` to pass
  through. A plain signed number / amount / percentage (`-12.5%`, `-$45.00`,
  `-1,234.56`, `PLAIN_NUMBER_RE`) is left alone so it stays a number (cycle-7
  F83 — it was turned into text). **Single-flight (F78):** `syncAll`,
  `syncTransactionsOnly` and `syncDashboardOnly` go through `singleFlight(kind,
  fn)` — a second run of the same kind shares the running promise, a different
  kind waits for it and then runs, so the hourly auto-sync and a manual click
  never write the same tabs at once. **Goals** use the DERIVED amount (balance − baseline when
  funding-linked, SXE-5 / INV-11) like `GET /api/goals`; the category
  expressions are the app's (`COALESCE(user_category, category[1])`, no Plaid
  PFC fallback — SXE-6, SX3-pinned); the Dashboard's KPI-count row is formatted
  as a number, not currency (SXE-10).

  **Outcome is persisted (SXE-1/WD-6).** Every `syncAll` caller (the
  scheduled auto-sync and `POST /api/sheets/sync`, which now returns
  `{ …result, partial, tabs_failed }`) records the run via
  `recordSheetsSyncResult()` (`routes/settings.js`) into
  `user_settings.last_sheets_sync_result`; a CHANGE in the set of failing tabs
  pushes one "Google Sheets sync: N tabs failed" notification (tag
  `sheets-sync`), `GET /api/data-health` raises an issue for a failed last run,
  and the dashboard/Subscriptions/Settings UIs say "Partial: N tabs failed"
  instead of reporting success. (Before, `syncAll` returned `errors[]` and
  every caller ignored it — a tab could fail silently forever.) A FAILED
  partial sync (`/api/sheets/sync-transactions`, `/api/sheets/dashboard`) is
  recorded too, as a one-step error (cycle-7 F86); a partial SUCCESS is not
  recorded, so it doesn't clear a full run's failing tabs.

  Triggered by:
  - Scheduled `sheets-auto-sync` job (configurable cadence: daily / weekly
    / monthly via `sheets_auto_sync_interval`).
  - `POST /api/sheets/sync` (full syncAll — ~30-60s on a large
    spreadsheet).
  - `POST /api/sheets/sync-transactions` — partial-sync endpoint that
    only refreshes the Transactions tab (~5s). Called by the dashboard
    CSV upload modal so users see uploaded transactions in Sheets
    quickly.
  - `POST /api/sheets/dashboard` — Dashboard tab only (checks the Sheets env
    like the other two — F86).

### Per-sistant Integration (Companion App)
Under the unified shell both apps run in the same Node process, so most of
what used to be a network/HMAC integration is now a function call or a
shared session cookie. Cross-app surface area today:
- **Shared auth**: shell PIN gate fronts both apps; sub-app `requireAuth`
  bails on `req.app.get("embedded")`.
- **Cross-app navigation**: in-nav "switch to other tool" link in each app's
  layout, only rendered when embedded. Same-origin, in-app navigation.
- **Knowledge → Perfin finance grounding** (new seam): Per-sistant's Knowledge
  feature (`apps/per-sistant/routes/rag.js`) reads Perfin's pool **read-only**
  via the wired `perfinPool` to ground finance-flavored questions ("can I
  afford my renewal?"): net worth, accounts and investments come from Perfin's
  own `getNetWorth` (`teller/services/financial-queries.js`, loaded lazily — so
  the Plaid-phantom dedupe and signed debts match the dashboard, KR-9), plus
  card limits and active `detected_subscriptions` (monthly equivalent =
  amount × 30 / cadence_days, Perfin's rule). Owned by the
  Knowledge / RAG subsystem; finance queries only; no Perfin schema changes;
  never an HTTP self-fetch (INV-35). This is why a Perfin-side audit should know
  Per-sistant consumes those tables.
- **Cross-pool wiring**: `shell/index.js` does
  `perfin.app.set("persistentPool", persistent.pool)` and the reverse, so
  routes in either app can query the other's database directly via
  `req.app.get("perfinPool")` / `("persistentPool")` instead of HTTP
  self-fetching. Self-fetches 401 through the shell auth gate (the
  in-process fetch carries no shell session cookie), so the wired-pool
  path is the load-bearing design under the unified shell.
- **Insight / digest email pipeline**: the four email events
  (`insights_generated`, `weekly_summary`, `daily_summary`, `critical_alert` —
  `{ subject, html_body, plain_text }`) go through `sendPerSistantWebhook()`
  (`teller/routes/persistent.js`). Under the shell they are delivered IN-PROCESS
  (`deliverDigestInProcess` — a row in Per-sistant's `emails` table for the first
  VALID address of `perfin_webhook_recipient` → `SMTP_FROM` → `SMTP_USER`, checked
  with Per-sistant's own `EMAIL_REGEX`; seams audit #3 — it stopped at the first SET
  value, so a display-form `SMTP_FROM` made every digest a draft). Only a standalone
  Perfin (and the `test` event) uses the HMAC-signed HTTP webhook.
- **Unified search — finance results** (roadmap T2.4 X3a): Per-sistant's `GET
  /api/search` (the dashboard search widget) also searches Perfin under the shell,
  READ-ONLY through the wired `perfinPool` (`apps/per-sistant/routes/finance-search.js`,
  never an HTTP self-fetch): transactions by display merchant / user notes / category
  (the 10 newest, at the user's share via Perfin's own `SPLIT_AMOUNT`, reimbursed and
  pending marked), active subscriptions, manual bills, goals and account names (the
  Plaid brokerage phantom left out), 10 each. Results follow Per-sistant's in the same
  array with `group: 'finance'`, `app: 'perfin'`, `type` (transaction / subscription /
  bill / goal / account), `title`, `description` and `url` — a path inside Perfin (a
  transaction: `/transactions?q=<merchant>&month=YYYY-MM`) that the widget joins with
  Perfin's mount (`linkedAppHref`, views/js.js — the linked-task chip's rule); no
  inline actions. Each query is fail-soft (a failing one drops its results and the
  request logs once); `q` is matched literally (F124) and must be 2-200 characters (a
  longer one is a 400). Standalone: no finance results, no Perfin query. X3b: the result
  renderer is ONE function, `renderSearchResults` (views/js.js — the dashboard widget passes
  `{ actions: true }` for its inline Complete / Send Now / Pin buttons), shared with a new
  **`/search` page** in Per-sistant (`pages/search.js`: `?q=` prefilled and searched, the box
  focused on load and by "/", the URL following the query, a refused query's message shown).
  Per-sistant's sidebar has a Search entry, and Perfin's nav a labelled search icon to
  `/per-sistant/search` — under the shell only (a standalone Perfin has nothing to search).
- **Quiet hours and mutes for Per-sistant** (cycle-8 E3c, G2): Per-sistant's
  `GET /api/notifications/check` reads Perfin's `notify_quiet_hours` /
  `notify_muted_types` READ-ONLY through the wired `perfinPool`
  (`perfinNotifyPrefs`, null standalone or on a failure — then nothing is held)
  and marks every entry with its `kind` (`notify-prefs.kindOfCheckType`) and
  `notify` (false inside quiet hours or for a muted kind), plus a top-level
  `quiet`. The dashboard raises no browser notification for `notify: false`; the
  Reminders widget still lists every entry. Per-sistant's Settings links to
  Perfin's section under the shell. Since cycle-8 E3e each entry also names its
  `item` (a linked task's source_key without `perfin:`; housing_due's
  `housing:<month of its due date>`), and an item Perfin pushed in the last 12
  hours (`perfinPushedItems` — notification_log push_state sent, read-only) is
  `notify: false` — one interruption per item across the two apps.
- **Productivity context** (`GET /api/persistent/productivity-context`):
  task/review stats from Per-sistant (embedded fast-path queries Per-sistant's
  pool via `queryPersistentStats` / `queryPersistentReview`; HTTP fetch is the
  standalone fallback). Nothing in Perfin calls it today — the AI insights
  prompt does not include it (seams audit #3; an endpoint for external use).
- **Per-sistant's Perfin widget** (`GET /api/perfin/stats`): symmetric — the
  embedded fast-path queries Perfin's `detected_subscriptions` directly;
  HTTP fetch is the standalone fallback. The fallback now correctly
  unwraps Perfin's `{subscriptions, summary}` response shape (an earlier
  version assumed a bare array and crashed silently, so the widget always
  showed "not connected" in standalone Per-sistant deployments). Both paths
  compute the figures with `widgetFigures(subs, today)` (routes/perfin.js):
  monthly cost = Σ amount × 30 / cadence_days (Perfin's monthly-equivalent
  rule — it used to add a yearly charge at full price), upcoming = a
  `next_expected` from today (APP_TIMEZONE) through today + 7, so a charge due
  today counts (cycle-7 F80).

**Legacy two-services integration** (still in code as standalone fallback):
- **Cross-app SSO**: HMAC-signed token exchange (60s expiry, per-token nonce
  for replay protection). Format: `sso:<timestamp>:<nonce>:<signature>`.
  Required `SSO_SECRET` set on both apps. Unused under the unified shell.
- **Webhook system**: HMAC-signed event notifications. Perfin itself sends only
  the four email events and `test`; `POST /api/persistent/webhook/send` can send
  any event by hand (the receiver stores the email events and logs the rest).
  Under the shell the email events are in-process; the signing layer remains for
  the standalone fallback. Dispatch
  is refused (`{ sent: false, reason: "missing_secret" }`) when the shared
  secret isn't configured so misconfiguration surfaces immediately rather
  than being silently rejected at the receiver.

## Deployment

### Operator state to provide manually
Two pieces of secret state are NOT version-controlled and must be placed
on the operator's machine (or fed via env vars) before the app boots:

1. **Teller mTLS PEMs** — `certificate.pem` and `private_key.pem` at the
   repo root (or `TELLER_CERT_PATH` / `TELLER_KEY_PATH` env vars; or
   base64'd `TELLER_CERT` / `TELLER_KEY` env vars on Render). These
   files used to be checked in but were `git rm --cached`'d. The old
   committed copies remain in earlier git history (merge 08ff2ff) and
   should be **considered compromised** — rotate the cert in the Teller
   dashboard before relying on them, and treat scrubbing history
   (`git filter-repo` / BFG) as a one-time destructive action that needs
   to happen out-of-band. Until the rotation happens, `getTlsAgent()`
   (`teller/services/teller-api.js`) logs a loud `*** SECURITY WARNING ***`
   at cert load when the loaded cert's DER SHA-256 matches the
   known-compromised fingerprint from history — the warning disappearing
   is the signal that the rotation took effect. Since cycle-7 F14 the same
   check runs at boot (`tellerCertStatus()`) and shows as a Settings → Sync
   Health issue, so it no longer depends on reading logs at the first Teller call.
2. **`TOKEN_ENCRYPTION_PASSPHRASE`** — used by `pgp_sym_encrypt` to store
   Teller access tokens, Plaid access tokens, and the Per-sistant webhook
   HMAC secret. **Missing it is FATAL at boot** (`services/database.js`
   exits 1, same posture as a missing `NEON_DATABASE_URL`) — booting
   without it used to only warn and then surface later as scattered
   `decryption_failed` errors. For local debugging without any bank links,
   set `ALLOW_MISSING_TOKEN_PASSPHRASE=true` to downgrade the failure to
   the old warning. Rotating it invalidates all stored ciphertext; the
   remediation is to re-link affected institutions (Teller Connect re-run
   for Teller items, Plaid Link re-run for Plaid items). After a rotation
   mismatch, `POST /api/plaid/sync-holdings` will surface
   `errors: [{ institution, error: "decryption_failed" }]` per affected
   item rather than silently returning zero accounts. The Teller sync paths
   (`syncAllEnrollments` / `syncAllBalances`) do the same: a NULL decrypted
   token is reported as `decryption_failed` and the enrollment is skipped
   rather than 401-ing against Teller and being silently marked DISCONNECTED
   (which would wrongly demand a Teller Connect re-run on a mere passphrase
   mismatch). Every sync/balance/holdings/flows/unlink token read goes through
   `perfin_try_decrypt(data, key)` — a plpgsql wrapper created by the
   migrations that returns NULL where `pgp_sym_decrypt` would RAISE (cycle-7
   F17: one stale row used to fail the whole query, so every sync failed and
   the per-row `decryption_failed` branches never ran). The Teller unlink of a
   stale enrollment skips the Teller revoke and just deletes it locally.
3. **Per-sistant Knowledge / RAG operator state** (all optional — the feature
   degrades to keyword-only without them; nothing blocks app boot):
   - `VOYAGE_API_KEY` — Voyage embeddings for semantic retrieval. Without it
     (or without pgvector) the vault is still synced — documents + facts are
     ingested and keyword-searchable (KR-3); setting it later backfills the
     embeddings (≤200 documents per sync). Voyage 429/5xx are retried with
     backoff (KR-7). (`VOYAGE_MODEL` optional, default
     `voyage-3.5`; dimension 1024 is baked into `chunks.embedding vector(1024)`.)
   - `VAULT_GITHUB_TOKEN` — **read-only** fine-grained PAT for the private
     Obsidian-vault repo (sync/ingest). Repo + branch are set in Settings →
     Knowledge, not env.
   - `VAULT_GITHUB_WRITE_TOKEN` — **separate write-scoped** PAT (Contents
     read+write) used ONLY by capture-to-vault; capture returns 400 until set.
     Kept distinct from the read-only sync token (least privilege).
   - **pgvector** — verify `CREATE EXTENSION vector` succeeds on the Neon DB
     before relying on semantic search. The migration is defensive (degrades to
     keyword if the extension is unavailable) so it won't crash boot, but
     semantic retrieval needs the extension present (Neon supports it).
   - **`knowledge-reindex.yml` GitHub Action secrets** — `SERVER_URL` +
     `API_KEY` repo secrets so the scheduled reindex can reach
     `/per-sistant/api/rag/reindex` (via the shell's x-api-key path) while the
     Render free tier sleeps.
   - **After any deploy that changes vault frontmatter parsing or sync
     semantics, run ONE full reindex** (`POST /per-sistant/api/rag/reindex`, or
     let the Action fire). Such a deploy bumps `VAULT_PARSE_VERSION`
     (apps/per-sistant/services/vault-sync.js); a successful full sync stamps
     `user_settings.vault_parse_version`, and Settings → Sync Health → Operator
     Checks shows "Knowledge index" as a warning until it matches (cycle-7 ST4). Incremental syncs only re-read CHANGED files, so rows
     stored under the old rules (e.g. the pre-Sept-2026 fail-OPEN sensitivity
     parser, KR-2) keep their old classification until a full walk re-files
     them and sweeps deleted-file orphans (KR-1). Cycle-7 Batch 12 is such a deploy
     (F132: "--- " delimiters and repeated sensitivity / embed / private keys now
     resolve fail-closed), and so is cycle-8 Batch 6 (F49: a quoted key is read, and a
     line the parser can't read that starts with a privacy key resolves private —
     VAULT_PARSE_VERSION 3).
4. **`db-backup.yml` GitHub Action secrets** — `NEON_DATABASE_URL`,
   `PERSISTENT_DATABASE_URL` (optional), and `BACKUP_ENCRYPTION_PASSPHRASE`
   repo secrets for the nightly encrypted backup workflow (pg_dump of both
   DBs → gpg symmetric AES-256 `.dump.gpg` artifacts, 90-day retention; runs
   from GitHub's runners so it works while Render sleeps). **Not set as of Oct
   2026 — no backup has ever been taken (F3); the workflow's FIRST step now
   names any missing secret.** Each backup is VERIFIED in the run (the
   encrypted file is decrypted and its archive read with `pg_restore --list`);
   gpg's integrity check makes a damaged or altered file fail to decrypt.
   Restore with `gpg --decrypt --output perfin.dump perfin-YYYY-MM-DD.dump.gpg`
   then `pg_restore` (runbook in the workflow header). Keep a copy of the
   backup passphrase OUTSIDE GitHub — the artifacts are unreadable without it.
   Do one restore drill into a throwaway Neon branch before you need it for real.
   Since cycle-8 E4a its last step records the backup in the database
   (`user_settings.last_backup_at`, `last_backup_source = 'github'`) — so
   `NEON_DATABASE_URL` must be a role that can UPDATE `user_settings` (the app's own
   connection string can); a failed stamp is a warning line, and Operator Checks then
   keeps reporting no backup.
5. **Scheduled workflows stay enabled** — GitHub disables a PUBLIC repo's
   scheduled workflows after 60 days without repository activity (F4: Database
   Backup, Weekly Reconcile, Keep Alive and Job Radar Refresh were all
   `disabled_inactivity` in Oct 2026). Re-enable each under Actions → the
   workflow → "Enable workflow"; making the repo private stops the auto-disable.
   With `GITHUB_OPS_TOKEN` set (item 6) Settings → Sync Health → Operator Checks
   shows a disabled or failing backstop and a missing backup (cycle-7 G1).
6. **GitHub ops token** (optional, cycle-7 G1 / ST4) — a fine-grained GitHub token
   for this repository with READ-ONLY Actions, Metadata and Secrets permissions, set
   as `GITHUB_OPS_TOKEN` with `GITHUB_OPS_REPO` = `owner/repo` on Render. The app
   reads workflow state and runs, the last successful backup, secret NAMES (never
   values) and repo visibility; the token is never stored, logged or returned.
   Without it the GitHub checks read "off" (one info line in Sync Health); the
   backup check then reads the stamp db-backup.yml / backup.sh records instead
   (local:backup, cycle-8 E4a), and the go-live checks need no token at all.

Both the **weekly digest** (Settings → AI Insights → "Weekly Digest
Email") and the **daily activity digest** ("Daily Activity Digest"
toggle) are delivered IN-PROCESS under the unified shell (no webhook
config needed — the email lands in Per-sistant's `emails` table for
`perfin_webhook_recipient` → `SMTP_FROM` → `SMTP_USER`; with no valid
address it is saved as a draft and reported NOT sent, cycle-7 F79). A
STANDALONE Perfin needs `persistent_url` and a webhook secret; without
them `sendPerSistantWebhook` short-circuits with
`{ sent: false, reason: "not_configured" | "missing_secret" }` and the
digests are a no-op. There is no Settings section for that standalone
config (F81) — set `persistent_url` / `persistent_webhook_secret` /
`persistent_webhook_enabled` via `PATCH /api/settings`. (An earlier
version of this note pointed at a "Settings → Integrations" section that
doesn't exist — cycle-7 F44.)

**Plaid** (optional — for banks Teller doesn't cover): create a Plaid
account at dashboard.plaid.com. New accounts after April 2026 get the
**Trial Plan** (10 free Production Items — enough for personal use).
Set `PLAID_CLIENT_ID`, `PLAID_SECRET_PROD`, and `PLAID_ENV=production`
in the Render dashboard. The old Development environment was
decommissioned June 2024; Trial Plan replaced it. Access tokens never
expire; re-auth only needed if the user changes their bank password.

**Gotcha — Plaid Liabilities coverage is issuer-dependent.** Some issuers
(observed with **Discover**) do NOT return APR or `balances.limit` through
Plaid's Liabilities product even after a fresh re-link with Liabilities
requested — so APR stays blank and utilization shows "—". A re-link will NOT
fix this (and burns a precious Trial-Plan Item), so do NOT recommend re-linking
to chase APR/limit. Instead use the **manual credit-limit + APR fields** on the
dashboard credit card (limit → `PATCH /api/accounts/:id/balance { credit_limit }`,
APR → `PATCH /api/accounts/:id { apr }`), which drive real utilization with no
Plaid dependency. `syncAllPlaidBalances` surfaces an actionable
message ("this connection predates Plaid Liabilities; unlink it and link the bank
again …") ONLY when the item lacks the Liabilities product entirely
(PRODUCTS_NOT_SUPPORTED) AND carries a credit account — it stays silent when
Liabilities is present but the issuer simply returns no APR/limit data, which is
the un-fixable Discover case. `liabilitiesGet` is called only for an Item with a
credit card or loan; `NO_LIABILITY_ACCOUNTS` is a quiet skip and
`ADDITIONAL_CONSENT_REQUIRED` joins the not-supported skip; APR / minimum / last
payment use `??`, so a 0% APR is stored as 0, not NULL (cycle-7 F28).

**Gotcha — a Plaid "needs re-authentication" item is fixed with RE-AUTHENTICATE,
not by linking again.** Running the link flow for an already-linked bank creates
a NEW Item (new item_id, account_ids and transaction_ids), so it would double
every transaction and use a second Trial-plan slot — the exchange routes therefore
REFUSE it (cycle-7 F18: `findDuplicatePlaidItem` — same institution + an account
with the same mask and type on another GOOD item; the investments-only exchange
also checks `findDuplicateInvestmentItem` — an active Plaid investment account at
the same institution name with the same mask + type, G3 → the new Item is released
at Plaid, nothing is stored, 409 pointing to Re-authenticate / Add accounts). To
recover an item flagged via `last_error_code` (Sync Health: "N Plaid item(s) need
re-authentication — open Accounts → Re-authenticate", which links there): press
**Re-authenticate** on the Accounts page (Plaid Link update mode, G3 — same Item,
transactions and edits kept); **Add accounts** does the same for a new card at a
connected login. Only an item whose token no longer decrypts (a changed
TOKEN_ENCRYPTION_PASSPHRASE — 409 `decryption_failed`) still needs unlink + link.
CSV imports never count toward that warning. Update mode opens the in-page Link
on a desktop browser and Plaid's hosted page on iOS / iPadOS, the home-screen app
and the Capacitor wrapper (roadmap T2.5 H1). Hosted Link's update-mode support was
read from the Plaid SDK's types and Plaid's glossary — plaid.com's docs weren't
reachable from the build environment — so try Re-authenticate once on an iPhone
before relying on it.

**Gotcha — Plaid Liabilities never covers auto loans (any issuer).** The
product supports only credit cards, student loans, and mortgages, so an auto
loan's APR/term/payment will NEVER arrive from Plaid — do not chase it with a
re-link. The loan's balance DOES sync via plain accountsGet. APR and monthly
payment are manual fields on the dashboard loan card (`PATCH /api/accounts/:id
{ apr, monthly_payment }`), which drive the payoff projection.

### Render (Free, recommended — currently deployed)
1. Connect GitHub repo in Render dashboard
2. Create Web Service from `render.yaml` blueprint
3. Build/start commands (the YAML defaults are correct under the unified shell):
   - **Build**: `npm install` (workspace-aware install at the root; walks
     shell/, teller/, apps/per-sistant/ in one pass)
   - **Start**: `npm start` → `node shell/index.js`
4. Provide the Teller mTLS cert via env vars:
   - `TELLER_CERT` = `base64 < certificate.pem`
   - `TELLER_KEY`  = `base64 < private_key.pem`
   *(Alternative: Render Secret Files + `TELLER_CERT_PATH` / `TELLER_KEY_PATH` env vars.)*
5. Set the unified-shell env vars (`SHELL_PIN`, `SHELL_SECRET`,
   `PERSISTENT_DATABASE_URL`) plus the existing Perfin/Per-sistant ones
   (see Environment Variables below)
6. Access at `https://pers-fin-tracker.onrender.com` — lands on the PIN
   page, then Per-sistant (the tile picker, with a status line per tile, is at `/`)

### Fly.io (~$2/mo)
```bash
fly launch --name pers-fin-tracker
fly secrets set SHELL_PIN="1234" SHELL_SECRET="$(openssl rand -hex 32)"
fly secrets set NEON_DATABASE_URL="postgres://..." \
                PERSISTENT_DATABASE_URL="postgres://..." \
                TOKEN_ENCRYPTION_PASSPHRASE="..."
fly secrets set TELLER_APPLICATION_ID="app_pplg2et45b7bl1scna000" TELLER_ENV="development"
fly secrets set TELLER_CERT=$(base64 < certificate.pem) TELLER_KEY=$(base64 < private_key.pem)
fly deploy
```

### Local
```bash
npm install            # walks all three workspaces
npm start              # boots the unified shell (node shell/index.js)
# Open http://localhost:3000 → PIN → Per-sistant (the tile picker is at /)

# Standalone debug (skip the shell entirely):
npm run start:perfin       # node teller/server.js
npm run start:persistent   # node apps/per-sistant/server.js
```

## Current Status
- Deployed on Render (free tier, sleeps after 15 min idle) — single service
  hosting both apps via `node shell/index.js`
- Render deploys from `main`
- Env vars configured in Render dashboard, including `SHELL_PIN`,
  `SHELL_SECRET`, `PERSISTENT_DATABASE_URL`
- Teller mTLS cert provided via base64 env vars (`TELLER_CERT` / `TELLER_KEY`)
- Teller Application ID: `app_pplg2et45b7bl1scna000`
- 3109 tests passing across 170 test files (Perfin 2369 + Per-sistant 740), plus the real-Postgres route contract suite (325 tests; CI `migrations` job, `npm run test:contract`) and 74 Playwright browser tests (CI `e2e` job — smoke.spec.js + the seeded every-page pages.spec.js with its click sweep); neither of the last two is in `npm test`
- AI runs on the Claude 5.5 models (Perfin haiku/sonnet/opus tiers → `claude-haiku-5-5` / `claude-sonnet-5-5` / `claude-opus-5-5`; Per-sistant haiku/sonnet → `claude-haiku-5-5` / `claude-sonnet-5-5`)

## Commands
```bash
cd teller && npm install && node server.js    # Run locally
npm install                                    # ALSO required at repo root for tests
npm test                                       # Run all tests (Perfin + Per-sistant)
npm run test:e2e                               # Playwright browser smokes + every-page load check (needs local Postgres; see e2e/boot-server.js)
PW_CHROMIUM_PATH=/opt/pw-browsers/chromium npm run test:e2e  # the same with a preinstalled Chromium (a cloud container, where the pinned build isn't installed)
npm run test:perfin                            # Perfin tests only (tests/*.test.js)
npm run test:persistent                        # Per-sistant tests only
CONTRACT_DATABASE_URL=postgres://… npm run test:contract  # real-Postgres route contract suite (tests/contract/; skips without the URL; creates/drops contract_* scratch DBs)
npm run reset:fresh                            # DRY RUN: print what a fresh-start reset would wipe/keep
npm run reset:fresh -- --yes                   # perform the reset (wipes data+config, keeps bank links)

# Key API endpoints
POST /api/enroll           # store Teller access token after Connect
POST /api/webhooks/plaid   # Plaid webhooks (roadmap T2.1): verified by the
                           # Plaid-Verification JWT; 503 without Plaid credentials;
                           # past the shell gate (self-authenticating). Recorded in
                           # webhook_events; SYNC_UPDATES_AVAILABLE syncs that item
                           # (W3); ITEM / HOLDINGS / INVESTMENTS_TRANSACTIONS events
                           # (W4 — see plaid-webhook-events.js). Plaid calls it only
                           # once PUBLIC_URL is set and the Item carries the URL
POST /api/plaid/webhooks/register # point every connected Plaid Item (GOOD plaid_items +
                           # investments-only) at this app's webhook URL via
                           # itemWebhookUpdate; records webhook_url on success →
                           # { ok, url, registered, failed, errors?[{institution,
                           # error: code}] } (Plaid error CODE only; an undecryptable
                           # token is decryption_failed, never sent). 400 without
                           # PUBLIC_URL, 501 without Plaid (roadmap T2.1 W4)
POST /api/webhooks/teller  # Teller webhooks: Teller-Signature HMAC with
                           # TELLER_WEBHOOK_SECRET; 503 without it. transactions.processed
                           # syncs the enrollment it names; enrollment.disconnected
                           # marks it DISCONNECTED + one notification; webhook.test
                           # 'done' (W5 — teller-webhook-events.js)
POST /api/sync             # pull transactions from Teller AND Plaid via
                           # syncAllTransactions (BSI-2): Teller, then Plaid
                           # (each failure-isolated), then ONE anomaly check over
                           # the combined added count (DD-1). Response keeps the
                           # legacy keys — { enrollments_synced, transactions_added
                           # (combined), errors?[{provider, institution, error}],
                           # teller, plaid }. 500 only when nothing synced (Teller
                           # threw and Plaid didn't succeed) so daily-sync.yml goes
                           # red. Stamps last_txn_sync_at; records teller_txn +
                           # plaid_txn in last_sync_result. Body background:true
                           # (cycle-7 ST1) → 202 { started, running, kind, id,
                           # started_at } and the run continues detached (409 with
                           # the running job's id while one runs); poll GET
                           # /api/sync/status?kind=sync. A POST during a run joins
                           # it (one sync, one record).
DELETE /api/items/:id      # unlink a Plaid item (BSI-3): best-effort itemRemove at
                           # Plaid (frees a Trial slot; skipped for CSV virtual
                           # items; token decrypt fail-soft), then in one txn delete
                           # its transactions + linked_accounts + plaid_investment_items
                           # registry row, deactivate its investment_accounts and
                           # delete their holdings. Returns plaid_item_removed.
GET  /api/items            # linked Teller enrollments + Plaid items; investments-only
                           # Plaid items (plaid_investment_items registry rows with no
                           # plaid_items twin) are listed as provider 'plaid_investment'
                           # with accounts: [] (cycle-7 F22); each row carries
                           # last_error_code (NULL for Teller / investments-only — G3)
DELETE /api/plaid/investment-items/:id # unlink an investments-only Plaid item: itemRemove
                           # at Plaid (fail-soft), deactivate its investment_accounts,
                           # drop their holdings, delete the registry row (F22)
POST /api/sync-balances    # (body background:true → 202 + job id, kind
                           # sync-balances — ST1; same rules as /api/sync)
                           # fetch latest account balances. Refreshes Teller
                           # (`syncAllBalances`), Plaid balances + credit limit
                           # + liabilities/APR (`syncAllPlaidBalances`), AND
                           # Plaid investment holdings (`syncAllPlaidHoldings`)
                           # in one call — no transactionsSync rerun.
                           # Response: { accounts_updated, accounts_changed,
                           # errors?, plaid_accounts_updated, plaid_errors?,
                           # holdings_updated, holdings_accounts_updated,
                           # holdings_errors?, flows_added, flows_errors? }.
                           # Also re-pulls investment cash flows
                           # (syncAllPlaidInvestmentFlows) for TWR/XIRR. plaid_errors now also carries
                           # surfaced liabilities failures ("liabilities: <code>")
                           # so a card whose APR/limit won't load is visible.
POST /api/detect           # run subscription detection, then the watchdog
                           # (response: { detected_count, subscriptions,
                           # watchdog: { still_charging, price_rises } } — G5)
POST /api/sync/reconcile   # backfill/reconcile to recover dropped transactions
                           # (body: days=1-365 default 90, provider=teller|plaid|all,
                           # background?=bool). Teller re-fetches the trailing window
                           # watermark-independently (idempotent upserts, no watermark
                           # advance, anomaly push suppressed); Plaid resets each
                           # item's cursor and re-walks transactionsSync. Stamps
                           # last_reconcile_at. SYNCHRONOUS by default — returns
                           # { days, provider, teller?, plaid? } per-provider
                           # summaries inline (the contract API/CLI callers rely on).
                           # With background:true the work runs detached: returns 202
                           # { started, running, kind, id, started_at, provider,
                           # days } immediately and
                           # pushes a "Reconcile complete" notification on finish
                           # (409 if one is already running — synchronous OR background,
                           # and the weekly in-process heal skips while one runs: one
                           # reconcile at a time, seams audit #3; a 409 for a run that
                           # isn't a background job carries id null). The Sync Health UI uses
                           # background mode + polling since the Plaid leg re-walks up
                           # to 2 years of history and can take a minute.
GET  /api/sync/status      # a background job slot (cycle-7 ST1; query kind=
                           # sync|sync-balances|reconcile, default sync; 400 otherwise):
                           # { kind, id, running, phase, started_at, finished_at,
                           # result, error }. error is a FIXED sentence ("Nothing synced:
                           # the Teller sync failed and Plaid did not succeed." …), never
                           # an exception message (the reconcile slot too since seams
                           # audit #3: "N item(s) failed — see Settings → Sync Health.",
                           # errors[] names provider + institution only); an idle slot
                           # has id null. In memory — a restart empties it (pollers
                           # compare the id they were given)
GET  /api/sync/reconcile/status # poll the background reconcile job (the same slot as
                           # /api/sync/status?kind=reconcile)
                           # { running, started_at, finished_at, provider, days,
                           #   result, error, errors[] } — error also summarizes
                           # per-item errors inside a leg (reconcileErrors, WD-17), so
                           # Settings + the push say "finished with errors" for them
POST /api/detect-transfers # run recurring transfer detection
GET  /api/recurring-transfers # list recurring transfers (query: filter=active|dismissed|all)
PATCH /api/recurring-transfers/:id/dismiss   # dismiss a recurring transfer
PATCH /api/recurring-transfers/:id/undismiss # restore a dismissed transfer
PATCH /api/recurring-transfers/:id/type      # reclassify transfer type
PATCH /api/recurring-transfers/:id/forecast  # { treatment: auto | bill | internal | ignore } —
                           # how the cash-flow forecast treats it (cycle-8 E1a); 400 on a
                           # malformed id / value before any query, 404 unknown, 400 for an
                           # INCOMING transfer (only outgoing ones are billed — E1 follow-on);
                           # then cash-alerts invalidate()
PATCH /api/subscriptions/:id/forecast # { ignore: true | false } (strict boolean) — leave a
                           # subscription out of the forecast (E1a); same rules
GET  /api/transactions     # list transactions (query: months, limit, offset)
GET  /api/transactions/search # search/filter (query: q, category, account_id, min/max_amount, start/end_date);
                           # q is matched literally (LIKE \ % _ escaped) and a non-date
                           # start/end_date is a 400 (cycle-7 F57)
GET  /api/transactions/duplicates # find candidate duplicate transactions across accounts
GET  /api/transactions/csv-overlap         # CSV virtual accounts whose transactions
                                           # overlap with Plaid/Teller-synced accounts
                                           # (same amount, date ±2 days, similar merchant,
                                           # paired one-to-one — F21; ≥3 pairs).
                                           # CSV accounts = linked_accounts under a
                                           # plaid_items row with status='CSV' (NOT
                                           # is_manual — DC-5: CSV accounts are never
                                           # manual, so the old filter found nothing);
                                           # counts/sums the paired CSV rows.
                                           # Common after linking a previously
                                           # CSV-only bank via Plaid — historical
                                           # CSV rows + 2yr Plaid history double-count.
POST /api/transactions/csv-overlap/resolve # delete CSV-side rows paired one-to-one with a
                                           # Plaid/Teller row (body: csv_account_id,
                                           # synced_account_id, dry_run?). Keeps the
                                           # synced account as canonical going forward.
                                           # 400s unless csv_account_id is a status='CSV'
                                           # account (a manual cash account can't have
                                           # its hand entries deleted) and the synced
                                           # side is Teller or a non-CSV Plaid item.
                                           # The deleted rows are tombstoned with a
                                           # snapshot in the same transaction (cycle-8 F4),
                                           # all with one batch_id, returned as { deleted,
                                           # batch_id } (cycle-8 E1c)
PATCH /api/transactions/:id # user overrides: merchant_name, notes, is_reimbursed
                            # (Phase B1/B2), personal_for ('self'|'partner'|null —
                            # shared-card settlement override; invalid values
                            # silently coerced to NULL). A merchant_name edit clears
                            # user_merchant_rule_id; with apply_to_all: true it also
                            # creates an exact rename rule on the row's raw merchant
                            # and returns rename_rule / rename_rule_error / renamed /
                            # rekeyed (400 without a merchant_name — ST2)
POST /api/transactions/manual # add a one-off manual EXPENSE (e.g. cash spending
                            # bank sync never sees). Body: account_id (an existing
                            # is_manual account — 400 otherwise), amount (>0), date (YYYY-MM-DD),
                            # merchant_name?, category?, notes?. A date that isn't a
                            # real calendar date ("2026-13-45") is a 400 (F57). Stores amount
                            # POSITIVE (the spending sign), a unique manual_<ts>_<rand>
                            # transaction_id (never touched by re-sync), notes→user_notes.
DELETE /api/transactions/:id # delete a single transaction (deduplication tool); the id is
                            # recorded in deleted_transactions so a Teller/Plaid re-fetch
                            # or CSV re-import can't re-insert it (F20), with the row + its
                            # splits as a snapshot and its source (T2.5 U1)
GET  /api/deleted-transactions # deleted transactions, newest first (query: limit 1-200
                            # default 50, before = the previous page's `next`) →
                            # { items: [{ transaction_id, deleted_at, source, legacy,
                            # restorable, date, merchant, amount, account_name,
                            # splits_count, batch_id }], next, batches: [{ batch_id, count,
                            # deleted_at, restorable }] } — every Resolve batch still holding a
                            # row (restorable: not bank-removed, its account still linked),
                            # newest first, ≤20 (cycle-8 E1c) (roadmap T2.5 U1; Settings →
                            # Sync Health → Deleted transactions, U2)
POST /api/deleted-transactions/:id/restore # put it back from its snapshot and lift the
                            # tombstone, one transaction → { restored: true,
                            # already_present, splits }; 404 unknown; 409 when its account
                            # is gone; a pre-U1 tombstone → { restored: false, cleared,
                            # returns_on: reconcile | csv_reimport } (a manual one 409s);
                            # a Plaid id the bank removed since → 409 { reason:
                            # "removed_by_bank" }; one it changed → stale: true (cycle-8 F6);
                            # the Settings Restore button and the Activity toast's Undo (U2)
POST /api/deleted-transactions/batches/:batch_id/restore # undo a whole CSV-overlap Resolve
                            # (cycle-8 E1c): each row through the same restore, in ONE
                            # transaction → { batch_id, restored, already_present, splits,
                            # stale?, cleared? (a pre-U1 tombstone lifted, not restored),
                            # skipped: [{ transaction_id, reason removed_by_bank | account_gone |
                            # unrestorable | not_found, error }] } (a refused row stays deleted);
                            # 400 malformed id, 404 nothing left; Settings' "Restore all N"
GET  /api/transactions/:id/splits # list splits for a transaction (Phase B3)
POST /api/transactions/:id/splits # replace splits, validates sum matches parent ±$0.01
DELETE /api/transactions/:id/splits # clear all splits, revert to parent-row aggregation
GET  /api/forecast         # 7-90 day projection of recurring subscription charges
                           # (calendar-month stepping from the last charge, DC-9;
                           # includes a charge due today, days_away 0)
GET  /api/bill-calendar    # monthly calendar of expected charges + recurring income (query: year, month
                           # — defaults are the APP_TIMEZONE month; a month outside 1-12 or a
                           # year outside 1900-2999 is a 400, F57)
                           # — income projected per stream cadence (DC-10)
GET  /api/manual-bills     # list all active manual bills
POST /api/manual-bills     # create a manual bill (body: name, amount, due_day, cadence, category)
PATCH /api/manual-bills/:id # update a manual bill (400 on a non-numeric/≤0 amount
                            # or a due_day outside 1-31 — DC-15)
DELETE /api/manual-bills/:id # delete a manual bill
GET  /api/bill-payments    # list payments for a month (query: year, month — same validation
                           # and APP_TIMEZONE default as bill-calendar, F57)
POST /api/bill-payments    # mark a bill as paid (body: bill_source, bill_id, paid_date,
                           # paid_amount? — defaults to the bill's amount, SXE-11)
DELETE /api/bill-payments/:id # unmark a bill payment
GET  /api/housing/config   # rent/utilities ledger config (payee, rent, due day, utilities)
PATCH /api/housing/config  # replace config (validated/normalized; 400 if enabling w/o payee)
GET  /api/housing/ledger   # balance owed + obligations + payment history (with covered months),
                           # scoped to the configured payee (FAN-4)
POST /api/housing/generate # generate current/missing months' obligations from config (idempotent)
POST /api/housing/obligations # add an ad-hoc obligation (body: label, period, amount?, category?, due_day?)
PATCH /api/housing/obligations/:id # set amount (bill arrived → unpaid), notes, due_day, label
DELETE /api/housing/obligations/:id # remove an obligation; an auto-generated one is
                           # recorded in payee_obligation_skips so generation doesn't
                           # recreate it (F33) → { ok, skipped_from_generation }
POST /api/housing/payments # settle a batch of unpaid obligations (body: obligation_ids[],
                           # paid_date?, amount? (default=sum), memo? (default=derived)); marks paid
DELETE /api/housing/payments/:id # undo a payment, reverting its obligations to unpaid/pending_amount
GET  /api/housing/export   # landlord-ready record of a year's payments (query: year,
                           # format=csv|pdf|json) — memos + covered months + total (pdfkit PDF)
GET  /api/housing/split    # partner "even-up" for a month (query: month=YYYY-MM): what you
                           # send the partner = (rent+utilities − car)/2 so each bears half.
                           # Car pulled from a Perfin loan's monthly_payment or a fixed amount.
                           # Returns { enabled, transfer, direction, each_share, car_source,
                           # double_count_warning, awaiting_count, awaiting_labels }.
                           # Payee-scoped. double_count_warning (or null) flags
                           # shared-card charges that month matching the payee name /
                           # utility merchant_patterns (word-boundary, fail-soft);
                           # awaiting_* = the month's utilities still pending their bill
                           # (FAN-9 — the widget holds "Mark settled" until entered).
POST /api/housing/scan-bill # OCR a utility-bill image/PDF via Claude vision → SUGGEST
                           # { amount, period, label } WITHOUT writing (user confirms +
                           # PATCHes). Shares the AI cap (entry_type='scan'); 501 w/o
                           # ANTHROPIC_API_KEY, 429 past the cap. Image discarded, not stored.
GET  /api/csv-reminder     # list manual accounts overdue for a CSV refresh
GET  /api/subscriptions    # list detected subscriptions
GET  /api/accounts         # list linked accounts with balances (includes is_shared, spending_split_pct)
PATCH /api/accounts/:id    # update account details (apr 0-99.99; monthly_payment > 0
                           # or null — the manual loan fields driving the payoff projection;
                           # low_balance_floor 0-1e7 or null — the cash alerts' per-account
                           # floor, cents-rounded; a non-null floor on an account that isn't
                           # depository + non-investment is a 400, T2.2 L4)
PATCH /api/accounts/:id/shared # mark account as shared/joint (body: is_shared, spending_split_pct
                           # — an integer 0-100, 400 otherwise; 0 = all the partner's.
                           # `parseInt(x) || 100` used to turn 0 into 100 — WUI-6)
PATCH /api/accounts/:id/balance # update balance fields (current_balance, available_balance, credit_limit)
                           # — strict finite parse ("$1,250.50" accepted), 400 otherwise;
                           # null only for available_balance / credit_limit; a negative
                           # limit is a 400 (cycle-7 F29 — it used to store NaN; the
                           # investment-account PATCH validates its balance the same way)
POST /api/accounts/manual  # create a manual (non-Teller, non-Plaid) account
                           # (type: depository | credit | loan — loan subtype defaults 'auto')
DELETE /api/accounts/manual/:id # delete a manual account
GET  /api/shared-settlement # who-owes-who on shared cards for a given month
                            # (query: month=YYYY-MM, account_id?). Returns per-
                            # account { total_charges, shared_total, your/partner
                            # personal totals + counts, your_share, partner_share }
                            # plus the user's configured partner_name. Charges are
                            # NET of same-month refunds (non-transfer credits) and
                            # exclude pending (FAN-12); each account also carries
                            # refunds_total and account_key (linked_accounts.account_id,
                            # for the Activity-page deep link).
GET  /api/shared-settlement/:account_id/transactions # flat list of every charge on a
                            # shared account in the given month with each row's
                            # personal_for state, for reconciliation.
GET  /api/settlement       # whether a month is marked squared with the partner
                            # (query: month=YYYY-MM) → { period, settled, net_amount?,
                            # direction?, note?, settled_at? }. Backs the Settle Up
                            # widget's "Mark settled" state.
POST /api/settlement/settle # mark a month squared (upsert by period; body: month,
                            # net_amount, direction, note?). Records the client-computed
                            # combined net at settle time.
DELETE /api/settlement/:period # undo a month's settlement (period=YYYY-MM)
GET  /api/spending-summary # monthly trends, categories, top merchants (split-adjusted,
                           # net of refunds floored at $0 per month + category — F35;
                           # txn_count / avg_transaction describe the charges).
                           # monthly_trend uses WHOLE months (months=6 → 6 buckets
                           # incl. the current month-to-date); avg_monthly_spend /
                           # avg_daily_spend / avg_months are over COMPLETED months
                           # only, with real month lengths (FAN-6) — the dashboard
                           # "Avg Monthly"/"Avg Daily" cards read these. by_category
                           # and top_merchants use the SAME whole months (cycle-7
                           # F41 — they were a rolling UTC `CURRENT_DATE − N months`).
GET  /api/spending-categories # per-month category breakdown (query: month=YYYY-MM;
                           # splits/reimbursed/share-adjusted via getCategorySpendingForMonth)
GET  /api/cash-flow        # rolling cash flow projection (query: days 30-180, default 90);
                           # income from getLiveIncomeStreams (the bill calendar's
                           # streams — F34). services/cash-flow.js (T2.2 L1); starts
                           # the day after the APP_TIMEZONE date; adds lowest_balance /
                           # lowest_balance_date (the lowest projected day) and
                           # forecast_items { bills[], left_out[] } (cycle-8 E1a)
GET  /api/savings-rate     # income vs spending analysis (query: months, default 3)
GET  /api/income-summary   # income trend + top sources + by_account (query: months, default 6).
                           # Window anchored on the APP_TIMEZONE month; avg_monthly_income
                           # averages COMPLETED months only (FAN-13); top sources group
                           # by the display name, a rename wins (cycle-8 F54 — also the
                           # Sheets Income tab)
GET  /api/spending-yoy     # year-over-year comparison (query: month, year; defaults =
                           # the APP_TIMEZONE date). The current month is capped at
                           # today's day for every year (through_day; null = whole
                           # month); comparisons only between consecutive years (DD-11);
                           # refunds net per (year, category), floored at $0 (F35)
GET  /api/accounts/:id/balance-history # daily balance series for an account (query: source=linked|investment, months)
GET  /api/goals            # list financial goals with projections; each goal includes
                           # `suggested_transfers[]` matching active recurring transfers
                           # whose type aligns with the funding source and whose monthly
                           # amount is within ±25% of monthly_contribution (current_amount is
                           # derived from the funding account when one is linked).
                           # Response also carries `funding_status` (linked|orphaned|none)
                           # and `current_amount_manual` — when the FK is set but the
                           # account is gone (orphaned), current_amount falls back to
                           # current_amount_manual so pre-link progress is preserved.
GET  /api/goals/funding-options # depository + investment accounts a goal can link to (Phase C).
                           # A linked_accounts brokerage that is also an active
                           # investment_accounts row (the $0 Plaid phantom) is left out —
                           # the getNetWorth dedupe (WD-10). The Goals page shows an
                           # orphaned funding link as a warning, not "Auto-tracked".
GET  /api/fire-projection  # FIRE number/progress/time-to-FIRE + spending runway.
                           # Inputs: getNetWorth + trailing COMPLETED months'
                           # income/spending averages (partial month excluded) +
                           # fire_* assumption settings (real return % default 5,
                           # withdrawal rate % default 4, optional monthly-spending
                           # override). Goals page card with inline assumptions +
                           # 40-yr projection SVG. Math: services/projections.js.
POST /api/ask              # NL finance Q&A (body: { question, <=500 chars }).
                           # 501 without ANTHROPIC_API_KEY; 429 past the shared
                           # monthly AI cap; charges the cap (entry_type='ask').
POST /api/goals            # create a financial goal
GET  /api/investment-accounts # list manual investment accounts (manual + Plaid-synced rows in investment_accounts)
POST /api/investment-accounts # add manual investment account
GET  /api/investments         # unified investment list across Teller-linked + Plaid + manual sources
                              # (returns total_value, by_source totals, accounts[] with source/supports_holdings flags)
GET  /api/net-worth/history # net worth snapshots over time
GET  /api/context-export   # structured data dump for Claude chat (query: format=
                           # markdown|json). Latest REAL insight, investment_accounts
                           # included, no Plaid phantom, debts as "-$X owed" (JSON:
                           # is_liability), ISO dates (SXE-9)
GET  /api/tax-deductions   # accumulated tax-deductible transactions
GET  /api/settings         # retrieve user settings (+ notify_kinds — the notification
                           # kind catalog — and notify_timezone, cycle-8 E3a)
PATCH /api/settings        # update user settings. Accepts: theme,
                           # dashboard_months, insights_*, keep_alive_*,
                           # zip_code, partner_name (shared-card settlement
                           # widget display name, max 50 chars),
                           # pyramid_*, debt_baseline_amount,
                           # shell_idle_timeout_minutes, target_allocation_pct,
                           # weekly/daily digest toggles,
                           # fire_expected_return_pct (0-20),
                           # fire_withdrawal_rate_pct (1-10),
                           # fire_monthly_spending_override (>=0 or null),
                           # ai_monthly_budget_cents (1-10000 cents or null
                           # to fall back to env), insight_emails_enabled
                           # (a strict boolean — F81), cash_alert_enabled
                           # (strict boolean), cash_alert_threshold (0-1e7,
                           # "" / null refused), cash_alert_horizon_days
                           # (integer 7-60) — T2.2 L2, payday_alerts_enabled
                           # (strict boolean; switching on moves
                           # last_income_alert_at to now and, since cycle-8
                           # E2c, last_income_alert_txn_id to the newest id) — T2.2 L3,
                           # advice_alerts_enabled (strict boolean;
                           # switching on clears advice_state, so the
                           # first check is a fresh baseline) — T4.1 A4,
                           # contribution_limits (an object of "investment:<id>" /
                           # "linked:<id>" → dollars 0-1,000,000, cents-rounded,
                           # replacing the whole map; null clears) — T4.1 A10,
                           # linked_tasks_enabled (strict boolean),
                           # linked_tasks_sources (an object of still_charging /
                           # housing / utility_amount / bills / tax_documents →
                           # booleans, merged over the stored map; GET shows the
                           # stored map over the defaults), linked_tasks_bill_lead_days (integer
                           # 0-14) — T2.4 X2a, notify_quiet_hours ({ enabled
                           # strict boolean, start / end "HH:MM", start ≠ end, no
                           # other keys; null → off 22:00-07:00) and
                           # notify_muted_types (known MUTABLE kind keys, deduped;
                           # null → []) — cycle-8 E3a, etc.
POST /api/linked-tasks/run # run the linked-task sync now (Settings → Per-sistant Tasks
                           # "Run now", T2.4 X2c) → { status ok|partial, at, desired,
                           # created, updated, closed, reopened, skipped, errors[{kind,
                           # error}] } (also stored as linked_tasks_state). 501 standalone
                           # (no Per-sistant pool), 409 while a run is going, 400 while
                           # linked_tasks_enabled is off; errors are fixed sentences
GET  /api/tax/documents    # the tax documents checklist for a year (query: year — an
                           # integer 2000..this year, else 400) → { year, forms,
                           # documents: [{ id, tax_year, form, issuer, expected_by,
                           # received_at, dismissed_at, origin suggested|manual, notes,
                           # state received|dismissed|overdue|waiting }] } (T3.3 K2)
POST /api/tax/documents    # add a form by hand (body: year, form, issuer?, expected_by?
                           # — default the usual deadline, notes?) → 201; 409 when that
                           # form + issuer (any case) is already listed
PATCH /api/tax/documents/:id # received / dismissed (strict booleans — received stamps
                           # today's APP_TIMEZONE date), notes (≤1000 or null),
                           # expected_by (a date or null); 400 / 404
DELETE /api/tax/documents/:id # a manual row only; a suggested one is a 409 { reason:
                           # "suggested" } — dismiss it so it isn't suggested again
POST /api/tax/documents/suggest # add the forms the year's data points to (query or body
                           # year) → { year, added, suggestions[{ form, issuer,
                           # expected_by, reason }], errors[{ source, error }],
                           # documents } — ON CONFLICT DO NOTHING, never changing an
                           # existing row; no AI
GET  /api/tax/package      # the year-end tax package (T3.3 K3; query: year — the same
                           # rule, 400 otherwise; format json (default) | pdf | zip,
                           # 400 otherwise) → json: { year, generated_on, disclaimer,
                           # overview { …totals, sections_failed[] }, income,
                           # investment_income, realized_gains, retirement, deductions,
                           # rent_paid, documents (each { ok: true, … } or { ok: false,
                           # error: <fixed sentence> }), notes[] }; pdf / zip as
                           # attachments (perfin_tax_package_<year>.pdf|.zip — the ZIP:
                           # summary.pdf, deductions.csv, income.csv,
                           # investment_income.csv, realized_gains.csv, retirement.csv,
                           # rent_paid.csv, documents.csv, package.json); a fixed 500.
                           # format=csv&section=<deductions|income|investment_income|
                           # realized_gains|retirement|rent_paid|documents> → that CSV
                           # (perfin_tax_<section>_<year>.csv; 400 on another section — K4)
GET  /api/advice           # the "Where should my extra money go?" plan (roadmap T4.1 A2):
                           # services/advice.getAdvicePlan → { ok, generated_on,
                           # disclaimer, errors, period, headline { step, text,
                           # amount_monthly, amount_per_period }, why, steps[], surplus,
                           # cash, debts[], allocation { debts[], snowball, … }, notes }
                           # or { ok: false, error, disclaimer } (still 200); a fixed
                           # 500 on a throw. Educational, computed in code, no AI
GET  /api/dashboard/summary # the dashboard's Summary card + Needs attention (design D3):
                           # { today, month, net_worth { ok, value, as_of, change,
                           # change_since }, spending { ok, month, budget_count, spent,
                           # budget, percent, over_count }, cash { ok, days: 30,
                           # starting_balance, lowest_balance, lowest_date }, attention
                           # { items[{ kind rent|bills|uncategorized|sync_health, text,
                           # href, amount?, count }], errors[{ source, error }] } } — a
                           # failed part { ok: false, error: <fixed sentence> }; each
                           # figure from its own screen's helper (INV-147)
GET  /api/data-freshness   # per-source sync timestamps with staleness flags
GET  /api/data-health      # operator health surface — per-source freshness,
                           # Teller/Plaid connection status, scheduled-job
                           # heartbeats (jobs[] with per-job staleness from
                           # job_runs + thresholdMs, plus last_status /
                           # last_error — in-memory ticks are flushed first,
                           # F8), derived issues[] (incl. a failed scheduled
                           # job and the compromised Teller cert, F14)
                           # (disconnected links, stale balances, never-synced,
                           # + per-item errors from last_sync_result), recent sync
                           # notifications, last_reconcile_at, last_sync_result,
                           # last_sheets_sync_result (+ an issue when the last Sheets
                           # run had failed tabs — SXE-1), and a top-level `ok` flag. Does NOT live-decrypt tokens to
                           # probe a passphrase mismatch; that condition surfaces here
                           # via last_sync_result.errors (decryption_failed — reachable
                           # since the sync reads use perfin_try_decrypt, F17) (D).
                           # Also operator_checks (+ each warn/fail check as an issue
                           # tagged source:'operator') from CACHED GitHub results —
                           # it never waits on GitHub (cycle-7 G1 + ST4). Also
                           # webhooks (getWebhookStatus — per provider last event /
                           # 24h events + failures, the Plaid registration; a failed
                           # event in 24h is an issue) and connections ([{ provider,
                           # id, institution, status (NEEDS_REAUTH for a Plaid
                           # re-auth code), last_synced: { timestamp, age_seconds,
                           # level } }] from each enrollment's / item's own
                           # last_synced_at — no CSV items, no SUSPENDED) — roadmap
                           # T2.1 W6
GET  /api/errors           # the in-app error log (roadmap T1.4): { errors: [{ fingerprint,
                           # source, message, sample, count, first_seen, last_seen,
                           # resolved_at }] } — unresolved, newest first (?all=1 adds
                           # resolved; ?limit 1-100, default 20). Flushes the buffer first
POST /api/errors/:fingerprint/resolve # hide an error until it happens again (400 on a
                           # malformed id, 404 unknown)
GET  /api/operator-checks  # the operator doctor (cycle-7 G1 + ST4): { checked_at,
                           # github: { configured, ok, reason, checked_at, pending },
                           # checks: [{ id, label, status ok|info|warn|fail|unknown,
                           # detail, fix }] } — GitHub workflows / backup / secrets /
                           # visibility (6h cache; ?refresh=1 forces), local checks,
                           # the Knowledge parse version. Read-only; no secret value
                           # or token in the response
GET  /api/budgets          # list budgets with current spending (query: month=YYYY-MM)
GET  /api/budgets/one-time # every one-month budget → { budgets: [{ id, category,
                           # monthly_limit, effective_month }] } (roadmap T1.5)
POST /api/budgets          # create budget, upsert by category (body: rollover_enabled, budget_type,
                           # effective_month, notes — a field not sent keeps its stored value, F39;
                           # 400 on an unknown budget_type / malformed effective_month)
PATCH /api/budgets/:id     # update budget (400 on a non-finite/negative monthly_limit,
                           # unknown budget_type or malformed effective_month — FAN-14)
DELETE /api/budgets/:id    # delete budget
POST /api/budgets/suggest  # AI budget suggestions (from the last 3 COMPLETE months);
                           # 429 past the shared AI cap, charged as an entry_type='suggest' usage row
POST /api/budgets/accept   # accept AI-suggested budget (one row per category, last wins — F70)
GET  /api/budgets/alerts   # spending velocity warnings (critical/warning/info)
POST /api/budgets/snapshot # create monthly snapshot + compute rollovers (body: month=YYYY-MM, 01-12)
GET  /api/budgets/history  # budget snapshots for trend analysis (query: months)
POST /api/insights         # generate new AI insights. Response includes
                           # modules_used and modules_failed (dynamic modules
                           # whose data query threw — dropped from modules_used)
                           # + summary_status. 502 when the model returned no
                           # insight text (charged as 'insight_empty'; nothing
                           # stored, audited or emailed — AIN-8)
GET  /api/insights/status  # AI API config + usage stats + audit_accuracy (90d clean-run %)
                           # + running_summary (structured JSON) + running_summary_counts
                           # + persistent_ai { spent_cents, budget_cents } — Per-sistant's
                           # month AI spend + its own cap via persistentPool, null
                           # standalone or on a failure (roadmap T2.3 C4; read-only)
GET  /api/insights/usage   # AI usage history
POST /api/insights/reset   # clear long-term AI context
POST /api/insights/rebuild # rebuild context from all history
GET  /api/insights/audit   # audit log + per-module stats + 90-day accuracy summary
PATCH /api/insights/:id/feedback # set thumbs-up/down/mixed + optional correction note
                                  # (body: { feedback: 'positive'|'negative'|'mixed'|null, text? })
GET  /api/insights/feedback-summary # positive/negative/mixed counts (query: days, default 90)
GET  /api/insights/trust-overview # merged audit_accuracy + user_feedback for the Settings AI card
                                   # (query: days, default 90 — clamped 1-365)
POST /api/categorize       # ML categorize transactions (rules first, then Claude AI)
GET  /api/categorize/status # ML categorization status
GET  /api/categorize/review-queue # candidates the next AI categorize would send to Claude
POST /api/categorize/review # apply a single user decision (sets user_category, optionally creates rule;
                            # a too-short merchant for the rule returns rule_error and no rule — F48)
GET  /api/categorize/progress # live progress of the running categorize pass
                            # { running, phase, by_rules, by_teller_map, by_ai, ai_batches, remaining }
GET  /api/categorize/accuracy # running ML accuracy over verified AI rows
                            # { ai_total, verified, correct, unverified, accuracy_pct }
GET  /api/categorize/accuracy-sample # random unverified AI-categorized rows to review
                            # (query: limit 1-25 default 8) → { transactions[], categories[] }
POST /api/categorize/accuracy-review # record a verdict on a sampled AI row
                            # (body: transaction_id, correct: bool,
                            # corrected_category? (required when wrong), create_rule?).
                            # Preserves source='ai' so the miss still counts in stats;
                            # the corrected category still wins via user_category.
PATCH /api/transactions/:id/category # manually set transaction category — writes user_category
PATCH /api/transactions/bulk-category # bulk update categories — writes user_category
GET  /api/categorization-rules       # list all categorization rules
POST /api/categorization-rules       # create a rule (body: merchant_pattern, category, match_type);
                                     # 400 on a blank or <3-char contains/starts_with pattern (F48);
                                     # deactivates the merchant's rules for other categories (F46)
DELETE /api/categorization-rules/:id # delete a rule
POST /api/categorization-rules/apply # apply all active rules to uncategorized transactions
POST /api/categorization-rules/from-transaction # create rule from a manual categorization
GET  /api/merchant-rename-rules      # list merchant rename rules (most specific first — ST2)
POST /api/merchant-rename-rules      # create/re-point a rule (body: merchant_pattern, rename_to,
                                     # match_type? default exact); renames past rows, re-keys
                                     # detection, re-detects; 400 on a <3-char contains/starts_with
POST /api/merchant-rename-rules/apply # re-apply every active rule → { renamed }
PATCH /api/merchant-rename-rules/:id # body rename_to? (1-200 chars) / is_active? (boolean):
                                     # a new name renames the rule's rows + re-keys detection
                                     # (redetected); off reverts its rows and keeps the rule;
                                     # on re-applies it (roadmap T1.5). 400 / 404
DELETE /api/merchant-rename-rules/:id # delete a rule and revert the rows it renamed
POST /api/import-csv/preview # dry-run a CSV import: detect format + classify each
                           # row new/duplicate/skipped vs existing transaction_ids,
                           # WITHOUT writing. Returns { format_detected, account_label,
                           # rows_total, rows_parseable, rows_skipped, rows_new,
                           # rows_duplicate, rows_deleted (ids you deleted — skipped,
                           # T2.5 U1; sample status "deleted"), positive_means,
                           # sign_guess, sample[] }.
                           # Backs the two-step upload modal. body positive_means
                           # (charges|deposits — generic files only; 400 otherwise;
                           # null in the response for a known format — F26).
POST /api/import-csv       # import bank CSV file (with deduplication). Returns
                           # { rows_imported, rows_skipped, rows_duplicate, rows_deleted,
                           # format_detected } (a deleted id is never re-imported — T2.5 U1)
                           # (rows_skipped = unparseable only, matching the preview).
                           # A name-matched manual account's balance is rolled
                           # forward by the new post-balance rows (DC-6). Takes the
                           # same positive_means as the preview and echoes it (F26).
GET  /api/csv-imports      # list CSV import history
GET  /api/export           # download transactions/subscriptions CSV — ISO
                           # YYYY-MM-DD dates, the display merchant (user rename
                           # first), text cells formula-guarded via csvText
                           # (SXE-8/PSC-10/SXE-13)
POST /api/sheets/sync      # full sync to Google Sheets (all 16+ tabs, ~30-60s).
                           # Returns { ...result, partial, tabs_failed } and records
                           # the outcome in last_sheets_sync_result (SXE-1)
POST /api/sheets/sync-transactions # partial sync — Transactions tab only (~5s); called from CSV upload modal
POST /api/sheets/dashboard # sync dashboard data to Sheets (a failure is recorded in
                           # last_sheets_sync_result — F86)
GET  /api/watchlist        # list watchlist items (merchant/category/keyword)
POST /api/watchlist        # add watchlist item (body: type, value, notes?)
PATCH /api/watchlist/:id   # toggle is_active or update notes
DELETE /api/watchlist/:id  # remove watchlist item
GET  /api/credit-scores    # credit score history + computed trend (query: limit, score_type)
POST /api/credit-scores    # log a score (body: score 300-850, score_type?, source?, notes?, checked_at?)
DELETE /api/credit-scores/:id # remove an entry
GET  /api/plaid/status     # Plaid API config status (configured + environment)
POST /api/plaid/link-token # create Plaid Link token for investments only
POST /api/plaid/exchange   # exchange public token for investment accounts. accountsGet
                           # runs BEFORE anything is stored; a duplicate (findDuplicatePlaidItem
                           # or findDuplicateInvestmentItem — same institution + mask + type)
                           # → the Item is released at Plaid, 409 { duplicate_of }; writes
                           # investment_accounts.mask (cycle-7 G3)
POST /api/plaid/link-token-update # Plaid Link UPDATE MODE token (body: item_id, kind=
                           # transactions → plaid_items.id | investments →
                           # plaid_investment_items.id): the item's own access_token
                           # (perfin_try_decrypt), no products, update.account_selection_
                           # enabled. 400 bad kind/id or a CSV item, 404, 409 { reason:
                           # "decryption_failed" } (the one case needing unlink + link) — G3.
                           # hosted: true + redirect_uri (a non-empty string, else 400 before
                           # anything is read) adds hosted_link { url_lifetime_seconds: 3600,
                           # completion_redirect_uri } + redirect_uri and returns
                           # hosted_link_url (roadmap T2.5 H1 — iOS / standalone / Capacitor)
POST /api/plaid/update-complete # after update-mode Link succeeds (same body; no token
                           # exchange). transactions: under the Plaid lock, accountsGet →
                           # registerMissingPlaidAccounts → clear last_error_code → sync that
                           # item only; investments: syncAllPlaidHoldings({ itemId }) for that
                           # Item. → { accounts_added, transactions_added, incomplete?,
                           # holdings_updated? }; a re-auth code again → flag kept, 409.
                           # link_token? (the hosted flow, T2.5 H1 — a non-empty string, else
                           # 400): its Link session is read (linkTokenGet) BEFORE anything else;
                           # none finished without an exit → 400 { reason: exited | unfinished
                           # | none }, a Plaid error → fixed 502 — nothing written either way
POST /api/plaid/sync-holdings # sync investment holdings (thin wrapper around the
                              # exported syncAllPlaidHoldings helper; UPSERTs
                              # investment_accounts so wiped rows are re-created)
POST /api/plaid/link-token-transactions # create combined Transactions+Investments link token
                                        # (730-day history request; one Plaid Link session links
                                        # both checking + brokerage for banks like Schwab)
POST /api/plaid/exchange-transactions   # exchange token, store in plaid_items, fetch accounts
                                        # into linked_accounts, run initial transaction sync,
                                        # auto-detect + sync investment holdings if present.
                                        # accountsGet runs BEFORE anything is stored: a duplicate
                                        # of a connected Item (same institution + an account with
                                        # the same mask/type on another GOOD item) → the new Item
                                        # is released at Plaid, nothing stored, 409 { duplicate_of }
                                        # pointing to Re-authenticate / Add accounts (G3); a pre-store failure also
                                        # releases the Item (F18). /api/plaid/hosted-link-complete
                                        # applies the same guard
POST /api/plaid/sync-transactions       # cursor-based sync for all plaid_items (added/modified/removed)
                               # Response: { accounts_updated, holdings_updated, errors[]? }
                               # Per-item failures (including a NULL access_token from a
                               # passphrase mismatch — perfin_try_decrypt) surface as
                               # `errors: [{ institution, error: "decryption_failed" | ... }]`
GET  /api/plaid/holdings   # list investment holdings
GET  /api/investments/performance # portfolio returns + asset-class allocation + top winners/losers
                                  # (Plaid holdings only; auto-hides on dashboard when empty).
                                  # total_return / per-class return over KNOWN-basis holdings;
                                  # cost_basis_coverage { holdings_with_basis, holdings_total,
                                  # value_with_basis, value_pct }; top_winners return_pct > 0,
                                  # top_losers < 0 (BSI-5 / WD-17)
GET  /api/investments/performance-history # portfolio value series vs S&P 500
                                  # (query: months=3-60 default 12). Portfolio = daily
                                  # account_balance_snapshots summed across ALL investment
                                  # accounts (investment-source rows + Teller-linked
                                  # investment types, Plaid phantom twins deduped same
                                  # direction as getNetWorth), per-account forward-filled.
                                  # Benchmark from benchmark_prices (services/benchmarks.js);
                                  # response carries benchmark:null gracefully when the
                                  # source is unavailable. portfolio_return_pct is
                                  # point-to-point on VALUE (contributions count as
                                  # growth); the response ALSO carries flow-adjusted
                                  # figures: twr_pct (true time-weighted return — daily
                                  # chain-linked, exact since valuations are daily) and
                                  # xirr_pct (annualized money-weighted return), both
                                  # computed over FLOW-COVERED accounts only (Plaid accounts
                                  # whose flows completed a sync — investment_accounts.
                                  # flows_synced_at set, F24 — + any account with manual
                                  # flows) with a flow_coverage
                                  # block ({coverage_pct, flows_count, net_flows, scope:
                                  # all|partial|none, accounts_added}) so partial coverage
                                  # is explicit rather than silently wrong. An account that
                                  # joins mid-window is an opening inflow (accountEntryFlows,
                                  # BSI-6; counted in accounts_added). Snapshot dates are
                                  # read as snapshot_date::text / snapshotDay() (the local
                                  # calendar day — toISOString shifted them a day, F30).
POST /api/plaid/sync-flows # sync external cash flows (deposits/withdrawals/in-kind
                           # transfers) from Plaid investmentsTransactionsGet into
                           # investment_flows. Full ~24-month window every run, idempotent
                           # via UNIQUE plaid_investment_transaction_id (no watermark —
                           # a newly linked item can't silently lose history). Dividends,
                           # interest, capital gains, buys/sells/fees are RETURN
                           # components, never flows (classifyPlaidFlow). Every row of a
                           # tracked account is also stored in investment_transactions
                           # (T3.3 K1) → transactions_stored in the response.
GET  /api/investment-flows # list flows (query: months default 24) with account names
POST /api/investment-flows # log a manual flow for accounts Plaid can't see
                           # (body: source 'investment'|'linked', source_id, flow_date,
                           # amount, flow_type contribution|withdrawal — sign derived
                           # from flow_type regardless of submitted sign)
DELETE /api/investment-flows/:id # delete a MANUAL flow (plaid rows 404 — they'd
                           # resurrect on the next sync)
GET  /api/whats-new        # "since you last looked" feed — new transactions, balance deltas,
                           # new subscriptions, and recent notifications since last_dashboard_view_at
                           # + seen_token "<id>|<time>" (the mark read before the
                           # queries — cycle-8 E2d); by id once an id is stored
POST /api/whats-new/seen   # body { seen_token? }: advance last_dashboard_view_txn_id /
                           # last_dashboard_view_at to the token (forward only, capped
                           # at the newest id / now()); malformed → 400; no token →
                           # now (idempotent)
GET  /api/notifications/vapid # get VAPID public key for push
POST /api/notifications/subscribe # register push subscription
DELETE /api/notifications/subscribe # unregister push subscription
POST /api/notifications/test # send test push notification
GET  /api/notifications      # list notification log (query: limit, unread=true)
PATCH /api/notifications/:id/read # mark notification as read
POST /api/notifications/read-all  # mark all notifications as read

# Tax export
GET  /api/export/tax-report # year-end deduction summary (query: year — default the
                            # APP_TIMEZONE year, format=csv|json|pdf). Computed from
                            # transactions at export time (SXE-7): one row per matching
                            # transaction with its date, whole year, split-adjusted;
                            # merchant annotations (confirm/notes/category) from
                            # tax_deductions; Type "keyword_match". JSON groups by
                            # category; PDF renders via pdfkit with per-category
                            # breakdown and grand-total summary. Rows from
                            # getTaxDeductionReport, CSV from tax-package.taxReportCsv
                            # (shared with the tax package — T3.3 K3)

# WebAuthn / biometric login — Perfin sub-app endpoints (registration always
# happens here; standalone deployments also use these for the auth flow).
POST /api/webauthn/register-options    # generate registration challenge (auth required)
POST /api/webauthn/register            # verify and store new credential (auth required)
POST /api/webauthn/authenticate-options # generate auth challenge (no session needed)
POST /api/webauthn/authenticate        # verify biometric and create session (standalone)
GET  /api/webauthn/credentials         # list registered credentials (auth required)
DELETE /api/webauthn/credentials/:id   # remove a credential (auth required)

# Shell-layer biometric login (unified-shell deployments). Mounted BEFORE the
# shell's PIN gate so users can authenticate via FaceID/passkey without first
# entering the PIN. Reads `webauthn_credentials` from Perfin's pool via the
# cross-pool wiring; on successful verify, sets the shell signed-cookie session.
GET  /api/shell/webauthn/available             # does any credential exist? (drives login UI)
POST /api/shell/webauthn/authenticate-options  # generate auth challenge
POST /api/shell/webauthn/authenticate          # verify + set shell session cookie

# Per-sistant integration endpoints
POST /api/persistent/webhook/test  # test webhook connectivity to Per-sistant
POST /api/persistent/webhook/send  # manually trigger webhook event
GET  /api/persistent/status        # Per-sistant connection health check
GET  /api/persistent/productivity-context # fetch task/review stats from Per-sistant
POST /api/sso/generate             # create HMAC-signed SSO token (60s expiry)
POST /api/sso/validate             # validate SSO token, create session

# Pages
GET  /                          # redirects to /dashboard (post-login entry point;
                                # baseUrl-aware so it lands in the right mount
                                # under the unified shell)
GET  /accounts                  # Teller Connect enrollment + CSV import page
GET  /dashboard                 # main dashboard UI
GET  /subscriptions             # subscription management
GET  /transactions              # transaction search/filter page
GET  /calendar                  # bill calendar page
GET  /goals                     # financial goals page
GET  /budgets                   # budget tracking page
GET  /housing                   # Rent & Utilities ledger page
GET  /tax                       # the Tax page (roadmap T3.3 K4; ?year=)
GET  /settings                  # settings page
GET  /accounts/:id/history      # per-account balance chart (query: source=linked|investment, months)
GET  /login                     # login page (if auth enabled)
GET  /health                    # health check (Perfin standalone) — also
                                # served by the shell at the same path; the
                                # shell version is public (pre-auth) and
                                # doesn't touch the DB

# Shell-level public endpoints (no auth, mounted before requireAuth):
GET  /health                              # process-up probe (shell, JSON)
GET  /health/deep                         # SELECT 1 on both databases (3s each), cached
                                          # 60s: 200 / 503 { ok, perfin_db, persistent_db }
                                          # — yes/no fields only (roadmap T1.4). Monitor
                                          # /health instead on Render + Neon (probing the
                                          # database every few minutes keeps Neon awake)
GET  /manifest.json                       # unified-shell PWA manifest
GET  /apple-touch-icon.png                # iOS home-screen icon (mask-crop PNG)
GET  /apple-touch-icon-precomposed.png    # older-iOS probe path; same bytes
GET  /android-chrome-192x192.png          # PWA icon, 192 (mask-crop PNG)
GET  /android-chrome-512x512.png          # PWA icon, 512 (mask-crop PNG)
GET  /calendar.ics                        # bill-calendar iCalendar feed (subscribe from
                                          # iOS/Google Calendar). Token-gated via
                                          # ?token=CALENDAR_FEED_TOKEN — the ONE sanctioned
                                          # query-string credential (calendar apps send no
                                          # headers/cookies); read-only, single-purpose,
                                          # deliberately separate from API_KEY (which stays
                                          # header-only). Unset env = 404/feature off.
                                          # Events: detected-subscription charges projected
                                          # by cadence (calendar-month stepping from the
                                          # last charge, DC-9) + manual bills (every
                                          # occurrence in the window, anchored on the bill's
                                          # creation month + due_day clamped to the real
                                          # month length — the SAME rule as the in-app
                                          # calendar, DC-15; it used to cap at day 28 and
                                          # anchor quarterly/yearly on "this month") +
                                          # unpaid Rent & Utilities obligations (known
                                          # amount, on their period's due day; one
                                          # whose due day has passed is placed on
                                          # TODAY flagged "OVERDUE", same stable UID —
                                          # SXE-12),
                                          # "today" = the APP_TIMEZONE date,
                                          # 90 days default (?days=7-365). A rent/utility
                                          # due day is clamped to its month's real length
                                          # (F45); SUMMARY lines are folded at 75 octets per
                                          # RFC 5545 (icsFold, UTF-8 safe — F59). Builder:
                                          # subscriptions.buildBillCalendarIcs.
```

`PATCH /api/settings` accepts a new `shell_idle_timeout_minutes` field
(integer, 5-10080 minutes, strict integer parse) that drives the shell's
sliding-window auth.
After the PATCH a hook fires `auth.invalidateIdleCache()` so the new
value applies on the very next request, not after the 60s cache lag.

The `insight_modules` and `dashboard_widgets` toggle maps are coerced to a
flat `{ string: boolean }` object via `sanitizeBoolMap` before persisting
(rejects arrays / nested objects, caps key length, `!!`-coerces values) so a
pathological body can't be stored verbatim — parity with the `target_allocation_pct`
validation (SN-5); a non-object map is a 400. Since cycle-7 F86 the remaining
fields 400 instead of being silently dropped: `theme` (dark/light),
`dashboard_months` (integer 1-24), `insights_model` (haiku/sonnet/opus),
`insights_cadence_days` (7/14/30/60/90), `pyramid_data_source` / `pyramid_color_mode` (their
enums), `debt_baseline_amount` (a finite number ≥ 0 or null),
`sheets_auto_sync_interval` (daily/weekly/monthly) and
`session_timeout_minutes` (integer 1-1440).

## Environment Variables

### Shell (unified PIN gate)
- `SHELL_PIN` — unified PIN that fronts both apps (use at least 6 digits — boot warns otherwise; a global 30-failures/hour ceiling locks PIN login for 30 min, PSC-14). Compared as fixed-length SHA-256 digests (`auth.safeEqual` — the old padded raw-buffer compare threw on a multibyte PIN of the right length and crashed the process before login, cycle-7 F1), with a 750ms throttle on incorrect attempts, backed by an IP rate limiter (10 failed attempts / 15 min) on `/login` and the biometric authenticate endpoints.
- `SHELL_SECRET` — random ~32+ char string (`openssl rand -hex 32`). Signs the shell session cookie. **Required — the shell refuses to boot without it** (PSC-11). Rotating it invalidates every active session.
- `SHELL_PORT` — optional listener port override (defaults to `PORT` or `3000`)
- `CALENDAR_FEED_TOKEN` — optional long random token enabling the public `/calendar.ics` bill feed (unset = feature off)
- `GITHUB_OPS_TOKEN` / `GITHUB_OPS_REPO` — optional (cycle-7 G1): a fine-grained, READ-ONLY GitHub token (Actions, Metadata, Secrets) and the repo as `owner/repo`, so Settings → Sync Health → Operator Checks can see disabled / failing backstop workflows, the last successful backup, missing workflow secrets (names only) and repo visibility. Unset = GitHub checks off. Never stored, logged or returned.

### Databases (one per sub-app)
- `NEON_DATABASE_URL` — Perfin's Neon PostgreSQL connection string
- `PERSISTENT_DATABASE_URL` — Per-sistant's Neon DB (separate). Falls back to `NEON_DATABASE_URL` for standalone Per-sistant deployments. **Required under the unified shell, and it must name a different database from `NEON_DATABASE_URL`** — the shell refuses to start otherwise (cycle-8 F26, `shell/boot-checks.js`: the fallback used to migrate both apps into one database, merging their single-row `user_settings` and the two separate AI caps).
- `ALLOW_SHARED_DATABASE` — `true` to run both apps in ONE database under the shell on purpose (skips the check above). Unset in every documented deployment.
- `TOKEN_ENCRYPTION_PASSPHRASE` — passphrase for encrypting access tokens at rest. **Required — boot fails without it** (escape hatch: `ALLOW_MISSING_TOKEN_PASSPHRASE=true` for local debug with no bank links).

### Teller (Perfin)
- `TELLER_APPLICATION_ID` — Teller app ID
- `TELLER_ENV` — Teller environment (sandbox/development/production)
- `TELLER_CERT` / `TELLER_KEY` — base64-encoded mTLS PEMs (Render)
- `TELLER_CERT_PATH` / `TELLER_KEY_PATH` — file paths (default `./certificate.pem` / `./private_key.pem`)
- `TELLER_CERT_CONTENT` / `TELLER_KEY_CONTENT` — raw PEM contents written to disk by `docker-entrypoint.sh` at container start
- `TELLER_WEBHOOK_SECRET` — optional (roadmap T2.1): the webhook signing secret from the Teller dashboard; a comma-separated list during a rotation. Unset = `POST /perfin/api/webhooks/teller` answers 503. With it set and the URL `<public address>[/perfin]/api/webhooks/teller` added in the Teller dashboard, Teller's events act (W5). Confirm Teller's signature format first (see Known Open Issues) — send its test event and check the webhook_events row ends 'done'.

### Per-app auth (mostly bypassed when embedded under shell)
- `SESSION_PASSWORD` — text password for standalone Perfin login
- `SESSION_PIN` — numeric PIN for standalone Perfin PIN pad login
- `SESSION_SECRET` — session cookie secret (auto-generated if not set)
- `API_KEY` — `X-API-Key` for non-browser clients (cron, GitHub Actions like
  daily-sync.yml and keep-alive.yml). Under the unified shell, the shell's
  `requireAuth` itself validates the header (constant-time compare) as an
  alternate credential path parallel to the PIN cookie — sub-apps then see
  `req.app.get("embedded")=true` and skip their own check, trusting the
  shell. Browsers don't need it; they use the shell session cookie.
- `ALLOWED_ORIGINS` — comma-separated CORS origins (Perfin)

### AI / Insights (Perfin)
- `ANTHROPIC_API_KEY` — enables AI features in both apps
- `INSIGHTS_MONTHLY_BUDGET_CENTS` — monthly API spending cap fallback (default 50 = $0.50); shared between `/api/insights`, `/api/categorize`, `/api/insights/rebuild`, `/api/ask`, `/api/housing/scan-bill` and `/api/budgets/suggest` (spend read by the one `monthAiSpendCents()`). Overridable at runtime from Settings → AI Insights → Monthly Budget Cap (`user_settings.ai_monthly_budget_cents`, resolved by `getAiBudgetCents()` in routes/insights.js — the single cap reader)

### Push notifications (Perfin)
- `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` — Web Push keypair (`npx web-push generate-vapid-keys`); without these `/api/notifications/*` returns 501
- `VAPID_EMAIL` — contact `mailto:` URL (default `mailto:admin@perfin.app`)

### Keep-alive (Perfin / shell)
- `RENDER_EXTERNAL_URL` — auto-set by Render; the keep-alive self-ping uses it as the target URL when present, falling back to `http://localhost:PORT` for local runs. The insight email's "Open Dashboard" link is built from it too (no link without it — cycle-7 F72). Operators don't set this manually on Render.

### Hosting (`teller/services/hosting.js` — set on a self-hosted server, see `deploy/vps/`)
- `PUBLIC_URL` — the public https address; wins over `RENDER_EXTERNAL_URL` (which still works when this is unset). Used for the keep-alive target and the insight email's dashboard link. Setting it ALSO opts in to Plaid webhooks (roadmap T2.1 W4): new link tokens carry `<PUBLIC_URL>[/perfin]/api/webhooks/plaid` and `POST /api/plaid/webhooks/register` points existing Items there — `RENDER_EXTERNAL_URL` alone never does, so a sleeping free-tier host isn't woken by bank events.
- `ALWAYS_ON` — `true` when the host never sleeps: neither app starts the keep-alive ping (`startKeepAlive` returns false), both `/api/keep-alive-schedule` endpoints report `enabled: false` (so `keep-alive.yml` stops pinging), Settings → Keep-Alive shows a note instead of its controls (`GET /api/settings` returns `always_on`), and Operator Checks lists the Keep Alive workflow as "not needed" (info).
- `HEARTBEAT_URL` — optional (roadmap T1.4): a healthchecks.io ping URL (period 1 hour, grace 1 hour). Pinged every 30 minutes by `services/uptime.js`, or `<url>/fail` while a scheduled job's last run in this process failed; the service alerts on /fail and when pings stop. Not activity-gated and no database call. On a sleeping host (Render free tier) the pings stop whenever it sleeps — use it on an always-on server or with keep-alive on. Unset = an info line in Operator Checks.
- `SERVER_BACKUPS` — `true` when `deploy/vps/backup.sh` takes the backups: Operator Checks drops the GitHub backup check and the Database Backup workflow's secrets, lists that workflow as "not needed", and adds the `local:backup` check on `user_settings.last_backup_at` (fail when missing or older than 36h; needs no GitHub token — since cycle-8 E4a the same check also runs whenever the GitHub checks are off, reading the stamp db-backup.yml writes).

### Plaid (Perfin — investments + transactions for banks Teller doesn't cover)
- `PLAID_CLIENT_ID`, `PLAID_SECRET_SANDBOX|DEV|PROD` — Plaid API credentials
- `PLAID_ENV` — `sandbox` (default), `development`, or `production`; selects which `PLAID_SECRET_*` is used.
  **For real bank connections set `PLAID_ENV=production`** with a Trial Plan
  account (10 free Production Items, no cost). The old Development
  environment was decommissioned June 2024; Trial Plan (created after
  April 2026) is the replacement.

### SMTP (Per-sistant — email scheduling)
- `SMTP_HOST` / `SMTP_PORT` / `SMTP_USER` / `SMTP_PASS` / `SMTP_FROM`

### Shared — timezone
- `APP_TIMEZONE` — IANA zone (e.g. `America/New_York`). Used by BOTH apps.
  - **Per-sistant Health & Habits** day-math (streaks / due-today / 7-day grid /
    future-log guard) — server and injected client resolve "today" in this zone
    so they agree. See `apps/per-sistant/CLAUDE.md`.
  - **Perfin "current month" / "today" anchors** — `services/financial-queries.js`
    exports `currentMonth(tz)` / `todayStr(tz)` (the single tz source), and the
    user-facing month-bucketed surfaces resolve the month boundary in this zone:
    `getCategorySpendingThisMonth` (budgets/insights/ask), `getMonthlySpending` /
    `getMonthlyIncome` window anchors (savings-rate/trends/FIRE), budgets'
    `currentMonthKey`, the settlement/housing month defaults, and (Batch 6 —
    FAN-13/SXE-12/AIN-15) the budget-alert day math, budget push + scheduled
    snapshot month keys, weekly-digest weekday, daily-digest local date/hour,
    income-summary window, YoY defaults, housing reminder day / export year /
    payment date, credit-score date, goal + FIRE dates, the ICS feed's "today",
    and the Sheets windows/timestamp/tax year/archive month, plus (cycle-7 F66) the
    AI-cap spend month (`monthAiSpendCents`) and Ask's "today". Rolling-window
    `CURRENT_DATE` lookbacks (90-day cash-flow, retention) are intentionally left
    UTC — tz-insensitive.
  - Default `UTC` (byte-identical to the prior UTC-anchored behavior); set it to
    your zone or evening logs/figures west of UTC land in the wrong day/month
    (F11). An invalid zone falls back to UTC (no crash).

### Cross-app integration (legacy, two-Render-services era)
Unused under the unified shell — both apps run in-process. Documented as the
standalone-mode fallback if either app is run on its own Render service.
- `PERSISTENT_URL` — URL of standalone Per-sistant instance
- `PERSISTENT_WEBHOOK_SECRET` — HMAC secret for signing webhook payloads
- `SSO_SECRET` — shared HMAC secret for cross-app SSO token exchange

## Database
- Auto-migration runs on server startup in a transaction (BEGIN/COMMIT/ROLLBACK) — no
  manual SQL needed. Migration failures are now fatal (the process throws and exits)
  rather than logging a "non-fatal" warning while leaving the schema half-applied.
  **Locking (cycle-7 F10):** each run takes `pg_advisory_xact_lock(MIGRATION_LOCK_KEY)`
  first (Perfin 727274001, Per-sistant 727274002 — a standalone Per-sistant can share the
  database), with no timeout, so a second instance booting during a deploy overlap waits
  for the first; then `SET LOCAL lock_timeout = '5s'`, because every boot's ~100 idempotent
  `ALTER TABLE`s each take an ACCESS EXCLUSIVE lock and one stuck behind a long query
  froze the live app. A lock timeout (SQLSTATE 55P03) rolls back and is retried
  (`runMigrations({ attempts = 5, sleep })`, 2s × attempt backoff); any other error, or
  running out of attempts (~45s of contention), is still fatal.
  **IN-list CHECKs (cycle-8 F31):** a CHECK written inside `CREATE TABLE IF NOT EXISTS`
  never changes once the table exists. The value lists of `tax_documents.form` / `origin`,
  `webhook_events.provider` / `status`, `recurring_transfers.forecast_treatment` (E1a — its
  ADD COLUMN interpolates the list) and `notification_log.push_state` (cycle-8 E3a, the same way) live in `CHECK_LISTS` (services/database.js —
  the CREATE TABLEs interpolate them); `syncInListChecks(client)` reads each
  `<table>_<column>_check` (`pg_get_constraintdef`) and, only when its values differ,
  drops it and re-adds it `NOT VALID` inside the migration transaction. Add a new value to
  `CHECK_LISTS`, never to the CREATE TABLE text; a new IN-list CHECK that will grow should
  go into `CHECK_LISTS` too.
- `plaid_items.last_error_code TEXT` (BSI-10): the Plaid ITEM_* re-auth code from the
  last failed sync (NULL = healthy). Set by `syncAllPlaidTransactions` /
  `syncAllPlaidBalances` (only when the code CHANGES — a newly flagged item sends
  one notification to `/accounts`, G3), cleared by a clean transaction sync, by
  `POST /api/plaid/update-complete` and by both exchange upserts. `status` stays
  `'GOOD' | 'CSV'`. Surfaced by `GET /api/items` (the Accounts page's
  Re-authenticate button). Since roadmap T2.1 W4 Plaid ITEM webhooks set it too
  (ERROR with a re-auth code, PENDING_EXPIRATION, PENDING_DISCONNECT,
  USER_PERMISSION_REVOKED) and LOGIN_REPAIRED clears it; the two PENDING_* codes
  are advance warnings a clean sync does NOT clear (the item still works until
  then) — only update-complete, a re-link or LOGIN_REPAIRED does. The notification
  text follows the code ("expires soon" / "access revoked" / "sign in again").
- `plaid_items.webhook_url TEXT` + `plaid_investment_items.webhook_url TEXT` (roadmap
  T2.1 W4): the URL the Item was linked with (when PUBLIC_URL was set) or last
  registered at via `POST /api/plaid/webhooks/register`; NULL = none known. Read by
  the webhooks:plaid operator check and Sync Health's "N of M registered" (W6). Auto-migrated.
- `teller_enrollments.last_synced_at TIMESTAMPTZ` (roadmap T2.1 W5): when the
  enrollment last synced every account and row (syncOneTellerEnrollment — the
  scheduled sync, a reconcile pass and a webhook sync alike; a partial run doesn't
  stamp it). Distinct from `last_synced_txn_date` (the incremental watermark).
  Auto-migrated.
- `plaid_items.last_synced_at TIMESTAMPTZ` (roadmap T2.1 W3): when the item's
  transaction walk last reached the END of its cursor (stamped by syncOnePlaidItem —
  the scheduled sync and a webhook sync alike; a stuck or still-paging walk doesn't
  stamp it). The per-connection freshness a webhook sync advances instead of the
  global `last_txn_sync_at`. Distinct from `sync_cursors.last_synced_at`, which moves
  on every clean page. Auto-migrated.
- `investment_accounts.mask TEXT` (cycle-7 G3): a Plaid investment account's last
  digits, written by the holdings sync and both exchange paths (COALESCE keeps a
  known mask); read by the investments-only exchange's duplicate guard. Rows synced
  earlier fill on the next holdings sync. Auto-migrated.
- Migration creates base tables (`plaid_items`, `teller_enrollments`, `linked_accounts`,
  `sync_cursors`, `transactions`, `detected_subscriptions`, `csv_imports`) idempotently
  via `CREATE TABLE IF NOT EXISTS` before the per-feature `ALTER TABLE` steps.
- Schema versioning via `schema_migrations` table (current value: 3). Most
  migration steps use `IF NOT EXISTS` / `CREATE OR REPLACE` guards and run
  unconditionally, so the version is largely observability — with ONE exception:
  the detection-key orphan cleanup (see "Detection-key migration window") is
  gated on `currentVersion < 3` so it runs exactly once during the v3 upgrade
  instead of on every boot (PSA1). New one-shot cleanups should follow the same
  `currentVersion < N` gating rather than running unconditionally.
- Schema files in `db/` for reference only
- Key tables: `teller_enrollments`, `linked_accounts`, `transactions`,
  `transaction_splits`, `detected_subscriptions`, `recurring_transfers`,
  `user_settings` (single-row), `financial_insights`, `financial_goals`,
  `net_worth_snapshots`, `tax_deductions`, `csv_imports`, `budgets`, `budget_snapshots`,
  `push_subscriptions`, `webauthn_credentials`, `investment_accounts`, `investment_holdings`,
  `plaid_investment_items`, `plaid_items`, `sync_cursors`, `schema_migrations`,
  `categorization_rules`, `manual_bills`, `bill_payments`,
  `payee_obligations`, `payee_payments` (Rent & Utilities ledger), `notification_log`,
  `ai_audit_log`, `account_balance_snapshots`, `watchlist_items`, `credit_scores`,
  `job_runs` (scheduled-job heartbeats — one row per background job, UPSERTed by
  `services/job-health.js`; `last_status` / `last_error` hold the last run's
  outcome; the `_watchdog` row stores the last-notified
  missed-job signature; `last_ran_at` (cycle-8 E2a) is when the job runner last
  claimed the job — distinct from `last_run_at`, the heartbeat tick), `investment_flows` (external cash flows for
  TWR/XIRR — polymorphic (source, source_id) like account_balance_snapshots,
  signed amount (positive = into the portfolio), provenance 'plaid' (UNIQUE
  plaid_investment_transaction_id) or 'manual'), `investment_transactions` (roadmap T3.3
  K1 — every Plaid investment transaction of a tracked account, written by the flow sync:
  `plaid_investment_transaction_id` UNIQUE, `investment_account_id` (no FK, like
  investment_flows), `txn_date`, `type` / `subtype` (lowercased), the security
  (`security_id`, `ticker`, `security_name`, `security_type`), `quantity` / `price`
  NUMERIC(24,8), `amount` / `fees` NUMERIC(18,4) in Plaid's sign (positive = cash out),
  `name`, `cancel_transaction_id`; read by services/tax-investments.js; in reset-fresh's
  WIPE_TABLES), `benchmark_prices` (S&P 500 daily closes cached from
  Stooq by `services/benchmarks.js` — PK (symbol, price_date); read by
  `GET /api/investments/performance-history`)
- `user_settings`: single-row pattern (CHECK id = 1) for app preferences
- `linked_accounts` loan/debt columns: `apr NUMERIC(5,2)` (manual — also used by
  credit cards) and `monthly_payment NUMERIC(12,2)` (manual, loans) drive the
  loan payoff projection; Plaid Liabilities never reports auto-loan terms.
- `linked_accounts.last_statement_balance NUMERIC(12,2)` + `last_statement_issue_date DATE` (roadmap
  T4.1 A8): a credit card's last statement from Plaid Liabilities (`syncPlaidLiabilities`; a $0 statement
  kept); NULL for Teller-linked and manual cards. Read by the cash plan's statement-date utilization tip and
  carried-balance test. Auto-migrated.
- `linked_accounts.low_balance_floor NUMERIC(12,2)` (roadmap T2.2 L4): the cash alerts'
  per-account current-balance floor (NULL = none; settable only on a depository,
  non-investment account). Auto-migrated; kept by `npm run reset:fresh` (linked_accounts
  is a KEEP table), while the cash alert switch in user_settings is reset.
- `linked_accounts` columns include: `is_shared BOOLEAN`, `spending_split_pct INT DEFAULT 100`,
  `is_manual BOOLEAN` — constraint `chk_account_source` (rebuilt only when missing or lacking
  `is_manual` — PSC-13, it used to be dropped + re-added with a full rescan on every boot)
  allows `plaid_item_id IS NOT NULL OR
  teller_enrollment_id IS NOT NULL OR is_manual = true`
- `transactions` user-edit columns (Phase B1/B2/B4): `user_merchant_name TEXT` and
  `user_notes TEXT` hold user overrides separately from the raw Teller fields so a
  re-sync doesn't clobber them; `is_reimbursed BOOLEAN DEFAULT false` and
  `reimbursed_at TIMESTAMPTZ` flag transactions that the user (or an employer)
  paid back, which excludes them from every spending aggregation.
  Index `idx_transactions_reimbursed` is partial (only indexes rows where
  is_reimbursed = true) to keep the common false case cheap.
  Phase B4: `user_category TEXT` holds category overrides. `PATCH
  /api/transactions/:id/category`, bulk-category, AND every `/api/categorize`
  write path — user rules, the Teller-map fast path, the AI fallback, and
  `POST /api/categorization-rules/apply` — write here (NOT `category`), so a
  Teller/Plaid re-sync — which UPSERTs `category = EXCLUDED.category` — can't
  overwrite them. (Writing to scalar `user_category` means the rule/AI values
  are stored as plain strings, not the `category[]` array literal.) Display
  layers use `COALESCE(user_category, category[1])` everywhere, including the
  categorize candidate filter so already-categorized rows aren't re-sent to AI.
  Categorization provenance + accuracy: `user_category_source TEXT`
  (`'ai'|'rule'|'teller_map'|'plaid_map'|'manual'|'review'`) records HOW `user_category`
  was set; `category_verified_at TIMESTAMPTZ` + `category_was_correct BOOLEAN`
  capture the user's verdict when reviewing a sampled AI categorization. The
  accuracy sampler (`GET /api/categorize/accuracy[-sample]`,
  `POST /api/categorize/accuracy-review`) targets `user_category_source = 'ai'`
  (partial index `idx_txn_cat_source_ai`) and a "wrong" verdict keeps the row
  `'ai'`-sourced so the miss counts in the running accuracy %, while the
  corrected category still wins via `user_category`. Re-categorizing a row
  clears the prior verdict. `ai_skipped_at TIMESTAMPTZ` (cycle-7 F54): stamped on
  a row the AI batch saw but left unanswered; the AI pass skips it for
  `AI_SKIP_RETRY_DAYS` (30) — rules, the free maps and the Review widget still
  reach it. Auto-migrated.
- `deleted_transactions` (cycle-7 F20): `transaction_id TEXT PRIMARY KEY` +
  `deleted_at` — ids the user deleted via `DELETE /api/transactions/:id`; the
  Teller and Plaid upserts and the CSV import / CLI skip them. Roadmap T2.5 U1 adds
  `snapshot JSONB` (`{ row: to_jsonb(transaction), splits: [...] }`, written by the
  DELETE; NULL on an older tombstone) and `source TEXT` (teller / plaid / csv / manual).
  Cycle-8 F6 adds `bank_changed_at` / `bank_removed_at TIMESTAMPTZ` (stamped by Plaid's
  modified / removed deliveries for a tombstoned id; read by restore). Cycle-8 E1c adds `batch_id TEXT`
  (the CSV-overlap Resolve that wrote it — one id per Resolve, NULL for a single delete; a partial
  index). Restore deletes the row. In reset-fresh's WIPE_TABLES.
- `transaction_splits` (Phase B3): subdivides a single Teller transaction into
  multiple `(amount, category, merchant_name, notes)` rows that REPLACE the
  parent in per-category aggregations. `parent_transaction_id` references
  `transactions(transaction_id)` with `ON DELETE CASCADE`. Indexed by parent.
- `transactions.personal_for TEXT` (CHECK `personal_for IS NULL OR
  personal_for IN ('self','partner')`): per-transaction settlement override
  for shared cards. `NULL` = use the account's `spending_split_pct`;
  `'self'` = user owes 100% of the charge; `'partner'` = the other
  cardholder owes 100%. Only honored when the linked account is
  `is_shared = true`; on non-shared accounts the SPLIT_AMOUNT formula
  falls back to the spending_split_pct path regardless of value. Set
  via `PATCH /api/transactions/:id { personal_for: 'self'|'partner'|null }`
  (invalid values silently coerced to NULL).
- `user_settings.partner_name TEXT`: display name for the other
  cardholder on a shared card. Surfaces in the Settlement widget
  ("Sarah owes you $X" rather than "Partner owes you $X") and is
  returned by `GET /api/shared-settlement`. NULL/empty falls back to
  literal "Partner". Set via `PATCH /api/settings { partner_name }`,
  max 50 chars.
- `financial_goals` funding columns (Phase C): `funding_account_id INT REFERENCES
  linked_accounts(id)`, `funding_investment_id INT REFERENCES investment_accounts(id)`,
  `goal_baseline_amount NUMERIC(14,2)`. CHECK `chk_goal_funding_exclusive`
  enforces that at most one of the two FK columns is non-null. When a funding
  source is linked, GET `/api/goals` computes `current_amount =
  account_balance - goal_baseline_amount` instead of returning the stored value.
- `user_settings` Phase A auto-sync: `auto_sync_enabled BOOLEAN DEFAULT false`,
  `auto_sync_interval_hours INT DEFAULT 6`, `last_auto_sync_at TIMESTAMPTZ`.
  Drives the in-process scheduled sync task in `server.js`.
- `user_settings` includes Per-sistant config: `persistent_url TEXT` (validated
  on PATCH — http(s), no credentials, ≤500 chars, cycle-7 F82),
  `persistent_webhook_secret_enc BYTEA` (encrypted at rest with `pgp_sym_encrypt`,
  same passphrase as Teller/Plaid tokens), `persistent_webhook_enabled BOOLEAN`
- `user_settings.last_anomaly_txn_id BIGINT` + `last_anomaly_check_at TIMESTAMPTZ` — the
  post-sync anomaly notifier's watermark (cycle-8 E2c, `services/txn-watermark.js`): the
  newest `transactions.id` and the database time read BEFORE the candidates, which stop at
  that id. Candidates are rows above the stored id plus rows at or below it created within
  24 h of the stored time (a transaction open at the last check commits a lower id later);
  a charge whose `transaction_id` is already in an anomaly notification's `data` (30 days)
  is skipped, so the overlap never re-pushes. Both move forward only (GREATEST). If a push
  throws or isn't logged, the watermark is held back so the next sync re-considers the same
  candidates (the logged ones are skipped then). The id was backfilled once from the time
  watermark (the newest id created at or before it). (Cycle-8 F1's mark — the newest
  created_at, bounded by pg_stat_activity — is gone.)
- `user_settings.last_dashboard_view_at TIMESTAMPTZ` — watermark for the
  "Since you last looked" dashboard widget. Read by `GET /api/whats-new`
  to scope the response (new txns / new subs / balance deltas /
  notifications since this timestamp). Bumped by `POST /api/whats-new/seen`,
  which the widget fires 4 s after first render so a quick nav-away
  doesn't lose the unseen state — to the time in the GET's `seen_token`
  (forward only, capped at now(); a token-less POST sets now()). Beside it
  `last_dashboard_view_txn_id BIGINT` (cycle-8 E2d): the newest transaction
  id that GET read; new transactions are `id >` it (NULL — no backfill —
  reads by created_at until the first token). Defaults to "24 h ago" on first load
  so brand-new installations return one day of context rather than
  an empty card.
- `user_settings.weekly_digest_enabled BOOLEAN NOT NULL DEFAULT false`,
  `weekly_digest_day INT NOT NULL DEFAULT 1` (0=Sun..6=Sat),
  `last_weekly_digest_at TIMESTAMPTZ`: opt-in standing weekly-summary
  email channel (S2). Independent of the per-insight
  `insights_generated` email. Toggle + day selector live in Settings →
  AI Insights. The hourly scheduler in `startup.js` calls `runWeeklyDigest()`
  on the configured day; the helper gates on a 6-day window from
  `last_weekly_digest_at` to dedupe multiple ticks within the day.
- `user_settings.daily_digest_enabled BOOLEAN NOT NULL DEFAULT false`,
  `last_daily_digest_at TIMESTAMPTZ`: opt-in once-per-day "yesterday's
  activity" email channel (#19). Toggle in Settings → AI Insights. The
  hourly scheduler calls `runDailyDigest()`; the helper sends at most once
  per APP_TIMEZONE date, not before 07:00 local, covering the time since
  `last_daily_digest_at` (≤72h), and skips silently when `gatherWhatsNew`
  returns zero counts (AIN-15).
- `user_settings.last_csv_reminder_at TIMESTAMPTZ` (PSC-3): watermark for the
  hourly CSV-reminder tick — the reminder is evaluated at most once per 24h
  (stamped whether or not any account was stale). Auto-migrated
  (`ADD COLUMN IF NOT EXISTS`).
- `user_settings.insight_emails_enabled BOOLEAN NOT NULL DEFAULT true` (cycle-7
  F81): when false, an insight run doesn't send its `insights_generated` email.
  Settings → AI Insights toggle; PATCH takes a strict boolean (400 otherwise).
  Auto-migrated.
- `app_errors` (roadmap T1.4): the in-app error log — `fingerprint TEXT PRIMARY KEY`,
  `source` (perfin / per-sistant / shell / scripts / app), `message` (first line, ≤300),
  `sample` (≤2000 — a stack when there was one), `count`, `first_seen`, `last_seen`,
  `resolved_at` (cleared by a later occurrence), `notified_at`. Written once a minute by
  `services/error-log.js`; pruned daily (resolved >30 days, any >90). In reset-fresh's
  UNTOUCHED_TABLES. Messages can carry merchant or account names — they stay in this
  database; the notification body carries the first 120 characters.
- `webhook_events` (roadmap T2.1): one row per VERIFIED Plaid / Teller webhook —
  `provider` (CHECK plaid / teller), `event_type`, `event_code`, `subject` (item /
  enrollment id), `dedupe_key` (UNIQUE with provider), `status` (CHECK received /
  processing / done / failed / ignored), `error` (a fixed sentence), `received_at`,
  `processed_at`. Never the body. Pruned after 30 days. In reset-fresh's
  UNTOUCHED_TABLES. A row a restart caught mid-handler stays 'processing'.
- `user_settings.cash_alert_enabled BOOLEAN NOT NULL DEFAULT false`, `cash_alert_threshold
  NUMERIC(12,2) NOT NULL DEFAULT 500`, `cash_alert_horizon_days INT NOT NULL DEFAULT 14`,
  `cash_alert_state JSONB` (`{ alert: { breach_date, low_date, low_balance, notified_at } |
  null, last_notified: { breach_date, notified_at } | null (kept across a clear — cycle-8
  F11), last_check: { at, outcome, reason?, breach_date?, floors_below } }`) and `cash_alerts_checked_at
  TIMESTAMPTZ` (roadmap T2.2 L2 — the low cash alert's settings, dedup state and last
  evaluation; services/cash-alerts.js). Auto-migrated; reset by `npm run reset:fresh`.
- `user_settings.payday_alerts_enabled BOOLEAN NOT NULL DEFAULT false`,
  `last_income_alert_at TIMESTAMPTZ` and `last_income_alert_txn_id BIGINT` (roadmap T2.2
  L3; the id since cycle-8 E2c): the payday alerts' switch and the "Paycheck landed"
  watermark — the newest transaction id and the time of the last check (the overlap is
  measured from it); both set to now / the newest id when the switch goes on, so older
  deposits aren't announced. The id was backfilled once from the time. Auto-migrated.
- `user_settings.advice_alerts_enabled BOOLEAN NOT NULL DEFAULT false` and `advice_state JSONB`
  (roadmap T4.1 A4): the plan-change alert's switch and its state — `{ signature: { step, target,
  unit, amount, amount_monthly, at } | null, windfalls_seen: [key] (A6), checked_on, notified_at?,
  last_check: { at, outcome, kind? } }` (the signature is the plan last notified, or the first baseline). Auto-migrated; reset
  by `npm run reset:fresh` (the user_settings row is re-created).
- `user_settings.contribution_limits JSONB NOT NULL DEFAULT '{}'` (roadmap T4.1 A10): yearly contribution
  limits entered by hand — `{ "investment:<id>" | "linked:<id>": dollars }` (investment_flows' source + id; the
  Settings editor keys a GET /api/investments "teller" account linked:<id>, Plaid / manual investment:<id>). Read
  by the cash plan's `contributions` source. Auto-migrated; reset by `npm run reset:fresh`.
- `user_settings.linked_tasks_enabled BOOLEAN NOT NULL DEFAULT false`,
  `linked_tasks_sources JSONB NOT NULL DEFAULT '{"still_charging": true, "housing": true,
  "utility_amount": true, "bills": false}'`, `linked_tasks_bill_lead_days INT NOT NULL
  DEFAULT 3` and `linked_tasks_state JSONB` (roadmap T2.4 X2a — linked tasks: the switch,
  the sources (decision 5: manual bills off), how many days ahead a manual bill's task
  opens, and the last run's record, written by the X2b runner). Auto-migrated; reset by
  `npm run reset:fresh`. Edited in Settings → Per-sistant Tasks (X2c), which shows the
  record as its last-run line. A source added later (T3.3 K2's `tax_documents`, default
  on) isn't in the stored default — `effectiveSources` fills it in, and GET
  /api/settings returns that merged map.
- `tax_documents` (roadmap T3.3 K2): the tax documents checklist — `tax_year` (CHECK
  2000-9999), `form` (CHECK the services/tax-documents FORMS list), `issuer` (default ''),
  `expected_by` DATE, `received_at` DATE, `dismissed_at`, `origin` (CHECK suggested /
  manual), `notes`, timestamps; UNIQUE INDEX (tax_year, form, LOWER(issuer)) — the
  suggestions' ON CONFLICT target. In reset-fresh's WIPE_TABLES.
- `user_settings.last_backup_at TIMESTAMPTZ` (VPS move) + `last_backup_source TEXT`
  (cycle-8 E4a — `server` / `github`): stamped by `deploy/vps/backup.sh` and, since E4a,
  by `.github/workflows/db-backup.yml` after each verified backup; read by Operator Checks'
  backup check (`backupCheck`, id local:backup) under `SERVER_BACKUPS=true` and whenever
  the GitHub checks are off. Kept by `npm run reset:fresh`. Auto-migrated.
- `user_settings.operator_checks_signature TEXT` (cycle-7 G1 + ST4): the sorted ids of
  the warn / fail operator checks last notified — `notifyIfChanged` pushes only when
  it changes. Auto-migrated.
- `user_settings.insights_last_attempt_at TIMESTAMPTZ` (cycle-7 F63): stamped by
  the AI-insights auto-trigger before each attempt; an attempt newer than
  `insights_last_run` blocks a retry for 24 h. Auto-migrated.
- `user_settings.target_allocation_pct JSONB NOT NULL DEFAULT '{}'::jsonb`:
  per-asset-class target weights for the Investments performance card.
  Keys are lowercase `security_type` (etf, equity, bond, etc.); values
  are 0-100 numeric. `GET /api/investments/performance` joins these to
  the actual portfolio breakdown and emits `target_pct` + `drift_pct`
  per asset class. Empty `{}` → no drift fields on the response. Set
  via Settings → Target Allocation form.
- `user_settings` FIRE assumptions: `fire_expected_return_pct NUMERIC(5,2)`
  (annual real return, 0-20, default 5 when NULL),
  `fire_withdrawal_rate_pct NUMERIC(5,2)` (safe withdrawal rate, 1-10,
  default 4 when NULL), `fire_monthly_spending_override NUMERIC(12,2)`
  (optional retirement-spending override; NULL = use trailing completed-month
  average). Read by `GET /api/fire-projection` (goals.js) and the ask.js
  `get_fire_projection` tool; editable inline on the Goals-page FIRE card
  via `PATCH /api/settings`.
- `user_settings` data freshness: `last_txn_sync_at TIMESTAMPTZ` (updated by
  `POST /api/sync`), `last_balance_sync_at TIMESTAMPTZ` (updated by
  `POST /api/sync-balances`). The nav badge uses the most recent of these plus
  `last_auto_sync_at` to display staleness.
- `user_settings.last_sheets_sync_result JSONB` (SXE-1): the outcome of the
  most recent Google Sheets `syncAll` — `{ at, ok, tabs_failed, errors: [{ step,
  error }] }`. Written by `recordSheetsSyncResult()` (routes/settings.js) from the
  scheduled auto-sync and `POST /api/sheets/sync`; read by `GET /api/data-health`
  (issue on failed tabs), `GET /api/settings` and the Settings "Last Auto-Sync"
  line. A change in the failing-tab set notifies once (tag `sheets-sync`).
  Auto-migrated (`ADD COLUMN IF NOT EXISTS`).
- `user_settings.last_sync_result JSONB` — structured summary of the most recent
  run of EACH sync provider: `{ at, errors: [{ provider, institution, error }],
  providers: { <provider>: { at, errors } } }`. `errors` is the flat union across
  providers (what data-health + the auto-sync signature diff read). Written by
  `recordSyncResult()` (`routes/enrollments.js`), which MERGES per provider (BSI-11):
  each call replaces only the providers it passes (a null result = step not run →
  prior entry kept), so daily-sync's /api/sync-balances no longer wipes the Teller
  errors /api/sync wrote seconds earlier. A legacy flat payload is regrouped by
  provider on the next write. Provider keys: `teller_txn`, `plaid_txn`,
  `teller_balance`, `plaid_balance`, `plaid_holdings`, `plaid_flows`, `plaid`
  (wholesale throw), `teller_reconcile`, `plaid_reconcile`. Writers:
  `POST /api/sync`, `POST /api/sync-balances`, the bank auto-sync, reconcile
  (manual + weekly). A provider's errors persist until THAT provider runs again. Surfaced by `GET /api/data-health` as `issues[]` + the
  raw `last_sync_result`, so a per-item error that does NOT disconnect an
  enrollment — notably `decryption_failed` (passphrase mismatch) — is visible in
  the Sync Health card instead of staying silent on scheduled runs (addition D).
  A PARTIAL Teller failure (one account in an enrollment fetched cleanly, a
  sibling threw, so the watermark was held back per INV-02) surfaces as
  `partial_sync_incomplete` here too, instead of the enrollment reporting a clean
  success — `enrollments_synced` counts it as synced (it did connect) but the
  errors[] entry flags that a range still needs a retry (F15).
  The auto-sync fires a one-shot "Sync error" notification only when the error
  signature CHANGES, so a persistent mismatch doesn't spam hourly. A *wholesale*
  Plaid balance/holdings throw inside `POST /api/sync-balances` (vs. the per-item
  errors the helpers collect) is also captured into `last_sync_result` now, so a
  total Plaid failure surfaces on the Sync Health card instead of only the log
  (BS-6). Cycle-7 F23: a helper's `{ ok:false, error }` with no `errors[]`
  (wholesale holdings / flows failure) is recorded as one error entry, a THROWN
  step (auto-sync, weekly reconcile, a Teller throw in sync-balances) is recorded
  via `thrownSyncResult`, and "Plaid not configured" is skipped so it neither
  looks like a failure nor wipes that provider's last real outcome.
- `user_settings.shell_idle_timeout_minutes INT NOT NULL DEFAULT 60`: how
  many minutes of inactivity before the unified-shell PIN is required again
  (sliding window — every authenticated request resets the timer). Read by
  `shell/middleware/auth.js` with a 60s in-memory cache; the cache is
  invalidated on `PATCH /api/settings` via a hook the shell registers on
  Perfin's Express app. Bounded 5–10080 minutes (5 min … 7 days) at the
  PATCH layer.
- `user_settings.shell_session_epoch INT NOT NULL DEFAULT 0` (cycle-7 F12): the
  shell session epoch, read with the idle window. "Sign Out Everywhere"
  (`POST /logout?everywhere=1`) increments it, which invalidates every shell cookie
  minted before. Not settable via `PATCH /api/settings`. `npm run reset:fresh`
  resets it to 0 (follow-on).
- `budgets` rollover columns: `rollover_enabled BOOLEAN DEFAULT false`,
  `budget_type TEXT DEFAULT 'recurring'` (recurring or one_time),
  `effective_month TEXT` (YYYY-MM, only used for one_time budgets).
- `budget_snapshots`: monthly spending snapshots per budget for trend analysis.
  Columns: `budget_id`, `month` (YYYY-MM), `monthly_limit`, `spent`, `rollover_amount`.
  UNIQUE on (budget_id, month). Created via `POST /api/budgets/snapshot`.
- `categorization_rules`: persistent merchant→category rules. Columns: `merchant_pattern`,
  `category`, `match_type` (contains/exact/starts_with), `is_active`, `times_applied`.
  UNIQUE on (merchant_pattern, category). Applied before AI in `POST /api/categorize`.
- `merchant_rename_rules` (cycle-7 F55 / ST2): `merchant_pattern`, `match_type`
  (CHECK exact/starts_with/contains, default exact), `rename_to`, `is_active`,
  `times_applied`, timestamps; UNIQUE (merchant_pattern, match_type). Rows a rule
  renamed carry `transactions.user_merchant_rule_id INT` (NULL for a hand rename).
  In reset-fresh's WIPE_TABLES.
- `detected_subscriptions` watchdog columns (cycle-7 F53 / G5): `still_charging_txn
  TEXT`, `still_charging_at DATE`, `still_charging_amount NUMERIC(12,2)` (the last
  post-cancel charge alerted) and `price_alerted_amount NUMERIC(12,2)` (the price
  last alerted). Auto-migrated.
- `manual_bills`: user-created expected charges for the bill calendar. Columns: `name`,
  `amount`, `due_day` (1-31), `cadence` (monthly/quarterly/yearly), `category`,
  `is_active`, `notes`. Integrated into `/api/bill-calendar` and `/calendar.ics`
  via one placement rule (`cadence.manualBillOccurrences`: the series anchors on
  the `created_at` month + `due_day`, clamped to each month's length).
- `watchlist_items`: user-curated list of merchants / categories /
  keywords to monitor. Columns: `type` (CHECK enum: `merchant`,
  `category`, `keyword`), `value`, `notes`, `is_active`. UNIQUE
  on (type, value) so POSTing an existing item re-activates it
  rather than failing. Edited via Settings → Watchlist; rendered
  into the Watchlist sheet tab with the last 90 days of matching
  transactions on each Sheets sync.
- `credit_scores`: manual-entry credit score history. Columns: `score` (INT,
  CHECK 300-850), `score_type` (CHECK: fico/vantagescore/other), `source`,
  `notes`, `checked_at` (DATE). UNIQUE on (checked_at, score_type) so
  same-day re-entry upserts. Dashboard widget renders current + trend;
  AI insights sees the last 6 entries. Synced to Google Sheets "Credit
  Scores" tab with per-entry Change column.
- `recurring_transfers.transfer_type_user_set BOOLEAN NOT NULL DEFAULT false`
  (DC-4): set by `PATCH /api/recurring-transfers/:id/type`; while true the
  detector's upsert keeps the stored `transfer_type` instead of the keyword
  classifier's. Idempotent ADD COLUMN — no backfill (pre-existing user edits
  stay unflagged until re-set once).
- `recurring_transfers.forecast_treatment TEXT NOT NULL DEFAULT 'auto'` (CHECK auto / bill /
  internal / ignore, its list in `CHECK_LISTS`) and `detected_subscriptions.forecast_ignore
  BOOLEAN NOT NULL DEFAULT false` (cycle-8 E1a, G1): the user's correction of the cash-flow
  forecast (services/cash-flow.js transferTreatment / classifyBills). Written only by the two
  PATCH …/forecast routes — never by the detectors. Auto-migrated.
- `bill_payments`: tracks which bills have been paid. Columns: `bill_source`
  (subscription or manual), `bill_id`, `paid_date`, `paid_amount`, `notes`.
  UNIQUE on (bill_source, bill_id, paid_date). Calendar shows paid state.
  `paid_amount` defaults to the bill's amount when the POST omits it (SXE-11);
  rows written before that stay NULL.
- `payee_obligations`: Rent & Utilities ledger rows. Columns: `payee`,
  `category` (CHECK rent/utility/other), `label` ('Rent', 'Electricity', …),
  `period` (YYYY-MM), `amount NUMERIC(12,2)` (NULL = awaiting bill),
  `due_day` (1-31), `status` (CHECK `pending_amount`/`unpaid`/`paid`),
  `paid_payment_id` (FK-by-convention to `payee_payments` — the route reverts
  status on payment delete, no DB cascade), `notes`, `auto_generated`. UNIQUE
  (payee, period, category, label) so monthly generation is idempotent.
  Balance owed = SUM(amount) WHERE status='unpaid'.
- `payee_obligation_skips` (cycle-7 F33): `(period, category, label)` PRIMARY KEY
  + `created_at` — an auto-generated obligation the user removed; generation skips
  it, a hand-added obligation with the same key clears it, a utility label rename
  renames it. In reset-fresh's WIPE_TABLES.
- `payee_payments`: a transfer settling a batch of obligations. Columns:
  `payee`, `paid_date`, `amount`, `memo` (auto-derived from covered months when
  blank). Obligations point back via `paid_payment_id`.
- `settlements`: settle-up log for the dashboard Settle Up widget — one row per
  month the user marks squared with the partner. Columns: `period` (YYYY-MM,
  UNIQUE so re-marking upserts), `net_amount`, `direction`
  (`you_send_partner`/`partner_sends_you`/`square`), `note`, `settled_at`.
  Written by `POST /api/settlement/settle`, read by `GET /api/settlement`,
  cleared by `DELETE /api/settlement/:period`. Display-only state — does not
  alter the underlying shared-card or housing math.
- `user_settings.housing_config JSONB NOT NULL DEFAULT '{}'`: Rent & Utilities
  config — `{ enabled, payee_name, rent_amount, rent_due_day, reminder_lead_days,
  start_month, utilities: [{label, cadence_months, due_day, anchor, merchant_patterns[]}],
  split: {enabled, partner_name, car_loan_account_id, car_fixed_amount} }`. Read
  by `routes/housing.js getConfig()`; drives monthly obligation generation +
  reminders + the partner even-up split (`GET /api/housing/split`). `start_month`
  is preserved across edits (generation covers the trailing 24 months, FAN-3);
  `merchant_patterns` (≤8 statement names, FAN-10) feed the Settle Up
  double-count guard; a utility's `anchor` is kept across edits/renames and a
  new utility is anchored at the current month (FAN-4);
  `car_loan_account_id` references a `linked_accounts.id` (type='loan') whose
  `monthly_payment` is the car amount.
- `notification_log`: in-app notification history. Columns: `type`, `title`, `body`,
  `data` (JSONB), `is_read`. `sendToAll()` inserts here on every push notification.
  Indexed on (is_read, created_at DESC) for fast unread queries. Cycle-8 E3a adds
  `push_state TEXT` (CHECK sent / held / muted / covered / none / expired, its list in
  `CHECK_LISTS`) and `item_key TEXT` (the real-world item, e.g. `housing:<period>` — the
  linked-task key without `perfin:`). `push_state` is written by every sendToAll
  since E3b (NULL on older rows); `item_key` since E3d — on the rent, utility-amount and
  still-charging pushes (NULL otherwise).
- `user_settings.notify_quiet_hours JSONB NOT NULL DEFAULT '{"enabled": false, "start":
  "22:00", "end": "07:00"}'` and `notify_muted_types JSONB NOT NULL DEFAULT '[]'` (cycle-8
  E3a, G2): quiet hours on the APP_TIMEZONE clock and the muted notification kinds
  (services/notify-prefs.js). Perfin owns them for both apps (Per-sistant reads them
  read-only through perfinPool since E3c). Auto-migrated; reset by `npm run reset:fresh`.
- `ai_audit_log`: post-generation insight validation results. Columns: `insight_id`
  (FK to financial_insights), `module`, `severity` (critical/warning/info),
  `check_type` (tier1-4), `claim_text`, `expected_value`, `actual_value`.
  Indexed on (insight_id, severity).
- `financial_insights.entry_type TEXT NOT NULL DEFAULT 'insight'`: discriminator
  that lets `/api/categorize` (`'categorize'`) and `/api/insights/rebuild`
  (`'rebuild'`) write their AI usage rows to the same table without
  shadowing the user-facing "AI Insights" feed. Display queries (`GET
  /api/insights`, the previous-insight reference inside `POST /api/insights`,
  the `/api/insights/rebuild` source timeline) filter `entry_type = 'insight'`.
  The shared monthly-budget cost queries do NOT filter — `'insight'`,
  `'categorize'`, AND `'rebuild'` rows all count toward
  `INSIGHTS_MONTHLY_BUDGET_CENTS`. Without this, categorize and rebuild were
  read-only against the cap (checked it but never charged themselves).
- `financial_insights.user_feedback TEXT`, `user_feedback_text TEXT`,
  `user_feedback_at TIMESTAMPTZ`: per-row trust-loop signal set by the
  dashboard's thumbs-up/down/mixed buttons. `user_feedback` is enum-guarded
  via `CHECK (user_feedback IS NULL OR user_feedback IN ('positive',
  'negative', 'mixed'))`. `generateInsights()` pulls the latest 5 rated
  insights and renders them into the next prompt under a
  `=== USER FEEDBACK ON RECENT INSIGHTS ===` block so Claude can adjust.
  Cleared by passing `feedback: null` to `PATCH /api/insights/:id/feedback`.
- `financial_insights.audited_at TIMESTAMPTZ`, `audit_incomplete BOOLEAN NOT
  NULL DEFAULT false`: per-run audit completion marker (AI-5/AI-6). `auditInsight`
  stamps `audited_at = now()` after running all four tiers and sets
  `audit_incomplete = true` when any tier's DB query threw (and thus produced
  no findings). `getAuditAccuracy` counts only `audited_at IS NOT NULL AND NOT
  audit_incomplete` runs in its clean/total tally, so a genuinely-clean run
  (audited, zero findings) is distinguishable from one that was never audited
  or failed silently — the latter surface as `incomplete_runs`.
- `user_settings.insights_running_summary_json JSONB`: structured AI long-term
  memory — `{ trends, completed_goals, pending_actions, alerts }`. Replaces the
  legacy plain-text `insights_running_summary` (TEXT column still populated
  with a human-readable rendering for backward compat). Written by every
  successful POST `/api/insights` and cleared by POST `/api/insights/reset`.
  Validated through `sanitizeStructuredSummary` (max items per array, string
  length caps, enum guardrails) so a pathological tool response can't pollute
  long-term memory.
- `account_balance_snapshots`: daily per-account balance history for charting
  performance over time. Columns: `source TEXT CHECK IN ('linked','investment')`,
  `source_id INT`, `snapshot_date DATE`, `balance NUMERIC(14,2)`,
  `available_balance`, `current_balance`. UNIQUE (source, source_id,
  snapshot_date) so intra-day re-syncs upsert one row per account per day.
  Polymorphic source — `'linked'` references `linked_accounts.id` (covers
  Teller-linked accounts), `'investment'` references `investment_accounts.id`
  (covers manual + Plaid). Lack of FK is deliberate — both source tables
  exist independently. Written from `syncAllBalances` and the Plaid
  `/api/plaid/sync-holdings` path; read by `GET /api/accounts/:id/balance-history`.
  Plaid sync collects its per-account snapshot rows during the sync loop and
  flushes them as a single batched INSERT … ON CONFLICT DO UPDATE so either
  all of today's Plaid snapshots land or none do; Teller's `syncAllBalances`
  still inserts per-row.

## Recurring Transfer Detection
Transfers are identified by keyword matching on merchant_name/name fields:
- **peer_transfer**: zelle, venmo, cash app, paypal
- **bill_payment**: autopay, minimum payment, credit card payment, loan payment, mortgage payment
- **savings**: savings, emergency fund
- **investment**: vanguard, fidelity, schwab, robinhood, betterment, 401k
- **internal**: funds transfer, ach transfer, wire transfer, online transfer
- Merchant grouping uses `COALESCE(user_merchant_name, merchant_name, name)`
  (parallel to subscription detection) so user-merged merchant variants share a
  single recurring-transfer entry instead of fragmenting across raw merchant strings.
- Detection algorithm reuses subscription detection helpers (findModeAmount, isStale)
  with wider 15% amount tolerance and 7/14-day cadences for weekly/biweekly patterns
- Cadences ≥60 days (bi-monthly, quarterly, yearly) require only 2+ occurrences
  (1 matching gap); shorter cadences (7/14/30) require 3+ occurrences. Both the
  occurrence floor and the matching-gap threshold gate on `>= 60` — previously
  the gap threshold was `>= 90`, so a 60-day transfer still demanded 3 occurrences
  and the 2-occurrence allowance was unreachable (F4).
- A row is included when its merchant key OR (cycle-7 F49) its raw description
  — read only when not renamed — matches: the description is matched against the
  phrase-like types only (peer apps except PayPal, bill payments, internal
  transfers; `classifyTransferDescription`), so "ZELLE TO JOHN SMITH" is a
  `peer_transfer` while "PAYPAL *NETFLIX" and brand words (Vanguard, Schwab,
  savings) stay merchant-only. The group's type is the merchant key's, else the
  most common per-row type.
- Outgoing and incoming transactions analyzed as separate streams
- Outgoing recurring transfers integrated into cash flow forecast
- User-dismissed transfers are preserved across detection runs: the upsert's
  `is_active` CASE checks `is_dismissed` and keeps dismissed transfers inactive,
  mirroring the subscription detection logic; Undismiss sets `is_active = true`
  again (cycle-7 F56)
- Stale patterns (last transfer past `max(120d, 1.5×cadence)`, the stale sweep's
  window) are skipped before the upsert (DC-2, shared `isStale` helper), so a
  long-stopped transfer isn't re-activated from 36 months of history
- A user's reclassification sticks (DC-4): `PATCH /api/recurring-transfers/:id/type`
  sets `recurring_transfers.transfer_type_user_set = true`, and the upsert keeps
  the stored type for such rows (`CASE WHEN transfer_type_user_set THEN …`); only
  auto-classified rows follow the keyword classifier
- `next_expected` steps by calendar month for month-scale cadences
  (`services/cadence.js`, DC-9); 7/14-day cadences step in days

### Detection-key migration window
Subscription and transfer detection now key on
`COALESCE(user_merchant_name, merchant_name, name)`. Pre-existing rows in
`detected_subscriptions` and `recurring_transfers` keyed by the raw
`merchant_name` will not match the new key, so on the first detection run
after the upgrade a user with active `user_merchant_name` overrides may see
a parallel duplicate row appear under the new (merged) name.

A one-time cleanup runs ONCE during the v3 schema upgrade (gated on
`currentVersion < 3`, PSA1 — previously it ran on every startup): it
deactivates any subscription/transfer row whose `merchant_key` matches
`transactions.merchant_name` AND whose underlying transactions have a
differing `user_merchant_name` override set. This auto-retires the orphans
without waiting for the 120-day staleness sweep. It's gated to run once
because the predicate could otherwise deactivate an unrelated active row if
two distinct merchants share a raw `merchant_name` and one is renamed — and
the orphans only ever arose from the one-time raw→COALESCE key migration, so
re-running it every boot bought nothing but that re-exposure. Users who still
see duplicates after the upgrade (e.g. orphans without matching transaction
rows) can dismiss them from the UI or run `POST /api/cleanup`.

## Security
- **CSP nonces**: Per-request `crypto.randomBytes(16)` nonce for all inline scripts.
  No `'unsafe-inline'` in `scriptSrc`. Nonce passed via `res.locals.nonce` to EJS templates.
  Style policy is split (CSP Level 3): `styleSrcElem` requires the nonce on
  `<style>` blocks (the only such block lives in `partials/head.ejs` and now
  carries `nonce="<%= nonce %>"`). `styleSrcAttr` keeps `'unsafe-inline'` so the
  hundreds of inline `style="..."` attributes across templates continue to
  work; migrating each one is out of scope for now. **Every `<style>` element
  must carry the nonce** — a bare `<style>` in a view, or one injected at
  runtime via `document.createElement('style')`, is silently CSP-blocked (the
  Rent page's whole layout and the rules-panel caret were, WUI-1/WD-14). Put
  page CSS in the head partial's `extraStyles`, a nonced `<style>`, or
  `perfin-shared.css`; pinned by `tests/scan-sept-fixes.test.js`.
- **Shell-layer CSP + clickjacking guard (W1)**: the unified shell (`shell/index.js`)
  mounts its OWN `helmet` so its routes — the PIN `login`, the landing tile picker,
  icons, `/health` — get a nonce-based CSP + `frame-ancestors 'none'` + `X-Frame-Options`
  (previously the shell sent NO security headers, leaving the auth page framable). The
  shell nonce flows to `res.locals.nonce`; the two inline `<script>`s in
  `shell/views/login.ejs` carry `nonce="<%= nonce %>"`. **COOP/CORP/COEP are explicitly
  disabled** in the shell helmet because that middleware runs for sub-app requests too and
  `Cross-Origin-Opener-Policy: same-origin` breaks the Plaid/Teller Link popup/iframe flows
  (which rely on cross-origin `window.opener` postMessage) on Perfin's accounts page. Each
  sub-app still sets its own stricter, vendor-allowlisted CSP, which overwrites this baseline
  for its responses. `helmet` is declared in `shell/package.json` (not just hoisted) so the
  shell boot doesn't depend on a sub-app keeping the dep.
- **Logout clears the shell session (W2)**: under the shell (`window.BASE_PATH` set) Perfin's
  "Sign Out" POSTs the ROOT `/logout` (shell-owned `auth.handleLogout`, clears the
  `shell_session` cookie) and redirects to the root `/login` — both un-prefixed, never
  basePath'd. The earlier `/api/logout` + basePath'd redirect 404'd and left the shell session
  intact. Standalone Perfin (no BASE_PATH) POSTs its own `/api/logout` instead — the root
  `/logout` was a no-op there (WD-16). Per-sistant's embedded "Log Out" does the same: it is
  shown whenever embedded and POSTs the root `/logout` via an absolute URL so the fetch
  wrapper doesn't prefix BASE_PATH (PB-21). The shell cookie is stateless, so a plain
  Sign Out clears only that device's cookie; Settings → Security → **Sign Out
  Everywhere** (under the shell) POSTs the root `/logout?everywhere=1`, which bumps
  `user_settings.shell_session_epoch` and so revokes every session, including a copied
  cookie (cycle-7 F12).
- **COOP on Perfin (cycle-7 F9)**: Perfin's own helmet sets
  `Cross-Origin-Opener-Policy: same-origin-allow-popups` — its default `same-origin`
  overwrote the shell's disabled COOP on every Perfin page, which INV-62 forbids and which
  can sever a Plaid/Teller OAuth popup's opener.
- **Secure cookies + no stack traces (PSC-4)**: the shell session cookie and the WebAuthn
  challenge cookie are `Secure` when `NODE_ENV=production` OR `req.secure` (trust proxy is
  set, so true behind Render's/Fly's TLS proxy; plain-HTTP local runs still work); Perfin's
  session cookie uses express-session `secure: "auto"`. The shell mounts
  `shell/middleware/error-handler.js` last, so errors — including malformed JSON posted to
  `/login` before auth, and anything bubbling out of a sub-app — return a status + short
  message, never Express's default stack-trace page.
- **SHELL_SECRET fail-fast (PSC-11)**: `start()` throws before the sub-apps boot when
  `SHELL_SECRET` is unset (it used to warn, then every correct PIN threw inside the async
  login handler — an unhandled rejection that crash-looped the process); `handleLogin` also
  renders a 500 instead of throwing.
- **Self-authenticating webhook route (PB-15)**: `POST /per-sistant/api/perfin/webhook`
  passes the shell's cookie gate (`isSelfAuthenticatingRoute`) and Per-sistant's standalone
  session check — the receiver verifies an HMAC over the raw body plus a timestamp replay
  window and 503s without a secret. Only that exact method + path is exempt — and, since
  roadmap T2.1, Perfin's `POST /perfin/api/webhooks/plaid` and `/teller` (the Plaid JWT /
  Teller HMAC, 503 while unconfigured; `SELF_AUTHENTICATING_POSTS` in shell/middleware/auth.js).
- **Body limit**: the shell's JSON/urlencoded parsers run first, so their limit is the
  effective one for both sub-apps — 1mb (PSC-7; 64kb overrode Per-sistant's 1mb note limit).
- **Client session-expiry handling (W3)**: `apiFetch` (`perfin-shared.js`) redirects once to
  `/login?return_to=<current path + query>` on a 401 or a followed `302→/login` (loop-guarded),
  so a mid-session idle timeout sends the user to re-auth and back to the same page (return_to
  since cycle-7 F102 — the shell's PSC-9 carry-through) instead of silently rendering a
  blank/error UI.
- **CORS**: Rejects cross-origin requests when `ALLOWED_ORIGINS` not configured
- **API key**: Header-only (`X-API-Key`), no query string support. Standalone
  Perfin's `requireAuth` lets the header through ONLY when `API_KEY` is set
  (cycle-7 F6 — with none set, the key middleware passes everything, so the bare
  header used to bypass a configured PIN/password); standalone `/api/login`
  compares SHA-256 digests (a numeric JSON password used to throw).
- **Secret comparisons never throw (cycle-7 F1)**: every shell secret compare
  (PIN, `CALENDAR_FEED_TOKEN`, `API_KEY`) goes through fixed-length SHA-256
  digests (`auth.safeEqual` / `isValidApiKey`). Express 4 doesn't catch a
  rejected async handler and Node 22 exits on an unhandled rejection, so the
  shell also registers a `process.on("unhandledRejection")` LOGGER — a throwing
  handler now leaves that one request hanging instead of restarting the process
  (which used to reset the in-memory PIN lockout and rate limiters). Boot
  failures still exit via `start().catch`.
- **Public Actions logs (cycle-7 F2)**: while the repo is public its workflow
  logs are world-readable, so no workflow prints a response body. Each job
  defines a `SUMMARY_JS` env snippet (`node -e "$SUMMARY_JS" <file> <keys…>`)
  that prints only the listed keys — numbers/booleans as-is, arrays as a
  count, strings only for keys suffixed `:str`. Net-worth snapshot bodies (the
  per-account breakdown) and subscription names/amounts are never printed;
  details live in Settings → Sync Health. New workflow steps must follow this.
- **Per-sistant integration URL (cycle-7 F82)**: `PATCH /api/settings`
  validates `persistent_url` (`normalizePersistentUrl`: http(s), no embedded
  credentials, ≤500 chars, stored trimmed without a trailing slash; ""/null
  clears; 400 otherwise — private hosts stay allowed for a localhost/LAN
  Per-sistant), every outbound fetch to it uses `redirect: "manual"` (a 3xx
  reads as not-ok — configure the final URL), and the PATCH response drops
  `*_enc` columns (it used to echo `persistent_webhook_secret_enc`).
- **Token encryption**: pgcrypto `pgp_sym_encrypt` for Teller/Plaid access tokens AND the Per-sistant webhook HMAC secret (`persistent_webhook_secret_enc`) at rest, all keyed by `TOKEN_ENCRYPTION_PASSPHRASE`
- **Session**: Secure cookies, configurable timeout, CSRF custom header check.
  The pgSession store only attaches when `AUTH_SECRET` is set
  (`SESSION_PASSWORD` or `SESSION_PIN` configured). Under the unified shell
  (where the shell PIN gate handles auth) and standalone-without-auth
  configurations, the per-app session never gets written, so the in-memory
  default suffices and the `session` table is no longer maintained for nothing.
- **Rate limiting**: General (100/15min), tight (5/1min) for sync/detect, login (10/15min),
  SSO validate (10/15min). Under the shell the general limiter is SKIPPED (the request
  already passed the shell gate; the dashboard alone makes ~35-40 /api calls per load), and
  the tight limiter skips GETs so the 4-second `GET /api/sync/reconcile/status` poll (and the
  workflows' `GET /api/sync/status` polls) isn't
  429'd (PSC-8) — they still apply to a standalone deployment / the sync triggers. Shell layer (the sole auth gate): `authLimiter`
  (10 failed/15min, `skipSuccessfulRequests`) on `POST /login` and the
  biometric `authenticate` endpoint, plus `apiKeyLimiter`
  (20/15min) that counts only FAILED `x-api-key` attempts (skips header-less
  browser traffic; a request with a VALID key never counts, whatever its status —
  `requestWasSuccessful: isValidApiKey`, cycle-8 F30: a backstop workflow's 409s used
  to count and could lock the key out). The pre-auth biometric probes
  (`authenticate-options`, `GET /available`) answer 200 to anyone once a credential
  exists, so `skipSuccessfulRequests` never counted them; they have their own plain
  `webauthnProbeLimiter` (30/min per IP, every request counts) and the outstanding
  challenge map is capped at `MAX_CHALLENGES` (1000, oldest dropped — cycle-8 F28).
  Replaces the prior defenseless single 750ms delay.
- **Shell login redirect guard**: `auth.safeReturnTo()` only allows same-origin
  absolute paths for the post-login `return_to` — it rejects scheme-relative
  `//host` targets and backslash paths, so the login endpoint can't be turned
  into an open redirect (a naive `startsWith("/")` would have let `//evil.com`
  through). It also refuses any control character and any target that leaves the
  origin when resolved like a browser would (cycle-8 F25: "/<tab>/evil.example"
  passed, and the browser — dropping the tab — sent a biometric login to
  //evil.example; the PIN path was safe because res.redirect encodes it).
- **SSO replay protection**: Each SSO token embeds a 12-byte (96-bit) random nonce; validate tracks
  used nonces in an in-memory Map (2-minute TTL cleanup) and rejects duplicates. Nonce is
  consumed after signature verification so timing attacks can't burn legitimate nonces.
  Additionally, the nonce is *reserved* immediately before HMAC verification (atomic
  check-and-set) to prevent concurrent requests with the same token from both passing.
  If signature verification fails, the reservation is released so legitimate nonces
  aren't burned by bad signatures.
- **WebAuthn rpID**: Derived per-request from `req.hostname` (not cached at module scope),
  so deployments behind proxies with multiple hostnames or DNS changes work correctly.
  The shell verify path pins `requireUserVerification: true` on
  `verifyAuthenticationResponse` (matching the `userVerification:"required"` it
  requests) — @simplewebauthn v11 already defaults it true, so this is a
  defense-in-depth pin against a future SDK-default flip (PSA2).
- **WebAuthn transports**: registration persists the authenticator's
  `transports` (`webauthn_credentials.transports TEXT[]` — the Settings register
  flow sends `response.getTransports()`; before WD-13 it sent none, so every row
  was NULL), but BOTH
  authenticate-options endpoints (shell + standalone) deliberately advertise
  `transports: ['internal']` ONLY in `allowCredentials` at login. Registration
  pins `authenticatorAttachment: 'platform'`, so every credential lives on the
  same device — and echoing the authenticator's `'hybrid'` transport (which
  iCloud/synced passkeys report) is exactly what made browsers surface the
  cross-device "use a phone" QR option instead of going straight to Touch/Face
  ID. Internal-only suppresses that QR path and sends the browser to the local
  biometric. (Earlier this echoed the stored transports with an
  `['internal','hybrid']` fallback, which kept the QR option visible — the
  `'hybrid'` advert was the bug.) The real transports are still stored at
  registration; they're just not used as the login hint. Pinned by
  tests/budget-cap-webauthn.test.js.
- **Biometric registration UI**: Settings → Security → "Biometric Login"
  section lists registered credentials and provides Register / Remove
  buttons via the existing `/api/webauthn/*` endpoints. The register
  endpoints accept shell-authenticated requests (`req.app.get("embedded")`,
  INV-25) — they previously checked only Perfin's own session, which is never
  written under the unified shell, so registration always 401'd for shell
  users (found during PWA Phase-0 testing). Section auto-hides
  on browsers without `window.PublicKeyCredential` or when the WebAuthn
  SDK isn't installed (server returns 501). Works under both standalone
  and unified-shell deployments — registration always happens against
  Perfin's webauthn_credentials table; the shell-layer login endpoints
  read from that same pool.
- **Teller API**: mTLS client certificates, retry with exponential backoff (1s/2s/4s) on 5xx/network errors AND 429 rate limits (Retry-After honored, capped at 10s; other 4xx never retried), 30s timeout
- **AI prompt sanitization**: Two layers, with different scopes. First,
  `sanitizeForPrompt()` in `routes/insights.js` strips `---RUNNING_SUMMARY---`
  patterns and consecutive dashes from user-controlled strings (merchant
  names, goal names, transfer display names) before interpolating them into
  the AI prompt. It is **not** a general prompt-injection defense — payloads
  like "ignore previous instructions" pass through unchanged. Its only job
  is neutralizing structural markers that could mimic a parsed delimiter,
  in case the tool_use-replaced delimiter-parsing path ever re-enters the
  codebase. Perfin is a single-operator app, so the only attacker is the
  operator. Second, `sanitizeStructuredSummary()` enforces hard shape/length
  bounds (max items per array, string length caps, enum guardrails) on the
  structured summary the AI returns via tool_use, so a pathological tool
  response can't pollute long-term memory. When validation fails the prior
  summary is preserved and the response carries
  `summary_status: "preserved_validation_failed"`.
- **Subscription matching**: Word boundary regex to prevent false positives

## Scheduled Tasks (the job runner)
All run automatically after server startup — and the CRITICAL ones are
additionally guaranteed out-of-process by GitHub Actions cron (so Render
free-tier sleep can't skip them): `daily-sync.yml` (Teller + Plaid transactions
via /api/sync + balances/holdings/flows + net-worth snapshot + detection, daily
7AM UTC — the two syncs started in the background and polled by job id, cycle-7 ST1) and
`weekly-reconcile.yml` (Teller 90-day reconcile, Sundays — background + polling too). Both hit the
x-api-key'd endpoints; all writes are idempotent so overlap with the
in-process jobs is harmless. Their logs print counts only (`SUMMARY_JS`,
cycle-7 F2 — see Security). **Caveat (cycle-7 scan, F3/F4):** as of Oct 2026
GitHub had disabled Weekly Reconcile, Keep Alive, Job Radar and Database Backup
for inactivity, and every Database Backup run had failed because its secrets were
never set — the backstops exist on paper until the operator re-enables them and
sets the backup secrets (Operator state items 4–5). Since cycle-7 Batch 17 the
Operator Checks in Settings → Sync Health show this state (with a GitHub ops token,
item 6). Per-app jobs live in
`teller/startup.js`; keep-alive runs at the shell layer (`shell/index.js`)
under the unified shell so the timezone-aware self-ping fires regardless of
which sub-app owns its own listener (sub-app `startKeepAlive` is no-op in
embedded mode).
**Activity gate vs. away channels (PSC-3).** The heavy DB jobs are gated on
recent Perfin activity (`isUserActive()`, 15 min) so Neon can auto-suspend
while the user is away. The channels whose whole point is to reach the user
WHILE away — budget alerts (+ critical-alert email), the weekly digest, the
daily digest, the CSV reminder, the Rent & Utilities reminders (F15), the low cash and missed-payday alerts (T2.2 L2 / L3), the linked tasks (T2.4 X2b), the plan-change alert (T4.1 A4) and the quiet-hours release (cycle-8 E3b) — are NOT activity-gated (before, they fired
only if the user had touched Perfin in the last 15 min, so an email-only user
got no digest; Per-sistant traffic never counted). They are driven by their
own watermarks plus a per-local-day (APP_TIMEZONE) in-memory "settled" memo,
so once a job has sent or decided there is nothing to do, it makes no DB call
again until the next local day. Budget alerts run their short query every
3h while the process is awake (an accepted Neon cost). Exported for tests as
`startup._awayJobs`. The bank auto-sync, the self-healing reconcile and the AI
insights auto-trigger aren't activity-gated either; since cycle-8 F29 they skip
their settings read while switched off (the rest of the local day) or not due
(an in-memory next-due time — `notDueYet` / `setNextDue`), and PATCH /api/settings
drops that memo (`startup.invalidateJobMemos`) when `auto_sync_*`,
`insights_enabled` or `insights_cadence_days` changes.
**Due-based runner (cycle-8 E2a / E2b, ST1).** No job is a `setInterval`.
`startBackgroundJobs` registers the watchdog (`job-watchdog`, every 6 h) and the 16
jobs below, lightest first, with `services/job-runner.js` at their `JOB_INTERVALS_MS`
cadences (the "every N hours" below). A job runs when its last run
(`job_runs.last_ran_at`) is older than its cadence: the first check comes 60 s after
boot and reads `job_runs` once, then a check every 5 minutes decides in memory (no
query unless a job is due). So a host that sleeps between requests runs whatever came
due when it wakes, and a short restart doesn't re-run jobs that just ran (the F27
one-shot boot runs, which re-ran every job after any restart, are gone). Due jobs run
ONE AT A TIME, 20 s apart, oldest-due first (on a first boot in registration order) —
a long body (a bank auto-sync, an insights run) delays the jobs behind it. Each run is
claimed with a conditional UPSERT of `last_ran_at`, so two processes (a deploy
overlap) run a due job once; a failed claim runs it anyway. The activity-gated jobs
(goal milestones, budget snapshot, net-worth snapshot, Sheets auto-sync, the
watchdog) carry a `when: isUserActive` gate checked in memory before the claim: while
the user is away they cost no query and stay due, and run at the first check after
the user returns. The away channels carry none (INV-77). A job's own gates,
watermarks, memos and outcome are unchanged. `stopBackgroundJobs` stops the runner
(a check in progress finishes its current job). Test seam: `startup._scheduler`.
**Single-flight (PSC-12).** `syncAllTransactions`, `syncAllBalances` and
`runCategorize` keep a module-level in-flight promise: a caller that arrives
while a run is in progress (the 6-hourly insights chain and the bank auto-sync
fire at the same instant; a manual POST /api/sync or /api/categorize can
overlap either) shares that run's promise and result instead of starting a
second one (which re-sent the same uncategorized rows to Claude).
- **Keep-alive ping** (shell layer): every 14 min (timezone-aware active hours, 10s timeout); reads `keep_alive_enabled` and active-hours through `getKeepAliveConfigCached()` (`services/keep-alive.js`, 6h TTL; `PATCH /api/settings` invalidates it when any `keep_alive_*` key changes — PSC-2). `GET /api/keep-alive-schedule` (polled by `keep-alive.yml` every 14 min with x-api-key) reads the same cache and is EXCLUDED from `touchActivity`, so the GitHub pinger no longer keeps `isUserActive()` permanently true (which ran every activity-gated job 24/7 and stopped Neon suspending). Known gap: the workflow itself still wakes Render every 14 min around the clock.
- **Sheets auto-sync**: every 1 hour (daily/weekly/monthly cadence from settings)
- **Net worth snapshot**: every 1 hour (`ON CONFLICT (snapshot_date) DO UPDATE` so a same-day re-run rewrites the row with the latest balances — late-arriving syncs are reflected immediately). Computes the figure via the shared `getNetWorth()` helper, so this job, `syncAllBalances`, and `POST /api/net-worth/snapshot` all write the same investment-deduped value (F1)
- **Goal milestones**: every 6 hours (push notifications at 25/50/75/100%)
- **AI insights auto-trigger**: every 6 hours (respects `insights_cadence_days` setting;
  `runInsightsAutoTriggerTick` — cap pre-check, `insights_last_attempt_at` stamp,
  24 h retry back-off after a failed attempt, F63).
  Pre-analysis sync chain: syncAllTransactions (Teller → Plaid → one anomaly
  check) → syncAllPlaidHoldings → syncAllBalances → detect subscriptions →
  detect transfers → categorize → generate insights → audit → email webhook.
  Ensures AI analyzes freshest data. Auto-categorization runs as part of this pipeline.
- **Budget alerts**: every 3 hours, NOT activity-gated (push notifications at 80% and 100%+ thresholds, aligned with the in-app `/api/budgets/alerts` `warning`/`critical` levels). The push CALLS `getBudgetStatus` (cycle-7 F40 — it used to re-implement it), so it compares against the effective limit (base + PRIOR-month rollover) and skips one-time budgets outside their `effective_month`; thresholds use the UNROUNDED share (99.5% is a warning, not "exceeded") and the shown % is floored. The in-app `info`/pace heuristic is intentionally not pushed (too noisy as a notification). **Deduped to at most one notification per category+severity per 24h** via `sentRecently(tag, 24)` (`routes/notifications.js`, backed by `notification_log`) — previously a category that stayed over budget re-logged a notification on every 3-hour tick for the rest of the month. Escalation (warn → over) still fires immediately because the two severities use distinct tags.
- **Budget snapshot auto-trigger**: every 6 hours, `runBudgetSnapshot()`
  (`routes/budgets.js`) snapshots the previous month (spending + rollover
  amounts) so budget rollover advances automatically. Days 1–5 of a month
  (`SNAPSHOT_REFRESH_DAYS`, APP_TIMEZONE) it RE-TAKES the prior month (DO
  UPDATE) so charges dated the 29th–31st that post/sync on the 1st–3rd land in
  its spend + rollover (FAN-7 — the snapshot used to freeze on the first tick
  after midnight); after day 5 it only creates a missing snapshot (DO NOTHING),
  the M5 catch-up for a month missed while the process slept. Gated on user
  activity. Trade-off: a limit edited on days 1–5 also rewrites the prior
  month's recorded limit/rollover.
- **Bank auto-sync** (Phase A): every 1 hour, checks `auto_sync_enabled` and whether
  `auto_sync_interval_hours` has elapsed since `last_auto_sync_at`. When due, calls
  `syncAllTransactions()` (Teller then Plaid, one combined anomaly check) then
  `syncAllPlaidHoldings()` (Plaid investments) then `syncAllPlaidInvestmentFlows()`
  (external cash flows for TWR/XIRR) then
  `syncAllBalances()` then `runCategorize()` in-process — never via HTTP
  self-fetch, so API_KEY-protected deployments don't 401 against themselves.
  The trailing `runCategorize()` step gives a categorization sweep on every
  sync (free rule + Teller-map paths over the whole backlog + a bounded AI
  batch) so the uncategorized count doesn't pile up between the 30-day AI-
  insights cadence runs. Updates `last_auto_sync_at` on every
  check (success or partial failure).
  Push notification only fires when at least one transaction was added, at
  least one balance actually CHANGED (`syncAllBalances` `accounts_changed`,
  computed in the balance UPDATE via a `WITH prev AS (…)` CTE and
  `IS DISTINCT FROM ROUND(…, 2)` — `accounts_updated` still counts every
  account fetched), or a sync failed, and only while
  `sync_notifications_enabled` is on (PSC-1/DD-7: the SELECT never read that
  column, so the toggle did nothing, and every Teller fetch counted as an
  update, so "Auto-sync complete" was pushed on every run). Failed syncs still notify
  under "Auto-sync issue" so the user knows the data isn't fresh.
  Note: on Render free tier, scheduled syncs only fire while the process is awake;
  enable `keep_alive_enabled` if you need guaranteed cadence.
- **Low cash alert** (roadmap T2.2 L2): every 1 hour, NOT activity-gated
  (`runCashAlertsTick` → `services/cash-alerts.runCashAlerts`). While the alert is off
  it reads the settings once a local day (a Settings change makes the next tick look
  again); while on, one settings + data-stamp read per tick, and the forecast only when
  new bank data arrived since the last check or on a new local day. Records an outcome
  only when it evaluated (an unlogged notification is a failed run). The account floors
  (T2.2 L4) are checked in the same evaluation. The same tick runs
  the "Payday missed?" check (`services/payday-alerts.runPaydayMissed`, T2.2 L3), each
  check isolated so one failing doesn't skip the other.
- **Plan-change alert** (roadmap T4.1 A4): every 1 hour, NOT activity-gated
  (`runAdvicePlanTick` → `services/advice-alerts.runAdviceAlerts`). Evaluates at most once a
  local day — while off, or once it has checked, an in-memory memo skips even the settings
  read until the next local day (a Settings change clears it). Records an outcome only when
  it evaluated (an unlogged notification is a failed run).
- **Quiet-hours release** (cycle-8 E3b, `notify-release`): every 15 minutes, NOT
  activity-gated, its runner gate in memory (`notifications.releaseDue` — a push was held
  and quiet hours have ended, or the first check after boot), so it costs no query while
  nothing is held. Runs `releaseHeldNotifications` (above, Web Push); records an outcome
  only when it pushed or failed to.
- **Linked tasks** (roadmap T2.4 X2b): every 1 hour, NOT activity-gated
  (`runLinkedTasksTick` → `services/linked-tasks.runLinkedTasks`). Does nothing in a
  standalone Perfin (no Per-sistant pool) or while the switch is off (one settings read a
  local day); otherwise computes the tasks that should be open and reconciles Per-sistant's
  through its services/linked-tasks.js (one transaction under an advisory lock, so two
  processes never interleave — cycle-8 F20). After a clean run the tick does nothing — no
  read of either database — until the next local day (F21), because every write that can
  change a task kicks a refresh: the housing routes (incl. the config PATCH), bill payments,
  manual bills, tax documents and the ledger tick when it generated obligations (F22).
  Settings' "Run now" (`POST /api/linked-tasks/run`, X2c) runs it on demand (409 while a
  run is going). Records an outcome only when it ran (a source or the Per-sistant write
  failing → a failed run).
- **CSV import reminders**: every 1 hour, NOT activity-gated, evaluated at most
  once per 24h via `user_settings.last_csv_reminder_at` (PSC-3 — the old 24h
  `setInterval` needed a full day of uptime AND activity at that exact tick, so
  it essentially never fired on the free tier). Checks manual (CSV-only) accounts
  whose most recent CSV import is older than `csv_reminder_days` setting.
  Sends notification listing specific account names needing a fresh upload.
- **Rent & Utilities ledger**: every 6 hours, NOT activity-gated (`runHousingLedgerTick`,
  an away job — settled for the local day after a successful pass; cycle-7 F15:
  it used to be activity-gated, so rent reminders never reached an away user). Calls
  `generateHousingObligations()` (idempotently create this/missing months' rent
  + utility placeholders from `housing_config`) then `runHousingReminders()`
  (payment-due + missing-utility-amount push notifications, deduped via
  `sentRecently` to ≤1 per ~3 days). No-op when the ledger isn't configured.
  In-process helpers (INV-18).
- **Self-healing reconcile**: every 1 hour, acts at most weekly (gated on
  `last_reconcile_at`). Runs `reconcileTeller(90)` — re-fetches the trailing
  90 days from every Teller enrollment regardless of the incremental
  watermark, recovering any transactions a prior sync dropped (same-day late
  arrivals, a failed-sibling-account skip) via idempotent upserts. Teller
  only (free, cheap); Plaid reconcile is heavier (full cursor re-walk) and
  stays a manual `POST /api/sync/reconcile` action. Not gated on user
  activity — a weekly background heal should run even while the user is away.
  Records its outcome as `teller_reconcile` in `last_sync_result` (BSI-11).
- **Weekly digest**: every 1 hour, NOT activity-gated (no DB call before
  `DAILY_DIGEST_HOUR` local — cycle-8 F53), checks
  `weekly_digest_enabled` and that the APP_TIMEZONE weekday matches
  `weekly_digest_day` (0=Sun..6=Sat). When both match,
  invokes `runWeeklyDigest()` in `routes/insights.js`, which itself gates
  on a 6-day window from `last_weekly_digest_at` (so multiple hourly
  ticks on the configured day are idempotent). On success, fires the
  `weekly_summary` webhook to Per-sistant and bumps the watermark. No
  AI call — body is rendered from `insights_running_summary_json`.
- **Daily digest**: every 1 hour, NOT activity-gated (no DB call before
  `DAILY_DIGEST_HOUR` local), invokes `runDailyDigest()` in
  `routes/insights.js`. The helper bails if `daily_digest_enabled` is
  false, returns `too_early` before 07:00 APP_TIMEZONE and
  `already_sent_today` once the local date already has a send (AIN-15),
  covers everything since the previous send (≤72h; first send 24h), and
  skips silently when `gatherWhatsNew` returns zero counts. If the process
  is only awake before 07:00 local that day, the digest is skipped and the
  next one covers the gap. On send, fires the
  `daily_summary` webhook to Per-sistant. No AI call.
- **Error-log flush** (shell, roadmap T1.4): every minute, writes the console.error
  entries captured since the last flush (nothing to write → no database call).
- **Uptime heartbeat** (shell, roadmap T1.4, only with `HEARTBEAT_URL`): at boot, then
  every 30 minutes, NOT activity-gated, no database call — pings the URL, or `/fail`
  while `jobHealth.failingJobs()` (each job's latest outcome in this process) is
  non-empty. Deliberately not inside the watchdog below, which is activity-gated and so
  would stop pinging (a false alarm) whenever the user is away.
- **Missed-job watchdog**: the first job checked after boot, then every 6 hours
  (activity-gated, `job-watchdog`). Every scheduled job above calls
  `jobHealth.tick(name)` as its first statement — BEFORE the activity
  gate, recorded in memory only so the Neon idle-gate stays intact. The
  watchdog flushes ticks to the `job_runs` table and pushes a
  "Scheduled jobs missed" notification (tag `jobs-missed`) when any
  job's last persisted tick is older than max(4× its interval, 36h) —
  i.e. the process wasn't running at all (free-tier sleep with
  keep-alive off, crash loop). Alerts once per outage: the sorted
  missed-job list is a signature stored on the `_watchdog` row, and an
  unchanged signature doesn't re-notify. Normal overnight sleeps stay
  under the 36h floor by design. Jobs with no row yet (fresh install)
  never alarm. Every job also records its OUTCOME (`jobHealth.result`) when
  its body ran — a failed run shows in Sync Health as "Scheduled job X failed
  its last run" (F8); a gated skip (away, not due, disabled) records nothing.
  The same tick then refreshes the **operator checks** (cycle-7 G1 + ST4 — the
  GitHub part only when its 6h cache is stale) and calls `notifyIfChanged`: one
  "Operator checks: N need attention" push (tag `operator-checks`, deep link
  `/settings#sync-health`) when the set of failing check ids changes
  (`user_settings.operator_checks_signature`); unchanged → silent, recovery →
  silent, a round with an unreadable GitHub check → skipped.

## Shared Account Spending Split
All spending queries apply the `SPLIT_AMOUNT` SQL fragment from
`services/financial-queries.js`. As of the Settlement feature it's a CASE
expression with two layers — per-transaction `personal_for` override
(only on shared accounts) on top of the account-level `spending_split_pct`:
```sql
(CASE
   WHEN la.is_shared AND t.personal_for = 'self'    THEN t.amount
   WHEN la.is_shared AND t.personal_for = 'partner' THEN 0
   ELSE t.amount * COALESCE(la.spending_split_pct, 100) / 100.0
 END)
```
Non-shared accounts always fall through to the spending_split_pct branch
(which defaults to 100 = full amount). `routes/spending-analytics.js`
(spending-summary monthly/category/merchants, cash-flow daily/DOW averages,
spending-yoy), `routes/insights.js` (anomaly baseline + candidate, seasonal
patterns), and `routes/subscriptions.js` (bill-calendar income) **IMPORT**
`SPLIT_AMOUNT` / `NOT_TRANSFER` / `INCOME_PREDICATE` from
`financial-queries.js` and template-interpolate them — they are NOT
independent copies and cannot drift. Aliased variants are derived in place,
never re-typed: the split-row variant via `SPLIT_AMOUNT.replace(/t\.amount/g,
"s.amount")`, insights' anomaly-baseline subquery via `SPLIT_AMOUNT_2 =
SPLIT_AMOUNT.replace(/\bla\./g, "la2.").replace(/\bt\./g, "t2.")` and
`NOT_TRANSFER.replace(/\bt\./g, "t2.")`. (The June 2026 seams audit found and
converted the last literal copies — two in cash-flow, seven in insights
anomaly/seasonal; `tests/seams-audit.test.js` now scans every route/service
file and fails on any future re-inlining. The settlement endpoint's per-bucket
`FILTER (WHERE t.personal_for = …)` clauses are NOT copies of this CASE — they
implement the deliberately different who-owes-who bucket math.) The only place
that holds a TRUE inline copy (because it can't `require` the services layer)
is the standalone `scripts/sheets-sync.js` (verified byte-matching the
canonical) and the legacy Apps Script `apps-script/Code.gs` fork.
The standalone `scripts/sheets-sync.js` `buildDashboard` also
inlines a `SPLIT_AMT` + `NOT_TRANSFER` + reimbursed-exclusion copy (it can't
import the services layer). As of M4 it ALSO mirrors splits-REPLACEMENT for its
per-category surfaces — a splits-aware `cat_lines` CTE (parent_no_splits ∪
from_splits) backs the Spending-by-Category, category×month pivot, and Budget
Status queries, so per-category Sheets totals now match the in-app category
totals. Total aggregations (monthly trend, 6-month totals) and Top Merchants
stay parent-keyed by design — splits sum to their parent, so those totals are
unchanged either way. Any new spending aggregation should import `SPLIT_AMOUNT`
rather than re-inline.

This affects: spending-summary (monthly_trend, byCategory, topMerchants),
savings-rate, spending-yoy, budgets, budget alerts, cash flow, AI insights
anomaly detection + seasonal, and the Settlement widget — and, since cycle-7
F37, INCOME: `INCOME_AMOUNT = (−SPLIT_AMOUNT)` puts a deposit on a shared
account at the account's share in `getMonthlyIncome` (savings rate, insights,
FIRE, Ask), `/api/income-summary` and the Sheets Income tab (mirrored, pinned in
tests/scan-oct-batch5.test.js). The cash-flow / bill-calendar income streams
stay full deposit amounts.

## Income Detection
Income is identified via OR'd branches built by
`services/financial-queries.js incomePredicate(alias)`. `INCOME_PREDICATE` is
`incomePredicate("transactions")` (for callers that don't alias the table —
Postgres accepts the bare table name as a qualifier); aliased callers use
`incomePredicate("t")` (e.g. `INCOME_PREDICATE_T` in spending-analytics).
**Every outer column is qualified with the caller's alias (FAN-2)** — the
predicate used to write them unqualified on the theory that only the outer row
had those columns in scope, which is false inside `FROM transactions __t2`: the
branch (b) guard became `__t2.account_id <> __t2.account_id` (always false), so
a brokerage paycheck + its "Funds transfer from brokerage" counted twice.
Keyword matching uses Postgres word-boundary regex (`\y`) over
`CONCAT_WS(' ', user_merchant_name, merchant_name, name)` — the user override,
the cleaned merchant AND the raw description (DD-2: Teller stores the
counterparty in `merchant_name` and the raw description — where "PAYROLL"
lives — in `name`). No amount thresholds. Each branch is independently gated:

**Branch (a) — strict keyword match with negative filter.** Matches deposits
that look like payroll/direct-dep traffic AND are NOT excluded as transfers:
- Includes: `\y(payroll|direct dep|direct deposit|dir dep|salary|employer|deposit|ach credit)\y`
- Excludes: `\y(payment|transfer|pymt|zelle|venmo|paypal|cash app|refund|reversal|reimbursement|reimburse|reimb|expense report|atm|withdrawal|bill pay)\y`
  (the reimbursement words since cycle-7 F37 — an "EXPENSE REIMB DIRECT DEP" credit
  repays spending, it isn't income)

**Branch (b) — user-authorized brokerage transfer pattern.** Matches the
specific case of paychecks landing in a brokerage account and the user then
transferring to checking, leaving a "Funds transfer from brokerage" credit
that's the real paycheck from the user's perspective. To avoid double-
counting when both ends are linked, branch (b) requires NO matching debit
on a different account within ±2 days (the `__t2` subquery compares against
the alias-qualified OUTER row — FAN-2).

**Branch (c) — explicit category match.** `LOWER(COALESCE(user_category,
category[1])) = 'income'` — case-insensitive, so Teller's lower-case `income`
category counts too — covers any row the user manually overrode to 'Income' via
`PATCH /api/transactions/:id/category` and rows the free categorize map set.

**Branch (d) — Plaid personal_finance_category (DD-3).**
`user_category IS NULL AND personal_finance_category->>'primary' = 'INCOME'`
(Plaid's current taxonomy; the legacy `category` array has no top-level Income).
Includes Plaid's dividend/interest sub-codes. A user category wins.

`NOT_TRANSFER` (the spending-side negative filter) has two keyword lists
(cycle-7 F32):
- the payment/transfer PHRASES (autopay, epay, payment thank, transfer to/from,
  zelle, venmo, cash app, bill pay, card payment, atm, withdrawal, …) are matched
  against `COALESCE(user_merchant_name, CONCAT_WS(' ', merchant_name, name))` —
  merchant + raw description (DD-2), a user rename taking precedence so renaming
  stays the escape hatch for a payment that really is spending;
- bank / processor BRAND words (interest, paypal, chase, citi, discover, amex,
  wells fargo, capital one, …, deposit) are matched against the CLEANED merchant
  only (`COALESCE(user_merchant_name, merchant_name, name)`), with exemptions
  (Citi Bike / Citi Field, Chase Center / Field, "security deposit", a
  "PAYPAL *<merchant>" purchase). Matching them on the raw description made
  "PAYPAL *NETFLIX", Citi Bike rides and a security deposit vanish from spending.
  Trade-off: a card payment whose description names the bank but carries no
  payment phrase AND whose cleaned merchant isn't the bank now counts as spending
  (Plaid rows are still caught by their PFC).
It also excludes a row categorized `Transfer` or `Investment` (cycle-7 F51 —
`user_category`, or the provider `category[1]` for a non-Plaid row; a Plaid row's
legacy category is not trusted) AND Plaid `TRANSFER_IN` / `TRANSFER_OUT` /
`LOAN_PAYMENTS` rows unless the user has categorized the row as something other
than `Transfer` (DD-3). It is a single parenthesized boolean, safe after `AND`
and for the insights `t.`→`t2.` derivation; scripts/sheets-sync.js mirrors it
(SX3-pinned).

Constants exported from the same module: `INCOME_PREDICATE` (full predicate),
`incomePredicate(alias)`, `INCOME_AMOUNT`, `NOT_TRANSFER`, `SPLIT_AMOUNT`,
`NOT_REIMBURSED`, `INVESTMENT_ACCOUNT_TYPES`; helper `getLiveIncomeStreams`. Used by `/api/cash-flow`, `/api/savings-rate`,
`/api/income-summary` (its `by_account` now agrees with `monthly_trend`), AI
insights income module, bill-calendar income detection, and — byte-mirrored,
SX3-pinned — the Sheets Income tab.

## Key Design Decisions
- **Test-time devDeps re-declared at the root.** Tests in `tests/` directly
  `require('express')`, `require('pg')`, etc., so the repo-root `package.json`
  re-declares the subset that tests directly import (`pg`, `express`,
  `multer`, `csv-parse`, `supertest`). The root's `express` is pinned to v4
  to match `teller/` so tests run against the same Express version the
  primary tested module uses at runtime; `apps/per-sistant/` pins the same
  v4 (`^4.21.0`) in its own workspace. CI runs a single `npm ci` at the root — npm workspaces
  walks shell/, teller/, and apps/per-sistant/ in one pass. Local devs must
  `npm install` at the root before `npm test`.
- **Source-pinned regression tests.** `tests/audit-regressions.test.js` includes
  smoke tests that read source files with `fs.readFileSync` and assert against
  patterns (e.g., `persistent.js` references `process.env.SSO_SECRET` and never
  the legacy `SESSION_SECRET + AUTH_SECRET`). These are intentionally weaker
  than runtime tests but they avoid pulling `express-rate-limit` and other
  deps that aren't installed at the repo root, while still catching the most
  common regression: a code reviewer reverting a fix.
- **Real code over replicas; real Postgres for route SQL (Batch 15).** A test
  must exercise the production module — a test that re-implements the logic
  inline (the old `tests/teller.test.js` and Per-sistant `api.test.js`) can never
  fail on a production change and was deleted. Unit tests use mock pools; route
  SQL that only Postgres can judge (casts, `text[]` params, JOIN aliasing, mount
  order) is covered by `tests/contract/` against a real database with the real
  server.js mount order. A bug a real-code test exposes is recorded as a
  node:test `{ todo }` (or a guard `KNOWN_GAPS` entry) in a test-only batch and
  fixed separately — never by weakening the assertion.
- **No new bare catch in server code (cycle-7 policy response).** A catch that
  swallows an error must log it or carry a comment saying why ignoring it is
  safe. `tests/scan-oct-batch3.test.js` scans the server-side files (teller
  routes/services/startup/server/data, shell index + middleware, Per-sistant
  server code, scripts) for `catch {}` / `.catch(() => {})` / `.catch(() =>
  null)` and compares per-file counts with a `KNOWN_GAPS` map (count + reason):
  a count that GROWS fails, and so does one that SHRINKS without the map being
  updated, so the list only ever shrinks. `ROLLBACK").catch(() => {})` inside an
  error path is the one sanctioned idiom. Browser code is out of scope.
- **Service worker excludes `/api/*`.** The SW caches static assets but never
  API responses. A stale balance shown after the network drops would mislead
  the user worse than a clear "offline" error.
- **API key authenticates external tools, not browser users.** Browsers
  authenticate via session cookie; the `X-API-Key` header path exists for
  cron and external integrations. The dashboard never injects the key into
  the DOM and never appends it to a URL.
- **One timezone source for "current month" / "today" (F11).**
  `services/financial-queries.js` exports `currentMonth(tz)` / `todayStr(tz)`
  (APP_TIMEZONE, default UTC) — the single tz anchor every user-facing
  month-bucketed surface routes through, so the month boundary is the operator's
  wall-clock month, not UTC's. Server-side callers compute the month/day in JS
  and pass it into SQL as a parameter (e.g. `getMonthlySpending` anchors its
  window to `$2 = currentMonth()+'-01'`, not `date_trunc('month', CURRENT_DATE)`);
  `getCategorySpendingThisMonth` delegates to `getCategorySpendingForMonth(currentMonth())`.
  Rule: a path that mixes a JS month with a SQL anchor must convert BOTH in
  lockstep (or pass the JS month into the SQL) so they can't disagree — the JS
  and SQL "current month" were previously independent UTC anchors that happened
  to agree only because both were UTC. Rolling-window `CURRENT_DATE` lookbacks
  (90-day cash-flow, retention sweeps) stay UTC: a few hours of skew is
  immaterial over a multi-month window, and they're not month-bucketed. New
  "this month"/"today" surfaces MUST use `currentMonth()`/`todayStr()` rather
  than `new Date().toISOString()` or `CURRENT_DATE`.
- **Shared financial queries.** `services/financial-queries.js` is the
  source of truth for "income" and "spending" computations: keyword-filtered
  payroll/direct-dep income (excluding transfers/payments/refunds) and
  split-adjusted spending NET OF REFUNDS (`spendLinesCTE` + `NET_CATEGORY_MONTHS`,
  floored at $0 per month + category — F35) that honors `transaction_splits`, the
  account-level `spending_split_pct`, AND the per-transaction `personal_for`
  override on shared accounts (`SPLIT_AMOUNT` is a CASE expression — see
  the Shared Account Spending Split section). AI insights routes through
  it so Claude sees the same numbers the dashboard shows. Helpers:
  - `getMonthlyIncome(pool, months)` — keyword-filtered income, last N months
  - `getMonthlySpending(pool, months)` — split-adjusted spending, last N months.
    Both use a WHOLE-month window (floored to the 1st via `date_trunc`), so the
    oldest bucket is a full month rather than a partial one — callers (savings-
    rate, context-export, AI trends) treat each returned month as complete (FA-4).
    The current month is still included (partial-to-date, as expected in-progress).
  - `getCategorySpendingThisMonth(pool)` — current-month per-category spend
    (delegates to `getCategorySpendingForMonth(pool, currentMonth())` — the
    APP_TIMEZONE month, not Postgres `CURRENT_DATE`)
  - `getCategorySpendingForMonth(pool, monthStr)` — same shape, but for an
    arbitrary `'YYYY-MM'` month; used by `GET /api/budgets?month=...`,
    `POST /api/budgets/snapshot`, and the budget-snapshot auto-trigger so
    snapshots record the correct month's spending instead of always-this-month.
  - `getNetWorth(pool)` — the single source of truth for net worth (assets,
    liabilities, net_worth, breakdown). For a Plaid brokerage that appears in
    BOTH `linked_accounts` and `investment_accounts`, it keeps the
    `investment_accounts` value (the correct holdings-sum) and drops the
    `linked_accounts` phantom (often $0 from accountsGet) — see the net-worth
    Key Design Decision below. Always includes investments.
  Constants: `INCOME_PREDICATE`, `NOT_TRANSFER`, `SPLIT_AMOUNT`, `NOT_REIMBURSED`.
  `/api/savings-rate` calls `getMonthlyIncome` + `getMonthlySpending`;
  `/api/cash-flow` uses `INCOME_PREDICATE`; `GET /api/budgets`,
  `/api/budgets/alerts`, the AI insights prompt and the Ask budget tool use
  `getBudgetStatus` (and the scheduled budget-alert push the same
  prior-month-rollover rule over `getCategorySpendingThisMonth`, which is
  the tz `currentMonth()`);
  `/api/budgets/suggest` uses `getCategorySpendingForMonth` over the 3 previous
  COMPLETE months (FAN-8); `/api/context-export` uses `getMonthlySpending` — so AI suggestions
  and the Claude-chat export see the same split-adjusted numbers as the
  dashboard. The spending-summary monthly trend reads the same `spendLinesCTE` +
  `NET_CATEGORY_MONTHS` (F35) — any new financial endpoint should use this module
  instead of re-inlining.
- **Net worth is computed by one shared helper, not re-derived per writer.**
  `getNetWorth(pool)` in `services/financial-queries.js` is the single source of
  truth, used by all three `net_worth_snapshots` writers — the hourly snapshot
  job (`startup.js`), `POST /api/net-worth/snapshot` (`goals.js`), and
  `syncAllBalances` (`enrollments.js`). It sums depository (non-credit, non-loan)
  `linked_accounts` as assets, credit AND loan accounts as liabilities (Plaid
  sets `type='loan'` for all debt subtypes — counting a loan as an asset
  inflated net worth ~2× the loan balance, F1), and active `investment_accounts`
  — but **dedupes the Plaid brokerage that exists in BOTH tables**. A brokerage
  linked via the combined Plaid transactions+investments flow lands in
  `linked_accounts` (often $0 — Schwab et al. report `balances.current=0` at the
  account level and put the real value in holdings) AND `investment_accounts`
  (correct holdings-sum balance). **`investment_accounts` is authoritative**: the
  `linked_accounts` query drops any row whose `account_id` matches an active
  `investment_accounts.plaid_account_id` (`NOT EXISTS (… ia.plaid_account_id =
  la.account_id AND ia.is_active)`), and the `investment_accounts` query is NOT
  filtered against `linked_accounts`. This matches `GET /api/investments`
  (`la.plaid_item_id IS NULL`) and the dashboard accounts grid. Earlier the dedup
  ran the OTHER way (kept the $0 `linked_accounts` phantom, dropped the real
  `investment_accounts` value), so net worth understated by the full brokerage
  value (H1); before THAT (F1), the three writers disagreed — the balance-sync
  writer summed `linked_accounts` only (omitting investments) while the other two
  double-counted the Plaid brokerage. New net-worth surfaces MUST call
  `getNetWorth` rather than re-inlining the assets/liabilities sum.
- **Substring-safe keyword exclusions.** All merchant/transaction keyword
  filters use word-boundary matching — `\b` in JavaScript regex, `\y` in
  Postgres regex (`~*` / `!~*`). The reason: short tokens like `atm`,
  `pymt`, `interest`, `epay`, and `vision` previously substring-matched
  legitimate merchants (AT&T, Atmos Energy, internet ISPs, television-
  related merchants) and either hid them from dashboards or persisted false
  tax deductions. Multi-word phrases still work because `\b` / `\y` anchor
  at phrase edges, not inside the phrase. Sites that follow this pattern:
  `services/financial-queries.js` `INCOME_PREDICATE`,
  `scripts/detect-subscriptions.js` `isExcludedMerchant`,
  `scripts/detect-transfers.js` `classifyTransfer`,
  `teller/data/reference-data.js` `categorizeSubscription` /
  `findCancelUrl`, `routes/insights.js` tax-deduction regex,
  `routes/enrollments.js` top-merchants exclusion. **When adding a new
  keyword filter, do not use `LIKE '%kw%'` or `SIMILAR TO '%kw%'`** — use
  `~*` / `!~*` with `\y(kw1|kw2|...)\y`.
- **User overrides on synced transactions live in `user_*` columns.**
  When a user edits the merchant name or notes on a Teller-sourced
  transaction, the override goes to `transactions.user_merchant_name` /
  `user_notes`; the raw Teller fields are never touched. Display layers use
  `COALESCE(user_merchant_name, merchant_name, name)`. The next sync from
  Teller therefore can't fight the user — `INSERT … ON CONFLICT … DO
  UPDATE SET merchant_name = EXCLUDED.merchant_name` only updates the raw
  field and leaves the user override intact. The same pattern applies to
  `user_category` (category overrides set via `PATCH
  /api/transactions/:id/category`, bulk-category, AND the `/api/categorize`
  rule/Teller-map/AI/rules-apply paths): every display query — including the
  in-app routes (`/api/transactions`, `/api/spending-summary`,
  `/api/spending-yoy`, the financial-queries helpers) AND the Google Sheets
  exporter (`scripts/sheets-sync.js`) — reads the override via
  `COALESCE(user_category, category[1])` so a Teller re-sync can't clobber
  manual categorizations.
- **Goal `current_amount` is derived when funding-linked.** If a goal has
  `funding_account_id` (or `funding_investment_id`) set, GET `/api/goals`
  computes `current_amount = account_balance - goal_baseline_amount` rather
  than reading the stored value. Don't write to `current_amount` directly
  on linked goals — it'll be overwritten on next read. The stored value
  surfaces as `current_amount_manual` for transparency. Linking infers a
  baseline (`account_balance - existing_current_amount`) so the user's
  pre-link progress is preserved. If baseline inference fails (account
  not found, DB error), the funding link is silently dropped from the
  PATCH to prevent `current_amount = balance - 0` from inflating progress.
- **Transaction splits replace parent in category aggregations.** When
  `transaction_splits` rows exist for a parent, every per-category SQL
  aggregation in budgets/spending-summary/scheduled-push uses the splits'
  `(amount, category)` instead of the parent row. Total aggregations
  (monthly trend, cash flow, savings rate) are unchanged because splits
  sum to the parent's amount. New per-category endpoints should call
  `getCategorySpendingThisMonth(pool)` rather than re-implementing the
  CTE — that helper already handles splits + reimbursed + spending-split.
- **Categorization rules first, then AI — free paths sweep the whole backlog,
  only AI is batched.** "Uncategorized" = no `user_category` AND (a Plaid row —
  `personal_finance_category` set — OR no provider category OR one outside our
  scheme): a Plaid row's LEGACY category is never taken as ours ("Travel" for gas
  and taxis), and the Teller map runs only on non-Plaid rows (`mapCategoryFor`
  likewise maps a Plaid row from its PFC only) — cycle-7 F50: such rows used to be
  skipped by the PFC map and the AI. When `POST /api/categorize` (or `runCategorize`) runs,
  the FREE deterministic paths — user `categorization_rules`, the Teller
  `TELLER_CATEGORY_MAP` (`accommodation` = lodging → Travel and `loan` →
  Transfer since DC-12), and the Plaid `personal_finance_category` map
  (`PLAID_PFC_DETAILED_MAP` then `PLAID_PFC_PRIMARY_MAP`, source `'plaid_map'`,
  counted in `by_teller_map` — DD-3) — are applied as **bulk
  `UPDATE … RETURNING` over the ENTIRE uncategorized backlog** (no row cap),
  and a fourth free pass sets `user_category='Income'` on CREDITS whose
  provider category is income (Teller `income` / PFC `INCOME`) — every other
  path is limited to debits (`amount > 0`),
  because they're pure SQL and cost nothing. The paid Claude call **loops** in
  `AI_BATCH` (50)-row pages up to `AI_MAX_PER_RUN` (300) rows per invocation,
  re-checking the shared `INSIGHTS_MONTHLY_BUDGET_CENTS` cap before each page and
  stopping early when the cap is hit (returns `budget_hit: true`) or the backlog
  drains — so one click makes a real dent instead of nibbling 50 rows.
  (Earlier the whole batch — rules + Teller-map + AI — shared a single
  `LIMIT 50`, so one "Categorize" click barely moved a large backlog and the
  uncategorized count looked stuck.) Live progress is published to a module
  tracker polled by `GET /api/categorize/progress` so the Settings button shows
  "AI categorizing… N done" instead of a blind spinner. A user who creates a rule for
  "Amazon" → "Shopping" will never pay for AI to categorize Amazon
  transactions. Rules are matched against `COALESCE(user_merchant_name,
  merchant_name, name)` so user-renamed merchants are also handled, and the
  paid AI batch sends Claude that same name (DC-15 — it used to send the raw
  `COALESCE(merchant_name, name)`, ignoring the user's rename). All writes
  go to `user_category` so a Teller/Plaid re-sync can't clobber them. The AI
  write only fills a row whose `user_category` is still NULL, so a category the
  user sets while a batch is with the model wins (cycle-7 F47 — it used to be
  overwritten), and `categorized_by_ai` counts only rows actually written. Rows
  the model leaves unanswered are stamped `ai_skipped_at` and held back from the
  AI for 30 days (F54 — they came back on the very next page and every run,
  paid for each time). The
  HTTP route still returns 501 when `ANTHROPIC_API_KEY` is unset (the Settings
  button is disabled without it), so the free sweep runs as part of an
  AI-enabled call, not standalone.
- **Categorization engagement loop drives AI cost down.** The dashboard's
  "Review Uncategorized" widget (`GET /api/categorize/review-queue`) shows
  the same set of transactions that would otherwise go to Claude on the
  next AI run. The user picks a category (with a Teller-map suggestion
  pre-filled), optionally checks "Remember" to create a `categorization_rules`
  row via `POST /api/categorize/review`, and the rule base grows. Each rule
  added means future AI cost drops because more rows hit the rule path
  before reaching Claude. Long-term, the AI is reserved for genuinely
  novel merchants.
- **Goal-funding suggestions surface auto-link opportunities.** `GET /api/goals`
  returns `suggested_transfers[]` per goal — the top 5 active recurring
  outgoing transfers whose `transfer_type` matches the goal's funding-source
  kind (savings or investment) and whose monthly amount is within ±25% of
  `monthly_contribution`. Suggestion only — the UI can prompt "Auto-link
  this $500/mo Schwab transfer to House Down Payment?" without auto-linking.
- **Per-account balance history is polymorphic.** `account_balance_snapshots`
  uses a `(source, source_id)` polymorphic reference instead of two parallel
  tables. `source='linked'` rows reference `linked_accounts.id` (Teller-linked
  accounts including investments); `source='investment'` rows reference
  `investment_accounts.id` (Plaid + manual). The lack of FK is deliberate —
  both source tables exist with their own lifecycles, and a polymorphic
  UNIQUE keeps lookups O(1) per (source, source_id, date). Snapshots are
  written from `syncAllBalances` and Plaid `sync-holdings`; one row per
  account per day via `ON CONFLICT DO UPDATE`.
- **Budget rollover uses snapshots, not running totals.** The rollover
  amount is computed by `POST /api/budgets/snapshot` as `MAX(0, limit - spent)`
  and stored in `budget_snapshots` keyed by the month that just ended. The
  rollover that applies to month M is the unused budget from month M-1, so the
  readers (`GET /api/budgets`, `GET /api/budgets/alerts`, the AI insights
  prompt, the Ask budget tool — all via `getBudgetStatus` — and the scheduled
  budget-alert push) add the **prior** month's snapshot `rollover_amount` to the
  base `monthly_limit` to produce `effective_limit` — via `previousMonthKey()`
  (FA-1; now in `financial-queries.js`, re-exported by budgets.js). (They previously read the *current* month's snapshot, which doesn't
  exist yet or holds this month's own circular underspend, so the carried-over
  amount was silently never applied.) One-time budgets (`budget_type = 'one_time'`) share the
  `UNIQUE(category)` constraint with recurring budgets — you can't have both
  a recurring and one-time budget for the same category. Convert via PATCH.
- **Notification log as audit trail.** `sendToAll()` always writes to
  `notification_log` even when push isn't configured. This means the in-app
  notification center works independently of web push — users who haven't
  granted push permissions or whose push subscriptions expired still see
  their anomaly alerts, budget warnings, and goal milestones in the nav
  bell dropdown. READ notifications older than `NOTIFICATION_RETENTION_DAYS`
  (180) are pruned by `pruneNotificationLog`, called from `sendToAll` at most
  once a day (cycle-7 F86 — the table grew forever); unread ones are kept.
  `sentRecently` dedup windows (≤ days) are unaffected.
- **The scheduler calls helpers in-process, not via HTTP self-fetch.**
  Every route module that the scheduler invokes exports a callable helper
  alongside its Express router:
  - `routes/enrollments.js` → `syncAllTransactions` (the Teller+Plaid entry point every transaction-sync trigger uses), `syncAllEnrollments`, `syncAllBalances`, `reconcileTeller`, `recordSyncResult`, `runAnomalyCheck`
  - `routes/investments.js` → `syncAllPlaidTransactions`, `syncAllPlaidBalances`, `syncAllPlaidHoldings`, `syncAllPlaidInvestmentFlows`, `reconcilePlaidTransactions`
  - `routes/subscriptions.js` → `runSubscriptionDetection`
  - `routes/categorize.js` → `runCategorize`
  - `routes/insights.js` → `generateInsights`
  The HTTP route handlers are thin wrappers around the helpers. The whole
  AI-insights chain (detect → detect-transfers → categorize → insights →
  audit → email webhook) runs in-process from `teller/startup.js`. Earlier
  versions of the auto-trigger used HTTP self-fetches that 401'd through
  the API_KEY middleware (in standalone mode) and through the shell auth
  gate (in embedded mode); the helper-export pattern fixes both. Future
  scheduled tasks that need to invoke route logic should follow the same
  "extract handler into helper, export, reuse" pattern. Helpers return a
  `{ ok, status?, ...body }` discriminated union so HTTP wrappers can map
  to `res.status().json()` and direct callers can branch on `result.ok`.
  Outbound HTTP helpers (`sendPerSistantWebhook`) follow a parallel
  contract: `{ sent: bool, status?, reason?, error? }`. `reason` is an
  enum-style string (`"not_configured"`, `"missing_secret"`,
  `"decryption_failed"`, `"config_error"`) so callers can branch on the specific
  failure mode rather than parsing logs. `getPersistentConfig` decrypts the webhook secret
  in a separate query from the url/enabled read, so a `TOKEN_ENCRYPTION_PASSPHRASE`
  mismatch surfaces as `"decryption_failed"` instead of masquerading as
  `"not_configured"` (SN-3); likewise a DB error on the url/enabled read itself
  returns `{ configError: true }` → reason `"config_error"` rather than the
  misleading `"not_configured"` (F23).
- **"Since last X" watermarks live in `user_settings`, not in cookies.**
  The anomaly notifier (`last_anomaly_txn_id` + `last_anomaly_check_at`
  since cycle-8 E2c) and the "since you last looked" dashboard widget
  (`last_dashboard_view_txn_id` + `last_dashboard_view_at` since E2d) keep their watermark in columns on the
  single-row `user_settings` table to scope their respective queries. Storing server-side keeps the dedup logic
  intact across devices and across PIN re-logins, and the single-user
  app design means we never need a per-user dimension. New "since last X"
  features should follow the same pattern instead of inventing a cookie
  or local-storage equivalent.
- **AI user feedback feeds the next prompt, not the running summary.**
  When the user thumbs-down an insight via `PATCH /api/insights/:id/feedback`,
  the rating + optional note are stored on the `financial_insights` row.
  `generateInsights()` pulls the last 5 rated rows and renders a
  `=== USER FEEDBACK ON RECENT INSIGHTS ===` section into the prompt for
  the next run; the feedback is **never written into**
  `insights_running_summary_json`. Rationale: the summary is Claude's
  representation of the state of the user's finances; user feedback is a
  meta-signal about Claude's outputs, and storing it there would let one bad
  rating permanently pollute long-term memory. Retraction needs no schema
  change: the prompt tells Claude it may DROP a pending_action/alert that the
  feedback shows was wrong, since the summary it emits replaces the prior one
  wholesale (AIN-16 — the docs used to say the summary was never affected).
- **Dashboard widget and email digest share one aggregator.**
  `gatherWhatsNew(since)` in `routes/whats-new.js` is the single source
  of "what changed since X". The HTTP `GET /api/whats-new` route calls
  it with the `last_dashboard_view_at` watermark for the dashboard
  widget; `runDailyDigest()` in `routes/insights.js` calls it with the
  previous send time (≤72h back; 24h on a first send) for the daily email
  digest. Both surfaces always agree
  on what counts as "new" because there's only one query. Any change
  to scope (e.g. capping txn count) lands in one place.
- **Sliding-window shell session, idle window read from DB.** The shell
  PIN cookie's `maxAge` is refreshed on every authenticated request to
  `now + idleMs`. An active session never times out mid-use; an idle one
  expires after the configured window. `idleMs` comes from
  `user_settings.shell_idle_timeout_minutes` via a 60s in-memory cache
  that `PATCH /api/settings` invalidates so changes take effect on the
  next request. Falls back to a 60-minute default if the DB lookup blips
  (fail-open: better to keep an active user signed in on a transient
  error than fail-closed and force re-login). Replaces an earlier fixed
  7-day cookie TTL that gave no idle behavior at all.
- **Shell auth honors `x-api-key` as an alternate credential.** Non-
  browser clients (cron, GitHub Actions like daily-sync.yml and
  keep-alive.yml) send `x-api-key: $API_KEY`. The shell's `requireAuth`
  short-circuits on a valid header (constant-time compare against
  `process.env.API_KEY`) before checking the PIN cookie. Sub-apps still
  skip their own API_KEY check in embedded mode — the shell already
  enforced it, so the request is trusted past the gate. This is also
  why `/perfin/api/sync` works from cron even though it's behind the
  shell auth gate.
- **Cross-app transition animations are auto-init modules.** Both the
  cosmic mask reveal (Per-sistant entry) and the Iron Man materialize
  (Perfin entry) live as CSS+JS pairs under `shell/public/`. Each JS
  file scans for a marker attribute on init (`[data-atrans]` for cosmic,
  `[data-perfin-materialize]` for Iron Man), populates per-overlay
  decorations once, and binds click handlers that activate the overlay
  then navigate. Pages that want the animation just add the attribute
  to the link — no inline `<script>`. Loaded from `/shell-static/*`
  which is mounted before the auth gate.
- **`/shell-static/*` uses `maxAge: 0 + ETag`, not a long cache.** An
  earlier 1-day cache caused stale transition.css/transition.js after
  prod deploys. ETag revalidation keeps the per-request cost tiny
  (~100B for a 304) and avoids the need to bump `?v=` on every edit.
- **Shell serves PWA icons at root paths.** `/apple-touch-icon.png`,
  `/apple-touch-icon-precomposed.png`, `/android-chrome-192x192.png`,
  `/android-chrome-512x512.png` mounted before the auth gate, sourcing
  bytes from `apps/per-sistant/*.png` so there's one copy. iOS Safari's
  "Add to Home Screen" auto-discovers `/apple-touch-icon.png` from any
  origin path — so from `/login`, the landing, or any Perfin/Per-sistant
  page, the unified-shell PWA always installs with the mask-crop icon.
  Perfin's own pages still declare `<link rel="apple-touch-icon">`
  pointing at its helmet SVG, so an "Add to Home Screen" tap from deep
  inside Perfin still gets the helmet bookmark (different visual identity
  per app — a feature, not a bug).
- **Toast stack replaces single status element.** `showMsg(text, ok)` in
  `perfin-shared.js` pushes onto a `#toast-stack` container (auto-created
  on first call) rather than overwriting one shared `#status-msg` div.
  Stack caps at 5 visible toasts; identical consecutive messages dedupe
  (timer bump, no pile-up). Tap to dismiss; auto-dismiss after 5 s
  success / 10 s error (10 s for a toast with an action button — the
  optional `{ action: { label, run } }`, e.g. Undo, T2.5 U2). Desktop anchors top-right; mobile (≤640px)
  flips to bottom-right with `column-reverse` + slide-up so toasts are
  thumb-reachable and don't fight the iOS Dynamic Island. Per-page
  `.status-msg` divs are now `display: none !important` — kept in
  templates for backward compat with any direct DOM writes (silent
  no-op). The Accounts page's bespoke `#status` element was retired
  along the same path — its local `showStatus` now delegates to the
  shared `showMsg`.
- **Notification panel becomes a bottom sheet on mobile.** At ≤640px,
  `.notif-panel` flips from a 340 px-wide drop-down (`top: 56 px; right:
  12 px`) to a full-width bottom sheet (`bottom: 0`, `border-radius:
  16 px 16 px 0 0`) with a grab-handle hint (`.notif-grabber`) + dim
  backdrop (`#notif-backdrop`). Show/hide is controlled via the HTML
  `hidden` attribute (not `style.display`) so CSS animations are
  declarative; the backdrop, click-outside, and `Esc` key all dismiss.
  The nav sync badge is hidden in the same media query to free up
  width — the same data is in Settings and the notification log.
- **Per-transaction shared-card settlement override.** On is_shared
  accounts, the per-row `personal_for` column overrides the account-level
  `spending_split_pct` ('self' = 100% user, 'partner' = 100% other
  cardholder, NULL = use account default). Honored by the SPLIT_AMOUNT
  CASE expression in `services/financial-queries.js` (and every inline
  copy across enrollments.js / insights.js — see the Shared Account
  Spending Split section). The settlement endpoint (`GET
  /api/shared-settlement`) groups charges into three buckets — shared,
  your_personal, partner_personal — and computes per-person obligations
  as `(split_pct × shared_total) + personal_total`. Reimbursed rows are
  excluded entirely (they net to neither party). The dashboard widget
  and the Transactions-page Edit modal share one source of truth: the
  `personal_for` column. New "who owes what" surfaces should compute
  obligations from the settlement endpoint rather than re-deriving them.
- **Plaid balance refresh is a standalone helper.** `syncAllPlaidBalances`
  in `routes/investments.js` calls `accountsGet` on every linked
  Plaid item **with `status = 'GOOD'`** (so CSV virtual `plaid_items`
  — `status='CSV'`, placeholder token — aren't sent to Plaid every balance
  sync, which would 400 and surface as recurring spurious errors; matches the
  filter `syncAllPlaidTransactions` applies, F3) and writes `current_balance` /
  `available_balance` / `credit_limit` to `linked_accounts` + a daily snapshot
  row, then
  refreshes liabilities (APR / minimum payment / due date via
  `syncPlaidLiabilities`, failing gracefully when unsupported) — no
  transactionsSync involved. `credit_limit` is sourced from the liabilities
  response's `accounts[].balances.limit` (Plaid's `CreditCardLiability` has no
  credit-limit field, so the old per-card read was always undefined — Discover
  fix); APR/limit only populate once `liabilitiesGet` succeeds, so an item that
  predates the Liabilities product needs a Plaid Link re-auth. The dashboard
  only derives a card's limit from `owed + available` when an available figure
  exists — otherwise it shows utilization as "—" rather than a misleading 100%,
  and offers a **manual credit-limit input** (→ `PATCH /api/accounts/:id/balance
  { credit_limit }`) next to the existing manual APR field so issuers Plaid never
  reports a limit for (e.g. Discover) still get real utilization. `POST /api/sync-balances` calls it
  alongside Teller's `syncAllBalances` AND `syncAllPlaidHoldings`, so one
  "Sync Balances" click freshens balances + credit limits + APR +
  investment holdings across both providers without triggering Plaid's
  transaction sync (which would add duplicate rows during overlap with
  prior CSV imports). The auto-sync loop still calls
  `syncAllPlaidTransactions` for transaction history; the helpers exist
  in parallel for different cost/duplication profiles.
- **Plaid holdings sync re-creates accounts, not just updates them.**
  `syncAllPlaidHoldings` in `routes/investments.js` UPSERTs
  `investment_accounts` (`ON CONFLICT (plaid_account_id)`) rather than a
  bare UPDATE, so the account rows are RE-CREATED when the table has been
  cleared (e.g. after a `scripts/reset-fresh.js` run) — the old UPDATE-only
  path inserted holdings but left `investment_accounts` empty, so
  investments stayed blank after any wipe. Account balance falls back to
  the sum of the account's holdings (`sumHoldingsByAccount`) when Plaid
  returns a null OR zero account-level `balances.current` (Schwab et al.),
  via `|| acctValue` (not `??`, so a reported 0 falls through), so
  brokerages don't persist as $0. The items query UNIONs the dedicated
  `plaid_investment_items` registry with any `status='GOOD'` `plaid_items`
  that have an `INVESTMENT_ACCOUNT_TYPES` account in `linked_accounts`
  (DISTINCT ON item_id, registry preferred) — because Plaid often doesn't
  surface a brokerage as an investment account at link time, so
  `exchange-transactions` never registered it in `plaid_investment_items`
  and its holdings stayed permanently un-synced ($0) even though the
  account itself linked fine. `investmentsHoldingsGet` no-ops for items with
  no holdings, so the extra items are cheap. The helper runs in the bank
  auto-sync chain, the AI pre-insights chain, and `POST /api/sync-balances`;
  the `POST /api/plaid/sync-holdings` route is a thin wrapper around it.
  **Plaid's holdings response is authoritative per account (BSI-4):**
  `writePlaidHoldings` deletes the holdings of each account IN the response
  that the response no longer lists, so a sale clears its row; accounts not in
  the response (other items, manual accounts) are never touched. A missing
  cost basis is NULL and excluded from returns, never treated as $0 (BSI-5).
  The upsert keeps `is_active`: an account the user removed is not revived by
  the next sync and gets no mirror balance, snapshot or holdings (F22 — only a
  new link brings it back).
- **Plaid sync advances the cursor only on a fully-successful page.**
  `syncPlaidItemTransactions` processes each `transactionsSync` page, and if
  ANY row in the page fails to upsert it halts WITHOUT advancing the cursor —
  Plaid's contract is "everything ≤ cursor is durably processed," so stepping
  past a failed row would lose it forever. The cursor is persisted
  progressively after each clean page (so a later page's failure can't discard
  earlier progress), and re-processing a page is safe because all writes are
  idempotent (`ON CONFLICT` upserts / idempotent deletes). `modified`
  transactions are UPSERTED (not bare-UPDATEd) so a pending→posted re-delivery
  with no existing row is inserted rather than dropped. The helper returns
  `incomplete: true` + `incomplete_reason` (`row_failure` |
  `mutation_during_pagination` | `max_pages`); `syncAllPlaidTransactions`
  surfaces the first two as `partial_sync_incomplete` (max_pages is a normal
  resumable long walk). On `TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION` the
  walk restarts from the cursor the loop STARTED with (persisted; ≤3 restarts,
  then gives up with that cursor saved — BSI-12), per Plaid's contract.
  **New accounts are registered BEFORE the cursor walk** (BSI-1):
  `syncAllPlaidTransactions` calls `accountsGet` first (fail-soft) and
  `registerMissingPlaidAccounts` (ON CONFLICT DO NOTHING) — an account the item
  gained after link (new card, update mode) otherwise hit the
  `transactions.account_id` FK, failed the page, and — since the cursor never
  passes a failed page — stalled the whole item forever. The same accountsGet
  response feeds the balance refresh (no extra call). ITEM_* errors that need
  the user (ITEM_LOGIN_REQUIRED, PENDING_EXPIRATION, …; `PLAID_REAUTH_CODES`) set
  `plaid_items.last_error_code`, cleared by a clean transaction sync or a re-link
  (BSI-10) — a column, not a `status` value, because every sync path filters
  `status = 'GOOD'` and a status flip would stop retrying and never self-clear.
- **Sync "added" counts genuine inserts, not updates.** Both the Teller and
  Plaid transaction upserts `RETURNING (xmax = 0) AS inserted` and increment
  their `added`/`transactions_added` counters only when the row was a fresh
  insert (`xmax = 0`). `ON CONFLICT DO UPDATE` returns `rowCount = 1` for both
  inserts and updates, so the old `rowCount > 0` check inflated the count on
  every re-sync and reconcile — which drove false "new activity" auto-sync
  notifications and unnecessary anomaly passes. `modified`/`removed` are tracked
  separately and unaffected.
- **Teller incremental sync never steps over a failed account.** In
  `syncEnrollment`, the enrollment-level `last_synced_txn_date` watermark is
  advanced ONLY when every account in the enrollment fetched AND upserted
  cleanly — if any account's fetch throws, or any row fails to insert (BSI-7),
  the watermark is held back so the next sync retries that range instead of
  permanently skipping a failed sibling account's older transactions. The
  incremental floor is `watermark − 7 days` (`WATERMARK_LOOKBACK_DAYS`,
  `lookbackFloor`, BSI-8): the watermark is the newest date across ALL accounts,
  so a charge posting late on one account (dated before a sibling's newest row)
  would otherwise be skipped until the weekly reconcile; the re-read is
  idempotent (INV-01 counts only inserts). A 401/403 on EVERY account throws
  with the status so the enrollment is marked `DISCONNECTED` (BSI-9 — before,
  per-account auth errors were swallowed and DISCONNECTED was unreachable); the
  next sync in which Teller answers for at least one of its accounts restores it
  to `GOOD` (syncAllBalances runs GOOD enrollments only, so a transient 401 must
  not strand balances). A run where every fetch timed out or failed with a 5xx,
  or an enrollment with no linked accounts, proves nothing about the token and
  leaves it DISCONNECTED (`syncEnrollment` returns `authenticated` — cycle-8 F2). A single failing account
  among healthy siblings stays a retryable `partial_sync_incomplete`. Accounts
  opened after enrollment are registered by `syncAllBalances` (DD-9, ON CONFLICT
  DO NOTHING), and `/api/enroll`'s account upsert re-points
  `teller_enrollment_id` so a re-link that returns the same account ids moves
  them to the new enrollment (DD-8). The incremental filter uses `>=` (not `>`) against the
  day-granular watermark so a transaction that posts on the watermark day after
  a sync ran isn't dropped; re-including the whole watermark day is safe because
  the `ON CONFLICT (transaction_id)` upsert dedups the re-processed rows.
  Pagination is **page-size-independent** (BS-1): the loop requests an explicit
  `?count=500` and pages via `from_id` until Teller returns an empty page (or the
  floor date is crossed), with a `MAX_PAGES=100` runaway guard. The earlier
  `txns.length < 500` stop hard-coded a 500-row page assumption — if Teller's
  default page size were smaller, the first full page satisfied `< 500`, `from_id`
  pagination never advanced, and history was capped at one page while the
  watermark stepped past everything older.
- **Reconcile/backfill is watermark-independent and idempotent.**
  `reconcileTeller(days)` re-fetches the trailing window from every Teller
  enrollment by passing `{ backfillDays }` to `syncAllEnrollments`, which sets a
  `backfillFrom` floor used in place of `last_synced_txn_date` — it does NOT
  advance the incremental watermark and suppresses the anomaly push (re-upserting
  historical rows would otherwise look like a flood of new activity). All writes
  are `ON CONFLICT` upserts so it only recovers dropped rows, never duplicates.
  `reconcilePlaidTransactions()` resets every `sync_cursors.cursor` to '' and
  re-walks `transactionsSync` (Plaid's cursor is all-or-nothing, so reconcile is
  a full re-pull). Driven by `POST /api/sync/reconcile` and the weekly
  self-healing scheduler (Teller only; Plaid stays manual). Both record their
  outcome in `last_sync_result` (`teller_reconcile` / `plaid_reconcile`);
  `last_reconcile_at` always stamps the ATTEMPT (so a persistent failure isn't
  retried hourly) but `last_txn_sync_at` only when every leg completed (BSI-11).
  Reconcile never runs the anomaly check (INV-05). Plaid transaction syncs and
  Plaid reconciles share one in-process lock (`withPlaidTxnLock`; the reconcile
  resets cursors AND walks inside it), so a reconcile can't reset a cursor that a
  running sync is about to overwrite (cycle-7 F27). The wait is bounded
  (`PLAID_LOCK_MAX_WAIT_MS`, 10 min) so a hung Plaid call can't block every later
  sync.
- **Named route helpers are attached AFTER `module.exports = router`.** In
  modules that export an Express router AND helper functions (e.g.
  `routes/investments.js`), the helper attachments (`module.exports.syncAll… = …`)
  must come AFTER the `module.exports = router` line — otherwise the router
  assignment replaces the default exports object and silently drops the helpers
  to `undefined`. (This had left `syncAllPlaidTransactions` / `syncAllPlaidBalances`
  unexported, so the scheduler's Plaid steps were no-ops caught by try/catch.)
  All such helpers are hoisted `async function` declarations, so attaching them
  at the very end works.
- **Route modules mount specific-before-generic.** Express matches in mount
  order, so a module with a generic `/:id` route shadows a LATER module's
  literal sibling path. `routes/subscriptions.js` mounts `transactions.js`,
  whose `PATCH /api/transactions/:id` captured `PATCH
  /api/transactions/bulk-category` (id = "bulk-category") and 400'd every bulk
  recategorize until `routes/categorize` was mounted first in `server.js`
  (DC-1). When adding a literal path next to an existing `/:param` route in
  another module, mount the literal one's module earlier (the order is pinned
  by `tests/scan-sept-fixes.test.js`, which mounts modules in server.js order).

## Known Open Issues
**Cycle 8 (late-Oct 2026 broad scan) — open until their batches run** (the scan's
batch plan is in `.cycle/STATE.md`; 57 findings, F1–F57). Batch 1 (scheduler + auth
safety — boot runs F27, not-due memos F29, the biometric open redirect F25, the shared-
database refusal F26, the Teller self-heal F2, the biometric probe limiter F28, the
x-api-key limiter F30) and Batch 2 (money accuracy — the forecast's internal transfers F7
and utility autopays F8, fee rows in investment income F9, the payday-landed retry F10, the
low-cash alert's memory and forced re-check F11 / F12, F13–F15) and Batch 3 (detection /
rename / restore — F41 F46 F47 F5 F43 F4 F6 F54) and Batch 4 (sync watermarks + webhook
hardening — F1 F51 F3) and Batch 5 (linked tasks — F16 F17 F18 F19 F20 F21 F22 F23) and
Batch 6 (AI trust + Knowledge privacy — F42 F49 F44 F24 F50 F53) and Batch 7 (UI correctness
+ accessibility — F34 F35 F55 F36 F37 F38 F39 F40 F56 F57 F48) and Batch 8 (platform hygiene —
F31 F32 F33 F52 F45) are done — every cycle-8 fix batch is done.
Batch 1 follow-ons: the weekly / daily digest, CSV reminder and housing ledger settle for
the day once they find themselves off and a Settings change doesn't drop that memo
(switching one on takes effect the next local day); the watchdog's boot timeout isn't
cleared by stopBackgroundJobs (closed by E2b — the timeout is gone); in the cloud container `npm run test:e2e` needs
`PW_CHROMIUM_PATH=/opt/pw-browsers/chromium` (the project's Playwright pins a build that isn't
preinstalled — the E1 follow-ons added the env-gated option).
Batch 2 follow-ons: a linked card paid by an autopay whose name has no card phrase and whose
credit posts more than 5 days later is billed on top of the card spending (F8); a debit that
happens to match an unrelated same-amount credit on another spendable account within 5 days
is treated as internal (F7); an unlinked card's autopay with a card name is still skipped; the
user can't mark a transfer internal or a bill themselves (the scan's G1); an unlogged cash /
floor alert's retry still waits for new data when a check was stamped earlier that day.
Batch 3 follow-ons: the bank-changed / bank-removed handling is Plaid-only (Teller sends no
such signal, so a Teller row changed while deleted is restored as the old copy); the early
price-rise alert has no "one-off" dismissal, so a one-off higher charge (an add-on, a prorated
upgrade) on a non-utility subscription alerts once per distinct amount; when a new rename rule
takes only some rows under a name, the moved rows get a fresh detection row (no user state) on
the next run; a price change later reverted keeps PRICE UP until the next charge;
tests/roadmap-t2-4-x2a.test.js intermittently fails with a node:test runner IPC error.
Batch 4 follow-ons: (the anomaly watermark stalling behind an open transaction was closed by
E2c — an id watermark with an overlap rescan; a transaction open more than 24 h before a check
can now commit rows the overlap doesn't reach); the Plaid verifier's miss cache and lookup cap are per process — a flood of forged kids can
spend the cap, so after a restart a real webhook whose kid isn't cached fails until the hour
rolls (two instances each get their own); a deposit up to 24 h old that only now matches a pay
pattern is announced late. ("Since you last looked" advancing to now() was closed by E2d.)
Batch 5 follow-ons: a linked task deleted for good can't be brought back (no way to clear its
tombstone short of the database); a manual bill autopaid and never marked paid keeps its tasks
open indefinitely; a failing statement rolls back the whole linked-task run, and a run waits
without a timeout while another holds the lock; a change that reaches the sources without a
kicking route waits for the next local day's tick; an automation or webhook relying on
todo_completed for a Perfin-closed task no longer fires. (Any open housing task hiding the
housing_due line, and Perfin's payment-due push firing beside the task, were closed by cycle-8
E3d / E3e — one reminder per item.)
Batch 6 follow-ons: the audit's period words are English-phrase lists, so "back in the fall" or
"over the holidays" isn't read as another period; a bare other year anywhere before a claim in its
sentence skips it unless the sentence says "this month"; an unreadable frontmatter line that starts
with "private" / "embed" / "sensitivity" makes the file private even when it was prose (errs
restrictive); Knowledge's /diagram still returns an empty diagram on a refusal (rag.js reads
cappedAI's empty text); the credit-score prompt reads 6 entries across all types, so a rarely-logged
type may have no prior entry in range. OPERATOR: run one full Knowledge reindex after deploying
Batch 6 (VAULT_PARSE_VERSION 3).
Batch 7 follow-ons: the Undo toast's buttons are below the 44px phone touch target (operator check
V2); a switch whose save reached the server but whose reply was lost shows the old state until a
reload; a Tax-page note the server normalized on save shows what was typed until the next reload;
Per-sistant's standalone login ignores return_to; the heatmap day keys assume DATE columns arrive as
UTC midnight (a server not on UTC shifts them, as before).
Batch 8 follow-ons: only the IN-list CHECKs in `CHECK_LISTS` (tax_documents form / origin,
webhook_events provider / status, and since E1a recurring_transfers forecast_treatment) are kept in step — the rest of the schema's IN-list CHECKs are
still frozen at first creation; a replaced CHECK is added NOT VALID, so rows written before it
aren't re-checked; Per-sistant's calendar projection starts its window at UTC midnight (a day early
east of UTC — cosmetic); DATE values Per-sistant reads through perfinPool (finance search, the
Perfin widget, housingDue) are still Perfin's Dates; a landing line can be up to 30 s stale.

**Cycle-8 expansion E1 (done — E1a–E1c, `.cycle/plan-e1-forecast-corrections.md`; E2 planned, E3–E5 queued in
`.cycle/plan-cycle8-expansion.md`):** forecast corrections (G1) and undoing a whole CSV-overlap Resolve (G5).
The E1 follow-ons are done (`.cycle/blocks/8-e1-followons-broad-implement.md`): a rename re-key carries the
forecast setting onto the surviving row, an incoming transfer's setting is a 400, a batch reports what can be
restored, pre-E1c Resolves are batched by the migration. Still open: the forecast list covers recurring transfers
and subscriptions only (manual bills and income streams aren't listed or correctable); a surviving row that already
has its own setting keeps it (the retired row's is dropped); Resolve still has no page (API only); the legacy
batching groups by an identical deleted_at (only Resolve deletes several csv rows in one transaction). Test
follow-ons: tests/contract/cash-alerts-l2's seed is still date-dependent (fails in a 31-day month), and so is
tests/cycle8-e1a.test.js's "auto: the subscription and the plain transfer are billed" (its last charge is set N days
back, the forecast steps by calendar month — the next date is a day off near the end of a 31-day month, e.g. Oct 30); an e2e click
sweep that changes seeded state (Dismiss on the Subscriptions page) can affect a later check — the E1b check
undismisses its subscription first.

**Cycle-8 expansion E2 (done — `.cycle/plan-e2-scheduler-watermarks.md`, batches E2a–E2d):** a due-based job
runner over job_runs (ST1) and id watermarks with an overlap rescan for the anomaly, payday and "Since you last
looked" checks (ST3). E2a + E2b done (ST1): every Perfin background job runs through `services/job-runner.js` when it
is due (`job_runs.last_ran_at`). E2c done (ST3, part 1): the anomaly check and "Paycheck landed" read new rows by
transaction id with a 24 h overlap rescan (`services/txn-watermark.js`). E2d done (ST3, part 2): "Since you last looked"
stores what its GET read (a seen_token posted back to /seen) and counts new transactions by id. E2d follow-ons: a
transaction whose id was taken before the widget's GET but committed after it is never listed (no overlap rescan there —
by plan); a pending row that settles later is still never listed (pending = false).
E2c follow-ons: the anomaly check still announces at most 5 charges a run (LIMIT 5 — pre-existing); its
transaction_id dedupe is a NOT EXISTS over notification_log per remaining candidate (no index on the JSON field);
"Paycheck landed" now writes its watermark on a run that found nothing. Follow-ons: a failing job waits a full cadence before its next
run (as with setInterval); jobs run one at a time, so a long one delays the rest; the runner ticks each watched job every
5 minutes, so a job-health flush (a dashboard load's /api/data-health) can write up to 15 job_runs rows while awake; in a
deploy overlap with pre-E2b code a job can run in both processes once.

**Cycle-8 expansion E4 (in progress — `.cycle/plan-e4-operator-freshness.md`, batches E4a–E4b):** token-free
go-live checks (ST5) and a nav freshness badge that reads each connection (G3). E4a done: goLiveChecks (the Teller
cert missing or expiring, the shared database, PUBLIC_URL's shape, API_KEY / SHELL_SECRET strength, Plaid env ↔
secret, the Teller webhook secret's parts) and the backup record written by db-backup.yml too, so the backup check
works without a GitHub token. E4a follow-ons: no check probes credentials over the network (a wrong Plaid secret of
the right environment, an API_KEY that differs from the workflows' secret or a revoked Teller cert still read ok);
local:backup trusts the stamp (one written by hand, or carried by a restore, reads as a backup); with a GitHub token
and no SERVER_BACKUPS the GitHub backup check stays the only one. Test follow-on: tests/contract/persistent.contract's
"GET /api/calendar projects recurring todos" is date-dependent (a daily todo due tomorrow has no projection in this
month on the month's last two days). OPERATOR: expect one "Operator checks: N need attention" push after deploying E4a.

**Cycle-8 expansion E3 (done — `.cycle/plan-e3-notifications.md`, batches E3a–E3e):** quiet hours and a
mute per kind of alert in both apps (G2), and one alert per real-world item across Perfin's push, Per-sistant's
notifications and linked tasks (ST2). E3a done: the kind catalog and the decision (`services/notify-prefs.js`), the two
settings with PATCH validation, and notification_log.push_state / item_key. E3b done: Perfin's pushes follow them —
held during quiet hours and released after (one summary for several; the notify-release job), muted kinds logged but
never pushed or emailed. E3c done (G2 complete): Settings → Quiet Hours & Muting, the bell naming a held / expired /
muted push, and Per-sistant's notification check following the same settings. E3d done (ST2 core): a Perfin push about an
item that has an open Per-sistant linked task is logged covered (read) and not pushed — the rent, utility-amount and
still-charging pushes carry their items. E3e done (ST2 complete): Per-sistant's notification check names each entry's
item and raises no browser notification for one Perfin pushed in the last 12 hours (still listed), and housing_due steps
aside only for its own month's open task. E3e follow-ons: notification_log has no index on item_key (the 12 h read is a
scan of recent rows); the 12 h window counts from the row's created_at, so a held push released later reads older than it
is; a trashed or deleted month's task lets housing_due show again for that month; manual bills and tax documents have no
Perfin push, so their tasks carry no pushed-item check. E3d
follow-ons: a still-charging alert is never covered on its first send (its task is made after the push, and has no due
date, so the push is the interruption); the rent reminder's item is the month in its tag, so with several months owed
only that month's task is consulted; a task completed by hand without paying stops covering, but the reminder's 72 h
dedup (a covered send counts as sent) means the next push can wait up to 3 days; a housing tick can push a new period's
reminder once before its task is made (the refresh is fire-and-forget); one Per-sistant query per item-bearing push. E3c follow-ons: a standalone Per-sistant has no quiet hours or mutes (the settings are Perfin's); a Per-sistant
reminder held by quiet hours is raised only at the next dashboard load after they end (no push or release); the times are
read in APP_TIMEZONE, not the browser's zone (the section names the zone). E3b follow-ons: a hold not released within 12
hours (the host asleep past the end of quiet hours) is never pushed — it stays in the bell; the release job runs once
after every boot with nothing held (three short queries); a summary push carries one link (the newest's). E3a follow-on: a kind is read from the tag's prefix, so a caller whose tag is built entirely at runtime isn't
covered by the scan test and lands in "other" until the catalog names it.

**Roadmap T4.1 (done — A1–A10):** `services/advice.js` computes the plan; since A2 it is
served by GET /api/advice, shown in the dashboard's "Your plan" card (widget key `advice`, on by default)
and read by Ask's get_cash_plan; since A3 it is the `cash_plan` insight module (the model words the plan,
the audit checks its figures, its current step is one "Plan (…)" pending action). The A1 choices stand
(A2 and A3 changed none of them):
a last payment within 10% of the minimum stands in for "paid less than the statement" when no statement
is stored (since A8 a payment made after the stored statement is compared with it — under 95% carried); a loan at APR ≥ 8% joins the high-interest step and a loan with no APR gets
minimums only (not an assumed 22%); the cash-floor cap limits only money leaving cash (debt, investing),
not the buffer / emergency-fund steps; carried cards' and loans' minimums come off the surplus before
the 60% (conservative — part of a carried card's minimum pays purchases already counted as spending);
the medium step's 50/50 halves aren't rounded to $25. A1 follow-ons: the emergency fund is all
spendable cash, not a named account or goal (A5 kept that — its tracker reads the same cash); the avalanche assumes no new card purchases and a
fixed minimum, so payoff months are estimates. A2 follow-ons: the plan has no "tell me when my plan
changes" option yet (A4 — done since); the card fetches its own request, whose 60-day cash
forecast can differ from the Summary card's 30-day lowest day; the Settings toggle reads "Your Plan" (Title
Case, like the other widget labels). A3 follow-ons: every insight run reads the plan's sources (fourteen since A10; a
few more queries and a longer prompt); the audit checks a plan amount only when it is stated per paycheck
or as a named debt's monthly figure ("$750 toward your cards" isn't checked); a "Plan (…)" pending action
an earlier run wrote stays when cash_plan is switched off or the plan can't be worked out (the model may
carry it forward); the insight email and the AI Memory widget show it like any other pending action. Since A4
the "tell me when my plan changes" checkbox exists (Settings → Cash Alerts → Plan Changes). A4 follow-ons: a
step change caused by a source dropping out for a month (a pay stream, a card's interest line) notifies, and its
return notifies again (no hysteresis beyond the once-a-day check); a move from one debt to the next inside a debt
step notifies too (read as a headline change — the headline names the card); the push opens /dashboard, not
the "Your plan" card; Settings shows no "last checked" line for it (advice_state.last_check has it). Test
follow-on: tests/contract/cash-alerts-l2's "a dip below the floor" is date-dependent — its seed puts the last
charge 27 days back and expects the bill in 3, but the forecast steps by calendar month (INV-70), so it fails
when that month has 31 days. Since A5 the plan carries the emergency-fund tracker and each goal's
catch-up amount (the "Your plan" card — a labelled progress bar and the behind / overdue goals —
the cash_plan block and Ask's get_cash_plan). A5 follow-ons: the catch-up is what finishes a goal on
time and doesn't take a share of the plan's surplus, so while the plan sends the surplus to debt the
two can add up to more than it; a goal falling behind doesn't trigger the plan-change push (A4's
signature reads the headline only — a balance-linked goal near the $5 bar would flap); months covered
use the 3 completed months' average spending. Since A6 the plan carries raises, bonuses (split in the
plan's order) and spending creep, on the card, in the cash_plan block and in Ask, and the plan-change
push names a new raise or bonus once. A6 follow-ons: a raise is counted on top of the surplus, so once
months at the new pay complete the two overlap for the rest of the 90-day window; a bonus already spent
still gets a split (the gaps are measured without it); a new job's first $1,000+ paycheck reads as a
one-off until the second arrives, and a "deposit" that is really a transfer from someone reads as one
too; the audit doesn't check a bonus split or creep's monthly figures (no per-paycheck period);
spending creep never notifies and names a category, not merchants; pay that varies by more than ±10%
never shows a raise; each advice read runs two more queries (240 days of deposits, 6 months of
spend_lines). Since A7 the plan carries idle cash (checking above the starter buffer for 60 days,
moved in the plan's order to accounts that exist) and rebalancing directions (target-allocation drift
over 5 points, asset classes only); the Investments card's per-class figures moved into
services/allocation.js so the two read one definition. A7 follow-ons: idle cash needs a balance
snapshot from before the 60-day window for every checking account (a newly linked one hides it for two
months); "checking" is subtype 'checking' only and a Teller-linked investment account with no subtype
isn't a destination; the emergency-fund part names the first savings account; neither idle cash nor
rebalancing notifies; rebalancing covers Plaid holdings only and ignores which account holds what (a
taxable sale vs a retirement one) and wash sales; each advice read runs four more queries. Since A8
the plan stores each Plaid card's last statement (its balance and date), names the day the next statement
closes in the 30% tip and compares the last payment with that statement for the carried test, and lists
what an extra $100 a month does to each loan. A8 follow-ons: Teller-linked and manual cards have no
statement date (no manual field) and keep the due-date tip; the next close is projected a calendar month on,
so a fixed-day cycle drifts a day or two; the tip compares today's balance, and charges before the close add
to what it reports; a refund between the statement and the payment can make a full payment read under 95%
(carried until the next statement); the loan line's $100 is a constant, it ignores a prepayment penalty and
leaves out a loan the plan already funds; the audit doesn't check the loan line's interest saved or months;
once the statements fill in, a card's carried status (and so the plan's step) can change, and with the
plan-change alert on that pushes once. Since A9 the plan lists each quarterly / yearly bill of $100+ with
what to set aside each month until it's due and the steady amount after, overlapping services (what keeping
one would save) and memberships with no other purchase from their store in 90 days. A9 follow-ons: the
surplus doesn't subtract the sinking-fund amount (a yearly bill outside the last 3 completed months makes it
read high; the 60% slack partly absorbs it); a 60-day subscription isn't a sinking fund; the overlap groups
and memberships are fixed keyword lists and "keeping one" doesn't know which you use; a membership's store
purchases are matched on the display merchant only; nothing notifies for A9 and the audit doesn't check its
figures; each advice read runs three more queries. Since A10 the plan shows the room left under yearly
contribution limits entered by hand (Settings → Planning → Target Allocation) and Ask answers what-if
questions (get_cash_plan with an extra payment on one carried debt, or income / spending up or down a month —
the same engine on the changed inputs, with a before / after comparison). A10 follow-ons: only contributions
recorded as investment flows count (Plaid "deposit" / "contribution" rows or a manual log), so payroll 401(k)
deferrals Plaid reports otherwise, an employer match and a Teller-linked account's contributions (Teller syncs no
flows) need a manual log, and a rollover or transfer in isn't counted; limits are per account and calendar year —
a limit shared across accounts is split by hand, and a prior-year IRA contribution made in Jan–Apr counts in the
year it's dated; a what-if extra payment raises that debt's minimum, so part of it comes out of the plan's own
recommendation (60%) and the net change on a debt the plan already targets is smaller than asked; the lowest
projected cash day is shifted linearly, not re-forecast; what-if answers aren't audited and aren't on the card;
nothing notifies for contribution room; each advice read runs three more queries.

**Cycle 7 (Oct 2026 broad scan) — open until their batches run** (plan in
`.cycle/STATE.md`; Batches 1–8 — exposure / pre-auth safety, broken pages and
dead channels, backstops / outcomes / operator state, bank-sync durability, money
accuracy and classification, delete integrity and feeds, categorization rules and
income cadence, AI trust, Sheets and cross-app, Perfin UI, Per-sistant correctness, Knowledge
ingest edges, platform hardening / test quality / drift guards — are done; Batch 13 was the
last scan batch. The deferred decisions became Batches 14–16 (`.cycle/plan-cycle7-deferred.md`
— Batch 14, refund-aware spending, Batch 15, the subscription watchdog + merchant
rename rules, and Batch 16, the CSV sign, insight-email toggle, archive fingerprints
and notes privacy tier, are done — the deferred plan is complete). The expansion work is
re-cut into Batches 17–20 (`.cycle/plan-cycle7-expansion.md`): Batch 17, operator
visibility (G1 + ST4), Batch 18, async sync for the backstops (ST1), Batch 19, Plaid
Link update mode (G3), and Batch 20, browser quality + the Per-sistant client kit (G2 +
ST3), are done — cycle 7's planned work is complete; `/reflect` closes it):
- The repo is PUBLIC (operator: make it private and delete old Actions logs —
  they printed balances and net worth before Batch 1).
- OPERATOR: Database Backup has never produced a backup (its secrets were never
  set — confirmed from the run log) and four backstop workflows are disabled by
  GitHub for inactivity, so INV-53 does not hold in production until the secrets
  are added and the workflows re-enabled (F3/F4 — the code side shipped in
  Batch 3; see Operator state items 4–5). Settings → Sync Health → Operator
  Checks shows it once `GITHUB_OPS_TOKEN` is set (item 6).
- `/api/insights/rebuild` still falls back to "sonnet" when its settings read
  fails (the F73 pattern, model only); a self-healing reconcile that throws
  retries hourly (it is recorded now). Batch 3 follow-ons (the silent curl-timeout
  exits in three workflows were fixed in Batch 18).
- Per-sistant's `housingDue` (`apps/per-sistant/routes/housing-due.js`) still sees
  only this month's due date, so the briefing / notification check don't mention
  next month's rent inside its lead window (Perfin's own reminder does since F43);
  the Rent page has no "+ add item" UI, so a removed placeholder comes back only
  via `POST /api/housing/obligations`; `apps-script/Code.gs` keeps the pre-F32
  NOT_TRANSFER keyword list. Batch 5 follow-ons / later batches.
- The design & UX pass is DONE (`.cycle/plan-design-ux.md`, D1–D7 — INV-147, INV-148). Its
  follow-ons:
  - inline-styled buttons that keep their own colours (the Rent page's "Record payment" / Scan /
    Set, the dashboard's "+ Add bill" / "Save bill", the account cards' "Update balance" / "Mark
    shared", the Accounts page's own `button` rule), so they don't follow the filled-primary /
    outlined split; JS-built button labels aren't covered by the Title Case scans;
  - colours still to decide: Settle Up's amounts teal / gold by party, the YoY card's green / red
    arrows, the savings-rate gold level, the Rent & Utilities widget's gold / green balance (which
    also repeats the summary's rent item);
  - the sync strip repeats the summary's Sync Health warning; the stat-card row by Accounts
    overlaps the Summary card; the net-worth card reads "Not yet" until the first snapshot;
    getBillsDue counts a subscription marked paid early (as /api/forecast does);
  - the Review widget gives no suggestion for a CSV row's Teller-style "food & dining" (a
    mapCategoryFor gap);
  - no test renders every Perfin view through EJS (the extraStyles octal trap is pinned per page);
    the Settings index marks the deep-linked group only (no scroll-spy);
  - Per-sistant: the filled primary's text on a light accent is ~3:1 (a per-palette `--on-accent`
    would fix it); select options and modal titles stay in Title Case; empty states outside D6's
    list (Review, Today, Analytics, Health, Knowledge facts, templates) keep their plain line;
  - most font sizes and paddings in both apps are still literals on the token scale;
  - the landing reads both databases on every visit, and a slow line is dropped rather than
    filled in later; Per-sistant's `/api/stats` "overdue" still counts a task due today (the
    landing's `taskDueCounts` splits them); the drawer's Tax link and the dashboard's tax-season
    link follow the browser's date, not APP_TIMEZONE.
- Roadmap T3.3 (the year-end tax package) is DONE (`.cycle/plan-t3-3-tax-package.md`,
  K1–K4 — INV-146). K1 shipped the investment side on the server: every Plaid investment transaction
  stored (investment_transactions, by the flow sync) and `services/tax-investments.js` —
  FIFO realized gains, investment income and retirement distributions for a calendar year.
  They reach the package (K3) and the Tax page (K4). K1 follow-ons: lots are rebuilt
  from Plaid's ~24-month window, so a sale of shares bought before it has a NULL basis
  (reported as unknown, never $0) — the broker's 1099-B is the authority; wash sales,
  specific-lot / average-cost elections and corporate actions are not modelled (a split
  flags the security); manual and Teller-linked investment accounts have no transactions;
  a removed (inactive) account's rows still count for its years. K2 shipped the documents
  checklist on the server (`tax_documents`, `services/tax-documents.js`, the
  `/api/tax/documents` routes in routes/tax.js, `getIncomeForYear`) and the `tax_documents`
  linked-task source (default on; its Settings box). K2 follow-ons: Suggest runs only when
  asked (no schedule); a W-2 is
  suggested per payroll SOURCE name, so an employer whose deposits carry two names gets
  two; a 1099-INT from a bank can't be told apart from a brokerage cash sweep at the same
  institution (the larger of the two counts); suggestion reasons aren't stored; 1099-NEC /
  MISC / K / G and 1095 are manual only. K3 shipped the package on the server
  (`services/tax-package.js`, `services/zip-store.js`, `GET /api/tax/package` json / pdf / zip) and
  moved the deduction rows into `getTaxDeductionReport` and the landlord export's payments into
  `getHousingPayments` (both exports unchanged byte for byte). K3 follow-ons: the PDF lists at most 200 rows per section (the CSVs have them all);
  the package's PDF and ZIP are built in memory on each request (a few hundred KB); the ZIP's
  timestamp is the request time in UTC; package.json carries the whole package, merchant names
  included (the download is behind the shell gate like every export). K4 shipped the Tax page
  (`/tax`: the cards, downloads and checklist; the Settings and January–April dashboard links) and
  the section CSV. K4 follow-ons: the year default follows the browser's date, not APP_TIMEZONE
  (like the Budgets page); each checklist write reloads the whole package (a few queries); the
  page has no expected-by date editor (the API takes one) and no list of individual sales, sources or
  payments beyond the first eight (the CSVs have them all); the e2e click sweep counts controls on
  load, so the checklist rows it sees are the seeded ones.
- Roadmap T2.5 (transaction undelete + iOS re-authenticate) is DONE
  (`.cycle/plan-t2-5-undelete-ios-reauth.md`, U1 / U2 / H1 — INV-145). U1 shipped the server side of
  undelete — the delete's snapshot, `GET /api/deleted-transactions`, `POST
  /api/deleted-transactions/:id/restore` — and CSV imports that skip a deleted row (the Batch 6
  follow-ons); U2 the UI (Settings → Sync Health → Deleted transactions with Restore, and Undo
  on the Activity page's delete toast); H1 Re-authenticate / Add accounts through Plaid's hosted
  page on iOS / iPadOS, the home-screen app and the Capacitor wrapper (the Batch 19 follow-on).
  H1 follow-ons: Hosted Link's update-mode support was read from the Plaid SDK's types and
  Plaid's glossary, not live-tested — try it once on an iPhone; the flow is chosen by device, so
  a desktop browser that blocks popups still gets the in-page Link; update-complete doesn't check
  that the link_token was issued for the same item (the token comes from the page's own
  sessionStorage); Plaid keeps a session for six hours, so a return later than that reads as
  "none"; the investments-only Link still has no hosted variant for a NEW link. U2 follow-ons:
  the only delete in the UI is the Activity page's duplicate finder, so Undo lives there; the
  deleted list has no search or filter (newest first, 50 a page); an Undo toast lasts 10 s and
  a missed one leaves the Settings list as the way back. U1 follow-ons: a tombstone written before U1 shows only its id; Restore never starts a
  reconcile itself (a pre-U1 Teller / Plaid row needs Reconcile Now); snapshots are kept until
  a reset (no "delete forever").
- `ai_skipped_at` can't be cleared early (e.g.
  after switching the AI model); the rules list doesn't flag a stored rule
  skipped for being too short. Batch 7 follow-ons.
- The audit's entity check doesn't capture a capitalised "Cancel Netflix" at a
  sentence start; Ask's tool results still serialize DATE columns as full JSON
  timestamps; the budget-suggest and bill-scan usage rows record the configured
  model rather than the served one (categorize records the served one). Batch 8 follow-ons.
- The standalone HTTP webhook path still reports `sent: true` when Per-sistant's
  receiver stores a draft; the Sheets Important Dates tab lists a subscription
  by its one stored `next_expected` only; notification retention is a fixed 180
  days (no setting). OPERATOR: `clasp push` the Code.gs guard (F84). Batch 9
  follow-ons.
- The credit-score and AI-insights widgets have no Settings toggle (not in
  DASHBOARD_WIDGETS). Batch 10 follow-on (the budgets month picker and the chart
  redraw were fixed in roadmap T1.5 Batch B).
- Per-sistant: the palette / mode / collapsed-nav preference PATCHes still ignore
  failures (localStorage-first by design). Batch 11 follow-on (attachments on send
  and the failed-email error + Retry were fixed in roadmap T1.5 Batch C).
- Knowledge: a vault fact FILE with no
  non-reserved keys still drops its body at ingest; an unclosed frontmatter block is
  read as body text (its `sensitivity:` ignored); a vault too large for one recursive
  tree listing fails every sync with a full re-walk (F127 surfaces it — a subtree walk
  would index it). OPERATOR: run one full Knowledge reindex after deploying Batch 12 —
  F132 changed frontmatter parsing. Batch 12 follow-ons.
- Per-sistant's capture-to-vault file names use the UTC date (Perfin's F66
  equivalent; the AI cost-cap month was fixed in roadmap T2.3 C1 and Smart Suggestions'
  day in C2) — listed as a FOLLOW-ON entry in the timezone lint's KNOWN_GAPS
  (tests/scan-oct-batch13.test.js). `npm run reset:fresh` resets
  `shell_session_epoch` to 0, so a cookie minted before an earlier "Sign Out
  Everywhere" becomes valid again until it idles out. Per-sistant's standalone
  `POST /api/login` compares raw buffers (length-checked) rather than the SHA-256
  digest compare INV-104 describes. Batch 13 follow-ons.
- Refunds (F35): Settle Up's shared-card leg keeps its own refund rule (FAN-12 —
  no income exclusion, no category inheritance), so it can disagree with
  `REFUND_PREDICATE`; the Sheets Watchlist 90-day spend and `apps-script/Code.gs`
  stay gross; no UI copy says spending is net of refunds; budget snapshots taken
  before the Batch 14 deploy (outside the days 1–5 refresh) keep their gross
  spend and rollover. Batch 14 follow-ons.
- Watchdog / rename rules (F53 / F55): the watchdog runs only with detection (the
  6-hourly insights chain, `POST /api/detect`, daily-sync), so an alert can lag a
  charge by up to a day; there is no price-drop alert; a cancelled subscription
  sharing its merchant key with another product (one store, two plans) can raise a
  false "still charging". A rename rule's pattern can't be edited (delete +
  re-create; its name and on / off can since roadmap T1.5); rules aren't
  applied by the CSV CLI (`scripts/import-csv-cli.js` — the next sync applies them),
  have no Sheets tab, and a re-key onto a name that already has a row deactivates
  the old row rather than merging its user state; `PATCH /api/transactions/:id`
  with `apply_to_all` runs both detectors synchronously. Batch 15 follow-ons.
- Batch 16 follow-ons: a month whose archived rows were ALL deleted keeps its stale
  archive tab (the fingerprint query no longer lists it), and renaming an account
  doesn't rebuild its months (the account id is hashed, not its name); the generic
  CSV sign choice isn't remembered per account; a standalone deployment still has
  no Settings form for `persistent_url` / the webhook secret (the text now points
  at `PATCH /api/settings`); Per-sistant's `note_created` webhook still sends a
  private / secret note's TITLE (never its text), Knowledge's Secret lookup covers
  vault documents but not secret notes, and an untitled PRIVATE note's reminder
  shows its first 50 characters in the in-app notification list (only secret notes
  are masked there).
- Batch 17 follow-ons: the keep-alive / Job Radar / Knowledge-reindex workflow checks
  don't know whether those features are wanted, so a deliberately switched-off one
  still warns when its workflow is disabled; workflow secrets are checked for
  presence only (a wrong SERVER_URL / API_KEY shows up as failing runs); the Knowledge
  page and `/api/rag/status` don't show the parse version; the GitHub checks support
  github.com only; a SHELL_PIN under 6 characters is a standing dashboard warning.
- Batch 18 follow-ons: daily-sync's net-worth snapshot and detection steps still hold
  one request open; `knowledge-reindex.yml` prints its `{reindex, vault}` status JSON on
  a failed reindex (the vault block can carry repo / file names — an INV-103 gap that
  predates the batch); the background job slots are in memory, so a restart mid-run
  reads as "lost" (the step fails though the next run recovers); a deploy must reach
  the server before the next daily-sync — an old server answers 200 to
  `background: true`, which run_background reports as a failure.
- Batch 19 follow-ons (the in-page-only update mode on iOS was closed by roadmap T2.5 H1):
  update-complete doesn't refresh a new
  account's balance / liabilities (the next balance sync does) or write
  last_sync_result (an old plaid_txn error stays in Sync Health until the next full
  sync); investments-only Items never record a re-auth code (they show only "Add
  accounts", which re-authenticates too); a brokerage account added to a Transactions
  Item gets its holdings at the next holdings sync; the investments-only duplicate guard
  matches institution NAME + mask + type, so a separate same-broker login with a
  matching account would be refused, and pre-G3 rows have no mask until a holdings
  sync. The Liabilities "predates Plaid Liabilities; unlink it and link the bank again"
  message stays (update mode can't add a product).
- Roadmap T1.4 (Batch A) follow-ons: there is no permanent Mute for a known-benign error —
  Resolve hides it only until it happens again, so a recurring one can notify up to 5
  times a day (Per-sistant's "AI not configured" 500s are one, until T1.5 Batch C makes
  those routes 501 without logging); only the unified shell installs the console.error
  wrapper, so a standalone Perfin / Per-sistant records nothing; the heartbeat reports a
  failed job only for jobs that ran in the current process (a restart clears it).
- Roadmap T1.5 (Batch B) follow-ons: turning a rename rule off (like deleting it)
  doesn't re-key or re-run detection, so the next detection run creates a second
  subscription row under the bank's merchant name; the Budgets page's "this month"
  is the browser's month, not APP_TIMEZONE's.
- Roadmap T1.5 (Batch C) follow-ons: Per-sistant's compose dialog doesn't list an
  email's attachments or warn before Send that one's file is missing (the refusal
  arrives as the send's error toast); Retry sends a failed SCHEDULED email at once
  rather than offering to reschedule it.
- Roadmap T2.4 (cross-app automation) is DONE (`.cycle/plan-t2-4-crossapp-automation.md`,
  X1a–X3b): X1a shipped the linked-task store — db/030 (`todos.source_app` / `source_key` /
  `source_url` / `source_snapshot` / `auto_closed` / `source_detached`, a unique source_key
  that covers trashed rows, and a trigger that detaches a linked task whenever its completed
  state changes without the sync changing auto_closed) and `apps/per-sistant/services/
  linked-tasks.js` (syncLinkedTasks / ensureLinkedTask). X1b: an open task's title,
  description, due date and priority follow the source only while each still equals
  `source_snapshot` (your edit wins per field), and a linked task shows a "Perfin" chip
  (views/js.js `linkedTaskChip` — source_url is a path inside Perfin, joined with
  `window.LINKED_APP_BASES`: /perfin under the shell, PERFIN_URL standalone, plain text
  without one) on the To-Dos list, the dashboard task lists and the edit modal. X2a:
  Perfin's `teller/services/linked-tasks.js` computeLinkedTasks works out the tasks that
  should be open (rent & utilities due, utility amounts to enter, manual bills — off by
  default) and the `linked_tasks_*` settings exist (PATCH-validated). X2b: the runner
  (`runLinkedTasks`, the hourly `linked-tasks` away job, a refresh kicked by the housing and
  bill-payment routes after a write, the run recorded in `linked_tasks_state`) and the
  still-charging task from the subscription watchdog — the feature works once
  `linked_tasks_enabled` is set. X2c: Settings → Per-sistant Tasks (the switch, a box per
  source, lead days, the last-run line, "Run now" — `POST /api/linked-tasks/run`; standalone
  a note instead). X2c follow-ons: the last-run line's "outstanding" counts what Perfin has
  due, including a task you completed by hand; the section doesn't list the tasks
  themselves (they're in Per-sistant's To-Dos); Run now shares a running hourly run only
  through the 409 (press again once it ends). X3a: Per-sistant's `GET /api/search` also
  returns Perfin's transactions, subscriptions, manual bills, goals and accounts under the
  shell (`group: 'finance'`, read-only through perfinPool, fail-soft), shown by the dashboard
  search widget with links into Perfin. X3a follow-ons: the finance results are a flat 10 per
  kind with no paging or ranking across kinds; a transaction is found by its display merchant,
  notes or category only (not its raw bank description or amount); a recurring transfer or a
  housing obligation isn't searched. X3b: one renderer (`renderSearchResults`) for the dashboard
  widget and a new Per-sistant `/search` page, linked from both apps' navs (Perfin's under the
  shell only) — INV-144. X3b follow-ons: the /search page has no inline Complete / Send / Pin
  actions (the dashboard widget keeps them); the swipe-between-pages order doesn't include
  /search; a Perfin row opens the page that lists it (Activity filtered by merchant and month,
  the goals / subscriptions / calendar page) rather than the record itself. X2b
  follow-ons: a kicked refresh runs the whole computation (a few queries), not just the
  item that changed; the runner is in memory, so two processes (a deploy overlap) can run
  at once — both reconcile through the unique key and, since cycle-8 F20, one at a time under
  an advisory lock; transactions syncs don't
  kick it (the hourly run catches a deposit-driven change). X2a follow-ons: a ledger switched off reads as "nothing due", so its open tasks
  will close; a rent task groups the period's utilities under the RENT due date (the
  ledger is paid as one transfer); manual-bill occurrences follow the calendar's rule,
  which also projects months before the bill was created. X1b follow-ons: the Today page and the
  weekly review don't show the chip; a standalone Per-sistant's chip opens PERFIN_URL in a
  new tab only when PERFIN_URL is http(s). X1a follow-ons: a task you reopen by hand after an auto-close is
  detached for good (the sync never closes it again). (A trashed task's key freeing up at
  the 30-day purge was closed by cycle-8 F16 — the key is kept for good.)
- Roadmap T2.3 (an AI cost cap for every Per-sistant feature) is DONE
  (`.cycle/plan-t2-3-persistent-ai-cap.md`, C1–C4): the capped wrappers in
  `apps/per-sistant/ai.js` (APP_TIMEZONE spend month, a spend read that refuses the call
  when it fails; Job Radar on them), the nine routes/ai.js features and Knowledge's
  answer / diagram / capture on them (over the cap the action routes 429, Ask / Smart
  Suggestions keep their 200 shapes with `ai_cap`, the Knowledge answer is sources-only,
  the capture the raw note), and visibility (`GET /api/ai/usage`, the budget in Per-sistant
  Settings → AI Features with the per-feature spend, each app showing the other's month
  spend beside its own — INV-143). Follow-ons: `getAiBudgetInfo` falls back to the env /
  default budget when its settings read fails (only the spend read fails closed); the
  daily briefing and Smart Suggestions read the spend twice (their gate before the data
  queries, then the wrapper's own check); Knowledge's /query and /diagram run retrieval
  (and a Voyage query embedding, which the cap doesn't count) before the cap refuses the
  model call; Quick Add's AI path falls back to the local parser over the cap without
  saying why; the usage view covers the current month only (the ledger keeps the rows);
  two calls at once can both pass the check, so the month's last call can go slightly over
  (as in Perfin, AI-11).
- Roadmap T2.2 (low-balance and payday alerts) is DONE (`.cycle/plan-t2-2-cash-alerts.md`,
  L1–L4): the forecast as `services/cash-flow.js` (APP_TIMEZONE today, the lowest
  projected day), the low projected cash alert (`services/cash-alerts.js`, the
  `cash-alerts` away job, Settings → Cash Alerts), payday landed / missed
  (`services/payday-alerts.js`) and per-account floors + the last evaluation in Settings
  (INV-142). L4 follow-ons: floors run only while the Low Cash Alert switch is on; a floor
  alert is push-only (no critical-alert email); floors are set in Settings, not on the
  dashboard account card; the last-check line shows only the latest evaluation, and a
  floor account whose balance is stale is counted but not named. L1 follow-ons: the 60-day spending averages still use Postgres
  `CURRENT_DATE` (a documented rolling window); the projection is one total across
  depository accounts (the L4 floors are current-balance checks, not projections). L2 follow-ons: the alert compares
  the database's data stamps with the app's clock (a large clock skew between the two
  could delay a re-check to the next local day); with the alert on, the hourly settings
  read keeps a Neon database from suspending for long while the process is awake; the
  notification opens the dashboard, not the Cash Flow section (a hash link doesn't
  scroll to a section that renders after load). L3 follow-ons: the missed check runs in
  the cash-alerts job rather than inside runCashAlerts (so it works with the cash alert
  off); a paycheck that moves to a new source name reads as missed once (a merchant
  rename rule folds it back); a stream on an account with no connection (CSV / manual)
  never alerts as missed; "Paycheck landed" names the deposit's own amount and the
  stream's cadence, not the account.
- Roadmap T2.1 (bank webhooks) is DONE (`.cycle/plan-t2-1-webhooks.md`, W1–W6:
  receivers, event log, signature verification, Plaid transaction / item / holdings /
  investment-transaction events, webhook registration, Teller transactions.processed /
  enrollment.disconnected / webhook.test, Sync Health visibility). OPERATOR: Plaid
  webhooks turn on once `PUBLIC_URL` is set and Settings → Sync Health → "Register
  Plaid webhooks" is pressed once; Teller's once its dashboard has the URL and
  `TELLER_WEBHOOK_SECRET` is set. W6 follow-ons: the Connections list has no link
  per connection (re-auth is on the Accounts page); a webhook_events row a restart
  caught mid-handler counts in neither "done" nor "failed"; the 7-day quiet check
  can't tell a quiet account from a broken URL. W5 follow-ons:
  a Teller per-enrollment sync isn't serialized with a running syncAllEnrollments (both
  upsert idempotently; the watermark is written by whichever finishes last — never
  past data either fetched); Teller's transactions.processed payload shape (enrollment
  id vs account ids only) is from memory, so both are handled. POST /api/plaid/update-complete syncs its item with its own steps, so it
  doesn't stamp `plaid_items.last_synced_at` (the next scheduled sync does). W4
  follow-ons: an investments-only Item's ITEM re-auth events are ignored (no
  last_error_code there); whether update mode repairs USER_PERMISSION_REVOKED wasn't
  confirmable from the build environment (the notification also suggests unlink +
  link); passing `webhook` on the update-mode link token is assumed harmless;
  the webhook-triggered holdings sync isn't serialized with a scheduled one (both
  upsert the same rows).
  Teller's signature header format couldn't be re-checked against its docs from the
  build environment — confirm it before switching Teller webhooks on. A webhook_events
  row a restart caught mid-handler stays 'processing'.
- Seams & Invariants audit #3 follow-ons: after a restart while the database is
  unreachable the shell's session epoch reads 0, so a cookie revoked by "Sign Out
  Everywhere" works until the database answers (fail-open by design, X5); the
  weekly in-process reconcile and a weekly-reconcile.yml run that meet get a 409
  with id null and the workflow reads the idle slot's last state; `POST
  /api/plaid/sync-transactions` (no UI caller) and the reconcile legs don't stamp
  `last_txn_sync_at` or record `last_sync_result`, and the link exchanges' first sync
  runs outside `withPlaidTxnLock` (a new Item, so benign); Per-sistant's dashboard rent
  link uses `window.PERFIN_URL || '/perfin'` and nothing sets it, so a standalone
  Per-sistant links to `/perfin/housing` (C3); csv-import.yml passes the Google key
  CONTENT where sheets-sync.js expects a file path and `continue-on-error` hides it
  (O4 — fails once the repo is private); the Dockerfile's `TELLER_CERT_CONTENT` path
  writes the PEMs into the root-owned `/app` as `appuser` and fails (O5 — Render and
  fly.toml use `TELLER_CERT`); `npm run reset:fresh` clears `operator_checks_signature`
  (it keeps the backup record since cycle-8 E4a);
  Per-sistant `GET /api/calendar` defaults its month / year from the server clock
  (in the timezone lint's KNOWN_GAPS); the timezone lint still misses a UTC "today"
  computed through a Date assigned to a variable first.
- Batch 20 follow-ons: the e2e click sweep counts controls on page load, so controls
  inside a dialog a click opens, and rows rendered only after a click, aren't swept (the
  Activity page's rows appear after Search — its sweep presses 3 controls); Per-sistant's
  microphone buttons only `console.error` a refused permission (no toast); Save buttons
  that never had a pending toggle aren't single-flight (withPending covered the existing
  toggles only).

The bugs Batch 15's real-code tests exposed (calendar 500, Quick Add regexes,
palette picker under the shell, undefined CSS vars, unvalidated theme /
perfin_url) and its contract-coverage gap were fixed by the follow-on batch
(`.cycle/blocks/6-batch15-followons-broad-implement.md`). Still open:
- Plaid's transaction upsert (`teller/routes/investments.js` `upsertTxn`) builds
  the legacy `category` array as a concatenated `{a,b}` literal — the DC-14 class.
  Plaid's legacy category names contain no commas/quotes today, so it doesn't
  fire; it should take a `text[]` parameter like the CSV and manual paths.
- Per-sistant Quick Add computes its due date with `toISOString()` (UTC), so
  "tomorrow" typed late in the evening west of UTC lands a day late.
- Per-sistant `PATCH /api/settings` still stores `session_timeout_minutes` and
  `default_horizon` unvalidated.
- The contract suite doesn't drive the Plaid item loop (`syncAllPlaidTransactions`
  needs a Plaid client from env) or the Teller enroll / Plaid exchange routes.

## Git
- Render deploys from `main` (configured in the Render dashboard, not in `render.yaml`)
- PEM files and `.env` are in `.gitignore`

## Companion App: Per-sistant
- **Location**: `apps/per-sistant/` (subtree-merged into this repo; original
  per-sistant history preserved). Originally lived at `github.com/robinchoudhuryums/per-sistant`.
- **Purpose**: Personal assistant — task management, email scheduling, notes,
  AI productivity briefings, calendar, and a **personal Knowledge base**
  (vault-backed RAG: cited Q&A, structured facts, diagrams, capture, secret
  tier; grounds finance questions on Perfin data). See the Knowledge / RAG
  subsystem in the Cycle Workflow Config and the Knowledge section of
  `apps/per-sistant/CLAUDE.md`.
- **Integration under unified shell**: see "Per-sistant Integration" section
  above. Sub-app mounts at `/per-sistant/*`, shares the shell's session cookie,
  runs its own migrations against `PERSISTENT_DATABASE_URL`.
- **Per-app docs**: `apps/per-sistant/CLAUDE.md` for route-by-route architecture,
  `apps/per-sistant/README.md` for a public overview.
- **Standalone fallback**: `npm run start:persistent` boots it on its own
  port (3001) using the legacy `NEON_DATABASE_URL` fallback, useful for
  isolated debugging.

## Priority Next Features
1. **Mobile app (operator step)** — the Capacitor iOS wrapper is scaffolded in
   `mobile/` (remote-URL mode, coexists with the PWA); what remains is the
   free-signing Xcode build on the operator's Mac per `mobile/README.md`.
2. **Roadmap T4.1 — "Where should my extra money go?"** (done — A1, the engine
   `services/advice.js`, A2, GET /api/advice + the dashboard card + Ask's get_cash_plan, and A3, the cash_plan insight
   module, A4, the "tell me when my plan changes" checkbox, and A5, the emergency-fund tracker and goal
   catch-up, A6, raise / bonus split and spending creep, and A7, idle cash and rebalancing directions, A8, statement-date utilization and loan extra payments, A9, sinking funds and subscription consolidation, and A10, contribution room and what-if in Ask, are done — T4.1 is complete; plan `.cycle/plan-t4-1-advisory.md`): a code-computed plan — minimums, a starter cash buffer,
   high-APR card debt first with a per-card avalanche split, a 3-month emergency fund, then
   "invest $X more per paycheck" from a sustained surplus — on the dashboard, in AI insights and
   in Ask, with one opt-in "tell me when my plan changes" checkbox; then (A5–A9, done) emergency-fund
   and goal catch-up, raise / bonus split, spending creep, idle cash and rebalancing directions,
   statement-date utilization, loan extra payments, sinking funds and subscription consolidation, and (A10,
   done) tax-advantaged room and what-if questions in Ask.

Shipped (June 2026): **Job Radar (Per-sistant)** — a personal job-listing radar
built INTO Per-sistant (the Health & Habits module recipe: `db/021_jobs.sql` +
`apps/per-sistant/routes/jobs.js` + `pages/jobs.js` + `tests/jobs.test.js`).
Ingests Adzuna + direct ATS boards (Greenhouse/Lever/Ashby/Workable over a
curated, UI-editable `job_target_companies` allowlist), dedups on `content_hash`
(idempotent), then a **trust pass** (source weight + ghost-job freshness decay
from our own `first_seen` + corroboration + apply-domain + word-boundary scam
heuristics → trust_score/legitimacy) and a **fit pass** (Voyage embed cosine vs
a single `job_profile` row → a per-feature "Job Fit" Claude pass → 0–100
fit_score + rationale) + a **legitimacy** Claude pass for borderline rows. One
fail-soft `gatherJobRadarSummary` aggregator feeds the `/jobs` page, the
notification check, and one AI daily-briefing line (NO email digest — D3:
Per-sistant's proactive surface is the notification check; NO scheduler
heartbeat — D2). AI passes are **cap-charged** against a NEW Per-sistant AI
budget (`ai_usage` ledger + `ai_monthly_budget_cents` + `PERSISTENT_AI_BUDGET_CENTS`
+ `callAIWithUsage`/`recordAiUsage` in `ai.js` — D1; the 10 pre-existing AI
features still use the uncapped `callAI`). Weekly refresh via in-process
node-cron + `POST /api/jobs/refresh` + `.github/workflows/job-radar.yml`.
Default OFF (`job_radar_enabled`); reuses `services/embeddings.js` (voyage-3.5,
1024-dim) + `ANTHROPIC_API_KEY`; new env `ADZUNA_APP_ID`/`ADZUNA_APP_KEY`.
AI features 10→11 (Job Fit, default haiku). **Investment performance & allocation** — cost-basis
returns + asset-class allocation + target-drift
(`GET /api/investments/performance`) and portfolio value history vs S&P 500
benchmark (`GET /api/investments/performance-history`). **FIRE/runway
projections** — `GET /api/fire-projection` + Goals-page card
(`services/projections.js`). **Ask Perfin** — NL finance Q&A via Claude tool
use (`POST /api/ask`, dashboard widget). **Health/habits tracker** — built as
a Per-sistant expansion per the June 2026 decision (NOT a third shell sub-app:
Per-sistant already owned streaks/notifications/briefing; a third sub-app
costs a new DB + migration chain + nav/PWA identity). Shape as planned:
`apps/per-sistant/routes/health.js` + `pages/health.js` + 3 tables (db/020 —
habits, habit_logs, health_metrics), read-time streak computation, nudges via
the notification check + AI daily briefing. Escape hatch if it outgrows
Per-sistant: extract via the proven route-split + identity re-export recipe.

Dropped by design (June 2026): **multi-user support** — the single-user
assumption (single-row `user_settings`, server-side watermarks, no tenancy
dimension in queries) is a load-bearing simplification, not a gap; and
**onboarding flow** — single operator, already onboarded.

## Cycle Workflow Config

### Test Command
npm test

### Health Dimensions
Financial Data Accuracy, Sync Integrity & Idempotency, Income/Spending Classification,
AI Output Trustworthiness, Auth & Session Security, Secret & Token Handling,
Scheduler Reliability, Data Freshness & Reconciliation, Migration Safety,
Notification Correctness, Cross-app Integration Integrity, UI/UX & Accessibility,
External Export Fidelity, Knowledge Retrieval & Grounding, Test Coverage Quality

### Horizontal (Axis B) Categories
Silent Degradation Posture | failures that swallow errors and look like success
Startup Ordering Guarantees | migrations/cron/pool-wiring race or run out of order
Operator-Only State Gaps | undocumented manual setup (PEMs, passphrase, env vars)
Parallel Source-of-Truth Drift | SPLIT_AMOUNT/INCOME_PREDICATE copies diverging across files
Money / Precision Drift | NUMERIC rounding, split-sum ±$0.01, parseMoney edge cases
Test Coverage Quality | tests that pass regardless of the code under test

### Subsystems
Bank Sync & Ingestion:
  teller/routes/enrollments.js, teller/routes/investments.js,
  teller/routes/investment-performance.js, teller/services/plaid-client.js,
  teller/services/teller-api.js, teller/services/benchmarks.js,
  teller/data/csv-formats.js, scripts/import-csv-cli.js,
  teller/routes/webhooks.js, teller/services/webhook-verify.js,
  teller/routes/plaid-webhook-events.js, teller/routes/teller-webhook-events.js,
  teller/services/webhook-status.js, teller/services/txn-watermark.js
  (Teller and Plaid are co-equal, first-class linking paths — both write the
   same transactions/linked_accounts tables. Plaid additionally covers banks
   Teller doesn't, plus investment holdings.)
Detection & Categorization:
  teller/routes/subscriptions.js, teller/routes/transactions.js,
  teller/routes/categorize.js,
  teller/routes/categorize-helpers.js, teller/routes/merchant-rename.js,
  teller/data/reference-data.js, teller/services/cadence.js,
  scripts/detect-subscriptions.js, scripts/detect-transfers.js
Financial Analytics:
  teller/services/financial-queries.js, teller/routes/spending-analytics.js,
  teller/services/cash-flow.js, teller/services/cash-alerts.js,
  teller/services/payday-alerts.js, teller/services/advice.js, teller/services/advice-alerts.js,
  teller/services/allocation.js,
  teller/services/tax-investments.js,
  teller/services/tax-documents.js, teller/services/tax-package.js,
  teller/routes/tax.js, teller/services/projections.js, teller/routes/budgets.js,
  teller/routes/goals.js, teller/routes/credit-scores.js,
  teller/routes/dashboard-summary.js, teller/routes/advice.js,
  teller/routes/whats-new.js, teller/routes/watchlist.js,
  teller/routes/housing.js
  (housing.js = the Rent & Utilities single-payee ledger: obligations/payments,
   monthly generation + reminders, bill OCR, landlord export, and the partner
   even-up split feeding the dashboard Settle Up widget. Its page/view are
   covered by the Web UI globs.)
AI Insights & Audit:
  teller/routes/insights.js, teller/routes/insights-email.js,
  teller/routes/ask.js, teller/services/ai-audit.js, teller/services/claude.js
  (claude.js = the shared Claude 5.5 call helpers used by every Perfin model
   call, incl. categorize.js / budgets.js / housing.js in other subsystems)
Settings, Notifications & Cross-app:
  teller/routes/settings.js, teller/routes/notifications.js,
  teller/routes/persistent.js, teller/services/linked-tasks.js,
  teller/services/notify-prefs.js
  (Seam: the matching Per-sistant integration files —
   apps/per-sistant/routes/perfin.js + routes/webhooks.js — are audited
   together with this subsystem from both sides.)
Platform, Shell & Auth:
  shell/index.js, shell/landing-status.js, shell/boot-checks.js, shell/middleware/auth.js, shell/middleware/webauthn.js,
  shell/middleware/error-handler.js,
  teller/server.js, teller/startup.js, teller/services/database.js,
  teller/services/keep-alive.js, teller/services/job-health.js, teller/services/job-runner.js,
  teller/services/github-ops.js, teller/services/operator-checks.js,
  teller/services/hosting.js, teller/services/error-log.js, teller/services/uptime.js,
  teller/services/webauthn-ids.js,
  scripts/reset-fresh.js, scripts/ci-migration-test.js, db/*.sql
Web UI (Perfin):
  teller/pages/*.js, teller/views/*.ejs, teller/views/partials/*.ejs,
  teller/public/*.js, teller/public/*.css, teller/public/sw.js,
  shell/views/*.ejs, shell/public/*, design/tokens.json
  (design/tokens.json = the shared design values, also declared by Per-sistant's
   views/css.js — a seam with Per-sistant Web UI, checked by tests/design-tokens.test.js)
Sheets & External Export:
  scripts/sheets-sync.js, scripts/retention-cleanup.sql, apps-script/Code.gs,
  teller/services/csv-export.js, teller/services/zip-store.js
  (csv-export.js = the shared CSV cell helpers behind /api/export, the tax-report
   CSV, the housing landlord export and the tax package; zip-store.js = the
   STORE-only ZIP writer behind the tax package's download (T3.3 K3); the routes
   themselves stay in their own subsystems.)
Per-sistant Backend:
  apps/per-sistant/server.js, apps/per-sistant/ai.js, apps/per-sistant/config.js,
  apps/per-sistant/db.js, apps/per-sistant/errors.js, apps/per-sistant/helpers.js,
  apps/per-sistant/middleware.js, apps/per-sistant/routes/*.js,
  apps/per-sistant/services/keep-alive.js, apps/per-sistant/services/linked-tasks.js,
  apps/per-sistant/db/*.sql
  (Subtree-merged companion app, governed by THIS config to keep the two apps
   in lockstep — not a separate cycle. routes/perfin.js + routes/webhooks.js
   are the cross-app synergy seam shared with Perfin's Settings/Notifications/
   Cross-app subsystem.)
Per-sistant Web UI:
  apps/per-sistant/views.js, apps/per-sistant/views/*.js, apps/per-sistant/pages/*.js
Knowledge / RAG (Per-sistant):
  apps/per-sistant/routes/rag.js, apps/per-sistant/services/embeddings.js,
  apps/per-sistant/services/vault-sync.js, apps/per-sistant/pages/knowledge.js,
  apps/per-sistant/db/013_knowledge.sql, apps/per-sistant/db/014_vault_vectors.sql,
  apps/per-sistant/db/015_rag_cache.sql, apps/per-sistant/db/016_facts.sql,
  .github/workflows/knowledge-reindex.yml
  (Personal knowledge base: Obsidian-vault ingest + pgvector semantic retrieval,
   Citations, answer cache, structured facts + temporal validity, cross-app
   finance grounding, Mermaid diagrams, capture-to-vault, proactive surfacing.
   NOTE: embeddings.js + vault-sync.js are owned HERE, not by Per-sistant
   Backend (whose subsystem list names services/keep-alive.js explicitly, not
   services/*.js). Seam files shared with other subsystems: routes/notifications.js
   (fact_upcoming), routes/settings.js (vault config), ai.js (answerWithCitations),
   pages/settings.js + settings-script.js + pages/dashboard-script.js, server.js
   (vault-sync cron). CROSS-APP SEAM: rag.js reads Perfin's perfinPool
   (linked_accounts + investment_accounts via getNetWorth, detected_subscriptions)
   read-only — a new seam between
   Knowledge and Perfin's Bank Sync & Ingestion / Financial Analytics.)
Legacy Plaid Server:
  plaid/server.js
  (FROZEN — see Frozen Subsystems. The legacy standalone Plaid process only;
   the active Plaid path is teller/routes/investments.js under Bank Sync &
   Ingestion.)
n8n Workflows:
  n8n-workflows/*.json
  (FROZEN — see Frozen Subsystems. Superseded by teller/startup.js.)

### Invariant Library
INV-01 | Sync "added" counts only genuine inserts (RETURNING xmax=0), never updates | Subsystem: Bank Sync & Ingestion | Verify: tests/sync-durability.test.js
INV-02 | Teller watermark advances only when every account in the enrollment fetched AND upserted cleanly (a row-insert failure holds it too, BSI-7) | Subsystem: Bank Sync & Ingestion | Verify: code read syncEnrollment
INV-03 | Teller incremental filter uses >= against a 7-day lookback floor behind the day-granular watermark (lookbackFloor, BSI-8) | Subsystem: Bank Sync & Ingestion | Verify: code read
INV-04 | Plaid cursor advances only after a fully-successful page; persisted progressively; on mutation-during-pagination the loop restarts from (and re-persists) the loop-start cursor (BSI-12); new item accounts are registered before the walk so their rows can't FK-stall a page (BSI-1) | Subsystem: Bank Sync & Ingestion | Verify: code read syncPlaidItemTransactions
INV-05 | Reconcile is watermark-independent + idempotent; anomaly push suppressed | Subsystem: Bank Sync & Ingestion | Verify: reconcileTeller / tests/sync-durability.test.js
INV-06 | User overrides never clobbered by re-sync; display uses COALESCE | Subsystem: Bank Sync & Ingestion
INV-07 | Every spending aggregation applies SPLIT_AMOUNT (refund lines included) | Subsystem: Financial Analytics | Verify: tests/financial-queries.test.js
INV-08 | Reimbursed transactions (and reimbursed credits) excluded from all spending aggregations | Subsystem: Financial Analytics
INV-09 | transaction_splits replace parent in per-category totals; sum matches parent ±$0.01 | Subsystem: Financial Analytics
INV-10 | Keyword filters use word-boundary regex, never LIKE '%kw%' (a user-supplied LIKE pattern — rules, Ask merchant search — escapes \ % _) | Subsystem: Financial Analytics | Verify: tests/audit-regressions.test.js
INV-11 | Goal current_amount derived (balance − baseline) when funding-linked — including in the AI goal-tracking prompt (deriveGoalProgress, F62) and the cash plan's goal catch-up (advice.js's goals source, T4.1 A5) | Subsystem: Financial Analytics
INV-12 | Categorization writes user_category, never category | Subsystem: Detection & Categorization
INV-13 | Categorization rules applied before AI; only unmatched rows sent to Claude | Subsystem: Detection & Categorization
INV-14 | INSIGHTS_MONTHLY_BUDGET_CENTS enforced across insight+categorize+rebuild+ask+scan+suggest, every check reading the ONE monthAiSpendCents() (APP_TIMEZONE month, F66) | Subsystem: AI Insights & Audit | Verify: tests/ai-cap-charge.test.js + tests/scan-sept-batch7.test.js (AIN-10)
INV-15 | Insight cost uses granular token pricing (input + cache_read + cache_creation), keyed by MODEL ID (modelRates — previous models keep their own rates; Haiku 5.5 long-prompt card) | Subsystem: AI Insights & Audit | Verify: tests/model-upgrade.test.js
INV-16 | sanitizeStructuredSummary bounds the summary and requires all four arrays; failure, a max_tokens stop, or no tool call preserves the prior summary | Subsystem: AI Insights & Audit | Verify: tests/scan-sept-batch7.test.js (AIN-8)
INV-17 | Migrations run in one transaction; failure is fatal — except a lock timeout (55P03), which rolls back and is retried a bounded number of times; each run holds a per-app advisory lock and a SET LOCAL lock_timeout (cycle-7 F10); the IN-list CHECKs in CHECK_LISTS are brought in step inside that transaction (replaced NOT VALID only when their values differ, cycle-8 F31) | Subsystem: Platform, Shell & Auth | Verify: tests/scan-oct-batch13.test.js + tests/contract/platform-batch13.contract.test.js + tests/broad-scan-c8-batch8.test.js + tests/contract/c8-batch8
INV-18 | Scheduler invokes route logic via in-process helpers, never HTTP self-fetch | Subsystem: Platform, Shell & Auth
INV-19 | Named helper exports attached AFTER module.exports = router | Subsystem: Platform, Shell & Auth
INV-20 | Shell requireAuth honors x-api-key; embedded sub-apps skip own check | Subsystem: Platform, Shell & Auth | Verify: tests/audit-regressions.test.js
INV-21 | Shell safeReturnTo allows only same-origin absolute paths | Subsystem: Platform, Shell & Auth
INV-22 | Tokens + webhook secret encrypted at rest; mismatch surfaces as decryption_failed (sync token reads use perfin_try_decrypt, never the raising pgp_sym_decrypt — one stale row never fails the query) | Subsystem: Platform, Shell & Auth
INV-23 | Service worker never caches /api/* | Subsystem: Web UI
INV-24 | sheets-sync.syncAll isolates each tab (per-tab try/catch + errors[]) AND every syncAll caller records the outcome via recordSheetsSyncResult (last_sheets_sync_result; one notification per change in the failing-tab set) — errors[] is never ignored | Subsystem: Sheets & External Export | Verify: tests/scan-sept-batch10.test.js (SXE-1 block)
INV-25 | Embedded sub-apps detect req.app.get("embedded") and skip their own auth; cross-app calls use the wired pool (perfinPool/persistentPool), never HTTP self-fetch | Subsystem: Per-sistant Backend / Platform, Shell & Auth
INV-26 | Teller transaction pagination terminates on an empty page (count-explicit + from_id), never a hard-coded page-size compare | Subsystem: Bank Sync & Ingestion | Verify: tests/cycle-fixes.test.js (BS-1 block)
INV-27 | Only sensitivity='normal' docs/facts are embedded AND retrieved; private/secret are never embedded or sent to AI. Frontmatter sensitivity resolution FAILS CLOSED: YAML comments stripped, block lists parsed, yes/no/on/off understood, the most restrictive of sensitivity/embed/private wins, and any unrecognized value → private (KR-2). Hard-deleted notes/documents are never vector-retrieved (the joined source row must exist, KR-6). Trailing whitespace on a `---` delimiter still parses, and a repeated sensitivity / embed / private key keeps every value so the most restrictive wins (cycle-7 F132). A quoted key is read, and a frontmatter line the parser can't read that starts with a privacy key resolves private (cycle-8 F49). NOTES follow the same rule since cycle-7 F134 / ST5: only notes.sensitivity='normal' notes are embedded, keyword- or vector-retrieved, listed in Ask's context or AI-tagged; a note leaving 'normal' loses its chunks + embed_state, and outside webhooks never get a private / secret note's text | Subsystem: Knowledge / RAG | Verify: tests/knowledge.test.js (buildRetrievalQuery), tests/knowledge-facts.test.js, apps/per-sistant/tests/scan-sept-fixes.test.js (KR-2/KR-6), apps/per-sistant/tests/scan-oct-batch16.test.js + tests/contract/batch16-persistent.contract.test.js (notes), apps/per-sistant/tests/broad-scan-c8-batch6.test.js (F49)
INV-28 | pgvector objects are created defensively — the CREATE EXTENSION is attempted in an EXCEPTION block and vector objects are built only when the extension is INSTALLED (pg_extension), so an available-but-not-creatable extension degrades too (cycle-7 F10); the migration succeeds and Knowledge degrades to keyword retrieval rather than failing boot — and the vault sync still ingests documents + facts without Voyage/pgvector, embedding them later via the backfill (KR-3) | Subsystem: Knowledge / RAG | Verify: code read db/014_vault_vectors.sql + vault-sync.vectorReady
INV-29 | Retrieval is HYBRID (vector + keyword legs fused via Reciprocal Rank Fusion, each leg ranked per distinct source — the vector leg over-fetched 4× and collapsed to the best chunk per source; keyword terms drop function-word stopwords; keyword hits carry the matching passage, KR-4) — either leg failing degrades to the other alone; /query & /diagram degrade to sources-only / null when AI is off or unavailable — and, since roadmap T2.3 C3, /query to sources-only (ai_cap) over the monthly AI budget | Subsystem: Knowledge / RAG | Verify: tests/knowledge.test.js, apps/per-sistant/tests/rag-v2.test.js
INV-30 | Embedding dimension (1024) matches chunks.embedding vector(1024); a provider/dimension change is a re-embed migration, not a config flip | Subsystem: Knowledge / RAG | Verify: code read services/embeddings.js EMBED_DIM
INV-31 | embed_state content-hash skip prevents re-embedding unchanged sources | Subsystem: Knowledge / RAG | Verify: code read vault-sync.embedSource
INV-32 | Answer cache keyed on query+model+corpus_version ("<APP_TIMEZONE date>|" + notes+documents+facts+fact_verifications max(updated_at)+count — F14 folds in fact_verifications so verify/unverify invalidates; the date prefix (KR-5) expires cached answers when a fact's valid_from/valid_to boundary passes, and vault re-syncs no longer bump updated_at on unchanged documents/facts), with a SEMANTIC fallback layer (query-embedding cosine >= 0.97, same model+corpus_version+TTL — RAG v2, db/019); a SEMANTIC hit returns sources_from_similar_query=true (the cached sources reflect the original query's retrieval and the answer's [n] links are tied to that ordering, so they're kept, not re-retrieved — the Knowledge page caveats it; F12); finance-grounded answers bypass both layers; only a COMPLETE answer is cached — an empty one or a `max_tokens` stop is returned once (truncated:true) and never stored (cycle-7 F126) | Subsystem: Knowledge / RAG | Verify: tests/knowledge-cache.test.js + apps/per-sistant/tests/rag-v2.test.js + routes/rag.js useCache gate
INV-33 | Vault sync is read-only (VAULT_GITHUB_TOKEN); capture writes only with the separate write-scoped VAULT_GITHUB_WRITE_TOKEN (400 until set) | Subsystem: Knowledge / RAG | Verify: tests/knowledge-capture.test.js
INV-34 | Citations enabled all-or-none per request; incompatible with structured outputs (unused here) | Subsystem: Knowledge / RAG | Verify: tests/knowledge.test.js (answerWithCitations)
INV-35 | Cross-app finance grounding reads perfinPool read-only, only on finance queries, never an HTTP self-fetch (parallels INV-25) | Subsystem: Knowledge / RAG | Verify: tests/knowledge-crossapp.test.js
INV-36 | Single in-process vault-sync lock (isSyncing) prevents overlapping cron/reindex/GH-Action runs — BOTH syncVault AND syncNotes acquire it (busy→no-op), claimed synchronously before the first await (KR-8), so the cron's notes phase can't overlap a concurrent reindex (K4); vault_last_sha and vault_last_synced_at advance only when EVERY file succeeded (a failing file is isolated, removals run first, the error is recorded and the next sync retries the range — KR-7/KR-11); vault_last_attempt_at stamps every run; a truncated tree listing, or a compare whose status isn't ahead/identical (force-push → diverged), never lets the SHA advance past unseen files — the former is a reported failure, the latter forces a full walk + sweep (cycle-7 F127/F133); a file over 1 MB is read through the blobs API, never ingested empty (F128) | Subsystem: Knowledge / RAG | Verify: code read vault-sync.syncVault + syncNotes
INV-37..47 | RETIRED — assigned by the cycle-3 reflect but their definitions were never written into the repo and are unrecoverable; numbers burned, never reuse (their subject matter — the cycle-3 fixes — is test-pinned via tests/cycle-fixes.test.js + audit-regressions) | — | Verify: n/a
INV-48 | SPLIT_AMOUNT / INCOME_PREDICATE / NOT_TRANSFER are never re-inlined: every spending aggregation imports from financial-queries.js (aliased variants via incomePredicate(alias) or derived in place via .replace); the only permitted literal copies are scripts/sheets-sync.js (structure byte-pinned by SX3; every one of its five SPLIT CASE copies pinned since seams audit #3) + apps-script/Code.gs (legacy, unpinned) | Subsystem: Financial Analytics (seam) | Verify: tests/seams-audit.test.js literal-CASE scan (teller routes/services/top level/data/pages + scripts) + tests/audit-regressions.test.js SX3
INV-49 | Every member of Perfin's EMAIL_EVENTS set is accepted AND named (sendNameByEvent) by Per-sistant's HTTP webhook receiver — an unrecognized email event is 200-and-dropped in standalone deployments | Subsystem: Settings, Notifications & Cross-app (seam) | Verify: tests/seams-audit.test.js symmetry pin
INV-50 | WebAuthn auth-options advertise transports ['internal'] ONLY in allowCredentials (NOT 'hybrid') — registration pins authenticatorAttachment:'platform' so credentials are same-device; advertising the cross-device 'hybrid' transport is what surfaced the "use a phone" QR option instead of local Touch/Face ID, so internal-only suppresses the QR path; both shell and standalone auth-options endpoints comply (transports still persisted at registration, just not used as the login hint). NOTE (seams audit #3): the QR prompt also had a second cause — registration stored every credential id double-encoded, so allowCredentials named an id no authenticator holds; see INV-136 | Subsystem: Platform, Shell & Auth | Verify: tests/budget-cap-webauthn.test.js
INV-51 | Habit streaks are computed at read time from habit_logs (a backfilled log retroactively repairs a streak; an unlogged today never breaks one); no stored streak counters exist for habits | Subsystem: Per-sistant Backend | Verify: apps/per-sistant/tests/health.test.js backfill-repair test
INV-52 | Health consumers (notification check, AI daily briefing) call gatherHealthSummary fail-soft (.catch) — a health-tables error degrades to "no habit data", never 500s those surfaces | Subsystem: Per-sistant Backend | Verify: apps/per-sistant/tests/health.test.js integration pins
INV-53 | CRITICAL scheduled jobs (transaction/balance sync + snapshot + detection; weekly reconcile; backups — and the knowledge reindex, which Operator Checks lists as an OPTIONAL backstop because the feature is opt-in) have out-of-process GitHub-Actions backstops hitting x-api-key endpoints with idempotent writes, so Render free-tier sleep can't skip them | Subsystem: Platform, Shell & Auth | Verify: .github/workflows/{daily-sync,weekly-reconcile,db-backup,knowledge-reindex}.yml exist + idempotent-write invariants INV-01/05
INV-54 | Re-sync is BEHAVIORALLY idempotent: syncAllEnrollments (Teller) + syncPlaidItemTransactions (Plaid) run twice over identical inputs add 0 on the 2nd run, no duplicate rows, watermark/cursor stable (not merely source-string-pinned) | Subsystem: Bank Sync & Ingestion | Verify: tests/sync-idempotency.test.js
INV-55 | /api/ask charges the shared AI cap even on a mid-tool-loop failure — the usage row is written in a `finally` (idempotent `charged` flag) when tokens were consumed, so a throw on a later round doesn't let spend escape the cap (parity with rebuild AIA2 / categorize M2); `charged` is set only after the row is written, so a failed write is retried (F64) | Subsystem: AI Insights & Audit | Verify: tests/ai-cap-charge.test.js
INV-56 | The dashboard's inlined loanPayoff() is NUMERICALLY identical to services/projections.computeLoanPayoff across scenarios (months / total_interest ±$0.01 / insufficient flag), not merely string-equal | Subsystem: Web UI ↔ Financial Analytics (seam) | Verify: tests/loan-support.test.js (extract-and-run parity test)
INV-57 | The critical-audit notification is deduped to ≤1 per 24h via sentRecently('audit-alert', 24), fail-open — a steady-state critical finding doesn't re-push on every 6h auto-insight tick | Subsystem: AI Insights & Audit / Notification Correctness | Verify: code read routes/insights.js audit-alert gate
INV-58 | A kind='quantity' habit always has a non-null target_value, enforced on POST AND on PATCH against the MERGED post-update state (so switching to quantity without a target, or nulling a quantity habit's target, 400s instead of silently degrading meetsTarget) | Subsystem: Per-sistant Backend | Verify: apps/per-sistant/tests/health.test.js (F9 PATCH tests)
INV-59 | Bounded settings (target_allocation_pct, shell_idle_timeout_minutes, fire_*, ai_monthly_budget_cents, and since PSC-15 keep_alive_start/end, keep_alive_timezone (Intl-validated), auto_sync_interval_hours, csv_reminder_days, weekly_digest_day — strict integer parse, null/""/"6abc" rejected; since cycle-7 F86 also theme, dashboard_months, insights_model, insights_cadence_days, insight_modules / dashboard_widgets, pyramid_*, debt_baseline_amount, sheets_auto_sync_interval, session_timeout_minutes; since cycle-7 F81 insight_emails_enabled as a strict boolean; since T2.2 L2 cash_alert_enabled (strict boolean), cash_alert_threshold and cash_alert_horizon_days; since T2.2 L3 payday_alerts_enabled (strict boolean); since T4.1 A4 advice_alerts_enabled (strict boolean); since T4.1 A10 contribution_limits (known keys → 0-1,000,000); since T2.4 X2a linked_tasks_enabled (strict boolean), linked_tasks_sources (known sources → booleans) and linked_tasks_bill_lead_days (0-14); since cycle-8 E3a notify_quiet_hours (enabled strict boolean, HH:MM, start ≠ end) and notify_muted_types (known mutable kinds)) reject invalid input with 400 — never silent-drop + 200 | Subsystem: Settings, Notifications & Cross-app | Verify: tests/budget-cap-webauthn.test.js (PATCH /api/settings validation) + tests/scan-sept-batch9.test.js (PSC-15) + tests/scan-oct-batch9.test.js (F86)
INV-60 | Perfin "Sign Out" clears the SHELL session via the root POST /logout under the unified shell (not a basePath'd /api/logout); redirect target is the root /login — both un-prefixed; standalone Perfin (no BASE_PATH) posts /api/logout instead (WD-16), and Per-sistant's embedded Log Out also posts the root /logout (PB-21) | Subsystem: Web UI ↔ Platform, Shell & Auth (seam) | Verify: code read teller/views/settings.ejs logout() + shell POST /logout (auth.handleLogout)
INV-61 | apiFetch redirects once to /login (with return_to = the current path, F102) on a 401 or a followed 302→/login (session expiry), loop-guarded, while returning the Response unchanged to callers — idle timeout never leaves a blank/error UI | Subsystem: Web UI | Verify: code read teller/public/perfin-shared.js apiFetch
INV-62 | The shell sets a nonce CSP + frame-ancestors 'none' + X-Frame-Options on its own routes (login/landing), with COOP/CORP/COEP DISABLED so the global middleware doesn't break sub-app Plaid/Teller Link popups, and Perfin's own helmet sends COOP same-origin-allow-popups, never same-origin (cycle-7 F9); helmet is a declared shell dependency | Subsystem: Platform, Shell & Auth | Verify: header assertion on GET /login (frame-ancestors none, COOP/CORP absent, login scripts nonced) + tests/contract/platform-batch13 (Perfin COOP)
INV-63 | Per-sistant's shared fetch wrapper (apps/per-sistant/views/js.js) redirects once to the root /login (with return_to = the page's path + query, cycle-8 F40) on a 401 or a followed 302→/login (session expiry), loop-guarded, returning the Response unchanged to callers — parity with Perfin INV-61, so an idle-timeout never leaves a blank/error page. The check uses indexOf('/login'), NOT a regex, because the module is one backtick template literal that eats regex backslashes (see Per-sistant CLAUDE.md gotcha) | Subsystem: Per-sistant Web UI | Verify: code read views/js.js fetch wrapper
INV-64 | Job Radar's AI passes (job_fit + legitimacy) are cap-charged: cappedCall (since roadmap T2.3 C1 an alias of ai.cappedAI) reads getAiBudgetCents()+monthlyAiSpendCents() (the APP_TIMEZONE month; a spend read error is CAP_CHECK_FAILED and stops the pass) and throws { code:'CAP' } BEFORE calling the model when over budget; on a call that returned tokens it charges an ai_usage row via recordAiUsage once in a `finally`. Every other Per-sistant AI feature is on the same wrappers since T2.3 C2 / C3 — this is the Job Radar case of INV-143 | Subsystem: Per-sistant Backend | Verify: apps/per-sistant/tests/jobs.test.js (cappedCall charge-on-success + throw-CAP-before-model-call)
INV-65 | Job Radar ingest is content_hash-idempotent: dedupPersist upserts ON CONFLICT (content_hash) and counts genuine inserts via (xmax = 0), so a re-run over identical listings adds 0, no duplicate rows. Retention strips old new/dismissed descriptions but KEEPS the hash+status tombstone so a dismissed job re-ingested stays dismissed | Subsystem: Per-sistant Backend | Verify: apps/per-sistant/tests/jobs.test.js (dedup idempotency, retention)
INV-66 | gatherJobRadarSummary is the SINGLE fail-soft aggregator feeding the /jobs page, the notification check, and the AI daily-briefing line (the gatherHealthSummary pattern) — a query error returns the safe empty shape, never 500s those surfaces; the notif-check + briefing call it gated on job_radar_enabled. Listing status changes ARCHIVE (saved/applied/dismissed), never hard-delete, and removing a target company deactivates it (active=false — the db/021 seed would re-insert a deleted row) | Subsystem: Per-sistant Backend | Verify: apps/per-sistant/tests/jobs.test.js (aggregator fail-soft + archive-not-delete)
INV-67 | Every transaction-sync trigger (POST /api/sync + daily-sync.yml, bank auto-sync, pre-insights chain) goes through syncAllTransactions — Teller then Plaid, each failure-isolated — and runAnomalyCheck runs ONCE over the combined added count; a Plaid webhook's per-item sync runs the same post-sync steps (runPostSyncSteps — rename rules, then one check, then the payday-landed alert since T2.2 L3; serialized, so two syncs finishing together check in turn); reconcile/backfill never runs it | Subsystem: Bank Sync & Ingestion | Verify: tests/scan-sept-batch2.test.js (BSI-2 / DD-1 block) + tests/roadmap-t2-webhooks-w3.test.js
INV-68 | last_sync_result is merged PER PROVIDER (a write replaces only the providers it ran; null result = untouched), never last-writer-wins; errors[] is the flat union | Subsystem: Bank Sync & Ingestion / Data Freshness | Verify: tests/scan-sept-batch2.test.js (BSI-11 block)
INV-69 | incomePredicate(alias) qualifies EVERY outer column reference with the caller's alias, including inside the __t2 double-count guard (an unqualified ref inside a subquery resolves to the subquery's own table) | Subsystem: Financial Analytics | Verify: tests/scan-sept-batch3.test.js (FAN-2) + tests/ops-and-alerts.test.js
INV-70 | Recurring projections (detection next_expected, /api/forecast, /api/bill-calendar, /calendar.ics, the /api/cash-flow bill schedule, POST /api/subscriptions) step month-scale cadences (30/60/90/365) by CALENDAR MONTH via services/cadence.js, anchored on the last real charge with next_expected as the lower bound — never a fixed N×86400000 step; manual bills use ONE placement rule (manualBillOccurrences) on both the calendar and the ICS feed | Subsystem: Detection & Categorization | Verify: tests/scan-sept-batch4.test.js (DC-9 / DC-15 blocks)
INV-71 | Detection never re-activates a series whose last charge is past the stale window (isStale, same window as the stale sweep), and never overwrites a user-set transfer_type (transfer_type_user_set) | Subsystem: Detection & Categorization | Verify: tests/scan-sept-batch4.test.js (DC-2 / DC-4 blocks)
INV-72 | The Rent & Utilities ledger is single-payee: generation covers the trailing 24 months and never regenerates a period that already has a rent row (any payee) or a same-label utility row; a payee/label rename carries the stored rows over (planConfigUpdate) instead of creating new ones; ledger + split are scoped to the configured payee; an auto-generated row the user removed is never regenerated (payee_obligation_skips, F33) | Subsystem: Financial Analytics | Verify: tests/scan-sept-batch5.test.js (FAN-3 / FAN-4 blocks) + tests/contract/money-classification.contract.test.js (F33)
INV-73 | Budget status has ONE definition — getBudgetStatus(pool, month) in financial-queries.js (spend via getCategorySpendingForMonth; effective_limit = monthly_limit + the PRIOR month's snapshot rollover when rollover_enabled; one-time budgets only in their effective_month). GET /api/budgets, /api/budgets/alerts, the insights prompt and the Ask budget tool call it; the Sheets Budget Status SQL mirrors it; no surface reads the bare monthly_limit as the limit | Subsystem: Financial Analytics | Verify: tests/scan-sept-batch6.test.js (AIN-6 block)
INV-75 | The tax report (export + Sheets tab) is computed from transactions via getTaxDeductionTransactions (one shared keyword list); the tax_deductions table only annotates merchants and never supplies amounts | Subsystem: Financial Analytics / Sheets & External Export | Verify: tests/scan-sept-batch7.test.js (SXE-7)
INV-76 | No model call uses a forced tool_choice (Opus/Sonnet 5.5 400 on it): structured calls go through createToolCall (auto + strict tool + one re-ask, usage summed for the cap); every call sets an explicit effort and reads content blocks by type | Subsystem: AI Insights & Audit (seam: categorize / budgets / housing / Per-sistant ai.js) | Verify: tests/model-upgrade.test.js + apps/per-sistant/tests/model-upgrade.test.js
INV-77 | Away-from-app channels (budget alerts + critical-alert email, weekly digest, daily digest, CSV reminder, Rent & Utilities reminders — F15, the low cash and missed-payday alerts — T2.2 L2 / L3, the linked tasks — T2.4 X2b, the plan-change alert — T4.1 A4, the quiet-hours release — cycle-8 E3b, its gate an in-memory "something is held" flag) are never gated on isUserActive(); each is bounded by its own watermark (last_weekly_digest_at / last_daily_digest_at / last_csv_reminder_at / sentRecently / cash_alerts_checked_at + cash_alert_state; advice_state.checked_on + signature; the linked tasks: a clean run's local day, with every write that can change a task kicking its own refresh — cycle-8 F21) plus a per-local-day settled memo, so it neither misses an away user nor re-queries the DB all day; every scheduled job runs when it is due — checked a minute after boot and every 5 minutes, from job_runs.last_ran_at (the job runner, cycle-8 E2b; it replaced F27's boot runs) — so a host that sleeps between requests still reaches them | Subsystem: Platform, Shell & Auth / Notification Correctness | Verify: tests/scan-sept-batch8.test.js (PSC-3 block) + tests/roadmap-t2-2-cash-l2.test.js
INV-78 | The auto-sync "complete" notification fires only on genuinely new transactions or a balance that actually changed (accounts_changed), and never while sync_notifications_enabled is false | Subsystem: Bank Sync & Ingestion / Notification Correctness | Verify: tests/scan-sept-batch8.test.js (PSC-1 block)
INV-79 | The shell PIN gate has a GLOBAL failure ceiling (30 failed PINs/hour across all IPs → PIN login locked 30 min, even for the correct PIN, with at most one sendToAll alert per 6h — makeLockoutNotifier); biometric + x-api-key paths are unaffected; the shell refuses to boot without SHELL_SECRET; no login input can crash the process (and so reset the in-memory counter) — see INV-104 | Subsystem: Platform, Shell & Auth | Verify: tests/scan-sept-batch9.test.js (PSC-14 / PSC-11 blocks) + tests/scan-oct-batch1.test.js (F1 / F7 blocks)
INV-80 | Per-sistant outbound webhooks/Slack are SSRF-checked at send time by resolveSafeWebhookTarget — literal IPs in any spelling (IPv4-mapped/compatible IPv6 unwrapped) and EVERY DNS-resolved address must be outside the net.BlockList private ranges; DNS failure fails closed; fetch uses redirect:'manual' | Subsystem: Per-sistant Backend | Verify: apps/per-sistant/tests/scan-sept-batch9.test.js (PB-14 blocks)
INV-81 | scripts/reset-fresh.js classifies EVERY table the Perfin migrations create into exactly one of WIPE_TABLES / KEEP_TABLES / UNTOUCHED_TABLES (schema_migrations is never wiped) | Subsystem: Platform, Shell & Auth | Verify: tests/scan-sept-batch9.test.js (PSC-6 block)
INV-82 | Sheets formatting is re-runnable: formatSheet deletes a tab's banding + conditional-format rules before re-adding them (Dashboard also resets cell formats), so a second syncAll over the same spreadsheet succeeds | Subsystem: Sheets & External Export | Verify: tests/scan-sept-batch10.test.js (SXE-2 block, stateful fake Sheets API)
INV-83 | No exported text is ever evaluated as a formula: Sheets writes go through guardSheetsWrites (strings starting = + - @ tab/CR, or date-shaped, are "'"-prefixed; only sheetFormula() values pass through) and every CSV download builds text cells with csvText | Subsystem: Sheets & External Export | Verify: tests/scan-sept-batch10.test.js (SXE-13 block)
INV-84 | A month archive tab is written only once the month is settled (month-end + 10 days) and counts as current only while its completion marker carries the month's LIVE content fingerprint (ARCHIVE_MONTHS_SQL, cycle-7 F85); an unmarked, legacy (fingerprint-less) or stale-fingerprint archive is cleared and rebuilt within MAX_ARCHIVES_PER_RUN, never trusted | Subsystem: Sheets & External Export | Verify: tests/scan-sept-batch10.test.js (SXE-3 block) + tests/scan-oct-batch16.test.js + tests/contract/batch16-perfin.contract.test.js (F85)
INV-85 | A failed Knowledge sync is visible: vault_last_synced_at means last SUCCESS (vault_last_attempt_at records attempts), /api/rag/status reports reindex.ok, the knowledge-reindex Action polls it and fails on ok:false, and the notification check raises vault_sync_error while vault_last_error is set | Subsystem: Knowledge / RAG | Verify: apps/per-sistant/tests/scan-sept-batch11.test.js (KR-11 block)
INV-86 | A capture marked private or secret is never sent to the AI for structuring and is committed with that sensitivity; model-supplied fields never write reserved frontmatter keys (type/sensitivity/embed/private/valid_*…) | Subsystem: Knowledge / RAG | Verify: apps/per-sistant/tests/scan-sept-batch11.test.js (KR-10 block)
INV-87 | Plaid holdings mirror Plaid's response per returned account: every holdings write goes through writePlaidHoldings, which prunes that account's positions no longer returned (other accounts untouched); an unknown cost basis is stored NULL and never counted as a $0 basis in returns (cost_basis_coverage reports the known share) | Subsystem: Bank Sync & Ingestion / Financial Analytics | Verify: tests/scan-sept-batch12.test.js (BSI-4 / BSI-5 blocks)
INV-88 | TWR/XIRR treat an account that first appears mid-window as an opening inflow on its first snapshot date (its own flows on/before that date are part of the balance), never as investment return | Subsystem: Bank Sync & Ingestion (investment-performance.js) | Verify: tests/scan-sept-batch12.test.js (BSI-6 block)
INV-89 | Every Perfin page write reports its outcome: the response goes through writeOk (2xx → continue, else a toast with the server's error), never `await apiFetch(...)` then assume success; prompt amounts go through parseAmountInput and a non-number is refused | Subsystem: Web UI | Verify: tests/scan-sept-batch13.test.js (WUI-6 / WD-12 blocks)
INV-90 | Every Perfin modal (and the bell panel) is a dialog via openDialog / watchDialog — role="dialog" aria-modal, focus moved in, Tab trapped, Esc closes, focus restored; and every var(--x) used without a fallback is defined in perfin-shared.css | Subsystem: Web UI | Verify: tests/scan-sept-batch13.test.js (IF-1 / IF-4 blocks)
INV-91 | The Job Radar main bucket (and so top_pick, the job_radar notification and the briefing line) holds only listings with trust ≥ 60, a NON-NULL fit_score ≥ 65 and no 'suspect' verdict; an unscored or suspect listing is "verify first", a 'scam' verdict is never shown, and a 'new' listing ≥ STALE_DAYS behind the latest refresh's last_seen is dropped; each refresh re-scores trust for every live listing (keeping a Claude verdict) and a profile text edit clears the fit scores | Subsystem: Per-sistant Backend | Verify: apps/per-sistant/tests/scan-sept-batch14.test.js (PB-4 / PB-5 / PB-6 blocks)
INV-92 | The Per-sistant service worker never reports a queued write as success (offline → 503 ok:false), never queues send / refresh / AI / RAG / auth writes, never caches /api/rag/secret* or auth responses, and removes a queued entry only on a definitive answer (2xx or a non-retryable 4xx) or after 24h | Subsystem: Per-sistant Web UI | Verify: apps/per-sistant/tests/scan-sept-batch14.test.js (PB-17 block — the emitted sw.js run in a vm)
INV-93 | Every stored automation is validated by helpers.validateAutomationRule (runnable trigger/action pair for the trigger's entity, required value, priority/horizon enums) on POST and merged PATCH, runAutomations skips an invalid stored rule and isolates each rule in its own try/catch, and a set_* action only ever touches the todo that fired it | Subsystem: Per-sistant Backend | Verify: apps/per-sistant/tests/scan-sept-batch14.test.js (PD-6 block)
INV-94 | A change to route SQL or router mounting keeps the real-Postgres contract suite green: tests/contract/ runs both apps' own migrations and mounts every router in the order parsed from teller/server.js and apps/per-sistant/server.js with the real deps object — if either server.js's mount spelling changes, the parser regexes (pinned by scan-sept-batch15) must be updated, never bypassed | Subsystem: Test Coverage Quality (all route subsystems) | Verify: CI migrations job (npm run test:contract) + tests/scan-sept-batch15.test.js (contract wiring)
INV-95 | Source guards (un-nonced style, root-relative navigation, undefined CSS vars) carry a KNOWN_GAPS list that only shrinks: a new offender fails, and so does a listed entry that no longer occurs; a test never re-implements production logic inline (TQ-1) | Subsystem: Test Coverage Quality | Verify: tests/scan-sept-batch15.test.js
INV-96 | Every Per-sistant routes/*.js factory destructures only keys present in server.js's `const deps = { pool, config, helpers, views }` — a helper is read off `helpers`, never expected as its own dep (calendar.js read `advanceRecurrence` off deps, got undefined, and 500'd) | Subsystem: Per-sistant Backend | Verify: apps/per-sistant/tests/batch15-followons.test.js (FO-1 guard) + tests/contract (persistentApp builds routers with the real deps)
INV-103 | No GitHub Actions workflow prints an HTTP response body (the repo's logs are public while it is): steps print only allowlisted counts via the job's SUMMARY_JS snippet (numbers/booleans, array counts, ":str" strings), never the net-worth breakdown or merchant/account names; csv-import refuses to run while the repo is public. Likewise Per-sistant's outbound webhooks and Slack never carry a linked task's title, description or snapshot (Perfin's amounts, payees, merchants) — only a kind label, dates and state (helpers.linkedTaskWebhookData, cycle-8 F19) | Subsystem: Platform, Shell & Auth / Per-sistant Backend | Verify: tests/scan-oct-batch1.test.js (F2 block) + apps/per-sistant/tests/broad-scan-c8-batch5.test.js
INV-105 | Every scheduled job in teller/startup.js that ran its body records its outcome via jobHealth.result({ok, error}) (job_runs.last_status / last_error); GET /api/data-health flushes in-memory ticks + outcomes before reading and raises a failed job as an issue; every ticked job is in JOB_INTERVALS_MS | Subsystem: Platform, Shell & Auth | Verify: tests/scan-oct-batch3.test.js (F8 block)
INV-107 | A Plaid link (exchange-transactions / hosted-link-complete / the investments-only exchange — G3) that duplicates a connected Item is refused before anything is stored: the new Item is released at Plaid and the route answers 409 — a second Item never doubles transactions or holdings | Subsystem: Bank Sync & Ingestion | Verify: tests/contract/bank-durability.contract.test.js (F18) + tests/contract/plaid-update.contract.test.js
INV-108 | The CSV workflow deletes only files the CLI imported (CSV_IMPORTED_LIST); the CLI exits non-zero on any failed file | Subsystem: Bank Sync & Ingestion | Verify: tests/scan-oct-batch4.test.js (F19 block)
INV-109 | NOT_TRANSFER matches bank/processor BRAND words on the cleaned merchant only (payment/transfer phrases may read the raw description), and excludes a row categorized Transfer or Investment (user category, or the provider category for a non-Plaid row) | Subsystem: Financial Analytics | Verify: tests/contract/money-classification.contract.test.js (F32/F51) + SX3
INV-110 | Income aggregates count a deposit at its account's share (INCOME_AMOUNT = −SPLIT_AMOUNT); the cash-flow forecast and bill calendar project the same live income streams (getLiveIncomeStreams) | Subsystem: Financial Analytics | Verify: tests/contract/money-classification.contract.test.js (F37/F34)
INV-111 | A transaction the user deleted is never re-inserted by a provider sync, reconcile or CSV import (route or CLI — T2.5 U1): the Teller and Plaid upserts and the CSV inserts skip ids in deleted_transactions (written, with the row's snapshot, in the same transaction as the DELETE); only POST /api/deleted-transactions/:id/restore brings one back | Subsystem: Bank Sync & Ingestion | Verify: tests/contract/delete-feeds.contract.test.js (F20) + tests/scan-oct-batch6.test.js + tests/roadmap-t2-5-u1.test.js + tests/contract/undelete-t2-5.contract.test.js
INV-112 | Categorization rules apply most-specific first (RULE_ORDER_SQL, never by times_applied); saving a rule deactivates the merchant's active rules for other categories; a blank or <3-character contains/starts_with pattern is never stored or applied; the AI write only fills a still-uncategorized row; a row the AI left unanswered is not re-sent for 30 days (ai_skipped_at) | Subsystem: Detection & Categorization | Verify: tests/contract/categorize-rules.contract.test.js + tests/scan-oct-batch7.test.js
INV-113 | The tier-1 audit judges a dollar claim by its own sentence/clause (claimPeriodWindow) and never compares a claim about another named month (claimNamesOtherMonth — this month's name in another year included, cycle-8 F42) or another period (year / week / quarter too) with this month's actuals; tier-2 captures bounded Capitalized names, split on and/or/vs | Subsystem: AI Insights & Audit | Verify: tests/scan-oct-batch8.test.js + tests/broad-scan-c8-batch6.test.js + tests/contract/ai-trust.contract.test.js + tests/contract/c8-batch6
INV-114 | The Sheets export places manual bills and recurring transfers with the app's own cadence rules (cadence.manualBillOccurrences / seriesOccurrences, APP_TIMEZONE today) — never a SQL re-derivation (LEAST(due_day, 28), last + cadence_days); Sheets runs are single-flight (singleFlight: same kind shares, different kind waits) | Subsystem: Sheets & External Export | Verify: tests/contract/sheets-crossapp.contract.test.js + tests/scan-oct-batch9.test.js (F78)
INV-115 | An in-process digest/insight email is reported sent only when it was queued to a valid address; a draft-only delivery returns sent:false with stored:"draft" and a reason, and the digest ticks settle for the day on it while recording a failed job | Subsystem: Settings, Notifications & Cross-app | Verify: tests/contract/sheets-crossapp.contract.test.js (F79) + tests/scan-oct-batch9.test.js
INV-117 | Every Per-sistant page write reports its outcome: it goes through writeOk(await tryFetch(...)) (views/js.js — a non-2xx or network failure toasts the server's error and returns false) — a few older pages (notes, health, jobs, today, the dashboard script) check r.ok / d.error and alert instead, which reports HTTP failures but not a rejected fetch (seams audit #3 — follow-on to move them onto writeOk) — a modal stays open on a failed save, and Undo is offered only after a write succeeded; DATE columns are rendered via parseCalDate / fmtCalDate (never `new Date('YYYY-MM-DD')`, which is a day early west of UTC) | Subsystem: Per-sistant Web UI | Verify: apps/per-sistant/tests/scan-oct-batch11.test.js (F109 / F113 blocks)
INV-118 | Per-sistant attachments live in Postgres (attachments.data BYTEA, ≤10MB — a disk file on Render's ephemeral filesystem vanished on every deploy); list/upload responses never carry the bytes (META_COLUMNS); the download route is declared before the generic /:entityType/:entityId; purging an entity from the trash (by hand or the 30-day purgeTrash cron) removes its attachments, entity_links and Knowledge chunks | Subsystem: Per-sistant Backend | Verify: tests/contract/persistent-batch11.contract.test.js (F121 / F122)
INV-119 | Every webhook event Per-sistant offers (VALID_WEBHOOK_EVENTS) is fired by the code that causes it — todo_created / todo_completed from every create/complete path (announceTodoEvent), email_sent from the manual and cron sends, note_created, reminder_due (processDueReminders, claimed once via reminder_fired_at) and streak_milestone (once per day) — and Slack receives each through fireWebhooks | Subsystem: Per-sistant Backend | Verify: apps/per-sistant/tests/scan-oct-batch11.test.js (F116 block) + tests/contract/persistent-batch11.contract.test.js
INV-116 | The dashboard widget keys have ONE source, DASHBOARD_WIDGETS in perfin-shared.js: Settings renders its toggles from it and the dashboard hides through applyDashboardWidgets — every selector exists on the dashboard and every key the settings route defaults is in the list | Subsystem: Web UI | Verify: tests/scan-oct-batch10.test.js (F96)
INV-106 | No server-side file gains a bare catch (`catch {}`, `.catch(() => {})`, `.catch(() => null)`) beyond its KNOWN_GAPS count; the list only shrinks (a stale count fails too) | Subsystem: Test Coverage Quality / Silent Degradation | Verify: tests/scan-oct-batch3.test.js (empty-catch scan)
INV-104 | Every secret comparison (shell PIN, CALENDAR_FEED_TOKEN, API_KEY, standalone SESSION_PIN/PASSWORD, standalone Perfin's x-api-key, Per-sistant's standalone /api/login — the last two since seams audit #3) is a fixed-length SHA-256 digest compare (auth.safeEqual / isValidApiKey) — never timingSafeEqual over raw buffers whose byte lengths can differ — and the shell logs unhandled rejections instead of exiting | Subsystem: Platform, Shell & Auth | Verify: tests/scan-oct-batch1.test.js (F1 / F6 blocks) + tests/seams-audit-3.test.js + apps/per-sistant/tests/seams-audit-3.test.js
INV-97 | No Per-sistant client template-literal module (a pages/ or views/ file that exports a string) contains a single-escaped regex class or delimiter (\b \d \s \w \/ \. …) — the template consumes the backslash, so the regex silently changes meaning in the browser; double-escape or use string methods | Subsystem: Per-sistant Web UI | Verify: apps/per-sistant/tests/batch15-followons.test.js (FO-2 guard)
INV-120 | Shell sessions are revocable server-side: the cookie carries user_settings.shell_session_epoch and is refused once the epoch moves; POST /logout?everywhere=1 needs a valid session and bumps it; a legacy epoch-less cookie counts as epoch 0 | Subsystem: Platform, Shell & Auth | Verify: tests/contract/platform-batch13.contract.test.js (F12)
INV-121 | Drift guards only shrink: the timezone lint (no new UTC today/month anchor in server code) and the canonical-helper scan (net worth via getNetWorth, budget_snapshots / income streams / AI spend / effective limit derived in one place) keep per-file KNOWN_GAPS that fail on growth AND on a stale entry; the Sheets Budget Status equals getBudgetStatus on real Postgres | Subsystem: Test Coverage Quality / Parallel Source-of-Truth Drift | Verify: tests/scan-oct-batch13.test.js + tests/contract/budget-parity.contract.test.js
INV-122 | Every spending aggregation nets refunds through the shared spend_lines (spendLinesCTE: charges + split lines + REFUND_PREDICATE lines) floored per (month, category) at $0 (NET_CATEGORY_MONTHS) — no route re-derives refunds, the Sheets mirror is SX3-pinned, and cash flow / anomaly / tax stay charge-level (cycle-7 F35) | Subsystem: Financial Analytics | Verify: tests/scan-oct-batch14.test.js + tests/contract/refunds.contract.test.js + tests/contract/budget-parity.contract.test.js
INV-123 | The subscription watchdog alerts at most once per post-cancel charge (still_charging_txn) and once per new price (price_alerted_amount), only for a charge more than 7 days after cancelled_at at ±25% of the amount, a rise of ≥5% or ≥$1, or (cycle-8 F47) a non-utility charge 10–50% above the stored price; the detection upsert keeps prior_amount / amount_changed until a later charge (F46); it marks a row only after its notification was logged | Subsystem: Detection & Categorization / Notification Correctness | Verify: tests/contract/watchdog-rename.contract.test.js + tests/scan-oct-batch15.test.js + tests/contract/c8-batch3
INV-124 | A merchant rename rule matches the RAW merchant (never the user override), fills only a NULL user_merchant_name and tags it with user_merchant_rule_id — a hand rename always wins and clears the tag; deleting a rule — or turning it off — reverts exactly its rows; renaming a rule moves exactly its rows and re-keys detection keeping the rows' user state; a new rule takes the rows another rule renamed that it also matches (most specific wins) and re-keys only the keys it fully vacated (cycle-8 F41); a reconcile and a restore apply the rules, a restore with the rule's current state (F43 / F5) | Subsystem: Detection & Categorization | Verify: tests/contract/watchdog-rename.contract.test.js + tests/contract/quickwins.contract.test.js + tests/scan-oct-batch15.test.js + tests/contract/c8-batch3
INV-129 | Per-sistant client code disables a button for a pending action only through withPending(btn, key, fn, busyText) (views/js.js — guardPending single-flight + disabled + aria-busy, each button's prior state restored in a finally); no page re-enables a button or sets aria-busy by hand (shrinking KNOWN_GAPS guard); the e2e click sweep never presses a data-e2e-skip control, so every destructive, off-app or device-permission control carries it | Subsystem: Per-sistant Web UI / Test Coverage Quality | Verify: apps/per-sistant/tests/scan-oct-batch20.test.js + e2e/pages.spec.js
INV-128 | Plaid re-authentication and new accounts at a connected login go through Link UPDATE MODE on the same Item: link-token-update sends the item's own access_token (perfin_try_decrypt) with no products; update-complete never exchanges a token, registers new accounts BEFORE the cursor walk, clears last_error_code and syncs only that Item under withPlaidTxnLock (investments: syncAllPlaidHoldings({ itemId })); only a token that won't decrypt is sent to unlink + link | Subsystem: Bank Sync & Ingestion | Verify: tests/scan-oct-batch19.test.js + tests/contract/plaid-update.contract.test.js
INV-127 | A background sync (POST /api/sync, /api/sync-balances, /api/sync/reconcile with background:true) answers 202 with a job id at once and runs the SAME body as the synchronous call (records last_sync_result / freshness identically); for sync / sync-balances a POST during a run of that kind joins it (sharedRun) and a second background start is a 409 carrying the running id; a reconcile runs one at a time — either route answers 409 while any reconcile runs (background, synchronous or the weekly heal, which skips) and only a background run writes the slot (seams audit #3); the status's error is a fixed sentence, never an exception message (the reconcile slot included); the backstop workflows poll by id and fail on an error, a lost run or the deadline without printing the error text | Subsystem: Bank Sync & Ingestion / Platform, Shell & Auth | Verify: tests/scan-oct-batch18.test.js + tests/contract/async-sync.contract.test.js
INV-126 | Operator checks are fail-soft and read-only: the go-live checks (cycle-8 E4a — goLiveChecks, the cert expiry, backupCheck) read the environment and the databases only — never the network, never a secret's value or more of its length than "shorter than N" — and each is fail-soft (a failed read omits it); the GitHub client only GETs, with GITHUB_OPS_TOKEN read from the environment per call — never stored, logged or returned (errors carry only the HTTP status) — and never requests a secret's value; any failure is an "unknown" check with a reason, never a throw into data-health; data-health reads cached GitHub results only; the notification fires once per change in the failing set | Subsystem: Platform, Shell & Auth | Verify: tests/scan-oct-batch17.test.js + tests/contract/operator-checks.contract.test.js + tests/cycle8-e4a.test.js + tests/contract/operator-freshness-e4a
INV-125 | A generic CSV's sign is applied identically by preview, import and CLI: positive_means goes through parseCsvUpload's one parseOpts (default 'charges' — the old reading, so earlier imports keep their dedup IDs); an unknown value is a 400; known bank formats ignore it | Subsystem: Bank Sync & Ingestion | Verify: tests/scan-oct-batch16.test.js + tests/contract/batch16-perfin.contract.test.js (F26)
INV-130 | The e2e page run is SEEDED through the apps' own routes (the one direct insert is a Job Radar listing) and fails a page on an uncaught page error, a browser console.error or a non-501 5xx; its click sweep never presses a data-e2e-skip or destructively-labelled control | Subsystem: Test Coverage Quality | Verify: e2e/pages.spec.js + e2e/seed.js
INV-131 | A Plaid item's re-authentication notification is sent once per transition into a re-auth code (last_error_code NULL → set, setPlaidItemErrorCode's prev CTE), never on every failing sync | Subsystem: Bank Sync & Ingestion / Notification Correctness | Verify: tests/scan-oct-batch19.test.js
INV-132 | Every Plaid investment write path (the holdings sync and both exchange routes) stores investment_accounts.mask, keeping a known mask (COALESCE), so the investments-only duplicate guard can match | Subsystem: Bank Sync & Ingestion | Verify: tests/scan-oct-batch19.test.js + tests/contract/plaid-update.contract.test.js
INV-133 | Recording an error never throws into the caller and never recurses: the shell's console.error wrapper always prints first, capture() is re-entrancy guarded, the error log reports its own failures through the ORIGINAL console.error under an ignored "[error-log]" prefix, and a failed write re-buffers instead of dropping; new / reopened errors notify at most 5 times in 24 hours | Subsystem: Platform, Shell & Auth | Verify: tests/roadmap-t1-errors-uptime.test.js + tests/contract/error-log.contract.test.js
INV-134 | GET /health/deep is public but exposes only yes/no database fields (never an error message), is bounded per probe and cached 60s single-flight; the heartbeat never touches the database and is never activity-gated | Subsystem: Platform, Shell & Auth | Verify: tests/roadmap-t1-errors-uptime.test.js + tests/contract/error-log.contract.test.js
INV-135 | A Per-sistant email is sent with EVERY one of its stored attachments or not at all: both senders load them through routes/attachments.loadEmailAttachments; a missing file or a total over 20MB makes Send Now a 400 before its claim (the email stays unsent) and makes the scheduler mark the claimed row failed with the reason; Retry reuses the Send Now claim, so it can't double-send | Subsystem: Per-sistant Backend | Verify: apps/per-sistant/tests/roadmap-t1-batchc.test.js + tests/contract/persistent-batchc.contract.test.js
INV-137 | A bank webhook is verified before anything is recorded (Plaid's ES256 JWT incl. the body hash; Teller's HMAC with digest compares), recorded once per (provider, dedupe key) — a re-delivery is answered 200 and not processed again — answered 200 before its handler runs, and its body is never stored or logged; a provider without credentials / a secret answers 503 and writes nothing; only the two exact POST paths pass the shell gate | Subsystem: Bank Sync & Ingestion / Platform, Shell & Auth | Verify: tests/roadmap-t2-webhooks-w1.test.js + tests/roadmap-t2-webhooks-w2.test.js + tests/contract/webhooks-w1 / webhooks-w2 + tests/broad-scan-c8-batch4.test.js
INV-141 | Bank webhooks are visible without ever exposing a payload: GET /api/data-health reports per provider the last event + status and the last 24 hours' count and failures from webhook_events (no body is read), raises a failed event in 24h as an issue, and lists each connection's own last_synced_at; the operator checks warn while a GOOD Plaid connection isn't registered under the current PUBLIC_URL (webhook_url prefix + /api/webhooks/plaid) and only inform about webhooks off or quiet; every part is fail-soft | Subsystem: Bank Sync & Ingestion / Platform, Shell & Auth | Verify: tests/roadmap-t2-webhooks-w6.test.js + tests/contract/webhooks-w6.contract.test.js
INV-140 | A Teller webhook is a trigger, not data: transactions.processed syncs only the enrollment(s) it names (by enrollment id or its transactions' account ids — never a SUSPENDED one) through the same syncOneTellerEnrollment the scheduled sync loops, coalesced per enrollment, recording nothing global (the enrollment's last_synced_at only), then ONE runPostSyncSteps; enrollment.disconnected changes only a GOOD enrollment and notifies once per transition | Subsystem: Bank Sync & Ingestion | Verify: tests/roadmap-t2-webhooks-w5.test.js + tests/contract/webhooks-w5.contract.test.js
INV-139 | Plaid webhooks are opt-in by PUBLIC_URL alone (hosting.webhookBaseUrl — never RENDER_EXTERNAL_URL): without it no link token carries a webhook and registration is a 400; a clean sync never clears a webhook's advance warning (PENDING_EXPIRATION / PENDING_DISCONNECT — setPlaidItemErrorCode keepWarnings), only a re-authentication does; an ITEM ERROR sets the signal only for a re-auth code | Subsystem: Bank Sync & Ingestion | Verify: tests/roadmap-t2-webhooks-w4.test.js + tests/contract/webhooks-w4.contract.test.js
INV-138 | A Plaid webhook is a trigger, not data: SYNC_UPDATES_AVAILABLE syncs only the named GOOD item, through the same syncOnePlaidItem the scheduled sync loops, under withPlaidTxnLock and coalesced per item (a request during its run → one more round, never a parallel walk); it records nothing global (no last_txn_sync_at / last_sync_result — the item's last_synced_at only, stamped when the walk reached the end of the cursor) | Subsystem: Bank Sync & Ingestion | Verify: tests/roadmap-t2-webhooks-w3.test.js + tests/contract/webhooks-w3.contract.test.js
INV-142 | Cash and payday alerts are away channels driven by the shared forecast (projectCashFlow / getCashFlowForecast — the same numbers as /api/cash-flow) and never fire on stale data: no projected-low or account-floor alert on a balance older than 36 h, no missed-payday alert without an error-free sync of that connection after the grace window; each is deduped (projected low: cash_alert_state; account floor: 24 h per account via sentRecently; payday: per expected date / per deposit — the landed check's tag looked up in notification_log across its 24 h overlap, cycle-8 F51, on an id watermark since E2c) and advances its state only when the notification was logged; reconcile never triggers a landed-paycheck alert | Subsystem: Financial Analytics / Notification Correctness | Verify: tests/roadmap-t2-2-cash-l2.test.js + tests/roadmap-t2-2-cash-l3.test.js + tests/roadmap-t2-2-cash-l4.test.js + tests/contract/cash-alerts-l2 / payday-l3 / cash-floors-l4 + tests/contract/c8-batch4 + tests/contract/txn-watermark-e2c
INV-143 | Every Per-sistant model call goes through ai.js's capped wrappers (cappedAI / cappedCitations): the monthly ai_usage spend (APP_TIMEZONE month; a read error refuses the call) is checked against getAiBudgetCents() (user_settings.ai_monthly_budget_cents → PERSISTENT_AI_BUDGET_CENTS → $1.00, read from the same pool) before the call, and a usage row is charged once in a `finally` whenever tokens came back (a refusal included — and a routes/ai.js feature then answers 422 { ai_refusal }, never an empty 200, cycle-8 F24); no routes/*.js file calls callAI / answerWithCitations directly; cache hits make no call and cost nothing; over the cap the action routes 429, Ask / Smart Suggestions keep their 200 shapes with ai_cap, Knowledge answers degrade to sources-only and capture falls back to the raw note — and the pages show that message; GET /api/ai/usage reports the same spend the cap reads; the two apps' caps are separate and each only DISPLAYS the other's spend | Subsystem: Per-sistant Backend / Knowledge / RAG | Verify: apps/per-sistant/tests/roadmap-t2-3-cap-c1 / c2 / c3 / c4 + the c2 source guard + tests/contract/persistent-ai-cap + ai-usage-c4 + apps/per-sistant/tests/broad-scan-c8-batch6 (F24)
INV-144 | The unified search has ONE renderer — renderSearchResults (views/js.js) draws the dashboard widget and the /search page; a Perfin row (group 'finance') becomes a link only through linkedAppHref (a same-app path under Perfin's http(s) or root-relative base — never a javascript: / protocol-relative url), never carries an inline action, and a row of an unknown type is dropped; the finance rows come only from GET /api/search's read-only perfinPool queries (routes/finance-search.js — the escaped pattern, the user's share via Perfin's imported SPLIT_AMOUNT, each query fail-soft) and are absent standalone | Subsystem: Per-sistant Web UI / Settings, Notifications & Cross-app (seam) | Verify: apps/per-sistant/tests/roadmap-t2-4-x3a + x3b + tests/contract/finance-search + e2e/pages.spec.js
INV-145 | Deleting a transaction is reversible and nothing brings it back unasked: the tombstone and the row's snapshot (with its splits) are written in the delete's own transaction; no provider sync, reconcile or CSV import (route or CLI) inserts a tombstoned id; restore removes the tombstone and reinserts the snapshot in one transaction — never a duplicate (ON CONFLICT DO NOTHING), and nothing changes when the account is gone or (Plaid) the bank removed the row since (cycle-8 F6); CSV-overlap Resolve tombstones what it deletes (F4), all under one batch_id, and a batch restore runs each row through the same restore in one transaction — a refused row stays deleted (cycle-8 E1c); Plaid update mode — in-page or hosted — clears an item's re-auth flag only after Link reports the session finished (in-page: onSuccess; hosted: a link_sessions entry finished without an exit, read through linkTokenGet before anything is written) | Subsystem: Bank Sync & Ingestion | Verify: tests/roadmap-t2-5-u1.test.js + tests/roadmap-t2-5-u2.test.js + tests/roadmap-t2-5-h1.test.js + tests/contract/undelete-t2-5 + plaid-update + tests/contract/c8-batch3 + tests/cycle8-e1c.test.js + tests/contract/resolve-undo-e1c
INV-146 | The year-end tax package is computed on request from the ledger and never stored, and nothing in it is sent to an AI model: each figure has one definition shared with the screen or export that already shows it — deductions = getTaxDeductionReport (also behind /api/export/tax-report, whose CSV is taxReportCsv), income = getIncomeForYear on INCOME_PREDICATE / INCOME_AMOUNT, rent paid = getHousingPayments (also behind the landlord export, housingPaymentsCsv), investments = investment_transactions through getInvestmentTaxData; realized gains are FIFO over stored lots and labelled approximate — a sale not fully covered by known-cost lots has a NULL basis and gain, never 0; tax-advantaged accounts are kept out of gains and investment income; a suggested document the user received or dismissed is never changed or re-suggested (ON CONFLICT DO NOTHING); every section is fail-soft with a fixed sentence; every CSV text cell is formula-guarded; the Tax page's writes go through writeOk | Subsystem: Financial Analytics / Sheets & External Export / Web UI | Verify: tests/roadmap-t3-3-k1 / k2 / k3 / k4 + tests/contract/tax-investments / tax-documents / tax-package + e2e/pages.spec.js
INV-147 | The dashboard summary has one definition per figure, each the helper its own screen uses — net worth = the latest net_worth_snapshots row (written only through getNetWorth); spending = getBudgetStatus (GET /api/budgets); lowest cash = getCashFlowForecast (GET /api/cash-flow); bills due = getBillsDue (the /api/forecast charges via forecastCharges + the bill calendar's manualBillOccurrences, less bill_payments); rent owed = getHousingOwed (the ledger's ledgerTotals, payee-scoped); uncategorized = countUncategorized (/api/categorize/status); Sync Health = gatherDataHealth (/api/data-health) — no figure is re-derived in routes/dashboard-summary.js; every part is fail-soft with a fixed sentence and the page still loads when the whole request fails; attention links are same-app paths joined with withBase; the shell landing page's Perfin line reads the same gatherDashboardSummary in-process (its parts option — rent / bills / uncategorized only), never an HTTP self-fetch | Subsystem: Financial Analytics / Web UI | Verify: tests/design-d3.test.js + tests/design-d7.test.js + tests/contract/dashboard-summary.contract.test.js + e2e/pages.spec.js
INV-148 | Shared design values have one spec, design/tokens.json (status colours per theme, type scale, spacing, radius, button heights): both apps declare every shared value with the spec's value under their own names (Perfin perfin-shared.css, Per-sistant views/css.js), app-specific values (accent, surfaces, fonts) are never compared, and the parity test fails on drift. Every Perfin amount goes through fmt (a negative is -$X, never $-X) and colour carries meaning: money in green (.amt-in), red (.amt-bad) only for something wrong (overdue, over budget, below $0, a debt that rose), a charge or a debt the default text colour, gold the brand accent only. Buttons are sentence case in both apps, .primary filled; an empty state offers its next step through the app's emptyState (a same-app path or the page's existing button — no new write path) | Subsystem: Web UI / Per-sistant Web UI | Verify: tests/design-tokens.test.js + tests/design-d1.test.js + tests/design-d2.test.js + apps/per-sistant/tests/design-d6.test.js
INV-149 | A linked task follows its source without ever overriding the user: one sync at a time (a transaction under pg_advisory_xact_lock(727274010), creations announced only after COMMIT); a key deleted for good is never inserted again (linked_task_tombstones, db/031's BEFORE DELETE trigger on every delete path); a task is closed only when its source says the item is resolved — a still-open item past the creation window is retained, not closed; an auto-close is not a completion (no todo_completed event, and analytics / the weekly review / Ask / stats leave it out); a task completed, reopened, edited or trashed by hand is never touched (source_detached, per-field snapshot) | Subsystem: Per-sistant Backend / Settings, Notifications & Cross-app (seam) | Verify: apps/per-sistant/tests/roadmap-t2-4-x1a + x1b + broad-scan-c8-batch5 + tests/broad-scan-c8-batch5 + tests/contract/linked-tasks / linked-tasks-crossapp / c8-batch5
INV-136 | WebAuthn credential ids are stored exactly as the authenticator reports them (registrationInfo.credential.id — already base64url in @simplewebauthn v11), never re-encoded; a double-encoded row from before seams audit #3 is rewritten (or, when its real id already exists, removed) by repairCredentialIds in the migration | Subsystem: Platform, Shell & Auth | Verify: tests/seams-audit-3.test.js + tests/contract/seams3.contract.test.js
INV-150 | The cash plan's figures come from code, never the model: services/advice.js buildAdvicePlan computes every amount (the emergency-fund tracker and goal catch-up amounts — T4.1 A5 — the raise / bonus / spending-creep figures — A6 — and idle cash and rebalancing — A7, the drift read through services/allocation.js like the Investments card — and the statement-date tip and loan extra payments — A8, through computeLoanPayoff — and the sinking funds and subscription review — A9, the dates from cadence.js — and the contribution room — A10, from contributions recorded in investment_flows against limits the user entered — included), and GET /api/advice, the dashboard card, Ask's get_cash_plan and the cash_plan insight module only show or word that one plan; the insight prompt carries it verbatim (cashPlanPromptBlock), the audit checks the model's per-paycheck / named-debt monthly figures against the same plan object (planClaimFinding — a hypothetical isn't a plan claim), and the plan's step reaches long-term memory only as ONE "Plan (<step>)" pending action written after the summary was sanitized (seedPlanActions — bounds kept, a preserved summary untouched); every view carries the disclaimer and no security or fund is named; the plan-change push (services/advice-alerts.js) words a change between two plans (or a new raise / bonus, once each) from those same figures, at most once a local day, push only, and advances its state only when the push was logged ; a what-if in Ask (A10) is whatIfPlan — buildAdvicePlan on inputs changed by applyWhatIf, never the model's arithmetic | Subsystem: Financial Analytics / AI Insights & Audit | Verify: tests/roadmap-t4-1-a1 / a2 / a3 / a4 / a5 / a6 / a7 / a8 / a9 / a10 + tests/contract/advice-a1
INV-151 | The cash-flow forecast's bill schedule has one decision per recurring item, transferTreatment / classifyBills (services/cash-flow.js): the user's forecast_treatment / forecast_ignore beats the card-autopay and internal-move heuristics, every left-out item carries its reason in forecast_items, and nothing but the two PATCH …/forecast routes sets those columns (never the detectors; a rename re-key only copies the user's own setting from the row it retires onto the surviving row still on the default — E1 follow-on) — so every forecast reader (GET /api/cash-flow, the dashboard summary, the cash alerts, the advice plan) follows the same correction | Subsystem: Financial Analytics | Verify: tests/cycle8-e1a.test.js + tests/cycle8-e1b.test.js + tests/cycle8-e1-followons.test.js + tests/contract/forecast-e1a + e1-followons
INV-152 | A "what's new since the last check" read over transactions never skips a row that commits late and never announces one twice: it reads the mark (MAX(id) + now(), services/txn-watermark.readMark) BEFORE its candidates and stops at that id, rescans rows at or below the stored id created within 24 h of the previous check (an id is taken at INSERT, so an open transaction commits a lower id later), drops an overlap row already in notification_log (the anomaly charge by data.transaction_id, the paycheck by its payday-<hash> tag) and moves its watermark forward only (GREATEST) — held back when an announcement wasn't logged; no pg_stat_activity read ; the dashboard's "Since you last looked" follows the mark-before-read and forward-only rules without the overlap — /seen stores the mark its GET read (seen_token, cycle-8 E2d), never now() | Subsystem: Bank Sync & Ingestion / Notification Correctness | Verify: tests/cycle8-e2c.test.js + tests/cycle8-e2d.test.js + tests/contract/txn-watermark-e2c + whats-new-e2d + c8-batch4
INV-153 | Quiet hours and mutes act on the interruption, never the record: every sendToAll writes its notification_log row as before and returns the same `logged` (so every caller's dedup / watermark is unchanged), with push_state saying what happened to the push; a held push is released once quiet hours end — marked sent only after the push went out, one summary for several, expired (left in the bell) after 12 hours — and a muted kind is never pushed or emailed; security and the test notification are never held or muted; a failed settings read holds and mutes nothing; Per-sistant's notification check reads the same settings read-only through perfinPool and keeps every entry, marking it notify:false rather than dropping it (cycle-8 E3c); a push about an item with an OPEN Per-sistant linked task is covered — the row still written (read, with item_key), `logged` unchanged, not pushed — and the lookup is fail-soft to a push (cycle-8 E3d); Per-sistant's check marks notify:false an item Perfin pushed (push_state sent) in the last 12 hours, still listed, and housing_due steps aside only for its own month's open task (cycle-8 E3e) | Subsystem: Settings, Notifications & Cross-app / Notification Correctness | Verify: tests/cycle8-e3b.test.js + tests/cycle8-e3c.test.js + tests/cycle8-e3d.test.js + apps/per-sistant/tests/cycle8-e3c.test.js + tests/contract/notify-e3b.contract.test.js + tests/contract/notify-e3d.contract.test.js + apps/per-sistant/tests/cycle8-e3e.test.js + tests/contract/notify-e3e.contract.test.js
INV-74 | Per-sistant recurring todos keep their chain's anchor day (recurrence_anchor_day; monthly/yearly step on the month index with the day clamped — Jan 31 → Feb 28 → Mar 31); the midnight roll (rollMissedRecurring, APP_TIMEZONE cron) marks a missed instance missed=true with completed_at NULL — never counted as done by analytics or /api/stats | Subsystem: Per-sistant Backend | Verify: apps/per-sistant/tests/scan-sept-batch6.test.js (PD-2 / PB-10 blocks)

### Policy Configuration
Policy threshold: 5/10
Consecutive cycles: 2

### Seams Audit Cadence
every 3 subsystem cycles

### Regression Scenarios
S1 | Re-sync is idempotent | Subsystem: Bank Sync & Ingestion
  Steps:
    - Run a Teller + Plaid sync, note transactions_added
    - Run the same sync again with no new bank activity
  Expected: second run reports 0 added; no duplicate rows; watermark/cursor unchanged on the no-op
S2 | Shared-card settlement math | Subsystem: Financial Analytics
  Steps:
    - Mark an account is_shared at 50%; set one charge personal_for='self', one 'partner'
    - Open the Settlement widget for that month
  Expected: your_share = 50%×shared_total + self_total; partner mirror; reimbursed rows excluded
S3 | AI budget cap enforced | Subsystem: AI Insights & Audit
  Steps:
    - Set INSIGHTS_MONTHLY_BUDGET_CENTS low; trigger insights, then categorize
  Expected: 429 once cap hit; rules still categorize for free; usage rows written for both entry_types
S4 | Embedded auth gate + cross-pool wiring | Subsystem: Platform, Shell & Auth
  Steps:
    - Hit /perfin/api/spending-summary with no shell cookie, then with a valid x-api-key
    - Load the Per-sistant Perfin widget while embedded
  Expected: 401/redirect without creds; 200 with valid key; widget reads Perfin's pool directly (no self-fetch 401)
S5 | Sheets partial-failure isolation | Subsystem: Sheets & External Export
  Steps:
    - Force one tab's query to throw during syncAll
  Expected: other tabs still update; errors[] names the failed tab; run doesn't abort mid-way
S6 | Offline navigation fallback | Subsystem: Web UI
  Steps:
    - Install PWA, go offline, navigate to an uncached route
  Expected: branded /offline.html served; no stale /api/* data shown
SK1 | Vault sync idempotent | Subsystem: Knowledge / RAG
  Steps:
    - Configure the vault; run a sync, then run it again with no repo changes
  Expected: second run reports 0 changed; content-hash skips re-embedding; vault_last_sha unchanged
SK2 | Knowledge privacy | Subsystem: Knowledge / RAG
  Steps:
    - Mark a fact/doc private (embed:false / sensitivity: private|secret); ask a question that would match it
  Expected: it is never embedded and never returned by /query or /search (and never sent to the model)
SK3 | pgvector unavailable | Subsystem: Knowledge / RAG
  Steps:
    - Boot against a Postgres without the `vector` extension available
  Expected: migration still succeeds (no boot crash); the vault sync still ingests documents + facts (embeddings: false); Knowledge serves keyword retrieval
SK4 | Capture write-gating | Subsystem: Knowledge / RAG
  Steps:
    - POST /api/rag/capture with VAULT_GITHUB_WRITE_TOKEN unset, then set
  Expected: 400 with a clear message when unset; a single committed file when set
SK5 | Temporal validity | Subsystem: Knowledge / RAG
  Steps:
    - Create a fact with valid_to in the past; ask about it
  Expected: it is NOT injected into the answer; GET /api/rag/facts?all=1 still lists it

### Frozen Subsystems
- Legacy Plaid Server — plaid/server.js, the LEGACY standalone process only. The active, co-equal Plaid linking path lives in teller/routes/investments.js and is NOT frozen. This file is kept solely for isolated standalone Plaid debugging; unfreeze if the in-app Plaid path is ever extracted to a standalone service.
- n8n Workflows — n8n-workflows/*.json, superseded by in-process scheduled tasks in teller/startup.js. Unfreeze only if scheduling moves back out-of-process.

### Deploy Command
Platform, Shell & Auth: Render auto-deploys on push to `main` (configured in the Render dashboard, not via CLI). Alt: `fly deploy` (Dockerfile-based). Planned (not live): a single VPS — `.github/workflows/deploy-vps.yml` builds the image to GHCR after CI passes on `main` and runs `deploy/vps/deploy.sh` over a forced-command SSH key; inert until the `VPS_DEPLOY_ENABLED` repository variable is `true` (runbook: `deploy/vps/RUNBOOK.md`).
Sheets & External Export: Apps Script side deploys via clasp — `clasp push` from apps-script/, then Apps Script editor → Deploy → New version. (Server-side sheets-sync.js ships with the main Render deploy.)

### Cycle Rotation Plan
Recommended first subsystem: Bank Sync & Ingestion (widest blast radius — every downstream number depends on correct transaction data; most invariants; richest recent bug history).
Recommended order (frozen excluded): Bank Sync & Ingestion → Financial Analytics → Detection & Categorization → AI Insights & Audit → Knowledge / RAG (Per-sistant) → Platform, Shell & Auth → Settings, Notifications & Cross-app → Sheets & External Export → Web UI (Perfin) → Per-sistant Backend → Per-sistant Web UI.
Seams audit frequency: every 3 subsystem cycles (focus: enrollments.js, subscriptions.js, settings.js, financial-queries.js, notifications.js, the Per-sistant integration seam routes/perfin.js + routes/webhooks.js, and the Knowledge↔Perfin seam — rag.js's read-only perfinPool use of getNetWorth (linked_accounts/investment_accounts) + detected_subscriptions).
Confidence: Bank Sync, Analytics, Detection, AI, Platform = High; Integrations, Sheets, Web UI, Per-sistant Backend, Per-sistant Web UI, Knowledge / RAG = Medium (Knowledge: new code, heavily tested, but unexercised against a live vault/Voyage/pgvector).
