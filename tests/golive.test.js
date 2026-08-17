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
import { today as manilaToday } from '../lib/day.js';
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
const PUT = (c, p, b) => request(c, 'PUT', p, b ?? {});

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
  return Object.assign(raw.split(';')[0], { username });
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
  assert.match(again.data.error, /already at this branch/);
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

// ===========================================================================
// Removing a sign-in
//
// Switching off keeps the row and is the right answer most of the time.
// Removing is for accounts that should never have existed — duplicates, tests,
// typos — and it has to leave the record of what they did intact.
// ===========================================================================

const DELETE = (c, p) => request(c, 'DELETE', p);

test('a sign-in is removed, and what it did stays in the records under its name',
  async () => {
    const admin = await signIn('admin');
    const store = await signIn('warehouse');

    await load(admin, [{ sku: 'GONE-01', name: 'Handled By Someone Leaving',
      category: 'Soaps', unit_cost: 10, wholesale_price: 60, srp: 80, retail_price: 100 }]);
    const got = await POST(store, '/api/deliveries', {
      lines: [{ sku: 'GONE-01', batch_no: unique('G'), expiry: monthsOut(24), qty: 10 }],
    });
    assert.equal(got.status, 200, JSON.stringify(got.data));

    const before = (await db.query(
      'select count(*)::int as n from audit_log where actor = $1', [store.username])).rows[0].n;
    assert.ok(before > 0, 'the delivery should have been journalled');

    const row = (await GET(admin, '/api/users')).data.find((u) => u.username === store.username);
    const r = await DELETE(admin, `/api/users/${row.id}`);
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.equal(r.data.removed, store.username);

    assert.equal((await GET(admin, '/api/users')).data.some((u) => u.id === row.id), false,
      'the sign-in is gone');
    assert.equal((await db.query(
      'select count(*)::int as n from audit_log where actor = $1', [store.username])).rows[0].n,
      before,
      'the journal names who did what, so removing the account loses no history');
  });

test('you cannot remove the sign-in you are using', async () => {
  const admin = await signIn('admin');
  const mine = (await GET(admin, '/api/users')).data.find((u) => u.username === admin.username);
  const r = await DELETE(admin, `/api/users/${mine.id}`);
  assert.equal(r.status, 400);
  assert.match(r.data.error, /sign-in you are using/);
});

test('the last admin standing cannot be removed', async () => {
  // Unreachable over HTTP on purpose: whoever is calling is themselves an
  // active admin, so a second one always exists. The guard is there for
  // anything reaching the database directly, and that is where it is checked.
  const admin = await signIn('admin');
  const only = (await db.query(
    `select id, username from app_users where username = $1`, [admin.username])).rows[0];
  await db.query(
    `update app_users set active = false where role = 'admin' and username <> $1`,
    [admin.username]);
  try {
    await assert.rejects(
      db.query(`do $$ begin
        perform set_config('app.role', 'admin', true);
        perform set_config('app.actor', 'somebody-else', true);
        perform remove_login(${only.id});
      end $$;`),
      /last admin/);
  } finally {
    await db.query(`update app_users set active = true where role = 'admin'`);
  }
});

test('removing a login leaves the person on the team, minus the link', async () => {
  const admin = await signIn('admin');
  const leaver = await signIn('cashier');
  const id = (await GET(admin, '/api/users')).data
    .find((u) => u.username === leaver.username).id;

  const person = await POST(admin, '/api/team',
    { name: 'Someone Real', position: 'Counter', user_id: id });
  assert.equal(person.status, 200, JSON.stringify(person.data));

  assert.equal((await DELETE(admin, `/api/users/${id}`)).status, 200);

  const team = (await GET(admin, '/api/team')).data.team;
  const still = team.find((p) => p.name === 'Someone Real');
  assert.ok(still, 'the person stays on the team');
  assert.equal(still.user_id, null, 'they only lose the link to the account that has gone');
});

test('the counter cannot remove sign-ins', async () => {
  const admin = await signIn('admin');
  const till = await signIn('cashier');
  const target = (await GET(admin, '/api/users')).data.find((u) => u.username === till.username);
  const r = await DELETE(till, `/api/users/${target.id}`);
  assert.equal(r.status, 403);
});

// ===========================================================================
// Creating a sign-in
// ===========================================================================

test('a reseller sign-in with no reseller named is refused in words, not in constraints',
  async () => {
    const admin = await signIn('admin');
    const r = await POST(admin, '/api/users', {
      username: unique('portal'), password: 'secret123', role: 'reseller',
    });
    assert.equal(r.status, 400);
    assert.match(r.data.error, /has to belong to a reseller/);
    assert.doesNotMatch(r.data.error, /constraint|relation/i,
      'the message is for whoever is standing at the counter');
  });

test('a username already taken is refused by name', async () => {
  const admin = await signIn('admin');
  const taken = admin.username;
  const r = await POST(admin, '/api/users', {
    username: taken.toUpperCase(), password: 'secret123', role: 'cashier',
  });
  assert.equal(r.status, 400);
  assert.match(r.data.error, /already a sign-in called/);
});

test('only a reseller sign-in may belong to a reseller', async () => {
  const admin = await signIn('admin');
  const seller = await POST(admin, '/api/resellers',
    { name: unique('Company'), email: 'buyer@example.ph', tier: 2, credit_limit: 1000 });
  const r = await POST(admin, '/api/users', {
    username: unique('mixed'), password: 'secret123', role: 'cashier',
    reseller_id: seller.data.id,
  });
  assert.equal(r.status, 400);
  assert.match(r.data.error, /Only a reseller sign-in/);
});

test('a reseller sign-in works once the company exists', async () => {
  const admin = await signIn('admin');
  const seller = await POST(admin, '/api/resellers',
    { name: unique('Company'), email: 'buyer@example.ph', tier: 2, credit_limit: 1000 });
  const r = await POST(admin, '/api/users', {
    username: unique('portal'), password: 'secret123', role: 'reseller',
    reseller_id: seller.data.id,
  });
  assert.equal(r.status, 200, JSON.stringify(r.data));
});

// ===========================================================================
// The time clock
//
// Sixty people cannot queue at the till to be clocked in by a cashier, so they
// do it themselves on a shared device. The PIN is the only thing standing
// between one person and another person's attendance record.
// ===========================================================================

async function hire(admin, name, position = 'Counter') {
  const r = await POST(admin, '/api/team', { name, position });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  return Number(r.data.id);
}

test('several people are taken on at once, and each is refused the clock until they have a PIN',
  async () => {
    const admin = await signIn('admin');
    const stamp = unique('crew');
    const r = await POST(admin, '/api/team/bulk', {
      people: [
        { name: `${stamp} One`, position: 'Counter', phone: '09171234567' },
        { name: `${stamp} Two`, position: 'Stockroom' },
      ],
    });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.equal(r.data.added, 2);

    const team = (await GET(admin, '/api/team')).data.team;
    const one = team.find((p) => p.name === `${stamp} One`);
    assert.equal(one.has_pin, false, 'nobody gets a PIN by being added');

    const tried = await POST(admin, '/api/clock', { employeeId: one.id, pin: '1234' });
    assert.equal(tried.status, 400);
    assert.match(tried.data.error, /no PIN yet/);
  });

test('a list with the same person twice is refused before anybody is added', async () => {
  const admin = await signIn('admin');
  const before = (await GET(admin, '/api/team')).data.team.length;
  const stamp = unique('dup');
  const r = await POST(admin, '/api/team/bulk', {
    people: [{ name: stamp, position: 'Counter' }, { name: stamp, position: 'Stockroom' }],
  });
  assert.equal(r.status, 400);
  assert.match(r.data.error, /twice/);
  assert.equal((await GET(admin, '/api/team')).data.team.length, before);
});

test('the PIN clocks a person on and the same PIN clocks them off', async () => {
  const admin = await signIn('admin');
  const id = await hire(admin, unique('Clocker'));
  assert.equal((await POST(admin, `/api/team/${id}/pin`, { pin: '4821' })).status, 200);

  const on = await POST(admin, '/api/clock', { employeeId: id, pin: '4821' });
  assert.equal(on.status, 200, JSON.stringify(on.data));
  assert.equal(on.data.action, 'in');

  const team = (await GET(admin, '/api/team')).data.team;
  assert.equal(team.find((p) => Number(p.id) === id).on_shift, true);

  const off = await POST(admin, '/api/clock', { employeeId: id, pin: '4821' });
  assert.equal(off.data.action, 'out');
  assert.ok(off.data.worked_minutes >= 0);
  assert.equal((await GET(admin, '/api/team')).data.team.find((p) => Number(p.id) === id).on_shift, false);
});

test('the wrong PIN clocks nobody on', async () => {
  const admin = await signIn('admin');
  const id = await hire(admin, unique('Guarded'));
  await POST(admin, `/api/team/${id}/pin`, { pin: '1111' });

  const r = await POST(admin, '/api/clock', { employeeId: id, pin: '2222' });
  assert.equal(r.status, 400);
  assert.match(r.data.error, /does not match/);
  assert.equal((await GET(admin, '/api/team')).data.team.find((p) => Number(p.id) === id).on_shift, false);
});

test('a PIN shorter than four digits is refused, and the hash never leaves the server',
  async () => {
    const admin = await signIn('admin');
    const id = await hire(admin, unique('Short'));
    const r = await POST(admin, `/api/team/${id}/pin`, { pin: '12' });
    assert.equal(r.status, 400);
    assert.match(r.data.error, /4 to 8 digits/);

    const person = (await GET(admin, '/api/team')).data.team.find((p) => Number(p.id) === id);
    assert.equal('pin_hash' in person, false, 'the hash is never sent to a browser');
  });

test('hours add up over whatever period gets paid, counting an open shift up to now',
  async () => {
    const admin = await signIn('admin');
    const id = await hire(admin, unique('Hours'), 'Stockroom');
    await POST(admin, `/api/team/${id}/pin`, { pin: '9090' });
    await POST(admin, '/api/clock', { employeeId: id, pin: '9090' });

    const today = manilaToday();
    const r = await GET(admin, `/api/team/hours?from=${today}&to=${today}`);
    assert.equal(r.status, 200, JSON.stringify(r.data));

    const mine = r.data.people.find((x) => Number(x.employee_id) === id);
    assert.ok(mine, 'the person appears in the period');
    assert.equal(mine.days, 1);
    assert.equal(mine.still_open, 1,
      'a shift nobody closed is flagged rather than quietly counted as zero');
    assert.ok(Number(mine.hours) >= 0);
  });

test('the shift log covers a range rather than the last handful', async () => {
  const admin = await signIn('admin');
  const today = manilaToday();
  const r = await GET(admin, `/api/team/shifts?from=${today}&to=${today}`);
  assert.equal(r.status, 200);
  assert.ok(Array.isArray(r.data));
  assert.ok(r.data.every((s) => s.business_date.slice(0, 10) === today));
});

test('only the owner sets a PIN', async () => {
  const admin = await signIn('admin');
  const till = await signIn('cashier');
  const id = await hire(admin, unique('NotYours'));
  assert.equal((await POST(till, `/api/team/${id}/pin`, { pin: '1234' })).status, 403);
});

test('the clock itself works from any staff device, not just the owner', async () => {
  const admin = await signIn('admin');
  const store = await signIn('warehouse');
  const id = await hire(admin, unique('Anyone'));
  await POST(admin, `/api/team/${id}/pin`, { pin: '7777' });

  const r = await POST(store, '/api/clock', { employeeId: id, pin: '7777' });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.action, 'in');
});

// ===========================================================================
// Issuing PINs on paper
// ===========================================================================

