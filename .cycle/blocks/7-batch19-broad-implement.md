---BROAD SCAN IMPLEMENTATION SUMMARY---
Findings implemented:
- Batch 4 follow-on — the investments-only POST /api/plaid/exchange had no duplicate-Item guard; it now refuses a duplicate (F18 guard, absorbed into Batch 19 by `.cycle/plan-cycle7-expansion.md`)
New capabilities (G/ST):
- G3 — Plaid Link update mode: "Re-authenticate" and "Add accounts" on an existing Plaid connection keep the same Item, its transactions and the edits on them (it used to take unlink + link); a newly flagged item notifies once and the Sync Health issue deep-links to /accounts
Files modified:
- teller/routes/investments.js, teller/routes/enrollments.js, teller/routes/settings.js, teller/services/database.js
- teller/views/accounts.ejs, teller/views/settings.ejs, teller/views/dashboard.ejs
- tests: tests/scan-oct-batch19.test.js (new, 18), tests/contract/plaid-update.contract.test.js (new, 6); tests/contract/bank-durability.contract.test.js (the F18 error-text regex now expects the update-mode advice)

CHANGES:
G3 | investments.js | loadUpdateItem({ item_id, kind }): kind 'transactions' → plaid_items.id, 'investments' → plaid_investment_items.id; token read via perfin_try_decrypt; 400 on a bad kind/id or a CSV item, 404 unknown, 409 { reason: "decryption_failed" } with the unlink-then-link advice (the only case that still needs it)
G3 | investments.js | POST /api/plaid/link-token-update — linkTokenCreate with the item's access_token, no products, update: { account_selection_enabled: true }
G3 | investments.js | POST /api/plaid/update-complete — no token exchange. transactions: inside withPlaidTxnLock, accountsGet → registerMissingPlaidAccounts (before the walk, BSI-1) → clear last_error_code → syncPlaidItemTransactions for that item only → { accounts_added, transactions_added, incomplete? }; a re-auth error code re-sets the flag and answers 409. investments: accountsGet → count new investment accounts → syncAllPlaidHoldings({ itemId }) for that Item → { accounts_added, transactions_added: 0, holdings_updated }
G3 | investments.js | syncAllPlaidHoldings({ itemId } = {}) — optional one-Item filter ($2::text IS NULL OR item_id = $2); existing callers unchanged
G3 | investments.js | setPlaidItemErrorCode: the set path writes only when the code changes (IS DISTINCT FROM) and, when the item had NO code before, sends one "Bank connection needs re-authentication" notification (tag plaid-reauth-<id>, url /accounts); fail-soft
B4 follow-on | investments.js, database.js | the investments exchange calls accountsGet before storing anything and refuses a duplicate via findDuplicateInvestmentItem (findDuplicatePlaidItem, then an ACTIVE Plaid investment account at the same institution with the same mask + type that isn't the new Item's own) — the new Item released at Plaid, 409, nothing stored; a pre-store failure releases it too. New investment_accounts.mask column, written by both exchange paths and the holdings sync (COALESCE keeps a known mask)
G3 | investments.js | duplicateItemResponse (all three exchange routes) now points to "Re-authenticate / Add accounts on the existing connection" instead of unlink + link
G3 | enrollments.js | GET /api/items returns last_error_code (NULL for investments-only items)
G3 | settings.js, settings.ejs, dashboard.ejs | the "N Plaid item(s) need re-authentication" issue says "open Accounts → Re-authenticate" and carries link: "/accounts"; Sync Health and the dashboard strip render an issue's link (withBase)
G3 | accounts.ejs | a connected Plaid item (not CSV, not Teller) shows "Add accounts", plus "Re-authenticate" and a "needs re-authentication" note when flagged; updatePlaidItem opens Link with the update token (ensurePlaidSdk, shared with the investments link) and on success POSTs update-complete, both through writeOk, then reloads the list

TEST RESULTS: passed — npm test 1825/1825 (+18); contract suite 152/152 (+6, local Postgres without pgvector); migrations run twice cleanly; Playwright 35/35. Mutation checks: skipping the investments duplicate guard turns the unit tests red (2); registering accounts AFTER the sync turns both the unit ordering test and the contract test red. One existing contract assertion updated for the new duplicate-guard wording (intent unchanged).
REGRESSION RISKS:
- The investments-only exchange makes one more Plaid call (accountsGet) before storing; if it fails, the link is released and fails, where before the holdings call alone decided.
- The duplicate guard for investments-only Items matches by institution NAME + mask + type: a genuinely separate second login at the same broker whose account has the same last digits and type would be refused (unlikely). Rows synced before the mask column exist carry no mask until the next holdings sync, so the guard can't see them until then.
- The F18 409 text changed on all three exchange routes (UI shows it verbatim).
- setPlaidItemErrorCode no longer rewrites an unchanged code (updated_at not bumped on a repeat).
INVARIANTS AT RISK: None. INV-04 holds (accounts registered before the walk; the cursor walk itself is unchanged); INV-22 holds (perfin_try_decrypt); INV-107 extended to the investments-only exchange; INV-19 holds (helpers attached after module.exports = router); INV-54 / INV-01 hold (update-complete reuses syncPlaidItemTransactions — the contract test shows no duplicate rows and the user edits intact); F27's lock covers update-complete.
NET SCORE: 0 − 1 = −1 (G3 is new capability; the absorbed duplicate guard is preventive — no duplicate investments-only link is known to have happened. New failure mode: the name + mask + type guard can refuse a genuinely separate same-broker login with a matching account.)

OPERATOR ACTIONS / DEPLOY:
- None required. After deploying, the existing re-auth items show "Re-authenticate" on the Accounts page | BLOCKS DEPLOY: N
Deploy: Platform, Shell & Auth — Render auto-deploys on push to `main` (investment_accounts.mask auto-migrates). No Apps Script change.

(Not complete in production until blocking operator actions are done AND the deploy step is confirmed.)

FOLLOW-ON ITEMS:
- Update mode uses the in-page Link (popup OAuth); the hosted / redirect flow the Accounts page uses for iOS Safari has no update-mode variant, so Re-authenticate may not open on iOS Safari.
- update-complete doesn't refresh balances / liabilities for a newly added account (the next balance sync does) and doesn't write last_sync_result, so a stale plaid_txn error for the item stays in Sync Health until the next full sync.
- Investments-only Items have no last_error_code (the holdings sync doesn't record re-auth codes), so they only ever show "Add accounts" (which also re-authenticates in update mode).
- A Transactions Item that gains a brokerage account in update mode gets its holdings at the next holdings sync, not in update-complete.
- The duplicate guards still don't cover a CSV-only bank later linked via Plaid (the CSV-overlap tool handles that).
DOCUMENTATION UPDATES NEEDED:
- CLAUDE.md: Commands (POST /api/plaid/link-token-update, POST /api/plaid/update-complete, the investments exchange 409, GET /api/items last_error_code), the two "unlink + link" gotchas (Plaid re-auth → Re-authenticate / Add accounts; only decryption_failed needs unlink + link), the F18 duplicate-guard text, investment_accounts.mask (Database), data-health issue link, the re-auth notification, Known Open Issues (G3 done; the Batch 4 "investments exchange has no duplicate guard" bullet resolved; Batch 19 follow-ons; expansion progress), new INV (update mode keeps the Item), counts (1825 tests / 88 files; Perfin 1298; contract 152 + test-file descriptions).
- README: counts / Plaid re-auth wording.
---END BROAD SCAN IMPLEMENTATION SUMMARY---
