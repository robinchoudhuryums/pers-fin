---BROAD SCAN IMPLEMENTATION SUMMARY---
Findings implemented: None (expansion batch)
New capabilities (G/ST): G2 (part 3 of 3 — G2 complete) — E3c: the Settings section for quiet hours and mutes, the bell naming a push that didn't go out, and Per-sistant's browser notifications following the same settings
Files modified: teller/views/settings.ejs, teller/views/partials/nav.ejs, apps/per-sistant/routes/notifications.js, apps/per-sistant/pages/dashboard-script.js, apps/per-sistant/pages/settings.js, e2e/pages.spec.js, tests/cycle8-e3c.test.js (new), apps/per-sistant/tests/cycle8-e3c.test.js (new)

CHANGES:
G2 (E3c) | teller/views/settings.ejs | Settings → Alerts & Notifications → Quiet Hours & Muting (#quiet-hours-section, before Cash Alerts): a labelled switch, two labelled time inputs + "Save times", the zone the times are read in (notify_timezone), and a checkbox per MUTABLE kind from GET /api/settings' notify_kinds, grouped Perfin / Per-sistant (Per-sistant's only under the shell; security and test never listed). renderNotifyPrefs fills it from loadSettings; onQuietToggle / saveQuietTimes send the whole window, onMuteToggle the full checked list — each one PATCH through writeOk, a refused or failed save puts the control back; an empty or equal pair of times is refused before any request. Wired through bindEvents (the mute list by delegation)
G2 (E3c) | teller/views/partials/nav.ejs | the bell's renderList adds the push's fate to the time line (PUSH_STATE_WORDS): "Held for quiet hours", "Held for quiet hours — not pushed" (expired), "Muted — not pushed"; sent / none / older rows unchanged
G2 (E3c) | apps/per-sistant/routes/notifications.js | GET /api/notifications/check reads Perfin's quiet hours + muted kinds through perfinPool (perfinNotifyPrefs — read-only, teller/services/notify-prefs.js required lazily; null standalone or on a failure, logged) and annotateNotify gives every entry `kind` and `notify` (false inside quiet hours unless the kind bypasses them, or for a muted kind; true with no prefs); the response adds `quiet`. Every entry is still listed
G2 (E3c) | apps/per-sistant/pages/dashboard-script.js | isImportantReminder returns false for notify:false — no browser notification and no ledger mark, so the next dashboard load after quiet hours end raises it; the Reminders widget still lists it
G2 (E3c) | apps/per-sistant/pages/settings.js | Browser Notifications says where quiet hours and muting are set — a link to Perfin's section, under the shell only
G2 (E3c) | e2e/pages.spec.js | the section saves new times and a Job Radar mute (read back through the API and after a reload, then put back), and Per-sistant's Settings links to it

TEST RESULTS: npm test 3075/3075 (17 new — 7 in tests/cycle8-e3c.test.js, 10 in apps/per-sistant/tests/cycle8-e3c.test.js). Contract 315/316 (cash-alerts-l2, date-dependent, pre-existing). e2e: see STATE.
REGRESSION RISKS: Per-sistant's notification check makes one more perfinPool read per call under the shell (fail-soft); existing check tests' fake perfinPools answer it with no row (defaults — nothing held). The Settings page gains a section the e2e click sweep presses (Save times saves the current values).
INVARIANTS AT RISK: INV-25 / INV-35 — kept (the prefs are read through the wired perfinPool, read-only, never an HTTP self-fetch). INV-89 — kept (every save through writeOk). INV-97 — no regex added to a Per-sistant template-literal module. INV-153 — extended to Per-sistant's browser notifications (the list keeps every entry).
NET SCORE: 0 production fixes − 0 new failure modes = 0

OPERATOR ACTIONS / DEPLOY:
- None | BLOCKS DEPLOY: N
Deploy: Platform, Shell & Auth: Render auto-deploys on push to `main`.

FOLLOW-ON ITEMS:
- Per-sistant has no quiet hours standalone (the settings live in Perfin's row); its 8 h client snooze stays.
- A Per-sistant reminder held for quiet hours is raised only when the dashboard is next loaded after they end (Per-sistant has no push).
- The quiet-hours times are read in APP_TIMEZONE, which may differ from the browser's zone — the section names the zone.

DOCUMENTATION UPDATES NEEDED:
- CLAUDE.md: the Settings layout (Alerts & Notifications gains Quiet Hours & Muting, anchor #quiet-hours-section); the Unified notification center (the bell's words); the Per-sistant integration list (the check reads Perfin's prefs) and INV-153 (Per-sistant side); E3 Known Issues paragraph (G2 complete); the tests list and counts (3075 / 167 files; Per-sistant 731); e2e 74.
- apps/per-sistant/CLAUDE.md: Notification System (kind / notify / quiet, notify:false not browser-notified) and the test count (731).
---END BROAD SCAN IMPLEMENTATION SUMMARY---
