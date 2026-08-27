// Coming back to where you were.
//
// A reseller's account is a dialog. So is the invoice you open from it, and
// until now opening the second destroyed the first: read one invoice and you
// were back at the list, hunting for the name you had already clicked, with
// whatever you had half-typed into the account gone with it.
//
// Dialogs opened from inside another one now stack. This checks the two things
// that has to mean:
//
//   * the one underneath survives, exactly as it was left, and is out of reach
//     of the keyboard while it waits
//   * closing goes back one step, not all the way out — and leaving the screen
//     still takes the whole pile with it
//
// The behaviour half needs a browser. Playwright is not a dependency of this
// project, so where it is not installed this file says so and skips rather
// than failing a run that has nothing wrong with it. The half that matters
// most — that the invoice read from an account is opened over that account —
// is read straight off the source and always runs.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const app = fs.readFileSync(path.join(here, '..', 'public/app.js'), 'utf8');

/** The source of one top-level function, from its name to its closing line. */
function bodyOf(name) {
  const at = app.indexOf(`function ${name}(`);
  assert.notEqual(at, -1, `${name} is gone`);
  const end = app.indexOf('\n}\n', at);
  assert.notEqual(end, -1, `${name} has no end`);
  return app.slice(at, end + 3);
}

// ---------------------------------------------------------------------------
// What the screens ask for — no browser needed
// ---------------------------------------------------------------------------

// The one the owner asked for by name: open an account, read an invoice, and
// still be on that account when the invoice is closed.
test('the invoice read from an account is opened over that account', () => {
  const src = bodyOf('openReseller');
  const at = src.indexOf('showInvoiceDoc({');
  assert.notEqual(at, -1, 'an account no longer opens its invoices');
  assert.match(src.slice(at, at + 400), /over:\s*true/,
    'reading an invoice from an account must not close the account');
});

// The same promise, one screen over: the sheet and the delivery form are both
// opened from a purchase order and both have to give it back.
test('what is opened from a purchase order is opened over it', () => {
  const at = app.indexOf('SCREENS.purchaseorders = async');
  assert.notEqual(at, -1, 'the purchase order screen is gone');
  const screen = app.slice(at);
  assert.match(screen, /showPurchaseOrder\(po,\s*true\)/,
    'the sheet must not close the order it was printed from');
  assert.match(screen, /receiveDelivery\(\{[\s\S]{0,220}?over:\s*true/,
    'the delivery form must not close the order it answers');
  // Receiving one line, read out of its own function rather than by guessing
  // how many characters its dialog runs to.
  const rl = screen.slice(screen.indexOf('function receiveLine('));
  assert.match(rl.slice(0, rl.indexOf('\n  }\n')), /`,\s*'',\s*true\)/,
    'receiving one line must not close the order either');
});

// Leaving the screen is not going back a step, and must not leave a veil behind.
test('changing screens takes the whole pile with it', () => {
  assert.match(app,
    /clearInterval\(refreshTimer\);\s*\n\s*closeAllDialogs\(\);\s*\n\s*SCREENS\[tab\]/,
    'switching tabs must clear every dialog, not just the top one');
});

// ---------------------------------------------------------------------------
// What actually happens in a browser
// ---------------------------------------------------------------------------
let chromium = null;
try { ({ chromium } = await import('playwright')); } catch { /* not installed */ }

const BROWSER = [
  process.env.CHROMIUM_PATH,
  '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  '/opt/pw-browsers/chromium/chrome-linux/chrome',
].find((p) => p && fs.existsSync(p));

const why = !chromium ? 'playwright is not installed'
  : !BROWSER ? 'no chromium to drive'
  : undefined;

// The real machinery, lifted out of the app in one piece and given a page of
// its own — the stack, the opener, the closers and the Escape key, exactly as
// they are written. What is under test is the stacking, not the screens using
// it, so nothing else of the app comes along.
const FROM = 'const dialogsUnder = [];';
const TO = 'const closeAllDialogs = () => {';
const start = app.indexOf(FROM);
const stop = app.indexOf('};', app.indexOf(TO)) + 2;
assert.ok(start > 0 && stop > start, 'the dialog machinery is not where it was');
const MACHINERY = app.slice(start, stop);
assert.match(MACHINERY, /function dialog\(/, 'the opener came away with it');

const HARNESS = `<!doctype html><meta charset="utf-8"><body>
<scr` + `ipt>
const $ = (sel, root = document) => root.querySelector(sel);
${MACHINERY}
</scr` + `ipt></body>`;

test('a dialog opened over another gives it back when it closes',
  { skip: why }, async () => {
    const browser = await chromium.launch({ executablePath: BROWSER });
    try {
      const page = await browser.newPage();
      await page.setContent(HARNESS);

      // An account, with something typed into it.
      await page.evaluate(() => dialog('<h3>Anatolia</h3><input id="typed">'));
      await page.fill('#typed', 'half a payment');

      // An invoice read from it.
      await page.evaluate(() => dialog('<h3>Invoice</h3>', 'wide', true));
      assert.equal(await page.locator('.veil').count(), 2, 'both are on the page');
      assert.equal(await page.locator('#dialog h3').textContent(), 'Invoice',
        'the invoice is the one on top');
      assert.equal(await page.locator('.veil:not(#dialog)').evaluate((el) => el.inert), true,
        'the account is out of reach while the invoice is up');

      // Closed: back on the account, with the typing still in it.
      await page.evaluate(() => closeDialog());
      assert.equal(await page.locator('.veil').count(), 1);
      assert.equal(await page.locator('#dialog h3').textContent(), 'Anatolia',
        'closing the invoice comes back to the account');
      assert.equal(await page.inputValue('#typed'), 'half a payment',
        'and to what was half typed into it');
      assert.equal(await page.locator('#dialog').evaluate((el) => el.inert), false,
        'and it can be typed into again');

      // Closed again: out to the screen.
      await page.evaluate(() => closeDialog());
      assert.equal(await page.locator('.veil').count(), 0);
    } finally { await browser.close(); }
  });

test('a dialog that is not opened over another replaces it',
  { skip: why }, async () => {
    const browser = await chromium.launch({ executablePath: BROWSER });
    try {
      const page = await browser.newPage();
      await page.setContent(HARNESS);
      // Several screens reopen an account from inside a dialog belonging to it.
      // Those must not pile up behind themselves.
      await page.evaluate(() => { dialog('<h3>one</h3>'); dialog('<h3>two</h3>'); });
      assert.equal(await page.locator('.veil').count(), 1);
      await page.evaluate(() => closeDialog());
      assert.equal(await page.locator('.veil').count(), 0, 'and one close is enough');
    } finally { await browser.close(); }
  });

test('leaving the screen closes every dialog on it',
  { skip: why }, async () => {
    const browser = await chromium.launch({ executablePath: BROWSER });
    try {
      const page = await browser.newPage();
      await page.setContent(HARNESS);
      await page.evaluate(() => {
        dialog('<h3>account</h3>');
        dialog('<h3>invoice</h3>', 'wide', true);
        dialog('<h3>receipt</h3>', 'wide', true);
      });
      assert.equal(await page.locator('.veil').count(), 3);
      await page.evaluate(() => closeAllDialogs());
      assert.equal(await page.locator('.veil').count(), 0);
      // And the pile is really gone, not merely hidden: one more open starts
      // from nothing.
      await page.evaluate(() => dialog('<h3>next screen</h3>'));
      await page.evaluate(() => closeDialog());
      assert.equal(await page.locator('.veil').count(), 0);
    } finally { await browser.close(); }
  });
