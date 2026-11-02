---BROAD SCAN IMPLEMENTATION SUMMARY---
Findings implemented: None (expansion batch E5a only). One bug the new tests exposed was fixed under plan decision 5 (a one-line, in-scope fix): the Activity page's duplicate finder kept showing a pair after its last duplicate was deleted.
New capabilities (G/ST): ST4 (part 1 of E5 — `.cycle/plan-e5-behaviour-tests.md` decisions 1–4 and actions 1–8): behaviour tests that check each key action's new state on the page, in the API and after a reload, then put it back; an idempotent e2e seed; one Playwright worker
Files modified: e2e/behaviour.spec.js (new), e2e/helpers.js (new), e2e/pages.spec.js, e2e/seed.js, e2e/playwright.config.js, teller/public/transactions.js, .cycle/plan-e5-behaviour-tests.md, .cycle/plan-cycle8-expansion.md, .cycle/STATE.md

CHANGES:
ST4 | e2e/helpers.js | New: loginWithPin and watch (moved out of pages.spec.js unchanged), apiJson / apiSend (signed-in GET / write, throw on a non-2xx), ymd, HDR, PIN
ST4 | e2e/seed.js | ensureSeeded(req): seeds both apps once per run (the marker: the "E2E Cash" manual account) and on a later call reads back manualAccountId / taxYear — a second seedPerfin would duplicate rows and 409 on the 1099-NEC
ST4 | e2e/pages.spec.js | uses helpers.js and ensureSeeded; nothing else changed
ST4 | e2e/playwright.config.js | workers: 1 — the behaviour file never runs beside the click sweep (CI's 2-core runner already used one worker)
ST4 | e2e/behaviour.spec.js | New, serial, eight tests, each on rows it creates under a unique "E5 … <tag>" name (its own "E5 Wallet" manual account, reused across runs): 1 Activity rename + note (page, search API, reload + the dialog's values; cleared through the dialog → the bank's name back), 2 reimbursed (badge, is_reimbursed, reload; unticked through the dialog), 3 delete a duplicate (two one-row CSV imports on two accounts) → the tombstone in /api/deleted-transactions and one copy left → the toast's Undo → both back and the tombstone gone → still listed after a reload, 4 Review Uncategorized Apply with Remember off (row leaves the queue, user_category set, no rule, not in the queue after a reload), 5 Calendar: a manual bill's day marked paid (aria-pressed, .paid, one bill_payments row at the bill's amount, reload) and pressed again → unpaid (the bill deleted after), 6 Budgets: added with rollover ("Rolls over", the API, reload) → Stop rollover (badge gone, API, reload) → Delete on the card (gone from the API), 7 Rent: an own $77 obligation paid through the record-payment modal (balance owed drops, payment listed, ledger paid, reload) → the payment's Undo (owed again, unpaid) → the obligation deleted so the seeded balance is unchanged, 8 Subscriptions: Cancel (out of Active, CANCELLED under Cancelled, cancelled_at, reload) → Restore (cancelled_at null, Cancel back under Active) → dismissed after. The helper's cash rows carry a category so they never crowd the 8-row Review queue on a rerun
fix | teller/public/transactions.js | loadDuplicates: an empty duplicates list now hides the section and clears the list — after the last pair's Delete the pair stayed on screen (a second press answered 404)

TEST RESULTS: npm test 3126/3127 — the one failure is the known date-dependent tests/cycle8-e1a.test.js case (end of a 31-day month). e2e 82/82 on a fresh server (74 + 8 new); the behaviour file also passed three times in a row against one server (rerun safety). Contract not run (no server code changed). Mutations red: the transaction PATCH dropping the note (test 1), the budget PATCH ignoring rollover_enabled (test 6), the payment not marking its obligations paid (test 7); test 3 was red before the duplicate-finder fix.
REGRESSION RISKS: workers: 1 lengthens a local e2e run (about 4 minutes here); CI unchanged. pages.spec.js's helpers moved to helpers.js unchanged. The behaviour file leaves its own rows behind (cash rows on "E5 Wallet", the duplicate pair, a dismissed manual subscription) — none touches a figure pages.spec.js asserts; its budget, manual bill and rent obligation are removed. The duplicate-finder fix only adds a hide / clear when the list is empty.
INVARIANTS AT RISK: INV-130 widened as proposed (the e2e run also holds behaviour tests that check the page, the API and a reload and put the state back; the seed runs once per run; behaviour tests act only on rows they create). INV-145 / INV-111 — exercised (the delete → Undo path), not changed. INV-89 — the pages' writes still go through writeOk.
NET SCORE: 1 production fix (the duplicate finder kept a deleted pair on screen — it fires whenever the last duplicate is deleted) − 0 new failure modes = +1 (ST4 is new capability)

OPERATOR ACTIONS / DEPLOY:
- None | BLOCKS DEPLOY: N
Deploy: Web UI (Perfin) — Render auto-deploys on push to `main` (alt: `fly deploy`); the rest is test code.

(Not complete in production until blocking operator actions are done AND
the deploy step is confirmed.)

FOLLOW-ON ITEMS:
- The Review Uncategorized count label ("N transactions") isn't updated after an Apply (only the row is removed) — cosmetic, not changed
- The calendar's mark-unpaid matches a payment by String(paid_date).startsWith(date), which relies on the server's DATE serialisation (UTC midnight) — fine on a UTC server, unchecked elsewhere
- The behaviour file's rows accumulate across runs against one long-lived server (CI boots a fresh database each run)
- tests/cycle8-e1a.test.js, tests/contract/cash-alerts-l2 and the persistent calendar contract test remain date-dependent

DOCUMENTATION UPDATES NEEDED:
- CLAUDE.md: e2e/behaviour.spec.js + e2e/helpers.js in the e2e description (the `.github/workflows/ci.yml` bullet), workers: 1, ensureSeeded; e2e count 74 → 82; INV-130 widened; the duplicate-finder fix (Transaction deduplication / Activity); Known Open Issues: E5a done with its follow-ons
- README e2e count
---END BROAD SCAN IMPLEMENTATION SUMMARY---
