// The door agent.
//
// Runs on the PC at one shop door. Holds the scanner, holds that shop's
// templates in memory, and answers the clock page on localhost. It decides
// nothing about attendance: it says "this is who the finger belongs to" and
// the website decides whether to believe it.
import http from 'node:http';
import fs from 'node:fs';
import * as sdk from './sdk.js';

const conf = JSON.parse(fs.readFileSync(new URL('./door.json', import.meta.url), 'utf8'));
const PORT = Number(conf.port || 9500);
const REFRESH_MS = Number(conf.refreshMinutes || 10) * 60_000;

let cookie = '';
let people = [];
let lastError = null;
let lastLoad = null;

const say = (...a) => console.log(new Date().toLocaleTimeString('en-GB'), ...a);

async function call(method, path, body) {
  const res = await fetch(conf.site + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const raw = res.headers.getSetCookie?.()[0] ?? res.headers.get('set-cookie');
  if (raw) cookie = raw.split(';')[0];
  return { status: res.status, data: await res.json().catch(() => ({})) };
}

async function signIn() {
  const r = await call('POST', '/api/login',
    { username: conf.username, password: conf.password });
  if (r.status !== 200) {
    throw new Error(`The door could not sign in: ${r.data.error || r.status}. `
      + 'Check the Timekeeper username and code in door.json.');
  }
}

/**
 * Fetch this shop's templates and hand them to the matcher.
 *
 * Re-fetched on a timer rather than cached to disk. Somebody enrolled this
 * morning should be able to clock on this afternoon without anybody visiting
 * the shop, and a machine that is switched off should be carrying nothing.
 */
async function refresh() {
  try {
    let r = await call('GET', `/api/clock/fingers?shop=${conf.shop}`);
    if (r.status === 401) { await signIn(); r = await call('GET', `/api/clock/fingers?shop=${conf.shop}`); }
    if (r.status !== 200) throw new Error(r.data.error || `HTTP ${r.status}`);
    people = r.data.people;
    await sdk.load(people);
    lastLoad = new Date();
    lastError = null;
    say(`holding ${people.length} finger(s) for shop ${conf.shop}`);
  } catch (e) {
    // Keep serving whatever is already loaded. A shop whose internet is down
    // should still be able to clock people in and out.
    lastError = e.message;
    say('could not refresh:', e.message,
      people.length ? `— still holding ${people.length}` : '— holding nothing');
  }
}

/** Tell the website who the door recognised, and let it decide. */
async function clock(id) {
  let r = await call('POST', '/api/clock/by-finger',
    { employeeId: id, branch_id: conf.shop });
  if (r.status === 401) {
    await signIn();
    r = await call('POST', '/api/clock/by-finger', { employeeId: id, branch_id: conf.shop });
  }
  return r;
}

// ---------------------------------------------------------------------------
// The loop: watch for a finger, match it, clock it, remember it briefly so the
// page can pick it up.
// ---------------------------------------------------------------------------
let latest = null;
let enrolling = false;   // the enrolment desk and the door share one scanner

async function watch() {
  for (;;) {
    try {
      if (enrolling) { await new Promise((r) => setTimeout(r, 300)); continue; }
      const scan = await sdk.capture(3000);
      if (!scan) continue;

      const hit = await sdk.identify(scan.template);
      if (!hit) {
        // Deliberately vague, and deliberately the same answer as an unknown
        // finger: a screen by the door is not a place to learn who is on file.
        latest = { at: Date.now(), ok: false, say: 'That finger was not recognised.' };
        continue;
      }

      const who = people.find((p) => p.id === hit.id);
      const done = await clock(hit.id);
      latest = done.status === 200
        ? { at: Date.now(), ok: true, person: who?.name || null, result: done.data }
        : { at: Date.now(), ok: false, say: done.data.error || 'That did not work.' };
      say(latest.ok ? `${who?.name || hit.id} — ${latest.result?.action || 'clocked'}`
        : `refused: ${latest.say}`);
    } catch (e) {
      lastError = e.message;
      say('scanner:', e.message);
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
}

// ---------------------------------------------------------------------------
// The localhost surface the clock page talks to.
//
// Loopback only — it binds 127.0.0.1, so nothing on the shop's network can
// reach it even by accident.
// ---------------------------------------------------------------------------
const server = http.createServer((req, res) => {
  // The page is served from https://msbeauave-ops.vercel.app and this is a
  // different origin, so it needs saying explicitly. Only that one site.
  res.setHeader('Access-Control-Allow-Origin', conf.site);
  res.setHeader('Access-Control-Allow-Private-Network', 'true');
  res.setHeader('Vary', 'Origin');
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.writeHead(204).end();
    return;
  }

  const url = new URL(req.url, 'http://127.0.0.1');
  res.setHeader('Content-Type', 'application/json');

  if (url.pathname === '/hello') {
    // What the clock page asks on load to find out whether this door has a
    // scanner at all. Says nothing about who is enrolled.
    res.end(JSON.stringify({
      agent: 'msbeauave-door', shop: Number(conf.shop),
      scanner: sdk.ready(), holding: sdk.holding(),
      lastLoad, error: lastError,
    }));
    return;
  }

  if (url.pathname === '/capture') {
    // Enrolling. The office PC has a scanner too, and this is how the Team
    // screen gets a template out of it. It hands back the template and
    // nothing else — the website decides whose finger it is, because the
    // agent has no business knowing who is being enrolled.
    if (!sdk.ready()) {
      res.writeHead(503).end(JSON.stringify({ error: 'No scanner on this machine.' }));
      return;
    }
    enrolling = true;
    (async () => {
      try {
        for (let tries = 0; tries < 40; tries++) {
          const scan = await sdk.capture(3000);
          if (scan) {
            res.end(JSON.stringify({
              template: scan.template.toString('base64'), quality: scan.quality,
            }));
            return;
          }
        }
        res.end(JSON.stringify({ error: 'No finger was presented.' }));
      } catch (e) {
        res.writeHead(500).end(JSON.stringify({ error: e.message }));
      } finally { enrolling = false; }
    })();
    return;
  }

  if (url.pathname === '/latest') {
    // The page polls this. An answer is handed over once and then forgotten,
    // so a reload cannot replay somebody else's clock-in.
    const out = latest && Date.now() - latest.at < 15_000 ? latest : null;
    latest = null;
    res.end(JSON.stringify(out || {}));
    return;
  }

  res.writeHead(404).end(JSON.stringify({ error: 'No such thing here.' }));
});

say(`MS BEAU AVE door agent — shop ${conf.shop}, ${conf.site}`);
try {
  say('scanner:', await sdk.open());
} catch (e) {
  // Not fatal. The clock page falls back to PINs, and the shop keeps working
  // while somebody sorts the driver out.
  lastError = e.message;
  say('scanner:', e.message);
}
await signIn();
await refresh();
setInterval(refresh, REFRESH_MS);
if (sdk.ready()) watch();
server.listen(PORT, '127.0.0.1', () => say(`listening on http://127.0.0.1:${PORT}`));
