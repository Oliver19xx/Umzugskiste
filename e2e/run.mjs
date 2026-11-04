// Browser-Test mit nachgebauten Dienst-APIs. Start: npm run e2e (Port 5199).
// Getestet werden Ablauf, Offline und Fehlerpfade. Echte Dienste sind hier nicht beteiligt.
import { createRequire } from 'node:module';
import { execSync } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync, existsSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join } from 'node:path';
import assert from 'node:assert/strict';

const require = createRequire(`${execSync('npm root -g').toString().trim()}/`);
const { chromium, devices } = require('playwright');
const PORT = 5199, BASE = `http://127.0.0.1:${PORT}/`;
mkdirSync('e2e/shots', { recursive: true });

// Liefert das Repo aus und setzt für den Test SoundCloud-Einstellungen ein.
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.gif': 'image/gif', '.woff2': 'font/woff2', '.webmanifest': 'application/manifest+json' };
const server = createServer((req, res) => {
  const path = decodeURIComponent(new URL(req.url, BASE).pathname);
  if (path === '/src/config.js') {
    res.writeHead(200, { 'Content-Type': 'text/javascript' });
    res.end("export const CONFIG = { soundcloudClientId: 'scid', soundcloudTokenUrl: 'https://test.supabase.co/functions/v1/soundcloud-token' };");
    return;
  }
  let file = join('.', path);
  if (existsSync(file) && statSync(file).isDirectory()) file = join(file, 'index.html');
  if (!existsSync(file)) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'Content-Type': TYPES[extname(file)] || 'application/octet-stream' });
  res.end(readFileSync(file));
}).listen(PORT, '127.0.0.1');

const consoleErrors = [];
const watch = page => {
  page.on('pageerror', e => consoleErrors.push(`pageerror: ${e.message}`));
  page.on('console', m => { if (m.type() === 'error' && !/ERR_INTERNET_DISCONNECTED|Failed to load resource/.test(m.text())) consoleErrors.push(m.text()); });
};

