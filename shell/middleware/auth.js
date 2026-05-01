// ============================================================================
// Shell auth — PIN check + signed session cookie
// ============================================================================
// Stateless: the cookie carries an expiration timestamp signed with
// SHELL_SECRET. No DB needed. Rotating SHELL_SECRET invalidates every
// active session; rotating SHELL_PIN does not (since PIN isn't in the
// cookie).
//
// Why constant-time compare even for a 4-digit PIN: a fast string compare
// can leak the matching prefix length under a timing attack. The PIN is a
// short fixed-length secret on a public endpoint, so we should still do
// the safe thing.

const crypto = require("crypto");

const COOKIE_NAME = "shell_session";
const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 7; // 7 days; tweak in env later
const FAIL_DELAY_MS = 750;                       // soft brute-force throttle

function sign(value) {
  if (!process.env.SHELL_SECRET) throw new Error("SHELL_SECRET not set");
  const mac = crypto.createHmac("sha256", process.env.SHELL_SECRET)
    .update(value).digest("hex");
  return value + "." + mac;
}

function verify(signed) {
  if (!signed || !process.env.SHELL_SECRET) return null;
  const idx = signed.lastIndexOf(".");
  if (idx < 0) return null;
  const value = signed.slice(0, idx);
  const expected = crypto.createHmac("sha256", process.env.SHELL_SECRET)
    .update(value).digest();
  let actual;
  try { actual = Buffer.from(signed.slice(idx + 1), "hex"); }
  catch { return null; }
  if (actual.length !== expected.length) return null;
  if (!crypto.timingSafeEqual(actual, expected)) return null;
  return value;
}

function isValidSession(signed) {
  const value = verify(signed);
  if (!value) return false;
  const expires = parseInt(value, 10);
  return Number.isFinite(expires) && expires > Date.now();
}

function makeSession() {
  return sign(String(Date.now() + SESSION_TTL_MS));
}

function requireAuth(req, res, next) {
  if (isValidSession(req.cookies[COOKIE_NAME])) return next();
  // Browsers get a redirect, API clients get JSON. Sub-apps mounted past
  // this gate will inherit the same behavior automatically.
  if (req.method === "GET" && req.accepts("html")) return res.redirect("/login");
  res.status(401).json({ error: "Authentication required" });
}

function handleLogin(req, res) {
  const submitted = String(req.body.pin || "");
  const expected = process.env.SHELL_PIN || "";

  // Length-mismatch is itself information; pad before compare so we don't
  // leak the expected length via the early-exit branch.
  const expectedBuf = Buffer.from(expected || " ", "utf8");
  const submittedBuf = Buffer.from(
    submitted.padEnd(expectedBuf.length, " ").slice(0, expectedBuf.length),
    "utf8"
  );
  const matches =
    expected.length > 0 &&
    submitted.length === expected.length &&
    crypto.timingSafeEqual(submittedBuf, expectedBuf);

  if (!matches) {
    return setTimeout(
      () => res.status(401).render("login", { error: "Incorrect PIN." }),
      FAIL_DELAY_MS
    );
  }

  res.cookie(COOKIE_NAME, makeSession(), {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    maxAge: SESSION_TTL_MS,
    path: "/",
  });

  // Allow ?return_to=/perfin/today on the form so a redirected request
  // bounces back to where the user wanted to go after login.
  const target = req.body.return_to;
  res.redirect(typeof target === "string" && target.startsWith("/") ? target : "/");
}

function handleLogout(_req, res) {
  res.clearCookie(COOKIE_NAME, { path: "/" });
  res.redirect("/login");
}

module.exports = {
  COOKIE_NAME,
  SESSION_TTL_MS,
  isValidSession,
  makeSession,
  requireAuth,
  handleLogin,
  handleLogout,
};
