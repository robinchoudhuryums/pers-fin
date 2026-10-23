---BROAD SCAN IMPLEMENTATION SUMMARY---
Findings implemented:
- F87  Rent & Utilities page died once any utility was configured — utilRow's lost `div.innerHTML =` restored
- F88  /accounts/:id/history always 500'd ("activePage is not defined") — nav gets activePage; the nested <html>/<head>/container wrapper is gone
- F89  A sixth toast within 5–10 s hung the tab (infinite loop) — the cap counts only non-leaving toasts and drops the excess synchronously
- F90  Nav "Synced Xm ago" badge + bell unread count never loaded (apiFetch called before perfin-shared.js) — load-time calls go through whenShared() (DOMContentLoaded)
- F74  Web Push never delivered (JSON.parse on a JSONB object) and dead subscriptions were never pruned — subscriptionFromRow accepts the object; non-410 failures are logged
- F60  Insight thumbs-up/down/mixed always 500'd (untyped `$1 IS NULL`) — `$1::text` in both places + a real-Postgres contract test
- F93  Nav logo mask 404'd under /perfin — relative `url(logo.svg)`
- F92  Offline page: Retry CSP-blocked, logo 404 under the shell — external offline.js, relative assets, SW injects <base href="<mount>/">, cache perfin-v6
- F137 (minimum) No browser test loaded the pages that broke — e2e/pages.spec.js loads every Perfin + Per-sistant page (fails on page errors / 5xx) plus targeted F87/F88/F89/F90/F92/F93 checks
New capabilities (G/ST): None
Files modified:
- teller/views/housing.ejs, teller/views/account-history.ejs, teller/views/partials/nav.ejs
- teller/public/perfin-shared.js, teller/public/perfin-shared.css, teller/public/offline.html, teller/public/offline.js (new), teller/public/sw.js
- teller/routes/notifications.js, teller/routes/insights.js
- e2e/pages.spec.js (new), tests/scan-oct-batch2.test.js (new), tests/contract/sync-ai.contract.test.js

CHANGES:
F87  | teller/views/housing.ejs | `div.innerHTML =` restored before the row markup string (lost in Batch 5, 78138a6)
F88  | teller/views/account-history.ejs | head partial with extraStyles `.container { max-width: 980px; }` + `include('partials/nav', { activePage: 'dashboard' })`; outer html/head/body and the inner container removed
F89  | teller/public/perfin-shared.js | showMsg's cap collects non-`toast-leaving` children and removes the excess immediately (no 220 ms deferred removal inside the loop)
F90  | teller/views/partials/nav.ejs | `whenShared(fn)` (run now if window.apiFetch exists, else on DOMContentLoaded) wraps the sync-badge loader and the initial loadNotifs()
F74  | teller/routes/notifications.js | `subscriptionFromRow(row)` (object or JSON string) in sendToAll + /api/notifications/test; non-410/404 send failures console.error'd
F60  | teller/routes/insights.js, tests/contract/sync-ai.contract.test.js | `SET user_feedback = $1::text … CASE WHEN $1::text IS NULL`; contract test sets / changes / clears a rating on real Postgres
F93  | teller/public/perfin-shared.css | `mask: url(logo.svg)` (relative to the stylesheet)
F92  | teller/public/offline.html, offline.js, sw.js | inline onclick/onerror → offline.js listeners; `src="logo.svg"`; SW `offlineResponse()` injects `<base href="BASE/">` (keeps CSP headers, drops content-length); CACHE perfin-v6; offline.js precached
F137 | e2e/pages.spec.js | every-page smoke + targeted checks; logs in once and reuses the cookie (a login per test tripped Per-sistant's limiter — F123); KNOWN_GAPS tolerates the review page's review-summary 500 without an AI key (follow-on below)

TEST RESULTS: passed — npm test 1517/1517, 0 todo (+9 in tests/scan-oct-batch2.test.js; all 9 fail against the pre-fix code). Contract suite 44/44 on local PG16 without pgvector (+1 feedback test; it fails against the pre-fix SQL). Playwright 35/35 (8 existing smokes + 27 in pages.spec.js; 5 targeted specs fail against the pre-fix code). Local Playwright runs used the preinstalled chromium-1194 via a scratch config (the repo's @playwright/test 1.60 expects build 1223; CI installs its own).
REGRESSION RISKS:
- Over-cap toasts now vanish instantly instead of fading (cosmetic).
- Every installed Perfin PWA re-precaches on the perfin-v6 bump (one-time).
- account-history now uses the shared .container (max-width 980 via extraStyles) instead of a nested one — spacing may shift slightly.
- whenShared defers the nav's first fetches to DOMContentLoaded — imperceptible; if perfin-shared.js itself fails to load the badge stays empty (as before).
INVARIANTS AT RISK: None. INV-23 (SW never caches /api/*) unchanged — offlineResponse only rewrites the cached offline page. INV-61 (apiFetch 401 redirect) unchanged.
NET SCORE: 6 − 0 = 6 (production fixes that fired this month: F87, F88, F90, F74, F60, F93. F89 and F92 had no evidence of firing; F137 is structural.)

OPERATOR ACTIONS / DEPLOY:
- After deploy, open Perfin once in the installed PWA so the perfin-v6 service worker activates (old offline page dropped) | BLOCKS DEPLOY: N
- Re-subscribe to push is NOT needed — existing push_subscriptions rows now deliver | BLOCKS DEPLOY: N
Deploy: Platform, Shell & Auth — Render auto-deploys on push to `main` (merge the PR); alt `fly deploy`.

(Not complete in production until blocking operator actions are done AND the deploy step is confirmed.)

FOLLOW-ON ITEMS:
- NEW (found by the page smoke): Per-sistant POST /api/ai/review-summary returns 500 (callAI throws → serverError) instead of 501 when ANTHROPIC_API_KEY is unset; the review page fires it on every load. Tolerated in e2e/pages.spec.js KNOWN_GAPS — remove the entry when fixed.
- F123 (Batch 11) confirmed in practice: Per-sistant's general limiter (200/15 min, not skipped under the shell) was tripped by ~35 page loads, after which pages threw on the 429 JSON (calendar: `events.filter is not a function`).
- Local runs: the repo's @playwright/test 1.60 needs chromium build 1223; this sandbox has 1194 (used via executablePath in a scratch config).
- Batches 3–13 of the cycle-7 plan remain (see .cycle/STATE.md).
DOCUMENTATION UPDATES NEEDED:
- CLAUDE.md: SW cache `perfin-v6` (two places) + offline page served with an injected <base> and external offline.js; Web Push now delivers (JSONB keys) — remove from the cycle-7 Known Open Issues block with the other Batch 2 items; nav whenShared; account-history layout; toast cap; Playwright count (8 → 35) and e2e/pages.spec.js description in the ci.yml / Commands notes; test counts 1517 / 69 files + scan-oct-batch2 description; contract count 43 → 44 (+ feedback).
- README.md: counts.
---END BROAD SCAN IMPLEMENTATION SUMMARY---
