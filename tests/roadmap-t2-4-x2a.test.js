// ============================================================================
// Roadmap T2.4 X2a — linked tasks, Perfin's side: settings + the computation
// ============================================================================
// computeLinkedTasks over a fake pool returning canned rows: rent & utilities
// per unpaid period inside the payment-due window (the lead-window edge, an
// overdue period as urgent, next month's not-yet-generated rent, a skipped
// next month left out), a utility amount whose bill should have arrived (not
// before its due day; a past period always), manual bills from 30 days ago to
// the lead (a 31st bill in a 30-day month, a paid occurrence left out, an
// overdue one high), a failing source left out of ok_kinds while the others
// stay, a source switched off never read, a ledger that isn't set up read as
// nothing due. The default "today" is the APP_TIMEZONE date (this file forces
// a zone whose date differs from UTC's). The housing helpers the reminder now
// shares, PATCH /api/settings 400s + valid values, GET defaults, reset-fresh
// keeping user_settings as a reset table. The SQL predicates (status, payee,
// skips) are judged on real Postgres in tests/contract/linked-tasks-perfin.
// ============================================================================
if (!process.env.NEON_DATABASE_URL) process.env.NEON_DATABASE_URL = "postgres://mock:mock@localhost/mock";
if (!process.env.TOKEN_ENCRYPTION_PASSPHRASE) process.env.TOKEN_ENCRYPTION_PASSPHRASE = "test-passphrase";
// A zone whose date differs from UTC's right now (the scan-sept-batch6-tz recipe).
const utcHour = new Date().getUTCHours();
process.env.APP_TIMEZONE = utcHour < 12 ? "Etc/GMT+12" : "Pacific/Kiritimati";

