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

test('the role picker offers it, and the badge has a name for it', () => {
  const at = app.indexOf('const ROLES = [');
  const list = app.slice(at, app.indexOf('];', at));
  assert.match(list, /\['hr',/, 'a role a sign-in can be set to');
  assert.match(app, /hr: 'HR \/ Operations'/, 'and it is not shown as a bare code');
});

test('the people screens answer them', async () => {
  const hr = await signIn('hr');
  for (const p of ['/api/team', '/api/hr', '/api/payroll', '/api/advances',
    '/api/team/hours', '/api/hr/attendance']) {
    const r = await GET(hr, p);
    assert.equal(r.status, 200, `${p} answered ${r.status}`);
  }
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
