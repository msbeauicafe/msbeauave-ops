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

async function GET(path) {
  const res = await fetch(path, { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || 'Something went wrong.');
  return res.json();
}

let term = '';
let category = '';
let goods = [];
let categories = [];

function draw() {
  const shown = category ? goods.filter((p) => p.category === category) : goods;

  $('#app').innerHTML = `
    <header class="sh-header">
      <span class="logo-mark"><img src="/logo.jpg" alt=""></span>
      <label class="sh-search">🔍
        <input id="find" type="search" value="${esc(term)}"
          placeholder="Search skincare…" autocomplete="off">
      </label>
    </header>

    <div class="sh-wallet">
      <div><b>Free</b><span>skin check in store</span></div>
      <div><b>GCash · Maya</b><span>+ cash at the counter</span></div>
      <div><b>Same day</b><span>pick up in Cebu</span></div>
    </div>

    <div class="sh-chips">
      <button class="${category ? '' : 'on'}" data-cat="">All</button>
      ${categories.map((c) => `
        <button class="${category === c.category ? 'on' : ''}" data-cat="${esc(c.category)}">
          ${esc(c.category)}</button>`).join('')}
    </div>

    ${term || category ? '' : `
      <div class="sh-banner">
        <h3>Skincare, straight from the counter</h3>
        <p>Everything here is on our shelves right now. Reserve in store or ask us on Facebook.</p>
      </div>`}

    <div class="sh-rowhead">${
      term ? `${shown.length} result${shown.length === 1 ? '' : 's'} for “${esc(term)}”`
           : category ? esc(category) : '✨ For you'}</div>

    <div class="sh-feed" id="feed">
      ${shown.length ? shown.map((p) => `
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
      : `<div class="sh-empty">Nothing matches that just yet.<br>Try a different word.</div>`}
    </div>

    <nav class="sh-nav">
      <button class="on"><i>🏠</i>Home</button>
      <button data-nav="shop"><i>🛍️</i>Shop</button>
      <button data-nav="visit"><i>📍</i>Visit</button>
      <button data-nav="me"><i>👤</i>Me</button>
    </nav>`;

  const find = $('#find');
  find.addEventListener('input', (e) => {
    term = e.target.value;
    clearTimeout(find.timer);
    // A keystroke per request would hammer the database from every phone in
    // the shop; a short pause turns a typed word into one query.
    find.timer = setTimeout(() => load().catch(oops), 250);
  });

  $$('[data-cat]').forEach((b) => b.addEventListener('click', () => {
    category = b.dataset.cat;
    draw();
  }));

  $$('[data-sku]').forEach((b) => b.addEventListener('click', () => {
    openProduct(goods.find((p) => p.sku === b.dataset.sku));
  }));

  $$('[data-nav]').forEach((b) => b.addEventListener('click', () => {
    alert('That part of the app is still being built. The catalogue below is live.');
  }));

  if (document.activeElement !== find && term) {
    find.focus();
    find.setSelectionRange(term.length, term.length);
  }
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
  $('#feed').innerHTML = `<div class="sh-empty">${esc(err.message)}</div>`;
}

async function load() {
  goods = await GET(`/api/shop/catalog?q=${encodeURIComponent(term)}`);
  draw();
}

(async () => {
  try {
    categories = await GET('/api/shop/categories');
    await load();
  } catch (err) {
    document.getElementById('app').innerHTML =
      `<div class="sh-empty">The shop could not be reached.<br>${esc(err.message)}</div>`;
  }
})();
