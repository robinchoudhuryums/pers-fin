// Design pass D5 (Settings: groups + index) — `.cycle/plan-design-ux.md`, decision 8.
// - the seven groups in order, each holding its sections; markup moved only, so
//   every section id (and every anchor something links to) still exists;
// - the sticky index (≥961px) and the "Jump to" select (narrower) are built from
//   the group headings (buildSettingsIndex, run in a vm), so they can't drift;
// - a deep link lands on its section: revealHashTarget opens a closed <details>,
//   scrolls to it and marks its group in the index;
// - the page still renders through EJS, standalone and under /perfin.
"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const ROOT = path.join(__dirname, "..");
// Values built inside the vm come from another realm; compare them as plain data.
const plain = (v) => JSON.parse(JSON.stringify(v));
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), "utf8");
const page = read("teller", "views", "settings.ejs");
const shared = read("teller", "public", "perfin-shared.js");
function slice(src, start, end) {
  const i = src.indexOf(start);
  const j = src.indexOf(end, i + start.length);
  assert.ok(i >= 0 && j > i, "slice markers: " + start);
  return src.slice(i, j);
}

const GROUPS = [
  ["group-appearance", "Appearance & Dashboard"],
  ["group-security", "Security"],
  ["group-ai", "AI"],
  ["group-alerts", "Alerts & Notifications"],
  ["group-sync", "Sync & Connections"],
  ["group-planning", "Planning"],
  ["group-data", "Data & Exports"],
];
// Where each section id lives (decision 8).
const MEMBERS = {
  "group-appearance": ["install-section"],
  "group-security": ["biometric-section"],
  "group-ai": ["ai-insights", "insights-container"],
  "group-alerts": ["cash-alerts-section", "linked-tasks-section"],
  "group-sync": ["sync-health", "operator-checks-body", "recent-errors", "deleted-transactions", "keepalive-section"],
  "group-planning": ["target-allocation-section", "watchlist-section"],
  "group-data": [],
};
// Every id the page had before D5 (markup moves only).
const PRE_D5_IDS = ("theme-select months-select pyramid-source-select pyramid-color-select widget-toggles install-section " +
  "biometric-section ai-insights insights-container sync-health operator-checks-body recent-errors " +
  "deleted-transactions cash-alerts-section linked-tasks-section keepalive-section " +
  "target-allocation-section watchlist-section").split(" ");

// The text of one group: from its <section> to the next group's (or the layout's end).
function groupText(id) {
  const i = page.indexOf(`<section class="settings-group" id="${id}"`);
  assert.ok(i >= 0, id);
  const next = page.indexOf('<section class="settings-group"', i + 10);
  return page.slice(i, next > 0 ? next : page.indexOf("<script", i));
}

describe("decision 8 — the groups", () => {
  it("seven groups, in order, with their headings", () => {
    const found = [...page.matchAll(/<section class="settings-group" id="([^"]+)" aria-labelledby="\1-title">\s*<h3 class="settings-group-title" id="\1-title">([^<]+)<\/h3>/g)]
      .map((m) => [m[1], m[2].replace(/&amp;/g, "&")]);
    assert.deepEqual(found, GROUPS);
  });

  it("each section sits in its group", () => {
    for (const [group, ids] of Object.entries(MEMBERS)) {
      const text = groupText(group);
      for (const id of ids) assert.match(text, new RegExp(`id="${id}"`), `${id} in ${group}`);
    }
    assert.match(groupText("group-data"), /Open the Tax page/);
    assert.match(groupText("group-appearance"), /id="widget-toggles"/);
  });

  it("every pre-D5 id is still on the page, once", () => {
    for (const id of PRE_D5_IDS) {
      const n = page.split(`id="${id}"`).length - 1;
      assert.equal(n, 1, id);
    }
  });

  it("every /settings#… anchor the code links to exists on the page", () => {
    const targets = new Set(["sync-health", "deleted-transactions", "recent-errors", "cash-alerts-section", "linked-tasks-section", "ai-insights"]);
    const walk = (dir) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        if (e.name === "node_modules") continue;
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (/\.(js|ejs)$/.test(e.name)) {
          for (const m of fs.readFileSync(p, "utf8").matchAll(/\/settings#([A-Za-z0-9_-]+)/g)) targets.add(m[1]);
        }
      }
    };
    walk(path.join(ROOT, "teller"));
    walk(path.join(ROOT, "shell"));
    assert.ok(targets.size >= 6);
    for (const t of targets) assert.match(page, new RegExp(`id="${t}"`), `#${t}`);
  });

  it("the old inline-styled group headings are gone", () => {
    assert.doesNotMatch(page, /class="settings-group-title" style=/);
  });
});

