---BROAD SCAN IMPLEMENTATION SUMMARY---
Findings implemented:
- AIN-9 — the model price table is keyed by model ID, with corrected rates (Haiku 4.5 $1/$5, Opus 4.6 $5/$25).
- AIN-10 — POST /api/budgets/suggest is now capped and charged (entry_type='suggest'). One shared monthAiSpendCents() replaces the copy-pasted month-spend tally.
- AIN-1 — Tier-1 audit compares only the amount nearest a category name. It skips budget/benchmark/savings/cancel windows and comparator deltas, and needs total-phrasing before checking the subscription total.
- AIN-2 — Tier-2 entity check ignores months, weekdays and finance-noun headings; category names count as known. Heading bullets are captured only when a `$` follows.
- AIN-3 — the savings-rate check uses complete months (last complete month or the complete-month average; explicit "this month" uses the partial month). Tier 3 trend compares complete months.
- AIN-4 — the insight prompt labels the current month "(partial, through day DD)" and excludes it from trend deltas and seasonal history.
- AIN-5 — the anomaly baseline excludes the candidate's own row (LATERAL, t2.transaction_id <> t.transaction_id).
- AIN-7 — when a card's limit is unknown the debt prompt says "Utilization unknown" instead of 100%. Total limit and utilization cover only cards with a known limit, and include a manual credit_limit.
- AIN-8 — the running summary is preserved on max_tokens (generate and rebuild) and when any of the four arrays is missing. The insight tool is strict. Empty insight text is charged but not stored, audited or emailed. sanitizeStructuredSummary is exported and tested.
- AIN-11 — the recurring_transfers module toggle is honored.
- AIN-12 — every tax match is persisted (no top-15 cap). Stale unconfirmed, un-noted auto rows are pruned. Amounts are split-adjusted.
- AIN-14 — weekly digest alerts get their own critical/warning/info colour map.
- AIN-16 — docs aligned (the feedback retraction path; the insight email is also sent on manual runs). runWeeklyDigest skips an all-empty summary.
- SXE-7 — the tax report (CSV/PDF/JSON and the Sheets tab) is computed at export/sync time from transactions. One row per transaction, with dates, whole year, no LIMIT. tax_deductions is now the annotation layer. The Sheets prior-year tab is refreshed through April.

Files modified:
- teller/data/reference-data.js
- teller/routes/insights.js
- teller/routes/insights-email.js
- teller/routes/budgets.js
- teller/routes/ask.js
- teller/routes/categorize.js
- teller/routes/housing.js
- teller/routes/settings.js
- teller/services/ai-audit.js
- teller/services/financial-queries.js
- scripts/sheets-sync.js
- CLAUDE.md (AIN-16 doc alignment only)
- tests/scan-sept-batch7.test.js (new)
- tests/cycle-fixes.test.js
- tests/seams-audit.test.js

