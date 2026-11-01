// Service worker for the Siri-Tiri phone app.
// A release bumps APP_VERSION here AND in version.js (tests/version.test.mjs enforces it); the
// changed bytes are what makes browsers detect the update.
const APP_VERSION = '0.2.0';
const CACHE = 'siri-tiri-app-' + APP_VERSION;
const PRECACHE = [
  './', './index.html', './app.css', './app.js', './db.js', './records.js', './wav.js',
  './export.js', './recorder.js', './recorder-worklet.js', './version.js', './sync.js',
  './manifest.webmanifest', '../assets/cat-tiri-avatar.png',
];
const SCOPE_PATH = new URL(self.registration.scope).pathname;
const AVATAR_PATH = new URL('../assets/cat-tiri-avatar.png', self.registration.scope).pathname;

// No skipWaiting() here: a new worker waits until the owner taps the Update row.
self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(PRECACHE.map((u) => new Request(u, { cache: 'reload' })))));
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) {
      if (key.startsWith('siri-tiri-app-') && key !== CACHE) await caches.delete(key);
    }
    await self.clients.claim();
  })());
});

self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (!url.pathname.startsWith(SCOPE_PATH) && url.pathname !== AVATAR_PATH) return;
  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const hit = await cache.match(req, { ignoreSearch: req.mode === 'navigate' });
    if (hit) return hit;
    try {
      const res = await fetch(req);
      if (res.ok && res.type === 'basic') cache.put(req, res.clone()).catch(() => {});
      return res;
    } catch (err) {
      if (req.mode === 'navigate') {
        const shell = await cache.match('./index.html');
        if (shell) return shell;
      }
      throw err;
    }
  })());
});
