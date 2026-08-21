// A shop signing itself up.
//
// Three steps, and the middle one is a person here saying yes. Applying is
// open; being approved is not. Wholesale prices are the entire reason a
// reseller account exists, so the tests that matter are the ones proving an
// application on its own reaches nothing, and that the link which does grant
// access works exactly once.
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

async function admin() {
  const username = unique('boss');
  await db.query(
    `insert into app_users (username, display_name, password_hash, role)
     values ($1,$1,$2,'admin')`, [username, hashPassword('secret123')]);
  const res = await fetch(`${base}/api/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password: 'secret123' }),
  });
  const raw = res.headers.getSetCookie?.()[0] ?? res.headers.get('set-cookie');
  return raw.split(';')[0];
}

const apply = (over = {}) => POST(null, '/api/reseller/apply', {
  business_name: unique('Glow Shop'), contact_name: 'Marites Reyes',
  phone: '09170001111', ...over,
});

async function approved() {
  const boss = await admin();
  const name = unique('Claiming Shop');
  await apply({ business_name: name });
  const mine = (await GET(boss, '/api/reseller/applications')).data.applications
    .find((a) => a.business_name === name);
  const r = await POST(boss, `/api/reseller/applications/${mine.id}/approve`);
  return { boss, name, token: r.data.link.split('t=')[1], reseller: r.data.reseller_id };
}

// ---------------------------------------------------------------------------
// Applying reaches nothing
// ---------------------------------------------------------------------------
test('anybody may apply, and applying grants nothing at all', async () => {
  const sent = await apply();
  assert.equal(sent.status, 200);
  assert.deepEqual(sent.data, { received: true },
    'the reply carries no id — a stranger learns nothing from having applied');

  // No sign-in, no reseller account, nothing to read.
  for (const path of ['/api/reseller/applications', '/api/resellers', '/api/products']) {
    assert.equal((await GET(null, path)).status, 401, path);
  }
});

test('an application needs a name and a way to reach them', async () => {
  assert.equal((await POST(null, '/api/reseller/apply',
    { contact_name: 'A', phone: '09170000000' })).status, 400, 'no business name');
  assert.equal((await POST(null, '/api/reseller/apply',
    { business_name: 'B', phone: '09170000000' })).status, 400, 'no contact name');
  const noWay = await POST(null, '/api/reseller/apply',
    { business_name: unique('B'), contact_name: 'A' });
  assert.equal(noWay.status, 400, 'neither phone nor email');
  assert.match(noWay.data.error, /phone number or an email/);
});

test('applying twice in a week is not told it is a repeat', async () => {
  // Saying "you already applied" tells a stranger who our resellers are.
  const name = unique('Twice Shop');
  const first = await apply({ business_name: name });
  const again = await apply({ business_name: name });
  assert.equal(first.status, 200);
  assert.deepEqual(again.data, first.data, 'the same answer either way');

  const rows = await db.query(
    'select count(*)::int as n from reseller_applications where business_name = $1', [name]);
  assert.equal(rows.rows[0].n, 1, 'and only one row was written');
});

// ---------------------------------------------------------------------------
// Approving is the step that keeps wholesale prices ours
// ---------------------------------------------------------------------------
test('approving turns an application into an account and a one-time link', async () => {
  const boss = await admin();
  const name = unique('Approved Shop');
  await apply({ business_name: name });

  const listed = (await GET(boss, '/api/reseller/applications')).data;
  const mine = listed.applications.find((a) => a.business_name === name);
  assert.ok(mine, 'an owner sees it waiting');
  assert.equal(mine.status, 'pending');

  const ok = await POST(boss, `/api/reseller/applications/${mine.id}/approve`,
    { tier: 2, credit_limit: 5000, terms_days: 7 });
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
  assert.match(ok.data.link, /^\/join\/\?t=[A-Za-z0-9_-]{20,}$/);
  assert.ok(ok.data.reseller_id);

  // The token is handed over once and never written down in the clear.
  const token = ok.data.link.split('t=')[1];
  const stored = await db.query('select token_hash from reseller_invites where reseller_id = $1',
    [ok.data.reseller_id]);
  assert.equal(stored.rows.length, 1);
  assert.notEqual(stored.rows[0].token_hash, token, 'the token itself is not kept');
  assert.match(stored.rows[0].token_hash, /^[0-9a-f]{64}$/, 'only a hash of it is');

  // The account exists but nobody can open it yet.
  const acct = await db.query('select status from resellers where id = $1', [ok.data.reseller_id]);
  assert.equal(acct.rows[0].status, 'pending');
  const users = await db.query('select count(*)::int as n from app_users where reseller_id = $1',
    [ok.data.reseller_id]);
  assert.equal(users.rows[0].n, 0, 'approving creates no sign-in — the shop makes their own');
});

test('only an owner may approve or even see applications', async () => {
  const boss = await admin();
  const name = unique('Peeked At');
  await apply({ business_name: name });
  const mine = (await GET(boss, '/api/reseller/applications')).data.applications
    .find((a) => a.business_name === name);

  assert.equal((await GET(null, '/api/reseller/applications')).status, 401);
  assert.equal((await POST(null, `/api/reseller/applications/${mine.id}/approve`)).status, 401,
    'a stranger cannot approve themselves');
});

// Two guards that the tests above could not see, because something in front of
// them was doing the work. Both are the last line rather than the first, which
// is exactly why they need proving on their own.
test('the database refuses a non-owner, not only the router', async () => {
  const boss = await admin();
  const name = unique('Guarded');
  await apply({ business_name: name });
  const mine = (await GET(boss, '/api/reseller/applications')).data.applications
    .find((a) => a.business_name === name);

  // Signed in, and the wrong person. The route refuses first...
  const till = unique('till');
  await db.query(
    `insert into app_users (username, display_name, password_hash, role)
     values ($1,$1,$2,'cashier')`, [till, hashPassword('secret123')]);
  const res = await fetch(`${base}/api/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: till, password: 'secret123' }),
  });
  const cookie = (res.headers.getSetCookie?.()[0] ?? res.headers.get('set-cookie')).split(';')[0];
  assert.equal((await POST(cookie, `/api/reseller/applications/${mine.id}/approve`)).status, 403);
  assert.equal((await GET(cookie, '/api/reseller/applications')).status, 403);

  // ...and if it ever stopped, the function still would. Approving mints an
  // account that can read every wholesale price we charge, so the check that
  // matters is the one nothing can be routed around.
  const client = await db.connect();
  try {
    await client.query('begin');
    await client.query("select set_config('app.role','cashier',true)");
    await client.query("select set_config('app.actor',$1,true)", [till]);
    await client.query('set local role app_client');
    await assert.rejects(
      () => client.query('select approve_reseller_application($1,$2)', [mine.id, 'x'.repeat(64)]),
      /FORBIDDEN/);
  } finally {
    await client.query('rollback').catch(() => {});
    client.release();
  }
});

