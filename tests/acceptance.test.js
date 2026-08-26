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
import sharp from 'sharp';
import { hashPassword, needsRenewing } from '../lib/auth.js';
import { today, daysAgo } from '../lib/day.js';
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
const DELETE = (c, p) => request(c, 'DELETE', p);

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
// One payment, against the account rather than one invoice — the shape of a
// payment that actually arrives when a reseller sends money whenever it
// suits them rather than one bank transfer per order.
// ===========================================================================
test('one payment against the account settles what is open, oldest invoice first',
  async () => {
    const admin = await signIn('admin');
    const store = await signIn('warehouse');
    // 45-day terms so the 30-day early-settlement discount never applies —
    // this test is about which invoice the money goes to, not how much of it.
    const sku = await newProduct(admin, { alloc_b2b: 1, alloc_shop: 0, alloc_reserve: 0 });
    await receive(store, sku, 24, 40);
    const id = await newReseller(admin, { tier: 2, credit_limit: 1_000_000, terms_days: 45 });
    const buyer = await signIn('reseller', id);

    const first = await POST(buyer, '/api/portal/orders', { lines: [{ sku, qty: 10 }] });   // ₱2,500
    const second = await POST(buyer, '/api/portal/orders', { lines: [{ sku, qty: 10 }] });  // ₱2,500
    assert.equal(Number(first.data.invoice.amount), 2500);
    assert.equal(Number(second.data.invoice.amount), 2500);

    const paid = await POST(admin, `/api/resellers/${id}/payment`, { amount: 4000 });
    assert.equal(paid.status, 200, JSON.stringify(paid.data));
    assert.equal(paid.data.applied.length, 2, 'both invoices should have been touched');
    // jsonb_build_object hands the id back as a JSON number; the invoice a
    // route returns straight off a bigint column comes back as a string —
    // node-pg's own precaution against losing precision above 2^53. Both name
    // the same invoice, so the comparison casts rather than caring which.
    assert.equal(Number(paid.data.applied[0].invoice_id), Number(first.data.invoice.id),
      'the invoice raised first must be the one paid first');
    assert.equal(Number(paid.data.applied[0].applied), 2500);
    assert.equal(Number(paid.data.applied[0].now_owes), 0);
    assert.equal(Number(paid.data.applied[1].invoice_id), Number(second.data.invoice.id));
    assert.equal(Number(paid.data.applied[1].applied), 1500);
    assert.equal(Number(paid.data.applied[1].now_owes), 1000);
    assert.equal(Number(paid.data.credited), 0, 'every peso had somewhere to go');

    const account = await GET(admin, `/api/resellers/${id}`);
    assert.equal(account.data.invoices.find((i) => i.id === first.data.invoice.id).status, 'paid');
    assert.equal(account.data.invoices.find((i) => i.id === second.data.invoice.id).status, 'open');
    assert.equal(Number(account.data.owed), 1000);
  });

test('a payment left over once every invoice is closed is credit, not a discrepancy',
  async () => {
    const admin = await signIn('admin');
    const store = await signIn('warehouse');
    const sku = await newProduct(admin, { alloc_b2b: 1, alloc_shop: 0, alloc_reserve: 0 });
    await receive(store, sku, 24, 10);
    const id = await newReseller(admin, { tier: 2, credit_limit: 1_000_000, terms_days: 45 });
    const buyer = await signIn('reseller', id);
    const order = await POST(buyer, '/api/portal/orders', { lines: [{ sku, qty: 10 }] });  // ₱2,500

    const paid = await POST(admin, `/api/resellers/${id}/payment`, { amount: 3000 });
    assert.equal(paid.status, 200, JSON.stringify(paid.data));
    assert.equal(paid.data.applied.length, 1);
    assert.equal(Number(paid.data.applied[0].applied), 2500);
    assert.equal(Number(paid.data.credited), 500,
      'the ₱500 nobody owed for must not simply vanish off an over-full invoice');

    const account = await GET(admin, `/api/resellers/${id}`);
    assert.equal(account.data.invoices[0].status, 'paid');
    assert.equal(Number(account.data.credit), 500);
    assert.equal(Number(account.data.owed), 0);
  });

test('an account with nothing open turns a whole payment straight into credit', async () => {
  const admin = await signIn('admin');
  const id = await newReseller(admin, { tier: 2, credit_limit: 1_000_000, terms_days: 30 });

  const paid = await POST(admin, `/api/resellers/${id}/payment`, { amount: 1000 });
  assert.equal(paid.status, 200, JSON.stringify(paid.data));
  assert.deepEqual(paid.data.applied, []);
  assert.equal(Number(paid.data.credited), 1000);

  const account = await GET(admin, `/api/resellers/${id}`);
  assert.equal(Number(account.data.credit), 1000);
});

test('an order placed on a reseller\'s behalf raises the same invoice their own checkout would',
  async () => {
    const admin = await signIn('admin');
    const store = await signIn('warehouse');
    const sku = await newProduct(admin, { alloc_b2b: 1, alloc_shop: 0, alloc_reserve: 0 });
    await receive(store, sku, 24, 10);
    const id = await newReseller(admin, { tier: 2, credit_limit: 1_000_000, terms_days: 30 });

    const order = await POST(admin, `/api/resellers/${id}/orders`, { lines: [{ sku, qty: 4 }] }); // ₱1,000
    assert.equal(order.status, 200, JSON.stringify(order.data));
    assert.equal(Number(order.data.invoice.amount), 1000);
    assert.equal(Number(order.data.invoice.reseller_id), id);

    const account = await GET(admin, `/api/resellers/${id}`);
    assert.equal(Number(account.data.owed), 1000);
    assert.ok(account.data.invoices.some((i) => i.id === order.data.invoice.id));
  });

test('placing an empty order for a reseller is refused, not filed as a ₱0 order', async () => {
  const admin = await signIn('admin');
  const id = await newReseller(admin, { tier: 2, credit_limit: 1_000_000, terms_days: 30 });
  const empty = await POST(admin, `/api/resellers/${id}/orders`, { lines: [] });
  assert.equal(empty.status, 400);
});

test('only admin may place an order on a reseller\'s behalf', async () => {
  const admin = await signIn('admin');
  const store = await signIn('warehouse');
  const till = await signIn('cashier');
  const sku = await newProduct(admin, { alloc_b2b: 1, alloc_shop: 0, alloc_reserve: 0 });
  await receive(store, sku, 24, 10);
  const id = await newReseller(admin, { tier: 2, credit_limit: 1_000_000, terms_days: 30 });

  assert.equal((await POST(store, `/api/resellers/${id}/orders`, { lines: [{ sku, qty: 1 }] })).status, 403);
  assert.equal((await POST(till, `/api/resellers/${id}/orders`, { lines: [{ sku, qty: 1 }] })).status, 403);
});

