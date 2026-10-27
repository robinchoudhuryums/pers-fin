// ============================================================================
// Teller / Perfin — startup orchestration (extracted from server.js)
// ============================================================================
// Owns the side-effecty bits: migrations, background interval jobs, the
// HTTP listener, keep-alive, and graceful shutdown. Pulled out so
// server.js can be required by the unified shell without immediately
// listening on a port or running migrations.
//
// Two modes:
//   start(app)                   — standalone: listen, keep-alive, signals
//   start(app, { standalone: false }) — embedded: migrations + crons only
//
// In embedded mode the shell is responsible for app.listen(),
// startKeepAlive(), and process-signal handlers.

const { pool, runMigrations } = require("./services/database");
const { TELLER_APP_ID, TELLER_ENV } = require("./services/teller-api");
const { startKeepAlive } = require("./services/keep-alive");
const jobHealth = require("./services/job-health");

const PORT = process.env.PORT || 3000;
const API_KEY = process.env.API_KEY;

// Captured so shutdown (or the shell) can clearInterval them.
const intervalHandles = [];

// All scheduled jobs invoke route logic via exported helpers (in-process)
// rather than HTTP self-fetches. An HTTP fetch to http://localhost:PORT/api/...
// hits the unified shell's auth gate (no shell session cookie on the in-process
// fetch) and 401s — so the auto-trigger silently failed under the deployed shell
// for every cycle. Use the "extract handler → export → reuse" pattern when
// adding new scheduled tasks.

// ---- Idle-gate (Neon compute optimization) ----
// Tracks the last time a real HTTP request arrived. Background jobs check
// isUserActive() and skip their tick when nobody's been active for 15+
// minutes, letting Neon's auto-suspend kick in. Without this, the 10
// intervals fire hourly queries that keep Neon awake 24/7.
let _lastRequestAt = Date.now();
function touchActivity() { _lastRequestAt = Date.now(); }
function isUserActive() {
  return (Date.now() - _lastRequestAt) < 15 * 60 * 1000;
}

// ---- "Away" channels (PSC-3) ----
// The digests, budget alerts and CSV reminder exist for when the user is NOT
// in Perfin, so they must not be activity-gated (they only fired if someone
// had loaded /perfin within 15 minutes of the tick — Per-sistant traffic and
// email-only users never counted). They are gated on their own watermarks
// instead. To keep Neon idle-friendly, a job that has settled for the local
// (APP_TIMEZONE) day skips its DB read for the rest of that day.
const _awaySettled = {};
function localDay() { return require("./services/financial-queries").todayStr(); }
function awaySettledToday(job) { return _awaySettled[job] === localDay(); }
function markAwaySettled(job) { _awaySettled[job] = localDay(); }

// ---- Not-due memo (cycle-8 F29) ----
// bank-auto-sync, the self-healing reconcile and the insights auto-trigger are
// not activity-gated, and each read user_settings on every tick only to find
// itself switched off or not due — waking Neon hourly around the clock. A job
// that found itself off settles for the local day (markAwaySettled); one that
// is merely not due remembers WHEN it will be (setNextDue) and skips its read
// until then. PATCH /api/settings drops both memos when a field that moves the
// due time changes (invalidateJobMemos), so the next tick looks again.
const _nextDueAt = {};
function notDueYet(job) { return _nextDueAt[job] > Date.now(); }
function setNextDue(job, at) { if (Number.isFinite(at)) _nextDueAt[job] = at; }
function invalidateJobMemos(jobs = Object.keys({ ..._nextDueAt, ..._awaySettled })) {
  for (const job of jobs) { delete _nextDueAt[job]; delete _awaySettled[job]; }
}
function localHourNow() {
  const { APP_TIMEZONE } = require("./services/financial-queries");
  try {
    return parseInt(new Intl.DateTimeFormat("en-US", { timeZone: APP_TIMEZONE, hour: "numeric", hourCycle: "h23" }).format(new Date()), 10);
  } catch { return new Date().getUTCHours(); }
}

async function runBudgetAlertTick() {
  jobHealth.tick("budget-alerts");
  try {
    const { getBudgetStatus, currentMonth } = require("./services/financial-queries");
    // ONE budget-status definition (F40, INV-73): getBudgetStatus applies the
    // tz month (FAN-13), the PRIOR month's rollover (FA-1) and the one-time
    // budget rule (F18) — the same numbers as GET /api/budgets and the in-app
    // alerts. This tick used to re-implement all three.
    const budgets = await getBudgetStatus(pool, currentMonth());
    if (budgets.length === 0) { jobHealth.result("budget-alerts", { ok: true }); return; }

    const { sendToAll, sentRecently } = require("./routes/notifications");
    for (const b of budgets) {
      const spent = b.spent;
      const limit = b.effective_limit;
      if (!(limit > 0)) continue;
      // Thresholds on the UNROUNDED share, like GET /api/budgets/alerts —
      // Math.round made 99.5% "Budget exceeded". The shown % is floored so a
      // warning never prints "100%".
      const pct = (spent / limit) * 100;
      const shownPct = Math.floor(pct);
      // At most one alert per category+severity per 24h: without this, a
      // category that stays over budget re-logged a notification_log row on
      // every 3-hour tick for the rest of the month — web-push collapsed the
      // OS notifications via `tag`, but the in-app bell badge/log spammed.
      // Escalation (warn → over) uses a different tag, so it still fires
      // immediately.
      if (pct >= 100) {
        const tag = "budget-over-" + b.category.toLowerCase().replace(/\s+/g, "-");
        if (await sentRecently(tag, 24)) continue;
        const r = await sendToAll({
          title: "Budget exceeded: " + b.category,
          body: "$" + spent.toFixed(2) + " spent of $" + limit.toFixed(2) + " budget (" + shownPct + "%)",
          tag,
          data: { url: "/budgets" },
        });
        // Opt-in critical-alert email — shares the 24h sentRecently dedup
        // above. Only email when the dedup marker (notification_log row) actually
        // persisted: if it didn't, sentRecently can't see it and the next tick
        // would re-email, so skip rather than risk daily-cap-breaking spam (F24).
        if (r && r.logged) {
          try {
            const { sendCriticalAlertEmail } = require("./routes/persistent");
            await sendCriticalAlertEmail(
              "Budget exceeded: " + b.category,
              "$" + spent.toFixed(2) + " spent of $" + limit.toFixed(2) + " budget (" + shownPct + "%) this month."
            );
          } catch (e) { console.error("Budget alert email error:", e.message); }
        } else {
          console.error("Budget alert: dedup marker not persisted for", tag, "— skipping email to avoid re-send spam.");
        }
      } else if (pct >= 80) {
        const tag = "budget-warn-" + b.category.toLowerCase().replace(/\s+/g, "-");
        if (await sentRecently(tag, 24)) continue;
        await sendToAll({
          title: "Budget warning: " + b.category,
          body: "$" + spent.toFixed(2) + " of $" + limit.toFixed(2) + " (" + shownPct + "% — approaching limit)",
          tag,
          data: { url: "/budgets" },
        });
      }
    }
    jobHealth.result("budget-alerts", { ok: true });
  } catch (err) {
    console.error("Budget alert notification error:", err.message);
    jobHealth.result("budget-alerts", { ok: false, error: err.message });
  }
}

