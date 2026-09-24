// Офлайн-кэш приложения. При деплое метка версии заменяется на хэш коммита:
// новый хэш → новый кэш → старый удаляется, приложение обновляется целиком.
const VERSION = '__BUILD__';
const CACHE = `treker-${VERSION}`;
const ASSETS = [
  './',
  './index.html',
  './css/style.css',
  './js/app.js',
  './js/db.js',
  './js/logic.js',
  './js/charts.js',
  './js/sync.js',
  './manifest.webmanifest',
  './icons/icon.svg',
  './icons/apple-touch-icon.png',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE)
      // cache: 'reload' — мимо HTTP-кэша, иначе можно закэшировать старые файлы
      .then((cache) => cache.addAll(ASSETS.map((url) => new Request(url, { cache: 'reload' }))))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('treker-') && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET' || new URL(request.url).origin !== self.location.origin) return;
  event.respondWith(
    caches.match(request, { ignoreSearch: true }).then((hit) => hit ?? fetch(request).catch(() => {
      if (request.mode === 'navigate') return caches.match('./index.html');
      return Response.error();
    })),
  );
});
