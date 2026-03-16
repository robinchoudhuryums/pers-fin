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
  const tealInner = inner.replace(/fill="currentColor"/g, `fill="#5a8f8f"`);
  return `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 ${size} ${size}'>`
    + `<rect fill='#080b12' width='${size}' height='${size}' rx='${Math.round(size * 0.2)}'/>`
    + `<g transform='translate(${size * 0.15},${size * 0.1}) scale(${(size * 0.7) / 200})'>`
    + tealInner + `</g></svg>`;
}

// ---------------------------------------------------------------------------
// PWA manifest and service worker
// ---------------------------------------------------------------------------
router.get("/manifest.json", (_req, res) => {
  const svgIcon = "data:image/svg+xml," + encodeURIComponent(buildIcon(512));
  res.json({
    name: "Perfin — Personal Finance",
    short_name: "Perfin",
    start_url: "/dashboard",
    display: "standalone",
    background_color: "#080b12",
    theme_color: "#080b12",
    icons: [
      { src: svgIcon, sizes: "any", type: "image/svg+xml" },
      { src: "/apple-touch-icon.svg", sizes: "180x180", type: "image/svg+xml" },
    ],
  });
});

// Apple touch icon — served as SVG
router.get("/apple-touch-icon.svg", (_req, res) => {
  res.type("image/svg+xml").send(buildIcon(180));
});
router.get("/apple-touch-icon.png", (_req, res) => {
  res.type("image/svg+xml").send(buildIcon(180));
});

router.get("/sw.js", (_req, res) => {
  res.type("application/javascript").send(
    "const CACHE='perfin-v1';" +
    "self.addEventListener('install',()=>self.skipWaiting());" +
    "self.addEventListener('activate',e=>e.waitUntil(clients.claim()));" +
    "self.addEventListener('fetch',e=>{" +
    "if(e.request.method!=='GET')return;" +
    "e.respondWith(fetch(e.request).then(r=>{" +
    "if(r.ok&&e.request.url.includes('cdn.jsdelivr.net')){" +
    "const c=r.clone();caches.open(CACHE).then(ca=>ca.put(e.request,c));}" +
    "return r;}).catch(()=>caches.match(e.request)));" +
    "});" +
    "self.addEventListener('push',e=>{" +
    "if(!e.data)return;" +
    "const d=e.data.json();" +
    "e.waitUntil(self.registration.showNotification(d.title||'Perfin',{" +
    "body:d.body||'',tag:d.tag||'perfin',data:d.data||{}" +
    "}));" +
    "});" +
    "self.addEventListener('notificationclick',e=>{" +
    "e.notification.close();" +
    "e.waitUntil(clients.openWindow(e.notification.data.url||'/dashboard'));" +
    "});"
  );
});

module.exports = router;