test('PINs are issued to whoever lacks one, returned once, and never readable again',
  async () => {
    const admin = await signIn('admin');
    const stamp = unique('slips');
    await POST(admin, '/api/team/bulk', {
      people: [
        { name: `${stamp} A`, position: 'Counter' },
        { name: `${stamp} B`, position: 'Counter' },
      ],
    });

    const r = await POST(admin, '/api/team/pins', {});
    assert.equal(r.status, 200, JSON.stringify(r.data));
    const mine = r.data.issued.filter((p) => p.name.startsWith(stamp));
    assert.equal(mine.length, 2);
    for (const p of mine) {
      assert.match(p.pin, /^\d{4}$/, 'four digits');
      assert.ok(!['0000', '1234', '1111'].includes(p.pin), 'not one anybody guesses first');
    }

    // The PIN that came back is the PIN that works.
    const first = mine[0];
    const on = await POST(admin, '/api/clock', { employeeId: first.id, pin: first.pin });
    assert.equal(on.status, 200, JSON.stringify(on.data));
    assert.equal(on.data.action, 'in');

    // And it is nowhere in what the team list hands a browser.
    const listed = (await GET(admin, '/api/team')).data.team
      .find((p) => Number(p.id) === Number(first.id));
    assert.equal(listed.has_pin, true);
    assert.equal(JSON.stringify(listed).includes(first.pin), false,
      'the PIN itself is never sent again');
  });

test('issuing again leaves people who already have a PIN alone', async () => {
  const admin = await signIn('admin');
  const stamp = unique('again');
  await POST(admin, '/api/team/bulk', { people: [{ name: stamp, position: 'Counter' }] });

  const first = await POST(admin, '/api/team/pins', {});
  const theirs = first.data.issued.find((p) => p.name === stamp);
  assert.ok(theirs);

  const second = await POST(admin, '/api/team/pins', {});
  assert.equal(second.data.issued.some((p) => p.name === stamp), false,
    'reissuing unasked would lock somebody out of a clock they are already using');

  // The original still works.
  const on = await POST(admin, '/api/clock', { employeeId: theirs.id, pin: theirs.pin });
  assert.equal(on.status, 200, JSON.stringify(on.data));
});

test('only the owner issues PINs', async () => {
  const till = await signIn('cashier');
  assert.equal((await POST(till, '/api/team/pins', {})).status, 403);
});

test('no two people on the team share a clock PIN', async () => {
  const admin = await signIn('admin');
  const stamp = unique('many');
  // Enough people that a duplicate would be the expected outcome, not bad luck.
  await POST(admin, '/api/team/bulk', {
    people: Array.from({ length: 20 }, (_, i) =>
      ({ name: `${stamp} ${i}`, position: 'Counter' })),
  });

  const r = await POST(admin, '/api/team/pins', {});
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const pins = r.data.issued.map((p) => p.pin);
  assert.equal(new Set(pins).size, pins.length, 'every PIN issued is distinct');

  const held = (await db.query(
    `select count(*)::int as n, count(distinct pin_fp)::int as distinct_pins
       from employees where pin_fp is not null and ended_on is null`)).rows[0];
  assert.equal(held.n, held.distinct_pins,
    'nobody on the team shares a PIN with anybody else');
});

test('a PIN somebody else already uses is refused by hand too', async () => {
  const admin = await signIn('admin');
  const a = await hire(admin, unique('First'));
  const b = await hire(admin, unique('Second'));

  assert.equal((await POST(admin, `/api/team/${a}/pin`, { pin: '8431' })).status, 200);
  const clash = await POST(admin, `/api/team/${b}/pin`, { pin: '8431' });
  assert.equal(clash.status, 400);
  assert.match(clash.data.error, /already uses that PIN/);
  assert.doesNotMatch(clash.data.error, /First/,
    'naming who holds it would hand one person another PIN by elimination');
});

test('a PIN frees up when somebody leaves', async () => {
  const admin = await signIn('admin');
  const leaver = await hire(admin, unique('Leaver'));
  const starter = await hire(admin, unique('Starter'));

  await POST(admin, `/api/team/${leaver}/pin`, { pin: '7314' });
  assert.equal((await POST(admin, `/api/team/${starter}/pin`, { pin: '7314' })).status, 400);

  await POST(admin, `/api/team/${leaver}/left`, {});
  assert.equal((await POST(admin, `/api/team/${starter}/pin`, { pin: '7314' })).status, 200,
    'there is no reason to retire a number along with the person');
});

// ===========================================================================
// Taking somebody off the team list
//
// Two different things get called "remove". Deleting is for rows that should
// never have existed; leaving is dated and keeps the hours, because payroll
// still has to add up.
// ===========================================================================

test('somebody entered by mistake is deleted outright', async () => {
  const admin = await signIn('admin');
  const id = await hire(admin, unique('Typo'), 'Counter');

  const r = await DELETE(admin, `/api/team/${id}`);
  assert.equal(r.status, 200, JSON.stringify(r.data));

  const team = (await GET(admin, '/api/team')).data.team;
  assert.equal(team.some((p) => Number(p.id) === id), false, 'gone from the list');
});

test('somebody who has worked a shift cannot be deleted, and is told where to go',
  async () => {
    const admin = await signIn('admin');
    const id = await hire(admin, unique('Worked'), 'Counter');
    await POST(admin, `/api/team/${id}/pin`, { pin: '5150' });
    await POST(admin, '/api/clock', { employeeId: id, pin: '5150' });

    const r = await DELETE(admin, `/api/team/${id}`);
    assert.equal(r.status, 400);
    assert.match(r.data.error, /1 shift on record/);
    assert.match(r.data.error, /They have left/);

    assert.equal((await GET(admin, '/api/team')).data.team.some((p) => Number(p.id) === id),
      true, 'still on the list, because their hours are');
  });

test('leaving keeps the person and their hours', async () => {
  const admin = await signIn('admin');
  const id = await hire(admin, unique('Leaving'), 'Counter');
  await POST(admin, `/api/team/${id}/pin`, { pin: '6160' });
  await POST(admin, '/api/clock', { employeeId: id, pin: '6160' });

  assert.equal((await POST(admin, `/api/team/${id}/left`, {})).status, 200);
  const person = (await GET(admin, '/api/team')).data.team.find((p) => Number(p.id) === id);
  assert.ok(person, 'still on the list');
  assert.equal(person.here, false, 'marked as gone');

  const today = manilaToday();
  const hours = await GET(admin, `/api/team/hours?from=${today}&to=${today}`);
  assert.ok(hours.data.people.some((x) => Number(x.employee_id) === id),
    'their hours still appear in the period they worked');
});

test('removing a person leaves the sign-in they used alone', async () => {
  const admin = await signIn('admin');
  const theirs = await signIn('cashier');
  const login = (await GET(admin, '/api/users')).data
    .find((u) => u.username === theirs.username);

  const made = await POST(admin, '/api/team',
    { name: unique('Linked'), position: 'Counter', user_id: login.id });
  assert.equal((await DELETE(admin, `/api/team/${Number(made.data.id)}`)).status, 200);

  assert.ok((await GET(admin, '/api/users')).data.some((u) => u.id === login.id),
    'taking somebody off the team is not taking away their account');
});

test('only the owner removes people', async () => {
  const admin = await signIn('admin');
  const till = await signIn('cashier');
  const id = await hire(admin, unique('Safe'), 'Counter');
  assert.equal((await DELETE(till, `/api/team/${id}`)).status, 403);
});

// ===========================================================================
// Branches — the foundations
//
// Staff, the clock and sign-ins belong to a branch. Stock and money do not yet,
// on purpose: splitting those means teaching the picking engine which shelf it
// is reaching for, and half-doing it hides the mistake in a stock count.
// ===========================================================================

test('the shop starts as one branch, and everybody already belongs to it', async () => {
  const admin = await signIn('admin');
  const r = await GET(admin, '/api/branches');
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.ok(r.data.length >= 1);
  assert.ok(r.data.some((b) => b.name === 'Bayan Bayanan'));

  const id = await hire(admin, unique('Somewhere'), 'Counter');
  const person = (await GET(admin, '/api/team')).data.team.find((p) => Number(p.id) === id);
  assert.ok(person.branch_id, 'a new person lands at a branch without being asked');
  assert.ok(person.branch, 'and the list says which');
});

test('a second branch can be opened and somebody moved to it', async () => {
  const admin = await signIn('admin');
  const name = unique('Concepcion');
  const made = await POST(admin, '/api/branches',
    { name, address: 'Concepcion, Marikina', opens: '9am – 6pm' });
  assert.equal(made.status, 200, JSON.stringify(made.data));

  const id = await hire(admin, unique('Mover'), 'Counter');
  const moved = await POST(admin, `/api/team/${id}/branch`, { branch_id: made.data.id });
  assert.equal(moved.status, 200, JSON.stringify(moved.data));

  const person = (await GET(admin, '/api/team')).data.team.find((p) => Number(p.id) === id);
  assert.equal(person.branch, name);
});

test('two branches cannot share a name', async () => {
  const admin = await signIn('admin');
  const name = unique('Twice');
  assert.equal((await POST(admin, '/api/branches', { name })).status, 200);
  const again = await POST(admin, '/api/branches', { name });
  assert.equal(again.status, 400);
  assert.match(again.data.error, /already a branch called/);
});

test('a branch with people at it cannot be closed', async () => {
  const admin = await signIn('admin');
  const made = await POST(admin, '/api/branches', { name: unique('Staffed') });
  const id = await hire(admin, unique('Stays'), 'Counter');
  await POST(admin, `/api/team/${id}/branch`, { branch_id: made.data.id });

  const shut = await POST(admin, `/api/branches/${made.data.id}/close`, {});
  assert.equal(shut.status, 400);
  assert.match(shut.data.error, /still has 1 person/);
  assert.match(shut.data.error, /Move them/);

  // Once nobody is left, it closes, and closing is not deleting.
  await DELETE(admin, `/api/team/${id}`);
  assert.equal((await POST(admin, `/api/branches/${made.data.id}/close`, {})).status, 200);
  const listed = (await GET(admin, '/api/branches')).data
    .find((b) => Number(b.id) === Number(made.data.id));
  assert.ok(listed, 'a branch that traded stays on the books');
  assert.equal(listed.active, false);
});

test('the last branch open cannot be closed', async () => {
  const admin = await signIn('admin');
  const open = (await GET(admin, '/api/branches')).data.filter((b) => b.active);
  // Close all but one, then try the last.
  for (const b of open.slice(1)) {
    await db.query('update employees set ended_on = current_date where branch_id = $1', [b.id]);
    await POST(admin, `/api/branches/${b.id}/close`, {});
  }
  const last = (await GET(admin, '/api/branches')).data.filter((x) => x.active);
  assert.equal(last.length, 1);
  // Empty it too, so the "move them first" guard cannot be what answers.
  await db.query('update employees set ended_on = current_date where branch_id = $1',
    [last[0].id]);
  const r = await POST(admin, `/api/branches/${last[0].id}/close`, {});
  assert.equal(r.status, 400);
  assert.match(r.data.error, /only branch open/);
  await db.query('update branches set active = true');
});

test('hours can be totalled one branch at a time', async () => {
  const admin = await signIn('admin');
  const made = await POST(admin, '/api/branches', { name: unique('Payroll') });
  const id = await hire(admin, unique('Worker'), 'Counter');
  await POST(admin, `/api/team/${id}/branch`, { branch_id: made.data.id });
  await POST(admin, `/api/team/${id}/pin`, { pin: '3141' });
  await POST(admin, '/api/clock', { employeeId: id, pin: '3141' });

  const today = manilaToday();
  const mine = await GET(admin,
    `/api/team/hours?from=${today}&to=${today}&branch=${made.data.id}`);
  assert.equal(mine.status, 200, JSON.stringify(mine.data));
  assert.ok(mine.data.people.every((x) => x.branch === (made.data.name || x.branch)));
  assert.ok(mine.data.people.some((x) => Number(x.employee_id) === id));

  const everywhere = await GET(admin, `/api/team/hours?from=${today}&to=${today}`);
  assert.ok(everywhere.data.people.length >= mine.data.people.length);
});

