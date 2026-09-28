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

// Shop and wholesale sell off the same shelf, so a plain receipt is enough
// to place a reseller order — kept as its own name for what these tests use
// it for.
async function receiveForResale(who, sku, months, qty) {
  const r = await POST(who, '/api/receive',
    { sku, batch_no: unique('B'), expiry: monthsOut(months), qty });
  return r;
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
  await receiveForResale(store, sku, 24, 50);
  const seller = await newReseller(admin);

  const order = await POST(admin, `/api/resellers/${seller}/orders`, { lines: [{ sku, qty: 2 }] });
  assert.equal(order.status, 200, JSON.stringify(order.data));
  // CO and PL are stamped the moment the order lands; SI only once Invoice
  // is pressed.
  await POST(admin, `/api/orders/${order.data.orderId}/commit`);

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
  await receiveForResale(store, sku, 24, 80);
  const seller = await newReseller(admin);

  const first = await POST(admin, `/api/resellers/${seller}/orders`, { lines: [{ sku, qty: 1 }] });
  const then = await POST(admin, `/api/resellers/${seller}/orders`, { lines: [{ sku, qty: 1 }] });
  assert.equal(then.status, 200, JSON.stringify(then.data));
  await POST(admin, `/api/orders/${first.data.orderId}/commit`);
  await POST(admin, `/api/orders/${then.data.orderId}/commit`);

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
  await receiveForResale(store, sku, 24, 200);
  const seller = await newReseller(admin);

  // The advisory lock is what makes this safe; the unique index is only the
  // backstop. Six at once is what a busy afternoon looks like.
  const raised = await Promise.all(Array.from({ length: 6 }, () =>
    POST(admin, `/api/resellers/${seller}/orders`, { lines: [{ sku, qty: 1 }] })));
  assert.ok(raised.every((r) => r.status === 200),
    `not all six were accepted: ${JSON.stringify(raised.map((r) => r.data))}`);

  // SI is only stamped once Invoice is pressed — six presses at once is the
  // same rush this test is actually about.
  const committed = await Promise.all(raised.map((r) =>
    POST(admin, `/api/orders/${r.data.orderId}/commit`)));
  assert.ok(committed.every((r) => r.status === 200),
    `not all six committed: ${JSON.stringify(committed.map((r) => r.data))}`);

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
  await receiveForResale(store, sku, 24, 50);
  const seller = await newReseller(admin);
  const order = await POST(admin, `/api/resellers/${seller}/orders`, { lines: [{ sku, qty: 1 }] });
  assert.equal(order.status, 200, JSON.stringify(order.data));
  // Placing no longer raises the invoice — Invoice no. is only stamped once
  // Invoice is pressed, so this helper presses it: every test below still
  // gets a real si_no to write against, the same as CO and PL already had.
  await POST(admin, `/api/orders/${order.data.orderId}/commit`);
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

// Pressing Invoice again is not asking for a second invoice — raise_invoice
// already no-ops once one exists — but it is asking for this one to be read
// last. Whoever is pressed last takes the newest number; everything that
// sat above its old spot closes the gap behind it.
test('pressing Invoice again moves that invoice to the newest number', async () => {
  const admin = await signIn('admin');
  const store = await signIn('warehouse');
  const first = await anOrder(admin, store);
  const second = await anOrder(admin, store);
  const third = await anOrder(admin, store);

  const before = {
    first: (await numbers(first)).si_no,
    second: (await numbers(second)).si_no,
    third: (await numbers(third)).si_no,
  };
  const tail = (s) => Number(s.slice(-3));
  assert.equal(tail(before.second), tail(before.first) + 1);
  assert.equal(tail(before.third), tail(before.first) + 2);

  // Pressed again — the same order, nothing new placed.
  const pressed = await POST(admin, `/api/orders/${first}/commit`);
  assert.equal(pressed.status, 200, JSON.stringify(pressed.data));

  const after = {
    first: (await numbers(first)).si_no,
    second: (await numbers(second)).si_no,
    third: (await numbers(third)).si_no,
  };
  assert.equal(after.first, before.third, 'the one pressed last now carries the newest number');
  assert.equal(tail(after.second), tail(before.second) - 1, 'closed up by one behind it');
  assert.equal(tail(after.third), tail(before.third) - 1, 'closed up by one behind it');
});

// A number written by hand caps nothing. Pressing Invoice still sends the
// pressed order to the newest number there is — built past the written one,
// never onto or above it by reuse — the same "whoever is pressed last wins"
// rule as when nothing has been written by hand at all.
test('pressing Invoice climbs past a written number, not up to it', async () => {
  const admin = await signIn('admin');
  const store = await signIn('warehouse');
  const first = await anOrder(admin, store);
  const second = await anOrder(admin, store);

  const tail = (s) => Number(s.slice(-3));
  // One past whatever the counter currently reads — free, since second was
  // the last thing it handed out.
  const written = tail((await numbers(second)).si_no) + 1;
  const mine = `SI${stamp()}${String(written).padStart(3, '0')}`;
  const set = await POST(admin, `/api/orders/${second}/invoice-no`, { si_no: mine });
  assert.equal(set.status, 200, JSON.stringify(set.data));

  const pressed = await POST(admin, `/api/orders/${first}/commit`);
  assert.equal(pressed.status, 200, JSON.stringify(pressed.data));

  const after = (await numbers(first)).si_no;
  assert.equal(tail(after), written + 1,
    'built one past the written number, not reused up to it');
  assert.equal((await numbers(second)).si_no, mine, 'the written number itself never moved');
});

// Once one order has climbed past a written number, it is sitting right
// above it — so the next order to close its own gap past that one has to
// step around the written slot rather than land on it.
test('closing a later gap steps around a written number in its way', async () => {
  const admin = await signIn('admin');
  const store = await signIn('warehouse');
  const first = await anOrder(admin, store);
  const second = await anOrder(admin, store);
  const third = await anOrder(admin, store);

  const tail = (s) => Number(s.slice(-3));
  // One past whatever the counter currently reads — free, since third was
  // the last thing it handed out.
  const written = tail((await numbers(third)).si_no) + 1;
  const mine = `SI${stamp()}${String(written).padStart(3, '0')}`;
  const set = await POST(admin, `/api/orders/${third}/invoice-no`, { si_no: mine });
  assert.equal(set.status, 200, JSON.stringify(set.data));

  // first climbs past the written number — the newest there is, for now.
  await POST(admin, `/api/orders/${first}/commit`);
  const firstAfterFirstPress = tail((await numbers(first)).si_no);
  assert.equal(firstAfterFirstPress, written + 1);

  // second closes its own gap, and the only thing above its old spot now
  // is first, sitting one slot above the written number — reassigning it
  // one lower would collide with the written slot outright.
  const pressed = await POST(admin, `/api/orders/${second}/commit`);
  assert.equal(pressed.status, 200, JSON.stringify(pressed.data));

  assert.equal((await numbers(third)).si_no, mine, 'the written number stayed put throughout');
  assert.equal(tail((await numbers(second)).si_no), firstAfterFirstPress,
    'the one pressed last now carries the newest number');
  const firstNow = tail((await numbers(first)).si_no);
  assert.notEqual(firstNow, written, 'stepped around the written slot instead of landing on it');
  assert.equal(firstNow, written - 1, 'and closed up right behind it');
});

// A number written by hand is a promise about a piece of paper already
// printed. Pressing Invoice again on that order must never move it, and
// must never ask anything else to make room for it either — there is
// nothing to make room for, since it never had a slot in the automatic
// count to begin with.
test('a written number stays put even when Invoice is pressed again', async () => {
  const admin = await signIn('admin');
  const store = await signIn('warehouse');
  const first = await anOrder(admin, store);
  const second = await anOrder(admin, store);

  const mine = `BIR-${unique('X')}`;
  const written = await POST(admin, `/api/orders/${first}/invoice-no`, { si_no: mine });
  assert.equal(written.status, 200, JSON.stringify(written.data));

  const secondBefore = (await numbers(second)).si_no;

  const pressed = await POST(admin, `/api/orders/${first}/commit`);
  assert.equal(pressed.status, 200, JSON.stringify(pressed.data));

  assert.equal((await numbers(first)).si_no, mine, 'the written number never moves');
  assert.equal((await numbers(second)).si_no, secondBefore,
    'and nothing else moves to make room for it either');
});

// The date is the other half of the same story a moved number already
// tells — a number that jumped to the newest slot but a date still
// reading a week old would be two different answers to "when was this
// actually raised".
test('an invoice\'s issued date moves to today when Invoice is pressed again', async () => {
  const admin = await signIn('admin');
  const store = await signIn('warehouse');
  const id = await anOrder(admin, store);

  await db.query(`update invoices set issued_on = current_date - 10 where order_id = $1`, [id]);

  const pressed = await POST(admin, `/api/orders/${id}/commit`);
  assert.equal(pressed.status, 200, JSON.stringify(pressed.data));

  const row = (await db.query(
    'select issued_on = current_date as is_today from invoices where order_id = $1', [id])).rows[0];
  assert.equal(row.is_today, true, 'the date follows the press, the same as the number does');
});

// Pressing Packing list on Invoice tab's own Record payment dialog is what
// sends an order there — pressing it again is asking to be seen there
// first, the same as pressing Invoice again asks for the newest number.
test('pressing Packing list stamps when, and the order carries it', async () => {
  const admin = await signIn('admin');
  const store = await signIn('warehouse');
  const id = await anOrder(admin, store);

  const before = (await request(admin, 'GET', `/api/orders/${id}`)).data;
  assert.equal(before.packing_list_issued_at, null, 'nothing pressed yet');

  const pressed = await POST(admin, `/api/orders/${id}/packing-list-pressed`);
  assert.equal(pressed.status, 200, JSON.stringify(pressed.data));

  const after = (await request(admin, 'GET', `/api/orders/${id}`)).data;
  assert.ok(after.packing_list_issued_at, 'the press is now on the order');
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
  assert.match(show, /id="inv_keep"/, 'a form that has just been raised can be corrected');
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
