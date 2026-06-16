// ============================================================================
// Routes: Enrollment, Sync, Items, Accounts
// ============================================================================

const express = require("express");
const router = express.Router();
const { pool, ENCRYPTION_PASSPHRASE } = require("../services/database");
const { tellerRequest } = require("../services/teller-api");
const { INCOME_PREDICATE, NOT_TRANSFER, INVESTMENT_ACCOUNT_TYPES, SPLIT_AMOUNT, getMonthlySpending, getMonthlyIncome, getCategorySpendingForMonth } = require("../services/financial-queries");

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
async function syncEnrollment(enrollment, opts = {}) {
  const { id: enrollmentDbId, access_token, last_synced_txn_date, institution_name } = enrollment;

  // Reconciliation/backfill mode: when opts.backfillFrom is set, re-fetch from
  // that date floor regardless of the stored incremental watermark, and do NOT
  // advance the watermark (this is a recovery pass, not the incremental cursor).
  // Re-fetching is safe because the INSERT below upserts on transaction_id.
  const backfillFrom = opts.backfillFrom || null;
  const floorDate = backfillFrom || last_synced_txn_date;

  const { rows: accounts } = await pool.query(
    `SELECT account_id FROM linked_accounts WHERE teller_enrollment_id = $1`,
    [enrollmentDbId]
  );

  let added = 0;
  let latestDate = last_synced_txn_date;
  // If ANY account in this enrollment fails to fetch (fully), we hold back the
  // enrollment-level watermark so the next sync retries from the same point.
  // Otherwise an earlier account that synced to "today" would advance the
  // shared watermark and permanently skip a failed sibling account's older
  // un-synced transactions (F3). Re-processing is safe — the insert below
  // upserts on transaction_id.
  let fetchError = false;

  // Teller paginates newest-first; `from_id` returns rows OLDER than that id.
  // We request an explicit page size and do NOT assume what Teller's default is:
  // page until Teller returns an empty page (no older rows) or we cross the
  // floor date, with a hard page cap as a runaway guard. The previous
  // `txns.length < 500` stop hard-coded a 500-row page assumption — if Teller's
  // page size is smaller than 500 (the default is not documented as 500), the
  // first full page satisfied `< 500`, `from_id` pagination never advanced, and
  // history was capped at a single page while the watermark stepped past
  // everything older (BS-1). Terminating on an empty page makes this correct
  // regardless of the actual page size.
  const PAGE = 500;
  const MAX_PAGES = 100; // runaway guard: 100 * 500 = 50k txns/account
  for (const { account_id } of accounts) {
    let allTxns = [];
    let endpoint = `/accounts/${account_id}/transactions?count=${PAGE}`;

    let pages = 0;
    while (pages < MAX_PAGES) {
      pages++;
      let txns;
      try {
        txns = await tellerRequest(endpoint, access_token);
      } catch (fetchErr) {
        console.error(`  Error fetching transactions for account ${account_id}:`, fetchErr.message);
        fetchError = true;
        break;
      }

      if (!txns || txns.length === 0) break;
      allTxns = allTxns.concat(txns);

      const oldestInBatch = txns[txns.length - 1];
      // Reached the incremental/backfill floor — older rows aren't needed.
      if (floorDate && new Date(oldestInBatch.date) <= new Date(floorDate)) break;
      if (pages === MAX_PAGES) {
        console.warn(`  ${account_id}: hit MAX_PAGES (${MAX_PAGES}); older history beyond ${allTxns.length} txns not fetched this run.`);
        break;
      }
      // Page to OLDER transactions; terminates when Teller returns an empty page.
      endpoint = `/accounts/${account_id}/transactions?count=${PAGE}&from_id=${oldestInBatch.id}`;
    }

    // Use >= (not >) against the day-granular watermark: Teller transaction
    // `date` is day-granular, so a transaction that posts on the watermark day
    // AFTER a sync ran would be `=` and never `>`, dropping it forever (F6).
    // Re-including the whole watermark day is safe — the ON CONFLICT upsert
    // below dedups rows already inserted on that day.
    const txnsToProcess = floorDate
      ? allTxns.filter(t => new Date(t.date) >= new Date(floorDate))
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
             pending = EXCLUDED.pending
           RETURNING (xmax = 0) AS inserted`,
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

        // Count only genuine inserts, not ON-CONFLICT updates (rowCount is 1 for
        // both). `xmax = 0` is true only for a fresh insert, so re-syncing
        // existing rows no longer inflates `added` and triggers false
        // "new activity" notifications / anomaly passes (F16).
        if (result.rows[0]?.inserted) {
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

  // Only advance the watermark when every account fetched cleanly AND this is a
  // normal incremental sync — a backfill/reconcile pass must not move the
  // incremental cursor (it deliberately re-reads old data). On a fetch error we
  // leave last_synced_txn_date untouched so the next sync re-attempts the failed
  // account's range instead of stepping over it (F3).
  if (latestDate && !fetchError && !backfillFrom) {
    await pool.query(
      `UPDATE teller_enrollments SET last_synced_txn_date = $1, updated_at = now()
       WHERE id = $2`,
      [latestDate, enrollmentDbId]
    );
  }

  console.log(`  ${institution_name}: ${added} added/updated`);
  // `incomplete` = at least one account in this enrollment failed to fetch, so
  // the watermark was held back (INV-02) and the next sync will retry that
  // range. Surfaced by syncAllEnrollments so the partial failure is visible in
  // Sync Health rather than reported as a clean success (F15).
  return { added, incomplete: fetchError };
}

// syncAllEnrollments — in-process sync of every non-suspended Teller enrollment.
// Used by both POST /api/sync (HTTP handler) and the scheduled auto-sync task
// in server.js. Returns { enrollments_synced, transactions_added, errors }.
async function syncAllEnrollments(opts = {}) {
  // Backfill/reconcile mode: opts.backfillDays re-fetches the trailing N days
  // from every enrollment regardless of the incremental watermark, to recover
  // any transactions a prior sync dropped (idempotent upserts). The anomaly
  // push is suppressed in this mode because re-upserting historical rows would
  // otherwise look like a flood of "new" activity.
  const backfillDays = Number.isFinite(opts.backfillDays) ? opts.backfillDays : null;
  let backfillFrom = null;
  if (backfillDays) {
    const d = new Date();
    d.setDate(d.getDate() - backfillDays);
    backfillFrom = d.toISOString().split("T")[0];
  }

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
  // Hard failures = enrollments that did NOT sync at all (token decryption
  // failed, or syncEnrollment threw). A partial failure (some accounts synced,
  // one fetch errored) is NOT a hard failure — it's surfaced in errors[] for
  // visibility but still counts as a synced enrollment (F15).
  let hardFailures = 0;

  for (const enrollment of enrollments) {
    // A NULL decrypted token means the TOKEN_ENCRYPTION_PASSPHRASE no longer
    // matches the ciphertext (e.g. after a passphrase rotation). Surface it as
    // `decryption_failed` (parity with the Plaid sync paths) instead of letting
    // a null token reach Teller, 401, and silently mark the enrollment
    // DISCONNECTED — which would wrongly require re-linking on a key rotation (F7).
    if (!enrollment.access_token) {
      console.error(`Teller enrollment "${enrollment.institution_name}": token decryption failed (passphrase mismatch?) — skipping, not disconnecting.`);
      errors.push({ institution: enrollment.institution_name, error: "decryption_failed" });
      hardFailures++;
      continue;
    }
    try {
      const result = await syncEnrollment(enrollment, { backfillFrom });
      totalAdded += result.added;
      if (result.incomplete) {
        // Partial failure: some accounts synced, one fetch errored and the
        // watermark was held back. Surface it (without marking the whole
        // enrollment unsynced) so Sync Health / last_sync_result shows the
        // enrollment needs a retry instead of looking clean (F15).
        errors.push({ institution: enrollment.institution_name, error: "partial_sync_incomplete" });
      }
    } catch (err) {
      console.error(`Sync error for ${enrollment.institution_name}:`, err.message);
      if (err.status === 401 || err.status === 403) {
        await pool.query(
          `UPDATE teller_enrollments SET status = 'DISCONNECTED', updated_at = now()
           WHERE id = $1`,
          [enrollment.id]
        );
      }
      errors.push({ institution: enrollment.institution_name, error: err.message });
      hardFailures++;
    }
  }

  // Anomaly detection + push notifications. Correctness details:
  //   1. Baseline average excludes the trailing 7 days so the candidate
  //      doesn't inflate its own baseline.
  //   2. Only transactions inserted since last_anomaly_check_at are considered,
  //      so the same anomaly doesn't re-push on subsequent syncs.
  if (totalAdded > 0 && !backfillFrom) {
    try {
      const settings = await pool.query("SELECT last_anomaly_check_at FROM user_settings WHERE id = 1");
      const watermark = settings.rows[0]?.last_anomaly_check_at || null;
      // Group merchants by user_merchant_name when the user has set one, so a
      // user-merged merchant ('Amazon' replacing 'AMAZON MKTP*4321' / 'AMZN.COM')
      // accumulates a single baseline rather than three under-the-threshold ones.
      const anomalies = await pool.query(
        `SELECT t.merchant_name, t.name, t.user_merchant_name, t.amount, t.date, avg_tbl.avg_amount
         FROM transactions t
         JOIN (
           SELECT LOWER(COALESCE(t.user_merchant_name, t.merchant_name, t.name)) AS merchant,
                  AVG(t.amount) AS avg_amount, COUNT(*) AS txn_count
           FROM transactions t
           WHERE t.amount > 0 AND t.pending = false
             AND t.date >= CURRENT_DATE - INTERVAL '12 months'
             AND t.date <  CURRENT_DATE - INTERVAL '7 days'
             AND ${NOT_TRANSFER}
           GROUP BY LOWER(COALESCE(t.user_merchant_name, t.merchant_name, t.name))
           HAVING COUNT(*) >= 3
         ) avg_tbl ON LOWER(COALESCE(t.user_merchant_name, t.merchant_name, t.name)) = avg_tbl.merchant
         WHERE t.amount > 0 AND t.pending = false
           AND COALESCE(t.is_reimbursed, false) = false
           AND ${NOT_TRANSFER}
           -- 7-day window (F7) matches the baseline's 7-day exclusion below, so a
           -- late-POSTING charge (synced today but dated up to a week ago — caught
           -- by created_at > watermark) is still eligible, while staying disjoint
           -- from the baseline so a candidate never inflates its own average.
           AND t.date >= CURRENT_DATE - INTERVAL '7 days'
           AND t.amount > avg_tbl.avg_amount * 3
           AND ($1::timestamptz IS NULL OR t.created_at > $1)
         ORDER BY t.amount DESC
         LIMIT 5`,
        [watermark]
      );
      // Track whether the notify loop itself failed. If it did, leave the
      // watermark alone so the next sync re-considers the same candidates —
      // otherwise a transient sendToAll error would permanently silence the
      // anomaly (the watermark advances past the row's created_at, and the
      // next pass filters it out).
      let notifyFailed = false;
      if (anomalies.rows.length > 0) {
        try {
          const { sendToAll } = require("./notifications");
          for (const a of anomalies.rows) {
            const merchant = a.user_merchant_name || a.merchant_name || a.name;
            await sendToAll({
              title: "Unusual charge detected",
              body: merchant + ": $" + parseFloat(a.amount).toFixed(2) + " (avg: $" + parseFloat(a.avg_amount).toFixed(2) + ")",
              tag: "anomaly-" + merchant.toLowerCase().replace(/\s+/g, "-"),
              data: { url: "/transactions" },
            });
          }
        } catch (notifyErr) {
          notifyFailed = true;
          console.error("Anomaly notification dispatch error:", notifyErr.message);
        }
        // Opt-in critical-alert email — ONE summary per sync run, not one per
        // anomaly. Email failure is deliberately NOT notifyFailed: it must not
        // hold back the push watermark (the push already went out).
        try {
          const { sendCriticalAlertEmail } = require("./persistent");
          const lines = anomalies.rows.map(a => {
            const m = a.user_merchant_name || a.merchant_name || a.name;
            return m + ": $" + parseFloat(a.amount).toFixed(2) + " (typical: $" + parseFloat(a.avg_amount).toFixed(2) + ")";
          }).join("\n");
          await sendCriticalAlertEmail(
            anomalies.rows.length > 1 ? "Unusual charges detected" : "Unusual charge detected",
            lines
          );
        } catch (e) { console.error("Anomaly alert email error:", e.message); }
      }
      if (!notifyFailed) {
        await pool.query("UPDATE user_settings SET last_anomaly_check_at = now() WHERE id = 1")
          .catch(err => console.error("Anomaly watermark update error:", err.message));
      }
    } catch (err) {
      console.error("Post-sync anomaly check error:", err.message);
    }
  }

  return {
    // Count enrollments that connected and synced (fully or partially); only
    // HARD failures (decryption/throw) are excluded. A partial-sync enrollment
    // still appears in errors[] for visibility but counts as synced (F15).
    enrollments_synced: enrollments.length - hardFailures,
    transactions_added: totalAdded,
    errors: errors.length > 0 ? errors : undefined,
  };
}

// recordSyncResult — persist a structured summary of the most recent sync run
// (any path) to user_settings.last_sync_result so per-item errors surface in
// the Sync Health card (GET /api/data-health) instead of only living in a
// manual-sync HTTP payload (addition D). `parts` is [{ provider, result }];
// each result's `errors` array (e.g. [{ institution, error: "decryption_failed" }])
// is flattened. Returns the persisted payload so callers can diff it.
async function recordSyncResult(parts) {
  const errors = [];
  for (const { provider, result } of parts) {
    if (result && Array.isArray(result.errors)) {
      for (const e of result.errors) {
        errors.push({
          provider,
          institution: e && e.institution ? e.institution : null,
          error: e && e.error ? e.error : String(e),
        });
      }
    }
  }
  const payload = { at: new Date().toISOString(), errors };
  await pool.query(
    "UPDATE user_settings SET last_sync_result = $1 WHERE id = 1",
    [JSON.stringify(payload)]
  ).catch(e => console.error("record sync result error:", e.message));
  return payload;
}

// POST /api/sync
router.post("/api/sync", async (req, res) => {
  try {
    const result = await syncAllEnrollments();
    // Update data freshness timestamp
    await pool.query(
      "UPDATE user_settings SET last_txn_sync_at = now() WHERE id = 1"
    ).catch(() => {});
    await recordSyncResult([{ provider: "teller_txn", result }]);
    res.json(result);
  } catch (err) {
    console.error("Sync error:", err.message);
    res.status(500).json({ error: "An internal error occurred." });
  }
});

// reconcileTeller — re-fetch the trailing N days from every Teller enrollment,
// watermark-independent, to recover any transactions a prior incremental sync
// dropped (same-day late arrivals, a failed-sibling-account skip, etc.). All
// writes are idempotent upserts, so this is safe to run repeatedly.
async function reconcileTeller(days = 90) {
  const backfillDays = Math.max(1, Math.min(365, parseInt(days, 10) || 90));
  return syncAllEnrollments({ backfillDays });
}

// runReconcile — the actual backfill work, shared by the synchronous and
// background code paths. Teller re-fetches the trailing window; Plaid resets
// each item's cursor and re-walks transactionsSync (idempotent upserts).
// Stamps last_reconcile_at on completion.
async function runReconcile(days, provider) {
  const out = { days, provider };
  if (provider === "teller" || provider === "all") {
    reconcileJob.phase = "Re-fetching Teller transactions";
    try { out.teller = await reconcileTeller(days); }
    catch (e) { out.teller = { error: e.message }; }
  }
  if (provider === "plaid" || provider === "all") {
    reconcileJob.phase = "Re-walking Plaid history (this is the slow part)";
    try {
      const { reconcilePlaidTransactions } = require("./investments");
      out.plaid = await reconcilePlaidTransactions();
    } catch (e) { out.plaid = { error: e.message }; }
  }
  reconcileJob.phase = "Finalizing";
  await pool.query("UPDATE user_settings SET last_reconcile_at = now(), last_txn_sync_at = now() WHERE id = 1").catch(() => {});
  return out;
}

// In-memory background-reconcile tracker. The Plaid leg is a full cursor
// re-walk (up to 2 years across every item) and can take a while, so the UI
// runs it in the background and polls /status; on completion we push a
// notification. Single-operator, single-process app → one job at a time.
let reconcileJob = { running: false, phase: null, started_at: null, finished_at: null, provider: null, days: null, result: null, error: null };

function summarizeReconcile(out) {
  const leg = (r) => r ? (r.error ? "error" : ((r.transactions_added ?? r.added ?? 0) + " recovered")) : null;
  const parts = [];
  if (out.teller) parts.push("Teller: " + leg(out.teller));
  if (out.plaid) parts.push("Plaid: " + (out.plaid.error ? "error" : ((out.plaid.transactions_added ?? 0) + " recovered")));
  return parts.join(", ") || "Done.";
}

// POST /api/sync/reconcile — manual backfill/reconciliation across providers.
// Body: { days?: 1-365 (default 90), provider?: 'teller' | 'plaid' | 'all',
//         background?: bool }. Synchronous by default (returns the per-provider
// summary inline — the contract API/CLI callers rely on). With
// `background: true` the work runs detached and the route returns 202
// immediately; poll GET /api/sync/reconcile/status and watch for the
// "Reconcile complete" notification.
router.post("/api/sync/reconcile", async (req, res) => {
  const days = Math.max(1, Math.min(365, parseInt(req.body.days, 10) || 90));
  const provider = ["teller", "plaid", "all"].includes(req.body.provider) ? req.body.provider : "all";

  if (req.body.background === true) {
    if (reconcileJob.running) {
      return res.status(409).json({ running: true, started_at: reconcileJob.started_at, error: "A reconcile is already running." });
    }
    reconcileJob = { running: true, phase: "Starting", started_at: new Date().toISOString(), finished_at: null, provider, days, result: null, error: null };
    // Fire-and-forget. Completion is reported via the status endpoint + a push.
    (async () => {
      let out;
      try { out = await runReconcile(days, provider); }
      catch (e) { out = { days, provider, error: e.message }; }
      reconcileJob.running = false;
      reconcileJob.finished_at = new Date().toISOString();
      reconcileJob.result = out;
      reconcileJob.error = out.error || null;
      try {
        const { sendToAll } = require("./notifications");
        await sendToAll({
          title: out.error ? "Reconcile finished with errors" : "Reconcile complete",
          body: summarizeReconcile(out),
          tag: "reconcile",
          data: { url: "/settings" },
        });
      } catch {}
    })();
    return res.status(202).json({ started: true, running: true, provider, days });
  }

  try {
    const out = await runReconcile(days, provider);
    res.json(out);
  } catch (err) {
    console.error("Reconcile error:", err.message);
    res.status(500).json({ error: "An internal error occurred." });
  }
});

// GET /api/sync/reconcile/status — poll the background reconcile job state.
router.get("/api/sync/reconcile/status", (_req, res) => {
  res.json(reconcileJob);
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
    // is_investment flags Teller-linked brokerage / IRA / 401k / HSA / 529 /
    // pension accounts so the UI can group them as "Investments" instead of
    // showing them mixed in with cash/credit. Teller exposes balance only
    // (no holdings / cost basis) — see services/financial-queries.js
    // INVESTMENT_ACCOUNT_TYPES for the detection list.
    const result = await pool.query(
      `SELECT la.id, la.account_id, la.name, la.official_name, la.type, la.subtype, la.mask,
              la.available_balance, la.current_balance, la.balance_currency, la.balance_updated_at, la.apr,
              la.monthly_payment,
              COALESCE(te.institution_name, pi.institution_name, la.institution_name_manual) AS institution_name,
              CASE WHEN te.id IS NOT NULL THEN 'teller' WHEN la.is_manual THEN 'manual' ELSE 'plaid' END AS provider,
              la.is_manual, la.credit_limit, la.is_shared, la.spending_split_pct,
              ${INVESTMENT_ACCOUNT_TYPES} AS is_investment
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
  // "loan" supports manually-tracked debt (e.g. an auto loan at a credit
  // union whose loan account doesn't surface through Plaid) — counts as a
  // liability in net worth and renders under the dashboard's Loans group.
  const validTypes = ["depository", "credit", "loan"];
  if (!validTypes.includes(type)) return res.status(400).json({ error: "type must be depository, credit, or loan" });
  try {
    const accountId = "manual_" + Date.now() + "_" + Math.random().toString(36).slice(2, 8);
    const result = await pool.query(
      `INSERT INTO linked_accounts (account_id, name, type, subtype, is_manual, institution_name_manual, current_balance, available_balance, credit_limit, balance_updated_at)
       VALUES ($1, $2, $3, $4, true, $5, $6, $7, $8, now()) RETURNING *`,
      [accountId, name, type, subtype || (type === "credit" ? "credit_card" : type === "loan" ? "auto" : "checking"),
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
  const { apr, monthly_payment } = req.body;
  try {
    const updates = []; const values = []; let idx = 1;
    if (apr !== undefined) {
      const val = apr === null || apr === "" ? null : parseFloat(apr);
      if (val !== null && (isNaN(val) || val < 0 || val > 99.99)) {
        return res.status(400).json({ error: "APR must be between 0 and 99.99" });
      }
      updates.push("apr = $" + idx++); values.push(val);
    }
    // Manual monthly payment for loan accounts — Plaid Liabilities never
    // reports auto-loan terms, so this drives the payoff projection.
    if (monthly_payment !== undefined) {
      const val = monthly_payment === null || monthly_payment === "" ? null : parseFloat(monthly_payment);
      if (val !== null && (isNaN(val) || val <= 0 || val > 9999999)) {
        return res.status(400).json({ error: "monthly_payment must be a positive number" });
      }
      updates.push("monthly_payment = $" + idx++); values.push(val);
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

// syncAllBalances — in-process balance refresh for all connected Teller
// enrollments. Used by both POST /api/sync-balances and the scheduled
// auto-sync task in server.js.
async function syncAllBalances() {
  const enrollments = await pool.query(
    `SELECT id, enrollment_id, institution_name,
            pgp_sym_decrypt(access_token_enc, $1) AS access_token
     FROM teller_enrollments WHERE status = 'GOOD'`,
    [ENCRYPTION_PASSPHRASE]
  );

  let updated = 0;
  const errors = [];

  for (const enrollment of enrollments.rows) {
    // See syncAllEnrollments: a NULL decrypted token signals a passphrase
    // mismatch — surface decryption_failed rather than 401-ing against Teller (F7).
    if (!enrollment.access_token) {
      errors.push({ institution: enrollment.institution_name, error: "decryption_failed" });
      continue;
    }
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
          const availNum = available ? parseFloat(available) : null;
          const ledgerNum = ledger ? parseFloat(ledger) : null;
          // Persist current values to linked_accounts AND append a daily
          // history row so we can chart per-account performance over time.
          // RETURNING gets the linked_accounts.id we need for the snapshot
          // FK without a second SELECT round-trip. The snapshot UPSERT keeps
          // intra-day re-syncs to one row per account per day.
          const updateResult = await pool.query(
            `UPDATE linked_accounts
             SET available_balance = $1, current_balance = $2, balance_updated_at = now()
             WHERE account_id = $3
             RETURNING id`,
            [availNum, ledgerNum, acct.id]
          );
          updated++;
          const linkedAcctId = updateResult.rows[0]?.id;
          if (linkedAcctId) {
            const dailyBalance = ledgerNum !== null ? ledgerNum : availNum;
            await pool.query(
              `INSERT INTO account_balance_snapshots
                 (source, source_id, snapshot_date, balance, available_balance, current_balance)
               VALUES ('linked', $1, CURRENT_DATE, $2, $3, $4)
               ON CONFLICT (source, source_id, snapshot_date) DO UPDATE SET
                 balance = EXCLUDED.balance,
                 available_balance = EXCLUDED.available_balance,
                 current_balance = EXCLUDED.current_balance`,
              [linkedAcctId, dailyBalance, availNum, ledgerNum]
            ).catch(e => console.error("balance snapshot insert error:", e.message));
          }
        }
      }
    } catch (err) {
      errors.push({ institution: enrollment.institution_name, error: err.message });
    }
  }

  // Auto-snapshot net worth after balance sync. Uses the shared getNetWorth
  // (F1) so this write includes investments + dedupes Plaid-in-both-tables —
  // previously it summed linked_accounts ONLY (and wrote no breakdown), so it
  // clobbered the investment-inclusive snapshot the hourly job wrote, making
  // net worth oscillate intra-day.
  try {
    const { getNetWorth } = require("../services/financial-queries");
    const nw = await getNetWorth(pool);
    await pool.query(
      `INSERT INTO net_worth_snapshots (total_assets, total_liabilities, net_worth, breakdown, snapshot_date)
       VALUES ($1, $2, $3, $4, CURRENT_DATE)
       ON CONFLICT (snapshot_date) DO UPDATE SET
         total_assets = $1, total_liabilities = $2, net_worth = $3, breakdown = $4`,
      [nw.total_assets, nw.total_liabilities, nw.net_worth, JSON.stringify(nw.breakdown)]
    );
  } catch { /* non-critical */ }
  return { accounts_updated: updated, errors: errors.length > 0 ? errors : undefined };
}

// POST /api/sync-balances
router.post("/api/sync-balances", async (_req, res) => {
  try {
    const tellerResult = await syncAllBalances();
    // Also refresh Plaid balances so users with both providers get one-click
    // freshness. Lazy-required to avoid a circular import via routes/investments.
    let plaidResult = null;
    let holdingsResult = null;
    let flowsResult = null;
    let plaidThrew = null;
    try {
      const inv = require("./investments");
      if (typeof inv.syncAllPlaidBalances === "function") {
        plaidResult = await inv.syncAllPlaidBalances();
      }
      // Also refresh investment holdings so brokerage values + the
      // investment_accounts rows repopulate from one "Sync Balances" click
      // (notably right after a fresh-start reset, when those rows were wiped).
      if (typeof inv.syncAllPlaidHoldings === "function") {
        holdingsResult = await inv.syncAllPlaidHoldings();
      }
      // And external cash flows (TWR/XIRR) — idempotent full-window re-pull.
      if (typeof inv.syncAllPlaidInvestmentFlows === "function") {
        flowsResult = await inv.syncAllPlaidInvestmentFlows();
      }
    } catch (e) {
      // A wholesale throw (vs. per-item errors collected inside the helpers)
      // used to be only console.error'd, so a total Plaid balance/holdings
      // failure left no trace in last_sync_result and was invisible on the
      // Sync Health card (BS-6). Capture it so recordSyncResult surfaces it.
      console.error("Plaid balance/holdings sync error:", e.message);
      plaidThrew = e.message;
    }
    await pool.query(
      "UPDATE user_settings SET last_balance_sync_at = now() WHERE id = 1"
    ).catch(() => {});
    await recordSyncResult([
      { provider: "teller_balance", result: tellerResult },
      { provider: "plaid_balance", result: plaidResult },
      { provider: "plaid_holdings", result: holdingsResult },
      ...(plaidThrew ? [{ provider: "plaid", result: { errors: [{ institution: null, error: plaidThrew }] } }] : []),
    ]);
    res.json({
      ...tellerResult,
      plaid_accounts_updated: plaidResult?.accounts_updated || 0,
      plaid_errors: plaidResult?.errors?.length ? plaidResult.errors : undefined,
      holdings_updated: holdingsResult?.holdings_updated || 0,
      holdings_accounts_updated: holdingsResult?.accounts_updated || 0,
      holdings_errors: holdingsResult?.errors?.length ? holdingsResult.errors : undefined,
      flows_added: flowsResult?.flows_added || 0,
      flows_errors: flowsResult?.errors?.length ? flowsResult.errors : undefined,
    });
  } catch (err) {
    console.error("sync-balances error:", err.message);
    res.status(500).json({ error: "An internal error occurred." });
  }
});

// =========================================================================
// Spending/income analytics endpoints — extracted to
// routes/spending-analytics.js (route-file split). This file mounts the
// sub-router so /api/spending-summary etc. keep their paths; sync + account
// management stays here.
// =========================================================================
const spendingAnalytics = require("./spending-analytics");
router.use(spendingAnalytics);

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

// GET /api/accounts/:id/balance-history — Daily balance series for charting.
// `source` query param defaults to 'linked' (linked_accounts row); pass
// 'investment' to read snapshots for an investment_accounts row instead.
// Returns { source, account_id, snapshots: [{ snapshot_date, balance, ... }] }
// ordered oldest-first so charting libraries render left-to-right.
router.get("/api/accounts/:id/balance-history", async (req, res) => {
  const months = Math.max(1, Math.min(parseInt(req.query.months) || 12, 60));
  const source = req.query.source === "investment" ? "investment" : "linked";
  const accountId = parseInt(req.params.id);
  if (!Number.isFinite(accountId) || accountId <= 0) {
    return res.status(400).json({ error: "id must be a positive integer" });
  }
  try {
    const result = await pool.query(
      `SELECT snapshot_date, balance, available_balance, current_balance
       FROM account_balance_snapshots
       WHERE source = $1 AND source_id = $2
         AND snapshot_date >= CURRENT_DATE - make_interval(months => $3)
       ORDER BY snapshot_date ASC`,
      [source, accountId, months]
    );
    res.json({
      source,
      account_id: accountId,
      months,
      snapshots: result.rows.map(r => ({
        snapshot_date: r.snapshot_date,
        balance: parseFloat(r.balance),
        available_balance: r.available_balance !== null ? parseFloat(r.available_balance) : null,
        current_balance: r.current_balance !== null ? parseFloat(r.current_balance) : null,
      })),
    });
  } catch (err) {
    console.error("balance-history error:", err.message);
    res.status(500).json({ error: "An internal error occurred." });
  }
});

module.exports = router;
module.exports.syncAllEnrollments = syncAllEnrollments;
module.exports.syncAllBalances = syncAllBalances;
module.exports.reconcileTeller = reconcileTeller;
module.exports.recordSyncResult = recordSyncResult;
