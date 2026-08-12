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

// ---------------------------------------------------------------------------
// Signing the device in — once, by whoever sets the tablet down
// ---------------------------------------------------------------------------
function gate() {
  clearInterval(refresher);
  $('#leave').hidden = true;
  $('#app').innerHTML = `
    <form class="gate" id="in">
      <h2>Sign this device in</h2>
      <p>Once only. Whoever sets up the tablet signs in here, and then it stays
        on this screen — the staff just tap their name.</p>
      <input name="username" placeholder="Username" autocomplete="username" required>
      <input name="password" type="password" placeholder="Password"
        autocomplete="current-password" required>
      <button>Sign in</button>
    </form>`;
  $('#in').addEventListener('submit', async (e) => {
    e.preventDefault();
    const form = new FormData(e.target);
    try {
      await POST('/api/login', {
        username: form.get('username'), password: form.get('password'),
      });
      signedIn = true;
      start();
    } catch (err) { say(err.message, 'bad'); }
  });
}

// ---------------------------------------------------------------------------
// The faces
// ---------------------------------------------------------------------------
async function start() {
  $('#leave').hidden = false;
  $('#app').innerHTML = `
    <div class="tools">
      <input id="find" type="search" placeholder="Find your name…" autocomplete="off">
      <select id="branch"></select>
    </div>
    <div class="grid" id="grid"></div>`;

  // A device left by one door shows that door's faces, and remembers which,
  // because nobody wants to pick the shop every morning.
  const branches = await GET('/api/branches').catch(() => []);
  const remembered = localStorage.getItem('clockBranch') || '';
  const picker = $('#branch');
  picker.innerHTML = (branches.length > 1 ? '<option value="">Everybody</option>' : '')
    + branches.filter((b) => b.active).map((b) =>
      `<option value="${b.id}"${String(b.id) === remembered ? ' selected' : ''}>${
        esc(b.name)}</option>`).join('');
  if (branches.length < 2) picker.style.display = 'none';
  const named = branches.find((b) => String(b.id) === picker.value);
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
      ${p.has_photo
        ? `<img src="/api/team/${p.id}/photo" alt="">`
        : '<span class="face">🧑</span>'}
      <b>${esc(p.name)}</b>
      <span>${p.on_shift ? 'on shift'
        : p.has_pin ? esc(p.position) : 'no PIN yet — ask the owner'}</span>
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

$('#leave').addEventListener('click', async () => {
  await POST('/api/logout').catch(() => {});
  signedIn = false;
  gate();
});

// Does this device already have a sign-in? Asking costs one request and saves
// showing a login box to a shop that is already set up.
try {
  const me = await GET('/api/me');
  if (me.user && me.user.role !== 'reseller') { signedIn = true; await start(); } else gate();
} catch { gate(); }
