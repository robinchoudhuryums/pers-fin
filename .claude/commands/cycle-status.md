---
description: "Read-only: report standing + the next action for the current phase"
---

Do not make any changes to any files during this session. This is a
read-only status check — do not start any audit or implementation.

Read the project's current cycle state, in this order (skip any that
don't exist):
1. CLAUDE.md Cycle Workflow Config (subsystems, invariants, policy config)
2. PROJECT_HEALTH.md (score history / current standing)
3. .cycle/STATE.md (in-progress work)
4. .cycle/metrics.csv (per-cycle trend)

Produce a CYCLE STATUS report:
- Current standing: [latest synthesis scores / one-line health, or
  "no synthesis recorded yet"]
- Active cycle & phase: [from STATE.md's Cycle field — the single source of
  truth; flag if any metrics.csv row's cycle disagrees with it]
- In-progress work: [what's partially done + the next concrete step,
  or "none"]
- Open follow-on items: [list, or "none"]
- Trend: [direction from metrics.csv if present, or "n/a"]
- Seams cadence: [K of N subsystem cycles since the last Seams audit —
  K from STATE.md's "Subsystem cycles since last Seams audit", N from the
  Cycle Workflow Config's Seams Audit Cadence; flag "DUE" if K >= N]
- RECOMMENDED NEXT ACTION — choose explicitly, from STATE.md's Phase:
  → RESUME — Phase is implement and there is unfinished implementation
    work in STATE.md → run /cycle-resume
  → IMPLEMENT — Phase is audit: an audit has opened this cycle and
    nothing is implemented yet → choose findings and run the implement
    command for that tier
  → CLOSE OUT — Phase is reflect: reflected, not yet closed → run
    /cycle-close. In a project that verifies and synthesizes, first run
    /verify in a fresh session and then /health-synthesis
  → FRESH AUDIT — the last cycle is complete (Phase is idle, or none is
    in progress) → start /broad-scan or /targeted-audit <subsystem>
  State which and why in one sentence. A fresh audit must use fresh
  eyes — it does NOT inherit prior findings as conclusions.
