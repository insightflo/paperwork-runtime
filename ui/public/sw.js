const CACHE_NAME = "paperwork-v5";
const CACHE_PREFIX = "paperwork-";

function isHtmlResponse(response) {
  return (response.headers.get("content-type") || "").includes("text/html");
}

function withCacheBypass(url) {
  const next = new URL(url);
  next.searchParams.set("__pc_sw_bust", Date.now().toString(36));
  return next.toString();
}

self.addEventListener("install", (event) => {
  event.waitUntil(self.skipWaiting().catch(() => {}));
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    try {
      const keys = await caches.keys();
      await Promise.all(keys.filter((key) => key.startsWith(CACHE_PREFIX) && key !== CACHE_NAME)
        .map((key) => caches.delete(key).catch(() => false)));
    } catch { /* Cache storage may be unavailable; activation can still proceed. */ }
    await self.clients.claim().catch(() => {});
  })());
});

async function networkFirst(event, url) {
  const { request } = event;
  try {
    let response = await fetch(request);
    if (url.pathname.startsWith("/assets/") && isHtmlResponse(response)) {
      response = await fetch(withCacheBypass(url), { cache: "reload" });
    }
    // Only build assets are safe to persist; never store HTML or redirected API data.
    if (url.pathname.startsWith("/assets/") && response.ok && !response.redirected && !isHtmlResponse(response)) {
      const clone = response.clone();
      event.waitUntil(caches.open(CACHE_NAME)
        .then((cache) => cache.put(request, clone)).catch(() => {}));
    }
    return response;
  } catch {
    try {
      const cache = await caches.open(CACHE_NAME);
      const cached = await cache.match(request);
      if (cached && url.pathname.startsWith("/assets/") && !isHtmlResponse(cached)) return cached;
    } catch { /* A cache failure must still produce a valid offline response. */ }
    return new Response("Offline", { status: 503, headers: { "Content-Type": "text/plain" } });
  }
}

self.addEventListener("fetch", (event) => {
  const { request } = event;
  const url = new URL(request.url);
  // API, mutations, and other origins always use the browser's network path, without cache access.
  if (request.method !== "GET" || url.pathname.startsWith("/api") || url.origin !== self.location.origin) return;
  event.respondWith(networkFirst(event, url));
});
