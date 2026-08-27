// A PIN, then a finger.
//
// The two credentials are the same two. The order is the point.
//
// A PIN says who is standing at the door and that they meant to clock. It does
// not prove they own the number — one can be watched over a shoulder or lent
// to a friend running late — so nothing is recorded until the finger only they
// have follows it. And a scanner that listens all day answers fingers nobody
// offered on purpose, so a finger with no window open behind it now records
// nothing at all.
//
// Almost every test here is about what the window will not do: outlive its
// ninety seconds, be spent twice, be opened by a PIN that belongs to nobody,
// or be closed by the finger of the person standing behind. A confirming step
// that any of those defeats is one factor wearing a second one's name.
//
// The last of those matters most for the thing this order was changed to fix:
// pressing again to check the first press worked must not clock anybody out.
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

/** Typing the PIN at a door that has a scanner: names them, records nothing. */
const typePin = (door, p, pin = p.pin) =>
  POST(door, '/api/clock/by-pin', { pin, branch_id: p.branch, scanner: true });

/** The finger that closes the window the PIN opened. */
const press = (door, p) =>
  POST(door, '/api/clock/by-finger', { employeeId: p.id, branch_id: p.branch });

/** Both halves, the way somebody standing at the door does them. */
async function clockThrough(door, p) {
  const named = await typePin(door, p);
  assert.equal(named.status, 200, JSON.stringify(named.data));
  assert.equal(named.data.action, 'confirm', JSON.stringify(named.data));
  return press(door, p);
}

const openWindows = async (id) => Number((await db.query(
  'select count(*) as n from clock_confirmations where employee_id = $1 and used_at is null',
  [id])).rows[0].n);

// ---------------------------------------------------------------------------
// The window
// ---------------------------------------------------------------------------
test('a PIN alone records nothing at all', async () => {
  const door = await signIn('timekeeper');
  const p = await person({});

  const named = await typePin(door, p);
  assert.equal(named.status, 200, JSON.stringify(named.data));
  assert.equal(named.data.action, 'confirm');
  assert.equal(named.data.name, p.name, 'it says who, because the door needs to');
  assert.equal(named.data.seconds, 90);
  assert.equal(named.data.ticket, undefined,
    'and hands out no token, because the finger is what spends the window');

  assert.equal(await openShifts(p.id), 0, 'no shift, open or closed');
});

test('a finger alone records nothing either — and says why', async () => {
  const door = await signIn('timekeeper');
  const p = await person({});

  const pressed = await press(door, p);
  assert.equal(pressed.status, 400, JSON.stringify(pressed.data));
  assert.match(pressed.data.error, /PIN first/i);
  assert.equal(await openShifts(p.id), 0);
});

test('the finger that follows a PIN clocks them on, and out again', async () => {
  const door = await signIn('timekeeper');
  const p = await person({});

  const on = await clockThrough(door, p);
  assert.equal(on.status, 200, JSON.stringify(on.data));
  assert.equal(on.data.action, 'in');
  assert.equal(on.data.name, p.name);

  const off = await clockThrough(door, p);
  assert.equal(off.status, 200, JSON.stringify(off.data));
  assert.equal(off.data.action, 'out');
  assert.equal(typeof off.data.worked_minutes, 'number');

  const how = (await db.query(
    'select started_how, ended_how from shifts where employee_id = $1', [p.id])).rows[0];
  assert.equal(how.started_how, 'finger', 'both were used, and the finger is what it is called');
  assert.equal(how.ended_how, 'finger');
});

// The whole reason the order was turned round.
test('pressing again to check it worked does not clock them back out', async () => {
  const door = await signIn('timekeeper');
  const p = await person({});

  const on = await clockThrough(door, p);
  assert.equal(on.data.action, 'in');

  // The same finger, a second later, with no new PIN behind it.
  const twice = await press(door, p);
  assert.equal(twice.status, 400, JSON.stringify(twice.data));
  assert.match(twice.data.error, /PIN first/i);

  const shifts = (await db.query(
    'select ended_at from shifts where employee_id = $1', [p.id])).rows;
  assert.equal(shifts.length, 1, 'still one shift');
  assert.equal(shifts[0].ended_at, null, 'and still open — they are at work');
});

test("somebody else's finger does not close your window", async () => {
  const door = await signIn('timekeeper');
  const mine = await person({});
  const theirs = await person({});

  await typePin(door, mine);
  // The person behind presses first.
  const wrong = await press(door, theirs);
  assert.equal(wrong.status, 400, JSON.stringify(wrong.data));
  assert.equal(await openShifts(theirs.id), 0, 'and it clocked them on nothing');
  assert.equal(await openShifts(mine.id), 0, 'nor me');

  // Mine is still there for me.
  const ok = await press(door, mine);
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
  assert.equal(ok.data.action, 'in');
});

test('a window is spent once', async () => {
  const door = await signIn('timekeeper');
  const p = await person({});

  await typePin(door, p);
  assert.equal((await press(door, p)).status, 200);
  assert.equal(await openWindows(p.id), 0, 'nothing left open');

  const again = await press(door, p);
  assert.equal(again.status, 400, JSON.stringify(again.data));
  assert.equal(await openShifts(p.id), 1, 'one shift, not two');
});

