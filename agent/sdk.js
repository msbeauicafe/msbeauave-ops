// The only file that touches ZKTeco's library.
//
// libzkfp.dll is a C library, so this binds to it directly through koffi
// rather than going via the C# wrapper — one fewer runtime to install on a
// shop PC. Every call below is checked against the SDK's own error codes and
// turned into something a shop manager can act on, because "-3" on a screen by
// a door helps nobody.
//
// Two things will stop this working before any of the code is at fault, and
// both are checked at start-up:
//
//   1. Architecture. The SDK ships a 32-bit and a 64-bit libzkfp.dll and they
//      are not interchangeable. Node must match the DLL. A mismatch fails at
//      load with a message that does not say so, hence the check.
//   2. The DLL's folder. libzkfp.dll loads its own dependencies from beside
//      itself, so the SDK's bin folder has to be on PATH — which the SDK
//      installer normally does, and which `zkfpPath` in door.json overrides
//      when it has not.
//
// `SDK_STUB=1` swaps all of it for a pretend scanner, so the clock screen can
// be worked on without hardware.

import fs from 'node:fs';
import os from 'node:os';
import { createRequire } from 'node:module';

const STUB = process.env.SDK_STUB === '1';

// ---------------------------------------------------------------------------
// The SDK's own error codes, in its own words where they are clear enough and
// in ours where they are not.
// ---------------------------------------------------------------------------
const ERR = {
  0: 'ok',
  1: 'the library was already started',
  '-1': 'the library could not be loaded',
  '-2': 'the matching algorithm could not start',
  '-3': 'no scanner is plugged in',
  '-4': 'this scanner does not support that',
  '-5': 'the call was made wrongly (this is our bug, not yours)',
  '-6': 'the scanner would not start — unplug it, wait, plug it back in',
  '-7': 'the scanner handle went stale',
  '-8': 'no finger',
  '-9': 'that print could not be read — wipe the glass and try again',
  '-10': 'the finger did not match the earlier scans',
  '-11': 'that finger is already enrolled',
  '-17': 'the scanner is busy',
  '-18': 'the scanner is in use by another program',
};
const why = (code) => ERR[String(code)] || `the scanner returned ${code}`;

const OK = 0;
const NO_FINGER = -8;

const PARAM_IMAGE_WIDTH = 1;
const PARAM_IMAGE_HEIGHT = 2;

const TEMPLATE_MAX = 2048;    // the SDK's documented ceiling for one template

// A person may enrol more than one finger, and the matcher keys on a single
// number. Employee 144's right index becomes 1441, their left index 1446.
export const keyFor = (employeeId, finger) => employeeId * 10 + finger;
export const personFrom = (key) => Math.floor(key / 10);

// Said before each library call, not after. A wrong signature in an FFI
// binding does not raise an error a program can catch; it takes the process
// down. Which makes the last line written the name of the call that did it —
// the only way to find one of these from a distance.
let trace = () => {};
export const traceTo = (fn) => { trace = fn; };

let koffi = null;
let lib = null;
let fn = {};
let device = null;      // the scanner
let cache = null;       // the matcher, holding this shop's templates
let imageSize = 0;
let loadedCount = 0;