CHANGES:
AIN-9 | reference-data.js | MODEL_RATES_BY_ID keyed by model ID; legacy IDs keep historical prices because rows are re-priced at read time. modelRates(modelStr) tries the exact ID, then strips a dated suffix, then falls back to the family. MODEL_COST_PER_M is derived from MODEL_MAP. estimateCostUsd and estimateCostGranular use modelRates.
AIN-10 | insights.js, budgets.js, ask.js, categorize.js, housing.js | Exported monthAiSpendCents(db). All cap readers (status, generate, rebuild, ask, categorize, scan-bill, suggest) call it. Suggest returns 429 past the cap and writes an entry_type='suggest' usage row before tool validation (AIA2 parity).
AIN-1 | ai-audit.js | claimSegments takes the claim's own clause. attributeCategory picks the nearest category: last name occurrence ≤30 chars before with no open parenthetical, or "$X on|for|in <cat>". SKIP_WINDOW_RE covers budget/limit/target/goal/average/benchmark/national/typical/save/cut/reduce/cancel/switch/instead/could/would. DELTA_AFTER_RE catches "$X over/under/more…". The subscription total needs SUB_TOTAL_RE (total/all/combined/N subscriptions) and no category attribution. extractDollarClaims adds `raw`.
AIN-2 | ai-audit.js | isGenericName uses MONTH_DAY_RE plus the GENERIC_WORDS finance-noun set. Category names are queried into the known set. The heading-bullet pattern needs a following `$`.
AIN-3 | ai-audit.js | Savings rate is checked against the closest of last-complete-month and complete-month-average; explicit THIS_MONTH_RE uses the partial month. Tier 3 filters to month < currentMonth().
AIN-4 | insights.js | monthLabel() is applied to the Monthly Spending and income_savings rows. Trend deltas use complete months only. The seasonal query adds `t.date < $1::date` (current month 1st).
AIN-5 | insights.js | The anomaly query is CROSS JOIN LATERAL per candidate, excluding its own transaction_id; HAVING became `avg_tbl.txn_count >= 3`.
AIN-7 | insights.js | cardLimit(): credit_limit, else owed+available when available is non-null, else null meaning "Limit unknown, Utilization unknown". Totals cover known-limit cards only, with a note about unknown-limit cards.
AIN-8 | insights.js | SUMMARY_KEYS: sanitize returns null unless all four are arrays. INSIGHT_TOOL strict:true plus additionalProperties:false on all 6 objects. hitTokenCap with a tool block → preserved_due_to_truncation. Empty text → an 'insight_empty' usage row (charged; not in the feed, accuracy or email) and ok:false 502. Rebuild returns 500 on stop_reason max_tokens after the charge, before any write. Rebuild max_tokens raised 1500→4000. sanitizeStructuredSummary and INSIGHT_TOOL are exported.
AIN-11 | insights.js | The recurring-transfer block is wrapped in `if (modules.recurring_transfers !== false)`.
AIN-12 | insights.js | The tax module uses the shared getTaxDeductionTransactions. The prompt shows the top 15; every merchant is upserted. A DELETE prunes this year's ai_detected rows that are unconfirmed, have no notes and whose merchant is no longer matched.
AIN-14 | insights-email.js | alertSev() map for critical/warning/info.
AIN-16 | insights.js, CLAUDE.md | runWeeklyDigest returns `empty_summary` when all four arrays are empty. CLAUDE.md documents the feedback-driven retraction path (no schema change) and that the insight email is also sent on manual runs (none for an empty run).
SXE-7 | financial-queries.js, settings.js, sheets-sync.js | New TAX_KEYWORD_GROUPS / TAX_KEYWORDS / TAX_REGEX (same regex text as before) and taxCategoryFor (longest phrase wins). getTaxDeductionTransactions(pool, year): make_date window, display merchant, SPLIT_AMOUNT > 0, reimbursed and pending excluded, TO_CHAR date, no LIMIT. /api/export/tax-report builds per-transaction rows and merges tax_deductions merchant annotations (category unless 'flagged'/'uncategorized', confirmed, notes); the default year is tz-aware. The Sheets tab inlines the same groups and query (pinned), fills the Date column, and refreshes the prior year through April (no empty past-year tab).

TEST RESULTS: passed — `npm test` 1376/1376 (Perfin 878 + Per-sistant 498; 54 files).
- New tests/scan-sept-batch7.test.js: 58 tests, including an 18-statement false-positive set of correct insights shaped like real module outputs. Run against the old source in a worktree, 47 of 57 fail (the parenthetical-attribution test was added after that run).
- Updated test doubles:
  - cycle-fixes AI-7 pin: the query moved into financial-queries.
  - seams-audit: the insights import regex accepts a longer destructure.
- Real PG 16:
  - getTaxDeductionTransactions: rename, reimbursed, 50% shared and partner-owned rows, box office, prior year.
  - generateInsights end-to-end, with no modules_failed:
    - the LATERAL anomaly flags a $150 charge after 3×$20 that the old JOIN suppressed;
    - "Utilization unknown" for a card with no limit;
    - the prune keeps confirmed and annotated rows and drops the renamed-merchant row and the old-keyword row;
    - export JSON/CSV/PDF and the prior-year export.
  - Full sheets syncAll returns errors [] with the "Tax Deductions 2026" tab written.
- Migrations ×2 OK. e2e 8/8.
- Regression scenarios:
  - S3 (AI cap) PASS via tests.
  - S5 (Sheets isolation) PASS (real-PG syncAll).
  - Others not applicable.

REGRESSION RISKS:
- AIN-1 trades recall for precision. A wrong figure inside a budget/benchmark/"would save" clause, or a category name more than 30 chars before its amount, is no longer checked. The warning/critical thresholds are unchanged.
- The tax export changed shape:
  - one row per transaction instead of one per merchant;
  - Type is "keyword_match";
  - amounts are the user's split share;
  - confirm and notes apply per merchant.
  Anyone diffing against an old export will see different rows.
