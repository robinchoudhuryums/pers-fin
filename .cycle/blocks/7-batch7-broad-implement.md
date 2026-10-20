---BROAD SCAN IMPLEMENTATION SUMMARY---
Findings implemented:
- F46 — categorization rules apply most-specific first (exact → starts_with → contains, longer pattern, newer rule) instead of by times_applied; saving a merchant→category rule deactivates that merchant's active rules for other categories; times_applied no longer bumps updated_at
- F47 — the AI write only fills a row whose user_category is still NULL, so a category the user sets while a batch is with the model wins; categorized_by_ai counts only real writes
- F48 — minimum rule-pattern length: a blank pattern, or a contains / starts_with pattern under 3 characters, is refused (400 on POST /api/categorization-rules and from-transaction; the Review "Remember" path applies the category but returns rule_error instead of creating the rule); a stored short rule is skipped (logged) by runCategorize and /apply
- F52 — semimonthly income whose "1st" posts on the 29th–31st (weekend/holiday) is classified on a circular day-of-month (days ≥ 22 wrap to d−31 when the linear two-cluster test fails), so it stays semimonthly [1, 15] instead of falling through
- F54 — rows the model saw but left unanswered are stamped transactions.ai_skipped_at and not re-sent to the AI for 30 days (AI_SKIP_RETRY_DAYS); rules, the free maps and the Review widget still reach them
New capabilities (G/ST): None
Files modified:
- teller/routes/categorize-helpers.js
- teller/routes/categorize.js
- teller/services/cadence.js
- teller/services/database.js
- tests/scan-oct-batch7.test.js (new)
- tests/contract/categorize-rules.contract.test.js (new)

CHANGES:
F46 | categorize-helpers.js, categorize.js | RULE_ORDER_SQL (CASE match_type exact/starts_with/contains, LENGTH(merchant_pattern) DESC, updated_at DESC, id DESC) used by runCategorize and POST /api/categorization-rules/apply; deactivateSupersededRules(db, pattern, category) (case-insensitive same pattern, other category, active → inactive) called after POST rules, from-transaction, the Review "Remember" and the accuracy-review rule; the times_applied UPDATEs no longer set updated_at
F47 | categorize.js | AI UPDATE adds `AND user_category IS NULL`; aiUpdated increments only on rowCount
F48 | categorize-helpers.js, categorize.js | MIN_PATTERN_LENGTH = 3 + rulePatternError(pattern, type); 400 on POST rules / from-transaction; Review returns rule_error and skips the rule; accuracy-review requires a non-blank merchant; rule loops skip invalid stored rules (logged)
F52 | cadence.js | twoDayClusters tries the linear clustering, then a wrapped one (d ≥ 22 → d − 31), mapping back to 1–31
F54 | database.js, categorize.js | ALTER TABLE transactions ADD COLUMN IF NOT EXISTS ai_skipped_at TIMESTAMPTZ; the AI batch select excludes rows stamped within AI_SKIP_RETRY_DAYS (30); unanswered rows of each batch are stamped (failure logged — it only costs a re-send)

TEST RESULTS: npm test 1591/1591 (+8 scan-oct-batch7); contract 78/78 (+3 categorize-rules); migrations run twice OK. Every new test fails against the pre-fix code (unit 7/8 fail pre-fix — the remaining one pins the unchanged plain semimonthly/biweekly cases; contract 3/3 fail). Playwright not re-run (no page, view or client-script change).
REGRESSION RISKS:
- deactivateSupersededRules matches on the pattern regardless of match_type, so an exact "Amazon"→Groceries rule is turned off when a contains "Amazon"→Shopping rule is saved (intended: one merchant, one category).
- A row the model skipped stays uncategorized for up to 30 days unless a rule, the free maps or the Review widget reach it (deliberate back-off).
- A stored contains/starts_with rule under 3 characters stops applying (logged at each run); it still shows in the rules list.
- Rule ordering changes which rule wins when two overlap; the more specific one now wins regardless of use count.
INVARIANTS AT RISK: None — INV-12 (writes stay in user_category), INV-13 (rules before AI), INV-14 (cap checks unchanged), INV-106 (the new .catch logs), INV-110 (biweekly / plain semimonthly classification unchanged, pinned).
NET SCORE: 3 − 0 = 3 (F46, F52, F54 would have fired in production this month; F47 needs an edit inside the seconds a batch is with the model; F48 needs a short rule to exist)

OPERATOR ACTIONS / DEPLOY:
- None (ai_skipped_at is an idempotent ADD COLUMN run by the boot migrations) | BLOCKS DEPLOY: N
Deploy: Platform, Shell & Auth: Render auto-deploys on push to `main` (configured in the Render dashboard, not via CLI). Alt: `fly deploy` (Dockerfile-based).

(Not complete in production until blocking operator actions are done AND
the deploy step is confirmed.)

FOLLOW-ON ITEMS:
- The dashboard Review widget doesn't display rule_error yet (the category is applied; the "Remember" rule silently isn't created for a too-short merchant).
- The rules list doesn't mark a stored rule that is skipped for being too short, or one deactivated as superseded, beyond is_active.
- GET /api/categorize/review-queue still lists AI-skipped rows (useful — the user can categorize them by hand), but nothing labels them "the AI couldn't place this".
- No way to clear ai_skipped_at early (e.g. after switching the AI model) other than waiting 30 days.
(or "None")

DOCUMENTATION UPDATES NEEDED:
- CLAUDE.md: categorization rules (order, minimum length, superseded deactivation, rule_error), the AI back-off (ai_skipped_at, 30 days) + F47 in the categorization Key Design Decision, transactions.ai_skipped_at in Database, semimonthly wrap in the bill-calendar income bullet / cadence.js entry, POST /api/categorization-rules + /api/categorize/review endpoint notes, test counts (1591 across 74 files, Perfin 1135; contract 78), Known Issues (Batch 7 follow-ons).
- README: counts + Batch 7 summary.
---END BROAD SCAN IMPLEMENTATION SUMMARY---
