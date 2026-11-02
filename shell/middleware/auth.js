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
// isn't in the cookie). The cookie also carries the session EPOCH
// (user_settings.shell_session_epoch, read with the idle window): "Sign out
// everywhere" (POST /logout?everywhere=1) bumps it, so every cookie issued
// before is refused — server-side revocation without rotating the secret
// (cycle-7 F12). A cookie from before the epoch existed counts as epoch 0.
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

// Global PIN failure ceiling (PSC-14). The per-IP authLimiter alone lets an
// attacker with ~100 IPs walk a 4-digit PIN space in a couple of hours. Count
// failed PIN attempts across ALL IPs in a sliding window; past the ceiling,
// PIN login is locked for LOCKOUT_MS (biometric login and x-api-key clients are
// unaffected) and the onLockout hook fires once per lockout so the operator is
// told. In-memory: a restart clears it, which is acceptable for a
// single-process app (a restart costs the attacker far more than it saves).
const GLOBAL_FAIL_WINDOW_MS = 60 * 60 * 1000;
const GLOBAL_FAIL_CEILING = 30;
const LOCKOUT_MS = 30 * 60 * 1000;
let _failTimes = [];
let _lockedUntil = 0;
let _onLockout = null;

// Pool pulled in via init() so the auth module isn't import-time coupled
// to Perfin's database setup. When unset (or DB unavailable) we fall back
// to DEFAULT_IDLE_MS — still a usable session, just non-tunable.
let _pool = null;
let _cachedIdleMs = DEFAULT_IDLE_MS;
let _cachedEpoch = 0;
let _cacheExpiresAt = 0;

