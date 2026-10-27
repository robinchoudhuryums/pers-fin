// Design pass D6 — shared design tokens (`.cycle/plan-design-ux.md`, decision 9).
// design/tokens.json is the spec for the values both apps share: the status colours
// (dark and light), the type scale, spacing, radius and button heights. Each app
// declares them in its own CSS under its own names; this test reads both sources and
// fails on any drift. Values listed as app_specific (accent, surfaces, fonts) are
// checked to exist in their app but are never compared across apps.
"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const spec = JSON.parse(fs.readFileSync(path.join(ROOT, "design", "tokens.json"), "utf8"));

// An app's CSS as text: Perfin's is a stylesheet, Per-sistant's a JS module that
// exports the CSS string.
function cssOf(app) {
  const src = spec.apps[app].source;
  return src.endsWith(".js") ? require(path.join(ROOT, src)) : fs.readFileSync(path.join(ROOT, src), "utf8");
}
// The custom-property declarations of every top-level rule whose selector is exactly
// `selector` (later rules win, as in the cascade).
function declsOf(css, selector) {
  const out = {};
  const plain = css.replace(/\/\*[\s\S]*?\*\//g, "");
  let i = 0;
  while ((i = plain.indexOf("{", i)) >= 0) {
    const start = Math.max(plain.lastIndexOf("}", i), -1) + 1;
    const sel = plain.slice(start, i).trim();
    const end = plain.indexOf("}", i);
    if (sel === selector) {
      for (const m of plain.slice(i + 1, end).matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) out[m[1]] = m[2].trim();
    }
    i = end + 1;
  }
  return out;
}
// Every shared value as [key, scope, value]: status per mode, the rest in the base scope.
function sharedValues() {
  const rows = [];
  for (const [mode, colours] of Object.entries(spec.shared.status)) {
    for (const [k, v] of Object.entries(colours)) rows.push(["status." + k, mode, v]);
  }
  for (const group of ["type", "space", "radius", "button_height"]) {
    for (const [k, v] of Object.entries(spec.shared[group])) rows.push([group + "." + k, "base", v]);
  }
  return rows;
}
const norm = (v) => String(v).trim().toLowerCase();

describe("design/tokens.json (decision 9)", () => {
  it("lists the decision's values", () => {
    assert.deepEqual(Object.values(spec.shared.type), ["12px", "13px", "14px", "16px", "20px", "28px"]);
    assert.deepEqual(Object.values(spec.shared.space), ["4px", "8px", "12px", "16px", "24px", "32px"]);
    assert.deepEqual(Object.keys(spec.shared.radius), ["card", "control", "pill"]);
    assert.deepEqual(Object.values(spec.shared.button_height), ["32px", "40px", "44px"]);
    for (const mode of ["dark", "light"]) {
      assert.deepEqual(Object.keys(spec.shared.status[mode]), ["ok", "warn", "danger", "info"]);
    }
  });

  it("names every shared key in both apps, and no app-specific name is a shared one", () => {
    const keys = [...new Set(sharedValues().map(([k]) => k))];
    for (const app of ["perfin", "per-sistant"]) {
      const names = spec.apps[app].names;
      assert.deepEqual(Object.keys(names).sort(), keys.slice().sort(), app);
      const shared = new Set(Object.values(names));
      for (const n of spec.app_specific[app]) assert.ok(!shared.has(n), `${app}: ${n} is both shared and app-specific`);
    }
  });
});

for (const app of ["perfin", "per-sistant"]) {
  describe(`${app} declares the shared values`, () => {
    const css = cssOf(app);
    const { scopes, names } = spec.apps[app];

    for (const [key, scope, value] of sharedValues()) {
      it(`${key}${scope === "base" ? "" : " (" + scope + ")"} = ${value}`, () => {
        const decls = declsOf(css, scopes[scope]);
        const name = names[key];
        assert.ok(name in decls, `${names[key]} is not declared in ${scopes[scope]}`);
        assert.equal(norm(decls[name]), norm(value), `${name} in ${scopes[scope]}`);
      });
    }

    it("declares its app-specific values (not compared with the other app)", () => {
      const all = css.replace(/\/\*[\s\S]*?\*\//g, "");
      for (const n of spec.app_specific[app]) assert.match(all, new RegExp(n.replace(/-/g, "\\-") + "\\s*:"), n);
    });

    it("its card radius is the shared one", () => {
      assert.equal(declsOf(css, scopes.base)["--radius"], "var(--radius-card)");
    });
  });
}

describe("each app uses the tokens", () => {
  it("Perfin's controls are the shared heights, its button the control radius", () => {
    const css = cssOf("perfin");
    assert.match(css, /a\.btn, input\[type="submit"\] \{ min-height: var\(--btn-h\); \}/);
    assert.match(css, /button, \.btn, select, input\[type="submit"\] \{ min-height: var\(--btn-h-touch\); \}/);
    assert.match(css, /\.btn \{[^}]*border-radius: var\(--radius-control\)/);
  });

  it("Per-sistant's status colours are unified across palettes (decision 9: values unified where they differed)", () => {
    const css = cssOf("per-sistant");
    // No palette sets its own good / warn any more; both resolve on body from the status tokens.
    assert.doesNotMatch(css, /data-palette="[a-z]+"\][^{]*\{[^}]*--(good|warn|status-[a-z]+)\s*:/);
    assert.deepEqual(declsOf(css, "body"), { "--good": "var(--status-ok)", "--warn": "var(--status-danger)" });
    // The legacy dark selector carries the same dark status colours.
    const legacy = declsOf(css, 'html[data-theme="dark"] body');
    for (const [k, v] of Object.entries(spec.shared.status.dark)) {
      assert.equal(norm(legacy[spec.apps["per-sistant"].names["status." + k]]), norm(v), k);
    }
  });

  it("Per-sistant's buttons are the shared heights and control radius", () => {
    const css = require(path.join(ROOT, "apps", "per-sistant", "views", "css-components.js"));
    const btn = css.slice(css.indexOf(".btn, .actions button, .actions .btn {"));
    assert.match(btn, /^[^}]*min-height: var\(--btn-h-sm\)/);
    assert.match(btn, /^[^}]*border-radius: var\(--radius-control\)/);
    assert.match(css, /@media \(max-width: 640px\) \{\s*\.btn, \.actions button, \.actions \.btn \{ min-height: var\(--btn-h-touch\); \}/);
  });
});
