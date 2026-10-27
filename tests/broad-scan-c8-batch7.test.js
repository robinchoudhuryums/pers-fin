// ============================================================================
// Cycle-8 broad scan Batch 7 — UI correctness and accessibility, Perfin's side
// ============================================================================
// F35: a Tax checklist reload keeps the notes typed in other rows and the
// focused control. F39: the checklist's reloads are sequenced and its writes
// single-flight; Re-authenticate / Add accounts open Plaid once per tap. F37:
// a failed "Show more" in Deleted transactions leaves the button usable. F38: a
// refused or unreachable settings save puts the switch back; the account-floor
// Save reports a network failure and saves once. F55: Space / Enter inside a
// collapsible heading's select no longer collapses the section. F56: the Undo
// toast waits while hovered or focused, only its buttons close it, and focus
// can move to Undo. F57: the Accounts page's per-row buttons name their
// institution. Per-sistant's half is apps/per-sistant/tests/broad-scan-c8-batch7.
// ============================================================================
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const ROOT = path.join(__dirname, "..");
const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");
function slice(src, start, end) {
  const i = src.indexOf(start);
  const j = src.indexOf(end, i + start.length);
  assert.ok(i >= 0 && j > i, "slice markers: " + start);
  return src.slice(i, j);
}
const shared = read("teller/public/perfin-shared.js");
const esc = (() => {
  const ctx = {};
  vm.runInNewContext(slice(shared, "function esc(s)", "// --- Prefix helper") + "this.esc = esc;", ctx);
  return ctx.esc;
})();
const settle = () => new Promise((r) => setTimeout(r, 0));
const fakeRes = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body });

// ---------------------------------------------------------------- F35 / F39 (Tax page)
// A list element whose innerHTML is parsed into notes inputs and buttons, with
// defaultValue (the markup's value), focus and contains — what the carry-over reads.
function makeList(doc) {
  const list = {
    inputs: [], buttons: [], _html: "",
    get innerHTML() { return this._html; },
    set innerHTML(h) {
      this._html = h;
      this.inputs = [...h.matchAll(/<input class="doc-notes" data-notes-for="(\d+)"[^>]*value="([^"]*)"/g)].map((m) => ({
        attrs: { "data-notes-for": m[1] }, value: m[2], defaultValue: m[2],
        getAttribute(n) { return this.attrs[n] == null ? null : this.attrs[n]; },
        focus() { doc.activeElement = this; },
      }));
      this.buttons = [...h.matchAll(/<button[^>]*data-action="([a-z]+)" data-id="(\d+)"/g)].map((m) => ({
        attrs: { "data-action": m[1], "data-id": m[2] },
        getAttribute(n) { return this.attrs[n] == null ? null : this.attrs[n]; },
        focus() { doc.activeElement = this; },
      }));
      if (doc.activeElement && doc.activeElement !== doc.body) doc.activeElement = doc.body; // the old node is gone
    },
    querySelectorAll(sel) { return sel === "input[data-notes-for]" ? this.inputs : []; },
    querySelector(sel) {
      let m = /^\[data-notes-for="(\d+)"\]$/.exec(sel);
      if (m) return this.inputs.find((i) => i.attrs["data-notes-for"] === m[1]) || null;
      m = /^button\[data-action="([a-z]+)"\]\[data-id="(\d+)"\]$/.exec(sel);
      if (m) return this.buttons.find((b) => b.attrs["data-action"] === m[1] && b.attrs["data-id"] === m[2]) || null;
      return null;
    },
    contains(el) { return this.inputs.includes(el) || this.buttons.includes(el); },
    addEventListener() {},
  };
  return list;
}

const DOCS = (overrides = {}) => ({
  year: 2026, forms: ["W-2", "1099-INT"],
  documents: [
    { id: 1, form: "W-2", issuer: "Acme", expected_by: "2027-01-31", received_at: null, dismissed_at: null, origin: "suggested", notes: "drawer", state: "waiting", ...overrides[1] },
    { id: 2, form: "1099-INT", issuer: "Ally", expected_by: "2027-01-31", received_at: null, dismissed_at: null, origin: "manual", notes: null, state: "waiting", ...overrides[2] },
  ],
});

