Read CLAUDE.md before starting. Do not make any changes to any files
during this session (other than the optional metrics / estimates / STATE
counter appends below).

[PASTE IMPLEMENTATION SUMMARY BLOCK — and REGRESSION results if available]

For each action completed this cycle, answer two binary questions:
1. Would this bug have actually fired in production this month?
   YES (real, currently-reachable, realistic load) / NO (speculative,
   defensive, dead code, zero-caller). Be specific about the trigger.
2. Did this action introduce a new failure mode, documented or not?
   YES (describe it; better or worse than what it replaced; when it
   fires) / NO. If the post-cycle state is worse under any realistic
   scenario, that is a regression — count it, don't bury it as a
   "tradeoff".

Tally (three-way classification):
- Production fixes (YES to Q1): [count] — severity breakdown
- New capabilities / features: [count]
- Defensive/structural (NO to Q1, not a feature): [count]
- New failure modes (YES to Q2): [count] — severity breakdown
- Net score: [production fixes] − [new failure modes] = [net]
  (a net-positive score with a Critical new failure mode is still a problem)

Honest impact summary:
- What changed for a user right now?
- What changed for the next developer in this subsystem?
- What became safer under scale / concurrent load?
- Was effort spent on dead code / zero-caller paths / future-proofing?

Invariant growth: list rules this cycle establishes that the next
Verification Pass should probe. Assign each a NEW invariant ID by reading
the current maximum INV-N in the library and incrementing (INV-(max+1),
INV-(max+2), …) — do not invent or reuse a number, so parallel sessions
don't collide:
[INV-N] | [rule] | [subsystem/seam] | [Verify: test/assertion].

End with: the single most structurally significant change; the finding
that should have been deferred.

Produce a CYCLE SUMMARY BLOCK:

---CYCLE SUMMARY BLOCK---
Scope: [subsystem] | Cycle: [N/date]
Production fixes: [count] — severity: [breakdown]
New capabilities/features: [count]
Defensive/structural: [count]
New failure modes: [count] — severity: [breakdown]
Net score: [fixes] − [new failure modes] = [net]
Invariant candidates: [list or "None"]
Most structurally significant change: [one line]
Should-have-been-deferred: [one line]
---END CYCLE SUMMARY BLOCK---

METRICS (optional — only if .cycle/ exists): /reflect is the SOLE writer
of net_score/prod_fixes/new_failure_modes — append exactly ONE phase=reflect
row per cycle's reflection to .cycle/metrics.csv (header:
date,cycle,subsystem,phase,net_score,prod_fixes,new_failure_modes,category_d_ratio,axis_b_lowest,notes,defensive_count)
with net_score, prod_fixes, new_failure_modes, and defensive_count (the
Defensive/structural count from the tally above — a secondary signal that
does NOT change net_score); take the `cycle` value from .cycle/STATE.md's
Cycle field (the single source of truth — don't invent one); leave the
synthesis-only columns blank. defensive_count is the LAST column (after
the quoted notes). Do NOT also record net_score/prod_fixes/
new_failure_modes on an implement-phase row (the implement commands write
STATE.md, not metrics). Skip if no .cycle/.

ESTIMATE CALIBRATION (optional — only if .cycle/ exists): for each action
that carried an effort estimate, append a row to .cycle/estimates.csv
(header: date,cycle,action,estimate,estimated_hours,actual_hours,calibration_note)
recording the original S/M/L + estimated hours against the actual time
spent. End with one line on your calibration trend (e.g. "L items are
running ~2x the estimate"). Skip if no .cycle/.

SEAM COUNTER (optional — only if .cycle/ exists): increment "Subsystem
cycles since last Seams audit" in .cycle/STATE.md by 1 — this reflection
completes a subsystem cycle, and the count drives /audit's seams-cadence
reminder. (A Seams & Invariants audit resets it to 0.) Skip if no .cycle/.
