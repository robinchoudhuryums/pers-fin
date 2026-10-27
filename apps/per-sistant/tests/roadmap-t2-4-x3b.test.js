// ============================================================================
// Roadmap T2.4 X3b — unified search: the shared renderer, the /search page, the links
// ============================================================================
// renderSearchResults run in a vm from the EMITTED client bundle (each
// Per-sistant type linked through BASE_PATH, the done label, the dashboard's
// inline actions only when asked and never on a Perfin row, Perfin rows through
// linkedAppHref — a javascript: / protocol-relative url or no usable base as
// plain text, an http(s) base in a new tab — escaping, an unknown type left
// out, empty / non-array → "No results"); the /search page rendered under the
// shell and its script run in a vm (?q= prefilled + searched, focus on load,
// the result count, a refused query's message, a short query, the URL
// following the query, "/" focusing the box, a slower older search never
// overwriting a newer one); the Search nav entry + route; Perfin's nav link
// to /per-sistant/search only under the shell; the dashboard widget on the
// shared renderer. The browser half is e2e/pages.spec.js.
// ============================================================================
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const JS = require("../views/js");
const ESC = "function esc(s){return String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');}";
function rendererSource() {
  const a = JS.indexOf("function escAttr(");
  const h = JS.indexOf("function linkedAppHref(");
  const hEnd = JS.indexOf("\n}\n", h) + 3;
  const r = JS.indexOf("var SEARCH_PAGES=");
  const rEnd = JS.indexOf("\n}\n", JS.indexOf("function renderSearchResults(")) + 3;
  assert.ok(a >= 0 && h > 0 && r > 0 && rEnd > r);
  return ESC + JS.slice(a, JS.indexOf("\n", a) + 1) + JS.slice(h, hEnd) + JS.slice(r, rEnd);
}
function loadRenderer(win) {
  const ctx = { window: win };
  vm.runInNewContext(rendererSource() + ";this.render=renderSearchResults;", ctx);
  return ctx.render;
}

describe("renderSearchResults (emitted bundle)", () => {
  const win = { BASE_PATH: "/per-sistant", LINKED_APP_BASES: { perfin: "/perfin" } };

  it("links each Per-sistant type through BASE_PATH, escaped, with the done label", () => {
    const render = loadRenderer(win);
    const html = render([
      { id: 1, type: "todo", title: "Call <b>bank</b>", description: "a & b", completed: true },
      { id: 2, type: "email", title: "Hi", status: "draft" },
      { id: 3, type: "note", title: "N" },
      { id: 4, type: "contact", title: "Sam", description: "sam@example.com" },
    ]);
    for (const p of ["/per-sistant/todos", "/per-sistant/emails", "/per-sistant/notes", "/per-sistant/contacts"]) {
      assert.ok(html.includes(`<a href="${p}" class="result-item"`), p);
    }
    assert.ok(html.includes('<div class="result-type">todo (done)</div>'));
    assert.ok(html.includes("Call &lt;b&gt;bank&lt;/b&gt;") && !html.includes("<b>"));
    assert.ok(html.includes("a &amp; b"));
    assert.ok(!html.includes("data-action"), "no actions unless asked");
  });

  it("the dashboard's inline actions only when asked, on a real id, never on a Perfin row", () => {
    const render = loadRenderer(win);
    const rows = [
      { id: 7, type: "todo", title: "T", completed: false, recurring: true },
      { id: 8, type: "email", title: "E", status: "scheduled" },
      { id: 9, type: "note", title: "N", pinned: true },
      { id: "x", type: "todo", title: "bad id" },
      { group: "finance", app: "perfin", type: "goal", id: 5, title: "House", url: "/goals" },
    ];
    const html = render(rows, { actions: true });
    assert.ok(html.includes('data-action="search-complete" data-id="7" data-recurring="true"'));
    assert.ok(html.includes('data-action="search-send" data-id="8"'));
    assert.ok(html.includes('data-action="search-pin" data-id="9" data-pinned="true" class="btn">Unpin</button>'));
    assert.equal(html.split("data-action=").length - 1, 3, "no action for a bad id or the Perfin row");
  });

  it("a Perfin row links through linkedAppHref; an unsafe url or base is plain text; an http(s) base opens a new tab", () => {
    const row = { group: "finance", app: "perfin", type: "transaction", id: "t1", title: "Blue <i>Bottle</i>", description: "$6.00", url: "/transactions?q=Blue&month=2026-10" };
    let html = loadRenderer(win)([row]);
    assert.ok(html.startsWith('<a href="/perfin/transactions?q=Blue&amp;month=2026-10" class="result-item"'));
    assert.ok(html.includes('<div class="result-type">transaction · Perfin</div>'));
    assert.ok(html.includes("Blue &lt;i&gt;Bottle&lt;/i&gt;"));
    for (const url of ["javascript:alert(1)", "//evil.example/x", "goals", null]) {
      html = loadRenderer(win)([{ ...row, url }]);
      assert.match(html, /^<div class="result-item">/, String(url));
      assert.ok(!html.includes("href"), String(url));
    }
    assert.match(loadRenderer({ ...win, LINKED_APP_BASES: { perfin: "javascript:alert(1)//" } })([row]), /^<div class="result-item">/);
    html = loadRenderer({ ...win, LINKED_APP_BASES: { perfin: "https://perfin.example.com/" } })([row]);
    assert.ok(html.includes('href="https://perfin.example.com/transactions?q=Blue&amp;month=2026-10" target="_blank" rel="noopener"'));
  });

  it("an unknown type is left out; empty, non-array or all-unknown → No results", () => {
    const render = loadRenderer(win);
    const none = '<div class="empty-msg">No results</div>';
    assert.equal(render([]), none);
    assert.equal(render(null), none);
    assert.equal(render({ error: "x" }), none);
    assert.equal(render([{ type: "script", title: "<x>" }, null, 5]), none);
    assert.ok(!render([{ id: 1, type: "todo", title: "T" }, { type: "weird" }]).includes("weird"));
  });

  it("standalone (no BASE_PATH) links root-relative pages", () => {
    assert.ok(loadRenderer({})([{ id: 1, type: "note", title: "N" }]).startsWith('<a href="/notes"'));
  });
});

