// What a line is called on the paper, when the catalogue's name is not it.
//
// The sheet is what a reseller reads and agrees to, and there are lines the
// product's own name cannot say properly: a set going out with something
// substituted in it, a bundle sold as one thing, a shade written the way she
// asked for it rather than as the code the warehouse knows it by. Renaming the
// product was the only way, and that changes it for every order ever placed.
//
// It is what the line is called, not what the line is. The sku still says what
// comes off the shelf — so a description can never make the paperwork disagree
// with the warehouse about what is in the box, only about what to call it.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import pg from 'pg';
import { fileURLToPath } from 'node:url';
import { hashPassword } from '../lib/auth.js';
import { server } from '../scripts/dev.js';
import { pool } from '../lib/db.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const app = fs.readFileSync(path.join(here, '..', 'public/app.js'), 'utf8');
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
  const d = new Date(); d.setMonth(d.getMonth() + n);
  return d.toISOString().slice(0, 10);
};
async function request(cookie, method, p, body) {
  const res = await fetch(`${base}${p}`, {
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
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password: 'secret123' }) });
  assert.equal(res.status, 200);
  return (res.headers.getSetCookie?.()[0] ?? res.headers.get('set-cookie')).split(';')[0];
}

async function anOrder(admin, store) {
  const sku = unique('SKU');
  await POST(admin, '/api/products', {
    sku, name: `Catalogue name ${sku}`, brand: 'Beau Glow', category: 'Sets',
    unit_cost: 100, wholesale_price: 250, srp: 400, retail_price: 450,
    shelf_life_months: 24 });
  await POST(store, '/api/receive',
    { sku, batch_no: unique('B'), expiry: monthsOut(24), qty: 40 });
  const { data } = await POST(admin, '/api/resellers',
    { name: unique('Reseller'), email: 'b@example.ph', tier: 2,
      credit_limit: 1_000_000, terms_days: 15 });
  await POST(admin, `/api/resellers/${data.id}/approve`);
  const order = await POST(admin, `/api/resellers/${data.id}/orders`, { lines: [{ sku, qty: 2 }] });
  assert.equal(order.status, 200, JSON.stringify(order.data));
  const back = await GET(admin, `/api/orders/${order.data.orderId}`);
  return { id: order.data.orderId, sku, line: back.data.lines[0] };
}

test('a line can be called something the catalogue does not call it', async () => {
  const admin = await signIn('admin');
  const store = await signIn('warehouse');
  const o = await anOrder(admin, store);

  const out = await POST(admin, `/api/orders/${o.id}/descriptions`,
    { lines: [{ id: o.line.id, description: '  Rejuv Set (with the toner swapped)  ' }] });
  assert.equal(out.status, 200, JSON.stringify(out.data));

  const back = await GET(admin, `/api/orders/${o.id}`);
  assert.equal(back.data.lines[0].name, 'Rejuv Set (with the toner swapped)',
    'the documents read one name and get the one that was written');
  assert.equal(back.data.lines[0].sku, o.sku,
    'and it is still the same product coming off the same shelf');
});

test('emptying it goes back to the product rather than to nothing', async () => {
  const admin = await signIn('admin');
  const store = await signIn('warehouse');
  const o = await anOrder(admin, store);
  await POST(admin, `/api/orders/${o.id}/descriptions`,
    { lines: [{ id: o.line.id, description: 'Something else' }] });

  await POST(admin, `/api/orders/${o.id}/descriptions`,
    { lines: [{ id: o.line.id, description: '   ' }] });
  const back = await GET(admin, `/api/orders/${o.id}`);
  assert.equal(back.data.lines[0].name, o.line.name,
    'a line with no name on it is not a thing the paper can show');
  const row = await db.query('select description from order_lines where id = $1', [o.line.id]);
  assert.equal(row.rows[0].description, null, 'and it is cleared rather than blanked');
});

test('it names a line on this order and no other', async () => {
  const admin = await signIn('admin');
  const store = await signIn('warehouse');
  const mine = await anOrder(admin, store);
  const theirs = await anOrder(admin, store);

  await POST(admin, `/api/orders/${mine.id}/descriptions`,
    { lines: [{ id: mine.line.id, description: 'Only here' }] });

  const other = await GET(admin, `/api/orders/${theirs.id}`);
  assert.notEqual(other.data.lines[0].name, 'Only here',
    'renaming the product was what this replaced');
});

test('a line on somebody else’s order cannot be renamed through this one', async () => {
  const admin = await signIn('admin');
  const store = await signIn('warehouse');
  const mine = await anOrder(admin, store);
  const theirs = await anOrder(admin, store);

  await POST(admin, `/api/orders/${mine.id}/descriptions`,
    { lines: [{ id: theirs.line.id, description: 'Reached across' }] });
  const other = await GET(admin, `/api/orders/${theirs.id}`);
  assert.equal(other.data.lines[0].name, theirs.line.name,
    'the update is bounded by the order it was sent to');
});

test('once the goods have gone the paper cannot be renamed', async () => {
  const admin = await signIn('admin');
  const store = await signIn('warehouse');
  const o = await anOrder(admin, store);
  await POST(store, `/api/orders/${o.id}/dispatch`);

  const nope = await POST(admin, `/api/orders/${o.id}/descriptions`,
    { lines: [{ id: o.line.id, description: 'Too late' }] });
  assert.equal(nope.status, 400, JSON.stringify(nope.data));
  assert.match(nope.data.error, /gone with the goods/);
});

test('the warehouse floor cannot rename what it is picking', async () => {
  const admin = await signIn('admin');
  const store = await signIn('warehouse');
  const o = await anOrder(admin, store);

  const nope = await POST(store, `/api/orders/${o.id}/descriptions`,
    { lines: [{ id: o.line.id, description: 'Mine now' }] });
  assert.equal(nope.status, 403, JSON.stringify(nope.data));
});

// The /descriptions route above still stands, but the order form no longer
// renames a line — it swaps it. The product description on the form is a
// dropdown of the catalogue, and picking one moves the whole line (name, sku,
// standing price) to that product, so the paper cannot name something the
// warehouse is not holding.
test('the order form description picks a real product rather than free text', () => {
  const lines = app.slice(app.indexOf('const docLines ='), app.indexOf('function customerOrderForm'));
  assert.match(lines, /data-swap=/, 'the description is a catalogue dropdown that swaps the line');
  assert.doesNotMatch(lines, /data-notefor=/, 'and no longer a free-text rename box');

  const form = app.slice(app.indexOf('function customerOrderForm'),
                         app.indexOf('function showInvoice('));
  assert.match(form, /docLines\(lines, 5, canEdit, goods, canEdit\)/,
    'the form opens the products, the prices and the quantities together');

  const show = app.slice(app.indexOf('function showInvoice('),
                         app.indexOf('function showInvoiceDoc'));
  const save = show.slice(show.indexOf("keep.addEventListener('click'"));
  assert.doesNotMatch(save, /\/descriptions`/, 'the form swaps, it does not rename');
  assert.ok(save.indexOf('/invoice`') < save.indexOf('/lines`'),
    'the money is settled first, so the paid floor is judged on the corrected price');
});
