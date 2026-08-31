import '/reveal.js';   // an eye on the password box, like every other page
// MS BEAU AVE — Books. A standalone app on the same backend: sign in, keep the
// chart of accounts, post double-entry journal entries, read the trial balance
// and the two statements. The books are the owner's, so everything here is
// admin-only and the database says so; this page only draws what it is given.

const $ = (s, r = document) => r.querySelector(s);
const el = (t, c, h) => { const e = document.createElement(t); if (c) e.className = c; if (h != null) e.innerHTML = h; return e; };
const peso = (n) => '₱' + Number(n || 0).toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const onDay = (d) => d ? new Date(d).toLocaleDateString('en-PH', { year: 'numeric', month: 'short', day: 'numeric' }) : '';
const today = () => new Date().toISOString().slice(0, 10);

async function api(method, path, body) {
  const r = await fetch(path, {
    method, credentials: 'include',
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || 'Something went wrong.');
  return data;
}
const GET = (p) => api('GET', p);
const POST = (p, b) => api('POST', p, b || {});

function notice(text, kind) {
  const n = el('div', `notice ${kind || ''}`, esc(text));
  $('#notices').append(n);
  setTimeout(() => n.remove(), kind === 'bad' ? 6000 : 3200);
}

const root = () => $('#books');

// ---- sign in ----------------------------------------------------------------
function signInScreen(after) {
  root().innerHTML = `
    <div class="login-wrap">
      <div class="login-card">
        <div class="brand"><b>MS BEAU AVE</b><span>Books</span></div>
        <label>Username</label><input id="u" autofocus autocomplete="username">
        <label>Password</label><input id="p" type="password" autocomplete="current-password">
        <button class="btn wide" id="go">Sign in</button>
        <div class="dim mt">The books are the owner's. Sign in with an admin account.</div>
      </div>
    </div>`;
  const submit = async () => {
    try {
      await POST('/api/login', { username: $('#u').value.trim(), password: $('#p').value });
      after();
    } catch (e) { notice(e.message, 'bad'); }
  };
  $('#go').onclick = submit;
  $('#p').addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
}

// ---- the app ----------------------------------------------------------------
const TABS = [
  ['chart', 'Chart of accounts'],
  ['entry', 'New entry'],
  ['payables', 'Payables'],
  ['expenses', 'Expenses'],
  ['cash', 'Cash'],
  ['journal', 'Journal'],
  ['trial', 'Trial balance'],
  ['statements', 'Statements'],
  ['reports', 'Reports'],
];
let tab = 'trial';

async function shell(user) {
  root().innerHTML = `
    <header class="books-top">
      <div class="brand"><b>MS BEAU AVE</b><span>Books</span></div>
      <nav>${TABS.map(([id, label]) =>
        `<button data-tab="${id}" class="${id === tab ? 'on' : ''}">${esc(label)}</button>`).join('')}</nav>
      <div class="who"><span class="dim">${esc(user.name || user.username)}</span>
        <button class="btn quiet sm" id="out">Sign out</button></div>
    </header>
    <main id="page" class="page"></main>`;
  root().querySelectorAll('[data-tab]').forEach((b) => b.onclick = () => { tab = b.dataset.tab; shell(user); });
  $('#out').onclick = async () => { await POST('/api/logout').catch(() => {}); start(); };
  await SCREENS[tab]($('#page'));
}

const SCREENS = {};

SCREENS.chart = async (page) => {
  const rows = await GET('/api/books/accounts');
  const byType = {};
  rows.forEach((a) => (byType[a.type] ||= []).push(a));
  page.innerHTML = `<div class="head"><h2>Chart of accounts</h2>
      <span class="hint">${rows.length} accounts · seeded from the old system · tick Cash to count an account in the cash position</span>
      <button class="btn" id="add">＋ New account</button></div>
    ${Object.entries(byType).map(([type, list]) => `
      <div class="panel"><h3>${esc(type)}</h3>
        <table><thead><tr><th>Code</th><th>Title</th><th>Normal side</th><th class="n">Cash</th></tr></thead><tbody>
        ${list.map((a) => `<tr><td class="dim">${esc(a.code)}</td><td><b>${esc(a.title)}</b></td>
          <td>${esc(a.normal_side)}</td>
          <td class="n"><input type="checkbox" class="cashmark" data-code="${esc(a.code)}"${a.is_cash ? ' checked' : ''}></td></tr>`).join('')}
        </tbody></table></div>`).join('')}`;
  $('#add').onclick = () => accountDialog(() => shell_reload());
  page.querySelectorAll('.cashmark').forEach((c) => c.onchange = async () => {
    try {
      await POST('/api/books/cash/mark', { code: c.dataset.code, is_cash: c.checked });
      notice(c.checked ? 'Marked as cash 🌸' : 'No longer cash', 'good');
    } catch (e) { c.checked = !c.checked; notice(e.message, 'bad'); }
  });
};

function accountDialog(done) {
  const types = ['Asset', 'Contra Asset', 'Liability', 'Equity', 'Common',
    'Revenue', 'Contra Revenue', 'Expense', 'Contra Expense'];
  dialog(`<h3>New account</h3>
    <div class="row"><div><label>Code (optional)</label><input id="a_code"></div>
      <div style="flex:2"><label>Title</label><input id="a_title"></div></div>
    <div class="row"><div><label>Type</label><select id="a_type">${types.map((t) =>
        `<option>${t}</option>`).join('')}</select></div>
      <div><label>Normal side</label><select id="a_side"><option>debit</option><option>credit</option></select></div></div>
    <div class="mt right"><button class="btn quiet" id="a_x">Cancel</button>
      <button class="btn" id="a_go">Add</button></div>`);
  $('#a_x').onclick = closeDialog;
  $('#a_go').onclick = async () => {
    try {
      await POST('/api/books/accounts', {
        code: $('#a_code').value.trim(), title: $('#a_title').value.trim(),
        type: $('#a_type').value, normal_side: $('#a_side').value });
      closeDialog(); notice('Account added 🌸', 'good'); done();
    } catch (e) { notice(e.message, 'bad'); }
  };
}

SCREENS.entry = async (page) => {
  const accounts = await GET('/api/books/accounts');
  const opts = accounts.map((a) => `<option value="${esc(a.code)}">${esc(a.code)} — ${esc(a.title)}</option>`).join('');
  const line = (i) => `<tr class="jline">
      <td><select class="l_acct"><option value="">—</option>${opts}</select></td>
      <td><input class="l_debit n" inputmode="decimal" placeholder="0.00"></td>
      <td><input class="l_credit n" inputmode="decimal" placeholder="0.00"></td>
      <td><input class="l_memo" placeholder="(optional)"></td></tr>`;
  page.innerHTML = `<div class="head"><h2>New journal entry</h2>
      <span class="hint">Debits must equal credits</span></div>
    <div class="panel">
      <div class="row"><div><label>Date</label><input id="e_date" type="date" value="${today()}"></div>
        <div style="flex:3"><label>Memo</label><input id="e_memo" placeholder="What this posting is for"></div></div>
      <table class="lines mt"><thead><tr><th>Account</th><th>Debit</th><th>Credit</th><th>Memo</th></tr></thead>
        <tbody id="jbody">${line(0) + line(1) + line(2)}</tbody>
        <tfoot><tr><td class="right"><b>Totals</b></td><td class="n"><b id="td">₱0.00</b></td>
          <td class="n"><b id="tc">₱0.00</b></td><td id="bal"></td></tr></tfoot></table>
      <div class="mt right"><button class="btn quiet" id="more">＋ Add line</button>
        <button class="btn" id="post" disabled>Post entry</button></div>
    </div>`;
  const money = (v) => { const n = Number(String(v).replace(/[^0-9.]/g, '')); return Number.isFinite(n) ? n : 0; };
  const retotal = () => {
    let d = 0, c = 0;
    page.querySelectorAll('.jline').forEach((r) => { d += money($('.l_debit', r).value); c += money($('.l_credit', r).value); });
    $('#td').textContent = peso(d); $('#tc').textContent = peso(c);
    const ok = d > 0 && d === c;
    $('#bal').innerHTML = d === c ? '<span class="tag green">balanced</span>'
      : `<span class="tag red">off ${peso(Math.abs(d - c))}</span>`;
    $('#post').disabled = !ok;
  };
  page.addEventListener('input', retotal);
  $('#more').onclick = () => { $('#jbody').insertAdjacentHTML('beforeend', line(0)); };
  $('#post').onclick = async () => {
    const lines = [...page.querySelectorAll('.jline')].map((r) => ({
      account: $('.l_acct', r).value, debit: money($('.l_debit', r).value),
      credit: money($('.l_credit', r).value), memo: $('.l_memo', r).value.trim() || null,
    })).filter((l) => l.account && (l.debit > 0 || l.credit > 0));
    try {
      await POST('/api/books/journal', { entry_date: $('#e_date').value, memo: $('#e_memo').value.trim(), lines });
      notice('Posted 🌸', 'good'); tab = 'journal'; shell_reload();
    } catch (e) { notice(e.message, 'bad'); }
  };
  retotal();
};

// ---- payables & expenses share one thing: a grid of what-it-was-for lines ---
const money = (v) => { const n = Number(String(v).replace(/[^0-9.]/g, '')); return Number.isFinite(n) ? n : 0; };

function accountOptions(accounts, only) {
  const list = only ? accounts.filter(only) : accounts;
  return list.map((a) => `<option value="${esc(a.code)}">${esc(a.code)} — ${esc(a.title)}</option>`).join('');
}
// The cash accounts, or — if the owner has marked none — every asset account.
const cashAccounts = (accounts) => {
  const marked = accounts.filter((a) => a.is_cash);
  return marked.length ? marked : accounts.filter((a) => a.type === 'Asset');
};
const METHODS = ['cash', 'cheque', 'bank transfer', 'online'];
const methodField = (id) => `<label>Paid by</label><select id="${id}">${
  METHODS.map((m) => `<option>${m}</option>`).join('')}</select>`;
// A line grid: account · amount · memo, with a live total. Returns {html, wire, read}.
function lineGrid(accounts) {
  const opts = accountOptions(accounts);
  const line = () => `<tr class="bline">
      <td><select class="l_acct"><option value="">—</option>${opts}</select></td>
      <td><input class="l_amt n" inputmode="decimal" placeholder="0.00"></td>
      <td><input class="l_memo" placeholder="(optional)"></td>
      <td><button class="btn quiet sm l_del" title="Remove">✕</button></td></tr>`;
  const html = `<table class="lines mt"><thead><tr><th>Account</th><th>Amount</th><th>Memo</th><th></th></tr></thead>
      <tbody class="gbody">${line() + line()}</tbody>
      <tfoot><tr><td class="right"><b>Total</b></td><td class="n"><b class="gtotal">₱0.00</b></td><td></td>
        <td><button class="btn quiet sm gmore">＋</button></td></tr></tfoot></table>`;
  const wire = (root, onChange) => {
    const body = $('.gbody', root);
    const retotal = () => {
      let t = 0; root.querySelectorAll('.bline').forEach((r) => { t += money($('.l_amt', r).value); });
      $('.gtotal', root).textContent = peso(t);
      onChange && onChange(t);
    };
    root.addEventListener('input', retotal);
    $('.gmore', root).onclick = (e) => { e.preventDefault(); body.insertAdjacentHTML('beforeend', line()); };
    root.addEventListener('click', (e) => {
      if (e.target.closest('.l_del')) { e.preventDefault(); e.target.closest('tr').remove(); retotal(); }
    });
    retotal();
    return retotal;
  };
  const read = (root) => [...root.querySelectorAll('.bline')].map((r) => ({
    account: $('.l_acct', r).value, amount: money($('.l_amt', r).value),
    memo: $('.l_memo', r).value.trim() || null,
  })).filter((l) => l.account && l.amount > 0);
  return { html, wire, read };
}

SCREENS.payables = async (page) => {
  const [sum, bills, vendors, accounts] = await Promise.all([
    GET('/api/books/payables'), GET('/api/books/bills'),
    GET('/api/books/vendors'), GET('/api/books/accounts'),
  ]);
  const tag = (b) => {
    const late = b.due_date && String(b.due_date).slice(0, 10) < today() && b.status !== 'paid';
    if (b.status === 'paid') return '<span class="tag green">paid</span>';
    if (late) return '<span class="tag red">overdue</span>';
    if (b.status === 'part') return '<span class="tag">part-paid</span>';
    return '<span class="tag">open</span>';
  };
  page.innerHTML = `<div class="head"><h2>Payables</h2>
      <span class="hint">What the business owes its suppliers</span>
      <button class="btn quiet" id="vendor">Suppliers</button>
      <button class="btn" id="bill">＋ Record bill</button></div>
    <div class="panel"><div class="row" style="gap:32px">
      <div><div class="dim">Owed in total</div><div style="font-size:1.4rem"><b>${peso(sum.total_open)}</b></div></div>
      <div><div class="dim">Of that, overdue</div><div style="font-size:1.4rem"${sum.total_overdue > 0 ? ' class="due"' : ''}>
        <b>${peso(sum.total_overdue)}</b></div></div>
    </div></div>
    <div class="panel"><table class="lines"><thead><tr><th>Bill</th><th>Supplier</th><th>Dated</th><th>Due</th>
      <th class="n">Amount</th><th class="n">Paid</th><th class="n">Balance</th><th></th><th></th></tr></thead><tbody>
      ${bills.length ? bills.map((b) => `<tr>
        <td class="dim">${esc(b.bill_no)}${b.reference ? `<br><span class="dim">${esc(b.reference)}</span>` : ''}</td>
        <td><b>${esc(b.vendor)}</b>${b.memo ? `<br><span class="dim">${esc(b.memo)}</span>` : ''}</td>
        <td>${onDay(b.bill_date)}</td><td>${b.due_date ? onDay(b.due_date) : '<span class="dim">—</span>'}</td>
        <td class="n">${peso(b.amount)}</td><td class="n">${Number(b.paid) ? peso(b.paid) : ''}</td>
        <td class="n"><b>${peso(b.balance)}</b></td><td>${tag(b)}</td>
        <td>${b.status !== 'paid' ? `<button class="btn sm pay" data-id="${b.id}"
          data-bal="${b.balance}" data-who="${esc(b.vendor)}" data-no="${esc(b.bill_no)}">Pay</button>` : ''}</td></tr>`).join('')
        : '<tr><td colspan="9" class="dim">No bills recorded yet.</td></tr>'}
      </tbody></table></div>`;
  $('#bill').onclick = () => billDialog(vendors, accounts);
  $('#vendor').onclick = () => vendorList(vendors);
  page.querySelectorAll('.pay').forEach((btn) => btn.onclick = () => payDialog(btn.dataset, accounts));
};

function billDialog(vendors, accounts) {
  const grid = lineGrid(accounts);
  dialog(`<h3>Record a bill</h3>
    <div class="row"><div style="flex:2"><label>Supplier</label>
      <select id="b_vendor"><option value="">— pick a supplier —</option>
        ${vendors.map((v) => `<option value="${v.id}">${esc(v.name)}</option>`).join('')}</select></div>
      <div><label>Their ref</label><input id="b_ref" placeholder="DR / invoice no."></div></div>
    <div class="row"><div><label>Bill date</label><input id="b_date" type="date" value="${today()}"></div>
      <div><label>Due date</label><input id="b_due" type="date"></div>
      <div style="flex:2"><label>Memo</label><input id="b_memo" placeholder="What this bill is for"></div></div>
    <div id="b_grid">${grid.html}</div>
    <div class="mt right"><button class="btn quiet" id="b_x">Cancel</button>
      <button class="btn" id="b_go">Record bill</button></div>`);
  grid.wire($('#b_grid'));
  $('#b_x').onclick = closeDialog;
  $('#b_go').onclick = async () => {
    const lines = grid.read($('#b_grid'));
    if (!$('#b_vendor').value) return notice('Pick a supplier first.', 'bad');
    if (!lines.length) return notice('Add at least one line.', 'bad');
    try {
      await POST('/api/books/bills', {
        vendor_id: Number($('#b_vendor').value), bill_date: $('#b_date').value,
        due_date: $('#b_due').value || null, reference: $('#b_ref').value.trim(),
        memo: $('#b_memo').value.trim(), lines });
      closeDialog(); notice('Bill recorded 🌸', 'good'); shell_reload();
    } catch (e) { notice(e.message, 'bad'); }
  };
}

function payDialog(d, accounts) {
  dialog(`<h3>Pay ${esc(d.no)}</h3>
    <div class="dim">${esc(d.who)} · ${peso(d.bal)} still owed</div>
    <div class="row mt"><div><label>Date</label><input id="p_date" type="date" value="${today()}"></div>
      <div><label>Amount</label><input id="p_amt" class="n" inputmode="decimal" value="${Number(d.bal).toFixed(2)}"></div></div>
    <div class="row"><div><label>Paid from</label>
      <select id="p_from">${accountOptions(cashAccounts(accounts))}</select></div>
      <div>${methodField('p_method')}</div>
      <div><label>Reference / cheque no.</label><input id="p_ref" placeholder="(optional)"></div></div>
    <div class="row"><div style="flex:1"><label>Memo</label><input id="p_memo" placeholder="(optional)"></div></div>
    <div class="mt right"><button class="btn quiet" id="p_x">Cancel</button>
      <button class="btn" id="p_go">Record payment</button></div>`);
  $('#p_x').onclick = closeDialog;
  $('#p_go').onclick = async () => {
    try {
      await POST(`/api/books/bills/${d.id}/pay`, {
        pay_date: $('#p_date').value, amount: money($('#p_amt').value),
        paid_from: $('#p_from').value, method: $('#p_method').value, reference: $('#p_ref').value.trim(),
        memo: $('#p_memo').value.trim() });
      closeDialog(); notice('Payment recorded 🌸', 'good'); shell_reload();
    } catch (e) { notice(e.message, 'bad'); }
  };
}

function vendorList(vendors) {
  dialog(`<h3>Suppliers</h3>
    <div class="vendor-rows">${vendors.length ? vendors.map((v) => `<div class="row" style="justify-content:space-between">
      <div><b>${esc(v.name)}</b>${v.notes ? `<br><span class="dim">${esc(v.notes)}</span>` : ''}</div></div>`).join('')
      : '<div class="dim">No suppliers yet.</div>'}</div>
    <div class="row mt"><div style="flex:2"><label>New supplier</label><input id="v_name" placeholder="Name"></div>
      <div style="flex:1"><label>Notes</label><input id="v_notes" placeholder="(optional)"></div></div>
    <div class="mt right"><button class="btn quiet" id="v_x">Close</button>
      <button class="btn" id="v_go">Add supplier</button></div>`);
  $('#v_x').onclick = closeDialog;
  $('#v_go').onclick = async () => {
    if (!$('#v_name').value.trim()) return notice('A supplier needs a name.', 'bad');
    try {
      await POST('/api/books/vendors', { name: $('#v_name').value.trim(), notes: $('#v_notes').value.trim() });
      closeDialog(); notice('Supplier added 🌸', 'good'); shell_reload();
    } catch (e) { notice(e.message, 'bad'); }
  };
}

SCREENS.expenses = async (page) => {
  const [accounts, recent] = await Promise.all([GET('/api/books/accounts'), GET('/api/books/expenses')]);
  const grid = lineGrid(accounts);
  page.innerHTML = `<div class="head"><h2>Expenses</h2>
      <span class="hint">Money out, paid on the spot — no bill in between</span></div>
    <div class="panel">
      <div class="row"><div><label>Date</label><input id="x_date" type="date" value="${today()}"></div>
        <div><label>Paid from</label><select id="x_from">${accountOptions(cashAccounts(accounts))}</select></div>
        <div>${methodField('x_method')}</div>
        <div><label>Reference / cheque no.</label><input id="x_ref" placeholder="(optional)"></div></div>
      <div class="row"><div style="flex:1"><label>Memo</label><input id="x_memo" placeholder="What this was for"></div></div>
      <div id="x_grid">${grid.html}</div>
      <div class="mt right"><button class="btn" id="x_go" disabled>Record expense</button></div>
    </div>
    <div class="panel"><h3>Recent expenses</h3>
      ${recent.length ? `<table class="lines"><thead><tr><th>Date</th><th>Entry</th><th>What for</th>
        <th class="n">Amount</th></tr></thead><tbody>
        ${recent.map((e) => `<tr><td>${onDay(e.entry_date)}</td><td class="dim">${esc(e.entry_no)}</td>
          <td>${esc(e.memo)}${e.lines.length ? `<br><span class="dim">${e.lines.map((l) => esc(l.title)).join(', ')}</span>` : ''}</td>
          <td class="n"><b>${peso(e.total)}</b></td></tr>`).join('')}</tbody></table>`
        : '<div class="none">Nothing recorded yet.</div>'}</div>`;
  grid.wire($('#x_grid'), (t) => { $('#x_go').disabled = !(t > 0); });
  $('#x_go').onclick = async () => {
    const lines = grid.read($('#x_grid'));
    if (!lines.length) return notice('Add at least one line.', 'bad');
    try {
      await POST('/api/books/expenses', {
        pay_date: $('#x_date').value, paid_from: $('#x_from').value,
        method: $('#x_method').value, reference: $('#x_ref').value.trim(),
        memo: $('#x_memo').value.trim(), lines });
      notice('Expense recorded 🌸', 'good'); shell_reload();
    } catch (e) { notice(e.message, 'bad'); }
  };
};

SCREENS.cash = async (page) => {
  const [cash, disb, accounts] = await Promise.all([
    GET('/api/books/cash'), GET('/api/books/disbursements'), GET('/api/books/accounts'),
  ]);
  const move = (m) => {
    const inn = Number(m.debit), out = Number(m.credit);
    return `<tr><td>${onDay(m.entry_date)}</td><td class="dim">${esc(m.entry_no)}</td>
      <td>${esc(m.title)}</td><td>${esc(m.memo)}</td>
      <td class="n">${inn ? '<span class="tag green">' + peso(inn) + '</span>' : ''}</td>
      <td class="n">${out ? peso(out) : ''}</td></tr>`;
  };
  page.innerHTML = `<div class="head"><h2>Cash</h2>
      <span class="hint">Where the money is, and everything that moved it</span>
      <button class="btn" id="xfer">⇄ Transfer</button></div>
    <div class="panel"><div class="row" style="gap:24px;align-items:stretch">
      ${cash.accounts.map((a) => `<div class="cashcard"><div class="dim">${esc(a.title)}</div>
        <div style="font-size:1.3rem"><b>${peso(a.balance)}</b></div></div>`).join('')
        || '<div class="dim">No cash accounts marked yet — mark them on the Chart, or they default to your asset accounts.</div>'}
      <div class="cashcard total"><div class="dim">Cash on hand, all told</div>
        <div style="font-size:1.5rem"><b>${peso(cash.total)}</b></div></div>
    </div></div>
    <div class="panel"><h3>Disbursement vouchers</h3>
      ${disb.length ? `<table class="lines"><thead><tr><th>Voucher</th><th>Date</th><th>Paid to</th><th>For</th>
        <th>By</th><th class="n">Amount</th><th></th></tr></thead><tbody>
        ${disb.map((v, i) => `<tr><td class="dim">${esc(v.voucher_no)}</td><td>${onDay(v.paid_on)}</td>
          <td><b>${esc(v.payee)}</b></td><td>${esc(v.kind)}${v.bill_no ? ` · ${esc(v.bill_no)}` : ''}</td>
          <td>${esc(v.method)}${v.reference ? `<br><span class="dim">${esc(v.reference)}</span>` : ''}</td>
          <td class="n"><b>${peso(v.amount)}</b></td>
          <td><button class="btn quiet sm vch" data-i="${i}">Voucher</button></td></tr>`).join('')}</tbody></table>`
        : '<div class="none">No money out yet.</div>'}</div>
    <div class="panel"><h3>Recent cash movements</h3>
      ${cash.movements.length ? `<table class="lines"><thead><tr><th>Date</th><th>Entry</th><th>Account</th>
        <th>Memo</th><th class="n">In</th><th class="n">Out</th></tr></thead>
        <tbody>${cash.movements.map(move).join('')}</tbody></table>`
        : '<div class="none">Nothing has moved yet.</div>'}</div>`;
  $('#xfer').onclick = () => transferDialog(cashAccounts(accounts));
  page.querySelectorAll('.vch').forEach((b) => b.onclick = () => voucherDialog(disb[Number(b.dataset.i)]));
};

function transferDialog(cash) {
  if (cash.length < 2) return notice('You need at least two cash accounts to move money between.', 'bad');
  const opts = accountOptions(cash);
  dialog(`<h3>Move cash</h3>
    <div class="row"><div><label>From</label><select id="t_from">${opts}</select></div>
      <div><label>To</label><select id="t_to">${opts}</select></div></div>
    <div class="row"><div><label>Date</label><input id="t_date" type="date" value="${today()}"></div>
      <div><label>Amount</label><input id="t_amt" class="n" inputmode="decimal" placeholder="0.00"></div></div>
    <div class="row"><div style="flex:1"><label>Memo</label><input id="t_memo" placeholder="(optional)"></div></div>
    <div class="mt right"><button class="btn quiet" id="t_x">Cancel</button>
      <button class="btn" id="t_go">Move it</button></div>`);
  if (cash[1]) $('#t_to').value = cash[1].code;
  $('#t_x').onclick = closeDialog;
  $('#t_go').onclick = async () => {
    try {
      await POST('/api/books/transfer', {
        from: $('#t_from').value, to: $('#t_to').value, xfer_date: $('#t_date').value,
        amount: money($('#t_amt').value), memo: $('#t_memo').value.trim() });
      closeDialog(); notice('Cash moved 🌸', 'good'); shell_reload();
    } catch (e) { notice(e.message, 'bad'); }
  };
}

function voucherDialog(v) {
  dialog(`<div class="voucher">
      <div class="v-head"><div><b>MS BEAU AVE</b><div class="dim">Disbursement Voucher</div></div>
        <div class="right"><b>${esc(v.voucher_no)}</b><div class="dim">${onDay(v.paid_on)}</div></div></div>
      <table class="v-body"><tbody>
        <tr><td class="dim">Paid to</td><td><b>${esc(v.payee)}</b></td></tr>
        <tr><td class="dim">For</td><td>${esc(v.kind)}${v.bill_no ? ` · ${esc(v.bill_no)}` : ''}${
          v.memo ? ` — ${esc(v.memo)}` : ''}</td></tr>
        <tr><td class="dim">Paid by</td><td>${esc(v.method)}${v.reference ? ` · ${esc(v.reference)}` : ''}</td></tr>
        <tr><td class="dim">Out of</td><td>${esc(v.paid_from_title)}</td></tr>
        <tr class="v-amt"><td class="dim">Amount</td><td><b>${peso(v.amount)}</b></td></tr>
      </tbody></table>
      <div class="v-sign"><div><div class="v-line"></div>Prepared by</div>
        <div><div class="v-line"></div>Approved by</div>
        <div><div class="v-line"></div>Received by</div></div>
    </div>
    <div class="mt right no-print"><button class="btn quiet" id="v_x">Close</button>
      <button class="btn" id="v_print">Print</button></div>`);
  document.body.classList.add('voucher-open');
  const done = () => { document.body.classList.remove('voucher-open'); closeDialog(); };
  $('#v_x').onclick = done;
  $('#v_print').onclick = () => window.print();
}

SCREENS.journal = async (page) => {
  const [rows, pending] = await Promise.all([GET('/api/books/journal'), GET('/api/books/sync')]);
  const waiting = Number(pending.counter) + Number(pending.invoice) + Number(pending.payment) + Number(pending.discount);
  const bits = [[pending.counter, 'counter sale'], [pending.invoice, 'invoice'],
    [pending.payment, 'payment'], [pending.discount, 'discount']]
    .filter(([n]) => Number(n) > 0)
    .map(([n, w]) => `${n} ${w}${Number(n) === 1 ? '' : 's'}`).join(' · ');
  page.innerHTML = `<div class="head"><h2>Journal</h2>
      <span class="hint">${rows.length} entries, newest first</span></div>
    <div class="panel autopost">
      <div><b>Auto-posting</b> — the day's sales, straight from the selling side.
        <div class="dim">${waiting ? esc(bits) + ' waiting to post' : 'The books are up to date with the shop 🌸'}</div></div>
      <button class="btn${waiting ? '' : ' quiet'}" id="sync"${waiting ? '' : ' disabled'}>Bring the books up to date</button>
    </div>
    ${rows.length ? rows.map((e) => `<div class="panel">
      <div class="row" style="justify-content:space-between">
        <div><b>${esc(e.entry_no)}</b> · ${onDay(e.entry_date)} · ${esc(e.memo)}</div>
        <div class="dim">${esc(e.posted_by || '')}</div></div>
      <table class="lines"><tbody>${e.lines.map((l) => `<tr>
        <td>${esc(l.title)}</td>
        <td class="n">${Number(l.debit) ? peso(l.debit) : ''}</td>
        <td class="n">${Number(l.credit) ? peso(l.credit) : ''}</td>
        <td class="dim">${esc(l.memo || '')}</td></tr>`).join('')}</tbody></table></div>`).join('')
      : '<div class="none">Nothing posted yet.</div>'}`;
  const sync = $('#sync');
  if (sync && waiting) sync.onclick = async () => {
    sync.disabled = true; sync.textContent = 'Posting…';
    try {
      const r = await POST('/api/books/sync');
      notice(postedLine(r), 'good'); shell_reload();
    } catch (e) { notice(e.message, 'bad'); sync.disabled = false; sync.textContent = 'Bring the books up to date'; }
  };
};

// How a sync result reads back.
function postedLine(r) {
  const t = Number(r.total) || 0;
  if (!t) return 'Already up to date 🌸';
  const bits = [[r.counter, 'sale'], [r.invoice, 'invoice'], [r.payment, 'payment'], [r.discount, 'discount']]
    .filter(([n]) => Number(n) > 0).map(([n, w]) => `${n} ${w}${Number(n) === 1 ? '' : 's'}`).join(', ');
  return `Posted ${bits} to the books 🌸`;
}

SCREENS.trial = async (page) => {
  const { rows, totals } = await GET('/api/books/trial-balance');
  page.innerHTML = `<div class="head"><h2>Trial balance</h2>
      <span class="hint">${rows.length} accounts with a balance</span></div>
    <div class="panel"><table class="lines"><thead><tr><th>Code</th><th>Account</th>
      <th class="n">Debit</th><th class="n">Credit</th></tr></thead><tbody>
      ${rows.map((a) => `<tr><td class="dim">${esc(a.code)}</td><td><b>${esc(a.title)}</b>
        <span class="dim"> · ${esc(a.type)}</span></td>
        <td class="n">${Number(a.debits) ? peso(a.debits) : ''}</td>
        <td class="n">${Number(a.credits) ? peso(a.credits) : ''}</td></tr>`).join('')}
      </tbody><tfoot><tr><td></td><td class="right"><b>Totals</b></td>
        <td class="n"><b>${peso(totals.debits)}</b></td><td class="n"><b>${peso(totals.credits)}</b></td></tr>
        <tr><td></td><td class="right">${totals.debits === totals.credits
          ? '<span class="tag green">in balance</span>'
          : '<span class="tag red">out of balance</span>'}</td><td></td><td></td></tr></tfoot></table></div>`;
};

SCREENS.statements = async (page) => {
  const s = await GET('/api/books/statements');
  const list = (rows) => rows.length ? rows.map((a) => `<tr><td>${esc(a.title)}</td>
      <td class="n">${peso(a.balance)}</td></tr>`).join('') : '<tr><td class="dim">—</td><td></td></tr>';
  page.innerHTML = `<div class="head"><h2>Financial statements</h2>
      <span class="hint">Off the trial balance</span></div>
    <div class="two-up">
      <div class="panel"><h3>Income statement</h3><table class="lines">
        <tbody><tr class="sub"><td colspan="2">Revenue</td></tr>${list(s.income.revenue)}
          <tr><td class="right"><b>Total revenue</b></td><td class="n"><b>${peso(s.income.total_revenue)}</b></td></tr>
          <tr class="sub"><td colspan="2">Expenses</td></tr>${list(s.income.expense)}
          <tr><td class="right"><b>Total expenses</b></td><td class="n"><b>${peso(s.income.total_expense)}</b></td></tr>
          <tr class="grand"><td class="right"><b>${s.income.profit >= 0 ? 'Net income' : 'Net loss'}</b></td>
            <td class="n"><b>${peso(Math.abs(s.income.profit))}</b></td></tr></tbody></table></div>
      <div class="panel"><h3>Balance sheet</h3><table class="lines">
        <tbody><tr class="sub"><td colspan="2">Assets</td></tr>${list(s.balance.assets)}
          <tr><td class="right"><b>Total assets</b></td><td class="n"><b>${peso(s.balance.total_assets)}</b></td></tr>
          <tr class="sub"><td colspan="2">Liabilities</td></tr>${list(s.balance.liabilities)}
          <tr class="sub"><td colspan="2">Equity</td></tr>${list(s.balance.equity)}
          <tr><td>Profit for the period</td><td class="n">${peso(s.balance.profit)}</td></tr>
          <tr class="grand"><td class="right"><b>Liabilities + Equity</b></td>
            <td class="n"><b>${peso(s.balance.total_liabilities + s.balance.total_equity)}</b></td></tr></tbody></table></div>
    </div>`;
};

// ---- reports ----------------------------------------------------------------
let reportView = 'aging';
let reportFrom = null, reportTo = null;

SCREENS.reports = async (page) => {
  reportFrom ||= `${new Date().getFullYear()}-${String(new Date().getMonth() + 1).padStart(2, '0')}-01`;
  reportTo ||= today();
  const VIEWS = [['aging', 'Payables aging'], ['cashflow', 'Cash flow'], ['income', 'Income statement']];
  page.innerHTML = `<div class="head"><h2>Reports</h2>
      <span class="hint">Every figure straight off the journal</span></div>
    <div class="subnav">${VIEWS.map(([id, label]) =>
      `<button data-rv="${id}" class="${id === reportView ? 'on' : ''}">${esc(label)}</button>`).join('')}</div>
    <div class="daterow" id="drow" ${reportView === 'aging' ? 'hidden' : ''}>
      <label>From</label><input id="r_from" type="date" value="${reportFrom}">
      <label>To</label><input id="r_to" type="date" value="${reportTo}">
      <button class="btn quiet sm" id="r_apply">Show</button>
      <button class="btn quiet sm" id="r_month">This month</button>
      <button class="btn quiet sm" id="r_year">This year</button></div>
    <div id="rep-body"></div>`;
  page.querySelectorAll('[data-rv]').forEach((b) => b.onclick = () => { reportView = b.dataset.rv; shell_reload(); });
  const apply = () => { reportFrom = $('#r_from').value; reportTo = $('#r_to').value; draw(); };
  $('#r_apply').onclick = apply;
  $('#r_month').onclick = () => { const d = new Date();
    reportFrom = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`; reportTo = today(); shell_reload(); };
  $('#r_year').onclick = () => { reportFrom = `${new Date().getFullYear()}-01-01`; reportTo = today(); shell_reload(); };

  const body = $('#rep-body');
  async function draw() {
    body.innerHTML = '<div class="dim">Working…</div>';
    if (reportView === 'aging') return drawAging(body);
    if (reportView === 'cashflow') return drawCashflow(body);
    return drawIncome(body);
  }
  await draw();
};

async function drawAging(body) {
  const a = await GET('/api/books/reports/aging');
  const cols = [['notdue', 'Not due'], ['d30', '1–30 days'], ['d60', '31–60'], ['d90', '61–90'], ['over', '90+']];
  const cell = (n) => `<td class="n">${Number(n) ? peso(n) : ''}</td>`;
  body.innerHTML = `<div class="panel"><table class="lines"><thead><tr><th>Supplier</th>
      ${cols.map(([, l]) => `<th class="n">${l}</th>`).join('')}<th class="n">Total</th></tr></thead><tbody>
      ${a.vendors.length ? a.vendors.map((v) => `<tr><td><b>${esc(v.vendor)}</b></td>
        ${cols.map(([k]) => cell(v[k])).join('')}<td class="n"><b>${peso(v.total)}</b></td></tr>`).join('')
        : '<tr><td colspan="7" class="dim">Nothing outstanding — all paid up.</td></tr>'}
      </tbody><tfoot><tr><td class="right"><b>Total owed</b></td>
        ${cols.map(([k]) => `<td class="n"><b>${Number(a.totals[k]) ? peso(a.totals[k]) : ''}</b></td>`).join('')}
        <td class="n"><b>${peso(a.totals.total)}</b></td></tr></tfoot></table></div>`;
}

async function drawCashflow(body) {
  const c = await GET(`/api/books/reports/cashflow?from=${reportFrom}&to=${reportTo}`);
  const list = (rows, none) => rows.length ? rows.map((r) => `<tr><td>${esc(r.title)}</td>
      <td class="n">${peso(r.amount)}</td></tr>`).join('') : `<tr><td class="dim">${none}</td><td></td></tr>`;
  body.innerHTML = `<div class="panel"><h3>Cash flow · ${onDay(c.from)} – ${onDay(c.to)}</h3>
    <table class="lines"><tbody>
      <tr class="grand"><td>Cash at the start</td><td class="n"><b>${peso(c.opening)}</b></td></tr>
      <tr class="sub"><td colspan="2">Cash in</td></tr>${list(c.inflows, 'Nothing came in')}
      <tr><td class="right"><b>Total in</b></td><td class="n"><b>${peso(c.total_in)}</b></td></tr>
      <tr class="sub"><td colspan="2">Cash out</td></tr>${list(c.outflows, 'Nothing went out')}
      <tr><td class="right"><b>Total out</b></td><td class="n"><b>${peso(c.total_out)}</b></td></tr>
      <tr><td class="right">Net change</td><td class="n ${c.net < 0 ? 'due' : ''}">${peso(c.net)}</td></tr>
      <tr class="grand"><td><b>Cash at the close</b></td><td class="n"><b>${peso(c.closing)}</b></td></tr>
    </tbody></table></div>`;
}

async function drawIncome(body) {
  const s = await GET(`/api/books/reports/income?from=${reportFrom}&to=${reportTo}`);
  const p = s.period, pr = s.prior;
  const list = (rows) => rows.length ? rows.map((a) => `<tr><td>${esc(a.title)}</td>
      <td class="n">${peso(a.balance)}</td></tr>`).join('') : '<tr><td class="dim">—</td><td></td></tr>';
  const delta = (now, was) => {
    const d = Number(now) - Number(was);
    return `<span class="dim">${d >= 0 ? '▲' : '▼'} ${peso(Math.abs(d))} vs ${onDay(pr.from)}–${onDay(pr.to)}</span>`;
  };
  body.innerHTML = `<div class="panel"><h3>Income statement · ${onDay(s.from)} – ${onDay(s.to)}</h3>
    <table class="lines"><tbody>
      <tr class="sub"><td colspan="2">Revenue</td></tr>${list(p.revenue)}
      <tr><td class="right"><b>Total revenue</b></td><td class="n"><b>${peso(p.total_revenue)}</b></td></tr>
      <tr><td class="right">${delta(p.total_revenue, pr.total_revenue)}</td><td></td></tr>
      <tr class="sub"><td colspan="2">Expenses</td></tr>${list(p.expense)}
      <tr><td class="right"><b>Total expenses</b></td><td class="n"><b>${peso(p.total_expense)}</b></td></tr>
      <tr><td class="right">${delta(p.total_expense, pr.total_expense)}</td><td></td></tr>
      <tr class="grand"><td class="right"><b>${p.profit >= 0 ? 'Net income' : 'Net loss'}</b></td>
        <td class="n"><b>${peso(Math.abs(p.profit))}</b></td></tr>
      <tr><td class="right">${delta(p.profit, pr.profit)}</td><td></td></tr>
    </tbody></table></div>`;
}

// ---- a tiny dialog (self-contained, styles.css already has .veil/.dialog) ---
function dialog(html) {
  closeDialog();
  const v = el('div', 'veil', `<div class="dialog">${html}</div>`);
  v.id = 'dialog'; document.body.append(v);
  v.addEventListener('click', (e) => { if (e.target === v) closeDialog(); });
}
function closeDialog() { $('#dialog')?.remove(); }

let currentUser = null;
const shell_reload = () => shell(currentUser);

// Pull the shop's trading into the books once when the app opens. Idempotent, so
// it only ever posts what is new; silent unless it actually posted something.
async function syncOnLoad() {
  try {
    const r = await POST('/api/books/sync');
    if (Number(r.total) > 0) { notice(postedLine(r), 'good'); if (tab === 'journal') shell_reload(); }
  } catch { /* leave it to the button on the Journal tab */ }
}

async function start() {
  try {
    const me = await GET('/api/me');
    if (me.user && me.user.role === 'admin') { currentUser = me.user; await shell(me.user); syncOnLoad(); return; }
    if (me.user) {
      root().innerHTML = `<div class="login-wrap"><div class="login-card">
        <div class="brand"><b>MS BEAU AVE</b><span>Books</span></div>
        <div class="none bad">The books are the owner's. This sign-in cannot open them.</div>
        <button class="btn wide mt" id="out">Sign out</button></div></div>`;
      $('#out').onclick = async () => { await POST('/api/logout').catch(() => {}); start(); };
      return;
    }
  } catch { /* not signed in */ }
  signInScreen(start);
}

start();