function loadTax({ api } = {}) {
  const doc = { body: {}, activeElement: null, readyState: "loading", addEventListener() {} };
  doc.activeElement = doc.body;
  const list = makeList(doc);
  const els = { "documents-list": list };
  for (const id of ["tax-page", "tax-year", "tax-pdf-link", "tax-zip-link", "tax-sections", "doc-form", "doc-issuer", "doc-add", "tax-suggest"]) {
    els[id] = { id, innerHTML: "", value: "", href: "", disabled: false, addEventListener() {} };
  }
  doc.getElementById = (id) => els[id] || null;
  doc.querySelector = (sel) => list.querySelector(sel);
  const calls = [], toasts = [];
  const win = {
    document: doc, BASE_PATH: "/perfin",
    location: { search: "", pathname: "/perfin/tax", hash: "" },
    history: { replaceState() {} },
    localTodayStr: () => "2027-02-10", taxSeason: () => ({ year: 2026, season: true }),
    esc, withBase: (u) => "/perfin" + u,
    showMsg: (text, ok) => toasts.push({ text, ok }),
    writeOk: async (res) => res.ok,
    confirm: () => true,
    apiFetch: async (url, opts) => {
      calls.push({ url, method: (opts && opts.method) || "GET" });
      const r = api && (await api(url, opts));
      if (r) return r;
      if (url.startsWith("/api/tax/package")) return fakeRes(200, { year: 2026, overview: {} });
      if (url.startsWith("/api/tax/documents?")) return fakeRes(200, DOCS());
      return fakeRes(200, {});
    },
  };
  win.window = win;
  vm.runInContext(read("teller/public/tax-page.js"), vm.createContext(win));
  return { win, doc, list, els, calls, toasts, page: win.TaxPage };
}

describe("F35 — a Tax checklist reload keeps unsaved notes and focus", () => {
  it("notes typed in another row survive an action on a different row", async () => {
    const t = loadTax();
    await t.page.setYear(2026);
    const ally = t.list.querySelector('[data-notes-for="2"]');
    ally.value = "Ally's form is online"; // typed, not saved
    await t.page.onDocAction({ disabled: false, getAttribute: (n) => ({ "data-id": "1", "data-action": "received", "data-value": "true" })[n] });
    assert.equal(t.list.querySelector('[data-notes-for="2"]').value, "Ally's form is online", "carried over the redraw");
    assert.equal(t.list.querySelector('[data-notes-for="1"]').value, "drawer", "an untouched row shows the stored notes");
  });

  it("the focused notes box and the pressed button keep focus across the redraw", async () => {
    const t = loadTax();
    await t.page.setYear(2026);
    t.list.querySelector('[data-notes-for="1"]').focus();
    await t.page.setYear(2026);
    assert.equal(t.doc.activeElement, t.list.querySelector('[data-notes-for="1"]'));
    t.list.querySelector('button[data-action="dismissed"][data-id="2"]').focus();
    await t.page.setYear(2026);
    assert.equal(t.doc.activeElement, t.list.querySelector('button[data-action="dismissed"][data-id="2"]'));
  });

  it("a button that is gone after the redraw hands focus to its row's notes box", async () => {
    const t = loadTax({ api: (url) => (url.startsWith("/api/tax/documents?") ? fakeRes(200, { ...DOCS(), documents: DOCS().documents.slice(0, 1) }) : null) });
    await t.page.setYear(2026);
    t.list.querySelector('[data-notes-for="1"]').focus();
    t.doc.activeElement = { getAttribute: (n) => ({ "data-action": "delete", "data-id": "1" })[n] };
    t.list.buttons.push(t.doc.activeElement); // contained in the list
    await t.page.setYear(2026);
    assert.equal(t.doc.activeElement, t.list.querySelector('[data-notes-for="1"]'));
  });
});

