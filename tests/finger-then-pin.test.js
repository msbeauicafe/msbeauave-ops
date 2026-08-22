// A finger, then a PIN.
//
// A fingerprint says who is standing at the door. It does not say they meant
// to clock, and it is the one credential a person cannot change if it is ever
// copied. So a match records nothing on its own — it opens a short window in
// which that person, and only that person, confirms with the PIN.
//
// Almost every test here is about what the window will not do: outlive its
// ninety seconds, survive three wrong PINs, be spent twice, or accept the PIN
// of the person standing behind. A confirming step that any of those defeats
// is the old single factor wearing a second one's name.
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

// A PIN nobody else here has. The keyed fingerprint of a PIN is uniquely
// indexed — at most one person in the company can hold one — so a test that
// reuses a number is a test whose second person cannot be created at all.
let pins = 200000;
const freshPin = () => String(pins++ + Number(String(process.pid).slice(-3)) * 1000);

/** Somebody with a finger on file and a PIN of their own. */
async function person({ pin = freshPin(), finger = true } = {}) {
  const boss = await signIn('admin');
  const name = unique('Presser');
  const made = await POST(boss, '/api/team', { name, position: 'Consultant' });
  assert.equal(made.status, 200, JSON.stringify(made.data));
  const id = made.data.id;
  const branch = (await db.query('select id from branches order by id limit 1')).rows[0].id;
  await db.query('update employees set branch_id = $2 where id = $1', [id, branch]);
  if (pin) assert.equal((await POST(boss, `/api/team/${id}/pin`, { pin })).status, 200);
  if (finger) {
    await db.query(
      `insert into employee_fingers (employee_id, finger, template, quality)
       values ($1, 1, $2, 60)`, [id, Buffer.from(`template-${id}`)]);
  }
  return { id, name, branch, pin, boss };
}

const openShifts = async (id) => Number((await db.query(
  'select count(*) as n from shifts where employee_id = $1', [id])).rows[0].n);

/** One statement with a role's own rights, past every route. */
async function asRole(role, sql, params = []) {
  const client = await db.connect();
  try {
    await client.query('begin');
    await client.query("select set_config('app.role',$1,true)", [role]);
    await client.query("select set_config('app.actor','tester',true)");
    await client.query('set local role app_client');
    return await client.query(sql, params);
  } finally {
    await client.query('rollback').catch(() => {});
    client.release();
  }
}

const press = (door, p) =>
  POST(door, '/api/clock/by-finger', { employeeId: p.id, branch_id: p.branch });

// ---------------------------------------------------------------------------
// The window
// ---------------------------------------------------------------------------
test('a finger alone records nothing at all', async () => {
  const p = await person();
  const door = await signIn('timekeeper');

  const matched = await press(door, p);
  assert.equal(matched.status, 200, JSON.stringify(matched.data));
  assert.equal(matched.data.action, 'confirm', 'not "in" — nothing has happened yet');
  assert.equal(matched.data.name, p.name);
  assert.ok(matched.data.ticket, 'and a ticket to confirm with');

  assert.equal(await openShifts(p.id), 0,
    'a fingerprint on its own must never write a shift');
});

test('the PIN that follows it clocks them on, and out again', async () => {
  const p = await person();
  const door = await signIn('timekeeper');

  const inTicket = (await press(door, p)).data.ticket;
  const on = await POST(door, '/api/clock/confirm', { ticket: inTicket, pin: p.pin });
  assert.equal(on.status, 200, JSON.stringify(on.data));
  assert.equal(on.data.action, 'in');
  assert.equal(on.data.name, p.name);

  // Out is the same two steps. Walking past a scanner should not end a shift
  // any more than it should start one.
  const outTicket = (await press(door, p)).data.ticket;
  assert.equal(await openShifts(p.id), 1, 'still one shift, still open');
  const off = await POST(door, '/api/clock/confirm', { ticket: outTicket, pin: p.pin });
  assert.equal(off.data.action, 'out');

  const row = (await db.query(
    'select started_how, ended_how, ended_at from shifts where employee_id = $1', [p.id])).rows[0];
  assert.ok(row.ended_at, 'the shift is closed');
  assert.equal(row.started_how, 'finger');
  assert.equal(row.ended_how, 'finger');
});

// ---------------------------------------------------------------------------
// What the window will not do
// ---------------------------------------------------------------------------
test('somebody else\'s PIN does not confirm your finger', async () => {
  // The one that matters: two people at a door, one of them helpful.
  const mine = await person({ pin: '111222' });
  const theirs = await person({ pin: '333444' });
  const door = await signIn('timekeeper');

  const ticket = (await press(door, mine)).data.ticket;
  const no = await POST(door, '/api/clock/confirm', { ticket, pin: theirs.pin });
  assert.equal(no.status, 400, JSON.stringify(no.data));
  assert.equal(await openShifts(mine.id), 0);
  assert.equal(await openShifts(theirs.id), 0, 'and certainly not for the other person');
});

