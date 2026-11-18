---BROAD SCAN IMPLEMENTATION SUMMARY---
Findings implemented:
- F30 — raise detection: with paychecks that differ by cents, one raised deposit was reported as a raise of half its size, dated to an old-level paycheck; the alert key changed with each deposit, so one raise was pushed after every paycheck
- F31 — a loan with a known APR of 8% or more and no monthly payment on file dropped out of the plan, which then said "Invest"
- F32 — the plan's spending average always divided by 3; the emergency-fund date in the starter-buffer step ignored the debt step that comes next
- F33 — FIRE averaged income only over months that had income rows, while spending was averaged over all months
- F37 — the headline could promise a small debt more than it owed (the remainder went nowhere); idle cash rounded every line down to $100 and dropped small debts; windfalls beyond two per push were marked seen without being announced
- F38 — "Daily discretionary" wasn't the figure the projection uses; the payday check ordered by a text id; "Since you last looked" capped its count at 25; a year-end investment transaction cancelled in January still counted in the prior year
New capabilities (G/ST): None
Files modified:
- teller/services/advice.js
- teller/services/advice-alerts.js
- teller/services/projections.js
- teller/services/cash-flow.js
- teller/services/payday-alerts.js
- teller/services/tax-investments.js
- teller/routes/goals.js
- teller/routes/ask.js
- teller/routes/insights.js
- teller/routes/whats-new.js
- teller/views/dashboard.ejs
- tests/cycle9-b6.test.js (new, 38 tests)
- tests/contract/c9-batch6.contract.test.js (new, 5 tests)
- tests/roadmap-t4-1-a6.test.js, tests/roadmap-t2-2-cash-l3.test.js (pins that encoded the old alert key and the old ORDER BY)
- .cycle/STATE.md, .cycle/blocks/9-batch6-broad-implement.md

CHANGES:
F30 | teller/services/advice.js | `detectRaises` requires every deposit of the run to be at least 3% (RAISE_MIN_SHARE) above the old level, not only above the three deposits before it. One raised deposit is no longer a raise; two are, at full size, and `since` is the first raised deposit. Reproduced before the fix: a real raise of $140.25 was reported as $70.33.
F30 | teller/services/advice-alerts.js | `windfallsOf` keys a raise by payer + `since` (it was payer + the new level, a median that moves by cents with each deposit). Each raise also carries its old key as `legacy`, and a raise already announced under it isn't announced again.
F31 | teller/services/advice.js | A carried debt in the high tier with no payment on file stays in `planned` with a $0 payment and `minimum_unknown: true`. Its allocation row leaves `months_to_payoff`, `payoff_month`, `interest` and `interest_saved` null and `minimum_never_pays_off` false; no snowball line is worked out while one is present. The headline says "on top of its regular payment". A 6% loan or a loan with no APR, without a payment, is still left out.
F31 | teller/views/dashboard.ejs, teller/routes/insights.js | The "Your plan" card shows "Set its monthly payment" in the Paid-off column for such a loan (not the red "never pays it off"); the CASH PLAN prompt line says its payment isn't on file, so there is no payoff date.
F32 | teller/services/advice.js | The spending average is over the completed months (of the last 3) that have data; `cash.spending_months` reports how many. With fewer than 3 the plan adds a note; with none the average is 0 and the note says the cash targets are the floor alone. In the starter-buffer step with high-interest debt, the emergency date is the buffer's months + the debts' payoff at the plan's pace + the rest of the fund, with the note "It comes after your starter buffer and your high-interest debt." (no date when a payoff can't be worked out).
F33 | teller/services/projections.js, teller/routes/goals.js, teller/routes/ask.js | New pure `fireAverages(incomeRows, spendingRows, thisMonth)`: both sums divided by the number of completed months that have an income row or a spending row. `GET /api/fire-projection` and Ask's `get_fire_projection` both call it; `completed_months_used` is that count.
F37 | teller/services/advice.js | New `unplaced(debts, rows, extra)`: the part of the month's extra the step's debts can't take. In the high-interest step it goes to the emergency fund while that isn't reached, else investing (`allocation.emergency_monthly` / `invest_monthly`); `debt_extra_monthly` is what the debts take. The headline becomes "Pay off X: $A per paycheck on top of its minimum finishes it; the rest of your $B per paycheck goes to <next debt | your emergency fund | investing>." `headline.amount_*` is unchanged. In the medium step the unplaced part of the debt half is invested.
F37 | teller/services/advice.js | Idle cash: a line the cash cap doesn't cut keeps its exact amount; only a line the cap cuts is rounded down to $100. A debt under $100 is no longer dropped and the lines add up to the amount.
F37 | teller/services/advice-alerts.js | Only the windfalls a push names (at most 2) are added to `windfalls_seen`; the rest go out with the next day's check.
F38 | teller/services/cash-flow.js | `avg_daily_spend` is the projected discretionary total divided by the forecast days — the weekday averages the projection uses. It was the 60-day average over days that had spending only.
F38 | teller/services/payday-alerts.js | The candidates are ordered by `transactions.id`. `ORDER BY id` resolved to the `id::text` output alias, so "100" sorted before "99".
F38 | teller/routes/whats-new.js | The transactions query adds `COUNT(*) OVER()`; `counts.transactions` is that total, and the helper column is stripped from the listed rows. The list is still capped at 25.
F38 | teller/services/tax-investments.js | `getInvestmentTaxData` also reads later rows that cancel a row dated before the year's end, uses them only to drop what they cancel, and never treats a later-year row as a lot, sale or income of the year.