test('confirming a bank payment through chat orders stamps an OR, in the till\'s own series',
  async () => {
    const admin = await signIn('admin');
    const store = await signIn('warehouse');
    const sku = await newProduct(admin, { alloc_b2b: 1, alloc_shop: 0, alloc_reserve: 0 });
    await receive(store, sku, 24, 10);
    const id = await newReseller(admin, { tier: 2, credit_limit: 1_000_000, terms_days: 45 });
    const buyer = await signIn('reseller', id);
    const order = await POST(buyer, '/api/portal/orders', { lines: [{ sku, qty: 10 }] }); // ₱2,500

    const paid = await POST(admin, `/api/resellers/${id}/receipt`, { amount: 3000 });
    assert.equal(paid.status, 200, JSON.stringify(paid.data));
    assert.match(paid.data.receipt_no, /^OR-\d{8}-\d{5}$/);
    // Same ledger effect a plain /payment would have had — this route is not
    // a second way to apply money, only the first way plus a number on it.
    assert.equal(paid.data.applied.length, 1);
    assert.equal(Number(paid.data.applied[0].invoice_id), Number(order.data.invoice.id));
    assert.equal(Number(paid.data.applied[0].applied), 2500);
    assert.equal(Number(paid.data.credited), 500);

    const listed = await GET(admin, `/api/resellers/${id}/receipts`);
    assert.equal(listed.status, 200);
    assert.ok(listed.data.some((r) => r.receipt_no === paid.data.receipt_no));

    const single = await GET(admin, `/api/receipts/${paid.data.receipt_no}`);
    assert.equal(single.status, 200);
    assert.equal(Number(single.data.amount), 3000);
    assert.equal(Number(single.data.credited), 500);
  });

test('two ORs never share a number, even for the same account back to back', async () => {
  const admin = await signIn('admin');
  const id = await newReseller(admin, { tier: 2, credit_limit: 1_000_000, terms_days: 30 });
  const first = await POST(admin, `/api/resellers/${id}/receipt`, { amount: 100 });
  const second = await POST(admin, `/api/resellers/${id}/receipt`, { amount: 100 });
  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  assert.notEqual(first.data.receipt_no, second.data.receipt_no);
});

test('only admin may issue or look up a reseller\'s OR', async () => {
  const admin = await signIn('admin');
  const till = await signIn('cashier');
  const id = await newReseller(admin, { tier: 2, credit_limit: 1_000_000, terms_days: 30 });
  const buyer = await signIn('reseller', id);

  assert.equal((await POST(till, `/api/resellers/${id}/receipt`, { amount: 100 })).status, 403);
  assert.equal((await POST(buyer, `/api/resellers/${id}/receipt`, { amount: 100 })).status, 403);

  const issued = await POST(admin, `/api/resellers/${id}/receipt`, { amount: 100 });
  assert.equal(issued.status, 200);
  // Both lookup routes are admin-only — a reseller reads their own payment
  // history some other way (their portal orders), never by receipt number.
  assert.equal((await GET(buyer, `/api/receipts/${issued.data.receipt_no}`)).status, 403);
  assert.equal((await GET(buyer, `/api/resellers/${id}/receipts`)).status, 403);
});

test('credit on the account is drawn down the moment the next invoice exists, unasked',
  async () => {
    const admin = await signIn('admin');
    const store = await signIn('warehouse');
    const sku = await newProduct(admin, { alloc_b2b: 1, alloc_shop: 0, alloc_reserve: 0 });
    await receive(store, sku, 24, 20);
    const id = await newReseller(admin, { tier: 2, credit_limit: 1_000_000, terms_days: 45 });
    const buyer = await signIn('reseller', id);

    // Nothing owed yet, so the whole payment becomes credit.
    await POST(admin, `/api/resellers/${id}/payment`, { amount: 500 });
    assert.equal(Number((await GET(admin, `/api/resellers/${id}`)).data.credit), 500);

    // The credit is spent the instant an invoice exists — nobody asks for it,
    // nobody applies it by hand.
    const order = await POST(buyer, '/api/portal/orders', { lines: [{ sku, qty: 4 }] }); // ₱1,000
    assert.equal(order.status, 200, JSON.stringify(order.data));

    const account = await GET(admin, `/api/resellers/${id}`);
    assert.equal(Number(account.data.credit), 0, 'the credit is gone — it was just spent');
    const invoice = account.data.invoices.find((i) => i.id === order.data.invoice.id);
    assert.equal(Number(invoice.balance), 500, 'half the invoice was already covered');
    assert.equal(invoice.status, 'open', 'half paid is not the same as settled');
  });

