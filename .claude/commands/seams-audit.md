---
description: "Seams & Invariants Audit on its cadence: seam inventory, every invariant validated, candidates proposed"
---

This is the Seams & Invariants Audit as a command. It takes no arguments.
It gathers its own inputs, then follows the canonical prompt below without
changing it. Do steps 1–4 before reading on.

1. SUBSYSTEMS — read the Subsystems section of the Cycle Workflow Config
   (names and file lists). Leave out any listed under Frozen Subsystems,
   and say that you did.
2. LIBRARY — read the Invariant Library from the Cycle Workflow Config. If
   the project has scripts/invariant-check.mjs, run it: every invariant
   whose Verify field is a command is then probed by execution, and Part 2
   needs a code read only for the rest.
3. SYSTEMS MAP — use the systems map in CLAUDE.md if there is one;
   otherwise derive a 3–5 bullet summary from the Subsystems section and
   the entry points, and say that it is derived.
4. AXIS B — read the project's Horizontal (Axis B) Categories from the
   Cycle Workflow Config. Where Part 4 and the output block name five
   default categories, report on the project's configured categories
   instead — one line each, under its own name. A project that configures
   none uses the five named.

Wherever the prompt below shows a bracketed line saying something is
pasted or injected, use what steps 1–4 gave you. Number each proposed
invariant above the highest INV-N in the library or in any earlier
"Invariant candidates" or "Proposed additions" line under .cycle/blocks/,
in place of the INV-NEW-XX placeholder. They are candidates: this session
does not edit the library, and /sync-docs proposes their promotion.

The prompt's opening rule (no file changes) stands, with the SEAM COUNTER
step it already carries and one more exception:

BLOCKS (optional — only if .cycle/ exists): after producing the SEAMS &
INVARIANTS AUDIT BLOCK, write it verbatim to
.cycle/blocks/<cycle>-<letter>-seams.md — <cycle> from .cycle/STATE.md's
Cycle field, <letter> the next unused lowercase letter among that cycle's
non-release blocks. Health Synthesis and /sync-docs read it from there.
Never overwrite a block. Skip if no .cycle/.

═══════════════════════════════════════════
CANONICAL PROMPT — Seams & Invariants Audit
═══════════════════════════════════════════

Do not make any changes to any files during this session, other than the
optional SEAM COUNTER reset at the end.

[PASTE SYSTEMS MAP SUMMARY HERE]

This is a Seams & Invariants Audit. It runs on the project's Seams Audit Cadence (Cycle Workflow Config; default every 4 subsystem cycles) and has NO implementation phase. Your scope is explicitly the seams between subsystems and the invariants that must hold across them — the things no single vertical subsystem audit can own.

Project subsystems for reference:
[the project subsystem list is injected here per project]

INPUTS — read these before starting:
1. CLAUDE.md — especially the Common Gotchas section and Key Design Decisions
2. The Operator State Checklist (manual setup steps, env vars, one-time migrations)
3. The current invariant library below

[CURRENT INVARIANT LIBRARY — the current library is injected here per project]

---

Conduct the following audit in four parts:

PART 1 — SEAM INVENTORY
Identify every seam (boundary, interface, or handoff point) between the subsystems listed above. For each seam:
- Which two subsystems does it connect?
- What data or control crosses the boundary? (function calls, shared state, events, DB tables, config values)
- What assumptions does each side make about the other?
- Is the contract explicit (typed interface, schema, documented API) or implicit (convention, coincidence)?

Focus especially on seams where:
- One side was recently modified by a subsystem audit but the other side wasn't
- The contract is implicit rather than explicit
- Failure on one side would silently degrade the other (no error, just wrong results)

PART 2 — INVARIANT VALIDATION
For each invariant in the current library:
- Probe it via code read and/or test execution. Result: PASS / FAIL / STALE / UNVERIFIABLE
- STALE means the invariant references code that has been refactored or removed — it needs rewording or retirement
- If FAIL: describe what broke and which subsystem cycle likely caused it
- If UNVERIFIABLE: explain what would need to exist (test, assertion, monitoring) to make it verifiable

PART 3 — INVARIANT DISCOVERY
Based on Part 1 (seam inventory), identify new invariants that should be added to the library. These are rules that:
- Must hold across subsystem boundaries (not internal to one subsystem)
- Would cause silent degradation or data corruption if violated
- Are not currently tested or asserted anywhere

For each proposed invariant:
- State the rule clearly in one sentence
- Identify which seam it guards
- Note whether it is currently testable or would need new infrastructure

Also review the Common Gotchas section of CLAUDE.md and the Operator State Checklist for any rules that should be promoted to formal invariants.

PART 4 — HORIZONTAL BUG-SHAPE OBSERVATIONS
Provide cross-cutting observations relevant to the five Axis B categories from Health Synthesis. This is not a score — it is evidence for the next synthesis:
- Silent Degradation: any new silent-failure paths discovered at seams
- Startup Ordering: any ordering dependencies between subsystems that lack validation
- Operator-Only State Gaps: any manual steps that affect multiple subsystems but have no automated check
- Parallel Source-of-Truth Drift: any definitions, configs, or types duplicated across subsystem boundaries
- Test Coverage Quality: any seams that have zero test coverage

---

Produce the following output:

---SEAMS & INVARIANTS AUDIT BLOCK---
Audit date: [today's date]
Subsystem cycles since last seams audit: [N or "First audit"]

SEAM INVENTORY:
[seam-ID] | [Subsystem A] ↔ [Subsystem B] | [What crosses] | Contract: explicit/implicit | Risk: [High/Med/Low]
(repeat for each seam identified)

INVARIANT LIBRARY UPDATE:
[Validated — one PASS/FAIL/STALE/UNVERIFIABLE line per current invariant, injected at render time]
[INV-XX] | [PASS/FAIL/STALE/UNVERIFIABLE] | [one-line evidence]
(repeat for each existing invariant)

Proposed additions:
[INV-NEW-XX] | [invariant rule] | Guards seam: [seam-ID] | Testable: Yes/No
(repeat for each proposed invariant)

Proposed retirements:
[INV-XX] | [reason — stale, subsumed, or no longer applicable]
(or "None")

HORIZONTAL OBSERVATIONS (evidence for next Axis B scoring):
Silent Degradation: [observations]
Startup Ordering: [observations]
Operator-Only Gaps: [observations]
Parallel Drift: [observations]
Test Coverage: [observations]

RECOMMENDED FOCUS FOR NEXT SUBSYSTEM CYCLE:
[Which subsystem should be audited next based on seam risk, and what seam-related findings should be added to its audit scope]
---END SEAMS & INVARIANTS AUDIT BLOCK---

SEAM COUNTER (optional — only if .cycle/ exists): reset "Subsystem cycles
since last Seams audit" in .cycle/STATE.md to 0. This audit is what that
counter measures — /audit and /cycle-status read it to report the next one
DUE — so leaving it unreset reports DUE forever. This is the only file
write this session may make. Skip if no .cycle/.
