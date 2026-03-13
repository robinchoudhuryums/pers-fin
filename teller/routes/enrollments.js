// ============================================================================
// Routes: Enrollment, Sync, Items, Accounts
// ============================================================================

const express = require("express");
const router = express.Router();
const { pool, ENCRYPTION_PASSPHRASE } = require("../services/database");
const { tellerRequest } = require("../services/teller-api");

// POST /api/enroll — store Teller Connect enrollment
router.post("/api/enroll", async (req, res) => {
  const { accessToken, enrollment } = req.body;
  if (!accessToken || !enrollment?.id) {
    return res.status(400).json({ error: "accessToken and enrollment are required" });
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const institutionName = enrollment.institution?.name || "Unknown";

    const enrollResult = await client.query(
      `INSERT INTO teller_enrollments (enrollment_id, institution_name, access_token_enc)
       VALUES ($1, $2, pgp_sym_encrypt($3, $4))
       ON CONFLICT (enrollment_id) DO UPDATE SET
         access_token_enc = pgp_sym_encrypt($3, $4),
         institution_name = $2,
         status = 'GOOD',
         updated_at = now()
       RETURNING id`,
      [enrollment.id, institutionName, accessToken, ENCRYPTION_PASSPHRASE]
    );
    const enrollmentDbId = enrollResult.rows[0].id;

    const accounts = await tellerRequest("/accounts", accessToken);

    let linked = 0;
    for (const acct of accounts) {
      await client.query(
        `INSERT INTO linked_accounts (teller_enrollment_id, account_id, name, official_name, type, subtype, mask)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (account_id) DO UPDATE SET
           name = EXCLUDED.name,
           official_name = EXCLUDED.official_name,
           type = EXCLUDED.type,
           subtype = EXCLUDED.subtype`,
        [
          enrollmentDbId,
          acct.id,
          acct.name,
          acct.name,
          acct.type,
          acct.subtype || acct.type,
          acct.last_four || null,
        ]
      );
      linked++;
    }

    await client.query("COMMIT");

    console.log(`Enrolled ${institutionName}: ${linked} accounts linked.`);
    res.json({
      enrollment_id: enrollment.id,
      institution: institutionName,
      accounts_linked: linked,
    });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("Enrollment error:", err.message);
    res.status(500).json({ error: "An internal error occurred." });
  } finally {
    client.release();
  }
});

// Helper: sync a single enrollment
async function syncEnrollment(enrollment) {
  const { id: enrollmentDbId, access_token, last_synced_txn_date, institution_name } = enrollment;

  const { rows: accounts } = await pool.query(
    `SELECT account_id FROM linked_accounts WHERE teller_enrollment_id = $1`,
    [enrollmentDbId]
  );

  let added = 0;
  let updated = 0;
  let latestDate = last_synced_txn_date;

  for (const { account_id } of accounts) {
    let allTxns = [];
    let endpoint = `/accounts/${account_id}/transactions`;

    let keepFetching = true;
    while (keepFetching) {
      const txns = await tellerRequest(endpoint, access_token);

      if (!txns || txns.length === 0) break;
      allTxns = allTxns.concat(txns);

      const oldestInBatch = txns[txns.length - 1];
      if (last_synced_txn_date && new Date(oldestInBatch.date) <= new Date(last_synced_txn_date)) {
        keepFetching = false;
      } else if (txns.length < 500) {
        keepFetching = false;
      } else {
        endpoint = `/accounts/${account_id}/transactions?from_id=${oldestInBatch.id}`;
      }
    }

    const txnsToProcess = last_synced_txn_date
      ? allTxns.filter(t => new Date(t.date) > new Date(last_synced_txn_date))
      : allTxns;

    for (const txn of txnsToProcess) {
      if (txn.status === "pending") continue;

      const normalizedAmount = parseFloat(txn.amount) < 0 ? Math.abs(parseFloat(txn.amount)) : -parseFloat(txn.amount);

      const result = await pool.query(
        `INSERT INTO transactions (account_id, transaction_id, amount, iso_currency_code, date,
                                   merchant_name, name, category, pending)
         VALUES ($1, $2, $3, 'USD', $4, $5, $6, $7, false)
         ON CONFLICT (transaction_id)
         DO UPDATE SET
           amount = EXCLUDED.amount,
           date = EXCLUDED.date,
           merchant_name = EXCLUDED.merchant_name,
           name = EXCLUDED.name,
           category = EXCLUDED.category,
           pending = EXCLUDED.pending`,
        [
          account_id,
          txn.id,
          normalizedAmount,
          txn.date,
          txn.details?.counterparty?.name || txn.description || null,
          txn.description || "",
          txn.details?.category ? `{${txn.details.category}}` : null,
        ]
      );

      if (result.rowCount > 0) {
        added++;
      }

      if (!latestDate || new Date(txn.date) > new Date(latestDate)) {
        latestDate = txn.date;
      }
    }
  }

  if (latestDate) {
    await pool.query(
      `UPDATE teller_enrollments SET last_synced_txn_date = $1, updated_at = now()
       WHERE id = $2`,
      [latestDate, enrollmentDbId]
    );
  }

  console.log(`  ${institution_name}: ${added} added/updated`);
  return { added, updated };
}

