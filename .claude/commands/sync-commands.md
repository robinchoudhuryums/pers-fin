If $ARGUMENTS is empty or missing, respond with exactly this and stop:

Usage: /sync-commands <path-or-url-to-workflow-tools-repo>
Example: /sync-commands ../claude-workflow-tools
Example: /sync-commands ~/projects/claude-workflow-tools
Example: /sync-commands https://github.com/user/claude-workflow-tools

Accepts either a local filesystem path or a GitHub repository URL.

This command syncs your project's .claude/commands/ files with the
latest templates from the workflow tools repo.

---

Do not make any changes to any files until the comparison is complete.

You are syncing this project's command files with the latest templates.

Step 1: Read the template CLAUDE.md.
If $ARGUMENTS is a local path: read $ARGUMENTS/CLAUDE.md directly.
If $ARGUMENTS is a URL: fetch the raw CLAUDE.md from the repository
  (e.g. https://raw.githubusercontent.com/.../main/CLAUDE.md).
If neither works, stop and report the error.
Step 2: Read all command files in this project's .claude/commands/
Step 3: For each command file, compare against the corresponding
template in the workflow tools CLAUDE.md.

For each command, report:
- CURRENT: matches template (no action needed)
- OUTDATED: template has structural changes not in this version
  [list specific differences — new steps, changed instructions,
  added output sections, modified classification categories]
- MISSING: template exists but this project has no command file for it

Step 4: Verify this project's CLAUDE.md has a "Cycle Workflow Config"
section with: Test Command, Health Dimensions, Subsystems, Invariant
Library, and Policy Configuration. Flag any missing sections.

Additionally:
- If Test Command is `manual`, verify a `Regression Scenarios`
  section exists and is non-empty. Flag as a config error if missing.
- If Test Command is a real command (e.g., `npm test`), `Regression
  Scenarios` is optional. If present, note that it augments
  programmatic test runs — commands walk scenarios after tests pass.
- If a `Frozen Subsystems` section exists, verify each listed name
  matches a subsystem in the `Subsystems` section. Flag any mismatches
  as warnings (the reference is broken).
- If a `Deploy Command` section exists, verify each subsystem name
  on the left side of the mapping matches a subsystem in the
  `Subsystems` section. Flag any mismatches as warnings.

Step 5: For each OUTDATED command, produce the updated file content.
The commands are project-agnostic (they reference CLAUDE.md config,
not inline project-specific content), so the update is a direct copy
from the template — no merging needed.

After the comparison, ask for approval before writing any files.
