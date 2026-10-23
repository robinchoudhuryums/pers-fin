---BROAD SCAN IMPLEMENTATION SUMMARY---
Findings implemented:
- F61 — a dollar claim about a named other month ("In September, Dining hit $450", "2026-09: …", "$210 in August") is treated as cross-period and not compared with this month's partial spend (no more false CRITICAL + alert push); the current month's own name stays checkable
- F62 — the AI goal-tracking prompt shows funding-linked goals at balance − baseline via the shared deriveGoalProgress (INV-11), not the stale stored current_amount
- F64 — Ask sets its `charged` flag only after the usage row is written, so a failed write is retried by the `finally` block instead of letting the tokens escape the cap
- F65 — Ask's last round is sent tool_choice "none", so it answers in text instead of calling a tool and ending in "I couldn't produce an answer"
- F66 — Ask's "today" is the APP_TIMEZONE date; Ask records the model that served the call (msg.model); monthAiSpendCents counts from the APP_TIMEZONE month start (invalid zone → UTC)
- F67 — tier-2 entity capture takes a run of Capitalized words only and splits "A and/or/vs B", so "Fakemart and Amazon" no longer passes because it contains a known name
- F68 — a dollar claim's period is read from its own sentence up to the claim plus the rest of its clause (not ±80/40 characters reaching into neighbouring sentences); "$1.2k" / "$1.5M" are scaled
- F70 — budget suggestions: the tool's category is an enum of the categories sent and replies are filtered to them, once; Accept de-duplicates by (trimmed) category, last wins, instead of a Postgres "cannot affect row a second time" 500
- F71 — dates in the insight prompt (anomaly date, card due date, goal target date, credit-score date) are ISO 'YYYY-MM-DD' via isoDate, not JS Date toString
- F72 — the weekly digest plain text lists Recently Completed goals; the insight email's "Open Dashboard" links the real dashboard URL (RENDER_EXTERNAL_URL + /perfin under the shell) and is omitted when unknown, instead of href="#"
New capabilities (G/ST): None
Files modified:
- teller/services/ai-audit.js
- teller/routes/ask.js
- teller/routes/insights.js
- teller/routes/insights-email.js
- teller/routes/budgets.js
- teller/routes/goals.js
- teller/routes/persistent.js
- tests/ai-cap-charge.test.js (spend-query mock key)
- tests/scan-sept-batch7.test.js (spend-query pin + mock key)
- tests/scan-oct-batch8.test.js (new)
- tests/contract/ai-trust.contract.test.js (new)

CHANGES:
F61 | ai-audit.js | MONTH_NAME_RE (case-sensitive month names + YYYY-MM) + namesOtherMonth(window, thisMonth) + claimNamesOtherMonth (a month named before the figure in its sentence, or attached right after: in/for/during/of <Month>); tier 1 skips the claim as cross-period unless THIS_MONTH_RE matches
F62 | insights.js, goals.js | goal query LEFT JOINs linked_accounts / investment_accounts; current = deriveGoalProgress(g).current; goals.js exports deriveGoalProgress after module.exports = router (INV-19)
F64 | ask.js | chargeAsk sets charged = true after the INSERT
F65 | ask.js | lastRound → tool_choice { type: "none" } (not a forced choice, INV-76)
F66 | ask.js, insights.js | system prompt uses todayStr(); modelId = msg.model when present (modelRates strips dated suffixes); monthAiSpendCents: created_at >= ($1::date::timestamp AT TIME ZONE $2) with currentMonth()+'-01' and a validated zone
F67 | ai-audit.js | bounded Capitalized-run capture; split on and/or/vs/versus
F68 | ai-audit.js | claimPeriodParts / claimPeriodWindow (sentence lead + clause trail) feed CROSS_PERIOD_RE / THIS_MONTH_RE; extractDollarClaims scales k/M suffixes
F70 | budgets.js | suggest tool category enum + hasOwnProperty/seen filter; accept trims + Map de-dup (last wins)
F71 | insights.js | isoDate (csv-export) on r.date, next_payment_due_date, target_date, checked_at
F72 | insights-email.js, persistent.js, insights.js | renderWeeklyDigestText RECENTLY COMPLETED section; renderInsightEmail(…, dashboardUrl) link only when known; persistent.perfinDashboardUrl()

