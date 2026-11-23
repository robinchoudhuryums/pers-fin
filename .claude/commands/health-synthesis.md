---
description: "Two-axis Health Synthesis from the cycle's blocks; updates PROJECT_HEALTH.md on approval and closes the cycle"
argument-hint: "[cycle number]"
---

Usage: /health-synthesis [cycle number]   (default: the cycle owed
synthesis — see step 1). Run it in a fresh session, after /verify.

This is Health Synthesis as a command. It gathers its own inputs, then
follows the canonical prompt below without changing it. Do steps 1–6
before reading on.

1. CYCLE — $ARGUMENTS names the cycle if given. Otherwise use
   .cycle/STATE.md's Cycle field — unless .cycle/metrics.csv shows an
   EARLIER cycle with a phase=reflect row and no phase=synthesis row while
   this one has no reflect row yet: then the earlier cycle is the one
   owed. Say which cycle you are synthesizing. With no .cycle/ directory,
   ask the operator to paste the blocks the prompt lists.
2. INPUT BLOCKS — read every file under .cycle/blocks/ whose name starts
   with that cycle's number: each implementation summary, the Cycle
   Summary Block (…-reflect.md), the Verification Block
   (…-verification.md), a Seams block (…-seams.md) if one ran, and the
   audit's saved report: …-scan.md for a Tier 1 cycle (its FINAL REPORT
   and batch plan stand in for the Session Handoff Block), or
   …-audit-<subsystem>.md / …-targeted-audit-<subsystem>.md. If an audit
   saved none, say so. If there is no Verification Block,
   say so at the top and follow the prompt's rule for a missing one — do
   not verify the cycle yourself in this session. If there are several
   (…-verification.md, …-verification-2.md), the newest is the input and
   the others are named as superseded.
   NO REFLECT BLOCK — if none of that cycle's files is a …-reflect.md
   block, /reflect has not run, so the cycle has no Cycle Summary Block
   and no reflect row for its net score: say so at the top of your output
   and ask the operator whether to synthesize anyway or to run /reflect
   first. Do not go on until they answer.
3. PRIOR SCORES — read PROJECT_HEALTH.md: Current Standing and the newest
   Score History entry are the prior synthesis, for the delta and for the
   policy triggers.
4. DIMENSIONS — read Health Dimensions, the Horizontal (Axis B) Categories
   with what each measures, Subsystems and Policy Configuration from the
   Cycle Workflow Config. A project that configures no Axis B categories
   uses the standard five. A subsystem listed under Frozen Subsystems is
   "Not assessed this cycle" unless a block covers it.
5. PLAYBOOKS — the prompt offers per-category policy playbooks as starting
   points. Where none is supplied for a category, write the prescribed fix
   from that category's own definition and this cycle's evidence.
6. DERIVED FIGURES — if the project has scripts/synthesis-pack.mjs, run it
   for the cycle (node scripts/synthesis-pack.mjs --cycle N). Take the
   net-score reconciliation, the missing-verification flag, the releases
   no reflection or verification covers, the prior-score series, the
   cycles with no synthesis, the score at which each policy clause fires
   and, for a Tier 1 cycle, the batch plan against what shipped from it —
   do not add them up by eye. Where your judgment departs
   from a figure it derived, say so and why. Without the script, derive
   the same figures from the blocks, metrics.csv and PROJECT_HEALTH.md.

Wherever the prompt below shows a bracketed line saying something is
pasted or injected, use what steps 1–6 gave you.

The prompt's opening rule (no file changes beyond step 8) stands, with one
more exception:

PROJECT HEALTH — after producing the section 6 update block, show it and
ask the operator to approve it. On approval, replace the Current Standing
section of PROJECT_HEALTH.md with it and add the new Cycle entry at the
top of Score History, keeping every field label exactly as the block gives
it. Then, if the project has scripts/synthesis-pack.mjs, run it with
--check: the metrics row, Current Standing and the new entry must agree on
the cycle, the lowest Axis B category and score, Category D, Overall and
the triggered policy clauses. Fix any disagreement it reports before you
finish. Without approval, leave the file alone; the block in chat is the
record.

