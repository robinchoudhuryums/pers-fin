// ============================================================================
// Per-sistant — regression tests for the Tier 1/Tier 2 broad-scan fixes
// ============================================================================
//   - SN-1  inbound webhook receiver: timestamp-expiry + signature replay
//           guard (behavioral, supertest + HMAC signing)
//   - PS-4  markdown link scheme validation (source-pinned)
//   - PS-5  attachment Content-Disposition sanitization (source-pinned)
//   - PS-7  email PATCH status validation (source-pinned)
//   - PS-11 recurring-task cron atomic claim (source-pinned)
//   - migration env-gate uses the pool's actual connection string (source-pinned)

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const express = require("express");
const supertest = require("supertest");

// ---------------------------------------------------------------------------
// SN-1 — inbound webhook replay/expiry guard (behavioral)
// ---------------------------------------------------------------------------
describe("SN-1 — Perfin webhook receiver rejects stale + replayed posts", () => {
  const SECRET = "test-webhook-secret-123";
  process.env.PERSISTENT_WEBHOOK_SECRET = SECRET;
  const perfinFactory = require("../routes/perfin");

  function makeApp() {
    const app = express();
    // Mirror server.js: capture the raw body so the receiver verifies the
    // signature against the exact bytes (not a re-stringify).
    app.use(express.json({ verify: (req, _res, buf) => { req.rawBody = buf; } }));
    const stubPool = { query: async () => ({ rows: [] }) };
    app.use(perfinFactory({ pool: stubPool, config: { PERFIN_URL: null } }));
    return app;
  }
  const sign = (s) => crypto.createHmac("sha256", SECRET).update(s).digest("hex");
  // Unique nonce per body so signatures don't collide across tests (the
  // seen-signature map is module-scoped and shared between makeApp() calls).
  const freshBody = (over = {}) => JSON.stringify({
    event: "test", data: { n: crypto.randomBytes(6).toString("hex") },
    timestamp: new Date().toISOString(), ...over,
  });

  it("accepts a fresh, correctly-signed webhook", async () => {
    const body = freshBody();
    await supertest(makeApp()).post("/api/perfin/webhook")
      .set("Content-Type", "application/json")
      .set("x-webhook-signature", sign(body))
      .send(body).expect(200);
  });

  it("rejects a stale timestamp (outside the replay window)", async () => {
    const body = freshBody({ timestamp: new Date(Date.now() - 10 * 60 * 1000).toISOString() });
    await supertest(makeApp()).post("/api/perfin/webhook")
      .set("Content-Type", "application/json")
      .set("x-webhook-signature", sign(body))
      .send(body).expect(401);
  });

  it("rejects a replayed (already-seen) signature", async () => {
    const body = freshBody();
    const sig = sign(body);
    await supertest(makeApp()).post("/api/perfin/webhook")
      .set("Content-Type", "application/json").set("x-webhook-signature", sig)
      .send(body).expect(200);
    // Same signed bytes again → replay.
    await supertest(makeApp()).post("/api/perfin/webhook")
      .set("Content-Type", "application/json").set("x-webhook-signature", sig)
      .send(body).expect(401);
  });

  it("still rejects a bad signature", async () => {
    const body = freshBody();
    await supertest(makeApp()).post("/api/perfin/webhook")
      .set("Content-Type", "application/json")
      .set("x-webhook-signature", "deadbeef")
      .send(body).expect(401);
  });
});

// ---------------------------------------------------------------------------
// Source-pinned (DB/inline-cron-bound — guard against reversion)
// ---------------------------------------------------------------------------
describe("PS-4 — markdown link scheme validation", () => {
  const src = fs.readFileSync(path.join(__dirname, "../views/js.js"), "utf8");
  it("renderMd validates the href scheme (http/https/mailto only)", () => {
    assert.match(src, /\^\(https\?:\|mailto:\)/);
  });
  it("neutralizes disallowed schemes to '#'", () => {
    assert.match(src, /\?u\b|:\s*'#'/);
  });
});

describe("PS-5 — attachment Content-Disposition sanitization", () => {
  const src = fs.readFileSync(path.join(__dirname, "../routes/attachments.js"), "utf8");
  it("strips control chars from the filename and emits RFC 5987 filename*", () => {
    assert.match(src, /\\u0000-\\u001f\\u007f/);
    assert.match(src, /filename\*=UTF-8/);
  });
});

describe("PS-7 — email PATCH validates status", () => {
  const src = fs.readFileSync(path.join(__dirname, "../routes/emails.js"), "utf8");
  it("rejects a status not in VALID_EMAIL_STATUSES on PATCH", () => {
    assert.match(src, /!VALID_EMAIL_STATUSES\.includes\(status\)/);
  });
});

describe("PS-11 — recurring-task cron atomic claim", () => {
  const src = fs.readFileSync(path.join(__dirname, "../server.js"), "utf8");
  it("claims the row with WHERE completed = false RETURNING before generating the next", () => {
    assert.match(src, /UPDATE todos SET completed = true[\s\S]*WHERE id = \$1 AND completed = false RETURNING id/);
  });
});

