// ============================================================================
// Per-sistant — PWA Routes (manifest, service worker, icons)
// ============================================================================
// All resources are generated per-request so they can be served correctly
// when the app is mounted under the unified shell (e.g. /per-sistant). The
// route handlers read req.baseUrl and bake the prefix into:
//   - the manifest's start_url, scope, and icon paths
//   - the service worker's PAGES precache list
// Standalone deployments leave req.baseUrl === "" and the output is
// identical to the prior static behavior.

const express = require("express");
const path = require("path");

module.exports = function ({}) {
  const router = express.Router();

  // PNG icons live alongside server.js — favicon.io-generated set used for the
  // iPhone home-screen icon, Android Chrome PWA install, and now the
  // browser-tab favicon (no SVG variant — see pageHead comment in views.js).
  // Resolved once at module load and served via res.sendFile so the file is
  // read fresh per request (cached by Express's static handling).
  const PNG_DIR = path.join(__dirname, '..');
  const APPLE_TOUCH_PNG = path.join(PNG_DIR, 'apple-touch-icon.png');
  const ICON_192_PNG = path.join(PNG_DIR, 'android-chrome-192x192.png');
  const ICON_512_PNG = path.join(PNG_DIR, 'android-chrome-512x512.png');
  // mask-crop is a transparent-bg variant of the same artwork used as a small
  // corner glyph (sidebar brand) and as the cross-app icon shown from Perfin.
  const MASK_CROP_PNG = path.join(PNG_DIR, 'android-chrome-mask-crop.png');

  router.get("/manifest.json", (req, res) => {
    const bp = req.baseUrl || "";
    res.json({
      name: "Per-sistant",
      short_name: "Per-sistant",
      description: "Personal assistant — tasks, emails, notes",
      start_url: bp + "/",
      scope: bp + "/",
      display: "standalone",
      background_color: "#0a0b14",
      theme_color: "#0a0b14",
      icons: [
        // PNG-only set — the legacy SVG entries were the old vision icon
        // and have been removed. Both PNGs are the same artwork (the
        // mask-crop image) at different resolutions. The 512 is marked
        // any-maskable for Android adaptive-icon platforms. ?v=2 busts
        // OS-level icon caches that survive PWA reinstall (notably iOS
        // Safari's apple-touch-icon cache).
        { src: bp + "/android-chrome-192x192.png?v=2", sizes: "192x192", type: "image/png" },
        { src: bp + "/android-chrome-512x512.png?v=2", sizes: "512x512", type: "image/png", purpose: "any maskable" },
      ],
    });
  });

  router.get("/sw.js", (req, res) => {
    const bp = req.baseUrl || "";
    // BASE is injected via JSON.stringify so quotes are correct in either
    // the empty-string standalone case or the "/per-sistant" mounted case.
    res.type("application/javascript").send(`
    const BASE = ${JSON.stringify(bp)};
    const CACHE = 'per-sistant-v8';
    const PAGES = [BASE+'/', BASE+'/todos', BASE+'/emails', BASE+'/notes', BASE+'/calendar', BASE+'/contacts', BASE+'/review', BASE+'/analytics', BASE+'/settings'];
    const OFFLINE_KEY = 'per-sistant-offline-queue';
    // PB-17: never cache secret-tier answers (Cache Storage persists them on
    // disk), and never queue a write whose late replay would surprise the user
    // (sending mail, refreshes, AI calls, auth). A queued entry older than
    // QUEUE_MAX_AGE_MS is dropped instead of replayed days later.
    // (String matching only — this file is a template literal, so a regex
    // backslash would be eaten.)
    const NO_CACHE = ['/api/rag/secret', '/api/auth', '/api/logout'];
    const NO_QUEUE = ['/send', '/refresh', '/api/ai/', '/api/rag/', '/api/auth', '/api/logout', '/login', '/logout', '/reindex', '/sync'];
    const QUEUE_MAX_AGE_MS = 24 * 60 * 60 * 1000;
    function pathHas(path, list) { return list.some(function (p) { return path.indexOf(p) !== -1; }); }

    self.addEventListener('install', e => {
      e.waitUntil(caches.open(CACHE).then(cache => cache.addAll(PAGES)).then(() => self.skipWaiting()));
    });

    self.addEventListener('activate', e => {
      e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
    });

    function offlineResponse(queued) {
      // 503, never ok:true — a queued write has NOT happened yet, so callers
      // that check r.ok must not report success (PB-17).
      const msg = queued
        ? "You're offline — this change is saved and will be retried when you're back online."
        : "You're offline — this action needs a connection.";
      return new Response(JSON.stringify({ ok: false, offline: true, queued: !!queued, error: msg }),
        { status: 503, headers: { 'Content-Type': 'application/json' } });
    }

    self.addEventListener('fetch', e => {
      const url = new URL(e.request.url);
      // API requests: network-first, cache fallback for GET
      if (url.pathname.startsWith(BASE + '/api/')) {
        if (e.request.method === 'GET') {
          if (pathHas(url.pathname, NO_CACHE)) return; // straight to network, never stored
          e.respondWith(
            fetch(e.request).then(r => {
              if (r.ok) {
                const rc = r.clone();
                caches.open(CACHE).then(cache => cache.put(e.request, rc));
              }
              return r;
            }).catch(() => caches.match(e.request))
          );
        } else {
          // POST/PATCH/DELETE: try network, queue if offline (unless excluded)
          e.respondWith(
            fetch(e.request.clone()).catch(async () => {
              if (pathHas(url.pathname, NO_QUEUE)) return offlineResponse(false);
              const body = await e.request.clone().text();
              const queue = JSON.parse(await (await caches.match(OFFLINE_KEY))?.text() || '[]');
              queue.push({ url: e.request.url, method: e.request.method, body, headers: Object.fromEntries(e.request.headers), queued_at: Date.now() });
              const queueResponse = new Response(JSON.stringify(queue));
              await caches.open(CACHE).then(c => c.put(OFFLINE_KEY, queueResponse));
              return offlineResponse(true);
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

    // Sync offline queue when back online. An entry is removed only once it
    // got a definitive answer (2xx, or a 4xx other than 401/408/429 that a
    // retry can't fix); a network error, 401 (signed out), 408/429 or 5xx
    // keeps it for the next sync. Entries past QUEUE_MAX_AGE_MS are dropped.
    self.addEventListener('message', e => {
      if (e.data === 'sync') {
        caches.open(CACHE).then(async cache => {
          const resp = await cache.match(OFFLINE_KEY);
          if (!resp) return;
          const queue = JSON.parse(await resp.text());
          const keep = [];
          let replayed = 0;
          for (const req of queue) {
            if (req.queued_at && Date.now() - req.queued_at > QUEUE_MAX_AGE_MS) continue;
            try {
              const r = await fetch(req.url, { method: req.method, body: req.body, headers: req.headers });
              if (r.ok) { replayed++; continue; }
              if (r.status === 401 || r.status === 408 || r.status === 429 || r.status >= 500) keep.push(req);
            } catch { keep.push(req); }
          }
          if (keep.length) await cache.put(OFFLINE_KEY, new Response(JSON.stringify(keep)));
          else await cache.delete(OFFLINE_KEY);
          if (replayed) self.clients.matchAll().then(clients => clients.forEach(c => c.postMessage('synced')));
        });
      }
    });
  `);
  });

  // PNG icons (favicon.io-generated set). Long max-age cache because the
  // file content is fingerprinted by name; rotating to a new design will
  // either replace the bytes (and the SW cache version bump below
  // invalidates) or drop in differently-named files.
  function sendPng(filePath) {
    return (req, res) => {
      res.setHeader("Cache-Control", "public, max-age=86400");
      res.sendFile(filePath, (err) => {
        if (err) {
          if (!res.headersSent) res.status(404).end();
        }
      });
    };
  }
  router.get("/apple-touch-icon.png", sendPng(APPLE_TOUCH_PNG));
  router.get("/android-chrome-192x192.png", sendPng(ICON_192_PNG));
  router.get("/android-chrome-512x512.png", sendPng(ICON_512_PNG));
  router.get("/android-chrome-mask-crop.png", sendPng(MASK_CROP_PNG));

  return router;
};