test('a window that has run out of time is refused', async () => {
  const door = await signIn('timekeeper');
  const p = await person({});

  await typePin(door, p);
  await db.query(
    `update clock_confirmations set expires_at = now() - interval '1 second'
      where employee_id = $1 and used_at is null`, [p.id]);

  const late = await press(door, p);
  assert.equal(late.status, 400, JSON.stringify(late.data));
  assert.equal(await openShifts(p.id), 0);
});

test('two PINs in a row leave the second window standing, and one press ends it',
  async () => {
    const door = await signIn('timekeeper');
    const p = await person({});

    await typePin(door, p);
    await typePin(door, p);
    assert.equal(await openWindows(p.id), 2, 'somebody typed twice; both are windows');

    const on = await press(door, p);
    assert.equal(on.status, 200, JSON.stringify(on.data));
    assert.equal(await openShifts(p.id), 1, 'and only one shift came of it');
  });

// ---------------------------------------------------------------------------
// The PIN that opens it
// ---------------------------------------------------------------------------
test('a PIN that belongs to nobody here opens no window', async () => {
  const door = await signIn('timekeeper');
  const p = await person({});

  const wrong = await POST(door, '/api/clock/by-pin',
    { pin: '999999', branch_id: p.branch, scanner: true });
  assert.equal(wrong.status, 400, JSON.stringify(wrong.data));
  assert.equal(await openWindows(p.id), 0);
});

test('the window is not stored where it could be read back', async () => {
  const door = await signIn('timekeeper');
  const p = await person({});
  await typePin(door, p);

  const row = (await db.query(
    `select * from clock_confirmations where employee_id = $1
      order by id desc limit 1`, [p.id])).rows[0];
  assert.ok(row, 'a window was written');
  assert.ok(row.ticket_hash && row.ticket_hash.length >= 32,
    'what is kept is a hash, and a hash of something nobody was given');
  assert.equal(row.used_at, null);
});

test('clocking at a door needs the door\'s own sign-in', async () => {
  const p = await person({});
  const nobody = await POST(null, '/api/clock/by-pin',
    { pin: p.pin, branch_id: p.branch, scanner: true });
  assert.equal(nobody.status, 401);

  // Somebody who may look and not touch. A door's sign-in is its own, and a
  // back-office account is not it.
  const looker = await signIn('observer');
  assert.equal((await POST(looker, '/api/clock/by-finger',
    { employeeId: p.id, branch_id: p.branch })).status, 403);
  assert.equal((await POST(looker, '/api/clock/by-pin',
    { pin: p.pin, branch_id: p.branch, scanner: true })).status, 403);
});

// ---------------------------------------------------------------------------
// Who is sent to the glass, and who is not
// ---------------------------------------------------------------------------
test('somebody with no finger on file clocks on their PIN alone', async () => {
  const door = await signIn('timekeeper');
  const p = await person({ finger: false });

  // Sent to a scanner they could never satisfy, they would never clock on.
  const on = await typePin(door, p);
  assert.equal(on.status, 200, JSON.stringify(on.data));
  assert.equal(on.data.action, 'in', 'clocked, not asked for a finger');
  assert.equal((await db.query(
    'select started_how from shifts where employee_id = $1', [p.id])).rows[0].started_how,
    'pin');
});

test('a door with no working scanner clocks on the PIN alone', async () => {
  const door = await signIn('timekeeper');
  const p = await person({});          // has a finger — but no reader in front of them

  const on = await POST(door, '/api/clock/by-pin',
    { pin: p.pin, branch_id: p.branch, scanner: false });
  assert.equal(on.status, 200, JSON.stringify(on.data));
  assert.equal(on.data.action, 'in',
    'a broken reader at six in the morning is not a queue nobody can clear');
});

test('picking your face and typing your PIN goes to the glass too', async () => {
  const door = await signIn('timekeeper');
  const p = await person({});

  const named = await POST(door, '/api/clock',
    { employeeId: p.id, pin: p.pin, scanner: true });
  assert.equal(named.status, 200, JSON.stringify(named.data));
  assert.equal(named.data.action, 'confirm', 'the other way in, the same second step');

  const on = await press(door, p);
  assert.equal(on.data.action, 'in');
});

test('the board says who has a finger, and never what it is', async () => {
  const boss = await signIn('admin');
  const withOne = await person({});
  const without = await person({ finger: false });

  const board = await request(boss, 'GET', '/api/team');
  const find = (id) => board.data.team.find((t) => String(t.id) === String(id));
  assert.equal(find(withOne.id).has_finger, true);
  assert.equal(find(without.id).has_finger, false);
  assert.ok(!JSON.stringify(board.data.team).includes('template'),
    'and no template goes anywhere near the board');
});

// ---------------------------------------------------------------------------
// What is left behind
// ---------------------------------------------------------------------------
test('a PIN nobody stood behind is kept, and HR can see it', async () => {
  const door = await signIn('timekeeper');
  const p = await person({});
  await typePin(door, p);            // and then walked away

  const seen = await asRole('admin', 'select * from unconfirmed_matches()');
  assert.ok(seen.rows.some((r) => r.name === p.name),
    'a window with no finger after it is worth being able to look at');

  // Not something the door itself can read.
  await assert.rejects(() => asRole('timekeeper', 'select * from unconfirmed_matches()'));
});
