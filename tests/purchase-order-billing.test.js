// Billing — the supplier's own invoice against the order it is for.
//
// Three facts that can each be right without agreeing: what the order asked
// for, what actually arrived, and what the supplier says is owed. This checks
// the third one gets its own row, is reachable only by the people who already
// buy for the shop, and that a payment recorded against a bill settles the
// bill and nothing else — the balance is the ledger's own, the same shape
// advances and loans already keep theirs in.
import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { hashPassword } from '../lib/auth.js';
import { server } from '../scripts/dev.js';
import { pool } from '../lib/db.js';

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

let seq = 0;
const unique = (prefix) => `${prefix}-${process.pid}-${Date.now()}-${++seq}`;

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

async function signIn(role) {
  const username = unique(role);
  await db.query(
    `insert into app_users (username, display_name, password_hash, role)
     values ($1,$1,$2,$3)`, [username, hashPassword('secret123'), role]);
  const res = await fetch(`${base}/api/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password: 'secret123' }) });
  assert.equal(res.status, 200, `could not sign in as ${role}`);
  const raw = res.headers.getSetCookie?.()[0] ?? res.headers.get('set-cookie');
  return Object.assign(raw.split(';')[0], { username });
}

async function newProduct(admin) {
  const sku = unique('SKU');
  const r = await POST(admin, '/api/products', {
    sku, name: `Test ${sku}`, brand: 'Beau Glow', category: 'Serums',
    unit_cost: 100, wholesale_price: 250, srp: 400, retail_price: 450,
    shelf_life_months: 24,
  });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  return sku;
}

async function newPO(admin) {
  const sku = await newProduct(admin);
  const sup = await POST(admin, '/api/suppliers', { name: unique('Maker') });
  assert.equal(sup.status, 200, JSON.stringify(sup.data));
  const po = await POST(admin, '/api/purchase-orders', {
    supplier_id: sup.data.id, lines: [{ sku, qty: 10, unit: 'PCS' }],
  });
  assert.equal(po.status, 200, JSON.stringify(po.data));
  return po.data;
}

const findBill = (list, id) => list.find((b) => String(b.id) === String(id));

// ---------------------------------------------------------------------------
// The ordinary run: raise a bill, read it back, pay it down, pay it off
// ---------------------------------------------------------------------------
test('a bill is raised against an order and read back with it', async () => {
  const admin = await signIn('admin');
  const po = await newPO(admin);

  const made = await POST(admin, '/api/purchase-order-bills', {
    po_id: po.id, invoice_no: 'INV-4471', invoice_date: '2026-08-01',
    amount: 9600, due_date: '2026-09-01', note: 'net 30',
  });
  assert.equal(made.status, 200, JSON.stringify(made.data));

  const list = await GET(admin, '/api/purchase-order-bills');
  assert.equal(list.status, 200);
  const bill = findBill(list.data, made.data.id);
  assert.ok(bill, 'the bill is on the list');
  assert.equal(bill.po_no, po.po_no, 'carrying the order it answers');
  assert.equal(bill.invoice_no, 'INV-4471');
  assert.equal(Number(bill.amount), 9600);
  // pg hands a date column back as midnight UTC, which JSON turns into a full
  // timestamp — the day itself is the first ten characters.
  assert.equal(String(bill.due_date).slice(0, 10), '2026-09-01');
  assert.equal(Number(bill.paid), 0, 'nothing paid yet');
  assert.equal(Number(bill.balance), 9600, 'the whole amount is still owed');
});

test('a payment reduces the balance, and paying it off settles the bill, not the order', async () => {
  const admin = await signIn('admin');
  const po = await newPO(admin);
  const made = await POST(admin, '/api/purchase-order-bills',
    { po_id: po.id, amount: 500 });

  const part = await POST(admin, `/api/purchase-order-bills/${made.data.id}/payments`,
    { amount: 200 });
  assert.equal(part.status, 200, JSON.stringify(part.data));
  assert.equal(Number(part.data.balance), 300);

  const midway = findBill((await GET(admin, '/api/purchase-order-bills')).data, made.data.id);
  assert.equal(Number(midway.paid), 200);
  assert.equal(Number(midway.balance), 300, 'part paid, not settled');

  const order = await GET(admin, `/api/purchase-orders/${po.id}`);
  assert.equal(order.data.status, 'open', 'the order itself does not move');

  const rest = await POST(admin, `/api/purchase-order-bills/${made.data.id}/payments`,
    { amount: 300 });
  assert.equal(rest.status, 200, JSON.stringify(rest.data));
  assert.equal(Number(rest.data.balance), 0);

  const settled = findBill((await GET(admin, '/api/purchase-order-bills')).data, made.data.id);
  assert.equal(Number(settled.balance), 0, 'fully paid now');
});

test('a payment cannot take a bill past what is still owed', async () => {
  const admin = await signIn('admin');
  const po = await newPO(admin);
  const made = await POST(admin, '/api/purchase-order-bills', { po_id: po.id, amount: 100 });

  const over = await POST(admin, `/api/purchase-order-bills/${made.data.id}/payments`,
    { amount: 150 });
  assert.equal(over.status, 400, JSON.stringify(over.data));

  const still = findBill((await GET(admin, '/api/purchase-order-bills')).data, made.data.id);
  assert.equal(Number(still.balance), 100, 'the refused payment left nothing recorded');
});

test('a payment can be undone', async () => {
  const admin = await signIn('admin');
  const po = await newPO(admin);
  const made = await POST(admin, '/api/purchase-order-bills', { po_id: po.id, amount: 400 });
  const paid = await POST(admin, `/api/purchase-order-bills/${made.data.id}/payments`,
    { amount: 400 });
  assert.equal(paid.status, 200);

  const list = await GET(admin, '/api/purchase-order-bills');
  const settled = findBill(list.data, made.data.id);
  assert.equal(Number(settled.balance), 0);

  // record_bill_payment returns the balance, not the payment's own id, and
  // there is no list-payments route — read it back off the table directly.
  const row = await db.query(
    'select id from purchase_order_bill_payments where bill_id = $1', [made.data.id]);
  assert.equal(row.rows.length, 1);

  const undone = await DELETE(admin, `/api/purchase-order-bill-payments/${row.rows[0].id}`);
  assert.equal(undone.status, 200, JSON.stringify(undone.data));

  const again = findBill((await GET(admin, '/api/purchase-order-bills')).data, made.data.id);
  assert.equal(Number(again.balance), 400, 'owed again once the payment is undone');
});

test('a bill can be edited and removed', async () => {
  const admin = await signIn('admin');
  const po = await newPO(admin);
  const made = await POST(admin, '/api/purchase-order-bills',
    { po_id: po.id, invoice_no: 'INV-1', amount: 100 });

  const edited = await PUT(admin, `/api/purchase-order-bills/${made.data.id}`,
    { po_id: po.id, invoice_no: 'INV-1-REV', amount: 150 });
  assert.equal(edited.status, 200, JSON.stringify(edited.data));
  const mid = findBill((await GET(admin, '/api/purchase-order-bills')).data, made.data.id);
  assert.equal(mid.invoice_no, 'INV-1-REV');
  assert.equal(Number(mid.amount), 150);

  const dropped = await DELETE(admin, `/api/purchase-order-bills/${made.data.id}`);
  assert.equal(dropped.status, 200, JSON.stringify(dropped.data));
  const gone = findBill((await GET(admin, '/api/purchase-order-bills')).data, made.data.id);
  assert.equal(gone, undefined, 'really gone');
});

test('a bill with a payment against it cannot be removed until the payment is undone', async () => {
  const admin = await signIn('admin');
  const po = await newPO(admin);
  const made = await POST(admin, '/api/purchase-order-bills', { po_id: po.id, amount: 200 });
  await POST(admin, `/api/purchase-order-bills/${made.data.id}/payments`, { amount: 50 });

  const blocked = await DELETE(admin, `/api/purchase-order-bills/${made.data.id}`);
  assert.equal(blocked.status, 409, JSON.stringify(blocked.data));

  const row = await db.query(
    'select id from purchase_order_bill_payments where bill_id = $1', [made.data.id]);
  await DELETE(admin, `/api/purchase-order-bill-payments/${row.rows[0].id}`);

  const now = await DELETE(admin, `/api/purchase-order-bills/${made.data.id}`);
  assert.equal(now.status, 200, JSON.stringify(now.data));
});

// ---------------------------------------------------------------------------
// What it refuses
// ---------------------------------------------------------------------------
test('an invoice needs a real order and a real amount', async () => {
  const admin = await signIn('admin');
  const po = await newPO(admin);

  const noAmount = await POST(admin, '/api/purchase-order-bills', { po_id: po.id, amount: 0 });
  assert.equal(noAmount.status, 400, JSON.stringify(noAmount.data));

  const badPO = await POST(admin, '/api/purchase-order-bills', { po_id: 999999999, amount: 100 });
  assert.equal(badPO.status, 400, JSON.stringify(badPO.data));
});

test('buying is the stockroom’s business, not a reseller’s — billing is too', async () => {
  const admin = await signIn('admin');
  const po = await newPO(admin);
  const made = await POST(admin, '/api/purchase-order-bills', { po_id: po.id, amount: 100 });

  for (const role of ['cashier', 'employee', 'observer']) {
    const nosey = await signIn(role);
    assert.equal((await GET(nosey, '/api/purchase-order-bills')).status, 403, `${role} read the bills`);
    assert.equal((await POST(nosey, '/api/purchase-order-bills',
      { po_id: po.id, amount: 100 })).status, 403, `${role} raised a bill`);
    assert.equal((await POST(nosey, `/api/purchase-order-bills/${made.data.id}/payments`,
      { amount: 100 })).status, 403, `${role} recorded a payment`);
    assert.equal((await DELETE(nosey, `/api/purchase-order-bills/${made.data.id}`)).status,
      403, `${role} removed one`);
  }
});

// A data coordinator reaches the route (STOCK) but the row policy on the
// table does not name them, so what comes back is nothing rather than a
// refusal — the same shape as every other buying table.
test('a data coordinator reads no bills — the row policy does not know them', async () => {
  const admin = await signIn('admin');
  const coord = await signIn('datacoord');
  const po = await newPO(admin);
  await POST(admin, '/api/purchase-order-bills', { po_id: po.id, amount: 100 });

  const seen = await GET(coord, '/api/purchase-order-bills');
  assert.equal(seen.status, 200);
  assert.deepEqual(seen.data, [], 'the route lets them in; the row policy leaves them nothing');
});

// require_role treats 'warehouse' in the allowed set as standing permission
// for supervisor too, the same as raising the order itself does.
test('a supervisor holds the pen on billing, the same as on the order', async () => {
  const admin = await signIn('admin');
  const boss = await signIn('supervisor');
  const po = await newPO(admin);
  const made = await POST(boss, '/api/purchase-order-bills', { po_id: po.id, amount: 100 });
  assert.equal(made.status, 200, JSON.stringify(made.data));
});

// ---------------------------------------------------------------------------
// The order's own list carries the billing state, not just the delivery one
// ---------------------------------------------------------------------------
// The Purchase order list once said "open" or "all in" — how much had arrived,
// nothing about what was owed. The office reads it to know what still needs
// paying, so the same list now carries how many bills are on file and how
// many of those are settled, the two figures the paid / unpaid / paid w/ bal
// tag on screen is worked out from.
test('the order list carries how much of what is billed is paid', async () => {
  const admin = await signIn('admin');
  const po = await newPO(admin);

  const bare = (await GET(admin, '/api/purchase-orders')).data
    .find((o) => String(o.id) === String(po.id));
  assert.equal(bare.bills, 0, 'nothing billed yet');
  assert.equal(bare.bills_paid, 0);

  const one = await POST(admin, '/api/purchase-order-bills', { po_id: po.id, amount: 100 });
  const two = await POST(admin, '/api/purchase-order-bills', { po_id: po.id, amount: 50 });

  const some = (await GET(admin, '/api/purchase-orders')).data
    .find((o) => String(o.id) === String(po.id));
  assert.equal(some.bills, 2, 'both bills counted');
  assert.equal(some.bills_paid, 0, 'neither settled yet');

  await POST(admin, `/api/purchase-order-bills/${one.data.id}/payments`, { amount: 100 });
  const partway = (await GET(admin, '/api/purchase-orders')).data
    .find((o) => String(o.id) === String(po.id));
  assert.equal(partway.bills, 2);
  assert.equal(partway.bills_paid, 1, 'one of the two');

  await POST(admin, `/api/purchase-order-bills/${two.data.id}/payments`, { amount: 50 });
  const settled = (await GET(admin, '/api/purchase-orders')).data
    .find((o) => String(o.id) === String(po.id));
  assert.equal(settled.bills, 2);
  assert.equal(settled.bills_paid, 2, 'both, now');
});
