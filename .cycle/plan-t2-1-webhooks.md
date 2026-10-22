# Roadmap T2.1 — Plaid and Teller webhooks (plan, 2026-10-22)

Goal: Plaid and Teller tell the app when there is new data, so it syncs that one
connection within minutes. `daily-sync.yml` stays the backstop. Real value needs the
always-on host (roadmap 1.2); everything ships inert until the operator switches it on.

## Decisions (accepted with the plan)
1. Build now, switch on per provider: Plaid only once `PUBLIC_URL` is set and
   "Register webhooks" is pressed (W4); Teller only once `TELLER_WEBHOOK_SECRET` is set.
2. A webhook sync doesn't stamp the global `last_txn_sync_at` / `last_sync_result`;
   each item / enrollment gets its own `last_synced_at`.
3. Webhooks are a trigger, not data: the app re-fetches through the existing sync code
   (one ingestion path — INV-01/02/111), never ingests a payload's transactions.
4. (W1) The dedupe key is provider-supplied: Teller's event id; Plaid's signed
   verification JWT (hashed). A Plaid body hash would drop legitimate repeats.

## Batches (broad-implement sized)
| Batch | Scope | Status |
|---|---|---|
| W1 | Receivers + event log: `POST /perfin/api/webhooks/{plaid,teller}`, shell gate exemption, mounted before session / auth / CSRF / API key / activity; `webhook_events` (dedupe, 30-day prune, UNTOUCHED); 200 then detached handler; 512 KB cap; failed-verification limiter. 503 until W2. | DONE |
| W2 | Verification. Plaid: `Plaid-Verification` ES256 JWT, `webhookVerificationKeyGet` by `kid` (cache, `expired_at`), `iat` ≤ 5 min, `request_body_sha256` = SHA-256 of `req.rawBody`; dedupe key = hash of the JWT. Teller: HMAC-SHA256 over timestamp + raw body, digest compare (INV-104), timestamp window, `TELLER_WEBHOOK_SECRET` comma-separated for rotation; dedupe key = event id. Confirm Teller's header format against its docs first. Verified events recorded, no handlers yet. | DONE (Teller format unconfirmed — re-check before W5's switch-on) |
| W3 | Plaid per-item sync: move the loop body of `syncAllPlaidTransactionsOnce` into `syncOnePlaidItem(client, item)`; `runPostSyncSteps(added)` out of `syncAllTransactionsOnce` (rename rules + one anomaly check, INV-67); `SYNC_UPDATES_AVAILABLE` → that item under `withPlaidTxnLock`, coalesced (re-run-once flag); `plaid_items.last_synced_at`. | DONE (handler in routes/plaid-webhook-events.js; INV-138) |
| W4 | Plaid item events (ERROR / PENDING_EXPIRATION / PENDING_DISCONNECT / USER_PERMISSION_REVOKED → `setPlaidItemErrorCode`; LOGIN_REPAIRED clears; NEW_ACCOUNTS_AVAILABLE notifies; HOLDINGS / INVESTMENTS_TRANSACTIONS → `syncAllPlaidHoldings({ itemId })`; lookup in plaid_items and plaid_investment_items) + registration: `webhook` on the four `linkTokenCreate` calls when `hosting.publicUrl()` is known; `POST /api/plaid/webhooks/register` (`itemWebhookUpdate` for every GOOD item); the URL stored per item. | |
| W5 | Teller events: `syncTellerEnrollment(id)` (incremental, anomaly skipped, then `runPostSyncSteps`), `transactions.processed`, `enrollment.disconnected` (status DISCONNECTED + one notification), `webhook.test`; `teller_enrollments.last_synced_at`. | |
| W6 | Visibility: Sync Health Webhooks line (last event per provider, failures in 24 h, Register button); operator checks (no Teller secret — info; Plaid items not registered at the current address — warn; no webhook in 7 days while configured — info); per-connection freshness in data-health; the new invariant; docs. | |

## Operator steps (after W4 / W5)
- Teller dashboard: add the webhook URL; set `TELLER_WEBHOOK_SECRET`.
- Plaid: set `PUBLIC_URL`, press Register webhooks once.
- Check end to end with Plaid's `sandboxItemFireWebhook` and Teller's test event.
