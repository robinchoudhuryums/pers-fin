// Design pass D6 — Per-sistant alignment (`.cycle/plan-design-ux.md`, decisions 10 and 12).
// - emptyState (views/primitives.js) run in a vm from the EMITTED bundle: escaping, an
//   href joined with BASE_PATH (a same-app path only), the { click } action pressing the
//   page's existing button, no control without an action;
// - each listed empty state uses it with a next step whose button exists on the page;
// - buttons: sentence case in the UI font (no uppercase, no monospace), .primary filled,
//   .danger outlined, and no button label written in Title Case.
// The shared token values are checked by the root tests/design-tokens.test.js.
"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const APP = path.join(__dirname, "..");
const read = (...p) => fs.readFileSync(path.join(APP, ...p), "utf8");
const emitted = (rel) => require(path.join(APP, rel));

// The primitives bundle in a vm with a tiny document: returns its window.
function primitives(basePath) {
  const listeners = {};
  const byId = {};
  const document = {
    addEventListener: (ev, fn) => { (listeners[ev] = listeners[ev] || []).push(fn); },
    querySelectorAll: () => [],
    getElementById: (id) => byId[id] || null,
  };
  const window = { BASE_PATH: basePath || "" };
  vm.runInNewContext(emitted("views/primitives.js"), { window, document, String, Math, Number });
  return { window, document, listeners, byId };
}

describe("emptyState (decision 12)", () => {
  it("is exported on window and PsPrimitives, and the bundle parses", () => {
    assert.doesNotThrow(() => new vm.Script(emitted("views/primitives.js")));
    const { window } = primitives();
    assert.equal(typeof window.emptyState, "function");
    assert.equal(window.PsPrimitives.emptyState, window.emptyState);
  });

  it("renders a title, a line and a link through BASE_PATH, all escaped", () => {
    const { window } = primitives("/per-sistant");
    const html = window.emptyState({ title: 'No <b>"notes"</b>', text: "Tom & Jerry's", action: { label: "+ New <note>", href: "/notes?x=1&y=2" } });
    assert.equal(html,
      '<div class="empty-state"><div class="empty-state-title">No &lt;b&gt;&quot;notes&quot;&lt;/b&gt;</div>' +
      '<div class="empty-state-text">Tom &amp; Jerry&#39;s</div>' +
      '<div class="empty-state-action"><a class="btn primary" href="/per-sistant/notes?x=1&amp;y=2">+ New &lt;note&gt;</a></div></div>');
  });

  it("links only a same-app path; anything else renders no control", () => {
    const { window } = primitives("");
    for (const href of ["//evil.example", "javascript:alert(1)", "https://x.example/", "/\\evil", "notes", ""]) {
      const html = window.emptyState({ title: "T", action: { label: "Go", href } });
      assert.doesNotMatch(html, /<a |<button/, href);
    }
    assert.match(window.emptyState({ title: "T", action: { label: "Go", href: "/todos" } }), /<a class="btn primary" href="\/todos">Go<\/a>/);
    assert.doesNotMatch(window.emptyState({ title: "T" }), /empty-state-action/);
    assert.doesNotMatch(window.emptyState({ title: "T", action: { href: "/todos" } }), /empty-state-action/, "no label, no control");
  });

  it("a { click } action presses the page's existing button through one delegated handler", () => {
    const { window, listeners, byId } = primitives();
    const html = window.emptyState({ title: "No tasks", action: { label: "+ New task", click: 'add"task' } });
    assert.match(html, /<button type="button" class="btn primary" data-empty-click="add&quot;task">\+ New task<\/button>/);
    assert.equal(listeners.click.length, 1);
    let pressed = 0;
    byId["add-task-btn"] = { click: () => { pressed++; } };
    const target = { getAttribute: () => "add-task-btn" };
    const ev = { target: { closest: (sel) => (sel === "[data-empty-click]" ? target : null) } };
    assert.equal(window.PsPrimitives.emptyStateClick(ev), true);
    assert.equal(pressed, 1);
    assert.equal(window.PsPrimitives.emptyStateClick({ target: { closest: () => null } }), false, "another click is ignored");
    byId["add-task-btn"] = undefined;
    assert.equal(window.PsPrimitives.emptyStateClick(ev), false, "a missing target does nothing");
  });

  it("compact adds its class", () => {
    const { window } = primitives();
    assert.match(window.emptyState({ compact: true, title: "x" }), /^<div class="empty-state compact">/);
  });

  it("is styled", () => {
    const css = emitted("views/css-components.js");
    for (const sel of [".empty-state {", ".empty-state-title {", ".empty-state-text {", ".empty-state-action {", ".empty-state.compact {"]) {
      assert.ok(css.includes(sel), sel);
    }
  });
});