describe("F39 — the checklist's reloads are sequenced and its writes single-flight", () => {
  it("an older reply for the same year never overwrites a newer one", async () => {
    let n = 0;
    const gates = [];
    const t = loadTax({
      api: (url) => {
        if (!url.startsWith("/api/tax/documents?")) return null;
        const mine = ++n;
        return new Promise((resolve) => gates.push(() => resolve(fakeRes(200, DOCS({ 1: { notes: "reply " + mine } })))));
      },
    });
    const first = t.page.setYear(2026);
    const second = t.page.setYear(2026);
    await settle();
    gates[1](); await second;
    gates[0](); await first;
    assert.match(t.list.innerHTML, /value="reply 2"/);
  });

  it("a double tap on a row's button, Add or Suggest sends one request", async () => {
    let release;
    const t = loadTax({ api: (url, opts) => (opts && opts.method && opts.method !== "GET" ? new Promise((r) => { release = () => r(fakeRes(200, { added: 0 })); }) : null) });
    await t.page.setYear(2026);
    const b = { disabled: false, getAttribute: (n) => ({ "data-id": "2", "data-action": "dismissed", "data-value": "true" })[n] };
    const a = t.page.onDocAction(b), a2 = t.page.onDocAction(b);
    assert.equal(b.disabled, true, "disabled while it runs");
    await settle(); release(); await Promise.all([a, a2]);
    assert.equal(b.disabled, false);
    assert.equal(t.calls.filter((c) => c.method === "PATCH").length, 1);

    t.els["doc-issuer"].value = "Ally";
    const add1 = t.page.addDocument(), add2 = t.page.addDocument();
    await settle(); release(); await Promise.all([add1, add2]);
    assert.equal(t.calls.filter((c) => c.method === "POST" && c.url === "/api/tax/documents").length, 1);

    const s1 = t.page.suggest(), s2 = t.page.suggest();
    await settle(); release(); await Promise.all([s1, s2]);
    assert.equal(t.calls.filter((c) => c.url === "/api/tax/documents/suggest").length, 1);
    // a later tap runs again
    const s3 = t.page.suggest(); await settle(); release(); await s3;
    assert.equal(t.calls.filter((c) => c.url === "/api/tax/documents/suggest").length, 2);
  });
});

// ---------------------------------------------------------------- F37 / F38 (Settings)
describe("F37 — Show more is usable again after a failed load", () => {
  const src = read("teller/views/settings.ejs");
  it("the button is put back whatever the load did", async () => {
    let handler = null;
    const els = { "deleted-transactions-body": { textContent: "", innerHTML: "", addEventListener: (_, fn) => { handler = fn; } }, "deleted-transactions-count": { textContent: "" } };
    const msgs = [];
    let fail = false;
    const ctx = {
      esc, isFinite, Number, String, Date, encodeURIComponent,
      fmt: (n) => "$" + n, fmtDate: (d) => d,
      document: { getElementById: (id) => els[id] || null },
      apiFetch: async () => { if (fail) throw new Error("offline"); return fakeRes(200, { items: [{ transaction_id: "a", legacy: true, restorable: true }], next: "c" }); },
      writeOk: async (r) => r.ok, showMsg: (t, ok) => msgs.push([t, ok]), restoreTransaction: async () => null,
    };
    vm.runInNewContext(slice(src, "var deletedItems = [];", "async function loadOperatorChecks(refresh)"), ctx);
    await ctx.loadDeletedTransactions(false);
    fail = true;
    const more = { disabled: false };
    await handler({ target: { closest: (sel) => (sel === "[data-deleted-more]" ? more : null) } });
    assert.equal(more.disabled, false);
    assert.deepEqual(msgs, [["Couldn't load more deleted transactions — check your connection.", false]]);
  });
});

