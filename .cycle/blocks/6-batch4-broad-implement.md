---BROAD SCAN IMPLEMENTATION SUMMARY---
Findings implemented:
- DC-2  (H)   Stopped subscriptions/transfers were re-activated on every detection run
- DC-8  (M)   Any two similar purchases the right distance apart were flagged as a subscription
- DC-7  (M)   A >10% subscription price increase was hidden (the old price was reported)
- DC-9  (M)   Calendar / ICS / forecast / cash-flow stepped every cadence in fixed 30-day blocks (drift, double-booked months)
- DC-10 (M)   Bill-calendar income showed one averaged event per month for biweekly/semimonthly pay
- DC-4  (M)   A user's transfer-type reclassification was overwritten by the next detection run
- DC-5  (M)   CSV-overlap tool could never find CSV rows; its resolve step could delete manual cash entries (merged BSI-13)
- DC-6  (M)   CSV import overwrote a manual account's balance with the net of every CSV row ever imported (merged BSI-14)
- SXE-11 (L-M) Bills marked paid from the calendar had no amount → Sheets Payments Log flagged every row −100%
- DC-15 (L)   Manual-bill PATCH stored NaN; manual cash didn't enforce an is_manual account; import rows_skipped ≠ preview; quarterly/yearly manual-bill anchors differed between calendar and ICS; AI categorize ignored user_merchant_name

Files modified:
- teller/services/cadence.js (NEW — pure calendar-month cadence stepping, series/manual-bill/income-stream projection)
- scripts/detect-subscriptions.js
- scripts/detect-transfers.js
- teller/services/database.js
- teller/routes/subscriptions.js
- teller/routes/spending-analytics.js
- teller/routes/transactions.js
- teller/routes/categorize.js
- teller/views/accounts.ejs
- scripts/sheets-sync.js
- tests/scan-sept-batch4.test.js (NEW — 30 behavioral/pin tests)
- tests/detect-subscriptions.test.js (test double → real module)
- tests/manual-cash-settlement.test.js, tests/scan-sept-batch3.test.js (test doubles: account lookup now returns is_manual)

