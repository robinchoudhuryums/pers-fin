// ============================================================================
// Health & Habits tracker (db/020 + routes/health.js + integrations)
// ============================================================================

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const express = require("express");
const supertest = require("supertest");

const ROOT = path.join(__dirname, "..");
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), "utf8");

const health = require("../routes/health");
const { isDueOn, meetsTarget, computeStreaks, weekKey, addDays } = health;

// 2026-06-11 is a Thursday (UTC) — sanity-pin so the scenarios below read true.
const THU = "2026-06-11";
assert.equal(new Date(THU + "T00:00:00Z").getUTCDay(), 4);
const MON = "2026-06-08";

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------
describe("isDueOn / meetsTarget", () => {
  it("daily is due every day; weekdays skips weekends", () => {
    assert.equal(isDueOn({ schedule: "daily" }, "2026-06-13"), true); // Saturday
    assert.equal(isDueOn({ schedule: "weekdays" }, "2026-06-13"), false);
    assert.equal(isDueOn({ schedule: "weekdays" }, MON), true);
  });

  it("custom_days matches only the listed days (0=Sun..6=Sat)", () => {
    const h = { schedule: "custom_days", schedule_days: [1, 3] }; // Mon, Wed
    assert.equal(isDueOn(h, MON), true);
    assert.equal(isDueOn(h, "2026-06-10"), true); // Wednesday
    assert.equal(isDueOn(h, THU), false);
  });

  it("quantity habits meet the bar only at >= target; boolean at any value > 0", () => {
    const q = { kind: "quantity", target_value: 8 };
    assert.equal(meetsTarget(q, 5), false);
    assert.equal(meetsTarget(q, 8), true);
    assert.equal(meetsTarget({ kind: "boolean" }, 1), true);
    assert.equal(meetsTarget({ kind: "boolean" }, 0), false);
  });

  it("weekKey returns the Monday of the containing week", () => {
    assert.equal(weekKey(THU), MON);
    assert.equal(weekKey(MON), MON);
    assert.equal(weekKey("2026-06-14"), MON); // Sunday belongs to Monday's week
  });

  // F11: "today" is timezone-aware. Default (no/UTC) matches the old UTC date;
  // a passed IANA zone resolves a YYYY-MM-DD in that zone; a bad zone falls back.
  it("todayStr is timezone-aware and falls back safely (F11)", () => {
    const { todayStr } = health;
    const utc = new Date().toISOString().split("T")[0];
    assert.equal(todayStr("UTC"), utc, "UTC matches the legacy ISO date");
    assert.match(todayStr("America/New_York"), /^\d{4}-\d{2}-\d{2}$/);
    // Unknown timezone must not throw — it degrades to the UTC date.
    assert.equal(todayStr("Not/AZone"), utc);
  });
});

describe("computeStreaks — daily schedules", () => {
  const daily = { kind: "boolean", schedule: "daily" };
  const logs = (...dates) => dates.map(d => ({ log_date: d, value: 1 }));

  it("counts consecutive days; an unlogged today does not break the streak", () => {
    const r = computeStreaks(daily, logs("2026-06-09", "2026-06-10"), THU);
    assert.equal(r.current_streak, 2);
  });

  it("today's log extends the streak immediately", () => {
    const r = computeStreaks(daily, logs("2026-06-09", "2026-06-10", THU), THU);
    assert.equal(r.current_streak, 3);
  });

  it("a missed day before yesterday breaks the run; best streak remembers the longest", () => {
    const r = computeStreaks(daily, logs("2026-06-01", "2026-06-02", "2026-06-03", "2026-06-04", "2026-06-05", "2026-06-09", "2026-06-10"), THU);
    assert.equal(r.current_streak, 2);
    assert.equal(r.best_streak, 5);
  });

  it("a backfilled log retroactively repairs the streak (read-time computation)", () => {
    const broken = computeStreaks(daily, logs("2026-06-08", "2026-06-10"), THU);
    assert.equal(broken.current_streak, 1);
    const repaired = computeStreaks(daily, logs("2026-06-08", "2026-06-09", "2026-06-10"), THU);
    assert.equal(repaired.current_streak, 3);
  });

  it("weekdays schedule skips the weekend when walking back", () => {
    const h = { kind: "boolean", schedule: "weekdays" };
    // Today Mon (unlogged), logged Thu + Fri of the prior week → streak 2.
    const r = computeStreaks(h, logs("2026-06-04", "2026-06-05"), MON);
    assert.equal(r.current_streak, 2);
  });

  it("quantity habits below target do not count toward the streak", () => {
    const h = { kind: "quantity", target_value: 8, schedule: "daily" };
    const r = computeStreaks(h, [
      { log_date: "2026-06-09", value: 8 },
      { log_date: "2026-06-10", value: 5 }, // short of target
    ], THU);
    assert.equal(r.current_streak, 0);
    assert.equal(r.best_streak, 1);
  });

  it("no logs → zero streaks", () => {
    const r = computeStreaks(daily, [], THU);
    assert.equal(r.current_streak, 0);
    assert.equal(r.best_streak, 0);
  });
});

