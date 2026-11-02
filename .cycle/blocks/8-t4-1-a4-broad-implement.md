---BROAD SCAN IMPLEMENTATION SUMMARY---
Findings implemented: None (roadmap work, not scan findings)
New capabilities (G/ST): Roadmap T4.1 A4 — "Tell me when my plan changes": one opt-in checkbox (Settings → Alerts & Notifications → Cash Alerts → Plan Changes, user_settings.advice_alerts_enabled, off by default) and the hourly `advice-plan` away job that evaluates the plan at most once a local day and pushes "Your plan changed" when the headline step changes, a debt step's target debt changes, or the amount per period moves ≥ 20% AND ≥ $50 (push only, never email; signature advanced only when the notification was logged)
Files modified:
  teller/services/advice-alerts.js (new)
  teller/startup.js
  teller/services/job-health.js
  teller/services/database.js
  teller/routes/settings.js
  teller/views/settings.ejs
  tests/roadmap-t4-1-a4.test.js (new)
  tests/contract/advice-a1.contract.test.js

CHANGES:
T4.1 A4 | teller/services/advice-alerts.js | runAdviceAlerts(pool, { now, today, deps }): off → one settings read a local day (in-memory memo until invalidate()); advice_state.checked_on + a memo → at most one evaluation a local day; getAdvicePlan; a plan that can't be worked out only stamps the day; no stored signature → a silent baseline; planChange (pure): step change, a debt step's target change, or |Δ amount per period| ≥ 20% and ≥ $50 (a paycheck/month unit change compared monthly), always against the LAST NOTIFIED signature so a slow drift still triggers; changeText (pure): "<old target> is paid off — your plan now puts $X per paycheck toward <…>." when the old target is no longer a carried balance, else "Your plan changed — it now …" / "Your plan now … (was $Y per paycheck)."; the plan's own headline for a $0 amount or the minimums step; sendToAll { title "Your plan changed", tag advice-plan, url /dashboard }; an unlogged push writes nothing (the day stays unchecked → the next tick retries). No email path.
T4.1 A4 | teller/startup.js | runAdvicePlanTick — tick first, not activity-gated, result only when it evaluated (unlogged / throw → error); hourly setInterval, scheduleBootRuns ("advice-plan"), _awayJobs export
T4.1 A4 | teller/services/job-health.js | JOB_INTERVALS_MS "advice-plan": 1 hour
T4.1 A4 | teller/services/database.js | user_settings.advice_alerts_enabled BOOLEAN NOT NULL DEFAULT false + advice_state JSONB (ADD COLUMN IF NOT EXISTS)
T4.1 A4 | teller/routes/settings.js | GET selects both (defaults false / null); PATCH advice_alerts_enabled strict boolean (400 otherwise); switching on resets advice_state to NULL only when it was off (a fresh baseline, never a comparison with a pre-off plan); a change calls advice-alerts.invalidate()
T4.1 A4 | teller/views/settings.ejs | "Plan Changes" row in the Cash Alerts section — aria-labelled checkbox #advice-alert-toggle through saveToggle
T4.1 A4 | scripts/reset-fresh.js | no change needed — it deletes and re-inserts the user_settings row, so both columns return to their defaults; no new table (classification test unchanged)

TEST RESULTS: npm test 2808/2808 pass (24 new in tests/roadmap-t4-1-a4.test.js). Contract suite 276/277 — 1 new A4 test passes on real Postgres (PATCH on, silent baseline, once-a-day, Visa paid off → one notification_log row "Visa is paid off — … toward Store card", state advanced, off/on → fresh baseline); the 1 failure is PRE-EXISTING and date-dependent (tests/contract/cash-alerts-l2 "a dip below the floor notifies once" — fails on the unchanged tree too; see follow-ons). Mutation checks 6/6 caught (logged gate, the AND of 20%/$50, the silent baseline, the once-a-day stored day, the "paid in full is paid off" rule — caught after adding a test, the switch-on reset).
REGRESSION RISKS: GET /api/settings now selects two more columns (added by the boot migration); the settings response carries advice_state (debt names and amounts already shown on the dashboard). The plan engine runs at most once a local day while the switch is on (seven reads).
INVARIANTS AT RISK: None — INV-77 (away job: not activity-gated, own watermark advice_state.checked_on + a per-day memo, boot-run), INV-59 (strict boolean, 400), INV-105 (outcome recorded, in JOB_INTERVALS_MS), INV-81 (no new table), INV-150 (the push words the code-computed plan) all hold.
NET SCORE: 0 production fixes − 0 new failure modes = 0 (new capability)

OPERATOR ACTIONS / DEPLOY:
- None | BLOCKS DEPLOY: N
Deploy: Platform, Shell & Auth — Render auto-deploys on push to `main` (the boot migration adds the two columns).

(Not complete in production until blocking operator actions are done AND
the deploy step is confirmed.)

FOLLOW-ON ITEMS:
- tests/contract/cash-alerts-l2.contract.test.js "a dip below the floor notifies once" is date-dependent (pre-existing): the seed's last_charged is today − 27 and it expects the bill at today + 3, but the forecast steps by calendar month (INV-70), so when last_charged's month has 31 days the bill lands at + 4. Seed last_charged as the calendar month before add(3).
- A step change caused by a temporarily missing source (a pay stream that drops out for a month) notifies, and its return notifies again; there is no "quiet for N days" hysteresis beyond the once-a-day check.
- The push opens /dashboard, not the "Your plan" card (a hash link doesn't scroll to a section rendered after load).
- No "last checked" line under the checkbox (the state is stored in advice_state.last_check).
- A target change inside a debt step (Visa → Store card) notifies too — read as part of "the headline step changes", since the headline names the card.

DOCUMENTATION UPDATES NEEDED:
- CLAUDE.md: services/advice-alerts.js in the architecture tree + the Financial Analytics subsystem list; the Low cash / payday feature block (plan-change alert); the `advice-plan` scheduled task; user_settings.advice_alerts_enabled / advice_state under Database; PATCH /api/settings field list; INV-77 / INV-59 lists; INV-150 (the push); Known Open Issues T4.1 (A4 done + follow-ons); Priority Next Features (A5 next); test counts (2808 / 149 files, contract 277).
- README: test count + the plan-change alert clause.
---END BROAD SCAN IMPLEMENTATION SUMMARY---
