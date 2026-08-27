// CO26_08_001, SI26_08_001, PL26_08_001.
//
// A reseller order used to be known by its database id, and all three of its
// documents shared it: the customer order, the invoice and the packing list
// were each "#123". So "did you get 123?" in a chat window had three answers,
// and the number itself said nothing about when the order was placed.
//
// Each document now carries its own, in the shape the purchase orders already
// use — prefix, year, month, and a count that restarts monthly.
//
// The numbers are stamped by a trigger rather than by the function that places
// an order, because there are five of those across five migrations, each a
// replacement of the last. This checks the numbers arrive through the ordinary
// route a person uses, so a sixth pricing rewrite cannot quietly drop them.
import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { hashPassword } from '../lib/auth.js';
import { server } from '../scripts/dev.js';
import { pool } from '../lib/db.js';

const db = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 6 });
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
const monthsOut = (n) => {
  const d = new Date();
  d.setMonth(d.getMonth() + n);
  return d.toISOString().slice(0, 10);
};

async function request(cookie, method, path, body) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, data: await res.json().catch(() => ({})) };
}
const POST = (c, p, b) => request(c, 'POST', p, b ?? {});

async function signIn(role) {
  const username = unique(role);
  await db.query(
    `insert into app_users (username, display_name, password_hash, role)
     values ($1,$1,$2,$3)`, [username, hashPassword('secret123'), role]);
  const res = await fetch(`${base}/api/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password: 'secret123' }),
  });
  assert.equal(res.status, 200, `could not sign in as ${username}`);
  const raw = res.headers.getSetCookie?.()[0] ?? res.headers.get('set-cookie');
  return raw.split(';')[0];
}

async function newProduct(admin) {
  const sku = unique('SKU');
  const r = await POST(admin, '/api/products', {
    sku, name: `Test ${sku}`, brand: 'Beau Glow', category: 'Serums',
    unit_cost: 100, wholesale_price: 250, srp: 400, retail_price: 450,
    shelf_life_months: 24,
  });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  return sku;
}

async function newReseller(admin) {
  const { data } = await POST(admin, '/api/resellers',
    { name: unique('Reseller'), email: 'buyer@example.ph', tier: 2,
      credit_limit: 1_000_000, terms_days: 30 });
  await POST(admin, `/api/resellers/${data.id}/approve`);
  return data.id;
}

// The month a number belongs to is Manila's, which is what the trigger uses.
const stamp = () => {
  const now = new Date().toLocaleDateString('en-CA',
    { timeZone: 'Asia/Manila', year: '2-digit', month: '2-digit', day: '2-digit' });
  const [yy, mm] = now.split('-');
  return `${yy}_${mm}_`;
};

const numbers = async (orderId) => (await db.query(
  `select o.co_no, o.pl_no, i.si_no
     from orders o left join invoices i on i.order_id = o.id
    where o.id = $1`, [orderId])).rows[0];

test('a reseller order is stamped with all three document numbers', async () => {
  const admin = await signIn('admin');
  const store = await signIn('warehouse');
  const sku = await newProduct(admin);
  await POST(store, '/api/receive',
    { sku, batch_no: unique('B'), expiry: monthsOut(24), qty: 50 });
  const seller = await newReseller(admin);

  const order = await POST(admin, `/api/resellers/${seller}/orders`, { lines: [{ sku, qty: 2 }] });
  assert.equal(order.status, 200, JSON.stringify(order.data));

  const n = await numbers(order.data.orderId);
  const on = stamp();
  assert.match(n.co_no, new RegExp(`^CO${on}\\d{3}$`), `customer order number was ${n.co_no}`);
  assert.match(n.pl_no, new RegExp(`^PL${on}\\d{3}$`), `packing list number was ${n.pl_no}`);
  assert.match(n.si_no, new RegExp(`^SI${on}\\d{3}$`), `sales invoice number was ${n.si_no}`);

  // Three documents, three numbers. Sharing one is the thing this replaced.
  assert.notEqual(n.co_no, n.pl_no);
  assert.notEqual(n.co_no, n.si_no);
});

test('the count goes up, and each document counts for itself', async () => {
  const admin = await signIn('admin');
  const store = await signIn('warehouse');
  const sku = await newProduct(admin);
  await POST(store, '/api/receive',
    { sku, batch_no: unique('B'), expiry: monthsOut(24), qty: 80 });
  const seller = await newReseller(admin);

  const first = await POST(admin, `/api/resellers/${seller}/orders`, { lines: [{ sku, qty: 1 }] });
  const then = await POST(admin, `/api/resellers/${seller}/orders`, { lines: [{ sku, qty: 1 }] });
  assert.equal(then.status, 200, JSON.stringify(then.data));

  const a = await numbers(first.data.orderId);
  const b = await numbers(then.data.orderId);
  const tail = (s) => Number(s.slice(-3));
  assert.equal(tail(b.co_no), tail(a.co_no) + 1, 'the customer order count moves on by one');
  assert.equal(tail(b.pl_no), tail(a.pl_no) + 1, 'and so does the packing list');
  assert.equal(tail(b.si_no), tail(a.si_no) + 1, 'and the invoice');
});

test('a counter sale gets no customer order number', async () => {
  const admin = await signIn('admin');
  const store = await signIn('warehouse');
  const till = await signIn('cashier');
  const sku = await newProduct(admin);
  await POST(store, '/api/receive',
    { sku, batch_no: unique('B'), expiry: monthsOut(24), qty: 20 });

  const sale = await POST(till, '/api/till/sell',
    { lines: [{ sku, qty: 1 }], method: 'cash', tendered: 1000 });
  assert.equal(sale.status, 200, JSON.stringify(sale.data));

  const r = await db.query('select co_no, pl_no from orders where id = $1',
    [sale.data.order_id]);
  assert.equal(r.rows[0].co_no, null,
    'somebody buying over the counter has not placed a customer order');
  assert.equal(r.rows[0].pl_no, null, 'and nobody packs it — they walk out with it');
});

test('two orders raised at once cannot take the same number', async () => {
  const admin = await signIn('admin');
  const store = await signIn('warehouse');
  const sku = await newProduct(admin);
  await POST(store, '/api/receive',
    { sku, batch_no: unique('B'), expiry: monthsOut(24), qty: 200 });
  const seller = await newReseller(admin);

  // The advisory lock is what makes this safe; the unique index is only the
  // backstop. Six at once is what a busy afternoon looks like.
  const raised = await Promise.all(Array.from({ length: 6 }, () =>
    POST(admin, `/api/resellers/${seller}/orders`, { lines: [{ sku, qty: 1 }] })));
  assert.ok(raised.every((r) => r.status === 200),
    `not all six were accepted: ${JSON.stringify(raised.map((r) => r.data))}`);

  const all = await Promise.all(raised.map((r) => numbers(r.data.orderId)));
  const cos = all.map((n) => n.co_no);
  assert.equal(new Set(cos).size, 6, `six orders produced ${new Set(cos).size} numbers: ${cos}`);
  const sis = all.map((n) => n.si_no);
  assert.equal(new Set(sis).size, 6, `six invoices produced ${new Set(sis).size} numbers: ${sis}`);
});
