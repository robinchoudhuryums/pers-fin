// ============================================================================
// Audit regression tests — guards against re-introducing fixed findings
// ============================================================================
// These tests pin specific behaviors enforced by the C1-C4 + N1-N4 fix cycle:
//   C3  Login reads session_timeout_minutes from user_settings
//   C4  SSO uses SSO_SECRET (not SESSION_SECRET + AUTH_SECRET)
//   N1  Templates do not embed ?api_key= in any anchor href
//   N2  foot.ejs does not inject window.PERFIN_API_KEY
//   N4  isExcludedMerchant uses word boundaries (covered in detect-subscriptions.test.js)
// ============================================================================

if (!process.env.NEON_DATABASE_URL) process.env.NEON_DATABASE_URL = "postgres://mock:mock@localhost/mock";

const { describe, it, before } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const express = require("express");
const supertest = require("supertest");

// Minimal in-memory session middleware for tests — express-session lives in
// teller/node_modules, not at the repo root, so we stub the surface area
// (req.session getter, regenerate/save callbacks aren't needed by these routes).
function memorySessionMiddleware() {
  const store = new Map();
  return (req, res, next) => {
    let sid = (req.headers.cookie || "").match(/sid=([^;]+)/)?.[1];
    if (!sid || !store.has(sid)) {
      sid = crypto.randomBytes(8).toString("hex");
      store.set(sid, {});
      res.setHeader("Set-Cookie", "sid=" + sid + "; Path=/; HttpOnly");
    }
    req.session = store.get(sid);
    req.session.destroy = (cb) => { store.delete(sid); cb && cb(); };
    next();
  };
}

// ---------------------------------------------------------------------------
// N1 + N2 — template smoke tests
// ---------------------------------------------------------------------------
describe("N1/N2 — API key not leaked into views", () => {
  const viewsDir = path.join(__dirname, "..", "teller", "views");

  function readAllEjs(dir) {
    const files = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) files.push(...readAllEjs(full));
      else if (entry.name.endsWith(".ejs")) files.push(full);
    }
    return files;
  }

  const ejsFiles = readAllEjs(viewsDir);

  it("no template embeds ?api_key= in an href or fetch URL", () => {
    const offenders = [];
    for (const f of ejsFiles) {
      const text = fs.readFileSync(f, "utf-8");
      if (/api_key=/.test(text)) offenders.push(path.relative(viewsDir, f));
    }
    assert.deepEqual(offenders, [], `Templates still embed api_key= in URLs: ${offenders.join(", ")}`);
  });

  it("foot.ejs does not inject window.PERFIN_API_KEY", () => {
    const foot = fs.readFileSync(path.join(viewsDir, "partials", "foot.ejs"), "utf-8");
    assert.ok(!/window\.PERFIN_API_KEY/.test(foot),
      "foot.ejs must not write the API key into a JS global");
  });
});

// ---------------------------------------------------------------------------
// C4 — SSO uses SSO_SECRET (HMAC verifies with the documented env var)
// ---------------------------------------------------------------------------
// Source-level smoke test: persistent.js depends on express-rate-limit,
// which is only installed under teller/node_modules. Rather than couple
// this test to that install layout, we pin the SSO behavior at the source.
describe("C4 — persistent.js SSO uses SSO_SECRET", () => {
  const src = fs.readFileSync(
    path.join(__dirname, "..", "teller", "routes", "persistent.js"),
    "utf-8"
  );

  it("references process.env.SSO_SECRET", () => {
    assert.ok(/process\.env\.SSO_SECRET/.test(src),
      "persistent.js must read process.env.SSO_SECRET");
  });

  it("does NOT derive its HMAC key from SESSION_SECRET + AUTH_SECRET", () => {
    assert.ok(!/SESSION_SECRET\s*\+\s*AUTH_SECRET/.test(src),
      "legacy secret concatenation must not return");
  });

  it("guards SSO routes with a missing-SSO_SECRET check", () => {
    // At least one explicit guard should exist (returns 500 when SSO_SECRET is unset).
    assert.ok(/!SSO_SECRET/.test(src) || /SSO_SECRET\s*===?\s*null/.test(src),
      "persistent.js must guard against missing SSO_SECRET");
    // Both routes are still defined
    assert.ok(/\/api\/sso\/generate/.test(src), "missing /api/sso/generate route");
    assert.ok(/\/api\/sso\/validate/.test(src), "missing /api/sso/validate route");
  });
});

// ---------------------------------------------------------------------------
// C3 — Login applies the configured session_timeout_minutes
// ---------------------------------------------------------------------------
describe("C3 — login honors user_settings.session_timeout_minutes", () => {
  let app, originalPin;
  const FAKE_TIMEOUT = 47;

  before(() => {
    originalPin = process.env.SESSION_PIN;
    process.env.SESSION_PIN = "9876";

    // Mock pool: settings query returns FAKE_TIMEOUT
    const dbModule = require("../teller/services/database");
    dbModule.pool.query = async (sql) => {
      if (/session_timeout_minutes/i.test(sql)) {
        return { rows: [{ session_timeout_minutes: FAKE_TIMEOUT }] };
      }
      // Login.js GET /login also queries webauthn_credentials
      return { rows: [{ cnt: 0 }] };
    };
    dbModule.pool.connect = async () => ({ query: dbModule.pool.query, release: () => {} });

    const loginPath = require.resolve("../teller/pages/login");
    delete require.cache[loginPath];
    const loginFactory = require("../teller/pages/login");
    const router = loginFactory({
      AUTH_MODE: "pin",
      AUTH_SECRET: "9876",
      SESSION_PASSWORD: null,
      SESSION_PIN: "9876",
    });

    app = express();
    app.use(express.json());
    app.use(memorySessionMiddleware());
    app.use(router);
  });

  it("POST /api/login sets req.session.timeoutMinutes from settings, not the hardcoded 15", async () => {
    const agent = supertest.agent(app);
    await agent.post("/api/login").send({ password: "9876" }).expect(200);

    // Add a probe route that reports the session value
    app.get("/__probe", (req, res) => res.json({ timeout: req.session.timeoutMinutes }));
    const res = await agent.get("/__probe").expect(200);
    assert.equal(res.body.timeout, FAKE_TIMEOUT,
      `login should set timeoutMinutes from user_settings (got ${res.body.timeout}, expected ${FAKE_TIMEOUT})`);
  });

  process.on("exit", () => {
    if (originalPin === undefined) delete process.env.SESSION_PIN;
    else process.env.SESSION_PIN = originalPin;
  });
});
