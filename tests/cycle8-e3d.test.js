// ============================================================================
// Cycle 8 E3d (ST2) — one real-world item, one alert
// ============================================================================
// sendToAll({ item }) over a fake notification_log and a fake Per-sistant pool
// (wired the way the shell wires it — persistent.setEmbeddedPersistentPool):
// an open linked task for the item covers the push (logged read, item_key
// stored, `logged` unchanged, no push); a closed task, a failed read or a
// standalone Perfin pushes; a muted kind is muted before any lookup; a
// malformed item is ignored; the release job marks a held push covered when the
// item's task opened since. The callers: the housing reminders (housing:<period>,
// utility-amount:<id>) and the still-charging watchdog (stillChargingItem — the
// same key as its linked task). The cross-app half is
// tests/contract/notify-e3d.contract.test.js.
// ============================================================================
const { describe, it, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const Module = require("module");
const fs = require("fs");
const path = require("path");

if (!process.env.NEON_DATABASE_URL) process.env.NEON_DATABASE_URL = "postgres://mock:mock@localhost/mock";
if (!process.env.TOKEN_ENCRYPTION_PASSPHRASE) process.env.TOKEN_ENCRYPTION_PASSPHRASE = "test-passphrase";
process.env.APP_TIMEZONE = "UTC";
const dbModule = require("../teller/services/database");
const originalQuery = dbModule.pool.query;
const NOTIF = require.resolve("../teller/routes/notifications");
const persistent = require("../teller/routes/persistent");
const linkedTasks = require("../teller/services/linked-tasks");

function fakeDb() {
  const db = {
    clock: new Date("2026-10-29T12:00:00Z"), // outside 22:00-07:00
    log: [], nextId: 1, queries: [],
    prefs: { notify_quiet_hours: { enabled: true, start: "22:00", end: "07:00" }, notify_muted_types: [] },
    subs: [{ endpoint: "https://push.example/ok", keys: { endpoint: "https://push.example/ok" } }],
  };
  db.query = async (sql, params = []) => {
    db.queries.push(sql);
    if (/SELECT notify_quiet_hours, notify_muted_types FROM user_settings/.test(sql)) return { rows: [db.prefs] };
    if (/^INSERT INTO notification_log/.test(sql)) {
      const [type, title, body, data, push_state, item_key, is_read] = params;
      db.log.push({ id: db.nextId++, type, title, body, data: JSON.parse(data), push_state, item_key, is_read, created_at: new Date(db.clock) });
      return { rows: [] };
    }
    if (/SET push_state = 'expired'/.test(sql)) return { rows: [] };
    if (/SELECT id, type, title, body, data, item_key FROM notification_log/.test(sql)) {
      return { rows: db.log.filter((r) => r.push_state === "held") };
    }
    const m = /UPDATE notification_log SET push_state = '(\w+)'(, is_read = true)? WHERE id = ANY/.exec(sql);
    if (m) {
      db.log.filter((r) => params[0].includes(r.id) && r.push_state === "held").forEach((r) => { r.push_state = m[1]; if (m[2]) r.is_read = true; });
      return { rows: [] };
    }
    if (/SELECT endpoint, keys FROM push_subscriptions/.test(sql)) return { rows: db.subs };
    return { rows: [] };
  };
  return db;
}

// Per-sistant's todos as the covered lookup sees them.
function fakePersistent(open = new Set(), { throws = false } = {}) {
  const pp = { calls: [] };
  pp.query = async (sql, params) => {
    pp.calls.push([sql, params]);
    if (throws) throw new Error("persistent down");
    assert.match(sql, /FROM todos WHERE source_key = \$1 AND NOT completed\s+AND deleted_at IS NULL AND NOT source_detached/);
    return { rows: open.has(params[0]) ? [{ "?column?": 1 }] : [] };
  };
  return pp;
}

let notifications, db, pushed, origLoad;
function load({ vapid = true } = {}) {
  if (vapid) { process.env.VAPID_PUBLIC_KEY = "pub"; process.env.VAPID_PRIVATE_KEY = "priv"; }
  else { delete process.env.VAPID_PUBLIC_KEY; delete process.env.VAPID_PRIVATE_KEY; }
  delete require.cache[NOTIF];
  notifications = require(NOTIF);
  notifications._release.reset({ heldPending: false });
}
before(() => {
  origLoad = Module._load;
  Module._load = function (request) {
    if (request === "web-push") return { setVapidDetails() {}, async sendNotification(_s, p) { pushed.push(JSON.parse(p)); } };
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
  pushed = [];
  persistent.setEmbeddedPersistentPool(null);
  load();
});
const NOW = () => ({ now: new Date(db.clock) });
const rent = (extra = {}) => ({ title: "Rent/utilities due to Sam", body: "b", tag: "housing-due-2026-11", item: "housing:2026-11", data: { url: "/housing" }, ...extra });

describe("sendToAll with an item (cycle-8 E3d)", () => {
  it("an open linked task covers it: logged read with its item_key, `logged` true, nothing pushed", async () => {
    const pp = fakePersistent(new Set(["perfin:housing:2026-11"]));
    persistent.setEmbeddedPersistentPool(pp);
    const r = await notifications.sendToAll(rent(), NOW());
    assert.deepEqual(r, { sent: 0, failed: 0, logged: true, push_state: "covered" });
    assert.deepEqual(pushed, []);
    assert.deepEqual(db.log.map((l) => [l.type, l.push_state, l.item_key, l.is_read]), [["housing-due-2026-11", "covered", "housing:2026-11", true]]);
    assert.deepEqual(pp.calls.map((c) => c[1]), [["perfin:housing:2026-11"]]);
  });

  it("the task closed (or never made): pushed, item_key still stored, the push payload without `item`", async () => {
    persistent.setEmbeddedPersistentPool(fakePersistent(new Set()));
    const r = await notifications.sendToAll(rent(), NOW());
    assert.equal(r.push_state, "sent");
    assert.deepEqual(db.log.map((l) => [l.push_state, l.item_key, l.is_read]), [["sent", "housing:2026-11", false]]);
    assert.equal(pushed.length, 1);
    assert.equal("item" in pushed[0], false);
    assert.equal(pushed[0].tag, "housing-due-2026-11");
  });

  it("a failed lookup pushes (fail-soft) and is logged", async () => {
    persistent.setEmbeddedPersistentPool(fakePersistent(new Set(), { throws: true }));
    const errs = []; const ce = console.error; console.error = (...a) => errs.push(a.join(" "));
    try { assert.equal((await notifications.sendToAll(rent(), NOW())).push_state, "sent"); }
    finally { console.error = ce; }
    assert.equal(pushed.length, 1);
    assert.ok(errs.some((e) => /linked task lookup for a notification failed: persistent down/.test(e)));
  });

  it("standalone (no Per-sistant pool): pushed, no lookup", async () => {
    const r = await notifications.sendToAll(rent(), NOW());
    assert.equal(r.push_state, "sent");
    assert.equal(pushed.length, 1);
  });

  it("a muted kind is muted before any lookup; no item → no lookup; a malformed item is ignored", async () => {
    const pp = fakePersistent(new Set(["perfin:housing:2026-11"]));
    persistent.setEmbeddedPersistentPool(pp);
    db.prefs = { ...db.prefs, notify_muted_types: ["bills"] };
    assert.equal((await notifications.sendToAll(rent(), NOW())).push_state, "muted");
    db.prefs = { ...db.prefs, notify_muted_types: [] };
    notifications.invalidateNotifyPrefs();
    assert.equal((await notifications.sendToAll(rent({ item: undefined }), NOW())).push_state, "sent");
    for (const bad of ["perfin:housing:2026-11", "housing", "housing:", "Housing:x", "housing:a b", 7]) {
      assert.equal((await notifications.sendToAll(rent({ item: bad }), NOW())).push_state, "sent", String(bad));
    }
    assert.equal(pp.calls.length, 0);
    assert.ok(db.log.slice(1).every((l) => l.item_key === null));
  });

  it("covered beats quiet hours and push not being configured", async () => {
    persistent.setEmbeddedPersistentPool(fakePersistent(new Set(["perfin:housing:2026-11"])));
    db.clock = new Date("2026-10-29T23:00:00Z");
    assert.equal((await notifications.sendToAll(rent(), NOW())).push_state, "covered");
    load({ vapid: false });
    assert.equal((await notifications.sendToAll(rent(), NOW())).push_state, "covered");
    load({ vapid: false });
    persistent.setEmbeddedPersistentPool(fakePersistent(new Set()));
    assert.equal((await notifications.sendToAll(rent(), NOW())).push_state, "none");
  });

  it("the release job: a held push whose item's task opened since is covered (read), the rest pushed", async () => {
    const open = new Set();
    persistent.setEmbeddedPersistentPool(fakePersistent(open));
    db.clock = new Date("2026-10-29T23:00:00Z");
    await notifications.sendToAll(rent(), NOW());
    await notifications.sendToAll({ title: "Low cash ahead", body: "b", tag: "cash-low" }, NOW());
    assert.deepEqual(db.log.map((l) => l.push_state), ["held", "held"]);
    open.add("perfin:housing:2026-11");
    const r = await notifications.releaseHeldNotifications({ now: new Date("2026-10-30T07:30:00Z") });
    assert.deepEqual([r.outcome, r.released], ["released", 1]);
    assert.deepEqual(pushed.map((p) => p.tag), ["cash-low"]);
    assert.deepEqual(db.log.map((l) => [l.push_state, l.is_read]), [["covered", true], ["sent", false]]);
  });
});

describe("the item-bearing callers", () => {
  it("stillChargingItem is the linked task's key without its prefix", async () => {
    const sub = { id: 4, transaction_id: "tx 9/1", display_name: "Netflix", charged: 15.49, charged_on: "2026-10-20" };
    assert.equal(linkedTasks.stillChargingItem(sub), "still-charging:4:tx-9-1");
    assert.equal(linkedTasks.stillChargingItem({ id: 4 }), "still-charging:4:charge");
    let key;
    const pool = { query: async () => ({ rows: [{ linked_tasks_enabled: true, linked_tasks_sources: { still_charging: true }, linked_tasks_bill_lead_days: 3 }] }) };
    await linkedTasks.ensureStillChargingTask(pool, sub, { persistentPool: {}, deps: { ensure: async (_p, a) => { key = a.task.key; return { created: true, id: 1 }; } } });
    assert.equal(key, "perfin:" + linkedTasks.stillChargingItem(sub));
  });

  it("the watchdog passes the charge's item with its push", () => {
    const src = fs.readFileSync(path.join(__dirname, "..", "teller", "routes", "subscriptions.js"), "utf8");
    assert.match(src, /tag: "sub-still-charging-" \+ r\.id, item: linkedTasks\.stillChargingItem\(r\),/);
  });

  it("runHousingReminders: rent due carries housing:<period>, a missing utility amount utility-amount:<id>", async () => {
    const housing = require("../teller/routes/housing");
    const sent = [];
    const notif = require(NOTIF);
    const orig = { s: notif.sendToAll, r: notif.sentRecently };
    notif.sendToAll = async (p) => { sent.push(p); return { logged: true }; };
    notif.sentRecently = async () => false;
    const cfg = { enabled: true, payee_name: "Sam", rent_amount: 1800, rent_due_day: 1, reminder_lead_days: 5, start_month: "2026-01", utilities: [] };
    const fdb = { query: async (sql) => {
      if (/SELECT housing_config/.test(sql)) return { rows: [{ housing_config: cfg }] };
      if (/SUM\(amount\)/.test(sql)) return { rows: [{ balance: "1800", n: "1" }] };
      if (/AS has/.test(sql)) return { rows: [{ has: true }] };
      if (/status = 'pending_amount'/.test(sql)) return { rows: [{ id: 31, label: "Electricity", period: "2026-10", due_day: 5 }] };
      return { rows: [] };
    } };
    try {
      const r = await housing.runHousingReminders(fdb, "2026-10-29");
      assert.equal(r.sent, 2);
    } finally { notif.sendToAll = orig.s; notif.sentRecently = orig.r; }
    assert.deepEqual(sent.map((p) => [p.tag, p.item]), [["housing-due-2026-10", "housing:2026-10"], ["housing-util-31", "utility-amount:31"]]);
  });
});

describe("the bell (nav.ejs, in a vm)", () => {
  it("a covered row says the Per-sistant task covers it", () => {
    const vm = require("vm");
    const src = fs.readFileSync(path.join(__dirname, "..", "teller", "views", "partials", "nav.ejs"), "utf8");
    const start = src.indexOf("var PUSH_STATE_WORDS");
    const end = src.indexOf("var backdrop = document.getElementById('notif-backdrop');");
    const list = { innerHTML: "" };
    const esc = (v) => String(v == null ? "" : v).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
    vm.runInNewContext(src.slice(start, end) + "\nrenderList(__n);", { list, esc, Date, Math,
      __n: [{ id: 1, title: "Rent due", body: "b", is_read: true, created_at: new Date().toISOString(), push_state: "covered", data: {} }] });
    assert.match(list.innerHTML, /just now · Your Per-sistant task covers it — not pushed<\/div>/);
  });
});