describe("migration env-gate uses the pool's connection string", () => {
  const src = fs.readFileSync(path.join(__dirname, "../server.js"), "utf8");
  it("gates runMigrations on PERSISTENT_DATABASE_URL || NEON_DATABASE_URL", () => {
    assert.match(src, /PERSISTENT_DATABASE_URL \|\| process\.env\.NEON_DATABASE_URL/);
  });
});

describe("PS-3 — /api/stats surfaces a failed-email count", () => {
  const src = fs.readFileSync(path.join(__dirname, "../routes/settings.js"), "utf8");
  it("the emails stats query counts status='failed'", () => {
    assert.match(src, /FILTER \(WHERE status = 'failed'\) as failed/);
  });
});

// ===========================================================================
// Per-sistant Backend audit — PB-1 (SSRF) + PB-2 (error leakage)
// ===========================================================================
describe("PB-1 — isValidWebhookUrl blocks metadata + loopback ranges", () => {
  const { isValidWebhookUrl } = require("../config");
  it("blocks the cloud metadata endpoint (169.254.169.254)", () => {
    assert.equal(isValidWebhookUrl("http://169.254.169.254/latest/meta-data/"), false);
    assert.equal(isValidWebhookUrl("http://169.254.1.1/"), false);
  });
  it("blocks the full loopback /8 (not just 127.0.0.1)", () => {
    assert.equal(isValidWebhookUrl("http://127.0.0.2/admin"), false);
  });
  it("still blocks RFC-1918 private ranges", () => {
    assert.equal(isValidWebhookUrl("http://10.0.0.5/"), false);
    assert.equal(isValidWebhookUrl("http://192.168.1.1/"), false);
    assert.equal(isValidWebhookUrl("http://172.16.0.1/"), false);
  });
  it("allows a legitimate public https URL", () => {
    assert.equal(isValidWebhookUrl("https://example.com/hook"), true);
  });
});

describe("PB-2 — serverError returns a generic message, never raw err.message", () => {
  const { serverError } = require("../errors");
  it("responds 500 with a generic message and does not echo err.message", () => {
    let code = null, body = null;
    const res = { status(c) { code = c; return this; }, json(b) { body = b; } };
    serverError(res, new Error("relation \"todos\" does not exist"));
    assert.equal(code, 500);
    assert.equal(body.error, "An internal error occurred.");
    assert.ok(!/relation|todos/.test(JSON.stringify(body)), "must not leak DB error text");
  });
});

// ===========================================================================
// PB-7 — coverage for previously-untested load-bearing paths
// ===========================================================================
if (!process.env.PERSISTENT_DATABASE_URL) process.env.PERSISTENT_DATABASE_URL = "postgres://mock:mock@localhost/mock";

describe("PB-7 — advanceRecurrence (recurrence date math)", () => {
  const { advanceRecurrence } = require("../helpers");
  const iso = (d) => d.toISOString().split("T")[0];
  it("daily / custom_days advance by interval days", () => {
    assert.equal(iso(advanceRecurrence(new Date("2026-01-01"), "daily", 1)), "2026-01-02");
    assert.equal(iso(advanceRecurrence(new Date("2026-01-01"), "custom_days", 3)), "2026-01-04");
  });
  it("weekly advances 7 days * interval", () => {
    assert.equal(iso(advanceRecurrence(new Date("2026-01-01"), "weekly", 1)), "2026-01-08");
    assert.equal(iso(advanceRecurrence(new Date("2026-01-01"), "custom_weeks", 2)), "2026-01-15");
  });
  it("monthly / yearly advance by calendar unit", () => {
    assert.equal(iso(advanceRecurrence(new Date("2026-01-15"), "monthly", 1)), "2026-02-15");
    assert.equal(iso(advanceRecurrence(new Date("2026-01-01"), "yearly", 1)), "2027-01-01");
  });
  it("weekdays skips weekends", () => {
    // 2026-01-02 is a Friday; +1 weekday => Monday 2026-01-05
    assert.equal(iso(advanceRecurrence(new Date("2026-01-02"), "weekdays", 1)), "2026-01-05");
  });
});

describe("PB-7 — runAutomations (rule engine matching)", () => {
  const db = require("../db");
  const { runAutomations } = require("../helpers");
  const orig = db.pool.query;
  function setup(rule, captured) {
    db.pool.query = async (sql, params) => {
      if (/FROM automations/.test(sql)) return { rows: [rule] };
      captured.push({ sql, params });
      return { rows: [] };
    };
  }
  it("fires the action when conditions match", async () => {
    const captured = [];
    setup({ trigger_type: "todo_created", enabled: true, conditions: { category: "work" },
            action_type: "set_priority", action_data: { priority: "high" } }, captured);
    await runAutomations("todo_created", { id: 5, category: "work", priority: "low" }, "todo");
    db.pool.query = orig;
    const upd = captured.find(c => /UPDATE todos SET priority/.test(c.sql));
    assert.ok(upd, "matching rule must issue the priority UPDATE");
    assert.deepEqual(upd.params, ["high", 5]);
  });
  it("does NOT fire when a condition mismatches", async () => {
    const captured = [];
    setup({ trigger_type: "todo_created", enabled: true, conditions: { category: "work" },
            action_type: "set_priority", action_data: { priority: "high" } }, captured);
    await runAutomations("todo_created", { id: 5, category: "personal", priority: "low" }, "todo");
    db.pool.query = orig;
    assert.equal(captured.length, 0, "non-matching rule must issue no UPDATE");
  });
});

