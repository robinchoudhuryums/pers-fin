---BROAD SCAN IMPLEMENTATION SUMMARY---
Findings implemented:
- F13 — reconnecting a Teller bank left the old enrollment behind with no accounts: never listed, no Unlink button, DISCONNECTED (or decryption_failed) on every sync, "Reconnect <bank>" on the nav badge for good
- F14 — a manual account with any transaction couldn't be deleted (a foreign-key error, answered 500)
- F15 — a generic CSV with separate Debit / Credit columns imported every credit as $0 "unparseable", or with Credit first imported a paycheck as spending
- F16 — a Plaid row first inserted through a `modified` delivery wasn't counted as added, so rename rules, the anomaly check and "Paycheck landed" were skipped for it
- F17 — unlinking an investments-only Plaid item whose token can't be read left its accounts active, and the duplicate guard then refused the re-link
- F18 — `last_txn_sync_at` was stamped on runs that synced nothing; a failed read in `recordSyncResultNow` wiped the other providers' errors; a webhook-triggered partial sync was marked done
- F19 — the Plaid webhook dedupe key hashed the whole token, so a captured delivery could be replayed with a re-encoded signature
- F35 — re-linking a goal to a different funding account reset its progress to the pre-link amount
- F36 — the budget alert's rollover depended on a snapshot written only by an activity-gated job, so an away user could get "Budget exceeded" at the base limit
New capabilities (G/ST): None
Files modified:
- teller/routes/enrollments.js
- teller/routes/investments.js
- teller/routes/goals.js
- teller/routes/subscriptions.js
- teller/routes/teller-webhook-events.js
- teller/routes/plaid-webhook-events.js
- teller/services/webhook-verify.js
- teller/data/csv-formats.js
- teller/startup.js
- teller/views/accounts.ejs
- teller/views/dashboard.ejs
- scripts/import-csv-cli.js
- tests/cycle9-b7.test.js (new, 52 tests)
- tests/contract/c9-batch7.contract.test.js (new, 10 tests)
- tests/cycle-fixes.test.js, tests/roadmap-t2-webhooks-w2.test.js, tests/scan-oct-batch16.test.js, tests/scan-oct-batch5.test.js (a double and three pins that encoded the old behaviour)
- .cycle/STATE.md, .cycle/blocks/9-batch7-broad-implement.md

CHANGES:
F13 | teller/routes/enrollments.js | New `retireEmptyEnrollments(db, keepId)` (`RETIRE_EMPTY_ENROLLMENTS_SQL`): deletes a Teller enrollment that has no linked accounts while another enrollment at the same institution (name, case-insensitive) has some. `POST /api/enroll` runs it inside the link's transaction after the accounts are re-pointed, never retiring the enrollment it just created, and returns `retired_enrollments`. `syncAllEnrollments` runs it first (fail-soft), so one stranded before this fix goes at the next sync. Not revoked at Teller.
F14 | teller/routes/enrollments.js | `DELETE /api/accounts/manual/:id` locks the account, counts its transactions and answers 409 `{ reason: "has_transactions", transactions, error }` until the caller confirms with `?delete_transactions=1` (or body `delete_transactions: true`); then the transactions (splits by cascade), the account's balance snapshots and the account go in one database transaction → `{ deleted: true, transactions_deleted }`. An empty account needs no confirmation; a malformed id is a 404 with no query.
F14 | teller/views/accounts.ejs | On that 409 the page asks "<name> has N transactions. Remove the account and those transactions? This can't be undone." and retries with the confirmation.
F15 | teller/data/csv-formats.js | The generic parser recognises separate money-out / money-in columns (Debit / Credit, Withdrawals / Deposits, Money Out / Money In, "… Amount" forms; whole names, any case; only when there is no Amount column): amount = |debit| − |credit|, NaN when both are blank. `positiveMeans` doesn't apply to such a row. New exports `twoColumnKeys`, `isTwoColumnGeneric`.
F15 | teller/routes/subscriptions.js, scripts/import-csv-cli.js, teller/views/accounts.ejs, teller/views/dashboard.ejs | For a two-column file the preview and import report `positive_means: null` / `sign_guess: null` (like a known bank format), the CLI doesn't warn about the sign, and both upload forms hide the sign select.
F16 | teller/routes/investments.js | In `syncPlaidItemTransactions`, a `modified` row the upsert INSERTED counts in `added` (not `modified`); a row already present is still `modified`; a tombstoned row is neither.
F17 | teller/routes/investments.js | `findDuplicateInvestmentItem` inner-joins `plaid_investment_items` — a match needs a registered connection at that institution. The investments-only unlink, when it couldn't list the accounts (unreadable token, no Plaid client, accountsGet failed), deactivates the active Plaid investment accounts under the Item's institution name and drops their holdings — unless another connection (another registry row, or a GOOD plaid_items row) has that institution name, in which case nothing is guessed.
F18 | teller/routes/enrollments.js | `runTransactionSync` stamps `last_txn_sync_at` only when `transactionRunSynced(result)` — a connection synced, or the run was clean with nothing to do; a run of errors with no connection synced doesn't. `recordSyncResultNow` writes nothing when its read of the stored map fails and returns this run's own outcome with `recorded: false`.
F18 | teller/routes/teller-webhook-events.js, teller/routes/plaid-webhook-events.js | A webhook-triggered sync whose result carries errors (a partial sync) fails its event, after the post-sync steps for the rows it did add.
F19 | teller/services/webhook-verify.js | The Plaid dedupe key is `"jwt:" + sha256(header.payload)` — the signed bytes — instead of the whole token.
F35 | teller/routes/goals.js | When `PATCH /api/goals/:id` infers a baseline for a funding link, the goal's progress is `deriveGoalProgress` of the goal with its present funding source (balance − baseline), not the stored pre-link `current_amount`. Saving the same link again leaves the baseline unchanged.
F36 | teller/startup.js | `runBudgetAlertTick`, when any budget has rollover on, calls `runBudgetSnapshot(pool)` (refreshed on days 1–5, created only if missing afterwards) and re-reads the status when a snapshot was written. A failure is logged and the alert goes out on what it had.