describe("computeStreaks — weekly schedules", () => {
  const weekly = { kind: "boolean", schedule: "weekly", times_per_week: 3 };
  const logs = (...dates) => dates.map(d => ({ log_date: d, value: 1 }));

  it("an in-progress week neither counts nor breaks", () => {
    // Last week met (3 logs); this week 1 log so far.
    const r = computeStreaks(weekly, logs("2026-06-01", "2026-06-03", "2026-06-05", "2026-06-09"), THU);
    assert.equal(r.current_streak, 1);
  });

  it("the current week counts once its target is met", () => {
    const r = computeStreaks(weekly, logs("2026-06-01", "2026-06-03", "2026-06-05", "2026-06-08", "2026-06-09", "2026-06-10"), THU);
    assert.equal(r.current_streak, 2);
  });

  it("a missed prior week breaks the chain; best streak survives", () => {
    // Weeks of 05-18 and 05-25 met, week of 06-01 missed (1 log), this week met.
    const r = computeStreaks(weekly, logs(
      "2026-05-18", "2026-05-19", "2026-05-20",
      "2026-05-25", "2026-05-26", "2026-05-27",
      "2026-06-02",
      "2026-06-08", "2026-06-09", "2026-06-10"
    ), THU);
    assert.equal(r.current_streak, 1);
    assert.equal(r.best_streak, 2);
  });
});

// ---------------------------------------------------------------------------
// Routes (mock pool + supertest)
// ---------------------------------------------------------------------------
function buildApp(queryImpl) {
  const app = express();
  app.use(express.json());
  app.use(health({ pool: { query: queryImpl }, helpers: {} }));
  return app;
}

