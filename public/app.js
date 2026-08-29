// MS BEAU AVE — the whole front end.
//
// No framework and no build step: the file you read is the file that runs.
// Everything interpolated into markup goes through esc(), without exception —
// a product name is user input and must never be able to become markup.

// Puts an eye on every password box on every screen. Imported for what it
// does, not for anything it exports.
import './reveal.js';

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// The shop trades on Manila time and so does the engine. A browser date turned
// into an ISO string is UTC, which is a different day for eight hours after
// midnight — long enough for the first shift to be told the shop is empty.
// Manila spelled out rather than TZ, which is declared a few lines below and
// would not exist yet. Without it this is the machine's idea of today, and a
// PC whose clock is set to somewhere else opens every screen on the wrong day.
const localDay = (offsetDays = 0) =>
  new Date(Date.now() - offsetDays * 864e5)
    .toLocaleDateString('en-CA', { timeZone: 'Asia/Manila' });

const peso = (v) => '₱' + Number(v || 0).toLocaleString('en-PH',
  { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const count = (v) => Number(v || 0).toLocaleString('en-PH');

// The shop runs on Manila time wherever the browser happens to be, so receipt
// numbers, cut-offs and due dates all agree.
const TZ = 'Asia/Manila';
const when = (v) => (v ? new Date(v).toLocaleString('en-PH',
  { dateStyle: 'medium', timeStyle: 'short', timeZone: TZ }) : '—');
const onDay = (v) => (v ? new Date(v).toLocaleDateString('en-PH',
  { dateStyle: 'medium', timeZone: TZ }) : '—');

// A product's picture, if it has one. The stamp is only there to defeat the
// cache after a re-upload — without it the browser keeps showing the old shot.
const photoUrl = (sku, stamp) =>
  `/api/products/${encodeURIComponent(sku)}/photo${stamp ? `?v=${stamp}` : ''}`;

const thumb = (p, size = 34) => (p.has_photo
  ? `<img class="thumb" style="width:${size}px;height:${size}px" loading="lazy"
       src="${photoUrl(p.sku)}" alt="">`
  : `<span class="thumb none-photo" style="width:${size}px;height:${size}px">🧴</span>`);

// Phone cameras produce four-thousand-pixel photographs; a shelf tile is 150
// pixels wide. Shrinking here rather than on the way out means the big file
// never leaves the phone, which matters on a shop's connection.
function shrink(file, edge = 900, quality = 0.82) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('That file could not be read.'));
    reader.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error('That file is not an image.'));
      img.onload = () => {
        const scale = Math.min(1, edge / Math.max(img.width, img.height));
        const canvas = document.createElement('canvas');
        canvas.width = Math.round(img.width * scale);
        canvas.height = Math.round(img.height * scale);
        canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
        resolve(canvas.toDataURL('image/jpeg', quality));
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}

let user = null;
let tab = null;
let refreshTimer = null;

// ---------------------------------------------------------------------------
// Talking to the server
// ---------------------------------------------------------------------------
// The two POSTs that are nobody's business but the person making them.
//
// Signing out is a POST because it clears a cookie, and the first version of
// this rule read the method alone and shut the door on somebody trying to walk
// out of it — a view-only sign-in could not sign out at all. Somebody's own
// password is the same shape of mistake waiting to happen: view-only describes
// what they may do to the company, and their own way in is not the company's.
// Leaving a manager who may not change a price stuck with the password they
// were handed on a printed sheet would be the wrong way round.
const OWN_BUSINESS = ['/api/logout', '/api/my/password'];

/** Should this request be stopped in the browser, before it is sent? */
export const heldBack = (role, method, path) =>
  role === 'observer' && method !== 'GET' && !OWN_BUSINESS.includes(path);

async function call(method, path, body) {
  // A view-only sign-in stops here rather than at the far end. The server
  // refuses these too — that is the guard, and it is the one that counts —
  // but a refusal that arrives before the request makes the screen honest
  // instead of merely safe.
  if (heldBack(user?.role, method, path)) {
    throw new Error('This sign-in can look but not change anything.');
  }
  const res = await fetch(path, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Something went wrong (${res.status}).`);
  return data;
}
const GET = (p) => call('GET', p);
const POST = (p, b) => call('POST', p, b ?? {});
const PUT = (p, b) => call('PUT', p, b);
const DELETE = (p) => call('DELETE', p);

function notice(text, kind = '') {
  const el = document.createElement('div');
  el.className = `notice ${kind}`;
  el.textContent = text;
  $('#notices').append(el);
  setTimeout(() => el.remove(), kind === 'bad' ? 6500 : 3500);
}
const whoops = (e) => notice(e.message, 'bad');

// Dialogs opened from inside another one are stacked, not swapped. Reading an
// invoice from an account should put the account back when it is closed —
// having to find the name in the list again is the sort of thing that makes a
// person stop opening the invoice.
//
// Only the top one answers to #dialog, so everything that asks whether a
// dialog is open still gets the right answer. The ones underneath stay exactly
// where they were, scrolled where they were, dimmed by the veil above them.
//
// Opening `over` something is deliberate per call, because a dialog that
// reopens the screen it just saved from — several of them do — would otherwise
// pile up behind itself.
const dialogsUnder = [];

function dialog(html, extra = '', over = false) {
  const showing = $('#dialog');
  if (over && showing) {
    showing.removeAttribute('id');
    // Out of reach of the keyboard as well as the mouse while it waits: the
    // veil above stops clicks by covering them, but nothing stops a tab key.
    showing.inert = true;
    dialogsUnder.push(showing);
  } else {
    closeAllDialogs();
  }
  const veil = document.createElement('div');
  veil.className = 'veil';
  veil.id = 'dialog';
  // A way out that is a button, because a click anywhere outside used to be
  // one: a reseller's tax block half typed in, a stray click on the list
  // behind it, and the lot was gone with nothing to say so. Nothing that
  // holds typing should be closed by missing it.
  veil.innerHTML = `<div class="dialog ${extra}">
    <button class="dialog-x" aria-label="Close">✕</button>${html}</div>`;
  veil.querySelector('.dialog-x').addEventListener('click', closeDialog);
  document.body.append(veil);
  return veil;
}

// Escape still closes — it is deliberate in a way a misplaced click is not,
// and somebody who reaches for it has decided to leave. It leaves one step,
// the same as the ✕ does.
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeDialog();
});

// One step back: the invoice closes onto the account it was opened from, and
// the account closes onto the list.
const closeDialog = () => {
  $('#dialog')?.remove();
  const back = dialogsUnder.pop();
  if (back) { back.id = 'dialog'; back.inert = false; }
};

const closeAllDialogs = () => {
  $('#dialog')?.remove();
  while (dialogsUnder.length) dialogsUnder.pop().remove();
};

function repeat(fn, ms = 8000) {
  clearInterval(refreshTimer);
  refreshTimer = setInterval(() => { if (!$('#dialog')) fn().catch(() => {}); }, ms);
}

const tag = (text, kind) => `<span class="tag ${kind}">${esc(text)}</span>`;
const tierTag = (t) => tag(`Tier ${t}`, t === 3 ? 'green' : t === 2 ? 'pink' : 'grey');

// How somebody proved who they were at the door.
//
// A blank rather than a guess for the ones recorded before the clock started
// keeping this — a shift that says "PIN" because nothing said otherwise is a
// worse record than one that admits it does not know.
const HOW = {
  finger: ['👆 Finger', 'green'],
  pin: ['🔢 PIN', 'pink'],
  hand: ['✍️ By hand', 'amber'],
};
const howTag = (how) => (HOW[how]
  ? tag(...HOW[how])
  : '<span class="dim">—</span>');

// The day in one line: how many presses were fingers, how many were the
// keypad. It is the question somebody asks about a fingerprint door — is it
// being used — and reading it off fifty rows is not answering it.
function howLine(shifts) {
  const n = (how) => shifts.filter((s) => s.started_how === how).length;
  const counts = [['finger', n('finger')], ['pin', n('pin')], ['hand', n('hand')]]
    .filter(([, c]) => c);
  if (!counts.length) return '';
  const unknown = shifts.filter((s) => !s.started_how).length;
  return `<div class="dim" style="margin-bottom:10px">Clocked on by
    ${counts.map(([how, c]) => `${howTag(how)} <b>${count(c)}</b>`).join(' · ')}${
      unknown ? ` · <span class="dim">${count(unknown)} recorded before the
        clock kept this</span>` : ''}</div>`;
}

// Delivery is a confirmation on top of dispatch, not a different stock state.
function orderTag(o) {
  if (o.delivered_at) return tag('Delivered', 'green');
  if (o.status === 'placed' && o.tier === 1 && o.invoice_status === 'open') {
    return tag('Awaiting payment', 'amber');
  }
  return {
    placed: tag('Committed', 'pink'),
    picking: tag('Picking', 'amber'),
    fulfilled: tag('Dispatched', 'green'),
    cancelled: tag('Cancelled', 'grey'),
  }[o.status] ?? tag(o.status, 'grey');
}

function table(rows, columns, empty) {
  if (!rows.length) return `<div class="none">${esc(empty)}</div>`;
  return `<div class="scroll"><table>
    <thead><tr>${columns.map((c) =>
      `<th${c.n ? ' class="n"' : ''}>${esc(c.head)}</th>`).join('')}</tr></thead>
    <tbody>${rows.map((r) => `<tr>${columns.map((c) =>
      `<td${c.n ? ' class="n"' : ''}>${c.cell(r)}</td>`).join('')}</tr>`).join('')}</tbody>
  </table></div>`;
}

// ---------------------------------------------------------------------------
// Signing in
// ---------------------------------------------------------------------------
async function start() {
  try {
    const { user: me } = await GET('/api/me');
    user = me;
    if (me) drawFrame(); else drawSignIn();
  } catch {
    drawSignIn();
  }
}

// What the sign-in page says it is for.
//
// One website serves everybody, so this page cannot know who is about to type
// their name into it. The app they opened can: each installed app carries its
// own address, and the one for staff says so. "Stock, till and reseller
// orders" is true of the back office and means nothing to somebody who has
// come to look at their own hours.
const SIGN_IN_LINES = {
  staff: 'Your record, your leave, your hours',
  office: 'Stock, till and reseller orders',
};

function signInLine() {
  const app = new URLSearchParams(location.search).get('app');
  return SIGN_IN_LINES[app] ?? SIGN_IN_LINES.office;
}

// Whose name is over the door.
//
// Beauty Obsession Avenue Corp is a company of its own, not a branch of MS
// BEAU AVE, and the people who work there know it by its own logo. Handing
// them an app with somebody else's name on the sign-in is the sort of small
// wrongness that makes a system feel like it was built for somewhere else.
//
// Only the mark and the name change. It is one system, one database and one
// set of rules underneath — the brand is a coat of paint on the way in, not a
// second application, and nothing about what anybody may see turns on it.
// Which is the point: a brand read from the address must never be able to
// decide anything, so it decides only what is drawn.
const BRANDS = {
  // wordmark: the logo already spells the name, in the company's own
  // lettering. Setting it beside that in Georgia is two different typefaces
  // saying the same thing, and the wrong one is the bigger. So the mark
  // carries the name and the text stays for anything that cannot see it.
  boa: { name: 'BEAUTY OBSESSION AVE', logo: '/boa-mark.png', wordmark: false },
};
const HOUSE = { name: 'MS BEAU AVE', logo: '/logo.jpg', wordmark: true };

// A mark that will not load falls back to the house one rather than leaving a
// broken picture where a logo should be. Worth the one line: a brand file is
// the sort of thing that gets renamed, and a torn icon on the sign-in is the
// first thing anybody sees.
const markFailed = "this.onerror=null;this.src='/logo.jpg'";

function brand() {
  return BRANDS[new URLSearchParams(location.search).get('brand')] ?? HOUSE;
}

// A round badge and a wide wordmark are different shapes and cannot share one
// rule. The palette is not touched — see the test that holds that.
(function shapeTheMark() {
  const which = new URLSearchParams(location.search).get('brand');
  if (BRANDS[which]) document.documentElement.dataset.brand = which;
})();

// What the icon is called once it is on an iPhone's home screen.
//
// On Android the staff app is its own installed package with its own name. On
// iOS there is nothing to install: the app is this page, added to the home
// screen from Safari. Same page and same file for the back office and for
// staff, so the name has to come from the address — and iOS reads it out of
// the document at the moment somebody taps Add to Home Screen, which is always
// after this has run.
//
// Left alone when there is no ?app=, so the back office keeps the name it had.
const HOME_SCREEN_NAMES = { staff: 'MBA Staff' };
const BRAND_HOME_SCREEN_NAMES = { boa: 'BOA Staff' };

(function nameThisApp() {
  const q = new URLSearchParams(location.search);
  const app = q.get('app');
  const name = BRAND_HOME_SCREEN_NAMES[q.get('brand')] ?? HOME_SCREEN_NAMES[app];
  if (!name) return;
  document.title = name;
  let meta = document.querySelector('meta[name="apple-mobile-web-app-title"]');
  if (!meta) {
    meta = document.createElement('meta');
    meta.name = 'apple-mobile-web-app-title';
    document.head.append(meta);
  }
  meta.content = name;
  // And the manifest, for an iPhone new enough to read one, and for Android's
  // own "add to home screen" outside the installed app.
  const link = document.querySelector('link[rel="manifest"]');
  if (link) link.href = `/manifest-staff.webmanifest`;
})();

function drawSignIn() {
  clearInterval(refreshTimer);
  closeAllDialogs();
  $('#app').innerHTML = `
    <div class="signin-page"><form class="signin" id="signin">
      <span class="logo-mark"><img src="${esc(brand().logo)}" alt="${esc(brand().name)}"
        onerror="${markFailed}"></span>
      <h1 class="wordmark"${brand().wordmark ? '' : ' hidden'}>${esc(brand().name)}</h1>
      <p class="tag-line" style="margin:.2rem 0 1.4rem">${esc(signInLine())}</p>
      <label for="who">Username</label>
      <input id="who" type="text" autocomplete="username" autocapitalize="none" autofocus>
      <label for="secret">Password</label>
      <input id="secret" type="password" autocomplete="current-password">
      <div class="mt"><button class="btn" style="width:100%">Sign in</button></div>
    </form></div>`;

  $('#signin').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      const { user: me } = await POST('/api/login',
        { username: $('#who').value, password: $('#secret').value });
      user = me;
      drawFrame();
    } catch (err) {
      whoops(err);
    }
  });
}

// ---------------------------------------------------------------------------
// The frame
// ---------------------------------------------------------------------------
const TABS = {
  admin: [
    ['dashboard', '🏠', 'Dashboard'],
    ['workspace', '🗂️', 'Workspace'],
    ['pickups', '📦', 'Pickups'],
    ['promos', '🏷️', 'Promos'],
    ['team', '🧑‍💼', 'Team'],
    ['hr', '💼', 'HR'],
    ['attendance', '🕒', 'Attendance'],
    ['clock', '⏱️', 'Time clock'],
    ['branches', '🏬', 'Branches'],
    ['crm', '💗', 'Customers'],
    ['finance', '💰', 'Finance'],
    ['pricelists', '💵', 'Pricelists'],
    ['products', '🧴', 'Products'],
    // The buying half, in the order the work happens: ask a supplier, receive
    // what turns up, then look at what came in. Each was a panel on Receive
    // and each is a different person's job.
    ['purchaseorders', '🧾', 'Purchase order'],
    ['receive', '📦', 'Receive'],
    ['inventory', '📥', 'Inventory'],
    // Named after the document each one produces, in the order the work
    // happens: the customer orders, the warehouse packs it, the account is
    // invoiced. Staff look for the paper they are trying to produce, not for
    // the part of the system it lives in.
    ['customerorder', '💬', 'Customer order'],
    ['returns', '↩️', 'Returns'],
    ['reorder', '📈', 'Reordering'],
    ['reports', '📊', 'Reports'],
    ['stockroom', '🔀', 'Stockroom'],
    ['people', '👥', 'Sign-ins'],
    ['me', '🪪', 'My record'],
  ],
  warehouse: [
    ['workspace', '🗂️', 'Workspace'],
    ['orders', '📋', 'Pick & send'],
    ['purchaseorders', '🧾', 'Purchase order'],
    ['receive', '📦', 'Receive'],
    ['inventory', '📥', 'Inventory'],
    ['stockroom', '🔀', 'Stockroom'],
    ['clock', '⏱️', 'Time clock'],
    ['restock', '🛎️', 'Shelf tasks'],
    ['reorder', '📈', 'Reordering'],
  ],
  cashier: [
    ['till', '🛍️', 'Till'],
    ['pickups', '📦', 'Pickups'],
    ['team', '🧑‍💼', 'Team'],
    ['clock', '⏱️', 'Time clock'],
    ['crm', '💗', 'Customers'],
    ['finance', '💰', 'Finance'],
    ['workspace', '🗂️', 'Workspace'],
    ['tillreturns', '↩️', 'Returns'],
    ['closeday', '🌙', 'Close of day'],
  ],
  // A supervisor runs a floor: the till and the stockroom, plus the day their
  // own shop had. No pricing, no company money, no sign-ins.
  supervisor: [
    ['till', '🛍️', 'Till'],
    ['purchaseorders', '🧾', 'Purchase order'],
    ['receive', '📦', 'Receive'],
    ['inventory', '📥', 'Inventory'],
    ['stockroom', '🔀', 'Stockroom'],
    ['orders', '📋', 'Pick & send'],
    ['pickups', '📦', 'Pickups'],
    ['restock', '🛎️', 'Shelf tasks'],
    ['tillreturns', '↩️', 'Returns'],
    ['closeday', '🌙', 'Close of day'],
    ['shopday', '📊', "Shop's day"],
    ['team', '🧑‍💼', 'Team'],
    ['clock', '⏱️', 'Time clock'],
    ['workspace', '🗂️', 'Workspace'],
  ],
  // The office: the till and the stockroom, both. Not the shop's takings —
  // that is the supervisor's, who answers for the shop.
  office: [
    ['till', '🛍️', 'Till'],
    ['purchaseorders', '🧾', 'Purchase order'],
    ['receive', '📦', 'Receive'],
    ['inventory', '📥', 'Inventory'],
    ['stockroom', '🔀', 'Stockroom'],
    ['orders', '📋', 'Pick & send'],
    ['pickups', '📦', 'Pickups'],
    ['restock', '🛎️', 'Shelf tasks'],
    ['reorder', '📈', 'Reordering'],
    ['tillreturns', '↩️', 'Returns'],
    ['closeday', '🌙', 'Close of day'],
    ['team', '🧑‍💼', 'Team'],
    ['clock', '⏱️', 'Time clock'],
    ['workspace', '🗂️', 'Workspace'],
  ],
  // Somebody who works here and nothing else. Three screens, all of them
  // about themselves, and no way to reach a fourth.
  employee: [
    ['me', '🪪', 'My record'],
    ['myleave', '🌴', 'My leave'],
    ['notices', '📢', 'Noticeboard'],
  ],
  // Somebody who may look and not touch. The same screens an owner opens, less
  // Finance, less the till, and less anything whose only purpose is to change
  // something — Receive and Sign-ins are not read-only screens with the
  // buttons taken out, they are the buttons.
  observer: [
    ['dashboard', '🏠', 'Dashboard'],
    ['workspace', '🗂️', 'Workspace'],
    ['pickups', '📦', 'Pickups'],
    ['promos', '🏷️', 'Promos'],
    ['team', '🧑‍💼', 'Team'],
    ['hr', '💼', 'HR'],
    ['attendance', '🕒', 'Attendance'],
    ['clock', '⏱️', 'Time clock'],
    ['branches', '🏬', 'Branches'],
    ['crm', '💗', 'Customers'],
    ['products', '🧴', 'Products'],
    ['orders', '🚚', 'Wholesale'],
    ['resellers', '🤝', 'Resellers'],
    ['returns', '↩️', 'Returns'],
    ['reorder', '📈', 'Reordering'],
    ['reports', '📊', 'Reports'],
    ['stockroom', '🔀', 'Stockroom'],
    // They work here as well as watch. Their own hours, their own leave
    // balance, their own reviews — the same page a cashier gets, and the only
    // screen on this list that is about them rather than the company.
    ['me', '🪪', 'My record'],
  ],
  reseller: [
    ['catalog', '🛒', 'Order stock'],
    ['myorders', '🚚', 'My orders'],
    ['account', '💳', 'Invoices'],
  ],
};

// What a sign-in can do, not who the person is. Several people hold full
// access; only one of them owns the shop, so this says admin.
const roleName = (r) => ({
  admin: 'Admin', warehouse: 'Warehouse', cashier: 'Cashier',
  supervisor: 'Supervisor', office: 'Office', timekeeper: 'Timekeeper',
  reseller: 'Reseller', employee: 'Staff', observer: 'View only',
}[r] ?? r);

function drawFrame() {
  const tabs = TABS[user.role] ?? [];
  tab = tabs.some(([id]) => id === tab) ? tab : tabs[0][0];
  $('#app').innerHTML = `
    <div class="shell">
      <header class="app">
        <button id="navToggle" aria-label="Show the menu" aria-expanded="false">☰</button>
        <span class="logo-mark"><img src="${esc(brand().logo)}"
          alt="${brand().wordmark ? '' : esc(brand().name)}"
          onerror="${markFailed}"></span>
        <h1 class="wordmark"${brand().wordmark ? '' : ' hidden'}>${esc(brand().name)}</h1>
        <span class="badge">${esc(roleName(user.role))}</span>
        <div class="spacer"></div>
        <div class="who"><b>${esc(user.name)}</b></div>
        <button class="btn line" id="mypw">Password</button>
        <button class="btn line" id="signout">Sign out</button>
      </header>
      <nav class="tabs" id="tabs">
        ${tabs.map(([id, icon, label]) => `
          <button class="${id === tab ? 'on' : ''}" data-tab="${esc(id)}">
            <span aria-hidden="true">${icon}</span> ${esc(label)}</button>`).join('')}
      </nav>
      <div class="pagearea">
        ${user.role === 'observer' ? `
          <div class="viewonly-note">👀 <b>View only.</b> You can see everything on
            these screens and change none of it. Pay and the company's money are
            not shown at all.</div>` : ''}
        <main class="page" id="page"></main>
      </div>
    </div>
    <div id="navBackdrop"></div>`;

  // Below 1000px the tabs are a drawer over the page rather than a column of
  // it, so anything that changes what the page shows has to close them again.
  const drawer = (open) => {
    $('#tabs').classList.toggle('open', open);
    $('#navBackdrop').classList.toggle('show', open);
    $('#navToggle').setAttribute('aria-expanded', String(open));
  };
  $('#navToggle').addEventListener('click', () => drawer(!$('#tabs').classList.contains('open')));
  $('#navBackdrop').addEventListener('click', () => drawer(false));

  $$('[data-tab]').forEach((b) => b.addEventListener('click', () => {
    tab = b.dataset.tab;
    drawFrame();
  }));
  $('#mypw').addEventListener('click', changeMyPassword);
  $('#signout').addEventListener('click', async () => {
    await POST('/api/logout');
    user = null;
    drawSignIn();
  });

  clearInterval(refreshTimer);
  closeAllDialogs();
  SCREENS[tab]?.($('#page')).catch(whoops);
}

// Everybody's own password, from the header, on every screen there is.
//
// In the header rather than on a tab because most roles have no tab about
// themselves at all — a cashier's screens are the till and the stockroom — and
// the person most likely to want this is whoever was handed a printed sheet
// this morning, whatever their role turned out to be.
//
// Typed twice, and the one they use now is asked for. A phone left face-up on
// a counter is a signed-in session, and without that question anybody walking
// past could lock its owner out of their own record.
function changeMyPassword() {
  dialog(`<h3>Change my password</h3>
    <p class="dim">Nobody here can read it back. If you forget it, an owner
      issues a new one.</p>
    <label for="mp_now">The password I use now</label>
    <input id="mp_now" type="password" autocomplete="current-password" autofocus>
    <label for="mp_new">My new password</label>
    <input id="mp_new" type="password" autocomplete="new-password">
    <label for="mp_again">My new password again</label>
    <input id="mp_again" type="password" autocomplete="new-password">
    <p class="dim mt">At least 8 characters.</p>
    <div class="mt right">
      <button class="btn quiet" id="mp_no">Cancel</button>
      <button class="btn" id="mp_go">Change it</button>
    </div>`);

  $('#mp_no').addEventListener('click', closeDialog);
  $('#mp_go').addEventListener('click', async () => {
    const now = $('#mp_now').value;
    const next = $('#mp_new').value;
    // Checked here as well as at the far end. Being told the two do not match
    // after a round trip, with all three boxes cleared, is a small cruelty.
    if (next !== $('#mp_again').value) {
      return notice('The two new passwords are not the same.', 'bad');
    }
    $('#mp_go').disabled = true;
    try {
      await POST('/api/my/password', { current: now, password: next });
      closeDialog();
      notice('Your password is changed 🌸', 'good');
    } catch (e) {
      whoops(e);
      $('#mp_go').disabled = false;
    }
  });
}

const SCREENS = {};

// ===========================================================================
// Dashboard
// ===========================================================================
SCREENS.dashboard = async (page) => {
  const load = async () => {
    const d = await GET('/api/dashboard');
    page.innerHTML = `
      <div class="head"><h2>Dashboard</h2>
        <span class="hint">Updates on its own</span></div>

      <div class="tiles">
        ${d.takings ? `
        <div class="tile good"><div class="big">${peso(d.takings.total)}</div>
          <div class="label">Taken at the till today (${d.takings.sales} sale${d.takings.sales === 1 ? '' : 's'})</div></div>`
        : ''}
        <div class="tile"><div class="big">${d.waitingOrders}</div>
          <div class="label">Wholesale orders waiting</div></div>
        <div class="tile ${d.reorder.length ? 'bad' : 'good'}"><div class="big">${d.reorder.length}</div>
          <div class="label">Products to reorder</div></div>
        <div class="tile ${d.overdue.length ? 'bad' : 'good'}"><div class="big">${d.overdue.length}</div>
          <div class="label">Invoices past due</div></div>
        <div class="tile ${d.ageing.length ? 'warn' : 'good'}"><div class="big">${d.ageing.length}</div>
          <div class="label">Batches near expiry</div></div>
        <div class="tile ${d.shelf.length ? 'warn' : 'good'}"><div class="big">${d.shelf.length}</div>
          <div class="label">Shop shelves running low</div></div>
      </div>

      ${d.exposure.length ? `<div class="banner bad">⚠️ ${d.exposure.map((e) =>
        `<b>${esc(e.name)}</b> owes ${(e.share * 100).toFixed(0)}% of everything outstanding (${peso(e.owed)})`
        ).join(' · ')}</div>` : ''}
      ${d.cashVariance.length ? `<div class="banner bad">⚠️ Repeated till differences: ${
        d.cashVariance.map((v) => `<b>${esc(v.cashier)}</b> (${v.flagged_counts} times, ${peso(v.net_variance)})`).join(' · ')
        }</div>` : ''}
      ${d.expired.length ? `<div class="banner warn">☠️ ${d.expired.length} expired batch line(s) still on the books — write them off in the Stockroom.</div>` : ''}

      <div class="split">
        <div class="panel"><h3>🔥 Order these now</h3>
          ${table(d.reorder, [
            { head: 'Product', cell: (r) => `<b>${esc(r.name)}</b>` },
            { head: 'In stock', n: true, cell: (r) => count(r.in_stock) },
            { head: 'Reorder at', n: true, cell: (r) => count(r.reorder_at) },
            { head: 'Order', n: true, cell: (r) => `<b>${count(Math.round(r.suggested_order))}</b>` },
          ], 'Nothing needs reordering 🌸')}</div>

        <div class="panel"><h3>💸 Past due</h3>
          ${table(d.overdue, [
            { head: 'Reseller', cell: (r) => esc(r.name) },
            { head: 'Due', cell: (r) => onDay(r.due_on) },
            { head: 'Days', n: true, cell: (r) => r.days_late },
            { head: 'Owed', n: true, cell: (r) => peso(r.balance) },
          ], 'Everyone is up to date 🌸')}</div>

        <div class="panel"><h3>⏳ Near expiry — clear these</h3>
          ${table(d.ageing, [
            { head: 'Product', cell: (r) => esc(r.name) },
            { head: 'Batch', cell: (r) => `<span class="dim">${esc(r.batch_no)}</span>` },
            { head: 'Expires', cell: (r) => onDay(r.expiry) },
            { head: 'Days', n: true, cell: (r) => r.days_left },
            { head: 'Qty', n: true, cell: (r) => count(r.qty) },
            { head: 'Value', n: true, cell: (r) => peso(r.value_at_risk) },
          ], 'Nothing within six months of expiry 🌸')}
          ${d.ageing.length ? '<div class="dim mt">Worth bundling, discounting, or turning into testers.</div>' : ''}</div>

        <div class="panel"><h3>🛎️ Bring stock to the shop</h3>
          ${table(d.restock, [
            { head: 'Product', cell: (r) => esc(r.name) },
            { head: 'Why', cell: (r) => `<span class="dim">${esc(r.note || '')}</span>` },
            { head: 'Raised', cell: (r) => when(r.raised_at) },
          ], 'The shop shelves are stocked 🌸')}</div>
      </div>`;
  };
  await load();
  repeat(load, 12000);
};

// ===========================================================================
// Products
// ===========================================================================
SCREENS.products = async (page) => {
  let term = '';
  const load = async () => {
    const rows = await GET(`/api/products?q=${encodeURIComponent(term)}`);
    $('#list', page).innerHTML = table(rows, [
      { head: '', cell: (p) => thumb(p) },
      { head: 'Code', cell: (p) => `<span class="dim">${esc(p.sku)}</span>` },
      { head: 'Product', cell: (p) => `<b>${esc(p.name)}</b>`
          + (p.active ? '' : ' ' + tag('hidden', 'grey'))
          + (p.abc_class ? ' ' + tag(p.abc_class, 'pink') : '') },
      { head: 'Brand', cell: (p) => esc(p.brand || '') },
      { head: 'Wholesale', n: true, cell: (p) => count(p.free_b2b) },
      { head: 'Shop', n: true, cell: (p) => count(p.free_shop) },
      { head: 'Reserve', n: true, cell: (p) => count(p.free_reserve) },
      { head: 'Held', n: true, cell: (p) => count(p.committed_b2b) },
      { head: 'To resellers', n: true, cell: (p) => peso(p.wholesale_price) },
      { head: 'They sell at', n: true, cell: (p) => peso(p.srp) },
      { head: 'We sell at', n: true, cell: (p) => peso(p.retail_price) },
      { head: 'Split', cell: (p) => `<span class="dim">${Math.round(p.alloc_b2b * 100)}/${
          Math.round(p.alloc_shop * 100)}/${Math.round(p.alloc_reserve * 100)}</span>` },
      { head: '', cell: (p) => `
          <button class="btn sm quiet" data-edit="${esc(p.sku)}">Edit</button>
          <button class="btn sm line" data-batches="${esc(p.sku)}">Batches</button>` },
    ], 'No products match that search.');

    $$('[data-edit]', page).forEach((b) => b.addEventListener('click',
      () => editProduct(rows.find((p) => p.sku === b.dataset.edit), load)));
    $$('[data-batches]', page).forEach((b) => b.addEventListener('click',
      () => showBatches(b.dataset.batches).catch(whoops)));
  };

  page.innerHTML = `
    <div class="head"><h2>Products</h2>
      <span class="hint">Counts are units free to sell, by pool</span></div>
    <div class="tools">
      <input type="search" id="find" placeholder="Search by code, name or brand…">
      <button class="btn" id="add">＋ New product</button>
      <button class="btn line" id="sheet">📋 Load a price list</button>
      <button class="btn line" id="pics">🖼️ Pictures, all at once</button>
    </div>
    <div class="panel" id="list"></div>
    ${user.role === 'admin' ? `
      <div class="danger">
        <h3>Going live</h3>
        <div class="dim">The shop was set up with invented deliveries, sales and
          reseller orders so there was something to test against. Erasing them
          leaves the sign-ins, the staff, the customers and your price list
          alone. It cannot be undone.</div>
        <div class="mt"><button class="btn warn sm" id="erase">Erase the practice data</button></div>
      </div>` : ''}`;

  $('#find', page).addEventListener('input', (e) => { term = e.target.value; load().catch(whoops); });
  $('#add', page).addEventListener('click', () => editProduct(null, load));
  $('#sheet', page).addEventListener('click',
    () => priceListDialog(GET('/api/products').catch(() => []), load));
  $('#pics', page).addEventListener('click',
    () => GET('/api/products').then((all) => productPhotosDialog(all, load)).catch(whoops));
  $('#erase', page)?.addEventListener('click', () => erasePracticeData(load));
  await load();
  repeat(load, 15000);
};

// Typing the word is the point. A button that erases the books on one tap is a
// button that will eventually be tapped by a sleeve.
function erasePracticeData(reload) {
  dialog(`
    <h3>Erase the practice data</h3>
    <div class="dim">This removes every delivery, every batch and unit of stock,
      every counter sale, every reseller order and its invoices and payments,
      every expense and promotion. Receipt numbering starts again at one.
      <br><br>It keeps the sign-ins, the staff, the customers who registered,
      the noticeboard and everything on your price list. Practice products that
      are already hidden go with it, since nothing will be left against them.
      <br><br><b>There is no way back from this.</b> Do it once, before the
      first real sale.</div>
    <label class="inline mt"><input type="checkbox" id="e_sellers" checked>
      Remove the sample resellers and their sign-ins too</label>
    <label class="mt" for="e_word">Type <b>ERASE</b> to confirm</label>
    <input id="e_word" type="text" placeholder="ERASE" autocomplete="off">
    <div class="mt right">
      <button class="btn quiet" id="e_cancel">Keep everything</button>
      <button class="btn warn" id="e_go" disabled>Erase</button>
    </div>`);

  const word = $('#e_word');
  word.addEventListener('input',
    () => { $('#e_go').disabled = word.value.trim().toUpperCase() !== 'ERASE'; });
  $('#e_cancel').addEventListener('click', closeDialog);

  $('#e_go').addEventListener('click', async () => {
    $('#e_go').disabled = true;
    try {
      const r = await POST('/api/catalogue/erase', {
        confirm: word.value.trim(), resellers: $('#e_sellers').checked,
      });
      closeDialog();
      notice(`Erased ${r.sales_erased} sales, ${r.orders_erased} orders and ${
        r.units_erased} units of stock. The books start here.`, 'good');
      reload();
    } catch (e) { whoops(e); $('#e_go').disabled = false; }
  });
}

// ===========================================================================
// The price list
//
// The brand issues one sheet with everything on it, so the shop takes one
// sheet with everything on it. Typing thirty products through thirty dialogs
// is not a smaller version of this job — it is the version where row nineteen
// gets missed and nobody finds out until somebody tries to sell it.
// ===========================================================================

// A starting point, not a claim about what is in stock. These are the lines
// Brilliant Skin Essentials is known for; the sizes and the exact range change,
// so the shop's own sheet is the authority. Prices are deliberately blank —
// a made-up price is far worse than a missing one.
const BRILLIANT_SKIN = `# code | product | category | costs us | to resellers | they sell at | we sell at | split
# Delete what you do not carry, add what is missing, then fill in the money.
# Leave a price blank and the product is saved but stays off the shelf.
# The split is wholesale/shop/reserve. 0/100/0 puts every delivery on the shelf.
BSE-SET-01 | Rejuvenating Set | Sets |  |  |  |  | 0/100/0
BSE-SET-02 | Anti-Acne Set | Sets |  |  |  |  | 0/100/0
BSE-SOP-01 | Kojic Papaya Soap 135g | Soaps |  |  |  |  | 0/100/0
BSE-SOP-02 | Kojic Papaya Soap 65g | Soaps |  |  |  |  | 0/100/0
BSE-SOP-03 | Anti-Acne Soap | Soaps |  |  |  |  | 0/100/0
BSE-SOP-04 | Glutathione Soap | Soaps |  |  |  |  | 0/100/0
BSE-TON-01 | Rejuvenating Toner 60ml | Toners |  |  |  |  | 0/100/0
BSE-TON-02 | Anti-Acne Toner 60ml | Toners |  |  |  |  | 0/100/0
BSE-CRM-01 | Rejuvenating Night Cream | Creams |  |  |  |  | 0/100/0
BSE-CRM-02 | Rejuvenating Day Cream | Creams |  |  |  |  | 0/100/0
BSE-CRM-03 | Underarm Whitening Cream | Creams |  |  |  |  | 0/100/0
BSE-SUN-01 | Sunblock SPF 60 | Sunscreen |  |  |  |  | 0/100/0
BSE-SER-01 | Facial Serum | Serums |  |  |  |  | 0/100/0
BSE-FAC-01 | Facial Wash | Face |  |  |  |  | 0/100/0
BSE-FAC-02 | Micellar Water | Face |  |  |  |  | 0/100/0
BSE-BOD-01 | Whitening Body Lotion | Body |  |  |  |  | 0/100/0
BSE-BOD-02 | Bleaching Body Set | Body |  |  |  |  | 0/100/0
BSE-LIP-01 | Lip and Cheek Tint | Lip |  |  |  |  | 0/100/0
BSE-WEL-01 | Slimming Coffee | Wellness |  |  |  |  | 0/100/0
BSE-WEL-02 | Glutathione Capsules | Wellness |  |  |  |  | 0/100/0`;

// Tab first, because the likeliest way this box gets filled is a paste out of
// a spreadsheet. Pipes next, because that is what the starter list uses and a
// product name is allowed to contain a comma.
function parsePriceList(text) {
  const items = [];
  const problems = [];
  const seen = new Set();

  text.split('\n').forEach((raw, index) => {
    const line = raw.trim();
    if (!line || line.startsWith('#')) return;
    const at = `Line ${index + 1}`;

    const sep = line.includes('\t') ? '\t' : line.includes('|') ? '|' : ',';
    const f = line.split(sep).map((s) => s.trim());

    const money = (s) => {
      if (!s || s === '-') return null;
      const n = Number(s.replace(/[₱,\s]/g, ''));
      return Number.isFinite(n) && n >= 0 ? n : NaN;
    };

    const item = {
      sku: (f[0] || '').toUpperCase(),
      name: f[1] || '',
      category: f[2] || '',
      unit_cost: money(f[3]),
      wholesale_price: money(f[4]),
      srp: money(f[5]),
      retail_price: money(f[6]),
      split: (f[7] || '').trim(),
    };

    // How a delivery of this product is split, written the way it reads:
    // wholesale / shop / reserve, as percentages. Left off, whatever the
    // product already has stands.
    if (item.split) {
      const parts = item.split.split(/[/\\]/).map((x) => Number(x.trim()));
      if (parts.length !== 3 || parts.some((v) => !Number.isFinite(v) || v < 0)) {
        problems.push(`${at}: “${item.split}” is not a split — write it as 0/100/0.`);
      } else if (Math.abs(parts[0] + parts[1] + parts[2] - 100) > 0.1) {
        problems.push(`${at}: the split adds up to ${
          Math.round((parts[0] + parts[1] + parts[2]) * 10) / 10}, not 100.`);
      } else {
        [item.alloc_b2b, item.alloc_shop, item.alloc_reserve] = parts.map((v) => v / 100);
      }
    }

    if (!item.sku) problems.push(`${at}: no product code.`);
    if (!item.name) problems.push(`${at}: no product name.`);
    if (seen.has(item.sku)) problems.push(`${at}: the code ${item.sku} is already used above.`);
    seen.add(item.sku);

    for (const [field, label] of [['unit_cost', 'cost'], ['wholesale_price', 'reseller price'],
      ['srp', 'their price'], ['retail_price', 'our price']]) {
      if (Number.isNaN(item[field])) problems.push(`${at}: “${f[{ unit_cost: 3, wholesale_price: 4, srp: 5, retail_price: 6 }[field]]}” is not a ${label}.`);
    }
    if (item.srp > 0 && item.retail_price > 0 && item.retail_price < item.srp) {
      problems.push(`${at}: our ${peso(item.retail_price)} is below the ${
        peso(item.srp)} resellers sell at.`);
    }

    items.push(item);
  });

  if (!items.length) problems.push('There are no products in that list.');
  return { items, problems };
}

async function priceListDialog(currentPromise, reload) {
  const current = await currentPromise;
  dialog(`
    <h3>Load a price list</h3>
    <div class="dim">One product a line, separated by <b>|</b> or tabs or commas:
      <br><code>code | product | category | costs us | to resellers | they sell at | we sell at | split</code>
      <br>Paste straight out of a spreadsheet if you have one. Lines starting
      with <b>#</b> are ignored. A product with no shop price is saved but stays
      off the shelf until you give it one.
      <br>The split is how a delivery is divided — <b>wholesale/shop/reserve</b>
      as percentages adding up to 100. <b>0/100/0</b> puts everything on the
      shelf. Leave it off and the product keeps the split it has; a brand new
      product with none takes the house 70/20/10.</div>
    <div class="row mt">
      <div><label>Brand on every line</label>
        <input id="c_brand" type="text" value="Brilliant Skin Essentials"></div>
      <div style="flex:0 0 auto; align-self:flex-end">
        <button class="btn quiet sm" id="c_starter">Start from the Brilliant Skin list</button>
        <button class="btn quiet sm" id="c_current">Start from what is here now</button>
      </div>
    </div>
    <label class="mt" for="c_text">The list</label>
    <textarea id="c_text" class="sheet" rows="12" spellcheck="false"></textarea>
    <div id="c_preview" class="mt"></div>
    <div class="mt right">
      <button class="btn quiet" id="c_cancel">Cancel</button>
      <button class="btn" id="c_save" disabled>Load this list</button>
    </div>`, 'wide');

  const pct = (v, fallback) => Math.round((v == null ? fallback : Number(v)) * 100);
  const splitOf = (p) =>
    `${pct(p.alloc_b2b, 0.7)}/${pct(p.alloc_shop, 0.2)}/${pct(p.alloc_reserve, 0.1)}`;
  const asLine = (p) => [p.sku, p.name, p.category || '', p.unit_cost, p.wholesale_price,
    p.srp, p.retail_price, splitOf(p)].join(' | ');

  const review = () => {
    const { items, problems } = parsePriceList($('#c_text').value);
    const listed = new Set(items.map((i) => i.sku));
    const going = current.filter((p) => !listed.has(p.sku));
    const unpriced = items.filter((i) => !i.retail_price).length;

    $('#c_preview').innerHTML = problems.length
      ? `<div class="none bad"><b>${problems.length} thing${
          problems.length === 1 ? '' : 's'} to fix first</b><br>${
          problems.slice(0, 12).map(esc).join('<br>')}${
          problems.length > 12 ? '<br>…' : ''}</div>`
      : `<div class="dim"><b>${items.length}</b> product${items.length === 1 ? '' : 's'} on this
           list${unpriced ? `, <b>${unpriced}</b> with no shop price yet — those stay off
           the shelf` : ''}.${going.length
             ? ` <b>${going.length}</b> currently listed ${going.length === 1
                 ? 'product is' : 'products are'} not on it and will be hidden, or removed
                 outright if ${going.length === 1 ? 'it has' : 'they have'} never traded:
                 ${esc(going.map((p) => p.name).slice(0, 6).join(', '))}${
                 going.length > 6 ? '…' : ''}.` : ''}</div>
         ${table(items.slice(0, 60), [
           { head: 'Code', cell: (i) => `<span class="dim">${esc(i.sku)}</span>` },
           { head: 'Product', cell: (i) => `<b>${esc(i.name)}</b>` },
           { head: 'Category', cell: (i) => esc(i.category) },
           { head: 'Costs us', n: true, cell: (i) => (i.unit_cost == null ? '—' : peso(i.unit_cost)) },
           { head: 'To resellers', n: true, cell: (i) => (i.wholesale_price == null ? '—' : peso(i.wholesale_price)) },
           { head: 'They sell at', n: true, cell: (i) => (i.srp == null ? '—' : peso(i.srp)) },
           { head: 'We sell at', n: true, cell: (i) => (i.retail_price == null ? '—' : peso(i.retail_price)) },
           { head: 'Split', cell: (i) => (i.alloc_shop == null
               ? '<span class="dim">unchanged</span>'
               : `<span class="dim">${i.split}</span>`) },
           { head: '', cell: (i) => (i.retail_price ? tag('on sale', 'green') : tag('no price', 'amber')) },
         ], '')}`;

    $('#c_save').disabled = problems.length > 0;
  };

  $('#c_text').addEventListener('input', review);
  $('#c_starter').addEventListener('click', () => { $('#c_text').value = BRILLIANT_SKIN; review(); });
  $('#c_current').addEventListener('click', () => {
    $('#c_text').value = current.map(asLine).join('\n');
    review();
  });
  $('#c_cancel').addEventListener('click', closeDialog);

  $('#c_save').addEventListener('click', async () => {
    const { items, problems } = parsePriceList($('#c_text').value);
    if (problems.length) return review();
    const brand = $('#c_brand').value.trim();

    // A blank cell means "leave this alone", so it is left out rather than
    // sent as a zero — sending zero would wipe a price that is already right.
    const payload = items.map((i) => {
      const row = { sku: i.sku, name: i.name };
      if (i.category) row.category = i.category;
      if (brand) row.brand = brand;
      for (const f of ['unit_cost', 'wholesale_price', 'srp', 'retail_price',
        'alloc_b2b', 'alloc_shop', 'alloc_reserve']) {
        if (i[f] != null) row[f] = i[f];
      }
      return row;
    });

    try {
      const r = await POST('/api/catalogue', { items: payload });
      closeDialog();
      notice(`${r.added} added, ${r.updated} updated, ${r.on_sale} on sale 🌸`, 'good');
      if (r.unpriced) notice(`${r.unpriced} still need a price before they can be sold.`);
      reload();
    } catch (e) { whoops(e); }
  });

  $('#c_text').value = current.length ? current.map(asLine).join('\n') : BRILLIANT_SKIN;
  review();
}

function editProduct(p, reload) {
  const isNew = !p;
  const num = (v, d = 0) => (v == null ? d : v);
  dialog(`
    <h3>${isNew ? 'New product' : esc(p.name)}</h3>
    <div class="row">
      <div><label>Product code</label>
        <input id="f_sku" type="text" value="${esc(p?.sku || '')}" ${isNew ? '' : 'disabled'}></div>
      <div style="flex:2"><label>Name</label>
        <input id="f_name" type="text" value="${esc(p?.name || '')}"></div>
    </div>
    <div class="row">
      <div><label>Brand</label><input id="f_brand" type="text" value="${esc(p?.brand || '')}"></div>
      <div><label>Category</label><input id="f_cat" type="text" value="${esc(p?.category || '')}"></div>
    </div>
    <div class="row">
      <div><label>Costs us</label><input id="f_cost" type="number" step="0.01" value="${num(p?.unit_cost)}"></div>
      <div><label>To resellers</label><input id="f_ws" type="number" step="0.01" value="${num(p?.wholesale_price)}"></div>
      <div><label>They sell at</label><input id="f_srp" type="number" step="0.01" value="${num(p?.srp)}"></div>
      <div><label>We sell at</label><input id="f_rp" type="number" step="0.01" value="${num(p?.retail_price)}"></div>
    </div>
    <div class="dim">Our shop price may not go below what resellers sell at.</div>
    <div class="row">
      <div><label>Shelf life (months)</label><input id="f_life" type="number" value="${num(p?.shelf_life_months, 24)}"></div>
      <div><label>Resellers need (months)</label><input id="f_floor" type="number" value="${num(p?.reseller_floor_months, 12)}"></div>
      <div><label>Keep at least (shop)</label><input id="f_min" type="number" value="${num(p?.shelf_min)}"></div>
    </div>
    <h3 class="mt">How a delivery is split</h3>
    <div class="dim">Must add up to 100. The house default is 70 / 20 / 10.</div>
    <div class="row">
      <div><label>Wholesale %</label><input id="f_ab" type="number" value="${Math.round(num(p?.alloc_b2b, 0.7) * 100)}"></div>
      <div><label>Shop %</label><input id="f_as" type="number" value="${Math.round(num(p?.alloc_shop, 0.2) * 100)}"></div>
      <div><label>Reserve %</label><input id="f_ar" type="number" value="${Math.round(num(p?.alloc_reserve, 0.1) * 100)}"></div>
    </div>
    ${isNew ? '' : `
      <h3 class="mt">Photograph</h3>
      <div class="dim">What the till and the customer app show for this product.</div>
      <div class="row" style="align-items:center">
        <div style="flex:0 0 auto" id="f_photo_now">${thumb(p, 76)}</div>
        <div><label for="f_photo">Choose a picture</label>
          <input id="f_photo" type="file" accept="image/*"></div>
        <div style="flex:0 0 auto">
          <button class="btn quiet sm" id="f_photo_clear"
            ${p.has_photo ? '' : 'disabled'}>Remove</button></div>
      </div>`}
    <div class="mt right">
      ${isNew ? '' : `<button class="btn quiet" id="f_toggle">${p.active ? 'Hide' : 'Show again'}</button>`}
      <button class="btn" id="f_save">Save</button>
    </div>`);


  // The photograph saves on its own, the moment one is chosen — it is not part
  // of the form below, and making someone press Save afterwards is how you end
  // up with a picture that silently did not upload.
  if (!isNew) {
    const showPhoto = (has) => {
      $('#f_photo_now').innerHTML = thumb({ sku: p.sku, has_photo: has }, 76)
        .replace('src="' + photoUrl(p.sku) + '"', 'src="' + photoUrl(p.sku, Date.now()) + '"');
      $('#f_photo_clear').disabled = !has;
    };

    $('#f_photo').addEventListener('change', async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      try {
        const dataUrl = await shrink(file);
        await POST(`/api/products/${encodeURIComponent(p.sku)}/photo`, { dataUrl });
        p.has_photo = true;
        showPhoto(true);
        notice('Picture saved 🌸', 'good');
        reload();
      } catch (err) { whoops(err); }
      e.target.value = '';
    });

    $('#f_photo_clear').addEventListener('click', async () => {
      try {
        await POST(`/api/products/${encodeURIComponent(p.sku)}/photo`, { dataUrl: null });
        p.has_photo = false;
        showPhoto(false);
        notice('Picture removed', 'good');
        reload();
      } catch (err) { whoops(err); }
    });
  }

  $('#f_save').addEventListener('click', async () => {
    const b2b = Number($('#f_ab').value) / 100;
    const shop = Number($('#f_as').value) / 100;
    const reserve = Number($('#f_ar').value) / 100;
    if (Math.abs(b2b + shop + reserve - 1) > 0.001) {
      return notice('The three shares have to add up to 100.', 'bad');
    }
    const body = {
      name: $('#f_name').value, brand: $('#f_brand').value, category: $('#f_cat').value,
      unit_cost: +$('#f_cost').value, wholesale_price: +$('#f_ws').value,
      srp: +$('#f_srp').value, retail_price: +$('#f_rp').value,
      shelf_life_months: +$('#f_life').value, reseller_floor_months: +$('#f_floor').value,
      shelf_min: +$('#f_min').value, alloc_b2b: b2b, alloc_shop: shop, alloc_reserve: reserve,
    };
    try {
      if (isNew) await POST('/api/products', { ...body, sku: $('#f_sku').value.trim() });
      else await PUT(`/api/products/${encodeURIComponent(p.sku)}`, body);
      notice('Saved 🌸', 'good');
      closeDialog();
      reload();
    } catch (e) { whoops(e); }
  });

  $('#f_toggle')?.addEventListener('click', async () => {
    try {
      await PUT(`/api/products/${encodeURIComponent(p.sku)}`, { active: !p.active });
      notice('Saved', 'good');
      closeDialog();
      reload();
    } catch (e) { whoops(e); }
  });
}

async function showBatches(sku) {
  const rows = await GET(`/api/products/${encodeURIComponent(sku)}/batches`);
  dialog(`
    <h3>${esc(rows[0]?.name || sku)} — batches</h3>
    ${table(rows, [
      { head: 'Batch', cell: (b) => esc(b.batch_no) },
      { head: 'Expires', cell: (b) => onDay(b.expiry) },
      { head: 'Days left', n: true, cell: (b) => b.days_left },
      { head: 'Flags', cell: (b) => (b.expired ? tag('expired', 'red')
          : b.ageing ? tag('near expiry', 'amber') : '')
          + (!b.expired && b.below_reseller_floor ? ' ' + tag('shop only', 'amber') : '') },
      { head: 'Wholesale', n: true, cell: (b) => count(b.free_b2b) },
      { head: 'Shop', n: true, cell: (b) => count(b.free_shop) },
      { head: 'Reserve', n: true, cell: (b) => count(b.free_reserve) },
    ], 'Nothing received for this product yet.')}
    <div class="dim mt">Counts are units free to sell. “Shop only” batches are too close
      to expiry for resellers to accept, but the shop can still sell them.</div>`);
}

// ===========================================================================
// Receiving
// ===========================================================================
// ---------------------------------------------------------------------------
// The receiving form: the whole delivery at once, counted in boxes
//
// Opened from two places now — the Receive screen, where a delivery arrives
// with no order behind it, and a purchase order, where it arrives against one.
// So it lives out here rather than inside either, and is told what it needs
// rather than reaching for it.
// ---------------------------------------------------------------------------
function receiveDelivery({ po, catalogue, shops, suppliers = [], done, over = false }) {
  // A purchase order's outstanding lines are what you expect to be holding,
  // so they are what the form opens with — already counted, still editable,
  // because what a supplier sends and what was asked for are two things.
  const items = (po?.lines || [])
    .filter((l) => l.qty - l.received > 0)
    .map((l) => ({
      sku: l.sku, name: l.name, unit: l.unit || 'PCS', po_line_id: l.id,
      batch_no: '', expiry: '', unit_cost: '',
      packs: [{ pack: 'BOX', qty_per_box: l.qty - l.received, boxes: 1 }],
    }));

  dialog(`
    <h3>Receiving form${po ? ` <span class="dim">· against ${esc(po.po_no)}</span>` : ''}</h3>
    <div class="dim">Counted the way it arrives: how many to a box, and how
      many boxes. A product can have more than one packing — three boxes of
      sixteen and one plastic of nine is one product and fifty-seven bottles.</div>

    <div class="row mt">
      ${po ? `<div style="flex:2"><label>Supplier</label>
               <div class="fixed">${esc(po.supplier)}</div></div>`
           : `<div style="flex:2"><label>Supplier</label>
               <select id="rf_supplier">${suppliers.map((v) =>
                 `<option value="${v.id}">${esc(v.name)}</option>`).join('')}</select></div>`}
      <div><label>Date received</label><input id="rf_on" type="date"></div>
      <div><label>Date and time on the gate</label>
        <input id="rf_at" type="text" placeholder="e.g. 26/08 3:40 PM"></div>
      ${branchPicker(shops, 'rf_branch', 'Arrived at')}
    </div>

    <div class="row">
      <div><label>Drivers name</label><input id="rf_driver" type="text"></div>
      <div><label>Plate no.</label><input id="rf_plate" type="text"></div>
      <div style="flex:2"><label>Address — pickup</label><input id="rf_pickup" type="text"></div>
      <div><label>Contact #</label><input id="rf_contact" type="text"></div>
    </div>

    <div class="row">
      <div><label>Shipping fee</label>
        <input id="rf_fee" type="number" step="0.01" min="0" placeholder="0.00"></div>
      <div><label>MOP</label><input id="rf_mop" type="text" placeholder="cash, GCash…"></div>
      <div><label>Total of boxes</label>
        <input id="rf_boxes" type="number" min="0" placeholder="counted below"></div>
      <div><label>Guard on duty</label><input id="rf_guard" type="text"></div>
    </div>

    <div class="row">
      <div style="flex:2"><label>Add a product</label>
        <input id="rf_add" type="text" list="rf_skus" placeholder="scan or type a code">
        <datalist id="rf_skus"></datalist></div>
      <div style="flex:0 0 auto" class="pushdown">
        <button class="btn line" id="rf_addgo">＋ Add</button></div>
    </div>

    <div id="rf_items" class="mt"></div>

    <div class="row mt">
      <div><label>Checked by</label><input id="rf_checked" type="text"></div>
      <div><label>Approved by</label><input id="rf_approved" type="text"></div>
      <div style="flex:2"><label>Others</label><input id="rf_others" type="text"></div>
    </div>
    <div class="mt right">
      <b id="rf_sum" class="dim"></b>
      <button class="btn" id="rf_go">Record the delivery</button></div>`, 'wide', over);

  $('#rf_skus').innerHTML = catalogue.map((c) =>
    `<option value="${esc(c.sku)}">${esc(c.name)}</option>`).join('');
  $('#rf_on').value = new Date().toISOString().slice(0, 10);

  // The inputs are the truth between redraws — read them back before any
  // redraw, or a half-typed batch number vanishes when a packing is added.
  const harvest = () => {
    $$('[data-item]').forEach((box) => {
      const it = items[+box.dataset.item];
      if (!it) return;
      it.unit = $('.i-unit', box).value.trim().toUpperCase() || 'PCS';
      it.batch_no = $('.i-batch', box).value;
      it.expiry = $('.i-exp', box).value;
      it.unit_cost = $('.i-cost', box).value;
      it.packs = $$('[data-pack]', box).map((row) => ({
        pack: $('.p-pack', row).value.trim().toUpperCase() || 'BOX',
        qty_per_box: +$('.p-per', row).value || 0,
        boxes: +$('.p-boxes', row).value || 0,
      }));
    });
  };

  const totalOf = (it) => it.packs.reduce((n, k) => n + k.qty_per_box * k.boxes, 0);
  const boxesOf = (it) => it.packs.reduce((n, k) => n + k.boxes, 0);

  const retally = () => {
    harvest();
    const units = items.reduce((n, it) => n + totalOf(it), 0);
    const cartons = items.reduce((n, it) => n + boxesOf(it), 0);
    $$('[data-item]').forEach((box) => {
      const it = items[+box.dataset.item];
      $('.i-total', box).textContent = it ? `${count(totalOf(it))} ${it.unit}` : '';
    });
    $('#rf_sum').textContent = items.length
      ? `${count(units)} units in ${count(cartons)} boxes  `
      : '';
    if (!$('#rf_boxes').value) $('#rf_boxes').placeholder = String(cartons || 0);
  };

  const drawItems = () => {
    $('#rf_items').innerHTML = items.length ? items.map((it, i) => `
      <div class="rfitem" data-item="${i}">
        <div class="row">
          <div style="flex:2"><label>Product</label>
            <div class="fixed"><b>${esc(it.name)}</b>
              <span class="dim">${esc(it.sku)}</span></div></div>
          <div style="flex:0 0 90px"><label>Unit</label>
            <input class="i-unit" type="text" value="${esc(it.unit || 'PCS')}"></div>
          <div><label>Batch number</label>
            <input class="i-batch" type="text" value="${esc(it.batch_no)}"></div>
          <div><label>Expiry date</label>
            <input class="i-exp" type="date" value="${esc(it.expiry)}"></div>
          <div><label>Cost each</label>
            <input class="i-cost" type="number" step="0.01" min="0"
                   placeholder="unchanged" value="${esc(it.unit_cost)}"></div>
          <div style="flex:0 0 auto" class="pushdown">
            <button class="btn sm line stop" data-drop="${i}">Remove</button></div>
        </div>
        ${it.packs.map((k, j) => `
          <div class="row packrow" data-pack="${j}">
            <div><label>Packing</label>
              <input class="p-pack" type="text" value="${esc(k.pack)}"></div>
            <div><label>Qty per box</label>
              <input class="p-per" type="number" min="1" value="${k.qty_per_box || ''}"></div>
            <div><label>No. of boxes</label>
              <input class="p-boxes" type="number" min="1" value="${k.boxes || ''}"></div>
            <div style="flex:0 0 auto" class="pushdown">
              ${it.packs.length > 1
                ? `<button class="btn sm quiet" data-droppack="${i}:${j}">✕</button>` : ''}
            </div>
          </div>`).join('')}
        <div class="row packfoot">
          <button class="btn sm quiet" data-addpack="${i}">＋ another packing</button>
          <span class="dim">comes to <b class="i-total"></b></span>
        </div>
      </div>`).join('')
      : '<div class="dim">Nothing on this delivery yet.</div>';

    $$('[data-drop]').forEach((b) => b.addEventListener('click', () => {
      harvest(); items.splice(+b.dataset.drop, 1); drawItems();
    }));
    $$('[data-addpack]').forEach((b) => b.addEventListener('click', () => {
      harvest();
      items[+b.dataset.addpack].packs.push({ pack: 'BOX', qty_per_box: 0, boxes: 1 });
      drawItems();
    }));
    $$('[data-droppack]').forEach((b) => b.addEventListener('click', () => {
      harvest();
      const [i, j] = b.dataset.droppack.split(':').map(Number);
      items[i].packs.splice(j, 1);
      drawItems();
    }));
    $$('#rf_items input').forEach((el) => el.addEventListener('input', retally));
    retally();
  };
  drawItems();

  const addProduct = () => {
    const sku = $('#rf_add').value.trim().toUpperCase();
    if (!sku) return;
    const found = catalogue.find((c) => c.sku.toUpperCase() === sku);
    if (!found) return notice('No product with that code.', 'bad');
    harvest();
    items.push({
      sku: found.sku, name: found.name, unit: found.unit_type || 'PCS',
      po_line_id: po?.lines?.find((l) => l.sku === found.sku)?.id || null,
      batch_no: '', expiry: '', unit_cost: '',
      packs: [{ pack: 'BOX', qty_per_box: 0, boxes: 1 }],
    });
    $('#rf_add').value = '';
    drawItems();
  };
  $('#rf_addgo').addEventListener('click', addProduct);
  $('#rf_add').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); addProduct(); }
  });

  $('#rf_go').addEventListener('click', async () => {
    harvest();
    if (!items.length) return notice('Nothing on this delivery yet.', 'bad');
    $('#rf_go').disabled = true;
    try {
      const out = await POST('/api/receiving-forms', {
        po_id: po?.id || null,
        supplier_id: po ? null : $('#rf_supplier')?.value || null,
        branch_id: branchOf(document, 'rf_branch'),
        lines: items,
        courier: {
          driver_name: $('#rf_driver').value, plate_no: $('#rf_plate').value,
          pickup: $('#rf_pickup').value, contact: $('#rf_contact').value,
          shipping_fee: $('#rf_fee').value, shipping_mop: $('#rf_mop').value,
          received_at: $('#rf_at').value,
        },
        foot: {
          received_on: $('#rf_on').value, total_boxes: $('#rf_boxes').value,
          others: $('#rf_others').value, guard_on_duty: $('#rf_guard').value,
          checked_by: $('#rf_checked').value, approved_by: $('#rf_approved').value,
        },
      });
      notice(`${esc(out.rf_no)} — ${count(out.units)} units in 🌸`, 'good');
      closeDialog();
      done();
      const full = await GET(`/api/receiving-forms/${out.id}`).catch(() => null);
      if (full) showReceivingForm(full, true);
    } catch (e) { whoops(e); $('#rf_go').disabled = false; }
  });
}

SCREENS.receive = async (page) => {
  const shops = await branches();
  let suppliers = [];
  page.innerHTML = `
    <div class="head"><h2>Receive a delivery</h2>
      <span class="hint">Splits automatically between wholesale, shop and reserve</span></div>
    <div class="panel">
      <div class="row">
        <div style="flex:2"><label>Product code</label>
          <input type="text" id="r_sku" list="skus" placeholder="scan or type"></div>
        <div><label>Batch number</label><input type="text" id="r_batch"></div>
        <div><label>Expiry date</label><input type="date" id="r_exp"></div>
        <div><label>How many</label><input type="number" id="r_qty" min="1"></div>
        <div><label>Cost each</label>
          <input type="number" id="r_cost" step="0.01" min="0" placeholder="unchanged"></div>
        <div><label>Paid by</label>
          <select id="r_method">
            <option value="bank">Bank transfer</option>
            <option value="cash">Cash</option>
            <option value="gcash">GCash</option>
            <option value="card">Card</option>
          </select></div>
        ${branchPicker(shops, 'r_branch', 'Arrived at')}
        <div style="flex:0 0 auto"><button class="btn" id="r_go">Receive</button></div>
        <div style="flex:0 0 auto"><button class="btn line" id="r_note">📦 Whole delivery</button></div>
      </div>
      <div class="dim">What this delivery cost is recorded against the money going
        out, and becomes the product's cost from now on. Leave it blank to keep
        the cost you already have. What came in is on <b>Inventory</b>, where it
        can still be undone.</div>
      <datalist id="skus"></datalist>
      <div id="r_out" class="mt"></div>
    </div>

    <div class="panel"><h3>Receiving forms</h3>
      <div class="dim">The paper the stockroom fills in while the delivery is
        still on the floor — counted in boxes, with the courier, the shipping
        and the guard on it. It receives the stock as it records itself, and
        where it answers a purchase order it ticks that order off too.</div>
      <div class="row mt">
        <div style="flex:0 0 auto"><button class="btn" id="rf_new">＋ Record a delivery</button></div>
      </div>
      <div id="rf_list" class="mt"></div></div>`;

  GET('/api/products?q=').then((rows) => {
    $('#skus', page).innerHTML = rows.map((p) =>
      `<option value="${esc(p.sku)}">${esc(p.name)}</option>`).join('');
  }).catch(() => {});

  $('#r_go', page).addEventListener('click', async () => {
    try {
      const r = await POST('/api/receive', {
        sku: $('#r_sku', page).value.trim(),
        batch_no: $('#r_batch', page).value.trim(),
        expiry: $('#r_exp', page).value,
        qty: +$('#r_qty', page).value,
        unit_cost: $('#r_cost', page).value,
        method: $('#r_method', page).value,
        branch_id: branchOf(page, 'r_branch'),
      });
      const label = { b2b: 'Wholesale', shop: 'Shop', reserve: 'Reserve' };
      $('#r_out', page).innerHTML = `<div class="banner good">✅ Received and split —
        ${r.allocation.map((a) => `<b>${esc(label[a.pool] || a.pool)}</b> ${a.on_hand}`).join(' · ')}</div>`;
      $('#r_batch', page).value = '';
      $('#r_qty', page).value = '';
      $('#r_cost', page).value = '';
      // What came in is listed on Inventory now, with the undo beside it.
    } catch (e) { whoops(e); }
  });

  wireBranchPicker(page, 'r_branch');
  $('#r_note', page).addEventListener('click',
    () => deliveryDialog(GET('/api/products?q=').catch(() => []), () => {},
      branchOf(page, 'r_branch')));

  const drawRFs = async () => {
    const rows = await GET('/api/receiving-forms').catch(() => []);
    $('#rf_list', page).innerHTML = table(rows, [
      { head: 'No.', cell: (f) => `<b>${esc(f.rf_no)}</b>` },
      { head: 'Received', cell: (f) => onDay(f.received_on) },
      { head: 'Supplier', cell: (f) => `${esc(f.supplier)}${
          f.brand_name ? `<div class="dim">${esc(f.brand_name)}</div>` : ''}` },
      { head: 'Against', cell: (f) => f.po_no ? esc(f.po_no) : tag('no order', 'grey') },
      { head: 'Products', n: true, cell: (f) => count(f.products) },
      { head: 'Units', n: true, cell: (f) => count(f.units) },
      { head: 'Boxes', n: true, cell: (f) => count(f.total_boxes) },
      { head: '', cell: (f) => `<button class="btn sm quiet" data-rf="${f.id}">Open</button>` },
    ], 'No receiving forms yet.');
    $$('[data-rf]', page).forEach((b) => b.addEventListener('click', async () => {
      try { showReceivingForm(await GET(`/api/receiving-forms/${b.dataset.rf}`)); }
      catch (e) { whoops(e); }
    }));
  };

  $('#rf_new', page).addEventListener('click', async () => {
    if (!suppliers.length) return notice('Add a supplier first, on Purchase order.', 'bad');
    const catalogue = await GET('/api/products?q=').catch(() => []);
    receiveDelivery({ po: null, catalogue, shops, suppliers, done: () => drawRFs() });
  });

  suppliers = await GET('/api/suppliers').catch(() => []);
  await drawRFs();
};

// ===========================================================================
// Purchase orders — the company buying
// ===========================================================================
SCREENS.purchaseorders = async (page) => {
  const shops = await branches();
  let suppliers = [];
  page.innerHTML = `
    <div class="head"><h2>Purchase order</h2>
      <span class="hint">What has been asked of a supplier, and what is still short</span></div>
    <div class="panel">
      <div class="dim">A purchase order carries no prices: it says what is
        wanted and how much of it, and what it costs lands when the goods are
        received. Receiving against a line records the batch and the cost
        exactly as receiving anything does — it also notes how much of the
        order that delivery covered.</div>
      <div class="row mt">
        <div style="flex:2"><label>Supplier</label>
          <select id="po_supplier"></select></div>
        <div style="flex:0 0 auto"><button class="btn line" id="po_newsup">＋ New supplier</button></div>
        <div style="flex:0 0 auto"><button class="btn" id="po_new">＋ Raise a purchase order</button></div>
      </div>
      <div id="po_list" class="mt"></div></div>`;

  const drawSuppliers = async () => {
    suppliers = await GET('/api/suppliers').catch(() => []);
    $('#po_supplier', page).innerHTML = suppliers.length
      ? suppliers.map((v) => `<option value="${v.id}">${esc(v.name)}${
          v.brand_name ? ` — ${esc(v.brand_name)}` : ''}</option>`).join('')
      : '<option value="">No suppliers yet</option>';
  };


  const drawPOs = async () => {
    const rows = await GET('/api/purchase-orders').catch(() => []);
    $('#po_list', page).innerHTML = table(rows, [
      { head: 'No.', cell: (o) => `<b>${esc(o.po_no)}</b>` },
      { head: 'Raised', cell: (o) => onDay(o.ordered_on) },
      { head: 'Supplier', cell: (o) => `${esc(o.supplier)}${
          o.brand_name ? `<div class="dim">${esc(o.brand_name)}</div>` : ''}` },
      { head: 'Lines', n: true, cell: (o) => count(o.lines) },
      { head: 'Still short', n: true, cell: (o) => o.still_short > 0
          ? `<b>${count(o.still_short)}</b>` : '—' },
      { head: 'State', cell: (o) => o.status === 'closed' ? tag('all in', 'green')
          : o.status === 'part' ? tag('part delivered', 'amber')
          : o.status === 'cancelled' ? tag('cancelled', 'grey') : tag('open', 'pink') },
      { head: '', cell: (o) => `<button class="btn sm quiet" data-po="${o.id}">Open</button>` },
    ], 'No purchase orders yet.');
    $$('[data-po]', page).forEach((b) => b.addEventListener('click',
      () => openPO(+b.dataset.po).catch(whoops)));
  };

  // Opened rather than printed straight away: the sheet is one of the things
  // in here, but so is receiving against it, and both belong to the order.

  async function openPO(poId) {
    const po = await GET(`/api/purchase-orders/${poId}`);
    const shops = await branches();
    dialog(`
      <h3>${esc(po.po_no)} <span class="dim">· ${esc(po.supplier)}</span></h3>
      <div class="dim">Raised ${onDay(po.ordered_on)} by ${esc(po.raised_by)}${
        po.note ? ` · ${esc(po.note)}` : ''}</div>
      <div class="mt right">
        <button class="btn quiet" id="po_sheet">🧾 The purchase order</button>
        ${po.status === 'open' || po.status === 'part'
          ? '<button class="btn line" id="po_rf">📗 Receive the whole delivery</button>' : ''}
        ${po.status === 'open' || po.status === 'part'
          ? '<button class="btn line stop" id="po_cancel">Cancel this order</button>' : ''}
      </div>
      <div id="po_lines" class="mt"></div>`, 'wide');

    const drawLines = () => {
      $('#po_lines').innerHTML = table(po.lines, [
        { head: 'Product', cell: (l) => `<b>${esc(l.name)}</b>
            <div class="dim">${esc(l.sku)}</div>` },
        { head: 'Ordered', n: true, cell: (l) => `${count(l.qty)} ${esc(l.unit)}` },
        { head: 'In', n: true, cell: (l) => count(l.received) },
        { head: 'Short', n: true, cell: (l) => l.qty - l.received > 0
            ? `<b>${count(l.qty - l.received)}</b>` : tag('all in', 'green') },
        { head: '', cell: (l) => l.qty - l.received > 0
            ? `<button class="btn sm" data-recv="${l.id}">Receive</button>` : '' },
      ], 'Nothing on this order.');

      $$('[data-recv]').forEach((b) => b.addEventListener('click', () => {
        const line = po.lines.find((l) => String(l.id) === b.dataset.recv);
        receiveLine(po, line, shops, async () => {
          const fresh = await GET(`/api/purchase-orders/${poId}`);
          po.lines = fresh.lines;
          po.status = fresh.status;
          drawLines();
          drawPOs();
        });
      }));
    };
    drawLines();

    $('#po_sheet').addEventListener('click', () => showPurchaseOrder(po, true));
    $('#po_rf')?.addEventListener('click', async () => {
      const catalogue = await GET('/api/products?q=').catch(() => []);
      receiveDelivery({
        po, catalogue, shops, suppliers, over: true,
        done: () => drawPOs(),
      });
    });
    $('#po_cancel')?.addEventListener('click', async () => {
      try {
        await POST(`/api/purchase-orders/${poId}/cancel`, {});
        notice('Purchase order cancelled', 'good');
        closeDialog();
        drawPOs();
      } catch (e) { whoops(e); }
    });
  }

  // The delivery itself. Batch, expiry and cost are the same three things
  // receiving has always asked for, because this is the same receiving.

  function receiveLine(po, line, shops, done) {
    const short = line.qty - line.received;
    dialog(`
      <h3>Receive against ${esc(po.po_no)}</h3>
      <div class="dim"><b>${esc(line.name)}</b> — ${count(short)} of
        ${count(line.qty)} ${esc(line.unit)} still to come.</div>
      <div class="row mt">
        <div><label>Batch number</label><input id="pr_batch" type="text" autofocus></div>
        <div><label>Expiry date</label><input id="pr_exp" type="date"></div>
        <div><label>How many arrived</label>
          <input id="pr_qty" type="number" min="1" value="${short}"></div>
        <div><label>Cost each</label>
          <input id="pr_cost" type="number" step="0.01" min="0" placeholder="unchanged"></div>
      </div>
      <div class="row">
        <div><label>Paid by</label><select id="pr_method">
          <option value="bank">Bank transfer</option><option value="cash">Cash</option>
          <option value="gcash">GCash</option><option value="card">Card</option></select></div>
        ${branchPicker(shops, 'pr_branch', 'Arrived at')}
        <div style="flex:0 0 auto"><button class="btn" id="pr_go">Receive</button></div>
      </div>
      <div class="dim">More than was ordered is recorded, not refused — a
        supplier who sends a hundred against an order for ninety-six has sent a
        hundred.</div>`, '', true);

    $('#pr_go').addEventListener('click', async () => {
      const qty = +$('#pr_qty').value;
      if (!(qty > 0)) return whoops(new Error('How many arrived?'));
      $('#pr_go').disabled = true;
      try {
        const out = await POST(`/api/purchase-orders/lines/${line.id}/receive`, {
          batch_no: $('#pr_batch').value, expiry: $('#pr_exp').value, qty,
          unit_cost: $('#pr_cost').value, method: $('#pr_method').value,
          branch_id: branchOf(document, 'pr_branch'),
        });
        notice(`${count(out.received)} of ${count(out.ordered)} in 🌸`, 'good');
        closeDialog();
        done();
      } catch (e) { whoops(e); $('#pr_go').disabled = false; }
    });
  }

  // -------------------------------------------------------------------------
  // The receiving form: the whole delivery at once, counted in boxes
  //
  // receiveLine above takes one product because sometimes one product is what
  // turned up. This takes the van: every product on it, each in the packings it
  // came in, and the courier, the shipping and the guard around them. It posts
  // the same receive_stock underneath, once per product, and where it is
  // answering a purchase order it ticks that order off as it goes.
  // -------------------------------------------------------------------------

  $('#po_newsup', page).addEventListener('click', () => {
    dialog(`
      <h3>New supplier</h3>
      <div class="row">
        <div style="flex:2"><label>Company name</label><input id="s_name" type="text" autofocus></div>
        <div style="flex:2"><label>Brand name</label><input id="s_brand" type="text"></div>
      </div>
      <div class="row">
        <div><label>TIN no.</label><input id="s_tin" type="text"></div>
        <div style="flex:2"><label>Address</label><input id="s_addr" type="text"></div>
        <div><label>Contact #</label><input id="s_contact" type="text"></div>
      </div>
      <div class="dim mt">All of it prints on the purchase order. Leave blank
        what they have not given you.</div>
      <div class="mt right"><button class="btn" id="s_save">Save supplier</button></div>`);
    $('#s_save').addEventListener('click', async () => {
      try {
        await POST('/api/suppliers', {
          name: $('#s_name').value, brand_name: $('#s_brand').value,
          tin: $('#s_tin').value, address: $('#s_addr').value,
          contact: $('#s_contact').value,
        });
        notice('Supplier saved 🌸', 'good');
        closeDialog();
        drawSuppliers();
      } catch (e) { whoops(e); }
    });
  });


  $('#po_new', page).addEventListener('click', async () => {
    const supplier = $('#po_supplier', page).value;
    if (!supplier) return notice('Add a supplier first.', 'bad');
    const catalogue = await GET('/api/products?q=').catch(() => []);
    const basket = new Map();

    dialog(`
      <h3>Raise a purchase order</h3>
      <div class="dim">To <b>${esc(($('#po_supplier', page).selectedOptions[0] || {}).text || '')}</b>.
        No prices: a purchase order says what is wanted and how much of it, and
        what it costs lands when the goods are received.</div>
      <input type="search" id="pn_find" class="mt" placeholder="Search products…">
      <div class="dim" id="pn_count" style="font-size:.72rem;margin:4px 0 2px"></div>
      <div id="pn_goods" class="scroll" style="max-height:280px;overflow-y:auto"></div>
      <h4 class="mt">On this order</h4>
      <div id="pn_basket"></div>
      <div class="row mt"><div style="flex:3"><label>Comments or special instructions</label>
        <input id="pn_note" type="text"></div></div>
      <div class="mt right"><button class="btn" id="pn_go">Raise it</button></div>`, 'wide');

    const drawGoods = () => {
      const term = ($('#pn_find').value || '').trim().toLowerCase();
      const rows = catalogue.filter((p) => !term
        || p.name.toLowerCase().includes(term) || p.sku.toLowerCase().includes(term));
      $('#pn_count').textContent = term
        ? `${rows.length} of ${catalogue.length} products match “${term}”`
        : `All ${rows.length} products — type to narrow it down`;
      $('#pn_goods').innerHTML = table(rows, [
        { head: 'Product', cell: (p) => `<b>${esc(p.name)}</b>
            <span class="dim">${esc(p.sku)}</span>` },
        { head: '', cell: (p) => `<button class="btn sm quiet"
            data-add="${esc(p.sku)}">Add</button>` },
      ], 'Nothing matches.');
      $$('[data-add]', $('#pn_goods')).forEach((b) => b.addEventListener('click', () => {
        const prod = catalogue.find((x) => x.sku === b.dataset.add);
        const at = basket.get(prod.sku)
          ?? { sku: prod.sku, name: prod.name, unit: prod.unit_type || 'PCS', qty: 0 };
        at.qty += 1;
        basket.set(prod.sku, at);
        drawBasket();
      }));
    };

    const drawBasket = () => {
      $('#pn_basket').innerHTML = basket.size ? [...basket.values()].map((l) => `
        <div class="pick">
          <span class="nm"><b>${esc(l.name)}</b><br><span class="dim">${esc(l.sku)}</span></span>
          <input type="number" min="1" value="${l.qty}" data-q="${esc(l.sku)}">
          <input type="text" value="${esc(l.unit)}" data-u="${esc(l.sku)}" style="width:74px">
          <button class="btn sm stop" data-x="${esc(l.sku)}">✕</button>
        </div>`).join('') : '<div class="none">Nothing added yet.</div>';
      $$('[data-q]', $('#pn_basket')).forEach((i) => i.addEventListener('change', () => {
        basket.get(i.dataset.q).qty = Math.max(1, +i.value || 1);
      }));
      $$('[data-u]', $('#pn_basket')).forEach((i) => i.addEventListener('change', () => {
        basket.get(i.dataset.u).unit = i.value.trim() || 'PCS';
      }));
      $$('[data-x]', $('#pn_basket')).forEach((b) => b.addEventListener('click', () => {
        basket.delete(b.dataset.x);
        drawBasket();
      }));
    };

    $('#pn_find').addEventListener('input', drawGoods);
    drawGoods();
    drawBasket();

    $('#pn_go').addEventListener('click', async () => {
      if (!basket.size) return notice('Add what is being ordered first.', 'bad');
      $('#pn_go').disabled = true;
      try {
        const out = await POST('/api/purchase-orders', {
          supplier_id: supplier, note: $('#pn_note').value,
          lines: [...basket.values()],
        });
        notice(`${out.po_no} raised 🌸`, 'good');
        closeDialog();
        await drawPOs();
        openPO(Number(out.id)).catch(whoops);
      } catch (e) { whoops(e); $('#pn_go').disabled = false; }
    });
  });

  await drawSuppliers();
  await drawPOs();
};

// ===========================================================================
// Inventory — what came in, and what can still be unmade
// ===========================================================================
SCREENS.inventory = async (page) => {
  page.innerHTML = `
    <div class="head"><h2>Inventory</h2>
      <span class="hint">Everything that has moved, newest first</span></div>
    <div class="panel"><h3>Deliveries you can still undo</h3>
      <div class="dim">A delivery entered wrongly should be unmade, not written
        off as damage — writing it off puts goods that never existed into the
        shrinkage report and money that never moved into the loss column. This
        only works while nothing has happened to the lot yet.</div>
      <div id="r_undo" class="mt"></div></div>
    <div class="panel"><h3>Just received</h3><div id="r_recent"></div></div>`;

  const recent = async () => {
    const rows = await GET('/api/reports/journal?limit=20');
    $('#r_recent', page).innerHTML = table(rows, [
      { head: 'When', cell: (m) => when(m.at) },
      { head: 'Product', cell: (m) => esc(m.name) },
      { head: 'Batch', cell: (m) => `<span class="dim">${esc(m.batch_no)}</span>` },
      { head: 'Move', cell: (m) => `${esc(m.from_pool || '·')} → ${esc(m.to_pool || 'out')}` },
      { head: 'Qty', n: true, cell: (m) => count(m.qty) },
      { head: 'Why', cell: (m) => `<span class="dim">${esc(m.reason)}</span>` },
      { head: 'Who', cell: (m) => `<span class="dim">${esc(m.actor)}</span>` },
    ], 'Nothing has moved yet.');
  };

  // The list says why a delivery is stuck as well as that it is, so nobody
  // presses a button to find out.

  const undoable = async () => {
    const rows = await GET('/api/receipts?limit=15');
    $('#r_undo', page).innerHTML = table(rows, [
      { head: 'When', cell: (r) => when(r.received_at) },
      { head: 'Product', cell: (r) => esc(r.name) },
      { head: 'Batch', cell: (r) => `<span class="dim">${esc(r.batch_no || '—')}</span>` },
      { head: 'Units', n: true, cell: (r) => count(r.qty_received) },
      { head: 'Cost', n: true, cell: (r) => peso(r.value) },
      { head: 'Where', cell: (r) => `<span class="dim">${esc(r.branches || '—')}</span>` },
      { head: '', cell: (r) => (r.held_by
          ? tag(r.held_by, 'grey')
          : `<button class="btn sm stop" data-undo="${r.batch_id}"
               data-what="${esc(r.name)} — ${esc(r.batch_no || 'no batch number')}, ${
                 r.qty_received} unit(s), ${peso(r.value)}">Undo</button>`) },
    ], 'Nothing received yet.');

    $$('[data-undo]', page).forEach((b) => b.addEventListener('click',
      () => undoDialog(b.dataset.undo, b.dataset.what, () => {
        undoable(); recent();
      })));
  };

  await recent();
  await undoable().catch(() => {});
  repeat(recent, 15000);
};


// Undoing a delivery removes every trace that it was entered, so the reason is
// the only thing left behind. That is why the box is not optional, and why the
// dialog says plainly what is about to disappear.
function undoDialog(batchId, what, done) {
  dialog(`
    <h3>Undo this delivery?</h3>
    <div class="dim">${esc(what)}</div>
    <div class="banner warn mt">The stock, the money recorded as paid out and
      the journal lines all go together, as though the delivery had never been
      entered. It cannot be undone twice.</div>
    <div class="mt"><label>Why is this being undone?</label>
      <input id="ud_why" type="text" placeholder="typed 10000 instead of 1000"></div>
    <div class="row mt">
      <button class="btn stop" id="ud_go">Undo the delivery</button>
      <button class="btn quiet" id="ud_no">Keep it</button></div>`);

  $('#ud_no').addEventListener('click', closeDialog);
  $('#ud_go').addEventListener('click', async () => {
    const why = $('#ud_why').value.trim();
    if (!why) return notice('Say why, so the record shows it.', 'bad');
    try {
      const r = await POST(`/api/receipts/${batchId}/undo`, { why });
      closeDialog();
      notice(`Undone — ${r.units} unit(s), ${peso(r.value)} 🌸`, 'good');
      done();
    } catch (e) { whoops(e); }
  });
}

// ===========================================================================
// A whole delivery note
//
// Suppliers send a box with a list, not twenty separate errands. The list goes
// in as a list. Everything is checked before anything is booked in, and the
// server takes the lot in one transaction — so a delivery either landed or it
// did not, and there is no third state where the totals look about right.
// ===========================================================================

// Expiry dates on cosmetics are printed every which way. A bare month means
// the end of that month, which is what "EXP 08/2027" means on a box.
function parseExpiry(raw) {
  const s = String(raw || '').trim();
  if (!s) return null;
  const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun',
    'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
  const endOf = (y, m) => new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
  const pad = (y) => (y < 100 ? 2000 + y : y);
  let m;

  if ((m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s))) {
    return `${m[1]}-${String(+m[2]).padStart(2, '0')}-${String(+m[3]).padStart(2, '0')}`;
  }
  if ((m = /^(\d{4})[-/](\d{1,2})$/.exec(s))) return endOf(+m[1], +m[2]);
  if ((m = /^(\d{1,2})[-/](\d{4})$/.exec(s))) return endOf(+m[2], +m[1]);
  if ((m = /^(\d{1,2})[-/](\d{1,2})[-/](\d{2,4})$/.exec(s))) {
    return `${pad(+m[3])}-${String(+m[2]).padStart(2, '0')}-${String(+m[1]).padStart(2, '0')}`;
  }
  if ((m = /^([a-z]{3,})\s+(\d{2,4})$/i.exec(s))) {
    const i = MONTHS.indexOf(m[1].slice(0, 3).toLowerCase());
    if (i >= 0) return endOf(pad(+m[2]), i + 1);
  }
  if ((m = /^(\d{1,2})\s+([a-z]{3,})\s+(\d{2,4})$/i.exec(s))) {
    const i = MONTHS.indexOf(m[2].slice(0, 3).toLowerCase());
    if (i >= 0) {
      return `${pad(+m[3])}-${String(i + 1).padStart(2, '0')}-${String(+m[1]).padStart(2, '0')}`;
    }
  }
  return undefined;               // understood as "given, but not a date"
}

function parseDelivery(text, known) {
  const lines = [];
  const problems = [];
  const seen = new Set();
  const today = localDay();

  text.split('\n').forEach((raw, index) => {
    const s = raw.trim();
    if (!s || s.startsWith('#')) return;
    const at = `Line ${index + 1}`;

    const sep = s.includes('\t') ? '\t' : s.includes('|') ? '|' : ',';
    const f = s.split(sep).map((x) => x.trim());
    const line = {
      sku: (f[0] || '').toUpperCase(),
      batch_no: f[1] || '',
      expiry: parseExpiry(f[2]),
      qty: f[3] === '' || f[3] == null ? null : Number(f[3]),
      unit_cost: !f[4] ? null : Number(String(f[4]).replace(/[₱,\s]/g, '')),
      raw: { expiry: f[2] || '', qty: f[3] || '', cost: f[4] || '' },
    };
    line.product = known.find((p) => p.sku === line.sku);

    if (!line.sku) problems.push(`${at}: no product code.`);
    else if (!line.product) problems.push(`${at}: no product with the code ${line.sku}.`);
    else if (!line.product.active) problems.push(`${at}: ${line.product.name} is not on sale.`);

    if (!line.batch_no) problems.push(`${at}: no batch number.`);
    else {
      const key = `${line.sku}|${line.batch_no.toUpperCase()}`;
      if (seen.has(key)) problems.push(`${at}: batch ${line.batch_no} is on this note twice.`);
      seen.add(key);
    }

    if (line.expiry === null) problems.push(`${at}: no expiry date.`);
    else if (line.expiry === undefined) problems.push(`${at}: “${line.raw.expiry}” is not a date.`);
    else if (line.expiry <= today) {
      problems.push(`${at}: expires ${line.expiry}, which has already passed.`);
    }

    if (!Number.isFinite(line.qty) || line.qty <= 0 || line.qty % 1) {
      problems.push(`${at}: “${line.raw.qty}” is not a whole number of units.`);
    }
    if (line.unit_cost != null && (!Number.isFinite(line.unit_cost) || line.unit_cost < 0)) {
      problems.push(`${at}: “${line.raw.cost}” is not a cost.`);
    }

    lines.push(line);
  });

  if (!lines.length) problems.push('There are no lines on that delivery note.');
  return { lines, problems };
}

async function deliveryDialog(knownPromise, reload, branchId = null) {
  const known = await knownPromise;
  dialog(`
    <h3>Receive a whole delivery</h3>
    <div class="dim">One line per product, straight off the delivery note:
      <br><code>code | batch | expiry | how many | cost each</code>
      <br>Dates can be written <b>2027-08-31</b>, <b>08/2027</b>, <b>31/08/2027</b> or
      <b>Aug 2027</b> — a month on its own means the end of that month, the way
      it is printed on a box. Leave the cost blank to keep the cost you already
      have. Lines starting with <b>#</b> are ignored.</div>
    <div class="row mt">
      <div style="flex:0 0 auto"><label>Paid by</label>
        <select id="d_method">
          <option value="bank">Bank transfer</option>
          <option value="cash">Cash</option>
          <option value="gcash">GCash</option>
          <option value="card">Card</option>
        </select></div>
      <div style="flex:0 0 auto; align-self:flex-end">
        <button class="btn quiet sm" id="d_template">Start from your product list</button>
      </div>
    </div>
    <label class="mt" for="d_text">The delivery note</label>
    <textarea id="d_text" class="sheet" rows="12" spellcheck="false"
      placeholder="BSE-SOP-01 | A2451 | 08/2027 | 24 | 83"></textarea>
    <div id="d_preview" class="mt"></div>
    <div class="mt right">
      <button class="btn quiet" id="d_cancel">Cancel</button>
      <button class="btn" id="d_save" disabled>Book it in</button>
    </div>`, 'wide');

  const review = () => {
    const { lines, problems } = parseDelivery($('#d_text').value, known);
    const units = lines.reduce((t, l) => t + (l.qty > 0 ? l.qty : 0), 0);
    const value = lines.reduce((t, l) => t + (l.qty > 0
      ? l.qty * (l.unit_cost != null ? l.unit_cost : Number(l.product?.unit_cost || 0)) : 0), 0);

    $('#d_preview').innerHTML = problems.length
      ? `<div class="none bad"><b>${problems.length} thing${
          problems.length === 1 ? '' : 's'} to fix first</b><br>${
          problems.slice(0, 12).map(esc).join('<br>')}${problems.length > 12 ? '<br>…' : ''}</div>`
      : `<div class="dim"><b>${lines.length}</b> line${lines.length === 1 ? '' : 's'},
           <b>${count(units)}</b> units, costing <b>${peso(value)}</b> — which is recorded
           as money going out on the day you book it in.</div>
         ${table(lines, [
           { head: 'Code', cell: (l) => `<span class="dim">${esc(l.sku)}</span>` },
           { head: 'Product', cell: (l) => `<b>${esc(l.product?.name || '')}</b>` },
           { head: 'Batch', cell: (l) => esc(l.batch_no) },
           { head: 'Expires', cell: (l) => onDay(l.expiry) },
           { head: 'How many', n: true, cell: (l) => count(l.qty) },
           { head: 'Cost each', n: true, cell: (l) => (l.unit_cost == null
               ? `<span class="dim">${peso(l.product?.unit_cost || 0)}</span>`
               : peso(l.unit_cost)) },
           { head: 'Line total', n: true, cell: (l) => peso(l.qty
               * (l.unit_cost != null ? l.unit_cost : Number(l.product?.unit_cost || 0))) },
         ], '')}`;

    $('#d_save').disabled = problems.length > 0;
  };

  $('#d_text').addEventListener('input', review);
  $('#d_cancel').addEventListener('click', closeDialog);
  $('#d_template').addEventListener('click', () => {
    $('#d_text').value = ['# code | batch | expiry | how many | cost each',
      '# Delete the lines that did not arrive, then fill in batch, expiry and quantity.',
      ...known.filter((p) => p.active).map((p) => `${p.sku} | | | | `)].join('\n');
    review();
  });

  $('#d_save').addEventListener('click', async () => {
    const { lines, problems } = parseDelivery($('#d_text').value, known);
    if (problems.length) return review();
    $('#d_save').disabled = true;
    try {
      const r = await POST('/api/deliveries', {
        branch_id: branchId,
        lines: lines.map((l) => ({
          sku: l.sku, batch_no: l.batch_no, expiry: l.expiry, qty: l.qty,
          unit_cost: l.unit_cost == null ? '' : l.unit_cost,
          method: $('#d_method').value,
        })),
      });
      closeDialog();
      notice(`${r.lines} lines, ${count(r.units)} units booked in — ${peso(r.value)} 🌸`, 'good');
      reload();
    } catch (e) { whoops(e); $('#d_save').disabled = false; }
  });

  review();
}

// ===========================================================================
// Wholesale orders / picking
// ===========================================================================
SCREENS.orders = async (page) => {
  let status = '';
  const load = async () => {
    const rows = await GET(`/api/orders?status=${status}`);
    $('#board', page).innerHTML = table(rows, [
      // The number on the sheet the bench is holding, not the database's own.
      { head: 'Packing list', cell: (o) => `<b>${esc(o.pl_no || o.id)}</b>` },
      { head: 'Reseller', cell: (o) => `<b>${esc(o.reseller || '')}</b> `
          + (o.tier ? tierTag(o.tier) : '') },
      { head: 'Stage', cell: (o) => orderTag(o) },
      { head: 'Invoice', cell: (o) => {
          if (!o.invoice_id) return '—';
          if (o.invoice_status !== 'open') return tag(o.invoice_status, o.invoice_status === 'paid' ? 'green' : 'grey');
          // The warehouse is shown whether it is paid, never the amount.
          const label = o.balance == null
            ? `unpaid · due ${onDay(o.due_on)}`
            : `${peso(o.balance)} due ${onDay(o.due_on)}`;
          return tag(label, o.invoice_overdue ? 'red' : 'amber');
        } },
      { head: 'Total', n: true, cell: (o) => peso(o.total) },
      { head: 'Placed', cell: (o) => when(o.placed_at) },
      { head: '', cell: (o) => `<button class="btn sm quiet" data-open="${o.id}">Open</button>` },
    ], 'No orders here yet.');

    $$('[data-open]', page).forEach((b) => b.addEventListener('click',
      () => openOrder(b.dataset.open, load).catch(whoops)));
  };

  page.innerHTML = `
    <div class="head"><h2>${user.role === 'warehouse' ? 'Pick &amp; send' : 'Wholesale orders'}</h2>
      <span class="hint">Stock is held the moment an order is placed</span></div>
    <div class="tools"><select id="stage">
      <option value="">Every stage</option>
      <option value="placed">Committed</option>
      <option value="picking">Being picked</option>
      <option value="fulfilled">Dispatched</option>
      <option value="delivered">Delivered</option>
      <option value="cancelled">Cancelled</option>
    </select></div>
    <div class="panel" id="board"></div>`;

  $('#stage', page).addEventListener('change', (e) => { status = e.target.value; load().catch(whoops); });
  await load();
  repeat(load);
};

async function openOrder(id, reload) {
  const o = await GET(`/api/orders/${id}`);
  // Correctable while the goods are still in the building, and only then: once
  // an order is fulfilled the stock has left, and a screen cannot call it back.
  const canEdit = ['admin', 'office'].includes(user?.role)
    && o.channel === 'b2b' && ['placed', 'picking'].includes(o.status);
  // The catalogue comes along so a blank row can offer what the warehouse
  // actually holds. Fetched rather than assumed: if it does not arrive the
  // dialog still opens, still corrects what is on the order, and simply has
  // nothing to offer for adding something new.
  const catalog = canEdit ? await GET('/api/wholesale/catalog').catch(() => null) : null;
  const goods = catalog || [];
  const SPARE = canEdit && goods.length ? 3 : 0;

  // The order dialog is where both of the order's own numbers can be written.
  // The invoice carries its number on the invoice and the packing list carries
  // its number on the sheet; the customer order form is handed over once, at
  // the moment it is placed, and is never reopened — so this is the only place
  // CO can be corrected, and PL sits beside it because a series is lined back
  // up by moving both together.
  const mayNumber = ['admin', 'office'].includes(user?.role) && o.channel === 'b2b';
  dialog(`
    <h3>Order ${esc(o.co_no || o.id)} — ${esc(o.reseller || 'counter sale')}</h3>
    <div class="tags">${orderTag(o)} ${o.tier ? tierTag(o.tier) : ''}
      ${o.invoice_id ? tag(`Invoice ${o.invoice_status} · due ${onDay(o.due_on)}`,
          o.invoice_status === 'paid' ? 'green' : 'amber') : ''}</div>
    ${mayNumber ? `
      <div class="panel">
        <h3>The numbers on the paperwork</h3>
        <div class="dim">Handed out in order as each order is taken. Written
          here when they have to match something this system did not print — a
          number already quoted in a chat, or a gap left by an order that was
          cancelled. What is written becomes the one the next order counts on
          from.</div>
        <div class="row">
          <div><label for="on_co">Customer order no.</label>
            <input id="on_co" type="text" autocomplete="off"
              value="${esc(o.co_no || '')}"></div>
          <div><label for="on_pl">Packing list no.</label>
            <input id="on_pl" type="text" autocomplete="off"
              value="${esc(o.pl_no || '')}"></div>
          <div style="flex:0 0 auto;align-self:flex-end">
            <button class="btn sm" id="on_keep">Save the numbers</button></div>
        </div>
      </div>` : ''}
    <h3>Pick in this order</h3>
    <div class="dim">Soonest to expire first — that is what leaves the building.${canEdit
      ? ` Every box on this table can be typed in. Change the product, how
          many, or what it costs, and the stock, the packing list and the
          invoice all move with it. Emptying a quantity takes that product off
          the order; a product swapped or added takes its batch the same way,
          soonest to expire first, and arrives on its standing price.`
      : ''}</div>
    <div id="ol_box">
    ${o.lines.length || SPARE ? `
      <div class="scroll"><table>
        <thead><tr>
          <th>Product</th><th>Batch</th><th>Expires</th>
          <th class="n">Qty</th><th class="n">Price</th><th class="n">Total</th>
        </tr></thead>
        <tbody>
          ${o.lines.map((l) => `<tr>
            <td>${canEdit && goods.length
              ? `<input class="cellbox open" list="doc_goods" data-swap="${esc(String(l.id))}"
                   data-was="${esc(l.sku)}" data-wasname="${esc(l.name)}"
                   autocomplete="off" title="${esc(l.name)}" value="${esc(l.name)}">`
              : esc(l.name)}</td>
            <td><b>${esc(l.batch_no)}</b></td>
            <td>${onDay(l.expiry)}</td>
            <td class="n">${canEdit
              ? `<input class="cellbox open n" inputmode="numeric" data-sku="${esc(l.sku)}"
                   data-qtyfor="${esc(String(l.id))}" value="${Number(l.qty)}">`
              : count(l.qty)}</td>
            <td class="n">${canEdit
              ? `<input class="cellbox open n" inputmode="decimal" data-line="${esc(String(l.id))}"
                   value="${Number(l.unit_price).toFixed(2)}">`
              : peso(l.unit_price)}</td>
            <td class="n" data-linetotal="${esc(String(l.id))}">${peso(l.unit_price * l.qty)}</td>
          </tr>`).join('')}
          ${Array.from({ length: SPARE }, (_x, i) => `<tr>
            <td><input class="cellbox open" list="doc_goods" data-add="${i}"
                  autocomplete="off" placeholder="Add a product"></td>
            <td></td>
            <td></td>
            <td class="n"><input class="cellbox open n" data-addqty="${i}"
                  inputmode="numeric" disabled></td>
            <td class="n" data-addprice="${i}"></td>
            <td class="n" data-addtotal="${i}"></td>
          </tr>`).join('')}
        </tbody>
      </table></div>${goodsList(goods)}`
      : '<div class="none">No lines on this order.</div>'}
    </div>
    <div class="right mt"><b>Total <span id="ol_total">${peso(o.total)}</span></b></div>
    ${canEdit ? `<div class="right"><span class="dim" id="ol_state"></span>
      <button class="btn sm" id="ol_keep">Save the products</button></div>` : ''}
    <div class="mt right">
      <button class="btn quiet" id="a_packing">🖨 Packing list</button>
      ${o.status === 'placed' ? '<button class="btn" id="a_pick">Start picking</button>' : ''}
      ${['placed', 'picking'].includes(o.status) ? `
        <button class="btn go" id="a_send">Dispatch</button>
        <button class="btn stop" id="a_cancel">Cancel</button>` : ''}
      ${o.status === 'fulfilled' && !o.delivered_at
        ? '<button class="btn go" id="a_delivered">Mark delivered</button>' : ''}
    </div>`, 'wide');

  const act = (sel, path) => $(sel)?.addEventListener('click', async () => {
    try {
      const r = await POST(`/api/orders/${id}/${path}`);
      notice(r.message || 'Done', 'good');
      closeDialog();
      reload();
    } catch (e) { whoops(e); }
  });
  $('#on_keep')?.addEventListener('click', async () => {
    const button = $('#on_keep');
    const co = $('#on_co').value.trim().toUpperCase();
    const pl = $('#on_pl').value.trim().toUpperCase();
    if (co === (o.co_no || '') && pl === (o.pl_no || '')) {
      return notice('Those are the numbers it already has.', 'good');
    }
    button.disabled = true;
    try {
      const out = await POST(`/api/orders/${id}/numbers`,
        { co_no: co || null, pl_no: pl || null });
      notice(`This order is ${out.co_no}, its packing list ${out.pl_no} 🌸`, 'good');
      closeDialog();
      reload();
    } catch (e) { whoops(e); button.disabled = false; }
  });

  // The lines themselves. Same two calls the invoice makes and in the same
  // order — prices before quantities, because both are judged against what has
  // already been settled and the usual correction is a price going up while a
  // quantity comes down.
  if (canEdit) {
    const box = $('#ol_box');
    const each = sheetBoxes(box, goods, () => retotal());
    const money = (el) => {
      const n = Number(String(el?.value ?? '').replace(/[^0-9.]/g, ''));
      return Number.isFinite(n) && n >= 0 ? n : 0;
    };
    const asPlaced = [...o.lines.reduce((by, l) =>
      by.set(l.sku, (by.get(l.sku) || 0) + Number(l.qty)), new Map())]
      .map(([sku, qty]) => ({ sku, qty }));
    const paid = Number(o.total || 0) - Number(o.balance ?? o.total ?? 0);

    function retotal() {
      let running = 0;
      for (const price of $$('[data-line]', box)) {
        const qty = wholeUnits($(`[data-qtyfor="${price.dataset.line}"]`, box));
        const line = money(price) * qty;
        running += line;
        const cell = $(`[data-linetotal="${price.dataset.line}"]`, box);
        if (cell) cell.textContent = peso(line);
      }
      // Something added here has no price of its own until it is saved: it
      // takes the standing wholesale price, and the office corrects it after
      // like any other line. Showing that now keeps the total honest.
      each.added().forEach((g, i) => {
        const line = Number(g.wholesale_price || 0) * g.qty;
        running += line;
        const price = $(`[data-addprice="${i}"]`, box);
        const total = $(`[data-addtotal="${i}"]`, box);
        if (price) price.textContent = peso(g.wholesale_price || 0);
        if (total) total.textContent = peso(line);
      });
      const whole = running + Number(o.shipping || 0) + Number(o.others || 0);
      $('#ol_total').textContent = peso(whole);
      const empty = !each.picture().some((l) => l.qty > 0);
      const short = paid > 0 && whole < paid;
      $('#ol_state').innerHTML = empty
        ? `<span class="over">An order with nothing on it is a cancellation —
           use Cancel if that is what this is</span>`
        : short
          ? `<span class="over">${peso(paid)} has already been settled against
             this order — it cannot come to less</span>` : '';
      $('#ol_keep').disabled = empty || short;
    }
    $$('[data-line]', box).forEach((el) => {
      el.addEventListener('input', retotal);
      el.addEventListener('change', () => { el.value = money(el).toFixed(2); retotal(); });
    });
    retotal();

    $('#ol_keep').addEventListener('click', async () => {
      const button = $('#ol_keep');
      button.disabled = true;
      try {
        await POST(`/api/orders/${id}/invoice`, {
          // A line whose product was swapped is about to be replaced, so its
          // price box is showing the new product's standing figure rather than
          // anything anybody agreed to. Sending it would price the old line a
          // moment before it is deleted.
          lines: $$('[data-line]', box)
            .filter((el) => !el.dataset.swapped)
            .map((el) => ({ id: el.dataset.line, price: money(el) })),
        });
        const now = each.picture().filter((l) => l.qty > 0);
        const moved = now.length !== asPlaced.length || now.some(({ sku, qty }) =>
          qty !== asPlaced.find((l) => l.sku === sku)?.qty);
        const out = moved
          ? await POST(`/api/orders/${id}/lines`, { lines: now })
          : { total: null };
        notice(`This order now comes to ${
          out.total == null ? $('#ol_total').textContent : peso(out.total)} 🌸`, 'good');
        closeDialog();
        reload();
      } catch (e) { whoops(e); button.disabled = false; }
    });
  }

  act('#a_pick', 'picking');
  act('#a_send', 'dispatch');
  act('#a_cancel', 'cancel');
  act('#a_delivered', 'deliver');

  // Opened over the order rather than replacing it: the picking view above
  // carries batch and expiry, which is what the picker works from, and the
  // packing list is what travels with the box.
  $('#a_packing')?.addEventListener('click', () => {
    showPackingList({
      orderId: o.id, packingNo: o.pl_no,
      resellerName: o.reseller, placedAt: o.placed_at, who: o,
      canEdit, catalog, resellerId: o.reseller_id,
      onSaved: reload,
      // The board names the column unit_type; the document asks for unit.
      lines: o.lines.map((l) => ({ ...l, unit: l.unit_type })),
    });
  });
}

// ---------------------------------------------------------------------------
// A document as a file, rather than a screenshot of a screen
//
// These sheets are sent to a reseller over Messenger. Print-to-PDF meant
// somebody screenshotting their own browser, which is why the whole thing had
// to be made to fit one screen. This hands them the picture directly, drawn at
// twice the screen's resolution so the small print survives being read on a
// phone.
//
// Drawn by putting the document inside an SVG foreignObject and rasterising
// that: the browser's own layout engine, no library. Everything the document
// needs has to travel inside that SVG — the stylesheet inlined, the logo as a
// data URI, and :root rewritten to the wrapper, because inside the SVG the
// wrapper IS the root and every colour in the house style is declared there.
// Anything still pointing outside taints the canvas, and a tainted canvas
// cannot be saved at all.
// ---------------------------------------------------------------------------
let sheetCss = null;    // fetched once; it does not change while signed in
let logoData = null;

const asDataUri = async (url) => {
  const blob = await (await fetch(url)).blob();
  return new Promise((done, fail) => {
    const r = new FileReader();
    r.onload = () => done(r.result);
    r.onerror = fail;
    r.readAsDataURL(blob);
  });
};

async function saveDocument(node, filename, scale = 2) {
  if (!node) throw new Error('There is no document open to save.');
  sheetCss ??= await (await fetch('/styles.css')).text();
  logoData ??= await asDataUri('/logo.png');

  const width = Math.ceil(node.getBoundingClientRect().width);
  const clone = node.cloneNode(true);
  clone.querySelectorAll('img').forEach((img) => { img.setAttribute('src', logoData); });

  const shot = document.createElement('div');
  shot.id = 'shot';
  // The brand decides the palette, and the palette lives on :root.
  if (document.documentElement.dataset.brand) {
    shot.dataset.brand = document.documentElement.dataset.brand;
  }
  shot.setAttribute('style',
    `width:${width}px;background:#fff;padding:18px;box-sizing:border-box;` +
    'font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;font-size:15px');
  shot.append(clone);

  // Measured on the page, because a foreignObject does not report its own
  // height back and an SVG cut short simply loses the bottom of the sheet.
  document.body.append(shot);
  const height = Math.ceil(shot.getBoundingClientRect().height);
  const body = new XMLSerializer().serializeToString(shot);
  shot.remove();

  const css = sheetCss.replace(/:root/g, '#shot')
                      .replace(/&/g, '&amp;').replace(/</g, '&lt;');
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">` +
    `<foreignObject x="0" y="0" width="${width}" height="${height}">` +
    `<div xmlns="http://www.w3.org/1999/xhtml"><style>${css}</style>${body}</div>` +
    '</foreignObject></svg>';

  const img = new Image();
  await new Promise((done, fail) => {
    img.onload = done;
    img.onerror = () => fail(new Error('The document could not be drawn.'));
    img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
  });

  const canvas = document.createElement('canvas');
  canvas.width = width * scale;
  canvas.height = height * scale;
  const ctx = canvas.getContext('2d');
  // JPEG has no transparency; without this the sheet comes out on black.
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);

  const blob = await new Promise((done) => canvas.toBlob(done, 'image/jpeg', 0.92));
  if (!blob) throw new Error('The document could not be saved.');
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

// The button that does it, with the wait shown on the button itself — a big
// sheet takes a moment and a button that looks idle gets pressed twice.
const wireSave = (btnId, selector, filename) => {
  const b = $(btnId);
  if (!b) return;
  b.addEventListener('click', async () => {
    const was = b.textContent;
    b.disabled = true;
    b.textContent = 'Saving…';
    try {
      await saveDocument($(selector, $('#dialog')), filename);
      notice(`Saved as ${filename} 🌸`, 'good');
    } catch (e) { whoops(e); } finally {
      b.disabled = false;
      b.textContent = was;
    }
  });
};

// The letterhead every one of these documents carries.
const DOC_HEAD = `
  <div class="rule"></div>
  <div class="head-row">
    <img src="/logo.png" alt="MS Beau Ave">
    <div class="who">
      <b>MS BEAU AVE ENTERPRISES OPC</b>
      <div>LOT 16-A BLK 2 MS BEAU AVE BAYAN BAYANAN AVE.<br>
      MARIKINA HEIGHTS CITY OF MARIKINA NCR, SECOND DISTRICT 1810</div>
    </div>
    <span></span>
  </div>`;

// Where the money is to be sent. On the paper it sits on both the order form
// and the invoice, because a reseller reading either one is a reseller about
// to pay.
const BANK_DETAILS = `
  <div class="bank">
    <h5>BANK ACCOUNT DETAILS:</h5>
    <div class="b">BDO</div>
    <div>Account Name: MS Beau Ave Enterprises OPC</div>
    <div>Account Number: 010-338-012-751</div>
    <div class="b">BPI</div>
    <div>Account Name: MS Beau Ave Enterprises OPC</div>
    <div>Account Number: 317-378-3972</div>
    <div class="b">SECURITY BANK</div>
    <div>Account Name: MS Beau Ave Enterprises OPC</div>
    <div>Account Number: 000-006-567-3032</div>
  </div>`;

const TAX_LINES = [
  ['Tax Type', 'tax_type'], ['Business Trade Name', 'trade_name'],
  ['Taxpayer Name', 'taxpayer_name'], ['TIN Number', 'tin'],
  ['Business Address', 'business_address'],
];

// ---------------------------------------------------------------------------
// The boxes a document grows once it can be corrected
//
// A packing list and an invoice are the same order seen from two sides, so
// they answer the same question — how many of what is going out — and they
// have to answer it the same way. The markup differs because the tables do;
// the reading of it is here, once, so the two sheets cannot disagree.
// ---------------------------------------------------------------------------

// A quantity box holds whole units. Anything else typed into it is nothing,
// and nothing is a line that is not going — which is a thing somebody may well
// mean, so it is allowed rather than corrected back.
const wholeUnits = (el) => {
  const n = Math.trunc(Number(String(el?.value ?? '').replace(/[^0-9]/g, '')));
  return Number.isFinite(n) && n > 0 ? n : 0;
};

/**
 * Wires the quantity boxes and the blank-row pickers inside one document, and
 * hands back a reading of what the sheet currently says.
 *
 * `goods` is the wholesale catalogue, so a blank row can only offer what the
 * warehouse actually holds. Each row of the sheet is its own box, and a product
 * picked from two deliveries has two rows: summing them is what the sheet
 * means — this many of that product go out, however they were held.
 */
function sheetBoxes(root, goods = [], onChange = null) {
  const byName = new Map(goods.map((g) => [g.name, g]));
  const bySku = new Map(goods.map((g) => [g.sku, g]));
  // The picker resolves what was typed to a real product before the row counts
  // for anything: by name, as the list offers it, or by code for whoever knows
  // the code and types it straight in.
  const found = (el) => {
    const said = (el?.value || '').trim();
    return said ? byName.get(said) || bySku.get(said.toUpperCase()) || null : null;
  };

  $$('[data-add]', root).forEach((box) => {
    box.addEventListener('change', () => {
      const g = found(box);
      const i = box.dataset.add;
      const qty = $(`[data-addqty="${i}"]`, root);
      // Not every sheet has a unit column to fill — the order dialog names the
      // batch where a document names the unit — so this asks rather than
      // assumes. A missing cell is a document that does not print that fact,
      // not a mistake.
      const unit = $(`[data-addunit="${i}"]`, root);
      box.classList.toggle('named', !!g);
      if (qty) qty.disabled = !g;
      if (unit) unit.textContent = g?.unit_type || '';
      if (g) {
        box.value = g.name;
        if (qty && !wholeUnits(qty)) qty.value = '1';
        qty?.focus();
        qty?.select();
      } else if (qty) { qty.value = ''; }
      onChange?.();
    });
  });
  // A line whose product is wrong is not a line to empty and retype somewhere
  // else. Picking a different product on the row moves the quantity to it, and
  // the whole picture then reads as that product going out and the old one not
  // — which is exactly what a swap is.
  $$('[data-swap]', root).forEach((box) => {
    box.addEventListener('change', () => {
      const g = found(box);
      const qty = $(`[data-qtyfor="${box.dataset.swap}"]`, root);
      const price = $(`[data-line="${box.dataset.swap}"]`, root);
      // Not a product the warehouse holds, so the row goes back to what it was
      // rather than sitting there naming something that cannot be picked.
      if (!g) {
        box.value = box.dataset.wasname;
        if (qty) qty.dataset.sku = box.dataset.was;
        if (price) delete price.dataset.swapped;
      } else {
        box.value = g.name;
        if (qty) qty.dataset.sku = g.sku;
        // The typed price belonged to the line that is about to be replaced,
        // so it cannot follow. The new product arrives on its standing price,
        // and the office corrects it after — the same as a row added below.
        if (price && g.sku !== box.dataset.was) {
          price.value = Number(g.wholesale_price || 0).toFixed(2);
          price.dataset.swapped = '1';
        } else if (price) { delete price.dataset.swapped; }
      }
      box.classList.toggle('named', !!g && g.sku !== box.dataset.was);
      onChange?.();
    });
  });
  if (onChange) {
    $$('[data-sku], [data-addqty]', root)
      .forEach((el) => el.addEventListener('input', onChange));
  }

  return {
    added: () => $$('[data-add]', root).map((box) => {
      const g = found(box);
      const qty = wholeUnits($(`[data-addqty="${box.dataset.add}"]`, root));
      return g && qty ? { ...g, qty } : null;
    }).filter(Boolean),
    // What goes out when this sheet is signed, by product — the shape
    // revise_order reads, which is the whole picture rather than a list of
    // changes: a product left off the sheet is a product that is not going.
    picture() {
      const by = new Map();
      const put = (sku, qty) => by.set(sku, (by.get(sku) || 0) + qty);
      $$('[data-sku]', root).forEach((el) => put(el.dataset.sku, wholeUnits(el)));
      this.added().forEach((g) => put(g.sku, g.qty));
      return [...by].map(([sku, qty]) => ({ sku, qty }));
    },
  };
}

// The catalogue a blank row offers, as a list the browser fills in from.
const goodsList = (goods) => (goods.length ? `<datalist id="doc_goods">${goods.map((g) => `
  <option value="${esc(g.name)}" label="${esc(g.sku)} · ${count(g.available)} on hand">
  </option>`).join('')}</datalist>` : '');

// Every one of these sheets is a piece of paper somebody sends or files, so
// every one of them offers both ways off the screen: a picture for the chat
// window, and the printer for the folder. The button is hidden on the paper
// itself by the print stylesheet, along with the rest of the screen.
const PRINT_BTN = '<button class="btn quiet" onclick="window.print()">🖨 Print</button>';

const docParty = (name, dateOn, orderNo, who = {}, numberLabel = 'SALES ORDER NO.',
                  typed = false, numberTyped = false) => `
  <div class="party" style="display:flex;justify-content:space-between;gap:20px;margin-bottom:6px;line-height:1.3">
    <div>
      <div style="font-weight:700;font-size:1.02rem">${esc(name || 'counter sale')}${
        // Beside the name, the way it has been written on these forms by hand
        // for years: DS, then whoever the order is being sent on to.
        who?.drop_ship ? `<span style="font-weight:400;font-size:.72rem;margin-left:14px">
          <b>DS:</b> ${esc(who.drop_ship)}</span>` : ''}</div>
      ${TAX_LINES.map(([label, key]) => `
        <div style="font-size:.68rem"><b>${label}:</b>
          ${typed
            ? `<input class="figure wide party" data-tax="${key}"
                 value="${esc(who?.[key] || '')}">`
            : esc(who?.[key] || '')}</div>`).join('')}
    </div>
    <div style="white-space:nowrap;font-size:.7rem">
      <div><b>DATE:</b> ${onDay(dateOn)}</div>
      <div><b>${numberLabel}</b> ${numberTyped
        ? `<input class="figure wide docno" data-docno autocomplete="off"
             value="${esc(String(orderNo))}">`
        : esc(String(orderNo))}</div>
    </div>
  </div>`;

// `typed` turns the UNIT PRICE column into something somebody can correct.
//
// The price on a sheet is right most of the time and wrong some of the time —
// a figure agreed in a chat window and not in the price list, a discount the
// owner gave on the phone. Correcting it used to mean cancelling the order,
// which puts the stock back on sale and loses the number the reseller already
// has in front of them.
//
// The box is styled to look like the number it replaces rather than like a
// form field, so a sheet that is printed or saved as a picture reads as a
// document either way.
// `typed` opens the money boxes and `qtyToo` the quantity ones. Two flags
// rather than one because they close at different moments: a price stays
// correctable for as long as the invoice exists, and a quantity stops the
// moment the goods leave the building.
const docLines = (lines, blanks = 5, typed = false, goods = null, qtyToo = false) => {
  const spare = Math.max(0, blanks - lines.length);
  // Somewhere to write what the order did not have on it. Only where there is
  // a catalogue to pick from: a free-text row would be a product nobody can
  // hold stock against.
  const pickable = qtyToo && goods && goods.length ? Math.min(spare, 4) : 0;
  return `
  <table class="lines">
    <thead><tr>
      <th style="width:88px">PCODE</th><th>PRODUCT DESCRIPTION</th>
      <th style="width:70px">QUANTITY</th><th style="width:70px">UNIT TYPE</th>
      <th style="width:80px">UNIT PRICE</th><th style="width:88px">TOTAL</th>
    </tr></thead>
    <tbody>
      ${lines.map((l) => `<tr>
        <td class="c">${esc(l.code || '')}</td>
        <td><b>${esc(l.name)}</b></td>
        <td class="c">${qtyToo && l.id
          ? `<input class="figure mid" inputmode="numeric" data-sku="${esc(l.sku || '')}"
               data-qtyfor="${esc(String(l.id))}" value="${Number(l.qty)}">`
          : count(l.qty)}</td>
        <td class="c">${esc(l.unit || '')}</td>
        <td class="n">${typed && l.id
          ? `<input class="figure" inputmode="decimal" data-line="${esc(String(l.id))}"
               data-qty="${Number(l.qty)}" value="${peso(l.price).replace('₱', '')}">`
          : peso(l.price)}</td>
        <td class="n" data-linetotal="${esc(String(l.id ?? ''))}">${peso(l.price * l.qty)}</td>
      </tr>`).join('')}
      ${Array.from({ length: pickable }, (_x, i) => `<tr>
        <td class="c"></td>
        <td><input class="figure wide" list="doc_goods" data-add="${i}"
              autocomplete="off" placeholder="Add a product"></td>
        <td class="c"><input class="figure mid" data-addqty="${i}"
              inputmode="numeric" disabled></td>
        <td class="c" data-addunit="${i}"></td>
        <td class="n" data-addprice="${i}"></td>
        <td class="n" data-addtotal="${i}"></td>
      </tr>`).join('')}
      ${Array.from({ length: spare - pickable },
        () => '<tr><td>&nbsp;</td><td></td><td></td><td></td><td></td><td></td></tr>').join('')}
    </tbody>
  </table>`;
};

/**
 * The CUSTOMER ORDER FORM: what a reseller is sent to agree to, before money.
 * Prices, the totals, where to pay, and the two reminders the paper carries.
 */
function customerOrderForm({ orderId, issuedOn, amount, resellerName, lines,
                            who = {}, shipping = 0, others = 0, orderNo = null,
                            canEdit = false }) {
  const sub = lines.reduce((s, l) => s + l.price * l.qty, 0);
  return `
    <div class="doc cof">
      ${DOC_HEAD}
      <div class="title cof">CUSTOMER ORDER FORM</div>
      ${docParty(resellerName, issuedOn, orderNo || orderId, who,
                 orderNo ? 'CUSTOMER ORDER NO.' : 'SALES ORDER NO.', false,
                 // Only on a form for an order that exists. The basket preview
                 // draws this same sheet before anything has been placed, and
                 // there is no number there yet to correct.
                 canEdit && !!orderNo)}
      <div class="duebox">Total Due (PHP)<b>${peso(amount ?? sub)}</b></div>
      <div style="clear:both"></div>
      ${docLines(lines)}
      <div class="foot">
        <div style="font-size:.68rem">
          <b>Reminders:</b>
          <div>1. Please settle payment before delivery date.</div>
          <div>2. Please settle payment to any bank accounts indicated below.</div>
          ${BANK_DETAILS}
        </div>
        <div class="totals">
          <div><span>Subtotal:</span><span>${peso(sub)}</span></div>
          <div><span>Shipping/Delivery Fee:</span><span>${peso(shipping)}</span></div>
          <div><span>Others:</span><span>${peso(others)}</span></div>
          <div class="grand"><span>Grand Total:</span><span>${peso(sub + shipping + others)}</span></div>
        </div>
      </div>
      <div class="sign1">
        <div class="nm">${esc(user?.name || user?.username || '')}</div>
        <div>Order Management Coordinator</div>
        <div class="cap">PREPARED BY:</div>
      </div>
    </div>`;
}

// The same sheet, opened over the screen with the buttons that send it.
/**
 * The order form as it is handed over — and the one moment to correct the
 * number on it.
 *
 * This sheet is shown once, straight after the order is placed, and goes into
 * the chat window from here. So the number it carries is the number the
 * reseller will hold, and if it has to match something already quoted to them
 * it has to be changed now, before the picture is sent, rather than on a
 * screen they will never see.
 */
function showInvoice(opts, over = false) {
  const canEdit = opts.canEdit && !!opts.orderNo && !!opts.orderId;
  dialog(`${customerOrderForm(opts)}
    <div class="mt right">
      ${canEdit ? '<span class="dim" id="inv_state"></span>' : ''}
      <button class="btn quiet" id="inv_save">⬇ Download JPEG</button>
      ${PRINT_BTN}
      ${canEdit ? '<button class="btn" id="inv_keep">Save the number</button>' : ''}
      <button class="btn ${canEdit ? 'quiet' : ''}" id="inv_done">Done</button></div>`,
    'wide', over);
  wireSave('#inv_save', '.doc', `${opts.orderNo || opts.orderId}.jpg`);
  $('#inv_done').addEventListener('click', closeDialog);
  if (!canEdit) return;

  const box = $('.doc [data-docno]');
  const keep = $('#inv_keep');
  const said = () => box.value.trim().toUpperCase();
  const restate = () => {
    const empty = !said();
    $('#inv_state').innerHTML = empty
      ? `<span class="over">A form with no number on it is a form nobody can
         quote back at you</span>` : '';
    keep.disabled = empty || said() === opts.orderNo;
  };
  box.addEventListener('input', restate);
  restate();

  // Saved without closing. The sheet is about to be downloaded and sent, so
  // what somebody wants next is to see the corrected number on it, not to
  // find their way back to a document they have just been put back in front of.
  keep.addEventListener('click', async () => {
    keep.disabled = true;
    try {
      const out = await POST(`/api/orders/${opts.orderId}/numbers`, { co_no: said() });
      opts.orderNo = out.co_no;
      box.value = out.co_no;
      notice(`This order is ${out.co_no} 🌸`, 'good');
      opts.onSaved?.(out.co_no);
    } catch (e) { whoops(e); }
    restate();
  });
}

/**
 * The INVOICE: the order form plus the money side of it.
 *
 * PAYMENT DETAILS is filled from the ledger rather than left blank — what the
 * account has already sent, with the receipt number to quote against each. A
 * payment recorded before ORs existed has no number, and prints blank rather
 * than borrowing one that means something else. Empty slots follow, because
 * the paper has five and a payment made after this printed goes in by hand.
 */
function showInvoiceDoc({ orderId, issuedOn, resellerName, lines, payments = [],
                          who = {}, shipping = 0, others = 0, over = false,
                          invoiceNo = null, canEdit = false, onSaved = null,
                          catalog = null, resellerId = null, status = null }) {
  // Correctable while the goods are still in the building. A price can be
  // fixed on a sheet at any time — nothing physical follows it — but a
  // quantity moves stock, and stock that has left cannot be called back by a
  // document. So the money boxes and the quantity boxes have different
  // lifetimes, and only the quantity ones close.
  const canPick = canEdit && ['placed', 'picking'].includes(status);
  const goods = canPick && catalog ? catalog : [];
  const sub = lines.reduce((s, l) => s + l.price * l.qty, 0);
  const grand = sub + shipping + others;
  const paid = payments.reduce((s, p) => s + Number(p.amount), 0);
  // MOP is the bank the money came through, Details the account it landed in,
  // and the reference is the bank's own — the number a reseller quotes to say
  // it left them. Anything not recorded prints blank rather than guessed at.
  const slot = (p) => `
    <div class="slot">
      <b>MOP${p && p.method ? ` &nbsp;&nbsp;&nbsp; ${esc(p.method)}` : ''}</b>
      <div>Details: ${p ? esc(p.payer_details || '') : ''}</div>
      <div>Reference no.: ${p ? esc(p.reference_no || '') : ''}</div>
      <div>Date: ${p ? onDay(p.paid_on) : ''}</div>
      <div>Amount: ${p ? peso(p.amount) : ''}</div>
    </div>`;
  // Five, as the paper pad has, because a reseller may settle in instalments
  // and the sheet has to have somewhere to record each one. They were cut to
  // three when the document ran to two pages; everything else about the sheet
  // has tightened since, so the five fit and the five stay.
  const slots = [...payments.slice(0, 5).map(slot),
                 ...Array.from({ length: Math.max(0, 5 - payments.length) }, () => slot(null))];
  dialog(`
    <div class="doc inv">
      ${DOC_HEAD}
      <div class="title inv">INVOICE</div>
      ${docParty(resellerName, issuedOn, invoiceNo || orderId, who,
                 invoiceNo ? 'INVOICE NO.' : 'SALES ORDER NO.',
                 canEdit && !!resellerId,
                 // Only where there is an invoice to renumber. Before one is
                 // raised the line shows the sales order, which is the
                 // order's own number and not this sheet's to change.
                 canEdit && !!invoiceNo)}
      <div class="duebox">Total Due (PHP)<b>${peso(grand - paid)}</b></div>
      <div style="clear:both"></div>
      ${docLines(lines, 5, canEdit, goods, canPick)}
      ${goodsList(goods)}
      <div class="foot">
        <div class="mop">
          <div class="hd">PAYMENT DETAILS${payments.length ? '' : ' — TO FOLLOW PAYMENT'}</div>
          ${slots.join('')}
        </div>
        <div>
          <div class="totals">
            <div><span>Subtotal:</span><span id="iv_sub">${peso(sub)}</span></div>
            <div><span>Shipping/Delivery Fee:</span><span>${canEdit
              ? `<input class="figure" id="iv_ship" inputmode="decimal"
                   value="${peso(shipping).replace('₱', '')}">`
              : peso(shipping)}</span></div>
            <div><span>Others:</span><span>${canEdit
              ? `<input class="figure" id="iv_oth" inputmode="decimal"
                   value="${peso(others).replace('₱', '')}">`
              : peso(others)}</span></div>
            <div class="grand"><span>Grand Total:</span><span id="iv_grand">${peso(grand)}</span></div>
            <div class="bal"><span>Balance:</span><span id="iv_bal">${peso(grand - paid)}</span></div>
          </div>
          ${BANK_DETAILS}
        </div>
      </div>
      <div class="sign1">
        <div class="nm">${esc(user?.name || user?.username || '')}</div>
        <div>Order Management Coordinator</div>
        <div class="cap">PREPARED BY:</div>
      </div>
    </div>
    <div class="mt right">
      ${canEdit ? '<span class="dim" id="iv_state"></span>' : ''}
      <button class="btn quiet" id="ivd_save">⬇ Download JPEG</button>
      ${PRINT_BTN}
      ${canEdit ? '<button class="btn" id="iv_keep">Save the changes</button>' : ''}
      <button class="btn ${canEdit ? 'quiet' : ''}" id="ivd_done">Done</button></div>`,
    'wide', over);
  wireSave('#ivd_save', '.doc', `${invoiceNo || orderId} INVOICE.jpg`);
  $('#ivd_done').addEventListener('click', closeDialog);

  if (!canEdit) return;

  // A number typed with the commas it was shown with is still a number.
  const read = (el) => {
    const n = Number(String(el?.value ?? '').replace(/[^0-9.]/g, ''));
    return Number.isFinite(n) && n >= 0 ? n : 0;
  };
  const boxes = () => $$('[data-line]');
  const sheet = $('.doc.inv');
  const each = sheetBoxes(sheet, goods, () => retotal());
  // How many of a line are going, which is the box if there is one and what
  // was picked if there is not.
  const going = (box) => {
    const typedQty = $(`[data-qtyfor="${box.dataset.line}"]`, sheet);
    return typedQty ? wholeUnits(typedQty) : Number(box.dataset.qty || 0);
  };
  // What was picked, by product — the same shape the sheet reads back, so
  // "did anything move?" is one comparison rather than two. A product held on
  // two batches is two lines and one entry here, as it is on the sheet.
  const asPlaced = [...lines.reduce((by, l) =>
    by.set(l.sku, (by.get(l.sku) || 0) + Number(l.qty)), new Map())]
    .map(([sku, qty]) => ({ sku, qty }));
  const moved = () => {
    const now = each.picture().filter((l) => l.qty > 0);
    return now.length !== asPlaced.length || now.some(({ sku, qty }) =>
      qty !== asPlaced.find((l) => l.sku === sku)?.qty);
  };

  // The totals follow the typing rather than waiting for a save, because the
  // figure somebody is checking is the Grand Total, not the line they are in.
  const retotal = () => {
    let running = 0;
    for (const box of boxes()) {
      const line = read(box) * going(box);
      running += line;
      const cell = $(`[data-linetotal="${box.dataset.line}"]`, sheet);
      if (cell) cell.textContent = peso(line);
    }
    // A row added here has no price of its own yet — it takes the standing
    // wholesale price when it is saved, and the office corrects it after, the
    // same as any other line. Showing that figure now keeps the Grand Total
    // honest about what is being agreed to.
    each.added().forEach((g, i) => {
      const line = Number(g.wholesale_price || 0) * g.qty;
      running += line;
      const price = $(`[data-addprice="${i}"]`, sheet);
      const total = $(`[data-addtotal="${i}"]`, sheet);
      if (price) price.textContent = peso(g.wholesale_price || 0);
      if (total) total.textContent = peso(line);
    });
    const ship = read($('#iv_ship'));
    const oth = read($('#iv_oth'));
    const whole = running + ship + oth;
    $('#iv_sub').textContent = peso(running);
    $('#iv_grand').textContent = peso(whole);
    $('#iv_bal').textContent = peso(whole - paid);
    $('.duebox b').textContent = peso(whole - paid);
    // Money already taken is the floor, and an invoice with nothing on it is a
    // cancellation. Saying either while they type beats a refusal after they
    // press the button.
    const short = whole < paid;
    const empty = canPick && !each.picture().some((l) => l.qty > 0);
    $('#iv_state').innerHTML = short
      ? `<span class="over">${peso(paid)} has already been settled against this
         invoice — it cannot come to less</span>`
      : empty
        ? `<span class="over">An invoice with nothing on it is a cancellation —
           cancel the order itself if that is what this is</span>` : '';
    $('#iv_keep').disabled = short || empty;
  };

  $$('[data-line], #iv_ship, #iv_oth').forEach((el) => {
    el.addEventListener('input', retotal);
    // Tidied to the shape the rest of the sheet is in once they leave it.
    el.addEventListener('change', () => { el.value = peso(read(el)).replace('₱', ''); retotal(); });
  });
  retotal();

  $('#iv_keep').addEventListener('click', async () => {
    const button = $('#iv_keep');
    button.disabled = true;
    try {
      // Three things can have changed, and they are saved in the order that
      // makes the refusals land in the right place.
      //
      // The tax block first: it belongs to the account rather than to this
      // order, so it is worth keeping even if the figures are then refused,
      // and it is what every later sheet of theirs prints.
      const tax = {};
      $$('[data-tax]', sheet).forEach((el) => { tax[el.dataset.tax] = el.value.trim(); });
      if (Object.keys(tax).length
          && TAX_LINES.some(([, k]) => (tax[k] || '') !== (who?.[k] || ''))) {
        await POST(`/api/resellers/${resellerId}/tax`, tax);
      }

      // Then the number on the sheet. It is a label rather than a figure —
      // nothing recalculates behind it — so it goes with the tax block,
      // before anything that can be refused for the money it comes to.
      const typedNo = $('[data-docno]', sheet)?.value.trim().toUpperCase();
      if (typedNo && typedNo !== (invoiceNo || '')) {
        await POST(`/api/orders/${orderId}/invoice-no`, { si_no: typedNo });
      }

      // Prices before quantities. Both are judged against what has already
      // been settled, and the common correction is a price going up while a
      // quantity comes down — judged in that order the invoice clears the
      // floor, judged the other way round it would be refused halfway.
      // Quantities also keep whatever price the line is on, so the figure
      // agreed here survives the second call.
      let out = await POST(`/api/orders/${orderId}/invoice`, {
        lines: boxes().map((b) => ({ id: b.dataset.line, price: read(b) })),
        shipping: read($('#iv_ship')),
        others: read($('#iv_oth')),
      });
      if (canPick && moved()) {
        out = await POST(`/api/orders/${orderId}/lines`, { lines: each.picture() });
      }
      notice(`${typedNo || out.si_no || 'The invoice'} now comes to ${peso(out.total)} 🌸`, 'good');
      closeDialog();
      onSaved?.();
    } catch (e) { whoops(e); button.disabled = false; }
  });
}

/**
 * The warehouse's sheet: what to pick, and a box to tick beside each line.
 *
 * The same PACKING LIST already used on paper, so the bench is not asked to
 * read a new document. It carries no money — the person packing has no need
 * of what the account pays, and a price on a sheet that travels with the
 * goods is a price the customer's customer can read.
 *
 * Blank rows follow the real lines because the pad it replaces had them: a
 * substitution or a short-pick gets written where the checker is already
 * looking, rather than in the margin.
 */
function showPackingList({ orderId, resellerName, placedAt, lines, who = {},
                          packingNo = null, canEdit = false, catalog = null,
                          resellerId = null, onSaved = null }) {
  const BLANKS = Math.max(0, 8 - lines.length);
  // Somewhere to write what was not on the order. Four is what the pad leaves
  // room for once the real lines are on it, and four is more than anybody has
  // ever added to a box at the door.
  const SPARE = canEdit ? Math.min(BLANKS, 4) : 0;
  const goods = canEdit && catalog ? catalog : [];
  // A blank row is a product picker until it has a product in it. The list is
  // the wholesale catalogue, so what can be added to a box is what the
  // warehouse actually holds.
  const picker = (i) => `
    <td><input class="figure wide" list="doc_goods" data-add="${i}"
          autocomplete="off" placeholder="Add a product"></td>
    <td class="qty"><input class="figure mid" data-addqty="${i}"
          inputmode="numeric" disabled></td>
    <td class="unit" data-addunit="${i}"></td>`;
  dialog(`
    <div class="packing">
      <div class="rule"></div>
      <div class="head-row">
        <img src="/logo.png" alt="MS Beau Ave">
        <div class="who">
          <b>MS BEAU AVE ENTERPRISES OPC</b>
          <div>LOT 16-A BLK 2 MS BEAU AVE BAYAN BAYANAN AVE.<br>
          MARIKINA HEIGHTS CITY OF MARIKINA NCR, SECOND DISTRICT 1810</div>
        </div>
        <span></span>
      </div>
      <div class="title">PACKING LIST</div>
      <div class="party">
        <div>
          <div class="lbl" style="font-size:.85rem">${esc(resellerName || 'counter sale')}</div>
          ${TAX_LINES.map(([label, key]) => `
            <div class="lbl">${label}:
              ${canEdit && resellerId
                ? `<input class="figure wide" data-tax="${key}"
                     value="${esc(who?.[key] || '')}">`
                : `<span class="val">${esc(who?.[key] || '')}</span>`}</div>`).join('')}
        </div>
        <div style="white-space:nowrap">
          <div class="lbl">DATE: <span class="val">${onDay(placedAt)}</span></div>
          <div class="lbl">${packingNo ? 'PACKING LIST NO.' : 'SALES ORDER NO.'}:
            ${canEdit && packingNo
              ? `<input class="figure wide docno" data-docno autocomplete="off"
                   value="${esc(String(packingNo))}">`
              : `<span class="val">${esc(String(packingNo || orderId))}</span>`}</div>
          ${who?.drop_ship ? `<div class="lbl">DS:
            <span class="val">${esc(who.drop_ship)}</span></div>` : ''}
        </div>
      </div>
      <table>
        <thead><tr>
          <th style="width:34px"></th>
          <th>PRODUCT DESCRIPTION</th>
          <th style="width:90px">QUANTITY</th>
          <th style="width:90px">UNIT TYPE</th>
        </tr></thead>
        <tbody>
          ${lines.map((l) => `<tr>
            <td class="tick"><span class="box"></span></td>
            <td><b>${esc(l.name)}</b></td>
            <td class="qty">${canEdit
              ? `<input class="figure mid" inputmode="numeric"
                   data-sku="${esc(l.sku || '')}" value="${Number(l.qty)}">`
              : count(l.qty)}</td>
            <td class="unit">${esc(l.unit || '')}</td>
          </tr>`).join('')}
          ${Array.from({ length: SPARE }, (_x, i) => `<tr>
            <td class="tick"><span class="box"></span></td>${picker(i)}
          </tr>`).join('')}
          ${Array.from({ length: BLANKS - SPARE }, () => `<tr>
            <td class="tick"><span class="box"></span></td><td></td><td></td><td></td>
          </tr>`).join('')}
        </tbody>
      </table>
      <div class="sign">
        <div class="who-line">
          <div class="nm">${esc(user?.name || user?.username || '')}</div>
          <div class="role">Prepared by</div>
          <div class="cap">PREPARED BY:</div>
        </div>
        <div class="who-line">
          <div class="nm">&nbsp;</div>
          <div class="role">Warehouse Checker</div>
          <div class="cap">CHECKED BY:</div>
        </div>
      </div>
    </div>
    ${goodsList(goods)}
    <div class="mt right">
      ${canEdit ? '<span class="dim" id="pk_state"></span>' : ''}
      <button class="btn quiet" id="pk_save">⬇ Download JPEG</button>
      ${PRINT_BTN}
      ${canEdit ? '<button class="btn" id="pk_keep">Save the changes</button>' : ''}
      <button class="btn ${canEdit ? 'quiet' : ''}" id="pk_done">Close</button>
    </div>`, 'wide');
  wireSave('#pk_save', '.packing', `${packingNo || orderId} PACKING LIST.jpg`);
  $('#pk_done').addEventListener('click', closeDialog);

  if (!canEdit) return;

  const sheet = $('.packing');
  const each = sheetBoxes(sheet, goods, () => restate());

  function restate() {
    const going = each.picture().reduce((t, l) => t + l.qty, 0);
    $('#pk_state').innerHTML = going
      ? ''
      : `<span class="over">A sheet with nothing on it is a cancellation —
         cancel the order itself if that is what this is</span>`;
    $('#pk_keep').disabled = !going;
  }
  restate();

  $('#pk_keep').addEventListener('click', async () => {
    const button = $('#pk_keep');
    button.disabled = true;
    try {
      // The account's tax details first. They belong to the reseller rather
      // than to this order, so they are worth keeping even if the quantities
      // are then refused — and they are what every later sheet prints.
      const tax = {};
      $$('[data-tax]', sheet).forEach((el) => { tax[el.dataset.tax] = el.value.trim(); });
      if (Object.keys(tax).length
          && TAX_LINES.some(([, k]) => (tax[k] || '') !== (who?.[k] || ''))) {
        await POST(`/api/resellers/${resellerId}/tax`, tax);
      }
      // The sheet's own number goes before the quantities, for the reason the
      // invoice's does: it is a label, and nothing recalculates behind it.
      const typedNo = $('[data-docno]', sheet)?.value.trim().toUpperCase();
      if (typedNo && typedNo !== (packingNo || '')) {
        await POST(`/api/orders/${orderId}/numbers`, { pl_no: typedNo });
      }
      const out = await POST(`/api/orders/${orderId}/lines`, { lines: each.picture() });
      notice(`${typedNo || out.pl_no || 'The packing list'} now matches the box${
        out.si_no ? ` — ${out.si_no} comes to ${peso(out.total)}` : ''} 🌸`, 'good');
      closeDialog();
      onSaved?.();
    } catch (e) { whoops(e); button.disabled = false; }
  });
}

// An official receipt, as the till prints it. Raised from the reseller's
// own profile, where the bank confirmation happens, and shown the same way
// wherever it is raised from.
/**
 * The ACKNOWLEDGEMENT RECEIPT: the third of the three sheets, and the last one
 * in the conversation — the reseller has paid, and this is what says so.
 *
 * Not an Official Receipt. That is a BIR-registered document with its own
 * rules, and calling this one that would be claiming something the company has
 * not claimed. Only the name changes: the number is still the OR number, from
 * the till's own counter, and is still labelled as one — it is what the office
 * quotes to each other and what the ledger has always called it.
 *
 * Same letterhead, same party block, same shape as the order form and the
 * invoice, in green rather than pink or blue. The colour is the whole
 * difference, and it is enough: somebody scrolling a chat can tell which of
 * the three they are looking at without reading a word of it.
 *
 * What the table lists is not products. A payment is not made against goods,
 * it is made against invoices — oldest first — so the lines are the invoices
 * it settled, what each one took, and what each one has left. The rest of the
 * money, if there is any, is theirs: held as credit and shown as held rather
 * than quietly kept.
 */
function officialReceipt({ receiptNo, issuedOn, resellerName, who = {},
                           applied = [], credited = 0, stillOwed = 0,
                           method, reference, amount }) {
  const received = applied.reduce((t, a) => t + Number(a.applied), 0);
  const discount = applied.reduce((t, a) => t + Number(a.discount || 0), 0);

  // The table says which orders this receipt settled, one row each. It used to
  // say it once per transfer, which put the same invoice on five rows with the
  // same balance repeated down the side — five statements of one fact.
  //
  // And the sales order is the number, on its own. An invoice carries its own
  // id in the database but no document has ever shown it: the order form says
  // SALES ORDER NO., the invoice says SALES ORDER NO., and a receipt that
  // introduced a second number would be the only paper in the company asking
  // somebody to hold two.
  const byOrder = new Map();
  for (const a of applied) {
    const key = String(a.order_id ?? a.invoice_id);
    const row = byOrder.get(key) ?? { key, applied: 0, discount: 0, now_owes: 0 };
    row.applied += Number(a.applied);
    row.discount += Number(a.discount || 0);
    row.now_owes = Number(a.now_owes || 0);
    byOrder.set(key, row);
  }
  const orders = [...byOrder.values()];

  // How it was paid, transfer by transfer — the breakdown, in the same five
  // slots the invoice carries, because it is the same five payments seen from
  // the other side. A receipt raised in one step has no per-transfer detail to
  // show, so those slots fall back to what the one payment was made through.
  const slot = (a) => `
    <div class="slot">
      <b>MOP${a?.method || method ? ` &nbsp;&nbsp;&nbsp; ${esc(a?.method || method)}` : ''}</b>
      <div>Details: MS Beau Ave Enterprises OPC</div>
      <div>Reference no.: ${esc(a?.reference_no || (a ? '' : reference) || '')}</div>
      <div>Date: ${a ? onDay(a.paid_on || issuedOn) : ''}</div>
      <div>Amount: ${a ? peso(a.applied) : ''}</div>
    </div>`;
  const slots = [...applied.slice(0, 5).map(slot),
                 ...Array.from({ length: Math.max(0, 5 - applied.length) }, () => slot(null))];

  return `
    <div class="doc or">
      ${DOC_HEAD}
      <div class="title or">ACKNOWLEDGEMENT RECEIPT</div>
      ${docParty(resellerName, issuedOn, receiptNo, who, 'OR NO.')}
      <div class="duebox or">Amount Received (PHP)<b>${peso(amount ?? received + credited)}</b></div>
      <div style="clear:both"></div>

      <table class="lines">
        <thead><tr>
          <th style="width:120px">SALES ORDER NO.</th>
          <th>SETTLED AGAINST</th>
          <th style="width:88px">DISCOUNT</th>
          <th style="width:100px">APPLIED</th>
          <th style="width:104px">STILL OWED</th>
        </tr></thead>
        <tbody>
          ${orders.map((o) => `<tr>
            <td class="c">${esc(o.key)}</td>
            <td><b>Invoice for order #${esc(o.key)}</b></td>
            <td class="n">${o.discount > 0 ? peso(o.discount) : ''}</td>
            <td class="n">${peso(o.applied)}</td>
            <td class="n">${o.now_owes > 0 ? peso(o.now_owes) : 'settled'}</td>
          </tr>`).join('')}
          ${orders.length ? '' : `<tr><td class="c"></td>
            <td><b>Nothing was open to apply this to — held as credit.</b></td>
            <td></td><td></td><td></td></tr>`}
          ${Array.from({ length: Math.max(0, 3 - orders.length) },
            () => '<tr><td>&nbsp;</td><td></td><td></td><td></td><td></td></tr>').join('')}
        </tbody>
      </table>

      <div class="foot">
        <div class="mop">
          <div class="hd">HOW IT WAS PAID${
            applied.length > 1 ? ` — ${count(applied.length)} transfers` : ''}</div>
          ${slots.join('')}
        </div>
        <div>
          <div class="totals">
            <div><span>Applied to invoices:</span><span>${peso(received)}</span></div>
            ${discount > 0
              ? `<div><span>Early-settlement discount:</span><span>${peso(discount)}</span></div>` : ''}
            <div><span>Held as credit:</span><span>${peso(credited)}</span></div>
            <div class="grand"><span>Total Received:</span><span>${
              peso(amount ?? received + credited)}</span></div>
            <div class="bal"><span>Still owed on the account:</span><span>${peso(stillOwed)}</span></div>
          </div>
          <div class="thanks">Salamat po! 🌸</div>
        </div>
      </div>

      <div class="sign1">
        <div class="nm">${esc(user?.name || user?.username || '')}</div>
        <div>Order Management Coordinator</div>
        <div class="cap">RECEIVED BY:</div>
      </div>
    </div>`;
}

/**
 * The PURCHASE ORDER: the first sheet in this system that goes out rather than
 * back. Everything else here is the company selling; this is the company
 * buying, and the reader is a supplier, not a reseller.
 *
 * It carries no prices, because the paper it replaces carries none. A purchase
 * order is a request — what is wanted and how much of it — and what a case
 * costs is settled between the office and the supplier and lands when the
 * goods are received, which is where this system has always recorded cost.
 *
 * Two parties across the top rather than one: who is being asked, and where it
 * is to be sent. And three signatures rather than one, because buying is the
 * one thing here that nobody does alone — it is prepared, recorded and
 * acknowledged, and the boxes down the left are what the warehouse ticks when
 * the delivery is checked against it.
 */
function purchaseOrder({ poNo, orderedOn, supplier = {}, lines = [], note,
                         preparedBy, recordedBy, acknowledgedBy }) {
  const BLANKS = Math.max(0, 8 - lines.length);
  const field = (label, value) => `
    <div class="fld"><span>${label}</span><b>${esc(value || '')}</b></div>`;
  return `
    <div class="doc po">
      <div class="rule"></div>
      <div class="po-head">
        <img src="/logo.png" alt="MS Beau Ave">
        <div class="po-title">
          <h2>PURCHASE ORDER</h2>
          <div class="po-nums">
            ${field('DATE', onDay(orderedOn))}
            ${field('PURCHASE ORDER', poNo)}
          </div>
        </div>
      </div>

      <div class="po-parties">
        <div>
          <div class="barhd">SUPPLIER INFORMATION</div>
          ${field('COMPANY NAME:', supplier.supplier || supplier.name)}
          ${field('BRAND NAME', supplier.brand_name)}
          ${field('TIN NO.:', supplier.tin)}
          ${field('ADDRESS', supplier.address)}
        </div>
        <div>
          <div class="barhd">SHIP TO</div>
          ${field('COMPANY NAME:', 'MS BEAU AVE')}
          ${field('TIN NO.:', '010-794-089-00000')}
          ${field('ADDRESS', 'MARIKINA CITY')}
          ${field('CONTACT #', '9274054805')}
        </div>
      </div>

      <table class="lines">
        <thead><tr>
          <th style="width:52px">No.</th>
          <th>PRODUCT DESCRIPTION</th>
          <th style="width:110px">QUANTITY</th>
          <th style="width:90px">UNIT</th>
        </tr></thead>
        <tbody>
          ${lines.map((l, i) => `<tr>
            <td class="c">${i + 1}</td>
            <td>${esc(l.name)}</td>
            <td class="c">${count(l.qty)}</td>
            <td class="c">${esc(l.unit || l.unit_type || 'PCS')}</td>
          </tr>`).join('')}
          ${Array.from({ length: BLANKS },
            () => '<tr><td>&nbsp;</td><td></td><td></td><td></td></tr>').join('')}
        </tbody>
      </table>

      <div class="po-foot">
        <div class="notes">
          <div class="barhd">Comments or Special Instructions</div>
          <div class="wrote">${esc(note || '')}</div>
          <div class="ticks">
            <span><i></i>COMPLETED</span>
            <span><i></i>LACKINGS</span>
            <span><i></i>RECORDED</span>
          </div>
        </div>
      </div>

      <div class="sign3">
        <div><div class="nm">${esc(preparedBy || user?.name || '')}</div>
          <div class="role">Signature Over Printed Name</div>
          <div class="cap">PREPARED BY:</div></div>
        <div><div class="nm">${esc(recordedBy || '')}</div>
          <div class="role">Signature Over Printed Name</div>
          <div class="cap">RECORDED BY:</div></div>
        <div><div class="nm">${esc(acknowledgedBy || '')}</div>
          <div class="role">Signature Over Printed Name</div>
          <div class="cap">ACKNOWLEDGED BY:</div></div>
      </div>
    </div>`;
}

function showPurchaseOrder(po, over = false) {
  dialog(`${purchaseOrder({
    poNo: po.po_no, orderedOn: po.ordered_on, supplier: po,
    lines: po.lines || [], note: po.note,
    preparedBy: po.raised_by,
  })}
    <div class="mt right">
      <button class="btn quiet" id="po_save">⬇ Download JPEG</button>
      ${PRINT_BTN}
      <button class="btn" id="po_done">Done</button></div>`, 'wide', over);
  wireSave('#po_save', '.doc', `${po.po_no}.jpg`);
  $('#po_done').addEventListener('click', closeDialog);
}

// ---------------------------------------------------------------------------
// The receiving form — what actually came off the van
//
// The purchase order went out in units, because that is how you ask for
// something. This comes back in boxes, because that is how it arrives and how
// somebody standing next to it counts it: three boxes of sixteen and one
// plastic of nine, which is fifty-seven bottles, which is the number that
// matters to stock and to nobody on the loading bay.
//
// So a product here is a group of rows, one per packing, and the group's
// quantity is what they come to. Green, to sit beside the orange order it
// answers.
// ---------------------------------------------------------------------------
function receivingForm({ rfNo, poNo, receivedOn, receivedAt, supplier = {},
                         courier = {}, groups = [], foot = {} }) {
  const BLANKS = Math.max(0, 8 - groups.reduce((n, g) => n + g.packs.length, 0));
  const field = (label, value) => `
    <div class="fld"><span>${label}</span><b>${esc(value || '')}</b></div>`;

  const body = groups.map((g) => {
    const total = g.packs.reduce((n, k) => n + k.qty_per_box * k.boxes, 0);
    const span = g.packs.length;
    return g.packs.map((k, i) => `<tr>
      ${i === 0 ? `
        <td class="c" rowspan="${span}"><b>${count(total)}</b></td>
        <td class="c" rowspan="${span}">${esc(g.unit || 'PCS')}</td>
        <td rowspan="${span}">${esc(g.name || g.sku)}</td>` : ''}
      <td class="c">${count(k.qty_per_box)}</td>
      <td class="c">${count(k.boxes)}${k.pack && k.pack !== 'BOX'
        ? ` <i>${esc(k.pack)}</i>` : ''}</td>
      <td class="c">${count(k.qty_per_box * k.boxes)}</td>
    </tr>`).join('');
  }).join('');

  return `
    <div class="doc po rf">
      <div class="rule"></div>
      <div class="po-head">
        <img src="/logo.png" alt="MS Beau Ave">
        <div class="po-title">
          <h2>RECEIVING FORM</h2>
          <div class="po-nums">
            ${field('DATE', onDay(receivedOn))}
            ${field('RECEIVING FORM', rfNo)}
            ${poNo ? field('PURCHASE ORDER', poNo) : ''}
          </div>
        </div>
      </div>

      <div class="po-parties four">
        <div>
          <div class="barhd">SHIP TO</div>
          ${field('COMPANY NAME:', 'MS BEAU AVE')}
          ${field('TIN NO.:', '010-794-089-00000')}
          ${field('ADDRESS', 'MARIKINA CITY')}
          ${field('CONTACT #', '9274054805')}
        </div>
        <div>
          <div class="barhd">RECEIVED FROM (COURIER)</div>
          ${field('DRIVERS NAME:', courier.driver_name)}
          ${field('PLATE NO.:', courier.plate_no)}
          ${field('ADDRESS-PICKUP', courier.pickup)}
          ${field('CONTACT #', courier.contact)}
        </div>
        <div>
          <div class="barhd">SUPPLIER INFORMATION</div>
          ${field('SUPPLIER NAME:', supplier.supplier || supplier.name)}
          ${field('BRAND NAME', supplier.brand_name)}
        </div>
        <div>
          <div class="barhd">SHIPPING FEE</div>
          ${field('AMOUNT:', Number(courier.shipping_fee || 0) > 0
            ? peso(courier.shipping_fee) : '')}
          ${field('MOP', courier.shipping_mop)}
        </div>
      </div>

      <table class="lines">
        <thead><tr>
          <th style="width:78px">QUANTITY</th>
          <th style="width:62px">UNIT</th>
          <th>PRODUCT DESCRIPTION</th>
          <th style="width:86px">QTY PER BOX</th>
          <th style="width:92px">NO. OF BOXES</th>
          <th style="width:70px">TOTAL</th>
        </tr></thead>
        <tbody>
          ${body}
          ${Array.from({ length: BLANKS },
            () => '<tr><td>&nbsp;</td><td></td><td></td><td></td><td></td><td></td></tr>').join('')}
        </tbody>
      </table>

      <div class="rf-foot">
        <div class="notes">
          <div class="barhd">OTHERS</div>
          <div class="wrote">${esc(foot.others || '')}</div>
          <div class="tally">
            ${field('TOTAL OF BOXES', foot.total_boxes == null ? '' : count(foot.total_boxes))}
            ${field('GUARD ON DUTY', foot.guard_on_duty)}
            ${field('DATE AND TIME', receivedAt
              || (receivedOn ? onDay(receivedOn) : ''))}
          </div>
        </div>
        <div class="sign3">
          <div><div class="nm">${esc(foot.checked_by || '')}</div>
            <div class="role">Signature Over Printed Name</div>
            <div class="cap">CHECKED BY:</div></div>
          <div><div class="nm">${esc(foot.approved_by || '')}</div>
            <div class="role">Signature Over Printed Name</div>
            <div class="cap">APPROVED BY:</div></div>
          <div><div class="nm">${esc(foot.recorded_by || '')}</div>
            <div class="role">Signature Over Printed Name</div>
            <div class="cap">RECORDED BY:</div></div>
        </div>
      </div>
    </div>`;
}

// The stored form comes back as one row per packing; the paper wants them
// gathered back into the products they were packings of.
function rfGroups(lines = []) {
  const by = new Map();
  for (const l of lines) {
    const key = String(l.line_no);
    if (!by.has(key)) {
      by.set(key, { sku: l.sku, name: l.name, unit: l.unit, packs: [] });
    }
    by.get(key).packs.push({
      pack: l.pack, qty_per_box: Number(l.qty_per_box), boxes: Number(l.boxes),
    });
  }
  return [...by.values()];
}

function showReceivingForm(f, over = false) {
  dialog(`${receivingForm({
    rfNo: f.rf_no, poNo: f.po_no, receivedOn: f.received_on,
    receivedAt: f.received_at, supplier: f, courier: f,
    groups: f.groups || rfGroups(f.lines || []), foot: f,
  })}
    <div class="mt right">
      <button class="btn quiet" id="rf_save">⬇ Download JPEG</button>
      ${PRINT_BTN}
      <button class="btn" id="rf_done">Done</button></div>`, 'wide', over);
  wireSave('#rf_save', '.doc', `${f.rf_no}.jpg`);
  $('#rf_done').addEventListener('click', closeDialog);
}

function showOR(r, reseller, paid = {}, over = false) {
  dialog(`${officialReceipt({
    receiptNo: r.receipt_no,
    issuedOn: paid.paid_on || new Date(),
    resellerName: reseller?.name,
    who: reseller || {},
    applied: r.applied || [],
    credited: Number(r.credited || 0),
    stillOwed: Number(r.still_owed || 0),
    method: paid.method,
    reference: paid.reference_no,
    amount: paid.amount,
  })}
    <div class="mt right">
      <button class="btn quiet" id="or_save">⬇ Download JPEG</button>
      ${PRINT_BTN}
      <button class="btn" id="or_done">Done</button></div>`, 'wide', over);
  // The OR goes back into the same chat the payment was confirmed in, so it is
  // named after itself rather than the order it settles — one payment can
  // cover several.
  wireSave('#or_save', '.doc', `${r.receipt_no}.jpg`);
  $('#or_done').addEventListener('click', closeDialog);
}

// ===========================================================================
// Chat orders — the FB-Messenger flow: a reseller orders in chat, gets an
// invoice back in chat, pays the bank, and gets an OR once that is confirmed.
// One reseller at a time, ordering and payment side by side, so whoever is
// running the conversation never has to leave this screen to finish it.
// ===========================================================================
// One order, four documents, one menu.
//
// The customer order, the invoice and the packing list were three entries in
// the left-hand column, sitting apart from each other among two dozen others.
// They are not three parts of the system; they are four moments of one job —
// somebody messages, the order is taken, the account is invoiced, the bench
// packs it — and looking at the second while holding the third meant leaving
// the screen and finding it again in a list.
//
// Which panel is open outlives a redraw, because raising an invoice from the
// chat tab and being put back on the chat tab is right, and being put back on
// the first tab every time is how somebody loses their place.
let orderPanel = 'chatorders';

/**
 * The price list, whole.
 *
 * Every product down the page, every price code across it. This is how the
 * office reads a price list — down a column, comparing what a Regional pays
 * against what a Sub-Reseller does — and until now the only way to see it was
 * to open one product card at a time, sixty times.
 *
 * Typed into directly. This began read-only, on the reasoning that a grid of
 * eight hundred boxes is a place to make a mistake nobody notices for a month
 * — but the office keeps its prices in a spreadsheet precisely because a
 * spreadsheet lets you fix a column without opening eight hundred cards, and
 * asking somebody to leave this screen to change one figure they are already
 * looking at is how a price list stops being kept up to date.
 *
 * So: every figure and every code is typed into and saved on the spot, and the
 * safety is in the saving rather than in the refusing. One cell at a time, the
 * box says what it is doing, and a refusal puts the old value back rather than
 * leaving a number on screen that is not the number in the system.
 */
SCREENS.pricelists = async (page) => {
  let data = null;
  let brand = '';
  let term = '';
  let gapsOnly = false;

  page.innerHTML = `
    <div class="head"><h2>Pricelists</h2>
      <span class="hint">Type over any code or price and it saves itself</span>
      <span class="hint" id="pl_count"></span></div>
    <div class="tools">
      <input type="search" id="pl_find" placeholder="Search code, name or brand…" autofocus>
      <select id="pl_brand"><option value="">Every brand</option></select>
      <label class="dotkey" style="gap:6px">
        <input type="checkbox" id="pl_gaps"> only products missing a price</label>
    </div>
    <div id="pl_table" class="scrollx"></div>`;

  // A code nobody has priced anything under is not a column of gaps; it is a
  // code that is not in use. Counting its eight hundred blanks as "not set"
  // buries the handful that somebody actually has to go and fill in — VIP,
  // STOCKIST and EXEC alone would have contributed some 2,700 of them.
  const inUse = () => data.codes.filter((c) =>
    data.products.some((p) => p.prices[c] != null));
  const unused = () => data.codes.filter((c) =>
    !data.products.some((p) => p.prices[c] != null));

  const draw = () => {
    if (!data) return;
    const codes = inUse();
    const t = term.trim().toLowerCase();
    const shown = data.products.filter((p) => {
      if (brand && (p.brand || '') !== brand) return false;
      if (gapsOnly && codes.every((c) => p.prices[c] != null)) return false;
      if (!t) return true;
      return p.sku.toLowerCase().includes(t)
        || p.name.toLowerCase().includes(t)
        || (p.brand || '').toLowerCase().includes(t);
    });

    // A missing price is the thing worth spotting, so it is a dash in the
    // danger colour rather than an empty cell that reads as a zero.
    const plain = (v) => (v == null ? '' : peso(v).replace('₱', ''));
    $('#pl_table', page).innerHTML = table(shown, [
      { head: 'Code', cell: (p) => `<input class="cellbox code" data-sku="${esc(p.sku)}"
          value="${esc(p.sku)}" spellcheck="false"
          title="The code this product is known by everywhere">` },
      { head: 'Product', cell: (p) => `<b>${esc(p.name)}</b>${p.active ? ''
          : ' ' + tag('hidden', 'grey')}<br><span class="dim">${esc(p.brand || '')}${
          p.unit_type ? ' · ' + esc(p.unit_type) : ''}</span>` },
      ...codes.map((c) => ({
        head: c, n: true,
        cell: (p) => `<input class="cellbox money ${p.prices[c] == null ? 'unset' : ''}"
          inputmode="decimal" data-sku="${esc(p.sku)}" data-code="${esc(c)}"
          value="${plain(p.prices[c])}" placeholder="—">`,
      })),
      { head: 'Retail', n: true, cell: (p) => Number(p.retail_price)
          ? peso(p.retail_price) : '<span class="over">—</span>' },
    ], 'Nothing matches that.');
    wireCells();

    shownNow = shown;
    countUp();
  };

  // Split out of draw(), because filling a cell changes the tally without
  // changing anything else on the page.
  let shownNow = [];
  const countUp = () => {
    const codes = inUse();
    const shown = shownNow;
    const missing = codes.reduce((n, c) =>
      n + shown.filter((p) => p.prices[c] == null).length, 0);
    const idle = unused();
    $('#pl_count', page).innerHTML = `${count(shown.length)} product${
      shown.length === 1 ? '' : 's'}${missing ? ` · <b>${count(missing)}</b> price${
      missing === 1 ? '' : 's'} not set` : ' · every price set'}${idle.length
      ? ` · ${idle.map(esc).join(', ')} ${idle.length === 1 ? 'is' : 'are'} not in use`
      : ''}`;
  };

  // Saved one cell at a time, on leaving it rather than on every keystroke.
  //
  // The row is not redrawn afterwards. Redrawing under somebody working across
  // a row takes the next box away mid-type, and the only thing that changed is
  // the figure they just typed — so the cell reports for itself: it goes quiet
  // while saving, settles into the shape the rest of the column is in, and on
  // a refusal puts back what was there before. A number on screen that is not
  // the number in the system is worse than no screen at all.
  const settle = (box, value) => {
    box.classList.remove('saving');
    box.value = value;
  };

  const wireCells = () => {
    $$('.cellbox.money', page).forEach((box) => {
      box.addEventListener('change', async () => {
        const { sku, code } = box.dataset;
        const row = data.products.find((p) => p.sku === sku);
        const before = row?.prices[code];
        const typed = String(box.value).replace(/[^0-9.]/g, '');
        if (typed === '') { settle(box, plainOf(before)); return; }
        const asked = Number(typed);
        if (!Number.isFinite(asked) || asked < 0) {
          notice('A price is a number, and not less than nothing.', 'bad');
          settle(box, plainOf(before));
          return;
        }
        if (before != null && Number(before) === asked) { settle(box, plainOf(asked)); return; }
        box.classList.add('saving');
        try {
          await POST(`/api/products/${encodeURIComponent(sku)}/price`, { code, price: asked });
          if (row) row.prices[code] = asked;
          box.classList.remove('unset');
          settle(box, plainOf(asked));
          countUp();
        } catch (e) { whoops(e); settle(box, plainOf(before)); }
      });
    });

    $$('.cellbox.code', page).forEach((box) => {
      box.addEventListener('change', async () => {
        const was = box.dataset.sku;
        const asked = box.value.trim().toUpperCase();
        if (!asked || asked === was) { settle(box, was); return; }
        box.classList.add('saving');
        try {
          const out = await POST(`/api/products/${encodeURIComponent(was)}/code`, { code: asked });
          const row = data.products.find((p) => p.sku === was);
          if (row) row.sku = out.sku;
          // Every price box on this row was addressed by the old code.
          $$(`[data-sku="${CSS.escape(was)}"]`, page).forEach((el) => { el.dataset.sku = out.sku; });
          settle(box, out.sku);
          notice(`${was} is now ${out.sku} 🌸`, 'good');
        } catch (e) { whoops(e); settle(box, was); }
      });
    });
  };

  const plainOf = (v) => (v == null ? '' : peso(v).replace('₱', ''));

  $('#pl_find', page).addEventListener('input', (e) => { term = e.target.value; draw(); });
  $('#pl_brand', page).addEventListener('change', (e) => { brand = e.target.value; draw(); });
  $('#pl_gaps', page).addEventListener('change', (e) => { gapsOnly = e.target.checked; draw(); });

  data = await GET('/api/pricelist');
  const brands = [...new Set(data.products.map((p) => p.brand).filter(Boolean))].sort();
  $('#pl_brand', page).innerHTML = '<option value="">Every brand</option>'
    + brands.map((b) => `<option value="${esc(b)}">${esc(b)}</option>`).join('');
  draw();
};

SCREENS.customerorder = async (page) => {
  const PANELS = [
    ['chatorders', 'Chat order'],
    ['pendingorders', 'Pending customer order'],
    ['resellers', 'Invoice'],
    ['orders', 'Packing list'],
  ];
  if (!PANELS.some(([id]) => id === orderPanel)) orderPanel = 'chatorders';

  page.innerHTML = `
    <div class="subtabs">
      ${PANELS.map(([id, label]) => `<button data-panel="${esc(id)}"
        class="${id === orderPanel ? 'on' : ''}">${esc(label)}</button>`).join('')}
    </div>
    <div id="panel"></div>`;

  $$('[data-panel]', page).forEach((b) => b.addEventListener('click', () => {
    orderPanel = b.dataset.panel;
    SCREENS.customerorder(page).catch(whoops);
  }));

  // Each panel draws its own heading, so this adds none: two headings stacked
  // on one screen reads as two screens that failed to separate.
  await SCREENS[orderPanel]($('#panel', page));
};

/**
 * Everything taken and not yet out of the door.
 *
 * The list somebody works from rather than a report: an order that has been
 * placed is money promised and stock held, and until it is delivered it is
 * somebody's to chase. Delivered orders drop off it by themselves — a list
 * that only grows is a list nobody opens twice.
 *
 * All three numbers on every row, because the question asked over Messenger is
 * never "how is order 41 doing". It is "what happened to CO26_08_004", and the
 * answer is on the same row as the invoice it became.
 */
SCREENS.pendingorders = async (page) => {
  const load = async () => {
    const rows = (await GET('/api/orders?status='))
      .filter((o) => o.status === 'placed' || o.status === 'picking');
    $('#pending', page).innerHTML = table(rows, [
      { head: 'Customer order', cell: (o) => `<b>${esc(o.co_no || '—')}</b>` },
      { head: 'Reseller', cell: (o) => `${esc(o.reseller || '')} `
          + (o.tier ? tierTag(o.tier) : '') },
      { head: 'Stage', cell: (o) => orderTag(o) },
      { head: 'Invoice', cell: (o) => o.si_no
          ? `${esc(o.si_no)}<br><span class="dim">${o.invoice_status === 'open'
              ? `due ${onDay(o.due_on)}` : esc(o.invoice_status || '')}</span>`
          : '<span class="dim">not raised</span>' },
      { head: 'Packing list', cell: (o) => esc(o.pl_no || '—') },
      { head: 'Total', n: true, cell: (o) => peso(o.total) },
      { head: 'Placed', cell: (o) => when(o.placed_at) },
      { head: '', cell: (o) => `<button class="btn sm quiet" data-open="${o.id}">Open</button>` },
    ], 'Nothing is waiting — every order taken has gone out.');

    $('#pending_count', page).textContent = rows.length
      ? `${count(rows.length)} waiting · ${peso(rows.reduce((t, o) => t + Number(o.total), 0))}`
      : '';

    $$('[data-open]', page).forEach((b) => b.addEventListener('click',
      () => openOrder(b.dataset.open, load).catch(whoops)));
  };

  page.innerHTML = `
    <div class="head"><h2>Pending customer orders</h2>
      <span class="hint">Taken and not yet out of the door. Open one to change
        it, invoice it, or send the paperwork again</span>
      <span class="hint" id="pending_count"></span></div>
    <div id="pending"></div>`;
  await load();
};

SCREENS.chatorders = async (page) => {
  let resellers = [];
  let picked = null;
  let catalog = null;
  let codes = null;
  const basket = new Map();

  page.innerHTML = `
    <div class="head"><h2>Chat orders</h2>
      <span class="hint">For an order that came in over Messenger — place it,
        then send them the order form. The payment is confirmed on their own
        page, under Invoice</span></div>
    <div class="tools">
      <input type="search" id="rs_find" placeholder="Filter by name or email…" autofocus>
    </div>
    <div id="rs_hits"></div>
    <div id="working"></div>`;

  const findBox = $('#rs_find', page);
  const hitsBox = $('#rs_hits', page);
  const workingBox = $('#working', page);

  // Two letters off the name, so a card without a picture is still a card
  // somebody recognises at a glance rather than a row of identical squares.
  const initials = (name) => (name || '?')
    .split(/\s+/).filter(Boolean).slice(0, 2)
    .map((w) => w[0]).join('').toUpperCase();

  // Everybody, all the time, laid out the way the faces are on the time clock.
  // Typing filters what is already on screen instead of summoning a list:
  // whoever is taking the order is looking at a chat window, and reading a
  // name off it and finding that name is one action, not two.
  const drawHits = () => {
    const term = findBox.value.trim().toLowerCase();
    const shown = resellers.filter((r) => !term
      || r.name.toLowerCase().includes(term)
      || (r.email || '').toLowerCase().includes(term));
    hitsBox.innerHTML = shown.length ? `<div class="face-grid">${shown.map((r) => `
      <button class="face-card ${r.blocked ? 'stopped' : ''}" data-pick="${r.id}"
        ${r.blocked ? 'disabled' : ''} title="${esc(r.name)}">
        ${r.photo_at
          ? `<img class="face" src="/api/resellers/${r.id}/photo?v=${r.photo_at}" alt="">`
          : `<span class="face">${esc(initials(r.name))}</span>`}
        <span class="strip"><b>${esc(r.name)}</b>
          <span class="under ${!r.blocked && Number(r.owed) > 0 ? 'owing' : ''}">${
            r.blocked ? 'cannot order'
            : Number(r.owed) > 0 ? `owes ${peso(r.owed)}` : 'clear'}</span></span>
      </button>`).join('')}</div>`
      : '<div class="dim">Nobody matches that.</div>';
    // r.id comes back from the API as a string — a bigint column arrives as
    // text, node-pg's own precaution against losing precision above 2^53 —
    // so this has to compare as text too, not coerce one side to a number.
    $$('[data-pick]', hitsBox).forEach((b) => b.addEventListener('click',
      () => pick(resellers.find((r) => String(r.id) === b.dataset.pick))));
  };

  const pick = (r) => {
    picked = r;
    basket.clear();
    findBox.value = '';
    hitsBox.innerHTML = '';
    drawWorking();
  };

  const backToPicker = () => {
    picked = null;
    basket.clear();
    workingBox.innerHTML = '';
    drawHits();
    findBox.focus();
  };

  const drawWorking = () => {
    if (!picked) { workingBox.innerHTML = ''; return; }
    workingBox.innerHTML = `
      <div class="panel">
        <h3>${esc(picked.name)}
          ${Number(picked.owed) > 0 ? tag(`owes ${peso(picked.owed)}`, picked.overdue ? 'red' : 'amber') : tag('nothing owed', 'green')}
          ${picked.blocked ? tag('cannot order', 'red') : ''}</h3>
        <button class="btn sm quiet" id="rs_change">Change reseller</button>
      </div>
      ${picked.blocked ? `<div class="banner bad">This account cannot order right now:
        ${esc(picked.blocked_reason || 'a past-due invoice')}. Confirm their bank
        payment on their own page, under Invoice — that lifts this by itself once
        nothing is overdue.</div>` : ''}
      ${picked.drop_ship ? `
        <div class="panel">
          <h3>Sending it on</h3>
          <div class="dim">This account buys for herself some weeks and to send
            straight on to somebody else in others. Left alone this order is
            hers. Tick it only when the goods go elsewhere, and that name
            prints beside her own on the form.</div>
          <div class="row">
            <div style="flex:0 0 auto"><label class="dotkey" style="gap:8px">
              <input type="checkbox" id="ch_dson"> Send this one on to somebody</label></div>
            <div style="flex:2"><label for="ch_ds">Drop ship to</label>
              <input id="ch_ds" type="text" autocomplete="off" disabled
                value="${esc(picked.drop_ship_to || '')}"
                placeholder="Who it goes on to"></div>
          </div>
        </div>` : ''}
      <div class="split">
        <div class="panel">
          <h3>1 · What they ordered</h3>
          <input type="search" id="ch_find" placeholder="Search products…">
          <div class="dim" id="ch_count" style="font-size:.72rem;margin:4px 0 2px"></div>
          <div id="ch_goods" class="scroll" style="max-height:420px;overflow-y:auto"></div>
          <h4 class="mt">Basket</h4>
          <div id="ch_basket"></div>
          <div class="total" id="ch_total">₱0.00</div>
          <div id="ch_nocode"></div>
          <div class="mt right"><button class="btn" id="ch_place">Place order &amp; raise invoice</button></div>
          <div id="ch_order_out" class="mt"></div>
        </div>
        <div class="panel">
          <h3>2 · What they will be sent</h3>
          <div class="dim">The customer order form itself, filled in as you add
            to the basket — so what goes into the chat is read here first,
            rather than after it has been raised.</div>
          <div id="ch_preview" class="preview mt"></div>
        </div>
      </div>`;

    $('#rs_change', workingBox).addEventListener('click', backToPicker);

    if (!catalog) {
      GET('/api/wholesale/catalog').then((rows) => { catalog = rows; drawGoods(); }).catch(whoops);
    } else drawGoods();
    // The codes are the same all day; fetched once and kept.
    if (!codes) {
      GET('/api/price-codes').then((rows) => { codes = rows; drawBasket(); }).catch(whoops);
    }

    // Ticked or not is the question; the name is only the answer to it. One
    // reading of both, so the paper on screen and the order that gets placed
    // cannot come to different conclusions.
    $('#ch_dson', workingBox)?.addEventListener('change', (e) => {
      const box = $('#ch_ds', workingBox);
      box.disabled = !e.target.checked;
      if (e.target.checked && !box.value.trim()) box.value = picked.drop_ship_to || '';
      if (e.target.checked) box.focus();
      drawPreview();
    });
    $('#ch_ds', workingBox)?.addEventListener('input', drawPreview);
    $('#ch_find', workingBox).addEventListener('input', drawGoods);
    $('#ch_place', workingBox).addEventListener('click', placeOrder);
    drawBasket();
  };

  const drawGoods = () => {
    const box = $('#ch_goods', workingBox);
    if (!box) return;
    const term = ($('#ch_find', workingBox)?.value || '').trim().toLowerCase();
    const rows = (catalog || []).filter((p) => !term
      || p.name.toLowerCase().includes(term) || (p.brand || '').toLowerCase().includes(term));
    // Named for what it is rather than what it holds: `count` is the shared
    // formatter three lines below, and taking that name here left the table
    // calling a div.
    const tally = $('#ch_count', workingBox);
    if (tally) {
      tally.textContent = term
        ? `${rows.length} of ${(catalog || []).length} products match “${term}”`
        : `All ${rows.length} products — type to narrow it down`;
    }
    box.innerHTML = table(rows, [
      { head: 'Product', cell: (p) => `<b>${esc(p.name)}</b> <span class="dim">${esc(p.brand || '')}</span>` },
      { head: 'Price', n: true, cell: (p) => peso(p.wholesale_price) },
      { head: 'Have', n: true, cell: (p) => count(p.available) },
      { head: '', cell: (p) => `<button class="btn sm quiet" data-add="${esc(p.sku)}"
          ${p.available <= 0 ? 'disabled' : ''}>Add</button>` },
    ], 'Nothing matches.');
    $$('[data-add]', box).forEach((b) => b.addEventListener('click', () => {
      const p = catalog.find((x) => x.sku === b.dataset.add);
      const line = basket.get(p.sku)
        ?? { sku: p.sku, name: p.name, price: Number(p.wholesale_price),
             listed: Number(p.wholesale_price),
             unit: p.unit_type || 'PCS', code: '', prices: p.prices || {}, qty: 0 };
      line.qty += 1;
      basket.set(p.sku, line);
      drawBasket();
    }));
  };

  const drawBasket = () => {
    const box = $('#ch_basket', workingBox);
    if (!box) return;
    // Thirteen codes was a row of thirteen buttons, which wrapped onto three
    // lines and made every basket line tall enough to push the total off the
    // screen. A list that is thirteen long is a list, not a set of buttons.
    //
    // Beside it, the price itself. A code covers the prices the office has
    // agreed in advance; it does not cover the one a reseller talked somebody
    // into on Messenger this morning, and until now that order could not be
    // taken here at all. Typing a price is therefore a third state, not a
    // broken version of the first two: it clears the code, because the number
    // is no longer what that code means, and it silences the no-PCODE warning,
    // because the price was chosen rather than defaulted to.
    const plain = (v) => peso(v).replace('₱', '');
    box.innerHTML = basket.size ? [...basket.values()].map((l) => `
      <div class="pick">
        <span class="nm"><b>${esc(l.name)}</b><br><span class="dim">${
          l.typed ? 'typed price' : l.code ? esc(l.code) : 'no PCODE'
          }${l.unit ? ' · ' + esc(l.unit) : ''} · ${peso(l.price * l.qty)} for ${count(l.qty)}</span></span>
        <select class="pcode" data-code="${esc(l.sku)}"
          title="Which agreed price this line is charged at">
          <option value="">${l.typed ? 'typed price' : `no PCODE — ${plain(l.listed ?? l.price)}`}</option>
          ${(codes || []).filter((c) => (l.prices || {})[c.code] != null)
            .map((c) => `<option value="${esc(c.code)}"
              ${!l.typed && c.code === l.code ? 'selected' : ''}>${esc(c.code)} — ${
              plain(l.prices[c.code])}</option>`).join('')}
        </select>
        <input class="unit" type="text" inputmode="decimal" data-price="${esc(l.sku)}"
          value="${plain(l.price)}" title="The unit price charged on this line">
        <input type="number" min="1" value="${l.qty}" data-qty="${esc(l.sku)}">
        <button class="btn sm stop" data-drop="${esc(l.sku)}">✕</button>
      </div>`).join('') : '<div class="none">Nothing added yet.</div>';
    $('#ch_total', workingBox).textContent =
      peso([...basket.values()].reduce((s, l) => s + l.price * l.qty, 0));
    $$('[data-qty]', box).forEach((i) => i.addEventListener('change', () => {
      basket.get(i.dataset.qty).qty = Math.max(1, +i.value || 1);
      drawBasket();
    }));
    $$('[data-drop]', box).forEach((b) => b.addEventListener('click', () => {
      basket.delete(b.dataset.drop);
      drawBasket();
    }));
    drawPreview();
    // Tapping the code already on is how it comes off again, so a line can go
    // back to the listed price without a blank entry in a list to mean it.
    const warn = $('#ch_nocode', workingBox);
    if (warn) {
      const bare = [...basket.values()].filter((l) => !l.code && !l.typed
        && Object.keys(l.prices || {}).length);
      warn.innerHTML = bare.length ? `<div class="banner warn">
        <b>${count(bare.length)} line${bare.length > 1 ? 's have' : ' has'} no PCODE.</b>
        ${bare.map((l) => `${esc(l.name)} — ${peso(l.price)}, against ${
          peso(Math.min(...Object.values(l.prices).map(Number)))} at its cheapest code`)
          .join('<br>')}
        <div class="dim mt">Placed as it stands, ${bare.length > 1 ? 'these lines are' : 'this line is'}
          charged the listed price, which is not a dealer price.</div></div>` : '';
    }
    drawPreview();
    $$('[data-code]', box).forEach((sel) => sel.addEventListener('change', () => {
      const line = basket.get(sel.dataset.code);
      line.code = sel.value;
      line.typed = false;
      const priced = (line.prices || {})[line.code];
      line.price = priced != null ? Number(priced) : Number(line.listed ?? line.price);
      drawBasket();
    }));

    // On change rather than on input: the basket redraws itself after every
    // edit, and redrawing under somebody's cursor takes the field away
    // mid-number. This fires when they leave it, by which time they have
    // finished typing.
    $$('[data-price]', box).forEach((i) => i.addEventListener('change', () => {
      const line = basket.get(i.dataset.price);
      // Typed with the commas it was shown with, most of the time.
      const asked = Number(String(i.value).replace(/[^0-9.]/g, ''));
      if (!Number.isFinite(asked) || asked <= 0) { drawBasket(); return; }
      const listed = Number(line.listed ?? line.price);
      const coded = Object.entries(line.prices || {})
        .find(([, v]) => Number(v) === asked);
      line.price = asked;
      // Typing a number that is exactly one of the codes is not a hand price;
      // it is that code, and saying so keeps the paperwork honest.
      if (coded) { line.code = coded[0]; line.typed = false; }
      else if (asked === listed) { line.code = ''; line.typed = false; }
      else { line.code = ''; line.typed = true; }
      drawBasket();
    }));
  };

  // Asked once, and answered by pressing the thing that says what will happen
  // rather than the thing that says yes.
  const askedAndAnswered = (bare) => new Promise((done) => {
    dialog(`
      <h3>Place without a PCODE?</h3>
      <div class="dim">${count(bare.length)} line${bare.length > 1 ? 's have' : ' has'}
        no price code, so ${bare.length > 1 ? 'they are' : 'it is'} charged the
        listed price rather than a dealer's.</div>
      <div class="mt">${bare.map((l) => `<div class="pick">
        <span class="nm"><b>${esc(l.name)}</b><br>
          <span class="dim">${peso(l.price)} listed · ${
            peso(Math.min(...Object.values(l.prices).map(Number)))} at its cheapest code</span></span>
      </div>`).join('')}</div>
      <div class="mt right">
        <button class="btn quiet" id="nc_back">Go back and pick one</button>
        <button class="btn stop" id="nc_go">Charge the listed price</button></div>`);
    $('#nc_back').addEventListener('click', () => { closeDialog(); done(false); });
    $('#nc_go').addEventListener('click', () => { closeDialog(); done(true); });
  });

  // Its own number until it has one: an order form on screen has not been
  // placed, and putting a plausible number on it invites somebody to quote it.
  let placedAs = null;
  let placedCo = null;

  // Empty unless this account has it on, the tick is in, and a name is typed.
  // Returning '' rather than the account's boolean matters: `drop_ship` on a
  // reseller is true/false and on a document is a name, and a document handed
  // the boolean would print "DS: true".
  const sendingOn = () => (picked?.drop_ship && $('#ch_dson', workingBox)?.checked
    ? ($('#ch_ds', workingBox)?.value || '').trim() : '');

  const drawPreview = () => {
    const box = $('#ch_preview', workingBox);
    if (!box || !picked) return;
    const lines = [...basket.values()];
    box.innerHTML = customerOrderForm({
      orderId: placedAs ?? '—',
      orderNo: placedCo,
      issuedOn: new Date(),
      amount: lines.reduce((t, l) => t + l.price * l.qty, 0),
      resellerName: picked.name,
      lines,
      // Shown as it will print, including whoever is in the Drop ship box at
      // this moment — the whole point of the preview is that what goes into
      // the chat is read here first.
      who: { ...picked, drop_ship: sendingOn() || null },
    });
    const doc = box.firstElementChild;
    if (!doc) return;
    // Measured before the document is widened, or the widening is what gets
    // measured.
    const room = box.clientWidth || 900;
    doc.style.width = '900px';
    doc.style.transformOrigin = 'top left';
    const scale = Math.min(1, room / 900);
    doc.style.transform = `scale(${scale})`;
    // A scaled element still claims its unscaled height, which would leave a
    // page's worth of blank underneath it.
    box.style.height = `${doc.scrollHeight * scale}px`;
  };

  async function placeOrder() {
    if (!basket.size) return notice('Add what they ordered first.', 'bad');
    const lines = [...basket.values()];
    const bare = lines.filter((l) => !l.code && Object.keys(l.prices || {}).length);
    if (bare.length && !(await askedAndAnswered(bare))) return;
    $('#ch_place', workingBox).disabled = true;
    try {
      const sendOn = sendingOn();
      const out = await POST(`/api/resellers/${picked.id}/orders`, {
        lines: lines.map((l) => ({ sku: l.sku, qty: l.qty, code: l.code || null })),
        drop_ship: sendOn || null,
      });
      if (sendOn) picked.drop_ship_to = sendOn;
      placedAs = out.orderId;
      placedCo = out.co_no;
      basket.clear();
      drawBasket();
      $('#ch_order_out', workingBox).innerHTML =
        `<div class="banner good">Order placed. Here is the invoice to send back.
         <button class="btn sm quiet" id="ch_packing">🖨 Packing list</button></div>`;
      $('#ch_order_out', workingBox).querySelector('#ch_packing')
        .addEventListener('click', () => showPackingList({
          orderId: out.orderId, packingNo: out.pl_no,
          resellerName: picked.name, placedAt: new Date(), lines, who: picked,
        }));
      notice('Order placed 🌸', 'good');
      if (out.invoice) showInvoice({
        orderId: out.orderId, orderNo: out.co_no,
        issuedOn: out.invoice.issued_on,
        amount: out.invoice.amount, resellerName: picked.name, lines,
        who: picked,
        canEdit: ['admin', 'office'].includes(user?.role),
        // The panel behind is the same sheet, drawn live, and it quotes the
        // number as well — left alone it would go on showing the one that was
        // just corrected.
        onSaved: (co) => { placedCo = co; drawPreview(); },
      });
    } catch (e) { whoops(e); } finally {
      $('#ch_place', workingBox).disabled = false;
    }
  }

  findBox.addEventListener('input', drawHits);
  resellers = (await GET('/api/resellers'))
    .sort((a, b) => a.name.localeCompare(b.name));
  // Drawn once the accounts are in hand: the grid is the screen now, not
  // something a search produces.
  drawHits();
};

// ===========================================================================
// Resellers
// ===========================================================================
SCREENS.resellers = async (page) => {
  let term = '';
  const load = async () => {
    const all = await GET('/api/resellers');
    const rows = all.filter((r) => !term
      || r.name.toLowerCase().includes(term)
      || (r.email || '').toLowerCase().includes(term));
    $('#list', page).innerHTML = table(rows, [
      // The name is the way in. A row with a button at the far end asks you to
      // cross it to act on the thing you are already pointing at.
      { head: 'Reseller', cell: (r) => `
          <button class="nameopen" data-open="${r.id}">
            ${Number(r.owed) > 0
              ? `<span class="blip ${r.overdue ? 'late' : ''}" title="${
                  r.overdue ? 'has a past-due invoice' : 'has an invoice waiting to be paid'
                }"></span>` : ''}<b>${esc(r.name)}</b>
          </button>${r.email ? `<div class="dim">${esc(r.email)}</div>` : ''}` },
      { head: 'Tier', cell: (r) => tierTag(r.tier) },
      { head: 'Standing', cell: (r) => (r.blocked || r.overdue
          ? tag('cannot order', 'red')
          : r.status === 'active' ? tag('active', 'green') : tag(r.status, 'amber'))
          + (r.docs_verified ? '' : ' ' + tag('papers pending', 'grey')) },
      { head: 'Limit', n: true, cell: (r) => peso(r.credit_limit) },
      { head: 'Owes', n: true, cell: (r) => peso(r.owed) },
      { head: 'Payment record', cell: (r) => `<span class="dim">${r.paid_on_time} on time · ${
          r.late_this_quarter > 0
            ? `<span class="tag red">${r.late_this_quarter} late this quarter</span>`
            : 'none late this quarter'}</span>` },
    ], 'No reseller accounts yet.');

    $$('[data-open]', page).forEach((b) => b.addEventListener('click',
      () => openReseller(+b.dataset.open, load).catch(whoops)));
  };

  page.innerHTML = `
    <div class="head"><h2>Resellers</h2>
      <span class="hint">Whoever was invoiced most recently is at the top, and
        stays there until they pay · Tier 1 pays first · Tier 2 gets terms ·
        Tier 3 gets the best terms</span>
      <div class="dotkey">
        <span><i class="blip"></i>owes money, not yet past due</span>
        <span><i class="blip late"></i>past due</span>
      </div></div>
    <div class="tools">
      <input type="search" id="find" placeholder="Search name or email…">
      <button class="btn" id="add">＋ New reseller</button>
    </div>
    <div class="panel" id="list"></div>`;

  $('#find', page).addEventListener('input', (e) => {
    term = e.target.value.toLowerCase();
    load().catch(whoops);
  });

  $('#add', page).addEventListener('click', () => {
    dialog(`
      <h3>New reseller</h3>
      <div class="row">
        <div style="flex:2"><label>Business name</label><input id="n_name" type="text"></div>
        <div style="flex:2"><label>Email</label><input id="n_email" type="text"></div>
      </div>
      <div class="row">
        <div><label>Contact person</label><input id="n_contact" type="text"></div>
        <div><label>Tier</label><select id="n_tier">
          <option value="1">1 — new, pays first</option>
          <option value="2">2 — established</option>
          <option value="3">3 — key account</option></select></div>
        <div><label>Credit limit</label><input id="n_limit" type="number" value="0"></div>
        <div><label>Days to pay</label><input id="n_days" type="number" value="0"></div>
      </div>
      <div class="dim mt">New accounts start as pending. Approve them once the
        licence and tax papers are on file.</div>
      <div class="mt right"><button class="btn" id="n_save">Create</button></div>`);
    $('#n_save').addEventListener('click', async () => {
      try {
        await POST('/api/resellers', {
          name: $('#n_name').value, email: $('#n_email').value,
          contact: $('#n_contact').value, tier: +$('#n_tier').value,
          credit_limit: +$('#n_limit').value, terms_days: +$('#n_days').value,
        });
        notice('Account created 🌸', 'good');
        closeDialog();
        load();
      } catch (e) { whoops(e); }
    });
  });

  await load();
  repeat(load, 15000);
};

async function openReseller(id, reload) {
  const r = await GET(`/api/resellers/${id}`);
  dialog(`
    <h3>${esc(r.name)}</h3>
    <div class="tags">${tierTag(r.tier)}
      ${r.blocked || r.overdue ? tag('cannot order', 'red') : tag(r.status, 'green')}
      ${r.docs_verified ? tag('papers verified', 'green') : tag('papers pending', 'amber')}
      ${tag(`limit ${peso(r.credit_limit)}`, 'pink')}
      ${tag(`owes ${peso(r.owed)}`, Number(r.owed) > 0 ? 'amber' : 'green')}
      ${Number(r.credit) > 0 ? tag(`${peso(r.credit)} in credit`, 'green') : ''}</div>

    ${r.blocked || r.overdue ? `<div class="banner bad">Cannot order:
      ${esc(r.blocked_reason || 'there is a past-due invoice')}. Recording the payment
      lifts this by itself — an override below is only for when you have decided to
      let it through anyway.</div>` : ''}

    ${Number(r.credit) > 0 ? `<div class="banner good">Holding ${peso(r.credit)} of
      theirs — money that arrived with nothing open left to pay. It is taken off
      their next invoice automatically, the moment it is raised.</div>` : ''}

    ${r.status !== 'active' || !r.docs_verified
      ? '<div class="mt"><button class="btn go" id="d_approve">Approve this account</button></div>' : ''}

    <h3 class="mt">Terms</h3>
    <div class="row">
      <div><label>Tier</label><select id="d_tier">${[1, 2, 3].map((t) =>
        `<option value="${t}" ${t === r.tier ? 'selected' : ''}>Tier ${t}</option>`).join('')}</select></div>
      <div><label>Credit limit</label><input id="d_limit" type="number" value="${r.credit_limit}"></div>
      <div><label>Days to pay</label><input id="d_days" type="number" value="${r.terms_days}"></div>
      <div style="flex:0 0 auto"><button class="btn" id="d_terms">Save terms</button></div>
    </div>

    ${r.blocked || r.overdue ? `<h3 class="mt">Let this one through anyway</h3>
      <div class="row">
        <div style="flex:3"><label>Reason (kept on the record)</label><input id="d_note" type="text"></div>
        <div style="flex:0 0 auto"><button class="btn stop" id="d_override">Override</button></div>
      </div>` : ''}

    <h3 class="mt">Their picture</h3>
    <div class="dim">Shown on their card on the Customer order screen, so
      whoever is taking the order finds them by recognising them. A shopfront
      or a logo does the job as well as a face.</div>
    <div class="row mt" style="align-items:center">
      <div style="flex:0 0 auto">
        ${r.photo_at
          ? `<img class="face" src="/api/resellers/${id}/photo?v=${r.photo_at}" alt="">`
          : `<span class="face">${esc((r.name || '?').split(/\s+/).filter(Boolean)
               .slice(0, 2).map((w) => w[0]).join('').toUpperCase())}</span>`}
      </div>
      <div style="flex:2"><label>Choose a picture</label>
        <input id="d_photo" type="file" accept="image/jpeg,image/png,image/webp"></div>
      ${r.photo_at ? '<div style="flex:0 0 auto"><button class="btn line stop" id="d_photo_x">Remove</button></div>' : ''}
    </div>

    <h3 class="mt">For tax</h3>
    <div class="dim">The block printed at the top of this account's invoices,
      order forms and packing lists. Leave anything blank that they have not
      given you — a blank line prints blank, the same as the paper does.</div>
    <div class="row mt">
      <div><label>Tax Type</label>
        <input id="d_taxtype" type="text" list="taxtypes" value="${esc(r.tax_type || '')}">
        <datalist id="taxtypes"><option>VAT</option><option>Non-VAT</option></datalist></div>
      <div style="flex:2"><label>Business Trade Name</label>
        <input id="d_trade" type="text" value="${esc(r.trade_name || '')}"></div>
      <div style="flex:2"><label>Taxpayer Name</label>
        <input id="d_taxpayer" type="text" value="${esc(r.taxpayer_name || '')}"></div>
    </div>
    <div class="row">
      <div><label>TIN Number</label>
        <input id="d_tin" type="text" value="${esc(r.tin || '')}"></div>
      <div style="flex:3"><label>Business Address</label>
        <input id="d_addr" type="text" value="${esc(r.business_address || '')}"></div>
      <div style="flex:0 0 auto"><button class="btn" id="d_tax">Save</button></div>
    </div>

    <h3 class="mt">Sending it on</h3>
    <div class="dim">Some accounts buy to send straight on to somebody else,
      and their order forms carry that name beside their own. Off for
      everybody until it is turned on here, so the rest are not asked a
      question that has nothing to do with them.</div>
    <div class="row mt">
      <div style="flex:0 0 auto"><label class="dotkey" style="gap:8px">
        <input type="checkbox" id="d_ds" ${r.drop_ship ? 'checked' : ''}>
        This account ships on to somebody</label></div>
      <div style="flex:2"><label for="d_dsto">Usually to</label>
        <input id="d_dsto" type="text" value="${esc(r.drop_ship_to || '')}"
          placeholder="Their name, to fill the box by default"
          ${r.drop_ship ? '' : 'disabled'}></div>
      <div style="flex:0 0 auto; align-self:flex-end">
        <button class="btn quiet" id="d_dssave">Save</button></div>
    </div>

    <h3 class="mt">Papers</h3>
    ${r.documents.length
      ? `<div class="dim">${r.documents.map((d) =>
          `${esc(d.kind)}: ${esc(d.reference)} ${d.verified ? '✅' : '⏳'}`).join('<br>')}</div>`
      : '<div class="dim">Nothing on file.</div>'}
    <div class="row mt">
      <div><label>Kind</label><select id="d_kind">
        <option>business licence</option><option>tax paper</option><option>agreement</option>
      </select></div>
      <div style="flex:2"><label>Where it is</label>
        <input id="d_ref" type="text" placeholder="drive link or file name"></div>
      <div style="flex:0 0 auto"><button class="btn quiet" id="d_attach">Attach</button></div>
    </div>

    <h3 class="mt">Confirm the bank payment</h3>
    <div class="dim">A reseller settles in instalments, so there are five rows —
      fill in as many as have actually landed. Each is applied to whatever is
      open, oldest invoice first. Anything left once nothing is open becomes
      credit, held on the account and taken off their next invoice by itself.
      <b>Confirming is not receipting</b>: the receipt is issued separately,
      below, and one receipt covers every transfer confirmed since the last.</div>
    ${[0, 1, 2, 3, 4].map((n) => `
      <div class="row payrow">
        <div><label${n ? ' class="sr"' : ''}>Amount received</label>
          <input class="pay_amt" type="number" step="0.01" min="0.01"
                 placeholder="${n ? '' : '0.00'}"></div>
        <div><label${n ? ' class="sr"' : ''}>Received on</label>
          <input class="pay_on" type="date" value="${localDay()}"></div>
        <div><label${n ? ' class="sr"' : ''}>Through (MOP)</label>
          <input class="pay_mop" type="text" list="acct_banks"
                 placeholder="BANCO DE ORO (BDO)"></div>
        <div><label${n ? ' class="sr"' : ''}>Reference no.</label>
          <input class="pay_ref" type="text" placeholder="the bank's own reference"></div>
      </div>`).join('')}
    <datalist id="acct_banks">
      <option value="BANCO DE ORO (BDO)"></option>
      <option value="BPI"></option>
      <option value="SECURITY BANK"></option>
      <option value="GCASH"></option>
    </datalist>
    <div class="dim">The reference is the bank's, off their proof of payment — it
      is what they quote to say the money left, and what the statement is matched
      against later. It prints on the invoice.</div>
    <div class="mt right"><button class="btn" id="acct_pay">Confirm payments</button></div>
    <div id="acct_out" class="mt"></div>

    <h3 class="mt">Issue the receipt</h3>
    <div id="acct_pending"></div>

    <h3 class="mt">Invoices</h3>
    ${table(r.invoices, [
      { head: '#', cell: (i) => i.id },
      { head: 'Issued', cell: (i) => onDay(i.issued_on) },
      { head: 'Due', cell: (i) => onDay(i.due_on) },
      { head: 'Amount', n: true, cell: (i) => peso(i.amount) },
      { head: 'Still owed', n: true, cell: (i) => peso(i.balance) },
      { head: 'State', cell: (i) => i.status === 'paid' ? tag('paid', 'green')
          : i.status === 'void' ? tag('void', 'grey')
          : i.overdue ? tag('past due', 'red') : tag('open', 'amber') },
      { head: '', cell: (i) => `${i.status === 'open'
          ? `<button class="btn sm" data-pay="${i.id}" data-owed="${i.balance}"
                     data-order="${esc(i.order_id)}">Record payment</button>` : ''}
          <button class="btn sm quiet" data-invoice="${i.order_id}">🖨 Invoice</button>` },
    ], 'No invoices yet.')}

    <h3 class="mt">History</h3>
    <div class="dim">${r.events.slice(0, 10).map((e) =>
      `${when(e.at)} — <b>${esc(e.kind)}</b> ${esc(JSON.stringify(e.detail || {}))}`).join('<br>')
      || 'Nothing yet.'}</div>

    ${r.credits?.length ? `<h3 class="mt">Credit ledger</h3>
      <div class="dim">${r.credits.map((c) =>
        `${when(c.at)} — <b>${Number(c.amount) > 0 ? '+' : ''}${peso(c.amount)}</b>
          — ${esc(c.reason)}`).join('<br>')}</div>` : ''}`);

  $('#d_approve')?.addEventListener('click', async () => {
    try {
      await POST(`/api/resellers/${id}/approve`);
      notice('Approved 🌸', 'good');
      closeDialog();
      reload();
    } catch (e) { whoops(e); }
  });

  $('#d_photo')?.addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      // Shrunk in the browser first so a phone photograph is not carried
      // whole across the wire; the server shrinks it again, to the shape of
      // the card, which is the size that is actually stored.
      await POST(`/api/resellers/${id}/photo`, { dataUrl: await shrink(file, 900) });
      notice('Picture saved 🌸', 'good');
      closeDialog();
      reload();
    } catch (err) { whoops(err); }
    e.target.value = '';
  });

  $('#d_photo_x')?.addEventListener('click', async () => {
    try {
      await DELETE(`/api/resellers/${id}/photo`);
      notice('Picture removed', 'good');
      closeDialog();
      reload();
    } catch (err) { whoops(err); }
  });

  // The name box is only worth filling in when the switch is on.
  $('#d_ds')?.addEventListener('change', (e) => {
    $('#d_dsto').disabled = !e.target.checked;
    if (!e.target.checked) $('#d_dsto').value = '';
  });

  $('#d_dssave')?.addEventListener('click', async () => {
    try {
      const on = $('#d_ds').checked;
      await POST(`/api/resellers/${id}/dropship`, { on, to: $('#d_dsto').value.trim() });
      notice(on ? 'Their order forms will ask who it goes on to 🌸'
                : 'No longer shipping on', 'good');
      closeDialog();
      reload();
    } catch (e) { whoops(e); }
  });

  $('#d_tax').addEventListener('click', async () => {
    try {
      await POST(`/api/resellers/${id}/tax`, {
        tax_type: $('#d_taxtype').value, trade_name: $('#d_trade').value,
        taxpayer_name: $('#d_taxpayer').value, tin: $('#d_tin').value,
        business_address: $('#d_addr').value,
      });
      notice('Saved 🌸', 'good');
      closeDialog();
      reload();
    } catch (e) { whoops(e); }
  });

  $('#d_terms').addEventListener('click', async () => {
    try {
      await POST(`/api/resellers/${id}/terms`, {
        tier: +$('#d_tier').value, credit_limit: +$('#d_limit').value,
        terms_days: +$('#d_days').value,
      });
      notice('Terms saved', 'good');
      closeDialog();
      reload();
    } catch (e) { whoops(e); }
  });

  $('#d_override')?.addEventListener('click', async () => {
    try {
      await POST(`/api/resellers/${id}/override`, { note: $('#d_note').value });
      notice('Override recorded', 'good');
      closeDialog();
      reload();
    } catch (e) { whoops(e); }
  });

  $('#d_attach').addEventListener('click', async () => {
    try {
      await POST(`/api/resellers/${id}/documents`,
        { kind: $('#d_kind').value, reference: $('#d_ref').value });
      notice('Attached', 'good');
      openReseller(id, reload);
    } catch (e) { whoops(e); }
  });

  // What an OR would cover if one were asked for now. Drawn on opening and
  // again after every confirmation, because the answer is the whole reason
  // the two acts were separated.
  const drawPending = async () => {
    const box = $('#acct_pending');
    if (!box) return;
    try {
      const p = await GET(`/api/resellers/${id}/pending-receipt`);
      box.innerHTML = p.count ? `
        <div class="dim">${count(p.count)} payment${p.count > 1 ? 's' : ''} confirmed
          and not yet receipted, ${peso(p.amount)} in all.</div>
        <div class="mt">${p.lines.map((l) => `<div class="pick">
          <span class="nm"><b>${peso(l.amount)}</b> — invoice #${esc(String(l.invoice_id))}
            <br><span class="dim">${onDay(l.paid_on)}${
              l.method ? ' · ' + esc(l.method) : ''}${
              l.reference_no ? ' · ref ' + esc(l.reference_no) : ''}</span></span>
        </div>`).join('')}</div>
        <div class="mt right"><button class="btn go" id="acct_or">
          Issue receipt for ${peso(p.amount)}</button></div>`
        : '<div class="dim">Nothing confirmed is waiting for a receipt.</div>';

      $('#acct_or')?.addEventListener('click', async () => {
        $('#acct_or').disabled = true;
        try {
          const out = await POST(`/api/resellers/${id}/issue-or`, {});
          notice(`${out.receipt_no} issued 🌸`, 'good');
          // The list behind both of them is refreshed now rather than when
          // they are dismissed, so it is already right whenever that happens.
          reload();
          showOR(out, r, { amount: Number(out.amount) }, true);
        } catch (e) { whoops(e); $('#acct_or').disabled = false; }
      });
    } catch (e) { whoops(e); }
  };
  drawPending();

  // Confirming records the money and applies it. It puts no number on it —
  // that is the button below, and it is a separate decision on purpose: four
  // transfers against one invoice should leave the reseller holding one
  // receipt, not four.
  $('#acct_pay').addEventListener('click', async () => {
    const rows = $$('.payrow').map((row) => ({
      amount: +$('.pay_amt', row).value,
      paid_on: $('.pay_on', row).value,
      method: $('.pay_mop', row).value.trim() || null,
      reference_no: $('.pay_ref', row).value.trim() || null,
    })).filter((r) => r.amount > 0);

    if (!rows.length) return whoops(new Error('Type how much came in.'));
    $('#acct_pay').disabled = true;
    try {
      const out = await POST(`/api/resellers/${id}/confirm`, { payments: rows });
      const said = out.confirmed.flatMap((c) => (c.applied || []).map((a) =>
        `Invoice #${a.invoice_id}: ${peso(a.applied)} applied` +
        (a.now_owes > 0 ? `, ${peso(a.now_owes)} still owed` : ', now settled')));
      const credited = out.confirmed.reduce((t, c) => t + Number(c.credited || 0), 0);
      if (credited > 0) said.push(`${peso(credited)} left over — held as credit.`);
      $('#acct_out').innerHTML = said.length
        ? `<div class="banner good">${said.join('<br>')}</div>`
        : '<div class="dim">Nothing was open to apply this to — it is all credit now.</div>';
      notice(`${count(rows.length)} payment${rows.length > 1 ? 's' : ''} confirmed 🌸`, 'good');
      $$('.payrow').forEach((row) => {
        $('.pay_amt', row).value = '';
        $('.pay_ref', row).value = '';
      });
      drawPending();
    } catch (e) { whoops(e); } finally {
      $('#acct_pay').disabled = false;
    }
  });

  // Recording against ONE invoice, in as many pieces as it actually arrived in.
  //
  // The account-level confirm above takes the same five rows but applies them
  // oldest-invoice-first, which is right when somebody has sent money and not
  // said what for. This is the other case: the bill is on the screen, whoever
  // is looking at it knows the money is for that bill, and the five rows are
  // there so the breakdown — BDO, then BPI, then GCash — survives into the
  // ledger and onto the invoice, instead of one anonymous lump nobody can
  // trace back to a bank statement.
  $$('[data-pay]').forEach((b) => b.addEventListener('click', () => {
    const owed = Number(b.dataset.owed);
    const invoiceNo = b.dataset.pay;
    const orderNo = b.dataset.order;
    dialog(`
      <h3>Record a payment — invoice #${esc(invoiceNo)}</h3>
      <div class="dim">${orderNo && orderNo !== invoiceNo
        ? `Sales order no. ${esc(orderNo)} · ` : ''}<b>${peso(owed)}</b> still on it.
        All five rows go against this invoice and no other, so fill in as many
        as it actually arrived in — a BDO transfer, a BPI transfer and GCash is
        three rows, not one. <b>Confirming is not receipting</b>: the receipt is
        issued from the account above, and one covers every transfer confirmed
        since the last.</div>
      ${[0, 1, 2, 3, 4].map((n) => `
        <div class="row payrow">
          <div><label${n ? ' class="sr"' : ''}>Amount received</label>
            <input class="ip_amt" type="number" step="0.01" min="0.01"
                   placeholder="${n ? '' : '0.00'}"${n ? '' : ` value="${owed}"`}></div>
          <div><label${n ? ' class="sr"' : ''}>Received on</label>
            <input class="ip_on" type="date" value="${localDay()}"></div>
          <div><label${n ? ' class="sr"' : ''}>Through (MOP)</label>
            <input class="ip_mop" type="text" list="inv_banks"
                   placeholder="BANCO DE ORO (BDO)"></div>
          <div><label${n ? ' class="sr"' : ''}>Reference no.</label>
            <input class="ip_ref" type="text" placeholder="the bank's own reference"></div>
        </div>`).join('')}
      <datalist id="inv_banks">
        <option value="BANCO DE ORO (BDO)"></option>
        <option value="BPI"></option>
        <option value="SECURITY BANK"></option>
        <option value="GCASH"></option>
      </datalist>
      <div class="dim">Paying a 30-day invoice within 10 days takes 2% off by
        itself. Clearing the last past-due invoice lets the account order again.
        The reference is the bank's own — what they quote to say the money left,
        and what the statement is matched against later. It prints on the invoice.</div>
      <div class="row mt"><div class="dim" id="ip_sum"></div></div>
      <div class="mt right"><button class="btn" id="p_save">Record</button></div>`, 'wide');

    // Running total against what is left, because five boxes of pesos is
    // exactly where a nought goes astray, and the message afterwards is a
    // worse place to find out than the moment it is typed.
    const retotal = () => {
      const taken = $$('.ip_amt').reduce((n, el) => n + (+el.value || 0), 0);
      const over = taken > owed + 0.005;
      $('#ip_sum').innerHTML = taken
        ? `${peso(taken)} of ${peso(owed)}${over
            ? ' — <b class="over">more than this invoice owes</b>'
            : taken >= owed - 0.005 ? ' — settles it' : `, leaving ${peso(owed - taken)}`}`
        : '';
      $('#p_save').disabled = over;
    };
    $$('.ip_amt').forEach((el) => el.addEventListener('input', retotal));
    retotal();

    $('#p_save').addEventListener('click', async () => {
      const payments = $$('.payrow').map((row) => ({
        amount: $('.ip_amt', row).value,
        paid_on: $('.ip_on', row).value,
        method: $('.ip_mop', row).value.trim() || null,
        reference_no: $('.ip_ref', row).value.trim() || null,
      })).filter((p) => Number(p.amount) > 0);
      if (!payments.length) return notice('How much actually landed?', 'bad');
      $('#p_save').disabled = true;
      try {
        const out = await POST(`/api/invoices/${invoiceNo}/payments`, { payments });
        notice(out.status === 'paid'
          ? `Invoice #${out.invoice_id} settled 🌸`
          : `${peso(out.taken)} recorded — ${peso(out.balance)} left on #${out.invoice_id}`,
          'good');
        openReseller(id, reload);
      } catch (e) { whoops(e); $('#p_save').disabled = false; }
    });
  }));

  // The record of what an order actually looked like on paper — the same
  // view a chat order shows the moment it is placed, reachable again later
  // from the account it belongs to, not just the one screen that made it.
  // Reopened from the account rather than from the moment it was placed, so
  // the money side is known by now: this is the INVOICE, with what the account
  // has already paid filled in against it.
  $$('[data-invoice]').forEach((b) => b.addEventListener('click', async () => {
    try {
      const may = user?.role === 'admin' || user?.role === 'office';
      // The catalogue only matters while quantities can still move, so it is
      // fetched only then — and a sheet whose catalogue did not arrive is
      // still a sheet somebody can read, correct the prices on, and print.
      const [o, payments] = await Promise.all([
        GET(`/api/orders/${b.dataset.invoice}`),
        GET(`/api/resellers/${id}/payments?order_id=${b.dataset.invoice}`).catch(() => []),
      ]);
      const catalog = may && ['placed', 'picking'].includes(o.status)
        ? await GET('/api/wholesale/catalog').catch(() => null) : null;
      showInvoiceDoc({
        over: true,
        orderId: o.id, issuedOn: o.placed_at, resellerName: o.reseller, payments, who: o,
        invoiceNo: o.si_no, status: o.status, catalog, resellerId: o.reseller_id,
        shipping: Number(o.shipping || 0), others: Number(o.others || 0),
        canEdit: may,
        onSaved: () => openReseller(id, reload),
        lines: o.lines.map((l) => ({ id: l.id, sku: l.sku, name: l.name, qty: l.qty,
          price: l.unit_price, code: l.price_code, unit: l.unit_type })),
      });
    } catch (e) { whoops(e); }
  }));
}

// ===========================================================================
// Returns queue (owner decides)
// ===========================================================================
SCREENS.returns = async (page) => {
  page.innerHTML = `
    <div class="head"><h2>Returns</h2>
      <span class="hint">Nothing moves until you decide</span></div>
    <div class="panel" id="queue"></div>`;

  const load = async () => {
    const rows = await GET('/api/returns');
    $('#queue', page).innerHTML = table(rows, [
      { head: 'Receipt', cell: (r) => `<span class="dim">${esc(r.receipt_no)}</span>` },
      { head: 'Product', cell: (r) => esc(r.name) },
      { head: 'Batch', cell: (r) => `<span class="dim">${esc(r.batch_no)}</span>` },
      { head: 'Qty', n: true, cell: (r) => r.qty },
      { head: 'Why', cell: (r) => esc(r.reason) },
      { head: 'By', cell: (r) => `<span class="dim">${esc(r.raised_by)}</span>` },
      { head: 'State', cell: (r) => r.status === 'pending' ? tag('waiting', 'amber')
          : r.status === 'approved' ? tag(r.outcome, 'green') : tag('turned down', 'grey') },
      { head: '', cell: (r) => r.status !== 'pending' ? '' : `
          <button class="btn sm go" data-do="${r.id}|restock">Back on shelf</button>
          <button class="btn sm quiet" data-do="${r.id}|damaged">Damaged</button>
          <button class="btn sm quiet" data-do="${r.id}|tester">Make tester</button>
          <button class="btn sm stop" data-no="${r.id}">Turn down</button>` },
    ], 'No returns waiting 🌸');

    $$('[data-do]', page).forEach((b) => b.addEventListener('click', async () => {
      const [id, outcome] = b.dataset.do.split('|');
      try {
        await POST(`/api/returns/${id}/decide`, { approve: true, outcome });
        notice(`Recorded as ${outcome}`, 'good');
        load();
      } catch (e) { whoops(e); }
    }));
    $$('[data-no]', page).forEach((b) => b.addEventListener('click', async () => {
      try {
        await POST(`/api/returns/${b.dataset.no}/decide`, { approve: false });
        notice('Turned down', 'good');
        load();
      } catch (e) { whoops(e); }
    }));
  };
  await load();
  repeat(load);
};

// ===========================================================================
// Reordering
// ===========================================================================
SCREENS.reorder = async (page) => {
  page.innerHTML = `
    <div class="head"><h2>Reordering</h2>
      <span class="hint">Lead time means door to door — shipping, customs and FDA</span></div>
    <div class="panel" id="list"></div>`;

  const load = async () => {
    const rows = await GET('/api/reorder');
    $('#list', page).innerHTML = table(rows, [
      { head: 'Product', cell: (r) => `<b>${esc(r.name)}</b>`
          + (r.abc_class ? ' ' + tag(r.abc_class, 'pink') : '') },
      { head: 'Sells/day', n: true, cell: (r) => r.avg_daily ?? '—' },
      { head: 'Busiest day', n: true, cell: (r) => r.max_daily ?? '—' },
      { head: 'Usual wait', n: true, cell: (r) => r.avg_lead_days ?? '—' },
      { head: 'Worst wait', n: true, cell: (r) => r.max_lead_days ?? '—' },
      { head: 'Buffer', n: true, cell: (r) => r.safety_stock == null ? '—' : count(r.safety_stock) },
      { head: 'Reorder at', n: true, cell: (r) => r.reorder_at == null ? '—' : `<b>${count(r.reorder_at)}</b>` },
      { head: 'In stock', n: true, cell: (r) => r.in_stock == null ? '' : count(r.in_stock) },
      { head: 'Now what', cell: (r) => r.short_by != null
          ? tag(`order ${count(Math.round(r.suggested_order))}`, 'red')
          : r.reorder_at != null ? tag('fine', 'green') : tag('not set', 'grey') },
      { head: '', cell: (r) => `<button class="btn sm quiet" data-set="${esc(r.sku)}">Set</button>`
          + (r.reorder_at != null
              ? ` <button class="btn sm line" data-recalc="${esc(r.sku)}">↻ From sales</button>` : '') },
    ], 'No products yet.');

    $$('[data-set]', page).forEach((b) => b.addEventListener('click', () => {
      const r = rows.find((x) => x.sku === b.dataset.set);
      dialog(`
        <h3>${esc(r.name)}</h3>
        <div class="row">
          <div><label>Sells per day (usual)</label>
            <input id="o_avg" type="number" step="0.1" value="${r.avg_daily ?? ''}"></div>
          <div><label>Sells per day (busiest)</label>
            <input id="o_max" type="number" step="0.1" value="${r.max_daily ?? ''}"></div>
        </div>
        <div class="row">
          <div><label>Usual wait (days)</label>
            <input id="o_al" type="number" value="${r.avg_lead_days ?? ''}"></div>
          <div><label>Worst wait (days)</label>
            <input id="o_ml" type="number" value="${r.max_lead_days ?? ''}"></div>
          <div><label>Months to cover</label>
            <input id="o_mc" type="number" value="${r.months_cover ?? 3}"></div>
        </div>
        <div class="dim mt">Buffer = busiest × worst wait − usual × usual wait.<br>
          Reorder at = usual × usual wait + buffer.</div>
        <div class="mt right"><button class="btn" id="o_save">Work it out</button></div>`);
      $('#o_save').addEventListener('click', async () => {
        try {
          const out = await POST(`/api/reorder/${encodeURIComponent(r.sku)}`, {
            avg_daily: +$('#o_avg').value, max_daily: +$('#o_max').value,
            avg_lead: +$('#o_al').value, max_lead: +$('#o_ml').value,
            months_cover: +$('#o_mc').value,
          });
          notice(`Buffer ${count(out.safety_stock)}, reorder at ${count(out.reorder_at)}`, 'good');
          closeDialog();
          load();
        } catch (e) { whoops(e); }
      });
    }));

    $$('[data-recalc]', page).forEach((b) => b.addEventListener('click', async () => {
      try {
        const out = await POST(`/api/reorder/${encodeURIComponent(b.dataset.recalc)}/recalc`);
        notice(`From the last 90 days: ${out.avg_daily}/day → reorder at ${count(out.reorder_at)}`, 'good');
        load();
      } catch (e) { whoops(e); }
    }));
  };
  await load();
};

// ===========================================================================
// Stockroom — moving, counting, writing off
// ===========================================================================
SCREENS.stockroom = async (page) => {
  const shops = await branches();
  const elsewhere = (here) => shops.filter((b) => String(b.id) !== String(here));

  page.innerHTML = `
    <div class="head"><h2>Stockroom</h2>
      ${shops.length > 1 ? '<span class="hint">Everything here is one shop\'s stock</span>' : ''}
    </div>
    ${shops.length > 1 ? `<div class="tools">${
      branchPicker(shops, 's_branch', 'Working at')}</div>` : ''}
    <div class="split">
      <div class="panel"><h3>🔀 Move stock between pools</h3>
        <div class="row">
          <div style="flex:2"><label>Product code</label><input id="m_sku" type="text" list="skus2"></div>
          <div style="flex:0 0 auto"><button class="btn quiet" id="m_find">Find batches</button></div>
        </div>
        <datalist id="skus2"></datalist>
        <div id="m_out" class="mt"></div>
      </div>
      <div class="panel"><h3>🔢 Count the shelf</h3>
        <div class="row">
          <div style="flex:2"><label>Product code</label><input id="c_sku" type="text" list="skus2"></div>
          <div><label>You counted</label><input id="c_qty" type="number" min="0"></div>
          <div style="flex:0 0 auto"><button class="btn" id="c_go">Record</button></div>
        </div>
        <div id="c_out" class="mt"></div>
        <div class="mt" id="c_hist"></div>
      </div>
    </div>
    <div class="panel"><h3>☠️ Expired stock</h3><div id="x_out"></div></div>
    <div class="panel"><h3>🛎️ Shelf tasks</h3><div id="t_out"></div></div>`;

  GET('/api/products?q=').then((rows) => {
    $('#skus2', page).innerHTML = rows.map((p) =>
      `<option value="${esc(p.sku)}">${esc(p.name)}</option>`).join('');
  }).catch(() => {});

  const label = { b2b: 'Wholesale', shop: 'Shop', reserve: 'Reserve' };
  const findBatches = async () => {
    const sku = $('#m_sku', page).value.trim();
    if (!sku) return;
    const here = branchOf(page, 's_branch');
    const rows = await GET(`/api/products/${encodeURIComponent(sku)}/batches`
      + (here ? `?branch=${here}` : ''));
    $('#m_out', page).innerHTML = rows.length ? rows.map((b) => `
      <div class="tile mt"><b>${esc(b.batch_no)}</b>
        <span class="dim">expires ${onDay(b.expiry)} — wholesale ${b.free_b2b},
          shop ${b.free_shop}, reserve ${b.free_reserve}</span>
        <div class="row mt">
          <div><label>From</label><select id="mf_${b.batch_id}">
            <option value="reserve">Reserve</option><option value="b2b">Wholesale</option>
            <option value="shop">Shop</option></select></div>
          <div><label>To</label><select id="mt_${b.batch_id}">
            <option value="shop">Shop</option><option value="b2b">Wholesale</option>
            <option value="reserve">Reserve</option></select></div>
          <div><label>How many</label><input id="mq_${b.batch_id}" type="number" min="1"></div>
          <div style="flex:0 0 auto"><button class="btn sm" data-move="${b.batch_id}">Move</button></div>
        </div>
        ${elsewhere(here).length ? `
          <div class="row mt" style="border-top:1px dashed var(--rose-soft);padding-top:10px">
            <div><label>Send to</label><select id="tb_${b.batch_id}">${
              elsewhere(here).map((x) => `<option value="${x.id}">${esc(x.name)}</option>`)
                .join('')}</select></div>
            <div><label>From pool</label><select id="tp_${b.batch_id}">
              <option value="shop">Shop</option><option value="b2b">Wholesale</option>
              <option value="reserve">Reserve</option></select></div>
            <div><label>How many</label>
              <input id="tq_${b.batch_id}" type="number" min="1"></div>
            <div style="flex:0 0 auto"><button class="btn sm line"
              data-send="${b.batch_id}">🚚 Send</button></div>
          </div>` : `
          <div class="dim mt" style="border-top:1px dashed var(--rose-soft);padding-top:10px">
            Sending stock to another shop needs a second shop. Add one under
            <b>Branches</b> and a <b>🚚 Send</b> row appears here.</div>`}
        </div>`).join('') : '<div class="none">Nothing received for that code.</div>';

    $$('[data-move]', page).forEach((btn) => btn.addEventListener('click', async () => {
      const id = btn.dataset.move;
      try {
        await POST('/api/move', {
          batchId: +id, from: $(`#mf_${id}`).value, to: $(`#mt_${id}`).value,
          qty: +$(`#mq_${id}`).value, branch_id: branchOf(page, 's_branch'),
        });
        notice('Stock moved 🌸', 'good');
        findBatches();
      } catch (e) { whoops(e); }
    }));
    // Sending stock to another shop. The pool does not change: what was on the
    // shelf here is on the shelf there.
    $$('[data-send]', page).forEach((btn) => btn.addEventListener('click', async () => {
      const id = btn.dataset.send;
      try {
        await POST('/api/transfer', {
          batchId: +id, pool: $(`#tp_${id}`).value,
          from_branch: branchOf(page, 's_branch') || shops[0].id,
          to_branch: $(`#tb_${id}`).value, qty: +$(`#tq_${id}`).value,
        });
        notice('Sent 🚚', 'good');
        findBatches();
      } catch (e) { whoops(e); }
    }));
  };
  $('#m_find', page).addEventListener('click', () => findBatches().catch(whoops));
  wireBranchPicker(page, 's_branch', () => findBatches().catch(() => {}));

  const counts = async () => {
    const rows = await GET('/api/stock-counts');
    $('#c_hist', page).innerHTML = table(rows.slice(0, 8), [
      { head: 'Product', cell: (c) => esc(c.name) },
      { head: 'Counted', n: true, cell: (c) => count(c.counted) },
      { head: 'System', n: true, cell: (c) => count(c.on_system) },
      { head: 'Difference', n: true, cell: (c) => c.variance === 0
          ? tag('spot on', 'green') : tag(`${c.variance > 0 ? '+' : ''}${c.variance}`, 'red') },
      { head: 'When', cell: (c) => when(c.at) },
    ], '');
  };
  $('#c_go', page).addEventListener('click', async () => {
    try {
      const r = await POST('/api/stock-count',
        { sku: $('#c_sku', page).value.trim(), counted: +$('#c_qty', page).value,
          branch_id: branchOf(page, 's_branch') });
      $('#c_out', page).innerHTML = `<div class="banner ${r.variance === 0 ? 'good' : 'warn'}">
        Counted ${r.counted}, system says ${r.on_system} — difference <b>${r.variance}</b>.
        ${r.variance === 0 ? 'Spot on 🌸' : 'Noted for the owner to look at.'}</div>`;
      counts();
    } catch (e) { whoops(e); }
  });

  const expired = async () => {
    const rows = await GET('/api/expired');
    $('#x_out', page).innerHTML = table(rows, [
      { head: 'Product', cell: (x) => esc(x.name) },
      { head: 'Batch', cell: (x) => esc(x.batch_no) },
      { head: 'Expired', cell: (x) => onDay(x.expiry) },
      { head: 'Pool', cell: (x) => `<span class="dim">${esc(label[x.pool] || x.pool)}</span>` },
      { head: 'Qty', n: true, cell: (x) => count(x.qty) },
      { head: '', cell: (x) => `<button class="btn sm stop" data-off="${x.batch_id}">Write off</button>` },
    ], 'No expired stock 🌸');

    $$('[data-off]', page).forEach((b) => b.addEventListener('click', async () => {
      try {
        const r = await POST('/api/expired/write-off', { batchId: +b.dataset.off });
        notice(`${r.units} unit(s) written off`, 'good');
        expired();
      } catch (e) { whoops(e); }
    }));
  };

  const tasks = async () => {
    const rows = await GET('/api/restock');
    $('#t_out', page).innerHTML = table(rows, [
      { head: 'Product', cell: (t) => `<b>${esc(t.name)}</b> <span class="dim">${esc(t.sku)}</span>` },
      { head: 'Why', cell: (t) => `<span class="dim">${esc(t.note || '')}</span>` },
      { head: 'State', cell: (t) => t.status === 'open' ? tag('to do', 'amber') : tag('done', 'green') },
      { head: 'Raised', cell: (t) => when(t.raised_at) },
      { head: '', cell: (t) => t.status === 'open'
          ? `<button class="btn sm go" data-done="${t.id}">Done</button>` : '' },
    ], 'Nothing to bring out 🌸');

    $$('[data-done]', page).forEach((b) => b.addEventListener('click', async () => {
      try {
        await POST(`/api/restock/${b.dataset.done}/done`);
        notice('Done 🌸', 'good');
        tasks();
      } catch (e) { whoops(e); }
    }));
  };

  await Promise.all([counts(), expired(), tasks()]);
  repeat(async () => { await expired(); await tasks(); }, 15000);
};

SCREENS.restock = async (page) => {
  page.innerHTML = `
    <div class="head"><h2>Shelf tasks</h2>
      <span class="hint">Bring stock from the back to the shop floor</span></div>
    <div class="panel" id="list"></div>`;
  const load = async () => {
    const rows = await GET('/api/restock');
    $('#list', page).innerHTML = table(rows, [
      { head: 'Product', cell: (t) => `<b>${esc(t.name)}</b> <span class="dim">${esc(t.sku)}</span>` },
      { head: 'Why', cell: (t) => `<span class="dim">${esc(t.note || '')}</span>` },
      { head: 'State', cell: (t) => t.status === 'open' ? tag('to do', 'amber') : tag('done', 'green') },
      { head: 'Raised', cell: (t) => when(t.raised_at) },
      { head: '', cell: (t) => t.status === 'open'
          ? `<button class="btn sm go" data-done="${t.id}">Done</button>` : '' },
    ], 'Nothing to bring out 🌸');
    $$('[data-done]', page).forEach((b) => b.addEventListener('click', async () => {
      try {
        await POST(`/api/restock/${b.dataset.done}/done`);
        notice('Done 🌸', 'good');
        load();
      } catch (e) { whoops(e); }
    }));
  };
  await load();
  repeat(load);
};

// ===========================================================================
// Reports
// ===========================================================================
SCREENS.reports = async (page) => {
  const today = localDay();
  const monthAgo = localDay(30);

  page.innerHTML = `
    <div class="head"><h2>Reports</h2></div>
    <div class="tools">
      <button class="btn sm" data-r="sales">Sales</button>
      <button class="btn sm quiet" data-r="valuation">What stock is worth</button>
      <button class="btn sm quiet" data-r="ageing">Near expiry</button>
      <button class="btn sm quiet" data-r="receivables">Who owes what</button>
      <button class="btn sm quiet" data-r="journal">Stock movements</button>
    </div>
    <div id="report"></div>`;

  const out = $('#report', page);
  const reports = {
    sales: async () => {
      out.innerHTML = `<div class="tools">
          <input type="date" id="s_from" value="${monthAgo}">
          <input type="date" id="s_to" value="${today}">
          <button class="btn sm" id="s_go">Show</button></div><div id="s_out"></div>`;
      const run = async () => {
        const d = await GET(`/api/reports/sales?from=${$('#s_from').value}&to=${$('#s_to').value}`);
        const name = { b2b: 'Wholesale', shop: 'Shop' };
        $('#s_out').innerHTML = `
          <div class="tiles">${d.byChannel.map((c) => `<div class="tile">
            <div class="big">${peso(c.revenue)}</div>
            <div class="label">${esc(name[c.channel] || c.channel)} — ${c.orders} order(s)</div>
            </div>`).join('') || '<div class="none">Nothing sold in that period.</div>'}</div>
          <div class="panel"><h3>By product</h3>${table(d.byProduct, [
            { head: 'Product', cell: (p) => esc(p.name) },
            { head: 'Units', n: true, cell: (p) => count(p.units) },
            { head: 'Value', n: true, cell: (p) => peso(p.revenue) },
          ], 'Nothing sold.')}</div>
          <div class="panel"><h3>Day by day</h3>${table(d.byDay, [
            { head: 'Day', cell: (x) => onDay(x.day) },
            { head: 'Where', cell: (x) => esc(name[x.channel] || x.channel) },
            { head: 'Value', n: true, cell: (x) => peso(x.revenue) },
          ], 'Nothing sold.')}</div>`;
      };
      $('#s_go').addEventListener('click', () => run().catch(whoops));
      await run();
    },
    valuation: async () => {
      const rows = await GET('/api/reports/valuation');
      const total = rows.reduce((s, r) => s + Number(r.value_at_cost), 0);
      out.innerHTML = `
        <div class="tiles"><div class="tile good"><div class="big">${peso(total)}</div>
          <div class="label">What the unexpired stock cost us</div></div></div>
        <div class="panel">${table(rows, [
          { head: 'Product', cell: (r) => esc(r.name) },
          { head: 'Units', n: true, cell: (r) => count(r.units) },
          { head: 'Each', n: true, cell: (r) => peso(r.unit_cost) },
          { head: 'Value', n: true, cell: (r) => peso(r.value_at_cost) },
        ], 'No stock.')}</div>`;
    },
    ageing: async () => {
      const rows = await GET('/api/reports/ageing');
      out.innerHTML = `<div class="panel">${table(rows, [
        { head: 'Product', cell: (a) => esc(a.name) },
        { head: 'Batch', cell: (a) => esc(a.batch_no) },
        { head: 'Expires', cell: (a) => onDay(a.expiry) },
        { head: 'Days left', n: true, cell: (a) => a.days_left },
        { head: 'Qty', n: true, cell: (a) => count(a.qty) },
        { head: 'Value', n: true, cell: (a) => peso(a.value_at_risk) },
        { head: 'Sell where', cell: (a) => a.shop_only ? tag('shop only', 'red') : tag('anywhere', 'green') },
      ], 'Nothing within six months of expiry 🌸')}</div>`;
    },
    receivables: async () => {
      const d = await GET('/api/reports/receivables');
      out.innerHTML = `
        <div class="panel"><h3>How old the debts are</h3>${table(d.ageing, [
          { head: 'Reseller', cell: (a) => esc(a.name) },
          { head: 'Tier', cell: (a) => tierTag(a.tier) },
          { head: 'Not yet due', n: true, cell: (a) => peso(a.not_yet_due) },
          { head: '1–30 days', n: true, cell: (a) => peso(a.overdue_1_30) },
          { head: '31–60', n: true, cell: (a) => peso(a.overdue_31_60) },
          { head: '60+', n: true, cell: (a) => peso(a.overdue_60_plus) },
          { head: 'Total', n: true, cell: (a) => `<b>${peso(a.total_owed)}</b>` },
        ], 'Nobody owes anything 🌸')}</div>
        <div class="panel"><h3>How much rests on one account</h3>${table(d.concentration, [
          { head: 'Reseller', cell: (c) => esc(c.name) },
          { head: 'Owes', n: true, cell: (c) => peso(c.owed) },
          { head: 'Share', n: true, cell: (c) => `${(c.share * 100).toFixed(1)}%` },
          { head: '', cell: (c) => c.flagged ? tag('over 15%', 'red') : '' },
        ], 'Nothing outstanding.')}</div>
        <div class="panel"><h3>Money held as credit</h3>
          <div class="dim">Paid ahead of what they owed, with nothing open to put it
            against at the time. It comes off their next invoice by itself.</div>
          ${table(d.credit, [
            { head: 'Reseller', cell: (c) => esc(c.name) },
            { head: 'Tier', cell: (c) => tierTag(c.tier) },
            { head: 'Held', n: true, cell: (c) => `<b>${peso(c.credit)}</b>` },
          ], 'Nobody is holding a credit right now.')}</div>`;
    },
    journal: async () => {
      out.innerHTML = `<div class="tools">
        <input type="search" id="j_q" placeholder="Filter by product or reason…"></div>
        <div class="panel" id="j_out"></div>`;
      const run = async () => {
        const rows = await GET(`/api/reports/journal?q=${encodeURIComponent($('#j_q').value || '')}`);
        $('#j_out').innerHTML = table(rows, [
          { head: 'When', cell: (m) => when(m.at) },
          { head: 'Product', cell: (m) => esc(m.name) },
          { head: 'Batch', cell: (m) => `<span class="dim">${esc(m.batch_no)}</span>` },
          { head: 'From', cell: (m) => esc(m.from_pool || '·') },
          { head: 'To', cell: (m) => esc(m.to_pool || 'out') },
          { head: 'Qty', n: true, cell: (m) => count(m.qty) },
          { head: 'Why', cell: (m) => `<span class="dim">${esc(m.reason)}</span>` },
          { head: 'Who', cell: (m) => `<span class="dim">${esc(m.actor)}</span>` },
        ], 'Nothing matches.');
      };
      $('#j_q').addEventListener('input', () => run().catch(whoops));
      await run();
    },
  };

  $$('[data-r]', page).forEach((b) => b.addEventListener('click', () => {
    $$('[data-r]', page).forEach((x) => x.classList.add('quiet'));
    b.classList.remove('quiet');
    reports[b.dataset.r]().catch(whoops);
  }));
  await reports.sales();
};

// ===========================================================================
// Sign-ins
// ===========================================================================
SCREENS.people = async (page) => {
  const [users, resellers, shops] = await Promise.all([
    GET('/api/users'), GET('/api/resellers'), branches()]);
  page.innerHTML = `
    <div class="head"><h2>Sign-ins</h2>
      <span class="hint">Switching someone off ends their session straight away</span></div>
    <div class="panel"><h3>Add a sign-in</h3>
      <div class="row">
        <div><label>Username</label><input id="u_name" type="text"></div>
        <div><label>Display name</label><input id="u_disp" type="text"></div>
        <div><label>Password</label><input id="u_pass" type="password"></div>
        <div><label>Can do</label><select id="u_role">
          <option value="admin">Everything (admin)</option>
          <option value="warehouse">Warehouse</option>
          <option value="cashier">Cashier (the till)</option>
          <option value="supervisor">Supervisor (the till and the stockroom)</option>
          <option value="office">Office (the till and the stockroom)</option>
          <option value="timekeeper">Timekeeper (a door tablet — the clock only)</option>
          <option value="employee">Staff (their own record and nothing else)</option>
          <option value="reseller">Reseller (their own portal)</option></select></div>
        <div id="u_link" style="display:none"><label>Which reseller</label>
          ${resellers.length
            ? `<select id="u_res">${resellers.map((r) =>
                `<option value="${r.id}">${esc(r.name)}</option>`).join('')}</select>`
            : `<div class="banner warn">No resellers yet. Add the company under
                 <b>Resellers</b> first — a portal sign-in has to belong to one.</div>`}
        </div>
        <div style="flex:0 0 auto"><button class="btn" id="u_go">Create</button></div>
      </div>
      <div class="dim mt">At least 8 characters for the password.</div>
    </div>
    <div class="panel" id="u_list"></div>`;

  $('#u_role', page).addEventListener('change', (e) => {
    $('#u_link', page).style.display = e.target.value === 'reseller' ? '' : 'none';
  });

  const draw = (rows) => {
    $('#u_list', page).innerHTML = table(rows, [
      { head: 'Username', cell: (u) => `<b>${esc(u.username)}</b>` },
      { head: 'Name', cell: (u) => esc(u.display_name) },
      { head: 'Can do', cell: (u) => tag(roleName(u.role), 'pink') },
      { head: 'Reseller', cell: (u) => esc(u.reseller || '—') },
      { head: 'Works at', cell: (u) => (u.role === 'reseller'
          ? '<span class="dim">—</span>'
          : `<select class="sm" data-branch="${u.id}">
              <option value="">Every branch</option>
              ${shops.map((b) => `<option value="${b.id}"${
                String(b.id) === String(u.branch_id) ? ' selected' : ''
              }>${esc(b.name)}</option>`).join('')}
             </select>`) },
      { head: 'State', cell: (u) => u.active ? tag('active', 'green') : tag('switched off', 'grey') },
      { head: '', cell: (u) => `
          <button class="btn sm quiet" data-flip="${u.id}" data-to="${u.active ? 0 : 1}">
            ${u.active ? 'Switch off' : 'Switch on'}</button>
          <button class="btn sm quiet" data-ren="${u.id}"
            data-user="${esc(u.username)}" data-disp="${esc(u.display_name)}">Rename</button>
          <button class="btn sm line" data-pw="${u.id}">New password</button>
          <button class="btn sm quiet" data-out="${u.id}"
            data-who="${esc(u.display_name)}">Sign out everywhere</button>
          <button class="btn sm warn" data-del="${u.id}"
            data-who="${esc(u.username)}">Remove</button>` },
    ], 'No sign-ins yet.');

    // Tying someone to a shop is not cosmetic: their screens stop asking which
    // branch, and the database refuses to act on any other.
    $$('[data-branch]', page).forEach((sel) => sel.addEventListener('change', async () => {
      try {
        await POST(`/api/users/${sel.dataset.branch}/branch`, { branch_id: sel.value || null });
        notice(sel.value
          ? `Now works at ${sel.selectedOptions[0].textContent}`
          : 'Covers every branch', 'good');
      } catch (e) { whoops(e); draw(await GET('/api/users')); }
    }));

    // How the tablet by the door gets signed out: it has no button of its own,
    // so this ends every session that sign-in has open, wherever they are.
    $$('[data-out]', page).forEach((b) => b.addEventListener('click', () => {
      dialog(`
        <h3>Sign out everywhere?</h3>
        <div class="dim">Every device signed in as <b>${esc(b.dataset.who)}</b> stops
          working at once — the shop tablet, a phone, a laptop left open at home.
          Nothing is lost; they sign in again with the same password.</div>
        <div class="row mt">
          <button class="btn stop" id="so_go">Sign them out</button>
          <button class="btn quiet" id="so_no">Cancel</button></div>`);
      $('#so_no').addEventListener('click', closeDialog);
      $('#so_go').addEventListener('click', async () => {
        try {
          const r = await POST(`/api/users/${b.dataset.out}/sign-out-everywhere`);
          closeDialog();
          notice(`${r.signedOut} signed out everywhere 🌸`, 'good');
        } catch (e) { whoops(e); }
      });
    }));

    $$('[data-ren]', page).forEach((b) => b.addEventListener('click', () => {
      dialog(`
        <h3>Rename this sign-in</h3>
        <div class="dim">The password does not change. Whoever uses this account
          carries on with the one they have — only what they type in the
          username box is different.</div>
        <div class="row mt">
          <div><label>Username</label>
            <input id="rn_user" type="text" value="${esc(b.dataset.user)}"></div>
          <div><label>Display name</label>
            <input id="rn_disp" type="text" value="${esc(b.dataset.disp)}"></div>
        </div>
        <div class="row mt">
          <button class="btn" id="rn_go">Save</button>
          <button class="btn quiet" id="rn_no">Cancel</button></div>`);
      $('#rn_no').addEventListener('click', closeDialog);
      $('#rn_go').addEventListener('click', async () => {
        try {
          await PUT(`/api/users/${b.dataset.ren}`, {
            username: $('#rn_user').value.trim(),
            display_name: $('#rn_disp').value.trim(),
          });
          closeDialog();
          notice('Renamed 🌸', 'good');
          draw(await GET('/api/users'));
        } catch (e) { whoops(e); }
      });
    }));

    $$('[data-flip]', page).forEach((b) => b.addEventListener('click', async () => {
      try {
        await POST(`/api/users/${b.dataset.flip}/active`, { active: b.dataset.to === '1' });
        draw(await GET('/api/users'));
      } catch (e) { whoops(e); }
    }));
    // Removing is permanent, so it asks. Switching off is one tap and
    // reversible, which is why that one does not.
    $$('[data-del]', page).forEach((b) => b.addEventListener('click', () => {
      dialog(`<h3>Remove ${esc(b.dataset.who)}?</h3>
        <div class="dim">The sign-in goes for good and cannot be used again.
          Everything it has already done stays in the records under its name.
          <br><br>To stop someone signing in for now and keep the account,
          use <b>Switch off</b> instead.</div>
        <div class="mt right">
          <button class="btn quiet" id="rm_no">Keep it</button>
          <button class="btn warn" id="rm_yes">Remove</button></div>`);
      $('#rm_no').addEventListener('click', closeDialog);
      $('#rm_yes').addEventListener('click', async () => {
        $('#rm_yes').disabled = true;
        try {
          const r = await DELETE(`/api/users/${b.dataset.del}`);
          closeDialog();
          notice(`${r.removed} removed`, 'good');
          draw(await GET('/api/users'));
        } catch (e) { whoops(e); $('#rm_yes').disabled = false; }
      });
    }));
    $$('[data-pw]', page).forEach((b) => b.addEventListener('click', () => {
      dialog(`<h3>Set a new password</h3>
        <label>New password</label><input id="pw_new" type="password" autofocus>
        <div class="mt right"><button class="btn" id="pw_save">Save</button></div>`);
      $('#pw_save').addEventListener('click', async () => {
        try {
          await POST(`/api/users/${b.dataset.pw}/password`, { password: $('#pw_new').value });
          notice('Password changed', 'good');
          closeDialog();
        } catch (e) { whoops(e); }
      });
    }));
  };
  draw(users);

  $('#u_go', page).addEventListener('click', async () => {
    try {
      await POST('/api/users', {
        username: $('#u_name', page).value.trim(),
        display_name: $('#u_disp', page).value,
        password: $('#u_pass', page).value,
        role: $('#u_role', page).value,
        // No reseller chosen means none exists yet; the server says so plainly.
        reseller_id: $('#u_role', page).value === 'reseller'
          ? Number($('#u_res', page)?.value) || null : null,
      });
      notice('Sign-in created 🌸', 'good');
      $('#u_pass', page).value = '';
      draw(await GET('/api/users'));
    } catch (e) { whoops(e); }
  });
};

// ===========================================================================
// Which shop am I standing in?
//
// A till, a delivery and a stock move all happen somewhere. With one branch
// the question has one answer and the picker stays out of the way; with two it
// is the first thing that has to be right, so the choice is remembered per
// device rather than asked every morning.
// ===========================================================================
let BRANCHES = null;

async function branches() {
  if (!BRANCHES) BRANCHES = await GET('/api/branches').catch(() => []);
  return BRANCHES.filter((b) => b.active);
}

const branchRemembered = () => localStorage.getItem('branch') || '';

// Renders nothing at all when there is only one shop: a choice of one is not a
// choice, and an extra control on the till is an extra thing to get wrong.
function branchPicker(list, id = 'branch_pick', label = 'Branch') {
  if (list.length < 2) return '';
  const chosen = branchRemembered();
  return `<div style="flex:0 0 auto"><label>${esc(label)}</label>
    <select id="${id}">${list.map((b) =>
      `<option value="${b.id}" ${String(b.id) === chosen ? 'selected' : ''}>${
        esc(b.name)}</option>`).join('')}</select></div>`;
}

function wireBranchPicker(page, id = 'branch_pick', after) {
  const el = $(`#${id}`, page);
  if (!el) return;
  el.addEventListener('change', () => {
    localStorage.setItem('branch', el.value);
    if (after) after();
  });
}

const branchOf = (page, id = 'branch_pick') => $(`#${id}`, page)?.value || null;

// ===========================================================================
// Branches
//
// One shop today. The list exists so that the day there are two, nothing has
// to be untangled — every person, every clock and every sign-in already knows
// which door it belongs to.
// ===========================================================================
SCREENS.branches = async (page) => {
  page.innerHTML = `
    <div class="head"><h2>Branches</h2>
      <span class="hint">Where the shop trades, and who works at each</span></div>
    <div class="tools"><button class="btn" id="br_add">＋ New branch</button></div>
    <div class="panel" id="br_list"></div>
    <div class="panel">
      <h3>What is split by branch, and what is not</h3>
      <div class="dim">Staff, the time clock and sign-ins each belong to a
        branch, so a shared device by one door shows that door's faces and
        hours can be totalled a shop at a time.
        <br><br><b>Stock and sales are counted a shop at a time too.</b> Every
        shelf, every till receipt and every wholesale order carries the branch
        it happened at, and the screens that touch a shelf — Receive,
        Stockroom, the till, Wholesale — ask which shop first. One shop cannot
        sell what is sitting in another's stockroom; to make it sellable there,
        send it across with <b>Send</b> in the Stockroom.
        <br><br><b>Money is still totalled across the whole business.</b>
        Reports, Finance and the Dashboard add every branch together. Splitting
        those is the next piece of work.</div>
    </div>`;

  const load = async () => {
    const rows = await GET('/api/branches');
    $('#br_list', page).innerHTML = table(rows, [
      { head: 'Branch', cell: (b) => `<b>${esc(b.name)}</b>`
          + (b.active ? '' : ' ' + tag('closed', 'grey')) },
      { head: 'Where', cell: (b) => `<span class="dim">${esc(b.address || '—')}</span>` },
      { head: 'Open', cell: (b) => esc(b.opens || '—') },
      { head: 'Phone', cell: (b) => `<span class="dim">${esc(b.phone || '—')}</span>` },
      { head: 'People', n: true, cell: (b) => count(b.people) },
      { head: 'On shift', n: true, cell: (b) => (b.on_shift
          ? tag(String(b.on_shift), 'green') : '<span class="dim">0</span>') },
      { head: '', cell: (b) => `
          <button class="btn sm quiet" data-br-edit="${b.id}">Edit</button>
          <button class="btn sm ${b.active ? 'line' : 'go'}"
            data-br-shut="${b.id}" data-open="${b.active ? 0 : 1}">
            ${b.active ? 'Close' : 'Reopen'}</button>` },
    ], 'No branches yet.');

    $$('[data-br-edit]', page).forEach((b) => b.addEventListener('click',
      () => editBranch(rows.find((x) => String(x.id) === b.dataset.brEdit), load)));

    $$('[data-br-shut]', page).forEach((b) => b.addEventListener('click', async () => {
      try {
        await POST(`/api/branches/${b.dataset.brShut}/close`,
          { reopen: b.dataset.open === '1' });
        notice(b.dataset.open === '1' ? 'Open again' : 'Closed', 'good');
        load();
      } catch (e) { whoops(e); }
    }));
  };

  $('#br_add', page).addEventListener('click', () => editBranch(null, load));
  await load();
};

function editBranch(b, reload) {
  const isNew = !b;
  dialog(`
    <h3>${isNew ? 'New branch' : esc(b.name)}</h3>
    <div class="row">
      <div style="flex:2"><label>Name</label>
        <input id="br_name" type="text" value="${esc(b?.name || '')}"
          placeholder="Bayan Bayanan"></div>
      <div><label>Open</label>
        <input id="br_opens" type="text" value="${esc(b?.opens || '')}"
          placeholder="9am – 7pm"></div>
    </div>
    <div class="row">
      <div style="flex:2"><label>Address</label>
        <input id="br_addr" type="text" value="${esc(b?.address || '')}"></div>
      <div><label>Phone</label>
        <input id="br_phone" type="text" value="${esc(b?.phone || '')}"></div>
    </div>
    <div class="mt right">
      <button class="btn quiet" id="br_cancel">Cancel</button>
      <button class="btn" id="br_save">Save</button>
    </div>`);

  $('#br_cancel').addEventListener('click', closeDialog);
  $('#br_save').addEventListener('click', async () => {
    const body = {
      name: $('#br_name').value, address: $('#br_addr').value,
      phone: $('#br_phone').value, opens: $('#br_opens').value,
    };
    try {
      if (isNew) await POST('/api/branches', body);
      else await PUT(`/api/branches/${b.id}`, body);
      closeDialog();
      notice('Saved 🌸', 'good');
      reload();
    } catch (e) { whoops(e); }
  });
}

// ===========================================================================
// Taking on several people at once
// ===========================================================================
function bulkTeamDialog(reload, branches = []) {
  dialog(`
    <h3>Add several people</h3>
    <div class="dim">One person a line, separated by <b>|</b> or tabs or commas:
      <br><code>name | position | phone | started</code>
      <br>Phone and start date can be left off — the start date then means today.
      Lines beginning with <b>#</b> are ignored. Nobody gets a clock PIN here;
      set those individually afterwards.</div>
    ${branches.length > 1 ? `<div class="row mt"><div><label>Which branch</label>
      <select id="b_branch">${branches.filter((b) => b.active).map((b) =>
        `<option value="${b.id}">${esc(b.name)}</option>`).join('')}</select></div></div>` : ''}
    <label class="mt" for="b_text">The list</label>
    <textarea id="b_text" class="sheet" rows="12" spellcheck="false"
      placeholder="Aileen Ramos | Counter | 09171234567 | 2026-08-01"></textarea>
    <div id="b_preview" class="mt"></div>
    <div class="mt right">
      <button class="btn quiet" id="b_cancel">Cancel</button>
      <button class="btn" id="b_save" disabled>Add them</button>
    </div>`, 'wide');

  const parse = (text) => {
    const people = [];
    const problems = [];
    const seen = new Set();
    text.split('\n').forEach((raw, i) => {
      const line = raw.trim();
      if (!line || line.startsWith('#')) return;
      const at = `Line ${i + 1}`;
      const sep = line.includes('\t') ? '\t' : line.includes('|') ? '|' : ',';
      const f = line.split(sep).map((x) => x.trim());
      const person = { name: f[0] || '', position: f[1] || '', phone: f[2] || '',
                       started: f[3] || '' };

      if (!person.name) problems.push(`${at}: no name.`);
      if (!person.position) problems.push(`${at}: no position.`);
      if (person.name && seen.has(person.name.toLowerCase())) {
        problems.push(`${at}: ${person.name} is on the list twice.`);
      }
      seen.add(person.name.toLowerCase());
      if (person.started && Number.isNaN(Date.parse(person.started))) {
        problems.push(`${at}: “${person.started}” is not a date.`);
      }
      people.push(person);
    });
    if (!people.length) problems.push('There is nobody on that list.');
    return { people, problems };
  };

  const review = () => {
    const { people, problems } = parse($('#b_text').value);
    $('#b_preview').innerHTML = problems.length
      ? `<div class="none bad"><b>${problems.length} thing${
          problems.length === 1 ? '' : 's'} to fix first</b><br>${
          problems.slice(0, 12).map(esc).join('<br>')}${problems.length > 12 ? '<br>…' : ''}</div>`
      : `<div class="dim"><b>${people.length}</b> to add.</div>
         ${table(people, [
           { head: 'Name', cell: (x) => `<b>${esc(x.name)}</b>` },
           { head: 'Position', cell: (x) => esc(x.position) },
           { head: 'Phone', cell: (x) => `<span class="dim">${esc(x.phone || '—')}</span>` },
           { head: 'Started', cell: (x) => (x.started ? onDay(x.started)
               : '<span class="dim">today</span>') },
         ], '')}`;
    $('#b_save').disabled = problems.length > 0;
  };

  $('#b_text').addEventListener('input', review);
  $('#b_cancel').addEventListener('click', closeDialog);
  $('#b_save').addEventListener('click', async () => {
    const { people, problems } = parse($('#b_text').value);
    if (problems.length) return review();
    $('#b_save').disabled = true;
    try {
      const r = await POST('/api/team/bulk',
        { people, branch_id: $('#b_branch')?.value || null });
      closeDialog();
      notice(`${r.added} added — ${r.on_the_team} on the team 🌸`, 'good');
      notice('They cannot clock on until each has a PIN. Edit → Clock PIN.');
      reload();
    } catch (e) { whoops(e); $('#b_save').disabled = false; }
  });

  review();
}

// ===========================================================================
// PINs, on paper
//
// The PIN comes back from the server once and is never readable again — only
// its hash is kept, so there is no screen anywhere that can be made to show it
// a second time. That is the whole point, and it means this sheet has to be
// printed or written down before the dialog closes. A lost slip is a new PIN,
// which is the right trade: a system that can tell you somebody's PIN can tell
// anybody.
// ===========================================================================
async function pinSlipsDialog(reload) {
  // One shop, or both. Reissuing takes a PIN away from somebody who has already
  // learned it, so a shop that has never been given theirs has to be reachable
  // without resetting the shop that is clocking on with theirs this minute.
  const shops = await branches();
  dialog(`
    <h3>PINs &amp; slips</h3>
    <div class="dim">Gives a PIN to everybody who has not got one, and prints a
      slip each to hand out. Anybody who already has a PIN is left alone —
      reissuing would lock them out of a clock they are already using.
      <br><br><b>The PINs appear once.</b> Only the scrambled form is stored, so
      nothing here can be looked up again afterwards. Print before you close
      this. If somebody loses their slip, give them a new PIN from Edit.</div>
    <div class="row mt">
      <div style="flex:0 0 auto">
        <label class="dim">Which shop</label><br>
        <select id="k_shop">
          <option value="">Both shops</option>
          ${shops.filter((b) => b.active).map((b) =>
            `<option value="${b.id}">${esc(b.name)}</option>`).join('')}
        </select>
      </div>
      <div style="flex:0 0 auto">
        <label class="inline"><input type="checkbox" id="k_all">
          Reissue for <b>everyone</b>, including those who already have one</label></div>
    </div>
    <div id="k_warn"></div>
    <div class="mt right">
      <button class="btn quiet" id="k_cancel">Cancel</button>
      <button class="btn" id="k_go">Generate</button>
    </div>
    <div id="k_out"></div>`, 'wide');

  $('#k_cancel').addEventListener('click', closeDialog);

  // Said before it happens, not after. Reissuing is the one control here that
  // takes something away, and the difference between one shop and both is the
  // difference between handing out slips and locking a shop out mid-shift.
  const shopNow = () => $('#k_shop').selectedOptions[0].textContent.trim();
  const warn = () => {
    if (!$('#k_all').checked) { $('#k_warn').replaceChildren(); return; }
    $('#k_warn').innerHTML = `<div class="banner warn mt">Everybody at
      <b>${esc(shopNow())}</b> gets a new PIN, and their old one stops working
      the moment you press Generate. Only do this if you are handing the new
      slips out today.</div>`;
  };
  $('#k_all').addEventListener('change', warn);
  $('#k_shop').addEventListener('change', warn);

  $('#k_go').addEventListener('click', async () => {
    const everyone = $('#k_all').checked;
    const branch = $('#k_shop').value || null;
    // The slip carries the shop somebody actually works at, so a BOA slip does
    // not tell them to look for a door marked MS BEAU AVE.
    const slipShop = branch ? shopNow() : null;
    $('#k_go').disabled = true;
    $('#k_all').disabled = true;
    $('#k_shop').disabled = true;
    const all = [];
    try {
      // The server works in bites because hashing is slow on purpose; keep
      // asking, handing back where the last bite stopped, until nobody is
      // left. Reissuing for everybody has to walk the whole team, not stop
      // after the first twenty.
      let after = 0;
      for (;;) {
        const r = await POST('/api/team/pins', { everyone, after, branch });
        all.push(...r.issued);
        after = r.after ?? after;
        $('#k_out').innerHTML = `<div class="dim mt">${all.length} done${
          r.remaining ? `, ${r.remaining} to go…` : ''}</div>`;
        if (!r.remaining || !r.issued.length) break;
      }
    } catch (e) {
      whoops(e);
      $('#k_go').disabled = false;
      $('#k_all').disabled = false;
      $('#k_shop').disabled = false;
      return;
    }

    if (!all.length) {
      $('#k_out').innerHTML = `<div class="none mt">Everybody at ${
        esc(shopNow())} already has a PIN. Tick the box above to reissue.</div>`;
      $('#k_go').disabled = false;
      $('#k_all').disabled = false;
      $('#k_shop').disabled = false;
      return;
    }

    $('#k_out').innerHTML = `
      <div class="banner warn mt">Printed or written down before you close this,
        or these are gone — ${all.length} PIN${all.length === 1 ? '' : 's'} issued.</div>
      <div class="mt right"><button class="btn" id="k_print">🖨️ Print the slips</button></div>
      <div class="slips" id="k_slips">
        ${all.map((p) => `
          <div class="slip">
            <div class="slip-shop">${esc(slipShop || 'MS BEAU AVE')}</div>
            <div class="slip-who">${esc(p.name)}</div>
            <div class="slip-job">${esc(p.position)}</div>
            <div class="slip-pin">${esc(p.pin)}</div>
            <div class="slip-note">Your clock-in PIN, coming in and going home.
              At the door: press your finger, then type this on the keyboard.
              No fingerprint yet? Find your face on the screen and type it
              there. Keep it to yourself — it is how the shop knows the hours
              are yours.</div>
          </div>`).join('')}
      </div>`;

    $('#k_print').addEventListener('click', () => window.print());
    reload();
  });
}

// ===========================================================================
// The time clock
//
// One shared device by the door. Big faces, because somebody arriving at seven
// in the morning should not have to read. Pick yourself, type your PIN, and
// the same button clocks you out at the end of the day.
// ===========================================================================
SCREENS.clock = async (page) => {
  page.innerHTML = `
    <div class="head"><h2>Time clock</h2>
      <span class="hint">Tap your name, type your PIN</span></div>
    <div class="tools">
      <input type="search" id="c_find" placeholder="Find your name…" autocomplete="off">
      <select id="c_branch"></select>
      <a class="btn line" href="/clock/" target="_blank" rel="noopener">🚪 Open the door screen</a>
    </div>
    <div class="dim mb">The door screen is this clock on a page of its own —
      no menu, nothing else on it. Put it on the tablet by the door so nobody
      clocking on is one tap from the takings.</div>
    <div id="c_grid" class="clock-grid"></div>`;

  // A device left by one door should show that door's faces. It remembers the
  // choice, because nobody wants to pick the branch every morning.
  const branches = await GET('/api/branches').catch(() => []);
  const remembered = localStorage.getItem('clockBranch') || '';
  $('#c_branch', page).innerHTML =
    (branches.length > 1 ? '<option value="">Everybody</option>' : '')
    + branches.filter((b) => b.active).map((b) =>
      `<option value="${b.id}" ${String(b.id) === remembered ? 'selected' : ''}>${
        esc(b.name)}</option>`).join('');
  if (branches.length < 2) $('#c_branch', page).style.display = 'none';

  let team = [];
  const load = async () => {
    team = (await GET('/api/team')).team.filter((p) => p.here);
    draw();
  };

  const draw = () => {
    const q = ($('#c_find', page).value || '').trim().toLowerCase();
    const here = $('#c_branch', page).value;
    const shown = team
      .filter((p) => !here || String(p.branch_id) === here)
      .filter((p) => !q || p.name.toLowerCase().includes(q));
    $('#c_grid', page).innerHTML = shown.length ? shown.map((p) => `
      <button class="clock-card ${p.on_shift ? 'on' : ''}" data-who="${p.id}"
        ${p.has_pin ? '' : 'disabled'}>
        ${p.has_photo
          ? `<img src="/api/team/${p.id}/photo" alt="">`
          : '<span class="clock-face">🧑</span>'}
        <b>${esc(p.name)}</b>
        <span>${p.on_shift ? `on since ${when(p.since)}`
          : p.has_pin ? esc(p.position) : 'no PIN yet'}</span>
      </button>`).join('')
      : '<div class="none">Nobody matches that.</div>';

    $$('[data-who]', page).forEach((b) => b.addEventListener('click',
      () => pinPad(team.find((p) => String(p.id) === b.dataset.who), load)));
  };

  $('#c_find', page).addEventListener('input', draw);
  $('#c_branch', page).addEventListener('change', (e) => {
    localStorage.setItem('clockBranch', e.target.value);
    draw();
  });
  await load();
  repeat(load, 20000);
};

function pinPad(person, done) {
  let pin = '';
  dialog(`
    <h3>${esc(person.name)}</h3>
    <div class="dim">${person.on_shift
      ? 'Type your PIN to clock out.' : 'Type your PIN to clock on.'}</div>
    <div class="pin-dots" id="p_dots"></div>
    <div class="pin-pad">
      ${[1, 2, 3, 4, 5, 6, 7, 8, 9].map((d) =>
        `<button data-d="${d}">${d}</button>`).join('')}
      <button class="quiet" id="p_clear">clear</button>
      <button data-d="0">0</button>
      <button class="go" id="p_ok">✓</button>
    </div>
    <div class="mt right"><button class="btn quiet" id="p_cancel">Cancel</button></div>`);

  const dots = () => {
    $('#p_dots').textContent = pin.replace(/./g, '● ') || '– – – –';
  };
  dots();

  $$('[data-d]').forEach((b) => b.addEventListener('click', () => {
    if (pin.length < 8) pin += b.dataset.d;
    dots();
  }));
  $('#p_clear').addEventListener('click', () => { pin = ''; dots(); });
  $('#p_cancel').addEventListener('click', closeDialog);

  $('#p_ok').addEventListener('click', async () => {
    $('#p_ok').disabled = true;
    try {
      const r = await POST('/api/clock', { employeeId: person.id, pin });
      closeDialog();
      notice(r.action === 'in'
        ? `Good morning ${r.name} — clocked on 🌸`
        : `${r.name} clocked out after ${(r.worked_minutes / 60).toFixed(2)} hours 🌸`, 'good');
      done();
    } catch (e) {
      whoops(e);
      pin = '';
      dots();
      $('#p_ok').disabled = false;
    }
  });
}

// ===========================================================================
// The till
// ===========================================================================
const basket = new Map();

SCREENS.till = async (page) => {
  let goods = [];
  const shops = await branches();

  page.innerHTML = `
    <div class="head"><h2>Till</h2><span class="hint">Sells from the shop shelf only</span></div>
    <div class="till">
      <div>
        <div class="tools"><input type="search" id="q"
          placeholder="Scan a barcode, or type a name…" autofocus>
          ${branchPicker(shops, 'till_branch', 'Selling at')}</div>
        <div class="goods" id="goods"></div>
      </div>
      <div class="panel">
        <h3>🛒 Basket</h3><div id="basket"></div>
        <div class="total" id="total">₱0.00</div>
        <div class="pay">
          <button class="btn" data-pay="cash">💵 Cash</button>
          <button class="btn quiet" data-pay="gcash">📱 GCash</button>
          <button class="btn quiet" data-pay="card">💳 Card</button>
        </div>
        <div id="paying" class="mt"></div>
      </div>
    </div>`;

  const sum = () => [...basket.values()].reduce((s, l) => s + l.price * l.qty, 0);

  const drawBasket = () => {
    const box = $('#basket', page);
    box.innerHTML = basket.size ? [...basket.values()].map((l) => `
      <div class="pick">
        <span class="nm"><b>${esc(l.name)}</b><br><span class="dim">${peso(l.price)} each</span></span>
        <input type="number" min="1" value="${l.qty}" data-qty="${esc(l.sku)}">
        <button class="btn sm stop" data-drop="${esc(l.sku)}">✕</button>
      </div>`).join('') : '<div class="none">Nothing yet — tap a product.</div>';
    $('#total', page).textContent = peso(sum());

    $$('[data-qty]', box).forEach((i) => i.addEventListener('change', () => {
      basket.get(i.dataset.qty).qty = Math.max(1, +i.value || 1);
      drawBasket();
    }));
    $$('[data-drop]', box).forEach((b) => b.addEventListener('click', () => {
      basket.delete(b.dataset.drop);
      drawBasket();
    }));
  };

  const add = (p) => {
    if (p.on_shelf <= 0) return;
    // The promotion price, because that is what place_order will charge. A
    // basket that totals one figure and a receipt that prints another is an
    // argument at the counter.
    const line = basket.get(p.sku)
      ?? { sku: p.sku, name: p.name, price: Number(p.price_now ?? p.retail_price), qty: 0 };
    line.qty += 1;
    basket.set(p.sku, line);
    drawBasket();
  };

  const drawGoods = () => {
    $('#goods', page).innerHTML = goods.length ? goods.map((p) => `
      <button class="good ${p.on_shelf <= 0 ? 'empty' : ''}" data-add="${esc(p.sku)}">
        ${p.has_photo ? `<img class="goodpic" src="${photoUrl(p.sku)}" alt="" loading="lazy">`
          : '<span class="goodpic none-photo">🧴</span>'}
        <span class="nm">${esc(p.name)}</span>
        <span class="pr">${peso(p.price_now ?? p.retail_price)}${
          p.percent_off ? ` <s class="dim">${peso(p.retail_price)}</s>` : ''}</span>
        <span class="st">${p.on_shelf > 0 ? `${p.on_shelf} on the shelf` : 'none on the shelf'}</span>
      </button>`).join('') : '<div class="none">Nothing matches.</div>';

    $$('[data-add]', page).forEach((b) => b.addEventListener('click', () => {
      const p = goods.find((x) => x.sku === b.dataset.add);
      if (p.on_shelf <= 0) {
        notice('None on the shelf. Ask the warehouse to bring some out.', 'bad');
        POST('/api/restock', { sku: p.sku, note: 'asked for at the till' })
          .then(() => notice('The warehouse has been told 🌸', 'good'))
          .catch(() => {});
      } else {
        add(p);
      }
    }));
  };

  const search = async () => {
    goods = await GET(`/api/till/products?q=${encodeURIComponent($('#q', page).value)}`
      + (branchOf(page, 'till_branch') ? `&branch=${branchOf(page, 'till_branch')}` : ''));
    drawGoods();
  };

  $('#q', page).addEventListener('input', () => search().catch(whoops));
  // Switching shops empties the basket: a basket picked off one shelf cannot
  // be paid for at another, and half-moving it would be worse than starting
  // again.
  wireBranchPicker(page, 'till_branch', () => {
    basket.clear();
    drawBasket();
    search().catch(whoops);
  });
  $('#q', page).addEventListener('keydown', (e) => {
    // A barcode scanner types the code and presses Enter.
    if (e.key !== 'Enter') return;
    const code = e.target.value.trim().toLowerCase();
    const hit = goods.find((p) => p.sku.toLowerCase() === code);
    if (hit) { add(hit); e.target.value = ''; search().catch(whoops); }
  });

  $$('[data-pay]', page).forEach((b) => b.addEventListener('click', () => {
    if (!basket.size) return notice('The basket is empty.', 'bad');
    const method = b.dataset.pay;
    const owed = sum();
    const box = $('#paying', page);

    if (method === 'cash') {
      box.innerHTML = `<div class="row">
        <div><label>Cash handed over</label>
          <input type="number" id="given" step="0.01" min="0" autofocus></div>
        <div><label>Change</label><div class="big" id="change" style="font-size:1.3rem">—</div></div>
        <div style="flex:0 0 auto"><button class="btn go" id="done">Finish sale</button></div></div>`;
      $('#given').addEventListener('input', () => {
        const given = +$('#given').value;
        $('#change').textContent = given >= owed ? peso(given - owed) : '—';
      });
      $('#done').addEventListener('click', () => finish('cash', +$('#given').value));
    } else {
      box.innerHTML = `<div class="row">
        <div class="dim">Recording <b>${peso(owed)}</b> as ${esc(method)}.
          The system records the method; it does not take the payment.</div>
        <div style="flex:0 0 auto"><button class="btn go" id="done">Finish sale</button></div></div>`;
      $('#done').addEventListener('click', () => finish(method, null));
    }
  }));

  async function finish(method, tendered) {
    try {
      const receipt = await POST('/api/till/sell', {
        lines: [...basket.values()].map((l) => ({ sku: l.sku, qty: l.qty })),
        method, tendered, branch_id: branchOf(page, 'till_branch'),
      });
      basket.clear();
      drawBasket();
      $('#paying', page).innerHTML = '';
      showReceipt(receipt);
      search().catch(() => {});
    } catch (e) {
      whoops(e);
      search().catch(() => {});
    }
  }

  function showReceipt(r) {
    const lines = r.lines.map((l) =>
      `${l.qty} × ${esc(l.name)}\n    batch ${esc(l.batch_no)}${' '.repeat(4)}${peso(l.unit_price * l.qty)}`
    ).join('\n');
    dialog(`
      <h3>Receipt ${esc(r.receipt_no)}</h3>
      <div class="receipt">MS BEAU AVE
${esc(r.receipt_no)} · ${when(r.at)}
Served by ${esc(r.cashier)}
--------------------------------
${lines}
--------------------------------
TOTAL${' '.repeat(6)}${peso(r.total)}
${esc(r.method.toUpperCase())}${r.method === 'cash'
  ? `   given ${peso(r.tendered)}\nCHANGE${' '.repeat(5)}${peso(r.change)}` : ''}
--------------------------------
Salamat po! 🌸</div>
      <div class="loyalty">
        <label for="who">Points for a customer? Search by name or number</label>
        <input id="who" type="search" autocomplete="off" placeholder="Optional">
        <div id="hits"></div>
      </div>
      <div class="mt right">
        ${PRINT_BTN}
        <button class="btn" id="next">Next sale</button></div>`);
    $('#next').addEventListener('click', closeDialog);

    // Attributing happens after the sale, never before it: the goods have gone
    // and the money is in the drawer, so a mistyped number must not be able to
    // hold any of that up. Worst case the points are added later.
    let timer;
    $('#who').addEventListener('input', (e) => {
      const term = e.target.value.trim();
      clearTimeout(timer);
      if (!term) return ($('#hits').innerHTML = '');
      timer = setTimeout(async () => {
        try {
          const found = await GET(`/api/customers/find?q=${encodeURIComponent(term)}`);
          $('#hits').innerHTML = found.length
            ? found.map((c) => `
                <button class="btn sm quiet hit" data-cust="${c.id}">
                  ${esc(c.name)} <span class="dim">${esc(c.phone || '')} ·
                  ${count(c.points)} pts</span></button>`).join('')
            : `<div class="dim">Nobody by that name or number.
                 <button class="btn sm" id="reg">Register them</button></div>`;

          $$('[data-cust]').forEach((b) => b.addEventListener('click', async () => {
            try {
              const out = await POST(`/api/sales/${encodeURIComponent(r.receipt_no)}/customer`,
                { customer_id: Number(b.dataset.cust) });
              notice(`+${out.points} points 🌸`, 'good');
              $('.loyalty').innerHTML =
                `<div class="dim">${out.points} points added to their account.</div>`;
            } catch (err) { whoops(err); }
          }));

          $('#reg')?.addEventListener('click', async () => {
            const name = prompt('Name?');
            if (!name) return;
            try {
              const made = await POST('/api/customers', { name, phone: term });
              await POST(`/api/sales/${encodeURIComponent(r.receipt_no)}/customer`,
                { customer_id: made.id });
              notice('Registered, and the points are on 🌸', 'good');
              $('.loyalty').innerHTML =
                '<div class="dim">Registered. They can claim the account in the app '
                + 'with that number.</div>';
            } catch (err) { whoops(err); }
          });
        } catch (err) { whoops(err); }
      }, 250);
    });
  }

  drawBasket();
  await search();
  repeat(search, 10000);
};

// ===========================================================================
// Till: returns and shrinkage
// ===========================================================================
SCREENS.tillreturns = async (page) => {
  page.innerHTML = `
    <div class="head"><h2>Returns &amp; damage</h2></div>
    <div class="split">
      <div class="panel"><h3>↩️ Take something back</h3>
        <div class="row">
          <div style="flex:2"><label>Receipt number</label>
            <input id="rn" type="text" placeholder="OR-20260810-00001"></div>
          <div style="flex:0 0 auto"><button class="btn quiet" id="rf">Find</button></div>
        </div>
        <div id="rbody" class="mt"></div>
      </div>
      <div class="panel"><h3>🧪 Tester or breakage</h3>
        <div class="dim">Comes off the shelf with your name against it.</div>
        <div class="row">
          <div style="flex:2"><label>Product code</label><input id="sk" type="text"></div>
          <div style="flex:0 0 auto"><button class="btn quiet" id="sf">Find batches</button></div>
        </div>
        <div id="sbody" class="mt"></div>
      </div>
    </div>
    <div class="panel"><h3>What I have sent back</h3><div id="mine"></div></div>`;

  const mine = async () => {
    const rows = await GET('/api/till/returns');
    $('#mine', page).innerHTML = table(rows, [
      { head: 'Receipt', cell: (r) => `<span class="dim">${esc(r.receipt_no)}</span>` },
      { head: 'Product', cell: (r) => esc(r.name) },
      { head: 'Qty', n: true, cell: (r) => r.qty },
      { head: 'Why', cell: (r) => esc(r.reason) },
      { head: 'State', cell: (r) => r.status === 'pending' ? tag('with the owner', 'amber')
          : r.status === 'approved' ? tag(r.outcome, 'green') : tag('turned down', 'grey') },
    ], 'Nothing sent back yet.');
  };

  $('#rf', page).addEventListener('click', async () => {
    try {
      const receipt = $('#rn', page).value.trim();
      const r = await GET(`/api/till/receipts/${encodeURIComponent(receipt)}`);
      $('#rbody', page).innerHTML = `
        <div class="dim">${when(r.at)} — ${peso(r.total)} ${esc(r.method)}</div>
        ${r.lines.map((l, i) => `
          <div class="tile mt"><b>${esc(l.name)}</b>
            <span class="dim">batch ${esc(l.batch_no)} — bought ${l.qty}, can take back ${l.returnable}</span>
            ${Number(l.returnable) > 0 ? `<div class="row mt">
              <div><label>How many</label>
                <input id="q_${i}" type="number" min="1" max="${l.returnable}" value="1"></div>
              <div style="flex:2"><label>Why</label>
                <input id="w_${i}" type="text" placeholder="unopened, wrong shade…"></div>
              <div style="flex:0 0 auto"><button class="btn sm" data-send="${i}"
                data-sku="${esc(l.sku)}" data-batch="${l.batch_id}">Send to the owner</button></div>
            </div>` : ''}</div>`).join('')}`;

      $$('[data-send]', page).forEach((b) => b.addEventListener('click', async () => {
        const i = b.dataset.send;
        try {
          await POST('/api/till/returns', {
            receipt_no: receipt, sku: b.dataset.sku, batchId: +b.dataset.batch,
            qty: +$(`#q_${i}`).value, reason: $(`#w_${i}`).value || 'no reason given',
          });
          notice('Sent to the owner to decide 🌸', 'good');
          mine();
          $('#rf', page).click();
        } catch (e) { whoops(e); }
      }));
    } catch (e) { whoops(e); }
  });

  $('#sf', page).addEventListener('click', async () => {
    try {
      const sku = $('#sk', page).value.trim();
      const rows = await GET(`/api/till/shelf-batches/${encodeURIComponent(sku)}`);
      $('#sbody', page).innerHTML = rows.length ? rows.map((b, i) => `
        <div class="tile mt"><b>${esc(b.batch_no)}</b>
          <span class="dim">expires ${onDay(b.expiry)} — ${b.free} on the shelf</span>
          <div class="row mt">
            <div><label>How many</label>
              <input id="sq_${i}" type="number" min="1" max="${b.free}" value="1"></div>
            <div><label>What happened</label><select id="sr_${i}">
              <option value="tester">Made a tester</option>
              <option value="damaged">Damaged</option></select></div>
            <div style="flex:0 0 auto"><button class="btn sm" data-log="${i}"
              data-batch="${b.batch_id}">Record</button></div>
          </div></div>`).join('') : '<div class="none">Nothing on the shelf for that code.</div>';

      $$('[data-log]', page).forEach((btn) => btn.addEventListener('click', async () => {
        const i = btn.dataset.log;
        try {
          await POST('/api/till/shrinkage', {
            sku, batchId: +btn.dataset.batch, qty: +$(`#sq_${i}`).value,
            reason: $(`#sr_${i}`).value,
          });
          notice('Recorded and taken off the shelf 🌸', 'good');
          $('#sf', page).click();
        } catch (e) { whoops(e); }
      }));
    } catch (e) { whoops(e); }
  });

  await mine();
  repeat(mine, 15000);
};

// ===========================================================================
// Close of day — the blind count
// ===========================================================================
// ===========================================================================
// The shop's day
//
// What a supervisor needs to answer "how did we do today" without being handed
// the company's books. The takings view is branch-scoped in the database, so a
// tied sign-in sees one shop here and there is nothing on this screen that
// widens it.
// ===========================================================================
SCREENS.shopday = async (page) => {
  const today = localDay();
  const back = localDay(13);
  page.innerHTML = `
    <div class="head"><h2>Shop's day</h2>
      <span class="hint">Takings and shifts for your shop</span></div>
    <div class="panel">
      <div class="row">
        <div><label>From</label><input type="date" id="sd_from" value="${back}"></div>
        <div><label>To</label><input type="date" id="sd_to" value="${today}"></div>
        <div style="flex:0 0 auto"><button class="btn" id="sd_go">Show</button></div>
      </div>
      <div id="sd_out" class="mt"></div>
    </div>
    <div class="panel"><h3>On shift now</h3><div id="sd_who"></div></div>
    <div class="panel"><h3>Short on the shelf</h3><div id="sd_short"></div></div>`;

  const load = async () => {
    const from = $('#sd_from', page).value || back;
    const to = $('#sd_to', page).value || today;
    const rows = await GET(`/api/takings-by-branch?from=${from}&to=${to}`);
    const total = rows.reduce((n, r) => n + Number(r.revenue || 0), 0);
    const sales = rows.reduce((n, r) => n + Number(r.sales || 0), 0);
    $('#sd_out', page).innerHTML = `
      <div class="banner good">${count(sales)} sale(s), <b>${peso(total)}</b>
        over ${rows.length} trading day(s)</div>`
      + table(rows, [
        { head: 'Day', cell: (r) => onDay(r.business_date) },
        { head: 'Shop', cell: (r) => esc(r.branch) },
        { head: 'Sales', n: true, cell: (r) => count(r.sales) },
        { head: 'Taken', n: true, cell: (r) => peso(r.revenue) },
      ], 'Nothing sold in that stretch.');
  };

  const who = async () => {
    const { team } = await GET('/api/team');
    const on = team.filter((p) => p.on_shift);
    $('#sd_who', page).innerHTML = table(on, [
      { head: 'Name', cell: (p) => `<b>${esc(p.name)}</b>` },
      { head: 'Job', cell: (p) => `<span class="dim">${esc(p.position)}</span>` },
      { head: 'Since', cell: (p) => when(p.since) },
    ], 'Nobody is clocked in.');
  };

  const short = async () => {
    const rows = await GET('/api/restock').catch(() => []);
    $('#sd_short', page).innerHTML = table(rows, [
      { head: 'Product', cell: (t) => esc(t.name) },
      { head: 'Why', cell: (t) => `<span class="dim">${esc(t.reason)}</span>` },
      { head: 'Raised', cell: (t) => when(t.raised_at) },
    ], 'Nothing waiting 🌸');
  };

  $('#sd_go', page).addEventListener('click', () => load().catch(whoops));
  await Promise.all([load().catch(whoops), who().catch(() => {}), short().catch(() => {})]);
};

SCREENS.closeday = async (page) => {
  page.innerHTML = `
    <div class="head"><h2>Close of day</h2>
      <span class="hint">Count first — the till total stays hidden until you submit</span></div>
    <div class="split">
      <div class="panel"><h3>🌙 Count the drawer</h3>
        <div class="dim">Count the cash in the drawer and enter it below. You will see
          what the till expected only after you submit — that is the point.</div>
        <div class="row mt">
          <div><label>Cash counted</label><input id="c_amt" type="number" step="0.01" min="0"></div>
          <div style="flex:0 0 auto"><button class="btn" id="c_go">Submit the count</button></div>
        </div>
        <div id="c_res" class="mt"></div>
      </div>
      <div class="panel"><h3>Earlier counts</h3><div id="c_hist"></div></div>
    </div>`;

  const history = async () => {
    const rows = await GET('/api/till/close-day');
    $('#c_hist', page).innerHTML = table(rows, [
      { head: 'Day', cell: (r) => onDay(r.business_date) },
      { head: 'Counted', n: true, cell: (r) => peso(r.declared) },
      { head: 'State', cell: (r) => r.reconciled ? tag('checked', 'green') : tag('waiting', 'amber') },
    ], 'No counts yet.');
  };

  $('#c_go', page).addEventListener('click', async () => {
    try {
      const r = await POST('/api/till/close-day', { declared: +$('#c_amt', page).value });
      const off = Number(r.variance);
      $('#c_res', page).innerHTML = `<div class="banner ${off === 0 ? 'good' : 'warn'}">
        You counted <b>${peso(r.declared)}</b>. The till expected <b>${peso(r.expected)}</b>.
        Difference <b>${peso(r.variance)}</b>${r.flagged
          ? ' — flagged for the owner to look at.'
          : off === 0 ? ' — exactly right 🌸' : ' — within tolerance.'}</div>`;
      history();
    } catch (e) { whoops(e); }
  });

  await history();
};

// ===========================================================================
// The reseller's own screens
// ===========================================================================
const order = new Map();

SCREENS.catalog = async (page) => {
  let goods = [];

  page.innerHTML = `
    <div class="head"><h2>Order stock</h2>
      <span class="hint">What is free to ship you right now</span></div>
    <div id="warn"></div>
    <div class="till">
      <div>
        <div class="tools"><input type="search" id="q" placeholder="Search products…"></div>
        <div class="panel" id="list"></div>
      </div>
      <div class="panel"><h3>🛒 Your order</h3><div id="cart"></div>
        <div class="total" id="total">₱0.00</div>
        <button class="btn" id="send" style="width:100%">Place the order</button>
        <div class="dim mt">Stock is held for you the moment this goes through.</div>
      </div>
    </div>`;

  const drawCart = () => {
    $('#cart', page).innerHTML = order.size ? [...order.values()].map((l) => `
      <div class="pick">
        <span class="nm"><b>${esc(l.name)}</b><br><span class="dim">${peso(l.price)} each</span></span>
        <input type="number" min="1" value="${l.qty}" data-qty="${esc(l.sku)}">
        <button class="btn sm stop" data-drop="${esc(l.sku)}">✕</button>
      </div>`).join('') : '<div class="none">Nothing yet — add from the list.</div>';
    $('#total', page).textContent = peso(
      [...order.values()].reduce((s, l) => s + l.price * l.qty, 0));

    $$('[data-qty]', page).forEach((i) => i.addEventListener('change', () => {
      order.get(i.dataset.qty).qty = Math.max(1, +i.value || 1);
      drawCart();
    }));
    $$('[data-drop]', page).forEach((b) => b.addEventListener('click', () => {
      order.delete(b.dataset.drop);
      drawCart();
    }));
  };

  const drawList = () => {
    const term = ($('#q', page).value || '').toLowerCase();
    const rows = goods.filter((g) => !term
      || g.name.toLowerCase().includes(term) || g.sku.toLowerCase().includes(term));
    $('#list', page).innerHTML = table(rows, [
      { head: 'Product', cell: (g) => `<b>${esc(g.name)}</b><br>`
          + `<span class="dim">${esc(g.brand || '')} ${esc(g.sku)}</span>` },
      { head: 'Your price', n: true, cell: (g) => peso(g.wholesale_price) },
      { head: 'You sell at', n: true, cell: (g) => peso(g.srp) },
      { head: 'Available', n: true, cell: (g) => g.available > 0
          ? count(g.available) : tag('none', 'red') },
      { head: '', cell: (g) => g.available > 0
          ? `<button class="btn sm" data-add="${esc(g.sku)}">Add</button>` : '' },
    ], 'Nothing matches.');

    $$('[data-add]', page).forEach((b) => b.addEventListener('click', () => {
      const g = goods.find((x) => x.sku === b.dataset.add);
      const line = order.get(g.sku)
        ?? { sku: g.sku, name: g.name, price: Number(g.wholesale_price), qty: 0 };
      line.qty += 1;
      order.set(g.sku, line);
      drawCart();
    }));
  };

  const load = async () => {
    const [catalog, account] = await Promise.all([
      GET('/api/portal/catalog'), GET('/api/portal/account'),
    ]);
    goods = catalog;
    $('#warn', page).innerHTML = account.blocked
      ? `<div class="banner bad">🚫 ${esc(account.reason)}
          ${account.toClear > 0 ? ` Settle <b>${peso(account.toClear)}</b> to start ordering again.` : ''}</div>`
      : '';
    drawList();
  };

  $('#q', page).addEventListener('input', drawList);
  $('#send', page).addEventListener('click', async () => {
    if (!order.size) return notice('Your order is empty.', 'bad');
    try {
      const r = await POST('/api/portal/orders', {
        lines: [...order.values()].map((l) => ({ sku: l.sku, qty: l.qty })),
      });
      order.clear();
      drawCart();
      notice(`Order ${r.orderId} placed — stock is held for you 🌸`
        + (r.invoice ? ` Invoice due ${onDay(r.invoice.due_on)}.` : ''), 'good');
      load();
    } catch (e) { whoops(e); load(); }
  });

  drawCart();
  await load();
  repeat(load, 10000);
};

SCREENS.myorders = async (page) => {
  page.innerHTML = '<div class="head"><h2>My orders</h2></div><div class="panel" id="list"></div>';
  const load = async () => {
    const rows = await GET('/api/portal/orders');
    $('#list', page).innerHTML = table(rows, [
      { head: '#', cell: (o) => o.id },
      { head: 'Placed', cell: (o) => when(o.placed_at) },
      { head: 'What', cell: (o) => `<span class="dim">${o.lines.map((l) =>
          `${l.qty}× ${esc(l.sku)}`).join(', ')}</span>` },
      { head: 'Total', n: true, cell: (o) => peso(o.total) },
      { head: 'Stage', cell: (o) => orderTag(o) },
      { head: 'Invoice', cell: (o) => !o.invoice_id ? '—'
          : o.invoice_status === 'open'
            ? tag(`${peso(o.balance)} due ${onDay(o.due_on)}`, 'amber')
            : tag(o.invoice_status, o.invoice_status === 'paid' ? 'green' : 'grey') },
      { head: '', cell: (o) => o.status === 'placed'
          ? `<button class="btn sm stop" data-cancel="${o.id}">Cancel</button>` : '' },
    ], 'You have not ordered anything yet.');

    $$('[data-cancel]', page).forEach((b) => b.addEventListener('click', async () => {
      try {
        await POST(`/api/portal/orders/${b.dataset.cancel}/cancel`);
        notice('Cancelled — the stock goes back on sale.', 'good');
        load();
      } catch (e) { whoops(e); }
    }));
  };
  await load();
  repeat(load);
};

SCREENS.account = async (page) => {
  const load = async () => {
    const a = await GET('/api/portal/account');
    page.innerHTML = `
      <div class="head"><h2>Invoices &amp; credit</h2></div>
      ${a.blocked ? `<div class="banner bad">🚫 ${esc(a.reason)}</div>` : ''}
      <div class="tiles">
        <div class="tile"><div class="big">${tierTag(a.account.tier)}</div>
          <div class="label">${a.account.tier === 1
            ? 'You pay before we ship' : `You have ${a.account.terms_days} days to pay`}</div></div>
        <div class="tile"><div class="big">${peso(a.creditLimit)}</div>
          <div class="label">Your credit limit</div></div>
        <div class="tile ${a.owed > 0 ? 'warn' : 'good'}"><div class="big">${peso(a.owed)}</div>
          <div class="label">You owe</div></div>
        <div class="tile ${a.toClear > 0 ? 'bad' : 'good'}"><div class="big">${peso(a.toClear)}</div>
          <div class="label">Pay this to keep ordering</div></div>
      </div>
      <div class="panel"><h3>Invoices</h3>${table(a.invoices, [
        { head: '#', cell: (i) => i.id },
        { head: 'Issued', cell: (i) => onDay(i.issued_on) },
        { head: 'Due', cell: (i) => onDay(i.due_on) },
        { head: 'Amount', n: true, cell: (i) => peso(i.amount) },
        { head: 'Still owed', n: true, cell: (i) => peso(i.balance) },
        { head: 'State', cell: (i) => i.status === 'paid'
            ? tag(Number(i.discount) > 0 ? `paid · saved ${peso(i.discount)}` : 'paid', 'green')
            : i.status === 'void' ? tag('cancelled', 'grey')
            : i.overdue ? tag('past due', 'red') : tag('open', 'amber') },
      ], 'No invoices yet.')}
        <div class="dim mt">💡 Pay a 30-day invoice within 10 days and 2% comes off by itself.</div>
      </div>`;
  };
  await load();
  repeat(load, 15000);
};

// ===========================================================================
// Workspace — the team's feed and its task board
// ===========================================================================
SCREENS.workspace = async (page) => {
  page.innerHTML = `
    <div class="head"><h2>Workspace</h2>
      <span class="hint">What the team is saying, and what the team has to do</span></div>
    <div class="split">
      <div class="panel">
        <h3>Team feed</h3>
        <div class="row">
          <div style="flex:3"><input id="say" type="text"
            placeholder="Share an update with the team…" maxlength="500"></div>
          <div style="flex:0 0 auto"><button class="btn" id="post">Post</button></div>
        </div>
        <div id="feed" class="mt"></div>
      </div>
      <div class="panel">
        <h3>Tasks</h3>
        <div class="row">
          <div style="flex:2"><input id="t_title" type="text" placeholder="What needs doing"></div>
          <div><select id="t_who"></select></div>
          <div><input id="t_due" type="date"></div>
          <div><select id="t_prio">
            <option value="normal">Normal</option><option value="high">Urgent</option>
          </select></div>
          <div style="flex:0 0 auto"><button class="btn" id="add">Add</button></div>
        </div>
        <div class="kanban mt" id="board"></div>
      </div>
    </div>`;

  const LANES = [['todo', 'To do'], ['doing', 'In progress'], ['done', 'Done']];

  const load = async () => {
    const w = await GET('/api/workspace');

    // Only rebuild the assignee list when it changes: rewriting it every few
    // seconds would throw away whatever the person had chosen mid-sentence.
    const who = $('#t_who', page);
    const names = w.team.map((m) => m.username).join(',');
    if (who.dataset.names !== names) {
      who.dataset.names = names;
      who.innerHTML = '<option value="">Anyone</option>'
        + w.team.map((m) => `<option value="${esc(m.username)}">${esc(m.display_name)}</option>`).join('');
    }

    $('#feed', page).innerHTML = w.feed.length
      ? w.feed.map((p) => `
          <div class="post">
            <div class="post-by">${esc(p.author_name)}
              <span class="dim">${when(p.posted_at)}</span></div>
            <div>${esc(p.body)}</div>
          </div>`).join('')
      : '<div class="none">Nobody has said anything yet 🌸</div>';

    $('#board', page).innerHTML = LANES.map(([id, label]) => {
      const cards = w.tasks.filter((t) => t.status === id);
      return `
        <div class="klane">
          <h5>${label} <span>${cards.length}</span></h5>
          ${cards.map((t) => `
            <div class="kcard">
              <b>${esc(t.title)}</b>
              ${t.priority === 'high' ? tag('urgent', 'red') : ''}
              <div class="dim">${esc(t.assignee_name || 'unassigned')}${
                t.due_on ? ' · due ' + onDay(t.due_on) : ''}</div>
              ${t.overdue ? tag('overdue', 'amber') : ''}
              <div class="kmove">
                ${id !== 'todo' ? `<button class="btn sm quiet" data-move="${t.id}" data-to="${
                  id === 'done' ? 'doing' : 'todo'}">←</button>` : ''}
                ${id !== 'done' ? `<button class="btn sm" data-move="${t.id}" data-to="${
                  id === 'todo' ? 'doing' : 'done'}">→</button>` : ''}
              </div>
            </div>`).join('')
          || '<div class="dim" style="padding:6px">Nothing here</div>'}
        </div>`;
    }).join('');

    $$('[data-move]', page).forEach((b) => b.addEventListener('click', async () => {
      try {
        await POST(`/api/workspace/tasks/${b.dataset.move}/status`, { status: b.dataset.to });
        load();
      } catch (e) { whoops(e); }
    }));
  };

  $('#post', page).addEventListener('click', async () => {
    const body = $('#say', page).value.trim();
    if (!body) return;
    try {
      await POST('/api/workspace/posts', { body });
      $('#say', page).value = '';
      notice('Posted 🌸', 'good');
      load();
    } catch (e) { whoops(e); }
  });

  $('#add', page).addEventListener('click', async () => {
    const title = $('#t_title', page).value.trim();
    if (!title) return;
    try {
      await POST('/api/workspace/tasks', {
        title,
        assignee: $('#t_who', page).value || null,
        due: $('#t_due', page).value || null,
        priority: $('#t_prio', page).value,
      });
      $('#t_title', page).value = '';
      $('#t_due', page).value = '';
      notice('Task added 🌸', 'good');
      load();
    } catch (e) { whoops(e); }
  });

  await load();
  repeat(load, 15000);
};

// ===========================================================================
// Pickups — what the app reserved, waiting at the counter
// ===========================================================================
SCREENS.pickups = async (page) => {
  page.innerHTML = `
    <div class="head"><h2>Pickups</h2>
      <span class="hint">Reserved in the customer app, held off the shelf</span></div>
    <div class="panel" id="list"></div>`;

  const load = async () => {
    const rows = await GET('/api/pickups');
    $('#list', page).innerHTML = table(rows, [
      { head: 'Code', cell: (r) => `<b>${esc(r.code)}</b>` },
      { head: 'Customer', cell: (r) => `${esc(r.customer)}<br><span class="dim">${esc(r.phone)}</span>` },
      { head: 'Items', cell: (r) => esc(r.items || '') },
      { head: 'Total', n: true, cell: (r) => peso(r.total) },
      { head: 'Hold until', cell: (r) => when(r.hold_until) },
      { head: '', cell: (r) => `
          <button class="btn sm go" data-collect="${esc(r.code)}">Collected</button>
          <button class="btn sm quiet" data-drop="${r.id}">Cancel</button>` },
    ], 'Nothing reserved right now 🌸');

    $$('[data-collect]', page).forEach((b) => b.addEventListener('click', () => {
      const code = b.dataset.collect;
      dialog(`
        <h3>Handing over ${esc(code)}</h3>
        <div class="dim">Take the money, then record it. This goes through the till,
          so it lands in today's takings and the close of day.</div>
        <div class="row mt">
          <div><label>Paid by</label>
            <select id="p_method">
              <option value="cash">Cash</option>
              <option value="gcash">GCash</option>
              <option value="card">Card</option>
            </select></div>
        </div>
        <div class="mt right"><button class="btn go" id="p_go">Collected</button></div>`);

      $('#p_go').addEventListener('click', async () => {
        try {
          const out = await POST(`/api/pickups/${encodeURIComponent(code)}/collect`,
            { method: $('#p_method').value });
          closeDialog();
          notice(`${out.receipt_no} · ${peso(out.total)} · +${out.points} points 🌸`, 'good');
          load();
        } catch (e) { whoops(e); }
      });
    }));

    $$('[data-drop]', page).forEach((b) => b.addEventListener('click', async () => {
      try {
        await POST(`/api/pickups/${b.dataset.drop}/cancel`);
        notice('Released back to the shelf', 'good');
        load();
      } catch (e) { whoops(e); }
    }));
  };

  await load();
  repeat(load, 15000);
};

// ===========================================================================
// Promotions — a discount the till actually charges
// ===========================================================================
SCREENS.promos = async (page) => {
  page.innerHTML = `
    <div class="head"><h2>Promos</h2>
      <span class="hint">What comes off the shop price, and until when</span></div>
    <div class="tools">
      <button class="btn" id="new">＋ Start a promotion</button>
    </div>
    <div class="panel"><h3>Running now</h3><div id="live"></div></div>
    <div class="split">
      <div class="panel"><h3>Worth putting on sale</h3>
        <div class="dim">Batches with less than six months left, and the most you
          can take off before undercutting what resellers sell at.</div>
        <div id="cands" class="mt"></div></div>
      <div class="panel"><h3>Everything, past and future</h3><div id="all"></div></div>
    </div>`;

  let data = { live: [], all: [], candidates: [] };

  const load = async () => {
    data = await GET('/api/promos');

    $('#live', page).innerHTML = table(data.live, [
      { head: 'Product', cell: (p) => `<b>${esc(p.product)}</b>
          <span class="dim">${esc(p.sku)}</span>` },
      { head: 'Headline', cell: (p) => esc(p.headline) },
      { head: 'Off', n: true, cell: (p) => `${tag(`−${Number(p.percent_off)}%`, 'red')}` },
      { head: 'Was', n: true, cell: (p) => `<s class="dim">${peso(p.was)}</s>` },
      { head: 'Now', n: true, cell: (p) => `<b>${peso(p.now_price)}</b>` },
      { head: 'Until', cell: (p) => onDay(p.ends_on) },
      { head: 'Lot', cell: (p) => p.batch_no ? `<span class="dim">${esc(p.batch_no)}</span>` : '' },
      { head: '', cell: (p) => user.role === 'admin'
          ? `<button class="btn sm stop" data-end="${p.id}">End it</button>` : '' },
    ], 'Nothing on promotion right now');

    $('#cands', page).innerHTML = table(data.candidates, [
      { head: 'Product', cell: (c) => `<b>${esc(c.product)}</b>` },
      { head: 'Lot', cell: (c) => `<span class="dim">${esc(c.batch_no)}</span>` },
      { head: 'Expires', cell: (c) => `${onDay(c.expiry)}
          <span class="dim">${c.days_left}d</span>` },
      { head: 'Units', n: true, cell: (c) => count(c.units) },
      { head: 'Max off', n: true, cell: (c) => c.max_percent > 0 ? `${c.max_percent}%` : '—' },
      { head: '', cell: (c) => (user.role === 'admin' && !c.already_on_promo && c.max_percent > 0)
          ? `<button class="btn sm quiet" data-cand="${c.batch_id}">Put on sale</button>`
          : (c.already_on_promo ? tag('on promo', 'green') : '') },
    ], 'Nothing near expiry 🌸');

    $('#all', page).innerHTML = table(data.all, [
      { head: 'Product', cell: (p) => esc(p.product) },
      { head: 'Off', n: true, cell: (p) => `${Number(p.percent_off)}%` },
      { head: 'From', cell: (p) => onDay(p.starts_on) },
      { head: 'Until', cell: (p) => onDay(p.ends_on) },
      { head: 'State', cell: (p) => p.ended_early ? tag('stopped', 'grey')
          : p.running ? tag('running', 'green')
          : (new Date(p.starts_on) > new Date() ? tag('scheduled', 'amber') : tag('finished', 'grey')) },
    ], 'No promotions yet');

    $$('[data-end]', page).forEach((b) => b.addEventListener('click', async () => {
      try {
        await POST(`/api/promos/${b.dataset.end}/end`);
        notice('Ended — the price is back to normal', 'good');
        load();
      } catch (e) { whoops(e); }
    }));

    $$('[data-cand]', page).forEach((b) => b.addEventListener('click', () => {
      const c = data.candidates.find((x) => String(x.batch_id) === b.dataset.cand);
      openPromo(c);
    }));
  };

  const openPromo = (from) => {
    const inAMonth = localDay(-30);
    dialog(`
      <h3>Start a promotion</h3>
      <div class="row">
        <div style="flex:2"><label>Product code</label>
          <input id="pm_sku" type="text" value="${esc(from?.sku || '')}"
            placeholder="e.g. SER-004"></div>
        <div><label>Take off (%)</label>
          <input id="pm_pc" type="number" min="1" max="90" step="1"
            value="${from ? Math.min(20, from.max_percent) : 15}"></div>
      </div>
      ${from ? `<div class="dim">${esc(from.product)} · lot ${esc(from.batch_no)} ·
        ${count(from.units)} units · expires ${onDay(from.expiry)} ·
        the most you can take off is ${from.max_percent}%</div>` : ''}
      <div><label>Headline</label>
        <input id="pm_head" type="text" maxlength="90"
          value="${from ? esc(`Flash Sale — ${from.product} (lot ${from.batch_no})`) : ''}"
          placeholder="What the customer reads"></div>
      <div class="row">
        <div><label>Kind</label>
          <select id="pm_kind">
            <option value="flash">Flash sale</option>
            <option value="instore">In-store promo</option>
          </select></div>
        <div><label>Starts</label><input id="pm_from" type="date"></div>
        <div><label>Ends</label><input id="pm_to" type="date" value="${inAMonth}"></div>
      </div>
      <div class="dim mt">The shop price can never go below what resellers sell at.
        If it would, this is refused and tells you the most you can take off.</div>
      <div class="mt right"><button class="btn" id="pm_go">Start it</button></div>`);

    $('#pm_go').addEventListener('click', async () => {
      try {
        await POST('/api/promos', {
          sku: $('#pm_sku').value.trim().toUpperCase(),
          headline: $('#pm_head').value,
          percent: Number($('#pm_pc').value),
          kind: $('#pm_kind').value,
          starts: $('#pm_from').value || null,
          ends: $('#pm_to').value,
          batch_id: from?.batch_id || null,
        });
        closeDialog();
        notice('Promotion started 🌸', 'good');
        load();
      } catch (e) { whoops(e); }
    });
  };

  $('#new', page).addEventListener('click', () => openPromo(null));
  await load();
  repeat(load, 20000);
};

// ===========================================================================
// The team — who works here, and who is here now
// ===========================================================================
// Postgres hands an interval over in parts, and every part has to be counted:
// a half-hour shift arrives as minutes only, and dropping them would show 0h
// against somebody who was here.
const hoursOf = (interval) => {
  if (!interval) return '—';
  const h = (interval.days || 0) * 24 + (interval.hours || 0)
          + (interval.minutes || 0) / 60 + (interval.seconds || 0) / 3600;
  if (h >= 1) return `${h.toFixed(1)}h`;
  const mins = Math.round(h * 60);
  return mins >= 1 ? `${mins}m` : 'just started';
};

SCREENS.team = async (page) => {
  const owner = user.role === 'admin';
  page.innerHTML = `
    <div class="head"><h2>Team</h2>
      <span class="hint">${owner ? 'Who works here, and the hours they actually worked'
        : 'Who is on today'}</span></div>
    <div class="tools">
      <input type="search" id="t_find" placeholder="Search by name or position…">
      <select id="t_branch"><option value="">Every branch</option></select>
      ${owner ? `<button class="btn" id="add">＋ Add someone</button>
        <button class="btn line" id="t_many">👥 Add many</button>
        <button class="btn line" id="t_photos">📷 Photographs</button>
        <button class="btn line" id="t_pins">🖨️ PINs &amp; slips</button>` : ''}
    </div>
    <div class="tiles" id="tiles"></div>
    <div class="panel" id="list"></div>
    ${owner ? `
      <div class="panel">
        <h3>Hours worked</h3>
        <div class="dim">Totals for whatever period you pay over. An open shift
          counts up to now, so somebody who forgot to clock out is visible
          rather than silently worth nothing.</div>
        <div class="row mt">
          <div><label>From</label><input type="date" id="h_from"></div>
          <div><label>To</label><input type="date" id="h_to"></div>
          <div><label>Branch</label>
            <select id="h_branch"><option value="">Every branch</option></select></div>
          <div style="flex:0 0 auto; align-self:flex-end">
            <button class="btn" id="h_go">Total it up</button></div>
        </div>
        <div id="hours" class="mt"></div>
      </div>
      <div class="panel"><h3>Recent shifts</h3><div id="shifts"></div></div>` : ''}`;

  let data = { team: [], shifts: [], logins: [] };

  const load = async () => {
    data = await GET('/api/team');
    const here = data.team.filter((p) => p.here);
    const on = here.filter((p) => p.on_shift);

    $('#tiles', page).innerHTML = `
      <div class="tile good"><div class="big">${on.length}</div>
        <div class="label">On shift right now</div></div>
      <div class="tile"><div class="big">${here.length}</div>
        <div class="label">On the team</div></div>`;

    const q = ($('#t_find', page)?.value || '').trim().toLowerCase();
    const onlyBranch = $('#t_branch', page)?.value || '';
    const shown = data.team
      .filter((p) => !onlyBranch || String(p.branch_id) === onlyBranch)
      .filter((p) => !q || `${p.name} ${p.position}`.toLowerCase().includes(q));

    $('#list', page).innerHTML = table(shown, [
      { head: '', cell: (p) => p.has_photo
          ? `<img class="thumb" style="width:34px;height:34px" src="/api/team/${p.id}/photo" alt="">`
          : `<span class="thumb none-photo" style="width:34px;height:34px">🧑</span>` },
      { head: 'Name', cell: (p) => `<b>${esc(p.name)}</b>`
          + (p.here ? '' : ' ' + tag('left', 'grey')) },
      { head: 'Position', cell: (p) => esc(p.position) },
      { head: 'Branch', cell: (p) => `<span class="dim">${esc(p.branch || '')}</span>` },
      { head: 'Signs in as', cell: (p) => p.signs_in_as
          ? tag(roleName(p.signs_in_as), 'pink') : '<span class="dim">no login</span>' },
      ...(owner ? [
        { head: 'Phone', cell: (p) => `<span class="dim">${esc(p.phone || '')}</span>` },
        { head: 'This week', n: true, cell: (p) => hoursOf(p.hours_this_week) },
      ] : []),
      { head: 'Now', cell: (p) => p.on_shift
          ? `${tag('on shift', 'green')} <span class="dim">since ${when(p.since)}</span>`
          : (p.here ? '<span class="dim">off</span>' : '') },
      { head: '', cell: (p) => !p.here ? '' : `
          <button class="btn sm ${p.on_shift ? 'stop' : 'go'}"
            data-clock="${p.id}" data-dir="${p.on_shift ? 'out' : 'in'}">
            ${p.on_shift ? 'Clock out' : 'Clock in'}</button>
          ${owner ? `<button class="btn sm quiet" data-edit="${p.id}">Edit</button>` : ''}` },
      ...(owner ? [
        { head: '', cell: (p) => `<button class="btn sm warn" data-drop="${p.id}"
            data-who="${esc(p.name)}">Remove</button>` },
      ] : []),
    ], q ? 'Nobody matches that search.' : 'Nobody on the team yet');

    if (owner) {
      $('#shifts', page).innerHTML = table(data.shifts, [
        { head: 'Who', cell: (s) => esc(s.name) },
        { head: 'Day', cell: (s) => onDay(s.business_date) },
        { head: 'On', cell: (s) => when(s.started_at) },
        { head: 'Off', cell: (s) => s.ended_at ? when(s.ended_at) : tag('still on', 'green') },
        { head: 'Worked', n: true, cell: (s) => hoursOf(s.worked) },
        { head: 'Clocked by', cell: (s) => `<span class="dim">${esc(s.started_by)}${
            s.ended_by && s.ended_by !== s.started_by ? ' / ' + esc(s.ended_by) : ''}</span>` },
      ], 'No shifts recorded yet');
    }

    $$('[data-clock]', page).forEach((b) => b.addEventListener('click', async () => {
      try {
        const out = await POST(`/api/team/${b.dataset.clock}/clock`, { direction: b.dataset.dir });
        notice(b.dataset.dir === 'out'
          ? `Clocked out after ${hoursOf(out.worked)} 🌸` : 'Clocked in 🌸', 'good');
        load();
      } catch (e) { whoops(e); }
    }));

    $$('[data-edit]', page).forEach((b) => b.addEventListener('click', () =>
      openPerson(data.team.find((p) => String(p.id) === b.dataset.edit))));

    // Two different things get called "remove", so the dialog says which this
    // is and where the other one lives.
    $$('[data-drop]', page).forEach((b) => b.addEventListener('click', () => {
      dialog(`<h3>Remove ${esc(b.dataset.who)}?</h3>
        <div class="dim">This is for somebody who should never have been on the
          list — a test entry, a duplicate, a name typed into the wrong box. The
          record goes for good.
          <br><br>If they genuinely worked here and are leaving, close this and
          use <b>Edit → They have left</b> instead. That dates the departure and
          keeps their hours, which payroll still has to add up.
          <br><br>Anybody with a shift on record cannot be removed here.</div>
        <div class="mt right">
          <button class="btn quiet" id="d_no">Keep them</button>
          <button class="btn warn" id="d_yes">Remove</button></div>`);
      $('#d_no').addEventListener('click', closeDialog);
      $('#d_yes').addEventListener('click', async () => {
        $('#d_yes').disabled = true;
        try {
          const r = await DELETE(`/api/team/${b.dataset.drop}`);
          closeDialog();
          notice(`${r.removed} removed`, 'good');
          load();
        } catch (e) { whoops(e); $('#d_yes').disabled = false; }
      });
    }));
  };

  const openPerson = (p) => {
    const isNew = !p;
    // Someone already linked to a login keeps theirs in the list; everybody
    // else can only be offered the accounts nobody has claimed.
    const options = [
      { id: '', display_name: 'No sign-in' },
      ...(p?.user_id ? [{ id: p.user_id, display_name: `${p.username} (current)` }] : []),
      ...data.logins,
    ];

    dialog(`
      <h3>${isNew ? 'Add someone' : esc(p.name)}</h3>
      <div class="row">
        <div style="flex:2"><label>Name</label>
          <input id="t_name" type="text" value="${esc(p?.name || '')}"></div>
        <div><label>Position</label>
          <input id="t_pos" type="text" value="${esc(p?.position || '')}"
            placeholder="Cashier, Warehouse…"></div>
      </div>
      <div class="row">
        <div><label>Phone</label>
          <input id="t_phone" type="text" value="${esc(p?.phone || '')}"></div>
        <div><label>Signs in as</label>
          <select id="t_user">
            ${options.map((o) => `<option value="${esc(String(o.id))}"
              ${p?.user_id && o.id === p.user_id ? 'selected' : ''}>
              ${esc(o.display_name)}</option>`).join('')}
          </select></div>
        ${isNew ? '<div><label>Started</label><input id="t_from" type="date"></div>' : ''}
        ${isNew && branches.length > 1 ? `<div><label>Branch</label>
          <select id="t_new_branch">${branchOptions()}</select></div>` : ''}
      </div>
      <div><label>Note</label>
        <input id="t_note" type="text" value="${esc(p?.note || '')}"
          placeholder="Anything worth remembering"></div>

      ${isNew || branches.length < 2 ? '' : `
        <h3 class="mt">Branch</h3>
        <div class="row">
          <div><label>Works at</label>
            <select id="t_branch_pick">${branchOptions(p.branch_id)}</select></div>
          <div style="flex:0 0 auto; align-self:flex-end">
            <button class="btn quiet sm" id="t_branch_save">Move them</button></div>
        </div>`}

      ${isNew ? '' : `
        <h3 class="mt">Clock PIN</h3>
        <div class="dim">Four to eight digits, typed on the shared device by the
          door. It stops one person clocking in another; it is not a password
          and opens nothing else.</div>
        <div class="row">
          <div><label for="t_pin">${p.has_pin ? 'Replace the PIN' : 'Set a PIN'}</label>
            <input id="t_pin" type="text" inputmode="numeric" maxlength="8"
              autocomplete="off" placeholder="${p.has_pin ? 'unchanged' : 'e.g. 4821'}"></div>
          <div style="flex:0 0 auto; align-self:flex-end">
            <button class="btn quiet sm" id="t_pin_save">Save PIN</button></div>
          <div style="flex:0 0 auto; align-self:flex-end" class="dim">
            ${p.has_pin ? '✅ can clock on' : '⚠️ cannot clock on yet'}</div>
        </div>

        <h3 class="mt">Fingerprints</h3>
        <div class="dim">The PIN says the four digits were typed. A finger says
          who typed them. Enrol two, so a cut thumb on a Monday does not cost
          somebody their hours.</div>
        <div class="row" style="align-items:flex-end">
          <div style="flex:0 0 auto"><label for="t_finger">Finger</label>
            <select id="t_finger">
              <option value="1">Right index</option>
              <option value="2">Right thumb</option>
              <option value="6">Left index</option>
              <option value="7">Left thumb</option>
            </select></div>
          <div style="flex:0 0 auto">
            <button class="btn quiet sm" id="t_scan">Scan a finger</button></div>
          <div style="flex:0 0 auto">
            ${p.fingers ? `<button class="btn quiet sm" id="t_unfinger">Remove all</button>` : ''}</div>
          <div class="dim" id="t_fingerstate">${p.fingers
            ? `✅ ${p.fingers} enrolled`
            : 'none enrolled — this person clocks on with their PIN'}</div>
        </div>

        <h3 class="mt">Photograph</h3>
        <div class="row" style="align-items:center">
          <div style="flex:0 0 auto" id="t_pic">${p.has_photo
            ? `<img class="thumb" style="width:70px;height:70px" src="/api/team/${p.id}/photo" alt="">`
            : '<span class="thumb none-photo" style="width:70px;height:70px">🧑</span>'}</div>
          <div><label for="t_file">Choose a picture</label>
            <input id="t_file" type="file" accept="image/*"></div>
        </div>`}

      <div class="mt right">
        ${isNew || !p.here ? '' : `<button class="btn quiet" id="t_left">They have left</button>`}
        <button class="btn" id="t_save">Save</button>
      </div>`);

    if (!isNew) {
      // Enrolling needs a scanner on *this* machine, reached through the same
      // little agent the shop doors run. If nothing answers on loopback, say
      // so plainly rather than leaving a button that does nothing.
      $('#t_scan')?.addEventListener('click', async () => {
        const state = $('#t_fingerstate');
        const button = $('#t_scan');
        button.disabled = true;
        state.textContent = 'Press the finger three times, lifting between each…';
        try {
          const got = await fetch('http://127.0.0.1:9500/capture',
            { signal: AbortSignal.timeout(40000) }).then((r) => r.json());
          if (got.error) throw new Error(got.error);
          await POST(`/api/team/${p.id}/finger`,
            { finger: +$('#t_finger').value, template: got.template, quality: got.quality });
          notice(`${p.name} — finger enrolled`, 'good');
          closeDialog();
          load();
        } catch (e) {
          // No scanner is not a dead end. The PIN above is enough to put
          // somebody on the clock today; the finger can be added here on any
          // later day, from any desk that has a working reader.
          const why = /fetch|timeout|abort/i.test(e.message)
            ? 'No door program running on this computer.'
            : e.message;
          state.innerHTML = `${esc(why)} <b>Set a PIN above instead</b> \u2014
            ${esc(p.name)} can clock in and out on the PIN alone, and you can
            enrol the finger here another day.`;
          button.disabled = false;
        }
      });

      $('#t_unfinger')?.addEventListener('click', async () => {
        try {
          const r = await DELETE(`/api/team/${p.id}/fingers`);
          notice(`${r.removed} removed — ${p.name} clocks on with their PIN now`, 'good');
          closeDialog();
          load();
        } catch (e) { whoops(e); }
      });

      $('#t_branch_save')?.addEventListener('click', async () => {
        try {
          await POST(`/api/team/${p.id}/branch`,
            { branch_id: $('#t_branch_pick').value });
          notice(`${p.name} moved`, 'good');
          closeDialog();
          load();
        } catch (err) { whoops(err); }
      });

      $('#t_pin_save').addEventListener('click', async () => {
        try {
          await POST(`/api/team/${p.id}/pin`, { pin: $('#t_pin').value.trim() });
          notice(`${p.name} can clock on now 🌸`, 'good');
          closeDialog();
          load();
        } catch (err) { whoops(err); }
      });

      $('#t_file').addEventListener('change', async (e) => {
        const file = e.target.files[0];
        if (!file) return;
        try {
          await POST(`/api/team/${p.id}/photo`, { dataUrl: await shrink(file, 600) });
          $('#t_pic').innerHTML =
            `<img class="thumb" style="width:70px;height:70px" src="/api/team/${p.id}/photo?v=${Date.now()}" alt="">`;
          notice('Picture saved 🌸', 'good');
          load();
        } catch (err) { whoops(err); }
        e.target.value = '';
      });

      $('#t_left')?.addEventListener('click', async () => {
        try {
          await POST(`/api/team/${p.id}/left`, {});
          closeDialog();
          notice('Recorded — their hours stay on the books', 'good');
          load();
        } catch (err) { whoops(err); }
      });
    }

    $('#t_save').addEventListener('click', async () => {
      const chosen = $('#t_user').value;
      const body = {
        name: $('#t_name').value,
        position: $('#t_pos').value,
        phone: $('#t_phone').value,
        note: $('#t_note').value,
        branch_id: $('#t_new_branch')?.value || null,
        user_id: chosen ? Number(chosen) : null,
      };

      try {
        if (isNew) {
          await POST('/api/team', { ...body, started: $('#t_from').value || null });
        } else {
          await PUT(`/api/team/${p.id}`, body);
        }
        closeDialog();
        notice('Saved 🌸', 'good');
        load();
      } catch (e) { whoops(e); }
    });
  };

  $('#t_find', page).addEventListener('input', () => load().catch(whoops));
  $('#t_branch', page).addEventListener('change', () => load().catch(whoops));

  // The branch pickers everywhere on this screen come from the same list.
  const branches = await GET('/api/branches').catch(() => []);
  const branchOptions = (chosen) => branches.filter((b) => b.active || b.id === chosen)
    .map((b) => `<option value="${b.id}" ${b.id === chosen ? 'selected' : ''}>${
      esc(b.name)}</option>`).join('');
  $('#t_branch', page).innerHTML = '<option value="">Every branch</option>'
    + branches.map((b) => `<option value="${b.id}">${esc(b.name)}</option>`).join('');

  if (owner) {
    $('#add', page).addEventListener('click', () => openPerson(null));
    $('#t_many', page).addEventListener('click', () => bulkTeamDialog(load, branches));
    $('#t_photos', page).addEventListener('click', () => photosDialog(data.team, load));
    $('#t_pins', page).addEventListener('click', () => pinSlipsDialog(load));

    $('#h_branch', page).innerHTML = '<option value="">Every branch</option>'
      + branches.map((b) => `<option value="${b.id}">${esc(b.name)}</option>`).join('');

    // Default the report to this month so far — the commonest thing to ask.
    const today = localDay();
    $('#h_from', page).value = today.slice(0, 8) + '01';
    $('#h_to', page).value = today;

    $('#h_go', page).addEventListener('click', async () => {
      try {
        const r = await GET(`/api/team/hours?from=${$('#h_from', page).value}`
          + `&to=${$('#h_to', page).value}`
          + ($('#h_branch', page).value ? `&branch=${$('#h_branch', page).value}` : ''));
        const total = r.people.reduce((t, x) => t + Number(x.hours), 0);
        const open = r.people.reduce((t, x) => t + Number(x.still_open), 0);
        $('#hours', page).innerHTML = `
          <div class="dim"><b>${r.people.length}</b> people ·
            <b>${total.toFixed(2)}</b> hours between ${onDay(r.from)} and ${onDay(r.to)}${
            open ? ` · <b>${open}</b> shift${open === 1 ? '' : 's'} still open, counted up to now`
                 : ''}</div>
          ${table(r.people, [
            { head: 'Who', cell: (x) => `<b>${esc(x.name)}</b>`
                + (x.here ? '' : ' ' + tag('left', 'grey')) },
            { head: 'Position', cell: (x) => esc(x.position) },
            { head: 'Branch', cell: (x) => `<span class="dim">${esc(x.branch)}</span>` },
            { head: 'Days', n: true, cell: (x) => count(x.days) },
            { head: 'Hours', n: true, cell: (x) => Number(x.hours).toFixed(2) },
            { head: 'Longest shift', n: true, cell: (x) => Number(x.longest_hours).toFixed(2) },
            { head: '', cell: (x) => (Number(x.still_open)
                ? tag('still on', 'amber') : '') },
          ], 'Nobody worked in that period.')}`;
      } catch (e) { whoops(e); }
    });
  }
  await load();
  repeat(load, 20000);
};

// ---------------------------------------------------------------------------
// Everybody's photograph, in one go
//
// Fifty people, one at a time — open the person, choose the file, save, close,
// find the next one — is fifty of everything, and the sort of job that gets
// abandoned at number nine.
//
// The photographs already know who they are: whoever took them saved
// "Loberiano, Melmark Tiangco.jpg". So the folder goes in whole, the filenames
// do the matching, and what is left on screen is only the ones it could not
// work out. Nothing saves until it has been looked at — a face against the
// wrong name is worse than no face at all, because the door screen exists to
// be recognised.
// ---------------------------------------------------------------------------

// Names arrive in every shape: "Loberiano, Melmark Tiangco", "melmark
// loberiano", "IBAÑEZ_GINA-A", "03 Esplana Jennifer (1).png". Strip it back to
// the words, and lose the accents — a filename that has been through Windows,
// Drive and a zip cannot be trusted to have kept its ñ.
const nameWords = (text) => String(text ?? '')
  .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  .toLowerCase()
  .replace(/\.[a-z0-9]{2,4}$/, '')          // the extension
  .replace(/\(\d+\)/g, '')                   // Windows' "(1)" on a duplicate
  .replace(/[^a-z]+/g, ' ')
  .split(' ')
  .filter((w) => w.length > 1);              // initials say too little

// The words, plus each neighbouring pair run together.
//
// Whether a name is written as one word or two is not a fact about the person,
// it is a habit of whoever typed it: the roster says "Marygrace Abagon" and the
// photograph is filed as "MARY GRACE ABAGON". Without this, "Mary" is the only
// word left to go on — and it belongs to somebody else entirely, which is
// exactly the wrong-face-on-the-door-screen all of this exists to avoid.
const joined = (words) => {
  const all = new Set(words);
  for (let i = 0; i < words.length - 1; i++) all.add(words[i] + words[i + 1]);
  return all;
};

// How much a filename looks like a person. Counted in whole words rather than
// letters: "Ma. Beatriz Diane Gochuico Pardo" and "Pardo Beatriz" share two
// words and mean the same person, while "Jennifer Esplana" and "Jennifer
// Siguenza" share one and do not.
function scoreName(words, person) {
  const theirs = joined(nameWords(person.name));
  if (!theirs.size) return 0;
  let score = 0;
  for (const w of joined(words)) {
    if (!theirs.has(w)) continue;
    // A word both of them have is worth more when it is rare across the team:
    // sharing "Ibañez" says far more than sharing "Marie". And a run-together
    // pair counts for more than a single word, because two words falling in
    // the same order is a great deal harder to hit by accident.
    const weight = RARE.get(w) ?? 1;
    score += words.includes(w) ? weight : weight * 1.5;
  }
  return score;
}
let RARE = new Map();

/**
 * How much each word tells you, given the team you are looking at.
 *
 * A word only one person carries identifies them; one four people share barely
 * narrows anything. Worked out from the team rather than assumed, so it stays
 * right as people join and leave — and over the same run-together pairs the
 * scorer looks at, or the two would disagree about what a word is.
 */
function rarityAcross(people) {
  const seen = new Map();
  for (const p of people) {
    for (const w of joined(nameWords(p.name))) seen.set(w, (seen.get(w) || 0) + 1);
  }
  return new Map([...seen].map(([w, n]) => [w, 1 / n]));
}

/**
 * Who a filename belongs to — or nobody, which is a real answer.
 *
 * The whole decision lives here rather than at the call site, because it is
 * the one rule worth being able to test on its own: a face against the wrong
 * name goes onto the door screen, which exists to be recognised, and into the
 * HR record. Being unsure costs one dropdown. Being confidently wrong costs
 * somebody their face.
 *
 * So a match has to be clear of the runner-up rather than merely ahead of it.
 * "Ibañez.jpg" with three Ibañez on the team ties three ways and picks none.
 */
function bestMatch(filename, people) {
  const words = nameWords(filename);
  const scored = people.map((p) => ({ p, score: scoreName(words, p) }))
    .sort((a, b) => b.score - a.score);
  const [best, second] = scored;
  const sure = !!best && best.score > 0 && best.score > (second?.score ?? 0) * 1.5;
  return { who: sure ? best.p : null, sure };
}

function photosDialog(team, reload) {
  const here = team.filter((p) => p.here);

  RARE = rarityAcross(here);

  const options = (chosen) => `<option value="">— skip —</option>`
    + here.map((p) => `<option value="${p.id}"${String(p.id) === String(chosen)
        ? ' selected' : ''}>${esc(p.name)}${p.has_photo ? ' (has one)' : ''}</option>`).join('');

  let picked = [];

  const veil = dialog(`
    <h3>Photographs, all at once</h3>
    <div class="dim">Choose the whole folder. The filenames do the matching —
      anything it is unsure about is left for you to set, and nothing is saved
      until you press the button.</div>
    <div class="row mt">
      <div><label for="ph_files">The photographs</label>
        <input id="ph_files" type="file" accept="image/*" multiple></div>
    </div>
    <div id="ph_state" class="dim mt"></div>
    <div id="ph_grid" class="mt"></div>
    <div class="mt right">
      <button class="btn quiet" id="ph_cancel">Close</button>
      <button class="btn" id="ph_save" disabled>Save the photographs</button>
    </div>`, 'wide');

  const state = (text, kind = 'dim') => {
    $('#ph_state', veil).className = `${kind} mt`;
    $('#ph_state', veil).textContent = text;
  };

  const draw = () => {
    // Two files pointed at one person is the mistake this catches: it means a
    // name was matched twice and somebody else has nothing.
    const counts = new Map();
    for (const f of picked) {
      if (f.who) counts.set(f.who, (counts.get(f.who) || 0) + 1);
    }
    const clash = [...counts.values()].some((n) => n > 1);

    $('#ph_grid', veil).innerHTML = `<div class="photogrid">${picked.map((f, i) => `
      <div class="photopick${f.who ? '' : ' unsure'}${
          f.who && counts.get(f.who) > 1 ? ' clash' : ''}">
        <img src="${f.preview}" alt="">
        <div class="fn" title="${esc(f.file.name)}">${esc(f.file.name)}</div>
        <select data-pick="${i}">${options(f.who)}</select>
        ${f.who ? (counts.get(f.who) > 1
            ? '<div class="why bad">two photographs for this person</div>'
            : `<div class="why">${f.sure ? 'matched by name' : 'best guess — check it'}</div>`)
          : '<div class="why bad">no name matched</div>'}
      </div>`).join('')}</div>`;

    $$('[data-pick]', veil).forEach((s) => s.addEventListener('change', () => {
      picked[Number(s.dataset.pick)].who = s.value;
      picked[Number(s.dataset.pick)].sure = true;
      draw();
    }));

    const ready = picked.filter((f) => f.who).length;
    $('#ph_save', veil).disabled = !ready || clash;
    $('#ph_save', veil).textContent = clash
      ? 'Two photographs share a name'
      : `Save ${ready} photograph${ready === 1 ? '' : 's'}`;
    const unsure = picked.filter((f) => !f.who).length;
    state(`${picked.length} chosen · ${ready} matched${
      unsure ? ` · ${unsure} need a name` : ''}`, unsure || clash ? 'warn' : 'dim');
  };

  $('#ph_files', veil).addEventListener('change', async (e) => {
    const files = [...e.target.files];
    if (!files.length) return;
    state(`Reading ${files.length} photographs…`);
    picked = [];
    for (const file of files) {
      let preview;
      try {
        preview = await shrink(file, 220, 0.7);
      } catch { continue; }               // not an image; the folder may hold others
      const match = bestMatch(file.name, here);
      picked.push({
        file, preview,
        sure: match.sure,
        who: match.who ? String(match.who.id) : '',
      });
    }
    draw();
  });

  $('#ph_cancel', veil).addEventListener('click', closeDialog);

  $('#ph_save', veil).addEventListener('click', async () => {
    const jobs = picked.filter((f) => f.who);
    const button = $('#ph_save', veil);
    button.disabled = true;
    let done = 0;
    const failed = [];
    for (const job of jobs) {
      try {
        await POST(`/api/team/${job.who}/photo`, { dataUrl: await shrink(job.file, 600) });
        done++;
      } catch (e) {
        failed.push(`${job.file.name}: ${e.message}`);
      }
      state(`Saving… ${done + failed.length} of ${jobs.length}`);
    }
    closeDialog();
    notice(failed.length
      ? `${done} saved, ${failed.length} would not: ${failed[0]}`
      : `${done} photograph${done === 1 ? '' : 's'} saved 🌸`,
      failed.length ? 'bad' : 'good');
    reload();
  });
}

/**
 * The same job as photosDialog, for products rather than people.
 *
 * The difference that matters: a product has a code, and a code in a filename
 * is not a guess. "MS-TOT001.png" is that product and nothing else, however
 * the rest of the filename reads. So the code is tried first and exactly;
 * only a filename without one falls through to matching on the name, where
 * the same rule as for faces applies — a match has to be clear of the
 * runner-up, and being unsure costs one dropdown.
 */
function productPhotosDialog(products, reload) {
  const sellable = products.filter((p) => p.active);
  RARE = rarityAcross(sellable);

  // Longest code first: MS-TOT0011 must not be claimed by MS-TOT001.
  const codes = sellable.map((p) => p.sku)
    .sort((a, b) => b.length - a.length);

  const bySku = new Map(sellable.map((p) => [p.sku, p]));

  const matchProduct = (filename) => {
    const flat = filename.toUpperCase().replace(/[^A-Z0-9]/g, '');
    const hit = codes.find((sku) => flat.includes(sku.toUpperCase().replace(/[^A-Z0-9]/g, '')));
    if (hit) return { who: bySku.get(hit), sure: true };
    return bestMatch(filename, sellable);
  };

  const options = (chosen) => '<option value="">— skip —</option>'
    + sellable.map((p) => `<option value="${esc(p.sku)}"${p.sku === chosen ? ' selected' : ''}>${
        esc(p.name)}${p.has_photo ? ' (has one)' : ''}</option>`).join('');

  let picked = [];

  const veil = dialog(`
    <h3>Pictures, all at once</h3>
    <div class="dim">Choose the whole folder. A product code in the filename is
      taken as certain, and a name it can match beyond doubt is too — anything
      else is skipped rather than guessed at, and you can set it by hand if you
      know. Nothing is saved until you press the button. Big pictures are shrunk
      here before they are sent, so the originals stay on this machine.</div>
    <div class="row mt">
      <div><label for="pp_files">The pictures</label>
        <input id="pp_files" type="file" accept="image/*" multiple></div>
    </div>
    <div id="pp_state" class="dim mt"></div>
    <div id="pp_grid" class="mt"></div>
    <div class="mt right">
      <button class="btn quiet" id="pp_cancel">Close</button>
      <button class="btn" id="pp_save" disabled>Save the pictures</button>
    </div>`, 'wide');

  const state = (text, kind = 'dim') => {
    $('#pp_state', veil).className = `${kind} mt`;
    $('#pp_state', veil).textContent = text;
  };

  const draw = () => {
    const counts = new Map();
    for (const f of picked) {
      if (f.sku) counts.set(f.sku, (counts.get(f.sku) || 0) + 1);
    }
    const clash = [...counts.values()].some((n) => n > 1);

    $('#pp_grid', veil).innerHTML = `<div class="photogrid">${picked.map((f, i) => `
      <div class="photopick${f.sku ? '' : ' unsure'}${
          f.sku && counts.get(f.sku) > 1 ? ' clash' : ''}">
        <img src="${f.preview}" alt="">
        <div class="fn" title="${esc(f.file.name)}">${esc(f.file.name)}</div>
        <select data-pick="${i}">${options(f.sku)}</select>
        ${f.sku ? (counts.get(f.sku) > 1
            ? '<div class="why bad">two pictures for this product</div>'
            : '<div class="why">matched by code</div>')
          : '<div class="why">no certain match — will be skipped</div>'}
      </div>`).join('')}</div>`;

    $$('[data-pick]', veil).forEach((s) => s.addEventListener('change', () => {
      picked[Number(s.dataset.pick)].sku = s.value;
      draw();
    }));

    const ready = picked.filter((f) => f.sku).length;
    $('#pp_save', veil).disabled = !ready || clash;
    $('#pp_save', veil).textContent = clash
      ? 'Two pictures share a product'
      : `Save ${ready} picture${ready === 1 ? '' : 's'}`;
    // Skipping is a normal outcome, not a problem to fix: a folder may hold
    // pictures of things not on the price list at all. Only a clash is amber.
    const skipped = picked.filter((f) => !f.sku).length;
    state(`${picked.length} chosen · ${ready} matched${
      skipped ? ` · ${skipped} skipped` : ''}`, clash ? 'warn' : 'dim');
  };

  $('#pp_files', veil).addEventListener('change', async (e) => {
    const files = [...e.target.files];
    if (!files.length) return;
    picked = [];
    let read = 0;
    for (const file of files) {
      state(`Reading ${++read} of ${files.length}…`);
      let preview;
      try {
        preview = await shrink(file, 220, 0.7);
      } catch { continue; }               // not an image; the folder may hold others
      // Only a match it is sure of is chosen for you. bestMatch answers with
      // nobody when the runner-up is close, and that stays nobody here: a
      // picture on the wrong product is worse than a product with no picture,
      // and the dropdown is one click away when you know better than it does.
      const match = matchProduct(file.name);
      picked.push({ file, preview, sku: match.who ? match.who.sku : '' });
    }
    draw();
  });

  $('#pp_cancel', veil).addEventListener('click', closeDialog);

  $('#pp_save', veil).addEventListener('click', async () => {
    const jobs = picked.filter((f) => f.sku);
    const button = $('#pp_save', veil);
    button.disabled = true;
    let done = 0;
    const failed = [];
    for (const job of jobs) {
      try {
        await POST(`/api/products/${encodeURIComponent(job.sku)}/photo`,
          { dataUrl: await shrink(job.file) });
        done++;
      } catch (e) {
        failed.push(`${job.file.name}: ${e.message}`);
      }
      state(`Saving… ${done + failed.length} of ${jobs.length}`);
    }
    closeDialog();
    notice(failed.length
      ? `${done} saved, ${failed.length} would not: ${failed[0]}`
      : `${done} picture${done === 1 ? '' : 's'} saved 🌸`,
      failed.length ? 'bad' : 'good');
    reload();
  });
}

// ===========================================================================
// Customers — who buys, how often, and what they are owed in points
// ===========================================================================
const STANDING = {
  active: ['green', 'bought recently'],
  slipping: ['amber', 'not for a month'],
  lapsed: ['red', 'not for three months'],
  'never bought': ['grey', 'never bought'],
};

SCREENS.crm = async (page) => {
  let term = '';
  page.innerHTML = `
    <div class="head"><h2>Customers</h2>
      <span class="hint">Everyone with a loyalty account, however they got one</span></div>
    <div class="tools">
      <input type="search" id="find" placeholder="Search by name or number…">
      <button class="btn" id="add">＋ Register someone</button>
    </div>
    <div class="tiles" id="tiles"></div>
    <div class="panel" id="list"></div>`;

  const load = async () => {
    const d = await GET(`/api/customers?q=${encodeURIComponent(term)}`);

    $('#tiles', page).innerHTML = `
      <div class="tile"><div class="big">${count(d.counts.all)}</div>
        <div class="label">On the list</div></div>
      <div class="tile good"><div class="big">${count(d.counts.active)}</div>
        <div class="label">Bought in the last month</div></div>
      <div class="tile warn"><div class="big">${count(d.counts.slipping)}</div>
        <div class="label">Slipping — a month or more</div></div>
      <div class="tile bad"><div class="big">${count(d.counts.lapsed)}</div>
        <div class="label">Lapsed — three months or more</div></div>
      <div class="tile"><div class="big">${count(d.points)}</div>
        <div class="label">Points owed across everyone</div></div>`;

    $('#list', page).innerHTML = table(d.customers, [
      { head: 'Name', cell: (c) => `<b>${esc(c.name)}</b>`
          + (c.claimed ? '' : ' ' + tag('not claimed', 'grey')) },
      { head: 'Number', cell: (c) => `<span class="dim">${esc(c.phone || '')}</span>` },
      { head: 'Standing', cell: (c) => {
          const [kind, why] = STANDING[c.standing] ?? ['grey', c.standing];
          return `${tag(c.standing, kind)} <span class="dim">${why}</span>`; } },
      { head: 'Orders', n: true, cell: (c) => count(c.orders) },
      { head: 'Spent', n: true, cell: (c) => peso(c.spent) },
      { head: 'Points', n: true, cell: (c) => `${count(c.points)}
          <span class="dim">${esc(c.tier)}</span>` },
      { head: 'Joined', cell: (c) => `${onDay(c.joined_at)}
          <span class="dim">${c.joined_via === 'counter' ? 'at the counter' : 'in the app'}</span>` },
      { head: '', cell: (c) => `<button class="btn sm quiet" data-open="${c.id}">Open</button>` },
    ], term ? 'Nobody matches that' : 'No customers yet');

    $$('[data-open]', page).forEach((b) => b.addEventListener('click', () => openCustomer(b.dataset.open)));
  };

  const openCustomer = async (id) => {
    let c;
    try { c = await GET(`/api/customers/${id}`); } catch (e) { return whoops(e); }
    const [kind] = STANDING[c.standing] ?? ['grey'];

    dialog(`
      <h3>${esc(c.name)}</h3>
      <div class="dim">${esc(c.phone || '')} · joined ${onDay(c.joined_at)}
        ${c.joined_via === 'counter' ? 'at the counter' : 'in the app'}
        ${c.claimed ? '' : ' · has not claimed the account yet'}</div>

      <div class="tiles mt">
        <div class="tile"><div class="big">${count(c.orders)}</div><div class="label">Orders</div></div>
        <div class="tile"><div class="big">${peso(c.spent)}</div><div class="label">Spent</div></div>
        <div class="tile"><div class="big">${count(c.points)}</div>
          <div class="label">Points · ${esc(c.tier)}</div></div>
      </div>
      <div class="tags">${tag(c.standing, kind)}
        ${c.last_bought ? `<span class="dim">last bought ${onDay(c.last_bought)}</span>` : ''}</div>

      <div><label>Note</label>
        <input id="c_note" type="text" value="${esc(c.note || '')}"
          placeholder="Skin type, what they like, anything worth remembering"></div>
      <div class="mt right"><button class="btn sm" id="c_save">Save note</button></div>

      <h3 class="mt">What they have bought</h3>
      <div id="c_hist"></div>`);

    $('#c_hist').innerHTML = table(c.history || [], [
      { head: 'When', cell: (h) => when(h.at) },
      { head: 'Reference', cell: (h) => `<span class="dim">${esc(h.reference)}</span>` },
      { head: 'How', cell: (h) => h.how === 'counter'
          ? tag('at the counter', 'pink') : tag('reserved in the app', 'green') },
      { head: 'Total', n: true, cell: (h) => peso(h.total) },
      { head: 'Points', n: true, cell: (h) => count(h.points) },
    ], 'Nothing yet');

    $('#c_save').addEventListener('click', async () => {
      try {
        await PUT(`/api/customers/${id}/note`, { note: $('#c_note').value });
        notice('Saved 🌸', 'good');
        load();
      } catch (e) { whoops(e); }
    });
  };

  $('#find', page).addEventListener('input', (e) => {
    term = e.target.value;
    load().catch(whoops);
  });
  $('#add', page).addEventListener('click', () => {
    dialog(`
      <h3>Register a customer</h3>
      <div class="dim">Takes a name and a number. They set their own password
        later by joining in the app with the same number — their points will be
        waiting.</div>
      <div class="row mt">
        <div style="flex:2"><label>Name</label><input id="n_name" type="text"></div>
        <div><label>Mobile number</label><input id="n_phone" type="text"
          placeholder="09XX XXX XXXX"></div>
      </div>
      <div><label>Note</label><input id="n_note" type="text"
        placeholder="Optional"></div>
      <div class="mt right"><button class="btn" id="n_go">Register</button></div>`);

    $('#n_go').addEventListener('click', async () => {
      try {
        await POST('/api/customers', {
          name: $('#n_name').value, phone: $('#n_phone').value, note: $('#n_note').value,
        });
        closeDialog();
        notice('Registered 🌸', 'good');
        load();
      } catch (e) { whoops(e); }
    });
  });

  await load();
  repeat(load, 30000);
};

// ===========================================================================
// Finance — what came in, what it cost, what went out
// ===========================================================================
const EXPENSE_KINDS = ['stock', 'rent', 'wages', 'utilities', 'supplies',
                       'transport', 'marketing', 'fees', 'other'];

SCREENS.finance = async (page) => {
  const today = localDay();
  let from = localDay(29);
  let to = today;

  page.innerHTML = `
    <div class="head"><h2>Finance</h2>
      <span class="hint">Counter and wholesale kept apart, because they pay differently</span></div>
    <div class="tools">
      <label class="inline">From <input type="date" id="f_from" value="${from}"></label>
      <label class="inline">To <input type="date" id="f_to" value="${to}"></label>
      <button class="btn sm quiet" data-span="7">Last 7 days</button>
      <button class="btn sm quiet" data-span="30">Last 30</button>
      <button class="btn sm quiet" data-span="90">Last 90</button>
      <button class="btn" id="spend">＋ Record an expense</button>
    </div>
    <div id="body"></div>`;

  const load = async () => {
    const d = await GET(`/api/finance?from=${from}&to=${to}`);
    const money = (v) => peso(v || 0);

    $('#body', page).innerHTML = `
      <div class="tiles">
        <div class="tile good"><div class="big">${money(d.counter.revenue)}</div>
          <div class="label">Taken at the counter · ${count(d.counter.sales)} sale${
            Number(d.counter.sales) === 1 ? '' : 's'}</div></div>
        <div class="tile"><div class="big">${money(d.wholesale.invoiced)}</div>
          <div class="label">Invoiced to resellers</div></div>
        <div class="tile"><div class="big">${money(d.wholesale.received)}</div>
          <div class="label">Paid by resellers in this period</div></div>
        <div class="tile bad"><div class="big">${money(d.wholesale.outstanding)}</div>
          <div class="label">Still owed to you</div></div>
      </div>

      <div class="split">
        <div class="panel">
          <h3>What it left you</h3>
          <table>
            <tbody>
              <tr><td>Counter takings</td><td class="n">${money(d.counter.revenue)}</td></tr>
              <tr><td>Cost of what was sold</td><td class="n">−${money(d.counter.cost)}</td></tr>
              <tr><td>Wholesale invoiced</td><td class="n">${money(d.wholesale.invoiced)}</td></tr>
              <tr><td>Cost of what was shipped</td><td class="n">−${money(d.wholesale.cost)}</td></tr>
              <tr><td><b>Gross margin</b></td>
                  <td class="n"><b>${money(d.gross_margin)}</b></td></tr>
              <tr><td>Running costs</td><td class="n">−${money(d.expenses.total)}</td></tr>
              <tr><td><b>Profit</b></td>
                  <td class="n"><b>${money(d.net)}</b></td></tr>
            </tbody>
          </table>
          <div class="dim mt">Stock bought does not appear here on purpose: its cost
            already comes off as “cost of what was sold”, and counting it twice
            would make every figure wrong. It is in the cash column instead.</div>

          <h3 class="mt">Cash</h3>
          <table>
            <tbody>
              <tr><td>Taken at the counter</td><td class="n">${money(d.counter.revenue)}</td></tr>
              <tr><td>Paid by resellers</td><td class="n">${money(d.wholesale.received)}</td></tr>
              <tr><td>Stock bought</td><td class="n">−${money(d.stock_bought)}</td></tr>
              <tr><td>Running costs</td><td class="n">−${money(d.expenses.total)}</td></tr>
              <tr><td><b>${Number(d.cash.movement) < 0 ? 'Down by' : 'Up by'}</b></td>
                  <td class="n"><b>${money(Math.abs(Number(d.cash.movement)))}</b></td></tr>
            </tbody>
          </table>
          <div class="dim mt">A shop can be profitable and still short of cash — buy a
            quarter's stock in one week and this column says so while the one above
            looks fine.</div>
          ${d.counter.fully_costed ? '' : `
            <div class="banner warn mt">Some sales in this period were rung up before
              the system started keeping the cost of each line, so their margin uses
              today's cost price rather than the one at the time.</div>`}
        </div>

        <div class="panel">
          <h3>How the counter was paid</h3>
          ${Object.keys(d.counter.by_method || {}).length ? `
            <table><tbody>${Object.entries(d.counter.by_method).map(([m, v]) => `
              <tr><td>${esc(m === 'gcash' ? 'GCash' : m[0].toUpperCase() + m.slice(1))}</td>
                  <td class="n">${money(v)}</td></tr>`).join('')}
            </tbody></table>` : '<div class="none">Nothing taken in this period</div>'}

          <h3 class="mt">Where the money went</h3>
          ${Object.keys(d.expenses.by_kind || {}).length ? `
            <table><tbody>${Object.entries(d.expenses.by_kind)
              .sort((a, b) => Number(b[1]) - Number(a[1])).map(([k, v]) => `
              <tr><td>${esc(k[0].toUpperCase() + k.slice(1))}</td>
                  <td class="n">${money(v)}</td></tr>`).join('')}
            </tbody></table>` : '<div class="none">No expenses recorded yet</div>'}

          <div class="dim mt">Stock on the shelves is worth ${money(d.stock_at_cost)} at cost.</div>
        </div>
      </div>

      <div class="panel"><h3>Expenses</h3><div id="ex"></div></div>`;

    $('#ex', page).innerHTML = table(d.entries, [
      { head: 'Date', cell: (e) => onDay(e.spent_on) },
      { head: 'Kind', cell: (e) => tag(e.kind, e.voided ? 'grey' : 'pink') },
      { head: 'What for', cell: (e) => e.voided
          ? `<s class="dim">${esc(e.description)}</s>
             <span class="dim">— voided: ${esc(e.void_reason || '')}</span>`
          : esc(e.description) },
      { head: 'Paid by', cell: (e) => esc(e.method) },
      { head: 'Amount', n: true, cell: (e) => e.voided
          ? `<s class="dim">${peso(e.amount)}</s>` : peso(e.amount) },
      { head: '', cell: (e) => e.voided ? ''
          : `<button class="btn sm quiet" data-void="${e.id}">Void</button>` },
    ], 'Nothing recorded in this period');

    $$('[data-void]', page).forEach((b) => b.addEventListener('click', async () => {
      const reason = prompt('Why is this being voided?');
      if (!reason) return;
      try {
        await POST(`/api/expenses/${b.dataset.void}/void`, { reason });
        notice('Voided — the entry stays on the books', 'good');
        load();
      } catch (e) { whoops(e); }
    }));
  };

  $$('[data-span]', page).forEach((b) => b.addEventListener('click', () => {
    from = localDay(Number(b.dataset.span) - 1);
    to = today;
    $('#f_from', page).value = from;
    $('#f_to', page).value = to;
    load().catch(whoops);
  }));
  $('#f_from', page).addEventListener('change', (e) => { from = e.target.value; load().catch(whoops); });
  $('#f_to', page).addEventListener('change', (e) => { to = e.target.value; load().catch(whoops); });

  $('#spend', page).addEventListener('click', () => {
    dialog(`
      <h3>Record an expense</h3>
      <div class="row">
        <div><label>Kind</label>
          <select id="e_kind">
            ${EXPENSE_KINDS.map((k) => `<option value="${k}">${k[0].toUpperCase() + k.slice(1)}</option>`).join('')}
          </select></div>
        <div style="flex:2"><label>What for</label>
          <input id="e_what" type="text" placeholder="Stall rent for August"></div>
      </div>
      <div class="row">
        <div><label>Amount</label><input id="e_amt" type="number" step="0.01" min="0.01"></div>
        <div><label>Paid by</label>
          <select id="e_method">
            <option value="cash">Cash</option><option value="gcash">GCash</option>
            <option value="card">Card</option><option value="bank">Bank transfer</option>
          </select></div>
        <div><label>Date</label><input id="e_on" type="date" value="${today}"></div>
      </div>
      <div class="dim mt">Nothing is ever deleted here. A mistake is voided with a
        reason, so the books can be relied on.</div>
      <div class="mt right"><button class="btn" id="e_go">Record it</button></div>`);

    $('#e_go').addEventListener('click', async () => {
      try {
        await POST('/api/expenses', {
          kind: $('#e_kind').value, description: $('#e_what').value,
          amount: Number($('#e_amt').value), method: $('#e_method').value,
          on: $('#e_on').value || null,
        });
        closeDialog();
        notice('Recorded 🌸', 'good');
        load();
      } catch (e) { whoops(e); }
    });
  });

  await load();
  repeat(load, 60000);
};

// ---------------------------------------------------------------------------
// HR — Adona's workspace
//
// Everywhere else in this system the subject is a product, a batch or a
// takings figure. Here it is a person, and the screen is arranged to read that
// way: who is here, who has asked for time off, who is being hired, what the
// month costs. The pay column is the reason this tab exists as its own place
// and not as three more buttons on Team.
// ---------------------------------------------------------------------------
const LEAVE_KINDS = {
  vacation: 'Vacation', sick: 'Sick', emergency: 'Emergency',
  unpaid: 'Unpaid', maternity: 'Maternity',
};
const STAGES = {
  applied: 'Applied', screening: 'Screening', interview: 'Interview',
  offer: 'Offer', hired: 'Hired', rejected: 'Not taken',
};
const leaveTag = (s) => tag({
  pending: 'Waiting', approved: 'Approved',
  declined: 'Declined', withdrawn: 'Withdrawn',
}[s] ?? s, { pending: 'amber', approved: 'green', declined: 'grey', withdrawn: 'grey' }[s]);

const stars = (n) => (n == null ? '<span class="dim">—</span>'
  : '★'.repeat(Math.round(n)) + '☆'.repeat(5 - Math.round(n)));

// Same version trick as a product picture and the board at the door: an
// address that changes only when the photograph does can be cached, so a
// screen that redraws on a timer stops re-fetching every face it shows.
const faceOf = (p, size = 34) => (p.has_photo
  ? `<img class="thumb" style="width:${size}px;height:${size}px;border-radius:50%"
       loading="lazy" src="/api/team/${p.id}/photo${
         p.photo_at ? `?v=${new Date(p.photo_at).getTime()}` : ''}" alt="">`
  : `<span class="thumb none-photo" style="width:${size}px;height:${size}px;border-radius:50%">🧑</span>`);

// One person, opened.
//
// HR's question about somebody is never one thing — their record, their hours,
// their leave, their reviews — and answering it used to mean four screens and
// a lot of scrolling. So a face is a thing you click, wherever a face appears,
// and everything about that person arrives in one panel with their attendance
// in it.
//
// Read-only throughout. The buttons that change somebody live on the HR screen
// where they always did; this is for looking, which is what it is opened for
// ninety-nine times out of a hundred.
async function openProfile(id) {
  dialog('<h3>Opening…</h3>', 'wide');
  let d;
  try {
    d = await GET(`/api/hr/people/${id}`);
  } catch (e) { closeDialog(); return whoops(e); }
  if (!$('#dialog')) return;             // they closed it while it loaded

  const p = d.person;
  const pay = p.salary == null ? null : `${peso(p.salary)} ${
    { monthly: 'a month', semi_monthly: 'twice a month', daily: 'a day' }[p.pay_period]
      ?? 'a month'}`;

  $('#dialog .dialog').innerHTML = `
    <div class="person-head">
      ${faceOf({ ...p, id }, 72)}
      <div>
        <h3 style="margin:0">${esc(p.name)}</h3>
        <div class="dim">${esc(p.position || '')}${
          p.branch ? ` · ${esc(p.branch)}` : ''}</div>
        <div class="dim">${p.department ? `${esc(p.department)} · ` : ''}With us since ${
          onDay(p.started_on)}</div>
        ${p.username ? `<div class="dim">Signs in as <code>${esc(p.username)}</code>
          · ${esc(roleName(p.signs_in_as))}</div>` : '<div class="dim">No sign-in</div>'}
      </div>
      <div style="margin-left:auto"><button class="btn quiet" id="pp_close">Close</button></div>
    </div>

    <div class="tiles mt">
      <div class="tile ${d.figures.still_on ? 'good' : ''}">
        <div class="big">${count(d.figures.days_present)}</div>
        <div class="label">Days in, last 30</div></div>
      <div class="tile"><div class="big">${count(d.figures.hours)}</div>
        <div class="label">Hours, last 30 days</div></div>
      <div class="tile"><div class="big">${count(p.leave_taken)} / ${count(p.leave_entitlement)}</div>
        <div class="label">Leave taken this year</div></div>
      ${pay ? `<div class="tile"><div class="big" style="font-size:1.1rem">${esc(pay)}</div>
        <div class="label">Pay</div></div>` : ''}
    </div>

    <div class="panel"><h3>🕒 Attendance — ${onDay(d.from)} to ${onDay(d.to)}</h3>
      ${table(d.shifts, [
        { head: 'Day', cell: (s) => onDay(s.business_date) },
        { head: 'In', cell: (s) => `<b>${esc(clockAt(s.started_at))}</b>` },
        { head: 'Out', cell: (s) => (s.ended_at
            ? `<b>${esc(clockAt(s.ended_at))}</b>` : tag('still on', 'green')) },
        { head: 'Hours', n: true, cell: (s) => hoursOf(s.worked) },
        { head: 'How', cell: (s) => howTag(s.started_how)
            + (s.ended_how && s.ended_how !== s.started_how
               ? ` <span class="dim">→</span> ${howTag(s.ended_how)}` : '') },
        { head: 'Note', cell: (s) => (s.note
            ? `<span class="dim">${esc(s.note)}</span>` : '') },
      ], 'No shifts in the last thirty days.')}</div>

    <div class="split">
      <div class="panel"><h3>🌴 Leave</h3>
        ${table(d.leave, [
          { head: 'Kind', cell: (l) => esc(LEAVE_KINDS[l.leave_type] ?? l.leave_type) },
          { head: 'From', cell: (l) => onDay(l.start_date) },
          { head: 'To', cell: (l) => onDay(l.end_date) },
          { head: 'Days', n: true, cell: (l) => count(l.days) },
          { head: 'Status', cell: (l) => leaveTag(l.status) },
        ], 'No leave asked for.')}</div>

      <div class="panel"><h3>⭐ Reviews</h3>
        ${d.appraisals.length ? d.appraisals.map((a) => `
          <div class="post"><div>
            <b>${esc(a.period)}</b> ${stars(a.rating)}
            ${a.strengths ? `<div class="dim">👍 ${esc(a.strengths)}</div>` : ''}
            ${a.improvements ? `<div class="dim">🎯 ${esc(a.improvements)}</div>` : ''}
            <div class="dim">${esc(a.reviewer || '')}</div>
          </div></div>`).join('') : '<div class="none">No reviews yet.</div>'}</div>
    </div>`;

  $('#pp_close').addEventListener('click', closeDialog);
}

// Anything carrying data-person opens that person. Wired once per screen
// rather than per row, so a table that grows a face next month is covered by
// having a face.
const wirePeople = (root) => $$('[data-person]', root).forEach((el) => {
  el.classList.add('clickable');
  el.addEventListener('click', () => openProfile(el.dataset.person));
});

SCREENS.hr = async (page) => {
  const load = async () => {
    const d = await GET('/api/hr');
    const waiting = d.leave.filter((l) => l.status === 'pending');
    const hiring = d.pipeline.filter((a) => !['hired', 'rejected'].includes(a.pipeline_stage));

    page.innerHTML = `
      <div class="head"><h2>Human resources</h2>
        <span class="hint">${count(d.figures.headcount)} people, two shops</span></div>

      <div class="tiles">
        <div class="tile"><div class="big">${count(d.figures.headcount)}</div>
          <div class="label">On the team today</div></div>
        <div class="tile ${waiting.length ? 'warn' : 'good'}"><div class="big">${waiting.length}</div>
          <div class="label">Leave waiting on you</div></div>
        <div class="tile"><div class="big">${hiring.length}</div>
          <div class="label">Candidates in play</div></div>
        ${/* Pay is stripped out of the reply for a view-only sign-in, so these
             two came through as null and drew "₱0.00" and the word "null" on
             the screen. A figure they may not see has no tile at all: a zero
             would be worse than nothing, because it reads as a fact. */
          d.figures.payroll_monthly == null ? '' : `
        <div class="tile good"><div class="big">${peso(d.figures.payroll_monthly)}</div>
          <div class="label">Monthly payroll on record</div></div>
        <div class="tile ${d.figures.unpaid ? 'warn' : 'good'}"><div class="big">${d.figures.unpaid}</div>
          <div class="label">Without a pay figure set</div></div>`}
      </div>

      <div class="panel"><h3>🌴 Leave waiting on a decision</h3>
        ${table(waiting, [
          { head: 'Who', cell: (l) => `<b>${esc(l.name)}</b>
              <div class="dim">${esc(l.position || '')}${l.branch ? ' · ' + esc(l.branch) : ''}</div>` },
          { head: 'Kind', cell: (l) => esc(LEAVE_KINDS[l.leave_type] ?? l.leave_type) },
          { head: 'From', cell: (l) => onDay(l.start_date) },
          { head: 'To', cell: (l) => onDay(l.end_date) },
          { head: 'Days', n: true, cell: (l) => count(l.days) },
          { head: 'Reason', cell: (l) => esc(l.reason || '—') },
          { head: '', cell: (l) => `
              <button class="btn sm" data-yes="${l.id}">Approve</button>
              <button class="btn line sm" data-no="${l.id}">Decline</button>` },
        ], 'Nobody is waiting on you 🌸')}</div>

      <div class="panel"><h3>👥 The company</h3>
        <div class="dim" style="margin-bottom:10px">Tap anybody to see their
          record, their hours and their leave.</div>
        ${table(d.people.filter((p) => p.here), [
          { head: '', cell: (p) => `<span data-person="${p.id}">${faceOf(p)}</span>` },
          { head: 'Name', cell: (p) => `<span data-person="${p.id}"><b>${esc(p.name)}</b>
              <div class="dim">${esc(p.position)}</div></span>` },
          { head: 'Shop', cell: (p) => esc(p.branch || '—') },
          { head: 'Department', cell: (p) => esc(p.department || '—') },
          { head: 'Started', cell: (p) => onDay(p.started_on) },
          { head: 'Pay', n: true, cell: (p) => (p.salary == null
              ? '<span class="dim">not set</span>'
              : `${peso(p.salary)}<div class="dim">${esc({
                  monthly: 'a month', semi_monthly: 'twice a month', daily: 'a day',
                }[p.pay_period] ?? p.pay_period)}</div>`) },
          { head: 'Leave', n: true, cell: (p) =>
              `${count(p.leave_taken)} / ${count(p.leave_entitlement)}` },
          { head: 'Reviews', cell: (p) => stars(p.avg_rating) },
          { head: 'Sign-in', cell: (p) => (p.username
              ? `<code>${esc(p.username)}</code>` : '<span class="dim">none</span>') },
          { head: '', cell: (p) => `
              <button class="btn line sm" data-pay="${p.id}">Employment</button>
              <button class="btn line sm" data-review="${p.id}">Review</button>` },
        ], 'Nobody on the team yet.')}</div>

      <div class="split">
        <div class="panel">
          <div class="head"><h3>🧾 Hiring</h3>
            <button class="btn sm" id="add_cand">＋ Candidate</button></div>
          ${table(d.pipeline, [
            { head: 'Candidate', cell: (a) => `<b>${esc(a.candidate_name)}</b>
                <div class="dim">${esc(a.phone || a.email || '')}</div>` },
            { head: 'For', cell: (a) => esc(a.target_role) },
            { head: 'Stage', cell: (a) => `<select data-stage="${a.id}">${
                Object.entries(STAGES).map(([v, label]) =>
                  `<option value="${v}"${v === a.pipeline_stage ? ' selected' : ''}>${esc(label)}</option>`
                ).join('')}</select>` },
            { head: 'Notes', cell: (a) => esc(a.notes || '—') },
          ], 'Nobody has applied yet.')}</div>

        <div class="panel">
          <div class="head"><h3>📢 Noticeboard</h3>
            <button class="btn sm" id="add_note">＋ Post</button></div>
          ${d.announcements.length ? d.announcements.map((a) => `
            <div class="post" style="display:flex;gap:10px;align-items:flex-start">
              <div style="flex:1"><b>${esc(a.title)}</b>
                <div class="dim">${esc(a.body)}</div>
                <div class="dim">${esc(a.posted_by)} · ${when(a.posted_at)}</div></div>
              <button class="btn line sm" data-drop="${a.id}">Take down</button>
            </div>`).join('') : '<div class="none">Nothing posted.</div>'}</div>
      </div>

      <div class="panel"><h3>⭐ Recent reviews</h3>
        ${table(d.appraisals, [
          { head: 'Who', cell: (a) => `<b>${esc(a.name)}</b>` },
          { head: 'Period', cell: (a) => esc(a.period) },
          { head: 'Rating', cell: (a) => stars(a.rating) },
          { head: 'Strengths', cell: (a) => esc(a.strengths || '—') },
          { head: 'To work on', cell: (a) => esc(a.improvements || '—') },
          { head: 'By', cell: (a) => `<span class="dim">${esc(a.reviewer)}</span>` },
        ], 'No reviews written yet.')}</div>`;

    const decide = async (id, status) => {
      try {
        await POST(`/api/hr/leave/${id}`, { status });
        notice(status === 'approved' ? 'Approved 🌸' : 'Declined', 'good');
        load();
      } catch (e) { whoops(e); }
    };
    $$('[data-yes]', page).forEach((b) =>
      b.addEventListener('click', () => decide(b.dataset.yes, 'approved')));
    $$('[data-no]', page).forEach((b) =>
      b.addEventListener('click', () => decide(b.dataset.no, 'declined')));

    $$('[data-pay]', page).forEach((b) => b.addEventListener('click', () =>
      employmentDialog(d.people.find((p) => String(p.id) === b.dataset.pay), load)));
    $$('[data-review]', page).forEach((b) => b.addEventListener('click', () =>
      reviewDialog(d.people.find((p) => String(p.id) === b.dataset.review), load)));

    $$('[data-stage]', page).forEach((sel) => sel.addEventListener('change', async () => {
      try {
        await POST(`/api/hr/pipeline/${sel.dataset.stage}`, { pipeline_stage: sel.value });
        notice('Moved 🌸', 'good');
        load();
      } catch (e) { whoops(e); load(); }
    }));

    $$('[data-drop]', page).forEach((b) => b.addEventListener('click', async () => {
      try {
        await DELETE(`/api/hr/announcements/${b.dataset.drop}`);
        load();
      } catch (e) { whoops(e); }
    }));

    $('#add_cand', page).addEventListener('click', () => candidateDialog(load));
    $('#add_note', page).addEventListener('click', () => announcementDialog(load));
    wirePeople(page);
  };

  await load();
  repeat(load, 60000);
};

function employmentDialog(person, done) {
  if (!person) return;
  dialog(`
    <h3>${esc(person.name)}</h3>
    <div class="dim">${esc(person.position)}${person.branch ? ' · ' + esc(person.branch) : ''}</div>
    <div class="row mt">
      <div><label>Department</label>
        <input id="h_dept" value="${esc(person.department || '')}" placeholder="Retail"></div>
      <div><label>Pay</label>
        <input id="h_pay" type="number" step="0.01" value="${person.salary ?? ''}"></div>
      <div><label>Paid</label>
        <select id="h_period">
          ${[['monthly', 'a month'], ['semi_monthly', 'twice a month'], ['daily', 'a day']]
            .map(([v, l]) => `<option value="${v}"${v === person.pay_period ? ' selected' : ''}>${l}</option>`).join('')}
        </select></div>
      <div><label>Leave days a year</label>
        <input id="h_leave" type="number" value="${person.leave_entitlement ?? 5}"></div>
    </div>
    <div class="dim mt">Pay is kept apart from the team list, so nobody but you
      can read it — not the till, not the stockroom, not the door screen.</div>
    <div class="mt"><button class="btn" id="h_go">Save</button>
      <button class="btn line" onclick="this.closest('.veil').remove()">Cancel</button></div>`);

  $('#h_go').addEventListener('click', async () => {
    try {
      await POST(`/api/hr/people/${person.id}/employment`, {
        department: $('#h_dept').value,
        salary: $('#h_pay').value === '' ? null : Number($('#h_pay').value),
        pay_period: $('#h_period').value,
        leave_entitlement: Number($('#h_leave').value),
      });
      closeDialog();
      notice('Saved 🌸', 'good');
      done();
    } catch (e) { whoops(e); }
  });
}

function reviewDialog(person, done) {
  if (!person) return;
  dialog(`
    <h3>Review — ${esc(person.name)}</h3>
    <div class="row mt">
      <div><label>Period</label>
        <input id="r_period" placeholder="${new Date().getFullYear()} first half"></div>
      <div><label>Rating</label>
        <select id="r_rating">${[5, 4, 3, 2, 1].map((n) =>
          `<option value="${n}"${n === 3 ? ' selected' : ''}>${'★'.repeat(n)}${'☆'.repeat(5 - n)}</option>`).join('')}</select></div>
    </div>
    <div class="mt"><label>What they do well</label>
      <textarea id="r_good" rows="3"></textarea></div>
    <div class="mt"><label>What to work on</label>
      <textarea id="r_work" rows="3"></textarea></div>
    <div class="dim mt">They will read this in their own workspace. A review
      nobody sees is a note, not a review.</div>
    <div class="mt"><button class="btn" id="r_go">Save the review</button>
      <button class="btn line" onclick="this.closest('.veil').remove()">Cancel</button></div>`);

  $('#r_go').addEventListener('click', async () => {
    try {
      await POST('/api/hr/appraisals', {
        employee_id: person.id, period: $('#r_period').value,
        rating: Number($('#r_rating').value),
        strengths: $('#r_good').value, improvements: $('#r_work').value,
      });
      closeDialog();
      notice('Saved 🌸', 'good');
      done();
    } catch (e) { whoops(e); }
  });
}

function candidateDialog(done) {
  dialog(`
    <h3>New candidate</h3>
    <div class="row mt">
      <div><label>Name</label><input id="c_name" autofocus></div>
      <div><label>Applying for</label><input id="c_role" placeholder="Beauty Consultant"></div>
      <div><label>Phone</label><input id="c_phone" inputmode="tel"></div>
      <div><label>Email</label><input id="c_email" type="email"></div>
    </div>
    <div class="mt"><label>Notes</label><textarea id="c_notes" rows="3"></textarea></div>
    <div class="mt"><button class="btn" id="c_go">Add</button>
      <button class="btn line" onclick="this.closest('.veil').remove()">Cancel</button></div>`);

  $('#c_go').addEventListener('click', async () => {
    try {
      await POST('/api/hr/pipeline', {
        candidate_name: $('#c_name').value, target_role: $('#c_role').value,
        phone: $('#c_phone').value, email: $('#c_email').value,
        notes: $('#c_notes').value,
      });
      closeDialog();
      notice('Added 🌸', 'good');
      done();
    } catch (e) { whoops(e); }
  });
}

function announcementDialog(done) {
  dialog(`
    <h3>Post to the noticeboard</h3>
    <div class="mt"><label>Title</label><input id="n_title" autofocus></div>
    <div class="mt"><label>What it says</label><textarea id="n_body" rows="4"></textarea></div>
    <div class="dim mt">Everybody with a sign-in sees this, in both shops.</div>
    <div class="mt"><button class="btn" id="n_go">Post</button>
      <button class="btn line" onclick="this.closest('.veil').remove()">Cancel</button></div>`);

  $('#n_go').addEventListener('click', async () => {
    try {
      await POST('/api/hr/announcements',
        { title: $('#n_title').value, body: $('#n_body').value });
      closeDialog();
      notice('Posted 🌸', 'good');
      done();
    } catch (e) { whoops(e); }
  });
}

// ---------------------------------------------------------------------------
// The staff workspace — one person, about themselves
//
// The whole screen is fed by /api/my, which takes no id. There is nothing on
// this page that could be pointed at somebody else, because there is no field
// in which somebody else could be named.
// ---------------------------------------------------------------------------
SCREENS.me = async (page) => {
  const load = async () => {
    const d = await GET('/api/my');
    const p = d.profile;
    page.innerHTML = `
      <div class="head"><h2>My record</h2>
        <span class="hint">Only you and HR see this page</span></div>

      <div class="panel">
        <div class="post">
          <div style="display:flex;gap:14px;align-items:center">
            ${p.has_photo
              ? '<img src="/api/my/photo" alt="" style="width:74px;height:74px;border-radius:50%;object-fit:cover">'
              : '<span class="thumb none-photo" style="width:74px;height:74px;border-radius:50%">🧑</span>'}
            <div><b style="font-size:1.15rem">${esc(p.name)}</b>
              <div class="dim">${esc(p.position)}${p.branch ? ' · ' + esc(p.branch) : ''}</div>
              <div class="dim">With us since ${onDay(p.started_on)}</div></div>
          </div>
        </div>
      </div>

      <div class="tiles">
        <div class="tile good"><div class="big">${count(p.leave_left)}</div>
          <div class="label">Leave days left this year</div></div>
        <div class="tile"><div class="big">${count(p.leave_taken)}</div>
          <div class="label">Days taken or asked for</div></div>
        <div class="tile"><div class="big">${esc(p.department || '—')}</div>
          <div class="label">Department</div></div>
        <div class="tile"><div class="big">${p.salary == null ? '—' : peso(p.salary)}</div>
          <div class="label">Your pay, ${esc({
            monthly: 'a month', semi_monthly: 'twice a month', daily: 'a day',
          }[p.pay_period] ?? 'a month')}</div></div>
      </div>

      <div class="split">
        <div class="panel"><h3>⏱️ My recent hours</h3>
          ${table(d.hours.slice(0, 14), [
            { head: 'Day', cell: (h) => onDay(h.business_date) },
            { head: 'On', cell: (h) => when(h.started_at).split(', ').pop() },
            { head: 'Off', cell: (h) => (h.ended_at ? when(h.ended_at).split(', ').pop()
              : tag('still on', 'green')) },
            { head: 'Worked', n: true, cell: (h) => hoursOf(h.worked) },
          ], 'No shifts recorded yet.')}</div>

        <div class="panel"><h3>⭐ My reviews</h3>
          ${d.appraisals.length ? d.appraisals.map((a) => `
            <div class="post"><div>
              <b>${esc(a.period)}</b> ${stars(a.rating)}
              ${a.strengths ? `<div class="dim">👍 ${esc(a.strengths)}</div>` : ''}
              ${a.improvements ? `<div class="dim">🎯 ${esc(a.improvements)}</div>` : ''}
              <div class="dim">${esc(a.reviewer)} · ${when(a.created_at)}</div>
            </div></div>`).join('') : '<div class="none">No reviews yet.</div>'}</div>
      </div>`;
  };
  await load();
  repeat(load, 60000);
};

SCREENS.myleave = async (page) => {
  const load = async () => {
    const d = await GET('/api/my');
    const p = d.profile;
    page.innerHTML = `
      <div class="head"><h2>My leave</h2>
        <span class="hint">${count(p.leave_left)} of ${count(p.leave_entitlement)} days left</span></div>

      <div class="panel"><h3>Ask for time off</h3>
        <div class="row">
          <div><label>Kind</label><select id="l_kind">${
            Object.entries(LEAVE_KINDS).map(([v, l]) =>
              `<option value="${v}">${esc(l)}</option>`).join('')}</select></div>
          <div><label>From</label><input id="l_from" type="date" value="${localDay()}"></div>
          <div><label>To</label><input id="l_to" type="date" value="${localDay()}"></div>
        </div>
        <div class="mt"><label>Why (optional)</label><input id="l_why"></div>
        <div class="dim mt">HR decides these. Days you have asked for already
          count against what is left, so the number above is what you can still
          take rather than what you started the year with.</div>
        <div class="mt"><button class="btn" id="l_go">Send the request</button></div>
      </div>

      <div class="panel"><h3>What I have asked for</h3>
        ${table(d.leave, [
          { head: 'Kind', cell: (l) => esc(LEAVE_KINDS[l.leave_type] ?? l.leave_type) },
          { head: 'From', cell: (l) => onDay(l.start_date) },
          { head: 'To', cell: (l) => onDay(l.end_date) },
          { head: 'Days', n: true, cell: (l) => count(l.days) },
          { head: 'Why', cell: (l) => esc(l.reason || '—') },
          { head: 'Status', cell: (l) => leaveTag(l.status)
              + (l.decided_by ? `<div class="dim">${esc(l.decided_by)}</div>` : '') },
          { head: '', cell: (l) => (l.status === 'pending'
              ? `<button class="btn line sm" data-pull="${l.id}">Withdraw</button>` : '') },
        ], 'You have not asked for any leave.')}</div>`;

    $('#l_go', page).addEventListener('click', async () => {
      try {
        await POST('/api/my/leave', {
          leave_type: $('#l_kind').value, start_date: $('#l_from').value,
          end_date: $('#l_to').value, reason: $('#l_why').value,
        });
        notice('Sent to HR 🌸', 'good');
        load();
      } catch (e) { whoops(e); }
    });
    $$('[data-pull]', page).forEach((b) => b.addEventListener('click', async () => {
      try {
        await DELETE(`/api/my/leave/${b.dataset.pull}`);
        notice('Withdrawn', 'good');
        load();
      } catch (e) { whoops(e); }
    }));
  };
  await load();
};

SCREENS.notices = async (page) => {
  const load = async () => {
    const { announcements } = await GET('/api/noticeboard');
    page.innerHTML = `
      <div class="head"><h2>Noticeboard</h2>
        <span class="hint">From HR, to everybody</span></div>
      <div class="panel">
        ${announcements.length ? announcements.map((a) => `
          <div class="post"><div>
            <b>${esc(a.title)}</b>
            <div>${esc(a.body)}</div>
            <div class="dim">${esc(a.posted_by)} · ${when(a.posted_at)}</div>
          </div></div>`).join('') : '<div class="none">Nothing posted yet.</div>'}
      </div>`;
  };
  await load();
  repeat(load, 60000);
};

// ---------------------------------------------------------------------------
// Attendance — HR's view of the day
//
// Arranged around the question actually being asked, which is not "who is
// here" but "who is not". Whoever came in is listed in the order they arrived;
// everybody who did not is underneath, in their own block, because that block
// is the reason to open this screen at all.
// ---------------------------------------------------------------------------
const clockAt = (v) => (v ? new Date(v).toLocaleTimeString('en-PH',
  { hour: 'numeric', minute: '2-digit', timeZone: TZ }) : '—');

SCREENS.attendance = async (page) => {
  let day = localDay();
  let shop = '';

  const load = async () => {
    const d = await GET(`/api/hr/attendance?on=${encodeURIComponent(day)}${
      shop ? `&branch=${encodeURIComponent(shop)}` : ''}`);
    // The sheet names its people employee_id, because a row here is a day
    // rather than a person and the id is which person it is about. Everything
    // that draws a face expects `id`, so the two are reconciled once, here,
    // rather than at each of the places that show one.
    const people = d.people.map((p) => ({ ...p, id: p.employee_id }));
    const came = people.filter((p) => p.first_in);
    const missing = people.filter((p) => !p.first_in);
    const isToday = day === localDay();

    page.innerHTML = `
      <div class="head"><h2>Attendance</h2>
        <span class="hint">${isToday ? 'Today, updating on its own' : onDay(day)}</span></div>

      <div class="row">
        <div><label>Day</label><input id="a_day" type="date" value="${esc(day)}"
          max="${localDay()}"></div>
        <div><label>Shop</label><select id="a_shop">
          <option value="">Both shops</option>
          ${d.branches.map((b) => `<option value="${b.id}"${
            String(b.id) === String(shop) ? ' selected' : ''}>${esc(b.name)}</option>`).join('')}
        </select></div>
        <div style="flex:0 0 auto"><label>&nbsp;</label>
          <button class="btn line" id="a_yesterday">◀ Day before</button></div>
        <div style="flex:0 0 auto"><label>&nbsp;</label>
          <button class="btn line" id="a_today">Today</button></div>
      </div>

      <div class="tiles mt">
        <div class="tile good"><div class="big">${count(d.figures.present)}</div>
          <div class="label">Came in</div></div>
        <div class="tile ${d.figures.absent ? 'warn' : 'good'}">
          <div class="big">${count(d.figures.absent)}</div>
          <div class="label">Did not clock on</div></div>
        <div class="tile"><div class="big">${count(d.figures.still_on)}</div>
          <div class="label">Still on shift</div></div>
        <div class="tile"><div class="big">${count(d.figures.onbooks)}</div>
          <div class="label">On the books</div></div>
      </div>

      <div class="panel"><h3>🟢 Came in — ${count(came.length)}</h3>
        ${table(came, [
          { head: '', cell: (p) => `<span data-person="${p.id}">${faceOf(p)}</span>` },
          { head: 'Name', cell: (p) => `<span data-person="${p.id}"><b>${esc(p.name)}</b>
              <div class="dim">${esc(p.position)}</div></span>` },
          { head: 'Shop', cell: (p) => esc(p.branch || '—') },
          { head: 'In', cell: (p) => `<b>${esc(clockAt(p.first_in))}</b>` },
          { head: 'Out', cell: (p) => (p.still_on
              ? tag('still on', 'green') : `<b>${esc(clockAt(p.last_out))}</b>`) },
          { head: 'Hours', n: true, cell: (p) => hoursOf(p.worked) },
          // A day in more than one piece is worth seeing: a break, or somebody
          // who went home at noon and came back.
          { head: 'Stretches', n: true, cell: (p) => (p.stretches > 1
              ? tag(`${p.stretches}×`, 'amber') : '<span class="dim">1</span>') },
        ], 'Nobody has clocked on.')}</div>

      <div class="panel"><h3>⚪ Did not clock on — ${count(missing.length)}</h3>
        ${missing.length ? `<div class="dim" style="margin-bottom:10px">
          Not the same as absent. Somebody may be on leave, or have forgotten
          the screen by the door.</div>` : ''}
        ${table(missing, [
          { head: '', cell: (p) => `<span data-person="${p.id}">${faceOf(p)}</span>` },
          { head: 'Name', cell: (p) => `<span data-person="${p.id}"><b>${esc(p.name)}</b>
              <div class="dim">${esc(p.position)}</div></span>` },
          { head: 'Shop', cell: (p) => esc(p.branch || '—') },
        ], 'Everybody clocked on 🌸')}</div>

      <div class="panel"><h3>🕒 Every press, in order</h3>
        ${howLine(d.stretches)}
        ${table(d.stretches, [
          { head: 'In', cell: (s) => esc(clockAt(s.started_at)) },
          { head: 'Out', cell: (s) => (s.ended_at
              ? esc(clockAt(s.ended_at)) : tag('open', 'green')) },
          { head: 'Who', cell: (s) => `<span data-person="${s.employee_id}"><b>${
              esc(s.name)}</b></span>` },
          { head: 'Shop', cell: (s) => esc(s.branch || '—') },
          { head: 'Worked', n: true, cell: (s) => hoursOf(s.worked) },
          // Which way they proved who they were, which is a different question
          // from who wrote the row. A door with a fingerprint reader on it
          // should be able to show people are actually using it, rather than
          // going back to the keypad every morning and nobody noticing.
          { head: 'How', cell: (s) => howTag(s.started_how)
              + (s.ended_how && s.ended_how !== s.started_how
                 ? ` <span class="dim">→</span> ${howTag(s.ended_how)}` : '') },
          // Who the screen recorded it as. 'Timekeeper' is the door itself,
          // which is what a normal day looks like; a person's name here means
          // somebody entered it from the back office, and that is worth being
          // able to see when hours are questioned.
          { head: 'Recorded by', cell: (s) => `<span class="dim">${esc(s.started_by)}${
              s.ended_by && s.ended_by !== s.started_by ? ` / ${esc(s.ended_by)}` : ''
            }</span>` },
          { head: 'Note', cell: (s) => (s.note
              ? `<span class="dim">${esc(s.note)}</span>` : '') },
        ], 'Nothing recorded on this day.')}</div>`;

    const go = (d2) => { day = d2; load().catch(whoops); };
    $('#a_day', page).addEventListener('change', (e) => go(e.target.value || localDay()));
    $('#a_shop', page).addEventListener('change', (e) => { shop = e.target.value; load().catch(whoops); });
    $('#a_today', page).addEventListener('click', () => go(localDay()));
    $('#a_yesterday', page).addEventListener('click', () => {
      const back = new Date(`${day}T12:00:00`);
      back.setDate(back.getDate() - 1);
      go(back.toLocaleDateString('en-CA', { timeZone: TZ }));
    });
    wirePeople(page);
  };

  await load();
  // Only today moves. Refreshing a day that has already finished would be
  // redrawing the same rows over somebody trying to read them.
  repeat(() => (day === localDay() ? load() : Promise.resolve()), 30000);
};

start();
