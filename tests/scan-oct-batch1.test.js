// ============================================================================
// Broad-scan (Oct 2026, cycle 7) Batch 1 — exposure & pre-auth safety
// ============================================================================
// F1    a multibyte PIN / calendar token can't crash the process (digest compare)
// F2    workflows never print response bodies; CSV uploads refused while public
// F6    standalone Perfin: a bare x-api-key header is no bypass without API_KEY;
//       standalone login digests the password (a number used to throw)
// F7    the PIN-lockout alert is deduped
// F82   persistent_url validated; no redirect-following; no ciphertext echoed
// F125  Mermaid pinned; Per-sistant CSP allows only that path (not the host)
// (F11 — Per-sistant CSRF — is pinned in apps/per-sistant/tests/api.test.js.)
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

const PIN = "246810";
process.env.SHELL_PIN = PIN;
process.env.SHELL_SECRET = "oct-batch1-test-secret";
delete process.env.NODE_ENV;

const auth = require("../shell/middleware/auth");

function shellApp() {
  const app = express();
  app.set("view engine", "ejs");
  app.set("views", path.join(ROOT, "shell", "views"));
  app.use(require("cookie-parser")());
  app.use(express.urlencoded({ extended: false }));
  app.use((_req, res, next) => { res.locals.nonce = "test-nonce"; next(); });
  app.post("/login", auth.handleLogin);
  return app;
}

