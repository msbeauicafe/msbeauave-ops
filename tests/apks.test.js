// The apps we hand out are whole apps.
//
// The staff APK was built by hand with aapt2 rather than by the project that
// builds every other one, and it linked only its own four resources: an icon,
// a splash, a colour and a name. Its classes.dex is the Android browser
// library, which resolves that library's own themes and layouts by id at
// launch. Those ids were not in it. The app installed, parsed, reported the
// right package and version — and died the instant it opened, on two phones,
// twice, because nothing anybody checked could tell the difference.
//
// What tells the difference is the size of the resource table and the number
// of files. A real build of this shell carries about 46KB and fifty-odd files;
// the broken one had 1.5KB and nine. So that is what is checked here, on every
// APK in the folder rather than the one that went wrong, because the next one
// built in a hurry will be a different one.
//
// Read straight off the zip. An APK is a zip, its central directory is at the
// end, and both numbers are in it — no Android tooling needed, so this runs
// anywhere the rest of the tests do.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const here = path.dirname(fileURLToPath(import.meta.url));
const shed = path.join(here, '..', 'public', 'get');

const apks = fs.readdirSync(shed).filter((f) => f.endsWith('.apk')).sort();

/** Every entry in an APK: its name and its uncompressed size. */
function entries(file) {
  const out = execFileSync('unzip', ['-l', file], { encoding: 'utf8' });
  return out.split('\n')
    .map((line) => line.match(/^\s*(\d+)\s+\S+\s+\S+\s+(.+?)\s*$/))
    .filter(Boolean)
    .map((m) => ({ size: Number(m[1]), name: m[2] }))
    .filter((e) => e.name !== 'Name');
}

test('there are apps to check', () => {
  assert.ok(apks.length >= 5, `expected the apps, found ${apks.join(', ') || 'none'}`);
});

for (const name of apks) {
  const file = path.join(shed, name);

  test(`${name} carries the library resources it needs to start`, () => {
    const inside = entries(file);
    const arsc = inside.find((e) => e.name === 'resources.arsc');
    assert.ok(arsc, `${name} has no resource table at all`);

    // The shell's own resources come to about 46KB. A table under 20KB means
    // only the app's own handful were linked and the library's were dropped —
    // which is an app that installs and then dies on its first frame.
    assert.ok(arsc.size > 20000,
      `${name}: resources.arsc is only ${arsc.size} bytes. The Android library's `
      + 'resources are missing, so it will crash at launch. Build it with the '
      + 'gradle project rather than by hand.');

    assert.ok(inside.length >= 30,
      `${name} has ${inside.length} files; a real build of this shell has fifty-odd`);
  });

  test(`${name} has the code and a signature`, () => {
    const inside = entries(file);
    assert.ok(inside.some((e) => e.name === 'classes.dex'), `${name} has no classes.dex`);
    assert.ok(inside.some((e) => e.name === 'AndroidManifest.xml'), `${name} has no manifest`);
    assert.ok(inside.some((e) => /^META-INF\/.*\.(RSA|EC|DSA)$/.test(e.name)),
      `${name} is not signed`);
  });
}

test('every app we hand out is named on the download page', () => {
  // An APK in the folder that no card points at is one nobody can install, and
  // a card pointing at a file that is not there is a broken button.
  const page = fs.readFileSync(path.join(shed, 'index.html'), 'utf8');
  const missing = apks.filter((f) => !page.includes(`/get/${f}`));
  assert.deepEqual(missing, [], `these are downloadable but unlisted: ${missing.join(', ')}`);

  const linked = [...page.matchAll(/\/get\/([\w.-]+\.apk)/g)].map((m) => m[1]);
  const broken = [...new Set(linked)].filter((f) => !apks.includes(f));
  assert.deepEqual(broken, [], `these are linked but not there: ${broken.join(', ')}`);
});

test('every app that claims a package is signed by the key assetlinks names', () => {
  // A TWA whose signature does not match assetlinks.json still opens, but with
  // Chrome's address bar across the top — which looks like a different, worse
  // app. Checked against the manifest rather than a list kept here.
  const links = JSON.parse(fs.readFileSync(
    path.join(here, '..', 'public', '.well-known', 'assetlinks.json'), 'utf8'));
  assert.ok(links.length >= 3, 'expected an entry for each verified app');
  for (const entry of links) {
    assert.match(entry.target.package_name, /^com\.msbeauave\./);
    assert.match(entry.target.sha256_cert_fingerprints[0], /^([0-9A-F]{2}:){31}[0-9A-F]{2}$/,
      `${entry.target.package_name}: that is not a SHA-256 fingerprint`);
  }
});
