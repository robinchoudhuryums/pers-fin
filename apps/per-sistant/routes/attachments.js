const express = require("express");
const fs = require("fs");
const path = require("path");
let multer;
try { multer = require("multer"); } catch { multer = null; }

const { serverError } = require("../errors");

// Attachment bytes are stored in Postgres (attachments.data, db/025 — F121):
// the old uploads/ directory is Render's ephemeral disk, wiped on every deploy.
const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024; // 10MB per file
const ENTITY_TYPES = ["todo", "email", "note"];
// Every column but the bytes — list endpoints never ship file contents.
const META_COLUMNS = "id, filename, original_name, mime_type, size_bytes, entity_type, entity_id, created_at, (data IS NOT NULL) AS stored";

const LEGACY_UPLOADS_DIR = path.join(__dirname, "..", "uploads");

// One-time, best-effort copy of legacy on-disk attachments into the table.
// A row whose file is already gone stays as-is (the download says so).
async function migrateDiskAttachments(pool, dir = LEGACY_UPLOADS_DIR) {
  let moved = 0;
  try {
    if (!fs.existsSync(dir)) return 0;
    const r = await pool.query("SELECT id, filename FROM attachments WHERE data IS NULL");
    for (const row of r.rows) {
      const filePath = path.join(dir, path.basename(String(row.filename || "")));
      if (!row.filename || !fs.existsSync(filePath)) continue;
      try {
        await pool.query("UPDATE attachments SET data = $1 WHERE id = $2 AND data IS NULL", [fs.readFileSync(filePath), row.id]);
        moved++;
      } catch (err) { console.error("attachment migrate error:", row.id, err.message); }
    }
  } catch (err) { console.error("attachment migrate error:", err.message); }
  return moved;
}

