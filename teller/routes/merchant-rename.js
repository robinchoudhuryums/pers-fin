// ============================================================================
// Routes: merchant rename rules (cycle-7 F55 / ST2)
// ============================================================================
// Renaming ONE transaction (user_merchant_name) used to split its merchant:
// detection keys on COALESCE(user_merchant_name, merchant_name, …), so the
// renamed row grouped apart from its siblings and from every future charge, and
// a subscription or recurring transfer fragmented into two entries. A rename
// rule renames every PAST and FUTURE transaction whose RAW merchant matches.
//
// - Rules reuse the categorization-rule machinery: most specific first
//   (RULE_ORDER_SQL), rulePatternError's 3-character minimum for contains /
//   starts_with, LIKE metacharacters escaped. The default match is exact.
// - A rule matches the RAW merchant (COALESCE(merchant_name, name)), never the
//   user override, and only fills user_merchant_name where it is NULL — a row
//   the user renamed by hand always wins. Rows a rule renamed carry
//   user_merchant_rule_id, so deleting the rule reverts exactly those rows.
// - applyRenameRules runs inside syncAllTransactions (after both providers,
//   before the anomaly check), after a CSV import and after a manual entry, so
//   categorization rules and detection see the renamed merchant.
// - createRuleFromTransaction (PATCH /api/transactions/:id with
//   apply_to_all) also RE-KEYS the existing detected_subscriptions /
//   recurring_transfers rows from the old merchant keys to the new name, keeping
//   their user state (cancelled, dismissed, category, notes), then re-runs
//   detection. An old-key row whose new key already exists is deactivated.

const express = require("express");
const router = express.Router();
const { pool } = require("../services/database");
const { RULE_ORDER_SQL, rulePatternError } = require("./categorize-helpers");

const RAW_MERCHANT = "LOWER(COALESCE(t.merchant_name, t.name, ''))";
// The detectors' merchant key (scripts/detect-subscriptions.js / detect-transfers.js).
const DETECT_KEY = "TRIM(COALESCE(t.user_merchant_name, t.merchant_name, LOWER(REGEXP_REPLACE(t.name, '[^a-zA-Z0-9 ]', '', 'g'))))";
const ESC_PAT = "REPLACE(REPLACE(REPLACE(LOWER($1), '\\', '\\\\'), '%', '\\%'), '_', '\\_')";
const MATCH_TYPES = ["exact", "starts_with", "contains"];

// SQL condition on `t` for a rule's pattern ($1).
function ruleCondition(matchType) {
  if (matchType === "exact") return `${RAW_MERCHANT} = LOWER($1)`;
  if (matchType === "starts_with") return `${RAW_MERCHANT} LIKE ${ESC_PAT} || '%' ESCAPE '\\'`;
  return `${RAW_MERCHANT} LIKE '%' || ${ESC_PAT} || '%' ESCAPE '\\'`;
}

// Apply every active rule to rows with no user merchant name. Returns the
// number of rows renamed. Cheap no-op when there are no rules.
async function applyRenameRules(db = pool) {
  const rules = await db.query(`SELECT * FROM merchant_rename_rules WHERE is_active = true ${RULE_ORDER_SQL}`);
  let renamed = 0;
  for (const rule of rules.rows) {
    const err = rulePatternError(rule.merchant_pattern, rule.match_type);
    if (err) { console.error(`rename rules: skipping rule ${rule.id} — ${err}`); continue; }
    const r = await db.query(
      `UPDATE transactions t SET user_merchant_name = $2, user_merchant_rule_id = $3
       WHERE t.user_merchant_name IS NULL AND ${ruleCondition(rule.match_type)}`,
      [rule.merchant_pattern, rule.rename_to, rule.id]
    );
    if (r.rowCount > 0) {
      renamed += r.rowCount;
      await db.query("UPDATE merchant_rename_rules SET times_applied = times_applied + $2 WHERE id = $1", [rule.id, r.rowCount]);
    }
  }
  return renamed;
}

