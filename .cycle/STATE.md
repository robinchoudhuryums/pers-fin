# .cycle/STATE.md — In-Progress Cycle State

Tracks the *currently running* cycle so work can be resumed across sessions.
Read first by `/cycle-status` and `/cycle-resume`. When a cycle completes, its
results move to `PROJECT_HEALTH.md` + `.cycle/metrics.csv` and this file resets
to the "none in progress" state.

---

## Current Cycle

Cycle: 7
Phase: implement
Scope: broad (Oct 2026 broad scan — all non-frozen subsystems + cycle-6 policy responses)
Updated: 2026-10-23

(Machine-read fields for the v1.43.0 commands: the next /broad-scan,
/targeted-audit or /audit increments Cycle to 7 in its CYCLE OPEN step;
implement and reflect sessions only set Phase.)

- **Status:** **Roadmap T2.4 (cross-app automation) — X3b DONE; T2.4 COMPLETE** (2026-10-23,
  branch `claude/sweet-ritchie-f9d8ah`, PR robinchoudhuryums/pers-fin#133). Plan:
  `.cycle/plan-t2-4-crossapp-automation.md` (all seven batches DONE). Block:
  `.cycle/blocks/7-roadmap-t2-4-x3b-broad-implement.md`.
  - **Completed:** renderSearchResults (views/js.js) shared by the dashboard widget and the new
    Per-sistant /search page (?q=, focus, "/", URL follows the query); the Search sidebar entry
    and Perfin's embedded-only nav link to /per-sistant/search; INV-144; T2.4 marked DONE in
    Known Open Issues with its follow-ons.
  - **Tests:** npm 2237/2237 (14 new), contract 231/231, Playwright 61/61 (3 new); 15 mutations red.
  - **Where I left off:** X3b committed; roadmap T2.4 done. NEXT: `/reflect` to close cycle 7, or
    the next roadmap item.
- **Previous status:** **Roadmap T2.4 (cross-app automation) — X3a DONE** (2026-10-23, branch
  `claude/sweet-ritchie-f9d8ah`, PR robinchoudhuryums/pers-fin#133). Plan:
  `.cycle/plan-t2-4-crossapp-automation.md`. Block: `.cycle/blocks/7-roadmap-t2-4-x3a-broad-implement.md`.
  - **Completed:** Per-sistant's GET /api/search finance group under the shell
    (routes/finance-search.js — transactions at the user's share, subscriptions, manual bills,
    goals, accounts; read-only via perfinPool, fail-soft, 10 each); q 2-200 characters;
    linkedAppHref shared by the chip and the dashboard widget's finance links.
    Decision: the response stays one flat array — finance rows carry group 'finance'.
  - **Tests:** npm 2223/2223 (10 new), contract 231/231 (4 new), Playwright 58/58; 19/20
    mutations red, one equivalent.
  - **Where I left off:** X3a committed. NEXT: `/broad-implement X3b` (the /search page, nav
    links, INV-144, T2.4 close-out).
- **Earlier status (X2c):** **Roadmap T2.4 (cross-app automation) — X2c DONE** (2026-10-23, branch
  `claude/sweet-ritchie-f9d8ah`, PR robinchoudhuryums/pers-fin#133). Plan:
  `.cycle/plan-t2-4-crossapp-automation.md`. Block: `.cycle/blocks/7-roadmap-t2-4-x2c-broad-implement.md`.
  - **Completed:** Perfin Settings → Per-sistant Tasks (switch, sources — bills marked off by
    default — lead days, last-run line with named source errors, Run now; standalone note),
    POST /api/linked-tasks/run (501 / 409 / 400 / record), isRunning(), the X2 docs.
    Decision: the last-run line says "outstanding" (Perfin's due items, a hand-completed
    task included), not "open".
  - **Tests:** npm 2213/2213 (13 new), contract 227/227 (1 new), Playwright 58/58; 16
    mutations red.
  - **Where I left off:** X2c committed; X2 complete. NEXT: `/broad-implement X3a`.
- **Earlier status (X2b):** **Roadmap T2.4 (cross-app automation) — X2b DONE** (2026-10-23, branch
  `claude/sweet-ritchie-f9d8ah`, PR robinchoudhuryums/pers-fin#133). Plan:
  `.cycle/plan-t2-4-crossapp-automation.md`. Block: `.cycle/blocks/7-roadmap-t2-4-x2b-broad-implement.md`.
  - **Completed:** runLinkedTasks (single-flight, off memo, ok_kinds only, state record),
    the hourly `linked-tasks` away job, kick() after the housing + bill-payment writes, the
    still-charging task from the watchdog, settings invalidate.
  - **Tests:** npm 2200/2200 (13 new), contract 226/226 (6 new, cross-database); 14
    mutations red.
  - **Where I left off:** X2b committed. NEXT: `/broad-implement X2c` (the Settings section,
    POST /api/linked-tasks/run, X2 docs).
- **Earlier status (X2a):** **Roadmap T2.4 (cross-app automation) — X2a DONE** (2026-10-23, branch
  `claude/sweet-ritchie-f9d8ah`, PR robinchoudhuryums/pers-fin#133). Plan:
  `.cycle/plan-t2-4-crossapp-automation.md`. Block: `.cycle/blocks/7-roadmap-t2-4-x2a-broad-implement.md`.
  - **Completed:** user_settings.linked_tasks_* (switch, sources — bills off — lead 0–14,
    state) with GET defaults + strict PATCH; teller/services/linked-tasks.js
    computeLinkedTasks (housing per unpaid period in the reminder's window, utility amounts,
    manual bills; ok_kinds / errors per source); the housing reminder now shares
    periodDueDate / rentReminderOpen / utilityAmountDue. Refinements: a utility-amount task is
    due on its bill's date (not today); switched-off sources aren't read.
  - **Tests:** npm 2187/2187 (16 new), contract 220/220 (3 new), migration test passed;
    14 mutations red.
  - **Where I left off:** X2a committed. NEXT: `/broad-implement X2b` (runLinkedTasks, the
    hourly linked-tasks away job, the route hooks, still-charging, cross-DB contract).
- **Earlier status (X1b):** **Roadmap T2.4 (cross-app automation) — X1b DONE** (2026-10-23, branch
  `claude/sweet-ritchie-f9d8ah`, PR robinchoudhuryums/pers-fin#133). Plan:
  `.cycle/plan-t2-4-crossapp-automation.md`. Block: `.cycle/blocks/7-roadmap-t2-4-x1b-broad-implement.md`.
  - **Completed:** per-field snapshot refresh in syncLinkedTasks (`updated`; your edits win);
    the "Perfin" chip (views/js.js linkedTaskChip + window.LINKED_APP_BASES) on the To-Dos
    list, both dashboard task lists and the edit modal; a seeded linked task + a browser test.
    Decision: source_url is a path inside the source app, joined with its mount by the chip.
  - **Tests:** npm 2171/2171 (8 new), contract 217/217 (1 new), Playwright 58/58 (1 new);
    14 mutations red, one equivalent.
  - **Where I left off:** X1b committed; X1 complete. NEXT: `/broad-implement X2a` (Perfin
    settings + computeLinkedTasks).
- **Earlier status:** **Roadmap T2.4 (cross-app automation) — X1a DONE** (2026-10-23, branch
  `claude/sweet-ritchie-f9d8ah`, PR robinchoudhuryums/pers-fin#133). Plan:
  `.cycle/plan-t2-4-crossapp-automation.md` (decisions 1–8 accepted). Block:
  `.cycle/blocks/7-roadmap-t2-4-x1a-broad-implement.md`.
  - **Completed:** db/030 (todos.source_app / source_key / source_url / source_snapshot /
    auto_closed / source_detached; unique source_key covering trashed rows; the detach
    trigger) and services/linked-tasks.js (syncLinkedTasks / ensureLinkedTask). Refinement:
    hand completion is final through a trigger-set `source_detached` (every completion path,
    and a hand reopen is respected) rather than clearing auto_closed in each route.
  - **Tests:** npm 2163/2163 (16 new), contract 216/216 (10 new), migration test passed;
    11 mutations all red.
  - **Where I left off:** X1a committed. NEXT: `/broad-implement X1b` (edits win via
    source_snapshot + the "Perfin" chip + the e2e seed).
- **Earlier status:** **Roadmap T2.4 (cross-app automation) — PLANNED, split into 7 batches** (2026-10-23,
  branch `claude/sweet-ritchie-f9d8ah`, PR robinchoudhuryums/pers-fin#133). Plan:
  `.cycle/plan-t2-4-crossapp-automation.md`. X1a Per-sistant schema + sync core (db/030,
  syncLinkedTasks / ensureLinkedTask, hand completion final); X1b edits win + the "Perfin"
  chip; X2a Perfin settings + computeLinkedTasks (housing per period, utility amount,
  manual bills); X2b runLinkedTasks + the hourly `linked-tasks` job + write hooks +
  still-charging; X2c the Settings section + Run now + X2 docs; X3a finance results in
  Per-sistant's /api/search; X3b the `/search` page, nav links, INV-144, close-out.
  Decisions 1–8 are proposed; `/broad-implement X1a` accepts them.
  - **Where I left off:** plan split and committed. NEXT: `/broad-implement X1a`.
- **Earlier status:** **Roadmap T2.3 (AI cost cap for every Per-sistant feature) — C4 DONE; T2.3 COMPLETE** on branch
  `claude/sweet-ritchie-f9d8ah` (2026-10-23, in PR robinchoudhuryums/pers-fin#133). Plan:
  `.cycle/plan-t2-3-persistent-ai-cap.md`. Block: `.cycle/blocks/7-roadmap-t2-3-c4-broad-implement.md`.
  - **Completed:** ai.js getAiBudgetInfo (settings / env / default; the budget read from the
    wrapper's pool); GET /api/ai/usage (spend by feature in the APP_TIMEZONE month, the cap
    and its source, Perfin's spend via perfinPool); PATCH /api/settings ai_monthly_budget_cents
    (1–10000 or null, 400 otherwise); the AI limiter skipping the two read-only GETs; Settings →
    AI Features → Monthly AI budget (spend, source, breakdown, Perfin line, Save / Use default);
    the dashboard / Today / Review cards showing the budget message, the Review theme ignoring
    it, the Knowledge capture note; Perfin's /api/insights/status persistent_ai + its Settings
    line. INV-143. Docs (both CLAUDE.md files, README, Known Open Issues → T2.3 DONE).
  - **Verification:** npm 2147/2147 (22 new); contract 206/206 (3 new, both apps' real
    databases); Playwright 57/57; ten mutation checks red (one survivor pinned with a forced zone).
  - **Decisions:** each app only DISPLAYS the other's spend (separate caps, plan decision 2);
    the Per-sistant figure in Perfin is read with Per-sistant's own functions (one definition),
    only when the pool is wired, so a standalone Perfin never loads Per-sistant code; the usage
    card shows without an API key; Quick Add keeps its silent local-parser fallback.
  - **Where I left off:** C4 committed and pushed; roadmap T2.3 is complete. NEXT: the next
    roadmap item (or `/reflect` to close cycle 7).
- **Previous status:** **Roadmap T2.3 (AI cost cap for every Per-sistant feature) — C3 DONE** on branch
  `claude/sweet-ritchie-f9d8ah` (2026-10-23, in PR robinchoudhuryums/pers-fin#133). Plan:
  `.cycle/plan-t2-3-persistent-ai-cap.md`. Block: `.cycle/blocks/7-roadmap-t2-3-c3-broad-implement.md`.
  - **Completed:** apps/per-sistant/routes/rag.js — /query through cappedCitations + a
    cappedAI prompt-cite fallback (each a rag_query row; over the cap / unreadable spend →
    sources-only with ai_cap / ai_cap_check_failed + note, no fallback attempt, after the
    cache lookup); /diagram through cappedAI (rag_diagram; 429 / 503 via capResponse);
    /capture through cappedAI (rag_capture; over the cap the raw note is committed with
    ai_cap + note). capMessage / capResponse / isCapError moved into ai.js (routes/ai.js
    imports them). The no-direct-callAI guard's KNOWN_GAPS is empty. Two older test files'
    stubs moved from callAI to the cap layer. New unit file + contract file. Docs.
  - **Verification:** npm 2125/2125 (12 new); contract 203/203 (2 new); six mutation checks
    red (one survivor pinned with a cap-read count).
  - **Decisions:** an unreadable spend degrades /query to sources-only (not a 503) and
    /capture to the raw note, matching their AI-off paths; /query and /diagram still run
    retrieval before the cap refuses the model call.
  - **Where I left off:** C3 committed and pushed. NEXT: `/broad-implement C4` (usage
    endpoint, budget setting, Settings UI, side-by-side spend, INV-143, Playwright).
- **Previous status:** **Roadmap T2.3 (AI cost cap for every Per-sistant feature) — C2 DONE** on branch
  `claude/sweet-ritchie-f9d8ah` (2026-10-23, in PR robinchoudhuryums/pers-fin#133). Plan:
  `.cycle/plan-t2-3-persistent-ai-cap.md`. Block: `.cycle/blocks/7-roadmap-t2-3-c2-broad-implement.md`.
  - **Completed:** apps/per-sistant/routes/ai.js — the nine features on ai.cappedAI with their
    feature-name entry_types; capResponse (CAP → 429 { ai_cap }, CAP_CHECK_FAILED → 503) after the
    400s / 501; capBlock gates the briefing (after its cache, before its queries), Ask and Smart
    Suggestions (200 shapes + ai_cap / ai_cap_check_failed); Smart Suggestions' date / weekday /
    cache key in APP_TIMEZONE (timezone-lint KNOWN_GAPS entry removed); ai.js exports capError.
    New test file with the no-direct-callAI source guard (KNOWN_GAPS rag.js: 6). Docs.
  - **Verification:** npm 2113/2113 (14 new); contract 201/201; eight mutation checks red.
  - **Decisions:** Ask / Suggestions answer an unreadable spend with their 200 shape +
    ai_cap_check_failed (not a 503), matching their never-error posture; the routes without data
    queries rely on the wrapper's own check (no separate gate).
  - **Where I left off:** C2 committed and pushed. NEXT: `/broad-implement C3` (Knowledge query /
    diagram / capture on the wrappers; the guard's KNOWN_GAPS emptied; contract file).
- **Previous status:** **Roadmap T2.3 (AI cost cap for every Per-sistant feature) — C1 DONE** on branch
  `claude/sweet-ritchie-f9d8ah` (2026-10-23, in PR robinchoudhuryums/pers-fin#133). Plan:
  `.cycle/plan-t2-3-persistent-ai-cap.md`. Block: `.cycle/blocks/7-roadmap-t2-3-c1-broad-implement.md`.
  - **Completed:** apps/per-sistant/ai.js — checkAiCap (fails closed: CAP_CHECK_FAILED on an
    unreadable spend), cappedAI / cappedCitations (CAP before the call, one charge in a finally
    whenever tokens came back, a refusal included, a failed charge logged), callAIWithUsage
    effort + meta.stop_reason, answerWithCitations usage (+ on its REFUSAL error),
    monthlyAiSpendCents from the APP_TIMEZONE month start and throwing; Job Radar's cappedCall an
    alias that stops on CAP or CAP_CHECK_FAILED; the timezone-lint KNOWN_GAPS entry removed. Docs.
  - **Verification:** npm 2099/2099 (16 new); contract 201/201; the spend SQL checked on real
    Postgres in three zones; six mutation checks red.
  - **Decisions:** 1–7 accepted as planned; the cap reads go through module.exports so tests stub
    them; getAiBudgetCents keeps its env / default fallback (only the spend read fails closed).
  - **Where I left off:** C1 committed and pushed. NEXT: `/broad-implement C2` (the nine
    routes/ai.js features on cappedAI, capResponse, the no-direct-callAI guard).
- **Previous status:** **Roadmap T2.3 (AI cost cap for every Per-sistant feature) — PLANNED** (2026-10-23,
  branch `claude/sweet-ritchie-f9d8ah`, PR robinchoudhuryums/pers-fin#133). Plan:
  `.cycle/plan-t2-3-persistent-ai-cap.md` — C1 shared capped wrapper + tz month + fail-closed spend
  read, C2 the nine routes/ai.js features, C3 Knowledge query / diagram / capture, C4 usage
  endpoint + budget setting + Settings UI + side-by-side spend + INV-143 + docs. Decisions 1–7
  to accept with C1. **Where I left off:** plan written. NEXT: `/broad-implement C1`.
- **Previous status:** **Roadmap T2.2 (low-balance and payday alerts) — L4 DONE; T2.2 COMPLETE** on branch
  `claude/sweet-ritchie-f9d8ah` (2026-10-23, in PR robinchoudhuryums/pers-fin#133). Plan:
  `.cycle/plan-t2-2-cash-alerts.md`. Block: `.cycle/blocks/7-roadmap-t2-2-l4-broad-implement.md`.
  - **Completed:** linked_accounts.low_balance_floor (migration); PATCH /api/accounts/:id
    low_balance_floor (0-1e7 or null, cents, 400 on a non-spendable account, the memo reset);
    GET /api/accounts returns it; cash-alerts.js split into checkFloors + checkProjection — a
    floor below its account's fresh balance pushes "Low balance: <name>" once per account per
    24 h, push only; an unlogged floor push leaves the check unstamped; last_check.floors_below;
    Settings → Cash Alerts → Account Floors list + the last-evaluation line; INV-142; docs.
  - **Verification:** npm 2083/2083 (17 new); contract 201/201 (3 new); migrations twice OK;
    Playwright 57/57; six mutation checks red.
  - **Decisions:** floors ride the Low Cash Alert switch and its "something new" gate (no second
    job); push only (no email) for floors; each floor account is judged on its own balance's
    freshness; reset-fresh keeps linked_accounts, so a floor survives while the switch resets.
  - **Follow-ons:** see Known Open Issues (T2.2 L4 follow-ons).
  - **Where I left off:** L4 committed and pushed with docs; roadmap T2.2 is done. NEXT: the next
    roadmap item (`/roadmap`), or `/reflect` to close cycle 7.
- **Previous status:** **Roadmap T2.2 (low-balance and payday alerts) — L3 DONE** on branch
  `claude/sweet-ritchie-f9d8ah` (2026-10-23, in PR robinchoudhuryums/pers-fin#133). Plan:
  `.cycle/plan-t2-2-cash-alerts.md`. Block: `.cycle/blocks/7-roadmap-t2-2-l3-broad-implement.md`.
  - **Completed:** services/payday-alerts.js — runPaydayLanded (the third runPostSyncSteps step;
    stream-matched income deposits ≤ 5 days old created after a text watermark; held back on a
    throwing send) and runPaydayMissed (overduePayday past a 3-day grace, any-amount arrival,
    only after a clean connection sync, sentRecently dedup, memo, email after a logged push);
    the cash-alerts tick runs both checks isolated; payday_alerts_enabled + last_income_alert_at;
    PATCH strict boolean + the watermark CASE on switch-on; the Settings toggle. Docs folded in.
  - **Verification:** npm 2066/2066 (21 new); contract 198/198 (3 new); migrations twice OK;
    Playwright 57/57; four mutation checks red.
  - **Decisions:** the missed check sits beside runCashAlerts in the same job (works with the cash
    alert off); created_at round-trips as text (a JS Date drops microseconds and would re-announce);
    streams on CSV / manual accounts never alert as missed.
  - **Follow-ons:** see Known Open Issues (T2.2 L3 follow-ons).
  - **Where I left off:** L3 committed and pushed with docs. NEXT: `/broad-implement L4` (account
    floors, the last evaluation in Settings, reset-fresh check, INV-142, docs).
- **Previous status:** **Roadmap T2.2 (low-balance and payday alerts) — L2 DONE** on branch
  `claude/sweet-ritchie-f9d8ah` (2026-10-23, in PR robinchoudhuryums/pers-fin#133). Plan:
  `.cycle/plan-t2-2-cash-alerts.md`. Block: `.cycle/blocks/7-roadmap-t2-2-l2-broad-implement.md`.
  - **Completed:** services/cash-alerts.js (runCashAlerts — off memo, data-stamp gate, 36 h balance
    gate, forecast + firstBelow, once-per-breach dedup with 3-days-earlier / 72 h re-notify, email
    and state only after a logged push); the hourly "cash-alerts" away job + JOB_INTERVALS_MS;
    five user_settings columns; PATCH validation + memo reset; Settings → Cash Alerts. Docs folded in.
  - **Verification:** npm 2045/2045 (19 new); contract 195/195 (4 new); migrations twice OK;
    Playwright 57/57; four mutation checks red.
  - **Decisions:** the notification opens /dashboard (no hash — the section renders after load);
    an unlogged push leaves the check unstamped so the next tick retries; "unchanged" / "disabled"
    record no job outcome.
  - **Follow-ons:** see Known Open Issues (T2.2 L2 follow-ons).
  - **Where I left off:** L2 committed and pushed with docs. NEXT: `/broad-implement L3` (payday
    landed via runPostSyncSteps + missed payday inside runCashAlerts).
- **Previous status:** **Roadmap T2.2 (low-balance and payday alerts) — L1 DONE** on branch
  `claude/sweet-ritchie-f9d8ah` (2026-10-23, in PR robinchoudhuryums/pers-fin#133). Plan:
  `.cycle/plan-t2-2-cash-alerts.md` (decisions accepted). Block:
  `.cycle/blocks/7-roadmap-t2-2-l1-broad-implement.md`.
  - **Completed:** services/cash-flow.js — getCashFlowInputs (the forecast's reads, moved),
    the pure projectCashFlow (calendar-date days from the APP_TIMEZONE today, the daily
    projection + the lowest day), firstBelow, getCashFlowForecast; GET /api/cash-flow a thin
    wrapper adding lowest_balance / lowest_balance_date; the dashboard "Lowest projected" figure.
    Docs folded in.
  - **Verification:** npm 2026/2026 (18 new); contract 191/191 (2 new); Playwright 57/57; no
    schema change; three mutation checks red.
  - **Decisions:** the route returns the old fields + the lowest day, never the daily series; the
    60-day spending averages keep their CURRENT_DATE window (documented rolling window).
  - **Follow-ons:** see Known Open Issues (T2.2 L1 follow-ons).
  - **Where I left off:** L1 committed and pushed with docs. NEXT: `/broad-implement L2` (low
    projected cash alert — settings, runCashAlerts, the cash-alerts away job, Settings form).
- **Previous status:** **Roadmap T2.1 (bank webhooks) — W6 DONE; T2.1 COMPLETE** on branch
  `claude/sweet-ritchie-f9d8ah` (2026-10-22, in PR robinchoudhuryums/pers-fin#133). Plan:
  `.cycle/plan-t2-1-webhooks.md`. Block: `.cycle/blocks/7-roadmap-t2-1-w6-broad-implement.md`.
  - **Completed:** services/webhook-status.js (getWebhookStatus — per-provider last event / 24h
    events + failures from webhook_events, the Plaid registration under PUBLIC_URL, the Teller
    enrollment count; webhookChecks — webhooks:plaid warn while a connection isn't registered,
    info off / quiet 7 days; webhooks:teller info off / quiet); operator-checks includes them
    (precomputed status reused); data-health returns webhooks + connections (each enrollment's /
    item's own last_synced_at) and raises failed webhook events; Settings → Sync Health Webhooks
    line, "Register Plaid webhooks" button (data-e2e-skip) and Connections list. Docs folded in
    (new INV-141).
  - **Verification:** npm 2008/2008 (13 new); contract 189/189 (3 new); Playwright 57/57; no schema
    change (migrations not re-run); three mutation checks red.
  - **Decisions:** registration = webhook_url prefix of PUBLIC_URL + /api/webhooks/plaid suffix (no
    mount knowledge needed, works for the watchdog); per-connection freshness is data + UI only (no
    issue — partial syncs already report via last_sync_result); no new endpoint (data-health carries
    it; the router before auth must not gain a GET).
  - **Follow-ons:** see Known Open Issues (T2.1 W6 follow-ons); confirm Teller's signature format and
    payload before switching Teller on.
  - **Where I left off:** W6 committed and pushed with docs; roadmap T2.1 complete. Roadmap T2.2
    (low-balance and payday alerts) is PLANNED in `.cycle/plan-t2-2-cash-alerts.md` — batches
    L1–L4, decisions proposed. NEXT: accept / change the decisions, then `/broad-implement L1`.
- **Previous status:** **Roadmap T2.1 (bank webhooks) — W5 DONE** on branch `claude/sweet-ritchie-f9d8ah`
  (2026-10-22, in PR robinchoudhuryums/pers-fin#133). Plan: `.cycle/plan-t2-1-webhooks.md`.
  Block: `.cycle/blocks/7-roadmap-t2-1-w5-broad-implement.md`.
  - **Completed:** enrollments.js — syncOneTellerEnrollment (the per-enrollment body of
    syncAllEnrollments, + teller_enrollments.last_synced_at on a clean run) and
    syncTellerEnrollment(id) (coalesced per enrollment, nothing global); routes/teller-webhook-
    events.js (transactions.processed → the enrollment by id or by its transactions' account ids →
    runPostSyncSteps; enrollment.disconnected → GOOD → DISCONNECTED + one notification with the reason
    in words; webhook.test done) as the router's Teller handler; the verifier passes payload.reason +
    the transactions' account ids (never the transactions). Docs folded in (new INV-140).
  - **Verification:** npm 1995/1995 (15 new); contract 186/186 (3 new); migrations twice OK;
    Playwright not re-run (no page / mount change); three mutation checks red.
  - **Decisions:** both payload shapes handled (enrollment_id or account ids only) since Teller's
    docs were unreachable again; the DISCONNECTED write in a failed sync is now fail-soft (logged) so
    syncOneTellerEnrollment never throws.
  - **Follow-ons:** confirm Teller's signature header + transactions.processed payload against its
    docs before switching it on; Teller per-enrollment sync not serialized with syncAllEnrollments.
  - **Where I left off:** W5 committed and pushed with docs. NEXT: W6 (Sync Health visibility +
    Register button + operator checks + per-connection freshness).
- **Previous status:** **Roadmap T2.1 (bank webhooks) — W4 DONE** on branch `claude/sweet-ritchie-f9d8ah`
  (2026-10-22, in PR robinchoudhuryums/pers-fin#133). Plan: `.cycle/plan-t2-1-webhooks.md`.
  Block: `.cycle/blocks/7-roadmap-t2-1-w4-broad-implement.md`.
  - **Completed:** plaid-webhook-events.js — ITEM events (re-auth ERROR / PENDING_EXPIRATION /
    PENDING_DISCONNECT / USER_PERMISSION_REVOKED set last_error_code, LOGIN_REPAIRED clears,
    NEW_ACCOUNTS_AVAILABLE notifies ≤1/day), HOLDINGS → syncAllPlaidHoldings({ itemId }),
    INVESTMENTS_TRANSACTIONS → syncAllPlaidInvestmentFlows({ itemId }) (new filter); lookup in
    plaid_items + plaid_investment_items. Registration: hosting.webhookBaseUrl (PUBLIC_URL only),
    plaidWebhookUrl(req) on the four linkTokenCreate calls, webhook_url columns recorded at
    exchange, POST /api/plaid/webhooks/register (itemWebhookUpdate per Item). Advance warnings
    (PENDING_*) survive a clean sync (setPlaidItemErrorCode keepWarnings); per-code notification
    text. Verifier passes error.error_code. Docs folded in (new INV-139).
  - **Verification:** npm 1980/1980 (17 new); contract 183/183 (5 new); migrations twice OK;
    Playwright not re-run (no page / mount change; link tokens unchanged without PUBLIC_URL);
    three mutation checks red.
  - **Decisions:** opt-in is PUBLIC_URL alone (never RENDER_EXTERNAL_URL — plan decision 1);
    PENDING_* are advance warnings only a re-authentication clears; investments-only Items'
    re-auth events ignored (no column); NEW_ACCOUNTS_AVAILABLE deduped with sentRecently 24h.
  - **Follow-ons:** investments-only re-auth signal; confirm update mode repairs
    USER_PERMISSION_REVOKED and accepts `webhook`; holdings sync not serialized with a webhook run.
  - **Where I left off:** W4 committed and pushed with docs. NEXT: W5 (Teller events) — confirm
    Teller's signature format first.
- **Previous status:** **Roadmap T2.1 (bank webhooks) — W3 DONE** on branch `claude/sweet-ritchie-f9d8ah`
  (2026-10-22, in PR robinchoudhuryums/pers-fin#133). Plan: `.cycle/plan-t2-1-webhooks.md`.
  Block: `.cycle/blocks/7-roadmap-t2-1-w3-broad-implement.md`.
  - **Completed:** investments.js — syncOnePlaidItem (one item's whole sync, the loop body of
    syncAllPlaidTransactionsOnce), syncPlaidItem(id) (one GOOD item under withPlaidTxnLock, coalesced
    per item with a re-run-once flag, nothing global recorded); plaid_items.last_synced_at (stamped
    when the walk reached the end of the cursor); enrollments.js runPostSyncSteps(added) (rename
    rules + one anomaly check, serialized) used by syncAllTransactions; routes/plaid-webhook-events.js
    (SYNC_UPDATES_AVAILABLE → that item → post-sync steps; everything else 'ignored') as the router's
    Plaid handler. Docs folded in (new INV-138, INV-67 widened).
  - **Verification:** npm 1963/1963 (19 new); contract 178/178 (3 new); migrations twice OK;
    Playwright not re-run (no page / mount change); three mutation checks red.
  - **Decisions:** last_synced_at = "caught up" (not stamped on a stuck / still-paging walk;
    sync_cursors.last_synced_at keeps its per-page meaning); a failed item sync still runs the
    post-sync steps for rows it added, then fails the event; post-sync steps serialized globally.
  - **Follow-ons:** update-complete doesn't stamp last_synced_at (own steps); W4–W6 remain.
  - **Where I left off:** W3 committed and pushed with docs. NEXT: W4 (Plaid item events +
    webhook registration).
- **Previous status:** **Roadmap T2.1 (bank webhooks) — W2 DONE** (+ W1's docs) on branch
  `claude/sweet-ritchie-f9d8ah` (2026-10-22, in PR robinchoudhuryums/pers-fin#133). Plan:
  `.cycle/plan-t2-1-webhooks.md`. Block: `.cycle/blocks/7-roadmap-t2-1-w2-broad-implement.md`.
  - **Completed:** services/webhook-verify.js — Plaid ES256 JWT (kid key fetch + 24h cache,
    expired_at refused, iat 5 min, body hash) and Teller HMAC (t window, rotation, digest compares);
    the production router uses them; verified events recorded and marked 'ignored' (no handlers).
    CLAUDE.md / README updated for W1 + W2 (new INV-137).
  - **Verification:** npm 1944/1944; contract 175/175; Playwright not re-run (no page / mount
    change; 57/57 on W1); two mutation checks red.
  - **Decisions:** Plaid dedupe = hash of the signed JWT; Teller = event id (signature hash if none).
  - **Follow-ons:** confirm Teller's signature format against its docs (unreachable from the build
    environment) and whether Plaid retries non-200 deliveries.
  - **Where I left off:** W2 committed and pushed with docs. NEXT: W3 (Plaid per-item sync:
    syncOnePlaidItem + runPostSyncSteps + SYNC_UPDATES_AVAILABLE handler + plaid_items.last_synced_at).
- **Previous status:** **Roadmap T2.1 (bank webhooks) — W1 DONE** on branch `claude/sweet-ritchie-f9d8ah`
  (2026-10-22, in PR robinchoudhuryums/pers-fin#133). Plan: `.cycle/plan-t2-1-webhooks.md` (W1–W6).
  Block: `.cycle/blocks/7-roadmap-t2-1-w1-broad-implement.md`.
  - **Completed:** routes/webhooks.js — POST /api/webhooks/{plaid,teller} (body required + 512 KB
    cap, 503 until a verifier is configured, 401 + per-IP limiter on failed verification, record in
    webhook_events under a provider dedupe key, 200 then a detached handler, done / ignored / failed,
    30-day prune); mounted before session / auth / CSRF / API key / activity; the shell exempts
    exactly the two POSTs; webhook_events table (UNTOUCHED by reset-fresh).
  - **Verification:** npm 1930/1930; contract 173/173; migrations ×2; Playwright 57/57; two mutation
    checks red.
  - **Decisions:** dedupe key is provider-supplied (Teller event id; Plaid JWT hash in W2) — a Plaid
    body hash would drop legitimate identical SYNC_UPDATES_AVAILABLE events.
  - **Follow-ons:** a row left 'processing' by a restart stays so (W6 shows it).
  - **Where I left off:** W1 committed and pushed; /sync-docs not yet run for it. NEXT: W2
    (signature verification) — confirm Teller's signature header format against its docs first.
- **Previous status:** **Seams & Invariants audit #3 DONE** on branch `claude/sweet-ritchie-f9d8ah`
  (2026-10-22, in PR robinchoudhuryums/pers-fin#133). Block: `.cycle/blocks/7-seams3-audit.md`.
  - **Completed:** 16 confirmed findings fixed (X1 WebAuthn double-encoded credential ids + migration
    repair, C1 manual accounts in /api/items, S1 one reconcile at a time, S2 seasonal partial month, X3
    digest recipient chain, O1–O3 reindex workflow + reconcile error text, S3–S6, X2, X6, C4, C5,
    INV-104 standalone compares) + doc/comment drift; new INV-136; SX3 / literal-CASE / timezone
    guards widened.
  - **Verification:** npm 1915/1915; contract 167/167; migrations ×2 OK; Playwright 57/57; mutation
    checks red.
  - **Follow-ons:** in CLAUDE.md Known Open Issues ("Seams & Invariants audit #3 follow-ons").
  - **Where I left off:** audit committed and pushed; seams counter reset to 0. NEXT: per rotation,
    or /reflect / health synthesis if wanted.
- **Previous status:** **Post-cycle-7 roadmap — T1.5 Batch C DONE** on branch `claude/sweet-ritchie-f9d8ah`
  (2026-10-22, in PR robinchoudhuryums/pers-fin#133). Per-sistant quick wins. Block:
  `.cycle/blocks/7-roadmap-t1-batchC-broad-implement.md`. Roadmap T1.4 + T1.5 (Batches A–C) are
  complete; next is the Seams & Invariants audit (counter at 3).
  - **Completed:** C1 attachments sent by Send Now + the scheduler (loadEmailAttachments, 20MB cap,
    a missing file refuses the send); C2 failed email error + Retry in the Emails list; C3 AI routes
    501 without a key (after their own 400s) + the Review page gate; the e2e KNOWN_GAPS entry removed.
  - **Verification:** npm 1890/1890; contract 165/165; Playwright 57/57; one mutation check red. Net 2.
  - **Decisions:** the 501 comes after each route's own 400s (existing tests pin input validation
    without a key); Send Now refuses before claiming, the scheduler fails the claimed row.
  - **Follow-ons:** compose dialog doesn't list attachments; Retry sends a failed scheduled email now.
  - **/sync-docs DONE (Batch C):** CLAUDE.md — Known Open Issues (Batch 11 attachments / Retry and the
    review-summary 500 removed; Batch C follow-ons), the e2e KNOWN_GAPS note (empty), new INV-135, counts
    1890 / 93 files / Per-sistant 545 / contract 165 + test-file descriptions. Per-sistant CLAUDE.md —
    Email senders + attachments, failed-email Retry, File Attachments, the AI routes' 501, the Review gate,
    Commands, the test file, 545. README — counts and coverage. Subsystem paths and operator state unchanged.
  - **Where I left off:** Batch C + its /sync-docs committed and pushed. NEXT: the Seams & Invariants audit.
- **Previous status:** **Post-cycle-7 roadmap — T1.5 Batch B DONE** on branch `claude/sweet-ritchie-f9d8ah`
  (2026-10-22, in PR robinchoudhuryums/pers-fin#133). Perfin quick wins. Block:
  `.cycle/blocks/7-roadmap-t1-batchB-broad-implement.md`. Next: Batch C (Per-sistant: attachments on
  send, failed-email error + Retry, AI routes 501 without a key), then the Seams & Invariants audit
  (counter at 3).
  - **Completed:** B1 dashboard charts + the category-month selector redraw from the fresh summary
    after a sync / detection / split change (chart instances destroyed and redrawn, canvas kept for
    the empty state); B2 Budgets month navigation + GET /api/budgets/one-time links to one-month
    budgets in other months; B3 PATCH /api/merchant-rename-rules/:id (rename / off / on) + Settings
    Edit and Turn off / on.
  - **Verification:** npm 1879/1879; contract 160/160; Playwright 57/57; two mutation checks red. Net 0.
  - **Decisions:** other-month budgets come from a separate route (GET /api/budgets stays an array);
    turning a rule off behaves like Delete (no re-key / re-detect).
  - **Follow-ons:** off / delete leave detection keyed on the rule's name; pattern not editable; the
    Budgets page month is the browser's.
  - **/sync-docs DONE (Batch B):** CLAUDE.md — budgets.js + merchant-rename.js entries, Features
    (dashboard chart redraw, Budgets month navigation, rename-rule Edit / off / on), Commands (GET
    /api/budgets/one-time, PATCH /api/merchant-rename-rules/:id), Known Open Issues (Batch 10 / 15
    follow-ons narrowed; Batch B follow-ons), INV-124 widened, counts 1879 / 92 files / Perfin 1345 /
    contract 160 + test-file descriptions. README — counts, coverage text, one endpoint row. Subsystem
    paths and operator state unchanged.
  - **Where I left off:** Batch B + its /sync-docs committed and pushed. NEXT: `/broad-implement Batch C`.
- **Previous status:** **Post-cycle-7 roadmap — T1.4 Batch A DONE** on branch `claude/sweet-ritchie-f9d8ah`
  (2026-10-22). Error log + uptime. Block: `.cycle/blocks/7-roadmap-t1-batchA-broad-implement.md`.
- **Previous status:** **Cycle 7 — expansion Batch 20 DONE** on branch `claude/sweet-ritchie-f9d8ah`
  (2026-10-21). Browser quality (G2 remaining) + the Per-sistant client kit (ST3), from
  `.cycle/plan-cycle7-expansion.md`. Block: `.cycle/blocks/7-batch20-broad-implement.md`.
  Cycle 7's planned work (scan Batches 1–13, deferred 14–16, expansion 17–20) is complete.
  - **Completed:** views/js.js withPending(btn, key, fn, busyText) + the 10 hand-rolled pending
    toggles migrated (Send Now, AI draft / tone / breakdown / parse / tags, Knowledge reindex +
    capture, Job Radar Refresh, Ask) + a shrinking guard; e2e/seed.js (both apps seeded through
    their routes, one Job Radar row direct), console.error failures and a click sweep on all 22
    pages (data-e2e-skip on destructive / off-app / device controls, SWEEP_KNOWN_GAPS).
  - **Verification:** npm 1832/1832; contract 152/152; migrations twice; Playwright 57/57 (220
    controls pressed); the ST3 guard goes red on a planted toggle. Net 0. The sweep found no app bug
    (its first-run failures were the microphone buttons and Teller Connect — skipped).
  - **Decisions:** seeding lives in pages.spec.js's beforeAll (webServer readiness would race a
    boot-server seed); the sweep skips by data-e2e-skip AND a destructive-label regex for runtime
    row buttons; withPending restores each button's own prior disabled state.
  - **Follow-ons:** the sweep counts controls on load only (dialogs / rows rendered after a click
    aren't swept — Activity's rows); the mic buttons only log a refused permission; unguarded Save
    buttons not covered by withPending.
  - **/sync-docs DONE (Batch 20):** CLAUDE.md — the CI e2e description (seeded run, console
    errors, click sweep, data-e2e-skip convention, 57 tests), Known Open Issues (Batch 20 done —
    planned work complete; Batch 20 follow-ons), new INV-129 (withPending + data-e2e-skip), counts
    1832 / 89 files / Per-sistant 534 + the new test file. Per-sistant CLAUDE.md — withPending in the
    client kit, the test file, 534. README — counts, coverage and e2e text. Subsystem paths and
    operator state unchanged.
  - **Where I left off:** Batch 20 + its /sync-docs committed and pushed (no PR). NEXT: `/reflect`
    to close cycle 7.
- **Previous status:** **Cycle 7 — expansion Batch 19 DONE** on branch `claude/sweet-ritchie-f9d8ah`
  (2026-10-21). Plaid Link update mode (G3) + the Batch 4 investments-exchange duplicate-guard
  follow-on, from `.cycle/plan-cycle7-expansion.md`. Block: `.cycle/blocks/7-batch19-broad-implement.md`.
  - **Completed:** investments.js — POST /api/plaid/link-token-update (the item's own token, no
    products, account selection on; decryption_failed 409) and POST /api/plaid/update-complete (no
    exchange; transactions: register accounts → clear last_error_code → sync that item under the
    Plaid lock; investments: holdings sync for that Item via syncAllPlaidHoldings({ itemId })); the
    investments-only exchange refuses a duplicate (findDuplicateInvestmentItem + the new
    investment_accounts.mask); the F18 text points to Re-authenticate / Add accounts; a NEW re-auth
    code notifies once (url /accounts). GET /api/items carries last_error_code; the data-health issue
    links to /accounts (Settings + dashboard strip render issue links); Accounts page buttons.
  - **Verification:** npm 1825/1825; contract 152/152; migrations twice; Playwright 35/35; two mutation
    checks red. Net −1.
  - **Decisions:** update mode uses the in-page Link (popup OAuth), not the hosted flow; the
    investments-only duplicate match is institution name + mask + type (investment_accounts has no item
    link); update-complete does no balance / liabilities refresh (the next sync does).
  - **Follow-ons:** no hosted (iOS Safari) update mode; no last_sync_result write from update-complete;
    investments-only Items never flagged for re-auth; new brokerage accounts on a Transactions Item wait
    for the next holdings sync.
  - **/sync-docs DONE (Batch 19):** CLAUDE.md — investments.js entry (update-mode routes + both
    duplicate guards), Features (Plaid-linked: Link update mode + the re-auth notification), the
    re-auth gotcha rewritten (Re-authenticate / Add accounts; only decryption_failed needs unlink +
    link), Commands (/api/items last_error_code, /api/plaid/exchange guard, link-token-update,
    update-complete, the F18 409 text), Database (last_error_code changes-only + notification;
    investment_accounts.mask), Sync Health issue link, Known Open Issues (Batch 19 done; the Batch 4
    G3 / investments-guard bullet removed; Batch 19 follow-ons), INV-107 widened, new INV-128, counts
    1825 / 88 files / Perfin 1298 / contract 152 + test-file descriptions. README — counts, two
    endpoint rows, coverage text. Per-sistant docs unchanged. Subsystem paths unchanged.
  - **Where I left off:** Batch 19 + its /sync-docs committed and pushed (no PR). NEXT:
    `/broad-implement Batch 20` (browser quality + the Per-sistant client kit, G2 + ST3) → /reflect.
- **Earlier status:** **Cycle 7 — expansion Batch 18 DONE** on branch `claude/sweet-ritchie-f9d8ah`
  (2026-10-21). Asynchronous sync for the backstops (ST1) + the Batch 3 workflow-timeout
  follow-on, from `.cycle/plan-cycle7-expansion.md`. Block: `.cycle/blocks/7-batch18-broad-implement.md`.
  - **Completed:** enrollments.js background tracker (bgJobs by kind, reconcileJob folded in),
    runTransactionSync / runBalanceSync + sharedRun single-flight, `background: true` on /api/sync and
    /api/sync-balances (202 + id, 409 follows), GET /api/sync/status?kind=; daily-sync + weekly-reconcile
    use run_background (poll by id, 20-minute deadline, fixed error lines, allowlisted counts only);
    check_status in weekly-reconcile / knowledge-reindex / job-radar.
  - **Verification:** npm 1807/1807; contract 146/146; migrations twice; Playwright 35/35; the bash
    helper run against a fake server; one mutation check red. Net 0.
  - **Decisions:** the status's error is a fixed sentence (never an exception message — public logs);
    a poller follows a 409'd run by its id; a missing id = "lost"; synchronous answers unchanged.
  - **Follow-ons:** snapshot / detection steps still synchronous; knowledge-reindex prints vault JSON on
    failure; job slots in memory only.
  - **/sync-docs DONE (Batch 18):** CLAUDE.md — enrollments.js background-tracker note, the
    workflow-hygiene paragraph (check_status everywhere, RUN_BACKGROUND / run_background, poll by
    id, 20-minute deadline), Commands (/api/sync + /api/sync-balances background mode, the
    reconcile 202 shape, new GET /api/sync/status), the limiter note, Scheduled Tasks backstop
    text, Known Open Issues (Batch 18 done; the Batch 3 curl-timeout follow-on resolved; Batch 18
    follow-ons), new INV-127, counts 1807 / 87 files / Perfin 1280 / contract 146 + test-file
    descriptions. README — counts and coverage. Per-sistant docs unchanged (no Per-sistant code
    or test change). Subsystem paths unchanged.
  - **Where I left off:** Batch 18 + its /sync-docs committed and pushed (no PR). NEXT:
    `/broad-implement Batch 19` (Plaid Link update mode, G3) → 20 → /reflect.
- **Previous status:** **Cycle 7 — expansion Batch 17 DONE** on branch `claude/sweet-ritchie-f9d8ah`
  (2026-10-21). Operator visibility (G1 remaining + ST4), from `.cycle/plan-cycle7-expansion.md`.
  Block: `.cycle/blocks/7-batch17-broad-implement.md`.
  - **Completed:** teller/services/github-ops.js (read-only GitHub checks: backstop workflow state +
    latest run, last successful backup ≤36h, workflow secret names, repo visibility; fail-soft, token
    never logged/returned) + teller/services/operator-checks.js (6h cache, single-flight; local checks
    incl. the F14 cert moved out of data-health; Knowledge parse-version check via persistentPool;
    toIssues; notifyIfChanged on user_settings.operator_checks_signature). GET /api/operator-checks,
    data-health operator issues + operator_checks, Settings → Sync Health "Operator Checks" + Check now,
    watchdog refresh + notification. Per-sistant VAULT_PARSE_VERSION = 2 stamped by a successful FULL
    sync (db/029).
  - **Verification:** npm 1792/1792; contract 144/144; migrations twice (29 Per-sistant files);
    Playwright 35/35; two mutation checks red. Net −1 (new capability; standing warning noise).
  - **Decisions:** GitHub part cached 6h and never awaited by data-health; notification skipped while
    any GitHub check is unknown; disabled optional workflows (keep-alive, job-radar, knowledge-reindex)
    warn, critical ones fail; the parse version starts at 2 so existing vaults are asked for one reindex.
  - **Operator:** set GITHUB_OPS_TOKEN (fine-grained, read-only Actions/Metadata/Secrets) +
    GITHUB_OPS_REPO on Render; then act on the list.
  - **Follow-ons:** feature-aware workflow checks; secrets presence only; parse version not on the
    Knowledge page; github.com only.
  - **/sync-docs DONE (Batch 17):** CLAUDE.md — github-ops.js / operator-checks.js architecture
    entries + Platform subsystem paths, Sync Health card (Operator Checks), data-health + new GET
    /api/operator-checks endpoint, env GITHUB_OPS_TOKEN / GITHUB_OPS_REPO, Operator state item 3
    (VAULT_PARSE_VERSION) + item 5 updated + new item 6 (GitHub ops token), scheduled-tasks caveat +
    watchdog step, user_settings.operator_checks_signature, new INV-126, Known Open Issues (expansion
    re-cut into Batches 17–20, Batch 17 follow-ons), counts 1792 / 86 files / Perfin 1265 /
    Per-sistant 527 / contract 144 + test-file descriptions. apps/per-sistant/CLAUDE.md — db/029 +
    "bump VAULT_PARSE_VERSION" note, test file, counts. README — counts and coverage lines.
  - **Where I left off:** Batch 17 + its /sync-docs committed and pushed (no PR). NEXT:
    `/broad-implement Batch 18` (async sync, ST1) → 19 → 20 → /reflect.
- **Previous status:** **Cycle 7 — Oct 2026 broad scan, Batch 16 DONE** on branch
  `claude/sweet-ritchie-f9d8ah` (2026-10-21). Imports, exports and privacy (F26, F81, F85,
  F134 → ST5), the last batch of `.cycle/plan-cycle7-deferred.md`. Block:
  `.cycle/blocks/7-batch16-broad-implement.md`.
  - **Completed:** F26 generic-CSV sign (guessGenericSign, positive_means on preview + import via
    parseCsvUpload, the select on both upload forms, CLI --positive-means); F81 insight_emails_enabled
    (default true, strict-boolean PATCH, Settings toggle, generateInsights skips the email when false)
    + the standalone text / log lines now name PATCH /api/settings; F85 month-archive fingerprint
    (ARCHIVE_MONTHS_SQL, marker "… — YYYY-MM · <12 hex>", a mismatch or legacy marker rebuilds the
    tab within the per-run cap); ST5 notes.sensitivity (db/028) — only normal notes embedded /
    retrieved / in Ask / AI-tagged, chunks dropped when a note leaves normal, secret text masked in
    lists, search, labels, and webhook titles.
  - **Verification:** npm 1773/1773 (Perfin 1249 + Per-sistant 524, 84 files); contract 142/142;
    migrations twice; Playwright 35/35; two mutation checks red. Net score −1 (1 fix − 2 new modes).
  - **Follow-ons:** an all-deleted archived month keeps its tab; sign choice not remembered per
    account; no standalone Settings form for the webhook; note_created webhook sends a private
    note's title; Secret lookup doesn't cover secret notes.
  - **/sync-docs DONE (Batch 16):** CLAUDE.md — csv-formats / sheets-sync / CLI entries, CSV
    import (generic sign), insight email toggle, Sheets archive tabs (fingerprint), endpoints
    (/api/import-csv*, PATCH /api/settings), user_settings.insight_emails_enabled, INV-27
    (notes), INV-59, INV-84 reworded, new INV-125 (CSV sign), Known Open Issues (Batch 16 done,
    the stale F81 text bullet removed, Batch 16 follow-ons), counts 1773 / 84 files / Perfin
    1249 / Per-sistant 524 / contract 142 + test-file descriptions. apps/per-sistant/CLAUDE.md —
    Notes privacy tier, db/028 + test file, notes / suggest-tags endpoints, secret tier note,
    test counts. README — counts, coverage and contract lines.
  - **Where I left off:** Batch 16 + its /sync-docs committed and pushed (no PR). The deferred
    plan (Batches 14–16) is complete. The expansion E-batches don't each fit one
    /broad-implement run (E1 ≈ 18–20h, E2 ≈ 13h, E4 ≈ 2h vs the ~8–12h a run holds), so they
    were re-cut into `.cycle/plan-cycle7-expansion.md`: Batch 17 operator visibility (G1 + ST4),
    Batch 18 async sync for the backstops (ST1), Batch 19 Plaid Link update mode (G3), Batch 20
    browser quality + Per-sistant client kit (G2 + ST3). NEXT: `/broad-implement Batch 17`,
    then 18 → 19 → 20, then /reflect to close cycle 7.
- **Previous status:** **Cycle 7 — Oct 2026 broad scan, Batch 15 DONE** on branch
  `claude/sweet-ritchie-f9d8ah` (2026-10-21). Subscription watchdog (F53 → G5) + merchant rename
  rules (F55 → ST2), from `.cycle/plan-cycle7-deferred.md`.
  - **Completed:** runSubscriptionWatchdog after every detection (still charging > 7 days after
    cancel within ±25%, one alert per charge; price rise ≥ 5% or ≥ $1 within 45 days, one alert per
    price) + STILL CHARGING / PRICE UP badges; merchant_rename_rules + routes/merchant-rename.js
    (raw-merchant match, NULL-only fill, user_merchant_rule_id, re-key of detection rows keeping
    user state, revert on delete), applied at sync (before anomaly), in the CSV import transaction
    and on manual entry; Edit dialog "Apply to all past and future"; Settings rename-rules panel.
  - **Decisions:** reuse prior_amount (already maintained by detection) instead of a new
    previous_amount column; the watchdog lives in routes/subscriptions.js (it notifies); rule rows
    tracked by user_merchant_rule_id so a delete reverts only them; CSV rule-apply moved inside the
    import transaction (savepoint) after a test hang exposed the post-COMMIT pool call.
  - **Results:** npm 1755/1755 (82 files), contract 134/134, migrations ×2, Playwright 35/35.
    Net 0 − 2 = −2. Block: `.cycle/blocks/7-batch15-broad-implement.md`.
  - **Follow-ons:** watchdog only with detection (not hourly auto-sync); no price-drop alert;
    rename rules not editable / not applied by the CSV CLI / no Sheets tab; re-key clash doesn't
    merge user state.
  - **/sync-docs DONE (Batch 15):** CLAUDE.md — architecture tree (merchant-rename.js entry,
    watchdog note on subscriptions.js), Detection & Categorization subsystem list, Features
    (watchdog paragraph under Subscription detection, new Merchant rename rules bullet), the
    PATCH /api/transactions/:id + POST /api/detect endpoint notes and the
    /api/merchant-rename-rules endpoints, Database (merchant_rename_rules,
    user_merchant_rule_id, the four watchdog columns), reset-fresh WIPE_TABLES mention,
    INV-123 (watchdog) + INV-124 (rename rules), Known Open Issues (Batch 15 done + follow-ons
    bullet), counts 1755 / 82 files / Perfin 1238 / contract 134 + test-file descriptions.
    README — counts, coverage and contract lines.
  - **Where I left off:** Batch 15 + its /sync-docs committed and pushed (no PR). NEXT:
    `/broad-implement Batch 16` (plan file `.cycle/plan-cycle7-deferred.md`).
- **Previous status:** **Cycle 7 — Oct 2026 broad scan, Batch 14 DONE** on branch
  `claude/sweet-ritchie-f9d8ah` (2026-10-21). Refund-aware spending (F35 → G4), from
  `.cycle/plan-cycle7-deferred.md`.
  - **Completed:** REFUND_PREDICATE + REFUND_PRIOR_CATEGORY_JOIN + spendLinesCTE +
    NET_CATEGORY_MONTHS in financial-queries.js; getMonthlySpending / getCategorySpendingForMonth
    (→ budgets, alerts, push, snapshots, savings rate, FIRE, context export, Ask, insights),
    /api/spending-summary, /api/spending-yoy, the insights seasonal block, Ask's search total and
    the Sheets Dashboard (SX3-pinned mirror) all net refunds per (month, category), floored at $0.
    Cash flow, anomaly, tax and Settle Up stay charge-level.
  - **Decisions:** refunds take the merchant's latest earlier charge category (180 days), then their
    own provider category; refund-only categories / merchants aren't listed; txn_count = charges;
    the income test inside the refund predicate is COALESCEd (NULL for non-Plaid rows — the first
    version matched no refund at all; caught by the new contract tests).
  - **Results:** npm 1745/1745 (81 files), contract 128/128, Playwright 35/35. Net 1 − 1 = 0.
    Block: `.cycle/blocks/7-batch14-broad-implement.md`.
  - **Follow-ons:** Settle Up's own refund rule vs REFUND_PREDICATE; Watchlist 90-day spend + Code.gs
    stay gross; no "net of refunds" UI copy; pre-deploy budget snapshots stay gross.
  - **/sync-docs DONE (Batch 14):** CLAUDE.md — financial-queries entry (refund helpers), new
    "Refunds reduce spending" feature bullet, Ask total, Sheets Dashboard, spending-summary /
    spending-yoy endpoint notes, Shared financial queries, INV-07/08 wording + NEW INV-122,
    Known Open Issues (F35 removed, Batch 14 follow-ons, batch-status header), counts 1745/81
    (Perfin 1228), contract 128 + refunds / budget-parity descriptions, scan-oct-batch14 entry.
    README — counts + Batch 14 coverage + contract line. No subsystem path or operator-state change.
  - **Where I left off:** Batch 14 + its /sync-docs committed and pushed (no PR). NEXT:
    `/broad-implement Batch 15` (subscription watchdog + rename rules — plan file).
- **Previous status:** **Cycle 7 — Oct 2026 broad scan, Batch 13 DONE** on branch
  `claude/sweet-ritchie-f9d8ah` (2026-10-21). Platform hardening, test quality, drift guards.
  - **Completed:** F9 (Perfin COOP same-origin-allow-popups), F10 (migration advisory lock →
    lock_timeout 5s, 55P03 retried ×5, else fatal; pgvector create in an EXCEPTION block, vector
    objects only when installed — db/014/019/021), F12 (shell cookie carries
    user_settings.shell_session_epoch; POST /logout?everywhere=1 + Settings "Sign Out
    Everywhere"), F13 (Dockerfile chowns apps/per-sistant/uploads), F136 (Per-sistant
    integration.test.js deleted → tests/contract/persistent-batch13), F138/F139 (behavioural
    tests: runMigrations fake clients, passphrase/NEON exit via child process, PS-2 concurrent
    email claim, SSO replay, perfin_try_decrypt, session epoch, reindex endpoint, Per-sistant
    login gate, analytics), policy guards (tz lint + canonical-helper scan with KNOWN_GAPS;
    tests/contract/budget-parity — Sheets Budget Status = getBudgetStatus).
  - **Decisions:** advisory lock taken BEFORE lock_timeout so a second instance waits for the
    first; distinct lock keys per app; legacy cookies = epoch 0 (nobody logged out on deploy);
    epoch fails open on a DB blip; "everywhere" requires a valid session.
  - **Results:** npm 1732/1732 (80 files), contract 123/123, migrations ×2 OK, Playwright 35/35.
    Net score 0 − 2 = −2. Block: `.cycle/blocks/7-batch13-broad-implement.md`.
  - **Follow-ons:** Per-sistant AI cap month / Ask "Today" / capture file date are UTC (tz-lint
    KNOWN_GAPS); reset-fresh resets the session epoch; Per-sistant /api/login raw-buffer compare.
  - **/sync-docs DONE (Batch 13):** CLAUDE.md — counts 1732/80 (Perfin 1215 + Per-sistant 517),
    contract 123, scan-oct-batch13 (both apps) + platform-batch13 / persistent-batch13 /
    budget-parity descriptions, shell auth session epoch + exports, Dockerfile uploads chown,
    Database migration locking + shell_session_epoch column, Security (Sign Out Everywhere,
    Perfin COOP), INV-17/28/62 reworded, NEW INV-120 (session epoch) + INV-121 (drift guards),
    Known Open Issues (Batch 13 done + follow-ons). Per-sistant CLAUDE.md — counts, test list
    (integration.test.js removed), migration locking, vector guard wording. README — counts +
    Batch 13 coverage + contract line. Subsystem paths resolve; no new operator state.
  - **Deferred decisions RESOLVED (2026-10-21, operator accepted every recommendation):**
    F35 net refunds in their posting month, floored per category · F53 still-charging (>7 days
    after cancel) + price-rise (≥5% or $1) alerts · F55 rename rules (exact, apply to past +
    future, at sync) · F26 sign toggle in the CSV preview · F81 fix the text + an insight-email
    toggle, no standalone UI · F85 rebuild an archive whose content fingerprint changed · F134
    notes privacy tier. Plan: `.cycle/plan-cycle7-deferred.md` — Batch 14 (refund-aware
    spending), Batch 15 (subscription watchdog + rename rules), Batch 16 (CSV sign, F81, archive
    fingerprints, notes privacy).
  - **Where I left off:** Batch 13 + its /sync-docs committed and pushed (no PR); the deferred
    plan is written. NEXT: `/broad-implement Batch 14` (read the plan file for the scope), then
    15 and 16; expansion E1–E4 stays separate.
- **Previous status:** **Cycle 7 — Oct 2026 broad scan, Batch 12 DONE** on branch
  `claude/sweet-ritchie-f9d8ah` (2026-10-21). Knowledge ingest edges.
  - **Completed:** F126 (empty / max_tokens answers not cached; truncated flag), F127 (truncated
    tree → reported failure, SHA holds), F128 (>1 MB files via the blobs API), F129 (GitHub +
    Voyage timeouts), F130 (aiLimiter on rag query/diagram/capture; 1000 / 20000-char caps),
    F131 (upcomingFacts validity window + APP_TIMEZONE), F132 ("--- " + repeated privacy keys
    fail closed), F133 (diverged/behind compare → full walk), F135 (field-less fact capture → note).
  - **Decisions (mine):** F130's "cap" read as the input-length cap (per the plan line), not the
    AI cost cap (opt-in per call site, D1); F127 surfaces the truncation rather than walking
    subtrees.
  - **Tests:** npm test 1702/1702 (+24 scan-oct-batch12); contract 103/103 (+4 knowledge-batch12);
    Playwright 35/35. New tests fail pre-fix (22/24 unit — two controls; 4/4 contract). Two KR-1
    tests in scan-sept-fixes encoded ok:true on a truncated tree and were updated.
  - **Net score:** 0 − 1 = −1 (nothing would have fired on the current vault; F127's hourly full
    re-walk for an over-large vault is the documented new failure mode).
  - **Follow-ons:** RAG calls not charged to the AI cost cap; a field-less fact FILE drops its body;
    unclosed frontmatter read as body; subtree walk for over-large vaults; F134 → ST5.
  - **Block:** `.cycle/blocks/7-batch12-broad-implement.md`.
  - **Where I left off:** Batch 12 committed and pushed (no PR); its /sync-docs is done (root
    CLAUDE.md counts + INV-27/32/36 + Batch 12 follow-ons + reindex note, Per-sistant CLAUDE.md
    Knowledge block, README). OPERATOR: one full Knowledge reindex after deploy (F132). NEXT: Batch 13 (platform hardening, test quality and drift guards: F9, F10, F12, F13, F136 …).

- **Previous:** **Cycle 7 — Oct 2026 broad scan, Batch 11 DONE** on branch
  `claude/sweet-ritchie-f9d8ah` (2026-10-20). Per-sistant correctness.
  - **Completed:** F109 (parseCalDate on every DATE render), F113 (writeOk/tryFetch on ~70
    writes), F111 (Send Now single-flight), F110 (oldest unpaid month → overdue), F112
    (email_failed notifications; recipient validated), F114 (Job Radar new-only, keyed to the
    newest), F115 (reminders + stats on the APP_TIMEZONE day), F116 (email_sent /
    note_created / reminder_due + Slack wired), F117 (refresh single-flight; backstop moved +
    skip-recent), F118 (Ask totals), F119 (review upcoming from today), F120 (sent final;
    scheduled needs a time), F121 (attachments in Postgres; download route order; leftovers
    purged), F122 (30-day trash purge), F123 (limiter skipped embedded), F124 (grouped).
  - **Decisions (user):** F116 wire the events up (not remove); F121 store bytes in Postgres
    (not flag). Mine: "automation/webhook parity" read as bulk complete / create-todo /
    template apply running todo_* automations + webhooks; Slack gets every event.
  - **Tests:** npm test 1678/1678 (+29 apps/per-sistant/tests/scan-oct-batch11); contract 99/99
    (+9 persistent-batch11); migrations twice; Playwright 35/35. All new tests fail pre-fix.
    The contract test found a pre-existing bug: /api/attachments/download/:id was shadowed by
    /:entityType/:entityId (fixed under F121).
  - **Net score:** 6 − 2 = 4 (F121 database growth; F117 skipped manual backstop runs).
  - **Follow-ons:** Quick Add local parser UTC due date; settings session_timeout/default_horizon
    unvalidated; attachments not sent with emails; no one-click Retry for a failed email.
  - **Block:** `.cycle/blocks/7-batch11-broad-implement.md`.
  - **Where I left off:** Batch 11 committed and pushed (no PR); its /sync-docs is done
    (root CLAUDE.md INV-117..119 + counts, Per-sistant CLAUDE.md, README). NEXT: Batch 12 (Knowledge ingest edges: F126, F127, F128, F133 …).

- **Previous:** **Cycle 7 — Oct 2026 broad scan, Batch 10 DONE** on branch
  `claude/sweet-ritchie-f9d8ah` (2026-10-20). Perfin UI correctness and a11y.
  - **Completed:** F91 (charts from /api/spending-summary + local month labels), F94 (nav wraps
    641–960px), F95 (calendar minmax(0, 1fr)), F96 (one DASHBOARD_WIDGETS list), F97
    (parseAmountInput in the prompts), F98 (parseCalDate for goal / credit-score dates), F99
    (five writes report failures), F100 (one-click Add forms), F101 (labels + IF-3 scan on
    Settings / Subscriptions), F39 (budget type / month / rollover UI; upsert keeps unsent
    fields), F102 (return_to on expiry), F103 (Split modal), F104 (one style attr), F105
    (manual loan owed), F106 (escaped errors), F107 (SW path keys, no redirect / stray HTML,
    v7), F108 (failed loads say so).
  - **Tests:** npm test 1649/1649 (+24 scan-oct-batch10, +2 IF-3 files); contract 90/90 (+3
    ui-writes); Playwright 35/35; ad-hoc layout check (no horizontal scroll 390–1280px). All
    new tests fail pre-fix except the PATCH toggle contract test.
  - **Net score:** 8 − 1 = 7 (F96: dormant stored "off" toggles now take effect).
  - **Decisions:** the charts reuse the tables' latest summary request; the SW keys by path
    (query dropped) for pages too; a failed push-subscribe POST unsubscribes the browser.
  - **Follow-ons:** a future-month one-time budget is invisible until its month; the category
    month selector keeps the first response; no toggles for the credit-score / insights widgets.
  - **Block:** `.cycle/blocks/7-batch10-broad-implement.md`.
  - **Where I left off:** Batch 10 committed and pushed (no PR). /sync-docs DONE (Batch 10):
    CLAUDE.md — sw.js entry + PWA bullet (v7, path keys, shouldCache — F107), perfin-shared.js
    entry (DASHBOARD_WIDGETS / applyDashboardWidgets — F96), dashboard charts (F91/F108), split
    modal (F103), budget rollover UI + POST upsert (F39, bullet + endpoint; F39 removed from
    the Batch 5 Known Issues line), loan display (F105), nav / calendar layout (F94/F95),
    Accessibility scan pages (F101), W3 + INV-61 return_to (F102), new INV-116, Known Issues
    (Batch 10 follow-ons), counts 1649 / 77 (Perfin 1193) + contract 90; README counts +
    Batch 10 summary. No new source paths or operator state. NEXT: Batch 11 (Per-sistant
    correctness: F109, F113, F111, F110, F112, F114, F115, F121, F122, F116–F124).

- **Previous:** **Cycle 7 — Oct 2026 broad scan, Batch 9 DONE** on branch
  `claude/sweet-ritchie-f9d8ah` (2026-10-20). Sheets and cross-app.
  - **Completed:** F75 (Sheets averages over completed months), F76 (Utilities / Important
    Dates via cadence.js + APP_TIMEZONE), F77 (resetFormats on 3 tabs), F78 (Sheets
    single-flight), F79 (draft digest = not sent; ticks settle for the day), F80 (Per-sistant
    widget monthly equivalent + due today), F83 (guard passes plain numbers), F84 (Code.gs
    guard), F86 (settings 400s, dashboard env check, partial-sync failures recorded,
    notification_log retention, Credit Scores change per type), F44 (doc fixes).
  - **Scope note:** the plan's Batch 9 also lists F83/F84/F86/F44 — the Batch 8 hand-off line
    ("F75 … F80") left them off; implemented per the plan.
  - **Tests:** npm test 1624/1624 (+16 scan-oct-batch9); contract 87/87 (+5 sheets-crossapp);
    migrations twice; Playwright 35/35. All new tests fail pre-fix.
  - **Net score:** 5 − 1 = 4 (F79 day-settle delay).
  - **Decisions:** a partial Sheets SUCCESS isn't recorded (only failures); a different-kind
    Sheets run waits rather than skips; notification retention = read rows > 180 days.
  - **Operator:** clasp push Code.gs (F84).
  - **Follow-ons:** Settings text pointing at a non-existent integration section (F81); the HTTP
    webhook path's sent:true on a receiver draft; Important Dates subs single next_expected.
  - **Block:** `.cycle/blocks/7-batch9-broad-implement.md`.
  - **Where I left off:** Batch 9 committed and pushed (no PR). /sync-docs DONE (Batch 9):
    CLAUDE.md — Sheets (completed-month averages F75, Utilities / Important Dates via
    cadence.js F76, resetFormats F77, single-flight F78, plain-number pass-through F83,
    Credit Scores per type F86), Code.gs guard (F84), in-process draft = not sent (F79, insight
    email + weekly digest bullets), Per-sistant widget figures (F80, also
    apps/per-sistant/CLAUDE.md), settings 400s (PATCH note + INV-59), dashboard env check +
    partial-sync failure record (SXE-1 paragraph + endpoint), notification_log retention, new
    INV-114 / INV-115, Known Issues (Batch 9 follow-ons + clasp push), counts 1624 / 76
    (Perfin 1168) + contract 87; README counts + Batch 9 summary. No new source paths; the
    only operator step is `clasp push` for Code.gs. NEXT: Batch 10 (F91, F94, F95, F96, F97,
    F99 …).

- **Previous:** **Cycle 7 — Oct 2026 broad scan, Batch 8 DONE** on branch
  `claude/sweet-ritchie-f9d8ah` (2026-10-20). AI trust.
  - **Completed:** F61 (named other month = cross-period), F62 (goal prompt via
    deriveGoalProgress), F64 (Ask charge flag after the write), F65 (last Ask round
    tool_choice none), F66 (Ask APP_TIMEZONE date + served model; spend month in
    APP_TIMEZONE), F67 (bounded entity capture), F68 (sentence/clause period window; k/M
    suffix), F70 (suggest category enum + de-dup; Accept de-dup), F71 (ISO prompt dates),
    F72 (weekly digest text completed goals; real dashboard link or none).
  - **Scope note:** the scan plan's Batch 8 also lists F70/F71/F72 — the Batch 7 hand-off
    line ("F61 … F68") left them off; implemented per the plan.
  - **Tests:** npm test 1608/1608 (+17 scan-oct-batch8); contract 82/82 (+4 ai-trust);
    migrations twice. New tests fail pre-fix except the unchanged-behaviour pins.
  - **Net score:** 4 − 1 = 3 (F61's month attribution: documented false-negative mode).
  - **Decisions:** a month counts when named before the figure in its sentence or attached
    right after it; Accept keeps the last entry per category; no email link without
    RENDER_EXTERNAL_URL.
  - **Follow-ons:** capitalised "Cancel X" not captured; Ask tool results' DATE serialization;
    other usage rows record the configured model.
  - **Block:** `.cycle/blocks/7-batch8-broad-implement.md`.
  - **Where I left off:** Batch 8 committed and pushed (no PR). /sync-docs DONE (Batch 8):
    CLAUDE.md — ask.js entry (F64/F65/F66), audit period window + named months + bounded
    entities (F61/F67/F68), APP_TIMEZONE spend month (cost tracking, APP_TIMEZONE list,
    INV-14), suggest/accept (F70 + endpoint), goal prompt + ISO dates (F62/F71, INV-11),
    weekly digest text + dashboard link + RENDER_EXTERNAL_URL (F72), INV-55 update, new
    INV-113, Known Issues (Batch 8 follow-ons), counts 1608 / 75 (Perfin 1152) + contract
    82; README counts + Batch 8 summary. No new source paths or operator state. NEXT: Batch 9
    (F75, F76, F77, F78, F79, F80).

- **Previous:** **Cycle 7 — Oct 2026 broad scan, Batch 7 DONE** on branch
  `claude/sweet-ritchie-f9d8ah` (2026-10-20). Categorization rules + income cadence.
  - **Completed:** F46 (most-specific rule order; saving a rule deactivates the merchant's
    other-category rules; times_applied no longer bumps updated_at), F47 (AI write only fills a
    still-uncategorized row), F48 (blank / <3-char contains|starts_with rules refused; stored ones
    skipped), F52 (circular day-of-month for semimonthly income), F54 (unanswered rows stamped
    ai_skipped_at, held back from the AI for 30 days).
  - **Tests:** npm test 1591/1591 (+8 scan-oct-batch7); contract 78/78 (+3 categorize-rules);
    migrations twice. All new tests fail pre-fix (except the unchanged-cadence pin).
  - **Net score:** 3 − 0 = 3.
  - **Decisions:** superseded = same pattern (case-insensitive) for another category, any
    match_type; the Review "Remember" path still applies the category when the rule is refused
    (returns rule_error); 30-day AI back-off rather than permanent.
  - **Follow-ons:** Review widget doesn't show rule_error; no early reset of ai_skipped_at;
    rules list doesn't flag too-short rules.
  - **Block:** `.cycle/blocks/7-batch7-broad-implement.md`.
  - **Where I left off:** Batch 7 committed and pushed (no PR). /sync-docs DONE (Batch 7):
    CLAUDE.md — rule order / superseded deactivation / minimum length / rule_error
    (categorization-rules bullet + endpoints), the AI write guard + ai_skipped_at back-off
    (categorization Key Design Decision + Database), semimonthly wrap (cadence.js entry + bill
    calendar income), new INV-112, Known Issues (Batch 7 follow-ons), counts 1591 / 74
    (Perfin 1135) + contract 78; README counts + Batch 7 summary. Paths verified. No new
    operator state (ai_skipped_at is auto-migrated). NEXT: Batch 8 (F61, F62, F64, F65, F66,
    F67, F68).

- **Previous:** **Cycle 7 — Oct 2026 broad scan, Batch 6 DONE** on branch
  `claude/sweet-ritchie-f9d8ah` (2026-10-20). Delete integrity and feeds.
  - **Completed:** F20 (deleted_transactions tombstone skipped by the Teller + Plaid upserts),
    F21 (CSV-overlap: merchant-similar, one-to-one pairing; GET and Resolve share it), F45 (ICS
    rent due day clamped to the real month), F59 (RFC 5545 folding), F56 (Undismiss
    re-activates), F57 (calendar month / due_day / search dates / manual date 400s, literal
    search LIKE, APP_TIMEZONE defaults), F58 (dead artifacts removed).
  - **Tests:** npm test 1583/1583 (+10 scan-oct-batch6); contract 75/75 (+7 delete-feeds);
    migrations twice; Playwright 35/35. All new tests fail pre-fix.
  - **Net score:** 0 − 0 = 0.
  - **Decisions:** tombstones only for the user DELETE route (Plaid `removed` and CSV-overlap
    resolve deletions aren't tombstoned — provider-side and CSV ids never re-enter via the
    provider upserts); CSV re-import doesn't check tombstones (preview parity).
  - **Follow-ons:** no undelete; CSV re-import vs tombstones decision.
  - **Block:** `.cycle/blocks/7-batch6-broad-implement.md`.
  - **Where I left off:** Batch 6 committed and pushed (no PR). /sync-docs DONE (Batch 6):
    CLAUDE.md — deleted_transactions (dedup bullet, Database, reset list, DELETE endpoint),
    CSV-overlap pairing (dedup bullet + endpoints + transactions.js note), ICS clamp + folding
    (Rent ledger bullet + /calendar.ics), Undismiss (subscription + transfer sections), F57
    400s + APP_TIMEZONE defaults (manual bills, bill-calendar, bill-payments, search, manual
    txn), cadence.isValidYmd, Known Issues (Batch 6 follow-ons), new INV-111, counts 1583 / 73
    (Perfin 1127) + contract 75; README counts + Batch 6 summary. Paths verified. npm test
    1583/1583. NEXT: Batch 7.

- **Previous:** **Cycle 7 — Oct 2026 broad scan, Batch 5 DONE** on branch
  `claude/sweet-ritchie-f9d8ah` (2026-10-20). Money accuracy and classification.
  - **Completed:** F31 (0% split null-safe), F32 (NOT_TRANSFER brand words on the cleaned
    merchant only + exemptions; Sheets mirror), F51 (Transfer/Investment category excluded),
    F49 (detectors read the raw description — phrase-like words only), F50 (Plaid legacy
    category = uncategorized; Teller map skips Plaid rows), F34 (cash-flow income via the shared
    getLiveIncomeStreams / cadence.js), F37 (INCOME_AMOUNT joint-account share + reimbursement
    words), F36 (context export unknown limit), F33 (payee_obligation_skips + Remove button),
    F38 (snapshots only while a budget is in effect), F40 (push via getBudgetStatus, unrounded
    thresholds), F41 (Spending Summary whole-month windows), F42 (Watchlist literal LIKE +
    spend total), F43 (next month's rent in the lead window).
  - **Tests:** npm test 1573/1573 (+15 scan-oct-batch5); contract 68/68 (+11
    money-classification); migrations twice; Playwright 35/35. All new tests fail pre-fix.
  - **Net score:** 0 − 1 = −1 (F32's narrower brand matching is a documented trade-off).
  - **Decisions:** NULL split → 100 (SPLIT_AMOUNT's default) in Settle Up; cash-flow /
    calendar income streams stay full deposit amounts (only aggregates use INCOME_AMOUNT);
    removal skips keyed (period, category, label) like generation's own check.
  - **Follow-ons:** Per-sistant housingDue has the same month-boundary gap (F43); no "+ add
    item" UI on the Rent page; Code.gs NOT_TRANSFER still the old list.
  - **Block:** `.cycle/blocks/7-batch5-broad-implement.md`.
  - **Where I left off:** Batch 5 committed and pushed (no PR). /sync-docs DONE (Batch 5):
    CLAUDE.md — NOT_TRANSFER phrase vs brand lists + exemptions + Transfer/Investment
    exclusion, INCOME_AMOUNT + reimbursement words, getLiveIncomeStreams (calendar + cash
    flow), detectors' raw-description rule, Plaid uncategorized rule, 0% split, context-export
    unknown limit, payee_obligation_skips (table, generation, DELETE endpoint, Remove button,
    reset list), next-month rent reminder, snapshot in-effect rule, budget push via
    getBudgetStatus, Spending Summary windows, Sheets Watchlist, Known Issues (Batch 5
    follow-ons), INV-72 extended, new INV-109 / INV-110, counts 1573 / 72 (Perfin 1117) +
    contract 68; README counts + Batch 5 summary. Paths verified. npm test 1573/1573.
    NEXT: Batch 6.

- **Previous:** **Cycle 7 — Oct 2026 broad scan, Batch 4 DONE** on branch
  `claude/sweet-ritchie-f9d8ah` (2026-10-20). Bank-sync durability.
  - **Completed:** F17 (perfin_try_decrypt — a wrong-key token row no longer fails every
    sync; stale Teller enrollment unlinks), F18 (duplicate-Item guard on both exchange routes,
    409 + release; docs/hints say unlink + link), F19 (CLI exits 1 + imported-files manifest;
    workflow removes only those; per-row savepoint), F25 (roll-forward: label > institution,
    ambiguity skip, loan sign, APP_TIMEZONE as-of + newest-row stamp, savepoint), F22 (removed
    investment accounts stay removed; investments-only unlink route + listing), F27 (Plaid
    sync/reconcile lock, bounded 10 min), F24 (flows_synced_at coverage; skip codes), F28
    (liabilities only for card/loan Items, skip codes, `??`), F29 (balance PATCH validation),
    F30 (snapshot day + Teller text[] category).
  - **Not finished (selected):** none.
  - **Tests:** npm test 1558/1558 (+11); contract 57/57 (+13, new bank-durability file);
    migrations twice OK; Playwright 35/35. New tests fail pre-fix. Block:
    `.cycle/blocks/7-batch4-broad-implement.md`.
  - **Decisions:** F18 refuses a duplicate Item (release + 409) rather than merging histories —
    G3 update mode is the real fix; perfin_try_decrypt swallows any decrypt error as NULL (reported
    as decryption_failed); the Plaid lock wait is bounded so a hung call can't block forever; a
    CSV-rolled balance is stamped as of its newest row.
  - **Follow-ons:** G3; no duplicate guard on the investments-only exchange; setCreditLimit NaN →
    null in the UI; Plaid upsertTxn "{a,b}" literal (known); data-health decrypt probe.
  - **Where I left off:** Batch 4 committed and pushed (no PR). /sync-docs DONE (Batch 4):
    CLAUDE.md — perfin_try_decrypt (Operator state 2, INV-22, data-health + sync-transactions
    notes), the duplicate-Item 409 on exchange-transactions / hosted-link-complete, GET
    /api/items 'plaid_investment' + DELETE /api/plaid/investment-items/:id, holdings keep a user
    removal, flows_synced_at coverage, the Plaid sync/reconcile lock, liabilities skips + `??`,
    balance PATCH validation, CSV CLI exit/manifest + workflow removal rule + roll-forward rules,
    snapshot dates, Teller text[] category, Known Issues (F17/F18 resolved → G3 limitation),
    new INV-107 (duplicate-Item guard) + INV-108 (CSV workflow removes only imported files),
    counts 1558 / 71 (Perfin 1102), contract 57; README counts + Batch 4 summary. Subsystem
    paths verified. npm test 1558/1558. NEXT: Batch 5.

- **Previous:** **Cycle 7 — Oct 2026 broad scan, Batch 3 DONE** on branch
  `claude/sweet-ritchie-f9d8ah` (2026-10-20). Backstops, outcomes, operator state (policy responses).
  - **Completed:** F3 (backup names missing secrets first — the run log confirmed both were unset;
    operator must add them), F4 (operator: re-enable 4 workflows; documented), F5 (daily-sync
    steps independent + timeout reported, 420 s), F8 (job outcomes via jobHealth.result, data-health
    flushes first + raises failed jobs, housing-ledger watched), F23 (wholesale/thrown sync failures
    recorded), F69 (failed finding INSERT → audit_incomplete), F73 (no settings fallback in
    generateInsights), F63 (cap pre-check, insights_last_attempt_at + 24 h back-off, 'insight_unsaved'
    charge), F14 (tellerCertStatus → data-health issue + boot log), F15 (housing reminders = away
    job), F16 (workflow permissions, gpg + verified backups, generic test-notification error,
    shutdown stops jobs, Express v4 doc), policy empty-catch scan (KNOWN_GAPS, 9 catches fixed).
  - **Not finished (selected):** none in code. F3/F4 need the operator (secrets, re-enable,
    restore drill).
  - **Tests:** npm test 1547/1547 (+30); contract 44/44; migrations twice OK; new tests fail
    pre-fix. Block: `.cycle/blocks/7-batch3-broad-implement.md`.
  - **Decisions:** auto-insight retry back-off 24 h; backups switched to gpg (integrity-checked) —
    no openssl backup ever existed; the empty-catch scan covers server code only, keyed per-file
    count (no line numbers), ROLLBACK().catch is the one sanctioned idiom; data-health flush writes
    only changed jobs.
  - **Follow-ons:** rebuild's sonnet fallback (F73 pattern); port CHECK_STATUS to the other
    workflows; reconcile throw retries hourly; KNOWN_GAPS 38 catches / 16 files.
  - **Operator:** add NEON_DATABASE_URL + BACKUP_ENCRYPTION_PASSPHRASE (+ PERSISTENT_DATABASE_URL)
    secrets; re-enable Database Backup / Weekly Reconcile / Keep Alive / Job Radar; run one backup
    + restore drill; make the repo PRIVATE; delete old Actions logs.
  - **/sync-docs DONE (Batch 3, 2026-10-20):** CLAUDE.md — job-health / teller-api / shell
    index architecture entries, test counts 1547/70 (Perfin 1091) + scan-oct-batch3
    description, Current Status, workflow hygiene note (permissions, daily-sync independent
    steps + CHECK_STATUS), cost tracking ('insight_unsaved'), auto-trigger (cap pre-check,
    attempt stamp, 24 h back-off, F73), Sync Health card, Operator state items 1 (cert check at
    boot + Sync Health), 4 (gpg + verify + restore command, secrets never set) and NEW 5
    (re-enable scheduled workflows), Scheduled Tasks (caveat, away channels + housing, auto-
    trigger, housing ledger, job outcomes), data-health endpoint, last_sync_result (F23),
    insights_last_attempt_at + job_runs columns, empty-catch Key Design Decision, INV-77
    (+ housing), NEW INV-105 (job outcomes) + INV-106 (empty-catch scan), Known Open Issues
    (Batches 1–3 done, F3/F4 operator-only, Batch 3 follow-ons). README — counts, Batch 3
    coverage, backup section (gpg, verify, missing-secret step, re-enable). Per-sistant docs
    unchanged. Subsystem paths resolve.
  - **Where I left off:** Batch 3 + its /sync-docs committed and pushed (no PR). NEXT: Batch 4.

- **Previous:** **Cycle 7 — Oct 2026 broad scan, Batch 2 DONE** on branch
  `claude/sweet-ritchie-f9d8ah` (2026-10-20). Broken pages & dead channels.
  - **Completed:** F87 (Rent page utility row), F88 (account history 500), F89 (toast loop),
    F90 (nav badge + unread count), F74 (Web Push JSONB keys), F60 (insight feedback SQL),
    F93 (nav logo under /perfin), F92 (offline page + SW <base>, perfin-v6), F137 (every-page
    Playwright smoke, minimum version).
  - **Not finished (selected):** none.
  - **Tests:** npm test 1517/1517 (+9); contract 44/44 (+1); Playwright 35/35 (+27). New tests
    fail pre-fix. Block: `.cycle/blocks/7-batch2-broad-implement.md`.
  - **Decisions:** nav waits via whenShared/DOMContentLoaded rather than moving perfin-shared.js
    into <head>; the page smoke logs in once (cookie reuse) and keeps a KNOWN_GAPS list.
  - **New follow-on:** Per-sistant /api/ai/review-summary 500s (not 501) without an AI key
    (tolerated in e2e KNOWN_GAPS). F123 (Batch 11) confirmed by the smoke.
  - **Operator:** still — make the repo PRIVATE, delete old Actions logs (Batch 1).
  - **/sync-docs DONE (Batch 2, 2026-10-20):** CLAUDE.md — offline.html/offline.js/sw.js
    architecture entries (perfin-v6, offlineResponse `<base>` injection), account-history
    one-document note (F88), nav whenShared (F90), toast cap (F89), PWA + offline bullets,
    Web Push JSONB keys + pruning (F74), test counts 1517/69 (Perfin 1061) + scan-oct-batch2
    description, contract 44 (+ feedback, F60), ci.yml e2e note + Current Status (35 Playwright
    tests, pages.spec.js / KNOWN_GAPS), Commands; Known Open Issues — Batch 2 UI items removed,
    review-summary 500 and F123 added. README — counts, Batch 2 coverage, e2e sentence, sw.js
    row. Per-sistant docs unchanged (no Per-sistant code touched). Subsystem paths all resolve
    (offline.js is covered by teller/public/*.js). Operator state: none new beyond the
    perfin-v6 activation note already in the Batch 2 block.
  - **Where I left off:** Batch 2 + its /sync-docs committed and pushed (no PR). NEXT: Batch 3.

- **Previous:** **Cycle 7 — Oct 2026 broad scan, Batch 1 DONE** on branch
  `claude/sweet-ritchie-f9d8ah` (2026-10-19). Scan: 9 Stage-1 auditors + 2 Stage-2 sweeps
  (real-PG reproduction, browser click sweep); 139 findings F1–F139, G1–G5, ST1–ST5 (the full
  report lives in the scan session's chat — the batch plan below is the durable copy).
  - **Completed:** F2 (workflows print counts only; csv-import refuses while the repo is
    public), F1 (digest PIN/token compare + unhandledRejection logger), F6 (standalone
    x-api-key bypass needs API_KEY; login digest), F125 (Mermaid 11.4.1 + path-scoped CSP),
    F82 (persistent_url validated, no redirects, no *_enc echoed), F11 (Per-sistant CSRF),
    F7 (lockout alert deduped 6h).
  - **Not finished (selected):** none.
  - **Tests:** npm test 1508/1508 (+19, tests/scan-oct-batch1.test.js; all 6 suites fail
    pre-fix). Block: `.cycle/blocks/7-batch1-broad-implement.md`.
  - **Decisions:** strip *_enc from the settings PATCH response rather than an explicit
    column list; private hosts stay allowed for persistent_url (standalone Per-sistant on
    localhost/LAN); lockout alert window 6h.
  - **Operator:** make the repo PRIVATE; delete old Actions logs (balances/net worth);
    check one Knowledge diagram renders after deploy.
  - **Remaining cycle-7 batches (scan plan):**
    B2 broken pages & dead channels (F87 F88 F89 F90 F74 F60 F93 F92 F137) ·
    B3 backstops/outcomes/operator state — policy responses (F3 F4 F5 F8 F23 F69 F73 F63 F14
    F15 F16 + empty-catch scan) · B4 bank-sync durability (F17 F18 F19 F25 F22 F27 F24 F28 F29
    F30) · B5 money accuracy & classification (F31 F32 F51 F49 F50 F34 F37 F36 F33 F38 F40 F41
    F42 F43) · B6 delete integrity & feeds (F20 F21 F45 F59 F56 F57 F58) · B7 categorization
    (F46 F47 F48 F52 F54) · B8 AI trust (F61 F62 F64 F65 F66 F67 F68 F70 F71 F72) · B9 Sheets &
    cross-app (F75 F76 F77 F78 F79 F80 F83 F84 F86 F44) · B10 Perfin UI (F91 F94 F95 F96 F97 F99
    F101 F39 F98 F100 F102–F108) · B11 Per-sistant (F109 F113 F111 F110 F112 F114 F115 F121 F122
    F116–F120 F123 F124) · B12 Knowledge (F126 F127 F128 F133 F129–F132 F135) · B13 platform +
    tests + drift guards (F9 F10 F12 F13 F136 F138 F139 + canonical-helper scan, tz lint,
    Sheets-vs-getBudgetStatus parity). Deferred: F35→G4, F53→G5, F55→ST2, F134→ST5, F81, F85,
    F26 (decisions). Expansion: E1 (G1 G2) · E2 (ST1 G3) · E3 (G4 G5 ST2) · E4 (ST3 ST4 ST5).
  - **/sync-docs DONE (Batch 1, 2026-10-20):** CLAUDE.md — test counts 1508/68 (Perfin 1052) +
    scan-oct-batch1 description, csv-import public-repo guard, lockout alert dedup + crash note,
    SHELL_PIN digest compare, Security bullets (standalone API-key rule, secret compares never
    throw + unhandledRejection logger, public Actions logs / SUMMARY_JS, persistent_url
    validation), backstop caveat in Scheduled Tasks, persistent_url column note, INV-79 extended,
    NEW INV-103 (no workflow prints a response body) + INV-104 (digest secret compares), Known
    Open Issues cycle-7 block. Per-sistant CLAUDE.md — CSRF, CSP/Mermaid pin. READMEs — counts,
    Batch 1 coverage, PIN compare, lockout dedup, CSRF. Subsystem paths resolve (83/83).
  - **Where I left off (then):** Batch 1 + docs committed and pushed (no PR).

- **Previous:** **Cycle 6 REFLECTED + SYNTHESIZED (2026-10-13)** — net +102 (117 prod fixes − 15 new failure modes), block `.cycle/blocks/6-a-reflect.md`; synthesis in PROJECT_HEALTH.md (Axis A 7 / 7.5, Axis B 7 / 7.5, 3 policy responses mandatory for cycle 7). NEXT: the next audit opens Cycle 7 with the policy fixes in scope. Earlier: **Cycle 6 — Sept 2026 broad-scan, Batch 15 follow-ons DONE** on branch
  `claude/lucid-darwin-7r8e59` (2026-10-10). The bugs Batch 15's real-code tests exposed are
  fixed and the contract-coverage gap is closed (all unmerged with Batches 11–15, no PR).
  - **Completed:** FO-1 (/api/calendar 500 — router now reads advanceRecurrence from helpers),
    FO-2 (Quick Add regexes double-escaped), FO-3 (palette picker under the shell), FO-4
    (views/js.js on current theme tokens), FO-5 (theme + perfin_url validated), FO-6 (contract tests
    for the Teller/Plaid sync engines, categorize, generateInsights + audit, and the Knowledge
    pipeline). Guards added: router deps ⊆ server.js deps; no single-escaped regex in client
    template literals. Batch 15 KNOWN_GAPS lists are empty.
  - **Not finished (selected):** none.
  - **Tests:** npm test 1489/1489, 0 todo (Perfin 1033 + Per-sistant 456; 67 files). Contract 43/43,
    0 todo (with and without pgvector). Playwright smokes + temporary follow-on specs green.
  - **Decisions:** calendar router takes `helpers` (no new dep key); perfin_url stored trimmed
    without a trailing slash; undo button text uses --paper so it reads on the mono-dark accent.
  - **Open follow-ons:** see `.cycle/blocks/6-batch15-followons-broad-implement.md` — Plaid
    legacy-category array literal (DC-14 class), Quick Add UTC due date, unvalidated
    session_timeout_minutes/default_horizon, no contract test of the Plaid item loop / Teller enroll.
  - **Operator:** none required.
  - **Where I left off:** committed and pushed (no PR). /sync-docs DONE (follow-ons): counts
    1489/67 + contract 43, Known Open Issues rewritten to the remaining items, INV-96/97, Per-sistant
    feature + gotcha notes, README. NEXT: a PR for Batches 11–15 + follow-ons when the operator asks.

- **Previous:** **Cycle 6 — Sept 2026 broad-scan, Batch 15 DONE** on branch
  `claude/lucid-darwin-7r8e59` (2026-10-09). Batch 15 (test-quality guards) implemented on top of
  Batches 11–14 (all unmerged, no PR), tested, pushed. Test/CI changes only — no production code.
  - **Completed:** TQ-2 (tests/contract/ real-Postgres route contract suite — financial queries,
    housing + settle-up, calendar + exports, transaction writes + CSV import, Per-sistant routes;
    `npm run test:contract`; CI `migrations` job step), TQ-1 (tests/teller.test.js + Per-sistant
    api.test.js rewritten against the real code; replicas/tautologies deleted), source guards
    (tests/scan-sept-batch15.test.js: style nonce, root-relative navigation, undefined CSS vars,
    contract wiring).
  - **Not finished (selected):** none.
  - **Tests:** npm test 1475/1475 + 2 todo (Perfin 1033 + Per-sistant 442; 66 files). Contract
    suite 27 pass + 1 todo on local PG16; mutation check (FAN-1 cast, DC-1 mount order, SXE-8
    dates) turns it red.
  - **Decisions:** one scratch DB per contract file; full real mount order in the contract app;
    pre-existing bugs found by the new tests are recorded as node:test `todo`s / guard KNOWN_GAPS
    (reported, not CI-red) rather than fixed in a test batch.
  - **Open follow-ons:** see `.cycle/blocks/6-batch15-broad-implement.md` — /api/calendar 500
    (advanceRecurrence), quick-add regexes lose `\b`, settings-patch pathname, Per-sistant legacy
    CSS vars, unvalidated perfin_url/theme.
  - **Operator:** none required.
  - **Where I left off:** Batch 15 committed and pushed (no PR). This was the last planned batch of
    the Sept 2026 broad scan. /sync-docs DONE (Batch 15): root CLAUDE.md (counts 1475/66, batch15 + tests/contract entries, ci.yml contract step, `npm run test:contract`, a real-code/contract Key Design Decision, INV-94/95, a Known Open Issues section), apps/per-sistant/CLAUDE.md (442, api.test.js real-code, Known Open Issues), README. NEXT: the follow-ons above (open a PR for Batches 11–15 when the operator asks).

- **Previous:** **Cycle 6 — Sept 2026 broad-scan, Batch 14 DONE** on branch
  `claude/lucid-darwin-7r8e59` (2026-10-09). Batch 14 (Per-sistant correctness & UI)
  implemented on top of Batches 11–13 (all unmerged, no PR), tested, pushed.
  - **Completed:** PB-4, PB-5, PB-6, PB-9 (Job Radar: profile edit clears embedding + fits; live
    re-score, fit backfill, stale exclusion, unscored = verify-first, batched embeds; scam hidden /
    suspect verify-first; dismiss no longer penalizes the source), PB-7 (+PD-10, company remove =
    deactivate), PB-17 (SW 503 + exclusions + safe replay), PB-19 (timeouts), PD-5 (location on
    create + recurrence), PD-6 (automation validation + wiring + per-rule isolation), PD-7 (Ask /
    Smart Suggestions models, db/024), PD-9 (single-recipient validation), PD-11 (iCal), PD-12
    (dependencies), PD-13 (templates), PD-14 (review overdue), PUI-3..PUI-8 (undo semantics, Jobs
    views + errors, keyboard + dialogs, webhook events, http(s) apply links, keep-alive embedded).
  - **Not finished (selected):** none. PB-8, PB-16, PB-18, PB-20 deferred per the plan.
  - **Tests:** 1647/1647 (Perfin 1025 + Per-sistant 622; 65 files). New
    apps/per-sistant/tests/scan-sept-batch14.test.js (45; 42 fail pre-fix). Real PG: migrations ×2
    incl. db/024 + every new SQL path. Browser: keyboard task toggle + recurring undo, dialog
    Esc/focus, Jobs views, embedded keep-alive; 156 inline page scripts node --check clean.
  - **Decisions:** PB-9 resolved by dropping the dismiss penalty + nudging only on a status change
    (no company-trust table); stale = 14 days behind the latest refresh (not wall-clock); Ask
    defaults to Haiku (user-initiated), Smart Suggestions inherits the briefing model; SW replays
    keep 401/408/429/5xx and drop >24h entries; recurring undo deletes only an untouched next
    instance (<1 day old) and steps the streak back by one.
  - **Open follow-ons:** see `.cycle/blocks/6-batch14-broad-implement.md` — notably the
    PRE-EXISTING `/api/calendar` 500 (calendar router never receives advanceRecurrence).
  - **Operator:** none required.
  - **/sync-docs DONE (Batch 14):** apps/per-sistant/CLAUDE.md — Job Radar (main needs a scored
    fit, verify-first semantics, stale/scam handling, live re-score + fit backfill, profile-edit
    reset, company deactivate, dismiss nudge, page views/errors, http(s) links, timeouts),
    Offline Support (503 + exclusions + replay rules), Automations (triggers/actions, validation,
    wiring, isolation), Ask/Smart Suggestions models (db/024), recipient + webhook-events validation,
    iCal, dependencies, templates, weekly review, Undo (no send undo; recurring undo endpoint),
    keyboard + dialogs, location, keep-alive, key files, API list, counts 622. Root CLAUDE.md —
    counts 1647/65 (Per-sistant 622), batch14 test description, INV-66 extended (company
    deactivate), NEW INV-91 (Job Radar buckets), INV-92 (service worker), INV-93 (automations).
    README — counts + Batch 14 coverage. Subsystem paths resolve (globs). Operator state: none new
    (db/024 auto-migrates; Ask defaults to Haiku — noted in the Per-sistant docs).
  - **Where I left off (then):** Batch 14 and its docs committed and pushed.

- **Previous:** **Cycle 6 — Sept 2026 broad-scan, Batch 13 DONE** on branch
  `claude/lucid-darwin-7r8e59` (2026-10-09). Batch 13 (Perfin UI correctness & accessibility)
  implemented on top of Batches 11–12 (all unmerged, no PR), tested, pushed.
  - **Completed:** WD-4, WD-5 (pyramid shapes; server net worth; loans in debt), WUI-6, WD-12
    (writeOk on every listed write; 0% share kept client+server; NaN prompts refused), WD-7, WD-8
    (CSV Auto-detect + Accounts preview; Plaid pre-build removed), WD-9, WD-11, WD-13, WD-15, IF-1
    (openDialog/watchDialog on all modals + bell panel), IF-2..IF-7 (calendar buttons, labels, CSS
    tokens, light-theme contrast, PIN pad, notification links).
  - **Not finished (selected):** none.
  - **Tests:** 1602/1602 (Perfin 1025 + Per-sistant 577; 64 files). New tests/scan-sept-batch13.test.js
    (30; 29 fail pre-fix). Browser: 10 pages error-free, dialog trap/Esc/restore, light-theme
    on-teal, Add Goal, Accounts CSV preview+import, PIN > 8 digits; e2e 8/8.
  - **Decisions:** debt baseline acts as a high-water mark (raised when debt exceeds it); pyramid net
    worth reads the latest snapshot rather than a new endpoint; dialogs via a MutationObserver
    watcher so pages keep their own show/hide code; PIN-pad guard limited to Enter.
  - **Open follow-ons:** see `.cycle/blocks/6-batch13-broad-implement.md`.
  - **Operator:** none required.
  - **/sync-docs DONE (Batch 13):** CLAUDE.md — perfin-shared.js (writeOk / parseAmountInput /
    openDialog / watchDialog conventions) + perfin-shared.css (defined token aliases, --on-teal,
    opaque options/modals) architecture entries, CSV import (Auto-detect default + Accounts
    preview), loan accounts (UI form), account history (debt display, reset), pyramid modes,
    bill calendar keyboard, notification links, accessibility, PIN pad, shared-split endpoint
    validation, WebAuthn transports now stored, NEW INV-89 (writes report outcome) + INV-90
    (dialogs + defined CSS vars), test counts 1602/64 (Perfin 1025) + batch13 description.
    README — counts + Batch 13 coverage. Subsystem paths resolve. Operator state: none new.
  - **Where I left off (then):** Batch 13 and its docs committed and pushed.

- **Previous:** **Cycle 6 — Sept 2026 broad-scan, Batch 12 DONE** on branch
  `claude/lucid-darwin-7r8e59` (2026-10-09). Batch 12 (Investments) implemented on top of
  Batch 11 (both unmerged, no PR), tested, pushed.
  - **Completed:** BSI-4 (prune holdings Plaid no longer returns), BSI-5 (NULL cost basis +
    known-basis return + cost_basis_coverage; Sheets + dashboard), BSI-6 (mid-window account entry
    flows in TWR/XIRR), WD-2 (sparkline history source), WD-10 (funding-options phantom dedupe +
    orphan warning), WD-17 (winners/losers filtered by sign, stale history chart cleared, reconcile
    leg errors reported), BSI-16 (parseMoney CR/DR + trailing minus, chase_checking, trailing-comma
    tolerance).
  - **Not finished (selected):** none.
  - **Tests:** 1572/1572 (Perfin 995 + Per-sistant 577; 63 files). New
    tests/scan-sept-batch12.test.js (21; all fail pre-fix). Real PG: migrations ×2 (cost_basis
    nullable), prune/NULL basis on the real table, performance figures, funding-options dedupe.
    Browser: dashboard/goals/settings load with no script/CSP errors; e2e 8/8.
  - **Decisions:** prune only accounts present in the item's response; unknown basis excluded from
    the return (coverage shown) rather than estimated; CR → negative / DR → positive in the
    debit-positive convention; Chase checking Type is not used as a category.
  - **Open follow-ons:** see `.cycle/blocks/6-batch12-broad-implement.md`.
  - **Operator:** none required.
  - **/sync-docs DONE (Batch 12):** CLAUDE.md — csv-formats entry + CSV import bullet (Chase
    checking, CR/DR, trailing minus, trailing-comma tolerance), Plaid holdings (prune, NULL basis),
    Investments widget (known-basis return + coverage, winners/losers by sign, per-account sparkline
    source, TWR entry flows, empty-range state), Sheets Investments tab, endpoint notes (reconcile
    status errors, funding-options dedupe + orphan, performance coverage, performance-history
    accounts_added), holdings Key Design Decision, NEW INV-87 (holdings mirror Plaid per account /
    NULL basis) + INV-88 (mid-window entry inflow), test counts 1572/63 (Perfin 995) + batch12
    description. README — counts + Batch 12 coverage. Subsystem paths resolve. Operator state:
    none new.
  - **Where I left off:** Batch 12 and its docs are committed and pushed (no PR). NEXT: Batch 13
    (Perfin UI correctness & accessibility).

- **Previous:** **Cycle 6 — Sept 2026 broad-scan, Batch 11 DONE** on branch
  `claude/lucid-darwin-7r8e59` (2026-10-08). Batches 3–10 were merged to `main` via
  robinchoudhuryums/pers-fin#129; the branch was then restarted from the new `main` and
  Batch 11 (Knowledge lifecycle & retrieval) implemented, tested, pushed (no PR opened).
  - **Completed:** KR-3 (vault ingested without Voyage/pgvector + embedding backfill),
    KR-4 (stopwords, per-source vector ranking with 4× over-fetch, matching-passage window),
    KR-7 (Voyage retry/backoff, per-file/per-note isolation, removals first, sha held on failure),
    KR-8 (lock claimed before the first await), KR-9 (finance snapshot via Perfin's getNetWorth +
    monthly-equivalent subscriptions), KR-10 (capture reserved keys + sensitivity, no AI for
    private/secret), KR-11 (success-only last_synced_at, db/023 vault_last_attempt_at, reindex ok,
    Action polls + fails, vault_sync_error notification), KR-12 (inline-citation parse),
    KR-13 (cache prune), KR-14 (word-segment attribute match, vault_repo validation, headers).
  - **Not finished (selected):** none.
  - **Tests:** 1551/1551 (Perfin 974 + Per-sistant 577; 62 files). New
    apps/per-sistant/tests/scan-sept-batch11.test.js (32; 31 fail pre-fix). Real PG without
    pgvector: migrations ×2, vault sync ingest/partial-failure/recovery, upcomingFacts, search
    window, cache prune, finance snapshot = getNetWorth. Rendered pages' scripts parse; e2e 8/8.
  - **Decisions:** keep an embedding whose text is unchanged when Voyage is off (no forced
    re-embed); stopwords are function words only; finance snapshot imports Perfin's helper
    (lazy, fail-soft) instead of mirroring it; the Action polls status rather than a long request.
  - **Open follow-ons:** see `.cycle/blocks/6-batch11-broad-implement.md`.
  - **Operator:** none required (db/023 auto-migrates); the reindex Action can now go red.
  - **/sync-docs DONE (Batch 11):** CLAUDE.md — Knowledge operator state (vault synced without
    Voyage/pgvector, backfill, retry), finance-grounding seam via getNetWorth (+ subsystem note and
    rotation-plan seam focus), INV-28/29/36 extended, NEW INV-85 (sync failures visible) and INV-86
    (capture sensitivity / reserved keys), SK3 expected result, test counts 1551/62 (Per-sistant 577)
    + batch11 test description. apps/per-sistant/CLAUDE.md — sync lifecycle, ranking, citation
    fallback, cache prune, finance snapshot, capture sensitivity, attribute segments, db/023,
    vault_sync_error, /api/rag/status + reindex + capture API notes, VOYAGE env, test counts 577.
    README.md + apps/per-sistant/README.md — keyword-degrade wording (vault docs + facts too),
    counts + Batch 11 coverage. Subsystem paths resolve. Operator state: none new.
  - **Where I left off:** Batch 11 and its docs are committed and pushed (no PR). NEXT: Batch 12
    (Investments) — restart the branch from main first if Batch 11 has been merged.

- **Previous:** **Cycle 6 — Sept 2026 broad-scan, Batch 10 DONE** on branch
  `claude/lucid-darwin-7r8e59` (2026-10-08). Batch 10 (Sheets & exports) implemented, tested, pushed (no PR opened).
  - **Completed:**
    - SXE-1 / WD-6: Sheets sync outcome persisted (user_settings.last_sheets_sync_result), signature-deduped notification, data-health issue, "Partial: N tabs failed" in dashboard / Subscriptions / Settings.
    - SXE-2: formatSheet() deletes banding + conditional rules before re-adding (Dashboard also resets formats).
    - SXE-14: per-run sheet-id cache with fields mask; 429-aware retry (POST only on 429); 6 archives/run.
    - SXE-3: archives 10 days after month-end + completion marker + rebuild of incomplete/legacy tabs.
    - SXE-5 / SXE-6 / SXE-10: derived goals; app category expression (SX3-pinned); KPI count not currency.
    - SXE-13: formula guard for Sheets writes (sheetFormula for our 3 formulas) + csvText for CSVs (new teller/services/csv-export.js).
    - SXE-8 / PSC-10: ISO dates + user merchant names in /api/export.
    - SXE-9: context-export — real insights, investment accounts, no Plaid phantom, debts negative, ISO dates.
    - SXE-15: Code.gs category precedence + layout check. SXE-16: comment + CLAUDE.md drift.
  - **Not finished (selected):** none.
  - **Tests:** 1519/1519 (Perfin 974 + Per-sistant 545; 61 files). New tests/scan-sept-batch10.test.js (26) + 3 SX3 pins. Two full syncAll runs on real PG against a stateful fake Sheets API (2nd run clean; the pre-fix script fails it on banding); real-PG export/context-export/data-health checks; migrations ×2; e2e 8/8.
  - **Decisions:** guard (apostrophe) rather than RAW writes; legacy archives rebuilt once (6/run); POSTs retried only on 429; "Partial" result shown under Settings → Last Auto-Sync for manual runs too.
  - **Open follow-ons:** see `.cycle/blocks/6-batch10-broad-implement.md`.
  - **Operator:** none required; legacy Apps Script users: clasp push + separate spreadsheet.
  - **/sync-docs DONE (Batch 10):** CLAUDE.md — new services/csv-export.js in the architecture tree + the Sheets & External Export subsystem list; Code.gs layout check + category precedence (separate spreadsheet); Sheets section: archive delay/marker/rebuild/6-per-run, re-runnable formatting, sheet-id cache + 429-only POST retry, formula guard, derived goals, app category expression, KPI count, persisted outcome + alert + data-health + Partial UI; Context export bullet + endpoint; /api/export, /api/sheets/sync, /api/data-health endpoint notes; new user_settings.last_sheets_sync_result DB bullet; INV-24 extended (outcome recorded), NEW INV-82 (re-runnable formatting), INV-83 (no formula evaluation in Sheets/CSV), INV-84 (settled-month archives + marker); test counts 1519/61 (Perfin 974) + batch10 test description. README — counts + Batch 10 coverage. Per-sistant CLAUDE.md unchanged (no Per-sistant code touched). Subsystem paths all resolve. Operator state: none new (last_sheets_sync_result auto-migrates).
  - **Where I left off:** Batch 10 and its docs are committed and pushed (no PR). NEXT: Batch 11 (Knowledge lifecycle & retrieval).

- **Previous:** **Cycle 6 — Sept 2026 broad-scan, Batch 9 DONE** on branch
  `claude/lucid-darwin-7r8e59` (2026-10-08). Batch 9 (platform hardening) implemented, tested, pushed (no PR opened).
  - **Completed:**
    - PSC-4: Secure cookies follow req.secure; shell error handler (no stack traces); NODE_ENV=production at runtime in Dockerfile/fly.toml (render.yaml deliberately not — build impact).
    - PSC-11: boot fails fast without SHELL_SECRET; login can't crash.
    - PSC-14: global PIN ceiling 30/h → 30 min lockout + "PIN login locked" alert; short-PIN boot warning.
    - PSC-7: shell body limit 1mb. PSC-9: return_to carried through login (incl. biometric).
    - PSC-8: general limiter skipped when embedded; tight limiter skips GETs.
    - PSC-13: guarded constraint rebuilds. PSC-6: reset-fresh table lists complete + schema-classification test.
    - PSC-15: shell deps declared; csv-import.yml permissions + no in-tree CSV archive; bounded settings 400.
    - PB-14: CIDR SSRF check incl. mapped IPv6, DNS-resolving check at send, redirect:'manual'.
    - PB-15: signed Perfin webhook passes Per-sistant standalone auth + the shell gate.
    - PB-21 / WD-16: logout works in both modes for both apps.
  - **Not finished (selected):** none.
  - **Tests:** 1490/1490 (Perfin 945 + Per-sistant 545; 60 files). New tests/scan-sept-batch9.test.js (37) + apps/per-sistant/tests/scan-sept-batch9.test.js (27). Real-PG migrations ×2 + constraint/reset checks; e2e 8/8; live booted-shell HTTP checks.
  - **Decisions:** PIN lockout refuses even the right PIN (biometric/API key unaffected); SSRF fails closed on DNS error; processed CSVs deleted rather than archived; NODE_ENV not set in render.yaml.
  - **Open follow-ons:** see `.cycle/blocks/6-batch9-broad-implement.md` (notably per-boot ADD COLUMN locks remain — PSC-13 residual).
  - **Operator:** SHELL_SECRET must be set (already is on Render); optionally lengthen a <6-digit SHELL_PIN.
  - **/sync-docs DONE (Batch 9):** CLAUDE.md — shell architecture (auth.js exports, new error-handler.js, also in the Platform subsystem list), reset-fresh lists, deploy configs + NODE_ENV rationale, csv-import workflow, UI auth bullet (global PIN ceiling, return_to), Security (logout both modes incl. Per-sistant, Secure cookies/no stack traces, SHELL_SECRET fail-fast, self-authenticating webhook route, 1mb body limit, rate-limit skips), env vars (SHELL_PIN length, SHELL_SECRET required), chk_account_source guard, INV-59/INV-60 extended, NEW INV-79 (PIN ceiling + SHELL_SECRET), INV-80 (resolving SSRF), INV-81 (reset-fresh classification), test counts 1490/60. apps/per-sistant/CLAUDE.md — SSRF CIDR/DNS/redirect, webhook auth exemption, embedded Log Out, 545 tests. README — counts, SHELL_PIN/SHELL_SECRET, error-handler. Subsystem paths 80/80. Operator state: SHELL_SECRET now required (documented).
  - **Where I left off:** Batch 9 and its docs are committed and pushed (no PR). NEXT: Batch 10 (Sheets & exports).

## Current Cycle (prior — broad-scan F1-F12 + T1-T4, cycle 5 reflected)

- **Status (this cycle 5 entry is historical):** Last completed cycle: **4** (2026-06-12 —
  Seams & Invariants audit #2 + health synthesis + reflect), fully merged to
  main (PR #116); results recorded in `PROJECT_HEALTH.md` + `.cycle/metrics.csv`.
  Post-cycle FEATURE rounds since (not audit cycles, all merged): auto-loan
  support (PR #117/#118) and notifications-dedup/subtask-progress/hybrid-
  transition/top-bar-Ask/login+biometric (PR #119). Tests: **988** across 37
  files (Perfin 601 + Per-sistant 387) + 8 Playwright smokes. Seams counter: 1
  of 3 (cycle-5 broad-scan full sweep reflected 2026-06-15; cadence not yet due).
  **Next:** a FRESH `/broad-scan` or `/targeted-audit` — the un-audited churn
  (health.js, ask.js, loan-payoff math, transition rewrite, top-bar Ask) is the
  highest-value target. History of prior cycles preserved in the records below.

### Broad-scan + broad-implement T1/T3 (2026-06-15, branch `claude/beautiful-hamilton-abf4h0`)
Full 3-stage /broad-scan run (6 subsystem deep-dive agents + Stage-2 test-quality &
migration-safety dives). Findings F1-F12 + T1-T4 in the session report. Implemented
the test-quality findings **T1 + T3 ONLY** (operator scope):
- **T1** `tests/sync-idempotency.test.js` (NEW) — behavioral idempotency: runs
  `syncAllEnrollments` (Teller) and `syncPlaidItemTransactions` (Plaid) TWICE over the
  same mock fixtures; asserts 2nd run adds 0, no dupes, watermark stable. Closes the
  gap where INV-01/03/04 + S1 were source-string-pinned only and the one reconcile
  test ran against empty enrollments. Required a 1-line test-only export
  `module.exports.syncPlaidItemTransactions` in investments.js (matches the existing
  `sumHoldingsByAccount` precedent; INV-19-compliant, after the router export).
- **T3** `tests/ai-cap-charge.test.js` (NEW) — behavioral cap enforcement for /api/ask
  + runCategorize via a Module._load-injected fake @anthropic-ai/sdk (CI-safe, no prod
  change): ask charges one entry_type='ask' row on success, 429-without-charge once cap
  hit, tool loop runs + charges accumulated tokens; categorize charges
  entry_type='categorize' + writes user_category source 'ai', 429 with free rules still
  applied. Includes a SKIPPED test documenting **F1** (ask charges only after the loop →
  mid-loop throw escapes the cap) as a behavioral target for when F1 is fixed.
Tests: 988 → 997 (8 active + 1 skip). Full `npm test` green (996 pass / 1 skip / 0 fail).

### Broad-implement F1 + T2 + T4 (2026-06-15, same branch) — follow-on
- **F1** `teller/routes/ask.js` — the entry_type='ask' usage-row INSERT was moved
  into a `chargeAsk()` closure called on success AND in a `finally` block when tokens
  were consumed but not yet charged, so a mid-tool-loop throw no longer spends tokens
  that escape the shared monthly cap (parity with rebuild AIA2 / categorize M2). Charge
  is idempotent (`charged` flag); 429/400/501 early-returns consume nothing so finally
  skips. Un-skipped the F1 behavioral test in tests/ai-cap-charge.test.js (now asserts
  500 + one charged 'ask' row with the round-1 tokens).
- **T2** `teller/routes/insights.js` — hoisted `sanitizeForPrompt` from a closure inside
  generateInsights to a module-scope function + exported it; tests/coverage-gaps.test.js
  now exercises the REAL deployed function instead of a re-implemented copy (was
  tautological). Behavior unchanged.
- **T4** tests/loan-support.test.js — replaced the string-presence "parity smoke" with a
  test that EXTRACTS the inlined dashboard `loanPayoff()` (regex) and RUNS it against the
  same inputs as `computeLoanPayoff`, asserting numeric parity (months, total_interest
  ±$0.01, insufficient-payment flag) across 5 scenarios.
Tests: 997 pass / 0 skip / 0 fail. No production behavior change for T2/T4 (test-quality);
F1 fixes a real uncapped-spend gap.
### Broad-implement F2–F6 + /sync-docs (2026-06-15, same branch) — follow-on
- **F2** `teller/routes/enrollments.js` — `syncAllBalances` net-worth snapshot bare
  `catch {}` now logs (`console.error`), so a getNetWorth/snapshot failure isn't silent.
- **F3** `teller/public/perfin-shared.js` — `esc()` now escapes `"`/`'` (5-char replace)
  so bank-supplied names can't break out of double-quoted attribute contexts
  (data-name/aria-label). CSP already blocked injected inline handlers; this closes the
  markup-injection vector. (NOTE follow-on: api.test.js:344 has a separate tautological
  esc COPY that already encodes the correct behavior — couldn't de-tautologize without
  jsdom; left in place, now consistent with the real fn.)
- **F4** `teller/routes/investments.js` `syncAllPlaidHoldings` — the linked_accounts
  MIRROR UPDATE now guards the holdings-sum FALLBACK case (`current_balance IS NULL OR
  = 0`) so it doesn't clobber a real cash-inclusive balance; a real account-level current
  still updates unconditionally. investment_accounts (authoritative) + the Schwab $0
  fallback are unchanged.
- **F5** `teller/routes/insights.js` — audit-alert push gated by
  `sentRecently('audit-alert', 24)` so a steady-state critical finding doesn't re-push on
  every 6h auto-insight tick (fail-open if the dedup check errors).
- **F6** `teller/services/ai-audit.js` — widened `CROSS_PERIOD_RE` with unambiguous
  cross-period tokens (last/previous/prior month, N months ago, year-over-year, trailing,
  estimate(d)) so those claims skip the this-month dollar comparison. Deliberately did NOT
  skip bare/`per month` claims — AIA1 + pinned tests intentionally check those. +7 test
  cases in tests/ai-audit.test.js.
- /sync-docs: CLAUDE.md + README test counts 988→1004 (Perfin 617 + Per-sistant 387),
  37→39 files; F5/F6 behavior notes added to the AI-audit section.
Tests: 1004 pass / 0 skip / 0 fail.
### Broad-implement F7–F12 + /sync-docs (2026-06-15, same branch) — follow-on
- **F7** `teller/routes/spending-analytics.js` `/api/savings-rate` — averages now
  exclude the partial CURRENT month (parity with FIRE + getMonthly* semantics), with a
  fallback to all rows when the only data is the current month. `months` array unchanged.
  (FIRE in goals.js already excluded current month; the zero-empty-month omission in
  getMonthly* GROUP BY is a shared-helper concern, deliberately left out of scope.)
- **F8** `teller/routes/subscriptions.js` — forecast + bill-calendar cadence-advance
  `while` loops now `continue` on `cadence_days <= 0`/NaN (latent infinite-loop guard,
  matching the ICS builder).
- **F9** `apps/per-sistant/routes/health.js` — PATCH enforces the quantity⇒target_value
  invariant on the MERGED post-update state (fetches existing kind/target) so switching
  to quantity without a target — or nulling a quantity habit's target — 400s instead of
  silently degrading meetsTarget. +4 tests.
- **F10** `teller/services/benchmarks.js` — the once/day fetch gate now gates per-day only
  on SUCCESS; a transient FAILURE throttles retries ~30 min (FAIL_RETRY_MS) instead of
  suppressing the benchmark all day. `_resetFetchGate` updated; existing "attempts===1"
  test still green.
- **F11** `teller/routes/settings.js` — `target_allocation_pct` and
  `shell_idle_timeout_minutes` now 400 on invalid input (consistent with fire_*/budget)
  instead of silently dropping + returning 200. +3 tests.
- **F12** `teller/views/dashboard.ejs` — inlined loanPayoff date label formatted in UTC
  (timeZone:'UTC') so the displayed month matches the API's UTC payoff_date.
- /sync-docs: counts 1004→1011 (Perfin 620 + Per-sistant 391); benchmarks once/day note
  updated for the F10 fail-retry behavior.
Tests: 1011 pass / 0 skip / 0 fail.
**Where I left off:** ALL broad-scan findings F1–F12 + T1–T4 implemented & committed on
`claude/beautiful-hamilton-abf4h0`. Remaining notes (not findings): the api.test.js esc
tautology (separate test-quality item, needs jsdom to de-tautologize); the getMonthly*
zero-empty-month GROUP BY omission (shared-helper, would need zero-filling across all
callers — deliberately deferred).

### Broad-scan + broad-implement (June 2026 session, branch `claude/exciting-albattani-ug1gjv`)
Full 3-stage /broad-scan completed (4 subsystem deep-dives + gap-fill on Web UI/A11y,
Export Fidelity, Notification Correctness, Income Classification). Implemented F1-F5:
- **F1** `.github/workflows/db-backup.yml` — nightly pg_dump of both Neon DBs from
  GitHub Actions, AES-256 artifacts, 90-day retention, restore runbook in header.
  README "Backups" section. OPERATOR: set NEON_DATABASE_URL, PERSISTENT_DATABASE_URL,
  BACKUP_ENCRYPTION_PASSPHRASE repo secrets; do one restore drill.
- **F2** database.js — missing TOKEN_ENCRYPTION_PASSPHRASE now fatal at boot
  (ALLOW_MISSING_TOKEN_PASSPHRASE=true escape hatch). Test files set mock passphrase.
- **F3** teller-api.js — boot warning when loaded Teller cert matches the compromised
  fingerprint (d58d1d12...0954) from git history. OPERATOR (still open): rotate cert in
  Teller dashboard, then scrub history (git filter-repo).
- **F4** services/job-health.js + job_runs table + ticks in every startup.js interval +
  6-hourly/post-boot watchdog ("jobs-missed" notification, signature-deduped, 36h+ threshold).
- **F5** notifications.sentRecently(tag, hours) — budget alerts max 1/category/severity/24h.
Tests: 779 pass (764 -> 779, +15 in tests/broad-scan-fixes.test.js).
**Open follow-ons:** F6 Code.gs splits divergence; F7 Per-sistant CSP nonces; F8 notif-panel
a11y + contrast; F9 recurrence_interval CHECK; F10 insights-email escaping audit; docs drift
(test count 745 -> 779 in CLAUDE.md x3 + README) -> /sync-docs.
**Where I left off:** F1-F5 committed + pushed on `claude/exciting-albattani-ug1gjv`; awaiting
review/merge + the three operator actions above.

### Broad-implement F6-F10 + /sync-docs (same session, same branch)
/sync-docs applied (test counts, job_runs, watchdog, backup secrets, fail-fast passphrase,
stale README 663/17 table entry, per-sistant 257->343). Then implemented F6-F10:
- **F6** Code.gs buildDashboard prefers GET /api/spending-summary (canonical splits/
  reimbursed/split_pct numbers) when SERVER_URL set; local sheet aggregation = standalone
  fallback. Dead sortedMonths/sortedCats opts removed. DEPLOY: clasp push + new Apps
  Script version (per Deploy Command).
- **F7** Per-sistant CSP nonce migration (PB-3 closed): nonce in views.basePathMiddleware
  -> res.locals.cspNonce + ALS; helmet scriptSrc nonce directive, 'unsafe-inline' removed;
  nonceAttr() on all inline scripts (views.js x5, 11 pages, routes/auth.js login).
- **F8** Perfin notification a11y (button bell + role=dialog + focus mgmt + keyboard rows +
  toast aria-live + surfaced mark-read failures) + AA contrast tokens (muted 0.70/0.75,
  light teal #336363).
- **F9** recurrence_interval >= 1: todos POST/PATCH validation, db/018 clamp+CHECK
  (todos + todo_templates), advanceRecurrence floor.
- **F10** email renderers audited — already consistently escaped; pinned with behavioral
  hostile-string tests (finding effectively retracted-on-close-read, now regression-proof).
Tests: 796 pass across 26 files. Both waves committed on `claude/exciting-albattani-ug1gjv`.
**Remaining follow-ons:** N+1 goal milestones; unread badge 9+ cap; per-sistant CLAUDE.md
still says script-src carries 'unsafe-inline' (now stale — fixed in parent docs sweep? NO:
update apps/per-sistant/CLAUDE.md Helmet CSP paragraph next /sync-docs); job_runs surface
in /api/data-health (optional).

### Roadmap update + investment-performance implementation (same session, same branch)
Roadmap: DROPPED multi-user + onboarding by operator decision (documented in CLAUDE.md
Priority Next Features with rationale); roadmap #4 (investment performance) IMPLEMENTED:
- services/benchmarks.js + benchmark_prices table — S&P 500 closes from Stooq (keyless),
  lazy fetch, once/day gate, graceful failure (benchmark:null, never errors).
- GET /api/investments/performance-history (months 3-60) — portfolio value series from
  account_balance_snapshots (investment-source + Teller-linked investment types, Plaid
  phantom-twin dedupe same direction as getNetWorth, per-account forward-fill via
  exported buildPortfolioSeries) + benchmark trimmed to window + excess return.
- Dashboard: "Value vs S&P 500" sub-card (3M/6M/12M, dual-line normalized SVG) —
  independent of Plaid holdings; cost-basis Total return row now holdings-gated.
- DESIGN NOTE: value-based point-to-point return (contributions count as growth) — true
  TWR deliberately scoped out (flows not reliably attributable from snapshots alone);
  the contribution-adjusted figure remains /performance's cost-basis return.
Tests: 812 pass across 27 files (+16 tests/investment-performance.test.js).

### TWR/XIRR implementation (same session, same branch)
investment_flows table + classifyPlaidFlow (subtype-driven signs; dividends/cap-gains =
return, not flows) + syncAllPlaidInvestmentFlows (full-window idempotent, wired into
auto-sync + pre-insights + sync-balances chains) + manual flow CRUD
(GET/POST/DELETE /api/investment-flows, plaid rows delete-protected) + computeTWR (daily
chain-linked exact) + computeXIRR (bisection) on performance-history with flow_coverage
scoping {coverage_pct, scope all|partial|none}. Dashboard: TWR/XIRR line + log-flow form
(Plaid accounts excluded from dropdown). Tests: 837 across 28 files (+25
tests/investment-flows.test.js).

### PWA Phase-0 fixes + polish (same session, same branch)
Phase-0 PWA testing surfaced: (1) biometric registration 401'd under the shell —
register endpoints checked Perfin's standalone session, never written when embedded;
fixed with the INV-25 embedded bail (tests pin both guards). (2) VAPID keys were never
generated — operator set all three on Render (resolved, no code). (3) AI budget cap
\$0.512/\$0.50 = documented check-then-charge overshoot, working as designed; added
Settings-tunable cap (user_settings.ai_monthly_budget_cents, getAiBudgetCents() single
resolver, INV-14). (4) PWA polish: pull-to-refresh in both apps' shared JS
(standalone-only, passive, overlay/pyramid/canvas exclusions) + safe-area pass (Perfin
body pads env(safe-area-inset-*) under viewport-fit=cover — the notch collision was
structural, not per-page; shell login/landing same; Per-sistant deliberately untouched,
auto-insets, pinned by test). Native iOS app DEFERRED: no APNs without \$99/yr, web push
doesn't run in native WebViews, free-signing loses notifications vs the PWA.
Tests: 856 across 30 files (+9 budget-cap-webauthn, +10 pwa-polish).

### Native iOS wrapper scaffold (same session, same branch)
mobile/ Capacitor workspace (NOT in root npm workspaces): remote-URL mode at the Render
deployment, iOS project generated + icons from the mask-crop artwork, Teller/Plaid
allowNavigation, offline stub, free-signing runbook + Phase-2 device checklist in
mobile/README.md. PTR gate widened to window.Capacitor. Coexistence design: PWA stays
installed alongside (separate session; web push keeps flowing through the PWA — native
free-signed build has no APNs; notification taps open the PWA). Operator next: on the
Mac — cd mobile && npm install && npx cap sync ios && npx cap open ios, personal-team
signing, run on device. Tests: 859 across 30 files (+3 scaffold pins).

### UI polish round 2 (field-testing feedback, same branch)
Opaque floating chrome (--surface-solid token; toasts/notif-panel/nav-drawer were 3-10%
alpha — content bled through, screenshot-confirmed). Recent Transactions removed from
dashboard → Activity page is the surface: mobile filters collapse behind a toggle,
rows use new txn-compact 2-line grid (~3x density vs responsive-cards). Dashboard:
4 sections collapsible (localStorage-persisted), Spending by Category month selector
backed by new GET /api/spending-categories (getCategorySpendingForMonth). Updated 2
stale cycle-fixes pins that encoded the old layout. Tests: 870 across 31 files
(+11 ui-polish).

### Login default + icon particle transition (same branch)
Post-login default → /per-sistant (DEFAULT_POST_LOGIN in shell auth.js; landing still at
/; safeReturnTo open-redirect guard unchanged, fallback destination updated incl. the
biometric path in login.ejs — sync-durability pins updated). transition.js rewritten
around a canvas particle engine: samples the PWA icon img into ~3k colored particles,
assemble 950ms → shimmer 280ms → burst 520ms → navigate; prefers-reduced-motion =
instant nav; CSS-mask-reveal kept as fallback. Tests: 874 across 31 files.

### Ops & alerts batch (broad-implement round 3, same branch)
1) CI migration test: ci.yml 'migrations' job (pgvector/pgvector:pg16 service container)
runs both apps' migrations twice via scripts/ci-migration-test.js; pools honor
PGSSLMODE=disable (CI-only escape hatch). 2) Out-of-process scheduling: daily-sync.yml
+= sync-balances + net-worth snapshot; new weekly-reconcile.yml (Teller 90d, Sundays).
3) RAG v2: hybrid retrieval (RRF fuseRetrieval, INV-29 text updated) + semantic answer
cache (db/019 query_embedding, cosine>=0.97, INV-32 updated); token-aware chunking
DEFERRED (full re-embed churn vs marginal gain). 4) Critical-alert emails (opt-in
critical_alert_emails_enabled; budget-exceeded shares 24h dedup; anomaly = one summary
email/run, never holds watermark) + bill-calendar .ics (buildBillCalendarIcs + shell
public /calendar.ics gated on new CALENDAR_FEED_TOKEN env — the one sanctioned query
credential). 5) Small fry: badge 99+, integer-cent split sum, milestone N+1 removed,
data-health jobs[] surface. Tests: 901 across 33 files (+27).
OPERATOR (new): optionally set CALENDAR_FEED_TOKEN (long random) to enable the calendar
feed; subscribe iOS Calendar to https://<host>/calendar.ics?token=<token>.
**Where I left off:** everything committed + pushed on `claude/exciting-albattani-ug1gjv`.
Remaining my-court items: custom income keywords UI only.

### Chunking + splits + browser smokes (broad-implement round 4, same branch)
1) Token-aware chunking SHIPPED (vault empty = zero re-embed cost): estimated-token
budgets (max(words×1.32, chars/4)), heading→paragraph→sentence→word cascade (no
mid-word slicing), CHUNKING_VERSION salts the embed_state hash so future chunker
changes auto-re-embed. 2) Route splits (interface-preserving, helpers re-exported BY
IDENTITY): investments.js 2153→1649 (+ routes/investment-performance.js 503 + shared
services/plaid-client.js); insights.js 1622→1376 (+ routes/insights-email.js 264).
3) Playwright smokes: e2e/ harness (boot-server.js scratch DBs → shell boot), 8 specs
(login wrong/right incl. /per-sistant default, both apps' pages, feed gate), CI 'e2e'
job, npm run test:e2e (kept out of npm test). REAL local verification: started the
sandbox's Postgres 16 — scripts/ci-migration-test.js passed clean (both apps × 2, all
19 per-sistant migrations, keyword-degraded path), and the harness booted the full
shell with every smoke flow verified over HTTP. Chromium itself couldn't download
(sandbox CDN allowlist) — browser layer executes in CI. Tests: 911 across 33 files.

### Final route splits (round 5, same branch) — user merging after this
enrollments.js 1555→992 (+ routes/spending-analytics.js 589: the six read-only
aggregation endpoints); subscriptions.js 1510→1069 (+ routes/transactions.js 467:
per-transaction search/list/duplicates/csv-overlap/PATCH/splits/DELETE). Mount-based,
paths unchanged, helper exports stayed put; 2 stale pins relocated. BONUS REAL BUG
found by the live e2e boot: /api/income-summary 500'd ('column reference name is
ambiguous' — INCOME_PREDICATE unqualified outer refs × linked_accounts JOIN); fixed
via INCOME_PREDICATE_T t.-qualified derivation (insights' t2-rewrite convention),
live-verified 200. All moved endpoints live-verified against a real boot. Subsystem
lists updated (spending-analytics → Financial Analytics; transactions → Detection &
Categorization). Tests: 915 across 33 files.
### Post-merge features (round 6, same branch — new PR needed)
FIRE/runway projections: services/projections.js (pure math: FIRE number = annual spend
× 100/SWR, geometric monthly compounding, 40-yr series; runway w/ growth), GET
/api/fire-projection (completed-month averages, fire_* settings w/ PATCH bounds), Goals
page card (stats + SVG + inline assumptions). Ask Perfin NL Q&A: routes/ask.js — Claude
tool use over 7 read-only tools bound to shared helpers (numbers match dashboard;
parameterized only, injection-tested), bounded loop, shared AI cap (429) + entry_type=
'ask' usage row; dashboard widget (key 'ask'). Caught my own alias bug in test
(total_spend not total_spent). Live-verified: fire 200 graceful-empty, ask 501-gated,
both UI surfaces render. Tests: 934 across 34 files (+19).
DECISION RECORDED: health/habits tracker → expand Per-sistant (streaks/analytics/
notifications already there), extract to third sub-app only if it outgrows a page.
### Health/habits tracker built (round 7, same branch)
Implemented per the decision: db/020_health.sql (habits, habit_logs UNIQUE(habit_id,
log_date), health_metrics UNIQUE(metric, recorded_on)); routes/health.js (CRUD + log
upsert + summary/heatmap/metrics; READ-TIME streaks — computeStreaks/isDueOn pure +
exported, INV-19 attach-after-factory; DELETE archives, never hard-deletes; future-date
400; streak_milestone webhook at 7/30/100/365); pages/health.js (/health: today list w/
quantity steppers, clickable 7-day backfill grid, 90-day heatmap, measurements + SVG
trend; backtick-free page JS, nonceAttr, zero inline handlers); NAV + heart icon;
notification check gained habit_streak_at_risk + habits_due counts (fail-soft .catch);
AI daily briefing gained habits line (fail-soft). gatherHealthSummary is the ONE
aggregator shared by page/notifications/briefing. Live-verified on scratch PG16:
migration fresh + idempotent (2nd boot "20 files"), streak build 0→2→3 incl. backfill
repair, quantity 5/8 not-met → 8 met, future 400, metrics upsert+lowercase, heatmap,
notification counts, archive/restore. Tests: 963 across 35 files (+29 in
apps/per-sistant/tests/health.test.js). Docs synced (both CLAUDE.mds, both READMEs,
roadmap → Shipped).

**PRIOR MERGE DONE; this round needs a fresh merge** —  (pre-merge: confirm
TOKEN_ENCRYPTION_PASSPHRASE in Render; watch the first CI run's 3 jobs). Operator items unchanged (merge w/ passphrase check, backup secrets+drill,
cert rotation, clasp push, VAPID done).
**Where I left off:** everything committed + pushed on `claude/exciting-albattani-ug1gjv`
(F1-F10 + docs + investment performance + TWR/XIRR); awaiting review/merge + operator actions
(Render passphrase check BLOCKS DEPLOY; backup secrets; cert rotation; clasp push for
Code.gs F6). Remaining follow-ons unchanged otherwise.

### AI Insights & Audit targeted cycle (this session)
Audited; 3 findings (1 Medium AIA1, 2 Low AIA2/AIA3). Implemented A1–A2, deferred A3:
- **A1 (AIA1)** ai-audit.js: Tier-1 dollar-claim arithmetic now SKIPS claims whose context signals a non-current-month window (annual / multi-month / YTD / projected / average — `CROSS_PERIOD_RE`), since the only per-category + subscription actuals it has are this-month. Stops false-positive CRITICAL findings (audit-alert notification spam + deflated audit_accuracy%) on annualized advice. this-month/unqualified claims still checked. Exported `CROSS_PERIOD_RE` + added 15 classification tests.
- **A2 (AIA2)** insights.js /api/insights/rebuild: moved the `entry_type='rebuild'` usage-row INSERT to immediately after the Claude call — BEFORE the tool-block validation early-returns and the summary UPDATE — so a rebuild that truncates/fails-validation (previously 500'd before the insert) still records its already-incurred spend against the shared monthly cap. Failure now logged loudly.
- **Deferred:** A3 (AIA3 — empty insight_text row reaches the feed when the model returns neither tool nor text block; cosmetic, rare with tool_choice forced).

### Seams audit (this session) — COMPLETE, clean
Audited the cross-subsystem boundaries. No Critical/High/Medium. Verified OK:
webhook event shape (in-process deliverDigestInProcess + HTTP receiver insert
identical emails columns + identical recipient resolution; status CHECK allows
draft/scheduled); perfinPool read contract (all linked_accounts/detected_subscriptions
columns rag.js + the Perfin widget assume exist today, INV-35); productivity-context
(todos/emails/notes/weekly_reviews columns exist; standalone fallback unwraps /api/review
shape); embedded-auth + pool wiring (no HTTP self-fetch except documented standalone
fallbacks + the test event, INV-25); settings↔shell idle-cache (shellAuthInvalidator
wired callback, sanitizeBoolMap + bounds, SN-5).
Findings:
- **SEAM-1 (Low, doc/impl drift — FIXED this session):** CLAUDE.md said enrollments.js/insights.js hold "inline copies" of SPLIT_AMOUNT; they actually IMPORT it from financial-queries.js and template-interpolate (safe `.replace` alias transforms), so they can't drift. Only sheets-sync.js (byte-matching) + Apps Script Code.gs (stale fork, broad-scan L1) are true copies. Corrected the Shared-Account-Spending-Split doc section.
- **SEAM-2 (Low, accepted):** cross-app perfinPool reads + the Perfin widget swallow ALL errors (→ null / connected:false), so a FUTURE Perfin column rename degrades silently. Documented INV-35 posture; intentional. No action.

### Platform, Shell & Auth targeted cycle (this session)
Audited the full subsystem (shell/index.js, auth.js, webauthn.js, server.js, startup.js, database.js, keep-alive.js, reset-fresh.js). Strong shape — 0 Critical/High/Medium, 4 Low. Implemented A1–A2, deferred A3/A4:
- **A1 (PSA1)** database.js: version-gated the detection-key orphan cleanup (bumped SCHEMA_VERSION 2→3; wrapped the two UPDATEs in `if (currentVersion < 3)`) so it runs ONCE instead of every boot — stops the recurring rare false-deactivation (two distinct merchants sharing a raw name, one renamed) and makes "one-shot" true. schema_migrations now gates one step (was observability-only).
- **A2 (PSA2)** shell/webauthn.js: pinned `requireUserVerification: true` on verifyAuthenticationResponse. NOTE: @simplewebauthn/server v11 ALREADY defaults this to true (verified in node_modules), so this is a defense-in-depth PIN against a future SDK-default flip, NOT a live-vuln fix — the audit finding overstated it.
- **Deferred:** A3 (reset-fresh CASCADE FK-topology guard — latent), A4 (shell shutdown doesn't stop sub-app cron — cosmetic).
- Tests 760, 0 fail.

### Settings, Notifications & Cross-app targeted cycle (this session)
Audited settings.js, notifications.js, persistent.js + the cross-app seam. Mostly clean — 0 Critical/High, 1 Medium, 2 Low. Implemented A1–A2, deferred A3/A4:
- **A1 (SETT1, Medium)** settings.js: `/api/export` (transaction CSV) and `/api/export/tax-report` (CSV + summary) now quote-escape EVERY interpolated text field (account, institution, category in the txn export; category, deduction_type, summary-category in the tax report). Previously only merchant/notes were escaped, so a `"` in the others silently misaligned the CSV columns.
- **A2 (SETT2, Low)** settings.js: `data-freshness` `stale` boolean uses `age >= STALE_SEC` so it agrees with `level==="stale"` at the exact 24h boundary (was `>`, off by a 1-second window).
- **Deferred:** A3 (CSV formula-injection prefix-guard `= + - @` — single-operator own-data, low priority), A4 (log inside cross-app read catch so a future Perfin schema rename isn't fully silent — accepted INV-35 posture / SEAM-2).
- Tests 760, 0 fail. notifications.js + persistent.js (SSO/productivity-context/webhook) verified clean; cross-app contracts confirmed by the seams audit.

### Per-sistant Web UI targeted cycle (this session)
Audited views.js + views/*.js + pages/*.js (XSS-sink scan). Cross-module follow-on from Knowledge/RAG CLOSED: renderMd escapes &<> first → safe backstop. Severity recalibrated from the scan's 3 Medium → 5 Low: CSP `script-src-attr:'none'` (confirmed via helmet defaults) blocks inline-handler execution + no javascript:-href sink, so the escaping gaps are correctness/defense-in-depth, not live XSS. Implemented A1–A2, deferred A3:
- **A1 (PWUI1-4)** added `escAttr()` (encodes & < > " ') to views/js.js; used it for the `title=`/`<option value=` attribute contexts (todos-script-1.js:40,46,86-87,89) and added `esc()` to the option text + automation condition key/value (settings-script.js:161). esc() alone can't neutralize the `"` breakout in attribute context.
- **A2 (PWUI5)** middleware.js: explicitly pinned `scriptSrcAttr: ["'none'"]` so the inline-handler block doesn't depend on helmet's implicit default (effective header unchanged — was already 'none' via default).
- **Deferred:** A3 (remove `'unsafe-inline'` from script-src via per-request-nonce migration — the real PB-3 fix, L effort).
- Tests 760, 0 fail. Emitted client JS bodies verified to parse.

### Per-sistant Backend targeted cycle (this session)
Audited server.js, ai.js, config.js, db.js, errors.js, helpers.js, middleware.js, keep-alive.js, db/*.sql, routes/* (excl. rag/perfin/webhooks). Heavily hardened — 1 Medium, 4 Low. Implemented A1–A2, deferred A3/A4/A5:
- **A1 (PSB1, Medium)** db.js: flipped `ssl.rejectUnauthorized` false→true so the Neon TLS cert is verified (was MITM-exposed; inconsistent with Perfin which already verifies). Deploy-sensitive but Perfin connects to Neon with verification successfully → strong evidence the cert is trusted.
- **A2 (PSB2, Low)** helpers.js: `sendWebhook` now re-validates the URL via isValidWebhookUrl at SEND time (mirrors sendSlackNotification) — closes the SSRF defense-in-depth gap + matches the documented invariant.
- **Deferred:** A3 (config.js IPv6-mapped SSRF regex misses ::ffff:192.168./172.16-31. — single-operator), A4 (integer-:id guards + bulk/import element validation — robustness, parameterized so no security risk), A5 (recurring streak on-time UTC-boundary tz edge).
- Tests 760, 0 fail. Verified clean: PS-1/2/11, PB-1/2/4/5, constant-time auth, CSRF+sameSite:lax, AI model resolution (whitelisted, no stale opus), no SQLi.

### Sheets & External Export targeted cycle (this session)
Audited sheets-sync.js, retention-cleanup.sql, Code.gs. 3 Low. Implemented A1–A3, deferred A4:
- **A1 (SX2-email)** Code.gs: added `escapeHtml_` + escaped a.service/a.detail/u.service/u.date in the subscription-alert email HTML. Requires a separate clasp/Apps Script deploy.
- **A2 (SX1)** retention-cleanup.sql + subscriptions.js POST /api/cleanup + api.test.js: bumped retention 18mo→36mo (must be ≥ the longest analytical window — detection 36mo / seasonal 24mo — so cleanup doesn't silently truncate them; size-safe ~18k rows). Fixed the stale n8n header in the reference SQL. Kept the reference SQL + live endpoint in lockstep.
- **A3 (SX3)** tests/audit-regressions.test.js: new source-pinned `pin()` block asserting sheets-sync's inlined NOT_TRANSFER / INCOME include+exclude keywords / SPLIT_AMOUNT CASE byte-match financial-queries.js canonical (4 pins, all green → confirms no current drift).
- **Deferred:** A4 (Code.gs standalone CSV path: rowIndex dedup-ID / filename-first detection / loose WF — recommend DEPRECATE the standalone path, header already steers to "Sync from Server", rather than perpetually port).
- Tests 764 (+4), 0 fail.

### Rotation status — COMPLETE
Every non-frozen subsystem audited+implemented this cycle: Bank Sync, Financial Analytics, broad pass, Knowledge/RAG, Detection & Categorization, AI Insights & Audit (+seams audit), Platform/Shell & Auth, Settings/Notifications/Cross-app, Per-sistant Web UI, Per-sistant Backend, Sheets & External Export. (Web UI (Perfin) was covered by the broad-scan Web UI agent; not given a standalone targeted cycle.) Frozen excluded: plaid/server.js, n8n-workflows. Next: run `/reflect` to record metrics + promote candidate invariants, and a Health Synthesis; consider a fresh `/broad-scan` next cycle. Open PR: none (all on branch claude/sweet-brahmagupta-3uwc4r).

### Doc drift to sync (NEXT /sync-docs)
- Per-sistant CLAUDE.md Webhooks line — DONE (commit 3a5c45d). No outstanding doc drift from the Sheets cycle (no doc stated the 18-month window).

### Doc drift to sync (NEXT /sync-docs)
- Per-sistant CLAUDE.md "Helmet CSP" feature line says `script-src-attr` "defaults to 'none' (via helmet)" — now set EXPLICITLY (A2/PWUI5). Optionally note `escAttr()` as the attribute-context escaper alongside the PS-4 renderMd note.

### Doc drift to sync (NEXT /sync-docs)
- CLAUDE.md Database section says "schema_migrations ... recorded for observability only; it does not gate any migration logic today" AND the "Detection-key migration window" section says the cleanup "runs on every startup" — both now STALE after A1 (the cleanup is version-gated to run once via `currentVersion < 3`). Correct both.
- Optionally note A2's `requireUserVerification: true` pin in the WebAuthn/biometric section.

### Detection & Categorization targeted cycle (this session)
Audited; 7 findings, all Low (3 prior broad-scan items here — M1 LIKE-escaping, M2 cap-escape, L2 CSV balance match — already fixed earlier this cycle). Implemented A1–A4, deferred A5/A6:
- **A1 (DC1)** detect-subscriptions.js: `"bp "` → `"bp"` so the gas-station exclusion word-boundary-matches `BP` instead of substring-matching `"bp "` mid-word.
- **A2 (DC2)** detect-subscriptions.js: header comment "last 12 months" → "36 months" (matches the query window).
- **A3 (DC3)** categorize.js: the three IMPLICIT rule-creation paths (review, accuracy-review, from-transaction) no longer overwrite `match_type` on conflict — they reactivate the existing rule but keep its match semantics. The EXPLICIT `POST /api/categorization-rules` (where the user deliberately chooses match_type) is intentionally unchanged.
- **A4 (DC6)** subscriptions.js: split-sum validation now compares integer cents (`round(x*100)`) — honors the documented "within $0.01" exactly AND is float-safe (replaces the `> 0.011` FP padding).
- **Deferred:** A5 (DC5/DC4 — Schwab parser return NaN not 0 on no-valid-amount; needs a CapOne CSV sample to settle the both-columns-0.00 case), A6 (DC7 — stale `MODEL_MAP.opus` → claude-opus-4-6; belongs to the AI Insights model-config cycle).

### Rotation status
Cycles done: 1 Bank Sync, 2 Financial Analytics, + broad pass, + Knowledge/RAG, + Detection & Categorization. Next per rotation: AI Insights & Audit (4). Seams audit is due after this (every 3 subsystem cycles).

### Knowledge / RAG targeted cycle (this session)
Audited Knowledge/RAG; 6 findings (1 Medium, 5 Low). Implemented A1–A4, deferred A5/A6:
- **A1 (K1, Medium)** vault-sync.js syncVault prose branch: `await clearFacts(pool, path)` so a fact-file→prose conversion drops orphaned facts that were still being injected into answers (asymmetry with prose→fact, which already cleared the doc).
- **A2 (K2, Low)** rag.js upcomingFacts: `value::date` → `to_date(value,'YYYY-MM-DD')` so one date-shaped-but-invalid fact value (e.g. 2025-02-30) can't throw and silently disable ALL upcoming-fact notifications.
- **A3 (K4, Low)** vault-sync.js syncNotes: now holds the `_syncing` single-flight lock (busy→no-op) so the hourly cron's notes phase and a concurrent reindex can't overlap-embed. Strengthens INV-36 (previously the notes leg was unlocked).
- **A4 (K5, Low)** vault-sync.js embedSource: empty-body sources now upsert `embed_state` (chunk_count 0) instead of just clearSource, so the content-hash skip engages instead of re-clearing every sync.
- **Deferred:** A5 (K3 — parse inline [n] in the Citations fallback so `grounded` isn't always false on that path), A6 (K6 — allow capture into private/secret tier). Plus cross-module follow-on: verify Per-sistant's shared `renderMd` escapes raw HTML (not just link schemes) since the Knowledge answer renders via `renderMd` into innerHTML under a CSP that still has `script-src 'unsafe-inline'` (PB-3).
- **Phase:** implemented — not yet Health-Synthesized (broad-scan Axis-A scores recorded in the session report, not yet promoted to PROJECT_HEALTH.md).
- **Subsystem audited:** broad pass across all subsystems (cycle 3, broad). Prior: Bank Sync (cycle 1), Financial Analytics (cycle 2).
- **Started:** 2026-06-09
- **Findings gathered (broad scan):** H1 (High — getNetWorth dedup direction drops Plaid brokerage value), M1–M6 + ~15 Low. Top-5: H1, M5, M2, M3, M1.
- **Implementation progress (this session):** H1, M5, M2, M3, M1 committed + pushed (commit f871cef); docs synced (92c080c); then Tier-1 follow-up M6, M4, L2 implemented + tested (745 pass, 0 fail).

### Findings implemented this session
- **H1** `getNetWorth` (financial-queries.js): flipped dedup direction — drop the $0 Plaid `linked_accounts` phantom when an active `investment_accounts` row exists; `investment_accounts` is authoritative (matches /api/investments + dashboard grid). Updated the two cycle-fixes.test.js getNetWorth mocks (they routed on a bare `/investment_accounts/` substring that now also matches the linked query's NOT EXISTS subquery — routed on `FROM linked_accounts` instead).
- **M5** budget-snapshot auto-trigger (startup.js): removed the `getDate()===1` gate so a missed prior-month snapshot is caught up on any later tick (idempotent via the existing-snapshot short-circuit). Fixes silent rollover loss on free-tier sleep.
- **M2** categorize AI loop (categorize.js): a swallowed usage-row INSERT no longer lets spend escape the cap — on insert failure we apply the already-paid batch, then stop the loop (`budgetHit=true`).
- **M3** sheets buildDashboard (sheets-sync.js): budget-join category expression now matches the SPENDING BY CATEGORY query (adds `personal_finance_category->>'primary'`), so the budget tab's "Spent" agrees with the breakdown on the same sheet.
- **M1** categorization-rule LIKE (categorize.js, both runCategorize + /apply): escape `\ % _` in user patterns with `REPLACE(...) ESCAPE '\'` so a `%`/`_` in a pattern can't act as a wildcard. exact (`=`) unchanged.

### Tier 1 follow-up implemented (this session, after the H1/M5/M2/M3/M1 batch)
- **M6** shell/index.js: added a `verify` hook to the shell's `express.json` so `req.rawBody` is captured under the unified shell — the embedded Per-sistant webhook receiver now HMAC-verifies the exact signed bytes instead of falling back to re-stringifying `req.body`.
- **M4** scripts/sheets-sync.js: `buildDashboard` now routes the three per-category queries (categorySummary, categoryByMonth, budgetData) through a splits-aware `cat_lines` CTE (parent_no_splits ∪ from_splits) mirroring getCategorySpendingForMonth, so per-category Sheets totals match the app for users who split transactions. Total queries (monthlySummary, totals) + topMerchants intentionally left parent-keyed.
- **L2** teller/routes/subscriptions.js: CSV-import balance auto-update now matches the user's manual account by EXACT institution name OR EXACT account label (was a `name LIKE '%institution%'` substring that could overwrite the wrong account).

### Still deferred (in broad-scan report)
- L1 (Apps Script Code.gs stale fork), L3 (split tolerance 0.011), L4 (detection-key cleanup runs every boot / "one-shot" comment), L5 ($0 CSV skip), L6 (ephemeral SESSION_SECRET, embedded-irrelevant), L7 (syncNotes outside _syncing lock), L8 (empty-doc embed_state), L9 (return_to on requireAuth redirect). Plus Tier-3 effectiveness/completeness items.

### Next concrete step
- Review + deploy (Render auto-deploys on merge to `main`). Then `/sync-docs` to fix CLAUDE.md's getNetWorth Key Design Decision (it documents the OLD/wrong dedup direction). Optionally `/reflect` to record broad-scan metrics + a candidate invariant for the net-worth dedup direction.

### Decisions made this cycle (cycle 2 — Financial Analytics)
- **A1/F1** liability set = `type IN ('credit','loan')` (Plaid's two debt types cover all loan subtypes); return shape of `getNetWorth` unchanged so its 3 snapshot writers + dashboard + context-export need no caller changes.
- **A2/F2** extracted `deriveGoalProgress()` shared by GET /api/goals + context-export to kill the parallel-source-of-truth drift (was an inline duplicate).
- **A4/F4** trend scoped to the latest entry's score_type; added `score_type` to the trend object (additive).

### Decisions made cycle 1 (Bank Sync & Ingestion)

### Decisions made this cycle
- **BS-1** judged advisable despite Teller's default `count` being undocumented:
  the fix is page-size-independent (paginate until empty page / floor), so it is
  correct under any default. Sets `count=500` (documented Teller param) to bound
  round-trips; MAX_PAGES=100 runaway guard.
- **BS-2** Schwab Amount-column sign assumed negative=debit (parity with the
  Chase format + this format's Withdrawal→positive mapping). One-line flip if a
  real Schwab Amount export proves the opposite convention.
- **BS-4** Plaid cursor (INV-04) + xmax counting (INV-01) pinned via
  source-pinned tests rather than live-client behavioral tests
  (`syncPlaidItemTransactions` is not exported; behavioral would need a
  module-surface change out of scope).

### Residual / follow-on
- BS-1 MAX_PAGES break advances the watermark even if a >50k-txn account wasn't
  fully paged (warns to console). Beyond single-operator scale; revisit only if
  the warn ever fires.
- BS-1 depends on Teller accepting `count=500` (documented param; standard
  clamp expected). Watch the first post-deploy Teller sync.

## Where I left off
Cycle 2 (Financial Analytics) A1–A5 implemented on `claude/pensive-davinci-JhKFb`;
tests green at 666. Cycle 1 (Bank Sync, BS-1..BS-8) is in open PR #108. No cycle
work outstanding — next is `/reflect` (promote INV-27, record cycle-2 metrics)
then rotate to Detection & Categorization.

---

## Rotation Plan

1. ~~Bank Sync & Ingestion~~ ✅ audited + fixed (cycle 1)
2. ~~Financial Analytics~~ ✅ audited + fixed (cycle 2)
3. **Detection & Categorization**  ← recommended next
4. AI Insights & Audit
5. Platform, Shell & Auth
6. Settings, Notifications & Cross-app
7. Sheets & External Export
8. Web UI (Perfin)
9. Per-sistant Backend
10. Per-sistant Web UI

- **Seams audit:** every 3 subsystem cycles.
- **Subsystem cycles since last Seams audit:** 0 (Seams & Invariants audit #3, 2026-10-22 — record below; audit #2 June 2026 below it.)

### Seams & Invariants audit #3 (2026-10-22 — counter reset to 0)
Four parallel read-only reviews (cross-app, client↔server, ops, shared truth + mounts), each finding
re-verified. 16 fixed: X1 (High) WebAuthn ids double-encoded at registration — no passkey could ever
match; stored as given + migration repair (INV-136). Medium: C1 manual accounts as a null Plaid item,
S2 seasonal prompt's partial oldest month, X3 display-form SMTP_FROM turning digests into drafts. Low:
S1 reconcile overlap (INV-127), O1–O3 reindex workflow 409 / printed status JSON (INV-103) + reconcile
error text, S3 rename rules after single-Item Plaid syncs, S4 recordSyncResult race (INV-68), S5 tax
year, S6 milestones via deriveGoalProgress (INV-11), X2 today's charge in Knowledge grounding, X6
shutdown flush, C4 source_id, C5 SW caching a redirect, INV-104 standalone compares. Guards widened
(SX3 all copies, literal-CASE scan dirs, timezone lint getFullYear). Tests 1915 (+25), contract 167
(+2). Follow-ons in CLAUDE.md Known Open Issues. Block: `.cycle/blocks/7-seams3-audit.md`.
- **Last subsystem audited:** Sheets & External Export
- **Cycles completed:** rotation complete this session (broad-scan + 8 targeted + 1 seams); reflect recorded (cycle 3, net +4); Health Synthesis still pending.

### Seams & Invariants audit #2 (June 2026, round 8 — counter reset to 0)
Scope: all documented seams + the seams NEW since audit #1 (4 route-file splits,
ask.js cap seam, health.js→notifications/briefing, webauthn transports contract,
critical_alert event, whats-new↔daily-digest, job-health name map). 14 invariants
code-read-verified (INV-02/03/04/06/08/12/14/17/18/21/23/26/27/33/36): ALL PASS.
Route splits: all 4 structurally sound (mounts, no duplicate paths, identity
re-exports resolve, INV-19 ordering, no require cycles). Cross-app contracts:
email-insert columns/status/recipient-chain identical across in-process + HTTP
paths; rag.js perfinPool columns all exist; widget fallback unwraps the real
shape; productivity-context columns exist; cross-pool wiring null-checked.
Findings (all FIXED this session):
- **SEAMS-1 (Medium):** Per-sistant's HTTP webhook receiver didn't recognize
  `critical_alert` (Perfin's EMAIL_EVENTS sends it) — standalone deployments
  200-and-dropped critical alert emails; embedded in-process path unaffected.
  Added to the receiver condition + fallbackSubject + sendNameByEvent.
- **SEAMS-2 (Low, drift):** cash-flow (spending-analytics.js ×4 sites incl. the
  yoy splits-CTE pair) and insights.js anomaly+seasonal (×7 sites) held LITERAL
  copies of the SPLIT_AMOUNT CASE while CLAUDE.md claimed "cannot drift" (seams
  audit #1's SEAM-1 under-counted). All converted to `${SPLIT_AMOUNT}` +
  in-place derivations (new SPLIT_AMOUNT_2 = la2./t2. rewrite). Live-verified:
  cash-flow/yoy/summary 200 against real PG; anomaly+seasonal SQL EXPLAIN-valid.
- **SEAMS-3 (Trivial):** getAiBudgetCents comment named 3 cap sharers; now 4
  (added /api/ask). Settlement FILTER buckets confirmed NOT copies (by design).
New pins: tests/seams-audit.test.js — repo-wide literal-CASE scan (fails on any
future re-inlining) + EMAIL_EVENTS↔receiver symmetry (every sender event must be
accepted + named by the receiver). Tests: 971 across 36 files (+4).

### Health Synthesis — cycle 4 (2026-06-12) — COMPLETE
First synthesis since cycle 3. Axis-A min 7→8, mean 8.1→≈8.5; Axis-B min 7→8,
mean 7.8→≈8.3. No policy flags (nothing ≤6). All five cycle-3 drags moved:
UI/UX 7→9 (PB-3 closed + a11y + e2e smokes), Export 7→8 (F6), Test Quality
7→8 both axes (e2e + live-PG migration CI), Silent Degradation 7→8, plus
Accuracy 8→9 (copy elimination + scan pin), Scheduler 8→9 (GH-Actions cron
guarantees), Cross-app 8→9 (contracts verified + symmetry pin), Drift 8→9.
Recorded in PROJECT_HEALTH.md (tables + cycle-4 notes) + metrics.csv row 4.
No new failure modes; PSB1 deploy-time check transfers to the upcoming merge.
NEXT /reflect: promote INV-37..47 (carry-over) + 2 new candidates (SPLIT_AMOUNT
never-re-inlined scan; EMAIL_EVENTS↔receiver symmetry).
**Where I left off:** seams audit #2 + health synthesis committed on
`claude/exciting-albattani-ug1gjv`. Branch has 6 unmerged commits (FIRE/Ask,
sync-docs, health tracker, animation+webauthn, seams audit, synthesis) —
recommend merging before further feature work.

### /reflect — cycle 4 (2026-06-12) — COMPLETE; branch MERGED (PR #116)
Net +5: 7 production fixes (4 Medium — biometric registration 401, webauthn
transports QR/USB-only, income-summary 500, Render-sleep job misses; 3 Low —
budget-alert spam, transparent floating chrome, notch overlap) − 2 Low new
failure modes (fail-fast passphrase boot [deliberate, escape-hatched]; CI
Playwright CDN dependency [CI-only]). ~17 capabilities, ~15 defensive.
Invariant candidates INV-48..53 recorded in the cycle summary (48 scan-rule,
49 EMAIL_EVENTS symmetry, 50 webauthn transports, 51 read-time streaks,
52 health fail-soft, 53 GH-Actions job backstops); INV-14 amended (+ask).
INV-37..47 (cycle-3 candidates) RETIRED — definitions were never written to
the repo and are unrecoverable; numbers burned, never reuse. Most significant:
live-PG + browser e2e verification posture. Should-have-deferred: mobile/
scaffold. Seams counter stays 0 (this cycle ended WITH the seams audit; no
subsystem audit has run since). Estimates skipped — no estimates.csv and no
recorded per-action estimates this cycle.
**Where I left off:** cycle 4 fully closed (audit→implement→seams→synthesis→
reflect), everything merged to main via PR #116. Next per rotation: fresh
/broad-scan or next targeted subsystem when feature work resumes; promote
INV-48..53 into CLAUDE.md's library at the next docs touch.
