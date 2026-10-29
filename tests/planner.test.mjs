import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  normalizeDataset, buildPlan, DEFAULT_PREFS, classify, readConditions, splitIntoRuns, runMinutes,
  requiredDifficulty, describeRun, swapTarget, heistBreakdown, planToText, cleanPrefs, steamProfileUrl, compareDatasets,
} from '../planner.js';

const input = JSON.parse(await readFile(new URL('./fixtures/sample.json', import.meta.url), 'utf8'));
const data = normalizeDataset(input);
const items = data.achievements;
const state = { completed: {}, later: {}, notes: {} };
const byName = (name) => items.find((a) => a.name === name);

test('fixture reconciles with its reported totals and carries no identity', () => {
  assert.equal(items.length, 28);
  assert.equal(new Set(items.map((a) => a.id)).size, 28);
  assert.equal(data.counts.total, data.counts.unlocked + items.length);
  assert.ok(items.every((a) => a.description));
  assert.ok(!/steamcommunity|mikematt/i.test(JSON.stringify(input)));
});

test('rejects partial, duplicate, statusless and fully-unlocked exports', () => {
  assert.throws(() => normalizeDataset({ ...input, achievements: input.achievements.slice(0, 5) }), /Incomplete list/);
  assert.throws(() => normalizeDataset({ achievements: [input.achievements[0], input.achievements[0]] }), /duplicate/);
  assert.throws(() => normalizeDataset({ achievements: [{ name: 'Missing', description: 'Some requirement' }] }), /status/);
  assert.throws(() => normalizeDataset({ achievements: [{ description: 'No name here', status: 'locked' }] }), /needs a name/);
  assert.throws(() => normalizeDataset({ achievements: [{ name: 'Done', description: 'x', status: 'unlocked' }] }), /already unlocked/);
});

test('accepts a Steam Web API GetPlayerAchievements response', () => {
  const api = { playerstats: { steamID: '0', gameName: 'PAYDAY 2', achievements: [
    { apiname: 'a', achieved: 0, unlocktime: 0, name: 'Locked One', description: 'Complete the Big Bank job on the Hard difficulty or above.' },
    { apiname: 'b', achieved: 1, unlocktime: 1, name: 'Open One', description: 'Complete your first heist.' },
  ] } };
  const ds = normalizeDataset(api);
  assert.equal(ds.achievements.length, 1);
  assert.deepEqual(ds.counts, { total: 2, unlocked: 1, locked: 1 });
  assert.match(ds.source, /Steam Web API/);
  assert.throws(() => normalizeDataset({ playerstats: { achievements: [{ apiname: 'a', achieved: 0 }] } }), /l=english/);
  // Hidden achievements come back with an empty description; the import must still succeed.
  const hidden = normalizeDataset({ playerstats: { achievements: [
    { apiname: 'fin', achieved: 0, name: 'The End', description: '' },
    { apiname: 'b', achieved: 1, name: 'Open One', description: 'Complete your first heist.' },
  ] } });
  assert.equal(hidden.achievements.length, 1);
  assert.match(hidden.achievements[0].description, /did not provide a description/);
  assert.equal(hidden.achievements[0].heist, 'General challenges');
});

test('classifies heist, difficulty, kind and Infamy; cleans generic wording', () => {
  const a = classify({ name: 'Test', description: 'Complete the Lost In Transit job on the OVERKILL difficulty or above.', global_unlock_percentage: '0.1%' });
  assert.equal(a.heist, 'Lost In Transit');
  assert.equal(a.difficulty, 'OVERKILL');
  assert.equal(a.orAbove, true);
  assert.equal(a.hard, false);
  assert.equal(a.rarity, 0.1);
  assert.equal(classify({ name: 'Rank', description: 'Reach the fiftieth rank of Infamy.' }).kind, 'infamy');
  assert.equal(classify({ name: 'Santa', description: "Complete the Santa's Workshop job on Hard." }).heist, "Santa's Workshop");
  assert.equal(classify({ name: 'Anything', description: 'Complete any job on the Death Wish difficulty.' }).heist, 'General challenges');
  assert.equal(classify({ name: 'Biker', description: 'Complete the first day of the Biker heist in stealth.' }).heist, 'Biker');
  assert.equal(classify({ name: 'Crouch', description: 'Kill 10 enemies while crouching on the Murky Station job.' }).heist, 'Murky Station');
  assert.equal(classify({ name: 'Single', description: 'In a single day of a heist, place at least 40 trip mines.' }).heist, 'General challenges');
});

