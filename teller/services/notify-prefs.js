// ============================================================================
// Notification kinds, quiet hours and mutes (cycle-8 E3a, G2)
// ============================================================================
// One catalog of the user-facing KINDS of alert across both apps. A Perfin
// push is named by its tag (sendToAll's `tag`, also notification_log.type) and
// a Per-sistant notification by its check type (GET /api/notifications/check);
// kindOf maps either to its kind. The user's settings — quiet hours and the
// muted kinds — live on Perfin's user_settings row (Perfin owns them; under
// the shell Per-sistant reads them through perfinPool).
//
//   - kindOf(tag) / kindOfCheckType(type) — the kind key; an unknown tag is
//     "other" (mutable, so a new caller is never silently unmutable).
//   - normalizePrefs(row) — { quiet: { enabled, start, end }, muted: [kind] }
//     from a settings row, defaults filled, unknown / unmutable kinds dropped.
//   - isQuiet(now, quiet, tz) — inside quiet hours on the APP_TIMEZONE wall
//     clock; end before start wraps past midnight.
//   - decide({ kind, prefs, now, tz, covered }) — what to do with the
//     INTERRUPTION (never the record): "muted" | "covered" (an open linked
//     task is the surface — ST2) | "held" (quiet hours) | "sent".
//   - parseQuietHours / parseMutedKinds — PATCH /api/settings validation.
// Pure apart from Intl; no database. Delivery uses it from E3b.
// ============================================================================

const APP_TIMEZONE = process.env.APP_TIMEZONE || "UTC";

// tags: exact Perfin tags; prefixes: tag prefixes (each ends in "-");
// checkTypes: Per-sistant notification-check types.
const NOTIFY_KINDS = [
  { key: "spending", label: "Unusual charges and budget alerts", app: "perfin", tags: [], prefixes: ["anomaly-", "budget-over-", "budget-warn-"], checkTypes: [] },
  { key: "cash", label: "Low cash, account floors and paydays", app: "perfin", tags: ["cash-low"], prefixes: ["balance-floor-", "payday-"], checkTypes: [] },
  { key: "bills", label: "Rent, utilities and subscriptions", app: "perfin", tags: [], prefixes: ["housing-due-", "housing-util-", "sub-still-charging-", "sub-price-"], checkTypes: ["housing_due"] },
  { key: "plan", label: "Changes to your plan", app: "perfin", tags: ["advice-plan"], prefixes: [], checkTypes: [] },
  { key: "goals", label: "Goal milestones", app: "perfin", tags: [], prefixes: ["goal-"], checkTypes: [] },
  { key: "accounts", label: "Bank connections and syncs", app: "perfin", tags: ["sync-error", "auto-sync", "reconcile", "csv-reminder"], prefixes: ["plaid-reauth-", "plaid-new-accounts-", "teller-disconnected-"], checkTypes: [] },
  { key: "system", label: "Operator checks and app errors", app: "perfin", tags: ["operator-checks", "jobs-missed", "sheets-sync", "audit-alert"], prefixes: ["app-error-"], checkTypes: [] },
  { key: "tasks", label: "Tasks due and note reminders", app: "per-sistant", tags: [], prefixes: [], checkTypes: ["due_today", "overdue", "reminder"] },
  { key: "habits", label: "Streaks at risk", app: "per-sistant", tags: [], prefixes: [], checkTypes: ["streak_at_risk", "habit_streak_at_risk"] },
  { key: "knowledge", label: "Knowledge facts and vault sync", app: "per-sistant", tags: [], prefixes: [], checkTypes: ["fact_upcoming", "vault_sync_error"] },
  { key: "jobs", label: "Job Radar", app: "per-sistant", tags: [], prefixes: [], checkTypes: ["job_radar"] },
  { key: "email", label: "Emails that failed to send", app: "per-sistant", tags: [], prefixes: [], checkTypes: ["email_failed"] },
  // Can't be muted and never held: a PIN lockout is someone guessing your PIN.
  { key: "security", label: "Security", app: "shell", tags: ["pin-lockout"], prefixes: [], checkTypes: [], mutable: false, bypassQuiet: true },
  // The test notification exists to test delivery.
  { key: "test", label: "Test notification", app: "perfin", tags: ["test"], prefixes: [], checkTypes: [], mutable: false, bypassQuiet: true },
  { key: "other", label: "Other notifications", app: "perfin", tags: ["general"], prefixes: [], checkTypes: [] },
].map((k) => ({ mutable: true, bypassQuiet: false, ...k }));

const BY_KEY = new Map(NOTIFY_KINDS.map((k) => [k.key, k]));
const EXACT = new Map();
const CHECK = new Map();
const PREFIXES = [];
for (const k of NOTIFY_KINDS) {
  for (const t of k.tags) EXACT.set(t, k.key);
  for (const t of k.checkTypes) CHECK.set(t, k.key);
  for (const p of k.prefixes) PREFIXES.push([p, k.key]);
}
PREFIXES.sort((a, b) => b[0].length - a[0].length); // longest prefix wins

