// ============================================================================
// Broad-scan (Sept 2026) Batch 6 — Per-sistant dates + knowledge cache
// ============================================================================
// PD-2   monthly/yearly recurrences keep their anchor day (Jan 31 → Feb 28 →
//        Mar 31; Feb 29 yearly returns on leap years) — db/022 recurrence_anchor_day
// PD-4   complete-recurring's on-time check uses the APP_TIMEZONE date
// PB-10  the midnight roll runs in APP_TIMEZONE and marks MISSED instances
//        missed (completed_at NULL), not done; analytics exclude them
// PB-13  the notification check / AI briefing "today" is the APP_TIMEZONE date
// KR-5   the answer-cache corpus version includes the date (so validity-bounded
//        facts expire from cached answers); vault re-syncs skip unchanged rows
// ============================================================================

// Force an APP_TIMEZONE whose calendar date DIFFERS from UTC's right now, so
// any path still reading the UTC date disagrees with todayStr().
process.env.APP_TIMEZONE = new Date().getUTCHours() < 12 ? "Etc/GMT+12" : "Pacific/Kiritimati";

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

// ---------------------------------------------------------------------------
// PD-2
// ---------------------------------------------------------------------------
describe("PD-2 — advanceRecurrence keeps the anchor day", () => {
  const { advanceRecurrence, ymdLocal, recurrenceAnchorDay } = helpers;
  it("monthly from Jan 31 → Feb 28 → Mar 31 (not Mar 3 → Apr 3)", () => {
    const feb = advanceRecurrence(local(2026, 1, 31), "monthly", 1, 31);
    assert.equal(ymdLocal(feb), "2026-02-28");
    const mar = advanceRecurrence(feb, "monthly", 1, 31);
    assert.equal(ymdLocal(mar), "2026-03-31");
    assert.equal(ymdLocal(advanceRecurrence(mar, "monthly", 1, 31)), "2026-04-30");
  });
  it("without an explicit anchor the instance's own day is used (legacy rows)", () => {
    assert.equal(ymdLocal(advanceRecurrence(local(2026, 1, 31), "monthly", 1)), "2026-02-28");
    assert.equal(ymdLocal(advanceRecurrence(local(2026, 5, 15), "custom_months", 3)), "2026-08-15");
  });
  it("yearly Feb 29 → Feb 28 … → Feb 29 on the next leap year", () => {
    let d = local(2024, 2, 29);
    const seen = [];
    for (let i = 0; i < 4; i++) { d = advanceRecurrence(d, "yearly", 1, 29); seen.push(ymdLocal(d)); }
    assert.deepEqual(seen, ["2025-02-28", "2026-02-28", "2027-02-28", "2028-02-29"]);
  });
  it("December → January crosses the year", () => {
    assert.equal(ymdLocal(advanceRecurrence(local(2026, 12, 31), "monthly", 1, 31)), "2027-01-31");
  });
  it("weekly/daily are unchanged", () => {
    assert.equal(ymdLocal(advanceRecurrence(local(2026, 1, 31), "weekly", 1)), "2026-02-07");
    assert.equal(ymdLocal(advanceRecurrence(local(2026, 1, 31), "daily", 2)), "2026-02-02");
  });
  it("recurrenceAnchorDay prefers the stored anchor, else the due day", () => {
    assert.equal(recurrenceAnchorDay({ recurrence_anchor_day: 31, due_date: local(2026, 2, 28) }), 31);
    assert.equal(recurrenceAnchorDay({ recurrence_anchor_day: null, due_date: local(2026, 2, 28) }), 28);
    assert.equal(recurrenceAnchorDay({}), null);
  });
  it("migration 022 adds recurrence_anchor_day + missed idempotently", () => {
    const sql = read("db", "022_recurrence_anchor_missed.sql");
    assert.match(sql, /ADD COLUMN IF NOT EXISTS recurrence_anchor_day INT/);
    assert.match(sql, /ADD COLUMN IF NOT EXISTS missed BOOLEAN NOT NULL DEFAULT false/);
    assert.match(sql, /IF NOT EXISTS \(SELECT 1 FROM pg_constraint WHERE conname = 'chk_todos_recurrence_anchor_day'\)/);
  });
  it("a manual due-date edit resets the chain anchor; calendar projections pass it", () => {
    assert.match(read("routes/todos.js"), /recurrence_anchor_day = NULL/);
    assert.match(read("routes/calendar.js"), /recurrence_anchor_day/);
  });
});