// A small DOM for the index code: groups with titles and sections inside.
function fakeDoc() {
  const byId = {};
  const links = [];
  function el(tag, id, parent) {
    const e = {
      tagName: tag, id, parent, open: false, attrs: {}, scrolled: null, innerHTML: "",
      closest(sel) { let n = this; while (n) { if (sel === ".settings-group" && n.isGroup) return n; n = n.parent; } return null; },
      scrollIntoView(o) { this.scrolled = o; },
    };
    if (id) byId[id] = e;
    return e;
  }
  const groups = [
    Object.assign(el("SECTION", "group-sync"), { isGroup: true, title: "Sync & Connections" }),
    Object.assign(el("SECTION", "group-x"), { isGroup: true, title: "<b>Bad & Co</b>" }),
    Object.assign(el("SECTION", "group-untitled"), { isGroup: true, title: null }),
  ];
  const sync = el("DIV", "sync-health", groups[0]);
  el("DETAILS", "deleted-transactions", sync);
  const list = el("OL", "settings-index-list");
  const sel = el("SELECT", "settings-jump");
  // innerHTML on the list makes link objects the way a browser would.
  Object.defineProperty(list, "innerHTML", {
    get() { return this._html || ""; },
    set(v) {
      this._html = v;
      links.length = 0;
      for (const m of v.matchAll(/data-group="([^"]*)"/g)) {
        links.push({ attrs: { "data-group": m[1] }, getAttribute(k) { return this.attrs[k]; },
          setAttribute(k, val) { this.attrs[k] = val; }, removeAttribute(k) { delete this.attrs[k]; } });
      }
    },
  });
  return {
    sel, list, links, byId,
    getElementById: (id) => byId[id] || null,
    querySelectorAll(q) {
      if (q === ".settings-group") return groups.map((g) => ({
        id: g.id, querySelector: () => (g.title == null ? null : { textContent: "  " + g.title + " " }),
      }));
      if (q === "#settings-index-list a") return links;
      return [];
    },
  };
}
function indexFns() {
  const ctx = {};
  const esc = slice(shared, "  function esc(s) {", "\n  }\n") + "\n  }\n";
  vm.runInNewContext(esc + slice(page, "    function buildSettingsIndex(doc)", "    (function initSettingsIndex()") +
    "this.build = buildSettingsIndex; this.reveal = revealHashTarget; this.mark = markCurrentGroup;", ctx);
  return ctx;
}

