---BROAD SCAN IMPLEMENTATION SUMMARY---
Findings implemented: None (expansion batch)
New capabilities (G/ST): G2 (part 2 of 3) — E3b: Perfin's pushes follow quiet hours and per-kind mutes (held pushes released after quiet hours end, one summary for several; muted kinds logged but never pushed or emailed)
Files modified: teller/routes/notifications.js, teller/services/notify-prefs.js, teller/routes/persistent.js, teller/routes/settings.js, teller/startup.js, teller/services/job-health.js, teller/routes/enrollments.js, teller/routes/subscriptions.js, teller/services/cash-alerts.js, teller/services/payday-alerts.js, tests/cycle8-e3b.test.js (new), tests/contract/notify-e3b.contract.test.js (new), tests/cycle8-e2b.test.js, tests/cycle8-e3a.test.js

CHANGES:
G2 (E3b) | teller/routes/notifications.js | sendToAll(payload, opts?) reads the quiet hours + muted kinds (readNotifyPrefs — cached 60 s, a failed read = nothing held or muted) and decides through notify-prefs.decide: the notification_log row is written exactly as before plus push_state (sent / held / muted / none) and `logged` keeps its meaning; held → not pushed, the release gate opens (heldPending + releaseNotBefore = the end of quiet hours); muted → never pushed; a hold whose row failed to write is pushed at once; push not configured → none. The push loop moved into pushToSubscribers (unchanged behaviour). releaseHeldNotifications({ now }): still quiet → nothing (the wait moved to the end); holds older than HOLD_MAX_HOURS (12) → expired (stay in the bell); a kind muted since → muted; one held row pushed as itself, several as ONE summary ("N notifications during quiet hours", the newest three titles, the newest's link, tag quiet-summary); rows marked sent only after the push went out — a failed delivery leaves them held; the gate closes only when nothing is left and no hold arrived meanwhile (holdGeneration). releaseDue(), invalidateNotifyPrefs(), _release test seam
G2 (E3b) | teller/services/notify-prefs.js | minutesUntilQuietEnd(now, quiet, tz)
G2 (E3b) | teller/routes/persistent.js | sendCriticalAlertEmail(title, body, { tag | kind }) — the same single settings read now also reads notify_muted_types; a muted (mutable) kind returns { sent: false, reason: "muted" }; quiet hours never hold an email
G2 (E3b) | teller/startup.js, teller/routes/enrollments.js, teller/routes/subscriptions.js, teller/services/cash-alerts.js, teller/services/payday-alerts.js | every critical-alert email names its kind (budget-over tag, kind spending for the anomaly summary, sub-still-charging-<id>, cash-low, the payday-missed tag)
G2 (E3b) | teller/startup.js, teller/services/job-health.js | the notify-release job (JOB_INTERVALS_MS 15 min; runner gate releaseDue — in memory, no query while nothing is held or quiet hours run; not activity-gated); its outcome recorded only when it pushed or failed to
G2 (E3b) | teller/routes/settings.js | PATCH /api/settings drops the cached prefs and the release wait when notify_quiet_hours / notify_muted_types change (switching quiet hours off releases what's held at the next check)

TEST RESULTS: npm test 3058/3058 (22 new in tests/cycle8-e3b.test.js; cycle8-e2b updated for the new job; the E3a tag scan skips the release job's own quiet-summary tag). Contract 315/316 (6 new in notify-e3b; cash-alerts-l2 date-dependent, pre-existing). Mutation check: pushing held notifications at once turns notify-e3b red (2 tests). e2e 73/73.
REGRESSION RISKS: every send now makes one settings read a minute (cached); the release gate is open at boot, so the first check after every boot runs one release (three short queries) even with nothing held. sendToAll's result gains push_state; its other fields are unchanged.
INVARIANTS AT RISK: INV-77 — kept (notify-release is not activity-gated; its gate is the in-memory hold flag). INV-142 / INV-115 / every caller relying on `logged` — kept (a held or muted push still writes its row and returns logged: true). INV-24 / INV-59 unaffected.
NET SCORE: 0 production fixes − 1 new failure mode (a hold not released within 12 hours — e.g. the host asleep past the end of quiet hours — expires and is never pushed; it stays in the bell, by design) = −1

OPERATOR ACTIONS / DEPLOY:
- None (the columns shipped with E3a; nothing changes until quiet hours are switched on or a kind is muted) | BLOCKS DEPLOY: N
Deploy: Platform, Shell & Auth: Render auto-deploys on push to `main`.

FOLLOW-ON ITEMS:
- No UI yet: quiet hours and mutes are set through PATCH /api/settings until E3c's Settings section; the bell doesn't show a row's push_state yet (E3c).
- Per-sistant's browser notifications don't follow the settings yet (E3c).
- The release job's first check after boot runs once with nothing held (three queries); a summary push carries one link (the newest's).
- A hold made just before a restart waits for the first check after boot (~1 minute) plus quiet hours' end — never earlier than intended.

DOCUMENTATION UPDATES NEEDED:
- CLAUDE.md: routes/notifications.js (sendToAll's decision + push_state, releaseHeldNotifications, releaseDue, invalidateNotifyPrefs); notify-prefs minutesUntilQuietEnd; sendCriticalAlertEmail's opts; the notify-release job in Scheduled Tasks and JOB_INTERVALS_MS; the Unified notification center / Web Push sections; INV-77 lists notify-release; a new invariant for "quiet hours / mutes never silence the record" (logged unchanged, push held not dropped, expired after 12 h); E3 Known Issues paragraph; test counts (3058 / 165 files; contract 316).
---END BROAD SCAN IMPLEMENTATION SUMMARY---
