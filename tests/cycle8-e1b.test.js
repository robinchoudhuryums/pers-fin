// ============================================================================
// Cycle 8 E1b (G1) — "What's in this forecast" on the dashboard
// ============================================================================
// The Cash Flow section's list of projected bills and items left out, run in a
// vm from dashboard.ejs with the real fmt / esc: amounts, cadence, the count and
// total in the window, the next date, the reasons in words, a labelled select
// per transfer (Automatic / Always a bill / Between my accounts / Leave out)
// and per subscription (Include / Leave out), escaping, the empty state; a
// change saved through writeOk with the right PATCH, the section and the
// summary reloaded on success, the select put back on a refusal or a network
// failure, focus kept on the changed control; the delegated listener and the
// markup (collapsed, its open state outside the re-rendered body).
// ============================================================================
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const ROOT = path.join(__dirname, "..");
const dash = fs.readFileSync(path.join(ROOT, "teller", "views", "dashboard.ejs"), "utf8");
const shared = fs.readFileSync(path.join(ROOT, "teller", "public", "perfin-shared.js"), "utf8");
function slice(src, start, end) {
  const i = src.indexOf(start);
  const j = src.indexOf(end, i + start.length);
  assert.ok(i >= 0 && j > i, "slice markers: " + start);
  return src.slice(i, j);
}
const fmtSrc = slice(shared, "function fmt(n) {", "// Calendar dates (DATE columns)");
const escSrc = slice(shared, "function esc(s) {", "\n  }\n") + "\n  }\n";
const section = slice(dash, "    // --- Cash Flow Projection ---", "    // --- Year-over-Year Comparison ---");

function el(id) {
  return {
    id, style: {}, innerHTML: "", hidden: false, listeners: {}, queried: [], focused: null,
    addEventListener(type, fn) { this.listeners[type] = fn; },
    querySelector(sel) { this.queried.push(sel); const self = this; return { focus() { self.focused = sel; } }; },
  };
}

// A context with the section loaded; `replies` maps a URL prefix to a reply.
function ctx({ replies = {}, writeOk = async (r) => !!(r && r.ok), throwOn = null } = {}) {
  const els = {};
  const calls = { fetch: [], msgs: [], summary: 0 };
  const c = {
    document: { getElementById: (id) => (els[id] = els[id] || el(id)), activeElement: null },
    fmtDate: (d) => "D(" + d + ")",
    apiFetch: async (url, opts) => {
      calls.fetch.push({ url, opts });
      if (throwOn && url.startsWith(throwOn)) throw new Error("offline");
      const key = Object.keys(replies).find((k) => url.startsWith(k));
      const body = key ? replies[key] : { error: "nope" };
      return { ok: !!key && !body.__fail, status: key && !body.__fail ? 200 : 400, json: async () => body };
    },
    writeOk, showMsg: (t, ok) => calls.msgs.push([t, ok]),
    loadDashboardSummary: () => { calls.summary++; },
  };
  vm.createContext(c);
  vm.runInContext(fmtSrc + escSrc + section +
    ";this.items = forecastItemsHtml; this.change = onForecastItemChange; this.wire = wireForecastItems; this.load = loadCashFlow; this.cadence = cadenceWords;", c);
  return { c, els, calls };
}

const ITEMS = {
  bills: [
    { source: "subscription", id: 10, name: "Netflix", amount: 15.49, cadence_days: 30, treatment: "auto", why: "auto", next_date: "2026-11-02", occurrences: 3, projected_total: 46.47 },
    { source: "transfer", id: 2, name: "Chase card autopay", amount: 800, cadence_days: 30, treatment: "bill", transfer_type: "bill_payment", why: "user", next_date: "2026-11-05", occurrences: 3, projected_total: 2400 },
    { source: "transfer", id: 4, name: "Car insurance", amount: 600, cadence_days: 365, treatment: "auto", why: "auto", next_date: null, occurrences: 0, projected_total: 0 },
  ],
  left_out: [
    { source: "transfer", id: 1, name: "Transfer to savings", amount: 300, cadence_days: 14, treatment: "auto", reason: "internal" },
    { source: "transfer", id: 3, name: "Zelle <b>Jane</b>", amount: 1500, cadence_days: 30, treatment: "ignore", reason: "user_ignored" },
    { source: "subscription", id: 11, name: "Gym", amount: 40, cadence_days: 30, treatment: "ignore", reason: "user_ignored" },
    { source: "transfer", id: 5, name: "Amex", amount: 120, cadence_days: 30, treatment: "auto", reason: "card_autopay" },
    { source: "transfer", id: 6, name: "Rent split", amount: 900, cadence_days: 30, treatment: "internal", reason: "user_internal" },
  ],
};

