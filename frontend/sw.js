const CACHE_NAME = 'devicetrade-v2026-10-10-2';
const STATIC_ASSETS = [
  './',
  './index.html',
  './style.css',
  './app.js',
  './manifest.json'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(async (cache) => {
      for (const asset of STATIC_ASSETS) {
        try {
          await cache.add(asset);
        } catch (err) {
          console.warn(`Failed to cache ${asset}:`, err);
        }
      }
    })
  );
});

self.addEventListener('message', (event) => {
  if (event.data?.type === 'SKIP_WAITING') self.skipWaiting();
  if (event.data?.type === 'CACHE_VERSION_UPDATED') {
    caches.keys().then((keys) => Promise.all(keys.map((key) => caches.delete(key))));
    self.skipWaiting();
  }
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.map((k) => k !== CACHE_NAME && caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const requestUrl = new URL(event.request.url);
  if (requestUrl.origin !== self.location.origin) return;

  const isAppAsset = /(?:\.js|\.css|\.html|\.json|\.png|\.svg|\.ico|\.webmanifest)$/.test(requestUrl.pathname)
    || requestUrl.pathname.endsWith('/')
    || requestUrl.pathname.endsWith('/index.html');

  if (event.request.method !== 'GET') return;

  if (isAppAsset) {
    event.respondWith(
      fetch(event.request, { cache: 'no-store' })
        .then((networkResponse) => {
          if (networkResponse.status === 200) {
            const clone = networkResponse.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
          }
          return networkResponse;
        })
        .catch(async () => {
          const cachedResponse = await caches.match(event.request);
          if (cachedResponse) return cachedResponse;
          throw new Error('Network request failed and no cached response exists.');
        })
    );
    return;
  }

  event.respondWith(
    fetch(event.request)
      .then((networkResponse) => {
        if (networkResponse.status === 200) {
          const clone = networkResponse.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
        }
        return networkResponse;
      })
      .catch(async () => {
        const cachedResponse = await caches.match(event.request);
        if (cachedResponse) return cachedResponse;

        if (requestUrl.pathname.includes('/api/')) {
          return new Response(JSON.stringify({
            success: false,
            message: 'Backend unavailable. Check the server URL and try again.'
          }), {
            status: 503,
            headers: { 'Content-Type': 'application/json' }
          });
        }

        throw new Error('Network request failed and no cached response exists.');
      })
  );
});