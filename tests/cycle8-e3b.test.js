// ============================================================================
// Cycle 8 E3b (G2) — Perfin delivery honours quiet hours and mutes
// ============================================================================
// sendToAll over a stateful fake notification_log + a stubbed web-push: every
// notification is still logged (`logged` unchanged); push_state records sent /
// held / muted / none; a held push isn't sent and opens the release gate until
// quiet hours end; security and test kinds are never held or muted; a failed
// settings read holds and mutes nothing; a hold whose row couldn't be written
// is pushed at once. releaseHeldNotifications: nothing while still quiet; one
// held row pushed as itself, several as ONE summary; a hold older than 12 h
// expired; a kind muted since marked muted; a failed push leaves the rows held;
// a hold made during a release keeps the gate open. The critical-alert email
// skips a muted kind; every caller names its kind; PATCH /api/settings drops
// the cached prefs; the notify-release job's wiring and outcome. The
// database-backed half is tests/contract/notify-e3b.contract.test.js.
// ============================================================================
if (!process.env.NEON_DATABASE_URL) process.env.NEON_DATABASE_URL = "postgres://mock:mock@localhost/mock";
if (!process.env.TOKEN_ENCRYPTION_PASSPHRASE) process.env.TOKEN_ENCRYPTION_PASSPHRASE = "test-passphrase";
process.env.APP_TIMEZONE = "UTC";