test('only the owner changes the branch list, but any staff device can read it', async () => {
  const till = await signIn('cashier');
  assert.equal((await GET(till, '/api/branches')).status, 200,
    'the clock by the door has to know which shop it is standing in');
  assert.equal((await POST(till, '/api/branches', { name: unique('Nope') })).status, 403);
});

// ===========================================================================
// Two branches, kept apart
//
// The point of the whole change. Every one of these would pass trivially with
// one shop; they only mean anything with two.
// ===========================================================================

async function twoBranches(admin) {
  const a = await POST(admin, '/api/branches', { name: unique('North') });
  const b = await POST(admin, '/api/branches', { name: unique('South') });
  return [Number(a.data.id), Number(b.data.id)];
}

const shopOnly = (admin, sku, name) => load(admin, [
  { sku, name, category: 'Soaps', unit_cost: 40, wholesale_price: 60,
    srp: 80, retail_price: 100, alloc_b2b: 0, alloc_shop: 1, alloc_reserve: 0 }]);

test('stock received at one branch cannot be sold at the other', async () => {
  const admin = await signIn('admin');
  const store = await signIn('warehouse');
  const till = await signIn('cashier');
  const [north, south] = await twoBranches(admin);
  const sku = 'BR-ONE';
  await shopOnly(admin, sku, 'Branch One');

  await POST(store, '/api/receive',
    { sku, batch_no: unique('N'), expiry: monthsOut(24), qty: 20, branch_id: north });

  const atSouth = await POST(till, '/api/till/sell',
    { lines: [{ sku, qty: 1 }], method: 'cash', tendered: 500, branch_id: south });
  assert.equal(atSouth.status, 400);
  // The app softens the engine's wording; what matters is that it refused.
  assert.match(atSouth.data.error, /Not enough stock/i);
  assert.match(atSouth.data.error, /BR-ONE/);

  const atNorth = await POST(till, '/api/till/sell',
    { lines: [{ sku, qty: 1 }], method: 'cash', tendered: 500, branch_id: north });
  assert.equal(atNorth.status, 200, JSON.stringify(atNorth.data));
});

test('selling at one branch leaves the other branch\'s shelf untouched', async () => {
  const admin = await signIn('admin');
  const store = await signIn('warehouse');
  const till = await signIn('cashier');
  const [north, south] = await twoBranches(admin);
  const sku = 'BR-TWO';
  await shopOnly(admin, sku, 'Branch Two');

  await POST(store, '/api/receive',
    { sku, batch_no: unique('N'), expiry: monthsOut(24), qty: 10, branch_id: north });
  await POST(store, '/api/receive',
    { sku, batch_no: unique('S'), expiry: monthsOut(24), qty: 10, branch_id: south });

  const before = (await GET(admin, `/api/branch-stock?branch=${south}&q=${sku}`)).data[0];
  await POST(till, '/api/till/sell',
    { lines: [{ sku, qty: 4 }], method: 'cash', tendered: 500, branch_id: north });

  const northNow = (await GET(admin, `/api/branch-stock?branch=${north}&q=${sku}`)).data[0];
  const southNow = (await GET(admin, `/api/branch-stock?branch=${south}&q=${sku}`)).data[0];
  assert.equal(northNow.free_shop, 6);
  assert.equal(southNow.free_shop, before.free_shop, 'the other shop did not move');

  // And the business-wide total still adds up to what is really held.
  const all = (await GET(admin, `/api/products?q=${sku}`)).data[0];
  assert.equal(Number(all.free_shop), 16);
});

test('oldest-first is decided within a branch, not across the business', async () => {
  const admin = await signIn('admin');
  const store = await signIn('warehouse');
  const till = await signIn('cashier');
  const [north, south] = await twoBranches(admin);
  const sku = 'BR-FEFO';
  await shopOnly(admin, sku, 'Branch Fefo');

  // The older lot is at the far shop; the near shop must not reach for it.
  const old = unique('OLD');
  const fresh = unique('FRESH');
  await POST(store, '/api/receive',
    { sku, batch_no: old, expiry: monthsOut(4), qty: 5, branch_id: south });
  await POST(store, '/api/receive',
    { sku, batch_no: fresh, expiry: monthsOut(30), qty: 5, branch_id: north });

  const sold = await POST(till, '/api/till/sell',
    { lines: [{ sku, qty: 2 }], method: 'cash', tendered: 500, branch_id: north });
  assert.equal(sold.status, 200, JSON.stringify(sold.data));
  assert.equal(sold.data.lines[0].batch_no, fresh,
    'the near shop sold its own stock, not the older lot two towns away');
});

test('a transfer moves units between shops and conserves the total', async () => {
  const admin = await signIn('admin');
  const store = await signIn('warehouse');
  const [north, south] = await twoBranches(admin);
  const sku = 'BR-MOVE';
  await shopOnly(admin, sku, 'Branch Move');

  const batch = await POST(store, '/api/receive',
    { sku, batch_no: unique('T'), expiry: monthsOut(24), qty: 12, branch_id: north });
  const batchId = batch.data.batchId;

  const moved = await POST(store, '/api/transfer',
    { batchId, pool: 'shop', from_branch: north, to_branch: south, qty: 5 });
  assert.equal(moved.status, 200, JSON.stringify(moved.data));

  const n = (await GET(admin, `/api/branch-stock?branch=${north}&q=${sku}`)).data[0];
  const s = (await GET(admin, `/api/branch-stock?branch=${south}&q=${sku}`)).data[0];
  assert.equal(n.free_shop, 7);
  assert.equal(s.free_shop, 5);
  assert.equal(Number((await GET(admin, `/api/products?q=${sku}`)).data[0].free_shop), 12,
    'a transfer moves stock, it does not create or destroy it');
});

test('a transfer cannot send more than the branch has free', async () => {
  const admin = await signIn('admin');
  const store = await signIn('warehouse');
  const [north, south] = await twoBranches(admin);
  const sku = 'BR-SHORT';
  await shopOnly(admin, sku, 'Branch Short');

  const batch = await POST(store, '/api/receive',
    { sku, batch_no: unique('T'), expiry: monthsOut(24), qty: 3, branch_id: north });
  const r = await POST(store, '/api/transfer',
    { batchId: batch.data.batchId, pool: 'shop',
      from_branch: north, to_branch: south, qty: 10 });
  assert.equal(r.status, 400);
  assert.match(r.data.error, /Not enough stock/i);
});

test('the same lot arriving at two shops stays one batch with one expiry', async () => {
  const admin = await signIn('admin');
  const store = await signIn('warehouse');
  const [north, south] = await twoBranches(admin);
  const sku = 'BR-LOT';
  await shopOnly(admin, sku, 'Branch Lot');
  const lot = unique('LOT');

  const first = await POST(store, '/api/receive',
    { sku, batch_no: lot, expiry: monthsOut(24), qty: 6, branch_id: north });
  const second = await POST(store, '/api/receive',
    { sku, batch_no: lot, expiry: monthsOut(24), qty: 4, branch_id: south });
  assert.equal(second.status, 200, JSON.stringify(second.data));
  assert.equal(second.data.batchId, first.data.batchId, 'one lot, one batch');

  // The same lot cannot be recorded with two different expiries.
  const wrong = await POST(store, '/api/receive',
    { sku, batch_no: lot, expiry: monthsOut(30), qty: 1, branch_id: south });
  assert.equal(wrong.status, 400);
  assert.match(wrong.data.error, /already recorded expiring/);
});

test('a counted shelf is one shop\'s shelf', async () => {
  const admin = await signIn('admin');
  const store = await signIn('warehouse');
  const [north, south] = await twoBranches(admin);
  const sku = 'BR-COUNT';
  await shopOnly(admin, sku, 'Branch Count');

  await POST(store, '/api/receive',
    { sku, batch_no: unique('C'), expiry: monthsOut(24), qty: 10, branch_id: north });
  await POST(store, '/api/receive',
    { sku, batch_no: unique('C'), expiry: monthsOut(24), qty: 7, branch_id: south });

  const counted = await POST(store, '/api/stock-count',
    { sku, counted: 10, branch_id: north });
  assert.equal(counted.status, 200, JSON.stringify(counted.data));
  assert.equal(counted.data.on_system, 10,
    'counting North against the whole business would invent a variance of seven');
  assert.equal(counted.data.variance, 0);
});

test('the till lists the shelf of the shop selling, not the business total', async () => {
  const admin = await signIn('admin');
  const store = await signIn('warehouse');
  const till = await signIn('cashier');
  const [north, south] = await twoBranches(admin);
  const sku = 'BR-TILL';
  await shopOnly(admin, sku, 'Branch Till');

  await POST(store, '/api/receive',
    { sku, batch_no: unique('N'), expiry: monthsOut(24), qty: 9, branch_id: north });
  await POST(store, '/api/receive',
    { sku, batch_no: unique('S'), expiry: monthsOut(24), qty: 4, branch_id: south });

  const atNorth = (await GET(till, `/api/till/products?q=${sku}&branch=${north}`)).data
    .find((p) => p.sku === sku);
  const atSouth = (await GET(till, `/api/till/products?q=${sku}&branch=${south}`)).data
    .find((p) => p.sku === sku);

  assert.equal(atNorth.on_shelf, 9);
  assert.equal(atSouth.on_shelf, 4,
    'showing 13 here would take an order the shop cannot fill');
});

test('a whole delivery note lands at the branch it was received at', async () => {
  const admin = await signIn('admin');
  const store = await signIn('warehouse');
  const [north, south] = await twoBranches(admin);
  const sku = 'BR-NOTE';
  await shopOnly(admin, sku, 'Branch Note');

  const r = await POST(store, '/api/deliveries', {
    branch_id: south,
    lines: [{ sku, batch_no: unique('D'), expiry: monthsOut(24), qty: 15 }],
  });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.deepEqual(r.data.received[0].split, { shop: 15 });

  const atSouth = (await GET(admin, `/api/branch-stock?branch=${south}&q=${sku}`)).data;
  const atNorth = (await GET(admin, `/api/branch-stock?branch=${north}&q=${sku}`)).data;
  assert.equal(atSouth[0].free_shop, 15);
  assert.equal(atNorth.length, 0, 'nothing landed at the other shop');
});

test('the same lot can be delivered to a second shop, but not twice to one', async () => {
  const admin = await signIn('admin');
  const store = await signIn('warehouse');
  const [north, south] = await twoBranches(admin);
  const sku = 'BR-LOT2';
  await shopOnly(admin, sku, 'Branch Lot Two');
  const lot = unique('L');

  assert.equal((await POST(store, '/api/deliveries', {
    branch_id: north, lines: [{ sku, batch_no: lot, expiry: monthsOut(24), qty: 5 }],
  })).status, 200);

  assert.equal((await POST(store, '/api/deliveries', {
    branch_id: south, lines: [{ sku, batch_no: lot, expiry: monthsOut(24), qty: 5 }],
  })).status, 200, 'one lot can be split across two shops');

  const again = await POST(store, '/api/deliveries', {
    branch_id: north, lines: [{ sku, batch_no: lot, expiry: monthsOut(24), qty: 5 }],
  });
  assert.equal(again.status, 400);
  assert.match(again.data.error, /already at this branch/);
});

// ===========================================================================
// Undoing a delivery
//
// The value of this function is entirely in what it refuses, so most of these
// tests are about it saying no. A reversal that can erase a lot which has been
// sold is not an undo button, it is a way to make a sale disappear.
// ===========================================================================

