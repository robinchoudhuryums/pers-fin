// ============================================================================
// Per-sistant — PWA Routes (manifest, service worker, icons)
// ============================================================================

const express = require("express");
const fs = require("fs");
const path = require("path");

module.exports = function ({}) {
  const router = express.Router();

  // Load custom icon SVG at startup
  let customIcon = '';
  try {
    customIcon = fs.readFileSync(path.join(__dirname, '..', 'vision icon.svg'), 'utf8');
  } catch (e) { /* fallback to default below */ }

  router.get("/manifest.json", (req, res) => {
    res.json({
      name: "Per-sistant",
      short_name: "Per-sistant",
      description: "Personal assistant — tasks, emails, notes",
      start_url: "/",
      display: "standalone",
      background_color: "#0a0b14",
      theme_color: "#0a0b14",
      icons: [
        { src: "/icon-192.svg", sizes: "192x192", type: "image/svg+xml" },
        { src: "/icon-512.svg", sizes: "512x512", type: "image/svg+xml" },
      ],
    });
  });

  router.get("/sw.js", (req, res) => {
    res.type("application/javascript").send(`
    const CACHE = 'per-sistant-v2';
    const PAGES = ['/', '/todos', '/emails', '/notes', '/calendar', '/contacts', '/review', '/analytics', '/settings'];
    const OFFLINE_KEY = 'per-sistant-offline-queue';

    self.addEventListener('install', e => {
      e.waitUntil(caches.open(CACHE).then(cache => cache.addAll(PAGES)).then(() => self.skipWaiting()));
    });

    self.addEventListener('activate', e => {
      e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
    });

    self.addEventListener('fetch', e => {
      const url = new URL(e.request.url);
      // API requests: network-first, cache fallback for GET
      if (url.pathname.startsWith('/api/')) {
        if (e.request.method === 'GET') {
          e.respondWith(
            fetch(e.request).then(r => {
              const rc = r.clone();
              caches.open(CACHE).then(cache => cache.put(e.request, rc));
              return r;
            }).catch(() => caches.match(e.request))
          );
        } else {
          // POST/PATCH/DELETE: try network, queue if offline
          e.respondWith(
            fetch(e.request.clone()).catch(async () => {
              // Store in offline queue for sync later
              const body = await e.request.clone().text();
              const queue = JSON.parse(await (await caches.match(OFFLINE_KEY))?.text() || '[]');
              queue.push({ url: e.request.url, method: e.request.method, body, headers: Object.fromEntries(e.request.headers) });
              const queueResponse = new Response(JSON.stringify(queue));
              await caches.open(CACHE).then(c => c.put(OFFLINE_KEY, queueResponse));
              return new Response(JSON.stringify({ ok: true, offline: true }), { headers: { 'Content-Type': 'application/json' } });
            })
          );
        }
        return;
      }
      // Page requests: network-first with cache fallback
      e.respondWith(
        fetch(e.request).then(r => {
          const rc = r.clone();
          caches.open(CACHE).then(cache => cache.put(e.request, rc));
          return r;
        }).catch(() => caches.match(e.request))
      );
    });

    // Sync offline queue when back online
    self.addEventListener('message', e => {
      if (e.data === 'sync') {
        caches.open(CACHE).then(async cache => {
          const resp = await cache.match(OFFLINE_KEY);
          if (!resp) return;
          const queue = JSON.parse(await resp.text());
          for (const req of queue) {
            try {
              await fetch(req.url, { method: req.method, body: req.body, headers: req.headers });
            } catch {}
          }
          await cache.delete(OFFLINE_KEY);
          self.clients.matchAll().then(clients => clients.forEach(c => c.postMessage('synced')));
        });
      }
    });
  `);
  });

  // SVG icon
  const SVG_ICON = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
  <rect width="512" height="512" rx="64" fill="#0a0b14"/>
  <text x="256" y="340" font-family="Inter,sans-serif" font-size="280" font-weight="300" fill="#a08cd4" text-anchor="middle">P</text>
</svg>`;

  const icon = customIcon || SVG_ICON;
  router.get("/icon-192.svg", (req, res) => res.type("image/svg+xml").send(icon));
  router.get("/icon-512.svg", (req, res) => res.type("image/svg+xml").send(icon));

  return router;
};