const ok = name => console.log(`ok  ${name}`);
const shot = (page, name) => page.screenshot({ path: `e2e/shots/${name}.png` });
const json = (route, body, status = 200, headers = {}) => route.fulfill({ status, contentType: 'application/json', headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*', ...headers }, body: JSON.stringify(body) });

// Nachgebautes Spotify nach den Dev-Mode-Regeln: limit > 10 bei der Suche gibt 400.
function fakeSpotify(state) {
  return async route => {
    const req = route.request();
    const url = new URL(req.url());
    const p = url.pathname.replace('/v1', '');
    state.calls.push(`${req.method()} ${p}`);
    if (req.method() === 'OPTIONS') return json(route, {});
    if (url.host === 'accounts.spotify.com') return json(route, { access_token: 'tok', refresh_token: 'r', expires_in: 3600 });
    if (p === '/me/playlists' && req.method() === 'GET') return json(route, { items: [{ id: 'pl1', name: 'Peak Time', items: { total: 3 } }], total: 1, next: null });
    if (p === '/me/playlists' && req.method() === 'POST') { state.created.push(JSON.parse(req.postData()).name); return json(route, { id: 'new1', external_urls: { spotify: 'https://open.spotify.com/playlist/new1' } }); }
    if (p === '/playlists/pl1') return json(route, { name: 'Peak Time' });
    if (p === '/playlists/pl1/items') {
      const tr = (id, name, artist, isrc) => ({ item: { id, name, type: 'track', uri: `spotify:track:${id}`, duration_ms: 300000, artists: [{ name: artist }], album: { name: 'LP' }, external_ids: { isrc } } });
      return json(route, { items: [tr('a', 'Glue', 'Bicep', 'GBAAA1111111'), tr('b', 'Strobe (Extended Mix)', 'deadmau5', ''), tr('c', 'Gibt Es Nicht', 'Niemand', '')], total: 3, next: null });
    }
    if (p === '/playlists/new1/items' && req.method() === 'GET') return json(route, { items: [], total: 0, next: null });
    if (p === '/playlists/new1/items') { state.added.push(...JSON.parse(req.postData()).uris); return json(route, { snapshot_id: 'x' }, 201); }
    if (p === '/search') {
      const limit = Number(url.searchParams.get('limit'));
      if (limit > 10) return json(route, { error: { message: 'Invalid limit' } }, 400);
      const q = url.searchParams.get('q');
      const hit = (id, name, artist, ms = 300000) => ({ id, name, uri: `spotify:track:${id}`, artists: [{ name: artist }], duration_ms: ms, external_urls: { spotify: `https://open.spotify.com/track/${id}` } });
      if (q.includes('One More Time')) return json(route, { tracks: { items: [hit('omt', 'One More Time', 'Daft Punk')] } });
      if (q.includes('Glue')) return json(route, { tracks: { items: [hit('glue', 'Glue', 'Bicep')] } });
      if (q.includes('Strobe')) return json(route, { tracks: { items: [hit('st', 'Strobe - Radio Edit', 'deadmau5', 210000)] } });
      return json(route, { tracks: { items: [] } });
    }
    return json(route, { error: { message: `nicht nachgebaut: ${p}` } }, 404);
  };
}

const browser = await chromium.launch();
try {
  /* Offline-Pfad */
  const ctx = await browser.newContext({ viewport: { width: 1100, height: 800 } });
  const state = { calls: [], created: [], added: [] };
  await ctx.route(/api\.spotify\.com|accounts\.spotify\.com/, fakeSpotify(state));
  const page = await ctx.newPage();
  watch(page);
  await page.goto(BASE);
  await page.waitForSelector('h1');
  await shot(page, 'leer');
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.reload();
  await page.waitForFunction(() => navigator.serviceWorker.controller);
  await ctx.setOffline(true);
  await page.reload();
  await page.waitForSelector('.intro h1');
  assert.equal(await page.locator('#net').isVisible(), true);
  ok('Start ohne Netz aus dem Cache');

  await page.click('text=Neue Kiste');
  await page.fill('#textName', 'Offline gepackt');
  await page.fill('#textBody', 'Daft Punk - One More Time\nBicep - Glue\nDeadmau5 - Strobe (Extended Mix)\nNiemand - Gibt Es Nicht\n<img src=x onerror=alert(1)> - XSS');
  await page.click('text=Einpacken');
  await page.waitForSelector('.title-input');
  assert.equal(await page.locator('.track').count(), 5);
  assert.equal(await page.locator('img[src=x]').count(), 0);
  ok('Kiste offline gepackt, HTML im Titel bleibt Text');
  await shot(page, 'kiste');

  const [dl] = await Promise.all([page.waitForEvent('download'), (async () => {
    await page.click('[aria-label=Mehr]');
    await page.click('dialog button:has-text("CSV")');
  })()]);
  assert.match(dl.suggestedFilename(), /Offline gepackt\.csv/);
  ok('CSV-Export offline');

  /* Spotify-Anmeldung simulieren, Umzug offline einreihen, online fortsetzen */
  await page.evaluate(() => {
    localStorage.setItem('uk.spotify.clientId', '"abcabcabcabcabcabcabcabc"');
    localStorage.setItem('uk.spotify.session', JSON.stringify({ access: 't', refresh: 'r', exp: Date.now() + 3600e3 }));
  });
  await page.click('text=Umziehen');
  await page.waitForSelector('#targetName');
  await page.click('button:has-text("Nach Spotify umziehen")');
  await page.waitForSelector('#jobLine');
  assert.match(await page.textContent('#jobLine'), /Wartet auf den Start/);
  ok('Umzug offline eingereiht');
  await ctx.setOffline(false);
  await page.evaluate(() => dispatchEvent(new Event('online')));
  await page.waitForSelector('text=Wartet auf dich');
  assert.equal(await page.locator('.review').count(), 1);
  assert.ok(state.calls.every(c => !c.includes('/tracks')), 'keine alten Spotify-Pfade');
  ok('Läuft online von selbst weiter und hält bei unsicherem Treffer');
  await shot(page, 'pruefen');
  await page.click('.review button:has-text("Nehmen")');
  await page.waitForFunction(() => !document.querySelector('.review'));
  await page.click('button:has-text("eintragen")');
  await page.waitForSelector('text=In Spotify öffnen');
  assert.deepEqual(state.created, ['Offline gepackt']);
  assert.deepEqual(state.added.sort(), ['spotify:track:glue', 'spotify:track:omt', 'spotify:track:st'].sort());
  ok('Songs eingetragen, nur eine Playlist angelegt');
  await page.click('[aria-label=Mehr]');
  await page.click('dialog button:has-text("nicht gefunden")');
  await page.waitForSelector('dialog:has-text("Selbst suchen")');
  await shot(page, 'fertig');
  await page.click('dialog .done');

  /* Spotify als Quelle */
  await page.goto(`${BASE}#/new/spotify`);
  await page.waitForSelector('text=Peak Time');
  await page.check('label:has-text("Peak Time") input');
  await page.click('button:has-text("Auswahl einpacken")');
  await page.waitForSelector('.box-name:has-text("Peak Time")');
  ok('Spotify-Playlist eingelesen');
  await page.waitForTimeout(200);
  await shot(page, 'kisten');

  /* Teilen */
  await ctx.grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.click('.box-name:has-text("Peak Time")');
  await page.click('button:has-text("Teilen")');
  await page.waitForSelector('#toast:has-text("Link kopiert")');
  const link = await page.evaluate(() => navigator.clipboard.readText());
  assert.match(link, /#s=/);
  const friendCtx = await browser.newContext(devices['iPhone 13']);
  const friend = await friendCtx.newPage();
  watch(friend);
  const fresh = await friendCtx.newPage();
  await fresh.goto(BASE);
  await fresh.waitForSelector('.intro img');
  await fresh.waitForTimeout(1800);
  await shot(fresh, 'mobil-start');
  await fresh.click('.head .icon');
  await fresh.waitForTimeout(350);
  await shot(fresh, 'mobil-info');
  await fresh.close();
  await friend.goto(link);
  await friend.waitForSelector('text=wurden mit dir geteilt');
  await friend.click('text=In meine Kisten legen');
  await friend.waitForSelector('.title-input');
  assert.equal(await friend.locator('.track').count(), 3);
  ok('Geteilter Link öffnet die Kiste auf anderem Gerät');
  await friend.waitForTimeout(200);
  await shot(friend, 'mobil-kiste');
  await friend.goto(`${BASE}#/settings`);
  await friend.waitForSelector('text=Client ID kopieren');
  await shot(friend, 'mobil-dienste');
  const over = await friend.evaluate(() => document.documentElement.scrollWidth > innerWidth);
  assert.equal(over, false, 'kein seitliches Scrollen');
  ok('Mobil ohne seitliches Scrollen');
  await friendCtx.close();

  /* OAuth-Rückweg Spotify */
  await page.evaluate(() => {
    localStorage.removeItem('uk.spotify.session');
    localStorage.setItem('uk.spotify.state', '"sp.xyz"');
    localStorage.setItem('uk.spotify.verifier', '"ver"');
  });
  await page.goto(`${BASE}?code=abc&state=sp.bad`);
  await page.waitForSelector('#toast:has-text("nicht bestätigen")');
  assert.equal(await page.evaluate(() => localStorage.getItem('uk.spotify.session')), null);
  await page.evaluate(() => {
    localStorage.setItem('uk.spotify.state', '"sp.xyz"');
    localStorage.setItem('uk.spotify.verifier', '"ver"');
  });
  await page.goto(`${BASE}?code=abc&state=sp.xyz`);
  await page.waitForFunction(() => localStorage.getItem('uk.spotify.session'));
  assert.equal(new URL(page.url()).search, '');
  ok('Spotify-Login prüft state, Code verschwindet aus der Adresse');

  /* SoundCloud: Login über Token-Funktion, Quelle, Ziel, Zusammenführen, Limit */
  const sc = { put: [], token: [], lists: { 'soundcloud:playlists:1': ['soundcloud:tracks:old'] }, limit: false };
  const upload = (n, title, user = 'Label') => ({ urn: `soundcloud:tracks:${n}`, title, duration: 300000, user: { username: user }, permalink_url: `https://soundcloud.com/x/${n}`, access: 'playable' });
  await ctx.route(/supabase\.co/, route => {
    if (route.request().method() === 'OPTIONS') return json(route, {});
    const body = JSON.parse(route.request().postData());
    sc.token.push(body);
    return json(route, { access_token: `tok${sc.token.length}`, refresh_token: `ref${sc.token.length}`, expires_in: 3600 });
  });
  await ctx.route(/api\.soundcloud\.com/, route => {
    const req = route.request();
    const url = new URL(req.url());
    const p = decodeURIComponent(url.pathname);
    if (req.method() === 'OPTIONS') return json(route, {});
    assert.match(req.headers().authorization || '', /^OAuth /);
    if (req.headers().authorization === 'OAuth expired') return json(route, {}, 401);
    if (p === '/me/playlists') return json(route, { collection: [{ urn: 'soundcloud:playlists:1', title: 'Warm-up Set', track_count: 1 }], next_href: null });
    if (p === '/me/likes/tracks') return json(route, { collection: [upload(1, 'Aphex Twin - Windowlicker')], next_href: null });
    if (p === '/playlists/soundcloud:playlists:1' && req.method() === 'GET') return json(route, { urn: 'soundcloud:playlists:1', title: 'Warm-up Set' });
    if (p.endsWith('/tracks') && p.startsWith('/playlists/')) return json(route, { collection: (sc.lists[p.split('/')[2]] || []).map(urn => ({ urn })), next_href: null });
    if (p === '/playlists' && req.method() === 'POST') { const urn = 'soundcloud:playlists:2'; sc.lists[urn] = []; return json(route, { urn, permalink_url: 'https://soundcloud.com/me/sets/neu' }, 201); }
    if (p.startsWith('/playlists/') && req.method() === 'PUT') {
      const urn = p.split('/')[2];
      const tracks = JSON.parse(req.postData()).playlist.tracks.map(t => t.urn);
      sc.put.push(tracks); sc.lists[urn] = tracks;
      return json(route, { urn, track_count: tracks.length });
    }
    if (p === '/tracks') {
      if (sc.limit) return json(route, {}, 429, { 'Retry-After': '3600' });
      const q = url.searchParams.get('q');
      return json(route, { collection: q.includes('Glue') ? [upload(7, 'Bicep - Glue')] : [], next_href: null });
    }
    return json(route, { message: `nicht nachgebaut: ${p}` }, 404);
  });
  await page.evaluate(() => {
    localStorage.setItem('uk.soundcloud.state', '"sc.ok"');
    localStorage.setItem('uk.soundcloud.verifier', '"ver"');
  });
  await page.goto(`${BASE}?code=abc&state=sc.ok`);
  await page.waitForFunction(() => localStorage.getItem('uk.soundcloud.session'));
  assert.equal(sc.token[0].grant_type, 'authorization_code');
  assert.equal(JSON.stringify(sc.token[0]).includes('secret'), false);
  ok('SoundCloud-Login über Token-Funktion, ohne Secret im Browser');

  await page.goto(`${BASE}#/new/soundcloud`);
  await page.waitForSelector('text=Warm-up Set');
  await page.check('label:has-text("Gelikte Tracks") input');
  await page.click('button:has-text("Auswahl einpacken")');
  await page.waitForSelector('.box-name:has-text("Gelikte Tracks")');
  await page.click('.box-name:has-text("Gelikte Tracks")');
  await page.waitForSelector('.track:has-text("Windowlicker")');
  assert.equal(await page.getAttribute('.track a', 'href'), 'https://soundcloud.com/x/1');
  ok('SoundCloud-Likes eingelesen, mit Link zum Original');

  await page.goto(`${BASE}#/`);
  await page.click('.box-name:has-text("Peak Time")');
  await page.click('text=Umziehen');
  await page.click('[role=tab]:has-text("SoundCloud")');
  await page.waitForSelector('label:has-text("Warm-up Set")');
  assert.ok(await page.locator('.soon li:has-text("Apple Music")').isVisible());
  await shot(page, 'ziel');
  await page.click('button:has-text("Nach SoundCloud umziehen")');
  await page.waitForSelector('text=In SoundCloud öffnen');
  assert.deepEqual(sc.put.at(-1), ['soundcloud:tracks:7']);
  ok('Neues SoundCloud-Set angelegt');

  await page.goto(`${BASE}#/`);
  await page.click('.box-name:has-text("Peak Time")');
  await page.click('text=Umziehen');
  await page.click('[role=tab]:has-text("SoundCloud")');
  await page.click('label:has-text("Warm-up Set")');
  await page.click('button:has-text("Nach SoundCloud umziehen")');
  await page.waitForFunction(() => document.body.textContent.includes('Fertig'));
  assert.deepEqual(sc.lists['soundcloud:playlists:1'], ['soundcloud:tracks:old', 'soundcloud:tracks:7']);
  ok('Bestehendes Set behält seine Tracks');

  await page.evaluate(() => {
    const s = JSON.parse(localStorage.getItem('uk.soundcloud.session'));
    localStorage.setItem('uk.soundcloud.session', JSON.stringify({ ...s, access: 'expired' }));
  });
  await page.goto(`${BASE}#/new/soundcloud`);
  await page.waitForSelector('text=Warm-up Set');
  assert.equal(sc.token.at(-1).grant_type, 'refresh_token');
  ok('Abgelaufenes Token wird einmal erneuert');

  sc.limit = true;
  await page.evaluate(async () => { const r = indexedDB.open('umzugskiste'); await new Promise(o => { r.onsuccess = o; }); const t = r.result.transaction('cache', 'readwrite'); t.objectStore('cache').clear(); });
  await page.goto(`${BASE}#/`);
  await page.click('.box-name:has-text("Offline gepackt")');
  await page.click('text=Umziehen');
  await page.click('[role=tab]:has-text("SoundCloud")');
  await page.click('button:has-text("Nach SoundCloud umziehen")');
  await page.waitForSelector('text=SoundCloud-Limit');
  assert.match(await page.textContent('p.notice'), /Weiter ab/);
  ok('SoundCloud-Limit pausiert mit Uhrzeit');

  /* Layout: Die Seite scrollt nie, auch nicht klein */
  await page.setViewportSize({ width: 360, height: 560 });
  for (const route of ['#/', '#/new', '#/new/spotify', '#/jobs', '#/settings/spotify', '#/settings/soundcloud', '#/settings/backup']) {
    await page.goto(BASE + route);
    await page.waitForTimeout(420);
    const bad = await page.evaluate(() => document.documentElement.scrollHeight > innerHeight || document.body.scrollHeight > innerHeight || document.documentElement.scrollWidth > innerWidth);
    assert.equal(bad, false, `Seite scrollt: ${route}`);
    if (await page.locator('.bar').count()) assert.ok((await page.locator('.bar').boundingBox()).y + 20 < 560, `Leiste sichtbar: ${route}`);
  }
  await page.goto(`${BASE}#/`);
  await page.click('.box-name >> nth=0');
  await page.waitForSelector('.bar');
  await shot(page, 'klein-kiste');
  assert.ok(await page.locator('.bar a').isVisible());
  await page.goto(`${BASE}#/jobs`);
  await page.click('.box-name >> nth=0');
  await page.waitForSelector('.bar');
  await page.waitForTimeout(150);
  assert.ok((await page.locator('.bar').boundingBox()).y + 20 < 560);
  await shot(page, 'klein-umzug');
  await page.setViewportSize({ width: 390, height: 844 });
  for (const [route, name] of [['#/', 'ios-kisten'], ['#/jobs', 'ios-umzuege']]) { await page.goto(BASE + route); await page.waitForTimeout(450); await shot(page, name); }
  await page.click('.box-name >> nth=0'); await page.waitForTimeout(450); await shot(page, 'ios-umzug');
  await page.goto(`${BASE}#/`); await page.click('.box-name >> nth=0'); await page.waitForTimeout(450); await shot(page, 'ios-kiste');
  await page.click('[aria-label=Mehr]'); await page.waitForTimeout(450); await shot(page, 'ios-blatt'); await page.click('dialog .done');
  await page.click('text=Umziehen'); await page.waitForTimeout(450); await page.click('[role=tab]:has-text("SoundCloud")'); await page.waitForTimeout(450); await shot(page, 'ios-ziel');
  ok('Layout passt bei 360×560 ohne Seiten-Scrollen');

  /* Neues-Dialog nach Update, nicht beim ersten Besuch */
  assert.ok(await page.evaluate(() => localStorage.getItem('uk.seenVersion')));
  await page.evaluate(() => localStorage.setItem('uk.seenVersion', '0.0.1'));
  await page.goto(`${BASE}#/jobs`);
  await page.reload();
  await page.waitForSelector('dialog:has-text("Neu in")');
  await page.click('dialog .done');
  await page.reload();
  await page.waitForSelector('.view');
  assert.equal(await page.locator('dialog').count(), 0);
  ok('Änderungen erscheinen nach Update einmal');
  await page.goto(`${BASE}#/jobs`);
  await page.click('.head .icon');
  assert.match(await page.getAttribute('#feedback', 'href'), /Umzugskiste\/issues\/new\?body=Version/);
  assert.deepEqual(consoleErrors, []);
  ok('Keine Konsolenfehler');
  await ctx.close();

  /* Dunkel */
  const dark = await browser.newContext({ colorScheme: 'dark', viewport: { width: 1100, height: 800 } });
  const dp = await dark.newPage();
  await dp.goto(BASE);
  await dp.click('text=Neue Kiste');
  await dp.fill('#textName', 'Nachtschicht');
  await dp.fill('#textBody', Array.from({ length: 60 }, (_, i) => `Artist ${i % 9} - Track ${i}`).join('\n'));
  await dp.click('text=Einpacken');
  await dp.waitForSelector('.title-input');
  await dp.waitForTimeout(200);
  await shot(dp, 'dunkel');
  await dark.close();
} finally {
  await browser.close();
  server.close();
}
writeFileSync('e2e/shots/.done', 'ok');
console.log('alle Browser-Tests ok');