describe("F38 — a refused settings save puts the control back", () => {
  const src = read("teller/views/settings.ejs");
  function load(api) {
    const msgs = [];
    const ctx = {
      JSON, apiFetch: async (url, opts) => api(url, opts), showMsg: (t, ok) => msgs.push([t, ok]), applyTheme() {},
      document: { getElementById: () => null },
    };
    vm.runInNewContext(slice(src, "async function updateSetting(key, value)", "// Monthly AI budget cap") + slice(src, "async function toggleModule(key, enabled)", "async function logout()"), ctx);
    return { ctx, msgs };
  }

  it("updateSetting resolves true only when the save succeeded", async () => {
    assert.equal(await load(async () => fakeRes(200, {})).ctx.updateSetting("x", 1), true);
    assert.equal(await load(async () => fakeRes(400, { error: "bad" })).ctx.updateSetting("x", 1), false);
    assert.equal(await load(async () => { throw new Error("offline"); }).ctx.updateSetting("x", 1), false);
  });

  it("saveToggle flips a refused switch back and leaves a saved one", async () => {
    const box = { checked: true };
    const t = load(async () => fakeRes(400, { error: "nope" }));
    await t.ctx.saveToggle(box, "cash_alert_enabled");
    assert.equal(box.checked, false);
    assert.deepEqual(t.msgs, [["nope", false]]);
    const box2 = { checked: false };
    await load(async () => fakeRes(200, {})).ctx.saveToggle(box2, "cash_alert_enabled");
    assert.equal(box2.checked, false);
  });

  it("toggleModule reports failure (including an unreadable settings read)", async () => {
    assert.equal(await load(async () => fakeRes(500, {})).ctx.toggleModule("anomaly", true), false);
    const ok = load(async (url, opts) => fakeRes(200, opts ? {} : { insight_modules: {} }));
    assert.equal(await ok.ctx.toggleModule("anomaly", true), true);
  });

  it("every switch goes through saveToggle; modules and widgets revert on failure", () => {
    assert.doesNotMatch(src, /updateSetting\('[a-z_]+', this\.checked\)/);
    assert.ok((src.match(/saveToggle\(this, '[a-z_]+'\)/g) || []).length >= 12);
    assert.match(src, /toggleModule\(box\.dataset\.module, want\)\.then\(function\(ok\) \{ if \(!ok\) box\.checked = !want; \}\);/);
    assert.match(src, /if \(!ok\) box\.checked = !enabled;/);
  });

  it("the floor Save reports a network failure and saves once", async () => {
    const saveHandlers = [];
    const listEl = {
      textContent: "", _html: "",
      set innerHTML(h) { this._html = h; }, get innerHTML() { return this._html; },
      querySelectorAll: () => [{ getAttribute: () => "5", addEventListener: (_, fn) => saveHandlers.push(fn), disabled: false }],
      querySelector: () => ({ value: "250" }),
    };
    const msgs = [];
    let patches = 0, release;
    const ctx = {
      esc, String, parseFloat, isFinite,
      document: { getElementById: () => listEl },
      parseAmountInput: (s) => Number(s),
      writeOk: async (r) => r.ok,
      showMsg: (t, ok) => msgs.push([t, ok]),
      apiFetch: async (url, opts) => {
        if (!opts) return fakeRes(200, [{ id: 5, name: "Checking", type: "depository" }]);
        patches++;
        await new Promise((r) => { release = r; });
        throw new Error("offline");
      },
    };
    vm.runInNewContext(slice(src, "async function loadCashFloors()", "async function loadSettings()"), ctx);
    await ctx.loadCashFloors();
    const btn = { getAttribute: () => "5", disabled: false };
    const run = (fn) => fn.call(btn);
    const h = saveHandlers[0];
    // the handler reads `btn` from its closure — the fake querySelectorAll button
    const a = run(h), b = run(h);
    await settle(); release(); await Promise.all([a, b]);
    assert.equal(patches, 1);
    assert.deepEqual(msgs, [["Couldn't save the floor — check your connection.", false]]);
  });
});

// ---------------------------------------------------------------- F55 (dashboard)
describe("F55 — keys inside a collapsible heading's control don't collapse it", () => {
  const src = read("teller/views/dashboard.ejs");
  it("Space / Enter on the select is left alone; on the heading it toggles", () => {
    const listeners = {};
    const h2 = { attrs: {}, setAttribute(k, v) { this.attrs[k] = v; }, addEventListener(ev, fn) { listeners[ev] = fn; } };
    const classes = new Set();
    const sec = {
      getAttribute: () => "categories", hasAttribute: () => false,
      querySelector: (sel) => (sel.indexOf("h2") !== -1 ? h2 : null),
      classList: { toggle(c, on) { if (on) classes.add(c); else classes.delete(c); }, contains: (c) => classes.has(c) },
    };
    const ctx = {
      window: {}, localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
      document: { querySelectorAll: () => [sec] },
      collapsedFromStore: () => false, scrollActiveTab() {},
    };
    vm.runInNewContext(slice(src, "(function initCollapsibles()", "// Dashboard widget visibility"), ctx);
    const select = {};
    let prevented = 0;
    listeners.keydown({ key: " ", target: select, preventDefault: () => prevented++ });
    listeners.keydown({ key: "Enter", target: select, preventDefault: () => prevented++ });
    assert.equal(classes.has("collapsed"), false);
    assert.equal(prevented, 0, "the select keeps its own Space / Enter");
    listeners.keydown({ key: "Enter", target: h2, preventDefault: () => prevented++ });
    assert.equal(classes.has("collapsed"), true);
    assert.equal(prevented, 1);
  });
});

