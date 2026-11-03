// YouTube Data API v3. Der Login nutzt den Token-Redirect von Google, damit
// kein Google-Skript auf der Seite läuft. Ein Token hält rund eine Stunde.
// Tageslimit: 100 Suchen und 10.000 Einheiten, Neustart um Mitternacht Pacific Time.
import { makeTrack } from '../model.js';
import { AuthError, OfflineError, QuotaError } from '../errors.js';
import { redirectUri } from './spotify.js';

const API = 'https://www.googleapis.com/youtube/v3';
const SCOPE = 'https://www.googleapis.com/auth/youtube';
export const SEARCH_LIMIT = 100;
export const UNIT_LIMIT = 10000;

const load = k => { try { return JSON.parse(localStorage.getItem(`uk.youtube.${k}`)); } catch { return null; } };
const save = (k, v) => localStorage.setItem(`uk.youtube.${k}`, JSON.stringify(v));
const drop = k => localStorage.removeItem(`uk.youtube.${k}`);

const ptDay = ms => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles' }).format(ms);
export function nextReset(now = Date.now()) {
  const today = ptDay(now);
  let t = now - (now % 60000);
  while (ptDay(t) === today) t += 60000;
  return t + 60000;
}

function quota() {
  const q = load('quota');
  const day = ptDay(Date.now());
  return q?.day === day ? q : { day, searches: 0, units: 0 };
}
function spend(units, searches = 0) {
  const q = quota();
  q.units += units; q.searches += searches;
  save('quota', q);
}
const limitError = () => new QuotaError('Das YouTube-Tageslimit ist erreicht. Der Umzug läuft nach dem Neustart des Limits automatisch weiter, sobald die App offen ist.', nextReset());

