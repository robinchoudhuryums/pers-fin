---BROAD SCAN IMPLEMENTATION SUMMARY---
Findings implemented:
- F75 — the Sheets Dashboard "Avg Monthly Spend" / "Avg Daily Spend" are over COMPLETED months with real month lengths (parity with the app's Spending Summary, FAN-6); they divided a window that includes the month to date by 6 / by days-to-date
- F76 — the Sheets Utilities and Important Dates tabs place manual bills with the app's manualBillOccurrences (creation-anchored monthly / quarterly / yearly, real month length, every occurrence in the 90-day window) and transfers with seriesOccurrences (calendar-month steps); "today" is the APP_TIMEZONE date — they placed every manual bill monthly with a 28-day cap, on UTC, and added cadence_days to the last transfer
- F77 — the Income, AI Trust and Watchlist tabs reset cell formats before re-formatting (their section rows move between syncs, leaving stale header formatting)
- F78 — Sheets sync single-flight: a second call of the same kind shares the running run's promise; a different kind waits for it, then runs
- F79 — in-process digest delivery reports a draft (no recipient, or one that isn't an email address) as sent: false (reason no_recipient_configured / invalid_recipient) instead of sent: true; the weekly / daily digest ticks settle for the day on it (no hourly drafts) and record a failed run
- F80 — Per-sistant's Perfin widget: monthly cost is every active subscription's monthly equivalent (amount × 30 / cadence_days, Perfin's rule), and "upcoming this week" is today through today + 7 by APP_TIMEZONE date (a charge due today was dropped)
- F83 — the Sheets formula guard passes plain signed numbers / amounts / percentages ("-12.5%", "-$45.00", "+20") as data instead of text
- F84 — apps-script/Code.gs guards every data write (setValues / appendRow) with guardRows_ (formula-like strings get a leading apostrophe; plain numbers pass)
- F86 — validation bundle: PATCH /api/settings 400s an invalid theme, dashboard_months, insights_model, insights_cadence_days, insight_modules, pyramid_*, debt_baseline_amount, sheets_auto_sync_interval, dashboard_widgets and session_timeout_minutes (they were dropped or clamped with a 200); shell_idle_timeout_minutes uses the strict toInt ("30abc" → 400); /api/sheets/dashboard checks the Sheets env; a failed partial Sheets sync (transactions / dashboard) is recorded in last_sheets_sync_result; read notification_log rows older than 180 days are pruned (at most once a day, on the next send); the Credit Scores "Change" compares the same score type only
- F44 — doc fixes: getCategorySpendingThisMonth is described as the APP_TIMEZONE month (not CURRENT_DATE); the income-predicate comment describes its four branches; the digest-prerequisite note no longer points at a non-existent "Settings → Integrations" (the shared-card 50/50 and Express v5 claims were already gone)
New capabilities (G/ST): None
Files modified:
- scripts/sheets-sync.js
- apps-script/Code.gs
- teller/routes/settings.js
- teller/routes/notifications.js
- teller/routes/persistent.js
- teller/startup.js
- teller/services/financial-queries.js (comment only)
- apps/per-sistant/routes/perfin.js
- CLAUDE.md (F44)
- tests/scan-sept-batch6.test.js (Utilities order pin moved to JS)
- tests/scan-oct-batch9.test.js (new)
- tests/contract/sheets-crossapp.contract.test.js (new)

CHANGES:
F75 | sheets-sync.js | per-month totals query over the 6-month window + completedMonthAverages(monthTotals, sheetsMonth(0)); blank cells with no completed month
F76 | sheets-sync.js | requires the pure ../teller/services/cadence (manualBillOccurrences, seriesOccurrences, addDaysStr); Utilities computes a manual bill's next_due in JS and sorts Active-first / next_due-nulls-last in JS; Important Dates queries subs + goals with $1 = APP_TIMEZONE today and builds manual-bill + transfer rows in JS; fmtDate returns a 'YYYY-MM-DD' string unchanged
F77 | sheets-sync.js | formatSheet(…, { resetFormats: true }) in syncIncome / syncAiTrust / syncWatchlist
F78 | sheets-sync.js | singleFlight(kind, fn) around syncAll / syncTransactionsOnly / syncDashboardOnly (runSync* hold the bodies)
F79 | persistent.js, startup.js | deliverDigestInProcess validates the recipient and returns sent:false + stored:"draft"; DRAFT_ONLY_REASONS settle the digest ticks for the day
F80 | apps/per-sistant/routes/perfin.js | widgetFigures(subs, today) (+ ymdOf) shared by the embedded and standalone paths; exported for tests
F83 | sheets-sync.js | PLAIN_NUMBER_RE short-circuit in guardCell
F84 | Code.gs | guardCell_ / guardRows_ + every data setValues / appendRow wrapped
F86 | settings.js, notifications.js, sheets-sync.js | settings 400s + toInt; dashboard env check; recordSheetsSyncResult on a failed partial sync (a partial success isn't recorded — it says nothing about other tabs); pruneNotificationLog (180 days, read rows, once a day); Credit Scores prior = next older row of the same score type
F44 | CLAUDE.md, financial-queries.js | the three stale claims corrected

TEST RESULTS: npm test 1624/1624 (+16 scan-oct-batch9); contract 87/87 (+5 sheets-crossapp); migrations run twice OK (no schema change); Playwright 35/35. Every new test fails against the pre-fix code. The new contract test caught a bug in the first F76 draft (seriesOccurrences' max bounds iterations, not results — max 1 never reached today); fixed before commit. One existing pin (scan-sept-batch6 — the Utilities ORDER BY in SQL) was updated to the JS sort.
REGRESSION RISKS:
- F86: a client that relied on clamping (an empty session-timeout field → 15, dashboard_months 99 → 24) now gets a 400 and an error toast.
- F79: a draft-only digest settles for the day, so fixing the recipient later that day sends the next day; the watermark isn't advanced, so the next digest covers the gap.
- F76: Important Dates now lists every manual-bill occurrence in the window (a monthly bill appears ~3 times); a transfer past its expected date shows its next calendar occurrence instead of disappearing.
- F78: a dashboard / transactions-only sync requested during a full sync waits for it (up to ~60s).
- F83: "+20"-style strings are written as numbers (the Credit Scores Change column), which Sheets displays as 20.
- F86: read notifications older than 180 days disappear from the bell.
INVARIANTS AT RISK: None — INV-24 (per-tab isolation unchanged; partial-sync failures now recorded too), INV-82 (resetFormats is the existing re-runnable path), INV-83 (the guard still prefixes every formula-like string; only plain numbers pass), INV-59 (more bounded settings now 400), INV-70 (Sheets now uses the same cadence rules), INV-77 (digest ticks still away-from-app, watermark-bound), INV-106 (no new bare catch).
NET SCORE: 5 − 1 = 4 (F75, F76, F77, F80, F83 fired in production; F79's day-settle is a documented new delay)

OPERATOR ACTIONS / DEPLOY:
- Apps Script: push the updated apps-script/Code.gs (`clasp push` from apps-script/, then Deploy → New version) for F84 | BLOCKS DEPLOY: N
Deploy: Platform, Shell & Auth: Render auto-deploys on push to `main` (configured in the Render dashboard, not via CLI). Alt: `fly deploy` (Dockerfile-based).
Deploy: Sheets & External Export: Apps Script side deploys via clasp — `clasp push` from apps-script/, then Apps Script editor → Deploy → New version. (Server-side sheets-sync.js ships with the main Render deploy.)

(Not complete in production until blocking operator actions are done AND
the deploy step is confirmed.)

FOLLOW-ON ITEMS:
- Settings → AI Insights still tells the user to configure the webhook "in Per-sistant integration below" — that section doesn't exist (F81, later batch).
- The standalone HTTP webhook path still reports sent: true when Per-sistant's receiver stores a draft.
- Important Dates still lists a subscription by its single stored next_expected (not every occurrence in the window).
- notification_log retention is fixed at 180 days (no setting).
(or "None")

DOCUMENTATION UPDATES NEEDED:
- CLAUDE.md: Sheets (Dashboard averages over completed months; Utilities / Important Dates via cadence.js + APP_TIMEZONE; resetFormats on Income / AI Trust / Watchlist; single-flight; the guard's plain-number pass-through; Credit Scores change per type); Code.gs guard (apps-script entry); in-process digest draft = not sent (Insight email / digest bullets + the Database perfin_webhook_recipient note); Per-sistant widget figures (Per-sistant Integration section + apps/per-sistant/CLAUDE.md); settings 400s (INV-59 + the PATCH /api/settings note); /api/sheets/dashboard env check + partial-sync failure recording (SXE-1 paragraph); notification_log retention ("Notification log as audit trail" said never deleted); counts (1624 across 76 files, Perfin 1168; contract 87); Known Issues (Batch 9 follow-ons).
- README: counts + Batch 9 summary.
---END BROAD SCAN IMPLEMENTATION SUMMARY---
