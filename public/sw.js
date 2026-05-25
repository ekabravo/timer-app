const CACHE_NAME = "visual-timer-dev";
const PRECACHE_URLS = ["/", "/index.html", "/manifest.webmanifest", "/icon.svg"];
const DISABLE_CACHE = isDevelopmentHost(self.location.hostname);

self.addEventListener("install", (event) => {
  if (DISABLE_CACHE) {
    self.skipWaiting();
    return;
  }

  event.waitUntil(precacheApp());
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  if (DISABLE_CACHE) {
    event.waitUntil(
      caches
        .keys()
        .then((keys) =>
          Promise.all(
            keys.filter((key) => key.startsWith("visual-timer-")).map((key) => caches.delete(key))
          )
        )
        .then(() => self.registration.unregister())
    );
    self.clients.claim();
    return;
  }

  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key)))
      )
  );
  self.clients.claim();
});

self.addEventListener("message", (event) => {
  if (DISABLE_CACHE) {
    return;
  }

  if (event.data?.type !== "WARM_CACHE" || !Array.isArray(event.data.urls)) {
    return;
  }

  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) =>
      Promise.all(
        event.data.urls
          .map((url) => normalizeSameOriginUrl(url))
          .filter(Boolean)
          .map((url) =>
            cache.add(new Request(url, { cache: "reload" })).catch(() => undefined)
          )
      )
    )
  );
});

self.addEventListener("fetch", (event) => {
  if (DISABLE_CACHE) {
    return;
  }

  if (event.request.method !== "GET") {
    return;
  }

  const requestUrl = new URL(event.request.url);
  if (requestUrl.origin !== self.location.origin) {
    return;
  }

  if (event.request.mode === "navigate") {
    event.respondWith(cacheFirst(event, "/index.html"));
    return;
  }

  event.respondWith(cacheFirst(event));
});

function cacheFirst(event, fallbackUrl) {
  const { request } = event;

  return caches.match(request, { ignoreVary: true }).then((cached) => {
    const refresh = fetchAndCache(request);

    if (cached) {
      event.waitUntil(refresh);
      return cached;
    }

    return refresh
      .then((response) =>
        response || (fallbackUrl ? caches.match(fallbackUrl, { ignoreVary: true }) : undefined)
      )
      .then((response) => response || Response.error());
  });
}

async function fetchAndCache(request) {
  return fetch(request)
    .then(async (response) => {
      if (response.ok && response.type === "basic") {
        const copy = response.clone();
        const cache = await caches.open(CACHE_NAME);
        await cache.put(request, copy);
      }

      return response;
    })
    .catch(() => undefined);
}

async function precacheApp() {
  const cache = await caches.open(CACHE_NAME);
  await cache.addAll(
    PRECACHE_URLS.map((url) => new Request(url, { cache: "reload" }))
  );
}

function normalizeSameOriginUrl(value) {
  try {
    const url = new URL(value, self.location.origin);
    if (url.origin !== self.location.origin || url.pathname === "/sw.js") {
      return null;
    }

    return `${url.pathname}${url.search}`;
  } catch {
    return null;
  }
}

function isDevelopmentHost(hostname) {
  return (
    hostname === "localhost" ||
    hostname === "0.0.0.0" ||
    hostname === "127.0.0.1" ||
    hostname === "::1" ||
    hostname.startsWith("127.") ||
    hostname.startsWith("10.") ||
    hostname.startsWith("192.168.") ||
    /^172\.(1[6-9]|2\d|3[0-1])\./.test(hostname)
  );
}
