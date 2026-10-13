If $ARGUMENTS is empty or missing, respond with exactly this and stop:

Usage: /audit <subsystem-name>
Available subsystems: see the Subsystems section in CLAUDE.md's Cycle
Workflow Config.

---

Read CLAUDE.md (especially Common Gotchas, Key Design Decisions, and the
Cycle Workflow Config) before starting. Do not make any changes to any
files during this session, other than the optional CYCLE OPEN step below.

This session's scope: $ARGUMENTS

[PASTE SYSTEMS MAP SUMMARY HERE — 3–5 bullets]
[OPTIONAL: PASTE FOLLOW-ON ITEMS FROM A PRIOR SESSION]
[IF TRIGGERED: PASTE POLICY RESPONSE BLOCKS FROM THE LAST HEALTH
 SYNTHESIS — these are MANDATORY scope additions for this cycle]
[OPTIONAL: SEAMS AUDIT FOCUS — a seam this cycle should emphasize]

If this scope is listed under Frozen Subsystems in the Cycle Workflow
Config, print the FROZEN SUBSYSTEM banner (see /targeted-audit) before
continuing, then proceed.

CYCLE OPEN (optional — only if .cycle/STATE.md exists): this audit opens
a new cycle, and this is the ONLY file write the session may make. Unless
STATE.md's Phase is already "audit" (a parallel or re-run audit of a
cycle that is already open — then leave Cycle alone and say so),
increment its Cycle field by 1 (treat a missing or non-numeric value as
0, so a project's first audit is Cycle 1) and set Phase: audit, Scope to
this audit's scope, and Updated to today's date. Every later phase of
this cycle carries that number; none of them increments it. Skip if
.cycle/STATE.md does not exist.

Seams cadence check: read the Seams Audit Cadence (N) from the Cycle
Workflow Config and "Subsystem cycles since last Seams audit" (K) from
.cycle/STATE.md (treat a missing counter or cadence as 0 / default 4). If
K >= N, note at the TOP of your output that a Seams & Invariants audit is
DUE (K of N) and recommend running it this cycle or next — then proceed
with this audit normally.

Audit this subsystem across these focus areas:
1. Bugs and logic errors in currently-reachable code paths
2. Dead code / unused exports (only if they create confusion)
3. Test gaps (missing coverage on load-bearing paths)
4. Stale artifacts (TODOs, comments, docs that mislead)
5. Hardcoded values that should be config/env
6. Security and compliance gaps
7. Docs drift (CLAUDE.md vs implementation)
8. Code quality that is actively wrong (not style preference)
9. Parallel source-of-truth (values/types defined in multiple places)
10. Startup ordering / initialization assumptions
11. Silent degradation paths (failure swallowed, wrong results continue)
12. Operator-only state (manual steps with no automated validation)

For each finding:
- State the issue, cite file and function/line
- Severity: Critical / High / Medium / Low
- Confidence: High / Medium / Low
- Would this fire in production this month? YES (trigger) / NO (why not)
- Effort: S (<2h) / M (½–2 days) / L (3+ days) + rough time estimate

DO NOT flag style preferences or speculative "could be cleaner"
refactoring unless the current code is actively wrong.

Finding IDs in the handoff block are SESSION-LOCAL labels (F1, F2, …) —
not invariant-library IDs. INV-N IDs are assigned only when a rule is
promoted to the Invariant Library (see /reflect), so parallel audit
sessions can reuse F1/F2 without colliding.

Do NOT produce an implementation plan — that is /plan. Produce a
SESSION HANDOFF BLOCK:

---SESSION HANDOFF BLOCK---
Scope: [subsystem group name]
Files covered: [comma-separated list]
Audit confidence: [High / Medium / Low]

FINDINGS:
[ID] | [File: function/line] | [Severity] | [Confidence] | [Effort] | [Description]

CROSS-MODULE DEPENDENCIES SURFACED:
- [dependency description]

OPERATOR ACTIONS SURFACED (manual / out-of-PR steps this scope depends on — env vars, IaC, console/dashboard, one-time migrations):
- [action] | BLOCKS DEPLOY: Y/N
(or "None")

TOP PRIORITIES:
Impact: [finding IDs]
High-leverage: [finding IDs]

RECOMMENDED PLANNING STARTING POINT: [one sentence]
---END HANDOFF BLOCK---
