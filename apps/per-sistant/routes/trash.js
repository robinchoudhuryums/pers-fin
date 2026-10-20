const express = require("express");

const { serverError } = require("../errors");
const { removeLegacyFile } = require("./attachments");

const TABLES = { todo: "todos", email: "emails", note: "notes" };
// How long a soft-deleted item stays in the trash (the UI promises 30 days).
const TRASH_RETENTION_DAYS = 30;

// Everything that hangs off a permanently deleted todo / email / note.
// Fail-soft — a purge failure must not turn a successful delete into a 500.
//  - attachments + entity_links have no FK to their entity, so they outlived
//    it (F121: orphaned rows, and links to an id that no longer exists);
//  - a note's Knowledge chunks/embed_state (KR-6) stayed vector-retrievable
//    until the next syncNotes sweep (the retrieval query's n.id IS NOT NULL
//    guard still hides the orphans; the Knowledge tables may not exist).
async function purgeEntityLeftovers(pool, type, ids) {
  if (!ids.length) return;
  const att = await pool.query("DELETE FROM attachments WHERE entity_type = $1 AND entity_id = ANY($2) RETURNING filename", [type, ids])
    .catch((err) => { console.error("trash attachment purge error:", err.message); return { rows: [] }; });
  (att.rows || []).forEach((r) => removeLegacyFile(r.filename));
  await pool.query("DELETE FROM entity_links WHERE (source_type = $1 AND source_id = ANY($2)) OR (target_type = $1 AND target_id = ANY($2))", [type, ids])
    .catch((err) => console.error("trash link purge error:", err.message));
  if (type === "note") {
    await pool.query("DELETE FROM chunks WHERE source_kind = 'note' AND source_id = ANY($1)", [ids]).catch(() => {});
    await pool.query("DELETE FROM embed_state WHERE source_kind = 'note' AND source_id = ANY($1)", [ids]).catch(() => {});
  }
}

// Permanently delete trashed rows (all of them, or only those trashed more
// than `olderThanDays` ago) and their leftovers. Used by Empty Trash and by
// the daily purge cron (F122 — the UI promised 30-day retention, but nothing
// ever purged, so the trash grew forever).
async function purgeTrash(pool, olderThanDays = null) {
  const cond = olderThanDays == null ? "deleted_at IS NOT NULL" : "deleted_at < now() - make_interval(days => $1)";
  const params = olderThanDays == null ? [] : [olderThanDays];
  const out = {};
  for (const [type, table] of Object.entries(TABLES)) {
    const r = await pool.query(`DELETE FROM ${table} WHERE ${cond} RETURNING id`, params);
    const ids = (r.rows || []).map((x) => x.id);
    await purgeEntityLeftovers(pool, type, ids);
    out[table] = ids.length;
  }
  return out;
}

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
    } catch (err) { serverError(res, err); }
  });

  router.post("/api/trash/:type/:id/restore", async (req, res) => {
    try {
      const { type, id } = req.params;
      const table = TABLES[type];
      if (!table) return res.status(400).json({ error: "Invalid type. Must be: todo, email, or note" });
      const r = await pool.query(`UPDATE ${table} SET deleted_at = NULL WHERE id = $1 AND deleted_at IS NOT NULL RETURNING id`, [id]);
      if (!r.rows.length) return res.status(404).json({ error: "Not found in trash." });
      res.json({ ok: true, message: "Item restored." });
    } catch (err) { serverError(res, err); }
  });

  router.delete("/api/trash/:type/:id", async (req, res) => {
    try {
      const { type, id } = req.params;
      const table = TABLES[type];
      if (!table) return res.status(400).json({ error: "Invalid type. Must be: todo, email, or note" });
      const r = await pool.query(`DELETE FROM ${table} WHERE id = $1 AND deleted_at IS NOT NULL RETURNING id`, [id]);
      if (!r.rows.length) return res.status(404).json({ error: "Not found in trash." });
      await purgeEntityLeftovers(pool, type, r.rows.map((x) => x.id));
      res.json({ ok: true, message: "Permanently deleted." });
    } catch (err) { serverError(res, err); }
  });

  router.post("/api/trash/empty", async (req, res) => {
    try {
      await purgeTrash(pool);
      res.json({ ok: true, message: "Trash emptied." });
    } catch (err) { serverError(res, err); }
  });

  return router;
};

// Helpers attached AFTER module.exports = router factory (INV-19).
module.exports.purgeTrash = purgeTrash;
module.exports.purgeEntityLeftovers = purgeEntityLeftovers;
module.exports.TRASH_RETENTION_DAYS = TRASH_RETENTION_DAYS;
