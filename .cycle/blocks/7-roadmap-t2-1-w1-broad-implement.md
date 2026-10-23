---BROAD SCAN IMPLEMENTATION SUMMARY---
Findings implemented: None (roadmap work, not scan findings)
New capabilities (G/ST): Roadmap T2.1 (Plaid and Teller webhooks), batch W1 of W1–W6 (.cycle/plan-t2-1-webhooks.md) —
  W1 the two webhook receivers, their pass through the shell gate, the webhook_events log and the record-then-detach pipeline. No verifier is configured yet, so both endpoints answer 503 and record nothing until W2.
Files modified: teller/routes/webhooks.js (new), teller/server.js, shell/middleware/auth.js, teller/services/database.js, scripts/reset-fresh.js, tests/roadmap-t2-webhooks-w1.test.js (new), tests/contract/webhooks-w1.contract.test.js (new), .cycle/plan-t2-1-webhooks.md (new)

CHANGES:
W1 | teller/routes/webhooks.js | createWebhookRouter({ verifiers, handlers, db, defer, now }) → POST /api/webhooks/:provider (plaid | teller; anything else 404): body required (400) and capped at 512 KB (413); verifier not configured → 503, nothing recorded; bad / throwing verification → 401 "Signature verification failed." logged with console.warn (not the error log); failed verifications limited to 20 per IP per 15 min (only 401s count); a verified event is INSERTed into webhook_events ON CONFLICT (provider, dedupe_key) DO NOTHING — a duplicate answers 200 { duplicate: true } and isn't processed; a failed insert answers 500 (not acknowledged); otherwise 200 at once, then the provider's handler runs detached and the row is finished done / ignored (no handler) / failed with a fixed sentence; the 30-day prune runs at most once a day. The body is never stored or logged. The production instance has no verifiers or handlers (W2–W5 add them). Exports createWebhookRouter, MAX_BODY_BYTES, RETENTION_DAYS, WEBHOOK_PATHS after module.exports (INV-19)
W1 | teller/server.js | express.json keeps req.rawBody (standalone; the shell's parser already does); the webhooks router is mounted before the activity touch, session, requireAuth, CSRF and API-key middleware
W1 | shell/middleware/auth.js | isSelfAuthenticatingRoute: an exact set of POST paths — the Per-sistant receiver plus /perfin/api/webhooks/plaid and /perfin/api/webhooks/teller
W1 | teller/services/database.js, scripts/reset-fresh.js | webhook_events (provider CHECK plaid|teller, event_type / event_code / subject, dedupe_key, status CHECK received|processing|done|failed|ignored, error, received_at, processed_at, UNIQUE (provider, dedupe_key), index on received_at); in UNTOUCHED_TABLES (operational log, like app_errors)
Tests | tests/roadmap-t2-webhooks-w1.test.js (15), tests/contract/webhooks-w1.contract.test.js (6) | the production 503s with no write; 400 / 413 / 404; 401 + warn + nothing recorded; a throwing verifier; record → 200 → detached handler → done; ignored / failed fixed error; duplicate not processed; insert failure 500; body never in params or logs; the limiter (503s don't count, the 21st failure 429s); the daily prune; the shell gate (exact paths, GET refused); the server.js mount order; the table + reset-fresh class; on real Postgres the CHECKs, one row per delivery, per-provider dedupe, the failed row, the prune boundary and the production router recording nothing

TEST RESULTS: npm test 1930/1930 (15 new); contract 173/173 (6 new); migrations twice on an empty database OK; Playwright 57/57. Mutation checks: dropping ON CONFLICT turns a unit and a contract test red; dropping a path from the shell exemption turns the gate test red.
REGRESSION RISKS:
- Two new pre-auth POST endpoints. They answer 503 until W2 and do nothing else; a 503 doesn't count toward the failed-verification limiter, so they can be called freely (cheap: the shell already parsed the body).
- Perfin's standalone JSON parser now keeps a reference to every request's raw buffer (memory only for the request's life).
- The webhooks router sits ahead of every other Perfin middleware; it matches only POST /api/webhooks/:provider.
INVARIANTS AT RISK: None. INV-19 (helpers attached after the router export), INV-25 (embedded auth unchanged; the exemption is exact), INV-103 (no body logged), INV-104 (no secret compare added yet — W2's HMAC must use digests), INV-81 (webhook_events classified). New invariant for /sync-docs: a webhook event is verified before anything is recorded, recorded once per provider dedupe key, processed at most once, and its body is never stored or logged.
NET SCORE: 0 production fixes − 0 new failure modes = 0 (new capability; nothing acts on an event yet)

OPERATOR ACTIONS / DEPLOY:
- None for W1 (both endpoints stay inert) | BLOCKS DEPLOY: N
Deploy: Platform, Shell & Auth — Render auto-deploys on push to `main` (PR robinchoudhuryums/pers-fin#133); the migration adds one table on boot.

(Not complete in production until blocking operator actions are done AND
the deploy step is confirmed.)

FOLLOW-ON ITEMS:
- Decision taken in W1: the dedupe key is provider-supplied (Teller's event id; for Plaid, W2 will use a hash of the signed verification JWT). The plan's "Plaid body hash within 24 hours" would have dropped legitimate repeats — Plaid's SYNC_UPDATES_AVAILABLE body is identical every time for an item.
- A row left 'processing' by a restart stays that way (W6 shows statuses; the daily sync covers the data).
- scripts/reset-fresh.js's header comment still omits several UNTOUCHED / WIPE tables (pre-existing seams-audit #3 note; webhook_events joins them).

DOCUMENTATION UPDATES NEEDED:
- CLAUDE.md: Architecture (routes/webhooks.js), Security (the self-authenticating routes now include the two webhook POSTs), Database (webhook_events), Commands / endpoints (the two POSTs, 503 until configured), the new invariant, test counts (1930 / 97 files / Perfin 1379, contract 173) + the two test-file descriptions, Known Open Issues (T2.1 in progress, W2–W6 pending).
- README: counts.
---END BROAD SCAN IMPLEMENTATION SUMMARY---
