// ============================================================================
// PWA Phase-0 findings: embedded WebAuthn registration + tunable AI budget cap
// ============================================================================
//   - Biometric registration under the unified shell: the endpoints checked
//     Perfin's OWN session (never written when the shell PIN gate is the
//     authenticator), so "Register this device" always 401'd for shell users.
//   - Monthly AI budget cap: now user-tunable via
//     user_settings.ai_monthly_budget_cents through one shared resolver
//     (getAiBudgetCents) with env-var fallback (INV-14: one cap, one reader).
// ============================================================================

const { describe, it, before, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

if (!process.env.NEON_DATABASE_URL) process.env.NEON_DATABASE_URL = "postgres://mock:mock@localhost/mock";
if (!process.env.TOKEN_ENCRYPTION_PASSPHRASE) process.env.TOKEN_ENCRYPTION_PASSPHRASE = "test-passphrase";

const ROOT = path.join(__dirname, "..");

// ---------------------------------------------------------------------------
// Embedded-mode WebAuthn registration (INV-25)
// ---------------------------------------------------------------------------
describe("WebAuthn registration honors embedded mode", () => {
  it("both register endpoints bail past the session check when embedded", () => {
    const src = fs.readFileSync(path.join(ROOT, "teller", "pages", "login.js"), "utf8");
    const guards = src.match(/!req\.app\.get\("embedded"\) && \(!req\.session \|\| !req\.session\.authenticated\)/g) || [];
    assert.equal(guards.length, 2,
      "register-options AND register must accept shell-authenticated (embedded) requests");
    // The standalone path must still 401 unauthenticated requests.
    assert.match(src, /Must be logged in to register biometric/);
  });
});

// ---------------------------------------------------------------------------
// WebAuthn transports — platform-authenticator hint (QR-code/USB-only fix)
// ---------------------------------------------------------------------------
// Without transports in allowCredentials, browsers can't tell the stored
// credential is a platform (FaceID/TouchID) authenticator and offer only the
// cross-device options (QR code / USB security key) on the login screen.
describe("WebAuthn transports flow to allowCredentials", () => {
  const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), "utf8");

  it("migration adds the transports column idempotently", () => {
    const src = read("teller", "services", "database.js");
    assert.match(src, /ALTER TABLE webauthn_credentials\s+ADD COLUMN IF NOT EXISTS transports TEXT\[\]/);
  });

  it("registration persists the authenticator's transports", () => {
    const src = read("teller", "pages", "login.js");
    assert.match(src, /INSERT INTO webauthn_credentials \(credential_id, public_key, counter, device_name, transports\)/);
    assert.match(src, /credential\.transports/);
  });

  it("both auth-options endpoints advertise internal-only transports (suppresses the QR path)", () => {
    // 'hybrid' is the cross-device transport — advertising it is what made
    // browsers offer the "use a phone" QR option instead of the local
    // Touch/Face ID. Registration pins authenticatorAttachment:'platform', so
    // credentials are same-device and internal-only is correct AND it sends the
    // browser straight to the local biometric (QR-only fix follow-up).
    for (const file of [["teller", "pages", "login.js"], ["shell", "middleware", "webauthn.js"]]) {
      const src = read(...file);
      assert.match(src, /transports: \["internal"\],/,
        file.join("/") + " must advertise internal-only transports at login");
      assert.ok(!/transports:.*\bhybrid\b/.test(src.replace(/\/\/[^\n]*/g, "")),
        file.join("/") + " must NOT advertise 'hybrid' in allowCredentials (it triggers the QR path)");
    }
  });
});

// ---------------------------------------------------------------------------
// getAiBudgetCents — Settings-tunable cap with env fallback
// ---------------------------------------------------------------------------
describe("getAiBudgetCents", () => {
  let dbModule, originalPoolQuery, insights, originalEnv;

  before(() => {
    dbModule = require("../teller/services/database");
    originalPoolQuery = dbModule.pool.query;
    insights = require("../teller/routes/insights");
    originalEnv = process.env.INSIGHTS_MONTHLY_BUDGET_CENTS;
  });

  afterEach(() => {
    dbModule.pool.query = originalPoolQuery;
    if (originalEnv === undefined) delete process.env.INSIGHTS_MONTHLY_BUDGET_CENTS;
    else process.env.INSIGHTS_MONTHLY_BUDGET_CENTS = originalEnv;
  });

  it("the user setting wins when set and positive", async () => {
    dbModule.pool.query = async () => ({ rows: [{ ai_monthly_budget_cents: 200 }] });
    process.env.INSIGHTS_MONTHLY_BUDGET_CENTS = "75";
    assert.equal(await insights.getAiBudgetCents(), 200);
  });

  it("falls back to the env var when the setting is null", async () => {
    dbModule.pool.query = async () => ({ rows: [{ ai_monthly_budget_cents: null }] });
    process.env.INSIGHTS_MONTHLY_BUDGET_CENTS = "75";
    assert.equal(await insights.getAiBudgetCents(), 75);
  });

  it("falls back to the $0.50 default when neither is set", async () => {
    dbModule.pool.query = async () => ({ rows: [{ ai_monthly_budget_cents: null }] });
    delete process.env.INSIGHTS_MONTHLY_BUDGET_CENTS;
    assert.equal(await insights.getAiBudgetCents(), 50);
  });

  it("ignores zero/negative DB values and fails open on a DB error", async () => {
    delete process.env.INSIGHTS_MONTHLY_BUDGET_CENTS;
    dbModule.pool.query = async () => ({ rows: [{ ai_monthly_budget_cents: 0 }] });
    assert.equal(await insights.getAiBudgetCents(), 50, "zero is not a valid cap");
    dbModule.pool.query = async () => { throw new Error("boom"); };
    assert.equal(await insights.getAiBudgetCents(), 50, "DB blip → default cap, not a crash");
  });

  it("is the ONLY cap reader — no handler re-reads the env var directly (INV-14)", () => {
    const ins = fs.readFileSync(path.join(ROOT, "teller", "routes", "insights.js"), "utf8");
    const cat = fs.readFileSync(path.join(ROOT, "teller", "routes", "categorize.js"), "utf8");
    // insights.js: exactly one env read, inside the helper's fallback.
    const insReads = ins.match(/parseInt\(process\.env\.INSIGHTS_MONTHLY_BUDGET_CENTS\)/g) || [];
    assert.equal(insReads.length, 1, "insights.js env read only inside getAiBudgetCents");
    assert.equal((cat.match(/parseInt\(process\.env\.INSIGHTS_MONTHLY_BUDGET_CENTS\)/g) || []).length, 0,
      "categorize.js must use the shared resolver");
    assert.match(cat, /getAiBudgetCents/);
    // All three AI spenders resolve the cap through the helper.
    assert.equal((ins.match(/await getAiBudgetCents\(\)/g) || []).length, 3,
      "status + generate + rebuild all use the resolver");
  });
});

