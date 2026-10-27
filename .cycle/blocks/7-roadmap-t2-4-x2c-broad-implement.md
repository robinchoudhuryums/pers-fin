---BROAD SCAN IMPLEMENTATION SUMMARY---
Findings implemented: None (roadmap item)
New capabilities (G/ST): Roadmap T2.4 X2c — Perfin Settings → Per-sistant Tasks (switch, a box per source with manual bills marked off by default, bill lead days, the last-run line from linked_tasks_state with any source error, Run now; standalone a note instead of the controls) + POST /api/linked-tasks/run + the X2 docs
Files modified: teller/routes/settings.js, teller/services/linked-tasks.js, teller/views/settings.ejs, tests/roadmap-t2-4-x2c.test.js (new), tests/contract/linked-tasks-crossapp.contract.test.js, CLAUDE.md, README.md, apps/per-sistant/CLAUDE.md

CHANGES:
X2c | teller/routes/settings.js | POST /api/linked-tasks/run: 501 standalone (no Per-sistant pool), 409 while a run is going (no second run started), the off-for-today memo cleared then 400 while the switch is off, else { status, at, desired, created, updated, closed, reopened, skipped, errors } (no internal fields); a thrown run a fixed 500. Hands over the app's persistentPool.
X2c | teller/services/linked-tasks.js | isRunning() export (backs the 409).
X2c | teller/views/settings.ejs | "Per-sistant Tasks" section under Notifications & Automation: labelled switch, four labelled source checkboxes (manual bills "off by default: autopaid bills nobody marks paid stay open"), lead days (0-14, refused locally otherwise), "Last run …: N outstanding, N closed." plus named source errors, Run now (not data-e2e-skip — swept). Every save goes through writeOk; a refused toggle puts its box back. Standalone: note shown, controls hidden. renderLinkedTasks(s) from loadSettings.
X2c | tests | 13 unit tests (route gating / 409 / 400 + memo / shape / 500 / pool / isRunning; vm: last-run line, standalone, embedded render, each PATCH, refusal + revert, lead validation, Run now ok + 409, markup labels + wiring); 1 contract case (Run now 400 while off, then the record — desired equal to Perfin's computation — stored).
X2c | docs | CLAUDE.md Features (Per-sistant tasks), settings.js route list, linked-tasks.js isRunning, Commands (POST /api/linked-tasks/run), Database note, Scheduled Tasks (Run now), counts, test descriptions, Known Open Issues (X2c + follow-ons); README section + counts; Per-sistant CLAUDE.md pointer to the Perfin Settings section.

TEST RESULTS: npm test 2213/2213 (13 new); contract 227/227 (1 new); Playwright 58/58 (Perfin Settings page + click sweep incl. Run now); 16 mutations all red. No schema change — migration test not needed.
REGRESSION RISKS: The run route's 409 relies on isRunning(); a manual press while the hourly run is going is refused rather than joined (by design — press again). "Outstanding" counts what Perfin has due, including a task completed by hand in Per-sistant (the line's wording says so, not "open").
INVARIANTS AT RISK: None — INV-59 (bounded settings, the PATCH unchanged), INV-89 (writeOk on every new write), INV-90/IF-3 (every new control labelled), INV-25 (the wired pool, never a self-fetch), INV-106 (no bare catch), INV-103 n/a.
NET SCORE: 0 production fixes − 0 new failure modes = 0 (new capability)

OPERATOR ACTIONS / DEPLOY:
- None (opt-in: switch on Settings → Per-sistant Tasks under the unified shell) | BLOCKS DEPLOY: N
Deploy: Platform, Shell & Auth: Render auto-deploys on push to `main`.

FOLLOW-ON ITEMS:
- The last-run line's "outstanding" includes a task completed by hand (it is what Perfin has due, not what is open in Per-sistant).
- The section doesn't list the tasks themselves (they live in Per-sistant's To-Dos).
- Run now during a running hourly run gets a 409 instead of joining it.

DOCUMENTATION UPDATES NEEDED:
- None (folded into this batch)
---END BROAD SCAN IMPLEMENTATION SUMMARY---
