If $ARGUMENTS is empty or missing, respond with exactly this and stop:

Usage: /targeted-audit <subsystem-name>

Available subsystems: See the "Subsystems" section in CLAUDE.md's
Cycle Workflow Config for the full list.

Example: /targeted-audit Security & Compliance

---

Read CLAUDE.md (especially Common Gotchas, Key Design Decisions, and
the Cycle Workflow Config) before starting. Do not make any changes
to any files during this session, other than the optional CYCLE OPEN
step below.

This session's scope: $ARGUMENTS
Use the Subsystems section of CLAUDE.md's Cycle Workflow Config to
identify the relevant files for this subsystem.

CYCLE OPEN (optional — only if .cycle/STATE.md exists): this audit opens
a new cycle, and this is the ONLY file write the session may make. Unless
STATE.md's Phase is already "audit" (a parallel or re-run audit of a
cycle that is already open — then leave Cycle alone and say so),
increment its Cycle field by 1 (treat a missing or non-numeric value as
0, so a project's first audit is Cycle 1) and set Phase: audit, Scope to
this audit's scope, and Updated to today's date. Every later phase of
this cycle carries that number; none of them increments it. Skip if
.cycle/STATE.md does not exist.

If $ARGUMENTS names a subsystem listed in `Frozen Subsystems`:
print this banner at the top of your output before continuing, then
proceed with the audit as normal:

  ╔══════════════════════════════════════════════════════════════╗
  ║ FROZEN SUBSYSTEM — proceeding because explicitly named.      ║
  ║ Reason: [reason from Frozen Subsystems config]               ║
  ╚══════════════════════════════════════════════════════════════╝

[OPTIONAL: PASTE ANY FOLLOW-ON ITEMS FROM A PRIOR SESSION]

[IF TRIGGERED: PASTE ANY POLICY RESPONSE BLOCKS FROM THE LAST HEALTH
SYNTHESIS — these are MANDATORY scope additions for this cycle]

Audit this subsystem thoroughly. For each finding:
- State the issue, cite file and function/line
- Severity: Critical / High / Medium / Low
- Confidence: High / Medium / Low
- Would this bug actually fire in production this month? YES/NO
- Effort to fix: S (< 2 hours) / M (half-day to 2 days) / L (3+ days)

Focus on:
- Bugs and logic errors in currently-reachable code paths
- Security concerns specific to this module
- Inconsistencies between CLAUDE.md and actual implementation
- Cross-module dependencies — what would break in OTHER modules
- Silent degradation paths

DO NOT flag style preferences, speculative improvements, or "could be
cleaner" refactoring unless the current code is actively wrong.

After the audit, produce an implementation plan:
- Action ID (A1, A2, A3...)
- What specifically to do (concrete)
- Which finding(s) it addresses
- Effort: S / M / L
- Cross-module risk: Low / High
- Prerequisites

Organize into:
1. Fix now — production bugs, security issues, blocking problems
2. Fix this session — high-value, well-scoped, low cross-module risk
3. Defer — needs more context, high risk, or dependencies outside scope

End with a TIER 2 HANDOFF BLOCK:

---TIER 2 HANDOFF BLOCK---
Scope: [subsystem]
Findings: [count] total — [critical/high/medium/low breakdown]
Production bugs (would fire this month): [count]

ACTIONS (implement in this order):
[ID] | [File: area] | [Effort] | [Risk] | [Description]

CROSS-MODULE RISKS:
- [what could break outside this scope and where to verify]
(or "None identified")

OPERATOR ACTIONS SURFACED (manual / out-of-PR steps — env vars, IaC, console/dashboard, migrations):
- [action] | BLOCKS DEPLOY: Y/N
(or "None")

DO NOT TOUCH:
- [high-risk files/functions — explain why]
---END TIER 2 HANDOFF BLOCK---
