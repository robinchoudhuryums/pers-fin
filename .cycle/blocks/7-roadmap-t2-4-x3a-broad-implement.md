---BROAD SCAN IMPLEMENTATION SUMMARY---
Findings implemented: None (roadmap item)
New capabilities (G/ST): Roadmap T2.4 X3a — unified search, the finance results: Per-sistant's GET /api/search also returns Perfin's transactions (the 10 newest by display merchant / notes / category, at the user's share), active subscriptions, manual bills, goals and accounts under the shell, read-only through perfinPool, fail-soft; the dashboard search widget links them into Perfin
Files modified: apps/per-sistant/routes/finance-search.js (new), apps/per-sistant/routes/search.js, apps/per-sistant/views/js.js, apps/per-sistant/pages/dashboard-script.js, apps/per-sistant/tests/roadmap-t2-4-x3a.test.js (new), apps/per-sistant/tests/roadmap-t2-4-x1b.test.js, tests/contract/finance-search.contract.test.js (new), CLAUDE.md, README.md, apps/per-sistant/CLAUDE.md

CHANGES:
X3a | apps/per-sistant/routes/finance-search.js | searchFinance(perfinPool, pattern): five read-only queries (transactions joined to linked_accounts at Perfin's own SPLIT_AMOUNT, lazily required — INV-48; active non-dismissed non-cancelled subscriptions; active manual bills; active goals; linked accounts minus the Plaid brokerage phantom + active investment accounts), LIMIT 10 each, Promise.allSettled so a failing (or SQL-building) query drops only its rows and the request logs once; never rejects. Result { group:'finance', app:'perfin', type, id, title, description, url } — url a path inside Perfin (transaction: /transactions?q=<merchant>&month=YYYY-MM; /subscriptions, /calendar, /goals, /accounts/:id/history?source=…).
X3a | apps/per-sistant/routes/search.js | q must be a string of 2-200 characters (over 200 → 400; a repeated q → []); the finance group is appended to the same flat array, run concurrently with the Per-sistant queries, with the same escaped pattern (F124). Standalone (no perfinPool): no Perfin query.
X3a | apps/per-sistant/views/js.js | linkedAppHref(app, path) — the chip's safe-link rule extracted (same-app path, http(s) or root-relative base) and reused by linkedTaskChip.
X3a | apps/per-sistant/pages/dashboard-script.js | the search widget renders finance rows ("<type> · Perfin", escaped title/detail) as a link through linkedAppHref (plain text without one), no inline actions; a failed fetch or non-array reply reads as "No results".
X3a | tests | 10 unit tests (+ the x1b chip loader now slices from linkedAppHref); 4 contract cases with both databases; docs folded in.

TEST RESULTS: npm test 2223/2223 (10 new); contract 231/231 (4 new); Playwright 58/58 (dashboard unchanged on load + sweep); 19 of 20 mutations red, one equivalent (dropping the no-perfinPool early return — with no pool nothing can be queried). No schema change — migration test not needed.
REGRESSION RISKS: /api/search now 400s a q over 200 characters (the widget treats it as no results); the existing flat array keeps its shape (finance rows are appended with group:'finance'); the chip's link rule moved into linkedAppHref unchanged (the x1b chip tests pass).
INVARIANTS AT RISK: None — INV-25/35 (perfinPool read-only, never a self-fetch), INV-48 (SPLIT_AMOUNT imported, not re-typed), INV-10 (the escaped pattern, F124), INV-97 (no backslash regex added to the template-literal modules), INV-27 (secret-note rules unchanged).
NET SCORE: 0 production fixes − 0 new failure modes = 0 (new capability)

OPERATOR ACTIONS / DEPLOY:
- None | BLOCKS DEPLOY: N
Deploy: Platform, Shell & Auth: Render auto-deploys on push to `main`.

FOLLOW-ON ITEMS:
- Finance results are a flat 10 per kind — no paging and no ranking across kinds.
- A transaction is found by display merchant, notes or category only (not its raw bank description or amount).
- Recurring transfers and housing obligations aren't searched.

DOCUMENTATION UPDATES NEEDED:
- None (folded into this batch; the /search page, nav links and INV-144 are X3b)
---END BROAD SCAN IMPLEMENTATION SUMMARY---
