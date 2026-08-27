// The screen by the door.
//
// A page of its own, not a tab in the back office. On the till the clock sat
// next to Finance and Products, so the person clocking on for a morning shift
// was one mis-tap from the takings — and a screen that stands at a door all
// day, in front of everybody, is the least private device in the building.
//
// So this page can reach exactly two things: who is on the team, and the clock
// itself. There is no menu, no link out, and nothing else rendered. Signing the
// device in is still required — the staff list is not something to hand to
// anybody who finds the address — but it is done once, at the door, and then
// the screen stays on this page.
//
// The eye is for that one box: setting a door up is a long code typed by
// somebody standing at it, and getting it wrong tells you nothing about which
// character was wrong.
import '../reveal.js';
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

async function api(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401) { signedIn = false; gate(); throw new Error('Signed out.'); }
  if (!res.ok) throw new Error(data.error || 'That did not work.');
  return data;
}
const GET = (p) => api('GET', p);
const POST = (p, b) => api('POST', p, b ?? {});

// Said out loud and large. Somebody reads this from a step away, holding a bag.
function say(text, kind = 'good', holdMs = 0) {
  busy(Math.max(holdMs, 8000));
  const el = document.createElement('div');
  el.className = `say ${kind}`;
  el.textContent = text;
  $('#notices').replaceChildren(el);
  setTimeout(() => el.remove(), holdMs || (kind === 'bad' ? 5000 : 4000));
}

// A clocking result stays up longer than anything else on this page. Somebody
// walks away the moment they think it worked, and four seconds is not long
// enough to be sure across a room while taking a bag off your shoulder.
const CONFIRM_MS = 6500;

// ---------------------------------------------------------------------------
// What the door says when it lets you in, and when it lets you go
//
// A time clock is the first thing anybody here sees in the morning and the
// last thing at night, and for a year it has said the same eleven words at
// both ends. So it says something different each time — warm on the way in,
// warm on the way out, and never at anybody's expense. Somebody arriving late
// or leaving early reads this too.
//
// Kept here rather than on the server on purpose: it is the door's own voice
// and changing it should not need a deploy of anything but this file.
// ---------------------------------------------------------------------------
const HELLO = [
  "You're clocked in. Now get to work.",
  "You're in. The day starts now.",
  "Clocked in. Go be brilliant.",
  "In you go. Make it count.",
  "You're on the clock. Coffee first, then chaos.",
  "Clocked in. The shelves won't stock themselves.",
  "You're in. Let's make today easy on tomorrow.",
  "Clocked in. Somebody's order is waiting.",
  "In. Good morning — properly this time.",
  "You're on. Head up, let's go.",
  "Clocked in. Today's the one, then.",
  "You're in. Try to enjoy it.",
  "Clocked in. The team just got better.",
  "In you come. Deep breath, then begin.",
  "You're on the clock. Do the hard one first.",
  "Clocked in. Nothing breaks on your watch.",
  "You're in. Let's give them something to talk about.",
  "Clocked in. Right — where were we?",
];

const GOODBYE = [
  "You're clocked out. Ciao.",
  "Clocked out. Goodbye, and well done.",
  "You're out. Go home properly.",
  "Clocked out. That'll do.",
  "You're done. Rest is part of the job.",
  "Out you go. See you tomorrow.",
  "Clocked out. Leave it at the door.",
  "You're out. Go and eat something.",
  "Clocked out. Good shift.",
  "Done for the day. Ciao.",
  "You're out. Nothing follows you home.",
  "Clocked out. Thanks for today.",
  "Out. Go on — the day's yours now.",
  "You're done. Sleep well.",
  "Clocked out. Same time tomorrow?",
  "You're out. Take the long way home.",
  "Clocked out. Well earned.",
  "Off you go. Goodbye.",
];

// Not the same line twice running, which is the one thing that makes a random
// list look like it isn't one. With eighteen to choose from, remembering the
// last is enough — a queue of them would just be bookkeeping.
let lastLine = '';
function pick(lines) {
  const other = lines.filter((l) => l !== lastLine);
  lastLine = other[Math.floor(Math.random() * other.length)];
  return lastLine;
}

