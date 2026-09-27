---BROAD SCAN IMPLEMENTATION SUMMARY---
Findings implemented:
- FAN-2 — INCOME_PREDICATE's brokerage double-count guard now references the OUTER row (was self-comparing __t2, so a payroll + its "Funds transfer from brokerage" counted twice)
- DD-2 — income detection and the transfer exclusion read the raw description as well as the cleaned merchant (Teller counterparty/description split)
- DD-3 — Plaid personal_finance_category used: INCOME counts as income, TRANSFER_IN/OUT + LOAN_PAYMENTS excluded from spending, a free PFC→category map pass, and credits whose provider category is income get user_category='Income'
- FAN-5 — cash-flow starting balance counts depository, non-investment accounts only (was every non-credit account, loans included)
- DD-4 — cash-flow no longer double-counts: subscription merchants are out of the daily spending average, and card autopays aren't billed on top of the card spending they pay off
- FAN-6 — spending-summary uses whole months, and the dashboard "Avg Monthly"/"Avg Daily" cover completed months only, using real month lengths
- DC-12 — Teller map: accommodation → Travel (was Housing), loan → Transfer (was Fees & Charges)
- DC-13 — implicit "remember" rules (review widget, accuracy review, from-transaction) default to exact match
- DC-14 — CSV-import and manual-entry categories are passed as text[] parameters instead of concatenated array literals
- AIN-13 — Ask's search_transactions total applies NOT_TRANSFER, counts the same rows it lists, escapes LIKE metacharacters, and states the split caveat
Files modified:
- teller/services/financial-queries.js, teller/routes/spending-analytics.js, teller/routes/categorize-helpers.js, teller/routes/categorize.js, teller/routes/ask.js, teller/routes/subscriptions.js, teller/routes/transactions.js, teller/views/dashboard.ejs, scripts/sheets-sync.js
- tests/scan-sept-batch3.test.js (new), tests/audit-regressions.test.js, tests/ops-and-alerts.test.js, tests/manual-cash-settlement.test.js

