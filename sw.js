/* JSP Extender Control — service worker (relative paths for GitHub Pages). */

const CACHE_VERSION = 'v7';
const CACHE_NAME = `jsp-extender-${CACHE_VERSION}`;

/* All paths are relative so the app works under /<repo-name>/ on GitHub Pages. */
const PRECACHE_URLS = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './config.js',
  './manifest.json',
  './icons/favicon.svg',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png'
];

/* Never cache authenticated API traffic. */
const BYPASS_PATTERN = /(supabase\.co|supabase\.in|\/auth\/v1\/|\/rest\/v1\/|\/realtime\/v1\/)/;

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then((cache) => cache.addAll(PRECACHE_URLS))
      .catch(() => undefined)
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;

  if (request.method !== 'GET' || BYPASS_PATTERN.test(request.url)) return;

  /* App shell navigations: network first, cached shell as the offline fallback. */
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((response) => {
          const copy = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put('./index.html', copy)).catch(() => undefined);
          return response;
        })
        .catch(async () => {
          const cache = await caches.open(CACHE_NAME);
          return (await cache.match('./index.html')) || (await cache.match('./')) || Response.error();
        })
    );
    return;
  }

  /* Same-origin assets: stale-while-revalidate. */
  const sameOrigin = new URL(request.url).origin === self.location.origin;

  if (sameOrigin) {
    event.respondWith(
      caches.open(CACHE_NAME).then(async (cache) => {
        const cached = await cache.match(request);
        const network = fetch(request)
          .then((response) => {
            if (response && response.status === 200 && response.type === 'basic') {
              cache.put(request, response.clone()).catch(() => undefined);
            }
            return response;
          })
          .catch(() => cached);
        return cached || network;
      })
    );
    return;
  }

  /* Cross-origin (Supabase JS CDN): network first, then cache. */
  event.respondWith(
    fetch(request)
      .then((response) => {
        if (response && (response.status === 200 || response.type === 'opaque')) {
          const copy = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(request, copy)).catch(() => undefined);
        }
        return response;
      })
      .catch(async () => {
        const cache = await caches.open(CACHE_NAME);
        return (await cache.match(request)) || Response.error();
      })
  );
});
