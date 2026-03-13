// ============================================================================
// Routes: Subscriptions CRUD, Transactions, Detection, CSV Import
// ============================================================================

const express = require("express");
const router = express.Router();
const multer = require("multer");
const { parse } = require("csv-parse/sync");
const { pool, ENCRYPTION_PASSPHRASE } = require("../services/database");
const { categorizeSubscription, findCancelUrl } = require("../data/reference-data");
const { CSV_FORMATS, detectCsvFormat, parseDate, csvTransactionId } = require("../data/csv-formats");
const { detectSubscriptions } = require("../../scripts/detect-subscriptions");

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

// GET /api/subscriptions
router.get("/api/subscriptions", async (req, res) => {
  const filter = req.query.filter || "active";
  try {
    let where;
    switch (filter) {
      case "dismissed": where = "WHERE ds.is_dismissed = true AND ds.cancelled_at IS NULL"; break;
      case "cancelled": where = "WHERE ds.cancelled_at IS NOT NULL"; break;
      case "all": where = ""; break;
      default: where = "WHERE ds.is_active = true AND ds.is_dismissed = false AND ds.cancelled_at IS NULL";
    }
    const result = await pool.query(`
      SELECT ds.*,
        CASE WHEN ds.cadence_days > 0
          THEN ROUND(ds.amount * (30.0 / ds.cadence_days), 2)
          ELSE ds.amount
        END AS monthly_cost
      FROM detected_subscriptions ds
      ${where}
      ORDER BY ds.amount DESC
    `);

    const subs = result.rows.map(s => ({
      ...s,
      cancel_url: findCancelUrl(s.display_name) || findCancelUrl(s.merchant_key),
      display_category: categorizeSubscription(s.display_name),
    }));

    const active = subs.filter(s => !s.is_dismissed && !s.cancelled_at);
    const activeSubs = active.filter(s => s.category !== "utility");
    const activeUtils = active.filter(s => s.category === "utility");
    const subsMonthlyCost = activeSubs.reduce((sum, s) => sum + parseFloat(s.monthly_cost || 0), 0);
    const utilMonthlyCost = activeUtils.reduce((sum, s) => sum + parseFloat(s.monthly_cost || 0), 0);
    const totalMonthlyCost = subsMonthlyCost + utilMonthlyCost;

    res.json({
      subscriptions: subs,
      summary: {
        total_active: active.length,
        monthly_cost: Math.round(totalMonthlyCost * 100) / 100,
        yearly_cost: Math.round(totalMonthlyCost * 12 * 100) / 100,
        subscriptions_monthly: Math.round(subsMonthlyCost * 100) / 100,
        utilities_monthly: Math.round(utilMonthlyCost * 100) / 100,
        subscription_count: activeSubs.length,
        utility_count: activeUtils.length,
      },
    });
  } catch (err) {
    res.status(500).json({ error: "An internal error occurred." });
  }
});

// POST /api/subscriptions
router.post("/api/subscriptions", async (req, res) => {
  const { name, amount, cadence_days, notes } = req.body;
  if (!name || !amount || !cadence_days) {
    return res.status(400).json({ error: "name, amount, and cadence_days are required" });
  }
  try {
    const merchantKey = `manual_${name.toLowerCase().replace(/[^a-z0-9]+/g, "_")}`;
    const today = new Date().toISOString().slice(0, 10);
    const nextExpected = new Date(Date.now() + cadence_days * 86400000).toISOString().slice(0, 10);

    const result = await pool.query(
      `INSERT INTO detected_subscriptions
         (merchant_key, display_name, amount, cadence_days, first_seen, last_charged,
          next_expected, is_active, is_new, source, notes)
       VALUES ($1, $2, $3, $4, $5, $5, $6, true, false, 'manual', $7)
       ON CONFLICT (merchant_key, cadence_days)
       DO UPDATE SET
         display_name = EXCLUDED.display_name,
         amount = EXCLUDED.amount,
         notes = EXCLUDED.notes,
         is_active = true,
         cancelled_at = NULL,
         updated_at = now()
       RETURNING *`,
      [merchantKey, name, amount, cadence_days, today, nextExpected, notes || null]
    );
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: "An internal error occurred." });
  }
});

