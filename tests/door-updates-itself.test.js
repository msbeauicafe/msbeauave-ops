// The door picks up a change on its own.
//
// The BOA door is 500 metres away, on a PC nothing outside that PC can reach,
// and its browser is opened once at startup and left. Every change to the
// clock used to wait for somebody to walk over. This is the thing that stops
// that, so it is worth more than a reading of the source.
//
// It is served here the way the real door serves it. A door with a scanner
// does not fetch the clock from the website — it fetches it from the agent on
// its own PC, which passes the website through and hands back Content-Type and
// Cache-Control and nothing else. No ETag. No Last-Modified. The first version
// of the watcher asked for exactly those headers, and would have sat at that
// door doing nothing at all, so the server below is deliberately as bare as
// agent/door.js is: if the watcher ever goes back to relying on a header, this
// stops passing.
//
// Needs a browser, which is not a dependency of this project; it says so and
// skips where there is none.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(here, '..', 'public');

let chromium = null;
try { ({ chromium } = await import('playwright')); } catch { /* not installed */ }
const BROWSER = [
  process.env.CHROMIUM_PATH,
  '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  '/opt/pw-browsers/chromium/chrome-linux/chrome',
].find((p) => p && fs.existsSync(p));
const skip = !chromium || !BROWSER
  ? 'needs Playwright and a Chromium build; neither is a dependency of this project'
  : false;

const TYPES = {
  '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
};

// A copy of the site, so a test may edit a file underneath a running page.
// The five-minute check becomes a one-second one; nothing else is touched.
function stand() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'door-'));
  fs.cpSync(PUBLIC, dir, { recursive: true });
  const js = path.join(dir, 'clock/clock.js');
  const src = fs.readFileSync(js, 'utf8');
  const quick = src.replace('const CHECK_EVERY = 5 * 60 * 1000;', 'const CHECK_EVERY = 1000;');
  assert.notEqual(quick, src, 'clock.js no longer has a CHECK_EVERY to shorten');
  fs.writeFileSync(js, quick);
  return dir;
}

async function serve(dir) {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://door');
    // No session here, so the clock shows its setting-up screen. The watcher
    // starts before any of that and runs either way, which is on purpose: a
    // door that has lost its sign-in still has to be able to pick up a fix.
    if (url.pathname.startsWith('/api/')) {
      res.writeHead(401, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      return res.end('{"error":"signed out"}');
    }
    const file = path.join(dir, url.pathname === '/' ? 'clock/index.html'
      : url.pathname.endsWith('/') ? `${url.pathname}index.html`
      : url.pathname);
    if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404, { 'Cache-Control': 'no-store' });
      return res.end('no');
    }
    // Exactly what agent/door.js replies with, and nothing more.
    res.writeHead(200, {
      'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream',
      'Cache-Control': 'no-store',
    });
    res.end(fs.readFileSync(file));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { server, base: `http://127.0.0.1:${server.address().port}` };
}

test('a door 500 metres away picks up a change by itself', { skip }, async (t) => {
  const dir = stand();
  const { server, base } = await serve(dir);
  const browser = await chromium.launch({ executablePath: BROWSER });
  t.after(async () => {
    await browser.close();
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const page = await browser.newPage();
  let loads = 0;
  page.on('load', () => { loads += 1; });
  await page.goto(`${base}/clock/`);

  // Nothing has changed, so nothing should happen. A door that reloaded every
  // few minutes on its own would be worse than one that never did.
  await page.waitForTimeout(2500);
  assert.equal(loads, 1, 'the door reloaded itself with nothing to pick up');

  // A deploy.
  const css = path.join(dir, 'clock/clock.css');
  fs.appendFileSync(css, '\n/* a change, as a deploy would make */\n');
  await page.waitForTimeout(4000);
  assert.equal(loads, 2,
    'the door did not pick up a changed stylesheet — check it is not asking for '
    + 'an ETag, which the door agent does not pass on');
});

test('and waits until nobody is standing at it', { skip }, async (t) => {
  const dir = stand();
  const { server, base } = await serve(dir);
  const browser = await chromium.launch({ executablePath: BROWSER });
  t.after(async () => {
    await browser.close();
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const page = await browser.newPage();
  let loads = 0;
  page.on('load', () => { loads += 1; });
  await page.goto(`${base}/clock/`);
  await page.waitForTimeout(1500);
  const before = loads;

  // Somebody has just clocked on and is reading the screen — which is what
  // say() puts there. Reloading now would take the answer away mid-sentence.
  await page.evaluate(() => {
    const el = document.createElement('div');
    el.className = 'say good';
    el.textContent = 'Good morning — clocked on';
    document.querySelector('#notices').append(el);
  });
  fs.appendFileSync(path.join(dir, 'clock/clock.css'), '\n/* a change, mid-shift */\n');
  await page.waitForTimeout(3000);
  assert.equal(loads - before, 0, 'the door reloaded while somebody was reading it');

  // They walk away.
  await page.evaluate(() => document.querySelector('#notices').replaceChildren());
  await page.waitForTimeout(6000);
  assert.equal(loads - before, 1, 'the door never picked the change up once it was free');
});
