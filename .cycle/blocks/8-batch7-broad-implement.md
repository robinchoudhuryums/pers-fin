---BROAD SCAN IMPLEMENTATION SUMMARY---
Findings implemented:
- F34 — Per-sistant search widget's Pin / Unpin did nothing (it sent the note's current state back)
- F35 — a Tax checklist reload wiped the notes typed in other rows and dropped focus
- F55 — Space / Enter in Spending by Category's month select collapsed the section
- F36 — the search widget / page could draw a stale reply; the widget showed a refused query or a network failure as "No results"
- F37 — Deleted transactions' "Show more" stayed disabled after a failed load
- F38 — a Settings switch stayed flipped after a refused save; the account-floor Save had no failure handling
- F39 — the Tax checklist's reloads weren't sequenced and its writes weren't single-flight; a double tap on Re-authenticate / Add accounts requested two Link tokens
- F40 — Per-sistant's session-expiry redirect dropped the page (no return_to)
- F56 — the Undo toast: no pause on hover / focus, its whole body dismissed it, no keyboard path to Undo
- F57 — Re-authenticate / Add accounts / Unlink had no institution in their accessible names
- F48 — the Health and Analytics heatmaps keyed today's cell a day ahead west of UTC in the evening
New capabilities (G/ST): None
Files modified:
- apps/per-sistant/pages/dashboard-script.js, apps/per-sistant/pages/search.js, apps/per-sistant/views/js.js,
  apps/per-sistant/pages/health.js, apps/per-sistant/pages/analytics.js
- teller/public/tax-page.js, teller/public/perfin-shared.js, teller/public/perfin-shared.css,
  teller/public/transactions.js, teller/views/settings.ejs, teller/views/dashboard.ejs, teller/views/accounts.ejs
- tests: new tests/broad-scan-c8-batch7.test.js (19), apps/per-sistant/tests/broad-scan-c8-batch7.test.js (12);
  updated (test doubles / source pins encoding the old behaviour) tests/roadmap-t2-2-cash-l2.test.js,
  tests/roadmap-t2-2-cash-l3.test.js, tests/scan-oct-batch16.test.js (saveToggle), tests/roadmap-t2-5-u2.test.js
  (Show more re-enabled, the delete toast's text), apps/per-sistant/tests/roadmap-t2-4-x3a.test.js (tryFetch +
  sequence), apps/per-sistant/tests/roadmap-t2-4-x3b.test.js (renderSearchResults(data, …))

CHANGES:
F34 | pages/dashboard-script.js | searchTogglePin sends { pinned: !pinned } (pinned = the button's data-pinned, the note's current state)
F36 | pages/dashboard-script.js, pages/search.js | the widget reads through tryFetch with a searchWidgetSeq checked after the reply AND after its body; a cleared box bumps it; a non-2xx shows the server's error and a network failure "Search failed — check your connection." (role="alert"), not "No results"; the /search page re-checks its sequence after json()
F40 | views/js.js | the 401 / followed-302 redirect goes to /login?return_to=<pathname + search> (encodeURIComponent, no regex — template literal); still once, never from a login page
F48 | pages/health.js, pages/analytics.js | heatmap map keys via ymdOfLocal(parseCalDate(h.day)) and grid keys via ymdOfLocal(d); Health's grid is anchored on todayLocal() (APP_TIMEZONE)
F35 | teller/public/tax-page.js | loadDocuments captures dirty notes (value !== defaultValue) and the focused control in the list before the redraw and restores them after (a vanished button hands focus to its row's notes box)
F39 | teller/public/tax-page.js, teller/views/accounts.ejs | checklist reloads carry state.docSeq; each row action (action:id), Add and Suggest run through singleFlight (one run per key, button disabled meanwhile); updatePlaidItem is a guard around openPlaidUpdate (one open at a time)
F37 | teller/views/settings.ejs | Show more's handler re-enables the button in a finally
F38 | teller/views/settings.ejs | updateSetting resolves true / false; saveToggle(box, key) puts a refused switch back (12 switches); toggleModule and the widget toggles revert too (and refuse an unreadable settings read); the floor Save is wrapped in try/catch/finally with a single-flight disabled guard
F55 | teller/views/dashboard.ejs | the collapsible heading's keydown ignores events whose target isn't the heading
F56 | teller/public/perfin-shared.js, perfin-shared.css, teller/public/transactions.js | an action toast: no body-click dismissal, a labelled "Dismiss" (×) button, the 10 s timer paused while hovered or focused (focusout within the toast ignored), action.focus moves focus to the action button; the Activity delete passes focus: true and its text names Settings → Sync Health → Deleted transactions
F57 | teller/views/accounts.ejs | aria-label "Re-authenticate <institution>", "Add accounts at <institution>", "Unlink <institution>" (escaped)

TEST RESULTS: npm test 2697/2697 (31 new); contract 270/270 (no route change); mutation 13/13 red (each fix reverted alone); Per-sistant emitted bundles (views/js.js, dashboard-script, the health / analytics / search pages' scripts) parse; Playwright not re-run (the container's Playwright build isn't installed — Batch 1 follow-on).
REGRESSION RISKS:
- updateSetting now returns a boolean; its other callers ignore the value (unchanged behaviour).
- An action toast no longer closes when its text is tapped — only Undo / Dismiss / the timer close it (intended, F56).
- A switch whose save reached the server but whose reply was lost now shows the old state until reload (the inverse of the old flipped-but-unsaved case).
- The Tax carry-over restores what was typed even after a save that normalized it (e.g. trimmed) — the input shows the typed text until the next reload.
- The Plaid update guard clears when Link opens, so a second tap after Plaid's modal closes opens it again (intended).
INVARIANTS AT RISK:
- INV-63 (Per-sistant fetch wrapper redirect) — the target is now /login?return_to=…; still once, loop-guarded, indexOf only. Doc text needs updating.
- INV-89 (Perfin writes report their outcome) — strengthened (floor Save failures, toggles).
- INV-144 (one search renderer) — unchanged; the widget still calls renderSearchResults (errors are a widget-level line).
NET SCORE: 4 production fixes (F34, F36, F40, F48) − 0 new failure modes = 4

OPERATOR ACTIONS / DEPLOY:
- None
Deploy: Platform, Shell & Auth: Render auto-deploys on push to `main`. (Web UI / Per-sistant Web UI ship with it.)

(Not complete in production until blocking operator actions are done AND the deploy step is confirmed.)

FOLLOW-ON ITEMS:
- Operator visual check V2 (the Undo toast on a phone): the toast's buttons are below the 44px touch target (.toast-action's padding, unchanged; .toast-close 32px wide).
- Per-sistant's standalone login ignores return_to (the shell's honours it).
- The Tax checklist still reloads the whole package on each write (K4 follow-on).
- Settings switches other than updateSetting's (linked tasks already revert; the watchlist reloads) were left as they were.
- The heatmap day keys assume the server returns DATE columns as UTC midnight (a server not on UTC shifts them, as before).
DOCUMENTATION UPDATES NEEDED:
- CLAUDE.md: INV-63 (return_to), the toast paragraph (Dismiss, pause, focus), the Settings / Tax page notes (switches revert, notes carried over), Known Open Issues (Batch 7 done + follow-ons), test counts 2697 / 143 (Perfin 1981, Per-sistant 716).
- apps/per-sistant/CLAUDE.md: the search widget's errors + sequence, the fetch wrapper's return_to, heatmap day keys, counts.
---END BROAD SCAN IMPLEMENTATION SUMMARY---
