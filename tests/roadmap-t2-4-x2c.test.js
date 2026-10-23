// ============================================================================
// Roadmap T2.4 X2c — Settings → Per-sistant Tasks + POST /api/linked-tasks/run
// ============================================================================
// The run route (501 standalone, 409 while a run is going — no second run,
// 400 while the switch is off, the record's shape without internal fields, a
// thrown run a fixed 500, the app's Per-sistant pool handed over, the off-for-
// today memo cleared first). The Settings section run in a vm: the last-run
// line (counts + a source error by name), the standalone note hiding the
// controls, the embedded render, each field's PATCH (switch, each source,
// lead days — a bad value refused locally), a refused save shown and the box
// put back, Run now's POST + line + message and its failure path; the markup's
// labels and wiring. The cross-database half is tests/contract/linked-tasks-crossapp.
// ============================================================================
if (!process.env.NEON_DATABASE_URL) process.env.NEON_DATABASE_URL = "postgres://mock:mock@localhost/mock";
if (!process.env.TOKEN_ENCRYPTION_PASSPHRASE) process.env.TOKEN_ENCRYPTION_PASSPHRASE = "test-passphrase";

const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const express = require("express");
const supertest = require("supertest");

const dbModule = require("../teller/services/database");
const lt = require("../teller/services/linked-tasks");

const saved = { query: dbModule.pool.query, run: lt.runLinkedTasks, isRunning: lt.isRunning, invalidate: lt.invalidate };
beforeEach(() => lt._reset());
afterEach(() => {
  dbModule.pool.query = saved.query;
  lt.runLinkedTasks = saved.run; lt.isRunning = saved.isRunning; lt.invalidate = saved.invalidate;
  lt._reset();
});

const read = (p) => fs.readFileSync(path.join(__dirname, "..", p), "utf8");
const PS_POOL = { query: async () => { throw new Error("not used"); } };

function app({ persistentPool } = {}) {
  const a = express();
  a.use(express.json());
  if (persistentPool) a.set("persistentPool", persistentPool);
  a.use(require("../teller/routes/settings"));
  return a;
}

describe("POST /api/linked-tasks/run", () => {
  it("standalone (no Per-sistant pool) → 501, nothing read", async () => {
    let reads = 0;
    dbModule.pool.query = async () => { reads++; return { rows: [] }; };
    const r = await supertest(app()).post("/api/linked-tasks/run").expect(501);
    assert.equal(r.body.error, "Per-sistant tasks are available under the unified shell only.");
    assert.equal(reads, 0);
  });

  it("409 while a run is going, without starting another", async () => {
    let runs = 0;
    lt.isRunning = () => true;
    lt.runLinkedTasks = async () => { runs++; return { status: "ok" }; };
    const r = await supertest(app({ persistentPool: PS_POOL })).post("/api/linked-tasks/run").expect(409);
    assert.match(r.body.error, /already going/);
    assert.equal(runs, 0);
  });

  it("switched off → 400; the off-for-today memo is cleared first so a fresh read decides", async () => {
    let selects = 0;
    dbModule.pool.query = async (sql) => {
      if (/^SELECT linked_tasks_enabled/.test(sql)) { selects++; return { rows: [{ linked_tasks_enabled: false }] }; }
      throw new Error("unexpected SQL: " + sql);
    };
    const a = app({ persistentPool: PS_POOL });
    assert.equal((await supertest(a).post("/api/linked-tasks/run").expect(400)).body.error, "Turn on Per-sistant tasks first.");
    await supertest(a).post("/api/linked-tasks/run").expect(400);
    assert.equal(selects, 2, "the second press read the switch again");
  });

  it("returns the run's record (no internal fields) and hands over the app's Per-sistant pool", async () => {
    const args = [];
    lt.runLinkedTasks = async (pool, pp) => {
      args.push([pool, pp]);
      return { status: "partial", ran: true, at: "2026-11-28T10:00:00.000Z", desired: 3, created: 1, updated: 0, closed: 2, reopened: 0, skipped: 0, errors: [{ kind: "bill", error: "Could not read this source." }], extra: "x" };
    };
    const r = await supertest(app({ persistentPool: PS_POOL })).post("/api/linked-tasks/run").expect(200);
    assert.deepEqual(r.body, { status: "partial", at: "2026-11-28T10:00:00.000Z", desired: 3, created: 1, updated: 0, closed: 2, reopened: 0, skipped: 0, errors: [{ kind: "bill", error: "Could not read this source." }] });
    assert.equal(args[0][0], dbModule.pool);
    assert.equal(args[0][1], PS_POOL);
  });

  it("a thrown run → a fixed 500, never the exception text", async () => {
    lt.runLinkedTasks = async () => { throw new Error("secret detail"); };
    const orig = console.error; console.error = () => {};
    try {
      const r = await supertest(app({ persistentPool: PS_POOL })).post("/api/linked-tasks/run").expect(500);
      assert.equal(r.body.error, "An internal error occurred.");
    } finally { console.error = orig; }
  });

  it("isRunning follows a real run", async () => {
    let release;
    const pool = { query: async (sql) => {
      if (/^SELECT linked_tasks_enabled/.test(sql)) return { rows: [{ linked_tasks_enabled: true }] };
      return { rows: [] };
    } };
    const p = lt.runLinkedTasks(pool, PS_POOL, { today: "2026-11-28", deps: {
      compute: () => new Promise((r) => { release = () => r({ ok_kinds: [], desired: [], errors: [] }); }),
      sync: async () => ({}),
    } });
    await new Promise((r) => setImmediate(r));
    assert.equal(lt.isRunning(), true);
    release();
    await p;
    assert.equal(lt.isRunning(), false);
  });
});

