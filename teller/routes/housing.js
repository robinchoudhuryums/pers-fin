// ============================================================================
// Routes: Rent & Utilities — a single-payee accounts-payable ledger
// ============================================================================
// Models the "what we owe [person] for rent + utilities" spreadsheet as two
// things: OBLIGATIONS (rent = fixed; a utility starts `pending_amount` until the
// mailed bill arrives and the amount is entered) and PAYMENTS (a bank transfer
// that settles a BATCH of obligations with a memo like "Jan–Mar rent"). The
// running balance is just the sum of `unpaid` obligations.
//
// Config (payee, monthly rent, due day, utilities + cadence, reminder lead)
// lives in user_settings.housing_config. A scheduled task (startup.js) calls
// generateHousingObligations + runHousingReminders in-process (INV-18).

const express = require("express");
const router = express.Router();
const { pool } = require("../services/database");

const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// ---------------------------------------------------------------------------
// Pure helpers (exported for tests)
// ---------------------------------------------------------------------------
function thisMonth() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

// Whole months from a→b (both 'YYYY-MM'); negative if b precedes a.
function monthsBetween(a, b) {
  const [ay, am] = a.split("-").map(Number);
  const [by, bm] = b.split("-").map(Number);
  return (by - ay) * 12 + (bm - am);
}

// Inclusive list of 'YYYY-MM' from start..end (end >= start), capped so a bad
// config can't generate thousands of months.
function monthRange(start, end, cap = 24) {
  const out = [];
  const n = monthsBetween(start, end);
  if (n < 0) return out;
  let [y, m] = start.split("-").map(Number);
  for (let i = 0; i <= n && i < cap; i++) {
    out.push(`${y}-${String(m).padStart(2, "0")}`);
    m++; if (m > 12) { m = 1; y++; }
  }
  return out;
}

// Human label for a period+label, e.g. "Jan 2026 Electricity".
function periodLabel(period) {
  if (!MONTH_RE.test(String(period || ""))) return String(period || "");
  const [y, m] = period.split("-").map(Number);
  return `${MONTHS[m - 1]} ${y}`;
}

// Derive a payment memo from the obligations it covers, collapsing consecutive
// same-label months into a range: "Jan–Mar Rent, Jan Electricity".
function deriveMemo(obligations) {
  const byLabel = new Map();
  for (const o of obligations) {
    if (!byLabel.has(o.label)) byLabel.set(o.label, []);
    byLabel.get(o.label).push(o.period);
  }
  const parts = [];
  for (const [label, periods] of byLabel) {
    const sorted = [...new Set(periods)].sort();
    // Collapse consecutive months into ranges.
    const ranges = [];
    let runStart = sorted[0], prev = sorted[0];
    for (let i = 1; i < sorted.length; i++) {
      if (monthsBetween(prev, sorted[i]) === 1) { prev = sorted[i]; continue; }
      ranges.push([runStart, prev]); runStart = sorted[i]; prev = sorted[i];
    }
    ranges.push([runStart, prev]);
    const rendered = ranges.map(([a, b]) => {
      const [ay, am] = a.split("-").map(Number);
      const [by] = b.split("-").map(Number);
      if (a === b) return `${MONTHS[am - 1]} ${ay}`;
      const bm = Number(b.split("-")[1]);
      // Same-year range: "Jan–Mar 2026"; cross-year: "Nov 2025–Feb 2026".
      return ay === by ? `${MONTHS[am - 1]}–${MONTHS[bm - 1]} ${ay}` : `${MONTHS[am - 1]} ${ay}–${MONTHS[bm - 1]} ${by}`;
    }).join(", ");
    parts.push(`${rendered} ${label}`);
  }
  return parts.join(", ");
}

