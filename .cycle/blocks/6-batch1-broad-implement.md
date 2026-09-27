---BROAD SCAN IMPLEMENTATION SUMMARY---
Findings implemented:
- KR-2 — Knowledge vault sensitivity parsing fails CLOSED (YAML comments, block lists, yes/no/on/off, unknown value → private; most-restrictive wins)
- KR-1 — Full vault sync mark-and-sweep of deleted/renamed files; incremental falls back to full on compare 404/422 or the 300-file cap; repo/branch change resets vault_last_sha; malformed/truncated tree never sweeps
- KR-6 — Hard-deleted notes can't be vector-retrieved (source row must exist) and their chunks/embed_state are purged on permanent delete / empty trash
- FAN-1 — Rent/utility obligation PATCH no longer 500s (typed `$n::numeric IS NULL`)
- DC-1 — Bulk recategorize reachable (categorize mounted before subscriptions/transactions)
- WD-1 — Tax-report CSV/JSON/PDF links honor the /perfin basePath
- WUI-1 — Rent page <style> carries the CSP nonce (layout no longer CSP-blocked)
- WD-14 — Categorization-rules caret styles moved from a runtime-injected (CSP-blocked) <style> into perfin-shared.css
- PD-1 — Per-sistant "Save Draft" stays a draft (client sends status:'draft'; POST honors explicit status)
- PUI-1 — Email schedule / note reminder edit fields filled in LOCAL time (open+save no longer shifts by the UTC offset)
- PUI-2 — "Send now" always saves the form first (no stale-body send)
- DC-3 — Bill-calendar paid state renders (paidKey normalizes the pg DATE)
Files modified:
- teller/routes/housing.js, teller/server.js, teller/routes/subscriptions.js, teller/views/settings.ejs, teller/views/housing.ejs, teller/public/settings-rules.js, teller/public/perfin-shared.css
- apps/per-sistant/services/vault-sync.js, apps/per-sistant/routes/settings.js, apps/per-sistant/routes/rag.js, apps/per-sistant/routes/trash.js, apps/per-sistant/routes/emails.js, apps/per-sistant/pages/emails.js, apps/per-sistant/pages/notes.js, apps/per-sistant/views/js.js
- tests/housing.test.js, tests/scan-sept-fixes.test.js (new), apps/per-sistant/tests/knowledge-vault.test.js, apps/per-sistant/tests/scan-sept-fixes.test.js (new)

CHANGES:
KR-2 | apps/per-sistant/services/vault-sync.js | New stripYamlComment (quoted-scalar aware; `#` only a comment after whitespace); block-list parsing; resolveSensitivity rewritten fail-closed via frontmatterFlag + SENSITIVITY_RANK (most restrictive of sensitivity/embed/private; unrecognized → private). Old test pinning "bogus → normal" flipped to "→ private".
KR-1 | apps/per-sistant/services/vault-sync.js, routes/settings.js | listIndexableFiles returns {paths, truncated} (missing tree array ⇒ truncated); listChangedFiles returns {incomplete} at the 300-file cap; syncVault falls back to full on compare 404/422/incomplete and, in full mode on an untruncated tree, sweeps vault documents/facts whose source_ref is absent through the existing removal path; PATCH /api/settings NULLs vault_last_sha in ONE CASE assignment when vault_repo/vault_branch change.
KR-6 | apps/per-sistant/routes/rag.js, routes/trash.js | VECTOR_SQL requires n.id / d.id IS NOT NULL; trash permanent-delete + empty purge chunks/embed_state for deleted note ids (fail-soft).
FAN-1 | teller/routes/housing.js | `$n IS NULL` → `$n::numeric IS NULL` in the status CASE.
DC-1 | teller/server.js | app.use(require("./routes/categorize")) moved above subscriptions (specific-before-generic), with a comment.
WD-1 | teller/views/settings.ejs | tax-report href base prefixed with window.BASE_PATH.
WUI-1 | teller/views/housing.ejs | <style nonce="<%= nonce %>">.
WD-14 | teller/public/settings-rules.js, perfin-shared.css | removed document.createElement('style'); rules now static CSS.
PD-1 | apps/per-sistant/pages/emails.js, routes/emails.js | saveEmail sets status:'draft' and reports save failures; POST honors an explicit draft|scheduled status (400 otherwise; 400 on scheduled without scheduled_at).
PUI-1 | apps/per-sistant/views/js.js, pages/emails.js, pages/notes.js | shared toLocalDatetimeInput(iso) (backslash/backtick-free) replaces iso.slice(0,16) in both edit forms.
PUI-2 | apps/per-sistant/pages/emails.js | sendNow always awaits saveEmail() and aborts on failure.
DC-3 | teller/routes/subscriptions.js | paidKey(source, id, date) used on both sides of the paid-set lookup (local-getter formatting of the pg Date); exported after module.exports = router (INV-19).

