# .cycle/STATE.md — In-Progress Cycle State

Tracks the *currently running* cycle so work can be resumed across sessions.
Read first by `/cycle-status` and `/cycle-resume`. When a cycle completes, its
results move to `PROJECT_HEALTH.md` + `.cycle/metrics.csv` and this file resets
to the "none in progress" state.

---

## Current Cycle

- **Status:** audit→plan→implement complete (Financial Analytics, cycle 2); awaiting deploy confirmation
- **Phase:** implemented — not yet Health-Synthesized (no Axis-A/B scores recorded yet)
- **Subsystem audited:** Financial Analytics (cycle 2). Prior: Bank Sync & Ingestion (cycle 1).
- **Started:** 2026-06-07
- **Findings gathered (cycle 2):** F1 (High — net worth counted loans as assets), F2/F3/F4 (Med/Low), F5 (test gaps). Implemented as A1–A5.
- **Implementation progress:** A1–A5 all implemented + tested (666 tests pass, +3). Cycle 1 (BS-1..BS-8) shipped via PR #108.
- **Next concrete step:** operator deploys (Render auto-deploys on merge to `main`; cycle-1 work is in open PR #108, cycle-2 commits stack on the same branch). Then run `/reflect` (promote candidate INV-27 net-worth liability rule; record cycle-2 metrics) and optionally a Health Synthesis, then rotate to subsystem 3 (Detection & Categorization).

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
