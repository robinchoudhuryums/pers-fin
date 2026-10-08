// ============================================================================
// Broad-scan (Sept 2026) Batch 5 — PB-2: one day-granular housingDue helper
// ============================================================================
// The notification check and the AI daily briefing each had a copy of the rent
// due-date math that compared a local-midnight Date to `now`: ON the due day it
// rolled to next month and went silent, an overdue balance never notified, the
// briefing said "due in 30 days", the day was clamped to 28 and "today" ignored
// APP_TIMEZONE. Both now call routes/housing-due.js.
// ============================================================================

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const supertest = require("supertest");
const fs = require("fs");
const path = require("path");

const { computeHousingDue, housingDueSuffix, housingDue } = require("../routes/housing-due");
const { todayStr } = require("../routes/health");

const CFG = { enabled: true, payee_name: "Sam", rent_due_day: 1, reminder_lead_days: 5 };

describe("PB-2 — computeHousingDue (pure, day-granular)", () => {
  it("due TODAY surfaces as due_today (it used to roll to next month and vanish)", () => {
    const h = computeHousingDue(CFG, 1500, 1, "2026-10-01");
    assert.equal(h.status, "due_today");
    assert.equal(h.days_until_due, 0);
    assert.equal(housingDueSuffix(h), " (due today)");
  });
  it("past the due day with a balance owed → OVERDUE, every day until paid", () => {
    const h = computeHousingDue(CFG, 1500, 1, "2026-10-09");
    assert.equal(h.status, "overdue");
    assert.equal(h.days_until_due, -8);
    assert.equal(housingDueSuffix(h), " (overdue by 8 days)");
    assert.equal(computeHousingDue(CFG, 1500, 1, "2026-10-29").status, "overdue");
  });
  it("upcoming inside the lead window; nothing outside it", () => {
    const cfg = { ...CFG, rent_due_day: 15 };
    const h = computeHousingDue(cfg, 900, 1, "2026-10-12");
    assert.equal(h.status, "upcoming");
    assert.equal(housingDueSuffix(h), " (due in 3 days)");
    assert.equal(computeHousingDue(cfg, 900, 1, "2026-10-02"), null);
  });
  it("a due day of 31 clamps to the real month length (Feb 28, not a blanket 28)", () => {
    const cfg = { ...CFG, rent_due_day: 31 };
    assert.equal(computeHousingDue(cfg, 1, 1, "2026-02-28").status, "due_today");
    assert.equal(computeHousingDue(cfg, 1, 1, "2026-03-31").status, "due_today");
    assert.equal(computeHousingDue(cfg, 1, 1, "2026-03-28").status, "upcoming");
  });
  it("nothing owed / not configured → null; no due day → unscheduled (surfaces)", () => {
    assert.equal(computeHousingDue(CFG, 0, 0, "2026-10-01"), null);
    assert.equal(computeHousingDue({ ...CFG, enabled: false }, 10, 1, "2026-10-01"), null);
    const h = computeHousingDue({ enabled: true, payee_name: "Sam" }, 10, 1, "2026-10-05");
    assert.equal(h.status, "unscheduled");
    assert.equal(housingDueSuffix(h), "");
  });
  it("housingDue scopes the balance to the configured payee and is fail-soft", async () => {
    let balParams;
    const pool = {
      query: async (sql, params) => {
        if (/housing_config/.test(sql)) return { rows: [{ housing_config: CFG }] };
        balParams = params;
        return { rows: [{ balance: "1500.00", n: 1 }] };
      },
    };
    const h = await housingDue(pool, "2026-10-01");
    assert.deepEqual(balParams, ["Sam"]);
    assert.equal(h.status, "due_today");
    assert.equal(await housingDue({ query: async () => { throw new Error("boom"); } }), null);
    assert.equal(await housingDue(null), null);
  });
});

describe("PB-2 — both surfaces use the shared helper", () => {
  it("notification check reports rent due TODAY (APP_TIMEZONE today)", async () => {
    const day = parseInt(todayStr().slice(8, 10), 10);
    const perfinPool = {
      query: async (sql) => {
        if (/housing_config/.test(sql)) return { rows: [{ housing_config: { ...CFG, rent_due_day: day } }] };
        if (/payee_obligations/.test(sql)) return { rows: [{ balance: "1500.00", n: 1 }] };
        return { rows: [] };
      },
    };
    const app = express();
    app.set("perfinPool", perfinPool);
    app.use(require("../routes/notifications")({ pool: { query: async () => ({ rows: [] }) } }));
    const res = await supertest(app).get("/api/notifications/check").expect(200);
    const h = res.body.notifications.find((n) => n.type === "housing_due");
    assert.ok(h, "rent due today must notify (it used to roll to next month and return null)");
    assert.match(h.title, /\$1500\.00 owed to Sam \(due today\)/);
    assert.equal(h.status, "due_today");
  });
  it("no private copies of the due math remain in notifications.js / ai.js", () => {
    for (const f of ["notifications.js", "ai.js"]) {
      const src = fs.readFileSync(path.join(__dirname, "..", "routes", f), "utf8");
      assert.match(src, /require\("\.\/housing-due"\)/, f);
      assert.doesNotMatch(src, /Math\.min\(dueDay, 28\)/, f);
      assert.doesNotMatch(src, /\(due now\)/, f);
    }
  });
});
