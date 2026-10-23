// Real-Postgres contract tests for cycle-7 Batch 13 (test quality, Per-sistant
// side). Replaces apps/per-sistant/tests/integration.test.js (F136), which ran
// hand-written replica SQL against NEON_DATABASE_URL — the production database
// variable — and never ran in CI. Here the same schema guarantees are checked
// on a scratch database migrated by the app's own runMigrations, plus the real
// code paths that only had source-regex pins (F138/F139): the analytics route,
// scheduled-email at-most-once delivery (PS-2) under two concurrent runners,
// POST /api/rag/reindex → GET /api/rag/status, and migration serialization (F10).
const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const supertest = require("supertest");
const { SKIP, persistentDb, persistentApp } = require("./_setup");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

describe("Per-sistant Batch 13 on real Postgres", { skip: SKIP }, () => {
  let pool, app, server, sent;
  const q = (s, p) => pool.query(s, p);
  const violates = (code) => (err) => err.code === code;

  before(async () => {
    delete process.env.VOYAGE_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    pool = await persistentDb("batch13");
    app = persistentApp(pool);
    // PS-2: a stub transporter that is slow enough for two runners to overlap.
    process.env.SMTP_HOST = "smtp.invalid";
    sent = [];
    const nodemailer = require("nodemailer");
    nodemailer.createTransport = () => ({ sendMail: async (m) => { sent.push(m.to); await sleep(30); } });
    server = require("../../apps/per-sistant/server");
  });
  after(async () => { if (pool) await pool.end(); });

  describe("schema (ported from integration.test.js, F136)", () => {
    it("todos: CHECK constraints on priority and horizon", async () => {
      await assert.rejects(q("INSERT INTO todos (title, priority) VALUES ('x', 'critical')"), violates("23514"));
      await assert.rejects(q("INSERT INTO todos (title, horizon) VALUES ('x', 'infinite')"), violates("23514"));
    });

    it("todos: the updated_at trigger advances on update", async () => {
      const id = (await q("INSERT INTO todos (title) VALUES ('trigger') RETURNING id")).rows[0].id;
      await q("UPDATE todos SET updated_at = now() - interval '1 day' WHERE id = $1", [id]);
      const before = (await q("SELECT updated_at FROM todos WHERE id = $1", [id])).rows[0].updated_at;
      await q("UPDATE todos SET title = 'trigger 2' WHERE id = $1", [id]);
      const after = (await q("SELECT updated_at FROM todos WHERE id = $1", [id])).rows[0].updated_at;
      assert.ok(after > before, "updated_at moved forward");
    });

    it("emails: status CHECK", async () => {
      await assert.rejects(q("INSERT INTO emails (recipient_email, subject, body, status) VALUES ('a@b.com', 's', 'b', 'invalid')"), violates("23514"));
    });

    it("contacts: name is unique case-insensitively", async () => {
      await q("INSERT INTO contacts (name, email) VALUES ('Ada Lovelace', 'ada@example.com')");
      await assert.rejects(q("INSERT INTO contacts (name, email) VALUES ('ada lovelace', 'other@example.com')"), violates("23505"));
    });

    it("user_settings: single row (id = 1 only)", async () => {
      await q("INSERT INTO user_settings (id) VALUES (1) ON CONFLICT DO NOTHING");
      await assert.rejects(q("INSERT INTO user_settings (id) VALUES (2)"), violates("23514"));
    });

    it("subtasks cascade with their todo", async () => {
      const id = (await q("INSERT INTO todos (title) VALUES ('parent') RETURNING id")).rows[0].id;
      await q("INSERT INTO subtasks (todo_id, title) VALUES ($1, 'child')", [id]);
      await q("DELETE FROM todos WHERE id = $1", [id]);
      assert.equal((await q("SELECT count(*)::int AS n FROM subtasks WHERE todo_id = $1", [id])).rows[0].n, 0);
    });

    it("webhooks/automations defaults; notes keep tag arrays", async () => {
      const w = (await q("INSERT INTO webhooks (name, url, events) VALUES ('h', 'https://example.com/h', $1) RETURNING enabled, events", [["todo_created"]])).rows[0];
      assert.equal(w.enabled, true);
      assert.deepEqual(w.events, ["todo_created"]);
      const n = (await q("INSERT INTO notes (title, content, tags) VALUES ('n', 'c', $1) RETURNING tags, pinned", [["a", "b"]])).rows[0];
      assert.deepEqual(n.tags, ["a", "b"]);
      assert.equal(n.pinned, false);
    });

    it("the performance indexes exist", async () => {
      const names = (await q("SELECT indexname FROM pg_indexes WHERE schemaname = 'public'")).rows.map((r) => r.indexname);
      for (const ix of ["idx_todos_horizon", "idx_todos_due", "idx_emails_status", "idx_notes_pinned", "idx_contacts_name"]) {
        assert.ok(names.includes(ix), ix + " missing");
      }
    });
  });

  it("F139: GET /api/analytics runs its real queries and counts this week's work", async () => {
    await q("DELETE FROM todos");
    await q(`INSERT INTO todos (title, priority, category, completed, completed_at) VALUES
      ('done 1', 'high', 'work', true, now()),
      ('done 2', 'low', 'work', true, now()),
      ('open', 'urgent', 'home', false, NULL)`);
    const r = await supertest(app).get("/api/analytics?period=week").expect(200);
    assert.equal(r.body.total_created, 3);
    assert.equal(r.body.total_completed, 2);
    assert.equal(r.body.completion_rate, 67);
    assert.deepEqual(r.body.priority_breakdown.map((p) => p.priority), ["urgent"]);
    const work = r.body.category_breakdown.find((c) => c.category === "work");
    assert.equal(Number(work.completed), 2);
  });

  it("F138 / PS-2: two concurrent scheduler runs deliver each due email exactly once", async () => {
    await q("DELETE FROM emails");
    for (let i = 0; i < 6; i++) {
      await q("INSERT INTO emails (recipient_email, subject, body, status, scheduled_at) VALUES ($1, 's', 'b', 'scheduled', now() - interval '1 minute')", [`p${i}@example.com`]);
    }
    await q("INSERT INTO emails (recipient_email, subject, body, status, scheduled_at) VALUES ('later@example.com', 's', 'b', 'scheduled', now() + interval '1 day')");
    sent.length = 0;
    await Promise.all([server.processScheduledEmails(), server.processScheduledEmails()]);
    assert.equal(sent.length, 6, "six sends, no duplicates: " + sent.join(","));
    assert.equal(new Set(sent).size, 6);
    const st = (await q("SELECT status, count(*)::int AS n FROM emails GROUP BY status ORDER BY status")).rows;
    assert.deepEqual(st, [{ status: "scheduled", n: 1 }, { status: "sent", n: 6 }]);
  });

  it("F139: POST /api/rag/reindex runs in the background and GET /api/rag/status reports the outcome", async () => {
    await supertest(app).patch("/api/settings").send({ vault_enabled: true, vault_repo: "me/vault", vault_branch: "main" }).expect(200);
    process.env.VAULT_GITHUB_TOKEN = "contract-read-token";
    const b64 = (s) => Buffer.from(s, "utf8").toString("base64");
    const files = { "notes/r.md": "# Reindexed\nhello reindex\n" };
    const realFetch = globalThis.fetch;
    globalThis.fetch = async (url) => {
      const p = new URL(url).pathname;
      const json = (body, status = 200) => ({ ok: status < 400, status, json: async () => body, text: async () => JSON.stringify(body) });
      if (p.endsWith("/branches/main")) return json({ commit: { sha: "r1" } });
      if (p.includes("/git/trees/")) return json({ truncated: false, tree: Object.keys(files).map((path) => ({ path, type: "blob" })) });
      const m = p.match(/\/contents\/(.+)$/);
      if (m && files[decodeURIComponent(m[1])]) return json({ encoding: "base64", content: b64(files[decodeURIComponent(m[1])]) });
      return json({ message: "Not Found" }, 404);
    };
    try {
      await supertest(app).post("/api/rag/reindex").expect(202);
      let status;
      for (let i = 0; i < 100; i++) {
        status = (await supertest(app).get("/api/rag/status").expect(200)).body.reindex;
        if (!status.running) break;
        await sleep(50);
      }
      assert.equal(status.running, false);
      assert.equal(status.ok, true, JSON.stringify(status));
      assert.equal((await q("SELECT count(*)::int AS n FROM documents WHERE source_ref = 'notes/r.md' AND deleted_at IS NULL")).rows[0].n, 1);
      assert.equal((await q("SELECT vault_last_sha FROM user_settings")).rows[0].vault_last_sha, "r1");
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it("F10: concurrent migration runs serialize on the advisory lock and both succeed", async () => {
    const db = require("../../apps/per-sistant/db");
    await Promise.all([db.runMigrations(), db.runMigrations()]);
    assert.equal((await q("SELECT count(*)::int AS n FROM todos WHERE title = 'open'")).rows[0].n, 1, "data survives");
  });
});
