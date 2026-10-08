---BROAD SCAN IMPLEMENTATION SUMMARY---
Findings implemented:
- SXE-1: Sheets sync errors are no longer dropped. Every syncAll caller (scheduler + POST /api/sheets/sync) records the outcome in user_settings.last_sheets_sync_result. A change in the set of failing tabs sends one notification, and data-health and Settings show the failure.
- WD-6: the dashboard "Sync to Sheets" button shows "Partial: N tabs failed" plus a toast (showMsg) instead of "Synced ✓" with no error shown. Subscriptions and Settings show partial failures too.
- SXE-2: tab formatting can be re-run. formatSheet() deletes the sheet's existing banding and conditional rules (highest index first) in the same atomic batch before re-adding them, and the Dashboard also resets cell formats.
- SXE-14: sheet ids are read once per run with a fields mask. A custom gaxios retry policy retries 429s on any method (Retry-After, else 15s × attempt, ≤60s) but never retries a POST on a 5xx or dropped connection. Month archives are capped at 6 per run.
- SXE-3: month archives are written only 10 days after month-end (APP_TIMEZONE). A per-month completion marker is written last; a tab without it (or a legacy archive) is cleared and rebuilt.
- SXE-5: the Sheets Dashboard goals use the derived funding-linked progress (max(0, balance − baseline)), matching deriveGoalProgress.
- SXE-6: the Sheets category expression is the app's (no personal_finance_category fallback), pinned in SX3.
- SXE-10: the Active Subscriptions count is no longer formatted as currency.
- SXE-13: text written to Sheets is guarded against formula injection; the script's own 3 formulas are wrapped in sheetFormula(). CSV text fields are guarded via the new teller/services/csv-export.js (csvText).
- SXE-8 / PSC-10: CSV exports use YYYY-MM-DD dates (a missing date is blank, not "null"). The transactions export uses the user's merchant rename.
- SXE-9: context-export uses only real insights (entry_type='insight'), lists investment_accounts, drops the Plaid brokerage phantom, shows credit and loans as negative "owed" amounts, and uses ISO dates.
- SXE-15: Code.gs prefers the server-resolved category over PFC, and refuses to write into a Transactions or Subscriptions tab with a different (server-written) header layout.
- SXE-16: the stale splits comment in sheets-sync is fixed. CLAUDE.md now says AI Trust has 100 findings (not 50) and the tab is "Tax Deductions YYYY".

Files modified:
scripts/sheets-sync.js, teller/routes/settings.js, teller/routes/goals.js, teller/routes/housing.js,
teller/services/database.js, teller/startup.js, NEW teller/services/csv-export.js,
teller/views/dashboard.ejs, teller/views/settings.ejs, teller/views/subscriptions.ejs,
apps-script/Code.gs, CLAUDE.md (SXE-16 lines only),
tests/audit-regressions.test.js (SX3 pins), NEW tests/scan-sept-batch10.test.js

CHANGES:
SXE-1 | settings.js, startup.js, database.js, settings.ejs | New `recordSheetsSyncResult(result)`, exported:
  - persists {at, ok, tabs_failed, errors[{step,error}]} to the new user_settings.last_sheets_sync_result JSONB column (auto-migrated);
  - sends one "Google Sheets sync: N tab(s) failed" notification (tag sheets-sync) when the sorted set of failing steps differs from the previous run;
  - the route returns {...result, partial, tabs_failed} and records a wholesale throw as {step:'sync'};
  - the scheduler records the result (a throw too) and still stamps sheets_last_auto_sync;
  - data-health adds a warning issue and returns last_sheets_sync_result; GET /api/settings returns it; Settings shows "Partial: …" under Last Auto-Sync.
WD-6 | dashboard.ejs, subscriptions.ejs | The client checks data.errors.length on a 200 and uses the global showMsg (the old showStatus was IIFE-local and never ran).
SXE-2 | sheets-sync.js | New formatSheet(sheets, sheetId, requests, {resetFormats}):
  - when the requests add banding or conditional rules (or reset), one masked get of bandedRanges and conditionalFormats, then deleteBanding for each and deleteConditionalFormatRule from the highest index down, prepended to the tab's requests;
  - resetFormats adds repeatCell userEnteredFormat {} over the whole sheet (Dashboard);
  - all 15 format passes go through it.
