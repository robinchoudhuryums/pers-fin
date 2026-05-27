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
const { detectRecurringTransfers } = require("../../scripts/detect-transfers");
const { INCOME_PREDICATE } = require("../services/financial-queries");

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
  const parsedAmount = parseFloat(amount);
  const parsedCadence = parseInt(cadence_days);
  if (isNaN(parsedAmount) || parsedAmount <= 0) return res.status(400).json({ error: "amount must be a positive number" });
  if (isNaN(parsedCadence) || parsedCadence < 1) return res.status(400).json({ error: "cadence_days must be a positive integer" });
  try {
    const merchantKey = `manual_${name.toLowerCase().replace(/[^a-z0-9]+/g, "_")}`;
    const today = new Date().toISOString().slice(0, 10);
    const nextExpected = new Date(Date.now() + parsedCadence * 86400000).toISOString().slice(0, 10);

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
      [merchantKey, name, parsedAmount, parsedCadence, today, nextExpected, notes || null]
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

// GET /api/transactions/search — Full-text search with filters
router.get("/api/transactions/search", async (req, res) => {
  const { q, category, account_id, min_amount, max_amount, start_date, end_date, limit: rawLimit, offset: rawOffset } = req.query;
  const limit = Math.min(parseInt(rawLimit) || 100, 500);
  const offset = parseInt(rawOffset) || 0;

  try {
    const conditions = ["t.pending = false"];
    const values = [];
    let idx = 1;

    if (q) {
      conditions.push(`(LOWER(COALESCE(t.user_merchant_name, t.merchant_name, t.name, '')) LIKE $${idx})`);
      values.push("%" + q.toLowerCase() + "%");
      idx++;
    }
    if (category) {
      // Honor user_category override so manually-recategorized rows surface
      // under the user's chosen category, not Teller's stale value.
      conditions.push(`COALESCE(t.user_category, t.category[1]) = $${idx}`);
      values.push(category);
      idx++;
    }
    if (account_id) {
      conditions.push(`t.account_id = $${idx}`);
      values.push(account_id);
      idx++;
    }
    if (min_amount) {
      conditions.push(`ABS(t.amount) >= $${idx}`);
      values.push(parseFloat(min_amount));
      idx++;
    }
    if (max_amount) {
      conditions.push(`ABS(t.amount) <= $${idx}`);
      values.push(parseFloat(max_amount));
      idx++;
    }
    if (start_date) {
      conditions.push(`t.date >= $${idx}`);
      values.push(start_date);
      idx++;
    }
    if (end_date) {
      conditions.push(`t.date <= $${idx}`);
      values.push(end_date);
      idx++;
    }

    const where = conditions.length ? "WHERE " + conditions.join(" AND ") : "";

    const [result, countResult] = await Promise.all([
      pool.query(`
        SELECT t.transaction_id, t.date, COALESCE(t.user_merchant_name, t.merchant_name, t.name) AS merchant, t.user_notes, t.is_reimbursed,
               t.amount, la.name AS account_name, la.type AS account_type,
               COALESCE(pi.institution_name, te.institution_name, la.institution_name_manual, 'CSV Import') AS institution_name,
               COALESCE(t.user_category, t.category[1]) AS category, t.logo_url, t.pending
        FROM transactions t
        JOIN linked_accounts la ON la.account_id = t.account_id
        LEFT JOIN plaid_items pi ON pi.id = la.plaid_item_id
        LEFT JOIN teller_enrollments te ON te.id = la.teller_enrollment_id
        ${where}
        ORDER BY t.date DESC
        LIMIT $${idx} OFFSET $${idx + 1}
      `, [...values, limit, offset]),
      pool.query(`SELECT COUNT(*) AS total FROM transactions t ${where}`, values),
    ]);

    res.json({
      transactions: result.rows,
      total: parseInt(countResult.rows[0].total),
      limit, offset,
    });
  } catch (err) {
    console.error("transaction search error:", err.message);
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
        COALESCE(t.user_merchant_name, t.merchant_name, t.name) AS merchant,
        t.user_notes,
        t.is_reimbursed,
        t.amount,
        la.name AS account_name,
        la.type AS account_type,
        COALESCE(pi.institution_name, te.institution_name, 'CSV Import') AS institution_name,
        COALESCE(t.user_category, t.category[1]) AS category,
        t.personal_finance_category->>'primary' AS pfc_primary,
        t.personal_finance_category->>'detailed' AS pfc_detailed,
        t.logo_url,
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

// runSubscriptionDetection — orchestration extracted from POST /api/detect so
// the scheduler can invoke detection in-process. Returns the same shape the
// HTTP handler used to send: { detected_count, subscriptions }.
async function runSubscriptionDetection() {
  const detected = await detectSubscriptions(pool);
  for (const sub of detected) {
    const cat = categorizeSubscription(sub.display_name);
    const dbCategory = cat === "utility" ? "utility" : "subscription";
    // Only promote 'subscription' → 'utility' on re-detection. The WHERE
    // clause's `category = 'subscription'` guard intentionally preserves
    // any user-set classification: a row already marked 'utility' (either
    // by an earlier auto-detect or via PATCH /api/subscriptions/:id/category)
    // is never re-flipped, even if categorizeSubscription happens to
    // re-classify the merchant differently on a later run.
    if (dbCategory !== "subscription") {
      await pool.query(
        "UPDATE detected_subscriptions SET category = $1 WHERE merchant_key = $2 AND category = 'subscription'",
        [dbCategory, sub.merchant_key]
      );
    }
  }
  return { detected_count: detected.length, subscriptions: detected };
}

// POST /api/detect — HTTP wrapper around runSubscriptionDetection().
router.post("/api/detect", async (_req, res) => {
  try {
    res.json(await runSubscriptionDetection());
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
    let records = parse(content, { columns: true, skip_empty_lines: true, trim: true, bom: true });
    if (!records.length) return res.status(400).json({ error: "CSV file is empty or unparseable" });

    const headers = Object.keys(records[0]);
    const formatName = detectCsvFormat(headers);
    const fmt = CSV_FORMATS[formatName];
    if (!fmt) return res.status(400).json({ error: `Unrecognized CSV format: ${formatName}` });

    // Headerless formats (Wells Fargo) need a re-parse with explicit columns so
    // each record is keyed by the declared column names rather than the values
    // that columns:true mis-promoted to headers.
    if (fmt.headerless && fmt.columns) {
      records = parse(content, { columns: fmt.columns, skip_empty_lines: true, trim: true, bom: true });
    }

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
      if (!piRow.rows.length) throw new Error("Failed to create CSV import record");

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
          // For headerless formats, row is keyed by fmt.columns after the re-parse above.
          parsed = fmt.parse(row, fmt.headerless ? fmt.columns : headers);
        } catch { skipped++; continue; }

        const date = parseDate(parsed.date);
        if (!date || isNaN(parsed.amount) || parsed.amount === 0) { skipped++; continue; }

        const txnId = csvTransactionId(accountLabel, date, parsed.amount, parsed.merchant_name);

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

      // Auto-update manual account balance if institution matches
      try {
        const manualAcct = await client.query(
          `SELECT id, type FROM linked_accounts
           WHERE is_manual = true
             AND (LOWER(institution_name_manual) = LOWER($1) OR LOWER(name) LIKE '%' || LOWER($1) || '%')
           LIMIT 1`,
          [institution]
        );
        if (manualAcct.rows.length) {
          // Calculate balance from most recent transactions
          const balanceResult = await client.query(
            `SELECT SUM(amount) AS net FROM transactions
             WHERE account_id = $1 AND pending = false`,
            [virtualAccountId]
          );
          const netAmount = parseFloat(balanceResult.rows[0]?.net || 0);
          // For credit cards, the balance is the sum of debits (positive = spent)
          const balance = manualAcct.rows[0].type === 'credit' ? Math.abs(netAmount) : -netAmount;
          await client.query(
            `UPDATE linked_accounts SET current_balance = $1, balance_updated_at = now() WHERE id = $2`,
            [balance, manualAcct.rows[0].id]
          );
        }
      } catch (e) { /* non-critical */ }

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

// GET /api/bill-calendar — Monthly calendar of expected charges
router.get("/api/bill-calendar", async (req, res) => {
  const year = parseInt(req.query.year) || new Date().getFullYear();
  const month = parseInt(req.query.month) || new Date().getMonth() + 1;
  try {
    const daysInMonth = new Date(year, month, 0).getDate();
    const startDate = `${year}-${String(month).padStart(2, '0')}-01`;
    const endDate = `${year}-${String(month).padStart(2, '0')}-${String(daysInMonth).padStart(2, '0')}`;

    // Get active subscriptions. Include `id` so each event can carry its own
    // bill_id at insertion time — earlier code SELECTed without id and then
    // back-patched bill_source via an O(days × subs × events) loop matching by
    // display_name (which silently mistagged manual bills sharing a name and
    // left bill_id undefined when sub.id was missing from the SELECT).
    const subs = await pool.query(`
      SELECT id, display_name, amount, cadence_days, next_expected, category
      FROM detected_subscriptions
      WHERE is_active = true AND is_dismissed = false AND cancelled_at IS NULL
        AND next_expected IS NOT NULL
    `);

    // Place subscriptions on calendar days
    const calendar = {};
    for (let d = 1; d <= daysInMonth; d++) calendar[d] = [];

    for (const sub of subs.rows) {
      const amount = parseFloat(sub.amount);
      const cadence = parseInt(sub.cadence_days);
      let nextDate = new Date(sub.next_expected);

      // Advance past dates
      const monthStart = new Date(startDate);
      while (nextDate < monthStart) {
        nextDate = new Date(nextDate.getTime() + cadence * 86400000);
      }

      // Place within this month — set bill_source/bill_id at insertion so
      // payment-tracking has correct identity from the start.
      const monthEnd = new Date(endDate);
      while (nextDate <= monthEnd) {
        const day = nextDate.getDate();
        calendar[day].push({
          name: sub.display_name,
          amount,
          category: sub.category,
          bill_source: "subscription",
          bill_id: sub.id,
        });
        nextDate = new Date(nextDate.getTime() + cadence * 86400000);
      }
    }

    // Manual bills
    const manualBills = await pool.query(
      "SELECT * FROM manual_bills WHERE is_active = true"
    );
    for (const bill of manualBills.rows) {
      const amount = parseFloat(bill.amount);
      const day = Math.min(bill.due_day, daysInMonth);
      // Check if this bill applies to this month based on cadence
      const billCreated = new Date(bill.created_at);
      const monthDiff = (year - billCreated.getFullYear()) * 12 + (month - 1 - billCreated.getMonth());
      const applies = bill.cadence === "monthly" ||
        (bill.cadence === "quarterly" && monthDiff % 3 === 0) ||
        (bill.cadence === "yearly" && monthDiff % 12 === 0);
      if (applies) {
        calendar[day].push({
          name: bill.name,
          amount,
          category: bill.category,
          bill_source: "manual",
          bill_id: bill.id,
        });
      }
    }

    // Load payments for this month to mark paid bills
    const payments = await pool.query(
      "SELECT * FROM bill_payments WHERE paid_date >= $1 AND paid_date <= $2",
      [startDate, endDate]
    );
    const paidSet = new Set();
    for (const p of payments.rows) {
      paidSet.add(p.bill_source + ":" + p.bill_id + ":" + p.paid_date);
    }
    // Mark events as paid
    for (let d = 1; d <= daysInMonth; d++) {
      for (const ev of calendar[d]) {
        if (ev.bill_source && ev.bill_id) {
          const dateStr = `${year}-${String(month).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
          ev.is_paid = paidSet.has(ev.bill_source + ":" + ev.bill_id + ":" + dateStr);
        }
      }
    }

    // Income deposits (detected from recent patterns) — uses the shared
    // INCOME_PREDICATE from services/financial-queries.js so the calendar
    // shows the same income events the cash-flow forecast and savings-rate
    // dashboards use. Previously a narrower inline regex meant some payroll
    // events showed up only on the calendar, not in cash-flow (and vice versa).
    const incomeResult = await pool.query(`
      SELECT COALESCE(merchant_name, name) AS source,
             ABS(amount) AS amount,
             ROUND(AVG(EXTRACT(DAY FROM date::timestamp))) AS typical_day
      FROM transactions
      WHERE amount < 0 AND pending = false
        AND date >= CURRENT_DATE - INTERVAL '3 months'
        AND ${INCOME_PREDICATE}
      GROUP BY COALESCE(merchant_name, name), ABS(amount)
      HAVING COUNT(*) >= 2
    `);

    for (const inc of incomeResult.rows) {
      const day = parseInt(inc.typical_day);
      if (day >= 1 && day <= daysInMonth) {
        calendar[day].push({
          name: inc.source,
          amount: -parseFloat(inc.amount),
          category: "income",
          is_income: true,
        });
      }
    }

    // Calculate daily totals
    let totalBills = 0;
    let totalIncome = 0;
    const days = [];
    for (let d = 1; d <= daysInMonth; d++) {
      const dayBills = calendar[d].filter(e => !e.is_income).reduce((s, e) => s + e.amount, 0);
      const dayIncome = calendar[d].filter(e => e.is_income).reduce((s, e) => s + Math.abs(e.amount), 0);
      totalBills += dayBills;
      totalIncome += dayIncome;
      days.push({
        day: d,
        date: `${year}-${String(month).padStart(2, '0')}-${String(d).padStart(2, '0')}`,
        events: calendar[d],
        total_bills: Math.round(dayBills * 100) / 100,
        total_income: Math.round(dayIncome * 100) / 100,
      });
    }

    const monthNames = ['January','February','March','April','May','June','July','August','September','October','November','December'];
    res.json({
      year, month,
      month_name: monthNames[month - 1],
      days_in_month: daysInMonth,
      total_bills: Math.round(totalBills * 100) / 100,
      total_income: Math.round(totalIncome * 100) / 100,
      net: Math.round((totalIncome - totalBills) * 100) / 100,
      days,
    });
  } catch (err) {
    console.error("bill-calendar error:", err.message);
    res.status(500).json({ error: "An internal error occurred." });
  }
});

// GET /api/transactions/duplicates — Find potential duplicate transactions across sources
router.get("/api/transactions/duplicates", async (_req, res) => {
  try {
    const result = await pool.query(`
      SELECT t1.transaction_id AS id1, t2.transaction_id AS id2,
             t1.date, COALESCE(t1.merchant_name, t1.name) AS merchant,
             t1.amount,
             la1.name AS account1, la2.name AS account2,
             COALESCE(pi1.institution_name, te1.institution_name, la1.institution_name_manual, 'CSV') AS inst1,
             COALESCE(pi2.institution_name, te2.institution_name, la2.institution_name_manual, 'CSV') AS inst2
      FROM transactions t1
      JOIN transactions t2 ON t1.date = t2.date
        AND t1.amount = t2.amount
        AND t1.transaction_id < t2.transaction_id
        AND t1.account_id != t2.account_id
        AND ABS(t1.amount) > 0
      JOIN linked_accounts la1 ON la1.account_id = t1.account_id
      JOIN linked_accounts la2 ON la2.account_id = t2.account_id
      LEFT JOIN plaid_items pi1 ON pi1.id = la1.plaid_item_id
      LEFT JOIN teller_enrollments te1 ON te1.id = la1.teller_enrollment_id
      LEFT JOIN plaid_items pi2 ON pi2.id = la2.plaid_item_id
      LEFT JOIN teller_enrollments te2 ON te2.id = la2.teller_enrollment_id
      WHERE t1.pending = false AND t2.pending = false
        AND t1.date >= CURRENT_DATE - INTERVAL '6 months'
        AND (LOWER(COALESCE(t1.merchant_name, t1.name, '')) = LOWER(COALESCE(t2.merchant_name, t2.name, ''))
             OR SIMILARITY(LOWER(COALESCE(t1.merchant_name, t1.name, '')), LOWER(COALESCE(t2.merchant_name, t2.name, ''))) > 0.6)
      ORDER BY t1.date DESC
      LIMIT 100
    `);

    res.json({
      duplicates: result.rows,
      count: result.rows.length,
    });
  } catch (err) {
    // Fallback without SIMILARITY (pg_trgm might not be installed)
    try {
      const result = await pool.query(`
        SELECT t1.transaction_id AS id1, t2.transaction_id AS id2,
               t1.date, COALESCE(t1.merchant_name, t1.name) AS merchant,
               t1.amount,
               la1.name AS account1, la2.name AS account2
        FROM transactions t1
        JOIN transactions t2 ON t1.date = t2.date
          AND t1.amount = t2.amount
          AND t1.transaction_id < t2.transaction_id
          AND t1.account_id != t2.account_id
        JOIN linked_accounts la1 ON la1.account_id = t1.account_id
        JOIN linked_accounts la2 ON la2.account_id = t2.account_id
        WHERE t1.pending = false AND t2.pending = false
          AND t1.date >= CURRENT_DATE - INTERVAL '6 months'
          AND LOWER(COALESCE(t1.merchant_name, t1.name, '')) = LOWER(COALESCE(t2.merchant_name, t2.name, ''))
        ORDER BY t1.date DESC
        LIMIT 100
      `);
      res.json({ duplicates: result.rows, count: result.rows.length });
    } catch (err2) {
      console.error("duplicates error:", err2.message);
      res.status(500).json({ error: "An internal error occurred." });
    }
  }
});

// PATCH /api/transactions/:id — user overrides (merchant_name, notes, is_reimbursed).
// User edits are stored in `user_*` columns so a subsequent sync from Teller
// does not clobber them. `merchant_name` in the PATCH body writes to
// `user_merchant_name`; the raw `merchant_name` column keeps Teller's value.
router.patch("/api/transactions/:id", async (req, res) => {
  const { merchant_name, notes, is_reimbursed } = req.body;
  const updates = []; const values = []; let idx = 1;
  if (merchant_name !== undefined) {
    const v = typeof merchant_name === "string" ? merchant_name.trim() : null;
    updates.push("user_merchant_name = $" + idx++); values.push(v || null);
  }
  if (notes !== undefined) {
    const v = typeof notes === "string" ? notes : null;
    updates.push("user_notes = $" + idx++); values.push(v || null);
  }
  if (is_reimbursed !== undefined) {
    const flag = !!is_reimbursed;
    updates.push("is_reimbursed = $" + idx++); values.push(flag);
    if (flag) {
      updates.push("reimbursed_at = now()");
    } else {
      updates.push("reimbursed_at = $" + idx++); values.push(null);
    }
  }
  if (!updates.length) return res.status(400).json({ error: "No valid fields to update" });
  values.push(req.params.id);
  try {
    const result = await pool.query(
      "UPDATE transactions SET " + updates.join(", ") + " WHERE transaction_id = $" + idx + " RETURNING transaction_id, user_merchant_name, user_notes, is_reimbursed, reimbursed_at",
      values
    );
    if (!result.rows.length) return res.status(404).json({ error: "Transaction not found" });
    res.json(result.rows[0]);
  } catch (err) {
    console.error("patch transaction error:", err.message);
    res.status(500).json({ error: "An internal error occurred." });
  }
});

// GET /api/transactions/:id/splits — list the splits for a transaction (if any)
router.get("/api/transactions/:id/splits", async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT id, parent_transaction_id, amount, category, merchant_name, notes, created_at FROM transaction_splits WHERE parent_transaction_id = $1 ORDER BY id",
      [req.params.id]
    );
    res.json({ splits: result.rows });
  } catch (err) {
    res.status(500).json({ error: "An internal error occurred." });
  }
});

// POST /api/transactions/:id/splits — replace the splits for a transaction.
// Body: { splits: [{ amount, category, merchant_name, notes }, ...] }
// All splits must sum (±$0.01) to the parent transaction's amount; otherwise
// we 400 rather than silently accepting inconsistent data. Posting with an
// empty array clears existing splits (equivalent to DELETE below).
router.post("/api/transactions/:id/splits", async (req, res) => {
  const { splits } = req.body;
  if (!Array.isArray(splits)) return res.status(400).json({ error: "splits array is required" });
  if (splits.length > 20) return res.status(400).json({ error: "Max 20 splits per transaction" });
  try {
    const txn = await pool.query("SELECT amount, pending FROM transactions WHERE transaction_id = $1", [req.params.id]);
    if (!txn.rows.length) return res.status(404).json({ error: "Transaction not found" });
    if (txn.rows[0].pending) return res.status(400).json({ error: "Cannot split a pending transaction" });
    const parentAmount = parseFloat(txn.rows[0].amount);

    if (splits.length > 0) {
      let sum = 0;
      for (const s of splits) {
        const n = parseFloat(s.amount);
        if (isNaN(n) || n <= 0) return res.status(400).json({ error: "Each split amount must be a positive number" });
        sum += n;
      }
      if (Math.abs(sum - parentAmount) > 0.011) {
        return res.status(400).json({
          error: `Splits sum to $${sum.toFixed(2)} but parent transaction is $${parentAmount.toFixed(2)} — must match within $0.01`,
        });
      }
    }

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("DELETE FROM transaction_splits WHERE parent_transaction_id = $1", [req.params.id]);
      for (const s of splits) {
        await client.query(
          `INSERT INTO transaction_splits (parent_transaction_id, amount, category, merchant_name, notes)
           VALUES ($1, $2, $3, $4, $5)`,
          [
            req.params.id,
            parseFloat(s.amount),
            s.category ? String(s.category) : null,
            s.merchant_name ? String(s.merchant_name) : null,
            s.notes ? String(s.notes) : null,
          ]
        );
      }
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }

    const saved = await pool.query(
      "SELECT id, parent_transaction_id, amount, category, merchant_name, notes, created_at FROM transaction_splits WHERE parent_transaction_id = $1 ORDER BY id",
      [req.params.id]
    );
    res.json({ splits: saved.rows });
  } catch (err) {
    console.error("split transaction error:", err.message);
    res.status(500).json({ error: "An internal error occurred." });
  }
});

// DELETE /api/transactions/:id/splits — remove all splits, revert to parent-row aggregation
router.delete("/api/transactions/:id/splits", async (req, res) => {
  try {
    const result = await pool.query(
      "DELETE FROM transaction_splits WHERE parent_transaction_id = $1 RETURNING id",
      [req.params.id]
    );
    res.json({ deleted: result.rowCount });
  } catch (err) {
    res.status(500).json({ error: "An internal error occurred." });
  }
});

// DELETE /api/transactions/:id — Delete a specific transaction (for dedup)
router.delete("/api/transactions/:id", async (req, res) => {
  try {
    const result = await pool.query(
      "DELETE FROM transactions WHERE transaction_id = $1 RETURNING transaction_id",
      [req.params.id]
    );
    if (!result.rows.length) return res.status(404).json({ error: "Transaction not found" });
    res.json({ deleted: true, transaction_id: req.params.id });
  } catch (err) {
    console.error("delete transaction error:", err.message);
    res.status(500).json({ error: "An internal error occurred." });
  }
});

// ============================================================================
// Recurring Transfers — detection and management
// ============================================================================

// GET /api/recurring-transfers — list detected recurring transfers
router.get("/api/recurring-transfers", async (req, res) => {
  try {
    const filter = req.query.filter || "active";
    let where = "WHERE rt.is_active = true AND rt.is_dismissed = false";
    if (filter === "dismissed") where = "WHERE rt.is_dismissed = true";
    else if (filter === "all") where = "";

    const result = await pool.query(
      `SELECT rt.*,
              ROUND(rt.amount * (30.0 / rt.cadence_days), 2) AS monthly_equivalent
       FROM recurring_transfers rt
       ${where}
       ORDER BY rt.amount DESC`
    );
    const totalMonthly = result.rows.reduce((s, r) => {
      if (!r.is_active || r.is_dismissed) return s;
      return s + parseFloat(r.monthly_equivalent || 0);
    }, 0);
    res.json({
      transfers: result.rows,
      total_monthly: Math.round(totalMonthly * 100) / 100,
      count: result.rows.length,
    });
  } catch (err) {
    console.error("recurring-transfers list error:", err.message);
    res.status(500).json({ error: "An internal error occurred." });
  }
});

// POST /api/detect-transfers — run recurring transfer detection
router.post("/api/detect-transfers", async (_req, res) => {
  try {
    const detected = await detectRecurringTransfers(pool);
    res.json({ detected_count: detected.length, transfers: detected });
  } catch (err) {
    console.error("Transfer detection error:", err.message);
    res.status(500).json({ error: "An internal error occurred." });
  }
});

// PATCH /api/recurring-transfers/:id/dismiss — dismiss a recurring transfer
router.patch("/api/recurring-transfers/:id/dismiss", async (req, res) => {
  try {
    const result = await pool.query(
      "UPDATE recurring_transfers SET is_dismissed = true, updated_at = now() WHERE id = $1 RETURNING *",
      [req.params.id]
    );
    if (!result.rows.length) return res.status(404).json({ error: "Not found" });
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: "An internal error occurred." });
  }
});

// PATCH /api/recurring-transfers/:id/undismiss — restore a dismissed transfer
router.patch("/api/recurring-transfers/:id/undismiss", async (req, res) => {
  try {
    const result = await pool.query(
      "UPDATE recurring_transfers SET is_dismissed = false, updated_at = now() WHERE id = $1 RETURNING *",
      [req.params.id]
    );
    if (!result.rows.length) return res.status(404).json({ error: "Not found" });
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: "An internal error occurred." });
  }
});

// PATCH /api/recurring-transfers/:id/type — update transfer type classification
router.patch("/api/recurring-transfers/:id/type", async (req, res) => {
  const { transfer_type } = req.body;
  const validTypes = ["peer_transfer", "bill_payment", "savings", "investment", "internal", "other"];
  if (!transfer_type || !validTypes.includes(transfer_type)) {
    return res.status(400).json({ error: `transfer_type must be one of: ${validTypes.join(", ")}` });
  }
  try {
    const result = await pool.query(
      "UPDATE recurring_transfers SET transfer_type = $1, updated_at = now() WHERE id = $2 RETURNING *",
      [transfer_type, req.params.id]
    );
    if (!result.rows.length) return res.status(404).json({ error: "Not found" });
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: "An internal error occurred." });
  }
});

// ============================================================================
// Manual Bills — user-created expected charges for the calendar
// ============================================================================

// GET /api/manual-bills — list all manual bills
router.get("/api/manual-bills", async (_req, res) => {
  try {
    const result = await pool.query(
      "SELECT * FROM manual_bills WHERE is_active = true ORDER BY due_day, name"
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: "An internal error occurred." });
  }
});

// POST /api/manual-bills — create a manual bill
router.post("/api/manual-bills", async (req, res) => {
  const { name, amount, due_day, cadence, category, notes } = req.body;
  if (!name || amount == null || !due_day) {
    return res.status(400).json({ error: "name, amount, and due_day are required" });
  }
  const parsedDay = parseInt(due_day);
  if (parsedDay < 1 || parsedDay > 31) return res.status(400).json({ error: "due_day must be 1-31" });
  const parsedAmount = parseFloat(amount);
  if (isNaN(parsedAmount) || parsedAmount <= 0) return res.status(400).json({ error: "amount must be positive" });
  const validCadences = ["monthly", "quarterly", "yearly"];
  const billCadence = validCadences.includes(cadence) ? cadence : "monthly";
  try {
    const result = await pool.query(
      `INSERT INTO manual_bills (name, amount, due_day, cadence, category, notes)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [name.trim(), parsedAmount, parsedDay, billCadence, category || "bill", notes || null]
    );
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: "An internal error occurred." });
  }
});

// PATCH /api/manual-bills/:id — update a manual bill
router.patch("/api/manual-bills/:id", async (req, res) => {
  const { name, amount, due_day, cadence, category, notes, is_active } = req.body;
  const updates = []; const values = []; let idx = 1;
  if (name !== undefined) { updates.push("name = $" + idx++); values.push(name.trim()); }
  if (amount !== undefined) { updates.push("amount = $" + idx++); values.push(parseFloat(amount)); }
  if (due_day !== undefined) { const d = parseInt(due_day); if (d >= 1 && d <= 31) { updates.push("due_day = $" + idx++); values.push(d); } }
  if (cadence !== undefined && ["monthly", "quarterly", "yearly"].includes(cadence)) { updates.push("cadence = $" + idx++); values.push(cadence); }
  if (category !== undefined) { updates.push("category = $" + idx++); values.push(category); }
  if (notes !== undefined) { updates.push("notes = $" + idx++); values.push(notes || null); }
  if (is_active !== undefined) { updates.push("is_active = $" + idx++); values.push(!!is_active); }
  if (!updates.length) return res.status(400).json({ error: "No valid fields" });
  updates.push("updated_at = now()");
  values.push(req.params.id);
  try {
    const result = await pool.query(
      "UPDATE manual_bills SET " + updates.join(", ") + " WHERE id = $" + idx + " RETURNING *",
      values
    );
    if (!result.rows.length) return res.status(404).json({ error: "Not found" });
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: "An internal error occurred." });
  }
});

// DELETE /api/manual-bills/:id — delete a manual bill
router.delete("/api/manual-bills/:id", async (req, res) => {
  try {
    await pool.query("DELETE FROM manual_bills WHERE id = $1", [req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: "An internal error occurred." });
  }
});

// ============================================================================
// Bill Payments — mark bills as paid
// ============================================================================

// POST /api/bill-payments — mark a bill as paid for a date
router.post("/api/bill-payments", async (req, res) => {
  const { bill_source, bill_id, paid_date, paid_amount, notes } = req.body;
  if (!bill_source || !bill_id || !paid_date) {
    return res.status(400).json({ error: "bill_source, bill_id, and paid_date are required" });
  }
  if (!["subscription", "manual"].includes(bill_source)) {
    return res.status(400).json({ error: "bill_source must be 'subscription' or 'manual'" });
  }
  try {
    const result = await pool.query(
      `INSERT INTO bill_payments (bill_source, bill_id, paid_date, paid_amount, notes)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (bill_source, bill_id, paid_date) DO UPDATE SET
         paid_amount = COALESCE($4, bill_payments.paid_amount), notes = $5
       RETURNING *`,
      [bill_source, parseInt(bill_id), paid_date, paid_amount ? parseFloat(paid_amount) : null, notes || null]
    );
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: "An internal error occurred." });
  }
});

// DELETE /api/bill-payments/:id — unmark a bill payment
router.delete("/api/bill-payments/:id", async (req, res) => {
  try {
    await pool.query("DELETE FROM bill_payments WHERE id = $1", [req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: "An internal error occurred." });
  }
});

// GET /api/bill-payments — list payments for a month
router.get("/api/bill-payments", async (req, res) => {
  const year = parseInt(req.query.year) || new Date().getFullYear();
  const month = parseInt(req.query.month) || new Date().getMonth() + 1;
  const startDate = `${year}-${String(month).padStart(2, "0")}-01`;
  const daysInMonth = new Date(year, month, 0).getDate();
  const endDate = `${year}-${String(month).padStart(2, "0")}-${String(daysInMonth).padStart(2, "0")}`;
  try {
    const result = await pool.query(
      "SELECT * FROM bill_payments WHERE paid_date >= $1 AND paid_date <= $2 ORDER BY paid_date",
      [startDate, endDate]
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: "An internal error occurred." });
  }
});

module.exports = router;
module.exports.runSubscriptionDetection = runSubscriptionDetection;
