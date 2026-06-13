// ============================================================================
// Shell WebAuthn — biometric authentication for the unified-shell login page
// ============================================================================
// Wires the standalone Perfin /api/webauthn/* endpoints into the shell so
// users can authenticate via FaceID / TouchID / passkey without entering the
// PIN. Without this, the shell's PIN gate intercepts every /perfin/* request
// before it reaches Perfin's WebAuthn endpoints, making biometric login
// unreachable under the deployed shell.
//
// Architecture: the shell hosts the verify endpoints itself (mounted before
// requireAuth). It reads `webauthn_credentials` from Perfin's pg pool — the
// only table involved — and on successful verification, sets the shell's
// signed session cookie via auth.makeSession().
//
// Challenge storage is in-memory (Map keyed by a short-lived cookie). Single-
// process deployments are the default; multi-instance setups would need
// sticky sessions or a shared store.

const crypto = require("crypto");
const auth = require("./auth");

let simplewebauthn;
try {
  simplewebauthn = require("@simplewebauthn/server");
} catch {
  simplewebauthn = null;
}

const CHALLENGE_COOKIE = "shell_webauthn_chl";
const CHALLENGE_TTL_MS = 5 * 60 * 1000; // 5 min — plenty for a user to complete a prompt
const _challenges = new Map();
setInterval(() => {
  const cutoff = Date.now() - CHALLENGE_TTL_MS;
  for (const [k, v] of _challenges) if (v.ts < cutoff) _challenges.delete(k);
}, CHALLENGE_TTL_MS).unref();

// Derive WebAuthn RP ID and origin per-request from req.hostname so deployments
// behind proxies with multiple hostnames or DNS changes work correctly. Same
// rule the standalone /api/webauthn handler uses (teller/pages/login.js).
function getRp(req) {
  const id = req.hostname;
  const port = process.env.SHELL_PORT || process.env.PORT || 3000;
  const origin = `${req.protocol}://${req.hostname}${req.hostname === "localhost" ? ":" + port : ""}`;
  return { id, origin };
}

function attach(app, perfinPool) {
  if (!simplewebauthn || !perfinPool) return;

  // GET /api/shell/webauthn/available — does any credential exist?
  // Used by the login page to decide whether to render the biometric button.
  app.get("/api/shell/webauthn/available", async (_req, res) => {
    try {
      const r = await perfinPool.query("SELECT COUNT(*) AS cnt FROM webauthn_credentials");
      res.json({ available: parseInt(r.rows[0].cnt, 10) > 0 });
    } catch {
      res.json({ available: false });
    }
  });

  // POST /api/shell/webauthn/authenticate-options — generate auth challenge.
  // No prior session needed (biometric auth is the alternative to PIN entry).
  app.post("/api/shell/webauthn/authenticate-options", async (req, res) => {
    try {
      const creds = await perfinPool.query("SELECT credential_id FROM webauthn_credentials");
      if (creds.rows.length === 0) {
        return res.status(404).json({ error: "No biometric credentials registered" });
      }
      // Advertise ONLY the internal (platform) transport. Registration pins
      // authenticatorAttachment:'platform' (teller/pages/login.js), so every
      // stored credential lives on THIS device. Echoing the authenticator's
      // 'hybrid' transport (which iCloud/synced passkeys report) is exactly what
      // made browsers surface the cross-device "use a phone" QR option instead
      // of going straight to Touch/Face ID — internal-only suppresses that QR
      // path. (The real transports are still persisted at registration; they're
      // just not used as the login hint.)
      const allowCredentials = creds.rows.map(r => ({
        id: r.credential_id,
        type: "public-key",
        transports: ["internal"],
      }));
      const rp = getRp(req);
      const options = await simplewebauthn.generateAuthenticationOptions({
        rpID: rp.id,
        allowCredentials,
        userVerification: "required",
      });
      // Store challenge keyed by random cookie value so the verify step can
      // recover it without server-side state tied to a session id.
      const challengeKey = crypto.randomBytes(12).toString("hex");
      _challenges.set(challengeKey, { challenge: options.challenge, ts: Date.now() });
      res.cookie(CHALLENGE_COOKIE, challengeKey, {
        httpOnly: true,
        secure: process.env.NODE_ENV === "production",
        sameSite: "lax",
        maxAge: CHALLENGE_TTL_MS,
        path: "/",
      });
      res.json(options);
    } catch (err) {
      console.error("Shell WebAuthn auth-options error:", err.message);
      res.status(500).json({ error: "Authentication failed" });
    }
  });

  // POST /api/shell/webauthn/authenticate — verify response + set shell session.
  app.post("/api/shell/webauthn/authenticate", async (req, res) => {
    try {
      const challengeKey = req.cookies && req.cookies[CHALLENGE_COOKIE];
      const stored = challengeKey ? _challenges.get(challengeKey) : null;
      if (!stored) return res.status(400).json({ error: "No authentication challenge found" });
      // One-shot: delete BEFORE verify so a failed attempt can't be replayed.
      _challenges.delete(challengeKey);

      const credIdFromBody = req.body && req.body.id;
      if (!credIdFromBody) return res.status(400).json({ error: "Missing credential id" });
      const credRow = await perfinPool.query(
        "SELECT * FROM webauthn_credentials WHERE credential_id = $1",
        [credIdFromBody]
      );
      if (credRow.rows.length === 0) return res.status(400).json({ error: "Unknown credential" });
      const stored_cred = credRow.rows[0];

      const rp = getRp(req);
      const verification = await simplewebauthn.verifyAuthenticationResponse({
        response: req.body,
        expectedChallenge: stored.challenge,
        expectedOrigin: rp.origin,
        expectedRPID: rp.id,
        // Enforce that the authenticator actually performed user verification
        // (biometric / device PIN), matching the `userVerification: "required"`
        // we request in authenticate-options. @simplewebauthn/server v11 already
        // defaults this to true; pinning it explicitly keeps "biometric login"
        // genuinely biometric if a future SDK upgrade ever flips the default
        // (PSA2 — defense-in-depth, not a current gap).
        requireUserVerification: true,
        credential: {
          id: stored_cred.credential_id,
          publicKey: Buffer.from(stored_cred.public_key, "base64url"),
          counter: parseInt(stored_cred.counter, 10),
        },
      });

      if (!verification.verified) {
        return res.status(401).json({ error: "Biometric verification failed" });
      }

      // Bump the counter on the credential row so cloned authenticators are
      // detectable on later attempts (per WebAuthn spec recommendation).
      await perfinPool.query(
        "UPDATE webauthn_credentials SET counter = $1 WHERE credential_id = $2",
        [verification.authenticationInfo.newCounter, stored_cred.credential_id]
      );

      // Set the shell session cookie — same shape the PIN flow sets, including
      // the user-tunable shell_idle_timeout_minutes window. An earlier version
      // referenced an undefined auth.SESSION_TTL_MS and called makeSession()
      // with no idleMs, which produced a session-only cookie (cleared on
      // browser close) and ignored the Settings idle timeout.
      res.clearCookie(CHALLENGE_COOKIE, { path: "/" });
      const idleMs = await auth.getIdleMs();
      auth.setSessionCookie(res, idleMs);
      res.json({ ok: true });
    } catch (err) {
      console.error("Shell WebAuthn authenticate error:", err.message);
      res.status(500).json({ error: "Authentication failed" });
    }
  });
}

module.exports = { attach };
