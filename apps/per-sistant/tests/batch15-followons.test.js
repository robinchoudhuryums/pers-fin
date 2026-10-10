// ============================================================================
// Batch 15 follow-ons — the production bugs Batch 15's real-code tests exposed
// ============================================================================
// FO-1  GET /api/calendar 500'd with an open recurring todo: the router read
//       advanceRecurrence off deps, which server.js never passes
// FO-2  Quick Add never detected priority or a date: its regexes lost their
//       backslashes in the template-literal page script
// FO-3  the palette picker never appeared under the shell (/per-sistant/settings)
// FO-4  views/js.js used CSS variables the current theme doesn't define
// FO-5  PATCH /api/settings stored theme and perfin_url unvalidated
// ============================================================================

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const express = require("express");
const supertest = require("supertest");

const config = require("../config");
const helpers = require("../helpers");

const ROOT = path.join(__dirname, "..");
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), "utf8");

function appWith(router) {
  const app = express();
  app.use(express.json());
  app.use(router);
  return app;
}

// ---------------------------------------------------------------------------
describe("FO-1 — router factories only read deps that server.js passes", () => {
  const server = read("server.js");
  const depsLine = server.match(/const deps = \{([^}]*)\};/);
  const passed = new Set(depsLine[1].split(",").map((s) => s.trim().split(":")[0].trim()).filter(Boolean));

  it("server.js passes { pool, config, helpers, views }", () => {
    assert.deepEqual([...passed].sort(), ["config", "helpers", "pool", "views"]);
  });

  it("no routes/*.js factory destructures a key outside that set", () => {
    const offenders = [];
    for (const f of fs.readdirSync(path.join(ROOT, "routes")).filter((f) => f.endsWith(".js"))) {
      const m = read("routes", f).match(/module\.exports\s*=\s*function\s*\w*\s*\(\s*\{([^}]*)\}\s*\)/);
      if (!m) continue;
      for (const name of m[1].split(",").map((s) => s.trim().split(/[:=\s]/)[0]).filter(Boolean)) {
        if (!passed.has(name)) offenders.push(`${f}: ${name}`);
      }
    }
    assert.deepEqual(offenders, []);
  });

  it("GET /api/calendar projects a recurring todo with the server's deps", async () => {
    const due = new Date(2026, 9, 3); // Oct 3, weekly
    const pool = { query: async (sql) => {
      if (/recurring = true/.test(sql)) return { rows: [{ id: 7, title: "Gym", due_date: due, recurrence_rule: "weekly", recurrence_interval: 1, recurrence_anchor_day: null, priority: "medium" }] };
      return { rows: [] };
    } };
    const router = require("../routes/calendar")({ pool, config, helpers, views: {} });
    const r = await supertest(appWith(router)).get("/api/calendar?month=10&year=2026").expect(200);
    const dates = r.body.filter((e) => e.recurring_projection).map((e) => e.event_date);
    assert.ok(dates.length >= 4, `expected weekly projections, got ${dates}`);
  });
});

// ---------------------------------------------------------------------------
// The modules that export one template-literal string of client code: a single
// backslash in their source is consumed by the template, so a regex escape
// (\b \d \s \w \/ \. …) silently changes meaning in the browser.
describe("FO-2 — client template literals keep their regex escapes", () => {
  function stringModules() {
    const out = [];
    for (const dir of ["pages", "views"]) {
      for (const f of fs.readdirSync(path.join(ROOT, dir)).filter((f) => f.endsWith(".js"))) {
        const mod = require(path.join(ROOT, dir, f));
        if (typeof mod === "string") out.push(`${dir}/${f}`);
      }
    }
    return out;
  }

  it("found the client string modules (todos script, shared JS, settings patch)", () => {
    const mods = stringModules();
    for (const m of ["pages/todos-script-2.js", "views/settings-patch.js"]) assert.ok(mods.includes(m), m);
  });

  it("no single-escaped regex class / delimiter in their source", () => {
    const offenders = [];
    for (const m of stringModules()) {
      read(m).split("\n").forEach((line, i) => {
        if (/(^|[^\\])\\[bBdDsSwW\/.?()[\]{}+*]/.test(line)) offenders.push(`${m}:${i + 1}: ${line.trim().slice(0, 80)}`);
      });
    }
    assert.deepEqual(offenders, []);
  });

  it("the emitted Quick Add regexes contain a real \\b", () => {
    const emitted = require("../pages/todos-script-2");
    assert.ok(emitted.includes("/\\burgent\\b/i"));
    assert.ok(!emitted.includes("\b"), "a backspace character reached the bundle");
  });
});

