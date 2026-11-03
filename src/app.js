// Oberfläche: Hash-Router und Ansichten. Logik liegt in den anderen Modulen.
import { h, btn, confirmBtn, toast, download, paged, spine, sleeveColor, stateColor, dialog, picker } from './ui.js';
import * as store from './store.js';
import { VERSION, CHANGELOG, makeBox, makeTrack, songs, artistLine, trackKey, dedupe } from './model.js';
import { parseText, parseFile } from './parse.js';
import { toCsv, toText, toJson, reportCsv, safeFilename } from './export.js';
import { encodeShare, decodeShare } from './share.js';
import { newJob, counts, pick, skip, acceptAllUnsure, confirmReview, retry, delta } from './transfer.js';
import { adapters, planned, serviceName } from './services/index.js';
import { spotify } from './services/spotify.js';
import { soundcloud } from './services/soundcloud.js';
import { redirectUri } from './services/pkce.js';
import { pump, onJob, live, stop, resumeAuthPaused } from './runner.js';

const view = document.getElementById('view');
const go = hash => { location.hash = hash; };
let renderId = 0;

const fail = e => toast(e.message || String(e));
const OFFLINE_HINT = 'Dafür brauchst du Internet. Text und Dateien gehen auch offline.';

async function saveBox(box) {
  await store.put('boxes', box);
  navigator.storage?.persist?.().catch(() => {});
  return box;
}

// Hauptseiten: großer Titel mit Info-Knopf. Unterseiten: Zurück-Pfeil, keine Tab-Leiste.
const rootHead = title => h('div.head', {}, h('h1', {}, title), h('button.icon', { type: 'button', 'aria-label': 'Über die App', onClick: showInfo }, 'i'));
const backLink = href => h('a.back', { href, 'aria-label': 'Zurück' });
const deepHead = (title, href) => h('div.head.sub', {}, backLink(href), h('h1', {}, title));
const soon = () => h('div.soon', {}, h('p.muted', {}, 'Vielleicht später'), h('ul', {}, planned.map(name => h('li', { 'aria-disabled': 'true' }, name))));
const spineSize = () => (innerHeight < 640 ? 36 : 64);
const sourceLabel = box => {
  if (!box.source) return 'Von Hand gepackt';
  return `Aus ${serviceName(box.source.service)}`;
};

/* ---------- Kisten ---------- */
function explainer() {
  return h('picture.explainer', {},
    h('source', { media: '(prefers-reduced-motion: reduce)', srcset: 'assets/explainer.png' }),
    h('img', { src: 'assets/explainer.gif', alt: 'Eine Playlist wird eingepackt, abgeglichen und im neuen Dienst eingetragen.' }));
}

async function homeView() {
  const boxes = (await store.all('boxes')).sort((a, b) => b.updatedAt - a.updatedAt);
  const add = h('a.btn.wide', { href: '#/new' }, 'Neue Kiste');
  if (!boxes.length) {
    return h('div.view.intro', {},
      h('div.head', {}, h('h1.wordmark', {}, 'Umzugskiste'), h('button.icon', { type: 'button', 'aria-label': 'Über die App', onClick: showInfo }, 'i')),
      explainer(),
      h('p', {}, 'Nimm deine Playlists mit zum nächsten Musikdienst. Ohne Konto, alles bleibt auf dem Gerät.'),
      add);
  }
  return h('div.view', {},
    rootHead('Kisten'),
    h('ul.boxes.fill', {}, boxes.map(box => h('li', {},
      h('a.box', { href: `#/box/${box.id}` },
        h('span.box-name', {}, box.name),
        h('span.box-meta', {}, `${songs(box.tracks.length)}, ${sourceLabel(box)}`),
        spine(box.tracks, { height: 30, colorOf: sleeveColor, label: `${songs(box.tracks.length)} in ${box.name}` }))))),
    h('div.actions.bar', {}, add));
}

