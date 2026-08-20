// Every time on every screen is the shop's time.
//
// Found by photographing the door board from a machine set to UTC: the
// arrivals, the departures and the date under each face all read Manila,
// because those are pinned — and the clock in the corner read eight hours
// earlier, because it was not. A door whose PC has the wrong timezone would
// have shown one time on the wall while recording another, which is the worst
// way for an hours record to be wrong. It looks right to the person standing
// in front of it.
//
// This walks the shipped files rather than testing a helper, because the fault
// is never in the helper. It is in the one call somebody wrote in a hurry
// three thousand lines away from the others.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const pub = path.join(here, '..', 'public');

const SCREENS = ['clock/clock.js', 'app.js', 'shop/shop.js', 'portal/index.html'];

// A number formatted for the Philippines has no timezone to get wrong; only a
// date or a time does. These are the option names that mean one is being read.
const SHOWS_A_MOMENT = /\b(dateStyle|timeStyle|hour|minute|weekday|day|month|year)\b/;

test('nothing shows a time in the machine\'s timezone instead of the shop\'s', () => {
  const unpinned = [];
  for (const rel of SCREENS) {
    const file = path.join(pub, rel);
    if (!fs.existsSync(file)) continue;
    const src = fs.readFileSync(file, 'utf8');
    // Across the whole call rather than line by line: most of them wrap, and a
    // line-based check would pass while the option sat on the next line.
    for (const m of src.matchAll(/toLocale(?:Time|Date)?String\('en-[A-Z]{2}'\s*,\s*(\{.*?\})/gs)) {
      const opts = m[1];
      if (!SHOWS_A_MOMENT.test(opts)) continue;
      if (opts.includes('timeZone')) continue;
      unpinned.push(`${rel}:${src.slice(0, m.index).split('\n').length}`);
    }
  }
  assert.deepEqual(unpinned, [],
    `these render a date or time without naming the shop's timezone: ${unpinned.join(', ')}`);
});

test('the audit would notice one that was not pinned', () => {
  // A test that walks source files can pass because its own pattern stopped
  // matching anything. This proves the pattern still finds what it is for.
  const sample = `const when = (v) => new Date(v).toLocaleString('en-PH',
    { dateStyle: 'medium', timeStyle: 'short' });`;
  const found = [...sample.matchAll(
    /toLocale(?:Time|Date)?String\('en-[A-Z]{2}'\s*,\s*(\{.*?\})/gs)]
    .filter((m) => SHOWS_A_MOMENT.test(m[1]) && !m[1].includes('timeZone'));
  assert.equal(found.length, 1, 'the audit must still catch an unpinned call');
});
