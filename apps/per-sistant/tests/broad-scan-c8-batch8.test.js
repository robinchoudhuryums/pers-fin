// ============================================================================
// Cycle-8 broad scan Batch 8 — Per-sistant's DATE values (F52)
// ============================================================================
// db.js's pool returns a DATE column as its 'YYYY-MM-DD' text (pool-scoped
// types — Perfin's pool keeps its own parsing). node-pg's default built a LOCAL
// midnight Date, which JSON-serialized in UTC: on a server east of UTC every
// due date went out a day early, and ai.js's toISOString() quoted it a day
// early too. Server code turns a value into a local Date with helpers.calDate
// and back with helpers.ymdOf (either shape accepted). These run in child
// processes under a zone east of UTC (Asia/Tokyo) and one west (America/
// Los_Angeles); the real-Postgres half is the root tests/contract/c8-batch8.
// ============================================================================
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
function inZone(tz, code) {
  const r = spawnSync(process.execPath, ["-e", code], {
    env: { ...process.env, TZ: tz, PERSISTENT_DATABASE_URL: "postgres://x@localhost/x", SESSION_SECRET: "t" },
    encoding: "utf8", cwd: ROOT,
  });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout.trim().split("\n").pop());
}

describe("F52 — a DATE is its own calendar day in any server zone", () => {
  for (const tz of ["Asia/Tokyo", "America/Los_Angeles"]) {
    it(`the pool's parser, calDate and ymdOf (${tz})`, () => {
      const out = inZone(tz, `
        const { DATE_AS_STRING } = require("./db");
        const h = require("./helpers");
        const date = DATE_AS_STRING.getTypeParser(1082, "text")("2026-10-31");
        const ts = DATE_AS_STRING.getTypeParser(1184, "text")("2026-10-31 12:00:00+00");
        const local = new Date(2026, 9, 31);
        console.log(JSON.stringify({
          date, tsIsDate: ts instanceof Date, json: JSON.stringify({ due_date: date }),
          day: h.calDate(date).getDate(), month: h.calDate(date).getMonth(),
          ymd: h.ymdOf(date), ymdFromDate: h.ymdOf(local), passthrough: h.calDate(local) === local,
          none: [h.calDate(null), h.ymdOf(""), h.ymdOf("garbage")],
        }));`);
      assert.equal(out.date, "2026-10-31");
      assert.equal(out.tsIsDate, true, "other types keep node-pg's parsing");
      assert.equal(out.json, '{"due_date":"2026-10-31"}', "serialized as its own day");
      assert.equal(out.day, 31);
      assert.equal(out.month, 9);
      assert.equal(out.ymd, "2026-10-31");
      assert.equal(out.ymdFromDate, "2026-10-31");
      assert.equal(out.passthrough, true);
      assert.deepEqual(out.none, [null, null, null]);
    });

    it(`the calendar's ICS day and a month-end projection (${tz})`, () => {
      const out = inZone(tz, `
        const express = require("express");
        const supertest = require("supertest");
        const rows = (sql) => {
          if (/FROM todos WHERE deleted_at IS NULL AND due_date IS NOT NULL/.test(sql)) return [{ id: 1, title: "Rent", due_date: "2026-10-31", priority: "high" }];
          if (/recurring = true/.test(sql)) return [{ id: 2, title: "Bill", due_date: "2026-10-31", recurrence_rule: "monthly", recurrence_interval: 1, recurrence_anchor_day: null }];
          return [];
        };
        const app = express();
        app.use(require("./routes/calendar")({ pool: { query: async (sql) => ({ rows: rows(sql) }) }, helpers: require("./helpers") }));
        (async () => {
          const ics = (await supertest(app).get("/api/calendar.ics")).text;
          const cal = (await supertest(app).get("/api/calendar?month=11&year=2026")).body;
          console.log(JSON.stringify({
            start: (/DTSTART;VALUE=DATE:(\\d+)/.exec(ics) || [])[1], end: (/DTEND;VALUE=DATE:(\\d+)/.exec(ics) || [])[1],
            projected: cal.filter((e) => e.recurring_projection).map((e) => e.event_date),
          }));
        })();`);
      assert.equal(out.start, "20261031");
      assert.equal(out.end, "20261101");
      assert.deepEqual(out.projected, ["2026-11-30"]);
    });
  }

  it("no server code formats a DATE value with toISOString or new Date(...) any more", () => {
    const files = ["helpers.js", "routes/ai.js", "routes/calendar.js", "routes/todos.js", "routes/notifications.js"];
    for (const f of files) {
      const src = fs.readFileSync(path.join(ROOT, f), "utf8");
      assert.doesNotMatch(src, /\.due_date\.toISOString\(\)/, f);
      assert.doesNotMatch(src, /new Date\((?:t|todo|x|f)\.(?:due_date|event_date|on_date)\)/, f);
    }
    assert.match(fs.readFileSync(path.join(ROOT, "db.js"), "utf8"), /types: DATE_AS_STRING,/);
  });
});
