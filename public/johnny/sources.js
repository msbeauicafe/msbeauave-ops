// Johnny — the data layer for the "what's on and where to watch it" hub.
//
// This module knows two things and nothing else: how to ask ESPN's public
// scoreboard for a league's fixtures, and how to turn a broadcaster's name
// into a link to the place that is actually licensed to show the game. It
// holds no state and touches no DOM, so it can be reasoned about — and tested —
// on its own.
//
// Johnny does NOT restream anything. Every "Watch" link on this hub points at
// the official broadcaster or the league's own player. When we don't recognise
// a broadcaster, the link falls back to the league's official "ways to watch"
// page rather than guessing.

// ESPN exposes a public, read-only scoreboard per league. It answers with a
// permissive CORS header, so the browser can read it directly and this hub
// needs no server of its own. If that ever changes, `fetchLeague` fails softly
// (see johnny.js) and the affected card shows the official schedule link
// instead of breaking the page.
const ESPN = 'https://site.api.espn.com/apis/site/v2/sports';

// The four leagues Johnny follows, in the order they appear on the page. Each
// carries where to fetch it and where the league itself tells people to watch —
// the honest fallback when we can't name the exact broadcaster.
export const LEAGUES = [
  {
    key: 'nba',
    label: 'NBA',
    sport: 'Basketball',
    path: `${ESPN}/basketball/nba/scoreboard`,
    officialWatch: 'https://www.nba.com/watch',
    officialSchedule: 'https://www.nba.com/schedule',
  },
  {
    key: 'nfl',
    label: 'NFL',
    sport: 'Football',
    path: `${ESPN}/football/nfl/scoreboard`,
    officialWatch: 'https://www.nfl.com/ways-to-watch/',
    officialSchedule: 'https://www.nfl.com/schedules/',
  },
  {
    key: 'ufc',
    label: 'UFC',
    sport: 'MMA',
    path: `${ESPN}/mma/ufc/scoreboard`,
    officialWatch: 'https://www.ufc.com/how-to-watch',
    officialSchedule: 'https://www.ufc.com/events',
  },
  // Tennis lives under two tours; Johnny asks for both and merges them so the
  // card reads "Tennis" rather than making the viewer care which tour it is.
  {
    key: 'tennis',
    label: 'Tennis',
    sport: 'Tennis',
    path: [`${ESPN}/tennis/atp/scoreboard`, `${ESPN}/tennis/wta/scoreboard`],
    officialWatch: 'https://www.tennischannel.com/en-us/page/watch',
    officialSchedule: 'https://www.atptour.com/en/scores/current',
  },
];

export const leagueByKey = (key) => LEAGUES.find((l) => l.key === key);

// The map from a broadcaster's on-air name to the page that is licensed to
// stream it. Matched case-insensitively as a substring, so "ESPN2" and
// "ESPN Deportes" both find "espn" unless a more specific rule matches first.
// Order matters: the most specific names come first.
const BROADCASTERS = [
  ['espn+', 'https://plus.espn.com'],
  ['espn deportes', 'https://www.espn.com/deportes/watch/'],
  ['espn', 'https://www.espn.com/watch/'],
  ['abc', 'https://www.abc.com/watch-live/'],
  ['nba tv', 'https://www.nba.com/watch'],
  ['nba league pass', 'https://www.nba.com/watch'],
  ['nfl network', 'https://www.nfl.com/network/watch/nfl-network-live'],
  ['nfl+', 'https://www.nfl.com/plus/'],
  ['peacock', 'https://www.peacocktv.com/sports'],
  ['nbc', 'https://www.nbcsports.com/live'],
  ['prime video', 'https://www.amazon.com/gp/video/watchlive'],
  ['amazon', 'https://www.amazon.com/gp/video/watchlive'],
  ['paramount+', 'https://www.paramountplus.com/live-tv/'],
  ['cbs', 'https://www.cbssports.com/watch/'],
  ['fs1', 'https://www.foxsports.com/live'],
  ['fs2', 'https://www.foxsports.com/live'],
  ['fox', 'https://www.foxsports.com/live'],
  ['tnt', 'https://www.max.com/'],
  ['tbs', 'https://www.max.com/'],
  ['trutv', 'https://www.max.com/'],
  ['max', 'https://www.max.com/'],
  ['tennis channel', 'https://www.tennischannel.com/en-us/page/watch'],
];

