// PKCE-Bausteine für Spotify und SoundCloud.
export const b64url = buf => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
export const random = () => b64url(crypto.getRandomValues(new Uint8Array(48)));
export const challenge = async verifier => b64url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
export const redirectUri = () => location.origin + location.pathname;