// The big moment: their own face, filling the screen, with something said to
// them by name.
//
// It is deliberately the whole screen. The old confirmation was a strip of
// text at the top of a board of fifty faces, which is nothing to look at from
// four steps away with a bag on your shoulder — and being unsure is exactly
// what made people press again. Nobody is unsure about this.
const CHEER_MS = 4200;
let cheerTimer = null;

// How the face arrives. Eight of them, picked at random, all landing in the
// same place so the name and the line underneath never move.
const MOVES = ['m-pop', 'm-swing', 'm-drop', 'm-spin', 'm-rise', 'm-flip',
               'm-wobble', 'm-zoom'];

function cheer({ name, photo, action, minutes }) {
  clearTimeout(cheerTimer);
  document.querySelector('.cheer')?.remove();
  // "Now press your finger" has just been answered. Leaving it up under the
  // confirmation is the screen contradicting itself.
  $('#notices').replaceChildren();
  busy(CHEER_MS + 1500);

  const out = action === 'out';
  const el = document.createElement('div');
  // A different move each time, so the same face arriving every morning at
  // ten to six is not the same four seconds every morning at ten to six.
  el.className = `cheer ${out ? 'out' : 'in'} ${
    MOVES[Math.floor(Math.random() * MOVES.length)]}`;
  el.innerHTML = `
    <div class="cheer-card">
      <div class="cheer-face">
        ${photo
          ? `<img src="${photo}" alt="">`
          : '<span class="noface">🧑</span>'}
      </div>
      <b class="cheer-name">${esc(name || '')}</b>
      <p class="cheer-line">${esc(pick(out ? GOODBYE : HELLO))}</p>
      <p class="cheer-when">${esc(new Date().toLocaleTimeString('en-PH', {
        hour: 'numeric', minute: '2-digit', timeZone: 'Asia/Manila' }))}${
        out && minutes ? ` · ${(minutes / 60).toFixed(2)} hours` : ''}</p>
    </div>`;
  document.body.append(el);
  // A frame's grace so the browser has something to animate away from.
  requestAnimationFrame(() => el.classList.add('up'));

  const go = () => {
    el.classList.remove('up');
    setTimeout(() => el.remove(), 400);
  };
  cheerTimer = setTimeout(go, CHEER_MS);
  // Somebody in a hurry behind them can clear it.
  el.addEventListener('click', () => { clearTimeout(cheerTimer); go(); });
}

// The face to put on it. The board already knows everybody's photograph; a
// clocking answer only carries a name, so it is looked up by name here rather
// than fetched again.
const faceOf = (name) => {
  const p = team.find((x) => x.name === name);
  return p?.has_photo ? faceSrc(p) : null;
};

// Said the same way wherever a clocking lands — the keypad, a tapped face, or
// the scanner — so all three ends of this page agree.
function clocked(r) {
  cheer({
    name: r.name || r.person,
    photo: faceOf(r.name || r.person),
    action: r.action,
    minutes: r.worked_minutes,
  });
  load().catch(() => {});
}

// Manila, not the machine. Every other time on this page is pinned to the
// shop's clock — the arrivals, the departures, the date under a face — and
// this one was following whatever the PC happened to be set to. A door whose
// timezone is wrong then shows one time on the wall while recording another,
// and the board quietly disagrees with itself in front of the people whose
// hours it is keeping.
const tick = () => {
  $('#now').textContent = new Date().toLocaleTimeString('en-PH',
    { hour: 'numeric', minute: '2-digit', timeZone: 'Asia/Manila' });
};
tick();
setInterval(tick, 10000);

// Which shop's colours this door wears.
//
// A door screen is a fixture in one shop, not a page on a website, so it looks
// like that shop. Which shop is the server's answer, not the address bar's —
// the branch list is what says a door belongs to Beauty Obsession Avenue, and
// a query string could say anything.
//
// Remembered so the next morning is instant. The screen is switched on once
// and left, and a palette that arrives a moment late is a screen that looks
// briefly broken in front of whoever is standing at it.
const brandOf = (name) => (/obsession/i.test(name || '') ? 'boa' : null);
const MARKS = { boa: '/boa-mark.png' };

function wear(brand) {
  const root = document.documentElement;
  if (brand) root.dataset.brand = brand; else delete root.dataset.brand;
  const mark = document.querySelector('.brand img');
  if (mark) mark.src = MARKS[brand] ?? '/logo.jpg';
  try {
    if (brand) localStorage.setItem('clockBrand', brand);
    else localStorage.removeItem('clockBrand');
  } catch { /* a locked-down screen still gets the colours, just not the memory */ }
}