// deliverDigestInProcess saved the email as a draft (no or invalid recipient,
// cycle-7 F79).
const DRAFT_ONLY_REASONS = ["no_recipient_configured", "invalid_recipient"];

async function runWeeklyDigestTick() {
  jobHealth.tick("weekly-digest");
  if (awaySettledToday("weekly-digest")) return;
  try {
    const settings = await pool.query(
      "SELECT weekly_digest_enabled, weekly_digest_day FROM user_settings WHERE id = 1"
    );
    const s = settings.rows[0];
    if (!s || !s.weekly_digest_enabled) { markAwaySettled("weekly-digest"); return; }
    // 0=Sun, 1=Mon, etc. Default 1 (Monday). The weekday is the LOCAL
    // (APP_TIMEZONE) day, not the server's UTC day (AIN-15).
    const localWeekday = new Date(localDay() + "T00:00:00Z").getUTCDay();
    if (localWeekday !== (s.weekly_digest_day ?? 1)) { markAwaySettled("weekly-digest"); return; }
    const { runWeeklyDigest } = require("./routes/insights");
    const result = await runWeeklyDigest();
    const settled = result.sent || ["already_sent_this_week", "disabled", "no_summary", "empty_summary"].includes(result.reason);
    // Saved as a draft for want of a valid recipient (F79): a failure for Sync
    // Health, but done for the day — retrying hourly would only add drafts.
    if (settled || DRAFT_ONLY_REASONS.includes(result.reason)) markAwaySettled("weekly-digest");
    jobHealth.result("weekly-digest", settled ? { ok: true } : { ok: false, error: result.reason || result.error });
    if (result.sent) console.log("Weekly digest sent.");
    else if (result.reason && result.reason !== "already_sent_this_week" && result.reason !== "disabled") {
      console.log("Weekly digest skipped:", result.reason);
    }
  } catch (err) {
    console.error("Weekly digest scheduler error:", err.message);
    jobHealth.result("weekly-digest", { ok: false, error: err.message });
  }
}

async function runDailyDigestTick() {
  jobHealth.tick("daily-digest");
  if (awaySettledToday("daily-digest")) return;
  try {
    const { runDailyDigest, DAILY_DIGEST_HOUR } = require("./routes/insights");
    if (localHourNow() < DAILY_DIGEST_HOUR) return;
    const result = await runDailyDigest();
    const settled = result.sent || ["already_sent_today", "disabled", "nothing_new"].includes(result.reason);
    if (settled || DRAFT_ONLY_REASONS.includes(result.reason)) markAwaySettled("daily-digest");
    // too_early (an APP_TIMEZONE hour edge) is a skip, not a failure.
    if (settled || result.reason === "too_early") jobHealth.result("daily-digest", { ok: true });
    else jobHealth.result("daily-digest", { ok: false, error: result.reason || result.error });
    if (result.sent) console.log("Daily digest sent.");
    else if (result.reason && result.reason !== "already_sent_today" && result.reason !== "disabled" && result.reason !== "nothing_new") {
      console.log("Daily digest skipped:", result.reason);
    }
  } catch (err) {
    console.error("Daily digest scheduler error:", err.message);
    jobHealth.result("daily-digest", { ok: false, error: err.message });
  }
}

async function runCsvReminderTick() {
  jobHealth.tick("csv-reminder");
  if (awaySettledToday("csv-reminder")) return;
  try {
    const settings = await pool.query(
      "SELECT csv_reminder_enabled, csv_reminder_days, last_csv_reminder_at FROM user_settings WHERE id = 1"
    );
    const s = settings.rows[0];
    if (!s || !s.csv_reminder_enabled) { markAwaySettled("csv-reminder"); return; }
    if (s.last_csv_reminder_at && Date.now() - new Date(s.last_csv_reminder_at).getTime() < 24 * 60 * 60 * 1000) {
      markAwaySettled("csv-reminder");
      return;
    }
    const days = parseInt(s.csv_reminder_days) || 14;
    // Match the LATERAL JOIN logic in GET /api/csv-reminder so the push
    // notification reflects the same stale-account list the UI shows. The
    // previous join used a single COALESCE(institution_name_manual, name)
    // path and missed accounts where csv_imports.account_label matches.
    const staleAccounts = await pool.query(`
      SELECT la.name, la.institution_name_manual AS institution, ci.imported_at AS last_import
      FROM linked_accounts la
      LEFT JOIN LATERAL (
        SELECT imported_at FROM csv_imports
        WHERE LOWER(institution) = LOWER(COALESCE(la.institution_name_manual, ''))
           OR LOWER(account_label) = LOWER(la.name)
        ORDER BY imported_at DESC LIMIT 1
      ) ci ON true
      WHERE la.is_manual = true
        AND (ci.imported_at IS NULL OR ci.imported_at < now() - make_interval(days => $1))
    `, [days]);
    if (staleAccounts.rows.length > 0) {
      const { sendToAll } = require("./routes/notifications");
      const names = staleAccounts.rows.map(r => r.institution || r.name).join(", ");
      await sendToAll({
        title: "CSV import reminder",
        body: `${staleAccounts.rows.length} account(s) need a fresh CSV upload: ${names}`,
        tag: "csv-reminder",
        data: { url: "/" },
      });
    }
    // Stamp the evaluation (sent or nothing stale) so the next check is ≥24h out.
    await pool.query("UPDATE user_settings SET last_csv_reminder_at = now() WHERE id = 1");
    markAwaySettled("csv-reminder");
    jobHealth.result("csv-reminder", { ok: true });
  } catch (err) {
    console.error("CSV reminder scheduler error:", err.message);
    jobHealth.result("csv-reminder", { ok: false, error: err.message });
  }
}

