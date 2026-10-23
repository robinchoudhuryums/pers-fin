# Roadmap T2.2 — Low-balance and payday alerts (plan, 2026-10-22)

Goal: the cash-flow forecast reaches you. A push when your cash is projected to fall
below a floor within N days, when an account's current balance is below its floor, when
a paycheck lands, and when an expected payday passes without one. All are "away"
channels (INV-77): never activity-gated, bounded by their own watermarks / dedup. All
default OFF.

## What exists (read for this plan)
- `GET /api/cash-flow` (routes/spending-analytics.js) projects day by day: starting
  balance = depository, non-investment cash (FAN-5); income = `getLiveIncomeStreams`
  projected with `incomeEventsBetween` (F34); bills = active subscriptions + outgoing
  recurring transfers minus card autopays (DD-4) via `seriesOccurrences`; spending =
  60-day per-weekday averages without subscription merchants. The whole projection is
  INLINE in the route; it returns only weekly totals (a mid-week low is invisible) and
  anchors "today" with `now.toISOString()` — UTC, the F11 class the timezone lint misses
  because it isn't written `new Date().toISOString()`.
- Away-job pattern: `startup.js` (`awaySettledToday` / `markAwaySettled`, `jobHealth`
  tick + result, `JOB_INTERVALS_MS`), `sentRecently(tag, hours)`, `sendToAll` (returns
  `logged`), `sendCriticalAlertEmail` (opt-in).
- `runPostSyncSteps(added)` runs after every transaction sync that added rows —
  `syncAllTransactions` AND the webhook per-item / per-enrollment syncs (T2.1) — so a
  hook there is near-real-time once webhooks are on.
- Income streams: `{ source, amount (median), cadence, days, anchor, last, count }`;
  `last` is the newest deposit of that amount cluster; `isIncomeStreamLive` keeps a
  stream ≤ 35 days old (≤ 50 monthly) — long enough to notice a missed payday.

## Decisions (accepted with /broad-implement L1)
1. **The projection alert is on TOTAL spendable cash** (all depository, non-investment
   accounts), the same figure the forecast shows. Income streams and bills carry no
   account, so a per-account projection isn't possible without new modelling. The
   per-account risk (checking about to overdraw while savings is fine) is covered by a
   separate CURRENT-balance floor per account (L4), not a projection.
2. **Alerts need fresh data.** No low-balance alert when the newest balance data is
   older than 36 h, and no missed-payday alert unless a transaction sync with no error
   for that provider ran after the payday's grace window — a stale or failing sync must
   not read as "your paycheck didn't arrive". A skip is recorded as the job's outcome
   reason, not an alert.
3. **Missed payday = a live stream's expected date + 3 days of grace passed with no
   deposit from that SOURCE (any amount) since expected − 3 days.** "Any amount" stops a
   raise (a new amount cluster) reading as a missed check; −3 days covers pay that
   arrives early before a weekend or holiday. One alert per (stream, expected date).
4. **Paycheck landed = a new deposit (created after a watermark) that matches a live
   stream** (same source, ±10%). One-off income (refunds, transfers in, a first
   paycheck from a new job) doesn't notify — streams need 2 deposits. Runs from
   `runPostSyncSteps`, so reconcile never triggers it (INV-05 pattern).
5. **Dedup.** Projected low cash: once when a breach appears, again only if the breach
   date moves ≥ 3 days earlier or 72 h pass while it persists (state in
   `user_settings.cash_alert_state`); recovery is silent. Account floor: once per
   account per 24 h while below. Payday events: once per tag (`payday-<hash>-<date>`,
   `payday-missed-<hash>-<date>`).
6. **Email**: low projected cash and a missed payday also send the opt-in
   critical-alert email (`critical_alert_emails_enabled`), only when the notification
   was logged (the F24 rule). A landed paycheck is push only.
7. **Fixing the forecast's UTC "today"** (and the per-day `toISOString()` dates) to
   APP_TIMEZONE is part of L1 — the alerts must not disagree with the widget by a day.
   It changes `/api/cash-flow`'s day boundaries west/east of UTC; nothing else.

