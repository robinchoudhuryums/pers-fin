---BROAD SCAN IMPLEMENTATION SUMMARY---
Findings implemented:
- F31 — the tax_documents form / origin and webhook_events provider / status CHECKs lived only inside CREATE TABLE IF NOT EXISTS, so a value added in code reached only fresh databases (green tests, a 500 in production)
- F32 — the error log's daily prune ran only after a minute that had new errors
- F33 — a landing status line that ran over its 1.5 s budget left its queries running, and every visit started another set (no cache, no single-flight) on a 3-connection pool
- F52 — Per-sistant had no DATE type parser: node-pg's local-midnight Date serialized in UTC, so on a server east of UTC a due date went out (and ai.js quoted it) a day early
- F45 — the two stale Known Open Issues bullets: already corrected by the Batch 1 docs sync (fcd096c); nothing left to change
New capabilities (G/ST): None
Files modified:
- teller/services/database.js, teller/services/error-log.js, shell/landing-status.js
- apps/per-sistant/db.js, apps/per-sistant/helpers.js, apps/per-sistant/routes/calendar.js, apps/per-sistant/routes/todos.js,
  apps/per-sistant/routes/ai.js, apps/per-sistant/routes/notifications.js
- e2e/pages.spec.js (the landing test reloads until a 30 s cached line has turned over)
- tests: new tests/broad-scan-c8-batch8.test.js (10), apps/per-sistant/tests/broad-scan-c8-batch8.test.js (5),
  tests/contract/c8-batch8.contract.test.js (2); updated tests/roadmap-t3-3-k2.test.js (the form list now read from
  database.CHECK_LISTS)

CHANGES:
F31 | teller/services/database.js | CHECK_LISTS holds the four value lists (tax_documents.form = services/tax-documents.FORMS, pinned); the CREATE TABLEs interpolate them; syncInListChecks (run in the migration after webhook_events) reads each stored <table>_<column>_check through pg_get_constraintdef and, only when its values differ, drops it and adds the code's list NOT VALID (new rows checked, old rows not re-read — a removed value can't fail the boot); exported with checkValues
F32 | teller/services/error-log.js | flushOnce calls pruneIfDue before returning on an empty buffer (still at most one query a day)
F33 | shell/landing-status.js | sharedRead(pool, label, fn): per pool (WeakMap) one read in flight shared by every visit, its result (a failure as null) kept CACHE_MS = 30 s; landingStatus reads both lines through it inside the unchanged 1.5 s budget, so a read that ran over finishes in the background and the next visit shows its line
F52 | apps/per-sistant/db.js | the pool's types (DATE_AS_STRING) return a DATE (oid 1082) as its 'YYYY-MM-DD' text and leave every other type to node-pg — pool-scoped, so Perfin's pool in the same process is unchanged
F52 | apps/per-sistant/helpers.js + callers | calDate(v) (a DATE value — text or Date — as LOCAL midnight) and ymdOf(v); recurrenceAnchorDay, nextDueAfter, rollMissedRecurring, the calendar's projection / dedupe / ICS day, complete-recurring's on-time check, Ask and Smart Suggestions' due dates (they called toISOString() on the value) and the fact_upcoming date use them

TEST RESULTS: npm test 2712/2712 (15 new); contract 272/272 (2 new); scripts/ci-migration-test.js passes (both apps' migrations twice on empty databases); mutation 7/7 red (each fix reverted alone); Playwright not run (the container's Playwright browser build isn't installed — Batch 1 follow-on).
REGRESSION RISKS:
- Every Per-sistant DATE in an API response is now "YYYY-MM-DD" instead of "YYYY-MM-DDT00:00:00.000Z". The client helpers (parseCalDate, split('T')[0], slice(0, 10)) read both; new Date(…) of either is the same instant on a UTC server.
- Server code that does new Date(row.<date column>) on a Per-sistant DATE now gets UTC midnight (a day early west of UTC); every such site found was moved to calDate / ymdOf, and a guard pins the five files.
- A landing line can be up to 30 s old (e.g. right after a rent payment).
- A CHECK replaced NOT VALID doesn't re-check old rows (intended).
INVARIANTS AT RISK:
- INV-17 (migrations in one transaction, fatal on error) — the CHECK sync runs inside the same transaction; NOT VALID keeps an old row from making the boot fatal.
- INV-147 (the landing's Perfin line from gatherDashboardSummary) — unchanged source, now cached 30 s.
- INV-133 (the error log never throws) — pruneIfDue catches; unchanged.
- INV-117 (Per-sistant DATE values rendered as their own day) — strengthened at the source.
NET SCORE: 1 production fix (F33) − 1 new failure mode (a landing line up to 30 s stale) = 0

OPERATOR ACTIONS / DEPLOY:
- None
Deploy: Platform, Shell & Auth: Render auto-deploys on push to `main`.

(Not complete in production until blocking operator actions are done AND the deploy step is confirmed.)

FOLLOW-ON ITEMS:
- Other IN-list CHECKs written inside CREATE TABLE IF NOT EXISTS (e.g. merchant_rename_rules.match_type, investment_transactions, Per-sistant's tables) aren't in CHECK_LISTS yet — add a list there before changing one.
- The calendar's projection window compares local-midnight dates with new Date('YYYY-MM-01') (UTC midnight), so on a server east of UTC a projection on the 1st can be left out (pre-existing).
- Per-sistant's server still reads Perfin's DATE values (perfinPool) as Dates — routes/perfin.js and housing-due.js handle both shapes.
DOCUMENTATION UPDATES NEEDED:
- CLAUDE.md: Known Open Issues (Batch 8 done — every cycle-8 batch done; Batch 8 follow-ons), the database migration note (CHECK_LISTS / syncInListChecks), app_errors pruning wording, the landing-page paragraph (single-flight + 30 s), test counts 2712 / 145 + contract 272; a gotcha: add a value to an IN-list CHECK through CHECK_LISTS.
- apps/per-sistant/CLAUDE.md: db.js returns DATE as text (calDate / ymdOf for server code), counts + the new test file.
---END BROAD SCAN IMPLEMENTATION SUMMARY---