// PATCH /api/subscriptions/:id/dismiss
router.patch("/api/subscriptions/:id/dismiss", async (req, res) => {
  try {
    const result = await pool.query(
      `UPDATE detected_subscriptions SET is_dismissed = true, updated_at = now()
       WHERE id = $1 RETURNING *`,
      [req.params.id]
    );
    if (!result.rows.length) return res.status(404).json({ error: "Not found" });
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: "An internal error occurred." });
  }
});

// PATCH /api/subscriptions/:id/undismiss
router.patch("/api/subscriptions/:id/undismiss", async (req, res) => {
  try {
    const result = await pool.query(
      `UPDATE detected_subscriptions SET is_dismissed = false, updated_at = now()
       WHERE id = $1 RETURNING *`,
      [req.params.id]
    );
    if (!result.rows.length) return res.status(404).json({ error: "Not found" });
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: "An internal error occurred." });
  }
});

// PATCH /api/subscriptions/:id/cancel
router.patch("/api/subscriptions/:id/cancel", async (req, res) => {
  try {
    const result = await pool.query(
      `UPDATE detected_subscriptions
       SET cancelled_at = now(), cancel_confirmed = true, is_active = false, updated_at = now()
       WHERE id = $1 RETURNING *`,
      [req.params.id]
    );
    if (!result.rows.length) return res.status(404).json({ error: "Not found" });
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: "An internal error occurred." });
  }
});

// PATCH /api/subscriptions/:id/uncancel
router.patch("/api/subscriptions/:id/uncancel", async (req, res) => {
  try {
    const result = await pool.query(
      `UPDATE detected_subscriptions
       SET cancelled_at = NULL, cancel_confirmed = false, is_active = true, updated_at = now()
       WHERE id = $1 RETURNING *`,
      [req.params.id]
    );
    if (!result.rows.length) return res.status(404).json({ error: "Not found" });
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: "An internal error occurred." });
  }
});

// PATCH /api/subscriptions/:id/category
router.patch("/api/subscriptions/:id/category", async (req, res) => {
  const { category } = req.body;
  if (!category || !["subscription", "utility"].includes(category)) {
    return res.status(400).json({ error: "category must be 'subscription' or 'utility'" });
  }
  try {
    const result = await pool.query(
      "UPDATE detected_subscriptions SET category = $1, updated_at = now() WHERE id = $2 RETURNING *",
      [category, req.params.id]
    );
    if (!result.rows.length) return res.status(404).json({ error: "Not found" });
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: "An internal error occurred." });
  }
});

// GET /api/transactions
router.get("/api/transactions", async (req, res) => {
  const months = parseInt(req.query.months) || 6;
  const limit = Math.min(parseInt(req.query.limit) || 10000, 50000);
  const offset = parseInt(req.query.offset) || 0;

  try {
    const result = await pool.query(`
      SELECT
        t.transaction_id,
        t.date,
        COALESCE(t.merchant_name, t.name) AS merchant,
        t.amount,
        la.name AS account_name,
        la.type AS account_type,
        COALESCE(pi.institution_name, te.institution_name, 'CSV Import') AS institution_name,
        t.category[1] AS category,
        t.personal_finance_category->>'primary' AS pfc_primary,
        t.personal_finance_category->>'detailed' AS pfc_detailed,
        t.pending
      FROM transactions t
      JOIN linked_accounts la ON la.account_id = t.account_id
      LEFT JOIN plaid_items pi ON pi.id = la.plaid_item_id
      LEFT JOIN teller_enrollments te ON te.id = la.teller_enrollment_id
      WHERE t.pending = false
        AND t.date >= CURRENT_DATE - make_interval(months => $1)
      ORDER BY t.date DESC
      LIMIT $2 OFFSET $3
    `, [months, limit, offset]);

    const countResult = await pool.query(`
      SELECT COUNT(*) AS total
      FROM transactions
      WHERE pending = false
        AND date >= CURRENT_DATE - make_interval(months => $1)
    `, [months]);

    res.json({
      transactions: result.rows,
      total: parseInt(countResult.rows[0].total),
      months,
      limit,
      offset,
    });
  } catch (err) {
    res.status(500).json({ error: "An internal error occurred." });
  }
});

