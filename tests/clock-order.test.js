// The order faces appear in on the door screen.
//
// Small, and worth pinning down: it is the difference between somebody finding
// themselves in a second and reading a wall of fifty faces twice. The rule is
// that the board fills from the top as the shift starts — whoever is on comes
// first, in the order they walked in — and everybody still to come stays
// alphabetical below, where a name can be found by looking.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

// Lifted from the page it runs in rather than copied, so a change to the rule
// has to come through here.
const clock = fs.readFileSync(path.join(here, '..', 'public', 'clock', 'clock.js'), 'utf8');
const source = clock.slice(clock.indexOf('const arrivals ='), clock.indexOf('function draw()'));
assert.ok(source.includes('const arrivals'), 'the sort moved; this test needs updating');
const arrivals = new Function(`${source} return arrivals;`)();

const at = (hhmm) => `2026-08-18T${hhmm}:00.000Z`;
const on = (name, since) => ({ name, on_shift: true, since });
const off = (name) => ({ name, on_shift: false, since: null });
const order = (people) => people.slice().sort(arrivals).map((p) => p.name);

test('whoever is on shift comes first, in the order they arrived', () => {
  assert.deepEqual(order([
    off('Zenaida Cruz'),
    on('Adona Marie Belen', at('09:05')),
    off('Basty Costan'),
    on('Sonny Lorica', at('08:58')),
    off('Alliah Tulabing'),
  ]), [
    'Sonny Lorica',        // first in, first on the board
    'Adona Marie Belen',
    'Alliah Tulabing',     // and the rest alphabetical underneath
    'Basty Costan',
    'Zenaida Cruz',
  ]);
});

test('two people clocking on together do not make the board shuffle', () => {
  // A queue at the door puts several through in the same second. Falling back
  // to the name keeps that stable, rather than leaving it to sort order.
  const same = at('09:05');
  assert.deepEqual(order([on('Caila Ang', same), on('Basty Costan', same)]),
    ['Basty Costan', 'Caila Ang']);
  assert.deepEqual(order([on('Basty Costan', same), on('Caila Ang', same)]),
    ['Basty Costan', 'Caila Ang']);
});

test('nobody on shift leaves the board alphabetical', () => {
  // The state the shop opens in, and the one it closes in.
  assert.deepEqual(order([off('Zenaida Cruz'), off('Alliah Tulabing'), off('Basty Costan')]),
    ['Alliah Tulabing', 'Basty Costan', 'Zenaida Cruz']);
});

test('clocking out drops somebody back into the alphabet', () => {
  // The board is read from the top all day; somebody who has gone home should
  // not still be sitting at the front of it.
  const before = order([on('Zenaida Cruz', at('08:00')), off('Alliah Tulabing'), off('Basty Costan')]);
  assert.deepEqual(before, ['Zenaida Cruz', 'Alliah Tulabing', 'Basty Costan']);
  const after = order([off('Zenaida Cruz'), off('Alliah Tulabing'), off('Basty Costan')]);
  assert.deepEqual(after, ['Alliah Tulabing', 'Basty Costan', 'Zenaida Cruz']);
});

test('a missing arrival time never throws the board away', () => {
  // on_shift comes from one column and since from another; a shift row that
  // arrives half-written must still leave everybody on screen and in a
  // sensible order, because a clock nobody can use is worse than an odd sort.
  const shown = order([off('Basty Costan'), on('Caila Ang', null), on('Adona Belen', at('09:00'))]);
  assert.equal(shown.length, 3);
  assert.equal(shown[shown.length - 1], 'Basty Costan', 'whoever is off is still last');
  assert.ok(shown.includes('Caila Ang') && shown.includes('Adona Belen'));
});