test('three wrong PINs kill the ticket', async () => {
  const p = await person({ pin: '556677' });
  const door = await signIn('timekeeper');
  const ticket = (await press(door, p)).data.ticket;

  for (const wrong of ['000000', '999999', '123456']) {
    assert.equal((await POST(door, '/api/clock/confirm', { ticket, pin: wrong })).status, 400);
  }
  // The right PIN now, and it is too late — the window is gone, not merely
  // guarded. Otherwise holding a stranger's finger to the glass would buy an
  // unlimited number of guesses.
  const late = await POST(door, '/api/clock/confirm', { ticket, pin: p.pin });
  assert.equal(late.status, 400, JSON.stringify(late.data));
  assert.match(late.data.error, /expired/i);
  assert.equal(await openShifts(p.id), 0);
});

test('a ticket is spent once', async () => {
  const p = await person({ pin: '778899' });
  const door = await signIn('timekeeper');
  const ticket = (await press(door, p)).data.ticket;

  assert.equal((await POST(door, '/api/clock/confirm', { ticket, pin: p.pin })).status, 200);
  // A replay would clock them straight back out, which is exactly the bug the
  // door's own settle window was written to stop.
  const again = await POST(door, '/api/clock/confirm', { ticket, pin: p.pin });
  assert.equal(again.status, 400, JSON.stringify(again.data));
  assert.equal(await openShifts(p.id), 1, 'one shift, not one and a closing');
  const row = (await db.query(
    'select ended_at from shifts where employee_id = $1', [p.id])).rows[0];
  assert.equal(row.ended_at, null, 'and still on shift');
});

test('a ticket that has run out of time is refused', async () => {
  const p = await person({ pin: '224466' });
  const door = await signIn('timekeeper');
  const ticket = (await press(door, p)).data.ticket;

  // Ninety seconds is not something to wait for in a test, so the window is
  // moved rather than the clock.
  await db.query(
    "update clock_confirmations set expires_at = now() - interval '1 second'"
    + ' where employee_id = $1', [p.id]);

  const late = await POST(door, '/api/clock/confirm', { ticket, pin: p.pin });
  assert.equal(late.status, 400, JSON.stringify(late.data));
  assert.match(late.data.error, /expired/i);
  assert.equal(await openShifts(p.id), 0);
});

test('an invented ticket confirms nobody', async () => {
  const p = await person();
  const door = await signIn('timekeeper');
  await press(door, p);

  for (const made_up of ['', 'x', 'a'.repeat(32)]) {
    const no = await POST(door, '/api/clock/confirm', { ticket: made_up, pin: p.pin });
    assert.equal(no.status, 400, `"${made_up}" was accepted`);
  }
  assert.equal(await openShifts(p.id), 0);
});

test('the ticket is not stored where it could be read back', async () => {
  // Kept as a hash like a password, so a copy of the table confirms nobody.
  const p = await person();
  const door = await signIn('timekeeper');
  const ticket = (await press(door, p)).data.ticket;

  const rows = await db.query(
    'select ticket_hash from clock_confirmations where employee_id = $1', [p.id]);
  assert.equal(rows.rows.length, 1);
  assert.notEqual(rows.rows[0].ticket_hash, ticket, 'the ticket itself must not be written down');
  assert.match(rows.rows[0].ticket_hash, /^[0-9a-f]{64}$/);
});

test('a finger nobody at this door owns opens no window', async () => {
  const p = await person({ finger: false });
  const door = await signIn('timekeeper');

  const no = await press(door, p);
  assert.equal(no.status, 400, JSON.stringify(no.data));
  assert.equal(Number((await db.query(
    'select count(*) as n from clock_confirmations where employee_id = $1',
    [p.id])).rows[0].n), 0);
});

// ---------------------------------------------------------------------------
// Not a way in for anybody else
// ---------------------------------------------------------------------------
test('confirming needs the door\'s own sign-in', async () => {
  const p = await person();
  const door = await signIn('timekeeper');
  const ticket = (await press(door, p)).data.ticket;

  // A ticket is handed to the screen at the door. Somebody who came by it
  // another way still has to be a door to spend it.
  assert.equal((await POST(null, '/api/clock/confirm', { ticket, pin: p.pin })).status, 401);
  const staff = await signIn('employee');
  assert.equal((await POST(staff, '/api/clock/confirm', { ticket, pin: p.pin })).status, 403);
  assert.equal(await openShifts(p.id), 0);
});

test('the PIN pad on its own still works, for everybody with no finger', async () => {
  // The confirming step must not have quietly become the only way in. Most of
  // the company has no fingerprint on file and types four digits.
  const p = await person({ pin: '135791', finger: false });
  const door = await signIn('timekeeper');

  const on = await POST(door, '/api/clock/by-pin', { pin: '135791', branch_id: p.branch });
  assert.equal(on.status, 200, JSON.stringify(on.data));
  assert.equal(on.data.action, 'in');
  const row = (await db.query(
    'select started_how from shifts where employee_id = $1', [p.id])).rows[0];
  assert.equal(row.started_how, 'pin');
});

test('an unconfirmed match is kept, and HR can see it', async () => {
  // A finger opened a window and no PIN followed. Worth being able to look at
  // — it is somebody using a finger they cannot back up.
  const p = await person();
  const door = await signIn('timekeeper');
  await press(door, p);

  const seen = await asRole('admin', 'select * from unconfirmed_matches()');
  assert.ok(seen.rows.some((r) => r.name === p.name),
    'the match that never became a shift is on the record');

  // And it is not open to everybody who can work a door: the tablet writes
  // these rows and has no business reading the list back.
  await assert.rejects(() => asRole('timekeeper', 'select * from unconfirmed_matches()'),
    /FORBIDDEN/);
});
