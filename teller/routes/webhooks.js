// ============================================================================
// Bank webhook receivers (roadmap T2.1, W1)
// ============================================================================
// POST /api/webhooks/plaid and POST /api/webhooks/teller. Plaid and Teller call
// these directly, so they carry no shell cookie and no x-api-key: each request
// authenticates ITSELF with the provider's signature (the shell lets exactly
// these two method + path pairs through — isSelfAuthenticatingRoute). They are
// mounted in server.js BEFORE the session, auth, CSRF, API-key and activity
// middleware, so a webhook never counts as user activity (the Neon idle-gate).
//
// The pipeline, per request:
//   1. a body is required (400) and capped at MAX_BODY_BYTES (413);
//   2. the provider's verifier must be configured — otherwise 503, nothing
//      recorded;
//   3. the signature must verify — otherwise 401 with a fixed message
//      (failures per IP are rate-limited);
//   4. the event is recorded in webhook_events under a provider-supplied
//      dedupe key — a replay / re-delivery is answered 200 and not processed
//      again;
//   5. the route answers 200 at once and the handler runs detached (Plaid and
//      Teller time out quickly; a sync can take a minute). Its outcome is
//      written to the row (done / failed with a fixed error / ignored).
//
// The request body is never stored and never logged — a Teller payload can
// carry transactions, and Render's logs are not private.
//
// Verifiers (W2, services/webhook-verify.js): Plaid's ES256 JWT — "configured"
// once Plaid credentials are set; Teller's HMAC — once TELLER_WEBHOOK_SECRET is
// set. A provider without them answers 503.
//
// Handlers (W3–W5): a Plaid SYNC_UPDATES_AVAILABLE syncs that item (W3); other
// events are recorded and marked 'ignored' until W4 (Plaid item events) and W5
// (Teller).
// ============================================================================
const express = require("express");
const rateLimit = require("express-rate-limit");
const { pool } = require("../services/database");
const { createPlaidVerifier, createTellerVerifier } = require("../services/webhook-verify");

const PROVIDERS = ["plaid", "teller"];
// Plaid's and Teller's webhook bodies are small; a transactions.processed
// event lists a day's rows. Anything bigger is not a real delivery.
const MAX_BODY_BYTES = 512 * 1024;
const RETENTION_DAYS = 30;
const PRUNE_EVERY_MS = 24 * 60 * 60 * 1000;
const FAILED_VERIFY_LIMIT = 20; // per IP per 15 minutes

// A verifier: { configured() → bool, verify(req) → Promise<{ ok, event?, dedupeKey? }> }
// where event = { type, code, subject } (short provider fields, never the body).
const notConfigured = { configured: () => false, verify: async () => ({ ok: false }) };
const DEFAULT_VERIFIERS = { plaid: createPlaidVerifier(), teller: createTellerVerifier() };

// Handlers: provider → async (event, ctx) → { status: 'done' | 'ignored' }.
// Plaid (W3): SYNC_UPDATES_AVAILABLE syncs that item (routes/plaid-webhook-
// events.js, required lazily so this module loads without the sync code).
// Teller comes with W5 — its events are recorded and 'ignored'.
const DEFAULT_HANDLERS = {
  plaid: (event, ctx) => require("./plaid-webhook-events").handlePlaidEvent(event, ctx),
};

const clip = (v, n) => (v == null ? null : String(v).slice(0, n));

