// MS BEAU AVE — the whole front end.
//
// No framework and no build step: the file you read is the file that runs.
// Everything interpolated into markup goes through esc(), without exception —
// a product name is user input and must never be able to become markup.

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

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
async function call(method, path, body) {
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

function notice(text, kind = '') {
  const el = document.createElement('div');
  el.className = `notice ${kind}`;
  el.textContent = text;
  $('#notices').append(el);
  setTimeout(() => el.remove(), kind === 'bad' ? 6500 : 3500);
}
const whoops = (e) => notice(e.message, 'bad');

function dialog(html) {
  closeDialog();
  const veil = document.createElement('div');
  veil.className = 'veil';
  veil.id = 'dialog';
  veil.innerHTML = `<div class="dialog">${html}</div>`;
  veil.addEventListener('click', (e) => { if (e.target === veil) closeDialog(); });
  document.body.append(veil);
  return veil;
}
const closeDialog = () => $('#dialog')?.remove();

function repeat(fn, ms = 8000) {
  clearInterval(refreshTimer);
  refreshTimer = setInterval(() => { if (!$('#dialog')) fn().catch(() => {}); }, ms);
}

const tag = (text, kind) => `<span class="tag ${kind}">${esc(text)}</span>`;
const tierTag = (t) => tag(`Tier ${t}`, t === 3 ? 'green' : t === 2 ? 'pink' : 'grey');

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

function drawSignIn() {
  clearInterval(refreshTimer);
  $('#app').innerHTML = `
    <div class="signin-page"><form class="signin" id="signin">
      <span class="logo-mark"><img src="/logo.jpg" alt="MS BEAU AVE"></span>
      <h1 class="wordmark">MS BEAU AVE</h1>
      <p class="tag-line" style="margin:.2rem 0 1.4rem">Stock, till and reseller orders</p>
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
    ['products', '🧴', 'Products'],
    ['receive', '📦', 'Receive'],
    ['orders', '🚚', 'Wholesale'],
    ['resellers', '🤝', 'Resellers'],
    ['returns', '↩️', 'Returns'],
    ['reorder', '📈', 'Reordering'],
    ['reports', '📊', 'Reports'],
    ['stockroom', '🔀', 'Stockroom'],
    ['people', '👥', 'Sign-ins'],
  ],
  warehouse: [
    ['workspace', '🗂️', 'Workspace'],
    ['orders', '📋', 'Pick & send'],
    ['receive', '📦', 'Receive'],
    ['stockroom', '🔀', 'Stockroom'],
    ['restock', '🛎️', 'Shelf tasks'],
    ['reorder', '📈', 'Reordering'],
  ],
  cashier: [
    ['till', '🛍️', 'Till'],
    ['pickups', '📦', 'Pickups'],
    ['workspace', '🗂️', 'Workspace'],
    ['tillreturns', '↩️', 'Returns'],
    ['closeday', '🌙', 'Close of day'],
  ],
  reseller: [
    ['catalog', '🛒', 'Order stock'],
    ['myorders', '🚚', 'My orders'],
    ['account', '💳', 'Invoices'],
  ],
};

const roleName = (r) => ({
  admin: 'Owner', warehouse: 'Warehouse', cashier: 'Cashier', reseller: 'Reseller',
}[r] ?? r);

function drawFrame() {
  const tabs = TABS[user.role] ?? [];
  tab = tabs.some(([id]) => id === tab) ? tab : tabs[0][0];
  $('#app').innerHTML = `
    <div class="shell">
      <header class="app">
        <button id="navToggle" aria-label="Show the menu" aria-expanded="false">☰</button>
        <span class="logo-mark"><img src="/logo.jpg" alt=""></span>
        <h1 class="wordmark">MS BEAU AVE</h1>
        <span class="badge">${esc(roleName(user.role))}</span>
        <div class="spacer"></div>
        <div class="who"><b>${esc(user.name)}</b></div>
        <button class="btn line" id="signout">Sign out</button>
      </header>
      <nav class="tabs" id="tabs">
        ${tabs.map(([id, icon, label]) => `
          <button class="${id === tab ? 'on' : ''}" data-tab="${esc(id)}">
            <span aria-hidden="true">${icon}</span> ${esc(label)}</button>`).join('')}
      </nav>
      <main class="page" id="page"></main>
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
  $('#signout').addEventListener('click', async () => {
    await POST('/api/logout');
    user = null;
    drawSignIn();
  });

  clearInterval(refreshTimer);
  closeDialog();
  SCREENS[tab]?.($('#page')).catch(whoops);
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
        <div class="tile good"><div class="big">${peso(d.takings.total)}</div>
          <div class="label">Taken at the till today (${d.takings.sales} sale${d.takings.sales === 1 ? '' : 's'})</div></div>
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
    </div>
    <div class="panel" id="list"></div>`;

  $('#find', page).addEventListener('input', (e) => { term = e.target.value; load().catch(whoops); });
  $('#add', page).addEventListener('click', () => editProduct(null, load));
  await load();
  repeat(load, 15000);
};

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
SCREENS.receive = async (page) => {
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
        <div style="flex:0 0 auto"><button class="btn" id="r_go">Receive</button></div>
      </div>
      <datalist id="skus"></datalist>
      <div id="r_out" class="mt"></div>
    </div>
    <div class="panel"><h3>Just received</h3><div id="r_recent"></div></div>`;

  GET('/api/products?q=').then((rows) => {
    $('#skus', page).innerHTML = rows.map((p) =>
      `<option value="${esc(p.sku)}">${esc(p.name)}</option>`).join('');
  }).catch(() => {});

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

  $('#r_go', page).addEventListener('click', async () => {
    try {
      const r = await POST('/api/receive', {
        sku: $('#r_sku', page).value.trim(),
        batch_no: $('#r_batch', page).value.trim(),
        expiry: $('#r_exp', page).value,
        qty: +$('#r_qty', page).value,
      });
      const label = { b2b: 'Wholesale', shop: 'Shop', reserve: 'Reserve' };
      $('#r_out', page).innerHTML = `<div class="banner good">✅ Received and split —
        ${r.allocation.map((a) => `<b>${esc(label[a.pool] || a.pool)}</b> ${a.on_hand}`).join(' · ')}</div>`;
      $('#r_batch', page).value = '';
      $('#r_qty', page).value = '';
      recent();
    } catch (e) { whoops(e); }
  });

  await recent();
  repeat(recent, 15000);
};

// ===========================================================================
// Wholesale orders / picking
// ===========================================================================
SCREENS.orders = async (page) => {
  let status = '';
  const load = async () => {
    const rows = await GET(`/api/orders?status=${status}`);
    $('#board', page).innerHTML = table(rows, [
      { head: '#', cell: (o) => o.id },
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
  dialog(`
    <h3>Order ${o.id} — ${esc(o.reseller || 'counter sale')}</h3>
    <div class="tags">${orderTag(o)} ${o.tier ? tierTag(o.tier) : ''}
      ${o.invoice_id ? tag(`Invoice ${o.invoice_status} · due ${onDay(o.due_on)}`,
          o.invoice_status === 'paid' ? 'green' : 'amber') : ''}</div>
    <h3>Pick in this order</h3>
    <div class="dim">Soonest to expire first — that is what leaves the building.</div>
    ${table(o.lines, [
      { head: '#', cell: (_l, i) => '' },
      { head: 'Product', cell: (l) => esc(l.name) },
      { head: 'Batch', cell: (l) => `<b>${esc(l.batch_no)}</b>` },
      { head: 'Expires', cell: (l) => onDay(l.expiry) },
      { head: 'Qty', n: true, cell: (l) => count(l.qty) },
      { head: 'Price', n: true, cell: (l) => peso(l.unit_price) },
    ], 'No lines on this order.')}
    <div class="right mt"><b>Total ${peso(o.total)}</b></div>
    <div class="mt right">
      <button class="btn quiet" onclick="window.print()">🖨 Print picking slip</button>
      ${o.status === 'placed' ? '<button class="btn" id="a_pick">Start picking</button>' : ''}
      ${['placed', 'picking'].includes(o.status) ? `
        <button class="btn go" id="a_send">Dispatch</button>
        <button class="btn stop" id="a_cancel">Cancel</button>` : ''}
      ${o.status === 'fulfilled' && !o.delivered_at
        ? '<button class="btn go" id="a_delivered">Mark delivered</button>' : ''}
    </div>`);

  const act = (sel, path) => $(sel)?.addEventListener('click', async () => {
    try {
      const r = await POST(`/api/orders/${id}/${path}`);
      notice(r.message || 'Done', 'good');
      closeDialog();
      reload();
    } catch (e) { whoops(e); }
  });
  act('#a_pick', 'picking');
  act('#a_send', 'dispatch');
  act('#a_cancel', 'cancel');
  act('#a_delivered', 'deliver');
}

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
      { head: 'Reseller', cell: (r) => `<b>${esc(r.name)}</b>`
          + (r.email ? `<br><span class="dim">${esc(r.email)}</span>` : '') },
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
      { head: '', cell: (r) => `<button class="btn sm quiet" data-open="${r.id}">Open</button>` },
    ], 'No reseller accounts yet.');

    $$('[data-open]', page).forEach((b) => b.addEventListener('click',
      () => openReseller(+b.dataset.open, load).catch(whoops)));
  };

  page.innerHTML = `
    <div class="head"><h2>Resellers</h2>
      <span class="hint">Tier 1 pays first · Tier 2 gets terms · Tier 3 gets the best terms</span></div>
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
      ${tag(`owes ${peso(r.owed)}`, Number(r.owed) > 0 ? 'amber' : 'green')}</div>

    ${r.blocked || r.overdue ? `<div class="banner bad">Cannot order:
      ${esc(r.blocked_reason || 'there is a past-due invoice')}. Recording the payment
      lifts this by itself — an override below is only for when you have decided to
      let it through anyway.</div>` : ''}

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
      { head: '', cell: (i) => i.status === 'open'
          ? `<button class="btn sm" data-pay="${i.id}" data-owed="${i.balance}">Record payment</button>` : '' },
    ], 'No invoices yet.')}

    <h3 class="mt">History</h3>
    <div class="dim">${r.events.slice(0, 10).map((e) =>
      `${when(e.at)} — <b>${esc(e.kind)}</b> ${esc(JSON.stringify(e.detail || {}))}`).join('<br>')
      || 'Nothing yet.'}</div>`);

  $('#d_approve')?.addEventListener('click', async () => {
    try {
      await POST(`/api/resellers/${id}/approve`);
      notice('Approved 🌸', 'good');
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

  $$('[data-pay]').forEach((b) => b.addEventListener('click', () => {
    const owed = b.dataset.owed;
    dialog(`
      <h3>Record a payment</h3>
      <div class="row">
        <div><label>Amount received</label>
          <input id="p_amt" type="number" step="0.01" value="${owed}" autofocus></div>
        <div><label>Received on</label>
          <input id="p_on" type="date" value="${new Date().toISOString().slice(0, 10)}"></div>
      </div>
      <div class="dim mt">Paying a 30-day invoice within 10 days takes 2% off by itself.
        Clearing the last past-due invoice lets the account order again.</div>
      <div class="mt right"><button class="btn" id="p_save">Record</button></div>`);
    $('#p_save').addEventListener('click', async () => {
      try {
        await POST(`/api/invoices/${b.dataset.pay}/payment`,
          { amount: +$('#p_amt').value, paid_on: $('#p_on').value });
        notice('Payment recorded', 'good');
        openReseller(id, reload);
      } catch (e) { whoops(e); }
    });
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
  page.innerHTML = `
    <div class="head"><h2>Stockroom</h2></div>
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
    const rows = await GET(`/api/products/${encodeURIComponent(sku)}/batches`);
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
        </div></div>`).join('') : '<div class="none">Nothing received for that code.</div>';

    $$('[data-move]', page).forEach((btn) => btn.addEventListener('click', async () => {
      const id = btn.dataset.move;
      try {
        await POST('/api/move', {
          batchId: +id, from: $(`#mf_${id}`).value, to: $(`#mt_${id}`).value,
          qty: +$(`#mq_${id}`).value,
        });
        notice('Stock moved 🌸', 'good');
        findBatches();
      } catch (e) { whoops(e); }
    }));
  };
  $('#m_find', page).addEventListener('click', () => findBatches().catch(whoops));

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
        { sku: $('#c_sku', page).value.trim(), counted: +$('#c_qty', page).value });
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
  const today = new Date().toISOString().slice(0, 10);
  const monthAgo = new Date(Date.now() - 30 * 864e5).toISOString().slice(0, 10);

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
        ], 'Nothing outstanding.')}</div>`;
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
  const [users, resellers] = await Promise.all([GET('/api/users'), GET('/api/resellers')]);
  page.innerHTML = `
    <div class="head"><h2>Sign-ins</h2>
      <span class="hint">Switching someone off ends their session straight away</span></div>
    <div class="panel"><h3>Add a sign-in</h3>
      <div class="row">
        <div><label>Username</label><input id="u_name" type="text"></div>
        <div><label>Display name</label><input id="u_disp" type="text"></div>
        <div><label>Password</label><input id="u_pass" type="password"></div>
        <div><label>Can do</label><select id="u_role">
          <option value="admin">Everything (owner)</option>
          <option value="warehouse">Warehouse</option>
          <option value="cashier">Till</option>
          <option value="reseller">Reseller portal</option></select></div>
        <div id="u_link" style="display:none"><label>Which reseller</label><select id="u_res">
          ${resellers.map((r) => `<option value="${r.id}">${esc(r.name)}</option>`).join('')}
        </select></div>
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
      { head: 'State', cell: (u) => u.active ? tag('active', 'green') : tag('switched off', 'grey') },
      { head: '', cell: (u) => `
          <button class="btn sm quiet" data-flip="${u.id}" data-to="${u.active ? 0 : 1}">
            ${u.active ? 'Switch off' : 'Switch on'}</button>
          <button class="btn sm line" data-pw="${u.id}">New password</button>` },
    ], 'No sign-ins yet.');

    $$('[data-flip]', page).forEach((b) => b.addEventListener('click', async () => {
      try {
        await POST(`/api/users/${b.dataset.flip}/active`, { active: b.dataset.to === '1' });
        draw(await GET('/api/users'));
      } catch (e) { whoops(e); }
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
        reseller_id: $('#u_role', page).value === 'reseller' ? +$('#u_res', page).value : null,
      });
      notice('Sign-in created 🌸', 'good');
      $('#u_pass', page).value = '';
      draw(await GET('/api/users'));
    } catch (e) { whoops(e); }
  });
};

// ===========================================================================
// The till
// ===========================================================================
const basket = new Map();

SCREENS.till = async (page) => {
  let goods = [];

  page.innerHTML = `
    <div class="head"><h2>Till</h2><span class="hint">Sells from the shop shelf only</span></div>
    <div class="till">
      <div>
        <div class="tools"><input type="search" id="q"
          placeholder="Scan a barcode, or type a name…" autofocus></div>
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
    goods = await GET(`/api/till/products?q=${encodeURIComponent($('#q', page).value)}`);
    drawGoods();
  };

  $('#q', page).addEventListener('input', () => search().catch(whoops));
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
        method, tendered,
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
      <div class="mt right">
        <button class="btn quiet" onclick="window.print()">🖨 Print</button>
        <button class="btn" id="next">Next sale</button></div>`);
    $('#next').addEventListener('click', closeDialog);
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
    const inAMonth = new Date(Date.now() + 30 * 864e5).toISOString().slice(0, 10);
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

start();
