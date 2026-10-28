---BROAD SCAN IMPLEMENTATION SUMMARY---
Findings implemented: None (roadmap work, not scan findings)
New capabilities (G/ST): Roadmap T4.1 A9 (.cycle/plan-t4-1-advisory.md) — sinking funds for quarterly / yearly bills ("set aside $X a month until <date>, then $Y a month") and subscription consolidation (overlapping services — "keeping just one would save $X to $Y a month" — and memberships with no other purchase from their store in 90 days)
Files modified: teller/services/advice.js, teller/routes/insights.js, teller/routes/ask.js, teller/views/dashboard.ejs, tests/roadmap-t4-1-a9.test.js (new), tests/roadmap-t4-1-a1.test.js, tests/roadmap-t4-1-a5.test.js, tests/roadmap-t4-1-a6.test.js, tests/roadmap-t4-1-a7.test.js, tests/roadmap-t4-1-a8.test.js, tests/contract/advice-a1.contract.test.js

CHANGES:
A9 | teller/services/advice.js | a 13th, NON-critical source `subscriptions` (SUBSCRIPTIONS_SQL: active detected subscriptions not dismissed or cancelled, dates as ::text; SINKING_BILLS_SQL: active quarterly / yearly manual bills; MEMBERSHIP_ACTIVITY_SQL: 90 days of settled debits whose display merchant names a membership store, word boundaries — INV-10) — a failure is null + "Your subscriptions and bills couldn't be read.", the plan still worked out; sinkingFunds: each detected subscription billed every 90+ days and each quarterly / yearly manual bill of SINKING_MIN ($100)+, its next date by cadence.seriesOccurrences / manualBillOccurrences (INV-70), the set-aside per month rounded up to the dollar until then and the steady amount after, soonest first, at most 8; subscriptionReview: OVERLAP_GROUPS (video / music streaming, cloud storage, VPN, password manager — a service counted in its first group) with two or more members → total, save range, text; MEMBERSHIPS (Amazon Prime — not Prime Video — Costco, Walmart+, Instacart, DashPass, Uber One, Grubhub) at least 90 days old with no purchase from the store in 90 days other than a charge within 50 cents of the fee → unused; monthly = Perfin's monthly equivalent (amount × 30 / cadence days); plan.sinking_funds { bills, total_monthly (the steady sum), text } and plan.subscription_review { overlaps, unused, save_max_monthly } (each null when the source failed)
A9 | teller/routes/insights.js | cashPlanPromptBlock: "Sinking funds (quarterly / yearly bills):" and "Subscriptions to review:" lines
A9 | teller/routes/ask.js | get_cash_plan: sinking_funds, subscription_review; the tool description
A9 | teller/views/dashboard.ejs | the "Your plan" card lists the sinking-fund total and bills, the overlaps and the unused memberships
A9 | tests | new roadmap-t4-1-a9 (13 tests); the A1 / A5–A8 input doubles gain the subscriptions source; advice-a1 contract: a quarterly subscription, a quarterly manual bill and a yearly membership as sinking funds (dates equal to the cadence helpers; a monthly bill and a cancelled service left out), a Netflix + Hulu overlap, an Amazon Prime with no other purchase (Costco with one) through GET /api/advice

TEST RESULTS: npm test 2896/2896 (13 new; 154 files). Contract 281/282 — the one failure is the known pre-existing date-dependent cash-alerts-l2 "a dip below the floor" (31-day months). Mutation checks (the fee tolerance, one group per service, the 90-day age, the months divisor, the two-service minimum) each turn the A9 tests red.
REGRESSION RISKS: every advice read (the card, Ask, each insight run) runs three more queries (all active subscriptions, quarterly / yearly manual bills, 90 days of store purchases); the new source is non-critical, so a failure only drops the two A9 fields; no existing field changed.
INVARIANTS AT RISK: INV-150 (extended — the A9 figures come from code), INV-70 (honoured — the next dates come from cadence.js), INV-10 (honoured — word-boundary matching in SQL and JS). None violated.
NET SCORE: 0 production fixes − 0 new failure modes = 0 (new capability)

OPERATOR ACTIONS / DEPLOY:
- None — no migration, no setting, no env var | BLOCKS DEPLOY: N
Deploy: Platform, Shell & Auth: Render auto-deploys on push to `main`.

(Not complete in production until blocking operator actions are done AND
the deploy step is confirmed.)

FOLLOW-ON ITEMS:
- The surplus doesn't subtract the sinking-fund amount — a yearly bill outside the last 3 completed months can make the surplus read high (the 60% slack partly absorbs it).
- A detected subscription with a 60-day cadence isn't a sinking fund; only 90+ days.
- Overlap groups and memberships are fixed keyword lists; a service under an unusual name, or one in another category, isn't grouped — and "keeping just one" doesn't know which you use.
- A membership's store purchases are matched on the display merchant only (a purchase recorded under another name — "AMZN Mktp" is matched by "amzn", but a third-party seller isn't); a membership bundled into another plan (Prime through a phone carrier) never shows as a subscription.
- Nothing notifies for A9 (the plan-change push reads the headline only).
- The audit doesn't check the sinking-fund or subscription figures (no per-paycheck period).
- Pre-existing: tests/contract/cash-alerts-l2 "a dip below the floor" fails in 31-day months.

DOCUMENTATION UPDATES NEEDED:
- CLAUDE.md: advice.js (A9 — the subscriptions source, sinkingFunds, subscriptionReview, the two plan fields), the cash_plan block / Ask additions, Known Open Issues (A1–A9 done + A9 follow-ons; "thirteen sources"), Priority Next Features (A10 next), INV-150, counts 2896 / 154 / Perfin 2175 / contract 282 + the new test entry.
- README: test counts and clause.
---END BROAD SCAN IMPLEMENTATION SUMMARY---
