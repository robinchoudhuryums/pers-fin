// ============================================================================
// Cycle 8 E3a (G2) — notification kinds, quiet hours and mutes
// ============================================================================
// services/notify-prefs.js: every tag a Perfin notification is sent with today
// and every Per-sistant check type maps to a named kind (a source scan — a new
// caller with an unmapped tag fails here); isQuiet on the APP_TIMEZONE wall
// clock (wrapping past midnight, the edges, a DST night, another zone, a bad
// zone); decide's order (muted, then covered, then held); normalizePrefs and
// the PATCH parsers; PATCH /api/settings writing or refusing the two fields
// through the real router; GET's normalized fields + catalog; the migration.
// No delivery change in this batch (E3b).
// ============================================================================
if (!process.env.NEON_DATABASE_URL) process.env.NEON_DATABASE_URL = "postgres://mock:mock@localhost/mock";
if (!process.env.TOKEN_ENCRYPTION_PASSPHRASE) process.env.TOKEN_ENCRYPTION_PASSPHRASE = "test-passphrase";

const { describe, it, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const express = require("express");
const supertest = require("supertest");

const ROOT = path.join(__dirname, "..");
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), "utf8");
const np = require("../teller/services/notify-prefs");
const dbModule = require("../teller/services/database");
const originalQuery = dbModule.pool.query;
afterEach(() => { dbModule.pool.query = originalQuery; });

