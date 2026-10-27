# Cycle 7 — expansion work: implementation plan (Batches 17–20)

Written 2026-10-21, after the deferred plan (Batches 14–16) finished. It replaces the
scan's E-batch grouping for the remaining expansion items. E3 (G4, G5, ST2) and ST5
already shipped in Batches 14–16.

## Why the E-batches are re-cut

Batches 14–16 each took about 8–12h, and that is what one `/broad-implement` session
holds with full verification (npm, contract, migrations, Playwright, summary block).
Measured against that:

| E-batch | Items (estimate) | Total | One run? |
|---------|------------------|-------|----------|
| E1 | G1 remaining (6–8h) + G2 remaining (4h) + ST4 (8h) | 18–20h | **No**. Split it: G1 and ST4 share one GitHub client and one Sync Health surface, so they go together. G2 goes last, so its click sweep covers the UI built in 17–19. |
| E2 | G3 Plaid update mode (8h) + ST1 async sync (5h) | about 13h | **Marginal**, so split it. The two are independent and G3 is the riskier change (it re-links bank auth). Each one also has a natural follow-on to absorb (listed below). |
| E4 | ST3 tidy-up (2h) | 2h | **Too small** for a run of its own. Fold it into Batch 20. |

Order: 17 → 18 → 19 → 20.
- **Batch 17** first: it makes the open operator risks visible (no backups, disabled backstops, public repo).
- **Batch 18** next: daily-sync timeouts happen every day.
- **Batch 19** after that: re-auth only matters when a bank password changes.
- **Batch 20** last: the click sweep should exercise everything built before it.

Each batch below names every item it covers. Per `/broad-implement` rules, anything else noticed goes into follow-ons.

---

## Batch 17 — Operator visibility (G1 remaining + ST4) | about 11–13h

**Goal.** The app reports operator-side state it can't see today:
- a disabled or failing backstop workflow;
- no recent backup;
- missing workflow secrets;
- a public repo;
- a Knowledge index built with old parsing rules.

Batch 3 already records each in-process job's outcome (INV-105). This batch adds what lives outside the process.

**GitHub client.** New file `teller/services/github-ops.js`:
- Read-only REST client. Configured by env `GITHUB_OPS_TOKEN` (fine-grained PAT: Actions read, Metadata read, Secrets read) and `GITHUB_OPS_REPO` (`owner/repo`). The token is never stored in the DB and never logged.
- 10s timeout per call. Results cached for 6h; "Check now" bypasses the cache.
- Fail-soft. With no token, a 401/403 or a network error, the GitHub checks are `unknown` and carry the reason. They never throw into data-health.

**Checks.** `getOperatorChecks({ force })` returns `[{ id, label, status: ok|warn|fail|unknown, detail, fix }]`.

GitHub checks:
- **Workflow state** for each backstop: daily-sync, weekly-reconcile, db-backup, knowledge-reindex, keep-alive, job-radar.
  - `disabled_inactivity` or `disabled_manually` → fail. The fix text says "Actions → <workflow> → Enable workflow".
  - Latest scheduled run failed, or is older than 2× its cron cadence → warn.
- **Backups.** The last SUCCESSFUL db-backup run is older than 36h, or none exists → fail. Today's state, "never ran", must read as fail.
- **Secrets present** for each workflow, by name only via `GET /actions/secrets`:
  - required: SERVER_URL, API_KEY, NEON_DATABASE_URL, BACKUP_ENCRYPTION_PASSPHRASE;
  - optional (info): PERSISTENT_DATABASE_URL, and csv-import's GOOGLE_SERVICE_ACCOUNT_KEY / GOOGLE_SHEETS_ID / TOKEN_ENCRYPTION_PASSPHRASE (that workflow refuses to run while the repo is public).
  - Values are never readable or requested.
- **Repo visibility.** Public → warn. The fix text covers making it private and deleting old Actions logs.

Local checks (no token needed):
- Teller cert fingerprint: reuse `tellerCertStatus()`, and move its data-health issue here so there is one source.
- TOKEN_ENCRYPTION_PASSPHRASE set.
- SHELL_PIN at least 6 characters.
- APP_TIMEZONE unset/UTC → info.
- VAPID / CALENDAR_FEED_TOKEN → info only.

**Knowledge reindex version.**
- Add `VAULT_PARSE_VERSION` in `apps/per-sistant/services/vault-sync.js`, bumped whenever frontmatter parsing or sync semantics change. Start at 2 and note "bump on parsing change" beside the constant.
- A successful FULL sync stamps `user_settings.vault_parse_version` (new Per-sistant migration `db/029`).
- The doctor reads it read-only through the wired `persistentPool` (INV-25). When stored < current → warn: "run one full Knowledge reindex". This replaces the manual operator note from Batch 12.

