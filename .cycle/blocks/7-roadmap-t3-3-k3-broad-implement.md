---BROAD SCAN IMPLEMENTATION SUMMARY---
Findings implemented: None (roadmap work, not scan findings)
New capabilities (G/ST): Roadmap T3.3 K3 — the year-end tax package. Two refactors make each figure have one definition (`getTaxDeductionReport`, `getHousingPayments`); new `gatherTaxPackage` with fail-soft sections, a STORE-only ZIP writer, the summary PDF and `GET /api/tax/package?year=&format=json|pdf|zip`. The /tax page is K4.
Files modified:
- teller/services/financial-queries.js
- teller/routes/settings.js
- teller/routes/housing.js
- teller/routes/tax.js
- teller/services/tax-package.js (new)
- teller/services/zip-store.js (new)
- tests/roadmap-t3-3-k3.test.js (new)
- tests/contract/tax-package.contract.test.js (new)
- CLAUDE.md
- README.md
- .cycle/STATE.md
- .cycle/plan-t3-3-tax-package.md

CHANGES:
K3 | teller/services/financial-queries.js | New `getTaxDeductionReport(pool, year)`. It holds the deduction rows moved verbatim out of GET /api/export/tax-report:
  - `getTaxDeductionTransactions`, annotated by the tax_deductions merchant notes (an annotation read failing leaves the rows unannotated, as before);
  - sorted by category, then date.
K3 | teller/routes/settings.js | GET /api/export/tax-report reads `getTaxDeductionReport` and builds its CSV with `tax-package.taxReportCsv`. JSON and PDF code is unchanged. CSV and JSON were checked byte-identical against snapshots taken before the change.
K3 | teller/routes/housing.js | New `getHousingPayments(year, db)`: `{ year, payee, total, payments }`, with the payee taken from config first, as before; `getConfig` now reads through the same `db`. New `housingPaymentsCsv`. GET /api/housing/export calls both, and its CSV and JSON are byte-identical. Both helpers are exported after `module.exports = router` (INV-19).
K3 | teller/services/zip-store.js | New: a STORE-only ZIP writer, no dependency.
  - Table-driven `crc32`, not `zlib.crc32`.
  - `createZip([{ name, data }], { date })`: local headers, central directory and end record.
  - DOS time is taken from the date's UTC fields.
  - Names must be printable-ASCII relative paths: no "..", no leading "/", no backslash, no duplicates.
  - No ZIP64: a file or archive over 4 GB, or more than 65535 entries, throws.
K3 | teller/services/tax-package.js | New `gatherTaxPackage(pool, year, deps)`, built from the shared definitions:
  - getIncomeForYear;
  - getInvestmentTaxData, read once for three sections;
  - getTaxDeductionReport;
  - getHousingPayments;
  - listTaxDocuments.
  Sections and fail-soft behaviour:
  - Sections: `overview`, `income`, `investment_income`, `realized_gains` (coverage counts), `retirement`, `deductions` (by category, total), `rent_paid`, `documents` (state counts), `notes` (fixed caveats, the disclaimer first).
  - A section whose read fails returns `{ ok: false, error: <fixed sentence> }` and the others still render; `overview.sections_failed` names the failed ones.
  - A synchronous throw in a reader is contained.
  Downloads:
  - A CSV per section through csvText / csvDate. `taxReportCsv` IS the tax-report CSV, and `rent_paid.csv` is the landlord CSV. An unknown basis is a blank cell, never 0.00. A failed section's CSV holds its sentence.
  - `renderPackagePdf` (pdfkit → Buffer): a bookmark per section, the disclaimer on the first and last page, at most 200 rows per section.
  - `buildPackageZip`: summary.pdf, seven CSVs and package.json.
  - No AI.
K3 | teller/routes/tax.js | New GET /api/tax/package:
  - the year rule and an unknown format are 400s before any read;
  - JSON by default;
  - PDF and ZIP are attachments named `perfin_tax_package_<year>.<ext>`, sent with Cache-Control no-store;
  - an unexpected failure returns the fixed 500 "Could not build the tax package."
