// Three new menu entries: Warehouse inventory report, Receiving form,
// Releasing form — added after Customer order, each its own screen rather
// than a second door onto Internal Inventory Report or Warehouse receiving.
//
// Warehouse inventory report has nothing of its own to filter to — stock
// only ever sits in b2b, shop or reserve, never a separate "warehouse" pool
// — so it is Internal Inventory Report's own three tabs again, kept as its
// own copy. Receiving form promotes the receiving-forms list Warehouse
// receiving already keeps to its own screen, reading the same
// receiving_forms table and opening the same showReceivingForm. Releasing
// form is genuinely new: a paper trail for stock leaving the warehouse
// outside a customer order, never touching batches, stock or movements.
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
const app = fs.readFileSync(path.join(here, '../public/app.js'), 'utf8');
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

async function newBranch(admin) {
  const r = await POST(admin, '/api/branches', { name: unique('Branch') });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  return r.data.id;
}

// ---------------------------------------------------------------------------
// Menu placement
// ---------------------------------------------------------------------------
test('the three new screens sit in the admin menu right after Customer order', () => {
  const at = app.indexOf('admin: [');
  const list = app.slice(at, app.indexOf('warehouse: [', at));
  const co = list.indexOf("'customerorder'");
  const wi = list.indexOf("'warehouseinventory'");
  const rv = list.indexOf("'receivingform'");
  const rl = list.indexOf("'releasingform'");
  const fin = list.indexOf("'finance'");
  assert.ok(co > 0 && wi > co && rv > wi && rl > rv && fin > rl,
    'Warehouse inventory report, Receiving form, Releasing form, in that order, between Customer order and Finance');
});

// ---------------------------------------------------------------------------
// Warehouse inventory report — its own copy, nothing filtered differently
// ---------------------------------------------------------------------------
test("Warehouse inventory report is its own screen, not a second menu entry for SCREENS.inventory", () => {
  assert.match(app, /SCREENS\.warehouseinventory = async/,
    'its own screen function, not a reused reference to SCREENS.inventory');
  const at = app.indexOf('SCREENS.warehouseinventory = async');
  const fn = app.slice(at, app.indexOf('\n};', at));

  assert.match(app.slice(app.lastIndexOf('let warehouseInventoryPanel', at), at),
    /let warehouseInventoryPanel = localStorage\.getItem\('warehouseInventoryPanel'\)/,
    "its own tab state, not inventoryPanel — switching one tab list never moves the other's");
  assert.match(fn, /\['stockin', 'Stock in'\]/);
  assert.match(fn, /\['stockout', 'Stock out'\]/);
  assert.match(fn, /\['history', 'History'\]/);
  assert.match(fn, /GET\('\/api\/receipts\?limit=15'\)/,
    'the same read Internal Inventory Report uses — there is no separate warehouse pool to filter to');
  assert.match(fn, /GET\('\/api\/reports\/stock-out\?limit=20'\)/);
  assert.match(fn, /GET\('\/api\/reports\/journal\?limit=20'\)/);

  // Internal Inventory Report itself is untouched by this.
  const original = app.slice(app.indexOf('SCREENS.inventory = async'),
    app.indexOf('SCREENS.warehouseinventory = async'));
  const invAt = app.indexOf('SCREENS.inventory = async');
  assert.match(app.slice(app.lastIndexOf('let inventoryPanel', invAt), invAt), /let inventoryPanel/);
  assert.match(original, /<h2>Inventory<\/h2>/);

  // Running stocks was asked for Internal Inventory Report specifically — it
  // sits on that screen's own tab list, not this copy's.
  assert.match(original, /\['runningstocks', 'Running stocks'\]/,
    "Internal Inventory Report carries the Running stocks tab");
  assert.doesNotMatch(fn, /runningstocks/,
    "Warehouse inventory report's own copy never picks it up");
});