// POST /api/sync
router.post("/api/sync", async (req, res) => {
  try {
    const { rows: enrollments } = await pool.query(
      `SELECT te.id, te.enrollment_id, te.institution_name,
              pgp_sym_decrypt(te.access_token_enc, $1) AS access_token,
              te.last_synced_txn_date
       FROM teller_enrollments te
       WHERE te.status != 'SUSPENDED'
       ORDER BY te.id`,
      [ENCRYPTION_PASSPHRASE]
    );

    let totalAdded = 0;
    let totalUpdated = 0;
    const errors = [];

    for (const enrollment of enrollments) {
      try {
        const result = await syncEnrollment(enrollment);
        totalAdded += result.added;
        totalUpdated += result.updated;
      } catch (err) {
        console.error(`Sync error for ${enrollment.institution_name}:`, err.message);
        if (err.status === 401 || err.status === 403) {
          await pool.query(
            `UPDATE teller_enrollments SET status = 'DISCONNECTED', updated_at = now()
             WHERE id = $1`,
            [enrollment.id]
          );
        }
        errors.push({
          institution: enrollment.institution_name,
          error: err.message,
        });
      }
    }

    res.json({
      enrollments_synced: enrollments.length - errors.length,
      transactions_added: totalAdded,
      transactions_updated: totalUpdated,
      errors: errors.length > 0 ? errors : undefined,
    });
  } catch (err) {
    console.error("Sync error:", err.message);
    res.status(500).json({ error: "An internal error occurred." });
  }
});

// GET /api/items
router.get("/api/items", async (_req, res) => {
  try {
    const result = await pool.query(
      `SELECT
         COALESCE(te.id, pi.id) AS id,
         COALESCE(te.enrollment_id, pi.item_id) AS item_id,
         COALESCE(te.institution_name, pi.institution_name) AS institution_name,
         COALESCE(te.status, pi.status) AS status,
         COALESCE(te.created_at, pi.created_at) AS created_at,
         CASE WHEN te.id IS NOT NULL THEN 'teller' ELSE 'plaid' END AS provider,
         json_agg(json_build_object(
           'account_id', la.account_id,
           'name', la.name,
           'type', la.type,
           'subtype', la.subtype,
           'mask', la.mask
         )) AS accounts
       FROM linked_accounts la
       LEFT JOIN teller_enrollments te ON te.id = la.teller_enrollment_id
       LEFT JOIN plaid_items pi ON pi.id = la.plaid_item_id
       GROUP BY te.id, te.enrollment_id, te.institution_name, te.status, te.created_at,
                pi.id, pi.item_id, pi.institution_name, pi.status, pi.created_at
       ORDER BY COALESCE(te.created_at, pi.created_at)`
    );
    res.json(result.rows);
  } catch (err) {
    console.error("list items error:", err.message);
    res.status(500).json({ error: "An internal error occurred." });
  }
});

