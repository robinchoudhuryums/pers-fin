Read CLAUDE.md (Cycle Workflow Config) before starting. Do not make any
changes to any files during this session.

[PASTE SYSTEMS MAP SUMMARY HERE]
[OPTIONAL: PRIOR SYNTHESIS SCORE OR KEY FINDINGS FOR REFERENCE]

Provide a Health Pulse — a directional snapshot on both axes. This is
lower-precision than a synthesis; never compare pulse scores to synthesis
scores.

AXIS A — VERTICAL (subsystem health): for each Health Dimension in the
Cycle Workflow Config, give a score /10 (or "Not assessed"), confidence
(High / Med / Low), one sentence of reasoning, and flag any
Low-confidence dimension whose audit is overdue.

AXIS B — HORIZONTAL (bug-shape posture): for each Axis B category in the
Cycle Workflow Config (default: Silent Degradation, Startup Ordering,
Operator-Only Gaps, Parallel Drift, Test Coverage Quality), give a quick
1–10 directional score and one sentence of evidence from CLAUDE.md,
recent commits, and code structure. Flag these as lower-confidence.

Close with:
- Anything materially worse since the last assessment?
- Which dimension/category should move up the audit queue?
- The one thing most likely to cause a problem before the next full cycle
- Which Axis B category you'd investigate first with one hour
