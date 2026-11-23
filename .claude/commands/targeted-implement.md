---
description: "Implement from the Tier 2 handoff block"
argument-hint: "[paste the TIER 2 HANDOFF BLOCK first if it is not in this session]"
---

If $ARGUMENTS is empty or missing AND no TIER 2 HANDOFF BLOCK exists
earlier in this session or in an audit report file
(.cycle/blocks/<cycle>-targeted-audit-<subsystem>.md) for the current
cycle, respond with exactly this and stop:

Usage (same session): /targeted-implement — run after /targeted-audit
Usage (new session): Paste the TIER 2 HANDOFF BLOCK first, then run

---

Read CLAUDE.md (especially Common Gotchas) before starting.

You are implementing the actions from the TIER 2 HANDOFF BLOCK above. If
it is not in this session, read it from the newest report file
.cycle/blocks/<cycle>-targeted-audit-<subsystem>.md for the subsystem
$ARGUMENTS names (or the only one this cycle), and say which file you
used.

Rules:
- Implement ONLY the actions in the handoff block, in order
- Do not fix anything outside scope — note for follow-on
- Stop on unexpected complexity and describe before continuing
- Stop if touching DO NOT TOUCH files or out-of-scope files
- Check Common Gotchas before each action
- Before editing a module, scan for its test doubles — mocks/stubs/fixtures
  of that module, especially ones encoding the OLD behavior; update them as
  part of the action, not reactively in the test step

After all actions complete:

1. RUN TESTS — read the Test Command from CLAUDE.md's Cycle Workflow Config.
   - If it is `manual`: walk every Regression Scenario whose Subsystem
     overlaps a file you modified, and record PASS / FAIL / NOT APPLICABLE
     (with the reason for NOT APPLICABLE). A FAIL counts as a test failure.
   - Otherwise: run the suite (the Test Command, or `npm test` if none is
     set), then walk any configured Regression Scenarios.
   Classify each failure: caused by this session (fix now) / pre-existing
   (note, don't fix) / a real production bug exposed by a correct test or
   scenario (flag as a follow-on, don't fix here).
2. REGRESSION CHECK — review each modified file for breakage risk,
   cross-reference CROSS-MODULE RISKS from handoff block
3. REFLECT — for each action: production bug? (YES/NO) New failure
   mode? (YES/NO). Tally net score.
4. INVARIANT CHECK — cross-reference against project invariant library
5. INVARIANT CANDIDATES — new rules from this session's changes
6. SUMMARY — produce TARGETED IMPLEMENTATION SUMMARY:

---TARGETED IMPLEMENTATION SUMMARY---
Scope: [subsystem]
Actions completed: [list IDs]
Actions not completed: [list with reason, or "All completed"]
Files modified: [list]

CHANGES:
[Action ID] | [File(s)] | [What changed] | [Findings addressed]

TEST RESULTS: [passed/failed]
REGRESSION RISKS: [risks or "None"]
INVARIANTS AT RISK: [any or "None"]
NET SCORE: [production fixes] − [new failure modes] = [net]
INVARIANT CANDIDATES: [new rules or "None"]

OPERATOR ACTIONS / DEPLOY:
- [human-only step outside the PR — env var, IaC, console/dashboard, one-time migration] | BLOCKS DEPLOY: Y/N
(repeat per action, or "None")
Deploy: [Deploy Command for the touched subsystem if configured, else
"N/A — no Deploy Command configured"]

(Not complete in production until blocking operator actions are done AND
the deploy step is confirmed.)

FOLLOW-ON ITEMS:
- FO-[cycle]-[n] | [File: area] — [what to check and why] | → [this cycle | next audit | roadmap | decision | won't do (reason)]
(or "None")

DOCUMENTATION UPDATES NEEDED:
- [updates or "None"]
---END TARGETED IMPLEMENTATION SUMMARY---

FOLLOW-ON IDS (every follow-on item this session reports): number each
FO-<cycle>-<n>, with <cycle> from .cycle/STATE.md's Cycle field and <n> one
above the highest FO number already used for that cycle in STATE.md and
.cycle/blocks/ (FO-<n> if the project keeps no .cycle/). Give each exactly
one disposition:
- this cycle — a later implement session takes it by its ID
- next audit — the next audit whose scope covers it re-checks it, as a
  lead and not as a finding
- roadmap — too large for one session; /sync-docs proposes a roadmap item
- decision — only the operator can settle it; name the choice
- won't do (reason) — closed now, and the reason is the record
"Noted" is not a disposition. Only if a .cycle/ directory exists: add
every item that is not "won't do" to the "Open follow-on items" in .cycle/STATE.md, one
line each with its ID and disposition, and remove each open item this
session finished or closed — including one marked "confirmed as" a
finding this session implemented.

7. CHECKPOINT (optional — only if the project uses .cycle/ state)
If a .cycle/ directory exists at the project root, create or update
.cycle/STATE.md to reflect this session: completed actions, any actions
not finished, open follow-on items, decisions made, and a "Where I left
off" line. This lets /cycle-resume continue cleanly in a fresh session
if context runs out. Set Phase: implement; leave Cycle exactly as the
audit's CYCLE OPEN step set it — implement sessions never increment it.
If .cycle/ does not exist, skip this step.
If STATE.md's sections still describe an EARLIER cycle (its Scope line
says so), this is the new cycle's first checkpoint: move the old "In
progress" and "Completed this cycle" entries to .cycle/HISTORY.md under a
heading naming that cycle (create the file if needed), keep any pending
item, follow-on or decision that is still live, and drop the note from
the Scope line.

ALSO write the summary block VERBATIM to
.cycle/blocks/<cycle>-<version-or-scope>-targeted-implement.md (create the
directory if needed) — §4v and §6a read these in a fresh session.
Never overwrite a block: if that name is taken (a second batch under the
same version or scope), add the batch number before the command name —
<cycle>-<version-or-scope>-2-targeted-implement.md.

Suggest /test-sync and /sync-docs if applicable.