## Batches (broad-implement sized)
| Batch | Scope | Status |
|---|---|---|
| L1 | **Projection as a service.** Move the forecast out of the route into `services/cash-flow.js`: `getCashFlowInputs(pool, { today })` (the five queries — streams, subscriptions, transfers, balances, weekday averages) and a PURE `projectCashFlow(inputs, { days, today })` → the current response fields + daily `projection[]` internally + `lowest: { date, balance }` + `firstBelow(threshold)`. "Today" = `todayStr()`, day stepping on calendar dates (cadence helpers), not `toISOString()`. `GET /api/cash-flow` becomes a thin wrapper; its response keeps every field and adds `lowest_balance` / `lowest_balance_date`. Dashboard Cash Flow line shows "Lowest projected: $X on <date>". Tests: the pure function over canned inputs (bills, semimonthly income, autopay skipped, weekday averages, a breach), a vm-free route parity check, the timezone pin (TZ west of UTC), contract on real rows. | DONE (services/cash-flow.js; lowest_balance / lowest_balance_date) |
| L2 | **Low projected cash alert.** Settings `cash_alert_enabled` (default false), `cash_alert_threshold` (≥ 0, default 500), `cash_alert_horizon_days` (7–60, default 14), state `cash_alert_state` JSONB + `cash_alerts_checked_at`; PATCH validation (INV-59). `runCashAlerts(pool, { now })` in `services/cash-alerts.js`: freshness gate (decision 2), `projectCashFlow`, decision-5 dedup, push "Cash projected to drop to $X on <date>" (tag `cash-low`, `/dashboard#cashflow-section`) + opt-in email. Away job `cash-alerts` in startup.js: hourly tick, NOT activity-gated, evaluates when the newest data stamp (`last_txn_sync_at`, `last_balance_sync_at`, any connection's `last_synced_at`) is newer than `cash_alerts_checked_at`, else at most once per local day; `JOB_INTERVALS_MS` entry; outcome via `jobHealth.result`. Settings → Notifications "Cash alerts" form. | DONE (services/cash-alerts.js; opens /dashboard — the hash link was dropped) |
| L3 | **Payday alerts.** `payday_alerts_enabled` (default false) + watermark `last_income_alert_at`. Landed: a third step in `runPostSyncSteps` (after the anomaly check, same serialized chain, never rejects) — new income deposits (`INCOME_PREDICATE`, `created_at` > watermark) matched to a live stream → push "Paycheck: $X from <source>" (tag per deposit); the watermark is held back if a send throws (the anomaly-watermark rule). Missed: inside `runCashAlerts` (so it rides L2's job) — decision 3 + the sync-freshness half of decision 2 → push + opt-in email (tag per stream + expected date). Settings toggle. | PLANNED |
| L4 | **Account floors + visibility + docs.** `linked_accounts.low_balance_floor NUMERIC(12,2)` (NULL = none; depository, non-investment only), `PATCH /api/accounts/:id { low_balance_floor }` (≥ 0 or null, 400 otherwise); `runCashAlerts` checks each floored account's current balance (available, else current) — push once per account per 24 h (tag `balance-floor-<id>`, `/dashboard`). Settings "Cash alerts" lists depository accounts with a floor input; the section shows the last evaluation (`cash_alerts_checked_at`, a skip reason such as "balances 2 days old"). reset-fresh classification for the new columns (INV-81 — `user_settings` is reset, `linked_accounts` kept: the floor survives). New invariant; CLAUDE.md / README; Known Open Issues. | PLANNED |

Each batch: unit tests + a contract file on real Postgres, migration test when the
schema changes, Playwright when a page changes, mutation checks.

## New invariant (L4)
INV-142 | Cash and payday alerts are away channels driven by the shared forecast
(`projectCashFlow` — the same numbers as `/api/cash-flow`) and never fire on stale
data: no balance alert when balances are older than 36 h, no missed-payday alert
without an error-free transaction sync after the grace window; each is deduped
(projected low: state; floors: 24 h; payday: per expected date / deposit); reconcile
never triggers a landed-paycheck alert.

## Trade-offs to state in the docs
- The forecast spends the 60-day weekday average every day and bills card autopays as
  already spent (DD-4), so the projected line is smooth: a real dip on autopay day can
  be deeper than projected. The account floor (L4) is the precise, non-projected guard.
- A paycheck that moves to a new source name (employer rename, a new payroll provider)
  reads as missed once; renaming the deposit (merchant rename rules) fixes it.
- Monthly streams use a 30-day step in `incomeEventsBetween` (existing), so a monthly
  payday can drift a day or two; the 3-day grace absorbs it.
- With webhooks off, "landed" arrives with the next sync (daily backstop / auto-sync),
  not in minutes.

## Out of scope
Per-account projections; alerts for credit-card balances or utilization; a cash
threshold per day of month; SMS. Per-sistant tasks from these alerts are roadmap 2.4.