describe("habit routes — validation", () => {
  const neverQuery = async () => { throw new Error("should not hit the DB"); };

  it("POST /api/habits rejects missing name, bad schedule, bad kind", async () => {
    const app = buildApp(neverQuery);
    await supertest(app).post("/api/habits").send({}).expect(400);
    await supertest(app).post("/api/habits").send({ name: "Run", schedule: "fortnightly" }).expect(400);
    await supertest(app).post("/api/habits").send({ name: "Run", kind: "maybe" }).expect(400);
  });

  it("POST /api/habits enforces schedule-specific fields", async () => {
    const app = buildApp(neverQuery);
    // custom_days without days / with out-of-range day
    await supertest(app).post("/api/habits").send({ name: "Gym", schedule: "custom_days" }).expect(400);
    await supertest(app).post("/api/habits").send({ name: "Gym", schedule: "custom_days", schedule_days: [7] }).expect(400);
    // weekly without times_per_week
    await supertest(app).post("/api/habits").send({ name: "Gym", schedule: "weekly" }).expect(400);
    await supertest(app).post("/api/habits").send({ name: "Gym", schedule: "weekly", times_per_week: 9 }).expect(400);
    // quantity without target
    await supertest(app).post("/api/habits").send({ name: "Water", kind: "quantity" }).expect(400);
  });

  it("POST /api/habits inserts a valid habit with normalized fields", async () => {
    let captured;
    const app = buildApp(async (sql, params) => {
      if (/INSERT INTO habits/.test(sql)) { captured = params; return { rows: [{ id: 1 }] }; }
      return { rows: [] };
    });
    await supertest(app).post("/api/habits")
      .send({ name: "  Gym  ", schedule: "custom_days", schedule_days: [3, 1, 1] })
      .expect(200);
    assert.equal(captured[0], "Gym", "name trimmed");
    assert.deepEqual(captured[6], [1, 3], "schedule_days deduped + sorted");
  });

  it("POST /api/habits/:id/log rejects future dates and negative values", async () => {
    const app = buildApp(async () => ({ rows: [{ id: 1, kind: "boolean", schedule: "daily" }] }));
    const future = addDays(new Date().toISOString().split("T")[0], 1);
    await supertest(app).post("/api/habits/1/log").send({ date: future }).expect(400);
    await supertest(app).post("/api/habits/1/log").send({ date: "junk" }).expect(400);
    await supertest(app).post("/api/habits/1/log").send({ value: -1 }).expect(400);
  });

  it("POST /api/habits/:id/log upserts and returns the recomputed streak", async () => {
    const today = new Date().toISOString().split("T")[0];
    const app = buildApp(async (sql) => {
      if (/SELECT \* FROM habits/.test(sql)) return { rows: [{ id: 1, kind: "boolean", schedule: "daily" }] };
      if (/INSERT INTO habit_logs/.test(sql)) {
        assert.match(sql, /ON CONFLICT \(habit_id, log_date\)/, "log writes are idempotent per day");
        return { rows: [{ id: 9, habit_id: 1, log_date: today, value: 1 }] };
      }
      if (/SELECT log_date, value FROM habit_logs/.test(sql)) {
        return { rows: [{ log_date: addDays(today, -1), value: 1 }, { log_date: today, value: 1 }] };
      }
      return { rows: [] };
    });
    const res = await supertest(app).post("/api/habits/1/log").send({}).expect(200);
    assert.equal(res.body.current_streak, 2);
  });

  it("DELETE /api/habits/:id archives instead of deleting (history kept)", async () => {
    let sql;
    const app = buildApp(async (s) => { sql = s; return { rows: [{ id: 1 }] }; });
    const res = await supertest(app).delete("/api/habits/1").expect(200);
    assert.equal(res.body.archived, true);
    assert.match(sql, /UPDATE habits SET is_active = false/);
    assert.doesNotMatch(sql, /DELETE FROM habits/);
  });

  // F9: PATCH must enforce the quantity⇒target_value invariant on the MERGED
  // state, not just the partial body — otherwise switching a habit to quantity
  // without a target silently degrades meetsTarget to "any value > 0 counts".
  it("PATCH kind:'quantity' without a target rejects when the habit has no existing target (F9)", async () => {
    const app = buildApp(async (sql) => {
      if (/SELECT kind, target_value FROM habits/.test(sql)) return { rows: [{ kind: "boolean", target_value: null }] };
      if (/UPDATE habits SET/.test(sql)) return { rows: [{ id: 1 }] };
      return { rows: [] };
    });
    await supertest(app).patch("/api/habits/1").send({ kind: "quantity" }).expect(400);
  });

  it("PATCH kind:'quantity' is allowed when the habit already has a target (F9)", async () => {
    const app = buildApp(async (sql) => {
      if (/SELECT kind, target_value FROM habits/.test(sql)) return { rows: [{ kind: "quantity", target_value: 8 }] };
      if (/UPDATE habits SET/.test(sql)) return { rows: [{ id: 1, kind: "quantity", target_value: 8 }] };
      return { rows: [] };
    });
    await supertest(app).patch("/api/habits/1").send({ kind: "quantity" }).expect(200);
  });

  it("PATCH kind:'quantity' with a target in the same body succeeds (F9)", async () => {
    const app = buildApp(async (sql) => {
      if (/SELECT kind, target_value FROM habits/.test(sql)) return { rows: [{ kind: "boolean", target_value: null }] };
      if (/UPDATE habits SET/.test(sql)) return { rows: [{ id: 1, kind: "quantity", target_value: 5 }] };
      return { rows: [] };
    });
    await supertest(app).patch("/api/habits/1").send({ kind: "quantity", target_value: 5 }).expect(200);
  });

  it("PATCH target_value:null on an existing quantity habit rejects (F9)", async () => {
    const app = buildApp(async (sql) => {
      if (/SELECT kind, target_value FROM habits/.test(sql)) return { rows: [{ kind: "quantity", target_value: 8 }] };
      if (/UPDATE habits SET/.test(sql)) return { rows: [{ id: 1 }] };
      return { rows: [] };
    });
    await supertest(app).patch("/api/habits/1").send({ target_value: null }).expect(400);
  });

  it("POST /api/health/metrics validates and lowercases the metric name", async () => {
    let captured;
    const app = buildApp(async (sql, params) => {
      if (/INSERT INTO health_metrics/.test(sql)) { captured = params; return { rows: [{ id: 1 }] }; }
      return { rows: [] };
    });
    await supertest(app).post("/api/health/metrics").send({ value: 180 }).expect(400);
    await supertest(app).post("/api/health/metrics").send({ metric: "Weight", value: "junk" }).expect(400);
    await supertest(app).post("/api/health/metrics").send({ metric: "Weight", value: 180.5 }).expect(200);
    assert.equal(captured[0], "weight");
    assert.equal(captured[1], 180.5);
  });
});

