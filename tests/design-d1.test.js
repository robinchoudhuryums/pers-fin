// Design pass D1 (Perfin half) — `.cycle/plan-design-ux.md`:
// - the dashboard's Review Uncategorized widget shows a calendar date (it showed
//   "2026-10-24T00:00:00.000Z"), starts a row without a suggestion on "Choose a
//   category" with Apply disabled, and ticks "Remember" only for a suggestion;
// - fmt() writes a negative as "-$24.29" (it wrote "$-24.29"), and the two
//   hand-built money strings that could go negative follow it;
// - the top nav is the same width on every page: the container is one width and
//   a page narrows its content through #main-content.
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
const sharedCtx = {};
vm.runInNewContext(
  slice(shared, "function fmt(n) {", "// TODAY as 'YYYY-MM-DD'") + "\nthis.fmt = fmt; this.fmtDate = fmtDate;",
  sharedCtx);
const escCtx = {};
vm.runInNewContext(slice(shared, "function esc(s)", "// --- Prefix helper") + "this.esc = esc;", escCtx);

describe("fmt (perfin-shared.js)", () => {
  const { fmt } = sharedCtx;
  it("writes a negative as -$X with thousands separators", () => {
    assert.equal(fmt(-0.5), "-$0.50");
    assert.equal(fmt(-1234.5), "-$1,234.50");
    assert.equal(fmt("-24.29"), "-$24.29");
  });
  it("leaves positives, zero and blanks as before", () => {
    assert.equal(fmt(1234.567), "$1,234.57");
    assert.equal(fmt(0), "$0.00");
    assert.equal(fmt(null), "$0.00");
    assert.equal(fmt(undefined), "$0.00");
  });
  it("never prints -$0.00 for a value that rounds to zero", () => {
    assert.equal(fmt(-0.001), "$0.00");
    assert.equal(fmt(-0.004), "$0.00");
  });
});

describe("hand-built money strings that can go negative", () => {
  it("the investment return goes through fmt with an explicit sign", () => {
    const dash = read("teller", "views", "dashboard.ejs");
    assert.match(dash, /retEl\.textContent = sign \+ fmt\(data\.total_return\) \+ pctTxt \+/);
    assert.doesNotMatch(dash, /'\$' \+ sign \+ data\.total_return/);
  });
  it("the Goals page's FIRE money formatter writes -$X", () => {
    const goals = read("teller", "views", "goals.ejs");
    const ctx = {};
    vm.runInNewContext(slice(goals, "function fmtMoney(n)", "function fmtMonths(m)") + "this.fmtMoney = fmtMoney;", ctx);
    assert.equal(ctx.fmtMoney(-1234.4), "-$1,234");
    assert.equal(ctx.fmtMoney(98765.6), "$98,766");
    assert.equal(ctx.fmtMoney(-0.2), "$0");
  });
});

