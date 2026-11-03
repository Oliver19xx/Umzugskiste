// Deezer nur zum Lesen öffentlicher Playlists und Alben. Die API erlaubt aus dem
// Browser nur JSONP, darum läuft das fremde Skript in einem abgeschotteten Rahmen.
import { makeTrack } from '../model.js';

const PAGE = 100;
const MAX_TRACKS = 10000;

function frameRequest(paths) {
  return new Promise((resolve, reject) => {
    const frame = document.createElement('iframe');
    frame.setAttribute('sandbox', 'allow-scripts');
    frame.hidden = true;
    frame.src = 'deezer-frame.html';
    let watchdog;
    const finish = (fn, value) => { clearTimeout(watchdog); removeEventListener('message', onMsg); frame.remove(); fn(value); };
    const arm = () => { clearTimeout(watchdog); watchdog = setTimeout(() => finish(reject, new Error('Deezer antwortet nicht. Prüfe den Link und versuche es noch einmal.')), 12000); };
    const onMsg = e => {
      if (e.source !== frame.contentWindow || !e.data?.dz) return;
      arm();
      try {
        const next = paths.next(e.data.dz === 'data' ? e.data.body : undefined);
        if (next) frame.contentWindow.postMessage({ dz: 'get', path: next }, '*');
        else finish(resolve, paths.result());
      } catch (err) { finish(reject, err); }
    };
    addEventListener('message', onMsg);
    arm();
    document.body.append(frame);
  });
}

export function parseDeezerUrl(url) {
  const m = String(url).match(/deezer\.com\/(?:[a-z]{2}\/)?(playlist|album)\/(\d+)/i);
  return m ? { kind: m[1].toLowerCase(), id: m[2] } : null;
}

const fromDeezer = (t, album) => makeTrack({
  title: t.title, artists: [t.artist?.name], album: t.album?.title || album,
  durationMs: (t.duration || 0) * 1000, isrc: t.isrc,
});

export async function readDeezer({ kind, id }, onProgress) {
  const tracks = [];
  let name = '', stage = 0, index = 0;
  const steps = {
    next(body) {
      if (body?.error) throw new Error('Deezer findet diese Playlist nicht. Sie ist vielleicht privat.');
      if (stage === 0) { stage = 1; return `${kind}/${id}`; }
      if (stage === 1) { name = body.title || 'Deezer'; stage = 2; return `${kind}/${id}/tracks?limit=${PAGE}&index=0`; }
      const page = body.data || [];
      tracks.push(...page.map(t => fromDeezer(t, name)));
      index += PAGE;
      onProgress?.(tracks.length, body.total);
      if (page.length < PAGE || tracks.length >= MAX_TRACKS) return null;
      return `${kind}/${id}/tracks?limit=${PAGE}&index=${index}`;
    },
    result: () => ({ name, tracks }),
  };
  return frameRequest(steps);
}
