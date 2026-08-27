// Which way somebody clocked on.
//
// The shift row always said who wrote it. It never said how the person at the
// door proved who they were, so "were this morning's fifteen fingers or PINs"
// had no answer — about a fingerprint door that took a day to get working.
//
// The method is not something the browser sends. It comes from which door the
// request arrived at: /api/clock/by-finger can only be reached by matching a
// finger, and /api/clock/by-pin can only be reached by typing one. That is the
// property worth testing, because the alternative design — trusting a field in
// the request body — would let a tablet claim a fingerprint it never read.
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

/** Somebody on the team, with a PIN, at a shop, optionally with a finger. */
async function person({ pin, finger = false } = {}) {
  const boss = await signIn('admin');
  const name = unique('Clocker');
  const made = await POST(boss, '/api/team', { name, position: 'Consultant' });
  assert.equal(made.status, 200, JSON.stringify(made.data));
  const id = made.data.id;
  const branch = (await db.query('select id from branches order by id limit 1')).rows[0].id;
  await db.query('update employees set branch_id = $2 where id = $1', [id, branch]);
  if (pin) assert.equal((await POST(boss, `/api/team/${id}/pin`, { pin })).status, 200);
  if (finger) {
    await db.query(
      `insert into employee_fingers (employee_id, finger, template, quality)
       values ($1, 1, $2, 60)`, [id, Buffer.from('not-a-real-template')]);
  }
  return { id, name, branch, pin, boss };
}

// What a door does now: a finger names somebody, and the PIN they type
// confirms it. A match on its own records nothing, which is the point of it —
// see tests/finger-then-pin.test.js for the boundary itself.
// The PIN names them and opens the window; the finger closes it. Both are
// used, and 'finger' is what the pair is called — see pin-then-finger.test.js
// for why that order and not the other one.
async function byFinger(door, p) {
  const named = await POST(door, '/api/clock/by-pin',
    { pin: p.pin, branch_id: p.branch, scanner: true });
  if (named.status !== 200) return named;
  assert.equal(named.data.action, 'confirm', JSON.stringify(named.data));
  return POST(door, '/api/clock/by-finger', { employeeId: p.id, branch_id: p.branch });
}

const shift = async (id) => (await db.query(
  `select started_how, ended_how, started_by from shifts
    where employee_id = $1 order by id desc limit 1`, [id])).rows[0];

// ---------------------------------------------------------------------------
// Each door says its own name
// ---------------------------------------------------------------------------
test('a finger at the door is recorded as a finger', async () => {
  const p = await person({ pin: '909192', finger: true });
  const door = await signIn('timekeeper');

  const on = await byFinger(door, p);
  assert.equal(on.status, 200, JSON.stringify(on.data));
  assert.equal(on.data.action, 'in');
  assert.equal((await shift(p.id)).started_how, 'finger');

  // And on the way out, because somebody can present a finger in the morning
  // and type a PIN at night — which is the thing worth being able to see.
  const off = await byFinger(door, p);
  assert.equal(off.data.action, 'out');
  const done = await shift(p.id);
  assert.equal(done.started_how, 'finger');
  assert.equal(done.ended_how, 'finger');
});

test('a PIN at the door is recorded as a PIN', async () => {
  const p = await person({ pin: '447291' });
  const door = await signIn('timekeeper');

  const on = await POST(door, '/api/clock/by-pin', { pin: '447291', branch_id: p.branch });
  assert.equal(on.status, 200, JSON.stringify(on.data));
  assert.equal((await shift(p.id)).started_how, 'pin');
});

test('picking a name and typing a PIN is a PIN too', async () => {
  const p = await person({ pin: '558312' });
  const door = await signIn('timekeeper');

  const on = await POST(door, '/api/clock', { employeeId: p.id, pin: '558312' });
  assert.equal(on.status, 200, JSON.stringify(on.data));
  assert.equal((await shift(p.id)).started_how, 'pin');
});

test('a shift entered from the back office says so', async () => {
  // The one that matters when hours are questioned: this row was typed by a
  // person, not presented at a door by the one it is about.
  const p = await person({});
  assert.equal((await POST(p.boss, `/api/team/${p.id}/clock`, { direction: 'in' })).status, 200);
  assert.equal((await shift(p.id)).started_how, 'hand');

  assert.equal((await POST(p.boss, `/api/team/${p.id}/clock`, { direction: 'out' })).status, 200);
  const done = await shift(p.id);
  assert.equal(done.started_how, 'hand');
  assert.equal(done.ended_how, 'hand');
});

