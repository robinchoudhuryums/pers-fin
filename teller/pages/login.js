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

  // Derive RP ID and origin from request on first use
  let rpID = null;
  let rpOrigin = null;

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

// POST /api/login
router.post("/api/login", (req, res) => {
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
  req.session.timeoutMinutes = 15;
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
// (requires authenticated session — user must be logged in to set up biometrics)
router.post("/api/webauthn/register-options", async (req, res) => {
  if (!simplewebauthn) return res.status(501).json({ error: "WebAuthn not available" });
  if (!req.session || !req.session.authenticated) {
    return res.status(401).json({ error: "Must be logged in to register biometric" });
  }
  try {
    if (!rpID) {
      rpID = req.hostname;
      rpOrigin = `${req.protocol}://${req.hostname}${req.hostname === "localhost" ? ":" + (process.env.PORT || 3000) : ""}`;
    }
    // Get existing credentials to exclude
    const existing = await pool.query("SELECT credential_id FROM webauthn_credentials");
    const excludeCredentials = existing.rows.map(r => ({
      id: r.credential_id,
      type: "public-key",
    }));

    const options = await simplewebauthn.generateRegistrationOptions({
      rpName: "Perfin",
      rpID,
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
  if (!req.session || !req.session.authenticated) {
    return res.status(401).json({ error: "Must be logged in to register biometric" });
  }
  const challenge = req.session.webauthnChallenge;
  if (!challenge) return res.status(400).json({ error: "No registration challenge found" });

  try {
    if (!rpID) {
      rpID = req.hostname;
      rpOrigin = `${req.protocol}://${req.hostname}${req.hostname === "localhost" ? ":" + (process.env.PORT || 3000) : ""}`;
    }
    const verification = await simplewebauthn.verifyRegistrationResponse({
      response: req.body,
      expectedChallenge: challenge,
      expectedOrigin: rpOrigin,
      expectedRPID: rpID,
    });

    if (!verification.verified || !verification.registrationInfo) {
      return res.status(400).json({ error: "Verification failed" });
    }

    const { credential, credentialDeviceType } = verification.registrationInfo;
    const credentialIdBase64 = Buffer.from(credential.id).toString("base64url");
    const publicKeyBase64 = Buffer.from(credential.publicKey).toString("base64url");

    const deviceName = (req.body.deviceName || credentialDeviceType || "Biometric Device").slice(0, 100);

    await pool.query(
      `INSERT INTO webauthn_credentials (credential_id, public_key, counter, device_name)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (credential_id) DO UPDATE SET public_key = $2, counter = $3, device_name = $4`,
      [credentialIdBase64, publicKeyBase64, credential.counter, deviceName]
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

// POST /api/webauthn/authenticate-options — generate auth challenge (no session needed)
router.post("/api/webauthn/authenticate-options", async (req, res) => {
  if (!simplewebauthn) return res.status(501).json({ error: "WebAuthn not available" });
  try {
    if (!rpID) {
      rpID = req.hostname;
      rpOrigin = `${req.protocol}://${req.hostname}${req.hostname === "localhost" ? ":" + (process.env.PORT || 3000) : ""}`;
    }
    const creds = await pool.query("SELECT credential_id FROM webauthn_credentials");
    if (creds.rows.length === 0) {
      return res.status(404).json({ error: "No biometric credentials registered" });
    }

    const allowCredentials = creds.rows.map(r => ({
      id: r.credential_id,
      type: "public-key",
    }));

    const options = await simplewebauthn.generateAuthenticationOptions({
      rpID,
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
    if (!rpID) {
      rpID = req.hostname;
      rpOrigin = `${req.protocol}://${req.hostname}${req.hostname === "localhost" ? ":" + (process.env.PORT || 3000) : ""}`;
    }
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
      expectedOrigin: rpOrigin,
      expectedRPID: rpID,
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
    req.session.timeoutMinutes = 15;
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
