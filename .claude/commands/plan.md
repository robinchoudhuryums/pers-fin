If $ARGUMENTS is empty AND no SESSION HANDOFF BLOCK exists earlier in
this session, respond with exactly this and stop:

Usage (same session): /plan — run after /audit
Usage (new session): paste the SESSION HANDOFF BLOCK first, then run

---

Read CLAUDE.md (Common Gotchas, Cycle Workflow Config) before starting.
Do not make any changes to any files during this session.

[PASTE SESSION HANDOFF BLOCK HERE IF FRESH SESSION]
[PASTE SYSTEMS MAP SUMMARY HERE]

Produce a prioritized action plan for the scope in the handoff block.

For each action:
- Action ID (A1, A2…)
- Concrete description (not "improve error handling")
- Finding ID(s) it addresses
- Effort: S / M / L + rough time estimate
- Cross-module risk: Low / High / Very High
- Prerequisites

Organize into:
1. Do immediately — critical, quick wins, or blockers
2. Do this week — high-value, well-scoped
3. Defer but schedule — important, not urgent, or has dependencies

If more than ~15 findings, split actions into Batch 1 (P0/Critical +
highest-compliance-risk) and Batch 2 (rest), and emit a complete,
SEPARATE IMPLEMENTATION HANDOFF BLOCK for EACH batch (set the Batch field
accordingly). Batch 2's block must stand alone — a fresh session must be
able to run it from its block alone, so do not leave Batch 2 as prose.

Then:
- Findings to escalate to the roadmap (too large/structural)
- Architectural decisions needed before implementation — each with the
  question, options + tradeoffs, a recommendation, and whether
  implementation is blocked or a safe default can proceed now
- Actions that are good automation/scripting candidates

Produce a DOCUMENTATION UPDATE CHECKLIST (CLAUDE.md / README / roadmap /
inline comments / other — omit files needing no change).

Then produce an IMPLEMENTATION HANDOFF BLOCK:

---IMPLEMENTATION HANDOFF BLOCK---
Scope: [subsystem group name]
Systems map reference: [available? Y/N]
Batch: [1 of 1 / 1 of 2 / 2 of 2 — omit if no split]

ACTIONS TO IMPLEMENT:
[ID] | [File: function/area] | [Effort] | [Cross-module risk] | [One-line description] | [Prereq IDs]

HIGH/VERY HIGH RISK ACTIONS (require dependency check before implementation):
[action IDs + the exports/interfaces they touch]

POLICY RESPONSE ACTIONS (mandatory if triggered — from last Health Synthesis):
[list or "None triggered"]

OPERATOR ACTIONS (carry forward to implement; mark deploy blockers — env vars, IaC, console/dashboard, migrations):
[action | BLOCKS DEPLOY: Y/N, or "None"]

IMPLEMENT IN THIS ORDER: [ordered action IDs]
ORDERING RATIONALE: [1–2 sentences]
---END IMPLEMENTATION HANDOFF BLOCK---
