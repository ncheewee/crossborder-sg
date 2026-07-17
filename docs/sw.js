const CACHE_NAME = "crossborder-sg-v1";
const SHELL_ASSETS = [
  "/crossborder-sg/",
  "/crossborder-sg/index.html",
  "/crossborder-sg/icon.svg",
  "/crossborder-sg/maskable-icon.svg",
  "/crossborder-sg/tuas.jpg",
  "/crossborder-sg/woodlands.jpg"
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(SHELL_ASSETS))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;
  const url = new URL(request.url);

  if (url.hostname.includes("crossborder-sg-api")) {
    event.respondWith(fetch(request).catch(() => caches.match("/crossborder-sg/index.html")));
    return;
  }

  if (url.origin === self.location.origin && url.pathname.startsWith("/crossborder-sg/")) {
    event.respondWith(
      caches.match(request).then((cached) => cached ?? fetch(request).then((response) => {
        const clone = response.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(request, clone));
        return response;
      }).catch(() => caches.match("/crossborder-sg/index.html")))
    );
  }
});
