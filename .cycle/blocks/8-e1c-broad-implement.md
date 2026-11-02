---BROAD SCAN IMPLEMENTATION SUMMARY---
Findings implemented: None (E1c is expansion work)
New capabilities (G/ST): G5 (cycle-8 E1c) — undo a whole CSV-overlap Resolve in one step: every row it removed restored together (rows that can't come back are listed and stay deleted), from a "Restore all N" in Settings → Sync Health → Deleted transactions.
Files modified: teller/services/database.js, teller/routes/transactions.js, teller/views/settings.ejs, tests/roadmap-t2-5-u1.test.js, tests/cycle8-e1c.test.js (new), tests/contract/resolve-undo-e1c.contract.test.js (new)

CHANGES:
G5 | teller/services/database.js | `deleted_transactions.batch_id TEXT` (NULL for a single delete) + a partial index on it.
G5 | teller/routes/transactions.js | newBatchId() (`resolve_<base36 ms>_<12 hex>`) and BATCH_ID_RE; POST /api/transactions/csv-overlap/resolve writes one batch id on every tombstone it writes (also on a re-tombstone via ON CONFLICT) and returns `{ deleted, batch_id }` (no batch_id when nothing was deleted); a single DELETE's re-tombstone clears batch_id. restoreDeleted(client, id, { applyRules = true }) — the batch path defers the rename rules. New POST /api/deleted-transactions/batches/:batch_id/restore: 400 for an id not matching BATCH_ID_RE before any connection; the batch's tombstones read FOR UPDATE in ONE transaction (none → ROLLBACK + 404); each through restoreDeleted — a refusal writes nothing and is listed in `skipped` [{ transaction_id, reason: removed_by_bank | account_gone | not_found | <body reason>, error }]; applyRenameRules once when anything was restored; COMMIT → `{ batch_id, restored, already_present, splits, stale?, skipped }`; a throw → ROLLBACK + fixed 500. GET /api/deleted-transactions: each item gains batch_id, and the reply gains `batches` [{ batch_id, count, deleted_at }] — every batch still holding a tombstone, newest first, ≤20.
G5 | teller/views/settings.ejs | Deleted transactions: deletedBatches from the reply; a list of "Removed by a CSV overlap resolve — N rows · <when>" headers above the rows, each with "Restore all N" (data-restore-batch, aria-label "Restore all N rows removed by the CSV overlap resolve on <when>", escaped); a row of a batch reads "Deleted <when> by a CSV overlap resolve". restoreDeletedBatch: disabled while running; POST; a network throw toasted; writeOk "Restore"; restoreBatchMessage (restored count, skipped rows "stay deleted", stale rows → Reconcile Now; not a success toast when anything was skipped); reload the list. The delegated click handler awaits it.
G5 | tests/roadmap-t2-5-u1.test.js | test doubles: the single delete's ON CONFLICT pin gains `batch_id = NULL`; the list's fake pool answers the batches query and the item / empty-list shapes gain batch_id / batches.
G5 | tests/cycle8-e1c.test.js | 13 tests: the batch id's format, the Resolve / single-delete / migration source pins, the batch route over a fake client (400 before connecting, 404 + rollback, restored / already present / account gone / removed by the bank with only the restored tombstones lifted and the rules once, nothing restorable without a rules pass, a throw rolled back with a fixed 500), the list's batch_id + batches query, and the Settings section in a vm (labelled + escaped header, rows marked, the POST → message → reload, skipped / stale message, a refusal and a network failure re-enabling the button).
G5 | tests/contract/resolve-undo-e1c.contract.test.js | 4 tests on real Postgres through the real routes: a Resolve of 4 paired rows tags them with its returned id and the list shows the batch; restoring it brings 3 back with notes and splits while a bank-removed row stays (still in its batch, count 1); a second restore restores nothing (no duplicates), an emptied batch 404s, a malformed id 400s; a later single delete belongs to no batch.

TEST RESULTS: npm test 2961/2961 (13 new). Contract 289/292 run: resolve-undo-e1c 4/4; the failure + 2 cancelled are the pre-existing date-dependent cash-alerts-l2 and cash-flow-l1. e2e 73/73 (Playwright pointed at /opt/pw-browsers/chromium through a scratch config outside the repo). Mutation checks: Resolve without the batch id (unit 1, contract 4 fail), the rules per row (unit 1), aborting on a refused row (unit 2, contract 3).
REGRESSION RISKS: GET /api/deleted-transactions runs one more (small, indexed) query and adds two fields; its other consumers (perfin-shared restoreTransaction, the U2 list) ignore them. Resolve's reply gains batch_id; no UI calls Resolve. restoreDeleted's default is unchanged (rules applied) for the single restore. A batch restore holds row locks on its tombstones for its duration.
INVARIANTS AT RISK: INV-111 / INV-145 (restore is still the only way a tombstoned id returns; each row's restore is restoreDeleted's own — refusals write nothing, no duplicates), INV-124 (the rename rules still apply to restored rows, once per batch), INV-89 (the write through writeOk). None violated.
NET SCORE: 0 production fixes − 0 new failure modes = 0 (G5 is a new capability)

OPERATOR ACTIONS / DEPLOY:
- None (the column auto-migrates) | BLOCKS DEPLOY: N
Deploy: Platform, Shell & Auth: Render auto-deploys on push to `main`.

(Not complete in production until blocking operator actions are done AND
the deploy step is confirmed.)

FOLLOW-ON ITEMS:
- Resolves run before this deploy have no batch id; their rows restore one at a time.
- Resolve itself still has no UI (API only), so a batch only appears after an API-driven Resolve.
- A legacy (snapshot-less) row in a batch would count as restored though only its tombstone is lifted — can't happen today (Resolve always writes a snapshot since cycle-8 F4).
- The batch header's count includes rows that can't come back; pressing again reports them skipped.
- Still open: tests/contract/cash-flow-l1's date-dependent seed (E1a); e2e/playwright.config.js could take the preinstalled Chromium from an env variable (E1b).

DOCUMENTATION UPDATES NEEDED:
- CLAUDE.md: Transaction deduplication / undelete (Resolve's batch id, the batch restore, "Restore all"), Commands (the batch route, Resolve's batch_id, the list's batches), the Database deleted_transactions entry, INV-145, test counts (2961 / 159 files; contract 292) + the new test entries, Known Open Issues (E1 done; follow-ons).
- .cycle/plan-e1-forecast-corrections.md + plan-cycle8-expansion.md: E1c / E1 done.
---END BROAD SCAN IMPLEMENTATION SUMMARY---
