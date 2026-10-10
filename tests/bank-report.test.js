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
test('SCREENS.bankreport reads the same finance figures Finance already uses, plus Books cash and its own lists', () => {
  assert.match(app, /SCREENS\.bankreport = async/);
  const at = app.indexOf('SCREENS.bankreport = async');
  const fn = app.slice(at, app.indexOf('\nSCREENS.', at + 1));

  assert.match(fn, /GET\(`\/api\/finance\?from=\$\{from\}&to=\$\{to\}`\)/,
    "the same finance_summary() figures Finance's own screen reads, not a second formula");
  assert.match(fn, /GET\('\/api\/books\/cash'\)/,
    "Cash position reads Books' own cash accounts, the exact route Books' own Cash screen reads");
  for (const route of ['/api/bank-report/sales?from=', '/api/bank-report/purchases?from=',
    "/api/bank-report/payables'", "/api/reports/receivables'"]) {
    assert.ok(fn.includes(route), `reads ${route}`);
  }

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
  assert.match(fn, /\['day', 'week', 'month'\]\.map\(\(x\) => `<button data-period="\$\{x\}"/);
  assert.match(fn, /\$\('#br_next', page\)\.disabled = brRange\(period, brShift\(period, anchor, 1\)\)\.from > today/,
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

// ---------------------------------------------------------------------------
// The tile menu — Bank report opens on seven tiles, each its own page
// ---------------------------------------------------------------------------
test('Bank report opens on a Dashboard header with the six tiles under it, and each has a way back', () => {
  assert.match(app, /const BR_TILES = \[\['dashboard', 'Dashboard'\], \['bank', 'Bank'\], \['sales', 'Sales'\],\s*\['purchases', 'Purchases'\], \['expenses', 'Expenses'\], \['payable', 'Accounts payable'\],\s*\['receivable', 'Accounts receivable'\]\];/);
  const at = app.indexOf('SCREENS.bankreport = async');
  const fn = app.slice(at, app.indexOf('\nSCREENS.', at + 1));
  assert.match(app, /const brTiles = \(keys\) => `<div class="brgrid">/);
  assert.match(fn, /id="br_back"/);
  // The menu: Dashboard is a header, not a button, with the six tiles
  // under it; each of them comes back to the menu.
  assert.match(fn, /<div class="brheader">/);
  assert.doesNotMatch(fn, /data-br="dashboard"|view === 'dashboard'/);
  assert.match(app, /const BR_INSIDE = \['sales', 'bank', 'expenses', 'purchases', 'receivable', 'payable'\];/);
  assert.match(fn, /\$\{brTiles\(BR_INSIDE\)\}/);
  assert.match(fn, /\$\('#br_back', page\)\.addEventListener\('click', menu\)/);
  assert.match(fn, /\n  menu\(\);\n\};\n/, 'it opens on the menu');
});

test("Bank report's own lists: sales and purchases by period, unpaid supplier bills", async () => {
  const admin = await signIn('admin');
  const bill = await newPOBill(admin, 1234);
  const owed = (await GET(admin, '/api/bank-report/payables')).data;
  assert.ok(owed.some((r) => Number(r.id) === Number(bill) && Number(r.balance) === 1234), JSON.stringify(owed).slice(0, 300));
  for (const r of owed) assert.ok(Number(r.balance) > 0, 'only what is still owed');

  const sales = await GET(admin, '/api/bank-report/sales?from=2000-01-01&to=2100-01-01');
  assert.equal(sales.status, 200);
  for (const i of sales.data) assert.ok(['paid', 'pending', 'overdue'].includes(i.standing));
  const pos = await GET(admin, '/api/bank-report/purchases?from=2000-01-01&to=2100-01-01');
  assert.equal(pos.status, 200);
  assert.ok(pos.data.length > 0 && 'total' in pos.data[0] && 'supplier' in pos.data[0]);
});