TEST RESULTS: npm test 1608/1608 (+17 scan-oct-batch8); contract 82/82 (+4 ai-trust); migrations run twice OK (no schema change). Against the pre-fix code 15 of the original 16 unit pins and 3 of 4 contract tests fail — the passing ones pin unchanged behaviour (entityKnown on a single name; the spend month under the default UTC zone, which the unit pin covers). Playwright not re-run (no page, view or client-script change). Two existing test mocks keyed on the old spend SQL (`date_trunc('month'`) and one source pin of it were updated to the new query.
REGRESSION RISKS:
- F61: a claim about this month in a sentence that names another month BEFORE it without "this month" ("September was quiet while Dining hit $450") is now skipped — a possible false negative, chosen over the false CRITICAL; an explicit "this month" still forces the check.
- F67: a merchant whose name has a lower-case word ("Bed Bath and Beyond") is checked as its parts; each part still matches a known full name by whole word.
- F66: Ask usage rows now store the served model ID (may be dated); pricing strips the date, so the cap reads the same rate.
- F72: no dashboard link when RENDER_EXTERNAL_URL is unset (local / Fly) — same as before in practice, the old link went nowhere.
- F70: a suggestion for a category not in the last 3 complete months is dropped.
INVARIANTS AT RISK: None — INV-14 (one spend reader, now APP_TIMEZONE-anchored), INV-55 (Ask charge in finally, strengthened), INV-76 (tool_choice "none" is not forced; scan passes), INV-11 (now also in the prompt), INV-19 (export after the router), INV-15 (dated IDs priced via modelRates), INV-106 (the new catch carries a comment).
NET SCORE: 4 − 1 = 3 (F61, F62, F71, F72 fired in production; F61's month attribution adds a documented false-negative mode)

OPERATOR ACTIONS / DEPLOY:
- None (no schema or env change; RENDER_EXTERNAL_URL is set by Render automatically) | BLOCKS DEPLOY: N
Deploy: Platform, Shell & Auth: Render auto-deploys on push to `main` (configured in the Render dashboard, not via CLI). Alt: `fly deploy` (Dockerfile-based).

(Not complete in production until blocking operator actions are done AND
the deploy step is confirmed.)

FOLLOW-ON ITEMS:
- The tier-2 "cancel" pattern is lower-case only, so "Cancel Netflix" at a sentence start isn't captured (pre-existing).
- Ask tool results serialize DATE columns via JSON (ISO with a time part); only the insight prompt was converted.
- Other AI usage rows (categorize, suggest, scan) still record the configured model ID rather than the served one.
(or "None")

DOCUMENTATION UPDATES NEEDED:
- CLAUDE.md: AI insight auditing (named other month, sentence/clause period window, k/M suffix, bounded entity capture); Ask (last round tool_choice none, APP_TIMEZONE date, served model, charge flag after the write — ask.js entry + INV-55); monthAiSpendCents APP_TIMEZONE month (cost tracking + INV-14 + APP_TIMEZONE list); AI budget suggestions (category enum + de-dup) + POST /api/budgets/accept de-dup; goal-tracking prompt via deriveGoalProgress (INV-11 note); ISO prompt dates; weekly digest text completed goals + the insight email dashboard link (RENDER_EXTERNAL_URL note); test counts (1608 across 75 files, Perfin 1152; contract 82); Known Issues (Batch 8 follow-ons).
- README: counts + Batch 8 summary.
---END BROAD SCAN IMPLEMENTATION SUMMARY---
