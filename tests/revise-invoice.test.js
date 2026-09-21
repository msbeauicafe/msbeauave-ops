// An invoice can be corrected without cancelling the order.
//
// The sheet is filled from a basket typed while somebody reads a chat window,
// so its figures are right most of the time and wrong some of the time: a
// price agreed in the conversation and not in the price list, a delivery fee
// nobody knew about until the rider quoted it. The only fix used to be
// cancelling the order — which puts the stock back on sale and loses the
// number the reseller is already holding.
//
// Money can be corrected on the document that charges it. Quantities cannot:
// stock is held against an order from the moment it is placed, and an invoice
// that says four while the box holds six surfaces as a shortage weeks later
// with nothing to trace it to.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
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
const GET = (c, p) => request(c, 'GET', p);
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

// One reseller, one product, one order of four at ₱250 — ₱1,000.
async function anOrder(admin, store, qty = 4) {
  const sku = unique('SKU');
  const made = await POST(admin, '/api/products', {
    sku, name: `Test ${sku}`, brand: 'Beau Glow', category: 'Serums',
    unit_cost: 100, wholesale_price: 250, srp: 400, retail_price: 450,
    shelf_life_months: 24,
  });
  assert.equal(made.status, 200, JSON.stringify(made.data));
  await POST(store, '/api/receive',
    { sku, batch_no: unique('B'), expiry: monthsOut(24), qty: 100 });

  const { data: seller } = await POST(admin, '/api/resellers',
    { name: unique('Reseller'), email: 'buyer@example.ph', tier: 2,
      credit_limit: 1_000_000, terms_days: 15 });
  await POST(admin, `/api/resellers/${seller.id}/approve`);

  const order = await POST(admin, `/api/resellers/${seller.id}/orders`, { lines: [{ sku, qty }] });
  assert.equal(order.status, 200, JSON.stringify(order.data));
  return { sku, seller: seller.id, orderId: order.data.orderId };
}

const invoiceOf = async (orderId) => (await db.query(
  'select amount, paid, discount, status, si_no from invoices where order_id = $1',
  [orderId])).rows[0];

test('a corrected price changes what the account owes', async () => {
  const admin = await signIn('admin');
  const store = await signIn('warehouse');
  const { orderId } = await anOrder(admin, store);

  const before = await invoiceOf(orderId);
  assert.equal(Number(before.amount), 1000, 'four at 250');

  const { data: o } = await GET(admin, `/api/orders/${orderId}`);
  const line = o.lines[0];
  assert.ok(line.id, 'the screen needs a line id to correct a price against');

  const r = await POST(admin, `/api/orders/${orderId}/invoice`,
    { lines: [{ id: line.id, price: 200 }] });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(Number(r.data.total), 800);

  const after = await invoiceOf(orderId);
  assert.equal(Number(after.amount), 800, 'the invoice follows the price');
  assert.equal(after.si_no, before.si_no, 'and keeps the number they already have');
});

test('shipping and Others land on the grand total', async () => {
  const admin = await signIn('admin');
  const store = await signIn('warehouse');
  const { orderId } = await anOrder(admin, store);

  const r = await POST(admin, `/api/orders/${orderId}/invoice`,
    { shipping: 150, others: 50 });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(Number(r.data.subtotal), 1000);
  assert.equal(Number(r.data.total), 1200, '1000 of goods, 150 to deliver, 50 of something else');
  assert.equal(Number((await invoiceOf(orderId)).amount), 1200);
});

test('the quantity is left alone — the bench is holding it', async () => {
  const admin = await signIn('admin');
  const store = await signIn('warehouse');
  const { orderId } = await anOrder(admin, store);

  const { data: o } = await GET(admin, `/api/orders/${orderId}`);
  await POST(admin, `/api/orders/${orderId}/invoice`,
    { lines: [{ id: o.lines[0].id, price: 300, qty: 99 }] });

  const { data: again } = await GET(admin, `/api/orders/${orderId}`);
  assert.equal(again.lines[0].qty, 4, 'a quantity sent from the invoice screen is ignored');
  assert.equal(Number(again.lines[0].unit_price), 300, 'the price is not');
});

test('an invoice cannot be revised below what has been settled against it', async () => {
  const admin = await signIn('admin');
  const store = await signIn('warehouse');
  const { orderId } = await anOrder(admin, store);
  const invoiceId = (await db.query(
    'select id from invoices where order_id = $1', [orderId])).rows[0].id;

  const paid = await POST(admin, `/api/invoices/${invoiceId}/payments`,
    { payments: [{ amount: 900, method: 'GCash', paid_on: null }] });
  assert.equal(paid.status, 200, JSON.stringify(paid.data));

  const { data: o } = await GET(admin, `/api/orders/${orderId}`);
  const tooLow = await POST(admin, `/api/orders/${orderId}/invoice`,
    { lines: [{ id: o.lines[0].id, price: 100 }] });   // would come to 400
  assert.equal(tooLow.status, 400, JSON.stringify(tooLow.data));
  assert.match(tooLow.data.error, /already been settled/);

  assert.equal(Number((await invoiceOf(orderId)).amount), 1000,
    'and nothing was changed on the way to being refused');
});

test('revised down to exactly what was paid, an invoice settles', async () => {
  const admin = await signIn('admin');
  const store = await signIn('warehouse');
  const { orderId } = await anOrder(admin, store);
  const invoiceId = (await db.query(
    'select id from invoices where order_id = $1', [orderId])).rows[0].id;

  await POST(admin, `/api/invoices/${invoiceId}/payments`,
    { payments: [{ amount: 800, method: 'GCash', paid_on: null }] });
  assert.equal((await invoiceOf(orderId)).status, 'open', '200 still outstanding');

  const { data: o } = await GET(admin, `/api/orders/${orderId}`);
  const r = await POST(admin, `/api/orders/${orderId}/invoice`,
    { lines: [{ id: o.lines[0].id, price: 200 }] });   // four at 200 — exactly 800
  assert.equal(r.status, 200, JSON.stringify(r.data));

  const after = await invoiceOf(orderId);
  assert.equal(Number(after.amount), 800);
  assert.equal(after.status, 'paid', 'nothing is left on it, so it is settled');
});

test('a cashier cannot revise an invoice', async () => {
  const admin = await signIn('admin');
  const store = await signIn('warehouse');
  const till = await signIn('cashier');
  const { orderId } = await anOrder(admin, store);

  const { data: o } = await GET(admin, `/api/orders/${orderId}`);
  const nope = await POST(till, `/api/orders/${orderId}/invoice`,
    { lines: [{ id: o.lines[0].id, price: 1 }] });
  assert.ok(nope.status === 403 || nope.status === 401,
    `a cashier got ${nope.status} rather than being turned away`);
  assert.equal(Number((await invoiceOf(orderId)).amount), 1000);
});

// A sheet that says "SALES ORDER NO. 57" is quoting a number the system made
// up for itself. The reseller is holding SI26_08_006.
test('the invoice sheet is headed by its own number', () => {
  const app = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  const at = app.indexOf('<div class="title inv">INVOICE</div>');
  const head = app.slice(at, at + 300);
  assert.match(head, /docParty\(resellerName, issuedOn, invoiceNo \|\| orderId/,
    'the invoice number heads the invoice');
  assert.match(head, /'INVOICE NO\.'/, 'and it is labelled as one');
});
