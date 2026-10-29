// Neutral defaults: the visitor fills in their own identity on first visit or in preferences.
export const DEFAULT_PREFS = {
  player: '',
  steam: '',
  infamy: null,
  playstyle: 'solo',
  difficulty: 'OVERKILL',
  minutes: 60,
  batchSize: 10,
  strategy: 'balanced',
  modePref: 'any',
  focusHeist: '',
  skipHeists: [],
  dlc: '',
  mods: '',
  variety: true,
  infamyBreaks: true,
};

export const MINUTES_RANGE = { min: 15, max: 480 };
export const BATCH_RANGE = { min: 1, max: 30 };

/**
 * How the planner ranks heist runs. Each weight multiplies one factor of a run:
 *   size       targets that share the run
 *   perTarget  minutes per target (negative: cheaper is better)
 *   finish     1 when the run clears the heist, falling off with every target it would leave behind
 *   stretch    skulls above the comfortable difficulty (negative)
 *   common     average global unlock % / 10, when the list carries it (commonly unlocked = easier)
 *   crew       targets with crew wording while playing solo (negative)
 *   mode       +1 when the run matches the stealth/loud preference, -1 when it clashes
 */
export const STRATEGIES = {
  balanced: {
    label: 'Balanced',
    summary: 'Weighs shared runs, heists you are close to clearing, your comfortable difficulty and how commonly each target is unlocked.',
    challenge: true,
    weights: { size: 8, perTarget: -0.5, finish: 16, stretch: -7, common: 1.5, crew: -6, mode: 10 },
  },
  easy: {
    label: 'Easy wins',
    summary: 'Short runs at or below your comfortable difficulty, favouring the most commonly unlocked targets. Leaves the hard challenge out.',
    challenge: false,
    weights: { size: 3, perTarget: -1.2, finish: 8, stretch: -14, common: 3, crew: -10, mode: 10 },
  },
  clusters: {
    label: 'Biggest clusters',
    summary: 'Heists with the most targets that can share one run come first, whatever the difficulty.',
    challenge: true,
    weights: { size: 18, perTarget: -0.1, finish: 4, stretch: -1, common: 0, crew: -3, mode: 10 },
  },
};

export const MODE_PREFS = {
  any: 'Stealth or loud, whatever fits',
  stealth: 'Prefer stealth',
  loud: 'Prefer loud',
  'stealth-only': 'Stealth only',
  'loud-only': 'Loud only',
};

export const DIFFICULTIES = ['Normal', 'Hard', 'Very Hard', 'OVERKILL', 'Mayhem', 'Death Wish', 'Death Sentence'];
// PAYDAY 2 shows risk as skulls: none on Normal, up to six on Death Sentence.
export const SKULLS = { Normal: 0, Hard: 1, 'Very Hard': 2, OVERKILL: 3, Mayhem: 4, 'Death Wish': 5, 'Death Sentence': 6 };
export const GENERAL = 'General challenges';
export const NO_DIFFICULTY = 'No difficulty specified';

/** Steam community URL for a vanity ID or 17-digit SteamID64; null when nothing usable is set. */
export function steamProfileUrl(steam) {
  const id = String(steam || '').trim();
  if (!id) return null;
  return /^\d{17}$/.test(id) ? `https://steamcommunity.com/profiles/${id}/` : `https://steamcommunity.com/id/${encodeURIComponent(id)}/`;
}

export const KIND_LABELS = {
  heist: 'Heist objective',
  challenge: 'Hard challenge',
  setup: 'Setup',
  weapon: 'Weapon',
  collectible: 'Collectible',
  infamy: 'Infamy',
};

export const MODE_LABELS = { stealth: 'Stealth', loud: 'Loud', any: '' };

export function achievementId(name) {
  let h = 2166136261;
  for (const c of name) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  const slug = name.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 65);
  return `${slug}-${(h >>> 0).toString(36)}`;
}

