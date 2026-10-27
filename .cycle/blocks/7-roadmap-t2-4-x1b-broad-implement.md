---BROAD SCAN IMPLEMENTATION SUMMARY---
Findings implemented: None (roadmap work, not scan findings)
New capabilities (G/ST): Roadmap T2.4 X1b — linked tasks: your edits win per field (source_snapshot refresh) and the "Perfin" chip on the To-Dos list, the dashboard task lists and the edit modal; a linked task in the e2e seed. Nothing calls the sync yet (Perfin wires it in X2).
Files modified:
  apps/per-sistant/services/linked-tasks.js (snapshot refresh, `updated`), apps/per-sistant/views/js.js (linkedTaskChip),
  apps/per-sistant/views.js (window.LINKED_APP_BASES in pageHead), apps/per-sistant/views/css-components.js (.linked-chip / .linked-note),
  apps/per-sistant/pages/todos-script-1.js (chip in the list row, showLinkedNote in the edit modal), apps/per-sistant/pages/todos.js (#f-linked),
  apps/per-sistant/pages/dashboard-script.js (chip on both task lists), apps/per-sistant/db/030_linked_tasks.sql (comment only: source_url is a path inside the source app),
  apps/per-sistant/tests/_linked-tasks-fake.js (new — the fake pool moved out of the X1a test and taught the refresh statement),
  apps/per-sistant/tests/roadmap-t2-4-x1a.test.js (fake moved; `updated` in the expected results; app-relative urls),
  apps/per-sistant/tests/roadmap-t2-4-x1b.test.js (new), tests/contract/linked-tasks.contract.test.js (X1b case, `updated`, app-relative urls),
  e2e/seed.js (one linked task), e2e/pages.spec.js (the chip on the To-Dos page and in the edit modal),
  CLAUDE.md, apps/per-sistant/CLAUDE.md, README.md, .cycle/plan-t2-4-crossapp-automation.md, .cycle/STATE.md

CHANGES:
T2.4-X1b | apps/per-sistant/services/linked-tasks.js | syncLinkedTasks → { created, updated, closed, reopened, skipped }: after the reopen, ONE batched UPDATE … FROM jsonb_to_recordset refreshes each open, attached, untrashed task's title / description / due_date / priority only where the current value still equals source_snapshot (a field you edited keeps your value; the rest follow), moves the snapshot to the new desired values and source_url to the source's; a task whose snapshot and url already match isn't written, so a re-run reports updated 0
T2.4-X1b | apps/per-sistant/views/js.js + views.js + views/css-components.js | linkedTaskChip(t) in the shared client bundle: '' for an ordinary task; otherwise an <a class="linked-chip"> to window.LINKED_APP_BASES[source_app] + source_url with an escaped aria-label "Open in Perfin: <title>" — only when the url is a path inside the app (starts "/", not "//", no backslash) and the base is root-relative or http(s) (an http(s) base, i.e. a standalone PERFIN_URL, opens in a new tab with rel=noopener, its trailing slash trimmed); anything else is a plain <span> label. No regex with a backslash (INV-97 — the backslash test uses String.fromCharCode(92)). pageHead writes window.LINKED_APP_BASES = {"perfin": "/perfin" under the shell, PERFIN_URL or "" standalone} into the existing BASE_PATH script ('<' escaped)
T2.4-X1b | apps/per-sistant/pages/todos-script-1.js + todos.js + dashboard-script.js | the chip leads the meta line of a To-Dos row, a dashboard task card and an Upcoming row; the edit modal shows #f-linked ("Kept in step with Perfin. Your edits stay; completing it here does not change Perfin.") for a linked task and hides it for a new / ordinary one
T2.4-X1b | (decision) | source_url is a path INSIDE the source app ('/housing'), joined with that app's mount by the chip — so the same row works under the shell (/perfin/housing) and standalone (PERFIN_URL/housing). The X1a tests used '/perfin/…' urls and were aligned
T2.4-X1b | e2e/seed.js + e2e/pages.spec.js | the seed inserts one linked task directly (no route creates one, like the Job Radar listing); a new browser test finds its chip on the To-Dos page (href /perfin/housing, aria-label), opens the edit modal and sees the note + chip, closes it and follows the chip to the Rent page — no page or console error

TEST RESULTS: passed — npm test 2171/2171 (Perfin 1537 + Per-sistant 634; 8 new); contract suite 217/217 (1 new X1b case: a title edited through PATCH kept across two syncs while the due date, priority and url follow, nothing written on a no-op run, a hand-reopened task not refreshed); migration test not needed (db/030 changed only in a comment); Playwright 58/58 (1 new; the To-Dos and dashboard pages still load and click-sweep clean with the seeded linked task). Mutation checks, each turning a test red: the title always overwritten, the due date never refreshed, a write on an unchanged task, the refresh reaching a detached task (first survived — added the hand-reopened case), no refresh call, the chip accepting a // url, a backslash url, an unescaped href (first survived — added a url with " & < >), no trailing-slash trim, no new tab for an external base, the new-task modal keeping the note. One equivalent mutant left: dropping the hasOwnProperty guard on LINKED_APP_BASES (no Object.prototype property is a string, so the chip falls back to text either way).
REGRESSION RISKS:
  - The edit modal and the To-Dos / dashboard rows call linkedTaskChip, defined in the shared bundle every page loads; an ordinary task renders exactly as before (the helper returns '').
  - pageHead's BASE_PATH script now also sets window.LINKED_APP_BASES — still one nonced script (the pageHead nonce count pin holds).
  - A sync now writes an open linked task's fields when the source changes; a field you edited is left alone.
INVARIANTS AT RISK: None — INV-97 (no single-escaped regex in client template literals) holds (the new client code's only regex, /^https?:/i, has no backslash); INV-117 (writes report outcome) — no new write; INV-129 (withPending) — no new pending control; INV-130 (seeded e2e, no console errors) holds with the new seed row; INV-119 unchanged (a refresh is not a create / complete, so no announce).
NET SCORE: 0 production fixes − 0 new failure modes = 0 (one new capability, not yet wired)

OPERATOR ACTIONS / DEPLOY:
- None | BLOCKS DEPLOY: N
Deploy: Platform, Shell & Auth: Render auto-deploys on push to `main` (after the PR merges).

(Not complete in production until blocking operator actions are done AND
the deploy step is confirmed.)

FOLLOW-ON ITEMS:
- The Today page and the weekly review don't show the chip (the plan named the To-Dos list, dashboard cards and edit modal).
- A standalone Per-sistant shows the chip as plain text unless PERFIN_URL is an http(s) URL.
- Per-sistant's dashboard rent link still reads window.PERFIN_URL, which nothing sets (seams audit #3 C3) — LINKED_APP_BASES.perfin now carries the right base and could replace it.

DOCUMENTATION UPDATES NEEDED:
- None (folded into this batch)
---END BROAD SCAN IMPLEMENTATION SUMMARY---