// POST /api/detect
router.post("/api/detect", async (_req, res) => {
  try {
    const detected = await detectSubscriptions(pool);
    for (const sub of detected) {
      const cat = categorizeSubscription(sub.display_name);
      const dbCategory = cat === "utility" ? "utility" : "subscription";
      await pool.query(
        "UPDATE detected_subscriptions SET category = $1 WHERE merchant_key = $2 AND category = 'subscription' AND category != $1",
        [dbCategory, sub.merchant_key]
      );
    }
    res.json({ detected_count: detected.length, subscriptions: detected });
  } catch (err) {
    console.error("Detection error:", err.message);
    res.status(500).json({ error: "An internal error occurred." });
  }
});

// POST /api/import-csv
router.post("/api/import-csv", upload.single("file"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "No file uploaded" });

  const institution = req.body.institution || "CSV Import";
  const accountLabel = req.body.account_label || `${institution} Account`;

  try {
    const content = req.file.buffer.toString("utf-8");
    const records = parse(content, { columns: true, skip_empty_lines: true, trim: true, bom: true });
    if (!records.length) return res.status(400).json({ error: "CSV file is empty or unparseable" });

    const headers = Object.keys(records[0]);
    const formatName = detectCsvFormat(headers);
    const fmt = CSV_FORMATS[formatName];

    const client = await pool.connect();
    try {
      await client.query("BEGIN");

      const virtualEnrollId = `csv_${institution.toLowerCase().replace(/[^a-z0-9]+/g, "_")}`;
      const virtualAccountId = `csv_${accountLabel.toLowerCase().replace(/[^a-z0-9]+/g, "_")}`;

      await client.query(
        `INSERT INTO plaid_items (item_id, institution_name, access_token_enc, status)
         VALUES ($1, $2, pgp_sym_encrypt('csv_no_token', $3), 'CSV')
         ON CONFLICT (item_id) DO NOTHING`,
        [virtualEnrollId, institution, ENCRYPTION_PASSPHRASE]
      );

      const piRow = await client.query(`SELECT id FROM plaid_items WHERE item_id = $1`, [virtualEnrollId]);

      await client.query(
        `INSERT INTO linked_accounts (plaid_item_id, account_id, name, type, subtype)
         VALUES ($1, $2, $3, 'csv', 'import')
         ON CONFLICT (account_id) DO NOTHING`,
        [piRow.rows[0].id, virtualAccountId, accountLabel]
      );

      let imported = 0;
      let skipped = 0;

      for (let i = 0; i < records.length; i++) {
        const row = records[i];
        let parsed;
        try {
          parsed = fmt.parse(row, headers);
        } catch { skipped++; continue; }

        const date = parseDate(parsed.date);
        if (!date || isNaN(parsed.amount) || parsed.amount === 0) { skipped++; continue; }

        const txnId = csvTransactionId(accountLabel, date, parsed.amount, parsed.merchant_name, i);

        const result = await client.query(
          `INSERT INTO transactions (account_id, transaction_id, amount, date, merchant_name, name, category, pending)
           VALUES ($1, $2, $3, $4, $5, $6, $7, false)
           ON CONFLICT (transaction_id) DO NOTHING`,
          [
            virtualAccountId, txnId, parsed.amount, date,
            parsed.merchant_name || null, parsed.merchant_name || "",
            parsed.category ? `{${parsed.category}}` : null,
          ]
        );
        if (result.rowCount > 0) imported++;
        else skipped++;
      }

      await client.query(
        `INSERT INTO csv_imports (filename, institution, account_label, rows_imported, rows_skipped)
         VALUES ($1, $2, $3, $4, $5)`,
        [req.file.originalname, institution, accountLabel, imported, skipped]
      );

      await client.query("COMMIT");

      res.json({
        format_detected: formatName,
        rows_imported: imported,
        rows_skipped: skipped,
        account_label: accountLabel,
      });
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  } catch (err) {
    console.error("CSV import error:", err.message);
    res.status(500).json({ error: "An internal error occurred." });
  }
});

