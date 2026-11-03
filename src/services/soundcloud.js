// SoundCloud: Login per PKCE, der Token-Tausch läuft über die Token-Funktion, weil
// SoundCloud ein Client Secret verlangt und das nicht in den Browser darf.
// Limits pro App: rund 100 Anfragen pro Minute, 3.000 Suchen pro Stunde, 500 Likes am Tag.
import { makeTrack } from '../model.js';
import { AuthError, OfflineError, QuotaError } from '../errors.js';
import { CONFIG } from '../config.js';
import { random, challenge, redirectUri } from './pkce.js';

const API = 'https://api.soundcloud.com';
const AUTHORIZE = 'https://secure.soundcloud.com/authorize';
const MAX_WAIT = 60;
const SEARCH_GAP = 650;
const MAX_TRIES = 3;
const BLIND_PAUSE = 900;
const sleep = ms => new Promise(r => setTimeout(r, ms));

const load = k => { try { return JSON.parse(localStorage.getItem(`uk.soundcloud.${k}`)); } catch { return null; } };
const save = (k, v) => { try { localStorage.setItem(`uk.soundcloud.${k}`, JSON.stringify(v)); } catch { /* Speicher gesperrt */ } };
const drop = k => { try { localStorage.removeItem(`uk.soundcloud.${k}`); } catch { /* Speicher gesperrt */ } };

async function tokenRequest(body) {
  let res;
  try {
    res = await fetch(CONFIG.soundcloudTokenUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  } catch { throw new OfflineError('offline'); }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (body.grant_type === 'refresh_token') drop('session');
    throw new AuthError(`SoundCloud-Anmeldung fehlgeschlagen. Melde dich neu an.`);
  }
  const session = { access: data.access_token, refresh: data.refresh_token, exp: Date.now() + (data.expires_in - 60) * 1000 };
  save('session', session);
  return session;
}

// Ein Refresh-Token gilt nur einmal, darum nie zwei Erneuerungen gleichzeitig.
let refreshing = null;
function refresh() {
  const s = load('session');
  if (!s?.refresh) { drop('session'); throw new AuthError('Die SoundCloud-Anmeldung ist abgelaufen. Melde dich neu an.'); }
  refreshing ??= tokenRequest({ grant_type: 'refresh_token', refresh_token: s.refresh }).finally(() => { refreshing = null; });
  return refreshing;
}

// Fremde Origins geben Limit-Header nur frei, wenn der Dienst es erlaubt. Sonst: Wartezeit verdoppeln.
function waitFrom(res, tries) {
  const after = Number(res.headers.get('Retry-After'));
  if (after) return after;
  const reset = Number(res.headers.get('X-Ratelimit-Reset'));
  if (reset) return Math.max(1, reset - Date.now() / 1000);
  return tries > MAX_TRIES ? BLIND_PAUSE : 2 ** (tries - 1);
}

async function api(path, opts = {}) {
  let session = load('session');
  if (!session) throw new AuthError('Melde dich bei SoundCloud an, um weiterzumachen.');
  if (Date.now() > session.exp) session = await refresh();
  const url = path.startsWith('http') ? path : API + path;
  let renewed = false;
  let tries = 0;
  for (;;) {
    let res;
    try {
      res = await fetch(url, {
        method: opts.method || 'GET',
        headers: { Accept: 'application/json', Authorization: `OAuth ${session.access}`, ...(opts.body ? { 'Content-Type': 'application/json' } : {}) },
        body: opts.body ? JSON.stringify(opts.body) : undefined,
      });
    } catch { throw new OfflineError('offline'); }
    if (res.status === 429) {
      const wait = waitFrom(res, ++tries);
      if (wait > MAX_WAIT) throw new QuotaError(`SoundCloud-Limit erreicht. Es geht in ${Math.ceil(wait / 60)} Minuten weiter, wenn die App offen ist.`, Date.now() + wait * 1000);
      await sleep(wait * 1000);
      continue;
    }
    if (res.status === 401 && !renewed) { renewed = true; session = await refresh(); continue; }
    if (res.status === 401) throw new AuthError('Die SoundCloud-Anmeldung ist abgelaufen. Melde dich neu an.');
    const data = await res.json().catch(() => null);
    if (!res.ok) {
      const err = new Error(`SoundCloud meldet ${res.status}: ${data?.message || data?.error || 'unbekannter Fehler'}`);
      err.status = res.status;
      throw err;
    }
    return data;
  }
}

async function getAll(path, onProgress) {
  const join = path.includes('?') ? '&' : '?';
  const out = [];
  let next = `${path}${join}linked_partitioning=true`;
  while (next) {
    const page = await api(next);
    const rows = page.collection || [];
    out.push(...rows);
    onProgress?.(out.length);
    next = rows.length ? page.next_href : null;
  }
  return out;
}

// Uploads heißen oft „Künstler - Titel“, der Kontoname ist nur der Hochlader.
export function parseUpload(t) {
  const title = String(t.title || '');
  const named = t.metadata_artist?.trim();
  if (named) return { title, artists: [named] };
  const dash = title.match(/^(.+?)\s+[-–—]\s+(.+)$/);
  if (dash) return { title: dash[2].trim(), artists: [dash[1].trim()] };
  return { title, artists: [t.user?.username].filter(Boolean) };
}