describe("PB-7 — complete-recurring streak + next instance", () => {
  const express = require("express");
  const supertest = require("supertest");
  it("increments the streak on an on-time completion and creates the next instance", async () => {
    const captured = {};
    const todoRow = {
      id: 5, title: "Stretch", description: null, priority: "medium", horizon: "short",
      category: "health", recurring: true, recurrence_rule: "daily", recurrence_interval: 1,
      completed: false, due_date: new Date(Date.now() + 7 * 86400000), // future => on time
      streak_count: 2, best_streak: 5, recurrence_parent_id: null,
    };
    const client = {
      query: async (sql, params) => {
        if (/BEGIN|COMMIT|ROLLBACK/.test(sql)) return {};
        if (/SELECT \* FROM todos WHERE id = \$1 FOR UPDATE/.test(sql)) return { rows: [todoRow] };
        if (/UPDATE todos SET completed/.test(sql)) { captured.update = params; return {}; }
        if (/INSERT INTO todos/.test(sql)) { captured.insert = params; return { rows: [{ id: 99 }] }; }
        return { rows: [] };
      },
      release() {},
    };
    const mockPool = { connect: async () => client };
    const app = express();
    app.use(express.json());
    app.use(require("../routes/todos")({ pool: mockPool, config: require("../config") }));
    const res = await supertest(app).post("/api/todos/5/complete-recurring").expect(200);
    assert.equal(res.body.streak, 3, "2 -> 3 on an on-time completion");
    assert.equal(res.body.best_streak, 5);
    assert.ok(captured.insert, "a next recurring instance must be created");
  });
});

// ===========================================================================
// PB-4 — manual email send: atomic claim guards against double-send
// ===========================================================================
describe("PB-4 — POST /api/emails/:id/send won't re-send an already-sent email", () => {
  it("returns 409 when the email is already sent (no re-send)", async () => {
    process.env.SMTP_HOST = process.env.SMTP_HOST || "smtp.test";
    const mockPool = {
      query: async (sql) => {
        if (/SELECT \* FROM emails/.test(sql)) {
          return { rows: [{ id: 7, status: "sent", recipient_email: "a@b.com", subject: "x", body: "y" }] };
        }
        return { rows: [] };
      },
    };
    const app = express();
    app.use(express.json());
    app.use(require("../routes/emails")({ pool: mockPool, config: require("../config"), helpers: {} }));
    await supertest(app).post("/api/emails/7/send").expect(409);
  });

  it("source: claims the row with status <> 'sent' RETURNING before sending", () => {
    const src = fs.readFileSync(path.join(__dirname, "../routes/emails.js"), "utf8");
    assert.match(src, /UPDATE emails SET status = 'sent'[\s\S]*status <> 'sent' RETURNING id/);
  });
});

// ===========================================================================
// Migration idempotency — CREATE TRIGGER must be guarded (production-down bug)
// ===========================================================================
// PS-1 made migrations run in ONE transaction with fatal-on-error. A bare
// `CREATE TRIGGER` (no IF NOT EXISTS) therefore throws "already exists" on
// every deploy after the first, rolls back the whole migration, and crashes
// the shell on boot. Every CREATE TRIGGER must be preceded by a matching
// DROP TRIGGER IF EXISTS so re-runs are no-ops.
describe("Migrations: every CREATE TRIGGER is idempotent (DROP IF EXISTS guard)", () => {
  const dbDir = path.join(__dirname, "../db");
  const files = fs.readdirSync(dbDir).filter((f) => f.endsWith(".sql"));

  it("no SQL file contains a CREATE TRIGGER without a preceding DROP TRIGGER IF EXISTS", () => {
    for (const f of files) {
      // Strip line comments so prose like "-- CREATE TRIGGER is not idempotent"
      // doesn't register as an actual statement.
      const sql = fs
        .readFileSync(path.join(dbDir, f), "utf8")
        .replace(/--[^\n]*/g, "");
      const triggerRe = /CREATE TRIGGER\s+(\w+)/g;
      let m;
      while ((m = triggerRe.exec(sql)) !== null) {
        const name = m[1];
        const guard = new RegExp(`DROP TRIGGER IF EXISTS\\s+${name}\\b`);
        assert.ok(
          guard.test(sql),
          `${f}: CREATE TRIGGER ${name} is missing a "DROP TRIGGER IF EXISTS ${name}" guard — ` +
            `it will throw "already exists" on the second migration run and crash boot`
        );
      }
    }
  });
});
