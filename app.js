import {
  DEFAULT_PREFS, DIFFICULTIES, KIND_LABELS, GENERAL, SKULLS, NO_DIFFICULTY, MODE_LABELS,
  cleanPrefs, normalizeDataset, compareDatasets, buildPlan, runMinutes, describeRun,
  swapTarget, heistBreakdown, planToText, isActive, steamProfileUrl,
} from './planner.js';

const STORAGE_KEY = 'the-completion-job.v1';
const PAGE_SIZE = 30;
// Address of the deployed Steam proxy (see worker/). Leave empty to offer file import only.
const STEAM_PROXY_URL = 'https://completion-job-steam.mikematt33.workers.dev/';
const $ = (selector) => document.querySelector(selector);

let dataset = null;
let items = [];
let state;
let view = 'landing';
let visible = PAGE_SIZE;
let breakdownExpanded = false;
let toastTimer;
let toastAction = null;
let installPrompt = null;
let savedAt = null;
let backedUpAt = null;
let fetching = false;

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const plural = (n, word) => `${n.toLocaleString()} ${word}${n === 1 ? '' : 's'}`;

function relativeTime(value) {
  const t = Date.parse(value);
  if (!Number.isFinite(t)) return '';
  const minutes = Math.round((Date.now() - t) / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} hr ago`;
  const days = Math.round(hours / 24);
  if (days < 7) return days === 1 ? 'yesterday' : `${days} days ago`;
  return new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

// ---------- feedback ----------

function notify(message, action) {
  $('#toast-text').textContent = message;
  const button = $('#toast-action');
  toastAction = action?.onAction || null;
  button.hidden = !action;
  if (action) button.textContent = action.label;
  $('#toast').classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(hideToast, action ? 7000 : 4200);
}

function hideToast() {
  $('#toast').classList.remove('show');
  toastAction = null;
}

$('#toast-action').onclick = () => {
  const run = toastAction;
  hideToast();
  run?.();
};

// ---------- persistence ----------

function save() {
  try {
    savedAt = new Date().toISOString();
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...state, dataset, savedAt, backedUpAt }));
    renderSaveStatus();
  } catch {
    $('#save-status').textContent = 'Not saved: storage unavailable';
    notify('Browser storage is unavailable or full. Export a backup to keep your progress.');
  }
}

function renderSaveStatus() {
  const el = $('#save-status');
  if (!el) return;
  el.textContent = savedAt ? `Saved ${relativeTime(savedAt)}` : 'Saved on this device';
  const note = $('#backup-note');
  if (note) {
    const days = backedUpAt ? Math.floor((Date.now() - Date.parse(backedUpAt)) / 86400000) : null;
    note.textContent = backedUpAt
      ? `Last backup ${relativeTime(backedUpAt)}.${days >= 14 ? ' That was a while ago; export a fresh one.' : ''}`
      : 'No backup exported yet. Browser data can be lost when site data is cleared, so export one once you have progress worth keeping.';
  }
}

function cleanState(raw, ds) {
  const ids = new Set(ds.achievements.map((a) => a.id));
  const entries = (obj) => Object.entries(obj && typeof obj === 'object' ? obj : {}).filter(([id]) => ids.has(id));
  const flags = (obj) => Object.fromEntries(entries(obj).filter(([, v]) => v === true).map(([id]) => [id, true]));
  // Completions store an ISO timestamp; legacy saves used `true`.
  const completed = Object.fromEntries(entries(raw?.completed)
    .filter(([, v]) => v === true || (typeof v === 'string' && Number.isFinite(Date.parse(v))))
    .map(([id, v]) => [id, v]));
  const notes = Object.fromEntries(entries(raw?.notes).filter(([, v]) => typeof v === 'string').map(([id, v]) => [id, v.slice(0, 4000)]));
  return {
    completed,
    later: flags(raw?.later),
    notes,
    prefs: cleanPrefs({ ...DEFAULT_PREFS, ...raw?.prefs }),
    rotation: Number.isInteger(raw?.rotation) ? Math.max(0, raw.rotation) : 0,
    profile: cleanProfile(raw?.profile),
    plan: null,
  };
}

// Level and Infamy as reported by Steam's stats feed; null when the list came from a file.
function cleanProfile(p) {
  if (!p || typeof p !== 'object') return null;
  const int = (v, max) => (Number.isInteger(v) && v >= 0 && v <= max ? v : null);
  const level = int(p.level, 100);
  const infamy = int(p.infamy, 500);
  if (level === null && infamy === null) return null;
  return { level, infamy, at: typeof p.at === 'string' && Number.isFinite(Date.parse(p.at)) ? p.at : new Date().toISOString() };
}

function restorePlan(rawPlan, catalogue = items, st = state, prefs = state?.prefs || DEFAULT_PREFS) {
  if (!rawPlan?.runs || !Array.isArray(rawPlan.runs) || rawPlan.runs.length > 20) return null;
  const ids = new Set(catalogue.map((a) => a.id));
  const byId = new Map(catalogue.map((a) => [a.id, a]));
  const valid = rawPlan.runs.every((r) => typeof r.title === 'string' && Array.isArray(r.achievementIds) && r.achievementIds.every((id) => typeof id === 'string'));
  if (!valid) return null;
  // Saved plans from before run briefings existed are rebuilt rather than restored half-empty.
  if (!rawPlan.runs.every((r) => Array.isArray(r.briefing))) return null;
  const runs = rawPlan.runs
    .map((r) => {
      // Targets missing from the catalogue were unlocked on Steam since the plan was built.
      const achievementIds = r.achievementIds.filter((id) => ids.has(id) && !st.completed[id] && !st.later[id]);
      const trimmed = achievementIds.length !== r.achievementIds.length;
      const targets = achievementIds.map((id) => byId.get(id));
      return {
        title: r.title.slice(0, 150),
        category: String(r.category || 'Your plan').slice(0, 50),
        why: String(r.why || '').slice(0, 3000),
        briefing: trimmed && targets.length ? describeRun(targets, prefs) : r.briefing.filter((l) => typeof l === 'string').map((l) => l.slice(0, 300)),
        achievementIds,
        minutes: trimmed ? runMinutes(targets) : Number.isFinite(r.minutes) ? r.minutes : 0,
      };
    })
    .filter((r, i) => r.achievementIds.length || !rawPlan.runs[i].achievementIds.length);
  if (!runs.length) return null;
  return { source: 'local', runs, minutes: runs.reduce((n, r) => n + r.minutes, 0), budget: Number.isFinite(rawPlan.budget) ? rawPlan.budget : prefs.minutes };
}

// ---------- navigation ----------

const PAGE_LABELS = { landing: 'Start', board: 'The board', vault: 'Achievement vault', preferences: 'Your preferences' };

function setView(next, filters) {
  if (!PAGE_LABELS[next]) return;
  if (!dataset && next !== 'landing') next = 'landing';
  view = next;
  document.body.classList.toggle('no-data', !dataset);
  for (const section of document.querySelectorAll('.view')) section.hidden = section.id !== `${next}-view`;
  for (const b of document.querySelectorAll('.nav-item')) {
    const active = b.dataset.view === next;
    b.classList.toggle('active', active);
    b.disabled = !dataset;
    if (active) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current');
  }
  $('#page-label').textContent = PAGE_LABELS[next];
  if (filters) {
    if (filters.status) $('#status-filter').value = filters.status;
    if (filters.heist !== undefined) $('#heist-filter').value = filters.heist;
    if (filters.kind !== undefined) $('#kind-filter').value = filters.kind;
    visible = PAGE_SIZE;
  }
  if (next === 'vault') renderVault();
  if (next === 'preferences') fillPreferences();
  window.scrollTo({ top: 0, behavior: 'instant' });
}

// ---------- rendering: shared pieces ----------

const RISK_CLASS = (difficulty) => `risk-${SKULLS[difficulty] ?? 0}`;

function skulls(difficulty, { label = true } = {}) {
  const count = SKULLS[difficulty];
  if (count === undefined) return '';
  const icons = count ? Array.from({ length: count }, () => '<svg class="skull"><use href="#skull"/></svg>').join('') : '';
  return `<span class="skulls ${RISK_CLASS(difficulty)}" title="${esc(difficulty)}" aria-label="${esc(difficulty)}">${icons}${label ? `<span>${esc(difficulty)}</span>` : ''}</span>`;
}

function tags(a) {
  const list = [`<span class="tag heist">${esc(a.heist)}</span>`];
  if (a.kind !== 'heist') list.push(`<span class="tag">${esc(KIND_LABELS[a.kind] || a.kind)}</span>`);
  if (a.difficulty !== NO_DIFFICULTY) list.push(`<span class="tag ${RISK_CLASS(a.difficulty)}">${skulls(a.difficulty)}${a.orAbove ? '<span class="or-above">+</span>' : ''}</span>`);
  if (a.mode !== 'any') list.push(`<span class="tag mode-${a.mode}">${MODE_LABELS[a.mode]}</span>`);
  if (a.day !== null) list.push(`<span class="tag">Day ${a.day}</span>`);
  if (a.timeLimit !== null) list.push(`<span class="tag">${a.timeLimit} min limit</span>`);
  if (a.hard) list.push('<span class="tag danger">Hard challenge</span>');
  if (a.crew) list.push('<span class="tag warn">Crew wording</span>');
  if (state.later[a.id]) list.push('<span class="tag later">Set aside</span>');
  return `<span class="row-tags">${list.join('')}</span>`;
}

function row(a) {
  const done = Boolean(state.completed[a.id]);
  return `<article class="achievement-row ${done ? 'done' : ''}">
    <input class="check" type="checkbox" data-check="${esc(a.id)}" ${done ? 'checked' : ''} aria-label="Mark ${esc(a.name)} complete">
    <button class="row-body" data-detail="${esc(a.id)}">
      <span class="row-title">${esc(a.name)}</span>
      <span class="row-description">${esc(a.description)}</span>
      ${tags(a)}
    </button>
    <button class="row-arrow" data-detail="${esc(a.id)}" aria-label="Details for ${esc(a.name)}">
      <svg aria-hidden="true" viewBox="0 0 20 20"><path d="M7 4l6 6-6 6"/></svg>
    </button>
  </article>`;
}

// ---------- rendering: board ----------

function renderHero() {
  const checked = Object.keys(state.completed).length;
  const later = Object.keys(state.later).length;
  const { total, unlocked: steamUnlocked } = dataset.counts;
  const unlocked = steamUnlocked + checked;
  const percent = total ? (100 * unlocked) / total : 100;
  const locked = items.length - checked;

  $('#progress-percent').innerHTML = `${percent.toFixed(1)}<span>%</span>`;
  $('#loot-unlocked').style.width = `${total ? (100 * steamUnlocked) / total : 0}%`;
  $('#loot-checked').style.width = `${total ? (100 * checked) / total : 0}%`;
  $('#loot-bar').setAttribute('aria-label', `Progress: ${steamUnlocked.toLocaleString()} unlocked on Steam, ${checked} checked off here, ${locked.toLocaleString()} still locked`);
  $('#hero-unlocked').textContent = steamUnlocked.toLocaleString();
  $('#hero-checked').textContent = checked.toLocaleString();
  $('#hero-locked').textContent = locked.toLocaleString();
  $('#hero-total').textContent = total.toLocaleString();

  $('#remaining-count').textContent = locked.toLocaleString();
  $('#completed-count').textContent = checked.toLocaleString();
  $('#later-count').textContent = later.toLocaleString();
  $('#nav-count').textContent = locked.toLocaleString();
  $('#profile-name').textContent = state.prefs.player || 'Heister';
  const steamUrl = steamProfileUrl(state.prefs.steam);
  const steamLink = $('#steam-link');
  steamLink.hidden = !steamUrl;
  if (steamUrl) steamLink.href = `${steamUrl}achievements/218620/`;
  $('#fbi-open').hidden = !steamUrl;

  const nextInfamy = items
    .filter((a) => a.kind === 'infamy' && !state.completed[a.id])
    .map((a) => (/fiftieth/i.test(a.description) ? 50 : /seventy-fifth/i.test(a.description) ? 75 : /hundredth/i.test(a.description) ? 100 : null))
    .filter(Boolean)
    .sort((a, b) => a - b)[0];
  const rank = state.profile?.infamy ?? state.prefs.infamy;
  const level = state.profile?.level;
  $('#infamy-label').textContent = rank === null || rank === undefined ? 'Infamy target' : 'Infamy';
  $('#infamy-stat').innerHTML = rank !== null && rank !== undefined
    ? `${rank}${level !== null && level !== undefined ? `<small class="level">-${level}</small>` : ''} <small>${nextInfamy ? `next ${nextInfamy}` : 'milestones done'}</small>`
    : nextInfamy ? `${nextInfamy} <small>next milestone</small>` : '— <small>no target imported</small>';
  const infamyHelp = $('#infamy-help');
  infamyHelp.textContent = state.profile
    ? `Steam reports Infamy ${state.profile.infamy ?? '?'}${state.profile.level !== null ? `, level ${state.profile.level}` : ''} as of ${relativeTime(state.profile.at)}. This field follows Steam on every refresh.`
    : 'Used for the Infamy break in your session plan. Filled in automatically when your list is fetched from Steam.';
  $('#dataset-note').textContent = `${dataset.source.replace(/\.$/, '')}. ${plural(dataset.counts.locked, 'locked achievement')} in this list${dataset.importedAt ? `, ${dataset.source.startsWith('Fetched') ? 'fetched' : 'imported'} ${relativeTime(dataset.importedAt)}` : ''}. ${STEAM_PROXY_URL ? (state.prefs.steam ? 'Refreshed from Steam each time the app opens.' : 'Add your Steam ID to refresh from Steam automatically.') : 'Nothing is fetched from Steam automatically.'}`;
  renderSaveStatus();
}

function renderBreakdown() {
  const rows = heistBreakdown(items, state);
  const withWork = rows.filter((r) => r.remaining > 0);
  const shown = breakdownExpanded ? rows : withWork.slice(0, 8);
  // Square-root scale keeps small heists visible next to the big "General challenges" bucket.
  const max = Math.max(1, ...rows.map((r) => r.total));
  const width = (total) => Math.max(4, 100 * Math.sqrt(total / max));
  $('#breakdown-toggle').textContent = breakdownExpanded ? 'Show the busiest heists' : `Show all ${rows.length} heists`;
  $('#breakdown-toggle').hidden = rows.length <= 8;
  $('#breakdown').innerHTML = shown.length ? shown.map((r) => `
    <button class="breakdown-row ${r.remaining ? '' : 'cleared'}" data-view="vault" data-heist="${esc(r.heist)}" data-status="${r.remaining ? 'remaining' : 'all'}">
      <span class="breakdown-name">${esc(r.heist)}</span>
      <span class="breakdown-bar" aria-hidden="true" style="--size:${width(r.total)}%">
        <i class="done" style="width:${(100 * r.done) / r.total}%"></i>
        <i class="later" style="width:${(100 * r.later) / r.total}%"></i>
      </span>
      <span class="breakdown-count">${r.remaining ? `${r.remaining} left` : 'Cleared'}<small>of ${r.total}</small></span>
    </button>`).join('')
    : '<div class="empty-state"><strong>Every heist is cleared.</strong>Import your next list to keep going.</div>';
}

function renderPlan() {
  if (!state.plan) state.plan = buildPlan(items, state, state.prefs, state.rotation);
  const byId = new Map(items.map((a) => [a.id, a]));
  const { runs, minutes, budget } = state.plan;
  const targetCount = runs.reduce((n, r) => n + r.achievementIds.length, 0);
  const doneCount = runs.reduce((n, r) => n + r.achievementIds.filter((id) => state.completed[id]).length, 0);
  const fit = minutes > budget * 1.25 ? ', more than one sitting' : '';
  $('#session-size').textContent = targetCount ? `${plural(targetCount, 'target')}, about ${minutes} min planned for a ${budget}-minute session${fit}${doneCount ? `, ${doneCount} done` : ''}` : '';
  $('#copy-plan').disabled = $('#print-plan').disabled = !targetCount;

  $('#session-grid').innerHTML = runs.length ? runs.map((run, i) => {
    const targets = run.achievementIds.map((id) => byId.get(id)).filter(Boolean);
    const allDone = targets.length > 0 && targets.every((a) => state.completed[a.id]);
    // Contract-card style: show the run's highest stated risk as skulls.
    const peak = targets.map((a) => a.difficulty).filter((d) => SKULLS[d] !== undefined).sort((a, b) => SKULLS[b] - SKULLS[a])[0];
    const briefing = (run.briefing || []).filter(Boolean);
    return `<article class="job-card ${allDone ? 'done' : ''}">
      <div class="job-top">
        <div class="job-kicker"><span>Run ${i + 1} · ${esc(run.category)}</span>${peak ? skulls(peak, { label: false }) : ''}</div>
        <h3>${esc(run.title)}</h3>
        <p class="job-sub">${targets.length ? `${plural(targets.length, 'achievement')}${run.minutes ? ` · about ${run.minutes} min` : ''}` : 'Small steps between batches'}</p>
      </div>
      ${targets.length ? `<div class="job-items">${targets.map((a) => `
        <div class="job-target ${state.completed[a.id] ? 'done' : ''}">
          <input class="check" type="checkbox" data-check="${esc(a.id)}" ${state.completed[a.id] ? 'checked' : ''} aria-label="Mark ${esc(a.name)} complete">
          <button class="job-target-body" data-detail="${esc(a.id)}" data-description="${esc(a.description)}">${esc(a.name)}<small>${a.difficulty === NO_DIFFICULTY ? esc(a.heist) : skulls(a.difficulty)}${a.mode !== 'any' ? `<span class="mode-flag">${MODE_LABELS[a.mode]}</span>` : ''}${a.crew ? '<span class="crew-flag">review crew wording</span>' : ''}</small></button>
          <button class="icon-button swap" data-swap="${esc(a.id)}" data-run="${i}" title="Swap for another target" aria-label="Swap ${esc(a.name)} for another target">
            <svg aria-hidden="true" viewBox="0 0 20 20"><path d="M4 7h11l-3-3M16 13H5l3 3"/></svg>
          </button>
        </div>`).join('')}</div>` : ''}
      ${briefing.length ? `<ul class="job-briefing">${briefing.map((l) => `<li>${esc(l)}</li>`).join('')}</ul>` : ''}
      <p class="job-note">${esc(run.why)}</p>
      ${targets.length ? `<div class="job-actions"><button class="text-button" data-run-done="${i}">${allDone ? 'Reopen this run' : 'Mark run complete'}</button></div>` : ''}
    </article>`;
  }).join('')
    : '<div class="empty-state"><strong>No targets in this queue.</strong>All imported achievements are checked off or set aside. Review the vault or import your next list.</div>';
}

function renderActivity() {
  const recent = Object.entries(state.completed)
    .filter(([, v]) => typeof v === 'string')
    .sort((a, b) => Date.parse(b[1]) - Date.parse(a[1]))
    .slice(0, 6)
    .map(([id, at]) => ({ a: items.find((x) => x.id === id), at }))
    .filter((x) => x.a);
  $('#activity').innerHTML = recent.length ? `<ol class="activity-list">${recent.map(({ a, at }) => `
    <li><button data-detail="${esc(a.id)}"><span class="activity-name">${esc(a.name)}</span><span class="activity-meta">${esc(a.heist)}</span></button><time datetime="${esc(at)}">${esc(relativeTime(at))}</time></li>`).join('')}</ol>`
    : '<div class="empty-state"><strong>Nothing checked off yet.</strong>Your first finished job will show up here.</div>';
}

function renderRadar() {
  const next = items.filter((a) => isActive(state, a)).slice(0, 3);
  $('#radar').innerHTML = next.map(row).join('') || '<div class="empty-state"><strong>Your active list is clear.</strong>Nice work.</div>';
}

// ---------- rendering: vault ----------

const DEFAULT_FILTERS = { search: '', heist: '', status: 'remaining', kind: '', difficulty: '', sort: 'default' };

function currentFilters() {
  return {
    search: $('#search').value.trim().toLowerCase(),
    heist: $('#heist-filter').value,
    status: $('#status-filter').value,
    kind: $('#kind-filter').value,
    difficulty: $('#difficulty-filter').value,
    sort: $('#sort-filter').value,
  };
}

function filteredItems(f, grouped = false) {
  const list = items.filter((a) =>
    (!f.search || `${a.name} ${a.description} ${a.heist}`.toLowerCase().includes(f.search))
    && (!f.heist || a.heist === f.heist)
    && (!f.kind || a.kind === f.kind)
    && (!f.difficulty || (f.difficulty === 'none' ? a.difficulty === 'No difficulty specified' : a.difficulty === f.difficulty))
    && (f.status === 'all'
      || (f.status === 'done' && state.completed[a.id])
      || (f.status === 'later' && state.later[a.id] && !state.completed[a.id])
      || (f.status === 'remaining' && !state.completed[a.id])));
  const rank = (a) => (a.difficulty === 'No difficulty specified' ? DIFFICULTIES.length : DIFFICULTIES.indexOf(a.difficulty));
  const rarity = (a, fallback) => (a.rarity === null ? fallback : a.rarity);
  const byHeist = (a, b) => (a.heist === GENERAL) - (b.heist === GENERAL) || a.heist.localeCompare(b.heist);
  const sorters = {
    name: (a, b) => a.name.localeCompare(b.name),
    heist: (a, b) => byHeist(a, b) || a.name.localeCompare(b.name),
    difficulty: (a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name),
    rarity: (a, b) => rarity(a, 101) - rarity(b, 101),
    common: (a, b) => rarity(b, -1) - rarity(a, -1),
  };
  const sorter = sorters[f.sort] || (() => 0);
  // Grouping keeps each heist together, then applies the chosen order inside the group.
  return grouped ? list.sort((a, b) => byHeist(a, b) || sorter(a, b)) : list.sort(sorter);
}

function renderVault() {
  const f = currentFilters();
  const grouped = $('#group-toggle').checked;
  const list = filteredItems(f, grouped);
  const isFiltered = Object.keys(DEFAULT_FILTERS).some((k) => f[k] !== DEFAULT_FILTERS[k]);
  $('#clear-filters').hidden = !isFiltered;
  $('#results-count').textContent = `${plural(list.length, 'achievement')}${f.search ? ' matching your search' : ''}`;
  $('#achievement-list').classList.toggle('expanded', $('#expand-toggle').checked);

  const page = list.slice(0, visible);
  let html;
  if (!page.length) {
    html = '<div class="empty-state"><strong>No jobs here.</strong>Try another search or clear the filters.</div>';
  } else if (grouped) {
    const groups = new Map();
    for (const a of page) {
      if (!groups.has(a.heist)) groups.set(a.heist, []);
      groups.get(a.heist).push(a);
    }
    html = [...groups.entries()].map(([heist, rows]) => `<section class="vault-group"><h3>${esc(heist)}<small>${plural(rows.length, 'achievement')}</small></h3>${rows.map(row).join('')}</section>`).join('');
  } else {
    html = page.map(row).join('');
  }
  $('#achievement-list').innerHTML = html;
  $('#load-more').hidden = list.length <= visible;
  $('#load-more').textContent = `Show more (${(list.length - visible).toLocaleString()} left)`;
}

function populateHeists() {
  const select = $('#heist-filter');
  const previous = select.value;
  const counts = heistBreakdown(items, state);
  select.innerHTML = '<option value="">Every heist</option>' + counts
    .slice()
    .sort((a, b) => (a.heist === GENERAL) - (b.heist === GENERAL) || a.heist.localeCompare(b.heist))
    .map((r) => `<option value="${esc(r.heist)}">${esc(r.heist)} (${r.remaining})</option>`)
    .join('');
  select.value = counts.some((r) => r.heist === previous) ? previous : '';
}

function render() {
  if (!dataset) { setView('landing'); return; }
  renderHero();
  renderBreakdown();
  renderPlan();
  renderActivity();
  renderRadar();
  populateHeists();
  if (view === 'vault') renderVault();
}

// ---------- achievement details ----------

function detail(id) {
  const a = items.find((x) => x.id === id);
  if (!a) return;
  const done = state.completed[id];
  const wiki = `https://payday.fandom.com/wiki/Special:Search?query=${encodeURIComponent(a.name)}`;
  const guides = `https://steamcommunity.com/app/218620/guides/?searchText=${encodeURIComponent(a.name)}`;
  $('#detail-content').innerHTML = `
    <p class="detail-kicker">${esc(a.heist)}</p>
    <h2 id="detail-title">${esc(a.name)}</h2>
    <p class="detail-description">${esc(a.description)}</p>
    <div class="detail-tags">
      <span class="tag">${esc(KIND_LABELS[a.kind] || a.kind)}</span>
      ${a.difficulty !== NO_DIFFICULTY ? `<span class="tag ${RISK_CLASS(a.difficulty)}">${skulls(a.difficulty)}${a.orAbove ? ' or above' : ''}</span>` : '<span class="tag">No difficulty specified</span>'}
      ${a.mode !== 'any' ? `<span class="tag mode-${a.mode}">${MODE_LABELS[a.mode]}</span>` : ''}
      ${a.day !== null ? `<span class="tag">Day ${a.day}</span>` : ''}
      ${a.timeLimit !== null ? `<span class="tag">${a.timeLimit} min limit</span>` : ''}
      ${a.hard ? '<span class="tag danger">Hard challenge</span>' : ''}
      <span class="tag ${done ? 'success' : ''}">${done ? (typeof done === 'string' ? `Checked off ${esc(relativeTime(done))}` : 'Checked off here') : 'Imported as locked'}</span>
      ${a.global_unlock_percentage ? `<span class="tag">${esc(a.global_unlock_percentage)} of players have it</span>` : ''}
    </div>
    ${a.crew ? '<div class="info-box">This description mentions a crew condition. Check whether your solo mod supports this exact achievement before attempting it.</div>' : ''}
    ${a.restrictions.length ? `<p class="detail-restrictions">Loadout: ${a.restrictions.map(esc).join('; ')}.</p>` : ''}
    <div class="detail-links">
      <a class="text-button" href="${wiki}" target="_blank" rel="noopener noreferrer">Look it up on the PAYDAY wiki ↗</a>
      <a class="text-button" href="${guides}" target="_blank" rel="noopener noreferrer">Search Steam guides ↗</a>
      <a class="text-button" href="https://fbi.paydaythegame.com/" target="_blank" rel="noopener noreferrer" title="Official PAYDAY 2 stats site. Heist details are under Files → Heist Database.">FBI Files ↗</a>
    </div>
    <label class="detail-note-label" for="achievement-note">Your field notes</label>
    <textarea id="achievement-note" maxlength="4000" rows="4" placeholder="Loadout, route, or something to remember">${esc(state.notes[id] || '')}</textarea>
    <div class="detail-actions">
      <button id="detail-toggle" class="button primary">${done ? 'Mark unfinished' : 'Check off achievement'}</button>
      <button id="save-note" class="button secondary">Save note</button>
      <button id="later-toggle" class="text-button">${state.later[id] ? 'Return to active list' : 'Set aside for later'}</button>
    </div>
    <p class="fine-print">${STEAM_PROXY_URL ? 'Checking this off updates your checklist here; Steam catches up when the list is next refreshed.' : 'Checking this off updates your website checklist. Steam status is not automatically refreshed.'}</p>`;

  const stashNote = () => {
    const text = $('#achievement-note').value;
    if (text.trim()) state.notes[id] = text; else delete state.notes[id];
  };
  $('#save-note').onclick = () => { stashNote(); save(); notify('Note saved.'); };
  $('#detail-toggle').onclick = () => { stashNote(); toggle(id, !state.completed[id]); $('#achievement-dialog').close(); };
  $('#later-toggle').onclick = () => {
    stashNote();
    if (state.later[id]) delete state.later[id]; else { state.later[id] = true; delete state.completed[id]; }
    state.plan = null;
    save();
    render();
    $('#achievement-dialog').close();
    notify(state.later[id] ? 'Set aside. It is out of your queue until you bring it back.' : 'Back on your active list.');
  };
  $('#achievement-dialog').showModal();
}

