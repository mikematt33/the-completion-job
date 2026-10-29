import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  normalizeDataset, buildPlan, DEFAULT_PREFS, classify, readConditions, splitIntoRuns, runMinutes,
  requiredDifficulty, describeRun, swapTarget, heistBreakdown, planToText, cleanPrefs, steamProfileUrl, compareDatasets,
  rankClusters, plannable, describePick, STRATEGIES, MODE_PREFS,
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

const focusRun = (plan) => plan.runs.find((r) => r.category === 'Heist focus');
const names = (run) => run.achievementIds.map((id) => items.find((a) => a.id === id).name);

test('ranking scores every heist run and explains the order', () => {
  const byHeist = new Map();
  for (const a of items.filter((a) => !a.hard && a.heist !== 'General challenges' && a.kind !== 'infamy')) byHeist.set(a.heist, [...(byHeist.get(a.heist) || []), a]);
  const clusters = [...byHeist.entries()].flatMap(([heist, targets]) => splitIntoRuns(targets).map((group) => ({ heist, group })));
  const remainingByHeist = new Map(heistBreakdown(items, state).map((r) => [r.heist, r.remaining]));
  const ranked = rankClusters(clusters, { prefs: DEFAULT_PREFS, remainingByHeist });
  assert.equal(ranked.length, clusters.length);
  for (let i = 1; i < ranked.length; i++) assert.ok(ranked[i - 1].score >= ranked[i].score, 'sorted by score');
  // GO Bank: three targets in one stealth run that clears the heist.
  assert.equal(ranked[0].heist, 'GO Bank');
  assert.match(ranked[0].reasons.join('; '), /3 targets can share one run; clears GO Bank/);
  const bigBankLoud = ranked.find((c) => c.heist === 'Big Bank' && c.mode === 'loud');
  assert.ok(bigBankLoud.score < ranked[0].score);
  // A comfortable difficulty below the run's requirement is called out, and the gap counts against it.
  const hard = rankClusters(clusters, { prefs: { ...DEFAULT_PREFS, difficulty: 'Hard' }, remainingByHeist });
  const nightclub = hard.find((c) => c.heist === 'Nightclub');
  assert.match(nightclub.reasons.join('; '), /needs OVERKILL, 2 skulls above your Hard/);
  assert.ok(nightclub.score < ranked.find((c) => c.heist === 'Nightclub').score);
  // A stealth preference lifts stealth runs and says so; a loud one marks the clash.
  const stealth = rankClusters(clusters, { prefs: { ...DEFAULT_PREFS, modePref: 'stealth' }, remainingByHeist });
  assert.match(stealth[0].reasons.join('; '), /stealth run, as you prefer/);
  const loud = rankClusters(clusters, { prefs: { ...DEFAULT_PREFS, modePref: 'loud' }, remainingByHeist });
  assert.match(loud.find((c) => c.heist === 'GO Bank').reasons.join('; '), /though you prefer loud/);
  assert.ok(loud.find((c) => c.heist === 'Big Bank' && c.mode === 'loud').score > bigBankLoud.score);
});

test('every strategy is complete and "Easy wins" leaves the hard challenge out', () => {
  for (const [key, s] of Object.entries(STRATEGIES)) {
    assert.ok(s.label && s.summary && typeof s.challenge === 'boolean');
    for (const k of ['size', 'perTarget', 'finish', 'stretch', 'common', 'crew', 'mode']) assert.equal(typeof s.weights[k], 'number', `${key}.${k}`);
    const plan = buildPlan(items, state, { ...DEFAULT_PREFS, strategy: key, minutes: 480, batchSize: 30 }, 0);
    assert.ok(plan.runs.length > 0);
    const hasChallenge = plan.runs.some((r) => r.category === 'One challenge');
    assert.equal(hasChallenge, s.challenge, `${key} challenge`);
  }
  // Biggest clusters ignores difficulty: with Normal as the comfort level it still leads with the largest run.
  const clusters = buildPlan(items, state, { ...DEFAULT_PREFS, strategy: 'clusters', difficulty: 'Normal' }, 0);
  assert.equal(focusRun(clusters).achievementIds.length, 3);
  // Easy wins at Normal prefers runs with no difficulty gap over the Big Bank OVERKILL cluster.
  const easy = buildPlan(items, state, { ...DEFAULT_PREFS, strategy: 'easy', difficulty: 'Normal' }, 0);
  assert.notEqual(focusRun(easy).title, 'Big Bank');
  assert.match(focusRun(easy).why, /^[A-Z0-9].*\.$/, 'reads as a sentence');
});

test('"Show another option" cycles through the shortlist and reports where it is', () => {
  const first = buildPlan(items, state, DEFAULT_PREFS, 0);
  assert.deepEqual(first.pick, { index: 1, of: 4, pinned: false });
  const seen = new Set();
  for (let rotation = 0; rotation < first.pick.of; rotation++) {
    const plan = buildPlan(items, state, DEFAULT_PREFS, rotation);
    assert.equal(plan.pick.index, rotation + 1);
    seen.add(focusRun(plan).title + names(focusRun(plan)).join());
  }
  assert.equal(seen.size, first.pick.of, 'each option leads with a different run');
  assert.equal(buildPlan(items, state, DEFAULT_PREFS, first.pick.of).pick.index, 1, 'wraps around');
  assert.match(describePick(first, DEFAULT_PREFS), /Strategy: Balanced · option 1 of 4/);
  assert.match(planToText(first, items, state, DEFAULT_PREFS), /option 1 of 4/);
});