CHANGES:
FAN-2 | financial-queries.js, spending-analytics.js | New incomePredicate(alias) factory that qualifies every outer column with the caller's alias, including inside the NOT EXISTS (… FROM transactions __t2 …) guard. INCOME_PREDICATE = incomePredicate("transactions") (Postgres accepts the bare table name as qualifier for unaliased callers). INCOME_PREDICATE_T = incomePredicate("t"), replacing the regex-derived copy; by_account now agrees with monthly_trend.
DD-2 | financial-queries.js | Income keywords match CONCAT_WS(' ', user_merchant_name, merchant_name, name). NOT_TRANSFER matches COALESCE(user_merchant_name, CONCAT_WS(' ', merchant_name, name)): the raw description is read, and a user rename still wins, so renaming stays the escape hatch for a payment that really is spending.
DD-3 | financial-queries.js, categorize-helpers.js, categorize.js | Income adds `user_category IS NULL AND personal_finance_category->>'primary' = 'INCOME'`, and branch (c) is case-insensitive, so Teller's lower-case 'income' matches. NOT_TRANSFER (now one parenthesized boolean) adds NOT(pfc IN TRANSFER_IN/TRANSFER_OUT/LOAN_PAYMENTS AND COALESCE(user_category,'Transfer')='Transfer'). New PLAID_PFC_DETAILED_MAP / PLAID_PFC_PRIMARY_MAP and mapCategoryFor(). runCategorize adds FREE PATH 3 (PFC detailed, then primary; source 'plaid_map', counted in by_teller_map) and FREE PATH 4 (credits with Teller 'income' or PFC INCOME → user_category 'Income'). The review-queue suggestion falls back to PFC.
FAN-5 | spending-analytics.js | Cash = SUM over la.type='depository' AND NOT INVESTMENT_ACCOUNT_TYPES.
DD-4 | spending-analytics.js | NOT_SUBSCRIPTION (NOT EXISTS against active detected_subscriptions, using detection's merchant_key expression) added to both 60-day average queries. bill_payment transfers are dropped from the bill schedule unless the display name says loan/mortgage.
FAN-6 | spending-analytics.js, dashboard.ejs | Monthly trend floors to date_trunc('month', $2) - (months-1) with a tz-aware anchor. The response adds avg_monthly_spend, avg_daily_spend and avg_months over completed months (current month excluded, real day counts). The dashboard reads them.
DC-12 | categorize-helpers.js | accommodation → Travel; loan → Transfer.
DC-13 | categorize.js, dashboard.ejs | review and from-transaction default match_type to "exact"; accuracy-review inserts 'exact'; the dashboard widget sends 'exact'. An explicit match_type is still honored; POST /api/categorization-rules keeps its documented contains default.
DC-14 | subscriptions.js, transactions.js | [String(category)] text[] parameter, matching import-csv-cli.js.
AIN-13 | ask.js | The total is CASE WHEN amount>0 AND NOT_REIMBURSED AND NOT_TRANSFER; match_count is over the same WHERE as the row list; ILIKE … ESCAPE '\' with \, % and _ escaped; the note explains the transfer exclusion and the split caveat (points to get_category_spending).
sheets-sync mirror | scripts/sheets-sync.js, tests/audit-regressions.test.js | incomePredicate/incomeText and NOT_TRANSFER copied byte-for-byte (whitespace-normalized). SX3 gains pins on the full predicate structure, not just the keyword lists.

TEST RESULTS: PASSED. npm test 1194/1194 (Perfin 725 + Per-sistant 469; +23 in tests/scan-sept-batch3.test.js, +2 SX3 pins; the ops-and-alerts FAN-2 pin was rewritten). The old manual-cash test expected the '{Food & Drink}' literal; it was updated to expect the text[] parameter as part of DC-14. 22 of the 23 new tests fail against the unfixed source; the remaining one is a non-regression guard (an explicit match_type is honored).

Real Postgres 16 (migrated schema), all PASS:
- FAN-2 reproduced: the old unqualified guard counts the $3,000 brokerage transfer. Fixed income is $5,450, not $8,450.
- incomePredicate('t') works under a linked_accounts JOIN. DD-2: a raw-description payroll is income; "ZELLE TO JOHN SMITH" is excluded. DD-3: PFC INCOME is income; TRANSFER_OUT is excluded unless the user re-categorized it. The insights t→t2 derivation executes.
- FAN-5: starting_balance 4000, checking only (not the $18k loan, brokerage or IRA). DD-4: the subscription merchant is excluded from the daily average.
- spending-summary, income-summary (by_account now sums to the trend) and runCategorize's PFC + credit→Income passes work on the real schema; NOT_TRANSFER results are stable afterwards.
- AIN-13: the total excludes transfers, and a bare "%" is literal. DC-14: 'Travel, "Air" {x}' stored as a single element.
- Playwright e2e 8/8 on a live boot. The edited dashboard inline script and sheets-sync.js pass node --check.
Regression scenarios: S2 PASS by construction (SPLIT_AMOUNT and the settlement endpoint untouched; settlement tests green). S4 PASS (e2e). S5 NOT APPLICABLE (tab isolation untouched; only the inlined predicates changed, and they are parity-pinned). S1/S3/S6/SK1-5 NOT APPLICABLE (no files in those paths modified).

REGRESSION RISKS:
- DD-2: NOT_TRANSFER now also reads the raw description when the merchant isn't renamed. A purchase whose raw description contains an excluded keyword (e.g. an issuer name like "CHASE", or "interest", "deposit", "atm") now drops out of spending where the counterparty name alone didn't. Renaming the merchant restores it.
- DD-3: Plaid INCOME includes dividends and interest, so savings rate / FIRE income can rise. Plaid TRANSFER_OUT rows that are really spending (an ACH to a person) are excluded unless re-categorized. Rows already categorized by the old map keep their old user_category; only uncategorized rows are touched.
- DD-4: the card-autopay skip is a heuristic: a bill_payment transfer whose name lacks "loan"/"mortgage" (e.g. a HELOC or a line-of-credit payment) is now treated as a card autopay and left out of projected bills.
- FAN-6: spending-summary returns `months` buckets (6) instead of months+1 (7), so the dashboard category-month selector offers one fewer old month. The "N-month avg" label now counts completed months.
- DC-12: loan-category Teller rows are now categorized Transfer; they appear under Transfer instead of Fees & Charges.
- DC-13: new "remember" rules no longer catch merchant-name variants (e.g. "ARCO #123" vs "ARCO"). An explicit contains rule via Settings still covers those.
INVARIANTS AT RISK: None violated.
- INV-48 holds: the predicates are still imported everywhere, and sheets-sync is the only literal copy, now structure-pinned.
- INV-10 holds: all new matching is word-boundary ~*, or exact/LIKE with escaping.
- INV-12 holds: new passes write user_category only. INV-13 holds: free map passes run before AI.
- INV-06 holds: a user rename/category still wins in NOT_TRANSFER and the PFC income branch.
- INV-07/08 hold: SPLIT_AMOUNT and reimbursed exclusion unchanged; Ask now applies both plus NOT_TRANSFER.
NET SCORE: 6 − 1 = 5. Would have fired in production this month: FAN-2, DD-2, DD-3, FAN-5, DD-4, FAN-6. New failure mode: raw-description keyword over-exclusion (DD-2).

OPERATOR ACTIONS / DEPLOY:
- None required | BLOCKS DEPLOY: N
- Optional: rows auto-categorized by the old Teller map (accommodation → Housing, loan → Fees & Charges) keep those values. To re-file them: UPDATE transactions SET user_category = NULL, user_category_source = NULL WHERE user_category_source = 'teller_map' AND LOWER(category[1]) IN ('accommodation','loan'); then run Categorize. | BLOCKS DEPLOY: N
Deploy: Platform, Shell & Auth: Render auto-deploys on push to `main` (configured in the Render dashboard, not via CLI). Alt: `fly deploy` (Dockerfile-based).
Sheets & External Export: the server-side sheets-sync.js ships with the Render deploy; apps-script/Code.gs was not changed (no clasp push needed).

(Not complete in production until blocking operator actions are done AND
the deploy step is confirmed.)

FOLLOW-ON ITEMS:
- runCategorize still returns 501 without ANTHROPIC_API_KEY before running the FREE passes (rules, Teller map, and the new PFC map), so a no-AI install never gets free categorization. Pre-existing behavior, documented.
- apps-script/Code.gs (the legacy fork) still carries the old income/transfer predicates. It is not pinned and was not touched (Sheets subsystem, separate deploy).
- The anomaly check in enrollments.js still uses NOT_TRANSFER with its t.-alias. It gains the new semantics automatically, but there's no dedicated test of anomaly results under PFC exclusion.
- The pyramid "Spending Health" reads a response shape spending-summary doesn't return (WD-4, Batch 13).
DOCUMENTATION UPDATES NEEDED:
- CLAUDE.md Income Detection section:
  - incomePredicate(alias) factory (FAN-2): outer refs qualified, the old "unqualified refs resolve to the outer row" claim was false;
  - text = user + merchant + raw description (DD-2);
  - branch (c) case-insensitive, plus the PFC INCOME branch (DD-3);
  - INCOME_PREDICATE_T is now incomePredicate("t").
- CLAUDE.md NOT_TRANSFER docs: user-rename precedence + raw description; PFC TRANSFER_*/LOAN_PAYMENTS exclusion with the user-category override.
- CLAUDE.md categorization docs:
  - FREE PATH 3/4: the PFC map and credit→Income, `user_category_source` value 'plaid_map';
  - Teller map changes (DC-12);
  - implicit rules default to exact (DC-13).
- CLAUDE.md cash-flow docs: depository-only cash, subscription/autopay de-duplication.
- CLAUDE.md spending-summary: avg_* fields over completed months.
- CLAUDE.md Ask docs: the search_transactions total semantics.
- CLAUDE.md sheets-sync note: the income predicate and NOT_TRANSFER are structure-pinned by SX3.
- CLAUDE.md test counts: 1194 across 47 files (Perfin 725 + Per-sistant 469).
- INV-48/INV-10 wording and the Income Detection section.
---END BROAD SCAN IMPLEMENTATION SUMMARY---
