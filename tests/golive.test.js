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
      // On the real list, but nobody has priced it yet. It is off the shelf
      // for the same reason a retired product is, and must survive anyway:
      // it is waiting for a price, not for deletion.
      { sku: 'LIVE-02', name: 'Priced Later', category: 'Soaps' },
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
    const after = (await GET(admin, '/api/products')).data;
    assert.equal(after.some((p) => p.sku === 'TRADED-01'), false,
      'a product dropped from the list leaves nothing behind once its history has gone');
    assert.ok(after.some((p) => p.sku === 'LIVE-02' && !p.active),
      'a product on the list that nobody has priced yet is waiting for a price, '
      + 'not for deletion — erasing must not take it');

    // The first real sale has to be receipt one. A gap in the numbering is a
    // question somebody has to answer later and nobody will be able to.
    await POST(store, '/api/receive',
      { sku: 'LIVE-01', batch_no: unique('B'), expiry: monthsOut(24), qty: 10 });
    const first = await POST(till, '/api/till/sell',
      { lines: [{ sku: 'LIVE-01', qty: 1 }], method: 'cash', tendered: 200 });
    assert.equal(first.status, 200, JSON.stringify(first.data));
    assert.match(first.data.receipt_no, /-00001$/, first.data.receipt_no);
  });

// ===========================================================================
// A whole delivery note at once
// ===========================================================================

const priced = (admin, items) => load(admin, items);

test('a delivery note goes in as one thing, split across the pools line by line',
  async () => {
    const admin = await signIn('admin');
    const store = await signIn('warehouse');
    await priced(admin, [
      { sku: 'DEL-01', name: 'First Delivered', category: 'Soaps',
        unit_cost: 40, wholesale_price: 60, srp: 90, retail_price: 100 },
      { sku: 'DEL-02', name: 'Second Delivered', category: 'Soaps',
        unit_cost: 10, wholesale_price: 60, srp: 90, retail_price: 100 },
    ]);

    const r = await POST(store, '/api/deliveries', {
      lines: [
        { sku: 'DEL-01', batch_no: 'A1', expiry: monthsOut(24), qty: 100, unit_cost: 50 },
        { sku: 'DEL-02', batch_no: 'B1', expiry: monthsOut(24), qty: 10 },
      ],
    });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.equal(r.data.lines, 2);
    assert.equal(r.data.units, 110);
    // 100 at the cost given, plus 10 at the cost the product already had.
    assert.equal(Number(r.data.value), 100 * 50 + 10 * 10);

    const rows = (await GET(admin, '/api/products')).data;
    const first = rows.find((p) => p.sku === 'DEL-01');
    assert.equal(Number(first.free_b2b), 70, 'the house split still applies per line');
    assert.equal(Number(first.free_shop), 20);
    assert.equal(Number(first.free_reserve), 10);
    assert.equal(Number(first.unit_cost), 50, 'a cost on the note becomes the cost');
  });

test('one bad line and none of the delivery lands', async () => {
  const admin = await signIn('admin');
  const store = await signIn('warehouse');
  await priced(admin, [
    { sku: 'DEL-01', name: 'First Delivered', category: 'Soaps',
      unit_cost: 50, wholesale_price: 60, srp: 90, retail_price: 100 },
    { sku: 'DEL-03', name: 'Third Delivered', category: 'Soaps',
      unit_cost: 20, wholesale_price: 60, srp: 90, retail_price: 100 },
  ]);
  const before = (await GET(admin, '/api/products')).data
    .find((p) => p.sku === 'DEL-03');

  const r = await POST(store, '/api/deliveries', {
    lines: [
      { sku: 'DEL-03', batch_no: 'GOOD', expiry: monthsOut(24), qty: 50 },
      { sku: 'DEL-01', batch_no: 'PAST', expiry: monthsOut(-2), qty: 10 },
    ],
  });

  assert.equal(r.status, 400);
  assert.match(r.data.error, /already passed/);
  const after = (await GET(admin, '/api/products')).data.find((p) => p.sku === 'DEL-03');
  assert.equal(Number(after.free_shop), Number(before.free_shop),
    'the good line before the bad one must not have been booked in');
});

test('a delivery naming a product that is not on sale is refused by name', async () => {
  const store = await signIn('warehouse');
  const r = await POST(store, '/api/deliveries', {
    lines: [{ sku: 'NOT-A-THING', batch_no: 'X1', expiry: monthsOut(24), qty: 5 }],
  });
  assert.equal(r.status, 400);
  assert.match(r.data.error, /NOT-A-THING/);
});

test('the same batch cannot be received twice, on one note or across two', async () => {
  const admin = await signIn('admin');
  const store = await signIn('warehouse');
  await priced(admin, [{ sku: 'DEL-04', name: 'Fourth Delivered', category: 'Soaps',
    unit_cost: 10, wholesale_price: 60, srp: 90, retail_price: 100 }]);

  const twice = await POST(store, '/api/deliveries', {
    lines: [
      { sku: 'DEL-04', batch_no: 'SAME', expiry: monthsOut(24), qty: 5 },
      { sku: 'DEL-04', batch_no: 'SAME', expiry: monthsOut(24), qty: 5 },
    ],
  });
  assert.equal(twice.status, 400);
  assert.match(twice.data.error, /twice/);

  await POST(store, '/api/deliveries', {
    lines: [{ sku: 'DEL-04', batch_no: 'ONCE', expiry: monthsOut(24), qty: 5 }],
  });
  const again = await POST(store, '/api/deliveries', {
    lines: [{ sku: 'DEL-04', batch_no: 'ONCE', expiry: monthsOut(24), qty: 5 }],
  });
  assert.equal(again.status, 400);
  assert.match(again.data.error, /already been received/);
});