test('a used link stays dead even if the sign-in it made is removed', async () => {
  // "Already has a sign-in" is not what makes a link single use — the mark on
  // the link is. Otherwise deleting an account would quietly bring an old
  // token back to life.
  const { token, reseller } = await approved();
  const username = unique('gone').replace(/-/g, '');
  assert.equal((await POST(null, '/api/reseller/invite/claim',
    { t: token, username, password: 'made-and-gone' })).status, 200);

  await db.query('delete from app_users where reseller_id = $1', [reseller]);
  assert.equal((await GET(null, `/api/reseller/invite?t=${token}`)).status, 404,
    'the link was spent, and stays spent');
  const tried = await POST(null, '/api/reseller/invite/claim',
    { t: token, username: unique('again').replace(/-/g, ''), password: 'second-go-now' });
  assert.equal(tried.status, 400);
});

test('an application is decided once', async () => {
  const boss = await admin();
  const name = unique('Once Only');
  await apply({ business_name: name });
  const mine = (await GET(boss, '/api/reseller/applications')).data.applications
    .find((a) => a.business_name === name);

  assert.equal((await POST(boss, `/api/reseller/applications/${mine.id}/decline`,
    { why: 'Too far to deliver.' })).status, 200);
  const again = await POST(boss, `/api/reseller/applications/${mine.id}/approve`);
  assert.equal(again.status, 400);
  assert.match(again.data.error, /already declined/);
});

