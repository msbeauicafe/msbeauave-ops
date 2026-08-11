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
// The basket lives in the browser until it is reserved: a shopper who is only
// browsing should not need an account, and a half-filled basket surviving a
// closed tab is the least surprising behaviour.
let basket = JSON.parse(localStorage.getItem('basket') || '{}');
const saveBasket = () => localStorage.setItem('basket', JSON.stringify(basket));
const basketCount = () => Object.values(basket).reduce((n, q) => n + q, 0);
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
      <button class="sh-cart" id="cart" aria-label="Basket">🛒${
        basketCount() ? `<span class="sh-cart-n">${basketCount()}</span>` : ''}</button>
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

  $('#cart').addEventListener('click', openBasket);

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
        ${[['toCollect', '📦', 'To collect'], ['collected', '✅', 'Collected'],
           ['cancelled', '↩️', 'Cancelled']].map(([k, icon, label]) => `
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
      <h4>How reserving works</h4>
      <p>Add what you want to the basket and reserve it. We hold it off the
         shelf until the end of the next day, and you pay at the counter when
         you collect — cash, GCash or card. One point for every ₱20 you spend.</p>
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

  $$('[data-purchases]').forEach((b) => b.addEventListener('click', () => {
    openPurchases(b.dataset.purchases);
  }));

  $$('[data-wallet]').forEach((b) => b.addEventListener('click', () => {
    const what = b.dataset.wallet;
    if (what === 'points') {
      note('Points', `You have ${me.points}. One point for every ₱20 spent, added `
        + 'when you collect. 500 points makes Silver, 2,000 makes Gold.');
    } else if (what === 'vouchers') {
      note('Vouchers', 'None yet. When we run one, it will appear here.');
    } else {
      note('How to pay', 'Cash, GCash, Maya or card — all at the counter when you '
        + 'collect. Nothing is charged in the app.');
    }
  }));
}

async function openPurchases(which) {
  let rows = [];
  try {
    rows = await GET('/api/shop/purchases');
  } catch (e) {
    return note('Could not load your purchases', e.message);
  }

  const want = { toCollect: 'reserved', collected: 'collected', cancelled: 'cancelled' }[which];
  const list = want ? rows.filter((r) => r.status === want) : rows;
  const label = { reserved: 'Waiting for you', collected: 'Collected', cancelled: 'Cancelled' };

  const sheet = document.createElement('div');
  sheet.className = 'sh-sheet';
  sheet.innerHTML = `
    <div class="sh-sheet-inner">
      <h2>${which === 'toCollect' ? 'To collect'
           : which === 'collected' ? 'Collected' : 'Cancelled'}</h2>
      ${list.length ? list.map((r) => `
        <div class="pu-card">
          <div class="pu-head"><b>${esc(r.code)}</b>
            <span class="pu-state ${esc(r.status)}">${esc(label[r.status])}</span></div>
          <div class="pu-items">${(r.lines || []).map((l) =>
            `${esc(l.name)} ×${l.qty}`).join('<br>')}</div>
          <div class="pu-foot">
            <b>${peso(r.total)}</b>
            ${r.status === 'reserved'
              ? `<span>hold until ${new Date(r.hold_until).toLocaleString('en-PH',
                  { dateStyle: 'medium', timeStyle: 'short' })}</span>`
              : r.status === 'collected'
                ? `<span>+${r.points_given} points</span>` : '<span></span>'}
          </div>
          ${r.status === 'reserved'
            ? `<button class="pu-drop" data-drop="${r.id}">Cancel this reservation</button>` : ''}
        </div>`).join('')
      : '<div class="sh-note">Nothing here.</div>'}
      <button class="sh-close">Close</button>
    </div>`;

  sheet.addEventListener('click', async (e) => {
    const t = e.target;
    if (t === sheet || t.classList.contains('sh-close')) return sheet.remove();
    if (t.dataset.drop) {
      t.disabled = true;
      try {
        await POST(`/api/shop/purchases/${t.dataset.drop}/cancel`, {});
        sheet.remove();
        await loadMe();
        await load();
        note('Cancelled', 'That reservation is dropped and the stock is back on the shelf.');
      } catch (err) {
        t.disabled = false;
        note('Could not cancel that', err.message);
      }
    }
  });
  document.body.appendChild(sheet);
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
      ${p.in_stock
        ? `<button class="me-go" data-add="${esc(p.sku)}">Add to basket</button>`
        : ''}
      <button class="sh-close">Close</button>
    </div>`;
  sheet.addEventListener('click', (e) => {
    if (e.target === sheet || e.target.classList.contains('sh-close')) sheet.remove();
    if (e.target.dataset && e.target.dataset.add) {
      basket[e.target.dataset.add] = (basket[e.target.dataset.add] || 0) + 1;
      saveBasket();
      sheet.remove();
      draw();
    }
  });
  document.body.appendChild(sheet);
}

// ---------------------------------------------------------------------------
// The basket
// ---------------------------------------------------------------------------
function openBasket() {
  const lines = Object.entries(basket)
    .map(([sku, qty]) => ({ ...goods.find((g) => g.sku === sku), sku, qty }))
    .filter((l) => l.name);
  const total = lines.reduce((sum, l) => sum + Number(l.price) * l.qty, 0);

  const sheet = document.createElement('div');
  sheet.className = 'sh-sheet';
  sheet.innerHTML = `
    <div class="sh-sheet-inner">
      <h2>Your basket</h2>
      ${lines.length ? lines.map((l) => `
        <div class="bk-line">
          <div class="bk-name">${esc(l.name)}<span>${peso(l.price)}</span></div>
          <div class="bk-qty">
            <button data-less="${esc(l.sku)}">−</button>
            <b>${l.qty}</b>
            <button data-more="${esc(l.sku)}">+</button>
          </div>
        </div>`).join('')
      : '<div class="sh-note">Nothing in it yet. Tap a product to add one.</div>'}

      ${lines.length ? `
        <div class="bk-total"><span>Total</span><b>${peso(total)}</b></div>
        ${me ? `
          <button class="me-go" id="reserve">Reserve for collection</button>
          <div class="sh-note">We hold these until the end of tomorrow. Pay at the
            counter when you collect — cash, GCash or card.</div>`
        : `<div class="sh-note">Sign in on the Me tab to reserve these.</div>`}`
      : ''}
      <button class="sh-close">Close</button>
    </div>`;

  sheet.addEventListener('click', async (e) => {
    const t = e.target;
    if (t === sheet || t.classList.contains('sh-close')) return sheet.remove();

    if (t.dataset.more) { basket[t.dataset.more] += 1; saveBasket(); sheet.remove(); draw(); openBasket(); }
    if (t.dataset.less) {
      basket[t.dataset.less] -= 1;
      if (basket[t.dataset.less] <= 0) delete basket[t.dataset.less];
      saveBasket(); sheet.remove(); draw(); openBasket();
    }

    if (t.id === 'reserve') {
      t.disabled = true;
      try {
        const out = await POST('/api/shop/reserve', {
          lines: Object.entries(basket).map(([sku, qty]) => ({ sku, qty })),
        });
        basket = {};
        saveBasket();
        sheet.remove();
        await loadMe();
        await load();
        note(`Reserved · ${out.code}`,
          `We are holding ${peso(out.total)} of stock for you until `
          + `${new Date(out.hold_until).toLocaleString('en-PH', { dateStyle: 'medium', timeStyle: 'short' })}. `
          + `Show this code at the counter.`);
      } catch (err) {
        t.disabled = false;
        note('Could not reserve that', err.message);
      }
    }
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
