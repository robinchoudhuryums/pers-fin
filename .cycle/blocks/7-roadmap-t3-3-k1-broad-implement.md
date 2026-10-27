---BROAD SCAN IMPLEMENTATION SUMMARY---
Findings implemented: None (roadmap work, not scan findings)
New capabilities (G/ST): Roadmap T3.3 K1 — every Plaid investment transaction stored (investment_transactions) and the investment tax figures for a calendar year: FIFO realized gains, investment income, retirement-account distributions (server only; shown by K3 / K4)
Files modified:
- teller/services/database.js
- scripts/reset-fresh.js
- teller/routes/investment-performance.js
- teller/services/tax-investments.js (new)
- tests/roadmap-t3-3-k1.test.js (new)
- tests/contract/tax-investments.contract.test.js (new)
- CLAUDE.md
- README.md
- .cycle/STATE.md
- .cycle/plan-t3-3-tax-package.md

CHANGES:
K1 | teller/services/database.js | New table `investment_transactions` (CREATE TABLE IF NOT EXISTS) with these columns:
  - `plaid_investment_transaction_id` TEXT UNIQUE;
  - `investment_account_id` (no FK, like investment_flows);
  - `txn_date`, `type`, `subtype`;
  - `security_id`, `ticker`, `security_name`, `security_type`;
  - `quantity` / `price` NUMERIC(24,8) and `amount` / `fees` NUMERIC(18,4), in Plaid's sign;
  - `name`, `cancel_transaction_id`, timestamps.
  Plus an index on (investment_account_id, txn_date).
