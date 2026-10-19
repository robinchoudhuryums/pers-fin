---BROAD SCAN IMPLEMENTATION SUMMARY---
Findings implemented:
- F2  Public Actions logs carried financial data — workflows now print only allowlisted counts; CSV-upload workflow refuses to run while the repo is public
- F1  Pre-auth process crash — shell PIN + calendar-token compares use a SHA-256 digest compare; unhandled rejections are logged instead of killing the process
- F6  Standalone Perfin: a bare x-api-key header bypassed login when API_KEY was unset — bypass now requires API_KEY; standalone /api/login digests the password (a numeric password threw)
- F125 Per-sistant CSP allowed all of cdn.jsdelivr.net + floating mermaid@11 — Mermaid pinned to 11.4.1, CSP allows only that path
- F82 persistent_url unvalidated / redirects followed / ciphertext echoed — validated on PATCH (http(s), no credentials, ≤500), outbound fetches use redirect:"manual", PATCH response strips *_enc columns
- F11 Per-sistant CSRF accepted multipart and "…application/json…" substrings — now X-Requested-With or a content type starting with application/json
- F7  PIN-lockout alert not deduped — one alert per 6h via sentRecently('pin-lockout', 6)
New capabilities (G/ST): None
Files modified:
- .github/workflows/daily-sync.yml, weekly-reconcile.yml, job-radar.yml, knowledge-reindex.yml, csv-import.yml
- shell/index.js, shell/middleware/auth.js
- teller/server.js, teller/pages/login.js, teller/routes/settings.js, teller/routes/persistent.js
- apps/per-sistant/config.js, apps/per-sistant/middleware.js, apps/per-sistant/pages/knowledge.js
- tests/scan-oct-batch1.test.js (new), tests/scan-sept-batch9.test.js, tests/ops-and-alerts.test.js, apps/per-sistant/tests/api.test.js