test('a mis-keyed delivery can be unmade — stock, money and journal together',
  async () => {
    const admin = await signIn('admin');
    const store = await signIn('warehouse');
    const sku = 'RV-PLAIN';
    await shopOnly(admin, sku, 'Reverse Plain');

    const got = await POST(store, '/api/receive',
      { sku, batch_no: unique('R'), expiry: monthsOut(24), qty: 10000, unit_cost: 170 });
    const batch = Number(got.data.batchId);

    const spend = async () => Number((await db.query(
      `select coalesce(sum(amount), 0) as v from expenses
        where batch_id = $1 and source = 'receiving'`, [batch])).rows[0].v);
    assert.equal(await spend(), 1700000);

    const undone = await POST(admin, `/api/receipts/${batch}/undo`,
      { why: 'typed 10000 instead of 1000' });
    assert.equal(undone.status, 200, JSON.stringify(undone.data));
    assert.equal(undone.data.units, 10000);
    assert.equal(Number(undone.data.value), 1700000);

    // All three go together, or the books are worse off than before.
    assert.equal(await spend(), 0, 'the money paid out has to go back');
    assert.equal((await db.query('select 1 from stock where batch_id = $1', [batch])).rowCount,
      0, 'the stock has to go');
    assert.equal((await db.query('select 1 from movements where batch_id = $1', [batch])).rowCount,
      0, 'the journal lines have to go');
    assert.equal((await db.query('select 1 from batches where id = $1', [batch])).rowCount,
      0, 'the batch itself has to go');
  });

test('undoing a delivery leaves a signed record behind', async () => {
  const admin = await signIn('admin');
  const store = await signIn('warehouse');
  const sku = 'RV-TRACE';
  await shopOnly(admin, sku, 'Reverse Trace');
  const lot = unique('T');

  const got = await POST(store, '/api/receive',
    { sku, batch_no: lot, expiry: monthsOut(24), qty: 50, unit_cost: 12 });
  await POST(admin, `/api/receipts/${got.data.batchId}/undo`, { why: 'never arrived' });

  const kept = await db.query('select * from receipt_reversals where batch_no = $1', [lot]);
  assert.equal(kept.rowCount, 1, 'an undo nobody can see is its own dishonesty');
  assert.equal(kept.rows[0].units, 50);
  assert.equal(kept.rows[0].why, 'never arrived');
  assert.equal(Number(kept.rows[0].value), 600);
  assert.equal(kept.rows[0].actor, admin.username, 'who did it is the point');
});

test('a delivery will not be undone without a reason', async () => {
  const admin = await signIn('admin');
  const store = await signIn('warehouse');
  const sku = 'RV-WHY';
  await shopOnly(admin, sku, 'Reverse Why');

  const got = await POST(store, '/api/receive',
    { sku, batch_no: unique('W'), expiry: monthsOut(24), qty: 5 });
  const bare = await POST(admin, `/api/receipts/${got.data.batchId}/undo`, { why: '  ' });
  assert.equal(bare.status, 400);
  assert.equal((await db.query('select 1 from batches where id = $1',
    [got.data.batchId])).rowCount, 1, 'and nothing happened');
});

test('a delivery that has been sold from cannot be undone', async () => {
  const admin = await signIn('admin');
  const store = await signIn('warehouse');
  const till = await signIn('cashier');
  const sku = 'RV-SOLD';
  await shopOnly(admin, sku, 'Reverse Sold');

  const got = await POST(store, '/api/receive',
    { sku, batch_no: unique('S'), expiry: monthsOut(24), qty: 20, unit_cost: 30 });
  const batch = Number(got.data.batchId);

  const sale = await POST(till, '/api/till/sell',
    { lines: [{ sku, qty: 1 }], method: 'cash', tendered: 1000 });
  assert.equal(sale.status, 200, JSON.stringify(sale.data));

  const nope = await POST(admin, `/api/receipts/${batch}/undo`, { why: 'changed my mind' });
  assert.equal(nope.status, 400);
  assert.match(nope.data.error, /touched since it arrived/);
  assert.equal((await db.query('select 1 from batches where id = $1', [batch])).rowCount, 1,
    'a function that can erase a sale is a function that can launder one');
});

test('a delivery that has been sent to another shop cannot be undone', async () => {
  const admin = await signIn('admin');
  const store = await signIn('warehouse');
  const [north, south] = await twoBranches(admin);
  const sku = 'RV-SENT';
  await shopOnly(admin, sku, 'Reverse Sent');

  const got = await POST(store, '/api/receive',
    { sku, batch_no: unique('X'), expiry: monthsOut(24), qty: 30, branch_id: north });
  const batch = Number(got.data.batchId);
  assert.equal((await POST(store, '/api/transfer',
    { batchId: batch, pool: 'shop', from_branch: north, to_branch: south, qty: 10 })).status, 200);

  const nope = await POST(admin, `/api/receipts/${batch}/undo`, { why: 'wrong quantity' });
  assert.equal(nope.status, 400);
  assert.match(nope.data.error, /touched since it arrived/);
});

// A reseller sign-in needs a reseller behind it, which the schema insists on.
async function signInAsReseller() {
  const username = unique('buyer');
  const r = await db.query(
    `insert into resellers (name, tier, status, docs_verified, credit_limit, terms_days)
     values ($1, 3, 'active', true, 500000, 30) returning id`, [unique('Buyer Co')]);
  await db.query(
    `insert into app_users (username, display_name, password_hash, role, reseller_id)
     values ($1,$1,$2,'reseller',$3)`,
    [username, hashPassword('secret123'), Number(r.rows[0].id)]);
  const res = await fetch(`${base}/api/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password: 'secret123' }),
  });
  assert.equal(res.status, 200, `could not sign in as ${username}`);
  const raw = res.headers.getSetCookie?.()[0] ?? res.headers.get('set-cookie');
  return Object.assign(raw.split(';')[0], { username });
}

test('a delivery promised to an order cannot be undone', async () => {
  const admin = await signIn('admin');
  const store = await signIn('warehouse');
  const sku = 'RV-HELD';
  await load(admin, [{ sku, name: 'Reverse Held', category: 'Soaps', unit_cost: 40,
    wholesale_price: 60, srp: 80, retail_price: 100,
    alloc_b2b: 1, alloc_shop: 0, alloc_reserve: 0 }]);

  const got = await POST(store, '/api/receive',
    { sku, batch_no: unique('H'), expiry: monthsOut(24), qty: 40 });
  const batch = Number(got.data.batchId);

  const buyer = await signInAsReseller();
  const order = await POST(buyer, '/api/portal/orders', { lines: [{ sku, qty: 5 }] });
  assert.equal(order.status, 200, JSON.stringify(order.data));

  const nope = await POST(admin, `/api/receipts/${batch}/undo`, { why: 'wrong quantity' });
  assert.equal(nope.status, 400);
  assert.match(nope.data.error, /promised to an order|already on an order/);
});

test('the warehouse can receive a delivery but not unmake one', async () => {
  const admin = await signIn('admin');
  const store = await signIn('warehouse');
  const sku = 'RV-ROLE';
  await shopOnly(admin, sku, 'Reverse Role');

  const got = await POST(store, '/api/receive',
    { sku, batch_no: unique('P'), expiry: monthsOut(24), qty: 8 });
  const nope = await POST(store, `/api/receipts/${got.data.batchId}/undo`, { why: 'mistake' });
  assert.equal(nope.status, 403, 'deleting a posted expense is not a warehouse job');
});

test('the list says why a delivery cannot be taken back, before anyone clicks',
  async () => {
    const admin = await signIn('admin');
    const store = await signIn('warehouse');
    const till = await signIn('cashier');
    const sku = 'RV-LIST';
    await shopOnly(admin, sku, 'Reverse List');

    const clean = await POST(store, '/api/receive',
      { sku, batch_no: unique('C'), expiry: monthsOut(24), qty: 12 });
    const dirty = await POST(store, '/api/receive',
      { sku, batch_no: unique('D'), expiry: monthsOut(12), qty: 12 });
    await POST(till, '/api/till/sell',
      { lines: [{ sku, qty: 1 }], method: 'cash', tendered: 500 });

    const rows = (await GET(admin, '/api/receipts?limit=50')).data;
    const untouched = rows.find((r) => Number(r.batch_id) === Number(clean.data.batchId));
    const traded = rows.find((r) => Number(r.batch_id) === Number(dirty.data.batchId));

    // FEFO picks the nearest expiry, so the sale came off the second batch.
    assert.equal(untouched.held_by, null, 'this one is still free to undo');
    assert.equal(traded.held_by, 'already traded');
  });

// ===========================================================================
// A sign-in that belongs to one shop
//
// The point of tying a cashier to a branch is that it holds when the browser
// says otherwise. A rule the client can talk its way out of is a label, not a
// rule, so most of these send the wrong branch on purpose.
// ===========================================================================

// A PIN has to be unique across everyone still working here, so a literal in
// one test can be taken by a person another test created. Deriving it from the
// row makes collisions impossible rather than unlikely.
const ownPin = (id) => String(10000000 + Number(id) * 7).slice(-8);

async function tieTo(admin, user, branchId) {
  const users = (await GET(admin, '/api/users')).data;
  const row = users.find((u) => u.username === user.username);
  assert.ok(row, `no sign-in called ${user.username}`);
  const r = await POST(admin, `/api/users/${row.id}/branch`, { branch_id: branchId });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  return Number(row.id);
}

test('a tied sign-in receives stock at its own shop without being asked',
  async () => {
    const admin = await signIn('admin');
    const store = await signIn('warehouse');
    const [north, south] = await twoBranches(admin);
    const sku = 'TIE-HERE';
    await shopOnly(admin, sku, 'Tied Here');
    await tieTo(admin, store, south);

    // No branch named at all — it has to land where the person works, not at
    // whichever branch happens to sort first.
    const got = await POST(store, '/api/receive',
      { sku, batch_no: unique('T'), expiry: monthsOut(24), qty: 7 });
    assert.equal(got.status, 200, JSON.stringify(got.data));

    const here = (await GET(admin, `/api/branch-stock?branch=${south}&q=${sku}`)).data;
    const there = (await GET(admin, `/api/branch-stock?branch=${north}&q=${sku}`)).data;
    assert.equal(here[0].free_shop, 7);
    assert.equal(there.length, 0, 'nothing landed at the shop they do not work at');
  });

test('a tied sign-in cannot act on another shop, however it asks', async () => {
  const admin = await signIn('admin');
  const store = await signIn('warehouse');
  const [north, south] = await twoBranches(admin);
  const sku = 'TIE-NOPE';
  await shopOnly(admin, sku, 'Tied Nope');
  await tieTo(admin, store, south);

  const nope = await POST(store, '/api/receive',
    { sku, batch_no: unique('N'), expiry: monthsOut(24), qty: 7, branch_id: north });
  assert.equal(nope.status, 400, JSON.stringify(nope.data));
  assert.match(nope.data.error, /cannot act on/);

  const there = (await GET(admin, `/api/branch-stock?branch=${north}&q=${sku}`)).data;
  assert.equal(there.length, 0, 'and it refused rather than quietly using its own shop');
});

test('a tied till sees its own shelf even when asked for the other one', async () => {
  const admin = await signIn('admin');
  const store = await signIn('warehouse');
  const till = await signIn('cashier');
  const [north, south] = await twoBranches(admin);
  const sku = 'TIE-TILL';
  await shopOnly(admin, sku, 'Tied Till');

  await POST(store, '/api/receive',
    { sku, batch_no: unique('A'), expiry: monthsOut(24), qty: 11, branch_id: north });
  await POST(store, '/api/receive',
    { sku, batch_no: unique('B'), expiry: monthsOut(24), qty: 3, branch_id: south });
  await tieTo(admin, till, south);

  const asked = (await GET(till, `/api/till/products?q=${sku}&branch=${north}`)).data
    .find((p) => p.sku === sku);
  assert.equal(asked.on_shelf, 3, 'asking for the other shop must not show its stock');
});

test('a tied sign-in is only offered its own shop to choose from', async () => {
  const admin = await signIn('admin');
  const till = await signIn('cashier');
  const [, south] = await twoBranches(admin);
  await tieTo(admin, till, south);

  const mine = (await GET(till, '/api/branches')).data;
  assert.equal(mine.length, 1, 'a picker with one option is a picker that hides itself');
  assert.equal(Number(mine[0].id), south);

  const all = (await GET(admin, '/api/branches')).data;
  assert.ok(all.length >= 2, 'the owner still sees every shop');
});

test('untying a sign-in gives every shop back', async () => {
  const admin = await signIn('admin');
  const store = await signIn('warehouse');
  const [north, south] = await twoBranches(admin);
  const sku = 'TIE-FREE';
  await shopOnly(admin, sku, 'Tied Free');

  await tieTo(admin, store, south);
  await tieTo(admin, store, null);

  const got = await POST(store, '/api/receive',
    { sku, batch_no: unique('F'), expiry: monthsOut(24), qty: 4, branch_id: north });
  assert.equal(got.status, 200, JSON.stringify(got.data));
  const there = (await GET(admin, `/api/branch-stock?branch=${north}&q=${sku}`)).data;
  assert.equal(there[0].free_shop, 4);
});

test('a reseller sign-in does not belong to one of the shops', async () => {
  const admin = await signIn('admin');
  const buyer = await signInAsReseller();
  const [, south] = await twoBranches(admin);

  const users = (await GET(admin, '/api/users')).data;
  const row = users.find((u) => u.username === buyer.username);
  const nope = await POST(admin, `/api/users/${row.id}/branch`, { branch_id: south });
  assert.equal(nope.status, 400);
  assert.match(nope.data.error, /does not belong to one of your shops/);
});

test('only the owner decides which shop a sign-in works at', async () => {
  const admin = await signIn('admin');
  const store = await signIn('warehouse');
  const [, south] = await twoBranches(admin);
  const users = (await GET(admin, '/api/users')).data;
  const row = users.find((u) => u.username === store.username);

  const nope = await POST(store, `/api/users/${row.id}/branch`, { branch_id: south });
  assert.equal(nope.status, 403, 'moving yourself to another shop is not a warehouse job');
});

test('a sign-in cannot be tied to a shop that is closed', async () => {
  const admin = await signIn('admin');
  const till = await signIn('cashier');
  const [, south] = await twoBranches(admin);
  assert.equal((await POST(admin, `/api/branches/${south}/close`, {})).status, 200);

  const users = (await GET(admin, '/api/users')).data;
  const row = users.find((u) => u.username === till.username);
  const nope = await POST(admin, `/api/users/${row.id}/branch`, { branch_id: south });
  assert.equal(nope.status, 400);
  assert.match(nope.data.error, /not open/);
});

// ===========================================================================
// Renaming a sign-in
//
// The point is that it is a rename and not a replacement: the password, the
// shop and the link to the staff record all have to survive, or people would
// go on using delete-and-recreate and lose them.
// ===========================================================================

test('a sign-in can be renamed without disturbing the password', async () => {
  const admin = await signIn('admin');
  const till = await signIn('cashier');
  const row = (await GET(admin, '/api/users')).data
    .find((u) => u.username === till.username);

  const fresh = `renamed-${row.id}`;
  const r = await PUT(admin, `/api/users/${row.id}`,
    { username: fresh, display_name: 'Yana Magtibay' });
  assert.equal(r.status, 200, JSON.stringify(r.data));

  const after = (await GET(admin, '/api/users')).data.find((u) => String(u.id) === String(row.id));
  assert.equal(after.username, fresh);
  assert.equal(after.display_name, 'Yana Magtibay');

  // The same password, under the new name.
  const back = await fetch(`${base}/api/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: fresh, password: 'secret123' }) });
  assert.equal(back.status, 200, 'renaming somebody must not lock them out');

  // And not under the old one.
  const old = await fetch(`${base}/api/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: till.username, password: 'secret123' }) });
  assert.equal(old.status, 401);
});

test('renaming a sign-in keeps the shop it works at', async () => {
  const admin = await signIn('admin');
  const till = await signIn('cashier');
  const [, south] = await twoBranches(admin);
  const row = (await GET(admin, '/api/users')).data
    .find((u) => u.username === till.username);

  await POST(admin, `/api/users/${row.id}/branch`, { branch_id: south });
  await PUT(admin, `/api/users/${row.id}`, { username: `kept-${row.id}` });

  const after = (await GET(admin, '/api/users')).data.find((u) => String(u.id) === String(row.id));
  assert.equal(Number(after.branch_id), south, 'a rename is not a reset');
});

test('two sign-ins cannot end up with the same name', async () => {
  const admin = await signIn('admin');
  const one = await signIn('cashier');
  const two = await signIn('warehouse');
  const row = (await GET(admin, '/api/users')).data.find((u) => u.username === two.username);

  const clash = await PUT(admin, `/api/users/${row.id}`, { username: one.username });
  assert.equal(clash.status, 400);
  assert.match(clash.data.error, /already a sign-in called/);
});

test('a username may be a name with a space in it', async () => {
  const admin = await signIn('admin');
  const till = await signIn('cashier');
  const row = (await GET(admin, '/api/users')).data.find((u) => u.username === till.username);

  const wanted = `sonny lorica ${row.id}`;
  assert.equal((await PUT(admin, `/api/users/${row.id}`, { username: wanted })).status, 200);

  // And it signs in, typed however the person happens to capitalise it.
  for (const typed of [wanted, wanted.toUpperCase()]) {
    const back = await fetch(`${base}/api/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: typed, password: 'secret123' }) });
    assert.equal(back.status, 200, `could not sign in as "${typed}"`);
  }
});

