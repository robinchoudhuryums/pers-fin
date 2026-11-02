---BROAD SCAN IMPLEMENTATION SUMMARY---
Findings implemented:
- F41 — a new merchant rename rule takes the rows another rule renamed that it also matches (rules re-apply most specific first), and re-keys only the detection keys no transaction still carries — a specific "AMAZON PRIME" rule no longer moves the broad "Amazon" rule's cancelled subscription (and its state) to the new name, nor lets the next detection run recreate "Amazon" as a fresh active subscription
- F46 — a price change survives a detection run with no new charge: prior_amount and amount_changed are kept until a later charge (both used to be recomputed from the unchanged amount on the next run, so the PRICE UP badge and the watchdog's rise lasted one run)
- F47 — the watchdog also alerts on a charge 10–50% above a subscription's price before detection moves the price (not a utility; once per charged amount via price_alerted_amount); the existing rise rule needed detection to re-anchor first, which takes three charges at the new price
- F5 — a restored transaction takes its rename rule's CURRENT name (a deleted or switched-off rule's rename is cleared), then every rule applies; a restore used to bring back the name of a rule deleted / renamed while the row was gone (INV-124)
- F43 — a reconcile applies the rename rules to the rows it recovers (Teller: after syncAllEnrollments; Plaid: renameNewRows after the re-walk) — never the anomaly check (INV-05)
- F4 — CSV-overlap Resolve tombstones (with a snapshot and source) the CSV rows it deletes, in one transaction, so re-importing the CSV file doesn't bring them back and they can be restored (INV-111 / INV-145)
- F6 — a deleted Plaid id the bank later REMOVED (a reversal, a voided charge) isn't restored (409 removed_by_bank); one the bank CHANGED is restored and flagged stale, and the toast says to run a Plaid Reconcile Now
- F54 — /api/income-summary's top sources (and the Sheets Income tab's mirror) group by the display name, so a renamed payroll source is one row
New capabilities (G/ST): None
Files modified:
- teller/routes/merchant-rename.js
- scripts/detect-subscriptions.js
- teller/routes/subscriptions.js
- teller/routes/transactions.js
- teller/services/database.js
- teller/routes/investments.js
- teller/routes/enrollments.js
- teller/public/perfin-shared.js
- teller/routes/spending-analytics.js
- scripts/sheets-sync.js
- tests/broad-scan-c8-batch3.test.js (new)
- tests/contract/c8-batch3.contract.test.js (new)
- tests/roadmap-t2-5-u1.test.js
- tests/scan-sept-batch4.test.js

CHANGES:
F41 | teller/routes/merchant-rename.js | createRenameRule reads the covered rows' detection keys first (unnamed or rule-named rows the pattern matches), upserts the rule, moves its own earlier rows to the new name, RELEASES rows another rule renamed that this pattern matches (user_merchant_rule_id <> the new rule — hand renames untouched), runs applyRenameRules, then re-keys only the old keys no transaction still carries ("vacated").
F46 | scripts/detect-subscriptions.js | The upsert sets prior_amount = the stored amount only when the amount changes (else keeps it), and amount_changed = true on a change, false once last_charged moves past the stored one, else kept.
F47 | teller/routes/subscriptions.js | runSubscriptionWatchdog adds an "early rise" query: an active, uncancelled, non-utility subscription whose latest settled charge after last_charged (≤45 days) is >110% and ≤150% of its amount, and price_alerted_amount isn't that charge → "<name> went up from $X to $Y" (tag sub-price-<id>); marked only when logged.
F5 | teller/routes/transactions.js | restoreDeleted, after inserting: a snapshot row with user_merchant_rule_id takes the rule's current rename_to when it is active, else loses the name and the rule id; then applyRenameRules(client).
F43 | teller/routes/enrollments.js, teller/routes/investments.js | reconcileTeller applies the rename rules (logged on failure) when it added rows; reconcilePlaidTransactions calls renameNewRows(transactions_added).
F4 | teller/routes/transactions.js | /api/transactions/csv-overlap/resolve runs BEGIN → INSERT INTO deleted_transactions (jsonb row + splits snapshot, SOURCE_SQL) ON CONFLICT DO UPDATE → DELETE → COMMIT.
F6 | teller/services/database.js, teller/routes/investments.js, teller/routes/transactions.js, teller/public/perfin-shared.js | deleted_transactions.bank_changed_at / bank_removed_at; Plaid's modified handler stamps bank_changed_at when the tombstone skipped the upsert, its removed handler stamps bank_removed_at; restore 409s a removed row and returns stale: true for a changed one; restoreMessage adds the Reconcile Now line.
F54 | teller/routes/spending-analytics.js, scripts/sheets-sync.js | Top income sources SELECT and GROUP BY COALESCE(user_merchant_name, merchant_name, name).
Tests | tests/broad-scan-c8-batch3.test.js, tests/contract/c8-batch3.contract.test.js, tests/roadmap-t2-5-u1.test.js, tests/scan-sept-batch4.test.js | 15 unit tests (restore 409 / stale / the rule's current name / a cleared rename / applyRenameRules on the client; the stale toast run in a vm; createRenameRule's release + vacated-only re-key over a fake pool; reconcileTeller renaming recovered rows through the real Teller engine without the anomaly check; source pins for F46 / F47 / F4 / F54 / the Plaid hooks) + 8 contract tests on real Postgres (F41 ×2, F46, F47, F4, F5, F6, F54). The U1 fakes match the widened SELECT; the DC-7 pin follows the new amount_changed CASE. Mutation checks 10/10 red.

