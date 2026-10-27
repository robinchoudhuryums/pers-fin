// Real-Postgres contract tests for roadmap T2.1 W2 (webhook verification), the
// PRODUCTION router mounted in server.js order with a stubbed Plaid client and a
// Teller signing secret:
//  - a signed Plaid event is recorded once ('ignored' — no handler yet) under a
//    JWT-hash key; replaying the same signed request adds no row
//  - a forged Plaid body and a Teller event signed with the wrong secret are
//    401s that write nothing
//  - a Teller event re-signed with a new timestamp is still one row (event id)
const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const express = require("express");
const supertest = require("supertest");
const { SKIP, perfinDb, perfinApp } = require("./_setup");

const KID = "kid-c";
const { privateKey, publicKey } = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
const jwk = publicKey.export({ format: "jwk" });
const b64u = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
function plaidJwt(body) {
  const h = b64u({ alg: "ES256", kid: KID, typ: "JWT" });
  const p = b64u({ iat: Math.floor(Date.now() / 1000), request_body_sha256: crypto.createHash("sha256").update(body).digest("hex") });
  return `${h}.${p}.${crypto.sign("sha256", Buffer.from(`${h}.${p}`), { key: privateKey, dsaEncoding: "ieee-p1363" }).toString("base64url")}`;
}
const SECRET = "contract-teller-secret";
const tellerSig = (raw, secret = SECRET, t = Math.floor(Date.now() / 1000)) =>
  `t=${t},v1=${crypto.createHmac("sha256", secret).update(`${t}.${raw}`).digest("hex")}`;

describe("Webhooks W2 on real Postgres", { skip: SKIP }, () => {
  let pool, app, realGet, savedSecret;
  const q = (s, p) => pool.query(s, p);
  const rows = (provider) => q("SELECT event_type, event_code, subject, dedupe_key, status FROM webhook_events WHERE provider = $1 ORDER BY id", [provider]).then((r) => r.rows);
  const settle = () => new Promise((r) => setTimeout(r, 50));
  const quiet = async (fn) => { const w = console.warn; console.warn = () => {}; try { return await fn(); } finally { console.warn = w; } };

  before(async () => {
    pool = await perfinDb("webhooks_w2");
    const plaidClient = require("../../teller/services/plaid-client");
    realGet = plaidClient.getPlaidClient;
    plaidClient.getPlaidClient = () => ({
      webhookVerificationKeyGet: async () => ({ data: { key: { ...jwk, alg: "ES256", kid: KID, use: "sig", created_at: 1, expired_at: null } } }),
    });
    savedSecret = process.env.TELLER_WEBHOOK_SECRET;
    process.env.TELLER_WEBHOOK_SECRET = SECRET;
    delete require.cache[require.resolve("../../teller/routes/webhooks")];
    app = express();
    app.use(express.json({ verify: (req, _res, buf) => { req.rawBody = buf; } }));
    app.use(perfinApp());
  });
  after(async () => {
    require("../../teller/services/plaid-client").getPlaidClient = realGet;
    if (savedSecret === undefined) delete process.env.TELLER_WEBHOOK_SECRET; else process.env.TELLER_WEBHOOK_SECRET = savedSecret;
    if (pool) await pool.end();
  });

  it("Plaid: a signed event is recorded once; a replay and a forgery add nothing", async () => {
    const raw = JSON.stringify({ webhook_type: "TRANSACTIONS", webhook_code: "SYNC_UPDATES_AVAILABLE", item_id: "item-c" });
    const token = plaidJwt(raw);
    const post = (body, tok) => supertest(app).post("/api/webhooks/plaid").set("Content-Type", "application/json").set("Plaid-Verification", tok).send(body);
    await post(raw, token).expect(200);
    await settle();
    await post(raw, token).expect(200);
    await quiet(() => post(raw.replace("item-c", "item-x"), token).expect(401));
    const r = await rows("plaid");
    assert.equal(r.length, 1);
    assert.deepEqual([r[0].event_type, r[0].event_code, r[0].subject, r[0].status], ["TRANSACTIONS", "SYNC_UPDATES_AVAILABLE", "item-c", "ignored"]);
    assert.match(r[0].dedupe_key, /^jwt:[0-9a-f]{64}$/);
  });

  it("Teller: one row per event id; a wrong-secret signature writes nothing", async () => {
    const raw = JSON.stringify({ id: "wh_contract", type: "transactions.processed", payload: { enrollment_id: "enr_c", transactions: [] } });
    const post = (hdr) => supertest(app).post("/api/webhooks/teller").set("Content-Type", "application/json").set("Teller-Signature", hdr).send(raw);
    await post(tellerSig(raw)).expect(200);
    await settle();
    const again = await post(tellerSig(raw, SECRET, Math.floor(Date.now() / 1000) - 2)).expect(200);
    assert.equal(again.body.duplicate, true);
    await quiet(() => post(tellerSig(raw, "wrong")).expect(401));
    const r = await rows("teller");
    assert.deepEqual(r.map((x) => [x.event_type, x.subject, x.dedupe_key, x.status]),
      [["transactions.processed", "enr_c", "evt:wh_contract", "ignored"]]);
  });
});