// ---------------------------------------------------------------------------
describe("the kind catalog", () => {
  it("unique keys; security and test can't be muted and bypass quiet hours", () => {
    const keys = np.NOTIFY_KINDS.map((k) => k.key);
    assert.equal(new Set(keys).size, keys.length);
    for (const k of ["security", "test"]) {
      assert.equal(np.kindInfo(k).mutable, false);
      assert.equal(np.kindInfo(k).bypassQuiet, true);
      assert.ok(!np.MUTABLE_KINDS.includes(k));
    }
    assert.ok(np.MUTABLE_KINDS.includes("other"), "an unknown tag is never unmutable");
    for (const c of np.catalog()) assert.deepEqual(Object.keys(c), ["key", "label", "app", "mutable", "bypass_quiet"]);
  });

  it("kindOf maps today's tags", () => {
    const cases = {
      "anomaly-trader-joe's": "spending", "budget-over-dining": "spending", "budget-warn-gas": "spending",
      "cash-low": "cash", "balance-floor-12": "cash", "payday-ab12": "cash", "payday-missed-ab12-2026-10-01": "cash",
      "housing-due-2026-11": "bills", "housing-util-7": "bills", "sub-still-charging-3": "bills", "sub-price-3": "bills",
      "advice-plan": "plan", "goal-4": "goals",
      "plaid-reauth-2": "accounts", "plaid-new-accounts-transactions-2": "accounts", "teller-disconnected-1": "accounts",
      "sync-error": "accounts", "auto-sync": "accounts", "reconcile": "accounts", "csv-reminder": "accounts",
      "operator-checks": "system", "jobs-missed": "system", "sheets-sync": "system", "app-error-abc": "system", "audit-alert": "system",
      "pin-lockout": "security", "test": "test", "general": "other", "something-new": "other", "": "other",
    };
    for (const [tag, kind] of Object.entries(cases)) assert.equal(np.kindOf(tag), kind, tag);
    assert.equal(np.kindOf(undefined), "other");
  });

  // A source scan: every tag literal a notification is sent with maps to a
  // named kind. A new caller with a new tag lands in "other" and fails here,
  // so the catalog stays complete.
  it("every tag literal in the notifying code maps to a named kind", () => {
    const files = [
      ...["services", "routes"].flatMap((d) => fs.readdirSync(path.join(ROOT, "teller", d)).filter((f) => f.endsWith(".js")).map((f) => path.join("teller", d, f))),
      path.join("teller", "startup.js"), path.join("shell", "middleware", "auth.js"),
    ];
    const RE = [
      /\btag\s*[:=]\s*["'`]([a-z][a-z-]*)/g,
      /\b[A-Z_]*TAG\s*=\s*["'`]([a-z][a-z-]*)/g,
      /\btagOf\s*=\s*\([^)]*\)\s*=>\s*["'`]([a-z][a-z-]*)/g,
    ];
    const found = new Map();
    for (const f of files) {
      const src = read(f);
      if (!/sendToAll|notify\s*\(/.test(src)) continue;
      for (const re of RE) for (const m of src.matchAll(re)) found.set(m[1], f);
    }
    // Every notifying caller found, not just some.
    for (const t of ["anomaly-", "budget-over-", "cash-low", "balance-floor-", "payday-", "payday-missed-", "housing-due-", "housing-util-",
      "sub-still-charging-", "sub-price-", "advice-plan", "goal-", "plaid-reauth-", "plaid-new-accounts-", "teller-disconnected-",
      "sync-error", "auto-sync", "reconcile", "csv-reminder", "operator-checks", "jobs-missed", "sheets-sync", "app-error-",
      "audit-alert", "pin-lockout", "test"]) {
      assert.ok(found.has(t), "the scan finds " + t);
    }
    for (const [t, f] of found) {
      // a prefix literal stands for tags that continue it
      assert.notEqual(np.kindOf(t.endsWith("-") ? t + "x" : t), "other", `${t} (${f}) has no kind in services/notify-prefs.js`);
    }
  });

  it("every Per-sistant notification-check type maps to a named kind", () => {
    const src = read("apps", "per-sistant", "routes", "notifications.js");
    const types = [...src.matchAll(/type:\s*"([a-z_]+)"/g)].map((m) => m[1]);
    assert.ok(types.length >= 10, "the scan finds the check's types");
    for (const t of types) assert.notEqual(np.kindOfCheckType(t), "other", t);
    assert.equal(np.kindOfCheckType("housing_due"), "bills", "Per-sistant's rent line is the same kind as Perfin's");
    assert.equal(np.kindOfCheckType("nope"), "other");
  });
});

// ---------------------------------------------------------------------------
describe("isQuiet", () => {
  const night = { enabled: true, start: "22:00", end: "07:00" };
  const at = (iso) => new Date(iso);

  it("wraps past midnight; start inclusive, end exclusive", () => {
    assert.equal(np.isQuiet(at("2026-10-29T23:00:00Z"), night, "UTC"), true);
    assert.equal(np.isQuiet(at("2026-10-29T22:00:00Z"), night, "UTC"), true);
    assert.equal(np.isQuiet(at("2026-10-30T06:59:00Z"), night, "UTC"), true);
    assert.equal(np.isQuiet(at("2026-10-30T07:00:00Z"), night, "UTC"), false);
    assert.equal(np.isQuiet(at("2026-10-29T21:59:00Z"), night, "UTC"), false);
    assert.equal(np.isQuiet(at("2026-10-29T12:00:00Z"), night, "UTC"), false);
  });

  it("a same-day window", () => {
    const lunch = { enabled: true, start: "12:00", end: "13:30" };
    assert.equal(np.isQuiet(at("2026-10-29T12:45:00Z"), lunch, "UTC"), true);
    assert.equal(np.isQuiet(at("2026-10-29T13:30:00Z"), lunch, "UTC"), false);
    assert.equal(np.isQuiet(at("2026-10-29T11:59:00Z"), lunch, "UTC"), false);
  });

  it("off, malformed or start = end is never quiet", () => {
    const t = at("2026-10-29T23:00:00Z");
    assert.equal(np.isQuiet(t, { ...night, enabled: false }, "UTC"), false);
    assert.equal(np.isQuiet(t, { enabled: true, start: "22:00", end: "22:00" }, "UTC"), false);
    assert.equal(np.isQuiet(t, { enabled: true, start: "25:00", end: "07:00" }, "UTC"), false);
    assert.equal(np.isQuiet(t, null, "UTC"), false);
  });

  it("reads the given zone's wall clock", () => {
    // 08:00Z is 01:00 in Los Angeles (PDT); 20:00Z is 13:00 there.
    assert.equal(np.isQuiet(at("2026-10-29T08:00:00Z"), night, "America/Los_Angeles"), true);
    assert.equal(np.isQuiet(at("2026-10-29T08:00:00Z"), night, "UTC"), false);
    assert.equal(np.isQuiet(at("2026-10-29T23:00:00Z"), night, "America/Los_Angeles"), false);
    // An invalid zone reads UTC rather than throwing.
    assert.equal(np.isQuiet(at("2026-10-29T23:00:00Z"), night, "Not/AZone"), true);
  });

  it("both 01:30s of the night clocks go back are 01:30", () => {
    const w = { enabled: true, start: "01:00", end: "02:00" };
    assert.equal(np.isQuiet(at("2026-11-01T05:30:00Z"), w, "America/New_York"), true, "01:30 EDT");
    assert.equal(np.isQuiet(at("2026-11-01T06:30:00Z"), w, "America/New_York"), true, "01:30 EST");
    assert.equal(np.isQuiet(at("2026-11-01T07:30:00Z"), w, "America/New_York"), false, "02:30 EST");
  });
});

// ---------------------------------------------------------------------------
describe("decide", () => {
  const quietNow = new Date("2026-10-29T23:00:00Z");
  const dayNow = new Date("2026-10-29T12:00:00Z");
  const prefs = (muted = [], enabled = true) => ({ quiet: { enabled, start: "22:00", end: "07:00" }, muted });

  it("muted, then covered, then held, else sent", () => {
    assert.equal(np.decide({ kind: "bills", prefs: prefs(["bills"]), now: quietNow, tz: "UTC", covered: true }), "muted");
    assert.equal(np.decide({ kind: "bills", prefs: prefs(), now: quietNow, tz: "UTC", covered: true }), "covered");
    assert.equal(np.decide({ kind: "bills", prefs: prefs(), now: quietNow, tz: "UTC" }), "held");
    assert.equal(np.decide({ kind: "bills", prefs: prefs(), now: dayNow, tz: "UTC" }), "sent");
    assert.equal(np.decide({ kind: "bills", prefs: prefs([], false), now: quietNow, tz: "UTC" }), "sent");
  });

  it("security and test are never muted or held", () => {
    for (const kind of ["security", "test"]) {
      assert.equal(np.decide({ kind, prefs: prefs([kind]), now: quietNow, tz: "UTC" }), "sent", kind);
    }
  });

  it("an unknown kind is treated as other; no prefs means nothing muted or quiet", () => {
    assert.equal(np.decide({ kind: "zzz", prefs: prefs(["other"]), now: dayNow, tz: "UTC" }), "muted");
    assert.equal(np.decide({ kind: "cash", prefs: null, now: quietNow, tz: "UTC" }), "sent");
  });
});

// ---------------------------------------------------------------------------
describe("normalizePrefs and the PATCH parsers", () => {
  it("normalizePrefs fills defaults, reads JSON strings and drops what it can't use", () => {
    assert.deepEqual(np.normalizePrefs(null), { quiet: { enabled: false, start: "22:00", end: "07:00" }, muted: [] });
    assert.deepEqual(np.normalizePrefs({
      notify_quiet_hours: JSON.stringify({ enabled: true, start: "23:15", end: "06:45" }),
      notify_muted_types: JSON.stringify(["jobs", "security", "nope", "jobs", 5]),
    }), { quiet: { enabled: true, start: "23:15", end: "06:45" }, muted: ["jobs"] });
    assert.deepEqual(np.normalizePrefs({ notify_quiet_hours: { enabled: "yes", start: "x" }, notify_muted_types: {} }),
      { quiet: { enabled: false, start: "22:00", end: "07:00" }, muted: [] });
  });

  it("parseQuietHours", () => {
    assert.deepEqual(np.parseQuietHours({ enabled: true, start: "21:30", end: "06:00" }).value, { enabled: true, start: "21:30", end: "06:00" });
    assert.deepEqual(np.parseQuietHours(null).value, { enabled: false, start: "22:00", end: "07:00" });
    for (const bad of [true, "22:00", [], {}, { enabled: "true", start: "22:00", end: "07:00" }, { enabled: true, start: "22:00" },
      { enabled: true, start: "24:00", end: "07:00" }, { enabled: true, start: "7:00", end: "22:00" }, { enabled: true, start: "22:00", end: "22:00" },
      { enabled: true, start: "22:00", end: "07:00", extra: 1 }]) {
      assert.ok(np.parseQuietHours(bad).error, JSON.stringify(bad));
    }
  });

  it("parseMutedKinds", () => {
    assert.deepEqual(np.parseMutedKinds(["jobs", "spending", "jobs"]).value, ["jobs", "spending"]);
    assert.deepEqual(np.parseMutedKinds(null).value, []);
    assert.deepEqual(np.parseMutedKinds([]).value, []);
    for (const bad of ["jobs", {}, [1], ["nope"], ["security"], ["test"]]) assert.ok(np.parseMutedKinds(bad).error, JSON.stringify(bad));
  });
});

// ---------------------------------------------------------------------------
describe("Settings routes", () => {
  const app = () => { const a = express(); a.use(express.json()); a.use(require("../teller/routes/settings")); return a; };

  it("PATCH refuses a bad value with a 400 and writes nothing", async () => {
    dbModule.pool.query = async () => { throw new Error("must not write"); };
    for (const body of [
      { notify_quiet_hours: { enabled: true, start: "22:00", end: "22:00" } },
      { notify_quiet_hours: "22:00-07:00" },
      { notify_muted_types: ["security"] },
      { notify_muted_types: "jobs" },
    ]) await supertest(app()).patch("/api/settings").send(body).expect(400);
  });

  it("PATCH stores both as JSON", async () => {
    const writes = [];
    dbModule.pool.query = async (sql, params) => { if (/^UPDATE user_settings SET/.test(sql)) writes.push({ sql, params }); return { rows: [{}] }; };
    await supertest(app()).patch("/api/settings")
      .send({ notify_quiet_hours: { enabled: true, start: "22:30", end: "06:30" }, notify_muted_types: ["jobs", "jobs", "habits"] })
      .expect(200);
    assert.equal(writes.length, 1);
    assert.match(writes[0].sql, /notify_quiet_hours = \$1, notify_muted_types = \$2/);
    assert.deepEqual(JSON.parse(writes[0].params[0]), { enabled: true, start: "22:30", end: "06:30" });
    assert.deepEqual(JSON.parse(writes[0].params[1]), ["jobs", "habits"]);
  });

  it("GET returns the normalized prefs, the catalog and the zone", async () => {
    dbModule.pool.query = async () => ({ rows: [{ theme: "dark", notify_quiet_hours: { enabled: true, start: "22:00", end: "07:00" }, notify_muted_types: ["jobs", "security"] }] });
    const body = (await supertest(app()).get("/api/settings").expect(200)).body;
    assert.deepEqual(body.notify_quiet_hours, { enabled: true, start: "22:00", end: "07:00" });
    assert.deepEqual(body.notify_muted_types, ["jobs"]);
    assert.ok(body.notify_kinds.some((k) => k.key === "security" && k.mutable === false));
    assert.equal(typeof body.notify_timezone, "string");
  });

  it("GET with no stored row still has the defaults", async () => {
    dbModule.pool.query = async () => ({ rows: [] });
    const body = (await supertest(app()).get("/api/settings").expect(200)).body;
    assert.deepEqual(body.notify_quiet_hours, { enabled: false, start: "22:00", end: "07:00" });
    assert.deepEqual(body.notify_muted_types, []);
  });
});

// ---------------------------------------------------------------------------
describe("the migration", () => {
  const src = read("teller", "services", "database.js");
  it("adds the settings and notification_log columns; push_state's values in CHECK_LISTS", () => {
    assert.match(src, /ADD COLUMN IF NOT EXISTS notify_quiet_hours JSONB NOT NULL DEFAULT '\{"enabled": false, "start": "22:00", "end": "07:00"\}'::jsonb/);
    assert.match(src, /ADD COLUMN IF NOT EXISTS notify_muted_types JSONB NOT NULL DEFAULT '\[\]'::jsonb/);
    assert.match(src, /ALTER TABLE notification_log ADD COLUMN IF NOT EXISTS push_state TEXT CHECK \(push_state IN \(\$\{inList\(CHECK_LISTS\.notification_log\.push_state\)\}\)\)/);
    assert.match(src, /ALTER TABLE notification_log ADD COLUMN IF NOT EXISTS item_key TEXT/);
    assert.deepEqual(dbModule.CHECK_LISTS.notification_log.push_state, ["sent", "held", "muted", "covered", "none", "expired"]);
  });
});
