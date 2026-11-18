// Cycle 9, the Batch 5 follow-on items — Per-sistant's side.
//  FO-6 — PATCH /api/settings gets the rules Perfin's route got in F47: the
//         three on / off switches take only true / false ("false" used to
//         switch them ON), the keep-alive hours, the session timeout and the
//         default horizon are validated, the keep-alive zone must be a real
//         one, and the dashboard layout must have the shape the dashboard
//         reads. The Settings page and the dashboard no longer save over
//         settings they couldn't load.
//  FO-7 — the rent line steps aside for a showing task of ANY unpaid month
//         (never for a month that isn't owed).
// The Perfin side is the root tests/cycle9-b5-followons.test.js; the
// database-backed half tests/contract/c9-batch5-followons.contract.test.js.
process.env.APP_TIMEZONE = "UTC";
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const vm = require("vm");
const express = require("express");
const supertest = require("supertest");

const config = require("../config");
const { housingDue, housingDueUnlessTask, housingTaskOpen } = require("../routes/housing-due");

// ---------------------------------------------------------------------------
describe("FO-6 — PATCH /api/settings validates what it stores", () => {
  function app(calls, session) {
    const pool = { query: async (sql, params) => { calls.push({ sql, params }); return { rows: [{ id: 1 }], rowCount: 1 }; } };
    const a = express();
    a.use(express.json());
    if (session) a.use((req, _res, next) => { req.session = session; next(); });
    a.use(require("../routes/settings")({ pool, config }));
    return a;
  }
  const patch = (a, body) => supertest(a).patch("/api/settings").send(body);

  it("the three switches take only true or false — a 400 before any query", async () => {
    for (const key of ["keep_alive_enabled", "vault_enabled", "job_radar_enabled"]) {
      for (const bad of ["false", "true", 0, 1, null, "", [], {}]) {
        const calls = [];
        const r = await patch(app(calls), { [key]: bad, theme: "dark" }).expect(400);
        assert.equal(r.body.error, key + " must be true or false");
        // "false" used to be stored as true (`!!"false"`).
        assert.deepEqual(calls, [], key + " " + JSON.stringify(bad));
      }
      for (const good of [true, false]) {
        const calls = [];
        await patch(app(calls), { [key]: good }).expect(200);
        assert.deepEqual(calls.map((c) => [c.sql, c.params]), [[`UPDATE user_settings SET ${key} = $1 WHERE id = 1 RETURNING *`, [good]]]);
      }
    }
  });

  it("keep-alive hours are whole hours 0-23 (not silently turned into 0); the zone must exist", async () => {
    for (const key of ["keep_alive_start", "keep_alive_end"]) {
      for (const bad of [24, -1, 7.5, "6abc", "", null, true, [6]]) {
        const calls = [];
        const r = await patch(app(calls), { [key]: bad }).expect(400);
        assert.equal(r.body.error, key + " must be an hour 0-23");
        assert.deepEqual(calls, []);
      }
      for (const [given, stored] of [[0, 0], [23, 23], ["6", 6]]) {
        const calls = [];
        await patch(app(calls), { [key]: given }).expect(200);
        assert.deepEqual(calls[0].params, [stored]);
      }
    }
    for (const bad of ["Mars/Olympus", "", null, 5, "x".repeat(80)]) {
      const calls = [];
      const r = await patch(app(calls), { keep_alive_timezone: bad }).expect(400);
      assert.equal(r.body.error, "keep_alive_timezone must be a valid IANA time zone");
      assert.deepEqual(calls, []);
    }
    const calls = [];
    await patch(app(calls), { keep_alive_enabled: true, keep_alive_start: 6, keep_alive_end: 0, keep_alive_timezone: "America/Los_Angeles" }).expect(200);
    assert.deepEqual(calls[0].params, [true, 6, 0, "America/Los_Angeles"]);
  });

  it("session_timeout_minutes is an integer 1-1440 and default_horizon one of the three", async () => {
    for (const bad of [0, 1441, 15.5, "abc", "", null, true]) {
      const calls = [];
      const r = await patch(app(calls), { session_timeout_minutes: bad }).expect(400);
      assert.equal(r.body.error, "session_timeout_minutes must be an integer 1-1440");
      assert.deepEqual(calls, []);
    }
    const session = {};
    const calls = [];
    await patch(app(calls, session), { session_timeout_minutes: "30", default_horizon: "medium" }).expect(200);
    assert.deepEqual(calls[0].params, [30, "medium"]);
    assert.equal(session.timeoutMinutes, 30, "the live session gets the number, not the string");
    for (const bad of ["forever", "", null, 3]) {
      const c = [];
      const r = await patch(app(c), { default_horizon: bad }).expect(400);
      assert.equal(r.body.error, "default_horizon must be one of short, medium, long");
      assert.deepEqual(c, []);
    }
  });

  it("dashboard_layout must be { widgets: [ids], hidden: [ids] } or null", async () => {
    const msg = "dashboard_layout must be { widgets: [ids], hidden: [ids] } (or null for the default).";
    const bads = [
      ["search", "cards"], "default", 7, {}, { widgets: "search" }, { widgets: ["search"], hidden: "cards" },
      { widgets: ["<script>"] }, { widgets: [1, 2] }, { widgets: ["search"], hidden: [{}] },
      { widgets: Array.from({ length: 41 }, (_, i) => "w" + i) },
    ];
    for (const bad of bads) {
      const calls = [];
      const r = await patch(app(calls), { dashboard_layout: bad }).expect(400);
      assert.equal(r.body.error, msg, JSON.stringify(bad));
      assert.deepEqual(calls, []);
    }
    // What the dashboard saves, and a stored layout from before a widget was retired.
    for (const good of [
      { widgets: ["search", "cards", "upcoming_emails", "mini_cal"], hidden: ["perfin"] },
      { widgets: ["tree", "ai_query", "tasks"], hidden: [] },
      { widgets: [] },
      null,
    ]) {
      const calls = [];
      await patch(app(calls), { dashboard_layout: good }).expect(200);
      assert.deepEqual(calls[0].params, [JSON.stringify(good)]);
    }
  });

  it("GET /api/settings answers 500 on a failed read (never a page of defaults)", async () => {
    const a = express();
    a.use(require("../routes/settings")({ pool: { query: async () => { throw new Error("db down"); } }, config }));
    const ce = console.error; console.error = () => {};
    try {
      const r = await supertest(a).get("/api/settings").expect(500);
      assert.equal(r.body.theme, undefined);
      assert.ok(r.body.error);
    } finally { console.error = ce; }
  });
});

