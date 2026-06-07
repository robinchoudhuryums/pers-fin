# .cycle/STATE.md — In-Progress Cycle State

Tracks the *currently running* cycle so work can be resumed across sessions.
Read first by `/cycle-status` and `/cycle-resume`. When a cycle completes, its
results move to `PROJECT_HEALTH.md` + `.cycle/metrics.csv` and this file resets
to the "none in progress" state below.

---

## Current Cycle

- **Status:** none in progress
- **Phase:** idle
- **Subsystem under audit:** —
- **Started:** —
- **Findings gathered:** —
- **Implementation progress:** —
- **Next concrete step:** start a fresh audit (see Rotation below)

> When a cycle is active, this section holds: the subsystem, the phase
> (audit → synthesis → implement → verify), the findings list with severities,
> which fixes are done vs pending, and the single next action to take.

---

## Rotation Plan

Recommended order (frozen subsystems excluded; name one explicitly to override):

1. **Bank Sync & Ingestion**  ← recommended first (widest blast radius, most invariants, richest bug history)
2. Financial Analytics
3. Detection & Categorization
4. AI Insights & Audit
5. Platform, Shell & Auth
6. Settings, Notifications & Cross-app
7. Sheets & External Export
8. Web UI (Perfin)
9. Per-sistant Backend
10. Per-sistant Web UI

- **Seams audit:** every 3 subsystem cycles — enrollments.js, subscriptions.js,
  settings.js, financial-queries.js, notifications.js, and the cross-app pair
  apps/per-sistant/routes/perfin.js + routes/webhooks.js.
- **Last subsystem audited:** none
- **Cycles completed:** 0

---

## Recommended Next Action

→ **FRESH AUDIT** — no cycle is in progress and no findings are pending.
Run `/broad-scan` (or `/targeted-audit Bank Sync & Ingestion`). Use fresh eyes —
do not inherit prior conclusions.
