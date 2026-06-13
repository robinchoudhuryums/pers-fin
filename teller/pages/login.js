const express = require("express");
const crypto = require("crypto");
const router = express.Router();
const { pool } = require("../services/database");

let simplewebauthn;
try {
  simplewebauthn = require("@simplewebauthn/server");
} catch {
  simplewebauthn = null;
}

module.exports = function(authConfig) {
  const { AUTH_MODE, AUTH_SECRET, SESSION_PASSWORD, SESSION_PIN } = authConfig;

  // Derive WebAuthn RP ID and origin from the current request every time,
  // not from a module-scoped latch. The old approach stored the first
  // request's hostname and reused it forever — behind a reverse proxy with
  // multiple hostnames this silently broke for everyone after the first user.
  function getRp(req) {
    const id = req.hostname;
    const origin = `${req.protocol}://${req.hostname}${req.hostname === "localhost" ? ":" + (process.env.PORT || 3000) : ""}`;
    return { id, origin };
  }

router.get("/login", async (_req, res) => {
  if (!AUTH_SECRET) return res.redirect("/dashboard");
  // Check if any WebAuthn credentials are registered
  let hasWebauthn = false;
  try {
    const result = await pool.query("SELECT COUNT(*) AS cnt FROM webauthn_credentials");
    hasWebauthn = parseInt(result.rows[0].cnt) > 0;
  } catch (err) { console.error("WebAuthn check error:", err.message); }
  res.render("login", { isPin: AUTH_MODE === "pin", authMode: AUTH_MODE, hasWebauthn });
});

// Helper: load configured session timeout (minutes) from user_settings, falling back to 15
async function loadSessionTimeout() {
  try {
    const r = await pool.query("SELECT session_timeout_minutes FROM user_settings WHERE id = 1");
    const v = r.rows[0]?.session_timeout_minutes;
    return Number.isFinite(parseInt(v)) ? parseInt(v) : 15;
  } catch {
    return 15;
  }
}

// POST /api/login
router.post("/api/login", async (req, res) => {
  if (!AUTH_SECRET) return res.json({ ok: true });
  const { password } = req.body;
  if (!password) return res.status(400).json({ error: (AUTH_MODE === "pin" ? "PIN" : "Password") + " required" });
  const providedBuf = Buffer.from(password);
  const expectedBuf = Buffer.from(AUTH_SECRET);
  if (providedBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(providedBuf, expectedBuf)) {
    return res.status(401).json({ error: AUTH_MODE === "pin" ? "Invalid PIN" : "Invalid password" });
  }
  req.session.authenticated = true;
  req.session.lastActivity = Date.now();
  req.session.timeoutMinutes = await loadSessionTimeout();
  res.json({ ok: true });
});

// POST /api/logout
router.post("/api/logout", (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

// ---------------------------------------------------------------------------
// WebAuthn (FaceID / Biometric) Registration
// ---------------------------------------------------------------------------

// POST /api/webauthn/register-options — generate registration challenge
// (requires an authenticated session — user must be logged in to set up
// biometrics. Under the unified shell, the shell's PIN gate authenticated the
// request before it ever reached this sub-app and Perfin's own session is
// never written, so `embedded` is the auth signal — without this check,
// registration always 401'd "Must be logged in" for shell users, INV-25.)
router.post("/api/webauthn/register-options", async (req, res) => {
  if (!simplewebauthn) return res.status(501).json({ error: "WebAuthn not available" });
  if (!req.app.get("embedded") && (!req.session || !req.session.authenticated)) {
    return res.status(401).json({ error: "Must be logged in to register biometric" });
  }
  try {
    const rp = getRp(req);
    // Get existing credentials to exclude
    const existing = await pool.query("SELECT credential_id FROM webauthn_credentials");
    const excludeCredentials = existing.rows.map(r => ({
      id: r.credential_id,
      type: "public-key",
    }));

    const options = await simplewebauthn.generateRegistrationOptions({
      rpName: "Perfin",
      rpID: rp.id,
      userName: "perfin-user",
      userDisplayName: "Perfin User",
      attestationType: "none",
      authenticatorSelection: {
        authenticatorAttachment: "platform",
        userVerification: "required",
        residentKey: "preferred",
      },
      excludeCredentials,
    });

    // Store challenge in session for verification
    req.session.webauthnChallenge = options.challenge;
    res.json(options);
  } catch (err) {
    console.error("WebAuthn register-options error:", err.message);
    res.status(500).json({ error: "An internal error occurred." });
  }
});

// POST /api/webauthn/register — verify registration and store credential
router.post("/api/webauthn/register", async (req, res) => {
  if (!simplewebauthn) return res.status(501).json({ error: "WebAuthn not available" });
  // Same embedded-mode bail as register-options (INV-25).
  if (!req.app.get("embedded") && (!req.session || !req.session.authenticated)) {
    return res.status(401).json({ error: "Must be logged in to register biometric" });
  }
  const challenge = req.session.webauthnChallenge;
  if (!challenge) return res.status(400).json({ error: "No registration challenge found" });

  try {
    const rp = getRp(req);
    const verification = await simplewebauthn.verifyRegistrationResponse({
      response: req.body,
      expectedChallenge: challenge,
      expectedOrigin: rp.origin,
      expectedRPID: rp.id,
    });

    if (!verification.verified || !verification.registrationInfo) {
      return res.status(400).json({ error: "Verification failed" });
    }

    const { credential, credentialDeviceType } = verification.registrationInfo;
    const credentialIdBase64 = Buffer.from(credential.id).toString("base64url");
    const publicKeyBase64 = Buffer.from(credential.publicKey).toString("base64url");

    const deviceName = (req.body.deviceName || credentialDeviceType || "Biometric Device").slice(0, 100);
    // Persist the authenticator's transports (e.g. ['internal','hybrid']).
    // They must be echoed back in allowCredentials at login time or browsers
    // assume a roaming key and offer only QR-code / USB options.
    const transports = Array.isArray(credential.transports) && credential.transports.length
      ? credential.transports.map(String).slice(0, 8)
      : (Array.isArray(req.body.response && req.body.response.transports)
          ? req.body.response.transports.map(String).slice(0, 8)
          : null);

    await pool.query(
      `INSERT INTO webauthn_credentials (credential_id, public_key, counter, device_name, transports)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (credential_id) DO UPDATE SET public_key = $2, counter = $3, device_name = $4, transports = $5`,
      [credentialIdBase64, publicKeyBase64, credential.counter, deviceName, transports]
    );

    delete req.session.webauthnChallenge;
    res.json({ ok: true, device: deviceName });
  } catch (err) {
    console.error("WebAuthn register error:", err.message);
    res.status(500).json({ error: "An internal error occurred." });
  }
});

// ---------------------------------------------------------------------------
// WebAuthn (FaceID / Biometric) Authentication
// ---------------------------------------------------------------------------
// NOTE: Reachable in standalone mode only. Under the unified shell, the shell's
// PIN gate runs before any /perfin/* request reaches these handlers, so the
// browser can't initiate a biometric flow without first completing PIN auth.
// The shell login page is plain PIN-only HTML. Wiring biometric login into the
// shell requires shell-side WebAuthn endpoints + login UI; until that's built,
// embedded deployments use PIN exclusively.

// POST /api/webauthn/authenticate-options — generate auth challenge (no session needed)
//   Standalone-only entry point — see note above.
router.post("/api/webauthn/authenticate-options", async (req, res) => {
  if (!simplewebauthn) return res.status(501).json({ error: "WebAuthn not available" });
  try {
    const rp = getRp(req);
    const creds = await pool.query("SELECT credential_id FROM webauthn_credentials");
    if (creds.rows.length === 0) {
      return res.status(404).json({ error: "No biometric credentials registered" });
    }

    // Advertise ONLY the internal (platform) transport. Registration pins
    // authenticatorAttachment:'platform', so every stored credential lives on
    // THIS device. Echoing the authenticator's 'hybrid' transport (which iCloud/
    // synced passkeys report) is exactly what made browsers surface the
    // cross-device "use a phone" QR option instead of going straight to Touch/
    // Face ID. Internal-only suppresses that QR path. (The real transports are
    // still persisted at registration; they're just not used as the login hint.)
    const allowCredentials = creds.rows.map(r => ({
      id: r.credential_id,
      type: "public-key",
      transports: ["internal"],
    }));

    const options = await simplewebauthn.generateAuthenticationOptions({
      rpID: rp.id,
      allowCredentials,
      userVerification: "required",
    });

    // Store challenge in session
    if (!req.session) return res.status(500).json({ error: "Session not available" });
    req.session.webauthnChallenge = options.challenge;
    res.json(options);
  } catch (err) {
    console.error("WebAuthn authenticate-options error:", err.message);
    res.status(500).json({ error: "An internal error occurred." });
  }
});

// POST /api/webauthn/authenticate — verify biometric and create session
router.post("/api/webauthn/authenticate", async (req, res) => {
  if (!simplewebauthn) return res.status(501).json({ error: "WebAuthn not available" });
  const challenge = req.session?.webauthnChallenge;
  if (!challenge) return res.status(400).json({ error: "No authentication challenge found" });

  try {
    const rp = getRp(req);
    // Look up the credential
    const credIdFromBody = req.body.id;
    const credRow = await pool.query(
      "SELECT * FROM webauthn_credentials WHERE credential_id = $1",
      [credIdFromBody]
    );
    if (credRow.rows.length === 0) {
      return res.status(400).json({ error: "Unknown credential" });
    }
    const storedCred = credRow.rows[0];

    const verification = await simplewebauthn.verifyAuthenticationResponse({
      response: req.body,
      expectedChallenge: challenge,
      expectedOrigin: rp.origin,
      expectedRPID: rp.id,
      credential: {
        id: storedCred.credential_id,
        publicKey: Buffer.from(storedCred.public_key, "base64url"),
        counter: parseInt(storedCred.counter),
      },
    });

    if (!verification.verified) {
      return res.status(401).json({ error: "Biometric verification failed" });
    }

    // Update counter
    await pool.query(
      "UPDATE webauthn_credentials SET counter = $1 WHERE credential_id = $2",
      [verification.authenticationInfo.newCounter, storedCred.credential_id]
    );

    // Create authenticated session
    delete req.session.webauthnChallenge;
    req.session.authenticated = true;
    req.session.lastActivity = Date.now();
    req.session.timeoutMinutes = await loadSessionTimeout();
    res.json({ ok: true });
  } catch (err) {
    console.error("WebAuthn authenticate error:", err.message);
    res.status(500).json({ error: "An internal error occurred." });
  }
});

// GET /api/webauthn/credentials — list registered credentials (authenticated only)
router.get("/api/webauthn/credentials", async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT id, device_name, created_at FROM webauthn_credentials ORDER BY created_at DESC"
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: "An internal error occurred." });
  }
});

// DELETE /api/webauthn/credentials/:id — remove a credential (authenticated only)
router.delete("/api/webauthn/credentials/:id", async (req, res) => {
  try {
    await pool.query("DELETE FROM webauthn_credentials WHERE id = $1", [req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: "An internal error occurred." });
  }
});

  return router;
};
