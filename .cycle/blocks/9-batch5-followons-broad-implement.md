---BROAD SCAN IMPLEMENTATION SUMMARY---
Findings implemented (the seven follow-on items of `.cycle/blocks/9-batch5-broad-implement.md`, numbered in its order):
- FO-1 — the dashboard's Debt Payoff mode no longer stores today's debt as the baseline when its settings read fails
- FO-2 — a retry that gives up is `failed` ("Push failed — not delivered") in the bell, not "Held for quiet hours — not pushed"
- FO-3 — a failed push of a kind quiet hours never hold (a PIN lockout) is retried during quiet hours, not after them
- FO-4 — a push error that won't pass (400 / 401 / 403 / 413, an unreadable stored subscription) is not retried; 408 / 429 / 5xx / network errors still are
- FO-5 — a held push stores when its quiet hours end (`hold_until`); the 12-hour limit counts from the later of that and the end by today's settings
- FO-6 — Per-sistant's `PATCH /api/settings` validates its switches, hours, zone, timeout, horizon and layout; its Settings page and dashboard no longer save over settings they couldn't load
- FO-7 — with several months owed, a showing task for ANY unpaid month covers Perfin's rent push and hides Per-sistant's rent line
New capabilities (G/ST): None
Files modified:
- teller/routes/notifications.js
- teller/services/database.js (CHECK_LISTS: push_state gains `failed`; new column notification_log.hold_until)
- teller/views/partials/nav.ejs
- teller/routes/housing.js
- teller/views/dashboard.ejs
- apps/per-sistant/routes/settings.js
- apps/per-sistant/routes/housing-due.js
- apps/per-sistant/pages/settings-script.js
- apps/per-sistant/pages/dashboard-script.js
- tests/cycle9-b5-followons.test.js (new, 28 tests)
- apps/per-sistant/tests/cycle9-b5-followons.test.js (new, 16 tests)
- tests/contract/c9-batch5-followons.contract.test.js (new, 8 tests)
- tests/cycle8-e3a.test.js, tests/cycle8-e3b.test.js, tests/cycle8-e3d.test.js, tests/cycle9-b5.test.js (doubles and pins that encoded the old SQL / behaviour)
- .cycle/STATE.md, .cycle/blocks/9-batch5-followons-broad-implement.md

