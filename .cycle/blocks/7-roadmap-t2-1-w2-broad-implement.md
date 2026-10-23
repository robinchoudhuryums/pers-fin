---BROAD SCAN IMPLEMENTATION SUMMARY---
Findings implemented: None (roadmap work, not scan findings)
New capabilities (G/ST): Roadmap T2.1 (Plaid and Teller webhooks), batch W2 of W1–W6 (.cycle/plan-t2-1-webhooks.md) —
  W2 signature verification: Plaid's ES256 JWT and Teller's HMAC; verified events are recorded (marked 'ignored' — no handler acts yet). Also folds in W1's documentation.
Files modified: teller/services/webhook-verify.js (new), teller/routes/webhooks.js, tests/roadmap-t2-webhooks-w2.test.js (new), tests/contract/webhooks-w2.contract.test.js (new), tests/roadmap-t2-webhooks-w1.test.js, tests/contract/webhooks-w1.contract.test.js, CLAUDE.md, README.md, .cycle/plan-t2-1-webhooks.md, .cycle/STATE.md

CHANGES:
W2 | teller/services/webhook-verify.js | createPlaidVerifier({ getClient, now }): Plaid-Verification JWT (≤4 KB, three parts), alg must be ES256 (refused before any key fetch), key by kid via webhookVerificationKeyGet (cached 24h; an expired_at key refused), signature checked with Node crypto (JWK → public key, ieee-p1363), iat within 5 min (1 min skew ahead), request_body_sha256 compared (digest compare) with the SHA-256 of req.rawBody; dedupe key "jwt:" + SHA-256 of the token; event { webhook_type, webhook_code, item_id }. configured() = a Plaid client exists (credentials set). createTellerVerifier({ secrets, now }): Teller-Signature "t=…,v1=…[,v1=…]", HMAC-SHA256 hex over "<t>.<raw body>", every v1 against every secret (TELLER_WEBHOOK_SECRET, comma-separated for rotation), digest compares with no early exit, t within 5 min; dedupe key "evt:" + event id, or "sig:" + a hash of the signature when an event has no id; event { type, subject: payload.enrollment_id }. configured() = a secret is set. Exports parseTellerSignature, tellerSecrets, MAX_AGE_MS
W2 | teller/routes/webhooks.js | the production router uses the two verifiers (header comment updated); no handlers yet, so a verified event ends 'ignored'
W2 | tests/roadmap-t2-webhooks-w1.test.js, tests/contract/webhooks-w1.contract.test.js | the "503 / nothing recorded" tests now clear PLAID_CLIENT_ID and TELLER_WEBHOOK_SECRET first — "unconfigured" is now a real state, not a constant
Docs (W1 + W2) | CLAUDE.md, README.md | Architecture (routes/webhooks.js, services/webhook-verify.js), reset-fresh's UNTOUCHED list (also app_errors, which it was missing), counts 1944 / 97 files / Perfin 1393, contract 175 + the new test-file descriptions, the two endpoints, TELLER_WEBHOOK_SECRET, webhook_events, the Security note on the self-authenticating routes, the Bank Sync subsystem file list, new INV-137, Known Open Issues (T2.1 in progress; Teller format unconfirmed)
Tests | tests/roadmap-t2-webhooks-w2.test.js (14), tests/contract/webhooks-w2.contract.test.js (2) | Plaid JWTs signed with a local P-256 key: valid, tampered body, stale / future iat, alg none / HS256 / RS256 with no key fetch, unknown / expired / other key, malformed and oversized tokens, the key cache, unconfigured without a client; Teller: valid, wrong secret, tampered body, stale / future / in-window t, rotation (two secrets, two v1 values), upper-case hex, id-less events, garbage headers, secret parsing; both through the production router (recorded once and 'ignored', a replay a duplicate, a forgery a 401 that never reaches the insert); on real Postgres the same for both providers

TEST RESULTS: npm test 1944/1944 (14 new); contract 175/175 (2 new); Playwright not re-run (W2 touches no page or mount; 57/57 on W1). Mutation checks: dropping the Plaid body-hash comparison or Teller's timestamp window turns 3 tests red.
REGRESSION RISKS:
- With Plaid credentials set (as on Render), POST /perfin/api/webhooks/plaid now verifies instead of answering 503: a well-formed JWT with an unknown kid makes the server call Plaid's key endpoint (refusals before that point need no network). Plaid only sends webhooks once W4 registers the URL, so in practice only forged requests reach it; the per-IP failure limiter caps them.
- A Plaid key-endpoint outage turns real deliveries into 401s, which count toward the failure limiter for Plaid's IPs (the daily sync is the backstop).
- Teller's header format is unconfirmed (see follow-ons); if it differs, every Teller delivery is a 401 — visible once W6 shows failures, harmless otherwise.
INVARIANTS AT RISK: None. INV-104 (every new secret compare is a SHA-256 digest compare), INV-103 (nothing logs a body or a signature), INV-137 (new — verified before recorded, once per dedupe key, body never stored).
NET SCORE: 0 production fixes − 0 new failure modes = 0 (new capability; still inert — nothing acts on an event)

OPERATOR ACTIONS / DEPLOY:
- None yet (Teller dashboard + TELLER_WEBHOOK_SECRET come with W5; Plaid registration with W4) | BLOCKS DEPLOY: N
Deploy: Bank Sync & Ingestion / Platform — Render auto-deploys on push to `main` (PR robinchoudhuryums/pers-fin#133).

(Not complete in production until blocking operator actions are done AND
the deploy step is confirmed.)

FOLLOW-ON ITEMS:
- Confirm Teller's webhook signature format (header name, "t=…,v1=…", the signed string "<t>.<body>", hex, the 5-minute window) against https://teller.io/docs/api/webhooks before switching Teller webhooks on; its docs couldn't be fetched from the build environment. A Teller "webhook.test" event is the end-to-end check.
- Confirm against Plaid's docs whether it retries a non-200 delivery (affects how much the daily backstop has to cover).
- A cached Plaid key is re-fetched after 24h; a key Plaid expires within that day is still accepted until then (Plaid rotates keys rarely; the iat window still applies).

DOCUMENTATION UPDATES NEEDED:
- None beyond this batch (W1 + W2 docs folded in here).
---END BROAD SCAN IMPLEMENTATION SUMMARY---