function bind(dllPath) {
  koffi = createRequire(import.meta.url)('koffi');
  lib = koffi.load(dllPath);

  // Handles stay `void *` rather than plain numbers: on 64-bit a handle does
  // not fit in an int, and a truncated one fails in ways that look like
  // hardware faults.
  fn = {
    init:       lib.func('int ZKFPM_Init()'),
    terminate:  lib.func('int ZKFPM_Terminate()'),
    count:      lib.func('int ZKFPM_GetDeviceCount()'),
    openDev:    lib.func('void *ZKFPM_OpenDevice(int index)'),
    closeDev:   lib.func('int ZKFPM_CloseDevice(void *handle)'),
    getParam:   lib.func('int ZKFPM_GetParameters(void *handle, int code, _Inout_ uint8_t *value, _Inout_ uint32_t *size)'),
    acquire:    lib.func('int ZKFPM_AcquireFingerprint(void *handle, _Out_ uint8_t *image, uint32_t imageSize, _Out_ uint8_t *tmpl, _Inout_ uint32_t *tmplSize)'),

    dbInit:     lib.func('void *ZKFPM_DBInit()'),
    dbFree:     lib.func('int ZKFPM_DBFree(void *cache)'),
    dbClear:    lib.func('int ZKFPM_DBClear(void *cache)'),
    dbAdd:      lib.func('int ZKFPM_DBAdd(void *cache, uint32_t fid, uint32_t size, uint8_t *tmpl)'),
    dbDel:      lib.func('int ZKFPM_DBDel(void *cache, uint32_t fid)'),
    dbIdentify: lib.func('int ZKFPM_DBIdentify(void *cache, uint8_t *tmpl, uint32_t size, _Out_ uint32_t *fid, _Out_ uint32_t *score)'),
    dbMatch:    lib.func('int ZKFPM_DBMatch(void *cache, uint8_t *a, uint32_t aSize, uint8_t *b, uint32_t bSize)'),
    dbMerge:    lib.func('int ZKFPM_DBMerge(void *cache, uint8_t *a, uint8_t *b, uint8_t *c, _Out_ uint8_t *out, _Inout_ uint32_t *outSize)'),
  };
}

function findDll(configured) {
  if (configured) {
    if (!fs.existsSync(configured)) {
      throw new Error(`No libzkfp.dll at ${configured}. Check zkfpPath in door.json.`);
    }
    return configured;
  }
  // The installer normally puts it on PATH, in which case the bare name works.
  // These are where it lands when it does not.
  const guesses = [
    'libzkfp.dll',
    'C:\\Program Files\\ZKTeco\\ZKFinger SDK\\bin\\libzkfp.dll',
    'C:\\Program Files (x86)\\ZKTeco\\ZKFinger SDK\\bin\\libzkfp.dll',
    'C:\\Windows\\System32\\libzkfp.dll',
  ];
  return guesses.find((g) => g === 'libzkfp.dll' || fs.existsSync(g)) || 'libzkfp.dll';
}

/**
 * Open the scanner. Returns a line for the log, or throws with something
 * somebody standing at the machine can act on.
 */
export async function open(conf = {}) {
  if (STUB) { device = 'stub'; return 'a pretend scanner (SDK_STUB=1)'; }

  const dll = findDll(conf.zkfpPath);
  try {
    bind(dll);
  } catch (e) {
    if (/not a valid Win32|%1 is not|is not a valid/i.test(e.message)) {
      throw new Error(
        `libzkfp.dll and Node do not match: Node is ${os.arch() === 'x64' ? '64-bit' : '32-bit'} `
        + 'and the DLL is the other one. Install the matching Node, or point zkfpPath at the '
        + "SDK's other bin folder.");
    }
    // The commonest one, and the one whose own message says least: koffi is
    // what lets Node call into the DLL at all, and it arrives with npm.
    if (/Cannot find module 'koffi'/.test(e.message)) {
      throw new Error(
        'The node_modules folder is missing beside this program. It ships inside '
        + 'the download, so the zip was probably not fully extracted — right-click '
        + 'it, choose Extract All, and run from the extracted folder. Everything '
        + 'except the scanner works meanwhile.');
    }
    if (/native Koffi module/i.test(e.message)) {
      throw new Error(
        `No bundled build for ${os.platform()}-${os.arch()}. The download carries `
        + 'the two Windows builds; this looks like a different machine.');
    }
    if (/cannot open|not found|No such file/i.test(e.message)) {
      throw new Error(
        `Could not find libzkfp.dll (tried "${dll}"). Install the ZKFinger SDK, or set `
        + 'zkfpPath in door.json to the full path of the DLL.');
    }
    throw new Error(`Could not load libzkfp.dll: ${e.message}`);
  }

  let r = fn.init();
  // "Already started" is a success, not a failure — it means something opened
  // the library before us and never closed it.
  if (r !== OK && r !== 1) throw new Error(`The fingerprint library would not start: ${why(r)}.`);

  const n = fn.count();
  if (n <= 0) throw new Error('No scanner is plugged in. Check the USB cable.');

  device = fn.openDev(0);
  if (!device) throw new Error('The scanner would not open. Close any other ZKTeco program and try again.');

  // The image buffer has to be exactly the sensor's size, and the sensor is
  // the only thing that knows it.
  const size = (code) => {
    const value = Buffer.alloc(4);
    const len = [4];
    const rc = fn.getParam(device, code, value, len);
    if (rc !== OK) throw new Error(`The scanner would not report its image size: ${why(rc)}.`);
    return value.readUInt32LE(0);
  };
  const w = size(PARAM_IMAGE_WIDTH);
  const h = size(PARAM_IMAGE_HEIGHT);
  imageSize = w * h;
  if (!imageSize) throw new Error('The scanner reported an image size of nothing.');

  cache = fn.dbInit();
  if (!cache) throw new Error('The matching algorithm would not start.');

  return `ZK scanner, ${w}×${h}`;
}

