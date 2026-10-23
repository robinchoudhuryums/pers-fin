---BROAD SCAN IMPLEMENTATION SUMMARY---
Findings implemented: None (roadmap work, not scan findings)
New capabilities (G/ST): Roadmap T2.3 C4 — the Per-sistant AI budget made visible and settable (usage endpoint, budget setting, Settings card, each app showing the other's spend), the pages showing the over-cap message, INV-143 (T2.3 complete)
Files modified:
  apps/per-sistant/ai.js (getAiBudgetInfo; getAiBudgetCents / checkAiCap read the given pool),
  apps/per-sistant/routes/ai.js (GET /api/ai/usage, aiUsageSummary, perfinAiSpend),
  apps/per-sistant/routes/settings.js (PATCH ai_monthly_budget_cents), apps/per-sistant/middleware.js
  (AI limiter skips the two read-only GETs), apps/per-sistant/pages/settings.js + settings-script.js
  (Monthly AI budget card), apps/per-sistant/pages/dashboard-script.js, today.js, review.js, knowledge.js
  (over-cap text shown), teller/routes/insights.js (persistentAiSpend; /api/insights/status persistent_ai),
  teller/views/settings.ejs (the Per-sistant line), apps/per-sistant/tests/roadmap-t2-3-cap-c4.test.js (new),
  tests/roadmap-t2-3-cap-c4.test.js (new), tests/contract/ai-usage-c4.contract.test.js (new),
  CLAUDE.md, apps/per-sistant/CLAUDE.md, README.md, .cycle/plan-t2-3-persistent-ai-cap.md, .cycle/STATE.md

CHANGES:
T2.3-C4 | apps/per-sistant/ai.js | getAiBudgetInfo(pool) → { cents, source: settings | env | default } (user_settings.ai_monthly_budget_cents → PERSISTENT_AI_BUDGET_CENTS → $1.00); an unreadable setting is now logged (was a silent catch) and still falls back; getAiBudgetCents(pool) and checkAiCap read the budget from the pool the wrapper was given (it used the module pool)
T2.3-C4 | apps/per-sistant/routes/ai.js | GET /api/ai/usage → { month, spent_cents, budget_cents, budget_source, by_feature: [{ entry_type, calls, cents }], available, perfin } — the same ai_usage rows and APP_TIMEZONE month start the cap reads; a ledger error is a 500; perfin = Perfin's monthAiSpendCents(perfinPool) + getAiBudgetCents() (required lazily, only when perfinPool is wired), null standalone or on a failure
T2.3-C4 | apps/per-sistant/routes/settings.js | PATCH /api/settings ai_monthly_budget_cents: an integer 1–10000 (a number or digit string) or null (→ env / default); anything else (0, 1.5, "6abc", "", true, an array) is a 400 that writes nothing
T2.3-C4 | apps/per-sistant/middleware.js | the AI limiter (20/min) skips GET /api/ai/usage and /api/ai/models (no model call; the Settings page loads both); every other /api/ai/ request — incl. the model-calling GETs — stays limited
T2.3-C4 | apps/per-sistant/pages/settings.js + settings-script.js | Settings → AI Features → Monthly AI budget (outside the models section, so shown without a key): "This month: $X of $Y" ("budget reached" at the cap), the cap's source, a per-feature breakdown, Perfin's line, a labelled cap input with Save (whole cents, out-of-range refused locally) and Use default (null) through withPending + writeOk
T2.3-C4 | apps/per-sistant/pages/dashboard-script.js, today.js, review.js, knowledge.js | over the cap the dashboard briefing + suggestions, Today's briefing and the Review summary show the response's budget message instead of hiding; the Review's weekly theme ignores an ai_cap answer (Ask's 200 budget text used to become the "theme"); the Knowledge capture status shows the response's note (raw text saved). Email draft / tone, task breakdown, note tags, Ask, Knowledge Q&A and diagram already showed it; Quick Add's AI path falls back to the local parser
T2.3-C4 | teller/routes/insights.js + teller/views/settings.ejs | GET /api/insights/status adds persistent_ai { spent_cents, budget_cents } — Per-sistant's own monthlyAiSpendCents / getAiBudgetCents over the wired persistentPool (lazy require, only when wired), null standalone or on a failure; Settings → AI Insights → Monthly Budget Cap shows it as one read-only line
T2.3-C4 | CLAUDE.md | INV-143 added (every Per-sistant model call capped and charged through the wrappers, the over-cap shapes, the usage view reading the same spend, separate caps); INV-64 now names itself the Job Radar case of it; Known Open Issues: T2.3 DONE with its follow-ons

