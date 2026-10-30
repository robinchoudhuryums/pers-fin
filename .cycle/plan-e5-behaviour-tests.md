# Cycle 8 E5 — behaviour tests (plan, 2026-10-30)

Status: E5a done (2026-10-30, block `.cycle/blocks/8-e5a-broad-implement.md`); E5b done (2026-10-30, block
`.cycle/blocks/8-e5b-broad-implement.md`); E5c queued.

Scope: ST4 from the cycle-8 expansion plan (`.cycle/plan-cycle8-expansion.md`): state-change assertions in
e2e for ~15 key actions.

Goal: a browser test fails when a key button stops doing its job. Today the seeded click sweep
(`e2e/pages.spec.js`, cycle-7 G2) presses ~230 controls and fails only on a page error, a console error or a
5xx — a Save that silently writes nothing, a toggle the server ignores, or a write the page never re-reads all
pass. E5 adds one test per key action that checks the new state on screen, in the API and after a reload, then
puts it back.

## What exists (read for this plan)
- **e2e layout:** `e2e/pages.spec.js` (every page loaded, the click sweep, ~20 targeted checks),
  `e2e/smoke.spec.js` (login, core pages), `e2e/seed.js` (seedPerfin / seedPersistent through the apps' own
  routes; the Job Radar listing and one linked task inserted directly). pages.spec's `beforeAll` logs in once,
  seeds, and every test reuses the cookie.
- **Already asserting a state change** (kept, not redone): the Cash Flow forecast setting saved and put back
  (E1b), a deleted transaction restored from Settings (T2.5 U2), quiet hours + a mute saved and reloaded
  (E3c), a Tax form added and marked received (T3.3 K4), the pyramid opened once and kept open after a reload
  (D4). The toast Undo test uses a fake `showMsg`, not a real delete.
- **Runner:** `e2e/playwright.config.js` sets no `workers` — locally files run in parallel, so a second spec
  file would run beside the click sweep, which presses Dismiss / Cancel / Save on whatever rows a page shows.
  CI's 2-core runner already gives Playwright one worker.
- **The seed is not idempotent:** a second `seedPerfin` duplicates "E2E Cash", the goal and the subscription,
  and its 1099-NEC POST answers 409 (the seed throws).

## Decisions (proposed; confirm at the first /broad-implement)
1. **A new file, `e2e/behaviour.spec.js`**, one `test.describe` run serially, one test per action. Each test:
   (a) does the action through the page the way a person would (click, type, select);
   (b) checks the page shows the new state;
   (c) checks the API agrees (a GET through `page.request`);
   (d) reloads and checks the state is still shown;
   (e) puts it back — through the page's own undo when the app has one (asserted the same way), else through
   the API — so it leaves the database as it found it.
2. **Its own data.** Each test creates what it acts on under a unique name (`E5 <action> <time>`) through the
   apps' routes, never touching seed.js's names or figures (rent owed, the tax year's $2,000 income, the
   seeded subscription) that pages.spec asserts. Two direct inserts, documented like the Job Radar one: an
   unread `notification_log` row for the bell (no route creates one without push keys) — nothing else.
3. **One worker:** `workers: 1` in the config (what CI already uses), so the behaviour file never runs beside
   the click sweep. Files run in name order; neither depends on the other's order.
4. **An idempotent seed:** `seed.js` gains `ensureSeeded(req)` — seeds once (the marker: the "E2E Cash"
   manual account) and on a later call reads back `manualAccountId` / `taxYear`; both spec files call it.
5. **Out of scope:** asserting inside the click sweep (it stays a crash sweep); visual / screenshot diffs;
   actions that need an outside service (Plaid / Teller Link, AI, push, Sheets, the vault, SMTP); new unit
   tests (each action's route and renderer already have them). A bug a test exposes is recorded in the
   summary as a follow-on (or fixed only when one line and in scope) — never by weakening the assertion.
6. **Mutation check per batch:** break each action's write or re-read once (e.g. drop the field from the
   PATCH, skip the reload of the list) and see its test go red, as the earlier batches did.