// GET /api/csv-imports
router.get("/api/csv-imports", async (_req, res) => {
  try {
    const result = await pool.query(
      `SELECT * FROM csv_imports ORDER BY imported_at DESC LIMIT 50`
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: "An internal error occurred." });
  }
});

// POST /api/cleanup
router.post("/api/cleanup", async (_req, res) => {
  try {
    const txnResult = await pool.query(
      `DELETE FROM transactions WHERE date < (CURRENT_DATE - INTERVAL '18 months') RETURNING transaction_id`
    );
    const subResult = await pool.query(
      `DELETE FROM detected_subscriptions WHERE is_active = false AND updated_at < (CURRENT_DATE - INTERVAL '6 months') RETURNING merchant_key`
    );
    res.json({
      transactions_pruned: txnResult.rowCount,
      subscriptions_pruned: subResult.rowCount,
    });
  } catch (err) {
    res.status(500).json({ error: "An internal error occurred." });
  }
});

// GET /api/forecast — predict recurring charges for the next 30 days
router.get("/api/forecast", async (req, res) => {
  const days = Math.min(Math.max(parseInt(req.query.days) || 30, 7), 90);
  try {
    const result = await pool.query(
      `SELECT display_name, amount, cadence_days, next_expected, category
       FROM detected_subscriptions
       WHERE is_active = true AND is_dismissed = false AND cancelled_at IS NULL
         AND next_expected IS NOT NULL
       ORDER BY next_expected ASC`
    );

    const now = new Date();
    const endDate = new Date(now.getTime() + days * 86400000);
    const forecast = [];
    let totalExpected = 0;

    for (const sub of result.rows) {
      const amount = parseFloat(sub.amount);
      const cadence = parseInt(sub.cadence_days);
      let nextDate = new Date(sub.next_expected);

      // If next_expected is in the past, advance it
      while (nextDate < now) {
        nextDate = new Date(nextDate.getTime() + cadence * 86400000);
      }

      // Generate all occurrences within the forecast window
      while (nextDate <= endDate) {
        const daysAway = Math.ceil((nextDate - now) / 86400000);
        forecast.push({
          name: sub.display_name,
          amount,
          date: nextDate.toISOString().split("T")[0],
          days_away: daysAway,
          category: sub.category,
        });
        totalExpected += amount;
        nextDate = new Date(nextDate.getTime() + cadence * 86400000);
      }
    }

    // Sort by date
    forecast.sort((a, b) => a.date.localeCompare(b.date));

    // Group by week
    const byWeek = [];
    let weekTotal = 0;
    let weekStart = null;
    for (const f of forecast) {
      const weekNum = Math.floor(f.days_away / 7);
      if (weekStart === null || weekNum !== weekStart) {
        if (weekStart !== null) byWeek.push({ week: weekStart, total: weekTotal });
        weekStart = weekNum;
        weekTotal = 0;
      }
      weekTotal += f.amount;
    }
    if (weekStart !== null) byWeek.push({ week: weekStart, total: weekTotal });

    res.json({
      forecast_days: days,
      total_expected: Math.round(totalExpected * 100) / 100,
      charge_count: forecast.length,
      charges: forecast,
      by_week: byWeek,
    });
  } catch (err) {
    res.status(500).json({ error: "An internal error occurred." });
  }
});

module.exports = router;
