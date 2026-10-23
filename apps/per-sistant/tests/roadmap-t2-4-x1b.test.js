// ============================================================================
// Roadmap T2.4 X1b — linked tasks: edits win + the source-app chip
// ============================================================================
// syncLinkedTasks refreshing an OPEN task's title / description / due date /
// priority only where the field still equals source_snapshot (an edited title
// kept, the untouched due date refreshed, the snapshot advanced, `updated`
// counted once, a closed / detached task not refreshed) — over the shared fake
// pool; the SQL itself is checked on real Postgres (tests/contract/linked-tasks).
// linkedTaskChip run in a vm from the EMITTED client bundle (escaped title, the
// mount base joined, a javascript: / protocol-relative / backslash url or an
// unknown base rendered as plain text, an http(s) base opened in a new tab);
// pageHead's LINKED_APP_BASES embedded vs standalone; the chip wired into the
// To-Dos list, the edit modal and the dashboard cards; the bundles parse.
// ============================================================================
const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const vm = require("vm");

const helpers = require("../helpers");
const linked = require("../services/linked-tasks");
const { fakePool } = require("./_linked-tasks-fake");

const savedAnnounce = helpers.announceTodoEvent;
beforeEach(() => { helpers.announceTodoEvent = () => {}; });
afterEach(() => { helpers.announceTodoEvent = savedAnnounce; });

const rent = (extra = {}) => ({ key: "perfin:housing:2026-11", title: "Pay rent for Nov", description: "$1,800 to Sam", url: "/housing", due_date: "2026-11-01", priority: "high", ...extra });
const sync = (pool, desired) => linked.syncLinkedTasks(pool, { app: "perfin", kinds: ["housing"], desired });

describe("X1b — edits win (source_snapshot)", () => {
  it("refreshes every field you didn't touch, keeps the one you edited, and advances the snapshot", async () => {
    const pool = fakePool();
    await sync(pool, [rent()]);
    pool.rows[0].title = "Rent — pay from joint";            // your edit
    const r = await sync(pool, [rent({ title: "Pay rent for Nov (overdue)", due_date: "2026-11-03", priority: "urgent", url: "/housing#pending" })]);
    assert.equal(r.updated, 1);
    const row = pool.rows[0];
    assert.equal(row.title, "Rent — pay from joint", "the edited title stays");
    assert.equal(row.due_date, "2026-11-03", "the untouched due date follows the source");
    assert.equal(row.priority, "urgent");
    assert.equal(row.source_url, "/housing#pending");
    assert.deepEqual(row.source_snapshot, { title: "Pay rent for Nov (overdue)", description: "$1,800 to Sam", due_date: "2026-11-03", priority: "urgent" });
    // a later change still leaves your title alone
    await sync(pool, [rent({ title: "Pay rent for Nov (2 days late)", due_date: "2026-11-03", priority: "urgent", url: "/housing#pending" })]);
    assert.equal(pool.rows[0].title, "Rent — pay from joint");
  });

  it("a re-run with nothing new updates nothing", async () => {
    const pool = fakePool();
    await sync(pool, [rent()]);
    assert.equal((await sync(pool, [rent()])).updated, 0);
  });

  it("never refreshes a closed or detached task", async () => {
    const pool = fakePool();
    await sync(pool, [rent()]);
    pool.rows[0].source_detached = true;
    assert.equal((await sync(pool, [rent({ title: "Changed" })])).updated, 0);
    assert.equal(pool.rows[0].title, "Pay rent for Nov");
  });
});

// The chip from the emitted bundle, with esc / escAttr as the bundle defines
// escAttr (esc needs a DOM there, so a string version stands in).
function loadChip(bases) {
  const JS = require("../views/js");
  const a = JS.indexOf("function escAttr(");
  const b = JS.indexOf("function linkedAppHref("); // the chip's link rule (X3a), then the chip
  const end = JS.indexOf("\n}\n", JS.indexOf("function linkedTaskChip(")) + 3;
  assert.ok(a >= 0 && b > a && end > b);
  const ctx = { window: { LINKED_APP_BASES: bases } };
  vm.runInNewContext(
    "function esc(s){return String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');}" +
    JS.slice(a, JS.indexOf("\n", a) + 1) + JS.slice(b, end) + ";this.chip=linkedTaskChip;", ctx);
  return ctx.chip;
}

