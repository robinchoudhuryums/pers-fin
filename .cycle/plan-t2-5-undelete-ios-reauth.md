# Roadmap T2.5 — Transaction undelete and iOS re-authenticate (plan, 2026-10-23)

Goal: two follow-ons that each leave the user stuck today.

1. A transaction you deleted can be brought back. Today `DELETE /api/transactions/:id` is
   final, and its tombstone keeps every provider sync from re-inserting it (Batch 6
   follow-on).
2. Plaid's Re-authenticate / Add accounts works in iOS Safari, and in the home-screen PWA
   and the Capacitor wrapper. Update mode opens only the in-page Link today, whose popup
   OAuth doesn't work there (Batch 19 follow-on).

Roadmap estimate: M, about 1 week.

## What exists (read for this plan)

**The tombstone (cycle-7 F20 / INV-111)**
- The table is `deleted_transactions(transaction_id TEXT PRIMARY KEY, deleted_at)`
  (teller/services/database.js).
- `DELETE /api/transactions/:id` (routes/transactions.js) deletes the row and inserts the
  tombstone in one transaction. The row's splits go with it (ON DELETE CASCADE).
- **Nothing of the row is kept.** A list of deleted transactions could show only an id
  and a date today.
- The only UI caller is the Activity page's Delete (`teller/public/transactions.js`).
- Both provider upserts honour the tombstone with `INSERT … SELECT … WHERE NOT EXISTS
  (deleted_transactions)`:
  - the Teller upsert in `enrollments.js`;
  - the Plaid `upsertTxn` in `investments.js`.
- **The CSV import ignores the tombstone.** Re-importing the file brings a hand-deleted
  row back; this is a listed follow-on.
