// ============================================================================
// Oct 2026 broad scan (cycle 7) — Batch 13: platform hardening + test quality
// ============================================================================
// The pins here need no database; the real-Postgres half (COOP header, SSO
// replay, perfin_try_decrypt, migration locking, session epoch, the Per-sistant
// schema/analytics/email/reindex tests) lives in
// tests/contract/platform-batch13.contract.test.js and
// tests/contract/persistent-batch13.contract.test.js.
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");

process.env.NEON_DATABASE_URL = process.env.NEON_DATABASE_URL || "postgres://test:test@127.0.0.1:1/test";
process.env.TOKEN_ENCRYPTION_PASSPHRASE = process.env.TOKEN_ENCRYPTION_PASSPHRASE || "test-passphrase";

// A fake pg client: records every statement; `failOn(sql)` returns an error to
// throw for that statement (or null).
function fakeDb(failOn) {
  const calls = { queries: [], releases: 0, connects: 0 };
  const client = {
    query: async (sql) => {
      calls.queries.push(typeof sql === "string" ? sql : sql.text);
      const err = failOn(String(sql), calls);
      if (err) throw err;
      return { rows: [], rowCount: 0 };
    },
    release: () => { calls.releases++; },
  };
  return { calls, db: { connect: async () => { calls.connects++; return client; } } };
}
const lockErr = () => Object.assign(new Error("canceling statement due to lock timeout"), { code: "55P03" });

describe("F10 / PS-1: Perfin runMigrations — locks, rollback, retry only on a lock timeout", () => {
  const database = require("../teller/services/database");
  const withFake = async (failOn, opts) => {
    const { calls, db } = fakeDb(failOn);
    const orig = database.pool.connect;
    database.pool.connect = db.connect;
    try {
      let error = null;
      try { await database.runMigrations(opts); } catch (e) { error = e; }
      return { calls, error };
    } finally { database.pool.connect = orig; }
  };

  it("opens with BEGIN, the advisory lock, then lock_timeout — before any DDL", async () => {
    const { calls } = await withFake((sql) => (/CREATE EXTENSION/.test(sql) ? new Error("stop") : null), { attempts: 1 });
    assert.equal(calls.queries[0], "BEGIN");
    assert.match(calls.queries[1], /pg_advisory_xact_lock/);
    assert.match(calls.queries[2], /SET LOCAL lock_timeout = '\d+s'/);
    assert.match(calls.queries[3], /CREATE EXTENSION IF NOT EXISTS pgcrypto/);
  });

  it("a non-lock failure rolls back, releases, rethrows and is NOT retried (INV-17)", async () => {
    let slept = 0;
    const { calls, error } = await withFake((sql) => (/CREATE EXTENSION/.test(sql) ? new Error("boom") : null),
      { attempts: 5, sleep: async () => { slept++; } });
    assert.equal(error.message, "boom");
    assert.equal(calls.connects, 1);
    assert.equal(calls.releases, 1);
    assert.equal(calls.queries.at(-1), "ROLLBACK");
    assert.equal(slept, 0);
  });

  it("a lock timeout (55P03) is retried with backoff, and the next failure is still fatal", async () => {
    const delays = [];
    const { calls, error } = await withFake((sql, c) => {
      if (/SET LOCAL lock_timeout/.test(sql)) return null;
      if (/CREATE EXTENSION/.test(sql)) return c.connects === 1 ? lockErr() : new Error("second failure");
      return null;
    }, { attempts: 5, sleep: async (ms) => { delays.push(ms); } });
    assert.equal(error.message, "second failure");
    assert.equal(calls.connects, 2, "retried once");
    assert.equal(calls.releases, 2);
    assert.deepEqual(delays, [2000]);
  });

  it("gives up after the configured attempts on a persistent lock timeout", async () => {
    const delays = [];
    const { calls, error } = await withFake((sql) => (/CREATE EXTENSION/.test(sql) ? lockErr() : null),
      { attempts: 3, sleep: async (ms) => { delays.push(ms); } });
    assert.equal(error.code, "55P03");
    assert.equal(calls.connects, 3);
    assert.deepEqual(delays, [2000, 4000]);
  });

  it("Perfin and Per-sistant use different advisory-lock keys (they can share a database)", () => {
    assert.notEqual(database.MIGRATION_LOCK_KEY, Number(read("apps/per-sistant/db.js").match(/MIGRATION_LOCK_KEY = (\d+)/)[1]));
  });
});