// ---------- actions ----------

function toggle(id, value, { silent = false } = {}) {
  if (!items.some((a) => a.id === id)) return;
  const previous = state.completed[id];
  if (value) {
    state.completed[id] = new Date().toISOString();
    delete state.later[id];
  } else {
    delete state.completed[id];
  }
  save();
  render();
  if (silent) return;
  if (value) {
    notify('Checked off. Your checklist is saved.', { label: 'Undo', onAction: () => toggle(id, false, { silent: true }) });
  } else {
    notify('Back on your remaining list.', previous ? { label: 'Undo', onAction: () => { state.completed[id] = previous; save(); render(); } } : undefined);
  }
}

function toggleRun(index) {
  const run = state.plan?.runs[index];
  if (!run) return;
  const snapshot = Object.fromEntries(run.achievementIds.map((id) => [id, state.completed[id]]));
  const allDone = run.achievementIds.every((id) => state.completed[id]);
  const stamp = new Date().toISOString();
  for (const id of run.achievementIds) {
    if (allDone) delete state.completed[id];
    else if (!state.completed[id]) { state.completed[id] = stamp; delete state.later[id]; }
  }
  save();
  render();
  notify(allDone ? 'Run reopened.' : `Heist successful. ${plural(run.achievementIds.length, 'achievement')} checked off.`, {
    label: 'Undo',
    onAction: () => {
      for (const [id, was] of Object.entries(snapshot)) {
        if (was) state.completed[id] = was; else delete state.completed[id];
      }
      save();
      render();
    },
  });
}