/* ---------- Neue Kiste ---------- */
const TABS = [['text', 'Text'], ['file', 'Datei'], ['link', 'Link'], ['spotify', 'Spotify'], ['soundcloud', 'SoundCloud']];

async function packTracks(name, tracks, source = null) {
  if (!tracks.length) { toast('Darin stehen keine Songs. Schreib pro Zeile einen Song, zum Beispiel: Daft Punk - One More Time'); return null; }
  const box = await saveBox(makeBox({ name, tracks: dedupe(tracks), source }));
  return box;
}

function textTab() {
  const name = h('input', { id: 'textName', placeholder: 'Name der Kiste', 'aria-label': 'Name der Kiste' });
  const area = h('textarea', { id: 'textBody', rows: 10, 'aria-label': 'Songliste', placeholder: 'Pro Zeile ein Song:\nDaft Punk - One More Time\nBicep - Glue' });
  return h('div.stack.grow', {}, name, area, btn('Einpacken', async () => {
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
  const input = h('input', { id: 'linkUrl', type: 'url', placeholder: 'Link zu Playlist oder Set', 'aria-label': 'Playlist-Link' });
  const pack = btn('Einpacken', async () => {
    if (!navigator.onLine) { toast(OFFLINE_HINT); return; }
    const url = input.value.trim();
    const adapter = /soundcloud\.com\//.test(url) ? soundcloud : /open\.spotify\.com\//.test(url) ? spotify : null;
    if (!adapter) { toast('Es gehen Links zu Spotify-Playlists und SoundCloud-Sets.'); return; }
    try {
      pack.disabled = true;
      need(adapter);
      const ref = await adapter.resolve(url);
      const got = await adapter.readSource(ref);
      const box = await packTracks(got.name, got.tracks, { service: adapter.id, ref });
      if (box) go(`#/box/${box.id}`);
    } catch (e) { fail(e); } finally { pack.disabled = false; }
  });
  return h('div.stack', {},
    h('p', {}, 'Füge den Link zu einer Spotify-Playlist oder einem SoundCloud-Set ein. Dafür musst du dort angemeldet sein.'),
    input, pack);
}

function need(adapter) {
  if (!adapter.isConnected()) throw new Error(`Melde dich zuerst unter Dienste bei ${adapter.name} an.`);
}

function connectHint(adapter) {
  if (!adapter.isConfigured()) {
    if (adapter === soundcloud) return h('p', {}, 'SoundCloud wird gerade eingerichtet.');
    return h('div.stack', {}, h('p', {}, `Für ${adapter.name} brauchst du einmalig eine eigene Zugangs-ID.`), h('a.btn', { href: `#/settings/${adapter.id}` }, 'Einrichten'));
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
  const list = h('ul.rows.scroll', {}, h('li.muted', {}, 'Lade Playlists…'));
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
  return h('div.stack.grow', {}, list, status, action);
}

async function newView(tab = 'text') {
  const panel = { text: textTab, file: fileTab, link: linkTab, spotify: () => serviceTab(spotify), soundcloud: () => serviceTab(soundcloud) }[tab] || textTab;
  return h('div.view', {},
    deepHead('Neue Kiste', '#/'),
    h('div.tabs', { role: 'tablist', 'aria-label': 'Woher kommen die Songs?' }, TABS.map(([id, label]) => h('a', {
      role: 'tab', href: `#/new/${id}`, 'aria-selected': String(id === tab),
    }, label))),
    h('div.sheet.fill', {}, panel()));
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
  const adapter = adapters[src.service];
  need(adapter);
  return adapter.readSource(src.ref);
}

function trackRow(t, onRemove) {
  return h('li.track', {},
    h('div.t', {}, h('strong', {}, t.title), h('span', {}, artistLine(t) || 'Künstler unbekannt')),
    t.refs.spotify ? h('a', { href: `https://open.spotify.com/track/${t.refs.spotify}`, target: '_blank', rel: 'noopener' }, 'Spotify') : null,
    t.refs.soundcloudUrl ? h('a', { href: t.refs.soundcloudUrl, target: '_blank', rel: 'noopener' }, 'SoundCloud') : null,
    onRemove ? h('button.x', { type: 'button', 'aria-label': `${t.title} entfernen`, onClick: onRemove }, '×') : null);
}

async function boxView(id) {
  const box = await store.get('boxes', id);
  if (!box) return missingView();
  const save = () => { box.updatedAt = Date.now(); return store.put('boxes', box); };
  const rename = h('input.title-input', {
    value: box.name, 'aria-label': 'Name der Kiste',
    onChange: async e => { box.name = e.target.value.trim() || box.name; await save(); },
  });
  const filter = h('input', { type: 'search', placeholder: 'In der Kiste suchen', 'aria-label': 'In der Kiste suchen' });
  const holder = h('div.scroll');
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
  const refresh = async () => {
    if (!navigator.onLine) { toast(OFFLINE_HINT); return; }
    try {
      const before = new Set(box.tracks.map(trackKey));
      const fresh = dedupe((await refreshBox(box)).tracks);
      // Sicherheitsbremse: Eine leere Antwort darf keine volle Kiste leeren.
      if (!fresh.length && box.tracks.length) { toast('Der Dienst liefert gerade keine Songs. Die Kiste bleibt unverändert.'); return; }
      const added = fresh.filter(t => !before.has(trackKey(t))).length;
      box.tracks = fresh;
      await save();
      toast(`${songs(added)} neu, jetzt ${songs(fresh.length)} in der Kiste.`);
      render();
    } catch (e) { fail(e); }
  };
  const more = () => dialog('Mehr', close => [
    h('div.grid', {},
      btn('CSV exportieren', () => { download(`${safeFilename(box.name)}.csv`, toCsv(box.tracks), 'text/csv'); close(); }, 'ghost'),
      btn('Text exportieren', () => { download(`${safeFilename(box.name)}.txt`, toText(box.tracks)); close(); }, 'ghost'),
      btn('JSON exportieren', () => { download(`${safeFilename(box.name)}.json`, toJson(box), 'application/json'); close(); }, 'ghost'),
      box.source ? btn('Aktualisieren', () => { close(); refresh(); }, 'ghost') : null,
      confirmBtn('Kiste löschen', 'Wirklich löschen?', async () => { close(); await store.del('boxes', id); go('#/'); })),
  ]);
  return h('div.view', {},
    h('div.head.sub', {}, backLink('#/'), rename),
    h('p.meta', {}, `${songs(box.tracks.length)}, ${sourceLabel(box)}`),
    spine(box.tracks, { height: spineSize(), colorOf: sleeveColor, label: `${songs(box.tracks.length)} in ${box.name}` }),
    h('div.sheet.fill', {}, filter, holder),
    h('div.actions.bar', {},
      h('a.btn.wide', { href: `#/box/${id}/move` }, 'Umziehen'),
      btn('Teilen', () => shareBox(box).catch(fail), 'ghost'),
      btn('Mehr', more, 'ghost')));
}

/* ---------- Umzug anlegen ---------- */
async function startJob(box, target) {
  const job = newJob(box, target);
  await store.put('jobs', job);
  pump().catch(fail);
  go(`#/job/${job.id}`);
}

function targetPanel(box, adapter) {
  if (!adapter.isConnected()) return connectHint(adapter);
  const name = h('input', { id: 'targetName', value: box.name, 'aria-label': 'Name der neuen Playlist' });
  const fixed = [{ id: 'new', name: 'Neue Playlist' }, ...(adapter.canLike ? [{ id: 'likes', name: 'Lieblingssongs' }] : [])];
  const list = picker(fixed, 'new', id => { name.hidden = id !== 'new'; });
  if (navigator.onLine) adapter.listTargets().then(found => list.setItems([...fixed, ...found])).catch(() => {});
  return h('div.stack.grow', {}, list.el, name, btn(`Nach ${adapter.name} umziehen`, () => {
    const choice = list.value();
    startJob(box, {
      service: adapter.id, kind: 'api', name: choice.id === 'new' ? (name.value.trim() || box.name) : choice.name,
      playlistId: choice.id === 'new' ? null : choice.id, url: null,
    }).catch(fail);
  }));
}

async function moveView(id, service = 'spotify') {
  const box = await store.get('boxes', id);
  if (!box) return missingView();
  const adapter = adapters[service] || spotify;
  return h('div.view', {},
    deepHead('Umziehen', `#/box/${id}`),
    h('p.meta', {}, `${songs(box.tracks.length)} aus ${box.name}`),
    h('div.tabs', { role: 'tablist', 'aria-label': 'Zieldienst' }, Object.values(adapters).map(a => h('a', {
      role: 'tab', href: `#/box/${id}/move/${a.id}`, 'aria-selected': String(a === adapter),
    }, a.name))),
    h('div.sheet.fill', {}, targetPanel(box, adapter)),
    soon());
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
  return `${STATUS[job.status]}, ${c.written} von ${c.total} übertragen`;
};

async function jobsView() {
  const jobs = (await store.all('jobs')).sort((a, b) => b.createdAt - a.createdAt);
  if (!jobs.length) {
    return h('div.view', {}, rootHead('Umzüge'), h('div.empty', {}, h('p', {}, 'Noch kein Umzug. Öffne eine Kiste und tippe auf Umziehen.')));
  }
  return h('div.view', {}, rootHead('Umzüge'), h('ul.boxes.fill', {}, jobs.map(job => h('li', {}, h('a.box', { href: `#/job/${job.id}` },
    h('span.box-name', {}, `${job.boxName} nach ${serviceName(job.target.service)}`),
    h('span.box-meta', {}, line(job)),
    jobSpine(job, 30))))));
}

const searchUrl = (service, q) => (service === 'spotify'
  ? `https://open.spotify.com/search/${encodeURIComponent(q)}`
  : `https://soundcloud.com/search?q=${encodeURIComponent(q)}`);
const queryOf = t => `${t.artists[0] || ''} ${t.title}`.trim();

function reviewBlock(job, save) {
  const unsure = job.items.filter(i => i.state === 'unsure');
  return h('div.sheet.fill', {},
    h('h2', {}, `${songs(unsure.length)} prüfen`),
    h('p.muted', {}, 'Oft eine andere Version. Nimm einen Vorschlag oder lass den Song aus.'),
    h('div.scroll', {}, paged(unsure, item => h('li.review', {},
      h('div.t', {}, h('strong', {}, item.track.title), h('span', {}, artistLine(item.track))),
      h('div.cands', {}, item.candidates.filter(c => c.score >= 0.3).map(c => h('div.cand', {},
        h('a', { href: c.url, target: '_blank', rel: 'noopener' }, `${c.title}, ${(c.artists || []).join(', ')}`),
        btn('Nehmen', async () => { pick(job, item.key, c); await save(); render(); }, 'ghost small')))),
      btn('Auslassen', async () => { skip(job, item.key); await save(); render(); }, 'ghost small')), 25)));
}

async function jobView(id) {
  const job = live(id) || await store.get('jobs', id);
  if (!job) return missingView();
  const save = () => store.put('jobs', job);
  const c = counts(job);
  const name = serviceName(job.target.service);
  const parts = [
    deepHead(job.boxName, '#/jobs'),
    h('p.meta', { id: 'jobLine' }, `Nach ${name}. ${line(job)}`),
    jobSpine(job, spineSize()),
  ];
  const del = confirmBtn('Löschen', 'Wirklich löschen?', async () => { await store.del('jobs', id); go('#/jobs'); });
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
  const review = job.status === 'review';
  parts.push(review ? reviewBlock(job, save) : h('div.grow'));
  const bar = h('div.actions.bar');
  if (['queued', 'matching', 'writing'].includes(job.status)) bar.append(btn('Anhalten', () => { stop(id); toast('Hält nach dem aktuellen Song an.'); }, 'ghost'));
  if (review) bar.append(btn(`${songs(c.sure)} eintragen`, async () => { confirmReview(job); await save(); pump().catch(fail); render(); }));
  if (job.status === 'paused' && job.pauseReason === 'auth') bar.append(btn(`Bei ${name} anmelden`, () => login(adapter)));
  else if (job.status === 'paused' || job.status === 'failed') bar.append(btn('Weitermachen', async () => { retry(job); await save(); pump().catch(fail); render(); }));
  if (job.target.url) bar.append(h(`a.btn${job.status === 'done' ? '' : '.ghost'}`, { href: job.target.url, target: '_blank', rel: 'noopener' }, `In ${name} öffnen`));
  const missing = job.items.filter(i => i.state === 'missing');
  const more = () => dialog('Mehr', close => [
    h('div.grid', {},
      review ? btn('Alle ersten Vorschläge nehmen', async () => { acceptAllUnsure(job); await save(); close(); render(); }, 'ghost') : null,
      job.status === 'done' ? btn('Neue Songs nachziehen', async () => {
        close();
        const box = await store.get('boxes', job.boxId);
        if (!box) { toast('Die Kiste zu diesem Umzug gibt es nicht mehr.'); return; }
        try {
          if (box.source && navigator.onLine) {
            const fresh = dedupe((await refreshBox(box)).tracks);
            if (fresh.length) { box.tracks = fresh; await store.put('boxes', box); }
          }
          const added = delta(job, box);
          if (!added.length) { toast('Keine neuen Songs in der Kiste.'); return; }
          await startJob({ ...box, tracks: added }, { ...job.target });
        } catch (e) { fail(e); }
      }, 'ghost') : null,
      missing.length ? btn(`${songs(missing.length)} nicht gefunden`, () => {
        close();
        dialog(`${songs(missing.length)} nicht gefunden`, () => [paged(missing, item => h('li.track', {},
          h('div.t', {}, h('strong', {}, item.track.title), h('span', {}, artistLine(item.track))),
          h('a', { href: searchUrl(job.target.service, queryOf(item.track)), target: '_blank', rel: 'noopener' }, 'Selbst suchen')))]);
      }, 'ghost') : null,
      btn('Bericht (CSV)', () => { download(`Bericht ${safeFilename(job.boxName)}.csv`, reportCsv(job), 'text/csv'); close(); }, 'ghost'),
      del),
  ]);
  bar.append(btn('Mehr', more, 'ghost'));
  parts.push(bar);
  return h('div.view', {}, parts);
}

/* ---------- Geteilte Kiste ---------- */
let incoming = null;
async function sharedView() {
  if (!incoming) return missingView();
  const { name, tracks } = incoming;
  return h('div.view', {},
    deepHead(name, '#/'),
    h('p.meta', {}, `${songs(tracks.length)} wurden mit dir geteilt.`),
    spine(tracks, { height: spineSize(), colorOf: sleeveColor, label: songs(tracks.length) }),
    h('div.sheet.fill', {}, h('div.scroll', {}, paged(tracks, t => trackRow(t)))),
    h('div.actions.bar', {}, btn('In meine Kisten legen', async () => {
      const box = await saveBox(makeBox({ name, tracks }));
      incoming = null;
      go(`#/box/${box.id}`);
    })));
}

/* ---------- Dienste ---------- */
const connected = adapter => h('div.stack', {}, h('p.ok', {}, `Bei ${adapter.name} angemeldet.`), btn('Abmelden', () => { adapter.logout(); render(); }, 'ghost'));

function soundcloudPanel() {
  if (soundcloud.isConnected()) return connected(soundcloud);
  if (!soundcloud.isConfigured()) return h('p', {}, 'SoundCloud wird gerade eingerichtet. Ohne eigene Zugangsdaten für dich.');
  return h('div.stack', {}, h('p', {}, 'Melde dich an, um Sets und gelikte Tracks zu nutzen.'), btn('Bei SoundCloud anmelden', () => login(soundcloud)));
}

function servicePanel(adapter, { label, steps }) {
  if (adapter.isConnected()) return connected(adapter);
  const id = h('input', { value: adapter.clientId(), 'aria-label': label, placeholder: label, autocomplete: 'off', spellcheck: 'false' });
  return h('div.stack.grow', {},
    h('p', {}, 'Einmalig eine eigene Zugangs-ID eintragen. Sie bleibt in diesem Browser.'),
    h('ol.scroll', {}, steps.map(s => h('li', {}, s))),
    id,
    btn(`Bei ${adapter.name} anmelden`, () => {
      adapter.setClientId(id.value);
      login(adapter);
    }));
}

function backupPanel() {
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
  return h('div.stack', {},
    h('p', {}, 'Die Kisten liegen nur in diesem Browser. Mit der Sicherung nimmst du sie auf ein anderes Gerät mit.'),
    btn('Alle Kisten sichern', async () => {
      const boxes = await store.all('boxes');
      download('umzugskiste-sicherung.json', JSON.stringify({ app: 'umzugskiste', v: 1, boxes }), 'application/json');
    }, 'ghost'),
    h('label.field', {}, 'Sicherung einspielen', backupIn),
    confirmBtn('Alle Daten löschen', 'Wirklich alles löschen?', async () => {
      for (const st of ['boxes', 'jobs', 'cache']) await store.clear(st);
      Object.values(adapters).forEach(a => a.logout());
      toast('Alle Daten sind gelöscht.');
      go('#/');
    }));
}

async function settingsView(tab = 'spotify') {
  const uri = redirectUri();
  const panels = {
    spotify: () => servicePanel(spotify, { label: 'Spotify Client ID', steps: [
      h('span', {}, 'Im ', h('a', { href: 'https://developer.spotify.com/dashboard', target: '_blank', rel: 'noopener' }, 'Spotify Developer Dashboard'), ' eine App mit Web API anlegen. Das braucht Spotify Premium.'),
      h('span', {}, 'Als Redirect URI eintragen: ', h('code', {}, uri)),
      'Client ID kopieren und unten einfügen.',
    ] }),
    soundcloud: soundcloudPanel,
    backup: backupPanel,
  };
  const tabs = [['spotify', 'Spotify'], ['soundcloud', 'SoundCloud'], ['backup', 'Sicherung']];
  const active = panels[tab] ? tab : 'spotify';
  return h('div.view', {},
    rootHead('Dienste'),
    h('div.tabs', { role: 'tablist', 'aria-label': 'Einstellungen' }, tabs.map(([id, label]) => h('a', {
      role: 'tab', href: `#/settings/${id}`, 'aria-selected': String(id === active),
    }, label))),
    h('div.sheet.fill', {}, panels[active]()),
    soon());
}

const missingView = () => h('div.view', {}, deepHead('Nicht gefunden', '#/'), h('div.empty', {}, h('p', {}, 'Das gibt es hier nicht mehr.'), h('a.btn', { href: '#/' }, 'Zu den Kisten')));

/* ---------- Kopf: Neues, Info ---------- */
const SEEN = 'uk.seenVersion';
const lsGet = k => { try { return localStorage.getItem(k); } catch { return null; } };
const lsSet = (k, v) => { try { localStorage.setItem(k, v); } catch { /* privater Modus */ } };
const newer = (a, b) => a.localeCompare(b, 'en', { numeric: true }) > 0;

function showChangelog(entries = CHANGELOG, title = 'Neues') {
  dialog(title, () => [h('div', {}, entries.map(e => h('section.log', {},
    h('h3', {}, e.version), h('ul', {}, e.notes.map(n => h('li', {}, n))))))], () => lsSet(SEEN, VERSION));
}

function changelogOnUpdate() {
  const seen = lsGet(SEEN);
  if (!seen) { lsSet(SEEN, VERSION); return; }
  const fresh = CHANGELOG.filter(e => newer(e.version, seen));
  if (fresh.length) showChangelog(fresh, `Neu in ${VERSION}`);
}

let installEvent = null;
addEventListener('beforeinstallprompt', e => { e.preventDefault(); installEvent = e; });

function showInfo() {
  dialog('Umzugskiste', close => [h('div.stack', {},
    h('p', {}, 'Läuft nur in deinem Browser. Kisten liegen auf diesem Gerät, Anfragen gehen direkt an den jeweiligen Dienst.'),
    h('p.muted', {}, 'Die SoundCloud-Anmeldung läuft kurz über eine kleine Funktion, die nichts speichert.'),
    h('div.grid', {},
      btn('Neues', () => { close(); showChangelog(); }, 'ghost'),
      h('a.btn.ghost', { id: 'feedback', target: '_blank', rel: 'noopener', href: `https://github.com/Oliver19xx/Umzugskiste/issues/new?body=${encodeURIComponent(`Version ${VERSION}\n\n`)}` }, 'Feedback'),
      installEvent ? btn('Installieren', () => installEvent.prompt(), 'ghost') : null),
    installEvent ? null : h('p.muted', {}, 'iPhone: In Safari auf Teilen, dann „Zum Home-Bildschirm“.'),
    h('p.muted', {}, `Version ${VERSION}. Nicht verbunden mit Spotify oder SoundCloud.`))]);
}

/* ---------- Router ---------- */
function route() {
  const hash = location.hash || '#/';
  const p = hash.replace(/^#\/?/, '').split('/');
  if (p[0] === 'new') return [newView, [p[1]], null];
  if (p[0] === 'box' && p[2] === 'move') return [moveView, [p[1], p[3]], null];
  if (p[0] === 'box') return [boxView, [p[1]], null];
  if (p[0] === 'jobs') return [jobsView, [], 'jobs'];
  if (p[0] === 'job') return [jobView, [p[1]], null];
  if (p[0] === 'settings') return [settingsView, [p[1]], 'settings'];
  if (p[0] === 'shared') return [sharedView, [], null];
  return [homeView, [], 'home'];
}

let lastHash = null;
async function render() {
  const mine = ++renderId;
  const [fn, args, nav] = route();
  document.body.classList.toggle('deep', !nav);
  const entering = lastHash !== location.hash;
  lastHash = location.hash;
  document.querySelectorAll('[data-nav]').forEach(a => {
    if (a.dataset.nav === nav) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
  });
  try {
    const node = await fn(...args);
    if (mine === renderId) { node.classList.toggle('enter', entering); view.replaceChildren(node); }
  } catch (e) {
    if (mine === renderId) view.replaceChildren(h('div.view', {}, h('div.empty', {}, h('h1', {}, 'Das ging schief.'), h('p', {}, e.message))));
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
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') navigator.serviceWorker.getRegistration().then(r => r?.update()).catch(() => {});
  });
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
  const state = query.get('state') || '';
  const adapter = state.startsWith('sp.') ? spotify : state.startsWith('sc.') ? soundcloud : null;
  if (adapter) {
    try {
      if (query.get('error')) throw new Error(`Die ${adapter.name}-Anmeldung wurde abgebrochen.`);
      await adapter.finishLogin(query.get('code'), state);
      await resumeAuthPaused(adapter.id);
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
  changelogOnUpdate();
  pump().catch(() => {});
})();
