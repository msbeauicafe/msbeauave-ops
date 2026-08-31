// Books — payables & expenses (Phase 2).
//
// The property that carries over from Phase 1: everything posts through the
// double entry, so recording a bill, paying it, and spending on the spot each
// move the trial balance and never unbalance it. A bill puts money into
// Accounts Payable; a payment takes it back out and out of cash with it; you
// cannot pay more than is owed; and the whole thing is the owner's alone.
import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { hashPassword } from '../lib/auth.js';
import { server } from '../scripts/dev.js';
import { pool } from '../lib/db.js';

const db = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 4 });
let base;
test.before(async () => { await new Promise((d) => server.listen(0, d)); base = `http://127.0.0.1:${server.address().port}`; });
test.after(async () => { await new Promise((d) => server.close(d)); await pool.end(); await db.end(); });

let seq = 0;
const uniq = (p) => `${p}-${process.pid}-${Date.now()}-${++seq}`;
async function req(cookie, method, p, body) {
  const r = await fetch(`${base}${p}`, { method,
    headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, data: await r.json().catch(() => ({})) };
}
async function signIn(role) {
  const u = uniq(role);
  await db.query(`insert into app_users (username, display_name, password_hash, role) values ($1,$1,$2,$3)`,
    [u, hashPassword('secret123'), role]);
  const r = await fetch(`${base}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: u, password: 'secret123' }) });
  return (r.headers.getSetCookie?.()[0] ?? r.headers.get('set-cookie')).split(';')[0];
}
// The three accounts these acts touch, out of the seeded chart.
async function accounts(admin) {
  const a = (await req(admin, 'GET', '/api/books/accounts')).data;
  return {
    payable: a.find((x) => x.code === '201').code,          // Accounts Payable
    cash: a.find((x) => x.type === 'Asset').code,           // some cash/asset account
    expense: a.find((x) => x.type === 'Expense').code,      // some expense account
    inventory: a.find((x) => x.type === 'Asset' && x.code !== '201').code,
  };
}
const tb = async (admin) => (await req(admin, 'GET', '/api/books/trial-balance')).data.totals;
const balanceOf = async (admin, code) => {
  const r = (await req(admin, 'GET', `/api/books/trial-balance`)).data.rows.find((x) => x.code === code);
  return r ? Number(r.balance) : 0;
};

test('a bill posts to Accounts Payable, and the trial balance still ties', async () => {
  const admin = await signIn('admin');
  const ac = await accounts(admin);
  const v = await req(admin, 'POST', '/api/books/vendors', { name: uniq('Supplier') });
  assert.equal(v.status, 200, JSON.stringify(v.data));

  const before = await tb(admin);
  const payableBefore = await balanceOf(admin, '201');
  const bill = await req(admin, 'POST', '/api/books/bills', {
    vendor_id: v.data.id, bill_date: '2026-08-31', due_date: '2026-09-30',
    reference: 'DR-100', memo: 'Stock delivery',
    lines: [{ account: ac.expense, amount: 3000 }, { account: ac.inventory, amount: 2000 }] });
  assert.equal(bill.status, 200, JSON.stringify(bill.data));

  const after = await tb(admin);
  assert.equal(Number(after.debits), Number(after.credits), 'the books still balance');
  assert.equal(Number(after.debits) - Number(before.debits), 5000, 'the whole bill posted');
  assert.equal(await balanceOf(admin, '201') - payableBefore, 5000, 'Accounts Payable owes 5,000 more');

  const bills = (await req(admin, 'GET', '/api/books/bills')).data;
  const mine = bills.find((b) => Number(b.id) === bill.data.id);
  assert.equal(Number(mine.amount), 5000);
  assert.equal(Number(mine.balance), 5000, 'nothing paid yet');
  assert.equal(mine.status, 'open');
});

test('paying a bill draws down the payable and the cash, part then whole', async () => {
  const admin = await signIn('admin');
  const ac = await accounts(admin);
  const v = await req(admin, 'POST', '/api/books/vendors', { name: uniq('Supplier') });
  const bill = await req(admin, 'POST', '/api/books/bills', {
    vendor_id: v.data.id, bill_date: '2026-08-31',
    lines: [{ account: ac.expense, amount: 1000 }] });

  // Pay half.
  const part = await req(admin, 'POST', `/api/books/bills/${bill.data.id}/pay`,
    { pay_date: '2026-08-31', paid_from: ac.cash, amount: 400 });
  assert.equal(part.status, 200, JSON.stringify(part.data));
  let mine = (await req(admin, 'GET', '/api/books/bills')).data.find((b) => Number(b.id) === bill.data.id);
  assert.equal(Number(mine.paid), 400);
  assert.equal(Number(mine.balance), 600);
  assert.equal(mine.status, 'part');

  // Pay the rest.
  const rest = await req(admin, 'POST', `/api/books/bills/${bill.data.id}/pay`,
    { pay_date: '2026-08-31', paid_from: ac.cash, amount: 600 });
  assert.equal(rest.status, 200, JSON.stringify(rest.data));
  mine = (await req(admin, 'GET', '/api/books/bills')).data.find((b) => Number(b.id) === bill.data.id);
  assert.equal(Number(mine.balance), 0);
  assert.equal(mine.status, 'paid');

  const totals = await tb(admin);
  assert.equal(Number(totals.debits), Number(totals.credits), 'still balanced after paying');
});

test('a payment cannot be for more than is still owed', async () => {
  const admin = await signIn('admin');
  const ac = await accounts(admin);
  const v = await req(admin, 'POST', '/api/books/vendors', { name: uniq('Supplier') });
  const bill = await req(admin, 'POST', '/api/books/bills', {
    vendor_id: v.data.id, bill_date: '2026-08-31', lines: [{ account: ac.expense, amount: 500 }] });

  const over = await req(admin, 'POST', `/api/books/bills/${bill.data.id}/pay`,
    { pay_date: '2026-08-31', paid_from: ac.cash, amount: 501 });
  assert.equal(over.status, 400);
  assert.match(over.data.error, /more than|owed/i);

  const mine = (await req(admin, 'GET', '/api/books/bills')).data.find((b) => Number(b.id) === bill.data.id);
  assert.equal(Number(mine.paid), 0, 'the refused payment wrote nothing');
});

test('the payables summary totals what is owed and what is overdue', async () => {
  const admin = await signIn('admin');
  const ac = await accounts(admin);
  const v = await req(admin, 'POST', '/api/books/vendors', { name: uniq('Supplier') });
  // One due long ago, one due next year.
  await req(admin, 'POST', '/api/books/bills', {
    vendor_id: v.data.id, bill_date: '2020-01-01', due_date: '2020-02-01',
    lines: [{ account: ac.expense, amount: 700 }] });
  await req(admin, 'POST', '/api/books/bills', {
    vendor_id: v.data.id, bill_date: '2026-08-31', due_date: '2099-01-01',
    lines: [{ account: ac.expense, amount: 300 }] });

  const s = (await req(admin, 'GET', '/api/books/payables')).data;
  assert.ok(Number(s.total_open) >= 1000, 'both bills are open');
  assert.ok(Number(s.total_overdue) >= 700, 'the 2020 one is overdue');
  const vname = (await req(admin, 'GET', '/api/books/vendors')).data.find((z) => Number(z.id) === v.data.id).name;
  const line = s.vendors.find((x) => x.vendor === vname);
  assert.ok(line && Number(line.open) >= 1000);
});

test('an expense paid on the spot lands on the income statement, no payable', async () => {
  const admin = await signIn('admin');
  const ac = await accounts(admin);
  const payableBefore = await balanceOf(admin, '201');
  const before = (await req(admin, 'GET', '/api/books/statements')).data.income.total_expense;

  const x = await req(admin, 'POST', '/api/books/expenses', {
    pay_date: '2026-08-31', paid_from: ac.cash, memo: 'Fuel',
    lines: [{ account: ac.expense, amount: 250 }] });
  assert.equal(x.status, 200, JSON.stringify(x.data));

  const after = (await req(admin, 'GET', '/api/books/statements')).data.income.total_expense;
  assert.equal(Number(after) - Number(before), 250, 'the expense shows');
  assert.equal(await balanceOf(admin, '201'), payableBefore, 'and nothing went to Accounts Payable');

  const recent = (await req(admin, 'GET', '/api/books/expenses')).data;
  assert.ok(recent.some((e) => Number(e.id) === x.data.id), 'it is in the recent-expenses list');
});

test('an expense or bill for nothing is refused', async () => {
  const admin = await signIn('admin');
  const ac = await accounts(admin);
  const v = await req(admin, 'POST', '/api/books/vendors', { name: uniq('Supplier') });
  const emptyBill = await req(admin, 'POST', '/api/books/bills',
    { vendor_id: v.data.id, bill_date: '2026-08-31', lines: [] });
  assert.equal(emptyBill.status, 400);
  const emptyExp = await req(admin, 'POST', '/api/books/expenses',
    { pay_date: '2026-08-31', paid_from: ac.cash, lines: [] });
  assert.equal(emptyExp.status, 400);
});

test('payables & expenses are the owner\'s — nobody else gets in', async () => {
  for (const role of ['warehouse', 'orderdesk', 'datacoord', 'cashier', 'employee']) {
    const who = await signIn(role);
    for (const p of ['/api/books/vendors', '/api/books/bills', '/api/books/payables', '/api/books/expenses']) {
      assert.equal((await req(who, 'GET', p)).status, 403, `${role} must not read ${p}`);
    }
    assert.equal((await req(who, 'POST', '/api/books/bills', { lines: [] })).status, 403);
    assert.equal((await req(who, 'POST', '/api/books/expenses', { lines: [] })).status, 403);
    assert.equal((await req(who, 'POST', '/api/books/vendors', { name: 'x' })).status, 403);
  }
});

test('the Payables and Expenses screens are wired into the books app', async () => {
  const fs = await import('node:fs');
  const url = await import('node:url');
  const path = await import('node:path');
  const here = path.dirname(url.fileURLToPath(import.meta.url));
  const src = fs.readFileSync(path.join(here, '..', 'public/books/books.js'), 'utf8');
  assert.match(src, /\['payables', 'Payables'\]/, 'Payables is a tab');
  assert.match(src, /\['expenses', 'Expenses'\]/, 'Expenses is a tab');
  assert.match(src, /SCREENS\.payables\s*=/, 'and each has a screen');
  assert.match(src, /SCREENS\.expenses\s*=/);
});