// ---------------------------------------------------------------------------
// Claiming: once, and only with a live link
// ---------------------------------------------------------------------------

test('the shop chooses its own username and password, and nobody here sees it', async () => {
  const { name, token } = await approved();

  const peek = await GET(null, `/api/reseller/invite?t=${token}`);
  assert.equal(peek.status, 200);
  assert.equal(peek.data.business, name, 'the page can say who it is for');

  const username = unique('glowshop').replace(/-/g, '');
  const claimed = await POST(null, '/api/reseller/invite/claim',
    { t: token, username, password: 'chosen-by-them' });
  assert.equal(claimed.status, 200, JSON.stringify(claimed.data));

  // It is a real sign-in, and it reaches the portal.
  const signedIn = await fetch(`${base}/api/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password: 'chosen-by-them' }),
  });
  assert.equal(signedIn.status, 200);
  const me = await signedIn.json();
  assert.equal(me.user.role, 'reseller');

  const cookie = (signedIn.headers.getSetCookie?.()[0]
    ?? signedIn.headers.get('set-cookie')).split(';')[0];
  assert.equal((await GET(cookie, '/api/portal/account')).status, 200, 'their own portal opens');
  assert.equal((await GET(cookie, '/api/resellers')).status, 403,
    'and nothing of anybody else\'s');
});

test('a link works once', async () => {
  const { token } = await approved();
  const first = await POST(null, '/api/reseller/invite/claim',
    { t: token, username: unique('first').replace(/-/g, ''), password: 'first-password' });
  assert.equal(first.status, 200);

  const second = await POST(null, '/api/reseller/invite/claim',
    { t: token, username: unique('second').replace(/-/g, ''), password: 'second-password' });
  assert.equal(second.status, 400, 'the same link cannot make a second sign-in');
  assert.equal((await GET(null, `/api/reseller/invite?t=${token}`)).status, 404,
    'and the page no longer offers the form');
});

test('an expired link is refused', async () => {
  const { token, reseller } = await approved();
  await db.query(
    `update reseller_invites set expires_at = now() - interval '1 day' where reseller_id = $1`,
    [reseller]);
  assert.equal((await GET(null, `/api/reseller/invite?t=${token}`)).status, 404);
  const tried = await POST(null, '/api/reseller/invite/claim',
    { t: token, username: unique('late').replace(/-/g, ''), password: 'too-late-now' });
  assert.equal(tried.status, 400);
});

test('a made-up token gets nothing, and says nothing', async () => {
  const guess = await GET(null, '/api/reseller/invite?t=notarealtokenatall');
  assert.equal(guess.status, 404);
  assert.match(guess.data.error, /not valid/);
  assert.doesNotMatch(JSON.stringify(guess.data), /reseller|invite|token_hash|sql/i,
    'a refusal explains nothing about what is behind it');
});

test('a short password is refused before anything is created', async () => {
  const { token } = await approved();
  const weak = await POST(null, '/api/reseller/invite/claim',
    { t: token, username: unique('weak').replace(/-/g, ''), password: 'short' });
  assert.equal(weak.status, 400);
  assert.match(weak.data.error, /eight characters/);
  assert.equal((await GET(null, `/api/reseller/invite?t=${token}`)).status, 200,
    'and the link still works, because nothing was used up');
});

test('reissuing kills the earlier link', async () => {
  const { boss, token, reseller } = await approved();
  const fresh = await POST(boss, `/api/resellers/${reseller}/invite`, {});
  assert.equal(fresh.status, 200);
  const newToken = fresh.data.link.split('t=')[1];

  assert.equal((await GET(null, `/api/reseller/invite?t=${token}`)).status, 404,
    'a token read over somebody\'s shoulder last month is not still good');
  assert.equal((await GET(null, `/api/reseller/invite?t=${newToken}`)).status, 200);
});

test('a reseller who already has a sign-in cannot be issued another link', async () => {
  const { boss, token, reseller } = await approved();
  await POST(null, '/api/reseller/invite/claim',
    { t: token, username: unique('taken').replace(/-/g, ''), password: 'already-mine' });

  const again = await POST(boss, `/api/resellers/${reseller}/invite`, {});
  assert.equal(again.status, 400);
  assert.match(again.data.error, /already has a sign-in/);
});
