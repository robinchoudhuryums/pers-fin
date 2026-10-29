// Cycle 8 E3c (G2) — Per-sistant follows Perfin's quiet hours and mutes.
// annotateNotify gives every notification-check entry its kind and
// notify:true|false (false inside quiet hours or for a muted kind; true with no
// prefs); perfinNotifyPrefs reads Perfin's row through perfinPool (null
// standalone or on a failure); GET /api/notifications/check carries both and a
// `quiet` flag; the dashboard raises no browser notification for notify:false
// (the Reminders list still shows it); Settings links to Perfin's section under
// the shell only.
process.env.APP_TIMEZONE = "UTC";
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const supertest = require("supertest");
const fs = require("fs");
const path = require("path");

const notifRoutes = require("../routes/notifications");
const { annotateNotify, perfinNotifyPrefs } = notifRoutes;

const QUIET = { enabled: true, start: "22:00", end: "07:00" };
const at = (iso) => new Date(iso);

describe("annotateNotify", () => {
  it("inside quiet hours nothing notifies; outside, everything not muted does", () => {
    const list = () => [{ type: "overdue" }, { type: "housing_due" }, { type: "job_radar" }];
    const quiet = annotateNotify(list(), { quiet: QUIET, muted: [] }, at("2026-10-29T23:00:00Z"));
    assert.deepEqual(quiet.map((n) => [n.kind, n.notify]), [["tasks", false], ["bills", false], ["jobs", false]]);
    const day = annotateNotify(list(), { quiet: QUIET, muted: ["jobs"] }, at("2026-10-29T12:00:00Z"));
    assert.deepEqual(day.map((n) => n.notify), [true, true, false], "a muted kind never notifies");
  });

  it("no prefs (standalone or a failed read): every entry may notify, kinds still named", () => {
    const out = annotateNotify([{ type: "reminder" }, { type: "something_new" }], null);
    assert.deepEqual(out.map((n) => [n.kind, n.notify]), [["tasks", true], ["other", true]]);
  });
});

describe("perfinNotifyPrefs", () => {
  it("standalone: null, no query", async () => {
    assert.equal(await perfinNotifyPrefs(null), null);
  });
  it("reads Perfin's row read-only and normalizes it", async () => {
    const sqls = [];
    const pool = { query: async (sql) => { sqls.push(sql); return { rows: [{ notify_quiet_hours: QUIET, notify_muted_types: ["jobs", "security"] }] }; } };
    assert.deepEqual(await perfinNotifyPrefs(pool), { quiet: QUIET, muted: ["jobs"] });
    assert.deepEqual(sqls, ["SELECT notify_quiet_hours, notify_muted_types FROM user_settings WHERE id = 1"]);
  });
  it("a failed read is null — nothing held back", async () => {
    const quiet = console.error; console.error = () => {};
    try { assert.equal(await perfinNotifyPrefs({ query: async () => { throw new Error("down"); } }), null); }
    finally { console.error = quiet; }
  });
});

describe("GET /api/notifications/check", () => {
  function app(perfinPool, row) {
    const a = express();
    if (perfinPool) a.set("perfinPool", perfinPool);
    const pool = { query: async (sql) => (/due_date = \$1/.test(sql) && !/streak_count/.test(sql) ? { rows: [row] } : { rows: [] }) };
    a.use(notifRoutes({ pool }));
    return a;
  }
  const row = { id: 7, title: "Pay rent", due_date: "2026-10-29" };

  it("under the shell: kind + notify per entry and the quiet flag, from Perfin's settings", async () => {
    // Quiet hours around the real current hour, so the route's own clock is inside them.
    const H = new Date().getUTCHours();
    const hh = (k) => String(((H + k) % 24 + 24) % 24).padStart(2, "0") + ":00";
    const perfinPool = { query: async (sql) => (/notify_quiet_hours/.test(sql)
      ? { rows: [{ notify_quiet_hours: { enabled: true, start: hh(-1), end: hh(2) }, notify_muted_types: [] }] } : { rows: [] }) };
    const body = (await supertest(app(perfinPool, row)).get("/api/notifications/check").expect(200)).body;
    assert.equal(body.quiet, true);
    const due = body.notifications.find((n) => n.type === "due_today");
    assert.deepEqual([due.kind, due.notify, due.title], ["tasks", false, "Pay rent"], "still listed, not notified");
  });

  it("standalone: every entry may notify, quiet false", async () => {
    const body = (await supertest(app(null, row)).get("/api/notifications/check").expect(200)).body;
    assert.equal(body.quiet, false);
    assert.ok(body.notifications.length > 0);
    assert.ok(body.notifications.every((n) => n.notify === true));
  });
});

describe("the dashboard and Settings", () => {
  const src = require("../pages/dashboard-script.js");
  function extract(name) {
    const i = src.indexOf("function " + name + "(");
    let depth = 0;
    const j = src.indexOf("{", i);
    for (let k = j; k < src.length; k++) {
      if (src[k] === "{") depth++;
      else if (src[k] === "}") { depth--; if (depth === 0) return src.slice(i, k + 1); }
    }
    return null;
  }
  // eslint-disable-next-line no-new-func
  const isImportantReminder = new Function(extract("isImportantReminder") + "\nreturn isImportantReminder;")();

  it("a notify:false entry raises no browser notification; others unchanged", () => {
    assert.equal(isImportantReminder({ type: "overdue", notify: false }), false);
    assert.equal(isImportantReminder({ type: "overdue", notify: true }), true);
    assert.equal(isImportantReminder({ type: "overdue" }), true, "an older server without the field");
    assert.equal(isImportantReminder({ type: "housing_due", status: "overdue", notify: false }), false);
  });

  it("the Reminders list still renders every entry (no notify filter there)", () => {
    const fn = extract("renderReminders");
    assert.ok(fn && fn.length > 50);
    assert.doesNotMatch(fn, /notify/);
  });

  it("Settings points to Perfin's section under the shell only", () => {
    const page = fs.readFileSync(path.join(__dirname, "..", "pages", "settings.js"), "utf8");
    assert.match(page, /\$\{req\.app\.get\("embedded"\) \? '<p [^']*id="quiet-hours-link">Quiet hours and muting for both apps are set in <a href="\/perfin\/settings#quiet-hours-section">Perfin Settings<\/a>\.<\/p>' : ''\}/);
  });
});
