// ============================================================================
// Per-sistant — Database Pool & Migrations
// ============================================================================
// Connection string lookup order:
//   1. PERSISTENT_DATABASE_URL — used when this app is mounted under the
//      unified shell alongside Perfin, which uses NEON_DATABASE_URL for
//      its own (different) Neon database.
//   2. NEON_DATABASE_URL — used in the standalone deployment of
//      per-sistant where there's no naming collision.
// Both apps coexisting in one process need distinct env vars; standalone
// deploys keep working with NEON_DATABASE_URL alone.

const { Pool, types: pgTypes } = require("pg");
const fs = require("fs");
const path = require("path");

// Cycle-8 F52: a DATE column arrives as its 'YYYY-MM-DD' text. node-pg's default
// builds a LOCAL-midnight Date, which JSON-serializes in UTC — on a server east of
// UTC every due date went out a day early (and the todo modal's split('T')[0] /
// ai.js's toISOString() saved or quoted it shifted). Pool-scoped, so Perfin's pool
// in the same process keeps its own parsing. Server code turns a value into a
// local Date with helpers.calDate and back with helpers.ymdOf (both accept either
// shape — test doubles still hand in Date objects).
const DATE_OID = 1082;
const DATE_AS_STRING = {
  getTypeParser(oid, format) {
    if (oid === DATE_OID && format !== "binary") return (v) => v;
    return pgTypes.getTypeParser(oid, format);
  },
};

const CONNECTION_STRING =
  process.env.PERSISTENT_DATABASE_URL || process.env.NEON_DATABASE_URL;

const pool = new Pool({
  connectionString: CONNECTION_STRING,
  // Verify the Neon TLS certificate (PSB1) — matches Perfin's
  // teller/services/database.js. `false` left DB traffic open to MITM /
  // endpoint impersonation (encrypted but unauthenticated). Neon terminates
  // TLS with a publicly-trusted cert in Node's default CA store, so
  // verification works without bundling a CA (Perfin connects to Neon this way).
  // PGSSLMODE=disable: see teller/services/database.js — CI migration test.
  ssl: (CONNECTION_STRING && process.env.PGSSLMODE !== "disable") ? { rejectUnauthorized: true } : false,
  // Single-user app — 3 connections is plenty. The previous 10 kept idle
  // Postgres backends alive on Neon, burning compute hours for nothing.
  max: 3,
  idleTimeoutMillis: 20000,
  connectionTimeoutMillis: 5000,
  types: DATE_AS_STRING,
});

// Migration locking (cycle-7 F10) — same rules as Perfin's runner: an
// advisory lock serialises two booting instances, lock_timeout stops a
// migration from freezing the live app behind a long query, and a lock
// timeout (55P03) is retried with backoff; anything else stays fatal (PS-1).
// A distinct key from Perfin's (727274001): a standalone Per-sistant can
// share Perfin's database.
const MIGRATION_LOCK_KEY = 727274002;
const MIGRATION_LOCK_TIMEOUT = "5s";
const MIGRATION_ATTEMPTS = 5;

async function runMigrations({ attempts = MIGRATION_ATTEMPTS, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), db = pool } = {}) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await runMigrationsOnce(db);
    } catch (err) {
      if (err && err.code === "55P03" && attempt < attempts) {
        console.warn(`Migration lock timeout (attempt ${attempt}/${attempts}) — retrying: ${err.message}`);
        await sleep(2000 * attempt);
        continue;
      }
      console.error("Migration error (fatal):", err.message);
      throw err;
    }
  }
}

async function runMigrationsOnce(db) {
  const client = await db.connect();
  try {
    const migrationsDir = path.join(__dirname, "db");
    if (!fs.existsSync(migrationsDir)) return;
    const files = fs.readdirSync(migrationsDir)
      .filter(f => f.endsWith(".sql"))
      .sort();
    // Run every migration inside ONE transaction and make failure FATAL
    // (PS-1). Previously each file ran without BEGIN/COMMIT and the catch
    // only logged, so a failed migration left a half-applied schema and the
    // server booted against it anyway. This mirrors Perfin's atomic + fatal
    // migration guarantee — the throw propagates to start(), which exits.
    await client.query("BEGIN");
    // Advisory lock FIRST, with no timeout: a second instance waits for the
    // first runner (whose own statements are bounded by lock_timeout below).
    await client.query("SELECT pg_advisory_xact_lock($1)", [MIGRATION_LOCK_KEY]);
    await client.query(`SET LOCAL lock_timeout = '${MIGRATION_LOCK_TIMEOUT}'`);
    for (const file of files) {
      const sql = fs.readFileSync(path.join(migrationsDir, file), "utf8");
      await client.query(sql);
    }
    await client.query("COMMIT");
    console.log(`Migrations complete (${files.length} files)`);
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { pool, runMigrations, MIGRATION_LOCK_KEY, DATE_AS_STRING };
