---BROAD SCAN IMPLEMENTATION SUMMARY---
Findings implemented: None (roadmap work, not scan findings)
New capabilities (G/ST): Roadmap T2.1 (Plaid and Teller webhooks), batch W6 of W1–W6 (.cycle/plan-t2-1-webhooks.md) — the last batch; T2.1 is complete.
  W6 visibility: Sync Health shows each provider's webhook status, failures and the Plaid registration (with a Register button) plus each connection's own last complete sync; operator checks flag unregistered Plaid connections (warn) and webhooks off / quiet (info). Docs folded in.
Files modified: teller/services/webhook-status.js (new), teller/services/operator-checks.js, teller/routes/settings.js, teller/views/settings.ejs, tests/roadmap-t2-webhooks-w6.test.js (new), tests/contract/webhooks-w6.contract.test.js (new), CLAUDE.md, README.md, .cycle/plan-t2-1-webhooks.md, .cycle/STATE.md

CHANGES:
W6 | teller/services/webhook-status.js | getWebhookStatus(pool, { env }): one webhook_events aggregate per provider (max(received_at), the latest status, 24h count, 24h failures — no body column read), the Plaid registration count over GOOD plaid_items + investments-only Items (a combined Item counted once; registered = webhook_url starts with hosting.webhookBaseUrl and ends /api/webhooks/plaid, so the /perfin mount needs no knowledge), the non-suspended Teller enrollment count; Plaid configured = a client exists, opted_in = PUBLIC_URL set, Teller configured = a secret set; each query fail-soft (logged, error: true). webhookChecks(status, { now }): webhooks:plaid — omitted without Plaid / connections, info while PUBLIC_URL is unset, WARN "N of M Plaid connection(s) aren't registered at <url>" (fix: Register Plaid webhooks), info after 7 quiet days, else ok; webhooks:teller — omitted without enrollments, info without a secret, info after 7 quiet days, else ok
W6 | teller/services/operator-checks.js | getOperatorChecks adds webhookChecks when a pool or a precomputed opts.webhookStatus is passed (the latter is reused, no second read); fail-soft. The watchdog (which passes the pool) therefore notifies once when a not-registered warning appears
W6 | teller/routes/settings.js | GET /api/data-health: webhooks (getWebhookStatus, shared with the operator checks), connections (Teller enrollments not SUSPENDED + Plaid items not CSV, status NEEDS_REAUTH for a re-auth code, last_synced via ageInfo), a warning per provider with failed events in the last 24h; both blocks fail-soft
W6 | teller/views/settings.ejs | Sync Health: a Webhooks block (per provider "off — set PUBLIC_URL / TELLER_WEBHOOK_SECRET" or last event age + status, 24h count + failures), "N of M Plaid connection(s) registered at <url>" with a "Register Plaid webhooks" button (POST /api/plaid/webhooks/register through writeOk, then reload; data-e2e-skip — an outward action), a collapsible Connections list (freshness dot from the connection's own last_synced_at, "no complete sync recorded yet", the re-auth / disconnected state, escaped names); the Operator Checks description mentions bank webhooks
Tests | tests/roadmap-t2-webhooks-w6.test.js (13), tests/contract/webhooks-w6.contract.test.js (3) | Unit: getWebhookStatus mapping, the registration SQL + param, RENDER_EXTERNAL_URL never counting, fail-soft parts; every webhookChecks branch; operator checks reusing a passed status, the warn in toIssues and the failing signature, none without a pool; data-health's webhooks / connections / failed-event issue and fail-soft blocks; the UI renderers run in a vm from settings.ejs (off states, counts, failures, Register only when it can act + data-e2e-skip, connections + escaping) and the Register wiring. Contract: per-provider status with an older failure not counted, the failed-event issue, connections without CSV / suspended and with NEEDS_REAUTH, the warning for an Item registered at another address, gone after Register; Teller without a secret = info
Docs | CLAUDE.md, README.md | Architecture (webhook-status.js, operator-checks, webhooks.js W1–W6), Sync Health card text, the data-health endpoint note, webhook_url readers, counts 2008 / 101 files / Perfin 1457, contract 189 + test-file descriptions, Bank Sync subsystem list, new INV-141, Known Open Issues (T2.1 done, operator steps, W6 follow-ons)

TEST RESULTS: npm test 2008/2008 (13 new); contract 189/189 (3 new); Playwright 57/57 (the Settings page changed); no schema change, so the migration test wasn't re-run. Mutation checks: counting registration without the PUBLIC_URL prefix, downgrading the not-registered warning to info, or dropping the failed-event issue each turn tests red.
REGRESSION RISKS:
- GET /api/data-health runs three more small queries (events aggregate, registration count, Teller count) plus the connections query on every Sync Health / dashboard-strip load; webhook_events is pruned at 30 days and indexed on received_at.
- Once PUBLIC_URL is set, every GOOD Plaid connection linked before W4 raises a "not registered" warning (dashboard strip + one operator-checks notification) until "Register Plaid webhooks" is pressed — intended, but it appears on the deploy that sets PUBLIC_URL.
- A failed webhook event raises a data-health warning for 24h even if the next scheduled sync recovered the data.
INVARIANTS AT RISK: None. INV-137 / INV-103 (no body read or shown), INV-126 (operator checks fail-soft; nothing GitHub-related changed), INV-129 / INV-130 (the new button is data-e2e-skip), new INV-141.
NET SCORE: 0 production fixes − 0 new failure modes = 0 (new capability)

OPERATOR ACTIONS / DEPLOY:
- To switch Plaid webhooks on: set PUBLIC_URL, then Settings → Sync Health → "Register Plaid webhooks" | BLOCKS DEPLOY: N
- To switch Teller webhooks on: confirm Teller's signature format and transactions.processed payload against its docs, add the URL in the Teller dashboard, set TELLER_WEBHOOK_SECRET, send its test event | BLOCKS DEPLOY: N
Deploy: Bank Sync & Ingestion / Platform — Render auto-deploys on push to `main` (PR robinchoudhuryums/pers-fin#133).

(Not complete in production until blocking operator actions are done AND
the deploy step is confirmed.)

FOLLOW-ON ITEMS:
- The Connections list has no per-connection link (re-authentication lives on the Accounts page).
- A webhook_events row a restart caught mid-handler ('processing') counts in neither done nor failed.
- The 7-day quiet check can't tell a quiet account from a broken URL (both are info).
- Teller's signature format / payload still unconfirmed (docs unreachable from the build environment).

DOCUMENTATION UPDATES NEEDED:
- None beyond this batch (docs folded in).
---END BROAD SCAN IMPLEMENTATION SUMMARY---
