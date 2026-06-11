#!/usr/bin/env node
// ============================================================================
// CI migration test — boots BOTH apps' auto-migrations against a real,
// empty Postgres, twice each.
// ============================================================================
// Catches the failure class mock-pool tests can't: SQL syntax errors, missing
// IF NOT EXISTS guards (the second run is the idempotency check — per-sistant
// migrations are fatal on re-run errors by design, PS-1), bad column refs in
// migration UPDATEs, and CREATE statements that depend on objects that don't
// exist yet on a fresh database.
//
// Usage (CI provides a service container):
//   MIGRATION_TEST_DATABASE_URL=postgres://user:pass@localhost:5432/postgres \
//     node scripts/ci-migration-test.js
//
// The script creates two scratch databases (perfin_ci, persistent_ci) on the
// server so each app migrates against its own DB, mirroring production.
// Run with a pgvector-enabled image (pgvector/pgvector:pg16) to exercise the
// Knowledge vector path; on a plain Postgres the per-sistant migration must
// still succeed by degrading to keyword-only (INV-28) — both are valid runs.

const { Client } = require("pg");

const ADMIN_URL = process.env.MIGRATION_TEST_DATABASE_URL;
if (!ADMIN_URL) {
  console.error("MIGRATION_TEST_DATABASE_URL is required (CI service container).");
  process.exit(1);
}

async function createDb(name) {
  const client = new Client({ connectionString: ADMIN_URL });
  await client.connect();
  await client.query(`DROP DATABASE IF EXISTS ${name}`);
  await client.query(`CREATE DATABASE ${name}`);
  await client.end();
}

function dbUrl(name) {
  const u = new URL(ADMIN_URL);
  u.pathname = "/" + name;
  return u.toString();
}

async function main() {
  await createDb("perfin_ci");
  await createDb("persistent_ci");

  // Env must be set BEFORE the modules load: both apps capture their
  // connection strings (and Perfin its passphrase) at require time.
  process.env.NEON_DATABASE_URL = dbUrl("perfin_ci");
  process.env.PERSISTENT_DATABASE_URL = dbUrl("persistent_ci");
  process.env.TOKEN_ENCRYPTION_PASSPHRASE = "ci-migration-test-passphrase";

  // Perfin pool config uses ssl rejectUnauthorized — the CI container speaks
  // plaintext. PGSSLMODE=disable makes node-postgres skip TLS.
  process.env.PGSSLMODE = "disable";

  const perfin = require("../teller/services/database");
  console.log("→ Perfin migrations, run 1 (fresh database)");
  await perfin.runMigrations();
  console.log("→ Perfin migrations, run 2 (idempotency)");
  await perfin.runMigrations();

  // Sanity probes: core tables exist and the schema version was stamped.
  const v = await perfin.pool.query("SELECT MAX(version) AS v FROM schema_migrations");
  if (!v.rows[0].v) throw new Error("Perfin schema_migrations not stamped");
  for (const t of ["transactions", "user_settings", "investment_flows", "job_runs", "benchmark_prices"]) {
    await perfin.pool.query(`SELECT 1 FROM ${t} LIMIT 1`);
  }
  console.log(`✓ Perfin schema OK (version ${v.rows[0].v})`);
  await perfin.pool.end();

  const persistent = require("../apps/per-sistant/db");
  console.log("→ Per-sistant migrations, run 1 (fresh database)");
  await persistent.runMigrations();
  console.log("→ Per-sistant migrations, run 2 (idempotency — PS-1 makes failures fatal)");
  await persistent.runMigrations();
  for (const t of ["todos", "emails", "notes", "documents", "facts"]) {
    await persistent.pool.query(`SELECT 1 FROM ${t} LIMIT 1`);
  }
  // INV-28: Knowledge degrades to keyword without pgvector; with the pgvector
  // image, the chunks table must carry the embedding column.
  const vec = await persistent.pool.query(
    "SELECT 1 FROM pg_extension WHERE extname = 'vector'"
  );
  if (vec.rows.length) {
    await persistent.pool.query("SELECT embedding FROM chunks LIMIT 1");
    console.log("✓ Per-sistant schema OK (pgvector path exercised)");
  } else {
    console.log("✓ Per-sistant schema OK (keyword-degraded path — no vector extension)");
  }
  await persistent.pool.end();

  console.log("All migration runs passed.");
}

main().catch((err) => {
  console.error("MIGRATION TEST FAILED:", err.message);
  process.exit(1);
});
