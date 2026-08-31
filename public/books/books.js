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
  ['journal', 'Journal'],
  ['trial', 'Trial balance'],
  ['statements', 'Statements'],
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
      <span class="hint">${rows.length} accounts · seeded from the old system</span>
      <button class="btn" id="add">＋ New account</button></div>
    ${Object.entries(byType).map(([type, list]) => `
      <div class="panel"><h3>${esc(type)}</h3>
        <table><thead><tr><th>Code</th><th>Title</th><th>Normal side</th></tr></thead><tbody>
        ${list.map((a) => `<tr><td class="dim">${esc(a.code)}</td><td><b>${esc(a.title)}</b></td>
          <td>${esc(a.normal_side)}</td></tr>`).join('')}
        </tbody></table></div>`).join('')}`;
  $('#add').onclick = () => accountDialog(() => shell_reload());
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

SCREENS.journal = async (page) => {
  const rows = await GET('/api/books/journal');
  page.innerHTML = `<div class="head"><h2>Journal</h2>
      <span class="hint">${rows.length} entries, newest first</span></div>
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
};

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

async function start() {
  try {
    const me = await GET('/api/me');
    if (me.user && me.user.role === 'admin') { currentUser = me.user; return shell(me.user); }
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
