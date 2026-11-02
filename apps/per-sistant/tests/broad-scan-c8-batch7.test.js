// ============================================================================
// Cycle-8 broad scan Batch 7 — UI correctness, Per-sistant's side
// ============================================================================
// F34: the search widget's Pin / Unpin sends the opposite of the note's state
// (it sent the same value back, so nothing changed). F36: the widget and the
// /search page draw only the newest search, and the widget shows a refused
// query or a network failure instead of "No results". F40: the fetch wrapper's
// session-expiry redirect carries the page as return_to. F48: the Health and
// Analytics heatmaps key their days as calendar days — the grid used
// toISOString() on a local date, a day ahead west of UTC in the evening. The
// Perfin half is the root tests/broad-scan-c8-batch7.test.js.
// ============================================================================
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const { spawnSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
function slice(src, start, end) {
  const i = src.indexOf(start);
  const j = src.indexOf(end, i + start.length);
  assert.ok(i >= 0 && j > i, "slice markers: " + start);
  return src.slice(i, j);
}
const DASH = require("../pages/dashboard-script");
const JS = require("../views/js");
const settle = () => new Promise((r) => setTimeout(r, 0));
const res = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
function render(page) {
  let html = "";
  require("../pages/" + page)()({ query: {}, app: { get: () => false } }, { send: (h) => { html = h; }, set() { return this; }, locals: {} });
  return html;
}

// ---------------------------------------------------------------- F34
describe("F34 — Pin / Unpin from search changes the note", () => {
  function load() {
    const sent = [];
    const ctx = {
      JSON,
      tryFetch: async (url, opts) => { sent.push([url, JSON.parse(opts.body)]); return res(200, {}); },
      writeOk: async (r) => r.ok,
      document: { getElementById: () => ({ style: {}, value: "x" }) },
      load() {},
    };
    vm.runInNewContext(slice(DASH, "async function searchTogglePin(id, pinned)", "// Design pass D1"), ctx);
    return { ctx, sent };
  }
  it("an unpinned note is pinned and a pinned one unpinned", async () => {
    const t = load();
    await t.ctx.searchTogglePin(4, false);
    await t.ctx.searchTogglePin(5, true);
    assert.deepEqual(t.sent, [["/api/notes/4", { pinned: true }], ["/api/notes/5", { pinned: false }]]);
  });
  it("the delegation passes the note's current state from data-pinned", () => {
    assert.match(DASH, /act==='search-pin'\)searchTogglePin\(id,btn\.dataset\.pinned==='true'\)/);
  });
});