TEST RESULTS: passed.
- `npm test`: 3492 / 3492 (38 new; 186 test files; Perfin 2723, Per-sistant 769).
- Route contract suite on a local Postgres 16: 383 / 383 (5 new).
- Playwright: 93 / 93.
- The new unit file and ten neighbouring files under five shifted clocks (2026-12-31, 2027-01-31, 2027-03-14, 2027-11-07, 2028-02-29): 249 / 249 each. The contract file was not run under a shifted clock (the database keeps the real date).
- Mutation check: against the pre-fix source the new files fail 29 of 38 (unit; the other 9 are unchanged-behaviour guards) and 5 of 5 (contract).
- Regression scenarios: S3 (AI budget cap — ask.js was touched) PASS by tests/ai-cap-charge.test.js; S4 PASS by the contract and e2e runs; S1, S2, S5, S6, SK1–SK5 not applicable to the files changed.

REGRESSION RISKS:
- A real raise whose run contains a deposit less than 3% above the old level (a small raise with noisy pay) is no longer reported until two clean deposits follow.
- After deploy, a raise already announced whose stored level differs by cents from today's median is announced once more (the old-key check covers only an unchanged level).
- For a high-APR loan with no payment on file, the plan now recommends an extra amount while its surplus doesn't subtract the loan's real payment (loan payments aren't in spending). The surplus was overstated the same way before; it then went to "Invest". The note asks for the payment to be set.
- When a small high-interest debt is finished and the emergency fund is already reached, the rest of the month's amount is shown as going to investing even if a 4–8% debt exists (the plan's own rule there is 50/50).
- The plan's cash targets rise for a user with fewer than 3 completed months of data (the average is no longer a third or two-thirds of real spending), so the step can move from "Invest" back to the buffer or the emergency fund.
- `counts.transactions` in GET /api/whats-new and the daily digest's subject can now exceed the 25 rows listed.
- `avg_daily_spend` in GET /api/cash-flow is now lower for anyone with no-spend days; nothing else reads it but the dashboard line.
- Idle-cash lines to investing are no longer $100 multiples (e.g. $5,285.44) when the cash cap doesn't bind.

INVARIANTS AT RISK: None broken. INV-150 holds (every figure, the capped headline's included, is computed in advice.js and known to the audit's planFigures — tested). INV-142 / INV-152 hold (the payday watermark logic is unchanged; only the walk order). INV-146 holds (tax figures still come only from investment_transactions). INV-147 holds (the dashboard summary's lowest day is untouched). INV-106 holds (no bare catch added). Wording to update at /sync-docs: INV-150 (the loan with no payment, the averaging rule, the capped headline, what-if untouched), INV-146 (a later cancel).
NET SCORE: 1 − 2 = −1
- Production fixes this month: 1 — F38's "Daily discretionary" (wrong on every dashboard load for an account with any no-spend day in 60). The others need conditions I can't see in production: a raise in the last 90 days (F30), an 8%+ loan with no payment set (F31), under 3 months of history (F32), months with no income rows (F33), a debt smaller than the plan's amount or three windfalls at once (F37), more than 25 new transactions, ids crossing a digit boundary with payday alerts on, or a January cancel (F38).
- New failure modes: 2 — a small real raise with one low deposit in its run is not reported (Low); the remainder of a finished high-interest debt is shown as going to investing while a medium-interest debt exists (Low).

OPERATOR ACTIONS / DEPLOY:
- None required. | BLOCKS DEPLOY: N
Deploy: Financial Analytics / AI Insights & Audit / Bank Sync & Ingestion / Settings, Notifications & Cross-app / Web UI — Render auto-deploys on push to `main` (this work is on `claude/gracious-maxwell-li0vm7`; no PR opened). No migration.

(Not complete in production until blocking operator actions are done AND
the deploy step is confirmed.)

FOLLOW-ON ITEMS:
- A medium-tier (4–8%) loan with no payment on file is still left out of the plan (F31 named 8% and up); the plan then invests everything instead of splitting 50/50.
- A what-if extra payment on a loan with no payment on file is ignored (`normalizeDebts` adds it only to a known minimum).
- The plan's surplus doesn't subtract the real payment of a loan whose payment isn't on file.
- With no completed month of data the average is $0, so the buffer and emergency targets are the floor alone and read as reached; the plan says so in a note but doesn't hold the steps open.
- The 60-day `avgDailySpend` input (spending days only) is still computed and used as the fallback when a weekday has no average; it never is in practice.
- `counts.subscriptions` and `counts.notifications` in whats-new are still capped at their list limits (10 and 20).
- In the high-interest step with several debts, the capped headline names the next debt for "the rest" even when the rest exceeds that debt too.
- The medium step's headline names only the first debt for the whole debt half.

DOCUMENTATION UPDATES NEEDED:
- CLAUDE.md: the advice.js tree entry (raise rule, the loan with no payment, the spending average + `cash.spending_months`, the starter-buffer emergency date, `unplaced` and the capped headline, idle rounding); advice-alerts.js (the raise key by payer + since, `legacy`, only announced windfalls marked seen); projections.js (`fireAverages`); cash-flow.js (`avg_daily_spend`); payday-alerts.js (the order); whats-new.js (the count); tax-investments.js (a later cancel); the FIRE API line, GET /api/whats-new and GET /api/cash-flow lines; the Cash flow forecast / plan-change alert / Year-end tax package feature text where they describe these; Known Open Issues (Batch 6 done with its follow-ons); INV-150 and INV-146 wording; the test list (tests/cycle9-b6.test.js, tests/contract/c9-batch6) and counts (3492 tests, 186 files, Perfin 2723; contract 383).
- README: test counts.
---END BROAD SCAN IMPLEMENTATION SUMMARY---
