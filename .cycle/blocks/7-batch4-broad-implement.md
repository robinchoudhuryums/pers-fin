---BROAD SCAN IMPLEMENTATION SUMMARY---
Findings implemented:
- F17  pgp_sym_decrypt RAISES on a wrong key, so one stale token row failed every Teller/Plaid sync, the balance sync and the reconcile, and blocked its own unlink — token reads go through a migration-defined perfin_try_decrypt (NULL on error), so the existing per-row decryption_failed branches finally run; the Teller unlink removes a stale enrollment without calling Teller
- F18  "Re-link to fix re-auth" created a NEW Plaid Item (doubled transactions, second Trial slot) — both exchange routes refuse a duplicate of a connected Item (same institution + an account with the same mask/type): the new Item is released at Plaid, nothing is stored, 409 with the unlink-then-link recovery; docs + in-app hints no longer say "re-link"
- F19  The CSV CLI exited 0 on a failed file and the workflow then `git rm`'d every CSV — the CLI exits 1 on any failed file and writes the imported files to $CSV_IMPORTED_LIST; the workflow removes only those (also after a partial failure); a per-row SAVEPOINT stops one bad row silently rolling the whole file back
- F25  CSV manual-balance roll-forward: LIMIT 1 with no ORDER BY, loans signed like depository, a UTC date boundary, and a bare catch inside the open transaction (silent ROLLBACK with rows_imported reported) — exact label beats institution and an ambiguous match is skipped; loans roll like credit; the as-of date is APP_TIMEZONE and the balance is stamped as of its newest included row; the step runs under a SAVEPOINT and logs
- F22  A user-removed Plaid investment account was revived by the next holdings sync; investments-only Items couldn't be unlinked — the upsert keeps is_active (a removed account gets no mirror balance, snapshot or holdings); GET /api/items lists investments-only Items and DELETE /api/plaid/investment-items/:id releases one at Plaid, deactivates its accounts, drops their holdings and deletes the registry row
- F27  A Plaid reconcile could race a running sync's cursor write — Plaid transaction syncs and reconciles share one lock (bounded wait, 10 min)
- F24  TWR/XIRR counted every Plaid account as flow-covered even when its flows never synced; transactions-only Items raised a recurring plaid_flows error — investment_accounts.flows_synced_at is stamped after a complete flow walk and coverage requires it; PRODUCTS_NOT_SUPPORTED / PRODUCT_NOT_READY are skipped
- F28  Liabilities raised false errors on Items without liabilities and `||` nulled a 0% APR — the balance path calls liabilitiesGet only for Items with a credit card or loan; NO_LIABILITY_ACCOUNTS is a quiet skip, ADDITIONAL_CONSENT_REQUIRED joins the not_supported skip; APR / minimum / last payment use `??`
- F29  PATCH /api/accounts/:id/balance and the investment-account PATCH stored NaN — strict finite parsing ("$1,250.50" accepted), 400 otherwise; null only for available_balance / credit_limit; a negative limit is refused
- F30  Performance-history snapshot dates went through toISOString (a day early east of UTC); the Teller category was a concatenated "{…}" literal — snapshot_date::text + snapshotDay() (local calendar day); the category is a text[] parameter
New capabilities (G/ST): None (G3 — Plaid update-mode re-auth — remains the real fix behind F18)
Files modified:
- teller/services/database.js, teller/routes/enrollments.js, teller/routes/investments.js, teller/routes/investment-performance.js, teller/routes/subscriptions.js, teller/routes/goals.js, teller/routes/settings.js, teller/views/accounts.ejs
- scripts/import-csv-cli.js, .github/workflows/csv-import.yml
- CLAUDE.md (the Plaid re-auth gotcha only)
- tests/scan-oct-batch4.test.js (new), tests/contract/bank-durability.contract.test.js (new), tests/teller.test.js, tests/scan-sept-batch4.test.js, tests/scan-sept-batch9.test.js, tests/cycle-fixes.test.js

CHANGES:
F17  | database.js, enrollments.js, investments.js, investment-performance.js | CREATE OR REPLACE FUNCTION perfin_try_decrypt (plpgsql, EXCEPTION → NULL); used by the Teller sync / balance / unlink reads and every Plaid token read (transactions, balances, recurring, holdings, flows, investment unlink). The Plaid unlink and the webhook-secret read keep their own try/catch
F18  | investments.js, settings.js, CLAUDE.md | findDuplicatePlaidItem + releasePlaidItem + duplicateItemResponse; exchange-transactions and hosted-link-complete fetch accounts BEFORE storing and release the Item on a duplicate or on a pre-store failure; liabilities and decryption hints say "unlink and link again"; the CLAUDE.md gotcha rewritten
F19  | import-csv-cli.js, csv-import.yml | SAVEPOINT csv_row per INSERT; process.exitCode = 1 when any file failed; CSV_IMPORTED_LIST manifest; the remove/commit steps read it and run on success OR failure of the import step
F25  | subscriptions.js | SAVEPOINT csv_balance; label_match ORDER BY + ambiguity skip; owed = credit || loan; to_char(balance_updated_at AT TIME ZONE APP_TIMEZONE); balance_updated_at = newest included row date at local noon
F22  | investments.js, enrollments.js, accounts.ejs | holdings upsert keeps is_active (RETURNING id, is_active; removed accounts skipped); DELETE /api/plaid/investment-items/:id; GET /api/items appends provider 'plaid_investment'; the page routes its unlink there
F27  | investments.js | withPlaidTxnLock (bounded by PLAID_LOCK_MAX_WAIT_MS); syncAllPlaidTransactions → lock + syncAllPlaidTransactionsOnce; reconcilePlaidTransactions resets + walks inside the lock
F24  | database.js, investment-performance.js | ADD COLUMN investment_accounts.flows_synced_at; stamped for the Item's accounts after a complete walk; coverage query requires it; skip codes
F28  | investments.js | `??` for apr / minimum_payment_amount / last_payment_amount / interest_rate_percentage; NO_LIABILITY_ACCOUNTS + ADDITIONAL_CONSENT_REQUIRED handling; hasLiabilityAccount gate on the balance path; syncPlaidLiabilities exported
F29  | enrollments.js, goals.js | parseMoneyField (finite / nullable); 400s
F30  | investment-performance.js, enrollments.js | snapshotDay(); snapshot_date::text; Teller category [String(category)]

