const SHELL = 'shell-v1';
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

// Shell is cache-first. ignoreSearch lets ?p=... pages match the cached index.html.
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  const key = e.request.mode === 'navigate' ? 'index.html' : e.request;
  e.respondWith(caches.match(key, { ignoreSearch: true }).then(hit => hit || fetch(e.request)));
});
