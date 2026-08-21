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
import pg from 'pg';
import { hashPassword } from '../lib/auth.js';
import { server } from '../scripts/dev.js';
import { pool } from '../lib/db.js';

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

test('an observer is not a way into somebody\'s own record either', async () => {
  const watcher = await signIn('observer');
  for (const path of ['/api/my', '/api/my/photo', '/api/noticeboard']) {
    const r = await GET(watcher, path);
    assert.equal(r.status, 403, `${path} answered ${r.status}`);
  }
  // Asking for somebody's leave is a POST route, so a GET is refused before
  // the role is even looked at. Worth saying out loud: that 405 is the router
  // being tidy, not the boundary doing anything.
  assert.equal((await POST(watcher, '/api/my/leave',
    { leave_type: 'vacation', start_date: '2027-01-04', end_date: '2027-01-05' })).status, 403);
});