test('reads stealth, loud, day, time limit and loadout conditions from descriptions', () => {
  assert.equal(byName('Vault Whisperer').mode, 'stealth');
  assert.equal(byName('Loud and Clear').mode, 'loud');
  assert.equal(byName('Paper Trail').mode, 'any');
  assert.equal(byName('Last Call').mode, 'stealth');
  assert.equal(byName('Spark Plug').day, 1);
  assert.equal(byName('Burn Notice').day, 3);
  assert.equal(byName('Beat the Clock').timeLimit, 12);
  assert.equal(byName('Bomb Squad').timeLimit, 8);
  assert.deepEqual(byName('Burn Notice').restrictions, ['using only the thermite']);
  assert.deepEqual(byName('Harbour Master').restrictions, ['without using any ECM jammers']);
  assert.deepEqual(readConditions('Complete the GO Bank job without using your primary weapon on the OVERKILL difficulty or above.', { kind: 'heist', hard: false, difficulty: 'OVERKILL' }).restrictions, ['without using your primary weapon']);
  assert.equal(byName('Wall of Lead').count, 500);
  const c = readConditions('Complete the heist within 90 seconds of the alarm.', { kind: 'heist', hard: false, difficulty: 'Normal' });
  assert.equal(c.timeLimit, 2);
});

test('effort estimates scale with type and conditions', () => {
  assert.equal(byName('Dress Code').effort, 5);
  assert.equal(byName('Collector').effort, 15);
  assert.equal(byName('Sharpshooter').effort, 25);
  assert.equal(byName('Wall of Lead').effort, 45);
  assert.ok(byName('Vault Whisperer').effort > byName('Paper Trail').effort, 'stealth adds time');
  assert.ok(byName('Last Man Standing').effort > byName('Paper Trail').effort, 'Death Wish adds time');
  assert.equal(byName('Halfway There').effort, 0);
  assert.equal(runMinutes([]), 0);
  const shared = runMinutes([byName('Paper Trail'), byName('Beat the Clock')]);
  assert.ok(shared < byName('Paper Trail').effort + byName('Beat the Clock').effort, 'targets in one run share time');
});

test('splits a heist into runs that never mix stealth with loud or different days', () => {
  const bigBank = items.filter((a) => a.heist === 'Big Bank');
  const runs = splitIntoRuns(bigBank);
  for (const run of runs) {
    const modes = new Set(run.map((a) => a.mode).filter((m) => m !== 'any'));
    assert.ok(modes.size <= 1, `mixed modes in ${run.map((a) => a.name)}`);
  }
  assert.equal(runs.flat().length, bigBank.length);
  const firestarter = splitIntoRuns(items.filter((a) => a.heist === 'Firestarter'));
  assert.equal(firestarter.length, 3);
  assert.ok(firestarter.every((r) => new Set(r.map((a) => a.day)).size === 1));
});

test('required difficulty is the highest named, and exact difficulties are called out', () => {
  const req = requiredDifficulty([byName('Vault Whisperer'), byName('Beat the Clock'), byName('Last Man Standing')]);
  assert.equal(req.difficulty, 'Death Wish');
  assert.deepEqual(req.conflicts, []);
  const exact = requiredDifficulty([classify({ name: 'Exact', description: 'Complete the Big Bank job on the Normal difficulty.' }), byName('Beat the Clock')]);
  assert.equal(exact.difficulty, 'Hard');
  assert.deepEqual(exact.conflicts, ['Exact']);
  assert.equal(requiredDifficulty([byName('Paper Trail')]), null);
});

