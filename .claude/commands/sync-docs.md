---
description: "Detect and fix documentation drift, roadmap currency included; propose promoting invariant candidates to the library"
---

Read CLAUDE.md and README before starting.

[PASTE THE IMPLEMENTATION SUMMARY / recent changes, if available]

Detect (and, with approval, fix) documentation drift via six checks:
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
5. Invariant candidates — has /reflect, a Verification Pass or a Seams
   audit proposed rules (pasted, or under .cycle/blocks/ where the project
   keeps one) that are not in the Invariant Library? Propose adding each
   under the ID it was given, with its Subsystem and a Verify field; if the
   library already uses that ID, give the candidate the next free number
   and say so. A candidate the operator declines is dropped and its number
   is not reused.
6. Roadmap currency — if the project keeps a roadmap (ROADMAP.md, or the
   file its docs name), does each item's status still match the code and
   the changelog? Flag an item that shipped and is not marked done, one
   marked in progress or queued for a cycle that has already run, and a
   stated top priority that names finished work. Propose the status edits.
   Choosing the next priority is the operator's decision: say that the
   stated one is spent and ask, do not pick one.

Produce a list of proposed doc edits (file → what changes and why), then
ask for approval before writing any files.
