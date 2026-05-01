const express = require("express");
const path = require("path");
const fs = require("fs");
const router = express.Router();

// ---------------------------------------------------------------------------
// Load helmet SVG and build PWA icon from it (teal on dark background)
// ---------------------------------------------------------------------------
const logoSvgRaw = fs.readFileSync(path.join(__dirname, "../public/logo.svg"), "utf8");

function buildIcon(size) {
  // Extract the inner content of logo.svg (everything between <svg> tags)
  const inner = logoSvgRaw.replace(/<\?xml[^?]*\?>/, "").replace(/<svg[^>]*>/, "").replace(/<\/svg>/, "").trim();
  // Re-color fills to teal and wrap in a sized SVG with dark rounded-rect background
  const tealInner = inner.replace(/fill="currentColor"/g, `fill="#c8a86c"`);
  return `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 ${size} ${size}'>`
    + `<rect fill='#080b12' width='${size}' height='${size}' rx='${Math.round(size * 0.2)}'/>`
    + `<g transform='translate(${size * 0.15},${size * 0.15}) scale(${(size * 0.7) / 200})'>`
    + tealInner + `</g></svg>`;
}

// Cache icons at startup — logo never changes at runtime
const cachedIcon512 = buildIcon(512);
const cachedIcon180 = buildIcon(180);

// ---------------------------------------------------------------------------
// PWA manifest and service worker
// ---------------------------------------------------------------------------
// Manifest is generated per-request so start_url, scope, and the
// apple-touch-icon path can include req.baseUrl when this app is mounted
// under the unified shell. Standalone (req.baseUrl === "") emits the same
// URLs as before.
router.get("/manifest.json", (req, res) => {
  const bp = req.baseUrl || "";
  const svgIcon = "data:image/svg+xml," + encodeURIComponent(cachedIcon512);
  res.json({
    name: "Perfin — Personal Finance",
    short_name: "Perfin",
    start_url: bp + "/dashboard",
    scope: bp + "/",
    display: "standalone",
    background_color: "#080b12",
    theme_color: "#080b12",
    icons: [
      { src: svgIcon, sizes: "any", type: "image/svg+xml" },
      { src: bp + "/apple-touch-icon.svg", sizes: "180x180", type: "image/svg+xml" },
    ],
  });
});

// Apple touch icon — served as SVG (cached at startup)
router.get("/apple-touch-icon.svg", (_req, res) => {
  res.type("image/svg+xml").send(cachedIcon180);
});
router.get("/apple-touch-icon.png", (_req, res) => {
  res.type("image/svg+xml").send(cachedIcon180);
});

// Service worker served as static file with no-cache to ensure updates
// propagate. Service-Worker-Allowed: '/' lets the SW (when served at
// /perfin/sw.js under the shell) be registered with a broader scope if
// ever needed; today's registration in perfin-shared.js uses the
// containing path's natural scope, but emitting this header is forward-
// compatible and harmless when the request was for /sw.js at root.
router.get("/sw.js", (_req, res) => {
  res.set("Cache-Control", "no-cache");
  res.set("Service-Worker-Allowed", "/");
  res.sendFile(path.join(__dirname, "../public/sw.js"));
});

module.exports = router;
