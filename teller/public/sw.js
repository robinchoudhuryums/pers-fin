// ============================================================================
// Service Worker — Perfin PWA
// ============================================================================

const CACHE = 'perfin-v1';

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(clients.claim()));

self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  // Don't intercept cross-origin requests — let them pass through to the network
  // directly. Intercepting them causes CSP violations for external CDNs (Teller, fonts).
  const u = new URL(e.request.url);
  if (u.origin !== self.location.origin) return;
  e.respondWith(
    fetch(e.request)
      .then((r) => r)
      .catch(() => caches.match(e.request))
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
