Read CLAUDE.md and README before starting. Do not make any changes to any
files during this session. Do not run audits or recommendations — this
session only maps architecture.

Produce a systems map in five phases:
1. ENTRY POINTS & STRUCTURE — server/client entry points, route
   registration, build/deploy entry, top-level directory roles
2. MODULE IDENTIFICATION — each module's responsibility and its startup
   assumptions (env vars, init order, singletons)
3. DATA FLOW — trace 3 critical paths end to end (e.g. a request, a job,
   an auth flow); note where data is transformed and persisted
4. DEPENDENCY MAP — high-fan-out modules and what depends on them;
   inter-module dependencies (this is the input to the §4 dependency check)
5. CROSS-REFERENCE VALIDATION — reconcile the map against the Subsystems
   section of CLAUDE.md's Cycle Workflow Config; flag mismatches

End with a 3–5 bullet SYSTEMS MAP SUMMARY suitable for pasting into
audit/plan/implement sessions, plus the inter-module dependency map.
