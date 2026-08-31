// Books — the accounting foundation.
//
// The one property that makes a ledger a ledger: it balances. An entry whose
// debits and credits are unequal is refused, to the centavo, and nothing is
// written; a balanced one posts and the trial balance ties. And the books are
// the owner's — nobody but an admin gets in.
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
const two = async (admin) => {
  const a = await req(admin, 'GET', '/api/books/accounts');
  const debit = a.data.find((x) => x.normal_side === 'debit' && x.type === 'Asset');
  const credit = a.data.find((x) => x.type === 'Revenue');
  return { debit: debit.code, credit: credit.code };
};

test('the chart of accounts is seeded from the old template', async () => {
  const admin = await signIn('admin');
  const r = await req(admin, 'GET', '/api/books/accounts');
  assert.equal(r.status, 200);
  assert.ok(r.data.length >= 70, 'the seventy-odd titles are there');
  assert.ok(r.data.some((a) => /Accounts Receivable/i.test(a.title)));
});

test('a balanced entry posts and the trial balance ties out', async () => {
  const admin = await signIn('admin');
  const { debit, credit } = await two(admin);
  const post = await req(admin, 'POST', '/api/books/journal', {
    entry_date: '2026-08-31', memo: 'A test sale',
    lines: [{ account: debit, debit: 1500, credit: 0 }, { account: credit, debit: 0, credit: 1500 }] });
  assert.equal(post.status, 200, JSON.stringify(post.data));

  const tb = await req(admin, 'GET', '/api/books/trial-balance');
  assert.equal(tb.status, 200);
  assert.equal(Number(tb.data.totals.debits), Number(tb.data.totals.credits), 'debits equal credits');
  assert.ok(Number(tb.data.totals.debits) >= 1500);
});

test('an entry that does not balance is refused to the centavo, and nothing lands', async () => {
  const admin = await signIn('admin');
  const { debit, credit } = await two(admin);
  const before = (await req(admin, 'GET', '/api/books/journal')).data.length;
  const bad = await req(admin, 'POST', '/api/books/journal', {
    entry_date: '2026-08-31', memo: 'Off by ten',
    lines: [{ account: debit, debit: 100, credit: 0 }, { account: credit, debit: 0, credit: 90 }] });
  assert.equal(bad.status, 400);
  assert.match(bad.data.error, /not equal/i);
  const after = (await req(admin, 'GET', '/api/books/journal')).data.length;
  assert.equal(after, before, 'the refused entry wrote nothing');
});

test('a one-sided or single-line entry is refused', async () => {
  const admin = await signIn('admin');
  const { debit } = await two(admin);
  const one = await req(admin, 'POST', '/api/books/journal',
    { entry_date: '2026-08-31', memo: 'One line', lines: [{ account: debit, debit: 100, credit: 0 }] });
  assert.equal(one.status, 400, 'a posting is at least two lines');
});

test('the books are the owner\'s — nobody else gets in', async () => {
  for (const role of ['warehouse', 'orderdesk', 'datacoord', 'cashier', 'employee']) {
    const who = await signIn(role);
    for (const p of ['/api/books/accounts', '/api/books/journal', '/api/books/trial-balance', '/api/books/statements']) {
      const r = await req(who, 'GET', p);
      assert.equal(r.status, 403, `${role} must not read ${p}`);
    }
    const post = await req(who, 'POST', '/api/books/journal', { lines: [] });
    assert.equal(post.status, 403, `${role} must not post`);
  }
});

test('the statements come off the trial balance', async () => {
  const admin = await signIn('admin');
  const { debit, credit } = await two(admin);
  await req(admin, 'POST', '/api/books/journal', {
    entry_date: '2026-08-31', memo: 'Revenue',
    lines: [{ account: debit, debit: 500, credit: 0 }, { account: credit, debit: 0, credit: 500 }] });
  const s = await req(admin, 'GET', '/api/books/statements');
  assert.equal(s.status, 200);
  assert.ok(Number(s.data.income.total_revenue) >= 500, 'revenue shows on the income statement');
  assert.equal(typeof s.data.balance.total_assets, 'number');
});