// Low projected cash alert (roadmap T2.2 L2). NOT activity-gated (INV-77): it
// exists for when the user is away. runCashAlerts gates itself — off by default
// (and then no DB read for the rest of the local day), evaluated only when new
// bank data arrived since the last check or on a new local day, never on
// balances older than 36 h, deduped through cash_alert_state. An outcome is
// recorded only when it evaluated; "unchanged" / "disabled" record nothing.
// The same job runs the "Payday missed?" check (roadmap T2.2 L3 —
// services/payday-alerts.js), gated the same way; each check is isolated so one
// failing doesn't skip the other.
async function runCashAlertsTick() {
  jobHealth.tick("cash-alerts");
  let ran = false;
  const errors = [];
  const checks = [
    ["cash alert", () => require("./services/cash-alerts").runCashAlerts(pool)],
    ["payday alert", () => require("./services/payday-alerts").runPaydayMissed(pool)],
  ];
  for (const [name, fn] of checks) {
    try {
      const r = await fn();
      if (r.ran) ran = true;
      if (r.status === "unlogged") errors.push(name + ": notification not logged");
    } catch (err) {
      console.error("Cash alert scheduler error (" + name + "):", err.message);
      ran = true;
      errors.push(name + ": " + err.message);
    }
  }
  if (errors.length) jobHealth.result("cash-alerts", { ok: false, error: errors.join("; ") });
  else if (ran) jobHealth.result("cash-alerts", { ok: true });
}

// Linked tasks (roadmap T2.4 X2b — services/linked-tasks.js): reconcile the
// Per-sistant tasks Perfin keeps in step (rent due, utility amounts, manual
// bills). An away channel (INV-77): NOT activity-gated, ticks hourly; while
// the switch is off the runner reads its settings once a local day (a Settings
// change invalidates it), after a clean run it does nothing until the next
// local day (writes kick their own refresh — cycle-8 F21), and with no
// Per-sistant pool wired (a standalone Perfin) it does nothing at all. An
// outcome is recorded only when it ran.
async function runLinkedTasksTick() {
  jobHealth.tick("linked-tasks");
  try {
    const r = await require("./services/linked-tasks").runLinkedTasks(pool, undefined, { scheduled: true });
    if (r.status === "partial") jobHealth.result("linked-tasks", { ok: false, error: (r.errors || []).map((e) => (e.kind ? e.kind + ": " : "") + e.error).join("; ") });
    else if (r.ran) jobHealth.result("linked-tasks", { ok: true });
  } catch (err) {
    console.error("Linked tasks scheduler error:", err.message);
    jobHealth.result("linked-tasks", { ok: false, error: err.message });
  }
}

// Rent & Utilities ledger (cycle-7 F15): generate the current/missing months'
// obligations from housing_config (idempotent), then fire the two reminders —
// payment-due and missing-utility-amount — each deduped via sentRecently inside
// runHousingReminders. An "away" channel like the digests (INV-77): a reminder
// that rent is due must reach a user who isn't in Perfin, so it is NOT
// activity-gated; once a local day's pass succeeds it skips its DB reads until
// the next day. No-op when the ledger isn't configured. In-process helpers,
// never an HTTP self-fetch (INV-18).
async function runHousingLedgerTick() {
  jobHealth.tick("housing-ledger");
  if (awaySettledToday("housing-ledger")) return;
  try {
    const housing = require("./routes/housing");
    const gen = await housing.generateHousingObligations();
    // New obligations can open a linked task — the hourly linked-task tick
    // runs once a day (cycle-8 F21), so tell it.
    if (gen && gen.generated > 0) require("./services/linked-tasks").kick("housing-generate");
    await housing.runHousingReminders();
    markAwaySettled("housing-ledger");
    jobHealth.result("housing-ledger", { ok: true });
  } catch (err) {
    console.error("Housing ledger task error:", err.message);
    jobHealth.result("housing-ledger", { ok: false, error: err.message });
  }
}

// AI insights auto-trigger (every 6 hours, respects insights_cadence_days).
// Pre-syncs transactions + balances + detection so AI sees fresh data.
// Cycle-7 F63: a run that couldn't produce an insight (cap reached, empty
// answer, DB error) left insights_last_run untouched, so EVERY 6-hour tick
// re-ran the whole Teller + Plaid sync chain and the paid call. Now (1) the
// shared monthly AI cap is checked BEFORE the chain — over the cap there is
// nothing to do until next month, and (2) every attempt is stamped in
// insights_last_attempt_at and a failed attempt is retried at most once per
// INSIGHTS_RETRY_MS. A manual POST /api/insights is never held back by this.
const INSIGHTS_RETRY_MS = 24 * 60 * 60 * 1000;

