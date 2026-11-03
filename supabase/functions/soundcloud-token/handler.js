// Tauscht Login-Codes und Refresh-Tokens gegen SoundCloud-Tokens und fügt das Secret hinzu.
// Speichert nichts und schreibt keine Tokens ins Log.
const TOKEN_URL = 'https://secure.soundcloud.com/oauth/token';
const list = s => String(s || '').split(',').map(x => x.trim()).filter(Boolean);

export async function handle(req, env, doFetch = fetch) {
  const origin = req.headers.get('Origin') || '';
  const origins = list(env.ALLOWED_ORIGINS);
  if (!origins.includes(origin)) return new Response('Forbidden', { status: 403 });
  const cors = {
    'Access-Control-Allow-Origin': origin, 'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, apikey, x-client-info', Vary: 'Origin',
  };
  const reply = (body, status) => new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } });
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  if (req.method !== 'POST') return reply({ error: 'method_not_allowed' }, 405);
  const body = await req.json().catch(() => null);
  const form = new URLSearchParams({ client_id: env.SOUNDCLOUD_CLIENT_ID, client_secret: env.SOUNDCLOUD_CLIENT_SECRET });
  if (body?.grant_type === 'authorization_code' && body.code && body.code_verifier && list(env.ALLOWED_REDIRECTS).includes(body.redirect_uri)) {
    form.set('grant_type', 'authorization_code');
    form.set('code', body.code);
    form.set('code_verifier', body.code_verifier);
    form.set('redirect_uri', body.redirect_uri);
  } else if (body?.grant_type === 'refresh_token' && body.refresh_token) {
    form.set('grant_type', 'refresh_token');
    form.set('refresh_token', body.refresh_token);
  } else {
    return reply({ error: 'invalid_request' }, 400);
  }
  const res = await doFetch(TOKEN_URL, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' }, body: form,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) return reply({ error: 'token_failed' }, res.status === 429 ? 429 : 400);
  return reply({ access_token: data.access_token, refresh_token: data.refresh_token, expires_in: data.expires_in }, 200);
}
