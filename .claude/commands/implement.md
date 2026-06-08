If $ARGUMENTS is empty AND no IMPLEMENTATION HANDOFF BLOCK exists earlier
in this session, respond with exactly this and stop:

Usage (same session): /implement — run after /plan
Usage (new session): paste the IMPLEMENTATION HANDOFF BLOCK first, then run

---

Read CLAUDE.md (especially Common Gotchas) before starting.

[PASTE SYSTEMS MAP SUMMARY HERE]
[PASTE IMPLEMENTATION HANDOFF BLOCK HERE IF FRESH SESSION]

Before starting: for every action listed as High/Very High risk, run the
Pre-Implementation Dependency Check (identify every out-of-scope file
that imports/calls the changed functions/exports; describe what would
break) and confirm understanding before implementing those actions.
Low-risk actions may proceed. Also confirm the path your change affects is
the one that runs in production — not just an in-memory / fallback / mock
path; where a real (e.g. DB-backed) path exists alongside a fallback,
implement and test BOTH.

Rules:
- Implement ONLY the actions in the handoff block, in order
- Do not fix anything outside scope — note it for follow-on
- Stop on unexpected complexity and describe before continuing
- Stop if an action requires touching out-of-scope files
- Check Common Gotchas before each action
- Before editing a module, scan for its test doubles — mocks/stubs/fixtures
  of that module, especially ones encoding the OLD behavior (a factory mock
  that throws on a newly-added export, a non-date-scoped mock, a fixture
  asserting the prior output). Update them as part of the change, not
  reactively in RUN TESTS.
- After each action, note: what changed, files touched, anything unexpected

After all actions complete, in order:

1. RUN TESTS — read Test Command from CLAUDE.md. If `manual`, walk the
   Regression Scenarios for the touched subsystem(s) instead (PASS / FAIL
   / NOT APPLICABLE; a FAIL = a test failure). Otherwise run the suite,
   then walk any configured scenarios. Classify failures: this session /
   pre-existing / real bug exposed by a correct test.
2. Produce an IMPLEMENTATION SUMMARY BLOCK:

---IMPLEMENTATION SUMMARY BLOCK---
Session scope: [subsystem group]
Actions completed: [IDs]
Actions not completed (if any): [list with reason]

CHANGES MADE:
[Action ID] | [File(s)] | [What changed]

TEST RESULTS: [passed/failed — details, or scenario outcomes if manual]

UNEXPECTED FINDINGS DURING IMPLEMENTATION:
- [discovered while implementing, not in the audit] (or "None")

OPERATOR ACTIONS / DEPLOY:
- [human-only step outside the PR — env var, IaC, console/dashboard, one-time migration] | BLOCKS DEPLOY: Y/N
(or "None")
Deploy: [Deploy Command for any touched subsystem if configured, else "N/A — no Deploy Command configured"]
(Not complete in production until blocking operator actions are done AND the deploy step is confirmed.)

FOLLOW-ON ITEMS:
- [out-of-scope items to add to the backlog] (or "None")

DOCUMENTATION UPDATES NEEDED:
- [CLAUDE.md / README / inline] (or "None")
---END IMPLEMENTATION SUMMARY BLOCK---

3. CHECKPOINT (optional — only if .cycle/ exists): create/update
   .cycle/STATE.md (completed/pending actions, follow-ons, decisions,
   "Where I left off") so /cycle-resume can continue. Skip if no .cycle/.

Suggest /regression, /reflect, /test-sync, /sync-docs as applicable.
