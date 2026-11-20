// ============================================================================
// Cycle 9 (Nov 2026 broad scan) Batch 9 — Perfin UI
// ============================================================================
// F73  Settle Up knows when a request FAILED (no net, no "Mark settled"); the
//      Accounts net total isn't shown when investments couldn't be loaded
// F74  saving one account-card field doesn't wipe the field being typed next
// F75  the hidden attribute always hides
// F76  the Perfin entry overlay is cleared on a back / forward-cache restore
// F77  failed requests: Upcoming Charges, Resolve, Link account
// F78  one Ask at a time; Quick Add Bill saves once
// F79  smaller: light-theme row separators, a labelled range select, money
//      through fmt(), "Enable push" can't spin forever
// Each client function is run in a vm from the page's own source. The
// Per-sistant half of F79 is apps/per-sistant/tests/cycle9-b9.test.js; the
// browser half is e2e/pages.spec.js.
// ============================================================================

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const read = (...p) => fs.readFileSync(path.join(__dirname, "..", ...p), "utf8");
const DASH = read("teller", "views", "dashboard.ejs");
const SETTINGS = read("teller", "views", "settings.ejs");
const GOALS = read("teller", "views", "goals.ejs");
const SHARED_JS = read("teller", "public", "perfin-shared.js");

function extractFunction(src, name) {
  let start = src.indexOf("function " + name + "(");
  assert.ok(start >= 0, "function " + name + " present");
  if (src.slice(start - 6, start) === "async ") start -= 6;
  let i = src.indexOf("{", src.indexOf(")", start)), depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}" && --depth === 0) break;
  }
  return src.slice(start, i + 1);
}
// "(function name() { … })" starting at `marker`, as a callable expression.
function extractIife(src, marker, from = 0) {
  const start = src.indexOf(marker, from);
  assert.ok(start >= 0, marker + " present");
  let depth = 0;
  for (let i = start; i < src.length; i++) {
    if (src[i] === "(") depth++;
    else if (src[i] === ")" && --depth === 0) return src.slice(start, i + 1) + "();";
  }
  throw new Error("unbalanced: " + marker);
}
const settle = () => new Promise((r) => setTimeout(r, 0));
const ok = (body) => ({ ok: true, status: 200, json: async () => body, clone() { return this; } });
const bad = (status = 500) => ({ ok: false, status, json: async () => ({ error: "An internal error occurred." }), clone() { return this; } });
const fmt = (() => { const c = vm.createContext({ Math, Number, isFinite, parseFloat }); vm.runInContext(extractFunction(SHARED_JS, "fmt"), c); return c.fmt; })();