function kindOf(tag) {
  const t = String(tag || "general");
  if (EXACT.has(t)) return EXACT.get(t);
  for (const [p, key] of PREFIXES) if (t.startsWith(p)) return key;
  return "other";
}
function kindOfCheckType(type) {
  return CHECK.get(String(type || "")) || "other";
}
const kindInfo = (key) => BY_KEY.get(key) || BY_KEY.get("other");
const MUTABLE_KINDS = NOTIFY_KINDS.filter((k) => k.mutable).map((k) => k.key);

// What GET /api/settings sends the Settings page (no matching rules).
function catalog() {
  return NOTIFY_KINDS.map(({ key, label, app, mutable, bypassQuiet }) => ({ key, label, app, mutable, bypass_quiet: bypassQuiet }));
}

const DEFAULT_QUIET = Object.freeze({ enabled: false, start: "22:00", end: "07:00" });
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const toMinutes = (hhmm) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));

function asObject(v) {
  if (typeof v === "string") { try { v = JSON.parse(v); } catch { return null; } }
  return v && typeof v === "object" ? v : null;
}

function normalizePrefs(row) {
  const q = asObject(row && row.notify_quiet_hours);
  const quiet = (q && typeof q.enabled === "boolean" && HHMM.test(q.start) && HHMM.test(q.end) && q.start !== q.end)
    ? { enabled: q.enabled, start: q.start, end: q.end }
    : { ...DEFAULT_QUIET };
  const m = asObject(row && row.notify_muted_types);
  const muted = Array.isArray(m) ? [...new Set(m.filter((k) => typeof k === "string" && MUTABLE_KINDS.includes(k)))] : [];
  return { quiet, muted };
}

// The wall-clock minute of the day in tz (an invalid zone → UTC).
function localMinutes(now, tz) {
  const fmt = (zone) => new Intl.DateTimeFormat("en-GB", { timeZone: zone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(now);
  let s;
  try { s = fmt(tz || APP_TIMEZONE); } catch { s = fmt("UTC"); }
  return toMinutes(s);
}

function isQuiet(now, quiet, tz = APP_TIMEZONE) {
  if (!quiet || quiet.enabled !== true || !HHMM.test(quiet.start) || !HHMM.test(quiet.end)) return false;
  const s = toMinutes(quiet.start), e = toMinutes(quiet.end);
  if (s === e) return false;
  const m = localMinutes(now instanceof Date ? now : new Date(now), tz);
  return s < e ? (m >= s && m < e) : (m >= s || m < e);
}

function decide({ kind, prefs, now = new Date(), tz = APP_TIMEZONE, covered = false }) {
  const info = kindInfo(kind);
  const p = prefs || normalizePrefs(null);
  if (info.mutable && p.muted.includes(info.key)) return "muted";
  if (covered) return "covered";
  if (!info.bypassQuiet && isQuiet(now, p.quiet, tz)) return "held";
  return "sent";
}

// PATCH validation: { value } or { error }. null resets to the default.
function parseQuietHours(v) {
  if (v === null) return { value: { ...DEFAULT_QUIET } };
  if (!v || typeof v !== "object" || Array.isArray(v)) return { error: "notify_quiet_hours must be { enabled, start, end } or null" };
  const keys = Object.keys(v);
  if (keys.some((k) => !["enabled", "start", "end"].includes(k))) return { error: "notify_quiet_hours takes only enabled, start and end" };
  if (typeof v.enabled !== "boolean") return { error: "notify_quiet_hours.enabled must be true or false" };
  if (typeof v.start !== "string" || !HHMM.test(v.start) || typeof v.end !== "string" || !HHMM.test(v.end)) {
    return { error: "notify_quiet_hours.start and end must be times as HH:MM (00:00-23:59)" };
  }
  if (v.start === v.end) return { error: "notify_quiet_hours.start and end must differ" };
  return { value: { enabled: v.enabled, start: v.start, end: v.end } };
}

function parseMutedKinds(v) {
  if (v === null) return { value: [] };
  if (!Array.isArray(v)) return { error: "notify_muted_types must be a list of notification kinds or null" };
  const out = [];
  for (const k of v) {
    if (typeof k !== "string" || !BY_KEY.has(k)) return { error: "notify_muted_types has an unknown kind" };
    if (!kindInfo(k).mutable) return { error: `"${k}" notifications can't be muted` };
    if (!out.includes(k)) out.push(k);
  }
  return { value: out };
}

module.exports = {
  NOTIFY_KINDS, MUTABLE_KINDS, DEFAULT_QUIET,
  kindOf, kindOfCheckType, kindInfo, catalog,
  normalizePrefs, isQuiet, decide, parseQuietHours, parseMutedKinds,
};
