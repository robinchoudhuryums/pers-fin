// ============================================================================
// Broad-scan (Sept 2026) Batch 9 — platform hardening (shell + Perfin)
// ============================================================================
// PSC-4   Secure cookies follow req.secure; the shell never returns a stack trace
// PSC-11  a missing SHELL_SECRET fails at boot, and a login can't crash the process
// PSC-14  global PIN failure ceiling → lockout + one operator alert
// PSC-7   shell body limit 1mb (was 64kb, overriding Per-sistant's 1mb)
// PSC-9   return_to is carried through the login flow
// PSC-8   Perfin limiters: general skipped when embedded; tight skips GETs
// PSC-13  constraints aren't dropped + re-added on every boot
// PSC-6   reset-fresh classifies every table the migrations create
// PSC-15  shell deps declared; csv-import.yml permissions; settings 400s
// PB-15   (shell side) Perfin's signed webhook passes the cookie gate
// WD-16   standalone Perfin Sign Out posts /api/logout
// ============================================================================

const { describe, it, before, after, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const express = require("express");
const supertest = require("supertest");

if (!process.env.NEON_DATABASE_URL) process.env.NEON_DATABASE_URL = "postgres://mock:mock@localhost/mock";
if (!process.env.TOKEN_ENCRYPTION_PASSPHRASE) process.env.TOKEN_ENCRYPTION_PASSPHRASE = "test-passphrase";

const ROOT = path.join(__dirname, "..");
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), "utf8");

const PIN = "135790";
process.env.SHELL_PIN = PIN;
process.env.SHELL_SECRET = "batch9-test-secret";
delete process.env.NODE_ENV;

const auth = require("../shell/middleware/auth");

function shellApp() {
  const app = express();
  app.set("trust proxy", 1);
  app.set("view engine", "ejs");
  app.set("views", path.join(ROOT, "shell", "views"));
  app.use(require("cookie-parser")());
  app.use(express.json({ limit: "1mb" }));
  app.use(express.urlencoded({ extended: false, limit: "1mb" }));
  app.use((_req, res, next) => { res.locals.nonce = "test-nonce"; next(); });
  app.post("/login", auth.handleLogin);
  app.use(auth.requireAuth);
  app.get("/*", (req, res) => res.json({ ok: true, path: req.path }));
  app.post("/*", (req, res) => res.json({ ok: true, path: req.path }));
  app.use(require("../shell/middleware/error-handler"));
  return app;
}

// ---------------------------------------------------------------------------
describe("PSC-4 — Secure cookie + no stack traces", () => {
  afterEach(() => auth._resetPinFailures());

  it("the session cookie is Secure behind a TLS proxy even without NODE_ENV", async () => {
    const res = await supertest(shellApp()).post("/login").set("X-Forwarded-Proto", "https").type("form").send({ pin: PIN });
    assert.equal(res.status, 302);
    assert.match(String(res.headers["set-cookie"]), /shell_session=.*; Secure/i);
  });

  it("plain-HTTP local runs still get a usable (non-Secure) cookie", async () => {
    const res = await supertest(shellApp()).post("/login").type("form").send({ pin: PIN });
    assert.doesNotMatch(String(res.headers["set-cookie"]), /Secure/i);
    assert.equal(auth.cookieSecure({ secure: true }), true);
    assert.equal(auth.cookieSecure({ secure: false }), false);
  });

  it("malformed JSON posted pre-auth gets a 400 with no stack trace", async () => {
    const res = await supertest(shellApp()).post("/login").set("Content-Type", "application/json").send('{"pin": ');
    assert.equal(res.status, 400);
    assert.deepEqual(res.body, { error: "Malformed request body." });
    assert.doesNotMatch(res.text, /at .*\.js:\d+|node_modules|SyntaxError/);
  });

  it("the shell mounts the handler last; Perfin's session cookie follows req.secure; Docker/fly set NODE_ENV at runtime", () => {
    const idx = read("shell", "index.js");
    assert.ok(idx.lastIndexOf("app.use(errorHandler)") > idx.indexOf('app.use("/per-sistant", persistent.app)'));
    assert.match(read("teller", "server.js"), /secure: process\.env\.NODE_ENV === "production" \? true : "auto"/);
    assert.match(read("shell", "middleware", "webauthn.js"), /secure: process\.env\.NODE_ENV === "production" \|\| !!req\.secure/);
    const docker = read("Dockerfile");
    assert.ok(docker.indexOf("ENV NODE_ENV=production") > docker.indexOf("RUN npm install"), "set after the install");
    assert.match(read("fly.toml"), /NODE_ENV = "production"/);
  });
});

