// What the system has to get right, checked the way a person would hit it:
// over real HTTP, against a real Postgres, with sign-ins and roles in play.
//
// Each of these corresponds to a promise the system makes about stock or
// money. If one of them fails, something a shop actually depends on is broken.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { hashPassword } from '../lib/auth.js';
import { server } from '../scripts/dev.js';
import { pool } from '../lib/db.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const db = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 10 });
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

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------
let seq = 0;
const unique = (prefix) => `${prefix}-${process.pid}-${Date.now()}-${++seq}`;

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
const PUT = (c, p, b) => request(c, 'PUT', p, b);

/** A signed-in user of the given role. */
async function signIn(role, resellerId = null) {
  const username = unique(role);
  await db.query(
    `insert into app_users (username, display_name, password_hash, role, reseller_id)
     values ($1,$1,$2,$3,$4)`,
    [username, hashPassword('secret123'), role, resellerId]);
  const res = await fetch(`${base}/api/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password: 'secret123' }),
  });
  assert.equal(res.status, 200, `could not sign in as ${username}`);
  const raw = res.headers.getSetCookie?.()[0] ?? res.headers.get('set-cookie');
  return Object.assign(raw.split(';')[0], { username });
}

async function newProduct(admin, overrides = {}) {
  const sku = unique('SKU');
  const { status, data } = await POST(admin, '/api/products', {
    sku, name: `Test ${sku}`, brand: 'Beau Glow', category: 'Serums',
    unit_cost: 100, wholesale_price: 250, srp: 400, retail_price: 450,
    shelf_life_months: 24, ...overrides,
  });
  assert.equal(status, 200, JSON.stringify(data));
  if (overrides.alloc_b2b !== undefined) {
    const r = await PUT(admin, `/api/products/${sku}`, {
      alloc_b2b: overrides.alloc_b2b,
      alloc_shop: overrides.alloc_shop,
      alloc_reserve: overrides.alloc_reserve,
    });
    assert.equal(r.status, 200, JSON.stringify(r.data));
  }
  return sku;
}

async function newReseller(admin, { tier = 2, credit_limit = 1_000_000, terms_days = 30 } = {}) {
  const { data } = await POST(admin, '/api/resellers',
    { name: unique('Reseller'), email: 'buyer@example.ph', tier, credit_limit, terms_days });
  await POST(admin, `/api/resellers/${data.id}/approve`);
  return data.id;
}

const receive = (who, sku, months, qty) =>
  POST(who, '/api/receive', { sku, batch_no: unique('B'), expiry: monthsOut(months), qty });

// ===========================================================================
// A delivery is split across the three pools, and the owner sets the split
// ===========================================================================
test('a delivery of 100 splits 70 wholesale / 20 shop / 10 reserve, and the split is editable',
  async () => {
    const admin = await signIn('admin');
    const store = await signIn('warehouse');
    const sku = await newProduct(admin);

    const first = await receive(store, sku, 24, 100);
    assert.equal(first.status, 200, JSON.stringify(first.data));
    assert.deepEqual(
      Object.fromEntries(first.data.allocation.map((a) => [a.pool, a.on_hand])),
      { b2b: 70, shop: 20, reserve: 10 });

    const changed = await PUT(admin, `/api/products/${sku}`,
      { alloc_b2b: 0.5, alloc_shop: 0.4, alloc_reserve: 0.1 });
    assert.equal(changed.status, 200, JSON.stringify(changed.data));

    const second = await receive(store, sku, 24, 100);
    assert.deepEqual(
      Object.fromEntries(second.data.allocation.map((a) => [a.pool, a.on_hand])),
      { b2b: 50, shop: 40, reserve: 10 });

    // An awkward number must not lose or invent a unit.
    const odd = await receive(store, sku, 24, 7);
    assert.equal(odd.data.allocation.reduce((sum, a) => sum + a.on_hand, 0), 7);
  });

test('a split that does not add up to 100% is refused', async () => {
  const admin = await signIn('admin');
  const sku = await newProduct(admin);
  const bad = await PUT(admin, `/api/products/${sku}`,
    { alloc_b2b: 0.5, alloc_shop: 0.4, alloc_reserve: 0.4 });
  assert.equal(bad.status, 400);
  assert.match(bad.data.error, /add up to 100/i);
});

// ===========================================================================
// The till and a reseller can never sell the same unit
// ===========================================================================
test('the till cannot reach stock set aside for resellers', async () => {
  const admin = await signIn('admin');
  const store = await signIn('warehouse');
  const till = await signIn('cashier');
  const sku = await newProduct(admin, { alloc_b2b: 1, alloc_shop: 0, alloc_reserve: 0 });
  await receive(store, sku, 24, 50);

  const sale = await POST(till, '/api/till/sell',
    { lines: [{ sku, qty: 1 }], method: 'cash', tendered: 1000 });
  assert.equal(sale.status, 400);
  assert.match(sale.data.error, /Not enough stock/,
    'the shelf is empty even with 50 units sitting in the wholesale pool');
});

test('two resellers going for the last units at the same moment: exactly one wins', async () => {
  const admin = await signIn('admin');
  const store = await signIn('warehouse');
  const sku = await newProduct(admin, { alloc_b2b: 1, alloc_shop: 0, alloc_reserve: 0 });
  await receive(store, sku, 24, 5);

  const one = await signIn('reseller', await newReseller(admin));
  const two = await signIn('reseller', await newReseller(admin));

  const [a, b] = await Promise.all([
    POST(one, '/api/portal/orders', { lines: [{ sku, qty: 5 }] }),
    POST(two, '/api/portal/orders', { lines: [{ sku, qty: 5 }] }),
  ]);

  const won = [a, b].filter((r) => r.status === 200);
  const lost = [a, b].filter((r) => r.status !== 200);
  assert.equal(won.length, 1, 'only one order may take the last five units');
  assert.equal(lost.length, 1);
  assert.match(lost[0].data.error, /Not enough stock/,
    'the one that lost is told plainly, not shown a database error');

  const after = await GET(admin, `/api/products?q=${sku}`);
  assert.equal(after.data[0].free_b2b, 0);
  assert.equal(after.data[0].committed_b2b, 5);
});

// ===========================================================================
// Oldest stock leaves first, and resellers never get short-dated goods
// ===========================================================================
test('picking takes the soonest to expire, and skips what a reseller would refuse', async () => {
  const admin = await signIn('admin');
  const store = await signIn('warehouse');
  const till = await signIn('cashier');
  const sku = await newProduct(admin, { alloc_b2b: 0.5, alloc_shop: 0.5, alloc_reserve: 0 });

  const short = unique('SHORT');    // 6 months — under the reseller floor
  const mid = unique('MID');        // 18 months — usable, expires first
  const far = unique('FAR');        // 30 months — usable, expires later
  await POST(store, '/api/receive', { sku, batch_no: short, expiry: monthsOut(6), qty: 40 });
  await POST(store, '/api/receive', { sku, batch_no: far, expiry: monthsOut(30), qty: 40 });
  await POST(store, '/api/receive', { sku, batch_no: mid, expiry: monthsOut(18), qty: 40 });

  const buyer = await signIn('reseller', await newReseller(admin));
  const catalogue = await GET(buyer, '/api/portal/catalog');
  assert.equal(catalogue.data.find((p) => p.sku === sku).available, 40,
    'the short-dated batch is not offered to resellers at all');

  const order = await POST(buyer, '/api/portal/orders', { lines: [{ sku, qty: 25 }] });
  assert.equal(order.status, 200, JSON.stringify(order.data));

  const detail = await GET(store, `/api/orders/${order.data.orderId}`);
  const picked = detail.data.lines;
  assert.equal(picked[0].batch_no, mid, 'the soonest usable batch goes first');
  assert.equal(picked[0].qty, 20);
  assert.equal(picked[1].batch_no, far, 'then the later one covers the rest');
  assert.equal(picked[1].qty, 5);
  assert.ok(!picked.some((l) => l.batch_no === short),
    'a batch under the floor must never appear on a reseller pick list');

  // The shop may still sell it — and clears it first, which is the point.
  const sale = await POST(till, '/api/till/sell',
    { lines: [{ sku, qty: 1 }], method: 'cash', tendered: 1000 });
  assert.equal(sale.status, 200, JSON.stringify(sale.data));
  assert.equal(sale.data.lines[0].batch_no, short);
});

// ===========================================================================
// The reorder arithmetic
// ===========================================================================
test('10 a day, 15 at worst, 60-day wait, 75 at worst → buffer 525, reorder at 1,125',
  async () => {
    const admin = await signIn('admin');
    const sku = await newProduct(admin, { shelf_life_months: 24 });

    const { status, data } = await POST(admin, `/api/reorder/${sku}`,
      { avg_daily: 10, max_daily: 15, avg_lead: 60, max_lead: 75, months_cover: 3 });
    assert.equal(status, 200, JSON.stringify(data));
    assert.equal(Number(data.safety_stock), 525);
    assert.equal(Number(data.reorder_at), 1125);

    // Nothing received, so it is below the point and the suggestion is three
    // months of cover — under what shelf life would allow, so not capped.
    const list = await GET(admin, '/api/reorder');
    const row = list.data.find((r) => r.sku === sku);
    assert.equal(Number(row.short_by), 1125);
    assert.equal(Number(row.suggested_order), 900);
  });

test('the suggested quantity is capped by how long the stock stays sellable', async () => {
  const admin = await signIn('admin');
  // 13 months of life against a 12-month reseller floor leaves ~25 days of
  // wholesale life, so three months of cover would be far too much to buy.
  const sku = await newProduct(admin, { shelf_life_months: 13 });
  await POST(admin, `/api/reorder/${sku}`,
    { avg_daily: 10, max_daily: 15, avg_lead: 60, max_lead: 75, months_cover: 3 });

  const list = await GET(admin, '/api/reorder');
  const row = list.data.find((r) => r.sku === sku);
  assert.ok(Number(row.suggested_order) < 900,
    'three months of cover must not be suggested for stock that cannot last three months');
  assert.equal(Math.round(Number(row.suggested_order)), 250);
});

// ===========================================================================
// Credit
// ===========================================================================
test('a new account cannot have goods dispatched until the invoice is paid', async () => {
  const admin = await signIn('admin');
  const store = await signIn('warehouse');
  const sku = await newProduct(admin, { alloc_b2b: 1, alloc_shop: 0, alloc_reserve: 0 });
  await receive(store, sku, 24, 20);

  const buyer = await signIn('reseller',
    await newReseller(admin, { tier: 1, credit_limit: 0, terms_days: 0 }));

  const order = await POST(buyer, '/api/portal/orders', { lines: [{ sku, qty: 4 }] });
  assert.equal(order.status, 200, JSON.stringify(order.data));

  const tooSoon = await POST(store, `/api/orders/${order.data.orderId}/dispatch`);
  assert.equal(tooSoon.status, 400);
  assert.match(tooSoon.data.error, /pays before dispatch/i);

  await POST(admin, `/api/invoices/${order.data.invoice.id}/payment`,
    { amount: order.data.invoice.amount });

  const now = await POST(store, `/api/orders/${order.data.orderId}/dispatch`);
  assert.equal(now.status, 200, JSON.stringify(now.data));
});

test('a past-due account is stopped, told what to pay, and can be let through on the record',
  async () => {
    const admin = await signIn('admin');
    const store = await signIn('warehouse');
    const sku = await newProduct(admin, { alloc_b2b: 1, alloc_shop: 0, alloc_reserve: 0 });
    await receive(store, sku, 24, 100);

    const id = await newReseller(admin, { tier: 2, credit_limit: 1_000_000, terms_days: 30 });
    const buyer = await signIn('reseller', id);

    const first = await POST(buyer, '/api/portal/orders', { lines: [{ sku, qty: 10 }] });
    assert.equal(first.status, 200, JSON.stringify(first.data));

    // Let that invoice age past its due date, the way the calendar would.
    await db.query(
      `update invoices set issued_on = current_date - 60, due_on = current_date - 30
        where order_id = $1`, [first.data.orderId]);

    const stopped = await POST(buyer, '/api/portal/orders', { lines: [{ sku, qty: 1 }] });
    assert.equal(stopped.status, 400);
    assert.match(stopped.data.error, /cannot order/i);

    // The portal says why, and the exact amount, without needing a phone call.
    const account = await GET(buyer, '/api/portal/account');
    assert.equal(account.data.blocked, true);
    assert.match(account.data.reason, /past due/i);
    assert.equal(Number(account.data.toClear), Number(first.data.invoice.amount));

    const noReason = await POST(admin, `/api/resellers/${id}/override`, {});
    assert.equal(noReason.status, 400, 'an override without a reason must be refused');

    const done = await POST(admin, `/api/resellers/${id}/override`,
      { note: 'Owner approved — cheque in hand' });
    assert.equal(done.status, 200);

    const record = await GET(admin, `/api/resellers/${id}`);
    const entry = record.data.events.find((e) => e.kind === 'override');
    assert.ok(entry, 'the override is on the account history');
    assert.match(entry.detail.note, /cheque in hand/);
    assert.equal(entry.detail.by, admin.username, 'and it names who did it');
  });

test('an order beyond the credit limit is refused, with the numbers spelled out', async () => {
  const admin = await signIn('admin');
  const store = await signIn('warehouse');
  const sku = await newProduct(admin, { alloc_b2b: 1, alloc_shop: 0, alloc_reserve: 0 });
  await receive(store, sku, 24, 100);

  const buyer = await signIn('reseller',
    await newReseller(admin, { tier: 2, credit_limit: 1000, terms_days: 30 }));

  const over = await POST(buyer, '/api/portal/orders', { lines: [{ sku, qty: 10 }] }); // ₱2,500
  assert.equal(over.status, 400);
  assert.match(over.data.error, /credit limit/i);
  assert.match(over.data.error, /₱/, 'the amounts are quoted in pesos');
});

test('paying a 30-day invoice within ten days takes 2% off by itself', async () => {
  const admin = await signIn('admin');
  const store = await signIn('warehouse');
  const sku = await newProduct(admin, { alloc_b2b: 1, alloc_shop: 0, alloc_reserve: 0 });
  await receive(store, sku, 24, 50);

  const id = await newReseller(admin, { tier: 2, credit_limit: 1_000_000, terms_days: 30 });
  const buyer = await signIn('reseller', id);
  const order = await POST(buyer, '/api/portal/orders', { lines: [{ sku, qty: 10 }] });
  const invoice = order.data.invoice;               // ₱2,500

  // 2% is ₱50, so ₱2,450 settles it.
  await POST(admin, `/api/invoices/${invoice.id}/payment`, { amount: 2450 });

  const account = await GET(admin, `/api/resellers/${id}`);
  const settled = account.data.invoices.find((i) => i.id === invoice.id);
  assert.equal(settled.status, 'paid');
  assert.equal(Number(settled.discount), 50);
  assert.equal(Number(account.data.owed), 0);
});

test('clearing the last past-due invoice lets the account order again on its own', async () => {
  const admin = await signIn('admin');
  const store = await signIn('warehouse');
  const sku = await newProduct(admin, { alloc_b2b: 1, alloc_shop: 0, alloc_reserve: 0 });
  await receive(store, sku, 24, 100);

  const id = await newReseller(admin, { tier: 2, credit_limit: 1_000_000, terms_days: 30 });
  const buyer = await signIn('reseller', id);
  const first = await POST(buyer, '/api/portal/orders', { lines: [{ sku, qty: 10 }] });
  await db.query(
    `update invoices set issued_on = current_date - 60, due_on = current_date - 30
      where order_id = $1`, [first.data.orderId]);

  assert.equal((await POST(buyer, '/api/portal/orders', { lines: [{ sku, qty: 1 }] })).status, 400);

  await POST(admin, `/api/invoices/${first.data.invoice.id}/payment`,
    { amount: first.data.invoice.amount });

  const again = await POST(buyer, '/api/portal/orders', { lines: [{ sku, qty: 1 }] });
  assert.equal(again.status, 200, 'paying up should be enough — no admin action needed');
});

// ===========================================================================
// Paying the whole account at once
// ===========================================================================
test('one payment against the account settles what is open, oldest invoice first',
  async () => {
    const admin = await signIn('admin');
    const store = await signIn('warehouse');
    const sku = await newProduct(admin, { alloc_b2b: 1, alloc_shop: 0, alloc_reserve: 0 });
    await receive(store, sku, 24, 100);

    const id = await newReseller(admin);
    const buyer = await signIn('reseller', id);
    const first = await POST(buyer, '/api/portal/orders', { lines: [{ sku, qty: 4 }] });   // ₱1,000
    const second = await POST(buyer, '/api/portal/orders', { lines: [{ sku, qty: 2 }] });  // ₱500

    // Enough to clear the first in full and leave the second at ₱300 owed.
    const paid = await POST(admin, `/api/resellers/${id}/payment`, { amount: 1200 });
    assert.equal(paid.status, 200, JSON.stringify(paid.data));
    assert.deepEqual(
      paid.data.applied.map((a) => [Number(a.invoice_id), Number(a.amount)]),
      [[Number(first.data.invoice.id), 1000], [Number(second.data.invoice.id), 200]],
      'the older invoice is paid off completely before a peso touches the newer one');
    assert.equal(Number(paid.data.credited), 0);

    const account = await GET(admin, `/api/resellers/${id}`);
    const inv1 = account.data.invoices.find((i) => i.id === first.data.invoice.id);
    const inv2 = account.data.invoices.find((i) => i.id === second.data.invoice.id);
    assert.equal(inv1.status, 'paid');
    assert.equal(inv2.status, 'open');
    assert.equal(Number(inv2.balance), 300);
  });

test('paying more than the account owes leaves the rest sitting as credit', async () => {
  const admin = await signIn('admin');
  const store = await signIn('warehouse');
  const sku = await newProduct(admin, { alloc_b2b: 1, alloc_shop: 0, alloc_reserve: 0 });
  await receive(store, sku, 24, 100);

  const id = await newReseller(admin);
  const buyer = await signIn('reseller', id);
  const order = await POST(buyer, '/api/portal/orders', { lines: [{ sku, qty: 4 }] }); // ₱1,000

  const paid = await POST(admin, `/api/resellers/${id}/payment`, { amount: 1500 });
  assert.equal(Number(paid.data.applied[0].amount), 1000);
  assert.equal(Number(paid.data.credited), 500);

  const account = await GET(admin, `/api/resellers/${id}`);
  assert.equal(Number(account.data.credit), 500);
  assert.equal(Number(account.data.owed), 0);
  assert.match(account.data.credits[0].reason, /overpayment/i);
});

test('an account with nothing open yet can still be paid — it all becomes credit', async () => {
  const admin = await signIn('admin');
  const id = await newReseller(admin);

  const paid = await POST(admin, `/api/resellers/${id}/payment`, { amount: 800 });
  assert.equal(paid.status, 200, JSON.stringify(paid.data));
  assert.deepEqual(paid.data.applied, []);
  assert.equal(Number(paid.data.credited), 800);

  const account = await GET(admin, `/api/resellers/${id}`);
  assert.equal(Number(account.data.credit), 800);
});

test('standing credit is drawn on automatically the next time an invoice is raised',
  async () => {
    const admin = await signIn('admin');
    const store = await signIn('warehouse');
    const sku = await newProduct(admin, { alloc_b2b: 1, alloc_shop: 0, alloc_reserve: 0 });
    await receive(store, sku, 24, 100);

    const id = await newReseller(admin);
    const buyer = await signIn('reseller', id);
    await POST(admin, `/api/resellers/${id}/payment`, { amount: 800 }); // pure credit, no invoice yet

    // ₱500 order against ₱800 credit: the invoice should already read paid.
    const order = await POST(buyer, '/api/portal/orders', { lines: [{ sku, qty: 2 }] });
    assert.equal(order.data.invoice.status, 'paid',
      'the reseller should never see a balance due — the credit covered it before they did');

    const account = await GET(admin, `/api/resellers/${id}`);
    assert.equal(Number(account.data.credit), 300, '₱800 credit minus the ₱500 invoice');
    assert.equal(Number(account.data.owed), 0);
  });

test('an account holding nothing but credit is not invisible to the receivables report',
  async () => {
    const admin = await signIn('admin');
    const credited = await newReseller(admin);
    await POST(admin, `/api/resellers/${credited}/payment`, { amount: 400 });
    const plain = await newReseller(admin); // owes nothing, holds no credit either

    const report = await GET(admin, '/api/reports/receivables');
    const row = report.data.credit.find((c) => Number(c.reseller_id) === credited);
    assert.ok(row, 'an account sitting on credit belongs in "money held as credit"');
    assert.equal(Number(row.credit), 400);
    assert.ok(!report.data.credit.some((c) => Number(c.reseller_id) === plain),
      'an account with no credit at all must not appear here');
  });

// ===========================================================================
// The till
// ===========================================================================
test('selling the last unit empties the shelf, raises a task, and blocks the next sale',
  async () => {
    const admin = await signIn('admin');
    const store = await signIn('warehouse');
    const till = await signIn('cashier');
    const sku = await newProduct(admin, { alloc_b2b: 0, alloc_shop: 1, alloc_reserve: 0 });
    await receive(store, sku, 24, 1);

    const sale = await POST(till, '/api/till/sell',
      { lines: [{ sku, qty: 1 }], method: 'cash', tendered: 500 });
    assert.equal(sale.status, 200, JSON.stringify(sale.data));
    assert.match(sale.data.receipt_no, /^OR-\d{8}-\d{5}$/, 'receipts are numbered in sequence');
    assert.equal(Number(sale.data.change), 50);           // ₱500 given for a ₱450 sale

    const shelf = await GET(till, `/api/till/products?q=${sku}`);
    assert.equal(shelf.data[0].on_shelf, 0);

    const tasks = await GET(store, '/api/restock');
    const mine = tasks.data.find((t) => t.sku === sku && t.status === 'open');
    assert.ok(mine, 'the system raised its own "bring stock out" task');
    assert.match(mine.note, /shelf down to 0/);

    const again = await POST(till, '/api/till/sell',
      { lines: [{ sku, qty: 1 }], method: 'cash', tendered: 500 });
    assert.equal(again.status, 400);
    assert.match(again.data.error, /Not enough stock/);

    assert.equal((await POST(store, `/api/restock/${mine.id}/done`)).status, 200);
    const twice = await POST(store, `/api/restock/${mine.id}/done`);
    assert.equal(twice.status, 400, 'closing a task twice is not a silent success');
  });

test('too little cash is refused before any stock moves', async () => {
  const admin = await signIn('admin');
  const store = await signIn('warehouse');
  const till = await signIn('cashier');
  const sku = await newProduct(admin, { alloc_b2b: 0, alloc_shop: 1, alloc_reserve: 0 });
  await receive(store, sku, 24, 5);

  const short = await POST(till, '/api/till/sell',
    { lines: [{ sku, qty: 1 }], method: 'cash', tendered: 100 });
  assert.equal(short.status, 400);
  assert.match(short.data.error, /Not enough cash/);

  const shelf = await GET(till, `/api/till/products?q=${sku}`);
  assert.equal(shelf.data[0].on_shelf, 5, 'the failed sale rolled all the way back');
});

// ===========================================================================
// The blind cash count
// ===========================================================================
test('the till total stays hidden until the drawer count is submitted', async () => {
  const admin = await signIn('admin');
  const store = await signIn('warehouse');
  const till = await signIn('cashier');
  const sku = await newProduct(admin, { alloc_b2b: 0, alloc_shop: 1, alloc_reserve: 0 });
  await receive(store, sku, 24, 10);

  await POST(till, '/api/till/sell', { lines: [{ sku, qty: 2 }], method: 'cash', tendered: 1000 });
  await POST(till, '/api/till/sell', { lines: [{ sku, qty: 1 }], method: 'gcash' });

  // Nothing a cashier can read tells them what the drawer should hold.
  const before = await GET(till, '/api/till/close-day');
  assert.equal(before.status, 200);
  assert.ok(!/expected|variance/.test(JSON.stringify(before.data)),
    'a cashier must not be able to look up the expected figure first');

  const expected = 450 * 2;                    // cash only; the GCash sale is not in the drawer
  const { status, data } = await POST(till, '/api/till/close-day', { declared: expected - 50 });
  assert.equal(status, 200, JSON.stringify(data));
  assert.equal(Number(data.expected), expected);
  assert.equal(Number(data.variance), -50);
  assert.equal(data.flagged, false, '₱50 is inside the tolerance');

  const twice = await POST(till, '/api/till/close-day', { declared: 1 });
  assert.equal(twice.status, 400);
  assert.match(twice.data.error, /already counted/i);
});

test('a big difference is flagged for the owner', async () => {
  const admin = await signIn('admin');
  const store = await signIn('warehouse');
  const till = await signIn('cashier');
  const sku = await newProduct(admin, { alloc_b2b: 0, alloc_shop: 1, alloc_reserve: 0 });
  await receive(store, sku, 24, 10);
  await POST(till, '/api/till/sell', { lines: [{ sku, qty: 2 }], method: 'cash', tendered: 1000 });

  const { data } = await POST(till, '/api/till/close-day', { declared: 200 });
  assert.equal(Number(data.variance), 200 - 900);
  assert.equal(data.flagged, true);
});

// ===========================================================================
// The look of it
// ===========================================================================
test('the dusty pink palette and a layout that works on a tablet', () => {
  const css = fs.readFileSync(path.join(here, '..', 'public', 'styles.css'), 'utf8');
  const html = fs.readFileSync(path.join(here, '..', 'public', 'index.html'), 'utf8');

  for (const colour of ['#D8A7B1', '#B4838D', '#FAF6F4', '#F4E4E8',
                        '#4A3B40', '#A8B8A0', '#E0A458', '#C46A6A']) {
    assert.ok(css.includes(colour), `the palette must define ${colour}`);
  }
  assert.match(html, /name="viewport"[^>]*width=device-width/);
  assert.ok(/@media \(max-width: 900px\)/.test(css) && /@media \(max-width: 950px\)/.test(css),
    'the frame and the till both need to fold down for a tablet');
  assert.ok(css.includes('--round') && css.includes('box-shadow'),
    'soft cards rather than hard borders');
});

// ===========================================================================
// Nobody sees anything that is not theirs
// ===========================================================================
test('each sign-in is held to its own part of the system', async () => {
  const admin = await signIn('admin');
  const till = await signIn('cashier');
  const store = await signIn('warehouse');
  const buyer = await signIn('reseller', await newReseller(admin));

  assert.equal((await GET(till, '/api/dashboard')).status, 403);
  assert.equal((await GET(till, '/api/resellers')).status, 403);
  assert.equal((await GET(store, '/api/reports/receivables')).status, 403);
  assert.equal((await GET(buyer, '/api/products?q=')).status, 403,
    'a reseller can never see what we hold in total');
  assert.equal((await GET(buyer, '/api/till/products?q=')).status, 403);
  assert.equal((await GET(null, '/api/dashboard')).status, 401);

  const other = await signIn('reseller', await newReseller(admin));
  const mine = await GET(buyer, '/api/portal/orders');
  const theirs = await GET(other, '/api/portal/orders');
  assert.equal(mine.status, 200);
  assert.equal(theirs.status, 200);
  assert.equal(mine.data.filter((o) => theirs.data.some((t) => t.id === o.id)).length, 0,
    'two accounts never see each other’s orders');
});

test('a warehouse picker sees who an order is for, and whether it is paid, but not the money',
  async () => {
    const admin = await signIn('admin');
    const store = await signIn('warehouse');
    const sku = await newProduct(admin, { alloc_b2b: 1, alloc_shop: 0, alloc_reserve: 0 });
    await receive(store, sku, 24, 20);
    const buyer = await signIn('reseller',
      await newReseller(admin, { tier: 1, credit_limit: 0, terms_days: 0 }));
    const order = await POST(buyer, '/api/portal/orders', { lines: [{ sku, qty: 3 }] });

    const asPicker = await GET(store, `/api/orders/${order.data.orderId}`);
    assert.equal(asPicker.status, 200);
    assert.ok(asPicker.data.reseller, 'the picker can see whose order it is');
    assert.equal(asPicker.data.invoice_status, 'open', 'and that a prepaid account has not paid');
    assert.equal(asPicker.data.balance, null, 'but not the amount — that is not their business');

    const asOwner = await GET(admin, `/api/orders/${order.data.orderId}`);
    assert.ok(Number(asOwner.data.balance) > 0, 'the owner does see it');
  });

test('switching a sign-in off ends the session immediately', async () => {
  const admin = await signIn('admin');
  const till = await signIn('cashier');
  assert.equal((await GET(till, '/api/till/products?q=')).status, 200);

  const { rows } = await db.query('select id from app_users where username = $1', [till.username]);
  assert.equal((await POST(admin, `/api/users/${rows[0].id}/active`, { active: false })).status, 200);

  const after = await GET(till, '/api/till/products?q=');
  assert.equal(after.status, 401, 'the cookie is still valid but must stop working at once');
  assert.match(after.data.error, /switched off/i);
});

// ===========================================================================
// Everything else the shop leans on
// ===========================================================================
test('cancelling an order that has not shipped puts the stock back on sale', async () => {
  const admin = await signIn('admin');
  const store = await signIn('warehouse');
  const sku = await newProduct(admin, { alloc_b2b: 1, alloc_shop: 0, alloc_reserve: 0 });
  await receive(store, sku, 24, 10);
  const buyer = await signIn('reseller', await newReseller(admin));

  const order = await POST(buyer, '/api/portal/orders', { lines: [{ sku, qty: 10 }] });
  const held = await GET(buyer, '/api/portal/catalog');
  assert.equal(held.data.find((p) => p.sku === sku).available, 0);

  assert.equal((await POST(buyer, `/api/portal/orders/${order.data.orderId}/cancel`)).status, 200);
  const back = await GET(buyer, '/api/portal/catalog');
  assert.equal(back.data.find((p) => p.sku === sku).available, 10);
});

test('a return waits for the owner before anything moves', async () => {
  const admin = await signIn('admin');
  const store = await signIn('warehouse');
  const till = await signIn('cashier');
  const sku = await newProduct(admin, { alloc_b2b: 0, alloc_shop: 1, alloc_reserve: 0 });
  await receive(store, sku, 24, 10);

  const sale = await POST(till, '/api/till/sell',
    { lines: [{ sku, qty: 3 }], method: 'cash', tendered: 2000 });
  const receipt = sale.data.receipt_no;

  const found = await GET(till, `/api/till/receipts/${receipt}`);
  const line = found.data.lines[0];
  assert.equal(Number(line.returnable), 3);

  const raised = await POST(till, '/api/till/returns', {
    receipt_no: receipt, sku, batchId: line.batch_id, qty: 2, reason: 'unopened, wrong shade',
  });
  assert.equal(raised.status, 200, JSON.stringify(raised.data));

  const stillOut = await GET(till, `/api/till/products?q=${sku}`);
  assert.equal(stillOut.data[0].on_shelf, 7, 'nothing goes back on the shelf on its own');

  const tooMany = await POST(till, '/api/till/returns', {
    receipt_no: receipt, sku, batchId: line.batch_id, qty: 2, reason: 'again',
  });
  assert.equal(tooMany.status, 400, 'more cannot come back than went out');

  assert.equal((await POST(admin, `/api/returns/${raised.data.id}/decide`,
    { approve: true, outcome: 'restock' })).status, 200);
  const restocked = await GET(till, `/api/till/products?q=${sku}`);
  assert.equal(restocked.data[0].on_shelf, 9);
});

test('the shop price may not be set below what resellers sell at', async () => {
  const admin = await signIn('admin');
  const sku = await newProduct(admin);
  const bad = await PUT(admin, `/api/products/${sku}`, { retail_price: 100, srp: 400 });
  assert.equal(bad.status, 400);
  assert.match(bad.data.error, /below the price resellers sell at/i);
});

test('expired stock cannot be sold and is written out of the ledger', async () => {
  const admin = await signIn('admin');
  const store = await signIn('warehouse');
  const till = await signIn('cashier');
  const sku = await newProduct(admin, { alloc_b2b: 0, alloc_shop: 1, alloc_reserve: 0 });
  const batchNo = unique('EXP');
  await POST(store, '/api/receive', { sku, batch_no: batchNo, expiry: monthsOut(24), qty: 10 });
  await db.query('update batches set expiry = current_date - 1 where batch_no = $1', [batchNo]);

  const sale = await POST(till, '/api/till/sell',
    { lines: [{ sku, qty: 1 }], method: 'cash', tendered: 1000 });
  assert.equal(sale.status, 400, 'expired stock is not sellable');

  const expired = await GET(store, '/api/expired');
  const row = expired.data.find((x) => x.batch_no === batchNo);
  assert.ok(row, 'it is listed for writing off');

  const off = await POST(store, '/api/expired/write-off', { batchId: row.batch_id });
  assert.equal(Number(off.data.units), 10);

  const journal = await GET(store, `/api/reports/journal?q=${sku}`);
  assert.ok(journal.data.some((m) => m.reason === 'expired' && m.qty === 10),
    'and the write-off is on the record with its reason');
});

test('marking an order delivered does not take it out of the books', async () => {
  const admin = await signIn('admin');
  const store = await signIn('warehouse');
  const sku = await newProduct(admin, { alloc_b2b: 1, alloc_shop: 0, alloc_reserve: 0 });
  await receive(store, sku, 24, 40);
  const buyer = await signIn('reseller', await newReseller(admin));

  const order = await POST(buyer, '/api/portal/orders', { lines: [{ sku, qty: 10 }] });
  await POST(store, `/api/orders/${order.data.orderId}/dispatch`);

  const revenue = async () => {
    const report = await GET(admin, '/api/reports/sales');
    const row = report.data.byProduct.find((p) => p.sku === sku);
    return row ? Number(row.revenue) : 0;
  };
  const before = await revenue();
  assert.ok(before > 0);

  assert.equal((await POST(store, `/api/orders/${order.data.orderId}/deliver`)).status, 200);
  assert.equal(await revenue(), before,
    'confirming delivery must not remove the sale from the reports');

  const twice = await POST(store, `/api/orders/${order.data.orderId}/deliver`);
  assert.equal(twice.status, 400);
  assert.match(twice.data.error, /already/i);
});

test('a counter sale cannot be marked delivered', async () => {
  const admin = await signIn('admin');
  const store = await signIn('warehouse');
  const till = await signIn('cashier');
  const sku = await newProduct(admin, { alloc_b2b: 0, alloc_shop: 1, alloc_reserve: 0 });
  await receive(store, sku, 24, 5);
  const sale = await POST(till, '/api/till/sell',
    { lines: [{ sku, qty: 1 }], method: 'cash', tendered: 1000 });

  const bad = await POST(store, `/api/orders/${sale.data.order_id}/deliver`);
  assert.equal(bad.status, 400);
  assert.match(bad.data.error, /handed over at the till/i);
});

test('the reserve can only be released by the owner', async () => {
  const admin = await signIn('admin');
  const store = await signIn('warehouse');
  const sku = await newProduct(admin);
  const received = await receive(store, sku, 24, 100);
  const batchId = received.data.batchId;

  const refused = await POST(store, '/api/move',
    { batchId, from: 'reserve', to: 'shop', qty: 5 });
  assert.equal(refused.status, 400);
  assert.match(refused.data.error, /does not allow/i);

  const allowed = await POST(admin, '/api/move',
    { batchId, from: 'reserve', to: 'shop', qty: 5 });
  assert.equal(allowed.status, 200, JSON.stringify(allowed.data));

  const journal = await GET(store, `/api/reports/journal?q=${sku}`);
  assert.ok(journal.data.some((m) => m.reason === 'reserve released'),
    'releasing the buffer is recorded as exactly that');
});

test('hostile input is treated as text, never as a command', async () => {
  const admin = await signIn('admin');
  const store = await signIn('warehouse');

  const injected = await GET(admin,
    `/api/products?q=${encodeURIComponent("'; drop table products;--")}`);
  assert.equal(injected.status, 200);
  assert.deepEqual(injected.data, []);
  assert.ok((await GET(admin, '/api/products?q=')).data.length > 0, 'the table is still there');

  for (const bad of ['-5', '0', 'abc', '1e999', '']) {
    const r = await GET(store, `/api/reports/journal?limit=${encodeURIComponent(bad)}`);
    assert.equal(r.status, 200, `limit=${bad} should be clamped, not error`);
    assert.ok(Array.isArray(r.data) && r.data.length <= 1000);
  }
});

test('the demand figures can be rebuilt from what actually sold', async () => {
  const admin = await signIn('admin');
  const store = await signIn('warehouse');
  const till = await signIn('cashier');
  const sku = await newProduct(admin, { alloc_b2b: 0, alloc_shop: 1, alloc_reserve: 0 });
  await receive(store, sku, 24, 200);
  await POST(admin, `/api/reorder/${sku}`,
    { avg_daily: 1, max_daily: 2, avg_lead: 30, max_lead: 40 });

  await POST(till, '/api/till/sell', { lines: [{ sku, qty: 90 }], method: 'gcash' });

  const { status, data } = await POST(store, `/api/reorder/${sku}/recalc`);
  assert.equal(status, 200, JSON.stringify(data));
  assert.equal(Number(data.avg_daily), 1, '90 units over 90 days is 1 a day');
  assert.equal(Number(data.max_daily), 90, 'and the busiest day was 90');
});
