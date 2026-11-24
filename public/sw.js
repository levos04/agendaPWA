/* Service Worker de Agenda PWA
 *
 * Estrategias de caché:
 *  - Precaché del "app shell" en install (HTML, CSS, JS, íconos, offline.html)
 *  - Navegación (HTML): Network First → caché → offline.html
 *  - Recursos estáticos (CSS/JS/imágenes): Stale-While-Revalidate
 *  - API GET (/api/*): Network First con respaldo en caché
 *  - API POST: solo red (los cambios offline viven en la outbox de IndexedDB)
 *
 * Además: Background Sync, Push y clic en notificaciones.
 */
importScripts('/js/db.js');

const VERSION = 'v1.0.2';
const SHELL_CACHE = `agenda-shell-${VERSION}`;
const RUNTIME_CACHE = `agenda-runtime-${VERSION}`;
const API_CACHE = `agenda-api-${VERSION}`;

const APP_SHELL = [
  '/',
  '/index.html',
  '/offline.html',
  '/css/styles.css',
  '/js/db.js',
  '/js/app.js',
  '/manifest.webmanifest',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/maskable-512.png',
  '/icons/badge-72.png',
  '/icons/apple-touch-icon.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE).then((cache) => cache.addAll(APP_SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  const keep = [SHELL_CACHE, RUNTIME_CACHE, API_CACHE];
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => !keep.includes(k)).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== self.location.origin) return;

  if (request.mode === 'navigate') {
    event.respondWith(networkFirstPage(request));
  } else if (url.pathname.startsWith('/api/')) {
    event.respondWith(networkFirst(request, API_CACHE));
  } else {
    event.respondWith(staleWhileRevalidate(request));
  }
});

async function networkFirstPage(request) {
  try {
    const response = await fetch(request);
    const isAppPage = !new URL(request.url).pathname.endsWith('.html') || request.url.endsWith('/index.html');
    if (response.ok && isAppPage) {
      const cache = await caches.open(SHELL_CACHE);
      cache.put('/index.html', response.clone());
    }
    return response;
  } catch {
    return (
      (await caches.match('/index.html')) ||
      (await caches.match('/')) ||
      (await caches.match('/offline.html'))
    );
  }
}

async function networkFirst(request, cacheName) {
  const cache = await caches.open(cacheName);
  try {
    const response = await fetch(request);
    if (response.ok) cache.put(request, response.clone());
    return response;
  } catch {
    const cached = await cache.match(request);
    return (
      cached ||
      new Response(JSON.stringify({ error: 'offline' }), {
        status: 503,
        headers: { 'Content-Type': 'application/json' }
      })
    );
  }
}

async function staleWhileRevalidate(request) {
  const cached = await caches.match(request);
  const network = fetch(request)
    .then(async (response) => {
      if (response.ok) {
        const cache = await caches.open(RUNTIME_CACHE);
        cache.put(request, response.clone());
      }
      return response;
    })
    .catch(() => undefined);
  return cached || (await network) || caches.match('/offline.html');
}

// ---------- Background Sync ----------
self.addEventListener('sync', (event) => {
  if (event.tag === 'sync-activities') {
    event.waitUntil(
      self.AgendaDB.syncNow().then(async ({ sent }) => {
        const clients = await self.clients.matchAll({ includeUncontrolled: true });
        clients.forEach((c) => c.postMessage({ type: 'SYNC_DONE', sent }));
      })
      // Si falla (sin red), la promesa rechazada hace que el navegador reintente más tarde
    );
  }
});

// ---------- Push ----------
self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { body: event.data && event.data.text() };
  }
  const title = data.title || 'Agenda PWA';
  event.waitUntil(
    self.registration.showNotification(title, {
      body: data.body || 'Tienes una notificación nueva',
      icon: '/icons/icon-192.png',
      badge: '/icons/badge-72.png',
      tag: data.tag,
      renotify: !!data.tag,
      vibrate: [100, 50, 100],
      data: { url: data.url || '/' },
      actions: [{ action: 'open', title: 'Abrir agenda' }]
    })
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = new URL(event.notification.data?.url || '/', self.location.origin).href;
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
      for (const client of clients) {
        if (new URL(client.url).origin === self.location.origin) {
          client.navigate(target).catch(() => {});
          return client.focus();
        }
      }
      return self.clients.openWindow(target);
    })
  );
});
