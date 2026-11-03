// Oberfläche: Hash-Router und Ansichten. Logik liegt in den anderen Modulen.
import { h, btn, confirmBtn, toast, download, paged, spine, sleeveColor, stateColor } from './ui.js';
import * as store from './store.js';
import { VERSION, makeBox, makeTrack, songs, artistLine, trackKey, dedupe } from './model.js';
import { parseText, parseFile } from './parse.js';
import { toCsv, toText, toJson, reportCsv, safeFilename } from './export.js';
import { encodeShare, decodeShare } from './share.js';
import { newJob, counts, pick, skip, acceptAllUnsure, confirmReview, retry, delta } from './transfer.js';
import { adapters, clickServices, serviceName } from './services/index.js';
import { spotify, redirectUri } from './services/spotify.js';
import { youtube, SEARCH_LIMIT, UNIT_LIMIT } from './services/youtube.js';
import { readDeezer, parseDeezerUrl } from './services/deezer.js';
import { pump, onJob, live, stop, resumeAuthPaused } from './runner.js';

const view = document.getElementById('view');
const go = hash => { location.hash = hash; };
let renderId = 0;

const fail = e => toast(e.message || String(e));
const whenOnline = () => navigator.onLine;
const OFFLINE_HINT = 'Dafür brauchst du Internet. Text und Dateien gehen auch offline.';

async function saveBox(box) {
  await store.put('boxes', box);
  navigator.storage?.persist?.().catch(() => {});
  return box;
}

const heading = (title, ...actions) => h('div.head', {}, h('h1', {}, title), actions.length ? h('div.actions', {}, actions) : null);
const sourceLabel = box => {
  if (!box.source) return 'Von Hand gepackt';
  return `Aus ${serviceName(box.source.service)}`;
};

/* ---------- Kisten ---------- */
async function homeView() {
  const boxes = (await store.all('boxes')).sort((a, b) => b.updatedAt - a.updatedAt);
  const add = h('a.btn', { href: '#/new' }, 'Neue Kiste');
  if (!boxes.length) {
    return h('div.intro', {},
      h('h1', {}, 'Pack deine Musik ein und nimm sie mit.'),
      h('p', {}, 'Lade Playlists aus einem Musikdienst, aus einer Datei oder als Text in eine Kiste. Von dort ziehen sie zu einem anderen Dienst um.'),
      h('p', {}, 'Alles bleibt auf diesem Gerät. Es gibt kein Konto und keinen Server.'),
      add);
  }
  return h('div', {},
    heading('Deine Kisten', add),
    h('ul.boxes', {}, boxes.map(box => h('li', {},
      h('a.box', { href: `#/box/${box.id}` },
        h('span.box-name', {}, box.name),
        h('span.box-meta', {}, `${songs(box.tracks.length)}, ${sourceLabel(box)}`),
        spine(box.tracks, { colorOf: sleeveColor, label: `${songs(box.tracks.length)} in ${box.name}` }))))));
}

/* ---------- Neue Kiste ---------- */
const TABS = [['text', 'Text'], ['file', 'Datei'], ['link', 'Link'], ['spotify', 'Spotify'], ['youtube', 'YouTube']];

async function packTracks(name, tracks, source = null) {
  if (!tracks.length) { toast('Darin stehen keine Songs. Schreib pro Zeile einen Song, zum Beispiel: Daft Punk - One More Time'); return null; }
  const box = await saveBox(makeBox({ name, tracks: dedupe(tracks), source }));
  return box;
}

function textTab() {
  const name = h('input', { id: 'textName', placeholder: 'Name der Kiste', 'aria-label': 'Name der Kiste' });
  const area = h('textarea', { id: 'textBody', rows: 10, 'aria-label': 'Songliste', placeholder: 'Pro Zeile ein Song:\nDaft Punk - One More Time\nBicep - Glue' });
  return h('div.stack', {}, name, area, btn('Einpacken', async () => {
    const box = await packTracks(name.value, parseText(area.value));
    if (box) go(`#/box/${box.id}`);
  }));
}

