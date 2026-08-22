// One person, opened.
//
// HR's question about somebody is never one thing — their record, their hours,
// their leave, their reviews — so a face is now a thing you click and all of
// it arrives together.
//
// Which puts a lot behind one address. The tests below are mostly about what
// it must not become: a way for a view-only manager to read pay, or for
// anybody else to read any of it at all.
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

async function signIn(role) {
  const username = unique(role);
  await db.query(
    `insert into app_users (username, display_name, password_hash, role)
     values ($1,$1,$2,$3)`, [username, hashPassword('secret123'), role]);
  const res = await fetch(`${base}/api/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password: 'secret123' }) });
  assert.equal(res.status, 200, `could not sign in as ${role}`);
  const raw = res.headers.getSetCookie?.()[0] ?? res.headers.get('set-cookie');
  return Object.assign(raw.split(';')[0], { username });
}

/** Somebody with a wage, a shift behind them and a review on file. */
async function person(boss) {
  const name = unique('Somebody');
  const made = await POST(boss, '/api/team', { name, position: 'Consultant' });
  assert.equal(made.status, 200, JSON.stringify(made.data));
  const id = made.data.id;
  const branch = (await db.query('select id from branches order by id limit 1')).rows[0].id;
  await db.query('update employees set branch_id = $2 where id = $1', [id, branch]);
  assert.equal((await POST(boss, `/api/hr/people/${id}/employment`,
    { department: 'Retail', salary: 27000, pay_period: 'monthly', leave_entitlement: 12 })).status,
    200);
  await db.query(
    `insert into shifts (employee_id, business_date, started_at, ended_at,
                         started_by, started_how, ended_how)
     values ($1, (now() at time zone 'Asia/Manila')::date,
             now() - interval '4 hours', now() - interval '1 hour',
             'Timekeeper', 'finger', 'pin')`, [id]);
  return { id, name };
}

// ---------------------------------------------------------------------------
// What HR gets
// ---------------------------------------------------------------------------
test('one address answers with the whole person', async () => {
  const boss = await signIn('admin');
  const p = await person(boss);

  const r = await GET(boss, `/api/hr/people/${p.id}`);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.person.name, p.name);
  assert.equal(r.data.person.department, 'Retail');
  assert.equal(Number(r.data.person.salary), 27000);
  assert.ok(Array.isArray(r.data.leave));
  assert.ok(Array.isArray(r.data.appraisals));
  assert.ok(Array.isArray(r.data.shifts));
});

test('their attendance comes with them', async () => {
  // The whole reason for the screen: the record and the days worked together,
  // rather than one on HR and the other on Attendance.
  const boss = await signIn('admin');
  const p = await person(boss);

  const d = (await GET(boss, `/api/hr/people/${p.id}`)).data;
  assert.equal(d.shifts.length, 1, 'the shift is there');
  assert.equal(d.shifts[0].started_how, 'finger');
  assert.equal(d.shifts[0].ended_how, 'pin', 'and how they went out');
  assert.equal(d.figures.days_present, 1);
  assert.ok(d.figures.hours >= 2.9 && d.figures.hours <= 3.1,
    `three hours worked, got ${d.figures.hours}`);
  assert.equal(d.figures.still_on, false);
});

test('somebody with nothing behind them is still a person', async () => {
  // A new starter has no shifts, no leave and no reviews, and the screen has
  // to open rather than fall over on the first empty list.
  const boss = await signIn('admin');
  const made = await POST(boss, '/api/team',
    { name: unique('New'), position: 'Consultant' });
  const r = await GET(boss, `/api/hr/people/${made.data.id}`);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.deepEqual(r.data.shifts, []);
  assert.equal(r.data.figures.days_present, 0);
  assert.equal(r.data.figures.hours, 0);
});

test('a person who does not exist is a plain no', async () => {
  const boss = await signIn('admin');
  assert.equal((await GET(boss, '/api/hr/people/99999999')).status, 404);
});

// ---------------------------------------------------------------------------
// What a view-only manager gets, and does not
// ---------------------------------------------------------------------------
test('a view-only manager can open somebody, without their pay', async () => {
  const boss = await signIn('admin');
  const watcher = await signIn('observer');
  const p = await person(boss);

  const r = await GET(watcher, `/api/hr/people/${p.id}`);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.person.name, p.name);
  assert.equal(r.data.person.department, 'Retail', 'the department is not pay');
  assert.equal(r.data.shifts.length, 1, 'and the hours are the job');

  assert.ok(!('salary' in r.data.person), 'no salary field at all — not null, absent');
  assert.ok(!('pay_period' in r.data.person));
  // Not merely absent from the reply: the whole body must not carry it.
  assert.doesNotMatch(JSON.stringify(r.data), /27000/, 'the figure is nowhere in the reply');
});

test('nobody else can open anybody', async () => {
  const boss = await signIn('admin');
  const p = await person(boss);

  for (const role of ['cashier', 'warehouse', 'supervisor', 'office',
    'employee', 'timekeeper']) {
    const nosey = await signIn(role);
    const r = await GET(nosey, `/api/hr/people/${p.id}`);
    assert.equal(r.status, 403, `${role} got ${r.status}`);
  }
  assert.equal((await GET(null, `/api/hr/people/${p.id}`)).status, 401);
});

test('an employee cannot reach a colleague this way', async () => {
  // They have a screen of their own — /api/my — which resolves them from the
  // session. This one takes an id, which is exactly why they are not on it.
  const boss = await signIn('admin');
  const mine = await person(boss);
  const staff = await signIn('employee');

  assert.equal((await GET(staff, `/api/hr/people/${mine.id}`)).status, 403);
});
