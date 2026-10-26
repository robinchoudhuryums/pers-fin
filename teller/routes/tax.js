// ============================================================================
// Routes: the year-end tax package (roadmap T3.3)
// ============================================================================
// K2 — the documents checklist (services/tax-documents.js):
//   GET    /api/tax/documents?year=          the year's checklist
//   POST   /api/tax/documents                add a form by hand (origin manual)
//   PATCH  /api/tax/documents/:id            received / dismissed / notes / expected_by
//   DELETE /api/tax/documents/:id            a manual row only (a suggested one is
//                                            dismissed instead — 409 — so it isn't
//                                            suggested again)
//   POST   /api/tax/documents/suggest?year=  add the forms the year's data points to
// K3 — the package (services/tax-package.js), computed on request, never stored:
//   GET    /api/tax/package?year=&format=json|pdf|zip
//          json (default) — the package object; pdf — one summary document;
//          zip — summary.pdf + a CSV per section + package.json. A section
//          whose read fails carries { ok: false, error } and the rest render.
// The year is an integer 2000..this APP_TIMEZONE year, else 400 (decision 1).
// Every write kicks the linked-task refresh (a received or dismissed form closes
// its Per-sistant task) after it commits; that never fails the response.

const express = require("express");
const router = express.Router();
const { pool } = require("../services/database");
const { todayStr } = require("../services/financial-queries");
const { isValidYmd } = require("../services/cadence");
const docs = require("../services/tax-documents");
const taxPackage = require("../services/tax-package");
const linkedTasks = require("../services/linked-tasks");

const YEAR_ERROR = "year must be a whole year from 2000 to this year";

function yearFrom(raw, res) {
  const y = docs.parseTaxYear(raw, todayStr());
  if (y == null) { res.status(400).json({ error: YEAR_ERROR }); return null; }
  return y;
}

function idFrom(raw, res) {
  const s = String(raw);
  if (!/^[1-9]\d{0,9}$/.test(s)) { res.status(400).json({ error: "Invalid document id" }); return null; }
  return Number(s);
}

// notes: a string up to MAX_NOTES (trimmed; "" → null) or null.
function notesFrom(v) {
  if (v === null) return { value: null };
  if (typeof v !== "string") return { error: "notes must be text or null" };
  const t = v.trim();
  if (t.length > docs.MAX_NOTES) return { error: `notes must be ${docs.MAX_NOTES} characters or fewer` };
  return { value: t || null };
}

// expected_by: a real calendar date or null.
function dateFrom(v) {
  if (v === null) return { value: null };
  if (typeof v !== "string" || !isValidYmd(v)) return { error: "expected_by must be a YYYY-MM-DD date or null" };
  return { value: v };
}

const PACKAGE_FORMATS = ["json", "pdf", "zip"];

router.get("/api/tax/package", async (req, res) => {
  const year = yearFrom(req.query.year, res);
  if (year == null) return;
  const format = String(req.query.format == null ? "json" : req.query.format).toLowerCase();
  if (!PACKAGE_FORMATS.includes(format)) return res.status(400).json({ error: "format must be json, pdf or zip" });
  try {
    const pkg = await taxPackage.gatherTaxPackage(pool, year);
    if (format === "json") return res.json(pkg);
    const buf = format === "pdf" ? await taxPackage.renderPackagePdf(pkg) : await taxPackage.buildPackageZip(pkg);
    res.setHeader("Content-Type", format === "pdf" ? "application/pdf" : "application/zip");
    res.setHeader("Content-Disposition", `attachment; filename=perfin_tax_package_${year}.${format}`);
    res.setHeader("Cache-Control", "no-store");
    res.send(buf);
  } catch (e) {
    console.error("GET /api/tax/package error:", e.message);
    res.status(500).json({ error: "Could not build the tax package." });
  }
});

router.get("/api/tax/documents", async (req, res) => {
  const year = yearFrom(req.query.year, res);
  if (year == null) return;
  try {
    res.json({ year, forms: docs.FORMS, documents: await docs.listTaxDocuments(pool, year, todayStr()) });
  } catch (e) {
    console.error("GET /api/tax/documents error:", e.message);
    res.status(500).json({ error: "Could not read the tax documents." });
  }
});

