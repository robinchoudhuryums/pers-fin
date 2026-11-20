---BROAD SCAN IMPLEMENTATION SUMMARY---
Findings implemented:
- F20 — the two recurring detectors share one keyword source; a series the transfer detector takes is no longer also a subscription (the forecast billed it twice)
- F28 — a paycheck expected today that hasn't landed is carried to the first projected day; a Teller webhook sync also refreshes that enrollment's balances
- F21 — a new subscription's prior price comes from its own series; a second plan under the same merchant key is not a price rise; the early price alert has its own memory
- F22 — moving a row from Utility to Subscription is no longer undone by the next detection run
- F23 — a manual subscription's next date moves on
- F24 — exact rename and categorization rules match a bank name with a trailing space
New capabilities (G/ST): None
Files modified:
- scripts/transfer-keywords.js (new — the shared lists and classifiers)
- scripts/detect-transfers.js
- scripts/detect-subscriptions.js
- teller/routes/subscriptions.js
- teller/routes/enrollments.js
- teller/routes/merchant-rename.js
- teller/routes/categorize.js
- teller/services/cash-flow.js
- teller/services/database.js (two ADD COLUMN IF NOT EXISTS)
- tests/cycle9-b3.test.js (new, 35 tests)
- tests/contract/c9-batch3.contract.test.js (new, 9 tests)
- tests/contract/c8-batch3.contract.test.js, tests/broad-scan-c8-batch3.test.js, tests/scan-sept-batch4.test.js, tests/scan-oct-batch15.test.js, tests/roadmap-t2-2-cash-l1.test.js, tests/roadmap-t2-webhooks-w5.test.js (pins and one stub that encoded the old SQL / response shape)
- .cycle/STATE.md, .cycle/blocks/9-batch3-broad-implement.md

CHANGES:
F20 | scripts/transfer-keywords.js, scripts/detect-transfers.js | TRANSFER_PATTERNS and the classifiers (classifyTransfer, classifyTransferDescription, classifyTransferTxn, isTransferMerchant) moved, unchanged, into one module. detect-transfers.js imports and re-exports them, so its exports are the same.
F20 | scripts/detect-subscriptions.js | A row is left out when the transfer classifier takes it (by merchant key or raw description), unless the user dismissed that merchant's outgoing recurring transfer. Each run also retires active, non-manual subscription rows keyed on a transfer merchant (same dismissed exception) — is_active only, user state kept — so rows detected before this fix stop being billed beside their transfer row. The extra reads are fail-soft.
F28 | teller/services/cash-flow.js | projectCashFlow carries an income event dated today to tomorrow when the stream's last deposit is more than 5 days before it (paydayLanded). A payday that has landed is left out as before (it is in the balance). The result gains carried_income [{ source, amount, expected_date, projected_date }], which GET /api/cash-flow returns.
F28 | teller/routes/enrollments.js | The body of syncAllBalances' per-enrollment loop is now refreshTellerEnrollmentBalances(enrollment) (a pure move; never throws). syncTellerEnrollment — the Teller webhook's per-enrollment sync — calls it after a run that didn't fail and returns balances_updated; a failed refresh is logged and never fails the sync.
F21 | scripts/detect-subscriptions.js | prior_amount for a new row is the previous charge of the same series (it was the merchant's previous charge of any amount). isOtherPlan(merchantTxns, stored, new, cadence): the new anchor is another plan when that amount was already charged within the two cadences up to the stored price's last charge. The upsert takes it as $11 and then records no price change (prior_amount and amount_changed untouched).
F21 | teller/routes/subscriptions.js, teller/services/database.js | New column detected_subscriptions.early_price_alerted_amount. The early rule writes it (not price_alerted_amount), both rules read both columns, and the early rule skips an amount that was already being charged in the two cadences up to last_charged.
F22 | teller/routes/subscriptions.js, teller/services/database.js | New column detected_subscriptions.category_user_set (default false). PATCH /api/subscriptions/:id/category sets it; detection's Subscription → Utility promotion adds AND NOT category_user_set.
F23 | teller/routes/subscriptions.js | rollManualSubscriptions(db, today): for active, uncancelled manual rows whose next_expected has passed, sets it to the series' first date on or after today, stepping from last_charged (the day it was added) with cadence.seriesOccurrences. Runs in runSubscriptionDetection and at the top of GET /api/subscriptions; fail-soft in both.
F24 | teller/routes/merchant-rename.js, teller/routes/categorize.js | Exact matches compare TRIM(merchant) with LOWER(TRIM(pattern)) — in ruleCondition("exact") and both categorization-rule apply sites. contains / starts_with are unchanged.

TEST RESULTS: passed.
- `npm test`: 3298 / 3298 (35 new; 180 test files; Perfin 2555).
- Route contract suite on a local Postgres 16: 349 / 349 (9 new).
- Playwright: 93 / 93 (smoke, every-page with the click sweep, behaviour).
- The new unit file and ten neighbouring files under five shifted clocks (2026-12-31, 2027-01-31, 2027-03-01, 2027-03-31, 2028-02-29): 225 / 225 each. The contract file was not run under a shifted clock (the database keeps the real date).
- Mutation check: against the pre-fix code the new contract file fails 7 of 9 (the two that pass describe behaviour that was already right); the new unit file can't load without the shared module.
- Regression scenarios: S1 (re-sync idempotent) — PASS by tests/sync-idempotency and the contract sync-ai suite, both in the runs above; S2, S3 — not applicable to the files changed in a way that alters them (suites pass); S4–S6 — not applicable.

REGRESSION RISKS:
- A merchant the transfer classifier names is no longer a subscription: a monthly charge from Acorns, Robinhood, Betterment, a merchant with "savings" in its name, or one whose cleaned name is just "PayPal" now shows under Recurring Transfers only, and subscription totals drop by it. Dismissing that transfer brings it back as a subscription at the next detection run.
- The forecast counts a paycheck expected today before it arrives. If it never comes, that day's forecast is one paycheck too high; it drops out the next day. If today's deposit lands under another name or outside the stream's ±10% amount band, it is counted twice for that day.
- Each Teller webhook sync now makes the balance calls too (one accounts call plus one per account).
- GET /api/subscriptions can write (the manual roll-forward).
- Exact rules now also match names that differ only by leading or trailing spaces.

INVARIANTS AT RISK: None broken. Wording to update at /sync-docs: INV-123 (the early alert's own memory; a second plan isn't a rise), INV-124 and INV-112 (exact rules compare trimmed values), INV-140 (a Teller webhook sync also refreshes that enrollment's balances — still nothing global), INV-142 / INV-151 (the forecast carries today's unlanded payday; every reader follows because it is in projectCashFlow). INV-70 holds for the manual roll-forward (cadence.seriesOccurrences from the anchor).
NET SCORE: 2 − 1 = +1
- Production fixes this month: 2. F20 — yes, likely: a steady brokerage contribution ("schwab", "vanguard", …) or mortgage payment was in the transfer list but not the subscription exclusions (not confirmed against production data). F28 — yes: on every payday morning the forecast and the dashboard's lowest projected day were a paycheck short until the deposit synced. F21, F22, F23, F24 — not confirmed (each needs data or an action I can't see).
- New failure modes: 1 (Low) — F20 moves genuine subscriptions billed by a transfer-keyword merchant out of the Subscriptions list until the user dismisses the transfer.

