// Real-Postgres contract test for seams audit #4 A3: the boot check compares
// the databases themselves, so one database reached under two addresses
// (localhost and 127.0.0.1 here; Neon's pooler and direct hosts in production)
// is caught, while two databases on one server are not confused.
const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { SKIP, perfinDb } = require("./_setup");

describe("seams audit #4 A3 — database identity on real Postgres", { skip: SKIP }, () => {
  const { Pool } = require("pg");
  const bc = require("../../shell/boot-checks");
  const ADMIN = process.env.CONTRACT_DATABASE_URL || "";
  const pools = [];
  let ONE = "";
  const url = (base, host) => {
    const u = new URL(base);
    if (host) u.hostname = host;
    return u.toString();
  };
  const pool = (connectionString) => {
    const p = new Pool({ connectionString, ssl: false, max: 1, connectionTimeoutMillis: 2000 });
    pools.push(p);
    return p;
  };

  before(async () => {
    const appPool = await perfinDb("s4a3"); // a scratch database (the app's own pool on it)
    pools.push(appPool);
    ONE = process.env.NEON_DATABASE_URL;
  });
  after(async () => { for (const p of pools) await p.end().catch(() => null); });

  it("the same database under two hosts is one; two databases on one server are two", async () => {
    const host = new URL(ONE).hostname;
    const alias = host === "localhost" ? "127.0.0.1" : "localhost";
    assert.equal(bc.sameDatabase(url(ONE, host), url(ONE, alias)), false, "the URL check alone doesn't see these as one database");
    assert.equal(await bc.poolsShareDatabase(pool(url(ONE, host)), pool(url(ONE, alias))), true);
    assert.equal(await bc.poolsShareDatabase(pool(ONE), pool(ADMIN)), false, "the scratch database and the admin database");
    assert.match(await bc.sharedDatabaseIdentityProblem({ perfinPool: pool(url(ONE, host)), persistentPool: pool(url(ONE, alias)), env: {} }),
      /same database/);
    assert.equal(await bc.sharedDatabaseIdentityProblem({ perfinPool: pool(ONE), persistentPool: pool(ADMIN), env: {} }), null);
  });

  it("an unreachable database reads as unknown, not as shared", async () => {
    const dead = new URL(ONE);
    dead.hostname = "127.0.0.1";
    dead.port = "1";
    assert.equal(await bc.poolsShareDatabase(pool(ONE), pool(dead.toString())), null);
  });
});
