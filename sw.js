/**
 * GroceryCompare SA — Service Worker
 * Caches the app shell for offline access.
 */
const CACHE = 'gc-v2';
const SHELL = ['/', '/grocery.html', '/manifest.json', '/icon.svg'];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const { request } = e;
  const url = new URL(request.url);

  // Cache-first for stable API endpoints (trending, health)
  if (url.pathname === '/api/trending' || url.pathname === '/api/health') {
    e.respondWith(
      caches.match(request).then(cached => {
        if (cached) return cached;
        return fetch(request).then(res => {
          if (res.ok && request.method === 'GET') {
            const clone = res.clone();
            caches.open(CACHE).then(c => c.put(request, clone));
          }
          return res;
        }).catch(() =>
          new Response(JSON.stringify({ error: 'Offline — no cached data' }), {
            headers: { 'Content-Type': 'application/json' },
          })
        );
      })
    );
    return;
  }

  // Network-first for all other API calls (fresh prices)
  if (url.pathname.startsWith('/api/')) {
    e.respondWith(
      fetch(request).catch(() =>
        new Response(JSON.stringify({ error: 'Offline — no cached data' }), {
          headers: { 'Content-Type': 'application/json' },
        })
      )
    );
    return;
  }

  // Cache-first for app shell
  e.respondWith(
    caches.match(request).then(cached => cached || fetch(request).then(res => {
      if (res.ok && request.method === 'GET') {
        const clone = res.clone();
        caches.open(CACHE).then(c => c.put(request, clone));
      }
      return res;
    }))
  );
});