async function api(path, { method = 'GET', params = {}, body, units = 1 } = {}) {
  const session = load('session');
  if (!session || Date.now() > session.exp) throw new AuthError('Die YouTube-Anmeldung ist abgelaufen. Melde dich neu an, der Umzug läuft dann weiter.');
  if (quota().units + units > UNIT_LIMIT) throw limitError();
  let res;
  try {
    res = await fetch(`${API}${path}?${new URLSearchParams(params)}`, {
      method,
      headers: { Authorization: `Bearer ${session.access}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch { throw new OfflineError('offline'); }
  const data = await res.json().catch(() => null);
  if (res.status === 401) throw new AuthError('Die YouTube-Anmeldung ist abgelaufen. Melde dich neu an, der Umzug läuft dann weiter.');
  if (res.status === 403 && /quota/i.test(data?.error?.errors?.[0]?.reason || '')) throw limitError();
  if (!res.ok) throw new Error(`YouTube meldet ${res.status}: ${data?.error?.message || 'unbekannter Fehler'}`);
  spend(units);
  return data;
}

async function getAll(path, params, onProgress) {
  const out = [];
  let pageToken;
  do {
    const page = await api(path, { params: { ...params, maxResults: 50, ...(pageToken ? { pageToken } : {}) } });
    out.push(...page.items);
    onProgress?.(out.length, page.pageInfo?.totalResults);
    pageToken = page.nextPageToken;
  } while (pageToken);
  return out;
}

const NOISE = /[([][^)\]]*(official|video|audio|lyrics?|visuali[sz]er|hd|4k|m\/v)[^)\]]*[)\]]/gi;
export function parseVideo(title, channel) {
  const clean = String(title).replace(NOISE, ' ').replace(/\s+/g, ' ').trim();
  const dash = clean.match(/^(.+?)\s+[-–—|]\s+(.+)$/);
  if (dash) return { title: dash[2].trim(), artists: [dash[1].trim()] };
  return { title: clean, artists: [String(channel || '').replace(/\s*-\s*Topic$/i, '').replace(/VEVO$/i, '').trim()].filter(Boolean) };
}
export const isoDuration = s => {
  const m = String(s).match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
  return m ? (Number(m[1] || 0) * 3600 + Number(m[2] || 0) * 60 + Number(m[3] || 0)) * 1000 : 0;
};
const videoUrl = id => `https://music.youtube.com/watch?v=${id}`;

export const youtube = {
  id: 'youtube', name: 'YouTube', batchSize: 1, canLike: false,
  hasClientId: () => !!load('clientId'),
  clientId: () => load('clientId') || '',
  setClientId(id) { save('clientId', id.trim()); },
  isConnected: () => { const s = load('session'); return !!s && Date.now() < s.exp; },
  logout() { drop('session'); },
  quota,

  async login() {
    const clientId = load('clientId');
    if (!clientId) throw new Error('Trage zuerst deine Google OAuth Client ID ein.');
    const state = `yt.${crypto.randomUUID()}`;
    save('state', state);
    location.href = `https://accounts.google.com/o/oauth2/v2/auth?${new URLSearchParams({
      client_id: clientId, redirect_uri: redirectUri(), response_type: 'token', scope: SCOPE, state, include_granted_scopes: 'true',
    })}`;
  },

  finishLogin(params) {
    const expected = load('state');
    drop('state');
    if (!expected || params.get('state') !== expected) throw new Error('Die Anmeldung ließ sich nicht bestätigen. Melde dich noch einmal an.');
    save('session', { access: params.get('access_token'), exp: Date.now() + (Number(params.get('expires_in')) - 60) * 1000 });
  },

  async listSources() {
    const lists = await getAll('/playlists', { part: 'snippet,contentDetails', mine: 'true' });
    return lists.map(p => ({ ref: `playlist:${p.id}`, name: p.snippet.title, total: p.contentDetails.itemCount }));
  },

  async readSource(ref, onProgress) {
    const id = ref.replace(/^playlist:/, '');
    const meta = await api('/playlists', { params: { part: 'snippet', id } });
    const rows = await getAll('/playlistItems', { part: 'snippet', playlistId: id }, onProgress);
    const tracks = rows
      .filter(r => r.snippet?.resourceId?.videoId && r.snippet.title !== 'Deleted video' && r.snippet.title !== 'Private video')
      .map(r => makeTrack({ ...parseVideo(r.snippet.title, r.snippet.videoOwnerChannelTitle), refs: { youtube: r.snippet.resourceId.videoId } }));
    return { name: meta.items?.[0]?.snippet?.title || 'YouTube-Playlist', tracks };
  },

  async search(track) {
    if (quota().searches >= SEARCH_LIMIT) throw limitError();
    const q = `${track.artists[0] || ''} ${track.title}`.trim();
    const found = await api('/search', { params: { part: 'snippet', type: 'video', videoCategoryId: '10', maxResults: 5, q } });
    spend(0, 1);
    const ids = found.items.map(i => i.id.videoId);
    if (!ids.length) return [];
    const details = await api('/videos', { params: { part: 'contentDetails', id: ids.join(',') } });
    const length = new Map(details.items.map(v => [v.id, isoDuration(v.contentDetails.duration)]));
    return found.items.map(i => ({
      id: i.id.videoId, ...parseVideo(i.snippet.title, i.snippet.channelTitle),
      durationMs: length.get(i.id.videoId) || 0, url: videoUrl(i.id.videoId),
    }));
  },

  async listTargets() {
    const lists = await getAll('/playlists', { part: 'snippet', mine: 'true' });
    return lists.map(p => ({ id: p.id, name: p.snippet.title }));
  },

  async createPlaylist(name) {
    const made = await api('/playlists', {
      method: 'POST', params: { part: 'snippet,status' }, units: 50,
      body: { snippet: { title: name, description: 'Eingepackt mit Umzugskiste' }, status: { privacyStatus: 'private' } },
    });
    return { id: made.id, url: `https://music.youtube.com/playlist?list=${made.id}` };
  },

  async existingIds(playlistId) {
    const rows = await getAll('/playlistItems', { part: 'snippet', playlistId });
    return new Set(rows.map(r => r.snippet?.resourceId?.videoId).filter(Boolean));
  },

  async addTracks(playlistId, matches) {
    for (const m of matches) {
      await api('/playlistItems', {
        method: 'POST', params: { part: 'snippet' }, units: 50,
        body: { snippet: { playlistId, resourceId: { kind: 'youtube#video', videoId: m.id } } },
      });
    }
  },
};
