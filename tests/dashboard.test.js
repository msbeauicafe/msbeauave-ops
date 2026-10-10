// The owner's dashboard, accounting first: sales today / this month / this
// year, accounts receivable, active distributors, twelve months of sales,
// and the latest invoices with Paid / Pending / Overdue. Read live off
// invoices, void left out. No stock list: the Product stock table went, and
// the full product list it read went with it.
// Somebody who may only look is sent none of the money.
import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { hashPassword } from '../lib/auth.js';
import { server } from '../scripts/dev.js';
import { pool } from '../lib/db.js';

const db = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 4 });
let base;

test.before(async () => {
  await new Promise((done) => server.listen(0, done));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(async () => {
  await new Promise((done) => server.close(done));
  await pool.end();
  await db.end();
});

let seq = 0;
const unique = (p) => `${p}-${process.pid}-${Date.now()}-${++seq}`;

async function signIn(role) {
  const username = unique(role);
  await db.query(
    `insert into app_users (username, display_name, password_hash, role)
     values ($1,$1,$2,$3)`, [username, hashPassword('secret123'), role]);
  const res = await fetch(`${base}/api/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password: 'secret123' }) });
  assert.equal(res.status, 200, `could not sign in as ${role}`);
  return (res.headers.getSetCookie?.()[0] ?? res.headers.get('set-cookie')).split(';')[0];
}
const GET = async (cookie, p) => {
  const res = await fetch(`${base}${p}`, { headers: { Cookie: cookie } });
  return { status: res.status, data: await res.json() };
};

test('the owner sees the accounting figures, twelve months and invoices, no stock list', async () => {
  const admin = await signIn('admin');
  const { status, data } = await GET(admin, '/api/dashboard');
  assert.equal(status, 200, JSON.stringify(data));
  for (const k of ['today', 'today_n', 'month', 'last_month_to_date', 'ytd']) {
    assert.ok(k in data.sales, `sales.${k}`);
  }
  for (const k of ['owed', 'open_n', 'past_due', 'past_due_n']) assert.ok(k in data.receivable, `receivable.${k}`);
  assert.ok('active' in data.distributors && 'on_file' in data.distributors);
  assert.equal(data.monthly.length, 12, 'twelve months, oldest first');
  assert.ok(Array.isArray(data.invoices));
  for (const i of data.invoices) assert.ok(['paid', 'pending', 'overdue'].includes(i.standing));
  assert.ok(!('stock' in data), 'the product list is no longer sent');
});

test('view-only is sent no money', async () => {
  const viewer = await signIn('observer');
  const { status, data } = await GET(viewer, '/api/dashboard');
  assert.equal(status, 200);
  assert.equal(data.sales, null);
  assert.equal(data.receivable, null);
  assert.deepEqual(data.monthly, []);
  assert.deepEqual(data.invoices, []);
  assert.ok(!('stock' in data));
});
