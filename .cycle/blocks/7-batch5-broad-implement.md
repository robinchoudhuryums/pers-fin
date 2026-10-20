---BROAD SCAN IMPLEMENTATION SUMMARY---
Findings implemented:
- F31  Settle Up turned a 0% split into 50% (`|| 50`, COALESCE(…,50)) and the dashboard showed 100% (`|| 100`) — null-safe split (NULL → 100, the SPLIT_AMOUNT default; 0 stays 0) in the route and the account card
- F32  Since DD-2, NOT_TRANSFER matched bank/processor brand words (paypal, chase, citi, discover, amex, deposit, interest, …) on the RAW description — "PAYPAL *NETFLIX", Citi Bike, Chase Center tickets and a security deposit vanished from all spending — only the payment/transfer PHRASES read the raw description; brand words read the cleaned merchant (COALESCE(user_merchant_name, merchant_name, name)) with a small exemption list (citi bike, citi field, chase center/field, security deposit, "PAYPAL *<merchant>"); sheets-sync mirrored (SX3)
- F51  A Transfer or Investment category didn't exclude a non-Plaid row from spending — NOT_TRANSFER excludes user_category Transfer/Investment, and the provider category for non-Plaid rows (a Plaid row's legacy category isn't trusted; its PFC is)
- F49  Both detectors keyed only on the merchant: "ZELLE TO JOHN SMITH" rent became the subscription "John Smith" — a row whose raw description (read only when not renamed) is a payment/transfer is dropped from subscription detection; the transfer detector also includes/classifies rows by their raw description (phrase-like types only — PayPal purchases and brand words stay merchant-only)
- F50  Plaid's legacy category names ("Travel" for gas and taxis) overlap ours, so those rows were treated as categorized and skipped by the PFC map and the AI — every uncategorized predicate treats a PFC row as uncategorized; the Teller map skips Plaid rows; mapCategoryFor maps a Plaid row from its PFC only
- F34  Cash-flow income used an old inline classifier (amount-only groups, no semimonthly, no staleness, ignored renames) — it now projects the bill calendar's live cadence.js streams via a shared getLiveIncomeStreams(pool) (the calendar uses it too)
- F37  Reimbursement credits counted as income; income on a joint account wasn't split — "reimbursement|reimburse|reimb|expense report" joins the income exclusion list; INCOME_AMOUNT (= −SPLIT_AMOUNT) puts income at the account's share in getMonthlyIncome, /api/income-summary and the Sheets Income tab (mirrored)
- F36  The context export showed 100% utilization when the card limit was unknown — the AIN-7 rule (credit_limit, else owed + available when available exists, else unknown → null / "limit unknown")
- F33  A removed housing obligation was regenerated on the next 6-hourly run, and there was no delete UI — payee_obligation_skips (period, category, label) is written when an auto-generated row is deleted and checked by generation; a hand-added obligation clears it; label renames carry it; awaiting-bill rows get a Remove button
- F38  Budget snapshots recorded rollover for months a budget wasn't in effect — writeBudgetSnapshot skips a one-time budget outside its effective_month and any month before the budget was created (APP_TIMEZONE month)
- F40  The budget push re-implemented getBudgetStatus and rounded the percentage (99.5% → "exceeded") — it calls getBudgetStatus and compares the unrounded share (shown % floored)
- F41  Spending Summary's category and merchant windows were rolling UTC `CURRENT_DATE − N months` while the trend used whole tz months — all three use the same whole-month window
- F42  The Sheets Watchlist used unescaped LIKE and summed raw signed amounts of ≤100 listed rows — user values are LIKE-literal (ESCAPE '\'); the 90-day total is a separate aggregate of spending at your share (debits, not reimbursed, split applied)
- F43  The rent reminder lead window never fired across a month boundary (next month's rent row doesn't exist until that month) — nextRentInLeadWindow adds next month's rent to the payment-due reminder when its lead window has opened and its row isn't generated or removed
New capabilities (G/ST): None
Files modified:
- teller/services/financial-queries.js, teller/services/database.js
- teller/routes/subscriptions.js, teller/routes/spending-analytics.js, teller/routes/categorize.js, teller/routes/categorize-helpers.js, teller/routes/goals.js, teller/routes/housing.js, teller/routes/budgets.js, teller/startup.js
- teller/views/dashboard.ejs, teller/views/housing.ejs
- scripts/detect-subscriptions.js, scripts/detect-transfers.js, scripts/sheets-sync.js, scripts/reset-fresh.js
- tests/scan-oct-batch5.test.js (new), tests/contract/money-classification.contract.test.js (new), tests/financial-queries.test.js, tests/cycle-fixes.test.js

CHANGES:
F31  | subscriptions.js, dashboard.ejs | COALESCE(spending_split_pct, 100); Number.isFinite split (0 kept); card label `== null ? 100 :`
F32  | financial-queries.js, sheets-sync.js | NOT_TRANSFER = phrase list on COALESCE(user_merchant_name, CONCAT_WS(merchant_name, name)) AND (brand list on COALESCE(user_merchant_name, merchant_name, name) NOT matching OR exemption match)
F51  | financial-queries.js, sheets-sync.js | AND LOWER(COALESCE(user_category, CASE WHEN pfc IS NULL THEN category[1] END, '')) NOT IN ('transfer','investment')
F49  | detect-subscriptions.js, detect-transfers.js | raw_description column (NULL when renamed); isExcludedDescription (interest/fees/debt_payments/transfers lists); classifyTransferDescription / classifyTransferTxn / groupTransferType
F50  | categorize.js, categorize-helpers.js | `personal_finance_category IS NOT NULL OR …` in all four uncategorized predicates; Teller-map pass `AND personal_finance_category IS NULL`; mapCategoryFor PFC-only for Plaid rows
F34  | financial-queries.js, spending-analytics.js, subscriptions.js | getLiveIncomeStreams; cash-flow projects incomeEventsBetween per stream; recurring_income {source, amount, cadence, cadence_days, last_date, days_of_month?}
F37  | financial-queries.js, spending-analytics.js, sheets-sync.js | income exclusion words; INCOME_AMOUNT exported; getMonthlyIncome / income-summary (3 queries) / Sheets Income (2 queries) aliased + LEFT JOIN linked_accounts
F36  | goals.js | cardLimit() (AIN-7); JSON credit_limit/utilization_pct null when unknown; markdown "limit unknown (utilization unknown)"
F33  | database.js, housing.js, housing.ejs, reset-fresh.js | CREATE TABLE payee_obligation_skips; generation NOT EXISTS skips; DELETE route in a transaction records the skip for auto_generated rows; POST obligations clears it; labelRenames rename skips; Remove button + confirm; WIPE_TABLES
F38  | budgets.js | monthOf(created_at) in APP_TIMEZONE; one-time + created-after skips in writeBudgetSnapshot
F40  | startup.js | runBudgetAlertTick → getBudgetStatus(pool, currentMonth()); pct unrounded; shownPct floored
F41  | spending-analytics.js | category (2 CTEs) + top merchants use date_trunc('month', $2::date) − make_interval(months => $1 − 1)
F42  | sheets-sync.js | likeLiteral + ESCAPE '\'; WATCH_SPEND aggregate query; header "90-Day Spend (your share)"; syncWatchlist added to _internals (test seam)
F43  | housing.js | nextRentInLeadWindow (exported); runHousingReminders(pool, today) adds next month's rent (not generated, not skipped) inside its lead window; tag housing-due-<next month>

TEST RESULTS: passed — npm test 1573/1573, 0 todo (+15 in tests/scan-oct-batch5.test.js, all failing against the pre-fix code). Contract suite 68/68 on local PG16 without pgvector (+11 in tests/contract/money-classification.contract.test.js, all failing pre-fix). scripts/ci-migration-test.js passes (twice). Playwright 35/35 (dashboard + Rent page changed). Updated pins: financial-queries.test.js (NOT_TRANSFER now has two exclusion patterns — the test unions them), cycle-fixes BS-7 (the cash-flow monthly clamp now comes from cadence.js — asserted behaviourally).
REGRESSION RISKS:
- F32: a card payment whose cleaned merchant carries no bank name AND whose raw description has a bank name but no payment phrase now counts as spending (Plaid rows are still excluded by PFC; Teller/CSV rows usually carry "autopay"/"epay"/"payment thank" or a bank merchant). A merchant literally named after a bank (a "Chase …" store other than the exemptions) is still excluded.
- F51: a Teller row categorized `investment` (or a user category Investment) is no longer spending — intended, but a purchase mis-categorized Investment disappears from spending.
- F50: Plaid rows that were treated as categorized (legacy name in our scheme) are now queued: the free PFC map handles most, the rest go to the AI on the next categorize run (one-time cost inside the monthly cap); their displayed category may change from the legacy name to the PFC-mapped one.
- F37: income on is_shared accounts drops to the account's share everywhere income is aggregated (savings rate, income summary, insights, FIRE, Ask, Sheets); the cash-flow / bill-calendar income streams stay full deposit amounts (they project cash into the account).
- F34: cash-flow income events now follow the calendar's streams — a stream that went quiet >35 days (>50 monthly) is no longer projected; recurring_income lost typical_day (the dashboard reads only source).
- F38: a budget created mid-month gets no snapshot for earlier months → no rollover into its first month (intended).
- F41: Spending Summary category / merchant totals for months=N now exclude the partial oldest month the rolling window included.
- F33: removing an auto-generated row is now remembered; to get it back the user must add it by hand (POST /api/housing/obligations) — there is no "+ add item" UI on the Rent page yet.
- F43: a rent reminder may now arrive in the last days of a month for next month's rent (tag housing-due-<next month>), alongside the current month's tag.
INVARIANTS AT RISK: None violated. INV-48 kept (new SPLIT CASE copies — Sheets INCOME_AMOUNT + WATCH_SPEND — live only in scripts/sheets-sync.js, the permitted copy; NOT_TRANSFER structure still SX3-pinned; INCOME_AMOUNT mirror pinned in scan-oct-batch5). INV-73 strengthened (the push now calls getBudgetStatus). INV-70 extended (cash-flow income on cadence.js). INV-72 extended (generation honors removals). INV-81 kept (payee_obligation_skips in WIPE_TABLES). INV-10 kept (Watchlist LIKE escaped). INV-07 extended to income.
NET SCORE: 0 − 1 = −1 (none of the fourteen had evidence of firing this month — no production data was examined; F32's narrower brand matching is a documented new failure mode: a bank-named card payment with no payment phrase and a non-bank cleaned merchant would now count as spending.)

OPERATOR ACTIONS / DEPLOY:
- None | BLOCKS DEPLOY: N
Deploy: Platform, Shell & Auth — Render auto-deploys on push to `main` (merge the PR); alt `fly deploy`. Sheets & External Export — server-side sheets-sync.js ships with the Render deploy (no Apps Script change).

(Not complete in production until blocking operator actions are done AND the deploy step is confirmed.)

FOLLOW-ON ITEMS:
- Per-sistant's housingDue (apps/per-sistant/routes/housing-due.js) has the same month-boundary gap as F43 (it only sees this month's due date and the unpaid balance) — the briefing / notification check won't mention next month's rent in the lead window.
- The Rent page has no "+ add item" UI for an ad-hoc obligation (POST /api/housing/obligations exists), so a removed placeholder can only be restored via the API.
- Refunds still never reduce spending outside the settlement (F35 / G4 — later batch).
- Rollover / one-time budgets still have no UI and the Add form's upsert resets them (F39 — not in Batch 5).
- CLAUDE.md stale claims (F44) — doc batch.
- Code.gs (legacy, unpinned) still has the pre-F32 NOT_TRANSFER keyword list.
DOCUMENTATION UPDATES NEEDED:
- CLAUDE.md: NOT_TRANSFER (Income Detection section + Key Design Decisions): phrase list vs merchant-only brand list + exemptions, Transfer/Investment category exclusion; INCOME_AMOUNT + income exclusion words (F37) in Income Detection / Shared Account Spending Split ("this affects" list); getLiveIncomeStreams + cash-flow income (Cash flow forecast bullet, GET /api/cash-flow, Bill calendar); categorize uncategorized predicate for Plaid rows (Categorization rules first + Review widget notes); detectors' raw-description rule (Subscription detection + Recurring Transfer Detection sections); Settle Up 0% split; context export unknown limit; Rent & Utilities: removal remembered (payee_obligation_skips table in Database + reset-fresh lists, DELETE endpoint text, the Settle Up "delete the placeholder" note now works, Remove button), next-month rent reminder; budget snapshot rule (Budget rollover + scheduled-snapshot bullet); budget push via getBudgetStatus (Budget alerts bullets); Spending Summary windows (GET /api/spending-summary); Sheets Watchlist (literal LIKE, spend total header); test counts 1573 / 72 files (Perfin 1117) + scan-oct-batch5 + the money-classification contract file; contract count 68; Known Open Issues (F43 Per-sistant gap, no add-item UI); possibly new invariants (detectors read raw description only for phrase-like words; removed housing items are not regenerated).
- README.md: counts; Batch 5 summary line.
---END BROAD SCAN IMPLEMENTATION SUMMARY---
