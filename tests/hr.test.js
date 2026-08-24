// The wall between one person's record and everybody else's.
//
// The HR workspace is the first thing in this system where the interesting
// question is not "can this role do it" but "can this role do it *to somebody
// else*". A cashier either takes money or does not. An employee sign-in can
// read a profile, request leave and see reviews — the whole risk is which
// profile, whose leave, whose reviews.
//
// So these tests spend almost all their effort on the same shape: sign in as
// one person, aim a request at another, and insist on nothing coming back.
// They go through HTTP where a browser would, and drop to SQL where the point
// is that the database itself refuses — because a rule the API enforces is a
// rule that a second API would not.
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
const unique = (prefix) => `${prefix}-${process.pid}-${Date.now()}-${++seq}`;

async function request(cookie, method, path, body) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const type = res.headers.get('content-type') || '';
  return {
    status: res.status,
    data: type.includes('json') ? await res.json().catch(() => ({})) : {},
  };
}
const GET = (c, p) => request(c, 'GET', p);
const POST = (c, p, b) => request(c, 'POST', p, b ?? {});
const DELETE = (c, p) => request(c, 'DELETE', p);

async function signIn(username) {
  const res = await fetch(`${base}/api/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password: 'secret123' }),
  });
  assert.equal(res.status, 200, `could not sign in as ${username}`);
  const raw = res.headers.getSetCookie?.()[0] ?? res.headers.get('set-cookie');
  return raw.split(';')[0];
}

async function newLogin(role) {
  const username = unique(role);
  await db.query(
    `insert into app_users (username, display_name, password_hash, role)
     values ($1,$1,$2,$3)`,
    [username, hashPassword('secret123'), role]);
  return username;
}

/** Somebody on the team with an employee sign-in of their own. */
async function newPerson(name, position = 'Beauty Consultant') {
  const username = await newLogin('employee');
  const branch = (await db.query('select id from branches order by id limit 1')).rows[0];
  const person = await db.query(
    `insert into employees (name, position, branch_id, user_id)
     values ($1,$2,$3,(select id from app_users where username = $4))
     returning id`,
    [name, position, branch.id, username]);
  return { id: Number(person.rows[0].id), username, name };
}

/** What an employee sign-in sees when it asks the database directly. */
async function asEmployee(username, sql, params = []) {
  const client = await db.connect();
  try {
    await client.query('begin');
    await client.query("select set_config('app.role','employee',true)");
    await client.query("select set_config('app.actor',$1,true)", [username]);
    await client.query('set local role app_client');
    return await client.query(sql, params);
  } finally {
    await client.query('rollback').catch(() => {});
    client.release();
  }
}

// ---------------------------------------------------------------------------
// The person themselves
// ---------------------------------------------------------------------------
test('somebody sees their own record, pay included', async () => {
  const hr = await signIn(await newLogin('admin'));
  const me = await newPerson(unique('Liza'));

  const set = await POST(hr, `/api/hr/people/${me.id}/employment`, {
    department: 'Retail', salary: 18000, pay_period: 'monthly', leave_entitlement: 10,
  });
  assert.equal(set.status, 200, JSON.stringify(set.data));

  const mine = await GET(await signIn(me.username), '/api/my');
  assert.equal(mine.status, 200, JSON.stringify(mine.data));
  assert.equal(mine.data.profile.name, me.name);
  assert.equal(Number(mine.data.profile.salary), 18000);
  assert.equal(mine.data.profile.department, 'Retail');
  assert.equal(mine.data.profile.leave_left, 10, 'nothing taken yet');
});

test('a leave request is filed against the person asking, not a number they sent', async () => {
  const someone = await newPerson(unique('Mira'));
  const victim = await newPerson(unique('Dana'));
  const cookie = await signIn(someone.username);

  // employee_id is not a parameter this route has. Sending one anyway is the
  // obvious first thing an attacker tries, so it is the first thing tested.
  const asked = await POST(cookie, '/api/my/leave', {
    employee_id: victim.id, leave_type: 'vacation',
    start_date: '2026-11-02', end_date: '2026-11-04', reason: 'family',
  });
  assert.equal(asked.status, 200, JSON.stringify(asked.data));

  const row = await db.query('select employee_id from leave_requests where id = $1',
    [asked.data.id]);
  assert.equal(Number(row.rows[0].employee_id), someone.id,
    'the request belongs to whoever asked for it');
});

test('leave already asked for cannot be asked for twice', async () => {
  const me = await newPerson(unique('Cel'));
  const cookie = await signIn(me.username);
  const days = { leave_type: 'vacation', start_date: '2027-03-01', end_date: '2027-03-05' };

  assert.equal((await POST(cookie, '/api/my/leave', days)).status, 200);
  const again = await POST(cookie, '/api/my/leave',
    { ...days, start_date: '2027-03-04', end_date: '2027-03-08' });
  assert.equal(again.status, 400);
  assert.match(again.data.error, /already asked for leave/);
});

test('days waiting on a decision are already spent', async () => {
  const hr = await signIn(await newLogin('admin'));
  const me = await newPerson(unique('Joy'));
  await POST(hr, `/api/hr/people/${me.id}/employment`, { salary: 15000, leave_entitlement: 5 });
  const cookie = await signIn(me.username);

  await POST(cookie, '/api/my/leave',
    { leave_type: 'vacation', start_date: '2026-06-01', end_date: '2026-06-03' });
  const seen = (await GET(cookie, '/api/my')).data.profile;
  assert.equal(seen.leave_taken, 3);
  assert.equal(seen.leave_left, 2,
    'three days pending leaves two, not five — otherwise they ask for five more');
});

// ---------------------------------------------------------------------------
// Everybody else's record
// ---------------------------------------------------------------------------
test('an employee sign-in reads nobody from the database, not even filtered', async () => {
  const me = await newPerson(unique('Ana'));
  await newPerson(unique('Bea'));

  // Not "sees only themselves" — sees nothing. The row-level policies name the
  // roles that may read a person and 'employee' is not among them, so there is
  // no filter to get wrong. Everything they legitimately see arrives through a
  // security-definer function instead.
  for (const table of ['employees', 'employment_details', 'leave_requests',
    'appraisals', 'employee_photos', 'shifts', 'applications']) {
    const r = await asEmployee(me.username, `select * from ${table}`);
    assert.equal(r.rows.length, 0, `an employee could read ${table}`);
  }
});

test('an employee cannot reach the HR workspace at all', async () => {
  const me = await newPerson(unique('Rose'));
  const cookie = await signIn(me.username);

  for (const path of ['/api/hr', '/api/team', '/api/team/hours', '/api/team/shifts',
    '/api/dashboard', '/api/finance']) {
    const r = await GET(cookie, path);
    assert.equal(r.status, 403, `${path} answered an employee with ${r.status}`);
  }
});

test('an employee cannot read a colleague\'s photograph', async () => {
  const hr = await signIn(await newLogin('admin'));
  const other = await newPerson(unique('Kim'));
  // A one-pixel PNG is a photograph as far as any of this is concerned.
  const dot = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJ'
    + 'AAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  assert.equal((await POST(hr, `/api/team/${other.id}/photo`, { dataUrl: dot })).status, 200);

  const me = await newPerson(unique('Tin'));
  const cookie = await signIn(me.username);
  const peek = await GET(cookie, `/api/team/${other.id}/photo`);
  assert.equal(peek.status, 403);

  // And their own is reached without naming anybody. Both cases, because a 404
  // for somebody who has no photograph is also what a broken route returns —
  // this test passed for a year on a route that could never have found one.
  const none = await fetch(`${base}/api/my/photo`, { headers: { Cookie: cookie } });
  assert.equal(none.status, 404, 'no photograph is a 404, not a 403');

  assert.equal((await POST(hr, `/api/team/${me.id}/photo`, { dataUrl: dot })).status, 200);
  const ours = await fetch(`${base}/api/my/photo`, { headers: { Cookie: cookie } });
  assert.equal(ours.status, 200, 'and once they have one, they can see it');
  assert.match(ours.headers.get('content-type'), /^image\//);
  assert.ok((await ours.arrayBuffer()).byteLength > 0, 'with the picture actually in it');
});

test('an employee cannot withdraw somebody else\'s leave', async () => {
  const victim = await newPerson(unique('Ella'));
  const asked = await POST(await signIn(victim.username), '/api/my/leave',
    { leave_type: 'sick', start_date: '2026-09-01', end_date: '2026-09-02' });
  assert.equal(asked.status, 200, JSON.stringify(asked.data));

  const nosy = await newPerson(unique('Vic'));
  const tried = await DELETE(await signIn(nosy.username), `/api/my/leave/${asked.data.id}`);
  assert.equal(tried.status, 400);
  assert.match(tried.data.error, /No such leave request/,
    'somebody else\'s request is missing, not forbidden — a refusal would confirm it exists');

  const still = await db.query('select status from leave_requests where id = $1', [asked.data.id]);
  assert.equal(still.rows[0].status, 'pending');
});

test('an employee cannot decide their own leave', async () => {
  const me = await newPerson(unique('Sam'));
  const cookie = await signIn(me.username);
  const asked = await POST(cookie, '/api/my/leave',
    { leave_type: 'vacation', start_date: '2026-12-01', end_date: '2026-12-10' });

  assert.equal((await POST(cookie, `/api/hr/leave/${asked.data.id}`,
    { status: 'approved' })).status, 403);

  // Nor by going around the route and calling the function directly.
  await assert.rejects(
    () => asEmployee(me.username, 'select decide_leave($1,$2)', [asked.data.id, 'approved']),
    /FORBIDDEN/);
});

test('an employee cannot post to the noticeboard, only read it', async () => {
  const hr = await signIn(await newLogin('admin'));
  const me = await newPerson(unique('Gia'));
  const cookie = await signIn(me.username);

  const title = unique('Payday moves to');
  assert.equal((await POST(hr, '/api/hr/announcements',
    { title, body: 'The fifteenth falls on a Sunday.' })).status, 200);

  const board = (await GET(cookie, '/api/noticeboard')).data.announcements;
  assert.ok(board.some((a) => a.title === title), 'everyone sees the notice');

  assert.equal((await POST(cookie, '/api/hr/announcements',
    { title: 'Free day', body: 'From me' })).status, 403);
});

// ---------------------------------------------------------------------------
// What HR does
// ---------------------------------------------------------------------------
test('HR approves leave and the balance moves', async () => {
  const hr = await signIn(await newLogin('admin'));
  const me = await newPerson(unique('Bel'));
  await POST(hr, `/api/hr/people/${me.id}/employment`, { salary: 16000, leave_entitlement: 8 });
  const cookie = await signIn(me.username);

  const asked = await POST(cookie, '/api/my/leave',
    { leave_type: 'vacation', start_date: '2026-08-03', end_date: '2026-08-06' });
  const decided = await POST(hr, `/api/hr/leave/${asked.data.id}`, { status: 'approved' });
  assert.equal(decided.status, 200, JSON.stringify(decided.data));

  const mine = (await GET(cookie, '/api/my')).data;
  assert.equal(mine.leave[0].status, 'approved');
  assert.equal(mine.profile.leave_left, 4);

  const twice = await POST(hr, `/api/hr/leave/${asked.data.id}`, { status: 'declined' });
  assert.equal(twice.status, 400, 'a decision is made once');
  assert.match(twice.data.error, /already approved/);
});

test('HR sees the whole company and what it costs', async () => {
  const hr = await signIn(await newLogin('admin'));
  const me = await newPerson(unique('Nel'));
  await POST(hr, `/api/hr/people/${me.id}/employment`,
    { department: 'Front of house', salary: 20000 });

  const seen = await GET(hr, '/api/hr');
  assert.equal(seen.status, 200, JSON.stringify(seen.data));
  const row = seen.data.people.find((p) => Number(p.id) === me.id);
  assert.equal(Number(row.salary), 20000);
  assert.equal(row.department, 'Front of house');
  assert.ok(seen.data.figures.payroll_monthly >= 20000);
  assert.ok(seen.data.figures.headcount >= 1);
});

test('a candidate moves along the pipeline and nobody else can see them', async () => {
  const hr = await signIn(await newLogin('admin'));
  const added = await POST(hr, '/api/hr/pipeline', {
    candidate_name: unique('Applicant'), target_role: 'Beauty Consultant',
    phone: '09170000001', notes: 'Walked in.',
  });
  assert.equal(added.status, 200, JSON.stringify(added.data));

  assert.equal((await POST(hr, `/api/hr/pipeline/${added.data.id}`,
    { pipeline_stage: 'interview', notes: 'Thursday, ten o\'clock.' })).status, 200);
  const nonsense = await POST(hr, `/api/hr/pipeline/${added.data.id}`,
    { pipeline_stage: 'nearly' });
  assert.equal(nonsense.status, 400);

  const me = await newPerson(unique('Fay'));
  const r = await asEmployee(me.username, 'select * from applications');
  assert.equal(r.rows.length, 0, 'a candidate is not the shop floor\'s business');
});

test('a review is written by HR and read by the person it is about', async () => {
  const hr = await signIn(await newLogin('admin'));
  const me = await newPerson(unique('Zed'));
  const other = await newPerson(unique('Ivy'));

  assert.equal((await POST(hr, '/api/hr/appraisals', {
    employee_id: me.id, period: '2026 first half', rating: 4,
    strengths: 'Steady on the busiest days.', improvements: 'Stock counts.',
  })).status, 200);
  assert.equal((await POST(hr, '/api/hr/appraisals', {
    employee_id: other.id, period: '2026 first half', rating: 2,
  })).status, 200);

  const mine = (await GET(await signIn(me.username), '/api/my')).data.appraisals;
  assert.equal(mine.length, 1, 'their own review and no other');
  assert.equal(mine[0].rating, 4);
  assert.equal(mine[0].strengths, 'Steady on the busiest days.');
});

test('a sign-in that belongs to nobody is told so rather than shown a blank', async () => {
  // An employee sign-in with no person behind it is a setup mistake, not an
  // attack, and it should read like one.
  const orphan = await newLogin('employee');
  const r = await GET(await signIn(orphan), '/api/my');
  assert.equal(r.status, 400);
  assert.match(r.data.error, /does not belong to anybody/);
});

// ---------------------------------------------------------------------------
// The attendance sheet
//
// The reason this is not a query over shifts: the interesting row is the one
// with no shift behind it. A sheet built from the shift table can only ever
// list people who turned up, which is the half HR already knows.
// ---------------------------------------------------------------------------
test('the attendance sheet carries the people who did not come in', async () => {
  const hr = await signIn(await newLogin('admin'));
  const came = await newPerson(unique('Came'));
  const didnt = await newPerson(unique('Didnt'));

  assert.equal((await POST(hr, `/api/team/${came.id}/clock`, { direction: 'in' })).status, 200);

  const sheet = (await GET(hr, '/api/hr/attendance')).data;
  const present = sheet.people.find((p) => Number(p.employee_id) === came.id);
  const missing = sheet.people.find((p) => Number(p.employee_id) === didnt.id);

  assert.ok(present, 'whoever clocked on is on the sheet');
  // Pinned because the screen draws a face from it. A row here is a day
  // rather than a person, so the id says which person the day is about and is
  // named accordingly — and the first version of the screen read `id`, got
  // undefined, and asked the server for a photograph of nobody. Fifty-one
  // blank circles, and nothing anywhere that said why.
  assert.ok('employee_id' in present, 'the sheet says whose day each row is');
  assert.ok('has_photo' in present, 'and whether there is a face to draw');
  assert.ok(present.first_in, 'with the time they arrived');
  assert.equal(present.still_on, true);
  assert.equal(present.last_out, null, 'no leaving time while they are still here');

  assert.ok(missing, 'and so is whoever did not — that is the point of the sheet');
  assert.equal(missing.first_in, null);
  assert.equal(missing.stretches, 0);
  assert.equal(missing.still_on, false);
});

test('leaving fills the out column, and a second stretch is visible as one', async () => {
  const hr = await signIn(await newLogin('admin'));
  const me = await newPerson(unique('Twice'));

  await POST(hr, `/api/team/${me.id}/clock`, { direction: 'in' });
  await POST(hr, `/api/team/${me.id}/clock`, { direction: 'out' });
  await POST(hr, `/api/team/${me.id}/clock`, { direction: 'in' });

  const row = (await GET(hr, '/api/hr/attendance')).data.people
    .find((p) => Number(p.employee_id) === me.id);
  assert.equal(row.stretches, 2, 'a break makes two stretches of one day');
  assert.equal(row.still_on, true);
  assert.equal(row.last_out, null,
    'back from a break is not gone — the earlier leaving time would read as home');

  await POST(hr, `/api/team/${me.id}/clock`, { direction: 'out' });
  const done = (await GET(hr, '/api/hr/attendance')).data.people
    .find((p) => Number(p.employee_id) === me.id);
  assert.ok(done.last_out, 'once they have gone, the last leaving time stands');
  assert.equal(done.still_on, false);
});

test('a day nobody worked still lists everybody', async () => {
  const hr = await signIn(await newLogin('admin'));
  await newPerson(unique('Quiet'));

  // Far enough back that no test has clocked anybody on it.
  const sheet = (await GET(hr, '/api/hr/attendance?on=2020-01-02')).data;
  assert.ok(sheet.people.length, 'the team is listed');
  assert.equal(sheet.figures.present, 0);
  assert.equal(sheet.figures.absent, sheet.figures.onbooks);
  assert.equal(sheet.stretches.length, 0);
});

test('an employee cannot read the attendance sheet', async () => {
  const me = await newPerson(unique('Nosy'));
  const cookie = await signIn(me.username);
  for (const path of ['/api/hr/attendance', '/api/hr/attendance/summary']) {
    assert.equal((await GET(cookie, path)).status, 403, path);
  }
});
