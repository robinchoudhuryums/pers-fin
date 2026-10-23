# Roadmap T2.3 — AI cost cap for every Per-sistant feature (plan, 2026-10-23)

Goal: every Per-sistant model call is checked against the monthly AI budget before it
runs and charged to the `ai_usage` ledger after it, the way Job Radar's two passes
already are (INV-64) and the way every Perfin call is (INV-14). The user sees what was
spent and can set the cap. Roadmap estimate: M, about a week.

## What exists (read for this plan)
- `apps/per-sistant/ai.js` has the cap pieces, built for Job Radar (D1):
  `getAiBudgetCents()` (`user_settings.ai_monthly_budget_cents` → env
  `PERSISTENT_AI_BUDGET_CENTS` → $1.00), `monthlyAiSpendCents()`, `recordAiUsage()`,
  `estimateCostCents()` (5.5 prices incl. cache tokens) and `callAIWithUsage()`
  (returns `{ text, usage }`; a refusal is empty text so the spend is still charged).
- The check-then-charge wrapper is `cappedCall` in `routes/jobs.js` (local to Job Radar).
- **13 uncapped calls** go through `callAI` / `answerWithCitations`:
  - `routes/ai.js` (9): draft-email, task-breakdown, parse-todo, review-summary,
    adjust-tone, daily-briefing, suggest-tags, smart-suggestions, query (Ask).
  - `routes/rag.js` (4): `/query` (`answerWithCitations`, then a `callAI` fallback when
    that throws), `/diagram`, `/capture` (AI structuring; falls back to a raw note).
- Gaps found while reading:
  - `monthlyAiSpendCents` counts from the UTC month start (`date_trunc('month', now())`).
    It's in the timezone lint's KNOWN_GAPS as a follow-on, matching Perfin's F66.
  - It returns 0 on a read error, so a database error fails the cap OPEN. Perfin's
    `monthAiSpendCents` throws instead.
  - `answerWithCitations` returns no usage, so the Knowledge answer can't be charged.
  - There's no Settings control or display for the Per-sistant budget: the column and
    the env var exist, but nothing shows spend or sets the cap.
- The response caches (briefing 10 min, suggestions 5 min, the Knowledge answer cache)
  serve repeats without a model call, so a cache hit stays free and uncapped.

## Decisions (accepted with /broad-implement C1)
1. **One wrapper, in ai.js.** `cappedAI(pool, { entry_type, model, prompt, system,
   maxTokens, effort, meta })` and `cappedCitations(pool, { entry_type, model, … })`
   check the cap, call the model, and charge in a `finally` (once, only when tokens
   came back). Job Radar's `cappedCall` becomes a thin alias, so there's one rule.
   Over the cap, the wrapper throws `{ code: "CAP" }` before any model call.
2. **Each app keeps its own cap.** Perfin and Per-sistant have separate databases,
   ledgers and env vars, and stay that way: no combined budget. The "side by side"
   view is read-only (C4).
3. **The spend read fails closed.** If the ledger can't be read, the call is refused
   (503 "AI spend couldn't be checked"), because spend that can't be checked couldn't
   be charged either. This matches Perfin's throwing reader. Job Radar's passes already
   stop on any thrown error.
4. **The month is the APP_TIMEZONE month** (`todayStr()` month start, like Perfin's
   F66). This removes the KNOWN_GAPS entry.
