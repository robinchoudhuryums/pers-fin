---BROAD SCAN IMPLEMENTATION SUMMARY---
Findings implemented: None (roadmap item)
New capabilities (G/ST): Roadmap T2.4 X3b — unified search: the page, the links and the T2.4 close-out. One renderer (renderSearchResults in views/js.js) for the dashboard search widget and a new Per-sistant /search page (?q= prefilled and searched, focus on load, "/" shortcut, the URL following the query); a Search entry in Per-sistant's sidebar and a labelled search icon in Perfin's nav to /per-sistant/search (under the shell only); INV-144
Files modified: apps/per-sistant/views/js.js, apps/per-sistant/pages/dashboard-script.js, apps/per-sistant/pages/search.js (new), apps/per-sistant/server.js, apps/per-sistant/views.js, teller/views/partials/nav.ejs, apps/per-sistant/tests/roadmap-t2-4-x3b.test.js (new), apps/per-sistant/tests/roadmap-t2-4-x3a.test.js, e2e/pages.spec.js, CLAUDE.md, apps/per-sistant/CLAUDE.md, README.md

CHANGES:
X3b | apps/per-sistant/views/js.js | renderSearchResults(results, opts): a Per-sistant row (todo / email / note / contact) links to its page through BASE_PATH (the done label kept); opts.actions adds the dashboard's Complete / Send Now / Pin buttons on a real numeric id; a Perfin row links only through linkedAppHref (plain text without a safe link), never with actions; an unknown type is dropped; empty / non-array / all-dropped → "No results". Everything escaped (r.type too — it wasn't).
X3b | apps/per-sistant/pages/dashboard-script.js | the widget calls renderSearchResults(results, { actions: true }); its inline row markup is gone.
X3b | apps/per-sistant/pages/search.js + server.js + views.js | GET /search — a labelled search box, a status line (count / "Type at least 2 characters." / the server's error / a network failure) and the results; ?q= prefilled and searched; focus on load; "/" focuses the box outside fields; history.replaceState keeps ?q= in the URL; a sequence number keeps a slower older search from overwriting a newer one. NAV gains { /search, Search } with an icon.
X3b | teller/views/partials/nav.ejs | an embedded-only search icon link (#nav-search-link, aria-label "Search everything") to /per-sistant/search beside the cross-app link.
X3b | tests | 14 unit tests (renderer in a vm from the emitted bundle, the page script in a vm, nav + route wiring); the X3a widget test now loads the renderer from views/js.js; Playwright: /per-sistant/search in the page list + its sweep, and a test that follows Perfin's nav link, finds the seeded "Corner Cafe" transaction at /per-sistant/search?q= and opens Activity filtered.
X3b | docs | INV-144; CLAUDE.md (integration bullet, test descriptions + counts, e2e count, Known Open Issues: T2.4 DONE with X3b follow-ons); Per-sistant CLAUDE.md (Global Search, pages, /search, counts, linked tasks no longer "in progress"); README.

TEST RESULTS: npm test 2237/2237 (14 new); contract 231/231 (unchanged — no route SQL); Playwright 61/61 (3 new: the page load, its sweep, the search + nav test); 15 mutations all red. (A mid-run Postgres stop in the sandbox failed one contract / Playwright attempt with ECONNREFUSED; both passed after a restart.)
REGRESSION RISKS: The dashboard widget's rows now come from the shared renderer — same markup, except the type label is escaped and a row with a non-numeric id gets no action button. Perfin's nav gains one more item under the shell (the F94 wrap rule covers the width).
INVARIANTS AT RISK: None — INV-144 (new), INV-97 (no backslash regex in the template-literal modules; the emitted bundles node --check), INV-95 (Per-sistant links carry BASE_PATH; Perfin's cross-app links are absolute as before), INV-90 / IF-3 (the new controls are labelled), INV-25 / INV-35 (search reads perfinPool read-only).
NET SCORE: 0 production fixes − 0 new failure modes = 0 (new capability)

OPERATOR ACTIONS / DEPLOY:
- None | BLOCKS DEPLOY: N
Deploy: Platform, Shell & Auth: Render auto-deploys on push to `main`.

FOLLOW-ON ITEMS:
- The /search page has no inline Complete / Send / Pin actions (the dashboard widget keeps them).
- The swipe-between-pages order doesn't include /search.
- A Perfin row opens the page that lists it (Activity filtered by merchant + month, goals / subscriptions / calendar), not the record itself.
- Pre-existing: apps/per-sistant/CLAUDE.md's Key Files still says "21 API route modules" / "9 page rendering modules" (stale before this batch).

DOCUMENTATION UPDATES NEEDED:
- None (folded into this batch)
---END BROAD SCAN IMPLEMENTATION SUMMARY---