test('a pinned heist leads the plan; skipped heists and ruled-out modes leave it entirely', () => {
  const pinned = buildPlan(items, state, { ...DEFAULT_PREFS, focusHeist: 'Rats' }, 0);
  assert.equal(focusRun(pinned).title, 'Rats');
  assert.match(focusRun(pinned).why, /^Your pinned heist/);
  assert.equal(pinned.pick.pinned, true);
  assert.match(describePick(pinned, { ...DEFAULT_PREFS, focusHeist: 'Rats' }), /pinned to Rats/);
  // Pinning stays pinned across "another option" presses.
  assert.equal(focusRun(buildPlan(items, state, { ...DEFAULT_PREFS, focusHeist: 'Rats' }, 5)).title, 'Rats');
  // A pin on a heist with nothing left falls back to the ranking.
  const gone = buildPlan(items, state, { ...DEFAULT_PREFS, focusHeist: 'Nowhere' }, 0);
  assert.equal(gone.pick.pinned, false);

  const skipPrefs = { ...DEFAULT_PREFS, skipHeists: ['GO Bank', 'Big Bank'], minutes: 480, batchSize: 30 };
  const skipped = buildPlan(items, state, skipPrefs, 0);
  const heists = new Set(skipped.runs.flatMap((r) => r.achievementIds).map((id) => items.find((a) => a.id === id).heist));
  assert.ok(!heists.has('GO Bank') && !heists.has('Big Bank'));
  assert.equal(skipped.hidden, items.filter((a) => ['GO Bank', 'Big Bank'].includes(a.heist)).length);
  assert.match(describePick(skipped, skipPrefs), /skipping 2 heists/);
  assert.equal(plannable(items, state, skipPrefs).length, items.filter((a) => a.kind !== 'infamy').length - skipped.hidden);

  for (const [pref, banned] of [['stealth-only', 'loud'], ['loud-only', 'stealth']]) {
    const plan = buildPlan(items, state, { ...DEFAULT_PREFS, modePref: pref, minutes: 480, batchSize: 30 }, 0);
    const modes = plan.runs.flatMap((r) => r.achievementIds).map((id) => items.find((a) => a.id === id).mode);
    assert.ok(!modes.includes(banned), `${pref} planned a ${banned} target`);
    assert.equal(plan.hidden, items.filter((a) => a.kind !== 'infamy' && a.mode === banned).length);
  }
  assert.ok(Object.keys(MODE_PREFS).includes('any'));

  // Swaps never bring a skipped heist or a ruled-out mode back in.
  for (const [i, run] of skipped.runs.entries()) {
    for (const id of run.achievementIds) {
      const { replacement } = swapTarget(skipped, i, id, items, state, skipPrefs);
      if (replacement) assert.ok(!skipPrefs.skipHeists.includes(replacement.heist));
    }
  }
  const stealthOnly = { ...DEFAULT_PREFS, modePref: 'stealth-only' };
  const stealthPlan = buildPlan(items, state, stealthOnly, 0);
  for (const [i, run] of stealthPlan.runs.entries()) {
    for (const id of run.achievementIds) {
      const { replacement } = swapTarget(stealthPlan, i, id, items, state, stealthOnly);
      if (replacement) assert.notEqual(replacement.mode, 'loud');
    }
  }
});

test('cleanPrefs bounds the new planning fields and keeps free-form session sizes', () => {
  const p = cleanPrefs({ minutes: 45, batchSize: 7, strategy: 'easy', modePref: 'loud-only', focusHeist: ' Rats ', skipHeists: ['Big Bank', 'Big Bank', '', 42, ' GO Bank '] });
  assert.equal(p.minutes, 45);
  assert.equal(p.batchSize, 7);
  assert.equal(p.strategy, 'easy');
  assert.equal(p.modePref, 'loud-only');
  assert.equal(p.focusHeist, 'Rats');
  assert.deepEqual(p.skipHeists, ['Big Bank', 'GO Bank']);
  const bad = cleanPrefs({ minutes: 5, batchSize: 99, strategy: 'yolo', modePref: 'quiet', skipHeists: 'Big Bank' });
  assert.equal(bad.minutes, DEFAULT_PREFS.minutes);
  assert.equal(bad.batchSize, DEFAULT_PREFS.batchSize);
  assert.equal(bad.strategy, 'balanced');
  assert.equal(bad.modePref, 'any');
  assert.deepEqual(bad.skipHeists, []);
  assert.equal(cleanPrefs({ minutes: '90' }).minutes, 90);
  assert.equal(cleanPrefs({ strategy: 'constructor' }).strategy, 'balanced');
  assert.deepEqual(cleanPrefs({}).skipHeists, []);
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
