// The door agent.
//
// Runs on the PC at one shop door. Holds the scanner, holds that shop's
// templates in memory, and answers the clock page on localhost. It decides
// nothing about attendance: it says "this is who the finger belongs to" and
// the website decides whether to believe it.
import http from 'node:http';
import fs from 'node:fs';
import * as sdk from './sdk.js';

/**
 * The door's own settings: which shop it is, and how to sign in.
 *
 * Written by SETUP.bat, and the first thing a fresh install trips over if that
 * was skipped. Node's own answer is a stack trace naming a file the person has
 * never heard of, on a PC by a shop door — nothing anybody can act on. So the
 * one likely reason gets said out loud instead.
 */
function settings() {
  const path = new URL('./door.json', import.meta.url);
  let raw;
  try {
    raw = fs.readFileSync(path, 'utf8');
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
    console.log(`
  This PC has not been set up yet.

  Right-click SETUP.bat and choose "Run as administrator", then answer:

      What is this computer?    2   the door at Bayan Bayanan
                                3   the door at Beauty Obsession Ave
                                1   the office PC that enrols fingers

  That writes door.json beside this program and starts everything by itself.
  Nothing else in this folder needs touching.
`);
    process.exit(1);
  }
  try {
    return JSON.parse(raw);
  } catch {
    console.log(`
  door.json is here but cannot be read — something has damaged it.

  Delete it and run SETUP.bat again; it will write a fresh one.
`);
    process.exit(1);
  }
}

const conf = settings();
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
      agent: 'msbeauave-door', shop: Number(conf.shop), desk: DESK,
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
    if (res.headersSent) return res.end();
    say('proxy failed:', req.method, url.pathname, '-', e.message);
    // A person asked for a page; give them a page. The raw JSON that used to
    // come back here said "fetch failed" and nothing else, to somebody standing
    // at a door wondering whether the shop's system had died.
    if ((req.headers.accept || '').includes('text/html')) {
      res.writeHead(502, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(offlinePage(e.message));
      return;
    }
    res.writeHead(502, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: `The website could not be reached: ${e.message}` }));
  });
});

// What this machine cannot do, and what still works anyway.
//
// The door holds the scanner and this shop's templates; the website holds
// everything else. When the line between them goes down the honest thing is to
// say which half is missing, rather than to look broken all over.
const offlinePage = (why) => `<!doctype html><meta charset="utf-8">
<title>MS BEAU AVE — no line to the website</title>
<style>
 body{font:16px/1.6 Inter,system-ui,sans-serif;background:#FBF6F8;color:#45303C;margin:0}
 .w{max-width:560px;margin:0 auto;padding:56px 22px}
 h1{font-family:Georgia,serif;color:#A2647E;font-size:23px;letter-spacing:.04em;margin:0 0 6px}
 .s{color:#92707F;font-size:14px;margin-bottom:24px}
 .c{background:#fff;border:1px solid #EFCCDA;border-radius:13px;padding:18px 22px;margin-bottom:13px}
 a.btn{display:inline-block;background:#C98DA4;color:#fff;text-decoration:none;
   border-radius:9px;padding:10px 19px;font-weight:700;font-size:.94rem}
 code{background:#F9E9F0;border-radius:5px;padding:1px 7px;color:#A2647E;font-size:.9em}
 ul{padding-left:1.15rem;margin:8px 0} li{margin-bottom:5px}
 .q{color:#92707F;font-size:13px;margin-top:22px}
</style>
<div class="w">
<h1>This PC cannot reach the website</h1>
<div class="s">The door agent is running. The line out to
  ${conf.site.replace(/^https?:\/\//, '')} is what is down.</div>

<div class="c"><b>The back office does not need this PC.</b> It is on the
  internet, not on this machine &mdash; open it directly and it works from any
  device that has a connection.
  <div style="margin-top:13px"><a class="btn" href="${conf.site}">Open the back office</a></div>
  <div class="q">Going through <code>127.0.0.1:9500/office</code> is only needed
    for <b>enrolling a fingerprint</b>, because that has to reach the scanner
    plugged into this PC.</div></div>

<div class="c"><b>Worth checking, in this order:</b>
  <ul>
    <li>Is anything else online on this PC? Open any website.</li>
    <li>Wi-Fi dropped, or the cable knocked out.</li>
    <li>Waking from sleep &mdash; give it a few seconds and reload.</li>
  </ul>
  It retries by itself. Reload once the PC is back online; nothing needs
  restarting.</div>

<div class="c"><b>The clock keeps working on PINs.</b> Not from this screen
  &mdash; this one needs the website too &mdash; but the tablet apps at the
  doors have their own connection, and nobody's hours are lost.</div>

<div class="q">What went wrong, in full: <code>${String(why).replace(/[<&]/g, '')}</code>
  <br>Everything the agent has said today is in <code>door-log.txt</code>, beside the program.</div>
</div>`;

/**
 * One fetch, with a second and third go at it if the line blinks.
 *
 * Shop wifi drops a request now and then, and a PC waking from sleep drops
 * every request for a second or two. Without this, one blink put an error on
 * the screen and the person in front of it had no way to tell that from the
 * system being down.
 *
 * Only reads are retried. A POST that failed may still have arrived — the
 * socket can break after the website has already acted on it — and the POST
 * this proxy carries is somebody clocking on. Sending that twice would clock
 * them straight back off, which is worse than showing them the error.
 */
async function tryFetch(method, target, opts) {
  const safe = ['GET', 'HEAD'].includes(method);
  const goes = safe ? 3 : 1;
  let last;
  for (let go = 1; go <= goes; go++) {
    try {
      return await fetch(target, opts);
    } catch (e) {
      last = e;
      if (go < goes) {
        say(`retrying ${method} ${target} — ${e.message}`);
        await new Promise((r) => setTimeout(r, go * 500));
      }
    }
  }
  throw last;
}

