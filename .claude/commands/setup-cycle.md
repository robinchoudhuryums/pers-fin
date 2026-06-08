Do not make any changes to any files during this session.

You are setting up the cycle workflow configuration for this project.
This is the foundation for all future audit, implementation, and
verification work — accuracy here compounds across every cycle.

Run the following five phases in order. Complete each fully before
starting the next.

═══════════════════════════════════════════
PHASE 1 — FOUNDATION READ
═══════════════════════════════════════════

Read these files carefully in this order:
1. CLAUDE.md (entire file — especially Common Gotchas, Key Design
   Decisions, Systems Map if present, Operator State Checklist if present)
   If CLAUDE.md does not exist yet (greenfield project), skip this step
   and note that Common Gotchas and invariants will be populated after
   the first audit cycle.
2. README
3. Package manifest (package.json, pyproject.toml, Cargo.toml, etc.)
4. All entry points (server/index.ts, client main, route registration)
5. Database schema files
6. Test configuration and existing test files (scan for patterns).
   If no programmatic test runner exists (no test command in the
   manifest, no test framework dependency, no test files), note this —
   OUTPUT 1 will use `Test Command: manual` and require a
   `Regression Scenarios` block.
7. Deployment mechanism (look for clasp config, terraform/ directory,
   .github/workflows/deploy.*, fly.toml, vercel.json, Dockerfile +
   deploy script, fastlane config, etc.). For each detected deployable,
   identify the command and the subsystem it deploys. If found, OUTPUT 1
   will include a `Deploy Command` section.

Produce a PROJECT PROFILE:
- Project type and domain: [what this application does, who uses it]
- Tech stack: [languages, frameworks, databases, external services]
- Approximate size: [file count, estimated lines]
- Maturity indicators: [test coverage breadth, CI config, documentation quality,
  error handling patterns, logging patterns]
- External dependencies: [APIs, databases, cloud services, SDKs]
- Multi-tenant: [yes/no — how is data isolated?]
- Key architectural patterns: [monolith/microservices, storage abstraction,
  auth model, job queue, real-time, etc.]

═══════════════════════════════════════════
PHASE 2 — MODULE & DEPENDENCY ANALYSIS
═══════════════════════════════════════════

For every directory that contains source code:
1. List all files with a one-line description of each file's responsibility
2. For the 10-15 most important files (entry points, high-fan-out modules,
   core business logic): trace their imports and identify which other
   files depend on them

Produce:
HIGH-FAN-OUT MODULES (most imported — changes here have widest blast radius):
[Module] | [Key exports] | [Consumer count] | [Notes]

NATURAL COUPLING CLUSTERS:
Identify groups of files that import heavily from each other but have
fewer connections to files outside the group. These are candidate
subsystem boundaries. For each cluster:
- [Cluster name] | [Files] | [Internal coupling evidence] | [External connections]

═══════════════════════════════════════════
PHASE 3 — SUBSYSTEM BOUNDARY PROPOSAL
═══════════════════════════════════════════

Using the coupling clusters from Phase 2, propose subsystem groupings.

For each proposed subsystem:
- Name: [clear, descriptive name]
- Files: [complete comma-separated file list]
- Responsibility: [one sentence — what this subsystem does]
- Session feasibility: [estimated file count and total lines — can this
  be deeply audited in one Claude Code session?]
