---
description: "Post-implementation regression check"
---

Read CLAUDE.md before starting. Do not make any changes to any files
during this session, other than the optional STATE.md write in FOLLOW-ON
IDS at the end.

[PASTE SYSTEMS MAP SUMMARY HERE, INCLUDING THE INTER-MODULE DEPENDENCY MAP]
[PASTE IMPLEMENTATION SUMMARY BLOCK FROM THE IMPLEMENTATION SESSION]

Based on the systems map and the changes made:
1. Identify which modules OUTSIDE the changed scope could be affected
2. For each, describe what could break and where to verify (file:area)
3. For each risk, explicitly confirm whether it materialized or was
   negated (cascade configs, zero callers, idempotent ops, existing
   indexes, defaults) — validate, don't just list
4. Confirm the path the tests exercise IS the path that runs in
   production — flag any change that passes via an in-memory / fallback /
   mock path but is broken or untested on the real (e.g. DB-backed)
   production path (Parallel Source-of-Truth Drift)
5. Cross-reference the changes against the invariant library (Cycle
   Workflow Config); flag any invariant at risk, and run its Verify test
   if one is defined
6. If a Deploy Command is configured for a touched subsystem, note which
   risks are git-verified vs. only verifiable after deploy
7. Note any docs (CLAUDE.md / README / roadmap) needing updates

Prioritize the verification list by likelihood of breakage. Then:

---FOLLOW-ON AUDIT ITEMS---
- FO-[cycle]-[n] | [File: function/area] — [what to check, why flagged, which change surfaced it] | → [this cycle | next audit | roadmap | decision | won't do (reason)]
(repeat for each item, or "None")
---END FOLLOW-ON AUDIT ITEMS---

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
