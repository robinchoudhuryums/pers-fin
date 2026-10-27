// Real-Postgres contract test for roadmap T1.4 (Batch A — error log + uptime):
// errors captured through a wrapped console.error land in app_errors grouped by
// fingerprint, a repeat adds to the count, Resolve hides one until it happens
// again (then it reopens and is announced again), GET /api/errors and GET
// /api/data-health surface them, and /health/deep probes the real database.
const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const supertest = require("supertest");
const { SKIP, perfinDb, perfinApp } = require("./_setup");

describe("Error log on real Postgres", { skip: SKIP }, () => {
  let pool, app, errorLog, uninstall;
  const q = (s, p) => pool.query(s, p);
  // A console stand-in so the test's own output isn't wrapped.
  const target = { error() {} };

  before(async () => {
    pool = await perfinDb("errorlog");
    app = perfinApp();
    errorLog = require("../../teller/services/error-log");
    errorLog._reset();
    errorLog._state.pool = pool; // what start() sets, without the timer
    uninstall = errorLog.install(target);
  });
  after(async () => {
    if (uninstall) uninstall();
    if (errorLog) errorLog._reset();
    if (pool) await pool.end();
  });

  let fp;
  it("captured errors are written grouped, counted and announced once", async () => {
    target.error("Sheets auto-sync failed:", new Error("quota exceeded for sheet 123"));
    target.error("Sheets auto-sync failed:", new Error("quota exceeded for sheet 456"));
    await errorLog.flush();
    const rows = (await q("SELECT * FROM app_errors")).rows;
    assert.equal(rows.length, 1);
    assert.equal(rows[0].count, 2);
    assert.match(rows[0].message, /^Sheets auto-sync failed: quota exceeded/);
    assert.match(rows[0].sample, /Error: quota exceeded/);
    assert.ok(rows[0].notified_at, "announced");
    fp = rows[0].fingerprint;
    const notes = (await q("SELECT title FROM notification_log WHERE data->>'url' = '/settings#recent-errors'")).rows;
    assert.deepEqual(notes.map((n) => n.title), ["New server error"]);

    target.error("Sheets auto-sync failed:", new Error("quota exceeded for sheet 789"));
    await errorLog.flush();
    assert.equal((await q("SELECT count FROM app_errors WHERE fingerprint = $1", [fp])).rows[0].count, 3);
    assert.equal((await q("SELECT count(*)::int AS n FROM notification_log WHERE data->>'url' = '/settings#recent-errors'")).rows[0].n, 1, "not announced again");
  });

  it("GET /api/errors lists it and data-health raises it", async () => {
    const list = (await supertest(app).get("/api/errors").expect(200)).body.errors;
    assert.equal(list.length, 1);
    assert.equal(list[0].fingerprint, fp);
    assert.equal(list[0].count, 3);
    const health = (await supertest(app).get("/api/data-health").expect(200)).body;
    const issue = health.issues.find((i) => /server error\(s\) in the last 24 hours/.test(i.message));
    assert.ok(issue);
    assert.equal(issue.link, "/settings#recent-errors");
  });

  it("Resolve hides it; the same error again reopens it and announces it as back", async () => {
    await supertest(app).post("/api/errors/" + fp + "/resolve").expect(200);
    await supertest(app).post("/api/errors/nothex/resolve").expect(400);
    assert.equal((await supertest(app).get("/api/errors").expect(200)).body.errors.length, 0);
    assert.equal((await supertest(app).get("/api/errors?all=1").expect(200)).body.errors.length, 1);
    const health = (await supertest(app).get("/api/data-health").expect(200)).body;
    assert.equal(health.issues.some((i) => /server error\(s\)/.test(i.message)), false);

    await new Promise((r) => setTimeout(r, 20)); // the recurrence is later than the resolve
    target.error("Sheets auto-sync failed:", new Error("quota exceeded for sheet 1"));
    await errorLog.flush();
    const row = (await q("SELECT resolved_at, count FROM app_errors WHERE fingerprint = $1", [fp])).rows[0];
    assert.equal(row.resolved_at, null);
    assert.equal(row.count, 4);
    const titles = (await q("SELECT title FROM notification_log WHERE data->>'url' = '/settings#recent-errors' ORDER BY id")).rows.map((r) => r.title);
    assert.deepEqual(titles, ["New server error", "A server error is back"]);
  });

  it("/health/deep answers 200 against the real database and 503 when it can't connect", async () => {
    const uptime = require("../../teller/services/uptime");
    const express = require("express");
    const ok = express().get("/health/deep", uptime.deepHealthHandler({ perfinPool: pool }));
    const res = await supertest(ok).get("/health/deep").expect(200);
    assert.deepEqual(res.body, { ok: true, perfin_db: true, persistent_db: null });
    const { Pool } = require("pg");
    const dead = new Pool({ connectionString: "postgres://nobody:x@127.0.0.1:1/none", connectionTimeoutMillis: 500 });
    const bad = express().get("/health/deep", uptime.deepHealthHandler({ perfinPool: dead, timeoutMs: 2000 }));
    const res2 = await supertest(bad).get("/health/deep").expect(503);
    assert.equal(res2.body.perfin_db, false);
    await dead.end();
  });
});