function fileTab() {
  const input = h('input', {
    type: 'file', id: 'fileInput', accept: '.csv,.tsv,.txt,.json,.m3u,.m3u8', multiple: true, 'aria-label': 'Dateien wählen',
    onChange: async () => {
      try {
        let last;
        for (const file of input.files) {
          const { name, tracks } = parseFile(file.name, await file.text());
          last = await packTracks(name, tracks);
        }
        if (last) go(input.files.length > 1 ? '#/' : `#/box/${last.id}`);
      } catch (e) { fail(e); }
    },
  });
  return h('div.stack', {},
    h('p', {}, 'CSV, TXT, JSON oder M3U. Exporte von Exportify und aus dieser App werden erkannt.'),
    input);
}

function linkTab() {
  const input = h('input', { id: 'linkUrl', type: 'url', placeholder: 'https://www.deezer.com/playlist/…', 'aria-label': 'Playlist-Link' });
  const go1 = btn('Einpacken', async () => {
    if (!whenOnline()) { toast(OFFLINE_HINT); return; }
    const url = input.value.trim();
    try {
      go1.disabled = true;
      const dz = parseDeezerUrl(url);
      const sp = url.match(/open\.spotify\.com\/(?:intl-[a-z]+\/)?playlist\/([0-9A-Za-z]+)/);
      const yt = url.match(/[?&]list=([\w-]+)/);
      let got, source;
      if (dz) { got = await readDeezer(dz); source = { service: 'deezer', ...dz }; }
      else if (sp) { need(spotify); source = { service: 'spotify', ref: `playlist:${sp[1]}` }; got = await spotify.readSource(source.ref); }
      else if (yt) { need(youtube); source = { service: 'youtube', ref: `playlist:${yt[1]}` }; got = await youtube.readSource(source.ref); }
      else { toast('Diesen Link kenne ich nicht. Es gehen Links zu Deezer-, Spotify- und YouTube-Playlists.'); return; }
      const box = await packTracks(got.name, got.tracks, source);
      if (box) go(`#/box/${box.id}`);
    } catch (e) { fail(e); } finally { go1.disabled = false; }
  });
  return h('div.stack', {},
    h('p', {}, 'Deezer-Playlists und -Alben gehen ohne Anmeldung, wenn sie öffentlich sind. Spotify und YouTube brauchen die Anmeldung.'),
    input, go1);
}

function need(adapter) {
  if (!adapter.isConnected()) throw new Error(`Melde dich zuerst unter Dienste bei ${adapter.name} an.`);
}

function connectHint(adapter) {
  if (!adapter.hasClientId()) {
    return h('div.stack', {}, h('p', {}, `Für ${adapter.name} brauchst du einmalig eine eigene Zugangs-ID.`), h('a.btn', { href: '#/settings' }, 'Zu den Diensten'));
  }
  return h('div.stack', {}, h('p', {}, `Melde dich bei ${adapter.name} an, um deine Playlists zu sehen.`), btn(`Bei ${adapter.name} anmelden`, () => login(adapter)));
}

function login(adapter) {
  if (!navigator.onLine) { toast('Für die Anmeldung brauchst du Internet.'); return; }
  sessionStorage.setItem('uk.return', location.hash || '#/');
  adapter.login().catch(fail);
}

function serviceTab(adapter) {
  if (!adapter.isConnected()) return connectHint(adapter);
  if (!navigator.onLine) return h('p', {}, OFFLINE_HINT);
  const list = h('ul.rows', {}, h('li.muted', {}, 'Lade Playlists…'));
  const status = h('p.muted', { role: 'status' });
  const chosen = new Set();
  let sources = [];
  const action = btn('Auswahl einpacken', async () => {
    action.disabled = true;
    try {
      const picks = sources.filter(s => chosen.has(s.ref));
      for (const [i, s] of picks.entries()) {
        status.textContent = `${i + 1} von ${picks.length}: ${s.name}`;
        const got = await adapter.readSource(s.ref, n => { status.textContent = `${s.name}: ${n} Songs gelesen`; });
        await saveBox(makeBox({ name: got.name, tracks: dedupe(got.tracks), source: { service: adapter.id, ref: s.ref } }));
      }
      go('#/');
    } catch (e) { fail(e); status.textContent = ''; } finally { action.disabled = false; }
  });
  action.disabled = true;
  adapter.listSources().then(found => {
    sources = found;
    list.replaceChildren(...found.map(s => h('li', {}, h('label.check', {},
      h('input', { type: 'checkbox', onChange: e => {
        if (e.target.checked) chosen.add(s.ref); else chosen.delete(s.ref);
        action.disabled = !chosen.size;
      } }),
      h('span', {}, s.name),
      s.total !== null ? h('span.muted', {}, songs(s.total)) : null))));
  }).catch(e => { list.replaceChildren(h('li', {}, e.message)); });
  return h('div.stack', {}, list, status, action);
}

