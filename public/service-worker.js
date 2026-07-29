// Minimal service worker — just enough to satisfy PWA install requirements.
// It caches the app shell so the UI still opens even with a flaky connection;
// live data always comes fresh from /api/latest (never cached).
//
// IMPORTANT: bump CACHE_NAME any time you deploy a meaningful update to
// index.html — this forces old installed/cached copies to refresh instead
// of silently sticking around forever.

const CACHE_NAME = "river-node-shell-v4";
const SHELL_FILES = ["/", "/index.html", "/manifest.json"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL_FILES))
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((names) =>
      Promise.all(
        names.map((name) => {
          if (name !== CACHE_NAME) return caches.delete(name);
        })
      )
    ).then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  // Never cache API calls — always go to network for live data
  if (event.request.url.includes("/api/")) {
    return;
  }
  // Network-first for the app shell: always try to get the freshest copy,
  // only fall back to cache if the network request fails (offline).
  event.respondWith(
    fetch(event.request)
      .then((response) => {
        const clone = response.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
        return response;
      })
      .catch(() => caches.match(event.request))
  );
});
