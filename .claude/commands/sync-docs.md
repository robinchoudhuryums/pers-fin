Four-check documentation drift detection. Do not make changes until all checks are complete and you've reported findings.

Read CLAUDE.md, README, and any other project documentation before starting.

═══════════════════════════════════════════ CHECK 1 — CLAUDE.md CURRENCY ═══════════════════════════════════════════

For each section of CLAUDE.md:

Are known issues listed that have been fixed? (stale gotchas)
Are there recent changes not reflected in the documentation?
Do the Key Design Decisions still match the actual implementation?
Is the Recent Changes section up to date?
Are file paths and line references still accurate?
═══════════════════════════════════════════ CHECK 2 — SUBSYSTEM FILE REFERENCE CURRENCY ═══════════════════════════════════════════

For each subsystem:

Do all listed files still exist at those paths?
Are there new files that should be added to a subsystem?
Have any files been moved, renamed, or deleted?
═══════════════════════════════════════════ CHECK 3 — OPERATOR STATE INVENTORY ═══════════════════════════════════════════

Scan for undocumented manual setup requirements:

Environment variables referenced in code but not in docs
Configuration files required but not mentioned
External service dependencies not documented
Manual migration steps needed but not listed
═══════════════════════════════════════════ CHECK 4 — IMPLEMENTATION DRIFT ═══════════════════════════════════════════

For recent implementation changes (last 1-2 cycles):

Do the changes match what CLAUDE.md says the code does?
Are there new patterns or conventions introduced that should be documented as Key Design Decisions?
Have any API endpoints changed that aren't reflected in docs?
═══════════════════════════════════════════ REPORT ═══════════════════════════════════════════

For each check, list findings as:

[CHECK N] [File: section] — [what's wrong] — [suggested fix]
Organize by priority:

Actively misleading (docs say X, code does Y) — fix immediately
Missing (undocumented but should be) — add this cycle
Stale (no longer relevant) — remove or update
After I review the findings, I will tell you which to implement. Do not make changes until then.
