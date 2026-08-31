// Books — auto-posting (Phase 5).
//
// The sweep reads the shop's real trading — counter sales, fulfilled invoices,
// payments on account — and posts the revenue side to the ledger. Three things
// have to be true and are checked here: it posts the right entry (cash or a
// receivable against Item Sales Revenue, and a receivable that nets to nothing
// once its invoice is settled), it posts each event exactly ONCE however often
// it runs, and it never touches a sale or a stock row. And it is the owner's.
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

// A completed counter sale (a shop order plus its till receipt).
async function counterSale(total, method = 'cash') {
  const o = (await db.query(
    `insert into orders (channel, status, subtotal, total, branch_id) values ('shop','fulfilled',$1,$1,$2) returning id`,
    [total, branch])).rows[0].id;
  const receipt = uniq('OR');
  const id = (await db.query(
    `insert into sales (order_id, receipt_no, method, total) values ($1,$2,$3,$4) returning id`,
    [o, receipt, method, total])).rows[0].id;
  return { order: o, sale: id, receipt };
}
// A fulfilled wholesale order with an invoice raised against a reseller.
async function wholesale(total) {
  const rid = (await db.query(`insert into resellers (name, status) values ($1,'active') returning id`, [uniq('RS')])).rows[0].id;
  const o = (await db.query(
    `insert into orders (channel, status, reseller_id, subtotal, total, branch_id)
     values ('b2b','fulfilled',$1,$2,$2,$3) returning id`, [rid, total, branch])).rows[0].id;
  const inv = (await db.query(
    `insert into invoices (order_id, reseller_id, due_on, amount) values ($1,$2,current_date + 30,$3) returning id`,
    [o, rid, total])).rows[0].id;
  return { reseller: rid, order: o, invoice: inv };
}
// The lines of whatever entry a source event became.
const linesFor = async (type, id) => (await db.query(
  `select l.account, l.debit, l.credit from journal_lines l
     join book_source_postings sp on sp.entry_id = l.entry_id
    where sp.source_type = $1 and sp.source_id = $2 order by l.account`, [type, id])).rows;
const mapCount = async (type, id) => Number((await db.query(
  `select count(*) as n from book_source_postings where source_type=$1 and source_id=$2`, [type, id])).rows[0].n);

test('a counter sale posts cash against sales revenue', async () => {
  const admin = await signIn('admin');
  const s = await counterSale(1000, 'cash');
  const posted = (await sync(admin)).data;
  assert.ok(Number(posted.counter) >= 1, 'at least my sale was posted');

  const lines = await linesFor('counter', s.sale);
  assert.equal(lines.length, 2, 'a two-line entry');
  const cash = lines.find((l) => l.account === '103');
  const rev = lines.find((l) => l.account === '402');
  assert.ok(cash && Number(cash.debit) === 1000, 'cash on hand is debited the total');
  assert.ok(rev && Number(rev.credit) === 1000, 'item sales revenue is credited the total');
});

test('a fulfilled invoice becomes a receivable that its payment clears', async () => {
  const admin = await signIn('admin');
  const w = await wholesale(5000);
  await sync(admin);
  let ar = await linesFor('invoice', w.invoice);
  assert.ok(ar.find((l) => l.account === '101' && Number(l.debit) === 5000), 'a receivable is raised');
  assert.ok(ar.find((l) => l.account === '402' && Number(l.credit) === 5000), 'against revenue');

  // Pay 4,900 with a 100 early-payment discount, and settle.
  const pay = (await db.query(
    `insert into payments (invoice_id, amount, method) values ($1,4900,'cash') returning id`, [w.invoice])).rows[0].id;
  await db.query(`update invoices set paid=4900, discount=100, status='paid', settled_on=current_date where id=$1`, [w.invoice]);
  await sync(admin);

  const payLines = await linesFor('payment', pay);
  assert.ok(payLines.find((l) => l.account === '103' && Number(l.debit) === 4900), 'cash comes in');
  assert.ok(payLines.find((l) => l.account === '101' && Number(l.credit) === 4900), 'and the receivable comes down');
  const disc = await linesFor('discount', w.invoice);
  assert.ok(disc.find((l) => l.account === '602' && Number(l.debit) === 100), 'the discount is a contra to revenue');

  // The whole receivable — raised, paid, discounted — nets to nothing.
  const net = Number((await db.query(
    `select coalesce(sum(l.debit - l.credit),0) as n from journal_lines l
      where l.account = '101' and l.entry_id in (
        select entry_id from book_source_postings
         where (source_type='invoice' and source_id=$1)
            or (source_type='discount' and source_id=$1)
            or (source_type='payment' and source_id=$2))`, [w.invoice, pay])).rows[0].n);
  assert.equal(net, 0, 'a settled invoice leaves nothing owed');
});

test('the sweep posts each event exactly once, however often it runs', async () => {
  const admin = await signIn('admin');
  const s = await counterSale(750);
  await sync(admin);
  assert.equal(await mapCount('counter', s.sale), 1, 'posted once');
  const again = (await sync(admin)).data;
  assert.equal(await mapCount('counter', s.sale), 1, 'and still once after a second sweep');
  // The second sweep did not re-post my sale (its own count may catch others', so check the map, not the tally).
  assert.ok(Number(again.total) >= 0);
});

test('the trial balance still ties after a sweep', async () => {
  const admin = await signIn('admin');
  await counterSale(1234, 'gcash');
  await wholesale(2222);
  await sync(admin);
  const t = (await req(admin, 'GET', '/api/books/trial-balance')).data.totals;
  assert.equal(Number(t.debits).toFixed(2), Number(t.credits).toFixed(2), 'debits equal credits');
});

test('auto-posting never touches a sale or a stock movement', async () => {
  const admin = await signIn('admin');
  const s = await counterSale(999);
  const sales0 = Number((await db.query('select count(*) as n from sales')).rows[0].n);
  const moves0 = Number((await db.query('select count(*) as n from movements')).rows[0].n);
  await sync(admin);
  const sales1 = Number((await db.query('select count(*) as n from sales')).rows[0].n);
  const moves1 = Number((await db.query('select count(*) as n from movements')).rows[0].n);
  assert.equal(sales1, sales0, 'no sale was added or removed');
  assert.equal(moves1, moves0, 'no stock moved');
  const still = (await db.query('select total from sales where id=$1', [s.sale])).rows[0];
  assert.equal(Number(still.total), 999, 'the sale itself is untouched');
});

test('auto-posting is the owner\'s — nobody else can read it or run it', async () => {
  for (const role of ['warehouse', 'orderdesk', 'datacoord', 'cashier', 'employee']) {
    const who = await signIn(role);
    assert.equal((await req(who, 'GET', '/api/books/sync')).status, 403, `${role} must not see what is pending`);
    assert.equal((await req(who, 'POST', '/api/books/sync')).status, 403, `${role} must not run the sweep`);
  }
});

test('the sweep is wired into the books app', async () => {
  const fs = await import('node:fs');
  const url = await import('node:url');
  const path = await import('node:path');
  const here = path.dirname(url.fileURLToPath(import.meta.url));
  const src = fs.readFileSync(path.join(here, '..', 'public/books/books.js'), 'utf8');
  assert.match(src, /syncOnLoad/, 'it catches up when the app opens');
  assert.match(src, /\/api\/books\/sync/, 'and there is a manual sweep too');
});