const { describe, it, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const supertest = require("supertest");

const dbModule = require("../teller/services/database");
const originalQuery = dbModule.pool.query;
afterEach(() => { dbModule.pool.query = originalQuery; });

const lt = require("../teller/services/linked-tasks");
const housing = require("../teller/routes/housing");
const fq = require("../teller/services/financial-queries");

const HOUSING = { enabled: true, payee_name: "Sam Lee", rent_amount: 1800, rent_due_day: 1, reminder_lead_days: 5, utilities: [] };

// Canned rows per statement. `fail` names a statement that throws.
function fakePool({ cfg = HOUSING, unpaid = [], pending = [], nextHas = false, bills = [], paid = [], fail = null } = {}) {
  const seen = [];
  return {
    seen,
    async query(sql, params) {
      const which =
        /SELECT housing_config FROM user_settings/.test(sql) ? "config" :
        /status = 'unpaid'/.test(sql) ? "unpaid" :
        /status = 'pending_amount'/.test(sql) ? "pending" :
        /payee_obligation_skips/.test(sql) ? "next" :
        /FROM manual_bills/.test(sql) ? "bills" :
        /FROM bill_payments/.test(sql) ? "paid" : null;
      if (!which) throw new Error("unexpected SQL: " + sql);
      seen.push({ which, params });
      if (fail === which) throw new Error("boom " + which);
      if (which === "config") return { rows: [{ housing_config: cfg }] };
      if (which === "unpaid") return { rows: unpaid };
      if (which === "pending") return { rows: pending };
      if (which === "next") return { rows: [{ has: nextHas }] };
      if (which === "bills") return { rows: bills };
      return { rows: paid };
    },
  };
}
const ALL = { sources: { housing: true, utility_amount: true, bills: true }, bill_lead_days: 3 };
const byKey = (r) => Object.fromEntries(r.desired.map((d) => [d.key, d]));

describe("housing helpers shared with the payment-due reminder", () => {
  it("periodDueDate clamps to the month; rentReminderOpen opens lead days before the due date, overdue included", () => {
    assert.equal(housing.periodDueDate("2027-02", 31), "2027-02-28");
    assert.equal(housing.periodDueDate("2026-11", 31), "2026-11-30");
    const cfg = { rent_due_day: 10, reminder_lead_days: 5 };
    assert.equal(housing.rentReminderOpen("2026-11", cfg, "2026-11-04"), false);
    assert.equal(housing.rentReminderOpen("2026-11", cfg, "2026-11-05"), true);
    assert.equal(housing.rentReminderOpen("2026-11", cfg, "2026-12-20"), true, "overdue stays open");
    assert.equal(housing.rentReminderOpen("2027-02", { rent_due_day: 31, reminder_lead_days: 3 }, "2027-02-25"), true, "the clamped due date");
  });

  it("utilityAmountDue: not before the due day this month, always for a past period", () => {
    assert.equal(housing.utilityAmountDue({ period: "2026-11", due_day: 20 }, "2026-11-19"), false);
    assert.equal(housing.utilityAmountDue({ period: "2026-11", due_day: 20 }, "2026-11-20"), true);
    assert.equal(housing.utilityAmountDue({ period: "2026-10", due_day: 28 }, "2026-11-01"), true);
  });

  it("runHousingReminders reads its windows through the shared helpers", () => {
    const src = require("fs").readFileSync(require.resolve("../teller/routes/housing"), "utf8");
    const start = src.indexOf("async function runHousingReminders");
    const body = src.slice(start, src.indexOf("\n// Routes", start));
    assert.match(body, /rentReminderOpen\(today\.slice\(0, 7\), cfg, today\)/);
    assert.match(body, /if \(!utilityAmountDue\(o, today\)\) continue;/);
    assert.doesNotMatch(body, /dom >= cfg\.rent_due_day/);
  });
});

describe("computeLinkedTasks", () => {
  it("one rent & utilities task per open period — overdue urgent, next month's rent before its row exists", async () => {
    const pool = fakePool({ unpaid: [
      { period: "2026-11", label: "Rent", amount: "1800.00" },
      { period: "2026-11", label: "Electricity", amount: "95.12" },
    ] });
    const r = await lt.computeLinkedTasks(pool, ALL, "2026-11-28");
    const k = byKey(r);
    assert.deepEqual(Object.keys(k).filter((x) => x.includes("housing")).sort(), ["perfin:housing:2026-11", "perfin:housing:2026-12"]);
    const nov = k["perfin:housing:2026-11"];
    assert.equal(nov.title, "Pay Sam Lee for Nov 2026");
    assert.equal(nov.description, "$1,895.12 owed: Rent $1,800.00, Electricity $95.12. Record the payment on Perfin's Rent page.");
    assert.deepEqual([nov.url, nov.due_date, nov.priority], ["/housing", "2026-11-01", "urgent"]);
    const dec = k["perfin:housing:2026-12"];
    assert.deepEqual([dec.due_date, dec.priority], ["2026-12-01", "high"]);
    assert.match(dec.description, /^\$1,800\.00 owed: Rent \$1,800\.00\./);
    const q = pool.seen.find((s) => s.which === "unpaid");
    assert.deepEqual(q.params, ["Sam Lee"], "payee-scoped");
  });

  it("next month's rent is left out when its row exists or was removed (the skip), and a period outside its window too", async () => {
    let r = await lt.computeLinkedTasks(fakePool({ nextHas: true }), ALL, "2026-11-28");
    assert.equal(r.desired.filter((d) => d.key.startsWith("perfin:housing")).length, 0);
    const cfg = { ...HOUSING, rent_due_day: 10 };
    r = await lt.computeLinkedTasks(fakePool({ cfg, unpaid: [{ period: "2026-11", label: "Rent", amount: "1800" }] }), ALL, "2026-11-04");
    assert.equal(r.desired.length, 0, "six days before the due date, lead 5");
    r = await lt.computeLinkedTasks(fakePool({ cfg, unpaid: [{ period: "2026-11", label: "Rent", amount: "1800" }] }), ALL, "2026-11-05");
    assert.deepEqual(r.desired.map((d) => [d.key, d.priority]), [["perfin:housing:2026-11", "high"]]);
  });

  it("a utility amount task once its bill should have arrived, due on the bill's date", async () => {
    const pending = [{ id: 7, label: "Electricity", period: "2026-11", due_day: 20 }, { id: 6, label: "Water", period: "2026-10", due_day: 28 }];
    let r = await lt.computeLinkedTasks(fakePool({ pending, nextHas: true }), ALL, "2026-11-19");
    assert.deepEqual(r.desired.map((d) => d.key), ["perfin:utility-amount:6"]);
    r = await lt.computeLinkedTasks(fakePool({ pending, nextHas: true }), ALL, "2026-11-20");
    const k = byKey(r);
    assert.deepEqual(Object.keys(k).sort(), ["perfin:utility-amount:6", "perfin:utility-amount:7"]);
    assert.deepEqual([k["perfin:utility-amount:7"].title, k["perfin:utility-amount:7"].url, k["perfin:utility-amount:7"].due_date, k["perfin:utility-amount:7"].priority],
      ["Enter the Electricity amount for Nov 2026", "/housing#pending", "2026-11-20", "medium"]);
    assert.equal(k["perfin:utility-amount:6"].due_date, "2026-10-28");
  });

  it("manual bills from 30 days ago to the lead — a 31st bill on the 30th, a paid occurrence left out, an overdue one high", async () => {
    const bills = [
      { id: 3, name: "Insurance", amount: "120.00", due_day: 31, cadence: "monthly", created_at: "2026-08-15" },
      { id: 4, name: "Gym", amount: "40.00", due_day: 4, cadence: "monthly", created_at: "2026-01-01" },
    ];
    const r = await lt.computeLinkedTasks(fakePool({ nextHas: true, bills, paid: [{ bill_id: 4, paid_date: "2026-09-04" }] }), ALL, "2026-10-02");
    const k = byKey(r);
    assert.deepEqual(Object.keys(k).filter((x) => x.includes(":bill:")).sort(),
      ["perfin:bill:3:2026-09-30", "perfin:bill:4:2026-10-04"], "Sep 4 was paid; Aug 31 / Sep 2 are outside the window");
    assert.deepEqual([k["perfin:bill:3:2026-09-30"].priority, k["perfin:bill:4:2026-10-04"].priority], ["high", "medium"]);
    assert.equal(k["perfin:bill:3:2026-09-30"].description, "$120.00 due 2026-09-30. Mark it paid on Perfin's bill calendar.");
    assert.equal(k["perfin:bill:4:2026-10-04"].url, "/calendar");
  });

  it("a failing source is left out of ok_kinds (with a fixed error) while the others stay", async () => {
    const r = await lt.computeLinkedTasks(fakePool({ unpaid: [{ period: "2026-11", label: "Rent", amount: "1800" }], nextHas: true, fail: "bills",
      bills: [{ id: 1, name: "X", amount: "1", due_day: 1, cadence: "monthly", created_at: "2026-01-01" }] }), ALL, "2026-11-02");
    assert.deepEqual(r.ok_kinds.sort(), ["housing", "utility-amount"]);
    assert.deepEqual(r.errors, [{ kind: "bill", error: "Could not read this source." }]);
    assert.equal(r.desired.length, 1);
    const r2 = await lt.computeLinkedTasks(fakePool({ fail: "config" }), ALL, "2026-11-02");
    assert.deepEqual(r2.ok_kinds, ["bill"]);
    assert.deepEqual(r2.errors.map((e) => e.kind), ["housing", "utility-amount"]);
  });

  it("a source switched off is never read; manual bills are off by default", async () => {
    const pool = fakePool({ nextHas: true });
    const r = await lt.computeLinkedTasks(pool, { sources: { housing: false, utility_amount: false } }, "2026-11-02");
    assert.deepEqual(r.ok_kinds, []);
    assert.equal(pool.seen.length, 0);
    const p2 = fakePool({ nextHas: true });
    const r2 = await lt.computeLinkedTasks(p2, {}, "2026-11-02");
    assert.deepEqual(r2.ok_kinds.sort(), ["housing", "utility-amount"]);
    assert.ok(!p2.seen.some((s) => s.which === "bills"));
    assert.deepEqual(lt.DEFAULT_SOURCES, { still_charging: true, housing: true, utility_amount: true, bills: false });
  });

  it("a ledger that isn't set up has nothing due (read, so its tasks may close)", async () => {
    const pool = fakePool({ cfg: { enabled: false } });
    const r = await lt.computeLinkedTasks(pool, ALL, "2026-11-02");
    assert.deepEqual(r.ok_kinds.sort(), ["bill", "housing", "utility-amount"]);
    assert.deepEqual(r.desired, []);
    assert.ok(!pool.seen.some((s) => s.which === "unpaid" || s.which === "pending"));
  });

  it("today defaults to the APP_TIMEZONE date, not UTC's", async () => {
    const zoneToday = fq.todayStr();
    assert.notEqual(zoneToday, new Date().toISOString().slice(0, 10), "the forced zone's date differs from UTC's");
    const day = parseInt(zoneToday.slice(8, 10), 10);
    const bills = [{ id: 9, name: "Phone", amount: "50", due_day: day, cadence: "monthly", created_at: zoneToday }]; // first occurrence: today
    const r = await lt.computeLinkedTasks(fakePool({ nextHas: true, bills }), { sources: { housing: false, utility_amount: false, bills: true }, bill_lead_days: 0 });
    const t = r.desired.find((d) => d.key === `perfin:bill:9:${zoneToday}`);
    assert.ok(t, "today's occurrence is inside a lead-0 window only by the zone's date");
    assert.equal(t.priority, "medium", "and is not overdue by the zone's date");
    assert.ok(r.desired.every((d) => d.due_date <= zoneToday), "nothing after the zone's today with lead 0");
  });

  it("every key, title, url and priority fits Per-sistant's linked-task checks", async () => {
    const ps = require("../apps/per-sistant/services/linked-tasks");
    const r = await lt.computeLinkedTasks(fakePool({
      unpaid: [{ period: "2026-11", label: "Rent", amount: "1800" }],
      pending: [{ id: 7, label: "Electricity", period: "2026-11", due_day: 20 }],
      bills: [{ id: 3, name: "Insurance", amount: "120", due_day: 31, cadence: "monthly", created_at: "2026-08-15" }],
    }), ALL, "2026-11-28");
    assert.ok(r.desired.length >= 4);
    for (const t of r.desired) assert.equal(ps.checkTask("perfin", r.ok_kinds, t).error, undefined, t.key);
  });
});

describe("settings", () => {
  const app = () => { const a = express(); a.use(express.json()); a.use(require("../teller/routes/settings")); return a; };

  it("PATCH refuses a bad switch, sources map or lead without writing", async () => {
    let wrote = 0;
    dbModule.pool.query = async (s) => { if (/^UPDATE user_settings/.test(s)) wrote++; return { rows: [{}] }; };
    for (const body of [
      { linked_tasks_enabled: "yes" }, { linked_tasks_enabled: 1 }, { linked_tasks_enabled: null },
      { linked_tasks_sources: [] }, { linked_tasks_sources: "housing" }, { linked_tasks_sources: null },
      { linked_tasks_sources: { housing: "true" } }, { linked_tasks_sources: { rent: true } },
      { linked_tasks_bill_lead_days: -1 }, { linked_tasks_bill_lead_days: 15 }, { linked_tasks_bill_lead_days: "3x" }, { linked_tasks_bill_lead_days: 2.5 },
    ]) {
      await supertest(app()).patch("/api/settings").send(body).expect(400);
    }
    assert.equal(wrote, 0);
  });

  it("PATCH stores the switch, merges the sources map over the stored one and stores the lead", async () => {
    let sql = null, values = null;
    dbModule.pool.query = async (s, v) => { if (/^UPDATE user_settings SET/.test(s)) { sql = s; values = v; } return { rows: [{}] }; };
    await supertest(app()).patch("/api/settings").send({ linked_tasks_enabled: true, linked_tasks_sources: { bills: true }, linked_tasks_bill_lead_days: "5" }).expect(200);
    assert.match(sql, /linked_tasks_enabled = \$1, linked_tasks_sources = linked_tasks_sources \|\| \$2::jsonb, linked_tasks_bill_lead_days = \$3/);
    assert.deepEqual(values.slice(0, 3), [true, JSON.stringify({ bills: true }), 5]);
  });

  it("GET returns the defaults for a row without them", async () => {
    dbModule.pool.query = async () => ({ rows: [{ theme: "dark" }] });
    const s = (await supertest(app()).get("/api/settings").expect(200)).body;
    assert.deepEqual([s.linked_tasks_enabled, s.linked_tasks_sources, s.linked_tasks_bill_lead_days, s.linked_tasks_state],
      [false, { still_charging: true, housing: true, utility_amount: true, bills: false }, 3, null]);
  });

  it("the migration adds the four columns with the decision-5 defaults; reset-fresh resets user_settings to a default row", () => {
    const fs = require("fs");
    const db = fs.readFileSync(require.resolve("../teller/services/database"), "utf8");
    assert.match(db, /ADD COLUMN IF NOT EXISTS linked_tasks_enabled BOOLEAN NOT NULL DEFAULT false/);
    assert.match(db, /ADD COLUMN IF NOT EXISTS linked_tasks_sources JSONB NOT NULL DEFAULT '\{"still_charging": true, "housing": true, "utility_amount": true, "bills": false\}'::jsonb/);
    assert.match(db, /ADD COLUMN IF NOT EXISTS linked_tasks_bill_lead_days INT NOT NULL DEFAULT 3/);
    assert.match(db, /ADD COLUMN IF NOT EXISTS linked_tasks_state JSONB/);
    const reset = require("../scripts/reset-fresh");
    assert.ok(reset.KEEP_TABLES.includes("user_settings"));
    const src = fs.readFileSync(require.resolve("../scripts/reset-fresh"), "utf8");
    assert.match(src, /DELETE FROM user_settings"\);\s*await client\.query\("INSERT INTO user_settings \(id\) VALUES \(1\)/);
  });
});
