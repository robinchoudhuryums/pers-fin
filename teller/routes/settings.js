// ============================================================================
// Routes: Settings, Google Sheets Sync, Export
// ============================================================================

const express = require("express");
const router = express.Router();
const { pool } = require("../services/database");
const { INSIGHT_MODULES } = require("../data/reference-data");

let sheetsSync;
try {
  sheetsSync = require("../../scripts/sheets-sync");
} catch {
  sheetsSync = null;
}

// GET /api/settings
router.get("/api/settings", async (_req, res) => {
  try {
    const result = await pool.query("SELECT session_timeout_minutes, theme, dashboard_months, insights_enabled, insights_last_run, insights_running_summary, insights_model, insights_cadence_days, keep_alive_enabled, keep_alive_start, keep_alive_end, keep_alive_timezone, zip_code, insight_modules FROM user_settings WHERE id = 1");
    const defaults = { session_timeout_minutes: 15, theme: "dark", dashboard_months: 6, insights_enabled: false, insights_last_run: null, insights_running_summary: null, insights_model: "sonnet", insights_cadence_days: 30, keep_alive_enabled: false, keep_alive_start: 6, keep_alive_end: 0, keep_alive_timezone: "America/New_York", zip_code: null, insight_modules: { utility_comparison: true, spending_benchmarks: true, savings_suggestions: true, subscription_audit: true, anomaly_detection: true, seasonal_forecast: true, debt_optimizer: true, bill_negotiation: true, income_savings: true, tax_deductions: true, goal_tracking: true } };
    const row = result.rows[0] || defaults;
    if (typeof row.insight_modules === "string") row.insight_modules = JSON.parse(row.insight_modules);
    res.json({ ...defaults, ...row, available_modules: INSIGHT_MODULES });
  } catch {
    res.json({ session_timeout_minutes: 15, theme: "dark", dashboard_months: 6, insights_enabled: false, insights_last_run: null, insights_model: "sonnet", insights_cadence_days: 30, keep_alive_enabled: false, keep_alive_start: 6, keep_alive_end: 0, keep_alive_timezone: "America/New_York", zip_code: null, insight_modules: { utility_comparison: true, spending_benchmarks: true, savings_suggestions: true, subscription_audit: true, anomaly_detection: true, seasonal_forecast: true, debt_optimizer: true, bill_negotiation: true, income_savings: true, tax_deductions: true, goal_tracking: true }, available_modules: INSIGHT_MODULES });
  }
});

// PATCH /api/settings
router.patch("/api/settings", async (req, res) => {
  const { session_timeout_minutes, theme, dashboard_months, insights_enabled, insights_model, insights_cadence_days, keep_alive_enabled, keep_alive_start, keep_alive_end, keep_alive_timezone, zip_code, insight_modules } = req.body;
  try {
    const updates = []; const values = []; let idx = 1;
    if (session_timeout_minutes !== undefined) {
      updates.push("session_timeout_minutes = $" + idx++);
      values.push(Math.max(1, Math.min(parseInt(session_timeout_minutes) || 15, 1440)));
      if (req.session) req.session.timeoutMinutes = values[values.length - 1];
    }
    if (theme !== undefined && ["dark", "light"].includes(theme)) {
      updates.push("theme = $" + idx++); values.push(theme);
    }
    if (dashboard_months !== undefined) {
      updates.push("dashboard_months = $" + idx++);
      values.push(Math.max(1, Math.min(parseInt(dashboard_months) || 6, 24)));
    }
    if (insights_enabled !== undefined) {
      updates.push("insights_enabled = $" + idx++); values.push(!!insights_enabled);
    }
    if (insights_model !== undefined && ["haiku", "sonnet", "opus"].includes(insights_model)) {
      updates.push("insights_model = $" + idx++); values.push(insights_model);
    }
    if (insights_cadence_days !== undefined) {
      const valid = [7, 14, 30, 60, 90];
      const val = parseInt(insights_cadence_days);
      if (valid.includes(val)) { updates.push("insights_cadence_days = $" + idx++); values.push(val); }
    }
    if (keep_alive_enabled !== undefined) {
      updates.push("keep_alive_enabled = $" + idx++); values.push(!!keep_alive_enabled);
    }
    if (keep_alive_start !== undefined) {
      const h = parseInt(keep_alive_start);
      if (h >= 0 && h <= 23) { updates.push("keep_alive_start = $" + idx++); values.push(h); }
    }
    if (keep_alive_end !== undefined) {
      const h = parseInt(keep_alive_end);
      if (h >= 0 && h <= 23) { updates.push("keep_alive_end = $" + idx++); values.push(h); }
    }
    if (keep_alive_timezone !== undefined && typeof keep_alive_timezone === "string" && keep_alive_timezone.length <= 50) {
      updates.push("keep_alive_timezone = $" + idx++); values.push(keep_alive_timezone);
    }
    if (zip_code !== undefined) {
      const cleaned = (zip_code || "").replace(/\D/g, "").substring(0, 5);
      updates.push("zip_code = $" + idx++);
      values.push(cleaned || null);
    }
    if (insight_modules !== undefined && typeof insight_modules === "object") {
      updates.push("insight_modules = $" + idx++);
      values.push(JSON.stringify(insight_modules));
    }
    if (!updates.length) return res.status(400).json({ error: "No valid settings" });
    updates.push("updated_at = now()");
    await pool.query("INSERT INTO user_settings (id) VALUES (1) ON CONFLICT DO NOTHING");
    const result = await pool.query("UPDATE user_settings SET " + updates.join(", ") + " WHERE id = 1 RETURNING *", values);
    res.json(result.rows[0]);
  } catch (err) {
    console.error("settings error:", err.message);
    res.status(500).json({ error: "An internal error occurred." });
  }
});

