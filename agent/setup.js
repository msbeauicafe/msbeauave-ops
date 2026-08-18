// Setting a machine up, in one conversation.
//
// There are four things to get right on a shop PC — what this machine is,
// which shop it belongs to, whether it starts by itself, and where to click
// afterwards — and until now they were four separate jobs done in three
// different places. Somebody standing at a counter should be asked four
// questions and then be finished.
import fs from 'node:fs';
import readline from 'node:readline/promises';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const FILE = path.join(here, 'door.json');
const EXAMPLE = path.join(here, 'door.example.json');

const tty = process.stdin.isTTY;
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
// Run without a keyboard — from a script, or a double-click that lost its
// console — and it takes the sensible answer rather than hanging on a prompt
// nobody can see.
const ask = {
  question: async (q, fallback = '') => {
    if (!tty) { console.log(q + fallback + '   (no keyboard — taking the usual answer)'); return fallback; }
    return rl.question(q);
  },
};
const say = (s = '') => console.log(s);
const run = (cmd, args) => spawnSync(cmd, args, { cwd: here, encoding: 'utf8', shell: true });

say();
say('  ┌──────────────────────────────────────────┐');
say('  │  MS BEAU AVE — setting up this machine   │');
say('  └──────────────────────────────────────────┘');
say();

// --- 1. Is Node here, and is it the right one? ------------------------------
const major = Number(process.versions.node.split('.')[0]);
if (major < 20) {
  say(`  Node ${process.versions.node} is too old — 20 or newer is needed.`);
  say('  Get the LTS installer from https://nodejs.org and run this again.');
  say();
  await ask.question('  Press Enter to close. ', '');
  process.exit(1);
}
say(`  Node ${process.versions.node} (${process.arch}) — good.`);

if (!fs.existsSync(path.join(here, 'node_modules', 'koffi'))) {
  say();
  say('  The node_modules folder is missing, so the zip was not fully extracted.');
  say('  Right-click the download, choose Extract All, and run this from the');
  say('  extracted folder rather than from inside the zip window.');
  say();
  await ask.question('  Press Enter to close. ', '');
  process.exit(1);
}
say('  The scanner parts are here — nothing to download.');

// --- 2. What is this machine? -----------------------------------------------
say();
say('  What is this computer?');
say();
say('    1   The office PC, for enrolling people');
say('        (holds the scanner, and clocks nobody on)');
say();
say('    2   The door at Bayan Bayanan');
say('    3   The door at Dao');
say();

let choice = '';
while (!['1', '2', '3'].includes(choice)) {
  choice = (await ask.question('  Type 1, 2 or 3 and press Enter: ', '1')).trim();
}

const conf = JSON.parse(fs.readFileSync(fs.existsSync(FILE) ? FILE : EXAMPLE, 'utf8'));
conf.desk = choice === '1';
if (choice === '2') conf.shop = 1;
if (choice === '3') conf.shop = 2;
fs.writeFileSync(FILE, JSON.stringify(conf, null, 2) + '\n');

const what = choice === '1' ? 'the enrolment desk'
  : choice === '2' ? "Bayan Bayanan's door" : "Dao's door";
const address = choice === '1' ? 'http://127.0.0.1:9500/office' : 'http://127.0.0.1:9500/';

say();
say(`  Set. This machine is ${what}.`);
if (choice === '1') {
  say('  A finger here enrols somebody. It will not clock anybody on, which is');
  say('  what you want while sixty-odd people are pressing the glass.');
} else {
  say(`  It will only ever hold that shop's fingerprints — nobody else's.`);
}

// --- 3. A shortcut, so nobody has to remember an address --------------------
say();
const wantLink = (await ask.question('  Put a shortcut on the Desktop? (Y/n) ', 'y')).trim().toLowerCase();
if (wantLink !== 'n') {
  const name = choice === '1' ? 'MBA enrolment desk' : 'MBA time clock';
  const link = path.join(os.homedir(), 'Desktop', `${name}.url`);
  try {
    fs.writeFileSync(link, `[InternetShortcut]\r\nURL=${address}\r\n`);
    say(`  Done — "${name}" is on the Desktop.`);
  } catch (e) {
    say(`  Could not write the shortcut (${e.message}). Open ${address} instead.`);
  }
}

// --- 4. Should it start by itself? ------------------------------------------
say();
say('  Should this start automatically when the PC is switched on?');
say('  A shop opening at nine should not depend on somebody remembering.');
say();
const wantService = (await ask.question('  Install it as a Windows service? (Y/n) ', 'n')).trim().toLowerCase();

if (wantService !== 'n') {
  const admin = run('net', ['session']).status === 0;
  if (!admin) {
    say();
    say('  Windows needs permission for that one. Close this, then RIGHT-CLICK');
    say('  SETUP.bat and choose "Run as administrator", and answer the same way.');
    say('  Everything else is already saved.');
  } else {
    say();
    say('  Fetching what the service needs — a minute, and it needs the internet.');
    const got = run('npm', ['install', '-g', 'node-windows', '--no-audit', '--no-fund']);
    if (got.status !== 0) {
      say('  That did not work:');
      say('  ' + (got.stderr || got.stdout || '').trim().split('\n').slice(-4).join('\n  '));
      say('  The door still runs by hand — see below.');
    } else {
      const made = run(process.execPath, ['service-install.js']);
      say('  ' + (made.stdout || made.stderr || '').trim().split('\n').join('\n  '));
    }
  }
}

// --- 5. Start it, since that is plainly the next thing ----------------------
//
// Telling somebody where to click and then not starting the thing they would
// be clicking on is not a finished job. It was the last step left standing on
// its own, so it stops standing on its own.
let started = false;
if (wantService === 'n') {
  say();
  const go = (await ask.question('  Start it now? (Y/n) ', 'n')).trim().toLowerCase();
  if (go !== 'n') {
    spawn('cmd', ['/c', 'start', '""', 'START-THE-DOOR.bat'],
      { cwd: here, detached: true, stdio: 'ignore', shell: false }).unref();
    started = true;
    say('  Started, in a window of its own. Leave it open — closing it stops');
    say('  the scanner. Give it a few seconds before opening the address below.');
  }
}

// --- Where to go now --------------------------------------------------------
say();
say('  ────────────────────────────────────────────');
say(`  Open:  ${address}`);
say();
if (wantService !== 'n') {
  say('  If the service installed, it is already running and will come back on');
  say('  its own after a restart. If it did not, START-THE-DOOR.bat still works.');
} else if (started) {
  say('  It is running now. Next time, double-click START-THE-DOOR.bat first —');
  say('  or run this again and say yes to the service, and it will start itself.');
} else {
  say('  Start it by double-clicking START-THE-DOOR.bat, and leave that window');
  say('  open — closing it stops the scanner.');
}
say('  ────────────────────────────────────────────');
say();
await ask.question('  Press Enter to close. ', '');
rl.close();
