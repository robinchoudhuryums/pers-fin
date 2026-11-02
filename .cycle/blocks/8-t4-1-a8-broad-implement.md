---BROAD SCAN IMPLEMENTATION SUMMARY---
Findings implemented: None (roadmap work, not scan findings)
New capabilities (G/ST): Roadmap T4.1 A8 (.cycle/plan-t4-1-advisory.md) — statement-date utilization (the card's last statement stored from Plaid Liabilities; the 30% tip names the day the next statement closes; the carried-balance test reads the statement) and loan extra payments ("an extra $100 a month on <loan> would save $Y and pay it off Z months sooner", computeLoanPayoff)
Files modified: teller/services/database.js, teller/routes/investments.js, teller/services/advice.js, teller/routes/insights.js, teller/routes/ask.js, teller/services/ai-audit.js, teller/views/dashboard.ejs, tests/roadmap-t4-1-a8.test.js (new), tests/roadmap-t4-1-a1.test.js, tests/roadmap-t4-1-a2.test.js, tests/contract/advice-a1.contract.test.js

CHANGES:
A8 | teller/services/database.js | linked_accounts.last_statement_balance NUMERIC(12,2) + last_statement_issue_date DATE (ADD COLUMN IF NOT EXISTS)
A8 | teller/routes/investments.js | syncPlaidLiabilities writes a credit card's last_statement_balance (`??`, a $0 statement kept) and last_statement_issue_date
A8 | teller/services/advice.js | DEBTS_SQL reads the statement columns (dates as ::text, last_payment_date too); nextStatementDate (last statement + k calendar months, day clamped via addMonthsYmd; null when older than STATEMENT_MAX_AGE_DAYS 62, future-dated or malformed); carryStatus: a payment made on/after the last statement under STATEMENT_PAID_SHARE (95%) of it → carried ("statement_not_paid"), at or above → "statement_paid" (beats the minimum-payment stand-in; interest still decides first); normalizeDebts(rows, activity, today): each card carries statement { last_date, last_balance, reported_pct, next_date } and its utilization tip gains by / basis — "before <Mon D>, when its next statement closes, keeps the balance it reports under 30%" when the next close is known, else the old due-date text; loanExtraPayments: each carried loan with APR > 0 and a payment, not already funded with extra by the plan's allocation, compared at payment vs payment + LOAN_EXTRA_MONTHLY ($100) through computeLoanPayoff → months sooner, interest saved, both payoff months, a low-tier note; plan.loan_extra; header comment
A8 | teller/routes/insights.js | cashPlanPromptBlock: "Loan extra payments:" lines (the statement tip already flows through "Utilization tips:")
A8 | teller/routes/ask.js | get_cash_plan: loan_extra, each debt's next_statement_date + last_statement_reported_pct; the tool description
A8 | teller/services/ai-audit.js | planFigures: a loan's extra $100 and its payment with it join that loan's monthly figures (so "put $100 a month extra on Car Loan" isn't a false finding)
A8 | teller/views/dashboard.ejs | the "Your plan" card lists the loan lines
A8 | tests | new roadmap-t4-1-a8 (13 tests); a1's tip deepEqual gains by / basis; a2's trimmed-debt keys gain the two statement fields; advice-a1 contract: Amex's statement paid in full (statement_paid, the tip's close date, reported 18%) and a car loan's extra $100 equal to computeLoanPayoff, through GET /api/advice

TEST RESULTS: npm test 2883/2883 (13 new; 153 files). Contract 280/281 — the one failure is the known pre-existing date-dependent cash-alerts-l2 "a dip below the floor" (31-day months; documented in Known Open Issues). Mutation checks (the 95% share, the payment-after-statement order, the 62-day staleness, the low-tier note, the funded-loan exclusion) each turn the A8 tests red.
REGRESSION RISKS: once the liabilities sync fills the statement columns, a card's carried status can change (a minimum-sized payment that covered a small statement is now paid in full; a partial payment after a statement is now carried) — the plan's step can move, and with the plan-change alert on that pushes once; a refund posted between the statement and the payment can make a full payment read under 95% (carried until the next statement); utilization_tip gained fields (consumers read .text); DEBTS_SQL's last_payment_date is now text (no other reader).
INVARIANTS AT RISK: INV-150 (extended — every A8 figure comes from code; the audit's plan figures cover the loan extra), INV-22/INV-04 untouched (the liabilities write is the same UPDATE with two more columns), INV-17 (two idempotent ADD COLUMN IF NOT EXISTS). None violated.
NET SCORE: 0 production fixes − 0 new failure modes = 0 (new capability)

OPERATOR ACTIONS / DEPLOY:
- None — the columns auto-migrate and fill on the next Plaid balance sync (Teller and manual cards have no statement data and keep the due-date tip) | BLOCKS DEPLOY: N
Deploy: Platform, Shell & Auth: Render auto-deploys on push to `main`.

(Not complete in production until blocking operator actions are done AND
the deploy step is confirmed.)

FOLLOW-ON ITEMS:
- Teller-linked and manual cards have no statement date (no manual field) — they keep the due-date tip.
- The next statement is projected a calendar month from the last one; an issuer whose cycle is a fixed number of days drifts by a day or two.
- The tip compares today's balance with the limit; charges before the statement closes add to what it reports.
- A refund posted after the statement can make a full payment read as under 95% (carried until the next statement).
- The loan line uses a fixed $100 a month (a constant, not a setting); it doesn't account for a prepayment penalty or for the money's other uses beyond the low-tier note; a loan the plan already funds is left out.
- The audit doesn't check the loan line's "saves $Y" or "N months sooner".
- Pre-existing: tests/contract/cash-alerts-l2 "a dip below the floor" fails in 31-day months.

DOCUMENTATION UPDATES NEEDED:
- CLAUDE.md: advice.js (A8 — the statement columns, nextStatementDate, the carried test, the tip, loan_extra), investments.js liabilities sync, the linked_accounts columns in Database, the cash_plan block / Ask / audit additions, Known Open Issues (A1–A8 done + A8 follow-ons), Priority Next Features (A9 next), INV-150, counts 2883 / 153 / Perfin 2162 / contract 281 + the new test entry.
- README: test counts.
---END BROAD SCAN IMPLEMENTATION SUMMARY---