try { wear(localStorage.getItem('clockBrand')); } catch { /* first morning */ }

// ---------------------------------------------------------------------------
// A door that updates itself
//
// This screen is 500 metres from anybody who could refresh it, behind a door,
// on a PC nothing outside that PC can reach — the agent binds 127.0.0.1 on
// purpose. So every change to this page waited for somebody to walk over, or
// for the machine to be restarted, and in between the two doors could be
// showing two different versions of the same clock.
//
// Now it watches its own files, and it watches the bytes rather than the
// headers. The obvious version of this asks for an ETag — but a door with a
// scanner does not fetch this page from the website, it fetches it from the
// agent on its own PC, which passes the website through and hands back the
// content type and nothing else. No ETag, no Last-Modified. A check built on
// those would have sat at the one door it was written for and never fired,
// and the only way to find that out is to have read the agent.
//
// So it fetches the files and hashes them. Forty kilobytes every five minutes,
// over a proxy that already marks everything no-store, which is why a plain
// fetch always gets today's copy rather than this morning's.
//
// The reload waits for a quiet moment, and quiet is defined generously:
// nothing may be half typed, no pad or dialog open, no finger being read, and
// nothing said on screen in the last few seconds. A clock that reloaded under
// somebody's hands would be worse than one that is a day out of date.
// ---------------------------------------------------------------------------
const WATCHED = ['/clock/clock.js', '/clock/clock.css'];
const CHECK_EVERY = 5 * 60 * 1000;

let busyUntil = 0;
// Somebody is doing something. Hold the reload off. Declared as a function so
// that say(), which is written above it, can call it — the two ends of this
// file are a long way apart and the ordering should not be load-bearing.
function busy(ms = 20000) { busyUntil = Math.max(busyUntil, Date.now() + ms); }