async function proxy(req, res, url) {
  // A door belongs to one shop, and the page decides which from its own
  // address. Sending the browser to /?shop=N once means the tablet at this
  // door shows this door's faces and cannot be talked out of it.
  if (url.pathname === '/' && !url.searchParams.get('shop')) {
    res.writeHead(302, { Location: `/?shop=${Number(conf.shop)}` }).end();
    return;
  }

  // The manifest is this door's, not the website's.
  //
  // Chrome offers to install the clock as an app, which is what a screen by a
  // door should be — its own window, no tabs, no address bar. But the website's
  // manifest starts at /clock/ with no shop in it, so the installed app would
  // come up asking which shop it was, on a machine whose whole point is that it
  // never asks. So the door answers for itself: its own start address, its own
  // shop, and a scope of / because that is where it serves the clock.
  if (url.pathname === '/clock/manifest.webmanifest' || url.pathname === '/manifest.webmanifest') {
    const shop = Number(conf.shop);
    res.writeHead(200, {
      'Content-Type': 'application/manifest+json; charset=utf-8',
      'Cache-Control': 'no-store',
    });
    res.end(JSON.stringify({
      // No shop in the name: this PC only ever installs its own door, and a
      // name copied from configure.js would be one more place to go stale.
      // The page says which shop it is across the top anyway.
      name: 'MS BEAU AVE — Time clock',
      short_name: 'Time clock',
      description: 'Tap your name, type your PIN',
      start_url: `/?shop=${shop}`,
      scope: '/',
      display: 'fullscreen',
      background_color: '#FBF6F8',
      theme_color: '#A2647E',
      icons: [
        { src: '/icon-192.png', sizes: '192x192', type: 'image/png' },
        { src: '/icon-512.png', sizes: '512x512', type: 'image/png' },
        { src: '/icon-maskable.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
      ],
    }));
    return;
  }

  // /office is the back office, served from here so that enrolling a
  // fingerprint can reach the scanner. Same reason the clock is served here:
  // a page from the internet may not touch this machine, so the machine
  // hands over the page.
  const path = url.pathname === '/' ? '/clock/'
    : (url.pathname === '/office' || url.pathname === '/office/') ? '/'
    : url.pathname;
  const target = conf.site + path + (url.search || '');

  const body = ['GET', 'HEAD'].includes(req.method)
    ? undefined
    : await new Promise((done) => {
        const parts = [];
        req.on('data', (c) => parts.push(c));
        req.on('end', () => done(Buffer.concat(parts)));
      });

  // Whose session to use.
  //
  // The clock has none of its own and borrows the door's — that is the point
  // of the door being signed in. But the back office reached through here is
  // somebody signing in as themselves, and they must be themselves: the owner
  // enrolling a fingerprint needs the owner's rights, not the door's. So a
  // browser that has signed in speaks for itself, and only a browser that has
  // not falls back to the door.
  const theirs = req.headers.cookie;
  const send = (useTheirs) => tryFetch(req.method, target, {
    method: req.method,
    headers: {
      ...(req.headers['content-type'] ? { 'Content-Type': req.headers['content-type'] } : {}),
      ...(useTheirs ? { Cookie: theirs } : (cookie ? { Cookie: cookie } : {})),
    },
    body,
    redirect: 'follow',
  });

  let mine = !theirs;
  let out = await send(!mine);
  // The door's session is what the clock borrows, so the door renews it.
  if (out.status === 401 && !mine) { mine = true; out = await send(false); }
  if (out.status === 401 && mine) { await signIn(); out = await send(false); }

  const type = out.headers.get('content-type');
  const head = {
    ...(type ? { 'Content-Type': type } : {}),
    // The page is the door's own now; nothing here should be held on to.
    'Cache-Control': 'no-store',
  };

  // Signing in through here has to actually sign the browser in, so the
  // cookie is passed back — minus Secure, which a cookie set over plain
  // loopback cannot carry, and which would otherwise be silently dropped.
  const set = out.headers.getSetCookie?.() ?? [];
  if (set.length) head['Set-Cookie'] = set.map((c) => c.replace(/;\s*Secure/gi, ''));

  res.writeHead(out.status, head);
  res.end(Buffer.from(await out.arrayBuffer()));
}

sdk.traceTo(say);

// Did the last run die loading a fingerprint into the matcher?
const wreck = sdk.crashedLoading();
if (wreck) {
  sdk.dontMatch();
  say('the last run stopped while loading a fingerprint into the scanner:');
  for (const line of wreck.trim().split('\n')) say('  ' + line);
  say('running without fingerprint matching this time — PINs still work.');
  say('send door-log.txt and matcher-crash.txt to have it fixed.');
}
// A desk is not a door.
//
// The machine that enrols people wants the scanner and the back office, and
// emphatically does not want the clock: sixty-seven people are about to press
// a finger on it to be enrolled, and every one of those presses would clock
// somebody in. So a desk holds the scanner, answers the office, and never
// clocks anybody.
const DESK = conf.desk === true || String(conf.mode || '').toLowerCase() === 'desk';

say(DESK
  ? `MS BEAU AVE enrolment desk — enrolling for shop ${conf.shop}, ${conf.site}`
  : `MS BEAU AVE door agent — shop ${conf.shop}, ${conf.site}`);
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
if (sdk.ready() && !DESK) watch();
if (DESK) {
  say('desk mode: a finger here enrols. It does not clock anybody on.');
  say(`open http://127.0.0.1:${PORT}/office to enrol somebody.`);
}
