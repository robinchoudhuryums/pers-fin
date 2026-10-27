---BROAD SCAN IMPLEMENTATION SUMMARY---
Findings implemented:
- F7 — the cash forecast no longer bills a recurring transfer whose latest debit landed as a same-amount credit (within 5 days) on another of your spendable (depository, non-investment) accounts
- F8 — only CARD autopays are left out of the forecast's bills (a payment into a linked credit card, a card-payment phrase or a card issuer's name); a utility / insurance "AUTOPAY" from checking is billed
- F9 — investment income ignores `fee` rows with an income subtype (margin interest charged, a dividend paid on a short); tax withheld still counts
- F10 — "Paycheck landed" holds its watermark when the notification wasn't logged (sendToAll returns { logged: false }; it never throws)
- F11 — the low-cash alert remembers its last notification across a "clear" (cash_alert_state.last_notified), so a forecast hovering around the floor doesn't re-notify within 72 h unless the dip is 3+ days earlier
- F12 — a cash-alert setting or account-floor change forces the next tick to evaluate (the "nothing new since the last check" gate used to hold it until new bank data or the next local day)
- F13 — documents.csv (and so the tax package ZIP) lists a dismissed form's day in APP_TIMEZONE
- F14 — a tax document id beyond int4 is a 400, not a 500
- F15 — "buy to cover" (closing a short) is not a FIFO lot
New capabilities (G/ST): None
Files modified:
- teller/services/cash-flow.js
- teller/services/cash-alerts.js
- teller/services/payday-alerts.js
- teller/services/tax-investments.js
- teller/services/tax-package.js
- teller/routes/tax.js
- tests/broad-scan-c8-batch2.test.js (new)
- tests/contract/c8-batch2.contract.test.js (new)
- tests/roadmap-t2-2-cash-l2.test.js

CHANGES:
F7 | teller/services/cash-flow.js | The transfers query computes moved_between_cash_accounts: EXISTS a debit by the transfer detector's merchant key on rt.last_transferred from a depository, non-investment account with a credit of -amount within ±5 days on ANOTHER depository, non-investment account (mirroredCredit). isInternalMove(tr) drops those bills.
F8 | teller/services/cash-flow.js | isCardAutopay = bill_payment, not loan / mortgage, AND (paid_linked_card — the same mirror test with la2.type = 'credit' — OR CARD_PAYMENT_RE: credit card / card payment / cardmember / CRD PMT / amex / american express / discover / capital one / citi / chase / barclays / synchrony / apple card). It used to be every non-loan bill_payment.
F9 | teller/services/tax-investments.js | investmentIncome skips a `fee`-type row for every field except tax_withheld.
F10 | teller/services/payday-alerts.js | runPaydayLanded treats a send that returns !logged (or throws) as held back: the watermark stays before that deposit, the run stops, it isn't counted as notified.
F11 | teller/services/cash-alerts.js | A clear keeps last_notified { breach_date, notified_at } (also kept on skipped / held, set on notified); a new breach is judged by shouldNotify against state.alert || last_notified.
F12 | teller/services/cash-alerts.js | invalidate() also sets _forceNext; runCashAlerts skips the "unchanged" gate while it is set and clears it after an evaluation completes (or when the alert is off); a throw keeps it.
F13 | teller/services/tax-package.js | documentsCsv renders dismissed_at with zoneDay (Intl, APP_TIMEZONE) instead of csvDate (server-local getters).
F14 | teller/routes/tax.js | idFrom refuses ids above 2147483647.
F15 | teller/services/tax-investments.js | realizedGains skips a buy with subtype "buy to cover".
Tests | tests/broad-scan-c8-batch2.test.js, tests/contract/c8-batch2.contract.test.js, tests/roadmap-t2-2-cash-l2.test.js | 15 unit tests (the two forecast flags through getCashFlowInputs, the card / utility names, fee rows and a dividend reversal, a buy to cover, an unlogged payday alert, notify → clear → held / 72 h / 3 days earlier, the force flag incl. after a throw, the dismissed day under America/Los_Angeles, the int4 400 before any query) + 1 contract test on real Postgres (checking → linked savings not billed; a brokerage contribution, a transfer to someone else, a utility autopay and a 9-day-apart "mirror" billed; a payment into the linked card not billed). Two L2 assertions updated for the new last_notified field. Mutation checks 10/10 red.

TEST RESULTS: passed — npm test 2598/2598; contract suite 254/254 (local Postgres 16, no pgvector); Playwright 72/72 (scratch config → preinstalled Chromium).
REGRESSION RISKS:
- F8: a LINKED card paid by an autopay whose name carries no card phrase, and whose credit posts more than 5 days after the debit or for a different amount, is now billed on top of the card spending in the average (the DD-4 double count, for that card only).
- F7: a transfer whose debit happens to match an unrelated same-amount credit on another spendable account within 5 days is wrongly treated as internal and left out of the bills.
- F8: an UNLINKED card's autopay with a card phrase / issuer name is still skipped, though its purchases aren't in the average (the previous behaviour for every non-loan bill_payment).
- F11: a genuinely new dip within 72 h of the last notification (after a real recovery) isn't announced unless it is 3+ days earlier — the hysteresis is the fix, but it holds real re-breaches too.
INVARIANTS AT RISK: None violated. Touched: INV-142 (cash / payday alerts — the logged rule now holds on every path; dedup across a clear), INV-146 (tax package: income excludes fee rows, no phantom lots), INV-147 (the dashboard summary's lowest cash day reads the corrected forecast through the same getCashFlowForecast).
NET SCORE: 1 − 2 = -1 (production fix: F8 — a utility autopay was projected nowhere for anyone with one; F7 and the rest depend on data or opt-in features with no evidence they fired this month. New failure modes: F8's late-posting linked-card payment, F7's coincidental mirror)

OPERATOR ACTIONS / DEPLOY:
- None
Deploy: Financial Analytics / Bank Sync — Render auto-deploys on push to `main` (configured in the Render dashboard).

(Not complete in production until blocking operator actions are done AND
the deploy step is confirmed.)

FOLLOW-ON ITEMS:
- An unlogged cash / floor alert leaves cash_alerts_checked_at unstamped, but a check stamped earlier the same day still hits the "nothing new" gate, so the retry the comment promises waits for new data or the next day (pre-existing).
- The forecast has no way for the user to mark a transfer internal / a bill (G1 in the scan's expansion plan).
- retirementDistributions doesn't look at the row type either (not reported; a fee row with a withdrawal subtype isn't a Plaid shape seen).
DOCUMENTATION UPDATES NEEDED:
- CLAUDE.md Cash flow forecast + services/cash-flow.js entry: DD-4 is now card autopays only (linked-card credit / card phrase / issuer), and transfers moved between your own spendable accounts aren't billed (F7 / F8).
- CLAUDE.md Low cash alert + services/cash-alerts.js entry + user_settings.cash_alert_state: last_notified, and a Settings / floor change forces the next evaluation.
- CLAUDE.md Payday alerts + services/payday-alerts.js entry: an unlogged "Paycheck landed" holds the watermark.
- CLAUDE.md services/tax-investments.js entry: fee rows aren't income; "buy to cover" isn't a lot. tax-package.js: documents.csv dismissed day in APP_TIMEZONE. routes/tax.js: the int4 id bound.
- CLAUDE.md test counts (2583 → 2598 tests, 134 → 135 files; contract 253 → 254), the new test files, and the cycle-8 Known Open Issues section (Batch 2 done).
---END BROAD SCAN IMPLEMENTATION SUMMARY---
