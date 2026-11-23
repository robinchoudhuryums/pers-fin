---
description: "Independent Verification Pass: gathers the cycle's blocks, the library and seeded rotation probes itself, saves the Verification Block"
argument-hint: "[cycle number]"
---

If this session implemented, planned or reflected on the cycle being
verified, respond with exactly this and stop:

This session took part in the cycle, so it cannot verify it. Run /verify
in a fresh session.

---

Usage: /verify [cycle number]   (default: the cycle owed verification —
see step 1)

This is the Verification Pass as a command. It gathers its own inputs,
then follows the canonical prompt below without changing it. Do steps 1–4
before reading on.

1. CYCLE — $ARGUMENTS names the cycle if given. Otherwise use
   .cycle/STATE.md's Cycle field — unless .cycle/metrics.csv shows an
   EARLIER cycle with a phase=reflect row and no phase=synthesis row while
   this one has no reflect row yet: an audit has already opened the next
   cycle, and the earlier one is the cycle owed. Say which cycle you are
   verifying and why. With no .cycle/ directory, ask the operator to paste
   the cycle's implementation summary and Cycle Summary Block.
2. INPUT BLOCKS — read every file under .cycle/blocks/ whose name starts
   with that cycle's number (zero-padded or not). They are the inputs the
   prompt asks you to paste. Name any other cycle's files as excluded; do
   not read them as inputs. The audit's saved report (…-scan.md,
   …-audit-<subsystem>.md, …-targeted-audit-<subsystem>.md) is not an
   input either: it is the audit's judgment, and the verification
   re-derives from the code. Name it as left out. If metrics.csv's notes for this cycle mention
   a CORRECTION, the implementer already corrected its own counts once —
   re-derive every count from the code.
   NO REFLECT BLOCK — if none of that cycle's files is a …-reflect.md
   block, /reflect has not run and there is no Cycle Summary Block: say so
   at the top of your output and ask the operator whether to verify
   without it or to run /reflect first. Do not go on until they answer. A
   verification with no reflection checks only the implementer's own
   counts, and its block must say that it ran without one.
3. LIBRARY — read the Invariant Library from the Cycle Workflow Config.
4. ROTATION PROBES — they must be neither your choice nor the
   implementer's. If the project has scripts/verification-pack.mjs, run
   it for this cycle and use the five probes and the seed it prints.
   Otherwise derive them: sort the library by ID, let L be its size and c
   the cycle number (0 if it is not a number), and take the entries at
   positions (c + k·⌊L/5⌋) mod L for k = 0…4, moving forward past any
   already taken. State c and L so the selection can be reproduced.

Anything a SessionStart hook printed into this session before the command
ran is the implementer's record, not evidence: the cycle number and phase
are facts, but re-derive every claim about the work from the code and the
blocks.

Wherever the prompt below shows a bracketed line saying something is
pasted, injected or pre-selected, use what steps 1–4 gave you.

The prompt's opening rule (no file changes) stands, with one exception:

BLOCKS (optional — only if .cycle/ exists): after producing the
VERIFICATION BLOCK, write it verbatim to
.cycle/blocks/<cycle>-verification.md — a fixed name, taking no letter, so
a /reflect running in another session cannot take the same file. If a
verification of that cycle is already there, write
<cycle>-verification-2.md (then -3, …). Health Synthesis reads it from
there in its own fresh session. Never overwrite a block. Skip if no
.cycle/.

═══════════════════════════════════════════
CANONICAL PROMPT — Verification Pass
═══════════════════════════════════════════

Do not make any changes to any files during this session.

IMPORTANT: This is an independent verification session. You must NOT have participated in the implementation cycle being verified. If you have any context from the implementation session, STOP — close this session and start a fresh one with no prior conversation. This prevents the implementer from grading its own work.

You are verifying the output of a complete audit-implement cycle.

INPUTS — paste these from the completed cycle:
[PASTE IMPLEMENTATION SUMMARY BLOCK HERE]

