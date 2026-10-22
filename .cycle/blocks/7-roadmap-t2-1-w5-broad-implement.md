---BROAD SCAN IMPLEMENTATION SUMMARY---
Findings implemented: None (roadmap work, not scan findings)
New capabilities (G/ST): Roadmap T2.1 (Plaid and Teller webhooks), batch W5 of W1–W6 (.cycle/plan-t2-1-webhooks.md) —
  W5 Teller events: transactions.processed syncs the named enrollment now (coalesced, nothing global), enrollment.disconnected marks it DISCONNECTED with one notification, webhook.test is acknowledged; teller_enrollments.last_synced_at. Docs folded in.
Files modified: teller/routes/enrollments.js, teller/routes/teller-webhook-events.js (new), teller/routes/webhooks.js, teller/services/webhook-verify.js, teller/services/database.js, tests/roadmap-t2-webhooks-w5.test.js (new), tests/contract/webhooks-w5.contract.test.js (new), tests/roadmap-t2-webhooks-w2.test.js, tests/roadmap-t2-webhooks-w3.test.js, CLAUDE.md, README.md, .cycle/plan-t2-1-webhooks.md, .cycle/STATE.md

CHANGES:
W5 | teller/routes/enrollments.js | TELLER_ENROLLMENTS_SQL (the existing non-suspended select, shared). The loop body of syncAllEnrollments moved into syncOneTellerEnrollment(enrollment, { backfillFrom }) → { added, errors[], failed } — decryption check, DISCONNECTED on a 401/403 everywhere, the self-heal to GOOD, the partial error — plus teller_enrollments.last_synced_at (fail-soft) after a run with no partial failure; the DISCONNECTED write is now .catch-logged so it never throws (it used to throw out of the whole syncAllEnrollments). syncAllEnrollments loops it with identical counts. syncTellerEnrollment(id): one non-suspended enrollment (… AND te.id = $2), incremental, coalesced per enrollment (re-run flag, shared promise), returns { ok:false, error:"not_found" } or { ok, runs, summed added, the last run's errors / failed }; no anomaly check, nothing global. Both exported after module.exports
W5 | teller/routes/teller-webhook-events.js | createTellerEventHandler({ db, syncEnrollment, postSync, notify }): transactions.processed → enrollments by payload enrollment_id, else by the transactions' account ids (linked_accounts JOIN, never SUSPENDED) → syncTellerEnrollment each → one runPostSyncSteps over the combined count → 'done' (a failed sync throws after the post-sync steps; none / gone → 'ignored'). enrollment.disconnected → a GOOD enrollment set DISCONNECTED (`… AND status = 'GOOD' RETURNING id`) + one notification (tag teller-disconnected-<id>, /accounts, reasonText: credentials changed / account locked / sign in again / inactive); already DISCONNECTED or SUSPENDED → 'done' silently; unknown / no subject → 'ignored'. webhook.test → 'done'. Others → 'ignored'
W5 | teller/routes/webhooks.js | DEFAULT_HANDLERS.teller → the handler above (lazy require); header comment updated
W5 | teller/services/webhook-verify.js | Teller event gains reason (payload.reason) and account_ids (distinct string account_id values of payload.transactions, ≤50, clipped) — never any other transaction field
W5 | teller/services/database.js | teller_enrollments.last_synced_at TIMESTAMPTZ
Tests | tests/roadmap-t2-webhooks-w5.test.js (15), tests/contract/webhooks-w5.contract.test.js (3), tests/roadmap-t2-webhooks-w2.test.js, tests/roadmap-t2-webhooks-w3.test.js | Unit: both lookups + their SQL, the combined post-sync pass, ignored / failed paths, the disconnect paths incl. a lost race, webhook.test, reasonText, the router wiring; syncTellerEnrollment over the REAL Teller engine (stubbed tellerRequest + mock pool): only that enrollment, the stamp only after a clean run, nothing global, not_found, a partial failure unstamped, coalescing; syncAllEnrollments counts / decryption failure / DISCONNECTED on a 401; the verifier's fields without transaction data. Contract (real engine, signed events): account-id-only transactions.processed syncing just its enrollment (row, watermark, last_synced_at, anomaly watermark, nothing global), disconnect → DISCONNECTED with one notification across two deliveries, webhook.test done, unknown enrollments ignored. W2 / W3 tests updated for the new event fields and the Teller handler pin
Docs | CLAUDE.md, README.md | Architecture (verifier fields, enrollments per-enrollment sync, webhooks.js W1–W5, new teller-webhook-events.js), the Teller endpoint note, TELLER_WEBHOOK_SECRET (dashboard URL + test-event check), teller_enrollments.last_synced_at, counts 1995 / 100 files / Perfin 1444, contract 186 + test-file descriptions, Bank Sync subsystem list, new INV-140, Known Open Issues (W1–W5 done, W5 follow-ons)

TEST RESULTS: npm test 1995/1995 (15 new); contract 186/186 (3 new); CI migration test (both apps, twice) passed on a fresh database; Playwright not re-run (no page or mount change). Mutation checks: removing the per-enrollment coalescing, stamping last_synced_at on a partial run, or notifying after a lost disconnect race each turn a test red.
REGRESSION RISKS:
- syncAllEnrollments now issues one more fail-soft UPDATE per clean enrollment (last_synced_at), including reconcile passes.
- A failed DISCONNECTED write inside a Teller sync is now logged instead of throwing out of syncAllEnrollments — the other enrollments still sync (strictly better, but a behaviour change).
- Still inert until TELLER_WEBHOOK_SECRET is set and Teller's dashboard has the URL. If Teller's real signature format differs from the remembered one, every delivery is a 401 (nothing acts); if its transactions.processed payload has neither an enrollment id nor account ids, the event is 'ignored' — the daily sync stays the backstop either way.
- A webhook-triggered Teller sync can overlap a running syncAllEnrollments for the same enrollment: idempotent upserts (INV-01 / INV-54); the watermark ends at whichever run finished last, which is never past data that run fetched (worst case a slightly earlier watermark → a re-read).
INVARIANTS AT RISK: None. INV-02 / INV-03 (the same syncEnrollment), INV-22 (perfin_try_decrypt), INV-67 / INV-138 pattern (one post-sync pass, nothing global), INV-103 / INV-137 (no body stored or logged; the verifier exposes only ids and the reason), new INV-140.
NET SCORE: 0 production fixes − 0 new failure modes = 0 (new capability; inert until Teller is configured)

OPERATOR ACTIONS / DEPLOY:
- To switch Teller webhooks on: confirm Teller's signature format against https://teller.io/docs/api/webhooks, add `<public address>/perfin/api/webhooks/teller` in the Teller dashboard, set TELLER_WEBHOOK_SECRET, send Teller's test event and check its webhook_events row ends 'done' — optional | BLOCKS DEPLOY: N
Deploy: Bank Sync & Ingestion / Platform — Render auto-deploys on push to `main` (PR robinchoudhuryums/pers-fin#133).

(Not complete in production until blocking operator actions are done AND
the deploy step is confirmed.)

FOLLOW-ON ITEMS:
- Teller's docs were unreachable again (proxy 403): confirm the Teller-Signature format and the transactions.processed payload shape before switching it on.
- A Teller per-enrollment webhook sync isn't serialized with a running syncAllEnrollments (harmless — idempotent — but double work).
- A disconnected Teller enrollment's notification points to Accounts; the Accounts page has no one-click "reconnect this enrollment" (Teller Connect re-run creates a new enrollment).

DOCUMENTATION UPDATES NEEDED:
- None beyond this batch (docs folded in).
---END BROAD SCAN IMPLEMENTATION SUMMARY---
