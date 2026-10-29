// Cycle 8 E3e (ST2) — Per-sistant's half of "one real-world item, one alert".
// The notification check names each entry's item (a linked task's source_key
// without "perfin:"; housing_due's housing:<month of its due date>), reads which
// items Perfin pushed in the last 12 hours through perfinPool (push_state 'sent'
// only; standalone or a failed read → none) and marks those entries notify:false
// (still listed); housing_due steps aside only for its OWN item's open task
// (housingDueUnlessTask, generalised from "any housing task" — openLinkedItems).
process.env.APP_TIMEZONE = "UTC";
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const supertest = require("supertest");

const notifRoutes = require("../routes/notifications");
const { annotateNotify, perfinPushedItems, PUSHED_WINDOW_HOURS } = notifRoutes;
const { housingItem, housingDueUnlessTask } = require("../routes/housing-due");
const { openLinkedItems } = require("../services/linked-tasks");

const quietErr = async (fn) => { const ce = console.error; console.error = () => {}; try { return await fn(); } finally { console.error = ce; } };

describe("perfinPushedItems", () => {
  it("standalone or no items: an empty set and no query", async () => {
    const pool = { query: async () => { throw new Error("must not query"); } };
    assert.equal((await perfinPushedItems(null, ["housing:2026-10"])).size, 0);
    assert.equal((await perfinPushedItems(pool, [undefined, null])).size, 0);
  });
  it("reads only pushes that went out in the last 12 hours, for these items", async () => {
    const calls = [];
    const pool = { query: async (sql, params) => { calls.push([sql, params]); return { rows: [{ item_key: "housing:2026-10" }] }; } };
    const got = await perfinPushedItems(pool, ["housing:2026-10", undefined, "housing:2026-10", "utility-amount:7"]);
    assert.deepEqual([...got], ["housing:2026-10"]);
    assert.equal(PUSHED_WINDOW_HOURS, 12);
    assert.match(calls[0][0], /FROM notification_log\s+WHERE item_key = ANY\(\$1::text\[\]\) AND push_state = 'sent'\s+AND created_at > now\(\) - make_interval\(hours => \$2\)/);
    assert.deepEqual(calls[0][1], [["housing:2026-10", "utility-amount:7"], 12]);
  });
  it("a failed read is an empty set (fail-soft)", async () => {
    const got = await quietErr(() => perfinPushedItems({ query: async () => { throw new Error("down"); } }, ["housing:2026-10"]));
    assert.equal(got.size, 0);
  });
});

describe("annotateNotify with Perfin's pushed items", () => {
  it("an item Perfin pushed doesn't notify; the rest unchanged; the list keeps every entry", () => {
    const list = [
      { type: "housing_due", item: "housing:2026-10" },
      { type: "overdue", item: "utility-amount:7" },
      { type: "overdue" },
    ];
    const out = annotateNotify(list, null, new Date("2026-10-29T12:00:00Z"), new Set(["housing:2026-10"]));
    assert.deepEqual(out.map((n) => n.notify), [false, true, true]);
    assert.equal(out.length, 3);
    assert.deepEqual(annotateNotify([{ type: "overdue", item: "x:1" }], null).map((n) => n.notify), [true], "no set → as before");
  });
});

