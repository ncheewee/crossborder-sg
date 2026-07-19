const CACHE_NAME = "crossborder-sg-v4";
const SHELL_ASSETS = [
  "/crossborder-sg/icon.svg",
  "/crossborder-sg/icon-192.png",
  "/crossborder-sg/icon-512.png",
  "/crossborder-sg/apple-touch-icon.png",
  "/crossborder-sg/maskable-icon.svg",
  "/crossborder-sg/maskable-icon-512.png",
  "/crossborder-sg/tuas.jpg",
  "/crossborder-sg/woodlands.jpg"
];

self.addEventListener("message", (event) => {
  if (event.data?.type === "SKIP_WAITING") {
    self.skipWaiting();
  }
});

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
  const isAppRequest = url.origin === self.location.origin && url.pathname.startsWith("/crossborder-sg/");

  if (url.hostname.includes("crossborder-sg-api")) {
    event.respondWith(fetch(request));
    return;
  }

  if (!isAppRequest) return;

  if (request.mode === "navigate" || url.pathname.endsWith("/index.html") || url.pathname === "/crossborder-sg/") {
    event.respondWith(
      fetch(request, { cache: "no-store" }).then((response) => {
        const clone = response.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(request, clone));
        return response;
      }).catch(() => caches.match(request).then((cached) => cached ?? caches.match("/crossborder-sg/index.html")))
    );
    return;
  }

  if (["script", "style", "worker"].includes(request.destination) || /\.(?:js|css)$/i.test(url.pathname)) {
    event.respondWith(
      fetch(request, { cache: "no-store" }).then((response) => {
        const clone = response.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(request, clone));
        return response;
      }).catch(() => caches.match(request))
    );
    return;
  }

  event.respondWith(
    caches.match(request).then((cached) => cached ?? fetch(request).then((response) => {
      const clone = response.clone();
      caches.open(CACHE_NAME).then((cache) => cache.put(request, clone));
      return response;
    }))
  );
});
