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
