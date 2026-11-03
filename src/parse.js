// Einlesen ohne Netz: freier Text, CSV (auch Exportify), M3U und eigenes JSON.
import { makeTrack, splitArtists } from './model.js';

export function parseLine(raw) {
  let line = raw.trim()
    .replace(/^\d{1,4}[.)]\s+/, '')
    .replace(/^\[?\d{1,2}:\d{2}(?::\d{2})?\]?\s+/, '')
    .replace(/\s+\(?\d{1,2}:\d{2}\)?$/, '');
  if (!line || line.startsWith('#') || /^https?:\/\//i.test(line)) return null;
  const tab = line.split('\t');
  if (tab.length >= 2) return makeTrack({ artists: tab[0], title: tab[1] });
  const dash = line.match(/^(.+?)\s+[-–—]\s+(.+)$/);
  if (dash) return makeTrack({ artists: dash[1], title: dash[2] });
  const by = line.match(/^(.+?)\s+(?:by|von)\s+(.+)$/i);
  if (by) return makeTrack({ title: by[1], artists: by[2] });
  return makeTrack({ title: line });
}

export function parseText(text) {
  return String(text).split(/\r?\n/).map(parseLine).filter(Boolean);
}

export function parseM3u(text) {
  const out = [];
  let seconds = 0;
  for (const raw of String(text).split(/\r?\n/)) {
    const m = raw.match(/^#EXTINF:(-?\d+)[^,]*,(.*)$/i);
    if (!m) continue;
    seconds = Math.max(0, Number(m[1]));
    const t = parseLine(m[2]);
    if (t) out.push({ ...t, durationMs: seconds * 1000 });
  }
  return out;
}

export function csvRows(text) {
  const src = String(text).replace(/^﻿/, '');
  const first = src.split(/\r?\n/, 1)[0] || '';
  const delim = [',', ';', '\t'].sort((a, b) => first.split(b).length - first.split(a).length)[0];
  const rows = [];
  let row = [], cell = '', quoted = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (quoted) {
      if (c === '"' && src[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"' && cell === '') quoted = true;
    else if (c === delim) { row.push(cell); cell = ''; }
    else if (c === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; }
    else if (c !== '\r') cell += c;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows.filter(r => r.some(c => c.trim()));
}

const COLUMNS = {
  title: ['title', 'track name', 'track', 'name', 'song', 'song name', 'titel'],
  artist: ['artist', 'artists', 'artist name', 'artist name(s)', 'artist names', 'künstler', 'interpret'],
  album: ['album', 'album name'],
  isrc: ['isrc'],
  durationMs: ['duration_ms', 'duration (ms)', 'track duration (ms)'],
  spotify: ['spotify_id', 'track uri', 'spotify - id', 'spotify id', 'uri'],
  soundcloud: ['soundcloud_urn'],
};
const unguard = v => String(v ?? '').replace(/^'(?=[=+\-@])/, '').trim();

export function parseCsv(text) {
  const rows = csvRows(text);
  if (!rows.length) return [];
  const head = rows[0].map(h => h.trim().toLowerCase());
  const col = {};
  for (const [key, names] of Object.entries(COLUMNS)) col[key] = head.findIndex(h => names.includes(h));
  if (col.title < 0) return parseText(rows.map(r => r.join(' - ')).join('\n'));
  return rows.slice(1).map(r => {
    const get = k => (col[k] >= 0 ? unguard(r[col[k]]) : '');
    const refs = {};
    const sp = get('spotify').replace(/^spotify:track:/, '');
    if (/^[0-9A-Za-z]{22}$/.test(sp)) refs.spotify = sp;
    if (get('soundcloud')) refs.soundcloud = get('soundcloud');
    return makeTrack({
      title: get('title'), artists: splitArtists(get('artist')), album: get('album'),
      durationMs: get('durationMs'), isrc: get('isrc'), refs,
    });
  }).filter(t => t.title);
}

export function parseJson(text) {
  const data = JSON.parse(text);
  const list = Array.isArray(data) ? data : data.tracks;
  if (!Array.isArray(list)) throw new Error('Diese JSON-Datei enthält keine Songliste.');
  return list.map(t => makeTrack(t)).filter(t => t.title);
}

export function parseFile(name, text) {
  const lower = name.toLowerCase();
  let tracks;
  if (lower.endsWith('.json')) tracks = parseJson(text);
  else if (lower.endsWith('.csv') || lower.endsWith('.tsv')) tracks = parseCsv(text);
  else if (lower.endsWith('.m3u') || lower.endsWith('.m3u8')) tracks = parseM3u(text);
  else tracks = parseText(text);
  return { name: name.replace(/\.[^.]+$/, ''), tracks };
}
