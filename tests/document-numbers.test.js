// CO26_08_001, SI26_08_001, PL26_08_001.
//
// A reseller order used to be known by its database id, and all three of its
// documents shared it: the customer order, the invoice and the packing list
// were each "#123". So "did you get 123?" in a chat window had three answers,
// and the number itself said nothing about when the order was placed.
//
// Each document now carries its own, in the shape the purchase orders already
// use — prefix, year, month, and a count that restarts monthly.
//
// The numbers are stamped by a trigger rather than by the function that places
// an order, because there are five of those across five migrations, each a
// replacement of the last. This checks the numbers arrive through the ordinary
// route a person uses, so a sixth pricing rewrite cannot quietly drop them.
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

async function newReseller(admin) {
  const { data } = await POST(admin, '/api/resellers',
    { name: unique('Reseller'), email: 'buyer@example.ph', tier: 2,
      credit_limit: 1_000_000, terms_days: 30 });
  await POST(admin, `/api/resellers/${data.id}/approve`);
  return data.id;
}

// The month a number belongs to is Manila's, which is what the trigger uses.
const stamp = () => {
  const now = new Date().toLocaleDateString('en-CA',
    { timeZone: 'Asia/Manila', year: '2-digit', month: '2-digit', day: '2-digit' });
  const [yy, mm] = now.split('-');
  return `${yy}_${mm}_`;
};

const numbers = async (orderId) => (await db.query(
  `select o.co_no, o.pl_no, i.si_no
     from orders o left join invoices i on i.order_id = o.id
    where o.id = $1`, [orderId])).rows[0];

test('a reseller order is stamped with all three document numbers', async () => {
  const admin = await signIn('admin');
  const store = await signIn('warehouse');
  const sku = await newProduct(admin);
  await POST(store, '/api/receive',
    { sku, batch_no: unique('B'), expiry: monthsOut(24), qty: 50 });
  const seller = await newReseller(admin);

  const order = await POST(admin, `/api/resellers/${seller}/orders`, { lines: [{ sku, qty: 2 }] });
  assert.equal(order.status, 200, JSON.stringify(order.data));

  const n = await numbers(order.data.orderId);
  const on = stamp();
  assert.match(n.co_no, new RegExp(`^CO${on}\\d{3}$`), `customer order number was ${n.co_no}`);
  assert.match(n.pl_no, new RegExp(`^PL${on}\\d{3}$`), `packing list number was ${n.pl_no}`);
  assert.match(n.si_no, new RegExp(`^SI${on}\\d{3}$`), `sales invoice number was ${n.si_no}`);

  // Three documents, three numbers. Sharing one is the thing this replaced.
  assert.notEqual(n.co_no, n.pl_no);
  assert.notEqual(n.co_no, n.si_no);
});

test('the count goes up, and each document counts for itself', async () => {
  const admin = await signIn('admin');
  const store = await signIn('warehouse');
  const sku = await newProduct(admin);
  await POST(store, '/api/receive',
    { sku, batch_no: unique('B'), expiry: monthsOut(24), qty: 80 });
  const seller = await newReseller(admin);

  const first = await POST(admin, `/api/resellers/${seller}/orders`, { lines: [{ sku, qty: 1 }] });
  const then = await POST(admin, `/api/resellers/${seller}/orders`, { lines: [{ sku, qty: 1 }] });
  assert.equal(then.status, 200, JSON.stringify(then.data));

  const a = await numbers(first.data.orderId);
  const b = await numbers(then.data.orderId);
  const tail = (s) => Number(s.slice(-3));
  assert.equal(tail(b.co_no), tail(a.co_no) + 1, 'the customer order count moves on by one');
  assert.equal(tail(b.pl_no), tail(a.pl_no) + 1, 'and so does the packing list');
  assert.equal(tail(b.si_no), tail(a.si_no) + 1, 'and the invoice');
});

test('a counter sale gets no customer order number', async () => {
  const admin = await signIn('admin');
  const store = await signIn('warehouse');
  const till = await signIn('cashier');
  const sku = await newProduct(admin);
  await POST(store, '/api/receive',
    { sku, batch_no: unique('B'), expiry: monthsOut(24), qty: 20 });

  const sale = await POST(till, '/api/till/sell',
    { lines: [{ sku, qty: 1 }], method: 'cash', tendered: 1000 });
  assert.equal(sale.status, 200, JSON.stringify(sale.data));

  const r = await db.query('select co_no, pl_no from orders where id = $1',
    [sale.data.order_id]);
  assert.equal(r.rows[0].co_no, null,
    'somebody buying over the counter has not placed a customer order');
  assert.equal(r.rows[0].pl_no, null, 'and nobody packs it — they walk out with it');
});

