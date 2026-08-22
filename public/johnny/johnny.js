// Johnny — the schedule hub.
//
// One page that answers "what's on, and where can I legally watch it?" for the
// NBA, the NFL, the UFC and tennis. It reads ESPN's public scoreboard for each
// league (see sources.js), shows the fixtures, and links every game to the
// broadcaster that actually holds the rights — never to a restream.
//
// The whole page is driven from one `state` object. Nothing renders straight
// from a fetch; a fetch only updates state, and `render()` draws whatever state
// currently says. That keeps the four leagues, their loading and their errors
// from fighting each other for the DOM.

import { LEAGUES, leagueByKey, broadcasterLink, fetchLeague } from './sources.js';

const $ = (sel, root = document) => root.querySelector(sel);

const esc = (s) => String(s ?? '').replace(/[&<>"']/g,
  (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// The viewer's own clock, labelled, so nobody has to convert a kick-off in
// their head. `toLocale*` with no timezone uses the device's zone.
const tzLabel = (() => {
  try { return new Intl.DateTimeFormat().resolvedOptions().timeZone || 'local time'; }
  catch { return 'local time'; }
})();

const when = (iso) => {
  if (!iso) return { day: 'TBD', time: '' };
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return { day: 'TBD', time: '' };
  return {
    day: d.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' }),
    time: d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }),
  };
};

// How often to re-check while something is live. Quiet enough to be polite to
// ESPN, often enough that a score on screen isn't embarrassingly stale.
const LIVE_REFRESH_MS = 60_000;

// ---------------------------------------------------------------------------
// State
//
// `tab` is which league filter is showing ('all' or a league key). Each league
// carries its own request status so one slow or broken feed shows a spinner or
// an error on its own card while the rest of the page is already usable.
// ---------------------------------------------------------------------------
const state = {
  tab: 'all',
  leagues: Object.fromEntries(
    LEAGUES.map((l) => [l.key, { status: 'idle', events: [], error: null }])),
  lastUpdated: null,
};

let inFlight = null;   // AbortController for the current refresh, if any
let timer = null;

// ---------------------------------------------------------------------------
// Loading the data
// ---------------------------------------------------------------------------
async function loadAll() {
  // A new refresh cancels the one before it, so a slow feed from a moment ago
  // can't land on top of fresher data.
  inFlight?.abort();
  inFlight = new AbortController();
  const { signal } = inFlight;

  LEAGUES.forEach((l) => {
    if (state.leagues[l.key].status !== 'ready') state.leagues[l.key].status = 'loading';
  });
  render();

  await Promise.all(LEAGUES.map(async (league) => {
    const slot = state.leagues[league.key];
    try {
      slot.events = await fetchLeague(league, { signal });
      slot.status = 'ready';
      slot.error = null;
    } catch (e) {
      if (e.name === 'AbortError') return;    // superseded; leave state alone
      slot.status = 'error';
      slot.error = e.message || 'Could not reach the schedule.';
    }
  }));

  state.lastUpdated = new Date();
  render();
  scheduleLiveRefresh();
}

// Only keep polling while at least one game is actually live. A page full of
// tomorrow's fixtures doesn't need a heartbeat.
function scheduleLiveRefresh() {
  clearTimeout(timer);
  const anyLive = Object.values(state.leagues)
    .some((s) => s.events.some((e) => e.state === 'live'));
  if (anyLive) timer = setTimeout(loadAll, LIVE_REFRESH_MS);
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------
const app = $('#app');

function render() {
  const leagues = state.tab === 'all' ? LEAGUES : LEAGUES.filter((l) => l.key === state.tab);
  app.innerHTML = `
    ${header()}
    ${tabs()}
    <main class="feed">
      ${leagues.map(section).join('')}
    </main>
    ${footer()}
  `;
}

function header() {
  const stamp = state.lastUpdated
    ? `Updated ${state.lastUpdated.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`
    : 'Loading…';
  return `
    <header class="top">
      <div class="brand">
        <span class="dot" aria-hidden="true"></span>
        <h1>Johnny</h1>
      </div>
      <p class="tagline">Live sport — and where to watch it, officially.</p>
      <div class="meta">
        <span class="stamp">${esc(stamp)}</span>
        <button class="refresh" type="button" data-refresh aria-label="Refresh">↻</button>
      </div>
    </header>`;
}

function tabs() {
  const items = [{ key: 'all', label: 'All' }, ...LEAGUES];
  return `
    <nav class="tabs" role="tablist">
      ${items.map((t) => `
        <button class="tab ${state.tab === t.key ? 'on' : ''}" role="tab"
          aria-selected="${state.tab === t.key}" data-tab="${t.key}">${esc(t.label)}</button>
      `).join('')}
    </nav>`;
}

function section(league) {
  const slot = state.leagues[league.key];
  return `
    <section class="league">
      <div class="league-head">
        <h2>${esc(league.label)} <span class="sport">${esc(league.sport)}</span></h2>
        <a class="watch-home" href="${esc(league.officialWatch)}" target="_blank"
           rel="noopener noreferrer">Ways to watch ↗</a>
      </div>
      ${body(league, slot)}
    </section>`;
}

function body(league, slot) {
  if (slot.status === 'loading' || slot.status === 'idle') {
    return `<div class="skeletons">${'<div class="skeleton"></div>'.repeat(3)}</div>`;
  }
  if (slot.status === 'error') {
    // A broken feed is a dead end for the data, not for the viewer: send them
    // straight to the league's own schedule.
    return `
      <div class="notice error">
        <p>Couldn't load the ${esc(league.label)} schedule right now.</p>
        <p class="small">${esc(slot.error)}</p>
        <a class="btn" href="${esc(league.officialSchedule)}" target="_blank"
           rel="noopener noreferrer">Open the official ${esc(league.label)} schedule ↗</a>
      </div>`;
  }
  if (!slot.events.length) {
    return `
      <div class="notice">
        <p>No ${esc(league.label)} fixtures on the board right now.</p>
        <a class="btn ghost" href="${esc(league.officialSchedule)}" target="_blank"
           rel="noopener noreferrer">See the full schedule ↗</a>
      </div>`;
  }
  return `<ul class="games">${slot.events.map(game).join('')}</ul>`;
}

function game(ev) {
  const t = when(ev.start);
  const badge = ev.state === 'live'
    ? `<span class="badge live">● Live${ev.statusDetail ? ' · ' + esc(ev.statusDetail) : ''}</span>`
    : ev.state === 'final'
      ? `<span class="badge final">Final</span>`
      : `<span class="badge soon">${esc(t.day)} · ${esc(t.time)}</span>`;

  return `
    <li class="game ${ev.state}">
      <div class="game-main">
        <div class="teams">${teams(ev)}</div>
        ${ev.venue ? `<p class="venue">${esc(ev.venue)}</p>` : ''}
        ${ev.note ? `<p class="note">${esc(ev.note)}</p>` : ''}
      </div>
      <div class="game-side">
        ${badge}
        ${watch(ev)}
      </div>
    </li>`;
}

function teams(ev) {
  // A two-sided game shows both sides and, once it's live or done, the score.
  // A card or a fixture we couldn't split into two just shows its name.
  if (ev.competitors.length >= 2) {
    const showScore = ev.state !== 'upcoming';
    return ev.competitors.slice(0, 2).map((c) => `
      <div class="team ${c.winner ? 'won' : ''}">
        <span class="team-name">${esc(c.name)}</span>
        ${showScore && c.score != null ? `<span class="score">${esc(c.score)}</span>` : ''}
      </div>`).join('');
  }
  return `<div class="team single"><span class="team-name">${esc(ev.name)}</span></div>`;
}

// The point of the whole hub: a link to somewhere licensed. Prefer the named
// broadcaster; fall back to the league's official player when we don't know the
// name. Never a third-party stream.
function watch(ev) {
  const league = leagueByKey(ev.league);
  const named = ev.broadcasters
    .map((name) => ({ name, url: broadcasterLink(name) }))
    .filter((b) => b.url);

  if (named.length) {
    // De-duplicate by destination so "ESPN" and "ESPN2" don't make two buttons
    // to the same page.
    const seen = new Set();
    const links = named.filter((b) => !seen.has(b.url) && seen.add(b.url));
    return `
      <div class="watch">
        ${links.map((b) => `
          <a class="btn watch-btn" href="${esc(b.url)}" target="_blank"
             rel="noopener noreferrer">Watch on ${esc(b.name)} ↗</a>`).join('')}
      </div>`;
  }

  // No broadcaster named yet (common for events still days out) — point at the
  // league's own "ways to watch". If ESPN listed a name we simply don't map,
  // show it as a hint so nobody thinks the game is unavailable.
  const hint = ev.broadcasters[0]
    ? `<span class="tv-hint">On ${esc(ev.broadcasters[0])}</span>` : '';
  return `
    <div class="watch">
      ${hint}
      <a class="btn ghost watch-btn" href="${esc(league.officialWatch)}" target="_blank"
         rel="noopener noreferrer">Where to watch ↗</a>
    </div>`;
}

function footer() {
  return `
    <footer class="foot">
      <a class="fb" href="https://www.facebook.com/jojo.white.568" target="_blank"
         rel="noopener noreferrer">Follow Johnny on Facebook ↗</a>
      <p class="disclaimer">
        Johnny links to official broadcasters only. Schedules and rights holders
        come from ESPN's public data and can change — always confirm on the
        broadcaster's own page. Times shown in ${esc(tzLabel)}.
      </p>
    </footer>`;
}

// ---------------------------------------------------------------------------
// Events — one delegated listener, since the DOM is rebuilt on every render.
// ---------------------------------------------------------------------------
app.addEventListener('click', (e) => {
  const tab = e.target.closest('[data-tab]');
  if (tab) { state.tab = tab.dataset.tab; render(); return; }
  if (e.target.closest('[data-refresh]')) { loadAll(); }
});

// Coming back to the tab after a while shows fresh fixtures without a manual
// tap; guarded so we don't hammer the feed on every little focus change.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') return;
  const stale = !state.lastUpdated || (Date.now() - state.lastUpdated.getTime() > LIVE_REFRESH_MS);
  if (stale) loadAll();
});

render();     // paint the skeletons immediately
loadAll();
