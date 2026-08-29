// Correcting what actually goes in the box, on the sheet that travels with it.
//
// Two were ordered and one is worth sending; or the reseller adds something
// over chat while the box is still open. Before this the only way to say so
// was to cancel the order, which puts every line back on sale and loses the
// number the reseller already has in front of them.
//
// The stock has to move with the paper. A sheet that says one while the
// warehouse still holds two is a shortage that surfaces weeks later with
// nothing to trace it to.
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
  assert.equal(res.status, 200);
  return (res.headers.getSetCookie?.()[0] ?? res.headers.get('set-cookie')).split(';')[0];
}

async function anAccount(admin) {
  const { data } = await POST(admin, '/api/resellers',
    { name: unique('Reseller'), email: 'b@example.ph', tier: 2,
      credit_limit: 1_000_000, terms_days: 15 });
  await POST(admin, `/api/resellers/${data.id}/approve`);
  return data.id;
}

async function stocked(admin, store, qty = 60, price = 250) {
  const sku = unique('SKU');
  await POST(admin, '/api/products', {
    sku, name: `Test ${sku}`, brand: 'Beau Glow', category: 'Serums',
    unit_cost: 100, wholesale_price: price, srp: 400, retail_price: 450,
    shelf_life_months: 24 });
  await POST(store, '/api/receive',
    { sku, batch_no: unique('B'), expiry: monthsOut(24), qty });
  return sku;
}

const held = async (sku) => Number((await db.query(
  `select coalesce(sum(s.committed), 0) as n from stock s
     join batches b on b.id = s.batch_id where b.sku = $1`, [sku])).rows[0].n);
const linesOf = async (order) => (await db.query(
  'select sku, qty from order_lines where order_id = $1 order by sku', [order])).rows;
const invoiceOf = async (order) => (await db.query(
  'select amount, status from invoices where order_id = $1', [order])).rows[0];

test('sending fewer puts the difference back on the shelf', async () => {
  const admin = await signIn('admin');
  const store = await signIn('warehouse');
  const sku = await stocked(admin, store);
  const id = await anAccount(admin);
  const { data: o } = await POST(admin, `/api/resellers/${id}/orders`,
    { lines: [{ sku, qty: 4 }] });
  assert.equal(await held(sku), 4);

  const out = await POST(admin, `/api/orders/${o.orderId}/lines`,
    { lines: [{ sku, qty: 1 }] });
  assert.equal(out.status, 200, JSON.stringify(out.data));

  assert.deepEqual(await linesOf(o.orderId), [{ sku, qty: 1 }]);
  assert.equal(await held(sku), 1, 'three units are back on sale, not held for a box they are not in');
  assert.equal(Number(out.data.total), 250);
  assert.equal(Number((await invoiceOf(o.orderId)).amount), 250,
    'the invoice follows the box rather than the order as first typed');
});

test('adding something the box gained holds the stock for it', async () => {
  const admin = await signIn('admin');
  const store = await signIn('warehouse');
  const one = await stocked(admin, store, 60, 250);
  const two = await stocked(admin, store, 60, 100);
  const id = await anAccount(admin);
  const { data: o } = await POST(admin, `/api/resellers/${id}/orders`,
    { lines: [{ sku: one, qty: 2 }] });

  const out = await POST(admin, `/api/orders/${o.orderId}/lines`,
    { lines: [{ sku: one, qty: 2 }, { sku: two, qty: 3 }] });
  assert.equal(out.status, 200, JSON.stringify(out.data));

  assert.deepEqual((await linesOf(o.orderId)).sort((a, b) => a.sku.localeCompare(b.sku)),
    [{ sku: one, qty: 2 }, { sku: two, qty: 3 }].sort((a, b) => a.sku.localeCompare(b.sku)));
  assert.equal(await held(two), 3, 'what was added is held like anything else on the order');
  assert.equal(Number(out.data.total), 2 * 250 + 3 * 100);
});

