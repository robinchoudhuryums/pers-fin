---BROAD SCAN IMPLEMENTATION SUMMARY---
Findings implemented:
- BSI-4 — Plaid holdings sync prunes positions Plaid no longer returns (sold / transferred out), scoped to the accounts in that item's response
- BSI-5 — an unknown cost basis is stored NULL (column made nullable) and left out of the return; the response reports how much of the portfolio has a known basis
- BSI-6 — an account that first appears mid-window enters TWR/XIRR as an opening inflow (its pre-entry flows are part of that balance), so linking a second account no longer reads as +100% return
- WD-2 — dashboard investment sparklines read the account's real history source (Teller-linked → linked, others → investment)
- WD-10 — goal funding options drop the Plaid brokerage's $0 linked_accounts phantom; an orphaned funding link shows a warning on the Goals page
- WD-17 — top_losers lists only losses (top_winners only gains); the value-vs-S&P chart clears to an empty state on a range with no data (superseded responses dropped); reconcile completion reports per-item errors in Settings and in the push
- BSI-16 — parseMoney handles trailing minus and CR/DR suffixes; new chase_checking format; CSV header parse tolerates Chase's trailing comma
Files modified:
- teller/routes/investments.js
- teller/routes/investment-performance.js
- teller/services/database.js
- teller/routes/goals.js
- teller/routes/enrollments.js
- teller/routes/subscriptions.js
- teller/data/csv-formats.js
- scripts/sheets-sync.js
- scripts/import-csv-cli.js
- teller/views/dashboard.ejs
- teller/views/goals.ejs
- teller/views/settings.ejs
- tests/scan-sept-batch12.test.js (new, 21 tests)

CHANGES:
BSI-4 | investments.js | New writePlaidHoldings(db, data): one batched upsert, then DELETE FROM investment_holdings WHERE plaid_account_id = ANY(<accounts in this response>) AND (plaid_account_id, security_id) NOT IN unnest(<returned pairs>). Used by syncAllPlaidHoldings and both exchange paths (the per-row loop in /api/plaid/exchange is gone). syncAllPlaidHoldings returns holdings_removed.
BSI-5 | investments.js, database.js, sheets-sync.js, dashboard.ejs | holdingCostBasis(h) → number or null (0 kept). Migration: ALTER investment_holdings.cost_basis DROP NOT NULL / DROP DEFAULT. /api/investments/performance: total_return = value of known-basis holdings − their basis; per-holding return null when basis unknown (not ranked); per-class return over known basis; new cost_basis_coverage { holdings_with_basis, holdings_total, value_with_basis, value_pct }. Sheets Investments tab: blank basis/return cells for unknown, totals over known basis. Dashboard return line uses the known-basis value and says "cost known for N of M holdings" when partial.
BSI-6 | investment-performance.js | Pure accountEntryFlows(rows) → entries (accounts whose first in-window snapshot is after the series start, non-zero balance) + firstSeen. performance-history adds each entry as a flow on its first date (flowsByDate + XIRR cashflow) and skips that account's flows dated on/before its first snapshot; flow_coverage.accounts_added. Re-exported from investments.js.
WD-2 | dashboard.ejs | invHistSource(a) used for both the card's "View history" link and the sparkline fetch (was hard-coded source=investment).
WD-10 | goals.js, goals.ejs | funding-options' investment linked_accounts query adds NOT EXISTS (active investment_accounts row with the same plaid_account_id) — the getNetWorth dedupe. Goals card: funding_status 'orphaned' renders a yellow "linked account is no longer available — showing the manually entered amount" note instead of "Auto-tracked".
WD-17 | investments.js, dashboard.ejs, enrollments.js, settings.ejs | top_winners filtered to return_pct > 0, top_losers to < 0. load(months): loadSeq drops a superseded response; < 2 points / failed fetch → showEmptyRange (clears chart, stats, TWR line) once the card is showing. New reconcileErrors(out) flattens leg + per-item errors ("Plaid not configured" excluded); the background job sets reconcileJob.error/errors from it, the push title uses it, summarizeReconcile appends "(N errors)"; Settings also counts result.teller/plaid errors.
BSI-16 | csv-formats.js, subscriptions.js, import-csv-cli.js | parseMoney: "CR" suffix → negative, "DR" → positive (debit-positive convention), trailing minus → negative; existing notations unchanged. chase_checking format (Details + Posting Date + Description + Amount): date = Posting Date, amount = −Amount, category "" (Type is a transaction kind); INSTITUTION_LABELS "Chase Checking". The route's and the CLI's header parse use relax_column_count (Chase checking rows end with a trailing comma → "Invalid Record Length" failed the whole file). CLI header comment no longer claims filename detection.