// ---------------------------------------------------------------------------
// A fake DOM just big enough for the page scripts' functions.
function fakeDom() {
  const els = {};
  const el = (id) => (els[id] = els[id] || {
    id, value: "", checked: false, textContent: "", innerHTML: "", className: "", disabled: false,
    style: {}, dataset: {}, addEventListener() {}, appendChild() {}, querySelectorAll: () => [],
  });
  return { els, document: { getElementById: el, querySelectorAll: () => [], documentElement: { setAttribute() {}, removeAttribute() {} } } };
}

describe("FO-6 — the Settings page never saves over settings it couldn't load", () => {
  const script = require("../pages/settings-script");
  const cut = (from, to) => {
    const a = script.indexOf(from); const b = script.indexOf(to, a);
    assert.ok(a >= 0 && b > a, "markers not found: " + from);
    return script.slice(a, b);
  };
  // load / settingsReady / saveSettings, saveSlack, saveVault and saveKeepAlive
  // as emitted, over a fake DOM and a fetch that records what is sent.
  function page(getSettings) {
    const { els, document } = fakeDom();
    const sent = [];
    const ctx = {
      document,
      window: { matchMedia: () => ({ matches: false }) },
      localStorage: { setItem() {}, getItem: () => null },
      setTimeout: () => 0,
      fetch: async (url, opts) => {
        if (opts && opts.method === "PATCH") { sent.push({ url, body: JSON.parse(opts.body) }); return { ok: true, json: async () => ({}) }; }
        if (url === "/api/settings") return getSettings();
        return { ok: true, json: async () => ({}) };
      },
      loadAiUsage() {}, updateKAEstimate() {}, loadVaultStatus() {},
      parseInt, JSON,
    };
    vm.createContext(ctx);
    vm.runInContext(
      cut("function applyTheme", "async function exportData") +
      cut("async function saveSlack", "async function logout") +
      cut("async function saveVault", "// Keep-alive hour selectors") +
      cut("async function saveKeepAlive", "\nload();\nloadAutomations();") +
      "\nthis.api = { load, saveSettings, saveSlack, saveVault, saveKeepAlive };", ctx);
    return { els, sent, api: ctx.api };
  }
  const MSG = "Your settings couldn't be loaded — reload the page before changing anything.";

  for (const [name, getSettings] of [
    ["a 500", async () => ({ ok: false, status: 500, json: async () => ({ error: "An internal error occurred." }) })],
    ["a network failure", async () => { throw new TypeError("Failed to fetch"); }],
  ]) {
    it(name + " on load: the page says so and none of the four forms saves", async () => {
      const p = page(getSettings);
      await p.api.load();
      assert.equal(p.els.status.textContent, MSG);
      assert.equal(p.els.status.className, "status-msg error");
      // The forms hold defaults ('' / unchecked) — these saves used to send them:
      // a 15-minute timeout, the Slack URL cleared, the vault switched off, keep-alive off.
      await p.api.saveSettings(); await p.api.saveSlack(); await p.api.saveVault(); await p.api.saveKeepAlive();
      assert.deepEqual(p.sent, []);
    });
  }

  it("a successful load fills the forms, and each save sends what they hold", async () => {
    const stored = { theme: "light", session_timeout_minutes: 45, default_horizon: "long", perfin_url: "https://perfin.example",
      slack_webhook_url: "https://hooks.slack.com/x", keep_alive_enabled: true, keep_alive_start: 7, keep_alive_end: 22, keep_alive_timezone: "America/Chicago",
      vault_enabled: true, vault_repo: "me/vault", vault_branch: "trunk" };
    const p = page(async () => ({ ok: true, json: async () => stored }));
    await p.api.load();
    assert.equal(p.els.status, undefined, "no message on a clean load");
    await p.api.saveSettings(); await p.api.saveSlack(); await p.api.saveVault(); await p.api.saveKeepAlive();
    assert.deepEqual(p.sent.map((s) => s.body), [
      { theme: "light", session_timeout_minutes: 45, default_horizon: "long", perfin_url: "https://perfin.example" },
      { slack_webhook_url: "https://hooks.slack.com/x" },
      { vault_enabled: true, vault_repo: "me/vault", vault_branch: "trunk" },
      { keep_alive_enabled: true, keep_alive_start: 7, keep_alive_end: 22, keep_alive_timezone: "America/Chicago" },
    ]);
  });
});