// Detection rows keyed on the old merchant keys move to the new name, keeping
// their user state; a row whose (new key, cadence[, direction]) already exists
// is deactivated instead (the existing row wins). A forecast correction on the
// deactivated row is carried to that existing row while it is still on the
// default (cycle-8 E1 follow-on — it used to be lost with the old row).
async function rekeyDetectedRows(db, oldKeys, newKey, displayName) {
  const keys = oldKeys.filter((k) => k && k !== newKey);
  if (!keys.length) return { subscriptions: 0, transfers: 0 };
  const subs = await db.query(
    `UPDATE detected_subscriptions ds SET merchant_key = $2, display_name = $3, updated_at = now()
     WHERE ds.merchant_key = ANY($1::text[])
       AND NOT EXISTS (SELECT 1 FROM detected_subscriptions o WHERE o.merchant_key = $2 AND o.cadence_days = ds.cadence_days)`,
    [keys, newKey, displayName]);
  await db.query(
    `UPDATE detected_subscriptions o SET forecast_ignore = true, updated_at = now()
     WHERE o.merchant_key = $2 AND NOT o.forecast_ignore
       AND EXISTS (SELECT 1 FROM detected_subscriptions ds
                   WHERE ds.merchant_key = ANY($1::text[]) AND ds.cadence_days = o.cadence_days
                     AND ds.is_active AND ds.source != 'manual' AND ds.forecast_ignore)`,
    [keys, newKey]);
  await db.query(
    "UPDATE detected_subscriptions SET is_active = false, updated_at = now() WHERE merchant_key = ANY($1::text[]) AND is_active AND source != 'manual'",
    [keys]);
  const transfers = await db.query(
    `UPDATE recurring_transfers rt SET merchant_key = $2, display_name = $3, updated_at = now()
     WHERE rt.merchant_key = ANY($1::text[])
       AND NOT EXISTS (SELECT 1 FROM recurring_transfers o
                       WHERE o.merchant_key = $2 AND o.cadence_days = rt.cadence_days AND o.direction = rt.direction)`,
    [keys, newKey, displayName]);
  await db.query(
    `UPDATE recurring_transfers o SET forecast_treatment = old.forecast_treatment, updated_at = now()
     FROM (SELECT DISTINCT ON (cadence_days, direction) cadence_days, direction, forecast_treatment
           FROM recurring_transfers
           WHERE merchant_key = ANY($1::text[]) AND is_active AND forecast_treatment <> 'auto'
           ORDER BY cadence_days, direction, updated_at DESC) old
     WHERE o.merchant_key = $2 AND o.cadence_days = old.cadence_days AND o.direction = old.direction
       AND o.forecast_treatment = 'auto'`,
    [keys, newKey]);
  await db.query(
    "UPDATE recurring_transfers SET is_active = false, updated_at = now() WHERE merchant_key = ANY($1::text[]) AND is_active",
    [keys]);
  return { subscriptions: subs.rowCount, transfers: transfers.rowCount };
}

// Create (or re-point) a rule and apply it to the past, re-key detection and
// re-run both detectors. Returns { rule, renamed, rekeyed } or { error }.
async function createRenameRule({ pattern, matchType = "exact", renameTo }, db = pool) {
  const type = MATCH_TYPES.includes(matchType) ? matchType : null;
  if (!type) return { error: "match_type must be exact, starts_with or contains" };
  const name = typeof renameTo === "string" ? renameTo.trim() : "";
  if (!name || name.length > 200) return { error: "rename_to must be 1-200 characters" };
  const perr = rulePatternError(pattern, type);
  if (perr) return { error: perr };
  const pat = String(pattern).trim();

  // The rows this rule may cover — unnamed, or named by a rule (a hand rename
  // always wins) — with their detection keys before the change.
  const before = await db.query(
    `SELECT DISTINCT ${DETECT_KEY} AS k FROM transactions t
     WHERE (t.user_merchant_name IS NULL OR t.user_merchant_rule_id IS NOT NULL) AND ${ruleCondition(type)}`,
    [pat]);
  const rule = (await db.query(
    `INSERT INTO merchant_rename_rules (merchant_pattern, match_type, rename_to)
     VALUES ($1, $2, $3)
     ON CONFLICT (merchant_pattern, match_type)
       DO UPDATE SET rename_to = EXCLUDED.rename_to, is_active = true, updated_at = now()
     RETURNING *`,
    [pat, type, name])).rows[0];
  // Rows an earlier version of this rule renamed follow the new name.
  await db.query(
    "UPDATE transactions SET user_merchant_name = $2 WHERE user_merchant_rule_id = $1",
    [rule.id, name]);
  // Rows ANOTHER rule renamed that this one also matches are released, so every
  // rule applies again most specific first (cycle-8 F41): applyRenameRules only
  // fills unnamed rows, so a new, more specific "AMAZON PRIME" rule never took
  // the rows a broad "amazon" rule already owned — yet the re-key below moved
  // the "Amazon" subscription (cancelled state and all) to the new name, and
  // the next detection run re-created "Amazon" as a fresh ACTIVE subscription.
  await db.query(
    `UPDATE transactions t SET user_merchant_name = NULL, user_merchant_rule_id = NULL
     WHERE t.user_merchant_rule_id IS NOT NULL AND t.user_merchant_rule_id <> $2 AND ${ruleCondition(type)}`,
    [pat, rule.id]);
  const renamed = await applyRenameRules(db);
  // Re-key only the old keys no transaction carries any more — every row under
  // them moved to the new name. A key some rows still use (the broad rule's
  // other merchants, a more specific rule that kept its rows) keeps its
  // detection row and user state.
  const oldKeys = [...new Set(before.rows.map((r) => r.k))].filter((k) => k && k !== name);
  let vacated = [];
  if (oldKeys.length) {
    const still = await db.query(
      `SELECT DISTINCT ${DETECT_KEY} AS k FROM transactions t WHERE ${DETECT_KEY} = ANY($1::text[])`,
      [oldKeys]);
    const inUse = new Set(still.rows.map((r) => r.k));
    vacated = oldKeys.filter((k) => !inUse.has(k));
  }
  const rekeyed = await rekeyDetectedRows(db, vacated, name, name);
  return { rule, renamed, rekeyed };
}