test('run briefings mention difficulty, mode, day, time limits, loadout and crew wording', () => {
  const lines = describeRun([byName('Vault Whisperer'), byName('Paper Trail')], DEFAULT_PREFS).join(' ');
  assert.match(lines, /Play on OVERKILL/);
  assert.match(lines, /Stealth run/);
  const day = describeRun([byName('Burn Notice')], DEFAULT_PREFS).join(' ');
  assert.match(day, /Day 3/);
  assert.match(day, /using only the thermite/);
  const timed = describeRun([byName('Beat the Clock')], DEFAULT_PREFS).join(' ');
  assert.match(timed, /12 min/);
  const crew = describeRun([byName('Crew Cut')], { ...DEFAULT_PREFS, playstyle: 'solo' }).join(' ');
  assert.match(crew, /solo mod/);
  const above = describeRun([byName('Last Man Standing')], { ...DEFAULT_PREFS, difficulty: 'Hard' }).join(' ');
  assert.match(above, /above your comfortable Hard/);
});

test('plans fit the session length, respect the batch cap, and never mix incompatible targets', () => {
  for (const minutes of [30, 60, 120]) {
    for (let rotation = 0; rotation < 12; rotation++) {
      const plan = buildPlan(items, state, { ...DEFAULT_PREFS, minutes, batchSize: 10 }, rotation);
      const ids = plan.runs.flatMap((r) => r.achievementIds);
      assert.ok(ids.length > 0 && ids.length <= 10);
      assert.equal(new Set(ids).size, ids.length);
      assert.ok(plan.minutes <= minutes + 15, `${plan.minutes} min planned for ${minutes}`);
      assert.ok(ids.map((id) => items.find((a) => a.id === id)).filter((a) => a.hard).length <= 1);
      for (const run of plan.runs) {
        const targets = run.achievementIds.map((id) => items.find((a) => a.id === id));
        const modes = new Set(targets.map((a) => a.mode).filter((m) => m !== 'any'));
        assert.ok(modes.size <= 1);
        assert.ok(Array.isArray(run.briefing));
        assert.ok(typeof run.why === 'string' && run.why.length);
      }
      assert.ok(plan.runs.some((r) => r.category === 'The long game'));
    }
  }
  const short = buildPlan(items, state, { ...DEFAULT_PREFS, minutes: 30 }, 0);
  const long = buildPlan(items, state, { ...DEFAULT_PREFS, minutes: 120 }, 0);
  assert.ok(long.runs.flatMap((r) => r.achievementIds).length >= short.runs.flatMap((r) => r.achievementIds).length);
});

test('planner excludes completed and set-aside targets, including timestamped completions', () => {
  const excluded = { completed: { [items[0].id]: '2026-01-01T00:00:00.000Z' }, later: { [items[1].id]: true } };
  for (let rotation = 0; rotation < 12; rotation++) {
    const ids = buildPlan(items, excluded, DEFAULT_PREFS, rotation).runs.flatMap((r) => r.achievementIds);
    assert.ok(!ids.includes(items[0].id) && !ids.includes(items[1].id));
  }
  const done = Object.fromEntries(items.map((a) => [a.id, true]));
  assert.equal(buildPlan(items, { completed: done, later: {} }, DEFAULT_PREFS).runs.length, 0);
});

test('swapTarget keeps hardness and compatibility, recomputes the run, and removes when nothing fits', () => {
  const plan = buildPlan(items, state, DEFAULT_PREFS, 0);
  for (const [i, run] of plan.runs.entries()) {
    for (const id of run.achievementIds) {
      const original = items.find((a) => a.id === id);
      const { plan: next, replacement } = swapTarget(plan, i, id, items, state, DEFAULT_PREFS);
      const ids = next.runs.flatMap((r) => r.achievementIds);
      assert.ok(!ids.includes(id));
      assert.equal(new Set(ids).size, ids.length);
      if (replacement) {
        assert.equal(replacement.hard, original.hard, `${original.name} swapped for ${replacement.name}`);
        assert.ok(ids.includes(replacement.id));
        const targets = next.runs[i].achievementIds.map((x) => items.find((a) => a.id === x));
        assert.equal(next.runs[i].minutes, runMinutes(targets));
      }
    }
  }
  const same = swapTarget(plan, 0, 'missing-id', items, state);
  assert.equal(same.plan, plan);
  const two = items.slice(0, 2);
  const tiny = { source: 'local', runs: [{ title: 'Only', category: 'Heist focus', why: '', briefing: [], achievementIds: [two[0].id], minutes: 0 }, { title: 'Rest', category: 'Cleanup', why: '', briefing: [], achievementIds: [two[1].id], minutes: 0 }], minutes: 0, budget: 60 };
  const { plan: next, replacement } = swapTarget(tiny, 0, two[0].id, two, state);
  assert.equal(replacement, null);
  assert.equal(next.runs.length, 1);
});

