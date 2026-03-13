const express = require("express");
const crypto = require("crypto");
const router = express.Router();

module.exports = function(authConfig) {
  const { AUTH_MODE, AUTH_SECRET, SESSION_PASSWORD, SESSION_PIN } = authConfig;
router.get("/login", (_req, res) => {
  if (!AUTH_SECRET) return res.redirect("/dashboard");
  res.render("login", { isPin: AUTH_MODE === "pin", authMode: AUTH_MODE });
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

  return router;
};
