// ============================================================================
// Cycle 9 (Nov 2026 broad scan) Batch 9 — the Per-sistant items of F79
// ============================================================================
//  - a failed list load is not an empty list ("No notes yet" on a 500)
//  - a bare label is tied to the control that follows it
//  - Tab stays inside the open modal
// Run in a vm from the EMITTED client scripts. The Perfin half of Batch 9 is
// the root tests/cycle9-b9.test.js.
// ============================================================================

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const vm = require("vm");

const JS = (() => { const j = require("../views/js.js"); return typeof j === "string" ? j : Object.values(j).find((v) => typeof v === "string"); })();

function extractFunction(src, name) {
  let start = src.indexOf("function " + name + "(");
  assert.ok(start >= 0, "function " + name + " present in the emitted source");
  if (src.slice(start - 6, start) === "async ") start -= 6;
  let i = src.indexOf("{", src.indexOf(")", start)), depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}" && --depth === 0) break;
  }
  return src.slice(start, i + 1);
}
function extractCall(src, marker) {
  const start = src.indexOf(marker);
  assert.ok(start >= 0, marker + " present");
  let depth = 0;
  for (let i = src.indexOf("(", start); i < src.length; i++) {
    if (src[i] === "(") depth++;
    else if (src[i] === ")" && --depth === 0) return src.slice(start, i + 1) + ";";
  }
  throw new Error("unbalanced: " + marker);
}
function renderPage(page) {
  let html = "";
  require("../pages/" + page)()({ query: {}, app: { get: () => false } }, { send: (h) => { html = h; }, set() { return this; }, locals: {} });
  return html;
}
const res = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => { if (body instanceof Error) throw body; return body; } });

// ---------------------------------------------------------------------------
describe("F79 — a failed list load is not an empty list", () => {
  function listKit(fetchImpl) {
    const ctx = vm.createContext({ Array, fetch: fetchImpl, esc: (s) => String(s).replace(/</g, "&lt;") });
    vm.runInContext([extractFunction(JS, "tryFetch"), extractFunction(JS, "fetchList"), extractFunction(JS, "loadFailedHtml")].join("\n"), ctx);
    return ctx;
  }
  it("fetchList: the array, or null for a failure of any kind", async () => {
    assert.deepEqual(await listKit(async () => res(200, [{ id: 1 }])).fetchList("/api/notes"), [{ id: 1 }]);
    assert.deepEqual(await listKit(async () => res(200, [])).fetchList("/api/notes"), []);
    assert.equal(await listKit(async () => res(500, { error: "An internal error occurred." })).fetchList("/api/notes"), null);
    assert.equal(await listKit(async () => res(200, { error: "odd" })).fetchList("/api/notes"), null, "a 200 that isn't a list");
    assert.equal(await listKit(async () => res(200, new SyntaxError("bad json"))).fetchList("/api/notes"), null);
    assert.equal(await listKit(async () => { throw new TypeError("Failed to fetch"); }).fetchList("/api/notes"), null);
  });
  it("loadFailedHtml is an alert that names what failed, escaped", () => {
    const html = listKit(async () => null).loadFailedHtml("your <notes>");
    assert.equal(html, '<div class="empty-msg" role="alert">Could not load your &lt;notes> — reload the page to try again.</div>');
  });

  // Each list page's own load(), with the request failing and then empty.
  const PAGES = [
    ["notes", renderPage("notes"), "notes-grid", "your notes", "No notes yet"],
    ["emails", renderPage("emails"), "email-list", "your emails", "No emails found"],
    ["contacts", renderPage("contacts"), "contact-list", "your contacts", "No contacts yet"],
    ["todos", require("../pages/todos-script-1"), "todo-list", "your tasks", "No tasks yet"],
  ];
  for (const [name, src, target, what, emptyTitle] of PAGES) {
    it(name + ": a failed load says so; an empty list still gets its empty state", async () => {
      const run = async (list) => {
        const el = { innerHTML: "" };
        const ctx = vm.createContext({
          document: { getElementById: (id) => (id === target ? el : { innerHTML: "", style: {}, value: "" }) },
          fetchList: async () => list,
          loadFailedHtml: (w) => "FAILED:" + w,
          emptyState: (o) => "EMPTY:" + o.title,
          loadCategories() {},
          curFilter: "", curHorizon: "", curStatus: "", curPriority: "", curCategory: "", emailSelectMode: false, noteSelectMode: false, selectMode: false, colorMap: {},
        });
        vm.runInContext(extractFunction(src, "load"), ctx);
        await ctx.load();
        return el.innerHTML;
      };
      assert.match(await run(null), new RegExp("FAILED:" + what));
      const empty = await run([]);
      assert.doesNotMatch(empty, /FAILED/);
      assert.match(empty, new RegExp(emptyTitle));
    });
  }
});