const fromSoundcloud = t => makeTrack({
  ...parseUpload(t), durationMs: t.duration, isrc: t.isrc,
  refs: { soundcloud: t.urn, soundcloudUrl: t.permalink_url },
});
const candidate = t => ({
  id: t.urn, ...parseUpload(t), durationMs: t.duration || 0, isrc: (t.isrc || '').toUpperCase().replace(/-/g, ''), url: t.permalink_url,
});
const enc = encodeURIComponent;
const playlistTracks = (urn, onProgress) => getAll(`/playlists/${enc(urn)}/tracks?access=playable,preview,blocked`, onProgress);

export const soundcloud = {
  id: 'soundcloud', name: 'SoundCloud', batchSize: 50, canLike: true,
  isConfigured: () => !!(CONFIG.soundcloudClientId && CONFIG.soundcloudTokenUrl),
  isConnected: () => !!load('session'),
  logout() { drop('session'); },

  async login() {
    if (!this.isConfigured()) throw new Error('SoundCloud ist noch nicht eingerichtet.');
    const verifier = random(), state = `sc.${random()}`;
    save('verifier', verifier); save('state', state);
    location.href = `${AUTHORIZE}?${new URLSearchParams({
      client_id: CONFIG.soundcloudClientId, redirect_uri: redirectUri(), response_type: 'code', scope: '',
      code_challenge: await challenge(verifier), code_challenge_method: 'S256', state,
    })}`;
  },

  async finishLogin(code, state) {
    const expected = load('state'), verifier = load('verifier');
    drop('state'); drop('verifier');
    if (!expected || state !== expected || !verifier) throw new Error('Die Anmeldung ließ sich nicht bestätigen. Melde dich noch einmal an.');
    await tokenRequest({ grant_type: 'authorization_code', code, code_verifier: verifier, redirect_uri: redirectUri() });
  },

  async listSources() {
    const lists = await getAll('/me/playlists?limit=200&show_tracks=false');
    return [{ ref: 'likes', name: 'Gelikte Tracks', total: null }, ...lists.map(p => ({ ref: `playlist:${p.urn}`, name: p.title, total: p.track_count ?? null }))];
  },

  async readSource(ref, onProgress) {
    if (ref === 'likes') {
      const rows = await getAll('/me/likes/tracks?limit=200', onProgress);
      return { name: 'Gelikte Tracks', tracks: rows.filter(t => t?.urn).map(fromSoundcloud) };
    }
    const urn = ref.replace(/^playlist:/, '');
    const meta = await api(`/playlists/${enc(urn)}?show_tracks=false`);
    const rows = await playlistTracks(urn, onProgress);
    return { name: meta.title, tracks: rows.filter(t => t?.urn).map(fromSoundcloud) };
  },

  async resolve(url) {
    const found = await api(`/resolve?url=${enc(url)}`);
    if (!String(found?.urn || '').includes(':playlists:')) throw new Error('Dieser Link führt nicht zu einem SoundCloud-Set.');
    return `playlist:${found.urn}`;
  },

  async search(track) {
    await sleep(this.searchGap ?? SEARCH_GAP);
    const q = `${track.artists[0] || ''} ${track.title}`.trim();
    const page = await api(`/tracks?q=${enc(q)}&limit=20&access=playable,preview&linked_partitioning=true`);
    return (page.collection || []).filter(t => t?.urn).map(candidate);
  },

  async listTargets() {
    const lists = await getAll('/me/playlists?limit=200&show_tracks=false');
    return lists.map(p => ({ id: p.urn, name: p.title }));
  },

  async createPlaylist(name) {
    const made = await api('/playlists', {
      method: 'POST', body: { playlist: { title: name, sharing: 'private', description: 'Eingepackt mit Umzugskiste' } },
    });
    return { id: made.urn, url: made.permalink_url };
  },

  async existingIds(playlistId) {
    if (playlistId === 'likes') return new Set();
    return new Set((await playlistTracks(playlistId)).map(t => t?.urn).filter(Boolean));
  },

  async addTracks(playlistId, matches) {
    if (playlistId === 'likes') {
      for (const m of matches) await api(`/likes/tracks/${enc(m.id)}`, { method: 'POST' });
      return;
    }
    // PUT schickt die ganze Liste. Darum vorher frisch lesen, nichts anderes wird verändert.
    const current = (await playlistTracks(playlistId)).map(t => t?.urn).filter(Boolean);
    const merged = [...new Set([...current, ...matches.map(m => m.id)])];
    const saved = await api(`/playlists/${enc(playlistId)}`, { method: 'PUT', body: { playlist: { tracks: merged.map(urn => ({ urn })) } } });
    if (typeof saved?.track_count === 'number' && saved.track_count < current.length) {
      throw new Error(`SoundCloud meldet nur noch ${saved.track_count} statt ${current.length} Tracks. Der Umzug ist gestoppt, bitte prüfe die Playlist.`);
    }
  },
};
