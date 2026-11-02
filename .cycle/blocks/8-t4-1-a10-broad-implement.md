---BROAD SCAN IMPLEMENTATION SUMMARY---
Findings implemented: None (roadmap work, not scan findings)
New capabilities (G/ST): Roadmap T4.1 A10 (.cycle/plan-t4-1-advisory.md) — contribution room (yearly limits entered by hand per investment account, compared with this calendar year's contributions recorded in investment_flows; no account type assumed) and what-if questions in Ask (get_cash_plan with an extra payment on one carried debt and / or income / spending up or down a month — the same engine on changed inputs, with a before / after comparison)
Files modified: teller/services/advice.js, teller/services/database.js, teller/routes/settings.js, teller/routes/ask.js, teller/routes/insights.js, teller/views/dashboard.ejs, teller/views/settings.ejs, tests/roadmap-t4-1-a10.test.js (new), tests/roadmap-t4-1-a1.test.js, tests/roadmap-t4-1-a2.test.js, tests/roadmap-t4-1-a5.test.js, tests/roadmap-t4-1-a6.test.js, tests/roadmap-t4-1-a7.test.js, tests/roadmap-t4-1-a8.test.js, tests/roadmap-t4-1-a9.test.js, tests/contract/advice-a1.contract.test.js

CHANGES:
A10 | teller/services/database.js | user_settings.contribution_limits JSONB NOT NULL DEFAULT '{}' — { "investment:<id>" | "linked:<id>": dollars }
A10 | teller/routes/settings.js | GET selects contribution_limits (default {}); PATCH validates an object or null — keys investment:<id> / linked:<id>, values 0–1,000,000 (a number or numeric string), cents-rounded — and replaces the whole map; a bad shape / key / value is a 400 with nothing written (INV-59)
A10 | teller/services/advice.js | a 14th, NON-critical source `contributions` (CONTRIBUTION_ACCOUNTS_SQL — the GET /api/investments list: Teller-linked investment accounts without a Plaid item as linked:<id>, active investment_accounts as investment:<id>, with plaid / flows_synced_at; CONTRIBUTION_FLOWS_SQL — SUM of flow_type='contribution' from Jan 1 of today's year to today per source + id); normalizeLimits, periodsLeftInYear (paychecks / months after today, ≥1), contributionRoom (per limited existing account: contributed, limit, room, per_period rounded UP to the dollar to fill it by Dec 31, reached, contributions_unknown for a Plaid account whose flows haven't synced; "Your plan's investing could go here first" on the invest / medium step; most room first; a $0 limit or a gone account left out) → plan.contribution_room ({ year, accounts, room_total } or null); normalizeDebts honours a raw row's what_if_extra_monthly (minimum + extra, capped at the balance); applyWhatIf (extra_payment { debt, amount_monthly } matched exact name / mask first, else one partial match, among CARRIED debts with a payment; income / spending change a month applied to every month row; the lowest projected cash day moved by income − spending − extra a month until it; inputs never changed in place; every refusal a sentence) and whatIfPlan (base + changed buildAdvicePlan, before / after step, text, amount, emergency month, each debt whose payment or payoff moved with its interest change, a worded `text`, the changed plan); plan.what_if
A10 | teller/routes/ask.js | get_cash_plan takes optional extra_payment / income_change_monthly / spending_change_monthly; with any, it runs whatIfPlan on getAdviceInputs and returns the changed plan trimmed + what_if { changes, before, after, debts, text }; a refusal → { ok:false, error, disclaimer }; the trimmed plan carries contribution_room; the description and the system prompt send what-if questions to it
A10 | teller/routes/insights.js | cashPlanPromptBlock adds "Contribution room (yearly limits the user entered):" lines
A10 | teller/views/dashboard.ejs | the "Your plan" card lists each contribution-room line
A10 | teller/views/settings.ejs | Settings → Planning → Target Allocation gains a "Yearly contribution limits" row (no new section): one labelled box per GET /api/investments account (blank = no limit), Save limits → PATCH through writeOk, single-flight; renderContribLimits / readContribLimits pure
A10 | tests | roadmap-t4-1-a10.test.js (21 tests); the a1/a5–a9 doubles gain `contributions`; a2's schema pin now lists the three overrides; contract advice-a1 gains A10 (limits via PATCH, flows via POST /api/investment-flows — last year's and a withdrawal left out — GET /api/advice's contribution_room, a what-if on real inputs)

TEST RESULTS: npm test 2917/2917 (21 new). Contract 282/283 — the one failure is the known date-dependent cash-alerts-l2 "a dip below the floor" (31-day months, pre-existing). Mutation checks (per-period rounded down, no lowest-day shift, extra ignored, flow_type filter dropped, invest note always on, unknown-flows flag off, no exact-name match) each turn a10 red.
REGRESSION RISKS: get_cash_plan's input_schema is no longer empty (a2 pin updated); Ask calls without overrides behave as before. Every advice read runs three more queries (settings, accounts, flows). A Teller-linked investment account counts only manual flows (Teller syncs none).
INVARIANTS AT RISK: INV-150 (every figure from code — contribution room and what-if are computed in advice.js; what-if runs buildAdvicePlan, never the model) — held; INV-59 (contribution_limits 400s) — held; INV-14 unaffected (no new model call).
NET SCORE: 0 production fixes − 0 new failure modes = 0 (new capability)

OPERATOR ACTIONS / DEPLOY:
- None | BLOCKS DEPLOY: N (the migration is auto-applied)
Deploy: Platform, Shell & Auth: Render auto-deploys on push to `main`.

(Not complete in production until blocking operator actions are done AND
the deploy step is confirmed.)

FOLLOW-ON ITEMS:
- Contribution room counts only flows recorded as contributions: a Plaid "deposit" / "contribution" subtype, or a manual log — payroll 401(k) deferrals Plaid reports differently, employer matches and a Teller-linked account's contributions (Teller syncs no flows) need a manual log; a rollover or transfer in isn't counted.
- The limits are per account, calendar year; an IRA contribution made Jan–Apr for the prior year counts in the year it's dated; a limit shared across accounts (all IRAs together) has to be split by hand.
- What-if raises a debt's minimum, so 60% of the change comes out of the recommendation (the rest from the slack) — a "pay $300 more" whose debt is already the plan's target shows a smaller net change on that debt; the lowest projected day is shifted linearly (a 30-day month), not re-forecast; income / spending changes apply to every month read (creep and raise detection read their own sources, unchanged).
- What-if isn't audited (Ask's answers aren't) and isn't on the card; no notification for contribution room.
- Settings' limits editor has no per-row "clear" control (empty the box and save).

DOCUMENTATION UPDATES NEEDED:
- CLAUDE.md: advice.js (the contributions source, contributionRoom, applyWhatIf / whatIfPlan), routes/settings.js + the PATCH list (contribution_limits), user_settings.contribution_limits under Database, ask.js's get_cash_plan overrides, the cash_plan block, Settings layout (Target Allocation's limits row), INV-150 (A10), INV-59, Known Open Issues (A1–A10 done, fourteen sources, A10 follow-ons), Priority Next Features (T4.1 done), counts 2917 / 155 / Perfin 2196 / contract 283 + the new test entry.
- README: counts + a clause.
---END BROAD SCAN IMPLEMENTATION SUMMARY---
