---
description: "Scoped subsystem audit + plan"
argument-hint: "<subsystem-name>"
---

If $ARGUMENTS is empty or missing, respond with exactly this and stop:

Usage: /targeted-audit <subsystem-name>

Available subsystems: See the "Subsystems" section in CLAUDE.md's
Cycle Workflow Config for the full list.

Example: /targeted-audit Security & Compliance

---

Read CLAUDE.md (especially Common Gotchas, Key Design Decisions, and
the Cycle Workflow Config) before starting. Do not make any changes
to any files during this session, other than the optional CYCLE OPEN,
FOLLOW-ON REVIEW and SAVE REPORT steps below.

This session's scope: $ARGUMENTS
Use the Subsystems section of CLAUDE.md's Cycle Workflow Config to
identify the relevant files for this subsystem.

CYCLE OPEN (optional — only if .cycle/STATE.md exists): this audit opens
a new cycle, and this is one of the session's three permitted file writes
(the others are FOLLOW-ON REVIEW and SAVE REPORT, below).
Increment STATE.md's Cycle field by 1 (treat a missing or non-numeric
value as 0, so a project's first audit is Cycle 1) and set Phase: audit,
Scope to this audit's scope, and Updated to today's date — unless this
is the SAME audit round: Phase is already "audit" and Updated is within
the last 7 days (a parallel or re-run audit of a cycle that is already
open). Then leave Cycle alone, add this audit's scope to the Scope line
if it is not there, and say so. An older "Phase: audit" is an audit that
led to no implementation; it does not hold the number — increment past
it. Every later phase of this cycle carries that number; none of them
increments it. When you increment:
- if STATE.md's other sections still describe the cycle you are leaving,
  do not edit them — end the Scope line with "(sections below still
  describe Cycle N)", N being that cycle; the first implement CHECKPOINT
  of the new cycle rolls them into .cycle/HISTORY.md;
- if .cycle/metrics.csv has a phase=reflect row for cycle N and no
  phase=synthesis row — while some earlier cycle has one, so this is a
  project that synthesizes — say at the TOP of your output that cycle N
  was reflected but never verified or synthesized, and that its
  verification inputs must now be requested for cycle N by number,
  because the Cycle field has moved on.
Skip if .cycle/STATE.md does not exist.

FOLLOW-ON REVIEW (optional — only if .cycle/STATE.md exists): read the
"Open follow-on items" in .cycle/STATE.md. Each item marked "next audit"
whose area falls in this audit's scope is a LEAD, not a finding: re-check
it with fresh eyes and close it as exactly one of —
- confirmed: it becomes a finding; give the finding its own ID and cite
  the FO ID beside it;
- already fixed: say what you checked;
- still open: keep it, and say why it is not a finding yet.
List every reviewed item under a FOLLOW-ON REVIEW heading at the end of
your output. Then move the items closed as already fixed from
.cycle/STATE.md to .cycle/HISTORY.md with what you checked, and in STATE.md
change a confirmed item's disposition to "confirmed as <finding
ID> (Cycle <N>)" — it stays open until the session that implements that
finding removes it. Items with any other disposition are not this audit's
to close. Skip this step if .cycle/STATE.md does not exist.

SAVE REPORT (optional — only if .cycle/STATE.md exists): when your output
is complete, write all of it VERBATIM to .cycle/blocks/ — the third of the
session's permitted file writes. Name the file by the command that ran:
<cycle>-scan.md for /broad-scan, <cycle>-audit-<subsystem>.md for /audit,
<cycle>-targeted-audit-<subsystem>.md for /targeted-audit — <cycle> from
STATE.md's Cycle field after CYCLE OPEN, <subsystem> in lower case with
every run of other characters turned into one hyphen. If that name is
taken (a re-run in the same round), add -2 (then -3, …) before .md; never
overwrite a block. The saved report is what later sessions read: an
implement session takes a batch, a finding or a handoff block from it,
Health Synthesis reads a Tier 1 cycle's FINAL REPORT and batch plan from
it, and the synthesis pack checks the batch plan against what shipped.
Write it in full, security findings included; whether .cycle/blocks/ is
committed to a public repository is the operator's decision. Skip this
step if .cycle/STATE.md does not exist.

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
- Dead or superseded artifacts — code, exports, styles/classes, markup,
  config, feature flags, exemptions — but ONLY where the thing is
  actively misleading: it hides a live defect, contradicts what the code
  does now, or survives a change that replaced it. Volume is not a
  finding; concealment is. For each, state how you verified it is
  unreferenced, and mark it SAFE (mechanically verified — no reference in
  any code path, template string, or generated markup) or PROPOSE (looks
  unused, but dynamic or generated references cannot be ruled out).
  PROPOSE items are questions for the operator, never removals.

DO NOT flag style preferences, speculative improvements, or "could be
cleaner" refactoring unless the current code is actively wrong.
Removing something is a change like any other and needs the same evidence
a fix needs. If you cannot name the check that proves nothing references
it, it is a PROPOSE, not a finding.

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
