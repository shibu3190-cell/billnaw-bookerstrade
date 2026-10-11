const CACHE_NAME = 'devicetrade-v2026-10-11-3';
const APP_CACHE_PREFIX = 'devicetrade-';
const STATIC_ASSETS = [
  './',
  './index.html',
  './style.css',
  './csv.js',
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
  if (event.data?.type === 'CLEAR_AND_ACTIVATE' || event.data?.type === 'CACHE_VERSION_UPDATED') {
    event.waitUntil(
      caches.keys()
        .then((keys) => Promise.all(keys
          .filter((key) => key.startsWith(APP_CACHE_PREFIX) && key !== CACHE_NAME)
          .map((key) => caches.delete(key))))
        .then(() => self.skipWaiting())
    );
  }
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((key) => key.startsWith(APP_CACHE_PREFIX) && key !== CACHE_NAME)
        .map((key) => caches.delete(key)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const requestUrl = new URL(event.request.url);
  if (requestUrl.origin !== self.location.origin) return;

  const isAppAsset = /\.(?:js|css|html|json|png|svg|ico|webmanifest)$/i.test(requestUrl.pathname)
    || requestUrl.pathname.endsWith('/')
    || requestUrl.pathname.endsWith('/index.html');

  if (event.request.method !== 'GET') return;

  if (requestUrl.pathname.includes('/api/')) {
    event.respondWith(
      fetch(event.request).catch(() => new Response(JSON.stringify({
        success: false,
        message: 'Backend unavailable. Check the server URL and try again.'
      }), {
        status: 503,
        headers: { 'Content-Type': 'application/json' }
      }))
    );
    return;
  }

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

        throw new Error('Network request failed and no cached response exists.');
      })
  );
});