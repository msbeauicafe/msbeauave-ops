// Changing your own password, and nobody else's.
//
// Everybody here was handed a password on a printed sheet that went round a
// building. Letting them replace it is the easy half. The interesting half is
// everything it must not become on the way:
//
//   - a way to change somebody else's, which would be an employee locking an
//     owner out;
//   - a way to change your own without knowing the current one, which would
//     make an unattended phone on a counter into an account takeover;
//   - a way for a door tablet, standing in a corridor, to change the sign-in a
//     whole shift clocks on with.
//
// The last two are the ones that would pass a hand-written check and still be
// wrong, so they are tested through HTTP and again in SQL — because a rule the
// API enforces is a rule a second API would not.
import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { hashPassword, checkPassword } from '../lib/auth.js';
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
const POST = (c, p, b) => request(c, 'POST', p, b ?? {});

async function login(username, password) {
  const res = await fetch(`${base}/api/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  const raw = res.headers.getSetCookie?.()[0] ?? res.headers.get('set-cookie');
  return { status: res.status, cookie: raw ? raw.split(';')[0] : null };
}

async function newLogin(role, password = 'secret123') {
  const username = unique(role);
  await db.query(
    `insert into app_users (username, display_name, password_hash, role)
     values ($1,$1,$2,$3)`,
    [username, hashPassword(password), role]);
  return username;
}

const storedHash = async (username) =>
  (await db.query('select password_hash from app_users where username = $1',
    [username])).rows[0].password_hash;

/** What one sign-in can do when it talks to the database directly. */
async function asRole(role, username, sql, params = []) {
  const client = await db.connect();
  try {
    await client.query('begin');
    await client.query("select set_config('app.role',$1,true)", [role]);
    await client.query("select set_config('app.actor',$1,true)", [username]);
    await client.query('set local role app_client');
    return await client.query(sql, params);
  } finally {
    await client.query('rollback').catch(() => {});
    client.release();
  }
}

// ---------------------------------------------------------------------------
// The thing itself
// ---------------------------------------------------------------------------
test('somebody who works here changes their own password and signs in with it',
  async () => {
    const who = await newLogin('employee', 'printed-sheet-1');
    const { cookie } = await login(who, 'printed-sheet-1');

    const done = await POST(cookie, '/api/my/password',
      { current: 'printed-sheet-1', password: 'chosen-by-me-9' });
    assert.equal(done.status, 200, JSON.stringify(done.data));

    assert.equal((await login(who, 'chosen-by-me-9')).status, 200,
      'the new password must work');
    assert.equal((await login(who, 'printed-sheet-1')).status, 401,
      'the printed one must stop working');
  });

test('the session in their hand survives it', async () => {
  // Somebody standing in a stockroom on their break should not be thrown out
  // of the app for tidying up their own password.
  const who = await newLogin('employee', 'printed-sheet-2');
  const { cookie } = await login(who, 'printed-sheet-2');

  // Asked before as well as after, so a route that was never going to answer
  // this sign-in cannot pass for a session that survived.
  const before = await request(cookie, 'GET', '/api/noticeboard');
  assert.equal(before.status, 200, 'the probe itself has to work signed in');

  await POST(cookie, '/api/my/password',
    { current: 'printed-sheet-2', password: 'chosen-by-me-9' });

  const still = await request(cookie, 'GET', '/api/noticeboard');
  assert.equal(still.status, 200, 'the cookie is about who they are, not their password');
});

test('everybody who signs in can do it, view-only included', async () => {
  for (const role of ['admin', 'cashier', 'warehouse', 'supervisor', 'office',
    'employee', 'observer']) {
    const who = await newLogin(role, 'printed-sheet-3');
    const { cookie } = await login(who, 'printed-sheet-3');
    const done = await POST(cookie, '/api/my/password',
      { current: 'printed-sheet-3', password: `chosen-${role}-9` });
    assert.equal(done.status, 200, `${role}: ${JSON.stringify(done.data)}`);
    assert.equal((await login(who, `chosen-${role}-9`)).status, 200, role);
  }
});

// ---------------------------------------------------------------------------
// Knowing the current one
// ---------------------------------------------------------------------------
test('a wrong current password is refused and changes nothing', async () => {
  const who = await newLogin('employee', 'printed-sheet-4');
  const { cookie } = await login(who, 'printed-sheet-4');
  const before = await storedHash(who);

  const no = await POST(cookie, '/api/my/password',
    { current: 'not-what-they-use', password: 'chosen-by-me-9' });
  assert.equal(no.status, 403, JSON.stringify(no.data));

  assert.equal(await storedHash(who), before, 'nothing may have been written');
  assert.equal((await login(who, 'printed-sheet-4')).status, 200,
    'they still sign in with what they had');
  assert.equal((await login(who, 'chosen-by-me-9')).status, 401);
});

test('an empty current password is refused', async () => {
  // The shape a mistake would take: a body with the new password and nothing
  // else, which must not read as "no password needed".
  const who = await newLogin('employee', 'printed-sheet-5');
  const { cookie } = await login(who, 'printed-sheet-5');

  const no = await POST(cookie, '/api/my/password', { password: 'chosen-by-me-9' });
  assert.equal(no.status, 400, JSON.stringify(no.data));
  assert.equal((await login(who, 'printed-sheet-5')).status, 200);
});

test('a short password is refused, and so is the one they already have', async () => {
  const who = await newLogin('employee', 'printed-sheet-6');
  const { cookie } = await login(who, 'printed-sheet-6');

  const short = await POST(cookie, '/api/my/password',
    { current: 'printed-sheet-6', password: 'abc123' });
  assert.equal(short.status, 400);

  const same = await POST(cookie, '/api/my/password',
    { current: 'printed-sheet-6', password: 'printed-sheet-6' });
  assert.equal(same.status, 400);
  assert.equal((await login(who, 'printed-sheet-6')).status, 200);
});

test('signed out, it is not a route at all', async () => {
  const no = await POST(null, '/api/my/password',
    { current: 'anything', password: 'chosen-by-me-9' });
  assert.equal(no.status, 401);
});

// ---------------------------------------------------------------------------
// Somebody else's
// ---------------------------------------------------------------------------
test('there is no way to name anybody else', async () => {
  const me = await newLogin('employee', 'printed-sheet-7');
  const owner = await newLogin('admin', 'the-owners-own');
  const ownersHash = await storedHash(owner);
  const { cookie } = await login(me, 'printed-sheet-7');

  // Every shape somebody would try: an id in the body, a username in the body,
  // the owner's name where their own would go.
  for (const extra of [{ id: 1 }, { user_id: 1 }, { username: owner },
    { user: owner }, { actor: owner }]) {
    const tried = await POST(cookie, '/api/my/password',
      { current: 'printed-sheet-7', password: 'chosen-by-me-9', ...extra });
    // It may well succeed — at changing their own, which is the point.
    assert.equal(await storedHash(owner), ownersHash,
      `${JSON.stringify(extra)} reached the owner's row`);
    // Put them back so the next shape starts from the same place.
    if (tried.status === 200) {
      await db.query('update app_users set password_hash = $2 where username = $1',
        [me, hashPassword('printed-sheet-7')]);
    }
  }
  assert.equal((await login(owner, 'the-owners-own')).status, 200,
    "the owner's password is untouched");
});

