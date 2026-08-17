// Prove the scanner works on this machine, before blaming anything else.
//
// Run this first, at the PC, with the scanner plugged in:
//
//     npm run selftest
//
// It goes through the same calls the door agent makes, one at a time, and
// stops at the first one that fails with what to do about it. If this passes
// and the clock still does not see a finger, the problem is the website or the
// browser — not the hardware, and not the driver.
import fs from 'node:fs';
import os from 'node:os';
import * as sdk from './sdk.js';

// Everything printed here is appended to install-log.txt as well, because the
// window this runs in is usually closed before anybody thinks to write down
// what it said.
const LOG = new URL('./install-log.txt', import.meta.url);
const write = (line) => {
  console.log(line);
  try { fs.appendFileSync(LOG, line.replace(/^\s+/, '') + '\n'); } catch { /* the log is a nicety */ }
};
const tick = (s) => write(`  ok    ${s}`);
const cross = (s) => write(`  FAIL  ${s}`);

console.log('\nMS BEAU AVE — scanner self-test\n');
write(`  Node ${process.version}, ${os.arch() === 'x64' ? '64-bit' : '32-bit'}, on ${os.platform()}`);
if (os.platform() !== 'win32') {
  console.log('\n  Note: this is not Windows. The ZKFinger SDK for Windows will not load here.');
  console.log('  Run SDK_STUB=1 npm start to exercise everything except the scanner.\n');
}

let conf = {};
try {
  conf = JSON.parse(fs.readFileSync(new URL('./door.json', import.meta.url), 'utf8'));
  tick(`door.json read — shop ${conf.shop}`);
} catch {
  cross('door.json is missing. Copy door.example.json to door.json and fill it in.');
  process.exit(1);
}

let opened = false;
try {
  const what = await sdk.open(conf);
  opened = true;
  tick(`scanner opened — ${what}`);
} catch (e) {
  cross(e.message);
  console.log('\n  Nothing below this point can be tested until that is fixed.\n');
  process.exit(1);
}

console.log('\n  Put a finger on the scanner and hold it there…\n');
try {
  const got = await sdk.capture(20000);
  if (!got) {
    cross('nothing was read in 20 seconds — is the glass clean, and the light on?');
  } else {
    tick(`a print was read — ${got.template.length} byte template`);

    console.log('\n  Now the enrolment path: the same finger three times.');
    console.log('  Lift it between each one.\n');
    const made = await sdk.enrol((step) => console.log(`        scan ${step} of 3`));
    tick(`three scans merged — ${made.template.length} byte registration template`);

    // Load it into the matcher and match it against itself: this is exactly
    // what the door does, minus the website.
    await sdk.load([{ id: 999, name: 'self-test', finger: 1,
                      template: made.template.toString('base64') }]);
    tick('template loaded into the matcher');

    console.log('\n  Last one — put the same finger on once more.\n');
    const again = await sdk.capture(20000);
    if (!again) cross('nothing was read that time');
    else {
      const hit = await sdk.identify(again.template);
      if (hit && hit.id === 999) tick(`recognised, score ${hit.score}`);
      else cross('the finger was read but not recognised — enrol again, pressing flat');
    }
  }
} catch (e) {
  cross(e.message);
} finally {
  if (opened) await sdk.close();
}

console.log('\n  Done. If every line says ok, the scanner half is working.\n');
