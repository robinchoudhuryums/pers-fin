Read CLAUDE.md before starting.

[PASTE THE IMPLEMENTATION SUMMARY from the cycle, if available]

Post-implementation test quality assessment AND failure resolution. Lead
with coverage/quality, not just fixing reds.

Step 1 — Run tests (Test Command from CLAUDE.md; if `manual`, walk the
Regression Scenarios) and classify each failure:
- A: outdated assertion (fix)
- B: test redefines a production value locally (rewrite to import it)
- C: pre-existing failure (fix if in scope)
- D: real production bug caught by a correct test (flag only, defer)
- E: infrastructure issue (fix)

Step 2 — Fix A, B, C, E in priority order. Do NOT "fix" a D by weakening
the test.

Step 3 — Coverage gap analysis (runs even if all tests pass): for every
change in the implementation summary, does a test exist that would FAIL
if the change regressed? For each gap, describe what's untested, classify
simple (<30 min) or complex, implement the simple ones now. Report the
Category D ratio (fixes with no regression test / total fixes). Where an
invariant defines a Verify test, confirm it exists and runs.

Step 4 — Test quality: flag tests that pass both before and after a fix
(no regression value), tests asserting on mock/stub behavior rather than
production behavior, and assertions so broad they'd pass regardless of
the code under test. Mark each salvageable (tighten) or rewrite.

Step 5 — CI config check (typecheck, lint, build wired and green).

Report: fixes made, remaining failures by category, coverage gaps and the
Category D ratio, and quality issues found.