describe("F138: the database module's fail-fast env checks run for real", () => {
  const boot = (env) => spawnSync(process.execPath, ["-e", "require('./teller/services/database')"], {
    cwd: ROOT, encoding: "utf8", timeout: 20000,
    env: { PATH: process.env.PATH, ...env },
  });

  it("exits 1 without TOKEN_ENCRYPTION_PASSPHRASE", () => {
    const r = boot({ NEON_DATABASE_URL: "postgres://x:y@127.0.0.1:1/z" });
    assert.equal(r.status, 1, r.stderr);
    assert.match(r.stderr, /TOKEN_ENCRYPTION_PASSPHRASE/);
  });

  it("exits 1 without NEON_DATABASE_URL", () => {
    const r = boot({ TOKEN_ENCRYPTION_PASSPHRASE: "p" });
    assert.equal(r.status, 1, r.stderr);
    assert.match(r.stderr + r.stdout, /NEON_DATABASE_URL/);
  });

  it("ALLOW_MISSING_TOKEN_PASSPHRASE=true downgrades the passphrase check to a warning", () => {
    const r = boot({ NEON_DATABASE_URL: "postgres://x:y@127.0.0.1:1/z", ALLOW_MISSING_TOKEN_PASSPHRASE: "true" });
    assert.equal(r.status, 0, r.stderr);
  });
});

describe("F9: Perfin's COOP allows the Plaid/Teller Link popups (INV-62)", () => {
  it("helmet is configured with same-origin-allow-popups (behaviour pinned in the contract suite)", () => {
    assert.match(read("teller/server.js"), /crossOriginOpenerPolicy: \{ policy: "same-origin-allow-popups" \}/);
  });
});

describe("F10: pgvector objects depend on the INSTALLED extension", () => {
  it("db/014 attempts the CREATE in a subtransaction and builds vector objects only if pg_extension has it", () => {
    const sql = read("apps/per-sistant/db/014_vault_vectors.sql");
    assert.match(sql, /BEGIN\s+CREATE EXTENSION IF NOT EXISTS vector;\s+EXCEPTION WHEN OTHERS THEN/);
    assert.match(sql, /IF EXISTS \(SELECT 1 FROM pg_extension WHERE extname = 'vector'\) THEN/);
  });
  for (const f of ["019_semantic_cache.sql", "021_jobs.sql"]) {
    it(`db/${f} guards on pg_extension and never creates the extension itself`, () => {
      const sql = read("apps/per-sistant/db/" + f);
      assert.match(sql, /pg_extension WHERE extname = 'vector'/);
      assert.doesNotMatch(sql, /CREATE EXTENSION/);
      assert.doesNotMatch(sql, /pg_available_extensions/);
    });
  }
});

