// Offline support for The Completion Job.
// Bump CACHE whenever shipped files change so clients pick up the new version.
const CACHE = 'the-completion-job-v4';
const SHELL = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './planner.js',
  './favicon.svg',
  './manifest.webmanifest',
  './icons/icon-192.svg',
  './icons/icon-maskable.svg',
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

// Same-origin requests: network first so deployments show up promptly, cache as the offline fallback.
// Cross-origin requests (fonts) are left to the browser.
self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET' || new URL(request.url).origin !== self.location.origin) return;
  event.respondWith(
    fetch(request)
      .then((response) => {
        if (response.ok) {
          const copy = response.clone();
          caches.open(CACHE).then((cache) => cache.put(request, copy));
        }
        return response;
      })
      .catch(() => caches.match(request, { ignoreSearch: true }).then((cached) => cached || (request.mode === 'navigate' ? caches.match('./index.html') : Response.error()))),
  );
});