// Normalize a stored housing_config (JSONB) into a safe, typed shape.
function normalizeConfig(raw) {
  const c = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  const utils = Array.isArray(c.utilities) ? c.utilities : [];
  return {
    enabled: !!c.enabled,
    payee_name: typeof c.payee_name === "string" ? c.payee_name.slice(0, 100) : "",
    rent_amount: Number.isFinite(Number(c.rent_amount)) ? Number(c.rent_amount) : 0,
    rent_due_day: clampDay(c.rent_due_day, 1),
    reminder_lead_days: Math.min(28, Math.max(0, parseInt(c.reminder_lead_days, 10) || 5)),
    start_month: MONTH_RE.test(String(c.start_month || "")) ? c.start_month : thisMonth(),
    utilities: utils.slice(0, 12).map((u) => ({
      label: typeof u.label === "string" ? u.label.slice(0, 60) : "Utility",
      cadence_months: Math.min(12, Math.max(1, parseInt(u.cadence_months, 10) || 1)),
      due_day: clampDay(u.due_day, 15),
      anchor: MONTH_RE.test(String(u.anchor || "")) ? u.anchor : (MONTH_RE.test(String(c.start_month || "")) ? c.start_month : thisMonth()),
    })),
  };
}
function clampDay(v, dflt) {
  const n = parseInt(v, 10);
  return Number.isInteger(n) && n >= 1 && n <= 31 ? n : dflt;
}

async function getConfig(db) {
  const r = await (db || pool).query("SELECT housing_config FROM user_settings WHERE id = 1");
  let raw = r.rows[0] && r.rows[0].housing_config;
  if (typeof raw === "string") { try { raw = JSON.parse(raw); } catch { raw = {}; } }
  return normalizeConfig(raw);
}

// ---------------------------------------------------------------------------
// Generation — ensure rent + utility placeholder rows exist for each month from
// start_month..thisMonth. Idempotent (ON CONFLICT DO NOTHING on the natural
// key). Utilities are created as `pending_amount` (NULL amount) on their
// cadence; rent as `unpaid` with the configured amount.
// ---------------------------------------------------------------------------
async function generateHousingObligations(pool_) {
  const db = pool_ || pool;
  const cfg = await getConfig(db);
  if (!cfg.enabled || !cfg.payee_name) return { generated: 0, skipped: "not_configured" };
  const months = monthRange(cfg.start_month, thisMonth());
  let generated = 0;
  for (const period of months) {
    if (cfg.rent_amount > 0) {
      const r = await db.query(
        `INSERT INTO payee_obligations (payee, category, label, period, amount, due_day, status, auto_generated)
         VALUES ($1, 'rent', 'Rent', $2, $3, $4, 'unpaid', true)
         ON CONFLICT (payee, period, category, label) DO NOTHING`,
        [cfg.payee_name, period, cfg.rent_amount, cfg.rent_due_day]
      );
      generated += r.rowCount;
    }
    for (const u of cfg.utilities) {
      if (monthsBetween(u.anchor, period) < 0) continue;
      if (monthsBetween(u.anchor, period) % u.cadence_months !== 0) continue;
      const r = await db.query(
        `INSERT INTO payee_obligations (payee, category, label, period, amount, due_day, status, auto_generated)
         VALUES ($1, 'utility', $2, $3, NULL, $4, 'pending_amount', true)
         ON CONFLICT (payee, period, category, label) DO NOTHING`,
        [cfg.payee_name, u.label, period, u.due_day]
      );
      generated += r.rowCount;
    }
  }
  return { generated };
}