test('the counter cannot book stock in', async () => {
  const till = await signIn('cashier');
  const r = await POST(till, '/api/deliveries', {
    lines: [{ sku: 'DEL-04', batch_no: 'Z9', expiry: monthsOut(24), qty: 1 }],
  });
  assert.equal(r.status, 403);
});

// ===========================================================================
// A shop with no resellers yet
//
// The house split holds 70% of every delivery back for wholesale. A shop that
// has no resellers wants none of that, and the case that catches people out is
// the small one: under 70/20/10 a delivery of a single unit puts nothing on
// the shelf at all, because 20% of one rounds down to none.
// ===========================================================================

test('with the split set to shop-only, even one unit reaches the shelf', async () => {
  const admin = await signIn('admin');
  const store = await signIn('warehouse');

  await load(admin, [{ sku: 'SHOPONLY-01', name: 'Shop Only', category: 'Soaps',
    unit_cost: 10, wholesale_price: 60, srp: 90, retail_price: 100 }]);
  const set = await request(admin, 'PUT', '/api/products/SHOPONLY-01',
    { alloc_b2b: 0, alloc_shop: 1, alloc_reserve: 0 });
  assert.equal(set.status, 200, JSON.stringify(set.data));

  for (const qty of [1, 3, 100]) {
    const r = await POST(store, '/api/deliveries', {
      lines: [{ sku: 'SHOPONLY-01', batch_no: unique('S'), expiry: monthsOut(24), qty }],
    });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.deepEqual(r.data.received[0].split, { shop: qty },
      `a delivery of ${qty} should land entirely on the shelf`);
  }

  const p = (await GET(admin, '/api/products')).data.find((x) => x.sku === 'SHOPONLY-01');
  assert.equal(Number(p.free_shop), 104);
  assert.equal(Number(p.free_b2b), 0, 'nothing is held back for resellers who do not exist');
  assert.equal(Number(p.free_reserve), 0);
});

test('under the house split a delivery of one unit reaches nobody, which is why the above matters',
  async () => {
    const admin = await signIn('admin');
    const store = await signIn('warehouse');

    await load(admin, [{ sku: 'HOUSE-01', name: 'House Split', category: 'Soaps',
      unit_cost: 10, wholesale_price: 60, srp: 90, retail_price: 100 }]);

    const r = await POST(store, '/api/deliveries', {
      lines: [{ sku: 'HOUSE-01', batch_no: unique('H'), expiry: monthsOut(24), qty: 1 }],
    });
    assert.deepEqual(r.data.received[0].split, { b2b: 1 },
      'the single unit goes to wholesale, and the shop still reads as sold out');
  });

// ===========================================================================
// The split, set from the price list
// ===========================================================================

test('a price list can set the split, and leaving it off keeps what is there', async () => {
  const admin = await signIn('admin');
  const store = await signIn('warehouse');

  await load(admin, [{ sku: 'SPLIT-01', name: 'Split From List', category: 'Soaps',
    unit_cost: 10, wholesale_price: 60, srp: 90, retail_price: 100,
    alloc_b2b: 0, alloc_shop: 1, alloc_reserve: 0 }]);

  let r = await POST(store, '/api/deliveries', {
    lines: [{ sku: 'SPLIT-01', batch_no: unique('S'), expiry: monthsOut(24), qty: 10 }],
  });
  assert.deepEqual(r.data.received[0].split, { shop: 10 },
    'the split came from the list, not the house default');

  // Loaded again with no split column: the product keeps what it has.
  await load(admin, [{ sku: 'SPLIT-01', name: 'Split From List', retail_price: 120 }]);
  r = await POST(store, '/api/deliveries', {
    lines: [{ sku: 'SPLIT-01', batch_no: unique('S'), expiry: monthsOut(24), qty: 10 }],
  });
  assert.deepEqual(r.data.received[0].split, { shop: 10 },
    'a list without a split column must not quietly reset it to 70/20/10');
});

test('a split that does not add up to 100 is refused, naming the product', async () => {
  const admin = await signIn('admin');
  const r = await load(admin, [{ sku: 'SPLIT-02', name: 'Bad Split', retail_price: 100,
    alloc_b2b: 0.5, alloc_shop: 0.8, alloc_reserve: 0 }]);
  assert.equal(r.status, 400);
  assert.match(r.data.error, /Bad Split/);
  assert.match(r.data.error, /130/, 'the message says what it actually adds up to');
});

test('two thirds of a split is a typo, not a split', async () => {
  const admin = await signIn('admin');
  const r = await load(admin, [{ sku: 'SPLIT-03', name: 'Partial Split', retail_price: 100,
    alloc_b2b: 0, alloc_shop: 1 }]);
  assert.equal(r.status, 400);
  assert.match(r.data.error, /all three/);
});

test('a new product with no split on the list takes the house 70/20/10', async () => {
  const admin = await signIn('admin');
  const store = await signIn('warehouse');
  await load(admin, [{ sku: 'SPLIT-04', name: 'No Split Given', category: 'Soaps',
    unit_cost: 10, wholesale_price: 60, srp: 90, retail_price: 100 }]);
  const r = await POST(store, '/api/deliveries', {
    lines: [{ sku: 'SPLIT-04', batch_no: unique('S'), expiry: monthsOut(24), qty: 100 }],
  });
  assert.deepEqual(r.data.received[0].split, { b2b: 70, shop: 20, reserve: 10 });
});
