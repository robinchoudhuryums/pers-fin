---BROAD SCAN IMPLEMENTATION SUMMARY---
Findings implemented: None (roadmap work, not scan findings)
New capabilities (G/ST): Roadmap T2.1 (Plaid and Teller webhooks), batch W3 of W1–W6 (.cycle/plan-t2-1-webhooks.md) —
  W3 Plaid per-item sync: a verified TRANSACTIONS / SYNC_UPDATES_AVAILABLE webhook syncs that one Plaid item now (coalesced, under the Plaid lock), then runs the shared post-sync steps. Docs folded in.
Files modified: teller/routes/investments.js, teller/routes/enrollments.js, teller/routes/plaid-webhook-events.js (new), teller/routes/webhooks.js, teller/services/database.js, tests/roadmap-t2-webhooks-w3.test.js (new), tests/contract/webhooks-w3.contract.test.js (new), tests/scan-oct-batch15.test.js, CLAUDE.md, README.md, .cycle/plan-t2-1-webhooks.md, .cycle/STATE.md

CHANGES:
W3 | teller/routes/investments.js | The loop body of syncAllPlaidTransactionsOnce moved unchanged into syncOnePlaidItem(client, item) → { added, modified, removed, accounts_registered, errors[], failed } (never throws); syncAllPlaidTransactionsOnce loops it and aggregates exactly as before. New: plaid_items.last_synced_at stamped (fail-soft) after a walk that reached the end of the cursor. syncPlaidItem(id): one GOOD item (PLAID_ITEMS_SQL + "AND pi.id = $2", perfin_try_decrypt) under withPlaidTxnLock, coalesced per item — a request during its run sets a re-run flag and shares the promise, so the run goes round once more; returns { ok:false, error: "Plaid not configured" | "not_found" } or { ok:true, runs, summed counts, the last run's errors / failed }. Records nothing global and runs no post-sync steps. Both exported after module.exports (INV-19)
W3 | teller/routes/enrollments.js | runPostSyncSteps(added): rename rules (fail-soft) then runAnomalyCheck, nothing for 0 rows, serialized through a promise chain (two syncs finishing together check in turn — the second reads the advanced watermark); never rejects. syncAllTransactionsOnce calls it with the combined count (behaviour unchanged). Exported
W3 | teller/routes/plaid-webhook-events.js | createPlaidEventHandler({ db, syncItem, postSync }): SYNC_UPDATES_AVAILABLE → SELECT the GOOD plaid_items row by item_id → syncPlaidItem → runPostSyncSteps(added) → 'done'; no subject / unknown / CSV item / item gone → 'ignored'; every other event → 'ignored' with no query (W4); a failed item sync still runs the post-sync steps for rows it added, then throws (the router marks the row 'failed' with its fixed text)
W3 | teller/routes/webhooks.js | DEFAULT_HANDLERS.plaid → the handler above (lazy require); header comment updated; Teller still 'ignored' until W5
W3 | teller/services/database.js | ALTER TABLE plaid_items ADD COLUMN IF NOT EXISTS last_synced_at TIMESTAMPTZ
Tests | tests/roadmap-t2-webhooks-w3.test.js (19), tests/contract/webhooks-w3.contract.test.js (3), tests/scan-oct-batch15.test.js | Unit: only the named item synced with its token, the stamp only after a complete walk, nothing global, not_found, a row failure unstamped, the item sync queued behind a running all-items sync, coalescing (one extra round, same promise, a later request starts fresh, other items not coalesced), syncAllPlaidTransactions aggregation + decryption failure + thrown item with its re-auth code, runPostSyncSteps (0 rows, order, serialized), the handler's paths, a verified event through the production router ending 'done' with one anomaly check. Contract: a signed SYNC_UPDATES_AVAILABLE through the production router with the real engine — the row inserted, cursor + balances + the item's last_synced_at, the anomaly watermark, 'done', last_txn_sync_at / last_sync_result untouched; a second delivery adds nothing; a CSV / unknown item 'ignored'. The batch15 rename-rule pin now reads runPostSyncSteps
Docs | CLAUDE.md, README.md | Architecture (enrollments runPostSyncSteps, webhooks.js W1–W3, new plaid-webhook-events.js, investments per-item sync), the endpoint note, plaid_items.last_synced_at, counts 1963 / 98 files / Perfin 1412, contract 178 + test-file descriptions, Bank Sync subsystem file list, INV-67 widened, new INV-138, Known Open Issues (W1–W3 done, update-complete stamp note)

TEST RESULTS: npm test 1963/1963 (19 new); contract 178/178 (3 new); CI migration test (both apps, twice) passed on a fresh database; Playwright not re-run (no page or mount change). Mutation checks: removing the per-item coalescing, stamping last_synced_at unconditionally, or un-serializing runPostSyncSteps each turn a test red.
REGRESSION RISKS:
- syncAllTransactions now awaits a process-wide post-sync chain: if an earlier anomaly check hung (database hang), a later sync's post-sync step waits behind it. Previously each ran independently; a database hang stalls everything anyway.
- Every Plaid sync now issues one more fail-soft UPDATE per item (last_synced_at).
- Still inert in production: Plaid sends webhooks only once W4 registers the URL. A forged request can't reach the handler (W2 verification); a genuine one for an item we don't have is 'ignored'.
- A webhook sync also refreshes liabilities and balances for that item (same code as the scheduled sync) — a few more Plaid calls per day per item once webhooks are on.
INVARIANTS AT RISK: None. INV-67 (widened: the webhook path runs the same post-sync steps), INV-04 / INV-01 / INV-111 (the webhook path uses the same cursor walk and upserts), INV-18 (in-process helpers), INV-19 (exports after module.exports), new INV-138.
NET SCORE: 0 production fixes − 0 new failure modes = 0 (new capability; still inert until W4 registration)

OPERATOR ACTIONS / DEPLOY:
- None (the column auto-migrates; webhooks reach the app only after W4's registration) | BLOCKS DEPLOY: N
Deploy: Bank Sync & Ingestion / Platform — Render auto-deploys on push to `main` (PR robinchoudhuryums/pers-fin#133).

(Not complete in production until blocking operator actions are done AND
the deploy step is confirmed.)

FOLLOW-ON ITEMS:
- POST /api/plaid/update-complete syncs its item with its own steps, so it doesn't stamp plaid_items.last_synced_at (the next scheduled sync does); it could call syncOnePlaidItem.
- plaid_items.last_synced_at and sync_cursors.last_synced_at now both exist with different meanings (caught up vs. last clean page) — W6 should surface only the former.
- The coalescing is in memory: a restart mid-sync drops the re-run flag (the daily sync is the backstop).

DOCUMENTATION UPDATES NEEDED:
- None beyond this batch (docs folded in).
---END BROAD SCAN IMPLEMENTATION SUMMARY---
