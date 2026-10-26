// Design pass D1 (Per-sistant half) — `.cycle/plan-design-ux.md`:
// - every sidebar entry has an icon (Job Radar had none);
// - the dashboard's stat tiles are coloured by VALUE, not by tile — a zero is
//   plain text, red only for urgent / overdue work that exists, green only for
//   work done — and sit two to a row on a phone;
// - the legacy disk-attachment copy runs after runMigrations, not when the
//   attachments router is built (on a fresh database it ran before the table
//   existed and logged a server error at every first boot).
"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const ROOT = path.join(__dirname, "..");
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), "utf8");

describe("sidebar icons", () => {
  const views = require("../views");
  it("every nav entry, Job Radar included, renders an svg icon", () => {
    const html = views.navBar("/");
    const entries = html.match(/<a href="[^"]*"[^>]*>\s*<span class="icon">[\s\S]*?<\/span>/g) || [];
    assert.ok(entries.length >= 14, "found " + entries.length + " nav entries");
    for (const e of entries) assert.match(e, /<span class="icon"><svg /, "icon missing in: " + e.slice(0, 80));
    assert.match(html, /href="[^"]*\/jobs"[^>]*>\s*<span class="icon"><svg /);
  });
});

describe("dashboard stat tiles", () => {
  const src = require("../pages/dashboard-script");
  const start = src.indexOf("function statTileClass(kind, value)");
  const end = src.indexOf("async function load()", start);
  assert.ok(start > 0 && end > start, "slice markers");
  const ctx = {};
  vm.runInNewContext(src.slice(start, end) + "\nthis.statTileClass = statTileClass; this.statTiles = statTiles;", ctx);

  it("colours a tile only for a non-zero value that means something", () => {
    for (const k of ["pending", "urgent", "overdue", "completed", "drafts", "scheduled", "sent", "notes"]) {
      assert.equal(ctx.statTileClass(k, 0), "", k + " at 0 is plain");
      assert.equal(ctx.statTileClass(k, null), "", k + " unknown is plain");
    }
    assert.equal(ctx.statTileClass("urgent", 2), "red");
    assert.equal(ctx.statTileClass("overdue", 1), "red");
    assert.equal(ctx.statTileClass("completed", 5), "green");
    for (const k of ["pending", "drafts", "scheduled", "sent", "notes"]) assert.equal(ctx.statTileClass(k, 7), "", k);
  });

  it("renders eight tiles with the value-based classes and numbers", () => {
    const html = ctx.statTiles({
      todos: { pending: 2, urgent: 0, overdue: 3, done: 0 },
      emails: { drafts: 1, scheduled: 0, sent: 4 },
      notes: { total: undefined },
    });
    assert.equal((html.match(/class="card"/g) || []).length, 8);
    assert.match(html, /Urgent<\/div><div class="value">0</);
    assert.match(html, /Overdue<\/div><div class="value red">3</);
    assert.match(html, /Completed<\/div><div class="value">0</);
    assert.match(html, /Pending Tasks<\/div><div class="value">2</);
    assert.match(html, /Notes<\/div><div class="value">0</, "a missing count shows 0, not undefined");
    assert.doesNotMatch(html, /undefined|NaN/);
  });

  it("load() fills the tiles through statTiles", () => {
    assert.match(src, /document\.getElementById\('cards'\)\.innerHTML = statTiles\(stats\);/);
  });

  it("puts two tiles per row on a phone", () => {
    const css = read("views", "css-pages.js");
    const phone = css.slice(css.indexOf("@media (max-width: 480px)"));
    assert.match(phone.slice(0, 600), /\.top-cards \{ grid-template-columns: repeat\(2, 1fr\);/);
    assert.doesNotMatch(phone.slice(0, 600), /\.top-cards \{ grid-template-columns: 1fr; \}/);
  });
});

describe("legacy attachment copy runs after the migrations", () => {
  it("building the attachments router reads nothing from the database", () => {
    const queries = [];
    const pool = { query: async (sql) => { queries.push(sql); return { rows: [] }; } };
    const prev = process.cwd();
    const factory = require("../routes/attachments");
    factory({ pool });
    assert.deepEqual(queries, [], "no query at router construction");
    assert.equal(process.cwd(), prev);
  });

  it("start() copies legacy files only after awaiting runMigrations", () => {
    const server = read("server.js");
    const body = server.slice(server.indexOf("async function start(opts = {})"));
    const migrate = body.indexOf("await runMigrations();");
    const copy = body.indexOf("migrateDiskAttachments(pool)");
    assert.ok(migrate > 0 && copy > migrate, "migrateDiskAttachments after runMigrations");
    // ...and only in the branch that ran them (no database → no copy).
    const elseAt = body.indexOf("} else {", migrate);
    assert.ok(copy < elseAt, "inside the database branch");
    assert.doesNotMatch(read("routes", "attachments.js"), /\n\s+migrateDiskAttachments\(pool\)\.then/);
  });
});
