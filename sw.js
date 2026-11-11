/* Offline support: app files are cached; food lookups always go to the network. */
const CACHE = 'cutlog-v114';
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
    e.respondWith(fetch(e.request, { cache: 'no-cache' }).then(r => { const c = r.clone(); caches.open(CACHE).then(k => k.put(e.request, c)); return r; })
      .catch(() => caches.match(e.request, { ignoreSearch: true }).then(r => r || caches.match('index.html'))));
  } else if (libs) {
    e.respondWith(caches.match(e.request).then(hit => hit || fetch(e.request).then(r => { const c = r.clone(); caches.open(CACHE).then(k => k.put(e.request, c)); return r; })));
  }
});
/* v91: alerts from the Cut Log alarm clock (server/cutlog-alerts). Each push is {title, body, url, tag}. */
self.addEventListener('push', e => {
  let m = {}; try { m = e.data ? e.data.json() : {}; } catch (err) { m = { body: e.data ? e.data.text() : '' }; }
  e.waitUntil(self.registration.showNotification(m.title || 'Cut Log', {
    body: m.body || '', tag: m.tag || 'cutlog', icon: 'icons/icon-192.png', badge: 'icons/icon-192.png', data: { url: m.url || './' } }));
});
// Tapping an alert: bring Cut Log forward on the right screen (or open it there)
async function openFromAlert(url) {
  const u = new URL(url || './', self.registration.scope), q = u.searchParams;
  const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  const w = wins.find(c => c.url.startsWith(self.registration.scope));
  if (w) { await w.focus().catch(() => {}); w.postMessage({ cutlog: 'open', open: q.get('open'), slot: q.get('slot') }); return 'focused'; }
  await self.clients.openWindow(u.href); return 'opened';
}
self.addEventListener('notificationclick', e => { e.notification.close(); e.waitUntil(openFromAlert(e.notification.data?.url)); });
