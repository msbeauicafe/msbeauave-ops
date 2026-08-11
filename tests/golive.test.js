// Going live: loading the real catalogue, and erasing the practice run.
//
// These get a database of their own, because both operations are about the
// whole shop at once. A test that erases every sale cannot share a database
// with tests that are counting sales, and a catalogue load retires everything
// not on the list — including whatever another test had just created. Sharing
// would make these tests either destructive or dishonestly narrow.
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

const load = (admin, items) => POST(admin, '/api/catalogue', { items });

// ===========================================================================
// Loading a price list
// ===========================================================================

test('a price list loads in one go, and a product with no price stays off the shelf',
  async () => {
    const admin = await signIn('admin');
    const r = await load(admin, [
      { sku: 'BSE-SOP-01', name: 'Kojic Papaya Soap 135g', category: 'Soaps',
        unit_cost: 75, wholesale_price: 95, srp: 120, retail_price: 130 },
      { sku: 'BSE-TON-01', name: 'Rejuvenating Toner 60ml', category: 'Toners' },
    ]);
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.equal(r.data.added, 2);
    assert.equal(r.data.unpriced, 1);

    const rows = (await GET(admin, '/api/products')).data;
    const soap = rows.find((p) => p.sku === 'BSE-SOP-01');
    const toner = rows.find((p) => p.sku === 'BSE-TON-01');

    assert.equal(soap.active, true, 'a priced product is on sale');
    assert.equal(Number(soap.retail_price), 130);
    assert.equal(toner.active, false,
      'a product nobody has priced must not be sellable at nothing');
  });

test('a shop price below what resellers sell at is refused, and nothing else is written',
  async () => {
    const admin = await signIn('admin');
    const before = (await GET(admin, '/api/products')).data.length;

    const r = await load(admin, [
      { sku: 'BSE-SOP-01', name: 'Kojic Papaya Soap 135g', category: 'Soaps',
        unit_cost: 75, wholesale_price: 95, srp: 120, retail_price: 130 },
      { sku: 'BSE-NEW-99', name: 'Something New', category: 'Soaps',
        srp: 200, retail_price: 150 },
    ]);

    assert.equal(r.status, 400);
    assert.match(r.data.error, /below the 200/,
      'the message has to name the figure that is wrong');
    assert.equal((await GET(admin, '/api/products')).data.length, before,
      'a list that fails anywhere writes nothing anywhere');
  });

test('the list is the catalogue: what is dropped is removed if it never traded, hidden if it did',
  async () => {
    const admin = await signIn('admin');
    const store = await signIn('warehouse');

    await load(admin, [
      { sku: 'KEEP-01', name: 'Stays On The List', category: 'Soaps',
        unit_cost: 10, srp: 40, retail_price: 50 },
      { sku: 'TRADED-01', name: 'Had A Delivery', category: 'Soaps',
        unit_cost: 10, srp: 40, retail_price: 50 },
      { sku: 'UNTOUCHED-01', name: 'Never Traded', category: 'Soaps',
        unit_cost: 10, srp: 40, retail_price: 50 },
    ]);

    const got = await POST(store, '/api/receive',
      { sku: 'TRADED-01', batch_no: unique('B'), expiry: monthsOut(24), qty: 5 });
    assert.equal(got.status, 200, JSON.stringify(got.data));

    // The new list drops the last two.
    const r = await load(admin, [
      { sku: 'KEEP-01', name: 'Stays On The List', category: 'Soaps',
        unit_cost: 10, srp: 40, retail_price: 50 },
    ]);
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.deepEqual(r.data.hidden, ['Had A Delivery']);
    assert.deepEqual(r.data.removed, ['Never Traded']);

    const rows = (await GET(admin, '/api/products')).data;
    assert.equal(rows.find((p) => p.sku === 'UNTOUCHED-01'), undefined,
      'a product that never traded leaves no trace behind');
    assert.equal(rows.find((p) => p.sku === 'TRADED-01').active, false,
      'a product with a delivery against it is hidden, never deleted — '
      + 'that delivery still has to add up');
  });

