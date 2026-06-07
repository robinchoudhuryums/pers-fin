# PROJECT_HEALTH.md — Cycle Health Standing

Living record of the project's health across audit/implement cycles. Updated by
the Health Synthesis step at the end of each cycle. Read by `/cycle-status`.

- **Scoring:** each dimension 1–10 (evidence-based from code reads + test runs).
  Higher = healthier. A score is only recorded when a cycle gathers evidence for
  that dimension; dimensions not touched in a cycle keep their prior value (with
  the cycle they were last scored noted).
- **Policy:** a dimension at **≤ 6/10 for 2 consecutive cycles** triggers a
  policy response (prioritized remediation before new feature work in that area).
- **Axes:** *Axis A* = the 14 vertical health dimensions (per-subsystem concerns).
  *Axis B* = 6 cross-cutting failure shapes scored alongside them.

---

## Current Standing

**No synthesis recorded yet.** Cycle config is established and validated
(see CLAUDE.md → Cycle Workflow Config; validated read-only on 2026-06-07).
The first `/broad-scan` or `/targeted-audit` will populate the scores below.

- Cycles completed: **0**
- Last cycle: **—**
- Policy flags active: **none**
- Test baseline at scaffold time: **648 passing** (17 files, `npm test`)

---

## Axis A — Health Dimensions (1–10)

| # | Dimension | What it measures | Primary subsystem(s) | Score | Last scored |
|---|-----------|------------------|----------------------|:-----:|:-----------:|
| 1 | Financial Data Accuracy | Money figures match source data end-to-end | Financial Analytics, Bank Sync | — | — |
| 2 | Sync Integrity & Idempotency | Re-syncs don't dup/drop; watermarks/cursors safe | Bank Sync & Ingestion | — | — |
| 3 | Income/Spending Classification | Correct income vs spending vs transfer split | Financial Analytics, Detection | — | — |
| 4 | AI Output Trustworthiness | Insights audited; hallucinations caught; cap enforced | AI Insights & Audit | — | — |
| 5 | Auth & Session Security | PIN gate, idle window, API-key path, redirects | Platform, Shell & Auth | — | — |
| 6 | Secret & Token Handling | Encryption at rest; mismatch surfaces, not silent | Platform, Shell & Auth | — | — |
| 7 | Scheduler Reliability | Cron tasks fire in-process, in order, idempotent | Platform, Shell & Auth | — | — |
| 8 | Data Freshness & Reconciliation | Staleness surfaced; reconcile recovers drops | Bank Sync, Settings/Notif | — | — |
| 9 | Migration Safety | Transactional, fatal-on-failure, idempotent | Platform, Shell & Auth | — | — |
| 10 | Notification Correctness | Right alerts, no spam, logged as audit trail | Settings, Notifications & Cross-app | — | — |
| 11 | Cross-app Integration Integrity | Pool-wiring/webhooks/SSO behave embedded + standalone | Settings/Notif/Cross-app, Per-sistant Backend | — | — |
| 12 | UI/UX & Accessibility | Responsive, a11y, CSP, mobile nav/tables | Web UI (Perfin), Per-sistant Web UI | — | — |
| 13 | External Export Fidelity | Sheets/Apps Script mirror DB without drift | Sheets & External Export | — | — |
| 14 | Test Coverage Quality | Tests fail when the code under test regresses | (all) | — | — |

## Axis B — Horizontal Failure Shapes (1–10)

| Category | What it measures | Score | Last scored |
|----------|------------------|:-----:|:-----------:|
| Silent Degradation Posture | Failures that swallow errors and look like success | — | — |
| Startup Ordering Guarantees | Migrations/cron/pool-wiring race or run out of order | — | — |
| Operator-Only State Gaps | Undocumented manual setup (PEMs, passphrase, env vars) | — | — |
| Parallel Source-of-Truth Drift | SPLIT_AMOUNT/INCOME_PREDICATE copies diverging across files | — | — |
| Money / Precision Drift | NUMERIC rounding, split-sum ±$0.01, parseMoney edges | — | — |
| Test Coverage Quality | Tests that pass regardless of the code under test | — | — |

---

## Score History

One row per completed cycle (newest first). Detailed per-finding data lives in
`.cycle/metrics.csv`; in-flight work lives in `.cycle/STATE.md`.

| Cycle | Date | Subsystem audited | Axis-A min / mean | Axis-B min | Findings (C/H/M/L) | Fixed | Tests after | Policy |
|-------|------|-------------------|-------------------|-----------|--------------------|-------|-------------|--------|
| _none yet_ | | | | | | | 648 | — |

---

## Notes / Standing Decisions
- Single-operator app: the only attacker is the operator; threat model weights
  correctness and data integrity over multi-tenant isolation.
- Frozen subsystems excluded from rotation: `plaid/server.js` (legacy standalone),
  `n8n-workflows/*.json` (superseded by in-process schedulers).