async function runInsightsAutoTriggerTick() {
  jobHealth.tick("insights-auto-trigger");
  try {
    if (!process.env.ANTHROPIC_API_KEY) return;
    // Off for the day, or not due yet: no settings read (cycle-8 F29).
    if (awaySettledToday("insights-auto-trigger") || notDueYet("insights-auto-trigger")) return;
    const settings = await pool.query(
      "SELECT insights_enabled, insights_cadence_days, insights_last_run, insights_last_attempt_at FROM user_settings WHERE id = 1"
    );
    const s = settings.rows[0];
    if (!s || !s.insights_enabled) { markAwaySettled("insights-auto-trigger"); return; }
    const cadenceDays = s.insights_cadence_days || 30;
    const lastRun = s.insights_last_run ? new Date(s.insights_last_run) : null;
    const now = new Date();
    if (lastRun && (now - lastRun) / 86400000 < cadenceDays) {
      setNextDue("insights-auto-trigger", lastRun.getTime() + cadenceDays * 86400000);
      return;
    }
    const lastAttempt = s.insights_last_attempt_at ? new Date(s.insights_last_attempt_at) : null;
    if (lastAttempt && (!lastRun || lastAttempt > lastRun) && (now - lastAttempt) < INSIGHTS_RETRY_MS) {
      setNextDue("insights-auto-trigger", lastAttempt.getTime() + INSIGHTS_RETRY_MS);
      return;
    }

    const { generateInsights, getAiBudgetCents, monthAiSpendCents } = require("./routes/insights");
    if (await monthAiSpendCents() >= await getAiBudgetCents()) {
      // Not a failure: the cap is the user's setting. Nothing runs until the
      // month turns or the cap is raised — the check itself is one query.
      jobHealth.result("insights-auto-trigger", { ok: true });
      return;
    }
    await pool.query("UPDATE user_settings SET insights_last_attempt_at = now() WHERE id = 1");

    const { syncAllTransactions, syncAllBalances } = require("./routes/enrollments");
    const { runSubscriptionDetection } = require("./routes/subscriptions");
    const { syncAllPlaidHoldings, syncAllPlaidInvestmentFlows } = require("./routes/investments");
    const { detectRecurringTransfers } = require("../scripts/detect-transfers");
    const { runCategorize } = require("./routes/categorize");

    // Teller + Plaid + ONE anomaly check over the combined count (DD-1). Each
    // step is isolated; the first failure is what the job outcome reports.
    const stepErrors = [];
    const step = async (label, fn) => {
      try { return await fn(); }
      catch (e) { console.error(label + " error:", e.message); stepErrors.push(label + ": " + e.message); return null; }
    };
    await step("Pre-insights sync", () => syncAllTransactions());
    await step("Pre-insights holdings sync", () => syncAllPlaidHoldings());
    await step("Pre-insights investment-flows", () => syncAllPlaidInvestmentFlows());
    await step("Pre-insights balance", () => syncAllBalances());
    await step("Pre-insights detect", () => runSubscriptionDetection());
    await step("Pre-insights detect-transfers", () => detectRecurringTransfers(pool));
    // Categorize BEFORE generating insights so the AI sees freshly
    // categorized rows (matches the documented chain in CLAUDE.md).
    const cat = await step("Pre-insights categorize", () => runCategorize());
    if (cat && !cat.ok) console.log("Auto-trigger categorize skipped:", cat.error);
    const ins = await step("Auto-trigger insights", () => generateInsights());
    if (ins && ins.ok) console.log("Auto-triggered AI insights (cadence: " + cadenceDays + " days).");
    else if (ins) console.log("Auto-trigger insights skipped:", ins.error);
    const failure = ins && !ins.ok ? "insights: " + ins.error : stepErrors[0];
    jobHealth.result("insights-auto-trigger", failure ? { ok: false, error: failure } : { ok: true });
  } catch (err) {
    console.error("Insights auto-trigger error:", err.message);
    jobHealth.result("insights-auto-trigger", { ok: false, error: err.message });
  }
}

