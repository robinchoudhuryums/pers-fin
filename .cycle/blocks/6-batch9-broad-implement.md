---BROAD SCAN IMPLEMENTATION SUMMARY---
Findings implemented:
- PSC-4: the shell session, WebAuthn challenge and Perfin session cookies are Secure behind TLS even without NODE_ENV. A shell error handler means no stack traces, including before auth. NODE_ENV=production is set at runtime in the Dockerfile and fly.toml.
- PSC-11: boot fails fast without SHELL_SECRET, and a login can no longer crash the process.
- PSC-14: a global PIN failure ceiling (30 per hour across all IPs) locks PIN login for 30 minutes and alerts the operator once. Boot warns when SHELL_PIN is shorter than 6 characters.
- PSC-7: the shell body limit is now 1mb (was 64kb, which overrode Per-sistant's 1mb).
- PSC-9: return_to is carried through login: the 302, the hidden form field, failed re-renders, GET /login and the biometric path.
- PSC-8: Perfin's general limiter is skipped when embedded, and the tight limiter skips GETs (the reconcile-status poll).
- PSC-13: chk_account_source and chk_personal_for are rebuilt only when missing or outdated, not on every boot.
- PSC-6: reset-fresh now wipes investment_flows, payee_obligations, payee_payments and settlements; a test classifies every migrated table.
- PSC-15:
  - the shell declares express-rate-limit and @simplewebauthn/server;
  - a stale comment is fixed;
  - csv-import.yml gets `contents: write` and removes CSVs instead of archiving them in the tree;
  - bounded settings return 400, including an invalid keep_alive_timezone.
- PB-14: the SSRF check uses node's built-in CIDR list (net.BlockList) with IPv4-mapped/compatible IPv6 unwrapped, checks DNS resolution at send time, and sends never follow redirects.
- PB-15: Perfin's HMAC-signed webhook passes Per-sistant's standalone auth and the shell's cookie gate (POST, that exact path only).
- PB-21: the embedded Per-sistant "Log Out" posts the root /logout and is shown whenever embedded.
- WD-16: standalone Perfin "Sign Out" posts /api/logout (root /logout stays the embedded path).

Files modified:
shell/index.js, shell/middleware/auth.js, shell/middleware/webauthn.js, NEW shell/middleware/error-handler.js,
shell/views/login.ejs, shell/package.json, package-lock.json, Dockerfile, fly.toml, render.yaml (comment only),
teller/server.js, teller/services/database.js, teller/routes/settings.js, teller/views/settings.ejs,
teller/pages/login.js (comment), scripts/reset-fresh.js, .github/workflows/csv-import.yml,
apps/per-sistant/config.js, apps/per-sistant/helpers.js, apps/per-sistant/middleware.js,
apps/per-sistant/pages/settings.js, apps/per-sistant/pages/settings-script.js,
tests/ui-polish.test.js (test double), NEW tests/scan-sept-batch9.test.js, NEW apps/per-sistant/tests/scan-sept-batch9.test.js

CHANGES:
PSC-4 | shell/middleware/auth.js, webauthn.js, error-handler.js, index.js, teller/server.js, Dockerfile, fly.toml, render.yaml | cookieSecure(req) = NODE_ENV==='production' OR req.secure (trust proxy is set). The WebAuthn challenge cookie does the same. Perfin's session cookie uses secure:'auto'. The shell error handler is mounted last and returns status plus a short message ("Malformed request body." / "Request body too large." / generic), logs 5xx, and never sends the stack. `ENV NODE_ENV=production` is placed AFTER the Docker install; fly.toml sets it in [env]. render.yaml deliberately leaves it unset (Render passes envVars to the build, which would change the install) and explains why.
PSC-11 | shell/index.js, auth.js | start() throws before the sub-apps start if SHELL_SECRET is unset. handleLogin wraps the cookie set in try/catch and renders a 500 instead of an unhandled rejection. Boot warns on a missing or short SHELL_PIN.
PSC-14 | auth.js, index.js | In-memory sliding window: 30 failed PINs per hour across all IPs → PIN login locked 30 min. A correct PIN is also refused while locked (429); biometric and x-api-key access are unaffected. One onLockout callback per lockout → sendToAll "PIN login locked" (tag pin-lockout). A restart clears the counter.
PSC-7 | shell/index.js | express.json and urlencoded limits are now 1mb.
PSC-9 | auth.js, index.js, login.ejs | requireAuth redirects a GET html request to /login?return_to=<safeReturnTo(originalUrl)>; plain /login for / or the default. loginReturnTo() echoes only safe, non-default targets into a hidden field: GET /login, failed or locked re-renders, and a valid session goes straight there. The biometric success path navigates to it.
PSC-8 | teller/server.js | generalLimiter skip: embedded. tightLimiter skip: GET (the only GET under its prefixes is /api/sync/reconcile/status).
PSC-13 | teller/services/database.js | DO-blocks: chk_account_source is rebuilt only when missing or its definition lacks is_manual; chk_personal_for is added only when missing.
PSC-6 | scripts/reset-fresh.js | Four tables added to WIPE_TABLES. New UNTOUCHED_TABLES (schema_migrations, job_runs, benchmark_prices). Pool creation and the env check moved under require.main so the lists are exported and testable.
PSC-15 | shell/package.json (+lock, 2 lines), teller/pages/login.js, csv-import.yml, teller/routes/settings.js | Dependencies declared. Comment now points to the shell WebAuthn. Workflow `permissions: contents: write`; processed CSVs are `git rm`'d rather than moved to csv-uploads/processed/. Settings: keep_alive_start/end, keep_alive_timezone (Intl-validated), auto_sync_interval_hours, csv_reminder_days and weekly_digest_day now return 400 with strict integer parsing (null / "" / "6abc" rejected).
PB-14 | apps/per-sistant/config.js, helpers.js | isPrivateAddress (net.BlockList: 0/8, 10/8, 100.64/10, 127/8, 169.254/16, 172.16/12, 192.0.0/24, 192.168/16, 198.18/15, 224/4, 240/4, ::/96, 64:ff9b::/96, fc00::/7, fe80::/10, ff00::/8; mapped IPv4 unwrapped). isValidWebhookUrl now rejects literal private IPs in any spelling. The new async resolveSafeWebhookTarget rejects a name if ANY resolved address is private and fails closed on DNS error. sendWebhook and sendSlackNotification use it and fetch with redirect:'manual'.
PB-15 | apps/per-sistant/middleware.js, shell/middleware/auth.js | `POST /api/perfin/webhook` is exempt from the session check (requireAuth is now exported for tests). The shell requireAuth lets `POST /per-sistant/api/perfin/webhook` through, because the receiver verifies its own HMAC and replay window.
PB-21 | apps/per-sistant/pages/settings.js, settings-script.js | The Session section renders when AUTH_SECRET is set OR the app is embedded. logout(): when embedded, POST location.origin + '/logout' (absolute, so BASE_PATH isn't prefixed) → /login; standalone is unchanged.
WD-16 | teller/views/settings.ejs | logout() posts /logout when window.BASE_PATH is set, /api/logout otherwise.

TEST RESULTS: passed. npm test 1490/1490 (Perfin 945 + Per-sistant 545; 60 files).
- New test files:
  - tests/scan-sept-batch9.test.js (37 tests): behavioural tests against the real shell auth module, error handler and settings router, plus the extracted logout().
  - apps/per-sistant/tests/scan-sept-batch9.test.js (27 tests): SSRF matrix, stubbed DNS and fetch through the real senders, requireAuth, the extracted logout(), and the rendered settings page.
- Old-code worktree run: the Perfin/shell file fails 8 of 8 suites. The Per-sistant file fails 18 of 27; the 9 that pass are deliberate guards on existing behaviour.
- Test double updated: ui-polish biometric redirect pin.
- Real Postgres:
  - migrations ×2;
  - re-running migrations leaves both constraints untouched (same xmin), and missing or outdated ones are rebuilt;
  - reset-fresh dry run lists the new tables, and --yes clears them while keeping schema_migrations.
- e2e 8/8.
- Live booted shell:
  - the deep-link 302 carries return_to;
  - malformed JSON returns a 400 JSON error;
  - login with return_to lands on the target;
  - Set-Cookie is Secure with X-Forwarded-Proto;
  - GET /login renders the hidden field;
  - the webhook reaches its receiver (503: no secret configured).
- The emitted Per-sistant settings bundle passes node --check.

REGRESSION RISKS:
- PSC-14: anyone can lock PIN login for 30 minutes by sending 30 wrong PINs within an hour (biometric and API key still work). This is the accepted price of a ceiling. A restart clears it.
- PSC-11: a deployment without SHELL_SECRET no longer boots. Before, it booted but every login failed.
- PSC-8: embedded requests (cookie or valid API key) have no per-IP general cap. Credential guessing is still capped at the shell.
- PB-15: the shell now parses (≤1mb) and forwards one unauthenticated POST path. The receiver HMAC-verifies it and returns 503 without a secret.
- PB-14: a webhook endpoint that answers with a redirect (e.g. http→https) is now recorded as a 3xx failure instead of being followed. Each send now does a DNS lookup (a DNS outage skips the send). A DNS-rebinding race between our lookup and fetch's own is still possible.
- PSC-15: clearing the CSV-reminder-days input in Settings now shows a 400 error toast instead of silently keeping the old value.
- PSC-6: reset-fresh now also clears the rent ledger and settle-up marks. This is intended, because housing_config is wiped with them.

INVARIANTS AT RISK: None.
- INV-21: safeReturnTo now guards both the inbound return_to and the redirect.
- INV-20: x-api-key is still checked first.
- INV-60: embedded Sign Out is unchanged.
- INV-62: shell helmet is unchanged; the error handler is added after it.
- INV-17: migrations still run in one transaction.
- INV-59: extended to the remaining bounded settings.
- INV-25: embedded requests still skip per-app auth.
- New invariant candidates: a global PIN ceiling and a resolving SSRF check with no redirects.

NET SCORE:
- Fired in production this month:
  - YES: PSC-4 (if the Render dashboard doesn't set NODE_ENV), PSC-9, PSC-8, PSC-13.
  - NO: PSC-11, PSC-14, PSC-7, PSC-6, PSC-15, PB-14, PB-15, PB-21, WD-16.
- New failure modes: 1 (the attacker-triggered 30-minute PIN lockout, documented).
- Score: 4 − 1 = 3.

OPERATOR ACTIONS / DEPLOY:
- Make sure SHELL_SECRET is set in every environment (Render already has it). The shell now refuses to boot without it. | BLOCKS DEPLOY: N (already set on Render; blocking only for an environment that lacks it)
- Optional: if SHELL_PIN is under 6 digits, rotate it to 6 or more (boot logs a warning). | BLOCKS DEPLOY: N
- Optional: CSVs already committed under csv-uploads/processed/ stay in git history; scrub them with git filter-repo if wanted. | BLOCKS DEPLOY: N
Deploy: Platform, Shell & Auth — Render auto-deploys on push to `main` (alt: `fly deploy`).

FOLLOW-ON ITEMS:
- PSC-13 residual: every `ALTER TABLE … ADD COLUMN IF NOT EXISTS` still takes a brief ACCESS EXCLUSIVE lock on each boot. A concurrent open reader still blocks the boot migration (verified on real PG). The constraint full-table rescans are gone. Fix: gate the ADD COLUMNs on information_schema, or move them under schema_migrations versioning.
- Per-sistant's own session cookie (middleware.js) still uses `secure: NODE_ENV==='production'`. It wasn't in PSC-4's Where list and is unused under the shell.
- PSC-4 EJS view cache: Render still runs without NODE_ENV, so views recompile per render (performance only).
- The PIN-failure ceiling is per-process and in memory. A multi-instance deploy would need shared state; this app is single-process.
- A stolen stateless shell cookie stays valid until idle expiry even after Sign Out (noted in PSC-14, not fixed: it would need server-side session revocation).

DOCUMENTATION UPDATES NEEDED:
- CLAUDE.md Security / UI & UX auth:
  - global PIN ceiling and lockout alert;
  - SHELL_SECRET fail-fast and minimum PIN length;
  - Secure cookie via req.secure;
  - shell error handler (new file shell/middleware/error-handler.js, Platform subsystem);
  - return_to carried through login;
  - webhook exemption at both gates.
- CLAUDE.md:
  - rate-limit bullet (general skipped when embedded, tight skips GET);
  - shell body limit 1mb;
  - csv-import workflow behaviour;
  - reset-fresh table lists (WIPE/KEEP/UNTOUCHED);
  - Logout bullet (W2/INV-60: standalone uses /api/logout; Per-sistant embedded logout);
  - settings 400s under INV-59;
  - Dockerfile/fly NODE_ENV;
  - test counts 1490/60 (Perfin 945 + Per-sistant 545);
  - new invariant candidates (PIN ceiling, resolving SSRF).
- apps/per-sistant/CLAUDE.md:
  - Webhooks/SSRF bullet (CIDR + mapped IPv6 + DNS resolution + redirect:'manual');
  - webhook auth exemption;
  - embedded Log Out;
  - test count 545.
---END BROAD SCAN IMPLEMENTATION SUMMARY---
