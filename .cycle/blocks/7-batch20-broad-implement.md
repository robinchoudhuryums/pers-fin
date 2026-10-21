---BROAD SCAN IMPLEMENTATION SUMMARY---
Findings implemented: None (Batch 20 is expansion work — `.cycle/plan-cycle7-expansion.md`)
New capabilities (G/ST):
- G2 (remaining) — browser quality: the every-page e2e run renders SEEDED data, fails on console.error, and click-sweeps every non-destructive control on all 22 pages
- ST3 — Per-sistant client kit: one withPending(btn, key, fn, busyText) helper (guardPending + disabled + aria-busy + busy label, restored in a finally) replaces every hand-rolled pending toggle; a shrinking guard stops new ones
Files modified:
- apps/per-sistant/views/js.js (withPending; Ask popover migrated)
- apps/per-sistant/pages/emails.js, todos-script-2.js, notes.js, knowledge.js, jobs.js (pending toggles → withPending)
- data-e2e-skip markers: teller/views/settings.ejs, teller/views/accounts.ejs, apps/per-sistant/pages/{contacts,emails,health,notes,settings,todos,knowledge}.js
- e2e/seed.js (new), e2e/pages.spec.js
- tests: apps/per-sistant/tests/scan-oct-batch20.test.js (new, 7); pins updated in apps/per-sistant/tests/scan-oct-batch11.test.js (Send Now single-flight now asserted on withPending) and scan-sept-batch14.test.js (Job Radar Refresh disabled through withPending)

CHANGES:
ST3 | views/js.js | withPending(btn, key, fn, busyText): single-flight per key via guardPending; btn may be an element, a NodeList / array or null; disables, sets aria-busy and (optionally) relabels, then restores each button's OWN prior disabled state, label and aria-busy in a finally (also on a throw); returns undefined while that key runs
ST3 | pages/*.js, views/js.js | the 10 hand-rolled sites migrated: Send Now (send-now), AI Draft (ai-draft), tone buttons (adjust-tone), AI Breakdown (ai-breakdown), AI Quick Add parse (parse-todo), AI Suggest tags (suggest-tags), Knowledge reindex (reindex — loadKStatus re-disables while the background run lasts) and capture (capture), Job Radar Refresh (jobs-refresh), the Ask popover (ask). The plan's "about 27" sites were 10 (the notif-btn permanent disable isn't a pending toggle)
ST3 | tests/scan-oct-batch20.test.js | withPending run in a vm from the EMITTED bundle (busy state + restore, single-flight, restore on throw, button lists / null / an already-disabled button); a guard counting `.disabled = false` / `aria-busy` in pages/*.js + views/*.js outside withPending against an (empty) KNOWN_GAPS map that fails on growth and on a stale entry; each migrated key pinned; the emitted bundle parses
G2 | e2e/seed.js | seeds through the apps' own routes before the run (page.request with the shell cookie): housing config + generate, a manual account + manual expense, a generic CSV import (3 charges + a refund row) with a split on one charge, a rollover budget, a goal, a manual subscription, a credit score; Per-sistant notes in each privacy tier, a habit with two logs, a todo with two subtasks; one Job Radar listing inserted into the scratch DB (no route creates listings)
G2 | e2e/pages.spec.js | watch() also fails on console.error (the browser's "Failed to load resource" line is left to the response check); clickSweep presses each visible, enabled `button / [role=button|checkbox|tab] / summary` (≤80 per page) that isn't data-e2e-skip or labelled destructive (delete / remove / unlink / send / empty / sign out / log out / reset / purge / disconnect / archive / trash / revoke / cancel subscription / mark settled), dismisses dialogs, closes what it opened (Escape) and returns to the page after a navigation; a failure is labelled with the control pressed; SWEEP_KNOWN_GAPS (shrinking) starts as the existing KNOWN_GAPS; each sweep must press something
G2 | settings.ejs, accounts.ejs, per-sistant pages | data-e2e-skip on the static destructive buttons (Sign Out, Sign Out Everywhere, Reset AI context, Empty Trash, Log Out, Delete / Archive buttons) and on controls that leave the app or need a device: the three microphone buttons (no mic in a headless browser → permission refused → console.error) and Link via Teller (loads Teller's SDK from teller.io)

TEST RESULTS: passed — npm test 1832/1832 (+7, incl. the two updated pins); contract suite 152/152 (unchanged); migrations run twice cleanly; Playwright 57/57 (35 existing + 22 click sweeps, 220 controls pressed across the 22 pages). Mutation check: a hand-rolled `.disabled = false` added to a page turns the ST3 guard red. The sweep's first run failed only on the microphone buttons and Teller Connect (environment / off-app, now skipped); it found no app bug.
REGRESSION RISKS:
- The migrated buttons restore their PRIOR disabled state rather than forcing enabled (identical in practice — each was enabled when clicked); a second click while one runs is now a silent no-op for every migrated action (it already was for Send Now).
- The AI breakdown / parse / suggest-tags / draft buttons' busy labels are restored from the label read at click time, not a hard-coded string (same text today).
- The e2e run takes ~3.5 minutes longer (22 sweeps) and the sweep changes seeded state (toggles, settings) while it runs; tests that follow it on the same server see that state.
INVARIANTS AT RISK: None. INV-97 holds (no regex or backtick added to the template-literal bundle; the emitted bundle and every page script pass node --check); INV-117 holds (writes still go through writeOk / tryFetch); INV-95 extended (one more shrinking KNOWN_GAPS guard).
NET SCORE: 0 − 0 = 0 (G2 / ST3 are new capability; no production bug was found or fixed; no new failure mode in production code — the helper is behaviour-preserving.)

OPERATOR ACTIONS / DEPLOY:
- None | BLOCKS DEPLOY: N
Deploy: Platform, Shell & Auth — Render auto-deploys on push to `main` (no migration). The e2e changes run in CI's e2e job.

(Not complete in production until blocking operator actions are done AND the deploy step is confirmed.)

FOLLOW-ON ITEMS:
- The sweep counts controls once, on page load: controls inside a dialog a click opens, and rows rendered only after a click, are not swept. The Activity page is the clearest case: its rows (with their Edit / Split buttons) appear only after Search, so its sweep pressed 3 controls.
- Seeding happens in pages.spec.js's beforeAll, not in e2e/boot-server.js as the plan said: Playwright's webServer readiness URL (/health) answers before a seed in boot-server could finish, so the tests could race it.
- The microphone buttons log console.error on a refused permission (a user who blocks the mic sees nothing — no toast); Teller Connect has no in-page error when its SDK fails to load beyond the console line.
- Writes with no pending guard at all (most Save buttons) are not covered by withPending; only toggles that existed were migrated.
DOCUMENTATION UPDATES NEEDED:
- CLAUDE.md: the e2e description (seeded data, console errors, click sweep, data-e2e-skip, SWEEP_KNOWN_GAPS, 57 tests), Known Open Issues (Batch 20 done — cycle 7's planned work complete; Batch 20 follow-ons), counts (1832 tests / 89 files / Per-sistant 534), INV for withPending + data-e2e-skip conventions.
- apps/per-sistant/CLAUDE.md: withPending in the client kit (CSRF/fetch-wrapper paragraph), test count 534, the new test file.
- README: counts.
---END BROAD SCAN IMPLEMENTATION SUMMARY---
