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

// ---------------------------------------------------------------------------
// The ordinary half
//
// The role was built as a slice of the owner and stopped there, so the menu
// listed My record, My leave and the noticeboard and nothing behind them would
// answer: both of them signed in to "Your sign-in does not allow that" on the
// first thing they clicked. A role is not only the special thing it may do —
// it is also everything ordinary that everybody who works here can already do.
// ---------------------------------------------------------------------------

/** A sign-in with a person behind it, the way a real member of staff has. */
async function onTheTeam(role, position = 'Order Management Coordinator') {
  const cookie = await signIn(role);
  const branch = (await db.query('select id from branches order by id limit 1')).rows[0];
  await db.query(
    `insert into employees (name, position, branch_id, user_id)
     values ($1, $2, $3, (select id from app_users where username = $4))`,
    [`Person ${cookie.username}`, position, branch?.id ?? null, cookie.username]);
  return cookie;
}

test('an order desk works here, so their own record answers them', async () => {
  const desk = await onTheTeam('orderdesk');

  const mine = await GET(desk, '/api/my');
  assert.equal(mine.status, 200, `their own record: ${JSON.stringify(mine.data)}`);

  assert.equal((await GET(desk, '/api/noticeboard')).status, 200,
    'a notice pinned up for the company is pinned up for them');

  // Their own password, which is not the company's business to keep from them.
  const pw = await POST(desk, '/api/my/password',
    { current: 'secret123', password: 'secret45678' });
  assert.equal(pw.status, 200, JSON.stringify(pw.data));
});

test('every screen on the order desk menu answers when it is opened', async () => {
  // The failure this file exists to prevent happening twice: a menu entry is
  // a promise, and the promise is kept by a route list somewhere else.
  const desk = await onTheTeam('orderdesk');
  const at = app.indexOf('  orderdesk: [');
  const ids = [...app.slice(at, app.indexOf('\n  ],', at)).matchAll(/\['([a-z]+)',/g)]
    .map((m) => m[1]);

  // What each screen asks for the moment it is drawn.
  const firstCall = {
    customerorder: '/api/orders?status=',
    me: '/api/my',
    myleave: '/api/my',
    notices: '/api/noticeboard',
  };

  for (const id of ids) {
    const p = firstCall[id];
    assert.ok(p, `${id} is on the menu but this test does not know what it opens`);
    const { status } = await GET(desk, p);
    assert.equal(status, 200, `${id} is on the menu and ${p} answers ${status}`);
  }
});

// ---------------------------------------------------------------------------
// Moving somebody onto it, from the app rather than a database console
// ---------------------------------------------------------------------------

test('an owner can move somebody between roles, and it takes effect at once', async () => {
  const admin = await signIn('admin');
  const staff = await signIn('employee');

  const who = (await GET(admin, '/api/users')).data
    .find((u) => u.username === staff.username);
  assert.equal(who.role, 'employee');

  const moved = await POST(admin, `/api/users/${who.id}/role`, { role: 'orderdesk' });
  assert.equal(moved.status, 200, JSON.stringify(moved.data));

  const now = (await db.query('select role, sessions_from from app_users where id = $1',
    [who.id])).rows[0];
  assert.equal(now.role, 'orderdesk');
  assert.ok(now.sessions_from, 'their sessions end with the role, because the cookie carries it');

});

test('the cookie somebody was holding does not keep the role they have lost', async () => {
  // The dangerous direction. A session cookie carries its own role, so an
  // owner demoted without their sessions ending would go on being an owner —
  // in their open tab, for another twelve hours, with nothing on any screen
  // to say so.
  const owner = await signIn('admin');
  const spare = await signIn('admin');          // so this is not the last one
  assert.ok(spare);

  const me = (await GET(owner, '/api/users')).data.find((u) => u.username === owner.username);
  assert.equal((await GET(owner, '/api/users')).status, 200, 'an owner reads the sign-ins');

  const down = await POST(owner, `/api/users/${me.id}/role`, { role: 'employee' });
  assert.equal(down.status, 200, JSON.stringify(down.data));

  const after = await GET(owner, '/api/users');
  assert.equal(after.status, 401,
    'the cookie is still signed and still unexpired — and no longer worth anything');
  assert.match(after.data.error, /signed out/i);
});

test('the last owner cannot be demoted, because nobody could put it back', async () => {
  const admin = await signIn('admin');
  const me = (await GET(admin, '/api/users')).data.find((u) => u.username === admin.username);

  // Every other owner switched off, so this one is the only way in.
  const others = (await db.query(
    "select id from app_users where role = 'admin' and active and id <> $1", [me.id])).rows;
  for (const o of others) await db.query('update app_users set active = false where id = $1', [o.id]);
  try {
    const tried = await POST(admin, `/api/users/${me.id}/role`, { role: 'employee' });
    assert.equal(tried.status, 400);
    assert.match(tried.data.error, /last owner/i,
      'and it says why, rather than failing with a permission error');
    assert.equal(
      (await db.query('select role from app_users where id = $1', [me.id])).rows[0].role,
      'admin', 'nothing moved');
  } finally {
    for (const o of others) await db.query('update app_users set active = true where id = $1', [o.id]);
  }
});

test('a portal sign-in is not moved in or out of the portal', async () => {
  const admin = await signIn('admin');
  const id = await anAccount(admin);
  const made = await POST(admin, '/api/users', {
    username: unique('portal'), display_name: 'Portal', password: 'secret12345',
    role: 'reseller', reseller_id: id });
  assert.equal(made.status, 200, JSON.stringify(made.data));

  const out = await POST(admin, `/api/users/${made.data.id}/role`, { role: 'employee' });
  assert.equal(out.status, 400);
  assert.match(out.data.error, /portal sign-in belongs to the reseller/i,
    'a sign-in pointing at a company it can no longer read is not a role change');

  const staff = await signIn('employee');
  const them = (await GET(admin, '/api/users')).data.find((u) => u.username === staff.username);
  const into = await POST(admin, `/api/users/${them.id}/role`, { role: 'reseller' });
  assert.equal(into.status, 400, 'and neither is one pointing at nothing at all');
});

test('the role picker offers every role a sign-in can be, and not the portal', () => {
  const at = app.indexOf('const ROLES = [');
  const list = app.slice(at, app.indexOf('];', at));
  const ids = [...list.matchAll(/\['([a-z]+)',/g)].map((m) => m[1]);

  assert.deepEqual(ids, ['admin', 'warehouse', 'cashier', 'supervisor', 'office',
    'orderdesk', 'datacoord', 'timekeeper', 'employee', 'observer']);
  assert.ok(!ids.includes('reseller'),
    'a portal sign-in is bound to an account, so it is created as one rather than moved into one');

  // One list behind both pickers, so the one on a new sign-in and the one on
  // an existing sign-in cannot drift apart.
  const people = app.slice(app.indexOf('SCREENS.people ='));
  assert.equal((people.match(/ROLES\.map/g) || []).length, 2);
});

test('a role with no name on screen reads as a database column', () => {
  const at = app.indexOf('const roleName =');
  const map = app.slice(at, app.indexOf('}[r] ?? r);', at));
  assert.match(map, /orderdesk: 'Order desk'/,
    'the badge in the corner says what somebody can do, in words');
});
