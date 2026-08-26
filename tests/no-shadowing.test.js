// The screen's shared formatters must keep their names.
//
// `count`, `peso`, `esc` and the rest are declared once at the top of app.js
// and called from inside hundreds of template strings. A local variable that
// takes one of those names does not fail to parse and does not fail a test —
// it throws at the moment somebody uses the screen, and takes the whole
// render with it. That is exactly how the product list came to draw its
// heading and nothing else: a `const count` two lines above a `count(...)`.
//
// Cheap to check, and it checks the one thing a browserless test suite
// otherwise cannot see.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const source = fs.readFileSync(path.join(here, '..', 'public', 'app.js'), 'utf8');

// The names declared at the very top of the file, in column zero, which is
// what makes them the shared ones rather than somebody's local.
const shared = [...source.matchAll(/^(?:const|let|function)\s+([A-Za-z_$][\w$]*)/gm)]
  .map((m) => m[1]);

test('no local variable takes the name of a shared formatter', () => {
  const formatters = ['count', 'peso', 'esc', 'tag', 'when', 'onDay', 'table',
                      'localDay', 'roleName', 'dialog', 'notice', 'whoops'];
  const guarded = formatters.filter((n) => shared.includes(n));
  assert.ok(guarded.length >= 8, `expected to find the formatters at top level, saw ${guarded}`);

  const offences = [];
  for (const name of guarded) {
    // Indented, therefore inside something: a declaration that hides the
    // top-level one from every template string in that scope.
    const shadow = new RegExp(`^[ \\t]+(?:const|let|var)\\s+${name}\\s*=`, 'gm');
    for (const m of source.matchAll(shadow)) {
      const line = source.slice(0, m.index).split('\n').length;
      offences.push(`${name} shadowed at public/app.js:${line}`);
    }
  }
  assert.deepEqual(offences, [], offences.join('\n'));
});