describe("housingItem / openLinkedItems / housingDueUnlessTask", () => {
  it("housingItem: the month of the line's due date, else this month", () => {
    assert.equal(housingItem({ due_date: "2026-09-01" }, "2026-10-29"), "housing:2026-09");
    assert.equal(housingItem({ due_date: "2026-10-05" }, "2026-10-01"), "housing:2026-10");
    assert.equal(housingItem({ due_date: null }, "2026-10-29"), "housing:2026-10");
    assert.equal(housingItem(null), null);
  });

  it("openLinkedItems: open, untrashed tasks for these items; no pool / items → no query; failure → empty", async () => {
    const calls = [];
    const pool = { query: async (sql, params) => { calls.push([sql, params]); return { rows: [{ source_key: "perfin:housing:2026-10" }] }; } };
    assert.deepEqual([...await openLinkedItems(pool, ["housing:2026-10", "utility-amount:7", "housing:2026-10"])], ["housing:2026-10"]);
    assert.match(calls[0][0], /source_key = ANY\(\$1::text\[\]\) AND NOT completed AND deleted_at IS NULL/);
    assert.deepEqual(calls[0][1], [["perfin:housing:2026-10", "perfin:utility-amount:7"]]);
    assert.equal((await openLinkedItems(null, ["a:1"])).size, 0);
    assert.equal((await openLinkedItems(pool, [])).size, 0);
    assert.equal(calls.length, 1);
    assert.equal((await quietErr(() => openLinkedItems({ query: async () => { throw new Error("x"); } }, ["a:1"]))).size, 0);
  });

  it("housingDueUnlessTask hides the line only for its own item's task, and names the item", async () => {
    const CFG = { enabled: true, payee_name: "Sam", rent_due_day: 1, reminder_lead_days: 5 };
    const perfin = { query: async (sql) => (/housing_config/.test(sql) ? { rows: [{ housing_config: CFG }] }
      : { rows: [{ balance: "1800.00", n: 2, oldest_period: "2026-09", oldest_due_day: 1 }] }) };
    const ps = (open) => ({ query: async (_s, params) => ({ rows: params[0].filter((k) => open.includes(k)).map((k) => ({ source_key: k })) }) });
    const shown = await housingDueUnlessTask(perfin, ps(["perfin:housing:2026-10"]), "2026-10-29");
    assert.deepEqual([shown.status, shown.due_date, shown.item], ["overdue", "2026-09-01", "housing:2026-09"], "September is the one owed — October's task doesn't hide it");
    assert.equal(await housingDueUnlessTask(perfin, ps(["perfin:housing:2026-09"]), "2026-10-29"), null);
  });
});

describe("GET /api/notifications/check", () => {
  function app({ perfinPushed = [], openKeys = [] } = {}) {
    const a = express();
    const CFG = { enabled: true, payee_name: "Sam", rent_due_day: 1, reminder_lead_days: 5 };
    const perfinPool = { query: async (sql, params) => {
      if (/housing_config/.test(sql)) return { rows: [{ housing_config: CFG }] };
      if (/FROM payee_obligations/.test(sql)) return { rows: [{ balance: "1800.00", n: 1, oldest_period: null }] };
      if (/FROM notification_log/.test(sql)) return { rows: params[0].filter((i) => perfinPushed.includes(i)).map((i) => ({ item_key: i })) };
      return { rows: [] };
    } };
    a.set("perfinPool", perfinPool);
    const today = new Date().toISOString().slice(0, 10);
    const pool = { query: async (sql, params) => {
      if (/source_key = ANY/.test(sql)) return { rows: params[0].filter((k) => openKeys.includes(k)).map((k) => ({ source_key: k })) };
      if (/due_date < \$1/.test(sql) && !/streak_count/.test(sql)) {
        return { rows: [{ id: 3, title: "Pay Sam", due_date: today.slice(0, 7) + "-01", source_key: "perfin:housing:" + today.slice(0, 7) }, { id: 4, title: "Call mom", due_date: "2020-01-01", source_key: null }] };
      }
      return { rows: [] };
    } };
    a.use(notifRoutes({ pool }));
    return { a, month: today.slice(0, 7) };
  }

  it("tasks off, Perfin pushed the rent: housing_due listed with its item, notify:false", async () => {
    const { a, month } = app({ perfinPushed: [] });
    const quiet = (await supertest(a).get("/api/notifications/check").expect(200)).body;
    const h0 = quiet.notifications.find((n) => n.type === "housing_due");
    assert.equal(h0.item, "housing:" + month);
    assert.equal(h0.notify, true, "not pushed → notifies");
    const { a: a2 } = app({ perfinPushed: ["housing:" + month] });
    const body = (await supertest(a2).get("/api/notifications/check").expect(200)).body;
    const h = body.notifications.find((n) => n.type === "housing_due");
    assert.deepEqual([h.item, h.notify], ["housing:" + month, false]);
  });

  it("tasks on: housing_due left out; the task's own entry carries the item; an ordinary task none", async () => {
    const m = new Date().toISOString().slice(0, 7);
    const { a } = app({ openKeys: ["perfin:housing:" + m] });
    const body = (await supertest(a).get("/api/notifications/check").expect(200)).body;
    assert.equal(body.notifications.find((n) => n.type === "housing_due"), undefined);
    const task = body.notifications.find((n) => n.id === 3);
    assert.deepEqual([task.type, task.item, task.notify], ["overdue", "housing:" + m, true]);
    const plain = body.notifications.find((n) => n.id === 4);
    assert.equal("item" in plain, false);
  });
});