// Run both detectors after a rename (best effort — the rename already stands).
async function redetect() {
  try {
    const { runSubscriptionDetection } = require("./subscriptions");
    const { detectRecurringTransfers } = require("../../scripts/detect-transfers");
    await runSubscriptionDetection();
    await detectRecurringTransfers(pool);
    return true;
  } catch (err) {
    console.error("rename rules: re-detection failed:", err.message);
    return false;
  }
}

// PATCH /api/transactions/:id with apply_to_all — the rule is the row's RAW
// merchant, exact match.
async function createRuleFromTransaction(transactionId, renameTo, db = pool) {
  const t = await db.query(
    "SELECT COALESCE(merchant_name, name) AS raw FROM transactions WHERE transaction_id = $1",
    [transactionId]);
  if (!t.rows.length) return { error: "Transaction not found", status: 404 };
  const raw = t.rows[0].raw;
  if (!raw || !String(raw).trim()) return { error: "This transaction has no merchant to match" };
  const out = await createRenameRule({ pattern: raw, matchType: "exact", renameTo }, db);
  if (out.error) return out;
  // The edited row itself is now rule-renamed (deleting the rule reverts it).
  await db.query(
    "UPDATE transactions SET user_merchant_name = $2, user_merchant_rule_id = $3 WHERE transaction_id = $1",
    [transactionId, out.rule.rename_to, out.rule.id]);
  out.redetected = await redetect();
  return out;
}

// GET /api/merchant-rename-rules
router.get("/api/merchant-rename-rules", async (_req, res) => {
  try {
    const r = await pool.query(`SELECT * FROM merchant_rename_rules ${RULE_ORDER_SQL}`);
    res.json({ rules: r.rows });
  } catch (err) {
    console.error("rename rules list error:", err.message);
    res.status(500).json({ error: "An internal error occurred." });
  }
});

// POST /api/merchant-rename-rules — body: merchant_pattern, rename_to, match_type?
router.post("/api/merchant-rename-rules", async (req, res) => {
  try {
    const { merchant_pattern, rename_to, match_type } = req.body || {};
    const out = await createRenameRule({ pattern: merchant_pattern, matchType: match_type || "exact", renameTo: rename_to });
    if (out.error) return res.status(400).json({ error: out.error });
    out.redetected = await redetect();
    res.json(out);
  } catch (err) {
    console.error("rename rule create error:", err.message);
    res.status(500).json({ error: "An internal error occurred." });
  }
});

// POST /api/merchant-rename-rules/apply — re-apply every active rule.
router.post("/api/merchant-rename-rules/apply", async (_req, res) => {
  try {
    res.json({ renamed: await applyRenameRules() });
  } catch (err) {
    console.error("rename rules apply error:", err.message);
    res.status(500).json({ error: "An internal error occurred." });
  }
});