describe("decision 8 — the index and the Jump to select", () => {
  it("buildSettingsIndex lists every titled group in both, escaped", () => {
    const { build } = indexFns();
    const doc = fakeDoc();
    const items = build(doc);
    assert.deepEqual(plain(items.map((i) => i.id)), ["group-sync", "group-x"], "an untitled group is left out");
    assert.equal(items[0].title, "Sync & Connections", "trimmed");
    assert.match(doc.list.innerHTML, /<li><a href="#group-sync" data-group="group-sync">Sync &amp; Connections<\/a><\/li>/);
    assert.match(doc.list.innerHTML, /&lt;b&gt;Bad &amp; Co&lt;\/b&gt;/);
    assert.doesNotMatch(doc.list.innerHTML, /<b>/);
    assert.equal(doc.sel.innerHTML,
      '<option value="">Choose a group…</option><option value="group-sync">Sync &amp; Connections</option>' +
      '<option value="group-x">&lt;b&gt;Bad &amp; Co&lt;/b&gt;</option>');
  });

  it("revealHashTarget opens a closed <details>, scrolls to it and marks its group", () => {
    const { build, reveal } = indexFns();
    const doc = fakeDoc();
    build(doc);
    const el = reveal(doc, "#deleted-transactions");
    assert.equal(el, doc.byId["deleted-transactions"]);
    assert.equal(el.open, true);
    assert.deepEqual(plain(el.scrolled), { block: "start" });
    assert.deepEqual(doc.links.map((a) => a.attrs["aria-current"]), ["true", undefined]);

    const sync = reveal(doc, "sync-health");
    assert.equal(sync.open, false, "a div isn't opened");
    assert.deepEqual(plain(sync.scrolled), { block: "start" });
  });

  it("revealHashTarget ignores an unknown, empty or malformed hash", () => {
    const { reveal } = indexFns();
    const doc = fakeDoc();
    assert.equal(reveal(doc, "#nope"), null);
    assert.equal(reveal(doc, "#"), null);
    assert.equal(reveal(doc, ""), null);
    assert.equal(reveal(doc, "#%E0%A4%A"), null);
  });

  it("markCurrentGroup clears the mark outside any group", () => {
    const { build, mark } = indexFns();
    const doc = fakeDoc();
    build(doc);
    mark(doc, doc.byId["sync-health"]);
    assert.equal(doc.links[0].attrs["aria-current"], "true");
    mark(doc, doc.byId["settings-jump"]);
    assert.deepEqual(doc.links.map((a) => a.attrs["aria-current"]), [undefined, undefined]);
  });

  it("the markup: a labelled index nav, the select labelled for IF-3, both empty until built", () => {
    assert.match(page, /<nav class="settings-index" id="settings-index" aria-label="Settings groups">\s*<ol id="settings-index-list"><\/ol>/);
    assert.match(page, /<label for="settings-jump">Jump to<\/label>\s*<select id="settings-jump"><option value="">Choose a group…<\/option><\/select>/);
    const init = slice(page, "(function initSettingsIndex()", "  </script>");
    assert.match(init, /buildSettingsIndex\(document\)/);
    assert.match(init, /addEventListener\('hashchange'/);
    assert.match(init, /el\.open|revealHashTarget\(document, location\.hash\)/);
  });

  it("CSS: the index is sticky only at ≥961px, where the select hides; anchors clear the top", () => {
    const css = slice(page, "extraStyles", "` }) %>");
    const wide = slice(css, "@media (min-width: 961px) {", "\n    }\n");
    assert.match(wide, /\.settings-index \{ display: block; position: sticky; top: 16px; \}/);
    assert.match(wide, /\.settings-jump \{ display: none; \}/);
    assert.match(wide, /grid-template-columns: 190px minmax\(0, 1fr\)/);
    const narrow = css.replace(wide, "");
    assert.match(narrow, /\.settings-index \{ display: none; \}/);
    assert.doesNotMatch(narrow, /position: sticky/);
    assert.match(css, /\.settings-group \.section\[id\], #recent-errors, #deleted-transactions \{ scroll-margin-top: 16px; \}/);
    assert.match(css, /#main-content \{ max-width: 860px; \}/, "D1's content width stays");
    assert.doesNotMatch(css, /\\[0-9]/, "no backslash escape in the extraStyles template literal");
  });
});

describe("the page renders", () => {
  it("settings.ejs through EJS, standalone and under /perfin", async () => {
    const ejs = require("ejs");
    for (const basePath of ["", "/perfin"]) {
      const html = await new Promise((resolve, reject) =>
        ejs.renderFile(path.join(ROOT, "teller", "views", "settings.ejs"), { nonce: "n", v: "1", basePath, activePage: "settings" },
          (err, out) => (err ? reject(err) : resolve(out))));
      assert.match(html, /id="settings-index-list"/);
      assert.match(html, /id="group-data-title">Data &amp; Exports/);
    }
  });
});
