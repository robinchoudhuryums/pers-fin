---BROAD SCAN IMPLEMENTATION SUMMARY---
Findings implemented:
- FAN-3  (H)    Rent/utility generation stopped 24 months after start_month
- FAN-4  (M-H)  Renaming the payee or a utility label duplicated every past month (balance jump, doubled even-up, reminder per row)
- FAN-9  (M)    Settle Up dropped utilities still awaiting their bill, with no warning, and let the month be marked settled
- FAN-10 (M)    The double-count guard matched utility labels ("Gas" → SHELL GAS) instead of statement merchants (PG&E)
- FAN-11 (L-M)  The Settle Up month picker never defaulted to the prior month in the first week
- FAN-12 (L-M)  Shared-card settlement ignored refunds and included pending charges
- WUI-3  (M)    Settle Up "Review →"/"Rent page", "Import CSV" and "Link an account" links missed the basePath; Activity ignored query-string filters
- PB-2   (M)    Per-sistant's housingDue hid the reminder on the due day and while rent was overdue (two private copies of the math)

Files modified:
- teller/routes/housing.js
- teller/views/housing.ejs
- teller/views/dashboard.ejs
- teller/routes/subscriptions.js
- teller/views/transactions.ejs
- teller/public/transactions.js
- apps/per-sistant/routes/housing-due.js (NEW — shared helper)
- apps/per-sistant/routes/notifications.js
- apps/per-sistant/routes/ai.js
- tests/scan-sept-batch5.test.js (NEW — 17 tests)
- apps/per-sistant/tests/scan-sept-batch5.test.js (NEW — 8 tests)
- apps/per-sistant/tests/health.test.js (test double: the briefing's housing SQL moved into the shared helper)

CHANGES:
FAN-3 | housing.js | New `addMonths` + `generationMonths(start, end, cap=24)`: generation covers the TRAILING 24 months ending this month, never earlier than start_month (the cap used to count forward from the pinned start_month).
FAN-4 | housing.js, housing.ejs | Pure `planConfigUpdate(existing, body)`: a changed payee_name → `payeeRename`; a utility row's `rename_from` (the form now sends the label it loaded with) whose old label existed and is no longer used → `labelRenames`, keeping the old cadence anchor; a brand-new utility with no anchor is anchored at THIS month (it defaulted to start_month and backfilled a placeholder + reminder per past cycle). PATCH /api/housing/config applies the renames to payee_obligations (+ payee_payments for the payee) in one transaction, skipping rows whose new key already exists. Generation is INSERT … SELECT … WHERE NOT EXISTS: a period with any rent row (any payee) or a same-label utility row isn't regenerated. GET /api/housing/ledger and /api/housing/split are scoped to the configured payee.
FAN-9 | housing.js, dashboard.ejs | /api/housing/split returns `awaiting_count` + `awaiting_labels` (the month's pending_amount utilities for the payee). The Settle Up widget shows a "Waiting on …" note linking to /housing#pending and disables "Mark settled" until they're entered.
FAN-10 | housing.js, housing.ejs | Utilities gain `merchant_patterns` (comma-separated in the form, ≤8 × 60 chars, normalized to an array). `buildDoubleCountPattern` uses a utility's statement names when set and falls back to its label. Still word-boundary + regex-escaped (INV-10).
FAN-11 | dashboard.ejs | Month picker selects index `now.getDate() <= 7 ? 1 : 0` (the old nested expression selected nothing in days 1–7).
FAN-12 | subscriptions.js | /api/shared-settlement and its per-account transaction list include non-transfer credits (`t.amount < 0 AND NOT_TRANSFER` — refunds net out of their personal_for bucket; card payments stay out) and require `t.pending = false`. Response adds `refunds_total` and `account_key` (linked_accounts.account_id).
WUI-3 | dashboard.ejs, transactions.ejs, transactions.js | Settle Up "Rent page" / "Review" links and "Enter amount" use `window.BASE_PATH`; "Import CSV" and "Link an account" go to `<basePath>/accounts` (were "/", the shell tile picker). The Review link passes `account_id=<account_key>&month=`. The Activity page gains an Account filter (from /api/accounts) and pre-fills q / category / account_id / month (→ that month's date range) / start_date / end_date / min/max_amount from the query string, opening the filter bar.
PB-2 | apps/per-sistant/routes/housing-due.js, notifications.js, ai.js | One helper: `computeHousingDue(cfg, balance, n, today)` does day-granular math on APP_TIMEZONE 'YYYY-MM-DD' strings (todayStr from routes/health.js), clamps the due day to the real month length, and returns status upcoming / due_today / overdue / unscheduled (overdue = due day passed with a balance owed — surfaced every day until paid). `housingDue(perfinPool)` scopes the balance to the configured payee (matching Perfin's reminder) and is fail-soft; `housingDueSuffix` renders "(due today)" / "(due in N days)" / "(overdue by N days)". Both the notification check (now also returns `status`) and the AI daily briefing use it.

TEST RESULTS: passed — 1249/1249 (Perfin 772 + Per-sistant 477; 50 test files). New Perfin file: 16 of 17 fail on the pre-fix source (worktree run; the 17th — search honors account_id — is a positive control). New Per-sistant file: the 2 integration/pin tests fail on the old notifications/ai code; the 6 pure-helper tests target the new module. Real Postgres 16: 24-month trailing generation (2024-11 → 2026-10 for a 30-month-old start), idempotent re-run, payee + label rename carried 48 rows + the payment to "John" with no duplicates and only this month's new Internet placeholder generated, ledger balance scoped, split awaiting_labels [Electricity, Internet], double-count flags PG&E not SHELL GAS, shared settlement nets a same-month refund and drops the card payment + pending hold (total 125, refunds 200, partner 62.50). Edited EJS inline scripts node --check clean; Playwright e2e 8/8.
Regression scenarios: S2 (shared-card settlement math) — PASS on real PG with the refund/pending change (shared 50% split, partner_share = 50% × net shared). S1/S3/S4/S5/S6 — NOT APPLICABLE (no sync/AI-cap/auth/Sheets/SW change). SK1–SK5 — NOT APPLICABLE.

REGRESSION RISKS:
- FAN-4: the ledger is single-payee, so ANY payee_name change is treated as a rename. Switching to a different landlord relabels the old landlord's history (paid rows + payments) under the new name; rent for a month that already has a rent row isn't generated again.
- FAN-9: "Mark settled" is unavailable while any utility for that month is still awaiting its bill. A bill that will never come must be entered as 0 or its placeholder deleted on the Rent page first.
- FAN-12: settlement totals now net refunds, so `total_charges` can drop (or go negative in a refund-heavy month). Credits whose description hits a NOT_TRANSFER word (e.g. a refund from "DISCOVER") are still excluded.
- The ledger/split payee scoping hides rows under an old payee name that a rename couldn't carry over (key conflict). Those rows remain in the table.
- PB-2: an overdue balance now notifies daily (the client's 12h dedup ledger limits browser re-fires); "unscheduled" (no due day) still surfaces whenever a balance is owed.

INVARIANTS AT RISK: None violated. INV-10: merchant patterns are regex-escaped and \y-anchored. INV-18/19: the new housing helpers are attached after module.exports = router. INV-25/35: housing-due reads perfinPool read-only, never an HTTP self-fetch. INV-48: shared settlement IMPORTS NOT_TRANSFER (no re-inlined copy). INV-08: reimbursed rows still excluded from the settlement.
NET SCORE: 5 − 2 = 3
  Production (would have fired this month): FAN-9 YES, FAN-11 YES (first week of every month), FAN-12 YES, WUI-3 YES (Review link 404s under the shell), PB-2 YES (every due day); FAN-3 NO (start_month is <24 months old), FAN-4 NO (needs a rename), FAN-10 NO (needs a utility on the shared card).
  New failure modes: payee change = rename (no landlord switch), and Mark settled held while bills are awaited = 2 (both documented above).

OPERATOR ACTIONS / DEPLOY:
- None required: no schema change (merchant_patterns lives in the housing_config JSONB). | BLOCKS DEPLOY: N
- Optional: on the Rent page, add each utility's statement merchant names (e.g. "PG&E") so the Settle Up double-count check can match it; until then the label is used. | BLOCKS DEPLOY: N
Deploy: Platform, Shell & Auth — Render auto-deploys on push to `main` (alt: `fly deploy`). No Sheets/Apps Script change.

(Not complete in production until blocking operator actions are done AND
the deploy step is confirmed.)

FOLLOW-ON ITEMS:
- Switching landlords isn't modeled: the ledger is single-payee, and a payee change is a rename (FAN-4 trade-off). A real multi-payee or "new payee from month X" flow would be a feature.
- Perfin's own runHousingReminders still uses server `new Date()` day-of-month (no overdue-vs-upcoming distinction, UTC) — scheduled under FAN-13 (Batch 6).
- The Settle Up widget's other silent write failures (Mark settled/Undo don't check res.ok) are WUI-6 (later batch).
- The double-count guard's 3-character minimum still drops a 2-character payee name; explicit merchant patterns are the workaround.
- Shared-settlement netting relies on NOT_TRANSFER's keyword list to tell refunds from card payments; Plaid PFC TRANSFER_IN credits are already excluded, Teller credits rely on the description.

DOCUMENTATION UPDATES NEEDED:
- CLAUDE.md Rent & Utilities ledger: trailing-24-month generation, rename propagation (rename_from, payee change = rename), new-utility anchoring, NOT EXISTS generation guard, ledger/split scoped to payee, utilities[].merchant_patterns in housing_config, split awaiting_count/awaiting_labels.
- CLAUDE.md Settle Up widget: awaiting-bill note + Mark settled gate; prior-month default (now actually works); shared-card leg nets refunds and excludes pending.
- CLAUDE.md endpoints: GET /api/housing/split (awaiting fields), GET /api/shared-settlement (refunds_total, account_key, pending/refund semantics), GET /api/housing/ledger (payee-scoped); Activity page query params + Account filter.
- apps/per-sistant/CLAUDE.md: routes/housing-due.js shared helper (status upcoming/due_today/overdue/unscheduled, APP_TIMEZONE, payee-scoped); housing_due notification gains `status`; test count 469 → 477.
- Test counts: 1249 across 50 files (Perfin 772 + Per-sistant 477).
---END BROAD SCAN IMPLEMENTATION SUMMARY---