async function newView(tab = 'text') {
  const panel = { text: textTab, file: fileTab, link: linkTab, spotify: () => serviceTab(spotify), youtube: () => serviceTab(youtube) }[tab] || textTab;
  return h('div', {},
    heading('Neue Kiste'),
    h('div.tabs', { role: 'tablist', 'aria-label': 'Woher kommen die Songs?' }, TABS.map(([id, label]) => h('a', {
      role: 'tab', href: `#/new/${id}`, 'aria-selected': String(id === tab),
    }, label))),
    h('div.sheet', {}, panel()));
}

/* ---------- Kiste ---------- */
async function shareBox(box) {
  const code = await encodeShare(box);
  const url = `${redirectUri()}#s=${code}`;
  if (url.length > 30000) toast(`Der Link ist sehr lang (${Math.round(url.length / 1000)} kB). Schick lieber die JSON-Datei.`);
  try { await navigator.clipboard.writeText(url); toast('Link kopiert. Wer ihn öffnet, bekommt eine Kopie dieser Kiste.'); }
  catch { prompt('Link kopieren', url); }
}

async function refreshBox(box) {
  const src = box.source;
  if (src.service === 'deezer') return readDeezer(src);
  const adapter = adapters[src.service];
  need(adapter);
  return adapter.readSource(src.ref);
}

function trackRow(t, onRemove) {
  return h('li.track', {},
    h('div.t', {}, h('strong', {}, t.title), h('span', {}, artistLine(t) || 'Künstler unbekannt')),
    t.refs.spotify ? h('a', { href: `https://open.spotify.com/track/${t.refs.spotify}`, target: '_blank', rel: 'noopener' }, 'Spotify') : null,
    onRemove ? h('button.x', { type: 'button', 'aria-label': `${t.title} entfernen`, onClick: onRemove }, '×') : null);
}

async function boxView(id) {
  const box = await store.get('boxes', id);
  if (!box) return missingView();
  const rename = h('input.title-input', {
    value: box.name, 'aria-label': 'Name der Kiste',
    onChange: async e => { box.name = e.target.value.trim() || box.name; box.updatedAt = Date.now(); await store.put('boxes', box); },
  });
  const save = () => { box.updatedAt = Date.now(); return store.put('boxes', box); };
  const filter = h('input', { type: 'search', placeholder: 'In der Kiste suchen', 'aria-label': 'In der Kiste suchen' });
  const holder = h('div');
  const show = () => {
    const q = filter.value.trim().toLowerCase();
    const list = box.tracks.filter(t => !q || `${t.title} ${artistLine(t)}`.toLowerCase().includes(q));
    holder.replaceChildren(paged(list, t => trackRow(t, async () => {
      box.tracks.splice(box.tracks.indexOf(t), 1);
      await save();
      render();
    })));
  };
  filter.addEventListener('input', show);
  show();
  return h('div', {},
    rename,
    h('p.meta', {}, `${songs(box.tracks.length)}, ${sourceLabel(box)}`),
    spine(box.tracks, { height: 72, colorOf: sleeveColor, label: `${songs(box.tracks.length)} in ${box.name}` }),
    h('div.actions.main', {},
      h('a.btn', { href: `#/box/${id}/move` }, 'Umziehen'),
      btn('Teilen', () => shareBox(box).catch(fail), 'ghost'),
      h('details.menu', {}, h('summary.btn.ghost', {}, 'Exportieren'), h('div', {},
        btn('CSV', () => download(`${safeFilename(box.name)}.csv`, toCsv(box.tracks), 'text/csv'), 'ghost'),
        btn('Text', () => download(`${safeFilename(box.name)}.txt`, toText(box.tracks)), 'ghost'),
        btn('JSON', () => download(`${safeFilename(box.name)}.json`, toJson(box), 'application/json'), 'ghost'))),
      box.source ? btn('Aktualisieren', async () => {
        if (!navigator.onLine) { toast(OFFLINE_HINT); return; }
        try {
          const before = new Set(box.tracks.map(trackKey));
          const got = await refreshBox(box);
          const fresh = dedupe(got.tracks);
          const added = fresh.filter(t => !before.has(trackKey(t))).length;
          box.tracks = fresh;
          await save();
          toast(`${songs(added)} neu, jetzt ${songs(fresh.length)} in der Kiste.`);
          render();
        } catch (e) { fail(e); }
      }, 'ghost') : null,
      confirmBtn('Löschen', 'Wirklich löschen?', async () => { await store.del('boxes', id); go('#/'); })),
    h('div.sheet', {}, filter, holder));
}