test("a cashier sign-in cannot read Bank report's lists", async () => {
  const cashier = await signIn('cashier');
  for (const p of ['/api/bank-report/sales?from=2000-01-01&to=2100-01-01',
    '/api/bank-report/purchases?from=2000-01-01&to=2100-01-01', '/api/bank-report/payables']) {
    assert.notEqual((await GET(cashier, p)).status, 200, p);
  }
});

// ---------------------------------------------------------------------------
// Bank → Bank transactions: the statement's own lines, one reference once
// ---------------------------------------------------------------------------
async function asRole(role, actor, sql, params = []) {
  const client = await db.connect();
  try {
    await client.query('begin');
    await client.query("select set_config('app.role',$1,true)", [role]);
    await client.query("select set_config('app.actor',$1,true)", [actor]);
    await client.query('set local role app_client');
    return await client.query(sql, params);
  } finally {
    await client.query('rollback').catch(() => {});
    client.release();
  }
}

test('a bank transaction is recorded and read back; the same reference on the same account is refused', async () => {
  const admin = await signIn('admin');
  const reference = unique('REF');
  const line = { txn_on: '2026-10-10', account: 'BDO', kind: 'instapay', direction: 'in',
    party: 'Bella Skin Manila', amount: 24900, reference, note: '' };
  const first = await POST(admin, '/api/bank-report/transactions', line);
  assert.equal(first.status, 200, JSON.stringify(first.data));

  const list = (await GET(admin, '/api/bank-report/transactions')).data;
  const mine = list.find((t) => t.reference === reference);
  assert.ok(mine, 'read back');
  assert.equal(Number(mine.amount), 24900);
  assert.equal(mine.kind, 'instapay');

  const again = await POST(admin, '/api/bank-report/transactions', { ...line, reference: ` ${reference.toLowerCase()} ` });
  assert.notEqual(again.status, 200);
  assert.match(JSON.stringify(again.data), /already on file for BDO/);

  // The same number on a different account is a different transfer.
  const other = await POST(admin, '/api/bank-report/transactions', { ...line, account: 'BPI' });
  assert.equal(other.status, 200, JSON.stringify(other.data));
});

test('a bank transaction needs a type, an account, an amount and a reference — picked, not typed', async () => {
  const admin = await signIn('admin');
  const ok = { txn_on: '2026-10-10', account: 'BDO', kind: 'pesonet', direction: 'out',
    party: 'Glow Pack Supplies', amount: 100, reference: unique('REF') };
  for (const bad of [{ kind: 'wire' }, { account: 'aaaaa' }, { direction: 'sideways' },
    { amount: 0 }, { reference: '  ' }, { party: '' }]) {
    const r = await POST(admin, '/api/bank-report/transactions', { ...ok, ...bad });
    assert.notEqual(r.status, 200, JSON.stringify(bad));
  }
});

test("bank transactions are the owner's book: refused to a cashier at the route and past it", async () => {
  const cashier = await signIn('cashier');
  assert.notEqual((await GET(cashier, '/api/bank-report/transactions')).status, 200);
  assert.notEqual((await POST(cashier, '/api/bank-report/transactions', {})).status, 200);
  for (const role of ['cashier', 'hr', 'observer', 'employee']) {
    await assert.rejects(asRole(role, 'someone', 'select bank_txn_list()'), /FORBIDDEN/);
    await assert.rejects(asRole(role, 'someone',
      "select bank_txn_record(current_date,'BDO','instapay','in','x',1,'r1','')"), /FORBIDDEN/);
  }
  await assert.rejects(asRole('admin', 'someone', 'select * from bank_transactions'));
});