test('a mixed day is recorded as mixed, not as one or the other', async () => {
  const p = await person({ pin: '661423', finger: true });
  const door = await signIn('timekeeper');

  await byFinger(door, p);
  await POST(door, '/api/clock/by-pin', { pin: '661423', branch_id: p.branch });

  const done = await shift(p.id);
  assert.equal(done.started_how, 'finger', 'in by finger');
  assert.equal(done.ended_how, 'pin', 'out by PIN — the scanner would not read them again');
});

// ---------------------------------------------------------------------------
// The door cannot claim a method it did not use
// ---------------------------------------------------------------------------
test('a tablet cannot claim a fingerprint it never read', async () => {
  // The whole design rests on this. If the method came from the request body,
  // a device at a door — or anybody who reached the API with the door's own
  // sign-in — could type a PIN and have it written down as a finger.
  const p = await person({ pin: '773514' });
  const door = await signIn('timekeeper');

  const on = await POST(door, '/api/clock/by-pin',
    { pin: '773514', branch_id: p.branch, how: 'finger', started_how: 'finger' });
  assert.equal(on.status, 200, JSON.stringify(on.data));
  assert.equal((await shift(p.id)).started_how, 'pin',
    'the route it arrived at decides, not what it asked for');
});

test('the database refuses a method that is not one of the three', async () => {
  const p = await person({});
  const client = await db.connect();
  try {
    await client.query('begin');
    await client.query("select set_config('app.role','admin',true)");
    await client.query("select set_config('app.actor','tester',true)");
    await client.query('set local role app_client');
    await assert.rejects(
      client.query('select clock_toggle($1,$2)', [p.id, 'face']),
      /not a way of clocking on/i);
  } finally {
    await client.query('rollback').catch(() => {});
    client.release();
  }
});

// ---------------------------------------------------------------------------
// Reading it back
// ---------------------------------------------------------------------------
test('HR sees which way each press was made', async () => {
  const p = await person({ pin: '939495', finger: true });
  const door = await signIn('timekeeper');
  await byFinger(door, p);

  for (const who of [await signIn('admin'), await signIn('observer')]) {
    const sheet = await GET(who, '/api/hr/attendance');
    assert.equal(sheet.status, 200, JSON.stringify(sheet.data));
    const row = sheet.data.stretches.find((s) => s.name === p.name);
    assert.ok(row, 'their press is on the sheet');
    assert.equal(row.started_how, 'finger');
  }
});

test('a shift from before this was kept reads as unknown, not as a PIN', async () => {
  // Every shift already recorded has no method, and the sheet must not invent
  // one for it. A guess written into an hours record cannot be argued with.
  const p = await person({});
  await db.query(
    `insert into shifts (employee_id, started_at, ended_at, started_by)
     values ($1, now() - interval '3 hours', now() - interval '1 hour', 'Timekeeper')`,
    [p.id]);

  const row = await shift(p.id);
  assert.equal(row.started_how, null);
  assert.equal(row.ended_how, null);

  const sheet = await GET(await signIn('admin'), '/api/hr/attendance');
  const seen = sheet.data.stretches.find((s) => s.name === p.name);
  assert.equal(seen.started_how, null, 'null travels all the way to the screen');
});

// ---------------------------------------------------------------------------
// Deploying it without shutting a door
// ---------------------------------------------------------------------------
test('the one-argument clock_toggle still works', async () => {
  // The database is migrated before the API that uses the new one is deployed,
  // and there are people standing at both doors during that gap. If the old
  // signature disappeared, nobody could clock on until the deploy finished.
  const p = await person({});
  const client = await db.connect();
  try {
    await client.query('begin');
    await client.query("select set_config('app.role','admin',true)");
    await client.query("select set_config('app.actor','tester',true)");
    await client.query('set local role app_client');
    const r = await client.query('select clock_toggle($1) as result', [p.id]);
    assert.equal(r.rows[0].result.action, 'in');
    await client.query('commit');
  } finally { client.release(); }

  assert.equal((await shift(p.id)).started_how, null,
    'and records no method, which is the truth about it');
});