/* ---------- Umzug anlegen ---------- */
async function startJob(box, target) {
  const job = newJob(box, target);
  await store.put('jobs', job);
  if (target.kind !== 'click') pump().catch(fail);
  go(`#/job/${job.id}`);
}

function targetPanel(box, adapter) {
  if (!adapter.isConnected()) return connectHint(adapter);
  const name = h('input', { id: 'targetName', value: box.name, 'aria-label': 'Name der neuen Playlist' });
  const select = h('select', { id: 'targetList', 'aria-label': 'Wohin?', onChange: () => { name.hidden = select.value !== 'new'; } },
    h('option', { value: 'new' }, 'Neue Playlist'),
    adapter.canLike ? h('option', { value: 'likes' }, 'Lieblingssongs') : null);
  if (navigator.onLine) {
    adapter.listTargets().then(lists => select.append(...lists.map(p => h('option', { value: p.id }, p.name)))).catch(() => {});
  }
  const info = adapter === youtube
    ? h('p.muted', {}, `YouTube erlaubt ${SEARCH_LIMIT} Suchen am Tag. Größere Kisten ziehen über mehrere Tage um und laufen weiter, sobald die App offen ist.`)
    : null;
  return h('div.stack', {}, select, name, info, btn(`Nach ${adapter.name} umziehen`, () => {
    const choice = select.value;
    const opt = select.selectedOptions[0];
    startJob(box, {
      service: adapter.id, kind: 'api', name: choice === 'new' ? (name.value.trim() || box.name) : opt.textContent,
      playlistId: choice === 'new' ? null : choice,
      url: null,
    }).catch(fail);
  }));
}

async function moveView(id, service = 'spotify') {
  const box = await store.get('boxes', id);
  if (!box) return missingView();
  const tabs = [...Object.values(adapters).map(a => [a.id, a.name])];
  const adapter = adapters[service];
  return h('div', {},
    heading(`${box.name} umziehen`),
    h('div.tabs', { role: 'tablist', 'aria-label': 'Zieldienst' }, tabs.map(([sid, label]) => h('a', {
      role: 'tab', href: `#/box/${id}/move/${sid}`, 'aria-selected': String(sid === service),
    }, label)), h('a', { role: 'tab', href: `#/box/${id}/move/click`, 'aria-selected': String(service === 'click') }, 'Andere')),
    h('div.sheet', {}, adapter ? targetPanel(box, adapter) : h('div.stack', {},
      h('p', {}, 'Diese Dienste lassen sich aus dem Browser nicht direkt ansteuern. Die Klickliste öffnet jeden Song im Dienst, und du hakst ab, was du gespeichert hast.'),
      h('div.grid', {}, Object.entries(clickServices).map(([sid, s]) => btn(s.name, () => startJob(box, { service: sid, kind: 'click', name: s.name }).catch(fail), 'ghost'))))));
}