function titleCase(text) {
  return text.replace(/(^|[\s\-(/])([a-z])/g, (m, before, letter) => before + letter.toUpperCase());
}

// Turns the loosely captured "X" in "...the X job/heist" into a heist name, or null for generic wording
// such as "any job", "a single day of a heist" or "the first day of the Biker heist".
function cleanHeist(raw) {
  let h = raw.replace(/^the /i, '').trim();
  const after = h.match(/^(?:.*\bday of|while .*? (?:on|in)) the (.+)$/i);
  if (after) h = after[1];
  h = h.replace(/^(?:any|an|a)\s+/i, '');
  h = h.replace(/^(?:(?:first|second|third|single|a single|any single)\s+)?day\s+(?:of|in)\s+(?:any\s+|a\s+|the\s+)?/i, '');
  if (!h || /^(?:a|an|any|single|day \d)$/i.test(h) || /^(?:in|on|complete|during|while)\b/i.test(h)) return null;
  return h;
}

/**
 * Pulls the conditions the planner can reason about out of a description:
 * stealth or loud, which day of a multi-day heist, a time limit, equipment restrictions,
 * and a rough effort estimate in minutes.
 */
export function readConditions(description, { kind, hard, difficulty }) {
  const d = description;
  const stealth = /\bstealth\b|without (?:the )?alarm|without (?:being |getting )?detected|undetected|without (?:raising|triggering|sounding) the alarm|without (?:any )?guards? (?:being )?alerted|without killing any(?:one|body| guards?| civilians?)|answer(?:ing)? (?:every|all) pagers?/i.test(d);
  const loud = !stealth && /\bkill(?:ing)? (?:at least )?\d+|\bassault\b|while the alarm|after the alarm|during (?:an|the) assault|police assault/i.test(d);
  const mode = stealth ? 'stealth' : loud ? 'loud' : 'any';

  const dayMatch = d.match(/\bday (\d)\b/i);
  const day = dayMatch ? Number(dayMatch[1]) : null;

  let timeLimit = null;
  const tm = d.match(/(?:within|in under|in less than) (\d+) (minutes?|seconds?)/i) || d.match(/(\d+) (seconds?|minutes?) of (?:the|starting)/i);
  if (tm) {
    const n = Number(tm[1]);
    timeLimit = /second/i.test(tm[2]) ? Math.max(1, Math.round(n / 60)) : n;
  }

  const restrictions = [];
  const restrictionRe = /\b(without (?:using|equipping|wearing|firing|deploying)[^.,;]*|using only[^.,;]*|only (?:using|with) [^.,;]*|while (?:wearing|using|equipped with) [^.,;]*|with no [^.,;]*(?:skills?|weapons?|armou?r|perk)[^.,;]*)/gi;
  const difficultyTail = /\s+on (?:the )?(?:normal|hard|very hard|overkill|mayhem|death wish|death sentence)\b.*$/i;
  let m;
  while ((m = restrictionRe.exec(d)) !== null) restrictions.push(m[1].replace(difficultyTail, '').trim().replace(/\s+/g, ' ').slice(0, 70));

  const countMatch = d.match(/\b(\d{2,4})\b(?=\s+(?:enemies|kills|bags|civilians|cops|guards|shields|dozers|cloakers|tasers|snipers|hostages|headshots|rounds))/i);
  const count = countMatch ? Number(countMatch[1]) : null;

  let effort;
  if (kind === 'setup') effort = 5;
  else if (kind === 'collectible') effort = 15;
  else if (kind === 'weapon') effort = count >= 500 ? 45 : count >= 100 ? 25 : 15;
  else if (kind === 'infamy') effort = 0;
  else {
    effort = hard ? 40 : 25;
    if (SKULLS[difficulty] >= 5) effort += 10;
    if (timeLimit !== null) effort += 5;
    if (restrictions.length) effort += 5;
    if (mode === 'stealth') effort += 5;
    if (count >= 100) effort += 10;
  }

  return { mode, day, timeLimit, restrictions, count, effort };
}

export function classify(a) {
  const d = a.description;
  let heist = GENERAL;
  const match = d.match(/(?:in|complete|on) (?:day \d (?:of|in) )?(?:the )?(.+?) (?:job|heist)\b/i);
  const captured = match ? cleanHeist(match[1]) : null;
  if (captured) heist = captured;
  else if (/in the (cafe|park|street|garage|overpass) escape/i.test(d)) heist = `${d.match(/in the (.+?) escape/i)[1]} escape`;
  else if (/infamy/i.test(d)) heist = 'Infamy';
  else if (/holdout/i.test(d)) heist = 'Holdout';
  else if (/crime spree/i.test(d)) heist = 'Crime Spree';
  else if (/lost tapes/i.test(d)) heist = 'Lost Tapes';
  if (heist !== GENERAL) heist = titleCase(heist);

  const difficulty = DIFFICULTIES.slice().reverse().find((v) => d.toLowerCase().includes(v.toLowerCase())) || NO_DIFFICULTY;
  const orAbove = /or above|or higher|or harder/i.test(d);
  const hard = /death sentence|death wish|one down|without (?:using|equipping).*skills|no (?:equipped )?skills|within \d+ minutes/i.test(d);
  const crew = /each (?:crew|team)|all (?:crew|team)|four players|4 players|crew of|full crew|four crew|you and your crew|everyone|all four/i.test(d);
  const kind = heist === 'Infamy' ? 'infamy'
    : hard ? 'challenge'
    : /^(equip|wear|purchase|buy|own)\b/i.test(d) ? 'setup'
    : /kill \d+|headshot|melee|rifle|pistol|shotgun|sniper|revolver/i.test(d) && heist === GENERAL ? 'weapon'
    : /find|collect|hidden|tape|horseshoe/i.test(d) ? 'collectible'
    : 'heist';
  const rarity = typeof a.global_unlock_percentage === 'string' ? parseFloat(a.global_unlock_percentage) : NaN;
  const conditions = readConditions(d, { kind, hard, difficulty });

  return {
    ...a,
    id: a.id || achievementId(a.name),
    heist,
    difficulty,
    orAbove,
    hard,
    crew,
    kind,
    rarity: Number.isFinite(rarity) ? rarity : null,
    ...conditions,
  };
}

function boundedInt(v, min, max, fallback) {
  const n = Number(v);
  return Number.isInteger(n) && n >= min && n <= max ? n : fallback;
}

export function cleanPrefs(p = {}) {
  return {
    player: String(p.player ?? DEFAULT_PREFS.player).trim().slice(0, 60),
    steam: String(p.steam ?? '').trim().replace(/^https?:\/\/steamcommunity\.com\/(?:id|profiles)\//i, '').replace(/\/.*$/, '').replace(/[^\w.-]/g, '').slice(0, 64),
    infamy: p.infamy === null || p.infamy === '' || p.infamy === undefined ? null : boundedInt(p.infamy, 0, 500, null),
    playstyle: p.playstyle === 'crew' ? 'crew' : 'solo',
    difficulty: DIFFICULTIES.includes(p.difficulty) ? p.difficulty : 'OVERKILL',
    minutes: boundedInt(p.minutes, MINUTES_RANGE.min, MINUTES_RANGE.max, DEFAULT_PREFS.minutes),
    batchSize: boundedInt(p.batchSize, BATCH_RANGE.min, BATCH_RANGE.max, DEFAULT_PREFS.batchSize),
    strategy: Object.hasOwn(STRATEGIES, p.strategy) ? p.strategy : DEFAULT_PREFS.strategy,
    modePref: Object.hasOwn(MODE_PREFS, p.modePref) ? p.modePref : DEFAULT_PREFS.modePref,
    focusHeist: String(p.focusHeist ?? '').trim().slice(0, 80),
    skipHeists: [...new Set((Array.isArray(p.skipHeists) ? p.skipHeists : []).filter((h) => typeof h === 'string').map((h) => h.trim().slice(0, 80)).filter(Boolean))].slice(0, 60),
    dlc: String(p.dlc ?? DEFAULT_PREFS.dlc).slice(0, 300),
    mods: String(p.mods ?? DEFAULT_PREFS.mods).slice(0, 1500),
    variety: p.variety !== false,
    infamyBreaks: p.infamyBreaks !== false,
  };
}

export function normalizeDataset(input) {
  const source = input.achievements || input.playerstats?.achievements;
  if (!Array.isArray(source) || !source.length || source.length > 5000) throw Error('Include an achievements array with 1–5,000 entries.');

  const all = source.map((a) => {
    const name = a.displayName || a.name;
    if (typeof name !== 'string' || !name.trim() || name.length > 300) {
      throw Error('Every achievement needs a name. A Steam Web API export only includes names and descriptions when the request has a language, so add l=english to the address and save it again.');
    }
    // Steam leaves the description empty on hidden achievements. Keep the record; the planner files it under General challenges.
    const description = typeof a.description === 'string' && a.description.trim() ? a.description.trim().slice(0, 6000) : 'Steam did not provide a description for this achievement.';
    const status = a.status ?? (a.achieved === 0 ? 'locked' : a.achieved === 1 ? 'unlocked' : null);
    if (!['locked', 'unlocked'].includes(status)) throw Error('Every achievement must have status locked/unlocked or achieved 0/1.');
    return {
      name: name.trim(),
      description,
      status,
      global_unlock_percentage: typeof a.global_unlock_percentage === 'string' ? a.global_unlock_percentage.slice(0, 12) : null,
    };
  });

  if (new Set(all.map((a) => a.name)).size !== all.length) throw Error('The imported list contains duplicate names.');

  const locked = all.filter((a) => a.status === 'locked');
  if (!locked.length) throw Error('Every achievement in this list is already unlocked. There is nothing left to plan.');
  const reported = input.counts || input.snapshot_counts;
  if (reported?.locked !== undefined && Number(reported.locked) !== locked.length) {
    throw Error(`Incomplete list: the file reports ${reported.locked} locked achievements but contains ${locked.length}.`);
  }
  const total = boundedInt(reported?.total, all.length, 100000, all.length);
  const unlocked = boundedInt(reported?.unlocked, 0, total, all.filter((a) => a.status === 'unlocked').length);
  if (total !== unlocked + locked.length) throw Error('The reported total must equal unlocked plus locked achievements.');

  return {
    source: typeof input.source === 'string' ? input.source.slice(0, 300) : (input.playerstats ? 'Imported from a Steam Web API export' : 'Imported checklist'),
    importedAt: typeof input.importedAt === 'string' ? input.importedAt : new Date().toISOString(),
    counts: { total, unlocked, locked: locked.length },
    achievements: locked.map(classify),
  };
}

/**
 * Compares a fresh import against the list already loaded, using the progress recorded here.
 * Targets that have left the locked list were unlocked on Steam; the rest keep their checkmarks and notes.
 */
export function compareDatasets(previous, next, state) {
  const nextIds = new Set(next.achievements.map((a) => a.id));
  const prevIds = new Set(previous.achievements.map((a) => a.id));
  const unlocked = previous.achievements.filter((a) => !nextIds.has(a.id));
  const keys = (obj) => Object.keys(obj || {}).filter((id) => nextIds.has(id));
  return {
    unlocked,
    confirmed: unlocked.filter((a) => state.completed?.[a.id]),
    unexpected: unlocked.filter((a) => !state.completed?.[a.id]),
    stillLocked: next.achievements.filter((a) => state.completed?.[a.id]),
    added: next.achievements.filter((a) => !prevIds.has(a.id)),
    kept: { completed: keys(state.completed).length, later: keys(state.later).length, notes: keys(state.notes).length },
  };
}

export const isDone = (state, id) => Boolean(state.completed[id]);
export const isActive = (state, a) => !state.completed[a.id] && !state.later[a.id];

const rotate = (list, rotation) => (list.length ? list.slice(rotation % list.length).concat(list.slice(0, rotation % list.length)) : list);

/**
 * Splits one heist's targets into groups that can plausibly share a run:
 * same day, and not mixing stealth with loud. "Any" targets join the larger side.
 */
export function splitIntoRuns(targets) {
  const byDay = new Map();
  for (const a of targets) {
    const key = a.day === null ? 'all' : String(a.day);
    if (!byDay.has(key)) byDay.set(key, []);
    byDay.get(key).push(a);
  }
  const runs = [];
  for (const group of byDay.values()) {
    const stealth = group.filter((a) => a.mode === 'stealth');
    const loud = group.filter((a) => a.mode === 'loud');
    const any = group.filter((a) => a.mode === 'any');
    if (stealth.length && loud.length) {
      (stealth.length >= loud.length ? stealth : loud).push(...any);
      runs.push(stealth, loud);
    } else {
      runs.push([...stealth, ...loud, ...any]);
    }
  }
  return runs.filter((r) => r.length).sort((a, b) => b.length - a.length);
}

/** Minutes for a set of targets played together: the first pays full price, the rest ride along. */
export function runMinutes(targets) {
  if (!targets.length) return 0;
  const sorted = [...targets].sort((a, b) => b.effort - a.effort);
  return sorted[0].effort + sorted.slice(1).reduce((n, a) => n + Math.min(a.effort, 10), 0);
}

/** The lowest difficulty that satisfies every "X or above" target in a group, or the exact one named. */
export function requiredDifficulty(targets) {
  const named = targets.filter((a) => a.difficulty !== NO_DIFFICULTY);
  if (!named.length) return null;
  const highest = named.reduce((best, a) => (SKULLS[a.difficulty] > SKULLS[best.difficulty] ? a : best));
  const exact = named.filter((a) => !a.orAbove && a.difficulty !== highest.difficulty);
  return { difficulty: highest.difficulty, conflicts: exact.map((a) => a.name) };
}

/** Plain-language briefing for a run, built only from what the descriptions say. */
export function describeRun(targets, prefs) {
  const lines = [];
  const req = requiredDifficulty(targets);
  if (req) {
    lines.push(targets.length > 1 ? `Play on ${req.difficulty} to cover every target here.` : `Needs ${req.difficulty}${targets[0].orAbove ? ' or above' : ''}.`);
    if (req.conflicts.length) lines.push(`${req.conflicts.join(' and ')} name${req.conflicts.length === 1 ? 's' : ''} an exact difficulty, so that one may need its own run.`);
    if (SKULLS[req.difficulty] > SKULLS[prefs.difficulty]) lines.push(`That is above your comfortable ${prefs.difficulty}.`);
  }
  const modes = new Set(targets.map((a) => a.mode).filter((m) => m !== 'any'));
  if (modes.has('stealth')) lines.push('Stealth run.');
  else if (modes.has('loud')) lines.push('Go loud.');
  const days = [...new Set(targets.map((a) => a.day).filter((d) => d !== null))].sort();
  if (days.length) lines.push(days.length === 1 ? `Day ${days[0]} only.` : `Covers days ${days.join(', ')}; play them in order.`);
  const limits = targets.filter((a) => a.timeLimit !== null);
  if (limits.length) lines.push(`Time limit: ${limits.map((a) => `${a.timeLimit} min for ${a.name}`).join('; ')}.`);
  const restrictions = targets.flatMap((a) => a.restrictions.map((r) => ({ name: a.name, r })));
  if (restrictions.length === 1) lines.push(`Loadout: ${restrictions[0].r}.`);
  else if (restrictions.length > 1) lines.push(`Loadout conditions: ${restrictions.map((x) => `${x.r} (${x.name})`).join('; ')}. Check they can be combined.`);
  const crew = targets.filter((a) => a.crew);
  if (crew.length && prefs.playstyle === 'solo') lines.push(`${crew.map((a) => a.name).join(' and ')} mention${crew.length === 1 ? 's' : ''} a crew; check your solo mod.`);
  return lines;
}

/** Targets the planner may use: active, not Infamy, not on a skipped heist, and not ruled out by a stealth-only / loud-only preference. */
export function plannable(items, state, prefs) {
  const skipped = new Set(prefs.skipHeists || []);
  const excludedMode = prefs.modePref === 'stealth-only' ? 'loud' : prefs.modePref === 'loud-only' ? 'stealth' : null;
  return items.filter((a) => isActive(state, a) && a.kind !== 'infamy' && !skipped.has(a.heist) && a.mode !== excludedMode);
}

const runMode = (group) => (group.some((a) => a.mode === 'stealth') ? 'stealth' : group.some((a) => a.mode === 'loud') ? 'loud' : 'any');
const preferredMode = (modePref) => (modePref.startsWith('stealth') ? 'stealth' : modePref.startsWith('loud') ? 'loud' : null);

/**
 * Scores every heist run under the chosen strategy and says why each one ranks where it does.
 * `remainingByHeist` counts every active target on the heist, hard ones included, so "clears" means exactly that.
 */
export function rankClusters(clusters, { prefs, remainingByHeist }) {
  const strategy = STRATEGIES[prefs.strategy] || STRATEGIES.balanced;
  const w = strategy.weights;
  const comfortable = SKULLS[prefs.difficulty];
  const wanted = preferredMode(prefs.modePref || 'any');

  const ranked = clusters.map(({ heist, group }) => {
    const n = group.length;
    const perTarget = runMinutes(group) / n;
    const leftAfter = Math.max(0, (remainingByHeist.get(heist) ?? n) - n);
    const finish = 1 / (1 + leftAfter);
    const req = requiredDifficulty(group);
    const stretch = req ? Math.max(0, SKULLS[req.difficulty] - comfortable) : 0;
    const known = group.filter((a) => a.rarity !== null);
    const avgRarity = known.length ? known.reduce((s, a) => s + a.rarity, 0) / known.length : null;
    const common = avgRarity === null ? 0 : avgRarity / 10;
    const crew = prefs.playstyle === 'solo' ? group.filter((a) => a.crew).length : 0;
    const mode = runMode(group);
    const modeFit = !wanted || mode === 'any' ? 0 : mode === wanted ? 1 : -1;

    const score = w.size * n + w.perTarget * perTarget + w.finish * finish + w.stretch * stretch + w.common * common + w.crew * crew + w.mode * modeFit;

    const reasons = [];
    if (n > 1) reasons.push(`${n} targets can share one run`);
    if (leftAfter === 0) reasons.push(`clears ${heist}`);
    else if (leftAfter <= 2) reasons.push(`leaves only ${leftAfter} on ${heist}`);
    if (req && stretch === 0) reasons.push(`${req.difficulty} is within your comfort zone`);
    else if (req) reasons.push(`needs ${req.difficulty}, ${stretch} skull${stretch === 1 ? '' : 's'} above your ${prefs.difficulty}`);
    if (avgRarity !== null && avgRarity >= 10) reasons.push(`commonly unlocked (${avgRarity.toFixed(0)}% of players)`);
    else if (avgRarity !== null && avgRarity <= 3) reasons.push(`rare: ${avgRarity.toFixed(1)}% of players have it`);
    if (modeFit === 1) reasons.push(`a ${mode} run, as you prefer`);
    else if (modeFit === -1) reasons.push(`a ${mode} run, though you prefer ${wanted}`);
    if (crew) reasons.push(`${crew === 1 ? 'one target mentions' : `${crew} targets mention`} a crew`);
    if (perTarget <= 15) reasons.push('quick');

    return { heist, group, score, reasons, mode };
  });

  return ranked.sort((a, b) => b.score - a.score || b.group.length - a.group.length || a.heist.localeCompare(b.heist));
}

const sentence = (reasons) => (reasons.length ? `${reasons[0][0].toUpperCase()}${reasons[0].slice(1)}${reasons.length > 1 ? `; ${reasons.slice(1).join('; ')}` : ''}.` : '');

export function buildPlan(items, state, prefs, rotation = 0) {
  const strategy = STRATEGIES[prefs.strategy] || STRATEGIES.balanced;
  const active = items.filter((a) => isActive(state, a) && a.kind !== 'infamy');
  const remaining = plannable(items, state, prefs);
  const comfortable = SKULLS[prefs.difficulty];
  const stretch = (a) => (SKULLS[a.difficulty] > comfortable ? 5 : 0) + (prefs.playstyle === 'solo' && a.crew ? 12 : 0);
  // Loose objectives: comfortable ones first; "Easy wins" also puts short, commonly unlocked ones ahead.
  const pool = [...remaining].sort((a, b) => stretch(a) - stretch(b)
    || (prefs.strategy === 'easy' ? a.effort - b.effort || (b.rarity ?? 0) - (a.rarity ?? 0) : 0));
  const spin = (list) => rotate(list, rotation);

  const picked = new Set();
  const runs = [];
  let count = prefs.batchSize;
  let minutes = prefs.minutes;

  // Takes as many of `choices` as fit the remaining time and count. The first run always gets at least one target;
  // later runs only open when most of their first target's time is still available.
  // `shared` is false for loose objectives that each need their own run or a menu visit.
  const add = (title, category, choices, why, { cap = Infinity, shared = true } = {}) => {
    const fresh = choices.filter((a) => !picked.has(a.id));
    if (!fresh.length || count <= 0) return null;
    if (runs.length && minutes < fresh[0].effort * 0.75) return null;
    const cost = (list) => (shared ? runMinutes(list) : list.reduce((n, a) => n + a.effort, 0));
    const targets = [];
    for (const a of fresh) {
      if (targets.length >= cap || targets.length >= count) break;
      const next = cost([...targets, a]);
      if (targets.length && next > minutes) break;
      targets.push(a);
    }
    if (!targets.length) return null;
    targets.forEach((a) => picked.add(a.id));
    count -= targets.length;
    const spent = cost(targets);
    minutes -= spent;
    const run = { title, category, achievementIds: targets.map((a) => a.id), minutes: spent, why, briefing: describeRun(targets, prefs) };
    runs.push(run);
    return run;
  };

  // Selection order gives the heist run first claim on the time budget; display order (below) still opens with the warm-up.
  const byHeist = new Map();
  for (const a of pool.filter((a) => !a.hard && a.heist !== GENERAL)) {
    if (!byHeist.has(a.heist)) byHeist.set(a.heist, []);
    byHeist.get(a.heist).push(a);
  }
  const remainingByHeist = new Map();
  for (const a of active) remainingByHeist.set(a.heist, (remainingByHeist.get(a.heist) || 0) + 1);
  const ranked = rankClusters(
    [...byHeist.entries()].flatMap(([heist, targets]) => splitIntoRuns(targets).map((group) => ({ heist, group }))),
    { prefs, remainingByHeist },
  );

  // A pinned heist leads outright. Otherwise "New batch" cycles through the shortlist of best-ranked runs,
  // so pressing it a few times shows the strong options rather than working down to the weakest.
  const pinned = ranked.filter((c) => prefs.focusHeist && c.heist === prefs.focusHeist);
  const others = ranked.filter((c) => !pinned.includes(c));
  const shortlist = Math.min(others.length, Math.max(4, Math.ceil(others.length / 3)));
  const offset = shortlist ? rotation % shortlist : 0;
  const ordered = [...rotate(others.slice(0, shortlist), offset), ...others.slice(shortlist)];
  const [focus, ...rest] = [...pinned, ...ordered];
  const pick = focus ? { index: offset + 1, of: shortlist, pinned: pinned.length > 0 } : null;

  if (focus) {
    const why = sentence(pinned.length ? ['your pinned heist', ...focus.reasons] : focus.reasons) || 'A remaining target on this heist.';
    add(focus.heist, 'Heist focus', focus.group, why);
  }

  if (prefs.variety) {
    // Warm-up: cheap objectives only. Collectibles tied to a heist with other targets stay with that heist.
    const light = spin(pool.filter((a) => !a.hard && a.effort <= 15 && !picked.has(a.id) && (a.kind === 'setup' || a.kind === 'weapon' || (a.kind === 'collectible' && a.heist === GENERAL))));
    add(
      light[0]?.kind === 'setup' ? 'A little preparation' : 'A change of pace',
      'Quick start',
      light,
      'Short objectives to warm up with. Each is its own small job or a visit to the menu.',
      { cap: Math.max(1, Math.floor(prefs.batchSize / 3)), shared: false },
    );
    const challenge = spin(pool.filter((a) => a.hard && !picked.has(a.id)));
    if (strategy.challenge) add(challenge[0]?.heist || 'The stretch goal', 'One challenge', challenge, 'A stretch goal for this session. Keep attempts short and come back when you feel ready.', { cap: 1 });
  }

  for (const { heist, group, reasons } of rest) {
    if (count <= 0 || minutes <= 0) break;
    add(heist, 'Another job', group, sentence(reasons) || 'A single remaining target on this heist.');
  }

  add('Equipment and other objectives', 'Cleanup', spin(pool.filter((a) => !a.hard)), 'Loose ends. Use these as individual objectives or add them to a compatible heist.', { shared: false });

  if (!runs.length && pool.length) {
    add(pool[0].heist, 'Specialist job', [pool[0]], 'Only specialist challenges remain. Plan a focused attempt.', { cap: 1 });
  }

  const order = ['Quick start', 'Heist focus', 'One challenge', 'Another job', 'Cleanup', 'Specialist job'];
  runs.sort((a, b) => order.indexOf(a.category) - order.indexOf(b.category));

  const infamy = items.filter((a) => a.kind === 'infamy' && !state.completed[a.id]);
  if (prefs.infamyBreaks && infamy.length) {
    runs.push({
      title: 'Make room for Infamy',
      category: 'The long game',
      achievementIds: [],
      minutes: 0,
      why: prefs.infamy === null
        ? 'Set your current Infamy rank in preferences. Between batches, take a small XP break toward your next locked milestone.'
        : `You are at Infamy ${prefs.infamy}. Between batches, work toward 1–2 more ranks without abandoning your other goals.`,
      briefing: [],
    });
  }

  // `hidden` counts targets kept out of this plan by skipped heists or a stealth-only / loud-only preference.
  return {
    source: 'local',
    runs,
    minutes: runs.reduce((n, r) => n + r.minutes, 0),
    budget: prefs.minutes,
    pick,
    hidden: active.length - remaining.length,
  };
}

/**
 * Replace one target in a plan with another unplanned, still-active achievement.
 * Keeps the same hardness, prefers the same heist and a compatible mode, then the same kind,
 * and avoids crew wording when it can. Skipped heists and ruled-out modes stay out. Removes the target when nothing fits.
 */
export function swapTarget(plan, runIndex, id, items, state, prefs = DEFAULT_PREFS) {
  const run = plan.runs[runIndex];
  if (!run || !run.achievementIds.includes(id)) return { plan, replacement: null };
  const current = items.find((a) => a.id === id);
  const planned = new Set(plan.runs.flatMap((r) => r.achievementIds));
  const fits = (a) => a.hard === Boolean(current?.hard);
  const candidates = plannable(items, state, prefs)
    .filter((a) => !planned.has(a.id) && fits(a))
    .sort((a, b) => Number(a.crew) - Number(b.crew));
  const compatible = (a) => current && (a.mode === 'any' || current.mode === 'any' || a.mode === current.mode) && (a.day === null || current.day === null || a.day === current.day);
  const sameHeist = current && current.heist !== GENERAL ? candidates.filter((a) => a.heist === current.heist && compatible(a)) : [];
  const sameKind = current ? candidates.filter((a) => a.kind === current.kind) : [];
  const replacement = sameHeist[0] || sameKind[0] || candidates[0] || null;
  const byId = new Map(items.map((a) => [a.id, a]));
  const runs = plan.runs.map((r, i) => {
    if (i !== runIndex) return r;
    const achievementIds = replacement
      ? r.achievementIds.map((x) => (x === id ? replacement.id : x))
      : r.achievementIds.filter((x) => x !== id);
    const targets = achievementIds.map((x) => byId.get(x)).filter(Boolean);
    return { ...r, achievementIds, minutes: runMinutes(targets), briefing: describeRun(targets, prefs) };
  }).filter((r) => r.achievementIds.length || r.category === 'The long game');
  return { plan: { ...plan, runs, minutes: runs.reduce((n, r) => n + r.minutes, 0) }, replacement };
}

export function heistBreakdown(items, state) {
  const map = new Map();
  for (const a of items) {
    if (!map.has(a.heist)) map.set(a.heist, { heist: a.heist, total: 0, done: 0, later: 0, remaining: 0 });
    const row = map.get(a.heist);
    row.total += 1;
    if (state.completed[a.id]) row.done += 1;
    else if (state.later[a.id]) row.later += 1;
    else row.remaining += 1;
  }
  return [...map.values()].sort((a, b) => b.remaining - a.remaining || b.total - a.total || a.heist.localeCompare(b.heist));
}

/** One line saying how a plan was chosen, for the board and the text export. */
export function describePick(plan, prefs) {
  const parts = [`Strategy: ${(STRATEGIES[prefs.strategy] || STRATEGIES.balanced).label}`];
  if (prefs.modePref && prefs.modePref !== 'any') parts.push(MODE_PREFS[prefs.modePref].toLowerCase());
  if (plan.pick?.pinned) parts.push(`pinned to ${prefs.focusHeist}`);
  else if (plan.pick?.of > 1) parts.push(`option ${plan.pick.index} of ${plan.pick.of}`);
  if (prefs.skipHeists?.length) parts.push(`skipping ${prefs.skipHeists.length === 1 ? prefs.skipHeists[0] : `${prefs.skipHeists.length} heists`}`);
  return parts.join(' · ');
}

export function planToText(plan, items, state, prefs) {
  const byId = new Map(items.map((a) => [a.id, a]));
  const lines = [
    `The Completion Job: next session${prefs.player ? ` for ${prefs.player}` : ''}`,
    `About ${plan.minutes} minutes planned for a ${plan.budget}-minute session.`,
    describePick(plan, prefs),
    '',
  ];
  plan.runs.forEach((run, i) => {
    lines.push(`${i + 1}. ${run.title} (${run.category}${run.minutes ? `, ~${run.minutes} min` : ''})`);
    for (const id of run.achievementIds) {
      const a = byId.get(id);
      if (!a) continue;
      lines.push(`   [${state.completed[id] ? 'x' : ' '}] ${a.name}: ${a.description}`);
    }
    for (const line of run.briefing || []) lines.push(`   ${line}`);
    if (run.why) lines.push(`   ${run.why}`);
    lines.push('');
  });
  lines.push('Checkmarks are website progress, not Steam-confirmed unlocks. Time estimates are rough.');
  return lines.join('\n');
}
