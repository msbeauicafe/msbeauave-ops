// The door screen fits on the door's screen.
//
// Every door here is a 1080p desktop monitor. The clock was drawn for a tablet
// held at arm's length, and at monitor sizes it grew past the bottom of the
// glass: three rows of faces, and the fingerprint panel cut in half by the edge
// of the screen. Nobody arriving for a shift scrolls a wall-mounted screen to
// find out where the keypad went, and a scanner below the fold is a scanner
// nobody knows is there.
//
// So this measures rather than trusts. It renders the real markup against the
// real stylesheet, with the real names and job titles from both shops — the
// long ones are what wrap a card onto an extra line and push a row off the
// bottom — and asserts what has to be true at a door:
//
//   * four rows of faces are on the screen, whole, without scrolling
//   * the keypad and the scanner panel are both entirely inside the glass
//   * the page itself does not scroll at all
//
// It needs a browser. Playwright is not a dependency of this project — the
// server needs nothing but pg — so where it is not installed this file says so
// and skips rather than failing a run that has nothing wrong with it.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const css = fs.readFileSync(path.join(here, '..', 'public/clock/clock.css'), 'utf8');

let chromium = null;
try { ({ chromium } = await import('playwright')); } catch { /* not installed */ }

// Playwright looks for browsers where it was told to; a container that has the
// module but not the download is the common case and is not a failure either.
const BROWSER = [
  process.env.CHROMIUM_PATH,
  '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  '/opt/pw-browsers/chromium/chrome-linux/chrome',
].find((p) => p && fs.existsSync(p));

// Both teams, as they are. The names are the point: "Mary Germae Tanwangco
// Mangulabnan" over "Ecommerce Staff/Inventory Staff" is the card that decides
// how tall a row is, and a test with Alice and Bob on it would pass on a layout
// that breaks the moment it meets the actual staff list.
const BOA = [
  ['Aj Claurence Acutem Flormata', 'Ecommerce Staff/Dispatcher'],
  ['Angela Aminah Lim Casitas', 'Live Seller Host'],
  ['Carla Jane Cortez Malana', 'Live Seller Host'],
  ['Cathlene Aira Leorag Esguerra', 'Ecommerce Staff'],
  ['Cristalynn Cristi', 'Live Seller Host'],
  ['Dixie Rose Reyes Alfonso', 'Live Seller Host'],
  ['Fiona Gweneth Idorot Cremen', 'Live Seller Host'],
  ['Gabriella Marie Zausa', 'Live Seller Host'],
  ['Gina Abarracoso Ibañez', 'Ecommerce Staff'],
  ['Jennifer Gojo Esplana', 'Ecommerce Staff'],
  ['Jeorge Melvin Roxas Panesa', 'Order Fulfillment Staff'],
  ['John Renz Marientes Ibañez', 'Order Fulfillment Staff'],
  ['Mark Elvin Abagon Malapajo', 'Order Fulfillment Staff'],
  ['Mary Germae Tanwangco Mangulabnan', 'Live Seller Host'],
  ['Marygrace Belarmino Abagon', 'Ecommerce Staff/Coordinator'],
  ['Melmark Tiangco Loberiano', 'Ecommerce Staff/Inventory Staff'],
  ['Omar Villanueva Dispabeladero', 'Order Fulfillment Staff'],
  ['Prince Kenneth Asi Canlas', 'Order Fulfillment Staff'],
  ['Princess Mariel Dasalla Sevilla', 'Ecommerce Admin'],
  ['Rey Allen Gonzales Delacruz', 'Ecommerce Staff'],
  ['Reymar Cator Mahinay', 'Ecommerce Staff/Dispatcher'],
  ['Sarah Jane Fabros', 'Live Seller Host'],
  ['Stephanie Orandoy Mayordomo', 'Ecommerce Staff'],
];
// The other door: a few more people, and job titles that run half a line
// longer. Padded past today's headcount on purpose — a shop that hires five
// people should not discover the door screen at the same time as the hires.
const OPC = [...BOA, ...BOA.slice(0, 9)].map(([n], i) =>
  [n, i % 4 === 0 ? 'Warehouse and Delivery Coordinator / Dispatcher' : 'Ecommerce Staff']);

// The same markup the page builds, with the pieces that decide a card's height:
// the photograph, a name that wraps, a job title that wraps, the date, and the
// times. Somebody on shift also carries a dot.
const card = ([name, role], i) => `
  <button class="card ${i < 3 ? 'on' : ''}">
    ${i < 3 ? '<span class="dot"></span>' : ''}
    <span class="face">🧑</span>
    <b>${name}</b>
    <span>${role}</span>
    <span class="day">Sat, Aug 22</span>
    <span class="times ${i < 3 ? 'in' : ''}">${i < 3 ? 'In 1:25 PM' : '6:52 AM – 4:00 PM'}</span>
  </button>`;

const doorPage = (people, brand) => `<!doctype html>
<html lang="en"${brand ? ` data-brand="${brand}"` : ''}><head><meta charset="utf-8">
<style>${css}</style></head><body>
<header id="bar">
  <div class="brand"><img src="data:image/gif;base64,R0lGODlhAQABAAAAACw=" alt="">
    <div><b>MS BEAU AVE</b><span id="where">Time clock</span></div></div>
  <div class="right"><span id="now">6:38 PM</span></div>
</header>
<main id="app"><div class="two">
  <section class="clockside">
    <div class="tools" style="display:none"><select id="branch"></select></div>
    <div class="grid" id="grid">${people.map(card).join('')}</div>
  </section>
  <aside class="rail">
    <section class="padside" id="bypin">
      <h2>Type your PIN</h2>
      <div class="dots">– – – –</div>
      <div class="keys">
        ${[1, 2, 3, 4, 5, 6, 7, 8, 9].map((d) => `<button>${d}</button>`).join('')}
        <button class="wipe">clear</button><button>0</button><button class="go">✓</button>
      </div>
      <p class="hint">Type your PIN on the keyboard, or pick your face on the left.</p>
    </section>
    <section class="padside finger" id="byfinger">
      <h2>Enrolment desk</h2>
      <div class="scan">☝</div>
      <p class="hint">Fingers enrol here. They clock nobody on.</p>
      <p class="wait-note">Hold it still and wait for your name.</p>
    </section>
  </aside>
</div></main>
<div id="notices"></div></body></html>`;