test('a product left off the sheet is a product that is not going', async () => {
  const admin = await signIn('admin');
  const store = await signIn('warehouse');
  const one = await stocked(admin, store);
  const two = await stocked(admin, store);
  const id = await anAccount(admin);
  const { data: o } = await POST(admin, `/api/resellers/${id}/orders`,
    { lines: [{ sku: one, qty: 2 }, { sku: two, qty: 2 }] });

  await POST(admin, `/api/orders/${o.orderId}/lines`, { lines: [{ sku: one, qty: 2 }] });
  assert.deepEqual(await linesOf(o.orderId), [{ sku: one, qty: 2 }]);
  assert.equal(await held(two), 0, 'the whole of it goes back, not just the line');
});

test('a corrected price survives a change of quantity', async () => {
  const admin = await signIn('admin');
  const store = await signIn('warehouse');
  const sku = await stocked(admin, store, 60, 250);
  const id = await anAccount(admin);
  const { data: o } = await POST(admin, `/api/resellers/${id}/orders`,
    { lines: [{ sku, qty: 2 }] });
  const line = (await db.query(
    'select id from order_lines where order_id = $1', [o.orderId])).rows[0].id;
  await POST(admin, `/api/orders/${o.orderId}/invoice`,
    { lines: [{ id: line, price: 199 }] });

  const out = await POST(admin, `/api/orders/${o.orderId}/lines`, { lines: [{ sku, qty: 5 }] });
  assert.equal(out.status, 200, JSON.stringify(out.data));
  assert.equal(Number(out.data.total), 5 * 199,
    'the figure the reseller agreed to is not handed back because a unit was added');
});

test('an empty sheet is refused rather than quietly cancelling the order', async () => {
  const admin = await signIn('admin');
  const store = await signIn('warehouse');
  const sku = await stocked(admin, store);
  const id = await anAccount(admin);
  const { data: o } = await POST(admin, `/api/resellers/${id}/orders`,
    { lines: [{ sku, qty: 2 }] });

  const nope = await POST(admin, `/api/orders/${o.orderId}/lines`, { lines: [{ sku, qty: 0 }] });
  assert.equal(nope.status, 400, JSON.stringify(nope.data));
  assert.match(nope.data.error, /cancellation/);
  assert.equal(await held(sku), 2, 'and nothing moved on the way to being refused');
});

test('more than the warehouse holds is refused, and the order is left as it was', async () => {
  const admin = await signIn('admin');
  const store = await signIn('warehouse');
  const sku = await stocked(admin, store, 5);
  const id = await anAccount(admin);
  const { data: o } = await POST(admin, `/api/resellers/${id}/orders`,
    { lines: [{ sku, qty: 2 }] });

  const nope = await POST(admin, `/api/orders/${o.orderId}/lines`, { lines: [{ sku, qty: 9 }] });
  assert.equal(nope.status, 400, JSON.stringify(nope.data));
  assert.match(nope.data.error, /short/);
  assert.deepEqual(await linesOf(o.orderId), [{ sku, qty: 2 }],
    'a refusal leaves the order exactly where it was');
  assert.equal(await held(sku), 2);
});

test('once it is out of the building the sheet cannot change it', async () => {
  const admin = await signIn('admin');
  const store = await signIn('warehouse');
  const sku = await stocked(admin, store);
  const id = await anAccount(admin);
  const { data: o } = await POST(admin, `/api/resellers/${id}/orders`,
    { lines: [{ sku, qty: 2 }] });
  await POST(store, `/api/orders/${o.orderId}/dispatch`);

  const nope = await POST(admin, `/api/orders/${o.orderId}/lines`, { lines: [{ sku, qty: 1 }] });
  assert.equal(nope.status, 400, JSON.stringify(nope.data));
  assert.match(nope.data.error, /left the building/);
});