describe("forecastItemsHtml", () => {
  const { c } = ctx();
  const html = c.items(ITEMS, 90);

  it("projected bills: amount, cadence, count and total in the window, next date, the user's choice", () => {
    assert.match(html, /<strong>Netflix<\/strong> \$15\.49 a month<br><span[^>]*>3 in the next 90 days, \$46\.47 · next D\(2026-11-02\)<\/span>/);
    assert.match(html, /<strong>Chase card autopay<\/strong> \$800\.00 a month<br><span[^>]*>3 in the next 90 days, \$2,400\.00 · next D\(2026-11-05\) · you set it as a bill<\/span>/);
    assert.match(html, /<strong>Car insurance<\/strong> \$600\.00 a year<br><span[^>]*>Not due in the next 90 days<\/span>/);
  });

  it("left out: each reason in words", () => {
    assert.match(html, /Transfer to savings<\/strong> \$300\.00 every 2 weeks<br><span[^>]*>Looks like a move between your own accounts<\/span>/);
    assert.match(html, /Amex<\/strong>[^<]*<br><span[^>]*>Looks like a credit card payment — the card’s purchases are already in your daily spending<\/span>/);
    assert.match(html, /Rent split<\/strong>[^<]*<br><span[^>]*>You marked it as a move between your accounts<\/span>/);
    assert.match(html, /Gym<\/strong>[^<]*<br><span[^>]*>You left it out<\/span>/);
    assert.ok(html.indexOf("Projected bills") < html.indexOf("Left out"));
  });

  it("a labelled select per item with its current setting selected", () => {
    const selects = html.match(/<select[^>]*>.*?<\/select>/g);
    assert.equal(selects.length, 8);
    const autopay = selects.find((s) => /data-fi-id="2"/.test(s));
    assert.match(autopay, /class="fi-select" data-fi-source="transfer" data-fi-id="2" data-fi-prev="bill" aria-label="Forecast setting for Chase card autopay"/);
    assert.deepEqual([...autopay.matchAll(/<option value="(\w+)"( selected)?>([^<]+)</g)].map((m) => [m[1], !!m[2], m[3]]), [
      ["auto", false, "Automatic"], ["bill", true, "Always a bill"], ["internal", false, "Between my accounts"], ["ignore", false, "Leave out"],
    ]);
    const gym = selects.find((s) => /data-fi-id="11"/.test(s));
    assert.deepEqual([...gym.matchAll(/<option value="(\w+)"( selected)?>([^<]+)</g)].map((m) => [m[1], !!m[2], m[3]]), [
      ["auto", false, "Include"], ["ignore", true, "Leave out"],
    ]);
  });

  it("escapes names everywhere they appear", () => {
    assert.match(html, /<strong>Zelle &lt;b&gt;Jane&lt;\/b&gt;<\/strong>/);
    assert.match(html, /aria-label="Forecast setting for Zelle &lt;b&gt;Jane&lt;\/b&gt;"/);
    assert.doesNotMatch(html, /<b>Jane/);
  });

  it("an item without a source or id gets no select; nothing at all is a note", () => {
    const one = c.items({ bills: [{ name: "Rent", amount: 1500, cadence_days: 30, why: "auto", occurrences: 1, projected_total: 1500, next_date: "2026-11-01" }], left_out: [] }, 30);
    assert.doesNotMatch(one, /<select/);
    assert.doesNotMatch(one, /Left out/);
    assert.match(c.items({ bills: [], left_out: [] }, 90), /No recurring bills or transfers are projected/);
    assert.match(c.items(undefined, 90), /No recurring bills or transfers are projected/);
    assert.match(c.items({ bills: [], left_out: [ITEMS.left_out[0]] }, 90), /Projected bills<\/div><div class="note"[^>]*>None\.<\/div>/);
  });

  it("cadence words", () => {
    assert.deepEqual([7, 14, 30, 60, 90, 365, 45, null].map(c.cadence), ["a week", "every 2 weeks", "a month", "every 2 months", "a quarter", "a year", "every 45 days", ""]);
  });
});

const flowReply = { by_week: [{ week: 1, start_date: "2026-11-01", income: 0, bills: 0, discretionary: 0, end_balance: 100 }], starting_balance: 100, ending_balance: 100, avg_daily_spend: 0, recurring_income: [], forecast_days: 90, forecast_items: ITEMS };

function select({ source = "transfer", id = "2", prev = "bill", value = "internal" } = {}) {
  const attrs = { "data-fi-source": source, "data-fi-id": id, "data-fi-prev": prev };
  return { value, disabled: false, attrs, classList: { contains: (n) => n === "fi-select" },
    getAttribute(n) { return n in attrs ? attrs[n] : null; }, setAttribute(n, v) { attrs[n] = String(v); } };
}