SXE-14 | sheets-sync.js | sheetIdMap() WeakMap cache per client, masked `sheets(properties(sheetId,title))`; ensureSheet updates it from the addSheet reply. google.sheets(... retryConfig: SHEETS_RETRY_CONFIG) with custom shouldRetry and retryBackoff. MAX_ARCHIVES_PER_RUN = 6.
SXE-3 | sheets-sync.js | archiveReadyOn(month) = month-end + 10 days, compared with sheetsTodayStr(). The per-month marker "Perfin archive complete — YYYY-MM" is the protection description, written last by applyProtection(sheets, sheetId, description), which also replaces the generic or older archive protections. A tab without the marker is values.clear'd and rebuilt.
SXE-5 | sheets-sync.js | The goals query LEFT JOINs linked_accounts and investment_accounts. A CASE mirrors deriveGoalProgress: account balance first, else investment balance, else the manual value (orphaned).
SXE-6 | sheets-sync.js, audit-regressions.test.js | CAT_EXPR_PARENT/SPLIT = COALESCE(user_category[, s.category], category[1], 'Uncategorized'). Two SX3 pins plus a no-PFC assertion.
SXE-10 | sheets-sync.js | kpiValuesRow is skipped by the per-row currency loop.
SXE-13 | sheets-sync.js, csv-export.js, settings.js, housing.js | guardSheetsWrites wraps values.update and values.append. guardCell prefixes "'" to strings starting with = + - @ \t \r or shaped like d-d / d/d; sheetFormula() values pass through verbatim. csvText (quote-doubling plus the same prefix) is used in /api/export, the tax-report CSV and the housing CSV; numeric fields stay bare.
SXE-8/PSC-10 | settings.js, csv-export.js | csvDate (local getters → YYYY-MM-DD, null → "") for the transaction date and subscription first_seen/last_charged/next_expected. The export query uses COALESCE(user_merchant_name, merchant_name, name). (The tax CSV's txn_date was already a YYYY-MM-DD string since Batch 7; it now also goes through csvDate.)
SXE-9 | goals.js | Accounts query: NOT EXISTS against active investment_accounts.plaid_account_id. A new investment_accounts query feeds both the markdown and JSON output (`investment_accounts`, `is_liability` on accounts). Credit and loans render as "-$X owed" with APR. The latest-insight query filters entry_type='insight'. Dates go through isoDate.
SXE-15 | Code.gs | New assertScriptLayout_(sheet, headers) after all 4 Transactions/Subscriptions acquisitions (it throws with a "use a separate spreadsheet" message). `txn.category || txn.pfc_primary`.
SXE-16 | sheets-sync.js, CLAUDE.md | Comment corrected (M4 mirrors splits-replacement). AI Trust 100 findings; "Tax Deductions YYYY (one tab per year)".

TEST RESULTS: passed. npm test 1519/1519 (Perfin 974 + Per-sistant 545; 61 files).
- New tests/scan-sept-batch10.test.js (26 tests) plus 3 SX3 pins in audit-regressions.
- Old-code worktree run: the new file fails 24 of 24, and the 3 new SX3 pins fail.
- Real Postgres:
  - migrations ×2.
  - Two full syncAll runs against perfin_ci with a stateful fake Sheets API that rejects a second addBanding on a sheet, as the finding says the real API should (I couldn't call the real API to confirm):
    - run 2 has 0 errors; banding ≤1 per tab; conditional-rule counts are identical across runs;
    - archives carry the marker and run 2 rebuilds none;
    - the "=HYPERLINK" and "7-11" cells are written guarded;
    - the funding-linked goal shows the derived 92% (was the stale 75%);
    - no PFC "FOOD_AND_DRINK" category appears.
    - The same harness on the pre-fix script reproduces the bug: run 2 fails Transactions and Subscriptions with "cannot add alternating background colors".
  - context-export markdown and JSON, the export CSV, recordSheetsSyncResult → data-health issue, and exactly one notification, all on real PG.
- Inline scripts in the 3 edited views pass node --check. e2e 8/8.

REGRESSION RISKS:
- SXE-13: user text starting with + - = @ is now written as literal text. A cell like "+12" (credit-score change) stays text and keeps its sign; the colour rules use VALUE() and still work. A free-text cell holding a number with a leading sign/@ is no longer coerced to a number.
- SXE-3: every existing (legacy, unmarked) archive tab is rebuilt once, 6 per run, which also picks up late-posting rows. That changes the "immutable" tabs one time.
- SXE-14: a sync can take longer under quota pressure (up to 4 retries × ≤60s per call) instead of failing fast; a manual POST /api/sheets/sync waits for it.
- SXE-2: each formatted tab costs one extra masked metadata read. The ensureSheet/getSheetId savings (~2 full-metadata reads per tab) more than offset it.
- SXE-15: an Apps Script user who shares one spreadsheet with the server sync now gets an explicit error instead of silent duplicates.
- SXE-9: the context-export JSON gains `investment_accounts` and `is_liability` (additive).

INVARIANTS AT RISK: None.
- INV-24 still holds: per-tab isolation is unchanged and errors[] is now consumed.
- INV-11 is now honored in Sheets too.
- INV-06: the export uses user_merchant_name.
- INV-48: sheets-sync's inlined fragments are unchanged; the category expression is newly pinned.
- INV-75: the tax report still comes from transactions.
- INV-18: the scheduler is still in-process.
- New invariant candidates:
  - every syncAll caller records last_sheets_sync_result;
  - Sheets formatting deletes before it re-adds;
  - no Sheets text cell is evaluated as a formula unless wrapped in sheetFormula().

NET SCORE:
- Fired in production this month (assuming the Sheets sync is in use):
  - YES: SXE-1, WD-6, SXE-2, SXE-3, SXE-6, SXE-10, SXE-13 (bullet-point insight text → #ERROR!).
  - NO: SXE-5 (needs a funding-linked goal), SXE-14, SXE-8/PSC-10, SXE-9 (needs an export or context-export run), SXE-15, SXE-16.
- New failure modes: none undocumented. The one-time archive rebuild and the slower syncs under quota pressure are intended.
- Score: 7 − 0 = 7.

OPERATOR ACTIONS / DEPLOY:
- None required. The new column auto-migrates. The first sync after deploy rebuilds legacy archive tabs, 6 per run. | BLOCKS DEPLOY: N
- If you use the legacy Apps Script (apps-script/Code.gs): `clasp push` + a new deployment so the category and header-check fixes take effect, and point it at a different spreadsheet from GOOGLE_SHEETS_ID. | BLOCKS DEPLOY: N
Deploy:
- Platform, Shell & Auth — Render auto-deploys on push to `main` (alt: `fly deploy`).
- Sheets & External Export — server side ships with that deploy. Apps Script: `clasp push` from apps-script/, then Apps Script editor → Deploy → New version.

FOLLOW-ON ITEMS:
- The data-health "recent_events" query matches title ILIKE '%sync%', so the new Sheets notifications also appear there. That is fine, just noting it.
- SXE-13: I didn't switch to RAW writes. Date-shaped USER_ENTERED text like "2026-09" (a bare month key) is still coerced by Sheets where the script writes it.
- SXE-2: a format pass that stops adding rules in a future change would leave its old rules in place, because formatSheet only reads and deletes when the batch adds banding or rules or resetFormats is set.
- The Settings "Last Auto-Sync" row shows the latest result whether it came from an auto or a manual run (the label is now slightly broader than "auto").

DOCUMENTATION UPDATES NEEDED:
- CLAUDE.md Sheets section:
  - sync outcome persistence + notification + data-health issue + UI "Partial";
  - re-runnable formatting (formatSheet);
  - per-run metadata cache + 429 retry policy;
  - archive delay / completion marker / 6-per-run cap;
  - derived goals;
  - category expression = the app's;
  - formula guard (guardCell / sheetFormula).
- CLAUDE.md:
  - the new teller/services/csv-export.js (csvText/csvDate) and the export behaviour (ISO dates, user merchant names, guarded text);
  - context-export changes;
  - DB column user_settings.last_sheets_sync_result;
  - data-health response field;
  - Code.gs layout check;
  - test counts 1519/61 (Perfin 974 + Per-sistant 545);
  - INV-24 extension or new invariants;
  - add teller/services/csv-export.js to a subsystem list (Sheets & External Export).
---END BROAD SCAN IMPLEMENTATION SUMMARY---