TEST RESULTS: PASSED — npm test 1143/1143 (Perfin 674 + Per-sistant 469; was 1097, +46 new). New tests fail against the unfixed code (31 of 39 checked fail with source reverted; the rest are backward-compat/non-regression cases). Real Postgres 16 verification of the new/changed SQL: FAN-1 status CASE, DC-3 pg-DATE key, vault sha-reset CASE (old-row RHS), sweep UNION, trash ANY($1) purge, PD-1 draft insert — all PASS. Playwright e2e smokes 8/8 PASS on a live boot (scratch PG; preinstalled Chromium via a scratch-only config). Per-sistant emitted bundle + emails/notes page scripts node --check clean; PUI-1 round-trip verified under UTC, America/New_York, Asia/Kolkata.
Regression scenarios: S4 PASS (e2e: unauth redirect, PIN login, both apps render); SK2 PASS (KR-2/KR-6 tests); SK1 PASS by test (unchanged tree ⇒ 0 removed; up-to-date path untouched); SK3 PASS by code read (vectorReady gate precedes the new sweep, unchanged); S1/S2/S3/S5/S6/SK4/SK5 NOT APPLICABLE (no files in those paths modified).

REGRESSION RISKS:
- KR-2: unquoted frontmatter values containing " #" are now truncated at the comment (YAML-correct and what Obsidian itself shows, but e.g. a fact `policy: ABC #123` now stores "ABC"; quote the value to keep it). Some vault docs previously resolved "normal" (e.g. `embed: maybe`, `sensitivity: normal` + `private: true`) now resolve "private" and leave retrieval — intended fail-closed.
- KR-1: new deletion path in full sync — guarded against truncated and malformed trees; a vault that is genuinely emptied WILL have its index swept (correct).
- PD-1: "Save Draft" on an already-scheduled email now unschedules it (label semantics; "Save & Schedule" remains the scheduling path). "Send now" now closes the modal before the send result alert (same as the pre-existing new-email path).
- DC-1: route mount order changed; categorize.js registers no generic pattern that could shadow subscriptions/transactions routes (verified); e2e boot green.
- DC-3: paid bills now render paid, so the calendar's un-mark (DELETE) path becomes reachable; it matches via JSON `paid_date.startsWith(date)`, correct on a UTC host (Render).
INVARIANTS AT RISK: None violated. INV-27 semantics strengthened (fail-closed; test flipped deliberately). INV-36 syncVault control flow restructured — the up-to-date early return and all new branches are inside the try, so `finally` still releases the lock (verified). INV-19 (paidKey attached after module.exports = router) and INV-63 (views/js.js fetch wrapper untouched; emitted bundle node --check clean) hold.
NET SCORE: 9 − 1 = 8

OPERATOR ACTIONS / DEPLOY:
- After deploy, run ONE full Knowledge reindex (POST /per-sistant/api/rag/reindex, or let knowledge-reindex.yml fire) so rows stored under the old fail-open parser are re-classified and deleted-file orphans are swept | BLOCKS DEPLOY: N
Deploy: Platform, Shell & Auth: Render auto-deploys on push to `main` (configured in the Render dashboard, not via CLI). Alt: `fly deploy` (Dockerfile-based).

(Not complete in production until blocking operator actions are done AND
the deploy step is confirmed.)

FOLLOW-ON ITEMS:
- Tax-report links nest <button> inside <a> (two tab stops, invalid nesting) — IF batch (Batch 13).
- Calendar un-mark relies on UTC JSON serialization of paid_date (`startsWith(date)`); a non-UTC host would miss — fold into the Batch 6 timezone sweep.
- saveAndSchedule / deleteEmail / quick-send still ignore non-ok responses (WD-12/PUI-4 class — Batch 13/14).
- Vault sync still processes removals after changed files, so one failing file aborts the sweep for that run (KR-7, Batch 11).
- Playwright's pinned headless-shell (1223) doesn't match this environment's preinstalled Chromium (1194); e2e only runs locally with an executablePath override (CI installs its own browser — unaffected).
DOCUMENTATION UPDATES NEEDED:
- CLAUDE.md: test counts (1143 across 45 files; Perfin 674 + Per-sistant 469) and the two new scan-sept-fixes test files; INV-27 note (fail-closed parsing, most-restrictive wins); "Calendar shows paid state" now accurate.
- apps/per-sistant/CLAUDE.md: Knowledge sync section — frontmatter fail-closed semantics (comments/lists/yes-no, unknown → private), full-sync mark-and-sweep + compare fallback, repo/branch change resets vault_last_sha, trash purges Knowledge chunks; test count 469; "Save Draft" semantics.
---END BROAD SCAN IMPLEMENTATION SUMMARY---