// ---------------------------------------------------------------------------
// PB-10
// ---------------------------------------------------------------------------
describe("PB-10 — rollMissedRecurring marks missed instances", () => {
  function rollDb(todo) {
    const calls = { claim: null, insert: null, select: null };
    return {
      calls,
      query: async (sql, params) => {
        if (/^SELECT \* FROM todos/.test(sql)) { calls.select = { sql, params }; return { rows: [todo] }; }
        if (/^UPDATE todos SET completed = true/.test(sql)) { calls.claim = { sql, params }; return { rows: [{ id: todo.id }] }; }
        if (/^INSERT INTO todos/.test(sql)) { calls.insert = { sql, params }; return { rows: [] }; }
        return { rows: [] };
      },
    };
  }

  it("claims as missed (completed_at NULL), next due = first occurrence on/after today, anchor carried", async () => {
    const todo = {
      id: 3, title: "Pay rent", recurring: true, recurrence_rule: "monthly", recurrence_interval: 1,
      due_date: local(2026, 7, 31), recurrence_anchor_day: null, best_streak: 4, recurrence_parent_id: null,
    };
    const db = rollDb(todo);
    const r = await helpers.rollMissedRecurring(db, "2026-10-08");
    assert.equal(r.rolled, 1);
    assert.deepEqual(db.calls.select.params, ["2026-10-08"], "tz 'today' passed in, not CURRENT_DATE");
    assert.match(db.calls.claim.sql, /completed_at = NULL, missed = true, streak_count = 0/);
    assert.match(db.calls.claim.sql, /AND completed = false RETURNING id/, "atomic claim (PS-11)");
    const p = db.calls.insert.params;
    assert.equal(p[5], "2026-10-31", "Jul 31 → Aug 31 → Sep 30 → Oct 31 (anchor kept, ≥ today)");
    assert.equal(p[9], 3, "chain parent");
    assert.equal(p[11], 31, "anchor day stored on the new instance");
  });

  it("an occurrence due exactly today is the next instance (not skipped)", async () => {
    const todo = { id: 4, title: "x", recurring: true, recurrence_rule: "weekly", recurrence_interval: 1, due_date: local(2026, 10, 1) };
    const db = rollDb(todo);
    await helpers.rollMissedRecurring(db, "2026-10-08");
    assert.equal(db.calls.insert.params[5], "2026-10-08");
  });

  it("a row claimed by complete-recurring meanwhile is skipped", async () => {
    const todo = { id: 5, title: "x", recurring: true, recurrence_rule: "daily", recurrence_interval: 1, due_date: local(2026, 10, 1) };
    let inserted = false;
    const db = {
      query: async (sql) => {
        if (/^SELECT/.test(sql)) return { rows: [todo] };
        if (/^UPDATE/.test(sql)) return { rows: [] };
        if (/^INSERT/.test(sql)) { inserted = true; }
        return { rows: [] };
      },
    };
    const r = await helpers.rollMissedRecurring(db, "2026-10-08");
    assert.equal(r.rolled, 0);
    assert.equal(inserted, false);
  });

  it("server.js runs the roll at LOCAL midnight with the tz date", () => {
    const server = read("server.js");
    assert.match(server, /rollMissedRecurring\(pool, todayStr\(\)\)/);
    assert.match(server, /timezone: process\.env\.APP_TIMEZONE \|\| "UTC"/);
  });

  it("completion analytics + /api/stats don't count missed instances as done", () => {
    const analytics = read("routes/analytics.js");
    assert.equal((analytics.match(/FILTER \(WHERE completed AND NOT COALESCE\(missed, false\)\)/g) || []).length, 2);
    assert.match(read("routes/settings.js"), /FILTER \(WHERE completed AND NOT COALESCE\(missed, false\)\) as done/);
  });
});

// ---------------------------------------------------------------------------
// PD-4
// ---------------------------------------------------------------------------
describe("PD-4 — complete-recurring judges 'on time' by the APP_TIMEZONE date", () => {
  it("completing on the (tz) due date keeps the streak; the next instance keeps its anchor", async () => {
    const [y, m, d] = todayStr().split("-").map(Number);
    const captured = {};
    const todoRow = {
      id: 5, title: "Stretch", description: null, priority: "medium", horizon: "short",
      category: "health", recurring: true, recurrence_rule: "monthly", recurrence_interval: 1,
      completed: false, due_date: local(y, m, d), recurrence_anchor_day: 31,
      streak_count: 2, best_streak: 5, recurrence_parent_id: null,
    };
    const client = {
      query: async (sql, params) => {
        if (/BEGIN|COMMIT|ROLLBACK/.test(sql)) return {};
        if (/FOR UPDATE/.test(sql)) return { rows: [todoRow] };
        if (/UPDATE todos SET completed/.test(sql)) { captured.update = params; return {}; }
        if (/INSERT INTO todos/.test(sql)) { captured.insert = params; return { rows: [{ id: 99 }] }; }
        return { rows: [] };
      },
      release() {},
    };
    const app = express();
    app.use(express.json());
    app.use(require("../routes/todos")({ pool: { connect: async () => client }, config: require("../config") }));
    const res = await supertest(app).post("/api/todos/5/complete-recurring").expect(200);
    assert.equal(res.body.streak, 3, "on-time on the local due date (the UTC date read 'late' west of UTC)");
    assert.equal(captured.update[3], todayStr(), "last_streak_date is the tz date");
    const t = y * 12 + (m - 1) + 1;
    const ny = Math.floor(t / 12), nm = (t % 12) + 1;
    const last = new Date(ny, nm, 0).getDate();
    assert.equal(captured.insert[5], `${ny}-${String(nm).padStart(2, "0")}-${String(Math.min(31, last)).padStart(2, "0")}`);
    assert.equal(captured.insert[13], 31);
  });
});

