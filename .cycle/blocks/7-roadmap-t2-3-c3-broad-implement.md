---BROAD SCAN IMPLEMENTATION SUMMARY---
Findings implemented: None (roadmap work, not scan findings)
New capabilities (G/ST): Roadmap T2.3 C3 — Knowledge's answer, diagram and capture on the capped wrappers (every Per-sistant model call is now capped)
Files modified:
  apps/per-sistant/routes/rag.js, apps/per-sistant/ai.js (capMessage / capResponse / isCapError),
  apps/per-sistant/routes/ai.js (imports those helpers instead of defining them),
  apps/per-sistant/tests/roadmap-t2-3-cap-c3.test.js (new), apps/per-sistant/tests/roadmap-t2-3-cap-c2.test.js
  (guard KNOWN_GAPS emptied), apps/per-sistant/tests/scan-oct-batch12.test.js + scan-sept-batch11.test.js
  (stubs moved from callAI to the cap layer), tests/contract/persistent-ai-cap.contract.test.js (new),
  CLAUDE.md, apps/per-sistant/CLAUDE.md, README.md, .cycle/plan-t2-3-persistent-ai-cap.md, .cycle/STATE.md

CHANGES:
T2.3-C3 | apps/per-sistant/routes/rag.js | POST /api/rag/query answers through ai.cappedCitations (entry_type rag_query) and its prompt-cite fallback through ai.cappedAI (a second rag_query row — decision 6; a refused Citations call is charged from its error's usage); over the cap or with the spend unreadable it returns the matching sources with ai_cap / ai_cap_check_failed and a note ("Monthly AI budget reached ($X of $Y) — raise it in Settings → AI. Showing matching sources."), without trying the fallback, and nothing is cached; the answer-cache lookup still comes first, so a cached answer is free
T2.3-C3 | apps/per-sistant/routes/rag.js | POST /api/rag/diagram through ai.cappedAI (rag_diagram); over the cap 429 { ai_cap }, an unreadable spend 503 { ai_cap_check_failed } (capResponse), the 400s first
T2.3-C3 | apps/per-sistant/routes/rag.js | POST /api/rag/capture structures through ai.cappedAI (rag_capture); over the cap / unreadable spend the raw note is still committed and the response adds ai_cap (or ai_cap_check_failed) + "… Saved as the raw text, without AI structuring."; a private / secret capture never reads the cap
T2.3-C3 | apps/per-sistant/ai.js + routes/ai.js | capMessage, capResponse and isCapError moved into ai.js (shared by both route files; routes/ai.js behaviour unchanged)
T2.3-C3 | apps/per-sistant/tests/roadmap-t2-3-cap-c2.test.js | the no-direct-callAI / answerWithCitations guard's KNOWN_GAPS is empty — no routes/*.js file calls the model outside the wrappers

TEST RESULTS: passed — npm test 2125/2125 (Perfin 1532 + Per-sistant 593; 12 new); contract suite 203/203 (2 new: charges in ai_usage with their entry_types in the APP_TIMEZONE month — a row from a minute before the zone's month start not counted — and, at the budget, /api/rag/query sources-only + /api/ai/draft-email 429 with no model call or row). Mutation checks, each turning roadmap-t2-3-cap-c3 red: dropping the fallback's cap degrade; dropping the capture's ai_cap flag; a wrong diagram entry_type; the diagram catch not mapping CAP to 429; calling the uncapped answerWithCitations; and dropping the Citations-path cap degrade (it first survived — the fallback re-checked and degraded the same way — and is now pinned by a one-cap-read assertion). No page or schema change, so no Playwright / migration run was needed.
REGRESSION RISKS:
  - Knowledge Q&A now stops at the Per-sistant budget (default $1.00/month; Knowledge answers default to Sonnet) and answers sources-only once it is reached.
  - An unreadable ai_usage ledger now degrades /query to sources-only, /diagram to a 503 and /capture to the raw note (fail closed) where they used to run uncapped.
  - A Citations refusal used to fall back to callAI, which threw on a refusal (500); the fallback is now cappedAI, which returns empty text on a refusal, so the route answers with its existing "The AI returned no answer" note instead.
INVARIANTS AT RISK: None — INV-27 / INV-86 (private / secret never sent to the AI) hold: the capture's sensitivity gate is unchanged and still precedes the cap read; INV-29 (degrade paths) extended with the over-cap sources-only path; INV-32 (only complete answers cached) holds — an over-cap response is never cached; INV-76 holds through the wrappers. INV-143 is added in C4.
NET SCORE: 0 production fixes − 0 new failure modes = 0 (one new capability)

OPERATOR ACTIONS / DEPLOY:
- None (no schema change; raise PERSISTENT_AI_BUDGET_CENTS on Render if Knowledge + the assistant features need more than $1.00/month before C4's Settings control) | BLOCKS DEPLOY: N
Deploy: Platform, Shell & Auth: Render auto-deploys on push to `main` (after the PR merges).

(Not complete in production until blocking operator actions are done AND
the deploy step is confirmed.)

FOLLOW-ON ITEMS:
- /query and /diagram still run retrieval (and a Voyage query embedding, which the cap doesn't count) before the cap refuses the model call.
- The Knowledge page's capture box doesn't show the response's over-cap note yet (planned for C4 with the other pages' 429 / 503 text); the query note and the diagram's 429 error already show.
- The 429 / note text points at a Settings control C4 adds (planned).

DOCUMENTATION UPDATES NEEDED:
- None (folded into this batch)
---END BROAD SCAN IMPLEMENTATION SUMMARY---