test('a username is tidied, so no two can look identical', async () => {
  const admin = await signIn('admin');
  const till = await signIn('cashier');
  const row = (await GET(admin, '/api/users')).data.find((u) => u.username === till.username);

  // Doubled and trailing spaces are invisible on a screen; two sign-ins that
  // look the same and are not is the bug nobody can see.
  assert.equal((await PUT(admin, `/api/users/${row.id}`,
    { username: `  msbeau${row.id}   adona  ` })).status, 200);
  const after = (await GET(admin, '/api/users')).data.find((u) => String(u.id) === String(row.id));
  assert.equal(after.username, `msbeau${row.id} adona`);

  const empty = await PUT(admin, `/api/users/${row.id}`, { username: '   ' });
  assert.equal(empty.status, 400);
  assert.match(empty.data.error, /needs a username/);
});

test('only the owner renames a sign-in', async () => {
  const admin = await signIn('admin');
  const till = await signIn('cashier');
  const row = (await GET(admin, '/api/users')).data.find((u) => u.username === till.username);

  const nope = await PUT(till, `/api/users/${row.id}`, { username: 'something.else' });
  assert.equal(nope.status, 403);
});

// ===========================================================================
// The supervisor
//
// A supervisor is a cashier and a stockroom person on one floor — not a little
// bit of an owner. The dangerous direction is too much, and too much never
// raises an error on its own, so most of these check for a refusal.
// ===========================================================================

test('a supervisor can work the till and the stockroom', async () => {
  const admin = await signIn('admin');
  const boss = await signIn('supervisor');
  const sku = 'SUP-BOTH';
  await shopOnly(admin, sku, 'Supervisor Both');

  // The stockroom half: receiving a delivery.
  const got = await POST(boss, '/api/receive',
    { sku, batch_no: unique('S'), expiry: monthsOut(24), qty: 20, unit_cost: 30 });
  assert.equal(got.status, 200, JSON.stringify(got.data));

  // The till half: selling from it.
  const sale = await POST(boss, '/api/till/sell',
    { lines: [{ sku, qty: 2 }], method: 'cash', tendered: 500 });
  assert.equal(sale.status, 200, JSON.stringify(sale.data));

  // And the jobs that fall between the two on a bad afternoon.
  const count = await POST(boss, '/api/stock-count', { sku, counted: 18 });
  assert.equal(count.status, 200, JSON.stringify(count.data));
  const moved = await POST(boss, '/api/move',
    { batchId: Number(got.data.batchId), from: 'shop', to: 'reserve', qty: 1 });
  assert.equal(moved.status, 200, JSON.stringify(moved.data));
});

test('a supervisor cannot touch prices, money, people or sign-ins', async () => {
  const admin = await signIn('admin');
  const boss = await signIn('supervisor');
  const sku = 'SUP-NOPE';
  await shopOnly(admin, sku, 'Supervisor Nope');

  const refused = [
    ['PUT', `/api/products/${sku}`, { retail_price: 1 }, 'changing a price'],
    ['POST', '/api/products', { sku: 'X-1', name: 'X' }, 'adding a product'],
    ['GET', '/api/finance', undefined, 'the company books'],
    ['POST', '/api/expenses', { kind: 'rent', description: 'x', amount: 1, method: 'cash' },
      'recording a company expense'],
    ['GET', '/api/dashboard', undefined, "the owner's dashboard"],
    ['POST', '/api/users', { username: 'x', password: 'password1', role: 'admin' },
      'making a sign-in'],
    ['POST', '/api/team', { name: 'X', position: 'Staff' }, 'adding staff'],
    ['POST', '/api/branches', { name: 'X' }, 'opening a branch'],
    ['POST', '/api/catalogue/erase', { confirm: 'ERASE' }, 'erasing the shop'],
  ];
  for (const [method, path, body, what] of refused) {
    const r = await request(boss, method, path, body);
    assert.equal(r.status, 403, `a supervisor must not be doing ${what} (${path})`);
  }

  // The other half of the same rule: the stockroom's own tools are theirs.
  // A journal of what moved is how a shelf discrepancy gets explained, and it
  // is already open to the stockroom, so refusing it here would be a
  // supervisor with less reach than the people they cover.
  const journal = await GET(boss, '/api/reports/journal?limit=5');
  assert.equal(journal.status, 200, 'the movement journal is a stockroom tool');
});

test('a supervisor sees their own shop and not the other', async () => {
  const admin = await signIn('admin');
  const store = await signIn('warehouse');
  const boss = await signIn('supervisor');
  const [north, south] = await twoBranches(admin);
  const sku = 'SUP-SHOP';
  await shopOnly(admin, sku, 'Supervisor Shop');
  await tieTo(admin, boss, south);

  await POST(store, '/api/receive',
    { sku, batch_no: unique('N'), expiry: monthsOut(24), qty: 12, branch_id: north });
  await POST(store, '/api/receive',
    { sku, batch_no: unique('S'), expiry: monthsOut(24), qty: 4, branch_id: south });

  const shelf = (await GET(boss, `/api/till/products?q=${sku}&branch=${north}`)).data
    .find((p) => p.sku === sku);
  assert.equal(shelf.on_shelf, 4, 'asking for the other shop must not show its stock');

  const wrong = await POST(boss, '/api/receive',
    { sku, batch_no: unique('W'), expiry: monthsOut(24), qty: 5, branch_id: north });
  assert.equal(wrong.status, 400);
  assert.match(wrong.data.error, /cannot act on/);
});

test("a supervisor reads their own shop's takings, not the company's", async () => {
  const admin = await signIn('admin');
  const boss = await signIn('supervisor');
  const [north, south] = await twoBranches(admin);
  const sku = 'SUP-TAKE';
  await shopOnly(admin, sku, 'Supervisor Take');
  await tieTo(admin, boss, south);

  await POST(boss, '/api/receive', { sku, batch_no: unique('T'), expiry: monthsOut(24), qty: 9 });
  assert.equal((await POST(boss, '/api/till/sell',
    { lines: [{ sku, qty: 1 }], method: 'cash', tendered: 500 })).status, 200);

  const mine = (await GET(boss, '/api/takings-by-branch')).data;
  assert.ok(mine.length, 'their own day has to be readable');
  assert.ok(mine.every((r) => Number(r.branch_id) === south),
    'a supervisor must never be shown another shop in their takings');
  assert.ok(!mine.some((r) => Number(r.branch_id) === north));
});

test('every table the shop floor can read has a supervisor policy to match',
  async () => {
    // The one list that has to be kept in step by hand. If somebody grants a
    // cashier or a stockroom person a new table and forgets the supervisor,
    // this fails here rather than as a blank screen on a Saturday.
    for (const role of ['supervisor', 'office']) {
      const missing = await db.query(`
        select p.tablename
          from pg_policies p
         where p.schemaname = 'public'
           and p.cmd = 'SELECT'
           and p.qual like '%current_role_name%'
           and (p.qual like '%cashier%' or p.qual like '%warehouse%')
           and not exists (
             select 1 from pg_policies s
              where s.schemaname = 'public' and s.tablename = p.tablename
                and s.qual like '%' || $1 || '%')`, [role]);
      assert.deepEqual(missing.rows.map((r) => r.tablename), [],
        `these tables are readable by the shop floor but not by a ${role}`);
    }
  });

