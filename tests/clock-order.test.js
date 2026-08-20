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
// Two slices rather than one long one. todayLine builds markup and so goes
// through esc() like everything else on the page, but everything between the
// two of them touches the DOM and would run on import.
const escaper = clock.slice(clock.indexOf('const esc ='), clock.indexOf('const GET'));
const source = escaper
  + clock.slice(clock.indexOf('const arrivals ='), clock.indexOf('function draw()'));
assert.ok(escaper.includes('replace('), 'the escaper moved; this test needs updating');
assert.ok(source.includes('const arrivals'), 'the sort moved; this test needs updating');
const arrivals = new Function(`${source} return arrivals;`)();
assert.ok(source.includes('function todayLine'), 'the times line moved; this test needs updating');
const todayLine = new Function(`${source} return todayLine;`)();

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

// ---------------------------------------------------------------------------
// The times under a face
//
// Manila is UTC+8, and the door board is the one screen in the building where
// getting that wrong is loud: eight hours out puts the morning shift's arrival
// in the middle of the night. So these fix the offset as well as the wording.
// ---------------------------------------------------------------------------
test('somebody on shift is shown when they arrived, and nothing else', () => {
  const line = todayLine({ on_shift: true, since: at('01:05'), today_in: at('01:05') });
  assert.match(line, /9:05/, '01:05 UTC is quarter past nine in Manila');
  assert.match(line, /In /);
  assert.match(line, /class="times in"/, 'green, because the board is answering "am I on"');
  assert.doesNotMatch(line, /–/, 'they have not gone anywhere');
  assert.match(line, /Tue, Aug 18/, 'and the day it happened, so a stalled tab gives itself away');
});

test('somebody who has gone is shown the stretch they worked', () => {
  const line = todayLine({
    on_shift: false, since: null, today_in: at('01:02'), today_out: at('09:10'),
  });
  assert.match(line, /9:02/);
  assert.match(line, /5:10/, 'and out at ten past five');
  assert.match(line, /–/);
  assert.doesNotMatch(line, /times in/, 'not green — that colour means still here');
});

test('a face nobody has clocked on today carries no times at all', () => {
  assert.equal(todayLine({ on_shift: false, since: null, today_in: null, today_out: null }), '');
});

test('back from lunch shows the stretch they are in, not the one they finished', () => {
  // Two shifts in a day: out at noon, in again at one. The view hands back the
  // most recent stretch, so today_out is null again — but if it ever were not,
  // being on shift has to win. A face reading "9:00 – 12:00" beside a green
  // dot is the board contradicting itself.
  const line = todayLine({
    on_shift: true, since: at('05:00'), today_in: at('05:00'), today_out: at('04:00'),
  });
  assert.match(line, /In 1:00/);
  assert.doesNotMatch(line, /–/);
});

test('the small hours are dated by Manila, not by the server', () => {
  // Manila is eight hours ahead, so this instant is half past one on the
  // Thursday morning here and still Wednesday afternoon in UTC. The board
  // stands in Bayan Bayanan and has to agree with the wall behind it.
  const line = todayLine({ on_shift: true, since: '2026-08-19T17:30:00.000Z' });
  assert.match(line, /Thu, Aug 20/);
  assert.doesNotMatch(line, /Aug 19/, 'the server\'s date is not the shop\'s date');
  assert.match(line, /In 1:30/);
});

test('the pair of times is dated from the arrival, not the departure', () => {
  const line = todayLine({
    on_shift: false, since: null,
    today_in: '2026-08-19T13:00:00.000Z', today_out: '2026-08-19T21:00:00.000Z',
  });
  assert.match(line, /Wed, Aug 19/, 'the shift belongs to the day it started');
  assert.doesNotMatch(line, /Thu/, 'even though it ended after midnight');
});

test('the clock on the wall is the shop\'s, not the machine\'s', () => {
  // Found by photographing the door page on a machine set to UTC: every time
  // on it read Manila except the one in the corner, which read eight hours
  // earlier. A door with its timezone set wrong would show one time and record
  // another, which is the worst way for an hours record to be wrong — it looks
  // right to the person standing there.
  const header = clock.slice(clock.indexOf('const tick ='), clock.indexOf('setInterval(tick'));
  assert.match(header, /timeZone: 'Asia\/Manila'/,
    'the header clock must be pinned to Manila like everything else on the page');
});