// ---------------------------------------------------------------------------
// PATCH /api/settings — ai_monthly_budget_cents validation (behavioral)
// ---------------------------------------------------------------------------
describe("PATCH /api/settings ai_monthly_budget_cents", () => {
  const supertest = require("supertest");
  const express = require("express");
  let dbModule, originalPoolQuery, app;

  before(() => {
    dbModule = require("../teller/services/database");
    originalPoolQuery = dbModule.pool.query;
    app = express();
    app.use(express.json());
    app.use(require("../teller/routes/settings"));
  });

  afterEach(() => { dbModule.pool.query = originalPoolQuery; });

  function capturePool() {
    const calls = [];
    dbModule.pool.query = async (sql, params) => {
      calls.push({ sql, params });
      if (/UPDATE user_settings SET/i.test(sql)) return { rows: [{ id: 1 }] };
      return { rows: [] };
    };
    return calls;
  }

  it("accepts a valid cap in cents", async () => {
    const calls = capturePool();
    await supertest(app).patch("/api/settings").send({ ai_monthly_budget_cents: 150 }).expect(200);
    const upd = calls.find(c => /UPDATE user_settings SET/i.test(c.sql));
    assert.ok(upd && /ai_monthly_budget_cents = \$/.test(upd.sql));
    assert.ok(upd.params.includes(150));
  });

  it("null clears the override back to env/default", async () => {
    const calls = capturePool();
    await supertest(app).patch("/api/settings").send({ ai_monthly_budget_cents: null }).expect(200);
    const upd = calls.find(c => /UPDATE user_settings SET/i.test(c.sql));
    assert.ok(upd && /ai_monthly_budget_cents = NULL/.test(upd.sql));
  });

  it("rejects out-of-range and non-integer values", async () => {
    capturePool();
    await supertest(app).patch("/api/settings").send({ ai_monthly_budget_cents: 0 }).expect(400);
    await supertest(app).patch("/api/settings").send({ ai_monthly_budget_cents: -5 }).expect(400);
    await supertest(app).patch("/api/settings").send({ ai_monthly_budget_cents: 20000 }).expect(400);
    await supertest(app).patch("/api/settings").send({ ai_monthly_budget_cents: 1.5 }).expect(400);
  });

  // F11: invalid target_allocation_pct / shell_idle_timeout_minutes must 400
  // (consistent with the other bounded numeric settings) rather than silently
  // dropping the field and returning 200, which made the client believe a bad
  // value had saved.
  it("accepts a valid target_allocation_pct object", async () => {
    const calls = capturePool();
    await supertest(app).patch("/api/settings").send({ target_allocation_pct: { equity: 70, bond: 30 } }).expect(200);
    const upd = calls.find(c => /UPDATE user_settings SET/i.test(c.sql));
    assert.ok(upd && /target_allocation_pct = \$/.test(upd.sql));
  });

  it("rejects invalid target_allocation_pct (F11 — no longer a silent drop)", async () => {
    capturePool();
    await supertest(app).patch("/api/settings").send({ target_allocation_pct: { equity: 150 } }).expect(400);
    await supertest(app).patch("/api/settings").send({ target_allocation_pct: { equity: "abc" } }).expect(400);
    await supertest(app).patch("/api/settings").send({ target_allocation_pct: [1, 2] }).expect(400);
  });

  it("rejects out-of-bounds shell_idle_timeout_minutes (F11)", async () => {
    capturePool();
    await supertest(app).patch("/api/settings").send({ shell_idle_timeout_minutes: 2 }).expect(400);
    await supertest(app).patch("/api/settings").send({ shell_idle_timeout_minutes: 99999 }).expect(400);
    await supertest(app).patch("/api/settings").send({ shell_idle_timeout_minutes: "x" }).expect(400);
  });
});