test('supervisor is a role a sign-in can actually be', async () => {
  const admin = await signIn('admin');
  const made = await POST(admin, '/api/users',
    { username: unique('boss'), password: 'password1', role: 'supervisor' });
  assert.equal(made.status, 200, JSON.stringify(made.data));

  const nonsense = await POST(admin, '/api/users',
    { username: unique('who'), password: 'password1', role: 'manager' });
  assert.equal(nonsense.status, 400);
  assert.match(nonsense.data.error, /is not something a sign-in can be/);
});

test('the database itself refuses a supervisor the owner-only jobs', async () => {
  // The router turns these away first, which is why the HTTP test above passes
  // even if the rule underneath is wrong. This one goes straight at the
  // database with a supervisor's role set, the way a bug or a stolen
  // connection string would, and the answer has to be the same.
  const client = await db.connect();
  try {
    await client.query('begin');
    await client.query(`select set_config('app.role', 'supervisor', true),
                               set_config('app.actor', 'boss', true)`);
    await client.query('set local role app_client');

    const ownerOnly = [
      [`select create_login('x','x','h','cashier')`, 'making a sign-in'],
      [`select add_branch('Somewhere')`, 'opening a branch'],
      [`select add_employee('X','Staff',null,null,null,null,null)`, 'adding staff'],
      [`select start_fresh('ERASE EVERYTHING', true)`, 'erasing the shop'],
      [`select set_login_branch(1, 1)`, 'moving somebody between shops'],
      [`select reverse_receipt(1, 'because')`, 'undoing a delivery'],
    ];
    for (const [sql, what] of ownerOnly) {
      await client.query('savepoint s');
      let refused = false;
      try {
        await client.query(sql);
      } catch (e) {
        refused = e.code === '42501';
        if (!refused) throw new Error(`${what} failed for the wrong reason: ${e.code} ${e.message}`);
      }
      await client.query('rollback to savepoint s');
      assert.ok(refused, `the database must refuse a supervisor ${what}`);
    }
  } finally {
    await client.query('rollback').catch(() => {});
    client.release();
  }
});

test('reissuing PINs covers the whole team, not the first bite', async () => {
  // The server works twenty at a time because hashing is slow on purpose.
  // Issuing to people who have none can find the rest by looking for a missing
  // PIN; reissuing to everybody cannot, because after the first bite they all
  // have one. This is that walk.
  const admin = await signIn('admin');
  const [north] = await twoBranches(admin);
  const many = Array.from({ length: 25 }, (_, i) => ({
    name: `${unique('P')}-${String(i).padStart(2, '0')}`, position: 'Cashier' }));
  assert.equal((await POST(admin, '/api/team/bulk',
    { people: many, branch_id: north })).status, 200);

  const mine = (await GET(admin, '/api/team')).data.team
    .filter((p) => p.branch_id && Number(p.branch_id) === north);
  assert.ok(mine.length >= 25, `expected the 25 just added, saw ${mine.length}`);

  const runThrough = async (everyone) => {
    const seen = [];
    let after = 0;
    for (let guard = 0; guard < 50; guard++) {
      const r = await POST(admin, '/api/team/pins', { everyone, after });
      assert.equal(r.status, 200, JSON.stringify(r.data));
      seen.push(...r.data.issued);
      after = r.data.after ?? after;
      if (!r.data.remaining || !r.data.issued.length) break;
    }
    return seen;
  };

  const first = await runThrough(false);
  assert.ok(first.length >= 25, `first pass covered ${first.length}, expected 25+`);
  // People who have left are skipped on purpose — a PIN for somebody who no
  // longer works here is a door left open, not an oversight.
  assert.equal((await GET(admin, '/api/team')).data.team
    .filter((p) => !p.ended_on && !p.has_pin).length, 0,
    'nobody still working here may be left without a PIN');

  // Now everybody again — the case that used to stop after twenty.
  const second = await runThrough(true);
  const ids = new Set(second.map((p) => String(p.id)));
  const everyone = (await GET(admin, '/api/team')).data.team.filter((p) => !p.ended_on);
  assert.ok(everyone.length > 20, 'the point of this test is more than one bite');
  assert.equal(ids.size, everyone.length,
    `reissue covered ${ids.size} of ${everyone.length} — it must not stop after a bite`);
  assert.equal(new Set(second.map((p) => p.pin)).size, second.length,
    'and no two people may be handed the same PIN');
});

test('a PIN can be taken back, and then it does not open the clock', async () => {
  const admin = await signIn('admin');
  const [north] = await twoBranches(admin);
  await POST(admin, '/api/team/bulk',
    { people: [{ name: unique('Gate'), position: 'Guard' }], branch_id: north });
  const who = (await GET(admin, '/api/team')).data.team
    .filter((p) => /^Gate-/.test(p.name)).pop();

  const pin = ownPin(who.id);
  assert.equal((await POST(admin, `/api/team/${who.id}/pin`, { pin })).status, 200);
  assert.equal((await POST(admin, '/api/clock',
    { employeeId: who.id, pin })).status, 200, 'the PIN works to begin with');
  await POST(admin, '/api/clock', { employeeId: who.id, pin });

  const gone = await request(admin, 'DELETE', `/api/team/${who.id}/pin`);
  assert.equal(gone.status, 200, JSON.stringify(gone.data));

  const after = await POST(admin, '/api/clock', { employeeId: who.id, pin });
  assert.equal(after.status, 400);
  assert.match(after.data.error, /no PIN yet/,
    'and the clock says there is no PIN rather than that it did not match');

  const row = (await GET(admin, '/api/team')).data.team
    .find((p) => String(p.id) === String(who.id));
  assert.equal(row.has_pin, false);
});

test('only the owner takes a PIN back', async () => {
  const admin = await signIn('admin');
  const till = await signIn('cashier');
  const [north] = await twoBranches(admin);
  await POST(admin, '/api/team/bulk',
    { people: [{ name: unique('Keep'), position: 'Guard' }], branch_id: north });
  const who = (await GET(admin, '/api/team')).data.team
    .filter((p) => /^Keep-/.test(p.name)).pop();
  const pin = ownPin(who.id);
  assert.equal((await POST(admin, `/api/team/${who.id}/pin`, { pin })).status, 200);

  assert.equal((await request(till, 'DELETE', `/api/team/${who.id}/pin`)).status, 403);
  assert.equal((await POST(admin, '/api/clock',
    { employeeId: who.id, pin })).status, 200, 'and the PIN still works');
  await POST(admin, '/api/clock', { employeeId: who.id, pin });
});

// ===========================================================================
// Clocking on by PIN alone
//
// The door screen leads with a keypad, so the PIN has to identify the person
// by itself. Its keyed fingerprint is uniquely indexed, which is what makes
// that safe to do — and these check that the uniqueness is really relied on
// rather than assumed.
// ===========================================================================

test('a PIN alone clocks the right person in and out', async () => {
  const admin = await signIn('admin');
  const [north] = await twoBranches(admin);
  await POST(admin, '/api/team/bulk', { people: [
    { name: unique('Solo'), position: 'Cashier' }], branch_id: north });
  const who = (await GET(admin, '/api/team')).data.team.filter((p) => /^Solo-/.test(p.name)).pop();
  const pin = ownPin(who.id);
  assert.equal((await POST(admin, `/api/team/${who.id}/pin`, { pin })).status, 200);

  const inn = await POST(admin, '/api/clock/by-pin', { pin });
  assert.equal(inn.status, 200, JSON.stringify(inn.data));
  assert.equal(inn.data.name, who.name, 'the PIN has to find the person who holds it');
  assert.equal(inn.data.action, 'in');

  const out = await POST(admin, '/api/clock/by-pin', { pin });
  assert.equal(out.data.action, 'out');
});

test('a PIN nobody holds says the same as a wrong one', async () => {
  const admin = await signIn('admin');
  // Eight digits, so no four-digit PIN issued anywhere can collide with it.
  const nobody = await POST(admin, '/api/clock/by-pin', { pin: '52379416' });
  assert.equal(nobody.status, 400);
  assert.match(nobody.data.error, /does not match anybody/,
    'a screen by the door must not reveal which PINs exist');
  assert.equal((await POST(admin, '/api/clock/by-pin', { pin: 'abcd' })).status, 400);
});

test('the door screen of one shop will not clock the other shop in', async () => {
  const admin = await signIn('admin');
  const [north, south] = await twoBranches(admin);
  await POST(admin, '/api/team/bulk',
    { people: [{ name: unique('Far'), position: 'Cashier' }], branch_id: south });
  const who = (await GET(admin, '/api/team')).data.team.filter((p) => /^Far-/.test(p.name)).pop();
  const pin = ownPin(who.id);
  assert.equal((await POST(admin, `/api/team/${who.id}/pin`, { pin })).status, 200);

  // The tablet at the other door hands its own branch, and must not find them.
  const wrongDoor = await POST(admin, '/api/clock/by-pin', { pin, branch_id: north });
  assert.equal(wrongDoor.status, 400);

  const ownDoor = await POST(admin, '/api/clock/by-pin', { pin, branch_id: south });
  assert.equal(ownDoor.status, 200, JSON.stringify(ownDoor.data));
  assert.equal(ownDoor.data.name, who.name);
  await POST(admin, '/api/clock/by-pin', { pin, branch_id: south });
});

test('a PIN taken back stops working on the keypad too', async () => {
  const admin = await signIn('admin');
  const [north] = await twoBranches(admin);
  await POST(admin, '/api/team/bulk',
    { people: [{ name: unique('Bye'), position: 'Guard' }], branch_id: north });
  const who = (await GET(admin, '/api/team')).data.team.filter((p) => /^Bye-/.test(p.name)).pop();
  const pin = ownPin(who.id);
  assert.equal((await POST(admin, `/api/team/${who.id}/pin`, { pin })).status, 200);
  assert.equal((await POST(admin, '/api/clock/by-pin', { pin })).status, 200);
  await POST(admin, '/api/clock/by-pin', { pin });

  await request(admin, 'DELETE', `/api/team/${who.id}/pin`);
  assert.equal((await POST(admin, '/api/clock/by-pin', { pin })).status, 400);
});

// ===========================================================================
// Signing a device out from somewhere else
//
// The clock screen has no sign-out button on purpose, so this is the only way
// the shop tablet gets signed out. Sessions are signed cookies rather than
// rows, so what is really being tested is that a cookie which still verifies
// can nonetheless be refused for being older than the line the owner drew.
// ===========================================================================

test('an owner can end every session a sign-in has open', async () => {
  const admin = await signIn('admin');
  const till = await signIn('cashier');
  const row = (await GET(admin, '/api/users')).data.find((u) => u.username === till.username);

  // Two devices, both signed in as the same person — the tablet and a phone.
  const second = await fetch(`${base}/api/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: till.username, password: 'secret123' }) });
  const phone = (second.headers.getSetCookie?.()[0] ?? second.headers.get('set-cookie'))
    .split(';')[0];

  assert.equal((await GET(till, '/api/team')).status, 200, 'the tablet works');
  assert.equal((await GET(phone, '/api/team')).status, 200, 'and the phone works');

  const done = await POST(admin, `/api/users/${row.id}/sign-out-everywhere`);
  assert.equal(done.status, 200, JSON.stringify(done.data));

  const after = await GET(till, '/api/team');
  assert.equal(after.status, 401, 'the tablet is out');
  assert.match(after.data.error, /signed out by the owner/);
  assert.equal((await GET(phone, '/api/team')).status, 401, 'and so is the phone');
});

test('signing out everywhere does not change the password', async () => {
  const admin = await signIn('admin');
  const till = await signIn('cashier');
  const row = (await GET(admin, '/api/users')).data.find((u) => u.username === till.username);
  await POST(admin, `/api/users/${row.id}/sign-out-everywhere`);

  const back = await fetch(`${base}/api/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: till.username, password: 'secret123' }) });
  assert.equal(back.status, 200, 'they sign in again with what they already had');
  const fresh = (back.headers.getSetCookie?.()[0] ?? back.headers.get('set-cookie')).split(';')[0];
  assert.equal((await GET(fresh, '/api/team')).status, 200,
    'and the new session is not caught by the same line');
});

