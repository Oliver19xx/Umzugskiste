// Arbeitet die Umzüge nacheinander ab, solange die App offen ist.
import * as store from './store.js';
import { adapters } from './services/index.js';
import { runJob, isDue } from './transfer.js';

let current = null;
let stopFor = null;
let timer = null;
const listeners = new Set();

export const onJob = fn => { listeners.add(fn); return () => listeners.delete(fn); };
export const live = id => (current?.id === id ? current : null);
export const stop = id => { stopFor = id; };

const notify = job => listeners.forEach(fn => fn(job));
const persist = job => store.put('jobs', job);

export async function pump() {
  if (current) return;
  clearTimeout(timer);
  const online = navigator.onLine;
  const jobs = (await store.all('jobs')).filter(j => adapters[j.target.service]).sort((a, b) => a.createdAt - b.createdAt);
  const job = online ? jobs.find(j => isDue(j, Date.now(), online)) : null;
  if (!job) {
    const wake = jobs.filter(j => j.pauseReason === 'quota' && j.resumeAt).map(j => j.resumeAt).sort((a, b) => a - b)[0];
    if (wake) timer = setTimeout(pump, Math.min(Math.max(1000, wake - Date.now()), 2 ** 31 - 1));
    return;
  }
  const adapter = adapters[job.target.service];
  if (!adapter.isConnected()) {
    Object.assign(job, { status: 'paused', pauseReason: 'auth', message: `Melde dich bei ${adapter.name} an, der Umzug läuft dann weiter.` });
    await persist(job);
    notify(job);
    pump();
    return;
  }
  if (job.status === 'paused') job.status = job.items.some(i => i.state === 'pending') ? 'queued' : 'writing';
  current = job;
  const stopped = () => stopFor === job.id;
  await runJob(job, { adapter, cache: store.matchCache, persist, notify, stopped });
  if (stopped()) {
    stopFor = null;
    Object.assign(job, { status: 'paused', pauseReason: 'user', message: 'Du hast den Umzug angehalten.' });
    await persist(job);
  }
  current = null;
  notify(job);
  pump();
}

export function resumeAuthPaused(service) {
  return store.all('jobs').then(async jobs => {
    for (const j of jobs) {
      if (j.target.service === service && j.status === 'paused' && j.pauseReason === 'auth') {
        j.status = j.items.some(i => i.state === 'pending') ? 'queued' : 'writing';
        j.pauseReason = null; j.message = null;
        await persist(j);
      }
    }
  });
}