// ---------------------------------------------------------------------------
describe("PSC-11 — SHELL_SECRET", () => {
  it("start() refuses to boot without SHELL_SECRET, before the sub-apps start", () => {
    const idx = read("shell", "index.js");
    const start = idx.slice(idx.indexOf("async function start()"));
    const check = start.indexOf("if (!process.env.SHELL_SECRET)");
    assert.ok(check > 0 && check < start.indexOf("await perfin.start"));
    assert.match(start.slice(check, check + 300), /throw new Error/);
  });

  it("a correct PIN with the secret missing renders a 500 instead of an unhandled rejection", async () => {
    const saved = process.env.SHELL_SECRET;
    delete process.env.SHELL_SECRET;
    try {
      const res = await supertest(shellApp()).post("/login").type("form").send({ pin: PIN });
      assert.equal(res.status, 500);
      assert.match(res.text, /misconfigured/);
    } finally { process.env.SHELL_SECRET = saved; }
  });
});

// ---------------------------------------------------------------------------
describe("PSC-14 — global PIN failure ceiling", () => {
  afterEach(() => auth._resetPinFailures());

  it("locks PIN login (even the right PIN) after the ceiling and alerts once", async () => {
    const alerts = [];
    auth.init({ pool: null, onLockout: (info) => { alerts.push(info); } });
    const t0 = Date.now();
    for (let i = 0; i < auth.GLOBAL_FAIL_CEILING - 1; i++) auth._recordPinFailure(t0 + i);
    assert.equal(auth.pinLockedForMs(t0 + 100), 0, "below the ceiling");
    auth._recordPinFailure(t0 + 200);
    assert.ok(auth.pinLockedForMs() > 0, "locked at the ceiling");
    auth._recordPinFailure(); // more failures while locked don't re-alert
    await new Promise((r) => setImmediate(r));
    assert.equal(alerts.length, 1);
    const res = await supertest(shellApp()).post("/login").type("form").send({ pin: PIN });
    assert.equal(res.status, 429);
    assert.match(res.text, /locked/);
    assert.equal(res.headers["set-cookie"], undefined, "no session while locked");
  });

  it("failures older than the window don't count", () => {
    const t0 = Date.now() - 2 * 60 * 60 * 1000;
    for (let i = 0; i < auth.GLOBAL_FAIL_CEILING - 1; i++) auth._recordPinFailure(t0);
    auth._recordPinFailure();
    assert.equal(auth.pinLockedForMs(), 0);
  });

  it("the shell wires the alert to Perfin's notifications and warns on a short PIN", () => {
    const idx = read("shell", "index.js");
    assert.match(idx, /onLockout: async[\s\S]*?sendToAll\(\{[\s\S]*?tag: "pin-lockout"/);
    assert.match(idx, /SHELL_PIN\.length < 6/);
  });
});

// ---------------------------------------------------------------------------
describe("PSC-9 — return_to survives the login", () => {
  afterEach(() => auth._resetPinFailures());

  it("an expired GET page redirect carries the path", async () => {
    const res = await supertest(shellApp()).get("/perfin/budgets?month=2026-09").set("Accept", "text/html");
    assert.equal(res.status, 302);
    assert.equal(res.headers.location, "/login?return_to=" + encodeURIComponent("/perfin/budgets?month=2026-09"));
    const root = await supertest(shellApp()).get("/").set("Accept", "text/html");
    assert.equal(root.headers.location, "/login");
  });

  it("a successful PIN login lands on the carried target; unsafe targets fall back", async () => {
    const ok = await supertest(shellApp()).post("/login").type("form").send({ pin: PIN, return_to: "/perfin/housing" });
    assert.equal(ok.headers.location, "/perfin/housing");
    const evil = await supertest(shellApp()).post("/login").type("form").send({ pin: PIN, return_to: "//evil.com" });
    assert.equal(evil.headers.location, auth.DEFAULT_POST_LOGIN);
  });

  it("a wrong PIN re-renders the form keeping the (sanitized) target", async () => {
    const res = await supertest(shellApp()).post("/login").type("form").send({ pin: "000000", return_to: "/perfin/budgets" });
    assert.equal(res.status, 401);
    assert.match(res.text, /name="return_to" id="return-to" value="\/perfin\/budgets"/);
    assert.equal(auth.loginReturnTo("//evil.com"), "");
    assert.equal(auth.loginReturnTo("/per-sistant"), "");
  });

  it("GET /login renders the target and the biometric path honours it", () => {
    const idx = read("shell", "index.js");
    assert.match(idx, /const returnTo = auth\.loginReturnTo\(req\.query\.return_to\);[\s\S]*?res\.render\("login", \{ error: null, returnTo \}\)/);
    assert.match(read("shell", "views", "login.ejs"), /\(rtEl && rtEl\.value\) \|\| '\/per-sistant'/);
  });
});

// ---------------------------------------------------------------------------
describe("PSC-7 — shell body limit", () => {
  it("is 1mb for both parsers", () => {
    const idx = read("shell", "index.js");
    assert.match(idx, /express\.json\(\{ limit: "1mb"/);
    assert.match(idx, /express\.urlencoded\(\{ extended: false, limit: "1mb" \}\)/);
    assert.doesNotMatch(idx, /limit: "64kb"/);
  });

  it("a ~200KB note body is accepted; >1mb is a clean 413", async () => {
    const app = shellApp();
    const cookie = auth.makeSession(60000);
    const ok = await supertest(app).post("/per-sistant/api/notes").set("Cookie", "shell_session=" + cookie).send({ content: "é".repeat(100000) });
    assert.equal(ok.status, 200);
    const big = await supertest(app).post("/per-sistant/api/notes").set("Cookie", "shell_session=" + cookie).send({ content: "x".repeat(1100000) });
    assert.equal(big.status, 413);
    assert.deepEqual(big.body, { error: "Request body too large." });
  });
});

// ---------------------------------------------------------------------------
describe("PB-15 (shell) — the signed Perfin webhook passes the cookie gate", () => {
  it("POST is let through to the receiver; nothing else is", async () => {
    const app = shellApp();
    const post = await supertest(app).post("/per-sistant/api/perfin/webhook").send({ event: "test" });
    assert.equal(post.status, 200);
    const get = await supertest(app).get("/per-sistant/api/perfin/webhook").set("Accept", "application/json");
    assert.equal(get.status, 401);
    const other = await supertest(app).post("/per-sistant/api/perfin/webhookX").send({});
    assert.equal(other.status, 401);
  });
});

// ---------------------------------------------------------------------------
describe("PSC-8 — Perfin rate limiters", () => {
  it("general limiter skips embedded requests; tight limiter skips reads", () => {
    const src = read("teller", "server.js");
    const gen = src.slice(src.indexOf("const generalLimiter"), src.indexOf("const tightLimiter"));
    assert.match(gen, /skip: \(req\) => !!req\.app\.get\("embedded"\)/);
    const tight = src.slice(src.indexOf("const tightLimiter"), src.indexOf("const loginLimiter"));
    assert.match(tight, /skip: \(req\) => req\.method === "GET"/);
  });

  it("the skips behave: 10 status polls under a 5/min limiter all succeed, a 6th POST is throttled", async () => {
    const rateLimit = require(require.resolve("express-rate-limit", { paths: [path.join(ROOT, "teller")] }));
    const app = express();
    app.use("/api/sync", rateLimit({ windowMs: 60000, max: 5, skip: (req) => req.method === "GET" }));
    app.get("/api/sync/reconcile/status", (_q, r) => r.json({ running: true }));
    app.post("/api/sync", (_q, r) => r.json({ ok: true }));
    for (let i = 0; i < 10; i++) await supertest(app).get("/api/sync/reconcile/status").expect(200);
    for (let i = 0; i < 5; i++) await supertest(app).post("/api/sync").expect(200);
    await supertest(app).post("/api/sync").expect(429);
  });
});

// ---------------------------------------------------------------------------
describe("PSC-13 — guarded constraints", () => {
  it("chk_account_source / chk_personal_for are only (re)built when missing or outdated", () => {
    const db = read("teller", "services", "database.js");
    // Every DROP CONSTRAINT sits inside a DO block guarded by pg_constraint.
    const drops = [...db.matchAll(/DROP CONSTRAINT IF EXISTS (\w+)/g)];
    for (const m of drops) {
      const before = db.slice(Math.max(0, m.index - 600), m.index);
      assert.match(before, /IF NOT EXISTS \(\s*SELECT 1 FROM pg_constraint/, m[1] + " drop must be guarded");
    }
    assert.match(db, /conname = 'chk_account_source'[\s\S]*?pg_get_constraintdef\(oid\) LIKE '%is_manual%'/);
    assert.match(db, /conname = 'chk_personal_for' AND conrelid = 'transactions'::regclass/);
    assert.doesNotMatch(db, /client\.query\("ALTER TABLE \w+ ADD CONSTRAINT chk_(account_source|personal_for)/);
  });
});

// ---------------------------------------------------------------------------
describe("PSC-6 — reset-fresh covers the whole schema", () => {
  const { WIPE_TABLES, KEEP_TABLES, UNTOUCHED_TABLES } = require("../scripts/reset-fresh");
  const created = [...new Set([...read("teller", "services", "database.js")
    .matchAll(/CREATE TABLE IF NOT EXISTS (\w+)/gi)].map((m) => m[1].toLowerCase()))];

  it("every migrated table is wiped, kept or deliberately untouched", () => {
    const classified = new Set([...WIPE_TABLES, ...KEEP_TABLES, ...UNTOUCHED_TABLES]);
    const missing = created.filter((t) => !classified.has(t));
    assert.deepEqual(missing, [], "unclassified tables: " + missing.join(", "));
    assert.ok(created.length > 30);
  });

  it("the four previously-missed tables are wiped; the lists don't overlap", () => {
    for (const t of ["investment_flows", "payee_obligations", "payee_payments", "settlements"]) {
      assert.ok(WIPE_TABLES.includes(t), t);
    }
    const all = [...WIPE_TABLES, ...KEEP_TABLES, ...UNTOUCHED_TABLES];
    assert.equal(new Set(all).size, all.length);
    assert.ok(UNTOUCHED_TABLES.includes("schema_migrations"));
  });
});

// ---------------------------------------------------------------------------
describe("PSC-15 — packaging, workflow, settings validation", () => {
  it("the shell declares every module it requires", () => {
    const pkg = JSON.parse(read("shell", "package.json"));
    for (const dep of ["express-rate-limit", "@simplewebauthn/server", "helmet", "express", "cookie-parser", "ejs", "dotenv"]) {
      assert.ok(pkg.dependencies[dep], dep);
    }
    assert.doesNotMatch(read("teller", "pages", "login.js"), /plain PIN-only HTML/);
  });

  it("csv-import.yml can push and no longer archives raw bank CSVs in the tree", () => {
    const wf = read(".github", "workflows", "csv-import.yml");
    assert.match(wf, /permissions:\s*\n\s*contents: write/);
    assert.doesNotMatch(wf, /mkdir -p csv-uploads\/processed|mv "\$f"/);
    assert.match(wf, /git rm -q "\$f"/);
  });

  describe("PATCH /api/settings rejects bad bounded values with 400", () => {
    let dbModule, original, app;
    before(() => {
      dbModule = require("../teller/services/database");
      original = dbModule.pool.query;
      app = express();
      app.use(express.json());
      app.use(require("../teller/routes/settings"));
    });
    after(() => { dbModule.pool.query = original; });

    function capture() {
      const calls = [];
      dbModule.pool.query = async (sql, params) => { calls.push({ sql, params }); return { rows: [{ id: 1 }] }; };
      return calls;
    }

    const bad = [
      { keep_alive_start: 24 }, { keep_alive_start: "6abc" }, { keep_alive_start: null },
      { keep_alive_end: -1 }, { keep_alive_timezone: "Mars/Olympus" }, { keep_alive_timezone: "" },
      { auto_sync_interval_hours: 0 }, { auto_sync_interval_hours: 1.5 },
      { csv_reminder_days: null }, { csv_reminder_days: 91 }, { weekly_digest_day: 7 }, { weekly_digest_day: "mon" },
    ];
    for (const body of bad) {
      it("400 for " + JSON.stringify(body) + " even alongside a valid field", async () => {
        const calls = capture();
        const res = await supertest(app).patch("/api/settings").send({ theme: "dark", ...body });
        assert.equal(res.status, 400);
        assert.ok(!calls.some((c) => /UPDATE user_settings SET/i.test(c.sql)), "nothing written");
      });
    }

    it("valid values still save", async () => {
      const calls = capture();
      await supertest(app).patch("/api/settings").send({
        keep_alive_start: 0, keep_alive_end: "23", keep_alive_timezone: "America/Los_Angeles",
        auto_sync_interval_hours: 6, csv_reminder_days: "14", weekly_digest_day: 0,
      }).expect(200);
      const upd = calls.find((c) => /UPDATE user_settings SET/i.test(c.sql));
      assert.ok(upd);
      for (const v of [0, 23, "America/Los_Angeles", 6, 14]) assert.ok(upd.params.includes(v), String(v));
    });
  });
});

// ---------------------------------------------------------------------------
describe("WD-16 — Sign Out in both modes", () => {
  const ejs = read("teller", "views", "settings.ejs");
  const start = ejs.indexOf("async function logout()");
  let depth = 0, end = start;
  for (let i = ejs.indexOf("{", start); i < ejs.length; i++) {
    if (ejs[i] === "{") depth++;
    else if (ejs[i] === "}") { depth--; if (depth === 0) { end = i + 1; break; } }
  }
  const fnSrc = ejs.slice(start, end);

  async function run(basePath) {
    const seen = [];
    const win = { BASE_PATH: basePath, location: { href: "" } };
    // eslint-disable-next-line no-new-func
    const logout = new Function("window", "fetch", fnSrc + "\nreturn logout;")(win, async (url) => { seen.push(url); return {}; });
    await logout();
    return { url: seen[0], href: win.location.href };
  }

  it("embedded → root /logout (INV-60); standalone → /api/logout", async () => {
    assert.deepEqual(await run("/perfin"), { url: "/logout", href: "/login" });
    assert.deepEqual(await run(""), { url: "/api/logout", href: "/login" });
  });
});