/* ---------- Umzüge ---------- */
const STATUS = {
  queued: 'Wartet auf den Start', matching: 'Sucht Songs', review: 'Wartet auf dich', writing: 'Trägt Songs ein',
  paused: 'Pausiert', done: 'Fertig', failed: 'Abgebrochen',
};
const jobSpine = (job, height) => {
  const c = counts(job);
  return spine(job.items, { height, colorOf: stateColor, label: `${c.written} von ${c.total} Songs übertragen` });
};
const line = job => {
  const c = counts(job);
  return job.target.kind === 'click' ? `${c.written} von ${c.total} abgehakt` : `${STATUS[job.status]}, ${c.written} von ${c.total} übertragen`;
};

async function jobsView() {
  const jobs = (await store.all('jobs')).sort((a, b) => b.createdAt - a.createdAt);
  if (!jobs.length) {
    return h('div.intro', {}, h('h1', {}, 'Noch kein Umzug.'), h('p', {}, 'Öffne eine Kiste und tippe auf Umziehen.'), h('a.btn', { href: '#/' }, 'Zu den Kisten'));
  }
  return h('div', {}, heading('Umzüge'), h('ul.boxes', {}, jobs.map(job => h('li', {}, h('a.box', { href: `#/job/${job.id}` },
    h('span.box-name', {}, `${job.boxName} nach ${serviceName(job.target.service)}`),
    h('span.box-meta', {}, line(job)),
    jobSpine(job, 44))))));
}

const searchUrl = (service, q) => (service === 'spotify'
  ? `https://open.spotify.com/search/${encodeURIComponent(q)}`
  : `https://music.youtube.com/search?q=${encodeURIComponent(q)}`);
const queryOf = t => `${t.artists[0] || ''} ${t.title}`.trim();

function reviewBlock(job, save) {
  const unsure = job.items.filter(i => i.state === 'unsure');
  return h('div.sheet', {},
    h('h2', {}, `${songs(unsure.length)} prüfen`),
    h('p', {}, 'Hier passt der Treffer nicht sicher, oft ist es eine andere Version. Nimm einen Vorschlag oder lass den Song aus.'),
    h('div.actions', {},
      btn('Alle ersten Vorschläge nehmen', async () => { acceptAllUnsure(job); await save(); render(); }, 'ghost')),
    paged(unsure, item => h('li.review', {},
      h('div.t', {}, h('strong', {}, item.track.title), h('span', {}, artistLine(item.track))),
      h('div.cands', {}, item.candidates.filter(c => c.score >= 0.3).map(c => h('div.cand', {},
        h('a', { href: c.url, target: '_blank', rel: 'noopener' }, `${c.title}, ${(c.artists || []).join(', ')}`),
        btn('Nehmen', async () => { pick(job, item.key, c); await save(); render(); }, 'ghost small')))),
      btn('Auslassen', async () => { skip(job, item.key); await save(); render(); }, 'ghost small')), 25),
    btn(`Weiter und ${songs(counts(job).sure)} eintragen`, async () => { confirmReview(job); await save(); pump().catch(fail); render(); }));
}

function clickJobView(job, save) {
  const service = clickServices[job.target.service];
  return paged(job.items, item => h('li.track', {},
    h('label.check', {},
      h('input', { type: 'checkbox', checked: item.state === 'written', 'aria-label': `${item.track.title} erledigt`, onChange: async e => {
        item.state = e.target.checked ? 'written' : 'pending';
        job.status = job.items.every(i => i.state === 'written') ? 'done' : 'queued';
        await save();
        document.getElementById('jobLine').textContent = line(job);
      } }),
      h('span.t', {}, h('strong', {}, item.track.title), h('span', {}, artistLine(item.track)))),
    h('a', { href: service.url(queryOf(item.track)), target: '_blank', rel: 'noopener' }, 'Öffnen')));
}

