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
- Active cycle & phase: [from STATE.md, or "none in progress"]
- In-progress work: [what's partially done + the next concrete step,
  or "none"]
- Open follow-on items: [list, or "none"]
- Trend: [direction from metrics.csv if present, or "n/a"]
- RECOMMENDED NEXT ACTION — choose explicitly:
  → RESUME — there is unfinished implementation work in STATE.md →
    run /cycle-resume
  → FRESH AUDIT — the last cycle is complete (or none is in progress) →
    start /broad-scan or /targeted-audit <subsystem>
  State which and why in one sentence. A fresh audit must use fresh
  eyes — it does NOT inherit prior findings as conclusions.