// ---------------------------------------------------------------- F36
describe("F36 — only the newest search draws, and a failure says so", () => {
  function loadWidget(fetchFn) {
    const out = { innerHTML: "", style: {} };
    const timers = [];
    const ctx = {
      encodeURIComponent,
      setTimeout: (fn) => { timers.push(fn); return timers.length; }, clearTimeout() {},
      tryFetch: fetchFn,
      esc: (s) => String(s).replace(/</g, "&lt;"),
      renderSearchResults: (r) => "R:" + JSON.stringify(r),
      document: { getElementById: () => out },
    };
    vm.runInNewContext("var searchTimeout = null, searchWidgetSeq = 0;\n" + slice(DASH, "function doSearch(q)", "var dashView"), ctx);
    return { ctx, out, timers };
  }

  it("a slower older reply never overwrites a newer one", async () => {
    const gates = {};
    const t = loadWidget((url) => new Promise((r) => { gates[decodeURIComponent(url.split("q=")[1])] = () => r(res(200, [{ q: url }])); }));
    t.ctx.doSearch("rent"); const first = t.timers.pop()();
    t.ctx.doSearch("rental"); const second = t.timers.pop()();
    await settle();
    gates.rental(); await second;
    gates.rent(); await first;
    assert.match(t.out.innerHTML, /rental/);
    assert.equal(t.out.style.display, "block");
  });

  it("a reply whose body is still being read when a newer search starts is dropped", async () => {
    const bodies = {};
    const t = loadWidget(async (url) => {
      const q = decodeURIComponent(url.split("q=")[1]);
      return { ok: true, json: () => new Promise((r) => { bodies[q] = () => r([q]); }) };
    });
    t.ctx.doSearch("rent"); const first = t.timers.pop()();
    await settle();
    t.ctx.doSearch("rental"); const second = t.timers.pop()();
    await settle();
    bodies.rental(); await second;
    bodies.rent(); await first;
    assert.equal(t.out.innerHTML, 'R:["rental"]');
  });

  it("a refused query and a network failure show their message, not No results", async () => {
    let t = loadWidget(async () => res(400, { error: "Search is limited to 200 characters" }));
    t.ctx.doSearch("ab"); await t.timers.pop()();
    assert.match(t.out.innerHTML, /role="alert">Search is limited to 200 characters</);
    t = loadWidget(async () => null);
    t.ctx.doSearch("ab"); await t.timers.pop()();
    assert.match(t.out.innerHTML, /Search failed — check your connection\./);
    t = loadWidget(async () => res(200, []));
    t.ctx.doSearch("ab"); await t.timers.pop()();
    assert.equal(t.out.innerHTML, "R:[]", "an empty answer is the renderer's No results");
  });

  it("clearing the box drops a search still on its way", async () => {
    let release;
    const t = loadWidget(() => new Promise((r) => { release = () => r(res(200, [1])); }));
    t.ctx.doSearch("rent"); const p = t.timers.pop()();
    t.ctx.doSearch("");
    await settle(); release(); await p;
    assert.equal(t.out.innerHTML, "");
    assert.equal(t.out.style.display, "none");
  });

  it("the /search page re-checks after reading the body", async () => {
    const html = render("search");
    const script = slice(html, "async function runSearch(q)", "function onSearchInput()");
    const els = { "search-page-results": { innerHTML: "" }, "search-page-status": { textContent: "" } };
    const bodies = {};
    const ctx = {
      encodeURIComponent, Array,
      setQueryInUrl() {}, renderSearchResults: (r) => "R:" + JSON.stringify(r),
      document: { getElementById: (id) => els[id] },
      tryFetch: async (url) => {
        const q = decodeURIComponent(url.split("q=")[1]);
        return { ok: true, json: () => new Promise((r) => { bodies[q] = () => r([q]); }) };
      },
    };
    vm.runInNewContext("var searchSeq = 0;\n" + script, ctx);
    const first = ctx.runSearch("rent");
    await settle(); // the first reply arrived; its body is being read
    const second = ctx.runSearch("rental");
    await settle();
    bodies.rental(); await second;
    bodies.rent(); await first;
    assert.equal(els["search-page-results"].innerHTML, 'R:["rental"]');
  });
});

// ---------------------------------------------------------------- F40
describe("F40 — an expired session returns to the same page after login", () => {
  function run(pathname, search) {
    const win = { location: { pathname, search, href: "" }, BASE_PATH: "/per-sistant" };
    win.fetch = async () => ({ status: 401, redirected: false, url: "" });
    const ctx = { window: win, encodeURIComponent };
    vm.runInNewContext(slice(JS, "(function(){\n  var _f=window.fetch;", "function esc(s)"), ctx);
    return win;
  }
  it("the redirect carries the path and query", async () => {
    const win = run("/per-sistant/search", "?q=rent");
    await win.fetch("/api/search?q=rent");
    assert.equal(win.location.href, "/login?return_to=" + encodeURIComponent("/per-sistant/search?q=rent"));
  });
  it("still once, and never from the login page", async () => {
    let win = run("/per-sistant/todos", "");
    await win.fetch("/api/todos");
    win.location.href = "kept";
    await win.fetch("/api/todos");
    assert.equal(win.location.href, "kept");
    win = run("/login", "");
    await win.fetch("/api/todos");
    assert.equal(win.location.href, "");
  });
});