// ---------------------------------------------------------------------------
describe("FO-3 — palette picker runs on /settings under the shell", () => {
  function run(basePath, pathname) {
    const listeners = [];
    const sandbox = {
      window: { BASE_PATH: basePath },
      location: { pathname },
      document: { addEventListener: (ev) => listeners.push(ev) },
      localStorage: { getItem: () => null, setItem() {} },
    };
    vm.runInNewContext(require("../views/settings-patch"), sandbox);
    return listeners.includes("DOMContentLoaded");
  }
  it("injects at /per-sistant/settings and at standalone /settings (trailing slash ok)", () => {
    assert.equal(run("/per-sistant", "/per-sistant/settings"), true);
    assert.equal(run("/per-sistant", "/per-sistant/settings/"), true);
    assert.equal(run("", "/settings"), true);
  });
  it("stays out of every other page", () => {
    assert.equal(run("/per-sistant", "/per-sistant/todos"), false);
    assert.equal(run("", "/"), false);
    assert.equal(run("/per-sistant", "/settings-old"), false);
  });
});

// ---------------------------------------------------------------------------
describe("FO-4 — shared client JS uses the current theme tokens", () => {
  it("no legacy variable names in views/js.js", () => {
    const js = read("views", "js.js");
    assert.doesNotMatch(js, /var\(--(border|green|surface-2|teal|text|text-muted|warm|yellow)\)/);
  });
  it("undo toast, offline banner and markdown use defined tokens", () => {
    const js = require("../views/js.js");
    const src = typeof js === "string" ? js : Object.values(js).join("\n");
    assert.match(src, /id='undo-toast'[\s\S]*background:var\(--paper-card\);border:1px solid var\(--line\)/);
    assert.match(src, /offBanner\.style\.cssText = '[^']*background:var\(--accent-soft\);color:var\(--ink\)/);
    assert.match(src, /color:var\(--accent\);text-decoration:underline/);
  });
});

// ---------------------------------------------------------------------------
describe("FO-5 — PATCH /api/settings validates theme and perfin_url", () => {
  function app(calls) {
    const pool = { query: async (sql, params) => { calls.push({ sql, params }); return { rows: [{ id: 1 }], rowCount: 1 }; } };
    return appWith(require("../routes/settings")({ pool, config }));
  }
  const updates = (calls) => calls.filter((c) => /^UPDATE user_settings/.test(c.sql));

  it("rejects an unknown theme and accepts dark / light / auto", async () => {
    const calls = [];
    const a = app(calls);
    const bad = await supertest(a).patch("/api/settings").send({ theme: "neon" }).expect(400);
    assert.match(bad.body.error, /theme must be one of dark, light, auto/);
    assert.equal(updates(calls).length, 0);
    for (const t of ["dark", "light", "auto"]) await supertest(a).patch("/api/settings").send({ theme: t }).expect(200);
  });

  it("rejects a non-http(s) or malformed perfin_url", async () => {
    const calls = [];
    const a = app(calls);
    for (const u of ["javascript:alert(1)", "perfin.example.com", "ftp://x.example", "https://user:pw@x.example", 42, "x".repeat(501)]) {
      await supertest(a).patch("/api/settings").send({ perfin_url: u }).expect(400);
    }
    assert.equal(updates(calls).length, 0);
  });

  it("stores a valid URL without its trailing slash, and clears on empty", async () => {
    const calls = [];
    const a = app(calls);
    await supertest(a).patch("/api/settings").send({ perfin_url: " https://perfin.example.com/ " }).expect(200);
    await supertest(a).patch("/api/settings").send({ perfin_url: "" }).expect(200);
    await supertest(a).patch("/api/settings").send({ perfin_url: null }).expect(200);
    const vals = updates(calls).map((c) => c.params[0]);
    assert.deepEqual(vals, ["https://perfin.example.com", null, null]);
  });

  it("the Settings page shows the server's reason on a failed save", () => {
    assert.match(read("pages", "settings-script.js"), /Could not save settings: ' \+ why/);
  });
});
