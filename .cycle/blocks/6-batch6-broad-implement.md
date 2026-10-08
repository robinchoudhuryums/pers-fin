---BROAD SCAN IMPLEMENTATION SUMMARY---
Findings implemented:
- FAN-7  (M)    The scheduled prior-month budget snapshot was frozen on the first tick of the 1st, so month-end charges that posted on the 1st–3rd never reached spend/rollover
- AIN-6 / SXE-4 / WUI-5 (M) Four budget-status copies disagreed: the AI prompt, Ask, the Sheets Budget Status and the Budgets page used the bare monthly_limit (a rolled-over budget read as overspent; a June one-time budget showed in September)
- FAN-8  (L-M)  Budget suggestions averaged the partial current month into the 3-month history
- FAN-14 (L)    PATCH /api/budgets/:id stored NaN / negative limits and malformed effective_month values
- FAN-13 / SXE-12 / PB-13 / AIN-15 (L-M) Remaining UTC "today"/month anchors: budget alerts, the snapshot + budget-push month keys, weekly-digest day, income-summary window (+ partial-month average), YoY defaults, housing reminder/export/payment dates, credit-score date, Sheets windows/timestamp (hard-wired to New York)/archive month/tax year, the ICS "today" (and overdue rent vanished from the feed), Per-sistant's notification check + briefing date; the daily digest crept 3–4h earlier every day and overlapped the previous send
- WUI-2  (M-H)  Calendar dates rendered one day early west of UTC; date-input defaults used the UTC date
- FAN-15 / PD-2 (L/M) Month addition overflowed on the 29th–31st (loan payoff / goal / FIRE dates skipped a month; Per-sistant monthly recurrences drifted Jan 31 → Mar 3 → Apr 3 and Feb 29 yearly → Mar 1 forever)
- PD-4 / PB-10 (M) complete-recurring judged "on time" by the UTC date; the midnight roll ran at UTC midnight and marked MISSED recurring instances completed (counted as done)
- KR-5   (M)    Every vault re-sync bumped updated_at on unchanged documents/facts, flushing the answer cache; cached answers ignored a fact's validity boundary passing
- DD-11  (L-M)  YoY compared month-to-date against whole prior months and silently skipped a missing year

Files modified:
- teller/services/financial-queries.js (getBudgetStatus, previousMonthKey)
- teller/routes/budgets.js
- teller/routes/insights.js
- teller/routes/insights-email.js (comment)
- teller/routes/ask.js
- teller/routes/spending-analytics.js
- teller/routes/subscriptions.js
- teller/routes/housing.js
- teller/routes/credit-scores.js
- teller/routes/goals.js
- teller/services/projections.js
- teller/startup.js
- teller/public/perfin-shared.js
- teller/public/transactions.js
- teller/views/budgets.ejs
- teller/views/dashboard.ejs
- teller/views/subscriptions.ejs
- teller/views/calendar.ejs
- scripts/sheets-sync.js
- apps/per-sistant/db/022_recurrence_anchor_missed.sql (NEW)
- apps/per-sistant/helpers.js
- apps/per-sistant/server.js
- apps/per-sistant/routes/todos.js
- apps/per-sistant/routes/calendar.js
- apps/per-sistant/routes/analytics.js
- apps/per-sistant/routes/settings.js
- apps/per-sistant/routes/notifications.js
- apps/per-sistant/routes/ai.js
- apps/per-sistant/routes/rag.js
- apps/per-sistant/services/vault-sync.js
- tests/scan-sept-batch6.test.js (NEW — 41 tests)
- tests/scan-sept-batch6-tz.test.js (NEW — 6 tests, forced APP_TIMEZONE)
- apps/per-sistant/tests/scan-sept-batch6.test.js (NEW — 21 tests)
- apps/per-sistant/tests/cycle-fixes.test.js (test double: the PS-11 roll moved to helpers.rollMissedRecurring)
- apps/per-sistant/tests/knowledge-cache.test.js (test double: corpus version now date-prefixed)
- apps/per-sistant/tests/knowledge-facts.test.js (test double: validity filter is a $N::date parameter, not CURRENT_DATE)

