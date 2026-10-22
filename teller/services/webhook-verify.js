// ============================================================================
// Bank webhook signature verification (roadmap T2.1, W2)
// ============================================================================
// Each verifier is { configured() → bool, verify(req) → Promise<{ ok, event?,
// dedupeKey? }> }, used by routes/webhooks.js. verify() reads req.rawBody (the
// exact bytes received — the shell's JSON parser keeps them), req.headers and
// the parsed req.body. A verifier never logs the body; on any doubt it returns
// { ok: false } (the router answers 401). event carries only short provider
// fields: { type, code, subject } (+ Plaid's error_code — W4).
//
// Plaid — the `Plaid-Verification` header is an ES256 JWT:
//   - alg must be ES256 (anything else, including "none", is refused);
//   - the signing key is fetched by the JWT's kid with
//     /webhook_verification_key/get and cached; a key whose expired_at is set
//     is refused;
//   - iat must be within MAX_AGE_MS (a little clock skew allowed ahead);
//   - request_body_sha256 must equal the SHA-256 of the raw body.
//   Plaid deliveries carry no event id, and its SYNC_UPDATES_AVAILABLE body is
//   identical every time for an item, so the dedupe key is a hash of the JWT —
//   one per signed delivery (a replay of the same request is recorded once).
//
// Teller — the `Teller-Signature` header is "t=<unix seconds>,v1=<sig>[,v1=…]":
//   HMAC-SHA256 with the webhook signing secret over "<t>.<raw body>", hex. Every
//   v1 is tried against every secret in TELLER_WEBHOOK_SECRET (comma-separated,
//   so a rotation can overlap), compared as fixed-length digests (INV-104).
//   t must be within MAX_AGE_MS. The dedupe key is Teller's event id.
//   NOTE: this format is from Teller's documentation as known when written; it
//   could not be re-checked from the build environment. Confirm it against
//   https://teller.io/docs/api/webhooks before switching Teller webhooks on
//   (a Teller "webhook.test" event is the end-to-end check).
// ============================================================================
const crypto = require("crypto");

const MAX_AGE_MS = 5 * 60 * 1000;
const MAX_SKEW_MS = 60 * 1000; // a timestamp this far in the future is still accepted
const KEY_CACHE_MS = 24 * 60 * 60 * 1000;

const sha256 = (v) => crypto.createHash("sha256").update(v).digest();
const sha256Hex = (v) => crypto.createHash("sha256").update(v).digest("hex");
// Fixed-length compare: both sides hashed first, so differing lengths never
// throw and never leak through timing (INV-104).
const safeEqual = (a, b) => crypto.timingSafeEqual(sha256(String(a)), sha256(String(b)));

function b64urlJson(part) {
  return JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
}

function withinWindow(tsMs, nowMs) {
  return Number.isFinite(tsMs) && tsMs <= nowMs + MAX_SKEW_MS && nowMs - tsMs <= MAX_AGE_MS;
}

const clip = (v, n) => (v == null || v === "" ? null : String(v).slice(0, n));

