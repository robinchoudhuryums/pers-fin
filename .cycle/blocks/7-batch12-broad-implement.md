---BROAD SCAN IMPLEMENTATION SUMMARY---
Findings implemented:
- F126 — an empty or max_tokens-truncated Knowledge answer is no longer cached (it was served for 24 h)
- F127 — a truncated GitHub tree listing is a reported failure; the vault SHA holds
- F128 — a vault file over 1 MB is read through the Git blobs API instead of being ingested empty
- F129 — GitHub (20 s read / 30 s write) and Voyage (30 s document / 10 s query) fetches have timeouts
- F130 — /api/rag/query, /diagram, /capture share the AI rate limiter; questions ≤1000 chars, captures ≤20000
- F131 — upcomingFacts announces only current facts and uses the APP_TIMEZONE date
- F132 — "--- " delimiters with trailing whitespace parse; repeated sensitivity/embed/private keys fail closed
- F133 — a diverged / behind compare (force-push, reset) forces a full walk + sweep
- F135 — a "fact" capture with no usable fields is committed as a note
New capabilities (G/ST): None
Files modified:
- apps/per-sistant/ai.js
- apps/per-sistant/routes/rag.js
- apps/per-sistant/pages/knowledge.js
- apps/per-sistant/services/vault-sync.js
- apps/per-sistant/services/embeddings.js
- apps/per-sistant/middleware.js
- apps/per-sistant/tests/scan-sept-fixes.test.js (two KR-1 tests pinned the old ok:true-on-truncation behaviour)
- apps/per-sistant/tests/scan-oct-batch12.test.js (new, 24 tests)
- tests/contract/knowledge-batch12.contract.test.js (new, 4 tests)

CHANGES:
F126 | ai.js, routes/rag.js, pages/knowledge.js | answerWithCitations returns stop_reason; callAI takes an optional `meta` object that receives it (the prompt-cite fallback passes one). POST /api/rag/query: an empty answer returns answer:null + a note + the sources, uncached; a max_tokens answer is returned with truncated:true and never cached. The Knowledge page shows "This answer was cut off".
F127 | services/vault-sync.js | A full walk whose tree is truncated still ingests the listed files, skips the sweep (as before), and now adds a "(file list)" failure → ok:false, partial, vault_last_error set, vault_last_sha NOT advanced.
F128 | services/vault-sync.js | getFileText: encoding "none" (or empty content with size > 0) → GET /git/blobs/:sha; if that yields no base64 content, the file throws ("file too large to fetch") so it is a per-file failure, never an empty ingest that clears its facts.
F129 | services/vault-sync.js, services/embeddings.js | ghJson + commitVaultFile pass AbortSignal.timeout (GH_TIMEOUT_MS 20 s, GH_WRITE_TIMEOUT_MS 30 s); embedRequest passes VOYAGE_TIMEOUT_MS (document 30 s, query 10 s) — a timeout is retried like a network error.
F130 | middleware.js, routes/rag.js | aiLimiter (20/min) also mounted on /api/rag/query, /diagram, /capture. MAX_QUERY_CHARS 1000 (query, diagram, search) and MAX_CAPTURE_CHARS 20000 (capture) → 400 with the limit.
F131 | routes/rag.js | upcomingFacts(pool, days, today = todayStr()): $2::date replaces CURRENT_DATE; both branches require valid_from ≤ today, the attribute branch also valid_to ≥ today.
F132 | services/vault-sync.js | parseFrontmatter accepts `---[ \t]*` on the opener and closer; setMetaValue keeps every value of a repeated sensitivity/embed/private key (array), so resolveSensitivity's most-restrictive rule applies (embed/private arrays → private). Other keys stay last-wins.
F133 | services/vault-sync.js | listChangedFiles returns incomplete unless the compare status is "ahead" or "identical" (missing status = trusted, for older stubs) → runVaultSync does the full walk + mark-and-sweep.
F135 | services/vault-sync.js, routes/rag.js | captureFieldLines(fields) (exported); buildCaptureMarkdown writes a note titled by title||entity when a fact has no usable field; the capture route reports type "note" in that case.

TEST RESULTS: passed — npm test 1702/1702 (+24 apps/per-sistant/tests/scan-oct-batch12); contract 103/103 (+4 knowledge-batch12); Playwright 35/35. No migration change. The new unit file fails 22/24 pre-fix (the two that pass are controls: a complete answer is cached; non-privacy keys stay last-wins); the new contract file fails 4/4 pre-fix. Two existing KR-1 tests (scan-sept-fixes) encoded the old ok:true-on-truncated-tree behaviour and were updated to F127's contract.
REGRESSION RISKS:
- A vault too large for one tree listing (>100k entries / 7 MB) now fails every hourly sync with a full re-walk (GitHub contents call per listed file) instead of silently reporting ok — loud but costly; such a vault was never fully indexed anyway.
- A repeated `embed: true` / `private: false` (both permissive) now resolves to private (an array is "unknown") — fail-closed by design.
- A blob fetch of a very large file may hit the 20 s GitHub timeout → that file fails (reported) rather than being ingested.
- The AI limiter (20/min) now also counts Knowledge questions; heavy back-to-back querying can 429.
INVARIANTS AT RISK: None. Strengthened: INV-27 (sensitivity fails closed on duplicates and "--- "), INV-32 (only complete answers are cached), INV-36 (the SHA advances only on a complete, untruncated sync).
NET SCORE: 0 − 1 = −1 (no fix would have fired this month — the vault feature has run on an empty/small vault and none of the edge inputs occurred; the documented new failure mode is F127's hourly full re-walk for an over-large vault).

OPERATOR ACTIONS / DEPLOY:
- None (no env var, no migration). | BLOCKS DEPLOY: N
Deploy: Per-sistant ships with the main Render deploy (auto-deploys on push to `main`); no Apps Script change.

(Not complete in production until blocking operator actions are done AND
the deploy step is confirmed.)

FOLLOW-ON ITEMS:
- The RAG endpoints still don't charge Per-sistant's AI cost cap (the cap is opt-in per call site — D1; only Job Radar uses it).
- A fact FILE (not a capture) whose frontmatter has no non-reserved keys still drops its body at ingest.
- An unclosed frontmatter block (`---` opener, no closer) is read as body text, so a `sensitivity:` line inside it is ignored (Obsidian also treats it as text).
- A vault too large for one recursive tree listing could be walked subtree by subtree instead of failing (F127 only surfaces it).
- F134 (notes have no sensitivity tier) → ST5, not in this batch.
(or "None")

DOCUMENTATION UPDATES NEEDED:
- apps/per-sistant/CLAUDE.md: Knowledge block — answer cache skips empty/truncated answers (+ truncated flag), sync lifecycle (truncated tree is a failure, blobs fallback for >1 MB, diverged/behind compare → full walk, fetch timeouts), frontmatter (trailing whitespace, repeated privacy keys), proactive surfacing (validity window + APP_TIMEZONE), capture (fact without fields → note, 20000-char cap), rate limiting (aiLimiter on rag query/diagram/capture, 1000-char question cap); API list (400s, truncated); test count 485 → 509.
- CLAUDE.md (root): counts (1702 across 79 files; Per-sistant 509; contract 103 with knowledge-batch12), Known Issues header (Batch 12 done) + Batch 12 follow-ons; INV-27/32/36 text extended (duplicate keys + "--- ", complete answers only, truncated tree).
- README: counts + Batch 12 summary + the contract list item.
---END BROAD SCAN IMPLEMENTATION SUMMARY---
