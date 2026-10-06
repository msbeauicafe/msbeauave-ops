// Bank report — the owner's own day/week/month snapshot, sitting right
// below Customer order in the admin menu.
//
// Sales, Expenses, Net profit and Net cash in are finance_summary() under a
// calendar window — the same figures Finance already shows, not a second
// formula that could quietly drift from the first. Cash position only
// displays Books' own named cash accounts; it never creates, renames or
// posts to one, so that stays entirely Books' own screen's job. Receivables
// reuses finance_summary()'s own outstanding figure. Payables is the one
// genuinely new number here — a read-only sum over real Purchase Order
// bills, checked against the view those bills already keep their own
// balance in, not a second copy of that arithmetic.
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
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password: 'secret123' }) });
  assert.equal(res.status, 200, `could not sign in as ${username}`);
  const raw = res.headers.getSetCookie?.()[0] ?? res.headers.get('set-cookie');
  return raw.split(';')[0];
}

async function newPOBill(admin, amount) {
  const sku = unique('SKU');
  await POST(admin, '/api/products', {
    sku, name: `Test ${sku}`, brand: 'Beau Glow', category: 'Serums',
    unit_cost: 100, wholesale_price: 250, srp: 400, retail_price: 450,
    shelf_life_months: 24,
  });
  const sup = await POST(admin, '/api/suppliers', { name: unique('Maker') });
  const po = await POST(admin, '/api/purchase-orders', {
    supplier_id: sup.data.id, lines: [{ sku, qty: 10, unit: 'PCS' }],
  });
  assert.equal(po.status, 200, JSON.stringify(po.data));
  const bill = await POST(admin, '/api/purchase-order-bills', { po_id: po.data.id, amount });
  assert.equal(bill.status, 200, JSON.stringify(bill.data));
  return bill.data.id;
}

// ---------------------------------------------------------------------------
// Menu placement
// ---------------------------------------------------------------------------
test('Bank report sits right after Customer order in the admin menu, nowhere else', () => {
  const at = app.indexOf('admin: [');
  const list = app.slice(at, app.indexOf('warehouse: [', at));
  const co = list.indexOf("'customerorder'");
  const br = list.indexOf("'bankreport'");
  const wi = list.indexOf("'warehouseinventory'");
  assert.ok(co > 0 && br > co && wi > br,
    "Bank report sits between Customer order and Warehouse inventory report");

  // No other role's own menu picks it up.
  const rest = app.slice(app.indexOf('warehouse: [', at));
  assert.doesNotMatch(rest, /'bankreport'/, "no other role's TABS array carries Bank report");
});

// ---------------------------------------------------------------------------
// The screen itself — reads real figures, touches no shared formula
// ---------------------------------------------------------------------------
test('SCREENS.bankreport reads the same finance figures Finance already uses, plus Books cash and the new payables total', () => {
  assert.match(app, /SCREENS\.bankreport = async/);
  const at = app.indexOf('SCREENS.bankreport = async');
  const fn = app.slice(at, app.indexOf('\nSCREENS.', at + 1));

  assert.match(fn, /GET\(`\/api\/finance\?from=\$\{from\}&to=\$\{to\}`\)/,
    "the same finance_summary() figures Finance's own screen reads, not a second formula");
  assert.match(fn, /GET\('\/api\/books\/cash'\)/,
    "Cash position reads Books' own cash accounts, the exact route Books' own Cash screen reads");
  assert.match(fn, /GET\('\/api\/reports\/payables'\)/);

  assert.match(fn, /fin\.wholesale\.outstanding/,
    "Receivables reuses finance_summary()'s own outstanding figure rather than a second query");

  // This screen only displays Books' cash accounts — no button or call here
  // ever creates, marks or renames one; that stays Books' own screen's job.
  assert.doesNotMatch(fn, /\/api\/books\/cash\/mark/);
  assert.doesNotMatch(fn, /POST\(.*\/api\/books/);
});

// Cash position always shows these seven boxes, whether or not Books
// happens to carry an account by that name yet — a box reads ₱0.00 rather
// than disappear, so the panel's shape never shifts as accounts are set up
// one at a time in Books.
test('Cash position is a fixed set of seven named boxes, not just whatever Books happens to have today', () => {
  assert.match(app,
    /const BR_CASH_BOXES = \['Bank', 'Cash on hand', 'GCash', 'BDO', 'BPI', 'Security Bank', 'Balance'\];/);

  const at = app.indexOf('SCREENS.bankreport = async');
  const fn = app.slice(at, app.indexOf('\nSCREENS.', at + 1));
  assert.match(fn, /BR_CASH_BOXES\.map/,
    "the panel renders the fixed list, not cash.accounts directly");
  assert.match(fn, /a\.title\.trim\(\)\.toLowerCase\(\) === label\.toLowerCase\(\)/,
    "each box is matched to a real Books account by its exact name");
});

test('the Day/Week/Month toggle is a real subtabs control, and the next arrow cannot be pushed into the future', () => {
  const at = app.indexOf('SCREENS.bankreport = async');
  const fn = app.slice(at, app.indexOf('\nSCREENS.', at + 1));
  assert.match(fn, /data-period="day"/);
  assert.match(fn, /data-period="week"/);
  assert.match(fn, /data-period="month"/);
  assert.match(fn, /br_next.*\.disabled = nextFrom > today/s,
    "the next arrow is disabled once the next period would start after today");
});

// ---------------------------------------------------------------------------
// GET /api/reports/payables — a read-only sum, admin only
// ---------------------------------------------------------------------------
test('payables sums real Purchase Order bill balances, not a second ledger', async () => {
  const admin = await signIn('admin');
  const before = (await GET(admin, '/api/reports/payables')).data.total;

  await newPOBill(admin, 4000);   // fully unpaid: balance 4000
  const partial = await newPOBill(admin, 6000);
  await POST(admin, `/api/purchase-order-bills/${partial}/payments`,
    { amount: 2500, method: 'CASH', paid_on: '2026-10-01' }); // balance now 3500

  const after = (await GET(admin, '/api/reports/payables')).data.total;
  assert.ok(Math.abs((after - before) - 7500) < 0.01,
    `expected the two new bills' unpaid balances (4000 + 3500 = 7500) added to the total, got a delta of ${after - before}`);
});

test('a cashier sign-in cannot read the payables total — owner only, same as Receivables', async () => {
  const cashier = await signIn('cashier');
  const r = await GET(cashier, '/api/reports/payables');
  assert.notEqual(r.status, 200, JSON.stringify(r.data));
});