test('an employee cannot reach the admin route for somebody else', async () => {
  const me = await newLogin('employee', 'printed-sheet-8');
  const owner = await newLogin('admin', 'the-owners-own');
  const ownerId = (await db.query('select id from app_users where username = $1',
    [owner])).rows[0].id;
  const { cookie } = await login(me, 'printed-sheet-8');

  const no = await POST(cookie, `/api/users/${ownerId}/password`,
    { password: 'chosen-by-me-9' });
  assert.equal(no.status, 403);
  assert.equal((await login(owner, 'the-owners-own')).status, 200);
});

// ---------------------------------------------------------------------------
// The database on its own
// ---------------------------------------------------------------------------
test('the function changes the caller and only the caller', async () => {
  const me = await newLogin('employee', 'printed-sheet-9');
  const other = await newLogin('employee', 'printed-sheet-10');
  const othersHash = await storedHash(other);

  await asRole('employee', me, 'select change_my_password($1)', [hashPassword('by-sql-9')]);
  // Rolled back by the helper, so the point is only that it refused nobody and
  // touched nobody: run it again, committing, through a second call.
  const client = await db.connect();
  try {
    await client.query('begin');
    await client.query("select set_config('app.role','employee',true)");
    await client.query("select set_config('app.actor',$1,true)", [me]);
    await client.query('set local role app_client');
    await client.query('select change_my_password($1)', [hashPassword('by-sql-9')]);
    await client.query('reset role');
    await client.query('commit');
  } finally { client.release(); }

  assert.ok(checkPassword('by-sql-9', await storedHash(me)), 'the caller changed');
  assert.equal(await storedHash(other), othersHash, 'nobody else did');
});

test('a door tablet cannot change the sign-in a whole shift clocks on with',
  async () => {
    // The timekeeper is a tablet on a wall in a corridor. Whoever is standing
    // in front of it is not the tablet, and locking a shop's clock out of its
    // own screen would stop a shift starting.
    const tablet = await newLogin('timekeeper', 'the-door-code-1');
    const before = await storedHash(tablet);

    await assert.rejects(
      asRole('timekeeper', tablet, 'select change_my_password($1)',
        [hashPassword('by-the-door-9')]),
      /shared device/i);
    await assert.rejects(
      asRole('timekeeper', tablet, 'select my_password_hash()'),
      /shared device/i);

    assert.equal(await storedHash(tablet), before);

    // And the route does not accept it either, which is the door it would
    // actually arrive at.
    const { cookie } = await login(tablet, 'the-door-code-1');
    const no = await POST(cookie, '/api/my/password',
      { current: 'the-door-code-1', password: 'by-the-door-9' });
    assert.equal(no.status, 403, JSON.stringify(no.data));
    assert.equal(await storedHash(tablet), before);
  });

test('a sign-in that has been switched off cannot change its password', async () => {
  const gone = await newLogin('employee', 'printed-sheet-11');
  const { cookie } = await login(gone, 'printed-sheet-11');
  await db.query('update app_users set active = false where username = $1', [gone]);

  const no = await POST(cookie, '/api/my/password',
    { current: 'printed-sheet-11', password: 'chosen-by-me-9' });
  assert.notEqual(no.status, 200, JSON.stringify(no.data));
});
