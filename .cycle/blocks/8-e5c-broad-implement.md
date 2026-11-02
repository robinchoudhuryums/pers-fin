---BROAD SCAN IMPLEMENTATION SUMMARY---
Findings implemented: none (an expansion batch; the new tests exposed no production bug).
New capabilities (G/ST): ST4 part 3 (cycle-8 E5c — E5 complete) — four Per-sistant behaviour tests in e2e/behaviour.spec.js (actions 14–16 of .cycle/plan-e5-behaviour-tests.md; 16 split in two): 14 pin a note, 15 complete a todo and a subtask, 16 log today's habit, 17 save a Job Radar listing.
Files modified: e2e/behaviour.spec.js

CHANGES:
E5c (14) | e2e/behaviour.spec.js | Notes: a note "E5 Note <tag>" made through POST /api/notes; opened from its card, "Pin to top" ticked and saved → the card says Pinned and is FIRST in the grid · GET /api/notes pinned true · both after a reload; unpinned through the dialog (badge gone, API false); deleted and removed from the trash in a finally
E5c (15) | e2e/behaviour.spec.js | To-Dos: a todo "E5 Task <tag>" with one subtask made through the API; the subtask check → aria-checked true, "1/1 subtasks", 100% · subtasks API completed; the task check → it leaves Pending, the undo toast says "Task completed" · completed true; Undo → back, completed false; completed again → after a reload not in Pending, under Completed with both checks ticked; put back on the page (reopened from Completed, the subtask unticked under Pending, both API-confirmed); deleted and removed from the trash in a finally
E5c (16) | e2e/behaviour.spec.js | Health: a daily habit "E5 Stretch <tag>" with yesterday logged (a 1-day streak); "Mark done" → the row's "✓ Done", streak badge 2, today's week-grid cell data-value 1 · GET /api/habits done_today true, current_streak 2 · after a reload; "Done" pressed again → "Mark done", streak 1, the cell cleared, API false / 1; the habit DELETEd from the database in a finally (the API only archives, and the click sweep presses Restore on archived habits)
E5c (17) | e2e/behaviour.spec.js | Job Radar: a listing "E5 Role <tag>" inserted (fit 88, trust 85, real — listings come only from the boards, like seed.js's); "Save" on its Top matches card → the "saved" badge and Unsave · /api/jobs/list?status=saved holds it · after a reload, and listed under Saved; Unsave from the Saved view → gone from it, status new, Save back on the radar card; the listing deleted and its source's trust_weight (Save nudges it +1) put back in a finally
E5c harness | e2e/behaviour.spec.js | perfinDb generalised to inDb(name, fn) with perfinDb / persistentDb; idOf for the routes' { id } / { todo } / { habit } shapes

TEST RESULTS: npm test 3122/3124 — the pre-existing date-dependent tests/cycle8-e1a.test.js failure (it fails on 2026-11-02 too, not only near a 31-day month's end), and tests/roadmap-t3-3-k2.test.js failed as a FILE with node:test's IPC error "Unable to deserialize cloned data" (the runner flake already listed for roadmap-t2-4-x2a; the file passes 24/24 alone; this batch changed no unit-tested code). Full e2e 91/91 (87 + 4 new); behaviour.spec.js 17/17 twice against one long-lived server (the rerun case). Contract suite not run (no server code changed). Mutation checks: notes PATCH ignoring `pinned` → test 14 red; the subtask PATCH ignoring `completed` → test 15 red; the job status PATCH writing nothing → test 17 red; each file restored.
REGRESSION RISKS: None in production code (test-only change). The habit and job tests write to Per-sistant's database directly (a listing insert; deletes of their own habit and listing; the source's trust_weight restored to the value read before) — scoped to their own rows by id.
INVARIANTS AT RISK: INV-130 — its "direct inserts" list grows: the behaviour file now also inserts its own Job Radar listing (the same kind seed.js inserts) and deletes its own habit and listing directly; documented here and to be reflected in INV-130's text by /sync-docs. No production invariant touched.
NET SCORE: 0 − 0 = 0 (four new tests; no production fix; no new failure mode)

OPERATOR ACTIONS / DEPLOY:
- None
Deploy: N/A — test-only change (no deployed subsystem modified).

(Not complete in production until blocking operator actions are done AND
the deploy step is confirmed.)

FOLLOW-ON ITEMS:
- tests/cycle8-e1a.test.js "auto: the subscription and the plain transfer are billed…" also fails on 2026-11-02 — its date dependence is wider than "near the end of a 31-day month" (CLAUDE.md's description); worth a /test-sync look.
- The node:test IPC deserialisation flake hit tests/roadmap-t3-3-k2.test.js this run (previously seen on roadmap-t2-4-x2a) — a file-level failure that passes alone.
- Job Radar's Save nudges the source's trust_weight (+1) and Unsave doesn't take it back (applyFeedbackToSource counts only saved / applied) — a save immediately undone still leaves the nudge in production; the test restores it itself.
- Habits have no hard-delete route (DELETE archives); a habit made by mistake stays in the Archived list — the test removes its own directly.
- The E5a / E5b follow-ons stand (the Review count label, the calendar's DATE prefix match, rows accumulating on a long-lived server — the E5b/E5c tests remove their own rows — the bell test's possible flake, a ~4.5-minute local run).

DOCUMENTATION UPDATES NEEDED:
- CLAUDE.md: the ci.yml e2e bullet (91 tests; behaviour.spec.js also covers the Per-sistant actions — pin a note, complete a todo + subtask, log a habit, save a job; its own Job Radar listing inserted and its habit / listing removed directly); Current Status e2e count (87 → 91); INV-130's direct-insert text; the E5 Known Open Issues entry (E5 done, E5c follow-ons, the wider e1a date failure and the k2 IPC flake); the E1 entry's "E5 in progress".
- apps/per-sistant/CLAUDE.md: none needed (no Per-sistant code changed).
- README: the e2e sentence (the Per-sistant actions).
---END BROAD SCAN IMPLEMENTATION SUMMARY---
