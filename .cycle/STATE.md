# .cycle/STATE.md — In-Progress Cycle State

Tracks the *currently running* cycle so work can be resumed across sessions.
Read first by `/cycle-status` and `/cycle-resume`. When a cycle completes, its
results move to `PROJECT_HEALTH.md` + `.cycle/metrics.csv` and this file resets
to the "none in progress" state.

---

## Current Cycle

- **Status:** /broad-scan + /broad-implement (H1/M5/M2/M3/M1 + Tier-1 M6/M4/L2) + /sync-docs, then a /targeted-audit + /targeted-implement of Knowledge / RAG (Per-sistant) (A1–A4) — all on branch `claude/sweet-brahmagupta-3uwc4r`; awaiting review/deploy.

### Knowledge / RAG targeted cycle (this session)
Audited Knowledge/RAG; 6 findings (1 Medium, 5 Low). Implemented A1–A4, deferred A5/A6:
- **A1 (K1, Medium)** vault-sync.js syncVault prose branch: `await clearFacts(pool, path)` so a fact-file→prose conversion drops orphaned facts that were still being injected into answers (asymmetry with prose→fact, which already cleared the doc).
- **A2 (K2, Low)** rag.js upcomingFacts: `value::date` → `to_date(value,'YYYY-MM-DD')` so one date-shaped-but-invalid fact value (e.g. 2025-02-30) can't throw and silently disable ALL upcoming-fact notifications.
- **A3 (K4, Low)** vault-sync.js syncNotes: now holds the `_syncing` single-flight lock (busy→no-op) so the hourly cron's notes phase and a concurrent reindex can't overlap-embed. Strengthens INV-36 (previously the notes leg was unlocked).
- **A4 (K5, Low)** vault-sync.js embedSource: empty-body sources now upsert `embed_state` (chunk_count 0) instead of just clearSource, so the content-hash skip engages instead of re-clearing every sync.
- **Deferred:** A5 (K3 — parse inline [n] in the Citations fallback so `grounded` isn't always false on that path), A6 (K6 — allow capture into private/secret tier). Plus cross-module follow-on: verify Per-sistant's shared `renderMd` escapes raw HTML (not just link schemes) since the Knowledge answer renders via `renderMd` into innerHTML under a CSP that still has `script-src 'unsafe-inline'` (PB-3).
- **Phase:** implemented — not yet Health-Synthesized (broad-scan Axis-A scores recorded in the session report, not yet promoted to PROJECT_HEALTH.md).
- **Subsystem audited:** broad pass across all subsystems (cycle 3, broad). Prior: Bank Sync (cycle 1), Financial Analytics (cycle 2).
- **Started:** 2026-06-09
- **Findings gathered (broad scan):** H1 (High — getNetWorth dedup direction drops Plaid brokerage value), M1–M6 + ~15 Low. Top-5: H1, M5, M2, M3, M1.
- **Implementation progress (this session):** H1, M5, M2, M3, M1 committed + pushed (commit f871cef); docs synced (92c080c); then Tier-1 follow-up M6, M4, L2 implemented + tested (745 pass, 0 fail).

### Findings implemented this session
- **H1** `getNetWorth` (financial-queries.js): flipped dedup direction — drop the $0 Plaid `linked_accounts` phantom when an active `investment_accounts` row exists; `investment_accounts` is authoritative (matches /api/investments + dashboard grid). Updated the two cycle-fixes.test.js getNetWorth mocks (they routed on a bare `/investment_accounts/` substring that now also matches the linked query's NOT EXISTS subquery — routed on `FROM linked_accounts` instead).
- **M5** budget-snapshot auto-trigger (startup.js): removed the `getDate()===1` gate so a missed prior-month snapshot is caught up on any later tick (idempotent via the existing-snapshot short-circuit). Fixes silent rollover loss on free-tier sleep.
- **M2** categorize AI loop (categorize.js): a swallowed usage-row INSERT no longer lets spend escape the cap — on insert failure we apply the already-paid batch, then stop the loop (`budgetHit=true`).
- **M3** sheets buildDashboard (sheets-sync.js): budget-join category expression now matches the SPENDING BY CATEGORY query (adds `personal_finance_category->>'primary'`), so the budget tab's "Spent" agrees with the breakdown on the same sheet.
- **M1** categorization-rule LIKE (categorize.js, both runCategorize + /apply): escape `\ % _` in user patterns with `REPLACE(...) ESCAPE '\'` so a `%`/`_` in a pattern can't act as a wildcard. exact (`=`) unchanged.

### Tier 1 follow-up implemented (this session, after the H1/M5/M2/M3/M1 batch)
- **M6** shell/index.js: added a `verify` hook to the shell's `express.json` so `req.rawBody` is captured under the unified shell — the embedded Per-sistant webhook receiver now HMAC-verifies the exact signed bytes instead of falling back to re-stringifying `req.body`.
- **M4** scripts/sheets-sync.js: `buildDashboard` now routes the three per-category queries (categorySummary, categoryByMonth, budgetData) through a splits-aware `cat_lines` CTE (parent_no_splits ∪ from_splits) mirroring getCategorySpendingForMonth, so per-category Sheets totals match the app for users who split transactions. Total queries (monthlySummary, totals) + topMerchants intentionally left parent-keyed.
- **L2** teller/routes/subscriptions.js: CSV-import balance auto-update now matches the user's manual account by EXACT institution name OR EXACT account label (was a `name LIKE '%institution%'` substring that could overwrite the wrong account).

### Still deferred (in broad-scan report)
- L1 (Apps Script Code.gs stale fork), L3 (split tolerance 0.011), L4 (detection-key cleanup runs every boot / "one-shot" comment), L5 ($0 CSV skip), L6 (ephemeral SESSION_SECRET, embedded-irrelevant), L7 (syncNotes outside _syncing lock), L8 (empty-doc embed_state), L9 (return_to on requireAuth redirect). Plus Tier-3 effectiveness/completeness items.

### Next concrete step
- Review + deploy (Render auto-deploys on merge to `main`). Then `/sync-docs` to fix CLAUDE.md's getNetWorth Key Design Decision (it documents the OLD/wrong dedup direction). Optionally `/reflect` to record broad-scan metrics + a candidate invariant for the net-worth dedup direction.

### Decisions made this cycle (cycle 2 — Financial Analytics)
- **A1/F1** liability set = `type IN ('credit','loan')` (Plaid's two debt types cover all loan subtypes); return shape of `getNetWorth` unchanged so its 3 snapshot writers + dashboard + context-export need no caller changes.
- **A2/F2** extracted `deriveGoalProgress()` shared by GET /api/goals + context-export to kill the parallel-source-of-truth drift (was an inline duplicate).
- **A4/F4** trend scoped to the latest entry's score_type; added `score_type` to the trend object (additive).

### Decisions made cycle 1 (Bank Sync & Ingestion)

### Decisions made this cycle
- **BS-1** judged advisable despite Teller's default `count` being undocumented:
  the fix is page-size-independent (paginate until empty page / floor), so it is
  correct under any default. Sets `count=500` (documented Teller param) to bound
  round-trips; MAX_PAGES=100 runaway guard.
- **BS-2** Schwab Amount-column sign assumed negative=debit (parity with the
  Chase format + this format's Withdrawal→positive mapping). One-line flip if a
  real Schwab Amount export proves the opposite convention.
- **BS-4** Plaid cursor (INV-04) + xmax counting (INV-01) pinned via
  source-pinned tests rather than live-client behavioral tests
  (`syncPlaidItemTransactions` is not exported; behavioral would need a
  module-surface change out of scope).

### Residual / follow-on
- BS-1 MAX_PAGES break advances the watermark even if a >50k-txn account wasn't
  fully paged (warns to console). Beyond single-operator scale; revisit only if
  the warn ever fires.
- BS-1 depends on Teller accepting `count=500` (documented param; standard
  clamp expected). Watch the first post-deploy Teller sync.

## Where I left off
Cycle 2 (Financial Analytics) A1–A5 implemented on `claude/pensive-davinci-JhKFb`;
tests green at 666. Cycle 1 (Bank Sync, BS-1..BS-8) is in open PR #108. No cycle
work outstanding — next is `/reflect` (promote INV-27, record cycle-2 metrics)
then rotate to Detection & Categorization.

---

## Rotation Plan

1. ~~Bank Sync & Ingestion~~ ✅ audited + fixed (cycle 1)
2. ~~Financial Analytics~~ ✅ audited + fixed (cycle 2)
3. **Detection & Categorization**  ← recommended next
4. AI Insights & Audit
5. Platform, Shell & Auth
6. Settings, Notifications & Cross-app
7. Sheets & External Export
8. Web UI (Perfin)
9. Per-sistant Backend
10. Per-sistant Web UI

- **Seams audit:** every 3 subsystem cycles.
- **Subsystem cycles since last Seams audit:** 2
- **Last subsystem audited:** Financial Analytics
- **Cycles completed:** 2 (audit+implement; synthesis pending)