describe("the listed empty states have a next step", () => {
  const cases = [
    ["dashboard Scheduled Emails", emitted("pages/dashboard-script.js"), /emptyState\(\{ title: 'No scheduled emails'[^)]*action: \{ label: '\+ Compose', href: '\/emails' \}/],
    ["dashboard calendar day", emitted("pages/dashboard-script.js"), /eventsEl\.innerHTML = emptyState\(\{ compact: true, title: 'Nothing on this day'[^)]*href: '\/todos'/],
    ["To-Dos list", emitted("pages/todos-script-1.js"), /emptyState\(q\.length[\s\S]{0,400}click: 'add-task-btn'[\s\S]{0,200}click: 'add-task-btn'/],
    ["Notes", read("pages", "notes.js"), /emptyState\(\{ title: 'No notes yet'[^)]*click: 'new-note-btn'/],
    ["Contacts", read("pages", "contacts.js"), /emptyState\(\{ title: 'No contacts yet'[^)]*click: 'btn-add-contact'/],
    ["Job Radar top matches", read("pages", "jobs.js"), /emptyState\(\{ title: 'No top matches yet'[^)]*click: 'btn-profile'/],
    ["Job Radar status lists", read("pages", "jobs.js"), /emptyState\(\{ title: 'No ' \+[^;]*click: 'jr-view-radar'/],
  ];
  for (const [name, src, re] of cases) it(name, () => assert.match(src, re));

  it("each click target is a button on its page", () => {
    assert.match(read("pages", "todos.js"), /<button class="btn primary" id="add-task-btn">/);
    assert.match(read("pages", "notes.js"), /<button class="btn primary" id="new-note-btn">/);
    assert.match(read("pages", "contacts.js"), /<button class="primary" id="btn-add-contact">/);
    assert.match(read("pages", "jobs.js"), /<button id="btn-profile">/);
    assert.match(read("pages", "jobs.js"), /<button data-view="radar" id="jr-view-radar"/);
  });

  it("the old 'nothing here' lines are gone", () => {
    const all = emitted("pages/dashboard-script.js") + emitted("pages/todos-script-1.js") + read("pages", "notes.js") + read("pages", "contacts.js") + read("pages", "jobs.js");
    for (const s of ["No scheduled emails</div>", "No events on this day", "No tasks found", "Create your first note!", "No contacts yet. Add contacts", "Nothing here.", "No top matches yet. Set your profile and Refresh."]) {
      assert.ok(!all.includes(s), s);
    }
  });
});

describe("buttons (decision 10)", () => {
  const css = emitted("views/css-components.js") + emitted("views/css.js") + require(path.join(APP, "views.js")).SHARED_CSS;
  const navChrome = read("views.js");
  // The declaration block of each button rule.
  function rule(src, sel) {
    const i = src.indexOf(sel + " {");
    assert.ok(i >= 0, sel);
    return src.slice(i, src.indexOf("}", i));
  }

  it("no button rule is uppercase or monospace", () => {
    const rules = [
      [css, ".btn, .actions button, .actions .btn"],
      [css, ".filters button"],
      [css, ".sidebar-foot .collapse-btn"],
      [navChrome, ".mode-toggle"],
      [navChrome, ".appbar .cross-app-link"],
      [navChrome, ".appbar .ask-ps-btn"],
    ];
    for (const [src, sel] of rules) {
      const r = rule(src, sel);
      assert.doesNotMatch(r, /text-transform:\s*uppercase/, sel);
      assert.doesNotMatch(r, /font-family:\s*var\(--mono\)/, sel);
      assert.doesNotMatch(r, /letter-spacing:\s*0\.1/, sel);
    }
    assert.match(rule(css, ".btn, .actions button, .actions .btn"), /font-family: var\(--ui\); font-size: var\(--fs-sm\)/);
  });

  it(".primary is filled with the accent, .danger outlined red", () => {
    assert.match(rule(css, ".btn.primary, .actions button.primary, .actions .btn.primary"), /background: var\(--accent\); color: var\(--paper\); border-color: var\(--accent\)/);
    const danger = rule(css, ".btn.danger, .actions button.danger");
    assert.match(danger, /border-color: var\(--warn\); color: var\(--warn\)/);
    assert.doesNotMatch(danger, /background:/);
  });

  it("no button label is written in Title Case or caps", () => {
    const PROPER = /^(AI|Perfin|CSV|PDF|Per-sistant|Slack|Markdown|Mermaid|Google|Outlook|Voyage|GitHub)$/;
    const files = [];
    for (const d of ["pages", "views"]) for (const f of fs.readdirSync(path.join(APP, d))) if (f.endsWith(".js")) files.push(d + "/" + f);
    files.push("views.js", "routes/auth.js");
    const bad = [];
    for (const f of files) {
      for (const m of read(f).matchAll(/<button[^>]*>([^<]*)<\/button>/g)) {
        const words = m[1].replace(/'[^']*\+[^']*'/g, " ").replace(/&[a-z#0-9]+;/g, " ").split(/\s+/).filter(Boolean);
        const first = words.findIndex((w) => /^[A-Za-z]/.test(w));
        for (let i = first + 1; first >= 0 && i < words.length; i++) {
          const w = words[i];
          if ((/^[A-Z][a-z]+$/.test(w) || /^[A-Z]{4,}$/.test(w)) && !PROPER.test(w)) bad.push(f + ": " + m[1].trim());
        }
      }
    }
    assert.deepEqual([...new Set(bad)], []);
  });
});
