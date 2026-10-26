// Design pass D2 (Perfin foundation) — `.cycle/plan-design-ux.md`:
// - buttons are sentence case (no uppercase transform) and a primary button is
//   filled gold with dark ink;
// - money colours (decision 11): a charge, a balance and a debt are the default
//   colour, money in is green (.amt-in), red (.amt-bad) only for something
//   wrong — an overdue rent item, a balance projected below $0, an overdrawn
//   cash account;
// - emptyState() (decision 12): every listed empty state offers its next step.
"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const ROOT = path.join(__dirname, "..");
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), "utf8");
function slice(src, start, end) {
  const i = src.indexOf(start);
  const j = src.indexOf(end, i + start.length);
  assert.ok(i >= 0 && j > i, "slice markers: " + start);
  return src.slice(i, j);
}

const shared = read("teller", "public", "perfin-shared.js");
const css = read("teller", "public", "perfin-shared.css");

function loadEmptyState(basePath, doc) {
  const ctx = { win: { BASE_PATH: basePath }, document: doc };
  vm.runInNewContext(
    slice(shared, "function esc(s)", "// --- API fetch with headers ---") +
      "\nthis.emptyState = emptyState; this.emptyStateClick = emptyStateClick;",
    ctx);
  return ctx;
}

describe("emptyState (perfin-shared.js)", () => {
  it("escapes the title, text and label", () => {
    const { emptyState } = loadEmptyState("", undefined);
    const html = emptyState({ title: "<b>x</b>", text: 'a "quote" & more', action: { label: "<i>Go</i>", click: "x\" onclick=\"y" } });
    assert.match(html, /<div class="empty-state-title">&lt;b&gt;x&lt;\/b&gt;<\/div>/);
    assert.match(html, /a &quot;quote&quot; &amp; more/);
    assert.match(html, />&lt;i&gt;Go&lt;\/i&gt;<\/button>/);
    assert.match(html, /data-empty-click="x&quot; onclick=&quot;y"/);
    assert.doesNotMatch(html, /<b>|<i>/);
  });

  it("an href action is a link through withBase", () => {
    const { emptyState } = loadEmptyState("/perfin", undefined);
    const html = emptyState({ title: "No insights yet", action: { label: "Generate in Settings", href: "/settings#ai-insights" } });
    assert.match(html, /<a class="btn btn-sm primary empty-state-action" href="\/perfin\/settings#ai-insights">Generate in Settings<\/a>/);
    const standalone = loadEmptyState("", undefined).emptyState({ action: { label: "Go", href: "/goals" } });
    assert.match(standalone, /href="\/goals"/);
  });

  it("only a same-app path becomes a link", () => {
    const { emptyState } = loadEmptyState("/perfin", undefined);
    for (const href of ["javascript:alert(1)", "//evil.example/x", "https://evil.example", "relative"]) {
      const html = emptyState({ title: "T", action: { label: "Go", href } });
      assert.doesNotMatch(html, /<a |<button/, href);
    }
  });

  it("no action renders no control", () => {
    const { emptyState } = loadEmptyState("", undefined);
    const html = emptyState({ title: "No budgets in effect for Dec 2026" });
    assert.equal(html, '<div class="empty-state"><div class="empty-state-title">No budgets in effect for Dec 2026</div></div>');
    assert.equal(emptyState({ title: "T", action: { href: "/x" } }).includes("<a"), false, "an action without a label is dropped");
  });

  it("a click action presses the page's existing button (no new write path)", () => {
    let clicked = 0;
    const target = { click: () => { clicked++; } };
    const doc = { getElementById: (id) => (id === "detect-btn" ? target : null) };
    const { emptyStateClick } = loadEmptyState("", doc);
    const btn = { getAttribute: () => "detect-btn" };
    assert.equal(emptyStateClick({ target: { closest: () => btn } }), true);
    assert.equal(clicked, 1);
    assert.equal(emptyStateClick({ target: { closest: () => null } }), false);
    assert.equal(emptyStateClick({ target: { closest: () => ({ getAttribute: () => "gone" }) } }), false);
    assert.equal(clicked, 1);
  });

  it("is exported and styled", () => {
    assert.match(shared, /win\.emptyState = emptyState;/);
    assert.match(shared, /document\.addEventListener\('click', emptyStateClick\);/);
    assert.match(css, /\.empty-state \{/);
  });
});

describe("each listed empty state offers its next step", () => {
  const dash = read("teller", "views", "dashboard.ejs");
  it("Upcoming Bills adds a bill through the Quick Add button", () => {
    assert.match(dash, /title: 'No upcoming bills this month',[\s\S]{0,160}action: \{ label: '\+ Add bill', click: 'quick-add-bill-btn' \}/);
    assert.doesNotMatch(dash, /body\.textContent = 'No upcoming bills this month\.'/);
  });
  it("AI Insights links to Settings' Generate (an anchor that exists)", () => {
    assert.match(dash, /action: \{ label: 'Generate in Settings', href: '\/settings#ai-insights' \}/);
    assert.doesNotMatch(dash, /generate from Settings\.'/);
    assert.match(read("teller", "views", "settings.ejs"), /<div class="section" id="ai-insights"><h2>AI Insights<\/h2>/);
  });
  it("Monthly Spend / Avg Daily say when they appear instead of a bare --", () => {
    const branch = slice(dash, "if (data.avg_months > 0) {", "} else {\n          monthBody");
    assert.match(branch, /getElementById\('avg-monthly'\)\.textContent = 'Not yet';/);
    assert.match(branch, /getElementById\('avg-monthly-sub'\)\.textContent = 'after your first full month';/);
    assert.match(branch, /getElementById\('avg-daily'\)\.textContent = 'Not yet';/);
    assert.doesNotMatch(branch, /no complete month yet/);
  });
  it("Goals, Budgets and Subscriptions press their existing add / detect buttons", () => {
    const goals = read("teller", "views", "goals.ejs");
    assert.match(goals, /action: \{ label: '\+ Add goal', click: 'toggle-form-btn' \}/);
    assert.match(goals, /id="toggle-form-btn"/);
    const budgets = read("teller", "views", "budgets.ejs");
    assert.match(budgets, /action: \{ label: '\+ Add budget', click: 'toggle-form-btn' \}/);
    assert.match(budgets, /id="toggle-form-btn"/);
    const subs = read("teller", "views", "subscriptions.ejs");
    assert.match(subs, /action: \{ label: 'Run detection', click: 'detect-btn' \}/);
    assert.match(subs, /id="detect-btn"/);
  });
});

describe("buttons: sentence case, filled primary", () => {
  function rule(sel) {
    const re = new RegExp("(^|\\n)" + sel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + " \\{([^}]*)\\}");
    const m = re.exec(css);
    assert.ok(m, "rule " + sel);
    return m[2];
  }
  it("no Perfin button rule transforms its label to uppercase", () => {
    for (const sel of [".btn", ".btn-sm", ".actions button, .actions select"]) {
      assert.doesNotMatch(rule(sel), /text-transform:\s*uppercase/, sel);
    }
    const acc = read("teller", "views", "accounts.ejs");
    assert.doesNotMatch(slice(acc, "    button { padding", "button:hover"), /uppercase/);
    const dash = read("teller", "views", "dashboard.ejs");
    assert.doesNotMatch(slice(dash, ".pyramid-switcher button {", "}"), /uppercase/, "the pyramid mode buttons");
    assert.doesNotMatch(slice(acc, ".btn-unlink {", ".btn-unlink:hover"), /uppercase/);
  });
  it("a primary button is filled gold with dark ink, in both themes", () => {
    for (const sel of [".btn.primary", ".btn-sm.primary", ".actions button.primary"]) {
      const r = rule(sel);
      assert.match(r, /background: var\(--warm\)/, sel);
      assert.match(r, /color: var\(--on-warm\)/, sel);
    }
    assert.equal((css.match(/--on-warm: #1a1206;/g) || []).length, 2, "--on-warm defined for both themes");
    assert.match(css, /\.btn:disabled, \.btn-sm:disabled, \.actions button:disabled \{ opacity: 0\.45; cursor: not-allowed; \}/);
  });
  it("no Perfin button label is written in Title Case or caps", () => {
    const PROPER = /^(Plaid|AI|Perfin|CSV|PDF|ZIP|Teller|Per-sistant|S&P|FIRE|APR|Sheets|Google)$/;
    const files = fs.readdirSync(path.join(ROOT, "teller", "views")).filter((f) => f.endsWith(".ejs"))
      .map((f) => ["teller/views/" + f, read("teller", "views", f)])
      .concat(fs.readdirSync(path.join(ROOT, "teller", "public")).filter((f) => f.endsWith(".js"))
        .map((f) => ["teller/public/" + f, read("teller", "public", f)]));
    const bad = [];
    for (const [f, src] of files) {
      for (const m of src.matchAll(/<button[^>]*>([^<]*)<\/button>/g)) {
        const words = m[1].replace(/'[^']*\+[^']*'/g, " ").replace(/&[a-z]+;/g, " ").split(/\s+/).filter(Boolean);
        const first = words.findIndex((w) => /^[A-Za-z]/.test(w));
        for (let i = first + 1; first >= 0 && i < words.length; i++) {
          const w = words[i];
          if (/^[A-Z][a-z]+$/.test(w) && !PROPER.test(w)) bad.push(f + ": " + m[1].trim());
          if (/^[A-Z]{4,}$/.test(w) && !PROPER.test(w)) bad.push(f + ": " + m[1].trim());
        }
      }
    }
    assert.deepEqual([...new Set(bad)], []);
  });
});

describe("money colours (decision 11)", () => {
  it("defines one pair of classes", () => {
    assert.match(css, /\n\.amt-in \{ color: var\(--green\); \}/);
    assert.match(css, /\n\.amt-bad \{ color: var\(--red\); \}/);
  });

  it("an Activity charge is the default colour; a credit is green and signed +", () => {
    const src = read("teller", "public", "transactions.js");
    const body = slice(src, "tbody.innerHTML = data.transactions.map(function(t) {", "}).join('');");
    const ctx = {
      esc: (s) => String(s == null ? "" : s),
      fmt: (n) => "$" + Number(n).toFixed(2),
      fmtDate: (d) => String(d),
    };
    vm.runInNewContext("this.row = function(t) {" + body.slice(body.indexOf("{") + 1) + "};", ctx);
    const charge = ctx.row({ transaction_id: "a", merchant: "Shop", date: "2026-10-01", amount: "12.50" });
    assert.match(charge, /<td class="amount" data-label="Amount">\$12\.50<\/td>/);
    const refund = ctx.row({ transaction_id: "b", merchant: "Shop", date: "2026-10-02", amount: "-12.50" });
    assert.match(refund, /<td class="amount amt-in" data-label="Amount">\+\$12\.50<\/td>/);
    assert.doesNotMatch(read("teller", "views", "transactions.ejs"), /\.amount\.debit|\.amount\.credit/);
  });

  it("the dashboard tables and cards carry no gold or red on plain money", () => {
    const dash = read("teller", "views", "dashboard.ejs");
    assert.doesNotMatch(dash, /class="amount (warm|teal)"/);
    for (const id of ["avg-monthly", "avg-daily", "subs-monthly", "net-balance"]) {
      assert.match(dash, new RegExp('<div class="value" id="' + id + '">'), id);
    }
    assert.doesNotMatch(dash, /class="value (warm|cost)"/);
    assert.doesNotMatch(dash, /color:var\(--(warm|red)\);">' \+ fmt\(/);
    assert.doesNotMatch(dash, /\.acct-balance\.(positive|negative|neutral)/);
    assert.match(dash, /'value' \+ \(netBalance < 0 \? ' amt-bad' : ''\)/);
  });

  it("an account card: a debt reads -$X owed in the default colour; only overdrawn cash is red", () => {
    const dash = read("teller", "views", "dashboard.ejs");
    assert.match(dash, /const balClass = hasBalances && !isDebt && displayBal < 0 \? 'amt-bad' : '';/);
    assert.match(dash, /fmt\(displayBal\) \+ \(isDebt && displayBal < 0 \? ' <span class="acct-owed">owed<\/span>' : ''\)/);
    const acc = read("teller", "views", "accounts.ejs");
    assert.match(acc, /\(!isDebt && bal < 0 \? ' class="amt-bad"' : ''\)/);
    assert.doesNotMatch(acc, /isDebt \? 'var\(--red\)'/);
  });

  it("cash flow: red only for a balance below $0", () => {
    const dash = read("teller", "views", "dashboard.ejs");
    const ctx = {};
    vm.runInNewContext(slice(dash, "function badIf(n)", "\n") + "\nthis.badIf = badIf;", ctx);
    assert.equal(ctx.badIf(-0.01), ' class="amt-bad"');
    assert.equal(ctx.badIf("-5"), ' class="amt-bad"');
    assert.equal(ctx.badIf(0), "");
    assert.equal(ctx.badIf(120), "");
  });

  it("the Calendar shows a bill as a neutral chip and income green", () => {
    const cal = read("teller", "views", "calendar.ejs");
    assert.match(cal, /\.cal-event\.bill \{ background: var\(--surface-2\); color: var\(--text\); \}/);
    assert.match(cal, /'<span class="amt-in">\+\$'/);
    assert.doesNotMatch(cal, /color:var\(--red\);">-\$/);
    assert.match(cal, /netEl\.className = 'value ' \+ \(data\.net >= 0 \? 'amt-in' : 'amt-bad'\);/);
  });

  it("the Rent page marks an unpaid item red only once it is overdue", () => {
    const hz = read("teller", "views", "housing.ejs");
    const ctx = {};
    vm.runInNewContext(slice(hz, "function isOverdue(o, today){", "\n    }\n") + "\n    }\nthis.isOverdue = isOverdue;", ctx);
    const today = "2026-10-26";
    assert.equal(ctx.isOverdue({ period: "2026-09", due_day: 1 }, today), true, "an earlier month");
    assert.equal(ctx.isOverdue({ period: "2026-10", due_day: 1 }, today), true, "past this month's due day");
    assert.equal(ctx.isOverdue({ period: "2026-10", due_day: 26 }, today), false, "due today");
    assert.equal(ctx.isOverdue({ period: "2026-10", due_day: 31 }, today), false);
    assert.equal(ctx.isOverdue({ period: "2026-11", due_day: 1 }, today), false, "next month");
    assert.equal(ctx.isOverdue({ period: "2026-10", due_day: null }, "2026-10-01"), false);
    assert.match(hz, /'<span class="hz-amt'\+\(isOverdue\(o, localTodayStr\(\)\) \? ' amt-bad' : ''\)\+'">'/);
  });
});
