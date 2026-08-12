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

    const today = new Date().toISOString().slice(0, 10);
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
  const today = new Date().toISOString().slice(0, 10);
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

  const today = new Date().toISOString().slice(0, 10);
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

  const today = new Date().toISOString().slice(0, 10);
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