// DELETE /api/enrollments/:id
router.delete("/api/enrollments/:id", async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT enrollment_id,
              pgp_sym_decrypt(access_token_enc, $1) AS access_token
       FROM teller_enrollments WHERE id = $2`,
      [ENCRYPTION_PASSPHRASE, req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: "Enrollment not found" });

    try {
      const accounts = await tellerRequest("/accounts", rows[0].access_token);
      for (const acct of accounts) {
        await tellerRequest(`/accounts/${acct.id}`, rows[0].access_token, { method: "DELETE" });
      }
    } catch (err) {
      console.warn("Could not revoke at Teller (may already be disconnected):", err.message);
    }

    await pool.query(
      `DELETE FROM transactions WHERE account_id IN (SELECT account_id FROM linked_accounts WHERE teller_enrollment_id = $1)`,
      [req.params.id]
    );
    await pool.query(`DELETE FROM teller_enrollments WHERE id = $1`, [req.params.id]);

    res.json({ deleted: true });
  } catch (err) {
    console.error("unlink error:", err.message);
    res.status(500).json({ error: err.message || "An internal error occurred." });
  }
});

// DELETE /api/items/:id — unlink a Plaid institution
router.delete("/api/items/:id", async (req, res) => {
  const { id } = req.params;
  try {
    const check = await pool.query("SELECT id, institution_name FROM plaid_items WHERE id = $1", [id]);
    if (!check.rows.length) return res.status(404).json({ error: "Item not found" });
    const name = check.rows[0].institution_name;
    await pool.query(
      `DELETE FROM transactions WHERE account_id IN (SELECT account_id FROM linked_accounts WHERE plaid_item_id = $1)`,
      [id]
    );
    await pool.query("DELETE FROM linked_accounts WHERE plaid_item_id = $1", [id]);
    await pool.query("DELETE FROM plaid_items WHERE id = $1", [id]);
    res.json({ deleted: true, institution_name: name });
  } catch (err) {
    console.error("delete plaid item error:", err.message);
    res.status(500).json({ error: "An internal error occurred." });
  }
});

// GET /api/accounts
router.get("/api/accounts", async (_req, res) => {
  try {
    const result = await pool.query(
      `SELECT la.id, la.account_id, la.name, la.official_name, la.type, la.subtype, la.mask,
              la.available_balance, la.current_balance, la.balance_currency, la.balance_updated_at, la.apr,
              COALESCE(te.institution_name, pi.institution_name) AS institution_name,
              CASE WHEN te.id IS NOT NULL THEN 'teller' ELSE 'plaid' END AS provider
       FROM linked_accounts la
       LEFT JOIN teller_enrollments te ON te.id = la.teller_enrollment_id
       LEFT JOIN plaid_items pi ON pi.id = la.plaid_item_id
       ORDER BY la.type, la.name`
    );
    res.json(result.rows);
  } catch (err) {
    console.error("list accounts error:", err.message);
    res.status(500).json({ error: "An internal error occurred." });
  }
});

// PATCH /api/accounts/:id
router.patch("/api/accounts/:id", async (req, res) => {
  const { apr } = req.body;
  try {
    const updates = []; const values = []; let idx = 1;
    if (apr !== undefined) {
      const val = apr === null || apr === "" ? null : parseFloat(apr);
      if (val !== null && (isNaN(val) || val < 0 || val > 99.99)) {
        return res.status(400).json({ error: "APR must be between 0 and 99.99" });
      }
      updates.push("apr = $" + idx++); values.push(val);
    }
    if (!updates.length) return res.status(400).json({ error: "No valid fields" });
    values.push(req.params.id);
    const result = await pool.query(
      "UPDATE linked_accounts SET " + updates.join(", ") + " WHERE id = $" + idx + " RETURNING *",
      values
    );
    if (!result.rows.length) return res.status(404).json({ error: "Account not found" });
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: "An internal error occurred." });
  }
});

// POST /api/sync-balances
router.post("/api/sync-balances", async (_req, res) => {
  try {
    const enrollments = await pool.query(
      `SELECT id, enrollment_id, institution_name,
              pgp_sym_decrypt(access_token_enc, $1) AS access_token
       FROM teller_enrollments WHERE status = 'GOOD'`,
      [ENCRYPTION_PASSPHRASE]
    );

    let updated = 0;
    const errors = [];

    for (const enrollment of enrollments.rows) {
      try {
        const accounts = await tellerRequest("/accounts", enrollment.access_token);
        for (const acct of accounts) {
          let balances = null;
          try {
            balances = await tellerRequest(`/accounts/${acct.id}/balances`, enrollment.access_token);
          } catch {}

          const available = balances?.available || acct.balance?.available || null;
          const ledger = balances?.ledger || acct.balance?.ledger || acct.balance?.current || null;

          if (available !== null || ledger !== null) {
            await pool.query(
              `UPDATE linked_accounts
               SET available_balance = $1, current_balance = $2, balance_updated_at = now()
               WHERE account_id = $3`,
              [available ? parseFloat(available) : null, ledger ? parseFloat(ledger) : null, acct.id]
            );
            updated++;
          }
        }
      } catch (err) {
        errors.push({ institution: enrollment.institution_name, error: err.message });
      }
    }

    // Auto-snapshot net worth after balance sync
    try {
      const allAccts = await pool.query("SELECT type, available_balance, current_balance FROM linked_accounts WHERE available_balance IS NOT NULL OR current_balance IS NOT NULL");
      let assets = 0, liabilities = 0;
      for (const a of allAccts.rows) {
        if (a.type === "credit") liabilities += parseFloat(a.current_balance || 0);
        else assets += parseFloat(a.available_balance || a.current_balance || 0);
      }
      await pool.query(
        "INSERT INTO net_worth_snapshots (total_assets, total_liabilities, net_worth, snapshot_date) VALUES ($1, $2, $3, CURRENT_DATE) ON CONFLICT (snapshot_date) DO UPDATE SET total_assets=$1, total_liabilities=$2, net_worth=$3",
        [assets, liabilities, assets - liabilities]
      );
    } catch { /* non-critical */ }
    res.json({ accounts_updated: updated, errors: errors.length > 0 ? errors : undefined });
  } catch (err) {
    console.error("sync-balances error:", err.message);
    res.status(500).json({ error: "An internal error occurred." });
  }
});

// GET /api/spending-summary
router.get("/api/spending-summary", async (req, res) => {
  const months = parseInt(req.query.months) || 6;
  try {
    const monthlyTrend = await pool.query(
      `SELECT TO_CHAR(date, 'YYYY-MM') AS month,
              SUM(amount) AS total_spend,
              COUNT(*) AS txn_count,
              ROUND(AVG(amount), 2) AS avg_transaction
       FROM transactions
       WHERE amount > 0 AND date >= CURRENT_DATE - ($1 || ' months')::INTERVAL
       GROUP BY TO_CHAR(date, 'YYYY-MM')
       ORDER BY month DESC`,
      [months]
    );

    const byCategory = await pool.query(
      `SELECT COALESCE(category[1], 'Uncategorized') AS category,
              SUM(amount) AS total,
              COUNT(*) AS txn_count
       FROM transactions
       WHERE amount > 0 AND date >= CURRENT_DATE - ($1 || ' months')::INTERVAL
       GROUP BY COALESCE(category[1], 'Uncategorized')
       ORDER BY total DESC
       LIMIT 15`,
      [months]
    );

    const topMerchants = await pool.query(
      `SELECT COALESCE(merchant_name, name) AS merchant,
              SUM(amount) AS total_spent,
              COUNT(*) AS txn_count
       FROM transactions
       WHERE amount > 0 AND merchant_name IS NOT NULL
             AND date >= CURRENT_DATE - ($1 || ' months')::INTERVAL
       GROUP BY COALESCE(merchant_name, name)
       ORDER BY total_spent DESC
       LIMIT 10`,
      [months]
    );

    const upcoming = await pool.query(
      `SELECT display_name, amount, cadence_days, next_expected,
              ROUND(amount * (30.0 / NULLIF(cadence_days, 0)), 2) AS monthly_cost
       FROM detected_subscriptions
       WHERE is_active = true AND is_dismissed = false AND cancelled_at IS NULL
       ORDER BY next_expected ASC
       LIMIT 10`
    );

    res.json({
      monthly_trend: monthlyTrend.rows,
      by_category: byCategory.rows,
      top_merchants: topMerchants.rows,
      upcoming_subscriptions: upcoming.rows,
    });
  } catch (err) {
    console.error("spending-summary error:", err.message);
    res.status(500).json({ error: "An internal error occurred." });
  }
});

module.exports = router;
