// ============================================================================
// Real-Postgres route contract tests — shared setup (TQ-2, Sept 2026 Batch 15)
// ============================================================================
// The unit suite runs route SQL against mock pools, so a statement Postgres
// rejects ("could not determine data type of parameter", an ambiguous column,
// a JS Date where a 'YYYY-MM-DD' key was expected) passes every test. These
// contract tests run the REAL routes + helpers against a REAL database:
//
//   CONTRACT_DATABASE_URL=postgres://postgres:ci@localhost:5432/postgres \
//     npm run test:contract
//
// Each test FILE gets its own scratch database (contract_<name>), migrated by
// the app's own runMigrations — node --test runs every file in its own
// process, which matters because both apps open their pool at require time.
// Without CONTRACT_DATABASE_URL every suite is skipped (so a plain `npm test`
// never needs a database); CI's `migrations` job sets it (pinned by
// tests/scan-sept-batch15.test.js).

const path = require("path");
const fs = require("fs");

const ROOT = path.join(__dirname, "..", "..");
const ADMIN_URL = process.env.CONTRACT_DATABASE_URL || "";
const SKIP = ADMIN_URL ? false : "CONTRACT_DATABASE_URL not set — real-Postgres contract tests skipped";

function dbUrl(name) {
  const u = new URL(ADMIN_URL);
  u.pathname = "/" + name;
  return u.toString();
}

async function createDb(name) {
  const { Client } = require("pg");
  const c = new Client({ connectionString: ADMIN_URL });
  await c.connect();
  try {
    await c.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    await c.query(`CREATE DATABASE ${name}`);
  } finally { await c.end(); }
}

// Env every app module reads at require time. Must run before ANY require of
// teller/ or apps/per-sistant/ code.
function baseEnv() {
  process.env.PGSSLMODE = "disable"; // the CI container speaks plaintext
  process.env.TOKEN_ENCRYPTION_PASSPHRASE = process.env.TOKEN_ENCRYPTION_PASSPHRASE || "contract-test-passphrase";
  process.env.APP_TIMEZONE = process.env.APP_TIMEZONE || "UTC";
  process.env.SESSION_SECRET = process.env.SESSION_SECRET || "contract-test-secret";
}

// Perfin: fresh database, migrations, the single user_settings row.
async function perfinDb(name) {
  baseEnv();
  const db = "contract_perfin_" + name;
  await createDb(db);
  process.env.NEON_DATABASE_URL = dbUrl(db);
  const database = require(path.join(ROOT, "teller/services/database"));
  await database.runMigrations();
  await database.pool.query("INSERT INTO user_settings (id) VALUES (1) ON CONFLICT DO NOTHING");
  return database.pool;
}

// Per-sistant: fresh database + its migrations.
async function persistentDb(name) {
  baseEnv();
  const db = "contract_persistent_" + name;
  await createDb(db);
  process.env.PERSISTENT_DATABASE_URL = dbUrl(db);
  process.env.NEON_DATABASE_URL = dbUrl(db);
  const database = require(path.join(ROOT, "apps/per-sistant/db"));
  await database.runMigrations();
  return database.pool;
}

// Every Perfin router, mounted in teller/server.js's own order — so a request
// resolves exactly as it does in production (DC-1: a generic /:id route in an
// earlier module used to shadow a later literal path).
function perfinApp() {
  const express = require("express");
  const src = fs.readFileSync(path.join(ROOT, "teller/server.js"), "utf8");
  const order = [...src.matchAll(/app\.use\(require\("\.\/routes\/([\w-]+)"\)\)/g)].map((m) => m[1]);
  if (!order.length) throw new Error("could not read the route mount order from teller/server.js");
  const app = express();
  app.use(express.json({ limit: "1mb" }));
  for (const name of order) app.use(require(path.join(ROOT, "teller/routes", name)));
  return app;
}

// Every Per-sistant router, built with the SAME deps object and in the same
// order as apps/per-sistant/server.js — so a router that destructures a dep
// server.js never passes fails here exactly as it does in production.
function persistentApp(pool) {
  const express = require("express");
  const src = fs.readFileSync(path.join(ROOT, "apps/per-sistant/server.js"), "utf8");
  const order = [...src.matchAll(/app\.use\(require\("\.\/routes\/([\w-]+)"\)\(deps\)\)/g)].map((m) => m[1]);
  if (!order.length) throw new Error("could not read the route mount order from apps/per-sistant/server.js");
  const base = path.join(ROOT, "apps/per-sistant");
  const deps = { pool, config: require(base + "/config"), helpers: require(base + "/helpers"), views: require(base + "/views") };
  const app = express();
  app.use(express.json({ limit: "1mb" }));
  for (const name of order) app.use(require(path.join(base, "routes", name))(deps));
  return app;
}

module.exports = { ROOT, SKIP, perfinDb, persistentDb, perfinApp, persistentApp };