const { describe, it, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const Module = require("module");
const express = require("express");
const supertest = require("supertest");

const read = (...p) => fs.readFileSync(path.join(__dirname, "..", ...p), "utf8");
const dbModule = require("../teller/services/database");
const originalQuery = dbModule.pool.query;
const NOTIF = require.resolve("../teller/routes/notifications");

// A fake notification_log + settings + subscriptions, answering the SQL the
// module sends. `clock` is the database's now() for created_at.
function fakeDb() {
  const db = {
    clock: new Date("2026-10-29T23:00:00Z"),
    log: [], nextId: 1,
    prefs: { notify_quiet_hours: { enabled: true, start: "22:00", end: "07:00" }, notify_muted_types: [] },
    prefsThrows: false, insertThrows: false,
    subs: [{ endpoint: "https://push.example/ok", keys: { endpoint: "https://push.example/ok" } }],
    queries: [],
  };
  db.query = async (sql, params = []) => {
    db.queries.push(sql);
    if (/SELECT notify_quiet_hours, notify_muted_types FROM user_settings/.test(sql)) {
      if (db.prefsThrows) throw new Error("settings down");
      return { rows: [db.prefs] };
    }
    if (/^INSERT INTO notification_log/.test(sql)) {
      if (db.insertThrows) throw new Error("insert failed");
      const [type, title, body, data, push_state, item_key = null, is_read = false] = params;
      db.log.push({ id: db.nextId++, type, title, body, data: JSON.parse(data), push_state, item_key, is_read, created_at: new Date(db.clock) });
      return { rows: [] };
    }
    if (/SET push_state = 'expired'/.test(sql)) {
      const cut = new Date(params[0]).getTime() - params[1] * 3600 * 1000;
      const hit = db.log.filter((r) => r.push_state === "held" && r.created_at.getTime() < cut);
      hit.forEach((r) => { r.push_state = "expired"; });
      return { rows: hit.map((r) => ({ id: r.id })) };
    }
    if (/SELECT id, type, title, body, data, item_key FROM notification_log/.test(sql)) {
      return { rows: db.log.filter((r) => r.push_state === "held").sort((a, b) => a.created_at - b.created_at || a.id - b.id).slice(0, params[0]) };
    }
    const m = /UPDATE notification_log SET push_state = '(\w+)' WHERE id = ANY/.exec(sql);
    if (m) {
      db.log.filter((r) => params[0].includes(r.id) && r.push_state === "held").forEach((r) => { r.push_state = m[1]; if (/is_read = true/.test(sql)) r.is_read = true; });
      return { rows: [] };
    }
    if (/SELECT endpoint, keys FROM push_subscriptions/.test(sql)) return { rows: db.subs };
    return { rows: [] };
  };
  return db;
}

let notifications, db, pushed, pushFails, onPush, origLoad;
function load({ vapid = true } = {}) {
  if (vapid) { process.env.VAPID_PUBLIC_KEY = "pub"; process.env.VAPID_PRIVATE_KEY = "priv"; }
  else { delete process.env.VAPID_PUBLIC_KEY; delete process.env.VAPID_PRIVATE_KEY; }
  delete require.cache[NOTIF];
  notifications = require(NOTIF);
}
before(() => {
  origLoad = Module._load;
  Module._load = function (request) {
    if (request === "web-push") {
      return {
        setVapidDetails() {},
        async sendNotification(sub, payload) {
          if (onPush) { const f = onPush; onPush = null; await f(); }
          if (pushFails) { const e = new Error("network"); e.statusCode = 500; throw e; }
          pushed.push(JSON.parse(payload));
        },
      };
    }
    return origLoad.apply(this, arguments);
  };
});
after(() => {
  Module._load = origLoad;
  dbModule.pool.query = originalQuery;
  delete process.env.VAPID_PUBLIC_KEY; delete process.env.VAPID_PRIVATE_KEY;
  delete require.cache[NOTIF];
});
beforeEach(() => {
  db = fakeDb();
  dbModule.pool.query = db.query;
  pushed = []; pushFails = false; onPush = null;
  load();
  notifications._release.reset({ heldPending: false });
});

const QUIET = new Date("2026-10-29T23:00:00Z");
const DAY = new Date("2026-10-30T12:00:00Z");

// ---------------------------------------------------------------------------
describe("sendToAll", () => {
  it("outside quiet hours: logged and pushed (push_state sent)", async () => {
    const r = await notifications.sendToAll({ title: "Low cash ahead", body: "b", tag: "cash-low", data: { url: "/dashboard" } }, { now: DAY });
    assert.deepEqual(r, { sent: 1, failed: 0, logged: true, push_state: "sent" });
    assert.equal(db.log[0].push_state, "sent");
    assert.equal(pushed.length, 1);
  });

  it("in quiet hours: logged, not pushed, held; the gate opens at the end of quiet hours", async () => {
    const r = await notifications.sendToAll({ title: "Low cash ahead", body: "b", tag: "cash-low" }, { now: QUIET });
    assert.deepEqual(r, { sent: 0, failed: 0, logged: true, push_state: "held" });
    assert.equal(db.log[0].push_state, "held");
    assert.equal(pushed.length, 0);
    const st = notifications._release.state();
    assert.equal(st.heldPending, true);
    assert.equal(new Date(st.releaseNotBefore).toISOString(), "2026-10-30T07:00:00.000Z");
    assert.equal(notifications.releaseDue(QUIET.getTime()), false, "no release before 07:00");
    assert.equal(notifications.releaseDue(Date.parse("2026-10-30T07:00:00Z")), true);
  });

  it("a muted kind: logged, never pushed (push_state muted)", async () => {
    db.prefs.notify_muted_types = ["spending"];
    const r = await notifications.sendToAll({ title: "Unusual charge", body: "b", tag: "anomaly-acme" }, { now: DAY });
    assert.deepEqual(r, { sent: 0, failed: 0, logged: true, push_state: "muted" });
    assert.equal(db.log[0].push_state, "muted");
    assert.equal(pushed.length, 0);
    assert.equal(notifications._release.state().heldPending, false, "a mute opens no release");
  });

  it("security and the test notification are pushed during quiet hours, muted or not", async () => {
    db.prefs.notify_muted_types = ["security", "test", "other"];
    for (const tag of ["pin-lockout", "test"]) {
      const r = await notifications.sendToAll({ title: tag, body: "b", tag }, { now: QUIET });
      assert.equal(r.push_state, "sent", tag);
    }
    assert.equal(pushed.length, 2);
  });

  it("a settings read that fails holds and mutes nothing", async () => {
    db.prefsThrows = true;
    const quiet = console.error; console.error = () => {};
    try {
      const r = await notifications.sendToAll({ title: "t", body: "b", tag: "cash-low" }, { now: QUIET });
      assert.equal(r.push_state, "sent");
    } finally { console.error = quiet; }
  });

  it("a hold whose row couldn't be written is pushed at once", async () => {
    db.insertThrows = true;
    const quiet = console.error; console.error = () => {};
    try {
      const r = await notifications.sendToAll({ title: "t", body: "b", tag: "cash-low" }, { now: QUIET });
      assert.deepEqual(r, { sent: 1, failed: 0, logged: false, push_state: "sent" });
    } finally { console.error = quiet; }
  });

  it("push not configured: logged as none (muted still muted)", async () => {
    load({ vapid: false });
    notifications._release.reset({ heldPending: false });
    assert.equal((await notifications.sendToAll({ title: "t", body: "b", tag: "cash-low" }, { now: QUIET })).push_state, "none");
    db.prefs.notify_muted_types = ["cash"];
    notifications.invalidateNotifyPrefs();
    assert.equal((await notifications.sendToAll({ title: "t", body: "b", tag: "cash-low" }, { now: QUIET })).push_state, "muted");
    assert.equal(notifications._release.state().heldPending, false);
  });

  it("the prefs are read once a minute; invalidateNotifyPrefs drops them and the release wait", async () => {
    await notifications.sendToAll({ title: "a", body: "b", tag: "cash-low" }, { now: QUIET });
    await notifications.sendToAll({ title: "a", body: "b", tag: "cash-low" }, { now: QUIET });
    const reads = () => db.queries.filter((q) => /notify_quiet_hours/.test(q)).length;
    assert.equal(reads(), 1);
    assert.ok(notifications._release.state().releaseNotBefore > 0);
    notifications.invalidateNotifyPrefs();
    assert.equal(notifications._release.state().releaseNotBefore, 0);
    await notifications.sendToAll({ title: "a", body: "b", tag: "test" }, { now: DAY });
    assert.equal(reads(), 2);
  });
});

// ---------------------------------------------------------------------------
describe("releaseHeldNotifications", () => {
  async function hold(title, tag, data, minutesAgo = 0) {
    db.clock = new Date(QUIET.getTime() - minutesAgo * 60000);
    await notifications.sendToAll({ title, body: title + " body", tag, data }, { now: QUIET });
  }

  it("still in quiet hours: nothing pushed, the wait moved to the end", async () => {
    await hold("Low cash ahead", "cash-low", { url: "/dashboard" });
    notifications._release.reset({ heldPending: true });
    const r = await notifications.releaseHeldNotifications({ now: new Date("2026-10-30T05:30:00Z") });
    assert.equal(r.outcome, "quiet");
    assert.equal(pushed.length, 0);
    assert.equal(new Date(notifications._release.state().releaseNotBefore).toISOString(), "2026-10-30T07:00:00.000Z");
  });

  it("one held notification is pushed as itself and marked sent; the gate closes", async () => {
    await hold("Low cash ahead", "cash-low", { url: "/dashboard" });
    const r = await notifications.releaseHeldNotifications({ now: new Date("2026-10-30T07:05:00Z") });
    assert.deepEqual(r, { ok: true, outcome: "released", released: 1, expired: 0 });
    assert.deepEqual(pushed, [{ title: "Low cash ahead", body: "Low cash ahead body", tag: "cash-low", data: { url: "/dashboard" } }]);
    assert.equal(db.log[0].push_state, "sent");
    assert.equal(notifications._release.state().heldPending, false);
    assert.equal((await notifications.releaseHeldNotifications({ now: new Date("2026-10-30T07:10:00Z") })).outcome, "none", "nothing twice");
    assert.equal(pushed.length, 1);
  });

  it("several held notifications are ONE summary push, newest first, the newest's link", async () => {
    await hold("Unusual charge", "anomaly-acme", { url: "/transactions" }, 50);
    await hold("Low cash ahead", "cash-low", { url: "/dashboard" }, 40);
    await hold("Paycheck landed", "payday-ab", { url: "/transactions" }, 30);
    await hold("Your plan changed", "advice-plan", { url: "/advice" }, 20);
    const r = await notifications.releaseHeldNotifications({ now: new Date("2026-10-30T07:05:00Z") });
    assert.equal(r.released, 4);
    assert.deepEqual(pushed, [{
      title: "4 notifications during quiet hours",
      body: "Your plan changed · Paycheck landed · Low cash ahead · +1 more",
      tag: "quiet-summary",
      data: { url: "/advice" },
    }]);
    assert.ok(db.log.every((h) => h.push_state === "sent"));
  });

  it("a hold older than 12 hours is left in the bell (expired), not pushed late", async () => {
    await hold("Old", "cash-low", {}, 13 * 60);
    await hold("New", "cash-low", {});
    const r = await notifications.releaseHeldNotifications({ now: new Date("2026-10-30T07:05:00Z") });
    assert.deepEqual([r.released, r.expired], [1, 1]);
    assert.deepEqual(db.log.map((h) => h.push_state), ["expired", "sent"]);
    assert.equal(pushed[0].title, "New");
  });

  it("a kind muted while held is marked muted, not pushed", async () => {
    await hold("Unusual charge", "anomaly-acme", {});
    db.prefs.notify_muted_types = ["spending"];
    const r = await notifications.releaseHeldNotifications({ now: new Date("2026-10-30T07:05:00Z") });
    assert.equal(r.released, 0);
    assert.equal(db.log[0].push_state, "muted");
    assert.equal(pushed.length, 0);
  });

  it("a failed push leaves the rows held and the gate open (retried)", async () => {
    await hold("Low cash ahead", "cash-low", {});
    pushFails = true;
    const quiet = console.error; console.error = () => {};
    try {
      const r = await notifications.releaseHeldNotifications({ now: new Date("2026-10-30T07:05:00Z") });
      assert.equal(r.ok, false);
      assert.equal(r.outcome, "failed");
    } finally { console.error = quiet; }
    assert.equal(db.log[0].push_state, "held");
    assert.equal(notifications._release.state().heldPending, true);
    pushFails = false;
    assert.equal((await notifications.releaseHeldNotifications({ now: new Date("2026-10-30T07:20:00Z") })).released, 1);
  });

  it("a hold made while a release is pushing keeps the gate open", async () => {
    await hold("First", "cash-low", {});
    onPush = () => notifications.sendToAll({ title: "Second", body: "b", tag: "cash-low" }, { now: QUIET });
    await notifications.releaseHeldNotifications({ now: new Date("2026-10-30T07:05:00Z") });
    assert.equal(notifications._release.state().heldPending, true);
  });

  it("quiet hours switched off: held rows go out at once", async () => {
    await hold("Low cash ahead", "cash-low", {});
    db.prefs.notify_quiet_hours = { enabled: false, start: "22:00", end: "07:00" };
    notifications.invalidateNotifyPrefs();
    assert.equal(notifications.releaseDue(QUIET.getTime()), true);
    assert.equal((await notifications.releaseHeldNotifications({ now: QUIET })).released, 1);
  });
});

// ---------------------------------------------------------------------------
describe("the critical-alert email", () => {
  const persistent = require("../teller/routes/persistent");
  function settings(row) {
    const calls = [];
    dbModule.pool.query = async (sql) => { calls.push(sql); if (/critical_alert_emails_enabled/.test(sql)) return { rows: [row] }; throw new Error("no webhook in this test"); };
    return calls;
  }

  it("a muted kind sends no email — one settings read, by tag or by kind", async () => {
    const calls = settings({ critical_alert_emails_enabled: true, notify_muted_types: ["bills", "spending"] });
    assert.deepEqual(await persistent.sendCriticalAlertEmail("t", "b", { tag: "sub-still-charging-3" }), { sent: false, reason: "muted" });
    assert.deepEqual(await persistent.sendCriticalAlertEmail("t", "b", { kind: "spending" }), { sent: false, reason: "muted" });
    assert.equal(calls.length, 2);
  });

  it("a kind that isn't muted, or no kind given, goes on to the send", async () => {
    settings({ critical_alert_emails_enabled: true, notify_muted_types: ["bills"] });
    const quiet = console.error; console.error = () => {};
    try {
      for (const opts of [{ tag: "cash-low" }, undefined]) {
        const r = await persistent.sendCriticalAlertEmail("t", "b", opts);
        assert.notEqual(r.reason, "muted");
      }
    } finally { console.error = quiet; }
  });

  it("every caller names its kind", () => {
    assert.match(read("teller", "startup.js"), /budget \(" \+ shownPct \+ "%\) this month\.",\s*\{ tag \}\s*\)/);
    assert.match(read("teller", "routes", "enrollments.js"), /lines,\s*\{ kind: "spending" \}\s*\)/);
    assert.match(read("teller", "routes", "subscriptions.js"), /sendCriticalAlertEmail\(title, body, \{ tag: "sub-still-charging-" \+ r\.id \}\)/);
    assert.match(read("teller", "services", "cash-alerts.js"), /sendEmail\("Low cash ahead", body, \{ tag: TAG \}\)/);
    assert.match(read("teller", "services", "payday-alerts.js"), /sendEmail\("Payday missed\?", body, \{ tag \}\)/);
  });
});

// ---------------------------------------------------------------------------
describe("wiring", () => {
  it("PATCH /api/settings drops the cached prefs and the release wait", async () => {
    notifications._release.reset({ heldPending: true, releaseNotBefore: Date.now() + 3600000 });
    dbModule.pool.query = async () => ({ rows: [{}] });
    const app = express(); app.use(express.json()); app.use(require("../teller/routes/settings"));
    await supertest(app).patch("/api/settings").send({ notify_quiet_hours: { enabled: false, start: "22:00", end: "07:00" } }).expect(200);
    assert.equal(notifications._release.state().releaseNotBefore, 0);
  });

  it("notify-release: every 15 minutes, gated on releaseDue, not on activity", () => {
    const jobHealth = require("../teller/services/job-health");
    assert.equal(jobHealth.JOB_INTERVALS_MS["notify-release"], 15 * 60 * 1000);
    const src = read("teller", "startup.js");
    assert.match(src, /\["notify-release", runNotifyReleaseTick, heldReady\]/);
    assert.match(src, /const heldReady = \(\) => require\("\.\/routes\/notifications"\)\.releaseDue\(\);/);
  });

  it("the job records an outcome only when it pushed or failed to", async () => {
    const jobHealth = require("../teller/services/job-health");
    const startup = require("../teller/startup");
    const real = notifications.releaseHeldNotifications;
    try {
      for (const [r, want] of [
        [{ ok: true, outcome: "none" }, undefined],
        [{ ok: true, outcome: "quiet" }, undefined],
        [{ ok: true, outcome: "released", released: 2 }, "ok"],
        [{ ok: false, outcome: "failed", error: "x" }, "error"],
      ]) {
        jobHealth._memoryResults.delete("notify-release");
        notifications.releaseHeldNotifications = async () => r;
        await startup._awayJobs.runNotifyReleaseTick();
        const got = jobHealth._memoryResults.get("notify-release");
        assert.equal(got && got.status, want, r.outcome);
      }
    } finally { notifications.releaseHeldNotifications = real; }
  });
});