export async function close() {
  if (STUB) { device = null; return; }
  try { if (cache) fn.dbFree(cache); } catch { /* going away anyway */ }
  try { if (device) fn.closeDev(device); } catch { /* ditto */ }
  try { fn.terminate(); } catch { /* ditto */ }
  device = null; cache = null;
}

/**
 * Load this shop's templates into the matcher.
 *
 * @param {{id:number, name:string, finger:number, template:string}[]} people
 */
export async function load(people) {
  if (STUB) { stubPeople = people; loadedCount = people.length; return people.length; }

  // No scanner open means no matcher to load into, and that is a normal state
  // rather than a fault: a door whose reader is unplugged still fetches its
  // shop's list, still answers the clock page, and still says the PIN pad is
  // the way in today. Reaching into the library here was a plain mistake — it
  // turned "no scanner" into a crash on every refresh.
  if (!device || !cache) { loadedCount = 0; return 0; }

  trace('load: emptying the matcher (ZKFPM_DBClear)');
  fn.dbClear(cache);
  let added = 0;
  for (const p of people) {
    const t = Buffer.from(p.template, 'base64');
    trace(`load: adding ${p.name} finger ${p.finger}, ${t.length} bytes (ZKFPM_DBAdd)`);
    const rc = fn.dbAdd(cache, keyFor(p.id, p.finger), t.length, t);
    trace(`load: added, returned ${rc}`);
    if (rc === OK) added++;
    // One unreadable template must not cost the shop its whole door.
    else console.log(`  could not load ${p.name}'s finger ${p.finger}: ${why(rc)}`);
  }
  loadedCount = added;
  return added;
}

/**
 * Wait for a finger and turn it into a template.
 *
 * @returns {Promise<{template: Buffer, quality: number}|null>} null when
 *          nothing was presented, which is the usual answer, all day.
 */
export async function capture(timeoutMs = 3000) {
  if (STUB) { await new Promise((r) => setTimeout(r, 300)); return null; }

  const image = Buffer.alloc(imageSize);
  const until = Date.now() + timeoutMs;
  do {
    const tmpl = Buffer.alloc(TEMPLATE_MAX);
    const len = [TEMPLATE_MAX];
    const rc = fn.acquire(device, image, imageSize, tmpl, len);
    if (rc === OK) return { template: tmpl.subarray(0, len[0]), quality: 100 };
    if (rc !== NO_FINGER) {
      // -9 is a bad read, which happens constantly with dry hands and is not
      // worth shouting about. Anything else is.
      if (rc !== -9) throw new Error(`The scanner: ${why(rc)}.`);
    }
    await new Promise((r) => setTimeout(r, 80));
  } while (Date.now() < until);
  return null;
}

