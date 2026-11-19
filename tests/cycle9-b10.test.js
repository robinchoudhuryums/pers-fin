// ============================================================================
// Cycle 9 Batch 10 — test honesty, docs, hygiene
// ============================================================================
// F6   the scripts that build their own Postgres pool (Sheets sync, reset:fresh,
//      the CSV CLI, the two detectors' CLI mode) honour PGSSLMODE=disable like
//      the apps' pools do — each script RUN as a child process
// F63  `npm run sheets-sync` reads its config after dotenv has loaded (the
//      script run for real with a stand-in .env); the context export names a
//      section it couldn't read instead of showing it empty
// F61  a full Sheets run isolates each tab (the per-tab try/catch, exercised —
//      it was only pinned as text); the rest of F61 is tests/api.test.js and
//      tests/contract/c9-batch10
// F8   the dependency fixes stay applied (the lock file, the declared ranges)
//      and csv-parse keeps a __proto__ column as an ordinary column
// ============================================================================
if (!process.env.NEON_DATABASE_URL) process.env.NEON_DATABASE_URL = "postgres://mock:mock@localhost/mock";
if (!process.env.TOKEN_ENCRYPTION_PASSPHRASE) process.env.TOKEN_ENCRYPTION_PASSPHRASE = "test-passphrase";
process.env.GOOGLE_SHEETS_ID = process.env.GOOGLE_SHEETS_ID || "unit-sheet";

const { describe, it, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const express = require("express");
const supertest = require("supertest");

const ROOT = path.join(__dirname, "..");
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), "utf8");
const PRELOAD = path.join(__dirname, "_script-preload.js");

// Runs scripts/<name> in a child process with pg / dotenv / googleapis swapped
// (tests/_script-preload.js). The environment is built from scratch so nothing
// of the developer's own (.env values exported in the shell) leaks in.
function runScript(name, { env = {}, args = [] } = {}) {
  const res = spawnSync(process.execPath, ["-r", PRELOAD, path.join(ROOT, "scripts", name), ...args], {
    cwd: ROOT, encoding: "utf8", timeout: 20000,
    env: { PATH: process.env.PATH, NEON_DATABASE_URL: "postgres://mock:mock@db.internal/mock", ...env },
  });
  const pool = (res.stdout.match(/^POOL (.*)$/m) || [])[1];
  return { status: res.status, stdout: res.stdout, stderr: res.stderr, pool: pool ? JSON.parse(pool) : null };
}

