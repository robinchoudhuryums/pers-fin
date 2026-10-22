---SEAMS & INVARIANTS AUDIT #3 SUMMARY---
Date: 2026-10-22 (after cycle 7 + roadmap T1.4 / T1.5; counter was 3 — due)
Scope: four parallel read-only reviews — cross-app (shell ↔ Perfin ↔ Per-sistant: auth,
webauthn, digests, Knowledge finance grounding, shutdown), client ↔ server (Perfin + Per-sistant
pages vs their routes, service workers), ops (workflows, deploy/vps, Docker/Fly/Render), shared
sources of truth + mounts (financial-queries copies, route shadowing over 190 routes, export
resolution, scheduler/state maps, reset-fresh, single-flight/locks). Every finding re-verified
against the code before fixing.

FIXED (code):
X1  | High | teller/pages/login.js, teller/services/webauthn-ids.js (new), database.js | registration
      stored Buffer.from(credential.id).toString("base64url") — credential.id is ALREADY base64url in
      @simplewebauthn v11 — so no stored id matched an authenticator: allowCredentials named nothing
      the device held (the "use a phone" QR) and verify always missed. Stored as given now; the
      migration's repairCredentialIds rewrites double-encoded rows (drops a stale duplicate). New INV-136.
C1  | Medium | enrollments.js GET /api/items | manual accounts grouped into one null "plaid" item whose
      Add accounts / Unlink buttons answered 400 / 500 → WHERE teller_enrollment_id OR plaid_item_id.
O1  | Low | knowledge-reindex.yml | a 409 polled an idle/stale state → skip_wait step output.
O2  | Low | enrollments.js | the background reconcile's error carried exception text (INV-127/103) →
      fixed sentence; errors[] names provider + institution only.
O3  | Low | knowledge-reindex.yml | a failed reindex printed the status JSON (repo, paths, errors) →
      a count line only (INV-103).
S1  | Low | enrollments.js, startup.js | reconcile ignored the one-at-a-time contract: a synchronous
      call or the weekly in-process heal ran next to a background one (duplicate 90-day Teller
      re-fetch / Plaid re-walk) and a synchronous run wrote the job slot → withReconcileGuard +
      reconcileBusy: either route 409s, the heal skips, only a background run writes the slot.
S2  | Medium | insights.js seasonal | rolling CURRENT_DATE − 24 months bound left the oldest month
      partial (a false "seasonal jump" in the prompt) → $1::date − 24 months.
S3  | Low | investments.js | rows inserted by the link exchanges / update-complete skipped rename
      rules until a later sync added a row → renameNewRows after each single-Item sync.
S4  | Low | enrollments.js recordSyncResult | read-merge-write could drop a concurrent recorder's
      providers (INV-68) → writes serialized on a promise chain.
S5  | Low | insights.js GET /api/tax-deductions | default year from the server clock → APP_TIMEZONE
      (the timezone lint now also catches new Date().getFullYear()).
S6  | Low | startup.js goal milestones | re-derived progress in SQL (a balance-less funding account
      read $0) → deriveGoalProgress (INV-11).
X2  | Low | apps/per-sistant/routes/rag.js | upcoming charges measured from now (today's charge
      dropped once the day began; toISOString shifted a day) → APP_TIMEZONE calendar dates via ymdOf.
X3  | Medium | teller/routes/persistent.js | the in-process digest recipient stopped at the first SET
      value — a display-form SMTP_FROM made every digest a draft → first VALID address, checked with
      Per-sistant's own EMAIL_REGEX.
X6  | Low | error-log.js, shell/index.js | the shutdown flush was a no-op while a periodic flush wrote
      (up to a minute of errors lost) → flush({ drain: true }) waits for it.
C4  | Low | whats-new.js | balance rows lacked source_id ("Account #undefined" links) → added.
C5  | Low | apps/per-sistant/routes/pwa.js | the SW cached a redirected (login page) response as API
      data → r.ok && !r.redirected, cache v9 (Perfin F107 parity).
INV-104 | Low | teller/server.js (standalone x-api-key), apps/per-sistant/routes/auth.js (standalone
      /api/login) | raw-buffer compares → SHA-256 digest compares.
Docs/comments | RUNBOOK permissions + restore drill as root + /health/deep; .env.example step ref;
      backup.sh, fly.toml, keep-alive.yml, shell keep-alive comment; CLAUDE.md insight-email /
      productivity-context / legacy webhook list / spending-summary / /api/sync/status / INV-48/50/53/
      104/117/127 wording; Per-sistant CLAUDE.md SW cache + four email events.

New guards: SX3 now pins all five SPLIT CASE copies in sheets-sync.js; the literal-CASE scan covers
teller top level / data / pages and scripts/; the timezone lint matches new Date().getFullYear().

INVARIANTS (code-read): INV-07, 11, 14, 18, 19, 23, 48, 60, 61, 62, 67, 68 (logic), 73, 81, 105, 110,
121, 122, 129 PASS; INV-104 FAIL → fixed; INV-127 FAIL (reconcile) → fixed; INV-103 FAIL (reindex) →
fixed; INV-117 wording drift (older pages check r.ok themselves) → reworded + follow-on; INV-50 had a
second cause (X1) → noted, INV-136 added.

SEAMS CLEAN: net worth (3 writers on getNetWorth), budget status, refunds, timezone month anchors,
route mounting (no shadowing over 190 routes), export resolution, single-flight + Plaid lock, shell
heartbeat wiring, away vs gated jobs, reset-fresh classification.

TESTS: npm 1915/1915 (+25: tests/seams-audit-3.test.js 18, apps/per-sistant/tests/seams-audit-3.test.js
6, SX3 all-copies 1); contract 167/167 (+2: tests/contract/seams3.contract.test.js); migrations twice
on an empty database OK; Playwright 57/57. Mutation checks: no reconcile guard / unserialized
recordSyncResult turn 3 pins red; no items WHERE turns the contract red.

FOLLOW-ONS (CLAUDE.md Known Open Issues): X5 epoch fail-open at boot without a database; weekly heal
vs weekly-reconcile.yml 409 with id null; /api/plaid/sync-transactions + reconcile legs don't stamp
freshness; C3 standalone PERFIN_URL rent link; O4 csv-import Google key content vs path; O5 Docker
TELLER_CERT_CONTENT permissions; reset-fresh clears last_backup_at / operator_checks_signature;
Per-sistant /api/calendar server-clock defaults; the timezone lint misses a Date assigned first;
older Per-sistant pages off writeOk.

OPERATOR ACTIONS: none. Existing passkeys are repaired by the migration on deploy (no
re-registration needed). | BLOCKS DEPLOY: N
Deploy: Render auto-deploys on push to `main` (PR robinchoudhuryums/pers-fin#133).
---END SEAMS & INVARIANTS AUDIT #3 SUMMARY---