TEST RESULTS: passed — npm test 2147/2147 (Perfin 1537 + Per-sistant 610; 22 new); contract suite 206/206 (3 new: GET /api/ai/usage's per-feature rows and spent_cents equal to monthlyAiSpendCents in the Pacific/Kiritimati month with last month's row left out; PATCH setting the cap the wrappers then enforce — a 1.5 a 400 that changes nothing, null back to the default; Perfin's spend in Per-sistant's usage and Per-sistant's in Perfin's /api/insights/status, with both real databases wired as the shell wires them); Playwright 57/57 (Settings pages loaded and click-swept in a real browser). Mutation checks, each turning a C4 test red: the usage query on the UTC month (first survived — the unit test ran under UTC — now pinned with a forced zone), the budget read ignoring its pool, PATCH accepting any type, the limiter skip removed, the limiter skipping every GET, the Review theme showing the cap text, perfinAiSpend throwing instead of null, persistentAiSpend reading Perfin's budget, /api/insights/status dropping persistent_ai, the card ignoring the env source.
REGRESSION RISKS:
  - The settings PATCH and the Settings "Use default" button now write ai_monthly_budget_cents; Job Radar and every feature read it at once (that's the point).
  - The budget is now read from the pool the wrapper was given rather than Per-sistant's module pool — identical in production (one pool), different only in tests.
  - The AI limiter no longer counts GET /api/ai/models; a standalone deployment's general limiter still applies to it.
  - The dashboard / Today / Review cards now appear (with the budget message) over the cap where they used to stay hidden.
INVARIANTS AT RISK: None — INV-143 added and pinned; INV-64 unchanged (the Job Radar case); INV-59 extended (Per-sistant's budget setting 400s); INV-25 / INV-35 (cross-app reads through the wired pools, read-only, never an HTTP self-fetch) hold in both directions; INV-129 (withPending for busy buttons) holds for the new Save / Use default; INV-97 (no single-escaped regex in client template literals) — the new client code has no regex.
NET SCORE: 0 production fixes − 0 new failure modes = 0 (one new capability; T2.3 complete)

OPERATOR ACTIONS / DEPLOY:
- None (no schema change — the ai_monthly_budget_cents column exists; set the Per-sistant cap in Settings → AI Features → Monthly AI budget, or keep PERSISTENT_AI_BUDGET_CENTS) | BLOCKS DEPLOY: N
Deploy: Platform, Shell & Auth: Render auto-deploys on push to `main` (after the PR merges).

(Not complete in production until blocking operator actions are done AND
the deploy step is confirmed.)

FOLLOW-ON ITEMS:
- getAiBudgetInfo falls back to the env / default budget when its settings read fails (only the spend read fails closed) — now logged.
- Quick Add's AI path falls back to the local parser over the cap without saying why.
- The usage view covers the current month only (the ledger keeps every row).
- Knowledge's /query and /diagram run retrieval (and an uncounted Voyage query embedding) before the cap refuses the model call; the briefing and Smart Suggestions read the spend twice.

DOCUMENTATION UPDATES NEEDED:
- None (folded into this batch)
---END BROAD SCAN IMPLEMENTATION SUMMARY---