// ---------------------------------------------------------------- F56 (toast)
describe("F56 — the Undo toast can be reached and doesn't vanish under you", () => {
  function makeDom() {
    const timers = new Map();
    let nextId = 1;
    const doc = { activeElement: null };
    function node(tag) {
      return {
        tagName: tag, children: [], parentNode: null, listeners: {}, attrs: {}, className: "",
        classList: { _s: new Set(), add(c) { this._s.add(c); }, contains(c) { return this._s.has(c); } },
        get lastElementChild() { return this.children[this.children.length - 1] || null; },
        get textContent() { return this._tc != null ? this._tc : this.children.map((c) => c.textContent).join(""); },
        set textContent(v) { this._tc = v; this.children = []; },
        setAttribute(k, v) { this.attrs[k] = v; },
        appendChild(c) { c.parentNode = this; this.children.push(c); return c; },
        removeChild(c) { this.children = this.children.filter((x) => x !== c); c.parentNode = null; },
        contains(c) { return c === this || this.children.some((x) => x === c || (x.contains && x.contains(c))); },
        addEventListener(ev, fn) { (this.listeners[ev] = this.listeners[ev] || []).push(fn); },
        fire(ev, e = {}) { let stopped = false; const evt = { stopPropagation() { stopped = true; }, ...e }; (this.listeners[ev] || []).forEach((f) => f(evt)); if (!stopped && this.parentNode && this.parentNode.fire) this.parentNode.fire(ev, e); },
        focus() { doc.activeElement = this; },
      };
    }
    const body = node("body");
    Object.assign(doc, { body, createElement: node, getElementById: (id) => body.children.find((c) => c.id === id) || null });
    return {
      document: doc, timers,
      setTimeout: (fn, ms) => { const id = nextId++; timers.set(id, ms); return id; },
      clearTimeout: (id) => { timers.delete(id); },
    };
  }
  function load() {
    const dom = makeDom();
    const ctx = { document: dom.document, setTimeout: dom.setTimeout, clearTimeout: dom.clearTimeout };
    vm.runInNewContext(slice(shared, "function removeToast", "// --- Button loading state ---"), ctx);
    return { ...ctx, dom };
  }
  const pending = (ui) => [...ui.dom.timers.values()].filter((ms) => ms === 10000).length;

  it("hovering or focusing pauses it; leaving both restarts the 10 s", () => {
    const ui = load();
    ui.showMsg("Transaction deleted.", true, { action: { label: "Undo", run() {} } });
    const toast = ui.dom.document.getElementById("toast-stack").children[0];
    assert.equal(pending(ui), 1);
    toast.fire("mouseenter"); assert.equal(pending(ui), 0, "paused while hovered");
    toast.fire("focusin"); toast.fire("mouseleave"); assert.equal(pending(ui), 0, "still focused");
    toast.fire("focusout", { relatedTarget: toast.children[2] }); assert.equal(pending(ui), 0, "focus moved within the toast");
    toast.fire("focusout", { relatedTarget: null }); assert.equal(pending(ui), 1, "restarted");
  });

  it("a click on its text doesn't close it; Dismiss does, without running the action", () => {
    const ui = load();
    let ran = 0;
    ui.showMsg("Transaction deleted.", true, { action: { label: "Undo", run: () => ran++ } });
    const toast = ui.dom.document.getElementById("toast-stack").children[0];
    toast.children[0].fire("click");
    assert.equal(toast.classList.contains("toast-leaving"), false);
    const close = toast.children[2];
    assert.equal(close.className, "toast-close");
    assert.equal(close.attrs["aria-label"], "Dismiss");
    close.fire("click");
    assert.ok(toast.classList.contains("toast-leaving"));
    assert.equal(ran, 0);
  });

  it("action.focus moves focus to the button; without it focus stays put", () => {
    const ui = load();
    ui.showMsg("A.", true, { action: { label: "Undo", run() {} } });
    assert.equal(ui.dom.document.activeElement, null);
    ui.showMsg("B.", true, { action: { label: "Undo", focus: true, run() {} } });
    assert.equal(ui.dom.document.activeElement, ui.dom.document.getElementById("toast-stack").children[1].children[1]);
  });

  it("a plain toast still closes on a click", () => {
    const ui = load();
    ui.showMsg("Saved.", true);
    const toast = ui.dom.document.getElementById("toast-stack").children[0];
    toast.fire("click");
    assert.ok(toast.classList.contains("toast-leaving"));
  });

  it("the Activity delete asks for focus and names the Settings list", () => {
    const tx = read("teller/public/transactions.js");
    assert.match(tx, /'Transaction deleted\. You can also restore it from Settings → Sync Health → Deleted transactions\.'/);
    assert.match(tx, /action: \{ label: 'Undo', focus: true, run:/);
    const css = read("teller/public/perfin-shared.css");
    assert.match(css, /\.toast-close \{/);
    assert.match(css, /\.toast:has\(\.toast-action\) \{ cursor: default; \}/);
  });
});

// ---------------------------------------------------------------- F57 / F39 (Accounts)
describe("F57 / F39 — the Accounts page's per-row buttons", () => {
  const page = read("teller/views/accounts.ejs");
  async function render(items) {
    const itemsList = { innerHTML: "", textContent: "" };
    const ctx = {
      esc, itemsList, apiFetch: async () => fakeRes(200, items), showStatus() {},
    };
    vm.runInNewContext(slice(page, "async function loadItems()", "async function unlinkAccount(") + "this.loadItems = loadItems;", ctx);
    await ctx.loadItems();
    return itemsList.innerHTML;
  }

  it("Re-authenticate, Add accounts and Unlink name their institution", async () => {
    const html = await render([
      { id: 7, provider: "plaid", status: "GOOD", last_error_code: "ITEM_LOGIN_REQUIRED", institution_name: "Capital <Bank>", accounts: [{}] },
      { id: 2, provider: "teller", status: "GOOD", institution_name: "Chase", accounts: [{}] },
    ]);
    assert.match(html, /aria-label="Re-authenticate Capital &lt;Bank&gt;">Re-authenticate</);
    assert.match(html, /aria-label="Add accounts at Capital &lt;Bank&gt;">Add accounts</);
    assert.match(html, /aria-label="Unlink Capital &lt;Bank&gt;">Unlink</);
    assert.match(html, /aria-label="Unlink Chase">Unlink</);
  });

  it("a double tap opens Plaid's update mode once", async () => {
    const log = [];
    let release;
    const win = {
      location: { origin: "https://app.example", pathname: "/perfin/accounts", href: "" },
      navigator: { userAgent: "Mozilla/5.0 (Windows NT 10.0)" },
      matchMedia: () => ({ matches: false }),
    };
    const ctx = {
      window: win, navigator: win.navigator, JSON,
      sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} },
      apiFetch: async (url) => { log.push(url); await new Promise((r) => { release = r; }); return fakeRes(200, { link_token: "t" }); },
      writeOk: async (r) => r.ok, showStatus: (t) => log.push(t),
      ensurePlaidSdk: async () => {}, loadItems() {}, loadInvestments() {},
    };
    win.Plaid = { create: () => ({ open: () => log.push("open") }) };
    vm.runInNewContext(slice(page, "var PLAID_UPDATE_KEY", "// --- Plaid transactions link"), ctx);
    const a = ctx.updatePlaidItem(7, "transactions", "Capital Bank");
    const b = ctx.updatePlaidItem(7, "transactions", "Capital Bank");
    await settle(); release(); await Promise.all([a, b]);
    assert.deepEqual(log, ["/api/plaid/link-token-update", "open"]);
    const c = ctx.updatePlaidItem(7, "transactions", "Capital Bank");
    await settle(); release(); await c;
    assert.equal(log.filter((x) => x === "open").length, 2, "a later tap opens again");
  });
});
