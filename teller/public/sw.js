// ============================================================================
// Service Worker — Perfin PWA
// ============================================================================

const CACHE = 'perfin-v3';
const OFFLINE_URL = '/offline.html';
const PRECACHE = [
  '/perfin-shared.js',
  '/perfin-shared.css',
  '/logo.svg',
  '/manifest.json',
  OFFLINE_URL,
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
  if (u.pathname.startsWith('/api/')) return;
  // Network-first with cache fallback. On successful fetch, write into the
  // cache so a later offline fetch can serve it. When the network fails AND
  // the cache doesn't have the requested URL AND it's a navigation (HTML
  // request), serve /offline.html so the user sees a branded page instead of
  // the browser's generic "No internet" error.
  e.respondWith(
    fetch(e.request)
      .then((r) => {
        if (r && r.ok && r.type === 'basic') {
          const copy = r.clone();
          caches.open(CACHE).then((c) => c.put(e.request, copy)).catch(() => null);
        }
        return r;
      })
      .catch(async () => {
        const cached = await caches.match(e.request);
        if (cached) return cached;
        if (e.request.mode === 'navigate') {
          const offline = await caches.match(OFFLINE_URL);
          if (offline) return offline;
        }
        // Fall through: let the browser produce its default network-error page
        return Response.error();
      })
  );
});

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
  e.waitUntil(clients.openWindow(e.notification.data.url || '/dashboard'));
});