describe("FO-6 — the dashboard never saves a layout over one it couldn't load", () => {
  const script = require("../pages/dashboard-script");
  function dash(getSettings) {
    const { document } = fakeDom();
    const sent = []; const toasts = [];
    const ctx = {
      document, Array, JSON,
      fetch: async () => getSettings(),
      tryFetch: async (url, opts) => { sent.push(JSON.parse(opts.body)); return { ok: true }; },
      writeOk: async (res) => !!(res && res.ok),
      showUndo: (...a) => toasts.push(a),
    };
    vm.createContext(ctx);
    const a = script.indexOf("var widgetNames"); const b = script.indexOf("function wdragStart");
    assert.ok(a >= 0 && b > a);
    vm.runInContext(script.slice(a, b) + "\nthis.api = { loadLayout, toggleWidget, resetLayout, layout: function(){ return dashLayout; } };", ctx);
    return { sent, toasts, api: ctx.api };
  }
  const flush = () => new Promise((r) => setImmediate(r));

  it("the layout read fails: hiding a widget isn't saved (and says so); Reset still is", async () => {
    for (const getSettings of [async () => ({ ok: false, status: 500, json: async () => ({ error: "x" }) }), async () => { throw new TypeError("Failed to fetch"); }]) {
      const d = dash(getSettings);
      await d.api.loadLayout();
      d.api.toggleWidget("perfin"); await flush();
      // It used to PATCH the default layout (+ this change) over the stored one.
      assert.deepEqual(d.sent, []);
      assert.deepEqual(d.toasts, [["Your layout couldn't be loaded, so this change isn't saved — reload the page.", "", "", "info"]]);
      d.api.resetLayout(); await flush();
      assert.equal(d.sent.length, 1, "Reset replaces the layout on purpose");
      assert.deepEqual(d.sent[0].dashboard_layout.hidden, []);
      d.api.toggleWidget("perfin"); await flush();
      assert.equal(d.sent.length, 2, "after the reset was saved, the page's layout IS the stored one");
    }
  });

  it("the read succeeds: the stored layout is used and a change is saved whole", async () => {
    const d = dash(async () => ({ ok: true, json: async () => ({ dashboard_layout: { widgets: ["tasks", "cards", "tree"], hidden: ["cards"] } }) }));
    await d.api.loadLayout();
    assert.deepEqual(JSON.parse(JSON.stringify(d.api.layout())), { widgets: ["tasks", "cards"], hidden: ["cards"] });
    d.api.toggleWidget("tasks"); await flush();
    assert.deepEqual(d.sent, [{ dashboard_layout: { widgets: ["tasks", "cards"], hidden: ["cards", "tasks"] } }]);
    assert.deepEqual(d.toasts, []);
    // No stored layout yet (a fresh install) is a successful read too.
    const fresh = dash(async () => ({ ok: true, json: async () => ({ dashboard_layout: null }) }));
    await fresh.api.loadLayout();
    fresh.api.toggleWidget("perfin"); await flush();
    assert.equal(fresh.sent.length, 1);
  });
});