test('two orders raised at once cannot take the same number', async () => {
  const admin = await signIn('admin');
  const store = await signIn('warehouse');
  const sku = await newProduct(admin);
  await POST(store, '/api/receive',
    { sku, batch_no: unique('B'), expiry: monthsOut(24), qty: 200 });
  const seller = await newReseller(admin);

  // The advisory lock is what makes this safe; the unique index is only the
  // backstop. Six at once is what a busy afternoon looks like.
  const raised = await Promise.all(Array.from({ length: 6 }, () =>
    POST(admin, `/api/resellers/${seller}/orders`, { lines: [{ sku, qty: 1 }] })));
  assert.ok(raised.every((r) => r.status === 200),
    `not all six were accepted: ${JSON.stringify(raised.map((r) => r.data))}`);

  const all = await Promise.all(raised.map((r) => numbers(r.data.orderId)));
  const cos = all.map((n) => n.co_no);
  assert.equal(new Set(cos).size, 6, `six orders produced ${new Set(cos).size} numbers: ${cos}`);
  const sis = all.map((n) => n.si_no);
  assert.equal(new Set(sis).size, 6, `six invoices produced ${new Set(sis).size} numbers: ${sis}`);
});

// ---------------------------------------------------------------------------
// A number the office can write
//
// The counter is right for the ordinary case and wrong for the ones that
// matter: an invoice raised against a BIR booklet whose printed number has to
// be the one on the sheet, or a gap in a series that has to be filled by hand.
// Neither can be reached by cancelling and re-raising, because a counter only
// ever goes forwards.
// ---------------------------------------------------------------------------
async function anOrder(admin, store) {
  const sku = await newProduct(admin);
  await POST(store, '/api/receive',
    { sku, batch_no: unique('B'), expiry: monthsOut(24), qty: 50 });
  const seller = await newReseller(admin);
  const order = await POST(admin, `/api/resellers/${seller}/orders`, { lines: [{ sku, qty: 1 }] });
  assert.equal(order.status, 200, JSON.stringify(order.data));
  return order.data.orderId;
}

test('the invoice number can be written rather than handed out', async () => {
  const admin = await signIn('admin');
  const store = await signIn('warehouse');
  const id = await anOrder(admin, store);

  const mine = `BIR-${unique('X')}`;
  const out = await POST(admin, `/api/orders/${id}/invoice-no`, { si_no: `  ${mine.toLowerCase()} ` });
  assert.equal(out.status, 200, JSON.stringify(out.data));
  assert.equal(out.data.si_no, mine.toUpperCase(),
    'trimmed and in capitals, the way every other number on the paper is written');
  assert.equal((await numbers(id)).si_no, mine.toUpperCase());
});

test('the counter carries on from what was written', async () => {
  const admin = await signIn('admin');
  const store = await signIn('warehouse');
  const first = await anOrder(admin, store);

  // Well above anything the counter has reached this month.
  const high = `SI${stamp()}900`;
  const set = await POST(admin, `/api/orders/${first}/invoice-no`, { si_no: high });
  assert.equal(set.status, 200, JSON.stringify(set.data));

  const next = await anOrder(admin, store);
  assert.equal((await numbers(next)).si_no, `SI${stamp()}901`,
    'the counter reads the highest number in the month, so nothing has to be told');
});

test('two invoices cannot be made to share one number', async () => {
  const admin = await signIn('admin');
  const store = await signIn('warehouse');
  const one = await anOrder(admin, store);
  const two = await anOrder(admin, store);

  const taken = (await numbers(one)).si_no;
  const clash = await POST(admin, `/api/orders/${two}/invoice-no`, { si_no: taken });
  assert.equal(clash.status, 400, JSON.stringify(clash.data));
  assert.match(clash.data.error, /already on another invoice/);
  assert.notEqual((await numbers(two)).si_no, taken,
    'the one that lost keeps the number it had');
});

