// ============================================================================
// Roadmap T2.1 — W2: webhook signature verification
// ============================================================================
//  Plaid: an ES256 JWT in Plaid-Verification, signed with a locally generated
//  P-256 key served by a fake webhookVerificationKeyGet — valid, tampered body,
//  stale / future iat, alg none / HS256 (no key fetch), unknown / expired key,
//  another key's signature, malformed tokens, the key cache, the JWT-hash
//  dedupe key.
//  Teller: HMAC-SHA256 over "<t>.<raw body>" in Teller-Signature — valid,
//  wrong secret, rotation (two secrets / two v1 values), stale t, tampered
//  body, upper-case hex, an id-less event, header garbage, secret parsing.
//  Both through the PRODUCTION router: recorded once (ignored — no handlers
//  yet), a replay answered as a duplicate, a forgery 401.
// The database-backed half is tests/contract/webhooks-w2.contract.test.js.
const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const express = require("express");
const supertest = require("supertest");

if (!process.env.NEON_DATABASE_URL) process.env.NEON_DATABASE_URL = "postgres://mock:mock@localhost/mock";
if (!process.env.TOKEN_ENCRYPTION_PASSPHRASE) process.env.TOKEN_ENCRYPTION_PASSPHRASE = "test-passphrase";

const dbModule = require("../teller/services/database");
const plaidClientModule = require("../teller/services/plaid-client");
const verify = require("../teller/services/webhook-verify");

// ---- Plaid helpers -----------------------------------------------------------
const KID = "kid-1";
const { privateKey, publicKey } = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
const other = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
const jwk = publicKey.export({ format: "jwk" });
const b64u = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
function plaidJwt({ body, iat = Math.floor(Date.now() / 1000), alg = "ES256", kid = KID, key = privateKey, hash } = {}) {
  const h = b64u({ alg, kid, typ: "JWT" });
  const p = b64u({ iat, request_body_sha256: hash || crypto.createHash("sha256").update(body).digest("hex") });
  const sig = crypto.sign("sha256", Buffer.from(`${h}.${p}`), { key, dsaEncoding: "ieee-p1363" }).toString("base64url");
  return `${h}.${p}.${sig}`;
}
function fakePlaidClient({ expired = false, missing = false } = {}) {
  const c = {
    fetches: 0,
    async webhookVerificationKeyGet({ key_id }) {
      c.fetches++;
      if (missing || key_id !== KID) return { data: { key: null } };
      return { data: { key: { ...jwk, alg: "ES256", kid: KID, use: "sig", created_at: 1, expired_at: expired ? 2 : null } } };
    },
  };
  return c;
}
const PLAID_BODY = JSON.stringify({ webhook_type: "TRANSACTIONS", webhook_code: "SYNC_UPDATES_AVAILABLE", item_id: "item-1", environment: "sandbox" });
const plaidReq = (token, raw = PLAID_BODY) => ({ headers: token == null ? {} : { "plaid-verification": token }, rawBody: Buffer.from(raw), body: JSON.parse(raw) });

// ---- Teller helpers ----------------------------------------------------------
const SECRET = "teller-signing-secret";
const TELLER_BODY = JSON.stringify({ id: "wh_123", type: "enrollment.disconnected", timestamp: "2026-10-22T00:00:00Z", payload: { enrollment_id: "enr_1", reason: "disconnected" } });
const tellerSig = (raw, { secret = SECRET, t = Math.floor(Date.now() / 1000) } = {}) =>
  `t=${t},v1=${crypto.createHmac("sha256", secret).update(`${t}.${raw}`).digest("hex")}`;
const tellerReq = (header, raw = TELLER_BODY) => ({ headers: header == null ? {} : { "teller-signature": header }, rawBody: Buffer.from(raw), body: JSON.parse(raw) });

