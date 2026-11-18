// Cycle 9 broad scan, Batch 5 — Per-sistant's side.
//  F45 — "does the task cover this reminder?" means open AND showing: due that
//        day or earlier (openLinkedItems' surfacingOn). During the rent lead
//        window the linked task isn't due yet and says nothing, so the
//        housing_due line stays; from its due date the task is the reminder.
//  F48 — db/030's detach trigger clears auto_closed on a hand change.
// The Perfin side is the root tests/cycle9-b5.test.js; the database-backed half
// tests/contract/c9-batch5.contract.test.js.
process.env.APP_TIMEZONE = "UTC";
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const { housingDueUnlessTask, housingTaskOpen } = require("../routes/housing-due");
const { openLinkedItems } = require("../services/linked-tasks");
const quietErr = async (fn) => { const ce = console.error; console.error = () => {}; try { return await fn(); } finally { console.error = ce; } };

// Per-sistant's todos, answering openLinkedItems the way Postgres would.
function todos(rows) {
  const pool = { calls: [] };
  pool.query = async (sql, params) => {
    pool.calls.push([sql, params]);
    const showing = /AND due_date IS NOT NULL AND due_date <= \$2::date/.test(sql);
    return { rows: rows
      .filter((t) => params[0].includes(t.source_key) && !t.completed && !t.deleted_at)
      .filter((t) => !showing || (t.due_date && t.due_date <= params[1]))
      .map((t) => ({ source_key: t.source_key })) };
  };
  return pool;
}

describe("F45 — openLinkedItems' surfacingOn", () => {
  const rows = [
    { source_key: "perfin:housing:2026-11", due_date: "2026-11-01" },
    { source_key: "perfin:utility-amount:7", due_date: "2026-10-20" },
    { source_key: "perfin:still-charging:3:t9", due_date: null },
    { source_key: "perfin:housing:2026-09", due_date: "2026-09-01", completed: true },
  ];

  it("with a day: only tasks due that day or earlier; the day is the second parameter", async () => {
    const pool = todos(rows);
    const items = ["housing:2026-11", "utility-amount:7", "still-charging:3:t9", "housing:2026-09"];
    assert.deepEqual([...await openLinkedItems(pool, items, { surfacingOn: "2026-10-28" })], ["utility-amount:7"]);
    assert.match(pool.calls[0][0], /WHERE source_key = ANY\(\$1::text\[\]\) AND NOT completed AND deleted_at IS NULL AND due_date IS NOT NULL AND due_date <= \$2::date$/);
    assert.deepEqual(pool.calls[0][1], [items.map((i) => "perfin:" + i), "2026-10-28"]);
    assert.deepEqual([...await openLinkedItems(pool, items, { surfacingOn: "2026-11-01" })].sort(), ["housing:2026-11", "utility-amount:7"]);
  });

  it("without one (or with something that isn't a date): every open task, the old query", async () => {
    for (const opt of [undefined, {}, { surfacingOn: null }, { surfacingOn: "tomorrow" }, { surfacingOn: 20261028 }, { surfacingOn: "2026-10-28'; DROP" }]) {
      const pool = todos(rows);
      const got = await openLinkedItems(pool, ["housing:2026-11", "still-charging:3:t9"], opt);
      assert.deepEqual([...got].sort(), ["housing:2026-11", "still-charging:3:t9"]);
      assert.doesNotMatch(pool.calls[0][0], /due_date/);
      assert.equal(pool.calls[0][1].length, 1);
    }
  });

  it("still fail-soft, and no query without a pool or items", async () => {
    assert.equal((await openLinkedItems(null, ["a:1"], { surfacingOn: "2026-10-28" })).size, 0);
    assert.equal((await quietErr(() => openLinkedItems({ query: async () => { throw new Error("x"); } }, ["a:1"], { surfacingOn: "2026-10-28" }))).size, 0);
  });
});

