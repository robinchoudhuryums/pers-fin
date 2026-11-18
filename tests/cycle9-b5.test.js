// ============================================================================
// Cycle 9 broad scan, Batch 5 — notifications and settings
// ============================================================================
//  F44 — a waiting push expires 12 hours past the END of the quiet window it
//        was created in (it was 12 hours from creation, so with a window of 12
//        hours or more everything held early in it was never pushed)
//  F46 — a push that failed on every device is kept ('retry') and pushed by the
//        release job; "nobody subscribed" and dead subscriptions are not
//  F34 — the rent reminder's window, tag and item follow the OLDEST unpaid month
//  F45 — a linked task covers a push only while it is showing (due that day or
//        earlier); the day rides along to Per-sistant's one predicate
//  F47 — GET /api/settings is a 500 on a failed read; the two toggle maps are
//        merged server-side and the page sends one key; ten switches and the
//        idle timeout parse strictly
//  F48 — db/030's trigger clears auto_closed on a hand change (+ the repair)
//  F49 — a non-string SSO token is a 400, not a crash; the minutes to the end
//        of quiet hours are real minutes on a night the clocks change
// The database-backed half is tests/contract/c9-batch5.contract.test.js; the
// Per-sistant side apps/per-sistant/tests/cycle9-b5.test.js.
// ============================================================================
if (!process.env.NEON_DATABASE_URL) process.env.NEON_DATABASE_URL = "postgres://mock:mock@localhost/mock";
if (!process.env.TOKEN_ENCRYPTION_PASSPHRASE) process.env.TOKEN_ENCRYPTION_PASSPHRASE = "test-passphrase";
process.env.APP_TIMEZONE = "UTC";

const { describe, it, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const Module = require("module");
const { execFileSync } = require("child_process");
const express = require("express");
const supertest = require("supertest");

const ROOT = path.join(__dirname, "..");
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), "utf8");
const slice = (src, from, to) => {
  const a = src.indexOf(from); const b = src.indexOf(to, a);
  assert.ok(a >= 0 && b > a, "markers not found: " + from);
  return src.slice(a, b);
};
const dbModule = require("../teller/services/database");
const originalQuery = dbModule.pool.query;
const NOTIF = require.resolve("../teller/routes/notifications");
const persistent = require("../teller/routes/persistent");
const notifyPrefs = require("../teller/services/notify-prefs");

const WAITING = ["held", "retry"];
// A fake notification_log + settings + subscriptions, answering the SQL the
// module sends (the shape tests/cycle8-e3b uses). `clock` is created_at.
function fakeDb() {
  const db = {
    clock: new Date("2026-10-29T12:00:00Z"),
    log: [], nextId: 1, queries: [], deleted: [],
    prefs: { notify_quiet_hours: { enabled: true, start: "19:00", end: "08:00" }, notify_muted_types: [] },
    subs: [{ endpoint: "https://push.example/ok", keys: { endpoint: "https://push.example/ok" } }],
    subsThrow: false, stateUpdateThrows: false,
  };
  db.query = async (sql, params = []) => {
    db.queries.push(sql);
    if (/SELECT notify_quiet_hours, notify_muted_types FROM user_settings/.test(sql)) return { rows: [db.prefs] };
    if (/^INSERT INTO notification_log/.test(sql)) {
      const [type, title, body, data, push_state, item_key = null, is_read = false] = params;
      const id = db.nextId++;
      db.log.push({ id, type, title, body, data: JSON.parse(data), push_state, item_key, is_read, created_at: new Date(db.clock) });
      return { rows: [{ id }] };
    }
    if (/SELECT id, type, title, body, data, item_key, push_state, created_at FROM notification_log\s+WHERE push_state IN \('held', 'retry'\)/.test(sql)) {
      return { rows: db.log.filter((r) => WAITING.includes(r.push_state)).sort((a, b) => a.created_at - b.created_at || a.id - b.id).slice(0, params[0]) };
    }
    const m = /UPDATE notification_log SET push_state = '(\w+)'(?:, is_read = true)? WHERE id = ANY\(\$1::int\[\]\) AND push_state (?:= '(\w+)'|IN \('held', 'retry'\))/.exec(sql);
    if (m) {
      if (db.stateUpdateThrows) throw new Error("update failed");
      const from = m[2] ? [m[2]] : WAITING;
      db.log.filter((r) => params[0].includes(r.id) && from.includes(r.push_state)).forEach((r) => { r.push_state = m[1]; });
      return { rows: [] };
    }
    if (/SELECT endpoint, keys FROM push_subscriptions/.test(sql)) {
      if (db.subsThrow) throw new Error("subscriptions down");
      return { rows: db.subs };
    }
    if (/DELETE FROM push_subscriptions/.test(sql)) { db.deleted.push(params[0]); return { rows: [] }; }
    return { rows: [] };
  };
  return db;
}

