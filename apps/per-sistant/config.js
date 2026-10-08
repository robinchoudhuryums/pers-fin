// ============================================================================
// Per-sistant — Configuration & Constants
// ============================================================================

const crypto = require("crypto");

// Auth
const SESSION_PASSWORD = process.env.SESSION_PASSWORD;
const SESSION_PIN = process.env.SESSION_PIN;
const AUTH_SECRET = SESSION_PASSWORD || SESSION_PIN || null;
const AUTH_MODE = SESSION_PIN ? "pin" : (SESSION_PASSWORD ? "password" : null);
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString("hex");
if (!process.env.SESSION_SECRET) {
  console.warn("WARNING: SESSION_SECRET not set — using random secret. Sessions will be invalidated on every restart.");
}
const PERFIN_URL = process.env.PERFIN_URL || null;

// Contacts from env
let envContacts = {};
try { envContacts = JSON.parse(process.env.CONTACTS || "{}"); } catch { envContacts = {}; }

// Validation constants
const VALID_PRIORITIES = ["low", "medium", "high", "urgent"];
const VALID_HORIZONS = ["short", "medium", "long"];
const VALID_RECURRENCE_RULES = ["daily", "weekly", "monthly", "yearly", "weekdays", "custom_days", "custom_weeks", "custom_months"];
const VALID_NOTE_COLORS = ["default", "warm", "teal", "green", "blue"];
const VALID_EMAIL_STATUSES = ["draft", "scheduled", "sent", "failed"];
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const VALID_AI_FEATURES = ["email_draft", "task_breakdown", "quick_add", "review_summary", "email_tone", "daily_briefing", "note_tagging", "smart_suggestions", "natural_language_query", "rag", "job_fit"];
const VALID_WEBHOOK_EVENTS = ["todo_created", "todo_completed", "email_sent", "note_created", "reminder_due", "streak_milestone"];
const VALID_TRIGGERS = ["todo_created", "todo_completed", "email_created", "note_created", "schedule"];
const VALID_ACTIONS = ["set_priority", "set_category", "set_horizon", "add_tag", "send_notification", "create_todo"];

// Input length limits
const MAX_TITLE_LENGTH = 500;
const MAX_BODY_LENGTH = 50000;
const MAX_CONTENT_LENGTH = 100000;
const MAX_BULK_IDS = 500;
const MAX_PAGINATION_LIMIT = 100;

// ---- SSRF guard (PB-1/PB-5/PB-14) -----------------------------------------
// Non-public address space, checked with node's built-in CIDR matcher. String
// prefix checks alone were bypassable: `http://[::ffff:169.254.169.254]/`
// normalizes to `[::ffff:a9fe:a9fe]` and slipped past, as did `[::]` and
// `[::ffff:7f00:1]`; and a public hostname could simply RESOLVE to a private
// address. IPv4-mapped / IPv4-compatible IPv6 addresses are unwrapped to IPv4
// first.
const net = require("net");
const _blocked = new net.BlockList();
[
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8],
  ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.168.0.0", 16],
  ["198.18.0.0", 15], ["224.0.0.0", 4], ["240.0.0.0", 4],
].forEach(([a, p]) => _blocked.addSubnet(a, p, "ipv4"));
[
  ["::", 96],          // unspecified, loopback and IPv4-compatible (::a.b.c.d)
  ["64:ff9b::", 96],   // NAT64 — can be routed to an internal IPv4
  ["fc00::", 7],       // unique local
  ["fe80::", 10],      // link local
  ["ff00::", 8],       // multicast
].forEach(([a, p]) => _blocked.addSubnet(a, p, "ipv6"));