// Bank auto-sync (every hour, throttled by the user's auto_sync_interval_hours).
// Not activity-gated. Off → settled for the local day; not due → no settings
// read until it is (cycle-8 F29). A Settings change drops both memos.
async function runBankAutoSyncTick() {
  jobHealth.tick("bank-auto-sync");
  if (awaySettledToday("bank-auto-sync") || notDueYet("bank-auto-sync")) return;
  try {
    const settings = await pool.query(
      // sync_notifications_enabled MUST be selected — the toggle checks below
      // read it, and without it they were always "on" (PSC-1).
      "SELECT auto_sync_enabled, auto_sync_interval_hours, last_auto_sync_at, last_sync_result, sync_notifications_enabled FROM user_settings WHERE id = 1"
    );
    const s = settings.rows[0];
    if (!s || !s.auto_sync_enabled) { markAwaySettled("bank-auto-sync"); return; }
    const intervalHours = Math.max(1, Math.min(168, parseInt(s.auto_sync_interval_hours) || 6));
    const lastSync = s.last_auto_sync_at ? new Date(s.last_auto_sync_at) : null;
    const now = new Date();
    const dueMs = intervalHours * 60 * 60 * 1000;
    if (lastSync && (now - lastSync) < dueMs) { setNextDue("bank-auto-sync", lastSync.getTime() + dueMs); return; }

    const { syncAllTransactions, syncAllBalances, recordSyncResult, thrownSyncResult } = require("./routes/enrollments");
    const { syncAllPlaidHoldings, syncAllPlaidInvestmentFlows } = require("./routes/investments");
    let txnResult = null, balResult = null, plaidResult = null, holdingsResult = null, flowsResult = null;
    // A step that THROWS is recorded as an error for its provider (cycle-7
    // F23) — it used to be recorded as nothing, keeping a stale clean entry.
    const threw = {};
    // Teller + Plaid via the shared entry point so the anomaly check runs
    // ONCE over the combined added count — Plaid charges get anomaly alerts
    // too (DD-1). Each provider is failure-isolated inside it.
    try {
      const all = await syncAllTransactions();
      txnResult = all.teller;
      plaidResult = all.plaid;
    } catch (e) { console.error("Auto-sync transaction error:", e.message); threw.teller_txn = e; }
    try { holdingsResult = await syncAllPlaidHoldings(); }
    catch (e) { console.error("Auto-sync holdings error:", e.message); threw.plaid_holdings = e; }
    // External cash flows for TWR/XIRR — full-window idempotent re-pull,
    // cheap (≤1 page for a personal account) and failure-isolated.
    try { flowsResult = await syncAllPlaidInvestmentFlows(); }
    catch (e) { console.error("Auto-sync investment-flows error:", e.message); threw.plaid_flows = e; }
    try { balResult = await syncAllBalances(); }
    catch (e) { console.error("Auto-sync balances error:", e.message); threw.teller_balance = e; }

    // Auto-categorize freshly-synced transactions so the user doesn't have
    // to click "Categorize" after every sync. runCategorize sweeps the FULL
    // backlog through the free rule + Teller-map paths and sends a bounded
    // batch to AI (budget-capped) — so this is cheap and keeps the
    // uncategorized count from piling up. Runs on the user's chosen auto-sync
    // cadence, giving the daily categorization sweep.
    try {
      const { runCategorize } = require("./routes/categorize");
      const catRes = await runCategorize();
      if (catRes && catRes.ok) {
        console.log(`Auto-sync categorize: ${catRes.categorized || 0} categorized, ${catRes.remaining ?? "?"} remaining.`);
      } else if (catRes && catRes.error) {
        console.log("Auto-sync categorize skipped:", catRes.error);
      }
    } catch (e) { console.error("Auto-sync categorize error:", e.message); }

    await pool.query("UPDATE user_settings SET last_auto_sync_at = now() WHERE id = 1")
      .catch(e => console.error("Auto-sync timestamp update failed:", e.message));
    setNextDue("bank-auto-sync", Date.now() + dueMs);

    // Persist a structured sync-result so per-item errors (decryption_failed,
    // per-institution failures) surface in the Sync Health card even on a
    // scheduled run nobody is watching (addition D). The auto-sync covers all
    // providers, so its record is the comprehensive one.
    const orThrew = (provider, result) => threw[provider] ? thrownSyncResult(threw[provider]) : result;
    const syncRecord = await recordSyncResult([
      { provider: "teller_txn", result: orThrew("teller_txn", txnResult) },
      { provider: "plaid_txn", result: plaidResult },
      { provider: "plaid_holdings", result: orThrew("plaid_holdings", holdingsResult) },
      // Investment-flow errors were never recorded (DD-10); "Plaid not
      // configured" is skipped inside recordSyncResult.
      { provider: "plaid_flows", result: orThrew("plaid_flows", flowsResult) },
      { provider: "teller_balance", result: orThrew("teller_balance", balResult) },
    ]);
    // Notify ONLY when the error set changes (new errors appeared) so a
    // persistent passphrase mismatch doesn't spam a notification every hour.
    const errSig = (errs) => (errs || []).map(e => `${e.provider}:${e.institution || ""}:${e.error}`).sort().join("|");
    const prevErrSig = errSig(s.last_sync_result && s.last_sync_result.errors);
    const newErrSig = errSig(syncRecord.errors);
    if (syncRecord.errors.length > 0 && newErrSig !== prevErrSig && s.sync_notifications_enabled !== false) {
      try {
        const { sendToAll } = require("./routes/notifications");
        const summary = syncRecord.errors.slice(0, 4)
          .map(e => `${e.institution || e.provider}: ${e.error}`).join("; ");
        await sendToAll({
          title: "Sync error",
          body: `${syncRecord.errors.length} sync error(s) — ${summary}. See Settings → Sync Health.`,
          tag: "sync-error",
          data: { url: "/settings" },
        });
      } catch (e) { console.error("Sync error notification failed:", e.message); }
    }
    const tellerTxns = txnResult ? txnResult.transactions_added : 0;
    const plaidTxns = plaidResult && plaidResult.ok ? plaidResult.transactions_added : 0;
    const syncMsg = `${tellerTxns + plaidTxns} txns (${tellerTxns} Teller, ${plaidTxns} Plaid)` +
      ", " + (balResult ? `${balResult.accounts_updated} balances` : "balance sync failed");
    console.log("Auto-sync complete: " + syncMsg);
    const txnsAdded = tellerTxns + plaidTxns;
    // A balance that was re-fetched but didn't move is not news (PSC-1):
    // accounts_changed, not accounts_updated, gates the notification.
    const balancesChanged = balResult ? (balResult.accounts_changed || 0) : 0;
    const anyFailed = !txnResult || txnResult.failed === true || !balResult;
    const anyChanged = txnsAdded > 0 || balancesChanged > 0;
    jobHealth.result("bank-auto-sync", anyFailed
      ? { ok: false, error: !txnResult || txnResult.failed === true ? "transaction sync failed" : "balance sync failed" }
      : { ok: true });
    if (s.sync_notifications_enabled !== false && (anyChanged || anyFailed)) {
      try {
        const { sendToAll } = require("./routes/notifications");
        await sendToAll({
          title: anyFailed ? "Auto-sync issue" : "Auto-sync complete",
          body: syncMsg,
          tag: "auto-sync",
          data: { url: "/dashboard" },
        });
      } catch (e) { console.error("Auto-sync notification failed:", e.message); }
    }
  } catch (err) {
    console.error("Auto-sync scheduler error:", err.message);
    jobHealth.result("bank-auto-sync", { ok: false, error: err.message });
  }
}

// Self-healing reconcile (every hour, acts at most weekly). Re-fetches the
// trailing 90 days from every Teller enrollment regardless of the incremental
// watermark, so any transactions a prior sync dropped (same-day late arrivals,
// a failed-sibling-account skip) are recovered via idempotent upserts. Teller
// only — it's free and cheap; Plaid reconcile is heavier (full cursor re-walk)
// and stays a manual POST /api/sync/reconcile action. Not gated on user
// activity: a weekly background heal should run even while the user is away.
async function runSelfHealingReconcileTick() {
  jobHealth.tick("self-healing-reconcile");
  // Not due → no read until it is (cycle-8 F29). A manual reconcile in the
  // meantime only moves the real due time later, so the memo can't run early.
  if (notDueYet("self-healing-reconcile")) return;
  const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
  try {
    const r = await pool.query("SELECT last_reconcile_at FROM user_settings WHERE id = 1");
    const last = r.rows[0]?.last_reconcile_at ? new Date(r.rows[0].last_reconcile_at) : null;
    if (last && (Date.now() - last.getTime()) < WEEK_MS) { setNextDue("self-healing-reconcile", last.getTime() + WEEK_MS); return; }
    const { reconcileTeller, reconcileBusy, withReconcileGuard } = require("./routes/enrollments");
    // A reconcile already running (e.g. weekly-reconcile.yml's background
    // one) covers this week; retry on the next tick (seams audit #3).
    if (reconcileBusy()) return;
    const result = await withReconcileGuard(() => reconcileTeller(90));
    await pool.query("UPDATE user_settings SET last_reconcile_at = now() WHERE id = 1")
      .catch(e => console.error("last_reconcile_at update failed:", e.message));
    setNextDue("self-healing-reconcile", Date.now() + WEEK_MS);
    // Record the outcome so a failing weekly heal is visible (BSI-11).
    const { recordSyncResult } = require("./routes/enrollments");
    await recordSyncResult([{ provider: "teller_reconcile", result }]);
    console.log("Self-healing Teller reconcile complete:", JSON.stringify(result));
    const reconcileErrors = result && Array.isArray(result.errors) ? result.errors.length : 0;
    jobHealth.result("self-healing-reconcile", reconcileErrors
      ? { ok: false, error: `${reconcileErrors} enrollment error(s)` }
      : { ok: true });
  } catch (err) {
    console.error("Self-healing reconcile error:", err.message);
    jobHealth.result("self-healing-reconcile", { ok: false, error: err.message });
    // A thrown reconcile used to leave no trace in last_sync_result (F23).
    try {
      const { recordSyncResult, thrownSyncResult } = require("./routes/enrollments");
      await recordSyncResult([{ provider: "teller_reconcile", result: thrownSyncResult(err) }]);
    } catch (e) { console.error("Could not record the reconcile failure:", e.message); }
  }
}

