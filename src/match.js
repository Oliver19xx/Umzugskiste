// Song-Abgleich: reine Logik ohne Netz, darum direkt testbar.
export const SURE = 0.82;
export const UNSURE = 0.55;

export function norm(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/ß/g, 'ss')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/&/g, ' and ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

// Klammer-Teile und Suffixe, die eine andere Aufnahme bedeuten.
const VERSION_WORD = /\b(extended|radio|club|vip|dub|acoustic|akustik|live|instrumental|remix|edit|mix|bootleg|rework|flip|mashup|karaoke|sped up|slowed|nightcore|version)\b/;
// Gleiche Aufnahme, nur anders beschriftet.
const NEUTRAL = /\b(remaster(ed)?|mono|stereo|deluxe|explicit|clean|original mix|original version|album version|single version|bonus track)\b/;
const FEAT = /\b(feat|ft|featuring|with)\b\.?/;

export function splitTitle(title) {
  const versions = new Set();
  let rest = String(title || '');
  const take = part => {
    const n = norm(part);
    if (!n) return true;
    if (FEAT.test(n)) return true;
    if (NEUTRAL.test(n)) return true;
    if (VERSION_WORD.test(n)) { versions.add(n); return true; }
    return false;
  };
  rest = rest.replace(/[([{]([^)\]}]*)[)\]}]/g, (all, inner) => (take(inner) ? ' ' : all));
  rest = rest.replace(/\s[-–—]\s(.+)$/, (all, tail) => (take(tail) ? ' ' : all));
  rest = rest.replace(/\s(feat|ft|featuring)\.?\s.*$/i, ' ');
  return { core: norm(rest), versions };
}

function bigrams(s) {
  const t = s.replace(/ /g, '');
  const map = new Map();
  for (let i = 0; i < t.length - 1; i++) {
    const b = t.slice(i, i + 2);
    map.set(b, (map.get(b) || 0) + 1);
  }
  return map;
}

export function similarity(a, b) {
  if (!a && !b) return 1;
  if (!a || !b) return 0;
  if (a === b) return 1;
  if (a.length < 3 || b.length < 3) return 0;
  const x = bigrams(a), y = bigrams(b);
  let hit = 0, total = 0;
  for (const [k, n] of x) { hit += Math.min(n, y.get(k) || 0); total += n; }
  for (const n of y.values()) total += n;
  return (2 * hit) / total;
}

function artistScore(src, cand) {
  if (!src.length || !cand.length) return null;
  const names = cand.map(norm);
  const joined = names.join(' ');
  const scoreOne = a => {
    const n = norm(a);
    if (joined.includes(n) && n.length > 2) return 1;
    return Math.max(...names.map(c => similarity(n, c)));
  };
  return scoreOne(src[0]);
}

function durationScore(a, b) {
  if (!a || !b) return null;
  const diff = Math.abs(a - b) / 1000;
  if (diff <= 3) return 1;
  if (diff >= 30) return 0;
  return 1 - (diff - 3) / 27;
}

export function scoreMatch(src, cand) {
  if (src.isrc && cand.isrc && src.isrc === cand.isrc) return 1;
  const a = splitTitle(src.title), b = splitTitle(cand.title);
  const parts = [
    [similarity(a.core, b.core), 0.6],
    [artistScore(src.artists, cand.artists), 0.3],
    [durationScore(src.durationMs, cand.durationMs), 0.1],
  ].filter(([v]) => v !== null);
  const weight = parts.reduce((sum, [, w]) => sum + w, 0);
  let score = parts.reduce((sum, [v, w]) => sum + v * w, 0) / weight;
  const same = a.versions.size === b.versions.size && [...a.versions].every(v => b.versions.has(v));
  if (!same) score *= 0.78;
  return score;
}

export function rank(src, candidates) {
  return candidates
    .map(c => ({ ...c, score: Math.round(scoreMatch(src, c) * 100) / 100 }))
    .sort((x, y) => y.score - x.score);
}

export function classify(score) {
  if (score >= SURE) return 'sure';
  if (score >= UNSURE) return 'unsure';
  return 'missing';
}
