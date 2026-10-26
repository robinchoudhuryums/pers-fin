---BROAD SCAN IMPLEMENTATION SUMMARY---
Findings implemented: None (roadmap work, not scan findings)
New capabilities (G/ST): Roadmap T3.3 K2 — the tax documents checklist (table, suggestions from the year's data, CRUD routes) and the `tax_documents` linked-task source (server + its Settings checkbox; the /tax page is K4)
Files modified:
- teller/services/database.js
- scripts/reset-fresh.js
- teller/services/financial-queries.js
- teller/services/tax-documents.js (new)
- teller/routes/tax.js (new)
- teller/server.js
- teller/services/linked-tasks.js
- teller/routes/settings.js
- teller/views/settings.ejs
- tests/roadmap-t3-3-k2.test.js (new)
- tests/contract/tax-documents.contract.test.js (new)
- tests/roadmap-t2-4-x2a.test.js
- tests/roadmap-t2-4-x2b.test.js
- tests/contract/linked-tasks-perfin.contract.test.js
- CLAUDE.md
- README.md
- .cycle/STATE.md
- .cycle/plan-t3-3-tax-package.md

CHANGES:
K2 | teller/services/database.js | New table `tax_documents`:
  - `tax_year` (CHECK 2000-9999);
  - `form` (CHECK the 14-form list);
  - `issuer` (default '');
  - `expected_by` DATE, `received_at` DATE, `dismissed_at`;
  - `origin` (CHECK suggested / manual);
  - `notes`, timestamps.
  Plus UNIQUE INDEX (tax_year, form, LOWER(issuer)). Idempotent; the migration test ran twice.
K2 | scripts/reset-fresh.js | `tax_documents` in WIPE_TABLES.
K2 | teller/services/financial-queries.js | `getIncomeForYear(pool, year)`:
  - one query over the calendar year's DATE bounds on `incomePredicate("t")` + `INCOME_AMOUNT` (a shared account at the user's share);
  - grouped by display source, kind (Plaid's detailed PFC INCOME_WAGES / INTEREST_EARNED / DIVIDENDS, else the description: interest, dividend, then the payroll words), institution (Teller / Plaid item / manual name) and month;
  - aggregated into `{ year, total, by_kind, by_source, by_month }`.
  K3's package will use it too.
K2 | teller/services/tax-documents.js | New module.
  - `FORMS`, `parseTaxYear` (2000..this APP_TIMEZONE year), `expectedBy` (Jan 31; Feb 15 for a 1099-B).
  - `computeSuggestions`, with each source isolated and a failure reported as a fixed sentence:
    - a W-2 per payroll source;
    - a 1099-INT per institution at ≥ $10 — the larger of bank and brokerage interest, never their sum;
    - a 1099-DIV at ≥ $10 of dividends + capital-gain distributions;
    - a 1099-B per brokerage with a sale;
    - a 1099-R per retirement distribution;
    - a 1098 / 1098-E / 1098-T from the deduction rows;
    - one per form + issuer, case-insensitively.
  - `suggestTaxDocuments`: INSERT … ON CONFLICT (tax_year, form, (LOWER(issuer))) DO NOTHING; counts only new rows; returns the reasons without storing them.
  - `listTaxDocuments`: form order, each row's state received / dismissed / overdue / waiting.
  - No AI.
K2 | teller/routes/tax.js, teller/server.js | New routes, mounted after housing:
  - GET / POST `/api/tax/documents`;
  - PATCH / DELETE `/api/tax/documents/:id`;
  - POST `/api/tax/documents/suggest`.
  Validation and behaviour:
  - the year rule is a 400 before any read;
  - form / issuer / expected_by / notes are validated;
  - strict booleans; received stamps today's APP_TIMEZONE date;
  - a duplicate (any case) is a 409;
  - a suggested row's DELETE is a 409 { reason: "suggested" } — dismiss it instead;
  - fixed-sentence 500s;
  - every write that changed something kicks the linked-task refresh.
K2 | teller/services/linked-tasks.js | New source `tax_documents` → kind `tax-doc`, default ON (decision 6).
  - `taxDocumentTasks`: each row not received, not dismissed and past `expected_by` gets a task — "Find your <year> <form> from <issuer>", `perfin:tax-doc:<id>`, `/tax#documents`, medium priority.
  - Marking the form received or dismissed (or deleting a manual row) drops it from the set and closes the task.
  - Per-sistant needed no change: it validates kinds by pattern.
K2 | teller/routes/settings.js, teller/views/settings.ejs | GET /api/settings returns `effectiveSources(stored)`, so the new default-on source shows as on. Before, the stored map had no key and the box would read off while the source ran. Settings → Per-sistant Tasks gains a labelled "Tax forms that haven't arrived by their usual date" checkbox, wired like the others, and the error label "Tax forms".
K2 | tests/roadmap-t3-3-k2.test.js | 24 tests: the year rule, each suggestion rule, the ON CONFLICT insert, list states (incl. a form due today still waiting), getIncomeForYear's SQL and aggregation, every route's validation / 409 / 404 / kick, the linked-task source, the Settings GET merge and checkbox, the migration's form list = FORMS, and reset-fresh.
K2 | tests/contract/tax-documents.contract.test.js | 4 tests, both databases wired as the shell does:
  - getIncomeForYear on last year's rows (by kind, a joint account at 50%);
  - Suggest adding W-2s, a 1099-INT (not the $2 credit union), a 1099-B, a 1099-R and a 1098-T;
  - a received / dismissed row unchanged by a second Suggest; 409s;
  - tasks opened per open past-due form and closed by marking received / dismissed through Perfin's route.
K2 | tests/roadmap-t2-4-x2a.test.js, tests/roadmap-t2-4-x2b.test.js, tests/contract/linked-tasks-perfin.contract.test.js | The test doubles that encoded the four-source set now carry `tax_documents`: the fake pool answers it, `ALL` pins it off where a test is about the other sources, and the defaults include it.
K2 | CLAUDE.md, README.md | Documented:
  - Architecture (tax-documents.js, routes/tax.js, getIncomeForYear, the linked-task source);
  - Features (the checklist, Per-sistant tasks);
  - Commands (the five routes, the settings note);
  - Database (tax_documents; linked_tasks_sources merging);
  - reset-fresh WIPE;
  - test descriptions and counts (2330 / 122 / Perfin 1672; contract 245);
  - Subsystems;
  - Known Open Issues (K2 shipped + follow-ons).
  README updated to match.

TEST RESULTS:
- npm test 2330/2330 (24 new).
- Contract 245/245 (4 new).
- Migration test (scripts/ci-migration-test.js) run twice: both passed.
- Playwright 63/63 (Settings with the new checkbox loads and sweeps clean).
- Mutation checks: 19/19 caught.
  - The $10 interest and dividend thresholds.
  - Max → sum of interest.
  - Wages kind.
  - The 1099-B deadline.
  - ON CONFLICT DO UPDATE.
  - The year upper bound.
  - The overdue boundary (caught after adding a due-today row).
  - Case-insensitive issuer.
  - Received / dismissed filters in the task SQL.
  - The source not run.
  - Default off.
  - The suggested-row DELETE guard.
  - Strict boolean.
  - The edit kick.
  - The duplicate 409.
  - The Settings merge.
  - INCOME_AMOUNT → raw amount.
  - The interest keyword.
- During the run, the existing x2a / x2b / linked-tasks-perfin doubles failed against the new default-on source. They were updated as part of the change; none was a production bug.
REGRESSION RISKS:
- The linked-task run now reads `tax_documents` every hour while linked tasks are on. It is one small query on a table of a few rows a year; a failure is isolated to that source.
- GET /api/settings now returns the merged sources map instead of the stored one. Every consumer treats a missing key as its default already, so the visible change is the new box reading on.
- A user with linked tasks on gets tax-form tasks without opting in (decision 6). Until K4 ships, the task's link is a 404 (`/tax#documents`); K2 and K4 are on the same branch.
INVARIANTS AT RISK: None.
- INV-59: `linked_tasks_sources` still 400s on an unknown key; `tax_documents` is a known key.
- INV-77: the linked tasks stay an away job.
- INV-81: `tax_documents` is classified.
- INV-89: the Settings write goes through writeOk via saveLinkedTasks.
- INV-110 / INV-48: `getIncomeForYear` interpolates INCOME_AMOUNT / incomePredicate — no re-inlined copy.
- INV-121: the timezone lint and canonical-helper scans pass.
NET SCORE: 0 production fixes − 0 new failure modes = 0 (new capability)

OPERATOR ACTIONS / DEPLOY:
- None. The table is created by the migration on boot. | BLOCKS DEPLOY: N
Deploy: Render auto-deploys on push to `main` (Financial Analytics ships with the main deploy); no Apps Script change.

(Not complete in production until blocking operator actions are done AND
the deploy step is confirmed.)

FOLLOW-ON ITEMS:
- The task links to `/tax#documents`, which K4 builds.
- Suggest runs only when asked (no schedule).
- A W-2 is suggested per payroll SOURCE name, so an employer whose deposits carry two names gets two.
- A bank 1099-INT and a brokerage cash sweep at the same institution can't be told apart (the larger counts).
- Suggestion reasons aren't stored.
- 1099-NEC / MISC / K / G and 1095 are manual only.

DOCUMENTATION UPDATES NEEDED:
- None (done in this batch)
---END BROAD SCAN IMPLEMENTATION SUMMARY---
