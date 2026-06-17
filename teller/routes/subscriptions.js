// ============================================================================
// Routes: Subscriptions CRUD, Transactions, Detection, CSV Import
// ============================================================================

const express = require("express");
const router = express.Router();
const multer = require("multer");
const { parse } = require("csv-parse/sync");
const { pool, ENCRYPTION_PASSPHRASE } = require("../services/database");
const { categorizeSubscription, findCancelUrl } = require("../data/reference-data");
const { CSV_FORMATS, INSTITUTION_LABELS, detectCsvFormat, parseDate, csvTransactionId, makeCsvTxnIdGenerator } = require("../data/csv-formats");
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
         -- Only reset user state when the existing row is itself a MANUAL entry
         -- (the user is re-adding their own bill). If a generated manual_<name>
         -- key collides with an auto-detected row the user cancelled/dismissed,
         -- preserve that state instead of silently re-activating it (F5).
         is_active = CASE WHEN detected_subscriptions.source = 'manual' THEN true ELSE detected_subscriptions.is_active END,
         is_dismissed = CASE WHEN detected_subscriptions.source = 'manual' THEN false ELSE detected_subscriptions.is_dismissed END,
         cancelled_at = CASE WHEN detected_subscriptions.source = 'manual' THEN NULL ELSE detected_subscriptions.cancelled_at END,
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

// =========================================================================
// Per-transaction endpoints (search/list, duplicates, csv-overlap, edit,
// splits, delete) — extracted to routes/transactions.js (route-file split).
// Mounted here so every /api/transactions* path is unchanged.
// =========================================================================
const transactionRoutes = require("./transactions");
router.use(transactionRoutes);

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

// parseCsvUpload — shared parse + format-detect + label-derivation for the CSV
// import + preview endpoints. Keeping it in ONE place guarantees the preview's
// dedup-ID classification matches what the real import will actually do (same
// format, same account label → same csvTransactionId occurrence sequence).
// Returns { error } on a bad file, else { formatName, fmt, institution,
// accountLabel, records, headers }.
function parseCsvUpload(buffer, body = {}) {
  const content = buffer.toString("utf-8");
  let records = parse(content, { columns: true, skip_empty_lines: true, trim: true, bom: true });
  if (!records.length) return { error: "CSV file is empty or unparseable" };
  const headers = Object.keys(records[0]);
  const formatName = detectCsvFormat(headers);
  const fmt = CSV_FORMATS[formatName];
  if (!fmt) return { error: `Unrecognized CSV format: ${formatName}` };
  // Default institution/account label from the DETECTED format when the caller
  // omits them (F2 — matches the CLI's content-derived label so dedup IDs align).
  const institution = body.institution || INSTITUTION_LABELS[formatName] || "CSV Import";
  const accountLabel = body.account_label || `${institution} Account`;
  // Headerless formats (Wells Fargo) re-parse with explicit columns.
  if (fmt.headerless && fmt.columns) {
    records = parse(content, { columns: fmt.columns, skip_empty_lines: true, trim: true, bom: true });
  }
  return { formatName, fmt, institution, accountLabel, records, headers };
}

