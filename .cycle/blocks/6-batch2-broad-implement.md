---BROAD SCAN IMPLEMENTATION SUMMARY---
Findings implemented:
- BSI-1 — Plaid registers accounts an item gained after link BEFORE walking the cursor (no permanent FK stall); a halted walk surfaces as partial_sync_incomplete
- BSI-2 (+DD-1) — POST /api/sync (dashboard button + daily-sync.yml backstop) covers Teller AND Plaid; ONE anomaly check runs over the combined added count, so Plaid charges get anomaly alerts
- BSI-7 — Teller row-insert failure holds the enrollment watermark (and reports partial_sync_incomplete)
- BSI-8 — Teller incremental floor re-reads a 7-day lookback behind the watermark (late-posting sibling-account charges no longer skipped)
- BSI-9 — Teller 401/403 on every account → enrollment DISCONNECTED (was unreachable); auto-restored to GOOD on the next clean sync
- BSI-10 — CSV virtual items excluded from the Plaid re-auth count; real ITEM_* re-auth errors recorded in plaid_items.last_error_code and cleared on success/re-link
- BSI-11 — last_sync_result merged per provider (no last-writer-wins); reconcile + investment-flow results recorded; a failed reconcile no longer stamps last_txn_sync_at
- DD-8 — Teller re-link re-points teller_enrollment_id on existing accounts
- DD-9 — syncAllBalances registers Teller accounts opened after enrollment; counts only matched updates
- DD-10 — per-account Teller balance failures reach errors[]; Teller client retries 429 (honoring Retry-After, capped); flow errors recorded; Teller unlink revokes per-account
- BSI-3 — Plaid unlink calls itemRemove (best-effort), purges plaid_investment_items, deactivates the item's investment_accounts and deletes their holdings
- BSI-12 — Plaid TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION restarts the loop from the loop-start cursor (bounded, 3 restarts; loop-start cursor persisted on give-up)
Files modified:
- teller/routes/enrollments.js, teller/routes/investments.js, teller/routes/settings.js, teller/services/database.js, teller/services/teller-api.js, teller/startup.js, teller/views/dashboard.ejs, teller/views/subscriptions.ejs, .github/workflows/daily-sync.yml
- tests/scan-sept-batch2.test.js (new)

