// Zuerst Netz mit kurzer Frist, damit Updates ankommen, sonst Cache: Die App startet
// offline und im Funkloch. Ein neuer Worker wartet auf den Hinweis-Knopf der Seite.
// Anfragen an Musikdienste sind fremde Origins und laufen nie durch diesen Worker.
const CACHE = 'umzugskiste-0.2.0';
const NET_WAIT = 2500;
const SHELL = [
  './', 'manifest.webmanifest', 'css/app.css', 'assets/explainer.gif', 'assets/explainer.png',
  'src/app.js', 'src/ui.js', 'src/runner.js', 'src/model.js', 'src/match.js', 'src/parse.js',
  'src/share.js', 'src/export.js', 'src/errors.js', 'src/transfer.js', 'src/store.js',
  'src/config.js', 'src/services/index.js', 'src/services/pkce.js', 'src/services/spotify.js', 'src/services/soundcloud.js',
  'icons/icon-192.png', 'icons/icon-512.png', 'icons/maskable-512.png', 'icons/apple-touch-icon.png',
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)));
});
self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});
self.addEventListener('message', e => {
  if (e.data === 'activate') self.skipWaiting();
});
self.addEventListener('fetch', e => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== location.origin) return;
  e.respondWith((async () => {
    const net = fetch(req).then(res => {
      if (res.ok && !url.search) {
        const copy = res.clone();
        caches.open(CACHE).then(c => c.put(req, copy));
      }
      return res;
    });
    const quick = await Promise.race([net, new Promise(r => setTimeout(r, NET_WAIT))]).catch(() => null);
    if (quick) return quick;
    const hit = await caches.match(req, { ignoreSearch: true })
      || (req.mode === 'navigate' ? await caches.match('./') : null);
    return hit || net;
  })());
});
