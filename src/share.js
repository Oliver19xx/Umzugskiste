// Teilen ohne Server: Die Kiste steckt gepackt im #-Teil des Links.
// Der #-Teil wird von Browsern nicht an den Webserver gesendet.
import { makeTrack, artistLine } from './model.js';

const MAX_UNPACKED = 5 * 1024 * 1024;

const toB64 = bytes => {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};
const fromB64 = str => {
  const bin = atob(str.replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(bin, c => c.charCodeAt(0));
};

async function pipe(bytes, stream) {
  const reader = new Blob([bytes]).stream().pipeThrough(stream).getReader();
  const parts = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > MAX_UNPACKED) { await reader.cancel(); throw new Error('Dieser Link ist zu groß.'); }
    parts.push(value);
  }
  const out = new Uint8Array(size);
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}

export async function encodeShare(box) {
  const data = {
    v: 1, n: box.name,
    t: box.tracks.map(t => [t.title, artistLine(t), t.isrc || '', Math.round(t.durationMs / 1000) || 0]),
  };
  const bytes = new TextEncoder().encode(JSON.stringify(data));
  return toB64(await pipe(bytes, new CompressionStream('deflate-raw')));
}

export async function decodeShare(code) {
  let data;
  try {
    const bytes = await pipe(fromB64(code), new DecompressionStream('deflate-raw'));
    data = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new Error('Dieser Link ist beschädigt. Lass ihn dir noch einmal schicken.');
  }
  if (data?.v !== 1 || !Array.isArray(data.t)) throw new Error('Dieser Link stammt aus einer neueren Version.');
  return {
    name: String(data.n || 'Geteilte Kiste'),
    tracks: data.t.map(([title, artists, isrc, sec]) => makeTrack({ title, artists, isrc, durationMs: (sec || 0) * 1000 })).filter(t => t.title),
  };
}