function init({ pool, onLockout } = {}) {
  _pool = pool || null;
  if (typeof onLockout === "function") _onLockout = onLockout;
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
      const r = await _pool.query("SELECT shell_idle_timeout_minutes, shell_session_epoch FROM user_settings WHERE id = 1");
      const min = r.rows.length ? Number(r.rows[0].shell_idle_timeout_minutes) : null;
      const epoch = r.rows.length ? Number(r.rows[0].shell_session_epoch) : 0;
      _cachedEpoch = Number.isInteger(epoch) && epoch >= 0 ? epoch : 0;
      if (Number.isFinite(min) && min >= 5 && min <= 10080) {
        _cachedIdleMs = min * 60 * 1000;
      } else {
        _cachedIdleMs = DEFAULT_IDLE_MS;
      }
    } catch {
      // Fail open on a DB blip: keep the last known epoch (an active user
      // stays signed in) and fall back to the default window.
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

// Signed value: "<expires ms>:<epoch>" (a legacy "<expires ms>" is epoch 0).
function isValidSession(signed) {
  const value = verify(signed);
  if (!value) return false;
  const [exp, ep] = value.split(":");
  const expires = parseInt(exp, 10);
  const epoch = ep === undefined ? 0 : parseInt(ep, 10);
  return Number.isFinite(expires) && expires > Date.now() && epoch === _cachedEpoch;
}

function makeSession(idleMs) {
  return sign(`${Date.now() + (idleMs || DEFAULT_IDLE_MS)}:${_cachedEpoch}`);
}

function currentEpoch() {
  return _cachedEpoch;
}

// Secure flag (PSC-4): NODE_ENV=production was never set in the deploy configs,
// so the session cookie went out without `Secure`. Also derive it from the
// request itself — `trust proxy` is set, so req.secure is true behind
// Render's/Fly's TLS-terminating proxy — and keep plain-HTTP local runs working.
function cookieSecure(req) {
  return process.env.NODE_ENV === "production" || !!(req && req.secure);
}

function setSessionCookie(res, idleMs) {
  res.cookie(COOKIE_NAME, makeSession(idleMs), {
    httpOnly: true,
    secure: cookieSecure(res.req),
    sameSite: "lax",
    maxAge: idleMs,
    path: "/",
  });
}

// Constant-time string equality over fixed-length SHA-256 digests: never
// throws on a length (or UTF-8 byte-length) mismatch and leaks neither length.
function safeEqual(provided, expected) {
  const a = crypto.createHash("sha256").update(String(provided), "utf8").digest();
  const b = crypto.createHash("sha256").update(String(expected), "utf8").digest();
  return crypto.timingSafeEqual(a, b);
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
  // Compare fixed-length SHA-256 digests so the timing-safe compare never
  // short-circuits on a length mismatch — a raw length check leaked the exact
  // API_KEY length to a timing observer (F22). Both digests are 32 bytes.
  const providedHash = crypto.createHash("sha256").update(String(provided)).digest();
  const expectedHash = crypto.createHash("sha256").update(expected).digest();
  try { return crypto.timingSafeEqual(providedHash, expectedHash); } catch { return false; }
}

// Requests that authenticate THEMSELVES and so pass the cookie gate (PB-15):
// Per-sistant's Perfin webhook receiver verifies an HMAC over the raw body plus
// a timestamp replay window (and 503s when no secret is configured). Perfin's
// HTTP webhook path (e.g. the Settings "test" event) sends no shell cookie.
// Perfin's bank webhook receivers (roadmap T2.1) verify the Plaid JWT /
// Teller HMAC themselves and answer 503 while unconfigured. Exact method +
// path only — nothing else under /perfin/api/webhooks passes.
const SELF_AUTHENTICATING_POSTS = new Set([
  "/per-sistant/api/perfin/webhook",
  "/perfin/api/webhooks/plaid",
  "/perfin/api/webhooks/teller",
]);
function isSelfAuthenticatingRoute(req) {
  return req.method === "POST" && SELF_AUTHENTICATING_POSTS.has(req.path);
}

async function requireAuth(req, res, next) {
  // API key bypass for cron + CI. No cookie refresh — these aren't browser
  // sessions and the headers carry every time.
  if (isValidApiKey(req)) return next();
  if (isSelfAuthenticatingRoute(req)) return next();

  // Refresh the cached idle window + session epoch first (60 s cache), so a
  // "sign out everywhere" from another process is honoured within a minute.
  await getIdleMs();
  if (!isValidSession(req.cookies[COOKIE_NAME])) {
    // Browsers get a redirect, API clients get JSON. Sub-apps mounted past
    // this gate will inherit the same behavior automatically.
    // Carry the requested page through the login (PSC-9) so a notification
    // deep link (e.g. /perfin/housing#pending) survives an idle timeout. The
    // fragment never reaches the server; the path + query do.
    if (req.method === "GET" && req.accepts("html")) {
      const back = safeReturnTo(req.originalUrl);
      return res.redirect(back === DEFAULT_POST_LOGIN || back === "/"
        ? "/login"
        : "/login?return_to=" + encodeURIComponent(back));
    }
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

function pinLockedForMs(now = Date.now()) {
  return _lockedUntil > now ? _lockedUntil - now : 0;
}

function recordPinFailure(now = Date.now()) {
  _failTimes = _failTimes.filter((t) => now - t < GLOBAL_FAIL_WINDOW_MS);
  _failTimes.push(now);
  if (_failTimes.length >= GLOBAL_FAIL_CEILING && !pinLockedForMs(now)) {
    _lockedUntil = now + LOCKOUT_MS;
    _failTimes = [];
    console.error(`SECURITY: ${GLOBAL_FAIL_CEILING} failed PIN attempts within an hour — PIN login locked for ${LOCKOUT_MS / 60000} min.`);
    if (_onLockout) {
      Promise.resolve()
        .then(() => _onLockout({ failures: GLOBAL_FAIL_CEILING, lockedUntil: new Date(_lockedUntil) }))
        .catch((e) => console.error("PIN lockout alert failed:", e.message));
    }
  }
}

function _resetPinFailures() { _failTimes = []; _lockedUntil = 0; }

function renderLogin(res, status, error, returnTo) {
  return res.status(status).render("login", { error, returnTo: loginReturnTo(returnTo) });
}

// The return_to value echoed into the login form: only a safe, non-default
// target (anything else just lands on the default destination anyway).
function loginReturnTo(target) {
  const t = safeReturnTo(target);
  return t === DEFAULT_POST_LOGIN ? "" : t;
}

async function handleLogin(req, res) {
  const submitted = String(req.body.pin || "");
  const expected = process.env.SHELL_PIN || "";
  const returnTo = req.body.return_to;

  const lockedMs = pinLockedForMs();
  if (lockedMs) {
    // Even a correct PIN is refused while locked — otherwise the lockout would
    // not stop a distributed guesser.
    const mins = Math.ceil(lockedMs / 60000);
    return renderLogin(res, 429, `Too many failed attempts. PIN login is locked for ${mins} more minute${mins === 1 ? "" : "s"} — use biometric login or try later.`, returnTo);
  }

  // Digest compare (safeEqual): the old padded-buffer compare checked the
  // CHARACTER count but compared UTF-8 BYTES, so a multibyte PIN of the right
  // length made timingSafeEqual throw inside this async handler — an
  // unhandled rejection that killed the process and reset every in-memory
  // brute-force counter (F1).
  const matches = expected.length > 0 && safeEqual(submitted, expected);

  if (!matches) {
    recordPinFailure();
    return setTimeout(() => renderLogin(res, 401, "Incorrect PIN.", returnTo), FAIL_DELAY_MS);
  }

  // A throw here (e.g. SHELL_SECRET unset — the boot check normally prevents
  // that, PSC-11) must not escape the async handler as an unhandled rejection,
  // which crashed the process on every correct PIN.
  try {
    const idleMs = await getIdleMs();
    setSessionCookie(res, idleMs);
  } catch (err) {
    console.error("Shell login error:", err.message);
    return renderLogin(res, 500, "Login is unavailable — the server is misconfigured.", returnTo);
  }

  // Allow ?return_to=/perfin/today on the form so a redirected request
  // bounces back to where the user wanted to go after login. safeReturnTo
  // rejects scheme-relative ("//evil.com") and backslash targets so the
  // auth endpoint can't be turned into an open redirect (F17).
  res.redirect(safeReturnTo(req.body.return_to));
}

// Default post-login destination. The tile-picker landing (still served at
// "/") proved an unnecessary extra hop in practice — successful auth lands
// directly in Per-sistant, and each app's nav carries the cross-app link.
const DEFAULT_POST_LOGIN = "/per-sistant";

// Sanitize a post-login redirect target. Only same-origin absolute paths are
// allowed: a value must start with a single "/" and NOT be a scheme-relative
// "//host" or contain a backslash (which some browsers normalize to "/"),
// otherwise "//evil.com" would pass a naive startsWith("/") check and produce
// an open redirect off the auth endpoint. Anything else falls back to the
// default destination (an explicit return_to="/" still reaches the landing).
function safeReturnTo(target) {
  if (typeof target !== "string") return DEFAULT_POST_LOGIN;
  if (!target.startsWith("/")) return DEFAULT_POST_LOGIN;
  if (target.startsWith("//")) return DEFAULT_POST_LOGIN;
  if (target.includes("\\")) return DEFAULT_POST_LOGIN;
  // A browser's URL parser drops tab / CR / LF, so "/\t/evil.example" passed
  // the checks above and became "//evil.example" when the login page assigned
  // it to location.href after a biometric login (cycle-8 F25). Refuse every
  // control character, then require the target to stay same-origin when it is
  // resolved the way a browser would.
  if (/[\x00-\x1f\x7f]/.test(target)) return DEFAULT_POST_LOGIN;
  try {
    if (new URL(target, "http://same-origin.invalid").origin !== "http://same-origin.invalid") return DEFAULT_POST_LOGIN;
  } catch { return DEFAULT_POST_LOGIN; }
  return target;
}

// POST /logout clears this device's cookie. With ?everywhere=1 (from a signed-in
// session only) it also bumps user_settings.shell_session_epoch, so every
// other cookie stops working too (F12); a failed bump is a 500, not a silent
// single-device logout.
async function handleLogout(req, res) {
  if (req.query && req.query.everywhere === "1") {
    await getIdleMs();
    if (!isValidSession(req.cookies && req.cookies[COOKIE_NAME])) {
      return res.status(401).json({ error: "Authentication required" });
    }
    try {
      if (!_pool) throw new Error("no settings database");
      const r = await _pool.query(
        "UPDATE user_settings SET shell_session_epoch = shell_session_epoch + 1 WHERE id = 1 RETURNING shell_session_epoch");
      if (!r.rows.length) throw new Error("no settings row");
      _cachedEpoch = Number(r.rows[0].shell_session_epoch);
    } catch (err) {
      console.error("Sign out everywhere failed:", err.message);
      return res.status(500).json({ error: "Could not sign out other sessions." });
    }
  }
  res.clearCookie(COOKIE_NAME, { path: "/" });
  res.redirect("/login");
}

// The onLockout handler the shell registers: one "PIN login locked" alert per
// LOCKOUT_ALERT_WINDOW_HOURS (F7) — while the ceiling keeps re-tripping, the
// first alert already told the operator. `getNotifications` returns Perfin's
// notifications module ({ sendToAll, sentRecently }); sentRecently fails open,
// so a DB error still alerts.
const LOCKOUT_ALERT_WINDOW_HOURS = 6;
function makeLockoutNotifier(getNotifications) {
  return async ({ failures, lockedUntil }) => {
    const { sendToAll, sentRecently } = getNotifications();
    if (await sentRecently("pin-lockout", LOCKOUT_ALERT_WINDOW_HOURS)) return false;
    await sendToAll({
      title: "PIN login locked",
      body: `${failures} failed PIN attempts within an hour. PIN login is locked until ${lockedUntil.toISOString().slice(11, 16)} UTC. If this wasn't you, rotate SHELL_PIN.`,
      tag: "pin-lockout",
      data: { url: "/" },
    });
    return true;
  };
}

module.exports = {
  COOKIE_NAME,
  DEFAULT_IDLE_MS,
  DEFAULT_POST_LOGIN,
  GLOBAL_FAIL_CEILING,
  cookieSecure,
  loginReturnTo,
  pinLockedForMs,
  _resetPinFailures,
  _recordPinFailure: recordPinFailure,
  init,
  invalidateIdleCache,
  isValidSession,
  LOCKOUT_ALERT_WINDOW_HOURS,
  makeLockoutNotifier,
  makeSession,
  currentEpoch,
  setSessionCookie,
  getIdleMs,
  requireAuth,
  handleLogin,
  handleLogout,
  safeEqual,
  safeReturnTo,
  isValidApiKey,
};
