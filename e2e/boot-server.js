#!/usr/bin/env node
// ============================================================================
// E2E server boot — creates scratch databases, then starts the unified shell.
// ============================================================================
// Used as Playwright's webServer command (and runnable standalone for manual
// poking). Same scratch-DB approach as scripts/ci-migration-test.js; the
// shell's normal startup then runs both apps' migrations against them.
//
// Env in: E2E_DATABASE_URL (admin URL of a disposable Postgres).
// Everything else is set here so a bare `node e2e/boot-server.js` works.

const { Client } = require("pg");

const ADMIN_URL = process.env.E2E_DATABASE_URL || "postgres://postgres:ci@localhost:5432/postgres";

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
  await createDb("perfin_e2e");
  await createDb("persistent_e2e");

  process.env.NEON_DATABASE_URL = dbUrl("perfin_e2e");
  process.env.PERSISTENT_DATABASE_URL = dbUrl("persistent_e2e");
  process.env.PGSSLMODE = "disable";
  process.env.TOKEN_ENCRYPTION_PASSPHRASE = "e2e-passphrase";
  process.env.SHELL_PIN = process.env.E2E_SHELL_PIN || "246810";
  process.env.SHELL_SECRET = "e2e-shell-secret-for-cookie-signing-only";
  process.env.PORT = process.env.E2E_PORT || "3000";
  // No bank/AI/SMTP config — every integration degrades gracefully by design.

  require("../shell/index.js");
}

main().catch((err) => {
  console.error("E2E boot failed:", err.message);
  process.exit(1);
});
