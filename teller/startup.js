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

function startBackgroundJobs() {
  // Sheets auto-sync check (every hour). Gated: skips when no user has
  // been active for 15+ minutes so Neon can auto-suspend.
  intervalHandles.push(setInterval(async () => {
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
        await sheetsSync.syncAll();
        await pool.query("UPDATE user_settings SET sheets_last_auto_sync = now() WHERE id = 1");
        console.log("Auto-sync to Google Sheets complete.");
      }
    } catch (err) {
      console.error("Sheets auto-sync error:", err.message);
    }
  }, 60 * 60 * 1000));

  // Hourly net worth auto-snapshot. Gated: skips when no user is active
  // so Neon can auto-suspend. The INSERT uses ON CONFLICT (snapshot_date)
  // DO UPDATE so a same-day re-run rewrites the row with the latest
  // balances.
  intervalHandles.push(setInterval(async () => {
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
    } catch (err) {
      console.error("Net worth auto-snapshot error:", err.message);
    }
  }, 60 * 60 * 1000));

  // Goal milestone notifications (every 6 hours). Gated on user activity.
  intervalHandles.push(setInterval(async () => {
    jobHealth.tick("goal-milestones");
    if (!isUserActive()) return;
    try {
      // Derive current_amount the same way GET /api/goals does: for a
      // funding-linked goal the real progress is (account_balance - baseline),
      // and the stored current_amount column is never updated — so milestones
      // must compute it here too, or funding-linked goals would fire on a stale
      // value (F13). Orphaned funding links (FK set but row gone) fall back to
      // the stored value via the la.id / ia.id NULL guards.
      const goals = await pool.query(
        `SELECT g.id, g.name, g.target_amount,
                CASE
                  WHEN g.funding_account_id IS NOT NULL AND la.id IS NOT NULL
                    THEN GREATEST(0, COALESCE(la.available_balance, la.current_balance, 0) - COALESCE(g.goal_baseline_amount, 0))
                  WHEN g.funding_investment_id IS NOT NULL AND ia.id IS NOT NULL
                    THEN GREATEST(0, COALESCE(ia.balance, 0) - COALESCE(g.goal_baseline_amount, 0))
                  ELSE g.current_amount
                END AS current_amount
         FROM financial_goals g
         LEFT JOIN linked_accounts     la ON la.id = g.funding_account_id
         LEFT JOIN investment_accounts ia ON ia.id = g.funding_investment_id
         WHERE g.is_active = true`
      );
      const MILESTONES = [25, 50, 75, 100];
      for (const g of goals.rows) {
        const target = parseFloat(g.target_amount);
        if (target <= 0) continue;
        const pct = Math.floor((parseFloat(g.current_amount) / target) * 100);
        for (const m of MILESTONES) {
          if (pct >= m) {
            const key = `milestone_${m}`;
            const check = await pool.query(
              "SELECT notes FROM financial_goals WHERE id = $1", [g.id]
            );
            const notes = check.rows[0]?.notes || "";
            if (notes.includes(key)) continue;
            try {
              const { sendToAll } = require("./routes/notifications");
              await sendToAll({
                title: pct >= 100 ? "Goal reached!" : "Goal milestone: " + m + "%",
                body: g.name + ": " + pct + "% complete" + (pct >= 100 ? " — congratulations!" : ""),
                tag: "goal-" + g.id,
                data: { url: "/goals" },
              });
            } catch {}
            const newNotes = (notes ? notes + " " : "") + key;
            await pool.query("UPDATE financial_goals SET notes = $1 WHERE id = $2", [newNotes, g.id]);
          }
        }
      }
    } catch (err) {
      console.error("Goal milestone check error:", err.message);
    }
  }, 6 * 60 * 60 * 1000));

  // Auto-trigger AI insights based on cadence (every 6 hours).
  // Pre-syncs transactions + balances + detection so AI sees fresh data.
  intervalHandles.push(setInterval(async () => {
    jobHealth.tick("insights-auto-trigger");
    try {
      if (!process.env.ANTHROPIC_API_KEY) return;
      const settings = await pool.query(
        "SELECT insights_enabled, insights_cadence_days, insights_last_run FROM user_settings WHERE id = 1"
      );
      const s = settings.rows[0];
      if (!s || !s.insights_enabled) return;
      const cadenceDays = s.insights_cadence_days || 30;
      const lastRun = s.insights_last_run ? new Date(s.insights_last_run) : null;
      const now = new Date();
      if (!lastRun || (now - lastRun) / 86400000 >= cadenceDays) {
        const { syncAllEnrollments, syncAllBalances } = require("./routes/enrollments");
        const { runSubscriptionDetection } = require("./routes/subscriptions");
        const { syncAllPlaidTransactions, syncAllPlaidHoldings } = require("./routes/investments");
        const { detectRecurringTransfers } = require("../scripts/detect-transfers");
        const { runCategorize } = require("./routes/categorize");
        const { generateInsights } = require("./routes/insights");

        try { await syncAllEnrollments(); } catch (e) { console.error("Pre-insights sync error:", e.message); }
        try { await syncAllPlaidTransactions(); } catch (e) { console.error("Pre-insights Plaid sync error:", e.message); }
        try { await syncAllPlaidHoldings(); } catch (e) { console.error("Pre-insights holdings sync error:", e.message); }
        try { await syncAllBalances(); } catch (e) { console.error("Pre-insights balance error:", e.message); }
        try { await runSubscriptionDetection(); } catch (e) { console.error("Pre-insights detect error:", e.message); }
        try { await detectRecurringTransfers(pool); } catch (e) { console.error("Pre-insights detect-transfers error:", e.message); }
        // Categorize BEFORE generating insights so the AI sees freshly
        // categorized rows (matches the documented chain in CLAUDE.md).
        try {
          const cat = await runCategorize();
          if (!cat.ok) console.log("Auto-trigger categorize skipped:", cat.error);
        } catch (e) { console.error("Pre-insights categorize error:", e.message); }
        try {
          const ins = await generateInsights();
          if (ins.ok) console.log("Auto-triggered AI insights (cadence: " + cadenceDays + " days).");
          else console.log("Auto-trigger insights skipped:", ins.error);
        } catch (err) { console.error("Auto-trigger insights error:", err.message); }
      }
    } catch (err) {
      console.error("Insights auto-trigger error:", err.message);
    }
  }, 6 * 60 * 60 * 1000));

  // Budget alert push notifications (every 3 hours). Gated on user activity.
  intervalHandles.push(setInterval(async () => {
    jobHealth.tick("budget-alerts");
    if (!isUserActive()) return;
    try {
      const { getCategorySpendingThisMonth } = require("./services/financial-queries");
      const now = new Date();
      const month = now.getFullYear() + "-" + String(now.getMonth() + 1).padStart(2, "0");
      // Rollover applied to this month is the PRIOR month's unused budget (FA-1)
      // — the snapshot job stores it keyed by prevMonth, so read that row, not
      // the current month's (which mirrors GET /api/budgets + /alerts).
      const prevD = new Date(now.getFullYear(), now.getMonth() - 1, 1);
      const prevMonth = prevD.getFullYear() + "-" + String(prevD.getMonth() + 1).padStart(2, "0");
      const [budgets, spending, snapshots] = await Promise.all([
        pool.query("SELECT id, category, monthly_limit, rollover_enabled, budget_type, effective_month FROM budgets"),
        getCategorySpendingThisMonth(pool),
        pool.query("SELECT budget_id, rollover_amount FROM budget_snapshots WHERE month = $1", [prevMonth]),
      ]);
      if (budgets.rows.length === 0) return;
      const spendMap = {};
      for (const r of spending) spendMap[r.category] = parseFloat(r.spent);
      const snapMap = {};
      for (const s of snapshots.rows) snapMap[s.budget_id] = s;

      const { sendToAll, sentRecently } = require("./routes/notifications");
      for (const b of budgets.rows) {
        // Skip one-time budgets outside their effective month, and compare
        // against the effective limit (base + rollover) — same as the in-app
        // alerts endpoint and GET /api/budgets (F18).
        if (b.budget_type === "one_time" && b.effective_month && b.effective_month !== month) continue;
        const spent = spendMap[b.category] || 0;
        const snap = snapMap[b.id];
        const rollover = (b.rollover_enabled && snap) ? parseFloat(snap.rollover_amount || 0) : 0;
        const limit = parseFloat(b.monthly_limit) + rollover;
        if (limit <= 0) continue;
        const pct = Math.round((spent / limit) * 100);
        // At most one alert per category+severity per 24h: without this, a
        // category that stays over budget re-logged a notification_log row on
        // every 3-hour tick for the rest of the month — web-push collapsed the
        // OS notifications via `tag`, but the in-app bell badge/log spammed.
        // Escalation (warn → over) uses a different tag, so it still fires
        // immediately.
        if (pct >= 100) {
          const tag = "budget-over-" + b.category.toLowerCase().replace(/\s+/g, "-");
          if (await sentRecently(tag, 24)) continue;
          await sendToAll({
            title: "Budget exceeded: " + b.category,
            body: "$" + spent.toFixed(2) + " spent of $" + limit.toFixed(2) + " budget (" + pct + "%)",
            tag,
            data: { url: "/budgets" },
          });
        } else if (pct >= 80) {
          const tag = "budget-warn-" + b.category.toLowerCase().replace(/\s+/g, "-");
          if (await sentRecently(tag, 24)) continue;
          await sendToAll({
            title: "Budget warning: " + b.category,
            body: "$" + spent.toFixed(2) + " of $" + limit.toFixed(2) + " (" + pct + "% — approaching limit)",
            tag,
            data: { url: "/budgets" },
          });
        }
      }
    } catch (err) {
      console.error("Budget alert notification error:", err.message);
    }
  }, 3 * 60 * 60 * 1000));

  // Budget snapshot auto-trigger (every 6 hours). Snapshots the PRIOR (now-
  // complete) month's spending + rollover so rollover-enabled budgets advance.
  // M5: this used to only act when today.getDate()===1, which — combined with
  // the user-activity gate and Render free-tier sleep — meant a snapshot could
  // be permanently missed if nobody woke the process on the 1st, and from the
  // 2nd onward the date gate never let it catch up, so rollover silently never
  // applied that month. Now it runs on EVERY tick and is made idempotent by the
  // existing-snapshot short-circuit below, so any tick after the month rolls
  // over creates the missing prior-month snapshot (catch-up) and subsequent
  // ticks no-op. Still gated on user activity (the prior month is complete
  // regardless of which day we run, so timing within the month doesn't matter).
  intervalHandles.push(setInterval(async () => {
    jobHealth.tick("budget-snapshot");
    if (!isUserActive()) return;
    try {
      const today = new Date();
      const prev = new Date(today.getFullYear(), today.getMonth() - 1, 1);
      const prevMonth = prev.getFullYear() + "-" + String(prev.getMonth() + 1).padStart(2, "0");
      const existing = await pool.query(
        "SELECT 1 FROM budget_snapshots WHERE month = $1 LIMIT 1", [prevMonth]
      );
      if (existing.rows.length > 0) return;
      const { getCategorySpendingForMonth } = require("./services/financial-queries");
      // Pull spending FOR last month, not this (new) month — getCategorySpendingThisMonth
      // would query the just-rolled-over current month and snapshot near-zero spending,
      // which made every rollover-enabled budget carry forward its full limit.
      const [budgets, spending] = await Promise.all([
        pool.query("SELECT * FROM budgets"),
        getCategorySpendingForMonth(pool, prevMonth),
      ]);
      const spendMap = {};
      for (const r of spending) spendMap[r.category] = parseFloat(r.spent);
      for (const b of budgets.rows) {
        const spent = spendMap[b.category] || 0;
        const limit = parseFloat(b.monthly_limit);
        const rollover = b.rollover_enabled ? Math.max(0, limit - spent) : 0;
        await pool.query(
          `INSERT INTO budget_snapshots (budget_id, month, monthly_limit, spent, rollover_amount)
           VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (budget_id, month) DO NOTHING`,
          [b.id, prevMonth, limit, spent, rollover]
        );
      }
      console.log("Auto budget snapshot created for", prevMonth);
    } catch (err) {
      console.error("Budget snapshot auto-trigger error:", err.message);
    }
  }, 6 * 60 * 60 * 1000));

  // Bank auto-sync (every hour, throttled by user setting)
  intervalHandles.push(setInterval(async () => {
    jobHealth.tick("bank-auto-sync");
    try {
      const settings = await pool.query(
        "SELECT auto_sync_enabled, auto_sync_interval_hours, last_auto_sync_at, last_sync_result FROM user_settings WHERE id = 1"
      );
      const s = settings.rows[0];
      if (!s || !s.auto_sync_enabled) return;
      const intervalHours = Math.max(1, Math.min(168, parseInt(s.auto_sync_interval_hours) || 6));
      const lastSync = s.last_auto_sync_at ? new Date(s.last_auto_sync_at) : null;
      const now = new Date();
      const dueMs = intervalHours * 60 * 60 * 1000;
      if (lastSync && (now - lastSync) < dueMs) return;

      const { syncAllEnrollments, syncAllBalances, recordSyncResult } = require("./routes/enrollments");
      const { syncAllPlaidTransactions, syncAllPlaidHoldings } = require("./routes/investments");
      let txnResult = null, balResult = null, plaidResult = null, holdingsResult = null;
      try { txnResult = await syncAllEnrollments(); }
      catch (e) { console.error("Auto-sync Teller error:", e.message); }
      try { plaidResult = await syncAllPlaidTransactions(); }
      catch (e) { console.error("Auto-sync Plaid error:", e.message); }
      try { holdingsResult = await syncAllPlaidHoldings(); }
      catch (e) { console.error("Auto-sync holdings error:", e.message); }
      try { balResult = await syncAllBalances(); }
      catch (e) { console.error("Auto-sync balances error:", e.message); }

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

      // Persist a structured sync-result so per-item errors (decryption_failed,
      // per-institution failures) surface in the Sync Health card even on a
      // scheduled run nobody is watching (addition D). The auto-sync covers all
      // providers, so its record is the comprehensive one.
      const syncRecord = await recordSyncResult([
        { provider: "teller_txn", result: txnResult },
        { provider: "plaid_txn", result: plaidResult },
        { provider: "plaid_holdings", result: holdingsResult },
        { provider: "teller_balance", result: balResult },
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
        } catch {}
      }
      const tellerTxns = txnResult ? txnResult.transactions_added : 0;
      const plaidTxns = plaidResult && plaidResult.ok ? plaidResult.transactions_added : 0;
      const syncMsg = `${tellerTxns + plaidTxns} txns (${tellerTxns} Teller, ${plaidTxns} Plaid)` +
        ", " + (balResult ? `${balResult.accounts_updated} balances` : "balance sync failed");
      console.log("Auto-sync complete: " + syncMsg);
      const txnsAdded = tellerTxns + plaidTxns;
      const balancesUpdated = balResult ? balResult.accounts_updated : 0;
      const anyFailed = !txnResult || !balResult;
      const anyChanged = txnsAdded > 0 || balancesUpdated > 0;
      if (s.sync_notifications_enabled !== false && (anyChanged || anyFailed)) {
        try {
          const { sendToAll } = require("./routes/notifications");
          await sendToAll({
            title: anyFailed ? "Auto-sync issue" : "Auto-sync complete",
            body: syncMsg,
            tag: "auto-sync",
            data: { url: "/dashboard" },
          });
        } catch {}
      }
    } catch (err) {
      console.error("Auto-sync scheduler error:", err.message);
    }
  }, 60 * 60 * 1000));

  // Self-healing reconcile (every hour, acts at most weekly). Re-fetches the
  // trailing 90 days from every Teller enrollment regardless of the incremental
  // watermark, so any transactions a prior sync dropped (same-day late arrivals,
  // a failed-sibling-account skip) are recovered via idempotent upserts. Teller
  // only — it's free and cheap; Plaid reconcile is heavier (full cursor re-walk)
  // and stays a manual POST /api/sync/reconcile action. Not gated on user
  // activity: a weekly background heal should run even while the user is away.
  intervalHandles.push(setInterval(async () => {
    jobHealth.tick("self-healing-reconcile");
    try {
      const r = await pool.query("SELECT last_reconcile_at FROM user_settings WHERE id = 1");
      const last = r.rows[0]?.last_reconcile_at ? new Date(r.rows[0].last_reconcile_at) : null;
      const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
      if (last && (Date.now() - last.getTime()) < WEEK_MS) return;
      const { reconcileTeller } = require("./routes/enrollments");
      const result = await reconcileTeller(90);
      await pool.query("UPDATE user_settings SET last_reconcile_at = now() WHERE id = 1").catch(() => {});
      console.log("Self-healing Teller reconcile complete:", JSON.stringify(result));
    } catch (err) {
      console.error("Self-healing reconcile error:", err.message);
    }
  }, 60 * 60 * 1000));

  // Weekly digest email. Gated on user activity (no point burning compute
  // to check if nobody's here). Fires on the configured weekly_digest_day
  // when weekly_digest_enabled is true. Bails silently otherwise.
  intervalHandles.push(setInterval(async () => {
    jobHealth.tick("weekly-digest");
    if (!isUserActive()) return;
    try {
      const settings = await pool.query(
        "SELECT weekly_digest_enabled, weekly_digest_day FROM user_settings WHERE id = 1"
      );
      const s = settings.rows[0];
      if (!s || !s.weekly_digest_enabled) return;
      const today = new Date();
      // 0=Sun, 1=Mon, etc. Default 1 (Monday). The 6-day gate inside
      // runWeeklyDigest handles dedup across multiple ticks per day.
      if (today.getDay() !== (s.weekly_digest_day ?? 1)) return;
      const { runWeeklyDigest } = require("./routes/insights");
      const result = await runWeeklyDigest();
      if (result.sent) console.log("Weekly digest sent.");
      else if (result.reason && result.reason !== "already_sent_this_week" && result.reason !== "disabled") {
        console.log("Weekly digest skipped:", result.reason);
      }
    } catch (err) {
      console.error("Weekly digest scheduler error:", err.message);
    }
  }, 60 * 60 * 1000));

  // Daily digest email (#19). Gated on user activity.
  intervalHandles.push(setInterval(async () => {
    jobHealth.tick("daily-digest");
    if (!isUserActive()) return;
    try {
      const { runDailyDigest } = require("./routes/insights");
      const result = await runDailyDigest();
      if (result.sent) console.log("Daily digest sent.");
      else if (result.reason && result.reason !== "already_sent_today" && result.reason !== "disabled" && result.reason !== "nothing_new") {
        console.log("Daily digest skipped:", result.reason);
      }
    } catch (err) {
      console.error("Daily digest scheduler error:", err.message);
    }
  }, 60 * 60 * 1000));

  // CSV import reminder (every 24 hours). Gated on user activity.
  intervalHandles.push(setInterval(async () => {
    jobHealth.tick("csv-reminder");
    if (!isUserActive()) return;
    try {
      const settings = await pool.query(
        "SELECT csv_reminder_enabled, csv_reminder_days, sync_notifications_enabled FROM user_settings WHERE id = 1"
      );
      const s = settings.rows[0];
      if (!s || !s.csv_reminder_enabled) return;
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
    } catch (err) {
      console.error("CSV reminder scheduler error:", err.message);
    }
  }, 24 * 60 * 60 * 1000));

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
  };
  const bootCheck = setTimeout(runWatchdog, 2 * 60 * 1000);
  if (bootCheck.unref) bootCheck.unref();
  intervalHandles.push(setInterval(runWatchdog, 6 * 60 * 60 * 1000));
}

function stopBackgroundJobs() {
  while (intervalHandles.length) clearInterval(intervalHandles.pop());
}

async function start(app, opts = {}) {
  const standalone = opts.standalone !== false;

  await runMigrations();
  startBackgroundJobs();

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

module.exports = { start, startBackgroundJobs, stopBackgroundJobs, touchActivity };