describe("the /search page", () => {
  const views = require("../views");
  function renderPage(embedded = true) {
    let html;
    const res = { locals: {}, send: (h) => { html = h; } };
    views.basePathMiddleware({ baseUrl: embedded ? "/per-sistant" : "", app: { get: () => embedded } }, res, () => {
      require("../pages/search")()({ query: {} }, res);
    });
    return html;
  }

  it("renders with a labelled box, the results area and Search active in the nav", () => {
    const html = renderPage();
    assert.ok(html.includes('<input type="search" id="search-page-input" aria-label="Search everything"'));
    assert.ok(html.includes('id="search-page-results"'));
    assert.match(html, /<a href="\/per-sistant\/search" class="active">/);
    assert.match(html, /<script nonce="[^"]+">\nvar searchTimer/, "the page script carries the nonce");
  });

  // The page script in a vm with a fake DOM.
  function runPage({ search = "?q=blue", replies = [] } = {}) {
    const html = renderPage();
    const start = html.indexOf("var searchTimer");
    const script = html.slice(start, html.indexOf("</script>", start));
    const els = {
      "search-page-input": { value: "", focused: 0, selected: 0, handlers: {}, addEventListener(ev, fn) { this.handlers[ev] = fn; }, focus() { this.focused++; }, select() { this.selected++; } },
      "search-page-results": { innerHTML: "" },
      "search-page-status": { textContent: "" },
    };
    const docHandlers = {};
    const calls = [], urls = [];
    let timer = null;
    const ctx = {
      window: { BASE_PATH: "/per-sistant", LINKED_APP_BASES: { perfin: "/perfin" } },
      document: { getElementById: (id) => els[id], addEventListener: (ev, fn) => { docHandlers[ev] = fn; } },
      location: { href: "https://app.example/per-sistant/search" + search, search },
      URL, URLSearchParams, encodeURIComponent,
      history: { replaceState: (_s, _t, u) => urls.push(u) },
      setTimeout: (fn) => { timer = fn; return 1; }, clearTimeout() {},
      tryFetch: async (url) => {
        calls.push(url);
        const r = replies.shift();
        if (r === null) return null;
        return { ok: (r.status || 200) < 300, status: r.status || 200, json: async () => r.body };
      },
    };
    vm.runInNewContext(rendererSource() + script, ctx);
    return { ctx, els, docHandlers, calls, urls, fireTimer: () => timer && timer() };
  }
  const tick = () => new Promise((r) => setImmediate(r));

  it("?q= is prefilled and searched; the box is focused; results and a count show", async () => {
    const p = runPage({ replies: [{ body: [{ id: 1, type: "todo", title: "Blue task" }, { group: "finance", app: "perfin", type: "goal", id: 2, title: "Blue fund", url: "/goals" }] }] });
    await tick(); await tick();
    assert.equal(p.els["search-page-input"].value, "blue");
    assert.equal(p.els["search-page-input"].focused, 1);
    assert.deepEqual(p.calls, ["/api/search?q=blue"]);
    assert.equal(p.els["search-page-status"].textContent, "2 results");
    assert.ok(p.els["search-page-results"].innerHTML.includes('href="/perfin/goals"'));
    assert.ok(!p.els["search-page-results"].innerHTML.includes("data-action"), "no inline actions on the page");
  });

  it("typing searches after a pause, keeps the URL in step, and a short query asks for more", async () => {
    const p = runPage({ search: "", replies: [{ body: [] }] });
    assert.deepEqual(p.calls, [], "nothing searched without ?q=");
    const input = p.els["search-page-input"];
    input.handlers.input.call({ value: "rent" });
    p.fireTimer(); await tick(); await tick();
    assert.deepEqual(p.calls, ["/api/search?q=rent"]);
    assert.equal(p.urls.pop(), "/per-sistant/search?q=rent");
    assert.equal(p.els["search-page-results"].innerHTML, '<div class="empty-msg">No results</div>');
    input.handlers.input.call({ value: "r" });
    p.fireTimer(); await tick();
    assert.equal(p.els["search-page-status"].textContent, "Type at least 2 characters.");
    assert.equal(p.calls.length, 1);
  });

  it("a refused query shows the server's message; a network failure says so", async () => {
    let p = runPage({ replies: [{ status: 400, body: { error: "Search text must be 200 characters or fewer." } }] });
    await tick(); await tick();
    assert.equal(p.els["search-page-status"].textContent, "Search text must be 200 characters or fewer.");
    assert.equal(p.els["search-page-results"].innerHTML, "");
    p = runPage({ replies: [null] });
    await tick(); await tick();
    assert.equal(p.els["search-page-status"].textContent, "Search failed — check your connection.");
  });

  it('"/" focuses the box unless typing in a field', () => {
    const p = runPage({ search: "" });
    let prevented = 0;
    p.docHandlers.keydown({ key: "/", target: { tagName: "BODY" }, preventDefault: () => prevented++ });
    assert.equal(p.els["search-page-input"].focused, 2);
    assert.equal(prevented, 1);
    p.docHandlers.keydown({ key: "/", target: { tagName: "INPUT" }, preventDefault: () => prevented++ });
    assert.equal(prevented, 1);
  });

  it("a slower older search never overwrites a newer one", async () => {
    const p = runPage({ search: "" });
    let releaseOld;
    p.ctx.tryFetch = (url) => (url.includes("old")
      ? new Promise((r) => { releaseOld = () => r({ ok: true, json: async () => [{ id: 1, type: "note", title: "OLD" }] }); })
      : Promise.resolve({ ok: true, json: async () => [{ id: 2, type: "note", title: "NEW" }] }));
    const input = p.els["search-page-input"];
    input.handlers.input.call({ value: "old" }); p.fireTimer();
    input.handlers.input.call({ value: "new" }); p.fireTimer();
    await tick(); await tick();
    releaseOld(); await tick(); await tick();
    assert.ok(p.els["search-page-results"].innerHTML.includes("NEW"));
    assert.ok(!p.els["search-page-results"].innerHTML.includes("OLD"));
  });
});