- The table is in reset-fresh's WIPE_TABLES.
- Other deletes write no tombstone, by design:
  - the CSV-overlap Resolve deletes CSV rows (they're never re-fetched);
  - unlinking a Teller enrollment or Plaid item;
  - Plaid `removed`;
  - the 36-month retention cleanup.

**Bringing a row back by re-fetching it**
- Teller: `reconcileTeller(days)` re-reads a trailing window, independent of the
  watermark.
- Plaid: its cursor never re-delivers a row it already sent. Only
  `reconcilePlaidTransactions()` brings one back — a full cursor reset and re-walk of up
  to 2 years, run as a background job.
- CSV and manual (`manual_*`) rows have no provider to re-fetch from.
- Since a re-fetch is either impossible or heavy for three of the four sources, the
  restore path is **a snapshot taken at delete time**.

**Plaid update mode (cycle-7 G3 / INV-128)**
- `POST /api/plaid/link-token-update { item_id, kind }`:
  - sends the item's own access_token (`perfin_try_decrypt`) with no products and
    `update.account_selection_enabled`;
  - returns `{ link_token }`.
- `POST /api/plaid/update-complete { item_id, kind }` works without a token exchange:
  - registers new accounts before the cursor walk;
  - clears `last_error_code`;
  - syncs that one Item under `withPlaidTxnLock` (investments: `syncAllPlaidHoldings({
    itemId })`).
- The Accounts page's `updatePlaidItem` opens the in-page `Plaid.create`.

**The hosted Link flow, for a NEW link only**
- `POST /api/plaid/hosted-link` calls `linkTokenCreate` with `hosted_link: {
  url_lifetime_seconds, completion_redirect_uri }` and returns `{ link_token,
  hosted_link_url }`.
- The page (`linkPlaidHosted`) keeps the token in sessionStorage
  (`perfin_plaid_link_token`, `perfin_plaid_hosted`) and redirects.
- On return, `handlePlaidHostedReturn` calls `POST /api/plaid/hosted-link-complete`. It
  reads the session through `linkTokenGet` → `link_sessions[-1]` → `public_token` → the
  exchange.
- The page shows "Link via Plaid" (hosted) next to the in-page button, so the user picks
  it.

## Decisions (to accept with /broad-implement U1)

**1. Snapshot at delete time.**
- The DELETE copies the row into the tombstone in the same transaction, before deleting
  it:
  - `deleted_transactions.snapshot JSONB` holds `to_jsonb(t)` plus its splits as a
    `splits` array;
  - `deleted_transactions.source` (`teller` | `plaid` | `csv` | `manual`) is taken from
    the account's provider, not guessed from the id.
- Kept indefinitely. The table is small (hand deletes only), and reset-fresh still wipes
  it.
- A tombstone written before this batch has `snapshot` NULL: a "legacy" row.

**2. Restore reinserts the snapshot.** One transaction, for every source alike:
- remove the tombstone;
- insert the row from its snapshot, `ON CONFLICT (transaction_id) DO NOTHING` (a row
  already there means nothing is duplicated);
- insert its splits.
- The insert uses ONLY the snapshot keys that are still columns of `transactions` (read
  from `information_schema`), so a later migration's NOT NULL DEFAULT column takes its
  default instead of NULL.
- The user's own fields come back with the row: category, notes, rename, reimbursed,
  personal_for.
- Refused, with a fixed-sentence 409 and nothing changed, when the row's account is no
  longer in `linked_accounts` (unlinked, or a manual account deleted).
- The next provider sync updates the restored row's raw fields as it would any row.
- **Legacy rows** (no snapshot): Restore only removes the tombstone. The response says
  how the row returns:
  - Teller: the next sync if it's within the 7-day lookback, else "Reconcile Now";
  - Plaid: a Plaid reconcile;
  - CSV: re-importing the file;
  - manual: not at all — such a manual row is listed as "can't be restored".
- Restore never starts a reconcile by itself. Sync Health's Reconcile Now does that, one
  at a time (INV-127).

**3. The CSV import honours the tombstone.**
- Preview and import both skip a tombstoned id. The preview counts these as
  `rows_deleted` (a new field), and the import doesn't count them as duplicates.
- With undelete available, re-importing a file no longer silently brings back a row you
  deleted; Restore is how you get it back. This closes the listed follow-on.
- The CLI (`scripts/import-csv-cli.js`) does the same.

**4. Where undelete lives.**
- Settings → Sync Health gets a collapsible "Deleted transactions" list:
  - newest first, 50 at a time, with "Show more";
  - each row shows date, merchant, amount and account from the snapshot (or "id only —
    deleted before undelete existed"), and when it was deleted;
  - each row has a labelled Restore button.
- The Activity page's Delete toast offers "Undo", which calls the same restore.
- No hard "forget" button: a tombstone's whole job is to stay.

**5. Hosted update mode.**
- `link-token-update` takes `hosted: true` plus the `redirect_uri`. It then adds
  `hosted_link: { url_lifetime_seconds: 3600, completion_redirect_uri }` (the same
  values as `/api/plaid/hosted-link`) and returns `hosted_link_url`.
- The page stores `{ item_id, kind, link_token }` in sessionStorage
  (`perfin_plaid_update`) and redirects.
- On return, it calls `update-complete` with `link_token`. When a `link_token` is sent,
  the server first checks the Link session through `linkTokenGet`:
  - a session that EXITED, or none finished, is a 400 ("Plaid re-authentication wasn't
    finished.") with nothing changed;
  - a finished one runs the existing update-complete body unchanged. There is no
    public_token in update mode.
- Without `link_token` (the in-page flow) nothing changes.
- **Confirm Hosted Link's update-mode support and `link_sessions` shape against Plaid's
  docs before shipping.** If update mode isn't offered through Hosted Link, H1 falls
  back to Link's redirect OAuth (`receivedRedirectUri`) — say so before building.

**6. When the hosted flow is used.**
- One helper, `prefersHostedPlaidLink()` in the page, picks the hosted flow when either:
  - the device is iOS / iPadOS (UA, or a Mac UA with touch points);
  - the page runs standalone (`display-mode: standalone`) or under `window.Capacitor`.
- Elsewhere: the in-page Link, as today.
- No extra button. Re-authenticate and Add accounts just work on each device.

## Batches (broad-implement sized)

| # | Batch | Status |
|---|---|---|
| U1 | **Undelete: snapshot, list, restore (server) + CSV tombstone.**<br>• Migration: `deleted_transactions.snapshot JSONB`, `source TEXT` (idempotent; the migration test runs it twice).<br>• `DELETE /api/transactions/:id` writes snapshot + source in its transaction (read the row and its splits FOR UPDATE, then delete).<br>• `GET /api/deleted-transactions?limit=&before=` → `{ items: [{ transaction_id, deleted_at, source, restorable, date, merchant, amount, account_name, splits_count }], next }`. The display merchant comes from the snapshot; the account name is a live join (NULL once the account is gone).<br>• `POST /api/deleted-transactions/:id/restore` (decision 2) returns:<br>&nbsp;&nbsp;– `{ restored: true, transaction_id, splits }` on success;<br>&nbsp;&nbsp;– `{ restored: false, returns_on: 'next_sync' \| 'reconcile' \| 'csv_reimport' \| 'never' }` for a legacy row;<br>&nbsp;&nbsp;– 404 for an unknown id; 409 when the account is gone.<br>• CSV preview / import / CLI skip tombstoned ids; `rows_deleted` in both responses (decision 3).<br>• Tests: the snapshot shape (user fields, splits), restore over a fake pool (column filtering, ON CONFLICT, splits, 409), the legacy branches, the CSV skip, the 404 / 400s.<br>• Contract (real Postgres): delete → a Teller reconcile and a Plaid re-delivery skip it → restore brings back the same row with its category / notes / splits → the next sync updates it and doesn't duplicate it; a restored CSV row; restore after unlinking the account → 409 with nothing changed; a re-imported CSV file skipping the deleted row (`rows_deleted` 1); a legacy tombstone cleared. | DONE (2026-10-23 — a pre-U1 manual tombstone is a 409 "can't be restored"; a pre-U1 Teller / Plaid one returns_on "reconcile" — without a date the 7-day lookback can't be judged; restored rows get a new serial id; block `7-roadmap-t2-5-u1`) |
| U2 | **Undelete: the UI.**<br>• Settings → Sync Health → "Deleted transactions" (decision 4): the list, Show more, Restore. Each restore goes through `writeOk`; a legacy row's message tells you how it returns. Controls are labelled (IF-3), the list is collapsible, and it shows an empty state.<br>• Activity page: the Delete toast gets "Undo" (restore, then reload the list). A failed undo is reported by toast.<br>• Playwright: `e2e/seed.js` deletes one seeded transaction through the route. The Settings sweep presses Restore (not destructive — a restore). The Activity delete stays `data-e2e-skip`.<br>• Docs: CLAUDE.md Features (Transaction deduplication paragraph), Database (`deleted_transactions` columns), Commands, Known Open Issues (the undelete and CSV-tombstone follow-ons closed); README.<br>• Tests: the section run in a vm (rows from snapshot / legacy, Restore's POST and messages, Show more, a failed load), the toast's Undo wiring. | DONE (2026-10-26 — Undo toasts last 10 s and never merge; Undo reloads only after a successful restore; the seed lookup and the cash-flow-l1 fixture fixed along the way; block `7-roadmap-t2-5-u2`) |
| H1 | **iOS re-authenticate (hosted update mode) + T2.5 close-out.**<br>• Server (decision 5): `link-token-update` gains `hosted` + `redirect_uri` (hosted_link object, `webhookParam` kept; `redirect_uri` validated the same way as `/api/plaid/hosted-link`). `update-complete` gains the optional `link_token` check through `linkTokenGet` — an exited / unfinished session is a 400 with no write; a finished one runs the unchanged body.<br>• Client (decision 6): `prefersHostedPlaidLink()`; `updatePlaidItem` takes the hosted path there; a return handler (`perfin_plaid_update`, removed before the call so a reload can't repeat it) calls update-complete and reloads the items. The existing new-link return handler ignores an update return, and the reverse.<br>• INV-145; CLAUDE.md (Plaid gotcha "update mode opens the in-page Link" → hosted on iOS; the Batch 19 follow-on closed; Commands); README; Known Open Issues: T2.5 DONE with its follow-ons; STATE.<br>• Tests: the token request (hosted vs in-page body, access_token, no products), the session check (finished / exited / none / a Plaid error → fixed 400 or 502, nothing written), `prefersHostedPlaidLink` run in a vm over UA / touch / standalone / Capacitor cases, the return handler (sessionStorage cleared first, update-complete body, an error toast).<br>• Contract: a flagged item through update-complete with a finished `link_token` session (stubbed Plaid client) — the flag is cleared — and with an exited one, unchanged.<br>• The Re-authenticate button stays outside the e2e sweep (off-app). | DONE (2026-10-26 — finished = a Link session with finished_at and no exit; a strict `hosted: true`; the buttons data-e2e-skip; Hosted Link's update-mode support read from the SDK's types + Plaid's glossary, plaid.com unreachable from the build environment — operator to try once on an iPhone; block `7-roadmap-t2-5-h1`) |

Three batches, each one /broad-implement session: U1 → U2 → H1. H1 doesn't depend on U1
or U2 and can run first. Each batch runs:
- npm test;
- the contract suite;
- the migration test (U1);
- Playwright (U2, H1);
- mutation checks.

Each folds in the docs for what it adds.

## New invariant (H1)
INV-145 | Deleting a transaction is reversible and nothing brings it back unasked:
- the tombstone and the row's snapshot (with its splits) are written in the delete's own
  transaction;
- no provider sync, reconcile or CSV import (route or CLI) inserts a tombstoned id;
- restore removes the tombstone and reinserts the snapshot in one transaction — never a
  duplicate (ON CONFLICT DO NOTHING), and nothing changes when the account is gone;
- Plaid update mode — in-page or hosted — clears an item's re-auth flag only after Link
  reports the session finished (hosted: through `linkTokenGet`).

Subsystem: Bank Sync & Ingestion. Verify: the U1 / H1 test files + contract
`undelete-t2-5` + `plaid-update`.

## Trade-offs to state in the docs
- A transaction deleted before T2.5 has no snapshot. Restore clears its tombstone, and
  the row comes back only through a sync / reconcile / re-import — or never, for a
  manual row.
- Restore puts back the row as it was when deleted (its category, notes, splits). A
  change the bank made since arrives with the next sync.
- A re-imported CSV file no longer brings back a row you deleted. Restore it instead.
- Snapshots are kept until a reset. There is no "delete forever".
- The hosted flow is chosen by device. A desktop browser that blocks popups still gets
  the in-page Link.
- Hosted Link's update-mode support is confirmed from Plaid's docs in H1, not
  live-tested from the build environment.

## Out of scope
- Undo for the other deletes (CSV-overlap Resolve, an unlinked connection, Plaid
  `removed`, the retention cleanup).
- Bulk restore.
- A hosted variant of the investments-only Link.
- Teller Connect re-authentication (Teller marks DISCONNECTED and you re-link).
- A Plaid redirect-OAuth (`receivedRedirectUri`) flow, unless decision 5's docs check
  rules out Hosted Link.
