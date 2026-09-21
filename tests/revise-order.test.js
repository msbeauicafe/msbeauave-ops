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

// The paper that travels with the box states what is in the box. It is not
// where the box is decided — at any desk.
//
// It was briefly a form, then briefly a form at one desk and a document at the
// other, which was worse: the same sheet answering differently depending on
// which tab reached it is a sheet nobody can be sure of.
test('the packing list is a document, wherever it is opened from', () => {
  const sheet = app.slice(app.indexOf('function showPackingList'),
                          app.indexOf('function officialReceipt'));
  for (const [what, pattern] of [
    ['a quantity box', /data-sku=/],
    ['a spare row to add a product', /data-add=/],
    ['a picker to swap one', /data-swap=/],
    ['a box for the tax block', /data-tax=/],
    ['a box for its own number', /data-docno/],
    ['a way to save any of it', /pk_keep|sheetBoxes/],
  ]) {
    assert.doesNotMatch(sheet, pattern, `the packing list still carries ${what}`);
  }
  assert.match(sheet, /id="pk_save"/, 'a picture for the chat window');
  assert.match(sheet, /PRINT_BTN/, 'the printer for the folder');
  assert.match(sheet, /id="pk_done"/, 'and a way to close it');

  // The sheet is handed nothing it could be made editable by, at any desk.
  const fn = app.slice(app.indexOf('async function openOrder'),
                       app.indexOf('// A document as a file'));
  const opened = fn.slice(fn.indexOf("$('#a_packing')"));
  assert.doesNotMatch(opened, /canEdit|catalog|onSaved/,
    'the sheet is handed nothing it could be made editable by');
});

// One screen works, the other reads.
//
// Pending customer order is where an order that has not left is corrected.
// Wholesale orders is where the warehouse picks and sends what has already
// been decided — so it opens the same order with nothing to type in. The stage
// buttons stay: starting a pick and dispatching are what that screen is for,
// and neither of them is editing.
test('the order is worked on from one screen and read from the other', () => {
  const board = app.slice(app.indexOf('SCREENS.orders = async'),
                          app.indexOf('/**\n * One order, opened.'));
  assert.match(board, /openOrder\(b\.dataset\.open, load, \{ readOnly: true \}\)/,
    'the picking screen opens an order to read');

  const pending = app.slice(app.indexOf('SCREENS.pendingorders = async'),
                            app.indexOf('SCREENS.chatorders = async'));
  assert.match(pending, /openOrder\(b\.dataset\.open, load\)/,
    'and the office screen opens it to work on');
  assert.doesNotMatch(pending, /readOnly/,
    'silence rather than false, so the working side cannot be shut by a typo');

  // Saying so is not the same as it holding: the dialog has to fold the
  // screen into both of the things it gates, the boxes and the numbers.
  const fn = app.slice(app.indexOf('/**\n * One order, opened.'),
                       app.indexOf('// A document as a file'));
  assert.match(fn, /const canEdit = !readOnly &&/,
    'a screen that reads cannot open the product, price or money boxes');
  assert.match(fn, /const mayNumber = !readOnly &&/,
    'nor the numbers on the paperwork');
  // And what that screen is actually for is untouched.
  for (const button of ['a_pick', 'a_send', 'a_cancel', 'a_packing']) {
    assert.match(fn, new RegExp(`id="${button}"`),
      `${button} is what the picking screen is for and must survive`);
  }
});

// A pad is never on its last page while somebody is still writing on it.
//
// The spare rows used to be a fixed three. Filling the third meant saving,
// reopening and finding your place again to add a fourth — on a screen whose
// whole purpose is taking an order down as it is being read out.
test('the spare rows do not run out', () => {
  const wire = app.slice(app.indexOf('function sheetBoxes'), app.indexOf('const goodsList'));
  assert.match(wire, /const growIfLast = \(box\) =>/,
    'a filled spare row grows the next one');
  assert.match(wire, /if \(box !== rows\[rows\.length - 1\]\) return;/,
    'and only the last one does, so filling an earlier row adds nothing');
  assert.match(wire, /wirePicker\(\$\('\[data-add\]', fresh\)\)/,
    'the row it grows is wired like the ones drawn with the sheet');
  assert.match(wire, /if \(g\) growIfLast\(box\)/,
    'a row is only spent once it holds a real product');
});

