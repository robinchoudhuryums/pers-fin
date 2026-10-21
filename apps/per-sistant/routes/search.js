const express = require("express");

const { serverError } = require("../errors");

module.exports = function ({ pool }) {
  const router = express.Router();

  router.get("/api/search", async (req, res) => {
    try {
      const { q } = req.query;
      if (!q || q.length < 2) return res.json([]);
      // F124: the query is matched literally — % and _ are LIKE wildcards
      // ("100%" matched everything that contains "100"); escape them and \.
      const pattern = `%${String(q).replace(/[\\%_]/g, (c) => "\\" + c)}%`;
      const [todos, emails, notes, contacts] = await Promise.all([
        pool.query("SELECT id, title, description, priority, horizon, completed, recurring, 'todo' as type FROM todos WHERE deleted_at IS NULL AND (title ILIKE $1 OR description ILIKE $1) LIMIT 10", [pattern]),
        pool.query("SELECT id, subject as title, recipient_name as description, status, status as priority, 'email' as type FROM emails WHERE deleted_at IS NULL AND (subject ILIKE $1 OR body ILIKE $1 OR recipient_name ILIKE $1) LIMIT 10", [pattern]),
        // A secret note (F134) matches on its title only and shows no text.
        pool.query("SELECT id, COALESCE(title, CASE WHEN sensitivity = 'secret' THEN 'Secret note' ELSE LEFT(content, 50) END) as title, CASE WHEN sensitivity = 'secret' THEN NULL ELSE LEFT(content, 100) END as description, pinned, 'note' as type FROM notes WHERE deleted_at IS NULL AND (title ILIKE $1 OR (sensitivity <> 'secret' AND content ILIKE $1)) LIMIT 10", [pattern]),
        pool.query("SELECT id, name as title, email as description, 'contact' as type FROM contacts WHERE name ILIKE $1 OR email ILIKE $1 LIMIT 10", [pattern]),
      ]);
      res.json([...todos.rows, ...emails.rows, ...notes.rows, ...contacts.rows]);
    } catch (err) { serverError(res, err); }
  });

  return router;
};
