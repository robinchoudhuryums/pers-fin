// ============================================================================
// Shell auth — PIN check + sliding-expiration session cookie
// ============================================================================
// Stateless: the cookie carries an expiration timestamp signed with
// SHELL_SECRET. No DB needed for the auth check itself — but the idle
// window length is read from Perfin's user_settings table (cached for 60s)
// so it can be tuned from the Settings page without a redeploy. Each
// authenticated request refreshes the cookie's expiration to (now + idleMs),
// so an active user never gets logged out mid-session, while an idle user
// is re-prompted after the configured window. Rotating SHELL_SECRET
// invalidates every active session; rotating SHELL_PIN does not (since PIN
// isn't in the cookie).
//
// Why constant-time compare even for a 4-digit PIN: a fast string compare
// can leak the matching prefix length under a timing attack. The PIN is a
// short fixed-length secret on a public endpoint, so we should still do
// the safe thing.

const crypto = require("crypto");

const COOKIE_NAME = "shell_session";
const DEFAULT_IDLE_MS = 60 * 60 * 1000;          // 60 min if DB lookup fails
const IDLE_CACHE_TTL_MS = 60 * 1000;             // re-read setting every 60s
const FAIL_DELAY_MS = 750;                       // soft brute-force throttle

// Pool pulled in via init() so the auth module isn't import-time coupled
// to Perfin's database setup. When unset (or DB unavailable) we fall back
// to DEFAULT_IDLE_MS — still a usable session, just non-tunable.
let _pool = null;
let _cachedIdleMs = DEFAULT_IDLE_MS;
let _cacheExpiresAt = 0;

function init({ pool } = {}) {
  _pool = pool || null;
  // Reset cache so the first request after init re-reads fresh.
  _cacheExpiresAt = 0;
}

function invalidateIdleCache() {
  _cacheExpiresAt = 0;
}

async function getIdleMs() {
  if (Date.now() < _cacheExpiresAt) return _cachedIdleMs;
  if (_pool) {
    try {
      const r = await _pool.query("SELECT shell_idle_timeout_minutes FROM user_settings WHERE id = 1");
      const min = r.rows.length ? Number(r.rows[0].shell_idle_timeout_minutes) : null;
      if (Number.isFinite(min) && min >= 5 && min <= 10080) {
        _cachedIdleMs = min * 60 * 1000;
      } else {
        _cachedIdleMs = DEFAULT_IDLE_MS;
      }
    } catch {
      _cachedIdleMs = DEFAULT_IDLE_MS;
    }
  } else {
    _cachedIdleMs = DEFAULT_IDLE_MS;
  }
  _cacheExpiresAt = Date.now() + IDLE_CACHE_TTL_MS;
  return _cachedIdleMs;
}

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

function makeSession(idleMs) {
  return sign(String(Date.now() + (idleMs || DEFAULT_IDLE_MS)));
}

function setSessionCookie(res, idleMs) {
  res.cookie(COOKIE_NAME, makeSession(idleMs), {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    maxAge: idleMs,
    path: "/",
  });
}

function isValidApiKey(req) {
  // Non-interactive clients (cron, CI workflows, etc.) authenticate with
  // x-api-key against the same API_KEY env var Perfin uses. Validated here
  // so the request can bypass the PIN cookie check entirely. Sub-apps see
  // req.app.get("embedded")=true and skip their own API_KEY enforcement,
  // trusting that the shell already verified.
  const expected = process.env.API_KEY;
  if (!expected) return false;
  const provided = req.headers["x-api-key"];
  if (!provided) return false;
  const providedBuf = Buffer.from(String(provided));
  const expectedBuf = Buffer.from(expected);
  if (providedBuf.length !== expectedBuf.length) return false;
  try { return crypto.timingSafeEqual(providedBuf, expectedBuf); } catch { return false; }
}

async function requireAuth(req, res, next) {
  // API key bypass for cron + CI. No cookie refresh — these aren't browser
  // sessions and the headers carry every time.
  if (isValidApiKey(req)) return next();

  if (!isValidSession(req.cookies[COOKIE_NAME])) {
    // Browsers get a redirect, API clients get JSON. Sub-apps mounted past
    // this gate will inherit the same behavior automatically.
    if (req.method === "GET" && req.accepts("html")) return res.redirect("/login");
    return res.status(401).json({ error: "Authentication required" });
  }
  // Sliding window: refresh cookie expiration on every authenticated request.
  // The DB read for the idle window is cached (60s), so the typical request
  // path is just an HMAC verify + cookie set — no extra round-trip.
  try {
    const idleMs = await getIdleMs();
    setSessionCookie(res, idleMs);
  } catch {
    // If anything goes sideways (DB blip, etc.), fall back to default and
    // continue — better to keep the user signed in with the default window
    // than to fail-closed and force a re-login on a transient error.
    setSessionCookie(res, DEFAULT_IDLE_MS);
  }
  next();
}

async function handleLogin(req, res) {
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

  const idleMs = await getIdleMs();
  setSessionCookie(res, idleMs);

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
  DEFAULT_IDLE_MS,
  init,
  invalidateIdleCache,
  isValidSession,
  makeSession,
  setSessionCookie,
  requireAuth,
  handleLogin,
  handleLogout,
};
