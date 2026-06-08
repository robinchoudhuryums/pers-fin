If $ARGUMENTS is empty or missing, respond with exactly this and stop:

Usage: /broad-implement <finding IDs or description of fixes to implement>
Example: /broad-implement F03, F07, F12

Paste or reference the findings from a prior /broad-scan session.

---

You are implementing specific findings from a broad scan audit.

Scope: $ARGUMENTS

Read CLAUDE.md (especially Common Gotchas) before starting.

Rules:
- Implement ONLY the findings specified above — nothing else
- Do not fix, refactor, or improve anything outside this scope even if
  you notice other issues — note them at the end
- If a fix is more complex than expected, stop and describe what you
  found before continuing
- If a fix requires touching files that seem unrelated to the finding,
  explain why before proceeding
- After each fix, briefly note: what changed, files touched, anything
  unexpected
- Check Common Gotchas before each fix to avoid re-introducing known issues
- Before editing a module, scan for its test doubles — mocks/stubs/fixtures
  of that module, especially ones encoding the OLD behavior; update them as
  part of the fix, not reactively in RUN TESTS

After all fixes are complete, do the following in order:

1. RUN TESTS
Read the Test Command from CLAUDE.md's Cycle Workflow Config.

  - If Test Command is `manual`: skip programmatic test execution.
    Walk every Regression Scenario whose Subsystem overlaps a file
    you modified. Record per-scenario outcome (PASS / FAIL /
    NOT APPLICABLE — with reason for NOT APPLICABLE). A FAIL is
    classified the same as a test failure below.

  - Otherwise: run the test suite (use the Test Command, or
    `npm test` if not specified). If Regression Scenarios is also
    configured, walk them after tests pass.

Note the result. If tests fail (or any scenario FAILs), classify:
- Caused by this session's changes (fix now)
- Pre-existing (note but don't fix)
- Real production bug exposed by correct test/scenario (flag as
  follow-on, don't fix here)

2. REGRESSION CHECK
For each file you modified:
- Could this change break any caller or consumer of this function/export?
- Did you change any interface, return type, or default value that other
  modules depend on?
- Is there any scenario where the old behavior was actually correct and
  you've made it worse?

3. REFLECT
For each fix completed:
a) Would this bug have actually fired in production this month? YES/NO
b) Did this fix introduce a new failure mode, documented or not? YES/NO
Tally: [production fixes] − [new failure modes] = [net score]

4. INVARIANT CHECK
Check whether any changes could have violated invariants from the project's
invariant library (listed in CLAUDE.md Common Gotchas). Flag any at risk.

5. SUMMARY
Produce a BROAD SCAN IMPLEMENTATION SUMMARY:

---BROAD SCAN IMPLEMENTATION SUMMARY---
Findings implemented: [list finding IDs and one-line descriptions]
Files modified: [list all files touched]

CHANGES:
[Finding ID] | [File(s)] | [What changed]

TEST RESULTS: [passed/failed — details if failed]
REGRESSION RISKS: [any risks identified, or "None"]
INVARIANTS AT RISK: [any invariants potentially affected, or "None"]
NET SCORE: [production fixes] − [new failure modes] = [net]

OPERATOR ACTIONS / DEPLOY:
- [human-only step outside the PR — env var, IaC, console/dashboard, one-time migration] | BLOCKS DEPLOY: Y/N
(repeat per action, or "None")
Deploy: [if a Deploy Command is configured in CLAUDE.md for any modified
subsystem, the command(s) to run, one line per subsystem; else
"N/A — no Deploy Command configured"]

(Not complete in production until blocking operator actions are done AND
the deploy step is confirmed.)

FOLLOW-ON ITEMS:
- [anything noticed but not fixed, out of scope]
(or "None")

DOCUMENTATION UPDATES NEEDED:
- [any CLAUDE.md, README, or inline doc changes needed]
(or "None")
---END BROAD SCAN IMPLEMENTATION SUMMARY---

6. CHECKPOINT (optional — only if the project uses .cycle/ state)
If a .cycle/ directory exists at the project root, create or update
.cycle/STATE.md to reflect this session: completed findings, any
selected findings not finished, open follow-on items, decisions made,
and a "Where I left off" line. This lets /cycle-resume continue cleanly
in a fresh session if context runs out. If .cycle/ does not exist, skip
this step — the summary block above is the record, as usual.

After the summary, suggest running /test-sync if any test failures remain,
and /sync-docs if any documentation updates are needed.