// ---------------------------------------------------------------- F48
describe("F48 — the heatmaps' days are calendar days west of UTC", () => {
  // 22:30 on Oct 26 in Los Angeles is Oct 27 in UTC — the evening case.
  const child = (code) => {
    const r = spawnSync(process.execPath, ["-e", code], {
      env: { ...process.env, TZ: "America/Los_Angeles", APP_TIMEZONE: "America/Los_Angeles" }, encoding: "utf8", cwd: ROOT,
    });
    assert.equal(r.status, 0, r.stderr);
    return JSON.parse(r.stdout.trim().split("\n").pop());
  };
  const prelude = `
    const vm = require("vm");
    const JS = require("./views/js");
    const slice = (s, a, b) => { const i = s.indexOf(a); return s.slice(i, s.indexOf(b, i + a.length)); };
    const helpers = slice(JS, "function parseCalDate(v)", "// Short display") + slice(JS, "function ymdOfLocal(d)", "// ISO timestamp");
    const NOW = Date.parse("2026-10-27T05:30:00Z");
    class FixedDate extends Date { constructor(...a) { if (a.length) super(...a); else super(NOW); } static now() { return NOW; } }
    const out = { innerHTML: "" };
  `;

  it("Health: a habit logged today shows on today's cell", () => {
    const cells = child(prelude + `
      let html = ""; require("./pages/health")()({ query: {}, app: { get: () => false } }, { send: (h) => { html = h; }, set() { return this; }, locals: {} });
      const code = helpers + slice(html, "var APP_TZ", "function scheduleLabel(h)") + slice(html, "async function loadHeatmap()", "\\n}\\n") + "\\n}";
      const ctx = { Date: FixedDate, Intl, Math, parseInt, String, JSON, document: { getElementById: () => out },
        fetch: async () => ({ json: async () => ({ heatmap: [{ day: "2026-10-26T00:00:00.000Z", count: "2" }, { day: "2026-10-25", count: "1" }] }) }) };
      vm.runInNewContext(code, ctx);
      ctx.loadHeatmap().then(() => console.log(JSON.stringify([...out.innerHTML.matchAll(/title="([^"]+)"/g)].slice(-2).map((m) => m[1]))));
    `);
    assert.deepEqual(cells, ["2026-10-25: 1 habits", "2026-10-26: 2 habits"]);
  });

  it("Analytics: the same", () => {
    const cells = child(prelude + `
      let html = ""; require("./pages/analytics")()({ query: {}, app: { get: () => false } }, { send: (h) => { html = h; }, set() { return this; }, locals: {} });
      const body = slice(html, "  // Heatmap (GitHub-style, 90 days)", "document.getElementById('heatmap').innerHTML = heatHtml;");
      const code = helpers + "function draw(data) {" + body + "document.getElementById('heatmap').innerHTML = heatHtml; }";
      const ctx = { Date: FixedDate, Math, parseInt, String, document: { getElementById: () => out } };
      vm.runInNewContext(code, ctx);
      ctx.draw({ heatmap: [{ day: "2026-10-26T00:00:00.000Z", count: "3" }] });
      console.log(JSON.stringify([...out.innerHTML.matchAll(/title="([^"]+)"/g)].slice(-2).map((m) => m[1])));
    `);
    assert.deepEqual(cells, ["2026-10-25: 0 tasks", "2026-10-26: 3 tasks"]);
  });

  it("no heatmap key comes from toISOString any more", () => {
    for (const p of ["health", "analytics"]) {
      const src = fs.readFileSync(path.join(ROOT, "pages", p + ".js"), "utf8");
      assert.doesNotMatch(src, /var key = d\.toISOString\(\)/, p);
      assert.doesNotMatch(src, /new Date\(h\.day\)\.toISOString\(\)/, p);
    }
  });
});
