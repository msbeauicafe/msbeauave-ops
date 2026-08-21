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
