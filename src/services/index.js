// Aktive Dienste. Weitere brauchen nur einen Adapter mit denselben Methoden.
import { spotify } from './spotify.js';
import { soundcloud } from './soundcloud.js';

export const adapters = { spotify, soundcloud };
export const planned = ['YouTube Music', 'Apple Music', 'TIDAL', 'Deezer', 'Amazon Music'];
export const serviceName = id => adapters[id]?.name || id;
