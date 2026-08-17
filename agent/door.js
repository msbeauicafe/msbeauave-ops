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

// Everything this says also goes to door-log.txt beside the program.
//
// A window that closes takes its reason with it, and the reason is the only
// thing worth having when somebody is setting a door up for the first time in
// a shop with the internet playing up. A file can be sent to somebody. A
// window that flashed cannot.
const LOG = new URL('./door-log.txt', import.meta.url);
const say = (...a) => {
  const line = [new Date().toLocaleTimeString('en-GB'), ...a].join(' ');
  console.log(line);
  try { fs.appendFileSync(LOG, line + '\n'); } catch { /* the log is a nicety */ }
};

// Anything that kills the program outright says so on the way out, rather than
// leaving a closed window and no explanation.
process.on('uncaughtException', (e) => {
  say('STOPPED:', e && e.message ? e.message : String(e));
  say(e && e.stack ? e.stack : '');
  process.exit(1);
});
process.on('unhandledRejection', (e) => {
  say('STOPPED:', e && e.message ? e.message : String(e));
  process.exit(1);
});

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
// Who may talk to this agent: our own site, and the machine it runs on.
//
// Pinning it to conf.site alone was too tight — a preview build, or the clock
// opened from a local copy while somebody is setting the door up, is the same
// person at the same machine and gets refused for no good reason. Loopback is
// allowed because anything running there is already inside the box.
const site = String(conf.site || '').replace(/\/$/, '');
const allowed = (origin) => {
  if (!origin) return site;
  if (origin === site) return origin;
  if (/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(origin)) return origin;
  return site;
};

const server = http.createServer((req, res) => {
  // The page is served over https and this is plain http on loopback, so it is
  // a different origin whatever happens and the permission has to be explicit.
  res.setHeader('Access-Control-Allow-Origin', allowed(req.headers.origin));
  res.setHeader('Access-Control-Allow-Private-Network', 'true');
  res.setHeader('Vary', 'Origin');
  if (req.method === 'OPTIONS') {
    // Chrome asks permission before letting a page on the public internet talk
    // to something on the machine itself, and it wants the answer spelled out
    // rather than implied.
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Max-Age', '600');
    res.writeHead(204).end();
    return;
  }

  const url = new URL(req.url, 'http://127.0.0.1');
  const json = (o) => {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(o));
  };

  if (url.pathname === '/hello') {
    // What the clock page asks on load to find out whether this door has a
    // scanner at all. Says nothing about who is enrolled.
    json({
      agent: 'msbeauave-door', shop: Number(conf.shop),
      scanner: sdk.ready(), holding: sdk.holding(),
      lastLoad, error: lastError,
    });
    return;
  }

  if (url.pathname === '/capture') {
    // Enrolling. The office PC has a scanner too, and this is how the Team
    // screen gets a template out of it. It hands back the template and
    // nothing else — the website decides whose finger it is, because the
    // agent has no business knowing who is being enrolled.
    if (!sdk.ready()) {
      res.setHeader('Content-Type', 'application/json');
      res.writeHead(503).end(JSON.stringify({ error: 'No scanner on this machine.' }));
      return;
    }
    enrolling = true;
    (async () => {
      try {
        // Three scans of the one finger, merged. The steps go to the log so
        // whoever is enrolling can be told when to lift and press again.
        const made = await sdk.enrol((step) => say(`enrol: scan ${step} of 3`));
        json({ template: made.template.toString('base64'), quality: made.quality });
        // The website saves this a moment from now, and the door has no way of
        // hearing about it. Waiting out the ten-minute refresh to find out
        // whether an enrolment took is a miserable way to set fifty people up,
        // so ask again shortly, and once more in case the first was too quick.
        setTimeout(() => refresh().catch(() => {}), 3000);
        setTimeout(() => refresh().catch(() => {}), 15000);
      } catch (e) {
        res.setHeader('Content-Type', 'application/json');
        res.writeHead(400).end(JSON.stringify({ error: e.message }));
      } finally { enrolling = false; }
    })();
    return;
  }

  if (url.pathname === '/latest') {
    // The page polls this. An answer is handed over once and then forgotten,
    // so a reload cannot replay somebody else's clock-in.
    const out = latest && Date.now() - latest.at < 15_000 ? latest : null;
    latest = null;
    json(out || {});
    return;
  }

  // ---------------------------------------------------------------------
  // Everything else: the clock page itself, and the website behind it.
  //
  // This exists because of a rule browsers are right to have. A page served
  // from the public internet is not allowed to reach into the machine it is
  // displayed on — otherwise any website could go looking for what is
  // listening on your own PC. Chrome enforces it, and a shop counter is the
  // last place to be turning that protection off in a settings screen.
  //
  // So the door stops being something the website reaches into, and becomes
  // where the clock is served from. Open http://127.0.0.1:9500/ and the page,
  // the scanner and the data all come from one address. There is no line for
  // the browser to refuse to cross.
  //
  // The website still holds everything; this only passes it through, using
  // the door's own sign-in. Which is also why it listens on loopback alone:
  // it is the tablet's session, and it never leaves the machine.
  // ---------------------------------------------------------------------
  proxy(req, res, url).catch((e) => {
    if (!res.headersSent) res.writeHead(502);
    res.end(JSON.stringify({ error: `The website could not be reached: ${e.message}` }));
  });
});

