If $ARGUMENTS is empty or missing, respond with exactly this and stop:

Usage: /broad-implement <finding IDs or description of fixes to implement>
Example: /broad-implement F03, F07, F12

Paste or reference the findings from a prior /broad-scan session.

---

You are implementing specific findings from a broad scan audit.

Scope: $ARGUMENTS

Read CLAUDE.md before starting.

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

After all fixes are complete, do the following in order:

1. RUN TESTS
Run the test suite (use the test command from CLAUDE.md's Cycle Workflow
Config, or `npm test` if not specified). Note the result. If tests fail, classify:
- Caused by this session's changes (fix now)
- Pre-existing (note but don't fix)
- Real production bug exposed by correct test (flag as follow-on, don't fix here)

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

4. SUMMARY
Produce a BROAD SCAN IMPLEMENTATION SUMMARY:

---BROAD SCAN IMPLEMENTATION SUMMARY---
Findings implemented: [list finding IDs and one-line descriptions]
Files modified: [list all files touched]

CHANGES:
[Finding ID] | [File(s)] | [What changed]

TEST RESULTS: [passed/failed — details if failed]
REGRESSION RISKS: [any risks identified, or "None"]
NET SCORE: [production fixes] − [new failure modes] = [net]

FOLLOW-ON ITEMS:
- [anything noticed but not fixed, out of scope]
(or "None")

DOCUMENTATION UPDATES NEEDED:
- [any CLAUDE.md, README, or inline doc changes needed]
(or "None")
---END BROAD SCAN IMPLEMENTATION SUMMARY---

After the summary, suggest running /test-sync if any test failures remain,
and /sync-docs if any documentation updates are needed.