CHANGES:
DC-2 | scripts/detect-subscriptions.js, scripts/detect-transfers.js | New exported `isStale(lastDate, cadence)` (same max(120d, 1.5×cadence) window as the stale sweep). A matched pattern whose last charge is stale is skipped in JS, so the upsert (whose is_active CASE only honors cancelled/dismissed) can no longer re-activate a row the sweep just retired from 36 months of history.
DC-8 | scripts/detect-subscriptions.js | Match now requires (a) the LATEST gap to match the cadence, (b) a true majority via Math.ceil(gaps × 0.5) (floor let 1-of-2 / 1-of-3 through), and (c) for 2-charge (≥60-day) detection, amounts within ±2%. Subscriptions only (the finding's location).
DC-7 | scripts/detect-subscriptions.js | New `findAnchorAmount`: anchor on the most recent amount's ±10% cluster when it has ≥ minOcc charges, else the global mode. prior_amount = the merchant's previous charge overall. The persisted row still flags the change via the upsert's `amount_changed = (EXCLUDED.amount != stored amount)`.
DC-9 | teller/services/cadence.js, scripts/detect-*.js, teller/routes/subscriptions.js, teller/routes/spending-analytics.js | cadence 30/60/90/365 step by 1/2/3/12 CALENDAR MONTHS, keeping the anchor day clamped per month (Jan 31 → Feb 28 → Mar 31); 7/14 still step in days. Detection next_expected (both detectors), POST /api/subscriptions, /api/forecast, /api/bill-calendar, /calendar.ics and the /api/cash-flow bill schedule use it. Projections anchor on the REAL last charge (last_charged / last_transferred) with next_expected as the lower bound (`seriesOccurrences`), so a 31st-billed sub doesn't drift to the 30th via a clamped stored next_expected. A 0/NaN cadence yields [] (no hang).
DC-10 | teller/services/cadence.js, teller/routes/subscriptions.js | Calendar income: raw deposits (4 months, COALESCE(user_merchant_name, merchant_name, name) as source) clustered per source by amount ±10%, cadence classified from gaps (weekly ≤10d; ≤20d → semimonthly when gaps aren't a steady 13–15 AND days-of-month form two tight clusters of ≥2, else biweekly; ≤45d monthly; longer not projected), median amount, projected into the month; a stream whose last deposit is >35d (>50d monthly) old is not projected.
DC-4 | teller/services/database.js, teller/routes/subscriptions.js, scripts/detect-transfers.js | New column recurring_transfers.transfer_type_user_set BOOLEAN NOT NULL DEFAULT false (idempotent ADD COLUMN). PATCH /api/recurring-transfers/:id/type sets it; the detector upsert keeps a user-set type (CASE WHEN transfer_type_user_set THEN existing ELSE EXCLUDED).
DC-5 | teller/routes/transactions.js | GET csv-overlap identifies CSV accounts via plaid_items.status='CSV' (not is_manual), the synced side as Teller or a non-CSV Plaid item, and counts/sums DISTINCT CSV rows (a CSV row matching two synced rows counted twice). Resolve requires the CSV side to be a status='CSV' account (a manual cash account now 400s instead of having hand entries deleted) and refuses a CSV account as the "synced" side.
DC-6 | teller/routes/subscriptions.js | The name-matched manual account's balance is ROLLED FORWARD by only this import's genuinely-inserted rows dated after its balance_updated_at (credit: +net; depository: −net); an account with no known balance is left alone. No more all-time CSV net overwrite.
SXE-11 | teller/routes/subscriptions.js, scripts/sheets-sync.js | POST /api/bill-payments defaults paid_amount to the bill's amount (manual_bills / detected_subscriptions) when omitted; non-numeric paid_amount → 400. Sheets Payments Log blanks Paid Amount + Variance for legacy NULL-amount rows.
DC-15 | teller/routes/subscriptions.js, teller/routes/transactions.js, teller/routes/categorize.js, teller/services/cadence.js, teller/views/accounts.ejs | PATCH /api/manual-bills 400s a non-finite/≤0 amount or out-of-range due_day (was stored as NaN / silently ignored). POST /api/transactions/manual 400s a non-manual account. Import: rows_skipped = unparseable only (duplicates in rows_duplicate — matches the preview); csv_imports history keeps skipped+duplicates; accounts page shows both. One manual-bill placement rule (`manualBillOccurrences`: creation month + due_day, clamped to the real month length) for the calendar AND the ICS feed (ICS used to cap at day 28 and anchor quarterly/yearly on "this month"). AI categorize batch sends COALESCE(user_merchant_name, merchant_name, name).

TEST RESULTS: passed — 1224/1224 (Perfin 755 + Per-sistant 469; 48 test files). New tests/scan-sept-batch4.test.js (30 tests): 23 fail on the pre-fix source (stash check with cadence.js kept); the other 7 are pure cadence-helper tests or positive controls. tests/detect-subscriptions.test.js now drives the REAL detectSubscriptions over a mock pool (it previously inlined a copy of the old logic, so it passed regardless of the module). Real Postgres 16: migrations twice (idempotent), DC-4 column + user type surviving re-detection, DC-2 stale row stays inactive, DC-5 overlap (distinct count 3, sum 146.75, manual refused, dry-run 3), DC-6 roll-forward (1000 → 980; re-import no-op, rows_duplicate 2 / rows_skipped 0), DC-10 biweekly income on the calendar, SXE-11 default 60.00, ICS quarterly 31st → Sep 30/Dec 31/Mar 31/Jun 30, /api/forecast + /api/cash-flow keep a 31st-billed sub on month-ends (Sep 30, Oct 31, Nov 30). Playwright e2e 8/8. accounts.ejs inline scripts node --check clean.
Regression scenarios: S1 (re-sync idempotent) — NOT APPLICABLE (no sync-path change); S2 settlement — NOT APPLICABLE; S3 AI cap — NOT APPLICABLE (categorize change is the merchant column only); S4 embedded auth — NOT APPLICABLE; S5 Sheets isolation — PASS by construction (Payments Log formatting change only, inside its existing per-tab try/catch); S6 offline — NOT APPLICABLE.

REGRESSION RISKS:
- DC-8 latest-gap rule: a monthly sub whose most recent charge is >7.5 days late (e.g. a billing-date move) isn't re-matched on THAT run; the existing row just isn't refreshed (not deactivated unless it goes stale) and re-matches on the next on-time charge. One-cycle blip.
- DC-7: a merchant with two concurrent subscriptions at different prices (e.g. two App Store subs) now anchors on whichever cluster is latest with ≥ minOcc charges instead of the global mode — can alternate between runs, producing amount_changed noise. (Only one sub per merchant was ever detected, before and after.)
- DC-6: a manual account with no balance_updated_at no longer gets any balance from a CSV import (previously set — to a wrong value). Set it once manually.
- /api/forecast now includes a charge due today (days_away 0); the old loop skipped anything earlier than "now" (same day included).
- DC-10: a past month viewed after an income stream ended no longer shows that stream (liveness is relative to today).
- Detection behavior is intentionally stricter; some previously-detected coincidental "subscriptions" will stop refreshing and age out via the stale sweep.

INVARIANTS AT RISK: None violated. INV-06 (user overrides never clobbered) strengthened by DC-4. INV-10 (word-boundary keyword filters) untouched. INV-12/13 (user_category writes, rules before AI) unchanged — DC-15 only changes the merchant string sent to AI. INV-01 (inserts-only counts) preserved — CSV rows_imported still counts rowCount>0 inserts. INV-17 (transactional migrations) — the new column is an idempotent ADD COLUMN IF NOT EXISTS inside the migration transaction. Candidate new invariants: INV-70 "recurring projections (forecast, bill calendar, ICS, cash flow, detection next_expected) step month-scale cadences by calendar month via services/cadence.js, anchored on the last real charge — never a fixed N×86400000 step"; INV-71 "detection never re-activates a series whose last charge is past the stale window, and never overwrites a user-set transfer_type".
NET SCORE: 7 − 1 = 6
  Production (would have fired this month): DC-2 YES, DC-8 YES, DC-7 YES, DC-9 YES, DC-10 YES, DC-5 YES, SXE-11 YES; DC-4 NO (needs a manual reclassification), DC-6 NO (needs a name-matched manual account), DC-15 NO (edge cases).
  New failure modes: DC-8 latest-gap one-cycle blip (documented above) = 1.

OPERATOR ACTIONS / DEPLOY:
- None required: the transfer_type_user_set column is an idempotent auto-migration; stale rows retire and prices re-anchor on the next detection run (daily-sync.yml / the insights chain run detection automatically). | BLOCKS DEPLOY: N
- Optional: trigger POST /perfin/api/detect and /perfin/api/detect-transfers once after deploy to apply the stricter rules immediately. Existing bill_payments rows with NULL paid_amount stay NULL (the Sheets log now shows them blank rather than −100%). | BLOCKS DEPLOY: N
Deploy: Platform, Shell & Auth — Render auto-deploys on push to `main` (alt: `fly deploy`). Sheets & External Export — server-side sheets-sync.js ships with the Render deploy (apps-script/ untouched; no clasp push needed).

(Not complete in production until blocking operator actions are done AND
the deploy step is confirmed.)

FOLLOW-ON ITEMS:
- tests/detect-transfers.test.js still inlines a copy of the transfer gap analysis instead of driving detectRecurringTransfers (the same test-quality issue fixed here for subscriptions).
- DC-8/DC-7 were scoped to subscriptions; the transfer detector still uses the floor-majority, no latest-gap check, and the global-mode amount.
- /api/cash-flow's own recurring-income model (typical_day / 14- / 7-day modulo) is separate from the calendar's new stream model and has no semimonthly support; could share cadence.buildIncomeStreams.
- ICS housing obligations still clamp due_day at 28 (the manual-bill clamp was fixed; housing wasn't in scope).
- The CSV-import balance update runs inside the import transaction under a swallowing try/catch — a failing query there aborts the whole transaction (pre-existing; should use a SAVEPOINT).
- The legacy frozen plaid/server.js detection insert is untouched.

DOCUMENTATION UPDATES NEEDED:
- CLAUDE.md architecture tree: add teller/services/cadence.js.
- CLAUDE.md Subscription detection: DC-2 recency skip, DC-8 latest-gap + ceil majority + ±2% two-charge rule, DC-7 recent-cluster anchor; Recurring Transfer Detection: DC-2 skip + transfer_type_user_set (DC-4); Database: new recurring_transfers.transfer_type_user_set column.
- CLAUDE.md bill calendar / forecast / cash-flow / /calendar.ics: calendar-month stepping anchored on the last charge; cadence-based income streams (DC-10); ICS manual bills now share the calendar's creation-anchored placement (the "quarterly/yearly = next occurrence" wording is stale) with real month-length clamping.
- CLAUDE.md csv-overlap endpoint docs (status='CSV', distinct counts, resolve refuses manual accounts); CSV import (rows_skipped semantics, manual-balance roll-forward); POST /api/bill-payments default paid_amount; PATCH /api/manual-bills validation; Sheets Bill Payments Log blank variance.
- CLAUDE.md test counts (1224 across 48 files; Perfin 755) + the scan-sept-batch4 test-file description; Invariant Library candidates INV-70/INV-71.
---END BROAD SCAN IMPLEMENTATION SUMMARY---
