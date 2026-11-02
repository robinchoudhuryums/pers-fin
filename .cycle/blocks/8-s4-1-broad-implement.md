---BROAD SCAN IMPLEMENTATION SUMMARY---
Findings implemented: S4-1 (from .cycle/plan-seams4.md / Seams & Invariants audit #4)
- A1 — a push is recorded 'sent' only when a device took it; none delivered → 'none' (sendToAll and the quiet-hours release)
- B2 — Sync Health reads only the watched jobs, so the runner's job-watchdog claim row no longer reads as permanently stale
- S2 — a rename rule moving two old keys at one cadence re-keys one survivor (user state first); create / update / apply-to-all run in one transaction
- B3 — db-backup.yml records whether Per-sistant's database was dumped; Operator Checks warns under the shell when only Perfin's was
- C1 — the contribution-limits Save is refused while the investment accounts failed to load, and a save keeps limits for accounts without a box
New capabilities (G/ST): None
Files modified: teller/routes/notifications.js, teller/routes/settings.js, teller/routes/merchant-rename.js,
  teller/services/operator-checks.js, teller/views/settings.ejs, .github/workflows/db-backup.yml,
  tests/cycle8-e3b.test.js, tests/cycle8-e3d.test.js, tests/scan-oct-batch3.test.js, tests/ops-and-alerts.test.js,
  tests/cycle8-e4a.test.js, tests/roadmap-t4-1-a10.test.js, tests/contract/watchdog-rename.contract.test.js,
  tests/contract/operator-freshness-e4a.contract.test.js

CHANGES:
A1 | teller/routes/notifications.js | INSERT … RETURNING id; after the push, r.sent === 0 (no live subscription, every send failed, a delivery error) → UPDATE that row 'sent' → 'none' and return push_state 'none'; releaseHeldNotifications marks the holds 'none' (outcome 'none', released 0) when nothing was delivered. `logged` unchanged. Test doubles in cycle8-e3b / e3d now return the inserted id and honour the UPDATE's push_state guard.
B2 | teller/routes/settings.js | gatherDataHealth reads job_runs WHERE job_name = ANY(Object.keys(JOB_INTERVALS_MS)) instead of != '_watchdog' — the job-watchdog row (written once by the runner's claim, never ticked) and any retired job name are no longer listed or flagged stale.
S2 | teller/routes/merchant-rename.js | rekeyDetectedRows moves one survivor per cadence (per cadence + direction for transfers) via DISTINCT ON — cancelled / dismissed / notes / forecast setting (/ user-set type) first, then active, newest — the rest stay on their old key and are deactivated as before. New inTransaction(db, fn): the pool → one client transaction (ROLLBACK on { error } or a throw); a client / test double runs as is. createRenameRule, createRuleFromTransaction (incl. the edited row's tag) and updateRenameRule run inside it; re-detection runs after COMMIT.
B3 | .github/workflows/db-backup.yml, teller/services/operator-checks.js | The Per-sistant step (id: persistent) emits a ::warning:: and dumped=false when its secret is unset, dumped=true after a verified dump; the stamp records last_backup_source 'github' or 'github-perfin-only'. backupCheck(pool, env, now, { underShell }) — underShell = a persistentPool is wired — warns on 'github-perfin-only' (age still fails first); standalone reads it as ok ("Perfin's database only").
C1 | teller/views/settings.ejs | loadContribAccounts disables Save while CONTRIB_ACCOUNTS is null; the click refuses with a sentence and sends nothing; readContribLimits(rows, base) merges the boxes over the stored map (a blank box removes its key, an account with no box keeps its limit).

TEST RESULTS: npm test 3135/3135 (was 3130 — +5); contract 330/330 (+2: S2 survivor and S2 rollback — both red on the old code with the unique-violation 500); e2e 91/91. Red checks: the C1 vm test fails with settings.ejs reverted; the A1 / B2 / B3 tests assert the new values.
REGRESSION RISKS:
- S2: the rule's whole apply (rows renamed through applyRenameRules) now holds its row locks until COMMIT; a sync upserting one of those rows waits for it (seconds at most).
- A1: the row is written 'sent' and corrected to 'none' after the push, so a Per-sistant check landing in that window (the length of a push call) reads it as pushed.
- B2: a job_runs row for a name not in JOB_INTERVALS_MS is no longer listed in Sync Health at all (none records an outcome today).
- B3: an existing 'github' stamp keeps reading ok until the next workflow run writes the new source.
INVARIANTS AT RISK: None broken. INV-124 (rename rules) holds again (S2); INV-153 — "pushed" now means delivered to ≥1 device (A1, wording); INV-126 backup part (B3); INV-105 (data-health jobs, B2); INV-151 (the forecast carry still runs after the survivor moves); INV-59 / INV-157 (C1 is a client-side merge — the PATCH still replaces the whole map).
NET SCORE: 2 − 1 = +1 (production fixes this month: A1 — conditional on VAPID keys being set, B2 — certain ~36 h after the deploy; S2, B3, C1 need a specific action / the backup secrets / a failed load — NO this month; new failure mode: S2's longer lock hold, Low)

OPERATOR ACTIONS / DEPLOY:
- Set the PERSISTENT_DATABASE_URL repository secret (with the other Database Backup secrets) — otherwise Operator Checks now warns that Per-sistant isn't backed up | BLOCKS DEPLOY: N
Deploy: Platform, Shell & Auth — Render auto-deploys on push to main. (Sheets & External Export not touched.)

(Not complete in production until blocking operator actions are done AND the deploy step is confirmed.)

FOLLOW-ON ITEMS:
- With GITHUB_OPS_TOKEN set (and no SERVER_BACKUPS) backupCheck is off and the GitHub check reads only the run's success — it can't see a Perfin-only backup either.
- S2: a loser's user state (notes / dismissed) is dropped when the survivor already carries user state of its own (only one row can survive).
- The rest of audit #4: S4-2 … S4-5 (.cycle/plan-seams4.md).

DOCUMENTATION UPDATES NEEDED:
- CLAUDE.md: db-backup.yml's stamp ('github' / 'github-perfin-only') in Operator state item 4, the backupCheck / local:backup descriptions and the user_settings.last_backup_source column; INV-153 ("sent" = delivered to ≥1 device; 'none' otherwise); the sendToAll / release notes under notifications.js and Web Push; GET /api/data-health's jobs[] = the watched jobs; merchant-rename.js (one survivor per cadence, one transaction) and INV-124; the contribution-limits editor (Save refused without accounts, merged over the stored map); test counts (3135 / contract 330).
---END BROAD SCAN IMPLEMENTATION SUMMARY---
