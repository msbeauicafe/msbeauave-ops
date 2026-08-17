// The only file that touches ZKTeco's library.
//
// Everything about this project that cannot be written from here is in this
// one file, on purpose. The scanner is in Marikina and the SDK is a Windows
// DLL behind a partner login, so the honest thing to do is put the four calls
// that need it in one place, say exactly what each must return, and make the
// rest of the agent runnable without any of it.
//
// `SDK_STUB=1` swaps in a fake scanner good enough to build the clock screen
// against: it invents templates, and "recognises" whoever was enrolled last.
//
// ---------------------------------------------------------------------------
// Filling this in
//
// The Windows SDK ships a C DLL (`libzkfp.dll`) and a .NET wrapper. From Node
// the shortest path is koffi (a maintained FFI binding) against the C API:
//
//   const koffi = require('koffi');
//   const lib = koffi.load('libzkfp.dll');
//   const ZKFPM_Init        = lib.func('int ZKFPM_Init()');
//   const ZKFPM_OpenDevice  = lib.func('void* ZKFPM_OpenDevice(int index)');
//   const ZKFPM_AcquireFingerprint = lib.func(
//     'int ZKFPM_AcquireFingerprint(void* handle, uint8_t* image, uint32_t size,'
//     + ' uint8_t* template, uint32_t* tlen)');
//
// The matching half is a second handle from `ZKFPM_DBInit`, with
// `ZKFPM_DBAdd` to load each enrolled template and `ZKFPM_DBIdentify` to match
// a fresh capture against everything loaded. That is the 1:N search, and it is
// why the templates come down to the door at all.
//
// Check the call signatures against the SDK's own header rather than against
// this comment — ZKTeco has changed them between versions, and a wrong
// signature in an FFI binding crashes the process rather than erroring.
// ---------------------------------------------------------------------------

const STUB = process.env.SDK_STUB === '1';

let device = null;
let loaded = [];

/**
 * Open the scanner. Returns a short description for the log, or throws with
 * something a shop manager can act on.
 */
export async function open() {
  if (STUB) { device = 'stub'; return 'a pretend scanner (SDK_STUB=1)'; }

  // TODO(sdk): ZKFPM_Init(), then ZKFPM_OpenDevice(0). Throw if the count of
  // devices is zero — that is "the scanner is unplugged", and it should say so
  // in those words rather than as an error code.
  throw new Error(
    'The ZKTeco library is not wired up yet. Fill in agent/sdk.js, or run with '
    + 'SDK_STUB=1 to work on the clock screen without a scanner.');
}

export async function close() {
  if (STUB) { device = null; return; }
  // TODO(sdk): ZKFPM_CloseDevice(handle), then ZKFPM_Terminate().
  device = null;
}

/**
 * Load the shop's templates for matching against.
 *
 * @param {{id:number, name:string, finger:number, template:string}[]} people
 *        templates base64 as they came off the website
 */
export async function load(people) {
  loaded = people;
  if (STUB) return people.length;
  // TODO(sdk): ZKFPM_DBInit() once, then ZKFPM_DBAdd(cache, id, template) for
  // each. The id passed here is what ZKFPM_DBIdentify hands back, so pass the
  // employee id and nothing cleverer.
  return people.length;
}

/**
 * Wait for a finger and turn it into a template.
 *
 * @returns {Promise<{template: Buffer, quality: number}|null>} null when
 *          nothing was presented before the timeout, which is not an error —
 *          it is the usual answer, several times a second, all day.
 */
export async function capture(_timeoutMs = 3000) {
  if (STUB) {
    await new Promise((r) => setTimeout(r, 300));
    return null;
  }
  // TODO(sdk): ZKFPM_AcquireFingerprint into an image buffer and a template
  // buffer. Return null on the "no finger" code rather than throwing.
  throw new Error('capture() is not wired up yet.');
}

/**
 * Match a captured template against the loaded shop.
 *
 * @returns {Promise<{id:number, score:number}|null>} null when nobody matches,
 *          which must stay silent about why — a screen by the door is not a
 *          place to learn whose fingers are on file.
 */
export async function identify(_template) {
  if (STUB) {
    const last = loaded[loaded.length - 1];
    return last ? { id: last.id, score: 99 } : null;
  }
  // TODO(sdk): ZKFPM_DBIdentify(cache, template, &id, &score). ZKTeco's own
  // demo treats a score below about 55 as no match; do the same rather than
  // accepting whatever comes back.
  throw new Error('identify() is not wired up yet.');
}

export const ready = () => device !== null;
export const holding = () => loaded.length;
