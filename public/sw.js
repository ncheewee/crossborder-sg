const CACHE_NAME = "crossborder-sg-v6";
const SHELL_ASSETS = [
  "/crossborder-sg/",
  "/crossborder-sg/index.html",
  "/crossborder-sg/icon.svg",
  "/crossborder-sg/icon-192.png",
  "/crossborder-sg/icon-512.png",
  "/crossborder-sg/apple-touch-icon.png",
  "/crossborder-sg/maskable-icon.svg",
  "/crossborder-sg/maskable-icon-512.png",
  "/crossborder-sg/tuas.jpg",
  "/crossborder-sg/woodlands.jpg"
];

function putIfOk(request, response) {
  if (!response || !response.ok) return response;
  const clone = response.clone();
  caches.open(CACHE_NAME).then((cache) => {
    cache.put(request, clone);
    const url = new URL(request.url);
    if (url.pathname === "/crossborder-sg/" || url.pathname.endsWith("/index.html")) {
      cache.put("/crossborder-sg/index.html", response.clone());
      cache.put("/crossborder-sg/", response.clone());
    }
  });
  return response;
}

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
      .catch(() => self.skipWaiting())
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

  if (request.mode === "navigate" || url.pathname.endsWith("/index.html") || url.pathname === "/crossborder-sg/" || url.pathname === "/crossborder-sg") {
    event.respondWith((async () => {
      const cache = await caches.open(CACHE_NAME);
      const cached = await cache.match(request) || await cache.match("/crossborder-sg/index.html") || await cache.match("/crossborder-sg/");
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 1200);
        const response = await fetch(request, { cache: "no-store", signal: controller.signal });
        clearTimeout(timer);
        if (response.ok) return putIfOk(request, response);
      } catch (_) {
        // Use the last good shell so reopen is never a blank page.
      }
      if (cached) return cached;
      return fetch(request);
    })());
    return;
  }

  if (["script", "style", "worker"].includes(request.destination) || /\.(?:js|css)$/i.test(url.pathname)) {
    event.respondWith(
      caches.match(request).then((cached) => {
        const networked = fetch(request).then((response) => putIfOk(request, response)).catch(() => cached);
        return cached || networked;
      })
    );
    return;
  }

  event.respondWith(
    caches.match(request).then((cached) => cached ?? fetch(request).then((response) => putIfOk(request, response)))
  );
});
