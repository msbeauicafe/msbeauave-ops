// One account buys to send straight on to somebody else.
//
// Valerine Rodil's order forms have carried a handwritten "DS: JHEM" beside
// her name for as long as the form has existed. Nobody else's do — so a Drop
// ship box on every order would be a field sixty-odd accounts have to ignore
// and one of them has to remember.
//
// It is a switch on the account rather than a name written into the code. Off
// for everybody by default; on for the account that needs it, and only then
// does the box appear. A second account starting to work this way is a tick,
// not a deployment.
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

async function anAccount(admin) {
  const { data } = await POST(admin, '/api/resellers',
    { name: unique('Reseller'), email: 'b@example.ph', tier: 2,
      credit_limit: 1_000_000, terms_days: 15 });
  await POST(admin, `/api/resellers/${data.id}/approve`);
  return data.id;
}

async function stocked(admin, store) {
  const sku = unique('SKU');
  await POST(admin, '/api/products', {
    sku, name: `Test ${sku}`, brand: 'Beau Glow', category: 'Serums',
    unit_cost: 100, wholesale_price: 250, srp: 400, retail_price: 450,
    shelf_life_months: 24 });
  await POST(store, '/api/receive',
    { sku, batch_no: unique('B'), expiry: monthsOut(24), qty: 60 });
  return sku;
}

const rowOf = async (id) => (await db.query(
  'select drop_ship, drop_ship_to from resellers where id = $1', [id])).rows[0];

test('an account ships on to nobody until somebody says otherwise', async () => {
  const admin = await signIn('admin');
  const id = await anAccount(admin);
  assert.equal((await rowOf(id)).drop_ship, false,
    'sixty accounts should not be asked a question that is about one of them');
});

test('the switch turns it on and remembers who it usually goes to', async () => {
  const admin = await signIn('admin');
  const id = await anAccount(admin);

  const on = await POST(admin, `/api/resellers/${id}/dropship`, { on: true, to: '  JHEM ' });
  assert.equal(on.status, 200, JSON.stringify(on.data));
  const after = await rowOf(id);
  assert.equal(after.drop_ship, true);
  assert.equal(after.drop_ship_to, 'JHEM', 'trimmed, so the form does not print a space');
});

test('turning it off forgets the name rather than leaving it to reappear', async () => {
  const admin = await signIn('admin');
  const id = await anAccount(admin);
  await POST(admin, `/api/resellers/${id}/dropship`, { on: true, to: 'JHEM' });
  await POST(admin, `/api/resellers/${id}/dropship`, { on: false });

  const after = await rowOf(id);
  assert.equal(after.drop_ship, false);
  assert.equal(after.drop_ship_to, null,
    'a name left behind is a name that turns up on a form months later');
});

test('an order carries who it is being sent on to', async () => {
  const admin = await signIn('admin');
  const store = await signIn('warehouse');
  const sku = await stocked(admin, store);
  const id = await anAccount(admin);
  await POST(admin, `/api/resellers/${id}/dropship`, { on: true, to: 'JHEM' });

  const order = await POST(admin, `/api/resellers/${id}/orders`,
    { lines: [{ sku, qty: 2 }], drop_ship: 'RICA' });
  assert.equal(order.status, 200, JSON.stringify(order.data));

  const o = await db.query('select drop_ship from orders where id = $1', [order.data.orderId]);
  assert.equal(o.rows[0].drop_ship, 'RICA', 'this order went to Rica, not the usual name');
  assert.equal((await rowOf(id)).drop_ship_to, 'RICA',
    'and what was typed this time fills the box next time');

  const back = await GET(admin, `/api/orders/${order.data.orderId}`);
  assert.equal(back.data.drop_ship, 'RICA', 'the documents can read it off the order');
});

test('an account not set up for it cannot be given a third party', async () => {
  const admin = await signIn('admin');
  const store = await signIn('warehouse');
  const sku = await stocked(admin, store);
  const id = await anAccount(admin);          // switch left off

  const order = await POST(admin, `/api/resellers/${id}/orders`, { lines: [{ sku, qty: 1 }] });
  const nope = await POST(admin, `/api/orders/${order.data.orderId}/dropship`, { to: 'SOMEBODY' });
  assert.equal(nope.status, 400, JSON.stringify(nope.data));
  assert.match(nope.data.error, /not set up/);

  const o = await db.query('select drop_ship from orders where id = $1', [order.data.orderId]);
  assert.equal(o.rows[0].drop_ship, null,
    'a stray field on a form must not put a third party on another account\'s invoice');
});

test('the box and the DS line only appear for an account that has it', () => {
  const at = app.indexOf('SCREENS.chatorders = async');
  const screen = app.slice(at, app.indexOf('\nSCREENS.', at + 10));
  assert.match(screen, /\$\{picked\.drop_ship \? `/,
    'the box is drawn only where the account has the switch on');
  assert.match(screen, /id="ch_ds"/, 'and it is a box somebody types into');

  const party = app.slice(app.indexOf('const docParty ='), app.indexOf('const docLines ='));
  assert.match(party, /who\?\.drop_ship \?/,
    'the printed form shows DS only when the order has somebody in it');
  assert.match(party, /<b>DS:<\/b>/, 'written the way the paper form writes it');
});
