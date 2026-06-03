Do not make any changes to any files during the audit phase.

Read CLAUDE.md (especially Common Gotchas and Key Design Decisions),
README, and the roadmap carefully before doing anything else.

This audit runs in three stages within this session. Complete each stage fully before starting the next.

═══════════════════════════════════════════
STAGE 1 — BROAD PASS
═══════════════════════════════════════════

Audit the codebase thoroughly. For each finding:
- State the issue, cite the file and function/line area
- Severity: Critical / High / Medium / Low
- Confidence: High / Medium / Low (flag if you only skimmed this area)
- Classify: is this a production bug, a structural/quality issue, or
  a feature/effectiveness gap? Be honest about which.

Flag:
- Bugs and logic errors in currently-reachable code paths
- Security and compliance gaps (auth, sensitive data handling, audit logging)
- Inconsistencies between CLAUDE.md/docs and actual implementation
- Dead code, unused exports, stale TODOs only if they create confusion
- Silent degradation paths: places where failure is swallowed and the
  app continues with wrong results rather than surfacing an error

For findings in any Frozen Subsystem (see CLAUDE.md Cycle Workflow Config):
- Prefix the finding with [FROZEN: subsystem-name]
- Consider whether the finding is worth fixing given retirement —
  Critical/High findings still warrant a fix; Medium/Low findings
  may be deferred or skipped depending on the retirement timeline

DO NOT flag code for "simplification" or "cleanup" unless the current
code is actively wrong or creates a maintenance trap. Working code
that could be written differently is not a finding.

After the broad pass, provide ratings out of 10 with reasoning for
each dimension listed in the "Health Dimensions" section of CLAUDE.md's
Cycle Workflow Config. One bullet per dimension.

For each rating include:
- Your confidence level (did you deeply read this area or infer from partial context?)
- The single finding most dragging the score down
- The single highest-leverage improvement and its estimated effort: S / M / L plus a rough wall-clock estimate (e.g. S ≈ <2h, M ≈ ½–2 days, L ≈ 3+ days; for one developer working with Claude Code)

End Stage 1 with:
- Top 5 findings by production impact (most likely to cause real breakage)
- Any findings that contradict or are missing from CLAUDE.md Common Gotchas
- CONFIDENCE GAP LIST: For every dimension you rated Medium or Low
  confidence, list the specific files and areas you did not read deeply.
  Format: [Dimension] — [files/areas not read] — [what you inferred
  vs. what you'd need to verify]

═══════════════════════════════════════════
STAGE 2 — DEEP DIVE ON LOW-CONFIDENCE AREAS
═══════════════════════════════════════════

Now go deeper on every area in your Confidence Gap List from Stage 1.
For each Low or Medium confidence dimension:

1. Read the specific files you listed as not deeply read
2. Look for findings you missed in Stage 1 — especially silent
   degradation, cross-module dependency issues, and security gaps
   that only appear on close reading
3. Update your findings list: add new findings, revise or remove
   any Stage 1 findings that were wrong on closer inspection
4. Revise your confidence level and score for each dimension you
   re-examined. For each revision, note what changed and why.

After completing the deep dives, produce a FINAL REPORT:

REVISED RATINGS (only dimensions that changed):
- [Dimension]: [old score] → [new score] | Confidence: [old] → [new]
  Reason: [what the deep dive revealed]

NEW FINDINGS (discovered in Stage 2):
[same format as Stage 1 findings]

RETRACTED FINDINGS (Stage 1 findings that were wrong on closer read):
[finding ID] — [why it was wrong]

FINAL TOP 5 by production impact (updated if Stage 2 changed the ranking)

One sentence: the single most important thing to fix before anything else.

═══════════════════════════════════════════
STAGE 3 — EFFECTIVENESS & STRATEGIC REVIEW
═══════════════════════════════════════════

Shift your lens from "what's broken" to "how well does this work."
Stages 1-2 assessed code quality. Stage 3 assesses the product.

For each major feature area (use the rating dimensions as a guide):
1. Does this feature actually accomplish what it's designed to do?
   Not "is it bug-free" but "does it produce good results for users?"
2. What's missing that a user or operator would reasonably expect?
   Completeness gaps, not bugs — things that aren't built yet vs.
   things that are built wrong.
3. Where is the UX friction? Workflows that are confusing, slow,
   or require unnecessary steps — separate from crashes or errors.

Then provide:
FEATURE EFFECTIVENESS (for each major feature area):
- [Feature area]: [Working well / Functional but limited / Needs work]
  [1-2 sentences on how effectively it serves users, not code quality]

COMPLETENESS GAPS (what's not built yet that should be):
- [Gap] — [impact on users] — [effort: S/M/L + rough time estimate]
(list the top 5 most impactful gaps)

STRATEGIC SUGGESTIONS (what would make this significantly more valuable):
- [Suggestion] — [why it matters] — [builds on what already exists]
(3-5 suggestions, grounded in what you observed, not generic advice)

PRODUCTION READINESS ASSESSMENT:
One paragraph: is this tool ready for production use? What's the gap
between current state and production-ready? Be specific about what
"production-ready" means for this type of application.

After I review the audit, I will tell you which findings to implement.
Do not implement anything until then.