test('the sheet cannot come to less than has already been settled', async () => {
  const admin = await signIn('admin');
  const store = await signIn('warehouse');
  const sku = await stocked(admin, store, 60, 250);
  const id = await anAccount(admin);
  const { data: o } = await POST(admin, `/api/resellers/${id}/orders`,
    { lines: [{ sku, qty: 4 }] });
  const inv = await db.query('select id from invoices where order_id = $1', [o.orderId]);
  await db.query('update invoices set paid = 1000 where id = $1', [inv.rows[0].id]);

  const nope = await POST(admin, `/api/orders/${o.orderId}/lines`, { lines: [{ sku, qty: 1 }] });
  assert.equal(nope.status, 400, JSON.stringify(nope.data));
  assert.match(nope.data.error, /already been settled/);
  assert.equal(await held(sku), 4, 'a refused sheet releases nothing');
});

test('the warehouse floor cannot rewrite an order it is only packing', async () => {
  const admin = await signIn('admin');
  const store = await signIn('warehouse');
  const sku = await stocked(admin, store);
  const id = await anAccount(admin);
  const { data: o } = await POST(admin, `/api/resellers/${id}/orders`,
    { lines: [{ sku, qty: 2 }] });

  const nope = await POST(store, `/api/orders/${o.orderId}/lines`, { lines: [{ sku, qty: 1 }] });
  assert.equal(nope.status, 403, JSON.stringify(nope.data));
});

test('the sheet only offers boxes while the goods are still in the building', () => {
  const at = app.indexOf('async function openOrder');
  const fn = app.slice(at, app.indexOf('\n}', app.indexOf('a_packing', at)));
  assert.match(fn, /\['admin', 'office'\]\.includes\(user\?\.role\)/,
    'the bench can read the sheet; correcting the order behind it is the office');
  assert.match(fn, /\['placed', 'picking'\]\.includes\(o\.status\)/,
    'and only while the stock is still held rather than gone');

  const sheet = app.slice(app.indexOf('function showPackingList'),
                          app.indexOf('function officialReceipt'));
  assert.match(sheet, /data-sku="\$\{esc\(l\.sku \|\| ''\)\}"/,
    'each line carries the product it is, so the sheet can be read back');
  assert.match(sheet, /list="doc_goods"/,
    'and a blank row offers what the warehouse actually holds');
  assert.match(sheet, /data-tax="\$\{key\}"/,
    'the tax block is typed here and kept on the account');
});

