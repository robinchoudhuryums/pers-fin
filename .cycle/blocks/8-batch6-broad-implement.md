---BROAD SCAN IMPLEMENTATION SUMMARY---
Findings implemented:
- F42 · Medium — the AI audit compared "last year" / "last week" / "last quarter" and prior-year same-month claims ("Last November Shopping hit $800") with this month's actuals → false CRITICALs
- F49 · Low (security) — a quoted frontmatter key (`"sensitivity": secret`) was ignored, so the file was embedded and sent to Voyage / Claude
- F44 · Low — /api/ask answered 500 when the success-path usage charge failed, though the answer existed
- F24 · Low — a model refusal on a capped Per-sistant route returned an empty 200 (adjust-tone's empty body overwrote the draft)
- F50 · Low — the insights prompt diffed credit scores across score types (FICO vs VantageScore)
- F53 · Low — the weekly digest sent at about 00:00–01:00 local (no hour gate)
New capabilities (G/ST): None
Files modified:
- teller/services/ai-audit.js
- apps/per-sistant/services/vault-sync.js
- teller/routes/ask.js
- apps/per-sistant/routes/ai.js
- teller/routes/insights.js
- teller/startup.js
- tests/broad-scan-c8-batch6.test.js (new, 8)
- apps/per-sistant/tests/broad-scan-c8-batch6.test.js (new, 7)
- tests/contract/c8-batch6.contract.test.js (new, 1)
- tests/ai-cap-charge.test.js (+1, F44)
- tests/scan-oct-batch8.test.js (F64 test: 500 → 200 + answer)
- tests/scan-sept-batch8.test.js (weekly-digest tick tests set DAILY_DIGEST_HOUR = 0)

CHANGES:
F42 | teller/services/ai-audit.js | CROSS_PERIOD_RE adds last/previous/prior year, years ago, same month/time/period last year, last <season>, last/past/previous/prior/this week, per week, /wk, /week, weekly, a week, last/previous/prior/this quarter, per quarter, quarterly ("a quarter" deliberately left out — "a quarter of your spending"). namesOtherMonth: this month's name preceded by last/previous/prior, or followed by a year that isn't this one, is another month; a bare 19xx/20xx year that isn't this one (not after "$", digits, "." "," or "-", not a YYYY-MM) is too. claimNamesOtherMonth's attached-trail match also reads "in November 2025", "in 2025" and "last November" after the figure.
F49 | apps/per-sistant/services/vault-sync.js | The key regex accepts a quoted key ('…' / "…"). A frontmatter line the parser can't read that STARTS with a privacy key (after indentation, a list dash or a quote — PRIVACY_MENTION_RE) records an unrecognized sensitivity, which resolves to private (fail closed). VAULT_PARSE_VERSION 2 → 3, so Operator Checks asks for one full reindex.
F44 | teller/routes/ask.js | The success-path chargeAsk is wrapped in try/catch (logged); the answer is returned and `charged` stays false, so the finally retries the charge once.
F24 | apps/per-sistant/routes/ai.js | capped() throws a REFUSAL error when stop_reason is "refusal" (cappedAI's finally has already charged it); the seven action routes answer 422 { error, ai_refusal: true } through refusalResponse; Ask's catch answers "Sorry, I couldn't process that query."; Smart Suggestions its "AI request failed."; a refused briefing isn't cached.
F50 | teller/routes/insights.js | New exported creditScoreSummary(rows): the delta and N-entry range use entries of the latest entry's score type; each other type is listed with its latest score. generateInsights' CREDIT SCORE section uses it.
F53 | teller/startup.js | runWeeklyDigestTick returns before any DB read while localHourNow() < DAILY_DIGEST_HOUR (07:00 APP_TIMEZONE), without settling the day.

TEST RESULTS: npm test 2666/2666 (16 new incl. ai-cap-charge's F44 case; the cycle-7 F64 test now expects 200 + the answer instead of 500 — the behaviour F44 changes). Contract 270/270 (1 new). Mutation checks 7/7 red (each fix reverted → its test fails; the F42 contract test too). Playwright not re-run (no page or route-mount change; the pages already show `error` on adjust-tone / review-summary).
REGRESSION RISKS:
- F42 widens what the audit skips: a genuine this-month hallucination in a sentence that also says "weekly", "a week", "this quarter" or names another year is no longer checked (THIS_MONTH_RE still overrides — "this month" keeps it checked). The audit accuracy % rises slightly by construction.
- F49: a frontmatter block-scalar / continuation line that STARTS with "private …", "embed: …" or "sensitivity …" now makes the file private (fail closed — over-restriction, never exposure). The parse-version bump makes Operator Checks warn until one full reindex runs.
- F24: clients get a 422 where they used to get 200 + empty text; both Per-sistant pages already surface `error`. A caller treating any non-200 as "AI unavailable" sees a refusal the same way.
- F44: a failed charge now leaves the answer returned; if the finally's retry also fails, that call's spend escapes the cap (logged twice) — the same as before for the finally path.
- F53: on a host that is only awake before 07:00 local on the digest day, the weekly digest waits for the next configured day (the daily digest already behaves this way).
INVARIANTS AT RISK:
- INV-113 (audit judges a claim by its own sentence / month) — extended, not weakened; pinned by the new unit + contract tests.
- INV-27 (privacy fails closed) — strengthened; quoted keys and unreadable privacy lines now resolve restrictively.
- INV-55 (Ask charges in a finally, `charged` set only after the write) — preserved; the success-path failure now also falls through to the finally retry.
- INV-143 (Per-sistant capped wrappers; a refusal is charged) — preserved: the charge happens in cappedAI's finally before capped() throws.
- INV-77 (away channels never activity-gated, watermark + per-day memo) — preserved; the weekly digest gains an hour gate that reads no DB and doesn't settle the day.
- INV-14 / INV-15 — unaffected.
NET SCORE: [1 production fix] − [0 new failure modes] = +1
- F42 (a) YES — seasonal / year-over-year phrasing is common in the insights; each one is a false CRITICAL, an alert and a lower accuracy %. (b) NO.
- F49 (a) NO — latent; no quoted keys in the vault today. (b) NO.
- F44 (a) NO — needs a DB write failure right after a model call. (b) NO.
- F24 (a) NO — refusals are rare on these prompts. (b) NO.
- F50 (a) NO — only one score type is logged today. (b) NO.
- F53 (a) NO — the weekly digest is opt-in and off. (b) NO.
(The F42 skip widening and the F49 over-restriction are documented trade-offs, not new failure modes.)

OPERATOR ACTIONS / DEPLOY:
- Run ONE full Knowledge reindex after this deploy (POST /per-sistant/api/rag/reindex, or let knowledge-reindex.yml fire) — VAULT_PARSE_VERSION moved to 3 and Operator Checks will warn until a full sync stamps it | BLOCKS DEPLOY: N
Deploy: Render auto-deploys on push to `main` (Platform, Shell & Auth); no Apps Script change.

(Not complete in production until blocking operator actions are done AND the deploy step is confirmed.)

FOLLOW-ON ITEMS:
- The audit's period words are still English-phrase lists; a claim like "Shopping hit $800 back in the fall" or "over the holidays" isn't recognised as cross-period.
- A bare other year anywhere in a claim's sentence before it skips the claim ("since 2024 you've cut dining to $450 this month" stays checked only because of "this month").
- F49's mention rule can't tell a prose continuation line starting with "private" from a key; it errs restrictive.
- Per-sistant's Knowledge /diagram still returns an empty Mermaid result on a refusal (cappedAI there returns "" — rag.js wasn't in F24's scope; the scan named routes/ai.js only).
- The credit-score summary still lists at most 6 entries total across types, so a rarely-logged type may have no "prior" in range.
DOCUMENTATION UPDATES NEEDED:
- CLAUDE.md: AI insight auditing (CROSS_PERIOD_RE year / week / quarter, prior-year month), Weekly digest (07:00 gate), Ask entry (F44), Credit score tracking (same-type delta in the prompt), INV-113 wording, test counts (2666 / 141 files, contract 270), Known Open Issues (cycle-8 Batch 6 done + follow-ons), operator reindex note (VAULT_PARSE_VERSION 3).
- apps/per-sistant/CLAUDE.md: frontmatter parsing (quoted keys, unreadable privacy line → private, parse version 3), AI features (a refusal → 422 ai_refusal), test count + new test file.
- README: test counts.
---END BROAD SCAN IMPLEMENTATION SUMMARY---
