// Seams & Invariants audit #4, batch S4-5, Per-sistant's side — C6: the Analytics
// heatmap buckets a completion by its APP_TIMEZONE calendar day (it used DATE()
// in the database's zone, UTC, so an evening completion west of UTC landed on
// tomorrow). The database-backed half is tests/contract/seams4-s4-5.contract.test.js.
const { describe, it, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const supertest = require("supertest");
const analytics = require("../routes/analytics");

describe("C6 — the heatmap day is the APP_TIMEZONE day", () => {
  const saved = process.env.APP_TIMEZONE;
  afterEach(() => { if (saved === undefined) delete process.env.APP_TIMEZONE; else process.env.APP_TIMEZONE = saved; });

  it("heatmapTimezone: APP_TIMEZONE, else UTC; an unknown zone → UTC", () => {
    assert.equal(analytics.heatmapTimezone("America/Los_Angeles"), "America/Los_Angeles");
    assert.equal(analytics.heatmapTimezone("Not/AZone"), "UTC");
    process.env.APP_TIMEZONE = "Asia/Tokyo";
    assert.equal(analytics.heatmapTimezone(), "Asia/Tokyo");
    delete process.env.APP_TIMEZONE;
    assert.equal(analytics.heatmapTimezone(), "UTC");
  });

  it("the SQL buckets completed_at AT TIME ZONE $2 as a 'YYYY-MM-DD' text day, auto-closed left out", () => {
    assert.match(analytics.HEATMAP_SQL, /SELECT \(\(completed_at AT TIME ZONE \$2\)::date\)::text as day, COUNT\(\*\) as count FROM todos/);
    assert.match(analytics.HEATMAP_SQL, /completed = true AND NOT auto_closed AND completed_at >= \$1 GROUP BY 1 ORDER BY 1/);
    assert.doesNotMatch(analytics.HEATMAP_SQL, /DATE\(completed_at\)/);
  });

  it("GET /api/analytics passes the zone with the heatmap query and returns its rows", async () => {
    process.env.APP_TIMEZONE = "America/Los_Angeles";
    const calls = [];
    const pool = {
      query: async (sql, params) => {
        calls.push([sql, params]);
        if (sql === analytics.HEATMAP_SQL) return { rows: [{ day: "2026-11-01", count: "2" }] };
        return { rows: [{ done: "0", total: "0", count: "0" }] };
      },
    };
    const app = express();
    app.use(analytics({ pool }));
    const body = (await supertest(app).get("/api/analytics").expect(200)).body;
    const hm = calls.find(([sql]) => sql === analytics.HEATMAP_SQL);
    assert.ok(hm, "the heatmap query ran");
    assert.match(hm[1][0], /^\d{4}-\d{2}-\d{2}$/);
    assert.equal(hm[1][1], "America/Los_Angeles");
    assert.deepEqual(body.heatmap, [{ day: "2026-11-01", count: "2" }]);
  });
});