// ---------------------------------------------------------------------------
describe("F1 — the PIN compare can't throw", () => {
  afterEach(() => auth._resetPinFailures());

  it("safeEqual is false (never throws) on a multibyte string of the right character length", () => {
    // "24681é" has PIN's 6 characters but 7 UTF-8 bytes — the old padded
    // timingSafeEqual threw ERR_CRYPTO_TIMING_SAFE_EQUAL_LENGTH here.
    assert.equal(auth.safeEqual("24681é", PIN), false);
    assert.equal(auth.safeEqual("", PIN), false);
    assert.equal(auth.safeEqual(PIN, PIN), true);
    assert.equal(auth.safeEqual("é", "é"), true);
  });

  it("POST /login with a multibyte PIN answers 401 instead of rejecting the handler", async () => {
    const rejections = [];
    const onRej = (r) => rejections.push(r);
    process.on("unhandledRejection", onRej);
    try {
      // Timeout: before the fix the rejected handler never answered, so a
      // regression must fail fast rather than hang the suite.
      const res = await supertest(shellApp()).post("/login").type("form").send({ pin: "24681é" }).timeout(5000);
      assert.equal(res.status, 401);
      await new Promise(r => setImmediate(r));
      assert.equal(rejections.length, 0);
    } finally {
      process.off("unhandledRejection", onRej);
    }
  });

  it("the right PIN still logs in", async () => {
    const res = await supertest(shellApp()).post("/login").type("form").send({ pin: PIN });
    assert.equal(res.status, 302);
    assert.match(String(res.headers["set-cookie"]), /shell_session=/);
  });

  it("/calendar.ics uses the digest compare and the shell logs unhandled rejections", () => {
    const idx = read("shell", "index.js");
    const ics = idx.slice(idx.indexOf('app.get("/calendar.ics"'), idx.indexOf('app.get("/login"'));
    assert.match(ics, /auth\.safeEqual\(/);
    assert.doesNotMatch(ics, /padEnd/);
    assert.match(idx, /process\.on\("unhandledRejection"/);
  });
});

// ---------------------------------------------------------------------------
describe("F7 — the PIN-lockout alert is deduped", () => {
  function fakeNotifications(recent) {
    const sent = [];
    const checked = [];
    return {
      sent, checked,
      mod: {
        sentRecently: async (tag, hours) => { checked.push({ tag, hours }); return recent; },
        sendToAll: async (p) => { sent.push(p); },
      },
    };
  }

  it("alerts when no lockout alert went out inside the window", async () => {
    const f = fakeNotifications(false);
    const out = await auth.makeLockoutNotifier(() => f.mod)({ failures: 30, lockedUntil: new Date("2026-10-19T12:30:00Z") });
    assert.equal(out, true);
    assert.equal(f.sent.length, 1);
    assert.equal(f.sent[0].tag, "pin-lockout");
    assert.match(f.sent[0].body, /30 failed PIN attempts.*12:30 UTC/);
    assert.deepEqual(f.checked, [{ tag: "pin-lockout", hours: auth.LOCKOUT_ALERT_WINDOW_HOURS }]);
  });

  it("stays quiet while a recent lockout alert exists", async () => {
    const f = fakeNotifications(true);
    const out = await auth.makeLockoutNotifier(() => f.mod)({ failures: 30, lockedUntil: new Date() });
    assert.equal(out, false);
    assert.equal(f.sent.length, 0);
  });
});

// ---------------------------------------------------------------------------
describe("F82 — persistent_url validation, redirects, no ciphertext", () => {
  const settings = require("../teller/routes/settings");
  let dbModule, originalPoolQuery, app;

  before(() => {
    dbModule = require("../teller/services/database");
    originalPoolQuery = dbModule.pool.query;
    app = express();
    app.use(express.json());
    app.use(settings);
  });
  after(() => { dbModule.pool.query = originalPoolQuery; });

  it("normalizePersistentUrl accepts http(s), trims and drops trailing slashes; clears on empty", () => {
    assert.deepEqual(settings.normalizePersistentUrl(" https://ps.example.com/ "), { value: "https://ps.example.com" });
    assert.deepEqual(settings.normalizePersistentUrl("http://localhost:3001//"), { value: "http://localhost:3001" });
    assert.deepEqual(settings.normalizePersistentUrl(""), { value: null });
    assert.deepEqual(settings.normalizePersistentUrl(null), { value: null });
  });

  it("normalizePersistentUrl rejects other schemes, credentials, junk and overlong values", () => {
    for (const bad of ["javascript:alert(1)", "ftp://x.test", "https://user:pw@x.test", "not a url", 42, "https://x.test/" + "a".repeat(500)]) {
      assert.ok(settings.normalizePersistentUrl(bad).error, `expected an error for ${String(bad).slice(0, 30)}`);
    }
  });

  it("PATCH /api/settings 400s a bad persistent_url and never echoes *_enc columns", async () => {
    let updates = 0;
    dbModule.pool.query = async (sql) => {
      if (/UPDATE user_settings SET/i.test(sql)) {
        updates++;
        return { rows: [{ id: 1, persistent_url: "https://ps.example.com", persistent_webhook_secret_enc: Buffer.from("cipher") }] };
      }
      return { rows: [] };
    };
    const bad = await supertest(app).patch("/api/settings").send({ persistent_url: "https://u:p@ps.example.com" });
    assert.equal(bad.status, 400);
    assert.equal(updates, 0);
    const ok = await supertest(app).patch("/api/settings").send({ persistent_url: "https://ps.example.com/" });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.persistent_url, "https://ps.example.com");
    assert.equal("persistent_webhook_secret_enc" in ok.body, false);
  });

  it("every outbound Per-sistant fetch refuses to follow redirects", () => {
    const src = read("teller", "routes", "persistent.js");
    const fetches = src.match(/fetch\(`\$\{config\.url\}[^`]*`,\s*\{[^}]*\}/g) || [];
    assert.equal(fetches.length, 4);
    for (const f of fetches) assert.match(f, /redirect: "manual"/);
  });
});

// ---------------------------------------------------------------------------
describe("F125 — Mermaid pinned; CSP allows only its path", () => {
  const config = require("../apps/per-sistant/config");

  it("MERMAID_CDN_BASE is an exact version on cdn.jsdelivr.net", () => {
    assert.match(config.MERMAID_CDN_BASE, /^https:\/\/cdn\.jsdelivr\.net\/npm\/mermaid@\d+\.\d+\.\d+\/$/);
  });

  it("the Knowledge page imports from the pinned base", () => {
    const page = read("apps", "per-sistant", "pages", "knowledge.js");
    assert.match(page, /import\('\$\{MERMAID_CDN_BASE\}dist\/mermaid\.esm\.min\.mjs'\)/);
    assert.doesNotMatch(page, /mermaid@11\//);
  });

  it("the served CSP script-src lists the pinned path, not the bare host", async () => {
    const db = require("../apps/per-sistant/db");
    const orig = db.pool.query;
    db.pool.query = async () => ({ rows: [] });
    try {
      const middleware = require("../apps/per-sistant/middleware");
      const app = express();
      app.use((_req, res, next) => { res.locals.cspNonce = "n0nce"; next(); });
      middleware.setup(app);
      app.get("/api/thing", (_req, res) => res.json({ ok: true }));
      const res = await supertest(app).get("/api/thing");
      const csp = res.headers["content-security-policy"];
      const scriptSrc = csp.split(";").find(d => d.trim().startsWith("script-src "));
      assert.ok(scriptSrc.includes(config.MERMAID_CDN_BASE), scriptSrc);
      assert.doesNotMatch(scriptSrc, /https:\/\/cdn\.jsdelivr\.net(\s|$)/);
    } finally {
      db.pool.query = orig;
    }
  });
});

// ---------------------------------------------------------------------------
describe("F2 — public Actions logs carry no financial data", () => {
  const wfDir = path.join(ROOT, ".github", "workflows");
  const workflows = fs.readdirSync(wfDir).filter(f => f.endsWith(".yml"));

  it("no workflow prints a response body", () => {
    for (const f of workflows) {
      const src = fs.readFileSync(path.join(wfDir, f), "utf8");
      assert.doesNotMatch(src, /\bcat \/tmp\//, `${f} prints a response body`);
    }
  });

  it("the daily subscription check prints counts, not names or amounts", () => {
    const daily = read(".github", "workflows", "daily-sync.yml");
    assert.doesNotMatch(daily, /display_name|monthly_cost|prior_amount/);
    assert.match(daily, /node -e "\$SUMMARY_JS" \/tmp\/sync\.json/);
  });

  it("the summary helper prints only allowlisted scalars and array counts", () => {
    const daily = read(".github", "workflows", "daily-sync.yml");
    const js = daily.split("SUMMARY_JS: |")[1].split("\n    steps:")[0]
      .split("\n").map(l => l.replace(/^ {8}/, "")).join("\n");
    const tmp = path.join(require("os").tmpdir(), `oct-b1-${process.pid}.json`);
    fs.writeFileSync(tmp, JSON.stringify({
      transactions_added: 4, errors: [{ institution: "Chase", error: "x" }],
      provider: "teller", breakdown: { "Chase Checking": 1234.5 }, net_worth: 99999,
    }));
    const { execFileSync } = require("child_process");
    const out = execFileSync(process.execPath, ["-e", js, tmp, "transactions_added", "errors", "provider:str", "breakdown"], { encoding: "utf8" });
    fs.unlinkSync(tmp);
    assert.equal(out, "transactions_added: 4\nerrors: 1\nprovider: teller\n");
  });

  it("csv-import refuses to run while the repository is public", () => {
    const wf = read(".github", "workflows", "csv-import.yml");
    assert.match(wf, /if: \$\{\{ !github\.event\.repository\.private \}\}[\s\S]*?exit 1/);
    assert.ok(wf.indexOf("repository.private") < wf.indexOf("Import CSV files"));
  });
});

// ---------------------------------------------------------------------------
describe("F6 — standalone Perfin: no x-api-key bypass without API_KEY", () => {
  it("requireAuth only waves the header through when API_KEY is configured", () => {
    const src = read("teller", "server.js");
    assert.match(src, /req\.headers\["x-api-key"\] && process\.env\.API_KEY\) return next\(\)/);
  });

  it("standalone /api/login digests the password: a numeric password is a 401, not a throw", async () => {
    const dbModule = require("../teller/services/database");
    const origQuery = dbModule.pool.query;
    dbModule.pool.query = async () => ({ rows: [] }); // session-timeout lookup
    const login = require("../teller/pages/login")({ AUTH_SECRET: "1234", AUTH_MODE: "pin" });
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => { req.session = {}; next(); });
    app.use(login);
    const rejections = [];
    const onRej = (r) => rejections.push(r);
    process.on("unhandledRejection", onRej);
    try {
      const wrongNumber = await supertest(app).post("/api/login").send({ password: 9999 });
      assert.equal(wrongNumber.status, 401);
      const rightNumber = await supertest(app).post("/api/login").send({ password: 1234 });
      assert.equal(rightNumber.status, 200);
      await new Promise(r => setImmediate(r));
      assert.equal(rejections.length, 0);
    } finally {
      process.off("unhandledRejection", onRej);
      dbModule.pool.query = origQuery;
    }
  });
});
