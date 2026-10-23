---BROAD SCAN IMPLEMENTATION SUMMARY---
Findings implemented:
- F26 — a generic CSV's sign is unknown (some exports write deposits positive); the preview now guesses it and offers a "Positive amounts are charges / deposits" choice, applied identically by preview, import and the CLI
- F81 — the Settings / log text pointed at a "Per-sistant integration" Settings section that doesn't exist; it now names PATCH /api/settings; plus an Insight Emails toggle (insight_emails_enabled)
- F85 — a finished month archive was final forever, so a backfilled row or a later edit to an archived month never reached it; the completion marker now carries a content fingerprint and a mismatch rebuilds that tab
New capabilities (G/ST):
- ST5 (F134) — notes privacy tier: notes.sensitivity normal / private / secret; only normal notes are embedded, retrieved or sent to the AI; secret notes are masked in lists and labels
Files modified:
- teller/data/csv-formats.js, teller/routes/subscriptions.js, scripts/import-csv-cli.js, teller/views/accounts.ejs, teller/views/dashboard.ejs
- teller/services/database.js, teller/routes/insights.js, teller/routes/settings.js, teller/routes/persistent.js, teller/views/settings.ejs
- scripts/sheets-sync.js
- apps/per-sistant/db/028_note_sensitivity.sql (new), apps/per-sistant/config.js, apps/per-sistant/routes/notes.js, apps/per-sistant/services/vault-sync.js, apps/per-sistant/routes/rag.js, apps/per-sistant/routes/ai.js, apps/per-sistant/routes/search.js, apps/per-sistant/routes/links.js, apps/per-sistant/routes/calendar.js, apps/per-sistant/routes/notifications.js, apps/per-sistant/routes/trash.js, apps/per-sistant/helpers.js, apps/per-sistant/pages/notes.js
- tests: tests/scan-oct-batch16.test.js (new, 11), apps/per-sistant/tests/scan-oct-batch16.test.js (new, 7), tests/contract/batch16-perfin.contract.test.js (new, 4), tests/contract/batch16-persistent.contract.test.js (new, 4); test doubles updated in tests/scan-sept-batch10.test.js (archive months query), tests/scan-oct-batch3.test.js + tests/scan-sept-batch7.test.js (insights settings query), tests/scan-sept-batch6.test.js (archive current-month pin moved into ARCHIVE_MONTHS_SQL)

CHANGES:
F26 | csv-formats.js | generic parser takes opts.positiveMeans ('charges' default = old behaviour, 'deposits' negates); guessGenericSign(records) — inflow-keyword vote (payroll / direct dep / deposit / refund / payment received …), else a negative majority → deposits, tie → charges; POSITIVE_MEANS exported
F26 | subscriptions.js | parseCsvUpload validates body.positive_means (400) and returns positiveMeans / signGuess / parseOpts (generic only; null for known formats); preview and import both call fmt.parse(row, cols, parseOpts); preview returns positive_means + sign_guess, import returns positive_means
F26 | import-csv-cli.js | --positive-means=charges|deposits (exit 1 otherwise), the target is the first non-flag arg, a warning when the guess differs from what is applied
F26 | accounts.ejs, dashboard.ejs | a sign select shown only for a generic file, pre-set to sign_guess on the first preview (re-previewing with it when it differs), sent as positive_means once chosen; changing it re-previews; a new file resets it
F81 | database.js, settings.js, settings.ejs | user_settings.insight_emails_enabled BOOLEAN NOT NULL DEFAULT true; PATCH takes a strict boolean (400 otherwise, INV-59); GET returns it; Settings → AI Insights "Insight Emails" toggle
F81 | insights.js | generateInsights reads insight_emails_enabled with its settings and skips the insights_generated send only when it is false
F81 | settings.ejs, persistent.js | the standalone prereq text and the two webhook log lines name PATCH /api/settings { persistent_url / persistent_webhook_secret / persistent_webhook_enabled } instead of a nonexistent Settings section
F85 | sheets-sync.js | ARCHIVE_MONTHS_SQL — one grouped query per run: each archivable month + LEFT(md5(string_agg(transaction_id | amount | date | account | display merchant | display category | reimbursed | notes ORDER BY transaction_id)), 12); archiveMarker(month, fp) = "Perfin archive complete — YYYY-MM · <fp>"; a tab is complete only when its marker matches the live fp — a changed month or a legacy (fp-less) marker is cleared and rebuilt within MAX_ARCHIVES_PER_RUN; applyProtection's prefix match replaces the old marker
ST5 | db/028, config.js, routes/notes.js | notes.sensitivity TEXT NOT NULL DEFAULT 'normal' + chk_notes_sensitivity; POST/PATCH validate it (400); a PATCH leaving 'normal' deletes the note's embed_state + chunks at once (42P01 tolerated without pgvector)
ST5 | vault-sync.js | syncNotes embeds only normal notes and prunes chunks / embed_state for every note that isn't normal (like a deleted one)
ST5 | rag.js | keyword corpus and the vector join read normal notes only
ST5 | ai.js | Ask's notes context reads normal notes only; suggest-tags 400s a private / secret note (no model call)
ST5 | search.js, links.js, calendar.js, notifications.js, trash.js | a secret note's text is masked ('Secret note' fallback title; search shows no snippet and matches its title only)
ST5 | helpers.js | the reminder_due webhook / Slack fallback title never carries a private or secret note's text ('Private note')
ST5 | pages/notes.js | Privacy select in the note modal; Private / Secret badge; a secret note's preview hidden until opened; AI Suggest refused client-side for non-normal notes