let notifications, db, pushed, pushStatus, origLoad;
const quietly = async (fn) => {
  const e = console.error; console.error = () => {};
  try { return await fn(); } finally { console.error = e; }
};
function loadNotifications() {
  process.env.VAPID_PUBLIC_KEY = "pub"; process.env.VAPID_PRIVATE_KEY = "priv";
  delete require.cache[NOTIF];
  notifications = require(NOTIF);
  notifications._release.reset({ heldPending: false });
}
before(() => {
  origLoad = Module._load;
  Module._load = function (request) {
    if (request === "web-push") {
      return {
        setVapidDetails() {},
        async sendNotification(sub, payload) {
          // pushStatus: null → delivered; a number → that push-service status.
          if (pushStatus) { const e = new Error("push " + pushStatus); e.statusCode = pushStatus; throw e; }
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
  persistent.setEmbeddedPersistentPool(null);
  delete process.env.VAPID_PUBLIC_KEY; delete process.env.VAPID_PRIVATE_KEY;
  delete require.cache[NOTIF];
});
beforeEach(() => {
  db = fakeDb();
  dbModule.pool.query = db.query;
  pushed = []; pushStatus = null;
  persistent.setEmbeddedPersistentPool(null);
  loadNotifications();
});

const at = (iso) => new Date(iso);
// Send one notification "at" a time: created_at and the clock agree.
async function sendAt(iso, payload) {
  db.clock = at(iso);
  return notifications.sendToAll({ body: "b", ...payload }, { now: at(iso) });
}

// ---------------------------------------------------------------------------
describe("F44 — a hold expires 12 hours past the end of its quiet window", () => {
  // Quiet hours 19:00-08:00 — 13 hours, which PATCH /api/settings accepts.
  it("a push held 30 minutes into a 13-hour window is pushed when the window ends", async () => {
    const r = await sendAt("2026-10-29T19:30:00Z", { title: "Low cash ahead", tag: "cash-low", data: { url: "/dashboard" } });
    assert.equal(r.push_state, "held");
    // 12 h 35 min after it was created — it used to be marked expired here.
    const rel = await notifications.releaseHeldNotifications({ now: at("2026-10-30T08:05:00Z") });
    assert.deepEqual(rel, { ok: true, outcome: "released", released: 1, expired: 0 });
    assert.equal(db.log[0].push_state, "sent");
    assert.deepEqual(pushed.map((p) => p.title), ["Low cash ahead"]);
  });

  it("every hold of the night goes out together, the 19:05 one included", async () => {
    await sendAt("2026-10-29T19:05:00Z", { title: "Budget exceeded", tag: "budget-alert-dining-critical" });
    await sendAt("2026-10-29T23:40:00Z", { title: "Unusual charge", tag: "anomaly-acme" });
    await sendAt("2026-10-30T06:10:00Z", { title: "Paycheck landed", tag: "payday-ab" });
    const rel = await notifications.releaseHeldNotifications({ now: at("2026-10-30T08:00:00Z") });
    assert.deepEqual([rel.released, rel.expired], [3, 0]);
    assert.equal(pushed.length, 1);
    assert.equal(pushed[0].title, "3 notifications during quiet hours");
  });

  it("still expires — 12 hours after the window ended, not after the push was made", async () => {
    await sendAt("2026-10-29T19:30:00Z", { title: "Old", tag: "cash-low" });
    // The host slept: the first release is at 20:01 the next day… but that is
    // inside the next quiet window, so the job waits; at 08:05 the day after
    // the hold is 24 h past its window.
    assert.equal((await notifications.releaseHeldNotifications({ now: at("2026-10-30T20:01:00Z") })).outcome, "quiet");
    const rel = await notifications.releaseHeldNotifications({ now: at("2026-10-31T08:05:00Z") });
    assert.deepEqual([rel.outcome, rel.released, rel.expired], ["expired", 0, 1]);
    assert.equal(db.log[0].push_state, "expired");
    assert.equal(pushed.length, 0);
  });

  it("the edge: 11 h 59 min past the window's end is pushed, 12 h 01 min is not", async () => {
    db.prefs.notify_quiet_hours = { enabled: true, start: "01:00", end: "02:00" };
    notifications.invalidateNotifyPrefs();
    await sendAt("2026-10-29T01:30:00Z", { title: "A", tag: "cash-low" });
    assert.equal((await notifications.releaseHeldNotifications({ now: at("2026-10-29T13:59:00Z") })).released, 1);
    await sendAt("2026-10-30T01:30:00Z", { title: "B", tag: "cash-low" });
    const rel = await notifications.releaseHeldNotifications({ now: at("2026-10-30T14:01:00Z") });
    assert.deepEqual([rel.released, rel.expired], [0, 1]);
  });

  it("quiet hours changed since the hold: its own creation time is the base", async () => {
    await sendAt("2026-10-29T19:30:00Z", { title: "Held", tag: "cash-low" });
    db.prefs.notify_quiet_hours = { enabled: false, start: "19:00", end: "08:00" };
    notifications.invalidateNotifyPrefs();
    // Switched off 13 hours later: nothing says the window ran until 08:00.
    const rel = await notifications.releaseHeldNotifications({ now: at("2026-10-30T08:31:00Z") });
    assert.deepEqual([rel.released, rel.expired], [0, 1]);
    // …and one switched off sooner goes out at once.
    await sendAt("2026-10-30T08:40:00Z", { title: "x", tag: "test" }); // never held; keeps the fake honest
    db.prefs.notify_quiet_hours = { enabled: true, start: "19:00", end: "08:00" };
    notifications.invalidateNotifyPrefs();
    await sendAt("2026-10-30T19:30:00Z", { title: "Held again", tag: "cash-low" });
    db.prefs.notify_quiet_hours = { enabled: false, start: "19:00", end: "08:00" };
    notifications.invalidateNotifyPrefs();
    assert.equal((await notifications.releaseHeldNotifications({ now: at("2026-10-30T21:00:00Z") })).released, 1);
  });

  it("no expiry SQL is left: the decision is per row, in code", () => {
    const src = read("teller", "routes", "notifications.js");
    assert.doesNotMatch(src, /created_at < \$1::timestamptz - make_interval/);
    assert.match(src, /const stale = waiting\.filter\(\(h\) => holdExpired\(h\.created_at, prefs, now\)\);/);
    assert.equal(notifications.HOLD_MAX_HOURS, 12);
  });
});

// ---------------------------------------------------------------------------
describe("F46 — a push that failed everywhere is retried", () => {
  it("every send failing (a push-service 500): logged, kept as 'retry', the release gate open", async () => {
    pushStatus = 500;
    const r = await quietly(() => sendAt("2026-10-29T12:00:00Z", { title: "Unusual charge", tag: "anomaly-acme", data: { url: "/transactions" } }));
    assert.deepEqual(r, { sent: 0, failed: 1, logged: true, push_state: "retry" });
    assert.equal(db.log[0].push_state, "retry");
    assert.equal(notifications._release.state().heldPending, true);
    assert.equal(notifications.releaseDue(at("2026-10-29T12:15:00Z").getTime()), true, "not waiting for the end of any quiet hours");
  });

  it("the release job pushes it as itself and marks it sent; nothing twice", async () => {
    pushStatus = 500;
    await quietly(() => sendAt("2026-10-29T12:00:00Z", { title: "Unusual charge", tag: "anomaly-acme", data: { url: "/transactions" } }));
    pushStatus = null;
    const rel = await notifications.releaseHeldNotifications({ now: at("2026-10-29T12:15:00Z") });
    assert.deepEqual(rel, { ok: true, outcome: "released", released: 1, expired: 0 });
    assert.deepEqual(pushed, [{ title: "Unusual charge", body: "b", tag: "anomaly-acme", data: { url: "/transactions" } }]);
    assert.equal(db.log[0].push_state, "sent");
    assert.equal(notifications._release.state().heldPending, false);
    assert.equal((await notifications.releaseHeldNotifications({ now: at("2026-10-29T12:30:00Z") })).outcome, "none");
    assert.equal(pushed.length, 1);
  });

  it("still failing: the row stays 'retry', the job reports a failure, and it gives up after 12 hours", async () => {
    pushStatus = 500;
    await quietly(() => sendAt("2026-10-29T12:00:00Z", { title: "Unusual charge", tag: "anomaly-acme" }));
    const rel = await quietly(() => notifications.releaseHeldNotifications({ now: at("2026-10-29T12:15:00Z") }));
    assert.deepEqual([rel.ok, rel.outcome], [false, "failed"]);
    assert.equal(db.log[0].push_state, "retry");
    assert.equal(notifications._release.state().heldPending, true);
    // 12 h 01 min after it was made (outside quiet hours 19:00-08:00? no — 00:01
    // is quiet, so the job waits; the next run after 08:00 expires it).
    assert.equal((await notifications.releaseHeldNotifications({ now: at("2026-10-30T00:01:00Z") })).outcome, "quiet");
    const late = await notifications.releaseHeldNotifications({ now: at("2026-10-30T08:01:00Z") });
    assert.deepEqual([late.outcome, late.expired], ["expired", 1]);
    assert.equal(db.log[0].push_state, "expired");
  });

  it("the subscription read itself failing is a retry too", async () => {
    db.subsThrow = true;
    const r = await quietly(() => sendAt("2026-10-29T12:00:00Z", { title: "Low cash ahead", tag: "cash-low" }));
    assert.equal(r.push_state, "retry");
  });

  it("nobody subscribed, or only a dead subscription (410): 'none' — nothing to retry", async () => {
    db.subs = [];
    assert.equal((await sendAt("2026-10-29T12:00:00Z", { title: "a", tag: "cash-low" })).push_state, "none");
    db.subs = [{ endpoint: "https://push.example/gone", keys: { endpoint: "https://push.example/gone" } }];
    pushStatus = 410;
    const r = await sendAt("2026-10-29T12:01:00Z", { title: "b", tag: "cash-low" });
    assert.deepEqual([r.push_state, r.failed], ["none", 1]);
    assert.deepEqual(db.deleted, ["https://push.example/gone"], "the dead subscription is pruned as before");
    assert.deepEqual(db.log.map((l) => l.push_state), ["none", "none"]);
    assert.equal(notifications._release.state().heldPending, false);
  });

  it("one device took it: sent — the other device's failure isn't retried", async () => {
    let n = 0;
    const realLoad = Module._load;
    Module._load = function (request) {
      if (request === "web-push") {
        return { setVapidDetails() {}, async sendNotification(_s, p) { if (n++ === 0) { const e = new Error("x"); e.statusCode = 500; throw e; } pushed.push(JSON.parse(p)); } };
      }
      return realLoad.apply(this, arguments);
    };
    try {
      loadNotifications();
      db.subs = [{ endpoint: "a", keys: { endpoint: "a" } }, { endpoint: "b", keys: { endpoint: "b" } }];
      const r = await quietly(() => sendAt("2026-10-29T12:00:00Z", { title: "a", tag: "cash-low" }));
      assert.deepEqual(r, { sent: 1, failed: 1, logged: true, push_state: "sent" });
    } finally { Module._load = realLoad; }
  });

  it("a row whose state couldn't be written isn't claimed as kept", async () => {
    pushStatus = 500;
    db.stateUpdateThrows = true;
    const r = await quietly(() => sendAt("2026-10-29T12:00:00Z", { title: "a", tag: "cash-low" }));
    assert.equal(r.push_state, "none");
    assert.equal(notifications._release.state().heldPending, false);
  });

  it("several waiting, one of them a retry: one summary that doesn't blame quiet hours", async () => {
    db.prefs.notify_quiet_hours = { enabled: true, start: "22:00", end: "07:00" };
    notifications.invalidateNotifyPrefs();
    pushStatus = 500;
    // 21:50 — ten minutes before quiet hours; the retry then waits them out.
    await quietly(() => sendAt("2026-10-29T21:50:00Z", { title: "Unusual charge", tag: "anomaly-acme", data: { url: "/transactions" } }));
    pushStatus = null;
    await sendAt("2026-10-29T22:30:00Z", { title: "Low cash ahead", tag: "cash-low", data: { url: "/dashboard" } });
    assert.deepEqual(db.log.map((l) => l.push_state), ["retry", "held"]);
    assert.equal((await notifications.releaseHeldNotifications({ now: at("2026-10-29T22:45:00Z") })).outcome, "quiet");
    const rel = await notifications.releaseHeldNotifications({ now: at("2026-10-30T07:00:00Z") });
    assert.equal(rel.released, 2);
    assert.deepEqual(pushed, [{
      title: "2 notifications waiting",
      body: "Low cash ahead · Unusual charge",
      tag: "quiet-summary",
      data: { url: "/dashboard" },
    }]);
    assert.ok(db.log.every((l) => l.push_state === "sent"));
  });

  it("a retry whose kind was muted since is marked muted, not pushed", async () => {
    pushStatus = 500;
    await quietly(() => sendAt("2026-10-29T12:00:00Z", { title: "Unusual charge", tag: "anomaly-acme" }));
    pushStatus = null;
    db.prefs.notify_muted_types = ["spending"];
    const rel = await notifications.releaseHeldNotifications({ now: at("2026-10-29T12:15:00Z") });
    assert.equal(rel.released, 0);
    assert.equal(db.log[0].push_state, "muted");
    assert.equal(pushed.length, 0);
  });

  it("'retry' is a stored state, worded in the bell, and Per-sistant doesn't count it as pushed", () => {
    assert.ok(dbModule.CHECK_LISTS.notification_log.push_state.includes("retry"));
    const nav = read("teller", "views", "partials", "nav.ejs");
    const ctx = {};
    vm.runInNewContext(slice(nav, "var PUSH_STATE_WORDS", "function renderList"), ctx);
    assert.equal(ctx.PUSH_STATE_WORDS.retry, "Push failed — trying again");
    assert.equal(ctx.PUSH_STATE_WORDS.held, "Held for quiet hours");
    assert.match(read("apps", "per-sistant", "routes", "notifications.js"), /push_state IN \('sent', 'held'\)/);
  });
});

// ---------------------------------------------------------------------------
describe("F34 — the rent reminder follows the oldest unpaid month", () => {
  const housing = require("../teller/routes/housing");
  const CFG = { enabled: true, payee_name: "Sam", rent_amount: 1800, rent_due_day: 15, reminder_lead_days: 5, start_month: "2026-01", utilities: [] };
  async function remind(today, { balance = "1800", n = "1", oldest, has = true, cfg = CFG } = {}) {
    const sent = []; const sqls = [];
    const notif = require(NOTIF);
    const orig = { s: notif.sendToAll, r: notif.sentRecently };
    notif.sendToAll = async (p) => { sent.push(p); return { logged: true }; };
    notif.sentRecently = async () => false;
    const fdb = { query: async (sql) => {
      sqls.push(sql);
      if (/SELECT housing_config/.test(sql)) return { rows: [{ housing_config: cfg }] };
      if (/SUM\(amount\)/.test(sql)) return { rows: [{ balance, n, oldest: oldest === undefined ? null : oldest }] };
      if (/AS has/.test(sql)) return { rows: [{ has }] };
      return { rows: [] };
    } };
    try { await housing.runHousingReminders(fdb, today); }
    finally { notif.sendToAll = orig.s; notif.sentRecently = orig.r; }
    return { sent, sqls };
  }

  it("last month's rent still unpaid on the 3rd: pushed now, for last month", async () => {
    // This month's window (due the 15th, 5 days' notice) opens on the 10th —
    // it used to say nothing until then.
    const { sent, sqls } = await remind("2026-11-03", { oldest: "2026-10" });
    assert.deepEqual(sent.map((p) => [p.tag, p.item]), [["housing-due-2026-10", "housing:2026-10"]]);
    assert.match(sent[0].body, /^\$1800\.00 owed across 1 item\(s\)\. Send the transfer\.$/);
    assert.ok(sqls.some((s) => /MIN\(period\) AS oldest FROM payee_obligations WHERE status = 'unpaid' AND payee = \$1/.test(s)));
  });

  it("only this month unpaid: quiet before its window, pushed inside it — this month's item", async () => {
    assert.deepEqual((await remind("2026-11-03", { oldest: "2026-11" })).sent, []);
    assert.deepEqual((await remind("2026-11-09", { oldest: "2026-11" })).sent, []);
    const { sent } = await remind("2026-11-10", { oldest: "2026-11" });
    assert.deepEqual(sent.map((p) => [p.tag, p.item]), [["housing-due-2026-11", "housing:2026-11"]]);
  });

  it("two months owed: the item is the older month's — the one the task and Per-sistant's line name", async () => {
    const { sent } = await remind("2026-11-12", { balance: "3600", n: "2", oldest: "2026-10" });
    assert.deepEqual(sent.map((p) => [p.tag, p.item]), [["housing-due-2026-10", "housing:2026-10"]]);
    assert.match(sent[0].body, /^\$3600\.00 owed across 2 item\(s\)/);
  });

  it("next month's rent announced: the tag is next month's, the item the month already owed", async () => {
    const cfg = { ...CFG, rent_due_day: 1 };
    // Oct 29, due the 1st, 5 days' notice: November's rent is inside its window and has no row yet.
    const both = await remind("2026-10-29", { oldest: "2026-10", has: false, cfg });
    assert.deepEqual(both.sent.map((p) => [p.tag, p.item]), [["housing-due-2026-11", "housing:2026-10"]]);
    assert.match(both.sent[0].body, /^\$3600\.00 owed across 2 item\(s\) — Nov 2026 rent is due 2026-11-01\./);
    // Nothing owed yet: next month's alone, under its own item.
    const next = await remind("2026-10-29", { balance: "0", n: "0", has: false, cfg });
    assert.deepEqual(next.sent.map((p) => [p.tag, p.item]), [["housing-due-2026-11", "housing:2026-11"]]);
  });

  it("an unpaid FUTURE month only (added by hand) waits for its own window", async () => {
    assert.deepEqual((await remind("2026-11-20", { oldest: "2026-12" })).sent, []);
    const { sent } = await remind("2026-12-10", { oldest: "2026-12" });
    assert.deepEqual(sent.map((p) => p.item), ["housing:2026-12"]);
  });

  it("the item is the month Per-sistant's line names (housingItem of its due date)", async () => {
    const { computeHousingDue, housingItem } = require("../apps/per-sistant/routes/housing-due");
    const h = computeHousingDue(CFG, 1800, 1, "2026-11-03", { period: "2026-10", due_day: 15 });
    assert.equal(h.status, "overdue");
    const { sent } = await remind("2026-11-03", { oldest: "2026-10" });
    assert.equal(sent[0].item, housingItem(h, "2026-11-03"));
  });
});

// ---------------------------------------------------------------------------
describe("F45 — a task covers a push only while it is showing", () => {
  // Per-sistant's todos, answering openLinkedItems as Postgres would.
  function tasks(rows) {
    const pp = { calls: [] };
    pp.query = async (sql, params) => {
      pp.calls.push([sql, params]);
      assert.match(sql, /AND NOT completed AND deleted_at IS NULL AND due_date IS NOT NULL AND due_date <= \$2::date$/);
      return { rows: rows.filter((t) => params[0].includes(t.source_key) && t.due_date && t.due_date <= params[1]).map((t) => ({ source_key: t.source_key })) };
    };
    return pp;
  }
  const rent = { title: "Rent/utilities due to Sam", tag: "housing-due-2026-11", item: "housing:2026-11", data: { url: "/housing" } };

  it("the rent task isn't due yet (the lead window): the push goes out", async () => {
    const pp = tasks([{ source_key: "perfin:housing:2026-11", due_date: "2026-11-01" }]);
    persistent.setEmbeddedPersistentPool(pp);
    db.prefs.notify_quiet_hours = { enabled: false, start: "22:00", end: "07:00" };
    const r = await sendAt("2026-10-28T12:00:00Z", rent);
    assert.equal(r.push_state, "sent", "it used to be covered — and the task says nothing until the 1st");
    assert.equal(pushed.length, 1);
    assert.deepEqual(pp.calls[0][1], [["perfin:housing:2026-11"], "2026-10-28"]);
  });

  it("from its due date the task is the reminder: covered, logged read, not pushed", async () => {
    persistent.setEmbeddedPersistentPool(tasks([{ source_key: "perfin:housing:2026-11", due_date: "2026-11-01" }]));
    db.prefs.notify_quiet_hours = { enabled: false, start: "22:00", end: "07:00" };
    for (const day of ["2026-11-01T09:00:00Z", "2026-11-04T09:00:00Z"]) {
      const r = await sendAt(day, rent);
      assert.deepEqual(r, { sent: 0, failed: 0, logged: true, push_state: "covered" });
    }
    assert.deepEqual(db.log.map((l) => [l.push_state, l.is_read]), [["covered", true], ["covered", true]]);
    assert.equal(pushed.length, 0);
  });

  it("a task with no due date (a still-charging alert's) never covers", async () => {
    persistent.setEmbeddedPersistentPool(tasks([{ source_key: "perfin:still-charging:7:t1", due_date: null }]));
    db.prefs.notify_quiet_hours = { enabled: false, start: "22:00", end: "07:00" };
    const r = await sendAt("2026-11-04T09:00:00Z", { title: "Netflix charged you after you cancelled", tag: "sub-still-charging-7", item: "still-charging:7:t1" });
    assert.equal(r.push_state, "sent");
  });

  it("the release job asks about the day it runs: a held push whose task came due overnight is covered", async () => {
    persistent.setEmbeddedPersistentPool(tasks([{ source_key: "perfin:housing:2026-11", due_date: "2026-11-01" }]));
    db.prefs.notify_quiet_hours = { enabled: true, start: "22:00", end: "07:00" };
    notifications.invalidateNotifyPrefs();
    // Oct 31, 23:00 — quiet. The task isn't showing yet, so the push is held, not covered.
    assert.equal((await sendAt("2026-10-31T23:00:00Z", rent)).push_state, "held");
    const rel = await notifications.releaseHeldNotifications({ now: at("2026-11-01T07:05:00Z") });
    assert.equal(rel.released, 0);
    assert.deepEqual([db.log[0].push_state, pushed.length], ["covered", 0]);
  });

  it("the day is the APP_TIMEZONE day of the push, not UTC's", () => {
    // 2026-11-01 03:00 UTC is still Oct 31 in Los Angeles: a task due Nov 1 isn't showing there yet.
    const script = `
      process.env.NEON_DATABASE_URL = "postgres://mock:mock@localhost/mock";
      process.env.TOKEN_ENCRYPTION_PASSPHRASE = "t";
      const db = require(${JSON.stringify(path.join(ROOT, "teller/services/database"))});
      db.pool.query = async (sql) => (/notify_quiet_hours/.test(sql) ? { rows: [{}] } : /INSERT INTO notification_log/.test(sql) ? { rows: [{ id: 1 }] } : { rows: [] });
      const days = [];
      require(${JSON.stringify(path.join(ROOT, "teller/routes/persistent"))}).setEmbeddedPersistentPool({ query: async (sql, params) => { days.push(params[1]); return { rows: [] }; } });
      const n = require(${JSON.stringify(path.join(ROOT, "teller/routes/notifications"))});
      n.sendToAll({ title: "t", body: "b", tag: "housing-due-2026-11", item: "housing:2026-11" }, { now: new Date("2026-11-01T03:00:00Z") })
        .then(() => { console.log(JSON.stringify(days)); process.exit(0); });
    `;
    // No VAPID keys in the child: push isn't configured there, and the cover
    // lookup runs before that is looked at.
    const env = { ...process.env, APP_TIMEZONE: "" };
    delete env.VAPID_PUBLIC_KEY; delete env.VAPID_PRIVATE_KEY;
    const run = (tz) => JSON.parse(execFileSync(process.execPath, ["-e", script], { env: { ...env, APP_TIMEZONE: tz }, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim().split("\n").pop());
    assert.deepEqual(run("America/Los_Angeles"), ["2026-10-31"]);
    assert.deepEqual(run("UTC"), ["2026-11-01"]);
    assert.deepEqual(run("Not/AZone"), ["2026-11-01"], "an unknown zone falls back to UTC");
  });
});

// ---------------------------------------------------------------------------
describe("F47 — settings: a failed read, the toggle maps, strict parses", () => {
  const app = () => { const a = express(); a.use(express.json()); a.use(require("../teller/routes/settings")); return a; };
  const SWITCHES = ["insights_enabled", "keep_alive_enabled", "sheets_auto_sync_enabled", "auto_sync_enabled", "csv_reminder_enabled",
    "persistent_webhook_enabled", "sync_notifications_enabled", "weekly_digest_enabled", "daily_digest_enabled", "critical_alert_emails_enabled"];
  // Records the settings UPDATE; answers everything else (the invalidation
  // hooks read nothing).
  function recorder() {
    const writes = [];
    dbModule.pool.query = async (sql, params) => { if (/^UPDATE user_settings SET/.test(sql)) writes.push({ sql, params }); return { rows: [{}] }; };
    return writes;
  }

  it("GET answers 500 with a fixed sentence when the read fails — never a page of defaults", async () => {
    dbModule.pool.query = async () => { throw new Error("connection terminated: host db.internal"); };
    const res = await quietly(() => supertest(app()).get("/api/settings").expect(500));
    assert.deepEqual(res.body, { error: "Your settings couldn't be read — try again." });
    assert.equal(res.body.insight_modules, undefined);
  });

  it("GET still answers 200 with the stored row over the defaults", async () => {
    dbModule.pool.query = async () => ({ rows: [{ theme: "light", insight_modules: { anomaly_detection: false }, dashboard_widgets: { charts: false } }] });
    const body = (await supertest(app()).get("/api/settings").expect(200)).body;
    assert.equal(body.theme, "light");
    assert.deepEqual(body.dashboard_widgets, { charts: false });
  });

  it("each of the ten switches refuses anything but true / false, before any query", async () => {
    dbModule.pool.query = async () => { throw new Error("must not query"); };
    for (const key of SWITCHES) {
      for (const bad of ["false", "true", 0, 1, null, "", [], {}]) {
        const res = await supertest(app()).patch("/api/settings").send({ [key]: bad }).expect(400);
        assert.equal(res.body.error, key + " must be true or false");
      }
    }
  });

  it("…and stores true and false as given", async () => {
    for (const key of SWITCHES) {
      for (const v of [true, false]) {
        const writes = recorder();
        await supertest(app()).patch("/api/settings").send({ [key]: v }).expect(200);
        assert.equal(writes.length, 1, key);
        assert.match(writes[0].sql, new RegExp("\\b" + key + " = \\$1\\b"));
        assert.strictEqual(writes[0].params[0], v);
      }
    }
    assert.doesNotMatch(read("teller", "routes", "settings.js"), /values\.push\(!!/);
  });

  it("a bad switch refuses the whole request, valid fields included", async () => {
    const writes = recorder();
    await supertest(app()).patch("/api/settings").send({ theme: "light", weekly_digest_enabled: "false" }).expect(400);
    assert.equal(writes.length, 0);
  });

  it("the idle timeout: 7.5 is a 400 (it was a 500 from the INT column); 30 and '45' are stored", async () => {
    dbModule.pool.query = async () => { throw new Error("must not query"); };
    for (const bad of [7.5, 59.9, "7.5", 4, 10081, null, ""]) {
      const res = await supertest(app()).patch("/api/settings").send({ shell_idle_timeout_minutes: bad }).expect(400);
      assert.match(res.body.error, /integer between 5 and 10080/);
    }
    for (const [sent, stored] of [[30, 30], ["45", 45]]) {
      const writes = recorder();
      await supertest(app()).patch("/api/settings").send({ shell_idle_timeout_minutes: sent }).expect(200);
      assert.deepEqual(writes[0].params, [stored]);
    }
  });

  it("insight_modules / dashboard_widgets are merged over the stored map, not replaced", async () => {
    let writes = recorder();
    await supertest(app()).patch("/api/settings").send({ insight_modules: { anomaly_detection: false } }).expect(200);
    assert.match(writes[0].sql, /insight_modules = insight_modules \|\| \$1::jsonb/);
    assert.deepEqual(JSON.parse(writes[0].params[0]), { anomaly_detection: false });
    writes = recorder();
    await supertest(app()).patch("/api/settings").send({ dashboard_widgets: { charts: false } }).expect(200);
    assert.match(writes[0].sql, /dashboard_widgets = dashboard_widgets \|\| \$1::jsonb/);
    assert.deepEqual(JSON.parse(writes[0].params[0]), { charts: false });
    // Still refused when not an object.
    dbModule.pool.query = async () => { throw new Error("must not query"); };
    await supertest(app()).patch("/api/settings").send({ dashboard_widgets: [1] }).expect(400);
    await supertest(app()).patch("/api/settings").send({ insight_modules: "x" }).expect(400);
  });

  describe("the Settings page sends one key and reads nothing first", () => {
    const src = read("teller", "views", "settings.ejs");
    function load(api) {
      const msgs = []; const calls = [];
      const ctx = {
        JSON, showMsg: (t, ok) => msgs.push([t, ok]), applyTheme() {},
        apiFetch: async (url, opts) => { calls.push([url, opts]); return api(url, opts); },
        document: { getElementById: () => null },
      };
      vm.runInNewContext(slice(src, "async function updateSetting(key, value)", "// Monthly AI budget cap") + slice(src, "async function toggleModule(key, enabled)", "async function logout()"), ctx);
      return { ctx, msgs, calls };
    }
    const res = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body });

    it("toggleModule: one PATCH carrying just that module — no GET", async () => {
      const { ctx, calls } = load(async () => res(200, {}));
      assert.equal(await ctx.toggleModule("anomaly_detection", false), true);
      assert.equal(calls.length, 1);
      assert.equal(calls[0][0], "/api/settings");
      assert.equal(calls[0][1].method, "PATCH");
      assert.deepEqual(JSON.parse(calls[0][1].body), { insight_modules: { anomaly_detection: false } });
    });

    it("two quick toggles each send their own key (neither carries the other's old value)", async () => {
      const { ctx, calls } = load(async () => res(200, {}));
      await Promise.all([ctx.toggleModule("anomaly_detection", false), ctx.toggleModule("tax_deductions", false)]);
      assert.deepEqual(calls.map((c) => JSON.parse(c[1].body)), [{ insight_modules: { anomaly_detection: false } }, { insight_modules: { tax_deductions: false } }]);
    });

    it("a refused or failed save still reports false", async () => {
      assert.equal(await load(async () => res(500, { error: "x" })).ctx.toggleModule("a", true), false);
      assert.equal(await load(async () => { throw new Error("offline"); }).ctx.toggleModule("a", true), false);
    });

    it("the widget toggle does the same; a failed settings load says so", () => {
      const widget = slice(src, "onDelegate('widget-toggles', 'change', 'input[data-widget]'", "onDelegate('biometric-list'");
      assert.match(widget, /var one = \{\}; one\[key\] = enabled;\s*ok = await updateSetting\('dashboard_widgets', one\);/);
      assert.doesNotMatch(widget, /apiFetch\('\/api\/settings'\)/);
      assert.match(widget, /if \(!ok\) box\.checked = !enabled;/);
      const loadFn = slice(src, "async function loadSettings()", "document.getElementById('theme-select').value");
      assert.match(loadFn, /if \(!res\.ok\) \{[\s\S]*showMsg\("Your settings couldn't be loaded — reload the page before changing anything\.", false\);\s*return;/);
    });
  });
});

// ---------------------------------------------------------------------------
describe("F48 — a hand change clears auto_closed (db/030)", () => {
  const sql = read("apps", "per-sistant", "db", "030_linked_tasks.sql");
  it("the detach trigger's function sets source_detached and clears auto_closed", () => {
    const fn = slice(sql, "CREATE OR REPLACE FUNCTION todos_detach_linked()", "$$ LANGUAGE plpgsql;");
    assert.match(fn, /NEW\.source_detached := true;\s*NEW\.auto_closed := false;\s*RETURN NEW;/);
    // Still fires only for a change the sync didn't make.
    assert.match(sql, /NEW\.completed IS DISTINCT FROM OLD\.completed\s+AND NEW\.auto_closed IS NOT DISTINCT FROM OLD\.auto_closed/);
  });
  it("rows left in that state are repaired by a statement a second run doesn't match", () => {
    assert.match(sql, /UPDATE todos SET auto_closed = false\s+WHERE source_key IS NOT NULL AND source_detached AND auto_closed;/);
    // The sync never produces "detached and auto_closed" itself: it closes and
    // reopens only tasks that aren't detached.
    const sync = read("apps", "per-sistant", "services", "linked-tasks.js");
    assert.match(sync, /SET completed = true, completed_at = now\(\), auto_closed = true[\s\S]{0,200}AND NOT completed AND NOT source_detached/);
    assert.match(sync, /SET completed = false, completed_at = NULL, auto_closed = false[\s\S]{0,200}AND completed AND auto_closed AND NOT source_detached/);
  });
});

// ---------------------------------------------------------------------------
describe("F49 — SSO token type; real minutes to the end of quiet hours", () => {
  it("a non-string SSO token is a 400 and the process lives (standalone)", () => {
    const script = `
      process.env.NEON_DATABASE_URL = "postgres://mock:mock@localhost/mock";
      process.env.TOKEN_ENCRYPTION_PASSPHRASE = "t";
      process.env.SESSION_PIN = "123456"; process.env.SSO_SECRET = "sso-secret";
      const express = require("express"); const supertest = require("supertest");
      const app = express(); app.use(express.json());
      app.use(require(${JSON.stringify(path.join(ROOT, "teller/routes/persistent"))}));
      (async () => {
        const out = [];
        for (const token of [12345, { a: 1 }, ["sso", "1", "2", "3"], true]) {
          const r = await supertest(app).post("/api/sso/validate").send({ token });
          out.push([r.status, r.body.error]);
        }
        const s = await supertest(app).post("/api/sso/validate").send({ token: "nope" });
        const none = await supertest(app).post("/api/sso/validate").send({});
        out.push([s.status, s.body.error], [none.status, none.body.error]);
        console.log(JSON.stringify(out));
        process.exit(0);
      })();
    `;
    // Before the fix `token.split` threw inside the async handler: an unhandled
    // rejection, which ends the process (exit code 1 — execFileSync throws).
    const out = JSON.parse(execFileSync(process.execPath, ["-e", script], { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim().split("\n").pop());
    assert.deepEqual(out, [
      [400, "Token must be a string."], [400, "Token must be a string."], [400, "Token must be a string."], [400, "Token must be a string."],
      [401, "Invalid token format."], [400, "Token required."],
    ]);
  });

  const Q = { enabled: true, start: "22:00", end: "07:00" };
  const NY = "America/New_York";
  it("an ordinary night: 22:00 → 07:00 is 540 minutes", () => {
    assert.equal(notifyPrefs.minutesUntilQuietEnd(at("2026-11-19T03:00:00Z"), Q, NY), 540); // 22:00 EST
    assert.equal(notifyPrefs.minutesUntilQuietEnd(at("2026-11-19T11:59:00Z"), Q, NY), 1);   // 06:59 EST
    assert.equal(notifyPrefs.minutesUntilQuietEnd(at("2026-11-19T17:00:00Z"), Q, NY), 0);   // noon — not quiet
  });
  it("the spring-forward night is an hour shorter: 480 real minutes, landing on 07:00", () => {
    const start = at("2027-03-14T03:00:00Z"); // 22:00 EST, Mar 13
    const mins = notifyPrefs.minutesUntilQuietEnd(start, Q, NY);
    assert.equal(mins, 480, "it was 540 — held pushes went out at 08:00");
    const end = new Date(start.getTime() + mins * 60000);
    assert.equal(end.toISOString(), "2027-03-14T11:00:00.000Z"); // 07:00 EDT
    assert.equal(notifyPrefs.isQuiet(end, Q, NY), false);
    assert.equal(notifyPrefs.isQuiet(new Date(end.getTime() - 60000), Q, NY), true);
  });
  it("the fall-back night is an hour longer: 600 real minutes", () => {
    const start = at("2026-11-01T02:00:00Z"); // 22:00 EDT, Oct 31
    const mins = notifyPrefs.minutesUntilQuietEnd(start, Q, NY);
    assert.equal(mins, 600);
    assert.equal(new Date(start.getTime() + mins * 60000).toISOString(), "2026-11-01T12:00:00.000Z"); // 07:00 EST
  });
  it("after the change the remaining minutes are plain again; a zone without a change is untouched", () => {
    assert.equal(notifyPrefs.minutesUntilQuietEnd(at("2027-03-14T08:00:00Z"), Q, NY), 180); // 04:00 EDT → 07:00
    assert.equal(notifyPrefs.minutesUntilQuietEnd(at("2027-03-14T03:00:00Z"), Q, "UTC"), 240); // 03:00 UTC → 07:00
    assert.equal(notifyPrefs.minutesUntilQuietEnd(at("2027-03-14T22:00:00Z"), Q, "UTC"), 540);
  });
  it("an end that falls in the skipped hour still returns a positive wait that converges", () => {
    const q = { enabled: true, start: "22:00", end: "02:30" };
    let t = at("2027-03-14T03:00:00Z"); // 22:00 EST; 02:30 doesn't exist that night
    for (let i = 0; i < 4 && notifyPrefs.isQuiet(t, q, NY); i++) {
      const mins = notifyPrefs.minutesUntilQuietEnd(t, q, NY);
      assert.ok(mins > 0);
      t = new Date(t.getTime() + mins * 60000);
    }
    assert.equal(notifyPrefs.isQuiet(t, q, NY), false);
    assert.ok(t.getTime() <= at("2027-03-14T08:00:00Z").getTime(), "by 04:00 EDT at the latest");
  });
});
