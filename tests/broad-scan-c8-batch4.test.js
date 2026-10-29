// ============================================================================
// Cycle-8 broad scan, Batch 4 — sync watermarks + webhook hardening
// ============================================================================
//   F1 / F51  the anomaly and "Paycheck landed" watermarks — since cycle-8
//        E2c an id watermark with an overlap rescan, tested in
//        tests/cycle8-e2c.test.js
//   F3   the Plaid verifier caches a missing kid, caps uncached key lookups,
//        shares one lookup per kid and checks iat / body hash first
// The concurrency half (an open transaction committing after a check) runs on
// real Postgres in tests/contract/c8-batch4.contract.test.js.
// ============================================================================
if (!process.env.NEON_DATABASE_URL) process.env.NEON_DATABASE_URL = "postgres://mock:mock@localhost/mock";
if (!process.env.TOKEN_ENCRYPTION_PASSPHRASE) process.env.TOKEN_ENCRYPTION_PASSPHRASE = "test-passphrase";

const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");

const dbModule = require("../teller/services/database");
const originalQuery = dbModule.pool.query;
afterEach(() => { dbModule.pool.query = originalQuery; });

// F1 / F51 — the anomaly and "Paycheck landed" watermarks moved to an id
// watermark with an overlap rescan in cycle-8 E2c; their unit tests are in
// tests/cycle8-e2c.test.js.

// ---------------------------------------------------------------------------
describe("F3 — Plaid key lookups", () => {
  const verify = require("../teller/services/webhook-verify");
  const KID = "kid-1";
  const { privateKey, publicKey } = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
  const jwk = publicKey.export({ format: "jwk" });
  const b64u = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const BODY = JSON.stringify({ webhook_type: "TRANSACTIONS", webhook_code: "SYNC_UPDATES_AVAILABLE", item_id: "item-1" });
  function jwt({ kid = KID, iat = Math.floor(Date.now() / 1000), body = BODY, hash } = {}) {
    const h = b64u({ alg: "ES256", kid, typ: "JWT" });
    const p = b64u({ iat, request_body_sha256: hash || crypto.createHash("sha256").update(body).digest("hex") });
    const sig = crypto.sign("sha256", Buffer.from(`${h}.${p}`), { key: privateKey, dsaEncoding: "ieee-p1363" }).toString("base64url");
    return `${h}.${p}.${sig}`;
  }
  const req = (token, raw = BODY) => ({ headers: { "plaid-verification": token }, rawBody: Buffer.from(raw), body: JSON.parse(raw) });
  function client({ fail } = {}) {
    const c = {
      fetches: 0, kids: [],
      async webhookVerificationKeyGet({ key_id }) {
        c.fetches++; c.kids.push(key_id);
        await new Promise((r) => setImmediate(r));
        if (fail) throw Object.assign(new Error("plaid"), { response: { status: fail } });
        if (key_id !== KID) return { data: { key: null } };
        return { data: { key: { ...jwk, alg: "ES256", kid: KID, expired_at: null } } };
      },
    };
    return c;
  }

  it("a kid with no key is remembered as a miss for an hour", async () => {
    let t = Date.now();
    const c = client();
    const v = verify.createPlaidVerifier({ getClient: () => c, now: () => t });
    for (let i = 0; i < 3; i++) assert.equal((await v.verify(req(jwt({ kid: "nope", iat: Math.floor(t / 1000) })))).ok, false);
    assert.equal(c.fetches, 1);
    t += verify.KEY_MISS_CACHE_MS + 1;
    await v.verify(req(jwt({ kid: "nope", iat: Math.floor(t / 1000) })));
    assert.equal(c.fetches, 2, "looked up again once the miss expires");
  });

  it("at most KEY_FETCH_LIMIT uncached lookups an hour; a cached key still verifies", async () => {
    const c = client();
    const v = verify.createPlaidVerifier({ getClient: () => c });
    assert.equal((await v.verify(req(jwt()))).ok, true);
    for (let i = 0; i < verify.KEY_FETCH_LIMIT + 10; i++) await v.verify(req(jwt({ kid: "k" + i })));
    assert.equal(c.fetches, verify.KEY_FETCH_LIMIT);
    assert.equal((await v.verify(req(jwt()))).ok, true, "the real key is cached");
  });

  it("concurrent deliveries for one kid share one lookup", async () => {
    const c = client();
    const v = verify.createPlaidVerifier({ getClient: () => c });
    const r = await Promise.all([1, 2, 3].map(() => v.verify(req(jwt()))));
    assert.deepEqual(r.map((x) => x.ok), [true, true, true]);
    assert.equal(c.fetches, 1);
  });

  it("a malformed kid, a stale iat or a wrong body hash is refused before any lookup", async () => {
    const c = client();
    const v = verify.createPlaidVerifier({ getClient: () => c });
    for (const kid of ["a/b", "x".repeat(129), "kid 1"]) assert.equal((await v.verify(req(jwt({ kid })))).ok, false, kid);
    assert.equal((await v.verify(req(jwt({ iat: Math.floor(Date.now() / 1000) - 600 })))).ok, false);
    assert.equal((await v.verify(req(jwt({ hash: "0".repeat(64) })))).ok, false);
    assert.equal(c.fetches, 0);
  });

  it("a 4xx from Plaid is cached as a miss; a 5xx is not", async () => {
    const c4 = client({ fail: 400 });
    const v4 = verify.createPlaidVerifier({ getClient: () => c4 });
    await v4.verify(req(jwt())); await v4.verify(req(jwt()));
    assert.equal(c4.fetches, 1);
    const c5 = client({ fail: 503 });
    const v5 = verify.createPlaidVerifier({ getClient: () => c5 });
    await v5.verify(req(jwt())); await v5.verify(req(jwt()));
    assert.equal(c5.fetches, 2);
  });
});
