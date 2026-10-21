// ============================================================================
// Cycle-7 expansion Batch 20 (ST3) — one "busy while pending" helper
// ============================================================================
// withPending(btn, key, fn, busyText) in the shared client bundle (views/js.js)
// is guardPending + disabled + aria-busy (+ an optional busy label), restored in
// a finally. It is run here in a vm from the EMITTED bundle. A guard scans every
// client module for a hand-rolled pending toggle (re-enabling a button with
// `.disabled = false`, or setting aria-busy) so new ones go through the helper;
// pre-existing offenders would sit in KNOWN_GAPS, which only shrinks.
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const JS = require("../views/js");
const ROOT = path.join(__dirname, "..");
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), "utf8");

function loadHelpers() {
  const start = JS.indexOf("var _pending = {};");
  const end = JS.indexOf("function showUndo(");
  assert.ok(start >= 0 && end > start);
  const ctx = {};
  vm.runInNewContext(JS.slice(start, end) + ";this.withPending=withPending;", ctx);
  return ctx.withPending;
}
function fakeButton(text) {
  const attrs = {};
  return {
    tagName: "BUTTON", textContent: text, disabled: false,
    setAttribute(k, v) { attrs[k] = String(v); },
    removeAttribute(k) { delete attrs[k]; },
    getAttribute(k) { return k in attrs ? attrs[k] : null; },
  };
}

describe("ST3 — withPending", () => {
  it("disables the button, marks it aria-busy and relabels it while the action runs, then restores it", async () => {
    const withPending = loadHelpers();
    const btn = fakeButton("AI Draft");
    let release;
    const run = withPending(btn, "draft", () => new Promise((r) => { release = r; }), "Drafting...");
    assert.equal(btn.disabled, true);
    assert.equal(btn.getAttribute("aria-busy"), "true");
    assert.equal(btn.textContent, "Drafting...");
    release("done");
    assert.equal(await run, "done");
    assert.equal(btn.disabled, false);
    assert.equal(btn.getAttribute("aria-busy"), null);
    assert.equal(btn.textContent, "AI Draft");
  });

  it("is single-flight per key: a second call while one runs does nothing and returns undefined", async () => {
    const withPending = loadHelpers();
    const btn = fakeButton("Send");
    let release, calls = 0;
    const first = withPending(btn, "send", () => { calls++; return new Promise((r) => { release = r; }); });
    assert.equal(await withPending(btn, "send", async () => { calls++; return "second"; }), undefined);
    release("ok");
    await first;
    assert.equal(calls, 1);
    assert.equal(await withPending(btn, "send", async () => "again"), "again", "free again after the run");
  });

  it("restores the button when the action throws", async () => {
    const withPending = loadHelpers();
    const btn = fakeButton("Capture");
    await assert.rejects(withPending(btn, "capture", async () => { throw new Error("boom"); }, "Saving…"), /boom/);
    assert.equal(btn.disabled, false);
    assert.equal(btn.getAttribute("aria-busy"), null);
    assert.equal(btn.textContent, "Capture");
  });

  it("takes a list of buttons or none, and keeps a button that was already disabled disabled", async () => {
    const withPending = loadHelpers();
    const a = fakeButton("Formal"), b = fakeButton("Casual");
    b.disabled = true;
    await withPending([a, b], "tone", async () => {
      assert.equal(a.disabled, true);
      assert.equal(b.disabled, true);
    });
    assert.equal(a.disabled, false);
    assert.equal(b.disabled, true, "restored to its own prior state");
    assert.equal(await withPending(null, "none", async () => 7), 7);
  });
});

// ---------------------------------------------------------------------------
// Guard: no hand-rolled pending toggle in client code. Re-enabling a button by
// hand (`.disabled = false`) or setting aria-busy outside withPending is the
// pattern ST3 folded into the helper. A file listed here may keep exactly that
// many offenders (with the reason); a new one, or a stale count, fails.
// ---------------------------------------------------------------------------
const KNOWN_GAPS = {};

function clientFiles() {
  const out = [];
  for (const dir of ["pages", "views"]) {
    for (const f of fs.readdirSync(path.join(ROOT, dir)).filter((x) => x.endsWith(".js"))) out.push(dir + "/" + f);
  }
  return out;
}
function offenders(rel) {
  let src = read(rel);
  if (rel === "views/js.js") {
    // The helper itself is the one place allowed to restore disabled / aria-busy.
    const start = src.indexOf("// ST3: the ONE");
    const end = src.indexOf("function showUndo(");
    assert.ok(start >= 0 && end > start && src.indexOf("async function withPending(") > start, "withPending present in views/js.js");
    src = src.slice(0, start) + src.slice(end);
  }
  const hits = src.match(/\.disabled\s*=\s*false|aria-busy/g) || [];
  return hits.length;
}

describe("ST3 — no hand-rolled pending toggles", () => {
  it("every client module re-enables buttons only through withPending", () => {
    const seen = {};
    for (const rel of clientFiles()) {
      const n = offenders(rel);
      if (n) seen[rel] = n;
    }
    for (const [rel, n] of Object.entries(seen)) {
      const gap = KNOWN_GAPS[rel];
      assert.ok(gap, `${rel}: ${n} hand-rolled pending toggle(s) — use withPending(btn, key, fn, busyText)`);
      assert.ok(n <= gap.count, `${rel}: ${n} toggles, KNOWN_GAPS allows ${gap.count}`);
    }
    for (const [rel, gap] of Object.entries(KNOWN_GAPS)) {
      assert.equal(seen[rel] || 0, gap.count, `${rel}: KNOWN_GAPS entry is stale — lower or remove it`);
    }
  });

  it("the migrated actions use the helper (send, AI draft / tone / breakdown / parse / tags, capture, reindex, Job Radar refresh, Ask)", () => {
    const want = [
      ["pages/emails.js", ["'send-now'", "'ai-draft'", "'adjust-tone'"]],
      ["pages/todos-script-2.js", ["'ai-breakdown'", "'parse-todo'"]],
      ["pages/notes.js", ["'suggest-tags'"]],
      ["pages/knowledge.js", ["'reindex'", "'capture'"]],
      ["pages/jobs.js", ["'jobs-refresh'"]],
      ["views/js.js", ["'ask'"]],
    ];
    for (const [rel, keys] of want) {
      const src = read(rel);
      for (const k of keys) assert.match(src, new RegExp("withPending\\([^;]*?" + k.replace(/'/g, "'")), `${rel} ${k}`);
    }
  });

  it("the emitted shared bundle still parses", () => {
    assert.doesNotThrow(() => new vm.Script(JS));
  });
});