5. **How an over-cap call answers, per surface:**
   - The seven action routes (draft-email, task-breakdown, parse-todo, review-summary,
     adjust-tone, daily-briefing, suggest-tags) return **429** `{ error: "Monthly AI
     budget reached ($X of $Y) — raise it in Settings → AI.", ai_cap: true }`. The 400s
     and 501 still come first, and the 429 comes before any data query.
   - Ask and Smart Suggestions keep their 200 shapes (`answer:` text / `suggestions:
     null`) and add `ai_cap: true`.
   - Knowledge `/query` degrades to sources-only (INV-29's AI-off path) with a note
     and `ai_cap: true`.
   - `/diagram` returns 429.
   - `/capture` still commits the raw note (its existing no-AI fallback) and says so.
6. **Every model attempt is charged.** For Knowledge `/query`, if `cappedCitations`
   returned usage and then failed to parse, that spend is charged, and the prompt-cite
   fallback is a second capped call charged separately. The check-then-charge race
   between two concurrent calls is accepted, as in Perfin (AI-11).
7. **The entry_type is the feature name** (`email_draft`, `task_breakdown`, `quick_add`,
   `review_summary`, `email_tone`, `daily_briefing`, `note_tagging`,
   `smart_suggestions`, `natural_language_query`, `rag_query`, `rag_diagram`,
   `rag_capture`; Job Radar keeps `job_fit` / `job_legitimacy`), so the breakdown
   groups by the same keys as the model settings.

## Batches (broad-implement sized)
| Batch | Scope | Status |
|---|---|---|
| C1 | **Shared wrapper + ledger correctness.**<br>• `ai.js`:<br>&nbsp;&nbsp;– `callAIWithUsage` gains `effort` and `meta.stop_reason`.<br>&nbsp;&nbsp;– `answerWithCitations` returns `usage` (all four counters).<br>&nbsp;&nbsp;– New `checkAiCap(pool)` → `{ ok, spent, budget }`, which throws on a read error.<br>&nbsp;&nbsp;– New `cappedAI` / `cappedCitations` (decision 1): CAP error with `spent` / `budget`, a charge in `finally`, a charge failure logged and never thrown into the answer.<br>&nbsp;&nbsp;– `monthlyAiSpendCents` counts from the APP_TIMEZONE month start and throws (decisions 3 and 4).<br>• Job Radar's `cappedCall` delegates to `cappedAI` (INV-64 unchanged).<br>• Tests: a fake-client pool (cap reached → no model call; charged once with cache tokens; refusal charged; a thrown create isn't charged; a charge failure doesn't lose the answer; read error → throws); the tz month start under a forced zone; the KNOWN_GAPS entry removed. | DONE (ai.js checkAiCap / cappedAI / cappedCitations; tz month; spend read fails closed; Job Radar on it) |
| C2 | **The nine `routes/ai.js` features on the wrapper.**<br>• Each `callAI` becomes `cappedAI` with its entry_type.<br>• A shared `capResponse(res, err)` maps CAP → 429 / the 200 shapes (decision 5) and a read error → 503.<br>• A source guard: no `routes/*.js` file imports `callAI` or `answerWithCitations` (shrinking KNOWN_GAPS — C2 leaves only rag.js; C3 empties it).<br>• While in the file: Smart Suggestions' day / cache key use `todayStr()` (APP_TIMEZONE) — the `routes/ai.js` timezone-lint KNOWN_GAPS entry — removed.<br>• Tests: each route's 429 order (400 → 501 → 429 → no data query, no model call), a charged row per call with its entry_type, cache hits free, Ask / Suggestions shapes. | DONE (cappedAI per feature; capResponse 429 / 503; Ask / Suggestions 200 + ai_cap; Suggestions in APP_TIMEZONE; the source guard, KNOWN_GAPS rag.js) |
| C3 | **Knowledge on the wrapper.**<br>• `/query`: cappedCitations, and its fallback cappedAI (decision 6); over-cap → sources-only + note (cache lookup first, so a cached answer is still free).<br>• `/diagram` → 429.<br>• `/capture` → raw note + `ai_cap` note.<br>• Tests: each path's charge; the fallback charged as its own row; the over-cap shapes; the guard's KNOWN_GAPS emptied. Contract on real Postgres: charges land in `ai_usage` in the APP_TIMEZONE month, and a pre-set spend at the cap makes `/query` sources-only and `/api/ai/draft-email` 429 with no model call. | DONE (cappedCitations + cappedAI fallback, sources-only / 429 / raw-note over the cap, helpers in ai.js, guard KNOWN_GAPS empty, contract persistent-ai-cap) |
| C4 | **Visibility + UI + docs.**<br>• `GET /api/ai/usage` → `{ month, spent_cents, budget_cents, budget_source (settings / env / default), by_feature: [{ entry_type, calls, cents }] }`.<br>• `PATCH /api/settings` takes `ai_monthly_budget_cents` (integer 1–10000 or null → env; 400 otherwise — INV-59 style).<br>• Settings → AI Models: "This month: $X of $Y", a cap input and Save, and a per-feature breakdown.<br>• AI buttons show the 429's message (withPending callers already toast `d.error` — check each), and the Knowledge page shows the over-cap note.<br>• Side by side (read-only, fail-soft, one line each): Per-sistant Settings shows Perfin's month spend via `perfinPool` (Perfin's `monthAiSpendCents` + `getAiBudgetCents`, required lazily like `getNetWorth`), and Perfin's AI card shows Per-sistant's via `persistentPool` (a SUM over `ai_usage` for the month).<br>• New invariant; both CLAUDE.md files; README; Known Open Issues; Playwright (Settings page). | PLANNED |

Each batch: unit tests, a contract file on real Postgres where routes or SQL change, the
migration test when the schema changes (none planned — the columns exist), Playwright
when a page changes, and mutation checks.

## New invariant (C4)
INV-143 | Every Per-sistant model call goes through ai.js's capped wrappers (cappedAI /
cappedCitations): the monthly `ai_usage` spend (APP_TIMEZONE month; a read error refuses
the call) is checked against `getAiBudgetCents()` before the call, and a usage row is
charged once in a `finally` whenever tokens came back (a refusal included); no
`routes/*.js` file calls `callAI` / `answerWithCitations` directly; cache hits make no
call and cost nothing; over the cap, the action routes 429, Ask / Suggestions keep their
200 shapes with `ai_cap`, Knowledge answers degrade to sources-only and capture falls
back to the raw note | Subsystem: Per-sistant Backend / Knowledge / RAG | Verify: the
C1–C3 test files + the contract file + the source guard. (INV-64 becomes the Job Radar
case of it.)

## Trade-offs to state in the docs
- The default cap is $1.00/month. Daily briefings, suggestions and Knowledge answers on
  Sonnet can reach that, so the UI shows the spend and the cap is easy to raise. The
  default stays: it's a spend guard, and the env var / setting overrides it.
- Two concurrent calls can both pass the check, and the last call of the month can go
  slightly over (same as Perfin, AI-11).
- The two apps' caps are independent; the side-by-side line is informational only.

## Out of scope
- Per-feature budgets.
- A provisional reservation that would close the concurrency gap.
- A combined cross-app cap.
- Charging embeddings (Voyage) against the cap.
- Usage history beyond the current month (the ledger keeps rows; a history view can come later).
