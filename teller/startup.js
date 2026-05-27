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
    if (!isUserActive()) return;
    try {
      const [accounts, investments] = await Promise.all([
        pool.query("SELECT name, type, available_balance, current_balance FROM linked_accounts WHERE available_balance IS NOT NULL OR current_balance IS NOT NULL"),
        pool.query("SELECT name, account_type, balance FROM investment_accounts WHERE is_active = true AND balance != 0"),
      ]);
      if (accounts.rows.length === 0 && investments.rows.length === 0) return;
      let totalAssets = 0, totalLiabilities = 0;
      const breakdown = { accounts: [], investments: [] };
      for (const a of accounts.rows) {
        if (a.type === "credit") {
          totalLiabilities += parseFloat(a.current_balance || 0);
          breakdown.accounts.push({ name: a.name, type: a.type, amount: -parseFloat(a.current_balance || 0) });
        } else {
          const bal = parseFloat(a.available_balance || a.current_balance || 0);
          totalAssets += bal;
          breakdown.accounts.push({ name: a.name, type: a.type, amount: bal });
        }
      }
      for (const inv of investments.rows) {
        const bal = parseFloat(inv.balance);
        totalAssets += bal;
        breakdown.investments.push({ name: inv.name, type: inv.account_type, amount: bal });
      }
      await pool.query(
        `INSERT INTO net_worth_snapshots (total_assets, total_liabilities, net_worth, breakdown, snapshot_date)
         VALUES ($1, $2, $3, $4, CURRENT_DATE)
         ON CONFLICT (snapshot_date) DO UPDATE SET
           total_assets = EXCLUDED.total_assets,
           total_liabilities = EXCLUDED.total_liabilities,
           net_worth = EXCLUDED.net_worth,
           breakdown = EXCLUDED.breakdown`,
        [totalAssets, totalLiabilities, totalAssets - totalLiabilities, JSON.stringify(breakdown)]
      );
      console.log("Daily net worth snapshot recorded: $" + (totalAssets - totalLiabilities).toFixed(2));
    } catch (err) {
      console.error("Net worth auto-snapshot error:", err.message);
    }
  }, 60 * 60 * 1000));

  // Goal milestone notifications (every 6 hours). Gated on user activity.
  intervalHandles.push(setInterval(async () => {
    if (!isUserActive()) return;
    try {
      const goals = await pool.query(
        "SELECT id, name, target_amount, current_amount FROM financial_goals WHERE is_active = true"
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
        const { syncAllPlaidTransactions } = require("./routes/investments");
        const { detectRecurringTransfers } = require("../scripts/detect-transfers");
        const { runCategorize } = require("./routes/categorize");
        const { generateInsights } = require("./routes/insights");

        try { await syncAllEnrollments(); } catch (e) { console.error("Pre-insights sync error:", e.message); }
        try { await syncAllPlaidTransactions(); } catch (e) { console.error("Pre-insights Plaid sync error:", e.message); }
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
    if (!isUserActive()) return;
    try {
      const { getCategorySpendingThisMonth } = require("./services/financial-queries");
      const [budgets, spending] = await Promise.all([
        pool.query("SELECT category, monthly_limit FROM budgets"),
        getCategorySpendingThisMonth(pool),
      ]);
      if (budgets.rows.length === 0) return;
      const spendMap = {};
      for (const r of spending) spendMap[r.category] = parseFloat(r.spent);

      const { sendToAll } = require("./routes/notifications");
      for (const b of budgets.rows) {
        const spent = spendMap[b.category] || 0;
        const limit = parseFloat(b.monthly_limit);
        if (limit <= 0) continue;
        const pct = Math.round((spent / limit) * 100);
        if (pct >= 100) {
          await sendToAll({
            title: "Budget exceeded: " + b.category,
            body: "$" + spent.toFixed(2) + " spent of $" + limit.toFixed(2) + " budget (" + pct + "%)",
            tag: "budget-over-" + b.category.toLowerCase().replace(/\s+/g, "-"),
            data: { url: "/budgets" },
          });
        } else if (pct >= 80) {
          await sendToAll({
            title: "Budget warning: " + b.category,
            body: "$" + spent.toFixed(2) + " of $" + limit.toFixed(2) + " (" + pct + "% — approaching limit)",
            tag: "budget-warn-" + b.category.toLowerCase().replace(/\s+/g, "-"),
            data: { url: "/budgets" },
          });
        }
      }
    } catch (err) {
      console.error("Budget alert notification error:", err.message);
    }
  }, 3 * 60 * 60 * 1000));

  // Budget snapshot auto-trigger (every 6 hours; only acts on the 1st of the month).
  // Gated on user activity.
  intervalHandles.push(setInterval(async () => {
    if (!isUserActive()) return;
    try {
      const today = new Date();
      if (today.getDate() !== 1) return;
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
    try {
      const settings = await pool.query(
        "SELECT auto_sync_enabled, auto_sync_interval_hours, last_auto_sync_at FROM user_settings WHERE id = 1"
      );
      const s = settings.rows[0];
      if (!s || !s.auto_sync_enabled) return;
      const intervalHours = Math.max(1, Math.min(168, parseInt(s.auto_sync_interval_hours) || 6));
      const lastSync = s.last_auto_sync_at ? new Date(s.last_auto_sync_at) : null;
      const now = new Date();
      const dueMs = intervalHours * 60 * 60 * 1000;
      if (lastSync && (now - lastSync) < dueMs) return;

      const { syncAllEnrollments, syncAllBalances } = require("./routes/enrollments");
      const { syncAllPlaidTransactions } = require("./routes/investments");
      let txnResult = null, balResult = null, plaidResult = null;
      try { txnResult = await syncAllEnrollments(); }
      catch (e) { console.error("Auto-sync Teller error:", e.message); }
      try { plaidResult = await syncAllPlaidTransactions(); }
      catch (e) { console.error("Auto-sync Plaid error:", e.message); }
      try { balResult = await syncAllBalances(); }
      catch (e) { console.error("Auto-sync balances error:", e.message); }

      await pool.query("UPDATE user_settings SET last_auto_sync_at = now() WHERE id = 1")
        .catch(e => console.error("Auto-sync timestamp update failed:", e.message));
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

  // Weekly digest email. Gated on user activity (no point burning compute
  // to check if nobody's here). Fires on the configured weekly_digest_day
  // when weekly_digest_enabled is true. Bails silently otherwise.
  intervalHandles.push(setInterval(async () => {
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