TEST RESULTS: passed — npm test 1773/1773 (Perfin 1249 + Per-sistant 524, 84 files); contract suite 142/142 (local Postgres without pgvector — the chunk-delete branch of the notes test runs in CI's pgvector container); migrations run twice cleanly (ci-migration-test.js, 28 Per-sistant files); Playwright 35/35. Mutation checks: dropping the notes sensitivity filter from keyword retrieval, or the merchant from the archive fingerprint, turns the batch16 contract tests red. Four pre-existing tests failed on this session's SQL changes (test doubles routing on the old insights settings query / archive months query, one source pin) — updated in place, assertions unchanged in intent.
REGRESSION RISKS:
- CSV: a generic file previewed with no explicit choice still imports as 'charges' (unchanged IDs); the UI now sends the guessed sign, so re-importing an OLD generic file whose guess is 'deposits' shows its rows as new in the preview — the user can flip the select back. Known formats are untouched.
- Archives: the first Sheets sync after deploy rebuilds every legacy archive (≤6 per run, so a large history takes several runs); archives now follow edits to old rows, so they are no longer an immutable record of what was exported at the time.
- Notes: a private note no longer appears in Knowledge search/answers (intended); the corpus version is unchanged (a sensitivity flip bumps notes.updated_at via the trigger, so the answer cache invalidates).
INVARIANTS AT RISK: None. INV-27 extended to notes (only normal notes embedded / retrieved / sent to AI); INV-59 holds for insight_emails_enabled; INV-84 changes meaning — an archive is final only while its fingerprint matches; INV-83 unchanged (archive writes still go through the guarded client).
NET SCORE: 1 − 2 = −1 (production fix: F85 — the categorize backlog sweep and reconciles routinely change rows in archived months; F26 and F81 had no evidence of firing this month (no generic-format import seen; the misleading text shows only in a standalone deployment); ST5 is a new capability. New failure modes: archives no longer immutable (F85); re-importing a generic file with the opposite sign duplicates its rows (F26 — the preview shows it first).)

OPERATOR ACTIONS / DEPLOY:
- None required. db/028 and the insight_emails_enabled column auto-migrate; existing notes stay normal; no reindex needed (syncNotes re-evaluates every note). Expect the first Sheets syncs after deploy to rebuild legacy month archives (≤6 per run). | BLOCKS DEPLOY: N
Deploy: Platform, Shell & Auth — Render auto-deploys on push to `main`. Sheets & External Export — server-side sheets-sync.js ships with that deploy (no Apps Script change).

(Not complete in production until blocking operator actions are done AND the deploy step is confirmed.)

FOLLOW-ON ITEMS:
- F85: a month whose rows were ALL deleted keeps its stale archive tab (the grouped query no longer lists it); renaming an account doesn't change the fingerprint (account_id is hashed, not its name); splits aren't in the archive or the fingerprint.
- F26: the sign choice isn't remembered per account/institution; the CLI only warns on a mismatched guess (it never applies the guess unasked).
- F81: a standalone deployment still has no Settings form for persistent_url / webhook secret (the text now says to use PATCH /api/settings).
- ST5: the note_created webhook still sends a private / secret note's title (never its text); Knowledge's Secret lookup covers vault documents only, not secret notes; a private note's untitled reminder still shows its first 50 characters in the in-app notification list (only secret is masked there — outside webhooks get "Private note").
DOCUMENTATION UPDATES NEEDED:
- CLAUDE.md: CSV import (generic sign + positive_means on preview/import + CLI flag), the insight-email toggle and the corrected standalone text (Known Open Issues F81 bullet), Sheets month archives (fingerprint marker, rebuild on change — INV-84 wording), user_settings.insight_emails_enabled, endpoints (/api/import-csv*, PATCH /api/settings), INV-27 extended to notes, counts (1773 tests / 84 files; contract 142), Known Open Issues follow-ons.
- apps/per-sistant/CLAUDE.md: notes privacy tier (db/028, Notes feature, Knowledge secret tier, endpoints), test count 524.
- README: counts and coverage lines.
---END BROAD SCAN IMPLEMENTATION SUMMARY---