TEST RESULTS: passed — npm test 2613/2613 (one run had 1 failure, the known roadmap-t2-4-x2a node:test IPC flake; the re-run was clean); contract suite 262/262 (local Postgres 16, no pgvector); Playwright 72/72 (scratch config → preinstalled Chromium).
REGRESSION RISKS:
- F41: creating a rule now releases rows another rule renamed that the new pattern matches, then re-applies all rules most specific first — a NEW broad rule that matches rows a more specific rule owns releases them, and the specific rule takes them back in the same pass (by RULE_ORDER_SQL), so the result is unchanged but those rows are rewritten.
- F41: a key some rows still carry keeps its detection row; the moved rows' new name gets a fresh detection row on the next run (no user state carried) — the trade for not moving a cancelled subscription that still owns other rows.
- F47: a one-off higher charge (an add-on, a prorated upgrade, a tax change) 10–50% above the price pushes a "went up" alert once; a utility is excluded, but a variable non-utility subscription can still false-alert once per distinct amount.
- F6: only Plaid marks tombstones (Teller has no removed / modified signal) — a Teller row the bank changed while deleted is restored as the old copy without the stale note.
- F46: a price change detected then reverted (a refunded overcharge) keeps PRICE UP until the next charge.
INVARIANTS AT RISK: None violated. Touched: INV-124 (rename rules — a hand rename still always wins: the release only clears rule-named rows, and a restore applies the rule's current state), INV-123 (watchdog — once per charged amount, marked only when logged), INV-111 / INV-145 (Resolve tombstones; restore never duplicates and now also refuses a bank-removed row), INV-05 / INV-67 (reconcile renames but still never runs the anomaly check), INV-48 (the Sheets mirror changed only its grouping column, not a canonical fragment).
NET SCORE: 2 − 2 = 0 (production fixes: F46 — every price change lost its PRICE UP badge on the next detection run (daily-sync runs detection daily); F54 — a renamed payroll source split the income summary for anyone with a rename. F41, F5, F43, F4, F6, F47 depend on rule / restore / Resolve / reconcile sequences with no evidence they occurred this month. New failure modes: F47's one-off higher charge alert, F41's fresh detection row without user state for a partly-vacated key)

OPERATOR ACTIONS / DEPLOY:
- None
Deploy: Detection & Categorization / Bank Sync / Financial Analytics — Render auto-deploys on push to `main` (configured in the Render dashboard). Sheets & External Export: the server-side sheets-sync.js ships with the same deploy (no clasp push — Code.gs unchanged).

(Not complete in production until blocking operator actions are done AND
the deploy step is confirmed.)

FOLLOW-ON ITEMS:
- Teller has no removed / modified signal, so F6's stale / removed handling is Plaid-only.
- The early-rise alert has no "this was a one-off" dismissal; the next distinct amount alerts again.
- tests/roadmap-t2-4-x2a.test.js intermittently fails with a node:test runner IPC error (pre-existing, seen in Batch 1–3 runs).
DOCUMENTATION UPDATES NEEDED:
- CLAUDE.md Merchant rename rules + routes/merchant-rename.js entry: a new rule takes rows other rules renamed (most specific wins) and re-keys only fully vacated keys (F41); restore follows the rule's current state (F5); a reconcile applies the rules (F43).
- CLAUDE.md Subscription detection / Watchdog: prior_amount + amount_changed kept until a later charge (F46); the early-rise alert (10–50%, non-utility, once per amount — F47).
- CLAUDE.md Transaction deduplication / Undelete + deleted_transactions columns: bank_changed_at / bank_removed_at, the 409 removed_by_bank and the stale flag + toast (F6); CSV-overlap Resolve tombstones (F4); the /api/transactions/csv-overlap/resolve and restore endpoint notes.
- CLAUDE.md /api/income-summary: top sources by display name (F54).
- CLAUDE.md test counts (2598 → 2613 tests, 135 → 136 files; contract 254 → 262), the new test files, INV-124 / INV-123 / INV-145 wording, and the cycle-8 Known Open Issues section (Batch 3 done + follow-ons).
---END BROAD SCAN IMPLEMENTATION SUMMARY---