describe("Settings → Per-sistant Tasks", () => {
  const src = read("teller/views/settings.ejs");
  function el(extra = {}) { return { hidden: false, checked: false, value: "", textContent: "", disabled: false, ...extra }; }
  function loadUi(ctxExtra = {}) {
    const start = src.indexOf("var LINKED_SOURCES");
    const end = src.indexOf("// One floor input per spendable account");
    assert.ok(start > 0 && end > start);
    const ctx = { Date, parseInt, String, Array, JSON, ...ctxExtra };
    vm.runInNewContext(src.slice(start, end), ctx);
    return ctx;
  }
  function dom() {
    const els = {};
    for (const id of ["linked-tasks-standalone", "linked-tasks-controls", "linked-tasks-toggle", "linked-src-housing", "linked-src-utility_amount", "linked-src-still_charging", "linked-src-bills", "linked-tasks-lead", "linked-tasks-last"]) els[id] = el();
    return { els, document: { getElementById: (id) => els[id] || null } };
  }
  // writeOk as perfin-shared.js has it: true on 2xx, else a toast with the server's error.
  const writeOkLike = (msgs) => async (res, what) => {
    if (res && res.ok) return true;
    let detail = "HTTP " + res.status;
    try { const b = await res.json(); if (b && b.error) detail = b.error; } catch (e) { /* not JSON */ }
    msgs.push([what + ": " + detail, false]);
    return false;
  };

  it("the last-run line: nothing while off, a prompt while on, counts and a named source error after a run", () => {
    const ui = loadUi();
    assert.equal(ui.linkedTasksLastText({ linked_tasks_enabled: false }), "");
    assert.equal(ui.linkedTasksLastText({ linked_tasks_enabled: true }), "Not run yet — it runs hourly, or press Run now.");
    const t = ui.linkedTasksLastText({ linked_tasks_state: { at: "2026-11-28T10:00:00Z", desired: 4, closed: 1, errors: [{ kind: "bill", error: "Could not read this source." }, { kind: null, error: "Could not update the tasks in Per-sistant." }] } });
    assert.match(t, /^Last run .+: 4 outstanding, 1 closed\. Manual bills: Could not read this source\. Could not update the tasks in Per-sistant\.$/);
    assert.match(ui.linkedTasksLastText({ linked_tasks_state: { at: "2026-11-28T10:00:00Z", desired: 0, closed: 0, errors: [] } }), /: 0 outstanding, 0 closed\.$/);
  });

  it("standalone: the note shows and the controls are hidden", () => {
    const { els, document } = dom();
    const ui = loadUi({ document });
    ui.renderLinkedTasks({ embedded: false, linked_tasks_enabled: true });
    assert.equal(els["linked-tasks-standalone"].hidden, false);
    assert.equal(els["linked-tasks-controls"].hidden, true);
    assert.equal(els["linked-tasks-toggle"].checked, false, "nothing else is filled in");
  });

  it("embedded: the switch, the sources, lead days and the last-run line", () => {
    const { els, document } = dom();
    const ui = loadUi({ document });
    ui.renderLinkedTasks({ embedded: true, linked_tasks_enabled: true, linked_tasks_sources: { still_charging: true, housing: false, utility_amount: true, bills: true }, linked_tasks_bill_lead_days: 0, linked_tasks_state: { at: "2026-11-28T10:00:00Z", desired: 2, closed: 0, errors: [] } });
    assert.equal(els["linked-tasks-standalone"].hidden, true);
    assert.equal(els["linked-tasks-controls"].hidden, false);
    assert.equal(els["linked-tasks-toggle"].checked, true);
    assert.deepEqual(["housing", "utility_amount", "still_charging", "bills"].map((k) => els["linked-src-" + k].checked), [false, true, true, true]);
    assert.equal(els["linked-tasks-lead"].value, "0");
    assert.match(els["linked-tasks-last"].textContent, /2 outstanding, 0 closed/);
    assert.equal(els["linked-tasks-last"].hidden, false);
  });

  it("each field is saved through PATCH /api/settings; a refused save is shown and the box put back", async () => {
    const calls = [], msgs = [];
    let status = 200;
    const { els, document } = dom();
    const ui = loadUi({
      document,
      apiFetch: async (url, opts) => {
        calls.push([url, opts.method, JSON.parse(opts.body)]);
        return { ok: status < 300, status, json: async () => (status < 300 ? {} : { error: "linked_tasks_sources must map …" }) };
      },
      writeOk: writeOkLike(msgs),
      showMsg: (t, ok) => msgs.push([t, ok]),
    });
    const box = el({ checked: true });
    await ui.onLinkedToggle(box, { linked_tasks_enabled: true });
    await ui.onLinkedToggle(box, { linked_tasks_sources: { bills: true } });
    els["linked-tasks-lead"].value = " 7 ";
    assert.equal(await ui.saveLinkedLead(), true);
    assert.deepEqual(calls, [
      ["/api/settings", "PATCH", { linked_tasks_enabled: true }],
      ["/api/settings", "PATCH", { linked_tasks_sources: { bills: true } }],
      ["/api/settings", "PATCH", { linked_tasks_bill_lead_days: 7 }],
    ]);
    assert.deepEqual(msgs, [["Setting saved.", true], ["Setting saved.", true], ["Setting saved.", true]]);
    status = 400;
    await ui.onLinkedToggle(box, { linked_tasks_sources: { housing: false } });
    assert.equal(box.checked, false, "the box goes back when the save is refused");
    assert.deepEqual(msgs[3], ["Per-sistant tasks: linked_tasks_sources must map …", false]);
  });

  it("lead days outside 0-14 or not a whole number are refused before the PATCH", async () => {
    const calls = [], msgs = [];
    const { els, document } = dom();
    const ui = loadUi({ document, apiFetch: async (u, o) => { calls.push(o.body); return { ok: true }; }, writeOk: async (r) => r.ok, showMsg: (t, ok) => msgs.push([t, ok]) });
    for (const v of ["15", "2.5", "", "-1", "abc"]) {
      els["linked-tasks-lead"].value = v;
      assert.equal(await ui.saveLinkedLead(), false, v);
    }
    assert.equal(calls.length, 0);
    assert.ok(msgs.every((m) => m[1] === false && /0 to 14/.test(m[0])));
    els["linked-tasks-lead"].value = "0";
    await ui.saveLinkedLead();
    assert.deepEqual(calls, [JSON.stringify({ linked_tasks_bill_lead_days: 0 })]);
  });

  it("Run now posts, shows the new line and a message, and re-enables the button; a refusal is shown", async () => {
    const calls = [], msgs = [];
    let reply = { ok: true, status: 200, json: async () => ({ status: "ok", at: "2026-11-28T10:00:00Z", desired: 3, closed: 1, errors: [] }) };
    const { els, document } = dom();
    const ui = loadUi({ document, apiFetch: async (url, opts) => { calls.push([url, opts.method]); return reply; }, writeOk: writeOkLike(msgs), showMsg: (t, ok) => msgs.push([t, ok]) });
    const btn = el();
    assert.equal(await ui.runLinkedTasksNow(btn), true);
    assert.deepEqual(calls, [["/api/linked-tasks/run", "POST"]]);
    assert.match(els["linked-tasks-last"].textContent, /3 outstanding, 1 closed/);
    assert.deepEqual(msgs, [["Per-sistant tasks updated: 3 outstanding, 1 closed.", true]]);
    assert.equal(btn.disabled, false);
    reply = { ok: false, status: 409, json: async () => ({ error: "A run is already going — try again in a moment." }) };
    assert.equal(await ui.runLinkedTasksNow(btn), false);
    assert.deepEqual(msgs[1], ["Run now: A run is already going — try again in a moment.", false]);
    assert.equal(btn.disabled, false);
  });

  it("the markup labels every control and wires each one; loadSettings renders the section", () => {
    const section = src.slice(src.indexOf('id="linked-tasks-section"'), src.indexOf('id="keepalive-section"'));
    assert.match(section, /<p class="desc" id="linked-tasks-standalone" hidden>Available under the unified shell/);
    assert.match(section, /id="linked-tasks-toggle" aria-label="Create tasks in Per-sistant"/);
    for (const k of ["housing", "utility_amount", "still_charging", "bills"]) {
      assert.match(section, new RegExp(`<input type="checkbox" id="linked-src-${k}" data-source="${k}"> <label for="linked-src-${k}">`));
      assert.match(src, new RegExp(`\\['linked-src-${k}', 'change', function\\(\\) \\{ onLinkedToggle\\(this, \\{ linked_tasks_sources: \\{ ${k}: this.checked \\} \\}\\); \\}\\]`));
    }
    assert.match(section, /Manual bills due — off by default: autopaid bills nobody marks paid stay open/);
    assert.match(section, /id="linked-tasks-lead"[^>]*aria-label="Bill lead days"/);
    assert.match(section, /<button class="btn" id="linked-tasks-run">Run now<\/button>/);
    assert.doesNotMatch(section, /data-e2e-skip/, "Run now is not destructive — the sweep presses it");
    assert.match(src, /\['linked-tasks-toggle', 'change', function\(\) \{ onLinkedToggle\(this, \{ linked_tasks_enabled: this.checked \}\); \}\]/);
    assert.match(src, /\['linked-tasks-run', 'click', function\(\) \{ runLinkedTasksNow\(this\); \}\]/);
    assert.match(src, /renderCashAlertLast\(s\);\n\s+renderLinkedTasks\(s\);/);
  });
});
