// Ausgabe als Datei: CSV, Text, JSON und Umzugsbericht.
import { artistLine } from './model.js';

// Zellen mit = + - @ würde eine Tabellenkalkulation als Formel ausführen.
const guard = v => {
  const s = String(v ?? '');
  return /^[=+\-@]/.test(s) ? `'${s}` : s;
};
const cell = v => {
  const s = guard(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
export const csvLine = values => values.map(cell).join(',');

export function toCsv(tracks) {
  const head = ['title', 'artist', 'album', 'duration_ms', 'isrc', 'spotify_id', 'youtube_id'];
  const rows = tracks.map(t => csvLine([t.title, t.artists.join('; '), t.album, t.durationMs || '', t.isrc, t.refs.spotify || '', t.refs.youtube || '']));
  return `﻿${head.join(',')}\n${rows.join('\n')}\n`;
}
export const toText = tracks => `${tracks.map(t => (t.artists.length ? `${artistLine(t)} - ${t.title}` : t.title)).join('\n')}\n`;
export const toJson = box => JSON.stringify({ app: 'umzugskiste', v: 1, name: box.name, tracks: box.tracks }, null, 2);

const STATE = { written: 'übertragen', sure: 'gefunden', unsure: 'unsicher', missing: 'nicht gefunden', skipped: 'ausgelassen', pending: 'offen' };
export function reportCsv(job) {
  const head = 'status,title,artist,match_title,match_artist,score,link';
  const rows = job.items.map(i => csvLine([
    STATE[i.state] || i.state, i.track.title, artistLine(i.track),
    i.match?.title || '', (i.match?.artists || []).join('; '), i.match?.score ?? '', i.match?.url || '',
  ]));
  return `﻿${head}\n${rows.join('\n')}\n`;
}

export function safeFilename(name) {
  return String(name).replace(/[^\p{L}\p{N} ._-]+/gu, '').trim().slice(0, 80) || 'kiste';
}