═══════════════════════════════════════════
CANONICAL PROMPT — Health Synthesis
═══════════════════════════════════════════

Do not make any changes to any files during this session, other than the
optional metrics.csv append and STATE.md phase update in step 8.

PRIMARY INPUT — Paste three blocks per subsystem completed this cycle:
(Session Handoff Block from §1 audit, Cycle Summary Block from /reflect, Verification Block from §4v)
For a Tier 1 cycle (/broad-scan), there is no per-subsystem Session Handoff Block: paste the scan's FINAL REPORT and batch plan once in its place, and one Cycle Summary Block and Verification Block for the cycle.

[one entry per project subsystem — three blocks each, injected at render time]
[OPTIONAL: PASTE PRIOR SYNTHESIS SCORE HERE FOR DELTA COMPARISON]

[OPTIONAL: PASTE SEAMS & INVARIANTS AUDIT BLOCK — if a Seams audit ran this cycle, its horizontal observations feed directly into Axis B scoring and its invariant library updates should be reflected in invariant probe results]

Using these inputs as your primary source of truth, produce a Project Health Report scored on two orthogonal axes.

Important: The Verification Block is an independent check — its regression counts, invariant probe results, and coverage gap data take precedence over the cycle's self-reported results where they conflict.

If a Verification Block is missing for a subsystem: mark Axis B confidence as "Low — no independent verification" for that subsystem's contributions. Score Axis B categories using only the Cycle Summary Block and Session Handoff Block, but note that these are self-reported and unverified. Do NOT skip Axis B scoring entirely — provide best-effort scores with the low-confidence flag.

═══════════════════════════════════════════════════
AXIS A — VERTICAL (Subsystem Health)
═══════════════════════════════════════════════════

For each dimension below, provide:
- A score out of 10, OR "Not assessed this cycle" if no direct signal exists from the cycle inputs
  Do NOT fabricate a score from indirect evidence. If no subsystem cycle touched a dimension and no Verification Block probed it, mark it "Not assessed." This is especially likely for dimensions where no dedicated cycle has run (e.g. a domain-specific or product dimension that no subsystem cycle touched and no Verification Block probed).
- Coverage confidence: High (full cycle with verification block) / Medium (cycle summary only, no verification) / Low (inferred from adjacent signals)
- 2–3 sentences of reasoning grounded in specific findings from the cycle inputs, not general impressions
- The single most important finding or unresolved item driving the score
- One concrete action that would most improve this score

Vertical dimensions:
[the project health dimensions are injected here per project]

═══════════════════════════════════════════════════
AXIS B — HORIZONTAL (Bug-Shape Posture)
═══════════════════════════════════════════════════

Score each of the following cross-cutting categories. These measure systemic bug patterns that span subsystems — no single vertical audit owns them. Evidence comes from all subsystem inputs combined, especially the Verification Blocks.

[the project Axis B categories + their "Measured by" definitions are injected here]
For each Axis B category provide:
- Score 1–10
- Trend vs. prior cycle: Improving / Stable / Degrading (or "First measurement" if no prior data)
- 1–2 sentences of key evidence from this cycle's inputs
- One specific action that would improve this category

═══════════════════════════════════════════════════
OUTPUT FORMAT
═══════════════════════════════════════════════════

Produce the following sections in order:

1. TWO-AXIS GRID (this is the primary output):

AXIS A — VERTICAL              Score     Confidence
────────────────────────────────────────────────────
[each dimension]                X/10      High/Med/Low
                                ...or "Not assessed"

AXIS B — HORIZONTAL             Score     Trend
────────────────────────────────────────────────────
[one grid row per Axis B category, injected at render time]

Reading the grid:
- Vertical axis tells you which subsystem to audit next (lowest-scoring assessed dimension).
- Horizontal axis tells you which bug class needs policy intervention (lowest-scoring category, especially if trending down).

2. OVERALL WEIGHTED AVERAGE (secondary signal only — do not use as the primary assessment):
   A single X/10 score. State the weights used. This exists for quick comparison across cycles, not for decision-making.

3. DELTA SUMMARY (if prior score provided):
   Which dimensions improved, declined, or held steady on BOTH axes, and why.

