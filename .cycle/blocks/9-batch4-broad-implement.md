---BROAD SCAN IMPLEMENTATION SUMMARY---
Findings implemented:
- F39 — the insight audit no longer raises false criticals on correct text: the subscription total the prompt gives, a percentage that isn't the savings rate, a monthly rate compared with the month to date
- F40 — the cash-plan check: a period phrase no longer bleeds onto the next figure; contribution-room amounts are plan figures; a per-paycheck amount with nothing in the plan to match is flagged
- F41 — Ask shortens a long tool result by key (valid JSON) and puts the what-if comparison first
- F42 — the entity check knows account, card, loan and institution names
- F43 — an empty insight run no longer stamps `insights_last_run`; the plan action's `first_recommended` comes from the stored summary; the tax prompt no longer presents the 2024 thresholds as current
New capabilities (G/ST): None
Files modified:
- teller/services/ai-audit.js
- teller/routes/ask.js
- teller/routes/insights.js
- tests/cycle9-b4.test.js (new, 56 tests)
- tests/contract/c9-batch4.contract.test.js (new, 7 tests)
- .cycle/STATE.md, .cycle/blocks/9-batch4-broad-implement.md

CHANGES:
F39 | teller/services/ai-audit.js | The subscription read returns subscriptions and utilities apart. A subscription-total claim is compared with the nearest of subscriptions only (what the prompt gives), subscriptions plus utilities (the Subscriptions page's total) and — when the clause names utilities — the utility total.
F39 | teller/services/ai-audit.js | savingsRateClaim: a percentage is the savings rate only when the phrase reaches it unbroken in its own stretch of the sentence ("your savings rate is 18%", "**Savings rate**: 18%", "an 18% savings rate"). Not when the clause is about a recommendation or benchmark ("recommended 20%", "50/30/20", "national"), or the figure is a change ("improved by 6%", "6 points"). The this-month test reads the claim's sentence instead of ±80 characters.
F39 | teller/services/ai-audit.js | A category figure stated as a monthly rate ("$600/mo on Groceries", "Dining averages $450") is not compared with this month's partial spend unless the claim says "this month". CROSS_PERIOD_RE is unchanged; the subscription total (itself a monthly figure) is still checked.
F40 | teller/services/ai-audit.js | claimSegments returns afterFigure (the lead follows another dollar figure in the same sentence). planClaimFinding then reads "per paycheck" / "a month" only AFTER the figure — the prompt block's own "pay $420.00 per paycheck ($840.00 a month: …)" made $840 a per-paycheck claim. planFigures adds contribution_room.accounts[].per_period. An empty comparison set is now a warning ("no such amount in the plan") unless the sentence is about pay.
F41 | teller/routes/ask.js | toolResultContent(result, limit 12,000): a result over the limit drops the plan's supporting sections in a fixed order (notes first, debts last; named in omitted_for_length), then halves its longest list (shortened_for_length), else returns a short error object — always valid JSON. It replaces JSON.stringify(result).slice(0, 12000). get_cash_plan returns ok, disclaimer, what_if, then the plan.
F42 | teller/services/ai-audit.js | Tier 2's known set adds ACCOUNT_NAMES_SQL: linked_accounts name / official_name / institution_name_manual, investment_accounts name / institution, and the institution names of Plaid items and Teller enrollments.
F43 | teller/routes/insights.js | The empty-run path no longer updates insights_last_run (the usage row is still written), so the auto-trigger's 24-hour retry applies instead of a full cadence. seedPlanActions takes the stored summary as a fourth argument and reads the earlier plan entry's first_recommended from it. The tax prompt says itemizing only helps past the standard deduction for the tax year, gives the 2024 amounts as 2024's, and tells the model not to state a later year's amount unless sure.

TEST RESULTS: passed.
- `npm test`: 3354 / 3354 (56 new; 181 test files; Perfin 2611).
- Route contract suite on a local Postgres 16: 356 / 356 (7 new). The audit swallows a failing query by design, so the contract file is what shows the new SQL runs.
- The new unit file and six neighbouring audit / Ask files under four shifted clocks (2026-12-31, 2027-01-01, 2027-03-31, 2028-02-29): 219 / 219 each.
- Mutation check: against the pre-fix code the new unit file fails 37 of 56 and the new contract file 6 of 7.
- Playwright was not run (no page or route shape changed).
- Regression scenario S3 (AI budget cap) — PASS by tests/ai-cap-charge and the contract persistent / ai-trust suites in the runs above; the others don't overlap the modified files.

REGRESSION RISKS:
- The audit checks less: a category figure written as a monthly rate is no longer compared with anything unless it says "this month", and a savings-rate figure the phrase doesn't reach unbroken ("your rate, which …, is 18%"; "yours is 18%") is not checked.
- A subscription-total claim now passes when it matches either total, so a model that confuses the two is not caught.
- The plan check's new warning can fire on a non-plan sentence that states a per-paycheck amount when the plan recommends nothing (pay sentences are excluded).
- Knowing institution names means an invented product at a real institution ("Chase Freedom" when only a Sapphire exists) passes the entity check.
- After an empty run the auto-trigger retries every 24 hours, each attempt charged to the monthly AI cap (the cap is checked first).
- A long Ask plan answer can lack sections; the result names what was left out.

INVARIANTS AT RISK: None broken. Wording to update at /sync-docs: INV-113 (the savings-rate clause rule, monthly rates, the two subscription totals), INV-150 (contribution room, the period phrase after a figure, a claim against an empty set). INV-14 / INV-55 hold (Ask's charge path is unchanged; an empty insight run is still charged). INV-16 holds (seedPlanActions still runs after the summary was sanitized, bounds kept).
NET SCORE: 2 − 2 = 0
- Production fixes this month: 2, both likely rather than confirmed. F39 — with utilities detected, the model repeating the prompt's own subscription total was a CRITICAL on each insight run. F42 — the debt module names cards on each run, and each name was a caution. F40 needs a carried debt in the plan, F41 a what-if on a data-rich plan, F43 an empty answer — not confirmed.
- New failure modes: 2 (both Low) — the audit no longer checks monthly-rate category figures; the plan check's new warning can fire on a non-plan per-paycheck sentence.

OPERATOR ACTIONS / DEPLOY:
- None.
Deploy: AI Insights & Audit — Render auto-deploys on push to `main` (this work is on `claude/gracious-maxwell-li0vm7`; no PR opened).

(Not complete in production until blocking operator actions are done AND
the deploy step is confirmed.)

FOLLOW-ON ITEMS:
- The audit still fetches monthly totals and the subscription count and checks neither (the second half of F42 — a gap, not a wrong result).
- With a plan that does recommend amounts, "you bring home $2,100 per paycheck" is still judged against them.
- The tax prompt cites 2024's standard deduction as an example; stating the current year's would need a maintained table.
- Ask's 12,000-character limit is unchanged; raising it would keep more of a large plan.
- Audit findings stored before this batch keep counting in the 90-day accuracy figure until they age out.

DOCUMENTATION UPDATES NEEDED:
- CLAUDE.md: the ai-audit.js entry and the "AI insight auditing" section (the subscription totals, the savings-rate clause rule, monthly rates, the plan check's period rule / contribution room / empty set, account names in the entity check); the ask.js entry (toolResultContent, what_if first); the insights auto-trigger and cost-tracking notes (an empty run no longer stamps insights_last_run); seedPlanActions; the tax-deduction module's prompt note; the test list (tests/cycle9-b4.test.js, tests/contract/c9-batch4) and counts (3354 tests, 181 files, Perfin 2611; contract 356); the cycle-9 Known Open Issues entry (Batch 4 done, follow-ons); INV-113 and INV-150 wording.
- README: test counts.
---END BROAD SCAN IMPLEMENTATION SUMMARY---