// POST /api/import-csv/preview — dry-run a CSV import: detect the format and
// classify every row as new / duplicate / skipped WITHOUT writing anything, so
// the user can confirm before committing. Duplicate detection uses the SAME
// occurrence-aware dedup ID the import writes (makeCsvTxnIdGenerator) checked
// against existing transaction_ids, so rows_new/rows_duplicate here equal the
// import's rows_imported/rows_duplicate for the same file (modulo concurrent
// syncs). Surfaces the silent drop that import would otherwise do quietly.
router.post("/api/import-csv/preview", upload.single("file"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "No file uploaded" });
  try {
    const parsed = parseCsvUpload(req.file.buffer, req.body);
    if (parsed.error) return res.status(400).json({ error: parsed.error });
    const { formatName, fmt, institution, accountLabel, records, headers } = parsed;

    const nextTxnId = makeCsvTxnIdGenerator();
    const rows = [];
    let skipped = 0;
    for (const row of records) {
      let p;
      try { p = fmt.parse(row, fmt.headerless ? fmt.columns : headers); }
      catch { skipped++; continue; }
      const date = parseDate(p.date);
      if (!date || isNaN(p.amount) || p.amount === 0) { skipped++; continue; }
      const txnId = nextTxnId(accountLabel, date, p.amount, p.merchant_name);
      rows.push({ txnId, date, amount: p.amount, merchant: p.merchant_name || "", category: p.category || "" });
    }

    let existing = new Set();
    if (rows.length) {
      const r = await pool.query(
        "SELECT transaction_id FROM transactions WHERE transaction_id = ANY($1)",
        [rows.map(x => x.txnId)]
      );
      existing = new Set(r.rows.map(x => x.transaction_id));
    }

    let newCount = 0, dupCount = 0;
    const sample = [];
    for (const row of rows) {
      const isDup = existing.has(row.txnId);
      if (isDup) dupCount++; else newCount++;
      if (sample.length < 12) {
        sample.push({ date: row.date, amount: row.amount, merchant: row.merchant, category: row.category, status: isDup ? "duplicate" : "new" });
      }
    }

    res.json({
      format_detected: formatName,
      institution,
      account_label: accountLabel,
      rows_total: records.length,
      rows_parseable: rows.length,
      rows_skipped: skipped,
      rows_new: newCount,
      rows_duplicate: dupCount,
      sample,
    });
  } catch (err) {
    console.error("CSV preview error:", err.message);
    res.status(500).json({ error: "An internal error occurred." });
  }
});

