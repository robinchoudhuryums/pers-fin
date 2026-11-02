---BROAD SCAN IMPLEMENTATION SUMMARY---
Findings implemented: None (roadmap work, not scan findings)
New capabilities (G/ST): Roadmap T4.1 A5 — the emergency-fund tracker (months of spending covered, progress to the 3-month target, when it's reached at the plan's pace) and the goal catch-up amount (a goal behind its target date → "Add $X per paycheck to <goal> to finish by <month>", from deriveGoalProgress), on the "Your plan" card, in the cash_plan insight block and in Ask's get_cash_plan
Files modified:
  teller/services/advice.js
  teller/services/ai-audit.js
  teller/routes/insights.js
  teller/routes/ask.js
  teller/views/dashboard.ejs
  tests/roadmap-t4-1-a5.test.js (new)
  tests/roadmap-t4-1-a1.test.js
  tests/contract/advice-a1.contract.test.js

CHANGES:
T4.1 A5 | teller/services/advice.js | An eighth, NON-critical source `goals` (GOALS_SQL: active financial_goals with the funding account / investment joined; each row through routes/goals.deriveGoalProgress — INV-11 — into { id, name, target, current, monthly_contribution, target_date, interest_rate }; a failure → goals null + "Your goals couldn't be read.", the plan still worked out). Pure pieces: monthsUntil (calendar months to the target's month), requiredMonthly (the annuity deposit at the goal's rate compounded monthly; even split at 0%), goalCatchUps → per goal status reached / no_date / due / overdue / on_track / behind; behind = the contribution falls GOAL_CATCHUP_MIN ($5) or more a month short; add_per_period rounded UP to the dollar; text "Add $X per <unit> to <goal> to finish by <Mon YYYY>." / "<goal> is past its target date with $X to go." / "… is due this month …". buildAdvicePlan adds `emergency` { months_covered (floored to a tenth), target_months, target, have, remaining, pct, reached, projection { months, month } | null, note } — the pace at the plan's recommended amount during the starter-buffer / emergency steps, after the high-interest debts' payoff months during that step (with a note), "Nothing is going toward it right now." with no surplus — and `goals`. New exports goalCatchUps / requiredMonthly / monthsUntil / GOALS_SQL / GOAL_CATCHUP_MIN.
T4.1 A5 | teller/services/ai-audit.js | planFigures adds each goal's add_per_period to the per-paycheck figures, so a correct "add $X per paycheck to <goal>" isn't flagged as a wrong plan amount
T4.1 A5 | teller/routes/insights.js | cashPlanPromptBlock adds "Emergency fund: N of 3 months of spending covered ($have of $target, P%)" + reached / "reaches it around YYYY-MM at this pace" / the note, and "Goals behind their target dates:" (behind / overdue / due only, sanitized)
T4.1 A5 | teller/routes/ask.js | get_cash_plan returns emergency + goals; the tool description says so
T4.1 A5 | teller/views/dashboard.ejs | the "Your plan" card: adviceEmergency (a native <progress> with an aria-label, months covered, the pace or the note) and adviceGoalLines (behind / overdue / due goals) after the debt table; .advice-ef styles (teal accent, no money colour)
T4.1 A5 | tests/roadmap-t4-1-a1.test.js | test double: the fake readers include `goals`; eight reads, not seven

TEST RESULTS: npm test 2825/2825 pass (17 new in tests/roadmap-t4-1-a5.test.js). Contract suite 277/278 — the new A5 contract test passes (a funding-linked goal measured as balance − baseline, behind by $1,500 a month; an on-track goal; an inactive goal left out; the tracker's months covered from the real cash; GET /api/advice carrying the same goals); the 1 failure is the PRE-EXISTING date-dependent tests/contract/cash-alerts-l2 seed already logged in A4. Mutation checks 6/7 caught (interest in requiredMonthly, the round-up, the $5 bar, the payoff months before the fund, deriveGoalProgress, the audit's goal figures); the 7th — dropping the card's status filter — is an equivalent mutant (only behind / overdue / due goals carry text).
REGRESSION RISKS: The plan object gains `emergency` and `goals` (additive; the A4 signature reads only the headline). getAdviceInputs reads one more table (financial_goals) wherever the plan is worked out (the card, Ask, each insight run, the daily plan-change check). The insight prompt grows by a few lines.
INVARIANTS AT RISK: None — INV-150 (every figure computed in code; the audit's plan figures now include the goal amounts), INV-11 (goal progress via deriveGoalProgress), INV-148 (no money colour on the tracker; the bar is the accent) hold.
NET SCORE: 0 production fixes − 0 new failure modes = 0 (new capability)

OPERATOR ACTIONS / DEPLOY:
- None | BLOCKS DEPLOY: N
Deploy: Platform, Shell & Auth — Render auto-deploys on push to `main`.

(Not complete in production until blocking operator actions are done AND
the deploy step is confirmed.)

FOLLOW-ON ITEMS:
- The emergency fund is still all spendable cash (A1's choice), so the tracker's "have" is checking + savings, not a named account or goal; months covered uses the 3 completed months' average spending.
- The goal catch-up doesn't compete with the plan's order: it says what finishes the goal on time, even while the plan puts the surplus toward debt; the two amounts aren't reconciled.
- A goal behind its date doesn't trigger the plan-change notification (A4's signature reads the headline only) — deliberate for now: a balance-derived goal near the $5 bar could flap.
- A goal's catch-up stated per month ("$333 a month to House") isn't audited (the audit checks named debts' monthly figures only).
- The pre-existing date-dependent tests/contract/cash-alerts-l2 test (A4 follow-on) still fails in months with 31 days.

DOCUMENTATION UPDATES NEEDED:
- CLAUDE.md: advice.js's entry (eight sources, goals non-critical, the tracker + goal catch-up), the cash_plan module text (the block's new lines), the audit's plan figures (goal amounts), ask.js's get_cash_plan, the dashboard "Your plan" description, Known Open Issues T4.1 (A5 done + follow-ons), Priority Next Features (A6 next), INV-150, test counts (2825 / 150 files, contract 278), the new test file entry.
- README: count + the A5 clause.
---END BROAD SCAN IMPLEMENTATION SUMMARY---
