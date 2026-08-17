// The screen by the door.
//
// A page of its own, not a tab in the back office. On the till the clock sat
// next to Finance and Products, so the person clocking on for a morning shift
// was one mis-tap from the takings — and a tablet left on the counter all day
// is the least private device in the building.
//
// So this page can reach exactly two things: who is on the team, and the clock
// itself. There is no menu, no link out, and nothing else rendered. Signing the
// device in is still required — the staff list is not something to hand to
// anybody who finds the address — but it is done once, on the tablet, and then
// the screen stays on this page.
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
function say(text, kind = 'good') {
  const el = document.createElement('div');
  el.className = `say ${kind}`;
  el.textContent = text;
  $('#notices').replaceChildren(el);
  setTimeout(() => el.remove(), kind === 'bad' ? 5000 : 4000);
}

const tick = () => {
  $('#now').textContent = new Date().toLocaleTimeString('en-PH',
    { hour: 'numeric', minute: '2-digit' });
};
tick();
setInterval(tick, 10000);

let signedIn = false;
let team = [];
let refresher = null;
let fixedBranch = null;

// The tablet's own sign-in. Not a person, and not on the team list.
const TIMEKEEPER = 'Timekeeper';

// ---------------------------------------------------------------------------
// Signing the device in — once, by whoever sets the tablet down
// ---------------------------------------------------------------------------
function gate() {
  clearInterval(refresher);
  // No username, and nobody's own password. The tablet has a sign-in of its
  // own — the timekeeper — which can see the team and work the clock and
  // nothing else at all. Whoever opens the shop types its code once.
  $('#app').innerHTML = `
    <form class="gate" id="in">
      <h2>Setting up this tablet</h2>
      <p class="who">Once, when the tablet is first set up.</p>
      <p><b>Clocking on for your shift?</b> Not here. Ask whoever opens the shop
        to set this screen up — then your name appears and you tap it and type
        your own PIN.</p>
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
// The faces
// ---------------------------------------------------------------------------
async function start() {
  // One job, two ways of doing it: find your face on the left, or type your
  // four digits on the right. There is deliberately no way into the back office
  // from here — a tablet on a counter should not be a door to the till, and a
  // sign-in box on it would leave the tablet as whoever last used it.
  $('#app').innerHTML = `
    <div class="two">
      <section class="clockside">
        <div class="tools">
          <input id="find" type="search" placeholder="Find your name…" autocomplete="off">
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
          <p class="hint">Or tap your name on the left.</p>
        </section>

        <!-- Only appears if this door has a scanner. It sits under the keypad
             rather than over it: the PIN is what everybody has, and what
             everybody falls back to when a finger is wet or cut. -->
        <section class="padside finger" id="byfinger" hidden>
          <h2>Place your finger</h2>
          <div class="scan" id="scanmark">☝</div>
          <p class="hint" id="scanhint">Ready</p>
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
    kdots();
  }));
  $('#kwipe').addEventListener('click', () => { typed = ''; kdots(); });
  const punch = async () => {
    if (typed.length < 4) return say('Type your four-digit PIN.', 'bad');
    $('#kgo').disabled = true;
    try {
      const r = await POST('/api/clock/by-pin', { pin: typed, branch_id: fixedBranch });
      say(r.action === 'in'
        ? `Good morning ${r.name} — clocked on 🌸`
        : `${r.name} clocked out after ${(r.worked_minutes / 60).toFixed(2)} hours 🌸`);
      typed = ''; kdots();
      load().catch(() => {});
    } catch (e) {
      say(e.message, 'bad');
      typed = ''; kdots();
    } finally { $('#kgo').disabled = false; }
  };
  $('#kgo').addEventListener('click', punch);
  // A tablet with a keyboard attached, or somebody who prefers typing.
  document.addEventListener('keydown', (e) => {
    if ($('.veil') || document.activeElement === $('#find')) return;
    if (/^[0-9]$/.test(e.key) && typed.length < 8) { typed += e.key; kdots(); }
    else if (e.key === 'Backspace') { typed = typed.slice(0, -1); kdots(); }
    else if (e.key === 'Enter') punch();
  });

  // A device left by one door shows that door's faces, and remembers which,
  // because nobody wants to pick the shop every morning.
  //
  // ?shop=<id> in the address fixes it outright, with no picker at all. That is
  // what the per-branch app icons use: the tablet at one door is that door's
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
  if (fixed || branches.length < 2) picker.style.display = 'none';
  const named = fixed || branches.find((b) => String(b.id) === picker.value);
  $('#where').textContent = named ? `Time clock · ${named.name}` : 'Time clock';

  $('#find').addEventListener('input', draw);
  picker.addEventListener('change', () => {
    localStorage.setItem('clockBranch', picker.value);
    const b = branches.find((x) => String(x.id) === picker.value);
    $('#where').textContent = b ? `Time clock · ${b.name}` : 'Time clock';
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
// section stays hidden and the door is a PIN pad, which is what every tablet
// will go on being.
// ---------------------------------------------------------------------------
const AGENT = 'http://127.0.0.1:9500';

// Adding ?debug=1 to the address makes the page say why it cannot see a
// scanner. Off by default and deliberately so — a tablet by a door should not
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
    const r = await fetch(`${AGENT}/hello`, { signal: AbortSignal.timeout(1500) });
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
  const idle = () => {
    if (!hello.scanner) {
      hint.textContent = 'Scanner not connected — use your PIN';
      panel.classList.add('cold');
    } else {
      hint.textContent = `Ready · ${hello.holding} on file`;
      panel.classList.remove('cold');
    }
  };
  idle();

  // The agent does the waiting and the matching; this only asks what happened.
  setInterval(async () => {
    if ($('.veil')) return;
    let latest;
    try {
      latest = await (await fetch(`${AGENT}/latest`, { signal: AbortSignal.timeout(2500) })).json();
    } catch { return; }
    if (!latest || latest.at === undefined) return;

    if (latest.ok) {
      const r = latest.result || {};
      say(`${latest.person || 'Welcome'} — ${r.action === 'out' ? 'clocked out' : 'clocked in'} ✨`, 'good');
      panel.classList.add('hit');
      setTimeout(() => panel.classList.remove('hit'), 1200);
      load().catch(() => {});
    } else {
      say(latest.say || 'That finger was not recognised.', 'bad');
    }
  }, 1200);
}

async function load() {
  team = (await GET('/api/team')).team.filter((p) => p.here);
  draw();
}

function draw() {
  const q = ($('#find')?.value || '').trim().toLowerCase();
  const here = $('#branch')?.value || '';
  const shown = team
    .filter((p) => !here || String(p.branch_id) === here)
    .filter((p) => !q || p.name.toLowerCase().includes(q));

  $('#grid').innerHTML = shown.length ? shown.map((p) => `
    <button class="card ${p.on_shift ? 'on' : ''}" data-who="${p.id}"
      ${p.has_pin ? '' : 'disabled'}>
      ${p.on_shift ? '<span class="dot" title="on shift"></span>' : ''}
      ${p.has_photo
        ? `<img src="/api/team/${p.id}/photo" alt="">`
        : '<span class="face">🧑</span>'}
      <b>${esc(p.name)}</b>
      <span>${p.has_pin ? esc(p.position) : 'no PIN yet — ask the owner'}</span>
    </button>`).join('')
    : '<div class="none">Nobody matches that.</div>';

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
        ? 'Type your PIN to clock out.' : 'Type your PIN to clock on.'}</div>
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
      const r = await POST('/api/clock', { employeeId: person.id, pin });
      veil.remove();
      say(r.action === 'in'
        ? `Good morning ${r.name} — clocked on 🌸`
        : `${r.name} clocked out after ${(r.worked_minutes / 60).toFixed(2)} hours 🌸`);
      load().catch(() => {});
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
