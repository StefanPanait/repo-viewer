const SHELL = 'shell';
const TILES = 'tiles';
const MAX_TILES = 3000;
const FILES = [
  './', 'index.html', 'app.js', 'style.css', 'manifest.webmanifest',
  'vendor/marked.min.js', 'vendor/leaflet.js', 'vendor/leaflet.css', 'icons/icon-192.png', 'icons/icon-512.png', 'icons/maskable-512.png',
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(SHELL).then(c => c.addAll(FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k !== SHELL && k !== TILES).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

// Shell is stale-while-revalidate: serve the cached copy at once and refresh it for next launch.
// ignoreSearch lets ?p=... pages match the cached index.html.
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (url.hostname === 'tile.openstreetmap.org') return e.respondWith(tile(e.request));
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  const key = e.request.mode === 'navigate'
    ? 'index.html'
    : url.pathname.slice(new URL(self.registration.scope).pathname.length) || './';
  e.respondWith(caches.open(SHELL).then(async cache => {
    const hit = await cache.match(key, { ignoreSearch: true });
    const fresh = fetch(key, { cache: 'no-cache' })
      .then(r => { if (r.ok) cache.put(key, r.clone()); return r; });
    if (hit) { e.waitUntil(fresh.catch(() => {})); return hit; }
    return fresh;
  }));
});

// Map tiles seen once stay available offline. Cache keys come back oldest first.
async function tile(req) {
  const cache = await caches.open(TILES);
  const hit = await cache.match(req);
  if (hit) return hit;
  const r = await fetch(req);
  if (r.ok) {
    await cache.put(req, r.clone());
    const keys = await cache.keys();
    await Promise.all(keys.slice(0, keys.length - MAX_TILES).map(k => cache.delete(k)));
  }
  return r;
}