OPERATOR ACTIONS / DEPLOY:
- None required. After the first detection run on the deployed code, check the Subscriptions page: anything that moved to Recurring Transfers and is really a subscription comes back by dismissing that transfer. | BLOCKS DEPLOY: N
Deploy: Bank Sync & Ingestion / Detection & Categorization / Financial Analytics — Render auto-deploys on push to `main` (this work is on `claude/gracious-maxwell-li0vm7`; no PR opened). The two new columns are added by the boot migration.

(Not complete in production until blocking operator actions are done AND
the deploy step is confirmed.)

FOLLOW-ON ITEMS:
- A paycheck that is a day or more late (expected yesterday, not landed) is still in neither the balance nor the projection.
- The dashboard's Cash Flow section doesn't say when a paycheck was carried (carried_income is in the API only).
- A merchant key that carries two plans still has one row per cadence, so the forecast bills only the plan that charged last.
- A subscription whose amount varies month to month alerts on each increase of $1 or more over the previous one (once per amount).
- daily-sync.yml runs /api/sync and /api/sync-balances as separate steps, so for a few minutes transactions are newer than balances.
- A transfer recognised only by its raw description (rent by Zelle) can't be turned into a subscription by dismissing the transfer — the subscription detector's own description exclusions still drop its rows.
- The retirement of overlapping subscription rows runs on every detection run (one small read); it could be a one-time step.

DOCUMENTATION UPDATES NEEDED:
- CLAUDE.md: scripts/transfer-keywords.js under Other key files and in the Detection & Categorization subsystem list; the Subscription detection and Recurring Transfer Detection sections (one classifier, the dismissed-transfer exception, retirement); the watchdog (series prior price, other-plan rule, early_price_alerted_amount); category_user_set; manual subscriptions' next date; exact rules trimmed (merchant rename rules and categorization rules); the cash-flow.js entry and the Cash flow forecast feature (carried_income); the enrollments.js and teller-webhook-events.js entries (per-enrollment balance refresh); the two new columns under Database; GET /api/cash-flow and PATCH /api/subscriptions/:id/category in the API list; the test list (tests/cycle9-b3.test.js, tests/contract/c9-batch3) and counts (3298 tests, 180 files, Perfin 2555; contract 349); the cycle-9 Known Open Issues entry (Batch 3 done, follow-ons); INV-112 / 123 / 124 / 140 / 142 wording.
- README: test counts.
---END BROAD SCAN IMPLEMENTATION SUMMARY---
