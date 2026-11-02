// Real-Postgres contract test for seams audit #4 batch S4-5, C6: Per-sistant's
// Analytics heatmap buckets a completion by its APP_TIMEZONE calendar day. A task
// completed at 03:00 UTC is the previous evening in Los Angeles — the old
// DATE(completed_at) put it on the UTC day, tomorrow on the user's calendar.
const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const supertest = require("supertest");
const { SKIP, persistentDb, persistentApp } = require("./_setup");

describe("Seams audit #4 S4-5 — the heatmap day on real Postgres", { skip: SKIP }, () => {
  let pool, app;
  const savedTz = process.env.APP_TIMEZONE;
  before(async () => {
    pool = await persistentDb("s4_5");
    app = persistentApp(pool);
  });
  after(async () => {
    if (savedTz === undefined) delete process.env.APP_TIMEZONE; else process.env.APP_TIMEZONE = savedTz;
    if (pool) await pool.end();
  });

  it("a 03:00 UTC completion is the previous day in America/Los_Angeles, the same day in UTC", async () => {
    const now = new Date();
    const utcToday = now.toISOString().slice(0, 10);
    const utcYesterday = new Date(Date.parse(utcToday + "T00:00:00Z") - 86400000).toISOString().slice(0, 10);
    await pool.query("INSERT INTO todos (title, completed, completed_at) VALUES ('evening in LA', true, $1::timestamptz)",
      [utcToday + "T03:00:00Z"]);
    // A linked task the sync closed is never on the heatmap (cycle-8 F18).
    await pool.query(`INSERT INTO todos (title, source_app, source_key, completed, completed_at, auto_closed)
                      VALUES ('closed by Perfin', 'perfin', 'perfin:housing:2026-10', true, $1::timestamptz, true)`,
      [utcToday + "T03:00:00Z"]);

    process.env.APP_TIMEZONE = "America/Los_Angeles";
    const la = (await supertest(app).get("/api/analytics").expect(200)).body.heatmap;
    assert.deepEqual(la.map((h) => [h.day, Number(h.count)]), [[utcYesterday, 1]]);

    process.env.APP_TIMEZONE = "UTC";
    const utc = (await supertest(app).get("/api/analytics").expect(200)).body.heatmap;
    assert.deepEqual(utc.map((h) => [h.day, Number(h.count)]), [[utcToday, 1]]);

    process.env.APP_TIMEZONE = "Not/AZone";
    const bad = (await supertest(app).get("/api/analytics").expect(200)).body.heatmap;
    assert.deepEqual(bad.map((h) => h.day), [utcToday], "an unknown zone falls back to UTC");
  });
});