test('heistBreakdown counts remaining, done and set-aside per heist', () => {
  const s = { completed: { [items[0].id]: true }, later: { [items[1].id]: true } };
  const rows = heistBreakdown(items, s);
  assert.equal(rows.reduce((n, r) => n + r.total, 0), items.length);
  assert.equal(rows.reduce((n, r) => n + r.done, 0), 1);
  assert.equal(rows.reduce((n, r) => n + r.later, 0), 1);
  assert.ok(rows.every((r) => r.total === r.done + r.later + r.remaining));
});

test('planToText lists every target, its requirement, the briefing and the time budget', () => {
  const plan = buildPlan(items, state, DEFAULT_PREFS, 0);
  const text = planToText(plan, items, { completed: { [plan.runs[0].achievementIds[0]]: true }, later: {} }, DEFAULT_PREFS);
  for (const id of plan.runs.flatMap((r) => r.achievementIds)) {
    const a = items.find((x) => x.id === id);
    assert.ok(text.includes(a.name) && text.includes(a.description));
  }
  assert.ok(text.includes('[x]'));
  assert.ok(text.includes('60-minute session'));
  assert.ok(text.includes('Steam-confirmed'));
});

test('compareDatasets reports Steam unlocks against local checkmarks and counts what carries over', () => {
  // A later export: two targets unlocked on Steam (one was checked off here, one was not), one brand-new achievement.
  const unlockedNames = ['Vault Whisperer', 'Rat Race'];
  const later = normalizeDataset({
    achievements: [
      ...input.achievements.map((a) => (unlockedNames.includes(a.name) ? { ...a, status: 'unlocked' } : a)),
      { name: 'Fresh DLC', description: 'Complete the Brand New job on the Hard difficulty or above.', status: 'locked' },
    ],
  });
  const progress = {
    completed: { [byName('Vault Whisperer').id]: '2026-01-01T00:00:00.000Z', [byName('Beat the Clock').id]: true },
    later: { [byName('Legend').id]: true },
    notes: { [byName('Rat Race').id]: 'cook fast', [byName('Hoarder').id]: 'grind' },
  };
  const c = compareDatasets(data, later, progress);
  assert.deepEqual(c.unlocked.map((a) => a.name).sort(), [...unlockedNames].sort());
  assert.deepEqual(c.confirmed.map((a) => a.name), ['Vault Whisperer']);
  assert.deepEqual(c.unexpected.map((a) => a.name), ['Rat Race']);
  assert.deepEqual(c.stillLocked.map((a) => a.name), ['Beat the Clock']);
  assert.deepEqual(c.added.map((a) => a.name), ['Fresh DLC']);
  // The note on the now-unlocked Rat Race is gone; everything attached to still-locked targets stays.
  assert.deepEqual(c.kept, { completed: 1, later: 1, notes: 1 });
  assert.equal(later.counts.locked, items.length - 2 + 1);

  const same = compareDatasets(data, data, { completed: {}, later: {}, notes: {} });
  assert.equal(same.unlocked.length + same.added.length + same.stillLocked.length, 0);
});

test('defaults carry no personal identity and Steam IDs are cleaned into profile links', () => {
  assert.equal(DEFAULT_PREFS.player, '');
  assert.equal(DEFAULT_PREFS.steam, '');
  assert.equal(DEFAULT_PREFS.mods, '');
  assert.equal(cleanPrefs({ steam: 'https://steamcommunity.com/id/someone/achievements/218620/' }).steam, 'someone');
  assert.equal(cleanPrefs({ steam: ' 76561198000000000 ' }).steam, '76561198000000000');
  assert.equal(cleanPrefs({ steam: 'bad<script>' }).steam, 'badscript');
  assert.equal(steamProfileUrl(''), null);
  assert.equal(steamProfileUrl('someone'), 'https://steamcommunity.com/id/someone/');
  assert.equal(steamProfileUrl('76561198000000000'), 'https://steamcommunity.com/profiles/76561198000000000/');
});