CHANGES:
F2   | .github/workflows/*.yml | job-level SUMMARY_JS (prints listed numeric/boolean keys, array counts, ":str" strings) replaces every `cat /tmp/*.json`; net-worth body never printed; subscription check prints counts only (names, amounts, monthly_cost removed, monthly_cost output dropped); csv-import.yml first step fails when github.event.repository.private is false
F1   | shell/middleware/auth.js, shell/index.js | new exported safeEqual (sha256 digests + timingSafeEqual) used by handleLogin and /calendar.ics; process.on("unhandledRejection") logger (boot failures still exit via start().catch)
F6   | teller/server.js, teller/pages/login.js | requireAuth waves x-api-key through only when process.env.API_KEY is set; /api/login compares sha256(String(password)) to sha256(AUTH_SECRET)
F125 | apps/per-sistant/config.js, middleware.js, pages/knowledge.js | MERMAID_CDN_BASE = https://cdn.jsdelivr.net/npm/mermaid@11.4.1/ used for the import and as the only jsdelivr scriptSrc source
F82  | teller/routes/settings.js, teller/routes/persistent.js | normalizePersistentUrl (exported) → 400 on bad input, stored trimmed w/o trailing slash; redirect:"manual" on the 4 config.url fetches; PATCH /api/settings response drops *_enc keys
F11  | apps/per-sistant/middleware.js, apps/per-sistant/tests/api.test.js | CSRF passes only X-Requested-With or content-type startsWith application/json; test updated (multipart without the header → 403, text/plain;x=application/json → 403)
F7   | shell/middleware/auth.js, shell/index.js, tests/scan-sept-batch9.test.js | makeLockoutNotifier(getNotifications) checks sentRecently('pin-lockout', LOCKOUT_ALERT_WINDOW_HOURS=6) before sendToAll; shell wires it; source pin updated

TEST RESULTS: passed — npm test 1508/1508, 0 todo (was 1489; +19 in tests/scan-oct-batch1.test.js). Mutation check: all 6 new suites fail against the pre-fix code (the F1 request hung pre-fix — the test now has a 5s timeout so a regression fails fast). One existing source pin (ops-and-alerts "timingSafeEqual" in shell/index.js) updated to the new helper. Contract suite not re-run (no route SQL changed).
REGRESSION RISKS:
- A standalone Per-sistant whose persistent_url answers with a redirect (e.g. http→https) now gets sent:false / connected:false instead of following it — set the final URL.
- External scripts that POST multipart to Per-sistant /api/* without X-Requested-With now get 403 (no in-app code does).
- Mermaid 11.4.1's ESM chunk imports were not fetched here (CDN blocked by the sandbox proxy); if any chunk loads from outside /npm/mermaid@11.4.1/ the diagram falls back to showing its source.
- With the unhandledRejection logger, a throwing async handler now leaves that one request hanging instead of restarting the process.
- Workflow logs no longer show error text; diagnosis moves to Settings → Sync Health.
INVARIANTS AT RISK: None. INV-79 (global PIN ceiling) is strengthened (it can no longer be reset by crashing the process); INV-20 unchanged under the shell; INV-59 extended in spirit (persistent_url now 400s); INV-62 unchanged.
NET SCORE: 1 − 3 = −2 (production fixes: F2 — financial data was printed to public logs by the Oct 18–19 successful daily-sync runs. F1/F6/F125/F82/F11/F7 were real exposures with no evidence of firing. New failure modes, all Low: redirect-following removed, multipart-without-header 403, hung request instead of crash-restart.)

OPERATOR ACTIONS / DEPLOY:
- Make the GitHub repository private (Settings → General → Danger Zone → Change visibility) | BLOCKS DEPLOY: N (but F2 is not closed until done; the csv-import workflow refuses to run until then)
- Delete the existing Actions run logs of Daily Sync & Alerts, Weekly Reconcile, Job Radar Refresh and Knowledge Vault Reindex (they contain balances / net worth / subscription names) | BLOCKS DEPLOY: N
- After deploy, open Per-sistant → Knowledge and render one diagram to confirm Mermaid 11.4.1 loads under the narrowed CSP | BLOCKS DEPLOY: N
- Standalone deployments only: set persistent_url to the final https URL (redirects are no longer followed) | BLOCKS DEPLOY: N
Deploy: Platform, Shell & Auth — Render auto-deploys on push to `main` (merge the PR); alt `fly deploy`.

(Not complete in production until blocking operator actions are done AND the deploy step is confirmed.)

FOLLOW-ON ITEMS:
- Perfin's own CSP (teller/server.js:193) also allows https://cdn.jsdelivr.net and https://*.jsdelivr.net host-wide — same bypass class as F125, out of this batch's scope.
- Perfin's /api CSRF check (teller/server.js:173) still passes any x-api-key header (not a CSRF hole — a cross-site form can't set it — but inconsistent with the F6 rule).
- The compromised Teller cert and earlier logs remain in public history until the repo is private / history scrubbed (F14, Batch 3).
- Batches 2–13 of the cycle-7 plan remain (see .cycle/STATE.md).
DOCUMENTATION UPDATES NEEDED:
- CLAUDE.md Security: shell PIN / calendar-token digest compare (safeEqual) + unhandledRejection logger; standalone x-api-key bypass requires API_KEY; persistent_url validation + no redirect following + PATCH strips *_enc; PIN-lockout alert dedup (6h); workflows never print response bodies (SUMMARY_JS) and csv-import refuses while public; test counts 1508 / 68 files + scan-oct-batch1 description.
- apps/per-sistant/CLAUDE.md: CSRF bullet (multipart no longer passes without X-Requested-With; JSON must be the leading content type); Helmet CSP + Diagrams bullets (only the pinned mermaid@11.4.1 path is allowlisted, MERMAID_CDN_BASE in config.js).
---END BROAD SCAN IMPLEMENTATION SUMMARY---
