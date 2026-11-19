// ============================================================================
// The TLS setting for a script's own Postgres pool (cycle-9 F6)
// ============================================================================
// The same rule as the apps' pools (teller/services/database.js,
// apps/per-sistant/db.js): TLS with a verified certificate, unless
// PGSSLMODE=disable says the database speaks plaintext on a private network
// (the CI service container, the VPS compose network). Each script used to
// hard-code `ssl: { rejectUnauthorized: true }`, so Sheets sync, reset:fresh,
// the CSV CLI and the detectors' CLI mode could not connect there.
//
// Read at call time (after dotenv has loaded), never at require time.
function pgSsl(env = process.env) {
  return env.PGSSLMODE === "disable" ? false : { rejectUnauthorized: true };
}

module.exports = { pgSsl };
