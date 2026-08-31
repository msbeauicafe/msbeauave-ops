// The data coordinator.
//
// New products arrive and stock has to be entered. Until this role existed the
// only sign-in that could add a product to the catalogue was the owner's, so
// keeping it current meant handing over pricing, the money and the staff
// records too. A data coordinator does the stockroom's paperwork — receive,
// count, transfer, purchase orders, reordering, write-offs — and the one thing
// the warehouse could not: add and edit a product. It never sets a selling
// price, never opens the till, and never touches a customer order.
//
// As with the order desk, the file leans on the refusals, and the sharpest one
// is checked twice: a data coordinator adds a product, but the price columns it
// sends are dropped, because a new product is priced by the owner and not by
// whoever entered it.
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
const PUT = (c, p, b) => request(c, 'PUT', p, b ?? {});

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

/** A sign-in with a person behind it, so its own record answers. */
async function onTheTeam(role) {
  const cookie = await signIn(role);
  const branch = (await db.query('select id from branches order by id limit 1')).rows[0];
  await db.query(
    `insert into employees (name, position, branch_id, user_id)
     values ($1, 'Data Coordinator', $2, (select id from app_users where username = $3))`,
    [`Person ${cookie.username}`, branch?.id ?? null, cookie.username]);
  return cookie;
}

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

// ---------------------------------------------------------------------------
// The job
// ---------------------------------------------------------------------------

test('a data coordinator adds a product and receives stock into it', async () => {
  const coord = await signIn('datacoord');
  const sku = unique('SKU');

  const added = await POST(coord, '/api/products', {
    sku, name: `Coordinator ${sku}`, brand: 'Beau Glow', category: 'Serums',
    unit_cost: 100, shelf_life_months: 24 });
  assert.equal(added.status, 200, `adding a product is theirs: ${JSON.stringify(added.data)}`);

  const listed = await GET(coord, `/api/products?q=${encodeURIComponent(sku)}`);
  assert.equal(listed.status, 200);
  assert.ok(listed.data.some((p) => p.sku === sku), 'and it is in the catalogue they read');

  const got = await POST(coord, '/api/receive',
    { sku, batch_no: unique('B'), expiry: monthsOut(24), qty: 48, unit_cost: 100 });
  assert.equal(got.status, 200, `receiving into it is theirs: ${JSON.stringify(got.data)}`);

  // Counting, and correcting the catalogue entry, are theirs as well.
  assert.equal((await POST(coord, '/api/stock-count',
    { sku, counted: 50 })).status, 200);
  assert.equal((await PUT(coord, `/api/products/${encodeURIComponent(sku)}`,
    { category: 'Ampoules' })).status, 200);
});

test('the product a data coordinator adds is priced at nothing, whatever the form sends', async () => {
  const coord = await signIn('datacoord');
  const sku = unique('SKU');

  // The form sends selling prices; a data coordinator's are ignored, because a
  // new product is priced by the owner and not by whoever entered it.
  const added = await POST(coord, '/api/products', {
    sku, name: `Priced ${sku}`, brand: 'Beau Glow', unit_cost: 90,
    wholesale_price: 250, srp: 400, retail_price: 450 });
  assert.equal(added.status, 200, JSON.stringify(added.data));

  const row = (await db.query(
    'select unit_cost, wholesale_price, srp, retail_price from products where sku = $1',
    [sku])).rows[0];
  assert.equal(Number(row.unit_cost), 90, 'the cost is theirs to record');
  assert.equal(Number(row.wholesale_price), 0, 'the reseller price is not');
  assert.equal(Number(row.srp), 0);
  assert.equal(Number(row.retail_price), 0, 'so it lands off the shelf until the owner prices it');
});

test('editing a product cannot slip a selling price past on the side', async () => {
  const admin = await signIn('admin');
  const coord = await signIn('datacoord');
  const sku = unique('SKU');
  await POST(admin, '/api/products', {
    sku, name: `Set ${sku}`, brand: 'Beau Glow',
    unit_cost: 100, wholesale_price: 250, srp: 400, retail_price: 450 });

  const edit = await PUT(coord, `/api/products/${encodeURIComponent(sku)}`,
    { category: 'Serums', retail_price: 1, wholesale_price: 1, srp: 1 });
  assert.equal(edit.status, 200, JSON.stringify(edit.data));

  const row = (await db.query(
    'select category, wholesale_price, srp, retail_price from products where sku = $1',
    [sku])).rows[0];
  assert.equal(row.category, 'Serums', 'the descriptive change lands');
  assert.equal(Number(row.retail_price), 450, 'the price the owner set is untouched');
  assert.equal(Number(row.wholesale_price), 250);
  assert.equal(Number(row.srp), 400);
});

