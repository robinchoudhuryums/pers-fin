# Cycle 8 E3 — notifications: quiet hours, mutes, one item one alert (plan, 2026-10-29)

Status: DONE — E3a–E3e (2026-10-29; G2 and ST2 complete).

Scope: G2 and ST2 from the cycle-8 expansion plan (`.cycle/plan-cycle8-expansion.md`).

Goal: the user decides WHEN they can be interrupted (quiet hours) and WHAT may interrupt them
(a mute per kind of alert), in both apps from one setting (G2); and one real-world item — this
month's rent, a utility amount to enter, a subscription still charging — interrupts once, on
one surface, however many parts of the two apps know about it (ST2).

## What exists (read for this plan)
- **Perfin push** (`teller/routes/notifications.js` `sendToAll({ title, body, tag, data })`): always
  INSERTs a `notification_log` row (type = the tag, title, body, data JSONB, is_read) — that row is
  also the dedup marker `sentRecently(tag, hours)` reads, and the return value's `logged` is what
  every dedup-gated caller advances its state on (F24 / F10 / L2…) — then web-pushes to every
  `push_subscriptions` row. `pruneNotificationLog` keeps unread rows, drops read ones after 180
  days. The service worker shows the push with its `tag` (the OS collapses same-tag pushes).
- **Callers** (~29 sendToAll sites, tags as types): `anomaly-<merchant>`, `budget-over-<cat>` /
  `budget-warn-<cat>`, `cash-low`, `balance-floor-<id>`, `payday-<hash>`, `payday-missed-…`,
  `advice-plan`, `sub-still-charging-<id>`, `sub-price-<id>`, `housing-due-<YYYY-MM>`,
  `housing-util-<obligation id>`, `goal-<id>`, `csv-reminder`, `auto-sync`, `sync-error`,
  `reconcile`, `plaid-reauth-<id>`, `teller-disconnected-<id>`, `operator-checks`, `jobs-missed`,
  `sheets-sync`, `app-error-<fp>`, `audit-alert`, `pin-lockout` (shell/middleware/auth.js), `test`.
  The critical-alert email (`routes/persistent.js sendCriticalAlertEmail`, opt-in) rides beside
  budget-exceeded, 3x anomalies, still-charging, low cash and payday missed — it knows nothing
  about the push it accompanies.
- **Per-sistant has no push**. `GET /api/notifications/check` (`apps/per-sistant/routes/
  notifications.js`) computes a list at request time — `due_today`, `overdue`, `streak_at_risk`,
  `reminder`, `fact_upcoming`, `habit_streak_at_risk`, `housing_due` (read from perfinPool;
  hidden while a linked housing task is open — `housingDueUnlessTask`, cycle-8 F23), `job_radar`,
  `email_failed`, `vault_sync_error`. The dashboard (`pages/dashboard-script.js`) lists them in
  the Reminders widget and fires browser `new Notification(...)` for `isImportantReminder` types
  (≤3 a load), deduped per device in localStorage (`ps-notify-ledger`, 12 h —
  `NOTIFY_WINDOW_BY_TYPE` for job_radar) with an 8 h client snooze (`ps-notify-snooze-until`).
- **Linked tasks** (T2.4): Perfin opens Per-sistant To-Dos keyed `perfin:housing:<period>`,
  `perfin:utility-amount:<obligation id>`, `perfin:bill:<id>:<date>`, `perfin:tax-doc:<id>`,
  `perfin:still-charging:<sub>:<txn>` (`teller/services/linked-tasks.js`). An open one also shows
  as `due_today` / `overdue` in Per-sistant's check — while Perfin's own `housing-due-*` /
  `housing-util-*` / `sub-still-charging-*` pushes still fire for the same item (the cycle-8
  Batch 5 follow-on that ST2 closes).
- **The job runner** (E2): a `when()` gate checked in memory before a claim — a closed gate costs
  no query. The away channels are never activity-gated (INV-77).
- Per-sistant already lazy-requires Perfin services under the shell (rag.js → financial-queries),
  and reads Perfin's pool read-only through `perfinPool` (INV-25 / INV-35).