// ---------------------------------------------------------------------------
// Running stocks — Product list's own Quantity figure, read again on
// Internal Inventory Report's own tab, with its own copy of the formula
// ---------------------------------------------------------------------------
test('Running stocks reads products fresh and keeps its own copy of the quantity formula', () => {
  const at = app.indexOf('SCREENS.inventory = async');
  const fn = app.slice(at, app.indexOf('\n};', at));

  assert.match(fn, /if \(inventoryPanel === 'runningstocks'\)/);
  assert.match(fn, /GET\('\/api\/products\?prices=1'\)/,
    'the same catalogue read Product list uses, not a narrowed or filtered copy');
  assert.match(fn, /const available = \(p\) => Number\(p\.total_on_hand\) - Number\(p\.committed_shop \|\| 0\)/,
    "its own copy of the formula — Product list's own `available` is local to that screen and unreachable from here");

  const headRe = /head: 'Code'[\s\S]*?head: 'Product'[\s\S]*?head: 'Brand'[\s\S]*?head: 'Category'[\s\S]*?head: 'Quantity'/;
  assert.match(fn, headRe, 'Code, Product, Brand, Category, Quantity, in that order');
});

test("Running stocks carries Product list's toolbar as its own copy", () => {
  const at = app.indexOf('SCREENS.inventory = async');
  const fn = app.slice(at, app.indexOf('\n};', at));

  // Search, brand dropdown, the category chips (its own copy now, with All
  // and Promo counted), Quantity — in the order
  // Product list shows them, under this tab's own rs_ ids. No New product:
  // the owner asked for that one left off.
  assert.match(fn, /id="rs_find"[\s\S]*?id="rs_brand"[\s\S]*?id="cat_rs"[\s\S]*?id="rs_qty"/);
  assert.match(fn, /wireCatChips\(page, 'cat_rs'/);

  // Product list's own toolbar is untouched and still its own.
  const plAt = app.indexOf('id="pt_brand"');
  const pl = app.slice(plAt, app.indexOf('</div>', plAt));
  assert.match(pl, /id="brand_find"[\s\S]*?id="brand_filter"[\s\S]*?id="add2"[\s\S]*?catChips\('cat_prod'\)[\s\S]*?id="qty_filter"/);
  assert.doesNotMatch(pl, /rs_/);

  // Warehouse inventory report never picks it up.
  const wAt = app.indexOf('SCREENS.warehouseinventory = async');
  assert.doesNotMatch(app.slice(wAt, app.indexOf('\n};', wAt)), /rs_find|cat_rs/);
});

// ---------------------------------------------------------------------------
// Receiving form — the existing receiving_forms list, promoted to its own
// screen, Warehouse receiving's own copy untouched
// ---------------------------------------------------------------------------
test('Receiving form is its own screen reading the same receiving forms Warehouse receiving already keeps', () => {
  assert.match(app, /SCREENS\.receivingform = async/);
  const at = app.indexOf('SCREENS.receivingform = async');
  const fn = app.slice(at, app.indexOf('\n};', at));

  assert.match(fn, /GET\('\/api\/receiving-forms'\)/,
    'the same backend list Warehouse receiving already reads — no new table for this');
  assert.match(fn, /showReceivingForm\(await GET\(`\/api\/receiving-forms\/\$\{b\.dataset\.rvf\}`\)\)/,
    'opened with the existing document renderer, reused not redrawn');
  assert.match(fn, /receiveDelivery\(\{ po: null, catalogue, shops, suppliers, done: \(\) => drawRFs\(\) \}\)/,
    'the same "record a delivery" dialog, already shared across screens');

  // Its own element ids, distinct from Warehouse receiving's rf_ ones, so a
  // script targeting one screen can never accidentally hit the other.
  assert.match(fn, /id="rvf_list"/);
  assert.match(fn, /id="rvf_new"/);

  // Warehouse receiving's own copy is untouched: still has the quick
  // single-line Receive form and the 📦 Whole delivery button this new
  // screen deliberately leaves out.
  const original = app.slice(app.indexOf('SCREENS.receive = async'),
    app.indexOf('SCREENS.receivingform = async'));
  assert.match(original, /id="r_go">Receive</);
  assert.match(original, /id="r_note">📦 Whole delivery</);
  assert.match(original, /id="rf_list"/);
  assert.match(original, /id="rf_new"/);
});

// ---------------------------------------------------------------------------
// Releasing form — genuinely new, a paper trail only
// ---------------------------------------------------------------------------
test('Releasing form posts to its own new endpoint and prints its own document', () => {
  assert.match(app, /SCREENS\.releasingform = async/);
  const at = app.indexOf('SCREENS.releasingform = async');
  const fn = app.slice(at, app.indexOf('\n};', at));

  assert.match(fn, /POST\('\/api\/warehouse-releases', \{/);
  assert.match(fn, /GET\('\/api\/warehouse-releases'\)/);
  assert.match(fn, /showReleasingForm\(\{/);
  assert.match(fn, /branchPicker\(shops, 'rl_branch', 'Releasing to'\)/,
    'a dropdown of branches, not a box the shop can type into');
});

test("the releasing form document carries RELEASED BY / CHECKED BY / RECEIVED BY, the same three-signature shape Receiving form's own document uses", () => {
  const at = app.indexOf('function releasingForm(');
  const fn = app.slice(at, app.indexOf('\nfunction showReleasingForm', at));
  assert.match(fn, /RELEASED BY:/);
  assert.match(fn, /CHECKED BY:/);
  assert.match(fn, /RECEIVED BY:/);
});

// ---------------------------------------------------------------------------
// release_stock — a paper trail only
// ---------------------------------------------------------------------------
test('a release is refused for a product code that does not exist', async () => {
  const admin = await signIn('admin');
  const branch = await newBranch(admin);
  const r = await POST(admin, '/api/warehouse-releases',
    { sku: unique('NOPE'), qty: 5, branch_id: branch });
  assert.notEqual(r.status, 200, JSON.stringify(r.data));
});

test('a release is refused for a quantity of zero or less', async () => {
  const admin = await signIn('admin');
  const sku = await newProduct(admin);
  const branch = await newBranch(admin);
  const r = await POST(admin, '/api/warehouse-releases', { sku, qty: 0, branch_id: branch });
  assert.notEqual(r.status, 200, JSON.stringify(r.data));
});

// require_role already lets a supervisor or office sign-in do anything a
// warehouse one can — the same rule release_stock inherits by allowing
// 'warehouse', same as receive_stock does. A cashier sign-in satisfies
// neither, so it is refused both ways: this is the role gate actually being
// enforced, not merely present.
test('a cashier sign-in can neither read releases nor log one', async () => {
  const admin = await signIn('admin');
  const sku = await newProduct(admin);
  const branch = await newBranch(admin);
  const cashier = await signIn('cashier');

  assert.notEqual((await GET(cashier, '/api/warehouse-releases')).status, 200);
  const blocked = await POST(cashier, '/api/warehouse-releases', { sku, qty: 1, branch_id: branch });
  assert.notEqual(blocked.status, 200, JSON.stringify(blocked.data));
});

test('a release is logged, read back with the product and branch names, and touches no stock at all', async () => {
  const admin = await signIn('admin');
  const sku = await newProduct(admin);
  const branch = await newBranch(admin);

  const before = (await db.query('select count(*)::int as n from movements')).rows[0].n;
  const beforeStock = (await db.query('select count(*)::int as n from stock')).rows[0].n;

  const made = await POST(admin, '/api/warehouse-releases',
    { sku, batch_no: 'LOT-9', qty: 7, branch_id: branch, reason: 'Shop restock' });
  assert.equal(made.status, 200, JSON.stringify(made.data));
  assert.ok(made.data.id > 0);

  const after = (await db.query('select count(*)::int as n from movements')).rows[0].n;
  const afterStock = (await db.query('select count(*)::int as n from stock')).rows[0].n;
  assert.equal(after, before, 'a release writes no movement — it never touches real stock');
  assert.equal(afterStock, beforeStock, 'and no stock row either — a paper trail only');

  const listed = (await GET(admin, '/api/warehouse-releases')).data;
  // Postgres hands bigint back as a string; made.data.id is the Number the
  // route already converted it to, so the two sides have to meet partway.
  const row = listed.find((r) => String(r.id) === String(made.data.id));
  assert.ok(row, 'the new release shows up in its own list');
  assert.equal(row.sku, sku);
  assert.equal(row.batch_no, 'LOT-9');
  assert.equal(row.qty, 7);
  assert.equal(row.reason, 'Shop restock');
  assert.match(row.name, /^Test SKU-/, "the product's own name, joined in — not just its code");
  assert.ok(row.branch, "the branch's own name, joined in — not just its id");
  assert.ok(row.released_by);
  assert.ok(row.released_at);
});