test('a data coordinator works here, so their own record answers them', async () => {
  const coord = await onTheTeam('datacoord');
  assert.equal((await GET(coord, '/api/my')).status, 200);
  assert.equal((await GET(coord, '/api/noticeboard')).status, 200);
});

// ---------------------------------------------------------------------------
// The refusals — at the door
// ---------------------------------------------------------------------------

test('a data coordinator is turned away from prices, money, the till and orders', async () => {
  const admin = await signIn('admin');
  const coord = await signIn('datacoord');

  const sku = unique('SKU');
  await POST(admin, '/api/products', { sku, name: `X ${sku}`, brand: 'Beau Glow', unit_cost: 1 });

  const shut = [
    // The selling prices themselves — the per-code dealer prices.
    ['POST', `/api/products/${encodeURIComponent(sku)}/price`, { code: 'RD', price: 200 }],
    ['GET', '/api/pricelist', undefined],
    // The whole-catalogue loader sets prices, so it is the owner's.
    ['POST', '/api/catalogue', { items: [] }],
    // The company's money, and what it pays people.
    ['GET', '/api/finance', undefined],
    ['GET', '/api/hr', undefined],
    // Who else can sign in.
    ['GET', '/api/users', undefined],
    ['POST', '/api/users', {}],
    // The till, and taking a reseller order.
    ['GET', '/api/resellers', undefined],
    ['GET', '/api/wholesale/catalog', undefined],
  ];
  for (const [method, p, b] of shut) {
    const { status } = await request(coord, method, p, b);
    assert.equal(status, 403, `${method} ${p} should be shut, got ${status}`);
  }
});

// ---------------------------------------------------------------------------
// The refusals — at the bottom, where they count
// ---------------------------------------------------------------------------

test('the database refuses a data coordinator a selling price and a customer order', async () => {
  const coord = await signIn('datacoord');
  const shut = [
    ['set_price', "select set_price('ANY','RD',1)"],
    ['replace_catalogue', "select replace_catalogue('[]'::jsonb)"],
    ['fulfil_order', 'select fulfil_order(1)'],
    ['create_login', "select create_login('x','x','x','admin')"],
    ['set_reseller_terms', 'select set_reseller_terms(1,2,100,30)'],
  ];
  for (const [what, sql] of shut) {
    await assert.rejects(
      () => asRole('datacoord', coord.username, sql),
      (e) => /FORBIDDEN|permission denied|does not exist/i.test(e.message),
      `${what} must refuse a data coordinator even past the router`);
  }
});

test('a data coordinator cannot read what it cannot act on', async () => {
  const coord = await signIn('datacoord');
  const pay = await asRole('datacoord', coord.username,
    'select count(*)::int as n from employment_details').catch(() => null);
  assert.ok(pay === null || pay.rows[0].n === 0, 'pay is not the coordinator\'s business');
});

// ---------------------------------------------------------------------------
// The menu
// ---------------------------------------------------------------------------

test('the data coordinator menu is the stock work and their own record', () => {
  const at = app.indexOf('  datacoord: [');
  assert.ok(at > 0, 'there is a data coordinator menu');
  const menu = app.slice(at, app.indexOf('\n  ],', at));
  const ids = [...menu.matchAll(/\['([a-z]+)',/g)].map((m) => m[1]);

  assert.deepEqual(ids, ['products', 'purchaseorders', 'receive', 'inventory',
    'stockroom', 'reorder', 'me', 'myleave', 'notices']);

  for (const gone of ['pricelists', 'finance', 'hr', 'people', 'customers',
    'customerorder', 'till', 'closeday']) {
    assert.ok(!ids.includes(gone), `${gone} is not the data coordinator's`);
  }
});

test('the role picker offers Data coordinator', () => {
  const at = app.indexOf('const ROLES = [');
  const list = app.slice(at, app.indexOf('];', at));
  assert.match(list, /\['datacoord',/, 'a role a sign-in can be set to');
  assert.match(app, /datacoord: 'Data coordinator'/, 'and it has a name on the badge');
});