// POST /api/sheets/sync
router.post("/api/sheets/sync", async (_req, res) => {
  if (!sheetsSync) {
    return res.status(501).json({ error: "Google Sheets integration not available. Install googleapis: npm install googleapis" });
  }
  if (!process.env.GOOGLE_SHEETS_ID || !process.env.GOOGLE_SERVICE_ACCOUNT_KEY) {
    return res.status(400).json({ error: "Set GOOGLE_SHEETS_ID and GOOGLE_SERVICE_ACCOUNT_KEY in .env" });
  }
  try {
    const result = await sheetsSync.syncAll();
    res.json(result);
  } catch (err) {
    console.error("Sheets sync error:", err.message);
    res.status(500).json({ error: "An internal error occurred." });
  }
});

// POST /api/sheets/dashboard
router.post("/api/sheets/dashboard", async (_req, res) => {
  if (!sheetsSync) {
    return res.status(501).json({ error: "Google Sheets integration not available." });
  }
  try {
    const result = await sheetsSync.syncDashboardOnly();
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: "An internal error occurred." });
  }
});

// GET /api/export
router.get("/api/export", async (req, res) => {
  const type = req.query.type || "transactions";
  try {
    if (type === "subscriptions") {
      const result = await pool.query("SELECT display_name, amount, cadence_days, category, first_seen, last_charged, next_expected, is_active FROM detected_subscriptions ORDER BY amount DESC");
      const header = "Name,Amount,Cadence Days,Category,First Seen,Last Charged,Next Expected,Active\n";
      const rows = result.rows.map(r => `"${r.display_name}",${r.amount},${r.cadence_days},"${r.category}",${r.first_seen},${r.last_charged},${r.next_expected},${r.is_active}`).join("\n");
      res.setHeader("Content-Type", "text/csv");
      res.setHeader("Content-Disposition", "attachment; filename=subscriptions.csv");
      return res.send(header + rows);
    }
    const months = parseInt(req.query.months) || 12;
    const result = await pool.query(
      `SELECT t.date, COALESCE(t.merchant_name, t.name) AS merchant, t.amount, la.name AS account,
              COALESCE(pi.institution_name, te.institution_name, 'CSV') AS institution,
              t.category[1] AS category
       FROM transactions t
       JOIN linked_accounts la ON la.account_id = t.account_id
       LEFT JOIN plaid_items pi ON pi.id = la.plaid_item_id
       LEFT JOIN teller_enrollments te ON te.id = la.teller_enrollment_id
       WHERE t.pending = false AND t.date >= CURRENT_DATE - make_interval(months => $1)
       ORDER BY t.date DESC`,
      [months]
    );
    const header = "Date,Merchant,Amount,Account,Institution,Category\n";
    const rows = result.rows.map(r => `${r.date},"${(r.merchant || "").replace(/"/g, '""')}",${r.amount},"${r.account}","${r.institution}","${r.category || ""}"`).join("\n");
    res.setHeader("Content-Type", "text/csv");
    res.setHeader("Content-Disposition", `attachment; filename=transactions_${months}mo.csv`);
    res.send(header + rows);
  } catch (err) {
    res.status(500).json({ error: "An internal error occurred." });
  }
});

module.exports = router;
