// ============================================================================
// Routes: Settings, Google Sheets Sync, Export
// ============================================================================

const express = require("express");
const router = express.Router();
const { pool, ENCRYPTION_PASSPHRASE } = require("../services/database");
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
    const result = await pool.query("SELECT session_timeout_minutes, theme, dashboard_months, insights_enabled, insights_last_run, insights_running_summary, insights_model, insights_cadence_days, keep_alive_enabled, keep_alive_start, keep_alive_end, keep_alive_timezone, zip_code, insight_modules, pyramid_data_source, pyramid_color_mode, debt_baseline_amount, sheets_auto_sync_enabled, sheets_auto_sync_interval, sheets_last_auto_sync, csv_reminder_days, csv_reminder_enabled, dashboard_widgets, persistent_url, persistent_webhook_enabled, auto_sync_enabled, auto_sync_interval_hours, last_auto_sync_at, last_balance_sync_at, last_txn_sync_at, sync_notifications_enabled FROM user_settings WHERE id = 1");
    const defaults = { session_timeout_minutes: 15, theme: "dark", dashboard_months: 6, insights_enabled: false, insights_last_run: null, insights_running_summary: null, insights_model: "sonnet", insights_cadence_days: 30, keep_alive_enabled: false, keep_alive_start: 6, keep_alive_end: 0, keep_alive_timezone: "America/New_York", zip_code: null, insight_modules: { utility_comparison: true, spending_benchmarks: true, savings_suggestions: true, subscription_audit: true, anomaly_detection: true, seasonal_forecast: true, debt_optimizer: true, bill_negotiation: true, income_savings: true, tax_deductions: true, goal_tracking: true, recurring_transfers: true }, pyramid_data_source: "wellness", pyramid_color_mode: "single", debt_baseline_amount: null, sheets_auto_sync_enabled: false, sheets_auto_sync_interval: 'weekly', sheets_last_auto_sync: null, csv_reminder_days: 14, csv_reminder_enabled: true, dashboard_widgets: {pyramid:true,accounts:true,recentTxns:true,monthlySpend:true,categories:true,merchants:true,upcoming:true,forecast:true,charts:true,calendar:true,cashFlow:true,savingsRate:true,yoy:true}, auto_sync_enabled: false, auto_sync_interval_hours: 6, last_auto_sync_at: null, last_balance_sync_at: null, last_txn_sync_at: null, sync_notifications_enabled: true };
    const row = result.rows[0] || defaults;
    if (typeof row.insight_modules === "string") row.insight_modules = JSON.parse(row.insight_modules);
    res.json({ ...defaults, ...row, available_modules: INSIGHT_MODULES });
  } catch {
    res.json({ session_timeout_minutes: 15, theme: "dark", dashboard_months: 6, insights_enabled: false, insights_last_run: null, insights_model: "sonnet", insights_cadence_days: 30, keep_alive_enabled: false, keep_alive_start: 6, keep_alive_end: 0, keep_alive_timezone: "America/New_York", zip_code: null, insight_modules: { utility_comparison: true, spending_benchmarks: true, savings_suggestions: true, subscription_audit: true, anomaly_detection: true, seasonal_forecast: true, debt_optimizer: true, bill_negotiation: true, income_savings: true, tax_deductions: true, goal_tracking: true, recurring_transfers: true }, pyramid_data_source: "wellness", pyramid_color_mode: "single", available_modules: INSIGHT_MODULES });
  }
});

