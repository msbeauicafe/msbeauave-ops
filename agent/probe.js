// Which way round does ZKFPM_DBAdd take its arguments?
//
// ZKTeco's C API is not consistent about it. DBMatch and DBIdentify take a
// pointer and then its length; the C# wrapper's DBAdd looks like it takes the
// length and then the pointer. Guessing wrong does not return an error — the
// wrong one puts an integer where a pointer belongs, the library dereferences
// it, and the process dies where it stands. Which is exactly what happened on
// the first real template.
//
// So this asks the question in a process that is allowed to die. The door runs
// it, once, in a child; if the child survives, that order is the right one and
// gets written down. Nothing in the shop notices either way.
//
//     node probe.js <dll> <order> <base64 template>
//
// order is "len-first" or "ptr-first". Exits 0 only if the call returned
// cleanly. Any crash is the answer to the question.
import { createRequire } from 'node:module';

const [dll, order, b64] = process.argv.slice(2);
const template = Buffer.from(b64, 'base64');

try {
  const koffi = createRequire(import.meta.url)('koffi');
  const lib = koffi.load(dll);

  const init = lib.func('int ZKFPM_Init()');
  const dbInit = lib.func('void *ZKFPM_DBInit()');
  const dbAdd = order === 'len-first'
    ? lib.func('int ZKFPM_DBAdd(void *cache, uint32_t fid, uint32_t size, uint8_t *tmpl)')
    : lib.func('int ZKFPM_DBAdd(void *cache, uint32_t fid, uint8_t *tmpl, uint32_t size)');

  const r = init();
  if (r !== 0 && r !== 1) { console.log(`init failed: ${r}`); process.exit(2); }

  // The matcher is its own thing — it needs no scanner, which is what makes
  // this safe to ask while the door has the device open.
  const cache = dbInit();
  if (!cache) { console.log('no matcher'); process.exit(2); }

  const rc = order === 'len-first'
    ? dbAdd(cache, 1441, template.length, template)
    : dbAdd(cache, 1441, template, template.length);

  // A wrong order can also survive and simply refuse, so a bad return is a
  // no as much as a crash is.
  console.log(`rc=${rc}`);
  process.exit(rc === 0 ? 0 : 3);
} catch (e) {
  console.log(`threw: ${e.message}`);
  process.exit(2);
}