// ---------------------------------------------------------------------------
// Reminders — (1) payment due (within lead window of rent due day, balance > 0),
// (2) missing utility amount (a pending_amount whose bill should have arrived).
// Deduped via sentRecently so each reminder repeats at most every ~3 days.
// ---------------------------------------------------------------------------
async function runHousingReminders(pool_) {
  const db = pool_ || pool;
  const cfg = await getConfig(db);
  if (!cfg.enabled || !cfg.payee_name) return { sent: 0 };
  let sent = 0;
  let sendToAll, sentRecently;
  try { ({ sendToAll, sentRecently } = require("./notifications")); }
  catch { return { sent: 0 }; }

  const today = new Date();
  const dom = today.getDate();

  // (1) Payment due — unpaid balance owed, and we're within the lead window of
  // the rent due day (or past it). One reminder per ~3 days while it stands.
  try {
    const bal = await db.query(
      "SELECT COALESCE(SUM(amount), 0) AS balance, COUNT(*) AS n FROM payee_obligations WHERE status = 'unpaid' AND payee = $1",
      [cfg.payee_name]
    );
    const balance = parseFloat(bal.rows[0].balance);
    const count = parseInt(bal.rows[0].n);
    if (balance > 0 && dom >= cfg.rent_due_day - cfg.reminder_lead_days) {
      const tag = "housing-due-" + thisMonth();
      if (!(await sentRecently(tag, 72))) {
        const r = await sendToAll({
          title: "Rent/utilities due to " + cfg.payee_name,
          body: "$" + balance.toFixed(2) + " owed across " + count + " item(s). Send the transfer.",
          tag,
          data: { url: "/housing" },
        });
        if (r && r.logged) sent++;
      }
    }
  } catch (e) { console.error("housing payment reminder error:", e.message); }

  // (2) Missing utility amount — a pending_amount whose bill should have arrived
  // (today's day-of-month is at/after the utility's due day, or the period is in
  // the past). Reminds to enter the figure so the balance + reminders are right.
  try {
    const pend = await db.query(
      `SELECT id, label, period, due_day FROM payee_obligations
       WHERE status = 'pending_amount' AND payee = $1
       ORDER BY period`,
      [cfg.payee_name]
    );
    const tm = thisMonth();
    for (const o of pend.rows) {
      const past = monthsBetween(o.period, tm) > 0;
      if (!past && dom < o.due_day) continue; // bill not due yet this month
      const tag = "housing-util-" + o.id;
      if (await sentRecently(tag, 72)) continue;
      const r = await sendToAll({
        title: "Enter " + o.label + " amount",
        body: periodLabel(o.period) + " " + o.label + " bill should have arrived — add the amount.",
        tag,
        data: { url: "/housing" },
      });
      if (r && r.logged) sent++;
    }
  } catch (e) { console.error("housing utility reminder error:", e.message); }

  return { sent };
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

// GET /api/housing/config
router.get("/api/housing/config", async (_req, res) => {
  try { res.json(await getConfig()); }
  catch (err) { console.error("housing config get error:", err.message); res.status(500).json({ error: "An internal error occurred." }); }
});

// PATCH /api/housing/config — replace the config (validated + normalized).
router.patch("/api/housing/config", async (req, res) => {
  const body = req.body || {};
  if (typeof body !== "object" || Array.isArray(body)) return res.status(400).json({ error: "config must be an object" });
  if (body.enabled && (!body.payee_name || !String(body.payee_name).trim())) {
    return res.status(400).json({ error: "payee_name is required to enable the ledger" });
  }
  if (body.rent_amount != null && !(Number.isFinite(Number(body.rent_amount)) && Number(body.rent_amount) >= 0)) {
    return res.status(400).json({ error: "rent_amount must be a non-negative number" });
  }
  if (body.utilities != null && !Array.isArray(body.utilities)) {
    return res.status(400).json({ error: "utilities must be an array" });
  }
  try {
    // Preserve the original start_month once set (so editing config later doesn't
    // shift the generation window and orphan/duplicate months).
    const existing = await getConfig();
    const merged = normalizeConfig({ ...body, start_month: existing.start_month || body.start_month });
    await pool.query("INSERT INTO user_settings (id) VALUES (1) ON CONFLICT DO NOTHING");
    await pool.query("UPDATE user_settings SET housing_config = $1, updated_at = now() WHERE id = 1", [JSON.stringify(merged)]);
    res.json(merged);
  } catch (err) { console.error("housing config patch error:", err.message); res.status(500).json({ error: "An internal error occurred." }); }
});

// GET /api/housing/ledger — balance, obligations, payments.
router.get("/api/housing/ledger", async (_req, res) => {
  try {
    const cfg = await getConfig();
    const [obl, pay] = await Promise.all([
      pool.query(
        `SELECT id, payee, category, label, period, amount, due_day, status, paid_payment_id, notes, auto_generated
         FROM payee_obligations ORDER BY period DESC, category, label`
      ),
      pool.query(
        `SELECT pp.id, pp.payee, pp.paid_date::text AS paid_date, pp.amount, pp.memo, pp.created_at,
                COALESCE(json_agg(json_build_object('label', o.label, 'period', o.period, 'amount', o.amount)
                         ORDER BY o.period) FILTER (WHERE o.id IS NOT NULL), '[]') AS covers
         FROM payee_payments pp
         LEFT JOIN payee_obligations o ON o.paid_payment_id = pp.id
         GROUP BY pp.id
         ORDER BY pp.paid_date DESC, pp.id DESC
         LIMIT 60`
      ),
    ]);
    let balance = 0, awaiting = 0;
    for (const o of obl.rows) {
      if (o.status === "unpaid") balance += parseFloat(o.amount || 0);
      else if (o.status === "pending_amount") awaiting++;
    }
    res.json({
      config: cfg,
      balance: Math.round(balance * 100) / 100,
      awaiting_count: awaiting,
      obligations: obl.rows,
      payments: pay.rows,
    });
  } catch (err) { console.error("housing ledger error:", err.message); res.status(500).json({ error: "An internal error occurred." }); }
});

// POST /api/housing/generate — generate current/missing months from config.
router.post("/api/housing/generate", async (_req, res) => {
  try { res.json(await generateHousingObligations()); }
  catch (err) { console.error("housing generate error:", err.message); res.status(500).json({ error: "An internal error occurred." }); }
});

// POST /api/housing/obligations — add an ad-hoc obligation (e.g. a one-off).
router.post("/api/housing/obligations", async (req, res) => {
  const { payee, category, label, period, amount, due_day, notes } = req.body || {};
  if (!label || !String(label).trim()) return res.status(400).json({ error: "label is required" });
  if (!MONTH_RE.test(String(period || ""))) return res.status(400).json({ error: "period must be 'YYYY-MM'" });
  const cat = ["rent", "utility", "other"].includes(category) ? category : "other";
  let amt = amount == null || amount === "" ? null : Number(amount);
  if (amt != null && !(Number.isFinite(amt) && amt >= 0)) return res.status(400).json({ error: "amount must be a non-negative number or blank" });
  const status = amt == null ? "pending_amount" : "unpaid";
  const cfg = await getConfig().catch(() => ({ payee_name: "" }));
  const pay = (payee && String(payee).trim()) || cfg.payee_name || "Payee";
  try {
    const r = await pool.query(
      `INSERT INTO payee_obligations (payee, category, label, period, amount, due_day, status, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (payee, period, category, label) DO UPDATE SET amount = EXCLUDED.amount,
         status = CASE WHEN payee_obligations.status = 'paid' THEN 'paid' WHEN EXCLUDED.amount IS NULL THEN 'pending_amount' ELSE 'unpaid' END,
         notes = EXCLUDED.notes, due_day = EXCLUDED.due_day, updated_at = now()
       RETURNING *`,
      [pay, cat, String(label).trim(), period, amt, clampDay(due_day, 1), status, notes || null]
    );
    res.json(r.rows[0]);
  } catch (err) { console.error("housing obligation create error:", err.message); res.status(500).json({ error: "An internal error occurred." }); }
});

// PATCH /api/housing/obligations/:id — set amount (bill arrived), notes, due_day.
// Setting an amount on a pending_amount row flips it to unpaid; clearing it
// reverts to pending_amount (unless already paid).
router.patch("/api/housing/obligations/:id", async (req, res) => {
  const fields = [];
  const params = [];
  let i = 1;
  const body = req.body || {};
  let amountProvided = false, newAmount = null;
  if (Object.prototype.hasOwnProperty.call(body, "amount")) {
    amountProvided = true;
    newAmount = body.amount == null || body.amount === "" ? null : Number(body.amount);
    if (newAmount != null && !(Number.isFinite(newAmount) && newAmount >= 0)) return res.status(400).json({ error: "amount must be a non-negative number or blank" });
    fields.push(`amount = $${i++}`); params.push(newAmount);
  }
  if (typeof body.notes === "string" || body.notes === null) { fields.push(`notes = $${i++}`); params.push(body.notes || null); }
  if (body.due_day !== undefined) { fields.push(`due_day = $${i++}`); params.push(clampDay(body.due_day, 1)); }
  if (body.label !== undefined && String(body.label).trim()) { fields.push(`label = $${i++}`); params.push(String(body.label).trim()); }
  if (!fields.length) return res.status(400).json({ error: "No fields to update" });
  // Recompute status from the (possibly new) amount unless the row is paid.
  if (amountProvided) {
    fields.push(`status = CASE WHEN status = 'paid' THEN 'paid' WHEN $${i} IS NULL THEN 'pending_amount' ELSE 'unpaid' END`);
    params.push(newAmount); i++;
  }
  fields.push("updated_at = now()");
  params.push(req.params.id);
  try {
    const r = await pool.query(`UPDATE payee_obligations SET ${fields.join(", ")} WHERE id = $${i} RETURNING *`, params);
    if (!r.rows.length) return res.status(404).json({ error: "Not found" });
    res.json(r.rows[0]);
  } catch (err) { console.error("housing obligation patch error:", err.message); res.status(500).json({ error: "An internal error occurred." }); }
});

// DELETE /api/housing/obligations/:id
router.delete("/api/housing/obligations/:id", async (req, res) => {
  try {
    const r = await pool.query("DELETE FROM payee_obligations WHERE id = $1 RETURNING id", [req.params.id]);
    if (!r.rows.length) return res.status(404).json({ error: "Not found" });
    res.json({ ok: true });
  } catch (err) { console.error("housing obligation delete error:", err.message); res.status(500).json({ error: "An internal error occurred." }); }
});

// POST /api/housing/payments — settle a batch of unpaid obligations.
// Body: { obligation_ids:[], paid_date?, amount?, memo? }. Only `unpaid`
// obligations (amount known) can be settled; the memo defaults to a derived
// range ("Jan–Mar Rent"). amount defaults to the sum of the covered obligations.
router.post("/api/housing/payments", async (req, res) => {
  const ids = Array.isArray(req.body && req.body.obligation_ids) ? req.body.obligation_ids.map((x) => parseInt(x, 10)).filter(Number.isInteger) : [];
  if (!ids.length) return res.status(400).json({ error: "obligation_ids is required" });
  const paidDate = /^\d{4}-\d{2}-\d{2}$/.test(String(req.body.paid_date || "")) ? req.body.paid_date : new Date().toISOString().slice(0, 10);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const obl = await client.query(
      "SELECT id, payee, label, period, amount, status FROM payee_obligations WHERE id = ANY($1) FOR UPDATE",
      [ids]
    );
    if (obl.rows.length !== ids.length) { await client.query("ROLLBACK"); return res.status(400).json({ error: "Some obligations were not found" }); }
    const notSettleable = obl.rows.filter((o) => o.status !== "unpaid");
    if (notSettleable.length) { await client.query("ROLLBACK"); return res.status(400).json({ error: "Only unpaid obligations with a known amount can be settled (set utility amounts first)" }); }
    const payee = obl.rows[0].payee;
    const sum = obl.rows.reduce((s, o) => s + parseFloat(o.amount || 0), 0);
    let amount = req.body.amount == null || req.body.amount === "" ? sum : Number(req.body.amount);
    if (!(Number.isFinite(amount) && amount >= 0)) { await client.query("ROLLBACK"); return res.status(400).json({ error: "amount must be a non-negative number" }); }
    const memo = (typeof req.body.memo === "string" && req.body.memo.trim()) ? req.body.memo.trim().slice(0, 300) : deriveMemo(obl.rows);

    const pp = await client.query(
      "INSERT INTO payee_payments (payee, paid_date, amount, memo) VALUES ($1,$2,$3,$4) RETURNING *",
      [payee, paidDate, Math.round(amount * 100) / 100, memo]
    );
    await client.query(
      "UPDATE payee_obligations SET status = 'paid', paid_payment_id = $1, updated_at = now() WHERE id = ANY($2)",
      [pp.rows[0].id, ids]
    );
    await client.query("COMMIT");
    res.json({ payment: pp.rows[0], settled: ids.length });
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    console.error("housing payment error:", err.message);
    res.status(500).json({ error: "An internal error occurred." });
  } finally { client.release(); }
});

