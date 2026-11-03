// Spotify über PKCE, ohne Server und ohne Client Secret.
// Pfade folgen den Dev-Mode-Regeln seit Februar 2026 (Suche max. 10, /items, /me/library).
import { makeTrack } from '../model.js';
import { AuthError, OfflineError, QuotaError } from '../errors.js';

const ACCOUNTS = 'https://accounts.spotify.com';
const API = 'https://api.spotify.com/v1';
const SCOPES = 'playlist-read-private playlist-read-collaborative playlist-modify-private playlist-modify-public user-library-read user-library-modify';
const MAX_WAIT = 60;
const sleep = ms => new Promise(r => setTimeout(r, ms));

const load = k => { try { return JSON.parse(localStorage.getItem(`uk.spotify.${k}`)); } catch { return null; } };
const save = (k, v) => localStorage.setItem(`uk.spotify.${k}`, JSON.stringify(v));
const drop = k => localStorage.removeItem(`uk.spotify.${k}`);

const b64url = buf => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const random = () => b64url(crypto.getRandomValues(new Uint8Array(48)));

export const redirectUri = () => location.origin + location.pathname;

async function tokenRequest(params) {
  const res = await fetch(`${ACCOUNTS}/api/token`, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(params),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new AuthError(`Spotify-Anmeldung fehlgeschlagen: ${data.error_description || data.error || res.status}`);
  const old = load('session') || {};
  const session = { access: data.access_token, refresh: data.refresh_token || old.refresh, exp: Date.now() + (data.expires_in - 60) * 1000 };
  save('session', session);
  return session;
}

let refreshing = null;
function refresh() {
  const s = load('session');
  if (!s?.refresh) { drop('session'); throw new AuthError('Die Spotify-Anmeldung ist abgelaufen. Melde dich neu an.'); }
  refreshing ??= tokenRequest({ grant_type: 'refresh_token', refresh_token: s.refresh, client_id: load('clientId') })
    .finally(() => { refreshing = null; });
  return refreshing;
}

async function api(path, opts = {}) {
  let session = load('session');
  if (!session) throw new AuthError('Melde dich bei Spotify an, um weiterzumachen.');
  if (Date.now() > session.exp) session = await refresh();
  const url = path.startsWith('http') ? path : API + path;
  let renewed = false;
  for (;;) {
    let res;
    try {
      res = await fetch(url, {
        method: opts.method || 'GET',
        headers: { Authorization: `Bearer ${session.access}`, ...(opts.body ? { 'Content-Type': 'application/json' } : {}) },
        body: opts.body ? JSON.stringify(opts.body) : undefined,
      });
    } catch { throw new OfflineError('offline'); }
    if (res.status === 429) {
      const wait = Number(res.headers.get('Retry-After')) || 1;
      if (wait > MAX_WAIT) throw new QuotaError(`Spotify drosselt gerade. Es geht in ${Math.ceil(wait / 60)} Minuten weiter.`, Date.now() + wait * 1000);
      await sleep(wait * 1000);
      continue;
    }
    if (res.status === 401 && !renewed) { renewed = true; session = await refresh(); continue; }
    if (res.status === 401) throw new AuthError('Die Spotify-Anmeldung ist abgelaufen. Melde dich neu an.');
    const data = await res.json().catch(() => null);
    if (!res.ok) {
      const err = new Error(`Spotify meldet ${res.status}: ${data?.error?.message || 'unbekannter Fehler'}`);
      err.status = res.status;
      throw err;
    }
    return data;
  }
}

async function getAll(path, onProgress) {
  const out = [];
  let next = path;
  while (next) {
    const page = await api(next);
    out.push(...page.items);
    onProgress?.(out.length, page.total);
    next = page.next;
  }
  return out;
}

const fromSpotify = t => makeTrack({
  title: t.name, artists: (t.artists || []).map(a => a.name), album: t.album?.name,
  durationMs: t.duration_ms, isrc: t.external_ids?.isrc, refs: { spotify: t.id },
});
const candidate = t => ({
  id: t.id, uri: t.uri, title: t.name, artists: (t.artists || []).map(a => a.name), album: t.album?.name,
  durationMs: t.duration_ms, isrc: t.external_ids?.isrc || '', url: t.external_urls?.spotify || `https://open.spotify.com/track/${t.id}`,
});
const quoted = s => s.replace(/"/g, '');
const searchTracks = async (q, limit) => {
  const data = await api(`/search?type=track&limit=${limit}&q=${encodeURIComponent(q)}`);
  return (data.tracks?.items || []).filter(Boolean).map(candidate);
};

export const spotify = {
  id: 'spotify', name: 'Spotify', batchSize: 100, canLike: true,
  hasClientId: () => !!load('clientId'),
  clientId: () => load('clientId') || '',
  setClientId(id) { save('clientId', id.trim()); },
  isConnected: () => !!load('session'),
  logout() { drop('session'); },

  async login() {
    const clientId = load('clientId');
    if (!clientId) throw new Error('Trage zuerst deine Spotify Client ID ein.');
    const verifier = random(), state = `sp.${random()}`;
    save('verifier', verifier); save('state', state);
    const challenge = b64url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
    location.href = `${ACCOUNTS}/authorize?${new URLSearchParams({
      response_type: 'code', client_id: clientId, redirect_uri: redirectUri(), scope: SCOPES,
      code_challenge_method: 'S256', code_challenge: challenge, state,
    })}`;
  },

  async finishLogin(code, state) {
    const expected = load('state'), verifier = load('verifier');
    drop('state'); drop('verifier');
    if (!expected || state !== expected || !verifier) throw new Error('Die Anmeldung ließ sich nicht bestätigen. Melde dich noch einmal an.');
    await tokenRequest({ grant_type: 'authorization_code', code, redirect_uri: redirectUri(), client_id: load('clientId'), code_verifier: verifier });
  },

  async listSources() {
    const lists = (await getAll('/me/playlists?limit=50')).filter(Boolean);
    const items = lists.map(p => ({ ref: `playlist:${p.id}`, name: p.name, total: (p.items || p.tracks)?.total ?? null }));
    return [{ ref: 'likes', name: 'Lieblingssongs', total: null }, ...items];
  },

  async readSource(ref, onProgress) {
    if (ref === 'likes') {
      const rows = await getAll('/me/tracks?limit=50', onProgress);
      return { name: 'Lieblingssongs', tracks: rows.map(r => r.track).filter(t => t?.id).map(fromSpotify) };
    }
    const id = ref.replace(/^playlist:/, '');
    const meta = await api(`/playlists/${encodeURIComponent(id)}?fields=name`);
    try {
      const rows = await getAll(`/playlists/${encodeURIComponent(id)}/items?additional_types=track&limit=50`, onProgress);
      return { name: meta.name, tracks: rows.map(r => r?.item || r?.track).filter(t => t?.id && t.type !== 'episode').map(fromSpotify) };
    } catch (e) {
      if (e.status === 403) throw new Error('Spotify gibt nur Songs aus eigenen und kollaborativen Playlists heraus. Kopiere die Playlist zuerst in der Spotify-App.');
      throw e;
    }
  },

  async search(track) {
    if (track.isrc && /^[A-Z0-9]{12}$/.test(track.isrc)) {
      const hits = await searchTracks(`isrc:${track.isrc}`, 3);
      if (hits.length) return hits;
    }
    const artist = track.artists[0];
    const strict = artist ? await searchTracks(`track:"${quoted(track.title)}" artist:"${quoted(artist)}"`, 10) : [];
    if (strict.length) return strict;
    return searchTracks(`${track.title} ${artist || ''}`.trim(), 10);
  },

  async listTargets() {
    const lists = (await getAll('/me/playlists?limit=50')).filter(Boolean);
    return lists.map(p => ({ id: p.id, name: p.name }));
  },

  async createPlaylist(name) {
    const made = await api('/me/playlists', {
      method: 'POST', body: { name, public: false, description: 'Eingepackt mit Umzugskiste' },
    });
    return { id: made.id, url: made.external_urls?.spotify || `https://open.spotify.com/playlist/${made.id}` };
  },

  async existingIds(playlistId) {
    if (playlistId === 'likes') return new Set();
    const rows = await getAll(`/playlists/${encodeURIComponent(playlistId)}/items?additional_types=track&limit=50`);
    return new Set(rows.map(r => (r?.item || r?.track)?.id).filter(Boolean));
  },

  async addTracks(playlistId, matches) {
    const uris = matches.map(m => m.uri || `spotify:track:${m.id}`);
    if (playlistId === 'likes') {
      for (let i = 0; i < uris.length; i += 40) {
        await api(`/me/library?uris=${encodeURIComponent(uris.slice(i, i + 40).join(','))}`, { method: 'PUT' });
      }
      return;
    }
    await api(`/playlists/${encodeURIComponent(playlistId)}/items`, { method: 'POST', body: { uris } });
  },
};
