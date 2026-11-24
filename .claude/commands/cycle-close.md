---
description: "Confirm what the cycle still owes, roll its record into .cycle/HISTORY.md, return the phase to idle"
---

Close the current cycle: confirm what it still owes, then roll its record
into history and return the phase to idle. Run it after /reflect — and, in
a project that verifies and synthesizes, after /verify and
/health-synthesis.

Read .cycle/STATE.md. If it does not exist, respond exactly:
"Nothing to close — this project keeps no .cycle/ state."
and stop.

1. CHECK (read-only). From STATE.md, the metrics file and this cycle's
   blocks (the files in the blocks directory whose names start with the
   cycle number), report each line as DONE, OWED or NOT USED BY THIS
   PROJECT:
   - Reflected — a phase=reflect row for this cycle
   - Verified — a …-verification.md block for this cycle
   - Synthesized — a phase=synthesis row for this cycle
   - Invariant candidates — every candidate in this cycle's reflect,
     verification and seams blocks is in the Invariant Library, was
     declined, or is held with a stated reason
   - Operator actions — any "BLOCKS DEPLOY: Y" line in this cycle's
     blocks that nothing records as done
   - Follow-on items — every line under "Open follow-on items" in STATE.md
     carries an FO ID and a disposition; any marked "this cycle" is OWED,
     because the cycle it names is closing
   - Seams audit — DUE if "Subsystem cycles since last Seams audit" has
     reached the Seams Audit Cadence
   NOT USED applies to Verified and Synthesized only, and only when the
   metrics file has no phase=synthesis row for ANY cycle: that project
   does not synthesize.
2. DECIDE.
   - Phase is audit or implement, or the cycle has no reflect row: STOP.
     The cycle is not closable; name the command that comes next
     (/cycle-resume, the implement command for its tier, or /reflect).
   - Phase is already idle and nothing is left to roll: say so and stop.
   - Verified or Synthesized is OWED: say so and ask whether to close
     anyway. If the operator closes anyway, the history entry says the
     cycle closed unverified.
   - Candidates or operator actions that are OWED do not block the close:
     list them, and keep them under Pending in step 3.
   - Follow-on items that are OWED do not block it either: ask the
     operator for a new disposition for each (next audit, roadmap,
     decision, or won't do with a reason), and give any line with no ID or
     disposition both now.
3. CLOSE (optional — only if .cycle/ exists). Update .cycle/STATE.md and
   .cycle/HISTORY.md together:
   - move the "In progress" and "Completed this cycle" entries to
     .cycle/HISTORY.md under a heading naming the cycle and today's date,
     newest cycle first (create the file if needed), with one line giving
     the cycle's net score from its reflect row(s) and whether it was
     verified and synthesized;
   - keep every pending item, follow-on and decision that is still live,
     and drop the ones this cycle finished; a follow-on closed as won't do
     moves to .cycle/HISTORY.md with its reason;
   - set Phase: idle, Scope to "—" and Updated to today's date. Leave
     Cycle alone — the next audit's CYCLE OPEN step increments it;
   - rewrite "Where I left off" to name the next action: an owed /verify
     or /health-synthesis, a DUE Seams audit, or a fresh audit.
   Never delete a block, and do not edit the metrics file.

Report what was moved, what was kept, and the next action in one line.
