// Steam proxy for The Completion Job.
//
// Steam's Web API does not allow browser requests, so this Cloudflare Worker fetches a player's
// PAYDAY 2 achievements on the site's behalf. The API key lives here as a secret; the browser only
// sends a Steam ID. Responses use the same shape as a GetPlayerAchievements export, which the
// importer already accepts.
//
//   GET /?steamid=<SteamID64 or vanity name>
//
// The response carries the achievement list plus `profile` ({ level, infamy }) read from the
// player's PAYDAY 2 stats when Steam shares them.
//
// Environment:
//   STEAM_API_KEY    secret, from https://steamcommunity.com/dev/apikey
//   ALLOWED_ORIGINS  comma-separated origins allowed to call this worker (set in wrangler.toml)

const APP_ID = '218620';
const CACHE_SECONDS = 60;
const STEAM = 'https://api.steampowered.com';

const fail = (message, status) => Object.assign(Error(message), { status });

const json = (body, status, headers) => new Response(JSON.stringify(body), {
  status,
  headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers },
});

function corsHeaders(request, env) {
  const origin = request.headers.get('origin') || '';
  const allowed = String(env.ALLOWED_ORIGINS || '').split(',').map((o) => o.trim()).filter(Boolean);
  if (!origin || !allowed.includes(origin)) return null;
  return {
    'access-control-allow-origin': origin,
    'access-control-allow-methods': 'GET, OPTIONS',
    'access-control-allow-headers': 'accept',
    'access-control-max-age': '86400',
    vary: 'origin',
  };
}

async function steamGet(path, params, env, fetcher) {
  const url = new URL(`${STEAM}${path}`);
  for (const [k, v] of Object.entries({ ...params, key: env.STEAM_API_KEY })) url.searchParams.set(k, v);
  const res = await fetcher(url.toString(), { headers: { accept: 'application/json' } });
  const body = await res.json().catch(() => null);
  return { status: res.status, body };
}

async function resolveSteamId(input, env, fetcher) {
  if (/^\d{17}$/.test(input)) return input;
  const { body } = await steamGet('/ISteamUser/ResolveVanityURL/v1/', { vanityurl: input }, env, fetcher);
  const r = body?.response;
  if (r?.success !== 1 || !/^\d{17}$/.test(r.steamid || '')) throw fail(`No Steam profile is called "${input}". Use the 17-digit SteamID64 from your profile URL instead.`, 404);
  return r.steamid;
}

/**
 * PAYDAY 2 publishes `player_level` and one `player_rank_N` stat for every Infamy rank reached.
 * Returns null when the stats do not look like PAYDAY 2's.
 */
export function readProfile(stats) {
  if (!Array.isArray(stats)) return null;
  let level = null;
  let infamy = null;
  for (const s of stats) {
    if (!s || typeof s.name !== 'string' || !Number.isFinite(s.value)) continue;
    if (s.name === 'player_level') level = Math.max(0, Math.min(100, Math.trunc(s.value)));
    const rank = /^player_rank_(\d{1,3})$/.exec(s.name);
    if (rank && s.value > 0) infamy = Math.max(infamy ?? 0, Math.min(500, Number(rank[1])));
  }
  if (level === null && infamy === null) return null;
  return { level, infamy: infamy ?? 0 };
}

export async function lookup(rawId, env, fetcher = fetch) {
  const input = String(rawId || '').trim().replace(/^https?:\/\/steamcommunity\.com\/(?:id|profiles)\//i, '').replace(/\/.*$/, '');
  if (!/^[\w.-]{1,64}$/.test(input)) throw fail('Enter a SteamID64 or vanity name.', 400);
  if (!env.STEAM_API_KEY) throw fail('The proxy has no Steam API key configured.', 500);

  const steamid = await resolveSteamId(input, env, fetcher);
  const [{ status, body }, statsReply] = await Promise.all([
    steamGet('/ISteamUserStats/GetPlayerAchievements/v1/', { appid: APP_ID, steamid, l: 'english' }, env, fetcher),
    // Stats are a bonus: Infamy and level for the board. A failure here must not block the achievement list.
    steamGet('/ISteamUserStats/GetUserStatsForGame/v2/', { appid: APP_ID, steamid }, env, fetcher).catch(() => null),
  ]);
  const stats = body?.playerstats;

  if (status === 403 || /private/i.test(stats?.error || '')) {
    throw fail('Steam would not share this profile. Set Game details to Public in your Steam privacy settings, then try again.', 403);
  }
  if (status === 400 && stats?.success === false) throw fail('Steam has no PAYDAY 2 stats for this account.', 404);
  if (status === 401 || status === 429 || status >= 500) throw fail(`Steam is not answering right now (${status}). Try again in a minute.`, 502);
  if (!Array.isArray(stats?.achievements)) throw fail('Steam returned an unexpected response.', 502);

  const profile = statsReply?.status === 200 ? readProfile(statsReply.body?.playerstats?.stats) : null;
  return { source: 'Fetched from Steam', fetchedAt: new Date().toISOString(), steamid, profile, playerstats: stats };
}

export default {
  async fetch(request, env, ctx) {
    const cors = corsHeaders(request, env);
    if (request.method === 'OPTIONS') return new Response(null, { status: cors ? 204 : 403, headers: cors || {} });
    if (!cors) return json({ error: 'This origin is not allowed.' }, 403, {});
    if (request.method !== 'GET') return json({ error: 'Use GET.' }, 405, cors);

    const steamid = new URL(request.url).searchParams.get('steamid');
    try {
      // Cache per Steam ID for a short while so repeated opens do not hammer Steam. The key never enters the
      // cache key, and the browser is always told no-store so a refresh really asks the worker.
      const cache = globalThis.caches?.default;
      const cacheKey = new Request(`https://cache.the-completion-job/${encodeURIComponent(String(steamid || '').toLowerCase())}`);
      const hit = cache && await cache.match(cacheKey);
      if (hit) return json(await hit.json(), 200, cors);

      const result = await lookup(steamid, env);
      if (cache) ctx?.waitUntil?.(cache.put(cacheKey, json(result, 200, { 'cache-control': `public, max-age=${CACHE_SECONDS}` })));
      return json(result, 200, cors);
    } catch (error) {
      return json({ error: error.message || 'Lookup failed.' }, error.status || 500, cors);
    }
  },
};
