---BROAD SCAN IMPLEMENTATION SUMMARY---
Findings implemented: None (roadmap work, not scan findings)
New capabilities (G/ST): Roadmap T2.2 (low-balance and payday alerts), batch L2 of L1–L4 (.cycle/plan-t2-2-cash-alerts.md) —
  L2 the low projected cash alert: services/cash-alerts.js (freshness gate, the shared forecast, firstBelow against a floor, once-per-breach dedup), the hourly "cash-alerts" away job, five user_settings columns with strict PATCH validation, Settings → Cash Alerts. Docs folded in.
Files modified: teller/services/cash-alerts.js (new), teller/services/database.js, teller/services/job-health.js, teller/startup.js, teller/routes/settings.js, teller/views/settings.ejs, tests/roadmap-t2-2-cash-l2.test.js (new), tests/contract/cash-alerts-l2.contract.test.js (new), CLAUDE.md, README.md, .cycle/plan-t2-2-cash-alerts.md, .cycle/STATE.md

CHANGES:
L2 | teller/services/cash-alerts.js | runCashAlerts(pool, { now, today, deps }): one read of the settings + data stamps (max balance_updated_at over depository non-investment accounts; GREATEST with last_txn_sync_at, last_balance_sync_at, max plaid_items / teller_enrollments last_synced_at). Off → "disabled" and an in-memory per-local-day memo (no further DB read; invalidate()). Checked earlier today with no newer data → "unchanged" (no write, no forecast). Newest spendable balance > 36 h old or none → "skipped" (stale_balances / no_balances), stamped. Else getCashFlowForecast(horizon) + firstBelow(threshold): none → "clear" (alert dropped, silent); breach → shouldNotify (no alert on record, breach ≥ 3 days earlier than the notified one, or ≥ 72 h since it) → push "Low cash ahead" (tag cash-low, /dashboard, text with the floor, breach day and lowest day) → only if logged: the opt-in critical-alert email (errors logged) and the state; an unlogged push → "unlogged", nothing written so the next tick retries; otherwise "held" with the notified breach kept as the reference. State = cash_alert_state { alert, last_check } + cash_alerts_checked_at
L2 | teller/services/database.js | user_settings.cash_alert_enabled (false), cash_alert_threshold NUMERIC(12,2) (500), cash_alert_horizon_days (14), cash_alert_state JSONB, cash_alerts_checked_at TIMESTAMPTZ
L2 | teller/startup.js, teller/services/job-health.js | runCashAlertsTick: tick → runCashAlerts; an outcome only when it evaluated (ok), an unlogged notification or a throw as an error; hourly setInterval, NOT activity-gated; exported in _awayJobs; JOB_INTERVALS_MS["cash-alerts"] = 1 h
L2 | teller/routes/settings.js | GET returns the five fields (defaults false / 500 / 14 / null / null). PATCH: cash_alert_enabled strict boolean, cash_alert_threshold a number or numeric string 0–1e7 ("" / null / text refused) rounded to cents, cash_alert_horizon_days integer 7–60 via toInt — each else a 400; any cash_alert_* key clears the alert's off-for-today memo
L2 | teller/views/settings.ejs | Settings → Cash Alerts: Low Cash Alert toggle, Floor input + Save (parseAmountInput, refuses a non-number or negative), Look Ahead select (7/14/21/30/45/60); every control aria-labelled; loaded from GET /api/settings
Tests | tests/roadmap-t2-2-cash-l2.test.js (19), tests/contract/cash-alerts-l2.contract.test.js (4) | Unit: every runCashAlerts gate and dedup branch over a fake pool with stubbed forecast / push / email (exact notification text and state, floor-equal not below, unlogged retry, email failure harmless, negative money), the tick's outcome recording, hourly + watched + not activity-gated, PATCH 400s + cents rounding + memo reset, GET defaults, the Settings form. Contract: off by default; switched on via the real PATCH (bad values 400); a real dip notifying once into notification_log; unchanged; held after new data; re-notified 72 h on; clear after more cash (alert dropped); skipped on a 40-hour-old balance
Docs | CLAUDE.md, README.md | Architecture (cash-alerts.js), the Low cash alert feature, PATCH /api/settings fields, the user_settings columns, Scheduled Tasks (the job + the away-channel list), INV-59 / INV-77 wording, counts 2045 / 103 files / Perfin 1494, contract 195 + test-file descriptions, Financial Analytics subsystem list, Known Open Issues (L2 done + follow-ons)

TEST RESULTS: npm test 2045/2045 (19 new); contract 195/195 (4 new); CI migration test (both apps, twice, fresh database) passed; Playwright 57/57 (the Settings page changed). Mutation checks: removing the 36-hour gate, removing the dedup, ignoring `logged`, or a loose Number("") floor parse each turn tests red.
REGRESSION RISKS:
- With the alert switched on, the hourly tick reads user_settings (+ max over three tables) every hour the process is awake — on Neon that keeps compute from suspending for long; off (the default) it reads once a local day.
- cash_alerts_checked_at is the app's clock while the data stamps are the database's: a large clock skew could delay a re-check until the next local day (the same server in practice).
- The Settings click sweep now presses the new Floor "Save" (a PATCH of the shown value — non-destructive).
INVARIANTS AT RISK: None. INV-59 (strict 400s, extended), INV-77 (a new away channel, watermark + memo gated, extended), INV-105 (outcome recorded, JOB_INTERVALS_MS entry — the scan-oct-batch3 coverage test passes), INV-106 (no bare catch), INV-81 (new user_settings columns reset by the default row), F24 rule (email + state only after a logged notification).
NET SCORE: 0 production fixes − 0 new failure modes = 0 (new capability; off by default)

OPERATOR ACTIONS / DEPLOY:
- Optional: switch it on in Settings → Cash Alerts (and Critical Alert Emails for the email) | BLOCKS DEPLOY: N
Deploy: Financial Analytics / Platform / Web UI — Render auto-deploys on push to `main` (PR robinchoudhuryums/pers-fin#133).

(Not complete in production until blocking operator actions are done AND
the deploy step is confirmed.)

FOLLOW-ON ITEMS:
- The notification opens the dashboard, not the Cash Flow section (a hash link doesn't scroll to a section that renders after load).
- The last evaluation / skip reason is stored (cash_alert_state.last_check) but not shown yet — L4.
- Clock skew between app and database (see regression risks).

DOCUMENTATION UPDATES NEEDED:
- None beyond this batch (docs folded in).
---END BROAD SCAN IMPLEMENTATION SUMMARY---
