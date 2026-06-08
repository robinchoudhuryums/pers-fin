If $ARGUMENTS is empty or missing AND no TIER 2 HANDOFF BLOCK exists
earlier in this session, respond with exactly this and stop:

Usage (same session): /targeted-implement — run after /targeted-audit
Usage (new session): Paste the TIER 2 HANDOFF BLOCK first, then run

---

Read CLAUDE.md (especially Common Gotchas) before starting.

You are implementing the actions from the TIER 2 HANDOFF BLOCK above.

Rules:
- Implement ONLY the actions in the handoff block, in order
- Do not fix anything outside scope — note for follow-on
- Stop on unexpected complexity and describe before continuing
- Stop if touching DO NOT TOUCH files or out-of-scope files
- Check Common Gotchas before each action
- Before editing a module, scan for its test doubles — mocks/stubs/fixtures
  of that module, especially ones encoding the OLD behavior; update them as
  part of the action, not reactively in the test step

After all actions complete:

1. RUN TESTS — read Test Command from CLAUDE.md. If `manual`, walk
   Regression Scenarios for the touched subsystem(s) instead. Classify
   failures (this session / pre-existing / real bug). See
   `/broad-implement` Step 1 for the full branching detail.
2. REGRESSION CHECK — review each modified file for breakage risk,
   cross-reference CROSS-MODULE RISKS from handoff block
3. REFLECT — for each action: production bug? (YES/NO) New failure
   mode? (YES/NO). Tally net score.
4. INVARIANT CHECK — cross-reference against project invariant library
5. INVARIANT CANDIDATES — new rules from this session's changes
6. SUMMARY — produce TARGETED IMPLEMENTATION SUMMARY:

---TARGETED IMPLEMENTATION SUMMARY---
Scope: [subsystem]
Actions completed: [list IDs]
Actions not completed: [list with reason, or "All completed"]
Files modified: [list]

CHANGES:
[Action ID] | [File(s)] | [What changed] | [Findings addressed]

TEST RESULTS: [passed/failed]
REGRESSION RISKS: [risks or "None"]
INVARIANTS AT RISK: [any or "None"]
NET SCORE: [production fixes] − [new failure modes] = [net]
INVARIANT CANDIDATES: [new rules or "None"]

OPERATOR ACTIONS / DEPLOY:
- [human-only step outside the PR — env var, IaC, console/dashboard, one-time migration] | BLOCKS DEPLOY: Y/N
(repeat per action, or "None")
Deploy: [Deploy Command for the touched subsystem if configured, else
"N/A — no Deploy Command configured"]

(Not complete in production until blocking operator actions are done AND
the deploy step is confirmed.)

FOLLOW-ON ITEMS:
- [File: area] — [what to check and why]
(or "None")

DOCUMENTATION UPDATES NEEDED:
- [updates or "None"]
---END TARGETED IMPLEMENTATION SUMMARY---

7. CHECKPOINT (optional — only if the project uses .cycle/ state)
If a .cycle/ directory exists at the project root, create or update
.cycle/STATE.md to reflect this session: completed actions, any actions
not finished, open follow-on items, decisions made, and a "Where I left
off" line. This lets /cycle-resume continue cleanly in a fresh session
if context runs out. If .cycle/ does not exist, skip this step.

Suggest /test-sync and /sync-docs if applicable.