function swap(runIndex, id) {
  const { plan, replacement } = swapTarget(state.plan, runIndex, id, items, state, state.prefs);
  state.plan = plan;
  save();
  renderPlan();
  notify(replacement ? `Swapped in ${replacement.name}.` : 'Removed from this session. Nothing else fits that slot right now.');
}

function regenerate() {
  state.rotation += 3;
  state.plan = buildPlan(items, state, state.prefs, state.rotation);
  save();
  renderPlan();
  notify('A fresh batch is on the board.');
}

function download(name, content, type = 'application/json') {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

async function copyOrDownload(text, filename, successMessage) {
  try {
    await navigator.clipboard.writeText(text);
    notify(successMessage);
  } catch {
    download(filename, text, 'text/plain');
    notify('Clipboard unavailable, so the file was downloaded instead.');
  }
}

function backup() {
  backedUpAt = new Date().toISOString();
  download('the-completion-job-backup.json', JSON.stringify({ format: 'the-completion-job', version: 1, exportedAt: backedUpAt, dataset, state }, null, 2));
  save();
  notify('Backup downloaded. Keep it somewhere safe.');
}

function fillPreferences() {
  const form = $('#preferences-form');
  for (const [name, value] of Object.entries(state.prefs)) {
    const el = form.elements.namedItem(name);
    if (!el) continue;
    if (el.type === 'checkbox') el.checked = value; else el.value = value ?? '';
  }
}

function restore(input, extraPrefs = {}, profile) {
  let changes = null;
  if (input.format === 'the-completion-job') {
    if (input.version !== 1 || !input.dataset || !input.state) throw Error('This backup format is not supported.');
    const ds = normalizeDataset(input.dataset);
    const st = cleanState(input.state, ds);
    st.plan = restorePlan(input.state.plan, ds.achievements, st, st.prefs);
    dataset = ds;
    state = st;
  } else if (dataset) {
    // A fresh achievement list on top of an existing one: keep everything recorded for targets still locked.
    const ds = normalizeDataset(input);
    changes = compareDatasets(dataset, ds, state);
    const st = cleanState({ ...state, prefs: { ...state.prefs, ...extraPrefs }, profile: profile ?? state.profile }, ds);
    st.plan = restorePlan(state.plan, ds.achievements, st, st.prefs);
    dataset = ds;
    state = st;
  } else {
    dataset = normalizeDataset(input);
    state = cleanState({ prefs: { ...state.prefs, ...extraPrefs }, profile }, dataset);
  }
  items = dataset.achievements;
  state.plan ||= buildPlan(items, state, state.prefs, state.rotation);
  save();
  visible = PAGE_SIZE;
  breakdownExpanded = false;
  render();
  return changes;
}

function namesList(list, limit = 25) {
  const shown = list.slice(0, limit).map((a) => `<li>${esc(a.name)} <span class="refresh-heist">${esc(a.heist)}</span></li>`).join('');
  const more = list.length > limit ? `<li class="refresh-more">and ${plural(list.length - limit, 'more')}</li>` : '';
  return `<ul class="refresh-list">${shown}${more}</ul>`;
}

function showChanges(changes) {
  const { unlocked, confirmed, unexpected, stillLocked, added, kept } = changes;
  const sections = [];
  if (unexpected.length) sections.push(`<h3>${plural(unexpected.length, 'achievement')} unlocked on Steam that you had not checked off here</h3>${namesList(unexpected)}`);
  if (stillLocked.length) sections.push(`<h3>${plural(stillLocked.length, 'achievement')} checked off here but still locked on Steam</h3><p>Worth a second look. They stay checked until you change them.</p>${namesList(stillLocked)}`);
  if (added.length) sections.push(`<h3>${plural(added.length, 'achievement')} new to this list</h3>${namesList(added)}`);
  const lead = unlocked.length
    ? `Steam shows ${plural(unlocked.length, 'achievement')} unlocked since your last import${confirmed.length ? `, ${confirmed.length === unlocked.length ? 'all' : confirmed.length} of which you had already checked off here` : ''}. ${plural(dataset.counts.locked, 'achievement')} left.`
    : `Nothing new has unlocked on Steam since your last import. ${plural(dataset.counts.locked, 'achievement')} left.`;
  $('#refresh-title').textContent = dataset.source.startsWith('Fetched') ? 'Synced with Steam' : 'List updated';
  $('#refresh-content').innerHTML = `
    <p>${lead}</p>
    ${sections.join('')}
    <p class="fine-print">Kept for the targets still locked: ${plural(kept.completed, 'checkmark')}, ${plural(kept.notes, 'note')}, ${kept.later} set aside. Your session plan was trimmed rather than rebuilt.</p>`;
  $('#refresh-dialog').showModal();
}

async function importFile(file, errorEl, extraPrefs) {
  errorEl.textContent = '';
  if (!file) return false;
  try {
    if (file.size > 8 * 1024 * 1024) throw Error('Choose a JSON file smaller than 8 MB.');
    if (!/\.json$/i.test(file.name) && !/json/.test(file.type)) throw Error('Choose a .json file. Saved web pages (.html) only contain the rows that were on screen.');
    const changes = restore(JSON.parse(await file.text()), extraPrefs);
    return { changes };
  } catch (error) {
    errorEl.textContent = error instanceof SyntaxError ? 'That file is not valid JSON. If you saved the Steam API page, make sure you saved the raw response, not a web page.' : error.message;
    return false;
  }
}

// ---------- Steam proxy ----------

async function fetchSteam(steam) {
  const url = `${STEAM_PROXY_URL}${STEAM_PROXY_URL.includes('?') ? '&' : '?'}steamid=${encodeURIComponent(steam)}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20000);
  try {
    const res = await fetch(url, { headers: { accept: 'application/json' }, cache: 'no-store', signal: controller.signal });
    const body = await res.json().catch(() => null);
    if (!res.ok) throw Error(body?.error || `The Steam proxy answered ${res.status}.`);
    return body;
  } catch (error) {
    if (error.name === 'AbortError') throw Error('Steam took too long to answer. Try again in a minute.');
    if (error instanceof TypeError) throw Error('Could not reach the Steam proxy. Check your connection and try again.');
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Pulls the current list from Steam through the proxy and lays it over what is loaded.
 * `quiet` is the start-up refresh: it stays silent unless something changed or Steam refused.
 */
async function refreshFromSteam({ steam = state.prefs.steam, extraPrefs = {}, errorEl = null, button = null, quiet = false } = {}) {
  if (!STEAM_PROXY_URL || fetching) return false;
  const id = cleanPrefs({ steam }).steam;
  if (!id) {
    if (errorEl) errorEl.textContent = 'Enter your Steam ID first.';
    else notify('Add your Steam ID in Preferences to refresh from Steam.');
    return false;
  }
  fetching = true;
  const label = button?.textContent;
  if (button) { button.disabled = true; button.textContent = 'Fetching from Steam…'; }
  if (errorEl) errorEl.textContent = '';
  try {
    const data = await fetchSteam(id);
    // Steam's stats feed knows the Infamy rank, so the preference follows it rather than being typed in.
    const profile = cleanProfile(data.profile);
    const fromSteam = profile?.infamy !== null && profile?.infamy !== undefined ? { infamy: profile.infamy } : {};
    const changes = restore(data, { steam: id, ...extraPrefs, ...fromSteam }, profile);
    return { changes };
  } catch (error) {
    if (errorEl) errorEl.textContent = error.message;
    else if (!quiet || navigator.onLine) notify(error.message);
    return false;
  } finally {
    fetching = false;
    if (button) { button.disabled = false; button.textContent = label; }
  }
}

async function refreshAndReport(button) {
  const result = await refreshFromSteam({ button });
  if (!result) return;
  const { unlocked, added, stillLocked } = result.changes;
  if (unlocked.length || added.length || stillLocked.length) showChanges(result.changes);
  else notify(`Up to date with Steam. ${plural(dataset.counts.locked, 'achievement')} left.`);
}

function resetEverything() {
  try { localStorage.removeItem(STORAGE_KEY); } catch { /* storage unavailable */ }
  dataset = null;
  items = [];
  state = { completed: {}, later: {}, notes: {}, prefs: cleanPrefs(DEFAULT_PREFS), rotation: 0, profile: null, plan: null };
  savedAt = null;
  backedUpAt = null;
  $('#landing-form').reset();
  setView('landing');
  notify('Everything on this browser has been removed.');
}

function openImport() {
  $('#import-file').value = '';
  $('#import-error').textContent = '';
  $('#import-dialog').showModal();
}

// ---------- events ----------

document.addEventListener('click', (e) => {
  const target = e.target.closest('[data-view],[data-detail],[data-swap],[data-run-done]');
  if (!target) return;
  if (target.dataset.view) {
    const hasFilters = target.dataset.status || target.dataset.heist !== undefined;
    setView(target.dataset.view, hasFilters ? { status: target.dataset.status, heist: target.dataset.heist } : undefined);
  } else if (target.dataset.detail) detail(target.dataset.detail);
  else if (target.dataset.swap) swap(Number(target.dataset.run), target.dataset.swap);
  else if (target.dataset.runDone !== undefined) toggleRun(Number(target.dataset.runDone));
});

document.addEventListener('change', (e) => {
  if (e.target.dataset.check) toggle(e.target.dataset.check, e.target.checked);
});

$('#go-vault').onclick = () => setView('vault');
$('#profile-button').onclick = () => setView('preferences');
$('#generate').onclick = regenerate;
$('#generate-again').onclick = regenerate;
$('#breakdown-toggle').onclick = () => { breakdownExpanded = !breakdownExpanded; renderBreakdown(); };
$('#copy-plan').onclick = () => copyOrDownload(planToText(state.plan, items, state, state.prefs), 'completion-job-session.txt', 'Session plan copied.');
$('#print-plan').onclick = () => window.print();

for (const id of ['search', 'heist-filter', 'status-filter', 'kind-filter', 'difficulty-filter', 'sort-filter', 'group-toggle', 'expand-toggle']) {
  $(`#${id}`).addEventListener(id === 'search' ? 'input' : 'change', () => { visible = PAGE_SIZE; renderVault(); });
}
$('#clear-filters').onclick = () => {
  $('#search').value = '';
  for (const [id, value] of [['heist-filter', ''], ['status-filter', 'remaining'], ['kind-filter', ''], ['difficulty-filter', ''], ['sort-filter', 'default']]) $(`#${id}`).value = value;
  visible = PAGE_SIZE;
  renderVault();
};
$('#load-more').onclick = () => { visible += PAGE_SIZE; renderVault(); };

for (const id of ['backup-side', 'export-backup', 'footer-export', 'import-backup-first']) $(`#${id}`).onclick = backup;
for (const id of ['import-open', 'import-settings']) $(`#${id}`).onclick = openImport;
$('#shortcuts-open').onclick = () => $('#shortcuts-dialog').showModal();

$('#preferences-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const form = e.target;
  state.prefs = cleanPrefs({ ...Object.fromEntries(new FormData(form)), variety: form.elements.variety.checked, infamyBreaks: form.elements.infamyBreaks.checked });
  state.plan = null;
  save();
  render();
  notify('Preferences saved. Your queue is updated.');
});

