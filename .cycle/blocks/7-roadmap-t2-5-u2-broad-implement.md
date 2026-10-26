---BROAD SCAN IMPLEMENTATION SUMMARY---
Findings implemented: None (roadmap work, not scan findings)
New capabilities (G/ST): Roadmap T2.5 U2 — the undelete UI: Settings → Sync Health → Deleted transactions (list, Show more, Restore) and an Undo on the Activity page's delete toast
Files modified:
- teller/public/perfin-shared.js
- teller/public/perfin-shared.css
- teller/public/transactions.js
- teller/views/settings.ejs
- e2e/seed.js
- e2e/pages.spec.js
- tests/roadmap-t2-5-u2.test.js (new)
- tests/roadmap-t2-2-cash-l4.test.js
- tests/contract/cash-flow-l1.contract.test.js
- CLAUDE.md
- README.md
- .cycle/STATE.md
- .cycle/plan-t2-5-undelete-ios-reauth.md

CHANGES:
U2 | teller/public/perfin-shared.js, perfin-shared.css | showMsg(text, ok, opts) takes an optional { action: { label, run } }. It adds a `.toast-action` button that closes the toast and calls run, without also running the toast's own click handler. Such a toast stays 10 s and is never merged with an earlier one; plain toasts are unchanged. New restoreTransaction(id) / restoreMessage(r) (on window): POST /api/deleted-transactions/:id/restore, a refusal through writeOk, a network failure toasted, and the outcome toasted. A pre-U1 row's message says how it returns: Reconcile Now for reconcile, "import its CSV file again" for csv_reimport.
U2 | teller/views/settings.ejs | Settings → Sync Health → a collapsible "Deleted transactions" (<details id="deleted-transactions">) with a count in the summary. loadDeletedTransactions loads 50 at a time; Show more follows `next`. Each row shows the date, merchant, amount (a credit as -$X), account and split count from the snapshot, or the id alone for a pre-U1 row, plus when it was deleted. Each has a labelled Restore button ("Restore <merchant> on <date>"); a pre-U1 manual entry gets a note instead. A delegated handler runs restoreTransaction and drops the row on success; on a refusal the row stays and the button is enabled again. Empty state: "No deleted transactions." A failed load shows "Unavailable"; a failed Show more is toasted and keeps the list. Loaded with the page.
U2 | teller/public/transactions.js | The Activity delete (the duplicate finder's Delete #1 / #2) reports a refusal through writeOk. Its success toast offers Undo, which restores and reloads the duplicates and the search only when the restore succeeded. Both buttons are data-e2e-skip.
U2 | e2e/seed.js, e2e/pages.spec.js | The seed adds a CSV row "E2E DELETED SHOP" and deletes it through DELETE /api/transactions/:id. New: Settings lists it, Restore toasts "Transaction restored." and removes the row, and Activity finds it again. New: a toast's Undo button runs its action and closes. FIX: the seed looked up rows by `merchant_name`, but GET /api/transactions names it `merchant`, so the GROCER split step had silently never run. The lookup now uses `merchant` and throws when a row is missing.
U2 | tests/roadmap-t2-5-u2.test.js | 19 tests (vm-run from the shipped sources): restoreTransaction / restoreMessage; showMsg's action button over a small fake DOM; the Settings section (snapshot / legacy / unrestorable rows, escaping, labels, -$X, Show more cursor, Restore dropping the row / a refusal keeping it, failed loads); the Activity Undo (reload only on success, a refused delete with no Undo, data-e2e-skip); the seed pin.
U2 | tests/roadmap-t2-2-cash-l4.test.js | The init-line pin now allows loadDeletedTransactions between loadRecentErrors and loadCashFloors.
PRE-EXISTING (CI-blocking) | tests/contract/cash-flow-l1.contract.test.js | The fixture assumed a 30-day step, but bills step by calendar month (DC-9), so the test failed on dates like today (2026-10-26: the loan landed Nov 1, not Oct 31), and on ~120 days in 4 years for Netflix. The fixture now puts each bill exactly one calendar month after its last charge, on a day the previous month has: Netflix from day 3, the loan after it. Simulated against the real cadence.seriesOccurrences over 8 years of "today": 0 failing days. Test-only; no production change.
U2 | CLAUDE.md, README.md | Transaction deduplication paragraph (the undelete UI), Commands (both routes' UI), the toast stack (action button) in Features + Key Design Decisions, the e2e description (seeded deletion, 63 tests), test counts (2271 / 119 files / Perfin 1613; Playwright 63), Known Open Issues T2.5 (U2 done, follow-ons); README count and undelete mentions.

TEST RESULTS:
- npm test 2271/2271 (19 new).
- Contract 236/236, after the cash-flow fixture fix. Before it: 235/236, the date-dependent pre-existing failure above.
- Playwright 63/63 (2 new); the GROCER split now really runs in the seed.
- Mutation checks: 12/12 caught. Dropping the Show-more cursor; not removing a restored row; replacing instead of appending a page; a Restore button for an unrestorable row; unescaped merchant; reload after a failed undo; no writeOk on the delete; merging action toasts; no stopPropagation (pinned after the first run); split wording; no writeOk on the restore; a 5 s action toast.
- Migrations: not re-run — no schema change.
REGRESSION RISKS:
- showMsg's dedupe now compares the stored text (_text) rather than textContent. For plain toasts the two are the same string. An action toast is never a dedupe target.
- The Activity delete's failure toast now reads "Delete: <server error>" (writeOk) instead of "Failed to delete."
- The seed now throws if the GROCER or the deleted row is missing (it used to skip silently).
INVARIANTS AT RISK: None. INV-89: both new writes go through writeOk. INV-90: no new modal. IF-3: the Restore buttons have text plus an aria-label. INV-111: restore stays the only way back. INV-130: the seed goes through the routes (a DELETE).
NET SCORE: 0 production fixes − 0 new failure modes = 0 (new capability; plus one seed bug and one date-dependent contract test fixed, both test-only)

OPERATOR ACTIONS / DEPLOY:
- None | BLOCKS DEPLOY: N
Deploy: Render auto-deploys on push to `main` (Platform, Shell & Auth); no Apps Script change.

(Not complete in production until blocking operator actions are done AND
the deploy step is confirmed.)

FOLLOW-ON ITEMS:
- The only delete in the UI is the Activity page's duplicate finder, so Undo lives there.
- The deleted list has no search or filter (newest first, 50 a page).
- An Undo toast lasts 10 s; after that, the Settings list is the way back.
- Other contract fixtures may share the 30-day-step assumption. Only cash-flow-l1 failed on today's date, and only it was fixed.
- U1 follow-ons stand: a pre-U1 tombstone shows only its id; Restore never starts a reconcile; snapshots are kept until a reset.

DOCUMENTATION UPDATES NEEDED:
- None (done in this batch)
---END BROAD SCAN IMPLEMENTATION SUMMARY---
