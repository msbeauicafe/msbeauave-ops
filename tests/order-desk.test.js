// The order desk.
//
// Two people take reseller orders all day. Until this role existed the only
// sign-in that could do that was the owner's, so taking an order meant holding
// the keys to pricing, the catalogue, the company's money and every staff
// record — because there was no smaller key.
//
// A permission is only worth what it refuses, so this file spends most of its
// length on the refusals, and checks them twice. Once at the door, where the
// router turns the request away with a clear answer; and once at the bottom,
// where the database refuses the same thing to somebody who skipped the door
// altogether. The second is the one that counts: a route added next year that
// nobody remembers to guard is still refused, because require_role names the
// sixteen functions an order desk may run and nothing widens that by accident.
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
  assert.equal(res.status, 200, `could not sign in as ${role}`);
  const raw = (res.headers.getSetCookie?.()[0] ?? res.headers.get('set-cookie')).split(';')[0];
  return Object.assign(raw, { username });
}

/** One statement with a role's own rights, past every route there is. */
async function asRole(role, actor, sql, params = []) {
  const client = await db.connect();
  try {
    await client.query('begin');
    await client.query("select set_config('app.role',$1,true)", [role]);
    await client.query("select set_config('app.actor',$1,true)", [actor]);
    await client.query('set local role app_client');
    return await client.query(sql, params);
  } finally {
    await client.query('rollback').catch(() => {});
    client.release();
  }
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

// ---------------------------------------------------------------------------
// The job
// ---------------------------------------------------------------------------

test('an order desk can do the whole job, start to finish', async () => {
  const admin = await signIn('admin');
  const store = await signIn('warehouse');
  const desk = await signIn('orderdesk');
  const sku = await stocked(admin, store);
  const id = await anAccount(admin);

  // Find the account, and what there is to sell.
  const accounts = await GET(desk, '/api/resellers');
  assert.equal(accounts.status, 200, JSON.stringify(accounts.data));
  assert.ok(accounts.data.some((r) => Number(r.id) === Number(id)));

  const catalog = await GET(desk, '/api/wholesale/catalog');
  assert.equal(catalog.status, 200, 'a basket can only offer what the warehouse holds');
  assert.ok(catalog.data.some((p) => p.sku === sku));
  assert.equal((await GET(desk, '/api/price-codes')).status, 200,
    'and a line has to be chargeable at an agreed code');

  // Place it.
  const placed = await POST(desk, `/api/resellers/${id}/orders`, { lines: [{ sku, qty: 4 }] });
  assert.equal(placed.status, 200, JSON.stringify(placed.data));
  const order = placed.data.orderId;
  assert.ok(placed.data.co_no, 'and it comes back with its number on it');

  // Correct it — the quantity, the money, the number on the paper.
  const detail = await GET(desk, `/api/orders/${order}`);
  assert.equal(detail.status, 200);
  assert.equal(
    (await POST(desk, `/api/orders/${order}/lines`, { lines: [{ sku, qty: 6 }] })).status, 200,
    'revising an order is the order desk\'s job, not a reason to fetch the owner');
  assert.equal(
    (await POST(desk, `/api/orders/${order}/invoice`,
      { lines: detail.data.lines.map((l) => ({ id: l.id, price: 300 })) })).status, 200,
    'and so is correcting the money on it');
  assert.equal(
    (await POST(desk, `/api/orders/${order}/numbers`, { co_no: unique('CO') })).status, 200);

  // Move it along, and take the money.
  assert.equal((await POST(desk, `/api/orders/${order}/picking`)).status, 200);
  const paid = await POST(desk, `/api/resellers/${id}/confirm`,
    { payments: [{ amount: 500, method: 'BDO' }] });
  assert.equal(paid.status, 200,
    `confirming a transfer belongs beside the order it settles: ${JSON.stringify(paid.data)}`);
  const or = await POST(desk, `/api/resellers/${id}/issue-or`);
  assert.equal(or.status, 200,
    `and so does the receipt that follows it: ${JSON.stringify(or.data)}`);
  assert.match(or.data.receipt_no, /^OR-/, 'with a number the reseller can quote back');
});

test('an order desk can put a line on at no charge', async () => {
  const admin = await signIn('admin');
  const store = await signIn('warehouse');
  const desk = await signIn('orderdesk');
  const sku = await stocked(admin, store);
  const id = await anAccount(admin);

  const placed = await POST(desk, `/api/resellers/${id}/orders`, { lines: [{ sku, qty: 2 }] });
  assert.equal(placed.status, 200, JSON.stringify(placed.data));
  const detail = await GET(desk, `/api/orders/${placed.data.orderId}`);

  // A buy-ten-free-one unit, a giveaway, a sample in the box. The desk prices
  // it, so the desk has to be allowed to price it at nothing.
  const free = await POST(desk, `/api/orders/${placed.data.orderId}/invoice`,
    { lines: detail.data.lines.map((l) => ({ id: l.id, price: 0 })) });
  assert.equal(free.status, 200, JSON.stringify(free.data));

  const after = await GET(desk, `/api/orders/${placed.data.orderId}`);
  assert.ok(after.data.lines.every((l) => Number(l.unit_price) === 0),
    'the line is on the paper, at nothing');
  assert.equal(Number(after.data.total), 0);
});

// ---------------------------------------------------------------------------
// The refusals — at the door
// ---------------------------------------------------------------------------

test('an order desk is turned away from everything else', async () => {
  const admin = await signIn('admin');
  const desk = await signIn('orderdesk');
  const id = await anAccount(admin);

  const shut = [
    // The money the company makes, and what it pays people.
    ['GET', '/api/finance'],
    ['GET', '/api/hr'],
    // What things cost and what they sell for.
    ['GET', '/api/pricelist'],
    ['POST', '/api/products/ANY/price'],
    ['POST', '/api/catalogue'],
    ['GET', '/api/products?q='],
    // The account itself: terms, credit limit, tax details, standing. These
    // moved to Customers, which is the owner's screen, and the whole point of
    // the split is that the desk does not set the terms it sells on.
    ['POST', `/api/resellers/${id}/terms`],
    ['POST', `/api/resellers/${id}/tier`],
    ['POST', `/api/resellers/${id}/tax`],
    ['POST', `/api/resellers/${id}/override`],
    ['POST', `/api/resellers/${id}/approve`],
    // Who else can sign in, and as what.
    ['GET', '/api/users'],
    ['POST', '/api/users'],
    // The stockroom.
    ['POST', '/api/receive'],
    ['GET', '/api/purchase-orders?status='],
  ];

  for (const [method, p] of shut) {
    const { status } = await request(desk, method, p, method === 'GET' ? undefined : {});
    assert.equal(status, 403, `${method} ${p} should be shut to an order desk, got ${status}`);
  }
});

// ---------------------------------------------------------------------------
// The refusals — at the bottom, where they count
// ---------------------------------------------------------------------------

test('the database refuses an order desk the same things, route or no route', async () => {
  const desk = await signIn('orderdesk');

  const shut = [
    ['set_price', "select set_price('ANY','RD',1)"],
    ['replace_catalogue', "select replace_catalogue('[]'::jsonb)"],
    ['create_login', "select create_login('x','x','x','admin')"],
    ['set_reseller_terms', 'select set_reseller_terms(1, 2, 100, 30)'],
  ];

  for (const [what, sql] of shut) {
    await assert.rejects(
      () => asRole('orderdesk', desk.username, sql),
      (e) => /FORBIDDEN|permission denied|does not exist/i.test(e.message),
      `${what} must refuse an order desk even when nobody asked the router first`);
  }
});

test('an order desk cannot read what it cannot act on', async () => {
  const desk = await signIn('orderdesk');
  // Pay is not merely hidden on a screen — it is not selectable at all, which
  // is the only version of hidden that survives somebody opening a terminal.
  const pay = await asRole('orderdesk', desk.username,
    'select count(*)::int as n from employment_details').catch(() => null);
  assert.ok(pay === null || pay.rows[0].n === 0, 'a salary is not the order desk\'s business');
});

// ---------------------------------------------------------------------------
// The menu
// ---------------------------------------------------------------------------

test('the order desk menu is the job and their own record, and nothing else', () => {
  const at = app.indexOf('  orderdesk: [');
  assert.ok(at > 0, 'there is an order desk menu');
  const menu = app.slice(at, app.indexOf('\n  ],', at));
  const ids = [...menu.matchAll(/\['([a-z]+)',/g)].map((m) => m[1]);

  assert.deepEqual(ids, ['customerorder', 'me', 'myleave', 'notices'],
    'the job, then the three screens everybody who works here has');

  for (const gone of ['pricelists', 'finance', 'hr', 'products', 'people',
    'receive', 'inventory', 'purchaseorders', 'reports', 'crm', 'customers']) {
    assert.ok(!ids.includes(gone), `${gone} is not the order desk's`);
  }
});

test('a role with no name on screen reads as a database column', () => {
  const at = app.indexOf('const roleName =');
  const map = app.slice(at, app.indexOf('}[r] ?? r);', at));
  assert.match(map, /orderdesk: 'Order desk'/,
    'the badge in the corner says what somebody can do, in words');
});
