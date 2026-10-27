---BROAD SCAN IMPLEMENTATION SUMMARY---
Findings implemented: None (roadmap work, not scan findings)
New capabilities (G/ST): Roadmap T3.3 K4 — the Tax page (/tax) and the T3.3 close-out. The page shows a year's package as section cards with CSV links, the PDF / ZIP downloads and the documents checklist. It is linked from Settings and, January to April only, from the dashboard. The package route gains a per-section CSV. INV-146 added. T3.3 is DONE.
Files modified:
- teller/pages/tax.js (new)
- teller/views/tax.ejs (new)
- teller/public/tax-page.js (new)
- teller/server.js
- teller/routes/tax.js
- teller/public/perfin-shared.js
- teller/views/dashboard.ejs
- teller/views/settings.ejs
- tests/roadmap-t3-3-k4.test.js (new)
- tests/roadmap-t3-3-k3.test.js
- tests/scan-sept-batch13.test.js
- e2e/seed.js
- e2e/pages.spec.js
- CLAUDE.md
- README.md
- .cycle/STATE.md
- .cycle/plan-t3-3-tax-package.md

CHANGES:
K4 | teller/pages/tax.js, teller/server.js | New GET /tax rendering views/tax.ejs. It is mounted after the housing page.
K4 | teller/views/tax.ejs | The page markup:
  - a labelled year select;
  - Download PDF / ZIP links;
  - the disclaimer;
  - the section cards' container (aria-live);
  - `<section id="documents">`, the target of the linked task's /tax#documents: "Suggest from my data", a labelled Form + Issuer add form, and the list.
  The page CSS is in the head partial's extraStyles, using defined tokens only. It loads public/tax-page.js through the mount base, after the foot (perfin-shared.js).
K4 | teller/public/tax-page.js | New page script.
  - Year: ?year= when 2000..this year, else taxSeason. The year options run this year back 7, plus an older selected year. The URL and the downloads follow the select.
  - GET /api/tax/package renders an overview card plus a card per section with its totals. Each card has a CSV link (format=csv&section= through withBase). A failed section shows its fixed sentence and no CSV link. All text goes through esc().
  - GET /api/tax/documents renders the checklist:
    - Mark received / Not received;
    - Dismiss / Restore;
    - a notes input + Save notes;
    - Delete, only on a manual row (data-e2e-skip, after a confirm).
    Every control is aria-labelled with its form and issuer.
  - Add form and Suggest.
  - Every write goes through writeOk and reloads only on success.
  - A failed load shows a message in place of "Loading…". A load for an older year never overwrites a newer one.
  - window.TaxPage is exposed for tests.
K4 | teller/public/perfin-shared.js | New `taxSeason(today)` → { year, season }: last year from January to April, else this year. It is the one rule for the page default and the dashboard link.
K4 | teller/views/dashboard.ejs | A hidden "Tax season: your <year> tax package is ready to review →" link above the sync strip. Its script shows it from January to April only, pointing at /tax?year=<last year> through the mount base.
K4 | teller/views/settings.ejs | Data & Exports gains a "Year-End Tax Package" row with "Open the Tax page", next to the existing Tax Report download.
K4 | teller/routes/tax.js | GET /api/tax/package takes format=csv&section=<deductions|income|investment_income|realized_gains|retirement|rent_paid|documents>.
  - It serves that section's CSV, the same file the ZIP holds.
  - The response is text/csv, perfin_tax_<section>_<year>.csv, no-store.
  - An unknown or missing section is a 400 before any read. The format error now lists csv.
K4 | tests/roadmap-t3-3-k4.test.js | 16 tests:
  - taxSeason in a vm;
  - tax-page.js in a vm over a fake DOM: the default year, ?year=, downloads, section cards and CSV links, a failed section, escaping, checklist labels, Delete only on a manual row, every write through writeOk, a refused write not reloading, delegation, failed loads, a stale load;
  - the dashboard link in a vm;
  - the Settings link, the view, the page route and mount;
  - the section CSV equal to the ZIP's file.
