# PROJECT_HEALTH.md — Cycle Health Standing

Living record of the project's health across audit/implement cycles. Updated by
the Health Synthesis step at the end of each cycle. Read by `/cycle-status`.

- **Scoring:** each dimension 1–10 (evidence-based from code reads + test runs).
  Higher = healthier. A score is only recorded when a cycle gathers evidence for
  that dimension; dimensions not touched in a cycle keep their prior value (with
  the cycle they were last scored noted).
- **Policy:** a dimension at **≤ 6/10 for 2 consecutive cycles** triggers a
  policy response (prioritized remediation before new feature work in that area).
- **Axes:** *Axis A* = the 15 vertical health dimensions (per-subsystem concerns;
  Knowledge Retrieval & Grounding added in cycle 3 to match the Cycle Workflow
  Config's Health Dimensions). *Axis B* = 6 cross-cutting failure shapes scored
  alongside them.

---

## Current Standing

**Cycle 3 synthesis (2026-06-09)** — first full Health Synthesis, after a
whole-rotation cycle (broad-scan + 8 targeted subsystem audits + 1 seams audit,
all audited→implemented). Scores below are evidence-based from deep code reads
across every non-frozen subsystem this cycle.

- Cycles completed: **3** (cycle 1 Bank Sync, cycle 2 Financial Analytics, cycle 3 full rotation)
- Last cycle: **3 / 2026-06-09 — all non-frozen subsystems**
- Axis-A: **min 7 · mean ≈ 8.1** (15 dimensions, incl. Knowledge Retrieval & Grounding)
- Axis-B: **min 7 · mean ≈ 7.8**
- Policy flags active: **none** — no dimension scored ≤ 6 this cycle (Financial Data Accuracy would have been ~6 pre-H1 but is 8 post-fix). Policy needs ≤6 for 2 consecutive cycles; this is the first scored synthesis.
- Tests: **648 → 764** passing (24 files, `npm test`)
- Reflect (cycle 3): net **+4** (5 production fixes − 1 guarded new failure mode); 11 candidate invariants INV-37…47 awaiting promotion.

---

## Axis A — Health Dimensions (1–10)

| # | Dimension | What it measures | Primary subsystem(s) | Score | Last scored |
|---|-----------|------------------|----------------------|:-----:|:-----------:|
| 1 | Financial Data Accuracy | Money figures match source data end-to-end | Financial Analytics, Bank Sync | **8** | 3 |
| 2 | Sync Integrity & Idempotency | Re-syncs don't dup/drop; watermarks/cursors safe | Bank Sync & Ingestion | **9** | 3 |
| 3 | Income/Spending Classification | Correct income vs spending vs transfer split | Financial Analytics, Detection | **8** | 3 |
| 4 | AI Output Trustworthiness | Insights audited; hallucinations caught; cap enforced | AI Insights & Audit | **8** | 3 |
| 5 | Auth & Session Security | PIN gate, idle window, API-key path, redirects | Platform, Shell & Auth | **9** | 3 |
| 6 | Secret & Token Handling | Encryption at rest; mismatch surfaces, not silent | Platform, Shell & Auth | **8** | 3 |
| 7 | Scheduler Reliability | Cron tasks fire in-process, in order, idempotent | Platform, Shell & Auth | **8** | 3 |
| 8 | Data Freshness & Reconciliation | Staleness surfaced; reconcile recovers drops | Bank Sync, Settings/Notif | **9** | 3 |
| 9 | Migration Safety | Transactional, fatal-on-failure, idempotent | Platform, Shell & Auth | **9** | 3 |
| 10 | Notification Correctness | Right alerts, no spam, logged as audit trail | Settings, Notifications & Cross-app | **8** | 3 |
| 11 | Cross-app Integration Integrity | Pool-wiring/webhooks/SSO behave embedded + standalone | Settings/Notif/Cross-app, Per-sistant Backend | **8** | 3 |
| 12 | UI/UX & Accessibility | Responsive, a11y, CSP, mobile nav/tables | Web UI (Perfin), Per-sistant Web UI | **7** | 3 |
| 13 | External Export Fidelity | Sheets/Apps Script mirror DB without drift | Sheets & External Export | **7** | 3 |
| 14 | Test Coverage Quality | Tests fail when the code under test regresses | (all) | **7** | 3 |
| 15 | Knowledge Retrieval & Grounding | Privacy tiers, citations, grounding, defensive pgvector | Knowledge / RAG (Per-sistant) | **8** | 3 |

## Axis B — Horizontal Failure Shapes (1–10)

| Category | What it measures | Score | Last scored |
|----------|------------------|:-----:|:-----------:|
| Silent Degradation Posture | Failures that swallow errors and look like success | **7** | 3 |
| Startup Ordering Guarantees | Migrations/cron/pool-wiring race or run out of order | **9** | 3 |
| Operator-Only State Gaps | Undocumented manual setup (PEMs, passphrase, env vars) | **8** | 3 |
| Parallel Source-of-Truth Drift | SPLIT_AMOUNT/INCOME_PREDICATE copies diverging across files | **8** | 3 |
| Money / Precision Drift | NUMERIC rounding, split-sum ±$0.01, parseMoney edges | **8** | 3 |
| Test Coverage Quality | Tests that pass regardless of the code under test | **7** | 3 |

---

## Score History

One row per completed cycle (newest first). Detailed per-finding data lives in
`.cycle/metrics.csv`; in-flight work lives in `.cycle/STATE.md`.

| Cycle | Date | Subsystem audited | Axis-A min / mean | Axis-B min | Findings (C/H/M/L) | Fixed | Tests after | Policy |
|-------|------|-------------------|-------------------|-----------|--------------------|-------|-------------|--------|
| 3 | 2026-06-09 | All non-frozen (broad + 8 targeted + seams) | 7 / 8.1 | 7 | 0 / 1 / ~5 / ~24 | ~30 | 764 | none |

---

## Cycle 3 synthesis notes (score rationale)

Strong overall (mean ≈ 8.1 / 7.8). The three Axis-A 7s and two Axis-B 7s are the
drags to probe next cycle:

- **UI/UX & Accessibility (7):** Perfin is nonce-CSP + escaping-clean; the cap is
  the standing Per-sistant `script-src 'unsafe-inline'` gap (PB-3) — escaping
  (renderMd + new `escAttr` + the `scriptSrcAttr:'none'` pin) is the backstop, but
  the real fix (per-request nonce migration to drop `'unsafe-inline'`) is deferred
  (L). Lifts to ~9 when PB-3 closes.
- **External Export Fidelity (7):** Sheets per-category now matches the app
  (M3/M4) and the inlined SQL copies are pinned (SX3, INV-45). Cap is the stale
  standalone `apps-script/Code.gs` fork (row-index dedup ID, filename detection,
  loose WF) — deferred; recommend deprecating its standalone CSV path.
- **Test Coverage Quality (7) / Axis-B mirror (7):** 764 tests, behavioral +
  source-pinned, and the one wrong-invariant pin (F1 dedup direction) was
  corrected. Cap: `auditInsight`'s full Tier-1 flow has no behavioral (mock-pool)
  test — only the pure extractors + the new `CROSS_PERIOD_RE` classification.
- **Silent Degradation Posture (Axis-B 7):** the cycle's recurring theme — most
  findings were swallowed-error / narrow-trigger silent paths (M2 cap escape, M5
  rollover, K2 notification-disable, AIA1 audit). Many fixed; the accepted
  residual is the documented "schema-drift safe → silent null" cross-app reads
  (SEAM-2/INV-35) and pervasive `.catch(()=>{})` that degrades gracefully.

**New failure mode this cycle (1, Medium, guarded):** PSB1 set Per-sistant's DB
`rejectUnauthorized: true` — introduces a deploy-time boot risk if Neon's cert
weren't in Node's trust store; mitigated by Perfin's working precedent + the
post-deploy connectivity check. Confirm on the next deploy.

**Pending:** promote INV-37…47 into CLAUDE.md's Invariant Library; a Seams &
Invariants audit is DUE (5 subsystem cycles since the last one).

## Notes / Standing Decisions
- Single-operator app: the only attacker is the operator; threat model weights
  correctness and data integrity over multi-tenant isolation.
- Frozen subsystems excluded from rotation: `plaid/server.js` (legacy standalone),
  `n8n-workflows/*.json` (superseded by in-process schedulers).
