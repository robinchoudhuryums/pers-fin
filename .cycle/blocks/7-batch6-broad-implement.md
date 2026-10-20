---BROAD SCAN IMPLEMENTATION SUMMARY---
Findings implemented:
- F20  Deleted transactions came back — the Teller 7-day lookback, the weekly reconcile and Plaid reconciles re-inserted them, undoing the duplicate cleanup (and their splits were gone) — DELETE /api/transactions/:id records the id in a new deleted_transactions table (same transaction), and the Teller and Plaid upserts skip a tombstoned id
- F21  CSV-overlap matched on amount ±2 days only — no merchant check, no one-to-one pairing — so "Resolve" could delete genuine CSV rows (two different $4.50 coffees; one synced row matching every same-amount CSV row near it) — candidates are paired in JS (pairOverlaps): merchant-similar only (shared token or ≥4-letter prefix, noise words ignored; the synced row's raw description is tried too), one CSV row per synced row and vice versa per account pair, closest date first; GET counts and Resolve deletes the same pairs
- F45  The ICS feed capped the rent due day at 28 and flagged a rent due on the 29th–31st OVERDUE before it was due — the due day is clamped to the period's real month length
- F59  The ICS feed had no RFC 5545 line folding — SUMMARY lines are folded at 75 octets on UTF-8 character boundaries (icsFold)
- F56  After "Undismiss" an item was in neither list until the next detection run (detection keeps dismissed rows inactive) — undismiss sets is_active (subscriptions: unless cancelled)
- F57  bill-calendar?month=13 → 500; manual-bill due_day "abc" → 500; search LIKE unescaped; manual transaction date "2026-13-45" → 500; UTC defaults — calendarMonthParams (APP_TIMEZONE default, 400 on an impossible year/month) for bill-calendar + bill-payments; integer due_day; search LIKE escaped (ESCAPE '\') and start/end dates validated; cadence.isValidYmd for the manual transaction date; POST /api/subscriptions uses todayStr()
- F58  Dead artifacts (each re-verified unreferenced): cadence.firstOnOrAfter removed; the detect-subscriptions "n8n variant" usage note replaced by the real in-process caller; the stale buildBillCalendarIcs header rewritten; categorize.js's unused estimateCostGranular import removed
New capabilities (G/ST): None
Files modified:
- teller/services/database.js, teller/services/cadence.js
- teller/routes/enrollments.js, teller/routes/investments.js, teller/routes/transactions.js, teller/routes/subscriptions.js, teller/routes/categorize.js
- scripts/detect-subscriptions.js, scripts/reset-fresh.js
- tests/scan-oct-batch6.test.js (new), tests/contract/delete-feeds.contract.test.js (new), tests/scan-sept-batch4.test.js, tests/coverage-gaps.test.js

CHANGES:
F20  | database.js, transactions.js, enrollments.js, investments.js, reset-fresh.js | CREATE TABLE deleted_transactions (transaction_id PK, deleted_at); DELETE route = transaction (delete + tombstone); both upserts → INSERT … SELECT (explicit casts) WHERE NOT EXISTS deleted_transactions … ON CONFLICT (RETURNING (xmax = 0) unchanged — a skipped row returns no row, so it isn't counted and isn't a page failure); WIPE_TABLES
F21  | transactions.js | OVERLAP_CANDIDATES_SQL (per-pair rows with both merchants + the synced raw name) shared by GET and resolve; merchantTokens / merchantsSimilar / pairOverlaps (exported test seams); GET aggregates per account pair in JS (≥3 pairs); resolve deletes only paired CSV ids
F45  | subscriptions.js | Math.min(daysInMonth(y, m − 1), due_day) (cadence.daysInMonth)
F59  | subscriptions.js | icsFold() on the SUMMARY line; exported as a test seam
F56  | subscriptions.js | undismiss: subscriptions `is_active = (cancelled_at IS NULL)`, transfers `is_active = true`
F57  | subscriptions.js, transactions.js, cadence.js | calendarMonthParams; Number.isInteger due_day; LIKE escape + ESCAPE '\'; isValidYmd (exported) for search dates + manual date; todayStr() in POST /api/subscriptions
F58  | cadence.js, detect-subscriptions.js, subscriptions.js, categorize.js | removals / comment rewrites as listed

TEST RESULTS: passed — npm test 1583/1583, 0 todo (+10 in tests/scan-oct-batch6.test.js, all failing against the pre-fix code). Contract suite 75/75 on local PG16 without pgvector (+7 in tests/contract/delete-feeds.contract.test.js, all failing pre-fix — a real Teller reconcile and Plaid re-delivery after a delete, the coffee / one-to-one overlap case, a 30th-of-month rent in the ICS, folded UTF-8 summaries, Undismiss, the 400s and a literal "50% off" search). scripts/ci-migration-test.js passes (twice). Playwright 35/35. Updated test doubles: scan-sept-batch4 DC-5 (the GET pin no longer expects SELECT DISTINCT; the resolve mock returns paired candidate rows with merchants and is matched before the linked_accounts branch — the candidate SQL also reads linked_accounts); coverage-gaps (the categorize cap pin asserted the dead estimateCostGranular import — now asserts the shared monthAiSpendCents reader).
REGRESSION RISKS:
- F20: a deleted transaction can only come back by hand (there's no undelete); a CSV row deleted by hand IS re-added by re-importing the same file (CSV imports don't check the tombstone — the preview counts it as new).
- F21: overlap detection is more conservative — a real duplicate whose CSV and synced merchant strings share no word (and no 4-letter prefix) is no longer found, so it stays double-counted until resolved another way (better than deleting a genuine row). Same-amount pairs beyond the first are no longer double-matched.
- F57: callers passing an out-of-range month or a non-integer due_day now get 400 instead of a 500; the calendar's default month follows APP_TIMEZONE (UTC by default — unchanged there).
- F56: an undismissed stale series is active until the next detection run's stale sweep retires it.
INVARIANTS AT RISK: None violated. INV-01 / INV-54 kept (re-sync adds 0; a tombstoned row is neither inserted nor counted; the contract re-sync tests stay green). INV-04 kept (a skipped tombstoned row is not a failed page — the cursor still advances). INV-06 unchanged. INV-81 kept (deleted_transactions in WIPE_TABLES). INV-10 kept (search LIKE escaped). INV-70 kept.
NET SCORE: 0 − 0 = 0 (none had evidence of firing this month — no production data was examined; no new failure mode beyond the documented, more conservative overlap matching.)

OPERATOR ACTIONS / DEPLOY:
- None | BLOCKS DEPLOY: N
Deploy: Platform, Shell & Auth — Render auto-deploys on push to `main` (merge the PR); alt `fly deploy`.

(Not complete in production until blocking operator actions are done AND the deploy step is confirmed.)

FOLLOW-ON ITEMS:
- No undelete for a deleted transaction (the tombstone would need clearing) — a small route + Activity-page action if wanted.
- CSV re-import doesn't honor deleted_transactions (and the preview would disagree if it did) — decide whether a hand-deleted CSV row should stay deleted on re-import.
- Plaid's upsertTxn still builds the legacy category as a "{a,b}" string (now cast ::text[] in the INSERT … SELECT; the DC-14 class remains — already in Known Open Issues).
- The other calendar views (Per-sistant) weren't in scope.
DOCUMENTATION UPDATES NEEDED:
- CLAUDE.md: deleted_transactions table (Database section, reset-fresh WIPE list, DELETE /api/transactions/:id endpoint text, the Teller/Plaid sync design decisions — "upserts skip a user-deleted id"); CSV-overlap endpoint text (merchant-similar, one-to-one; transactions.js architecture note); ICS feed (real month clamp for rent, RFC 5545 folding) in the /calendar.ics endpoint text + Rent ledger bullet; Undismiss behaviour (Subscription detection / Recurring Transfer Detection); F57 400s (bill-calendar / bill-payments / manual-bills POST / search / manual txn) + APP_TIMEZONE defaults; cadence.js no longer has firstOnOrAfter (architecture note lists it? check) + isValidYmd; test counts 1583 / 73 files (Perfin 1127) + scan-oct-batch6 + the delete-feeds contract file; contract count 75; possibly a new invariant (a user-deleted transaction is never re-inserted by a provider sync).
- README.md: counts; Batch 6 summary line.
---END BROAD SCAN IMPLEMENTATION SUMMARY---