$('#how-open').onclick = () => $('#how-dialog').showModal();
$('#reset-data').onclick = () => {
  if (window.confirm('Remove your list, checkmarks, notes and preferences from this browser? Export a backup first if you want to keep them.')) resetEverything();
};
$('#sign-out').onclick = () => {
  const what = STEAM_PROXY_URL ? 'Your list can be fetched again from Steam, but checkmarks, notes and preferences on this browser will be removed.' : 'Your list, checkmarks, notes and preferences will be removed from this browser.';
  if (window.confirm(`Sign out? ${what} Export a backup first if you want to keep them.`)) {
    resetEverything();
    notify('Signed out. This browser has been cleared.');
  }
};
// FBI Files has no deep links, so hand over the Steam ID on the clipboard and open the Suspect Database.
$('#fbi-open').onclick = async () => {
  const url = steamProfileUrl(state.prefs.steam);
  if (!url) return;
  let copied = false;
  try { await navigator.clipboard.writeText(url); copied = true; } catch { /* clipboard blocked; the user can type it */ }
  window.open('https://fbi.paydaythegame.com/', '_blank', 'noopener');
  notify(copied ? 'Your Steam profile link is on the clipboard. Paste it into the Suspect Database search.' : 'Opened FBI Files. Paste your Steam profile link into the Suspect Database search.');
};

