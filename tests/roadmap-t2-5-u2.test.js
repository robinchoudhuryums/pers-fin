// ============================================================================
// Roadmap T2.5 U2 — the undelete UI.
//
// Run in a vm from the shipped sources:
//   - perfin-shared.js: restoreMessage / restoreTransaction (the restore POST,
//     writeOk on a refusal, the message per outcome) and showMsg's optional
//     action button (Undo);
//   - settings.ejs: Settings → Sync Health → Deleted transactions (snapshot and
//     legacy rows, escaping, labels, Show more's cursor, Restore removing the
//     row, a failed load);
//   - transactions.js: the Activity delete's toast offering Undo, which
//     restores and reloads the lists only on success.
// The browser half is e2e/pages.spec.js (a seeded deletion restored from
// Settings, the toast's Undo button).
// ============================================================================
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const read = (p) => fs.readFileSync(path.join(__dirname, "..", p), "utf8");
const esc = (s) => (s == null ? "" : String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;"));
const slice = (src, from, to) => {
  const a = src.indexOf(from);
  const b = src.indexOf(to, a + 1);
  assert.ok(a >= 0 && b > a, `markers ${from} … ${to}`);
  return src.slice(a, b);
};

const shared = read("teller/public/perfin-shared.js");

describe("restoreTransaction / restoreMessage (perfin-shared.js)", () => {
  function load(extra) {
    const ctx = { encodeURIComponent, ...extra };
    vm.runInNewContext(slice(shared, "var RESTORE_RETURNS_ON", "// Parse a money/number"), ctx);
    return ctx;
  }
  const reply = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body });

  it("names each outcome", () => {
    const { restoreMessage } = load({});
    assert.equal(restoreMessage({ restored: true, splits: 0 }), "Transaction restored.");
    assert.equal(restoreMessage({ restored: true, splits: 1 }), "Transaction restored with its 1 split.");
    assert.equal(restoreMessage({ restored: true, splits: 3 }), "Transaction restored with its 3 splits.");
    assert.equal(restoreMessage({ restored: true, already_present: true }), "That transaction is already in your list.");
    assert.match(restoreMessage({ restored: false, cleared: true, returns_on: "reconcile" }), /^Undeleted\. It comes back with the next sync of its bank — Settings → Sync Health → Reconcile Now/);
    assert.equal(restoreMessage({ restored: false, cleared: true, returns_on: "csv_reimport" }), "Undeleted. Import its CSV file again to bring it back.");
    assert.match(restoreMessage(null), /^Undeleted\. /);
  });

  it("POSTs the restore, toasts the outcome and resolves to the reply", async () => {
    const calls = [], msgs = [];
    const ui = load({
      apiFetch: async (url, opts) => { calls.push([url, opts.method]); return reply(200, { restored: true, splits: 2 }); },
      writeOk: async (r) => r.ok,
      showMsg: (t, ok) => msgs.push([t, ok]),
    });
    const r = await ui.restoreTransaction("csv_a/b");
    assert.deepEqual(calls, [["/api/deleted-transactions/csv_a%2Fb/restore", "POST"]]);
    assert.deepEqual(r, { restored: true, splits: 2 });
    assert.deepEqual(msgs, [["Transaction restored with its 2 splits.", true]]);
  });

  it("a refusal goes through writeOk and resolves null; a network failure is toasted", async () => {
    const seen = [], msgs = [];
    const ui = load({
      apiFetch: async () => reply(409, { error: "Its account is no longer connected, so it can't be restored." }),
      writeOk: async (r, what) => { seen.push([r.status, what]); return false; },
      showMsg: (t, ok) => msgs.push([t, ok]),
    });
    assert.equal(await ui.restoreTransaction("x"), null);
    assert.deepEqual(seen, [[409, "Restore"]]);
    assert.deepEqual(msgs, []);
    const ui2 = load({ apiFetch: async () => { throw new Error("offline"); }, writeOk: async () => true, showMsg: (t, ok) => msgs.push([t, ok]) });
    assert.equal(await ui2.restoreTransaction("x"), null);
    assert.deepEqual(msgs, [["Couldn't restore the transaction — check your connection.", false]]);
  });

  it("is exported on window", () => {
    assert.match(shared, /win\.restoreTransaction = restoreTransaction;/);
    assert.match(shared, /win\.restoreMessage = restoreMessage;/);
  });
});

