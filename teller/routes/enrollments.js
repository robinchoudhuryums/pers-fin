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
  let latestDate = last_synced_txn_date;

  for (const { account_id } of accounts) {
    let allTxns = [];
    let endpoint = `/accounts/${account_id}/transactions`;

    let keepFetching = true;
    while (keepFetching) {
      let txns;
      try {
        txns = await tellerRequest(endpoint, access_token);
      } catch (fetchErr) {
        console.error(`  Error fetching transactions for account ${account_id}:`, fetchErr.message);
        break;
      }

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

      try {
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
      } catch (insertErr) {
        console.error(`  Error inserting transaction ${txn.id}:`, insertErr.message);
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
  return { added };
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
    const errors = [];

    for (const enrollment of enrollments) {
      try {
        const result = await syncEnrollment(enrollment);
        totalAdded += result.added;
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

    // After sync, check for anomalies in newly synced transactions and send push notifications.
    // Two correctness measures vs prior versions:
    //   1. The merchant-baseline average excludes transactions from the last 7 days, so the
    //      candidate anomaly doesn't drag its own baseline upward.
    //   2. We only consider transactions whose row was INSERTED since the last anomaly check
    //      (`last_anomaly_check_at` watermark on user_settings) — that prevents the same
    //      anomaly from notifying again on every subsequent /api/sync call.
    if (totalAdded > 0) {
      try {
        const settings = await pool.query("SELECT last_anomaly_check_at FROM user_settings WHERE id = 1");
        const watermark = settings.rows[0]?.last_anomaly_check_at || null;
        const anomalies = await pool.query(
          `SELECT t.merchant_name, t.name, t.amount, t.date, avg_tbl.avg_amount
           FROM transactions t
           JOIN (
             SELECT COALESCE(merchant_name, name) AS merchant,
                    AVG(amount) AS avg_amount, COUNT(*) AS txn_count
             FROM transactions
             WHERE amount > 0 AND pending = false
               AND date >= CURRENT_DATE - INTERVAL '12 months'
               AND date <  CURRENT_DATE - INTERVAL '7 days'
             GROUP BY COALESCE(merchant_name, name)
             HAVING COUNT(*) >= 3
           ) avg_tbl ON COALESCE(t.merchant_name, t.name) = avg_tbl.merchant
           WHERE t.amount > 0 AND t.pending = false
             AND t.date >= CURRENT_DATE - INTERVAL '3 days'
             AND t.amount > avg_tbl.avg_amount * 3
             AND ($1::timestamptz IS NULL OR t.created_at > $1)
           ORDER BY t.amount DESC
           LIMIT 5`,
          [watermark]
        );
        if (anomalies.rows.length > 0) {
          try {
            const { sendToAll } = require("./notifications");
            for (const a of anomalies.rows) {
              const merchant = a.merchant_name || a.name;
              await sendToAll({
                title: "Unusual charge detected",
                body: merchant + ": $" + parseFloat(a.amount).toFixed(2) + " (avg: $" + parseFloat(a.avg_amount).toFixed(2) + ")",
                tag: "anomaly-" + merchant.toLowerCase().replace(/\s+/g, "-"),
                data: { url: "/transactions" },
              });
            }
          } catch {}
        }
        // Always advance the watermark, even when no anomalies fired — otherwise a quiet
        // sync window after one anomaly would re-evaluate the same transactions on the
        // next call (different anomaly query, same transactions).
        await pool.query("UPDATE user_settings SET last_anomaly_check_at = now() WHERE id = 1").catch(() => {});
      } catch (err) {
        console.error("Post-sync anomaly check error:", err.message);
      }
    }

    res.json({
      enrollments_synced: enrollments.length - errors.length,
      transactions_added: totalAdded,
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

    const delClient = await pool.connect();
    try {
      await delClient.query("BEGIN");
      await delClient.query(
        `DELETE FROM transactions WHERE account_id IN (SELECT account_id FROM linked_accounts WHERE teller_enrollment_id = $1)`,
        [req.params.id]
      );
      await delClient.query(`DELETE FROM linked_accounts WHERE teller_enrollment_id = $1`, [req.params.id]);
      await delClient.query(`DELETE FROM teller_enrollments WHERE id = $1`, [req.params.id]);
      await delClient.query("COMMIT");
    } catch (delErr) {
      await delClient.query("ROLLBACK");
      throw delErr;
    } finally {
      delClient.release();
    }

    res.json({ deleted: true });
  } catch (err) {
    console.error("unlink error:", err.message);
    res.status(500).json({ error: "An internal error occurred." });
  }
});

// DELETE /api/items/:id — unlink a Plaid institution
router.delete("/api/items/:id", async (req, res) => {
  const { id } = req.params;
  try {
    const check = await pool.query("SELECT id, institution_name FROM plaid_items WHERE id = $1", [id]);
    if (!check.rows.length) return res.status(404).json({ error: "Item not found" });
    const name = check.rows[0].institution_name;
    const delClient = await pool.connect();
    try {
      await delClient.query("BEGIN");
      await delClient.query(
        `DELETE FROM transactions WHERE account_id IN (SELECT account_id FROM linked_accounts WHERE plaid_item_id = $1)`,
        [id]
      );
      await delClient.query("DELETE FROM linked_accounts WHERE plaid_item_id = $1", [id]);
      await delClient.query("DELETE FROM plaid_items WHERE id = $1", [id]);
      await delClient.query("COMMIT");
    } catch (delErr) {
      await delClient.query("ROLLBACK");
      throw delErr;
    } finally {
      delClient.release();
    }
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
              COALESCE(te.institution_name, pi.institution_name, la.institution_name_manual) AS institution_name,
              CASE WHEN te.id IS NOT NULL THEN 'teller' WHEN la.is_manual THEN 'manual' ELSE 'plaid' END AS provider,
              la.is_manual, la.credit_limit, la.is_shared, la.spending_split_pct
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

// POST /api/accounts/manual — Create a manual account
router.post("/api/accounts/manual", async (req, res) => {
  const { name, institution_name, type, subtype, current_balance, available_balance, credit_limit } = req.body;
  if (!name || !type) return res.status(400).json({ error: "name and type are required" });
  const validTypes = ["depository", "credit"];
  if (!validTypes.includes(type)) return res.status(400).json({ error: "type must be depository or credit" });
  try {
    const accountId = "manual_" + Date.now() + "_" + Math.random().toString(36).slice(2, 8);
    const result = await pool.query(
      `INSERT INTO linked_accounts (account_id, name, type, subtype, is_manual, institution_name_manual, current_balance, available_balance, credit_limit, balance_updated_at)
       VALUES ($1, $2, $3, $4, true, $5, $6, $7, $8, now()) RETURNING *`,
      [accountId, name, type, subtype || (type === "credit" ? "credit_card" : "checking"),
       institution_name || "Manual",
       parseFloat(current_balance) || 0, parseFloat(available_balance) || 0,
       credit_limit ? parseFloat(credit_limit) : null]
    );
    res.json(result.rows[0]);
  } catch (err) {
    console.error("create manual account error:", err.message);
    res.status(500).json({ error: "Failed to create account" });
  }
});

// PATCH /api/accounts/:id/balance — Update balance on any account
router.patch("/api/accounts/:id/balance", async (req, res) => {
  const { current_balance, available_balance, credit_limit } = req.body;
  try {
    const updates = []; const values = []; let idx = 1;
    if (current_balance !== undefined) { updates.push("current_balance = $" + idx++); values.push(parseFloat(current_balance)); }
    if (available_balance !== undefined) { updates.push("available_balance = $" + idx++); values.push(parseFloat(available_balance)); }
    if (credit_limit !== undefined) { updates.push("credit_limit = $" + idx++); values.push(credit_limit === null ? null : parseFloat(credit_limit)); }
    if (!updates.length) return res.status(400).json({ error: "No fields to update" });
    updates.push("balance_updated_at = now()");
    values.push(parseInt(req.params.id));
    const result = await pool.query("UPDATE linked_accounts SET " + updates.join(", ") + " WHERE id = $" + idx + " RETURNING *", values);
    if (!result.rows.length) return res.status(404).json({ error: "Account not found" });
    res.json(result.rows[0]);
  } catch (err) {
    console.error("update balance error:", err.message);
    res.status(500).json({ error: "Failed to update balance" });
  }
});

// PATCH /api/accounts/:id/shared — Mark account as shared/joint with spending split
router.patch("/api/accounts/:id/shared", async (req, res) => {
  const { is_shared, spending_split_pct } = req.body;
  try {
    const updates = []; const values = []; let idx = 1;
    if (is_shared !== undefined) { updates.push("is_shared = $" + idx++); values.push(!!is_shared); }
    if (spending_split_pct !== undefined) {
      const pct = Math.max(0, Math.min(100, parseInt(spending_split_pct) || 100));
      updates.push("spending_split_pct = $" + idx++); values.push(pct);
    }
    if (!updates.length) return res.status(400).json({ error: "No fields to update" });
    values.push(parseInt(req.params.id));
    const result = await pool.query("UPDATE linked_accounts SET " + updates.join(", ") + " WHERE id = $" + idx + " RETURNING *", values);
    if (!result.rows.length) return res.status(404).json({ error: "Account not found" });
    res.json(result.rows[0]);
  } catch (err) {
    console.error("update shared settings error:", err.message);
    res.status(500).json({ error: "Failed to update shared settings" });
  }
});

// DELETE /api/accounts/manual/:id — Delete a manual account
router.delete("/api/accounts/manual/:id", async (req, res) => {
  try {
    const result = await pool.query("DELETE FROM linked_accounts WHERE id = $1 AND is_manual = true RETURNING id", [parseInt(req.params.id)]);
    if (!result.rows.length) return res.status(404).json({ error: "Manual account not found" });
    res.json({ deleted: true });
  } catch (err) {
    console.error("delete manual account error:", err.message);
    res.status(500).json({ error: "Failed to delete account" });
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
          } catch (err) { console.error("Balance fetch error for", acct.id, ":", err.message); }

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
      `SELECT TO_CHAR(t.date, 'YYYY-MM') AS month,
              ROUND(SUM(t.amount * COALESCE(la.spending_split_pct, 100) / 100.0), 2) AS total_spend,
              COUNT(*) AS txn_count,
              ROUND(AVG(t.amount * COALESCE(la.spending_split_pct, 100) / 100.0), 2) AS avg_transaction
       FROM transactions t
       LEFT JOIN linked_accounts la ON la.account_id = t.account_id
       WHERE t.amount > 0 AND t.date >= CURRENT_DATE - ($1 || ' months')::INTERVAL
       GROUP BY TO_CHAR(t.date, 'YYYY-MM')
       ORDER BY month DESC`,
      [months]
    );

    const byCategory = await pool.query(
      `SELECT COALESCE(t.category[1], 'Uncategorized') AS category,
              ROUND(SUM(t.amount * COALESCE(la.spending_split_pct, 100) / 100.0), 2) AS total,
              COUNT(*) AS txn_count
       FROM transactions t
       LEFT JOIN linked_accounts la ON la.account_id = t.account_id
       WHERE t.amount > 0 AND t.date >= CURRENT_DATE - ($1 || ' months')::INTERVAL
       GROUP BY COALESCE(t.category[1], 'Uncategorized')
       ORDER BY total DESC
       LIMIT 15`,
      [months]
    );

    // Exclusion list uses word-boundary regex (\y) so short tokens like "atm",
    // "pymt", and "epay" can't substring-match legitimate merchants (AT&T,
    // Atmos Energy, etc.). Multi-word phrases still work because \y anchors
    // at the phrase edges, not inside the phrase.
    const topMerchants = await pool.query(
      `SELECT COALESCE(t.merchant_name, t.name) AS merchant,
              ROUND(SUM(t.amount * COALESCE(la.spending_split_pct, 100) / 100.0), 2) AS total_spent,
              COUNT(*) AS txn_count
       FROM transactions t
       LEFT JOIN linked_accounts la ON la.account_id = t.account_id
       WHERE t.amount > 0 AND t.merchant_name IS NOT NULL
             AND t.date >= CURRENT_DATE - ($1 || ' months')::INTERVAL
             AND COALESCE(t.merchant_name, t.name) !~*
               '\y(payment thank|pymt|autopay|auto pay|minimum payment|directpay|automatic payment|interest|int charge|finance charge|funds tran|funds transfer|transfer to|transfer from|ach transfer|wire transfer|internal transfer|zelle|venmo|paypal|cash app|cashapp|square cash|bank of america|wells fargo|chase bank|citi bank|citibank|capital one|us bank|pnc bank|td bank|ally bank|truist|boa transfer|online transfer|mobile transfer|bill pay|epay|credit card payment|loan payment|mortgage payment|deposit|direct dep|atm|withdrawal)\y'
       GROUP BY COALESCE(t.merchant_name, t.name)
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

    const recentTxns = await pool.query(
      `SELECT COALESCE(merchant_name, name) AS description,
              amount, date, pending,
              COALESCE(category[1], 'Uncategorized') AS category
       FROM transactions
       ORDER BY date DESC, created_at DESC
       LIMIT 10`
    );

    res.json({
      monthly_trend: monthlyTrend.rows,
      by_category: byCategory.rows,
      top_merchants: topMerchants.rows,
      upcoming_subscriptions: upcoming.rows,
      recent_transactions: recentTxns.rows,
    });
  } catch (err) {
    console.error("spending-summary error:", err.message);
    res.status(500).json({ error: "An internal error occurred." });
  }
});

// GET /api/cash-flow — Rolling 60/90-day cash flow projection
router.get("/api/cash-flow", async (req, res) => {
  const days = Math.min(Math.max(parseInt(req.query.days) || 90, 30), 180);
  try {
    // Get recent income patterns (last 3 months) — strict keyword match only,
    // no amount threshold (catches transfers/card payments as false income)
    const incomeResult = await pool.query(`
      SELECT COALESCE(merchant_name, name) AS source,
             ABS(amount) AS amount,
             date,
             EXTRACT(DAY FROM date::timestamp) AS day_of_month
      FROM transactions
      WHERE amount < 0 AND pending = false
        AND date >= CURRENT_DATE - INTERVAL '3 months'
        AND (LOWER(COALESCE(merchant_name, name, '')) LIKE '%payroll%'
          OR LOWER(COALESCE(merchant_name, name, '')) LIKE '%direct dep%'
          OR LOWER(COALESCE(merchant_name, name, '')) LIKE '%salary%'
          OR LOWER(COALESCE(merchant_name, name, '')) LIKE '%employer%'
          OR category[1] = 'Income')
        AND LOWER(COALESCE(merchant_name, name, '')) NOT SIMILAR TO
          '%(payment|transfer|pymt|zelle|venmo|paypal|cash app|refund|credit|reversal)%'
      ORDER BY date DESC
    `);

    // Detect recurring income (group by similar amounts ±10%)
    const incomeByAmount = {};
    for (const row of incomeResult.rows) {
      const amt = parseFloat(row.amount);
      let matched = false;
      for (const key of Object.keys(incomeByAmount)) {
        if (Math.abs(amt - parseFloat(key)) / parseFloat(key) < 0.1) {
          incomeByAmount[key].push(row);
          matched = true;
          break;
        }
      }
      if (!matched) incomeByAmount[amt.toFixed(2)] = [row];
    }

    // Find recurring income (2+ occurrences)
    const recurringIncome = [];
    for (const [amount, entries] of Object.entries(incomeByAmount)) {
      if (entries.length >= 2) {
        const days_between = [];
        for (let i = 1; i < entries.length; i++) {
          const diff = (new Date(entries[i-1].date) - new Date(entries[i].date)) / 86400000;
          days_between.push(Math.round(diff));
        }
        const avgInterval = days_between.reduce((s, d) => s + d, 0) / days_between.length;
        const cadence = avgInterval <= 10 ? 7 : avgInterval <= 20 ? 14 : 30;
        recurringIncome.push({
          source: entries[0].source,
          amount: parseFloat(amount),
          cadence_days: cadence,
          last_date: entries[0].date,
          typical_day: Math.round(entries.reduce((s, e) => s + parseInt(e.day_of_month), 0) / entries.length),
        });
      }
    }

    // Get upcoming bills from subscriptions + recurring transfers
    const [subsResult, transfersResult] = await Promise.all([
      pool.query(`
        SELECT display_name, amount, cadence_days, next_expected
        FROM detected_subscriptions
        WHERE is_active = true AND is_dismissed = false AND cancelled_at IS NULL
          AND next_expected IS NOT NULL
      `),
      pool.query(`
        SELECT display_name, amount, cadence_days, next_expected, transfer_type, direction
        FROM recurring_transfers
        WHERE is_active = true AND is_dismissed = false
          AND next_expected IS NOT NULL AND direction = 'outgoing'
      `),
    ]);

    // Combine subscriptions and outgoing recurring transfers into bill schedule
    const allBills = [...subsResult.rows, ...transfersResult.rows];

    // Pre-compute next occurrence for each bill (once, not per-day)
    const now = new Date();
    const billSchedule = allBills.map(sub => {
      let nextDate = new Date(sub.next_expected);
      const cadence = parseInt(sub.cadence_days);
      while (nextDate < now) nextDate = new Date(nextDate.getTime() + cadence * 86400000);
      const occurrences = [];
      const endDate = new Date(now.getTime() + (days + 1) * 86400000);
      while (nextDate <= endDate) {
        occurrences.push(nextDate.toISOString().split("T")[0]);
        nextDate = new Date(nextDate.getTime() + cadence * 86400000);
      }
      return { name: sub.display_name, amount: parseFloat(sub.amount), dates: new Set(occurrences) };
    });

    // Get current balances
    const balResult = await pool.query(`
      SELECT SUM(CASE WHEN type != 'credit' THEN COALESCE(available_balance, current_balance, 0) ELSE 0 END) AS cash,
             SUM(CASE WHEN type = 'credit' THEN COALESCE(current_balance, 0) ELSE 0 END) AS debt
      FROM linked_accounts
      WHERE available_balance IS NOT NULL OR current_balance IS NOT NULL
    `);
    let runningBalance = parseFloat(balResult.rows[0]?.cash || 0);

    // Get average daily discretionary spending (last 60 days, excluding subscription bills)
    // Also apply spending split for shared accounts
    const avgSpendResult = await pool.query(`
      SELECT COALESCE(AVG(daily_total), 0) AS avg_daily
      FROM (
        SELECT t.date, ROUND(SUM(t.amount * COALESCE(la.spending_split_pct, 100) / 100.0), 2) AS daily_total
        FROM transactions t
        LEFT JOIN linked_accounts la ON la.account_id = t.account_id
        WHERE t.amount > 0 AND t.pending = false
          AND t.date >= CURRENT_DATE - INTERVAL '60 days'
        GROUP BY t.date
      ) daily
    `);
    const avgDailySpend = parseFloat(avgSpendResult.rows[0]?.avg_daily || 0);

    // Get per-day-of-week spending averages for more realistic variation.
    // Generate every date in the 60-day window so that days with zero spending
    // are still included in each DOW's average — otherwise days with no debits
    // would skew the per-DOW means upward.
    const dowSpendResult = await pool.query(`
      WITH date_series AS (
        SELECT d::date AS date
        FROM generate_series(CURRENT_DATE - INTERVAL '60 days', CURRENT_DATE, '1 day'::interval) d
      ),
      daily_totals AS (
        SELECT t.date,
               SUM(t.amount * COALESCE(la.spending_split_pct, 100) / 100.0) AS daily_total
        FROM transactions t
        LEFT JOIN linked_accounts la ON la.account_id = t.account_id
        WHERE t.amount > 0 AND t.pending = false
          AND t.date >= CURRENT_DATE - INTERVAL '60 days'
        GROUP BY t.date
      )
      SELECT EXTRACT(DOW FROM ds.date) AS dow,
             COALESCE(AVG(COALESCE(dt.daily_total, 0)), 0) AS avg_daily
      FROM date_series ds
      LEFT JOIN daily_totals dt USING (date)
      GROUP BY EXTRACT(DOW FROM ds.date)
    `);
    const dowSpend = {};
    for (const r of dowSpendResult.rows) dowSpend[parseInt(r.dow)] = parseFloat(r.avg_daily);

    let totalIncome = 0;
    let totalBills = 0;
    let totalDiscretionary = 0;
    const projection = [];

    for (let d = 0; d < days; d++) {
      const date = new Date(now.getTime() + (d + 1) * 86400000);
      const dateStr = date.toISOString().split("T")[0];
      const dayOfMonth = date.getDate();
      const dow = date.getDay();
      let dayIncome = 0;
      let dayBills = 0;

      // Check for income
      for (const inc of recurringIncome) {
        if (inc.cadence_days === 30 && dayOfMonth === inc.typical_day) {
          dayIncome += inc.amount;
        } else if (inc.cadence_days === 14) {
          const lastDate = new Date(inc.last_date);
          const daysSinceLast = Math.round((date - lastDate) / 86400000);
          if (daysSinceLast > 0 && daysSinceLast % 14 === 0) dayIncome += inc.amount;
        } else if (inc.cadence_days === 7) {
          const lastDate = new Date(inc.last_date);
          const daysSinceLast = Math.round((date - lastDate) / 86400000);
          if (daysSinceLast > 0 && daysSinceLast % 7 === 0) dayIncome += inc.amount;
        }
      }

      // Check for bills (using pre-computed schedule)
      for (const bill of billSchedule) {
        if (bill.dates.has(dateStr)) dayBills += bill.amount;
      }

      // Use day-of-week spending average if available, else overall average
      const daySpend = dowSpend[dow] !== undefined ? dowSpend[dow] : avgDailySpend;

      runningBalance += dayIncome - dayBills - daySpend;
      totalIncome += dayIncome;
      totalBills += dayBills;
      totalDiscretionary += daySpend;

      projection.push({
        date: dateStr,
        income: Math.round(dayIncome * 100) / 100,
        bills: Math.round(dayBills * 100) / 100,
        discretionary: Math.round(daySpend * 100) / 100,
        balance: Math.round(runningBalance * 100) / 100,
      });
    }

    // Weekly summary
    const byWeek = [];
    for (let w = 0; w < Math.ceil(days / 7); w++) {
      const weekSlice = projection.slice(w * 7, (w + 1) * 7);
      byWeek.push({
        week: w + 1,
        start_date: weekSlice[0]?.date,
        income: Math.round(weekSlice.reduce((s, d) => s + d.income, 0) * 100) / 100,
        bills: Math.round(weekSlice.reduce((s, d) => s + d.bills, 0) * 100) / 100,
        discretionary: Math.round(weekSlice.reduce((s, d) => s + d.discretionary, 0) * 100) / 100,
        end_balance: weekSlice[weekSlice.length - 1]?.balance || 0,
      });
    }

    res.json({
      forecast_days: days,
      starting_balance: parseFloat(balResult.rows[0]?.cash || 0),
      avg_daily_spend: Math.round(avgDailySpend * 100) / 100,
      total_projected_income: Math.round(totalIncome * 100) / 100,
      total_projected_bills: Math.round(totalBills * 100) / 100,
      total_projected_discretionary: Math.round(totalDiscretionary * 100) / 100,
      ending_balance: projection[projection.length - 1]?.balance || 0,
      surplus_shortfall: Math.round((totalIncome - totalBills - totalDiscretionary) * 100) / 100,
      recurring_income: recurringIncome,
      by_week: byWeek,
    });
  } catch (err) {
    console.error("cash-flow error:", err.message);
    res.status(500).json({ error: "An internal error occurred." });
  }
});

// GET /api/spending-yoy — Year-over-year spending comparison
router.get("/api/spending-yoy", async (req, res) => {
  const month = parseInt(req.query.month) || new Date().getMonth() + 1;
  const year = parseInt(req.query.year) || new Date().getFullYear();
  try {
    const result = await pool.query(`
      SELECT TO_CHAR(t.date, 'YYYY') AS year,
             TO_CHAR(t.date, 'MM') AS month,
             COALESCE(t.category[1], 'Uncategorized') AS category,
             ROUND(SUM(t.amount * COALESCE(la.spending_split_pct, 100) / 100.0), 2) AS total,
             COUNT(*) AS txn_count
      FROM transactions t
      LEFT JOIN linked_accounts la ON la.account_id = t.account_id
      WHERE t.amount > 0 AND t.pending = false
        AND EXTRACT(MONTH FROM t.date) = $1
        AND EXTRACT(YEAR FROM t.date) >= $2 - 2
      GROUP BY TO_CHAR(t.date, 'YYYY'), TO_CHAR(t.date, 'MM'), COALESCE(t.category[1], 'Uncategorized')
      ORDER BY year DESC, total DESC
    `, [month, year]);

    // Group by year
    const byYear = {};
    for (const row of result.rows) {
      if (!byYear[row.year]) byYear[row.year] = { total: 0, txn_count: 0, categories: {} };
      byYear[row.year].total += parseFloat(row.total);
      byYear[row.year].txn_count += parseInt(row.txn_count);
      byYear[row.year].categories[row.category] = parseFloat(row.total);
    }

    // Calculate changes
    const years = Object.keys(byYear).sort().reverse();
    const comparisons = [];
    for (let i = 0; i < years.length - 1; i++) {
      const curr = byYear[years[i]];
      const prev = byYear[years[i + 1]];
      comparisons.push({
        current_year: years[i],
        previous_year: years[i + 1],
        current_total: Math.round(curr.total * 100) / 100,
        previous_total: Math.round(prev.total * 100) / 100,
        change_amount: Math.round((curr.total - prev.total) * 100) / 100,
        change_percent: prev.total > 0 ? Math.round(((curr.total - prev.total) / prev.total) * 10000) / 100 : null,
        category_changes: Object.keys({...curr.categories, ...prev.categories}).map(cat => ({
          category: cat,
          current: Math.round((curr.categories[cat] || 0) * 100) / 100,
          previous: Math.round((prev.categories[cat] || 0) * 100) / 100,
          change: Math.round(((curr.categories[cat] || 0) - (prev.categories[cat] || 0)) * 100) / 100,
        })).sort((a, b) => Math.abs(b.change) - Math.abs(a.change)),
      });
    }

    const monthNames = ['January','February','March','April','May','June','July','August','September','October','November','December'];
    res.json({
      month: month,
      month_name: monthNames[month - 1],
      by_year: byYear,
      comparisons,
    });
  } catch (err) {
    console.error("yoy error:", err.message);
    res.status(500).json({ error: "An internal error occurred." });
  }
});

// GET /api/savings-rate — Income detection + savings rate calculation
router.get("/api/savings-rate", async (req, res) => {
  const months = parseInt(req.query.months) || 3;
  try {
    // Detect income (negative amounts = credits/income in normalized system)
    // Strict keyword matching only — no amount threshold (avoids counting transfers/payments as income)
    const incomeResult = await pool.query(`
      SELECT TO_CHAR(date, 'YYYY-MM') AS month,
             SUM(ABS(amount)) AS total_income
      FROM transactions
      WHERE amount < 0 AND pending = false
        AND date >= CURRENT_DATE - make_interval(months => $1)
        AND (LOWER(COALESCE(merchant_name, name, '')) LIKE '%payroll%'
          OR LOWER(COALESCE(merchant_name, name, '')) LIKE '%direct dep%'
          OR LOWER(COALESCE(merchant_name, name, '')) LIKE '%salary%'
          OR LOWER(COALESCE(merchant_name, name, '')) LIKE '%employer%'
          OR category[1] = 'Income')
        AND LOWER(COALESCE(merchant_name, name, '')) NOT SIMILAR TO
          '%(payment|transfer|pymt|zelle|venmo|paypal|cash app|refund|credit|reversal)%'
      GROUP BY TO_CHAR(date, 'YYYY-MM')
      ORDER BY month DESC
    `, [months]);

    const spendResult = await pool.query(`
      SELECT TO_CHAR(t.date, 'YYYY-MM') AS month,
             ROUND(SUM(t.amount * COALESCE(la.spending_split_pct, 100) / 100.0), 2) AS total_spend
      FROM transactions t
      LEFT JOIN linked_accounts la ON la.account_id = t.account_id
      WHERE t.amount > 0 AND t.pending = false
        AND t.date >= CURRENT_DATE - make_interval(months => $1)
      GROUP BY TO_CHAR(t.date, 'YYYY-MM')
      ORDER BY month DESC
    `, [months]);

    const incomeMap = {};
    for (const r of incomeResult.rows) incomeMap[r.month] = parseFloat(r.total_income);
    const spendMap = {};
    for (const r of spendResult.rows) spendMap[r.month] = parseFloat(r.total_spend);

    const allMonths = [...new Set([...Object.keys(incomeMap), ...Object.keys(spendMap)])].sort().reverse();
    const monthly = allMonths.map(m => {
      const income = incomeMap[m] || 0;
      const spending = spendMap[m] || 0;
      const saved = income - spending;
      const rate = income > 0 ? Math.round((saved / income) * 10000) / 100 : 0;
      return { month: m, income: Math.round(income * 100) / 100, spending: Math.round(spending * 100) / 100, saved: Math.round(saved * 100) / 100, savings_rate: rate };
    });

    const totalIncome = monthly.reduce((s, m) => s + m.income, 0);
    const totalSpending = monthly.reduce((s, m) => s + m.spending, 0);
    const avgIncome = monthly.length ? totalIncome / monthly.length : 0;
    const avgSpending = monthly.length ? totalSpending / monthly.length : 0;
    const avgSaved = avgIncome - avgSpending;
    const avgRate = avgIncome > 0 ? Math.round((avgSaved / avgIncome) * 10000) / 100 : 0;

    // 50/30/20 analysis
    const needsRatio = avgIncome > 0 ? Math.round((avgSpending * 0.5 / avgIncome) * 10000) / 100 : 0;

    res.json({
      months: monthly,
      averages: {
        income: Math.round(avgIncome * 100) / 100,
        spending: Math.round(avgSpending * 100) / 100,
        saved: Math.round(avgSaved * 100) / 100,
        savings_rate: avgRate,
      },
      recommendation: avgRate >= 20 ? "Excellent! You're saving 20%+ of income." :
                       avgRate >= 10 ? "Good savings rate. Try to reach 20% for long-term wealth building." :
                       avgRate > 0 ? "You're saving, but aim for at least 10-20% of income." :
                       "Spending exceeds detected income. Review expenses or add income sources.",
    });
  } catch (err) {
    console.error("savings-rate error:", err.message);
    res.status(500).json({ error: "An internal error occurred." });
  }
});

// GET /api/csv-reminder — Check if CSV import is due
router.get("/api/csv-reminder", async (_req, res) => {
  try {
    const settings = await pool.query("SELECT csv_reminder_days, csv_reminder_enabled FROM user_settings WHERE id = 1");
    const reminderDays = settings.rows[0]?.csv_reminder_days || 14;
    const enabled = settings.rows[0]?.csv_reminder_enabled !== false;

    if (!enabled) return res.json({ due: false, enabled: false });

    // Find manual accounts and their last CSV import
    const result = await pool.query(`
      SELECT la.id, la.name, la.institution_name_manual AS institution,
             ci.imported_at AS last_import,
             EXTRACT(DAY FROM (CURRENT_TIMESTAMP - ci.imported_at)) AS days_since
      FROM linked_accounts la
      LEFT JOIN LATERAL (
        SELECT imported_at FROM csv_imports
        WHERE LOWER(institution) = LOWER(COALESCE(la.institution_name_manual, ''))
           OR LOWER(account_label) = LOWER(la.name)
        ORDER BY imported_at DESC LIMIT 1
      ) ci ON true
      WHERE la.is_manual = true
      ORDER BY ci.imported_at ASC NULLS FIRST
    `);

    const reminders = result.rows
      .filter(r => !r.last_import || parseInt(r.days_since) >= reminderDays)
      .map(r => ({
        account_id: r.id,
        account_name: r.name,
        institution: r.institution,
        last_import: r.last_import,
        days_since: r.days_since ? parseInt(r.days_since) : null,
        message: r.last_import
          ? `${r.name}: Last CSV import was ${parseInt(r.days_since)} days ago`
          : `${r.name}: No CSV imports found — upload a CSV to track transactions`,
      }));

    res.json({
      due: reminders.length > 0,
      enabled,
      reminder_days: reminderDays,
      reminders,
    });
  } catch (err) {
    console.error("csv-reminder error:", err.message);
    res.status(500).json({ error: "An internal error occurred." });
  }
});

module.exports = router;
