// Somebody who may look and not touch.
//
// The point of this role is a negative, so nearly every test here is one. A
// read-only tier that quietly permits one write is worse than no tier at all:
// it is the same access as before, with a name that says otherwise.
//
// The mechanism being tested is not the route list. It is require_role, which
// every function that changes anything asks first and which never accepts an
// observer — so the tests that matter call those functions directly, past the
// router, the way a second application or a mistake in a year's time would.
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
const db = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 10 });
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
const PUT = (c, p, b) => request(c, 'PUT', p, b ?? {});
const DELETE = (c, p) => request(c, 'DELETE', p);

async function signIn(role) {
  const username = unique(role);
  await db.query(
    `insert into app_users (username, display_name, password_hash, role)
     values ($1,$1,$2,$3)`, [username, hashPassword('secret123'), role]);
  const res = await fetch(`${base}/api/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password: 'secret123' }),
  });
  assert.equal(res.status, 200, `could not sign in as ${role}`);
  const raw = res.headers.getSetCookie?.()[0] ?? res.headers.get('set-cookie');
  return Object.assign(raw.split(';')[0], { username });
}

/** Run one statement with a role's own rights, past every route. */
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
// The rule the browser applies before sending anything
//
// Manners rather than security — the server refuses these too, and that is the
// guard that counts. But the first version read the method alone, and signing
// out is a POST because it clears a cookie. So a view-only sign-in could see
// everything and could not leave.
//
// Lifted out of the shipped file rather than copied, because a copy of a rule
// is not the rule.
// ---------------------------------------------------------------------------
const app = fs.readFileSync(
  path.join(here, '..', 'public', 'app.js'), 'utf8');
const ruleSrc = app.slice(app.indexOf('const OWN_BUSINESS ='), app.indexOf('async function call('));
assert.ok(ruleSrc.includes('heldBack'), 'the rule moved; this test needs updating');
const heldBack = new Function(`${ruleSrc.replace('export const', 'const')} return heldBack;`)();

test('a view-only sign-in can always sign out', () => {
  assert.equal(heldBack('observer', 'POST', '/api/logout'), false,
    'leaving is not a change to the company');
  assert.equal(heldBack('observer', 'POST', '/api/team'), true);
  assert.equal(heldBack('observer', 'PUT', '/api/products/X'), true);
  assert.equal(heldBack('observer', 'DELETE', '/api/team/1'), true);
});

test('a view-only sign-in can always change its own password', () => {
  // The same shape as signing out: their own way in is not the company's, and
  // a manager who may not change a price should not be stuck for good with the
  // password somebody printed for them.
  assert.equal(heldBack('observer', 'POST', '/api/my/password'), false);
  // And it stays the narrow exception it was written to be.
  assert.equal(heldBack('observer', 'POST', '/api/users/1/password'), true,
    'somebody else\'s password is very much the company\'s business');
});

test('a figure they may not see gets no tile', () => {
  // It drew "₱0.00 monthly payroll" and the literal word "null" underneath it.
  // Both numbers were correctly withheld by the server and then rendered
  // anyway. A zero is worse than a blank, because a zero reads as a fact.
  const hr = app.slice(app.indexOf('SCREENS.hr ='));
  const tiles = hr.slice(0, hr.indexOf('</div>\n\n      <div class="panel"'));
  assert.match(tiles, /payroll_monthly == null \? '' :/,
    'the pay tiles must be left out entirely when the figure is withheld');
  assert.ok(tiles.indexOf('figures.payroll_monthly == null') < tiles.indexOf('peso(d.figures.payroll_monthly)'),
    'the guard has to come before the tile it guards');
});

test('reading is never held back, and nobody else is held back at all', () => {
  assert.equal(heldBack('observer', 'GET', '/api/dashboard'), false);
  for (const role of ['admin', 'employee', 'cashier', undefined]) {
    assert.equal(heldBack(role, 'POST', '/api/team'), false, String(role));
  }
});

// ---------------------------------------------------------------------------
// What they may see
// ---------------------------------------------------------------------------
test('an observer can read the company without being an owner', async () => {
  const watcher = await signIn('observer');
  for (const path of ['/api/dashboard', '/api/products', '/api/orders', '/api/team',
    '/api/branches', '/api/workspace', '/api/promos', '/api/customers', '/api/resellers',
    '/api/reorder', '/api/restock', '/api/hr', '/api/hr/attendance', '/api/team/hours',
    '/api/reports/valuation']) {
    const r = await GET(watcher, path);
    assert.equal(r.status, 200, `${path} answered ${r.status}`);
  }
});

// ---------------------------------------------------------------------------
// What they may not
// ---------------------------------------------------------------------------
test('an observer cannot change one thing, anywhere', async () => {
  const watcher = await signIn('observer');
  const refusals = [
    ['POST', '/api/products', { sku: 'X', name: 'X' }],
    ['PUT', '/api/products/ANY', { retail_price: 1 }],
    ['POST', '/api/team', { name: 'X', position: 'Y' }],
    ['PUT', '/api/team/1', { name: 'X', position: 'Y' }],
    ['DELETE', '/api/team/1', undefined],
    ['POST', '/api/team/1/clock', { direction: 'in' }],
    ['POST', '/api/team/1/photo', { dataUrl: 'x' }],
    ['POST', '/api/users', { username: 'x', password: 'password1', role: 'admin' }],
    ['POST', '/api/promos', { name: 'X' }],
    ['POST', '/api/expenses', { amount: 1 }],
    ['POST', '/api/hr/announcements', { title: 'X', body: 'Y' }],
    ['POST', '/api/hr/leave/1', { status: 'approved' }],
    ['POST', '/api/hr/people/1/employment', { salary: 1 }],
    ['POST', '/api/hr/pipeline', { candidate_name: 'X', target_role: 'Y' }],
    ['POST', '/api/resellers', { name: 'X' }],
  ];
  for (const [method, path, body] of refusals) {
    const fn = { POST, PUT, DELETE }[method];
    const r = await fn(watcher, path, body);
    assert.equal(r.status, 403, `${method} ${path} answered ${r.status}, not 403`);
  }
});

test('the database refuses an observer, not only the router', async () => {
  // The routes above could all be rewritten tomorrow. This is the rule that
  // does not depend on anybody remembering: require_role never accepts an
  // observer, so a function written next year refuses one for free.
  const watcher = await signIn('observer');
  for (const [sql, params] of [
    ['select add_employee($1,$2)', ['X', 'Y']],
    ['select end_employment($1)', [1]],
    ['select clock_in($1)', [1]],
    ['select set_employment($1,$2,$3)', [1, 'Dept', 1]],
    ['select post_announcement($1,$2)', ['X', 'Y']],
    ['select create_login($1,$2,$3,$4)', ['x', 'x', 'x', 'admin']],
    ['select record_expense($1,$2,$3)', ['other', 'X', 1]],
  ]) {
    await assert.rejects(() => asRole('observer', watcher.username, sql, params),
      /FORBIDDEN/, sql);
  }
});

test('an observer never sees anybody\'s pay', async () => {
  const boss = await signIn('admin');
  const watcher = await signIn('observer');

  const made = await POST(boss, '/api/team', { name: unique('Paid'), position: 'Coordinator' });
  assert.equal(made.status, 200, JSON.stringify(made.data));
  assert.equal((await POST(boss, `/api/hr/people/${made.data.id}/employment`,
    { department: 'Retail', salary: 42000 })).status, 200);

  const seen = (await GET(watcher, '/api/hr')).data;
  const row = seen.people.find((p) => Number(p.id) === made.data.id);
  assert.ok(row, 'they can see the person');
  assert.equal(row.department, 'Retail', 'and the department');
  assert.ok(!('salary' in row), 'and no salary field at all — not null, absent');
  assert.ok(!('pay_period' in row));
  assert.equal(seen.figures.payroll_monthly, null, 'nor the monthly total');

  // Not merely absent from the reply: unreadable underneath it.
  const direct = await asRole('observer', watcher.username, 'select * from employment_details');
  assert.equal(direct.rows.length, 0, 'the table itself gives an observer nothing');

  // And an owner still sees it, so the stripping is by role and not by accident.
  const asOwner = (await GET(boss, '/api/hr')).data.people
    .find((p) => Number(p.id) === made.data.id);
  assert.equal(Number(asOwner.salary), 42000);
});

test('an observer never sees the company\'s money', async () => {
  const boss = await signIn('admin');
  const watcher = await signIn('observer');

  for (const path of ['/api/finance', '/api/reports/receivables', '/api/reports/journal',
    '/api/receipts', '/api/takings-by-branch']) {
    assert.equal((await GET(watcher, path)).status, 403, path);
  }

  const board = (await GET(watcher, '/api/dashboard')).data;
  assert.equal(board.takings, null, 'the day\'s takings are not a management report');
  assert.deepEqual(board.overdue, [], 'nor who owes us');
  assert.deepEqual(board.exposure, []);
  assert.deepEqual(board.cashVariance, [],
    'and least of all which cashier\'s drawer keeps coming up short');

  // The parts that are the job come through untouched.
  assert.ok(Array.isArray(board.reorder));
  assert.ok(Array.isArray(board.shelf));
  assert.ok(Array.isArray(board.expired));

  const owner = (await GET(boss, '/api/dashboard')).data;
  assert.ok(owner.takings, 'an owner still gets the takings');
});

// ---------------------------------------------------------------------------
// Their own record
//
// These sixteen are not auditors from outside. They clock on at the same door,
// take leave from the same allowance and are reviewed like everybody else, and
// for a while they were the only people in the building who could not see their
// own hours — the tier was built as a way of reading the company, and their own
// record got caught in it.
//
// So the reading half opened and the writing half did not, and the tests below
// are about the seam between them.
// ---------------------------------------------------------------------------

/** A view-only sign-in belonging to somebody who actually works here. */
async function watcherWhoWorksHere(name) {
  const watcher = await signIn('observer');
  const branch = (await db.query('select id from branches order by id limit 1')).rows[0];
  const person = await db.query(
    `insert into employees (name, position, branch_id, user_id)
     values ($1,'Coordinator',$2,(select id from app_users where username = $3))
     returning id`,
    [name, branch.id, watcher.username]);
  return Object.assign(watcher, { employeeId: Number(person.rows[0].id), name });
}

test('a view-only manager can see their own record', async () => {
  const watcher = await watcherWhoWorksHere(unique('Caila'));

  const mine = await GET(watcher, '/api/my');
  assert.equal(mine.status, 200, JSON.stringify(mine.data));
  assert.equal(mine.data.profile.name, watcher.name);
  assert.equal(Number(mine.data.profile.id), watcher.employeeId);
  assert.ok(Array.isArray(mine.data.hours), 'their own hours');
  assert.ok(Array.isArray(mine.data.leave), 'their own leave');
  assert.ok(Array.isArray(mine.data.appraisals), 'their own reviews');
  assert.equal((await GET(watcher, '/api/noticeboard')).status, 200,
    'a notice pinned up for the whole company is for them too');
});

test('their own record is their own and nobody else\'s', async () => {
  const her = await watcherWhoWorksHere(unique('Caila'));
  const him = await watcherWhoWorksHere(unique('Basty'));

  const hers = (await GET(her, '/api/my')).data.profile;
  const his = (await GET(him, '/api/my')).data.profile;
  assert.equal(hers.name, her.name);
  assert.equal(his.name, him.name);
  assert.notEqual(Number(hers.id), Number(his.id));

  // There is no id in the route to change, so the shapes somebody would try
  // are query strings — and none of them may move the answer.
  for (const q of [`?id=${him.employeeId}`, `?employee_id=${him.employeeId}`,
    `?employee=${encodeURIComponent(him.name)}`]) {
    const tried = (await GET(her, `/api/my${q}`)).data.profile;
    assert.equal(tried.name, her.name, `${q} moved the answer`);
  }
});

test('reading their record does not open writing to it', async () => {
  const watcher = await watcherWhoWorksHere(unique('Caila'));

  // Their leave balance shows on their record; asking for the days is still a
  // conversation with HR, because read-only is what these sixteen were given.
  assert.equal((await POST(watcher, '/api/my/leave',
    { leave_type: 'vacation', start_date: '2027-01-04', end_date: '2027-01-05' })).status, 403);
  assert.equal((await DELETE(watcher, '/api/my/leave/1')).status, 403);

  // And past the router, which is the guard that counts.
  for (const [sql, params] of [
    ['select request_leave($1,$2,$3)', ['vacation', '2027-01-04', '2027-01-05']],
    ['select withdraw_leave($1)', [1]],
  ]) {
    await assert.rejects(() => asRole('observer', watcher.username, sql, params),
      /FORBIDDEN/, sql);
  }
});

test('a view-only sign-in that belongs to nobody is told so, not shown somebody', async () => {
  // Not every observer has to be on the team. What must never happen is the
  // lookup coming back empty and the first row of somebody else standing in.
  const stranger = await signIn('observer');
  const r = await GET(stranger, '/api/my');
  assert.notEqual(r.status, 200, JSON.stringify(r.data));
  assert.match(r.data.error ?? '', /does not belong to anybody/i);
});

test('their own pay is theirs; the payroll is still not', async () => {
  const boss = await signIn('admin');
  const watcher = await watcherWhoWorksHere(unique('Caila'));
  assert.equal((await POST(boss, `/api/hr/people/${watcher.employeeId}/employment`,
    { department: 'Retail', salary: 31000 })).status, 200);

  // A cashier already sees their own figure. "Except salaries" means everybody
  // else's, and the reply to /api/hr proves that half is unchanged.
  const mine = (await GET(watcher, '/api/my')).data.profile;
  assert.equal(Number(mine.salary), 31000, 'their own payslip figure');

  const company = (await GET(watcher, '/api/hr')).data;
  assert.equal(company.figures.payroll_monthly, null, 'the monthly total, still not');
  assert.ok(company.people.every((p) => !('salary' in p)), 'nobody else\'s, still not');
});