// ---------------------------------------------------------------------------
// Plaid
// ---------------------------------------------------------------------------
function createPlaidVerifier({
  getClient = () => require("./plaid-client").getPlaidClient(),
  now = () => Date.now(),
} = {}) {
  const keys = new Map(); // kid → { key, fetchedAt }

  async function keyFor(kid) {
    const hit = keys.get(kid);
    if (hit && now() - hit.fetchedAt < KEY_CACHE_MS && hit.key.expired_at == null) return hit.key;
    const client = getClient();
    if (!client) return null;
    const res = await client.webhookVerificationKeyGet({ key_id: kid });
    const key = res && res.data && res.data.key;
    if (!key) return null;
    keys.set(kid, { key, fetchedAt: now() });
    return key;
  }

  return {
    configured: () => !!getClient(),
    async verify(req) {
      const token = req.headers["plaid-verification"];
      if (typeof token !== "string" || token.length > 4096) return { ok: false };
      const parts = token.split(".");
      if (parts.length !== 3) return { ok: false };
      let header, claims;
      try { header = b64urlJson(parts[0]); claims = b64urlJson(parts[1]); } catch { return { ok: false }; }
      if (!header || header.alg !== "ES256" || typeof header.kid !== "string" || !header.kid) return { ok: false };

      const key = await keyFor(header.kid);
      if (!key || key.expired_at != null) return { ok: false };
      let publicKey;
      try {
        publicKey = crypto.createPublicKey({ key: { kty: key.kty, crv: key.crv, x: key.x, y: key.y }, format: "jwk" });
      } catch { return { ok: false }; }
      const signed = Buffer.from(`${parts[0]}.${parts[1]}`);
      const signature = Buffer.from(parts[2], "base64url");
      const valid = crypto.verify("sha256", signed, { key: publicKey, dsaEncoding: "ieee-p1363" }, signature);
      if (!valid) return { ok: false };

      if (!claims || !withinWindow(Number(claims.iat) * 1000, now())) return { ok: false };
      if (!req.rawBody || typeof claims.request_body_sha256 !== "string") return { ok: false };
      if (!safeEqual(sha256Hex(req.rawBody), claims.request_body_sha256)) return { ok: false };

      const body = req.body || {};
      return {
        ok: true,
        dedupeKey: "jwt:" + sha256Hex(token),
        // error_code: an ITEM / ERROR (or USER_PERMISSION_REVOKED) event's
        // Plaid error code — the only field of its error object the handler reads.
        event: {
          type: clip(body.webhook_type, 100), code: clip(body.webhook_code, 100), subject: clip(body.item_id, 200),
          error_code: clip(body.error && typeof body.error === "object" ? body.error.error_code : null, 100),
        },
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Teller
// ---------------------------------------------------------------------------
function parseTellerSignature(value) {
  if (typeof value !== "string" || value.length > 4096) return null;
  let t = null;
  const sigs = [];
  for (const part of value.split(",")) {
    const i = part.indexOf("=");
    if (i < 1) continue;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    if (k === "t") t = v;
    else if (k === "v1" && v) sigs.push(v);
  }
  if (!t || !/^\d{1,12}$/.test(t) || !sigs.length) return null;
  return { t, sigs };
}

function tellerSecrets(env = process.env) {
  return String(env.TELLER_WEBHOOK_SECRET || "").split(",").map((s) => s.trim()).filter(Boolean);
}

function createTellerVerifier({ secrets = () => tellerSecrets(), now = () => Date.now() } = {}) {
  return {
    configured: () => secrets().length > 0,
    async verify(req) {
      const sig = parseTellerSignature(req.headers["teller-signature"]);
      if (!sig || !req.rawBody) return { ok: false };
      if (!withinWindow(Number(sig.t) * 1000, now())) return { ok: false };
      const signed = Buffer.concat([Buffer.from(sig.t + "."), req.rawBody]);
      let match = false;
      for (const secret of secrets()) {
        const expected = crypto.createHmac("sha256", secret).update(signed).digest("hex");
        // Every candidate is compared (no early exit) — the loop's timing
        // doesn't reveal which secret or signature matched.
        for (const s of sig.sigs) if (safeEqual(s.toLowerCase(), expected)) match = true;
      }
      if (!match) return { ok: false };

      const body = req.body || {};
      const payload = body.payload && typeof body.payload === "object" ? body.payload : {};
      // Teller events carry an id; a signed delivery without one is still
      // deduplicated per signature.
      const dedupeKey = typeof body.id === "string" && body.id
        ? "evt:" + body.id.slice(0, 180)
        : "sig:" + sha256Hex(sig.t + "." + sig.sigs.join(","));
      return {
        ok: true,
        dedupeKey,
        event: { type: clip(body.type, 100), code: null, subject: clip(payload.enrollment_id, 200) },
      };
    },
  };
}

module.exports = {
  createPlaidVerifier,
  createTellerVerifier,
  parseTellerSignature,
  tellerSecrets,
  MAX_AGE_MS,
};