describe("dashboard Review Uncategorized widget", () => {
  const dash = read("teller", "views", "dashboard.ejs");
  const code = slice(dash, "var REVIEW_CATEGORIES = [", "onDelegate('review-queue-list', 'click'");

  function load() {
    const els = {};
    const handlers = [];
    const buttons = {};
    const document = {
      getElementById: (id) => (els[id] = els[id] || { style: {}, innerHTML: "", textContent: "" }),
      querySelector: (sel) => {
        const m = /data-cat-apply="([^"]+)"/.exec(sel);
        return m ? (buttons[m[1]] = buttons[m[1]] || { disabled: true }) : null;
      },
    };
    const ctx = {
      document,
      apiFetch: async () => ({ ok: false }),
      fmt: sharedCtx.fmt,
      fmtDate: sharedCtx.fmtDate,
      esc: escCtx.esc,
      onDelegate: (parent, event, selector, fn) => handlers.push({ parent, event, selector, fn }),
    };
    vm.runInNewContext(code + "\nthis.renderReviewQueue = renderReviewQueue;", ctx);
    return { ctx, els, handlers, buttons };
  }

  it("shows a calendar date, never the raw timestamp, west of UTC", () => {
    const prev = process.env.TZ;
    process.env.TZ = "America/Los_Angeles";
    try {
      const { ctx, els } = load();
      ctx.renderReviewQueue([{ transaction_id: "t1", merchant: "CITY PHARMACY", date: "2026-10-24T00:00:00.000Z", amount: 42.1 }]);
      const html = els["review-queue-list"].innerHTML;
      assert.match(html, /Oct 24 &middot; \$42\.10/);
      assert.doesNotMatch(html, /T00:00:00|2026-10-24/);
    } finally {
      if (prev === undefined) delete process.env.TZ; else process.env.TZ = prev;
    }
  });

  it("a row without a suggestion starts on Choose a category, Apply disabled, Remember unticked", () => {
    const { ctx, els } = load();
    ctx.renderReviewQueue([{ transaction_id: "t1", merchant: "CITY PHARMACY", date: "2026-10-23", amount: 42.1 }]);
    const html = els["review-queue-list"].innerHTML;
    assert.match(html, /<option value="" selected disabled>Choose a category<\/option>/);
    assert.doesNotMatch(html, /value="Food &amp; Drink" selected/);
    assert.match(html, /<input type="checkbox" data-cat-rule="t1">/, "Remember unticked");
    assert.match(html, /<button data-cat-apply="t1" disabled class="btn-sm primary">/);
  });

  it("a row with a suggestion selects it, ticks Remember and enables Apply", () => {
    const { ctx, els } = load();
    ctx.renderReviewQueue([{ transaction_id: "t2", merchant: "Corner Cafe", date: "2026-10-24", amount: 12.5, suggested_category: "Groceries" }]);
    const html = els["review-queue-list"].innerHTML;
    assert.match(html, /<option value="Groceries" selected>Groceries<\/option>/);
    assert.doesNotMatch(html, /Choose a category/);
    assert.match(html, /<input type="checkbox" data-cat-rule="t2" checked>/);
    assert.match(html, /<button data-cat-apply="t2" class="btn-sm primary">/);
  });

  it("a suggestion outside the list is offered rather than dropped", () => {
    const { ctx, els } = load();
    ctx.renderReviewQueue([{ transaction_id: "t3", merchant: "X", date: "2026-10-24", amount: 1, suggested_category: "Pets" }]);
    const html = els["review-queue-list"].innerHTML;
    assert.match(html, /<option value="Pets" selected>Pets<\/option>/);
    assert.equal((html.match(/value="Pets"/g) || []).length, 1);
  });

  it("choosing a category enables that row's Apply; clearing disables it", () => {
    const { handlers, buttons } = load();
    const change = handlers.find((h) => h.event === "change");
    assert.ok(change, "a change handler on the list");
    assert.equal(change.parent, "review-queue-list");
    assert.equal(change.selector, "[data-cat-select]");
    const sel = { value: "Groceries", getAttribute: () => "t1" };
    change.fn.call(sel);
    assert.equal(buttons.t1.disabled, false);
    change.fn.call({ value: "", getAttribute: () => "t1" });
    assert.equal(buttons.t1.disabled, true);
  });

  it("a disabled Apply looks disabled (the shared button class, design D2)", () => {
    const css = read("teller", "public", "perfin-shared.css");
    assert.match(css, /\.btn:disabled, \.btn-sm:disabled, \.actions button:disabled \{ opacity: 0\.45; cursor: not-allowed; \}/);
  });

  it("Apply does nothing without a chosen category", () => {
    const apply = slice(dash, "onDelegate('review-queue-list', 'click'", "// AI Memory widget");
    assert.match(apply, /if \(!sel \|\| !sel\.value\) return;/);
  });
});

describe("the nav is the same width on every page", () => {
  const css = read("teller", "public", "perfin-shared.css");
  it("the container is one width and pages narrow #main-content", () => {
    assert.match(css, /\.container \{ max-width: 1060px; margin: 0 auto;/);
    assert.match(css, /#main-content \{ display: block; max-width: 960px; margin: 0 auto; \}/);
  });
  it("no page view with the nav sets its own .container width", () => {
    const dir = path.join(ROOT, "teller", "views");
    const views = fs.readdirSync(dir).filter((f) => f.endsWith(".ejs"));
    let withNav = 0;
    for (const f of views) {
      const src = fs.readFileSync(path.join(dir, f), "utf8");
      if (!src.includes("partials/nav")) continue;
      withNav++;
      assert.doesNotMatch(src, /\.container\s*\{[^}]*max-width/, f + " sets a .container width");
    }
    assert.ok(withNav >= 11, "checked " + withNav + " views");
  });
  it("the narrow pages keep their content width on #main-content", () => {
    for (const [f, w] of [["budgets.ejs", 720], ["goals.ejs", 720], ["accounts.ejs", 640], ["tax.ejs", 820], ["settings.ejs", 860]]) {
      assert.match(read("teller", "views", f), new RegExp("#main-content \\{ max-width: " + w + "px; \\}"), f);
    }
  });
  it("the nav renders inside the container, before <main>", () => {
    const nav = read("teller", "views", "partials", "nav.ejs");
    assert.ok(nav.indexOf('<nav class="topnav"') < nav.indexOf('<main id="main-content">'));
    assert.match(read("teller", "views", "partials", "head.ejs"), /<div class="container">/);
  });
});
