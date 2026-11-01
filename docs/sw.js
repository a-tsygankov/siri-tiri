const CACHE = "siri-tiri-shell-v1";
const SHELL = [
  "./",
  "./companion-app-design.html",
  "./offline.html",
  "./assets/cat-tiri-avatar.png"
];
self.addEventListener("install", event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(SHELL)));
  self.skipWaiting();
});
self.addEventListener("activate", event => {
  event.waitUntil(
    caches.keys().then(keys => Promise.all(keys.filter(key => key.startsWith("siri-tiri-shell-") && key !== CACHE).map(key => caches.delete(key))))
  );
  self.clients.claim();
});
// The phone app under ./app/ has its own worker; never handle (or cache) its requests here,
// including navigations that arrive before the app worker is installed.
const APP_PATH = new URL("./app/", self.location).pathname;
self.addEventListener("fetch", event => {
  const request = event.request;
  if (new URL(request.url).pathname.startsWith(APP_PATH)) return;
  if (request.method !== "GET" || new URL(request.url).origin !== self.location.origin) return;
  if (request.mode === "navigate") {
    event.respondWith(fetch(request).then(response => {
      const copy = response.clone();
      caches.open(CACHE).then(cache => cache.put("./companion-app-design.html", copy));
      return response;
    }).catch(async () => (await caches.match(request)) || (await caches.match("./companion-app-design.html")) || caches.match("./offline.html")));
    return;
  }
  event.respondWith(caches.match(request).then(cached => cached || fetch(request).then(response => {
    if (response.ok) {
      const copy = response.clone();
      caches.open(CACHE).then(cache => cache.put(request, copy));
    }
    return response;
  })));
});