describe("the links and the wiring", () => {
  it("Per-sistant: a Search nav entry and the /search route", () => {
    const views = fs.readFileSync(path.join(__dirname, "../views.js"), "utf8");
    assert.match(views, /\{ href: "\/search", +label: "Search", +id: "search" \}/);
    assert.match(views, /case 'search': return `<svg/);
    const server = fs.readFileSync(path.join(__dirname, "../server.js"), "utf8");
    assert.ok(server.includes('app.get("/search", require("./pages/search")());'));
  });

  it("Perfin's nav links to /per-sistant/search only under the shell, labelled", () => {
    const ejs = require("ejs");
    const tpl = fs.readFileSync(path.join(__dirname, "../../../teller/views/partials/nav.ejs"), "utf8");
    const embedded = ejs.render(tpl, { basePath: "/perfin", embedded: true, activePage: "dashboard", nonce: "n" });
    assert.match(embedded, /<a href="\/per-sistant\/search" class="nav-search-link" id="nav-search-link" title="Search Per-sistant and Perfin" aria-label="Search everything"/);
    const standalone = ejs.render(tpl, { basePath: "", embedded: false, activePage: "dashboard", nonce: "n" });
    assert.ok(!standalone.includes("nav-search-link"), "a standalone Perfin has no Per-sistant to search");
  });

  it("the dashboard widget uses the shared renderer with its inline actions; the bundles parse", () => {
    const dash = require("../pages/dashboard-script");
    new Function(dash);
    new Function(JS);
    assert.ok(dash.includes("renderSearchResults(results, { actions: true })"));
    assert.ok(!dash.includes("data-action=\"search-complete\""), "the row markup lives in views/js.js only");
  });
});
