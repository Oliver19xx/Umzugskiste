// Umzugs-Ablauf. Jeder Schritt wird gespeichert, darum übersteht ein Umzug
// Schließen, Funkloch und Tageslimit und läuft an der gleichen Stelle weiter.
import { uid, trackKey, dedupe } from './model.js';
import { rank, classify } from './match.js';
import { QuotaError, AuthError, OfflineError } from './errors.js';

export const ACTIVE = ['queued', 'matching', 'writing'];

export function newJob(box, target) {
  return {
    id: uid(), boxId: box.id, boxName: box.name, target, status: 'queued', createdAt: Date.now(),
    items: dedupe(box.tracks).map(track => ({ key: trackKey(track), track, state: 'pending', match: null, candidates: [] })),
  };
}

export function counts(job) {
  const c = { pending: 0, sure: 0, unsure: 0, missing: 0, skipped: 0, written: 0, total: job.items.length };
  for (const i of job.items) c[i.state]++;
  return c;
}

const isNetworkError = e => e instanceof OfflineError || e instanceof TypeError;

function pause(job, reason, message, resumeAt) {
  job.status = 'paused';
  job.pauseReason = reason;
  job.message = message;
  job.resumeAt = resumeAt || null;
}

async function matchPending(job, { adapter, cache, persist, notify, stopped }) {
  const service = job.target.service;
  let sinceSave = 0;
  for (const item of job.items) {
    if (item.state !== 'pending') continue;
    if (stopped()) return false;
    const direct = item.track.refs?.[service];
    const cached = direct ? null : await cache.get(`${service}|${item.key}`);
    if (direct) {
      item.match = { id: direct, title: item.track.title, artists: item.track.artists, score: 1 };
      item.state = 'sure';
    } else if (cached) {
      Object.assign(item, cached);
    } else {
      const found = rank(item.track, await adapter.search(item.track)).slice(0, 4);
      item.candidates = found;
      item.match = found[0] || null;
      item.state = classify(found[0]?.score ?? 0);
      if (found.length) await cache.set(`${service}|${item.key}`, { state: item.state, match: item.match, candidates: item.candidates });
    }
    notify(job);
    if (++sinceSave >= 5) { sinceSave = 0; await persist(job); }
  }
  await persist(job);
  return true;
}

async function writeMatched(job, { adapter, persist, notify, stopped }) {
  const target = job.target;
  if (!target.playlistId) {
    const made = await adapter.createPlaylist(target.name);
    target.playlistId = made.id;
    target.url = made.url;
    await persist(job);
  }
  // Schützt vor Dubletten, falls ein Lauf nach dem Senden abgebrochen wurde.
  const present = await adapter.existingIds(target.playlistId);
  const queued = new Set();
  const todo = [];
  for (const item of job.items) {
    if (item.state !== 'sure') continue;
    if (present.has(item.match.id) || queued.has(item.match.id)) { item.state = 'written'; continue; }
    queued.add(item.match.id);
    todo.push(item);
  }
  await persist(job);
  for (let i = 0; i < todo.length; i += adapter.batchSize) {
    if (stopped()) return false;
    const part = todo.slice(i, i + adapter.batchSize);
    await adapter.addTracks(target.playlistId, part.map(p => p.match));
    for (const p of part) p.state = 'written';
    notify(job);
    await persist(job);
  }
  return true;
}

export async function runJob(job, ctx) {
  const { persist, notify } = ctx;
  job.pauseReason = null; job.message = null; job.resumeAt = null;
  try {
    if (job.status !== 'writing') {
      job.status = 'matching';
      await persist(job); notify(job);
      if (!(await matchPending(job, ctx))) return;
      if (counts(job).unsure > 0) {
        job.status = 'review';
        await persist(job); notify(job);
        return;
      }
      job.status = 'writing';
    }
    await persist(job); notify(job);
    if (!(await writeMatched(job, ctx))) return;
    job.status = 'done';
    job.finishedAt = Date.now();
  } catch (e) {
    if (e instanceof QuotaError) pause(job, 'quota', e.message, e.resumeAt);
    else if (e instanceof AuthError) pause(job, 'auth', e.message);
    else if (isNetworkError(e)) pause(job, 'offline', 'Keine Verbindung. Der Umzug läuft weiter, sobald du wieder online bist.');
    else { job.status = 'failed'; job.message = e.message; }
  }
  await persist(job); notify(job);
}

export function pick(job, key, candidate) {
  const item = job.items.find(i => i.key === key);
  if (!item) return;
  item.match = candidate;
  item.state = 'sure';
}
export function skip(job, key) {
  const item = job.items.find(i => i.key === key);
  if (item) item.state = 'skipped';
}
export function acceptAllUnsure(job) {
  for (const i of job.items) if (i.state === 'unsure') i.state = 'sure';
}
export function confirmReview(job) {
  for (const i of job.items) if (i.state === 'unsure') i.state = 'skipped';
  job.status = 'writing';
}
export function retry(job) {
  job.status = job.items.some(i => i.state === 'pending') ? 'queued' : 'writing';
  job.pauseReason = null; job.message = null; job.resumeAt = null;
}

export function isDue(job, now, online) {
  if (ACTIVE.includes(job.status)) return true;
  if (job.status !== 'paused') return false;
  if (job.pauseReason === 'offline') return online;
  if (job.pauseReason === 'quota') return online && !!job.resumeAt && job.resumeAt <= now;
  return false;
}

export function delta(job, box) {
  const seen = new Set(job.items.map(i => i.key));
  return dedupe(box.tracks).filter(t => !seen.has(trackKey(t)));
}
