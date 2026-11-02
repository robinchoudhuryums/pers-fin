// Seams & Invariants audit #4, batch S4-5 (UI correctness), Perfin's side:
//   C2 — a Settings select / text / number box whose save was refused (or never
//        reached the server) goes back to the stored value, like a switch;
//   C3 — the emergency-fund note shows beside the projection;
//   C4 — the dashboard summary: a reload after a failed first load shows the
//        cards again, a failed reload keeps the ones on the page;
//   C5 — "Since you last looked" amounts through fmt and the money colours.
// C6 (Per-sistant's heatmap day) is apps/per-sistant/tests/seams-audit-4-s5.test.js
// and tests/contract/seams4-s4-5.contract.test.js.
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const ROOT = path.join(__dirname, "..");
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), "utf8");
function slice(src, start, end) {
  const i = src.indexOf(start);
  assert.ok(i >= 0, "missing: " + start);
  const j = src.indexOf(end, i + start.length);
  assert.ok(j > i, "missing: " + end);
  return src.slice(i, j);
}
const shared = read("teller", "public", "perfin-shared.js");
const settings = read("teller", "views", "settings.ejs");
const dash = read("teller", "views", "dashboard.ejs");
const fakeRes = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body });

// ---------------------------------------------------------------------------
describe("C2 — a refused select / box save puts the stored value back", () => {
  function el(value) {
    const attrs = {};
    return {
      value,
      getAttribute: (k) => (k in attrs ? attrs[k] : null),
      setAttribute: (k, v) => { attrs[k] = String(v); },
    };
  }
  function load(api, els) {
    const msgs = [];
    const ctx = {
      JSON, apiFetch: async (url, opts) => api(url, opts), showMsg: (t, ok) => msgs.push([t, ok]), applyTheme() {},
      document: { getElementById: (id) => els[id] || null },
    };
    vm.runInNewContext(slice(settings, "async function updateSetting(key, value)", "// Monthly AI budget cap"), ctx);
    return { ctx, msgs };
  }

  it("a refused save restores the value loadSettings marked; the error is shown", async () => {
    const sel = el("6");
    const { ctx, msgs } = load(async () => fakeRes(400, { error: "dashboard_months must be 1-24" }), { "months-select": sel });
    ctx.markSavedFields();
    sel.value = "99";
    assert.equal(await ctx.saveField(sel, "dashboard_months", 99), false);
    assert.equal(sel.value, "6");
    assert.equal(sel.getAttribute("data-saved"), "6");
    assert.deepEqual(msgs.at(-1), ["dashboard_months must be 1-24", false]);
  });

  it("a save that never reached the server restores it too", async () => {
    const sel = el("sonnet");
    const { ctx } = load(async () => { throw new Error("offline"); }, { "model-select": sel });
    ctx.markSavedFields();
    sel.value = "opus";
    assert.equal(await ctx.saveField(sel, "insights_model", "opus"), false);
    assert.equal(sel.value, "sonnet");
  });

  it("a saved change becomes the stored value a later refusal goes back to", async () => {
    const box = el("15");
    let ok = true;
    const { ctx } = load(async () => (ok ? fakeRes(200, {}) : fakeRes(400, { error: "no" })), { "timeout-input": box });
    ctx.markSavedFields();
    box.value = "30";
    assert.equal(await ctx.saveField(box, "session_timeout_minutes", 30), true);
    assert.equal(box.getAttribute("data-saved"), "30");
    ok = false;
    box.value = "0";
    await ctx.saveField(box, "session_timeout_minutes", 0);
    assert.equal(box.value, "30");
  });

  it("nothing marked (Settings never loaded) → the value is left alone", async () => {
    const sel = el("weekly");
    const { ctx } = load(async () => fakeRes(400, { error: "no" }), {});
    assert.equal(await ctx.saveField(sel, "sheets_auto_sync_interval", "weekly"), false);
    assert.equal(sel.value, "weekly");
  });

  it("every select / box bound to a setting saves through saveField, and each is marked on load", () => {
    const bind = slice(settings, "    bindEvents([\n      ['theme-select'", "    ]);");
    assert.doesNotMatch(bind, /'change', function\(\) \{ updateSetting\(/, "no change handler calls updateSetting directly");
    const ids = [...bind.matchAll(/\['([a-z0-9-]+)', 'change', function\(\) \{ saveField\(this, /g)].map((m) => m[1]);
    const listed = JSON.parse(slice(settings, "var SAVED_FIELDS = ", ";").slice("var SAVED_FIELDS = ".length).replace(/'/g, '"').replace(/\s+/g, " "));
    assert.deepEqual([...ids].sort(), [...listed].sort());
    for (const id of listed) assert.match(settings, new RegExp(`id="${id}"`), id + " is on the page");
    const load = slice(settings, "async function loadSettings()", "// Check AI API status");
    const marked = load.indexOf("markSavedFields();");
    assert.ok(marked > 0);
    for (const id of listed) {
      const set = load.indexOf(`getElementById('${id}')`);
      assert.ok(set > 0 && set < marked, id + " is filled before it is marked");
    }
  });
});

// ---------------------------------------------------------------------------
describe("C3 — the emergency-fund note shows beside the projection", () => {
  function card() {
    const ctx = {
      esc: (s) => String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"),
      fmt: (n) => "$" + Number(n).toFixed(2), emptyState: () => "", Number, String, Date, JSON,
    };
    vm.runInNewContext(slice(dash, "    var ADVICE_DISCLAIMER", "    // Design D3: the Summary card + Needs attention"), ctx);
    return ctx;
  }
  const ef = (extra) => ({ months_covered: 1.2, target_months: 3, have: 4000, target: 10500, pct: 38, reached: false, ...extra });

  it("projection and note → both", () => {
    const html = card().adviceEmergency(ef({ projection: { months: 20, month: "2028-06" }, note: "It comes after your high-interest debt is paid off." }));
    assert.match(html, /<div class="advice-ef-sub">At this pace, reached around [^<]*2028\. It comes after your high-interest debt is paid off\.<\/div>/);
  });

  it("only one of them → that one; reached → Reached.; neither → no line", () => {
    const c = card();
    assert.match(c.adviceEmergency(ef({ note: "Nothing is going toward it right now." })), /<div class="advice-ef-sub">Nothing is going toward it right now\.<\/div>/);
    assert.match(c.adviceEmergency(ef({ projection: { months: 3, month: "2027-02" } })), /<div class="advice-ef-sub">At this pace, reached around [^<]*2027\.<\/div>/);
    assert.match(c.adviceEmergency(ef({ reached: true, note: "x" })), /<div class="advice-ef-sub">Reached\.<\/div>/);
    assert.doesNotMatch(c.adviceEmergency(ef({})), /advice-ef-sub/);
  });

  it("the note is escaped", () => {
    assert.match(card().adviceEmergency(ef({ note: "<b>x</b>" })), /&lt;b&gt;x&lt;\/b&gt;/);
  });
});

// ---------------------------------------------------------------------------
describe("C4 — a summary reload un-hides the cards; a failed reload keeps them", () => {
  function setup() {
    const node = () => ({ hidden: false, innerHTML: "", textContent: "", removeAttribute() {} });
    const els = { "dash-summary-cards": node(), "dash-attention": node(), "dash-attention-body": node(), "dash-summary-error": node() };
    els["dash-summary-error"].hidden = true;
    const msgs = [];
    let next = null;
    const ctx = {
      document: { getElementById: (id) => els[id] || null },
      apiFetch: async () => next(),
      renderSummaryCards: (s) => "CARDS:" + s.tag,
      renderAttention: () => "ATT",
      showMsg: (t, ok) => msgs.push([t, ok]),
    };
    vm.runInNewContext(slice(dash, "    var summaryShown = false;", "    // Initialize"), ctx);
    return { ctx, els, msgs, respond: (fn) => { next = fn; } };
  }

  it("a failed first load hides the cards with one line; a later success shows them again", async () => {
    const t = setup();
    t.respond(async () => fakeRes(500, {}));
    await t.ctx.loadDashboardSummary();
    assert.equal(t.els["dash-summary-cards"].hidden, true);
    assert.equal(t.els["dash-attention"].hidden, true);
    assert.equal(t.els["dash-summary-error"].hidden, false);
    t.respond(async () => fakeRes(200, { tag: "ok" }));
    await t.ctx.loadDashboardSummary();
    assert.equal(t.els["dash-summary-cards"].hidden, false);
    assert.equal(t.els["dash-attention"].hidden, false);
    assert.equal(t.els["dash-summary-error"].hidden, true);
    assert.equal(t.els["dash-summary-cards"].innerHTML, "CARDS:ok");
  });

  it("a failed reload keeps the summary already shown and says so", async () => {
    const t = setup();
    t.respond(async () => fakeRes(200, { tag: "first" }));
    await t.ctx.loadDashboardSummary();
    t.respond(async () => { throw new Error("offline"); });
    await t.ctx.loadDashboardSummary();
    assert.equal(t.els["dash-summary-cards"].hidden, false);
    assert.equal(t.els["dash-attention"].hidden, false);
    assert.equal(t.els["dash-summary-error"].hidden, true);
    assert.equal(t.els["dash-summary-cards"].innerHTML, "CARDS:first");
    assert.equal(t.msgs.length, 1);
    assert.equal(t.msgs[0][1], false);
  });
});

// ---------------------------------------------------------------------------
describe("C5 — Since-you-last-looked amounts through fmt and the money colours", () => {
  function row(bc) {
    const ctx = { esc: (s) => String(s), parseFloat, Math, String };
    vm.runInNewContext(slice(shared, "function fmt(n)", "// TODAY as 'YYYY-MM-DD'") +
      slice(dash, "    function whatsNewBalanceRow(bc)", "    // S3: \"What's new since last visit\" widget."), ctx);
    return ctx.whatsNewBalanceRow(bc);
  }

  it("a falling cash balance: -$X with separators, the default colour; an overdraft red", () => {
    const html = row({ account_name: "Checking", delta: -1224.29, favorable: false, is_debt: false, baseline_balance: 1200, current_balance: -24.29 });
    assert.match(html, /<span>-\$1,224\.29<\/span>/);
    assert.match(html, /\(\$1,200\.00 → <span class="amt-bad">-\$24\.29<\/span>\)/);
    assert.doesNotMatch(html, /\$-|var\(--red\)|var\(--green\)/);
  });

  it("a rising cash balance is money in (green)", () => {
    assert.match(row({ account_name: "Savings", delta: 2500, favorable: true, is_debt: false, baseline_balance: 10000, current_balance: 12500 }),
      /<span class="amt-in">\+\$2,500\.00<\/span> <span>\(\$10,000\.00 → \$12,500\.00\)<\/span>/);
  });

  it("a debt that rose is red; a debt paid down is the default colour", () => {
    assert.match(row({ account_name: "Visa", delta: 300, favorable: false, is_debt: true, baseline_balance: 1000, current_balance: 1300 }),
      /<span class="amt-bad">\+\$300\.00 owed<\/span>/);
    const down = row({ account_name: "Visa", delta: -300, favorable: true, is_debt: true, baseline_balance: 1300, current_balance: 1000 });
    assert.match(down, /<span>-\$300\.00 owed<\/span>/);
    assert.doesNotMatch(down, /amt-bad|amt-in/);
  });

  it("the widget renders every balance row through it, and a new subscription through fmt", () => {
    const w = slice(dash, "(async function loadWhatsNew() {", "// PWA — use the shared helper");
    assert.match(w, /html\.push\(whatsNewBalanceRow\(data\.balance_changes\[i\]\)\)/);
    assert.match(w, /fmt\(s\.amount\)/);
    assert.doesNotMatch(w, /toFixed\(2\)/);
  });
});