TEST RESULTS: passed. npm test 1572/1572 (Perfin 995 + Per-sistant 577; 63 files). New tests/scan-sept-batch12.test.js (21 tests; all 21 fail on the pre-fix code). Real Postgres: both apps' migrations ×2 (cost_basis now nullable, no default); writePlaidHoldings on the real table stored NULL basis, pruned the sold position and left another item's holding alone; /api/investments/performance over it returned value 6,200 / return 200 (20%) / coverage 1 of 2 / no losers; funding-options excluded the $0 brokerage twin and kept a plain IRA; performance-history query ran. Browser: dashboard, goals and settings load with no page or CSP errors; Playwright e2e 8/8.
REGRESSION RISKS:
- total_return / total_return_pct now cover only known-basis holdings; a portfolio with no known basis shows no return (previously a misleading figure). cost_basis_coverage is additive.
- The prune trusts Plaid's holdings response per account: if Plaid ever returned an account with a transiently empty holdings list, its rows would be deleted and re-created on the next sync (self-heals; snapshots/balances unaffected).
- TWR/XIRR change for any window in which an account was added — intended; the value-based portfolio line is unchanged.
- relax_column_count lets a ragged CSV parse instead of failing the whole file; rows missing date/amount are still skipped and counted.
- parseMoney: a value ending in "CR"/"DR" or "-" changes sign handling — previously silently positive.
INVARIANTS AT RISK: None violated. INV-54 (holdings re-sync idempotent: a second identical run upserts the same rows and prunes 0), INV-22 untouched, getNetWorth unchanged (WD-10 copies its dedupe, INV-48 n/a), INV-10 (no LIKE added), INV-17 (cost_basis ALTER is idempotent inside the migration transaction), INV-18/19 (helpers attached after module.exports = router). Candidates: holdings sync mirrors Plaid's response (prune per returned account); an unknown cost basis is NULL and never counted as $0; TWR/XIRR treat a mid-window account's opening balance as an inflow.
NET SCORE: 5 − 0 = 5 (production: BSI-4 any sale/rebalance of a Plaid holding, BSI-5 transferred-in lots without basis, BSI-6 accounts linked within the last 12 months, WD-10 the Schwab brokerage phantom in funding options, WD-17 losers list on an up portfolio; not this month: WD-2 (no Teller investment account confirmed), BSI-16 (no Chase checking CSV import))

OPERATOR ACTIONS / DEPLOY:
- None required. The cost_basis ALTER auto-migrates on boot; ghost holdings are pruned on the next holdings sync (auto-sync, Sync Balances, or the AI pre-insights chain). | BLOCKS DEPLOY: N
Deploy: Platform, Shell & Auth: Render auto-deploys on push to `main`. Sheets & External Export: server-side sheets-sync.js ships with the main deploy (no clasp change).

(Not complete in production until blocking operator actions are done AND
the deploy step is confirmed.)

FOLLOW-ON ITEMS:
- The generic CSV parser still never flips sign (a bank whose generic export has money-out negative imports it as income). The preview shows it; a per-file sign toggle would fix it. Out of scope.
- Existing rows stored with cost_basis 0 for an unknown basis (before BSI-5) stay 0 until Plaid re-sends them — the next holdings sync rewrites every returned holding, so this clears itself after one sync.
- The value-based portfolio line and portfolio_return_pct still count a newly linked account as growth (documented: "contributions count as growth"); only TWR/XIRR are flow-adjusted.
- performance-history's covered-account test uses snapshots only; an account removed mid-window simply drops out (forward-fill stops at inactive) — not treated as an outflow. No finding; noted.
DOCUMENTATION UPDATES NEEDED:
- CLAUDE.md: Plaid holdings bullets (prune per returned account, nullable basis), Investments widget (known-basis return + coverage line, winners/losers), performance-history TWR note (mid-window account entry flows, accounts_added), /api/investments/performance + /api/plaid/sync-holdings + /api/sync/reconcile/status endpoint notes, goals funding-options dedupe + orphan display, Sheets Investments tab, CSV formats list (Chase checking, CR/DR, trailing minus, trailing-comma tolerance), test counts 1572/63 (Perfin 995) + batch12 test description; possible new invariants for the candidates above.
- README.md: counts 1572/63 + Batch 12 coverage.
---END BROAD SCAN IMPLEMENTATION SUMMARY---
