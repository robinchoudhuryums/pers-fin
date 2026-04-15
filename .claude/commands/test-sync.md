Post-implementation test quality assessment and failure resolution. Leads with coverage and quality analysis, not just failure fixing.

Step 1: RUN TESTS AND CLASSIFY FAILURES

Run the test suite. For each failure, classify into one of 5 categories:

Category A: Outdated assertions — test expectations that no longer match the (correct) new behavior. Fix by updating the assertion.
Category B: Tests with local redefinitions — tests that redefine constants, configs, or values that should be imported from production code. Rewrite to import production values.
Category C: Pre-existing failures — tests that were already failing before this cycle's changes. Fix if scoped to current work, otherwise note.
Category D: Real production bugs caught by correct tests — the test is right, the code is wrong. Flag as follow-on item, do NOT fix here.
Category E: Infrastructure issues — test runner config, missing fixtures, environment problems. Fix.

Step 2: FIX CATEGORIES A, B, C, E in priority order. Category D items are flagged but not fixed (they need their own audit cycle).

Step 3: COVERAGE GAP ANALYSIS (primary value — runs even if all tests pass)

For every change in the most recent implementation summary:

Does a test exist that would fail if the change regressed?
If not, that's a coverage gap.
For each gap:

Describe what's untested
Classify as simple (<30 min to write) or complex (>30 min)
Implement simple ones immediately
Category D ratio: what percentage of fixes have no regression test?

Step 4: TEST QUALITY CHECK

Flag tests that:

Pass both before and after a fix — they don't guard against regression
Assert on mock/stub behavior rather than production behavior
Have assertions so broad they'd pass regardless of the code under test
For each quality issue:

Is the test salvageable (tighten assertion) or should it be rewritten?
If salvageable, fix it now

Step 5: CI CONFIGURATION CHECK

Verify:

TypeScript type-check passes (tsc --noEmit)
Linter passes with no errors
Build succeeds
Coverage thresholds are still met

Report:

Tests fixed: [count by category]
Coverage gaps found: [count] — filled: [count] — remaining: [count]
Quality issues found: [count] — fixed: [count]
CI status: [all passing / issues found]