// ---------------------------------------------------------------------------
describe("W2 — Plaid JWT verification", () => {
  it("a valid delivery verifies, keyed by the JWT hash, with only short event fields", async () => {
    const client = fakePlaidClient();
    const v = verify.createPlaidVerifier({ getClient: () => client });
    assert.equal(v.configured(), true);
    const token = plaidJwt({ body: PLAID_BODY });
    const r = await v.verify(plaidReq(token));
    assert.equal(r.ok, true);
    assert.equal(r.dedupeKey, "jwt:" + crypto.createHash("sha256").update(token).digest("hex"));
    assert.deepEqual(r.event, { type: "TRANSACTIONS", code: "SYNC_UPDATES_AVAILABLE", subject: "item-1" });
  });

  it("a body that doesn't match request_body_sha256 is refused", async () => {
    const v = verify.createPlaidVerifier({ getClient: () => fakePlaidClient() });
    const token = plaidJwt({ body: PLAID_BODY });
    assert.equal((await v.verify(plaidReq(token, PLAID_BODY.replace("item-1", "item-2")))).ok, false);
  });

  it("iat must be within 5 minutes (a minute of skew ahead allowed)", async () => {
    const now = Date.now();
    const v = verify.createPlaidVerifier({ getClient: () => fakePlaidClient(), now: () => now });
    const at = (sec) => plaidJwt({ body: PLAID_BODY, iat: Math.floor(now / 1000) + sec });
    assert.equal((await v.verify(plaidReq(at(-4 * 60)))).ok, true);
    assert.equal((await v.verify(plaidReq(at(-6 * 60)))).ok, false);
    assert.equal((await v.verify(plaidReq(at(30)))).ok, true);
    assert.equal((await v.verify(plaidReq(at(5 * 60)))).ok, false);
  });

  it("only ES256 is accepted, refused before any key fetch", async () => {
    const client = fakePlaidClient();
    const v = verify.createPlaidVerifier({ getClient: () => client });
    for (const alg of ["none", "HS256", "RS256"]) {
      const [, p, s] = plaidJwt({ body: PLAID_BODY }).split(".");
      const forged = `${b64u({ alg, kid: KID, typ: "JWT" })}.${p}.${s}`;
      assert.equal((await v.verify(plaidReq(forged))).ok, false, alg);
    }
    assert.equal(client.fetches, 0);
  });

  it("an unknown or expired key, and another key's signature, are refused", async () => {
    assert.equal((await verify.createPlaidVerifier({ getClient: () => fakePlaidClient({ missing: true }) }).verify(plaidReq(plaidJwt({ body: PLAID_BODY })))).ok, false);
    assert.equal((await verify.createPlaidVerifier({ getClient: () => fakePlaidClient({ expired: true }) }).verify(plaidReq(plaidJwt({ body: PLAID_BODY })))).ok, false);
    assert.equal((await verify.createPlaidVerifier({ getClient: () => fakePlaidClient() }).verify(plaidReq(plaidJwt({ body: PLAID_BODY, key: other.privateKey })))).ok, false);
  });

  it("missing, oversized and malformed tokens are refused", async () => {
    const v = verify.createPlaidVerifier({ getClient: () => fakePlaidClient() });
    for (const t of [null, "", "a.b", "a.b.c.d", "!!.!!.!!", "x".repeat(5000)]) {
      assert.equal((await v.verify(plaidReq(t))).ok, false, String(t).slice(0, 20));
    }
  });

  it("keys are cached by kid; with no Plaid client the verifier is unconfigured", async () => {
    const client = fakePlaidClient();
    const v = verify.createPlaidVerifier({ getClient: () => client });
    await v.verify(plaidReq(plaidJwt({ body: PLAID_BODY })));
    await v.verify(plaidReq(plaidJwt({ body: PLAID_BODY, iat: Math.floor(Date.now() / 1000) - 1 })));
    assert.equal(client.fetches, 1);
    assert.equal(verify.createPlaidVerifier({ getClient: () => null }).configured(), false);
  });
});

// ---------------------------------------------------------------------------
describe("W2 — Teller HMAC verification", () => {
  const v = verify.createTellerVerifier({ secrets: () => [SECRET] });

  it("a valid delivery verifies, keyed by the event id, with the enrollment as subject", async () => {
    assert.equal(v.configured(), true);
    const r = await v.verify(tellerReq(tellerSig(TELLER_BODY)));
    assert.equal(r.ok, true);
    assert.equal(r.dedupeKey, "evt:wh_123");
    assert.deepEqual(r.event, { type: "enrollment.disconnected", code: null, subject: "enr_1" });
  });

  it("a wrong secret, a tampered body and a stale or far-future timestamp are refused", async () => {
    assert.equal((await v.verify(tellerReq(tellerSig(TELLER_BODY, { secret: "other" })))).ok, false);
    assert.equal((await v.verify(tellerReq(tellerSig(TELLER_BODY), TELLER_BODY.replace("enr_1", "enr_2")))).ok, false);
    const now = Math.floor(Date.now() / 1000);
    assert.equal((await v.verify(tellerReq(tellerSig(TELLER_BODY, { t: now - 6 * 60 })))).ok, false);
    assert.equal((await v.verify(tellerReq(tellerSig(TELLER_BODY, { t: now + 5 * 60 })))).ok, false);
    assert.equal((await v.verify(tellerReq(tellerSig(TELLER_BODY, { t: now - 4 * 60 })))).ok, true);
  });

  it("rotation: any configured secret and any v1 value may match; upper-case hex is accepted", async () => {
    const rotating = verify.createTellerVerifier({ secrets: () => ["old-secret", SECRET] });
    assert.equal((await rotating.verify(tellerReq(tellerSig(TELLER_BODY)))).ok, true);
    const t = Math.floor(Date.now() / 1000);
    const good = crypto.createHmac("sha256", SECRET).update(`${t}.${TELLER_BODY}`).digest("hex");
    assert.equal((await v.verify(tellerReq(`t=${t},v1=${"0".repeat(64)},v1=${good}`))).ok, true);
    assert.equal((await v.verify(tellerReq(`t=${t},v1=${good.toUpperCase()}`))).ok, true);
  });

  it("an event without an id is deduplicated per signature", async () => {
    const raw = JSON.stringify({ type: "webhook.test", payload: {} });
    const r = await v.verify(tellerReq(tellerSig(raw), raw));
    assert.equal(r.ok, true);
    assert.match(r.dedupeKey, /^sig:[0-9a-f]{64}$/);
  });

  it("garbage headers are refused; secrets parse from a comma-separated list", async () => {
    for (const h of [null, "", "t=abc,v1=00", "v1=00", "t=123", "t=1,v1=", "x".repeat(5000)]) {
      assert.equal((await v.verify(tellerReq(h))).ok, false, String(h).slice(0, 20));
    }
    assert.deepEqual(verify.tellerSecrets({ TELLER_WEBHOOK_SECRET: " a , b,, " }), ["a", "b"]);
    assert.deepEqual(verify.tellerSecrets({}), []);
    assert.equal(verify.createTellerVerifier({ secrets: () => [] }).configured(), false);
  });
});