test('an account holding nothing but credit is not invisible to the receivables report',
  async () => {
    // ar_ageing only ever lists a reseller by way of an open invoice — right
    // for a report about what is owed, wrong for one about the shop's money.
    // A reseller sitting purely in credit has no open invoice to be found by.
    const admin = await signIn('admin');
    const id = await newReseller(admin, { tier: 3, credit_limit: 1_000_000, terms_days: 30 });
    const named = await GET(admin, `/api/resellers/${id}`);
    // An account with nothing paid, nothing owed and nothing to it — the
    // report must not claim it is holding credit either.
    const plain = await newReseller(admin, { tier: 3, credit_limit: 1_000_000, terms_days: 30 });

    await POST(admin, `/api/resellers/${id}/payment`, { amount: 750 });

    const report = await GET(admin, '/api/reports/receivables');
    assert.equal(report.status, 200, JSON.stringify(report.data));
    const holder = report.data.credit.find((c) => Number(c.reseller_id) === id);
    assert.ok(holder, 'an account holding credit must appear in the credit report');
    assert.equal(Number(holder.credit), 750);
    assert.equal(holder.name, named.data.name);
    assert.equal(report.data.credit.some((c) => Number(c.reseller_id) === plain), false,
      'an account holding nothing must not be listed as holding credit');

    // And it must not appear as a debt: nothing is owed, so ar_ageing (and
    // therefore this table) should have nothing to say about this account.
    assert.equal(report.data.ageing.some((a) => Number(a.reseller_id) === id), false,
      'a reseller who is owed nothing must not also be listed as owing it');
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

  // The house palette, shared with the storefront and the marketing site.
  for (const colour of ['#C98DA4', '#A2647E', '#EFCCDA', '#F9E9F0',
                        '#DDAEC2', '#45303C', '#FBF6F8']) {
    assert.ok(css.includes(colour), `the palette must define ${colour}`);
  }
  assert.match(html, /name="viewport"[^>]*width=device-width/);

  // Wide: the tabs stand in a column beside the work. Narrow: they slide in
  // over it, because a phone cannot spare 236px. Both arrangements have to
  // exist, or one of the two shapes is broken.
  assert.ok(/@media \(min-width: 1000px\)/.test(css), 'the standing column of tabs');
  assert.ok(/@media \(max-width: 999px\)/.test(css), 'the tabs as a drawer');
  assert.ok(/@media \(max-width: 950px\)/.test(css), 'the till folds to one column');

  assert.ok(css.includes('--round') && css.includes('border-radius'),
    'soft cards rather than hard corners');
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

// ===========================================================================
// Reserving from the customer app
//
// The promise: what the app holds, the counter cannot sell — and what the
// counter hands over reaches the day's takings like any other sale.
// ===========================================================================

/** A signed-in shopper, with the cookie the app would carry. */
async function joinShop() {
  const phone = `0917${String(Date.now()).slice(-7)}${++seq % 10}`;
  const res = await fetch(`${base}/api/shop/join`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Test Shopper', phone, password: 'shopper123' }),
  });
  assert.equal(res.status, 200, 'could not join the shop');
  const raw = res.headers.getSetCookie?.()[0] ?? res.headers.get('set-cookie');
  return raw.split(';')[0];
}

const shelfFree = async (till, sku) =>
  (await GET(till, `/api/till/products?q=${sku}`)).data[0]?.on_shelf ?? 0;

test('a reservation holds stock the counter can no longer sell', async () => {
  const admin = await signIn('admin');
  const store = await signIn('warehouse');
  const till = await signIn('cashier');
  const sku = await newProduct(admin);
  await receive(store, sku, 24, 100);          // 20 of them land on the shelf

  const before = await shelfFree(till, sku);
  const shopper = await joinShop();

  const made = await POST(shopper, '/api/shop/reserve', { lines: [{ sku, qty: 3 }] });
  assert.equal(made.status, 200, JSON.stringify(made.data));
  assert.match(made.data.code, /^MB-\d+$/);

  assert.equal(await shelfFree(till, sku), before - 3,
    'the three reserved units must leave the sellable shelf immediately');

  // And the counter can see who is coming for what.
  const waiting = (await GET(till, '/api/pickups')).data;
  assert.ok(waiting.some((p) => p.code === made.data.code), 'the counter must see the hold');
});

test('collecting a reservation sells it, and points follow the money', async () => {
  const admin = await signIn('admin');
  const store = await signIn('warehouse');
  const till = await signIn('cashier');
  // Priced so the arithmetic below is obvious: two at ₱200 is ₱400, which is
  // twenty points. The reseller price moves with it, because the shop may
  // never undercut what resellers sell at.
  const sku = await newProduct(admin, { unit_cost: 50, wholesale_price: 100, srp: 180, retail_price: 200 });
  await receive(store, sku, 24, 100);

  const shopper = await joinShop();
  const made = await POST(shopper, '/api/shop/reserve', { lines: [{ sku, qty: 2 }] });
  const takingsBefore = Number((await GET(admin, '/api/dashboard')).data.takings.total);

  const done = await POST(till, `/api/pickups/${made.data.code}/collect`, { method: 'gcash' });
  assert.equal(done.status, 200, JSON.stringify(done.data));
  assert.match(done.data.receipt_no, /^OR-\d{8}-\d{5}$/, 'a collection is a sale, so it gets a receipt');
  assert.equal(Number(done.data.total), 400);
  assert.equal(done.data.points, 20, 'one point per ₱20');

  const takingsAfter = Number((await GET(admin, '/api/dashboard')).data.takings.total);
  assert.equal(takingsAfter - takingsBefore, 400,
    'a collected reservation has to reach the takings, or the close of day will not balance');

  const me = (await GET(shopper, '/api/shop/me')).data;
  assert.equal(me.customer.points, 20);
  assert.equal(me.purchases.collected, 1);
  assert.equal(me.purchases.toCollect, 0);

  // Handed over once. A second attempt must not sell the same goods twice.
  const again = await POST(till, `/api/pickups/${made.data.code}/collect`, { method: 'cash' });
  assert.equal(again.status, 400);
  assert.match(again.data.error, /already collected/i);
});

test('cancelling a reservation puts the stock back', async () => {
  const admin = await signIn('admin');
  const store = await signIn('warehouse');
  const till = await signIn('cashier');
  const sku = await newProduct(admin);
  await receive(store, sku, 24, 100);

  const shopper = await joinShop();
  const before = await shelfFree(till, sku);
  const made = await POST(shopper, '/api/shop/reserve', { lines: [{ sku, qty: 4 }] });
  assert.equal(await shelfFree(till, sku), before - 4);

  const dropped = await POST(shopper, `/api/shop/purchases/${made.data.pickup_id}/cancel`);
  assert.equal(dropped.status, 200);
  assert.equal(await shelfFree(till, sku), before, 'cancelling has to release the hold');
});

test('a reservation belongs to the shopper who made it', async () => {
  const admin = await signIn('admin');
  const store = await signIn('warehouse');
  const sku = await newProduct(admin);
  await receive(store, sku, 24, 100);

  const mine = await joinShop();
  const theirs = await joinShop();
  const made = await POST(mine, '/api/shop/reserve', { lines: [{ sku, qty: 1 }] });

  const meddling = await POST(theirs, `/api/shop/purchases/${made.data.pickup_id}/cancel`);
  assert.equal(meddling.status, 400);
  assert.match(meddling.data.error, /not your reservation/i);

  assert.equal((await GET(theirs, '/api/shop/purchases')).data.length, 0,
    'one shopper must never see another shopper\'s reservations');

  const stranger = await POST(null, '/api/shop/reserve', { lines: [{ sku, qty: 1 }] });
  assert.equal(stranger.status, 401, 'reserving requires signing in');
});

test('the app cannot reserve stock the shelf does not have', async () => {
  const admin = await signIn('admin');
  const store = await signIn('warehouse');
  const till = await signIn('cashier');
  const sku = await newProduct(admin);
  await receive(store, sku, 24, 100);

  const shopper = await joinShop();
  const free = await shelfFree(till, sku);
  const greedy = await POST(shopper, '/api/shop/reserve', { lines: [{ sku, qty: free + 1 }] });

  assert.equal(greedy.status, 400);
  assert.match(greedy.data.error, /short/i);
  assert.equal(await shelfFree(till, sku), free,
    'a refused reservation must not leave anything held');
});

// ===========================================================================
// Promotions
//
// The promise: a discount is what the customer is charged, it never undercuts
// the price resellers sell at, and it never touches a wholesale price.
// ===========================================================================
test('a promotion is charged, not merely advertised', async () => {
  const admin = await signIn('admin');
  const store = await signIn('warehouse');
  const till = await signIn('cashier');
  const sku = await newProduct(admin,
    { unit_cost: 50, wholesale_price: 100, srp: 150, retail_price: 200 });
  await receive(store, sku, 24, 100);

  const started = await POST(admin, '/api/promos',
    { sku, headline: 'Ten off', percent: 10, ends: monthsOut(1) });
  assert.equal(started.status, 200, JSON.stringify(started.data));

  const onShelf = (await GET(till, `/api/till/products?q=${sku}`)).data[0];
  assert.equal(Number(onShelf.retail_price), 200, 'the ordinary price is still known');
  assert.equal(Number(onShelf.price_now), 180, 'and the till knows what to charge today');

  const sale = await POST(till, '/api/till/sell',
    { lines: [{ sku, qty: 2 }], method: 'cash', tendered: 500 });
  assert.equal(sale.status, 200, JSON.stringify(sale.data));
  assert.equal(Number(sale.data.total), 360, 'two at the promotion price, not the shelf price');
  assert.equal(Number(sale.data.lines[0].unit_price), 180);
});

test('a promotion may never undercut what resellers sell at', async () => {
  const admin = await signIn('admin');
  const sku = await newProduct(admin,
    { unit_cost: 50, wholesale_price: 100, srp: 180, retail_price: 200 });

  const tooDeep = await POST(admin, '/api/promos',
    { sku, headline: 'Half price', percent: 50, ends: monthsOut(1) });
  assert.equal(tooDeep.status, 400);
  assert.match(tooDeep.data.error, /below the 180\.00 resellers sell at/,
    'and it has to say what the limit is, not just refuse');
  assert.match(tooDeep.data.error, /most you can take off is 10 percent/);

  const allowed = await POST(admin, '/api/promos',
    { sku, headline: 'Ten off', percent: 10, ends: monthsOut(1) });
  assert.equal(allowed.status, 200, 'right up to the floor is fine');
});

test('a promotion never moves a wholesale price', async () => {
  const admin = await signIn('admin');
  const store = await signIn('warehouse');
  const sku = await newProduct(admin,
    { unit_cost: 50, wholesale_price: 100, srp: 150, retail_price: 200 });
  await receive(store, sku, 24, 200);
  await POST(admin, '/api/promos', { sku, headline: 'Sale', percent: 20, ends: monthsOut(1) });

  const resellerId = await newReseller(admin);
  const buyer = await signIn('reseller', resellerId);
  const order = await POST(buyer, '/api/portal/orders', { lines: [{ sku, qty: 10 }] });
  assert.equal(order.status, 200, JSON.stringify(order.data));

  const placed = (await GET(admin, `/api/orders/${order.data.orderId}`)).data;
  assert.equal(Number(placed.lines[0].unit_price), 100,
    'wholesale is contracted — a retail promotion must not touch it');
});

test('ending a promotion puts the price back', async () => {
  const admin = await signIn('admin');
  const store = await signIn('warehouse');
  const till = await signIn('cashier');
  const sku = await newProduct(admin,
    { unit_cost: 50, wholesale_price: 100, srp: 150, retail_price: 200 });
  await receive(store, sku, 24, 100);

  const { data } = await POST(admin, '/api/promos',
    { sku, headline: 'Briefly', percent: 10, ends: monthsOut(1) });
  assert.equal(Number((await GET(till, `/api/till/products?q=${sku}`)).data[0].price_now), 180);

  await POST(admin, `/api/promos/${data.id}/end`);
  assert.equal(Number((await GET(till, `/api/till/products?q=${sku}`)).data[0].price_now), 200);
});

// ===========================================================================
// The team
//
// The promise: hours are traceable, nobody is on two shifts at once, and what
// people earn and where they live is the owner's business alone.
// ===========================================================================
async function newEmployee(admin, name, position = 'Cashier') {
  const { status, data } = await POST(admin, '/api/team', { name, position, phone: '09170000000' });
  assert.equal(status, 200, JSON.stringify(data));
  return data.id;
}

test('a person cannot be on two shifts at once', async () => {
  const admin = await signIn('admin');
  const id = await newEmployee(admin, unique('Rina'));

  assert.equal((await POST(admin, `/api/team/${id}/clock`, { direction: 'in' })).status, 200);
  const twice = await POST(admin, `/api/team/${id}/clock`, { direction: 'in' });
  assert.equal(twice.status, 400);
  assert.match(twice.data.error, /already clocked in/);

  assert.equal((await POST(admin, `/api/team/${id}/clock`, { direction: 'out' })).status, 200);
  const spare = await POST(admin, `/api/team/${id}/clock`, { direction: 'out' });
  assert.equal(spare.status, 400, 'and cannot clock out twice either');
});

test('only the owner sees phone numbers, notes and hours', async () => {
  const admin = await signIn('admin');
  const store = await signIn('warehouse');
  const till = await signIn('cashier');
  await newEmployee(admin, unique('Joel'), 'Warehouse');

  const asOwner = (await GET(admin, '/api/team')).data;
  assert.ok('phone' in asOwner.team[0]);
  assert.ok('hours_this_week' in asOwner.team[0]);

  for (const who of [store, till]) {
    const seen = (await GET(who, '/api/team')).data;
    assert.ok(seen.team.length, 'staff still see who they work with');
    assert.ok(!('phone' in seen.team[0]), 'but never a colleague\'s phone number');
    assert.ok(!('note' in seen.team[0]));
    assert.ok(!('hours_this_week' in seen.team[0]));
    assert.equal(seen.shifts.length, 0, 'nor the shift record');
  }
});

test('clocking on is the counter\'s job, keeping the list is the owner\'s', async () => {
  const admin = await signIn('admin');
  const store = await signIn('warehouse');
  const till = await signIn('cashier');
  const id = await newEmployee(admin, unique('Ana'));

  assert.equal((await POST(till, `/api/team/${id}/clock`, { direction: 'in' })).status, 200,
    'a cashier runs the counter, so a cashier clocks people on');
  assert.equal((await POST(store, `/api/team/${id}/clock`, { direction: 'out' })).status, 403);
  assert.equal((await POST(till, '/api/team', { name: 'X', position: 'Y' })).status, 403,
    'but only the owner adds people');
});

test('a sign-in that is being used stays signed in', async () => {
  // A screen by a door is touched all day and set up once. If its sign-in only
  // counted down from the moment somebody typed the password, the clock would
  // turn into a login box twelve hours later, mid-shift, with nobody there who
  // knows the password.
  const HOUR = 3600e3;
  assert.equal(needsRenewing({ expires: Date.now() + 11 * HOUR }), false,
    'a fresh sign-in is left alone — most replies carry no cookie at all');
  assert.equal(needsRenewing({ expires: Date.now() + 5 * HOUR }), true,
    'past halfway it is re-issued, so a screen in daily use never falls out');
  assert.equal(needsRenewing({ expires: Date.now() + 60e3 }), true, 'and near the end');
  assert.equal(needsRenewing({ expires: Date.now() - HOUR }), false,
    'but one that has already run out is not brought back to life');
  assert.equal(needsRenewing({}), false);
  assert.equal(needsRenewing(null), false);

  // A request on a fresh session should not be handing out cookies.
  const door = await signIn('timekeeper');
  const res = await fetch(`${base}/api/team`, { headers: { Cookie: door } });
  assert.equal(res.status, 200);
  assert.equal(res.headers.getSetCookie?.().length ?? 0, 0,
    'nothing to renew yet, so nothing is sent');
});

test('the door screen can show the faces it lists', async () => {
  // The clock is a wall of faces: that is how somebody finds themselves on it
  // without reading. It signs in as a timekeeper, and for a while that sign-in
  // could list the team by name and position but not fetch a single
  // photograph — so every card on the door rendered as a broken image.
  const admin = await signIn('admin');
  const door = await signIn('timekeeper');
  const id = await newEmployee(admin, unique('Face'));

  // A one-pixel PNG is a photograph as far as any of this is concerned.
  const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJ'
    + 'AAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  assert.equal((await POST(admin, `/api/team/${id}/photo`, { dataUrl: png })).status, 200);

  const listed = await GET(door, '/api/team');
  assert.equal(listed.status, 200, 'the door lists the team');
  assert.ok(listed.data.team.some((p) => Number(p.id) === id));

  const shown = await fetch(`${base}/api/team/${id}/photo`, { headers: { Cookie: door } });
  assert.equal(shown.status, 200, 'and may show the face beside the name');
  assert.match(shown.headers.get('content-type'), /^image\//);

  // The board redraws every twenty seconds. Without a version in the address
  // and a cache to match it, that is every face on the wall fetched again
  // every minute, all day, through one agent — and the ones that lose that
  // race are blank circles with nothing to say why.
  const row = listed.data.team.find((p) => Number(p.id) === id);
  assert.ok('photo_at' in row, 'the door is told when the photograph last changed');
  assert.ok(row.photo_at, 'and it is set for somebody who has one');

  const stamped = await fetch(
    `${base}/api/team/${id}/photo?v=${new Date(row.photo_at).getTime()}`,
    { headers: { Cookie: door } });
  assert.equal(stamped.status, 200);
  assert.match(stamped.headers.get('cache-control'), /max-age=31536000/,
    'an address that names its version is safe to keep');
  assert.doesNotMatch(shown.headers.get('cache-control'), /31536000/,
    'one that does not must still notice a replaced picture');

  // Still not a public wall, though: a reseller sees neither.
  const outsider = await signIn('reseller', await newReseller(admin));
  assert.equal((await GET(outsider, '/api/team')).status, 403);
  const refused = await fetch(`${base}/api/team/${id}/photo`, { headers: { Cookie: outsider } });
  assert.equal(refused.status, 403, 'a reseller has no business knowing our staff by sight');
});

test('the door board carries today\'s arrival and departure', async () => {
  // What somebody at the door actually wants to know is what time they came in
  // and what time they went. Both have to reach a timekeeper sign-in, which
  // gets a cut-down copy of the team row — so this is really a test that the
  // two columns are on that list and not only in the database.
  const admin = await signIn('admin');
  const door = await signIn('timekeeper');
  const id = await newEmployee(admin, unique('Arriving'));

  const before = (await GET(door, '/api/team')).data.team.find((p) => Number(p.id) === id);
  assert.ok(before, 'the door lists them');
  assert.ok('today_in' in before && 'today_out' in before,
    'the door is told about today, or the board has nothing to show');
  assert.equal(before.today_in, null, 'nobody has clocked them on yet');

  assert.equal((await POST(admin, `/api/team/${id}/clock`, { direction: 'in' })).status, 200);
  const on = (await GET(door, '/api/team')).data.team.find((p) => Number(p.id) === id);
  assert.equal(on.on_shift, true);
  assert.ok(on.today_in, 'and now there is an arrival to show');
  assert.equal(on.today_out, null, 'they have not gone anywhere');

  assert.equal((await POST(admin, `/api/team/${id}/clock`, { direction: 'out' })).status, 200);
  const gone = (await GET(door, '/api/team')).data.team.find((p) => Number(p.id) === id);
  assert.equal(gone.on_shift, false);
  assert.ok(gone.today_in, 'the arrival survives clocking out');
  assert.ok(gone.today_out, 'and the departure is there beside it');
  assert.ok(new Date(gone.today_out) >= new Date(gone.today_in));

  // Yesterday is not today's business. The board clears itself overnight.
  await db.query(
    `update shifts set business_date = business_date - 1 where employee_id = $1`, [id]);
  const tomorrow = (await GET(door, '/api/team')).data.team.find((p) => Number(p.id) === id);
  assert.equal(tomorrow.today_in, null, 'a new day starts empty');
  assert.equal(tomorrow.today_out, null);
});

test('someone leaving keeps their hours on the books', async () => {
  const admin = await signIn('admin');
  const id = await newEmployee(admin, unique('Departing'));
  await POST(admin, `/api/team/${id}/clock`, { direction: 'in' });

  await POST(admin, `/api/team/${id}/left`, {});
  const { team, shifts } = (await GET(admin, '/api/team')).data;

  // Postgres hands bigints back as strings, so compare as numbers.
  const person = team.find((p) => Number(p.id) === id);
  assert.ok(person, 'the person is still on the list, dated, not deleted');
  assert.equal(person.here, false);
  assert.equal(person.on_shift, false, 'and their open shift was closed for them');
  assert.ok(shifts.some((s) => Number(s.employee_id) === id),
    'the shift they worked is still recorded');
});

test('one sign-in belongs to one person', async () => {
  const admin = await signIn('admin');
  const spare = await db.query(
    `insert into app_users (username, display_name, password_hash, role)
     values ($1,$1,$2,'cashier') returning id`, [unique('till'), hashPassword('secret123')]);
  const userId = Number(spare.rows[0].id);

  const first = await POST(admin, '/api/team',
    { name: unique('First'), position: 'Cashier', user_id: userId });
  assert.equal(first.status, 200);

  const second = await POST(admin, '/api/team',
    { name: unique('Second'), position: 'Cashier', user_id: userId });
  assert.equal(second.status, 400);
  assert.match(second.data.error, /already belongs to someone/);
});

// ===========================================================================
// Customers and loyalty
//
// The promise: the counter can sign somebody up in seconds, a walk-in sale can
// earn them points, and claiming the account in the app finds those points
// waiting rather than starting them at zero.
// ===========================================================================
test('the counter registers a customer, and a walk-in sale earns them points', async () => {
  const admin = await signIn('admin');
  const store = await signIn('warehouse');
  const till = await signIn('cashier');
  const sku = await newProduct(admin,
    { unit_cost: 50, wholesale_price: 100, srp: 150, retail_price: 200 });
  await receive(store, sku, 24, 100);

  const phone = `0917${String(Date.now()).slice(-7)}`;
  const made = await POST(till, '/api/customers', { name: 'Maria Walkin', phone });
  assert.equal(made.status, 200, JSON.stringify(made.data));

  const sale = await POST(till, '/api/till/sell',
    { lines: [{ sku, qty: 2 }], method: 'cash', tendered: 500 });
  const put = await POST(till, `/api/sales/${sale.data.receipt_no}/customer`,
    { customer_id: made.data.id });
  assert.equal(put.status, 200, JSON.stringify(put.data));
  assert.equal(put.data.points, 20, '₱400 at one point per ₱20');

  const twice = await POST(till, `/api/sales/${sale.data.receipt_no}/customer`,
    { customer_id: made.data.id });
  assert.equal(twice.status, 400, 'one receipt cannot be counted twice');

  const seen = (await GET(admin, `/api/customers/${made.data.id}`)).data;
  assert.equal(seen.points, 20);
  assert.equal(Number(seen.spent), 400);
  assert.equal(seen.orders, 1);
  assert.equal(seen.claimed, false, 'they have not set a password yet');
});

test('claiming a counter account keeps the points already earned', async () => {
  const admin = await signIn('admin');
  const store = await signIn('warehouse');
  const till = await signIn('cashier');
  const sku = await newProduct(admin,
    { unit_cost: 50, wholesale_price: 100, srp: 150, retail_price: 200 });
  await receive(store, sku, 24, 100);

  const digits = String(Date.now()).slice(-7);
  const made = await POST(till, '/api/customers', { name: 'Ana Claimed', phone: `0917${digits}` });
  const sale = await POST(till, '/api/till/sell',
    { lines: [{ sku, qty: 1 }], method: 'cash', tendered: 500 });
  await POST(till, `/api/sales/${sale.data.receipt_no}/customer`, { customer_id: made.data.id });

  // Nobody can sign in to it before it is claimed, whatever they guess.
  const guess = await POST(null, '/api/shop/login', { phone: `0917${digits}`, password: 'guess123' });
  assert.equal(guess.status, 401);

  // Claimed with the same number written differently, as a person would.
  const claim = await POST(null, '/api/shop/join',
    { name: 'Ana Claimed', phone: `+63 917 ${digits}`, password: 'herpassword' });
  assert.equal(claim.status, 200, JSON.stringify(claim.data));
  assert.equal(claim.data.customer.points, 10,
    'the points the shop added are hers on the first screen she sees');

  const all = (await GET(admin, '/api/customers')).data.customers
    .filter((c) => (c.phone || '').includes(digits));
  assert.equal(all.length, 1, 'claiming must not leave a second, empty account');
});

test('a customer\'s history counts both the counter and the app', async () => {
  const admin = await signIn('admin');
  const store = await signIn('warehouse');
  const till = await signIn('cashier');
  const sku = await newProduct(admin,
    { unit_cost: 50, wholesale_price: 100, srp: 150, retail_price: 200 });
  await receive(store, sku, 24, 100);

  const digits = String(Date.now()).slice(-7);
  const made = await POST(till, '/api/customers', { name: 'Both Ways', phone: `0918${digits}` });
  const sale = await POST(till, '/api/till/sell',
    { lines: [{ sku, qty: 1 }], method: 'cash', tendered: 500 });
  await POST(till, `/api/sales/${sale.data.receipt_no}/customer`, { customer_id: made.data.id });

  const claim = await POST(null, '/api/shop/join',
    { name: 'Both Ways', phone: `0918${digits}`, password: 'herpassword' });
  assert.equal(claim.status, 200, JSON.stringify(claim.data));

  const jar = (await fetch(`${base}/api/shop/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ phone: `0918${digits}`, password: 'herpassword' }),
  }));
  const cookie = (jar.headers.getSetCookie?.()[0] ?? jar.headers.get('set-cookie')).split(';')[0];

  const reserved = await POST(cookie, '/api/shop/reserve', { lines: [{ sku, qty: 1 }] });
  assert.equal(reserved.status, 200, JSON.stringify(reserved.data));
  await POST(till, `/api/pickups/${reserved.data.code}/collect`, { method: 'cash' });

  const seen = (await GET(admin, `/api/customers/${made.data.id}`)).data;
  assert.equal(seen.orders, 2, 'one at the counter, one reserved in the app');
  assert.equal(Number(seen.spent), 400);
  assert.equal(seen.points, 20);
  assert.deepEqual(seen.history.map((h) => h.how).sort(), ['counter', 'reserved']);
});

test('a cashier may register and attribute, but not read the whole list', async () => {
  const till = await signIn('cashier');
  const store = await signIn('warehouse');

  assert.equal((await GET(till, '/api/customers')).status, 403,
    'the customer book is the owner\'s');
  assert.equal((await GET(store, '/api/customers/find?q=09')).status, 403,
    'and the stockroom has no business looking anybody up');
  assert.equal((await GET(till, '/api/customers/find?q=09')).status, 200,
    'but the counter must be able to find whoever is standing there');
});

// ===========================================================================
// The money
//
// The promise: margin is worked out from what the goods cost when they were
// sold, expenses come off it, and nothing on the books can be made to vanish.
// ===========================================================================
// Manila, not UTC. The engine books a sale against the Manila trading day, so
// a window built from the UTC date asks for yesterday for the eight hours
// after Manila midnight — and the tests pass all day and fail overnight.
const period = () => `from=${daysAgo(2)}&to=${today()}`;

test('margin uses what the goods cost when they were sold', async () => {
  const admin = await signIn('admin');
  const store = await signIn('warehouse');
  const till = await signIn('cashier');
  const sku = await newProduct(admin,
    { unit_cost: 100, wholesale_price: 150, srp: 180, retail_price: 200 });
  await receive(store, sku, 24, 100);

  const before = (await GET(admin, `/api/finance?${period()}`)).data;
  const sale = await POST(till, '/api/till/sell',
    { lines: [{ sku, qty: 3 }], method: 'cash', tendered: 1000 });
  assert.equal(sale.status, 200, JSON.stringify(sale.data));

  const after = (await GET(admin, `/api/finance?${period()}`)).data;
  assert.equal(Number(after.counter.revenue) - Number(before.counter.revenue), 600);
  assert.equal(Number(after.counter.cost) - Number(before.counter.cost), 300,
    'three at a cost of 100');

  // The supplier puts the price up. Last week's margin must not move.
  await PUT(admin, `/api/products/${sku}`, { unit_cost: 175 });
  const later = (await GET(admin, `/api/finance?${period()}`)).data;
  assert.equal(Number(later.counter.cost), Number(after.counter.cost),
    'a cost change today cannot rewrite what a past sale earned');
});

test('expenses come off the margin, and voiding one keeps it on the books', async () => {
  const admin = await signIn('admin');
  const before = (await GET(admin, `/api/finance?${period()}`)).data;

  const made = await POST(admin, '/api/expenses',
    { kind: 'rent', description: 'Stall rent', amount: 5000, method: 'bank' });
  assert.equal(made.status, 200, JSON.stringify(made.data));

  const after = (await GET(admin, `/api/finance?${period()}`)).data;
  assert.equal(Number(after.expenses.total) - Number(before.expenses.total), 5000);
  assert.equal(Number(before.net) - Number(after.net), 5000, 'and it reduces what is left');

  const noReason = await POST(admin, `/api/expenses/${made.data.id}/void`, { reason: '' });
  assert.equal(noReason.status, 400, 'voiding has to say why');

  await POST(admin, `/api/expenses/${made.data.id}/void`, { reason: 'Entered twice' });
  const ended = (await GET(admin, `/api/finance?${period()}`)).data;
  assert.equal(Number(ended.expenses.total), Number(before.expenses.total),
    'a voided expense stops counting');

  const row = ended.entries.find((e) => Number(e.id) === made.data.id);
  assert.ok(row, 'but the entry is still there');
  assert.equal(row.voided, true);
  assert.equal(row.void_reason, 'Entered twice');
});

test('the books are the owner\'s alone', async () => {
  const till = await signIn('cashier');
  const store = await signIn('warehouse');
  const buyer = await signIn('reseller', await newReseller(await signIn('admin')));

  for (const who of [till, store, buyer]) {
    assert.equal((await GET(who, '/api/finance')).status, 403);
    assert.equal((await POST(who, '/api/expenses',
      { kind: 'other', description: 'x', amount: 1 })).status, 403);
  }
});

test('counter takings and wholesale invoices are never added together', async () => {
  const admin = await signIn('admin');
  const store = await signIn('warehouse');
  const sku = await newProduct(admin,
    { unit_cost: 100, wholesale_price: 150, srp: 180, retail_price: 200 });
  await receive(store, sku, 24, 200);

  const resellerId = await newReseller(admin);
  const buyer = await signIn('reseller', resellerId);
  const order = await POST(buyer, '/api/portal/orders', { lines: [{ sku, qty: 10 }] });
  await POST(store, `/api/orders/${order.data.orderId}/dispatch`);

  const d = (await GET(admin, `/api/finance?${period()}`)).data;
  assert.ok(Number(d.wholesale.invoiced) >= 1500, 'the invoice is counted as wholesale');
  assert.ok('outstanding' in d.wholesale,
    'and what is still owed is shown separately from money actually in hand');
  assert.notEqual(d.counter.revenue, d.wholesale.invoiced,
    'the two are reported apart, because they are paid at different times');
});

// ===========================================================================
// Paying for stock
//
// The promise: a delivery is recorded as money out, without being subtracted
// twice — once as an expense and again as the cost of what was sold.
// ===========================================================================
test('receiving records what it cost, as cash out and not as a trading cost', async () => {
  const admin = await signIn('admin');
  const store = await signIn('warehouse');
  const sku = await newProduct(admin,
    { unit_cost: 100, wholesale_price: 150, srp: 180, retail_price: 200 });

  const before = (await GET(admin, `/api/finance?${period()}`)).data;

  const got = await POST(store, '/api/receive',
    { sku, batch_no: unique('B'), expiry: monthsOut(24), qty: 50, unit_cost: 120, method: 'bank' });
  assert.equal(got.status, 200, JSON.stringify(got.data));

  const after = (await GET(admin, `/api/finance?${period()}`)).data;

  assert.equal(Number(after.stock_bought) - Number(before.stock_bought), 6000,
    'fifty at ₱120 is money out');
  assert.equal(Number(after.expenses.total), Number(before.expenses.total),
    'but it is not a running cost — cost of goods sold already accounts for it');
  assert.equal(Number(after.net), Number(before.net),
    'so buying stock cannot move the profit figure');
  assert.equal(Number(before.cash.movement) - Number(after.cash.movement), 6000,
    'it comes off the cash instead');
});

test('what a delivery cost becomes the product\'s cost, and a blank leaves it alone', async () => {
  const admin = await signIn('admin');
  const store = await signIn('warehouse');
  const till = await signIn('cashier');
  const sku = await newProduct(admin,
    { unit_cost: 100, wholesale_price: 150, srp: 180, retail_price: 200 });

  await POST(store, '/api/receive',
    { sku, batch_no: unique('B'), expiry: monthsOut(24), qty: 20, unit_cost: 130 });
  let product = (await GET(admin, `/api/products?q=${sku}`)).data[0];
  assert.equal(Number(product.unit_cost), 130, 'the supplier\'s price today is the best guess');

  // A repeat delivery with the box left empty must not reset the cost to zero.
  await POST(store, '/api/receive',
    { sku, batch_no: unique('B'), expiry: monthsOut(24), qty: 20, unit_cost: '' });
  product = (await GET(admin, `/api/products?q=${sku}`)).data[0];
  assert.equal(Number(product.unit_cost), 130, 'blank means unchanged, not free');

  // And a sale is costed at the new figure.
  const before = (await GET(admin, `/api/finance?${period()}`)).data;
  await POST(till, '/api/till/sell', { lines: [{ sku, qty: 2 }], method: 'cash', tendered: 500 });
  const after = (await GET(admin, `/api/finance?${period()}`)).data;
  assert.equal(Number(after.counter.cost) - Number(before.counter.cost), 260);
});

test('a delivery of something with no cost recorded does not invent one', async () => {
  const admin = await signIn('admin');
  const store = await signIn('warehouse');
  const sku = await newProduct(admin,
    { unit_cost: 0, wholesale_price: 150, srp: 180, retail_price: 200 });

  const before = (await GET(admin, `/api/finance?${period()}`)).data;
  await POST(store, '/api/receive',
    { sku, batch_no: unique('B'), expiry: monthsOut(24), qty: 10 });
  const after = (await GET(admin, `/api/finance?${period()}`)).data;

  assert.equal(Number(after.stock_bought), Number(before.stock_bought),
    'nothing is recorded rather than a zero-peso entry cluttering the books');
});

// ===========================================================================
// PCODE — the price a line was given
//
// The column on the paper invoice has never meant the product's code. The two
// promises worth holding are the ones that decide what a customer is charged:
// a named code prices the line, and a named code with no price behind it stops
// the order rather than quietly charging the wholesale price while printing
// STOCKIST on the document.
// ===========================================================================
test('a price code sets the line price, and one without a price refuses the order', async () => {
  const admin = await signIn('admin');
  const store = await signIn('warehouse');
  const sku = await newProduct(admin, { wholesale_price: 250 });
  await receive(store, sku, 24, 60);
  const reseller = await newReseller(admin);

  // Nothing priced yet: naming a code is refused rather than guessed at.
  const blind = await POST(admin, `/api/resellers/${reseller}/orders`,
    { lines: [{ sku, qty: 2, code: 'STOCKIST' }] });
  assert.equal(blind.status, 400, JSON.stringify(blind.data));
  assert.match(JSON.stringify(blind.data), /price/i);

  // The same order with no code at all still works, the way it did before
  // any of this existed.
  const plain = await POST(admin, `/api/resellers/${reseller}/orders`,
    { lines: [{ sku, qty: 2 }] });
  assert.equal(plain.status, 200, JSON.stringify(plain.data));
  assert.equal(Number(plain.data.invoice.amount), 500, 'two at the wholesale price');

  // Price the base, and the adjusted code that hangs off it follows.
  await POST(admin, `/api/products/${sku}/price`, { code: 'PD', price: 180 });
  await POST(admin, '/api/price-codes/PD-10/adjustment', { adjust: 10 });

  const atBase = await POST(admin, `/api/resellers/${reseller}/orders`,
    { lines: [{ sku, qty: 2, code: 'PD' }] });
  assert.equal(atBase.status, 200, JSON.stringify(atBase.data));
  assert.equal(Number(atBase.data.invoice.amount), 360, 'two at the PD price');

  const adjusted = await POST(admin, `/api/resellers/${reseller}/orders`,
    { lines: [{ sku, qty: 2, code: 'PD-10' }] });
  assert.equal(adjusted.status, 200, JSON.stringify(adjusted.data));
  assert.equal(Number(adjusted.data.invoice.amount), 380, 'PD plus the ten pesos');

  // And the code is on the line afterwards, which is the whole point: the
  // document is printed from the order, not from what somebody remembers.
  const reopened = await GET(admin, `/api/orders/${adjusted.data.orderId}`);
  assert.equal(reopened.data.lines[0].price_code, 'PD-10');
  assert.equal(reopened.data.lines[0].unit_type, 'PCS');
});

// A code that adjusts another one cannot carry a price list of its own —
// otherwise RD+5 drifts away from RD the first time somebody edits one.
test('only a base code carries a price list', async () => {
  const admin = await signIn('admin');
  const sku = await newProduct(admin);
  const nope = await POST(admin, `/api/products/${sku}/price`,
    { code: 'RD+5', price: 100 });
  assert.equal(nope.status, 400, JSON.stringify(nope.data));
  assert.match(JSON.stringify(nope.data), /price list/i);
});

// ===========================================================================
// Who the customer is for tax
//
// Five lines at the top of every document. What matters is that they reach
// the document from the account, and that a reopened order still carries
// them — a customer's registration is exactly the sort of thing later
// disputed, and the answer has to be what the paper said on the day.
// ===========================================================================
test("a reseller's tax details reach the order they are printed from", async () => {
  const admin = await signIn('admin');
  const store = await signIn('warehouse');
  const sku = await newProduct(admin);
  await receive(store, sku, 24, 20);
  const id = await newReseller(admin);

  const saved = await POST(admin, `/api/resellers/${id}/tax`, {
    tax_type: 'Non-VAT', trade_name: '  Lai Sen Beauty  ',
    taxpayer_name: 'Lai Sen', tin: '123-456-789-000',
    business_address: '12 Bayan Bayanan Ave, Marikina',
  });
  assert.equal(saved.status, 200, JSON.stringify(saved.data));

  const back = await GET(admin, `/api/resellers/${id}`);
  assert.equal(back.data.trade_name, 'Lai Sen Beauty', 'stored without the stray spaces');
  assert.equal(back.data.tin, '123-456-789-000', 'the TIN is kept exactly as typed');

  const order = await POST(admin, `/api/resellers/${id}/orders`, { lines: [{ sku, qty: 1 }] });
  assert.equal(order.status, 200, JSON.stringify(order.data));
  const reopened = await GET(admin, `/api/orders/${order.data.orderId}`);
  assert.equal(reopened.data.tax_type, 'Non-VAT');
  assert.equal(reopened.data.taxpayer_name, 'Lai Sen');
  assert.equal(reopened.data.business_address, '12 Bayan Bayanan Ave, Marikina');

  // Blank is a real answer, and clearing means clearing rather than storing
  // an empty string that prints as nothing but is not nothing.
  await POST(admin, `/api/resellers/${id}/tax`, { tax_type: '   ', tin: '' });
  const cleared = await GET(admin, `/api/resellers/${id}`);
  assert.equal(cleared.data.tax_type, null);
  assert.equal(cleared.data.tin, null);
  assert.equal(cleared.data.trade_name, null, 'a field left out of the form is cleared too');
});

// ===========================================================================
// A face on the reseller's card
//
// The order screen finds an account by recognising it. What has to hold is
// that the picture is shrunk on the way in — the lesson that cost this
// company its egress allowance — and that a reseller cannot reach another
// account's.
// ===========================================================================
test("a reseller's picture is shrunk on the way in, not on the way out", async () => {
  const admin = await signIn('admin');
  const id = await newReseller(admin);

  // A deliberately oversized upload: 1400x1400 of noise, well past anything
  // the card asks for.
  const big = await sharp({
    create: { width: 1400, height: 1400, channels: 3, background: { r: 200, g: 140, b: 170 } },
  }).jpeg({ quality: 100 }).toBuffer();

  const up = await POST(admin, `/api/resellers/${id}/photo`,
    { dataUrl: `data:image/jpeg;base64,${big.toString('base64')}` });
  assert.equal(up.status, 200, JSON.stringify(up.data));

  const stored = await db.query(
    'select length(bytes) as size, mime from reseller_photos where reseller_id = $1', [id]);
  assert.equal(stored.rows[0].mime, 'image/jpeg');
  assert.ok(Number(stored.rows[0].size) < big.length / 4,
    `stored ${stored.rows[0].size} bytes against ${big.length} uploaded`);

  const meta = await sharp(stored.rows[0] && (await db.query(
    'select bytes from reseller_photos where reseller_id = $1', [id])).rows[0].bytes).metadata();
  assert.equal(meta.width, 240, 'the frame is round, so a square is what is kept');
  assert.equal(meta.height, 240);

  // The list says there is one, and says when, so the address can be cached.
  const list = await GET(admin, '/api/resellers');
  const mine = list.data.find((r) => String(r.id) === String(id));
  assert.ok(mine.photo_at > 0, 'the card knows there is a picture to draw');

  // A reseller's own portal has no business reading another account's.
  const buyer = await signIn('reseller', await newReseller(admin));
  const peek = await GET(buyer, `/api/resellers/${id}/photo`);
  assert.equal(peek.status, 403, JSON.stringify(peek.data));

  await DELETE(admin, `/api/resellers/${id}/photo`);
  const gone = await db.query('select 1 from reseller_photos where reseller_id = $1', [id]);
  assert.equal(gone.rowCount, 0);
});

// ===========================================================================
// Paying in instalments, and one receipt for the lot
//
// A reseller settles an invoice over several transfers. Confirming records
// each one; issuing the OR is a separate act afterwards. What must hold is
// that confirming puts no number on anything, that one OR covers every
// transfer since the last one, and that nothing is ever receipted twice.
// ===========================================================================
test('four transfers are confirmed separately and receipted once', async () => {
  const admin = await signIn('admin');
  const store = await signIn('warehouse');
  const sku = await newProduct(admin, { wholesale_price: 250 });
  await receive(store, sku, 24, 40);
  const id = await newReseller(admin);

  const order = await POST(admin, `/api/resellers/${id}/orders`, { lines: [{ sku, qty: 4 }] });
  assert.equal(order.status, 200, JSON.stringify(order.data));   // ₱1,000

  // Nothing has been paid, so nothing is waiting for a receipt.
  const idle = await GET(admin, `/api/resellers/${id}/pending-receipt`);
  assert.equal(idle.data.count, 0);
  const early = await POST(admin, `/api/resellers/${id}/issue-or`, {});
  assert.equal(early.status, 400, 'an OR over nothing is refused');

  // Three transfers in one go, a fourth after.
  const first = await POST(admin, `/api/resellers/${id}/confirm`, {
    payments: [
      { amount: 250, method: 'BDO',           reference_no: 'A1' },
      { amount: 250, method: 'BPI',           reference_no: 'B2' },
      { amount: 250, method: 'SECURITY BANK', reference_no: 'C3' },
    ],
  });
  assert.equal(first.status, 200, JSON.stringify(first.data));
  assert.equal(first.data.confirmed.length, 3);
  assert.ok(!JSON.stringify(first.data).includes('OR-'), 'confirming issues no receipt');
  assert.equal(Number(first.data.pending.amount), 750);

  await POST(admin, `/api/resellers/${id}/confirm`, {
    payments: [{ amount: 250, method: 'GCASH', reference_no: 'D4' }],
  });

  const waiting = await GET(admin, `/api/resellers/${id}/pending-receipt`);
  assert.equal(waiting.data.count, 4, 'all four are waiting on one receipt');
  assert.equal(Number(waiting.data.amount), 1000);
  assert.deepEqual(waiting.data.lines.map((l) => l.reference_no), ['A1', 'B2', 'C3', 'D4']);

  const or = await POST(admin, `/api/resellers/${id}/issue-or`, {});
  assert.equal(or.status, 200, JSON.stringify(or.data));
  assert.match(or.data.receipt_no, /^OR-\d{8}-\d{5}$/);
  assert.equal(Number(or.data.amount), 1000, 'one number over the whole thousand');
  assert.equal(or.data.applied.length, 4);

  // And never twice.
  const after = await GET(admin, `/api/resellers/${id}/pending-receipt`);
  assert.equal(after.data.count, 0, 'receipting empties the queue');
  const again = await POST(admin, `/api/resellers/${id}/issue-or`, {});
  assert.equal(again.status, 400, 'there is nothing left to receipt');
});

// The one-step call is still there, and must close off its own payments or
// Issue OR would offer to receipt them a second time.
test('paying and receipting in one step leaves nothing waiting', async () => {
  const admin = await signIn('admin');
  const store = await signIn('warehouse');
  const sku = await newProduct(admin, { wholesale_price: 250 });
  await receive(store, sku, 24, 20);
  const id = await newReseller(admin);
  await POST(admin, `/api/resellers/${id}/orders`, { lines: [{ sku, qty: 2 }] });

  const out = await POST(admin, `/api/resellers/${id}/receipt`, { amount: 500 });
  assert.equal(out.status, 200, JSON.stringify(out.data));
  assert.match(out.data.receipt_no, /^OR-/);

  const waiting = await GET(admin, `/api/resellers/${id}/pending-receipt`);
  assert.equal(waiting.data.count, 0, 'the one-step call receipts what it takes');
});
