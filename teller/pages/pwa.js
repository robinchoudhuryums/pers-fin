const express = require("express");
const router = express.Router();

// ---------------------------------------------------------------------------
// PWA manifest and service worker
// ---------------------------------------------------------------------------
router.get("/manifest.json", (_req, res) => {
  res.json({
    name: "Perfin — Subscription Tracker",
    short_name: "Perfin",
    start_url: "/dashboard",
    display: "standalone",
    background_color: "#080b12",
    theme_color: "#080b12",
    icons: [
      { src: "data:image/svg+xml," + encodeURIComponent("<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><rect fill='%23080b12' width='100' height='100' rx='20'/><text y='70' x='50' text-anchor='middle' font-size='55' fill='%23d4a574'>$</text></svg>"),
        sizes: "any", type: "image/svg+xml" }
    ],
  });
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
    "});"
  );
});

module.exports = router;