router.post("/api/tax/documents", async (req, res) => {
  const b = req.body || {};
  const year = yearFrom(b.year, res);
  if (year == null) return;
  if (typeof b.form !== "string" || !docs.FORMS.includes(b.form)) {
    return res.status(400).json({ error: "form must be one of " + docs.FORMS.join(", ") });
  }
  if (b.issuer != null && typeof b.issuer !== "string") return res.status(400).json({ error: "issuer must be text" });
  const issuer = docs.cleanIssuer(b.issuer);
  if (b.issuer != null && String(b.issuer).trim().length > docs.MAX_ISSUER) {
    return res.status(400).json({ error: `issuer must be ${docs.MAX_ISSUER} characters or fewer` });
  }
  let expected = docs.expectedBy(year, b.form);
  if (b.expected_by !== undefined) {
    const d = dateFrom(b.expected_by);
    if (d.error) return res.status(400).json({ error: d.error });
    expected = d.value;
  }
  let notes = null;
  if (b.notes !== undefined) {
    const n = notesFrom(b.notes);
    if (n.error) return res.status(400).json({ error: n.error });
    notes = n.value;
  }
  try {
    const r = await pool.query(
      `INSERT INTO tax_documents (tax_year, form, issuer, expected_by, notes, origin)
       VALUES ($1, $2, $3, $4::date, $5, 'manual')
       ON CONFLICT (tax_year, form, (LOWER(issuer))) DO NOTHING
       RETURNING ${docs.COLUMNS}`,
      [year, b.form, issuer, expected, notes]
    );
    if (!r.rows.length) return res.status(409).json({ error: "That form from that issuer is already on the list." });
    linkedTasks.kick("tax-document-add");
    res.status(201).json({ document: r.rows[0] });
  } catch (e) {
    console.error("POST /api/tax/documents error:", e.message);
    res.status(500).json({ error: "Could not add the tax document." });
  }
});

router.post("/api/tax/documents/suggest", async (req, res) => {
  const year = yearFrom(req.query.year !== undefined ? req.query.year : (req.body || {}).year, res);
  if (year == null) return;
  try {
    const out = await docs.suggestTaxDocuments(pool, year);
    if (out.added) linkedTasks.kick("tax-document-suggest");
    res.json({ year, ...out, documents: await docs.listTaxDocuments(pool, year, todayStr()) });
  } catch (e) {
    console.error("POST /api/tax/documents/suggest error:", e.message);
    res.status(500).json({ error: "Could not suggest tax documents." });
  }
});

router.patch("/api/tax/documents/:id", async (req, res) => {
  const id = idFrom(req.params.id, res);
  if (id == null) return;
  const b = req.body || {};
  const sets = [];
  const values = [];
  const add = (sql, v) => { values.push(v); sets.push(sql.replace("?", "$" + values.length)); };
  if (b.received !== undefined) {
    if (typeof b.received !== "boolean") return res.status(400).json({ error: "received must be true or false" });
    add("received_at = ?::date", b.received ? todayStr() : null);
  }
  if (b.dismissed !== undefined) {
    if (typeof b.dismissed !== "boolean") return res.status(400).json({ error: "dismissed must be true or false" });
    sets.push(b.dismissed ? "dismissed_at = COALESCE(dismissed_at, now())" : "dismissed_at = NULL");
  }
  if (b.notes !== undefined) {
    const n = notesFrom(b.notes);
    if (n.error) return res.status(400).json({ error: n.error });
    add("notes = ?", n.value);
  }
  if (b.expected_by !== undefined) {
    const d = dateFrom(b.expected_by);
    if (d.error) return res.status(400).json({ error: d.error });
    add("expected_by = ?::date", d.value);
  }
  if (!sets.length) return res.status(400).json({ error: "Nothing to update — send received, dismissed, notes or expected_by" });
  try {
    values.push(id);
    const r = await pool.query(
      `UPDATE tax_documents SET ${sets.join(", ")}, updated_at = now() WHERE id = $${values.length} RETURNING ${docs.COLUMNS}`,
      values
    );
    if (!r.rows.length) return res.status(404).json({ error: "Tax document not found" });
    linkedTasks.kick("tax-document-edit");
    res.json({ document: r.rows[0] });
  } catch (e) {
    console.error("PATCH /api/tax/documents/:id error:", e.message);
    res.status(500).json({ error: "Could not update the tax document." });
  }
});

router.delete("/api/tax/documents/:id", async (req, res) => {
  const id = idFrom(req.params.id, res);
  if (id == null) return;
  try {
    const cur = await pool.query("SELECT origin FROM tax_documents WHERE id = $1", [id]);
    if (!cur.rows.length) return res.status(404).json({ error: "Tax document not found" });
    if (cur.rows[0].origin !== "manual") {
      return res.status(409).json({ error: "A suggested document can't be deleted — dismiss it instead, so it isn't suggested again.", reason: "suggested" });
    }
    await pool.query("DELETE FROM tax_documents WHERE id = $1 AND origin = 'manual'", [id]);
    linkedTasks.kick("tax-document-delete");
    res.json({ ok: true });
  } catch (e) {
    console.error("DELETE /api/tax/documents/:id error:", e.message);
    res.status(500).json({ error: "Could not delete the tax document." });
  }
});

module.exports = router;