## The actions (16)
| # | Action | Page | State checked (page · API · after reload) | Put back by |
|---|--------|------|-------------------------------------------|-------------|
| 1 | Rename a merchant and add a note | Activity → Edit | the row's name and note · `user_merchant_name` / `user_notes` · both | the dialog (name cleared) |
| 2 | Mark a charge reimbursed | Activity → Edit | REIMBURSED badge · `is_reimbursed` · badge | the dialog (unticked) |
| 3 | Delete a duplicate, then Undo | Activity duplicate finder | row gone + toast · in `/api/deleted-transactions` · row back after Undo | the toast's Undo (asserted) |
| 4 | Apply a category from Review Uncategorized | Dashboard | row leaves the queue, count drops · `user_category`, no rule (Remember unticked) · not in the queue | none needed (its own row) |
| 5 | Mark a manual bill paid | Calendar | `aria-pressed="true"`, struck through · a `/api/bill-payments` row · pressed | pressing it again (asserted unpaid) |
| 6 | Add a budget that rolls over, then stop rollover | Budgets | card with "Rolls over" → gone · `rollover_enabled` · badge state | DELETE via the API |
| 7 | Record a rent payment | Rent | balance owed drops, payment in history · `/api/housing/ledger` · both | the payment's Undo (asserted owed again) |
| 8 | Cancel a subscription | Subscriptions | cancelled state · `cancelled_at` set · state | Uncancel on the page (asserted) |
| 9 | Log a credit score | Dashboard credit widget | the new score shown · `/api/credit-scores` · shown | DELETE via the API |
| 10 | Switch the theme | Settings | `html[data-theme]` · `theme` in `/api/settings` · after reload | switching back |
| 11 | Turn a dashboard widget off | Settings → dashboard | the dashboard section hidden (`.widget-off`) · `dashboard_widgets` · hidden | turning it on (asserted shown) |
| 12 | A switch whose save is refused goes back; a saved one stays | Settings (Insight emails) | refused (request routed to a 400): unticked again + toast; saved: ticked · `insight_emails_enabled` · ticked | switching back |
| 13 | Mark all notifications read | Bell | unread badge gone · `/api/notifications?unread=true` empty · gone | none (its own row) |
| 14 | Pin a note | Per-sistant Notes | "Pinned" on the card, first in the grid · `pinned` · both | unpinning (asserted) |
| 15 | Complete a todo and a subtask | Per-sistant To-Dos | done state, subtask ticked · `completed` · both | un-completing (asserted) |
| 16 | Log today's habit and save a job | Per-sistant Health / Jobs | today's cell marked, streak up · the log · marked; "saved" badge · `status` · badge | un-logging / Unsave (asserted) |

## Batches
| Batch | Scope | Est. | Status |
|-------|-------|------|--------|
| E5a | The harness (decisions 1–4: `e2e/behaviour.spec.js` with its helpers — a unique tag, `apiJson`, a reload-and-recheck step; `workers: 1`; `ensureSeeded` and both specs on it) and the Perfin money actions 1–8: Activity rename + note, reimbursed, delete → Undo (seeds its own duplicate pair), Review Uncategorized Apply, Calendar paid, budget rollover, rent payment + Undo, subscription cancel + Uncancel. Mutation check on three of them | ~3.5h | done |
| E5b | Perfin settings and chrome, actions 9–13: credit score, theme, a dashboard widget toggle, a refused / saved switch (F38's revert, through `page.route`), Mark all read (the one direct notification insert). Mutation check on two | ~2h | done |
| E5c | Per-sistant actions 14–16: pin a note, complete a todo + subtask, log a habit, save a job. Mutation check on two. CLAUDE.md / README counts are /sync-docs' job | ~2.5h | queued |

Order: E5a (the harness the other two use) → E5b → E5c. Total ≈ 8h. Then cycle 8's `/reflect`.

## Invariants
- INV-130 widened (E5a): the e2e run also holds one behaviour test per key action — each checks the page,
  the API and a reload after the action, then puts the state back; the seed runs once per run
  (`ensureSeeded`) and behaviour tests act only on entities they created (plus the documented direct inserts).
- No production invariant changes; a test that turns red on a real bug is a finding, not a test to loosen.

## Risks to watch
- **Order coupling:** the click sweep presses Dismiss / Cancel / Save on any row it sees. With one worker the
  behaviour file never overlaps it, and each behaviour test re-reads its own row before acting.
- **Run time:** `workers: 1` lengthens a local run (CI unchanged); the sweep is most of it.
- **Seeded figures:** a test that changed rent owed, the tax year's income or the seeded subscription would
  break pages.spec's checks — every test puts back what it changed, and rent / budget / credit tests use their
  own rows (the rent test pays one obligation and undoes it).
- **Dates:** the calendar and habit tests use today's month / today's local day — avoid the date-dependent
  traps already in the suite (31-day months); pick a manual bill due mid-month in the current month.
- **Flake:** wait on the page's own state (`expect(...).toHave…`, `expect.poll` on the API), never a sleep.