TEST RESULTS: passed.
- `npm test`: 3544 / 3544 (52 new; 187 test files; Perfin 2775, Per-sistant 769).
- Route contract suite on a local Postgres 16: 393 / 393 (10 new).
- Playwright: 93 / 93.
- The new unit file and six neighbouring files under five shifted clocks (2026-12-31, 2027-01-31, 2027-03-14, 2027-11-07, 2028-02-29): 217 / 217 each. The contract file was not run under a shifted clock.
- Mutation check: against the pre-fix source the new files fail 39 of 52 (unit; the other 13 are unchanged-behaviour guards) and 10 of 10 (contract — its cases build on each other).
- One intermittent failure seen once in the first full run and not again: tests/roadmap-t3-3-k2.test.js with the node:test runner error "Unable to deserialize cloned data" (pre-existing, listed in CLAUDE.md's Known Open Issues).
- Regression scenarios: S1 (re-sync is idempotent) PASS by tests/sync-idempotency.test.js and the sync-ai contract suite; S4 PASS by the contract and e2e runs; S2, S3, S5, S6, SK1–SK5 not applicable to the files changed.

REGRESSION RISKS:
- An enrollment with no accounts is deleted at the next sync when another enrollment at the same institution name has accounts. A genuine second login at the same bank that linked zero accounts would be removed too.
- The retired enrollment is not revoked at Teller, so it stays live on Teller's side.
- With the duplicate guard relaxed, investment accounts that an earlier unlink left active with no connection no longer block a re-link — but they stay active, so after the re-link the same account is listed twice (and counted twice in net worth) until the old row is removed by hand on the Accounts page.
- The unlink's institution-name fallback deactivates every active Plaid investment account under that institution name when no other connection has the name.
- `DELETE /api/accounts/manual/:id` now answers 409 where it answered 500, and 404 (not 500) for a malformed id; a caller that relied on a bare DELETE removing a non-empty account still doesn't get that without the confirmation.
- A two-column CSV whose Debit column is printed negative was imported before with those rows as credits; importing it again now adds the corrected rows beside the old ones (new dedup ids). Credit rows of any two-column file imported before are new rows now.
- A partial webhook sync now marks its event `failed`, so Sync Health shows "N webhook event(s) failed in the last 24 hours" while a connection keeps failing partway.
- After deploy, a Plaid event recorded under the old key and re-delivered by Plaid is processed once more (each is an idempotent sync).
- The budget-alert job (every 3 hours, not activity-gated) now writes last month's snapshot on days 1–5 for anyone with a rollover budget, including a limit edited in those days.
- `last_txn_sync_at` no longer moves on a run where every connection failed, so the global "transactions" freshness reads older in that case — which is the point.

INVARIANTS AT RISK: None broken. INV-01 / INV-54 hold (`added` still counts only genuine inserts — a modified-insert is one; re-delivery adds 0, tested). INV-68 holds and is tightened (a failed read no longer overwrites the per-provider map). INV-137 holds (verification unchanged; the dedupe key is narrower). INV-138 / INV-140 hold (the handlers still sync one item / enrollment and record nothing global). INV-107 holds for a connected Item (the guard still refuses a duplicate of a registered connection). INV-73 / INV-121 hold (the alert calls `runBudgetSnapshot`; no new budget_snapshots SQL). INV-77 holds (the alert is still ungated). INV-125 holds (preview, import and CLI share the parser; a two-column file has no sign option in any of them). INV-106 holds (no bare catch added outside the sanctioned ROLLBACK idiom). Wording to update at /sync-docs: INV-107 (the guard needs a registered connection), INV-125, INV-137 (signed bytes), INV-138 / INV-140 (a partial sync fails the event).
NET SCORE: 0 − 2 = −2
- Production fixes this month: 0 that I can confirm. Each needs an event I can't see in production: a Teller reconnect (F13), deleting a manual account that has entries (F14), importing a Debit / Credit file (F15), a first insert through `modified` (F16), an unlink with an unreadable token (F17), a sync in which every connection failed or a failed settings read (F18), a replayed webhook (F19), re-linking a goal (F35), a rollover budget with the user away over a month end (F36).
- New failure modes: 2 — a zero-account second login at the same bank is retired at the next sync (Low); a stranded investment account is listed twice after a now-permitted re-link until removed by hand (Low).

OPERATOR ACTIONS / DEPLOY:
- None required. | BLOCKS DEPLOY: N
- Optional: if Accounts shows a bank's investment account that has no connection (left by an earlier unlink), remove it there before or after linking the bank again. | BLOCKS DEPLOY: N
Deploy: Bank Sync & Ingestion / Financial Analytics / Platform, Shell & Auth / Web UI — Render auto-deploys on push to `main` (this work is on `claude/gracious-maxwell-li0vm7`; no PR opened). No migration.

(Not complete in production until blocking operator actions are done AND
the deploy step is confirmed.)

FOLLOW-ON ITEMS:
- F13's other half: when Teller issues NEW account ids on a reconnect, the old enrollment keeps its accounts and the transactions are duplicated under the new ones. There is no Teller equivalent of the Plaid duplicate-Item guard.
- An empty enrollment at an institution with no other enrollment is still never listed and can't be unlinked from the page.
- Unlinking a Teller enrollment or a Plaid item doesn't remove its accounts' balance snapshots (the manual delete now does).
- A re-link after F17 doesn't deactivate a stranded same-institution account with the same mask; it is left for the user to remove.
- The generic parser's two-column names are a fixed list; a file that names them otherwise ("Out" / "In", "Charges" / "Payments") is still read as one column.
- `transactionRunSynced` counts a partly failed run as synced, and the bank auto-sync and the reconcile keep their own stamping rules.
- `recordSyncResult`'s write (the UPDATE) still only logs when it fails.
- Two Plaid deliveries with the same body in the same second now share a dedupe key; the second is treated as a duplicate (the first already triggered the sync).
- In-app `GET /api/budgets/alerts` and the Budgets page still depend on the snapshot job for last month's rollover (it runs within minutes of the user's return).
- The balance-snapshot delete for a manual account has no test for a failing statement of its own (the rollback is tested on the account delete).

DOCUMENTATION UPDATES NEEDED:
- CLAUDE.md: the enrollments.js tree entry (retireEmptyEnrollments, the manual-account delete, transactionRunSynced, recordSyncResult's failed read); csv-formats.js (two-column generic files), the CSV import feature text and the import-csv-cli.js entry; investments.js (modified-inserts counted as added, the guard's inner join, the unlink fallback); plaid- / teller-webhook-events.js (a partial sync fails the event); webhook-verify.js (the dedupe key); goals.js / Goal funding (baseline from derived progress); Budget alerts and Scheduled Tasks (the alert takes the snapshot); the API list (`POST /api/enroll` → retired_enrollments, `DELETE /api/accounts/manual/:id`, the CSV preview's positive_means, `DELETE /api/plaid/investment-items/:id`); the Plaid re-link gotcha (the investments-only guard); Known Open Issues (Batch 7 done with its follow-ons); INV-107 / 125 / 137 / 138 / 140 wording; the test list (tests/cycle9-b7.test.js, tests/contract/c9-batch7) and counts (3544 tests, 187 files, Perfin 2775; contract 393).
- README: test counts.
---END BROAD SCAN IMPLEMENTATION SUMMARY---