// ---------------------------------------------------------------------------
describe("FO-7 — the rent line and the tasks of every unpaid month", () => {
  const CFG = { enabled: true, payee_name: "Sam", rent_due_day: 1, reminder_lead_days: 5 };
  // October and November both unpaid (October is the overdue one the line names).
  const perfin = (periods) => {
    const pool = { sqls: [] };
    pool.query = async (sql) => {
      pool.sqls.push(sql);
      if (/housing_config/.test(sql)) return { rows: [{ housing_config: CFG }] };
      return { rows: [{ balance: "3600.00", n: 2, oldest_period: "2026-10", oldest_due_day: 1, ...(periods === undefined ? {} : { periods }) }] };
    };
    return pool;
  };
  // Per-sistant's todos, answering openLinkedItems the way Postgres would.
  function todos(rows) {
    const pool = { calls: [] };
    pool.query = async (sql, params) => {
      pool.calls.push([sql, params]);
      return { rows: rows
        .filter((t) => params[0].includes(t.source_key) && !t.completed)
        .filter((t) => t.due_date && t.due_date <= params[1])
        .map((t) => ({ source_key: t.source_key })) };
    };
    return pool;
  }
  const oct = { source_key: "perfin:housing:2026-10", due_date: "2026-10-01" };
  const nov = { source_key: "perfin:housing:2026-11", due_date: "2026-11-01" };

  it("October's task ticked off by hand, November's showing: the line steps aside", async () => {
    const ps = todos([{ ...oct, completed: true }, nov]);
    // It used to show: only October's task (the line's own item) was asked about.
    assert.equal(await housingDueUnlessTask(perfin(["2026-10", "2026-11"]), ps, "2026-11-03"), null);
    assert.deepEqual(ps.calls[0][1], [["perfin:housing:2026-10", "perfin:housing:2026-11"], "2026-11-03"]);
  });

  it("neither unpaid month has a showing task: the line shows, under the oldest month's item", async () => {
    const shown = await housingDueUnlessTask(perfin(["2026-10", "2026-11"]), todos([{ ...oct, completed: true }, { ...nov, completed: true }]), "2026-11-03");
    assert.deepEqual([shown.status, shown.item], ["overdue", "housing:2026-10"]);
    assert.equal(shown.periods, undefined, "the unpaid months are not part of the line");
  });

  it("a showing task for a month that ISN'T owed never hides it (E3e)", async () => {
    const dec = { source_key: "perfin:housing:2026-12", due_date: "2026-11-02" };
    const ps = todos([dec]);
    const shown = await housingDueUnlessTask(perfin(["2026-10", "2026-11"]), ps, "2026-11-03");
    assert.equal(shown.item, "housing:2026-10");
    assert.ok(!ps.calls[0][1][0].includes("perfin:housing:2026-12"));
  });

  it("a read with no list of months (or a malformed one): the line's own item only, as before", async () => {
    for (const periods of [undefined, null, "2026-10,2026-11", ["garbage", 7, null]]) {
      const ps = todos([nov]);
      const shown = await housingDueUnlessTask(perfin(periods), ps, "2026-11-03");
      assert.equal(shown.item, "housing:2026-10", JSON.stringify(periods));
      assert.deepEqual(ps.calls[0][1][0], ["perfin:housing:2026-10"]);
    }
  });

  it("the read asks for every unpaid month in the same query; housingDue's own shape is unchanged", async () => {
    const pf = perfin(["2026-10", "2026-11"]);
    const h = await housingDue(pf, "2026-11-03");
    assert.match(pf.sqls[1], /ARRAY_AGG\(DISTINCT period\) AS periods\s+FROM payee_obligations WHERE status='unpaid' AND payee = \$1/);
    assert.deepEqual(Object.keys(h).sort(), ["balance", "days_until_due", "due_date", "n", "payee", "status"]);
    assert.equal(await housingDue(null, "2026-11-03"), null);
    assert.equal(await housingDue({ query: async () => { throw new Error("x"); } }, "2026-11-03"), null);
  });

  it("housingTaskOpen takes one item or a list", async () => {
    assert.equal(await housingTaskOpen(todos([nov]), "housing:2026-11", "2026-11-03"), true);
    assert.equal(await housingTaskOpen(todos([nov]), ["housing:2026-10", "housing:2026-11"], "2026-11-03"), true);
    assert.equal(await housingTaskOpen(todos([nov]), ["housing:2026-10"], "2026-11-03"), false);
    assert.equal(await housingTaskOpen(todos([nov]), [], "2026-11-03"), false);
    assert.equal(await housingTaskOpen(null, ["housing:2026-11"], "2026-11-03"), false);
  });
});
