---BROAD SCAN IMPLEMENTATION SUMMARY---
Findings implemented: None (roadmap work)
New capabilities (G/ST): Roadmap T4.1 A6 — raise / bonus split and spending creep
  - Raise: a payer whose deposits step up to a new steady level (≥ 2 deposits above every one of the 3 steady deposits before them, +3% and +$50 a month, first seen within 90 days) → "Your pay from X went up from $A to $B a deposit in <month> (about $C a month more). Put $D per <paycheck> of it toward <the plan's current step>." (half the raise, rounded down to $25 per paycheck)
  - Bonus: a deposit within 45 days that stands alone at ≥ $500 and 1.5× the payer's usual deposit (or ≥ $1,000 from a payer seen once) → split in the plan's order (starter buffer → high-interest debt by APR → emergency fund → medium debt 50/50 with investing → investing), with the gaps measured as if the bonus hadn't landed
  - Spending creep: a category whose last-3-completed-month average rose ≥ $50 a month (from a base ≥ $50) and ≥ 15 points faster than income over the 6 completed months → "Dining spending rose from $X to $Y a month (+N%) … Bringing it back would free $Z per paycheck." (top 3)
  - Surfaces: the "Your plan" card's secondary list, the cash_plan prompt block, Ask's get_cash_plan; the audit counts a raise's share, the raise per deposit and the freed amount as per-paycheck plan figures; the plan-change push (A4) names a new raise or bonus once ("New money for your plan", or with a plan change in one push)
Files modified:
  teller/services/advice.js, teller/services/advice-alerts.js, teller/services/ai-audit.js,
  teller/routes/insights.js, teller/routes/ask.js, teller/views/dashboard.ejs,
  tests/roadmap-t4-1-a6.test.js (new), tests/roadmap-t4-1-a1.test.js, tests/roadmap-t4-1-a5.test.js,
  tests/contract/advice-a1.contract.test.js

CHANGES:
A6 | teller/services/advice.js | two non-critical sources: deposits (DEPOSITS_SQL — settled income deposits on incomePredicate("t") at INCOME_AMOUNT, the user's share, 240 days) and categories (CATEGORY_MONTHS_SQL — spendLinesCTE + NET_CATEGORY_MONTHS over the 6 completed months); the months read widened to 7; pure detectRaises / standsAlone / detectBonuses / splitWindfall / spendingCreep / stepTarget; buildAdvicePlan adds raises / bonuses / spending_creep (null when their read failed); every threshold a named constant
A6 | teller/services/advice-alerts.js | windfallsOf (a bonus keyed by payer + day + amount, a raise by payer + level); advice_state.windfalls_seen (≤ 30); the baseline records them silently; a new one is pushed once — alone ("New money for your plan", the signature kept) or with a plan change in one push; written only when the push was logged
A6 | teller/services/ai-audit.js | planFigures' per-paycheck list adds each raise's suggest_per_period and raise_per_deposit and each creep line's increase_per_period
A6 | teller/routes/insights.js | cashPlanPromptBlock: "Raises:", "Bonuses / one-off deposits:", "Spending growing faster than income:" lines
A6 | teller/routes/ask.js | get_cash_plan returns raises / bonuses / spending_creep; the description names them
A6 | teller/views/dashboard.ejs | adviceTexts + one adviceList of the three after the goal lines
A6 | tests | 27 unit tests (roadmap-t4-1-a6); A1 / A5 test doubles carry the two new sources; one contract test (a biweekly raise, a joint-account bonus at 50%, a pending deposit ignored, Dining creep net of a refund, GET /api/advice the same)

TEST RESULTS: npm test 2852/2852 (27 new). Contract 278/279 — the 1 new A6 test passes; the failure is the known date-dependent cash-alerts-l2 "a dip below the floor" (fails in 31-day months; pre-existing, not touched). Mutation checks (the bonus filter in raise detection, the gaps measured without the bonus, the creep margin, the level check for a bonus, the step-above-the-old-range check, the six-months requirement, the windfall-only signature, the baseline's seen keys) each turn a test red.
REGRESSION RISKS:
  - Every advice read (the card, Ask, each insight run, the daily plan check) now runs two more queries (deposits over 240 days; the spend_lines CTE over 6 months) and a 7-month instead of 4-month totals read.
  - A plan-change push can now fire for a raise or bonus without a plan change (only with the switch on, once per item).
INVARIANTS AT RISK: None — INV-150 (every figure from buildAdvicePlan; the audit reads the same plan; push only when logged), INV-110 (deposits at INCOME_AMOUNT through the canonical predicate), INV-122 (creep reads spend_lines, net of refunds), INV-48 (predicates imported, not re-inlined), INV-10 (no new keyword filter), INV-77 (the away job's once-a-day gate unchanged) all hold.
NET SCORE: 0 production fixes − 0 new failure modes = 0 (new capability)

OPERATOR ACTIONS / DEPLOY:
- None | BLOCKS DEPLOY: N
Deploy: Platform, Shell & Auth: Render auto-deploys on push to `main` (after merge).

FOLLOW-ON ITEMS:
- A raise counts on top of the surplus: once months with the raise complete, the surplus already includes it, so the two overlap during the 90-day window.
- A bonus already spent still reads as landed (the gaps are measured without it, so its split can over-send); a new job's first paycheck of $1,000+ reads as a one-off until the second arrives; a one-off "deposit" that is really a transfer (a mobile check deposit from a friend) reads as a one-off too.
- The bonus split isn't checked by the audit (no per-paycheck period); creep's monthly figures aren't either (only a named debt's monthly figures are).
- Spending creep doesn't notify; a creep line names a category, not merchants; "Uncategorized" is skipped.
- Raise detection needs 3 steady deposits before the step; hourly pay that varies by more than ±10% never shows a raise.
DOCUMENTATION UPDATES NEEDED:
- CLAUDE.md: advice.js's two new sources + the A6 advisors, the audit / prompt / Ask additions, the plan-change push's windfalls (advice_state.windfalls_seen), Known Open Issues (A6 follow-ons) + Priority Next Features, INV-150 / INV-110 mention, counts 2852 / 151 / contract 279 + the new test entry.
- README: counts + the advisor clause.
---END BROAD SCAN IMPLEMENTATION SUMMARY---