TEST RESULTS: passed — npm test 1558/1558, 0 todo (+11 in tests/scan-oct-batch4.test.js; the 10 behavioural ones fail against the pre-fix code). Contract suite 57/57 on local PG16 (+13 in tests/contract/bank-durability.contract.test.js, all failing pre-fix — real wrong-key ciphertext, the 409 duplicate guard, the loan roll-forward, removed accounts, investments-only unlink, flow coverage, a 0% APR, NaN rejection, a comma category). scripts/ci-migration-test.js passes (twice). Playwright 35/35 (the Accounts page change). Updated pins: teller.test.js (category is an array param), scan-sept-batch4 (DC-6 UPDATE params now carry the as-of date), scan-sept-batch9 (`git rm -q -- "$f"`), cycle-fixes (the liabilities hint wording).
REGRESSION RISKS:
- A second link of a bank that is already connected is now refused (409). Adding new accounts at the same login therefore needs unlink + link while any existing account overlaps (G3 update mode is the real fix).
- A corrupted or wrong-key token now reads as NULL everywhere (reported as decryption_failed) instead of failing the whole query.
- After a 10-minute stall of a Plaid sync, a queued sync/reconcile proceeds anyway (overlap only in that already-broken case).
- A user-removed Plaid investment account can no longer be revived by a sync — only by linking again.
- TWR/XIRR coverage shrinks until each Plaid account's flows have synced once after deploy (the first sync-balances / auto-sync stamps it) — expected, temporarily "partial".
- A CSV-imported manual balance is now stamped as of its newest statement row, not "now" (the "updated" time on the account changes meaning).
- An invalid APP_TIMEZONE makes the CSV roll-forward fail (logged, import kept).
INVARIANTS AT RISK: None violated. INV-22 now actually holds (decryption_failed is reachable — before, a mismatch raised). INV-04 strengthened (reconcile can't race a cursor write). INV-87 kept (removed accounts' holdings aren't rewritten; prune still per returned account). INV-88 unchanged. INV-01/54 unchanged (contract re-sync tests green).
NET SCORE: 0 − 0 = 0 (none of the ten had evidence of firing this month — the scan reproduced F17 on PG16 but no stale token is known to exist in production; the two new failure modes found in review — an unbounded lock and an orphaned Item on a pre-store error — were closed before commit.)

OPERATOR ACTIONS / DEPLOY:
- If Sync Health shows "need re-authentication" for a Plaid bank: unlink it on the Accounts page, then link it again (a plain re-link is now refused) | BLOCKS DEPLOY: N
- After deploy, run "Sync Balances" once so each Plaid investment account's flows sync and TWR/XIRR coverage returns to "all" | BLOCKS DEPLOY: N
Deploy: Platform, Shell & Auth — Render auto-deploys on push to `main` (merge the PR); alt `fly deploy`.

(Not complete in production until blocking operator actions are done AND the deploy step is confirmed.)

FOLLOW-ON ITEMS:
- G3 (Plaid Link update mode) — the real re-auth fix; the duplicate guard is the stop-gap.
- POST /api/plaid/exchange (investments-only) has no duplicate guard — it upserts by item_id into plaid_investment_items, so a re-link creates a second registry Item too.
- The dashboard's setCreditLimit turns a non-numeric input into null (clears the limit) — a UI quirk; the server accepts null by design.
- Plaid's own upsertTxn still builds its legacy category as a "{a,b}" literal (already in Known Open Issues).
- The data-health "does any token decrypt?" probe could now use perfin_try_decrypt (it doesn't live-decrypt today).
- Batches 5–13 of the cycle-7 plan remain (see .cycle/STATE.md).
DOCUMENTATION UPDATES NEEDED:
- CLAUDE.md: perfin_try_decrypt in Operator state item 2 + INV-22 + the "decryption_failed" endpoint notes (sync-transactions / sync-holdings); Known Open Issues (F17/F18 resolved, the duplicate-guard limitation); POST /api/plaid/exchange-transactions + hosted-link-complete 409 behaviour; DELETE /api/plaid/investment-items/:id + GET /api/items provider 'plaid_investment' in the endpoint list; holdings sync keeps a user removal; investment_accounts.flows_synced_at + coverage scope in the performance-history endpoint / Investments widget text; Plaid sync/reconcile lock (Key Design Decisions — reconcile bullet); liabilities skip codes + `??`; balance PATCH validation; CSV import (CLI exit code + manifest, csv-import.yml removal rule, the roll-forward rules: label > institution, ambiguity skip, loan sign, as-of stamp, savepoint); snapshot dates; Teller category text[]; test counts 1558 / 71 files (Perfin 1102) + scan-oct-batch4 + the bank-durability contract file; contract count 57.
- README.md: counts; CSV upload workflow note.
---END BROAD SCAN IMPLEMENTATION SUMMARY---
