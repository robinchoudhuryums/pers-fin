---BROAD SCAN IMPLEMENTATION SUMMARY---
Findings implemented: None (roadmap work, not scan findings)
New capabilities (G/ST): Roadmap T2.3 C1 — the shared capped AI wrappers for Per-sistant (every later feature moves onto them in C2 / C3)
Files modified:
  apps/per-sistant/ai.js, apps/per-sistant/routes/jobs.js,
  apps/per-sistant/tests/roadmap-t2-3-cap-c1.test.js (new), tests/scan-oct-batch13.test.js
  (KNOWN_GAPS entry removed), CLAUDE.md, apps/per-sistant/CLAUDE.md, README.md,
  .cycle/plan-t2-3-persistent-ai-cap.md, .cycle/STATE.md

CHANGES:
T2.3-C1 | apps/per-sistant/ai.js | checkAiCap(pool) → { ok, spent, budget }, throwing CAP_CHECK_FAILED (logged) when the budget / spend can't be read; cappedAI(pool, { entry_type, model, prompt, system, maxTokens, effort, meta, client }) and cappedCitations(pool, { entry_type, model, system, query, documents, maxTokens, client }) — CAP { spent_cents, budget_cents } at or over the budget before any model call, one recordAiUsage row in a finally whenever tokens came back (a refusal included), a failed charge logged and the answer kept, entry_type required; the cap reads go through module.exports so tests stub them
T2.3-C1 | apps/per-sistant/ai.js | callAIWithUsage takes opts { effort, meta } (meta.stop_reason) and returns stop_reason; answerWithCitations returns usage (all four counters) and attaches it to its REFUSAL error; usageOf helper
T2.3-C1 | apps/per-sistant/ai.js | monthlyAiSpendCents counts from the APP_TIMEZONE month start (aiMonthStart — an invalid zone → UTC; `created_at >= ($1::date::timestamp AT TIME ZONE $2)`) and throws on a read error instead of returning $0
T2.3-C1 | apps/per-sistant/routes/jobs.js | cappedCall is an alias of ai.cappedAI; the fit and legitimacy loops stop on CAP or CAP_CHECK_FAILED
T2.3-C1 | tests/scan-oct-batch13.test.js | the timezone lint's apps/per-sistant/ai.js KNOWN_GAPS entry (the UTC cap month) removed

TEST RESULTS: passed — npm test 2099/2099 (Perfin 1532 + Per-sistant 567; 16 new); contract suite 201/201; the new spend SQL run against real Postgres in Pacific/Kiritimati, Etc/GMT+12 and UTC (a row a minute after the local month start counted, a minute before not). Mutation checks, each turning roadmap-t2-3-cap-c1 red: dropping the CAP check; dropping the finally charge; not charging a refusal's usage in cappedCitations; reverting to date_trunc('month', now()); swallowing a spend read error as ok; `<` → `<=` at the cap. No page or schema change, so no Playwright / migration run was needed.
REGRESSION RISKS:
  - A spend read error now refuses Job Radar's AI passes (CAP_CHECK_FAILED, the pass stops) instead of running them uncapped — intended (decision 3).
  - At a month boundary west / east of UTC the cap now resets at local midnight, not UTC midnight.
  - callAIWithUsage / answerWithCitations gained fields and an optional argument only; existing callers (rag.js, jobs.js) are unaffected.
INVARIANTS AT RISK: None — INV-64 holds (reworded: cappedCall is cappedAI); INV-76 (explicit effort, no forced tool_choice) holds in the new wrappers; INV-121 (timezone lint) shrank by one entry. INV-143 is added in C4.
NET SCORE: 0 production fixes − 0 new failure modes = 0 (one new capability)

OPERATOR ACTIONS / DEPLOY:
- None | BLOCKS DEPLOY: N
Deploy: Platform, Shell & Auth: Render auto-deploys on push to `main` (after the PR merges).

(Not complete in production until blocking operator actions are done AND
the deploy step is confirmed.)

FOLLOW-ON ITEMS:
- getAiBudgetCents still falls back to the env / default budget when its settings read fails (only the spend read fails closed).
- Until C2 / C3, the nine routes/ai.js features and Knowledge's answer / diagram / capture still call the uncapped callAI / answerWithCitations (planned).

DOCUMENTATION UPDATES NEEDED:
- None (folded into this batch)
---END BROAD SCAN IMPLEMENTATION SUMMARY---