describe("F45 — the rent line and its task", () => {
  const CFG = { enabled: true, payee_name: "Sam", rent_due_day: 1, reminder_lead_days: 5 };
  // November's rent unpaid, nothing older.
  const perfin = { query: async (sql) => (/housing_config/.test(sql) ? { rows: [{ housing_config: CFG }] }
    : { rows: [{ balance: "1800.00", n: 1, oldest_period: "2026-11", oldest_due_day: 1 }] }) };
  const task = { source_key: "perfin:housing:2026-11", due_date: "2026-11-01" };

  it("housingTaskOpen passes the day it is asked about", async () => {
    const pool = todos([task]);
    assert.equal(await housingTaskOpen(pool, "housing:2026-11", "2026-10-31"), false, "open, but not due yet");
    assert.equal(await housingTaskOpen(pool, "housing:2026-11", "2026-11-01"), true);
    assert.deepEqual(pool.calls.map((c) => c[1][1]), ["2026-10-31", "2026-11-01"]);
  });

  it("on the due date and after, the task is the reminder — the line steps aside", async () => {
    assert.equal(await housingDueUnlessTask(perfin, todos([task]), "2026-11-01"), null);
    assert.equal(await housingDueUnlessTask(perfin, todos([task]), "2026-11-09"), null);
  });

  it("no task (linked tasks off) or a completed one: the line shows, with its item", async () => {
    const shown = await housingDueUnlessTask(perfin, todos([]), "2026-11-01");
    assert.deepEqual([shown.status, shown.item], ["due_today", "housing:2026-11"]);
    assert.equal((await housingDueUnlessTask(perfin, todos([{ ...task, completed: true }]), "2026-11-03")).status, "overdue");
  });

  it("a task whose due date you moved later doesn't hide a rent that is due now", async () => {
    const moved = { ...task, due_date: "2026-11-20" };
    assert.equal((await housingDueUnlessTask(perfin, todos([moved]), "2026-11-03")).status, "overdue");
  });

  it("the lead window: the task isn't showing yet, so the upcoming line is listed by the check", async () => {
    // Rent due the 5th, 5 days' notice; today the 2nd. The task (due the 5th) is
    // open — it used to hide this line while saying nothing itself.
    const cfg = { ...CFG, rent_due_day: 5 };
    const pf = { query: async (sql) => {
      if (/housing_config/.test(sql)) return { rows: [{ housing_config: cfg }] };
      if (/FROM payee_obligations/.test(sql)) return { rows: [{ balance: "1800.00", n: 1, oldest_period: "2026-11", oldest_due_day: 5 }] };
      return { rows: [] };
    } };
    const shown = await housingDueUnlessTask(pf, todos([{ source_key: "perfin:housing:2026-11", due_date: "2026-11-05" }]), "2026-11-02");
    assert.deepEqual([shown.status, shown.days_until_due, shown.item], ["upcoming", 3, "housing:2026-11"]);
    assert.equal(await housingDueUnlessTask(pf, todos([{ source_key: "perfin:housing:2026-11", due_date: "2026-11-05" }]), "2026-11-05"), null);
  });
});

describe("F48 — db/030: a hand change clears auto_closed", () => {
  const sql = fs.readFileSync(path.join(__dirname, "../db/030_linked_tasks.sql"), "utf8");
  it("the trigger function clears it and the repair matches only rows changed by hand", () => {
    assert.match(sql, /NEW\.source_detached := true;\s*NEW\.auto_closed := false;/);
    assert.match(sql, /UPDATE todos SET auto_closed = false\s+WHERE source_key IS NOT NULL AND source_detached AND auto_closed;/);
    // After the trigger definition, so the columns and function exist.
    assert.ok(sql.indexOf("UPDATE todos SET auto_closed = false") > sql.indexOf("CREATE TRIGGER trg_todos_detach_linked"));
  });
  it("the counts that skip auto-closed tasks are unchanged — they now see a hand completion", () => {
    for (const f of ["routes/settings.js", "routes/analytics.js", "routes/review.js"]) {
      assert.match(fs.readFileSync(path.join(__dirname, "..", f), "utf8"), /NOT (\w+\.)?auto_closed|auto_closed = false|auto_closed IS NOT TRUE/, f);
    }
  });
});