describe("showMsg's action button (perfin-shared.js)", () => {
  // A small DOM: enough for the toast stack.
  function makeDom() {
    const timers = [];
    function node(tag) {
      const n = {
        tagName: tag, children: [], parentNode: null, listeners: {}, attrs: {}, _text: undefined, className: "",
        classList: { _s: new Set(), add(c) { this._s.add(c); }, contains(c) { return this._s.has(c); } },
        get lastElementChild() { return this.children[this.children.length - 1] || null; },
        get textContent() { return this._tc != null ? this._tc : this.children.map((c) => c.textContent).join(""); },
        set textContent(v) { this._tc = v; this.children = []; },
        setAttribute(k, v) { this.attrs[k] = v; },
        appendChild(c) { c.parentNode = this; this.children.push(c); return c; },
        removeChild(c) { this.children = this.children.filter((x) => x !== c); c.parentNode = null; },
        addEventListener(ev, fn) { (this.listeners[ev] = this.listeners[ev] || []).push(fn); },
        fire(ev) { let stopped = false; const e = { stopPropagation() { stopped = true; } }; (this.listeners[ev] || []).forEach((f) => f(e)); if (!stopped && this.parentNode && this.parentNode.fire) this.parentNode.fire(ev); },
      };
      return n;
    }
    const body = node("body");
    const document = {
      body,
      createElement: node,
      getElementById: (id) => body.children.find((c) => c.id === id) || null,
    };
    return { document, body, timers, setTimeout: (fn, ms) => { timers.push(ms); return timers.length; }, clearTimeout: () => {} };
  }
  function load() {
    const dom = makeDom();
    const ctx = { document: dom.document, setTimeout: dom.setTimeout, clearTimeout: dom.clearTimeout };
    vm.runInNewContext(slice(shared, "function removeToast", "// --- Button loading state ---"), ctx);
    return { ...ctx, dom };
  }

  it("adds a labelled button that closes the toast and runs the action once", () => {
    const ui = load();
    let ran = 0;
    ui.showMsg("Transaction deleted.", true, { action: { label: "Undo", run: () => { ran++; } } });
    const stack = ui.dom.document.getElementById("toast-stack");
    const toast = stack.children[0];
    assert.equal(toast.children[0].textContent, "Transaction deleted.");
    const btn = toast.children[1];
    assert.equal(btn.tagName, "button");
    assert.equal(btn.type, "button");
    assert.equal(btn.textContent, "Undo");
    assert.equal(btn.className, "toast-action");
    assert.deepEqual(ui.dom.timers, [10000], "a toast with an action stays 10 s");
    btn.fire("click");
    assert.equal(ran, 1);
    assert.ok(toast.classList.contains("toast-leaving"));
    assert.deepEqual(ui.dom.timers, [10000, 220], "the press stays on the button — the toast's own click handler doesn't run too");
  });

  it("an action toast is never merged into an earlier one with the same text", () => {
    const ui = load();
    const runs = [];
    ui.showMsg("Transaction deleted.", true, { action: { label: "Undo", run: () => runs.push("a") } });
    ui.showMsg("Transaction deleted.", true, { action: { label: "Undo", run: () => runs.push("b") } });
    const stack = ui.dom.document.getElementById("toast-stack");
    assert.equal(stack.children.length, 2);
    stack.children[1].children[1].fire("click");
    assert.deepEqual(runs, ["b"]);
  });

  it("plain toasts keep their behaviour: text only, 5 s, identical ones merged", () => {
    const ui = load();
    ui.showMsg("Saved.", true);
    ui.showMsg("Saved.", true);
    const stack = ui.dom.document.getElementById("toast-stack");
    assert.equal(stack.children.length, 1);
    assert.equal(stack.children[0].textContent, "Saved.");
    assert.equal(stack.children[0].children.length, 0);
    assert.deepEqual(ui.dom.timers, [5000, 5000]);
    ui.showMsg("Nope.", false, { action: { label: "x" } }); // no run → no button
    assert.equal(stack.children[1].children.length, 0);
  });

  it("the button has a style and the 40px touch target", () => {
    const css = read("teller/public/perfin-shared.css");
    assert.match(css, /\.toast-action \{/);
    assert.doesNotMatch(css.slice(css.indexOf(".toast-action {")), /^[^}]*min-height/);
  });
});

