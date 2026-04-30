const express = require("express");
const fs = require("fs");
const path = require("path");
let multer;
try { multer = require("multer"); } catch { multer = null; }

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
    } catch (err) { res.status(500).json({ error: err.message }); }
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
      } catch (err) { res.status(500).json({ error: err.message }); }
    });
  }

  router.get("/api/attachments/download/:id", async (req, res) => {
    try {
      const r = await pool.query("SELECT * FROM attachments WHERE id = $1", [req.params.id]);
      if (!r.rows.length) return res.status(404).json({ error: "Not found." });
      const filePath = path.join(uploadsDir, r.rows[0].filename);
      if (!fs.existsSync(filePath)) return res.status(404).json({ error: "File not found on disk." });
      res.setHeader("Content-Disposition", `attachment; filename="${r.rows[0].original_name}"`);
      res.setHeader("Content-Type", r.rows[0].mime_type);
      fs.createReadStream(filePath).pipe(res);
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  router.delete("/api/attachments/:id", async (req, res) => {
    try {
      const r = await pool.query("DELETE FROM attachments WHERE id = $1 RETURNING *", [req.params.id]);
      if (!r.rows.length) return res.status(404).json({ error: "Not found." });
      const filePath = path.join(uploadsDir, r.rows[0].filename);
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
      res.json({ ok: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  return router;
};
