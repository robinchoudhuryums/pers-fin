---BROAD SCAN IMPLEMENTATION SUMMARY---
Findings implemented: S4-5 (from .cycle/plan-seams4.md / Seams & Invariants audit #4)
- C2 — a Settings select / text / number box whose save was refused (or never reached the server) goes back to the stored value, like a switch (INV-157 completed)
- C3 — the dashboard plan card's emergency-fund line shows the plan's note beside the projection (it was dropped whenever both were set)
- C4 — the dashboard summary: a successful reload after a failed first load shows the cards again; a failed RELOAD keeps the summary on the page and toasts (it hid it)
- C5 — "Since you last looked" balance rows through fmt ("-$24.29", thousands separators) and the money colours (INV-148): money in green, a debt that rose red, a falling cash balance / a debt paid down the default colour, a cash balance below $0 red; a new subscription's amount through fmt
- C6 — Per-sistant's Analytics heatmap buckets a completion by its APP_TIMEZONE calendar day
New capabilities (G/ST): None
Files modified: teller/views/settings.ejs, teller/views/dashboard.ejs, apps/per-sistant/routes/analytics.js,
  tests/roadmap-t2-2-cash-l2.test.js, tests/scan-sept-batch8.test.js, tests/seams-audit-4-s5.test.js (new),
  apps/per-sistant/tests/seams-audit-4-s5.test.js (new), tests/contract/seams4-s4-5.contract.test.js (new)

CHANGES:
C2 | teller/views/settings.ejs | SAVED_FIELDS (the 18 selects / boxes bound to updateSetting on change), markSavedFields() — called by loadSettings once they're filled, storing each value as data-saved — and saveField(el, key, value): on a save the stored value moves on, on a refusal or network failure the control goes back to data-saved (nothing marked → left alone). Every change binding goes through saveField. The cash-floor / budget-cap boxes (a Save button, the typed value kept to correct) are unchanged.
C3 | teller/views/dashboard.ejs adviceEmergency | the sub-line joins the projection sentence and the note; Reached. still alone.
C4 | teller/views/dashboard.ejs loadDashboardSummary | summaryShown: success un-hides cards + attention and hides the error line; a failure after a shown summary toasts "The summary couldn't be refreshed — it shows the last figures loaded." and keeps the cards; a failure with none shown keeps the old one-line state.
C5 | teller/views/dashboard.ejs | whatsNewBalanceRow(bc): fmt for the delta and both balances, class amt-in (non-debt rise) / amt-bad (debt rose; a non-debt balance below $0) / none; the inline var(--green) / var(--red) gone. The subscription line's amount through fmt (no yellow — a charge is the default colour, INV-148).
C6 | apps/per-sistant/routes/analytics.js | HEATMAP_SQL = ((completed_at AT TIME ZONE $2)::date)::text as day … GROUP BY 1; heatmapTimezone() = APP_TIMEZONE validated with Intl (unknown → UTC), read per request; both exported. The other analytics queries (completed_by_day, created_by_day, the week/month window) are unchanged — out of C6's scope.
Tests | tests/seams-audit-4-s5.test.js (14: C2 in a vm — refused / offline restore, a saved change becomes the stored value, nothing marked left alone, every change binding on saveField and each field filled before markSavedFields; C3 — both lines, each alone, Reached., escaping; C4 — failed-then-ok un-hides, ok-then-failed keeps the cards with a toast; C5 with the real fmt — overdraft, money in, debt up / down, the widget wiring) + apps/per-sistant/tests/seams-audit-4-s5 (3) + tests/contract/seams4-s4-5 (1: a 03:00 UTC completion on the previous day under America/Los_Angeles, the same day under UTC and an unknown zone; an auto-closed task never on it) + Category A pin updates (roadmap-t2-2-cash-l2's horizon binding, scan-sept-batch8's DD-6 pins on the moved row code).

TEST RESULTS: npm test 3189 — 3188 pass; the one failure is tests/roadmap-t3-3-k2.test.js, the known node:test IPC flake (passes alone); contract 340/340 (+1); e2e 91/91. Red check: with the three production files reverted, 15 of the 17 new unit tests and the contract test fail.
REGRESSION RISKS:
- C2: data-saved is what this page last loaded or saved; if another tab changed the setting since, a refused save here puts back this page's older value (a reload shows the stored one).
- C4: after a failed reload the summary shows the previous figures (the toast says so) rather than nothing.
- C5: a falling checking balance is no longer red, and a credit card paid down is no longer green — by INV-148's rule, not a defect.
- C6: the heatmap's 90-day window start (completed_at >= the UTC date 90 days back) is unchanged, so its first day can be partial by a few hours west of UTC — the grid's oldest cell only.
INVARIANTS AT RISK: None broken. INV-148 now holds for the "Since you last looked" rows (C5); INV-157 (candidate — a refused Settings save puts the control back) now covers selects and boxes too (C2); INV-147 (C4 — the summary still from one request, fail-soft).
NET SCORE: 2 − 0 = +2 (production fixes this month: C5 — any falling checking balance read red on "Since you last looked", and a negative balance printed "$-X"; C6 — with APP_TIMEZONE west of UTC, every evening completion lands on tomorrow's heatmap cell. C2 / C3 / C4 need a refused save / a plan on the high-interest-debt step with a projection / a failed summary load — NO this month. No new failure mode.)

OPERATOR ACTIONS / DEPLOY:
- None | BLOCKS DEPLOY: N
Deploy: Web UI (Perfin) / Per-sistant Backend — Render auto-deploys on push to main.

FOLLOW-ON ITEMS:
- Per-sistant analytics' completed_by_day / created_by_day / productivity_by_dow and the week / month window still bucket in UTC (DATE(...) and toISOString) — the same class as C6, outside its scope (the heatmap only).
- Settings' cash-floor and budget-cap boxes keep a refused typed value (a Save-button form; the value is kept to correct) — consistent, but not the saveField rule.
- "Since you last looked" still colours its pills with inline var(--…) (Alerts red, New subs yellow) — not money amounts, left as is.
- The rest of audit #4 is done (S4-1..S4-5). Next per the plan: /test-sync, /sync-docs (INV-155..157 — 155/156 are in; add INV-157), then /reflect or the next /broad-scan.

DOCUMENTATION UPDATES NEEDED:
- CLAUDE.md: the audit #4 Known Open Issues entry (S4-5 done, every batch done; its follow-ons), the Settings layout paragraph (saveField beside saveToggle), the Since-you-last-looked widget (fmt + money classes), the "Your plan" / emergency-fund note, the Summary card's reload behaviour, INV-148 / INV-147 wording, a new INV-157, test counts (npm test 3188 across 176 files — Perfin 2445 + Per-sistant 743 — contract 340, the two new test files + the contract file); apps/per-sistant/CLAUDE.md: the Analytics heatmap's APP_TIMEZONE day.
---END BROAD SCAN IMPLEMENTATION SUMMARY---
