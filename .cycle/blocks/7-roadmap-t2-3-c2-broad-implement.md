---BROAD SCAN IMPLEMENTATION SUMMARY---
Findings implemented: None (roadmap work, not scan findings)
New capabilities (G/ST): Roadmap T2.3 C2 — the nine Per-sistant assistant AI features (routes/ai.js) on the capped wrapper
Files modified:
  apps/per-sistant/routes/ai.js, apps/per-sistant/ai.js (exports capError),
  apps/per-sistant/tests/roadmap-t2-3-cap-c2.test.js (new), apps/per-sistant/tests/scan-oct-batch11.test.js
  (F124 pin follows the capped call), apps/per-sistant/tests/scan-oct-batch16.test.js (stub cappedAI, not
  callAI), tests/scan-oct-batch13.test.js (KNOWN_GAPS entry removed), CLAUDE.md, apps/per-sistant/CLAUDE.md,
  README.md, .cycle/plan-t2-3-persistent-ai-cap.md, .cycle/STATE.md

CHANGES:
T2.3-C2 | apps/per-sistant/routes/ai.js | every model call is ai.cappedAI (read off the module object) with its feature name as the entry_type — email_draft, task_breakdown, quick_add, review_summary, email_tone, daily_briefing, note_tagging, smart_suggestions, natural_language_query; the file no longer imports callAI
T2.3-C2 | apps/per-sistant/routes/ai.js | capResponse(res, err): CAP → 429 { error: "Monthly AI budget reached ($X of $Y) — raise it in Settings → AI.", ai_cap: true }, CAP_CHECK_FAILED → 503 { error, ai_cap_check_failed: true }; used in the seven action routes' catch (after their 400s and the 501), so a cap reached by a concurrent call is a 429, not a 500
T2.3-C2 | apps/per-sistant/routes/ai.js | capBlock(pool) gates before the data queries: the daily briefing checks its 10-minute cache FIRST (a hit is free — no cap read, no query, no call), then the cap, then its queries; Ask answers 200 { answer: <budget message>, data: null, ai_cap: true } and Smart Suggestions 200 { suggestions: null, ai_cap: true } (ai_cap_check_failed on an unreadable spend) before any query
T2.3-C2 | apps/per-sistant/routes/ai.js | Smart Suggestions' date, weekday and cache key use todayStr() (APP_TIMEZONE) — they were the UTC date and the server's weekday; Ask's redundant local todayStr shadow removed
T2.3-C2 | tests/scan-oct-batch13.test.js | the timezone lint's apps/per-sistant/routes/ai.js KNOWN_GAPS entry (mislabelled as Ask's "Today:" line — it was Smart Suggestions) removed
T2.3-C2 | apps/per-sistant/tests/roadmap-t2-3-cap-c2.test.js | source guard: no routes/*.js file names callAI / answerWithCitations in code (KNOWN_GAPS { "rag.js": 6 }, exact — C3 empties it)

TEST RESULTS: passed — npm test 2113/2113 (Perfin 1532 + Per-sistant 581; 14 new); contract suite 201/201. Mutation checks, each turning roadmap-t2-3-cap-c2 red: Smart Suggestions back on the UTC date; dropping the briefing's gate; dropping Ask's gate; a wrong entry_type; capResponse not mapping CAP; not mapping CAP_CHECK_FAILED; a direct ai.callAI in one route; the briefing cache checked after the cap gate. No page or schema change, so no Playwright / migration run was needed (the e2e run has no ANTHROPIC_API_KEY, so its AI routes stop at the unchanged 501 / "not configured" paths).
REGRESSION RISKS:
  - Every assistant AI feature now stops at the Per-sistant budget (default $1.00/month); a user with real usage can hit it — the 429 text names the budget, but its Settings control arrives in C4.
  - An unreadable ai_usage ledger now refuses the seven action routes with a 503 (fail closed, decision 3) where they used to run uncapped.
  - The daily briefing now serves its cache before running the data queries (it used to run them and then discard them on a hit) — same answer, fewer queries.
  - Smart Suggestions' cache key moved from the UTC date to the APP_TIMEZONE date (one extra miss at deploy).
INVARIANTS AT RISK: None — INV-76 (no forced tool_choice, explicit effort) holds through cappedAI; INV-52 / INV-66 (fail-soft health / Job Radar lines in the briefing) unchanged; INV-121 (timezone lint) shrank by one entry; INV-27 (private / secret notes never sent) — suggest-tags' 400 still precedes the cap read. INV-143 is added in C4.
NET SCORE: 0 production fixes − 0 new failure modes = 0 (one new capability)

OPERATOR ACTIONS / DEPLOY:
- None (no schema change; the budget is the existing PERSISTENT_AI_BUDGET_CENTS / ai_monthly_budget_cents, default $1.00 — raise the env var on Render if the assistant features need more before C4's Settings control) | BLOCKS DEPLOY: N
Deploy: Platform, Shell & Auth: Render auto-deploys on push to `main` (after the PR merges).

(Not complete in production until blocking operator actions are done AND
the deploy step is confirmed.)

FOLLOW-ON ITEMS:
- The 429's "raise it in Settings → AI" names a control that C4 adds (planned).
- Whether each page shows the 429 / 503 error text (the AI buttons' handlers) is checked in C4 (planned).
- The daily briefing, Ask and Smart Suggestions read the spend twice per call (their gate before the data queries, then the wrapper's own check) — two cheap SUMs, accepted.
- Knowledge's /query, /diagram and /capture still call the model uncapped until C3 (planned; rag.js is the guard's KNOWN_GAPS).

DOCUMENTATION UPDATES NEEDED:
- None (folded into this batch)
---END BROAD SCAN IMPLEMENTATION SUMMARY---
