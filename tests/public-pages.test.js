// Which addresses belong to a page of their own.
//
// Everything not on the list below is rewritten to the back office, because
// the back office is a single page that does its own routing. That is right
// for /team and /finance and wrong for anything that is genuinely its own
// file — and the failure is quiet: the address loads, and shows the wrong
// application. A new public page that nobody remembered to exclude looks
// broken in a way that has nothing to do with the page.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const config = JSON.parse(fs.readFileSync(path.join(root, 'vercel.json'), 'utf8'));
const rewrite = config.rewrites.find((r) => r.destination === '/index.html');
const pattern = new RegExp(rewrite.source.replace(/^\//, '^/'));

const swallowed = (url) => pattern.test(url);

test('every folder with its own index.html is left alone', () => {
  // Read off the filesystem rather than listed here, so a page added next
  // month is covered by having been built rather than by being remembered.
  const pub = path.join(root, 'public');
  const own = fs.readdirSync(pub, { withFileTypes: true })
    .filter((d) => d.isDirectory() && fs.existsSync(path.join(pub, d.name, 'index.html')))
    .map((d) => d.name);

  assert.ok(own.length >= 4, `expected several public pages, found ${own.join(', ')}`);
  const caught = own.filter((name) => swallowed(`/${name}/`) || swallowed(`/${name}`));
  assert.deepEqual(caught, [],
    `these would be served the back office instead of themselves: ${caught.join(', ')}`);
});

test('the back office still catches its own screens', () => {
  for (const url of ['/', '/team', '/finance', '/attendance', '/anything-else']) {
    assert.ok(swallowed(url), `${url} should reach the back office`);
  }
});

test('the api is never rewritten', () => {
  for (const url of ['/api/login', '/api/hr/attendance', '/api/reseller/apply']) {
    assert.ok(!swallowed(url), `${url} must reach the server, not a page`);
  }
});

// The screen changes several times a day, and the whole point of shipping it
// that way is that somebody can look and say whether it is right. A browser
// holding on to app.js turns that into somebody looking at an hour-old build
// and reporting a bug that was already fixed — which is a worse failure than
// the bug, because the answer to it is not in the code.
//
// no-cache does not mean do not cache. It means ask first: an unchanged file
// still comes back 304 and costs nothing on the wire.
test('the screen itself is checked for freshness rather than assumed', () => {
  const rule = (config.headers || []).find((h) => /app\.js/.test(h.source));
  assert.ok(rule, 'nothing tells the browser to re-check app.js');
  assert.match(rule.source, /styles\.css/,
    'and the stylesheet with it — a new screen in an old skin reads as broken');

  const cache = rule.headers.find((h) => h.key.toLowerCase() === 'cache-control');
  assert.ok(cache, 'the rule sets no Cache-Control at all');
  assert.match(cache.value, /no-cache/,
    `app.js is served as "${cache.value}", which lets a browser hold it`);
  assert.doesNotMatch(cache.value, /immutable/,
    'immutable is the opposite promise: never ask again');
});