// ---------------------------------------------------------------------------
describe("F79 — a bare label is tied to its control", () => {
  function kit() {
    const ctx = vm.createContext({ Array });
    vm.runInContext("var _labelSeq=0;\n" + extractFunction(JS, "associateLabels"), ctx);
    return ctx;
  }
  const label = (next, extra = {}) => ({ htmlFor: "", getAttribute: () => null, querySelector: () => null, nextElementSibling: next, ...extra });
  const root = (labels) => ({ querySelectorAll: () => labels });

  it("a label followed by an input / select / textarea gets its for; an id is made up when missing", () => {
    const title = { tagName: "INPUT", type: "text", id: "f-title" };
    const prio = { tagName: "SELECT", id: "" };
    const desc = { tagName: "TEXTAREA", id: "" };
    const labels = [label(title), label(prio), label(desc)];
    const ctx = kit();
    assert.equal(ctx.associateLabels(root(labels)), 3);
    assert.equal(labels[0].htmlFor, "f-title");
    assert.match(prio.id, /^lbl-ctl-\d+$/);
    assert.equal(labels[1].htmlFor, prio.id);
    assert.notEqual(desc.id, prio.id);
    // A second pass changes nothing.
    assert.equal(ctx.associateLabels(root(labels)), 0);
  });
  it("leaves alone a label with a for, one that wraps its control, and one not followed by a control", () => {
    const input = { tagName: "INPUT", type: "text", id: "x" };
    const withFor = label(input, { htmlFor: "other" });
    const wrapping = label(input, { querySelector: () => ({}) });
    const beforeDiv = label({ tagName: "DIV" });
    const beforeHidden = label({ tagName: "INPUT", type: "hidden", id: "h" });
    const last = label(null);
    assert.equal(kit().associateLabels(root([withFor, wrapping, beforeDiv, beforeHidden, last])), 0);
    assert.equal(withFor.htmlFor, "other");
    assert.equal(wrapping.htmlFor, "");
  });
  it("runs for the page at load and for a dialog when it opens", () => {
    assert.match(JS, /function start\(\)\{\s+associateLabels\(document\);/);
    assert.match(JS, /function opened\(overlay\)\{\s+associateLabels\(overlay\);/);
  });
  it("the To-Dos form's labels end up associated (the page's own markup)", () => {
    // Every bare <label> in the task form is directly followed by its control.
    const html = renderPage("todos");
    const bare = html.match(/<label>[^<]+<\/label>\s*<(input|select|textarea)\b/g) || [];
    assert.ok(bare.length >= 5, "found " + bare.length + " label → control pairs");
  });
});

// ---------------------------------------------------------------------------
describe("F79 — Tab stays inside the open modal", () => {
  function page(open = true) {
    const mk = (name) => ({ name, offsetParent: {}, focused: 0, focus() { this.focused++; state.active = this; } });
    const state = { active: null };
    const items = [mk("title"), mk("due"), mk("save")];
    const box = { querySelectorAll: () => items, contains: (el) => items.includes(el) };
    const listeners = [];
    const ctx = vm.createContext({
      Array,
      document: {
        addEventListener: (ev, fn) => { if (ev === "keydown") listeners.push(fn); },
        querySelectorAll: (sel) => (sel === ".modal-overlay.active .modal" ? (open ? [box] : []) : []),
        get activeElement() { return state.active; },
      },
    });
    const at = JS.indexOf("if(key==='Tab'){");
    const start = JS.lastIndexOf("document.addEventListener('keydown'", at);
    vm.runInContext(extractCall(JS.slice(start), "document.addEventListener('keydown'"), ctx);
    const tab = (shiftKey = false) => { const e = { key: "Tab", shiftKey, prevented: false, preventDefault() { this.prevented = true; } }; listeners[0](e); return e; };
    return { state, items, tab };
  }
  it("Tab on the last control wraps to the first; Shift+Tab on the first wraps to the last", () => {
    const p = page();
    p.state.active = p.items[2];
    assert.equal(p.tab().prevented, true);
    assert.equal(p.state.active, p.items[0]);
    assert.equal(p.tab(true).prevented, true);
    assert.equal(p.state.active, p.items[2]);
  });
  it("Tab between controls is left to the browser; focus outside the dialog is pulled in", () => {
    const p = page();
    p.state.active = p.items[1];
    assert.equal(p.tab().prevented, false);
    assert.equal(p.state.active, p.items[1]);
    p.state.active = { name: "page link behind the dialog" };
    assert.equal(p.tab().prevented, true);
    assert.equal(p.state.active, p.items[0]);
  });
  it("with no modal open, Tab is untouched", () => {
    const p = page(false);
    p.state.active = p.items[2];
    assert.equal(p.tab().prevented, false);
    assert.equal(p.state.active, p.items[2]);
  });
});