describe("F12: Sign Out Everywhere", () => {
  it("the Settings page offers it under the shell and posts the root /logout?everywhere=1", () => {
    const ejs = read("teller/views/settings.ejs");
    assert.match(ejs, /id="logout-all-btn"/);
    assert.match(ejs, /fetch\('\/logout\?everywhere=1'/);
    assert.match(ejs, /if \(window\.BASE_PATH\) \{ var lar = document\.getElementById\('logout-all-row'\)/);
    assert.match(ejs, /\['logout-all-btn', 'click', logoutEverywhere\]/);
  });
  it("the epoch column is migrated", () => {
    assert.match(read("teller/services/database.js"), /ADD COLUMN IF NOT EXISTS shell_session_epoch INT NOT NULL DEFAULT 0/);
  });
});

describe("F13: the Docker image's uploads directory is writable by appuser", () => {
  it("creates + chowns apps/per-sistant/uploads before switching to USER appuser", () => {
    const df = read("Dockerfile");
    const chown = df.indexOf("chown -R appuser:appgroup apps/per-sistant/uploads");
    assert.ok(chown > 0);
    assert.ok(chown < df.indexOf("USER appuser"));
  });
});

describe("F136: no test points real SQL at the production database variable", () => {
  it("integration.test.js is gone and no npm-test file opens a pool on NEON_DATABASE_URL", () => {
    assert.equal(fs.existsSync(path.join(ROOT, "apps/per-sistant/tests/integration.test.js")), false);
    for (const dir of ["tests", "apps/per-sistant/tests"]) {
      for (const f of fs.readdirSync(path.join(ROOT, dir)).filter((n) => n.endsWith(".test.js"))) {
        assert.doesNotMatch(read(path.join(dir, f)), /connectionString:\s*process\.env\.(NEON|PERSISTENT)_DATABASE_URL/, `${dir}/${f}`);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Policy responses (cycle-6 / cycle-7): drift guards with shrinking lists.
// ---------------------------------------------------------------------------
const SERVER_DIRS = ["teller/routes", "teller/services", "teller/data", "scripts", "shell", "shell/middleware",
  "apps/per-sistant", "apps/per-sistant/routes", "apps/per-sistant/services"];
const SERVER_FILES = ["teller/startup.js", "teller/server.js"];
function serverFiles() {
  const out = new Set(SERVER_FILES);
  for (const dir of SERVER_DIRS) {
    for (const f of fs.readdirSync(path.join(ROOT, dir))) if (f.endsWith(".js")) out.add(dir + "/" + f);
  }
  return [...out].sort();
}
// Lines that are code (comment-only lines dropped).
const codeLines = (src) => src.split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l));

describe("Policy: timezone lint — no new UTC 'today' / 'this month' anchors in server code", () => {
  // A UTC "today" (new Date().toISOString().slice(0, 10)) or month bucket
  // (date_trunc('month', CURRENT_DATE | now())) is the operator's wrong day
  // or month west/east of UTC (F11 / FAN-13 / F66). Use todayStr() /
  // currentMonth() (Perfin) or Per-sistant's APP_TIMEZONE helpers. Date math on
  // an already-anchored date is fine and not matched. Entries only shrink: a
  // count that grows fails, and so does one that drops without an update here.
  const PATTERN = /new Date\(\)\.toISOString\(\)\.(slice\(0,\s*(7|10)\)|split\(["']T["']\)\[0\]|substring\(0,\s*(7|10)\))|date_trunc\(\s*'month',\s*(CURRENT_DATE|now\(\))\s*\)/g;
  const KNOWN_GAPS = {
    "teller/services/financial-queries.js": { count: 1, reason: "todayStr()'s invalid-APP_TIMEZONE fallback to UTC (documented)" },
    "teller/services/projections.js": { count: 1, reason: "computeLoanPayoff's default `today` arg; every server caller passes todayStr()" },
    "scripts/sheets-sync.js": { count: 1, reason: "sheetsTodayStr()'s invalid-zone fallback to UTC" },
    "apps/per-sistant/routes/health.js": { count: 1, reason: "the habits todayStr()'s invalid-zone fallback to UTC" },
    "apps/per-sistant/ai.js": { count: 1, reason: "FOLLOW-ON: Per-sistant's AI cap month (monthlyAiSpendCents) is the UTC month — Perfin's equivalent was fixed in F66" },
    "apps/per-sistant/routes/ai.js": { count: 1, reason: "FOLLOW-ON: the Ask context's 'Today:' line is the UTC date" },
    "apps/per-sistant/routes/rag.js": { count: 1, reason: "FOLLOW-ON: capture-to-vault file names use the UTC date" },
  };
  it("per-file counts match KNOWN_GAPS exactly", () => {
    const found = {};
    for (const f of serverFiles()) {
      const n = codeLines(read(f)).join("\n").match(PATTERN);
      if (n) found[f] = n.length;
    }
    const expected = Object.fromEntries(Object.entries(KNOWN_GAPS).map(([f, v]) => [f, v.count]));
    assert.deepEqual(found, expected);
  });
});

describe("Policy: canonical helpers are not re-derived", () => {
  const files = serverFiles();
  const usersOf = (re) => files.filter((f) => re.test(codeLines(read(f)).join("\n")));

  it("every net_worth_snapshots writer computes the figure with getNetWorth (INV: net worth has one source)", () => {
    for (const f of usersOf(/INSERT INTO net_worth_snapshots/)) {
      assert.match(read(f), /getNetWorth\(/, f + " writes a net-worth snapshot without getNetWorth");
    }
  });

  it("budget_snapshots are read only by getBudgetStatus, the snapshot writer and the parity-tested Sheets mirror (INV-73)", () => {
    assert.deepEqual(usersOf(/(FROM|JOIN) budget_snapshots/),
      ["scripts/sheets-sync.js", "teller/routes/budgets.js", "teller/services/financial-queries.js"]);
  });

  it("income streams are built only through getLiveIncomeStreams (INV-110)", () => {
    assert.deepEqual(usersOf(/buildIncomeStreams\(/), ["teller/services/cadence.js", "teller/services/financial-queries.js"]);
  });

  it("the monthly AI spend is computed only by monthAiSpendCents (INV-14)", () => {
    assert.deepEqual(usersOf(/cache_read_tokens[^`"]*FROM financial_insights WHERE created_at >=/), ["teller/routes/insights.js"]);
    assert.equal((read("teller/routes/insights.js").match(/FROM financial_insights WHERE created_at >= \(\$1::date::timestamp AT TIME ZONE \$2\)/g) || []).length, 1);
  });

  it("the budget effective limit is added up only in getBudgetStatus and its Sheets mirror", () => {
    assert.deepEqual(usersOf(/monthly_limit\s*\+\s*(rollover|CASE WHEN b\.rollover_enabled)|limit \+ rollover/),
      ["scripts/sheets-sync.js", "teller/services/financial-queries.js"]);
  });
});
