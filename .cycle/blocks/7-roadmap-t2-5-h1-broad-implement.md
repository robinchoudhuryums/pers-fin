---BROAD SCAN IMPLEMENTATION SUMMARY---
Findings implemented: None (roadmap work, not scan findings)
New capabilities (G/ST): Roadmap T2.5 H1 — Plaid Re-authenticate / Add accounts through Plaid's hosted page on iOS / iPadOS, the home-screen app and the Capacitor wrapper (closes the Batch 19 follow-on); INV-145; T2.5 close-out
Files modified:
- teller/routes/investments.js
- teller/views/accounts.ejs
- tests/roadmap-t2-5-h1.test.js (new)
- tests/scan-oct-batch19.test.js
- tests/contract/plaid-update.contract.test.js
- CLAUDE.md
- README.md
- .cycle/STATE.md
- .cycle/plan-t2-5-undelete-ios-reauth.md

CHANGES:
H1 | teller/routes/investments.js | POST /api/plaid/link-token-update takes hosted: true (strict) plus redirect_uri. A missing or non-string redirect_uri is a 400 before anything is read. It adds redirect_uri and hosted_link { url_lifetime_seconds: 3600, completion_redirect_uri } — the /api/plaid/hosted-link values — to the unchanged update-mode request (access_token, no products, account selection, webhookParam), and returns hosted_link_url. POST /api/plaid/update-complete takes an optional link_token (a non-empty string, else 400). After the item validation (404 / 400 / 409 as before), it reads the Link session through linkTokenGet BEFORE anything else. updateSessionState returns 'finished' when a session finished without an exit, else 'exited', 'unfinished' or 'none'. Anything but finished is a 400 { reason }; a Plaid error is a fixed 502 that logs only the error code. In both cases nothing is written and accountsGet isn't called. A finished session runs the unchanged body. Without a link_token (the in-page flow) nothing changes. updateSessionState is exported.
H1 | teller/views/accounts.ejs | prefersHostedPlaidLink(w) is true for an iPhone / iPad / iPod UA, a Mac UA with touch points (iPadOS), display-mode: standalone or navigator.standalone, and window.Capacitor. completePlaidUpdate(id, kind, name, linkToken) is the shared finish. updatePlaidItem takes the hosted path there: the token request with hosted + redirect_uri (trailing slash trimmed); { item_id, kind, name, link_token } saved in sessionStorage as perfin_plaid_update; then a redirect to hosted_link_url, or an error if Plaid returned none. Elsewhere it opens the in-page Link as before. handlePlaidUpdateReturn (on load) removes the saved state and cleans the URL BEFORE calling update-complete with the link_token; bad saved state is reported. handlePlaidOAuthReturn leaves an update return alone; the new-link hosted return reads only its own keys. The Re-authenticate / Add accounts buttons are data-e2e-skip (they leave the app).
H1 | tests/roadmap-t2-5-h1.test.js | 19 tests: the hosted token request, the in-page request unchanged, the 400 before reads, updateSessionState, update-complete's session check (finished / exited / unfinished / none / Plaid 502 / investments / bad token / 404 first / no token), and the Accounts page in a vm (device choice over 10 cases, hosted + in-page updatePlaidItem, the return handler's order and body, a refusal, bad state, the wiring).
H1 | tests/scan-oct-batch19.test.js | The button and body pins now allow data-e2e-skip and the shared body / completePlaidUpdate.
H1 | tests/contract/plaid-update.contract.test.js | +2: the hosted token request on real Postgres; a hosted update whose session exited changes nothing (flag, cursor, new account). The existing update-complete case now goes through a finished hosted session (the flag is cleared).
H1 | CLAUDE.md, README.md | INV-145. Plaid Features (update mode via the hosted page) and the Plaid gotcha (in-page on desktop, hosted on iOS / standalone / Capacitor, unverified against live docs). Commands (both routes). Known Open Issues: T2.5 DONE with the H1 follow-ons; the Batch 19 follow-on closed. Contract description, test counts (2290 / 120 / Perfin 1632; contract 238). README.

TEST RESULTS:
- npm test 2290/2290 (19 new).
- Contract 238/238 (2 new).
- Playwright 63/63 (the Accounts page loads and sweeps clean; no Plaid item is seeded, so the buttons aren't rendered there).
- Mutation checks: 13/13 caught.
  - Server: no redirect_uri check; hosted_link without completion_redirect_uri; a truthy rather than strict `hosted`; a session with an exit counted as finished; only 'exited' refused; the 502 swallowed; the link_token type check removed.
  - Client: no touch-Mac case; no Capacitor; the state not removed before the call; the link_token not sent; the OAuth guard removed; the trailing slash kept.
- Migrations: not re-run — no schema change.
REGRESSION RISKS:
- The in-page path is unchanged apart from moving its onSuccess body into completePlaidUpdate. A non-string link_token sent by an old client would now be a 400, but the old client sends none.
- A device that matches prefersHostedPlaidLink but where Plaid's hosted update fails would lose the in-page fallback. There is no button to choose; this is the plan's decision 6.
INVARIANTS AT RISK: None.
- INV-128: update mode still sends the item's own token, no products, no exchange, new accounts before the walk.
- INV-145 (new) holds: the flag is cleared only after Link reports a finished session.
- INV-103 / INV-22: errors log only Plaid's error code, never a token.
NET SCORE: 0 production fixes − 0 new failure modes = 0 (new capability; the hosted update path is unverified against live Plaid — stated as a trade-off, not a failure mode)

OPERATOR ACTIONS / DEPLOY:
- Try Re-authenticate (or Add accounts) once on an iPhone / the home-screen app after the deploy. Hosted Link's update-mode support was read from the Plaid SDK's types and Plaid's glossary; plaid.com's docs weren't reachable from the build environment. | BLOCKS DEPLOY: N
- The redirect URI (<public address>/perfin/accounts) must be in Plaid Dashboard → Allowed redirect URIs. It already is if "Link via Plaid" works. | BLOCKS DEPLOY: N
Deploy: Render auto-deploys on push to `main` (Bank Sync & Ingestion ships with the main deploy); no Apps Script change.

(Not complete in production until blocking operator actions are done AND
the deploy step is confirmed.)

FOLLOW-ON ITEMS:
- update-complete doesn't check that the link_token was issued for the same item; the token comes from the page's own sessionStorage.
- Plaid keeps a Link session for six hours, so a return later than that reads as "none" and the user presses Re-authenticate again.
- The investments-only Link has no hosted variant for a NEW link (out of scope in the plan).
- Teller re-authentication remains a re-link (out of scope).

DOCUMENTATION UPDATES NEEDED:
- None (done in this batch)
---END BROAD SCAN IMPLEMENTATION SUMMARY---
