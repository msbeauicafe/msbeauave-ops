// MS BEAU AVE — the customer shop.
//
// The catalogue here is the catalogue in the back office: same database, same
// products, same photographs. Add a product at the counter and it is in this
// window on the next refresh; take its picture and that is the picture a
// customer sees. Nothing on this page is invented or kept in the browser.
//
// It reads two open endpoints and writes nothing. There is no sign-in and no
// basket yet — see the note at the bottom of a product for what that means.

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const esc = (s) => String(s ?? '').replace(/[&<>"']/g,
  (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const peso = (v) => '₱' + Number(v || 0).toLocaleString('en-PH',
  { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const photoUrl = (sku) => `/api/products/${encodeURIComponent(sku)}/photo`;

async function POST(path, body) {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
  });
  const out = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(out.error || 'Something went wrong.');
  return out;
}

async function GET(path) {
  const res = await fetch(path, { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || 'Something went wrong.');
  return res.json();
}

let term = '';
let category = '';
let view = 'home';
let goods = [];
let categories = [];
let me = null;          // the signed-in shopper, or null
let meNumbers = null;   // their purchase counts and vouchers

// ---------------------------------------------------------------------------
// The frame: a band at the top, a page in the middle, four buttons at the
// bottom. Only the middle changes.
// ---------------------------------------------------------------------------
function draw() {
  const searchable = view === 'home' || view === 'shop';

  $('#app').innerHTML = `
    <header class="sh-header">
      <span class="logo-mark"><img src="/logo.jpg" alt=""></span>
      ${searchable ? `
        <label class="sh-search">🔍
          <input id="find" type="search" value="${esc(term)}"
            placeholder="Search skincare…" autocomplete="off">
        </label>`
      : `<h1 class="sh-title">${view === 'visit' ? 'Find us' : 'Me'}</h1>`}
    </header>

    <div class="sh-page" id="page">${
      view === 'home' ? homeView()
      : view === 'shop' ? shopView()
      : view === 'visit' ? visitView()
      : meView()}</div>

    <nav class="sh-nav">
      ${[['home', '🏠', 'Home'], ['shop', '🛍️', 'Shop'],
         ['visit', '📍', 'Visit'], ['me', '👤', 'Me']].map(([id, icon, label]) => `
        <button class="${view === id ? 'on' : ''}" data-nav="${id}">
          <i>${icon}</i>${label}</button>`).join('')}
    </nav>`;

  wire();
}

function wire() {
  const find = $('#find');
  if (find) {
    find.addEventListener('input', (e) => {
      term = e.target.value;
      clearTimeout(find.timer);
      // A keystroke per request would hammer the database from every phone in
      // the shop; a short pause turns a typed word into one query.
      find.timer = setTimeout(() => load().catch(oops), 250);
    });
    if (document.activeElement !== find && term) {
      find.focus();
      find.setSelectionRange(term.length, term.length);
    }
  }

  $$('[data-cat]').forEach((b) => b.addEventListener('click', () => {
    category = b.dataset.cat;
    draw();
  }));

  $$('[data-sku]').forEach((b) => b.addEventListener('click', () => {
    openProduct(goods.find((p) => p.sku === b.dataset.sku));
  }));

  if (view === 'me') wireMe();

  $$('[data-nav]').forEach((b) => b.addEventListener('click', () => {
    view = b.dataset.nav;
    // Coming back to a tab should not still be filtered by whatever was tapped
    // on the way out.
    if (view !== 'shop') category = '';
    window.scrollTo(0, 0);
    draw();
  }));
}

// ---------------------------------------------------------------------------
// Home — everything, newest thinking first
// ---------------------------------------------------------------------------
function homeView() {
  const shown = category ? goods.filter((p) => p.category === category) : goods;
  return `
    <div class="sh-wallet">
      <div><b>Free</b><span>skin check in store</span></div>
      <div><b>GCash · Maya</b><span>+ cash at the counter</span></div>
      <div><b>Same day</b><span>pick up in Cebu</span></div>
    </div>

    ${term ? '' : `
      <div class="sh-banner">
        <h3>Skincare, straight from the counter</h3>
        <p>Everything here is on our shelves right now. Reserve in store or message us.</p>
      </div>`}

    <div class="sh-rowhead">${term
      ? `${shown.length} result${shown.length === 1 ? '' : 's'} for “${esc(term)}”`
      : '✨ For you'}</div>
    ${grid(shown)}`;
}

// ---------------------------------------------------------------------------
// Shop — the same goods, entered through a category
// ---------------------------------------------------------------------------
function shopView() {
  const shown = category ? goods.filter((p) => p.category === category) : goods;
  return `
    <div class="sh-chips">
      <button class="${category ? '' : 'on'}" data-cat="">All</button>
      ${categories.map((c) => `
        <button class="${category === c.category ? 'on' : ''}" data-cat="${esc(c.category)}">
          ${esc(c.category)}</button>`).join('')}
    </div>
    <div class="sh-rowhead">${category ? esc(category) : 'Everything we stock'}
      <span class="sh-count">${shown.length}</span></div>
    ${grid(shown)}`;
}

function grid(list) {
  return `<div class="sh-feed" id="feed">
    ${list.length ? list.map((p) => `
      <button class="sh-card ${p.in_stock ? '' : 'gone'}" data-sku="${esc(p.sku)}">
        <div class="sh-img">${p.has_photo
          ? `<img src="${photoUrl(p.sku)}" alt="${esc(p.name)}" loading="lazy">` : '🧴'}</div>
        <div class="sh-body">
          <div class="sh-name">${esc(p.name)}</div>
          <div class="sh-brand">${esc(p.brand || '')}</div>
          <div class="sh-price">${peso(p.price)}</div>
          ${p.in_stock ? '' : '<div class="sh-out">Sold out</div>'}
        </div>
      </button>`).join('')
    : '<div class="sh-empty">Nothing matches that just yet.<br>Try a different word.</div>'}
  </div>`;
}

// ---------------------------------------------------------------------------
// Visit — where we are and when we are open
// ---------------------------------------------------------------------------
function visitView() {
  return `
    <div class="sh-panel">
      <h4>MS BEAU AVE</h4>
      <p>Skincare, sold from our own counter. Come in for a free skin check —
         no appointment needed.</p>
    </div>

    <div class="sh-panel">
      <h4>Paying</h4>
      <p>GCash and Maya, bank transfer, or cash at the counter.</p>
    </div>

    <div class="sh-panel">
      <h4>Reserving something</h4>
      <p>Found something here you want held? Message us with the product name
         and we will keep it for you until the end of the day.</p>
    </div>

    <div class="sh-panel quiet">
      <h4>Our address and opening hours</h4>
      <p>Not published here yet. Ask us and we will point you to the counter.</p>
    </div>`;
}

// ---------------------------------------------------------------------------
// Me — honest about there being nothing here yet
// ---------------------------------------------------------------------------
function meView() {
  if (!me) return signedOutView();

  const initial = esc(me.name.trim()[0] || '?').toUpperCase();
  const n = meNumbers || { purchases: {}, vouchers: 0 };

  return `
    <div class="me-band">
      <div class="me-avatar">${initial}</div>
      <div class="me-who">
        <h3>${esc(me.name)}</h3>
        <span class="me-tier">${esc(me.tier)}</span>
      </div>
    </div>

    <div class="me-strip">
      <div><b>${me.points}</b><span>points</span></div>
      <div><b>${n.vouchers}</b><span>vouchers</span></div>
      <div><b>${me.tier === 'Gold' ? '—' : me.pointsToNext}</b><span>${
        me.tier === 'Gold' ? 'top tier' : 'to ' + (me.tier === 'Silver' ? 'Gold' : 'Silver')}</span></div>
    </div>

    <div class="me-card">
      <h4>My purchases <a data-purchases="all">See all ›</a></h4>
      <div class="me-icons">
        ${[['toPay', '🧾', 'To pay'], ['toCollect', '📦', 'To collect'],
           ['toReceive', '🚚', 'To receive'], ['toRate', '⭐', 'To rate']].map(([k, icon, label]) => `
          <button data-purchases="${k}">
            <i>${icon}</i>${label}
            ${n.purchases[k] ? `<span class="me-badge">${n.purchases[k]}</span>` : ''}
          </button>`).join('')}
      </div>
    </div>

    <div class="me-card">
      <h4>My wallet</h4>
      <div class="me-icons">
        <button data-wallet="points"><i>💗</i>Points</button>
        <button data-wallet="vouchers"><i>🎟️</i>Vouchers</button>
        <button data-wallet="pay"><i>📱</i>How to pay</button>
      </div>
    </div>

    <div class="sh-panel quiet">
      <h4>Buying in the app</h4>
      <p>Not switched on yet — that is why every count above is zero. Browse
         here, then buy at the counter or message us to reserve, and points will
         start landing on this account once ordering goes live.</p>
    </div>

    <div class="me-out"><button class="sh-close" id="signout">Sign out</button></div>`;
}

function signedOutView() {
  return `
    <div class="me-band signed-out">
      <div class="me-avatar">👤</div>
      <div class="me-who">
        <h3>Not signed in</h3>
        <span class="me-tier">Join to collect points</span>
      </div>
    </div>

    <div class="me-card">
      <h4 id="authTitle">Sign in</h4>
      <form id="authForm">
        <div id="nameRow" hidden>
          <label for="a_name">Your name</label>
          <input id="a_name" type="text" autocomplete="name">
        </div>
        <label for="a_phone">Mobile number</label>
        <input id="a_phone" type="tel" autocomplete="tel" placeholder="09XX XXX XXXX">
        <label for="a_pass">Password</label>
        <input id="a_pass" type="password" autocomplete="current-password">
        <div class="me-err" id="a_err" hidden></div>
        <button class="me-go" id="a_go" type="submit">Sign in</button>
      </form>
      <button class="me-swap" id="a_swap">New here? Create an account</button>
    </div>

    <div class="sh-panel quiet">
      <h4>What an account is for</h4>
      <p>Points on what you buy, and your purchases in one place once ordering
         in the app is switched on. Nothing is shared with anyone.</p>
    </div>`;
}

function wireMe() {
  const swap = $('#a_swap');
  if (swap) {
    let joining = false;
    const form = $('#authForm');

    swap.addEventListener('click', () => {
      joining = !joining;
      $('#nameRow').hidden = !joining;
      $('#authTitle').textContent = joining ? 'Create an account' : 'Sign in';
      $('#a_go').textContent = joining ? 'Create account' : 'Sign in';
      swap.textContent = joining ? 'Already have one? Sign in' : 'New here? Create an account';
      $('#a_pass').setAttribute('autocomplete', joining ? 'new-password' : 'current-password');
    });

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const err = $('#a_err');
      err.hidden = true;
      try {
        const payload = {
          phone: $('#a_phone').value,
          password: $('#a_pass').value,
          ...(joining ? { name: $('#a_name').value } : {}),
        };
        await POST(joining ? '/api/shop/join' : '/api/shop/login', payload);
        await loadMe();
        draw();
      } catch (e2) {
        err.textContent = e2.message;
        err.hidden = false;
      }
    });
  }

  const out = $('#signout');
  if (out) {
    out.addEventListener('click', async () => {
      await POST('/api/shop/logout', {});
      me = null;
      meNumbers = null;
      draw();
    });
  }

  $$('[data-purchases], [data-wallet]').forEach((b) => b.addEventListener('click', () => {
    note('Nothing here yet',
      'Buying in the app is not switched on. Once it is, your orders and points '
      + 'will appear here on their own.');
  }));
}

// A plain sheet for saying one thing, so a tap never lands on silence.
function note(title, body) {
  const sheet = document.createElement('div');
  sheet.className = 'sh-sheet';
  sheet.innerHTML = `
    <div class="sh-sheet-inner">
      <h2>${esc(title)}</h2>
      <div class="sh-note">${esc(body)}</div>
      <button class="sh-close">Close</button>
    </div>`;
  sheet.addEventListener('click', (e) => {
    if (e.target === sheet || e.target.classList.contains('sh-close')) sheet.remove();
  });
  document.body.appendChild(sheet);
}

function openProduct(p) {
  if (!p) return;
  const sheet = document.createElement('div');
  sheet.className = 'sh-sheet';
  sheet.innerHTML = `
    <div class="sh-sheet-inner">
      ${p.has_photo
        ? `<img class="big-img" src="${photoUrl(p.sku)}" alt="${esc(p.name)}">`
        : '<div class="big-img placeholder">🧴</div>'}
      <h2>${esc(p.name)}</h2>
      <div class="sh-brand">${esc(p.brand || '')}${p.category ? ' · ' + esc(p.category) : ''}</div>
      <div class="price">${peso(p.price)}</div>
      ${p.in_stock
        ? '<div class="sh-note">In stock at the counter today.</div>'
        : '<div class="sh-note">Sold out for now — message us and we will tell you when it lands.</div>'}
      <div class="sh-note">Ordering in the app is not switched on yet. Reserve this in store
        or send us a message, and we will hold it for you.</div>
      <button class="sh-close">Close</button>
    </div>`;
  sheet.addEventListener('click', (e) => {
    if (e.target === sheet || e.target.classList.contains('sh-close')) sheet.remove();
  });
  document.body.appendChild(sheet);
}

function oops(err) {
  const feed = $('#feed');
  if (feed) feed.innerHTML = `<div class="sh-empty">${esc(err.message)}</div>`;
}

async function loadMe() {
  const out = await GET('/api/shop/me');
  me = out.customer;
  meNumbers = out.customer ? { purchases: out.purchases, vouchers: out.vouchers } : null;
}

async function load() {
  goods = await GET(`/api/shop/catalog?q=${encodeURIComponent(term)}`);
  draw();
}

(async () => {
  try {
    categories = await GET('/api/shop/categories');
    await loadMe().catch(() => { me = null; });
    await load();
  } catch (err) {
    document.getElementById('app').innerHTML =
      `<div class="sh-empty">The shop could not be reached.<br>${esc(err.message)}</div>`;
  }
})();