// The order dialog is where somebody is already looking at the products, so
// it is where they should be able to change them — rather than being sent to
// a document to correct what the document only reports.
test('the products are corrected where the order itself is opened', () => {
  const fn = app.slice(app.indexOf('async function openOrder'),
                       app.indexOf('// A document as a file'));
  assert.match(fn, /data-sku="\$\{esc\(l\.sku\)\}"/, 'a quantity on every line');
  assert.match(fn, /data-line="\$\{esc\(String\(l\.id\)\)\}"/, 'and a price');
  assert.match(fn, /list="doc_goods"/, 'and spare rows offering the catalogue');
  assert.match(fn, /sheetBoxes\(box, goods/,
    'read by the same one every other sheet reads through');
  assert.match(fn, /o\.channel === 'b2b' && \['placed', 'picking'\]/,
    'never on a counter sale, and never once the goods have gone');

  const save = fn.slice(fn.indexOf("$('#ol_keep').addEventListener"));
  assert.ok(save.indexOf('/invoice`') < save.indexOf('/lines`'),
    'the money is settled first, so the paid floor is judged on the corrected price');
});

// Every one of these sheets is a piece of paper somebody sends or files, so
// every one of them has to offer both ways off the screen. Print was on the
// packing list alone, which meant the invoice was a document you could only
// photograph.
test('every document offers the printer as well as the picture', () => {
  const shown = [...app.matchAll(/id="(\w+_save)">⬇ Download JPEG<\/button>\s*\n\s*(\S+)/g)];
  assert.ok(shown.length >= 6, `expected every sheet to be checked, found ${shown.length}`);
  for (const [, which, next] of shown) {
    assert.match(next, /PRINT_BTN/,
      `${which} offers a picture and no way to print the thing`);
  }

  const css = fs.readFileSync(path.join(here, '..', 'public/styles.css'), 'utf8');
  const printing = css.slice(css.indexOf('body:has(#dialog) .shell'));
  assert.match(printing.slice(0, 600), /\.veil:not\(#dialog\) \{ display: none/,
    'a document opened over another must not print the one underneath it');
});

// A line whose product is wrong is not a line to empty and retype below it.
test('the product on a line can be changed for another', () => {
  const fn = app.slice(app.indexOf('async function openOrder'),
                       app.indexOf('// A document as a file'));
  assert.match(fn, /data-swap="\$\{esc\(String\(l\.id\)\)\}"/,
    'the product itself is a picker, not a label');
  assert.match(fn, /data-was="\$\{esc\(l\.sku\)\}"/,
    'holding what it was, so a name that resolves to nothing can go back');

  const wire = app.slice(app.indexOf('function sheetBoxes'), app.indexOf('const goodsList'));
  assert.match(wire, /qty\.dataset\.sku = g\.sku/,
    'picking another product moves the quantity to it, which is what a swap is');
  assert.match(wire, /box\.value = box\.dataset\.wasname/,
    'and something that is not a product the warehouse holds puts the row back');
  assert.match(wire, /price\.dataset\.swapped = '1'/,
    'the price belonged to the line being replaced, so it is marked not to be sent');

  const save = fn.slice(fn.indexOf("$('#ol_keep').addEventListener"));
  assert.match(save, /filter\(\(el\) => !el\.dataset\.swapped\)/,
    'a swapped line must not be priced a moment before it is deleted');
});

// Borderless is right for a price list eight hundred rows deep. In a dialog of
// three rows it reads as a report, and somebody walks off to another screen to
// change what was under their cursor all along.
test('the boxes in the order dialog look like boxes', () => {
  const css = fs.readFileSync(path.join(here, '..', 'public/styles.css'), 'utf8');
  const rule = css.slice(css.indexOf('.cellbox.open {'), css.indexOf('.cellbox.unset'));
  assert.match(rule, /border-color: var\(--rose-soft\)/,
    'a box that says it is a box before it is hovered');

  const fn = app.slice(app.indexOf('async function openOrder'),
                       app.indexOf('// A document as a file'));
  const boxes = fn.match(/class="cellbox[^"]*"/g) || [];
  assert.ok(boxes.length >= 5, `expected every cell to be a box, found ${boxes.length}`);
  assert.ok(boxes.every((c) => c.includes('open')),
    `every one of them announces itself: ${boxes.filter((c) => !c.includes('open'))}`);
});

// The invoice and the packing list are the same order seen from two sides.
// Correcting one and not the other would mean walking to a different screen
// depending on which number was wrong, and two sheets that could disagree.
test('the invoice corrects the same things, and reads them the same way', () => {
  const doc = app.slice(app.indexOf('function showInvoiceDoc'),
                        app.indexOf('function showPackingList'));
  assert.match(doc, /docParty\([\s\S]*?canEdit && !!resellerId,/,
    'the tax block is typed here too, through the party block both sheets print');
  const party = app.slice(app.indexOf('const docParty ='), app.indexOf('const docLines ='));
  assert.match(party, /data-tax="\$\{key\}"/,
    'and it is a box when the sheet says so, plain text when it does not');
  assert.match(doc, /const canPick = canEdit && \['placed', 'picking'\]/,
    'quantities close when the goods leave; prices stay open as long as the invoice does');
  assert.match(doc, /sheetBoxes\(sheet, goods/,
    'and the sheet is read by the one reading both documents share');

  const packing = app.slice(app.indexOf('function showPackingList'),
                            app.indexOf('function officialReceipt'));
  assert.match(packing, /sheetBoxes\(sheet, goods/,
    'a packing list and an invoice must not come to different answers');

  // Prices are settled before quantities on purpose: both are judged against
  // what has already been paid, and the usual correction is a price going up
  // while a quantity comes down.
  const save = doc.slice(doc.indexOf("$('#iv_keep').addEventListener"));
  assert.ok(save.indexOf('/invoice`') < save.indexOf('/lines`'),
    'the money is settled first, so the paid floor is judged on the corrected price');
});