function unwrapMappedIpv4(ip) {
  const v = String(ip).toLowerCase();
  let m = v.match(/^(?:0{0,4}:){0,5}:?ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (m) return m[1];
  m = v.match(/^(?:0{0,4}:){0,5}:?ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (m) {
    const hi = parseInt(m[1], 16), lo = parseInt(m[2], 16);
    return [hi >> 8, hi & 255, lo >> 8, lo & 255].join(".");
  }
  return null;
}

// True for any address that is not publicly routable (or isn't an IP at all).
function isPrivateAddress(ip) {
  const bare = String(ip || "").replace(/^\[|\]$/g, "");
  const kind = net.isIP(bare);
  if (!kind) return true;
  if (kind === 6) {
    const v4 = unwrapMappedIpv4(bare);
    if (v4) return _blocked.check(v4, "ipv4");
    return _blocked.check(bare, "ipv6");
  }
  return _blocked.check(bare, "ipv4");
}

// URL validation for webhooks/external requests (synchronous, no DNS): scheme,
// literal private IPs in any spelling, and internal names. The send paths ALSO
// call resolveSafeWebhookTarget, which checks what the name resolves to.
function isValidWebhookUrl(urlStr) {
  try {
    const u = new URL(urlStr);
    if (u.protocol !== "http:" && u.protocol !== "https:") return false;
    // Block private/internal IPs
    const hostname = u.hostname;
    if (net.isIP(hostname.replace(/^\[|\]$/g, "")) && isPrivateAddress(hostname)) return false;
    if (hostname === "localhost" || hostname === "127.0.0.1" || hostname === "0.0.0.0" || hostname === "::1" || hostname === "[::1]") return false;
    if (hostname.startsWith("127.")) return false; // full loopback /8 (not just 127.0.0.1)
    // Link-local 169.254.0.0/16 — INCLUDES the cloud metadata endpoint
    // 169.254.169.254 (AWS/GCP/Azure credential theft via SSRF) (PB-1).
    if (hostname.startsWith("169.254.")) return false;
    if (hostname.startsWith("10.") || hostname.startsWith("192.168.")) return false;
    if (/^172\.(1[6-9]|2\d|3[01])\./.test(hostname)) return false;
    // IPv6 loopback/link-local/unique-local in bracketed form ([::1], [fe80::…],
    // [fc00::…]/[fd00::…]) and IPv4-mapped metadata.
    if (/^\[(::1|fe80:|fc[0-9a-f]{2}:|fd[0-9a-f]{2}:|::ffff:169\.254\.|::ffff:127\.|::ffff:10\.)/i.test(hostname)) return false;
    if (hostname.endsWith(".internal") || hostname.endsWith(".local")) return false;
    return true;
  } catch {
    return false;
  }
}

// Async SSRF check for the moment of sending (PB-14): the URL must pass
// isValidWebhookUrl AND every address its hostname resolves to must be public
// (a public-looking name pointing at 169.254.169.254 / 10.x is rejected).
// Callers must also fetch with redirect: "manual" so a public URL can't 30x to
// an internal one. (A rebinding race between this lookup and fetch's own is
// still possible; this closes the static cases.)
async function resolveSafeWebhookTarget(urlStr) {
  if (!isValidWebhookUrl(urlStr)) return false;
  const host = new URL(urlStr).hostname.replace(/^\[|\]$/g, "");
  if (net.isIP(host)) return !isPrivateAddress(host);
  try {
    const addrs = await require("dns").promises.lookup(host, { all: true, verbatim: true });
    return addrs.length > 0 && addrs.every((a) => !isPrivateAddress(a.address));
  } catch {
    return false;
  }
}

// Webhook header allowlist
const BLOCKED_WEBHOOK_HEADERS = ["host", "cookie", "set-cookie", "transfer-encoding", "content-length", "connection", "upgrade"];

function validateWebhookHeaders(headers) {
  if (!headers || typeof headers !== "object") return { valid: true };
  for (const key of Object.keys(headers)) {
    if (BLOCKED_WEBHOOK_HEADERS.includes(key.toLowerCase())) {
      return { valid: false, error: `Header "${key}" is not allowed in webhooks.` };
    }
    if (typeof headers[key] !== "string") {
      return { valid: false, error: `Header "${key}" value must be a string.` };
    }
  }
  return { valid: true };
}

module.exports = {
  isPrivateAddress,
  resolveSafeWebhookTarget,
  SESSION_PASSWORD, SESSION_PIN, AUTH_SECRET, AUTH_MODE, SESSION_SECRET, PERFIN_URL,
  envContacts,
  VALID_PRIORITIES, VALID_HORIZONS, VALID_RECURRENCE_RULES,
  VALID_NOTE_COLORS, VALID_EMAIL_STATUSES, EMAIL_REGEX,
  VALID_AI_FEATURES, VALID_WEBHOOK_EVENTS,
  VALID_TRIGGERS, VALID_ACTIONS,
  MAX_TITLE_LENGTH, MAX_BODY_LENGTH, MAX_CONTENT_LENGTH,
  MAX_BULK_IDS, MAX_PAGINATION_LIMIT,
  isValidWebhookUrl, validateWebhookHeaders, BLOCKED_WEBHOOK_HEADERS,
};