function createWebhookRouter({
  verifiers = DEFAULT_VERIFIERS,
  handlers = DEFAULT_HANDLERS,
  db = pool,
  defer = (fn) => setImmediate(fn),
  now = () => Date.now(),
} = {}) {
  const router = express.Router();
  let lastPruneAt = 0;

  // Counts only failed verifications (401) — a provider's normal traffic,
  // a 503 while unconfigured and duplicates never use up the allowance.
  const failedVerifyLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: FAILED_VERIFY_LIMIT,
    skipSuccessfulRequests: true,
    requestWasSuccessful: (_req, res) => res.statusCode !== 401,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: "Too many failed webhook verifications." },
  });

  async function pruneOld() {
    if (now() - lastPruneAt < PRUNE_EVERY_MS) return;
    lastPruneAt = now();
    try {
      await db.query(
        "DELETE FROM webhook_events WHERE received_at < now() - make_interval(days => $1)",
        [RETENTION_DAYS]
      );
    } catch (err) {
      console.error("webhook_events prune error:", err.message);
    }
  }

  async function finish(id, status, error = null) {
    try {
      await db.query(
        "UPDATE webhook_events SET status = $2, error = $3, processed_at = now() WHERE id = $1",
        [id, status, error]
      );
    } catch (err) {
      console.error("webhook_events status update error:", err.message);
    }
  }

  async function processEvent(id, provider, event) {
    const handler = handlers[provider];
    if (!handler) return finish(id, "ignored");
    try {
      await db.query("UPDATE webhook_events SET status = 'processing' WHERE id = $1", [id]);
      const r = await handler(event, { id, provider });
      await finish(id, r && r.status === "ignored" ? "ignored" : "done");
    } catch (err) {
      // The handler's message stays in the server log; the row gets a fixed
      // sentence (it is shown in Sync Health — W6).
      console.error(`webhook ${provider} ${event.type || "?"}/${event.code || "?"} handler error:`, err.message);
      await finish(id, "failed", "The event's sync failed — see the server log.");
    }
  }

  router.post("/api/webhooks/:provider", failedVerifyLimiter, async (req, res) => {
    const provider = req.params.provider;
    if (!PROVIDERS.includes(provider)) return res.status(404).json({ error: "Unknown webhook." });

    const raw = req.rawBody;
    if (!raw || !raw.length) return res.status(400).json({ error: "A JSON body is required." });
    if (raw.length > MAX_BODY_BYTES) return res.status(413).json({ error: "Body too large." });

    const verifier = verifiers[provider] || notConfigured;
    if (!verifier.configured()) {
      return res.status(503).json({ error: "Webhooks are not configured for this provider." });
    }

    let result;
    try {
      result = await verifier.verify(req);
    } catch (err) {
      console.warn(`webhook ${provider} verification error:`, err.message);
      result = { ok: false };
    }
    if (!result || !result.ok || !result.dedupeKey) {
      // console.warn, not console.error: an unsigned request from the internet
      // is not a server error and must not fill the in-app error log.
      console.warn(`webhook ${provider} rejected: signature verification failed`);
      return res.status(401).json({ error: "Signature verification failed." });
    }

    const event = result.event || {};
    let id = null;
    try {
      const ins = await db.query(
        `INSERT INTO webhook_events (provider, event_type, event_code, subject, dedupe_key)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (provider, dedupe_key) DO NOTHING
         RETURNING id`,
        [provider, clip(event.type, 100), clip(event.code, 100), clip(event.subject, 200), clip(result.dedupeKey, 200)]
      );
      if (!ins.rows.length) return res.json({ ok: true, duplicate: true });
      id = ins.rows[0].id;
    } catch (err) {
      // Not recorded → not acknowledged: the provider may retry, and the daily
      // sync is the backstop either way.
      console.error(`webhook ${provider} record error:`, err.message);
      return res.status(500).json({ error: "Could not record the event." });
    }

    res.json({ ok: true });
    defer(() => {
      processEvent(id, provider, event)
        .catch((err) => console.error(`webhook ${provider} processing error:`, err.message));
      pruneOld().catch((err) => console.error("webhook_events prune error:", err.message));
    });
  });

  return router;
}

module.exports = createWebhookRouter();
// Attached AFTER module.exports = router (INV-19).
module.exports.createWebhookRouter = createWebhookRouter;
module.exports.MAX_BODY_BYTES = MAX_BODY_BYTES;
module.exports.RETENTION_DAYS = RETENTION_DAYS;
module.exports.WEBHOOK_PATHS = PROVIDERS.map((p) => `/api/webhooks/${p}`);
