const express = require("express");
const { isAIAvailable } = require("../ai");
const { loadKeepAliveConfig } = require("../services/keep-alive");

const VALID_PALETTES = ["copper", "indigo", "forest", "slate", "plum", "mono"];

const { serverError } = require("../errors");

module.exports = function ({ pool, config }) {
  const router = express.Router();
  const { AUTH_MODE, PERFIN_URL } = config;

  // Keep-alive schedule — no auth required (used by GitHub Actions cron)
  router.get("/api/keep-alive-schedule", async (req, res) => {
    try {
      const cfg = await loadKeepAliveConfig();
      res.json({
        enabled: cfg.keep_alive_enabled,
        start: cfg.keep_alive_start,
        end: cfg.keep_alive_end,
        timezone: cfg.keep_alive_timezone,
      });
    } catch (err) {
      res.json({ enabled: false });
    }
  });

  router.get("/api/settings", async (req, res) => {
    try {
      const r = await pool.query("SELECT * FROM user_settings WHERE id = 1");
      const settings = r.rows[0] || { theme: "dark", session_timeout_minutes: 15, default_horizon: "short", palette: "copper" };
      settings.smtp_configured = !!(process.env.SMTP_HOST && process.env.SMTP_USER);
      settings.ai_configured = isAIAvailable();
      settings.perfin_url = PERFIN_URL || settings.perfin_url || null;
      settings.perfin_webhook_configured = !!process.env.PERSISTENT_WEBHOOK_SECRET;
      settings.palette = settings.palette || "copper";
      res.json(settings);
    } catch (err) {
      serverError(res, err);
    }
  });

  router.patch("/api/settings", async (req, res) => {
    try {
      const { theme, session_timeout_minutes, default_horizon, perfin_url, perfin_webhook_recipient, palette, dashboard_layout, slack_webhook_url, keep_alive_enabled, keep_alive_start, keep_alive_end, keep_alive_timezone, vault_enabled, vault_repo, vault_branch } = req.body;
      const fields = [];
      const params = [];
      let idx = 1;
      if (theme !== undefined) { fields.push(`theme = $${idx++}`); params.push(theme); }
      if (session_timeout_minutes !== undefined) { fields.push(`session_timeout_minutes = $${idx++}`); params.push(session_timeout_minutes); }
      if (default_horizon !== undefined) { fields.push(`default_horizon = $${idx++}`); params.push(default_horizon); }
      if (perfin_url !== undefined) { fields.push(`perfin_url = $${idx++}`); params.push(perfin_url || null); }
      if (perfin_webhook_recipient !== undefined) { fields.push(`perfin_webhook_recipient = $${idx++}`); params.push(perfin_webhook_recipient || null); }
      if (palette !== undefined) {
        if (!VALID_PALETTES.includes(palette)) return res.status(400).json({ error: `palette must be one of ${VALID_PALETTES.join(", ")}` });
        fields.push(`palette = $${idx++}`); params.push(palette);
      }
      if (dashboard_layout !== undefined) { fields.push(`dashboard_layout = $${idx++}`); params.push(JSON.stringify(dashboard_layout)); }
      if (slack_webhook_url !== undefined) {
        // Reject an SSRF-prone Slack URL at write-time (PB-5), parallel to how
        // webhook URLs are validated on create. Empty clears it.
        if (slack_webhook_url && !config.isValidWebhookUrl(slack_webhook_url)) {
          return res.status(400).json({ error: "Invalid Slack webhook URL. Must be a public http/https URL." });
        }
        fields.push(`slack_webhook_url = $${idx++}`); params.push(slack_webhook_url || null);
      }
      if (keep_alive_enabled !== undefined) { fields.push(`keep_alive_enabled = $${idx++}`); params.push(!!keep_alive_enabled); }
      if (keep_alive_start !== undefined) { fields.push(`keep_alive_start = $${idx++}`); params.push(parseInt(keep_alive_start) || 0); }
      if (keep_alive_end !== undefined) { fields.push(`keep_alive_end = $${idx++}`); params.push(parseInt(keep_alive_end) || 0); }
      if (keep_alive_timezone !== undefined) { fields.push(`keep_alive_timezone = $${idx++}`); params.push(keep_alive_timezone || "America/New_York"); }
      // Knowledge / Obsidian vault config (non-secret — the GitHub token is the
      // VAULT_GITHUB_TOKEN env var, never stored here).
      if (vault_enabled !== undefined) { fields.push(`vault_enabled = $${idx++}`); params.push(!!vault_enabled); }
      if (vault_repo !== undefined) {
        const repo = vault_repo ? String(vault_repo).trim() : null;
        if (repo && !/^[\w.-]+\/[\w.-]+$/.test(repo)) {
          return res.status(400).json({ error: "vault_repo must be in 'owner/name' form." });
        }
        fields.push(`vault_repo = $${idx++}`); params.push(repo);
      }
      if (vault_branch !== undefined) { fields.push(`vault_branch = $${idx++}`); params.push((vault_branch && String(vault_branch).trim()) || "main"); }
      if (!fields.length) return res.status(400).json({ error: "No fields to update." });
      const r = await pool.query(`UPDATE user_settings SET ${fields.join(", ")} WHERE id = 1 RETURNING *`, params);
      if (theme && req.session) req.session.theme = theme;
      if (session_timeout_minutes && req.session) req.session.timeoutMinutes = session_timeout_minutes;
      res.json(r.rows[0]);
    } catch (err) {
      serverError(res, err);
    }
  });

  router.get("/api/stats", async (req, res) => {
    try {
      const [todos, emails, notes] = await Promise.all([
        pool.query("SELECT count(*) FILTER (WHERE NOT completed) as pending, count(*) FILTER (WHERE completed) as done, count(*) FILTER (WHERE NOT completed AND priority = 'urgent') as urgent, count(*) FILTER (WHERE NOT completed AND due_date <= CURRENT_DATE) as overdue FROM todos WHERE deleted_at IS NULL"),
        pool.query("SELECT count(*) FILTER (WHERE status = 'draft') as drafts, count(*) FILTER (WHERE status = 'scheduled') as scheduled, count(*) FILTER (WHERE status = 'sent') as sent, count(*) FILTER (WHERE status = 'failed') as failed FROM emails WHERE deleted_at IS NULL"),
        pool.query("SELECT count(*) as total FROM notes WHERE deleted_at IS NULL"),
      ]);
      res.json({
        todos: todos.rows[0],
        emails: emails.rows[0],
        notes: notes.rows[0],
      });
    } catch (err) {
      serverError(res, err);
    }
  });

  return router;
};