async function jobView(id) {
  const job = live(id) || await store.get('jobs', id);
  if (!job) return missingView();
  const save = () => store.put('jobs', job);
  const c = counts(job);
  const name = serviceName(job.target.service);
  const parts = [
    heading(`${job.boxName} nach ${name}`),
    h('p.meta', { id: 'jobLine' }, line(job)),
    jobSpine(job, 72),
  ];
  if (job.target.kind === 'click') {
    return h('div', {}, parts, h('div.sheet', {}, clickJobView(job, save)),
      h('div.actions.main', {}, confirmBtn('Löschen', 'Wirklich löschen?', async () => { await store.del('jobs', id); go('#/jobs'); })));
  }
  const adapter = adapters[job.target.service];
  parts.push(h('ul.legend', {},
    h('li.l-written', {}, `${c.written} übertragen`),
    h('li.l-sure', {}, `${c.sure} gefunden`),
    h('li.l-unsure', {}, `${c.unsure} unsicher`),
    h('li.l-missing', {}, `${c.missing} nicht gefunden`),
    c.skipped ? h('li', {}, `${c.skipped} ausgelassen`) : null));
  if (job.message) {
    parts.push(h('p.notice', {}, job.message, job.resumeAt ? ` Weiter ab ${new Date(job.resumeAt).toLocaleString('de-DE', { dateStyle: 'short', timeStyle: 'short' })}.` : ''));
  }
  const actions = h('div.actions.main');
  if (['queued', 'matching', 'writing'].includes(job.status)) actions.append(btn('Anhalten', () => { stop(id); toast('Hält nach dem aktuellen Song an.'); }, 'ghost'));
  if (job.status === 'paused' && job.pauseReason === 'auth') actions.append(btn(`Bei ${name} anmelden`, () => login(adapter)));
  else if (job.status === 'paused' || job.status === 'failed') actions.append(btn('Weitermachen', async () => { retry(job); await save(); pump().catch(fail); render(); }));
  if (job.target.url) actions.append(h('a.btn.ghost', { href: job.target.url, target: '_blank', rel: 'noopener' }, `In ${name} öffnen`));
  if (job.status === 'done') {
    actions.append(btn('Neue Songs nachziehen', async () => {
      const box = await store.get('boxes', job.boxId);
      if (!box) { toast('Die Kiste zu diesem Umzug gibt es nicht mehr.'); return; }
      try {
        if (box.source && navigator.onLine) { box.tracks = dedupe((await refreshBox(box)).tracks); await store.put('boxes', box); }
        const fresh = delta(job, box);
        if (!fresh.length) { toast('Keine neuen Songs in der Kiste.'); return; }
        await startJob({ ...box, tracks: fresh }, { ...job.target });
      } catch (e) { fail(e); }
    }, 'ghost'));
  }
  actions.append(btn('Bericht (CSV)', () => download(`Bericht ${safeFilename(job.boxName)}.csv`, reportCsv(job), 'text/csv'), 'ghost'));
  actions.append(confirmBtn('Löschen', 'Wirklich löschen?', async () => { await store.del('jobs', id); go('#/jobs'); }));
  parts.push(actions);
  if (job.status === 'review') parts.push(reviewBlock(job, save));
  const missing = job.items.filter(i => i.state === 'missing');
  if (missing.length && job.status !== 'matching') {
    parts.push(h('details.sheet', {}, h('summary', {}, `${songs(missing.length)} nicht gefunden`),
      paged(missing, item => h('li.track', {},
        h('div.t', {}, h('strong', {}, item.track.title), h('span', {}, artistLine(item.track))),
        h('a', { href: searchUrl(job.target.service, queryOf(item.track)), target: '_blank', rel: 'noopener' }, 'Selbst suchen')))));
  }
  return h('div', {}, parts);
}

/* ---------- Geteilte Kiste ---------- */
let incoming = null;
async function sharedView() {
  if (!incoming) return missingView();
  const { name, tracks } = incoming;
  return h('div', {},
    heading(name),
    h('p.meta', {}, `${songs(tracks.length)} wurden mit dir geteilt.`),
    spine(tracks, { height: 72, colorOf: sleeveColor, label: songs(tracks.length) }),
    h('div.actions.main', {}, btn('In meine Kisten legen', async () => {
      const box = await saveBox(makeBox({ name, tracks }));
      incoming = null;
      go(`#/box/${box.id}`);
    })),
    h('div.sheet', {}, paged(tracks, t => trackRow(t))));
}

