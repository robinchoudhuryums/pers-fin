---BROAD SCAN IMPLEMENTATION SUMMARY---
Findings implemented:
- F52 — any save from the task edit dialog cleared the month-end anchor (the dialog always sends the due date), so a task anchored on the 31st, edited in February, moved to the 28th for good
- F53 — saving the Job Radar profile always cleared every fit score (the page always sends both text fields), each re-score a charged model call
- F50 — a frontmatter privacy value on the line after its key (`sensitivity:` then an indented `secret`), or a block list after a blank line, resolved to normal — the file was embedded and sent to the model
- F65 — the dashboard mini-calendar read `ev.date`; the API returns `event_date`, so no day was ever marked and every day said "Nothing on this day"
- F66 — the automation and webhook On / Off buttons sent the current state, so a rule or webhook couldn't be switched off from the list
- F67 — "Use template" filled the compose form and then `openCompose` cleared it
- F68 — a note's bulk-select checkbox sat inside the open-note click target, so every tick opened the editor
- F69 — single-key shortcuts ignored Ctrl / Cmd / Alt (Cmd+C on the dashboard opened the Calendar; Cmd+R on Today didn't reload)
- F70 — Per-sistant's Theme select set an attribute nothing styles; Auto did nothing
- F71 — a refused vault setting wrote its error into a hidden element
- F72 — quick parsers: "email to Bob" gave the recipient "to"; "wedding" scheduled Wednesday; "jan 5" became the year 2001
- F54 — past-due scheduled emails sat silently while SMTP wasn't configured
- F55 — Skip on a recurring task counted as a completion everywhere; snoozing a monthly task past month-end skipped a whole occurrence; a recurring task with no rule was re-created nightly and couldn't be completed
- F56 — creating a todo from a private or secret note copied its text into the todo (and out to webhooks)
- F58 — the finance-grounding gate fired on ordinary words ("Bill's phone number", "GitHub account"); Slack failures were never logged; the briefing counted saved roles as new
- F26 — an AI categorize batch that returned no tool block was charged but not marked, so the same rows were re-sent and re-charged every run; each prompt row carried a long JS date string
- F27 — the stale sweeps rewrote `updated_at` on every stale row each run; deleting a rename rule and `POST /api/categorize/review` weren't atomic; a non-string `name` on a manual-bill PATCH left the request hanging
New capabilities (G/ST): None
Files modified:
- apps/per-sistant/db/032_todo_skip_snooze.sql (new)
- apps/per-sistant/helpers.js
- apps/per-sistant/views.js
- apps/per-sistant/routes/todos.js, calendar.js, analytics.js, settings.js, ai.js, jobs.js, notifications.js, links.js, rag.js
- apps/per-sistant/services/vault-sync.js
- apps/per-sistant/pages/dashboard-script.js, today.js, todos-script-2.js, emails.js, notes.js, settings-script.js
- teller/routes/categorize.js, merchant-rename.js, subscriptions.js, persistent.js
- scripts/detect-subscriptions.js, scripts/detect-transfers.js
- tests: apps/per-sistant/tests/cycle9-b8.test.js (new, 51), tests/cycle9-b8.test.js (new, 11), tests/contract/c9-batch8.contract.test.js (new, 9); pins / doubles updated in apps/per-sistant/tests/api.test.js, broad-scan-c8-batch5.test.js, broad-scan-c8-batch6.test.js, scan-sept-batch6.test.js and tests/scan-oct-batch3.test.js, scan-sept-batch3.test.js, scan-sept-batch4.test.js, seams-audit-4-s4.test.js
- .cycle/STATE.md, .cycle/blocks/9-batch8-broad-implement.md

CHANGES:
F52 | apps/per-sistant/routes/todos.js | PATCH /api/todos/:id resets `recurrence_anchor_day` (and the new `snoozed_from`) only when the stored due date differs from the one sent (`CASE WHEN due_date IS DISTINCT FROM $n::date`), instead of on every request that carries a due date.
F53 | apps/per-sistant/routes/jobs.js | The profile UPDATE returns the text it replaced (a FROM subquery); `profileTextChanged(sent, prev)` (exported) decides the reset — only the text fields the request sent, NULL = empty, CRLF = LF. The embedding and fit scores are cleared only when the resume or preferences text really changed. The previous text is not echoed in the response.
F50 | apps/per-sistant/services/vault-sync.js | `parseFrontmatter`: a blank line no longer ends a key's block list; an INDENTED line after a privacy key with an empty value is that key's value (a tier name is honoured, anything else fails closed in `resolveSensitivity`). A truly empty key stays "absent". `VAULT_PARSE_VERSION` 3 → 4.
F65 | apps/per-sistant/pages/dashboard-script.js | New `calEventDay(ev)` reads `event_date` (a task's DATE through `parseCalDate`, an email's / note reminder's timestamp on its local day — the Calendar page's rule); both mini-calendar readers use it.
F66 | apps/per-sistant/pages/settings-script.js | The two delegated toggle handlers pass `dataset.enabled !== 'true'` (the other state).
F67 | apps/per-sistant/pages/emails.js | `useTemplate` calls `openCompose()` first, then fills subject and body.
F68 | apps/per-sistant/pages/notes.js | The page's click handler returns when the click is on `.note-bulk-check`.
F69 | apps/per-sistant/pages/dashboard-script.js, today.js, todos-script-2.js | Each single-key shortcut handler returns when `ctrlKey`, `metaKey` or `altKey` is held.
F70 | apps/per-sistant/pages/settings-script.js, apps/per-sistant/views.js | `applyTheme` now sets what the stylesheet reads — `body[data-mode]` — and stores the choice in localStorage `ps-ui.mode` (dark / light / auto), the store the sidebar toggle uses; `currentTheme` fills the select from this browser's choice, else the stored setting; loading Settings no longer repaints the page. `themeScript` gained `effectiveMode` (auto → the system setting), follows a system change while on Auto, and hydrates `auto` from the server on a first visit.
F71 | apps/per-sistant/pages/settings-script.js | `saveVault` writes a refusal with the visible `status-msg error` class (8 s).
F72 | apps/per-sistant/pages/emails.js, todos-script-2.js | `quickRecipient` (the word after "to", else after "email"; "to email X" skips to X); the weekday pattern is whole-word; `quickMonthDay(input, now)` reads a real month name + day (+ optional year) — no year means the next such date — and Quick Add uses it instead of `new Date("jan 5")`.
F54 | apps/per-sistant/routes/notifications.js | `waitingEmails(pool, env)` (exported): without `SMTP_HOST`, the count and oldest time of scheduled emails already due (no query with SMTP set; fail-soft). The notification check lists them as one `email_failed` entry (id `smtp-not-configured`, "N scheduled emails are waiting since <date> — email sending isn't set up (SMTP_HOST)") and adds `counts.email_waiting`.
F55 | apps/per-sistant/db/032_todo_skip_snooze.sql, routes/todos.js, helpers.js, routes/calendar.js, routes/analytics.js, routes/settings.js, routes/ai.js, teller/routes/persistent.js | New columns `todos.skipped` and `todos.snoozed_from`. Skip sets `completed = true, completed_at = NULL, skipped = true`; the done counts (/api/stats, analytics, Ask's totals, Perfin's embedded stats mirror) exclude skipped rows; Ask labels one "skipped"; undo refuses a skipped row; a hand change of `completed` clears the flag. Snooze stores the first pre-snooze date (and the chain's day of month for month-scale rules); `scheduleBase(todo)` (exported) is what `nextDueAfter`, the midnight roll and the calendar projection step from. The midnight roll ignores a recurring task with no rule, and complete-recurring completes such a task as a plain one (`next: null`).
F56 | apps/per-sistant/routes/links.js | `todoFieldsFromNote(n)` (exported): a normal note gives its title / first 100 characters and its text; a private, secret or unknown-tier note gives its title (else "Private note" / "Secret note") and NO description. The link back to the note is still created.
F58 | apps/per-sistant/routes/rag.js, helpers.js, routes/ai.js | `looksFinancial`: money words stay; `credit`, `account(s)` and `bill(s)` count only in a finance phrase ("credit card", "checking account", "my accounts", "the phone bill", plural "bills"); bare `renew(al)` and a bare `$` no longer open the gate. `sendSlackNotification` logs a non-OK answer (status) or a thrown send (error name) — never the URL. The briefing's Job Radar line uses `counts.main_new` / `top_new`.
F26 | teller/routes/categorize.js | A batch with no tool block is stamped `ai_skipped_at` through the shared `markAiSkipped` before the loop stops; each prompt row uses `to_char(date, 'YYYY-MM-DD') AS txn_day`.
F27 | scripts/detect-subscriptions.js, scripts/detect-transfers.js, teller/routes/merchant-rename.js, teller/routes/categorize.js, teller/routes/subscriptions.js | Both stale sweeps add `AND is_active = true`. DELETE /api/merchant-rename-rules/:id and POST /api/categorize/review each run in one transaction (`inTransaction`, now exported from merchant-rename.js; 404s roll back). PATCH /api/manual-bills/:id answers 400 for a non-string or blank `name`.

TEST RESULTS: passed — `npm test` 3606 / 3606 (189 files; Perfin 2786, Per-sistant 820; 62 new). Contract suite 402 / 402 (9 new). Playwright 93 / 93. The new and touched test files under five shifted clocks (2026-12-31, 2027-01-31, 2027-03-14, 2027-11-07, 2028-02-29): 147 / 147 each. Mutation check against the pre-fix source: 43 of 47 Per-sistant unit, 10 of 11 Perfin unit and 8 of 9 contract tests fail (the remaining Perfin unit and contract test is the manual-bill one, which on the pre-fix source never answers — the bug itself). One existing file (tests/roadmap-t3-3-k2.test.js) failed once with the known intermittent node:test IPC error and passed on re-run. Regression scenarios: S3 (AI cap) PASS via tests/ai-cap-charge; S4 PASS via e2e; SK1 / SK2 PASS via the Knowledge unit + contract files; S1, S2, S5, S6, SK3–SK5 not applicable (no file of theirs changed).
REGRESSION RISKS:
- Snooze no longer moves a recurring task's schedule: someone who snoozed a weekly task to move it to another weekday for good now gets the original weekday back on the next instance (edit the due date to move the series).
- The finance gate is narrower: a money question phrased only with a removed word ("when does Netflix renew", "which accounts do I have") no longer gets Perfin grounding.
- F50: an indented line under an empty `sensitivity:` / `embed:` / `private:` key now counts as its value, so a mis-indented frontmatter line can make a file private (it drops out of the index instead of being embedded).
- F26: a batch that fails once for a passing reason (the model answered in prose) defers its 50 rows from the AI for 30 days; rules, the free maps and the Review widget still reach them.
- F70: on a first visit with the stored theme `auto`, the page now follows the system setting (it stayed light).
- Rows skipped before this deploy keep their completion time and still count as done.
INVARIANTS AT RISK: None. INV-27 (privacy resolution fails closed) is strengthened by F50 and F56; INV-71 / INV-112 / INV-124 (detection, rules, rename rules) keep their behaviour with the transaction wrappers; INV-74 (recurring chains keep their anchor day) is strengthened by F52 / F55; INV-97 (no single-escaped regex in client template literals) and INV-106 (no new bare catch — helpers.js's count shrank 3 → 2) pass their guards; INV-14 (AI cap) is unchanged — the stamped batch is still charged first.
NET SCORE: 2 − 4 = −2 (F65 fired on every dashboard load; F27's sweep rewrote stale rows on every detection run. New failure modes: the snooze change, the narrower finance gate, F50's restrictive continuation rule, F26's 30-day deferral after a one-off failure.)

OPERATOR ACTIONS / DEPLOY:
- Run ONE full Knowledge reindex after this deploys (F50 changed frontmatter parsing; `VAULT_PARSE_VERSION` is 4 — Settings → Sync Health → Operator Checks shows "Knowledge index" as a warning until a full sync stamps it). Only matters if a vault is configured. | BLOCKS DEPLOY: N
- If scheduled emails are waiting and SMTP isn't set up, the Reminders list now says so. Before setting `SMTP_HOST`, delete any you no longer want sent — they all go out within 10 minutes of SMTP being configured. | BLOCKS DEPLOY: N
Deploy: Render auto-deploys on push to `main` (this work is on `claude/gracious-maxwell-li0vm7`; no PR opened). The new migration (db/032) runs at boot.

(Not complete in production until blocking operator actions are done AND
the deploy step is confirmed.)

FOLLOW-ON ITEMS:
- F53's second half: the profile's minimum salary, locations and remote preference are still stored and never used by the fit pass.
- F54's second half: once SMTP is configured, every past-due scheduled email still sends at once (no age limit); the notice is the only warning.
- POST / PATCH /api/todos still accept `recurring: true` with no rule (now harmless: not rolled, completes as a plain task, Skip answers 400).
- Reopening a MISSED instance by hand leaves `missed = true` (the skip flag is cleared on a hand change; the missed flag isn't).
- The snooze route still passes a malformed date to Postgres (a 500, as before).
- Quick Add still formats tomorrow / weekday dates with `toISOString()` (the known UTC issue), and doesn't remove a "jan 5" from the title.
- A secret note's TITLE is still copied into a todo made from it (titles are treated as non-secret everywhere).
- The Settings Theme select doesn't follow the sidebar toggle until a reload.
- Knowledge: `renew` no longer opens the finance gate even for a subscription question.
- The cycle-9 mutation check showed the old manual-bill PATCH hang also hangs any test run against it — nothing to do now that it is fixed.

DOCUMENTATION UPDATES NEEDED:
- CLAUDE.md: tree entries (categorize, merchant-rename, subscriptions manual-bill PATCH, detect scripts); Known Open Issues (Batch 8 done + follow-ons; "Still open, by batch" starts at Batch 9); test list (tests/cycle9-b8.test.js, tests/contract/c9-batch8) and counts (3606 / 189 files, Perfin 2786, Per-sistant 820, contract 402); operator state item 3 (VAULT_PARSE_VERSION 4 — one reindex); INV-27 / INV-74 / INV-112 / INV-124 wording.
- apps/per-sistant/CLAUDE.md: recurring tasks (skip flag, snooze base, no-rule tasks), db/032, Job Radar profile save, the Knowledge frontmatter rule + parse version 4, the notification check's waiting-email entry, the theme mechanism (the "Dark/Light theme" bullet), the finance gate, Known Open Issues, the test list and count (820).
- README.md: test counts.
---END BROAD SCAN IMPLEMENTATION SUMMARY---
