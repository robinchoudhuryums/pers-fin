---BROAD SCAN IMPLEMENTATION SUMMARY---
Findings implemented:
- KR-3 — vault documents + facts are ingested without Voyage/pgvector (keyword retrieval + facts work); embedding is an extra step with a backfill pass
- KR-4 — retrieval ranking: function-word stopwords dropped from both keyword legs; vector leg over-fetched and ranked per source; keyword-only hits send the passage around the match
- KR-7 — Voyage retry/backoff (429/5xx/network, Retry-After honored); per-file try/catch in the vault loop and per-note in syncNotes; removals run first; sha held when any file failed
- KR-8 — the vault-sync lock is claimed before the first await (syncVault + syncNotes)
- KR-9 — the Perfin finance snapshot uses Perfin's own getNetWorth (no $0 Plaid phantom, investments listed, debts signed "owed") and Perfin's monthly-equivalent subscription rule
- KR-10 — capture: model-supplied reserved keys dropped; sensitivity choice (normal/private/secret) on the form; private/secret captures never sent to the AI
- KR-11 — vault_last_synced_at = last SUCCESS only; new vault_last_attempt_at (db/023); reindex outcome (ok) in status; the GitHub Action polls and fails on a failed reindex; vault_sync_error notification
- KR-12 — the inline-citation fallback parses [n] markers, so fallback answers are no longer always "ungrounded"
- KR-13 — rag_answer_cache pruned on each write (stale version or past TTL)
- KR-14 — upcomingFacts matches whole attribute segments (INV-10); vault_repo rejects "../.." and other non-repo names; rag.js / vault-sync.js headers updated
Files modified:
- apps/per-sistant/services/vault-sync.js
- apps/per-sistant/services/embeddings.js
- apps/per-sistant/routes/rag.js
- apps/per-sistant/routes/notifications.js
- apps/per-sistant/routes/settings.js
- apps/per-sistant/pages/knowledge.js
- apps/per-sistant/pages/dashboard-script.js
- apps/per-sistant/db/023_vault_sync_attempt.sql (new)
- .github/workflows/knowledge-reindex.yml
- apps/per-sistant/tests/scan-sept-batch11.test.js (new, 32 tests)
- apps/per-sistant/tests/knowledge-vault.test.js (old "vector_unavailable" pin flipped — KR-3 reverses it)
- apps/per-sistant/tests/knowledge-crossapp.test.js (fixture moved to Perfin's sign convention; asserts "owed" + net worth)

CHANGES:
KR-8 | vault-sync.js | syncVault sets _syncing synchronously after the busy check and delegates to runVaultSync inside try/finally (so not_configured also releases it); syncNotes claims the lock before its readiness check.
KR-3 | vault-sync.js | No more embeddings_not_configured / vector_unavailable bail-out. canEmbed = Voyage key AND chunks table. Without it, documents/facts are upserted; a normal document whose stored embedding was made from different text gets its chunks/embed_state dropped (forgetEmbedding — chunks only when the table exists), an embedding of the same text is kept (embeddingIsCurrent), so a temporarily missing key doesn't wipe the index. backfillEmbeddings embeds up to 200 normal vault documents with no embed_state row, on every run with canEmbed (also when the vault is up to date). Result carries embeddings: true|false.
KR-7 | embeddings.js, vault-sync.js | embedBatch retries 429/5xx/network: 3 retries for documents, 1 for queries; waits Retry-After (capped 20s) else 1s/2s/4s; 4xx other than 429 not retried; injectable sleep. Vault loop: removals first, each removal and each changed file in its own try/catch (ingestFile helper), backfill failures collected; any failure → vault_last_error "N file(s) failed…; first: path: error", sha and vault_last_synced_at NOT advanced, result { ok:false, partial:true, failed, failures[≤20] }. syncNotes: per-note try/catch, { ok:false, partial:true, failed } when any failed.
KR-11 | vault-sync.js, db/023, rag.js, notifications.js, dashboard-script.js, knowledge.js, knowledge-reindex.yml | vault_last_attempt_at stamped each run (best-effort pre-migration); vault_last_synced_at only on success (the catch path no longer stamps it). /api/rag/status returns vault.last_attempt_at and reindex.ok (reindexOutcome: vault ok or not_configured AND notes ok or not_ready). Action: 409 → green; 202 → poll /api/rag/status every 15s up to 20 min, fail on ok:false or timeout. Notification check adds vault_sync_error (title with last good sync date + error) when vault_enabled and vault_last_error; dashboard treats it as important and links to /knowledge. Knowledge page shows last attempt and a failed reindex.
KR-4 | rag.js | STOPWORDS (function words only — "will", "may", "list" etc. deliberately kept) via searchTerms(), used by buildRetrievalQuery AND buildFactsQuery; all-stopword queries fall back to the phrase. fuseRetrieval ranks each leg per distinct source (first row only). VECTOR_SQL fetched at limit×4 and collapsed with bestChunkPerSource. Keyword rows' content replaced by matchingWindow(content, terms) (passage around the first term, whitespace-snapped, 1500 chars).
KR-9 | rag.js | perfinFinanceSnapshot lazily requires teller/services/financial-queries getNetWorth (null → no finance source); lines: "Net worth: $X (assets, debts)", Accounts from breakdown (credit/loan "-$X owed", credit limit from a small query), Investments from breakdown, subscriptions monthly = Σ amount × 30 / cadence_days (Perfin's rule).
KR-10 | vault-sync.js, rag.js, knowledge.js | buildCaptureMarkdown drops RESERVED_FACT_KEYS from fields and writes `sensitivity:` for private/secret. POST /api/rag/capture validates sensitivity (400 otherwise), skips callAI unless normal, returns sensitivity. Capture form has a Sensitivity select.
KR-12 | rag.js | parseInlineCitations(text, count) used in the Citations-failure fallback.
KR-13 | rag.js | pruneAnswerCache(pool, ver) runs at the start of cacheSet: DELETE … WHERE corpus_version <> $1 OR created_at < now() − 24h.
KR-14 | rag.js, settings.js, vault-sync.js | attribute ~* '(^|[^a-z0-9])(renew[a-z]*|expir[a-z]*|due|deadline|valid[^a-z0-9]?until|ends?)([^a-z0-9]|$)'; vault_repo must match ^[A-Za-z0-9][A-Za-z0-9-]*/[\w.-]+$ and the name can't be "." or ".."; headers describe the current hybrid/Citations/ingest behaviour.

TEST RESULTS: passed. npm test 1551/1551 (Perfin 974 + Per-sistant 577; 62 files). New apps/per-sistant/tests/scan-sept-batch11.test.js (32 tests; 31 fail on the pre-fix code — the one exception is a guard test). Real Postgres (no pgvector — the KR-3 case): both apps' migrations ×2 (023 applied); full vault sync with a fake GitHub ingested 3 documents + 5 facts with no embeddings and advanced the sha; a run with one failing file applied the deletion, held the sha, kept last_synced_at and recorded the error; the next clean run advanced and cleared it; upcomingFacts returned renewal_date + trial_ends but not friends/residue; /api/rag/search returned the matching passage of a long document and no secret content; the cache prune left only the current row; the finance snapshot over a real Perfin schema (Plaid brokerage phantom, loan, card, annual subscription) printed net worth $26,700 = getNetWorth, no $0 brokerage, "-$15,000.00 owed", ~$113.63/mo. Rendered Knowledge + dashboard pages: all inline scripts parse. Playwright e2e 8/8.
REGRESSION RISKS:
- syncVault no longer returns reason embeddings_not_configured / vector_unavailable; it ingests instead. No caller branches on those reasons (cron ignores the result; reindex reports it).
- A partial failure now returns ok:false and holds vault_last_sha. A file that ALWAYS fails makes every sync re-process the same range (cheap — unchanged rows/embeddings are skipped) and keeps the alert up until fixed; that is the intended visible state.
- The Knowledge reindex Action can now go red; if the vault sync was silently failing, the first post-deploy run will show it.
- Per-sistant's finance grounding now loads teller/services/financial-queries.js (pure, no deps). Without it, no finance source is injected (fail-soft), same as a DB error before.
- Stopwords change keyword matching for queries built only of function words (now a phrase match, as for short tokens before).
INVARIANTS AT RISK: None violated. INV-27 (capture now honours sensitivity; nothing private/secret is embedded or sent to AI — incl. capture structuring), INV-28/29 (keyword path now covers the vault without pgvector; either leg still degrades alone), INV-31 (hash skip intact; forgetEmbedding only when the text changed), INV-32 (prune deletes only rows that can't hit), INV-35 (getNetWorth runs SELECTs only on perfinPool, finance queries only), INV-36 (lock now claimed before any await), INV-10 (word-segment match). Candidates: vault ingest without embeddings + backfill; partial failure holds the sha and is surfaced; reindex Action fails on a failed reindex.
NET SCORE: 4 − 1 = 3 (production: KR-4 every query, KR-7 any Voyage rate limit, KR-9 with a loan/brokerage linked, KR-11 any failing sync; not this month: KR-3 (only without Voyage/pgvector), KR-8, KR-10, KR-12, KR-13, KR-14. New failure mode: a permanently failing file holds the sha and keeps re-processing its range — documented, surfaced)

OPERATOR ACTIONS / DEPLOY:
- None required. db/023 auto-migrates on boot. | BLOCKS DEPLOY: N
- After deploy, watch the next "Knowledge Vault Reindex" Action run: it now fails when the reindex fails (it was always green), and the dashboard shows "Knowledge vault sync failing" when vault_last_error is set. | BLOCKS DEPLOY: N
Deploy: Platform, Shell & Auth: Render auto-deploys on push to `main` (Per-sistant ships in the same service).

(Not complete in production until blocking operator actions are done AND
the deploy step is confirmed.)

FOLLOW-ON ITEMS:
- Search-term LIKE patterns don't escape "_" (a word char, so it can appear in a \w+ token) — "_" matches any one character. Low impact (slightly broader match); out of scope.
- The Action's 20-minute status poll can't distinguish a server restart mid-reindex (state resets to running:false, ok:null → keeps polling → times out red). Acceptable; noted.
- /api/rag/search over-fetches 4× vector chunks per query; negligible at personal scale, revisit if the corpus grows large.
- upcomingFacts still compares against Postgres CURRENT_DATE (UTC), not APP_TIMEZONE — a one-day edge near midnight; same as before, out of scope.
DOCUMENTATION UPDATES NEEDED:
- CLAUDE.md: Knowledge operator-state note (Voyage/pgvector optional — vault now ingested without them, backfill on enable); Knowledge subsystem/INV-28/29 wording; INV-36 (lock claimed before await); new invariants (vault ingest without embeddings + backfill; partial-failure sha hold + surfaced error; reindex Action fails on a failed reindex; capture sensitivity never sent to AI); test counts 1551/62 (Per-sistant 577) + batch11 test description; regression scenario SK3 expected result.
- apps/per-sistant/CLAUDE.md: Knowledge Database section (sync failure handling, attempt column db/023, backfill, ranking, finance snapshot via getNetWorth, capture sensitivity, cache prune), notification types (vault_sync_error), API (/api/rag/status last_attempt_at + reindex.ok; /api/rag/capture sensitivity), 023 migration, tests 577.
- README.md: counts 1551/62.
---END BROAD SCAN IMPLEMENTATION SUMMARY---