CHANGES:
FO-1 | teller/views/dashboard.ejs | The Debt Payoff mode returns "Your settings couldn't be loaded — reload to see your progress" when `GET /api/settings` isn't ok, before any write. It used to read the failure as "no baseline yet" and PATCH today's debt as the baseline.
FO-2 | teller/routes/notifications.js, teller/services/database.js, teller/views/partials/nav.ejs | New push_state `failed` (in CHECK_LISTS). The release job marks a stale `held` row `expired` and a stale `retry` row `failed`, each with its own UPDATE. The bell says "Push failed — not delivered".
FO-3 | teller/routes/notifications.js | An in-memory `urgentRetry` flag: set when a push of a kind with `bypassQuiet` is marked `retry`, true at boot, cleared when a run finds none. `releaseDue` is `heldPending && (urgentRetry || now >= releaseNotBefore)`. During quiet hours the release job, when the flag is set, reads only `retry` rows, keeps those whose kind bypasses quiet hours and pushes them; everything else waits for the end as before. A never-held kind's 12 hours count from its creation.
FO-4 | teller/routes/notifications.js | `passingPushError(err)`: no HTTP status, 408, 429 or 5xx can pass; any other 4xx can't. `pushToSubscribers` counts the second kind (and a stored subscription that can't be read) in `lasting`; `pushFailedEverywhere` leaves `gone` and `lasting` out, so those end as `none` with a logged error instead of a 12-hour retry. The subscription is kept (only 404 / 410 prune it).
FO-5 | teller/routes/notifications.js, teller/services/database.js | New column `notification_log.hold_until TIMESTAMPTZ`, written by sendToAll when a push is held. `holdWindowEnd(row, prefs)` is the later of the end computed from today's settings and the stored one; a row with no stored value (held before this change) is judged as before.
FO-6 | apps/per-sistant/routes/settings.js | `keep_alive_enabled`, `vault_enabled`, `job_radar_enabled` take only true / false — a 400 before any query (`"false"` used to switch them on). `keep_alive_start` / `_end` are integers 0–23 (no silent 0), `keep_alive_timezone` a real IANA zone, `session_timeout_minutes` an integer 1–1440, `default_horizon` one of short / medium / long, `dashboard_layout` `{ widgets: [ids], hidden: [ids] }` or null.
FO-6 | apps/per-sistant/pages/settings-script.js, apps/per-sistant/pages/dashboard-script.js | The Settings page checks the settings response; after a failed load the general, Slack, vault and keep-alive saves send nothing and the page says "Your settings couldn't be loaded — reload the page before changing anything." The dashboard saves a layout change only after its layout loaded (Reset still saves, since it replaces the layout on purpose).
FO-7 | teller/routes/housing.js, teller/routes/notifications.js | The unpaid-balance read also returns every unpaid month. The rent push carries `cover_items` (the other unpaid months' items); `itemCovered` takes a list and is true when any has a showing task. The list is kept in the log row's `data.cover_items` so a held push is checked the same way at release, and is never part of the pushed payload. The row's `item_key` stays the oldest month's.
FO-7 | apps/per-sistant/routes/housing-due.js | The read also returns every unpaid month; `housingDueUnlessTask` hides the line when its own item or any other unpaid month has a showing task. A task for a month that isn't owed still never hides it. `housingDue`'s result is unchanged.

TEST RESULTS: passed.
- `npm test`: 3454 / 3454 (44 new; 185 test files; Perfin 2685, Per-sistant 769).
- Route contract suite on a local Postgres 16: 378 / 378 (8 new).
- Playwright: 93 / 93.
- `scripts/ci-migration-test.js` (both apps' migrations twice on fresh databases): passed.
- The two new unit files and nine neighbouring files under five shifted clocks (2026-12-31, 2027-01-31, 2027-03-14, 2027-11-07, 2028-02-29): 263 / 263 each. The contract file was not run under a shifted clock (the database keeps the real date).
- Mutation check: against the pre-fix source the new files fail 27 of 28 (Perfin unit), 10 of 16 (Per-sistant unit) and 8 of 8 (contract).
- Regression scenarios: S4 (embedded auth gate + cross-pool wiring) — PASS by the contract suites that wire both pools and the e2e run; S1, S2, S3, S5, S6, SK1–SK5 — not applicable to the files changed.

REGRESSION RISKS:
- A push refused with a 4xx other than 404 / 408 / 410 / 429 is no longer retried. If a push service ever answers 403 for a passing condition, that push is lost (it is in the bell, and the error is logged).
- With two or more months owed, ticking off the oldest month's task by hand no longer brings the rent push back while a later unpaid month's task is showing. Before, the push resumed (cycle-8 E3d's rule, which looked at one month).
- A failed PIN-lockout push now makes the notify-release job run, and report a failed run, every 15 minutes during quiet hours until it gets through or 12 hours pass.
- Per-sistant: a client that sent `1`, `"true"` or `"false"` for a switch, a non-integer or out-of-range hour, or a layout of another shape now gets a 400. The app's own pages send valid values.
- Per-sistant: after a failed settings load the Settings page refuses all four forms (theme included) until a reload; the dashboard shows layout changes on screen but does not save them.
- A hold whose quiet hours were shortened after it was held keeps the later recorded end as its base, so it can be pushed up to 12 hours after that recorded end rather than after the new, earlier one.
- After a restart during quiet hours the release job makes one extra read of `notification_log`.

INVARIANTS AT RISK: None broken. Wording to update at /sync-docs: INV-153 (`failed`; a never-held kind's retry runs during quiet hours; errors that won't pass aren't retried; the hold's recorded end; cover across unpaid months), INV-59 (Per-sistant's settings route now follows the same strict rules). INV-17 holds (the new column is `ADD COLUMN IF NOT EXISTS`; the CHECK value went into CHECK_LISTS; both migrations re-run cleanly). INV-77 holds (the release gate is still in memory). INV-97 holds (no single-escaped regex added to a client template literal; the emitted bundles parse). INV-106 holds (no bare catch added to server code).
NET SCORE: 0 − 2 = −2
- Production fixes this month: 0. Each needs an event I can't see in production: a failed settings read (FO-1, FO-6), a push-service failure (FO-2, FO-3, FO-4), quiet hours changed while a push was held (FO-5), two months of rent owed with the older task ticked off by hand (FO-7).
- New failure modes: 2 — a push refused with a 4xx is dropped rather than retried (Low); with several months owed, a hand-completed oldest task no longer resumes the rent push while a later month's task shows (Low).

OPERATOR ACTIONS / DEPLOY:
- None required. | BLOCKS DEPLOY: N
Deploy: Settings, Notifications & Cross-app / Financial Analytics / Web UI / Per-sistant Backend / Per-sistant Web UI — Render auto-deploys on push to `main` (this work is on `claude/gracious-maxwell-li0vm7`; no PR opened). The boot migration adds `notification_log.hold_until` and `failed` to the push_state CHECK.

(Not complete in production until blocking operator actions are done AND
the deploy step is confirmed.)

FOLLOW-ON ITEMS:
- The Debt Payoff mode still reads a failed `/api/accounts` as "no debt" and shows 100% paid off (display only — nothing is written).
- A push dropped for a lasting error is visible only in Settings → Sync Health → Recent errors and as "none" in the data; the bell doesn't mark it, and nothing tells the user which device to re-register.
- Per-sistant's Settings page blocks the theme change too after a failed load (the theme is one field of the general form).
- `vault_branch` and `slack_webhook_url`'s type are still not checked beyond what was there (a non-string branch is stringified).
- `hold_until` is whole minutes from the send, so it can be up to a minute past the hour.
- The cover list for a held rent push is the unpaid months at send time; a month that became unpaid (or paid) while it was held isn't re-read at release.

DOCUMENTATION UPDATES NEEDED:
- CLAUDE.md: the notifications.js tree entry and the Web Push / notification-center sections (`failed` and its bell wording, errors that won't pass, the urgent retry during quiet hours, `hold_until`, `cover_items`); the housing.js entry and the Rent & Utilities reminder text (cover across unpaid months); the Per-sistant tasks paragraph ("one item, one alert" across unpaid months); Database (`notification_log.push_state` gains `failed`; `hold_until`); the dashboard Debt Payoff note; the cycle-9 Known Open Issues entry (Batch 5's follow-ons closed, the new follow-ons); the test list (tests/cycle9-b5-followons.test.js, apps/per-sistant/tests/cycle9-b5-followons.test.js, tests/contract/c9-batch5-followons) and counts (3454 tests, 185 files, Perfin 2685, Per-sistant 769; contract 378); INV-153 and INV-59 wording.
- apps/per-sistant/CLAUDE.md: the `PATCH /api/settings` rules (and the Known Open Issues line about `session_timeout_minutes` / `default_horizon`, now closed), the Settings / dashboard load guards, the housing-due entry (every unpaid month), the linked-tasks paragraph, the new test file, the test count (769).
- README: test counts.
---END BROAD SCAN IMPLEMENTATION SUMMARY---