- Key risk: [what's the worst thing that can go wrong in this subsystem?]

Quality checks — verify all of these before proceeding:
□ Every source file in the project is assigned to exactly one subsystem
□ No subsystem has so many files that it can't be audited in one session
  (rough guide: <20 files or <5000 lines for deep reading)
□ Files within each subsystem are more tightly coupled to each other
  than to files in other subsystems
□ The boundaries correspond to natural seams, not arbitrary directory splits
□ High-fan-out modules are in the subsystem that owns their primary concern

If any check fails, adjust the groupings and explain the tradeoff.

Flag SEAM FILES — files that sit at the boundary between subsystems
and could reasonably belong to either.

Flag FROZEN SUBSYSTEM CANDIDATES — subsystems that are explicitly
legacy / being retired / being migrated out (e.g., a deprecated
module kept only until a successor is fully built). For each
candidate, note: (a) why it's frozen, (b) what's replacing it,
(c) what conditions would unfreeze it. These appear in OUTPUT 1's
Frozen Subsystems section.

═══════════════════════════════════════════
PHASE 4 — HEALTH DIMENSIONS & POLICY
═══════════════════════════════════════════

Propose health dimensions for this project's scoring. These should:
- Reflect what actually matters for THIS project's domain and users
- Be scorable with evidence from code reads
- Cover both technical health and feature/product effectiveness
- Include domain-specific dimensions
- Be between 10-15 dimensions total

For each dimension:
- Name
- What it measures (one sentence)
- Which subsystem(s) primarily feed evidence into this score

Also recommend:
- Policy threshold: [score ≤ N triggers policy response]
- Consecutive cycles before trigger: [typically 2]

Also propose the project's HORIZONTAL (Axis B) bug-shape categories —
cross-cutting failure patterns that no single subsystem owns, scored in
Health Synthesis alongside the vertical dimensions. The default set fits
most server/SaaS projects: Silent Degradation Posture, Startup Ordering
Guarantees, Operator-Only State Gaps, Parallel Source-of-Truth Drift,
Test Coverage Quality. Keep these unless the domain calls for different
shapes (e.g. a data pipeline might add "Numerical / Precision Drift," a
mobile app "Offline / Sync Integrity," a library "Public API
Compatibility"). Aim for 4–6 categories, each with a name + one-sentence
"what it measures."

═══════════════════════════════════════════
PHASE 5 — INVARIANT EXTRACTION
═══════════════════════════════════════════

Extract initial invariants from the project's documentation and code.
Each invariant must be:
- Specific enough to be pass/fail (not "auth should be secure")
- Verifiable by code read or targeted test execution
- High-consequence if violated

Sources to mine (in priority order):
1. Common Gotchas section of CLAUDE.md
2. Key Design Decisions — each implies a contract
3. Operator State Checklist (if present)
4. Critical code patterns observed in Phase 2

For each invariant:
- ID: INV-XX
- Rule: [one clear sentence]
- Subsystem: [which subsystem]
- How to verify: [code read / specific test / assertion]
- Source: [which gotcha, decision, or pattern]

Aim for 15-25 invariants.

═══════════════════════════════════════════
OUTPUT — PROJECT CONFIGURATION
═══════════════════════════════════════════

Produce two outputs:

OUTPUT 1 — CYCLE WORKFLOW CONFIG (paste into the project's CLAUDE.md):

## Cycle Workflow Config

### Test Command
[test runner command, e.g. npm test — OR the literal word `manual`
 for projects with no programmatic test runner]

### Health Dimensions
[dim1], [dim2], [dim3], ...

### Horizontal (Axis B) Categories   ← optional; defaults to the standard 5 if omitted
[Category name] | [what it measures]
(repeat for each, 4–6 total)

### Subsystems
[Subsystem Name]:
  [comma-separated file list]
(repeat for each subsystem)

### Invariant Library
INV-XX | [rule text] | Subsystem: [name] | Verify: [test name or code ref — optional]
(repeat for each invariant; carry the Phase 5 "How to verify" detail into
 the optional Verify field when it names a concrete test or assertion)

### Policy Configuration
Policy threshold: [N]/10
Consecutive cycles: [N]

### Seams Audit Cadence   ← optional; default: every 4 subsystem cycles
every [N] subsystem cycles

### Regression Scenarios   ← required iff Test Command is `manual`; otherwise optional
S1 | [short scenario name] | Subsystem: [name]
  Steps:
    - [step]
    - [step]
  Expected: [outcome]
(repeat for each scenario; aim for 5–15 covering golden paths and known regression hotspots)

### Frozen Subsystems   ← optional; omit if no subsystems are frozen
- [subsystem name] — [reason: why frozen, what's replacing it, what would unfreeze it]
(repeat for each frozen subsystem)

### Deploy Command   ← optional; per-subsystem mapping; omit if project has no deploy step
[subsystem name]: [command + any context, e.g. "clasp push -f then Apps Script editor → Deploy → New version"]
[subsystem name]: [command + any context]
(repeat for each subsystem with a deploy command)

OUTPUT 2 — CYCLE ROTATION PLAN (for operator reference):

Recommended first subsystem to audit: [name — why]
Recommended cycle order: [ordered list with rationale — exclude
  any subsystems marked frozen; note that they are skipped by
  default but can be explicitly named to override]
Seams audit frequency: every [N] subsystem cycles

CONFIDENCE ASSESSMENT:
For each subsystem, rate confidence that file list is complete
and boundary is correct: High / Medium / Low.
