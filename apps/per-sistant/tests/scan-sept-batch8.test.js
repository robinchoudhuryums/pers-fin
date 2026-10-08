// ============================================================================
// Broad-scan (Sept 2026) Batch 8 — Per-sistant notifications & schedulers
// ============================================================================
// PB-1   every notification-check type reaches the user (browser notification
//        for the time-sensitive ones + an in-page Reminders list)
// PB-3   POST /api/jobs/refresh honors job_radar_enabled (page button: ?force=1)
// PB-11  skip-recurring is atomic + idempotent (locked, refuses completed rows)
// PB-12  bulk "complete" routes recurring todos through complete-recurring
// PD-3   completing / skipping a late recurring task schedules the next
//        instance AFTER today (catch-up), not one step after the old due date
// PD-8   the email scheduler claims ONE row per iteration
// ============================================================================

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const express = require("express");
const supertest = require("supertest");

const ROOT = path.join(__dirname, "..");
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), "utf8");
const helpers = require("../helpers");
const { todayStr } = require("../routes/health");
const local = (y, m, d) => new Date(y, m - 1, d);
const addDays = (ymd, n) => { const d = new Date(ymd + "T00:00:00"); d.setDate(d.getDate() + n); return helpers.ymdLocal(d); };

// ---------------------------------------------------------------------------
// PD-3 — nextDueAfter
// ---------------------------------------------------------------------------
describe("PD-3 — next due is caught up past today", () => {
  it("a daily task due Sep 20 completed on Sep 27 → due Sep 28", () => {
    const next = helpers.nextDueAfter({ recurrence_rule: "daily", recurrence_interval: 1, due_date: local(2026, 9, 20) }, "2026-09-27");
    assert.equal(helpers.ymdLocal(next), "2026-09-28");
  });
  it("an on-time completion is unchanged (one step)", () => {
    const next = helpers.nextDueAfter({ recurrence_rule: "weekly", recurrence_interval: 1, due_date: local(2026, 9, 30) }, "2026-09-27");
    assert.equal(helpers.ymdLocal(next), "2026-10-07");
  });
  it("monthly keeps the anchor day while catching up", () => {
    const next = helpers.nextDueAfter({ recurrence_rule: "monthly", recurrence_interval: 1, due_date: local(2026, 1, 31), recurrence_anchor_day: 31 }, "2026-03-15");
    assert.equal(helpers.ymdLocal(next), "2026-03-31");
  });
});

// ---------------------------------------------------------------------------
// complete / skip harness
// ---------------------------------------------------------------------------
function mockPool(rows) {
  const log = [];
  const client = {
    query: async (sql, params) => {
      log.push({ sql, params });
      if (/BEGIN|COMMIT|ROLLBACK/.test(sql)) return {};
      if (/SELECT \* FROM todos WHERE id = \$1 AND deleted_at IS NULL FOR UPDATE/.test(sql)) {
        const r = rows[String(params[0])];
        return { rows: r ? [r] : [] };
      }
      if (/INSERT INTO todos/.test(sql)) return { rows: [{ id: 99, due_date: params[5] }] };
      return { rows: [] };
    },
    release() {},
  };
  return {
    log,
    connect: async () => client,
    query: async (sql, params) => {
      log.push({ sql, params });
      if (/SELECT id FROM todos WHERE id = ANY/.test(sql)) {
        return { rows: Object.values(rows).filter((r) => params[0].map(String).includes(String(r.id)) && r.recurring && !r.completed).map((r) => ({ id: r.id })) };
      }
      return { rows: [] };
    },
  };
}
const today = todayStr();
const overdueDaily = (id, extra = {}) => ({
  id, title: "Stretch", description: null, priority: "medium", horizon: "short", category: "health",
  recurring: true, recurrence_rule: "daily", recurrence_interval: 1, completed: false,
  due_date: new Date(addDays(today, -7) + "T00:00:00"), streak_count: 2, best_streak: 5, recurrence_parent_id: null, ...extra,
});
function todosApp(pool) {
  const app = express();
  app.use(express.json());
  app.use(require("../routes/todos")({ pool, config: require("../config") }));
  app.use(require("../routes/bulk")({ pool, config: require("../config") }));
  return app;
}

describe("PD-3 / PB-11 — complete & skip", () => {
  it("completing a week-late daily task creates the next instance due tomorrow, not overdue", async () => {
    const pool = mockPool({ 5: overdueDaily(5) });
    const res = await supertest(todosApp(pool)).post("/api/todos/5/complete-recurring").expect(200);
    assert.equal(res.body.next.due_date, addDays(today, 1));
  });
  it("skip-recurring locks the row, catches up, and refuses an already-completed row", async () => {
    const pool = mockPool({ 6: overdueDaily(6), 7: overdueDaily(7, { completed: true }) });
    const res = await supertest(todosApp(pool)).post("/api/todos/6/skip-recurring").expect(200);
    assert.equal(res.body.next.due_date, addDays(today, 1));
    assert.ok(pool.log.some((l) => /FOR UPDATE/.test(l.sql)), "row locked");
    const again = await supertest(todosApp(pool)).post("/api/todos/7/skip-recurring");
    assert.equal(again.status, 400);
    assert.equal(pool.log.filter((l) => /INSERT INTO todos/.test(l.sql)).length, 1, "no second next instance");
  });
});

