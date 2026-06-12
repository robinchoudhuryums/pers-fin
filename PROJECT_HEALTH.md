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

**Cycle 4 synthesis (2026-06-12)** — covers everything since cycle 3: the
F6-F10 implement wave (Code.gs server-preference, Per-sistant nonce CSP/PB-3
closed, notification a11y, recurrence CHECK, email-renderer pins),
infrastructure round (live-Postgres migration CI job, out-of-process GitHub
Actions cron for critical jobs, nightly encrypted backups, RAG v2 hybrid
retrieval + semantic cache + token-aware chunking, critical-alert emails,
calendar feed), four route-file splits, Playwright e2e smokes, FIRE/runway +
Ask Perfin, the health/habits tracker, the hi-fi transition + WebAuthn
transports fixes, and the June 2026 **Seams & Invariants audit #2** (14
invariants re-verified PASS; 3 findings, all fixed same-session).

- Cycles completed: **4**
- Last cycle: **4 / 2026-06-12 — seams audit + feature rounds (whole-repo evidence)**
- Axis-A: **min 8 · mean ≈ 8.5** (15 dimensions)
- Axis-B: **min 8 · mean ≈ 8.3**
- Policy flags active: **none** — no dimension ≤ 6 (threshold 6/10 × 2 consecutive cycles)
- Tests: **764 → 971** passing (36 files, `npm test`) + 8 Playwright browser smokes (CI-only)
- Carry-over process debt: cycle-3 candidate invariants (INV-37…47) still awaiting `/reflect` promotion into CLAUDE.md's library; this cycle adds 2 more candidates (see notes).

---

## Axis A — Health Dimensions (1–10)

| # | Dimension | What it measures | Primary subsystem(s) | Score | Last scored |
|---|-----------|------------------|----------------------|:-----:|:-----------:|
| 1 | Financial Data Accuracy | Money figures match source data end-to-end | Financial Analytics, Bank Sync | **9** | 4 |
| 2 | Sync Integrity & Idempotency | Re-syncs don't dup/drop; watermarks/cursors safe | Bank Sync & Ingestion | **9** | 4 |
| 3 | Income/Spending Classification | Correct income vs spending vs transfer split | Financial Analytics, Detection | **8** | 4 |
| 4 | AI Output Trustworthiness | Insights audited; hallucinations caught; cap enforced | AI Insights & Audit | **8** | 4 |
| 5 | Auth & Session Security | PIN gate, idle window, API-key path, redirects | Platform, Shell & Auth | **9** | 4 |
| 6 | Secret & Token Handling | Encryption at rest; mismatch surfaces, not silent | Platform, Shell & Auth | **8** | 4 |
| 7 | Scheduler Reliability | Cron tasks fire in-process, in order, idempotent | Platform, Shell & Auth | **9** | 4 |
| 8 | Data Freshness & Reconciliation | Staleness surfaced; reconcile recovers drops | Bank Sync, Settings/Notif | **9** | 4 |
| 9 | Migration Safety | Transactional, fatal-on-failure, idempotent | Platform, Shell & Auth | **9** | 4 |
| 10 | Notification Correctness | Right alerts, no spam, logged as audit trail | Settings, Notifications & Cross-app | **8** | 4 |
| 11 | Cross-app Integration Integrity | Pool-wiring/webhooks/SSO behave embedded + standalone | Settings/Notif/Cross-app, Per-sistant Backend | **9** | 4 |
| 12 | UI/UX & Accessibility | Responsive, a11y, CSP, mobile nav/tables | Web UI (Perfin), Per-sistant Web UI | **9** | 4 |
| 13 | External Export Fidelity | Sheets/Apps Script mirror DB without drift | Sheets & External Export | **8** | 4 |
| 14 | Test Coverage Quality | Tests fail when the code under test regresses | (all) | **8** | 4 |
| 15 | Knowledge Retrieval & Grounding | Privacy tiers, citations, grounding, defensive pgvector | Knowledge / RAG (Per-sistant) | **8** | 4 |

## Axis B — Horizontal Failure Shapes (1–10)

| Category | What it measures | Score | Last scored |
|----------|------------------|:-----:|:-----------:|
| Silent Degradation Posture | Failures that swallow errors and look like success | **8** | 4 |
| Startup Ordering Guarantees | Migrations/cron/pool-wiring race or run out of order | **9** | 4 |
| Operator-Only State Gaps | Undocumented manual setup (PEMs, passphrase, env vars) | **8** | 4 |
| Parallel Source-of-Truth Drift | SPLIT_AMOUNT/INCOME_PREDICATE copies diverging across files | **9** | 4 |
| Money / Precision Drift | NUMERIC rounding, split-sum ±$0.01, parseMoney edges | **8** | 4 |
| Test Coverage Quality | Tests that pass regardless of the code under test | **8** | 4 |

---

## Score History

One row per completed cycle (newest first). Detailed per-finding data lives in
`.cycle/metrics.csv`; in-flight work lives in `.cycle/STATE.md`.

| Cycle | Date | Subsystem audited | Axis-A min / mean | Axis-B min | Findings (C/H/M/L) | Fixed | Tests after | Policy |
|-------|------|-------------------|-------------------|-----------|--------------------|-------|-------------|--------|
| 4 | 2026-06-12 | Seams & Invariants #2 + feature-round evidence | 8 / 8.5 | 8 | 0 / 0 / 1 / 2 | 3 | 971 | none |
| 3 | 2026-06-09 | All non-frozen (broad + 8 targeted + seams) | 7 / 8.1 | 7 | 0 / 1 / ~5 / ~24 | ~30 | 764 | none |

