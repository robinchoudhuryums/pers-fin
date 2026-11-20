---BROAD SCAN IMPLEMENTATION SUMMARY---
Scope: Batch 1 of the cycle-9 scan (Nov 2026) — backups and CI can't-wait | Cycle: 9 | Date: 2026-11-13
Findings implemented:
- F1 — the nightly backup's verify step failed on every real-size dump (gpg died on a broken pipe once pg_restore had read the table of contents), before the upload and the backup stamp
- F59 — six date-dependent test files (`npm test` would have gone red for good on 2026-11-20; two files red late Jan – late Mar every year; two on every 31st / Mar 29–30; one contract test Jan 1 – Feb 15)
- F9 — deploy/vps/backup.sh discarded gpg's exit status, so a truncated encrypted file counted as verified
- F12 — pg_dump's error text (it names the database host) could reach public Actions logs; CALENDAR_FEED_TOKEN had no minimum-length check
New capabilities (G/ST): None
Files modified: .github/workflows/db-backup.yml, deploy/vps/backup.sh, teller/services/operator-checks.js, tests/cycle9-b1.test.js (new), tests/broad-scan-fixes.test.js, tests/broad-scan-c8-batch3.test.js, tests/roadmap-t2-2-cash-l1.test.js, tests/scan-sept-batch3.test.js, tests/scan-sept-batch6.test.js, tests/fire-and-ask.test.js, tests/contract/tax-documents.contract.test.js, .cycle/STATE.md, .cycle/blocks/9-batch1-broad-implement.md

CHANGES:
F1 | .github/workflows/db-backup.yml | backup_db verifies in two steps instead of a pipe: `gpg --decrypt --output <name>.verify <file>` (gpg's integrity check now covers the whole file), then `pg_restore --list <name>.verify`; each failure removes the .verify and the .gpg, prints a fixed ::error:: line and fails the step. Checked on the 1.5 MB dump that failed 3 of 3 before: verified, exit 0.
F12 | .github/workflows/db-backup.yml | pg_dump's stderr goes to a file that is removed; on failure the step prints which kind it was (client older than the server / credentials refused / unreachable / a table it can't read / unknown) and never pg_dump's own text.
F9 | deploy/vps/backup.sh | decrypts to `<out>.plain.partial` with gpg's exit status checked ("did not decrypt cleanly" → fail), then `pg_restore --list < plain`; the plaintext copy is removed (and is covered by fail()'s *.partial cleanup).
F12 | teller/services/operator-checks.js | goLiveChecks: a set CALENDAR_FEED_TOKEN shorter than 24 characters (CALENDAR_FEED_TOKEN_MIN) → local:calendar-feed warn (never the value or its length); 24+ → ok; unset stays localChecks' info note.
F59 | tests/broad-scan-c8-batch3.test.js | the recovered Teller row is dated 5 days before the real clock, not the literal 2026-10-20.
F59 | tests/roadmap-t2-2-cash-l1.test.js, tests/scan-sept-batch3.test.js | the GET /api/cash-flow describes pin the clock to mid-June 2026 with node:test's Date mock (cash-l1 at an hour where the forced zone's date still differs from UTC's); cash-l1's fixture bill was last charged one calendar month before tomorrow (stepDate), not tomorrow − 30 days.
F59 | tests/scan-sept-batch6.test.js | through_day is asserted as `d < 31 ? d : null` (the route reports the whole month on the 31st).
F59 | tests/fire-and-ask.test.js | last month = previousMonthKey(currentMonth()), not setMonth(month − 1) on today's day.
F59 | tests/contract/tax-documents.contract.test.js | before the linked-task run, any open form not yet past its usual date is moved to yesterday through PATCH /api/tax/documents/:id (a no-op from Feb 16 to Dec 31).
tests | tests/cycle9-b1.test.js (new, 12 tests) | runs db-backup.yml's backup_db and a copy of backup.sh in bash with the real gpg and stubbed Postgres tools (a pg_restore that reads only the start of its input): the old pipe fails on a 2 MB dump, the new function verifies it, a truncated .gpg / an unreadable archive / a failed pg_dump each fail with nothing left behind and no host printed; backup.sh keeps and stamps two verified files, refuses a truncated one (the pre-fix script fails this test) and an archive with no tables; source pins; the token check. Skips its bash half without bash + GNU coreutils + gpg.
tests | tests/broad-scan-fixes.test.js | the pin that required the broken `--decrypt "$out" | pg_restore --list` pipe now requires the two-step verify.