// Edit a rule (roadmap T1.5): a new display name and/or an on / off switch.
// The pattern itself is not editable (delete + re-create).
// - Turning a rule OFF undoes its renames exactly as DELETE does (rows it
//   renamed go back to their bank names; another rule may then claim them) but
//   keeps the rule. Detection rows are left as they are, like DELETE.
// - A new name on an active rule, or turning a rule back ON, goes through
//   createRenameRule: the rows the rule renamed take the new name, the detected
//   subscription / recurring transfer keyed on the old name is re-keyed with its
//   user state kept, and the caller re-runs detection.
// - A new name on a rule that stays off is only stored.
// Returns { rule, renamed?, reverted?, rekeyed? } or { error, status }.
async function updateRenameRule(id, { renameTo, isActive } = {}, db = pool) {
  if (renameTo === undefined && isActive === undefined) return { error: "Send rename_to and/or is_active", status: 400 };
  if (isActive !== undefined && typeof isActive !== "boolean") return { error: "is_active must be true or false", status: 400 };
  let name;
  if (renameTo !== undefined) {
    name = typeof renameTo === "string" ? renameTo.trim() : "";
    if (!name || name.length > 200) return { error: "rename_to must be 1-200 characters", status: 400 };
  }
  const cur = (await db.query("SELECT * FROM merchant_rename_rules WHERE id = $1", [id])).rows[0];
  if (!cur) return { error: "Not found", status: 404 };
  const active = isActive === undefined ? cur.is_active : isActive;

  if (!active) {
    const rule = (await db.query(
      `UPDATE merchant_rename_rules SET is_active = false, rename_to = COALESCE($2, rename_to), updated_at = now()
       WHERE id = $1 RETURNING *`, [id, name === undefined ? null : name])).rows[0];
    let reverted = 0, renamed = 0;
    if (cur.is_active) {
      reverted = (await db.query(
        "UPDATE transactions SET user_merchant_name = NULL, user_merchant_rule_id = NULL WHERE user_merchant_rule_id = $1",
        [id])).rowCount;
      renamed = await applyRenameRules(db);
    }
    return { rule, reverted, renamed, redetect: false };
  }
  if (cur.is_active && (name === undefined || name === cur.rename_to)) return { rule: cur, renamed: 0, redetect: false };
  const out = await createRenameRule({ pattern: cur.merchant_pattern, matchType: cur.match_type, renameTo: name === undefined ? cur.rename_to : name }, db);
  if (out.error) return { error: out.error, status: 400 };
  return { ...out, redetect: true };
}

// PATCH /api/merchant-rename-rules/:id — body: rename_to?, is_active?
router.patch("/api/merchant-rename-rules/:id", async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id) || String(id) !== String(req.params.id)) return res.status(400).json({ error: "Invalid id" });
  try {
    const { rename_to, is_active } = req.body || {};
    const out = await updateRenameRule(id, { renameTo: rename_to, isActive: is_active });
    if (out.error) return res.status(out.status || 400).json({ error: out.error });
    const { redetect: needed, ...body } = out;
    if (needed) body.redetected = await redetect();
    res.json(body);
  } catch (err) {
    console.error("rename rule update error:", err.message);
    res.status(500).json({ error: "An internal error occurred." });
  }
});

// DELETE /api/merchant-rename-rules/:id — removes the rule and reverts the rows
// it renamed (other rules may then claim them).
router.delete("/api/merchant-rename-rules/:id", async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id)) return res.status(400).json({ error: "Invalid id" });
  try {
    const del = await pool.query("DELETE FROM merchant_rename_rules WHERE id = $1 RETURNING id", [id]);
    if (!del.rows.length) return res.status(404).json({ error: "Not found" });
    const reverted = await pool.query(
      "UPDATE transactions SET user_merchant_name = NULL, user_merchant_rule_id = NULL WHERE user_merchant_rule_id = $1",
      [id]);
    const renamed = await applyRenameRules();
    res.json({ ok: true, reverted: reverted.rowCount, renamed });
  } catch (err) {
    console.error("rename rule delete error:", err.message);
    res.status(500).json({ error: "An internal error occurred." });
  }
});

module.exports = router;
module.exports.applyRenameRules = applyRenameRules;
module.exports.createRenameRule = createRenameRule;
module.exports.createRuleFromTransaction = createRuleFromTransaction;
module.exports.updateRenameRule = updateRenameRule;
module.exports.ruleCondition = ruleCondition;
