# Roadmap T3.3 — Year-end tax package (plan, 2026-10-26)

Goal: one place, per calendar year, that gathers everything a tax return needs from
Perfin's data:
- what was spent on likely deductions;
- what came in (pay, bank interest, investment income);
- approximate realized gains;
- rent paid;
- which tax forms have arrived.

It downloads as one bundle for the user or an accountant.

The roadmap item (Oct 22 `/roadmap`, Tier 3) reads: "One bundle per year: the deduction
report, the landlord export, an income summary, charitable receipts from 3.2, and investment
flows and cost basis with approximate realized gains from Plaid investment transactions. Add a
checklist with Knowledge facts tracking which 1099s have arrived. Combines exports that already
exist. It's seasonal: aim to ship by January." Estimate: L, 2–4 weeks.

Two changes from that wording (decisions 5 and 7): the checklist lives in Perfin, not
Knowledge facts, and charitable receipts wait for 3.2.

## What exists (read for this plan)

**Deductions — `GET /api/export/tax-report?year=&format=csv|json|pdf`** (routes/settings.js)
- Computed at request time from the ledger: `getTaxDeductionTransactions(pool, year)`
  (financial-queries.js) is one row per matching transaction for the calendar year, at the
  user's share, reimbursed + pending left out, matched on the display merchant against
  `TAX_KEYWORD_GROUPS`. Groups are medical / charity / education / business / tax
  (INV-75).
- The `tax_deductions` table only annotates merchants (confirm, notes, category).
- The annotation merge, grouping and PDF are written inline in the route, so the package
  can't reuse them without copying.
- Settings has the year + format download (settings.ejs ~1264). The Sheets "Tax Deductions
  YYYY" tab mirrors the query (SX3-pinned).
- The year defaults to the APP_TIMEZONE year; `parseInt(req.query.year) || …`, so a bad
  year silently becomes this year.

**Rent paid — `GET /api/housing/export?year=&format=csv|pdf|json`** (routes/housing.js)
- The year's `payee_payments` with memos and covered months, scoped to the configured
  payee. The query is inline in the route.

**Income — `GET /api/income-summary?months=`** (routes/spending-analytics.js)
- A rolling-months window, not a calendar year. It uses `INCOME_PREDICATE_T` and
  `INCOME_AMOUNT` (a deposit on a shared account at the user's share, cycle-7 F37).
- Sources are grouped by `COALESCE(merchant_name, name)`.
- There is no year-scoped income helper. `getMonthlyIncome(pool, months)` is window-based
  too.
- Plaid rows carry `personal_finance_category` (INCOME_WAGES, INCOME_INTEREST_EARNED,
  INCOME_DIVIDENDS, …); Teller / CSV rows don't.

**Investments**
- `syncAllPlaidInvestmentFlows` (routes/investment-performance.js) calls
  `investmentsTransactionsGet` for the trailing 730 days and keeps only external cash flows
  (`classifyPlaidFlow`) in `investment_flows`.
- **Buys, sells, dividends, interest, capital-gain distributions, fees, tax withheld and
  corporate actions are read and thrown away.** Nothing stores them.
- Plaid's `amount` sign is positive when cash is debited (a buy), negative when credited (a
  sale). `fees` is the combined fees. Types are buy / sell / cancel / cash / fee /
  transfer, with ~50 subtypes (dividend, qualified dividend, interest, long-term capital
  gain, dividend reinvestment, split, merger, spin off, send, …) — checked against the SDK
  types in plaid@41.4.0.
- `investment_holdings` holds today's positions with a nullable `cost_basis` (BSI-5). It
  has no lots and no history.
- `investment_accounts.account_type` is Plaid's subtype (brokerage, ira, roth, 401k, hsa,
  529, …). Retirement accounts aren't taxable year by year.
- Teller-linked investment accounts expose no transactions; manual ones have only manual
  flows.

