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
3. Where is the workflow friction? Tasks that are confusing, slow,
   or require unnecessary steps — separate from crashes or errors.

INTERFACE & VISUAL LAYER
If the project has no user-facing surface — a library, a CLI, a
service with no client — write "No user-facing surface — not assessed"
and continue to the outputs below.

Otherwise assess the interface, splitting what you find by what you
can actually verify. This split is load-bearing: reading code proves
structure, never appearance.

(a) STRUCTURAL — verifiable by code read. Report these as findings,
    using the same severity/confidence rubric as Stage 1:
    - Keyboard and assistive access: click handlers bound to
      non-interactive elements (div, span, tr) with no role,
      tabindex, or key handler; focus order; focus traps in modals
      and drawers; inputs with no associated label
    - Missing states: does every async or list surface render
      empty, loading, and error states, or only the success path?
    - Responsive posture: do breakpoints exist for the layouts that
      need them, or does the layout assume one viewport?
    - Theme completeness: does every declared theme or mode supply a
      value for every token it consumes, or does one mode inherit
      gaps?
    - Design-token bypass: hardcoded colors, spacing, or fonts
      routing around the project's tokens — flag only where it
      breaks theming or consistency, never as style preference
    - Feedback on failure: does every action that can fail tell the
      user it failed? A swallowed rejection in a click handler is a
      Stage 1 silent-degradation finding, not a nit

(b) PERCEPTUAL — contrast, hierarchy, spacing, density, whether it
    looks right. You cannot verify these from code. Do NOT report
    them as findings and do NOT guess at them. List them under
    OPERATOR VISUAL CHECKS below as concrete steps a person can walk
    in a browser, so the check is scheduled rather than assumed.
    Where the project defines Regression Scenarios, write them in
    that format so they can be adopted directly.

DO NOT flag visual choices you would have made differently. A layout
that works and is internally consistent is not a finding, the same
way working code that could be written differently is not a finding.

Then provide:
FEATURE EFFECTIVENESS (for each major feature area):
- [Feature area]: [Working well / Functional but limited / Needs work]
  [1-2 sentences on how effectively it serves users, not code quality]

INTERFACE FINDINGS (structural only — omit if no user-facing surface):
- [Finding] — [file/component] — [Severity] — [what a user hits] —
  [effort: S/M/L + rough time estimate]
(or "None — no structural interface findings")

OPERATOR VISUAL CHECKS (perceptual — needs a person at a browser):
- [What to look at] — [steps] — [what "correct" looks like]
(or "None needed")

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

IMPLEMENTATION BATCH PLAN (every finding, in suggested implementation order):
The Top 5 ranks impact; this ranks the WORK. Group every finding from
Stages 1–3 — interface findings included — into sequential batches,
each sized for one /broad-implement session. Order batches by
production impact first, then by dependency: a fix that a later batch's
regression check relies on goes earlier, and a new guard that would
turn CI red until a gap closes goes AFTER the batch that closes it.
Within a batch, order by severity. Estimate each item (S/M/L + rough
hours) and total each batch.

Batch 1 — [theme] | est. [total hours]
  [ID] | [Severity] | [one-line fix] | [effort: S/M/L + hours] | [depends on / unblocks, or "—"]
(repeat per batch)
Deferred (not batched): [ID] — [why: needs a decision, out of scope, or blocked on another item]

Every finding must appear exactly once — in a batch or under Deferred.
The sequence is a suggestion; I will choose which batches to run.

After I review the audit, I will tell you which findings to implement.
Do not implement anything until then.