**Surfaces.**
- `GET /api/operator-checks` returns `{ checked_at, github: { configured, ok, reason }, checks }`. `?refresh=1` forces a refresh. Behind the normal auth.
- `GET /api/data-health` adds each warn/fail check to `issues[]`, so the dashboard sync strip shows it, and adds `operator_checks` to the response.
- Settings → Sync Health gets an "Operator checks" list (status dot, detail, fix text) and a "Check now" button that goes through writeOk.
- The missed-job watchdog tick (6h) refreshes the checks. When the set of failing check ids CHANGES, it pushes one notification (tag `operator-checks`, signature stored like Sheets / `jobs-missed`).

**Rules.** INV-103 still holds: no workflow prints any of this. The checks never return a secret value, and the token never appears in responses.

**Tests.**
- Unit, with a fake `fetchImpl`:
  - disabled workflow → fail;
  - failed or stale run → warn;
  - no successful backup → fail;
  - missing secret → fail;
  - public repo → warn;
  - no token / 401 / timeout → unknown with reason;
  - the 6h cache and the force bypass;
  - the signature-deduped notification;
  - the local checks.
- Per-sistant unit: a full sync stamps the version; a partial or failed sync does not.
- Contract (real Postgres): data-health with a stubbed client lists the GitHub issues; the reindex-version check reads the Per-sistant DB through persistentPool.
- Source pins: no token in responses or logs; settings.ejs wiring.

**Operator.**
- Create the fine-grained PAT (read-only Actions, Metadata, Secrets) on the repo and set `GITHUB_OPS_TOKEN` + `GITHUB_OPS_REPO` on Render.
- Not blocking: without them the GitHub checks read "unknown — not configured".

**Docs.** New INV: operator checks are fail-soft and read-only, the token is never stored, logged or returned, and secret values are never requested. Operator state gains a GitHub ops token item. Known Open Issues: G1 resolved.

---

## Batch 18 — Asynchronous sync for the backstops (ST1) | about 6–8h

**Goal.** daily-sync stops failing on curl timeouts.
- `/api/sync` (max-time 420s) and `/api/sync-balances` (240s) can outrun Render's request window on a cold start or a long Plaid walk.
- The workflows start a background run and poll for its outcome instead.

**Server.**
- Generalize the reconcile background tracker (`reconcileJob` in `teller/routes/enrollments.js`) into one small in-memory job tracker, keyed by kind (`sync`, `sync-balances`, `reconcile`), with `{ running, phase, started_at, finished_at, result, error }`.
- `POST /api/sync` and `POST /api/sync-balances` accept `background: true`:
  - return 202 `{ started, kind, started_at }`;
  - return 409 if that kind is already running;
  - poll at `GET /api/sync/status?kind=`.
- Without `background` the response is unchanged (the UI and API callers rely on it).
- The background run goes through the same single-flight helpers (PSC-12): a manual sync during it shares the run. It records `last_sync_result` / `last_txn_sync_at` exactly as the synchronous path does.
- The 500-when-nothing-synced rule (`teller.failed && !plaidOk`) becomes `error` on the status.

**Workflows.**
- daily-sync.yml starts each of the two steps with `background:true` and polls status every 15s, up to 20 min.
  - It fails the step on `error`, on a non-2xx, or on running past the deadline.
  - It prints only allowlisted counts through `SUMMARY_JS` (INV-103).
- weekly-reconcile.yml switches to the existing background reconcile + polling.
- **Absorbed Batch 3 follow-on:** weekly-reconcile, knowledge-reindex and job-radar adopt `CHECK_STATUS`, so a curl timeout ("000") becomes an `::error::` annotation instead of a silent exit.

**Tests.**
- Route:
  - 202 then status running → done with the result;
  - 409 while running;
  - error surfaced on the status;
  - the synchronous path unchanged;
  - a background run and a manual POST share one run.
- Workflow pins: the polling loop and deadline, `CHECK_STATUS` in every workflow that curls, no response body printed.
- Contract (real Postgres): a background `/api/sync` with stubbed providers completes and writes `last_sync_result`.

**Operator.** None (the workflows ship with the push).

---

## Batch 19 — Plaid Link update mode (G3) | about 8–10h