// ---------------------------------------------------------------------------
// PB-13
// ---------------------------------------------------------------------------
describe("PB-13 — notification check + briefing use the APP_TIMEZONE date", () => {
  it("both read todayStr()", () => {
    assert.match(read("routes/notifications.js"), /const today = todayStr\(\);/);
    assert.match(read("routes/ai.js"), /const today = todayStr\(\);/);
  });
});

// ---------------------------------------------------------------------------
// KR-5
// ---------------------------------------------------------------------------
describe("KR-5 — answer-cache corpus version + idempotent vault upserts", () => {
  const rag = require("../routes/rag");
  const vs = require("../services/vault-sync");

  it("corpusVersion folds in the date, so a fact's validity boundary invalidates cached answers", async () => {
    const pool = { query: async () => ({ rows: [{ v: "20260101120000", n: "7" }] }) };
    const a = await rag.corpusVersion(pool, "2026-10-08");
    const b = await rag.corpusVersion(pool, "2026-10-09");
    assert.notEqual(a, b);
    assert.equal(await rag.corpusVersion(pool), `${todayStr()}|20260101120000:7`, "defaults to the tz date");
  });

  it("buildFactsQuery filters validity on the tz date parameter, not CURRENT_DATE", () => {
    const { sql, params } = rag.buildFactsQuery("car", 5);
    assert.ok(!/CURRENT_DATE/.test(sql));
    assert.equal(params[params.length - 1], todayStr());
    assert.match(sql, new RegExp(`valid_to >= \\$${params.length}::date`));
  });

  it("factSetSignature is order-independent and normalizes dates/tags", () => {
    const a = [
      { entity: "Car", attribute: "deductible", value: "500", valid_from: local(2026, 1, 1), valid_to: null, sensitivity: "normal", tags: ["b", "a"] },
      { entity: "Rent", attribute: "amount", value: "1500", valid_from: null, valid_to: null, sensitivity: "normal", tags: null },
    ];
    const b = [
      { entity: "Rent", attribute: "amount", value: "1500" },
      { entity: "Car", attribute: "deductible", value: "500", valid_from: "2026-01-01", tags: ["a", "b"] },
    ];
    assert.equal(vs.factSetSignature(a), vs.factSetSignature(b));
    assert.notEqual(vs.factSetSignature(a), vs.factSetSignature([b[0]]));
  });

  it("upsertFacts skips the delete + re-insert when the file's facts are unchanged", async () => {
    let connected = false;
    const current = [{ entity: "Car", attribute: "deductible", value: "500", valid_from: null, valid_to: null, sensitivity: "normal", tags: null }];
    const pool = {
      query: async () => ({ rows: current }),
      connect: async () => { connected = true; return { query: async () => ({}), release() {} }; },
    };
    const r = await vs.upsertFacts(pool, "facts.md", [{ entity: "Car", attribute: "deductible", value: "500", sensitivity: "normal" }]);
    assert.deepEqual(r, { unchanged: true });
    assert.equal(connected, false);
  });

  it("upsertFacts replaces when a value changed", async () => {
    const ops = [];
    const pool = {
      query: async () => ({ rows: [{ entity: "Car", attribute: "deductible", value: "500" }] }),
      connect: async () => ({ query: async (sql) => { ops.push(sql.trim().split(/\s+/)[0]); return {}; }, release() {} }),
    };
    await vs.upsertFacts(pool, "facts.md", [{ entity: "Car", attribute: "deductible", value: "1000" }]);
    assert.deepEqual(ops, ["BEGIN", "DELETE", "INSERT", "COMMIT"]);
  });

  it("upsertVaultDocument only rewrites a changed row and still returns the id", async () => {
    const sqls = [];
    const pool = {
      query: async (sql) => {
        sqls.push(sql);
        if (/INSERT INTO documents/.test(sql)) return { rows: [] }; // unchanged → no row
        if (/SELECT id FROM documents/.test(sql)) return { rows: [{ id: 12 }] };
        return { rows: [] };
      },
    };
    const id = await vs.upsertVaultDocument(pool, "notes/a.md", "A", "body", "normal", []);
    assert.equal(id, 12);
    assert.match(sqls[0], /IS DISTINCT FROM/);
    assert.equal(sqls.length, 2);
  });
});