test('an invoice cannot be left with no number at all', async () => {
  const admin = await signIn('admin');
  const store = await signIn('warehouse');
  const id = await anOrder(admin, store);
  const was = (await numbers(id)).si_no;

  const blank = await POST(admin, `/api/orders/${id}/invoice-no`, { si_no: '   ' });
  assert.equal(blank.status, 400, JSON.stringify(blank.data));
  assert.equal((await numbers(id)).si_no, was);
});

test('the warehouse floor cannot renumber an invoice', async () => {
  const admin = await signIn('admin');
  const store = await signIn('warehouse');
  const id = await anOrder(admin, store);

  const nope = await POST(store, `/api/orders/${id}/invoice-no`, { si_no: 'SI-MINE-1' });
  assert.equal(nope.status, 403, JSON.stringify(nope.data));
});

test('the invoice number is written where the order is worked on', () => {
  const app = fs.readFileSync(path.join(here, '..', 'public/app.js'), 'utf8');
  const party = app.slice(app.indexOf('const docParty ='), app.indexOf('const docLines ='));
  assert.match(party, /numberTyped\s*\?/,
    'the number line is a box when the sheet says so, plain text when it does not');

  // The invoice is a document, so its number moved to the order rather than
  // going: all three of an order's numbers are written in one place.
  const doc = app.slice(app.indexOf('function showInvoiceDoc'),
                        app.indexOf('function showPackingList'));
  assert.doesNotMatch(doc, /data-docno/, 'the invoice does not carry a box for it');

  const fn = app.slice(app.indexOf('async function openOrder'),
                       app.indexOf('// A document as a file'));
  assert.match(fn, /id="on_si"/, 'the order dialog does');
  assert.match(fn, /o\.si_no \?/,
    'and only once an invoice has been raised, there being nothing to renumber before');
  assert.match(fn, /\/invoice-no`, \{ si_no: si \}\)/,
    'through the one call that moves an invoice number');

  // The order's own pair go first: a clash on the invoice number must not lose
  // a customer order number that was corrected in the same breath.
  const save = fn.slice(fn.indexOf("$('#on_keep')"));
  assert.ok(save.indexOf('/numbers`') < save.indexOf('/invoice-no`'),
    'the pair that belong to the order are settled before the one that does not');
});

// ---------------------------------------------------------------------------
// The other two numbers, for the same reasons
//
// A reseller holding CO26_08_012 in a chat window is holding the only copy of
// it, and the customer order form is handed over once and never reopened.
// ---------------------------------------------------------------------------
test('the order and packing list numbers can be written too', async () => {
  const admin = await signIn('admin');
  const store = await signIn('warehouse');
  const id = await anOrder(admin, store);

  const co = `CO-${unique('A')}`;
  const pl = `PL-${unique('B')}`;
  const out = await POST(admin, `/api/orders/${id}/numbers`,
    { co_no: co.toLowerCase(), pl_no: `  ${pl}  ` });
  assert.equal(out.status, 200, JSON.stringify(out.data));

  const n = await numbers(id);
  assert.equal(n.co_no, co.toUpperCase());
  assert.equal(n.pl_no, pl.toUpperCase());
  assert.match(n.si_no, /^SI/, 'the invoice keeps the number it was handed');
});

test('one of the two can be moved without touching the other', async () => {
  const admin = await signIn('admin');
  const store = await signIn('warehouse');
  const id = await anOrder(admin, store);
  const before = await numbers(id);

  await POST(admin, `/api/orders/${id}/numbers`, { pl_no: `PL-${unique('C')}` });
  const after = await numbers(id);
  assert.equal(after.co_no, before.co_no,
    'a number not named is a number left where it was');
  assert.notEqual(after.pl_no, before.pl_no);
});

test('the counters carry on from what was written', async () => {
  const admin = await signIn('admin');
  const store = await signIn('warehouse');
  const first = await anOrder(admin, store);
  const on = stamp();

  await POST(admin, `/api/orders/${first}/numbers`,
    { co_no: `CO${on}800`, pl_no: `PL${on}700` });

  const next = await anOrder(admin, store);
  const n = await numbers(next);
  assert.equal(n.co_no, `CO${on}801`);
  assert.equal(n.pl_no, `PL${on}701`,
    'each document counts for itself, from whatever it was last set to');
});

test('two orders cannot be made to share a number, and it says which', async () => {
  const admin = await signIn('admin');
  const store = await signIn('warehouse');
  const one = await anOrder(admin, store);
  const two = await anOrder(admin, store);
  const taken = await numbers(one);
  const was = await numbers(two);

  const clash = await POST(admin, `/api/orders/${two}/numbers`, { co_no: taken.co_no });
  assert.equal(clash.status, 400, JSON.stringify(clash.data));
  assert.match(clash.data.error, /already on another customer order/);
  assert.equal((await numbers(two)).co_no, was.co_no,
    'the one that lost keeps the number it had');

  const clashPl = await POST(admin, `/api/orders/${two}/numbers`, { pl_no: taken.pl_no });
  assert.equal(clashPl.status, 400, JSON.stringify(clashPl.data));
  assert.match(clashPl.data.error, /already on another packing list/);
});

test('a number can be replaced but not rubbed out', async () => {
  const admin = await signIn('admin');
  const store = await signIn('warehouse');
  const id = await anOrder(admin, store);
  const was = await numbers(id);

  const blank = await POST(admin, `/api/orders/${id}/numbers`, { co_no: '  ' });
  assert.equal(blank.status, 400, JSON.stringify(blank.data));
  assert.equal((await numbers(id)).co_no, was.co_no);
});

test('a counter sale has a receipt, not a customer order', async () => {
  const admin = await signIn('admin');
  const store = await signIn('warehouse');
  const sku = await newProduct(admin);
  await POST(store, '/api/receive',
    { sku, batch_no: unique('B'), expiry: monthsOut(24), qty: 10 });
  const sale = await POST(admin, '/api/till/sell',
    { lines: [{ sku, qty: 1 }], method: 'cash', tendered: 10_000 });
  assert.equal(sale.status, 200, JSON.stringify(sale.data));

  const nope = await POST(admin, `/api/orders/${sale.data.order_id}/numbers`,
    { co_no: `CO-${unique('D')}` });
  assert.equal(nope.status, 400, JSON.stringify(nope.data));
  assert.match(nope.data.error, /receipt/);
});

test('the warehouse floor cannot renumber an order', async () => {
  const admin = await signIn('admin');
  const store = await signIn('warehouse');
  const id = await anOrder(admin, store);

  const nope = await POST(store, `/api/orders/${id}/numbers`, { co_no: 'CO-MINE-1' });
  assert.equal(nope.status, 403, JSON.stringify(nope.data));
});

test('both of the order numbers are boxes where the order itself is opened', () => {
  const app = fs.readFileSync(path.join(here, '..', 'public/app.js'), 'utf8');
  const fn = app.slice(app.indexOf('async function openOrder'),
                       app.indexOf('\n// ---', app.indexOf('async function openOrder')));
  assert.match(fn, /id="on_co"/, 'the customer order number, which no document reopens');
  assert.match(fn, /id="on_pl"/, 'and the packing list number beside it');
  assert.match(fn, /o\.channel === 'b2b'/, 'never on a counter sale');

});

// The order form is shown once, straight after the order is placed, and goes
// into the chat window from there. So the number on it is the number the
// reseller will hold, and correcting it has to be possible on the sheet
// itself rather than on a screen they will never see.
test('the order form corrects its own number before it is sent', () => {
  const app = fs.readFileSync(path.join(here, '..', 'public/app.js'), 'utf8');
  const show = app.slice(app.indexOf('function showInvoice('),
                         app.indexOf('function showInvoiceDoc'));
  assert.match(show, /id="inv_keep"/, 'a form that has just been raised can be renumbered');
  assert.match(show, /\/numbers`, \{ co_no: said\(\) \}\)/,
    'through the one call that moves an order number');
  assert.match(show, /box\.value = out\.co_no;/,
    'and the sheet redraws with it, because the picture is about to be sent');
  assert.doesNotMatch(show, /closeDialog\(\);\s*\n\s*opts\.onSaved/,
    'without closing the document somebody is still reading');

  const form = app.slice(app.indexOf('function customerOrderForm'),
                         app.indexOf('function showInvoice('));
  assert.match(form, /canEdit && !!orderNo/,
    'the basket preview draws this same sheet before anything is placed, and '
    + 'there is no number there yet to correct');
});
