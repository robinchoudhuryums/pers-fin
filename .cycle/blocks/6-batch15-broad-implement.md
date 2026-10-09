---BROAD SCAN IMPLEMENTATION SUMMARY---
Findings implemented:
- TQ-2 — real-Postgres route contract tests (housing, financial queries, calendar, exports, settle-up, transaction writes/CSV import, Per-sistant routes) running in the CI Postgres job
- TQ-1 — the replica test files (apps/per-sistant/tests/api.test.js, tests/teller.test.js) rewritten to run the real production code; tautologies and copies deleted
- Source guards (no finding ID): no un-nonced <style> reaches Perfin's nonce-only styleSrcElem; client navigation always carries the mount base; every var(--x) is defined (Per-sistant + shell)
Files modified:
tests/contract/_setup.js (new), tests/contract/financial-queries.contract.test.js (new), tests/contract/housing-settle.contract.test.js (new), tests/contract/calendar-exports.contract.test.js (new), tests/contract/transactions.contract.test.js (new), tests/contract/persistent.contract.test.js (new), tests/scan-sept-batch15.test.js (new), tests/teller.test.js, apps/per-sistant/tests/api.test.js, package.json, .github/workflows/ci.yml
(No production code changed.)

CHANGES:
TQ-2 | tests/contract/_setup.js | CONTRACT_DATABASE_URL-gated setup: one scratch database per file (DROP … WITH (FORCE) + CREATE), env set before any app require, the app's own runMigrations, the user_settings row; perfinApp() mounts EVERY Perfin router in teller/server.js's parsed order (catches route shadowing); persistentApp(pool) builds every Per-sistant router with the same deps object and order as apps/per-sistant/server.js; suites skip without the env var
TQ-2 | tests/contract/financial-queries.contract.test.js | income predicate incl. the FAN-2 brokerage-transfer guard + the aliased predicate inside a JOIN; per-category spend with splits/reimbursed/shared split/personal_for; monthly totals; getNetWorth (loans as liabilities, phantom dedupe); getBudgetStatus + GET /api/budgets + alerts + PATCH 400; income-summary / savings-rate / cash-flow / spending-summary / spending-categories / spending-yoy; tax candidates
TQ-2 | tests/contract/housing-settle.contract.test.js | config PATCH + idempotent generation; FAN-1 obligation amount PATCH (set → unpaid, clear → pending, negative 400); payments + derived memo + ledger balance + undo + export JSON/CSV; split double-count guard; shared-settlement refunds/pending/personal_for + per-account list; PATCH personal_for; settle / get / undo
TQ-2 | tests/contract/calendar-exports.contract.test.js | manual bill validation + calendar placement + DC-3 is_paid + SXE-11 default amount + income projection; forecast + ICS feed; transactions/subscriptions CSV (ISO dates, rename, formula guard); tax report JSON/CSV; context export (loans as debt, real insight only)
TQ-2 | tests/contract/transactions.contract.test.js | bulk-category through the real mount order (DC-1) writing user_category only; PATCH user_* overrides; splits sum validation + replacement in categories; manual cash entry (manual account required, text[] category); CSV preview → import → re-import with matching counts
TQ-2 | tests/contract/persistent.contract.test.js | todo location, any-length dependency cycle, trashed blocker; recurring complete → location carried → undo once; template validation + transactional apply; note_created automation with an invalid legacy rule skipped; email PATCH recipient validation; review + iCal; Job Radar buckets/status view/company deactivate; GET /api/calendar as a TODO (pre-existing bug)
TQ-2 | package.json, .github/workflows/ci.yml | `npm run test:contract` (node --test tests/contract/*.test.js); CI `migrations` job runs it with CONTRACT_DATABASE_URL against the pgvector service after the migration test
TQ-1 | tests/teller.test.js | 13 replica tests → 7 against syncAllEnrollments (sign flip, pending skip, counterparty→description fallback, category literal), POST /api/enroll (required fields, 'Unknown' default), tellerRequest (Authorization header actually sent, via a stubbed https.request) and the TELLER_ENV export
TQ-1 | apps/per-sistant/tests/api.test.js | 231 replica/tautology tests → 51 against the real code: parseTimeExpr / parseQuickTodo / haversine / escAttr / renderMd extracted from the EMITTED client source and run in a vm; todos/emails/notes/subtasks/templates/reorder validation; contacts lookup + import; advanceRecurrence / nextDueAfter; completeRecurringTodo / skipRecurringTodo streak math + double-completion refusal; snooze; self-dependency; GET /api/todos pagination clamps + ordering; bulk / trash / links / attachments; search / review / categories; settings validation; isValidWebhookUrl / validateWebhookHeaders / webhooks route; runAutomations conditions; ai cache TTL, model ids, models PATCH, feature-off + required fields; jobs JSON parsers; middleware.setup CSRF, /api/health ok/degraded, requireAuth, the AI rate limiter. Dropped (documented in the header): object-shape tautologies, re-typed constant arrays, client-only arithmetic and "pattern" demos written inside the test
Guards | tests/scan-sept-batch15.test.js | contract wiring (script, CI step + env, area coverage, per-file skip + unique DB, route-order regexes still match both server.js files); no createElement('style') / '<style' strings in Perfin client code + nonce on any page-module <style>; root-relative navigation scanner over Perfin public JS + views (EJS scriptlets blanked) and Per-sistant pages/views with a self-test; undefined CSS vars for shell + Per-sistant. Pre-existing gaps are listed in KNOWN_GAPS with reasons — the guards fail on any new offender AND on a stale entry

TEST RESULTS: npm test 1475/1475 passed + 2 todo (Perfin 1033 — teller 7, batch15 14 — + Per-sistant 442 incl. api.test.js 51; 66 files). The count drop from 1647 is the deleted replicas (−231 −13) offset by real tests (+51 +7) and the guards (+14). Contract suite against local Postgres 16: 28 tests, 27 pass + 1 todo; without CONTRACT_DATABASE_URL every suite skips. Mutation check (in a worktree): removing the FAN-1 `::numeric` cast, swapping the categorize/subscriptions mount order (DC-1) and printing raw dates in /api/export (SXE-8) each turned contract tests red (4 failures). The 2 api.test.js todos and the 1 contract todo are pre-existing production bugs the real-code tests exposed (see follow-ons).
REGRESSION RISKS:
- The contract job adds CI time (~20–40 s) and depends on the Postgres service user being able to CREATE/DROP DATABASE (the CI image's superuser can).
- The root-relative and CSS-var guards are heuristic scanners: an unusual navigation spelling (e.g. building a page path from a variable) isn't seen, and a legitimate root-owned path outside ROOT_OWNED would need adding to the list.
- tests/teller.test.js reloads teller-api/enrollments via require.cache; it restores the originals in afterEach/after.
- No production code changed, so no runtime behaviour risk.
INVARIANTS AT RISK: None (test-only change). The guards and contract tests now actively back INV-07/08/09 (spending), INV-11/INV-12, INV-25 (wired deps), INV-69 (aliased income predicate), INV-72 (housing), INV-73 (budget status), INV-75 (tax), INV-83 (CSV formula guard) and the Batch 14 INV-91/93.
NET SCORE: production fixes 0 (test-quality batch; no production bug was live-fixed) − new failure modes 0 = 0. (It surfaced three live bugs, recorded below.)

OPERATOR ACTIONS / DEPLOY:
- None | BLOCKS DEPLOY: N
Deploy: N/A — test and CI changes only (no production code); Render's deploy from `main` is unaffected.

(Not complete in production until blocking operator actions are done AND
the deploy step is confirmed.)

FOLLOW-ON ITEMS:
- PRE-EXISTING BUG (contract test todo): apps/per-sistant/routes/calendar.js destructures `advanceRecurrence` from deps, but server.js never passes it — GET /api/calendar 500s whenever an open recurring todo exists (Calendar page + dashboard mini-calendar). Fix, then drop the `todo` flag in tests/contract/persistent.contract.test.js.
- PRE-EXISTING BUG (api.test.js todos): pages/todos-script-2.js is a template literal, so the quick-add parser's `\b` regexes reach the browser as a backspace character — no priority or date is ever detected by Quick Add. Double-escape the regexes, then drop the `todo` flags.
- PRE-EXISTING GAP (guard KNOWN_GAPS): apps/per-sistant/views/settings-patch.js compares `location.pathname !== '/settings'`, so the palette picker never appears under the shell (/per-sistant/settings).
- PRE-EXISTING GAP (guard KNOWN_GAPS): apps/per-sistant/views/js.js uses --border/--green/--surface-2/--teal/--text/--text-muted/--warm/--yellow, which the current Per-sistant CSS doesn't define (undo toast, offline banner, rendered markdown lose their colours/background).
- The old replica "Perfin URL validation" tests described a rule production never had: PATCH /api/settings stores perfin_url (and theme) unvalidated.
- The contract suite covers the Perfin areas named in the plan plus Per-sistant routes; sync engines (Teller/Plaid against a real schema), insights and Knowledge are not yet contract-tested.
DOCUMENTATION UPDATES NEEDED:
- Root CLAUDE.md: test counts (1475 / 66 files; Perfin 1033, Per-sistant 442), `npm run test:contract` in Commands, the ci.yml `migrations` job now also running the contract suite, a tests/contract entry + scan-sept-batch15 description, tests/teller.test.js now real-code, possibly a new invariant (route SQL changes keep the contract suite green; KNOWN_GAPS lists only shrink).
- apps/per-sistant/CLAUDE.md: api.test.js no longer "tests inline copies" (real-code rewrite, 51 tests), test count 442.
- README: counts + Batch 15 line; mention the contract suite.
---END BROAD SCAN IMPLEMENTATION SUMMARY---
