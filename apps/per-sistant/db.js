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

const { Pool } = require("pg");
const fs = require("fs");
const path = require("path");

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
});

async function runMigrations() {
  const client = await pool.connect();
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
    for (const file of files) {
      const sql = fs.readFileSync(path.join(migrationsDir, file), "utf8");
      await client.query(sql);
    }
    await client.query("COMMIT");
    console.log(`Migrations complete (${files.length} files)`);
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    console.error("Migration error (fatal):", err.message);
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { pool, runMigrations };
