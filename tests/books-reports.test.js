// Books — reports (Phase 4).
//
// Reports store nothing; every figure is read back off the journal, so they can
// never disagree with the books. The payables aging buckets open bills by how
// late they are; the cash-flow ties opening + in − out to the close; and the
// income statement for a period stands beside the one before it. Owner-only.
import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { hashPassword } from '../lib/auth.js';
import { server } from '../scripts/dev.js';
import { pool } from '../lib/db.js';

const db = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 4 });
let base;
test.before(async () => { await new Promise((d) => server.listen(0, d)); base = `http://127.0.0.1:${server.address().port}`; });
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
const dayFromNow = (n) => { const d = new Date(); d.setDate(d.getDate() + n); return d.toISOString().slice(0, 10); };
const expenseCode = async (admin) =>
  (await req(admin, 'GET', '/api/books/accounts')).data.find((a) => a.type === 'Expense').code;

test('the payables aging buckets open bills by how late they are', async () => {
  const admin = await signIn('admin');
  const exp = await expenseCode(admin);
  const v = await req(admin, 'POST', '/api/books/vendors', { name: uniq('AgingCo') });
  const bill = (due, amount) => req(admin, 'POST', '/api/books/bills',
    { vendor_id: v.data.id, bill_date: dayFromNow(-210), due_date: due, lines: [{ account: exp, amount }] });
  await bill(dayFromNow(-200), 900);  // over 90 days late
  await bill(dayFromNow(-45), 450);   // 31–60 days late
  await bill(dayFromNow(30), 300);    // not due yet

  const a = (await req(admin, 'GET', '/api/books/reports/aging')).data;
  const name = (await req(admin, 'GET', '/api/books/vendors')).data.find((z) => Number(z.id) === v.data.id).name;
  const row = a.vendors.find((r) => r.vendor === name);
  assert.ok(row, 'my supplier is on the aging');
  assert.equal(Number(row.over), 900, 'the ancient one is 90+');
  assert.equal(Number(row.d60), 450, '31–60 days');
  assert.equal(Number(row.notdue), 300, 'and one not due yet');
  assert.equal(Number(row.total), 1650);
});

test('the cash flow ties opening plus in minus out to the close', async () => {
  const admin = await signIn('admin');
  // An isolated month with nothing else in it: cash in 5,000, cash out 2,000.
  await req(admin, 'POST', '/api/books/journal', {
    entry_date: '2019-03-15', memo: 'A cash sale',
    lines: [{ account: '103', debit: 5000, credit: 0 }, { account: '402', debit: 0, credit: 5000 }] });
  await req(admin, 'POST', '/api/books/journal', {
    entry_date: '2019-03-20', memo: 'A cash cost',
    lines: [{ account: '507', debit: 2000, credit: 0 }, { account: '103', debit: 0, credit: 2000 }] });

  const c = (await req(admin, 'GET', '/api/books/reports/cashflow?from=2019-03-01&to=2019-03-31')).data;
  assert.equal(Number(c.opening), 0, 'nothing before this month');
  assert.equal(Number(c.total_in), 5000);
  assert.equal(Number(c.total_out), 2000);
  assert.equal(Number(c.net), 3000);
  assert.equal(Number(c.closing), 3000, 'opening + in − out');
  assert.ok(c.inflows.some((r) => Number(r.amount) === 5000), 'the sale is a named inflow');
  assert.ok(c.outflows.some((r) => Number(r.amount) === 2000), 'the cost is a named outflow');
});

test('the income statement covers the period and shows the one before it', async () => {
  const admin = await signIn('admin');
  await req(admin, 'POST', '/api/books/journal', {
    entry_date: '2018-06-15', memo: 'Period revenue',
    lines: [{ account: '103', debit: 8000, credit: 0 }, { account: '402', debit: 0, credit: 8000 }] });

  const s = (await req(admin, 'GET', '/api/books/reports/income?from=2018-06-01&to=2018-06-30')).data;
  assert.ok(Number(s.period.total_revenue) >= 8000, 'the period revenue is there');
  assert.equal(s.prior.to, '2018-05-31', 'the prior period ends the day before this one starts');
  // June 1–30 is thirty days; the prior window is the thirty days before it.
  assert.equal(s.prior.from, '2018-05-02', 'and is the same length');
  assert.equal(typeof s.prior.profit, 'number');
});

test('reports are the owner\'s — nobody else gets in', async () => {
  for (const role of ['warehouse', 'orderdesk', 'datacoord', 'cashier', 'employee']) {
    const who = await signIn(role);
    for (const p of ['/api/books/reports/aging', '/api/books/reports/cashflow', '/api/books/reports/income']) {
      assert.equal((await req(who, 'GET', p)).status, 403, `${role} must not read ${p}`);
    }
  }
});

test('the Reports screen is wired into the books app', async () => {
  const fs = await import('node:fs');
  const url = await import('node:url');
  const path = await import('node:path');
  const here = path.dirname(url.fileURLToPath(import.meta.url));
  const src = fs.readFileSync(path.join(here, '..', 'public/books/books.js'), 'utf8');
  assert.match(src, /\['reports', 'Reports'\]/, 'Reports is a tab');
  assert.match(src, /SCREENS\.reports\s*=/, 'and it has a screen');
  assert.match(src, /drawAging|drawCashflow|drawIncome/, 'with the three reports');
});
