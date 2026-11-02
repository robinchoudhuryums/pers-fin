// Boot-time configuration checks for the unified shell (shell/index.js calls
// them in start(), before either sub-app runs its migrations). Kept out of
// index.js, which starts the server as soon as it is required, so tests can
// load them.

// Cycle-8 F26: Per-sistant falls back to NEON_DATABASE_URL when
// PERSISTENT_DATABASE_URL is unset — right for a standalone Per-sistant, wrong
// under the shell: both apps would migrate into one database, their single-row
// user_settings tables would merge, and the two separate AI caps (INV-143)
// would silently become one. Returns the reason to refuse to start, or null.
// ALLOW_SHARED_DATABASE=true is the explicit opt-in for a one-database setup.
function sharedDatabaseProblem(env = process.env) {
  if (String(env.ALLOW_SHARED_DATABASE || "").toLowerCase() === "true") return null;
  const perfin = (env.NEON_DATABASE_URL || "").trim();
  const persistent = (env.PERSISTENT_DATABASE_URL || "").trim();
  if (!persistent) {
    return "PERSISTENT_DATABASE_URL is not set — refusing to start: Per-sistant would fall back to NEON_DATABASE_URL and share Perfin's database. Set it to Per-sistant's own database, or ALLOW_SHARED_DATABASE=true to run both apps in one.";
  }
  if (perfin && sameDatabase(perfin, persistent)) {
    return "PERSISTENT_DATABASE_URL points at the same database as NEON_DATABASE_URL — refusing to start (the two apps' settings would merge). Give Per-sistant its own database, or set ALLOW_SHARED_DATABASE=true to run both apps in one.";
  }
  return null;
}

// Same host, port and database name — the parts that decide where the tables
// land (user, password and query options don't).
function sameDatabase(a, b) {
  try {
    const ua = new URL(a);
    const ub = new URL(b);
    return ua.hostname.toLowerCase() === ub.hostname.toLowerCase()
      && (ua.port || "5432") === (ub.port || "5432")
      && ua.pathname.replace(/\/+$/, "") === ub.pathname.replace(/\/+$/, "");
  } catch {
    return a === b;
  }
}

module.exports = { sharedDatabaseProblem, sameDatabase };
