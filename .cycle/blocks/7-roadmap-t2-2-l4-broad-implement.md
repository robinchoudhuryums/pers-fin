---BROAD SCAN IMPLEMENTATION SUMMARY---
Findings implemented: None (roadmap work, not scan findings)
New capabilities (G/ST): Roadmap T2.2 L4 — per-account low-balance floors + the cash alerts' last evaluation in Settings (closes T2.2)
Files modified:
  teller/services/database.js, teller/services/cash-alerts.js, teller/routes/enrollments.js,
  teller/views/settings.ejs, tests/roadmap-t2-2-cash-l2.test.js (fake pool learns the floor
  query + stamp flag), tests/roadmap-t2-2-cash-l4.test.js (new),
  tests/contract/cash-floors-l4.contract.test.js (new), CLAUDE.md, README.md,
  .cycle/plan-t2-2-cash-alerts.md, .cycle/STATE.md

CHANGES:
T2.2-L4 | teller/services/database.js | linked_accounts.low_balance_floor NUMERIC(12,2) (ADD COLUMN IF NOT EXISTS; NULL = none)
T2.2-L4 | teller/routes/enrollments.js | GET /api/accounts selects la.low_balance_floor; PATCH /api/accounts/:id takes low_balance_floor — strict parse, 0-1e7 or null (400 otherwise), cents-rounded; a non-null floor updates only a depository, non-investment account (the UPDATE carries the filter; an existing other account → 400 "needs a checking or savings account", missing → 404); a floor edit clears the cash alerts' off-for-today memo
T2.2-L4 | teller/services/cash-alerts.js | runCashAlerts split into checkFloors + checkProjection under the same switch and "something new" gate; checkFloors: each floored spendable account with a known balance (available, else current) and a balance ≤ 36 h old, below its floor → "Low balance: <name>" / "<name> is at $X, below your $Y floor." (tag balance-floor-<id>, /dashboard) once per 24 h via sentRecently, push only; a stale account is counted, never alerted; an unlogged floor push leaves cash_alerts_checked_at unstamped (status "unlogged") while the projection's state is still saved; last_check.floors_below
T2.2-L4 | teller/views/settings.ejs | Settings → Cash Alerts → "Account Floors": one escaped, aria-labelled floor input + Save per checking / savings account (blank = remove; a negative / non-number refused before the PATCH; writeOk toasts) and the "Last checked …" line from cash_alert_state.last_check (skip reasons in words, floors below counted)
T2.2-L4 | CLAUDE.md / README.md | architecture, feature text, endpoint, DB column, scheduled task, test counts, INV-142, Known Open Issues (T2.2 DONE + L4 follow-ons)

TEST RESULTS: passed — npm test 2083/2083 (Perfin 1532 + Per-sistant 551; 17 new); contract suite 201/201 (3 new); scripts/ci-migration-test.js both apps twice OK; Playwright 57/57 (the Settings click sweep presses the new Save buttons). Mutation checks, each turning the L4 unit file red: `<` → `<=` on the floor compare; dropping the stale-balance skip; stamping on a logged projection alone; dropping the 24 h sentRecently dedup; dropping the PATCH's spendable-account filter; dropping the cents rounding.
REGRESSION RISKS:
  - runCashAlerts now reads linked_accounts for floors on every evaluation it makes (one small query; only while the switch is on and something new arrived or a new local day).
  - The cash alert state UPDATE now writes cash_alert_state even when a floor push was unlogged (stamp held back) — the L2 retry path still works because cash_alerts_checked_at isn't advanced.
  - PATCH /api/accounts/:id now aliases the table (`linked_accounts la`); RETURNING * is unchanged.
INVARIANTS AT RISK: None — INV-77 (away channel, own watermark + memo) and INV-59-style strict validation hold; INV-81 (linked_accounts stays a KEEP table, no new table). New: INV-142.
NET SCORE: 0 production fixes − 0 new failure modes = 0 (one new capability)

OPERATOR ACTIONS / DEPLOY:
- None (auto-migrated column; the feature is off until Settings → Cash Alerts is switched on and a floor is set) | BLOCKS DEPLOY: N
Deploy: Platform, Shell & Auth: Render auto-deploys on push to `main` (after the PR merges).

(Not complete in production until blocking operator actions are done AND
the deploy step is confirmed.)

FOLLOW-ON ITEMS:
- Floors run only while the Low Cash Alert switch is on (no separate switch).
- A floor alert is push-only (no critical-alert email).
- Floors are set in Settings, not on the dashboard account card.
- The last-check line shows only the latest evaluation; a floor account skipped as stale is counted, not named.

DOCUMENTATION UPDATES NEEDED:
- None (folded into this batch)
---END BROAD SCAN IMPLEMENTATION SUMMARY---