**Goal.** Re-authenticating a Plaid item, or adding accounts at an already-linked login, keeps the same Item. Its transactions and the edits on them stay. Today it needs unlink + link (CLAUDE.md gotcha; the F18 duplicate guard is the stop-gap).

**Server** (`teller/routes/investments.js`).
- `POST /api/plaid/link-token-update { item_id, kind: 'transactions'|'investments' }`:
  - decrypts the item's token with `perfin_try_decrypt`;
  - calls `linkTokenCreate` with `access_token`, no `products`, and `update: { account_selection_enabled: true }`;
  - a NULL token → 409 `decryption_failed` with the unlink-then-link advice (the only case that still needs it).
- `POST /api/plaid/update-complete { item_id, kind }`, called on Link success. Update mode keeps the access token, so there is no exchange. It:
  1. calls `accountsGet` + `registerMissingPlaidAccounts`, so new accounts register before any sync (BSI-1);
  2. clears `plaid_items.last_error_code`;
  3. runs `syncPlaidItemTransactions` for that item (inside `withPlaidTxnLock`); for `investments`, it runs the holdings sync for the item instead;
  4. returns `{ accounts_added, transactions_added }`.
- **Absorbed Batch 4 follow-on:** the investments-only `POST /api/plaid/exchange` gets the F18 duplicate guard (`findDuplicatePlaidItem`, the Item released at Plaid, 409). Its error text now points to "Re-authenticate / Add accounts", not unlink + link.

**UI** (`teller/views/accounts.ejs`).
- A Plaid item with `last_error_code` shows "Re-authenticate". Every Plaid item shows "Add accounts".
- Both open Plaid Link with the update token, then POST update-complete and report the result through writeOk.
- The Sync Health issue "N Plaid item(s) need re-authentication" and its notification deep-link to `/accounts`.

**Tests.**
- Stubbed Plaid client:
  - the update token request shape (access_token present, no products, account selection on);
  - update-complete clears the error code, registers a new account before the sync, and syncs only that item;
  - the decryption_failed 409;
  - the investments exchange 409 on a duplicate.
- Contract (real Postgres): an item with `last_error_code` and existing transactions plus user edits → update-complete → error cleared, transaction count unchanged, edits intact, a new account registered.
- vm/source pin: the Accounts page button wiring (real Plaid Link can't run in CI).

**Docs.** Replace the two "unlink + link" gotchas and the Known Open Issues G3 bullet.

**Operator.** None. Update mode needs no new Plaid product or env.

---

## Batch 20 — Browser quality + Per-sistant client kit (G2 remaining + ST3) | about 6–8h

**G2.** `e2e/pages.spec.js` loads every page but against an empty database, and only fails on page errors or 5xx.
- **Seed data.** `e2e/boot-server.js` seeds both DBs through the apps' own routes where possible:
  - a manual account with transactions, including a refund and a split;
  - a budget with rollover, a goal, a detected subscription, housing config + an obligation, a credit score;
  - notes in each privacy tier, a habit with logs, a todo with subtasks, a job listing.
- **Console errors.** Fail on `console.error`, not just `pageerror`. Tolerated entries go in the existing shrinking `KNOWN_GAPS` map with a reason.
- **Click sweep.** On each page, click every visible enabled control that neither navigates off-app nor destroys data. Skip controls marked with a `data-e2e-skip` attribute on destructive buttons (Delete / Unlink / Send / Empty trash / Sign Out). Fail on a page error, a console error or a non-501 5xx triggered by the click.
- **Bugs the sweep exposes** are recorded as `KNOWN_GAPS` entries and follow-ons. They are not fixed in this batch (Batch 15 rule: test-only batch, fix separately), unless the fix is a one-line wiring error in the code the sweep exercises.

**ST3.**
- Fold Per-sistant's "disable the button while pending" pattern into one shared helper in `apps/per-sistant/views/js.js`, `withPending(btn, key, fn)`: `guardPending` + `disabled` + `aria-busy`, restored in `finally`.
- Migrate the hand-rolled call sites in `pages/*.js` (about 27 `guardPending` / `disabled` sites today). Remember the template-literal escaping gotcha (INV-97) and `node --check` the emitted bundle.
- A guard test fails on a NEW hand-rolled pending toggle around a write (shrinking KNOWN_GAPS).

**Tests.** Playwright: the new specs. Node: the ST3 guard and `withPending` run in a vm.

**Operator.** None.

---

## After Batch 20
Cycle 7's planned work is then complete. Run `/reflect` to close the cycle (metrics, PROJECT_HEALTH synthesis, policy check).
