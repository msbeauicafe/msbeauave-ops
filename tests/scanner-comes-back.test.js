// A scanner that was not there at startup is picked up without a restart.
//
// The day this was written, Windows decided the fingerprint SDK's helper file
// had arrived from the internet and refused to load it. Unblocking the file
// took a minute. The door then went on reporting "no scanner" for the rest of
// the afternoon with a working reader plugged into it, because door.js asked
// the scanner exactly once, at startup, and treated the answer as final.
//
// So this stages that afternoon. The pretend scanner refuses the first time it
// is asked and answers every time after, and the test watches one running door
// — never restarted, never touched — go from no scanner to a scanner on its
// own. If somebody puts the one-shot open back, /hello stays false here and
// this fails.
//
// Nothing real is involved: SDK_STUB=1 means no DLL, no USB, no website.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const agent = path.join(here, '..', 'agent');
const CONF = path.join(agent, 'door.json');
const LOG = path.join(agent, 'door-log.txt');

// A door PC would have a real door.json, and a real door-log.txt worth
// keeping. Never write over either: put ours in place only when the folder is
// bare, and take it away again afterwards.
const occupied = fs.existsSync(CONF);

// Nothing here reaches the website. Port 9 is discard — signIn fails, the door
// says so, and carries on, which is itself the behaviour we want it to have.
const PORT = 9531;
const hello = (port) => fetch(`http://127.0.0.1:${port}/hello`).then((r) => r.json());

const until = async (port, want, ms) => {
  const stop = Date.now() + ms;
  for (;;) {
    try { const h = await hello(port); if (want(h)) return h; } catch { /* not up yet */ }
    if (Date.now() > stop) return null;
    await new Promise((r) => setTimeout(r, 150));
  }
};

test('a scanner that refused at startup is picked up without a restart', async (t) => {
  if (occupied) return t.skip('this machine has a real door.json — leaving it alone');

  fs.writeFileSync(CONF, JSON.stringify({
    shop: 1, site: 'http://127.0.0.1:9', port: PORT,
    username: 'nobody', password: 'nothing',
  }));

  const door = spawn(process.execPath, ['door.js'], {
    cwd: agent,
    env: {
      ...process.env,
      SDK_STUB: '1',
      SDK_STUB_REFUSALS: '1',   // blocked once, exactly like the real morning
      SCANNER_RETRY_MS: '700',  // thirty seconds is a long time to sit in a test
    },
    stdio: 'ignore',
  });

  t.after(async () => {
    door.kill();
    fs.rmSync(CONF, { force: true });
    fs.rmSync(LOG, { force: true });
  });

  // It comes up refusing, and says why rather than leaving a bare false.
  const first = await until(PORT, (h) => h.agent === 'msbeauave-door', 10000);
  assert.ok(first, 'the door never started listening');
  assert.equal(first.scanner, false, 'the stub was told to refuse the first open');
  assert.match(first.scannerError, /Application Control policy/,
    '/hello has to carry the reason — that reason was buried in a log file for an afternoon');

  // Nothing is restarted, nothing is clicked. It simply asks again.
  const later = await until(PORT, (h) => h.scanner === true, 10000);
  assert.ok(later, 'the door never picked the scanner up — the one-shot open is back');
  assert.equal(later.scannerError, null, 'a scanner that opened has nothing left to explain');

  const log = fs.readFileSync(LOG, 'utf8');
  assert.match(log, /the scanner answered this time/,
    'the log should say it recovered, so tomorrow nobody has to guess why it works');
});

test('a scanner that never answers is complained about once, not endlessly', async (t) => {
  if (occupied) return t.skip('this machine has a real door.json — leaving it alone');

  fs.writeFileSync(CONF, JSON.stringify({
    shop: 1, site: 'http://127.0.0.1:9', port: PORT + 1,
    username: 'nobody', password: 'nothing',
  }));

  const door = spawn(process.execPath, ['door.js'], {
    cwd: agent,
    env: {
      ...process.env,
      SDK_STUB: '1',
      SDK_STUB_REFUSALS: '999',
      SCANNER_RETRY_MS: '300',
    },
    stdio: 'ignore',
  });

  t.after(async () => {
    door.kill();
    fs.rmSync(CONF, { force: true });
    fs.rmSync(LOG, { force: true });
  });

  const up = await until(PORT + 1, (h) => h.agent === 'msbeauave-door', 10000);
  assert.ok(up, 'the door never started listening');
  assert.equal(up.scanner, false);

  // Long enough for a dozen refusals at 300ms.
  await new Promise((r) => setTimeout(r, 4000));

  const said = fs.readFileSync(LOG, 'utf8')
    .split('\n').filter((l) => /Application Control policy/.test(l)).length;
  assert.equal(said, 1,
    `the same refusal was logged ${said} times — a log nobody can read is a log nobody reads`);

  // And it is still saying so, rather than having quietly given up.
  assert.match((await hello(PORT + 1)).scannerError, /Application Control policy/);
});

// The agent does not update itself — somebody copies door.js onto each shop
// PC by hand. So /hello has to say which one it is, and the number in it has
// to be the number in package.json, or asking a machine what it is running
// gets an answer that was true two releases ago.
test('a door says which version of itself it is running', async (t) => {
  if (occupied) return t.skip('this machine has a real door.json — leaving it alone');

  const stated = JSON.parse(fs.readFileSync(path.join(agent, 'package.json'), 'utf8')).version;

  fs.writeFileSync(CONF, JSON.stringify({
    shop: 1, site: 'http://127.0.0.1:9', port: PORT + 2,
    username: 'nobody', password: 'nothing',
  }));

  const door = spawn(process.execPath, ['door.js'], {
    cwd: agent,
    env: { ...process.env, SDK_STUB: '1' },
    stdio: 'ignore',
  });

  t.after(async () => {
    door.kill();
    fs.rmSync(CONF, { force: true });
    fs.rmSync(LOG, { force: true });
  });

  const up = await until(PORT + 2, (h) => h.agent === 'msbeauave-door', 10000);
  assert.ok(up, 'the door never started listening');
  assert.equal(up.version, stated,
    `/hello says ${up.version} and package.json says ${stated} — they have drifted`);
});
