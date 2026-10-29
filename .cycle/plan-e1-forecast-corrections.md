# Cycle 8 E1 — forecast and data corrections (plan, 2026-10-28)

Status: E1a, E1b done (2026-10-29); E1c queued.

Scope: G1 and G5 from the cycle-8 expansion plan (`.cycle/plan-cycle8-expansion.md`).

Goal: the user can correct the cash-flow forecast where the code misreads a recurring item
(G1), and can take back a whole CSV-overlap Resolve in one step (G5).

## What exists (read for this plan)
- **The forecast's bills** (`services/cash-flow.js` getCashFlowInputs): active detected
  subscriptions plus outgoing active, non-dismissed `recurring_transfers`, minus
  `isCardAutopay` (a bill_payment paid into a linked card, or with a card phrase / issuer
  name — cycle-8 F8) and `isInternalMove` (a same-amount credit within 5 days on another
  spendable account — F7). Both are heuristics with known misses (the Batch 2 follow-ons:
  an autopay with no card phrase whose credit posts after 5 days is billed on top of the
  card spending; an unrelated same-amount credit reads as internal). Everything that reads
  the forecast goes through getCashFlowForecast: GET /api/cash-flow, the dashboard summary's
  lowest day, the low-cash alert, the advice plan's 60-day low. So one change there reaches
  them all.
- **recurring_transfers** has `transfer_type` + `transfer_type_user_set` (DC-4, kept by the
  detector's upsert), `is_dismissed`, and routes in routes/subscriptions.js (GET list,
  PATCH dismiss / undismiss / type). **No page shows recurring transfers today** — the
  routes have no UI caller. Dismissing one also removes it from the advice plan's savings
  transfers, goals' suggested_transfers, the insights block and Sheets, so "dismiss" is not
  a forecast-only switch.
- **detected_subscriptions** are all billed in the forecast; there's no way to leave one
  out without dismissing it everywhere.
- **The Cash Flow widget** (dashboard.ejs cashFlowSummaryHtml / cashFlowTableHtml) shows
  totals per week; it never lists which bills it projected.
- **CSV-overlap Resolve** (`POST /api/transactions/csv-overlap/resolve`, routes/
  transactions.js) deletes the paired CSV rows and tombstones each with a snapshot (F4).
  **No page calls it** (API only). Restore is one row at a time
  (`POST /api/deleted-transactions/:id/restore` → restoreDeleted), from Settings → Sync
  Health → Deleted transactions (U2).

## Decisions (proposed; confirm at the first /broad-implement)
1. **One forecast setting per recurring transfer**: `recurring_transfers.forecast_treatment`
   TEXT NOT NULL DEFAULT 'auto', CHECK IN ('auto','bill','internal','ignore') — the value
   list in `CHECK_LISTS` (cycle-8 F31 policy). auto = today's heuristics; bill = always
   billed (overrides isCardAutopay / isInternalMove); internal and ignore = never billed
   (two values so the list can say why). Forecast-only: the advice plan's savings transfers,
   goals, insights, Sheets and the detector are unchanged. The detector's upsert never
   writes it, so it survives re-detection.
2. **Subscriptions get a forecast switch too**: `detected_subscriptions.forecast_ignore`
   BOOLEAN NOT NULL DEFAULT false — left out of the forecast's bills only (still a
   subscription everywhere else). Its merchant stays out of the daily average
   (NOT_SUBSCRIPTION unchanged), so ignoring one removes it from the forecast entirely —
   the point of "ignore".
3. **The forecast says what it did**: getCashFlowInputs keeps every candidate and returns
   `bills` (with source + id + why: auto / user) and `left_out` [{ source, id, name, amount,
   cadence_days, reason: card_autopay | internal | user_internal | user_ignored }];
   projectCashFlow stays pure and reads only `bills`. GET /api/cash-flow adds
   `forecast_items` (both lists) — the old fields unchanged.
4. **Routes**: `PATCH /api/recurring-transfers/:id/forecast { treatment }` and
   `PATCH /api/subscriptions/:id/forecast { ignore }` — strict values (400), 404 unknown;
   each calls cash-alerts.invalidate() so the next hourly check re-evaluates (F12 pattern).
   A rename rule's re-key moves the row in place (keeps the setting); a re-key that
   deactivates the old row loses it (follow-on, like its user state today).
5. **UI**: a collapsible "What's in this forecast" list in the dashboard Cash Flow section:
   each projected bill and each left-out item with its reason in words, and a labelled
   select per transfer (Automatic / Always a bill / Between my accounts / Leave out) and per
   subscription (Include / Leave out). A change saves through writeOk and reloads the Cash
   Flow section (and the summary card's lowest day); a refused save puts the select back.
   This is the first UI for recurring transfers; a full transfers page is out of scope.
6. **G5 — a Resolve is one batch**: `deleted_transactions.batch_id TEXT` (NULL for a single
   delete). Resolve writes one id (`resolve_<ts>_<rand>`) on every row it tombstones and
   returns it. `POST /api/deleted-transactions/batches/:batch_id/restore` restores each row
   through restoreDeleted in ONE transaction; a row restoreDeleted refuses (account gone,
   removed by the bank) stays deleted and is listed in the reply — `{ restored, skipped:
   [{ transaction_id, reason }] }`; an unknown batch is a 404. GET
   /api/deleted-transactions returns batch_id per item and `batches` [{ batch_id, count,
   deleted_at }] for the page.
7. **G5 UI**: Settings → Sync Health → Deleted transactions shows rows that share a batch
   under one header ("Removed by CSV overlap resolve — N rows, <date>") with a labelled
   "Restore all N" (data-e2e-skip not needed — it restores, not destroys). The 50-row paging
   stays per row, so a header can show "N rows (M on this page)". Resolve itself keeps no
   UI (API only — a Resolve page is out of scope).

## Batches
| Batch | Scope | Status |
|-------|-------|--------|
| E1a | G1 server: the two columns (+ CHECK_LISTS entry), getCashFlowInputs honoring them with `bills` / `left_out`, GET /api/cash-flow's `forecast_items`, the two PATCH routes + cash-alerts invalidate; unit tests over a fake pool (each treatment beating each heuristic, the reasons, the strict 400s) and a contract test on real rows (an autopay set to bill is billed, an internal-looking transfer set to bill is billed, a transfer set to ignore isn't, a subscription left out, re-detection keeping the setting, getCashFlowForecast / the dashboard summary moving with it) | done (2026-10-29) |
| E1b | G1 UI: the "What's in this forecast" list in the Cash Flow section (vm tests: rendering, reasons in words, escaping, labels, each select's PATCH through writeOk, a refused save reverting, the reload); e2e: the list renders on the seeded dashboard | done (2026-10-29) |
| E1c | G5: batch_id on deleted_transactions, Resolve writing + returning it, the batch restore route, GET's batch_id / batches, the Settings grouping + "Restore all"; unit tests over a fake client (all restored, a refused row skipped and reported, 404, the transaction), vm tests for the grouping, a contract test (Resolve → restore the batch → rows back with notes / splits, a second restore a no-op, a row the bank removed skipped) | queued |

Order: E1a → E1b → E1c (E1c is independent of the other two and can run first).

## Out of scope / follow-ons
- Incoming transfers and income streams can't be corrected (a deposit misread as pay — the
  payday alerts' "one-off" case); a later item.
- A treatment on a deactivated (stale) transfer has no effect until it's active again.
- No page lists or edits recurring transfers outside the forecast list.
