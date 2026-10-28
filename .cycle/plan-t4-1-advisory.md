# Roadmap T4.1 — "Where should my extra money go?" (plan, 2026-10-27)

Status: QUEUED. Starts after the cycle-8 batches (Batches 5–8, then the cycle-8
`/reflect`). Not started; nothing below is built yet.

Scope: the debt-first surplus plan (A1–A4) plus twelve further advisors (A5–A10).

Goal: when you consistently end the month with money left over, Perfin says what to do
with it, in order. Debt first when that is the better advice, with an amount per credit
card. Then the emergency fund. Then investing, as "$X more per paycheck". The advice
appears on the dashboard and in AI insights. An optional notification can say when the
advice changes.

## What exists (read for this plan)
- **Income and spending by month:** `getMonthlyIncome` / `getMonthlySpending`
  (financial-queries.js). Both are split-adjusted, net of refunds and whole-month. The
  current month is partial and must be left out of any trend.
- **Pay schedule:** `getLiveIncomeStreams` gives each source's cadence (weekly /
  biweekly / semimonthly / monthly) and its median amount.
- **Cash:** `getCashFlowForecast` gives spendable cash (depository, non-investment), the
  lowest projected day and `firstBelow`. `cash_alert_threshold` is the user's cash floor
  (default $500).
- **Cards and loans:** `linked_accounts` stores `apr` (Plaid Liabilities or manual),
  `credit_limit`, `minimum_payment`, `next_payment_due_date`, `last_payment_amount` /
  `_date`, and a loan's `monthly_payment`. `computeLoanPayoff` (projections.js) does
  amortization. Discover reports no APR or limit through Plaid; auto loans never get
  terms from Plaid. Both are covered by the manual fields.
- **Debt optimizer insight module:** already gives Claude the cards and loans and asks
  for avalanche vs snowball. It is prompt-only: no numbers are computed for the user and
  nothing appears on the dashboard.
- **Other inputs:** recurring transfers typed `savings` / `investment` (what you already
  move each month), goals with funding accounts, Target Allocation drift, the running
  summary's `pending_actions`, and the Ask tools.

## Decisions (proposed; confirm at the first `/broad-implement`)
1. **The numbers come from code, not the model.** A pure engine,
   `services/advice.js` `buildAdvicePlan(inputs)`, computes every amount. The insight
   module and Ask only word the engine's output. This keeps the audit able to check every
   figure, and the dashboard card costs no AI spend.
2. **Order of the plan.** The first step that applies becomes the headline:
   1. **Minimum payments** on every card and loan are always covered first.
   2. **Starter cash buffer:** keep spendable cash at least your floor plus one month of
      spending. Before then, nothing goes to investing.
   3. **High-interest card debt (APR ≥ 8%):** the whole surplus goes here, using the
      avalanche order (described in decision 4).
   4. **Emergency fund to 3 months** of average spending.
   5. **Medium-interest debt (APR 4–8%):** split the surplus 50/50 between this debt and
      investing.
   6. **Invest:** low or 0% debt gets minimums only, and the rest is invested.
3. **"Carrying a balance" is detected.** A card paid in full every month is not debt. It
   counts as carried when there was an interest charge on it in the last 60 days, or its
   last payment was smaller than the balance it was paying. Detection uses Plaid's PFC
   interest category or an "interest charge" description. A card with an unknown APR is
   treated as 22% and says "APR unknown — assumed 22%; set it on the card".