// PATCH /api/settings
router.patch("/api/settings", async (req, res) => {
  const { session_timeout_minutes, theme, dashboard_months, insights_enabled, insights_model, insights_cadence_days, keep_alive_enabled, keep_alive_start, keep_alive_end, keep_alive_timezone, zip_code, insight_modules, pyramid_data_source, pyramid_color_mode, debt_baseline_amount } = req.body;
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
    if (pyramid_data_source !== undefined && ["wellness", "debt_payoff", "goal_progress", "spending_categories", "net_worth"].includes(pyramid_data_source)) {
      updates.push("pyramid_data_source = $" + idx++); values.push(pyramid_data_source);
    }
    if (pyramid_color_mode !== undefined && ["single", "multi"].includes(pyramid_color_mode)) {
      updates.push("pyramid_color_mode = $" + idx++); values.push(pyramid_color_mode);
    }
    if (debt_baseline_amount !== undefined) {
      const val = debt_baseline_amount === null ? null : parseFloat(debt_baseline_amount);
      if (val === null || (!isNaN(val) && val >= 0)) {
        updates.push("debt_baseline_amount = $" + idx++); values.push(val);
      }
    }
    if (req.body.sheets_auto_sync_enabled !== undefined) {
      updates.push("sheets_auto_sync_enabled = $" + idx++); values.push(!!req.body.sheets_auto_sync_enabled);
    }
    if (req.body.sheets_auto_sync_interval !== undefined && ["daily", "weekly", "monthly"].includes(req.body.sheets_auto_sync_interval)) {
      updates.push("sheets_auto_sync_interval = $" + idx++); values.push(req.body.sheets_auto_sync_interval);
    }
    // Bank auto-sync (Phase A)
    if (req.body.auto_sync_enabled !== undefined) {
      updates.push("auto_sync_enabled = $" + idx++); values.push(!!req.body.auto_sync_enabled);
    }
    if (req.body.auto_sync_interval_hours !== undefined) {
      const h = parseInt(req.body.auto_sync_interval_hours);
      if (h >= 1 && h <= 168) { updates.push("auto_sync_interval_hours = $" + idx++); values.push(h); }
    }
    if (req.body.csv_reminder_days !== undefined) {
      const val = parseInt(req.body.csv_reminder_days);
      if (val >= 1 && val <= 90) { updates.push("csv_reminder_days = $" + idx++); values.push(val); }
    }
    if (req.body.csv_reminder_enabled !== undefined) {
      updates.push("csv_reminder_enabled = $" + idx++); values.push(!!req.body.csv_reminder_enabled);
    }
    if (req.body.dashboard_widgets !== undefined && typeof req.body.dashboard_widgets === "object") {
      updates.push("dashboard_widgets = $" + idx++); values.push(JSON.stringify(req.body.dashboard_widgets));
    }
    // Per-sistant integration settings
    if (req.body.persistent_url !== undefined) {
      updates.push("persistent_url = $" + idx++); values.push(req.body.persistent_url || null);
    }
    if (req.body.persistent_webhook_secret !== undefined) {
      // Stored encrypted at rest with TOKEN_ENCRYPTION_PASSPHRASE. Empty string
      // clears the secret (NULL).
      const v = req.body.persistent_webhook_secret;
      if (v) {
        updates.push("persistent_webhook_secret_enc = pgp_sym_encrypt($" + idx++ + ", $" + idx++ + ")");
        values.push(v, ENCRYPTION_PASSPHRASE || "");
      } else {
        updates.push("persistent_webhook_secret_enc = NULL");
      }
    }
    if (req.body.persistent_webhook_enabled !== undefined) {
      updates.push("persistent_webhook_enabled = $" + idx++); values.push(!!req.body.persistent_webhook_enabled);
    }
    if (req.body.sync_notifications_enabled !== undefined) {
      updates.push("sync_notifications_enabled = $" + idx++); values.push(!!req.body.sync_notifications_enabled);
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

// GET /api/data-freshness — detailed sync timestamps for all data sources
router.get("/api/data-freshness", async (_req, res) => {
  try {
    const result = await pool.query(
      "SELECT last_auto_sync_at, last_balance_sync_at, last_txn_sync_at, insights_last_run FROM user_settings WHERE id = 1"
    );
    const s = result.rows[0] || {};
    const now = Date.now();
    function ageInfo(ts) {
      if (!ts) return { timestamp: null, age_seconds: null, stale: true };
      const age = Math.floor((now - new Date(ts).getTime()) / 1000);
      return { timestamp: ts, age_seconds: age, stale: age > 86400 };
    }
    res.json({
      transactions: ageInfo(s.last_txn_sync_at),
      balances: ageInfo(s.last_balance_sync_at),
      auto_sync: ageInfo(s.last_auto_sync_at),
      insights: ageInfo(s.insights_last_run),
    });
  } catch (err) {
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
      const rows = result.rows.map(r => `"${(r.display_name || "").replace(/"/g, '""')}",${r.amount},${r.cadence_days},"${(r.category || "").replace(/"/g, '""')}",${r.first_seen},${r.last_charged},${r.next_expected},${r.is_active}`).join("\n");
      res.setHeader("Content-Type", "text/csv");
      res.setHeader("Content-Disposition", "attachment; filename=subscriptions.csv");
      return res.send(header + rows);
    }
    const months = parseInt(req.query.months) || 12;
    const result = await pool.query(
      `SELECT t.date, COALESCE(t.merchant_name, t.name) AS merchant, t.amount, la.name AS account,
              COALESCE(pi.institution_name, te.institution_name, 'CSV') AS institution,
              COALESCE(t.user_category, t.category[1]) AS category
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

// GET /api/export/tax-report — Year-end tax deduction summary
router.get("/api/export/tax-report", async (req, res) => {
  const year = parseInt(req.query.year) || new Date().getFullYear();
  const format = req.query.format || "csv";
  try {
    const deductions = await pool.query(
      `SELECT td.*, t.date AS txn_date
       FROM tax_deductions td
       LEFT JOIN transactions t ON t.transaction_id = td.transaction_id
       WHERE td.tax_year = $1
       ORDER BY td.category, COALESCE(t.date, td.flagged_at) DESC`,
      [year]
    );

    if (format === "json") {
      // Group by category
      const byCategory = {};
      for (const d of deductions.rows) {
        if (!byCategory[d.category]) byCategory[d.category] = { items: [], total: 0 };
        byCategory[d.category].items.push(d);
        byCategory[d.category].total += parseFloat(d.amount);
      }
      const grandTotal = deductions.rows.reduce((s, d) => s + parseFloat(d.amount), 0);
      return res.json({
        tax_year: year,
        grand_total: Math.round(grandTotal * 100) / 100,
        categories: byCategory,
        item_count: deductions.rows.length,
      });
    }

    // PDF format
    if (format === "pdf") {
      try {
        const PDFDocument = require("pdfkit");
        const doc = new PDFDocument({ size: "LETTER", margins: { top: 50, bottom: 50, left: 50, right: 50 } });
        res.setHeader("Content-Type", "application/pdf");
        res.setHeader("Content-Disposition", `attachment; filename=tax_deductions_${year}.pdf`);
        doc.pipe(res);

        // Header
        doc.fontSize(20).fillColor("#d4a574").text("Perfin Tax Deduction Report", { align: "center" });
        doc.moveDown(0.3);
        doc.fontSize(12).fillColor("#888888").text(`Tax Year ${year}`, { align: "center" });
        doc.moveDown(1);

        // Group by category
        const pdfByCategory = {};
        for (const d of deductions.rows) {
          if (!pdfByCategory[d.category]) pdfByCategory[d.category] = { items: [], total: 0 };
          pdfByCategory[d.category].items.push(d);
          pdfByCategory[d.category].total += parseFloat(d.amount);
        }
        const pdfGrandTotal = deductions.rows.reduce((s, d) => s + parseFloat(d.amount), 0);

        for (const [cat, data] of Object.entries(pdfByCategory)) {
          doc.fontSize(14).fillColor("#d4a574").text(cat, { underline: true });
          doc.moveDown(0.3);
          for (const d of data.items) {
            const date = d.txn_date ? new Date(d.txn_date).toLocaleDateString() : "";
            const confirmed = d.is_confirmed ? " [Confirmed]" : "";
            doc.fontSize(10).fillColor("#cccccc")
              .text(`  ${date}  ${d.merchant}  $${parseFloat(d.amount).toFixed(2)}${confirmed}`);
          }
          doc.fontSize(11).fillColor("#ffffff").text(`  Subtotal: $${data.total.toFixed(2)}`, { align: "right" });
          doc.moveDown(0.5);
        }

        doc.moveDown(1);
        doc.fontSize(14).fillColor("#d4a574").text(`Grand Total: $${pdfGrandTotal.toFixed(2)}`, { align: "right" });
        doc.moveDown(0.5);
        doc.fontSize(9).fillColor("#666666").text(
          "This report is for informational purposes only. Consult a tax professional before filing. Generated by Perfin on " +
          new Date().toLocaleDateString() + ".",
          { align: "center" }
        );
        doc.end();
        return;
      } catch (pdfErr) {
        console.error("PDF generation error:", pdfErr.message);
        return res.status(500).json({ error: "PDF generation failed. Install pdfkit: cd teller && npm install pdfkit" });
      }
    }

    // CSV format
    const header = "Tax Year,Date,Merchant,Amount,Category,Type,Notes,Confirmed\n";
    const rows = deductions.rows.map(d =>
      `${d.tax_year},${d.txn_date || ''},` +
      `"${(d.merchant || '').replace(/"/g, '""')}",` +
      `${d.amount},"${d.category}","${d.deduction_type || ''}",` +
      `"${(d.notes || '').replace(/"/g, '""')}",${d.is_confirmed}`
    ).join("\n");

    // Add summary section
    const byCategory = {};
    for (const d of deductions.rows) {
      if (!byCategory[d.category]) byCategory[d.category] = 0;
      byCategory[d.category] += parseFloat(d.amount);
    }
    const grandTotal = deductions.rows.reduce((s, d) => s + parseFloat(d.amount), 0);
    const summary = "\n\nSUMMARY BY CATEGORY\nCategory,Total\n" +
      Object.entries(byCategory).map(([cat, total]) => `"${cat}",${total.toFixed(2)}`).join("\n") +
      `\n\nGRAND TOTAL,${grandTotal.toFixed(2)}`;

    res.setHeader("Content-Type", "text/csv");
    res.setHeader("Content-Disposition", `attachment; filename=tax_deductions_${year}.csv`);
    res.send(header + rows + summary);
  } catch (err) {
    console.error("tax report error:", err.message);
    res.status(500).json({ error: "An internal error occurred." });
  }
});

module.exports = router;