describe("loadCashFlow renders the list", () => {
  it("into #cashflow-items with the response's window", async () => {
    const { c, els } = ctx({ replies: { "/api/cash-flow": flowReply } });
    await c.load();
    assert.match(els["cashflow-items"].innerHTML, /3 in the next 90 days/);
    assert.match(els["cashflow-items"].innerHTML, /Looks like a move between your own accounts/);
  });
  it("keeps focus on the select that was changed", async () => {
    const { c, els } = ctx({ replies: { "/api/cash-flow": flowReply } });
    c.document.activeElement = select({ source: "subscription", id: "11" });
    await c.load();
    assert.equal(els["cashflow-items"].focused, 'select[data-fi-source="subscription"][data-fi-id="11"]');
  });
});

describe("onForecastItemChange", () => {
  it("a transfer: PATCH …/forecast { treatment }, then the section and the summary reload", async () => {
    const { c, calls } = ctx({ replies: { "/api/recurring-transfers/2/forecast": { id: 2 }, "/api/cash-flow": flowReply } });
    const sel = select({ value: "internal" });
    const p = c.change(sel);
    assert.equal(sel.disabled, true, "disabled while saving");
    await p;
    assert.equal(sel.disabled, false);
    assert.equal(calls.fetch[0].url, "/api/recurring-transfers/2/forecast");
    assert.equal(calls.fetch[0].opts.method, "PATCH");
    assert.deepEqual(JSON.parse(calls.fetch[0].opts.body), { treatment: "internal" });
    assert.equal(calls.fetch[1].url, "/api/cash-flow?days=90");
    assert.equal(calls.summary, 1);
    assert.equal(sel.attrs["data-fi-prev"], "internal");
  });

  it("a subscription: { ignore } from the select", async () => {
    const { c, calls } = ctx({ replies: { "/api/subscriptions/": { id: 10 }, "/api/cash-flow": flowReply } });
    await c.change(select({ source: "subscription", id: "10", prev: "auto", value: "ignore" }));
    await c.change(select({ source: "subscription", id: "10", prev: "ignore", value: "auto" }));
    const patches = calls.fetch.filter((f) => f.opts && f.opts.method === "PATCH");
    assert.deepEqual(patches.map((f) => [f.url, JSON.parse(f.opts.body)]), [
      ["/api/subscriptions/10/forecast", { ignore: true }],
      ["/api/subscriptions/10/forecast", { ignore: false }],
    ]);
  });

  it("a refused save puts the select back and reloads nothing", async () => {
    const seen = [];
    const { c, calls } = ctx({ writeOk: async (r, what) => { seen.push(what); return false; } });
    const sel = select({ prev: "bill", value: "ignore" });
    await c.change(sel);
    assert.equal(sel.value, "bill");
    assert.equal(sel.attrs["data-fi-prev"], "bill");
    assert.equal(sel.disabled, false);
    assert.deepEqual(seen, ["Could not save the forecast setting"]);
    assert.equal(calls.fetch.length, 1);
    assert.equal(calls.summary, 0);
  });

  it("a network failure toasts and puts the select back", async () => {
    const { c, calls } = ctx({ throwOn: "/api/recurring-transfers" });
    const sel = select({ prev: "auto", value: "bill" });
    await c.change(sel);
    assert.equal(sel.value, "auto");
    assert.deepEqual(calls.msgs, [["Could not save the forecast setting: the server could not be reached.", false]]);
    assert.equal(calls.summary, 0);
  });

  it("the delegated listener handles only the list's selects", async () => {
    const { c, els, calls } = ctx({ replies: { "/api/recurring-transfers/2/forecast": { id: 2 }, "/api/cash-flow": flowReply } });
    c.wire();
    const fire = els["cashflow-items"].listeners.change;
    assert.equal(typeof fire, "function");
    fire({ target: { classList: { contains: () => false } } });
    fire({ target: null });
    assert.equal(calls.fetch.length, 0);
    fire({ target: select({ value: "auto" }) });
    await new Promise((r) => setImmediate(r));
    assert.equal(calls.fetch[0].url, "/api/recurring-transfers/2/forecast");
  });
});

describe("markup", () => {
  it("a collapsed 'What's in this forecast' inside the Cash Flow section, wired at load", () => {
    const sec = slice(dash, 'id="cashflow-section"', "<!-- Bill Calendar Quick View -->");
    assert.match(sec, /<details id="cashflow-items-wrap"[^>]*>\s*<summary[^>]*>What's in this forecast<\/summary>\s*<div id="cashflow-items"/);
    assert.doesNotMatch(sec, /<details id="cashflow-items-wrap"[^>]*\bopen\b/);
    assert.match(dash, /loadAdvice\(\);\n    wireForecastItems\(\);/);
  });
});