// POST /api/import-csv
router.post("/api/import-csv", upload.single("file"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "No file uploaded" });

  try {
    const up = parseCsvUpload(req.file.buffer, req.body);
    if (up.error) return res.status(400).json({ error: up.error });
    const { formatName, fmt, institution, accountLabel, records, headers } = up;

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
      let duplicates = 0;
      // One occurrence-tracking generator per import so two genuinely-distinct
      // rows sharing (label,date,amount,merchant) get distinct IDs instead of
      // the second silently deduping against the first (F1). Mirrors the CLI.
      const nextTxnId = makeCsvTxnIdGenerator();

      for (let i = 0; i < records.length; i++) {
        const row = records[i];
        let parsed;
        try {
          // For headerless formats, row is keyed by fmt.columns after the re-parse above.
          parsed = fmt.parse(row, fmt.headerless ? fmt.columns : headers);
        } catch { skipped++; continue; }

        const date = parseDate(parsed.date);
        if (!date || isNaN(parsed.amount) || parsed.amount === 0) { skipped++; continue; }

        const txnId = nextTxnId(accountLabel, date, parsed.amount, parsed.merchant_name);

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
        // rowCount 0 here now means a TRUE re-import of an already-present row
        // (the occurrence index already separated same-file identical rows), so
        // it's surfaced as `duplicates` rather than lumped into `skipped`.
        if (result.rowCount > 0) imported++;
        else { skipped++; duplicates++; }
      }

      await client.query(
        `INSERT INTO csv_imports (filename, institution, account_label, rows_imported, rows_skipped)
         VALUES ($1, $2, $3, $4, $5)`,
        [req.file.originalname, institution, accountLabel, imported, skipped]
      );

      // Auto-update manual account balance if institution matches
      try {
        // Match the user's manual account by EXACT institution name or EXACT
        // account label (L2). The previous `name LIKE '%institution%'` substring
        // could match the wrong manual account (e.g. a short institution token
        // matching an unrelated account name) and silently overwrite ITS
        // current_balance from this CSV's net — both matches are now exact.
        const manualAcct = await client.query(
          `SELECT id, type FROM linked_accounts
           WHERE is_manual = true
             AND (LOWER(institution_name_manual) = LOWER($1) OR LOWER(name) = LOWER($2))
           LIMIT 1`,
          [institution, accountLabel]
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
        rows_duplicate: duplicates,
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

// GET /api/shared-settlement — month-by-month "who owes who" for shared
// credit cards. Splits each transaction by personal_for: NULL rows use the
// account's spending_split_pct (default 50/50 on a shared card); 'self' rows
// are 100% the user; 'partner' rows are 100% the other cardholder. Reimbursed
// rows are excluded entirely (they net out to neither party).
// Query: month=YYYY-MM (default = current month), account_id (optional —
// returns settlements for every shared account when omitted).
router.get("/api/shared-settlement", async (req, res) => {
  const month = /^\d{4}-(0[1-9]|1[0-2])$/.test(String(req.query.month || ""))
    ? req.query.month
    : new Date().toISOString().slice(0, 7);
  const accountIdFilter = req.query.account_id ? parseInt(req.query.account_id) : null;
  try {
    const partnerNameRow = await pool.query(
      "SELECT COALESCE(NULLIF(TRIM(partner_name), ''), 'Partner') AS partner_name FROM user_settings WHERE id = 1"
    );
    const partnerName = partnerNameRow.rows[0]?.partner_name || "Partner";

    const params = [month + "-01"];
    let accountClause = "la.is_shared = true";
    if (accountIdFilter) {
      params.push(accountIdFilter);
      accountClause += ` AND la.id = $${params.length}`;
    }

    const result = await pool.query(`
      SELECT
        la.id AS account_id,
        la.name AS account_name,
        COALESCE(la.spending_split_pct, 50) AS split_pct,
        COUNT(t.transaction_id)::int AS txn_count,
        ROUND(COALESCE(SUM(t.amount), 0)::numeric, 2) AS total_charges,
        ROUND(COALESCE(SUM(t.amount) FILTER (WHERE t.personal_for IS NULL), 0)::numeric, 2) AS shared_total,
        COUNT(*) FILTER (WHERE t.personal_for IS NULL)::int AS shared_count,
        ROUND(COALESCE(SUM(t.amount) FILTER (WHERE t.personal_for = 'self'), 0)::numeric, 2) AS your_personal_total,
        COUNT(*) FILTER (WHERE t.personal_for = 'self')::int AS your_personal_count,
        ROUND(COALESCE(SUM(t.amount) FILTER (WHERE t.personal_for = 'partner'), 0)::numeric, 2) AS partner_personal_total,
        COUNT(*) FILTER (WHERE t.personal_for = 'partner')::int AS partner_personal_count
      FROM linked_accounts la
      LEFT JOIN transactions t
        ON t.account_id = la.account_id
        AND t.amount > 0
        AND COALESCE(t.is_reimbursed, false) = false
        AND t.date >= $1::date
        AND t.date <  ($1::date + INTERVAL '1 month')::date
      WHERE ${accountClause}
      GROUP BY la.id, la.name, la.spending_split_pct
      ORDER BY la.name
    `, params);

    const accounts = result.rows.map(r => {
      const shared = parseFloat(r.shared_total) || 0;
      const yours = parseFloat(r.your_personal_total) || 0;
      const theirs = parseFloat(r.partner_personal_total) || 0;
      const yourSplitPct = (parseInt(r.split_pct) || 50) / 100;
      const yourShare = shared * yourSplitPct + yours;
      const theirShare = shared * (1 - yourSplitPct) + theirs;
      return {
        account_id: r.account_id,
        account_name: r.account_name,
        split_pct: parseInt(r.split_pct),
        txn_count: r.txn_count,
        total_charges: parseFloat(r.total_charges) || 0,
        shared_total: shared,
        shared_count: r.shared_count,
        your_personal_total: yours,
        your_personal_count: r.your_personal_count,
        partner_personal_total: theirs,
        partner_personal_count: r.partner_personal_count,
        your_share: Math.round(yourShare * 100) / 100,
        partner_share: Math.round(theirShare * 100) / 100,
      };
    });

    res.json({ month, partner_name: partnerName, accounts });
  } catch (err) {
    console.error("shared-settlement error:", err.message);
    res.status(500).json({ error: "An internal error occurred." });
  }
});

// GET /api/shared-settlement/:account_id/transactions — flat list of every
// transaction on a shared account for the given month, with each row's
// personal_for state, so the user can review/edit assignments while
// reconciling. Reimbursed rows are returned with a flag so the UI can hide
// or fade them.
router.get("/api/shared-settlement/:account_id/transactions", async (req, res) => {
  const month = /^\d{4}-(0[1-9]|1[0-2])$/.test(String(req.query.month || ""))
    ? req.query.month
    : new Date().toISOString().slice(0, 7);
  const accountId = parseInt(req.params.account_id);
  if (!accountId) return res.status(400).json({ error: "account_id required" });
  try {
    const result = await pool.query(`
      SELECT t.transaction_id, t.date, t.amount,
             COALESCE(t.user_merchant_name, t.merchant_name, t.name) AS merchant,
             COALESCE(t.user_category, t.category[1]) AS category,
             t.personal_for, t.is_reimbursed
      FROM transactions t
      JOIN linked_accounts la ON la.account_id = t.account_id
      WHERE la.id = $1
        AND t.amount > 0
        AND t.date >= $2::date
        AND t.date <  ($2::date + INTERVAL '1 month')::date
      ORDER BY t.date DESC, t.transaction_id
    `, [accountId, month + "-01"]);
    res.json({ month, account_id: accountId, transactions: result.rows });
  } catch (err) {
    console.error("settlement transactions error:", err.message);
    res.status(500).json({ error: "An internal error occurred." });
  }
});

// POST /api/cleanup
router.post("/api/cleanup", async (_req, res) => {
  try {
    const txnResult = await pool.query(
      // 36 months (SX1): must be >= the longest analytical window so cleanup
      // doesn't silently truncate detection (36mo) / seasonal (24mo) / YoY.
      // Mirrors scripts/retention-cleanup.sql — keep both in lockstep.
      `DELETE FROM transactions WHERE date < (CURRENT_DATE - INTERVAL '36 months') RETURNING transaction_id`
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
      // Guard against cadence_days <= 0 / NaN: the advance loops below add
      // `cadence * 86400000` each iteration, so a 0/NaN cadence would never
      // advance and would hang the request (the ICS builder guards the same way, F8).
      if (!(cadence > 0)) continue;
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
      // Guard against cadence_days <= 0 / NaN — the advance loop below would
      // otherwise never progress and hang the request (F8, same as the ICS builder).
      if (!(cadence > 0)) continue;
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

    // Rent & utilities ledger — show UNPAID obligations for this month on their
    // due day (bill_source 'housing', distinct from subscription/manual). Once
    // recorded as paid they drop off the calendar (tracked on the Rent page).
    // Only rows with a known amount appear (a utility awaiting its bill has none).
    try {
      const periodStr = `${year}-${String(month).padStart(2, "0")}`;
      const housing = await pool.query(
        "SELECT id, label, amount, due_day FROM payee_obligations WHERE status = 'unpaid' AND period = $1 AND amount IS NOT NULL",
        [periodStr]
      );
      for (const o of housing.rows) {
        const day = Math.min(o.due_day || 1, daysInMonth);
        // No bill_id — housing is settled via its own payment flow (the Rent
        // page), so it's display-only on the calendar (the paid-state toggle
        // keys on bill_source+bill_id against bill_payments, which we skip here).
        calendar[day].push({
          name: o.label,
          amount: parseFloat(o.amount),
          category: "housing",
          bill_source: "housing",
        });
      }
    } catch (e) { /* payee_obligations not migrated yet — omit from calendar */ }

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
              ROUND(rt.amount * (30.0 / NULLIF(rt.cadence_days, 0)), 2) AS monthly_equivalent
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


// ---------------------------------------------------------------------------
// Bill-calendar iCalendar feed (subscribed from iOS/Google Calendar). Pure
// read: projects the next `days` of expected charges — detected subscriptions
// stepping next_expected by cadence_days, plus active manual bills (monthly =
// every occurrence in the window; quarterly/yearly = next occurrence only,
// since their anchor month is ambiguous). All-day VEVENTs with stable UIDs so
// re-fetches update in place. Served via the shell's token-gated public
// /calendar.ics route (calendar apps can't send headers or cookies).
// ---------------------------------------------------------------------------
function icsEscape(t) {
  return String(t).replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");
}
function icsDate(d) {
  return d.toISOString().slice(0, 10).replace(/-/g, "");
}
async function buildBillCalendarIcs(days) {
  const horizon = Math.min(365, Math.max(7, parseInt(days) || 90));
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  const end = new Date(today.getTime() + horizon * 86400000);
  const events = [];

  const subs = await pool.query(
    `SELECT id, display_name, amount, cadence_days, next_expected
     FROM detected_subscriptions
     WHERE is_active = true AND is_dismissed = false AND cancelled_at IS NULL
       AND cadence_days > 0`
  );
  for (const sub of subs.rows) {
    let d = new Date(sub.next_expected);
    let guard = 0;
    while (d < today && guard++ < 60) d = new Date(d.getTime() + sub.cadence_days * 86400000);
    guard = 0;
    while (d <= end && guard++ < 60) {
      events.push({
        uid: "sub-" + sub.id + "-" + icsDate(d) + "@perfin",
        date: new Date(d),
        summary: sub.display_name + " — $" + parseFloat(sub.amount).toFixed(2),
      });
      d = new Date(d.getTime() + sub.cadence_days * 86400000);
    }
  }

  const bills = await pool.query(
    "SELECT id, name, amount, due_day, cadence FROM manual_bills WHERE is_active = true"
  );
  for (const b of bills.rows) {
    const dueDay = Math.min(28, Math.max(1, parseInt(b.due_day) || 1)); // month-end safety, same as Important Dates
    const occurrences = [];
    if (b.cadence === "monthly") {
      for (let m = 0; m <= Math.ceil(horizon / 28) + 1; m++) {
        const d = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() + m, dueDay));
        if (d >= today && d <= end) occurrences.push(d);
      }
    } else {
      // quarterly/yearly: next occurrence only (anchor month is ambiguous)
      const step = b.cadence === "quarterly" ? 3 : 12;
      for (let m = 0; m <= 12; m += step) {
        const d = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() + m, dueDay));
        if (d >= today) { if (d <= end) occurrences.push(d); break; }
      }
    }
    for (const d of occurrences) {
      events.push({
        uid: "bill-" + b.id + "-" + icsDate(d) + "@perfin",
        date: d,
        summary: b.name + " — $" + parseFloat(b.amount).toFixed(2) + " (bill)",
      });
    }
  }

  // Rent & utilities ledger — unpaid obligations with a known amount, placed on
  // their period's due day (display-only; settled via the Rent page). Stable
  // per-obligation UID so a due-day edit updates the event in place. Defensive:
  // a pre-migration DB just omits them.
  try {
    const housing = await pool.query(
      "SELECT id, label, amount, period, due_day FROM payee_obligations WHERE status = 'unpaid' AND amount IS NOT NULL"
    );
    for (const o of housing.rows) {
      const [y, m] = String(o.period).split("-").map(Number);
      if (!y || !m) continue;
      const dueDay = Math.min(28, Math.max(1, parseInt(o.due_day) || 1));
      const d = new Date(Date.UTC(y, m - 1, dueDay));
      if (d >= today && d <= end) {
        events.push({
          uid: "housing-" + o.id + "@perfin",
          date: d,
          summary: o.label + " — $" + parseFloat(o.amount).toFixed(2) + " (rent/utilities)",
        });
      }
    }
  } catch (e) { /* payee_obligations not migrated yet — omit */ }

  const stamp = new Date().toISOString().replace(/[-:]/g, "").slice(0, 15) + "Z";
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Perfin//Bill Calendar//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    "X-WR-CALNAME:Perfin Bills",
  ];
  for (const ev of events.sort((a, b2) => a.date - b2.date)) {
    lines.push(
      "BEGIN:VEVENT",
      "UID:" + ev.uid,
      "DTSTAMP:" + stamp,
      "DTSTART;VALUE=DATE:" + icsDate(ev.date),
      "SUMMARY:" + icsEscape(ev.summary),
      "TRANSP:TRANSPARENT",
      "END:VEVENT"
    );
  }
  lines.push("END:VCALENDAR");
  return lines.join("\r\n") + "\r\n";
}

module.exports = router;
module.exports.runSubscriptionDetection = runSubscriptionDetection;
module.exports.buildBillCalendarIcs = buildBillCalendarIcs;
