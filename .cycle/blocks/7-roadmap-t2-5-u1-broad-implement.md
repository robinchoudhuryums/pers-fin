---BROAD SCAN IMPLEMENTATION SUMMARY---
Findings implemented: none (roadmap batch, not scan findings)
New capabilities (G/ST): Roadmap T2.5 U1 — transaction undelete (server side) + CSV imports that honour the tombstone (the cycle-7 Batch 6 follow-ons)
Files modified: teller/services/database.js, teller/routes/transactions.js, teller/routes/subscriptions.js, scripts/import-csv-cli.js, tests/scan-oct-batch6.test.js, tests/roadmap-t2-5-u1.test.js (new), tests/contract/undelete-t2-5.contract.test.js (new), CLAUDE.md, .cycle/plan-t2-5-undelete-ios-reauth.md, .cycle/STATE.md

CHANGES:
U1 | teller/services/database.js | deleted_transactions.snapshot JSONB + source TEXT (idempotent ADD COLUMN)
U1 | teller/routes/transactions.js | DELETE reads the row + splits (to_jsonb) and its source (SOURCE_SQL through linked_accounts / plaid_items) FOR UPDATE, deletes, and upserts the tombstone with them; GET /api/deleted-transactions (limit 1-200, keyset cursor "<µs UTC>|<id>", snapshot + legacy rows, restorable); POST /api/deleted-transactions/:id/restore (restoreDeleted: 404 / account-gone 409 / jsonb_populate_record over the table's current non-generated, non-id columns ON CONFLICT DO NOTHING / splits via jsonb_populate_recordset / tombstone lifted; a pre-U1 tombstone lifted with returns_on reconcile | csv_reimport, a pre-U1 manual one a 409); test seams
U1 | teller/routes/subscriptions.js | deletedIdSet; the preview marks tombstoned rows "deleted" and returns rows_deleted; the import parses first, skips tombstoned ids (rows_deleted, counted in csv_imports' not-imported) and guards its INSERT with NOT EXISTS (deleted_transactions), category still a text[] parameter
U1 | scripts/import-csv-cli.js | the same NOT EXISTS guard; a deleted row counts as skipped and is reported separately
U1 | tests/scan-oct-batch6.test.js | the F20 pin follows the DELETE's new shape (tombstone with snapshot + source, ON CONFLICT DO UPDATE)

TEST RESULTS: npm test 2252/2252 (15 new); contract 236/236 (5 new); migrations run twice clean; Playwright 61/61; 13/13 mutations red (CSV NOT EXISTS, CSV skip, preview status, snapshot stored, id excluded, splits restored, tombstone lifted, account check, ON CONFLICT, cursor <, legacy manual 409, CLI NOT EXISTS, csv source branch)
REGRESSION RISKS: the CSV import now parses the whole file before inserting (same rows and IDs, one extra query); a re-imported file that used to bring a hand-deleted CSV row back now skips it (intended — Restore is the way back); the DELETE now runs one extra SELECT ... FOR UPDATE.
INVARIANTS AT RISK: INV-111 (extended: CSV import + CLI honour the tombstone; restore is the only way back — pinned), INV-06 (restore puts the user_* columns back from the snapshot — contract-pinned), INV-01 (a restored row is not counted as added by the next sync — contract-pinned), INV-12 / DC-14 (CSV category still a text[] parameter — pinned). None violated.
NET SCORE: 0 production fixes − 0 new failure modes = 0 (new capability)

OPERATOR ACTIONS / DEPLOY:
- None | BLOCKS DEPLOY: N
Deploy: Platform, Shell & Auth: Render auto-deploys on push to `main` (the migration adds two columns at boot).

FOLLOW-ON ITEMS:
- No page yet — U2 adds the Settings list and the Activity page's Undo.
- A tombstone written before U1 shows only its id; a pre-U1 Teller / Plaid row needs Reconcile Now (Restore never starts one); a pre-U1 manual entry can't be restored.
- Snapshots are kept until a reset; there is no "delete forever".
- A restored row gets a new serial id (sorts as the newest among rows of its date).

DOCUMENTATION UPDATES NEEDED:
- README line and the CLAUDE.md Features wording for the UI come with U2; INV-145 with H1.
---END BROAD SCAN IMPLEMENTATION SUMMARY---
