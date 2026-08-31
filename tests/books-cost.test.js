// Books — the cost side (Phase 6).
//
// Perpetual inventory, driven from the stock the business already keeps: a
// receipt goes into inventory against a clearing account; a sale relieves
// inventory into cost of goods; and a true-up brings the book value of
// inventory to the actual stock on hand. So gross profit — revenue less the
// cost of what was sold — comes right, and the balance sheet carries a real
// inventory asset. Additive, idempotent, owner-only.
import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { hashPassword } from '../lib/auth.js';
import { server } from '../scripts/dev.js';
import { pool } from '../lib/db.js';

const db = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 4 });
let base, branch;
test.before(async () => {
  await new Promise((d) => server.listen(0, d));
  base = `http://127.0.0.1:${server.address().port}`;
  branch = (await db.query('select id from branches order by id limit 1')).rows[0].id;
});
test.after(async () => { await new Promise((d) => server.close(d)); await pool.end(); await db.end(); });

let seq = 0;
const uniq = (p) => `${p}-${process.pid}-${Date.now()}-${++seq}`;
async function req(cookie, method, p, body) {
  const r = await fetch(`${base}${p}`, { method,
    headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, data: await r.json().catch(() => ({})) };
}
async function signIn(role) {
  const u = uniq(role);
  await db.query(`insert into app_users (username, display_name, password_hash, role) values ($1,$1,$2,$3)`,
    [u, hashPassword('secret123'), role]);
  const r = await fetch(`${base}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: u, password: 'secret123' }) });
  return (r.headers.getSetCookie?.()[0] ?? r.headers.get('set-cookie')).split(';')[0];
}
const sync = (admin) => req(admin, 'POST', '/api/books/sync');
const balanceOf = async (admin, code) => {
  const r = (await req(admin, 'GET', '/api/books/trial-balance')).data.rows.find((x) => x.code === code);
  return r ? Number(r.balance) : 0;
};
const linesFor = async (type, id) => (await db.query(
  `select l.account, l.debit, l.credit from journal_lines l
     join book_source_postings sp on sp.entry_id = l.entry_id
    where sp.source_type = $1 and sp.source_id = $2 order by l.account`, [type, id])).rows;
const mapCount = async (type, id) => Number((await db.query(
  `select count(*) as n from book_source_postings where source_type=$1 and source_id=$2`, [type, id])).rows[0].n);

async function product(unitCost) {
  const sku = uniq('SKU');
  await db.query(`insert into products (sku, name, brand, category, unit_cost) values ($1,$1,'Beau','Serum',$2)`,
    [sku, unitCost]);
  const batch = (await db.query(
    `insert into batches (sku, batch_no, expiry, qty_received) values ($1,$2, current_date + 365, 1000) returning id`,
    [sku, uniq('B')])).rows[0].id;
  return { sku, batch };
}
// A completed counter sale of `qty` at `price`, costed at `cost` each.
async function stockedSale(qty, price, cost) {
  const { sku, batch } = await product(cost);
  const o = (await db.query(
    `insert into orders (channel, status, subtotal, total, branch_id) values ('shop','fulfilled',$1,$1,$2) returning id`,
    [qty * price, branch])).rows[0].id;
  await db.query(`insert into order_lines (order_id, sku, batch_id, qty, unit_price, unit_cost) values ($1,$2,$3,$4,$5,$6)`,
    [o, sku, batch, qty, price, cost]);
  const sale = (await db.query(`insert into sales (order_id, receipt_no, method, total) values ($1,$2,'cash',$3) returning id`,
    [o, uniq('OR'), qty * price])).rows[0].id;
  return { sku, batch, order: o, sale, cost: qty * cost, revenue: qty * price };
}
async function stockedInvoice(qty, price, cost) {
  const { sku, batch } = await product(cost);
  const rid = (await db.query(`insert into resellers (name, status) values ($1,'active') returning id`, [uniq('RS')])).rows[0].id;
  const o = (await db.query(
    `insert into orders (channel, status, reseller_id, subtotal, total, branch_id) values ('b2b','fulfilled',$1,$2,$2,$3) returning id`,
    [rid, qty * price, branch])).rows[0].id;
  await db.query(`insert into order_lines (order_id, sku, batch_id, qty, unit_price, unit_cost) values ($1,$2,$3,$4,$5,$6)`,
    [o, sku, batch, qty, price, cost]);
  const inv = (await db.query(`insert into invoices (order_id, reseller_id, due_on, amount) values ($1,$2,current_date+30,$3) returning id`,
    [o, rid, qty * price])).rows[0].id;
  return { invoice: inv, cost: qty * cost };
}

test('Cost of Stocks Sold is now an expense, so it lands on the income statement', async () => {
  const admin = await signIn('admin');
  const a = (await req(admin, 'GET', '/api/books/accounts')).data.find((x) => x.code === '105');
  assert.ok(a, 'the account is there');
  assert.equal(a.type, 'Expense', 'reclassified from asset');
});

test('a counter sale relieves inventory into cost of goods', async () => {
  const admin = await signIn('admin');
  const s = await stockedSale(10, 100, 50);   // sell 10 @ 100, cost 50 → COGS 500
  await sync(admin);
  const l = await linesFor('cogs_counter', s.sale);
  assert.ok(l.find((x) => x.account === '105' && Number(x.debit) === 500), 'cost of goods debited');
  assert.ok(l.find((x) => x.account === '104' && Number(x.credit) === 500), 'inventory credited');
});

test('a wholesale invoice carries its cost, matched to the same event', async () => {
  const admin = await signIn('admin');
  const w = await stockedInvoice(4, 250, 90);  // COGS 360
  await sync(admin);
  const l = await linesFor('cogs_invoice', w.invoice);
  assert.ok(l.find((x) => x.account === '105' && Number(x.debit) === 360));
  assert.ok(l.find((x) => x.account === '104' && Number(x.credit) === 360));
});

test('stock received goes into inventory against the clearing account', async () => {
  const admin = await signIn('admin');
  const { batch } = await product(0);
  const e = (await db.query(
    `insert into expenses (kind, description, amount, spent_on, source, batch_id)
     values ('stock','A delivery',$1, current_date, 'receiving', $2) returning id`, [7500, batch])).rows[0].id;
  await sync(admin);
  const l = await linesFor('receiving', e);
  assert.ok(l.find((x) => x.account === '104' && Number(x.debit) === 7500), 'into inventory');
  assert.ok(l.find((x) => x.account === '805' && Number(x.credit) === 7500), 'goods received, not yet billed');
});

test('the cost side posts each event once, and the trial balance still ties', async () => {
  const admin = await signIn('admin');
  const s = await stockedSale(3, 200, 70);
  await sync(admin);
  assert.equal(await mapCount('cogs_counter', s.sale), 1, 'posted once');
  await sync(admin);
  assert.equal(await mapCount('cogs_counter', s.sale), 1, 'still once');
  const t = (await req(admin, 'GET', '/api/books/trial-balance')).data.totals;
  assert.equal(Number(t.debits).toFixed(2), Number(t.credits).toFixed(2), 'debits equal credits');
});

test('valuing the stockroom brings inventory to the actual stock on hand', async () => {
  const admin = await signIn('admin');
  const { sku, batch } = await product(50);
  await db.query(`insert into stock (batch_id, pool, on_hand, branch_id) values ($1,'shop',20,$2)`, [batch, branch]);

  const out = (await req(admin, 'POST', '/api/books/value-inventory')).data;
  const actual = Number((await db.query(
    `select coalesce(sum(s.on_hand * p.unit_cost),0) v
       from stock s join batches b on b.id=s.batch_id join products p on p.sku=b.sku`)).rows[0].v);
  assert.equal(Number(out.actual).toFixed(2), actual.toFixed(2), 'it valued the real stock');
  assert.equal((await balanceOf(admin, '104')).toFixed(2), actual.toFixed(2), 'and inventory now equals it');

  // Run again — nothing left to adjust.
  const again = (await req(admin, 'POST', '/api/books/value-inventory')).data;
  assert.equal(Number(again.adjusted), 0, 'a second valuing finds nothing to do');
  void sku;
});

test('valuing the stockroom is the owner\'s alone', async () => {
  for (const role of ['warehouse', 'orderdesk', 'datacoord', 'cashier', 'employee']) {
    const who = await signIn(role);
    assert.equal((await req(who, 'POST', '/api/books/value-inventory')).status, 403);
  }
});
