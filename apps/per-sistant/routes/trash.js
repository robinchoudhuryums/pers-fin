const express = require("express");

module.exports = function ({ pool }) {
  const router = express.Router();

  router.get("/api/trash", async (req, res) => {
    try {
      const [todos, emails, notes] = await Promise.all([
        pool.query("SELECT id, title, priority, horizon, deleted_at, 'todo' as type FROM todos WHERE deleted_at IS NOT NULL ORDER BY deleted_at DESC"),
        pool.query("SELECT id, subject as title, recipient_name, status, deleted_at, 'email' as type FROM emails WHERE deleted_at IS NOT NULL ORDER BY deleted_at DESC"),
        pool.query("SELECT id, COALESCE(title, LEFT(content, 50)) as title, deleted_at, 'note' as type FROM notes WHERE deleted_at IS NOT NULL ORDER BY deleted_at DESC"),
      ]);
      res.json([...todos.rows, ...emails.rows, ...notes.rows].sort((a, b) => new Date(b.deleted_at) - new Date(a.deleted_at)));
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  router.post("/api/trash/:type/:id/restore", async (req, res) => {
    try {
      const { type, id } = req.params;
      const table = { todo: "todos", email: "emails", note: "notes" }[type];
      if (!table) return res.status(400).json({ error: "Invalid type. Must be: todo, email, or note" });
      const r = await pool.query(`UPDATE ${table} SET deleted_at = NULL WHERE id = $1 AND deleted_at IS NOT NULL RETURNING id`, [id]);
      if (!r.rows.length) return res.status(404).json({ error: "Not found in trash." });
      res.json({ ok: true, message: "Item restored." });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  router.delete("/api/trash/:type/:id", async (req, res) => {
    try {
      const { type, id } = req.params;
      const table = { todo: "todos", email: "emails", note: "notes" }[type];
      if (!table) return res.status(400).json({ error: "Invalid type. Must be: todo, email, or note" });
      const r = await pool.query(`DELETE FROM ${table} WHERE id = $1 AND deleted_at IS NOT NULL RETURNING id`, [id]);
      if (!r.rows.length) return res.status(404).json({ error: "Not found in trash." });
      res.json({ ok: true, message: "Permanently deleted." });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  router.post("/api/trash/empty", async (req, res) => {
    try {
      await Promise.all([
        pool.query("DELETE FROM todos WHERE deleted_at IS NOT NULL"),
        pool.query("DELETE FROM emails WHERE deleted_at IS NOT NULL"),
        pool.query("DELETE FROM notes WHERE deleted_at IS NOT NULL"),
      ]);
      res.json({ ok: true, message: "Trash emptied." });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  return router;
};