describe("Settings → Sync Health → Deleted transactions (settings.ejs)", () => {
  const src = read("teller/views/settings.ejs");

  function load(api, extra = {}) {
    let handler = null;
    const els = {
      "deleted-transactions-body": { textContent: "Loading…", innerHTML: "", addEventListener: (_, fn) => { handler = fn; } },
      "deleted-transactions-count": { textContent: "" },
    };
    const calls = [], msgs = [], restored = [];
    const ctx = {
      esc, isFinite, Number, String, Date, encodeURIComponent,
      fmt: (n) => "$" + Number(n).toFixed(2),
      fmtDate: (d) => "D(" + d + ")",
      document: { getElementById: (id) => els[id] || null },
      apiFetch: async (url) => { calls.push(url); return api(url); },
      writeOk: async (r) => r.ok,
      showMsg: (t, ok) => msgs.push([t, ok]),
      restoreTransaction: async (id) => { restored.push(id); return extra.restoreResult === undefined ? { restored: true } : extra.restoreResult; },
    };
    vm.runInNewContext(slice(src, "var deletedItems = [];", "async function loadOperatorChecks(refresh)"), ctx);
    const click = async (attr, value) => {
      const btn = { disabled: false, getAttribute: () => value };
      await handler({ target: { closest: (sel) => (sel === `[${attr}]` ? btn : null) } });
      return btn;
    };
    return { ctx, els, calls, msgs, restored, click };
  }
  const ok = (body) => ({ ok: true, status: 200, json: async () => body });

  const snap = { transaction_id: "csv_1", deleted_at: "2026-10-20T12:00:00Z", source: "csv", legacy: false, restorable: true,
    date: "2026-10-01", merchant: "Shop <&> \"Co\"", amount: "9.99", account_name: "E2E Card", splits_count: 2 };
  const credit = { ...snap, transaction_id: "csv_2", merchant: "Refund", amount: "-16.00", splits_count: 0, account_name: null };
  const legacy = { transaction_id: "txn_old", deleted_at: "2026-09-01T00:00:00Z", source: "teller", legacy: true, restorable: true };
  const manual = { transaction_id: "manual_9", deleted_at: "2026-09-02T00:00:00Z", source: "manual", legacy: true, restorable: false };

  it("the section sits in Sync Health, collapsible, and loads with the page", () => {
    const sh = src.slice(src.indexOf('id="sync-health"'), src.indexOf("Google Sheets Auto-Sync"));
    assert.match(sh, /<details id="deleted-transactions"[^>]*>\s*<summary class="name">Deleted transactions <span id="deleted-transactions-count"><\/span><\/summary>/);
    assert.match(sh, /<div id="deleted-transactions-body"[^>]*>Loading…<\/div>/);
    assert.match(src, /loadRecentErrors\(\); loadDeletedTransactions\(false\); loadCashFloors\(\);/);
  });

  it("renders snapshot rows escaped and labelled, a credit as -$X, legacy rows by id, and the count", async () => {
    const t = load(() => ok({ items: [snap, credit, legacy, manual], next: null }));
    await t.ctx.loadDeletedTransactions(false);
    assert.deepEqual(t.calls, ["/api/deleted-transactions?limit=50"]);
    const html = t.els["deleted-transactions-body"].innerHTML;
    assert.match(html, /D\(2026-10-01\) · <strong>Shop &lt;&amp;&gt; &quot;Co&quot;<\/strong> · \$9\.99 · E2E Card · 2 splits/);
    assert.match(html, /<button class="btn" data-restore-deleted="csv_1" aria-label="Restore Shop &lt;&amp;&gt; &quot;Co&quot; on D\(2026-10-01\)"/);
    assert.match(html, /<strong>Refund<\/strong> · -\$16\.00<div/);
    assert.match(html, /txn_old<\/span> — id only, deleted before undelete existed/);
    assert.match(html, /data-restore-deleted="txn_old" aria-label="Restore txn_old"/);
    assert.doesNotMatch(html, /data-restore-deleted="manual_9"/);
    assert.match(html, /A manual entry deleted before undelete existed — it can't be restored\./);
    assert.doesNotMatch(html, /data-deleted-more/);
    assert.equal(t.els["deleted-transactions-count"].textContent, "(4)");
  });

  it("an empty list says so", async () => {
    const t = load(() => ok({ items: [], next: null }));
    await t.ctx.loadDeletedTransactions(false);
    assert.equal(t.els["deleted-transactions-body"].textContent, "No deleted transactions.");
    assert.equal(t.els["deleted-transactions-count"].textContent, "");
  });

  it("Show more follows the cursor and appends", async () => {
    const pages = [
      ok({ items: [snap], next: "2026-10-20T12:00:00.000000Z|csv_1" }),
      ok({ items: [legacy], next: null }),
    ];
    const t = load(() => pages.shift());
    await t.ctx.loadDeletedTransactions(false);
    assert.match(t.els["deleted-transactions-body"].innerHTML, /<button class="btn" data-deleted-more>Show more<\/button>/);
    assert.equal(t.els["deleted-transactions-count"].textContent, "(1+)");
    const more = await t.click("data-deleted-more");
    assert.equal(more.disabled, true);
    assert.equal(t.calls[1], "/api/deleted-transactions?limit=50&before=" + encodeURIComponent("2026-10-20T12:00:00.000000Z|csv_1"));
    const html = t.els["deleted-transactions-body"].innerHTML;
    assert.ok(html.indexOf("csv_1") < html.indexOf("txn_old"), "the next page appends");
    assert.doesNotMatch(html, /data-deleted-more/);
    assert.equal(t.els["deleted-transactions-count"].textContent, "(2)");
  });

  it("Restore calls restoreTransaction and drops the row; a refusal keeps it and re-enables the button", async () => {
    const t = load(() => ok({ items: [snap, legacy], next: null }));
    await t.ctx.loadDeletedTransactions(false);
    const b = await t.click("data-restore-deleted", "csv_1");
    assert.deepEqual(t.restored, ["csv_1"]);
    assert.equal(b.disabled, true);
    assert.doesNotMatch(t.els["deleted-transactions-body"].innerHTML, /csv_1/);
    assert.equal(t.els["deleted-transactions-count"].textContent, "(1)");

    const r = load(() => ok({ items: [snap], next: null }), { restoreResult: null });
    await r.ctx.loadDeletedTransactions(false);
    const b2 = await r.click("data-restore-deleted", "csv_1");
    assert.equal(b2.disabled, false);
    assert.match(r.els["deleted-transactions-body"].innerHTML, /csv_1/);
  });

  it("a failed load shows Unavailable; a failed Show more is toasted and keeps the list", async () => {
    const t = load(() => ({ ok: false, status: 500, json: async () => ({ error: "x" }) }));
    await t.ctx.loadDeletedTransactions(false);
    assert.equal(t.els["deleted-transactions-body"].textContent, "Unavailable");
    const t2 = load(() => { throw new Error("offline"); });
    await t2.ctx.loadDeletedTransactions(false);
    assert.equal(t2.els["deleted-transactions-body"].textContent, "Unavailable");

    const pages = [ok({ items: [snap], next: "c" }), null];
    const t3 = load(() => { const p = pages.shift(); if (!p) throw new Error("offline"); return p; });
    await t3.ctx.loadDeletedTransactions(false);
    await t3.ctx.loadDeletedTransactions(true);
    assert.deepEqual(t3.msgs, [["Couldn't load more deleted transactions — check your connection.", false]]);
    assert.match(t3.els["deleted-transactions-body"].innerHTML, /csv_1/);
  });
});

describe("Activity page delete → Undo (transactions.js)", () => {
  const src = read("teller/public/transactions.js");
  function load(deleteOk, restoreResult) {
    const calls = [], msgs = [], reloads = [], restored = [];
    const ctx = {
      encodeURIComponent,
      confirm: () => true,
      currentOffset: 100,
      apiFetch: async (url, opts) => { calls.push([url, opts.method]); return { ok: deleteOk, status: deleteOk ? 200 : 404 }; },
      writeOk: async (r, what) => { if (!r.ok) msgs.push([what + ": failed", false]); return r.ok; },
      showMsg: (t, ok, opts) => msgs.push([t, ok, opts]),
      loadDuplicates: () => reloads.push("dups"),
      searchTransactions: (off) => reloads.push("search:" + off),
      restoreTransaction: async (id) => { restored.push(id); return restoreResult; },
    };
    vm.runInNewContext(slice(src, "function reloadAfterDelete()", "// Event bindings"), ctx);
    return { ctx, calls, msgs, reloads, restored };
  }

  it("a delete toasts with an Undo that restores and reloads the lists", async () => {
    const t = load(true, { restored: true });
    await t.ctx.deleteDuplicate("txn_1");
    assert.deepEqual(t.calls, [["/api/transactions/txn_1", "DELETE"]]);
    const [text, ok, opts] = t.msgs[0];
    assert.equal(text, "Transaction deleted.");
    assert.equal(ok, true);
    assert.equal(opts.action.label, "Undo");
    assert.deepEqual(t.reloads, ["dups", "search:100"]);
    await opts.action.run();
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(t.restored, ["txn_1"]);
    assert.deepEqual(t.reloads, ["dups", "search:100", "dups", "search:100"]);
  });

  it("a failed Undo doesn't reload (restoreTransaction already toasted)", async () => {
    const t = load(true, null);
    await t.ctx.deleteDuplicate("txn_1");
    await t.msgs[0][2].action.run();
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(t.restored, ["txn_1"]);
    assert.deepEqual(t.reloads, ["dups", "search:100"]);
  });

  it("a refused delete is reported through writeOk with no Undo", async () => {
    const t = load(false, null);
    await t.ctx.deleteDuplicate("txn_1");
    assert.deepEqual(t.msgs, [["Delete: failed", false]]);
    assert.deepEqual(t.reloads, []);
  });

  it("the delete buttons stay out of the e2e sweep", () => {
    assert.equal((src.match(/data-action="delete-dup" data-e2e-skip/g) || []).length, 2);
  });
});

describe("e2e seed", () => {
  it("deletes one seeded transaction through the route", () => {
    const seed = read("e2e/seed.js");
    assert.match(seed, /E2E DELETED SHOP,9\.99/);
    assert.match(seed, /call\(req, "delete", `\/perfin\/api\/transactions\/\$\{encodeURIComponent\(deleted\.transaction_id \|\| deleted\.id\)\}`/);
    assert.match(read("e2e/pages.spec.js"), /Restore brings it back \(T2\.5 U2\)/);
  });
});
