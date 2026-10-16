/* Offline support: app files are cached; food lookups always go to the network. */
const CACHE = 'cutlog-v2';
const SHELL = ['./', 'index.html', 'style.css', 'app.js', 'foods.js', 'firebase-config.js', 'manifest.webmanifest', 'icons/icon-180.png', 'icons/icon-192.png', 'icons/icon-512.png'];
self.addEventListener('install', e => { e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting())); });
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.hostname.endsWith('openfoodfacts.org') || url.hostname.endsWith('googleapis.com') && !url.hostname.startsWith('fonts.')) return;
  const libs = /(unpkg\.com|cdn\.jsdelivr\.net|www\.gstatic\.com|fonts\.(googleapis|gstatic)\.com)$/.test(url.hostname);
  if (url.origin === location.origin) {
    // network first so updates arrive, cache as fallback for offline
    e.respondWith(fetch(e.request).then(r => { const c = r.clone(); caches.open(CACHE).then(k => k.put(e.request, c)); return r; })
      .catch(() => caches.match(e.request).then(r => r || caches.match('index.html'))));
  } else if (libs) {
    e.respondWith(caches.match(e.request).then(hit => hit || fetch(e.request).then(r => { const c = r.clone(); caches.open(CACHE).then(k => k.put(e.request, c)); return r; })));
  }
});
