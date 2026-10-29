import test from 'node:test';
import assert from 'node:assert/strict';
import worker, { lookup, readProfile } from '../worker/index.js';
import { normalizeDataset } from '../planner.js';

const env = { STEAM_API_KEY: 'test-key', ALLOWED_ORIGINS: 'https://example.github.io, http://127.0.0.1:4173' };
const ID = '76561198000000000';
const achievements = [
  { apiname: 'a', achieved: 0, unlocktime: 0, name: 'Locked One', description: 'Complete the Big Bank job on the Hard difficulty or above.' },
  { apiname: 'b', achieved: 1, unlocktime: 1, name: 'Open One', description: 'Complete your first heist.' },
];

// A stand-in for Steam: records the URLs it was asked for and answers from a table.
function steam(routes) {
  const calls = [];
  const fetcher = async (url) => {
    calls.push(new URL(url));
    const route = routes.find((r) => url.includes(r.path));
    if (!route) return new Response('not found', { status: 404 });
    return new Response(JSON.stringify(route.body), { status: route.status || 200 });
  };
  return { fetcher, calls };
}

test('lookup fetches PAYDAY 2 achievements in English with the secret key and never echoes the key', async () => {
  const { fetcher, calls } = steam([
    { path: 'GetPlayerAchievements', body: { playerstats: { steamID: ID, gameName: 'PAYDAY 2', achievements, success: true } } },
    { path: 'GetUserStatsForGame', body: { playerstats: { stats: [{ name: 'player_level', value: 37 }, { name: 'player_rank_0', value: 1 }, { name: 'player_rank_1', value: 1 }, { name: 'player_rank_2', value: 1 }, { name: 'heist_x', value: 9 }] } } },
  ]);
  const result = await lookup(ID, env, fetcher);
  const ach = calls.find((u) => u.pathname.includes('GetPlayerAchievements'));
  assert.equal(calls.length, 2);
  assert.equal(ach.searchParams.get('appid'), '218620');
  assert.equal(ach.searchParams.get('l'), 'english');
  assert.equal(ach.searchParams.get('key'), 'test-key');
  assert.equal(result.steamid, ID);
  assert.equal(result.source, 'Fetched from Steam');
  assert.deepEqual(result.profile, { level: 37, infamy: 2 });
  assert.ok(!JSON.stringify(result).includes('test-key'));
  // The importer accepts the proxy's response as-is.
  const ds = normalizeDataset(result);
  assert.equal(ds.achievements.length, 1);
  assert.equal(ds.source, 'Fetched from Steam');
});

test('Infamy and level come from the stats feed; missing stats never block the list', async () => {
  assert.deepEqual(readProfile([{ name: 'player_level', value: 100 }, { name: 'player_rank_0', value: 1 }]), { level: 100, infamy: 0 });
  assert.deepEqual(readProfile([{ name: 'player_rank_7', value: 1 }, { name: 'player_rank_12', value: 1 }, { name: 'player_rank_30', value: 0 }]), { level: null, infamy: 12 });
  assert.deepEqual(readProfile([{ name: 'player_level', value: 150.7 }]), { level: 100, infamy: 0 });
  assert.equal(readProfile([{ name: 'heist_x', value: 1 }]), null);
  assert.equal(readProfile(undefined), null);

  const noStats = steam([{ path: 'GetPlayerAchievements', body: { playerstats: { achievements } } }, { path: 'GetUserStatsForGame', status: 500, body: null }]);
  const result = await lookup(ID, env, noStats.fetcher);
  assert.equal(result.profile, null);
  assert.equal(result.playerstats.achievements.length, 2);
});

test('vanity names are resolved first; profile URLs are accepted', async () => {
  const { fetcher, calls } = steam([
    { path: 'ResolveVanityURL', body: { response: { success: 1, steamid: ID } } },
    { path: 'GetPlayerAchievements', body: { playerstats: { achievements } } },
  ]);
  const result = await lookup('https://steamcommunity.com/id/someone/achievements/', env, fetcher);
  assert.equal(calls[0].searchParams.get('vanityurl'), 'someone');
  assert.equal(calls[1].searchParams.get('steamid'), ID);
  assert.equal(result.steamid, ID);

  const missing = steam([{ path: 'ResolveVanityURL', body: { response: { success: 42, message: 'No match' } } }]);
  await assert.rejects(lookup('nobody', env, missing.fetcher), (e) => e.status === 404 && /No Steam profile/.test(e.message));
});

test('Steam refusals become readable errors with sensible statuses', async () => {
  const cases = [
    [{ status: 403, body: { playerstats: { error: 'Profile is not public', success: false } } }, 403, /Public/],
    [{ status: 400, body: { playerstats: { error: 'Requested app has no stats', success: false } } }, 404, /no PAYDAY 2/],
    [{ status: 500, body: null }, 502, /not answering/],
    [{ status: 200, body: { playerstats: {} } }, 502, /unexpected/],
  ];
  for (const [reply, status, pattern] of cases) {
    const { fetcher } = steam([{ path: 'GetPlayerAchievements', ...reply }]);
    await assert.rejects(lookup(ID, env, fetcher), (e) => e.status === status && pattern.test(e.message), `${reply.status} → ${status}`);
  }
  await assert.rejects(lookup('bad id!', env, steam([]).fetcher), (e) => e.status === 400);
  await assert.rejects(lookup(ID, { ...env, STEAM_API_KEY: '' }, steam([]).fetcher), (e) => e.status === 500);
});

test('the worker only answers allowed origins and returns JSON with CORS headers', async () => {
  const request = (origin, method = 'GET') => new Request(`https://proxy.example/?steamid=${ID}`, { method, headers: origin ? { origin } : {} });
  const blocked = await worker.fetch(request('https://evil.example'), env, {});
  assert.equal(blocked.status, 403);
  assert.equal(blocked.headers.get('access-control-allow-origin'), null);

  const preflight = await worker.fetch(request('https://example.github.io', 'OPTIONS'), env, {});
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get('access-control-allow-origin'), 'https://example.github.io');

  // Without a key, lookup fails inside the handler and the error is still a CORS-readable JSON body.
  const failed = await worker.fetch(request('http://127.0.0.1:4173'), { ...env, STEAM_API_KEY: '' }, {});
  assert.equal(failed.status, 500);
  assert.equal(failed.headers.get('access-control-allow-origin'), 'http://127.0.0.1:4173');
  assert.match((await failed.json()).error, /no Steam API key/);

  // Successful answers must not be cached by the browser, or the refresh-on-open would see stale data.
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ playerstats: { achievements } }), { status: 200 });
  try {
    const ok = await worker.fetch(request('https://example.github.io'), env, {});
    assert.equal(ok.status, 200);
    assert.equal(ok.headers.get('cache-control'), 'no-store');
    assert.equal(ok.headers.get('access-control-allow-origin'), 'https://example.github.io');
    assert.equal((await ok.json()).steamid, ID);
  } finally {
    globalThis.fetch = realFetch;
  }
});
