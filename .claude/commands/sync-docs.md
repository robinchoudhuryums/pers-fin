Read CLAUDE.md and README before starting.

[PASTE THE IMPLEMENTATION SUMMARY / recent changes, if available]

Detect (and, with approval, fix) documentation drift via four checks:
1. CLAUDE.md currency — are listed Known Issues / Common Gotchas still
   true? Remove or update resolved ones; add new gotchas this cycle
   surfaced.
2. Subsystem file-reference currency — do the file lists in the Cycle
   Workflow Config Subsystems section still match the tree? Flag moved /
   renamed / deleted paths.
3. Operator state inventory — any new manual setup (env vars, one-time
   migrations, deploy steps) that isn't documented? Add it.
4. Implementation drift — do recent changes match what the docs / README
   describe? Reconcile.

Produce a list of proposed doc edits (file → what changes and why), then
ask for approval before writing any files.