K4 | tests/roadmap-t3-3-k3.test.js, tests/scan-sept-batch13.test.js | The K3 format-400 test updated for csv and section 400s. tax.ejs joins the IF-3 label scan.
K4 | e2e/seed.js, e2e/pages.spec.js | The seed adds a Plaid-free tax year: a payroll deposit and a pharmacy charge on an "E2E Checking" CSV account, and a 1099-NEC on the checklist. /perfin/tax joins the every-page list, which adds a load test and a click sweep. A targeted test checks:
  - every section card;
  - the income and deductions figures;
  - the seeded form;
  - a form added through the page and marked received;
  - the ZIP download (200, application/zip, "PK").
K4 | CLAUDE.md, README.md | Documented:
  - Architecture (pages/tax.js, tax.ejs, tax-page.js, taxSeason, the csv section);
  - Features (the Tax page, the checklist on it);
  - Commands (GET /tax, format=csv&section);
  - the e2e description;
  - test counts (2370 / 124 / Perfin 1712; contract 249; Playwright 66);
  - INV-146;
  - Known Open Issues (T3.3 DONE + K4 follow-ons).
  README: the Tax page and the seed.

TEST RESULTS:
- npm test 2370/2370 (17 new: 16 K4 + the tax.ejs label scan case).
- Contract 249/249.
- Playwright 66/66 (3 new: /perfin/tax load + click sweep, and the Tax page test).
- Mutation checks 15/15 caught:
  - the season months;
  - the season year;
  - the ?year= upper bound;
  - a CSV link on a failed section;
  - a write reloading without writeOk;
  - the stale-load guard;
  - Delete on a suggested row;
  - the delete confirm;
  - the issuer cleared;
  - withBase dropped;
  - a failed package load rendered;
  - esc dropped;
  - the section 400;
  - the dashboard link out of season;
  - the year select's label.
- No migration in K4, so no migration test was run.
REGRESSION RISKS:
- GET /api/tax/package's format=csv was a 400 in K3 and is now served with a section. The format error text changed ("json, pdf, zip or csv"). Nothing outside the K3 test read it.
- The dashboard gains a hidden link and one small script block. It stays hidden outside January–April and when perfin-shared.js lacks taxSeason.
- The e2e seed adds a $2,000 payroll deposit and a $42.10 pharmacy charge on a new CSV account. Pages that sum income or spending show them; no other e2e test asserts those totals.
INVARIANTS AT RISK: None.
- INV-146 (new) holds.
- INV-89: the page's writes go through writeOk.
- INV-83: the section CSV is the guarded packageCsvFiles output.
- INV-61: apiFetch is used for every read and write.
- INV-95: the root-relative navigation guard passes (links through withBase / <%= basePath %>).
- IF-3 / INV-90: tax.ejs is label-scanned; there is no dialog.
- INV-130: the Delete control is data-e2e-skip.
- INV-129 doesn't apply (Perfin, not Per-sistant).
NET SCORE: 0 production fixes − 0 new failure modes = 0 (new capability)

OPERATOR ACTIONS / DEPLOY:
- None. | BLOCKS DEPLOY: N
Deploy: Render auto-deploys on push to `main` (Financial Analytics / Web UI ship with the main deploy); no Apps Script change.

(Not complete in production until blocking operator actions are done AND
the deploy step is confirmed.)

FOLLOW-ON ITEMS:
- The page's default year follows the browser's date, not APP_TIMEZONE (as the Budgets page does).
- Each checklist write reloads the whole package (a few queries).
- There is no expected-by date editor on the page; the API takes one.
- Cards list at most eight sources, distributions or entries; the CSVs have them all.
- The e2e click sweep counts controls on load, so it sees only the seeded checklist rows.
- The top nav has no Tax link, by design (decision 10).

DOCUMENTATION UPDATES NEEDED:
- None (done in this batch)
---END BROAD SCAN IMPLEMENTATION SUMMARY---
