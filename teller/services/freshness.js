// How fresh the bank data is (cycle-8 E4b, G3 — .cycle/plan-e4-operator-freshness.md).
//
// One definition behind Sync Health's connection list (gatherDataHealth),
// GET /api/data-freshness and the nav's "Synced Xm ago" badge. A webhook sync
// (roadmap T2.1 W3 / W5) stamps only its connection's own last_synced_at, never
// the global user_settings stamps — so the badge reads the connections: the
// OLDEST active one sets the age, and a connection that needs re-authentication
// or is disconnected makes the whole badge stale and names it. Only with no
// connection at all (CSV / manual accounts only) does it fall back to the newest
// global stamp.

const FRESH_SEC = 6 * 60 * 60;   // < 6 h → fresh (green)
const STALE_SEC = 24 * 60 * 60;  // ≥ 24 h → stale (red); in between → aging

// { timestamp, age_seconds, level } — level 'stale' when never synced.
function ageInfo(ts, now = Date.now()) {
  if (!ts) return { timestamp: null, age_seconds: null, level: "stale" };
  const age = Math.floor((now - new Date(ts).getTime()) / 1000);
  const level = age < FRESH_SEC ? "fresh" : age < STALE_SEC ? "aging" : "stale";
  return { timestamp: ts, age_seconds: age, level };
}

// Each non-suspended Teller enrollment and non-CSV Plaid item with its own
// last_synced_at, in the shape data-health has listed since W6. Throws on a
// failed read (callers decide what that means).
const CONNECTIONS_SQL = `SELECT 'teller' AS provider, id, institution_name, status, last_synced_at
       FROM teller_enrollments WHERE status <> 'SUSPENDED'
     UNION ALL
     SELECT 'plaid', id, institution_name,
            CASE WHEN last_error_code IS NOT NULL THEN 'NEEDS_REAUTH' ELSE status END,
            last_synced_at
       FROM plaid_items WHERE status <> 'CSV'
     ORDER BY 1, 3`;

async function readConnections(db, now = Date.now()) {
  const r = await db.query(CONNECTIONS_SQL);
  return r.rows.map((c) => ({
    provider: c.provider,
    id: c.id,
    institution: c.institution_name,
    status: c.status,
    last_synced: ageInfo(c.last_synced_at, now),
  }));
}

const PROBLEM_REASONS = { NEEDS_REAUTH: "reauth", DISCONNECTED: "disconnected" };

function named(c) {
  return { provider: c.provider, id: c.id, institution: c.institution || null };
}

// The badge's one figure. Pure.
//  - connections exist: a re-auth / disconnected one wins (stale, its reason);
//    else the OLDEST — a connection with no complete sync recorded counts as
//    oldest (reason 'never') — basis 'connections';
//  - no connections: the newest of the global stamps, basis 'global'.
function overallFreshness(connections, globals = {}, now = Date.now()) {
  const list = Array.isArray(connections) ? connections : [];
  if (list.length) {
    const problem = list.find((c) => PROBLEM_REASONS[c.status]);
    if (problem) {
      return {
        basis: "connections",
        level: "stale",
        reason: PROBLEM_REASONS[problem.status],
        timestamp: problem.last_synced ? problem.last_synced.timestamp : null,
        age_seconds: problem.last_synced ? problem.last_synced.age_seconds : null,
        connection: named(problem),
      };
    }
    let oldest = null;
    for (const c of list) {
      const ls = c.last_synced || { timestamp: null };
      if (!ls.timestamp) { oldest = c; break; }
      if (!oldest || ls.age_seconds > oldest.last_synced.age_seconds) oldest = c;
    }
    const ls = oldest.last_synced || ageInfo(null, now);
    return {
      basis: "connections",
      level: ls.level,
      reason: ls.timestamp ? null : "never",
      timestamp: ls.timestamp,
      age_seconds: ls.age_seconds,
      connection: named(oldest),
    };
  }
  const stamps = [globals.last_auto_sync_at, globals.last_txn_sync_at, globals.last_balance_sync_at]
    .filter(Boolean)
    .map((t) => ({ t, ms: new Date(t).getTime() }))
    .filter((x) => Number.isFinite(x.ms));
  const newest = stamps.length ? stamps.reduce((a, b) => (b.ms > a.ms ? b : a)).t : null;
  const info = ageInfo(newest, now);
  return {
    basis: "global",
    level: info.level,
    reason: newest ? null : "never",
    timestamp: info.timestamp,
    age_seconds: info.age_seconds,
    connection: null,
  };
}

// { connections, overall } from one read of the connections. A failed read
// falls back to the global basis (and says so with connections_error: true).
async function connectionFreshness(db, { now = Date.now(), globals = {} } = {}) {
  let connections = [];
  let connectionsError = false;
  try {
    connections = await readConnections(db, now);
  } catch (e) {
    console.error("freshness connections read failed:", e.message);
    connectionsError = true;
  }
  const overall = overallFreshness(connections, globals, now);
  return { connections, overall, connections_error: connectionsError };
}

module.exports = {
  FRESH_SEC,
  STALE_SEC,
  CONNECTIONS_SQL,
  ageInfo,
  readConnections,
  overallFreshness,
  connectionFreshness,
};