// ---------------------------------------------------------------------------
// PB-12 — bulk complete
// ---------------------------------------------------------------------------
describe("PB-12 — bulk complete keeps recurring series alive", () => {
  it("recurring ids go through complete-recurring; the plain UPDATE excludes them", async () => {
    const pool = mockPool({ 5: overdueDaily(5), 8: { id: 8, recurring: false, completed: false } });
    const res = await supertest(todosApp(pool)).post("/api/bulk/todos").send({ ids: [5, 8], action: "complete" }).expect(200);
    assert.equal(res.body.ok, true);
    assert.equal(pool.log.filter((l) => /INSERT INTO todos/.test(l.sql)).length, 1, "next instance for the recurring todo");
    const plain = pool.log.find((l) => /UPDATE todos SET completed = true, completed_at = now\(\) WHERE id = ANY/.test(l.sql));
    assert.ok(plain);
    assert.match(plain.sql, /NOT \(id = ANY\(\$2::int\[\]\)\)/);
    assert.deepEqual(plain.params[1], [5]);
  });
});

// ---------------------------------------------------------------------------
// PB-3 — Job Radar refresh honors the flag
// ---------------------------------------------------------------------------
describe("PB-3 — /api/jobs/refresh respects job_radar_enabled", () => {
  function app(enabled, seen) {
    const pool = { query: async (sql) => { seen.push(sql); if (/job_radar_enabled/.test(sql)) return { rows: [{ job_radar_enabled: enabled }] }; return { rows: [] }; } };
    const a = express(); a.use(express.json()); a.use(require("../routes/jobs")({ pool })); return a;
  }
  it("disabled → skipped, nothing ingested", async () => {
    const seen = [];
    const res = await supertest(app(false, seen)).post("/api/jobs/refresh").expect(200);
    assert.deepEqual(res.body, { ok: true, skipped: "disabled" });
    assert.equal(seen.length, 1, "only the flag read");
  });
  it("?force=1 (the page button) runs regardless", async () => {
    const seen = [];
    const res = await supertest(app(false, seen)).post("/api/jobs/refresh?force=1");
    assert.notEqual(res.body.skipped, "disabled");
    assert.ok(!seen.some((s) => /SELECT job_radar_enabled FROM user_settings/.test(s)), "force skips the flag read");
    assert.match(read("pages", "jobs.js"), /fetch\('\/api\/jobs\/refresh\?force=1'/);
  });
});

// ---------------------------------------------------------------------------
// PB-1 — notification types reach the user
// ---------------------------------------------------------------------------
describe("PB-1 — every notification-check type surfaces", () => {
  const src = require("../pages/dashboard-script.js");
  function extract(name) {
    const i = src.indexOf("function " + name + "(");
    let depth = 0, j = src.indexOf("{", i);
    for (let k = j; k < src.length; k++) {
      if (src[k] === "{") depth++;
      else if (src[k] === "}") { depth--; if (depth === 0) return src.slice(i, k + 1); }
    }
    return null;
  }
  // eslint-disable-next-line no-new-func
  const fns = new Function(
    "var REMINDER_PREFIX = " + src.match(/var REMINDER_PREFIX = (\{[\s\S]*?\});/)[1] + ";\n" +
    extract("reminderPrefix") + "\n" + extract("isImportantReminder") + "\nreturn { reminderPrefix, isImportantReminder };")();

  it("note reminders, habit streaks, due-today and Job Radar now notify", () => {
    for (const type of ["reminder", "habit_streak_at_risk", "due_today", "job_radar", "overdue", "streak_at_risk"]) {
      assert.equal(fns.isImportantReminder({ type, title: "x" }), true, type);
    }
  });
  it("rent notifies once due / overdue / within 3 days; facts within 7 days", () => {
    assert.equal(fns.isImportantReminder({ type: "housing_due", status: "overdue" }), true);
    assert.equal(fns.isImportantReminder({ type: "housing_due", status: "due_today" }), true);
    assert.equal(fns.isImportantReminder({ type: "housing_due", status: "upcoming", days_away: 2 }), true);
    assert.equal(fns.isImportantReminder({ type: "housing_due", status: "upcoming", days_away: 20 }), false);
    assert.equal(fns.isImportantReminder({ type: "fact_upcoming", days_away: 9 }), false);
  });
  it("prefixes per type", () => {
    assert.equal(fns.reminderPrefix({ type: "reminder" }), "Reminder: ");
    assert.equal(fns.reminderPrefix({ type: "habit_streak_at_risk" }), "Habit streak at risk: ");
  });
  it("an in-page Reminders widget renders the full list regardless of permission", () => {
    assert.match(read("pages", "dashboard.js"), /data-widget="reminders"[\s\S]*id="reminders-content"/);
    const call = src.indexOf("renderReminders(list);");
    const perm = src.indexOf("Notification.permission === 'granted'", src.indexOf("/api/notifications/check"));
    assert.ok(call > 0 && call < perm, "rendered before (outside) the permission check");
  });
});

// ---------------------------------------------------------------------------
// PD-8 — one-row email claims
// ---------------------------------------------------------------------------
describe("PD-8 — scheduler claims one email per iteration", () => {
  it("claims with LIMIT 1 … FOR UPDATE SKIP LOCKED inside the loop", () => {
    const src = read("server.js");
    const fn = src.slice(src.indexOf("async function processScheduledEmails"), src.indexOf("// Lifecycle"));
    assert.match(fn, /for \(let n = 0; n < MAX_PER_RUN; n\+\+\)/);
    assert.match(fn, /WHERE id = \(\s*SELECT id FROM emails[\s\S]*?LIMIT 1\s*FOR UPDATE SKIP LOCKED\s*\)/);
    assert.doesNotMatch(fn, /WHERE id IN \(/, "no whole-batch claim");
  });
});
