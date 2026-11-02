// Real-Postgres contract test for cycle-8 E3b (G2) — quiet hours and mutes on
// the real schema, set through PATCH /api/settings in the production mount
// order, with web-push stubbed:
//  - a push sent inside quiet hours is logged held and not pushed; it goes
//    out once after they end and not again
//  - pin-lockout is pushed during quiet hours
//  - a muted kind is logged muted, never pushed, and its critical-alert email
//    is skipped
//  - a fresh process (a restart) releases rows held before it
//  - a hold older than 12 hours expires on the real SQL
//  - the push_state CHECK refuses another value
const Module = require("module");
const pushed = [];
const origLoad = Module._load;
Module._load = function (request) {
  if (request === "web-push") {
    return { setVapidDetails() {}, async sendNotification(_sub, payload) { pushed.push(JSON.parse(payload)); } };
  }
  return origLoad.apply(this, arguments);
};
process.env.VAPID_PUBLIC_KEY = "pub";
process.env.VAPID_PRIVATE_KEY = "priv";

const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const supertest = require("supertest");
const { SKIP, ROOT, perfinDb, perfinApp } = require("./_setup");

describe("quiet hours and mutes (cycle-8 E3b) on real Postgres", { skip: SKIP }, () => {
  let pool, app, notifications;
  const NOTIF = path.join(ROOT, "teller/routes/notifications");
  const q = (s, p) => pool.query(s, p);
  const states = async () => (await q("SELECT type, push_state FROM notification_log ORDER BY id")).rows;
  // created_at is the database's real now(), so every time is relative to the
  // real clock: quiet hours run from an hour ago to two hours from now (UTC).
  const H = new Date().getUTCHours();
  const hh = (k) => String(((H + k) % 24 + 24) % 24).padStart(2, "0") + ":00";
  const QUIET = { enabled: true, start: hh(-1), end: hh(2) };
  const at = (hours) => ({ now: new Date(Date.now() + hours * 3600 * 1000) });

  before(async () => {
    pool = await perfinDb("notify_e3b");
    app = perfinApp();
    notifications = require(NOTIF);
    notifications._release.reset({ heldPending: false });
    await q("INSERT INTO push_subscriptions (endpoint, keys) VALUES ('https://push.example/1', $1)",
      [JSON.stringify({ endpoint: "https://push.example/1", keys: {} })]);
    await supertest(app).patch("/api/settings")
      .send({ notify_quiet_hours: QUIET }).expect(200);
  });
  after(async () => { Module._load = origLoad; if (pool) await pool.end(); });

  it("the settings are stored and read back normalized", async () => {
    const r = (await supertest(app).get("/api/settings").expect(200)).body;
    assert.deepEqual(r.notify_quiet_hours, QUIET);
    assert.deepEqual(r.notify_muted_types, []);
    await supertest(app).patch("/api/settings").send({ notify_muted_types: ["security"] }).expect(400);
  });

  it("held inside quiet hours, pushed once after they end; pin-lockout pushed during them", async () => {
    const held = await notifications.sendToAll({ title: "Low cash ahead", body: "b", tag: "cash-low", data: { url: "/dashboard" } }, at(0));
    assert.deepEqual([held.logged, held.push_state], [true, "held"]);
    const lock = await notifications.sendToAll({ title: "PIN login locked", body: "b", tag: "pin-lockout" }, at(0));
    assert.equal(lock.push_state, "sent");
    assert.deepEqual(pushed.map((p) => p.tag), ["pin-lockout"]);
    assert.deepEqual(await states(), [{ type: "cash-low", push_state: "held" }, { type: "pin-lockout", push_state: "sent" }]);

    assert.equal((await notifications.releaseHeldNotifications(at(1))).outcome, "quiet");
    assert.equal(pushed.length, 1);
    const r = await notifications.releaseHeldNotifications(at(2.5));
    assert.equal(r.released, 1);
    assert.deepEqual(pushed.map((p) => p.tag), ["pin-lockout", "cash-low"]);
    assert.equal((await notifications.releaseHeldNotifications(at(2.75))).released, 0);
    assert.equal(pushed.length, 2);
    assert.equal((await states())[0].push_state, "sent");
  });

  it("a muted kind is logged muted, never pushed, and its email is skipped", async () => {
    await supertest(app).patch("/api/settings").send({ notify_muted_types: ["spending"] }).expect(200);
    const before = pushed.length;
    const r = await notifications.sendToAll({ title: "Unusual charge", body: "b", tag: "anomaly-acme" }, at(5));
    assert.deepEqual([r.logged, r.push_state], [true, "muted"]);
    assert.equal(pushed.length, before);
    assert.equal((await q("SELECT 1 FROM notification_log WHERE type = 'anomaly-acme'")).rows.length, 1, "still the dedup marker");

    await q("UPDATE user_settings SET critical_alert_emails_enabled = true WHERE id = 1");
    const persistent = require(path.join(ROOT, "teller/routes/persistent"));
    assert.deepEqual(await persistent.sendCriticalAlertEmail("Unusual charge", "b", { kind: "spending" }), { sent: false, reason: "muted" });
    assert.notEqual((await persistent.sendCriticalAlertEmail("Low cash ahead", "b", { tag: "cash-low" })).reason, "muted");
    await supertest(app).patch("/api/settings").send({ notify_muted_types: null }).expect(200);
  });

  it("a fresh process releases rows held before it (the gate is open at boot)", async () => {
    await notifications.sendToAll({ title: "Paycheck landed", body: "b", tag: "payday-ab" }, at(0));
    delete require.cache[require.resolve(NOTIF)];
    const fresh = require(NOTIF);
    assert.equal(fresh.releaseDue(), true);
    const n = pushed.length;
    const r = await fresh.releaseHeldNotifications(at(2.5));
    assert.equal(r.released, 1);
    assert.equal(pushed[n].title, "Paycheck landed");
    assert.equal(fresh.releaseDue(), false, "nothing left: the gate closes");
    notifications = fresh;
  });

  it("a hold older than 12 hours expires on the real SQL; switching quiet hours off releases the rest", async () => {
    await q("INSERT INTO notification_log (type, title, body, data, push_state, created_at) VALUES ('cash-low', 'Old', '', '{}', 'held', now() - interval '13 hours')");
    await q("INSERT INTO notification_log (type, title, body, data, push_state) VALUES ('cash-low', 'Recent', '', '{}', 'held')");
    await supertest(app).patch("/api/settings")
      .send({ notify_quiet_hours: { enabled: false, start: "22:00", end: "07:00" } }).expect(200);
    notifications._release.reset({ heldPending: true });
    const n = pushed.length;
    const r = await notifications.releaseHeldNotifications({ now: new Date() });
    assert.deepEqual([r.released, r.expired], [1, 1]);
    assert.equal(pushed[n].title, "Recent");
    const rows = (await q("SELECT title, push_state FROM notification_log WHERE title IN ('Old', 'Recent') ORDER BY title")).rows;
    assert.deepEqual(rows, [{ title: "Old", push_state: "expired" }, { title: "Recent", push_state: "sent" }]);
  });

  it("the push_state CHECK refuses another value", async () => {
    await assert.rejects(q("INSERT INTO notification_log (type, title, body, push_state) VALUES ('t', 't', '', 'later')"), /push_state/);
  });
});
