const express = require("express");

const { serverError } = require("../errors");

module.exports = function ({ pool }) {
  const router = express.Router();

  // Permanently deleting a note must also drop its Knowledge embeddings
  // (KR-6): chunks/embed_state have no FK to notes, so they outlived the row
  // until the next syncNotes sweep and stayed vector-retrievable in the
  // meantime. Fail-soft — the Knowledge tables may not exist (pre-013 DB),
  // and a purge failure must not turn a successful delete into a 500 (the
  // retrieval query's n.id IS NOT NULL guard still hides the orphans).
  async function purgeNoteChunks(ids) {
    if (!ids.length) return;
    await pool.query("DELETE FROM chunks WHERE source_kind = 'note' AND source_id = ANY($1)", [ids]).catch(() => {});
    await pool.query("DELETE FROM embed_state WHERE source_kind = 'note' AND source_id = ANY($1)", [ids]).catch(() => {});
  }

  router.get("/api/trash", async (req, res) => {
    try {
      const [todos, emails, notes] = await Promise.all([
        pool.query("SELECT id, title, priority, horizon, deleted_at, 'todo' as type FROM todos WHERE deleted_at IS NOT NULL ORDER BY deleted_at DESC"),
        pool.query("SELECT id, subject as title, recipient_name, status, deleted_at, 'email' as type FROM emails WHERE deleted_at IS NOT NULL ORDER BY deleted_at DESC"),
        pool.query("SELECT id, COALESCE(title, LEFT(content, 50)) as title, deleted_at, 'note' as type FROM notes WHERE deleted_at IS NOT NULL ORDER BY deleted_at DESC"),
      ]);
      res.json([...todos.rows, ...emails.rows, ...notes.rows].sort((a, b) => new Date(b.deleted_at) - new Date(a.deleted_at)));
    } catch (err) { serverError(res, err); }
  });

  router.post("/api/trash/:type/:id/restore", async (req, res) => {
    try {
      const { type, id } = req.params;
      const table = { todo: "todos", email: "emails", note: "notes" }[type];
      if (!table) return res.status(400).json({ error: "Invalid type. Must be: todo, email, or note" });
      const r = await pool.query(`UPDATE ${table} SET deleted_at = NULL WHERE id = $1 AND deleted_at IS NOT NULL RETURNING id`, [id]);
      if (!r.rows.length) return res.status(404).json({ error: "Not found in trash." });
      res.json({ ok: true, message: "Item restored." });
    } catch (err) { serverError(res, err); }
  });

  router.delete("/api/trash/:type/:id", async (req, res) => {
    try {
      const { type, id } = req.params;
      const table = { todo: "todos", email: "emails", note: "notes" }[type];
      if (!table) return res.status(400).json({ error: "Invalid type. Must be: todo, email, or note" });
      const r = await pool.query(`DELETE FROM ${table} WHERE id = $1 AND deleted_at IS NOT NULL RETURNING id`, [id]);
      if (!r.rows.length) return res.status(404).json({ error: "Not found in trash." });
      if (type === "note") await purgeNoteChunks(r.rows.map((x) => x.id));
      res.json({ ok: true, message: "Permanently deleted." });
    } catch (err) { serverError(res, err); }
  });

  router.post("/api/trash/empty", async (req, res) => {
    try {
      const [, , notes] = await Promise.all([
        pool.query("DELETE FROM todos WHERE deleted_at IS NOT NULL"),
        pool.query("DELETE FROM emails WHERE deleted_at IS NOT NULL"),
        pool.query("DELETE FROM notes WHERE deleted_at IS NOT NULL RETURNING id"),
      ]);
      await purgeNoteChunks((notes.rows || []).map((x) => x.id));
      res.json({ ok: true, message: "Trash emptied." });
    } catch (err) { serverError(res, err); }
  });

  return router;
};