/**
 * A licensed link for a named broadcaster, or null when the name isn't one we
 * recognise. The caller decides what to do with a null — Johnny falls back to
 * the league's official "ways to watch" page, never to an unofficial source.
 */
export function broadcasterLink(name) {
  const hay = String(name || '').toLowerCase();
  if (!hay.trim()) return null;
  const hit = BROADCASTERS.find(([needle]) => hay.includes(needle));
  return hit ? hit[1] : null;
}

// ---------------------------------------------------------------------------
// Normalising ESPN's answer
//
// The three sports don't describe an event the same way — a basketball game has
// two teams and a score, a fight card has a headline bout, a tennis fixture has
// two players. These helpers read each shape defensively (every field optional)
// and hand back one flat event the view can render without knowing the sport.
// ---------------------------------------------------------------------------

const state = (comp) => {
  const t = comp?.status?.type || {};
  // ESPN's state is 'pre' (upcoming), 'in' (live) or 'post' (finished).
  if (t.state === 'in') return 'live';
  if (t.state === 'post' || t.completed) return 'final';
  return 'upcoming';
};

const competitors = (comp) =>
  (comp?.competitors || []).map((c) => ({
    name: c?.team?.displayName || c?.athlete?.displayName || c?.team?.name || c?.name || '—',
    short: c?.team?.abbreviation || c?.athlete?.shortName || c?.team?.shortDisplayName || '',
    score: c?.score ?? null,
    winner: c?.winner === true,
    home: c?.homeAway === 'home',
  }));

// Broadcasters can arrive under `broadcasts[].names`, `broadcasts[].media`, or
// the geo-scoped `geoBroadcasts[].media.shortName`. Collect all of them, drop
// blanks and duplicates, keep the order they were listed in.
const broadcasters = (comp) => {
  const out = [];
  const push = (v) => { const s = String(v || '').trim(); if (s) out.push(s); };
  (comp?.broadcasts || []).forEach((b) => {
    (b?.names || []).forEach(push);
    push(b?.media?.shortName);
    push(b?.shortName);
  });
  (comp?.geoBroadcasts || []).forEach((b) => {
    push(b?.media?.shortName);
    push(b?.media?.callLetters);
  });
  return [...new Set(out)];
};

function normalise(event, league) {
  const comp = (event?.competitions || [])[0] || {};
  return {
    id: String(event?.id || comp?.id || `${league.key}-${event?.date || Math.random()}`),
    league: league.key,
    leagueLabel: league.label,
    sport: league.sport,
    name: event?.name || comp?.name || league.label,
    shortName: event?.shortName || '',
    start: event?.date || comp?.date || null,
    state: state(comp),
    statusDetail: comp?.status?.type?.shortDetail || comp?.status?.type?.detail || '',
    competitors: competitors(comp),
    broadcasters: broadcasters(comp),
    venue: comp?.venue?.fullName || event?.venue?.fullName || '',
    note: (comp?.notes || [])[0]?.headline || '',
  };
}

/**
 * Fetch and normalise one league's fixtures. Resolves to an array of flat
 * events (possibly empty on a quiet day). Rejects only on a network or CORS
 * failure, which the caller turns into a per-card error state — one broken feed
 * never takes the others down.
 *
 * `signal` lets a refresh abort an in-flight request the viewer has moved past.
 */
export async function fetchLeague(league, { signal } = {}) {
  const paths = Array.isArray(league.path) ? league.path : [league.path];

  const perPath = await Promise.all(paths.map(async (url) => {
    const res = await fetch(url, { signal, headers: { Accept: 'application/json' } });
    if (!res.ok) throw new Error(`${league.label} feed returned ${res.status}`);
    const data = await res.json();
    return (data?.events || []).map((e) => normalise(e, league));
  }));

  // Merge the tours (tennis) or pass the single list straight through, then put
  // live games first, upcoming next, finished last — and within each, by time.
  const rank = { live: 0, upcoming: 1, final: 2 };
  return perPath.flat().sort((a, b) => {
    if (rank[a.state] !== rank[b.state]) return rank[a.state] - rank[b.state];
    return new Date(a.start || 0) - new Date(b.start || 0);
  });
}
