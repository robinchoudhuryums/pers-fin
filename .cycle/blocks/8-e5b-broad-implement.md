---BROAD SCAN IMPLEMENTATION SUMMARY---
Findings implemented: none (an expansion batch); one production bug the new tests exposed was fixed — the Settings
page's updateSetting wrapper (the keep-alive estimate refresh) dropped updateSetting's result, so saveToggle and the
insight-module / dashboard-widget switches read every SUCCESSFUL save as refused and flipped the switch back (the
stored value was right; the page showed the opposite until a reload) — since cycle-8 Batch 7's F38.
New capabilities (G/ST): ST4 part 2 (cycle-8 E5b) — five more behaviour tests in e2e/behaviour.spec.js (actions 9–13 of
.cycle/plan-e5-behaviour-tests.md): 9 a credit score logged on the dashboard, 10 the theme, 11 a dashboard widget switched
off and on, 12 a refused switch going back and a saved one staying (F38, the refusal through page.route), 13 Mark all read
on the bell (the plan's one direct notification_log insert).
Files modified: e2e/behaviour.spec.js, e2e/helpers.js, e2e/seed.js, teller/views/settings.ejs

CHANGES:
E5b (9) | e2e/behaviour.spec.js | Dashboard credit widget: 611 / Other / "E5 Bureau <tag>" logged through the form → "Logged ✓", the current score 611 and the form cleared · GET /api/credit-scores' newest entry · 611 after a reload; its entry DELETEd in a finally, then the current score equals the API's newest again
E5b (10) | e2e/behaviour.spec.js | Settings theme select → "Setting saved.", html[data-theme] switched · /api/settings theme · after removing localStorage perfin-theme and reloading (the stored setting decides) the theme and the select; put back through the select (API polled), PATCH fallback in a finally
E5b (11) | e2e/behaviour.spec.js | Settings → Dashboard Widgets "charts" unticked → "Setting saved.", the box stays unticked · dashboard_widgets.charts false · the dashboard's .charts-grid has widget-off and is hidden, also after a reload, and the box unticked on Settings after a reload; ticked again → API true, box ticked, the charts shown; PATCH fallback in a finally
E5b (12) | e2e/behaviour.spec.js | Insight emails switch (clicked through its slider): with the PATCH routed to a 400, the toast shows the refusal, the switch goes back and the API is unchanged; unrouted, the save stays flipped, the API agrees, a reload shows it; put back through the page, PATCH fallback in a finally
E5b (13) | e2e/behaviour.spec.js | an unread notification_log row inserted directly ("E5 bell <tag>"); /perfin/goals shows the badge and the bell's "N unread" label, the open list shows the row unread; Mark all read → badge hidden, label "Notifications", the row re-rendered read · the row not in ?unread=true · badge hidden after a reload; the row deleted in a finally
E5b harness | e2e/behaviour.spec.js, e2e/helpers.js, e2e/seed.js | openSettings (waits for the widget switches — loadSettings fills every control in one synchronous step, so a later change can't be overwritten), settingsOf, perfinDb; dbUrl moved from seed.js into helpers.js (seed.js imports it)
Fix | teller/views/settings.ejs | the updateSetting override (`_origUpdate` + updateKeepAliveEstimate) returns the original's result

TEST RESULTS: npm test 3126/3127 — the one failure is the pre-existing date-dependent tests/cycle8-e1a.test.js "auto: the subscription and the plain transfer are billed…" (today is the 30th of a 31-day month). Full e2e 87/87 (82 + 5 new; behaviour.spec 13/13 twice). Contract suite not run (no route SQL changed). Mutation checks: the fix reverted → tests 11 and 12 red (the box flipped back after "Setting saved."); the credit widget's load() after a save removed → test 9 red; POST /api/notifications/read-all made a no-op → test 13 red; each file restored.
REGRESSION RISKS: The settings.ejs fix changes only what the wrapper returns; every caller that ignored the result still ignores it (theme, months, timeouts, the budget cap, keep-alive), and the three that read it (saveToggle, toggleModule's caller, the widget handler) now see true on a save — the behaviour F38 intended. seed.js's dbUrl now comes from helpers.js (same ADMIN_URL default and env). Test 13 marks EVERY notification read (the action's own semantics); no other e2e check reads unread state.
INVARIANTS AT RISK: None — INV-130 holds (behaviour tests act on their own rows; the notification row is the plan's documented direct insert, deleted afterwards). The fix restores INV-59's / F38's intent on the page side.
NET SCORE: 1 − 0 = +1 (the switch-revert fix fired in production: since cycle-8 Batch 7 every Settings switch saved through saveToggle, every insight-module switch and every dashboard-widget switch showed the opposite of what was stored until a reload; the five tests are new capability, no new failure mode)

OPERATOR ACTIONS / DEPLOY:
- None
Deploy: Platform, Shell & Auth / Web UI ship with the main app: Render auto-deploys on push to `main` (settings.ejs).

(Not complete in production until blocking operator actions are done AND
the deploy step is confirmed.)

FOLLOW-ON ITEMS:
- tests/broad-scan-c8-batch7.test.js's saveToggle test runs only the ORIGINAL updateSetting in a vm (sliced before the override), so it passed while the page's real updateSetting returned undefined — a unit pin that the override passes the result on (or a slice that includes it) would catch a repeat without the browser.
- The budget-cap Save (`await updateSetting('ai_monthly_budget_cents', …)` then loadSettings) ignores a refused save — the field is re-read, so no wrong state stays, but nothing says the cap wasn't changed beyond the toast.
- Test 13's badge checks can flake if a background job writes a new unread notification during the test (unlikely in the e2e run; its API check is on its own row only).
- Test 9 logs score type "other" for today; a leftover from an interrupted run is upserted (ON CONFLICT (checked_at, score_type)) and removed by the finally.
- The E5a follow-ons stand (the Review count label, the calendar's DATE prefix match, rows accumulating on a long-lived server, a ~4-minute local run).

DOCUMENTATION UPDATES NEEDED:
- CLAUDE.md: the ci.yml e2e bullet (87 tests; behaviour.spec.js now also covers the credit score, theme, a widget switch, a refused / saved switch and Mark all read; one direct notification_log insert); Current Status e2e count (82 → 87); INV-130's direct inserts (+ the notification row); the E5 Known Open Issues entry (E5b done + its follow-ons); the Settings layout note on saveToggle (a saved switch now stays — the wrapper bug).
- README: the e2e sentence if it names the actions.
---END BROAD SCAN IMPLEMENTATION SUMMARY---
