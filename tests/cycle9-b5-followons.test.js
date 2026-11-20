// ============================================================================
// Cycle 9, the Batch 5 follow-on items (Perfin's side)
// ============================================================================
//  FO-1 — the dashboard's Debt Payoff mode no longer stores today's debt as the
//         baseline when its settings read fails
//  FO-2 — a retry that gives up is 'failed' ("Push failed — not delivered"),
//         not 'expired' ("Held for quiet hours — not pushed")
//  FO-3 — a retry of a kind quiet hours never hold (a PIN lockout) is tried
//         during quiet hours too; everything else still waits for their end
//  FO-4 — a push error that won't pass (a 400 / 401 / 403 / 413, an unreadable
//         stored subscription) is not retried; a 408 / 429 / 5xx / network
//         error is
//  FO-5 — a held push remembers when its quiet hours end (hold_until); the
//         12-hour limit counts from the later of that and the end by today's
//         settings
//  FO-7 — the rent push is covered by a showing task for ANY unpaid month
//         (cover_items), at send and at release
// (FO-6 — Per-sistant's PATCH /api/settings — is in
// apps/per-sistant/tests/cycle9-b5-followons.test.js; the database-backed half
// in tests/contract/c9-batch5-followons.contract.test.js.)
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

const WAITING = ["held", "retry"];
// A fake notification_log + settings + subscriptions, answering the SQL the
// module sends (the shape tests/cycle9-b5 uses). `clock` is created_at.
function fakeDb() {
  const db = {
    clock: new Date("2026-10-29T12:00:00Z"),
    log: [], nextId: 1, queries: [], deleted: [],
    prefs: { notify_quiet_hours: { enabled: true, start: "22:00", end: "07:00" }, notify_muted_types: [] },
    subs: [{ endpoint: "https://push.example/a", keys: { endpoint: "https://push.example/a" } }],
  };
  db.query = async (sql, params = []) => {
    db.queries.push(sql);
    if (/SELECT notify_quiet_hours, notify_muted_types FROM user_settings/.test(sql)) return { rows: [db.prefs] };
    if (/^INSERT INTO notification_log \(type, title, body, data, push_state, item_key, is_read, hold_until\)/.test(sql)) {
      const [type, title, body, data, push_state, item_key, is_read, hold_until] = params;
      const id = db.nextId++;
      db.log.push({ id, type, title, body, data: JSON.parse(data), push_state, item_key, is_read, hold_until, created_at: new Date(db.clock) });
      return { rows: [{ id }] };
    }
    const sel = /SELECT id, type, title, body, data, item_key, push_state, created_at, hold_until FROM notification_log\s+WHERE push_state IN \(('held', 'retry'|'retry')\)/.exec(sql);
    if (sel) {
      const states = sel[1].replace(/'/g, "").split(", ");
      return { rows: db.log.filter((r) => states.includes(r.push_state)).sort((a, b) => a.created_at - b.created_at || a.id - b.id).slice(0, params[0]) };
    }
    const m = /UPDATE notification_log SET push_state = '(\w+)'(?:, is_read = true)? WHERE id = ANY\(\$1::int\[\]\) AND push_state (?:= '(\w+)'|IN \('held', 'retry'\))/.exec(sql);
    if (m) {
      const from = m[2] ? [m[2]] : WAITING;
      db.log.filter((r) => params[0].includes(r.id) && from.includes(r.push_state)).forEach((r) => { r.push_state = m[1]; if (/is_read = true/.test(sql)) r.is_read = true; });
      return { rows: [] };
    }
    if (/SELECT endpoint, keys FROM push_subscriptions/.test(sql)) return { rows: db.subs };
    if (/DELETE FROM push_subscriptions/.test(sql)) { db.deleted.push(params[0]); return { rows: [] }; }
    return { rows: [] };
  };
  return db;
}
const logReads = () => db.queries.filter((q) => /FROM notification_log\s+WHERE push_state IN/.test(q));

let notifications, db, pushed, statusFor, origLoad, errors;
// Runs fn with console.error collected (the module logs every failed send).
const quietly = async (fn) => {
  const e = console.error; console.error = (...a) => errors.push(a.join(" "));
  try { return await fn(); } finally { console.error = e; }
};
before(() => {
  origLoad = Module._load;
  Module._load = function (request) {
    if (request === "web-push") {
      return {
        setVapidDetails() {},
        async sendNotification(sub, payload) {
          // statusFor(endpoint): null → delivered; "network" → an error with no
          // HTTP status; a number → that push-service status.
          const s = statusFor(sub.endpoint);
          if (s === "network") throw new Error("socket hang up");
          if (s) { const e = new Error("push " + s); e.statusCode = s; throw e; }
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
  pushed = []; errors = []; statusFor = () => null;
  persistent.setEmbeddedPersistentPool(null);
  process.env.VAPID_PUBLIC_KEY = "pub"; process.env.VAPID_PRIVATE_KEY = "priv";
  delete require.cache[NOTIF];
  notifications = require(NOTIF);
  // "A release has run and found nothing": the gate closed, no urgent retry.
  notifications._release.reset({ heldPending: false });
});

const at = (iso) => new Date(iso);
// Send one notification "at" a time: created_at and the clock agree.
async function sendAt(iso, payload) {
  db.clock = at(iso);
  return quietly(() => notifications.sendToAll({ body: "b", ...payload }, { now: at(iso) }));
}
const release = (iso) => quietly(() => notifications.releaseHeldNotifications({ now: at(iso) }));
const states = () => db.log.map((l) => l.push_state);

// ---------------------------------------------------------------------------
describe("FO-4 — a push error that won't pass is not retried", () => {
  it("passingPushError: no status, 408, 429 and 5xx pass; other 4xx don't", () => {
    const err = (s) => Object.assign(new Error("x"), s === undefined ? {} : { statusCode: s });
    for (const s of [undefined, 408, 429, 500, 502, 503]) assert.equal(notifications.passingPushError(err(s)), true, String(s));
    for (const s of [400, 401, 403, 413]) assert.equal(notifications.passingPushError(err(s)), false, String(s));
  });

  it("a 403 from every device (the push service refuses this server's key): 'none', no retry, the gate stays shut", async () => {
    statusFor = () => 403;
    const r = await sendAt("2026-10-29T12:00:00Z", { title: "Unusual charge", tag: "anomaly-acme" });
    // It used to be a 12-hour 'retry' with the notify-release job failing every 15 minutes.
    assert.deepEqual(r, { sent: 0, failed: 1, logged: true, push_state: "none" });
    assert.deepEqual(states(), ["none"]);
    assert.equal(notifications._release.state().heldPending, false);
    assert.equal(notifications.releaseDue(Date.parse("2026-10-29T12:15:00Z")), false);
    assert.deepEqual(db.deleted, [], "the subscription is kept — only a 404 / 410 prunes it");
    assert.ok(errors.some((e) => /push delivery error \(not retried — remove and re-register push on that device\): 403/.test(e)), "and it is logged");
  });

  it("a 400, a 401 and a 413 are the same; a 408, a 429, a 502 and a network error are retried", async () => {
    for (const [status, state] of [[400, "none"], [401, "none"], [413, "none"], [408, "retry"], [429, "retry"], [502, "retry"], ["network", "retry"]]) {
      statusFor = () => status;
      const r = await sendAt("2026-10-29T12:00:00Z", { title: "t", tag: "cash-low" });
      assert.equal(r.push_state, state, String(status));
    }
  });

  it("one device refusing for good and one failing for now: retried (the second may take it next time)", async () => {
    db.subs.push({ endpoint: "https://push.example/b", keys: { endpoint: "https://push.example/b" } });
    statusFor = (ep) => (ep.endsWith("/a") ? 403 : 503);
    assert.equal((await sendAt("2026-10-29T12:00:00Z", { title: "t", tag: "cash-low" })).push_state, "retry");
    // …and with the first one refusing and the second gone: nothing to retry.
    statusFor = (ep) => (ep.endsWith("/a") ? 403 : 410);
    const r = await sendAt("2026-10-29T12:05:00Z", { title: "t", tag: "cash-low" });
    assert.deepEqual([r.push_state, r.failed], ["none", 2]);
    assert.deepEqual(db.deleted, ["https://push.example/b"]);
  });

  it("a stored subscription that can't be read isn't a reason to retry; a readable one still gets the push", async () => {
    db.subs = [{ endpoint: "https://push.example/bad", keys: "{not json" }];
    assert.equal((await sendAt("2026-10-29T12:00:00Z", { title: "t", tag: "cash-low" })).push_state, "none");
    assert.ok(errors.some((e) => /a stored subscription can't be read/.test(e)));
    db.subs.push({ endpoint: "https://push.example/a", keys: { endpoint: "https://push.example/a" } });
    const r = await sendAt("2026-10-29T12:05:00Z", { title: "Second", tag: "cash-low" });
    assert.deepEqual([r.sent, r.failed, r.push_state], [1, 1, "sent"]);
    assert.deepEqual(pushed.map((p) => p.title), ["Second"]);
  });

  it("the release job: held rows that only meet a 403 are marked none — a clean run, not a failed job", async () => {
    await sendAt("2026-10-29T23:00:00Z", { title: "Low cash ahead", tag: "cash-low" });
    assert.deepEqual(states(), ["held"]);
    statusFor = () => 403;
    const rel = await release("2026-10-30T07:05:00Z");
    assert.deepEqual([rel.ok, rel.outcome, rel.released], [true, "none", 0]);
    assert.deepEqual(states(), ["none"]);
    assert.equal(notifications._release.state().heldPending, false);
  });
});

// ---------------------------------------------------------------------------
describe("FO-2 — a retry that gives up is 'failed', not 'expired'", () => {
  it("a held row and a retry both past their 12 hours: expired and failed, each by its own state", async () => {
    await sendAt("2026-10-28T23:00:00Z", { title: "Held last night", tag: "cash-low" });
    statusFor = () => 503;
    await sendAt("2026-10-29T12:00:00Z", { title: "Failed at noon", tag: "anomaly-acme" });
    assert.deepEqual(states(), ["held", "retry"]);
    // 07:30 the next morning: 24.5 h past the first one's quiet end, 19.5 h past the second's creation.
    const rel = await release("2026-10-30T07:30:00Z");
    assert.deepEqual([rel.ok, rel.outcome, rel.released, rel.expired], [true, "expired", 0, 2]);
    assert.deepEqual(states(), ["expired", "failed"]);
    assert.equal(pushed.length, 0);
    const updates = db.queries.filter((q) => /UPDATE notification_log SET push_state = '(expired|failed)'/.test(q));
    assert.deepEqual(updates, [
      "UPDATE notification_log SET push_state = 'expired' WHERE id = ANY($1::int[]) AND push_state = 'held'",
      "UPDATE notification_log SET push_state = 'failed' WHERE id = ANY($1::int[]) AND push_state = 'retry'",
    ]);
  });

  it("'failed' is a stored state with its own words in the bell", () => {
    assert.ok(dbModule.CHECK_LISTS.notification_log.push_state.includes("failed"));
    const ctx = {};
    vm.runInNewContext(slice(read("teller", "views", "partials", "nav.ejs"), "var PUSH_STATE_WORDS", "function renderList"), ctx);
    assert.equal(ctx.PUSH_STATE_WORDS.failed, "Push failed — not delivered");
    assert.equal(ctx.PUSH_STATE_WORDS.expired, "Held for quiet hours — not pushed");
  });
});

// ---------------------------------------------------------------------------
describe("FO-3 — a retry quiet hours never hold doesn't wait for them", () => {
  const lockout = { title: "PIN login locked", tag: "pin-lockout", data: { url: "/settings" } };

  it("a PIN-lockout push that failed at 23:00 is pushed at the next run, in quiet hours — what quiet hours hold still waits", async () => {
    await sendAt("2026-10-29T22:30:00Z", { title: "Low cash ahead", tag: "cash-low" });
    statusFor = () => 503;
    const r = await sendAt("2026-10-29T23:00:00Z", lockout);
    assert.equal(r.push_state, "retry");
    assert.deepEqual(states(), ["held", "retry"]);
    const st = notifications._release.state();
    assert.equal(st.urgentRetry, true);
    assert.equal(new Date(st.releaseNotBefore).toISOString(), "2026-10-30T07:00:00.000Z");
    // It used to wait here until 07:00.
    assert.equal(notifications.releaseDue(Date.parse("2026-10-29T23:15:00Z")), true);

    statusFor = () => null;
    const rel = await release("2026-10-29T23:15:00Z");
    assert.deepEqual(rel, { ok: true, outcome: "released", released: 1, expired: 0 });
    assert.deepEqual(pushed, [{ title: "PIN login locked", body: "b", tag: "pin-lockout", data: { url: "/settings" } }]);
    assert.deepEqual(states(), ["held", "sent"]);
    assert.match(logReads()[0], /WHERE push_state IN \('retry'\)/, "during quiet hours only the retries are read");
    // The urgent part is settled; the held row waits for 07:00 as before.
    const after = notifications._release.state();
    assert.deepEqual([after.urgentRetry, after.heldPending], [false, true]);
    assert.equal(notifications.releaseDue(Date.parse("2026-10-29T23:30:00Z")), false);
    assert.equal(notifications.releaseDue(Date.parse("2026-10-30T07:00:00Z")), true);
    assert.equal((await release("2026-10-30T07:00:00Z")).released, 1);
    assert.deepEqual(states(), ["sent", "sent"]);
  });

  it("a later hold doesn't close the gate on it", async () => {
    statusFor = () => 503;
    await sendAt("2026-10-29T23:00:00Z", lockout);
    statusFor = () => null;
    await sendAt("2026-10-29T23:05:00Z", { title: "Low cash ahead", tag: "cash-low" });
    assert.equal(notifications.releaseDue(Date.parse("2026-10-29T23:15:00Z")), true);
  });

  it("still failing in quiet hours: a failed run, and the gate stays open for the next one", async () => {
    statusFor = () => 503;
    await sendAt("2026-10-29T23:00:00Z", lockout);
    const rel = await release("2026-10-29T23:15:00Z");
    assert.deepEqual([rel.ok, rel.outcome], [false, "failed"]);
    assert.deepEqual(states(), ["retry"]);
    assert.equal(notifications.releaseDue(Date.parse("2026-10-29T23:30:00Z")), true);
  });

  it("a retry of a kind quiet hours DO hold is not pushed during them", async () => {
    statusFor = () => 503;
    await sendAt("2026-10-29T21:50:00Z", { title: "Unusual charge", tag: "anomaly-acme" }); // ten minutes before quiet hours
    statusFor = () => null;
    notifications._release.reset({ heldPending: true, urgentRetry: true }); // as after a restart
    const rel = await release("2026-10-29T23:15:00Z");
    assert.equal(rel.outcome, "quiet");
    assert.deepEqual(states(), ["retry"]);
    assert.equal(pushed.length, 0);
    const st = notifications._release.state();
    assert.equal(st.urgentRetry, false, "nothing urgent was found");
    assert.equal(new Date(st.releaseNotBefore).toISOString(), "2026-10-30T07:00:00.000Z");
    assert.equal((await release("2026-10-30T07:00:00Z")).released, 1);
  });

  it("no urgent retry: a run during quiet hours reads nothing; after a restart it reads once", async () => {
    await sendAt("2026-10-29T23:00:00Z", { title: "Low cash ahead", tag: "cash-low" });
    assert.equal((await release("2026-10-29T23:15:00Z")).outcome, "quiet");
    assert.equal(logReads().length, 0);
    notifications._release.reset({}); // a fresh process: one may have been left behind
    assert.equal(notifications._release.state().urgentRetry, true);
    assert.equal((await release("2026-10-29T23:30:00Z")).outcome, "quiet");
    assert.equal(logReads().length, 1);
    assert.equal((await release("2026-10-29T23:45:00Z")).outcome, "quiet");
    assert.equal(logReads().length, 1, "and not again");
  });

  it("its 12 hours count from when it was made, whatever the quiet hours: tried at 11 h 59, 'failed' at 12 h 01", async () => {
    db.prefs.notify_quiet_hours = { enabled: true, start: "19:00", end: "08:00" };
    notifications.invalidateNotifyPrefs();
    statusFor = () => 503;
    await sendAt("2026-10-29T19:30:00Z", lockout);
    await sendAt("2026-10-29T19:32:00Z", { ...lockout, title: "Second" });
    statusFor = () => null;
    db.log[1].created_at = at("2026-10-29T19:28:00Z"); // made two minutes before the first
    const rel = await release("2026-10-30T07:29:00Z"); // still quiet (until 08:00)
    assert.deepEqual([rel.released, rel.expired], [1, 1]);
    assert.deepEqual(db.log.map((l) => [l.title, l.push_state]), [["PIN login locked", "sent"], ["Second", "failed"]]);
  });
});

// ---------------------------------------------------------------------------
describe("FO-5 — a held push remembers when its quiet hours end", () => {
  it("hold_until is written at the hold; a push that isn't held has none", async () => {
    await sendAt("2026-10-29T23:00:00Z", { title: "Held", tag: "cash-low" });
    await sendAt("2026-10-30T12:00:00Z", { title: "Sent", tag: "cash-low" });
    assert.deepEqual(db.log.map((l) => l.hold_until && l.hold_until.toISOString()), ["2026-10-30T07:00:00.000Z", null]);
    assert.match(read("teller", "services", "database.js"), /ALTER TABLE notification_log ADD COLUMN IF NOT EXISTS hold_until TIMESTAMPTZ/);
  });

  it("quiet hours moved since, so the push's creation is no longer inside them: still pushed at the end", async () => {
    db.prefs.notify_quiet_hours = { enabled: true, start: "22:00", end: "11:00" };
    notifications.invalidateNotifyPrefs();
    await sendAt("2026-10-29T22:30:00Z", { title: "Held", tag: "cash-low" });
    // The window now starts at 23:00 — by today's settings a 22:30 push was
    // never held, so its 12 hours used to run from 22:30 and end at 10:30.
    db.prefs.notify_quiet_hours = { enabled: true, start: "23:00", end: "11:00" };
    notifications.invalidateNotifyPrefs();
    const rel = await release("2026-10-30T11:01:00Z");
    assert.deepEqual([rel.released, rel.expired], [1, 0]);
  });

  it("quiet hours lengthened since: the later end (today's settings) is the one that counts", async () => {
    await sendAt("2026-10-29T23:00:00Z", { title: "Held", tag: "cash-low" }); // hold_until 07:00
    db.prefs.notify_quiet_hours = { enabled: true, start: "22:00", end: "21:00" };
    notifications.invalidateNotifyPrefs();
    assert.equal((await release("2026-10-30T12:00:00Z")).outcome, "quiet");
    const rel = await release("2026-10-30T21:01:00Z"); // 14 hours past 07:00, one minute past 21:00
    assert.deepEqual([rel.released, rel.expired], [1, 0]);
  });

  it("the limit itself is unchanged: 12 h 01 min past the recorded end is expired", async () => {
    await sendAt("2026-10-29T23:00:00Z", { title: "Held", tag: "cash-low" });
    const rel = await release("2026-10-30T19:01:00Z");
    assert.deepEqual([rel.released, rel.expired], [0, 1]);
    assert.deepEqual(states(), ["expired"]);
  });

  it("a row held before the column existed (no hold_until) is judged by today's settings, as before", async () => {
    db.log.push({ id: 90, type: "cash-low", title: "Old row", body: "b", data: {}, push_state: "held", item_key: null, is_read: false, hold_until: null, created_at: at("2026-10-29T23:00:00Z") });
    assert.equal((await release("2026-10-30T18:59:00Z")).released, 1);
    db.log.push({ id: 91, type: "cash-low", title: "Older row", body: "b", data: {}, push_state: "held", item_key: null, is_read: false, created_at: at("2026-10-28T23:00:00Z") });
    notifications._release.reset({ heldPending: true });
    assert.equal((await release("2026-10-30T19:30:00Z")).expired, 1);
  });
});

// ---------------------------------------------------------------------------
describe("FO-7 — the rent push is covered by a showing task for any unpaid month", () => {
  // Per-sistant's todos, answering openLinkedItems the way Postgres would.
  function tasks(rows) {
    const pool = { calls: [] };
    pool.query = async (sql, params) => {
      pool.calls.push([sql, params]);
      const showing = /AND due_date IS NOT NULL AND due_date <= \$2::date/.test(sql);
      return { rows: rows
        .filter((t) => params[0].includes(t.source_key) && !t.completed)
        .filter((t) => !showing || (t.due_date && t.due_date <= params[1]))
        .map((t) => ({ source_key: t.source_key })) };
    };
    return pool;
  }
  const rent = { title: "Rent/utilities due to Sam", tag: "housing-due-2026-10", item: "housing:2026-10", cover_items: ["housing:2026-11"], data: { url: "/housing" } };
  beforeEach(() => { db.prefs.notify_quiet_hours = { enabled: false, start: "22:00", end: "07:00" }; });

  it("October's task ticked off by hand, November's showing: covered — under October's item", async () => {
    const pp = tasks([
      { source_key: "perfin:housing:2026-10", due_date: "2026-10-01", completed: true },
      { source_key: "perfin:housing:2026-11", due_date: "2026-11-01" },
    ]);
    persistent.setEmbeddedPersistentPool(pp);
    const r = await sendAt("2026-11-03T09:00:00Z", rent);
    // It used to be pushed: only October's task was asked about.
    assert.deepEqual(r, { sent: 0, failed: 0, logged: true, push_state: "covered" });
    assert.deepEqual(pp.calls[0][1], [["perfin:housing:2026-10", "perfin:housing:2026-11"], "2026-11-03"]);
    assert.deepEqual([db.log[0].item_key, db.log[0].is_read], ["housing:2026-10", true]);
    assert.equal(pushed.length, 0);
  });

  it("no unpaid month has a showing task: pushed, and the push carries neither the item nor the cover items", async () => {
    persistent.setEmbeddedPersistentPool(tasks([
      { source_key: "perfin:housing:2026-10", due_date: "2026-10-01", completed: true },
      { source_key: "perfin:housing:2026-11", due_date: "2026-11-01", completed: true },
      { source_key: "perfin:housing:2026-12", due_date: "2026-11-02" }, // a month that isn't owed
    ]));
    const r = await sendAt("2026-11-03T09:00:00Z", rent);
    assert.equal(r.push_state, "sent");
    assert.deepEqual(pushed, [{ title: rent.title, body: "b", tag: rent.tag, data: { url: "/housing" } }]);
    // The row keeps them, so a held push is checked the same way at release.
    assert.deepEqual(db.log[0].data, { url: "/housing", cover_items: ["housing:2026-11"] });
  });

  it("cover items are checked like the item: malformed, prefixed, repeated ones and the item itself are dropped; none without an item", async () => {
    const pp = tasks([]);
    persistent.setEmbeddedPersistentPool(pp);
    await sendAt("2026-11-03T09:00:00Z", { ...rent, cover_items: ["housing:2026-11", "housing:2026-11", "housing:2026-10", "perfin:housing:2026-12", "not an item", 7, null] });
    assert.deepEqual(pp.calls[0][1][0], ["perfin:housing:2026-10", "perfin:housing:2026-11"]);
    await sendAt("2026-11-03T09:05:00Z", { title: "t", tag: "cash-low", cover_items: ["housing:2026-11"] });
    assert.equal(pp.calls.length, 1, "no item → no lookup");
    assert.deepEqual(db.log[1].data, {});
    await sendAt("2026-11-03T09:10:00Z", { ...rent, cover_items: Array.from({ length: 40 }, (_, i) => "housing:20" + (30 + i) + "-01") });
    assert.equal(pp.calls[1][1][0].length, 25, "the item and at most 24 others");
  });

  it("a held rent push whose OTHER month's task came due overnight is covered at release; else pushed without cover_items", async () => {
    db.prefs.notify_quiet_hours = { enabled: true, start: "22:00", end: "07:00" };
    const pp = tasks([{ source_key: "perfin:housing:2026-11", due_date: "2026-11-01" }]);
    persistent.setEmbeddedPersistentPool(pp);
    assert.equal((await sendAt("2026-10-31T23:00:00Z", rent)).push_state, "held"); // November's task isn't due yet
    const rel = await release("2026-11-01T07:05:00Z");
    assert.deepEqual([rel.released, db.log[0].push_state, db.log[0].is_read], [0, "covered", true]);
    assert.deepEqual(pp.calls[pp.calls.length - 1][1], [["perfin:housing:2026-10", "perfin:housing:2026-11"], "2026-11-01"]);

    persistent.setEmbeddedPersistentPool(tasks([]));
    assert.equal((await sendAt("2026-11-01T23:00:00Z", rent)).push_state, "held");
    assert.equal((await release("2026-11-02T07:05:00Z")).released, 1);
    assert.deepEqual(pushed[0].data, { url: "/housing" });
  });

  describe("runHousingReminders", () => {
    const housing = require("../teller/routes/housing");
    const CFG = { enabled: true, payee_name: "Sam", rent_amount: 1800, rent_due_day: 15, reminder_lead_days: 5, start_month: "2026-01", utilities: [] };
    async function remind(today, row, { has = true, cfg = CFG } = {}) {
      const sent = [];
      const notif = require(NOTIF);
      const orig = { s: notif.sendToAll, r: notif.sentRecently };
      notif.sendToAll = async (p) => { sent.push(p); return { logged: true }; };
      notif.sentRecently = async () => false;
      const fdb = { query: async (sql) => {
        if (/SELECT housing_config/.test(sql)) return { rows: [{ housing_config: cfg }] };
        if (/SUM\(amount\)/.test(sql)) return { rows: [row] };
        if (/AS has/.test(sql)) return { rows: [{ has }] };
        return { rows: [] };
      } };
      try { await housing.runHousingReminders(fdb, today); }
      finally { notif.sendToAll = orig.s; notif.sentRecently = orig.r; }
      return sent;
    }

    it("two months owed: the item is the oldest, the other unpaid month rides along", async () => {
      const sent = await remind("2026-11-03", { balance: "3600", n: "2", oldest: "2026-10", periods: ["2026-10", "2026-11"] });
      assert.deepEqual(sent.map((p) => [p.item, p.cover_items]), [["housing:2026-10", ["housing:2026-11"]]]);
    });
    it("one month owed, or a read that returns no list: no cover items", async () => {
      assert.deepEqual((await remind("2026-11-03", { balance: "1800", n: "1", oldest: "2026-10", periods: ["2026-10"] }))[0].cover_items, []);
      assert.deepEqual((await remind("2026-11-03", { balance: "1800", n: "1", oldest: "2026-10" }))[0].cover_items, []);
      assert.deepEqual((await remind("2026-11-03", { balance: "1800", n: "1", oldest: "2026-10", periods: ["2026-10", "garbage", null] }))[0].cover_items, []);
    });
    it("only next month's rent announced (nothing owed yet): its own item, no cover items", async () => {
      // Rent due the 1st, 5 days' notice: on Nov 28 December's rent is announced.
      const cfg = { ...CFG, rent_due_day: 1 };
      const sent = await remind("2026-11-28", { balance: "0", n: "0", oldest: null, periods: null }, { has: false, cfg });
      assert.deepEqual(sent.map((p) => [p.tag, p.item, p.cover_items]), [["housing-due-2026-12", "housing:2026-12", []]]);
      // …and with October and November also owed, the item is the oldest and November rides along.
      const both = await remind("2026-11-28", { balance: "3600", n: "2", oldest: "2026-10", periods: ["2026-10", "2026-11"] }, { has: false, cfg });
      assert.deepEqual(both.map((p) => [p.tag, p.item, p.cover_items]), [["housing-due-2026-12", "housing:2026-10", ["housing:2026-11"]]]);
    });
  });
});

// ---------------------------------------------------------------------------
describe("FO-1 — the Debt Payoff mode never stores a baseline it couldn't read", () => {
  // The dashboard's PYRAMID_MODES run against canned API responses (the
  // harness tests/scan-sept-batch13 uses): a path with no response is a failed read.
  function loadPyramidModes(responses, patches) {
    const src = read("teller", "views", "dashboard.ejs");
    const start = src.indexOf("var PYRAMID_MODES = {");
    const end = src.indexOf("// Spawn rising neon orbs");
    assert.ok(start > 0 && end > start, "PYRAMID_MODES block present");
    const apiFetch = async (url, opts) => {
      if (opts && opts.method === "PATCH") { patches.push(JSON.parse(opts.body)); return { ok: true, json: async () => ({}) }; }
      const key = Object.keys(responses).find((k) => url.indexOf(k) === 0);
      const body = key ? responses[key] : null;
      return { ok: body !== null, json: async () => body };
    };
    // eslint-disable-next-line no-new-func
    return new Function("apiFetch", "document", src.slice(start, end) + "\nreturn PYRAMID_MODES;")(apiFetch, { getElementById: () => null });
  }
  const accounts = [{ type: "credit", current_balance: "4000" }, { type: "loan", current_balance: "6000" }];

  it("the settings read fails: nothing is written, and the card says so", async () => {
    const patches = [];
    const r = await loadPyramidModes({ "/api/accounts": accounts }, patches).debt_payoff.compute();
    // It used to PATCH debt_baseline_amount: 10000 over the stored baseline.
    assert.deepEqual(patches, []);
    assert.deepEqual([r.score, r.status], [0, "Your settings couldn't be loaded — reload to see your progress"]);
  });

  it("the read succeeds: a stored baseline is used, and only then is a missing or lower one set", async () => {
    let patches = [];
    const r = await loadPyramidModes({ "/api/accounts": accounts, "/api/settings": { debt_baseline_amount: "20000" } }, patches).debt_payoff.compute();
    assert.deepEqual([patches, r.score], [[], 50]);
    patches = [];
    await loadPyramidModes({ "/api/accounts": accounts, "/api/settings": { debt_baseline_amount: null } }, patches).debt_payoff.compute();
    assert.deepEqual(patches, [{ debt_baseline_amount: 10000 }]);
    patches = [];
    await loadPyramidModes({ "/api/accounts": accounts, "/api/settings": { debt_baseline_amount: "8000" } }, patches).debt_payoff.compute();
    assert.deepEqual(patches, [{ debt_baseline_amount: 10000 }]);
  });
});