$('#import-file').onchange = async (e) => {
  const result = await importFile(e.target.files[0], $('#import-error'));
  if (!result) return;
  $('#import-dialog').close();
  setView('board');
  if (result.changes) showChanges(result.changes);
  else notify('Checklist imported and saved on this device.');
};
$('#refresh-steam').onclick = (e) => refreshAndReport(e.currentTarget);
$('#import-fetch').onclick = async (e) => {
  const result = await refreshFromSteam({ errorEl: $('#import-error'), button: e.currentTarget });
  if (!result) return;
  $('#import-dialog').close();
  setView('board');
  const { unlocked, added, stillLocked } = result.changes;
  if (unlocked.length || added.length || stillLocked.length) showChanges(result.changes);
  else notify(`Up to date with Steam. ${plural(dataset.counts.locked, 'achievement')} left.`);
};

// Landing: name and Steam ID are optional and saved along with the first import.
const landingPrefs = () => {
  const form = $('#landing-form');
  return { player: form.elements.player.value, steam: form.elements.steam.value };
};
$('#landing-form').addEventListener('submit', (e) => e.preventDefault());
$('#landing-fetch').onclick = async (e) => {
  const prefs = landingPrefs();
  const result = await refreshFromSteam({ steam: prefs.steam, extraPrefs: prefs, errorEl: $('#landing-error'), button: e.currentTarget });
  if (!result) return;
  setView('board');
  notify(state.prefs.player ? `Welcome, ${state.prefs.player}. Your board is ready.` : 'Your board is ready.');
};
$('#landing-file').onchange = async (e) => {
  if (await importFile(e.target.files[0], $('#landing-error'), landingPrefs())) {
    setView('board');
    notify(state.prefs.player ? `Welcome, ${state.prefs.player}. Your board is ready.` : 'Your board is ready.');
  }
  e.target.value = '';
};
const dropZone = $('#drop-zone');
for (const type of ['dragenter', 'dragover']) dropZone.addEventListener(type, (e) => { e.preventDefault(); dropZone.classList.add('active'); });
for (const type of ['dragleave', 'drop']) dropZone.addEventListener(type, () => dropZone.classList.remove('active'));
dropZone.addEventListener('drop', async (e) => {
  e.preventDefault();
  if (await importFile(e.dataTransfer.files[0], $('#landing-error'), landingPrefs())) {
    setView('board');
    notify(state.prefs.player ? `Welcome, ${state.prefs.player}. Your board is ready.` : 'Your board is ready.');
  }
});