test('one sign-in being signed out leaves everybody else alone', async () => {
  const admin = await signIn('admin');
  const one = await signIn('cashier');
  const two = await signIn('warehouse');
  const row = (await GET(admin, '/api/users')).data.find((u) => u.username === one.username);

  await POST(admin, `/api/users/${row.id}/sign-out-everywhere`);
  assert.equal((await GET(one, '/api/team')).status, 401);
  assert.equal((await GET(two, '/api/team')).status, 200, 'a different person is untouched');
  assert.equal((await GET(admin, '/api/team')).status, 200, 'and so is the owner');
});

test('only the owner can sign somebody out everywhere', async () => {
  const admin = await signIn('admin');
  const till = await signIn('cashier');
  const boss = await signIn('supervisor');
  const row = (await GET(admin, '/api/users')).data.find((u) => u.username === till.username);

  assert.equal((await POST(boss, `/api/users/${row.id}/sign-out-everywhere`)).status, 403);
  assert.equal((await POST(till, `/api/users/${row.id}/sign-out-everywhere`)).status, 403);
  assert.equal((await GET(till, '/api/team')).status, 200, 'and nobody was signed out');
});

// ===========================================================================
// The timekeeper
//
// The door tablet's own sign-in. Not a person. The whole point is what it
// cannot reach, so almost all of this is refusals — a tablet that sits on a
// counter all day should carry the smallest thing that still works.
// ===========================================================================

