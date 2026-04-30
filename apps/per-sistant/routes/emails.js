const express = require("express");

let nodemailer;
try {
  nodemailer = require("nodemailer");
} catch {
  nodemailer = null;
}

module.exports = function createEmailRoutes({ pool, config, helpers }) {
  const router = express.Router();
  const { VALID_EMAIL_STATUSES, EMAIL_REGEX, MAX_PAGINATION_LIMIT, MAX_BODY_LENGTH } = config;
  const { fireWebhooks, sendSlackNotification, runAutomations } = helpers;

  // ============================================================================
  // API — Emails
  // ============================================================================

  router.get("/api/emails", async (req, res) => {
    try {
      const { status, limit, offset } = req.query;
      let where = ["deleted_at IS NULL"];
      let params = [];
      let idx = 1;
      if (status) { where.push(`status = $${idx++}`); params.push(status); }
      let pagination = "";
      if (limit) { pagination += ` LIMIT $${idx++}`; params.push(Math.min(Math.max(1, parseInt(limit, 10) || 20), MAX_PAGINATION_LIMIT)); }
      if (offset) { pagination += ` OFFSET $${idx++}`; params.push(Math.max(0, parseInt(offset, 10) || 0)); }
      const r = await pool.query(`SELECT * FROM emails WHERE ${where.join(" AND ")} ORDER BY CASE status WHEN 'scheduled' THEN 0 WHEN 'draft' THEN 1 WHEN 'sent' THEN 2 ELSE 3 END, created_at DESC${pagination}`, params);
      res.json(r.rows);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.post("/api/emails", async (req, res) => {
    try {
      const { recipient_name, recipient_email, subject, body, body_html, scheduled_at } = req.body;
      if (!recipient_email || !subject || !body) {
        return res.status(400).json({ error: "Recipient email, subject, and body are required." });
      }
      if (body.length > MAX_BODY_LENGTH) return res.status(400).json({ error: `Body too long. Maximum ${MAX_BODY_LENGTH} characters.` });
      if (!EMAIL_REGEX.test(recipient_email)) {
        return res.status(400).json({ error: "Invalid email address format." });
      }
      const status = scheduled_at ? "scheduled" : "draft";
      const r = await pool.query(
        `INSERT INTO emails (recipient_name, recipient_email, subject, body, body_html, status, scheduled_at) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
        [recipient_name || null, recipient_email, subject, body, body_html || null, status, scheduled_at || null]
      );
      res.json(r.rows[0]);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.patch("/api/emails/:id", async (req, res) => {
    try {
      const { recipient_name, recipient_email, subject, body, body_html, scheduled_at, status } = req.body;
      const fields = [];
      const params = [];
      let idx = 1;
      if (recipient_name !== undefined) { fields.push(`recipient_name = $${idx++}`); params.push(recipient_name); }
      if (recipient_email !== undefined) { fields.push(`recipient_email = $${idx++}`); params.push(recipient_email); }
      if (subject !== undefined) { fields.push(`subject = $${idx++}`); params.push(subject); }
      if (body !== undefined) { fields.push(`body = $${idx++}`); params.push(body); }
      if (body_html !== undefined) { fields.push(`body_html = $${idx++}`); params.push(body_html); }
      if (scheduled_at !== undefined) { fields.push(`scheduled_at = $${idx++}`); params.push(scheduled_at); }
      if (status !== undefined) { fields.push(`status = $${idx++}`); params.push(status); }
      if (!fields.length) return res.status(400).json({ error: "No fields to update." });
      params.push(req.params.id);
      const r = await pool.query(`UPDATE emails SET ${fields.join(", ")} WHERE id = $${idx} RETURNING *`, params);
      if (!r.rows.length) return res.status(404).json({ error: "Not found." });
      res.json(r.rows[0]);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.delete("/api/emails/:id", async (req, res) => {
    try {
      const r = await pool.query("UPDATE emails SET deleted_at = now() WHERE id = $1 AND deleted_at IS NULL RETURNING id", [req.params.id]);
      if (!r.rows.length) return res.status(404).json({ error: "Not found." });
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.post("/api/emails/:id/send", async (req, res) => {
    if (!nodemailer) return res.status(500).json({ error: "nodemailer not installed." });
    const smtpHost = process.env.SMTP_HOST;
    if (!smtpHost) return res.status(500).json({ error: "SMTP not configured. Set SMTP_HOST, SMTP_USER, SMTP_PASS in .env" });
    try {
      const r = await pool.query("SELECT * FROM emails WHERE id = $1", [req.params.id]);
      if (!r.rows.length) return res.status(404).json({ error: "Not found." });
      const email = r.rows[0];
      if (!EMAIL_REGEX.test(email.recipient_email)) {
        return res.status(400).json({ error: "Invalid recipient email address." });
      }
      const transporter = nodemailer.createTransport({
        host: smtpHost,
        port: parseInt(process.env.SMTP_PORT || "587", 10),
        secure: process.env.SMTP_PORT === "465",
        auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
      });
      const mail = {
        from: process.env.SMTP_FROM || process.env.SMTP_USER,
        to: email.recipient_email,
        subject: email.subject,
        text: email.body,
      };
      if (email.body_html) mail.html = email.body_html;
      await transporter.sendMail(mail);
      await pool.query("UPDATE emails SET status = 'sent', sent_at = now() WHERE id = $1", [req.params.id]);
      res.json({ ok: true, message: "Email sent successfully." });
    } catch (err) {
      await pool.query("UPDATE emails SET status = 'failed', error_message = $1 WHERE id = $2", [err.message, req.params.id]);
      res.status(500).json({ error: err.message });
    }
  });

  // ============================================================================
  // API — Email Templates
  // ============================================================================

  router.get("/api/email-templates", async (req, res) => {
    try {
      const r = await pool.query("SELECT * FROM email_templates ORDER BY name ASC");
      res.json(r.rows);
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  router.post("/api/email-templates", async (req, res) => {
    try {
      const { name, subject, body } = req.body;
      if (!name || !subject || !body) return res.status(400).json({ error: "Name, subject, and body required." });
      const r = await pool.query("INSERT INTO email_templates (name, subject, body) VALUES ($1,$2,$3) RETURNING *", [name, subject, body]);
      res.json(r.rows[0]);
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  router.patch("/api/email-templates/:id", async (req, res) => {
    try {
      const { name, subject, body } = req.body;
      const fields = []; const params = []; let idx = 1;
      if (name !== undefined) { fields.push(`name = $${idx++}`); params.push(name); }
      if (subject !== undefined) { fields.push(`subject = $${idx++}`); params.push(subject); }
      if (body !== undefined) { fields.push(`body = $${idx++}`); params.push(body); }
      if (!fields.length) return res.status(400).json({ error: "No fields." });
      params.push(req.params.id);
      const r = await pool.query(`UPDATE email_templates SET ${fields.join(", ")} WHERE id = $${idx} RETURNING *`, params);
      if (!r.rows.length) return res.status(404).json({ error: "Not found." });
      res.json(r.rows[0]);
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  router.delete("/api/email-templates/:id", async (req, res) => {
    try {
      const r = await pool.query("DELETE FROM email_templates WHERE id = $1 RETURNING id", [req.params.id]);
      if (!r.rows.length) return res.status(404).json({ error: "Not found." });
      res.json({ ok: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  return router;
};