function startBackgroundJobs() {
  // Sheets auto-sync check (every hour). Gated: skips when no user has
  // been active for 15+ minutes so Neon can auto-suspend.
  const runSheetsAutoSyncTick = async () => {
    jobHealth.tick("sheets-auto-sync");
    if (!isUserActive()) return;
    try {
      const settings = await pool.query("SELECT sheets_auto_sync_enabled, sheets_auto_sync_interval, sheets_last_auto_sync FROM user_settings WHERE id = 1");
      const s = settings.rows[0];
      if (!s || !s.sheets_auto_sync_enabled) return;
      const intervals = { daily: 1, weekly: 7, monthly: 30 };
      const intervalDays = intervals[s.sheets_auto_sync_interval] || 7;
      const lastSync = s.sheets_last_auto_sync ? new Date(s.sheets_last_auto_sync) : null;
      const now = new Date();
      if (!lastSync || (now - lastSync) / 86400000 >= intervalDays) {
        let sheetsSync;
        try { sheetsSync = require("../scripts/sheets-sync"); } catch { return; }
        if (!process.env.GOOGLE_SHEETS_ID || !process.env.GOOGLE_SERVICE_ACCOUNT_KEY) return;
        // SXE-1: record the outcome (persisted + one notification when the set
        // of failing tabs changes) instead of dropping errors[]. A wholesale
        // throw is recorded too; the attempt is stamped either way so a broken
        // spreadsheet isn't retried (~100 API calls) every hour.
        const { recordSheetsSyncResult } = require("./routes/settings");
        let result;
        try {
          result = await sheetsSync.syncAll();
        } catch (e) {
          result = { errors: [{ step: "sync", error: e.message }] };
        }
        const record = await recordSheetsSyncResult(result);
        await pool.query("UPDATE user_settings SET sheets_last_auto_sync = now() WHERE id = 1");
        console.log(record.ok ? "Auto-sync to Google Sheets complete." : `Auto-sync to Google Sheets: ${record.tabs_failed} tab(s) failed.`);
        jobHealth.result("sheets-auto-sync", record.ok ? { ok: true } : { ok: false, error: `${record.tabs_failed} tab(s) failed` });
      }
    } catch (err) {
      console.error("Sheets auto-sync error:", err.message);
      jobHealth.result("sheets-auto-sync", { ok: false, error: err.message });
    }
  };
  intervalHandles.push(setInterval(runSheetsAutoSyncTick, 60 * 60 * 1000));

  // Hourly net worth auto-snapshot. Gated: skips when no user is active
  // so Neon can auto-suspend. The INSERT uses ON CONFLICT (snapshot_date)
  // DO UPDATE so a same-day re-run rewrites the row with the latest
  // balances.
  const runNetWorthSnapshotTick = async () => {
    jobHealth.tick("net-worth-snapshot");
    if (!isUserActive()) return;
    try {
      // Single source of truth (F1): getNetWorth dedupes Plaid investment
      // accounts present in both linked_accounts and investment_accounts and
      // always includes investments, so this hourly snapshot, the balance-sync
      // snapshot, and POST /api/net-worth/snapshot all agree.
      const { getNetWorth } = require("./services/financial-queries");
      const nw = await getNetWorth(pool);
      if (nw.breakdown.accounts.length === 0 && nw.breakdown.investments.length === 0) return;
      await pool.query(
        `INSERT INTO net_worth_snapshots (total_assets, total_liabilities, net_worth, breakdown, snapshot_date)
         VALUES ($1, $2, $3, $4, CURRENT_DATE)
         ON CONFLICT (snapshot_date) DO UPDATE SET
           total_assets = EXCLUDED.total_assets,
           total_liabilities = EXCLUDED.total_liabilities,
           net_worth = EXCLUDED.net_worth,
           breakdown = EXCLUDED.breakdown`,
        [nw.total_assets, nw.total_liabilities, nw.net_worth, JSON.stringify(nw.breakdown)]
      );
      console.log("Daily net worth snapshot recorded: $" + nw.net_worth.toFixed(2));
      jobHealth.result("net-worth-snapshot", { ok: true });
    } catch (err) {
      console.error("Net worth auto-snapshot error:", err.message);
      jobHealth.result("net-worth-snapshot", { ok: false, error: err.message });
    }
  };
  intervalHandles.push(setInterval(runNetWorthSnapshotTick, 60 * 60 * 1000));

  // Goal milestone notifications (every 6 hours). Gated on user activity.
  const runGoalMilestonesTick = async () => {
    jobHealth.tick("goal-milestones");
    if (!isUserActive()) return;
    try {
      // Progress through the shared deriveGoalProgress (INV-11) — the Goals
      // page, the insights prompt and the context export use it. This job
      // used to re-derive it in SQL and read a funding account with no
      // balance as $0 progress instead of falling back to the stored value
      // (seams audit #3).
      const { deriveGoalProgress } = require("./routes/goals");
      const goals = await pool.query(
        `SELECT g.id, g.name, g.target_amount, g.notes, g.current_amount,
                g.funding_account_id, g.funding_investment_id, g.goal_baseline_amount,
                COALESCE(la.available_balance, la.current_balance) AS funding_account_balance,
                la.name AS funding_account_name,
                ia.balance AS funding_investment_balance,
                ia.name AS funding_investment_name
         FROM financial_goals g
         LEFT JOIN linked_accounts     la ON la.id = g.funding_account_id
         LEFT JOIN investment_accounts ia ON ia.id = g.funding_investment_id
         WHERE g.is_active = true`
      );
      const MILESTONES = [25, 50, 75, 100];
      for (const g of goals.rows) {
        const target = parseFloat(g.target_amount);
        if (target <= 0) continue;
        const pct = Math.floor((deriveGoalProgress(g).current / target) * 100);
        // Notes come from the main SELECT (no per-goal re-query) and are
        // tracked locally so multiple milestones crossed in one pass append
        // correctly before the single UPDATE per milestone.
        let notes = g.notes || "";
        for (const m of MILESTONES) {
          if (pct >= m) {
            const key = `milestone_${m}`;
            if (notes.includes(key)) continue;
            try {
              const { sendToAll } = require("./routes/notifications");
              await sendToAll({
                title: pct >= 100 ? "Goal reached!" : "Goal milestone: " + m + "%",
                body: g.name + ": " + pct + "% complete" + (pct >= 100 ? " — congratulations!" : ""),
                tag: "goal-" + g.id,
                data: { url: "/goals" },
              });
            } catch (e) { console.error("Goal milestone notification error:", e.message); }
            notes = (notes ? notes + " " : "") + key;
            await pool.query("UPDATE financial_goals SET notes = $1 WHERE id = $2", [notes, g.id]);
          }
        }
      }
      jobHealth.result("goal-milestones", { ok: true });
    } catch (err) {
      console.error("Goal milestone check error:", err.message);
      jobHealth.result("goal-milestones", { ok: false, error: err.message });
    }
  };
  intervalHandles.push(setInterval(runGoalMilestonesTick, 6 * 60 * 60 * 1000));

  // Auto-trigger AI insights based on cadence (every 6 hours).
  // Pre-syncs transactions + balances + detection so AI sees fresh data.
  intervalHandles.push(setInterval(() => runInsightsAutoTriggerTick(), 6 * 60 * 60 * 1000));

  // Budget alert push notifications (every 3 hours). NOT activity-gated
  // (PSC-3): the push + opt-in critical-alert email are "away" channels;
  // repeats are bounded by the per-category+severity 24h sentRecently dedup.
  intervalHandles.push(setInterval(() => runBudgetAlertTick(), 3 * 60 * 60 * 1000));

  // Rent & Utilities ledger (every 6 hours) — an away channel, see
  // runHousingLedgerTick (cycle-7 F15: it used to be activity-gated).
  intervalHandles.push(setInterval(() => runHousingLedgerTick(), 6 * 60 * 60 * 1000));

  // Budget snapshot auto-trigger (every 6 hours). Snapshots the PRIOR (now-
  // complete) month's spending + rollover so rollover-enabled budgets advance.
  // M5: this used to only act when today.getDate()===1, which — combined with
  // the user-activity gate and Render free-tier sleep — meant a snapshot could
  // be permanently missed if nobody woke the process on the 1st, and from the
  // 2nd onward the date gate never let it catch up, so rollover silently never
  // applied that month. Now it runs on EVERY tick (runBudgetSnapshot in
  // routes/budgets.js): during days 1-5 it RE-takes the prior month's snapshot
  // so charges that post a few days late are included (FAN-7 — "the prior month
  // is complete regardless of which day we run" didn't hold for bank posting
  // lag); after that it only creates a missing snapshot (catch-up) and
  // otherwise no-ops. Still gated on user activity.
  const runBudgetSnapshotTick = async () => {
    jobHealth.tick("budget-snapshot");
    if (!isUserActive()) return;
    try {
      // Refreshes the prior month during days 1-5 (late-posting charges, FAN-7),
      // creates it if missing afterwards (M5 catch-up); tz-anchored (FAN-13).
      const { runBudgetSnapshot } = require("./routes/budgets");
      const r = await runBudgetSnapshot(pool);
      jobHealth.result("budget-snapshot", { ok: true });
      if (r.mode === "exists") return;
      const prevMonth = r.month + " (" + r.mode + ", " + r.written + " row(s))";
      console.log("Auto budget snapshot for", prevMonth);
    } catch (err) {
      console.error("Budget snapshot auto-trigger error:", err.message);
      jobHealth.result("budget-snapshot", { ok: false, error: err.message });
    }
  };
  intervalHandles.push(setInterval(runBudgetSnapshotTick, 6 * 60 * 60 * 1000));

  // Bank auto-sync (every hour, throttled by user setting) — runBankAutoSyncTick.
  intervalHandles.push(setInterval(() => runBankAutoSyncTick(), 60 * 60 * 1000));

  // Self-healing reconcile (every hour, acts at most weekly) — runSelfHealingReconcileTick.
  intervalHandles.push(setInterval(() => runSelfHealingReconcileTick(), 60 * 60 * 1000));

  // Weekly digest email. NOT activity-gated (PSC-3) — it exists for when the
  // user is away. Fires on the configured weekly_digest_day when
  // weekly_digest_enabled is true; the 6-day last_weekly_digest_at watermark
  // inside runWeeklyDigest is the dedup. Once the day's outcome is settled
  // (sent / already sent / disabled / not the day / nothing to send) the job
  // skips its DB read until the next local day. A failed send stays unsettled
  // and retries on the next hourly tick.
  intervalHandles.push(setInterval(() => runWeeklyDigestTick(), 60 * 60 * 1000));

  // Daily digest email (#19). NOT activity-gated (PSC-3); runDailyDigest's own
  // last_daily_digest_at watermark (once per local date, ≥ 07:00 local, covers
  // everything since the previous send) is the gate. Before the send hour the
  // tick skips without touching the DB; once the day is settled it skips too.
  intervalHandles.push(setInterval(() => runDailyDigestTick(), 60 * 60 * 1000));

  // CSV import reminder. Hourly tick, NOT activity-gated (PSC-3): the old
  // 24-hour setInterval needed 24h of continuous uptime AND activity at that
  // exact tick, so under free-tier sleep/deploys it essentially never fired.
  // The last_csv_reminder_at watermark limits it to one reminder per 24h
  // (surviving restarts); the in-memory day memo keeps it to ~one DB read a day.
  intervalHandles.push(setInterval(() => runCsvReminderTick(), 60 * 60 * 1000));

  // Low projected cash alert (roadmap T2.2 L2). Hourly, NOT activity-gated;
  // see runCashAlertsTick — no DB read while it's off.
  intervalHandles.push(setInterval(() => runCashAlertsTick(), 60 * 60 * 1000));

  // Linked tasks (roadmap T2.4 X2b). Hourly, NOT activity-gated; see
  // runLinkedTasksTick — nothing while off or standalone.
  intervalHandles.push(setInterval(() => runLinkedTasksTick(), 60 * 60 * 1000));

  // Missed-job watchdog (F4). Flushes the in-memory job heartbeats to the
  // job_runs table and alerts (once per outage, signature-deduped) when any
  // scheduled job hasn't ticked for 36h+ — i.e. the process was asleep or
  // dead long enough that data is going stale (Render free tier with
  // keep-alive off, crash loops). Runs ~2 minutes after boot (boot counts as
  // user activity, and a wake-after-long-sleep is exactly when the gap is
  // visible) and every 6 hours thereafter. Activity-gated like the other
  // jobs so it doesn't keep Neon awake.
  const runWatchdog = async () => {
    if (!isUserActive()) return;
    try {
      const { sendToAll } = require("./routes/notifications");
      const { missed } = await jobHealth.checkMissedJobs(pool, { sendToAll });
      if (missed.length > 0) {
        console.warn("Job watchdog: missed jobs —",
          missed.map(m => `${m.job} (${m.stale_hours}h)`).join(", "));
      }
    } catch (err) {
      console.error("Job watchdog error:", err.message);
    }
    // Operator checks (cycle-7 G1 + ST4): refresh the GitHub part when its
    // cache is stale and push one notification when the failing set changes.
    try {
      const { sendToAll } = require("./routes/notifications");
      const operatorChecks = require("./services/operator-checks");
      const result = await operatorChecks.getOperatorChecks({
        pool,
        persistentPool: require("./routes/persistent").getEmbeddedPersistentPool(),
      });
      await operatorChecks.notifyIfChanged(pool, result, { sendToAll });
    } catch (err) {
      console.error("Operator checks error:", err.message);
    }
  };
  const bootCheck = setTimeout(runWatchdog, 2 * 60 * 1000);
  if (bootCheck.unref) bootCheck.unref();
  intervalHandles.push(setInterval(runWatchdog, 6 * 60 * 60 * 1000));

  // Boot run (cycle-8 F27). Every job above is a setInterval, so its first run
  // was one full interval after boot — on a host that sleeps after ~15 minutes
  // idle (Render free tier) the 3- and 6-hour jobs essentially never ran, and
  // the hourly away channels only if the process stayed up an hour. Each job
  // now also runs once shortly after boot, staggered, lightest first. They are
  // all safe to run early: each is gated by its own watermark / dedup / due
  // time (the reason the extra run costs nothing when there's nothing to do).
  scheduleBootRuns({
    "cash-alerts": runCashAlertsTick,
    "linked-tasks": runLinkedTasksTick,
    "budget-alerts": runBudgetAlertTick,
    "housing-ledger": runHousingLedgerTick,
    "csv-reminder": runCsvReminderTick,
    "daily-digest": runDailyDigestTick,
    "weekly-digest": runWeeklyDigestTick,
    "goal-milestones": runGoalMilestonesTick,
    "budget-snapshot": runBudgetSnapshotTick,
    "net-worth-snapshot": runNetWorthSnapshotTick,
    "sheets-auto-sync": runSheetsAutoSyncTick,
    "self-healing-reconcile": runSelfHealingReconcileTick,
    "bank-auto-sync": runBankAutoSyncTick,
    "insights-auto-trigger": runInsightsAutoTriggerTick,
  });
}

