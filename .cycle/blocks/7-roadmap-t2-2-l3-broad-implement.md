---BROAD SCAN IMPLEMENTATION SUMMARY---
Findings implemented: None (roadmap work, not scan findings)
New capabilities (G/ST): Roadmap T2.2 (low-balance and payday alerts), batch L3 of L1–L4 (.cycle/plan-t2-2-cash-alerts.md) —
  L3 payday alerts: "Paycheck landed" as the third post-sync step (stream-matched deposits only, a text watermark over created_at) and "Payday missed?" in the hourly cash-alerts job (overdue past a 3-day grace, any-amount arrival check, only after the account's connection synced cleanly), a strict settings switch that moves the watermark on switch-on, the Settings toggle. Docs folded in.
Files modified: teller/services/payday-alerts.js (new), teller/routes/enrollments.js, teller/startup.js, teller/services/database.js, teller/routes/settings.js, teller/views/settings.ejs, tests/roadmap-t2-2-cash-l3.test.js (new), tests/contract/payday-l3.contract.test.js (new), tests/roadmap-t2-2-cash-l2.test.js, CLAUDE.md, README.md, .cycle/plan-t2-2-cash-alerts.md, .cycle/STATE.md

CHANGES:
L3 | teller/services/payday-alerts.js | runPaydayLanded(pool, { today, deps }): settings read (off → done); no watermark → set to now, nothing announced; candidates = settled INCOME_PREDICATE deposits created after last_income_alert_at (compared as text — microseconds kept) and dated ≥ today − 5 days, in created_at order; each matching a live stream (getLiveIncomeStreams, same source, ±10%) → push "Paycheck landed" "$X from <source> (<cadence>) on <day>" (tag payday-<sha256(txn id)[12]>, /dashboard); the watermark moves to the newest processed row, or stops just before a send that throws. runPaydayMissed(pool, { now, today, deps }): off → memo, no DB read that day; one settings + sync-stamp read; an in-memory (local day | newest sync stamp) memo; per live stream, overduePayday (the latest expected date after its last deposit with expected + 3 < today, ≤ 14 days old); skip if any deposit from the source (any amount) is dated ≥ expected − 3; skip unless the account of the stream's last deposit belongs to a GOOD Teller enrollment / Plaid item whose last_synced_at's local day is after expected + 3 (CSV / manual never); dedup sentRecently(tag payday-missed-<hash>-<expected>, 60 days); push "Payday missed?" (/transactions) → only if logged the opt-in critical-alert email; an unlogged push leaves the memo unset (retry)
L3 | teller/routes/enrollments.js | runPostSyncSteps: a third step after runAnomalyCheck on the same serialized chain — runPaydayLanded, its errors logged, never rejecting
L3 | teller/startup.js | runCashAlertsTick runs runCashAlerts then runPaydayMissed, each isolated (a throw in one still runs the other); outcome ok when either evaluated, an error naming the check for a throw or an unlogged push, nothing when neither evaluated
L3 | teller/services/database.js | user_settings.payday_alerts_enabled (false), last_income_alert_at TIMESTAMPTZ
L3 | teller/routes/settings.js, teller/views/settings.ejs | GET returns payday_alerts_enabled (default false); PATCH: strict boolean (400 otherwise), switching on adds last_income_alert_at = CASE WHEN payday_alerts_enabled THEN last_income_alert_at ELSE now() END (the old switch is read), any change clears the missed check's memo. Settings → Cash Alerts gains a labelled Payday Alerts toggle
Tests | tests/roadmap-t2-2-cash-l3.test.js (21), tests/contract/payday-l3.contract.test.js (3), tests/roadmap-t2-2-cash-l2.test.js | Unit: overduePayday edges; landed (off, initialise, matched vs one-off with exact text + tag, text watermark, held back on a throw, the 5-day window, INCOME_PREDICATE) and its post-sync position (after the anomaly check, a failure not rejecting); missed (push + email + tag + the exact query params, any-amount arrival, no connection / no sync / an early sync never alerting, dedup, memo, unlogged retry, off memo + invalidate); the shared tick's isolation and outcomes; PATCH 400s, the CASE on switch-on only, the memo reset, GET default, the Settings toggle. Contract: switch-on moves the watermark; a 4-days-overdue biweekly paycheck on a freshly synced Plaid item notifies once, a stale item's doesn't, a repeat is unchanged / deduped; a matching deposit through the real runPostSyncSteps notifies once, a one-off direct deposit doesn't, nothing missed after it. The L2 tick test now stubs the payday check too and expects check-named errors
Docs | CLAUDE.md, README.md | Architecture (payday-alerts.js, runPostSyncSteps' third step), the Payday alerts feature, PATCH fields, the user_settings columns, Scheduled Tasks (the shared tick, the away-channel list), INV-59 / INV-67 / INV-77 wording, counts 2066 / 104 files / Perfin 1515, contract 198 + test-file descriptions, Financial Analytics subsystem list, Known Open Issues (L3 done + follow-ons)

TEST RESULTS: npm test 2066/2066 (21 new); contract 198/198 (3 new); CI migration test (both apps, twice, fresh database) passed; Playwright 57/57 (the Settings page changed). Mutation checks: announcing unmatched deposits, dropping the connection-freshness gate, ignoring an arrived deposit, or advancing the watermark past a failed send each turn tests red.
REGRESSION RISKS:
- Every transaction sync that adds rows now does one more settings read (+ the candidate and stream queries when payday alerts are on) inside the serialized post-sync chain.
- The missed check reads the income streams every tick a sync stamp moves (with the alert on) — the same 4-month income query the calendar and forecast run.
- An income deposit from a newly linked account dated within the last 5 days that matches an existing stream is announced as landed (intended — it is new to the app).
INVARIANTS AT RISK: None. INV-67 (the anomaly check still runs once per sync; the payday step follows it on the same chain — wording extended), INV-05 (reconcile runs no post-sync steps, so never a landed alert), INV-77 (the missed check is an away channel, memo + sentRecently gated), INV-59 (strict boolean), INV-110 (getLiveIncomeStreams is the one stream source), INV-106 (no bare catch), F24 rule (email only after a logged push).
NET SCORE: 0 production fixes − 0 new failure modes = 0 (new capability; off by default)

OPERATOR ACTIONS / DEPLOY:
- Optional: switch on Settings → Cash Alerts → Payday Alerts (and Critical Alert Emails for the missed-payday email) | BLOCKS DEPLOY: N
Deploy: Financial Analytics / Bank Sync / Platform / Web UI — Render auto-deploys on push to `main` (PR robinchoudhuryums/pers-fin#133).

(Not complete in production until blocking operator actions are done AND
the deploy step is confirmed.)

FOLLOW-ON ITEMS:
- The missed check runs beside runCashAlerts in the same job rather than inside it (the plan said inside) so it works with the cash alert switched off.
- A paycheck that moves to a new source name reads as missed once; a merchant rename rule folds it back.
- Streams on CSV / manual accounts never alert as missed (no connection freshness to trust).

DOCUMENTATION UPDATES NEEDED:
- None beyond this batch (docs folded in).
---END BROAD SCAN IMPLEMENTATION SUMMARY---