K1 | scripts/reset-fresh.js | `investment_transactions` added to WIPE_TABLES (re-synced from Plaid like transactions).
K1 | teller/routes/investment-performance.js | `storeInvestmentTransaction(localAccountId, t, sec)` upserts one row by the Plaid id (type and subtype lowercased, the security joined from the same response's `securities`) and returns 1 only on a genuine insert (`xmax = 0`).
  - `syncAllPlaidInvestmentFlows` stores every row of a tracked account before the unchanged flow classification, and returns `transactions_stored`.
  - A failed store is counted, logged once, and reported as one `investment_transactions_not_stored` error per Item. It never stops the flows or the `flows_synced_at` stamp.
  - Exported.
K1 | teller/services/tax-investments.js | New module.
  - `realizedGains(txns, { year })`:
    - FIFO lots per account + security, cost = the buy's |amount| (fees included);
    - a sale beyond known lots, or drawing on a transfer-in lot, has a NULL basis (never 0), with `basis_coverage` full / partial / none;
    - the term is short / long ("held more than a year") / mixed / unknown, and mixed is split pro rata in the totals;
    - cancels are dropped; split / merger / spin off / stock distribution flag the security and leave its lots alone; "sell short" is not modelled;
    - same-day buys come before sells.
  - `investmentIncome`: per taxable account — dividends with qualified separately, interest, long / short capital-gain distributions, tax withheld.
  - `retirementDistributions`: cash withdrawals / distributions from TAX_ADVANTAGED accounts.
  - `accountTaxAdvantaged`, `isLongTerm`, `validTaxYear`.
  - `getInvestmentTaxData(pool, year)`: reads every row before the year's end, so earlier buys are the lots, and keeps tax-advantaged accounts out of gains and income. Throws on an invalid year.
  - Nothing is stored and nothing is sent to AI.
K1 | tests/roadmap-t3-3-k1.test.js | 16 tests.
  - FIFO: mixed term, a partly used lot, isLongTerm edges incl. Feb 29, a reinvestment lot, beyond known lots (NULL / partial / none), a transfer in and out, a cancel pair, a split and a reverse split flagged with the lots untouched, sell short excluded, same-day ordering, per-account / per-security lots, the year filter.
  - Income and retirement totals, the tax-advantaged list, getInvestmentTaxData over a fake pool.
  - The flow sync: exact parameters, the security join, a re-sync storing 0, a store failure keeping the flows with one error.
  - The migration and reset-fresh.
K1 | tests/contract/tax-investments.contract.test.js | 3 tests on real Postgres with a stubbed Plaid client.
  - A brokerage and a 401(k): ten transactions stored once (a re-sync stores 0), the flows unchanged (the deposit in, the 401(k) withdrawal out).
  - getInvestmentTaxData: one mixed-term sale (basis 1300, long 1000 / short 100 gain); the 401(k) sale and dividend left out; qualified dividends 40, interest 2.5; the 401(k) withdrawal (600) under retirement.
  - An earlier year is empty, and an invalid year rejects.
K1 | CLAUDE.md, README.md | Documented:
  - investment-performance.js (the stored transactions) and the tax-investments.js entry;
  - the Database entry and the reset-fresh WIPE list;
  - the sync-flows command note;
  - the Financial Analytics subsystem file list;
  - test descriptions and counts (2306 / 121 / Perfin 1648; contract 241);
  - Known Open Issues: T3.3 IN PROGRESS with the K1 follow-ons.
  README updated to match.

TEST RESULTS:
- npm test 2306/2306 (16 new).
- Contract 241/241 (3 new).
- Migration test (scripts/ci-migration-test.js) run twice: both passed.
- Mutation checks: 15/15 caught. The xmax one was caught by the contract test; the unit stub can't judge SQL.
  - Flipped long-term to >=.
  - Cancels kept.
  - A known basis beyond the lots.
  - Short sales counted.
  - The corporate-action transfer skip removed.
  - A transfer-in lot at $0.
  - Same-day order.
  - Tax-advantaged income.
  - Qualified dividends.
  - Tax-advantaged gains.
  - Account type normalisation.
  - The year check.
  - The insert count (xmax).
  - The store error.
  - The type / subtype lowercasing.
- The Feb 29 anniversary line was an equivalent mutant ("02-29" already sorts between Feb 28 and Mar 1), so it was removed and the comment says why.
- Playwright not re-run: no page or client script changed.
REGRESSION RISKS:
- The flow sync now does one extra upsert per investment transaction, about 24 months per Item each run. That is more writes on the daily balance sync, holdings / investments webhook events and POST /api/plaid/sync-flows. The rows are small and idempotent.
- A store failure is now an `errors[]` entry. The webhook flows handler treats a partly failed flow sync as a failed event, so a broken table would show as failed webhook events. That is intended: visible, not silent.
- Callers that only read `flows_added` / `ok` are unaffected.
INVARIANTS AT RISK: None.
- INV-01 / INV-54: inserts are counted by xmax; a re-sync stores 0.
- INV-87 / INV-88: flows and holdings are untouched.
- INV-81: the new table is in WIPE_TABLES.
- INV-17: the migration is idempotent, run twice.
NET SCORE: 0 production fixes − 0 new failure modes = 0 (new capability, server only)

OPERATOR ACTIONS / DEPLOY:
- None. The table fills on the next Plaid flow sync (the daily balance sync, Sync Balances, or POST /api/plaid/sync-flows). | BLOCKS DEPLOY: N
Deploy: Render auto-deploys on push to `main` (Financial Analytics / Bank Sync & Ingestion ship with the main deploy); no Apps Script change.

(Not complete in production until blocking operator actions are done AND
the deploy step is confirmed.)

FOLLOW-ON ITEMS:
- Lots are rebuilt from Plaid's ~24-month window, so a sale of shares bought earlier has a NULL basis, reported as unknown. The broker's 1099-B is the authority.
- Wash sales, specific-lot or average-cost elections and corporate-action basis adjustments are not modelled; a split only flags the security.
- Manual and Teller-linked investment accounts have no transactions, so no gains or income.
- A removed (inactive) investment account's stored rows still count for their years.

DOCUMENTATION UPDATES NEEDED:
- None (done in this batch)
---END BROAD SCAN IMPLEMENTATION SUMMARY---