4. PRIORITY CALLS:
- Vertical: the dimension most in need of attention before the next development cycle
- Horizontal: the category most in need of policy intervention
- Any subsystem where the Verification Block signals failed invariants or unresolved Critical/High findings
- Any Axis B category that fires a POLICY TRIGGER this cycle (see section 7) — the trigger is RELATIVE: a category that is DECLINING, not merely one that is low
- The dimension closest to a meaningful threshold (nearly production-ready, or at risk of regression)

5. PLAIN-LANGUAGE SUMMARY:
One paragraph summarizing where the project stands, written for a technical stakeholder who hasn't read the full report.

6. PROJECT_HEALTH.md UPDATE BLOCK:
Produce a ready-to-paste block containing the Current Standing section and a new Cycle entry with both axes formatted for the score history.

7. POLICY RESPONSE TRIGGERS:
The trigger is RELATIVE, not a fixed floor. A fixed floor cannot fire on a healthy project: a category can fall from 9.5 to 7.0 and still sit far above any sensible absolute threshold, so the degradation that matters most goes unpoliced — which is exactly what happened for six cycles in the project this workflow was built on. Read `Policy threshold` and `Consecutive cycles` from the Cycle Workflow Config and compare each Axis B category against its scores in the prior cycles.

A category triggers a mandatory policy response when ANY of these holds:
(a) DECLINE — its score fell in `Consecutive cycles` consecutive cycles, at any magnitude.
(b) SHARP DROP — it fell by 1.5 or more in a SINGLE cycle. This magnitude is deliberately fixed rather than configurable: it is a property of the 10-point scale, not of the project, and it is the clause that catches the fall that matters most — a category dropping 9.0 → 7.0 is in trouble whether or not it drops again next cycle.
(c) PERSISTENT LAGGARD — it has been the lowest-scoring Axis B category for `Consecutive cycles` consecutive cycles AND did not improve in the most recent cycle. A category that is lowest but RECOVERING does not trigger; say so explicitly rather than silently omitting it.
(d) ABSOLUTE FLOOR — it is at or below `Policy threshold`, regardless of trend. This is a backstop for a genuinely broken category, not the primary rule.

Name which clause fired for each triggered category. If no prior score exists for a category (first measurement), it cannot trigger on (a) or (b) — say "First measurement" and check only (c).

For each triggered category, produce a POLICY RESPONSE entry:

---POLICY RESPONSE TRIGGERED---
Category: [Axis B category name]
Trigger clause: [decline | sharp drop | persistent laggard | absolute floor]
Consecutive poor cycles: [N]
Current score: [X/10] | Prior score: [X/10]
Root pattern: [one-sentence description of the systemic pattern causing the persistent low score]

Prescribed policy fix (include in next cycle scope):
- [specific, concrete action — not "improve X" but "add ESLint rule for Y" or "write test for Z"]
- [second action if needed]

Scope addition: Add these policy fixes to the next subsystem cycle's Implementation Handoff Block as mandatory actions alongside the subsystem-specific findings.
---END POLICY RESPONSE---

Use these category-specific playbooks as starting points:

[per-Axis-B-category policy playbooks injected here]
If no categories are triggered, output: "No policy responses triggered this cycle."

8. METRICS (optional — only if the project uses .cycle/ state):
If a .cycle/ directory exists at the project root, append one row to
.cycle/metrics.csv (create it with the header row if absent):
date,cycle,subsystem,phase,net_score,prod_fixes,new_failure_modes,category_d_ratio,axis_b_lowest,notes,defensive_count
Fill phase=synthesis with the Category D ratio from the Verification
Block and axis_b_lowest = the lowest-scoring Axis B category this cycle.
Leave net_score, prod_fixes, new_failure_modes, and defensive_count BLANK
— those columns are owned ONLY by the phase=reflect rows (/reflect is
their sole writer), so a synthesis row must not repeat them or the
cumulative trend double-counts. If .cycle/ does not exist, skip this step.
When you append that row, also set Phase: idle and Updated in
.cycle/STATE.md — a synthesized cycle is closed — but only if STATE.md's
Cycle is the cycle you synthesized. If an audit has already opened a later
cycle, leave Phase alone and say so.
