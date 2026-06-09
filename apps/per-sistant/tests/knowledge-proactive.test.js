// ============================================================================
// Per-sistant — Proactive surfacing (Phase 3) tests
// ============================================================================

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const supertest = require("supertest");

const { upcomingFacts } = require("../routes/rag");

describe("Proactive — upcomingFacts", () => {
  it("returns rows from the upcoming-facts query", async () => {
    const pool = {
      query: async (sql) => {
        if (/on_date/.test(sql)) {
          return { rows: [{ entity: "Car Insurance", kind: "expires", on_date: "2026-09-01", days_away: 5 }] };
        }
        return { rows: [] };
      },
    };
    const rows = await upcomingFacts(pool, 30);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].entity, "Car Insurance");
  });

  it("returns [] on error (facts table missing)", async () => {
    const pool = { query: async () => { throw new Error("no table"); } };
    assert.deepEqual(await upcomingFacts(pool, 30), []);
  });
});

describe("Proactive — notification check surfaces upcoming facts", () => {
  it("adds a fact_upcoming notification + count", async () => {
    const mockPool = {
      query: async (sql) => {
        if (/on_date/.test(sql)) {
          return { rows: [{ entity: "Car Insurance", kind: "expires", on_date: "2026-09-01", days_away: 5 }] };
        }
        return { rows: [] }; // todos/notes queries
      },
    };
    const app = express();
    app.use(express.json());
    app.use(require("../routes/notifications")({ pool: mockPool }));
    const res = await supertest(app).get("/api/notifications/check").expect(200);
    const fu = res.body.notifications.find((n) => n.type === "fact_upcoming");
    assert.ok(fu, "expected a fact_upcoming notification");
    assert.match(fu.title, /Car Insurance: expires on 2026-09-01 \(in 5 days\)/);
    assert.equal(fu.days_away, 5);
    assert.equal(res.body.counts.fact_upcoming, 1);
  });

  it("still returns ok when there are no upcoming facts", async () => {
    const mockPool = { query: async () => ({ rows: [] }) };
    const app = express();
    app.use(express.json());
    app.use(require("../routes/notifications")({ pool: mockPool }));
    const res = await supertest(app).get("/api/notifications/check").expect(200);
    assert.equal(res.body.counts.fact_upcoming, 0);
    assert.ok(!res.body.notifications.some((n) => n.type === "fact_upcoming"));
  });
});