// ---------------------------------------------------------------------------
describe("F6 — the scripts' own pools honour PGSSLMODE", () => {
  const { pgSsl } = require("../scripts/pg-ssl");
  const SHEETS_ENV = { GOOGLE_SHEETS_ID: "sheet-1", GOOGLE_SERVICE_ACCOUNT_KEY: "/secrets/key.json" };
  const SCRIPTS = [
    ["sheets-sync.js", { env: SHEETS_ENV }],
    ["reset-fresh.js", {}],
    ["import-csv-cli.js", {}],
    ["detect-subscriptions.js", {}],
    ["detect-transfers.js", {}],
  ];

  it("pgSsl: verified TLS unless PGSSLMODE is exactly \"disable\"", () => {
    assert.deepEqual(pgSsl({}), { rejectUnauthorized: true });
    assert.deepEqual(pgSsl({ PGSSLMODE: "require" }), { rejectUnauthorized: true });
    assert.deepEqual(pgSsl({ PGSSLMODE: "" }), { rejectUnauthorized: true });
    assert.deepEqual(pgSsl({ PGSSLMODE: "DISABLE" }), { rejectUnauthorized: true }, "only the exact value opts out");
    assert.equal(pgSsl({ PGSSLMODE: "disable" }), false);
  });

  it("pgSsl is the apps' own rule", () => {
    // teller/services/database.js and apps/per-sistant/db.js spell the same
    // condition inline (pinned in tests/ops-and-alerts.test.js).
    assert.match(read("teller", "services", "database.js"), /ssl: process\.env\.PGSSLMODE === "disable" \? false : \{ rejectUnauthorized: true \}/);
    assert.match(read("scripts", "pg-ssl.js"), /env\.PGSSLMODE === "disable" \? false : \{ rejectUnauthorized: true \}/);
  });

  for (const [name, opts] of SCRIPTS) {
    it(`${name} connects in plaintext under PGSSLMODE=disable (the VPS compose network)`, () => {
      const r = runScript(name, { ...opts, env: { ...(opts.env || {}), PGSSLMODE: "disable" } });
      assert.ok(r.pool, `${name} built a pool — stdout: ${r.stdout} stderr: ${r.stderr}`);
      assert.equal(r.pool.ssl, false);
      assert.equal(r.pool.url, true);
    });
    it(`${name} keeps verified TLS without it (Neon)`, () => {
      const r = runScript(name, opts);
      assert.ok(r.pool, `${name} built a pool — stdout: ${r.stdout} stderr: ${r.stderr}`);
      assert.deepEqual(r.pool.ssl, { rejectUnauthorized: true });
    });
  }

  it("no script hard-codes its own TLS setting any more", () => {
    for (const f of fs.readdirSync(path.join(ROOT, "scripts")).filter((x) => x.endsWith(".js") && x !== "pg-ssl.js")) {
      assert.doesNotMatch(read("scripts", f), /ssl:\s*\{\s*rejectUnauthorized/, f);
    }
  });
});

// ---------------------------------------------------------------------------
describe("F63 — npm run sheets-sync reads its config from .env", () => {
  const DOTENV = { GOOGLE_SHEETS_ID: "sheet-from-dotenv", GOOGLE_SERVICE_ACCOUNT_KEY: "/secrets/from-dotenv.json" };

  it("values that exist only in .env reach the script: it authenticates and goes on to connect", () => {
    const r = runScript("sheets-sync.js", { env: { FAKE_DOTENV: JSON.stringify(DOTENV) } });
    assert.doesNotMatch(r.stderr, /Set GOOGLE_SHEETS_ID and GOOGLE_SERVICE_ACCOUNT_KEY/, "the config was read before dotenv loaded");
    assert.match(r.stdout, /^AUTH from-dotenv\.json$/m, "the key path from .env was used");
    assert.ok(r.pool, "and the run reached the database");
    assert.equal(r.status, 0);
  });

  it("PGSSLMODE set only in .env is honoured too (read when the pool is built)", () => {
    const r = runScript("sheets-sync.js", { env: { FAKE_DOTENV: JSON.stringify({ ...DOTENV, PGSSLMODE: "disable" }) } });
    assert.equal(r.pool.ssl, false);
  });

  it("with nothing configured it still stops with the setup message", () => {
    const r = runScript("sheets-sync.js");
    assert.equal(r.status, 1);
    assert.match(r.stderr, /Set GOOGLE_SHEETS_ID and GOOGLE_SERVICE_ACCOUNT_KEY in \.env/);
    assert.equal(r.pool, null);
  });

  it("dotenv loads before the first environment read in the file", () => {
    const src = read("scripts", "sheets-sync.js");
    const dotenv = src.indexOf('require("dotenv").config(');
    const firstEnv = src.search(/^[^/\n]*process\.env\./m);
    assert.ok(dotenv >= 0 && firstEnv > dotenv, "dotenv first");
    assert.equal(src.split('require("dotenv")').length - 1, 1, "loaded once");
  });
});

// ---------------------------------------------------------------------------
describe("F63 — the context export names a section it couldn't read", () => {
  const dbModule = require("../teller/services/database");
  const goals = require("../teller/routes/goals");
  let origQuery, origError, logged, failing;
  const app = express(); app.use(goals);

  before(() => { origQuery = dbModule.pool.query; origError = console.error; });
  after(() => { dbModule.pool.query = origQuery; console.error = origError; });
  beforeEach(() => {
    logged = []; failing = [];
    console.error = (...a) => { logged.push(a.join(" ")); };
    dbModule.pool.query = async (sql) => {
      for (const re of failing) if (re.test(sql)) throw new Error("connection terminated unexpectedly");
      if (/FROM linked_accounts la\s+WHERE NOT EXISTS/.test(sql)) return { rows: [{ name: "Checking", type: "depository", available_balance: "1000", current_balance: "1000" }] };
      if (/FROM financial_goals g/.test(sql)) return { rows: [{ name: "House", type: "savings", target_amount: "1000", current_amount: "250", monthly_contribution: 0 }] };
      return { rows: [] };
    };
  });

  it("a failed goals and net-worth read are listed, logged, and the rest still exports", async () => {
    failing = [/FROM financial_goals g/, /FROM net_worth_snapshots/];
    const body = (await supertest(app).get("/api/context-export?format=json").expect(200)).body;
    assert.deepEqual(body.sections_unavailable.sort(), ["Financial Goals", "Net Worth History"]);
    assert.deepEqual(body.goals, []);
    assert.equal(body.accounts.length, 1, "the sections that could be read are still there");
    assert.equal(logged.filter((l) => /context-export: Financial Goals could not be read: connection terminated/.test(l)).length, 1);
    assert.equal(logged.filter((l) => /context-export: Net Worth History could not be read/.test(l)).length, 1);

    logged = [];
    const md = (await supertest(app).get("/api/context-export").expect(200)).text;
    const note = md.split("\n").find((l) => l.startsWith("> **Not included:**"));
    assert.ok(note, "the markdown says what is missing");
    assert.match(note, /Financial Goals/);
    assert.match(note, /Net Worth History/);
    assert.match(note, /does not mean there is nothing to show/);
    assert.ok(md.indexOf(note) < md.indexOf("## Accounts"), "before the data, where a reader sees it");
    assert.doesNotMatch(md, /## Financial Goals/);
    assert.doesNotMatch(md, /connection terminated/, "the database's message stays in the log");
  });

  it("each optional section is named by its own heading", async () => {
    failing = [/FROM financial_goals g/, /WHERE type = 'credit'/, /FROM net_worth_snapshots/, /FROM financial_insights/, /SELECT zip_code/, /FROM investment_accounts WHERE is_active/];
    const body = (await supertest(app).get("/api/context-export?format=json").expect(200)).body;
    assert.deepEqual(body.sections_unavailable.sort(),
      ["Credit Card Details", "Financial Goals", "Investment Accounts", "Location", "Most Recent AI Analysis", "Net Worth History"]);
    assert.equal(logged.length, 6);
  });

  it("with every read working nothing is listed and nothing is logged", async () => {
    const body = (await supertest(app).get("/api/context-export?format=json").expect(200)).body;
    assert.deepEqual(body.sections_unavailable, []);
    assert.equal(body.goals.length, 1);
    const md = (await supertest(app).get("/api/context-export").expect(200)).text;
    assert.doesNotMatch(md, /Not included/);
    assert.match(md, /## Financial Goals/);
    assert.deepEqual(logged, []);
  });

  it("a required section failing is still a 500, not a half-empty export", async () => {
    failing = [/FROM linked_accounts la\s+WHERE NOT EXISTS/];
    const res = await supertest(app).get("/api/context-export?format=json");
    assert.equal(res.status, 500);
    assert.deepEqual(res.body, { error: "An internal error occurred." });
  });
});

// ---------------------------------------------------------------------------
describe("F61 — a full Sheets run isolates each tab", () => {
  const sheetsSync = require("../scripts/sheets-sync");
  const I = sheetsSync._internals;
  const STEPS = ["transactions", "subscriptions", "utilities", "insights", "recurring_transfers", "tax_deductions",
    "investments", "net_worth_history", "income", "ai_trust", "categorization_rules", "manual_bills", "bill_payments",
    "credit_scores", "important_dates", "watchlist", "month_archives", "dashboard"];
  let origError, origLog;
  before(() => { origError = console.error; origLog = console.log; console.error = () => {}; console.log = () => {}; });
  after(() => { console.error = origError; console.log = origLog; });

  function fakeSheets() {
    const meta = [];
    let nextId = 100;
    return {
      spreadsheets: {
        get: async () => ({ data: { sheets: meta } }),
        batchUpdate: async (p) => ({ data: { replies: p.requestBody.requests.map((r) => {
          if (!r.addSheet) return {};
          const sheetId = nextId++;
          meta.push({ properties: { title: r.addSheet.properties.title, sheetId } });
          return { addSheet: { properties: { sheetId, title: r.addSheet.properties.title } } };
        }) } }),
        values: { update: async () => ({}), append: async () => ({}), clear: async () => ({}) },
      },
    };
  }

  it("with the database down every tab is reported by name and the run still returns its result", async () => {
    let ended = 0;
    const pool = { query: async () => { throw new Error("db down"); }, end: async () => { ended++; } };
    const res = await I.runSyncAll({ sheets: fakeSheets(), pool });
    assert.deepEqual(res.errors.map((e) => e.step), STEPS, "one entry per tab, in run order");
    for (const e of res.errors) assert.equal(e.error, "db down");
    // Each failed tab's count falls back to zero rather than aborting the run.
    assert.equal(res.transactions_synced, 0);
    assert.equal(res.subscriptions_synced, 0);
    assert.equal(res.income_rows_synced, 0);
    assert.equal(res.month_archives_created, 0);
    assert.match(res.timestamp, /^\d{4}-\d{2}-\d{2}T/);
    assert.equal(ended, 0, "an injected pool is the caller's to close");
  });

  it("one tab failing leaves the tabs after it running", async () => {
    const seen = [];
    const pool = {
      end: async () => {},
      query: async (sql) => {
        seen.push(String(sql));
        if (/FROM detected_subscriptions/.test(sql) && seen.filter((s) => /FROM detected_subscriptions/.test(s)).length === 1) throw new Error("subscriptions query failed");
        return { rows: [] };
      },
    };
    const res = await I.runSyncAll({ sheets: fakeSheets(), pool });
    const failed = res.errors.map((e) => e.step);
    assert.ok(failed.includes("subscriptions"), "the failing tab is named: " + JSON.stringify(res.errors));
    assert.ok(!failed.includes("transactions"), "the tab before it succeeded");
    // Tabs after the failure still queried the database.
    assert.ok(seen.some((s) => /FROM credit_scores/.test(s)), "Credit Scores still ran");
    assert.ok(seen.some((s) => /FROM watchlist_items/.test(s)), "Watchlist still ran");
  });

  it("the public syncAll() passes no test seam: it builds its own client and pool", () => {
    const src = read("scripts", "sheets-sync.js");
    assert.match(src, /function syncAll\(\) \{ return singleFlight\("all", runSyncAll\); \}/);
    assert.match(src, /entry\.promise = before\.then\(\(\) => fn\(\)\)/, "singleFlight calls the run with no arguments");
    assert.match(src, /if \(!deps\.pool\) await pool\.end\(\);/, "its own pool is still closed after a run");
  });
});

// ---------------------------------------------------------------------------
describe("F8 — the dependency fixes stay applied", () => {
  const lock = JSON.parse(read("package-lock.json")).packages;
  const ver = (name) => lock["node_modules/" + name].version;
  const atLeast = (have, want) => {
    const a = have.split(".").map(Number), b = want.split(".").map(Number);
    for (let i = 0; i < 3; i++) { if (a[i] !== b[i]) return a[i] > b[i]; }
    return true;
  };
  // package → the first version clear of the advisories `npm audit` reported
  // (production dependencies, Nov 2026).
  const FIXED = {
    "proxy-addr": "2.0.8",     // critical: IPv4-mapped IPv6 trust-subnet spoofing
    "body-parser": "1.20.9",
    multer: "2.5.0",           // high: DoS via crafted multipart field names
    axios: "1.21.1",
    morgan: "1.12.1",
    qs: "6.16.2",
    express: "4.22.3",
    "form-data": "4.0.6",
    "follow-redirects": "1.16.3",
    nodemailer: "10.1.4",      // high: addressparser DoS / recipient mis-parsing
    "csv-parse": "7.0.2",      // moderate: prototype replacement via columns
  };

  for (const [name, want] of Object.entries(FIXED)) {
    it(`${name} is locked at ${want} or later`, () => {
      assert.ok(atLeast(ver(name), want), `${name} ${ver(name)} < ${want}`);
    });
  }

  it("no second, older copy of a fixed package is nested under another dependency", () => {
    for (const [key, pkg] of Object.entries(lock)) {
      const m = key.match(/node_modules\/((?:@[^/]+\/)?[^/]+)$/);
      if (!m || !FIXED[m[1]]) continue;
      assert.ok(atLeast(pkg.version, FIXED[m[1]]), `${key} ${pkg.version} < ${FIXED[m[1]]}`);
    }
  });

  it("the declared ranges can't resolve below the fixed versions", () => {
    const dep = (file, name) => { const p = JSON.parse(read(...file)); return (p.dependencies || {})[name] || (p.devDependencies || {})[name]; };
    assert.equal(dep(["apps", "per-sistant", "package.json"], "nodemailer"), "^10.6.0");
    assert.equal(dep(["teller", "package.json"], "csv-parse"), "^7.0.3");
    assert.equal(dep(["package.json"], "csv-parse"), "^7.0.3");
    for (const f of [["package.json"], ["teller", "package.json"], ["apps", "per-sistant", "package.json"], ["shell", "package.json"]]) {
      assert.equal(dep(f, "express"), "^4.22.3", f.join("/"));
    }
    // nodemailer 10 needs Node 20; the Dockerfile and the CSV workflow run 20.
    assert.equal(JSON.parse(read("package.json")).engines.node, ">=20");
    assert.match(read("Dockerfile"), /^FROM node:(2[0-9]|[3-9][0-9])/m);
  });

  it("the installed versions match the lock file", () => {
    for (const name of ["nodemailer", "csv-parse", "express", "multer", "proxy-addr"]) {
      const installed = JSON.parse(read("node_modules", name, "package.json")).version;
      assert.equal(installed, ver(name), name);
    }
  });

  it("csv-parse keeps a __proto__ column as an ordinary column (the advisory's path)", () => {
    const { parse } = require("csv-parse/sync");
    const rows = parse("__proto__,Amount\nx,1.50\n", { columns: true, skip_empty_lines: true, relax_column_count: true });
    assert.equal(rows.length, 1);
    assert.ok(Object.prototype.hasOwnProperty.call(rows[0], "__proto__"), "an own property, not a prototype write");
    assert.equal(Object.getPrototypeOf(rows[0]), Object.prototype);
    assert.equal(rows[0].Amount, "1.50");
    assert.equal({}.x, undefined);
  });

  it("the CSV import still parses a bank file on the new csv-parse (Chase's trailing comma included)", () => {
    const { parse } = require("csv-parse/sync");
    const { detectCsvFormat } = require("../teller/data/csv-formats");
    const chase = "Details,Posting Date,Description,Amount,Type,Balance,Check or Slip #\n"
      + "DEBIT,01/05/2026,COFFEE SHOP,-4.50,DEBIT_CARD,995.50,,\n"
      + "CREDIT,01/06/2026,PAYROLL,2000.00,ACH_CREDIT,2995.50,,\n";
    const rows = parse(chase, { columns: true, skip_empty_lines: true, relax_column_count: true, trim: true });
    assert.equal(rows.length, 2);
    assert.equal(rows[0].Description, "COFFEE SHOP");
    assert.equal(rows[1].Amount, "2000.00");
    assert.equal(detectCsvFormat(Object.keys(rows[0]), rows[0]), "chase_checking");
  });
});
