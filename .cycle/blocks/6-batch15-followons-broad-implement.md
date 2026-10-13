---BROAD SCAN IMPLEMENTATION SUMMARY---
Findings implemented (the "still open" items Batch 15's real-code tests exposed):
- FO-1 — Per-sistant GET /api/calendar 500'd whenever an open recurring todo existed (router read advanceRecurrence off deps; server.js passes it inside helpers)
- FO-2 — Quick Add never detected priority or a date (its regexes lost their backslashes in the template-literal page script)
- FO-3 — the palette picker never appeared under the shell (pathname check ignored the /per-sistant mount base)
- FO-4 — views/js.js (undo toast, offline banner, rendered markdown) used CSS variables the current theme doesn't define
- FO-5 — Per-sistant PATCH /api/settings stored theme and perfin_url unvalidated
- FO-6 — no contract coverage for the sync engines, insights or Knowledge (real-Postgres tests added)
Files modified:
apps/per-sistant/routes/calendar.js, apps/per-sistant/pages/todos-script-2.js, apps/per-sistant/views/settings-patch.js, apps/per-sistant/views/js.js, apps/per-sistant/routes/settings.js, apps/per-sistant/pages/settings-script.js, apps/per-sistant/tests/batch15-followons.test.js (new), apps/per-sistant/tests/api.test.js, apps/per-sistant/tests/scan-sept-batch14.test.js, tests/scan-sept-batch15.test.js, tests/contract/persistent.contract.test.js, tests/contract/sync-ai.contract.test.js (new), tests/contract/knowledge.contract.test.js (new)

CHANGES:
FO-1 | routes/calendar.js | factory takes { pool, helpers } and reads advanceRecurrence from helpers (the deps object server.js actually passes); batch14's test double now passes helpers; the contract test's `todo` flag removed; a guard (batch15-followons) parses server.js's deps object and fails if any routes/*.js factory destructures a key outside it
FO-2 | pages/todos-script-2.js | every backslash in the quick-add regexes doubled so the emitted bundle carries \b \d \s \w (31 escapes); api.test.js's 2 QUICK_ADD_BUG todos now run (plus a weekday case); a guard scans every Per-sistant pages/ + views/ module that exports a template-literal string for a single-escaped regex class/delimiter
FO-3 | views/settings-patch.js | strips window.BASE_PATH (and trailing slashes, via string methods — the module is a template literal) before comparing with '/settings'; run in a vm at /per-sistant/settings, /settings, /per-sistant/todos
FO-4 | views/js.js | --surface-2→--paper-2/--paper-card, --border→--line, --text→--ink, --text-muted→--muted, --warm/--teal→--accent, --green→--good, offline banner --yellow/#000 → --accent-soft/--ink with a --line border, Undo button text --paper (readable on the mono-dark accent); the batch15 CSS-var guard's KNOWN_GAPS is now empty
FO-5 | routes/settings.js, pages/settings-script.js | theme ∈ dark|light|auto (400 otherwise); perfin_url must be an http(s) URL without credentials, ≤500 chars, stored trimmed without a trailing slash, ""/null clears; the Settings page shows the server's reason on a failed save
FO-3 | tests/scan-sept-batch15.test.js | navigation guard KNOWN_GAPS now empty (a stale entry would fail)
FO-6 | tests/contract/sync-ai.contract.test.js | Teller syncAllEnrollments (signs, pending skip, counterparty merchant, text[] category, watermark, re-sync adds 0), reconcileTeller (no adds, watermark unchanged), syncAllBalances (balance, daily + net-worth snapshot, accounts_changed 0 on repeat), syncAllTransactions; Plaid syncPlaidItemTransactions (insert, idempotent re-delivery, modified upsert, removed delete, cursor persisted, legacy category + PFC stored); POST /api/categorize (Teller-map + AI batch into user_category, usage row); generateInsights (modules_failed empty with ≥8 modules on the real schema, insight stored + audited complete, summary saved, status/list read back) — Teller HTTP, a Plaid client object and the Anthropic SDK are the only stubs
FO-6 | tests/contract/knowledge.contract.test.js | syncVault through a fake GitHub API (injected fetchImpl): documents + fact files ingested without Voyage, secret stored with sensitivity, no-op at the same head, syncNotes, keyword search over documents + notes never returning secret text, secret-lookup, facts current vs all=1 + verify, /api/rag/query without AI, status, incremental compare that removes a deleted file

TEST RESULTS: npm test 1489/1489, 0 todo (was 1475 + 2 todo; +14 in batch15-followons). Contract suite 43/43, 0 todo (was 27 + 1 todo) on local Postgres 16, run both without and with pgvector (the CI image's path); scripts/ci-migration-test.js passes. Playwright: the 8 smokes + 4 temporary follow-on specs (palette row under /per-sistant/settings, Quick Add preview shows "urgent" + the date, /api/calendar with a recurring todo, undo toast background) all pass in Chromium; the temporary spec was removed. Old-code check: 11 of the 14 new unit tests fail against HEAD (the other 3 are guards that held before too). Mutation check: making Plaid's upsert report every row as inserted, and dropping the sensitivity filter from keyword retrieval, each turned a new contract test red.
REGRESSION RISKS:
- calendar.js now requires deps.helpers — any caller building the router with only { pool, advanceRecurrence } breaks (only server.js and the updated test build it).
- PATCH /api/settings now 400s a theme outside dark/light/auto or a non-URL perfin_url; the Settings page only sends its select values, and a bad Perfin URL now surfaces as an error message instead of being saved.
- Colours of the undo toast / offline banner / markdown links changed (they had none before).
INVARIANTS AT RISK: None. INV-25 (embedded wiring) is now guarded for deps; INV-27/29 (Knowledge privacy + degrade) and INV-01/04/05/54 (sync idempotency) gained real-Postgres contract coverage; INV-95's KNOWN_GAPS lists shrank to empty.
NET SCORE: production fixes 5 (FO-1..FO-5 all fire in production today: the calendar page and dashboard mini-calendar error for anyone with a recurring task; Quick Add ignores priority/dates; the palette picker is missing under the shell; the toast/banner render without colours; invalid settings are stored) − new failure modes 0 = 5

OPERATOR ACTIONS / DEPLOY:
- None | BLOCKS DEPLOY: N
Deploy: Platform, Shell & Auth: Render auto-deploys on push to `main` (configured in the Render dashboard, not via CLI). Alt: `fly deploy` (Dockerfile-based). This branch (Batches 11–15 + these follow-ons) is not merged to main yet.

(Not complete in production until blocking operator actions are done AND
the deploy step is confirmed.)

FOLLOW-ON ITEMS:
- Plaid's transaction upsert still builds the legacy category array as a concatenated `{a,b}` literal (teller/routes/investments.js upsertTxn) — the DC-14 class; Plaid's legacy category names have no commas/quotes today, so it doesn't fire, but it should take a text[] parameter like the CSV and manual paths.
- Quick Add's due date uses toISOString() (UTC) — "tomorrow" entered late evening west of UTC lands a day late (the WUI-2/PD-4 class; not in this scope).
- Per-sistant PATCH /api/settings still stores session_timeout_minutes and default_horizon unvalidated.
- The contract suite still doesn't exercise the Plaid HTTP wrappers' item loop (syncAllPlaidTransactions needs a Plaid client from env) or the Teller enrollment/exchange routes.
DOCUMENTATION UPDATES NEEDED:
- Root CLAUDE.md + apps/per-sistant/CLAUDE.md: remove the "Known Open Issues" sections (all five fixed; the contract-coverage gap is now closed for sync/insights/Knowledge), update counts (1489 tests / 67 files; Perfin 1033 + Per-sistant 456; contract 43), describe tests/contract/sync-ai + knowledge, batch15-followons.test.js, and the deps / template-literal-escape guards; note the theme/perfin_url validation in the Per-sistant settings docs; README counts.
---END BROAD SCAN IMPLEMENTATION SUMMARY---