for (const dialog of document.querySelectorAll('dialog')) {
  dialog.addEventListener('click', (e) => {
    if (e.target !== dialog) return;
    const rect = dialog.getBoundingClientRect();
    if (e.clientX < rect.left || e.clientX > rect.right || e.clientY < rect.top || e.clientY > rect.bottom) dialog.close();
  });
}

// Keyboard shortcuts
document.addEventListener('keydown', (e) => {
  if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return;
  const tag = e.target.tagName;
  if (['INPUT', 'TEXTAREA', 'SELECT'].includes(tag) || e.target.isContentEditable) return;
  if (document.querySelector('dialog[open]')) return;
  if (!dataset) return;
  const actions = {
    '1': () => setView('board'),
    '2': () => setView('vault'),
    '3': () => setView('preferences'),
    '/': () => { setView('vault'); $('#search').focus(); },
    'g': () => { setView('board'); regenerate(); },
    'r': () => { if (STEAM_PROXY_URL) refreshAndReport($('#refresh-steam')); },
    'b': backup,
    '?': () => $('#shortcuts-dialog').showModal(),
  };
  const action = actions[e.key];
  if (action) { e.preventDefault(); action(); }
});

// Installable app
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  installPrompt = e;
  $('#install-panel').hidden = false;
});
$('#install-button').onclick = async () => {
  if (!installPrompt) return;
  installPrompt.prompt();
  await installPrompt.userChoice;
  installPrompt = null;
  $('#install-panel').hidden = true;
};
window.addEventListener('appinstalled', () => { $('#install-panel').hidden = true; notify('Installed. The Completion Job is on your device.'); });