module.exports = function ({ pool }) {
  const router = express.Router();

  // Memory storage: the bytes go straight into the row (10MB cap).
  const upload = multer ? multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: MAX_ATTACHMENT_BYTES },
  }) : null;

  // Copy any legacy files that are still on this disk (fail-soft, async).
  migrateDiskAttachments(pool).then((n) => { if (n) console.log(`Moved ${n} attachment(s) from disk into Postgres`); });

  // Declared BEFORE the generic /:entityType/:entityId route (F121): that one
  // matched /download/7 first (entityType "download" → 400), so no attachment
  // could ever be downloaded.
  router.get("/api/attachments/download/:id", async (req, res) => {
    try {
      const r = await pool.query("SELECT * FROM attachments WHERE id = $1", [req.params.id]);
      if (!r.rows.length) return res.status(404).json({ error: "Not found." });
      const row = r.rows[0];
      let bytes = row.data;
      if (!bytes) {
        // A legacy row: its file may still be on this disk.
        const filePath = path.join(LEGACY_UPLOADS_DIR, path.basename(String(row.filename || "")));
        if (!row.filename || !fs.existsSync(filePath)) {
          return res.status(404).json({ error: "This attachment's file is no longer available (it was stored on the server's temporary disk)." });
        }
        bytes = fs.readFileSync(filePath);
      }
      // Sanitize the user-supplied original_name before putting it in the
      // Content-Disposition header (PS-5): strip quotes/backslashes and control
      // chars (incl. CR/LF) so it can't break out of the quoted value or inject
      // a header, and also emit RFC 5987 filename* for correct UTF-8 handling.
      const rawName = String(row.original_name || "download");
      const asciiName = rawName.replace(/["\\]/g, "_").replace(/[\u0000-\u001f\u007f]/g, "");
      const safeName = asciiName.trim() || "download";
      const encodedName = encodeURIComponent(rawName).replace(/['()*]/g, escape);
      res.setHeader("Content-Disposition", `attachment; filename="${safeName}"; filename*=UTF-8''${encodedName}`);
      res.setHeader("Content-Type", row.mime_type);
      res.send(bytes);
    } catch (err) { serverError(res, err); }
  });

  router.get("/api/attachments/:entityType/:entityId", async (req, res) => {
    try {
      const { entityType, entityId } = req.params;
      if (!ENTITY_TYPES.includes(entityType)) return res.status(400).json({ error: "Invalid entity type." });
      const r = await pool.query(`SELECT ${META_COLUMNS} FROM attachments WHERE entity_type = $1 AND entity_id = $2 ORDER BY created_at DESC`, [entityType, entityId]);
      res.json(r.rows);
    } catch (err) { serverError(res, err); }
  });

  if (upload) {
    router.post("/api/attachments/:entityType/:entityId", (req, res, next) => {
      upload.single("file")(req, res, (err) => {
        if (err && err.code === "LIMIT_FILE_SIZE") return res.status(400).json({ error: "File is larger than 10MB." });
        if (err) return next(err);
        next();
      });
    }, async (req, res) => {
      try {
        const { entityType, entityId } = req.params;
        if (!ENTITY_TYPES.includes(entityType)) return res.status(400).json({ error: "Invalid entity type." });
        if (!req.file) return res.status(400).json({ error: "No file uploaded." });
        const filename = Date.now() + "-" + req.file.originalname.replace(/[^a-zA-Z0-9._-]/g, "_");
        const r = await pool.query(
          `INSERT INTO attachments (filename, original_name, mime_type, size_bytes, entity_type, entity_id, data)
           VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING ${META_COLUMNS}`,
          [filename, req.file.originalname, req.file.mimetype, req.file.size, entityType, entityId, req.file.buffer]
        );
        res.json(r.rows[0]);
      } catch (err) { serverError(res, err); }
    });
  }

  router.delete("/api/attachments/:id", async (req, res) => {
    try {
      const r = await pool.query("DELETE FROM attachments WHERE id = $1 RETURNING id, filename", [req.params.id]);
      if (!r.rows.length) return res.status(404).json({ error: "Not found." });
      removeLegacyFile(r.rows[0].filename);
      res.json({ ok: true });
    } catch (err) { serverError(res, err); }
  });

  return router;
};

// Best-effort removal of a legacy on-disk copy.
function removeLegacyFile(filename) {
  if (!filename) return;
  const filePath = path.join(LEGACY_UPLOADS_DIR, path.basename(String(filename)));
  try { if (fs.existsSync(filePath)) fs.unlinkSync(filePath); }
  catch (err) { console.error("attachment file remove error:", err.message); }
}

// The attachments of an email, as nodemailer attachment objects (roadmap
// T1.5): uploaded files used to be stored but never sent. Every attachment
// must be included — a send with one missing would go out incomplete — so a
// legacy row whose disk file is gone, or a total over MAX_EMAIL_ATTACHMENT_BYTES,
// throws an error with a `code` and a message the sender shows / stores.
const MAX_EMAIL_ATTACHMENT_BYTES = 20 * 1024 * 1024;
async function loadEmailAttachments(pool, emailId, { maxBytes = MAX_EMAIL_ATTACHMENT_BYTES, dir = LEGACY_UPLOADS_DIR } = {}) {
  const r = await pool.query(
    "SELECT id, filename, original_name, mime_type, data FROM attachments WHERE entity_type = 'email' AND entity_id = $1 ORDER BY id",
    [emailId]);
  const out = [];
  let total = 0;
  for (const row of r.rows) {
    const name = String(row.original_name || row.filename || "attachment");
    let bytes = row.data;
    if (!bytes) {
      const filePath = path.join(dir, path.basename(String(row.filename || "")));
      if (row.filename && fs.existsSync(filePath)) bytes = fs.readFileSync(filePath);
    }
    if (!bytes) {
      const err = new Error(`Attachment "${name}" is no longer available — remove it or upload it again, then send.`);
      err.code = "ATTACHMENT_MISSING";
      throw err;
    }
    total += bytes.length;
    if (total > maxBytes) {
      const err = new Error(`Attachments total more than ${Math.round(maxBytes / 1024 / 1024)}MB — remove some, then send.`);
      err.code = "ATTACHMENT_TOO_LARGE";
      throw err;
    }
    out.push({ filename: name, content: bytes, contentType: row.mime_type || "application/octet-stream" });
  }
  return out;
}

// Helpers attached AFTER module.exports = router factory (INV-19).
module.exports.migrateDiskAttachments = migrateDiskAttachments;
module.exports.removeLegacyFile = removeLegacyFile;
module.exports.MAX_ATTACHMENT_BYTES = MAX_ATTACHMENT_BYTES;
module.exports.loadEmailAttachments = loadEmailAttachments;
module.exports.MAX_EMAIL_ATTACHMENT_BYTES = MAX_EMAIL_ATTACHMENT_BYTES;