/**
 * Enrol: three scans of the same finger, merged into one registration
 * template. Three because one scan is a photograph of one moment and the
 * matcher wants the parts of a finger that are the same every time.
 *
 * @param {(step:number)=>void} onStep told 1, 2, 3 as each scan lands
 */
export async function enrol(onStep = () => {}) {
  if (STUB) {
    for (let i = 1; i <= 3; i++) { onStep(i); await new Promise((r) => setTimeout(r, 400)); }
    return { template: Buffer.from(`stub-${Date.now()}`), quality: 90 };
  }

  const scans = [];
  while (scans.length < 3) {
    trace(`enrol: waiting for scan ${scans.length + 1}`);
    const got = await capture(30000);
    if (!got) throw new Error('No finger was presented. Try again.');
    trace(`enrol: scan ${scans.length + 1} read, ${got.template.length} bytes`);

    // The same finger, three times — not one finger held down for three. The
    // SDK cannot tell those apart, so wait for the finger to come off.
    if (scans.length) {
      trace('enrol: comparing against the first scan (ZKFPM_DBMatch)');
      const same = fn.dbMatch(cache, scans[0], scans[0].length, got.template, got.template.length);
      trace(`enrol: comparison came back ${same}`);
      if (same <= 0) throw new Error('That was a different finger. Start again with one finger.');
    }
    scans.push(got.template);
    onStep(scans.length);
    if (scans.length < 3) { trace('enrol: waiting for the finger to lift'); await waitForLift(); }
  }

  const out = Buffer.alloc(TEMPLATE_MAX);
  const len = [TEMPLATE_MAX];
  trace('enrol: merging the three scans (ZKFPM_DBMerge)');
  const rc = fn.dbMerge(cache, scans[0], scans[1], scans[2], out, len);
  trace(`enrol: merge came back ${rc}, ${len[0]} bytes`);
  if (rc !== OK) throw new Error(`Those three scans would not combine: ${why(rc)}.`);
  return { template: out.subarray(0, len[0]), quality: 100 };
}

/** Wait until the finger comes off the glass, so the next scan is a new one. */
async function waitForLift(timeoutMs = 10000) {
  const image = Buffer.alloc(imageSize);
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const tmpl = Buffer.alloc(TEMPLATE_MAX);
    const len = [TEMPLATE_MAX];
    if (fn.acquire(device, image, imageSize, tmpl, len) === NO_FINGER) return;
    await new Promise((r) => setTimeout(r, 100));
  }
}

/**
 * Match a captured template against the loaded shop.
 *
 * @returns {Promise<{id:number, score:number}|null>} null when nobody matches,
 *          and deliberately silent about why: a screen by the door is not a
 *          place to learn whose fingers are on file.
 */
export async function identify(template, minScore = 55) {
  if (STUB) {
    const last = stubPeople[stubPeople.length - 1];
    return last ? { id: last.id, score: 99 } : null;
  }

  const fid = [0];
  const score = [0];
  trace(`identify: matching ${template.length} bytes against ${loadedCount} (ZKFPM_DBIdentify)`);
  const rc = fn.dbIdentify(cache, template, template.length, fid, score);
  trace(`identify: returned ${rc}, id ${fid[0]}, score ${score[0]}`);
  if (rc !== OK) return null;
  // ZKTeco's own demo treats a low score as no match rather than trusting
  // whatever comes back, and so should we — a wrong name on an attendance
  // record is worse than no name.
  if (score[0] < minScore) return null;
  return { id: personFrom(fid[0]), score: score[0] };
}

let stubPeople = [];

export const ready = () => device !== null;
export const holding = () => loadedCount;