async function stamps() {
  const out = [];
  for (const f of WATCHED) {
    const text = await (await fetch(f, { cache: 'no-store' })).text();
    // FNV-1a. Not a security hash — this is comparing a file with itself five
    // minutes ago, and the length goes alongside it so that the one collision
    // in four billion is not a door that stops updating.
    let h = 2166136261;
    for (let i = 0; i < text.length; i += 1) {
      h ^= text.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    out.push(`${(h >>> 0).toString(36)}.${text.length}`);
  }
  return out.join('|');
}

(async function watchForNewer() {
  let mine;
  try { mine = await stamps(); } catch { return; }   // offline: try again later
  setInterval(async () => {
    let now;
    try { now = await stamps(); } catch { return; }
    if (!now || now === mine) return;
    // The files changed. Wait for a moment when nobody is mid-anything.
    const quiet = () => Date.now() > busyUntil
      && !document.querySelector('.veil')
      && !document.querySelector('#notices .say');
    if (quiet()) { location.reload(); return; }
    const waiting = setInterval(() => {
      if (!quiet()) return;
      clearInterval(waiting);
      location.reload();
    }, 4000);
  }, CHECK_EVERY);
})();

let signedIn = false;
let team = [];
let refresher = null;
let fixedBranch = null;

// A PIN has named somebody and is waiting on the finger that confirms it.
//
// The PIN says who is standing here and that they meant to clock. It does not
// prove they are the person whose PIN it is — a number can be watched over a
// shoulder or lent to a friend running late — so nothing is recorded until the
// finger only they have follows it.
//
// This way round for two reasons. A scanner that listens all day answers
// fingers nobody offered on purpose: a hand on the glass, somebody reaching
// past. And a person who could not tell whether their press had registered
// pressed again, which under a toggle clocked them straight back out. Now the
// press is the last thing, it is deliberate, and the window it lands on is
// single-use — so a second press changes nothing.
//
// Going out as well as coming in: walking past a scanner should not end a
// shift any more than it should start one.
let awaiting = null;      // { name, until }
let askTimer = null;

// The screen's own sign-in. Not a person, and not on the team list.
const TIMEKEEPER = 'Timekeeper';

// ---------------------------------------------------------------------------
// Signing the device in — once, by whoever sets the door screen up
// ---------------------------------------------------------------------------
function gate() {
  clearInterval(refresher);
  // No username, and nobody's own password. The screen has a sign-in of its
  // own — the timekeeper — which can see the team and work the clock and
  // nothing else at all. Whoever opens the shop types its code once.
  $('#app').innerHTML = `
    <form class="gate" id="in">
      <h2>Setting up this screen</h2>
      <p class="who">Once, when the screen is first set up.</p>
      <p><b>Clocking on for your shift?</b> Not here. Ask whoever opens the shop
        to set this screen up — then your name appears, and you use your finger
        or type your own PIN.</p>
      <input name="code" type="password" inputmode="numeric" placeholder="Timekeeper code"
        autocomplete="off" required>
      <button>Set up</button>
    </form>`;
  $('#in').addEventListener('submit', async (e) => {
    e.preventDefault();
    const code = new FormData(e.target).get('code');
    try {
      await POST('/api/login', { username: TIMEKEEPER, password: code });
      signedIn = true;
      start();
    } catch (err) { say('That code does not match.', 'bad'); }
  });
}

// ---------------------------------------------------------------------------
// Asking for the finger that confirms a PIN
//
// It turns the scanner panel that is already there into their panel, with
// their name on it and a countdown, and turns it back when the window closes.
// Nothing is recorded either way until the finger arrives — a window that runs
// out leaves no trace of a shift, only a note that a PIN opened one and
// nothing followed.
// ---------------------------------------------------------------------------
function startAsking(name, seconds) {
  // Somebody has typed their PIN and is reaching for the glass. Nothing may
  // reload under them for at least as long as they have to do it.
  busy(((seconds || 90) + 15) * 1000);
  clearInterval(askTimer);
  awaiting = { name, until: Date.now() + (seconds || 90) * 1000 };

  const panel = $('#byfinger');
  if (!panel) return;
  panel.hidden = false;
  panel.classList.add('confirming');
  const left = () => Math.max(0, Math.ceil((awaiting.until - Date.now()) / 1000));
  const paint = () => {
    if (!awaiting) return;
    $('#scantitle', panel).textContent = `${name} — now your finger`;
    $('#scanhint', panel).textContent = `${left()}s to confirm on the glass.`;
    if (left() <= 0) {
      stopAsking();
      say('That took too long. Type your PIN again.', 'bad', CONFIRM_MS);
    }
  };
  paint();
  askTimer = setInterval(paint, 1000);
}

function stopAsking() {
  clearInterval(askTimer);
  askTimer = null;
  awaiting = null;
  const panel = $('#byfinger');
  if (!panel) return;
  panel.classList.remove('confirming');
  $('#scantitle', panel).textContent = 'Place your finger';
  scannerIdle?.();
}

// Set once the scanner has been found, so stopAsking can put the panel back to
// whatever it should say on this particular door — ready, not connected, or an
// enrolment desk.
let scannerIdle = null;

// Does this door have a working scanner? The server needs to know before it
// sends anybody to one: a broken reader at six in the morning must clock
// people on their PIN rather than turn into a queue nobody can clear.
let hasScanner = false;

// ---------------------------------------------------------------------------
// The faces
// ---------------------------------------------------------------------------
async function start() {
  // One job, two ways of doing it: pick your face on the left, or type your
  // four digits on the right. There is no name search: thirty-odd faces on a
  // monitor is a thing you find by looking, and a box that has to be clicked
  // into first is slower than the looking. There is deliberately no way into the back office
  // from here — a screen at a door should not be a way into the till, and a
  // sign-in box on it would leave it signed in as whoever last used it.
  $('#app').innerHTML = `
    <div class="two">
      <section class="clockside">
        <div class="tools">
          <select id="branch"></select>
        </div>
        <div class="grid" id="grid"></div>
      </section>

      <aside class="rail">
        <section class="padside" id="bypin" open>
          <h2>Type your PIN</h2>
          <div class="dots" id="kdots"></div>
          <div class="keys" id="keypad">
            ${[1, 2, 3, 4, 5, 6, 7, 8, 9].map((d) =>
              `<button data-k="${d}">${d}</button>`).join('')}
            <button class="wipe" id="kwipe">clear</button>
            <button data-k="0">0</button>
            <button class="go" id="kgo">✓</button>
          </div>
          <p class="hint">Type your PIN on the keyboard, or pick your face on the left.</p>
        </section>

        <!-- Only appears if this door has a scanner. Under the keypad, in the
             same rail: the PIN is what everybody has and what everybody falls
             back to, and the scanner is the shortcut sitting beneath it. -->
        <section class="padside finger" id="byfinger" hidden>
          <h2 id="scantitle">Place your finger</h2>
          <div class="scan" id="scanmark">☝</div>
          <p class="hint" id="scanhint">Ready</p>
          <p class="wait-note">Hold it still and wait for your name.</p>
        </section>
      </aside>
    </div>`;


  let typed = '';
  const kdots = () => {
    $('#kdots').textContent = typed.replace(/./g, '●') || '– – – –';
  };
  kdots();
  $$('[data-k]').forEach((b) => b.addEventListener('click', () => {
    if (typed.length < 8) typed += b.dataset.k;
    busy();
    kdots();
  }));
  $('#kwipe').addEventListener('click', () => { typed = ''; kdots(); });
  const punch = async () => {
    if (typed.length < 4) return say('Type your four-digit PIN.', 'bad');
    $('#kgo').disabled = true;
    try {
      const r = await POST('/api/clock/by-pin',
        { pin: typed, branch_id: fixedBranch, scanner: hasScanner });
      typed = ''; kdots();
      // Named, but nothing written down yet. The finger is what says they
      // meant it, and that they are the one who owns the number.
      if (r.action === 'confirm') {
        startAsking(r.name, r.seconds);
        say(`${r.name} — now press your finger`, 'good', CONFIRM_MS);
      } else {
        clocked(r);
      }
    } catch (e) {
      say(e.message, 'bad');
      typed = ''; kdots();
    } finally { $('#kgo').disabled = false; }
  };
  $('#kgo').addEventListener('click', punch);
  // Every door here is a desktop monitor, so the keyboard is the ordinary
  // way in for anybody not using the scanner.
  document.addEventListener('keydown', (e) => {
    if ($('.veil')) return;
    if (/^[0-9]$/.test(e.key) && typed.length < 8) { typed += e.key; busy(); kdots(); }
    else if (e.key === 'Backspace') { typed = typed.slice(0, -1); busy(); kdots(); }
    else if (e.key === 'Enter') { busy(); punch(); }
  });

  // A device left by one door shows that door's faces, and remembers which,
  // because nobody wants to pick the shop every morning.
  //
  // ?shop=<id> in the address fixes it outright, with no picker at all. That is
  // what the per-branch app icons use: the screen at one door is that door's
  // clock and cannot be switched to the other shop by a stray tap.
  const branches = await GET('/api/branches').catch(() => []);
  const pinned = new URLSearchParams(location.search).get('shop');
  const fixed = pinned && branches.find((b) => String(b.id) === String(pinned));
  fixedBranch = fixed ? Number(fixed.id) : null;
  const remembered = localStorage.getItem('clockBranch') || '';
  const picker = $('#branch');
  picker.innerHTML = fixed
    ? `<option value="${fixed.id}" selected>${esc(fixed.name)}</option>`
    : (branches.length > 1 ? '<option value="">Everybody</option>' : '')
      + branches.filter((b) => b.active).map((b) =>
        `<option value="${b.id}"${String(b.id) === remembered ? ' selected' : ''}>${
          esc(b.name)}</option>`).join('');
  // At a door the shop is fixed, so the picker is hidden — and it was the last
  // thing in that row once the name search went, leaving a strip of nothing
  // above the faces.
  if (fixed || branches.length < 2) {
    picker.style.display = 'none';
    const tools = document.querySelector('.tools');
    if (tools) tools.style.display = 'none';
  }
  const named = fixed || branches.find((b) => String(b.id) === picker.value);
  // The shop the server says this is, which may correct what was remembered.
  const worn = brandOf(named?.name);
  wear(worn);
  // A shop whose own mark is on the bar does not need its name spelled out
  // beside it in a different typeface. The others still do.
  $('#where').textContent = named && !worn ? `Time clock · ${named.name}` : 'Time clock';

  picker.addEventListener('change', () => {
    localStorage.setItem('clockBranch', picker.value);
    const b = branches.find((x) => String(x.id) === picker.value);
    const w = brandOf(b?.name);
    wear(w);
    $('#where').textContent = b && !w ? `Time clock · ${b.name}` : 'Time clock';
    draw();
  });

  await load();
  // Somebody else may clock on at the other door; the board should not go
  // stale while nobody is touching it.
  refresher = setInterval(() => { if (!$('.veil')) load().catch(() => {}); }, 20000);
  findScanner();
}

// ---------------------------------------------------------------------------
// The fingerprint scanner, if this door has one.
//
// A web page cannot read a fingerprint — the reader is a USB device and the
// matching lives in the manufacturer's native library — so a small agent runs
// on the same PC and answers here on loopback. If nothing answers, this whole
// section stays hidden and the door is a PIN pad, which is what every screen
// will go on being.
// ---------------------------------------------------------------------------
// Where the scanner answers. When the door serves this page itself — which is
// how a fingerprint door works, because a browser will not let a page from the
// internet reach into the machine it is shown on — that is simply here.
const AGENT = /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(location.origin)
  ? location.origin
  : 'http://127.0.0.1:9500';

// Adding ?debug=1 to the address makes the page say why it cannot see a
// scanner. Off by default and deliberately so — a screen by a door should not
// display plumbing at people arriving for a shift — but setting one of these
// up without it means guessing between "the agent is not running" and "the
// browser refused the request", which look identical from here.
const DEBUG = new URLSearchParams(location.search).get('debug') === '1';

function complain(what) {
  if (!DEBUG) return;
  const panel = $('#byfinger');
  panel.hidden = false;
  panel.classList.add('cold');
  $('#scanhint').innerHTML = what;
}

async function findScanner() {
  let hello;
  try {
    const r = await fetch(`${AGENT}/hello`, { signal: AbortSignal.timeout(4000) });
    hello = await r.json();
  } catch (e) {
    // Two very different problems, one silence. Worth telling apart.
    complain(e.name === 'TimeoutError'
      ? `Nothing answered on <b>${AGENT}</b> within a second.<br>`
        + 'Is TEST-WITHOUT-SCANNER.bat (or START-THE-DOOR.bat) running in a window?'
      : `Could not reach <b>${AGENT}</b>: ${esc(e.message)}.<br>`
        + `Open <b>${AGENT}/hello</b> in a tab — if that shows text, the browser `
        + 'is blocking this page from reaching it; if it does not, the agent is not running.');
    return;
  }
  if (!hello || hello.agent !== 'msbeauave-door') {
    complain(`Something answered on ${AGENT} but it is not the door agent.`);
    return;
  }

  const panel = $('#byfinger');
  const hint = $('#scanhint');
  panel.hidden = false;
  hasScanner = !hello.desk && !!hello.scanner;
  const idle = () => {
    // A desk is not a door, and saying "Ready" on one is a small lie: a finger
    // here is being enrolled, and pressing it expecting to clock on will look
    // like a fault when it is the machine doing exactly as it was told.
    if (hello.desk) {
      panel.querySelector('h2').textContent = 'Enrolment desk';
      hint.textContent = 'Fingers enrol here. They clock nobody on.';
      panel.classList.add('cold');
    } else if (!hello.scanner) {
      hint.textContent = 'Scanner not connected — use your PIN';
      panel.classList.add('cold');
    } else {
      // What it is waiting for, said as the second step it now is. "Ready" on
      // its own invited a press before the PIN, which is the thing this order
      // exists to stop.
      panel.querySelector('h2').textContent = 'Place your finger';
      hint.textContent = 'After your PIN — this confirms it';
      panel.classList.remove('cold');
    }
  };
  idle();
  scannerIdle = idle;

  // The agent does the waiting and the matching; this only asks what happened.
  //
  // Two things are asked for, not one. The result, when there is one — and
  // whether a finger is on the glass right now, which is the answer during the
  // second or two before there is anything to report. Without it the screen
  // said nothing while it worked, and people pressed again; a second press is
  // not a repeat, because clocking is a toggle and it takes them straight back
  // out again.
  let held = 0;
  setInterval(async () => {
    if ($('.veil')) return;
    let latest;
    try {
      latest = await (await fetch(`${AGENT}/latest`, { signal: AbortSignal.timeout(2500) })).json();
    } catch { return; }
    if (!latest) return;

    // A confirmation stays put. Nothing overwrites it with "hold still" while
    // somebody is still reading it.
    const showing = Date.now() < held;
    if (latest.reading && !showing) {
      panel.classList.add('reading');
      $('#scantitle', panel).textContent = 'Reading…';
      hint.textContent = 'Hold still — this takes a moment';
    } else if (!latest.reading && !showing) {
      panel.classList.remove('reading');
      $('#scantitle', panel).textContent = 'Place your finger';
      idle();
    }

    if (latest.at === undefined) return;

    if (latest.ok) {
      const r = latest.result || {};
      // The window this landed on is spent. The panel goes back to waiting
      // before anything else, so a second press finds nothing to do.
      if (awaiting) stopAsking();

      panel.classList.remove('reading');
      panel.classList.add('hit');
      const what = r.action === 'out' ? 'Clocked out' : 'Clocked in';
      $('#scantitle', panel).textContent = what;
      hint.textContent = latest.person || '';
      held = Date.now() + CONFIRM_MS;

      // Pressed twice. The door answers the second from memory rather than
      // clocking anybody back out, so say what already happened — but say it
      // small, in the strip, not with the whole screen again.
      if (latest.again) {
        say(`${latest.person || 'You'} — already ${what.toLowerCase()} ✨`, 'good', CONFIRM_MS);
      } else {
        clocked({ ...r, name: r.name || latest.person });
      }

      setTimeout(() => {
        panel.classList.remove('hit');
        $('#scantitle', panel).textContent = 'Place your finger';
        idle();
      }, CONFIRM_MS);
    } else {
      // A finger with no window open behind it. Not a fault and not an
      // accusation — most of these are a hand resting on the glass.
      const first = /pin first/i.test(latest.say || '');
      say(latest.say || 'That finger was not recognised.', first ? 'good' : 'bad', CONFIRM_MS);
      held = Date.now() + CONFIRM_MS;
      panel.classList.remove('reading');
      $('#scantitle', panel).textContent = first ? 'Your PIN first' : 'Not recognised';
      hint.textContent = first ? 'Type it on the right, then press again' : 'Try again, or use your PIN';
      setTimeout(() => {
        $('#scantitle', panel).textContent = 'Place your finger';
        idle();
      }, CONFIRM_MS);
    }
  }, 1200);
}

async function load() {
  team = (await GET('/api/team')).team.filter((p) => p.here);
  draw();
}

// Whoever is on shift comes first, in the order they arrived.
//
// The morning only runs one way: people clock on, and the board fills from the
// top. Everybody still to come stays below in alphabetical order, where a name
// is found by looking rather than by reading the whole board.
//
// It is the evening this really helps. Somebody clocking out finds themselves
// near the front, beside the people they worked the shift with, instead of
// hunting through fifty faces for their own.
//
// Ties go to the name: two people clocking on in the same second is a queue at
// the door, not a reason for the board to shuffle.
const arrivals = (a, b) => {
  if (!a.on_shift !== !b.on_shift) return a.on_shift ? -1 : 1;
  if (a.on_shift && a.since !== b.since) return new Date(a.since) - new Date(b.since);
  return a.name.localeCompare(b.name);
};

// The version in the address is the moment the photograph was last changed,
// which is what lets it be cached for a year instead of a minute. A board that
// redraws every twenty seconds was otherwise re-fetching every face on the
// wall every minute, all day, and the ones that lost that race showed as blank
// circles — a person unable to find themselves on a screen full of faces.
//
// Somebody with no stamp still gets a picture, just an uncached one.
const faceSrc = (p) => `/api/team/${p.id}/photo?v=${
  p.photo_at ? new Date(p.photo_at).getTime() : 'x'}`;

// What today looks like on a face at the door.
//
// On shift, the arrival is the only thing worth saying and it is said in
// green, because at a glance the board is answering "am I clocked on". Once
// somebody has gone the pair reads as the stretch it was. Before anybody
// arrives there is nothing to show, and an empty line is better than a row of
// dashes on fifty cards.
//
// The day and date sit above the time. The board only ever holds today, so on
// a screen that is looked at they are the same on every card — which is the
// point. A door screen is left running for weeks, and a tab that quietly
// stopped refreshing last Thursday looks exactly like one that is working
// until a date on it disagrees with the wall.
const clockTime = (v) => new Date(v).toLocaleTimeString('en-PH', {
  hour: 'numeric', minute: '2-digit', timeZone: 'Asia/Manila',
});
const clockDay = (v) => new Date(v).toLocaleDateString('en-PH', {
  weekday: 'short', month: 'short', day: 'numeric', timeZone: 'Asia/Manila',
});

function todayLine(p) {
  // Dated from the arrival itself rather than from the clock on the wall: a
  // night shift that runs past midnight belongs to the day it began.
  const day = (v) => `<span class="day">${esc(clockDay(v))}</span>`;
  if (p.on_shift && p.since) {
    return `${day(p.since)}<span class="times in">In ${clockTime(p.since)}</span>`;
  }
  if (p.today_in && p.today_out) {
    return `${day(p.today_in)}<span class="times">${
      clockTime(p.today_in)} – ${clockTime(p.today_out)}</span>`;
  }
  return '';
}

function draw() {
  const here = $('#branch')?.value || '';
  const shown = team
    .filter((p) => !here || String(p.branch_id) === here)
    .sort(arrivals);

  $('#grid').innerHTML = shown.length ? shown.map((p) => `
    <button class="card ${p.on_shift ? 'on' : ''}" data-who="${p.id}"
      ${p.has_pin ? '' : 'disabled'}>
      ${p.on_shift ? '<span class="dot" title="on shift"></span>' : ''}
      ${p.has_photo
        ? `<img src="${faceSrc(p)}" alt="" loading="lazy"
             onerror="this.dataset.tried ? this.replaceWith(Object.assign(
               document.createElement('span'), {className:'face', textContent:'🧑'}))
               : (this.dataset.tried = 1, this.src = this.src + '&again=1')">`
        : '<span class="face">🧑</span>'}
      <b>${esc(p.name)}</b>
      <span>${p.has_pin ? esc(p.position) : 'no PIN yet — ask the owner'}</span>
      ${todayLine(p)}
    </button>`).join('')
    : '<div class="none">Nobody on the team here yet.</div>';

  $$('[data-who]').forEach((b) => b.addEventListener('click',
    () => pad(team.find((p) => String(p.id) === b.dataset.who))));

}

// ---------------------------------------------------------------------------
// The PIN pad
// ---------------------------------------------------------------------------
function pad(person) {
  let pin = '';
  const veil = document.createElement('div');
  veil.className = 'veil';
  veil.innerHTML = `
    <div class="pad">
      <h2>${esc(person.name)}</h2>
      <div class="sub">${person.on_shift
        ? 'Type your PIN to clock out.' : 'Type your PIN to clock on.'}${
        hasScanner && person.has_finger ? '<br>Then press your finger.' : ''}</div>
      <div class="dots" id="dots"></div>
      <div class="keys">
        ${[1, 2, 3, 4, 5, 6, 7, 8, 9].map((d) => `<button data-d="${d}">${d}</button>`).join('')}
        <button class="wipe" id="wipe">clear</button>
        <button data-d="0">0</button>
        <button class="go" id="ok">✓</button>
      </div>
      <button class="quiet cancel" id="cancel">Cancel</button>
    </div>`;
  // Tapping the dark surround closes it, so a half-typed PIN left by somebody
  // who walked away does not sit on the screen.
  veil.addEventListener('click', (e) => { if (e.target === veil) veil.remove(); });
  document.body.append(veil);

  const dots = () => { $('#dots', veil).textContent = pin.replace(/./g, '●') || '– – – –'; };
  dots();

  $$('[data-d]', veil).forEach((b) => b.addEventListener('click', () => {
    if (pin.length < 8) pin += b.dataset.d;
    dots();
  }));
  $('#wipe', veil).addEventListener('click', () => { pin = ''; dots(); });
  $('#cancel', veil).addEventListener('click', () => veil.remove());

  $('#ok', veil).addEventListener('click', async () => {
    $('#ok', veil).disabled = true;
    try {
      const r = await POST('/api/clock',
        { employeeId: person.id, pin, scanner: hasScanner });
      veil.remove();
      if (r.action === 'confirm') {
        startAsking(r.name, r.seconds);
        say(`${r.name} — now press your finger`, 'good', CONFIRM_MS);
      } else {
        clocked(r);
      }
    } catch (e) {
      say(e.message, 'bad');
      pin = '';
      dots();
      $('#ok', veil).disabled = false;
    }
  });
}

// Does this device already have a sign-in? Asking costs one request and saves
// showing a login box to a shop that is already set up.
try {
  const me = await GET('/api/me');
  if (me.user && me.user.role !== 'reseller') { signedIn = true; await start(); } else gate();
} catch { gate(); }
