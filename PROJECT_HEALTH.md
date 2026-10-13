# PROJECT_HEALTH.md — Cycle Health Standing

Living record of the project's health across audit/implement cycles. Updated by
the Health Synthesis step at the end of each cycle. Read by `/cycle-status`.

- **Scoring:** each dimension 1–10 (evidence-based from code reads + test runs).
  Higher = healthier. A score is only recorded when a cycle gathers evidence for
  that dimension; dimensions not touched in a cycle keep their prior value (with
  the cycle they were last scored noted).
- **Policy:** a category that **declines for 2 consecutive cycles**, **drops
  ≥1.5 in one cycle**, **stays lowest for 2 cycles without improving**, or sits
  at the **absolute floor ≤ 5/10** triggers a policy response (prioritized
  remediation before new feature work in that area). Relative trigger per
  workflow-tools v1.33.0; floor lowered 6 → 5 after cycle 4.
- **Axes:** *Axis A* = the 15 vertical health dimensions (per-subsystem concerns;
  Knowledge Retrieval & Grounding added in cycle 3 to match the Cycle Workflow
  Config's Health Dimensions). *Axis B* = 6 cross-cutting failure shapes scored
  alongside them.

---

## Current Standing

**Cycle 6 synthesis (2026-10-13)** — the Sept 2026 broad scan (9 Stage-1
auditors + 3 deep dives, real-SQL reproduction) and its 15 implementation
batches + follow-ons. Inputs: the scan's FINAL REPORT + batch plan, the cycle-6
`/reflect` block (`.cycle/blocks/6-a-reflect.md`), `npm test` 1489/1489.
**No §4v Verification Block was run** — Axis A confidence is Medium at best and
every Axis B score is Low-confidence (self-reported, unverified).

- Cycles completed: **6** (cycle 5 was reflected but never synthesized — no row)
- Last cycle: **6 / 2026-10-13 — broad scan, all non-frozen subsystems**
- Axis-A: **min 7 · mean ≈ 7.5** (15 dimensions) — scan-measured pre-fix baseline was min 4 · mean ≈ 4.9
- Axis-B: **min 7 · mean 7.5**
- Overall (weighted 70% A / 30% B): **7.5** (cycle 4: 8.4)
- One-line summary: the cycle repaired a large backlog of real defects the
  cycle-4 scores never saw; the project is healthier than it was in September
  but measurably below what PROJECT_HEALTH.md claimed in June.
- Top vertical priority: **UI/UX & Accessibility** (7, Low-Med confidence — the
  scan's ten operator visual checks V1–V10 were never run)
- Top horizontal priority: **Parallel Source-of-Truth Drift** (9 → 7)
- Policy flags active: **3** — Parallel Source-of-Truth Drift (sharp drop),
  Silent Degradation Posture (persistent laggard), Operator-Only State Gaps
  (persistent laggard). See Policy Responses below; they are mandatory scope
  for cycle 7.
- Tests: **1097 → 1489** `npm test` (67 files) + 43 real-Postgres contract
  tests + 8 Playwright smokes (CI)

---

## Axis A — Health Dimensions (1–10)

| # | Dimension | What it measures | Primary subsystem(s) | Score | Conf. | Last scored |
|---|-----------|------------------|----------------------|:-----:|:-----:|:-----------:|
| 1 | Financial Data Accuracy | Money figures match source data end-to-end | Financial Analytics, Bank Sync | **7** | Med | 6 |
| 2 | Sync Integrity & Idempotency | Re-syncs don't dup/drop; watermarks/cursors safe | Bank Sync & Ingestion | **8** | Med | 6 |
| 3 | Income/Spending Classification | Correct income vs spending vs transfer split | Financial Analytics, Detection | **7** | Med | 6 |
| 4 | AI Output Trustworthiness | Insights audited; hallucinations caught; cap enforced | AI Insights & Audit | **7** | Med | 6 |
| 5 | Auth & Session Security | PIN gate, idle window, API-key path, redirects | Platform, Shell & Auth | **8** | Med | 6 |
| 6 | Secret & Token Handling | Encryption at rest; mismatch surfaces, not silent | Platform, Shell & Auth | **8** | Med | 6 |
| 7 | Scheduler Reliability | Cron tasks fire in-process, in order, idempotent | Platform, Shell & Auth | **7** | Med | 6 |
| 8 | Data Freshness & Reconciliation | Staleness surfaced; reconcile recovers drops | Bank Sync, Settings/Notif | **8** | Med | 6 |
| 9 | Migration Safety | Transactional, fatal-on-failure, idempotent | Platform, Shell & Auth | **8** | Med-High | 6 |
| 10 | Notification Correctness | Right alerts, no spam, logged as audit trail | Settings, Notifications & Cross-app | **7** | Med | 6 |
| 11 | Cross-app Integration Integrity | Pool-wiring/webhooks/SSO behave embedded + standalone | Settings/Notif/Cross-app, Per-sistant Backend | **8** | Med | 6 |
| 12 | UI/UX & Accessibility | Responsive, a11y, CSP, mobile nav/tables | Web UI (Perfin), Per-sistant Web UI | **7** | Low-Med | 6 |
| 13 | External Export Fidelity | Sheets/Apps Script mirror DB without drift | Sheets & External Export | **7** | Med | 6 |
| 14 | Test Coverage Quality | Tests fail when the code under test regresses | (all) | **8** | Med-High | 6 |
| 15 | Knowledge Retrieval & Grounding | Privacy tiers, citations, grounding, defensive pgvector | Knowledge / RAG (Per-sistant) | **7** | Med | 6 |

## Axis B — Horizontal Failure Shapes (1–10)

| Category | What it measures | Score | Trend | Last scored |
|----------|------------------|:-----:|:-----:|:-----------:|
| Silent Degradation Posture | Failures that swallow errors and look like success | **7** | Degrading (8 → 7) | 6 |
| Startup Ordering Guarantees | Migrations/cron/pool-wiring race or run out of order | **8** | Degrading (9 → 8) | 6 |
| Operator-Only State Gaps | Undocumented manual setup (PEMs, passphrase, env vars) | **7** | Degrading (8 → 7) | 6 |
| Parallel Source-of-Truth Drift | SPLIT_AMOUNT/INCOME_PREDICATE copies diverging across files | **7** | Degrading (9 → 7) | 6 |
| Money / Precision Drift | NUMERIC rounding, split-sum ±$0.01, parseMoney edges | **8** | Stable | 6 |
| Test Coverage Quality | Tests that pass regardless of the code under test | **8** | Stable (8 → 8; was overstated at 8, measured 4, rebuilt to 8) | 6 |

All Axis B scores: **Low confidence — no independent verification (§4v not run).**

---

## Score History

One row per completed cycle (newest first). Detailed per-finding data lives in
`.cycle/metrics.csv`; in-flight work lives in `.cycle/STATE.md`.

| Cycle | Date | Subsystem audited | Axis-A min / mean | Axis-B min | Findings (C/H/M/L) | Fixed | Tests after | Policy |
|-------|------|-------------------|-------------------|-----------|--------------------|-------|-------------|--------|
| 6 | 2026-10-13 | Broad scan, all non-frozen (15 batches + follow-ons) | 7 / 7.5 | 7 | ~185 actions (C/H/M/L not tallied) | 185 (4 deferred: PB-8/16/18/20) | 1489 | **3 triggered** |
| 5 | 2026-06-15 | Broad scan F1–F12 + T1–T4 | — (reflected, not synthesized) | — | 0 / 0 / 3 / 13 | 16 | 1011 | — |
| 4 | 2026-06-12 | Seams & Invariants #2 + feature-round evidence | 8 / 8.5 | 8 | 0 / 0 / 1 / 2 | 3 | 971 | none |
| 3 | 2026-06-09 | All non-frozen (broad + 8 targeted + seams) | 7 / 8.1 | 7 | 0 / 1 / ~5 / ~24 | ~30 | 764 | none |

---

## Policy Responses — triggered at cycle 6 (mandatory cycle-7 scope)

---POLICY RESPONSE TRIGGERED---
Category: Parallel Source-of-Truth Drift
Trigger clause: sharp drop (9 → 7 in one synthesis)
Consecutive poor cycles: 1
Current score: 7/10 | Prior score: 9/10
Root pattern: every feature shipped after cycle 4 re-derived a canonical number in its own surface (budget status in 4 places, the AI spend tally in 6, housing-due in 2, manual-bill placement calendar vs ICS, the pyramid vs getNetWorth, the tax report from a table instead of transactions), and the only mechanical guard covers SPLIT_AMOUNT / INCOME_PREDICATE / NOT_TRANSFER.

Prescribed policy fix (include in next cycle scope):
- Extend tests/seams-audit.test.js with a canonical-helper scan: fail when `monthly_limit` is read as a limit outside getBudgetStatus (financial-queries.js) and the pinned Sheets mirror; when a `financial_insights` cost sum appears outside monthAiSpendCents; when a net-worth sum over linked_accounts/investment_accounts appears outside getNetWorth. KNOWN_GAPS list that only shrinks (INV-95 pattern).
- Add the timezone lint the scan proposed: fail on `toISOString().slice(0, 10)`, `new Date(<date string>)` in client date display, and `date_trunc('month', CURRENT_DATE)` in month-bucketed code, outside an allowlist (promotes INV-98/INV-99).
- Contract-test parity: run the Sheets Budget Status SQL and getBudgetStatus against the same contract DB and assert identical effective limits.

Scope addition: Add these policy fixes to the next subsystem cycle's Implementation Handoff Block as mandatory actions alongside the subsystem-specific findings.
---END POLICY RESPONSE---

---POLICY RESPONSE TRIGGERED---
Category: Silent Degradation Posture
Trigger clause: persistent laggard (tied-lowest at cycle 4 (8) and cycle 6 (7), did not improve)
Consecutive poor cycles: 2
Current score: 7/10 | Prior score: 8/10
Root pattern: background work reports its outcome only to the log — this cycle alone found Sheets errors[] ignored by every caller, a silent Plaid stall, an invisible vault-sync failure, unchecked page writes and a Job Radar page that rendered "Added 0 of 0" on a 500.

Prescribed policy fix (include in next cycle scope):
- One background-job result surface (the scan's completeness gap #3): every startup.js job and Per-sistant cron records `{at, ok, error}` and GET /api/data-health turns a failed last run into an issue; add a test that enumerates startup.js jobs and fails on any without a recorded outcome.
- A `.catch(() => {})` / empty-catch scan over teller/routes, teller/services and apps/per-sistant/routes with a shrinking KNOWN_GAPS list; each surviving entry needs a one-line reason.

Scope addition: Add these policy fixes to the next subsystem cycle's Implementation Handoff Block as mandatory actions alongside the subsystem-specific findings.
---END POLICY RESPONSE---

---POLICY RESPONSE TRIGGERED---
Category: Operator-Only State Gaps
Trigger clause: persistent laggard (tied-lowest at cycle 4 (8) and cycle 6 (7), did not improve)
Consecutive poor cycles: 2
Current score: 7/10 | Prior score: 8/10
Root pattern: correctness still depends on manual steps the app can't see — a post-deploy full Knowledge reindex, NODE_ENV in the Render dashboard, the compromised Teller cert rotation, the Apps Script `clasp push`, and two open product decisions (PB-16 ephemeral attachments, PB-18 Per-sistant AI budget not settable).

Prescribed policy fix (include in next cycle scope):
- Make the reindex automatic: store a vault-parser/sync version in user_settings and run one full reindex on boot when it differs from the code's version (removes the standing post-deploy step).
- Surface operator state in Sync Health: a data-health issue when the loaded Teller cert matches the compromised fingerprint (today only a log line) and when `last_full_reindex_version` lags.
- Take the PB-16 storage decision and the PB-18 budget decision (operator), then schedule them.

Scope addition: Add these policy fixes to the next subsystem cycle's Implementation Handoff Block as mandatory actions alongside the subsystem-specific findings.
---END POLICY RESPONSE---

---

## Cycle 6 synthesis notes (score rationale)

**Why the scores fell from cycle 4 although 117 production bugs were fixed.**
Cycle 4's 8–9s were read-based. The Sept 2026 scan reproduced failures against
real Postgres and the full app's routing, and re-rated the project at Stage 2:
Financial Accuracy 4, Sync 5, Classification 4, AI 5, Auth 6, Secrets 7,
Scheduler 4, Freshness 4, Migration 7, Notifications 4, Cross-app 6, UI 4,
Export 4, Knowledge 5, Tests 4 (mean ≈ 4.9). Much of that damage sat in features
shipped after cycle 4 (housing, Settle Up, F11, Job Radar), the rest in older
code the mock-pool suite couldn't judge. Cycle 6 lifted every dimension by 1–4
from that measured baseline. The fall versus cycle 4 is mostly recalibration,
not new breakage — but it is real against the recorded numbers, and the policy
clauses are applied mechanically.

**Axis A, with evidence and the drag that holds each score:**
- **Financial Data Accuracy 7** (from measured 4): FAN-1 ledger write, FAN-3/4
  generation, DC-2 dead subscriptions, DD-4/FAN-5 cash flow, FAN-6 averages,
  WD-4/5 pyramid, one getBudgetStatus, investments BSI-4/5/6; contract-tested.
  Drag: DD-2 can drop real spending whose raw description hits an excluded word
  (new Medium failure mode). Action: a word-list review of NOT_TRANSFER against
  real raw descriptions.
- **Sync Integrity 8** (from 5): BSI-1/7/8/9/12, DD-8/9, unified /api/sync, sync
  engines now contract-tested and behaviorally idempotent (INV-54). Drag: the
  Plaid item loop and Teller enroll / Plaid exchange routes have no contract
  test. Action: a Plaid-client fixture in tests/contract.
- **Income/Spending Classification 7** (from 4): FAN-2 double count, DD-2 raw
  description, DD-3 Plaid PFC, DC-1/12/13/14. Drag: the DD-2 over-exclusion and
  DD-4's HELOC heuristic. Action: same as Financial Accuracy.
- **AI Output Trustworthiness 7** (from 5): AIN-1..16, Claude 5.5 upgrade through
  createToolCall, cap across six spenders. Drag: AIN-1 trades recall for
  precision; strict tool use is not exercised against the live API; Batch 7's
  14/14 self-score is unverified. Action: a §4v probe of the Tier-1 audit with a
  planted hallucination.
- **Auth & Session 8** (from 6): PSC-4/9/11/14, WD-16, PB-15/21. Drag: the
  PSC-14 lockout is attacker-triggerable (Medium). Action: exempt a recently
  successful device/IP from the global ceiling, or lower its window.
- **Secret & Token Handling 8** (from 7): KR-2 fail-closed, KR-10 capture
  sensitivity, BSI-3 token cleanup. Drag: rows filed by the old fail-open parser
  stay until the operator runs one full reindex; the compromised Teller cert is
  still unrotated. Action: Operator-Gaps policy fix (auto-reindex).
- **Scheduler Reliability 7** (from 4): PSC-2/3/12, PB-10/11/12, PD-2/3/8, AIN-15,
  FAN-7. Drag: keep-alive.yml still wakes Render 24/7; the daily digest is
  skipped on a day the process is only awake before 07:00. Action: decide the
  hosting move (always-on removes both).
- **Data Freshness & Reconciliation 8** (from 4): BSI-2/10/11, DD-10, SXE-1, KR-11
  all reach Sync Health. Drag: DD-5 can repeat a same-day balance change.
- **Migration Safety 8** (from 7, H): PSC-13, PSC-6 + INV-81 schema
  classification, db/022–024 idempotent, contract suite runs both migration
  chains per file. Drag: none significant; held below 9 without a verified
  fresh-vs-upgraded probe this cycle.
- **Notification Correctness 7** (from 4): PB-1 all types + Reminders widget,
  PSC-1 toggle + change gate, PSC-3 away channels, PB-2. Drag: Per-sistant
  browser notifications still only fire on a dashboard load; budget alerts now
  wake Neon every 3h.
- **Cross-app Integration 8** (from 6): one housingDue helper, getNetWorth shared
  with Knowledge (KR-9), signed-webhook exemption, embedded Log Out.
- **UI/UX & Accessibility 7** (from 4, Low-Med): WD-1, WUI-1..6, IF-1..7,
  PUI-1..8, FO-2..4, guards for nonce / base path / undefined vars. Drag: the
  scan's operator visual checks V1–V10 (light-theme modals, 320px, screen
  reader, iOS status bar) were never run. Action: run V1–V10.
- **External Export Fidelity 7** (from 4): SXE-1..16, WD-1, formula guard,
  re-runnable formatting. Drag: verified only against a stateful fake Sheets
  API; Code.gs standalone fork and `clasp push` still open.
- **Knowledge Retrieval & Grounding 7** (from 5): KR-1..14 and a keyword-path
  contract test. Drag: still never exercised against a live vault + Voyage +
  pgvector; the post-deploy reindex is pending.
- **Test Coverage Quality 8** (from 4): 244 replica/tautology tests replaced with
  real-code tests (TQ-1), a real-Postgres contract suite mounting every router in
  server.js order (TQ-2) that immediately exposed 5 live bugs, mutation checks
  turning it red, shrinking-KNOWN_GAPS guards. Drag: no §4v; Plaid item loop
  uncovered; Category D ratio not measured.

**New failure modes this cycle (from the reflect, corrected):** 15 — 3 Medium
(PSC-14 lockout, DD-2 over-exclusion, FAN-4 landlord-switch relabel), 12 Low.
Net +102.

**Deferred, needing operator decisions:** PB-8 (Job Radar profile steering),
PB-16 (durable attachments), PB-18 (Per-sistant AI budget), PB-20 (Adzuna dedupe,
unverified).

**Most likely problem before the next cycle:** the first production run of the
Batch 11 Knowledge changes without the one-time full reindex — old
fail-open-classified rows stay retrievable until it runs.

**Reading the grid:** audit UI/UX & Accessibility (or run V1–V10) next; put
Parallel Source-of-Truth Drift under policy.

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
