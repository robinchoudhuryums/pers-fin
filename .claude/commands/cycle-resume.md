You are RESUMING an in-progress implementation thread — you are NOT
starting a new audit.

Read .cycle/STATE.md. If it does not exist or shows no in-progress /
pending work, STOP and respond exactly:
"Nothing to resume. Start a fresh audit with /broad-scan or
/targeted-audit <subsystem>."

Also read this substrate (safe to carry forward): CLAUDE.md (Cycle
Workflow Config, Common Gotchas, systems map if present) and the
invariant library.

TWO MEMORY CHANNELS — observe the boundary:
- Carry forward FACTS + SUBSTRATE: what was changed, what is pending,
  decisions already made, the systems map, invariants, gotchas.
- Do NOT treat the prior session's findings or severity judgments as
  authoritative. You are continuing agreed work, not re-auditing. If
  you notice something that looks like a new finding outside the
  pending work, record it as a follow-on item — do not expand scope.

Continue the pending actions listed in STATE.md, in order, under the
same scope discipline as /implement:
- Implement only the pending actions. Stop on unexpected complexity and
  describe before continuing. Check Common Gotchas before each action.
- After each action, update .cycle/STATE.md (move the item from Pending
  to Completed, refresh "Where I left off").

When pending work is complete (or you must stop), update
.cycle/STATE.md, run the test step per CLAUDE.md's Test Command (or walk
the Regression Scenarios if `manual`), then emit the same
implementation summary block the original implement command would have.
Suggest /regression, /reflect, /test-sync, and /sync-docs as applicable.