// A 1080p monitor is not 1080 pixels of page. What the browser keeps for
// itself depends on how the door PC is set up, so all three are checked: the
// tab strip, address bar and bookmarks that are on the BOA door today; the
// same without bookmarks; and full screen, which is how a door ought to run.
const DOORS = [
  { label: '1080p, browser with a bookmarks bar', width: 1920, height: 900 },
  { label: '1080p, browser without bookmarks', width: 1920, height: 940 },
  { label: '1080p, full screen', width: 1920, height: 1032 },
  { label: '1600x900 monitor', width: 1600, height: 740 },
];

async function measure(browser, size, people, brand) {
  const page = await browser.newPage({ viewport: { width: size.width, height: size.height } });
  try {
    await page.setContent(doorPage(people, brand));
    return await page.evaluate(() => {
      const grid = document.querySelector('#grid');
      const cards = [...grid.querySelectorAll('.card')];
      const pane = grid.getBoundingClientRect();
      const tops = [...new Set(cards.map((c) => Math.round(c.getBoundingClientRect().top)))]
        .sort((a, b) => a - b);
      // A row only counts if the whole card is inside the pane. Half a face
      // showing at the bottom edge is not a row somebody can read.
      const wholeRows = tops.filter((t) => cards
        .find((c) => Math.round(c.getBoundingClientRect().top) === t)
        .getBoundingClientRect().bottom <= pane.bottom + 1).length;
      return {
        across: cards.filter((c) =>
          Math.round(c.getBoundingClientRect().top) === tops[0]).length,
        wholeRows,
        paneWidth: Math.round(pane.width),
        railWidth: Math.round(document.querySelector('.rail').getBoundingClientRect().width),
        screenWidth: innerWidth,
        keypadBottom: Math.round(document.querySelector('#bypin').getBoundingClientRect().bottom),
        scannerBottom: Math.round(document.querySelector('#byfinger').getBoundingClientRect().bottom),
        pageScrolls: document.documentElement.scrollHeight > innerHeight + 1,
        gridScrolls: grid.scrollHeight > grid.clientHeight + 1,
      };
    });
  } finally { await page.close(); }
}

test('the door screen fits on the door\'s screen', { skip: !chromium || !BROWSER
  ? 'needs Playwright and a Chromium build; neither is a dependency of this project'
  : false }, async (t) => {
  const browser = await chromium.launch({ executablePath: BROWSER });
  t.after(() => browser.close());

  for (const [shop, people, brand] of [['BOA', BOA, 'boa'], ['MS Beau Ave', OPC, null]]) {
    for (const door of DOORS) {
      const m = await measure(browser, door, people, brand);
      const where = `${shop}, ${door.label}`;

      // Four rows. The whole complaint, in one number: the screen showed three.
      assert.ok(m.wholeRows >= 4,
        `${where}: ${m.wholeRows} rows of faces on screen, wanted at least 4 `
        + `(${m.across} across)`);

      // And four rows of a decent width. Rows are cheap if the faces are in a
      // single column down the middle of the glass — which is exactly what one
      // stray auto margin did, and it counted as four rows while showing four
      // people. The faces get the monitor; the rail gets a strip of it.
      assert.ok(m.across >= 5,
        `${where}: only ${m.across} faces across — the board has collapsed`);
      assert.ok(m.paneWidth > m.screenWidth * 0.55,
        `${where}: the faces are ${m.paneWidth}px of a ${m.screenWidth}px screen, `
        + `beside a ${m.railWidth}px rail`);

      // Both panels in the rail, whole. The scanner is the bottom one and so
      // the one that goes over the edge first.
      assert.ok(m.scannerBottom <= door.height,
        `${where}: the scanner panel ends at ${m.scannerBottom}px on a ${door.height}px `
        + 'screen — it is cut off');
      assert.ok(m.keypadBottom <= door.height,
        `${where}: the keypad ends at ${m.keypadBottom}px on a ${door.height}px screen`);

      // The page holds still. Only the faces move, and only inside their pane.
      assert.equal(m.pageScrolls, false,
        `${where}: the page itself scrolls — the keypad will not stay put`);
    }
  }
});

// The layout above only holds because the faces have somewhere of their own to
// scroll. Without it a bigger team pushes the whole page down again, which is
// exactly how this broke the first time.
test('a team too big for the screen scrolls the faces, not the page', { skip: !chromium || !BROWSER
  ? 'needs Playwright and a Chromium build; neither is a dependency of this project'
  : false }, async (t) => {
  const browser = await chromium.launch({ executablePath: BROWSER });
  t.after(() => browser.close());

  // Twice the biggest shop, which no door has and one might.
  const crowd = [...OPC, ...OPC];
  const m = await measure(browser, DOORS[0], crowd, null);
  assert.equal(m.pageScrolls, false, 'the page scrolled instead of the faces');
  assert.equal(m.gridScrolls, true, 'the faces did not scroll, so some are unreachable');
  assert.ok(m.scannerBottom <= DOORS[0].height, 'the scanner was pushed off the screen');
  assert.ok(m.wholeRows >= 4, `${m.wholeRows} rows shown with a crowd, wanted at least 4`);
});
