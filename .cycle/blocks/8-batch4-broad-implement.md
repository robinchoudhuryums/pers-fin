---BROAD SCAN IMPLEMENTATION SUMMARY---
Findings implemented:
- F1 — the anomaly watermark no longer skips rows an overlapping write commits: it advances to the newest created_at visible BEFORE the candidate read (kept below the start of any other transaction still writing on the database), the candidates stop at that mark, and it never moves backwards — it used to be now() after the candidate read and the sends
- F51 — "Paycheck landed" re-reads 24 hours behind its watermark and skips a deposit there that was already announced (its tag in notification_log), so a CSV import whose rows carry the import's start time is no longer stepped past; the watermark never moves backwards
- F3 — the Plaid webhook verifier remembers a kid Plaid has no key for (an hour), caps uncached key lookups (20 an hour per process), shares one lookup per kid, refuses a malformed kid and checks iat and the body hash before any lookup
New capabilities (G/ST): None
Files modified:
- teller/routes/enrollments.js
- teller/services/payday-alerts.js
- teller/services/webhook-verify.js
- tests/broad-scan-c8-batch4.test.js (new)
- tests/contract/c8-batch4.contract.test.js (new)
- tests/roadmap-t2-2-cash-l3.test.js
- tests/roadmap-t2-webhooks-w3.test.js

CHANGES:
F1 | teller/routes/enrollments.js | runAnomalyCheck reads last_anomaly_check_at as text; then `SELECT LEAST((MAX(created_at) of rows after the watermark), (MIN(xact_start) − 1µs of pg_stat_activity rows on this database, not this backend, holding an xid))::text AS hw`; nothing new → returns with no candidate read and no update; the candidate query adds `t.created_at <= $2` (the mark); the update sets the mark (text) only when it is later than the stored watermark. A failed push still holds it. Without pg_stat_activity rights the writer bound is NULL and LEAST ignores it.
F51 | teller/services/payday-alerts.js | LANDED_OVERLAP_HOURS = 24: candidates `created_at > $1 − 24 h`, each flagged in_overlap (created_at <= the watermark); one `SELECT DISTINCT type FROM notification_log WHERE type = ANY(tags) AND created_at > now() − 30 days` for the overlap rows that match a stream; those already logged are skipped; the update is `GREATEST(last_income_alert_at, $1)`. A failed dedupe read throws (the post-sync step is isolated; the watermark stays).
F3 | teller/services/webhook-verify.js | KID_RE (1–128 of [A-Za-z0-9_-]); the iat window and request_body_sha256 checks moved before the key lookup (the signature is still verified after); keyFor: miss cache (KEY_MISS_CACHE_MS 1 h — a null key or a 4xx from Plaid; a 5xx / network error isn't cached), KEY_FETCH_LIMIT 20 uncached lookups per KEY_FETCH_WINDOW_MS 1 h (over it → no lookup, a cached key still verifies), one in-flight lookup per kid, the cache capped at 200 kids.
Tests | tests/broad-scan-c8-batch4.test.js, tests/contract/c8-batch4.contract.test.js, tests/roadmap-t2-2-cash-l3.test.js, tests/roadmap-t2-webhooks-w3.test.js | 13 unit tests (the anomaly mark's SQL, order, params and text update, no-new-rows, a failed push; the payday overlap SQL, an unannounced overlap row announced, an announced one skipped, the GREATEST update, no dedupe read without a stream match; the verifier's miss cache + expiry, the lookup cap with a cached key still verifying, the shared lookup, malformed kid / stale iat / wrong hash with no lookup, 4xx cached vs 5xx not) + 2 contract tests on real Postgres with an open transaction committing after a check (an anomaly and a paycheck each caught on the next run, once). Two test doubles follow the new settings SELECT text and answer the mark query. Mutation checks 10/10 red.

TEST RESULTS: passed — npm test 2626/2626; contract suite 264/264 (local Postgres 16, no pgvector); Playwright 72/72 (scratch config → preinstalled Chromium).
REGRESSION RISKS:
- F1: while another transaction on the database holds an xid (a long CSV import, a stuck idle-in-transaction connection), the anomaly watermark can't pass its start, so anomaly alerts for rows after it wait until it ends — delayed, not lost.
- F3: the lookup cap is per process — an attacker sending 20 forged kids an hour keeps it spent, and after a restart a real webhook whose kid isn't cached yet fails verification until the window rolls (previously the same flood spent Plaid's quota instead).
- F51: a deposit up to 24 h old that didn't match a stream when first read and matches one now (its stream formed in between) is announced late; a failed dedupe read stops that sync's landed check (retried at the next sync).
INVARIANTS AT RISK: None violated. Touched: INV-67 / INV-05 (the anomaly check still runs once per sync, never on a reconcile), INV-142 (the landed alert stays once per deposit — now through its tag in notification_log across the overlap), INV-137 (a webhook is still verified before anything is recorded; the cheap checks now come first).
NET SCORE: 0 − 2 = -2 (production fixes: none with evidence this month — the race needs an overlapping writer during the check, payday alerts are opt-in and off, and no forged-kid traffic is known. New failure modes: F1's open-writer delay, F3's per-process cap after a restart under a flood)

OPERATOR ACTIONS / DEPLOY:
- None
Deploy: Bank Sync & Ingestion / Financial Analytics — Render auto-deploys on push to `main` (configured in the Render dashboard).

(Not complete in production until blocking operator actions are done AND
the deploy step is confirmed.)

FOLLOW-ON ITEMS:
- The same "watermark past an uncommitted row" shape exists in GET /api/whats-new's last_dashboard_view_at (now()) — not in this batch (the scan's ST suggests a transactions.id-based scheme for all three).
- The Plaid verifier's caches and cap are per process; two instances (a deploy overlap) each get their own.
- tests/roadmap-t2-4-x2a.test.js's intermittent node:test IPC failure (pre-existing).
DOCUMENTATION UPDATES NEEDED:
- CLAUDE.md user_settings.last_anomaly_check_at + the real-time anomaly alerts note: the watermark is the mark read before the candidates, bounded by open writers, never now() (F1).
- CLAUDE.md services/payday-alerts.js entry + Payday alerts: the 24 h overlap and the tag dedupe; GREATEST update (F51).
- CLAUDE.md services/webhook-verify.js entry: kid format, the miss cache, the lookup cap, one lookup per kid, cheap checks first (F3).
- CLAUDE.md test counts (2613 → 2626 tests, 136 → 137 files; contract 262 → 264), the new test files, INV-142 wording, and the cycle-8 Known Open Issues section (Batch 4 done + follow-ons).
---END BROAD SCAN IMPLEMENTATION SUMMARY---
