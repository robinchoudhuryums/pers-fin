---BROAD SCAN IMPLEMENTATION SUMMARY---
Findings implemented: the E1 follow-ons (cycle-8 expansion E1, `.cycle/plan-e1-forecast-corrections.md`):
- FO-a: tests/contract/cash-flow-l1's card-autopay seed used a "same day last month" that doesn't exist on the 29th–31st (NULL → INSERT failed on Oct 29)
- FO-b: a rename rule's re-key that deactivates an old transfer / subscription row lost the user's forecast setting
- FO-c: PATCH /api/recurring-transfers/:id/forecast accepted an incoming transfer (a setting that never does anything)
- FO-d: `npm run test:e2e` couldn't find a browser in the cloud container (needed a throwaway config)
- FO-f: Settings' "Restore all N" counted rows that can't come back (account gone / removed by the bank)
- FO-g: the batch restore counted a lifted legacy tombstone (no snapshot) as restored, and a legacy manual entry's refusal as "account_gone"
- FO-h: Resolves run before E1c had no batch id, so they could only be restored one row at a time
- E2e test fix: the E1b e2e check depended on the seeded subscription not being dismissed, which the Subscriptions page's click sweep does earlier in a full run
New capabilities (G/ST): None (E2 planned, not implemented — `.cycle/plan-e2-scheduler-watermarks.md`)
Files modified: teller/routes/merchant-rename.js, teller/routes/subscriptions.js, teller/routes/transactions.js, teller/services/database.js, teller/views/settings.ejs, e2e/playwright.config.js, e2e/pages.spec.js, tests/contract/cash-flow-l1.contract.test.js, tests/cycle8-e1a.test.js, tests/cycle8-e1c.test.js, tests/cycle8-e1-followons.test.js (new), tests/contract/e1-followons.contract.test.js (new), .cycle/plan-e2-scheduler-watermarks.md (new), .cycle/plan-cycle8-expansion.md, .cycle/plan-e1-forecast-corrections.md, .cycle/STATE.md

CHANGES:
FO-a | tests/contract/cash-flow-l1.contract.test.js | the autopay row's day found by the same monthBefore loop as the other rows
FO-b | teller/routes/merchant-rename.js | rekeyDetectedRows copies forecast_ignore = true / the transfer's forecast_treatment from an ACTIVE old-key row onto the surviving new-key row (same cadence[, direction]) while that row is still on the default, before the old row is deactivated
FO-c | teller/routes/subscriptions.js | the UPDATE is `WHERE id = $2 AND direction = 'outgoing'`; no row → a SELECT tells a 400 ("Only an outgoing transfer is in the forecast") from a 404
FO-d | e2e/playwright.config.js | PW_CHROMIUM_PATH (env) sets use.launchOptions.executablePath; unset in CI
FO-f | teller/routes/transactions.js, teller/views/settings.ejs | GET /api/deleted-transactions' batches carry `restorable` (no bank_removed_at, a snapshot, its account still linked); the header shows "Restore all R", notes "N − R can't come back", and no button when R = 0 (an older reply without the field reads as all)
FO-g | teller/routes/transactions.js, teller/views/settings.ejs | a `cleared` result is counted as `cleared` (returned when non-zero) and named in the message; a refusal with returns_on "never" is reason `unrestorable`
FO-h | teller/services/database.js | the migration gives each group of 2+ csv snapshot tombstones sharing one deleted_at (a pre-E1c Resolve's transaction) the id `resolve_<md5(deleted_at)[0:12]>_legacy`; only NULL rows, so a re-run changes nothing
E2e | e2e/pages.spec.js | the E1b check undismisses the seeded Streamflix (through the route) before reading the list

TEST RESULTS: npm test 2972/2972 (11 new in tests/cycle8-e1-followons.test.js; cycle8-e1a's "neither detector writes the setting" pin narrowed to the two copy statements in merchant-rename; cycle8-e1c's batches reply now carries `restorable`). Contract 295/296 — new e1-followons 4/4, cash-flow-l1 now passes on Oct 29; the 1 failure is tests/contract/cash-alerts-l2's date-dependent seed (pre-existing, documented, out of scope). Mutation: the pre-change merchant-rename.js turns e1-followons' re-key test red. E2e: 73/73 (PW_CHROMIUM_PATH=/opt/pw-browsers/chromium) after the E1b check fix.
REGRESSION RISKS: The backfill groups by an identical deleted_at; two separate deletes in one transaction would be grouped — no route deletes two csv rows in one transaction except Resolve. A survivor that already has its own non-default setting keeps it (the old row's is dropped) — the user's later choice on the survivor wins.
INVARIANTS AT RISK: INV-151 — reworded: a rename re-key now writes the forecast columns, but only to COPY the user's own setting onto the surviving row (never derives one); the detectors still never write them. INV-145 — the batch restore still goes through restoreDeleted per row in one transaction; the backfill only adds ids. None violated.
NET SCORE: 2 − 0 = 2 (production fixes that would fire: FO-b — a rename rule over a merchant whose transfer had a forecast setting; FO-f — a batch with a bank-removed row showed a misleading count. FO-c / FO-g / FO-h are edge handling; FO-a / FO-d / the e2e fix are test-side)

OPERATOR ACTIONS / DEPLOY:
- None | BLOCKS DEPLOY: N
Deploy: Platform, Shell & Auth: Render auto-deploys on push to `main`.

FOLLOW-ON ITEMS:
- tests/contract/cash-alerts-l2's seed is date-dependent (last charge 27 days back, bill expected in 3) — fails in a 31-day month; not an E1 follow-on
- An e2e click sweep that changes seeded state (Dismiss) can affect later checks — the sweep doesn't press "Dismiss"-like controls back
- Not done (would be an optional E1d): a page for CSV-overlap Resolve; manual bills and income streams in the forecast list
- A legacy Resolve whose rows were deleted across a transaction boundary (impossible through the route) wouldn't be grouped

DOCUMENTATION UPDATES NEEDED:
- CLAUDE.md: Known Open Issues (E1 follow-ons closed: re-key setting, cash-flow-l1 seed, the e2e browser note → PW_CHROMIUM_PATH; Resolves before E1c now batched), Commands (PW_CHROMIUM_PATH for test:e2e), the forecast PATCH's 400, the batches' `restorable` + the restore's `cleared`, INV-151 wording, test counts (2972 / 159 files / contract 296)
---END BROAD SCAN IMPLEMENTATION SUMMARY---
