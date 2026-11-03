// Dienste mit Login-Anbindung plus Klicklisten für Dienste ohne offene Browser-API.
import { spotify } from './spotify.js';
import { youtube } from './youtube.js';

export const adapters = { spotify, youtube };

const enc = encodeURIComponent;
export const clickServices = {
  apple: { name: 'Apple Music', url: q => `https://music.apple.com/de/search?term=${enc(q)}` },
  tidal: { name: 'TIDAL', url: q => `https://listen.tidal.com/search?q=${enc(q)}` },
  amazon: { name: 'Amazon Music', url: q => `https://music.amazon.de/search/${enc(q)}` },
  deezer: { name: 'Deezer', url: q => `https://www.deezer.com/search/${enc(q)}` },
  ytmusic: { name: 'YouTube Music', url: q => `https://music.youtube.com/search?q=${enc(q)}` },
  soundcloud: { name: 'SoundCloud', url: q => `https://soundcloud.com/search?q=${enc(q)}` },
  beatport: { name: 'Beatport', url: q => `https://www.beatport.com/search?q=${enc(q)}` },
  bandcamp: { name: 'Bandcamp', url: q => `https://bandcamp.com/search?q=${enc(q)}` },
};

export const serviceName = id => adapters[id]?.name || clickServices[id]?.name || id;
