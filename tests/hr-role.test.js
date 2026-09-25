// HR and the operations manager.
//
// Two people run the people half of this company, and until this role existed
// both of them were admin — because admin was the only sign-in that could open
// Team, HR and Payroll. The price of being able to approve somebody's leave
// was the pricelist, the company's money and the sign-ins.
//
// So the point of this file is the same as the observer's: mostly negatives. A
// smaller role that quietly reaches the till or the catalogue is the old
// access with a new name on it. The refusals are checked past the router as
// well, against require_role, because a route list can be rewritten tomorrow
// and that function cannot be talked round.
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
const PUT = (c, p, b) => request(c, 'PUT', p, b ?? {});

async function signIn(role) {
  const username = unique(role);
  await db.query(
    `insert into app_users (username, display_name, password_hash, role)
     values ($1,$1,$2,$3)`, [username, hashPassword('secret123'), role]);
  const res = await fetch(`${base}/api/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password: 'secret123' }) });
  assert.equal(res.status, 200, `could not sign in as ${role}`);
  const raw = (res.headers.getSetCookie?.()[0] ?? res.headers.get('set-cookie')).split(';')[0];
  return Object.assign(raw, { username });
}

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

// ---------------------------------------------------------------------------
// The four screens
// ---------------------------------------------------------------------------
test('the menu is those four screens and nothing else', () => {
  const at = app.indexOf('\n  hr: [');
  assert.ok(at > 0, 'the role has a menu');
  const menu = app.slice(at, app.indexOf('\n  ],', at));
  const ids = [...menu.matchAll(/\['([a-z]+)',/g)].map((m) => m[1]);
  assert.deepEqual(ids, ['team', 'hr', 'payroll', 'attendance', 'me']);
});

test('the Payroll table has an Other charges column, after Loan/CA', () => {
  const at = app.indexOf('SCREENS.payroll = async');
  const screen = app.slice(at, app.indexOf('\nconst LOAN_LINES', at));
  const heads = [...screen.matchAll(/head: '([^']*)'/g)].map((m) => m[1]);
  const loan = heads.indexOf('Loan/ CA');
  const other = heads.indexOf('Oth. chg.');
  assert.ok(loan > 0 && other === loan + 1, 'right after Loan/CA, not somewhere else');
  assert.match(screen, /box\(r, 'other_charges', '0\.01'\)/, 'typed straight into the line, like Loan/CA');

  // The payslip's own Deductions table reads total_deductions off the same
  // line, so its itemised rows have to add up to the same figure or the
  // printed slip stops reconciling with its own total.
  const slip = app.slice(app.indexOf('function payslip('));
  assert.match(slip, /line\('Other Charges', null, r\.other_charges\)/,
    'the payslip has its own line for it, so Total Deductions still adds up');
});

// Allow./ day, not the old bare Allow. — a plain rename would leave whoever
// runs payroll typing what they think is the whole cutoff's figure into a
// box that is actually read as a day rate now.
test('Allowance reads as a rate per day, on the table and on the payslip alike', () => {
  const at = app.indexOf('SCREENS.payroll = async');
  const screen = app.slice(at, app.indexOf('\nconst LOAN_LINES', at));
  assert.match(screen, /head: 'Allow\.\/ day', n: true, cell: \(r\) => box\(r, 'allowance', '0\.01'\)/,
    'the header itself says it is a day rate now');
  assert.match(screen, /r\.allowance_total = Number\(r\.allowance \|\| 0\) \* Number\(r\.days_present \|\| 0\)/,
    "the screen's own live preview multiplies it out the same way the database will");
  assert.match(screen, /r\.allowance_total \+ Number\(r\.adjustment \|\| 0\)/,
    'and Earnings adds the multiplied figure, not the bare rate typed');

  const slip = app.slice(app.indexOf('function payslip('));
  assert.match(slip, /line\('Allowance', days\(r\.days_present\), r\.allowance_total\)/,
    'the payslip shows the day count beside it and the multiplied total, the same way Basic Pay does');
});

test('the role picker offers it, and the badge has a name for it', () => {
  const at = app.indexOf('const ROLES = [');
  const list = app.slice(at, app.indexOf('];', at));
  assert.match(list, /\['hr',/, 'a role a sign-in can be set to');
  assert.match(app, /hr: 'HR \/ Operations'/, 'and it is not shown as a bare code');
});

// Every read the five screens make. The branch dropdown is on this list because
// it was not: the Team screen fetches the branches separately from the table,
// so the table filled in and the dropdown stayed empty with nothing to say why.
test('the people screens answer them', async () => {
  const hr = await signIn('hr');
  for (const p of ['/api/team', '/api/hr', '/api/payroll', '/api/advances',
    '/api/team/hours', '/api/hr/attendance', '/api/branches']) {
    const r = await GET(hr, p);
    assert.equal(r.status, 200, `${p} answered ${r.status}`);
  }
});

// Clocking somebody was a cashier's job because the till stands by the door.
// The person who keeps the hours is at least as entitled to correct them, and
// the button was on her screen either way.
test('they can clock somebody in and out', async () => {
  const hr = await signIn('hr');
  const made = await POST(hr, '/api/team', { name: unique('Clocked'), position: 'Live Seller' });
  assert.equal(made.status, 200, JSON.stringify(made.data));

  assert.equal((await POST(hr, `/api/team/${made.data.id}/clock`, {})).status, 200);
  assert.equal((await POST(hr, `/api/team/${made.data.id}/clock`,
    { direction: 'out' })).status, 200);
});

// The fifth screen, and the one that was missed: the route had been opened up
// and the five functions behind it had not, so My record refused the person it
// belongs to. A role goes in require_role, not only in a route list.
test('and so does their own record — they work here too', async () => {
  const hr = await signIn('hr');
  const branch = (await db.query('select id from branches order by id limit 1')).rows[0];
  await db.query(
    `insert into employees (name, position, branch_id, user_id)
     values ($1, 'HR Officer', $2, (select id from app_users where username = $3))`,
    [`Person ${hr.username}`, branch?.id ?? null, hr.username]);

  const r = await GET(hr, '/api/my');
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.profile.name, `Person ${hr.username}`, 'their own row, not the first one');
});

// ---------------------------------------------------------------------------
// The job, in full — the reason for taking them off admin is that this role is
// enough on its own. A role that has to be worked around is not a smaller one.
// ---------------------------------------------------------------------------
test('they can hire somebody, set their pay and run a cutoff', async () => {
  const hr = await signIn('hr');

  const made = await POST(hr, '/api/team', { name: unique('Hired'), position: 'Live Seller' });
  assert.equal(made.status, 200, JSON.stringify(made.data));
  const who = made.data.id;

  assert.equal((await POST(hr, `/api/hr/people/${who}/employment`,
    { department: 'Retail', salary: 22000 })).status, 200, 'what they are on');
  assert.equal((await POST(hr, `/api/team/${who}/pay`,
    { daily_rate: 695, sss: 450, philhealth: 200, pagibig: 200 })).status, 200,
    'their daily rate');
  assert.equal((await POST(hr, `/api/team/${who}/email`,
    { email: 'someone@example.com' })).status, 200, 'where their payslip goes');
  assert.equal((await POST(hr, '/api/hr/announcements',
    { title: unique('Notice'), body: 'Body' })).status, 200, 'a notice');

  const cutoff = await POST(hr, '/api/payroll',
    { company: 'MS BEAU', starts_on: '2026-08-01', ends_on: '2026-08-15' });
  assert.equal(cutoff.status, 200, JSON.stringify(cutoff.data));
  assert.equal((await POST(hr, `/api/payroll/${cutoff.data.id}/close`, {})).status, 200,
    'and they can close it, which used to be the owner only');
});

// A cutoff no longer waits on somebody clicking Take it off — every running
// loan or cash advance takes its own per-cutoff amount the moment the
// cutoff opens, the same arithmetic, run for everyone at once.
test('a running loan takes itself off automatically when a cutoff opens', async () => {
  const admin = await signIn('admin');
  const branch = (await db.query('select id from branches order by id limit 1')).rows[0];
  const emp = (await db.query(
    `insert into employees (name, position, branch_id, company, daily_rate)
     values ($1, 'Live Seller', $2, 'MS BEAU', 500) returning id`,
    [unique('AutoLoan'), branch?.id ?? null])).rows[0];

  const advance = await POST(admin, '/api/advances',
    { employee_id: emp.id, kind: 'ca', principal: 5000, per_cutoff: 1200,
      started_on: '2026-01-01', note: 'test' });
  assert.equal(advance.status, 200, JSON.stringify(advance.data));

  const cutoff = await POST(admin, '/api/payroll',
    { company: 'MS BEAU', starts_on: '2030-01-01', ends_on: '2030-01-15' });
  assert.equal(cutoff.status, 200, JSON.stringify(cutoff.data));

  const line = (await db.query(
    'select loans from payroll_lines where period_id = $1 and employee_id = $2',
    [cutoff.data.id, emp.id])).rows[0];
  assert.equal(Number(line.loans), 1200, 'the per-cutoff amount was taken by itself');

  const ledger = (await db.query(
    'select balance from advance_balances where id = $1', [advance.data.id])).rows[0];
  assert.equal(Number(ledger.balance), 3800, 'and the ledger agrees with the cutoff');
});

test('a loan down to less than a cutoff\'s worth only takes what is left', async () => {
  const admin = await signIn('admin');
  const branch = (await db.query('select id from branches order by id limit 1')).rows[0];
  const emp = (await db.query(
    `insert into employees (name, position, branch_id, company, daily_rate)
     values ($1, 'Live Seller', $2, 'MS BEAU', 500) returning id`,
    [unique('AutoLoanSmall'), branch?.id ?? null])).rows[0];

  const advance = await POST(admin, '/api/advances',
    { employee_id: emp.id, kind: 'ca', principal: 500, per_cutoff: 1200,
      started_on: '2026-01-01', note: 'test' });
  assert.equal(advance.status, 200, JSON.stringify(advance.data));

  const cutoff = await POST(admin, '/api/payroll',
    { company: 'MS BEAU', starts_on: '2030-02-01', ends_on: '2030-02-15' });
  assert.equal(cutoff.status, 200, JSON.stringify(cutoff.data));

  const line = (await db.query(
    'select loans from payroll_lines where period_id = $1 and employee_id = $2',
    [cutoff.data.id, emp.id])).rows[0];
  assert.equal(Number(line.loans), 500, 'capped at what is actually still owed');

  const ledger = (await db.query(
    'select balance from advance_balances where id = $1', [advance.data.id])).rows[0];
  assert.equal(Number(ledger.balance), 0, 'and the loan is now settled');
});

// Hourly is a real third way of being paid, not daily wearing a different
// label — basic comes from the hours the clock actually counted, not a
// borrowed daily rate.
test('an hourly person is paid from the hours the clock counted, not a day', async () => {
  const admin = await signIn('admin');
  const branch = (await db.query('select id from branches order by id limit 1')).rows[0];
  const emp = (await db.query(
    `insert into employees (name, position, branch_id, company)
     values ($1, 'Live Seller Host', $2, 'MS BEAU') returning id`,
    [unique('Hourly'), branch?.id ?? null])).rows[0];

  const pay = await POST(admin, `/api/team/${emp.id}/pay`,
    { company: 'MS BEAU', pay_basis: 'hourly', hourly_rate: 100 });
  assert.equal(pay.status, 200, JSON.stringify(pay.data));

  const checkBasis = (await db.query(
    'select pay_basis, hourly_rate, daily_rate from employees where id = $1', [emp.id])).rows[0];
  assert.equal(checkBasis.pay_basis, 'hourly');
  assert.equal(Number(checkBasis.hourly_rate), 100);
  assert.equal(Number(checkBasis.daily_rate), 0, 'the rate that is not theirs is cleared');

  // Five hours on the clock, inside the cutoff about to open.
  await db.query(
    `insert into shifts (employee_id, business_date, started_at, ended_at)
     values ($1, '2030-04-05', '2030-04-05 09:00:00+00', '2030-04-05 14:00:00+00')`,
    [emp.id]);

  const cutoff = await POST(admin, '/api/payroll',
    { company: 'MS BEAU', starts_on: '2030-04-01', ends_on: '2030-04-15' });
  assert.equal(cutoff.status, 200, JSON.stringify(cutoff.data));

  const line = (await db.query(
    'select hours_present, days_present from payroll_lines where period_id = $1 and employee_id = $2',
    [cutoff.data.id, emp.id])).rows[0];
  assert.equal(Number(line.hours_present), 5, 'the hours between clocking in and out');
  assert.equal(Number(line.days_present), 1, 'the day is still counted too');

  const summary = (await db.query(
    'select basic, daily_rate from payroll_summary where period_id = $1 and employee_id = $2',
    [cutoff.data.id, emp.id])).rows[0];
  assert.equal(Number(summary.basic), 500, '5 hours at ₱100/hour, not 1 day at anything');
  assert.equal(Number(summary.daily_rate), 800,
    'the day-equivalent used for overtime and lateness is the hourly rate times 8');
});

// A charge that is neither a government contribution nor a loan off a
// ledger — typed straight into its own column, the same way Loan/CA is, and
// it comes off Net pay the same way everything else in Deductions does.
test('Other charges is its own deduction, on top of Loan/CA', async () => {
  const admin = await signIn('admin');
  const branch = (await db.query('select id from branches order by id limit 1')).rows[0];
  const emp = (await db.query(
    `insert into employees (name, position, branch_id, company, daily_rate)
     values ($1, 'Live Seller', $2, 'MS BEAU', 500) returning id`,
    [unique('OtherCharges'), branch?.id ?? null])).rows[0];

  const cutoff = await POST(admin, '/api/payroll',
    { company: 'MS BEAU', starts_on: '2030-05-01', ends_on: '2030-05-15' });
  assert.equal(cutoff.status, 200, JSON.stringify(cutoff.data));

  const line = (await db.query(
    'select id from payroll_lines where period_id = $1 and employee_id = $2',
    [cutoff.data.id, emp.id])).rows[0];

  const before = (await db.query(
    'select total_deductions, net_pay from payroll_summary where id = $1', [line.id])).rows[0];

  const saved = await PUT(admin, `/api/payroll-lines/${line.id}`, { other_charges: 150 });
  assert.equal(saved.status, 200, JSON.stringify(saved.data));

  const after = (await db.query(
    'select other_charges, total_deductions, net_pay from payroll_summary where id = $1',
    [line.id])).rows[0];
  assert.equal(Number(after.other_charges), 150);
  assert.equal(Number(after.total_deductions), Number(before.total_deductions) + 150,
    'it adds to Deductions like everything else there');
  assert.equal(Number(after.net_pay), Number(before.net_pay) - 150,
    'and comes off Net pay the same way');
});

// A rate per day, not a flat figure typed once for the whole cutoff — the
// owner typed 60 against a line that had worked 13 days and expected 780,
// not 60, added to Earnings.
test('Allowance multiplies by days present, the same way Basic already does', async () => {
  const admin = await signIn('admin');
  const branch = (await db.query('select id from branches order by id limit 1')).rows[0];
  const emp = (await db.query(
    `insert into employees (name, position, branch_id, company, daily_rate)
     values ($1, 'Live Seller', $2, 'MS BEAU', 500) returning id`,
    [unique('AllowTimesDays'), branch?.id ?? null])).rows[0];

  const cutoff = await POST(admin, '/api/payroll',
    { company: 'MS BEAU', starts_on: '2030-06-01', ends_on: '2030-06-15' });
  assert.equal(cutoff.status, 200, JSON.stringify(cutoff.data));

  const line = (await db.query(
    'select id from payroll_lines where period_id = $1 and employee_id = $2',
    [cutoff.data.id, emp.id])).rows[0];

  const saved = await PUT(admin, `/api/payroll-lines/${line.id}`,
    { days_present: 13, allowance: 60 });
  assert.equal(saved.status, 200, JSON.stringify(saved.data));

  const after = (await db.query(
    'select allowance, allowance_total, total_earnings from payroll_summary where id = $1',
    [line.id])).rows[0];
  assert.equal(Number(after.allowance), 60, 'the rate typed is kept as typed');
  assert.equal(Number(after.allowance_total), 780, '60 a day for 13 days present');
  assert.equal(Number(after.total_earnings), 500 * 13 + 780,
    'Basic (500/day \xd7 13) plus the multiplied allowance, nothing left flat');
});

// A loan whose own Since date has not arrived yet is not this cutoff's
// business — caught only after five loans across three people were taken
// off before their agreed start, on 2026-09-23.
test('a loan is left alone until its own start date arrives', async () => {
  const admin = await signIn('admin');
  const branch = (await db.query('select id from branches order by id limit 1')).rows[0];
  const emp = (await db.query(
    `insert into employees (name, position, branch_id, company, daily_rate)
     values ($1, 'Live Seller', $2, 'MS BEAU', 500) returning id`,
    [unique('NotYetLoan'), branch?.id ?? null])).rows[0];

  const advance = await POST(admin, '/api/advances',
    { employee_id: emp.id, kind: 'sss', loan_type: 'salary', principal: 5000, per_cutoff: 1200,
      started_on: '2031-01-01', note: 'starts later' });
  assert.equal(advance.status, 200, JSON.stringify(advance.data));

  const cutoff = await POST(admin, '/api/payroll',
    { company: 'MS BEAU', starts_on: '2030-03-01', ends_on: '2030-03-15' });
  assert.equal(cutoff.status, 200, JSON.stringify(cutoff.data));

  const line = (await db.query(
    'select loans from payroll_lines where period_id = $1 and employee_id = $2',
    [cutoff.data.id, emp.id])).rows[0];
  assert.equal(Number(line.loans), 0, 'nothing taken — the cutoff is paid before Since');

  const ledger = (await db.query(
    'select balance from advance_balances where id = $1', [advance.data.id])).rows[0];
  assert.equal(Number(ledger.balance), 5000, 'and the ledger has not moved');
});

// ---------------------------------------------------------------------------
// Everything else
// ---------------------------------------------------------------------------
test('nothing outside the people half answers them', async () => {
  const hr = await signIn('hr');
  const shut = [
    ['GET', '/api/dashboard'],
    ['GET', '/api/till/products'],
    ['GET', '/api/users'],
    ['GET', '/api/reports/valuation'],
    ['GET', '/api/pricelist'],
    ['GET', '/api/finance'],
    ['POST', '/api/products', { sku: 'X', name: 'X' }],
    ['POST', '/api/users', { username: 'x', password: 'password1', role: 'admin' }],
    ['POST', '/api/expenses', { amount: 1 }],
    ['POST', '/api/promos', { name: 'X' }],
  ];
  for (const [method, p, body] of shut) {
    const r = await { GET, POST, PUT }[method](hr, p, body);
    assert.equal(r.status, 403, `${method} ${p} answered ${r.status}, not 403`);
  }
});

test('the database refuses them, not only the router', async () => {
  const hr = await signIn('hr');
  for (const [sql, params] of [
    ['select set_price($1,$2,$3)', ['ANY', 'srp', 1]],
    ['select create_login($1,$2,$3,$4)', ['x', 'x', 'x', 'admin']],
    ['select record_expense($1,$2,$3)', ['other', 'X', 1]],
  ]) {
    await assert.rejects(() => asRole('hr', hr.username, sql, params), /FORBIDDEN/, sql);
  }
});

test('they cannot read the money or the catalogue underneath the screens', async () => {
  const hr = await signIn('hr');
  for (const table of ['products', 'sales', 'expenses']) {
    const r = await asRole('hr', hr.username, `select * from ${table} limit 1`);
    assert.equal(r.rows.length, 0, `${table} gives them nothing`);
  }
});