// DELETE /api/housing/payments/:id — unwind a payment, reverting its
// obligations to unpaid (or pending_amount if their amount was cleared).
router.delete("/api/housing/payments/:id", async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `UPDATE payee_obligations
       SET status = CASE WHEN amount IS NULL THEN 'pending_amount' ELSE 'unpaid' END,
           paid_payment_id = NULL, updated_at = now()
       WHERE paid_payment_id = $1`,
      [req.params.id]
    );
    const d = await client.query("DELETE FROM payee_payments WHERE id = $1 RETURNING id", [req.params.id]);
    await client.query("COMMIT");
    if (!d.rows.length) return res.status(404).json({ error: "Not found" });
    res.json({ ok: true });
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    console.error("housing payment delete error:", err.message);
    res.status(500).json({ error: "An internal error occurred." });
  } finally { client.release(); }
});

module.exports = router;
// Helpers attached AFTER module.exports = router (INV-19) so the scheduler +
// tests can call them without an HTTP self-fetch (INV-18).
module.exports.generateHousingObligations = generateHousingObligations;
module.exports.runHousingReminders = runHousingReminders;
module.exports.monthsBetween = monthsBetween;
module.exports.monthRange = monthRange;
module.exports.deriveMemo = deriveMemo;
module.exports.normalizeConfig = normalizeConfig;
module.exports.periodLabel = periodLabel;
