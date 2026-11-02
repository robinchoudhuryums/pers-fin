---BROAD SCAN IMPLEMENTATION SUMMARY---
Findings implemented: S4-3 (from .cycle/plan-seams4.md / Seams & Invariants audit #4)
- S1 — the cash-flow forecast's merchant key is the detectors' TRIMmed key, so a subscription whose bank name ends in a space is billed once and kept out of the spending average (it was both)
- S3 — "What's in this forecast" and the totals share one window (today+1 … today+days); a bill due today is in neither (the list counted it, the totals didn't)
- S6 — the low cash alert's freshness gate reads the OLDEST bank-synced spendable balance (an unstamped one skips too); manual / CSV-only setups keep the newest-balance rule
- S4 — Sync Health's "haven't synced in 24 h" warnings follow the bank connections (the nav badge's helper) when any exist; the global stamps only without connections
- S5 — GET /api/deleted-transactions' per-row `restorable` follows the restore route's refusals (bank-removed, account gone, a legacy manual entry), with `unrestorable_reason`; Settings words each
New capabilities (G/ST): None
Files modified: teller/services/cash-flow.js, teller/services/cash-alerts.js, teller/routes/settings.js,
  teller/routes/transactions.js, teller/views/settings.ejs, tests/sync-durability.test.js,
  tests/roadmap-t2-5-u1.test.js, tests/scan-sept-batch3.test.js, tests/seams-audit-4-s3.test.js (new),
  tests/contract/seams4-s4-3.contract.test.js (new)

CHANGES:
S1 | teller/services/cash-flow.js | DETECT_KEY_T = merchant-rename.js's DETECT_KEY (TRIM(COALESCE(user_merchant_name, merchant_name, cleaned name))) — used by mirroredCredit and the NOT_SUBSCRIPTION exclusion of the spending averages; exported.
S3 | teller/services/cash-flow.js | billSchedule's dates drop today (seriesOccurrences includes it) — the projection, the totals and forecast_items now read one window.
S6 | teller/services/cash-alerts.js | SYNCED_WITH_BALANCE (a depository, non-investment account with a balance whose connection is Teller or a GOOD Plaid item); the settings query adds oldest_synced_at (min balance_updated_at over those) and synced_unknown (one of them never stamped); checkProjection skips (stale_balances) when the newest is old, or any bank-synced one is old or unknown. Manual / CSV accounts don't count, so a manual-only setup keeps the newest rule.
S4 | teller/routes/settings.js | gatherDataHealth reads the connections (freshness.readConnections) before the issues; syncAgeIssues: with connections, one warning per connection whose own sync is 24 h+ old or never completed ("<bank> (Plaid) hasn't synced in over 24h." / "… has no complete sync recorded yet.", link /settings#sync-health), skipping re-auth / disconnected ones (counted above); the global balance warning only while a Teller connection exists (a Teller enrollment's sync doesn't refresh balances; a Plaid item's does); no connection or a failed read → the global stamps as before. Exported.
S5 | teller/routes/transactions.js | the list query reads bank_removed and account_linked; unrestorableReason (restoreDeleted's order: removed_by_bank → a legacy manual "never" → account_gone; a legacy non-manual tombstone is lifted, so restorable); items carry restorable + unrestorable_reason.
S5 | teller/views/settings.ejs | deletedRowHtml words removed_by_bank / account_gone / never; no Restore button for any.
Tests | tests/seams-audit-4-s3.test.js (15) + tests/contract/seams4-s4-3 (3: a "HULU " subscription billed and out of the average; a 72-hour-old synced balance beside a fresh one skipping, an unstamped one skipping, a manual account ignored; each deleted row's flag and the route agreeing) + Category A fixture updates (sync-durability's data-health mock answers the connections query; roadmap-t2-5-u1's list fixture carries the two new columns; scan-sept-batch3's FAN-5 pin reads the TRIMmed key).

TEST RESULTS: npm test 3164/3164 (+15); contract 335/335 (+3); e2e 91/91. Red check: with the five production files reverted, 13 of the 15 new unit tests and all 3 contract tests fail. The S6 contract test caught a bug in the first draft (the outer SELECT didn't pick the new columns, so the gate never saw them) — fixed before commit.
REGRESSION RISKS:
- S6: a bank-synced account whose balance stops updating (a closed card still linked as depository, a Plaid item that no longer returns one account) now keeps the low cash alert skipped until it syncs or is removed — Settings' last-check line says "skipped" (stale_balances).
- S4: right after a link, before the first sync stamps the connection, Sync Health shows "<bank> has no complete sync recorded yet" (the badge already read "Not synced yet").
- S3: a bill due today no longer appears in "What's in this forecast" (it was never in the totals).
INVARIANTS AT RISK: None broken. INV-142 holds fully (S6), INV-145 (S5 — per row now), INV-151 (S1 — one key), INV-154 (S4 — data-health's warnings now from the same helper).
NET SCORE: 3 − 1 = +2 (production fixes this month: S1 — any subscription whose merchant name carries a trailing space is double-counted in every forecast; S4 — a Plaid-webhook / per-item sync setup reads stale in Sync Health within a day; S5 — any bank-removed or orphaned deleted row offers a Restore that 409s. S3 / S6 need a bill due today / an account lagging the others — NO this month. New failure mode: S6's permanently skipped alert on a dead synced account (Low).)

OPERATOR ACTIONS / DEPLOY:
- None | BLOCKS DEPLOY: N
Deploy: Financial Analytics / Settings / Bank Sync — Render auto-deploys on push to main.

FOLLOW-ON ITEMS:
- S6: no "leave this account out" control — a dead synced account silences the low cash alert until removed.
- The Plaid / Teller link exchanges don't stamp last_synced_at, so a freshly linked connection reads "no complete sync" until the next scheduled sync (pre-existing; now visible in Sync Health too).
- The rest of audit #4: S4-4, S4-5 (.cycle/plan-seams4.md).

DOCUMENTATION UPDATES NEEDED:
- CLAUDE.md: cash-flow.js (the TRIMmed key, the today+1 window for forecast_items), cash-alerts.js (the oldest-synced gate, SYNCED_WITH_BALANCE) + the Low cash alert feature text, settings.js / Sync Health (the warnings follow the connections), GET /api/deleted-transactions (unrestorable_reason), the audit #4 Known Open Issues entry (S4-3 done, its follow-ons), test counts (3164 / 173 files, contract 335); INV-142 / INV-145 / INV-154 wording.
---END BROAD SCAN IMPLEMENTATION SUMMARY---
