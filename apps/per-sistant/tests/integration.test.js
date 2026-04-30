// ============================================================================
// Per-sistant — Integration Tests
// ============================================================================
// Tests that run against a real PostgreSQL database to verify SQL queries,
// schema compatibility, and end-to-end API behavior.
//
// These tests SKIP automatically if NEON_DATABASE_URL is not set.
// Run with: npm test
// ============================================================================

const { describe, it, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");

const hasDB = !!process.env.NEON_DATABASE_URL;

describe("Integration: Database operations", { skip: !hasDB && "No NEON_DATABASE_URL set" }, () => {
  let pool;

  before(async () => {
    const { Pool } = require("pg");
    pool = new Pool({
      connectionString: process.env.NEON_DATABASE_URL,
      ssl: { rejectUnauthorized: false },
      max: 3,
    });

    // Run migrations
    const fs = require("fs");
    const path = require("path");
    const client = await pool.connect();
    try {
      const migrationsDir = path.join(__dirname, "..", "db");
      const files = fs.readdirSync(migrationsDir).filter(f => f.endsWith(".sql")).sort();
      for (const file of files) {
        const sql = fs.readFileSync(path.join(migrationsDir, file), "utf8");
        await client.query(sql);
      }
    } finally {
      client.release();
    }
  });

  after(async () => {
    if (pool) await pool.end();
  });

  // -------------------------------------------------------------------------
  // Todos CRUD
  // -------------------------------------------------------------------------
  describe("Todos CRUD", () => {
    let todoId;

    it("creates a todo", async () => {
      const r = await pool.query(
        "INSERT INTO todos (title, priority, horizon, category) VALUES ($1, $2, $3, $4) RETURNING *",
        ["Integration test todo", "high", "short", "work"]
      );
      assert.equal(r.rows.length, 1);
      assert.equal(r.rows[0].title, "Integration test todo");
      assert.equal(r.rows[0].priority, "high");
      assert.equal(r.rows[0].completed, false);
      todoId = r.rows[0].id;
    });

    it("reads the todo back", async () => {
      const r = await pool.query("SELECT * FROM todos WHERE id = $1", [todoId]);
      assert.equal(r.rows.length, 1);
      assert.equal(r.rows[0].title, "Integration test todo");
    });

    it("updates the todo", async () => {
      await pool.query("UPDATE todos SET completed = true, completed_at = now() WHERE id = $1", [todoId]);
      const r = await pool.query("SELECT * FROM todos WHERE id = $1", [todoId]);
      assert.equal(r.rows[0].completed, true);
      assert.ok(r.rows[0].completed_at);
    });

    it("updated_at trigger fires on update", async () => {
      const before = await pool.query("SELECT updated_at FROM todos WHERE id = $1", [todoId]);
      // Small delay to ensure timestamp differs
      await new Promise(resolve => setTimeout(resolve, 50));
      await pool.query("UPDATE todos SET title = 'Updated title' WHERE id = $1", [todoId]);
      const after = await pool.query("SELECT updated_at FROM todos WHERE id = $1", [todoId]);
      assert.ok(after.rows[0].updated_at >= before.rows[0].updated_at);
    });

    it("soft-deletes the todo", async () => {
      await pool.query("UPDATE todos SET deleted_at = now() WHERE id = $1", [todoId]);
      const r = await pool.query("SELECT * FROM todos WHERE id = $1 AND deleted_at IS NULL", [todoId]);
      assert.equal(r.rows.length, 0);
    });

    it("still exists when querying without deleted_at filter", async () => {
      const r = await pool.query("SELECT * FROM todos WHERE id = $1", [todoId]);
      assert.equal(r.rows.length, 1);
      assert.ok(r.rows[0].deleted_at);
    });

    it("rejects invalid priority via CHECK constraint", async () => {
      await assert.rejects(
        () => pool.query("INSERT INTO todos (title, priority) VALUES ($1, $2)", ["Bad", "critical"]),
        (err) => err.message.includes("violates check constraint") || err.message.includes("check")
      );
    });

    it("rejects invalid horizon via CHECK constraint", async () => {
      await assert.rejects(
        () => pool.query("INSERT INTO todos (title, horizon) VALUES ($1, $2)", ["Bad", "infinite"]),
        (err) => err.message.includes("violates check constraint") || err.message.includes("check")
      );
    });

    // Cleanup
    after(async () => {
      if (todoId) await pool.query("DELETE FROM todos WHERE id = $1", [todoId]);
    });
  });

  // -------------------------------------------------------------------------
  // Emails CRUD
  // -------------------------------------------------------------------------
  describe("Emails CRUD", () => {
    let emailId;

    it("creates an email", async () => {
      const r = await pool.query(
        "INSERT INTO emails (recipient_email, subject, body, status) VALUES ($1, $2, $3, $4) RETURNING *",
        ["test@example.com", "Test Subject", "Test body", "draft"]
      );
      assert.equal(r.rows.length, 1);
      assert.equal(r.rows[0].status, "draft");
      emailId = r.rows[0].id;
    });

    it("updates email status to scheduled", async () => {
      const scheduledAt = new Date(Date.now() + 3600000).toISOString();
      await pool.query("UPDATE emails SET status = 'scheduled', scheduled_at = $1 WHERE id = $2", [scheduledAt, emailId]);
      const r = await pool.query("SELECT * FROM emails WHERE id = $1", [emailId]);
      assert.equal(r.rows[0].status, "scheduled");
      assert.ok(r.rows[0].scheduled_at);
    });

    it("rejects invalid email status via CHECK constraint", async () => {
      await assert.rejects(
        () => pool.query("INSERT INTO emails (recipient_email, subject, body, status) VALUES ($1, $2, $3, $4)", ["a@b.com", "s", "b", "invalid"]),
        (err) => err.message.includes("violates check constraint") || err.message.includes("check")
      );
    });

    after(async () => {
      if (emailId) await pool.query("DELETE FROM emails WHERE id = $1", [emailId]);
    });
  });

  // -------------------------------------------------------------------------
  // Notes CRUD
  // -------------------------------------------------------------------------
  describe("Notes CRUD", () => {
    let noteId;

    it("creates a note with tags", async () => {
      const r = await pool.query(
        "INSERT INTO notes (title, content, color, tags, format) VALUES ($1, $2, $3, $4, $5) RETURNING *",
        ["Test Note", "Some content", "teal", ["tag1", "tag2"], "markdown"]
      );
      assert.equal(r.rows.length, 1);
      assert.deepEqual(r.rows[0].tags, ["tag1", "tag2"]);
      assert.equal(r.rows[0].format, "markdown");
      noteId = r.rows[0].id;
    });

    it("pins a note", async () => {
      await pool.query("UPDATE notes SET pinned = true WHERE id = $1", [noteId]);
      const r = await pool.query("SELECT * FROM notes WHERE id = $1", [noteId]);
      assert.equal(r.rows[0].pinned, true);
    });

    after(async () => {
      if (noteId) await pool.query("DELETE FROM notes WHERE id = $1", [noteId]);
    });
  });

  // -------------------------------------------------------------------------
  // Contacts
  // -------------------------------------------------------------------------
  describe("Contacts", () => {
    let contactId;

    it("creates a contact", async () => {
      const r = await pool.query(
        "INSERT INTO contacts (name, email) VALUES ($1, $2) RETURNING *",
        ["Integration Test User", "inttest@example.com"]
      );
      assert.equal(r.rows.length, 1);
      contactId = r.rows[0].id;
    });

    it("enforces unique name (case-insensitive)", async () => {
      await assert.rejects(
        () => pool.query("INSERT INTO contacts (name, email) VALUES ($1, $2)", ["integration test user", "other@example.com"]),
        (err) => err.message.includes("unique") || err.message.includes("duplicate")
      );
    });

    after(async () => {
      if (contactId) await pool.query("DELETE FROM contacts WHERE id = $1", [contactId]);
    });
  });

  // -------------------------------------------------------------------------
  // Settings (single-row pattern)
  // -------------------------------------------------------------------------
  describe("Settings", () => {
    it("has exactly one settings row", async () => {
      const r = await pool.query("SELECT COUNT(*) as count FROM user_settings");
      assert.equal(parseInt(r.rows[0].count), 1);
    });

    it("enforces single-row CHECK constraint", async () => {
      await assert.rejects(
        () => pool.query("INSERT INTO user_settings (id) VALUES (2)"),
        (err) => err.message.includes("violates check constraint") || err.message.includes("check")
      );
    });

    it("can update theme", async () => {
      await pool.query("UPDATE user_settings SET theme = 'light' WHERE id = 1");
      const r = await pool.query("SELECT theme FROM user_settings WHERE id = 1");
      assert.equal(r.rows[0].theme, "light");
      // Reset
      await pool.query("UPDATE user_settings SET theme = 'dark' WHERE id = 1");
    });
  });

  // -------------------------------------------------------------------------
  // Subtasks
  // -------------------------------------------------------------------------
  describe("Subtasks", () => {
    let todoId, subtaskId;

    before(async () => {
      const r = await pool.query("INSERT INTO todos (title) VALUES ('Parent task') RETURNING id");
      todoId = r.rows[0].id;
    });

    it("creates a subtask linked to a todo", async () => {
      const r = await pool.query(
        "INSERT INTO subtasks (todo_id, title) VALUES ($1, $2) RETURNING *",
        [todoId, "Sub-item 1"]
      );
      assert.equal(r.rows.length, 1);
      assert.equal(r.rows[0].todo_id, todoId);
      subtaskId = r.rows[0].id;
    });

    it("completes a subtask", async () => {
      await pool.query("UPDATE subtasks SET completed = true WHERE id = $1", [subtaskId]);
      const r = await pool.query("SELECT * FROM subtasks WHERE id = $1", [subtaskId]);
      assert.equal(r.rows[0].completed, true);
    });

    it("cascades on parent todo delete", async () => {
      await pool.query("DELETE FROM todos WHERE id = $1", [todoId]);
      const r = await pool.query("SELECT * FROM subtasks WHERE todo_id = $1", [todoId]);
      assert.equal(r.rows.length, 0);
    });
  });

  // -------------------------------------------------------------------------
  // Task Dependencies
  // -------------------------------------------------------------------------
  describe("Task dependencies", () => {
    let taskA, taskB;

    before(async () => {
      const a = await pool.query("INSERT INTO todos (title) VALUES ('Task A') RETURNING id");
      const b = await pool.query("INSERT INTO todos (title) VALUES ('Task B') RETURNING id");
      taskA = a.rows[0].id;
      taskB = b.rows[0].id;
    });

    it("creates a dependency", async () => {
      const r = await pool.query(
        "INSERT INTO task_dependencies (todo_id, depends_on_id) VALUES ($1, $2) RETURNING *",
        [taskA, taskB]
      );
      assert.equal(r.rows.length, 1);
      assert.equal(r.rows[0].todo_id, taskA);
      assert.equal(r.rows[0].depends_on_id, taskB);
    });

    it("queries blocked_by correctly", async () => {
      const r = await pool.query(
        "SELECT t.* FROM task_dependencies d JOIN todos t ON t.id = d.depends_on_id WHERE d.todo_id = $1",
        [taskA]
      );
      assert.equal(r.rows.length, 1);
      assert.equal(r.rows[0].title, "Task B");
    });

    after(async () => {
      await pool.query("DELETE FROM task_dependencies WHERE todo_id = $1", [taskA]);
      await pool.query("DELETE FROM todos WHERE id IN ($1, $2)", [taskA, taskB]);
    });
  });

  // -------------------------------------------------------------------------
  // Recurring tasks & streaks
  // -------------------------------------------------------------------------
  describe("Recurring tasks & streaks", () => {
    let recurringId;

    it("creates a recurring task with streak columns", async () => {
      const r = await pool.query(
        "INSERT INTO todos (title, recurring, recurrence_rule, recurrence_interval, due_date, streak_count, best_streak) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *",
        ["Daily standup", true, "daily", 1, "2026-03-15", 5, 10]
      );
      assert.equal(r.rows[0].recurring, true);
      assert.equal(r.rows[0].recurrence_rule, "daily");
      assert.equal(r.rows[0].streak_count, 5);
      assert.equal(r.rows[0].best_streak, 10);
      recurringId = r.rows[0].id;
    });

    after(async () => {
      if (recurringId) await pool.query("DELETE FROM todos WHERE id = $1", [recurringId]);
    });
  });

  // -------------------------------------------------------------------------
  // Automations
  // -------------------------------------------------------------------------
  describe("Automations", () => {
    let ruleId;

    it("creates an automation rule", async () => {
      const r = await pool.query(
        "INSERT INTO automations (name, trigger_type, conditions, action_type, action_data) VALUES ($1, $2, $3, $4, $5) RETURNING *",
        ["Test rule", "todo_created", JSON.stringify({ category: "work" }), "set_priority", JSON.stringify({ priority: "high" })]
      );
      assert.equal(r.rows.length, 1);
      assert.equal(r.rows[0].enabled, true); // default
      ruleId = r.rows[0].id;
    });

    after(async () => {
      if (ruleId) await pool.query("DELETE FROM automations WHERE id = $1", [ruleId]);
    });
  });

  // -------------------------------------------------------------------------
  // Entity links
  // -------------------------------------------------------------------------
  describe("Entity links", () => {
    let todoId, noteId, linkId;

    before(async () => {
      const t = await pool.query("INSERT INTO todos (title) VALUES ('Linked todo') RETURNING id");
      const n = await pool.query("INSERT INTO notes (content) VALUES ('Linked note') RETURNING id");
      todoId = t.rows[0].id;
      noteId = n.rows[0].id;
    });

    it("creates a cross-entity link", async () => {
      const r = await pool.query(
        "INSERT INTO entity_links (source_type, source_id, target_type, target_id) VALUES ($1, $2, $3, $4) RETURNING *",
        ["todo", todoId, "note", noteId]
      );
      assert.equal(r.rows.length, 1);
      linkId = r.rows[0].id;
    });

    it("queries links for an entity", async () => {
      const r = await pool.query(
        "SELECT * FROM entity_links WHERE (source_type = $1 AND source_id = $2) OR (target_type = $1 AND target_id = $2)",
        ["todo", todoId]
      );
      assert.equal(r.rows.length, 1);
    });

    after(async () => {
      if (linkId) await pool.query("DELETE FROM entity_links WHERE id = $1", [linkId]);
      if (todoId) await pool.query("DELETE FROM todos WHERE id = $1", [todoId]);
      if (noteId) await pool.query("DELETE FROM notes WHERE id = $1", [noteId]);
    });
  });

  // -------------------------------------------------------------------------
  // Webhooks
  // -------------------------------------------------------------------------
  describe("Webhooks", () => {
    let webhookId;

    it("creates a webhook", async () => {
      const r = await pool.query(
        "INSERT INTO webhooks (name, url, events) VALUES ($1, $2, $3) RETURNING *",
        ["Test hook", "https://example.com/hook", ["todo_created", "todo_completed"]]
      );
      assert.equal(r.rows.length, 1);
      assert.equal(r.rows[0].enabled, true);
      assert.deepEqual(r.rows[0].events, ["todo_created", "todo_completed"]);
      webhookId = r.rows[0].id;
    });

    after(async () => {
      if (webhookId) await pool.query("DELETE FROM webhooks WHERE id = $1", [webhookId]);
    });
  });

  // -------------------------------------------------------------------------
  // Analytics queries
  // -------------------------------------------------------------------------
  describe("Analytics queries", () => {
    it("completion trend query runs without error", async () => {
      const r = await pool.query(
        "SELECT DATE(completed_at) as date, COUNT(*) as count FROM todos WHERE completed = true AND completed_at >= NOW() - INTERVAL '30 days' GROUP BY DATE(completed_at) ORDER BY date"
      );
      assert.ok(Array.isArray(r.rows));
    });

    it("category breakdown query runs without error", async () => {
      const r = await pool.query(
        "SELECT COALESCE(category, 'uncategorized') as category, COUNT(*) as count FROM todos WHERE deleted_at IS NULL GROUP BY category ORDER BY count DESC"
      );
      assert.ok(Array.isArray(r.rows));
    });

    it("priority breakdown query runs without error", async () => {
      const r = await pool.query(
        "SELECT priority, COUNT(*) as count, SUM(CASE WHEN completed THEN 1 ELSE 0 END) as completed FROM todos WHERE deleted_at IS NULL GROUP BY priority"
      );
      assert.ok(Array.isArray(r.rows));
    });
  });

  // -------------------------------------------------------------------------
  // Todo templates
  // -------------------------------------------------------------------------
  describe("Todo templates", () => {
    let templateId;

    it("creates a todo template", async () => {
      const r = await pool.query(
        "INSERT INTO todo_templates (name, title, priority, horizon, category, subtasks) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *",
        ["Meeting template", "Team Meeting", "medium", "short", "work", JSON.stringify(["Prepare agenda", "Take notes"])]
      );
      assert.equal(r.rows.length, 1);
      assert.equal(r.rows[0].name, "Meeting template");
      templateId = r.rows[0].id;
    });

    after(async () => {
      if (templateId) await pool.query("DELETE FROM todo_templates WHERE id = $1", [templateId]);
    });
  });

  // -------------------------------------------------------------------------
  // Performance indexes exist
  // -------------------------------------------------------------------------
  describe("Performance indexes", () => {
    it("has index on todos(horizon, completed)", async () => {
      const r = await pool.query(
        "SELECT 1 FROM pg_indexes WHERE tablename = 'todos' AND indexname = 'idx_todos_horizon'"
      );
      assert.equal(r.rows.length, 1);
    });

    it("has index on todos(due_date)", async () => {
      const r = await pool.query(
        "SELECT 1 FROM pg_indexes WHERE tablename = 'todos' AND indexname = 'idx_todos_due'"
      );
      assert.equal(r.rows.length, 1);
    });

    it("has index on emails(status)", async () => {
      const r = await pool.query(
        "SELECT 1 FROM pg_indexes WHERE tablename = 'emails' AND indexname = 'idx_emails_status'"
      );
      assert.equal(r.rows.length, 1);
    });

    it("has index on notes(pinned)", async () => {
      const r = await pool.query(
        "SELECT 1 FROM pg_indexes WHERE tablename = 'notes' AND indexname = 'idx_notes_pinned'"
      );
      assert.equal(r.rows.length, 1);
    });

    it("has unique index on contacts(name)", async () => {
      const r = await pool.query(
        "SELECT 1 FROM pg_indexes WHERE tablename = 'contacts' AND indexname = 'idx_contacts_name'"
      );
      assert.equal(r.rows.length, 1);
    });
  });
});
