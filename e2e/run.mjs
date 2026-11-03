// Browser-Test mit nachgebauten Dienst-APIs. Start: npm run e2e (Port 5199).
// Getestet werden Ablauf, Offline und Fehlerpfade. Echte Dienste sind hier nicht beteiligt.
import { createRequire } from 'node:module';
import { spawn, execSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import assert from 'node:assert/strict';

const require = createRequire(`${execSync('npm root -g').toString().trim()}/`);
const { chromium, devices } = require('playwright');
const PORT = 5199, BASE = `http://127.0.0.1:${PORT}/`;
mkdirSync('e2e/shots', { recursive: true });

const server = spawn('python3', ['-m', 'http.server', String(PORT), '--bind', '127.0.0.1'], { stdio: 'ignore' });
await new Promise(r => setTimeout(r, 700));

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
    await page.click('summary:has-text("Exportieren")');
    await page.click('.menu button:has-text("CSV")');
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
  await page.click('summary:has-text("nicht gefunden")');
  await shot(page, 'fertig');

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
  await friend.goto(link);
  await friend.waitForSelector('text=wurden mit dir geteilt');
  await friend.click('text=In meine Kisten legen');
  await friend.waitForSelector('.title-input');
  assert.equal(await friend.locator('.track').count(), 3);
  ok('Geteilter Link öffnet die Kiste auf anderem Gerät');
  await friend.waitForTimeout(200);
  await shot(friend, 'mobil-kiste');
  await friend.goto(`${BASE}#/settings`);
  await friend.waitForSelector('h2');
  await shot(friend, 'mobil-dienste');
  const over = await friend.evaluate(() => document.documentElement.scrollWidth > innerWidth);
  assert.equal(over, false, 'kein seitliches Scrollen');
  ok('Mobil ohne seitliches Scrollen');
  await friendCtx.close();

  /* Klickliste */
  await page.click('text=Umziehen');
  await page.click('[role=tab]:has-text("Andere")');
  await page.click('button:has-text("Apple Music")');
  await page.waitForSelector('text=0 von 3 abgehakt');
  await page.locator('.check input').first().check();
  await page.waitForSelector('text=1 von 3 abgehakt');
  assert.match(await page.locator('.track a').first().getAttribute('href'), /music\.apple\.com/);
  ok('Klickliste merkt den Stand');

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

  /* Deezer über den abgeschotteten Rahmen, Antworten als JSONP */
  await ctx.route(/api\.deezer\.com/, route => {
    const url = new URL(route.request().url());
    const body = url.pathname.endsWith('/tracks')
      ? { data: [{ title: 'Windowlicker', duration: 366, artist: { name: 'Aphex Twin' }, album: { title: 'EP' } }], total: 1 }
      : { title: 'Deezer-Test' };
    return route.fulfill({ contentType: 'text/javascript', body: `${url.searchParams.get('callback')}(${JSON.stringify(body)})` });
  });
  await page.goto(`${BASE}#/new/link`);
  await page.fill('#linkUrl', 'https://www.deezer.com/de/playlist/123');
  await page.click('button:has-text("Einpacken")');
  await page.waitForSelector('.track:has-text("Windowlicker")');
  ok('Deezer-Playlist über Sandbox-Rahmen gelesen');

  /* YouTube: Rückweg, Tageslimit, automatische Fortsetzung vorbereitet */
  const yt = { inserts: 0, searches: 0 };
  await ctx.route(/googleapis\.com/, route => {
    const req = route.request();
    const url = new URL(req.url());
    if (req.method() === 'OPTIONS') return json(route, {});
    if (url.pathname.endsWith('/search')) {
      yt.searches++;
      if (yt.searches > 1) return json(route, { error: { errors: [{ reason: 'quotaExceeded' }], message: 'quota' } }, 403);
      return json(route, { items: [{ id: { videoId: 'vid1' }, snippet: { title: 'Aphex Twin - Windowlicker (Official Video)', channelTitle: 'Warp' } }] });
    }
    if (url.pathname.endsWith('/videos')) return json(route, { items: [{ id: 'vid1', contentDetails: { duration: 'PT6M6S' } }] });
    if (url.pathname.endsWith('/playlists') && req.method() === 'POST') return json(route, { id: 'ytpl' });
    if (url.pathname.endsWith('/playlists')) return json(route, { items: [], pageInfo: { totalResults: 0 } });
    if (url.pathname.endsWith('/playlistItems') && req.method() === 'POST') { yt.inserts++; return json(route, { id: 'x' }); }
    if (url.pathname.endsWith('/playlistItems')) return json(route, { items: [], pageInfo: { totalResults: 0 } });
    return json(route, { error: { message: 'nicht nachgebaut' } }, 404);
  });
  await page.evaluate(() => {
    localStorage.setItem('uk.youtube.clientId', '"x.apps.googleusercontent.com"');
    localStorage.setItem('uk.youtube.state', '"yt.ok"');
  });
  await page.goto(`${BASE}#access_token=gt&expires_in=3600&state=yt.ok`);
  await page.reload();
  await page.waitForFunction(() => localStorage.getItem('uk.youtube.session'));
  await page.waitForSelector('.box-name:has-text("Deezer-Test")');
  await page.click('.box-name:has-text("Deezer-Test")');
  await page.click('text=Umziehen');
  await page.click('[role=tab]:has-text("YouTube")');
  await page.click('button:has-text("Nach YouTube umziehen")');
  await page.waitForSelector('text=In YouTube öffnen');
  assert.equal(yt.inserts, 1);
  ok('YouTube: Anmeldung, Suche, Playlist, Eintrag');
  await page.goto(`${BASE}#/box/none`);
  await page.waitForSelector('text=Das gibt es hier nicht mehr');
  await page.click('text=Zu den Kisten');
  await page.click('.box-name:has-text("Offline gepackt")');
  await page.click('text=Umziehen');
  await page.click('[role=tab]:has-text("YouTube")');
  await page.click('button:has-text("Nach YouTube umziehen")');
  await page.waitForSelector('text=Tageslimit');
  assert.match(await page.textContent('p.notice'), /Weiter ab/);
  ok('YouTube: Tageslimit pausiert mit Uhrzeit');

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
  server.kill();
}
writeFileSync('e2e/shots/.done', 'ok');
console.log('alle Browser-Tests ok');