function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  if (location.protocol !== 'https:' && !['localhost', '127.0.0.1'].includes(location.hostname)) return;
  let hadController = Boolean(navigator.serviceWorker.controller);
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (hadController) notify('A new version is ready.', { label: 'Reload', onAction: () => location.reload() });
    hadController = true;
  });
  navigator.serviceWorker.register('./sw.js').catch(() => { /* offline support is optional */ });
}

// ---------- start ----------

function init() {
  for (const el of document.querySelectorAll('.proxy-only')) el.hidden = !STEAM_PROXY_URL;
  for (const el of document.querySelectorAll('.file-only')) el.hidden = Boolean(STEAM_PROXY_URL);
  // With a proxy the Steam ID is the way in, so the field is required and the file route folds away.
  $('#landing-form').elements.steam.required = Boolean(STEAM_PROXY_URL);
  $('#file-steps').open = !STEAM_PROXY_URL;
  let raw = null;
  try {
    raw = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
  } catch {
    notify('Saved browser data could not be read.');
  }
  if (raw?.dataset) {
    try {
      dataset = normalizeDataset(raw.dataset);
    } catch {
      dataset = null;
      notify('Saved achievement data was invalid, so it has been cleared. Import your list again.');
    }
  }
  if (dataset) {
    items = dataset.achievements;
    state = cleanState(raw, dataset);
    state.plan = restorePlan(raw?.plan, items, state, state.prefs);
    savedAt = typeof raw?.savedAt === 'string' ? raw.savedAt : null;
    backedUpAt = typeof raw?.backedUpAt === 'string' ? raw.backedUpAt : null;
    setView('board');
    render();
    // Steam is the source of truth: pull the current list on every open and only speak up when something changed.
    if (STEAM_PROXY_URL && state.prefs.steam && navigator.onLine) {
      refreshFromSteam({ quiet: true }).then((result) => {
        if (!result) return;
        const { unlocked, added } = result.changes;
        if (unlocked.length || added.length) showChanges(result.changes);
      });
    }
  } else {
    state = { completed: {}, later: {}, notes: {}, prefs: cleanPrefs({ ...DEFAULT_PREFS, ...raw?.prefs }), rotation: 0, profile: null, plan: null };
    setView('landing');
  }
  setInterval(renderSaveStatus, 60000);
  registerServiceWorker();
}

init();
