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
const multer = require("multer");
const { pool } = require("../services/database");
const { currentMonth } = require("../services/financial-queries");

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

// Lazy Anthropic client (for OCR bill scanning) — optional dependency, mirrors ask.js.
let Anthropic;
try { Anthropic = require("@anthropic-ai/sdk").default || require("@anthropic-ai/sdk"); }
catch { Anthropic = null; }

const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// ---------------------------------------------------------------------------
// Pure helpers (exported for tests)
// ---------------------------------------------------------------------------
// tz-aware (APP_TIMEZONE; default UTC) so monthly obligation generation +
// the partner-split month default honor the operator's wall-clock month (F11).
function thisMonth() {
  return currentMonth();
}

// Settle-up double-count guard: build a Postgres word-boundary regex (\y…\y,
// per the keyword-filter gotcha INV-10) from the payee name + utility labels.
// A shared-card charge matching one of these would be counted in BOTH the
// shared-card settlement leg AND the housing even-up leg of the dashboard
// Settle Up widget. Returns null when there are no usable (>=3 char) terms.
// Regex metacharacters in user-entered labels are escaped so they can't break
// (or inject into) the query.
function buildDoubleCountPattern(cfg) {
  const terms = [];
  if (cfg && cfg.payee_name) terms.push(cfg.payee_name);
  for (const u of (cfg && cfg.utilities) || []) if (u && u.label) terms.push(u.label);
  const escaped = terms
    .map((t) => String(t).trim())
    .filter((t) => t.length >= 3)
    .map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  if (!escaped.length) return null;
  return "\\y(" + escaped.join("|") + ")\\y";
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

// Pure split math: the operator reimburses the partner so each bears half of
// (rentUtilities + car). The partner sends the full rentUtilities to the payee;
// the operator pays the car. transfer = (rentUtilities − car) / 2:
//   transfer > 0 → operator sends the partner that much ("you_send_partner")
//   transfer < 0 → the partner sends the operator |transfer| ("partner_sends_you")
// Each then nets (rentUtilities + car) / 2 — an even 50/50.
function computeSplit(rentUtilities, car) {
  const R = Number(rentUtilities) || 0;
  const C = Number(car) || 0;
  const raw = Math.round(((R - C) / 2) * 100) / 100;
  return {
    rent_utilities: Math.round(R * 100) / 100,
    car: Math.round(C * 100) / 100,
    transfer: Math.abs(raw),
    direction: raw >= 0 ? "you_send_partner" : "partner_sends_you",
    each_share: Math.round(((R + C) / 2) * 100) / 100,
  };
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
    split: normalizeSplit(c.split),
  };
}
// Partner-split config: the inter-spouse reconciliation layer. The partner
// sends the full payee payment; the operator pays the car; the operator then
// sends the partner (rent+utilities − car) / 2 so each bears half of the total
// (rent+utilities+car). car_loan_account_id pulls the car payment from a Perfin
// loan's monthly_payment; car_fixed_amount is the manual fallback.
function normalizeSplit(raw) {
  const s = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  const loanId = parseInt(s.car_loan_account_id, 10);
  return {
    enabled: !!s.enabled,
    partner_name: typeof s.partner_name === "string" ? s.partner_name.slice(0, 60) : "",
    car_loan_account_id: Number.isInteger(loanId) && loanId > 0 ? loanId : null,
    car_fixed_amount: Number.isFinite(Number(s.car_fixed_amount)) && Number(s.car_fixed_amount) >= 0 ? Number(s.car_fixed_amount) : null,
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
        // Deep-link to the awaiting-bill input so entering the figure is one tap.
        data: { url: "/housing#pending" },
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

// GET /api/housing/export?year=YYYY&format=csv|pdf|json — a landlord-ready record
// of payments to the payee for a year, with memos + covered months. Mirrors the
// tax-report exporter (pdfkit for PDF).
router.get("/api/housing/export", async (req, res) => {
  const year = parseInt(req.query.year, 10) || new Date().getFullYear();
  const format = String(req.query.format || "csv").toLowerCase();
  try {
    const cfg = await getConfig().catch(() => ({ payee_name: "" }));
    const pays = await pool.query(
      `SELECT pp.id, pp.payee, pp.paid_date::text AS paid_date, pp.amount, pp.memo,
              COALESCE(json_agg(json_build_object('label', o.label, 'period', o.period)
                       ORDER BY o.period) FILTER (WHERE o.id IS NOT NULL), '[]') AS covers
       FROM payee_payments pp
       LEFT JOIN payee_obligations o ON o.paid_payment_id = pp.id
       WHERE EXTRACT(YEAR FROM pp.paid_date) = $1
       GROUP BY pp.id
       ORDER BY pp.paid_date`,
      [year]
    );
    const rows = pays.rows;
    const total = rows.reduce((s, p) => s + parseFloat(p.amount || 0), 0);
    const payeeName = cfg.payee_name || (rows[0] && rows[0].payee) || "Payee";
    const coversText = (p) => (p.covers || []).map((c) => periodLabel(c.period) + " " + c.label).join("; ");

    if (format === "json") {
      return res.json({ year, payee: payeeName, total: Math.round(total * 100) / 100, payments: rows });
    }
    if (format === "pdf") {
      try {
        const PDFDocument = require("pdfkit");
        const doc = new PDFDocument({ size: "LETTER", margins: { top: 50, bottom: 50, left: 50, right: 50 } });
        res.setHeader("Content-Type", "application/pdf");
        res.setHeader("Content-Disposition", `attachment; filename=rent_utilities_${year}.pdf`);
        doc.pipe(res);
        doc.fontSize(20).fillColor("#d4a574").text("Rent & Utilities — Payment Record", { align: "center" });
        doc.moveDown(0.3);
        doc.fontSize(12).fillColor("#888888").text(`Paid to ${payeeName} · ${year}`, { align: "center" });
        doc.moveDown(1);
        for (const p of rows) {
          doc.fontSize(11).fillColor("#ffffff").text(`${p.paid_date}    $${parseFloat(p.amount).toFixed(2)}`);
          if (p.memo) doc.fontSize(10).fillColor("#cccccc").text(`    ${p.memo}`);
          const cov = coversText(p);
          if (cov) doc.fontSize(9).fillColor("#888888").text(`    Covers: ${cov}`);
          doc.moveDown(0.4);
        }
        doc.moveDown(0.5);
        doc.fontSize(14).fillColor("#d4a574").text(`Total paid in ${year}: $${total.toFixed(2)}`, { align: "right" });
        doc.moveDown(0.5);
        doc.fontSize(9).fillColor("#666666").text("Generated by Perfin on " + new Date().toLocaleDateString() + ".", { align: "center" });
        doc.end();
        return;
      } catch (pdfErr) {
        console.error("housing PDF error:", pdfErr.message);
        return res.status(500).json({ error: "PDF generation failed. Install pdfkit." });
      }
    }
    // CSV (default)
    const q = (v) => `"${String(v == null ? "" : v).replace(/"/g, '""')}"`;
    let csv = "Date,Amount,Memo,Covers,Payee\n";
    for (const p of rows) {
      csv += [p.paid_date, parseFloat(p.amount).toFixed(2), q(p.memo || ""), q(coversText(p)), q(p.payee)].join(",") + "\n";
    }
    csv += `,${total.toFixed(2)},${q("Total " + year)},,\n`;
    res.setHeader("Content-Type", "text/csv");
    res.setHeader("Content-Disposition", `attachment; filename=rent_utilities_${year}.csv`);
    res.send(csv);
  } catch (err) {
    console.error("housing export error:", err.message);
    res.status(500).json({ error: "An internal error occurred." });
  }
});

// POST /api/housing/scan-bill — OCR a utility bill image/PDF via Claude vision
// and SUGGEST { amount, period, label } WITHOUT writing (the user confirms, then
// PATCHes the obligation). Shares the monthly AI cap (entry_type='scan'); 501
// without ANTHROPIC_API_KEY, 429 past the cap. The image is processed and
// discarded — never persisted.
const SCAN_TOOL = {
  name: "report_bill",
  description: "Report the fields extracted from a utility/rent bill image.",
  input_schema: {
    type: "object",
    properties: {
      amount: { type: "number", description: "the total amount due, as a number (no currency symbol)" },
      period: { type: "string", description: "the billing month this bill is for, as YYYY-MM" },
      label: { type: "string", description: "the utility / biller name, e.g. Electricity, Water, Gas" },
    },
  },
};
router.post("/api/housing/scan-bill", upload.single("file"), async (req, res) => {
  if (!Anthropic || !process.env.ANTHROPIC_API_KEY) {
    return res.status(501).json({ error: "AI not configured. Set ANTHROPIC_API_KEY to scan bills." });
  }
  if (!req.file) return res.status(400).json({ error: "No file uploaded" });
  const mt = req.file.mimetype;
  let block;
  const data = req.file.buffer.toString("base64");
  if (mt === "application/pdf") {
    block = { type: "document", source: { type: "base64", media_type: "application/pdf", data } };
  } else if (/^image\/(jpeg|png|webp|gif)$/.test(mt)) {
    block = { type: "image", source: { type: "base64", media_type: mt, data } };
  } else {
    return res.status(400).json({ error: "Unsupported file type — upload a JPG, PNG, WEBP, GIF, or PDF." });
  }

  try {
    // Shared monthly AI cap (parity with /api/ask, INV-14): check then charge.
    const { getAiBudgetCents } = require("./insights");
    const { MODEL_MAP, estimateCostGranular, estimateCostUsd } = require("../data/reference-data");
    const budgetCents = await getAiBudgetCents();
    const u = await pool.query(
      "SELECT tokens_used, model_used, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens FROM financial_insights WHERE created_at >= date_trunc('month', CURRENT_DATE)"
    );
    let spendCents = 0;
    u.rows.forEach((r) => {
      const cost = r.input_tokens
        ? estimateCostGranular({ input_tokens: r.input_tokens, output_tokens: r.output_tokens, cache_read_input_tokens: r.cache_read_tokens || 0, cache_creation_input_tokens: r.cache_creation_tokens || 0 }, r.model_used)
        : estimateCostUsd(r.tokens_used || 0, r.model_used);
      spendCents += cost * 100;
    });
    if (spendCents >= budgetCents) {
      return res.status(429).json({ error: `Monthly AI budget reached ($${(budgetCents / 100).toFixed(2)} cap). Raise it under Settings → AI Insights.` });
    }

    const sRow = await pool.query("SELECT insights_model FROM user_settings WHERE id = 1");
    const modelId = MODEL_MAP[sRow.rows[0]?.insights_model] || MODEL_MAP.haiku;
    const client = new Anthropic();
    const msg = await client.messages.create({
      model: modelId,
      max_tokens: 300,
      tools: [SCAN_TOOL],
      tool_choice: { type: "tool", name: "report_bill" },
      messages: [{
        role: "user",
        content: [
          block,
          { type: "text", text: "This is a utility or rent bill. Extract the total amount due, the billing month it is for (as YYYY-MM), and the biller/utility name. If any field isn't clearly present, omit it." },
        ],
      }],
    });

    // Charge the cap (entry_type='scan' — counted by the cap queries, filtered
    // out of the user-facing insights feed which selects entry_type='insight').
    const usage = msg.usage || {};
    await pool.query(
      `INSERT INTO financial_insights
         (insight_text, model_used, tokens_used, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, entry_type)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'scan')`,
      ["[Scan] utility bill", modelId,
        (usage.input_tokens || 0) + (usage.output_tokens || 0),
        usage.input_tokens || 0, usage.output_tokens || 0,
        usage.cache_read_input_tokens || 0, usage.cache_creation_input_tokens || 0]
    ).catch((e) => console.error("scan-bill usage charge error:", e.message));

    const tool = (msg.content || []).find((b) => b.type === "tool_use");
    const out = (tool && tool.input) || {};
    const amount = Number.isFinite(Number(out.amount)) && Number(out.amount) >= 0 ? Math.round(Number(out.amount) * 100) / 100 : null;
    const period = MONTH_RE.test(String(out.period || "")) ? out.period : null;
    const label = typeof out.label === "string" ? out.label.slice(0, 60) : null;
    res.json({ amount, period, label });
  } catch (err) {
    console.error("scan-bill error:", err.message);
    res.status(500).json({ error: "An internal error occurred." });
  }
});

// GET /api/housing/split?month=YYYY-MM — what the operator sends the partner to
// even up the month (50/50). rent+utilities = the month's known-amount
// obligations; car = the configured loan's monthly_payment (or fixed fallback).
router.get("/api/housing/split", async (req, res) => {
  try {
    const cfg = await getConfig();
    const split = cfg.split || {};
    if (!split.enabled) return res.json({ enabled: false });
    const month = MONTH_RE.test(String(req.query.month || "")) ? req.query.month : thisMonth();

    const ru = await pool.query(
      `SELECT COALESCE(SUM(amount), 0) AS total
       FROM payee_obligations
       WHERE period = $1 AND amount IS NOT NULL AND status IN ('unpaid', 'paid')`,
      [month]
    );
    const rentUtilities = parseFloat(ru.rows[0].total);

    let car = split.car_fixed_amount || 0;
    let carSource = split.car_fixed_amount != null ? "fixed" : "none";
    if (split.car_loan_account_id) {
      const loan = await pool.query(
        "SELECT monthly_payment FROM linked_accounts WHERE id = $1 AND type = 'loan'",
        [split.car_loan_account_id]
      );
      if (loan.rows.length && loan.rows[0].monthly_payment != null) {
        car = parseFloat(loan.rows[0].monthly_payment);
        carSource = "loan";
      } else if (split.car_fixed_amount == null) {
        carSource = "loan_unset"; // loan picked but no monthly_payment on it yet
      }
    }

    // Partner display name: the split's own name, else the global
    // user_settings.partner_name (so the shared-card settlement and the housing
    // split agree on who the partner is — the same-partner guard for the
    // combined dashboard settle-up view), else "Partner".
    let partnerName = split.partner_name;
    if (!partnerName) {
      const pn = await pool.query("SELECT NULLIF(TRIM(partner_name), '') AS n FROM user_settings WHERE id = 1");
      partnerName = pn.rows[0]?.n || "Partner";
    }

    // Double-count guard: flag shared-card charges this month whose merchant
    // matches the payee/utility names — they'd be counted in both the
    // shared-card leg and this even-up leg of the combined Settle Up widget.
    let doubleCountWarning = null;
    const dcPattern = buildDoubleCountPattern(cfg);
    if (dcPattern) {
      try {
        const dc = await pool.query(
          `SELECT COALESCE(t.user_merchant_name, t.merchant_name, t.name) AS merchant,
                  ROUND(t.amount::numeric, 2) AS amount
           FROM transactions t
           JOIN linked_accounts la ON la.account_id = t.account_id
           WHERE la.is_shared = true
             AND t.amount > 0 AND COALESCE(t.is_reimbursed, false) = false
             AND t.date >= $1::date AND t.date < ($1::date + INTERVAL '1 month')::date
             AND COALESCE(t.user_merchant_name, t.merchant_name, t.name) ~* $2
           ORDER BY t.amount DESC LIMIT 5`,
          [month + "-01", dcPattern]
        );
        if (dc.rows.length) {
          doubleCountWarning = {
            count: dc.rows.length,
            total: Math.round(dc.rows.reduce((s, r) => s + parseFloat(r.amount), 0) * 100) / 100,
            sample: dc.rows.slice(0, 3).map((r) => ({ merchant: r.merchant, amount: parseFloat(r.amount) })),
          };
        }
      } catch (dcErr) {
        // Non-essential guard — never let it fail the split computation.
        console.error("double-count guard error:", dcErr.message);
      }
    }

    res.json({ enabled: true, month, partner_name: partnerName, car_source: carSource, double_count_warning: doubleCountWarning, ...computeSplit(rentUtilities, car) });
  } catch (err) {
    console.error("housing split error:", err.message);
    res.status(500).json({ error: "An internal error occurred." });
  }
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
module.exports.computeSplit = computeSplit;
module.exports.buildDoubleCountPattern = buildDoubleCountPattern;