// ---------------------------------------------------------------------------
// F73 — Settle Up
// ---------------------------------------------------------------------------
describe("F73 — Settle Up knows when a request failed", () => {
  const SHARED = { month: "2026-10", partner_name: "Sam", accounts: [{ account_name: "Joint Visa", partner_share: 240, your_share: 240, split_pct: 50, shared_total: 480, your_personal_total: 0, partner_personal_total: 0, total_charges: 480, txn_count: 6, account_key: "acc1" }] };
  const HOUSING = { enabled: true, direction: "you_send_partner", transfer: 900, rent_utilities: 2400, car: 600, each_share: 1500, partner_name: "Sam", awaiting_count: 0 };
  function widget(routes, { visible = false } = {}) {
    const els = {
      "settlement-section": { style: { display: visible ? "" : "none" } },
      "settlement-headline": { innerHTML: "" },
      "settlement-body": { innerHTML: "" },
      "settlement-month-pick": { value: "2026-10" },
    };
    const ctx = vm.createContext({
      Promise, Math, parseFloat, parseInt, Date, String, encodeURIComponent, JSON,
      window: {}, document: { getElementById: (id) => els[id] || null },
      buildSettlementMonthOptions() {},
      esc: (s) => String(s),
      writeOk: async () => true, showMsg() {},
      apiFetch: (url) => {
        const key = Object.keys(routes).find((k) => url.indexOf(k) === 0);
        const r = routes[key];
        return r instanceof Error ? Promise.reject(r) : Promise.resolve(r);
      },
    });
    vm.runInContext(["fmtMoney", "monthLabel", "settleLeg", "settleLoadState", "settleFailedNote", "settleFailedHtml", "wireSettleRetry", "loadSettlement"]
      .map((n) => extractFunction(DASH, n)).join("\n"), ctx);
    return { ctx, els };
  }
  const ROUTES = { "/api/shared-settlement": ok(SHARED), "/api/housing/split": ok(HOUSING), "/api/settlement": ok({ settled: false }) };

  it("settleLoadState names what failed", () => {
    const { ctx } = widget(ROUTES);
    const s = (a, b, c) => JSON.parse(JSON.stringify(ctx.settleLoadState([{ ok: a }, { ok: b }, { ok: c }])));
    assert.deepEqual(s(true, true, true), { moneyFailed: [], stateFailed: false, incomplete: false });
    assert.deepEqual(s(true, false, true), { moneyFailed: ["the rent & utilities even-up"], stateFailed: false, incomplete: true });
    assert.deepEqual(s(false, false, true).moneyFailed, ["the shared-card totals", "the rent & utilities even-up"]);
    assert.deepEqual(s(true, true, false), { moneyFailed: [], stateFailed: true, incomplete: true });
  });
  it("everything loaded: the net and Mark settled, as before", async () => {
    const { ctx, els } = widget(ROUTES);
    await ctx.loadSettlement();
    const h = els["settlement-headline"].innerHTML;
    assert.match(h, /Send Sam <strong>\$660\.00<\/strong>/); // 240 owed to you − 900 you send
    assert.match(h, /id="settle-mark-btn"[^>]*data-net="-660"/);
    assert.doesNotMatch(h, /Net not available|settle-retry-btn/);
    assert.equal(els["settlement-section"].style.display, "");
  });
  it("the housing leg failed: no net, no Mark settled, a Try again", async () => {
    for (const failure of [bad(500), new Error("offline")]) {
      const { ctx, els } = widget({ ...ROUTES, "/api/housing/split": failure });
      await ctx.loadSettlement();
      const h = els["settlement-headline"].innerHTML;
      assert.match(h, /Net not available/);
      assert.doesNotMatch(h, /settle-mark-btn|settle-undo-btn|\$240\.00<\/strong>/, "the shared leg alone is never offered as the net");
      assert.match(h, /Couldn't load the rent &amp; utilities even-up|Couldn't load the rent & utilities even-up/);
      assert.match(h, /id="settle-retry-btn"/);
      assert.match(els["settlement-body"].innerHTML, /Joint Visa/, "what did load is still listed");
    }
  });
  it("the shared-card leg failed: the even-up alone is not the net either", async () => {
    const { ctx, els } = widget({ ...ROUTES, "/api/shared-settlement": bad(502) });
    await ctx.loadSettlement();
    const h = els["settlement-headline"].innerHTML;
    assert.match(h, /Net not available/);
    assert.doesNotMatch(h, /settle-mark-btn|\$900\.00<\/strong>/);
    assert.match(h, /the shared-card totals/);
  });
  it("only the settled / not-settled read failed: the net shows, no button", async () => {
    const { ctx, els } = widget({ ...ROUTES, "/api/settlement": bad(500) });
    await ctx.loadSettlement();
    const h = els["settlement-headline"].innerHTML;
    assert.match(h, /Send Sam <strong>\$660\.00<\/strong>/);
    assert.doesNotMatch(h, /settle-mark-btn|settle-undo-btn/);
    assert.match(h, /Couldn't check whether this month is already settled/);
  });
  it("nothing loaded: a widget that was never shown stays hidden; one on screen says so", async () => {
    const routes = { ...ROUTES, "/api/shared-settlement": bad(500), "/api/housing/split": ok({ enabled: false }) };
    const hiddenOne = widget(routes);
    await hiddenOne.ctx.loadSettlement();
    assert.equal(hiddenOne.els["settlement-section"].style.display, "none");
    assert.equal(hiddenOne.els["settlement-headline"].innerHTML, "");
    const shown = widget(routes, { visible: true });
    await shown.ctx.loadSettlement();
    assert.equal(shown.els["settlement-section"].style.display, "");
    assert.match(shown.els["settlement-headline"].innerHTML, /Net not available/);
    assert.match(shown.els["settlement-headline"].innerHTML, /settle-retry-btn/);
  });
  it("genuinely nothing to settle still hides the widget", async () => {
    const { ctx, els } = widget({ ...ROUTES, "/api/shared-settlement": ok({ month: "2026-10", accounts: [] }), "/api/housing/split": ok({ enabled: false }) }, { visible: true });
    await ctx.loadSettlement();
    assert.equal(els["settlement-section"].style.display, "none");
  });
});

// ---------------------------------------------------------------------------
// F73 — the Accounts net total
// ---------------------------------------------------------------------------
describe("F73 — the Accounts net total when investments couldn't be loaded", () => {
  function grid(invResponse, accounts = [{ id: 1, type: "depository", name: "Checking", institution_name: "Bank", available_balance: 1500, current_balance: 1500 }]) {
    const els = { "accounts-grid": { innerHTML: "" }, "acct-count": {}, "net-balance": { textContent: "--", className: "value", title: "" } };
    const animated = [];
    const ctx = vm.createContext({
      Promise, Set, String, parseFloat, parseInt, Math, Date, isNaN,
      window: {}, document: { getElementById: (id) => els[id] || null },
      esc: (s) => String(s), fmt,
      animateInt() {}, animateCurrency: (el, v) => { animated.push(v); el.textContent = fmt(v); },
      apiFetch: async (url) => (url === "/api/accounts" ? ok(accounts) : invResponse),
    });
    vm.runInContext(["accountsInvFailedHtml", "setNetBalance", "loanPayoff", "loadAccounts"].map((n) => extractFunction(DASH, n)).join("\n"), ctx);
    return { ctx, els, animated };
  }
  it("a failed investments request: the accounts are listed, the net is \"—\" and says why", async () => {
    const { ctx, els, animated } = grid(bad(500));
    await ctx.loadAccounts();
    assert.match(els["accounts-grid"].innerHTML, /Checking/);
    assert.match(els["accounts-grid"].innerHTML, /Investment accounts couldn't be loaded, so the net balance isn't shown/);
    assert.equal(els["net-balance"].textContent, "—");
    assert.match(els["net-balance"].title, /investment accounts couldn't be loaded/);
    assert.deepEqual(animated, [], "no partial total is animated in");
  });
  it("with investments loaded the net includes them", async () => {
    const { ctx, els, animated } = grid(ok([{ id: 9, name: "Brokerage", institution: "Schwab", balance: "8500.00", account_type: "brokerage" }]));
    await ctx.loadAccounts();
    assert.deepEqual(animated, [10000]);
    assert.equal(els["net-balance"].title, "");
    assert.doesNotMatch(els["accounts-grid"].innerHTML, /couldn't be loaded/);
  });
  it("no linked accounts and a failed investments request is not \"No accounts linked\"", async () => {
    const { ctx, els } = grid(bad(500), []);
    await ctx.loadAccounts();
    assert.doesNotMatch(els["accounts-grid"].innerHTML, /No accounts linked/);
    assert.match(els["accounts-grid"].innerHTML, /Investment accounts couldn't be loaded/);
    assert.equal(els["net-balance"].textContent, "—");
  });
});

// ---------------------------------------------------------------------------
// F74
// ---------------------------------------------------------------------------
describe("F74 — a save doesn't wipe the field being typed next", () => {
  function card() {
    const state = { reloads: 0, active: null, sent: [], msgs: [] };
    const gridInput = { tagName: "INPUT", closest: (sel) => (sel === "#accounts-grid" ? {} : null) };
    const elsewhere = { tagName: "BODY", closest: () => null };
    let release = null;
    const ctx = vm.createContext({
      Promise, JSON, parseFloat,
      document: { get activeElement() { return state.active; } },
      loadAccounts: () => { state.reloads++; },
      showMsg: (m, good) => state.msgs.push([m, good]),
      apiFetch: (url, opts) => {
        state.sent.push([url, JSON.parse(opts.body)]);
        if (state.hold) return new Promise((r) => { release = () => r(state.next || ok({})); });
        return Promise.resolve(state.next || ok({}));
      },
    });
    vm.runInContext("var acctSaving = 0, acctReloadDeferred = false;\n" +
      ["accountsInputFocused", "reloadAccountsSoon", "saveAccountField", "setMonthlyPayment", "setApr", "setCreditLimit"].map((n) => extractFunction(DASH, n)).join("\n"), ctx);
    return { ctx, state, gridInput, elsewhere, release: () => release() };
  }
  it("limit saved while the APR box has focus: no re-render until focus leaves the grid", async () => {
    const c = card();
    c.state.active = c.gridInput; // Tab moved to APR; the limit's change event is saving
    await c.ctx.setCreditLimit(7, "5000");
    assert.deepEqual(c.state.sent, [["/api/accounts/7/balance", { credit_limit: 5000 }]]);
    assert.equal(c.state.reloads, 0, "the grid is left alone while a field is being typed in");
    assert.equal(vm.runInContext("acctReloadDeferred", c.ctx), true);
    // APR typed, then focus leaves: its own save finishes and ONE reload shows both.
    c.state.active = c.elsewhere;
    await c.ctx.setApr(7, "24.99");
    assert.equal(c.state.reloads, 1);
    assert.equal(vm.runInContext("acctReloadDeferred", c.ctx), false);
  });
  it("focus leaves without another edit: the waiting reload runs (the focusout path)", async () => {
    const c = card();
    c.state.active = c.gridInput;
    await c.ctx.setCreditLimit(7, "5000");
    assert.equal(c.state.reloads, 0);
    c.state.active = c.elsewhere;
    assert.equal(c.ctx.reloadAccountsSoon(), true);
    assert.equal(c.state.reloads, 1);
    assert.match(DASH, /grid\.addEventListener\('focusout', function\(\) \{\s+setTimeout\(function\(\) \{ if \(acctReloadDeferred\) reloadAccountsSoon\(\); \}, 0\);/);
  });
  it("a reload asked for while a save is in flight waits for it", async () => {
    const c = card();
    c.state.active = c.elsewhere;
    c.state.hold = true;
    const p = c.ctx.setApr(7, "19.9");
    await settle();
    assert.equal(c.ctx.reloadAccountsSoon(), false);
    assert.equal(c.state.reloads, 0);
    c.release();
    await p;
    assert.equal(c.state.reloads, 1);
  });
  it("nothing focused: a save reloads at once; a refused save says so and doesn't reload", async () => {
    const c = card();
    c.state.active = c.elsewhere;
    await c.ctx.setMonthlyPayment(3, "350");
    assert.equal(c.state.reloads, 1);
    c.state.next = { ok: false, status: 400, json: async () => ({ error: "apr must be 0-99.99" }) };
    await c.ctx.setApr(3, "150");
    assert.equal(c.state.reloads, 1);
    assert.deepEqual(c.state.msgs[c.state.msgs.length - 1], ["apr must be 0-99.99", false]);
  });
  it("the other grid reloads (sync, balance edit, shared split) wait for typing too", () => {
    assert.equal((DASH.match(/\n\s+reloadAccountsSoon\(\);\n/g) || []).length, 3);
    assert.equal((DASH.match(/\n\s+loadAccounts\(\);\n/g) || []).length, 2, "the first load and the one inside reloadAccountsSoon");
  });
});

// ---------------------------------------------------------------------------
// F75 / F79 (CSS + markup)
// ---------------------------------------------------------------------------
describe("F75 / F79 — shared CSS and markup", () => {
  const css = read("teller", "public", "perfin-shared.css");
  it("the hidden attribute always hides", () => {
    assert.match(css, /\n\[hidden\] \{ display: none !important; \}/);
  });
  it("row separators are visible on the light theme", () => {
    assert.match(css, /\[data-theme="light"\] td \{ border-bottom-color: rgba\(0,0,0,0\.07\); \}/);
  });
  it("the account-history range select has its label", () => {
    assert.match(read("teller", "views", "account-history.ejs"), /<label for="range-select"[^>]*>Range<\/label>\s*<select id="range-select"/);
  });
  it("budget, manual-account and split amounts go through fmt()", () => {
    const budgets = read("teller", "views", "budgets.ejs");
    assert.doesNotMatch(budgets, /'\$' \+|>\$' \+|toFixed\(0\)/);
    assert.match(budgets, /fmt\(b\.spent\) \+ ' of ' \+ fmt\(limit\)/);
    assert.match(budgets, /fmt\(remaining\) \+ ' remaining'/);
    assert.match(budgets, /fmt\(totalBudget - totalSpent\)/);
    const accounts = read("teller", "views", "accounts.ejs");
    assert.match(accounts, /var balStr = fmt\(Math\.abs\(bal\)\);/);
    assert.match(accounts, /' \/ Limit: ' \+ fmt\(parseFloat\(a\.credit_limit\)\)/);
    assert.match(read("teller", "public", "transactions.js"), /fmt\(diff\) \+ ' over' : fmt\(Math\.abs\(diff\)\) \+ ' under'/);
  });
});

// ---------------------------------------------------------------------------
// F76
// ---------------------------------------------------------------------------
describe("F76 — the Perfin entry overlay after a back / forward-cache restore", () => {
  function load() {
    const listeners = {};
    const overlay = { classes: new Set(["materialize-overlay", "active"]), classList: { remove(c) { overlay.classes.delete(c); } } };
    const ctx = vm.createContext({
      Math, setTimeout,
      window: { addEventListener: (ev, fn) => { listeners[ev] = fn; }, location: {} },
      document: {
        readyState: "complete",
        querySelectorAll: () => [],
        getElementById: (id) => (id === "perfin-materialize-overlay" ? overlay : null),
        addEventListener() {},
      },
    });
    vm.runInContext(read("shell", "public", "perfin-materialize.js"), ctx);
    return { listeners, overlay };
  }
  it("a restored page drops the overlay; an ordinary load leaves it alone", () => {
    const { listeners, overlay } = load();
    assert.equal(typeof listeners.pageshow, "function");
    listeners.pageshow({ persisted: false });
    assert.ok(overlay.classes.has("active"));
    listeners.pageshow({ persisted: true });
    assert.ok(!overlay.classes.has("active"));
  });
});

// ---------------------------------------------------------------------------
// F77
// ---------------------------------------------------------------------------
describe("F77 — failed requests", () => {
  it("Upcoming Charges: a failed or empty answer renders nothing (it wrote \"undefined charges\")", async () => {
    const run = async (response) => {
      const els = { "forecast-section": { style: { display: "none" } }, "forecast-summary": { innerHTML: "" }, "forecast-list": { innerHTML: "" } };
      const ctx = vm.createContext({ Array, document: { getElementById: (id) => els[id] }, esc: String, fmt, apiFetch: async () => response });
      vm.runInContext(extractFunction(DASH, "loadForecast"), ctx);
      await ctx.loadForecast();
      return els;
    };
    for (const r of [bad(500), ok({ error: "nope" }), ok({ charge_count: 0, charges: [] })]) {
      const els = await run(r);
      assert.equal(els["forecast-section"].style.display, "none");
      assert.equal(els["forecast-summary"].innerHTML, "");
    }
    const els = await run(ok({ charge_count: 2, total_expected: 31.98, forecast_days: 30, charges: [{ name: "Netflix", amount: 15.99, date: "2026-12-01", days_away: 3 }, { name: "Hulu", amount: 15.99, date: "2026-12-05", days_away: 7 }] }));
    assert.equal(els["forecast-section"].style.display, "block");
    assert.match(els["forecast-summary"].innerHTML, /<strong>2 charges<\/strong> totaling <strong>\$31\.98<\/strong>/);
  });

  it("Resolve: a request that never reaches the server re-enables the button and says so", async () => {
    const at = SETTINGS.indexOf("var btn = ev.target.closest('[data-resolve-error]');");
    const start = SETTINGS.lastIndexOf("(function () {", at);
    const listeners = [], msgs = [];
    let reloaded = 0;
    const ctx = vm.createContext({
      encodeURIComponent,
      document: { getElementById: () => ({ addEventListener: (ev, fn) => listeners.push(fn) }) },
      apiFetch: async () => { if (ctx.offline) throw new TypeError("Failed to fetch"); return ok({}); },
      writeOk: async (r) => r.ok,
      showMsg: (m, good) => msgs.push([m, good]),
      loadRecentErrors: () => { reloaded++; },
    });
    vm.runInContext(extractIife(SETTINGS, "(function () {", start), ctx);
    const btn = { disabled: false, getAttribute: () => "abc123" };
    const click = () => listeners[0]({ target: { closest: () => btn } });
    ctx.offline = true;
    await click();
    assert.equal(btn.disabled, false);
    assert.deepEqual(msgs[0], ["Resolve error: Failed to fetch", false]);
    assert.equal(reloaded, 0);
    ctx.offline = false;
    await click();
    assert.equal(reloaded, 1);
  });

  it("Link account: a failed funding-options request is reported, and missing lists don't throw", async () => {
    const run = async (response) => {
      const msgs = [];
      const ctx = vm.createContext({
        Array, parseInt,
        document: { getElementById: () => null, querySelector: () => null },
        apiFetch: async () => response,
        writeOk: async (r, what) => { if (!r.ok) msgs.push([what + ": " + (await r.json()).error, false]); return r.ok; },
        showMsg: (m, good) => msgs.push([m, good]),
        esc: String, fmt, loadGoals() {},
      });
      vm.runInContext(extractFunction(GOALS, "linkAccount"), ctx);
      await ctx.linkAccount(4);
      return msgs;
    };
    assert.deepEqual(await run(bad(500)), [["Could not load funding options: An internal error occurred.", false]]);
    assert.deepEqual(await run(ok({})), [["No eligible accounts. Link a depository or investment account first.", false]]);
  });
});

// ---------------------------------------------------------------------------
// F78
// ---------------------------------------------------------------------------
describe("F78 — one request per action", () => {
  it("Ask: Enter while a question is running doesn't send a second paid call", async () => {
    const els = { "ask-input": { value: "how much did I spend?", listeners: {} }, "ask-btn": { disabled: false, listeners: {} }, "ask-answer": { style: {}, textContent: "" }, "ask-meta": { textContent: "" } };
    for (const k of ["ask-input", "ask-btn"]) els[k].addEventListener = function (ev, fn) { this.listeners[ev] = fn; };
    let calls = 0, release;
    const ctx = vm.createContext({
      JSON, Promise,
      document: { getElementById: (id) => els[id] },
      apiFetch: () => { calls++; return new Promise((r) => { release = () => r(ok({ answer: "About $1,200.", tools_used: [], estimated_cost_usd: 0.001 })); }); },
    });
    vm.runInContext(extractIife(DASH, "(function initAsk() {"), ctx);
    const enter = () => els["ask-input"].listeners.keydown({ key: "Enter" });
    enter(); enter(); els["ask-btn"].listeners.click();
    await settle();
    assert.equal(calls, 1);
    release();
    await settle(); await settle();
    assert.equal(els["ask-answer"].textContent, "About $1,200.");
    assert.equal(els["ask-btn"].disabled, false);
    enter();
    await settle();
    assert.equal(calls, 2, "a new question can be asked once the first has answered");
  });

  it("Quick Add Bill: a double tap adds one bill, and Save stays off until the page reloads", async () => {
    const mk = (extra) => ({ value: "", style: {}, textContent: "", disabled: false, listeners: {}, addEventListener(ev, fn) { this.listeners[ev] = fn; }, focus() {}, ...extra });
    const els = {
      "quick-add-bill-modal": mk({ style: { display: "block" } }), "quick-add-bill-btn": mk(), "qab-save": mk({ textContent: "Save bill" }), "qab-cancel": mk(),
      "qab-name": mk({ value: "Water" }), "qab-amount": mk({ value: "40" }), "qab-day": mk({ value: "12" }), "qab-cadence": mk({ value: "monthly" }), "qab-category": mk({ value: "utility" }), "qab-status": mk(),
    };
    const posts = [];
    let next = () => ok({ id: 1 });
    const ctx = vm.createContext({
      JSON, Promise, parseFloat, parseInt, isFinite, Error,
      document: { getElementById: (id) => els[id], addEventListener() {} },
      location: { reload() {} },
      setTimeout: () => {}, // the 600 ms close-and-reload never runs here
      watchDialog() {},
      apiFetch: async (url, opts) => { if (url === "/api/manual-bills") { posts.push(JSON.parse(opts.body)); return next(); } return ok({}); },
    });
    vm.runInContext(extractIife(DASH, "(function wireQuickAddBill() {"), ctx);
    const save = els["qab-save"].listeners.click;
    await Promise.all([save(), save()]);
    await save();
    assert.equal(posts.length, 1);
    assert.deepEqual(posts[0], { name: "Water", amount: 40, due_day: 12, cadence: "monthly", category: "utility" });
    assert.equal(els["qab-save"].disabled, true, "no second save in the 600 ms before the reload");
  });
  it("Quick Add Bill: a refused save can be tried again", async () => {
    const mk = (extra) => ({ value: "", style: {}, textContent: "", disabled: false, listeners: {}, addEventListener(ev, fn) { this.listeners[ev] = fn; }, focus() {}, ...extra });
    const els = {
      "quick-add-bill-modal": mk(), "quick-add-bill-btn": mk(), "qab-save": mk(), "qab-cancel": mk(),
      "qab-name": mk({ value: "Water" }), "qab-amount": mk({ value: "40" }), "qab-day": mk({ value: "12" }), "qab-cadence": mk({ value: "monthly" }), "qab-category": mk({ value: "utility" }), "qab-status": mk(),
    };
    let posts = 0, fail = true;
    const ctx = vm.createContext({
      JSON, Promise, parseFloat, parseInt, isFinite, Error,
      document: { getElementById: (id) => els[id], addEventListener() {} }, location: { reload() {} }, setTimeout: () => {}, watchDialog() {},
      apiFetch: async (url) => { if (url !== "/api/manual-bills") return ok({}); posts++; return fail ? bad(500) : ok({ id: 1 }); },
    });
    vm.runInContext(extractIife(DASH, "(function wireQuickAddBill() {"), ctx);
    await els["qab-save"].listeners.click();
    assert.equal(els["qab-save"].disabled, false);
    assert.match(els["qab-status"].textContent, /^Failed: /);
    fail = false;
    await els["qab-save"].listeners.click();
    assert.equal(posts, 2);
    assert.equal(els["qab-save"].disabled, true);
  });
});

// ---------------------------------------------------------------------------
// F79 — Enable push
// ---------------------------------------------------------------------------
describe("F79 — \"Enable push\" can't wait forever for a service worker", () => {
  function page({ registration, ready }) {
    const els = { "push-btn": { disabled: false, textContent: "…" }, "test-push-btn": { disabled: false }, "push-desc": { textContent: "" } };
    const msgs = [];
    const ctx = vm.createContext({
      Promise, Error,
      setTimeout: (fn) => { ctx.deadline = fn; }, // fired by hand
      window: { PushManager: function () {} },
      navigator: { serviceWorker: { getRegistration: async () => registration, ready } },
      document: { getElementById: (id) => els[id] },
      showMsg: (m, good) => msgs.push([m, good]),
      btnLoading: (btn, on) => { btn.loading = on; },
      apiFetch: async () => ok({}), writeOk: async () => true,
    });
    vm.runInContext("var PUSH_SW_WAIT_MS = 8000;\n" + ["pushRegistration", "checkPushStatus", "togglePush"].map((n) => extractFunction(SETTINGS, n)).join("\n"), ctx);
    return { ctx, els, msgs };
  }
  it("no registration for this page: Enable reports it and stops spinning", async () => {
    const p = page({ registration: undefined, ready: new Promise(() => {}) });
    await p.ctx.togglePush();
    assert.match(p.msgs[0][0], /service worker isn't registered in this browser/);
    assert.equal(p.els["push-btn"].loading, false);
    await p.ctx.checkPushStatus();
    assert.equal(p.els["push-btn"].disabled, false, "pressing Enable again retries");
    assert.match(p.els["push-desc"].textContent, /Push isn't ready in this browser/);
  });
  it("a registration that never becomes ready hits the deadline", async () => {
    const p = page({ registration: {}, ready: new Promise(() => {}) });
    const pending = p.ctx.pushRegistration();
    await settle();
    p.ctx.deadline();
    await assert.rejects(pending, /didn't start/);
  });
  it("a ready worker is returned as before", async () => {
    const reg = { pushManager: { getSubscription: async () => null } };
    const p = page({ registration: reg, ready: Promise.resolve(reg) });
    assert.equal(await p.ctx.pushRegistration(), reg);
    await p.ctx.checkPushStatus();
    assert.equal(p.els["push-btn"].textContent, "Enable");
  });
});