// One-shot boot runs (F27): the first at BOOT_FIRST_DELAY_MS, then one every
// BOOT_STAGGER_MS in the order given, so the boot doesn't hit the database
// with fourteen jobs at once. Unref'd, and cleared by stopBackgroundJobs.
const BOOT_FIRST_DELAY_MS = 60 * 1000;
const BOOT_STAGGER_MS = 20 * 1000;
const bootHandles = [];
function bootRunPlan(names) {
  return names.map((name, i) => ({ name, delayMs: BOOT_FIRST_DELAY_MS + i * BOOT_STAGGER_MS }));
}
function scheduleBootRuns(jobs) {
  for (const { name, delayMs } of bootRunPlan(Object.keys(jobs))) {
    const h = setTimeout(() => {
      // Each tick records its own outcome; this only guards a synchronous throw.
      Promise.resolve().then(jobs[name]).catch((e) => console.error(`Boot run of ${name} failed:`, e.message));
    }, delayMs);
    if (h.unref) h.unref();
    bootHandles.push(h);
  }
}

function stopBackgroundJobs() {
  while (intervalHandles.length) clearInterval(intervalHandles.pop());
  while (bootHandles.length) clearTimeout(bootHandles.pop());
}

async function start(app, opts = {}) {
  const standalone = opts.standalone !== false;

  await runMigrations();
  startBackgroundJobs();
  // Cycle-7 F14: check the Teller cert at boot (not on the first Teller call);
  // Settings → Sync Health raises the same condition via /api/data-health.
  try {
    const { tellerCertStatus, COMPROMISED_CERT_WARNING } = require("./services/teller-api");
    if (tellerCertStatus().compromised) console.error(COMPROMISED_CERT_WARNING);
  } catch (e) { console.error("Teller cert check failed:", e.message); }

  if (!standalone) {
    // Embedded mode: shell owns the listener, keep-alive, and shutdown.
    return { app, intervalHandles };
  }

  const server = app.listen(PORT, "0.0.0.0", () => {
    console.log(`Teller server running on http://0.0.0.0:${PORT}`);
    console.log(`  Environment: ${TELLER_ENV}`);
    console.log(`  Application ID: ${TELLER_APP_ID || "(not set)"}`);
    startKeepAlive(PORT);
  });

  function shutdown(signal) {
    console.log(`\n${signal} received — shutting down gracefully...`);
    stopBackgroundJobs();
    server.close(() => {
      console.log("HTTP server closed.");
      pool.end().then(() => {
        console.log("Database pool closed.");
        process.exit(0);
      }).catch(() => process.exit(1));
    });
    setTimeout(() => { console.error("Forced shutdown after timeout."); process.exit(1); }, 10000);
  }
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));

  return { app, server, intervalHandles };
}

module.exports = { start, startBackgroundJobs, stopBackgroundJobs, touchActivity, isUserActive, invalidateJobMemos };
// Exposed for tests (PSC-3): the "away" job ticks and the per-day memo reset.
module.exports._awayJobs = {
  runBudgetAlertTick, runWeeklyDigestTick, runDailyDigestTick, runCsvReminderTick,
  runHousingLedgerTick, runInsightsAutoTriggerTick, runCashAlertsTick, runLinkedTasksTick,
  runBankAutoSyncTick, runSelfHealingReconcileTick,
  reset() { invalidateJobMemos(); },
};
module.exports._boot = { bootRunPlan, BOOT_FIRST_DELAY_MS, BOOT_STAGGER_MS };
