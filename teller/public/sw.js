// ============================================================================
// Service Worker — Perfin PWA
// ============================================================================
// Derives BASE from self.location.pathname so the same file works whether
// served at /sw.js (standalone) or /perfin/sw.js (under the unified shell).
// Pre-cache and notification-click URLs are all prefixed accordingly.

// self.location is the SW's own URL — e.g. "https://host/perfin/sw.js".
// Strip the trailing "/sw.js" to get the mount prefix ("" or "/perfin").
const BASE = new URL(self.location.href).pathname.replace(/\/sw\.js$/, '');

// v6: offline.html + offline.js changed (F92) — the old cached page had
// CSP-blocked inline handlers and a root-relative logo.
// v7: entries are keyed without their query string (F107) — every ?v= bump
// used to add another copy — so the old cache is dropped on activate.
const CACHE = 'perfin-v7';
const OFFLINE_URL = BASE + '/offline.html';
const PRECACHE = [
  BASE + '/perfin-shared.js',
  BASE + '/perfin-shared.css',
  BASE + '/logo.svg',
  BASE + '/manifest.json',
  OFFLINE_URL,
  BASE + '/offline.js',
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE).then((c) => c.addAll(PRECACHE)).catch(() => null).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  // Drop old cache versions before claiming clients
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  // Don't intercept cross-origin requests — let them pass through to the network
  // directly. Intercepting them causes CSP violations for external CDNs (Teller, fonts).
  const u = new URL(e.request.url);
  if (u.origin !== self.location.origin) return;
  // Don't cache API responses — they're user-specific and time-sensitive,
  // and a stale balance is worse than a clear network error.
  if (u.pathname.startsWith(BASE + '/api/')) return;
  // Network-first with cache fallback. On successful fetch, write into the
  // cache so a later offline fetch can serve it. When the network fails AND
  // the cache doesn't have the requested URL AND it's a navigation (HTML
  // request), serve /offline.html so the user sees a branded page instead of
  // the browser's generic "No internet" error.
  e.respondWith(
    fetch(e.request)
      .then((r) => {
        if (shouldCache(e.request, r)) {
          const copy = r.clone();
          caches.open(CACHE).then((c) => c.put(cacheKey(u), copy)).catch(() => null);
        }
        return r;
      })
      .catch(async () => {
        const cached = await caches.match(cacheKey(u));
        if (cached) return cached;
        if (e.request.mode === 'navigate') {
          const offline = await caches.match(OFFLINE_URL);
          if (offline) return offlineResponse(offline);
        }
        // Fall through: let the browser produce its default network-error page
        return Response.error();
      })
  );
});

// F107: one entry per path — the query string (an asset's ?v=, a page's
// filters) is dropped from the key, so a new ?v= REPLACES the old copy instead
// of piling up next to it.
function cacheKey(u) {
  return u.origin + u.pathname;
}
// Only store a real answer for THIS URL: a redirected response (an expired
// session sends /perfin-shared.js?v=… to the login page) would otherwise be
// stored as the asset, and HTML is stored only for a page navigation.
function shouldCache(req, r) {
  if (!r || !r.ok || r.type !== 'basic' || r.redirected) return false;
  const type = (r.headers.get('content-type') || '').toLowerCase();
  if (type.indexOf('text/html') !== -1 && req.mode !== 'navigate') return false;
  return true;
}

// The offline page is served for whatever URL the user navigated to, so its
// relative logo.svg / offline.js would resolve against THAT path. Inject a
// <base> pointing at the mount so they resolve under BASE (F92).
async function offlineResponse(cached) {
  try {
    const html = await cached.clone().text();
    const body = html.replace('<head>', '<head><base href="' + BASE + '/">');
    // Keep the cached headers (CSP included) but not the original length —
    // the body just grew.
    const headers = new Headers(cached.headers);
    headers.delete('content-length');
    return new Response(body, { status: 200, headers });
  } catch (_) {
    return cached;
  }
}

self.addEventListener('push', (e) => {
  if (!e.data) return;
  const d = e.data.json();
  e.waitUntil(
    self.registration.showNotification(d.title || 'Perfin', {
      body: d.body || '',
      tag: d.tag || 'perfin',
      data: d.data || {},
    })
  );
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  // Notification data may carry a target URL set by the server (e.g.
  // "/dashboard" or "/budgets"). Prepend BASE so the click lands in the
  // app's mount path, not the shell's root.
  const target = (e.notification.data && e.notification.data.url) || '/dashboard';
  const url = target.startsWith('/') ? BASE + target : target;
  e.waitUntil(clients.openWindow(url));
});
