// Offline zuerst: Die App kommt immer aus dem Cache. Eine neue Version installiert
// sich im Hintergrund und wartet, bis die Seite sie per Hinweis-Knopf aktiviert.
// Anfragen an Musikdienste sind fremde Origins und laufen nie durch diesen Worker.
const CACHE = 'umzugskiste-0.1.0';
const SHELL = [
  './', 'manifest.webmanifest', 'deezer-frame.html', 'css/app.css',
  'src/app.js', 'src/ui.js', 'src/runner.js', 'src/model.js', 'src/match.js', 'src/parse.js',
  'src/share.js', 'src/export.js', 'src/errors.js', 'src/transfer.js', 'src/store.js',
  'src/services/index.js', 'src/services/spotify.js', 'src/services/youtube.js', 'src/services/deezer.js',
  'fonts/barlow-latin-400-normal.woff2', 'fonts/barlow-latin-500-normal.woff2', 'fonts/barlow-latin-600-normal.woff2',
  'fonts/big-shoulders-stencil-latin-700-normal.woff2', 'fonts/big-shoulders-stencil-latin-800-normal.woff2',
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
    const hit = await caches.match(req, { ignoreSearch: true });
    if (hit) return hit;
    if (req.mode === 'navigate') {
      const shell = await caches.match('./');
      if (shell) return shell;
    }
    return fetch(req);
  })());
});
