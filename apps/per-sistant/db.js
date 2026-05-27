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
  ssl: CONNECTION_STRING ? { rejectUnauthorized: false } : false,
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
    for (const file of files) {
      const sql = fs.readFileSync(path.join(migrationsDir, file), "utf8");
      await client.query(sql);
    }
    console.log(`Migrations complete (${files.length} files)`);
  } catch (err) {
    console.error("Migration error:", err.message);
  } finally {
    client.release();
  }
}

module.exports = { pool, runMigrations };