// A form that runs to a second page is not the form: the paper it replaces is
// one sheet, and half a table on a page by itself is what somebody has to
// apologise for when they hand it over.
test('a long sheet is scaled onto one page rather than broken across two', () => {
  const fn = app.slice(app.indexOf('function printOneSheet'), app.indexOf('const PRINT_BTN'));
  // zoom, not transform. A transform is painted after layout, so the browser
  // paginates the sheet at its full height and then draws the pieces shrunk —
  // three pages of a form meant to be one, which is what this first did.
  assert.match(fn, /doc\.style\.zoom = shrink < 1 \? shrink\.toFixed\(4\) : ''/,
    'zoom changes the layout, so the page count follows it');
  assert.doesNotMatch(fn, /style\.transform/,
    'a transform leaves the pagination at full size');

  // Measured and corrected, not calculated and hoped for: working it out from
  // the unzoomed height came out seven pixels over, and seven pixels over is a
  // second page carrying one line of a signature block.
  assert.match(fn, /const got = doc\.getBoundingClientRect\(\)\.height;\s*\n\s*if \(got <= TALL\) break;/,
    'it asks the browser what it actually got');
  assert.match(fn, /shrink \*= \(TALL \/ got\) \* 0\.995/,
    'and comes down until the answer fits, never settling on the boundary');
  assert.match(fn, /shrink < 1/,
    'never above 1 — a two-line invoice must not print an inch high');
  assert.match(fn, /doc\.style\.width = `\$\{WIDE \/ shrink\}px`/,
    'laid out wider by as much as it is shrunk, so it fills the sheet rather '
    + 'than sitting in a column down the left of it');
  assert.match(fn, /addEventListener\('afterprint', undo\)/, 'the sheet goes back afterwards');
  assert.match(fn, /setTimeout\(undo, 3000\)/,
    'including where afterprint never fires, which is most phones');

  // A module's functions are not on window, so an inline onclick cannot see
  // them. This was wired as one before the tests caught it.
  assert.match(app, /const PRINT_BTN = '<button class="btn quiet" data-print>/,
    'the button is marked, not wired inline');
  assert.doesNotMatch(app, /onclick="printOneSheet/,
    'an inline handler in a module is a button that does nothing');

  const css = fs.readFileSync(path.join(here, '..', 'public/styles.css'), 'utf8');
  // The buttons under a document are hidden on paper, but their row keeps its
  // margin — and a sheet that fills the page exactly plus twelve pixels of
  // nothing is a second page with no ink on it.
  assert.match(css, /#dialog \.dialog > \.mt\.right \{ display: none !important; \}/,
    'the action row goes too, not just the buttons in it');

  // What comes out of the printer has to be the document that was read on
  // screen and approved, not a version of it the browser decided on.
  assert.match(css, /@page \{ margin: 0; \}/,
    'no page margin, because a page margin is where the browser prints the '
    + 'date, the URL and "1/1" across a document going to a reseller');
  assert.match(css, /#dialog \.dialog \{[^}]*padding: 10mm/,
    'the white border round the sheet is given by the sheet instead');
  assert.match(css, /print-color-adjust: exact/,
    'and the headings and column bands are not dropped to save ink');

  // Room to sign, at the foot of the paper.
  assert.match(css, /\.packing \.sign \.nm \{[^}]*border-top: 1px solid #000/,
    'the rule goes above the name, not under it — a signature line with the '
    + 'name already written on it is not a signature line');
  assert.match(css, /\.packing \.sign \.nm \{[^}]*margin-top: 13mm/,
    'with a hand\'s width of space over it');
  const pushed = css.indexOf('.packing .sign, .doc .sign1 { margin-top: auto; }');
  assert.ok(pushed > -1, 'the signatures are pushed to the foot of the page');
  assert.ok(pushed > css.indexOf('.packing .sign {'),
    'and declared after the margin it overrides — equal specificity, so the '
    + 'one further down the file is the one that wins');

  const fn2 = app.slice(app.indexOf('function printOneSheet'), app.indexOf('const PRINT_BTN'));
  assert.match(fn2, /doc\.style\.minHeight = `\$\{TALL \/ shrink\}px`/,
    'the sheet is as tall as the paper, or there is nothing to push against');
  assert.ok(fn2.indexOf('doc.style.minHeight =') > fn2.indexOf('shrink *= (TALL / got)'),
    'set after the fitting, or the sheet measures as its own minimum and '
    + 'shrinks itself trying to fit it');
  assert.match(fn2, /minHeight: doc\.style\.minHeight/,
    'and put back with the rest when the printing is done');
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
  assert.match(save, /filter\(\(el\) => !el\.dataset\.swapped/,
    'a swapped line must not be priced a moment before it is deleted');
  assert.match(fn, /data-remove="\$\{esc\(String\(l\.id\)\)\}"/,
    'an ✕ takes a line off the order');
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

// One desk works, the rest read.
//
// Pending customer order is where an order that has not left the building is
// corrected — the products, the quantities, the prices, the delivery fee, and
// the numbers on the paperwork. The account's own screen and the two document
// tabs are where the paper is looked up, saved as a picture and sent.
//
// The delivery fee and Others were typed on the invoice, and the invoice is a
// document now, so they moved rather than went. Nothing that could be
// corrected before has stopped being correctable; it is all in one place.
test('the invoice is a document, and what it used to take is on the order', () => {
  const doc = app.slice(app.indexOf('function showInvoiceDoc'),
                        app.indexOf('function showPackingList'));
  for (const [what, pattern] of [
    ['a quantity box', /data-sku=/],
    ['a spare row to add a product', /data-add=/],
    ['a price box', /data-line="/],
    ['a box for the delivery fee', /iv_ship/],
    ['a box for its own number', /data-docno/],
    ['a way to save any of it', /iv_keep|sheetBoxes/],
  ]) {
    assert.doesNotMatch(doc, pattern, `the invoice still carries ${what}`);
  }
  assert.match(doc, /id="ivd_save"/, 'a picture for the chat window');
  assert.match(doc, /PRINT_BTN/, 'the printer for the folder');

  const account = app.slice(app.indexOf("$$('[data-invoice]')"),
                            app.indexOf("$$('[data-invoice]')") + 1400);
  assert.doesNotMatch(account, /canEdit/,
    'and the account screen asks for none of it');

  // Everything it used to take is on the order, in one call.
  const fn = app.slice(app.indexOf('async function openOrder'),
                       app.indexOf('// A document as a file'));
  assert.match(fn, /id="ol_ship"/, 'the delivery fee moved here rather than going');
  assert.match(fn, /id="ol_oth"/, 'and so did Others');
  const save = fn.slice(fn.indexOf("$('#ol_keep').addEventListener"));
  assert.match(save, /shipping: money\(\$\('#ol_ship'\)\)/,
    'and they go up with the prices, being the same correction to the same money');
  assert.match(save, /others: money\(\$\('#ol_oth'\)\)/);
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
  assert.match(save, /filter\(\(el\) => !el\.dataset\.swapped/,
    'a swapped line must not be priced a moment before it is deleted');
  assert.match(fn, /data-remove="\$\{esc\(String\(l\.id\)\)\}"/,
    'an ✕ takes a line off the order');
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