/* ---------- Dienste ---------- */
function serviceCard(adapter, { label, steps }) {
  const id = h('input', { value: adapter.clientId(), 'aria-label': label, placeholder: label, autocomplete: 'off', spellcheck: 'false', onChange: e => { adapter.setClientId(e.target.value); render(); } });
  return h('section.sheet', {},
    h('h2', {}, adapter.name),
    adapter.isConnected()
      ? h('div.actions', {}, h('span.ok', {}, 'Angemeldet'), btn('Abmelden', () => { adapter.logout(); render(); }, 'ghost small'))
      : h('div.stack', {},
        h('details', {}, h('summary', {}, 'So bekommst du die ID'), h('ol', {}, steps.map(s => h('li', {}, s)))),
        id,
        btn(`Bei ${adapter.name} anmelden`, () => {
          adapter.setClientId(id.value);
          login(adapter);
        })));
}

async function settingsView() {
  const uri = redirectUri();
  const q = youtube.quota();
  const backupIn = h('input', {
    type: 'file', accept: '.json', 'aria-label': 'Sicherung einspielen', onChange: async () => {
      try {
        const data = JSON.parse(await backupIn.files[0].text());
        if (data.app !== 'umzugskiste' || !Array.isArray(data.boxes)) throw new Error('Das ist keine Sicherung aus Umzugskiste.');
        for (const b of data.boxes) await store.put('boxes', { ...b, tracks: b.tracks.map(makeTrack) });
        toast(`${data.boxes.length} Kisten eingespielt.`);
        go('#/');
      } catch (e) { fail(e); }
    },
  });
  return h('div', {},
    heading('Dienste'),
    h('p.lead', {}, 'Jeder Dienst braucht einmalig deine eigene Zugangs-ID. Sie bleibt in diesem Browser.'),
    serviceCard(spotify, { label: 'Spotify Client ID', steps: [
      h('span', {}, 'Im ', h('a', { href: 'https://developer.spotify.com/dashboard', target: '_blank', rel: 'noopener' }, 'Spotify Developer Dashboard'), ' eine App mit Web API anlegen. Dafür braucht es Spotify Premium.'),
      h('span', {}, 'Als Redirect URI eintragen: ', h('code', {}, uri)),
      'Client ID kopieren und hier einfügen.',
    ] }),
    serviceCard(youtube, { label: 'Google OAuth Client ID', steps: [
      h('span', {}, 'In der ', h('a', { href: 'https://console.cloud.google.com/apis/library/youtube.googleapis.com', target: '_blank', rel: 'noopener' }, 'Google Cloud Console'), ' ein Projekt anlegen und YouTube Data API v3 aktivieren.'),
      'OAuth-Client vom Typ Webanwendung anlegen und dich selbst als Testnutzer eintragen.',
      h('span', {}, 'Als Weiterleitungs-URI eintragen: ', h('code', {}, uri)),
      'Client ID kopieren und hier einfügen.',
    ] }),
    h('p.muted', {}, `YouTube heute: ${q.searches} von ${SEARCH_LIMIT} Suchen, ${q.units} von ${UNIT_LIMIT} Einheiten.`),
    h('section.sheet', {},
      h('h2', {}, 'Sicherung'),
      h('p', {}, 'Die Kisten liegen nur in diesem Browser. Mit der Sicherung nimmst du sie auf ein anderes Gerät mit.'),
      h('div.actions', {}, btn('Alle Kisten sichern', async () => {
        const boxes = await store.all('boxes');
        download('umzugskiste-sicherung.json', JSON.stringify({ app: 'umzugskiste', v: 1, boxes }), 'application/json');
      }, 'ghost')),
      h('label.field', {}, 'Sicherung einspielen', backupIn),
      confirmBtn('Alle Daten löschen', 'Wirklich alles löschen?', async () => {
        for (const s of ['boxes', 'jobs', 'cache']) await store.clear(s);
        adapters.spotify.logout(); adapters.youtube.logout();
        toast('Alle Daten sind gelöscht.');
        go('#/');
      })),
    h('p.muted', {}, `Umzugskiste ${VERSION}. Keine Verbindung mit Spotify, Google, Apple, Deezer oder TIDAL und nicht von ihnen unterstützt. Anfragen gehen direkt von deinem Browser an die Dienste.`));
}

const missingView = () => h('div.intro', {}, h('h1', {}, 'Das gibt es hier nicht mehr.'), h('a.btn', { href: '#/' }, 'Zu den Kisten'));

