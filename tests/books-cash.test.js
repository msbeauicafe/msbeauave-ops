// Books — cash & disbursements (Phase 3).
//
// The cash position is the balances of the accounts marked as cash; a transfer
// moves money between two of them without changing the total; a bill payment or
// an expense mints a numbered voucher and lands in one register. And every one
// of these is still a balanced posting, so the trial balance never drifts — and
// it is all the owner's alone.
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
const balanceOf = async (admin, code) => {
  const r = (await req(admin, 'GET', '/api/books/trial-balance')).data.rows.find((x) => x.code === code);
  return r ? Number(r.balance) : 0;
};
const tie = async (admin) => {
  const t = (await req(admin, 'GET', '/api/books/trial-balance')).data.totals;
  return Number(t.debits) === Number(t.credits);
};

test('the cash accounts are seeded, and the position adds them up', async () => {
  const admin = await signIn('admin');
  const cash = (await req(admin, 'GET', '/api/books/cash')).data;
  const codes = cash.accounts.map((a) => a.code);
  assert.ok(codes.includes('102') && codes.includes('103') && codes.includes('115'),
    'Cash In Bank, Cash On Hand and Cash Only are cash out of the box');
  const sum = cash.accounts.reduce((s, a) => s + Number(a.balance), 0);
  assert.equal(Number(cash.total).toFixed(2), sum.toFixed(2), 'the total is the sum of the accounts');
});

test('a transfer moves cash between two accounts and leaves the total alone', async () => {
  const admin = await signIn('admin');
  const bankBefore = await balanceOf(admin, '102');
  const handBefore = await balanceOf(admin, '103');
  const totalBefore = Number((await req(admin, 'GET', '/api/books/cash')).data.total);

  const t = await req(admin, 'POST', '/api/books/transfer',
    { from: '102', to: '103', xfer_date: '2026-08-31', amount: 1500, memo: 'To the drawer' });
  assert.equal(t.status, 200, JSON.stringify(t.data));

  assert.equal(await balanceOf(admin, '102') - bankBefore, -1500, 'the bank went down');
  assert.equal(await balanceOf(admin, '103') - handBefore, 1500, 'the drawer went up');
  const totalAfter = Number((await req(admin, 'GET', '/api/books/cash')).data.total);
  assert.equal(totalAfter.toFixed(2), totalBefore.toFixed(2), 'cash on hand overall is unchanged');
  assert.ok(await tie(admin), 'and the books still balance');
});

test('a transfer refuses the same account, a non-cash account, and nothing', async () => {
  const admin = await signIn('admin');
  const same = await req(admin, 'POST', '/api/books/transfer',
    { from: '102', to: '102', xfer_date: '2026-08-31', amount: 100 });
  assert.equal(same.status, 400);
  assert.match(same.data.error, /different accounts/i);

  // 101 (Accounts Receivable) is an asset but not a cash account.
  const notCash = await req(admin, 'POST', '/api/books/transfer',
    { from: '101', to: '103', xfer_date: '2026-08-31', amount: 100 });
  assert.equal(notCash.status, 400);
  assert.match(notCash.data.error, /cash account/i);

  const nothing = await req(admin, 'POST', '/api/books/transfer',
    { from: '102', to: '103', xfer_date: '2026-08-31', amount: 0 });
  assert.equal(nothing.status, 400);
});

test('marking an account as cash brings it into the position', async () => {
  const admin = await signIn('admin');
  // 104 Cost of Inventory is an asset not marked as cash. Mark it, and it appears.
  await req(admin, 'POST', '/api/books/cash/mark', { code: '104', is_cash: true });
  let codes = (await req(admin, 'GET', '/api/books/cash')).data.accounts.map((a) => a.code);
  assert.ok(codes.includes('104'), 'now it is a cash account');
  // Unmark it and it drops out again.
  await req(admin, 'POST', '/api/books/cash/mark', { code: '104', is_cash: false });
  codes = (await req(admin, 'GET', '/api/books/cash')).data.accounts.map((a) => a.code);
  assert.ok(!codes.includes('104'), 'and out again');
});

test('paying a bill mints a voucher and lands in the disbursements register', async () => {
  const admin = await signIn('admin');
  const expense = (await req(admin, 'GET', '/api/books/accounts')).data.find((a) => a.type === 'Expense').code;
  const v = await req(admin, 'POST', '/api/books/vendors', { name: uniq('Supplier') });
  const bill = await req(admin, 'POST', '/api/books/bills', {
    vendor_id: v.data.id, bill_date: '2026-08-31', lines: [{ account: expense, amount: 800 }] });

  const ref = uniq('CHK');
  const pay = await req(admin, 'POST', `/api/books/bills/${bill.data.id}/pay`, {
    pay_date: '2026-08-31', paid_from: '102', amount: 800, method: 'cheque', reference: ref });
  assert.equal(pay.status, 200, JSON.stringify(pay.data));

  const reg = (await req(admin, 'GET', '/api/books/disbursements')).data;
  const mine = reg.find((d) => d.reference === ref);
  assert.ok(mine, 'the payment is in the register');
  assert.match(mine.voucher_no, /^DV-\d{5}$/, 'with a voucher number');
  assert.equal(mine.kind, 'Bill payment');
  assert.equal(mine.method, 'cheque');
  assert.equal(Number(mine.amount), 800);
});

test('an on-the-spot expense mints a voucher too, and carries its method', async () => {
  const admin = await signIn('admin');
  const expense = (await req(admin, 'GET', '/api/books/accounts')).data.find((a) => a.type === 'Expense').code;
  const memo = uniq('Fare');
  const x = await req(admin, 'POST', '/api/books/expenses', {
    pay_date: '2026-08-31', paid_from: '103', memo, method: 'cash',
    lines: [{ account: expense, amount: 120 }] });
  assert.equal(x.status, 200, JSON.stringify(x.data));

  const reg = (await req(admin, 'GET', '/api/books/disbursements')).data;
  const mine = reg.find((d) => d.payee === memo && d.kind === 'Expense');
  assert.ok(mine, 'the expense is in the register');
  assert.match(mine.voucher_no, /^DV-\d{5}$/);
  assert.equal(Number(mine.amount), 120);
});

test('cash & disbursements are the owner\'s — nobody else gets in', async () => {
  for (const role of ['warehouse', 'orderdesk', 'datacoord', 'cashier', 'employee']) {
    const who = await signIn(role);
    for (const p of ['/api/books/cash', '/api/books/disbursements']) {
      assert.equal((await req(who, 'GET', p)).status, 403, `${role} must not read ${p}`);
    }
    assert.equal((await req(who, 'POST', '/api/books/transfer',
      { from: '102', to: '103', amount: 1 })).status, 403);
    assert.equal((await req(who, 'POST', '/api/books/cash/mark', { code: '102', is_cash: true })).status, 403);
  }
});

test('the Cash screen is wired into the books app', async () => {
  const fs = await import('node:fs');
  const url = await import('node:url');
  const path = await import('node:path');
  const here = path.dirname(url.fileURLToPath(import.meta.url));
  const src = fs.readFileSync(path.join(here, '..', 'public/books/books.js'), 'utf8');
  assert.match(src, /\['cash', 'Cash'\]/, 'Cash is a tab');
  assert.match(src, /SCREENS\.cash\s*=/, 'and it has a screen');
  assert.match(src, /function transferDialog/, 'a transfer dialog');
  assert.match(src, /function voucherDialog/, 'and a printable voucher');
});