describe("X1b — the source-app chip (emitted bundle)", () => {
  const task = { source_app: "perfin", source_url: "/housing#pending", title: 'Rent <b>"due"</b>' };

  it("links through the app's mount with an escaped aria-label", () => {
    const html = loadChip({ perfin: "/perfin" })(task);
    assert.match(html, /^<a class="linked-chip" href="\/perfin\/housing#pending" /);
    assert.ok(html.includes('aria-label="Open in Perfin: Rent &lt;b&gt;&quot;due&quot;&lt;/b&gt;"'));
    assert.ok(!html.includes("<b>"));
    assert.ok(!html.includes("target="), "same-origin under the shell");
    assert.ok(html.endsWith(">Perfin</a>"));
    const odd = loadChip({ perfin: "/perfin" })({ ...task, source_url: '/housing?a="b"&c=<d>' });
    assert.ok(odd.includes('href="/perfin/housing?a=&quot;b&quot;&amp;c=&lt;d&gt;"'), "the href is attribute-escaped");
  });

  it("opens a standalone PERFIN_URL in a new tab, trimming its trailing slash", () => {
    const html = loadChip({ perfin: "https://perfin.example.com/" })(task);
    assert.ok(html.includes('href="https://perfin.example.com/housing#pending"'));
    assert.ok(html.includes('target="_blank" rel="noopener"'));
  });

  it("renders plain text for an unsafe url or an unusable base", () => {
    const chip = loadChip({ perfin: "/perfin", evil: "javascript:alert(1)//" });
    for (const url of ["javascript:alert(1)", "//evil.example/x", "/x\\y", "housing", "/", null]) {
      const html = chip({ ...task, source_url: url });
      assert.match(html, /^<span class="linked-chip"/, String(url));
      assert.ok(!html.includes("href"));
    }
    assert.match(loadChip({ perfin: "" })(task), /^<span /, "standalone without PERFIN_URL");
    assert.match(loadChip({ perfin: "//cdn.example" })(task), /^<span /);
    assert.match(chip({ ...task, source_app: "evil" }), /^<span /, "a javascript: base is not a link");
    assert.equal(chip({ title: "plain task" }), "", "an ordinary task gets no chip");
  });
});

describe("X1b — wiring", () => {
  const views = require("../views");
  const render = (embedded) => {
    let head;
    views.basePathMiddleware({ baseUrl: embedded ? "/per-sistant" : "", app: { get: () => embedded } }, { locals: {} }, () => { head = views.pageHead("T"); });
    return head;
  };

  it("pageHead names Perfin's mount: /perfin under the shell, PERFIN_URL (unset here) standalone", () => {
    assert.ok(render(true).includes('window.LINKED_APP_BASES = {"perfin":"/perfin"};'));
    assert.ok(render(false).includes('window.LINKED_APP_BASES = {"perfin":""};'));
  });

  it("the To-Dos list, the edit modal and both dashboard task lists render the chip; the bundles parse", () => {
    const t1 = require("../pages/todos-script-1");
    const dash = require("../pages/dashboard-script");
    for (const src of [require("../views/js"), t1, require("../pages/todos-script-2"), dash]) new Function(src);
    assert.ok(t1.includes("<div class=\"todo-meta\">'+linkedTaskChip(t)+'"));
    assert.ok(t1.includes("showLinkedNote(t);") && t1.includes("showLinkedNote(null);"));
    assert.equal(dash.split("linkedTaskChip(t)").length - 1, 2);
    const page = require("fs").readFileSync(require("path").join(__dirname, "../pages/todos.js"), "utf8");
    assert.ok(page.includes('<div id="f-linked" class="linked-note" hidden></div>'));
  });
});
