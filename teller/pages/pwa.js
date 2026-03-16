const express = require("express");
const router = express.Router();

// ---------------------------------------------------------------------------
// Iron Man helmet SVG path (shared across manifest icon + apple-touch-icon)
// ---------------------------------------------------------------------------
const HELMET_PATH = "M100,6 C56,6 24,44 24,92L24,132C24,150 32,168 44,180L60,196 74,212 86,224 100,232 114,224 126,212 140,196 156,180C168,168 176,150 176,132L176,92C176,44 144,6 100,6Z M100,38L72,50 76,88 90,102 100,106 110,102 124,88 128,50Z M30,108L86,96 82,130 30,126Z M170,108L114,96 118,130 170,126Z M78,170L122,170 116,184 84,184Z";

function helmetSvg(size, bg, fg) {
  return `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 ${size} ${size}'>`
    + `<rect fill='${bg}' width='${size}' height='${size}' rx='${Math.round(size * 0.2)}'/>`
    + `<g transform='translate(${size * 0.15},${size * 0.1}) scale(${(size * 0.7) / 200})'>`
    + `<path fill-rule='evenodd' d='${HELMET_PATH}' fill='${fg}'/></g></svg>`;
}

// ---------------------------------------------------------------------------
// PWA manifest and service worker
// ---------------------------------------------------------------------------
router.get("/manifest.json", (_req, res) => {
  const svgIcon = "data:image/svg+xml," + encodeURIComponent(helmetSvg(512, "#080b12", "#5a8f8f"));
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

// Apple touch icon — served as SVG (iOS 16.4+ supports this in PWA context)
router.get("/apple-touch-icon.svg", (_req, res) => {
  res.type("image/svg+xml").send(helmetSvg(180, "#080b12", "#5a8f8f"));
});
// Also handle the standard apple-touch-icon.png path by serving SVG
router.get("/apple-touch-icon.png", (_req, res) => {
  res.type("image/svg+xml").send(helmetSvg(180, "#080b12", "#5a8f8f"));
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