// Sales: four boxes in place of the one Invoiced box — the whole period,
// the fully paid, the not-yet-paid and the part-paid with what is still owed.
test('Sales shows Total order amounts, Paid, Unpaid and Balance transactions', () => {
  const at = app.indexOf("if (view === 'sales')");
  const block = app.slice(at, app.indexOf("if (view === 'purchases')", at));
  for (const l of ['Total order amounts', 'Paid transactions', 'Unpaid transactions', 'Balance transactions']) {
    assert.ok(block.includes(`'${l}'`), l);
  }
  assert.doesNotMatch(block, /Invoiced · /);
  assert.match(block, /const paid = rows\.filter\(\(i\) => Number\(i\.balance\) <= 0\)/);
  assert.match(block, /const unpaid = rows\.filter\(\(i\) => Number\(i\.balance\) > 0 && paidSoFar\(i\) <= 0\)/);
  assert.match(block, /const part = rows\.filter\(\(i\) => Number\(i\.balance\) > 0 && paidSoFar\(i\) > 0\)/);
  assert.match(block, /sum\(part, \(i\) => i\.balance\)/);
  // Each box is a button narrowing the list to its own invoices.
  assert.match(block, /<button class="tile brsf/);
  assert.match(block, /table\(groups\[brSalesFilter\]\[0\]/);
});

test("Sales' columns: Invoice no., Client name, Issued date (the packing list's), Amount, Status, Balance", () => {
  const at = app.indexOf("if (view === 'sales')");
  const block = app.slice(at, app.indexOf("if (view === 'purchases')", at));
  const heads = [...block.matchAll(/head: '([^']*)'/g)].map((m) => m[1]);
  assert.deepEqual(heads, ['Invoice no.', 'Client name', 'Issued date', 'Amount', 'Status', 'Balance']);
  // Issued date is the packing list's own date, not the invoice's.
  assert.match(block, /onDay\(i\.packing_list_on\)/);
});

test("Sales' period follows the packing list's date, the same one Issued date shows", async () => {
  const admin = await signIn('admin');
  const pl = `to_char(coalesce((coalesce(o.packing_list_issued_at, o.placed_at) at time zone 'Asia/Manila')::date,
                       i.issued_on), 'YYYY-MM-DD')`;
  const r = await db.query(`select i.id, ${pl} as day from invoices i left join orders o on o.id = i.order_id
                             where i.status <> 'void' limit 1`);
  if (!r.rows.length) return;
  const { day } = r.rows[0];
  const { data } = await GET(admin, `/api/bank-report/sales?from=${day}&to=${day}`);
  assert.ok(data.some((x) => Number(x.id) === Number(r.rows[0].id)), 'found on its packing list date');
  const days = await db.query(`select distinct ${pl} as day from invoices i left join orders o on o.id = i.order_id
                                where i.id = any($1::bigint[])`, [data.map((x) => x.id)]);
  assert.deepEqual(days.rows.map((x) => x.day), [day], 'nothing from another day');
});

// The Dashboard under the header: Daily / Monthly, a date bar, and six
// figures — the hand-drawn layout — before the six tiles.
test('Bank report Dashboard: Daily/Monthly, a date bar and six figures above the tiles', () => {
  const at = app.indexOf('SCREENS.bankreport = async');
  const fn = app.slice(at, app.indexOf('\nSCREENS.', at + 1));
  const menu = fn.slice(fn.indexOf('const menu = () => {'));
  assert.ok(menu.indexOf('class="brheader"') < menu.indexOf('class="brdash"'));
  assert.ok(menu.indexOf('class="brdash"') < menu.indexOf('${brTiles(BR_INSIDE)}'));
  assert.match(menu, /data-dp="day"[^>]*>Daily<\/button>/);
  assert.match(menu, /data-dp="month"[^>]*>Monthly<\/button>/);
  const labels = [...fn.matchAll(/figure\('([^']+)'/g)].map((m) => m[1]);
  assert.deepEqual(labels, ['Total sales', 'Total bank balance', 'Outstanding AR', 'Outstanding AP',
    'Gross profit', 'Operating expenses']);
  assert.match(fn, /figure\('Total sales', invoices\.reduce\(\(t, i\) => t \+ Number\(i\.amount\), 0\)\)/,
    "Total sales is the Sales tile's own Total order amounts");
  assert.match(fn, /fin\.gross_margin/);
  assert.match(fn, /fin\.expenses\.total/);
});
