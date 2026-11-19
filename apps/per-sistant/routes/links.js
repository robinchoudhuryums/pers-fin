// ============================================================================
// Per-sistant — Cross-Entity Link Routes
// ============================================================================

const express = require("express");

const { serverError } = require("../errors");
const { announceTodoEvent } = require("../helpers");

module.exports = function ({ pool }) {
  const router = express.Router();

  router.get("/api/links/:type/:id", async (req, res) => {
    try {
      const { type, id } = req.params;
      if (!["todo", "email", "note"].includes(type)) return res.status(400).json({ error: "Invalid entity type." });
      const [outgoing, incoming] = await Promise.all([
        pool.query(`SELECT el.*,
          CASE el.target_type
            WHEN 'todo' THEN (SELECT title FROM todos WHERE id = el.target_id)
            WHEN 'email' THEN (SELECT subject FROM emails WHERE id = el.target_id)
            WHEN 'note' THEN (SELECT COALESCE(title, CASE WHEN sensitivity = 'secret' THEN 'Secret note' ELSE LEFT(content, 50) END) FROM notes WHERE id = el.target_id)
          END as target_title
          FROM entity_links el WHERE el.source_type = $1 AND el.source_id = $2`, [type, id]),
        pool.query(`SELECT el.*,
          CASE el.source_type
            WHEN 'todo' THEN (SELECT title FROM todos WHERE id = el.source_id)
            WHEN 'email' THEN (SELECT subject FROM emails WHERE id = el.source_id)
            WHEN 'note' THEN (SELECT COALESCE(title, CASE WHEN sensitivity = 'secret' THEN 'Secret note' ELSE LEFT(content, 50) END) FROM notes WHERE id = el.source_id)
          END as source_title
          FROM entity_links el WHERE el.target_type = $1 AND el.target_id = $2`, [type, id]),
      ]);
      res.json({ outgoing: outgoing.rows, incoming: incoming.rows });
    } catch (err) { serverError(res, err); }
  });

  router.post("/api/links", async (req, res) => {
    try {
      const { source_type, source_id, target_type, target_id } = req.body;
      if (!["todo", "email", "note"].includes(source_type) || !["todo", "email", "note"].includes(target_type)) {
        return res.status(400).json({ error: "Invalid entity type." });
      }
      if (source_type === target_type && parseInt(source_id) === parseInt(target_id)) {
        return res.status(400).json({ error: "Cannot link an entity to itself." });
      }
      const r = await pool.query(
        "INSERT INTO entity_links (source_type, source_id, target_type, target_id) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING RETURNING *",
        [source_type, source_id, target_type, target_id]
      );
      if (!r.rows.length) return res.status(409).json({ error: "Link already exists." });
      res.json(r.rows[0]);
    } catch (err) { serverError(res, err); }
  });

  router.delete("/api/links/:id", async (req, res) => {
    try {
      const r = await pool.query("DELETE FROM entity_links WHERE id = $1 RETURNING id", [req.params.id]);
      if (!r.rows.length) return res.status(404).json({ error: "Not found." });
      res.json({ ok: true });
    } catch (err) { serverError(res, err); }
  });

  // Create todo from note
  router.post("/api/notes/:id/create-todo", async (req, res) => {
    try {
      const note = await pool.query("SELECT * FROM notes WHERE id = $1 AND deleted_at IS NULL", [req.params.id]);
      if (!note.rows.length) return res.status(404).json({ error: "Note not found." });
      const n = note.rows[0];
      const { priority, horizon } = req.body;
      // Cycle-9 F56: a todo has no privacy tier — its title and description go
      // to webhooks / Slack, Ask and the AI briefing. A private or secret
      // note's TEXT is never copied into one (F134): the todo gets the note's
      // title (or a plain label) and no description; the link back to the note
      // is the reference.
      const fields = todoFieldsFromNote(n);
      const todo = await pool.query(
        "INSERT INTO todos (title, description, priority, horizon) VALUES ($1, $2, $3, $4) RETURNING *",
        [fields.title, fields.description, priority || "medium", horizon || "short"]
      );
      // Create cross-entity link
      await pool.query("INSERT INTO entity_links (source_type, source_id, target_type, target_id) VALUES ('note', $1, 'todo', $2) ON CONFLICT DO NOTHING",
        [n.id, todo.rows[0].id]);
      announceTodoEvent("todo_created", todo.rows[0]); // F124 parity
      res.json(todo.rows[0]);
    } catch (err) { serverError(res, err); }
  });

  // Create todo from email
  router.post("/api/emails/:id/create-todo", async (req, res) => {
    try {
      const email = await pool.query("SELECT * FROM emails WHERE id = $1 AND deleted_at IS NULL", [req.params.id]);
      if (!email.rows.length) return res.status(404).json({ error: "Email not found." });
      const e = email.rows[0];
      const { priority, horizon } = req.body;
      const todo = await pool.query(
        "INSERT INTO todos (title, description, priority, horizon) VALUES ($1, $2, $3, $4) RETURNING *",
        [e.subject, `Follow up on email to ${e.recipient_name || e.recipient_email}: ${e.body.substring(0, 200)}`, priority || "medium", horizon || "short"]
      );
      await pool.query("INSERT INTO entity_links (source_type, source_id, target_type, target_id) VALUES ('email', $1, 'todo', $2) ON CONFLICT DO NOTHING",
        [e.id, todo.rows[0].id]);
      announceTodoEvent("todo_created", todo.rows[0]); // F124 parity
      res.json(todo.rows[0]);
    } catch (err) { serverError(res, err); }
  });

  return router;
};

// What a todo made from a note may carry (cycle-9 F56). A normal note: its
// title (else the first 100 characters) and its text. A private or secret
// note — or one whose tier isn't a known value — never its text.
function todoFieldsFromNote(n) {
  const content = String((n && n.content) || "");
  const tier = (n && n.sensitivity) || "normal";
  if (tier === "normal") return { title: n.title || content.substring(0, 100), description: content };
  return { title: n.title || (tier === "secret" ? "Secret note" : "Private note"), description: null };
}
module.exports.todoFieldsFromNote = todoFieldsFromNote;
