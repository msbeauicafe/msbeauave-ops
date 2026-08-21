// An eye on every password box.
//
// The eye is added by a module that watches the page, so a file only gets it
// by importing that module — one line, at the top, easy to leave out. This is
// what notices. A password box added next year in a file nobody thought to
// wire up would otherwise be a box that silently swallows what is typed into
// it, on a phone, by somebody reading a password off a sheet of paper.
//
// It also reads the module itself, because the two things that would break the
// eye without breaking any page are a toggle button that submits the form it
// sits in, and a scan narrowed to the boxes that happened to exist that day.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const pub = path.join(here, '..', 'public');

// Every .js and .html under public/, found rather than listed.
function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
    const full = path.join(dir, d.name);
    if (d.isDirectory()) return walk(full);
    return /\.(js|html)$/.test(d.name) ? [full] : [];
  });
}

const files = walk(pub).map((f) => ({
  path: path.relative(pub, f),
  text: fs.readFileSync(f, 'utf8'),
}));

test('every page with a password box imports the eye', () => {
  const withPassword = files.filter((f) =>
    /type=["']?password/.test(f.text) && f.path !== 'reveal.js');
  assert.ok(withPassword.length >= 4,
    `expected several password boxes, found ${withPassword.length}`);

  const missing = withPassword
    .filter((f) => !/import\s+['"][^'"]*reveal\.js['"]/.test(f.text))
    .map((f) => f.path);
  assert.deepEqual(missing, [],
    `these have a password box and no eye: ${missing.join(', ')}`);
});

test('the eye is on every password box, not a list of them', () => {
  const src = fs.readFileSync(path.join(pub, 'reveal.js'), 'utf8');
  assert.match(src, /querySelectorAll\('input\[type=password\]'\)/,
    'the scan must find password boxes by what they are');
});

test('the toggle does not submit the form it sits in', () => {
  const src = fs.readFileSync(path.join(pub, 'reveal.js'), 'utf8');
  // A button in a form is a submit button unless it says otherwise, so
  // pressing the eye on the sign-in page would try to sign in with half a
  // password typed.
  assert.match(src, /eye\.type\s*=\s*'button'/,
    'the eye must be type=button');
});

test('the eye toggles back as well as forward', () => {
  const src = fs.readFileSync(path.join(pub, 'reveal.js'), 'utf8');
  assert.match(src, /input\.type\s*=\s*showing\s*\?\s*'password'\s*:\s*'text'/,
    'showing must be reversible — a password left on screen is worse than one hidden');
});
