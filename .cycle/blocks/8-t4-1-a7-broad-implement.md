---BROAD SCAN IMPLEMENTATION SUMMARY---
Findings implemented: None (roadmap work)
New capabilities (G/ST): Roadmap T4.1 A7 — idle cash and rebalancing directions
  - Idle cash: when checking (all checking accounts summed, each one's last balance snapshot carried forward) hasn't dropped below the plan's starter buffer (the floor + a month of spending) for 60 days, the excess (rounded down to $100, at least $500) is moved in the plan's order — high-interest debt first, then the emergency fund (to a savings account), then investing (to a brokerage that isn't tax-advantaged) — only to an account that exists, with money leaving cash capped so the lowest projected day stays at the floor. "Your checking hasn't dropped below $7,000.00 in 60 days — more than the $3,300.00 your plan keeps there … Move $3,000.00: $3,000.00 to Visa."
  - Rebalancing: a target-allocation class more than 5 points off → "Move about $3,000.00 from bond (45% now, target 30%) to equity (55% now, target 70%)." — overweight paired with underweight largest first, rounded to $100, asset classes only (never a security), with a note (pick the holdings yourself; selling in a taxable account can be taxed; new contributions can move the mix).
  - Surfaces: the "Your plan" card's secondary list, the cash_plan prompt block (with a never-name-a-security instruction) and Ask's get_cash_plan.
Files modified:
  teller/services/allocation.js (new), teller/routes/investments.js, teller/services/advice.js,
  teller/routes/insights.js, teller/routes/ask.js, teller/views/dashboard.ejs,
  tests/roadmap-t4-1-a7.test.js (new), tests/roadmap-t4-1-a1.test.js, tests/roadmap-t4-1-a5.test.js,
  tests/roadmap-t4-1-a6.test.js, tests/contract/advice-a1.contract.test.js

CHANGES:
A7 | teller/services/allocation.js | NEW — the one asset-class allocation: HOLDINGS_SQL, normalizeTargets, assetAllocation (per class value / known-basis value / share / target / drift; a targeted class with no holdings at 0%)
A7 | teller/routes/investments.js | GET /api/investments/performance reads HOLDINGS_SQL, normalizeTargets and assetAllocation (by_asset_class unchanged — same fields, order and figures); its totals / winners / losers loop unchanged
A7 | teller/services/advice.js | two NON-critical sources: idle (IDLE_ACCOUNTS_SQL — depository + investment linked accounts minus the Plaid brokerage phantom; IDLE_INVESTMENTS_SQL; IDLE_SNAPSHOTS_SQL — checking snapshots over 60 + 31 days) and allocation (the shared helper over holdings + target_allocation_pct); pure checkingLow / idleDestinations / rebalanceMoves; buildAdvicePlan adds idle_cash (splitWindfall's order mapped to real destinations, the floor cap on outflows) and rebalance; every threshold a named constant
A7 | teller/routes/insights.js | cashPlanPromptBlock: "Idle cash:" and "Rebalancing (directions between asset classes — never name a security or fund):" lines
A7 | teller/routes/ask.js | get_cash_plan returns idle_cash / rebalance; the description names them
A7 | teller/views/dashboard.ejs | the idle line, each move and the note in one adviceList
A7 | tests | 18 unit tests (roadmap-t4-1-a7: the helper and the route reading it, checkingLow, destinations, rebalanceMoves, idle cash per step + the cap + the nothing-to-show cases, readers' SQL, surfaces); A1 / A5 / A6 doubles carry the two sources; one contract test (a $9,000 checking dip with a $0 joint checking, a savings account, a taxable brokerage and its $0 phantom; moves only to real destinations; the bond → equity $3,000 move; the plan's drift equal to GET /api/investments/performance's; GET /api/advice the same)

TEST RESULTS: npm test 2870/2870 (18 new). Contract 279/280 — the 1 new A7 test passes; the failure is the known date-dependent cash-alerts-l2 "a dip below the floor" (fails in 31-day months; pre-existing). Mutation checks (the not-enough-history check, the carry-forward, the tax-advantaged exclusion, the 5-point drift, the floor cap on outflows, the savings requirement for the emergency move, the any-destination gate, the drift sign in the helper) each turn a test red.
REGRESSION RISKS:
  - GET /api/investments/performance now builds by_asset_class through the shared helper — same fields and figures (pinned against the helper and on real Postgres), but any later change to the helper changes the card too (by design).
  - Each advice read runs four more queries (three for idle cash, the holdings query and the targets read).
INVARIANTS AT RISK: None — INV-150 (every amount from buildAdvicePlan; no security named — the rebalance text carries only asset classes, pinned), INV-87 (holdings: an unknown basis isn't a known-basis value in the shared helper), INV-48 / INV-10 (no re-inlined predicates or new keyword filters), the getNetWorth phantom dedupe direction (the idle accounts query drops the linked phantom like getNetWorth).
NET SCORE: 0 production fixes − 0 new failure modes = 0 (new capability)

OPERATOR ACTIONS / DEPLOY:
- None | BLOCKS DEPLOY: N
Deploy: Platform, Shell & Auth: Render auto-deploys on push to `main` (after merge).

FOLLOW-ON ITEMS:
- Idle cash needs a balance snapshot from before the 60-day window for every checking account (balance syncs write them daily); a newly linked checking account hides the advice until then.
- "Checking" is subtype 'checking' only; savings is savings / money market / cash management; a brokerage is a linked investment account or investment_accounts row that isn't tax-advantaged by its subtype / account_type — a Teller-linked investment account with an empty subtype isn't a destination.
- Neither idle cash nor rebalancing notifies (A4's push names the headline, raises and bonuses only).
- Rebalancing covers Plaid holdings only (the Investments card's scope) and doesn't consider which account holds what (selling in a taxable account vs. a retirement one), wash sales, or a cash class drifting from new deposits.
- The emergency-fund part of idle cash names the first savings account; with several, the user may prefer another.
DOCUMENTATION UPDATES NEEDED:
- CLAUDE.md: services/allocation.js in the tree + the Financial Analytics subsystem list; advice.js's two new sources + the A7 advisors; the performance route reading the helper; the prompt / Ask additions; Known Open Issues (A7 follow-ons) + Priority Next Features; INV-150; counts 2870 / 152 / Perfin 2149 / contract 280 + the new test entry.
- README: counts + the advisor clause.
---END BROAD SCAN IMPLEMENTATION SUMMARY---