test('a list that repeats a code is refused rather than silently keeping the last one',
  async () => {
    const admin = await signIn('admin');
    const r = await load(admin, [
      { sku: 'DUP-01', name: 'First', retail_price: 100 },
      { sku: 'DUP-01', name: 'Second', retail_price: 200 },
    ]);
    assert.equal(r.status, 400);
    assert.match(r.data.error, /twice/);
  });

test('only the owner can load a catalogue', async () => {
  const till = await signIn('cashier');
  const r = await load(till, [{ sku: 'X-1', name: 'Anything', retail_price: 10 }]);
  assert.equal(r.status, 403);
});

// ===========================================================================
// Erasing the practice run
// ===========================================================================

test('erasing refuses without the word, so it cannot happen by accident', async () => {
  const admin = await signIn('admin');
  const r = await POST(admin, '/api/catalogue/erase', { confirm: 'yes' });
  assert.equal(r.status, 400);
  assert.match(r.data.error, /type ERASE/);
});

test('only the owner can erase', async () => {
  const till = await signIn('cashier');
  const r = await POST(till, '/api/catalogue/erase', { confirm: 'ERASE' });
  assert.equal(r.status, 403);
});

test('erasing clears the trading, keeps the people and the catalogue, and restarts receipts',
  async () => {
    const admin = await signIn('admin');
    const store = await signIn('warehouse');
    const till = await signIn('cashier');

    await load(admin, [
      { sku: 'LIVE-01', name: 'Real Product', category: 'Soaps',
        unit_cost: 40, wholesale_price: 60, srp: 90, retail_price: 100 },
    ]);
    await POST(store, '/api/receive',
      { sku: 'LIVE-01', batch_no: unique('B'), expiry: monthsOut(24), qty: 50 });
    const practice = await POST(till, '/api/till/sell',
      { lines: [{ sku: 'LIVE-01', qty: 2 }], method: 'cash', tendered: 500 });
    assert.equal(practice.status, 200, JSON.stringify(practice.data));

    const users = Number((await db.query('select count(*) from app_users')).rows[0].count);
    const onSale = (await GET(admin, '/api/products')).data
      .filter((p) => p.active).map((p) => p.sku).sort();

    const r = await POST(admin, '/api/catalogue/erase', { confirm: 'erase' });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.ok(r.data.sales_erased >= 1);
    assert.ok(r.data.units_erased >= 48);

    const count = async (t) =>
      Number((await db.query(`select count(*) from ${t}`)).rows[0].count);
    for (const t of ['sales', 'orders', 'batches', 'stock', 'movements',
      'invoices', 'payments', 'expenses', 'promos', 'order_lines']) {
      assert.equal(await count(t), 0, `${t} should be empty after erasing`);
    }

    assert.equal(await count('app_users'), users, 'sign-ins are people, not practice');
    assert.deepEqual((await GET(admin, '/api/products')).data
      .filter((p) => p.active).map((p) => p.sku).sort(), onSale,
      'everything that was on sale is still on sale — the catalogue is replaced '
      + 'by loading a price list, never by erasing');

    // Practice products that were only hidden — because they had deliveries
    // against them at the time the real list was loaded — have nothing left
    // against them now, so they go rather than lingering as empty rows.
    assert.equal((await GET(admin, '/api/products')).data.some((p) => !p.active), false,
      'no hidden leftovers survive the erase');

    // The first real sale has to be receipt one. A gap in the numbering is a
    // question somebody has to answer later and nobody will be able to.
    await POST(store, '/api/receive',
      { sku: 'LIVE-01', batch_no: unique('B'), expiry: monthsOut(24), qty: 10 });
    const first = await POST(till, '/api/till/sell',
      { lines: [{ sku: 'LIVE-01', qty: 1 }], method: 'cash', tendered: 200 });
    assert.equal(first.status, 200, JSON.stringify(first.data));
    assert.match(first.data.receipt_no, /-00001$/, first.data.receipt_no);
  });