TEST RESULTS: passed — npm test 3216 / 3216 (3204 + 12 new) on today's clock and under eight shifted clocks (2026-11-21, 2026-12-31, 2027-01-01 00:30Z, 2027-01-31, 2027-02-10, 2027-03-10, 2027-03-30, 2028-02-29); contract suite 340 / 340 on a local Postgres 16; tests/contract/tax-documents also under 2027-01-15, 2027-02-05 and 2027-01-01 clocks (failed on the first two before the fix). e2e not run (no page or route changed). Regression Scenarios: S4 (Platform) NOT APPLICABLE — no auth, mount or pool-wiring code touched; the others' subsystems weren't modified.
REGRESSION RISKS: (1) db-backup.yml no longer prints anything pg_dump writes to stderr, warnings on a successful dump included — an unclassified failure has to be reproduced locally. (2) backup.sh needs room for one plaintext copy of each dump in BACKUP_DIR during verification; with too little it fails (not kept, not stamped). (3) A production CALENDAR_FEED_TOKEN under 24 characters now shows as an operator-check warning and sends one "Operator checks: N need attention" push. (4) The two cash-flow route test blocks now run on a pinned date, so they no longer exercise today's real calendar (the service-level tests in the same files and tests/contract/cash-flow-l1 still do).
INVARIANTS AT RISK: None. INV-103 is tightened (pg_dump text withheld), INV-126 holds for the new check (env only, "shorter than 24", never the value), INV-53's backup backstop becomes able to run, INV-94 green.
NET SCORE: 1 production fix (F59 — CI would have gone red on 2026-11-20; F1 / F9 / F12 are not counted: the backup workflow has never got past its secrets check, the VPS isn't live, and there is no evidence of a leaked host or a guessed token) − 2 Low new failure modes (regression risks 1 and 2) = −1

OPERATOR ACTIONS / DEPLOY:
- Set the repository secrets NEON_DATABASE_URL, PERSISTENT_DATABASE_URL and BACKUP_ENCRYPTION_PASSPHRASE, re-enable the Database Backup workflow, run it once by hand (Actions → Database Backup → Run workflow) and confirm an artifact with two .dump.gpg files and "Backup recorded." Then do one restore drill. | BLOCKS DEPLOY: N
- If production's CALENDAR_FEED_TOKEN is shorter than 24 characters: set a new one (openssl rand -hex 32) and re-subscribe the calendar app to the new feed address. | BLOCKS DEPLOY: N
- When the VPS goes live, install this version of deploy/vps/backup.sh on the server. | BLOCKS DEPLOY: N
Deploy: Platform, Shell & Auth — merge to `main`; Render auto-deploys (the operator-checks change). The workflow change takes effect once it is on the default branch.

(Not complete in production until blocking operator actions are done AND the deploy step is confirmed.)

FOLLOW-ON ITEMS:
- /calendar.ics still has no rate limit (the third part of F12, left out on purpose: with a 24+ character token guessing isn't feasible, and a limiter could block a calendar app's polling).
- db-backup.yml leaves the plaintext dump on the runner if the encrypt step itself fails (an ephemeral runner; the upload glob never matches it).
- The shifted-clock preload used to verify F59 lives in the session scratchpad, not the repo — ST2 (a shared test clock + a shifted-date CI job) would keep date-dependent tests from coming back.
- e2e/seed.js dates rows by UTC day offsets; its behaviour in the first days of January wasn't exercised.
- .cycle/STATE.md's header note still says the next audit "increments Cycle to 7" (F60).

DOCUMENTATION UPDATES NEEDED:
- CLAUDE.md: db-backup.yml's description (Operator state item 4, "VERIFIED in the run") → decrypts in full, then lists; pg_dump's message withheld. backup.sh's description in deploy/vps. operator-checks.js + the Sync Health Operator Checks list: the CALENDAR_FEED_TOKEN length check. tests/ list: tests/cycle9-b1.test.js; counts 3204 → 3216 tests, 177 → 178 files, Perfin 2461 → 2473. Known Open Issues: a cycle-9 entry (Batch 1 done; Batches 2–10 open). INV-103 (pg_dump text) and INV-126 (the new check) wording.
- README.md: test count (3202 → 3216); Backups section ("checks that each encrypted file decrypts into a readable archive" → decrypts in full, then lists).
---END BROAD SCAN IMPLEMENTATION SUMMARY---
