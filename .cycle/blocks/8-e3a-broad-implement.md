---BROAD SCAN IMPLEMENTATION SUMMARY---
Findings implemented: None (expansion batch)
New capabilities (G/ST): G2 (part 1 of 3) — E3a: the notification-kind catalog, quiet-hours and mute settings with validation, and the notification_log columns delivery will write; no delivery change yet
Files modified: teller/services/notify-prefs.js (new), teller/services/database.js, teller/routes/settings.js, tests/cycle8-e3a.test.js (new)

CHANGES:
G2 (E3a) | teller/services/notify-prefs.js | NOTIFY_KINDS — 15 user-facing kinds (spending, cash, bills, plan, goals, accounts, system, tasks, habits, knowledge, jobs, email, security, test, other) each with its Perfin tags / tag prefixes and Per-sistant check types; kindOf(tag) (exact, then longest prefix, else "other" — mutable) / kindOfCheckType(type) (housing_due → bills, the same kind as Perfin's rent push); catalog(); normalizePrefs(row) (defaults, JSON strings, unknown / unmutable kinds dropped); isQuiet(now, quiet, tz) on the APP_TIMEZONE wall clock (end before start wraps past midnight; start inclusive, end exclusive; an invalid zone reads UTC); decide({ kind, prefs, now, tz, covered }) → muted → covered → held → sent (security and test never muted or held); parseQuietHours / parseMutedKinds for PATCH
G2 (E3a) | teller/services/database.js | user_settings.notify_quiet_hours JSONB (default off, 22:00–07:00) + notify_muted_types JSONB (default []); notification_log.push_state TEXT (its CHECK list sent / held / muted / covered / none / expired in CHECK_LISTS, so syncInListChecks keeps it in step) + item_key TEXT — both NULL until E3b / E3d write them
G2 (E3a) | teller/routes/settings.js | PATCH /api/settings: notify_quiet_hours ({ enabled boolean, start / end HH:MM, start ≠ end, no other keys; null → default) and notify_muted_types (known mutable kinds, deduped; null → []) — 400 with nothing written otherwise; GET returns both normalized plus notify_kinds (the catalog) and notify_timezone

TEST RESULTS: npm test 3036/3036 (20 new in tests/cycle8-e3a.test.js — incl. a source scan that every tag literal a notification is sent with, and every Per-sistant check type, maps to a named kind). Contract 309/310 (cash-alerts-l2, date-dependent, pre-existing). Migrations run twice on a scratch Postgres: defaults present, push_state CHECK refuses an unknown value (23514). e2e not run (no page or boot-order change; the columns are additive).
REGRESSION RISKS: None for delivery — nothing reads the new settings or columns yet. GET /api/settings carries four more fields; PATCH's RETURNING * returns the raw columns.
INVARIANTS AT RISK: INV-59 (bounded settings reject with 400) — kept, both new fields are strictly validated. INV-17 (migrations; CHECK_LISTS) — the new IN-list CHECK is in CHECK_LISTS as F31 requires.
NET SCORE: 0 production fixes − 0 new failure modes = 0 (one new capability, groundwork)

OPERATOR ACTIONS / DEPLOY:
- None
Deploy: Platform, Shell & Auth: Render auto-deploys on push to `main`.

FOLLOW-ON ITEMS:
- The kind is decided by tag prefix; a caller whose tag doesn't follow an existing prefix lands in "other" until the catalog names it (the scan test catches literal tags, not tags built entirely at runtime).
- The settings have no UI yet (E3c) and change no delivery yet (E3b).

DOCUMENTATION UPDATES NEEDED:
- CLAUDE.md: teller/services/notify-prefs.js in the architecture list (and Settings, Notifications & Cross-app subsystem); the two user_settings columns and notification_log.push_state / item_key in Database; PATCH /api/settings' two fields; CHECK_LISTS gains notification_log.push_state; the test count.
---END BROAD SCAN IMPLEMENTATION SUMMARY---
