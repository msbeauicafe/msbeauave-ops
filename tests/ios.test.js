// The iPhone version.
//
// There isn't an .ipa and there cannot be one handed round: Apple has no
// sideloading, so an iOS build would need a paid developer account and App
// Store review, which rejects apps that only wrap a website. What an iPhone
// can do is add the page to the home screen — its own icon, full screen, no
// browser bars — which is what the Android app is too, in a different wrapper.
//
// That only works if four things are present, and every one of them is a line
// in a <head> that nothing else would miss if it went. A page that loses them
// still loads perfectly in a browser and quietly stops being an app, which is
// exactly the kind of breakage worth a test.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const pub = path.join(here, '..', 'public');

// Read off the filesystem: a page added next month is covered by having been
// built rather than by somebody remembering to list it here.
const pages = fs.readdirSync(pub, { withFileTypes: true })
  .flatMap((d) => (d.isDirectory() && fs.existsSync(path.join(pub, d.name, 'index.html'))
    ? [[`${d.name}/index.html`, path.join(pub, d.name, 'index.html')]] : []))
  .concat([['index.html', path.join(pub, 'index.html')]])
  // The download page and the claim pages are read once in a browser; they are
  // not something anybody keeps on a home screen.
  .filter(([name]) => !['get/index.html', 'join/index.html', 'apply/index.html']
    .includes(name));

for (const [name, file] of pages) {
  const html = fs.readFileSync(file, 'utf8');

  test(`${name} can be added to an iPhone home screen`, () => {
    assert.match(html, /name="apple-mobile-web-app-capable"\s+content="yes"/,
      'without this, older iOS opens it in Safari with the address bar');
    assert.match(html, /name="apple-mobile-web-app-title"/,
      'without this the icon is named after the <title>, which is long');
    assert.match(html, /rel="apple-touch-icon"/,
      'without this iOS screenshots the page and uses that as the icon');
    assert.match(html, /rel="manifest"/);
  });

  test(`${name} does not draw under the notch`, () => {
    // A standalone iOS app owns the whole glass. Without viewport-fit=cover
    // the page is letterboxed; with it and no safe-area padding the header
    // sits behind the status bar. Both halves are needed, and the CSS half is
    // checked below.
    assert.match(html, /name="viewport"[^>]*viewport-fit=cover/,
      `${name} has no viewport-fit=cover`);
  });
}

test('every stylesheet a home-screen app uses keeps clear of the notch and the home bar', () => {
  for (const sheet of ['styles.css', 'shop/shop.css', 'clock/clock.css']) {
    const css = fs.readFileSync(path.join(pub, sheet), 'utf8');
    assert.match(css, /env\(safe-area-inset-top/,
      `${sheet}: the header will sit behind the iPhone status bar`);
    assert.match(css, /env\(safe-area-inset-bottom/,
      `${sheet}: the bottom of the page will sit under the home bar`);
    // The fallback matters as much as the inset: env() is nothing on Android
    // and a desktop, and calc() with an empty term collapses the whole rule.
    assert.match(css, /env\(safe-area-inset-top,\s*0px\)/,
      `${sheet}: env() needs a 0px fallback or the padding breaks everywhere else`);
  }
});

test('the staff app is its own icon, not a second back office', () => {
  // One page serves both, so the name has to come from ?app=staff. iOS reads
  // it out of the document when somebody taps Add to Home Screen, which is
  // always after the page has run.
  const app = fs.readFileSync(path.join(pub, 'app.js'), 'utf8');
  assert.match(app, /HOME_SCREEN_NAMES/);
  assert.match(app, /apple-mobile-web-app-title/,
    'app.js must set the home screen name for ?app=staff');
  assert.match(app, /manifest-staff\.webmanifest/);

  const manifest = JSON.parse(
    fs.readFileSync(path.join(pub, 'manifest-staff.webmanifest'), 'utf8'));
  assert.equal(manifest.short_name, 'MBA Staff');
  assert.equal(manifest.start_url, '/?app=staff',
    'opening the icon must land on the staff sign-in, not the back office one');
  assert.equal(manifest.display, 'standalone');
  assert.ok(manifest.icons.length >= 2);
});

test('the iPhone instructions are on the download page', () => {
  // Somebody handed an iPhone has nothing to download and no button to press.
  // If the page does not say so they will decide the app is Android-only.
  const page = fs.readFileSync(path.join(pub, 'get', 'index.html'), 'utf8');
  assert.match(page, /Add to Home Screen/);
  assert.match(page, /Safari/, 'Chrome on iPhone cannot do it, so the page has to say Safari');
  assert.match(page, /\/\?app=staff/, 'the staff address has to be one of the links');
});