- The Sheets tax tab's last column is now Date (was Flagged).
- strict:true on the insight tool depends on structured-outputs support for the configured models (Haiku 4.5 / Sonnet 4.6 / Opus 4.6 support it). It is not exercised against the live API here.
- The empty-insight path now returns 502 where it used to return 200 with empty text.
- The LATERAL anomaly query costs more per run (one per-candidate baseline scan). It runs at most every 6h, gated by cadence, which is fine at single-user scale.

INVARIANTS AT RISK: None violated.
- INV-14: strengthened (suggest is now charged; one spend reader).
- INV-15: rates corrected.
- INV-16: strengthened (missing keys preserve the prior summary).
- INV-07 / INV-48: the tax query imports SPLIT_AMOUNT. The Sheets copy is the documented standalone exception; its tax groups are pinned.
- INV-10: the tax regex is still word-boundary.
- INV-24: the tax tab stays inside step().
- INV-57: the audit-alert dedup is untouched.

NET SCORE: 14 − 0 = 14
- AIN-9 YES, AIN-10 YES, AIN-1 YES, AIN-2 YES, AIN-3 YES, AIN-4 YES, AIN-5 YES, AIN-7 YES, AIN-8 YES (Rebuild truncation was realistic at 1500 tokens), AIN-11 YES, AIN-12 YES, AIN-14 YES, AIN-16 YES (empty weekly digest), SXE-7 YES.
- No new failure modes. The 502 on empty text and the reduced audit recall are deliberate trade-offs, documented above.

OPERATOR ACTIONS / DEPLOY:
- None required | BLOCKS DEPLOY: N
- Optional: after deploy, re-download any already-exported tax report for the current/prior year; the new export is computed from transactions. | BLOCKS DEPLOY: N
Deploy:
- Platform, Shell & Auth: Render auto-deploys on push to `main`.
- Sheets & External Export: server-side sheets-sync.js ships with the main deploy (no Apps Script change).

(Not complete in production until blocking operator actions are done AND
the deploy step is confirmed.)

FOLLOW-ON ITEMS:
- GET /api/tax-deductions (insights.js) still defaults the year to `new Date().getFullYear()` (UTC) and lists the annotation table, not the computed report. It could share getTaxDeductionTransactions.
- The anomaly prompt line prints `r.date` as a JS Date string ("Thu Sep 17 2026 00:00:00 GMT…"), which is noisy prompt text. Format it as YYYY-MM-DD.
- monthAiSpendCents keys on the UTC month (`date_trunc('month', CURRENT_DATE)`), not APP_TIMEZONE. That is pre-existing, now in one place.
- sheets-sync syncTaxDeductions adds a conditional-format rule on every sync (pre-existing pattern across tabs; rules may accumulate).

DOCUMENTATION UPDATES NEEDED:
- CLAUDE.md — AI cost pricing and the cap:
  - ID-keyed MODEL_RATES_BY_ID / modelRates and the corrected Haiku/Opus prices;
  - monthAiSpendCents as the single spend reader;
  - entry_type 'suggest' + 'insight_empty' in the cap list;
  - AI budget suggestions are now capped (INV-14 text).
- CLAUDE.md — AI insight auditing (AIN-1/2/3):
  - nearest-amount attribution, skip windows and total-phrasing for subscriptions;
  - generic-name filter and categories in the known set;
  - complete-month savings-rate/trend baselines.
- CLAUDE.md — AI Insights:
  - partial-month labelling (AIN-4);
  - anomaly baseline excludes the candidate's own row (AIN-5; the current text says "excludes the trailing 7 days so the candidate doesn't inflate its own baseline");
  - unknown-limit utilization (AIN-7);
  - summary_status rules, strict tool, empty-insight handling and rebuild max_tokens 4000 (AIN-8);
  - recurring_transfers toggle (AIN-11);
  - weekly digest empty_summary (AIN-16).
- CLAUDE.md — tax:
  - deductions computed at export time from transactions via financial-queries getTaxDeductionTransactions / TAX_KEYWORD_GROUPS / taxCategoryFor;
  - tax_deductions is the annotation layer, with the prune rule (AIN-12) and split-adjusted amounts;
  - GET /api/export/tax-report row shape;
  - the Sheets "Tax Deductions YYYY" tab (Date column, prior-year refresh through April, pinned keyword mirror).
- CLAUDE.md test counts: 1376 / 54 files (Perfin 878).
- Consider new invariants:
  - "one AI spend reader (monthAiSpendCents)";
  - "the tax report is computed from transactions — the tax_deductions table never supplies amounts".
---END BROAD SCAN IMPLEMENTATION SUMMARY---