---

## Cycle 4 synthesis notes (score rationale)

Mean rose 8.1 → ≈8.5 (Axis A) and 7.8 → ≈8.3 (Axis B); every cycle-3 drag
(the three Axis-A 7s and two Axis-B 7s) moved:

**Score changes, with evidence:**
- **Financial Data Accuracy 8 → 9:** the seams audit eliminated the last
  11 literal SPLIT_AMOUNT copies (4 cash-flow/yoy, 7 insights anomaly/seasonal)
  and pinned a repo-wide scan (`tests/seams-audit.test.js`), restoring the
  documented single-source-of-truth guarantee mechanically; FIRE + Ask Perfin
  bind to the same shared helpers (numbers match the dashboard by
  construction); the income-summary JOIN-ambiguity 500 was caught by live-boot
  verification and fixed.
- **Scheduler Reliability 8 → 9:** critical jobs now have out-of-process
  GitHub-Actions guarantees (daily-sync, weekly-reconcile, db-backup,
  knowledge-reindex) so Render free-tier sleep can't skip them; job-health
  watchdog verified; the tick-name ↔ threshold-table mapping verified exact
  (11/11) in the seams audit.
- **Cross-app Integration Integrity 8 → 9:** seams audit #2 verified every
  column contract on both sides of the pool-wiring seam, both email delivery
  paths insert identical rows, and the one asymmetry found (critical_alert
  accepted in-process but 200-and-dropped by the standalone HTTP receiver) is
  fixed + pinned by an EMAIL_EVENTS↔receiver symmetry test.
- **UI/UX & Accessibility 7 → 9:** PB-3 closed (Per-sistant per-request nonce
  CSP, `'unsafe-inline'` removed — the exact lift cycle 3 predicted), plus
  notification-panel a11y/contrast (F8), escAttr attribute-context fixes,
  mobile nav/responsive-cards/toast/bottom-sheet work, safe-area + PTR, and
  real-browser Playwright smokes now in CI.
- **External Export Fidelity 7 → 8:** Code.gs prefers the canonical server API
  when SERVER_URL is set (F6); CSV dedup-ID parity fixed; SX3 byte-pins hold.
  Residual cap: the standalone Code.gs CSV path remains a stale fork and the
  operator `clasp push` is still pending.
- **Test Coverage Quality 7 → 8 (both axes):** 971 tests / 36 files;
  Playwright browser smokes + a live-Postgres double-run migration CI job
  catch whole classes (boot failures, non-idempotent migrations) tests with
  mock pools can't; injection-as-bind-param and hostile-string behavioral
  tests added. Residual cap unchanged: `auditInsight`'s full Tier-1 flow still
  lacks a behavioral mock-pool test.
- **Silent Degradation (Axis B) 7 → 8:** decryption_failed surfacing,
  last_sync_result + BS-6 wholesale-throw capture, modules_failed, and the
  critical_alert receiver gap fixed; remaining fail-soft paths are deliberate
  and documented (INV-35 posture).
- **Parallel Source-of-Truth Drift (Axis B) 8 → 9:** the audit proved drift
  HAD happened (11 unconverted sites survived two prior audits' "cannot
  drift" claim) — but the repo-wide literal-CASE scan test now fails on any
  recurrence, which is stronger than any prose guarantee.

**Held flat:** Sync Integrity 9, Auth 9, Secrets 8, Freshness 9, Migration 9,
Classification 8, AI Trust 8 (cap now spans four spenders incl. ask; AIA3
cosmetic deferral stands), Notifications 8 (gap found+fixed nets out),
Knowledge 8 (RAG v2 shipped — hybrid RRF + semantic cache + token-aware
chunking — but still unexercised against a live vault/Voyage, which caps
confidence, not quality), Startup Ordering 9, Operator Gaps 8 (well-documented
but cert rotation + backup secrets + clasp push still open), Money/Precision 8.

**New failure modes this cycle: none at synthesis time.** The cycle-4
`/reflect` (post-merge) later tallied 2 Low (fail-fast passphrase boot,
deliberate + escape-hatched; CI Playwright CDN dependency, CI-only). PSB1
(Per-sistant DB TLS verify) transfers to the first deploy of the merged main
(PR #116).

**Candidate invariants — RESOLVED by the cycle-4 reflect:** promoted as
INV-48…53 into CLAUDE.md's Invariant Library (scan rule, EMAIL_EVENTS
symmetry, webauthn transports, read-time streaks, health fail-soft,
GH-Actions job backstops); INV-14 amended to include /api/ask. INV-37…47
(cycle-3 candidates) RETIRED — definitions were never written to the repo
and are unrecoverable; numbers burned, never reuse.

**Most likely problem before next cycle:** the first deploy of this large
unmerged branch (PSB1 TLS verify + first CI run of the new migrations/e2e
jobs + Render passphrase prerequisite). Recommend merging soon rather than
letting the branch grow further.

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

**Pending:** ~~promote INV-37…47 into CLAUDE.md's Invariant Library~~ —
resolved at cycle 4: definitions were never written to the repo and are
unrecoverable, so 37…47 are RETIRED (numbers burned; subject matter is
test-pinned) and the cycle-4 candidates were promoted as INV-48…53 instead.
~~A Seams & Invariants audit is DUE~~ — completed 2026-06-12 (cycle 4).

## Notes / Standing Decisions
- Single-operator app: the only attacker is the operator; threat model weights
  correctness and data integrity over multi-tenant isolation.
- Frozen subsystems excluded from rotation: `plaid/server.js` (legacy standalone),
  `n8n-workflows/*.json` (superseded by in-process schedulers).