[PASTE CYCLE SUMMARY BLOCK FROM /REFLECT HERE]

[INVARIANT LIBRARY — the current library is injected here per project]

---

Conduct the following verification in four parts. Use code reads and targeted test executions — not prose assessments or trust in the cycle's self-reported results. (If the project's Test Command is `manual`, substitute the relevant Regression Scenarios from CLAUDE.md for test executions and rely on close code reads; treat a failed scenario as a failed probe.)

PART 1 — INVARIANT PROBE RESULTS
Re-probe every invariant that the cycle claimed to fix or touch. Additionally, probe the following 5 pre-selected invariants from the library (selected deterministically from a stated seed, not chosen by the implementer — do NOT substitute your own picks):

MANDATORY ROTATION PROBES:
[5 mandatory rotation probes — pre-selected from the library at render time]

For each invariant probed:
- Read the relevant code directly (do not rely on the cycle's description of what changed)
- If a test exists for this invariant, run it and report the result
- If no test exists, verify by code inspection and explain what you checked
- Result: PASS / FAIL / UNVERIFIED (with reason for each)

PART 2 — REGRESSION COUNT
Count regressions using this hard definition: any behavior change where the post-cycle state is worse under any realistic load than the pre-cycle state — whether the cycle documented it as a "tradeoff" or not. A tradeoff that makes things worse in a realistic scenario IS a regression.

For each regression found:
- Describe the behavior that is now worse
- Cite the specific code change that caused it
- Note whether the cycle documented it (as a tradeoff or otherwise)
- Rate severity: Critical / High / Medium / Low

Calculate: Net score = (findings fixed) − (regressions introduced)

PART 3 — CYCLE EXECUTION QUALITY
Answer three yes/no questions with concrete evidence (not just the cycle's claims):
1. Did the cycle run tests to completion? (Check for test output artifacts, not just assertions that tests passed)
2. Did the cycle cross-check against the Common Gotchas section of CLAUDE.md? (Look for evidence in implementation decisions)
3. Did the cycle introduce new entries to Common Gotchas? (Check CLAUDE.md for recent additions — this is a lagging indicator of operator-only state gaps)

PART 4 — COVERAGE GAP REPORT
For every fix claimed in the Implementation Summary Block:
- Does a test exist that would fail if the bug came back?
- If yes: cite the test file and what it asserts
- If no: flag as a Category D candidate (fix without regression test)

Calculate: Category D ratio = (fixes without regression tests) / (total fixes)

---

Produce a VERIFICATION BLOCK formatted exactly as shown below:

---VERIFICATION BLOCK---
Verified scope: [subsystem group name from implementation summary]
Verification date: [today's date]
Cycle being verified: [subsystem + cycle reference]

INVARIANT PROBE RESULTS:
INV-XX | [invariant description] | PASS / FAIL / UNVERIFIED | [evidence summary]
(repeat for each probed invariant)
Probed: [N] | Passed: [N] | Failed: [N] | Unverified: [N]

REGRESSION COUNT:
Regressions found: [N]
R1 | [description] | [severity] | Documented by cycle: Y/N | [code location]
(repeat for each regression, or "None found")
Net score: [findings fixed] − [regressions] = [net]

CYCLE EXECUTION QUALITY:
Tests run to completion: YES/NO — [evidence]
Common Gotchas cross-checked: YES/NO — [evidence]
New Common Gotchas added: YES/NO — [what was added, or N/A]

COVERAGE GAP REPORT:
Fixes with regression tests: [N of M]
Category D candidates (fixes without regression tests):
[action ID] | [fix description] | [what test is needed]
(repeat for each, or "None — all fixes have regression tests")
Category D ratio: [X%]
---END VERIFICATION BLOCK---

Finally, answer: "What invariants should be added to the library based on what this cycle revealed?" List any new invariants discovered during verification that should be probed in future cycles.