/* ---------- Router ---------- */
function route() {
  const hash = location.hash || '#/';
  const p = hash.replace(/^#\/?/, '').split('/');
  if (p[0] === 'new') return [newView, [p[1]], 'home'];
  if (p[0] === 'box' && p[2] === 'move') return [moveView, [p[1], p[3]], 'home'];
  if (p[0] === 'box') return [boxView, [p[1]], 'home'];
  if (p[0] === 'jobs') return [jobsView, [], 'jobs'];
  if (p[0] === 'job') return [jobView, [p[1]], 'jobs'];
  if (p[0] === 'settings') return [settingsView, [], 'settings'];
  if (p[0] === 'shared') return [sharedView, [], 'home'];
  return [homeView, [], 'home'];
}

async function render() {
  const mine = ++renderId;
  const [fn, args, nav] = route();
  document.querySelectorAll('[data-nav]').forEach(a => {
    if (a.dataset.nav === nav) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
  });
  try {
    const node = await fn(...args);
    if (mine === renderId) view.replaceChildren(node);
  } catch (e) {
    if (mine === renderId) view.replaceChildren(h('div.intro', {}, h('h1', {}, 'Das ging schief.'), h('p', {}, e.message)));
  }
}

function netState() {
  document.getElementById('net').hidden = navigator.onLine;
}

function setupUpdates() {
  if (!('serviceWorker' in navigator)) return;
  const bar = document.getElementById('update');
  const offer = worker => {
    bar.replaceChildren('Neue Version bereit. ', btn('Jetzt laden', () => worker.postMessage('activate'), 'small'));
    bar.hidden = false;
  };
  navigator.serviceWorker.register('sw.js').then(reg => {
    if (reg.waiting && navigator.serviceWorker.controller) offer(reg.waiting);
    reg.addEventListener('updatefound', () => {
      const worker = reg.installing;
      worker?.addEventListener('statechange', () => {
        if (worker.state === 'installed' && navigator.serviceWorker.controller) offer(worker);
      });
    });
  }).catch(() => {});
  let reloaded = false;
  const hadController = !!navigator.serviceWorker.controller;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (hadController && !reloaded) { reloaded = true; location.reload(); }
  });
}

async function handleCallbacks() {
  const query = new URLSearchParams(location.search);
  const back = () => {
    const target = sessionStorage.getItem('uk.return') || '#/';
    sessionStorage.removeItem('uk.return');
    history.replaceState(null, '', location.pathname + target);
  };
  if ((query.get('state') || '').startsWith('sp.')) {
    try {
      if (query.get('error')) throw new Error('Die Spotify-Anmeldung wurde abgebrochen.');
      await spotify.finishLogin(query.get('code'), query.get('state'));
      await resumeAuthPaused('spotify');
    } catch (e) { fail(e); }
    back();
  }
  const fragment = new URLSearchParams(location.hash.slice(1));
  if ((fragment.get('state') || '').startsWith('yt.')) {
    try {
      if (!fragment.get('access_token')) throw new Error('Die YouTube-Anmeldung wurde abgebrochen.');
      youtube.finishLogin(fragment);
      await resumeAuthPaused('youtube');
    } catch (e) { fail(e); }
    back();
  }
}

async function handleShare() {
  const m = location.hash.match(/^#s=([\w-]+)$/);
  if (!m) return;
  try {
    incoming = await decodeShare(m[1]);
    history.replaceState(null, '', `${location.pathname}#/shared`);
  } catch (e) {
    fail(e);
    history.replaceState(null, '', `${location.pathname}#/`);
  }
}

let liveTimer;
onJob(job => {
  const [fn, args] = route();
  const onJobPage = fn === jobView && args[0] === job.id;
  if (!onJobPage && fn !== jobsView) return;
  if (liveTimer) return;
  liveTimer = setTimeout(() => { liveTimer = null; render(); }, 250);
});

addEventListener('hashchange', () => { handleShare().then(render); });
addEventListener('online', () => { netState(); pump().catch(() => {}); });
addEventListener('offline', netState);
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => render());

(async () => {
  netState();
  setupUpdates();
  await handleCallbacks();
  await handleShare();
  await render();
  pump().catch(() => {});
})();
