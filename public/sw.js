const CACHE_NAME = "visual-timer-v4";
const SHELL = ["/manifest.webmanifest", "/icon.svg"];

self.addEventListener("install", (event) => {
  event.waitUntil(precacheAppShell());
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
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

  return caches.match(request).then((cached) => {
    const refresh = fetchAndCache(request);

    if (cached) {
      event.waitUntil(refresh);
      return cached;
    }

    return refresh
      .then((response) => response || (fallbackUrl ? caches.match(fallbackUrl) : undefined))
      .then((response) => response || Response.error());
  });
}

function fetchAndCache(request) {
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

async function precacheAppShell() {
  const cache = await caches.open(CACHE_NAME);
  const indexResponse = await fetch(new Request("/index.html", { cache: "reload" }));
  const indexHtml = await indexResponse.text();
  const indexInit = {
    status: indexResponse.status,
    statusText: indexResponse.statusText
  };

  await Promise.all([
    cache.put("/", new Response(indexHtml, { ...indexInit, headers: new Headers(indexResponse.headers) })),
    cache.put(
      "/index.html",
      new Response(indexHtml, { ...indexInit, headers: new Headers(indexResponse.headers) })
    ),
    cache.addAll(SHELL.map((url) => new Request(url, { cache: "reload" })))
  ]);

  const assetUrls = getSameOriginAssetUrls(indexHtml);
  await cache.addAll(assetUrls.map((url) => new Request(url, { cache: "reload" })));
}

function getSameOriginAssetUrls(html) {
  const urls = new Set();
  const pattern = /\b(?:href|src)="([^"]+)"/g;
  let match;

  while ((match = pattern.exec(html))) {
    const url = normalizeSameOriginUrl(match[1]);
    if (url) {
      urls.add(url);
    }
  }

  return [...urls];
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
