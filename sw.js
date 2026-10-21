const SHELL = 'shell';
const FILES = [
  './', 'index.html', 'app.js', 'style.css', 'manifest.webmanifest',
  'vendor/marked.min.js', 'icons/icon-192.png', 'icons/icon-512.png', 'icons/maskable-512.png',
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(SHELL).then(c => c.addAll(FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k !== SHELL).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

// Shell is stale-while-revalidate: serve the cached copy at once and refresh it for next launch.
// ignoreSearch lets ?p=... pages match the cached index.html.
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
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