K3 | tests/roadmap-t3-3-k3.test.js | 23 tests:
  - crc32 against the standard vectors plus a bitwise second implementation;
  - the ZIP read back by a parser written in the test (each local header against its central record, the end record, every CRC, names, bytes, DOS date / time incl. a forced west-of-UTC zone) and its name refusals;
  - both exports byte-identical to their pre-refactor snapshots;
  - getTaxDeductionReport with a failing annotation read;
  - getHousingPayments' payee order;
  - gatherTaxPackage: every section, each failing reader isolated with its sentence and never the error text, the year rule, and the real readers over a SQL-routed fake pool;
  - every CSV, including the formula guard in five sections;
  - the PDF: bookmarks, the disclaimer on the first and last page, a failed section's sentence;
  - the ZIP's nine files;
  - the route's 400s, types, names and 500.
K3 | tests/contract/tax-package.contract.test.js | 4 tests on real rows:
  - deductions equal /api/export/tax-report?format=json to the cent, and the ZIP's deductions.csv is that export's CSV;
  - rent paid equals /api/housing/export?format=json, and rent_paid.csv is its CSV;
  - income equals getIncomeForYear; the FIFO sale, the qualified dividend and the checklist come through;
  - an empty year renders every section.
K3 | CLAUDE.md, README.md | Documented:
  - Architecture (tax-package.js, zip-store.js, the routes/tax.js package route, getTaxDeductionReport, getHousingPayments);
  - Features (the tax package; the deduction report's shared definition);
  - Commands (GET /api/tax/package; the tax-report note);
  - Subsystems (tax-package under Financial Analytics, zip-store under Sheets & External Export);
  - test descriptions and counts (2353 / 123 / Perfin 1695; contract 249);
  - Known Open Issues (K3 shipped + follow-ons).
  README: a Year-End Tax Package section, the API row and the test paragraph.

TEST RESULTS:
- npm test 2353/2353 (23 new).
- Contract 249/249 (4 new).
- No migration and no page changed in K3, so the migration test and Playwright were not run.
- Mutation checks: 28/28 caught. The first run left 3 survivors, each caught after a test was added:
  - getHours vs getUTCHours (a forced-TZ test);
  - the annotation read's fail-soft;
  - the configured payee winning over a payment's.
- Mutants covered:
  - CRC polynomial / final XOR;
  - the local CRC;
  - the local-header offset;
  - the central directory offset;
  - the name check;
  - duplicates;
  - the error CSV unguarded;
  - a blank basis printed as 0.00;
  - the error text leaked;
  - a synchronous investment throw;
  - category totals;
  - rent total rounding;
  - sections_failed;
  - bookmarks;
  - the last-page disclaimer;
  - the deductions merchant unguarded;
  - the corporate-action flag;
  - rent rows dropped;
  - documents without today;
  - the format 400;
  - the content type;
  - the 500 text;
  - the deduction sort;
  - the housing year filter.
REGRESSION RISKS:
- `/api/export/tax-report` and `/api/housing/export` now go through shared helpers. Byte-identical CSV and JSON were verified with unit snapshots and on real Postgres. The PDF paths changed only where their rows come from.
- `getConfig(db)` in the housing export now reads through the passed pool; in production that is the same pool.
- A ZIP or PDF is built in memory per request. It is a few hundred KB, behind the shell gate, with no schedule.
INVARIANTS AT RISK: None.
- INV-83: every package CSV text cell goes through csvText (tested in five sections).
- INV-48 / INV-110: income comes from getIncomeForYear and nothing is re-inlined.
- INV-19: the housing helpers are attached after `module.exports = router`.
- INV-106: no new bare catch in server code.
- INV-121: the timezone and canonical-helper scans pass.
- INV-146 (K4 will add it) holds already: one definition per figure, nothing stored, no AI.
NET SCORE: 0 production fixes − 0 new failure modes = 0 (new capability)

OPERATOR ACTIONS / DEPLOY:
- None. | BLOCKS DEPLOY: N
Deploy: Render auto-deploys on push to `main` (Financial Analytics / Sheets & External Export ship with the main deploy); no Apps Script change.

(Not complete in production until blocking operator actions are done AND
the deploy step is confirmed.)

FOLLOW-ON ITEMS:
- Nothing links to the package yet; K4's /tax page will.
- The PDF lists at most 200 rows per section; the CSVs have them all.
- The PDF and ZIP are built in memory on each request.
- The ZIP's timestamp is the request time in UTC.
- package.json carries the whole package, merchant names included. It sits behind the shell gate like every export.

DOCUMENTATION UPDATES NEEDED:
- None (done in this batch)
---END BROAD SCAN IMPLEMENTATION SUMMARY---
