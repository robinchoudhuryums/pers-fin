// ============================================================================
// PWA polish: pull-to-refresh + notch/safe-area pass (Phase-0 follow-ups)
// ============================================================================
//   - Pull-to-refresh: standalone-PWA-only JS implementation in BOTH apps'
//     shared client JS (iOS home-screen PWAs have no native gesture), with
//     overlay/pyramid/canvas exclusions and passive listeners.
//   - Safe-area: Perfin opted into viewport-fit=cover but never padded the
//     body, so the top nav rendered under the iPhone status bar / notch in
//     standalone mode. Shell login/landing had the same gap.

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), "utf8");

describe("pull-to-refresh", () => {
  const perfinJs = read("teller", "public", "perfin-shared.js");
  const persistantJs = read("apps", "per-sistant", "views", "js.js");

  it("exists in both apps' shared JS, gated to standalone display-mode", () => {
    for (const [name, src] of [["perfin", perfinJs], ["per-sistant", persistantJs]]) {
      assert.ok(src.includes("initPullToRefresh"), name + " must ship PTR");
      assert.match(src, /display-mode: standalone/, name + " must gate on standalone (browser tabs have the native gesture)");
    }
  });

  it("uses passive listeners only (never blocks scrolling)", () => {
    for (const src of [perfinJs, persistantJs]) {
      const ptr = src.slice(src.indexOf("initPullToRefresh"));
      const listeners = ptr.match(/addEventListener\('touch\w+', [\s\S]*?\{ passive: true \}\)/g) || [];
      assert.equal(listeners.length, 3, "touchstart/move/end all passive");
    }
  });

  it("excludes overlays, the 3D pyramid, and chart canvases from triggering", () => {
    for (const src of [perfinJs, persistantJs]) {
      assert.match(src, /\.notif-panel, \.modal-backdrop, \.modal-overlay, dialog, \.pyramid-stage, canvas/);
    }
  });

  it("only arms when the page is scrolled to the very top", () => {
    for (const src of [perfinJs, persistantJs]) {
      assert.match(src, /scrollTop > 0\) return/);
    }
  });

  it("per-sistant's copy is template-literal safe (no backticks / interpolation)", () => {
    const ptr = persistantJs.slice(persistantJs.indexOf("initPullToRefresh"));
    // The module is one big exported template literal — a stray ` or ${ in
    // the PTR block would break the whole shared-JS bundle at require time.
    const beforeClosing = ptr.slice(0, ptr.lastIndexOf("`;"));
    assert.ok(!beforeClosing.includes("`"), "no backticks inside the template literal");
    assert.ok(!beforeClosing.includes("${"), "no interpolation inside the template literal");
  });

  it("indicator styles exist in both apps (ready + refreshing states)", () => {
    const perfinCss = read("teller", "public", "perfin-shared.css");
    const psCss = read("apps", "per-sistant", "views", "css-components.js");
    for (const css of [perfinCss, psCss]) {
      assert.match(css, /#ptr-indicator/);
      assert.match(css, /\.ptr-ready/);
      assert.match(css, /\.ptr-refreshing .*animation: spin/);
    }
  });
});

describe("notch / safe-area pass", () => {
  it("Perfin body pads by the safe-area insets (viewport-fit=cover demands it)", () => {
    const css = read("teller", "public", "perfin-shared.css");
    assert.match(css, /body \{ padding-top: env\(safe-area-inset-top\);/);
    assert.match(css, /padding-left: env\(safe-area-inset-left\)/);
    assert.match(css, /padding-right: env\(safe-area-inset-right\)/);
  });

  it("notif-panel and PTR indicator offset below the inset, bottom-nav already padded", () => {
    const css = read("teller", "public", "perfin-shared.css");
    assert.match(css, /\.notif-panel \{ position: fixed; top: calc\(56px \+ env\(safe-area-inset-top\)\)/);
    assert.match(css, /#ptr-indicator \{ position: fixed; top: calc\(10px \+ env\(safe-area-inset-top\)\)/);
    assert.match(css, /\.bottom-nav \{[^}]*padding-bottom: env\(safe-area-inset-bottom\)/s);
  });

  it("shell login/landing body pads by the insets too", () => {
    const css = read("shell", "public", "landing.css");
    assert.match(css, /padding-top: env\(safe-area-inset-top\)/);
    assert.match(css, /padding-bottom: env\(safe-area-inset-bottom\)/);
  });

  it("Per-sistant deliberately does NOT use viewport-fit=cover (auto-inset)", () => {
    // Its viewport meta omits viewport-fit, so iOS standalone insets content
    // automatically — adding body padding there would double-inset. This pin
    // documents the asymmetry so a future "consistency" edit doesn't break it.
    const views = read("apps", "per-sistant", "views.js");
    assert.ok(!views.includes("viewport-fit"), "per-sistant viewport meta must not opt into cover without a matching safe-area pass");
  });
});