async function proxy(req, res, url) {
  // A door belongs to one shop, and the page decides which from its own
  // address. Sending the browser to /?shop=N once means the tablet at this
  // door shows this door's faces and cannot be talked out of it.
  if (url.pathname === '/' && !url.searchParams.get('shop')) {
    res.writeHead(302, { Location: `/?shop=${Number(conf.shop)}` }).end();
    return;
  }

  const path = url.pathname === '/' ? '/clock/' : url.pathname;
  const target = conf.site + path + (url.search || '');

  const body = ['GET', 'HEAD'].includes(req.method)
    ? undefined
    : await new Promise((done) => {
        const parts = [];
        req.on('data', (c) => parts.push(c));
        req.on('end', () => done(Buffer.concat(parts)));
      });

  const send = () => fetch(target, {
    method: req.method,
    headers: {
      ...(req.headers['content-type'] ? { 'Content-Type': req.headers['content-type'] } : {}),
      ...(cookie ? { Cookie: cookie } : {}),
    },
    body,
    redirect: 'follow',
  });

  let out = await send();
  // The door's session is what the page borrows, so the door renews it.
  if (out.status === 401) { await signIn(); out = await send(); }

  const type = out.headers.get('content-type');
  res.writeHead(out.status, {
    ...(type ? { 'Content-Type': type } : {}),
    // The page is the door's own now; nothing here should be held on to.
    'Cache-Control': 'no-store',
  });
  res.end(Buffer.from(await out.arrayBuffer()));
}

say(`MS BEAU AVE door agent — shop ${conf.shop}, ${conf.site}`);
try {
  say('scanner:', await sdk.open(conf));
} catch (e) {
  // Not fatal. The clock page falls back to PINs, and the shop keeps working
  // while somebody sorts the driver out.
  lastError = e.message;
  say('scanner:', e.message);
}
// Start listening first, and sign in afterwards.
//
// The old order killed the agent outright if the website could not be reached
// — which is exactly when somebody is standing at the door wanting to know
// why. Now it comes up regardless, serves /hello with the reason in it, and
// keeps retrying in the background.
server.listen(PORT, '127.0.0.1', () => say(`listening on http://127.0.0.1:${PORT}`));

try {
  await signIn();
  await refresh();
} catch (e) {
  lastError = e.message;
  say(e.message);
  say('will keep trying — the clock page will show this until it works');
}
setInterval(async () => {
  try {
    if (lastError) await signIn();
    await refresh();
  } catch (e) { lastError = e.message; }
}, REFRESH_MS);
if (sdk.ready()) watch();
