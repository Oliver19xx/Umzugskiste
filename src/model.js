// Datenmodell: Kiste (Sammlung von Songs), Song und ein paar kleine Helfer.
import { norm } from './match.js';

export const VERSION = '0.1.0';
export const CHANGELOG = [
  { version: '0.1.0', notes: [
    'Playlists aus Spotify, SoundCloud, Dateien oder Text in Kisten packen',
    'Kisten zu Spotify oder SoundCloud umziehen',
    'Unsichere Treffer prüfen, Kisten per Link teilen, alles auch offline',
  ] },
];

export const uid = () => (globalThis.crypto?.randomUUID?.() ?? `id-${Date.now()}-${Math.random().toString(36).slice(2)}`);

export function makeTrack({ title = '', artists = [], album = '', durationMs = 0, isrc = '', refs = {} }) {
  const list = Array.isArray(artists) ? artists : splitArtists(artists);
  return {
    title: String(title).trim(),
    artists: list.filter(Boolean).map(a => String(a).trim()).filter(Boolean),
    album: String(album || '').trim(),
    durationMs: Number(durationMs) || 0,
    isrc: String(isrc || '').trim().toUpperCase().replace(/-/g, ''),
    refs: { ...refs },
  };
}

export function splitArtists(value) {
  return String(value || '')
    .split(/\s*(?:;|,\s|\s&\s|\s(?:feat\.?|ft\.?|featuring)\s)\s*/i)
    .map(s => s.trim())
    .filter(Boolean);
}

export function trackKey(t) {
  if (t.isrc) return `isrc:${t.isrc}`;
  return `t:${norm(t.artists[0] || '')}|${norm(t.title)}`;
}

export function dedupe(tracks) {
  const seen = new Set();
  return tracks.filter(t => {
    const k = trackKey(t);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

export function makeBox({ name, tracks, source = null }) {
  const now = Date.now();
  return { id: uid(), name: String(name || 'Neue Kiste').trim() || 'Neue Kiste', tracks, source, createdAt: now, updatedAt: now };
}

export const songs = n => (n === 1 ? '1 Song' : `${n.toLocaleString('de-DE')} Songs`);
export const artistLine = t => t.artists.join(', ');