describe("gatherHealthSummary", () => {
  it("reports due/done counts and streaks at risk from one shared aggregator", async () => {
    const today = new Date().toISOString().split("T")[0];
    const pool = {
      query: async (sql) => {
        if (/FROM habits WHERE is_active/.test(sql)) {
          return { rows: [
            { id: 1, name: "Run", kind: "boolean", schedule: "daily", target_value: null },
            { id: 2, name: "Read", kind: "boolean", schedule: "daily", target_value: null },
          ] };
        }
        if (/FROM habit_logs/.test(sql)) {
          // Run: 4-day streak ending yesterday (at risk). Read: done today.
          return { rows: [
            { habit_id: 1, log_date: addDays(today, -4), value: 1 },
            { habit_id: 1, log_date: addDays(today, -3), value: 1 },
            { habit_id: 1, log_date: addDays(today, -2), value: 1 },
            { habit_id: 1, log_date: addDays(today, -1), value: 1 },
            { habit_id: 2, log_date: today, value: 1 },
          ] };
        }
        return { rows: [] }; // metrics
      },
    };
    const s = await health.gatherHealthSummary(pool);
    assert.equal(s.due_today, 2);
    assert.equal(s.done_today, 1);
    assert.equal(s.streaks_at_risk.length, 1);
    assert.equal(s.streaks_at_risk[0].name, "Run");
    assert.equal(s.streaks_at_risk[0].current_streak, 4);
    const run = s.habits.find(h => h.id === 1);
    assert.equal(run.week.length, 7, "7-day grid present");
  });
});

// ---------------------------------------------------------------------------
// Integration pins (source-read)
// ---------------------------------------------------------------------------
describe("health integration pins", () => {
  it("migration 020 creates the three health tables idempotently", () => {
    const sql = read("db", "020_health.sql");
    for (const t of ["habits", "habit_logs", "health_metrics"]) {
      assert.match(sql, new RegExp(`CREATE TABLE IF NOT EXISTS ${t}`));
    }
    assert.match(sql, /UNIQUE \(habit_id, log_date\)/);
    assert.match(sql, /UNIQUE \(metric, recorded_on\)/);
  });

  it("server mounts the health routes and page", () => {
    const src = read("server.js");
    assert.match(src, /routes\/health/);
    assert.match(src, /app\.get\("\/health", require\("\.\/pages\/health"\)\(\)\)/);
  });

  it("navBar lists /health", () => {
    const src = read("views.js");
    assert.match(src, /href: "\/health"/);
    assert.match(src, /case 'health':/);
  });

  it("the health page nonces its inline script and uses no inline handlers (CSP)", () => {
    const src = read("pages", "health.js");
    assert.match(src, /<script\$\{nonceAttr\(\)\}>/);
    assert.doesNotMatch(src, /onclick=|onchange=/);
    // one template literal — the inline JS must stay backtick-free
    const inner = src.slice(src.indexOf("<script"), src.indexOf("</script>"));
    assert.ok(!inner.slice(inner.indexOf(">") + 1).includes("`"), "page JS is backtick-free");
  });

  it("notification check includes habit streaks fail-softly", () => {
    const src = read("routes", "notifications.js");
    assert.match(src, /gatherHealthSummary\(pool\)\.catch/, "health leg degrades, never 500s the check");
    assert.match(src, /habit_streak_at_risk/);
  });

  it("AI daily briefing feeds habit status into the prompt fail-softly", () => {
    const src = read("routes", "ai.js");
    assert.match(src, /gatherHealthSummary\(pool\)\.catch\(\(\) => null\)/);
    assert.match(src, /Habits due today/);
  });

  it("helper exports are attached AFTER the factory assignment (INV-19)", () => {
    const src = read("routes", "health.js");
    const factoryIdx = src.indexOf("module.exports = function");
    for (const helper of ["isDueOn", "computeStreaks", "gatherHealthSummary"]) {
      assert.ok(src.indexOf(`module.exports.${helper}`) > factoryIdx, helper);
    }
  });
});
