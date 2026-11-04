import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { parseText, parseCsv, parseM3u, parseFile } from '../src/parse.js';
import { scoreMatch, classify, splitTitle, rank, norm } from '../src/match.js';
import { makeTrack, makeBox, trackKey, dedupe, VERSION, splitArtists } from '../src/model.js';
import { encodeShare, decodeShare } from '../src/share.js';
import { toCsv, toJson, reportCsv } from '../src/export.js';
import { newJob, runJob, counts, confirmReview, isDue, retry, delta } from '../src/transfer.js';
import { QuotaError, AuthError } from '../src/errors.js';
import { parseUpload } from '../src/services/soundcloud.js';
import { handle } from '../supabase/functions/soundcloud-token/handler.js';

const T = (title, artists, extra = {}) => makeTrack({ title, artists, ...extra });

test('Text: Formate und Rauschen', () => {
  const r = parseText('1. Daft Punk - One More Time\nBicep – Glue (3:12)\n\n# Kommentar\nhttps://x.y/z\nStrobe by deadmau5\nNur Titel');
  assert.deepEqual(r.map(t => [t.artists[0], t.title]), [['Daft Punk', 'One More Time'], ['Bicep', 'Glue'], ['deadmau5', 'Strobe'], [undefined, 'Nur Titel']]);
});
test('CSV: Exportify-Spalten, Anführungszeichen, Semikolon', () => {
  const r = parseCsv('"Track URI","Track Name","Artist Name(s)","Album Name","Duration (ms)","ISRC"\n"spotify:track:4cOdK2wGLETKBW3PvgPWqT","Foo, Bar","A;B","X","200000","GBABC1234567"\n');
  assert.equal(r[0].title, 'Foo, Bar');
  assert.deepEqual(r[0].artists, ['A', 'B']);
  assert.equal(r[0].refs.spotify, '4cOdK2wGLETKBW3PvgPWqT');
  assert.equal(r[0].isrc, 'GBABC1234567');
  assert.equal(parseCsv('Titel;Künstler\nLied;Band\n')[0].artists[0], 'Band');
});
test('CSV: Export und Import ergeben dasselbe, Formel-Schutz', () => {
  const t = [T('=SUM(1)', ['A', 'B'], { isrc: 'GBABC1234567', durationMs: 1000, refs: { spotify: '4cOdK2wGLETKBW3PvgPWqT' } }), T('Mit "Quote", Komma', ['C'])];
  const csv = toCsv(t);
  assert.match(csv, /'=SUM/);
  const back = parseCsv(csv);
  assert.equal(back[0].title, '=SUM(1)');
  assert.deepEqual(back[1].title, 'Mit "Quote", Komma');
  assert.deepEqual(back[0].artists, ['A', 'B']);
});
test('M3U und JSON', () => {
  assert.equal(parseM3u('#EXTM3U\n#EXTINF:120,Foo - Bar\nfile.mp3')[0].durationMs, 120000);
  const box = makeBox({ name: 'K', tracks: [T('a b', ['c'])] });
  assert.equal(parseFile('x.json', toJson(box)).tracks[0].title, 'a b');
  assert.throws(() => parseFile('x.json', '{}'));
});
test('Künstler trennen und Dubletten', () => {
  assert.deepEqual(splitArtists('A, B & C feat. D'), ['A', 'B', 'C', 'D']);
  assert.equal(dedupe([T('x', ['a']), T('X!', ['A'])]).length, 1);
  assert.equal(trackKey(T('x', ['a'], { isrc: 'us-abc-12-34567' })), 'isrc:USABC1234567');
});
test('Abgleich: gleich, Remaster, Feat, ISRC', () => {
  assert.equal(scoreMatch(T('a', [], { isrc: 'X' }), T('b', [], { isrc: 'X' })), 1);
  const s = T('One More Time', ['Daft Punk'], { durationMs: 320000 });
  assert.equal(classify(scoreMatch(s, T('One More Time', ['Daft Punk'], { durationMs: 320300 }))), 'sure');
  assert.equal(classify(scoreMatch(s, T('One More Time - Remastered 2009', ['Daft Punk']))), 'sure');
  assert.equal(classify(scoreMatch(T('Song (feat. X)', ['Y']), T('Song', ['Y', 'X']))), 'sure');
  assert.equal(norm('Beyoncé & Straße'), 'beyonce and strasse');
});
test('Abgleich: andere Version wird unsicher, anderer Song fehlt', () => {
  const ext = T('Strobe (Extended Mix)', ['deadmau5'], { durationMs: 630000 });
  assert.equal(classify(scoreMatch(ext, T('Strobe - Radio Edit', ['deadmau5'], { durationMs: 210000 }))), 'unsure');
  assert.equal(classify(scoreMatch(T('Glue', ['Bicep']), T('Rumour Mill', ['Rudimental']))), 'missing');
  assert.deepEqual([...splitTitle('Foo (Bar Remix) [Remastered]').versions], ['bar remix']);
  assert.equal(rank(T('Glue', ['Bicep']), [T('Nope', ['Z']), T('Glue', ['Bicep'])])[0].title, 'Glue');
});
test('Teilen: Hin und zurück, Umlaute, kaputter Link', async () => {
  const box = makeBox({ name: 'Küche', tracks: [T('Für Elise', ['Beethoven'], { isrc: 'DEABC1234567', durationMs: 180000 })] });
  const back = await decodeShare(await encodeShare(box));
  assert.equal(back.name, 'Küche');
  assert.equal(back.tracks[0].title, 'Für Elise');
  assert.equal(back.tracks[0].durationMs, 180000);
  await assert.rejects(decodeShare('kaputt'));
});

function fakeAdapter(opts = {}) {
  const a = {
    batchSize: 2, writes: [], created: 0, present: new Set(), failAfterSearch: Infinity, searches: 0,
    async search(t) {
      if (a.searches++ >= a.failAfterSearch) throw (opts.err || new QuotaError('Limit', Date.now() + 1000));
      if (t.title === 'Fehlt') return [];
      if (t.title === 'Andere Version (Extended Mix)') return [{ id: 'v', title: 'Andere Version (Radio Edit)', artists: t.artists }];
      return [{ id: `id-${t.title}`, title: t.title, artists: t.artists }];
    },
    async createPlaylist() { a.created++; return { id: 'pl', url: 'u' }; },
    async existingIds() { return a.present; },
    async addTracks(_, m) { if (a.failWrite) { a.failWrite = false; throw new TypeError('Netz weg'); } a.writes.push(...m.map(x => x.id)); },
  };
  return a;
}
const ctx = (adapter, extra = {}) => {
  const map = new Map();
  return { adapter, persist: async () => {}, notify: () => {}, stopped: () => false, cache: { get: async k => map.get(k), set: async (k, v) => map.set(k, v) }, ...extra };
};
const box = titles => makeBox({ name: 'K', tracks: titles.map(t => T(t, ['Band'])) });

test('Umzug: sauberer Lauf, Paketgröße, fehlende Songs', async () => {
  const a = fakeAdapter();
  const job = newJob(box(['Eins', 'Zwei', 'Drei', 'Fehlt']), { service: 'spotify', name: 'Ziel' });
  await runJob(job, ctx(a));
  assert.equal(job.status, 'done');
  assert.equal(a.created, 1);
  assert.deepEqual(a.writes, ['id-Eins', 'id-Zwei', 'id-Drei']);
  assert.equal(counts(job).missing, 1);
  assert.equal(counts(job).written, 3);
});
test('Umzug: unsicher hält an, Prüfen führt weiter', async () => {
  const a = fakeAdapter();
  const job = newJob(box(['Eins', 'Andere Version (Extended Mix)']), { service: 'spotify', name: 'Ziel' });
  const c = ctx(a);
  await runJob(job, c);
  assert.equal(job.status, 'review');
  assert.equal(a.writes.length, 0);
  confirmReview(job);
  await runJob(job, c);
  assert.equal(job.status, 'done');
  assert.deepEqual(a.writes, ['id-Eins']);
  assert.equal(counts(job).skipped, 1);
});
test('Umzug: Limit pausiert und läuft ohne Doppelarbeit weiter', async () => {
  const a = fakeAdapter();
  a.failAfterSearch = 1;
  const job = newJob(box(['Eins', 'Zwei']), { service: 'youtube', name: 'Ziel' });
  const c = ctx(a);
  await runJob(job, c);
  assert.equal(job.status, 'paused');
  assert.equal(job.pauseReason, 'quota');
  assert.equal(isDue(job, Date.now(), true), false);
  assert.equal(isDue(job, job.resumeAt + 1, true), true);
  a.failAfterSearch = Infinity;
  retry(job);
  await runJob(job, c);
  assert.equal(job.status, 'done');
  assert.equal(a.searches, 3);
  assert.equal(a.created, 1);
});
test('Umzug: Netz weg beim Schreiben, keine Dubletten beim Neustart', async () => {
  const a = fakeAdapter();
  a.failWrite = true;
  const job = newJob(box(['Eins', 'Zwei', 'Drei']), { service: 'spotify', name: 'Ziel' });
  await runJob(job, ctx(a));
  assert.equal(job.pauseReason, 'offline');
  assert.equal(job.target.playlistId, 'pl');
  a.present = new Set(['id-Eins']);
  retry(job);
  await runJob(job, ctx(a));
  assert.equal(job.status, 'done');
  assert.equal(a.created, 1);
  assert.deepEqual(a.writes, ['id-Zwei', 'id-Drei']);
});
test('Umzug: Anmeldung abgelaufen und Fehler', async () => {
  const a = fakeAdapter({ err: new AuthError('weg') });
  a.failAfterSearch = 0;
  const job = newJob(box(['Eins']), { service: 'spotify', name: 'Z' });
  await runJob(job, ctx(a));
  assert.equal(job.pauseReason, 'auth');
  const b = fakeAdapter({ err: new Error('Boom') });
  b.failAfterSearch = 0;
  const j2 = newJob(box(['Eins']), { service: 'spotify', name: 'Z' });
  await runJob(j2, ctx(b));
  assert.equal(j2.status, 'failed');
});
test('Nachziehen und Bericht', () => {
  const b = box(['Eins']);
  const job = newJob(b, { service: 'spotify', name: 'Z' });
  b.tracks.push(T('Zwei', ['Band']));
  assert.deepEqual(delta(job, b).map(t => t.title), ['Zwei']);
  assert.match(reportCsv(job), /offen,Eins/);
});
test('SoundCloud: Upload-Titel verstehen', () => {
  assert.deepEqual(parseUpload({ title: 'Bicep - Glue', user: { username: 'Label' } }), { title: 'Glue', artists: ['Bicep'] });
  assert.deepEqual(parseUpload({ title: 'Glue', metadata_artist: 'Bicep', user: { username: 'Label' } }), { title: 'Glue', artists: ['Bicep'] });
  assert.deepEqual(parseUpload({ title: 'Glue', user: { username: 'Bicep' } }), { title: 'Glue', artists: ['Bicep'] });
});
const ENV = { ALLOWED_ORIGINS: 'https://a.test', ALLOWED_REDIRECTS: 'https://a.test/app/', SOUNDCLOUD_CLIENT_ID: 'id', SOUNDCLOUD_CLIENT_SECRET: 'geheim' };
const call = (body, origin = 'https://a.test', method = 'POST') => new Request('https://f.test/', { method, headers: { Origin: origin, 'Content-Type': 'application/json' }, body: method === 'POST' ? JSON.stringify(body) : undefined });
test('Token-Funktion: Secret nur serverseitig, fremde Herkunft und Weiterleitung blockiert', async () => {
  let sent;
  const fake = async (_, init) => { sent = init.body; return new Response(JSON.stringify({ access_token: 'a', refresh_token: 'r', expires_in: 3600, extra: 'x' })); };
  assert.equal((await handle(call({}, 'https://boese.test'), ENV, fake)).status, 403);
  assert.equal((await handle(call({ grant_type: 'authorization_code', code: 'c', code_verifier: 'v', redirect_uri: 'https://boese.test/' }), ENV, fake)).status, 400);
  assert.equal((await handle(call({ grant_type: 'password' }), ENV, fake)).status, 400);
  assert.equal(sent, undefined);
  const res = await handle(call({ grant_type: 'authorization_code', code: 'c', code_verifier: 'v', redirect_uri: 'https://a.test/app/' }), ENV, fake);
  assert.equal(res.status, 200);
  assert.equal(sent.get('client_secret'), 'geheim');
  assert.deepEqual(await res.json(), { access_token: 'a', refresh_token: 'r', expires_in: 3600 });
  assert.equal(res.headers.get('Access-Control-Allow-Origin'), 'https://a.test');
  assert.equal((await handle(call(null, 'https://a.test', 'OPTIONS'), ENV, fake)).status, 204);
});
test('Offline-Liste vollständig, Version passt', () => {
  const sw = readFileSync('sw.js', 'utf8');
  assert.ok(sw.includes(`umzugskiste-${VERSION}`));
  const shell = [...sw.match(/SHELL = \[([\s\S]*?)\];/)[1].matchAll(/'([^']+)'/g)].map(m => m[1]);
  for (const f of shell) if (f !== './') assert.ok(existsSync(f), `fehlt: ${f}`);
  const files = [...readdirSync('src').filter(f => f.endsWith('.js')).map(f => `src/${f}`), ...readdirSync('src/services').map(f => `src/services/${f}`)];
  for (const f of files) assert.ok(shell.includes(f), `nicht im Cache: ${f}`);
});
