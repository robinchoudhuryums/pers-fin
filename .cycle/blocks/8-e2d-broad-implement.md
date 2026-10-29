---BROAD SCAN IMPLEMENTATION SUMMARY---
Findings implemented: None (E2d is new capability)
New capabilities (G/ST): ST3 (part 2 of 2, E2d) — "Since you last looked" moves its watermark to what the dashboard's GET actually read (a seen_token: the newest transaction id + the database time, read before its queries) instead of now() at the delayed /seen POST, and reads new transactions by id.
Files modified: teller/routes/whats-new.js, teller/services/database.js, teller/views/dashboard.ejs, tests/cycle8-e2d.test.js (new), tests/contract/whats-new-e2d.contract.test.js (new), .cycle/plan-e2-scheduler-watermarks.md, .cycle/STATE.md

CHANGES:
ST3 (E2d) | teller/routes/whats-new.js | GET /api/whats-new reads services/txn-watermark.readMark first and returns seen_token "<id>|<timestamptz text>"; getWatermark also reads last_dashboard_view_txn_id; with a stored id the new transactions are `id > stored AND id <= mark` (gatherWhatsNew(since, { sinceTxnId, untilTxnId })), without one (and for the daily digest's gatherWhatsNew(since)) created_at as before; subscriptions, notifications and balance changes stay on the time. POST /seen with a token: SEEN_SQL — last_dashboard_view_txn_id = GREATEST(stored, LEAST(token id, MAX(id))), last_dashboard_view_at = GREATEST(stored, LEAST(token time, now())); a malformed token (parseSeenToken — digits | a timestamptz shape) is a 400 that writes nothing; no token → SEEN_NOW_SQL (now() and the newest id — the pre-E2d meaning). parseSeenToken / SEEN_SQL / SEEN_NOW_SQL exported for tests
ST3 (E2d) | teller/services/database.js | user_settings.last_dashboard_view_txn_id BIGINT (no backfill: NULL reads by created_at until the first /seen with a token)
ST3 (E2d) | teller/views/dashboard.ejs | the widget's delayed /seen POST sends { seen_token } as JSON when the GET returned one (plain POST otherwise)

TEST RESULTS: npm test 3016/3016 (12 new in tests/cycle8-e2d.test.js — parseSeenToken's accepted / refused shapes; GET reading the mark first and returning seen_token, by id with a stored id (params, the time for the other sources), by created_at without one and for the digest; /seen storing the token (capped, forward only), a malformed token a 400 with no write, the token-less fallback; the migration; the widget run in a vm from dashboard.ejs posting the token as JSON 4 s after rendering, a plain POST without one, no POST when nothing is new). Contract 309/310 — new whats-new-e2d 4/4 through the production mount order (a transaction and a notification arriving between the GET and /seen shown on the next visit and not again; an older token after a newer one not moving the watermark back; a future / too-high token capped and a malformed one a 400; a token-less /seen meaning "seen up to now"); the 1 failure is tests/contract/cash-alerts-l2's date-dependent seed (pre-existing). Mutation: ignoring the token in /seen turns 2 of the 4 contract tests red. E2e 73/73 (PW_CHROMIUM_PATH) — the dashboard loads clean.
REGRESSION RISKS: (1) A transaction whose id was allocated before the GET's mark but committed after it (an overlapping sync or CSV import at that moment) is never listed — the widget has no overlap rescan (plan decision 7: here a row shown twice is the acceptable error, so the id is exact rather than overlapped; the anomaly / payday checks have the overlap). (2) Two dashboard tabs: each posts its own token, forward only — the later GET wins; nothing goes backwards. (3) An old page (no token) after a newer one still sets the time to now(), as before E2d.
INVARIANTS AT RISK: INV-152 (the anomaly / payday half is unchanged; the widget follows its mark-before-read and forward-only rules without the overlap). INV-77 / INV-18 unaffected. None violated.
NET SCORE: 0 − 0 = 0 (new capability)

OPERATOR ACTIONS / DEPLOY:
- None | BLOCKS DEPLOY: N
Deploy: Platform, Shell & Auth: Render auto-deploys on push to `main`.

FOLLOW-ON ITEMS:
- A pending transaction that settles later keeps its id / created_at, so "Since you last looked" (pending = false) still never lists it (plan decision 8, pre-existing)
- A late-committing lower id is never listed by the widget (risk 1) — an overlap rescan with a "shown" record would close it
- E2 is complete; E3–E5 remain before cycle 8's /reflect
- tests/contract/cash-alerts-l2's seed is still date-dependent

DOCUMENTATION UPDATES NEEDED:
- CLAUDE.md: whats-new.js entry / the "Since-you-last-looked widget" feature bullet (the seen_token, by id), the user_settings.last_dashboard_view_at entry + the new last_dashboard_view_txn_id column, the GET / POST endpoint docs, the "since last X" design decision, INV-152 (the widget's rule), Known Open Issues (E2 complete; Batch 4's "Since you last looked still advances to now()" follow-on closed), counts (3016 / 163 files / Perfin 2295; contract 310), the new test entries
---END BROAD SCAN IMPLEMENTATION SUMMARY---