async function signInAsTimekeeper() {
  const username = unique('clockdev');
  await db.query(
    `insert into app_users (username, display_name, password_hash, role)
     values ($1,$1,$2,'timekeeper')`, [username, hashPassword('1234')]);
  const res = await fetch(`${base}/api/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password: '1234' }) });
  assert.equal(res.status, 200, 'a timekeeper has to be able to sign a tablet in');
  const raw = res.headers.getSetCookie?.()[0] ?? res.headers.get('set-cookie');
  return Object.assign(raw.split(';')[0], { username });
}

test('a timekeeper can run the clock and see who is on the team', async () => {
  const admin = await signIn('admin');
  const [north] = await twoBranches(admin);
  await POST(admin, '/api/team/bulk',
    { people: [{ name: unique('Tick'), position: 'Cashier' }], branch_id: north });
  const who = (await GET(admin, '/api/team')).data.team.filter((p) => /^Tick-/.test(p.name)).pop();
  const pin = ownPin(who.id);
  assert.equal((await POST(admin, `/api/team/${who.id}/pin`, { pin })).status, 200);

  const tablet = await signInAsTimekeeper();
  assert.equal((await GET(tablet, '/api/team')).status, 200, 'the faces');
  assert.equal((await GET(tablet, '/api/branches')).status, 200, 'and which shop it is');

  const byName = await POST(tablet, '/api/clock', { employeeId: who.id, pin });
  assert.equal(byName.status, 200, JSON.stringify(byName.data));
  assert.equal(byName.data.action, 'in');
  const byPin = await POST(tablet, '/api/clock/by-pin', { pin });
  assert.equal(byPin.status, 200, JSON.stringify(byPin.data));
  assert.equal(byPin.data.action, 'out');
});

test('a timekeeper can reach nothing else at all', async () => {
  const admin = await signIn('admin');
  const tablet = await signInAsTimekeeper();

  const refused = [
    ['GET', '/api/products?q=', undefined, 'the catalogue'],
    ['GET', '/api/branch-stock?q=', undefined, 'the shelves'],
    ['GET', '/api/till/products?q=', undefined, 'the till'],
    ['POST', '/api/till/sell', { lines: [{ sku: 'X', qty: 1 }], method: 'cash' }, 'a sale'],
    ['GET', '/api/finance', undefined, 'the money'],
    ['GET', '/api/dashboard', undefined, "the owner's dashboard"],
    ['GET', '/api/users', undefined, 'the sign-ins'],
    ['GET', '/api/reports/journal', undefined, 'the stock journal'],
    ['GET', '/api/takings-by-branch', undefined, 'the takings'],
    ['POST', '/api/receive', { sku: 'X', batch_no: 'B', expiry: monthsOut(12), qty: 1 },
      'receiving stock'],
    ['POST', '/api/team', { name: 'X', position: 'Staff' }, 'adding staff'],
    ['GET', '/api/orders', undefined, 'wholesale orders'],
    ['GET', '/api/customers?q=', undefined, 'customers'],
  ];
  for (const [method, path, body, what] of refused) {
    const r = await request(tablet, method, path, body);
    assert.equal(r.status, 403, `a door tablet must not reach ${what} (${path})`);
  }
});

test('the database refuses a timekeeper too, not just the router', async () => {
  const client = await db.connect();
  try {
    await client.query('begin');
    await client.query(`select set_config('app.role', 'timekeeper', true),
                               set_config('app.actor', 'tablet', true)`);
    await client.query('set local role app_client');
    for (const [sql, what] of [
      [`select sell('[]'::jsonb, 'cash', null, null)`, 'selling'],
      [`select receive_stock('X','B',current_date + 400, 1)`, 'receiving'],
      [`select create_login('x','x','h','cashier')`, 'making a sign-in'],
      [`select add_employee('X','Staff',null,null,null,null,null)`, 'adding staff'],
    ]) {
      await client.query('savepoint s');
      let refused = false;
      try { await client.query(sql); } catch (e) { refused = e.code === '42501'; }
      await client.query('rollback to savepoint s');
      assert.ok(refused, `the database must refuse a timekeeper ${what}`);
    }
  } finally {
    await client.query('rollback').catch(() => {});
    client.release();
  }
});

test('a timekeeper is a role a sign-in can be, and is not an employee', async () => {
  const admin = await signIn('admin');
  const made = await POST(admin, '/api/users',
    { username: unique('tablet'), password: 'password1', role: 'timekeeper' });
  assert.equal(made.status, 200, JSON.stringify(made.data));

  // It holds no staff record, so it never appears on the clock's own board.
  const tablet = await signInAsTimekeeper();
  const board = (await GET(tablet, '/api/team')).data.team;
  assert.ok(!board.some((p) => p.name === tablet.username),
    'the tablet must not appear among the faces');
});

// ===========================================================================
// The office
//
// Exactly what a cashier and a stockroom person can do between them. The line
// that matters is the one at the top: the shop's takings belong to whoever
// answers for the shop, and that is not the office.
// ===========================================================================

test('an office sign-in can work both the till and the stockroom', async () => {
  const admin = await signIn('admin');
  const desk = await signIn('office');
  const sku = 'OFF-BOTH';
  await shopOnly(admin, sku, 'Office Both');

  const got = await POST(desk, '/api/receive',
    { sku, batch_no: unique('O'), expiry: monthsOut(24), qty: 12, unit_cost: 25 });
  assert.equal(got.status, 200, JSON.stringify(got.data));

  const sale = await POST(desk, '/api/till/sell',
    { lines: [{ sku, qty: 1 }], method: 'cash', tendered: 500 });
  assert.equal(sale.status, 200, JSON.stringify(sale.data));

  assert.equal((await POST(desk, '/api/stock-count', { sku, counted: 11 })).status, 200);
  assert.equal((await POST(desk, '/api/move',
    { batchId: Number(got.data.batchId), from: 'shop', to: 'reserve', qty: 1 })).status, 200);
});

test("the office does not read the shop's takings", async () => {
  const admin = await signIn('admin');
  const desk = await signIn('office');
  const boss = await signIn('supervisor');

  // The one screen that separates the two roles.
  assert.equal((await GET(desk, '/api/takings-by-branch')).status, 403);
  assert.equal((await GET(boss, '/api/takings-by-branch')).status, 200,
    'a supervisor still has it');
});

test('the office cannot touch prices, money, people or sign-ins', async () => {
  const admin = await signIn('admin');
  const desk = await signIn('office');
  const sku = 'OFF-NOPE';
  await shopOnly(admin, sku, 'Office Nope');

  for (const [method, path, body, what] of [
    ['PUT', `/api/products/${sku}`, { retail_price: 1 }, 'changing a price'],
    ['GET', '/api/finance', undefined, 'the company books'],
    ['GET', '/api/dashboard', undefined, "the owner's dashboard"],
    ['POST', '/api/users', { username: 'x', password: 'password1', role: 'admin' },
      'making a sign-in'],
    ['POST', '/api/team', { name: 'X', position: 'Staff' }, 'adding staff'],
    ['POST', '/api/branches', { name: 'X' }, 'opening a branch'],
    ['POST', '/api/expenses', { kind: 'rent', description: 'x', amount: 1, method: 'cash' },
      'recording an expense'],
  ]) {
    const r = await request(desk, method, path, body);
    assert.equal(r.status, 403, `the office must not be doing ${what} (${path})`);
  }
});

test('an office sign-in stays at its own shop', async () => {
  const admin = await signIn('admin');
  const store = await signIn('warehouse');
  const desk = await signIn('office');
  const [north, south] = await twoBranches(admin);
  const sku = 'OFF-SHOP';
  await shopOnly(admin, sku, 'Office Shop');
  await tieTo(admin, desk, south);

  await POST(store, '/api/receive',
    { sku, batch_no: unique('N'), expiry: monthsOut(24), qty: 9, branch_id: north });
  await POST(store, '/api/receive',
    { sku, batch_no: unique('S'), expiry: monthsOut(24), qty: 4, branch_id: south });

  const shelf = (await GET(desk, `/api/till/products?q=${sku}&branch=${north}`)).data
    .find((p) => p.sku === sku);
  assert.equal(shelf.on_shelf, 4, 'asking for the other shop must not show its stock');

  const wrong = await POST(desk, '/api/receive',
    { sku, batch_no: unique('W'), expiry: monthsOut(24), qty: 5, branch_id: north });
  assert.equal(wrong.status, 400);
  assert.match(wrong.data.error, /cannot act on/);
});

test('the database refuses an office sign-in the owner-only jobs', async () => {
  const client = await db.connect();
  try {
    await client.query('begin');
    await client.query(`select set_config('app.role', 'office', true),
                               set_config('app.actor', 'desk', true)`);
    await client.query('set local role app_client');
    for (const [sql, what] of [
      [`select create_login('x','x','h','cashier')`, 'making a sign-in'],
      [`select add_branch('Somewhere')`, 'opening a branch'],
      [`select add_employee('X','Staff',null,null,null,null,null)`, 'adding staff'],
      [`select reverse_receipt(1, 'because')`, 'undoing a delivery'],
      [`select sign_out_everywhere(1)`, 'signing somebody out'],
    ]) {
      await client.query('savepoint s');
      let refused = false;
      try { await client.query(sql); } catch (e) { refused = e.code === '42501'; }
      await client.query('rollback to savepoint s');
      assert.ok(refused, `the database must refuse the office ${what}`);
    }
  } finally {
    await client.query('rollback').catch(() => {});
    client.release();
  }
});

// ---------------------------------------------------------------------------
// The credit ladder
//
// Tiers used to be three numbers typed per account. These tests are about the
// thing that changed: that a tier now means something, that editing what it
// means carries the accounts standing on it, and that an account deliberately
// set apart is left where its owner put it.
// ---------------------------------------------------------------------------
test('promoting an account takes the ladder rather than typed numbers', async () => {
  const owner = await signIn('admin');
  const made = await POST(owner, '/api/resellers', { name: unique('Ladder Trading') });
  const id = made.data.id;

  const before = await GET(owner, `/api/resellers/${id}`);
  assert.equal(Number(before.data.tier), 1, 'a new account starts at the floor');
  assert.equal(Number(before.data.credit_limit), 0);

  const { ladder } = (await GET(owner, '/api/reseller-tiers')).data;
  const two = ladder.find((t) => t.tier === 2);

  const up = await POST(owner, `/api/resellers/${id}/tier`, { tier: 2 });
  assert.equal(up.status, 200);

  const after = await GET(owner, `/api/resellers/${id}`);
  assert.equal(Number(after.data.tier), 2);
  assert.equal(Number(after.data.credit_limit), Number(two.credit_limit));
  assert.equal(Number(after.data.terms_days), Number(two.terms_days));
});

test('editing a rung moves everyone on it, and nobody who was set apart', async () => {
  const owner = await signIn('admin');
  const follower = (await POST(owner, '/api/resellers', { name: unique('Follows') })).data.id;
  const apart = (await POST(owner, '/api/resellers', { name: unique('Apart') })).data.id;

  await POST(owner, `/api/resellers/${follower}/tier`, { tier: 3 });
  // Terms of its own: same rung, a limit somebody chose for this account.
  await POST(owner, `/api/resellers/${apart}/terms`,
    { tier: 3, credit_limit: 12345, terms_days: 7 });

  const was = (await GET(owner, '/api/reseller-tiers')).data.ladder.find((t) => t.tier === 3);
  const moved = await PUT(owner, '/api/reseller-tiers/3',
    { credit_limit: 99000, terms_days: 45 });
  assert.equal(moved.status, 200);
  assert.ok(moved.data.moved >= 1, 'at least the account on the rung moves');

  const a = await GET(owner, `/api/resellers/${follower}`);
  assert.equal(Number(a.data.credit_limit), 99000, 'the account on the rung follows it');
  assert.equal(Number(a.data.terms_days), 45);

  const b = await GET(owner, `/api/resellers/${apart}`);
  assert.equal(Number(b.data.credit_limit), 12345, 'the exception stays where it was put');
  assert.equal(Number(b.data.terms_days), 7);

  // Put the rung back so the rest of the suite sees what it expects.
  await PUT(owner, '/api/reseller-tiers/3',
    { credit_limit: Number(was.credit_limit), terms_days: Number(was.terms_days) });
});

test('the floor cannot be given credit', async () => {
  const owner = await signIn('admin');
  const no = await PUT(owner, '/api/reseller-tiers/1', { credit_limit: 5000, terms_days: 30 });
  assert.equal(no.status, 400);
  assert.match(no.data.error, /pays before dispatch/);

  // And not around the API either: the table itself refuses it.
  await assert.rejects(
    db.query('update reseller_tiers set credit_limit = 5000 where tier = 1'),
    (e) => e.code === '23514');
});

test('an account back on its rung stops counting as an exception', async () => {
  const owner = await signIn('admin');
  const id = (await POST(owner, '/api/resellers', { name: unique('Rejoins') })).data.id;
  const two = (await GET(owner, '/api/reseller-tiers')).data.ladder.find((t) => t.tier === 2);

  await POST(owner, `/api/resellers/${id}/terms`,
    { tier: 2, credit_limit: 555, terms_days: 3 });
  let adrift = (await GET(owner, '/api/reseller-tiers')).data.offLadder;
  assert.ok(adrift.some((r) => String(r.id) === String(id)), 'off the rung, and shown as such');

  // Typing in exactly what the rung already says is not an exception.
  await POST(owner, `/api/resellers/${id}/terms`,
    { tier: 2, credit_limit: Number(two.credit_limit), terms_days: Number(two.terms_days) });
  adrift = (await GET(owner, '/api/reseller-tiers')).data.offLadder;
  assert.ok(!adrift.some((r) => String(r.id) === String(id)), 'back on the rung, back in the fold');
});

test('the database refuses anybody but the owner the credit ladder', async () => {
  for (const role of ['supervisor', 'office', 'cashier', 'warehouse']) {
    const client = await db.connect();
    try {
      await client.query('begin');
      await client.query(`select set_config('app.role', $1, true),
                                 set_config('app.actor', 'desk', true)`, [role]);
      await client.query('set local role app_client');
      for (const [sql, what] of [
        ['select set_tier(1, 3)', 'promoting an account'],
        ['select set_tier_ladder(2, 999999, 90)', 'rewriting a rung'],
        ['select set_terms(1, 3, 999999, 90)', 'setting terms by hand'],
      ]) {
        await client.query('savepoint s');
        let refused = false;
        try { await client.query(sql); } catch (e) { refused = e.code === '42501'; }
        await client.query('rollback to savepoint s');
        assert.ok(refused, `the database must refuse a ${role} ${what}`);
      }
    } finally {
      await client.query('rollback').catch(() => {});
      client.release();
    }
  }
});

// ---------------------------------------------------------------------------
// Fingerprints
//
// The matching itself belongs to the manufacturer's library at the door, and
// none of it can be tested here. What can be tested is everything around it:
// that only the owner enrols, that a door is handed its own shop's templates
// and no others, and that a door claiming to have recognised somebody has the
// claim checked rather than believed.
// ---------------------------------------------------------------------------
const someTemplate = (seed) =>
  Buffer.from(Array.from({ length: 64 }, (_, i) => (seed * 7 + i * 13) % 256)).toString('base64');

test('a finger is enrolled, counted, and taken back', async () => {
  const owner = await signIn('admin');
  const shop = (await POST(owner, '/api/branches', { name: unique('Door') })).data.id;
  const who = (await POST(owner, '/api/team',
    { name: unique('Fingered'), position: 'Cashier', branch_id: shop })).data.id;

  assert.equal((await POST(owner, `/api/team/${who}/finger`,
    { finger: 1, template: someTemplate(1), quality: 80 })).status, 200);
  assert.equal((await POST(owner, `/api/team/${who}/finger`,
    { finger: 2, template: someTemplate(2), quality: 75 })).status, 200);

  const listed = (await GET(owner, '/api/team')).data.team.find((p) => String(p.id) === String(who));
  assert.equal(listed.fingers, 2, 'both fingers counted');

  // Enrolling the same finger again replaces it rather than adding a second.
  await POST(owner, `/api/team/${who}/finger`, { finger: 1, template: someTemplate(9) });
  const again = (await GET(owner, '/api/team')).data.team.find((p) => String(p.id) === String(who));
  assert.equal(again.fingers, 2, 're-enrolling a finger replaces it');

  const gone = await DELETE(owner, `/api/team/${who}/fingers`);
  assert.equal(gone.data.removed, 2);
  const after = (await GET(owner, '/api/team')).data.team.find((p) => String(p.id) === String(who));
  assert.equal(after.fingers, 0, 'a leaver stops opening the door');
});

test('an empty scan is refused rather than stored', async () => {
  const owner = await signIn('admin');
  const who = (await POST(owner, '/api/team',
    { name: unique('Empty'), position: 'Cashier' })).data.id;
  for (const body of [{ finger: 1, template: '' }, { finger: 1 }]) {
    const no = await POST(owner, `/api/team/${who}/finger`, body);
    assert.equal(no.status, 400);
    assert.match(no.data.error, /produced nothing/);
  }
  const silly = await POST(owner, `/api/team/${who}/finger`,
    { finger: 44, template: someTemplate(3) });
  assert.equal(silly.status, 400);
});

test('a door is handed its own shop and nobody else', async () => {
  const owner = await signIn('admin');
  const here = (await POST(owner, '/api/branches', { name: unique('Here') })).data.id;
  const there = (await POST(owner, '/api/branches', { name: unique('There') })).data.id;

  const ours = (await POST(owner, '/api/team',
    { name: unique('Ours'), position: 'Cashier', branch_id: here })).data.id;
  const theirs = (await POST(owner, '/api/team',
    { name: unique('Theirs'), position: 'Cashier', branch_id: there })).data.id;
  await POST(owner, `/api/team/${ours}/finger`, { finger: 1, template: someTemplate(4) });
  await POST(owner, `/api/team/${theirs}/finger`, { finger: 1, template: someTemplate(5) });

  const door = await GET(owner, `/api/clock/fingers?shop=${here}`);
  assert.equal(door.status, 200);
  const ids = door.data.people.map((p) => p.id);
  assert.ok(ids.includes(ours), 'our own people are handed over');
  assert.ok(!ids.includes(theirs), "the other shop's people are not");

  // And a door with no shop is given nothing at all.
  const nowhere = await GET(owner, '/api/clock/fingers');
  assert.equal(nowhere.status, 400);
});

test('a template survives the round trip byte for byte', async () => {
  const owner = await signIn('admin');
  const shop = (await POST(owner, '/api/branches', { name: unique('Round') })).data.id;
  const who = (await POST(owner, '/api/team',
    { name: unique('Trip'), position: 'Cashier', branch_id: shop })).data.id;
  const sent = someTemplate(6);
  await POST(owner, `/api/team/${who}/finger`, { finger: 3, template: sent });

  const back = (await GET(owner, `/api/clock/fingers?shop=${shop}`)).data.people
    .find((p) => p.id === who && p.finger === 3);
  assert.equal(back.template, sent, 'a template the door cannot trust is worse than none');
});

test('the door is not believed about somebody who has no finger', async () => {
  const owner = await signIn('admin');
  const shop = (await POST(owner, '/api/branches', { name: unique('Claim') })).data.id;
  const other = (await POST(owner, '/api/branches', { name: unique('Elsewhere') })).data.id;

  const enrolled = (await POST(owner, '/api/team',
    { name: unique('Enrolled'), position: 'Cashier', branch_id: shop })).data.id;
  const bare = (await POST(owner, '/api/team',
    { name: unique('Bare'), position: 'Cashier', branch_id: shop })).data.id;
  const away = (await POST(owner, '/api/team',
    { name: unique('Away'), position: 'Cashier', branch_id: other })).data.id;
  await POST(owner, `/api/team/${enrolled}/finger`, { finger: 1, template: someTemplate(7) });
  await POST(owner, `/api/team/${away}/finger`, { finger: 1, template: someTemplate(8) });

  const on = await POST(owner, '/api/clock/by-finger',
    { employeeId: enrolled, branch_id: shop });
  assert.equal(on.status, 200, 'the enrolled person clocks on');

  // Nobody enrolled this person, so a door naming them is making it up.
  const invented = await POST(owner, '/api/clock/by-finger',
    { employeeId: bare, branch_id: shop });
  assert.equal(invented.status, 400);

  // Enrolled, but at the other shop. This door does not hold their template
  // and has no business clocking them on.
  const elsewhere = await POST(owner, '/api/clock/by-finger',
    { employeeId: away, branch_id: shop });
  assert.equal(elsewhere.status, 400);
});

test('the database refuses anybody but the owner a fingerprint', async () => {
  for (const role of ['supervisor', 'office', 'cashier', 'warehouse', 'timekeeper']) {
    const client = await db.connect();
    try {
      await client.query('begin');
      await client.query(`select set_config('app.role', $1, true),
                                 set_config('app.actor', 'door', true)`, [role]);
      await client.query('set local role app_client');
      for (const [sql, what] of [
        [`select enrol_finger(1, 1, '\\x00'::bytea, 50)`, 'enrolling a finger'],
        ['select clear_fingers(1)', 'taking one back'],
        ['select count(*) from employee_fingers', 'reading templates directly'],
      ]) {
        await client.query('savepoint s');
        let refused = false;
        try {
          const r = await client.query(sql);
          // Reading is not an error under row-level security; it returns
          // nothing. Either way the templates must not come out.
          refused = sql.startsWith('select count') ? Number(r.rows[0].count) === 0 : false;
        } catch (e) { refused = e.code === '42501'; }
        await client.query('rollback to savepoint s');
        assert.ok(refused, `the database must refuse a ${role} ${what}`);
      }
    } finally {
      await client.query('rollback').catch(() => {});
      client.release();
    }
  }
});