CHANGES:
FAN-7 | budgets.js, startup.js | New writeBudgetSnapshot(db, month, {overwrite}) + runBudgetSnapshot(db, today = todayStr()). Days 1–SNAPSHOT_REFRESH_DAYS (5) of a month: re-take the prior month with DO UPDATE, so late-posting charges land. After that: create-if-missing only (DO NOTHING; the M5 catch-up), mode "exists" when present. Month/day come from APP_TIMEZONE. The startup job calls runBudgetSnapshot(pool). POST /api/budgets/snapshot keeps overwrite semantics.
AIN-6/SXE-4/WUI-5 | financial-queries.js, budgets.js, insights.js, ask.js, budgets.ejs, sheets-sync.js | getBudgetStatus(pool, month = currentMonth()) is the one definition:
  - spending via getCategorySpendingForMonth;
  - effective_limit = monthly_limit + the PRIOR month's snapshot rollover (when rollover_enabled);
  - one-time budgets only in their effective_month;
  - rows are { ...budget, spent, rollover_amount, effective_limit, remaining, percent_used }.
  Callers: GET /api/budgets, /api/budgets/alerts, the insights prompt ("$spent / $effective incl. $R rolled over"), and Ask get_budget_status (adds rollover_amount + effective_limit; remaining/percent are vs the effective limit). The Budgets page shows effective_limit with "($base + $R rolled over)". The Sheets Budget Status query joins the prior month's budget_snapshots and applies the one-time filter. previousMonthKey moved to financial-queries (string math); budgets.js still re-exports it.
FAN-8 | budgets.js | /api/budgets/suggest uses the 3 previous COMPLETE months (previousMonthKey from the tz currentMonth). The prompt says "last 3 complete months".
FAN-14 | budgets.js | PATCH 400s a non-finite or negative monthly_limit, a budget_type outside recurring/one_time, and an effective_month that isn't YYYY-MM (01–12). null or "" still clears effective_month.
FAN-13 | budgets.js, startup.js, spending-analytics.js, housing.js, credit-scores.js, goals.js | Server-side "today"/month now comes from todayStr()/currentMonth():
  - alerts day-of-month/days-in-month;
  - budget-push month + rollover key;
  - weekly-digest weekday;
  - income-summary windows (`$2::date - make_interval(...)` with currentMonth()-01); avg_monthly_income now covers COMPLETED months (falls back to all months when only the current month exists);
  - YoY defaults;
  - housing reminder day, export default year and payment date;
  - credit-score checked_at default;
  - goal estimated_date and FIRE date.
SXE-12 | sheets-sync.js, subscriptions.js | Sheets:
  - SHEETS_TZ = APP_TIMEZONE, with sheetsTodayStr / sheetsMonth(offset) and validated sqlDate / sqlMonth literals;
  - 6-month windows are whole tz months (WINDOW_6MO_START = sheetsMonth(-5)-01) and the this-month window is [month-01, next-month-01);
  - avg daily spend divides by the real window length;
  - the timestamp uses SHEETS_TZ (was America/New_York);
  - tax year, Income 24/12-month windows and the archive "current month" are tz-anchored.
  ICS: today = todayStr(). An unpaid obligation past its due date is placed on today as "(rent/utilities, OVERDUE)" with a stable UID; it used to drop out of the feed.
AIN-15 | insights.js | runDailyDigest(now = new Date()) is wall-clock anchored:
  - "too_early" before 07:00 APP_TIMEZONE;
  - "already_sent_today" when the last send was on the same local date;
  - the window is everything since the previous send (floored at 72h; a first send uses 24h);
  - stamps last_daily_digest_at = now.
  The old 20h gate crept 3–4h earlier per day and overlapped the previous window by ~4h.
PB-13 | apps/per-sistant/routes/notifications.js, routes/ai.js | The notification check and AI daily briefing "today" = todayStr() (APP_TIMEZONE).
WUI-2 | perfin-shared.js, transactions.js, subscriptions.ejs, calendar.ejs, dashboard.ejs | New shared helpers:
  - DATE_ONLY_RE + parseCalDate: 'YYYY-MM-DD' or a UTC-midnight 'YYYY-MM-DDT00:00:00.000Z' becomes a LOCAL-midnight Date for that day; real instants are untouched. fmtDate uses it.
  - localTodayStr(offsetDays) and localDateStr(d).
  Users: the Activity filter defaults and cash-entry date, the Subscriptions overdue check and next-charge label, the calendar "today", and the dashboard investment-flow date.