// ---------------------------------------------------------------------------
describe("W2 — through the production router", () => {
  const realQuery = dbModule.pool.query;
  const realGet = plaidClientModule.getPlaidClient;
  const saved = process.env.TELLER_WEBHOOK_SECRET;
  let calls, seen, router;
  before(() => {
    process.env.TELLER_WEBHOOK_SECRET = "old-secret," + SECRET;
    plaidClientModule.getPlaidClient = () => fakePlaidClient();
    seen = new Set();
    dbModule.pool.query = async (sql, params) => {
      calls.push({ sql, params });
      if (/INSERT INTO webhook_events/.test(sql)) {
        const k = params[0] + "|" + params[4];
        if (seen.has(k)) return { rows: [] };
        seen.add(k);
        return { rows: [{ id: seen.size }] };
      }
      return { rows: [], rowCount: 1 };
    };
    delete require.cache[require.resolve("../teller/routes/webhooks")];
    router = require("../teller/routes/webhooks");
  });
  after(() => {
    dbModule.pool.query = realQuery;
    plaidClientModule.getPlaidClient = realGet;
    if (saved === undefined) delete process.env.TELLER_WEBHOOK_SECRET; else process.env.TELLER_WEBHOOK_SECRET = saved;
  });
  const app = () => {
    const a = express();
    a.use(express.json({ verify: (req, _res, buf) => { req.rawBody = buf; } }));
    a.use(router);
    return a;
  };
  const settle = () => new Promise((r) => setTimeout(r, 20));

  it("Plaid: recorded once and marked ignored (no handler yet); a replay is a duplicate; a forgery 401s", async () => {
    calls = [];
    const token = plaidJwt({ body: PLAID_BODY });
    const send = (tok, raw = PLAID_BODY) => supertest(app()).post("/api/webhooks/plaid")
      .set("Content-Type", "application/json").set("Plaid-Verification", tok).send(raw);
    assert.deepEqual((await send(token).expect(200)).body, { ok: true });
    await settle();
    assert.deepEqual((await send(token).expect(200)).body, { ok: true, duplicate: true });
    const orig = console.warn; console.warn = () => {};
    try { await send(token, PLAID_BODY.replace("item-1", "item-9")).expect(401); } finally { console.warn = orig; }
    const ins = calls.filter((c) => /INSERT INTO webhook_events/.test(c.sql));
    assert.equal(ins.length, 2, "the forgery never reaches the insert");
    assert.deepEqual(ins[0].params.slice(0, 4), ["plaid", "TRANSACTIONS", "SYNC_UPDATES_AVAILABLE", "item-1"]);
    assert.match(ins[0].params[4], /^jwt:[0-9a-f]{64}$/);
    assert.ok(calls.some((c) => /SET status = \$2/.test(c.sql) && c.params[1] === "ignored"));
  });

  it("Teller: a fresh signature on the same event id is still one event", async () => {
    calls = [];
    const send = (hdr) => supertest(app()).post("/api/webhooks/teller")
      .set("Content-Type", "application/json").set("Teller-Signature", hdr).send(TELLER_BODY);
    await send(tellerSig(TELLER_BODY)).expect(200);
    const again = await send(tellerSig(TELLER_BODY, { t: Math.floor(Date.now() / 1000) - 1 })).expect(200);
    assert.equal(again.body.duplicate, true);
    const orig = console.warn; console.warn = () => {};
    try { await send(tellerSig(TELLER_BODY, { secret: "forged" })).expect(401); } finally { console.warn = orig; }
    const ins = calls.filter((c) => /INSERT INTO webhook_events/.test(c.sql));
    assert.deepEqual(ins[0].params, ["teller", "enrollment.disconnected", null, "enr_1", "evt:wh_123"]);
  });
});