## Decisions (proposed; confirm at the first /broad-implement)
1. **One catalog, one module** — `teller/services/notify-prefs.js` (pure, requireable by
   Per-sistant like financial-queries): `NOTIFY_TYPES` — a fixed list of user-facing kinds, each
   `{ key, label, app, tagPrefixes[], mutable, bypassQuiet }`. Perfin: `spending` (anomaly-,
   budget-), `cash` (cash-low, balance-floor-, payday-), `bills` (housing-, sub-), `plan`
   (advice-plan), `goals` (goal-), `accounts` (plaid-reauth-, teller-disconnected-, sync-error,
   auto-sync, reconcile, csv-reminder), `system` (operator-checks, jobs-missed, sheets-sync,
   app-error-, audit-alert), `security` (pin-lockout — not mutable, bypasses quiet hours), `test`
   (bypasses both — it exists to test delivery). Per-sistant: `tasks` (due_today, overdue,
   reminder), `habits` (streak_at_risk, habit_streak_at_risk), `knowledge` (fact_upcoming,
   vault_sync_error), `jobs` (job_radar), `email` (email_failed), `housing` (housing_due — the
   same kind as Perfin's `bills`). `typeOf(tagOrType)` maps a tag / check type to its kind; an
   unknown tag is `other` (mutable). No caller changes for G2.
2. **Perfin owns the setting** (the shell's settings row, read by both apps): `user_settings.
   notify_quiet_hours JSONB` `{ enabled, start: "HH:MM", end: "HH:MM" }` (default off, 22:00–07:00;
   APP_TIMEZONE; `end < start` wraps past midnight; start = end is a 400) and
   `notify_muted_types JSONB` (an array of mutable kind keys, default `[]`). PATCH /api/settings
   validates both (strict — INV-59); GET returns them with the catalog for the UI.
   Per-sistant reads them through perfinPool (fail-soft → no quiet hours, nothing muted);
   a standalone Per-sistant has none (its client snooze stays).
3. **The bell is never silenced** — quiet hours and mutes act on the INTERRUPTION (web push, a
   Per-sistant browser notification), never on the record: sendToAll still writes the
   notification_log row exactly as today, and `logged` keeps its meaning, so no caller's
   dedup / watermark changes (F24 contract). New `notification_log.push_state TEXT` (`sent` /
   `held` / `muted` / `covered` / `none` (push not configured) — NULL on old rows) says what
   happened to the push.
4. **Quiet hours hold, they don't drop** — a push for a kind that doesn't bypass quiet hours is
   held (`push_state = 'held'`). A `notify-release` job on the runner (every 15 min, NOT
   activity-gated, its `when()` gate an in-memory "something is held" flag — set by a hold, and
   true once after boot so held rows from before a restart are found) sends at quiet-hours end:
   one held push as itself, several as ONE summary push ("4 notifications while you were away",
   url = the newest's, tag `quiet-summary`) — then marks them `sent`. A hold older than 12 h is
   left in the bell (`push_state = 'expired'`), never pushed late.
5. **Mutes are total for that kind** — a muted kind is logged (`push_state = 'muted'`) with no
   push and no critical-alert email: `sendCriticalAlertEmail(title, body, { tag })` checks the
   kind; quiet hours never hold an email (it waits in the inbox anyway). `security` and `test`
   can't be muted (PATCH 400s them).
6. **One real-world item, one alert (ST2)** — an `item` key on the notification, the same string as
   the linked-task key without its `perfin:` prefix (`housing:<period>`,
   `utility-amount:<id>`, `still-charging:<sub>:<txn>`, `bill:<id>:<date>`, `tax-doc:<id>`), stored
   in `notification_log.item_key`. One router function `notify({ tag, item?, title, body, data })`
   (sendToAll becomes its wrapper) decides, in order: muted → `muted`; an OPEN linked task for the
   item in Per-sistant (read through persistentPool: `source_key = 'perfin:' || item`, not
   completed, not deleted, not detached — fail-soft: a failed read pushes) → `covered`, the log
   row written `is_read = true` (the task is the surface; the bell doesn't count it); quiet → `held`;
   else `sent`. The pure `decide({ kind, prefs, now, tz, covered })` lives in notify-prefs.js so
   Per-sistant uses the same rule.
7. **Per-sistant follows the same rule** — `GET /api/notifications/check` annotates each entry with
   `kind` and `notify: true|false` (false while quiet unless the kind bypasses, while muted, and —
   ST2 — for an entry whose item Perfin pushed in the last 12 h: its `notification_log.item_key`
   with `push_state = 'sent'`, read through perfinPool); the dashboard fires browser Notifications
   only for `notify: true` (the list still shows everything; the localStorage ledger and snooze
   stay as a per-device layer). `housingDueUnlessTask` becomes the general rule: an entry carrying an
   item key that an open linked task covers is left out (the task's own due_today / overdue entry
   is the surface).
8. **Settings UI in one place** — Perfin Settings → Alerts & Notifications → "Quiet hours &
   muting": a switch, two labelled time inputs, a checkbox per mutable kind grouped by app (Per-
   sistant's kinds listed only under the shell), each save through writeOk / saveToggle (revert on
   refusal — cycle-8 F38). Per-sistant's Settings shows a line linking there under the shell.
   The Perfin bell marks a held / muted / covered row in words ("held during quiet hours").
9. **Out of scope**: per-device preferences; quiet hours for the weekly / daily digest emails (they
   are scheduled at 07:00+ already); snoozing one item; a kind catalog the user can edit;
   standalone Per-sistant quiet hours; changing any caller's own dedup window.

## Batches
| Batch | Scope | Est. | Status |
|-------|-------|------|--------|
| E3a | `services/notify-prefs.js`: `NOTIFY_TYPES`, `typeOf` (every tag sendToAll is called with today and every Per-sistant check type mapped — a scan test fails on an unmapped literal tag), `isQuiet(now, prefs, tz)` (overnight wrap, the edges, DST days under a forced zone), `decide(...)`; the two `user_settings` columns + `notification_log.push_state` / `item_key`; PATCH /api/settings validation (HH:MM, start ≠ end, known mutable kinds only, strict boolean) and GET's defaults + catalog. No delivery change | 4h | done (2026-10-29) |
| E3b | Perfin delivery: sendToAll through `decide` — `push_state` written on every row, a held push kept, a muted kind not pushed, `logged` unchanged; `notify-release` on the runner (the in-memory gate, one summary push for several, the 12 h expiry, mark-after-send so a failed send retries); `sendCriticalAlertEmail` skipping a muted kind; unit tests over a fake pool + stubbed web-push (every existing caller's tests still green) and a contract test (a push held at 23:00 and released once at 07:00, a muted kind logged and never pushed or emailed, `pin-lockout` pushed during quiet hours, a restart with held rows releasing them) | 5h | done (2026-10-29) |
| E3c | The UI and Per-sistant's G2 half: the Settings section (vm test — the switch, labelled times, a checkbox per kind, refusal reverts, the shell-only Per-sistant group), the bell's push_state words, the check's `kind` / `notify` from Perfin's prefs through perfinPool (fail-soft, standalone none), dashboard-script firing only `notify: true` (vm test), Per-sistant Settings' link; e2e: the section on the Settings page and the click sweep clean | 4h | done (2026-10-29) |
| E3d | ST2 core: `notify({ item })` and `item_key` on the item-bearing callers — housing due (`housing:<period>`), the utility-amount reminder (`utility-amount:<id>`), still-charging (`still-charging:<sub>:<txn>`); the covered check through persistentPool (fail-soft); unit tests (covered → logged read, no push; task closed → pushed; read failure → pushed; standalone → pushed) and a cross-app contract test on both real databases (rent due with linked tasks on: one Per-sistant task, Perfin's push `covered`; tasks off: pushed) | 5h | done (2026-10-29) |
| E3e | ST2 Per-sistant half + follow-through: the check's item keys (housing_due, linked-task entries), the "pushed by Perfin in 12 h" read, `housingDueUnlessTask` generalised; the remaining item-shaped callers given keys where a linked-task kind exists (bills, tax-doc — none push today: noted, not invented); a cross-app contract test (rent due, tasks on: no Perfin push and the Per-sistant entry is the task's own; tasks off: Perfin pushes and the check's housing_due is `notify: false`); docs pointers for /sync-docs | 4–5h | done (2026-10-29) |

Order: E3a → E3b → E3c; E3d needs E3b (the router); E3e needs E3c and E3d. Total ≈ 22–23h.

## Risks to watch
- E3b sits under every alert in the app. The `logged` contract is what ~15 callers advance their
  state on — a test must assert a held / muted / covered push still returns `logged: true` when the
  row was written, and `logged: false` only when it wasn't.
- A held push must never be lost silently: the release marks rows only after the send, a restart
  re-finds them (the gate is true once at boot), and an expired hold stays visible in the bell.
- The covered check adds one persistentPool read per item-keyed push (a handful a day) — fail-soft
  toward pushing, so a Per-sistant outage can't silence Perfin.
- Quiet hours use APP_TIMEZONE; an operator who never set it (UTC) gets quiet hours in UTC — the
  Settings section says which zone it uses.
- The catalog maps tags by prefix; a new caller with a new tag lands in `other` (mutable, never
  silently muted) and the E3a scan test names it.
