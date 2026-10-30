# Cycle 8 E4 — operator and freshness visibility (plan, 2026-10-30)

Status: PLANNED — E4a, E4b.

Scope: ST5 and G3 from the cycle-8 expansion plan (`.cycle/plan-cycle8-expansion.md`).

Goal: before go-live, Settings → Sync Health → Operator Checks says whether this deployment is set up
right, without a GitHub token (ST5); and the nav's "Synced Xm ago" badge tells the truth about how fresh
the bank data is now that webhooks sync one connection at a time (G3).

## What exists (read for this plan)
- **Operator checks** (`teller/services/operator-checks.js`): `getOperatorChecks` = the GitHub checks
  (need `GITHUB_OPS_TOKEN`) + `localChecks(env)` (the compromised Teller cert — only when a cert is
  configured; the token passphrase; SHELL_PIN length; info notes for UTC, no VAPID, no HEARTBEAT_URL, no
  CALENDAR_FEED_TOKEN) + `serverBackupCheck` (only with `SERVER_BACKUPS=true`) + `knowledgeCheck` +
  the bank-webhook checks (`webhook-status.webhookChecks` — info while PUBLIC_URL is unset, a warn while
  a Plaid Item isn't registered at it). `toIssues` puts warn / fail on the dashboard strip;
  `notifyIfChanged` pushes once per change in the failing set (INV-126).
- **What a fresh Render deployment can't see without a token:** whether any backup was ever taken (the
  only backup check is GitHub's, or the on-server stamp under SERVER_BACKUPS); whether the Teller cert is
  missing while Teller enrollments exist, or close to expiring; whether API_KEY / SHELL_SECRET are weak
  or missing (the backstop workflows need API_KEY); whether both apps share one database on purpose
  (`ALLOW_SHARED_DATABASE` — the shell refuses an accidental share at boot, F26); whether PUBLIC_URL is a
  usable https origin; whether the Plaid credentials match PLAID_ENV.
- **Backup stamp:** `user_settings.last_backup_at` is written only by `deploy/vps/backup.sh`.
  `.github/workflows/db-backup.yml` dumps, encrypts and verifies both databases with `NEON_DATABASE_URL`
  / `PERSISTENT_DATABASE_URL` in its env — it could stamp the same column, but doesn't. `npm run
  reset:fresh` clears the stamp (a seams-audit-#3 follow-on).
- **Nav badge** (`teller/views/partials/nav.ejs`): reads `GET /api/settings` and shows the newest of
  `last_auto_sync_at` / `last_txn_sync_at` / `last_balance_sync_at`, coloured by an inline style (6 h / 24 h),
  with a per-source tooltip; hidden at ≤640px. A webhook sync (T2.1 W3 / W5) stamps only that
  connection's `last_synced_at`, never the global stamps — so with webhooks on, the badge says "2d ago"
  while the data is minutes old; and one connection failing for days hides behind another's fresh sync.
- **Per-connection freshness already exists** in `gatherDataHealth` (`routes/settings.js`): each non-
  suspended Teller enrollment and non-CSV Plaid item with its `last_synced_at`, a NEEDS_REAUTH status for a
  Plaid re-auth code, and `ageInfo` levels (fresh < 6 h, aging < 24 h, stale). `GET /api/data-freshness`
  has the same thresholds over the global stamps only.

## Decisions (proposed; confirm at the first /broad-implement)
1. **Go-live checks are local and token-free** — a new `goLiveChecks({ pool, persistentPool, env, now })`
   in operator-checks.js (async; `localChecks` stays pure), each check `{ id, label, status, detail, fix }`
   and never a secret's value or length beyond "shorter than N":
   - `local:teller-cert` widened: Teller enrollments exist and no cert is configured → **fail**; the
     cert's `validTo` (node's `crypto.X509Certificate`, read in `tellerCertStatus`, cached) within 30 days
     → **warn**, past → **fail**; the compromised-cert fail stays first.
   - `local:databases` (under the shell only — a persistentPool is wired): distinct → ok;
     `ALLOW_SHARED_DATABASE=true` and the same database (`boot-checks.sameDatabase`) → **warn** ("settings
     and AI caps are shared"); standalone → omitted.
   - `local:public-url`: unset → info (webhooks off, email links from RENDER_EXTERNAL_URL or none); not
     `https:`, carrying credentials, a path or a query → **warn**; else ok with the origin shown.
   - `local:api-key`: unset → **warn** (the daily-sync / weekly-reconcile / Knowledge-reindex backstops
     can't reach the app); shorter than 24 characters → warn. `local:shell-secret`: shorter than 32 → warn.
   - `local:plaid-config`: PLAID_CLIENT_ID set without the PLAID_SECRET_* for PLAID_ENV → **fail**;
     PLAID_ENV sandbox while GOOD Plaid items exist → warn; Plaid not configured → omitted.
   - `local:teller-webhook-secret`: set but any comma-separated part shorter than 16 → warn (the
     present / absent case stays with webhooks:teller).
2. **The backup check works without a token** — db-backup.yml stamps `user_settings.last_backup_at` (and a
   new `last_backup_source` = `github`; backup.sh writes `server`) through `psql -q` AFTER both dumps are
   verified, printing nothing (INV-103). `serverBackupCheck` becomes `backupCheck`: it runs under
   SERVER_BACKUPS (as now) and also whenever the GitHub checks are off (no token), with the same 36 h rule
   — missing → **fail** "no backup has been recorded", older → fail, else ok naming the source. With a
   GitHub token and no SERVER_BACKUPS the GitHub backup check stays the only one (no duplicate row).
   `reset-fresh` keeps `last_backup_at` / `last_backup_source` (closes the seams-#3 follow-on).
3. **Data-health and the push follow automatically** — the new checks go through `toIssues` and
   `notifyIfChanged` like every other; the first deploy may push one "Operator checks: N need attention"
   (the failing set changed) — expected, said in the deploy notes.
4. **One connection-freshness definition** — `connectionFreshness(db, { now })` (new
   `teller/services/freshness.js`, the `ageInfo` thresholds moved there) → `{ connections[], overall }`:
   connections exactly as data-health lists them today; `overall` = the OLDEST active connection
   (`basis: 'connections'`, naming it) — a connection that is DISCONNECTED or NEEDS_REAUTH makes the
   overall level `stale` with `reason: 'reauth' | 'disconnected'`; with no connections (CSV / manual only)
   → the newest of the global stamps (`basis: 'global'`). gatherDataHealth and `GET /api/data-freshness`
   both call it (data-freshness gains `connections` + `overall`; its existing fields unchanged).
5. **The badge reads `overall`** — nav.ejs fetches `/api/data-freshness` (not `/api/settings`): text
   "Synced 12m ago" from `overall`, "Reconnect <bank>" when the reason is reauth / disconnected; colour by
   a level class (`.sync-fresh` / `.sync-aging` / `.sync-stale` in perfin-shared.css — no inline colour);
   the tooltip lists each connection's age; the badge becomes a link to `/settings#sync-health` through
   `withBase` with an aria-label saying the same; a failed load leaves it empty (as now). Still hidden at
   ≤640px.
6. **Out of scope**: a Per-sistant badge; changing the 6 h / 24 h thresholds; any check that needs the
   network (Teller / Plaid credential probes); a "go-live" grouping in the Operator Checks list (they sit
   with the other local checks); the dashboard strip's wording.

## Batches
| Batch | Scope | Est. | Status |
|-------|-------|------|--------|
| E4a | ST5: `goLiveChecks` (decision 1 — cert missing / expiry via an injectable cert reader, the database share, PUBLIC_URL shape, API_KEY / SHELL_SECRET strength, Plaid env ↔ secret, the Teller webhook secret's parts), wired into `getOperatorChecks`; the backup stamp (decision 2 — `last_backup_source` column, db-backup.yml's `psql` stamp after verification with nothing printed, `backupCheck` token-free, reset-fresh keeping the stamp); unit tests (each branch with an injected env / fake pool, no value or length ever in a detail, the workflow step's order and silence, reset-fresh's lists) and a contract test (the stamp read on the real schema, a fresh database failing the backup check without a token and passing after a stamp, a GOOD Plaid item under sandbox warning) | 4h | planned |
| E4b | G3: `services/freshness.js` `connectionFreshness` (decision 4) behind both gatherDataHealth and `/api/data-freshness`; the badge (decision 5) — nav.ejs on `/api/data-freshness`, level classes, the link, "Reconnect <bank>"; unit tests (the overall rule — oldest wins, reauth / disconnected stale, CSV and suspended left out, the global fallback — data-health's connections byte-for-byte unchanged, the route's shape, the badge run in a vm from nav.ejs: text, class, tooltip, link through withBase, a failed load) and a contract test (a webhook-synced item fresh while the global stamp is two days old → fresh; a second item 30 h old → stale naming it); e2e: the badge on the dashboard (seeded CSV-only → the global basis) linking to Sync Health | 2–3h | planned |

Order: E4a → E4b (independent; E4a first because it carries the deploy-time operator note). Total ≈ 6–7h.
Then E5 (ST4 — behaviour tests), then cycle 8's `/reflect`.

## Invariants
- INV-126 widened (E4a): the go-live checks read the environment and the databases only — never the
  network, never a secret's value — and are fail-soft per check.
- Proposed INV-154 (E4b): freshness has one definition — `connectionFreshness` behind Sync Health's
  connection list, `/api/data-freshness` and the nav badge; the badge never shows a fresher age than the
  oldest active connection's.

## Risks to watch
- New warn / fail checks change the failing set on the first deploy → one push; a check that warns on a
  healthy setup becomes a standing dashboard warning (cf. the SHELL_PIN one) — keep the thresholds to
  things that are really wrong.
- The db-backup stamp writes to the production database from a public repo's runner; the step must use
  the same secret already in the job, print nothing (`psql -q`, no `-c` echo of the URL), and run only
  after both `pg_restore --list` verifications passed.
- `crypto.X509Certificate` throws on a malformed PEM — `tellerCertStatus` must stay non-throwing (expiry
  unknown → no expiry finding).
- The badge's "oldest connection" can turn red for a bank that rarely changes (a quiet savings account
  synced cleanly but long ago) — `last_synced_at` stamps on every clean run, so only a connection that
  stopped syncing ages; the tooltip names it.
