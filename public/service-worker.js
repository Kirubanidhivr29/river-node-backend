// Minimal service worker — just enough to satisfy PWA install requirements.
// It caches the app shell so the UI still opens even with a flaky connection;
// live data always comes fresh from /api/latest (never cached).

const CACHE_NAME = "river-node-shell-v1";
const SHELL_FILES = ["/", "/index.html", "/manifest.json"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL_FILES))
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("fetch", (event) => {
  // Never cache API calls — always go to network for live data
  if (event.request.url.includes("/api/")) {
    return;
  }
  event.respondWith(
    caches.match(event.request).then((cached) => cached || fetch(event.request))
  );
});
