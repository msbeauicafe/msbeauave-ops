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

// Cash position's boxes come off Payment Management's own list (db/188): BANK
// down the left, CASH down the right, the rest named under them — so a bank
// renamed there is renamed here, and one added gets a box of its own. A box
// still reads ₱0.00 rather than vanish when Books has nothing on it yet.
test("Cash position's boxes are Payment Management's list, laid out BANK | CASH", () => {
  const at = app.indexOf('SCREENS.bankreport = async');
  const fn = app.slice(at, app.indexOf('\nSCREENS.', at + 1));
  assert.match(fn, /const bankCol = boxes\.filter\(\(x\) => x\.column === 'bank'\)/);
  assert.match(fn, /const cashCol = boxes\.filter\(\(x\) => x\.column === 'cash'\)/);
  assert.match(fn, /\$\{column\('Bank', bankCol\)\}\$\{column\('Cash', cashCol\)\}/);
  assert.match(fn, /Also in the total:/);
  assert.match(fn, /\[\.\.\.boxes\.map\(\(x\) => x\.name\), 'Balance'\]\.reduce\(\(t, label\) => t \+ Number\(bal\(label\) \|\| 0\), 0\)/,
    'the total counts every box, the same as the Dashboard');
  assert.match(fn, /a\.title\.trim\(\)\.toLowerCase\(\) === label\.toLowerCase\(\)/,
    "each box is matched to a real Books account by its exact name");
  assert.doesNotMatch(app, /BR_CASH_BOXES/, 'no fixed seven any more');
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

test("Sales' columns, in the owner's order: the four boxes split row by row, Status last", () => {
  const at = app.indexOf("if (view === 'sales')");
  const block = app.slice(at, app.indexOf("if (view === 'purchases')", at));
  const heads = [...block.matchAll(/head: '([^']*)'/g)].map((m) => m[1]);
  assert.deepEqual(heads, ['Invoice no.', 'Client name', 'Issued date', 'Total orders', 'Total paid',
    'Total unpaid', 'Balance', 'Total balance', 'Status']);
  // Unpaid and Balance follow the boxes: nothing paid yet, or part-paid.
  assert.match(block, /head: 'Total unpaid', n: true, cell: \(i\) => \(Number\(i\.balance\) > 0 && paidSoFar\(i\) <= 0/);
  assert.match(block, /head: 'Balance', n: true, cell: \(i\) => \(Number\(i\.balance\) > 0 && paidSoFar\(i\) > 0/);
  // Purchases' and Expenses' tables are untouched.
  const rest = app.slice(app.indexOf("if (view === 'purchases')", at));
  assert.match(rest, /head: 'PO no\.'[\s\S]*?head: 'Amount'[\s\S]*?head: 'Status'/);
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

test("the Dashboard's date and Sales' date open Bank report's own calendar; Purchases and Expenses are left as they were", () => {
  const at = app.indexOf('SCREENS.bankreport = async');
  const fn = app.slice(at, app.indexOf('\n};\n', at));
  assert.match(fn, /const brCalendar = \(under, \{ mode, value, onPick \}\) =>/, 'its own calendar, inside this screen');
  assert.match(fn, /id="brd_pick"[\s\S]*?<b id="brd_label"><\/b>/, 'the Dashboard date is a button');
  assert.match(fn, /\$\('#brd_pick', page\)\.addEventListener\('click', \(\) => brCalendar\(/);
  assert.match(fn, /if \(key === 'sales'\) \{\s*\n\s*\$\('#br_label', page\)\.outerHTML/, 'Sales alone gets the picker');
  assert.match(fn, /<b id="br_label"><\/b>\n\s*<button class="btn sm quiet" id="br_next">/,
    "the shared header keeps its plain date for Purchases and Expenses");
  assert.doesNotMatch(app.slice(0, at), /brCalendar/, 'nothing outside Bank report uses it');
  assert.match(fn, /\$\{iso > today \? 'disabled' : ''\}/, 'no picking a day after today');
});

test("Bank's transactions section is laid out as the owner drew it, inside the Bank view only", () => {
  const at = app.indexOf("if (view === 'bank') {");
  const block = app.slice(at, app.indexOf("if (view === 'sales')", at));
  assert.match(block, /<h3>Bank Transactions<\/h3>/);
  assert.match(block, /View and manage all bank transactions, filter by account, type and period\./);
  assert.match(block, /placeholder="Search reference, name, or particulars…"/);
  assert.match(block, /id="bt_range"/, 'a From – To period filter');
  // The transactions table's own headings (Payment Management's list has its own).
  const bt = block.slice(block.indexOf('<table class="bttable">'), block.indexOf('</thead>', block.indexOf('<table class="bttable">')));
  const heads = [...bt.matchAll(/<th[^>]*>([^<]*)<\/th>/g)].map((m) => m[1]);
  assert.deepEqual(heads, ['Date', 'Reference #', 'Particulars', 'Account', 'Reference', '◆', 'Type',
    'Debit (₱)', 'Credit (₱)', 'Balance (₱)', 'Remarks']);
  assert.match(block, /Use the filters above or click “Payment Management” to get started\./);
  assert.match(block, /<button class="btn" id="bt_new">Payment Management<\/button>/, 'the button is named Payment Management');
  assert.match(block, /<h3>Payment Management<\/h3>/, 'and so is the form it opens');
  assert.doesNotMatch(block, /Record Bank Transaction|Record bank transaction/);
  // Its own table, not the app-wide helper.
  assert.match(block, /<table class="bttable">/);
  assert.doesNotMatch(app.slice(0, app.indexOf('SCREENS.bankreport = async')), /bttable|bt_range/);
});

test("a Cash position box opens its own account's transactions, in the Bank view only", () => {
  const at = app.indexOf("if (view === 'bank') {");
  const block = app.slice(at, app.indexOf("if (view === 'sales')", at));
  assert.match(block, /class="br-cash-acct br-cash-pick" data-btacct="\$\{esc\(acct\)\}"/, 'each box is a button');
  assert.match(block, /pick\.value = pick\.value === b\.dataset\.btacct \? '' : b\.dataset\.btacct;/,
    'click narrows to that account; click again for every account');
  // Every box's account is one the list can filter to.
  for (const acct of ['BDO', 'BPI', 'Security Bank', 'Cash on hand', 'GCash']) {
    assert.match(app, new RegExp(`const BR_BT_ACCOUNTS = \\[[^\\]]*'${acct}'`), `${acct} is in the account filter`);
  }
});

test("a box's Books entries come through to the transactions list, with Books' running balance", async () => {
  const admin = await signIn('admin');
  // A BDO account in Books, made here if this database has none yet.
  await db.query(`insert into coa_accounts (code, title, type, normal_side)
                  values ('TBDO', 'BDO', 'Asset', 'debit') on conflict do nothing`);
  const code = (await db.query("select code from coa_accounts where lower(title) = 'bdo'")).rows[0].code;
  await db.query(`insert into coa_accounts (code, title, type, normal_side)
                  values ('TSALES', 'Test sales ${process.pid}', 'Revenue', 'credit') on conflict do nothing`);
  const before = (await GET(admin, '/api/bank-report/ledger')).data.filter((l) => l.account === 'BDO');
  const start = before.length ? Number(before[0].running) : 0;
  const memo = unique('Payment from Bella Skin');
  const e = await db.query(`insert into journal_entries (entry_no, entry_date, memo)
                            values ($1, '2099-01-02', $2) returning id`, [unique('JE'), memo]);
  await db.query(`insert into journal_lines (entry_id, account, debit) values ($1, $2, 1500)`, [e.rows[0].id, code]);
  await db.query(`insert into journal_lines (entry_id, account, credit) values ($1, 'TSALES', 1500)`, [e.rows[0].id]);

  const after = (await GET(admin, '/api/bank-report/ledger')).data;
  const line = after.find((l) => l.memo === memo && l.account === 'BDO');
  assert.ok(line, 'the Books line on BDO is in the list');
  assert.equal(Number(line.debit), 1500);
  assert.equal(Number(line.running), start + 1500, "Books' own running balance, ending where the box does");
  assert.ok(!after.some((l) => l.account === `Test sales ${process.pid}`), 'only the cash accounts');

  const cashier = await signIn('cashier');
  assert.notEqual((await GET(cashier, '/api/bank-report/ledger')).status, 200, 'the owner\'s book');
});

test("Cash position's BANK and CASH headings are set larger, their subtotals unchanged", () => {
  const css = fs.readFileSync(path.join(here, '..', 'public/styles.css'), 'utf8');
  assert.match(css, /\.br-cash-colhd > span:first-child \{ font-size: 1\.45rem;/);
});

test('Bank Transactions: a payment reads by its SI no. and payor; a PO payment is money out with its PO no. and supplier', async () => {
  const admin = await signIn('admin');

  // A paid purchase order bill comes through as money out.
  const billId = await newPOBill(admin, 5000);
  const paid = await POST(admin, `/api/purchase-order-bills/${billId}/payments`,
    { amount: 1200, method: 'BANCO DE ORO (BDO)', note: 'First half' });
  assert.equal(paid.status, 200, JSON.stringify(paid.data));
  const po = (await GET(admin, '/api/bank-report/po-payments')).data.find((x) => Number(x.id) === paid.data.id);
  assert.ok(po, 'the PO payment is listed');
  assert.ok(po.po_no && po.supplier, 'with its PO no. and supplier');
  assert.ok('invoice_no' in po, "and the supplier's invoice no. the bill carries");
  assert.equal(Number(po.amount), 1200);
  // Kept by Payment Management's name for the bank (db/188).
  assert.equal(po.method, 'BDO');

  const cashier = await signIn('cashier');
  assert.notEqual((await GET(cashier, '/api/bank-report/po-payments')).status, 200);

  // The screen maps the columns as asked.
  const at = app.indexOf("if (view === 'bank') {");
  const block = app.slice(at, app.indexOf("if (view === 'sales')", at));
  assert.match(block, /ref: l\.si_no \|\| l\.entry_no \|\| '', party: l\.payor \|\| l\.memo \|\| ''/);
  assert.match(block, /ref: x\.invoice_no \|\| '—',\s*\n\s*party: x\.supplier, account: methodAccount\(x\.method\), dir: 'out'/,
    "a PO payment's Reference # is the supplier's invoice no., not the PO no.");
  assert.match(block, /note: \[`PO \$\{x\.po_no\}`, x\.method, x\.note\]/, 'the PO no. stays in Remarks');
  assert.match(block, /<option value="po">Purchase order payments<\/option>/);
});

test("Payment Management's Account list: add a bank, rename it, and the lines follow the new name", async () => {
  const admin = await signIn('admin');
  const name = unique('Metrobank');
  const added = await POST(admin, '/api/bank-report/accounts', { name });
  assert.equal(added.status, 200, JSON.stringify(added.data));
  assert.ok((await GET(admin, '/api/bank-report/accounts')).data.includes(name), 'on the list');
  assert.notEqual((await POST(admin, '/api/bank-report/accounts', { name: name.toUpperCase() })).status, 200,
    'the same name twice is refused, whatever its case');
  assert.notEqual((await POST(admin, '/api/bank-report/accounts', { name: '  ' })).status, 200);

  const ref = unique('REF');
  const rec = await POST(admin, '/api/bank-report/transactions', { txn_on: '2026-10-12', account: name,
    kind: 'instapay', direction: 'in', party: 'Bella Skin', amount: 500, reference: ref });
  assert.equal(rec.status, 200, JSON.stringify(rec.data));

  const to = unique('Metrobank Ortigas');
  const renamed = await request(admin, 'PUT', '/api/bank-report/accounts', { from: name, to });
  assert.equal(renamed.status, 200, JSON.stringify(renamed.data));
  const list = (await GET(admin, '/api/bank-report/accounts')).data;
  assert.ok(list.includes(to) && !list.includes(name));
  const line = (await GET(admin, '/api/bank-report/transactions')).data.find((t) => t.reference === ref);
  assert.equal(line.account, to, 'the recorded line carries the new name');
  assert.notEqual((await request(admin, 'PUT', '/api/bank-report/accounts', { from: to, to: 'BDO' })).status, 200,
    "can't rename onto a name already on the list");

  const cashier = await signIn('cashier');
  assert.notEqual((await GET(cashier, '/api/bank-report/accounts')).status, 200);
  assert.notEqual((await POST(cashier, '/api/bank-report/accounts', { name: 'X' })).status, 200);
  await assert.rejects(asRole('cashier', 'someone', "select bank_acct_add('X')"), /FORBIDDEN/);
});

// Sales' Status reads the invoice's standing the way Invoice tab does: a
// part-paid invoice past its due date is paid w/bal, not Overdue.
test("Sales' Status: paid / paid w/bal / unpaid, as Invoice tab reads it — never Overdue", () => {
  const at = app.indexOf("if (view === 'sales')");
  const block = app.slice(at, app.indexOf("if (view === 'purchases')", at));
  assert.match(block, /\{ head: 'Status', cell: \(i\) => brSalesStanding\(i\) \}/);
  const fn = block.slice(block.indexOf('const brSalesStanding'), block.indexOf('const groups'));
  assert.match(fn, /tag\('paid', 'green'\)/);
  assert.match(fn, /if \(paidSoFar\(i\) > 0\) return tag\('paid w\/bal', 'amber'\);/,
    'part-paid is paid w/bal, before any due-date check');
  assert.match(fn, /tag\('unpaid', i\.standing === 'overdue' \? 'red' : 'amber'\)/);
  assert.doesNotMatch(block, /'Overdue'/);
  assert.equal(app.match(/brSalesStanding\(/g).length, 1, "Sales' own, used nowhere else");
});

// One list of banks (db/188): Payment Management's. Mode of payment offers
// its banks by the names given there, plus CASH and FUNDS; renaming one
// there renames it on the payments already recorded, on a purchase order
// bill's payments, and on the Books account behind its Cash position box.
test('one bank list: Mode of payment follows Payment Management, and a rename carries everywhere', async () => {
  const admin = await signIn('admin');
  const modes = (await GET(admin, '/api/payment-modes')).data;
  assert.deepEqual(modes.slice(-2), ['CASH', 'FUNDS'], 'CASH and FUNDS, last, as they were');
  for (const b of ['BDO', 'BPI', 'Security Bank', 'GCash']) assert.ok(modes.includes(b), `${b} is offered`);
  assert.ok(!modes.includes('Bank') && !modes.includes('Cash on hand'), 'the two that are not banks are not offered');
  assert.ok(!modes.includes('BANCO DE ORO (BDO)'), 'no second name for BDO');

  // A new bank: offered at once, with a Books account and a BANK box.
  const name = unique('Landbank');
  assert.equal((await POST(admin, '/api/bank-report/accounts', { name })).status, 200);
  assert.ok((await GET(admin, '/api/payment-modes')).data.includes(name), 'a bank added is a Mode of payment');
  const box = (await GET(admin, '/api/bank-report/account-boxes')).data.find((x) => x.name === name);
  assert.equal(box.column, 'bank');
  assert.ok(box.coa_code, 'with a Books account of its own');

  // Paid through it — a supplier's bill, and (where there is an invoice) a customer.
  const bill = await newPOBill(admin, 900);
  const paid = await POST(admin, `/api/purchase-order-bills/${bill}/payments`, { amount: 300, method: name });
  assert.equal(paid.status, 200, JSON.stringify(paid.data));
  const inv = (await db.query('select id from invoices order by id limit 1')).rows[0];
  const pay = inv ? (await db.query(
    'insert into payments (invoice_id, amount, method) values ($1, 1, $2) returning id', [inv.id, name])).rows[0].id : null;

  const to = unique('LANDBANK OF THE PHILIPPINES');
  const r = await request(admin, 'PUT', '/api/bank-report/accounts', { from: name, to });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const after = (await GET(admin, '/api/payment-modes')).data;
  assert.ok(after.includes(to) && !after.includes(name), 'Mode of payment shows the new name only');
  const po = (await GET(admin, '/api/bank-report/po-payments')).data.find((x) => Number(x.id) === paid.data.id);
  assert.equal(po.method, to, "the bill payment already recorded reads the new name");
  if (pay) {
    assert.equal((await db.query('select method from payments where id = $1', [pay])).rows[0].method, to,
      "and so does the customer's");
    await db.query('delete from payments where id = $1', [pay]);
  }
  assert.equal((await db.query('select title from coa_accounts where code = $1', [box.coa_code])).rows[0].title, to,
    'the Books account behind the box is renamed with it');

  // The old wording still means the bank it always did.
  const bdo = (await GET(admin, '/api/bank-report/account-boxes')).data.find((x) => x.aliases.includes('BANCO DE ORO (BDO)'));
  const old = await POST(admin, `/api/purchase-order-bills/${bill}/payments`, { amount: 100, method: 'BANCO DE ORO (BDO)' });
  assert.equal(old.status, 200, JSON.stringify(old.data));
  const oldRow = (await GET(admin, '/api/bank-report/po-payments')).data.find((x) => Number(x.id) === old.data.id);
  assert.equal(oldRow.method, bdo.name, 'kept under the list\'s name');
  assert.notEqual((await POST(admin, `/api/purchase-order-bills/${bill}/payments`, { amount: 1, method: 'aaaaa' })).status, 200,
    'a bank not on the list is refused');
  assert.notEqual((await POST(admin, '/api/bank-report/accounts', { name: 'cash' })).status, 200, 'CASH is not a bank name');

  const cashier = await signIn('cashier');
  assert.notEqual((await GET(cashier, '/api/payment-modes')).status, 200);
  assert.notEqual((await GET(cashier, '/api/bank-report/account-boxes')).status, 200);
});

test('Payment Management is only Account, Rename, + Add bank and Save; every Mode of payment reads the list', () => {
  const at = app.indexOf("$('#bt_new', body).addEventListener('click'");
  const fn = app.slice(at, app.indexOf("if (view === 'sales')", at));
  const form = fn.slice(fn.indexOf('dialog(`'), fn.indexOf('`);'));
  for (const id of ['bt_account', 'bt_acct_rename', 'bt_acct_add', 'bt_acct_name', 'bt_go']) {
    assert.match(form, new RegExp(`id="${id}"`), `${id} stays`);
  }
  for (const id of ['bt_on', 'bt_type', 'bt_dir', 'bt_party', 'bt_amt', 'bt_ref', 'bt_note', 'bt_acct_save', 'bt_acct_cancel']) {
    assert.doesNotMatch(form, new RegExp(`id="${id}"`), `${id} is gone`);
  }
  assert.doesNotMatch(fn, /POST\('\/api\/bank-report\/transactions'/, 'Save no longer records a bank line');
  assert.match(fn, /PUT\('\/api\/bank-report\/accounts', \{ from, to: typed \}\)/);
  assert.match(fn, /POST\('\/api\/bank-report\/accounts', \{ name: typed \}\)/);

  // Record payment on Customer order, Purchase order's billing statement and
  // the account's Confirm the bank payment all read the list as they open.
  assert.match(app, /let MOP_OPTIONS = /);
  assert.match(app, /const refreshMops = async \(\) => \{\n  const list = await GET\('\/api\/payment-modes'\)/);
  for (const opener of ['async function recordInvoicePayment(', 'const billPaymentForm = async (bill, done) => {',
    "$$('[data-pay]').forEach((b) => b.addEventListener('click', async () => {"]) {
    const i = app.indexOf(opener);
    assert.ok(i > 0, opener);
    assert.match(app.slice(i, i + 300), /await refreshMops\(\);/, `${opener} reads the list first`);
  }
  assert.doesNotMatch(app, /BANCO DE ORO \(BDO\)/, 'no second name for BDO left on any screen');
});

// Payment Management, as the owner drew it: Account | Account no., Rename and
// Add bank under the number, and the List of mode of payment below (db/189).
test('Payment Management: Account, Account no., Rename / Add bank, and the List of mode of payment', async () => {
  const at = app.indexOf("$('#bt_new', body).addEventListener('click'");
  const fn = app.slice(at, app.indexOf("if (view === 'sales')", at));
  const form = fn.slice(fn.indexOf('dialog(`'), fn.indexOf('`);'));
  assert.match(form, /id="bt_account"[\s\S]*?id="bt_acct_no"[\s\S]*?id="bt_acct_rename"[\s\S]*?id="bt_acct_add"[\s\S]*?id="bt_go"[\s\S]*?List of mode of payment[\s\S]*?id="pm_list"/,
    'Account, then Account no. with Rename and Add bank under it, Save, then the list');
  assert.match(fn, /<th>Account<\/th><th>Account name<\/th><th>Account no\.<\/th>/);
  assert.match(fn, /pmBoxes\.filter\(\(x\) => x\.is_bank\)/, 'the list is the banks Mode of payment offers');
  assert.match(fn, /PUT\('\/api\/bank-report\/accounts\/details', \{ name, account_name: holder, account_no: no \}\)/);

  const admin = await signIn('admin');
  const name = unique('Unionbank');
  assert.equal((await POST(admin, '/api/bank-report/accounts', { name })).status, 200);
  const set = await request(admin, 'PUT', '/api/bank-report/accounts/number', { name, account_no: ' 0010-0014 ' });
  assert.equal(set.status, 200, JSON.stringify(set.data));
  let box = (await GET(admin, '/api/bank-report/account-boxes')).data.find((x) => x.name === name);
  assert.equal(box.account_no, '0010-0014', 'kept, trimmed');
  await request(admin, 'PUT', '/api/bank-report/accounts/number', { name, account_no: '' });
  box = (await GET(admin, '/api/bank-report/account-boxes')).data.find((x) => x.name === name);
  assert.equal(box.account_no, null, 'and can be cleared');
  assert.notEqual((await request(admin, 'PUT', '/api/bank-report/accounts/number', { name: 'no such', account_no: '1' })).status, 200);
  const cashier = await signIn('cashier');
  assert.notEqual((await request(cashier, 'PUT', '/api/bank-report/accounts/number', { name, account_no: '1' })).status, 200);
});

// The Customer order form's Bank account details come off Payment
// Management's list (db/190): each bank with an account no., by its name,
// account name and number. The invoice and the other papers keep their own.
test("Customer order form: Bank account details read Payment Management's list", async () => {
  const at = app.indexOf('function customerOrderForm(');
  const form = app.slice(at, app.indexOf('\n}\n', at));
  assert.match(form, /\$\{coBankDetails\(\)\}/, 'the form draws its own bank block');
  assert.doesNotMatch(form, /\$\{BANK_DETAILS\}/);
  assert.equal(app.match(/coBankDetails\(\)/g).length, 1, "the Customer order form's alone");
  assert.equal(app.match(/\$\{BANK_DETAILS\}/g).length, 4, 'the invoice and the other papers are untouched');
  assert.match(app, /function drawFrame\(\) \{\n  refreshCoBanks\(\);/, 'read after sign-in');
  const pm = app.slice(app.indexOf("$('#bt_new', body).addEventListener('click'"));
  assert.match(pm.slice(0, pm.indexOf("if (view === 'sales')")), /refreshCoBanks\(\);/, 'and again when Payment Management saves');

  const admin = await signIn('admin');
  const name = unique('RCBC');
  assert.equal((await POST(admin, '/api/bank-report/accounts', { name })).status, 200);
  let shown = (await GET(admin, '/api/co-bank-details')).data;
  assert.ok(!shown.some((b) => b.name === name), 'a bank with no account no. is not printed');
  const set = await request(admin, 'PUT', '/api/bank-report/accounts/details',
    { name, account_name: ' MS Beau Ave Enterprises OPC ', account_no: '123-456' });
  assert.equal(set.status, 200, JSON.stringify(set.data));
  shown = (await GET(admin, '/api/co-bank-details')).data;
  assert.deepEqual(shown.find((b) => b.name === name),
    { name, account_name: 'MS Beau Ave Enterprises OPC', account_no: '123-456' });
  const box = (await GET(admin, '/api/bank-report/account-boxes')).data.find((x) => x.name === name);
  assert.equal(box.account_name, 'MS Beau Ave Enterprises OPC', 'and Payment Management lists it');
  // The three the form always printed are on the list with their numbers.
  for (const no of ['010-338-012-751', '317-378-3972', '000-006-567-3032']) {
    assert.ok(shown.some((b) => b.account_no === no && b.account_name === 'MS Beau Ave Enterprises OPC'), no);
  }
  const orderdesk = await signIn('orderdesk');
  assert.equal((await GET(orderdesk, '/api/co-bank-details')).status, 200, 'whoever draws the form can read it');
  assert.notEqual((await request(orderdesk, 'PUT', '/api/bank-report/accounts/details', { name, account_no: '1' })).status, 200);
});

// The ✕ on Payment Management's List of mode of payment: an empty bank goes,
// one anything was recorded under stays (db/190).
test("List of mode of payment: ✕ removes a bank nothing was recorded under, and only that", async () => {
  const at = app.indexOf("$('#bt_new', body).addEventListener('click'");
  const fn = app.slice(at, app.indexOf("if (view === 'sales')", at));
  assert.match(fn, /data-pmdrop="\$\{esc\(x\.name\)\}"/, 'an ✕ on every row');
  assert.match(fn, /btn\.textContent = 'Remove\?';\n\s*return;/, 'asks once before removing');
  assert.match(fn, /POST\('\/api\/bank-report\/accounts\/remove', \{ name \}\)/);

  const admin = await signIn('admin');
  const empty = unique('Eastwest');
  assert.equal((await POST(admin, '/api/bank-report/accounts', { name: empty })).status, 200);
  const code = (await GET(admin, '/api/bank-report/account-boxes')).data.find((x) => x.name === empty).coa_code;
  const gone = await POST(admin, '/api/bank-report/accounts/remove', { name: empty });
  assert.equal(gone.status, 200, JSON.stringify(gone.data));
  assert.ok(!(await GET(admin, '/api/payment-modes')).data.includes(empty), 'off Mode of payment');
  assert.equal((await db.query('select 1 from coa_accounts where code = $1', [code])).rowCount, 0,
    'and its unused Books account with it');

  const used = unique('Metrobank');
  assert.equal((await POST(admin, '/api/bank-report/accounts', { name: used })).status, 200);
  const bill = await newPOBill(admin, 500);
  assert.equal((await POST(admin, `/api/purchase-order-bills/${bill}/payments`, { amount: 100, method: used })).status, 200);
  const kept = await POST(admin, '/api/bank-report/accounts/remove', { name: used });
  assert.notEqual(kept.status, 200, 'a bank payments went through stays');
  assert.match(JSON.stringify(kept.data), /so it stays/);
  assert.ok((await GET(admin, '/api/payment-modes')).data.includes(used));
  assert.notEqual((await POST(admin, '/api/bank-report/accounts/remove', { name: 'Cash on hand' })).status, 200,
    'Cash on hand is not a bank to remove');

  const cashier = await signIn('cashier');
  assert.notEqual((await POST(cashier, '/api/bank-report/accounts/remove', { name: used })).status, 200);
});

// GCash's box sits under BANK, after Security Bank (db/193): the list's own
// side for it, read only by Cash position.
test('Cash position: GCash sits under BANK, after Security Bank', async () => {
  const admin = await signIn('admin');
  const boxes = (await GET(admin, '/api/bank-report/account-boxes')).data;
  const gcash = boxes.find((x) => x.aliases.includes('GCASH'));
  assert.equal(gcash.column, 'bank');
  const bank = boxes.filter((x) => x.column === 'bank').map((x) => x.name);
  const sec = boxes.find((x) => x.aliases.includes('SECURITY BANK')).name;
  assert.ok(bank.indexOf(gcash.name) > bank.indexOf(sec), 'below Security Bank');
  assert.deepEqual(boxes.filter((x) => x.column === 'cash').map((x) => x.aliases), [['CASH']],
    'Cash on hand alone under CASH');
});

// Bank Transactions' Reference column: the reference no. a customer's payment
// was recorded with on Record payment, carried on its Books line.
test("Bank Transactions: a Reference column with the customer payment's reference no.", async () => {
  const at = app.indexOf("if (view === 'bank') {");
  const block = app.slice(at, app.indexOf("if (view === 'sales')", at));
  assert.match(block, /<th>Account<\/th>\n\s*<th>Reference<\/th>/);
  assert.match(block, /payref: l\.pay_ref \|\| ''/);
  assert.match(block, /<td>\$\{t\.payref \? esc\(t\.payref\) : '<span class="dim">—<\/span>'\}<\/td>/);

  const admin = await signIn('admin');
  const inv = (await db.query("select i.id from invoices i where i.status = 'open' order by i.id limit 1")).rows[0];
  if (!inv) return;
  const ref = unique('REF');
  await db.query(
    "insert into payments (invoice_id, amount, method, reference_no) values ($1, 1, 'BDO', $2) returning id",
    [inv.id, ref]);
  await POST(admin, '/api/books/sync');
  const line = (await GET(admin, '/api/bank-report/ledger')).data.find((l) => l.pay_ref === ref);
  assert.ok(line, 'the Books line carries the payment reference');
});
