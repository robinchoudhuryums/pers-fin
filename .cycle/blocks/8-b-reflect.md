---CYCLE SUMMARY BLOCK---
Scope: Seams & Invariants audit #4 fixes (S4-1..S4-5, 24 findings) + the opening-screen redesign | Cycle: 8 / 2026-11-04
Production fixes: 7 — severity: 1 Medium (A1 push_state 'sent' with nothing delivered → Per-sistant silenced its own reminder), 6 Low (B2 false stale-job warning ~36 h after deploy, B6 hourly auto-sync running every 2 h, B4 PIN length shown in Operator Checks, S1 trailing-space subscription billed AND averaged, C5 "Since you last looked" red for a falling cash balance / "$-X", C6 heatmap a day ahead west of UTC)
New capabilities/features: 1 (opening screen, direction D: the shell dial, JSON PIN keypad, unlock spin, hairline ring field + ripple — replaces the starfield and the pointer light)
Defensive/structural: 18 (S2 B3 C1 B1 B5 A3 S3 S6 S4 S5 A2 A6 A5 A4 C2 C3 C4 + the e2e summary-skeleton race fix)
New failure modes: 6 — severity: 6 Low (S2 rename rule holds row locks to COMMIT; B1 a legitimately >30 min run recorded failed; B1 a Plaid call >90 s now fails; S6 a dead bank-synced account silences the low-cash alert; S4 a freshly linked connection warns "no complete sync recorded" until its first scheduled sync; A6 Per-sistant quiet on a held item until the hold expires when the release job never runs)
Net score: 7 − 6 = +1
Invariant candidates: INV-158 (login keypad → JSON POST /login, same-origin redirect only, form post unchanged, reduced motion skips the animation), INV-159 (Sync Health's jobs[] is exactly the JOB_INTERVALS_MS set)
Most structurally significant change: B1 — a deadline on every scheduled run and the runner's own queries, so one hung call can no longer stop every job behind it (the watchdog included)
Should-have-been-deferred: A5 — queryPersistentStats parity with /api/stats for an endpoint nothing in the app calls
---END CYCLE SUMMARY BLOCK---

Corrections to the batch summaries (self-reported 9 prod fixes / 4 new failure modes):
- S4-3 S4 → defensive: webhooks are off on Render (PUBLIC_URL unset), so the global stamps moved with every scheduled sync and the false "stale" never fired; S4-3 S5 → defensive: needs a deleted row whose account is gone or that Plaid removed after it settled — not known to exist.
- Added two Low failure modes the summaries listed only as risks: B1's 90 s Plaid timeout and S4's post-link "no complete sync" warning.
- Accepted as YES with a condition: A1 (VAPID set — the PWA push path is in use), B6 (auto-sync switched on), C6 (APP_TIMEZONE set west of UTC — Health relies on it).