FAN-15 | projections.js, goals.js, dashboard.ejs | New addMonthsYm / addMonthsYmd (month-index math, day clamped to the target month's length). computeLoanPayoff takes `today` and uses addMonthsYm. Goal estimated_date = addMonthsYmd(todayStr(), n); FIRE date = addMonthsYm(todayStr(), n). The dashboard's inlined loanPayoff label uses Date.UTC(y, m + n, 1).
PD-2 | db/022, helpers.js, todos.js, calendar.js | Migration 022 adds todos.recurrence_anchor_day INT (CHECK 1–31, guarded) and missed BOOLEAN NOT NULL DEFAULT false, idempotently. advanceRecurrence(date, rule, interval, anchorDay): monthly/custom_months/yearly step on the month index, re-apply the chain's anchor day and clamp it (Jan 31 → Feb 28 → Mar 31; Feb 29 yearly → Feb 28 … → Feb 29). recurrenceAnchorDay(todo) returns the stored anchor, else the due day. New instances (complete/skip/roll) carry the anchor; a manual due-date PATCH resets it to NULL; calendar projections pass it.
PD-4 | todos.js | complete-recurring: today = todayStr(), and isOnTime compares against ymdLocal(due_date) (node-pg DATE = local midnight). Next due dates are written with ymdLocal.
PB-10 | helpers.js, server.js, analytics.js, settings.js | rollMissedRecurring(db, today):
  - atomic claim sets completed = true, completed_at = NULL, missed = true, streak 0;
  - the next instance is the first occurrence on/after today, with the anchor carried.
  The server.js cron "0 0 * * *" runs it with { timezone: APP_TIMEZONE || "UTC" } and todayStr(). Analytics completion rate/category breakdown and /api/stats "done" exclude missed rows. The weekly review is already completed_at-ranged.
KR-5 | rag.js, vault-sync.js | Answer cache and vault upserts:
  - corpusVersion(pool, today = todayStr()) → "YYYY-MM-DD|v:n", so a fact crossing valid_from/valid_to invalidates cached answers at the next tz midnight.
  - buildFactsQuery and GET /api/rag/facts filter validity on a $N::date tz parameter instead of CURRENT_DATE.
  - upsertVaultDocument's DO UPDATE only fires when title/content/tags/sensitivity/deleted_at actually differ (IS DISTINCT FROM), falling back to SELECT id.
  - upsertFacts skips the delete + re-insert when the file's fact set is unchanged (order-independent factSetSignature).
  - A reindex no longer bumps updated_at → no spurious cache flush.
DD-11 | spending-analytics.js, dashboard.ejs | YoY of the CURRENT month caps every year at today's day-of-month (EXTRACT(DAY) <= $3). Years are bounded to [$2-2, $2]. Comparisons are emitted only for consecutive years; the response adds through_day (null = whole month). The widget labels "(days 1–N of each)".

TEST RESULTS: passed — 1317/1317 (Perfin 819 + Per-sistant 498; 53 test files).
- Old-code worktree runs (pre-fix source + new tests):
  - Perfin batch6: 36 of 38 fail. The 2 passes are a positive control (valid PATCH) and already_sent_today, which the old 20h gate happens to satisfy.
  - Perfin tz file: 5 of 6 fail (the 6th is the fixture sanity check).
  - Per-sistant batch6: 21 of 21 fail. The pure-helper controls fail only because ymdLocal didn't exist.
- Three Per-sistant test doubles were updated for the new corpus-version / $N::date contract.
- Real Postgres 16:
  - both apps' migrations ran twice (022 idempotent; the anchor CHECK rejects 32);
  - getBudgetStatus: Dining 540 / effective 580 (incl. $80 rollover); the June one-time budget is hidden;
  - runBudgetSnapshot: day 3 refresh rewrote spend 420 → 480 and rollover 80 → 20; day 12 leaves an existing snapshot alone; catch-up writes then reports "exists";
  - income-summary avg 3000 excludes the $300 month-to-date;
  - YoY through_day 8 drops last year's day-28 charge;
  - GET /api/budgets and alerts OK; PATCH "abc" → 400; ICS shows an overdue rent obligation on today;
  - full Sheets syncAll (faked Google client) — every Batch 6–touched tab ran clean;
  - Per-sistant: rollMissedRecurring Jul 31 → next 2026-10-31 (anchor 31, missed=true, completed_at NULL, idempotent); analytics done=0;
  - an unchanged document upsert leaves updated_at alone; a changed one rewrites; a soft-deleted one is restored;
  - an unchanged fact set skips; corpusVersion is stable; the fact valid_to=10-07 is returned for 10-07 and not for 10-08.
- Edited EJS inline scripts + public JS: node --check clean. Playwright e2e 8/8.
- Pre-existing failure found during the Sheets run (NOT caused by this batch — query untouched): the Utilities tab fails with "invalid UNION/INTERSECT/EXCEPT ORDER BY clause". See FOLLOW-ON.
Regression scenarios:
- S5 (Sheets partial-failure isolation): PASS on real PG. The pre-existing Utilities failure was isolated into errors[] and every other tab completed (INV-24).
- SK1 (vault sync idempotent): PASS for the KR-5 surfaces (unchanged doc/fact re-upsert writes nothing; corpus version stable).
- SK5 (temporal validity): PASS (the expired fact is excluded from the date-parameterized query; the corpus version rolls daily so cached answers can't outlive validity).
- NOT APPLICABLE (no sync/settlement/auth/SW/privacy/vector/capture change): S1, S2, S3, S4, S6, SK2, SK3, SK4.

REGRESSION RISKS:
- FAN-7: on days 1–5 the scheduled job re-snapshots the prior month using the CURRENT monthly_limit, so a limit edited on the 2nd also changes last month's recorded limit/rollover (previously frozen on the 1st).
- AIN-6: Ask get_budget_status `remaining` / `percent_used` are now against the effective limit (base + rollover), not the bare limit — numbers shift for rollover budgets (intended: they now match the Budgets page).
- AIN-15: the daily digest no longer sends before 07:00 APP_TIMEZONE. If the process is only awake before then (free-tier sleep, keep-alive off), that day's digest is skipped and the next one covers up to 72h.
- KR-5: the corpus version now changes at every APP_TIMEZONE midnight, so the answer cache is invalidated once a day (the 24h TTL bounded it anyway). The format change invalidates all existing cached answers once on deploy.
- PB-10: missed instances stay completed = true, so they leave the active list as before. The todo list UI shows them like a completed task (no "missed" badge yet). Rows rolled before deploy stay counted as done.
- WUI-2: parseCalDate treats any exact UTC-midnight timestamp as a calendar date; a genuine instant at 00:00:00.000Z would render as that calendar day rather than shifted.
- DD-11: a past-month comparison is still the whole month; only the current month is capped. 3+-year-old data is no longer fetched (window bounded to year−2..year).

INVARIANTS AT RISK: None violated.
- INV-48: getBudgetStatus delegates to getCategorySpendingForMonth; no SPLIT_AMOUNT/NOT_TRANSFER re-inline. The Sheets Budget Status edit stays on the SX3-pinned cat_lines path.
- INV-18/19: runBudgetSnapshot/SNAPSHOT_REFRESH_DAYS attached after module.exports = router; startup calls the helper in-process.
- INV-17 / PS-1: migration 022 is additive + guarded; ran twice clean.
- INV-27: the facts query keeps sensitivity='normal'.
- INV-32: still keyed on query+model+corpus_version — the version string just gains a date prefix (semantic layer unchanged).
- INV-36: the vault-sync lock is untouched.
- INV-51: habit streaks untouched; todo streaks are a separate stored counter.
- INV-14: the digest makes no AI call. The Ask tool is read-only.
NET SCORE: 12 − 2 = 10
  Production (would have fired this month), scored per finding ID:
  - YES: FAN-7 (every month), AIN-6, SXE-4, WUI-5 (any rollover/one-time budget), FAN-8 (every suggest run), FAN-13 (income average drags every month), SXE-12 (NY-hardwired timestamp; overdue rent drops off the feed), AIN-15 (daily drift), WUI-2 (every date one day early in a US browser), PB-10 (any missed recurring task counted done), KR-5 (cache flushed twice daily by reindex), DD-11 (YoY on the current month).
  - NO: FAN-14 (needs bad input), PB-13 / PD-4 (no change while APP_TIMEZONE is unset), FAN-15 / PD-2 (needs a 29th–31st anchor).
  New failure modes: 2 — the digest can be skipped on a day the process only wakes before 07:00 local, and a day 1–5 limit edit rewrites the prior month's snapshot.

OPERATOR ACTIONS / DEPLOY:
- None required: Per-sistant migration 022 auto-runs at boot (additive, idempotent). | BLOCKS DEPLOY: N
- Recommended (already documented): set APP_TIMEZONE to your zone. Most Batch 6 tz fixes (PD-4, PB-13, the cron's local midnight, Sheets/ICS today) are no-ops while it's unset (UTC). | BLOCKS DEPLOY: N
Deploy: Platform, Shell & Auth — Render auto-deploys on push to `main` (alt: `fly deploy`). Sheets & External Export — server-side sheets-sync.js ships with the Render deploy; no Apps Script (Code.gs) change, so no clasp push.

(Not complete in production until blocking operator actions are done AND
the deploy step is confirmed.)

FOLLOW-ON ITEMS:
- PRE-EXISTING BUG (found here, not fixed — out of scope): sheets-sync.js syncUtilities' UNION ALL query ends with `ORDER BY CASE WHEN status = 'Active' …, next_due` — Postgres rejects expressions over output columns in a UNION's ORDER BY ("invalid UNION/INTERSECT/EXCEPT ORDER BY clause"), so the Utilities tab fails on EVERY sync (isolated by INV-24 into errors[]). Fix: wrap the UNION in a subquery, or order by a computed output column.
- sheets-sync.js still uses CURRENT_DATE in the Utilities next_due, Important Dates and similar rolling 90-day projections (not month-bucketed; outside SXE-12's listed sites).
- The Per-sistant todo list has no visual "missed" state; a rolled instance shows like a completed one (data model now distinguishes them).
- The weekly-digest / daily-digest wall-clock hours (Monday, 07:00) aren't user-configurable.
- Perfin's runHousingReminders now uses todayStr() for its day, but still doesn't distinguish overdue vs upcoming the way Per-sistant's housing-due helper does.

DOCUMENTATION UPDATES NEEDED:
- CLAUDE.md:
  - Budgets: getBudgetStatus as the single budget-status helper (endpoint/alerts/insights/Ask/Budgets page/Sheets); snapshot auto-trigger refresh window (days 1–5 DO UPDATE, then create-if-missing); PATCH validation; suggestions use the 3 complete months.
  - Daily digest: once per local date at/after 07:00 APP_TIMEZONE, window since the previous send (≤72h; first send 24h). Replaces the 20-hour gate text in Features, Scheduled Tasks and the user_settings DB notes.
  - Sheets: SHEETS_TZ / whole-tz-month windows; timestamp in APP_TIMEZONE; Budget Status uses the effective limit.
  - ICS: an overdue unpaid obligation is placed on today, flagged OVERDUE.
  - Endpoints: GET /api/spending-yoy through_day + consecutive-years; GET /api/income-summary avg over completed months; PATCH /api/budgets/:id 400s.
  - services/projections.js addMonthsYm/addMonthsYmd + computeLoanPayoff `today`.
  - Shared JS: parseCalDate / localTodayStr / localDateStr (WUI-2).
  - APP_TIMEZONE section: list the newly tz-anchored surfaces.
  - INV-32 wording: the corpus version is date-prefixed.
- apps/per-sistant/CLAUDE.md:
  - migration 022 (recurrence_anchor_day, missed);
  - advanceRecurrence anchor semantics;
  - rollMissedRecurring in helpers.js + the cron in APP_TIMEZONE;
  - missed instances excluded from analytics + /api/stats;
  - complete-recurring tz on-time;
  - notification check / briefing todayStr;
  - KR-5 conditional document upsert + unchanged-fact skip + date-prefixed corpus version + $N::date facts filter;
  - test count 477 → 498.
- Test counts: 1317 across 53 files (Perfin 819 + Per-sistant 498).
---END BROAD SCAN IMPLEMENTATION SUMMARY---