4. **Per-card allocation (avalanche).** Each card gets its minimum (stored, else the
   larger of $25 and 1% of the balance plus a month's estimated interest). Whatever the
   step allows on top goes to the highest-APR card; a tie goes to the smaller balance.
   Overflow moves to the next card. The output is per card: pay $X per paycheck, payoff
   month, and interest saved compared with minimums only. A one-line note gives the
   snowball alternative and its extra cost. An optional utilization tip applies to a card
   above 30% of its limit: "paying $Y before the due date brings it under 30%".
5. **Sustained surplus.** It counts only when the last **3 completed months** each
   show net (income − spending) of at least **max($200, 10% of that month's income)**.
   - The surplus is the **median** of those three months' net.
   - It is reduced by money already moved each month to savings or investment through
     recurring transfers, so the same money isn't counted twice.
   - It is also reduced if needed so the lowest projected cash day in the next 60 days
     stays at or above the floor.
   - The plan recommends **60%** of the result and keeps the rest as slack. It is
     rounded down to $25 per paycheck.
   - No surplus → no investing step. The card says why ("2 of the last 3 months were
     under $200 net").
6. **Per paycheck.** A monthly amount × 12 ÷ paychecks a year, using the main income
   stream's cadence (52 / 26 / 24 / 12). With no live stream, the amount is shown per
   month.
7. **Where it shows.**
   - A dashboard card "Your plan" (`DASHBOARD_WIDGETS` key `advice`, on by default)
     shows the headline step, the per-card table and "why". It goes after the summary in
     the D4 order, before the charts.
   - A new insight module `cash_plan` replaces the debt optimizer's free-form avalanche
     text. That module keeps its utilization and credit-score context.
   - Ask gets a `get_cash_plan` tool.
8. **Notify: one checkbox, off by default.** "Tell me when my plan changes" sits under
   Settings → Alerts & Notifications, inside the existing Cash Alerts section, not a new
   section. It is stored as `user_settings.advice_alerts_enabled` plus an
   `advice_state` signature. An away job checks at most daily and pushes only when the
   headline step changes or the per-paycheck amount moves ≥ 20% (and ≥ $50) — for
   example "Card X is paid off — your plan now puts $250 per paycheck toward the
   emergency fund". It is push only, never email.
9. **The thresholds are constants.** Every threshold above ships as a named constant in
   `services/advice.js`, not a setting. A setting can be added later if one of them is
   wrong for you (decision 8 keeps Settings small).
10. **Every view carries a disclaimer:** "Educational, based on your data — not
    financial advice." The plan never names a security or a fund.

## Batches (broad-implement sized)
| Batch | Scope | Status |
|-------|-------|--------|
| A1 | `services/advice.js`: `getAdviceInputs(pool)` (one read per source, each fail-soft) and the pure `buildAdvicePlan` (decisions 2–6). Carried-balance detection. Unit tests over canned inputs: each step as headline, per-card avalanche with overflow, unknown APR, 0% card, the surplus gate, transfers already moving money, the cash-floor cap, per-paycheck rounding. A contract test on real rows. | done (block `.cycle/blocks/8-t4-1-a1-broad-implement.md`) |
| A2 | `GET /api/advice` plus the dashboard "Your plan" card (empty state through `emptyState`, money colours per INV-148), the `DASHBOARD_WIDGETS` entry in page order, and the Ask `get_cash_plan` tool. | done (2026-10-27) |
| A3 | The `cash_plan` insight module: the engine's output goes in the prompt and the model words it. The audit's arithmetic tier checks the figures against the engine. Running-summary `pending_actions` are seeded from the plan's steps. | done (2026-10-27) |
| A4 | The notify checkbox, the `advice-plan` away job (INV-77 pattern, signature dedup, marked only when logged), the migration, and reset-fresh classification. | done (2026-10-28) |
| A5 | Emergency-fund tracker (months of spending covered, progress bar, target-date projection) and the goal catch-up amount (a goal behind its target date → "add $X per paycheck to finish on time", from `deriveGoalProgress`). | done (2026-10-28) |
| A6 | Raise / bonus split (a stream's amount steps up into a new cluster, or a one-off large deposit lands → split it by the plan's order) and spending creep (a category whose 3-month average grew faster than income over 6 months). | done (2026-10-28) |
| A7 | Idle cash (checking above floor + buffer for 60+ days while a savings or brokerage account exists → "move $X") and rebalancing directions (Target Allocation drift > 5 points → "move ~$X from bonds to equities"; directions only, never securities). | done (2026-10-28) |
| A8 | Statement-date utilization (store Plaid Liabilities `last_statement_issue_date` / statement balance, then "pay $Y before <date> to report under 30%") and loan extra payments ("an extra $100/month saves $Y and ends it Z months early", `computeLoanPayoff`). | done (2026-10-28) |
| A9 | Sinking funds for yearly / quarterly bills ("set aside $X/month") and subscription consolidation (overlapping services, ones with no related activity — builds on the subscription audit). | done (2026-10-28) |
| A10 | Tax-advantaged room (yearly limits entered by hand, compared with contributions seen in investment flows; no account types assumed) and what-if questions in Ask (`get_cash_plan` with overrides: "pay $300 more on card X", "rent goes up $150" — the same engine on changed inputs). | queued |

A5–A10 surface through the same three places as the plan (the "Your plan" card's
secondary list, the `cash_plan` insight module, Ask) and the same notify checkbox — no
new Settings sections. Each advisor is a pure function in `services/advice.js` over
`getAdviceInputs`, computes its own figures (decision 1), carries the disclaimer
(decision 10) and keeps its thresholds as named constants (decision 9). A8's statement
fields need a migration and a liabilities-sync change.

