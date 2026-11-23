---
description: "Deep subsystem audit (produces a Session Handoff Block)"
argument-hint: "<subsystem-name>"
---

If $ARGUMENTS is empty or missing, respond with exactly this and stop:

Usage: /audit <subsystem-name>
Available subsystems: see the Subsystems section in CLAUDE.md's Cycle
Workflow Config.

---

Read CLAUDE.md (especially Common Gotchas, Key Design Decisions, and the
Cycle Workflow Config) before starting. Do not make any changes to any
files during this session, other than the optional CYCLE OPEN,
FOLLOW-ON REVIEW and SAVE REPORT steps below.

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

Seams cadence check: read the Seams Audit Cadence (N) from the Cycle
Workflow Config and "Subsystem cycles since last Seams audit" (K) from
.cycle/STATE.md (treat a missing counter or cadence as 0 / default 4). If
K >= N, note at the TOP of your output that a Seams & Invariants audit is
DUE (K of N) and recommend running it this cycle or next — then proceed
with this audit normally.

Audit this subsystem across these focus areas:
1. Bugs and logic errors in currently-reachable code paths
2. Dead or superseded artifacts — code, exports, styles/classes, markup,
   config, feature flags, exemptions — but ONLY where the thing is
   actively misleading: it hides a live defect, contradicts what the code
   does now, or survives a change that replaced it. Volume is not a
   finding; concealment is. For each, state how you verified it is
   unreferenced, and mark it SAFE (mechanically verified — no reference in
   any code path, template string, or generated markup) or PROPOSE (looks
   unused, but dynamic or generated references cannot be ruled out).
   PROPOSE items are questions for the operator, never removals.
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
Removing something is a change like any other and needs the same evidence
a fix needs. If you cannot name the check that proves nothing references
it, it is a PROPOSE, not a finding.

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
