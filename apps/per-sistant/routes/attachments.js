const express = require("express");
const fs = require("fs");
const path = require("path");
let multer;
try { multer = require("multer"); } catch { multer = null; }

const { serverError } = require("../errors");

module.exports = function ({ pool }) {
  const router = express.Router();

  const uploadsDir = path.join(__dirname, "..", "uploads");
  if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });

  const upload = multer ? multer({
    storage: multer.diskStorage({
      destination: uploadsDir,
      filename: (req, file, cb) => cb(null, Date.now() + "-" + file.originalname.replace(/[^a-zA-Z0-9._-]/g, "_")),
    }),
    limits: { fileSize: 10 * 1024 * 1024 }, // 10MB
  }) : null;

  router.get("/api/attachments/:entityType/:entityId", async (req, res) => {
    try {
      const { entityType, entityId } = req.params;
      if (!["todo", "email", "note"].includes(entityType)) return res.status(400).json({ error: "Invalid entity type." });
      const r = await pool.query("SELECT * FROM attachments WHERE entity_type = $1 AND entity_id = $2 ORDER BY created_at DESC", [entityType, entityId]);
      res.json(r.rows);
    } catch (err) { serverError(res, err); }
  });

  if (upload) {
    router.post("/api/attachments/:entityType/:entityId", upload.single("file"), async (req, res) => {
      try {
        const { entityType, entityId } = req.params;
        if (!["todo", "email", "note"].includes(entityType)) return res.status(400).json({ error: "Invalid entity type." });
        if (!req.file) return res.status(400).json({ error: "No file uploaded." });
        const r = await pool.query(
          "INSERT INTO attachments (filename, original_name, mime_type, size_bytes, entity_type, entity_id) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *",
          [req.file.filename, req.file.originalname, req.file.mimetype, req.file.size, entityType, entityId]
        );
        res.json(r.rows[0]);
      } catch (err) { serverError(res, err); }
    });
  }

  router.get("/api/attachments/download/:id", async (req, res) => {
    try {
      const r = await pool.query("SELECT * FROM attachments WHERE id = $1", [req.params.id]);
      if (!r.rows.length) return res.status(404).json({ error: "Not found." });
      const filePath = path.join(uploadsDir, r.rows[0].filename);
      if (!fs.existsSync(filePath)) return res.status(404).json({ error: "File not found on disk." });
      // Sanitize the user-supplied original_name before putting it in the
      // Content-Disposition header (PS-5): strip quotes/backslashes and control
      // chars (incl. CR/LF) so it can't break out of the quoted value or inject
      // a header, and also emit RFC 5987 filename* for correct UTF-8 handling.
      const rawName = String(r.rows[0].original_name || "download");
      const asciiName = rawName.replace(/["\\]/g, "_").replace(/[\u0000-\u001f\u007f]/g, "");
      const safeName = asciiName.trim() || "download";
      const encodedName = encodeURIComponent(rawName).replace(/['()*]/g, escape);
      res.setHeader("Content-Disposition", `attachment; filename="${safeName}"; filename*=UTF-8''${encodedName}`);
      res.setHeader("Content-Type", r.rows[0].mime_type);
      fs.createReadStream(filePath).pipe(res);
    } catch (err) { serverError(res, err); }
  });

  router.delete("/api/attachments/:id", async (req, res) => {
    try {
      const r = await pool.query("DELETE FROM attachments WHERE id = $1 RETURNING *", [req.params.id]);
      if (!r.rows.length) return res.status(404).json({ error: "Not found." });
      const filePath = path.join(uploadsDir, r.rows[0].filename);
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
      res.json({ ok: true });
    } catch (err) { serverError(res, err); }
  });

  return router;
};