CHANGES:
BSI-7 | teller/routes/enrollments.js | syncEnrollment tracks insertError; watermark update gated on !insertError; incomplete = fetchError || insertError.
BSI-8 | teller/routes/enrollments.js | WATERMARK_LOOKBACK_DAYS = 7 + lookbackFloor(watermark, days) (date-part based, no UTC shift, unparseable → null); floorDate = backfillFrom || lookbackFloor(...). Watermark still advances to the newest date.
BSI-9 | teller/routes/enrollments.js | per-account 401/403 counted; when EVERY account failed auth, syncEnrollment throws with err.status → existing catch marks DISCONNECTED. A later clean sync restores DISCONNECTED → GOOD (added so a transient 401 can't strand balance sync, which runs GOOD-only).
DD-8 | teller/routes/enrollments.js | /api/enroll account upsert adds teller_enrollment_id = EXCLUDED.teller_enrollment_id.
BSI-2 + DD-1 | teller/routes/enrollments.js, teller/startup.js, views, daily-sync.yml | anomaly block extracted verbatim into runAnomalyCheck(); syncAllEnrollments(opts.skipAnomaly); new syncAllTransactions() = Teller (skipAnomaly) → Plaid (lazy require, failure-isolated) → one runAnomalyCheck on the combined count; returns legacy top-level keys + teller/plaid sub-results. POST /api/sync, the bank auto-sync and the pre-insights chain all use it. /api/sync still 500s when nothing synced (Teller threw and Plaid didn't succeed). Dashboard + Subscriptions sync toasts show per-institution errors. daily-sync.yml sync step gets --max-time 240.
BSI-1 | teller/routes/investments.js | syncAllPlaidTransactions calls accountsGet first (fail-soft) and registerMissingPlaidAccounts() (INSERT … ON CONFLICT DO NOTHING); the same response feeds the balance refresh (no extra API call). result.incomplete with reason row_failure/mutation_during_pagination → errors[] partial_sync_incomplete (max_pages is a normal resumable walk, not reported). items_synced counts hard failures only.
BSI-12 | teller/routes/investments.js | syncPlaidItemTransactions remembers loopStartCursor; on the mutation error code it persists + resumes from it (≤3 restarts), else incomplete_reason 'mutation_during_pagination'. Returns incomplete_reason.
BSI-10 | teller/services/database.js, investments.js, settings.js | migration ADD COLUMN IF NOT EXISTS plaid_items.last_error_code (a column, NOT a new status — every sync path filters status='GOOD', so a status flip would stop retrying and never self-clear); PLAID_REAUTH_CODES set; recorded on a re-auth error in the txn + balance sync, cleared on a clean txn sync and on re-link (both exchange upserts). data-health: total and not_good exclude status='CSV'; not_good = non-GOOD OR last_error_code set.
BSI-11 | teller/routes/enrollments.js, teller/startup.js | recordSyncResult reads the prior payload and replaces only the providers passed (null result = untouched; legacy flat payload regrouped by provider); stores { at, errors (flat union), providers }. runReconcile records teller_reconcile / plaid_reconcile and stamps last_txn_sync_at only when no leg errored (last_reconcile_at always = attempt time). Weekly self-heal reconcile records its result.
DD-9 | teller/routes/enrollments.js | syncAllBalances inserts unknown /accounts entries (ON CONFLICT DO NOTHING, never re-points); accounts_updated counts only UPDATEs that matched; returns accounts_registered.
DD-10 | teller/services/teller-api.js, enrollments.js, startup.js | 429 retried (Retry-After honored, capped 10s); per-account balance fetch failure → errors[] "balance fetch failed for <name> (<status>)"; plaid_flows recorded in /api/sync-balances and the auto-sync; Teller unlink DELETE loop per-account try.
BSI-3 | teller/routes/enrollments.js | DELETE /api/items/:id: token decrypted fail-soft (unlink must work on a passphrase mismatch); for non-CSV items accountsGet (to catch investment-only accounts) + itemRemove best-effort; in the delete transaction: DELETE plaid_investment_items by item_id, investment_accounts is_active=false + DELETE investment_holdings for the item's account ids. Response adds plaid_item_removed.

TEST RESULTS: PASSED — npm test 1169/1169 (Perfin 700 + Per-sistant 469; +26 in tests/scan-sept-batch2.test.js). New tests are behavioral (mock pool + stubbed Teller/Plaid clients); 22 of the original 24 fail against the unfixed source (the other 2 are non-regression guards). Real Postgres 16: both apps' migrations twice via scripts/ci-migration-test.js (idempotent incl. the new column), then DD-8 re-point, BSI-8 with a real pg DATE watermark, DD-1 anomaly SQL, DD-9/DD-10 balances, BSI-11 jsonb merge, BSI-1 with the real transactions FK, BSI-10 data-health counts (CSV excluded, re-auth counted then cleared), BSI-3 unlink, reconcile record+stamp: all PASS. Playwright e2e 8/8 on a live boot. Edited dashboard/subscriptions inline scripts node --check clean.
Regression scenarios: S1 PASS (sync-idempotency.test.js unchanged and green; the 7-day lookback re-reads rows but adds 0, watermark stable; BSI-12 restart re-delivery adds 0); S4 PASS (e2e: unauth redirect, PIN login, both apps render); S2/S3/S5/S6/SK1-5 NOT APPLICABLE (no files in those paths modified — the anomaly SQL was moved verbatim).

REGRESSION RISKS:
- BSI-2: POST /api/sync now also runs the Plaid transactionsSync, so the dashboard/Subscriptions "Sync Transactions" click and the daily-sync.yml step take longer (Plaid item count × pages). The response keeps the legacy top-level keys; transactions_added is now the COMBINED count and errors[] entries carry a provider field.
- BSI-2: /api/sync returns 200 when Teller threw but Plaid synced (the Teller error is in errors[] + last_sync_result); only a total no-op 500s.
- BSI-11: a provider's errors now persist until THAT provider runs again (by design). teller_reconcile errors can linger up to a week, and the auto-sync "Sync error" push can now fire for errors another writer recorded (e.g. daily-sync's balance errors) the first time they appear.
- BSI-9: DISCONNECTED is now reachable; a 401/403 on every account marks it (it self-restores on the next clean sync). A single-account enrollment whose only account is closed (403) will show as disconnected.
- BSI-8: each incremental Teller sync re-reads ~7 extra days (idempotent; may fetch one extra page).
- DD-10: per-account balance failures now appear in Sync Health / the dashboard strip, where they used to be invisible.
- BSI-12: modified/removed counters can double-count re-delivered rows after a restart (informational counters only; `added` is exact).
INVARIANTS AT RISK: None violated. INV-01 (xmax counting untouched), INV-02 (watermark now also held on an insert failure, which strengthens it), INV-03 (>= kept, floor lowered by the lookback), INV-04 (cursor still advances only after a clean page; the mutation restart re-persists the loop-start cursor), INV-05 (reconcile still skips the anomaly check, which is gated on !backfillFrom and absent from reconcilePlaidTransactions), INV-18 (all in-process), INV-19 (new exports attached after module.exports = router), INV-53 (the daily backstop now covers Plaid too), INV-54 (the idempotency test is green).
NET SCORE: 4 − 0 = 4 (would have fired in production this month: BSI-2/DD-1, BSI-10, BSI-11, BSI-8. The one new failure mode found in review, /api/sync going green on a total failure, was fixed before commit.)

OPERATOR ACTIONS / DEPLOY:
- None required. The plaid_items.last_error_code column is an idempotent auto-migration. Optional: after deploy, confirm Sync Health no longer shows "N Plaid item(s) need re-authentication" for CSV-only imports | BLOCKS DEPLOY: N
Deploy: Platform, Shell & Auth: Render auto-deploys on push to `main` (configured in the Render dashboard, not via CLI). Alt: `fly deploy` (Dockerfile-based).

(Not complete in production until blocking operator actions are done AND
the deploy step is confirmed.)

FOLLOW-ON ITEMS:
- Plaid Link update mode is not implemented, so a last_error_code item can only be fixed by re-linking. The re-link upsert clears the flag.
- Accounts page (accounts.ejs) still launches Teller Connect without the existing enrollment id (reconnect mode). DD-8's re-point covers same-ID re-links; a re-link that returns NEW account ids still duplicates history (the other half of DD-8, noted as S-M).
- A new Teller account registered by syncAllBalances first syncs from the enrollment's watermark − 7d, so its older history arrives only via a reconcile (≤90 days) or not at all.
- Plaid investment-only items (plaid_investment_items registry, no plaid_items row) have no unlink route.
- The Sync Health UI doesn't yet show per-provider `at` timestamps from last_sync_result.providers.
DOCUMENTATION UPDATES NEEDED:
- CLAUDE.md: POST /api/sync now covers Teller + Plaid (+ one anomaly check), plus its response shape; the "Plaid Liabilities / re-auth" and data-health notes (CSV excluded, last_error_code); last_sync_result is now per-provider merged (Key Design Decision + user_settings.last_sync_result entry); the reconcile stamping rule; the Teller 7-day watermark lookback and insert-failure hold (INV-02/03 wording); DISCONNECTED reachable + self-restoring; syncAllBalances registers new accounts; the Teller 429 retry; the Plaid unlink semantics; the BSI-12 mutation restart (INV-04 note); scheduler entries (auto-sync/pre-insights use syncAllTransactions); the daily-sync.yml description; test counts (1169 across 46 files; Perfin 700 + Per-sistant 469).
- README.md: the sync-button/daily-sync description, if it says Teller-only.
---END BROAD SCAN IMPLEMENTATION SUMMARY---
