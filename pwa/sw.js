// MushMap service worker. The build fills in VERSION and PRECACHE (see vite.config.ts).
const VERSION = __VERSION__;
const PRECACHE = __PRECACHE__;
const SHELL = `mushmap-shell-${VERSION}`;
const DATA = 'mushmap-data';
const scope = new URL(self.registration.scope);

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SHELL)
      .then((cache) => cache.addAll(PRECACHE.map((p) => new URL(p, scope).href)))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys
        .filter((k) => k.startsWith('mushmap-shell-') && k !== SHELL)
        .map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  // Firebase, map tiles and weather APIs are other origins; the browser handles them.
  if (url.origin !== scope.origin || !url.pathname.startsWith(scope.pathname)) return;

  if (req.mode === 'navigate') {
    // Pages: the newest index.html when online, the cached one offline.
    event.respondWith(networkFirst(req, SHELL, new URL('./', scope).href));
  } else if (url.pathname.startsWith(`${scope.pathname}data/`)) {
    // Heat map, trail and species data change weekly or daily: fresh when online, last copy offline.
    event.respondWith(networkFirst(req, DATA));
  } else {
    // Build files have hashed names, so a cached copy never goes stale.
    event.respondWith(cacheFirst(req, SHELL));
  }
});

async function networkFirst(req, cacheName, fallbackUrl) {
  const cache = await caches.open(cacheName);
  try {
    const res = await fetch(req);
    if (res.ok) cache.put(fallbackUrl ?? req, res.clone());
    return res;
  } catch (err) {
    const hit = await cache.match(fallbackUrl ?? req);
    if (hit) return hit;
    throw err;
  }
}

async function cacheFirst(req, cacheName) {
  const hit = await caches.match(req);
  if (hit) return hit;
  const res = await fetch(req);
  if (res.ok) (await caches.open(cacheName)).put(req, res.clone());
  return res;
}
