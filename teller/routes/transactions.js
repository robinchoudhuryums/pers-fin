// ============================================================================
// Routes: Transactions (search/list, edit, splits, dedup tools)
// ============================================================================
// Extracted from routes/subscriptions.js (route-file split). Mounted by
// subscriptions.js, so every endpoint path is unchanged:
//   GET  /api/transactions, /api/transactions/search,
//   GET  /api/transactions/duplicates, /api/transactions/csv-overlap (+resolve)
//   PATCH/DELETE /api/transactions/:id, GET/POST/DELETE /api/transactions/:id/splits
// User edits write user_* columns only (INV-06); split sums are validated in
// integer cents (INV-09).

const express = require("express");
const router = express.Router();
const { pool } = require("../services/database");
const { isValidYmd } = require("../services/cadence");

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
      // The query is a literal (cycle-7 F57, INV-10): LIKE metacharacters are
      // escaped so "50%" or "a_b" don't act as wildcards.
      conditions.push(`(LOWER(COALESCE(t.user_merchant_name, t.merchant_name, t.name, '')) LIKE $${idx} ESCAPE '\\')`);
      values.push("%" + String(q).toLowerCase().replace(/[\\%_]/g, (c) => "\\" + c) + "%");
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
    // A malformed date 500'd on the cast (F57).
    if ((start_date && !isValidYmd(start_date)) || (end_date && !isValidYmd(end_date))) {
      return res.status(400).json({ error: "start_date / end_date must be YYYY-MM-DD" });
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
        t.personal_for,
        t.amount,
        la.name AS account_name,
        la.type AS account_type,
        la.is_shared AS account_is_shared,
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

// GET /api/transactions/csv-overlap — find CSV-imported transactions that
// have a matching Plaid/Teller-synced transaction (same date ±2 days, exact
// amount). This is the common cause of spending double-counting after a user
// links a previously CSV-only account via Plaid: the historical CSV rows are
// still in the database under a manual virtual account, and Plaid pulls fresh
// copies of the same transactions under its own account_id. The transaction_id
// scheme differs across sources so the existing ON CONFLICT dedup misses them.
// Candidate pairs: a CSV row and a synced row with the same amount within ±2
// days. Pairing happens in JS (pairOverlaps) — ONE synced row per CSV row and
// vice versa, and only when the merchants look alike (cycle-7 F21: amount +
// date alone matched two different $4.50 coffees, and one synced row matched
// every same-amount CSV row around it, so "Resolve" deleted genuine CSV rows).
const OVERLAP_CANDIDATES_SQL = `
  SELECT la_csv.id AS csv_id, la_synced.id AS synced_id,
         t_csv.transaction_id AS csv_txn, t_synced.transaction_id AS synced_txn,
         t_csv.amount, t_csv.date,
         ABS(t_synced.date - t_csv.date) AS day_gap,
         COALESCE(t_csv.user_merchant_name, t_csv.merchant_name, t_csv.name) AS csv_merchant,
         COALESCE(t_synced.user_merchant_name, t_synced.merchant_name, t_synced.name) AS synced_merchant,
         t_synced.name AS synced_name
  FROM linked_accounts la_csv
  JOIN plaid_items pi_csv ON pi_csv.id = la_csv.plaid_item_id AND pi_csv.status = 'CSV'
  JOIN transactions t_csv ON t_csv.account_id = la_csv.account_id
  JOIN transactions t_synced ON t_synced.amount = t_csv.amount
    AND ABS(t_synced.date - t_csv.date) <= 2
    AND t_synced.account_id != t_csv.account_id
  JOIN linked_accounts la_synced ON la_synced.account_id = t_synced.account_id
  LEFT JOIN plaid_items pi_s ON pi_s.id = la_synced.plaid_item_id
  WHERE (la_synced.teller_enrollment_id IS NOT NULL
         OR (la_synced.plaid_item_id IS NOT NULL AND pi_s.status <> 'CSV'))`;

// Merchant tokens: lower-case words of 3+ letters, minus processor/noise words.
const MERCHANT_NOISE = new Set(["the", "and", "inc", "llc", "com", "www", "pos", "purchase", "debit", "card",
  "payment", "recurring", "online", "sq", "tst", "paypal", "pending"]);
function merchantTokens(s) {
  return new Set(String(s || "").toLowerCase().replace(/[^a-z ]+/g, " ").split(/\s+/)
    .filter((w) => w.length >= 3 && !MERCHANT_NOISE.has(w)));
}
// Two statement strings name the same merchant when they share a token, or one
// token is a prefix (≥4 letters) of another ("amzn"/"amazon" don't — so the
// raw synced description is tried as well as its cleaned merchant).
function merchantsSimilar(a, b) {
  const A = merchantTokens(a), B = merchantTokens(b);
  for (const x of A) for (const y of B) {
    if (x === y) return true;
    if (x.length >= 4 && y.length >= 4 && (x.startsWith(y) || y.startsWith(x))) return true;
  }
  return false;
}
// One-to-one pairing per (csv account, synced account): merchant-similar
// candidates only, closest dates first. Returns the matched candidate rows.
function pairOverlaps(candidates) {
  const ok = candidates
    .filter((c) => merchantsSimilar(c.csv_merchant, c.synced_merchant) || merchantsSimilar(c.csv_merchant, c.synced_name))
    .sort((x, y) => Number(x.day_gap) - Number(y.day_gap) || String(x.csv_txn).localeCompare(String(y.csv_txn)));
  const used = new Set(), out = [];
  for (const c of ok) {
    const group = c.csv_id + "|" + c.synced_id;
    const kc = group + "|csv|" + c.csv_txn, ks = group + "|synced|" + c.synced_txn;
    if (used.has(kc) || used.has(ks)) continue;
    used.add(kc); used.add(ks);
    out.push(c);
  }
  return out;
}

router.get("/api/transactions/csv-overlap", async (_req, res) => {
  try {
    // CSV-imported accounts are NOT is_manual — /api/import-csv files them under
    // a virtual plaid_items row with status = 'CSV' (DC-5). Counts are over
    // one-to-one, merchant-checked pairs (F21).
    const [cand, accts] = await Promise.all([
      pool.query(OVERLAP_CANDIDATES_SQL),
      pool.query(`
        SELECT la.id, la.name,
               COALESCE(la.institution_name_manual, pi.institution_name, te.institution_name) AS institution,
               pi.status AS plaid_status, pi.id AS plaid_id
        FROM linked_accounts la
        LEFT JOIN plaid_items pi ON pi.id = la.plaid_item_id
        LEFT JOIN teller_enrollments te ON te.id = la.teller_enrollment_id`),
    ]);
    const byId = new Map(accts.rows.map((a) => [a.id, a]));
    const groups = new Map();
    for (const p of pairOverlaps(cand.rows)) {
      const key = p.csv_id + "|" + p.synced_id;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(p);
    }
    const overlaps = [];
    for (const [key, pairs] of groups) {
      if (pairs.length < 3) continue;
      const [csvId, syncedId] = key.split("|").map(Number);
      const c = byId.get(csvId) || {}, s = byId.get(syncedId) || {};
      const dates = pairs.map((p) => String(p.date instanceof Date ? p.date.toISOString() : p.date).slice(0, 10)).sort();
      overlaps.push({
        csv_account_id: csvId,
        csv_account_name: c.name,
        csv_institution: c.institution,
        synced_account_id: syncedId,
        synced_account_name: s.name,
        synced_institution: s.institution,
        synced_source: s.plaid_id ? "plaid" : "teller",
        overlap_count: pairs.length,
        overlap_amount: Math.round(pairs.reduce((sum, p) => sum + parseFloat(p.amount), 0) * 100) / 100,
        overlap_first_date: dates[0],
        overlap_last_date: dates[dates.length - 1],
      });
    }
    overlaps.sort((a, b) => b.overlap_count - a.overlap_count);
    res.json({
      overlaps,
      note: "CSV virtual accounts whose transactions overlap with Plaid/Teller-synced accounts (same amount, date ±2 days, similar merchant, one-to-one). POST /api/transactions/csv-overlap/resolve with { csv_account_id, synced_account_id } to delete the CSV-side duplicates.",
    });
  } catch (err) {
    console.error("csv-overlap error:", err.message);
    res.status(500).json({ error: "An internal error occurred." });
  }
});

// POST /api/transactions/csv-overlap/resolve — delete CSV transactions that
// pair one-to-one with a Plaid/Teller transaction (same amount, date ±2 days,
// similar merchant — F21). Keeps the Plaid/Teller side as the canonical source
// going forward. Also offers a dry_run flag so the user can preview the row
// count before committing.
router.post("/api/transactions/csv-overlap/resolve", async (req, res) => {
  const csvAccountId = parseInt(req.body?.csv_account_id);
  const syncedAccountId = parseInt(req.body?.synced_account_id);
  const dryRun = req.body?.dry_run === true;
  if (!csvAccountId || !syncedAccountId) {
    return res.status(400).json({ error: "csv_account_id and synced_account_id required (numeric linked_accounts.id values from GET /api/transactions/csv-overlap)" });
  }
  try {
    const accts = await pool.query(
      `SELECT la.id, la.account_id, la.plaid_item_id, la.teller_enrollment_id,
              pi.status AS plaid_status
       FROM linked_accounts la
       LEFT JOIN plaid_items pi ON pi.id = la.plaid_item_id
       WHERE la.id = ANY($1::int[])`,
      [[csvAccountId, syncedAccountId]]
    );
    if (accts.rows.length !== 2) return res.status(404).json({ error: "One or both accounts not found" });
    const csv = accts.rows.find(r => r.id === csvAccountId);
    const synced = accts.rows.find(r => r.id === syncedAccountId);
    // The CSV side must be a CSV-import account (virtual plaid_items status
    // 'CSV'), never a hand-made manual account — the old is_manual check let
    // this DELETE manual cash entries that happened to match a bank row (DC-5).
    if (csv?.plaid_status !== "CSV") return res.status(400).json({ error: "csv_account_id must be a CSV-imported account" });
    const syncedIsLinked = synced?.teller_enrollment_id || (synced?.plaid_item_id && synced.plaid_status !== "CSV");
    if (!syncedIsLinked) {
      return res.status(400).json({ error: "synced_account_id must be a Plaid- or Teller-linked account" });
    }
    const candidates = await pool.query(
      OVERLAP_CANDIDATES_SQL + " AND la_csv.id = $1 AND la_synced.id = $2",
      [csvAccountId, syncedAccountId]
    );
    const ids = pairOverlaps(candidates.rows).map((p) => p.csv_txn);
    if (dryRun) {
      return res.json({ would_delete: ids.length, dry_run: true });
    }
    if (!ids.length) return res.json({ deleted: 0 });
    const del = await pool.query(
      `DELETE FROM transactions WHERE transaction_id = ANY($1::text[]) RETURNING transaction_id`,
      [ids]
    );
    res.json({ deleted: del.rows.length });
  } catch (err) {
    console.error("csv-overlap resolve error:", err.message);
    res.status(500).json({ error: "An internal error occurred." });
  }
});

// PATCH /api/transactions/:id — user overrides (merchant_name, notes, is_reimbursed).
// User edits are stored in `user_*` columns so a subsequent sync from Teller
// does not clobber them. `merchant_name` in the PATCH body writes to
// `user_merchant_name`; the raw `merchant_name` column keeps Teller's value.
// POST /api/transactions/manual — add a one-off manual EXPENSE (e.g. cash
// spending that bank sync never sees). Requires an existing account_id — create
// a manual "Cash" account via POST /api/accounts/manual first. A unique
// manual_<ts>_<rand> transaction_id makes every entry distinct (no dedup
// collision) and Teller/Plaid re-sync never touches it. Amount is stored
// POSITIVE = expense (the sign every spending aggregation sums on `amount > 0`).
router.post("/api/transactions/manual", async (req, res) => {
  const { account_id, amount, date, merchant_name, category, notes } = req.body || {};
  if (!account_id) return res.status(400).json({ error: "account_id is required" });
  const amt = parseFloat(amount);
  if (!Number.isFinite(amt) || amt <= 0) return res.status(400).json({ error: "amount must be a positive number" });
  // A real date, not just the shape — "2026-13-45" used to 500 on insert (F57).
  if (!isValidYmd(date)) return res.status(400).json({ error: "date must be YYYY-MM-DD" });
  try {
    const acct = await pool.query("SELECT account_id, is_manual FROM linked_accounts WHERE account_id = $1", [account_id]);
    if (!acct.rows.length) return res.status(404).json({ error: "Account not found" });
    // Manual cash entries belong on a manual account only (DC-15, as documented):
    // on a synced account the next reconcile/csv-overlap pass could treat the
    // hand-entered row as a bank row, and bank balances never reflect it.
    if (!acct.rows[0].is_manual) return res.status(400).json({ error: "account_id must be a manual account (create one via POST /api/accounts/manual)" });
    const txnId = "manual_" + Date.now() + "_" + Math.random().toString(36).slice(2, 8);
    const merchant = (merchant_name && String(merchant_name).trim()) || "Cash";
    // One-element text[] parameter, not a concatenated array literal (DC-14).
    const cat = category && String(category).trim() ? [String(category).trim()] : null;
    const result = await pool.query(
      `INSERT INTO transactions (account_id, transaction_id, amount, date, merchant_name, name, category, user_notes, pending)
       VALUES ($1, $2, $3, $4, $5, $5, $6, $7, false) RETURNING *`,
      [account_id, txnId, Math.abs(amt), date, merchant, cat, notes ? String(notes).slice(0, 500) : null]
    );
    // F55: merchant rename rules apply to hand-entered rows too (fail-soft).
    let row = result.rows[0];
    try {
      if (await require("./merchant-rename").applyRenameRules() > 0) {
        row = (await pool.query("SELECT * FROM transactions WHERE transaction_id = $1", [txnId])).rows[0] || row;
      }
    } catch (e) { console.error("manual transaction: rename rules failed:", e.message); }
    res.json(row);
  } catch (err) {
    console.error("manual transaction error:", err.message);
    res.status(500).json({ error: "Failed to add transaction" });
  }
});

router.patch("/api/transactions/:id", async (req, res) => {
  const { merchant_name, notes, is_reimbursed, personal_for, apply_to_all } = req.body;
  const updates = []; const values = []; let idx = 1;
  let newMerchant = null;
  if (merchant_name !== undefined) {
    const v = typeof merchant_name === "string" ? merchant_name.trim() : null;
    newMerchant = v || null;
    updates.push("user_merchant_name = $" + idx++); values.push(newMerchant);
    // A hand rename always wins over a rename rule (F55): clear the rule link.
    updates.push("user_merchant_rule_id = NULL");
  }
  // F55 / ST2: "Apply to all past and future" needs the new name.
  if (apply_to_all && !newMerchant) {
    return res.status(400).json({ error: "apply_to_all needs a merchant_name" });
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
  if (personal_for !== undefined) {
    // null / '' / 'shared' all clear the override (use the account's
    // spending_split_pct). 'self' and 'partner' are the only stored values.
    const v = personal_for === "self" || personal_for === "partner" ? personal_for : null;
    updates.push("personal_for = $" + idx++); values.push(v);
  }
  if (!updates.length) return res.status(400).json({ error: "No valid fields to update" });
  values.push(req.params.id);
  try {
    const result = await pool.query(
      "UPDATE transactions SET " + updates.join(", ") + " WHERE transaction_id = $" + idx + " RETURNING transaction_id, user_merchant_name, user_notes, is_reimbursed, reimbursed_at, personal_for",
      values
    );
    if (!result.rows.length) return res.status(404).json({ error: "Transaction not found" });
    if (apply_to_all) {
      const { createRuleFromTransaction } = require("./merchant-rename");
      const out = await createRuleFromTransaction(req.params.id, newMerchant);
      // The row itself is already renamed; a rule error is reported, not fatal.
      return res.json({ ...result.rows[0], user_merchant_name: newMerchant,
        rename_rule: out.error ? null : out.rule, rename_rule_error: out.error || null,
        renamed: out.renamed || 0, rekeyed: out.rekeyed || null });
    }
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
      // Accumulate in integer cents (DC4/A4): per-amount rounding happens at
      // parse time, so many-way splits can't accumulate FP noise into the
      // tolerance check. Honors the documented "within $0.01" exactly.
      let sumCents = 0;
      for (const s of splits) {
        const n = parseFloat(s.amount);
        if (isNaN(n) || n <= 0) return res.status(400).json({ error: "Each split amount must be a positive number" });
        sumCents += Math.round(n * 100);
      }
      if (Math.abs(sumCents - Math.round(parentAmount * 100)) > 1) {
        return res.status(400).json({
          error: `Splits sum to $${(sumCents / 100).toFixed(2)} but parent transaction is $${parentAmount.toFixed(2)} — must match within $0.01`,
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

// DELETE /api/transactions/:id — Delete a specific transaction (for dedup).
// The id is remembered in deleted_transactions so a Teller / Plaid re-fetch
// (the 7-day lookback, the weekly reconcile, a Plaid reconcile) doesn't bring
// it back (cycle-7 F20 — the duplicate-cleanup's work was undone and the
// row's splits were lost the second time).
router.delete("/api/transactions/:id", async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await client.query(
      "DELETE FROM transactions WHERE transaction_id = $1 RETURNING transaction_id",
      [req.params.id]
    );
    if (!result.rows.length) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Transaction not found" });
    }
    await client.query(
      "INSERT INTO deleted_transactions (transaction_id) VALUES ($1) ON CONFLICT DO NOTHING",
      [req.params.id]
    );
    await client.query("COMMIT");
    res.json({ deleted: true, transaction_id: req.params.id });
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    console.error("delete transaction error:", err.message);
    res.status(500).json({ error: "An internal error occurred." });
  } finally { client.release(); }
});


module.exports = router;
// Test seams (cycle-7 F21) — attached after the router assignment (INV-19).
module.exports.pairOverlaps = pairOverlaps;
module.exports.merchantsSimilar = merchantsSimilar;
