// The shop, banded by the house a product comes from.
//
// Home was every product we stock in one column: 867 cards, two abreast, four
// hundred rows deep. Reaching the bottom of that is not something anybody does
// twice, which means most of the shop was never seen by anybody.
//
// A customer asking for "888" is not asking for a category either. They are
// asking for a brand, because that is what is written on the tub in their hand
// and what they were told to buy — and the shop had category chips and a flat
// wall, neither of which answers that.
//
// So both the wall and the search are grouped by brand, which for this shop is
// the supplier line. The page now scrolls down through seventy-three houses
// rather than through eight hundred products, and each house swipes sideways.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const shop = fs.readFileSync(path.join(here, '..', 'public/shop/shop.js'), 'utf8');
const css = fs.readFileSync(path.join(here, '..', 'public/shop/shop.css'), 'utf8');

test('the box says it searches products, not a category', () => {
  assert.match(shop, /placeholder="Search product…"/,
    'somebody looking for a tub of 888 is not looking for "skincare"');
  assert.ok(!shop.includes('Search skincare'), 'the old wording is gone');
});

test('one house is one brand, however it was typed', () => {
  const at = shop.indexOf('function byBrand(');
  assert.ok(at > 0, 'products are grouped by the house they come from');
  const fn = shop.slice(at, shop.indexOf('\n}', at));
  assert.match(fn, /String\(p\.brand \|\| ''\)\.trim\(\)/,
    '"MERRY SUN " and "MERRY SUN" are one house, not two');
  assert.match(fn, /b\[1\]\.length - a\[1\]\.length/,
    'the houses we carry deepest come first — those are what somebody came for');
});

test('touching the search box opens the suggestions', () => {
  assert.match(shop, /find\.addEventListener\('focus'/,
    'the box opens the suggestions rather than waiting for a keystroke');
  assert.match(shop, /cameFrom = view;\s*\n\s*view = 'suggest';/,
    'and remembers where it was tapped from, so back means something');
  assert.match(shop, /view === 'suggest' \? suggestView\(\)/, 'the view is drawn');
});

test('home is rows of houses, not one column of everything', () => {
  const at = shop.indexOf('function rails(');
  assert.ok(at > 0, 'there is a banded arrangement');
  const fn = shop.slice(at, shop.indexOf('\n}\n', at));
  assert.match(fn, /class="sh-rail"/, 'each house is a rail');
  assert.match(fn, /of\.slice\(0, RAIL\)/,
    'a rail carries the first few, not the whole house');
  assert.match(fn, /sh-railmore/,
    'and offers the rest rather than pretending the house is that small');

  // Searching still wants a wall — a rail per house is for browsing, and
  // somebody who typed a word wants the matches, not an arrangement.
  assert.match(shop, /\$\{term \? grid\(shown\) : rails\(shown\)\}/,
    'a typed search shows results; an untyped page shows houses');
});

test('a rail swipes sideways and the page never does', () => {
  const rail = css.slice(css.indexOf('.sh-rail {'), css.indexOf('.sh-rail {') + 400);
  assert.match(rail, /overflow-x:\s*auto/, 'the rail scrolls');
  assert.match(rail, /scroll-snap-type/, 'and lands on a card rather than between two');
  assert.match(rail, /overscroll-behavior-x:\s*contain/,
    'without handing its momentum to the page behind it');
});

test('a card is drawn once, however it is arranged', () => {
  assert.match(shop, /^function card\(p, named = true\) \{/m,
    'the wall, the bands and the rails all draw the same card');
  const grid = shop.slice(shop.indexOf('function grid(list'), shop.indexOf('function grid(list') + 400);
  assert.match(grid, /list\.map\(\(p\) => card\(p, named\)\)/,
    'the grid uses it rather than keeping a second copy that drifts');
});

test('a house does not repeat its own name on every card', () => {
  const at = shop.indexOf('function suggestView(');
  const fn = shop.slice(at, shop.indexOf('\n}\n', at));
  assert.match(fn, /grid\(shown, false\)/,
    'under a heading that already says the brand, printing it six more times '
    + 'is six copies of a word the eye has just read');
});
