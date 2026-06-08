Read CLAUDE.md before starting. Do not make any changes to any files
during this session.

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
- [File: function/area] — [what to check, why flagged, which change surfaced it]
(repeat for each item, or "None")
---END FOLLOW-ON AUDIT ITEMS---