**Tasks** — the linked-task runner (`teller/services/linked-tasks.js`, T2.4) reconciles
`perfin:<kind>:<id>` tasks into Per-sistant. Its sources are still_charging, housing,
utility_amount and bills, and a new source is one entry in `SOURCES`.

**Knowledge facts** (Per-sistant `facts`) are ingested from the Obsidian vault (read-only
sync). Writing one means a capture-to-vault commit with the write-scoped token.

**Files** — `pdfkit` is a dependency. There is no zip library. Node is 22 in CI, the
Dockerfile uses node:20-alpine, and Render follows `engines: >=18`.

## Decisions (to accept with /broad-implement K1)

**1. The tax year is the calendar year, given explicitly.**
- `year` must be an integer from 2000 to the current APP_TIMEZONE year; anything else is a
  400 on every new route. This replaces the silent fallback for the new routes only; the
  existing tax-report route keeps its behaviour.
- Dates are DATE columns compared with `'YYYY-01-01'` and `'YYYY+1-01-01'`, so there is no
  timezone shift.

**2. Store every Plaid investment transaction.**
- A new `investment_transactions` table, written by the SAME `investmentsTransactionsGet`
  pages the flow sync already reads (no extra Plaid call).
- Columns: `plaid_investment_transaction_id` UNIQUE, `investment_account_id` (→
  investment_accounts.id), date, type, subtype, security_id, ticker, security_name,
  security_type (from the response's `securities`), quantity, price, amount, fees, name,
  cancel_transaction_id.
- Upserted ON CONFLICT DO UPDATE (Plaid can correct a row). The flows table is unchanged.
- Rows outside Plaid's 24-month window stay, so history grows from now on. That matters
  for gains next year.
- reset-fresh: WIPE_TABLES (like transactions).

**3. Realized gains: FIFO over the stored lots, labelled approximate.**
- A pure `realizedGains(txns, { year })` per (account, security), oldest first.
- Lots:
  - a buy (incl. buy to cover and dividend / capital-gain reinvestment) adds a lot at cost
    = `amount` (fees included, Plaid's sign);
  - an in-kind transfer in adds a lot with an UNKNOWN cost;
  - a sell takes shares FIFO;
  - a send / transfer out removes shares FIFO without a sale.
- A sale inside the year reports: date, account, security, quantity, proceeds
  (`-amount`), cost basis, gain, and term (short ≤ 1 year / long / mixed / unknown) from
  the lot dates.
- Shares sold beyond the known lots, or from an unknown-cost lot, make the basis and gain
  **null** — never 0 (the BSI-5 rule) — and the sale is marked `basis_coverage: partial |
  none`.
- A security with a split, merger, spin off or stock distribution in the history is marked
  `corporate_action: true` and its gains "verify against your 1099-B". Lots aren't
  adjusted.
- Cancelled rows (`type cancel`, or a row named by another's `cancel_transaction_id`) are
  dropped.
- FIFO is the IRS default for shares. A fund held on average cost will differ: say so.
  The broker's 1099-B is authoritative and the package says that on every page that shows
  gains.

**4. Retirement and other tax-advantaged accounts are shown separately.**
- An account whose `account_type` is in a `TAX_ADVANTAGED` list (ira, roth, roth 401k,
  401k, 403b, 457b, sep ira, simple ira, hsa, 529, pension, retirement, keogh, …) is left
  out of gains and investment income.
- Its withdrawals / distributions are listed (a 1099-R may come).
- The list is one exported constant, and the account type is shown next to each account.

**5. The documents checklist lives in Perfin, not Knowledge facts.**
- Knowledge facts come from the vault through a read-only sync. A checklist that changes
  every few days would mean a vault commit per tick and a reindex to see it.
- New table `tax_documents`: `tax_year`, `form` (CHECK W-2 / 1099-INT / 1099-DIV / 1099-B
  / 1099-R / 1099-NEC / 1099-MISC / 1099-K / 1099-G / 1098 / 1098-E / 1098-T / 1095 /
  other), `issuer`, `expected_by` DATE, `received_at`, `dismissed_at`, `origin`
  (suggested / manual), `notes`. UNIQUE (`tax_year`, `form`, LOWER(`issuer`)).
- **Suggestions** are derived from the year's data and upserted ON CONFLICT DO NOTHING, so
  a dismissed or received row stays as the user left it:
  - W-2 per payroll source (Plaid INCOME_WAGES or the payroll keywords);
  - 1099-INT per institution with ≥ $10 of interest;
  - 1099-DIV per taxable brokerage with ≥ $10 of dividends;
  - 1099-B per taxable brokerage with a sale;
  - 1099-R per tax-advantaged account with a distribution;
  - 1098 / 1098-E / 1098-T when the deduction report has mortgage-interest /
    student-loan-interest / tuition rows.
- Expected-by dates: Jan 31 of the next year, Feb 15 for 1099-B. These are the usual
  deadlines, labelled "usually arrives by".
- CRUD: `GET /api/tax/documents?year=`, `POST` (manual), `PATCH /:id` (received / dismiss /
  notes / expected_by), `DELETE /:id` (manual rows only; a suggested row is dismissed
  instead, so it isn't re-suggested), `POST /api/tax/documents/suggest?year=`.

**6. Linked tasks pick up missing forms.**
- New linked-task source `tax_documents`, default ON. The whole feature stays behind
  `linked_tasks_enabled`, which is off by default.
- An open checklist row (not received, not dismissed) whose `expected_by` has passed opens
  "Find your <year> <form> from <issuer>" (`perfin:tax-doc:<id>`, url `/tax#documents`).
- Marking it received or dismissed closes the task.

**7. Charitable receipts wait for 3.2.**
- The package's charity section is the deduction report's charity group (transactions).
- When 3.2 stores receipts, each one attaches to its transaction there. Out of scope here.

**8. The package is computed on request, never stored.**
- `services/tax-package.js` `gatherTaxPackage(pool, year)` returns one JSON object:
  - `overview`;
  - `income` (by source and month, split into wages / interest / dividends / other where
    the provider says so, at the user's share — the app's rule, stated);
  - `investment_income` (dividends — qualified / non-qualified, interest, capital-gain
    distributions, foreign tax withheld — per taxable account);
  - `realized_gains` (sales, short / long totals, coverage);
  - `retirement` (distributions);
  - `deductions` (the existing report);
  - `rent_paid` (the landlord export's rows);
  - `documents` (the checklist);
  - `notes` (the caveats).
- Each section is fail-soft: one failing query marks that section `error` (a fixed
  sentence) and the rest still render.
- **One definition per figure:**
  - the deduction rows move into `financial-queries.getTaxDeductionReport(pool, year)`,
    used by both `/api/export/tax-report` and the package;
  - the housing payments into `housing.getHousingPayments(pool, year)`, used by the export
    and the package;
  - income-for-a-year into `financial-queries.getIncomeForYear(pool, year)` on
    `INCOME_PREDICATE` + `INCOME_AMOUNT`.
  - No route re-derives any of them.

**9. Downloads.**
- `GET /api/tax/package?year=&format=json|pdf|zip`.
  - PDF: one document, a section per heading, the disclaimer on the first and last page.
  - ZIP: `summary.pdf` plus a CSV per section (`deductions.csv`, `income.csv`,
    `investment_income.csv`, `realized_gains.csv`, `retirement.csv`, `rent_paid.csv`,
    `documents.csv`) plus `package.json`.
- CSV text cells go through `csvText` (formula guard, INV-83) and dates through `csvDate`.
- The ZIP is written by a small `services/zip-store.js`: the STORE method (no
  compression), a table CRC-32 (not `zlib.crc32`, which Node 20 / 18 may lack) and ASCII
  names. It needs no new dependency.

**10. The Tax page.**
- `/tax` with a year select (defaults to last year from January to April, else this year).
- One card per section with its totals and a CSV link.
- The documents checklist (`#documents`, Received / Dismiss / notes, a manual add form,
  "Suggest from my data").
- Download buttons: PDF, ZIP.
- Linked from Settings → Data & Exports (beside the existing tax-report download) and from
  the dashboard in January–April only. The top nav already wraps (F94), so it gets no new
  link.
- Labels per IF-3, writes through `writeOk`, dialogs through `openDialog`.

**11. No AI anywhere in T3.3** — no cap charge, nothing sent to a model.

## Batches (broad-implement sized)

| # | Batch | Status |
|---|---|---|
| K1 | **Investment transactions + realized gains + investment income (server).**<br>• Migration: `investment_transactions` (decision 2; idempotent, run twice in the migration test); reset-fresh WIPE_TABLES.<br>• The flow sync writes every investment transaction from the pages it already reads (one upsert per row, the securities map from the same response); the flows logic is unchanged; a transaction for an account not in `investment_accounts` is skipped as today.<br>• `services/tax-investments.js`: `TAX_ADVANTAGED`; pure `realizedGains(txns, { year })` (decision 3); `getInvestmentTaxData(pool, year)` → `{ realized_gains, investment_income, retirement }` reading the table.<br>• Tests:<br>&nbsp;&nbsp;– FIFO over canned histories: a partial lot, a short / long / mixed term, a reinvested dividend lot;<br>&nbsp;&nbsp;– a sale beyond known lots (null basis, partial coverage), an unknown-cost transfer-in lot;<br>&nbsp;&nbsp;– a cancel pair dropped, a split flagged, a year filter, a retirement account left out;<br>&nbsp;&nbsp;– the sync writing buys / sells / dividends while flows stay as before, the securities join, a re-sync not duplicating.<br>• Contract: a Plaid flow sync over a stubbed client stores the transactions once; `getInvestmentTaxData` on real rows (gains, dividends, a 401k withdrawal under retirement). | DONE (2026-10-26 — block `.cycle/blocks/7-roadmap-t3-3-k1-broad-implement.md`) |
| K2 | **The documents checklist + linked tasks (server).**<br>• Migration: `tax_documents` (decision 5); reset-fresh WIPE_TABLES.<br>• `services/tax-documents.js`: `suggestTaxDocuments(pool, year)` (the rules in decision 5 over the K1 data, `getIncomeForYear` and the deduction report — added here to financial-queries), `listTaxDocuments`.<br>• Routes: GET / POST / PATCH / DELETE `/api/tax/documents`, `POST /api/tax/documents/suggest`; the year rule (decision 1); 400 / 404s; a suggested row can't be deleted (409 → dismiss).<br>• Linked-task source `tax_documents` (decision 6) in `computeLinkedTasks`; the Settings source checkbox.<br>• Tests: each suggestion rule, a dismissed / received row never resurrected, the route validation, the linked-task desired set (past `expected_by` only, closed once received).<br>• Contract: suggestions on real rows (a payroll stream → W-2, interest → 1099-INT, a K1 sale → 1099-B), dismiss + re-suggest, the linked-task round trip through both databases. | DONE (2026-10-26 — block `.cycle/blocks/7-roadmap-t3-3-k2-broad-implement.md`) |
| K3 | **The package: one definition per figure + downloads.**<br>• Refactors (decision 8): `getTaxDeductionReport` (the existing route calls it; its CSV / JSON / PDF unchanged byte for byte), `getHousingPayments` (the landlord export calls it).<br>• `services/tax-package.js` `gatherTaxPackage` (fail-soft sections); `services/zip-store.js`; the PDF renderer.<br>• `GET /api/tax/package?year=&format=json|pdf|zip` (decision 9).<br>• Tests:<br>&nbsp;&nbsp;– the package over a fake pool: every section, a failing section isolated with a fixed sentence;<br>&nbsp;&nbsp;– the existing tax-report and housing exports unchanged (snapshot of their CSV / JSON);<br>&nbsp;&nbsp;– the ZIP read back (local headers, central directory, CRC-32 against a known vector, file names, contents);<br>&nbsp;&nbsp;– the PDF starting `%PDF` with the section titles;<br>&nbsp;&nbsp;– the CSV formula guard on a merchant `=HYPERLINK(…)`;<br>&nbsp;&nbsp;– the year 400s.<br>• Contract: `gatherTaxPackage` on real rows agrees with `/api/export/tax-report?format=json` and `/api/housing/export?format=json` to the cent; the ZIP's `deductions.csv` equals the tax-report CSV's rows. | PLANNED |
| K4 | **The Tax page + close-out.**<br>• `/tax` (page + view + script, decision 10); the Settings link; the January–April dashboard link; the sweep-safe controls (Dismiss is a write but not destructive — Delete stays `data-e2e-skip`).<br>• Playwright: the seed adds a Plaid-free year (deductions, income, a manual tax document); a targeted test opens `/tax`, checks the sections, marks a document received and downloads the ZIP (200, `application/zip`).<br>• INV-146; CLAUDE.md (Features, Database, Commands, Subsystems — the new services under Financial Analytics, Known Open Issues: T3.3 DONE with its follow-ons); README; STATE.<br>• Tests: the page script in a vm (year default by month, sections from a canned package, the checklist writes through `writeOk`, a failed load, labels), the dashboard link only January–April. | PLANNED |

Four batches, each one /broad-implement session, in order K1 → K2 → K3 → K4 (K2 reads K1's
data; K3 reads both; K4 shows everything). Each batch runs:
- npm test;
- the contract suite;
- the migration test (K1, K2);
- Playwright (K4, and K3 if a page changed);
- mutation checks.

Each folds in the docs for what it adds.

## New invariant (K4)
INV-146 | The year-end tax package is computed on request from the ledger and never stored:
- each figure has one definition, shared with the screen or export that already shows it:
  - deductions — `getTaxDeductionReport`, also behind `/api/export/tax-report`;
  - income — `getIncomeForYear` on INCOME_PREDICATE / INCOME_AMOUNT;
  - rent paid — `getHousingPayments`, also behind the landlord export;
  - investments — `investment_transactions`;
- realized gains are FIFO over stored lots and labelled approximate. A sale not fully
  covered by known-cost lots has a NULL basis and gain, never 0;
- tax-advantaged accounts are kept out of gains and investment income;
- a suggested document the user dismissed or received is never re-suggested;
- nothing in T3.3 is sent to an AI model;
- every CSV text cell is formula-guarded.

Subsystem: Financial Analytics / Sheets & External Export.
Verify: the K1–K4 test files + contract `tax-package` / `tax-investments`.

## Trade-offs to state in the docs
- **Realized gains are an estimate.**
  - FIFO over the lots Perfin has seen: Plaid serves 24 months, and the store keeps rows
    from now on.
  - Shares bought earlier, transferred in, or held at average cost give a null or different
    basis. The broker's 1099-B is authoritative.
  - Corporate actions aren't applied to lots; the security is flagged instead.
  - Wash sales aren't detected.
- **Income is the app's figure:**
  - a deposit on a shared account at the user's share;
  - classification by keyword / provider category.
  - It cross-checks a W-2 / 1099; it doesn't replace them.
- **Only Plaid-linked investment accounts have transactions.** Teller-linked and manual
  investment accounts show balances only.
- **Deductions are keyword matches** (the existing report), not a tax determination. The
  package says "for informational purposes only — consult a tax professional" on its first
  and last page.
- The documents checklist's dates are the usual deadlines, not guarantees.
- The ZIP isn't compressed (CSV + one PDF — a few hundred KB).

## Out of scope
- Receipts and charitable-receipt images (3.2).
- Filing, tax estimates, brackets, tax-loss harvesting, wash-sale detection, state forms.
- Lot-level cost basis from the broker (Plaid has no lot endpoint) and a cost-method
  setting.
- A Sheets tab for the package (the existing "Tax Deductions YYYY" tab stays).
- Writing the checklist into Knowledge facts.
