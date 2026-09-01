// Saved chat-order drafts — a basket parked to finish later.
//
// A draft is a reseller and the lines picked so far. It saves, lists newest
// first, reopens with its lines intact, and discards; it needs an account and
// at least one line; and it is the order desk's, closed to everyone else.
import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { hashPassword } from '../lib/auth.js';
import { server } from '../scripts/dev.js';
import { pool } from '../lib/db.js';

const db = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 4 });
let base;
test.before(async () => { await new Promise((d) => server.listen(0, d)); base = `http://127.0.0.1:${server.address().port}`; });
test.after(async () => { await new Promise((d) => server.close(d)); await pool.end(); await db.end(); });

let seq = 0;
const uniq = (p) => `${p}-${process.pid}-${Date.now()}-${++seq}`;
async function req(cookie, method, p, body) {
  const r = await fetch(`${base}${p}`, { method,
    headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, data: await r.json().catch(() => ({})) };
}
async function signIn(role) {
  const u = uniq(role);
  await db.query(`insert into app_users (username, display_name, password_hash, role) values ($1,$1,$2,$3)`,
    [u, hashPassword('secret123'), role]);
  const r = await fetch(`${base}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: u, password: 'secret123' }) });
  return (r.headers.getSetCookie?.()[0] ?? r.headers.get('set-cookie')).split(';')[0];
}
const newReseller = async () =>
  (await db.query(`insert into resellers (name, status) values ($1,'active') returning id`, [uniq('RS')])).rows[0].id;

test('a draft saves, lists, reopens and discards', async () => {
  const desk = await signIn('orderdesk');
  const rid = await newReseller();
  const lines = [{ sku: 'SKU-A', name: 'A', qty: 2, price: 100 }, { sku: 'SKU-B', name: 'B', qty: 1, price: 50 }];

  const saved = await req(desk, 'POST', '/api/order-drafts', { reseller_id: rid, lines });
  assert.equal(saved.status, 200, JSON.stringify(saved.data));

  const list = await req(desk, 'GET', '/api/order-drafts');
  const mine = list.data.find((d) => Number(d.id) === saved.data.id);
  assert.ok(mine, 'the draft is in the list');
  assert.equal(Number(mine.items), 2, 'with its line count');
  assert.ok(mine.reseller, 'and the account name');

  const one = await req(desk, 'GET', `/api/order-drafts/${saved.data.id}`);
  assert.equal(one.status, 200);
  assert.equal(one.data.lines.length, 2, 'its lines come back to reopen');
  assert.equal(one.data.lines[0].sku, 'SKU-A');

  const gone = await req(desk, 'DELETE', `/api/order-drafts/${saved.data.id}`);
  assert.equal(gone.status, 200);
  const after = await req(desk, 'GET', '/api/order-drafts');
  assert.ok(!after.data.some((d) => Number(d.id) === saved.data.id), 'discarded');
});

test('a draft is the taker\'s own — one desk hand does not see another\'s', async () => {
  const a = await signIn('orderdesk');
  const b = await signIn('orderdesk');
  const rid = await newReseller();

  const mine = await req(a, 'POST', '/api/order-drafts', { reseller_id: rid, lines: [{ sku: 'M', qty: 1 }] });
  assert.equal(mine.status, 200);

  // B's own list never shows A's draft.
  const bList = await req(b, 'GET', '/api/order-drafts');
  assert.ok(!bList.data.some((d) => Number(d.id) === mine.data.id), 'not in another hand\'s list');
  // Nor can B open or discard it.
  assert.equal((await req(b, 'GET', `/api/order-drafts/${mine.data.id}`)).status, 404, 'cannot open it');
  await req(b, 'DELETE', `/api/order-drafts/${mine.data.id}`);
  assert.equal((await req(a, 'GET', `/api/order-drafts/${mine.data.id}`)).status, 200, 'B\'s discard left A\'s draft standing');
});

test('editing a parked basket updates that one draft, not a second copy', async () => {
  const desk = await signIn('orderdesk');
  const rid = await newReseller();

  const saved = await req(desk, 'POST', '/api/order-drafts', { reseller_id: rid, lines: [{ sku: 'X', qty: 1 }] });
  assert.equal(saved.status, 200);

  // Save again onto the same draft — two lines now, still one draft.
  const upd = await req(desk, 'PUT', `/api/order-drafts/${saved.data.id}`,
    { lines: [{ sku: 'X', qty: 3 }, { sku: 'Y', qty: 1 }] });
  assert.equal(upd.status, 200);
  assert.equal(Number(upd.data.id), saved.data.id, 'the same draft came back');

  const one = await req(desk, 'GET', `/api/order-drafts/${saved.data.id}`);
  assert.equal(one.data.lines.length, 2, 'its lines are the edited ones');
  assert.equal(one.data.lines[0].qty, 3);

  const mine = (await req(desk, 'GET', '/api/order-drafts')).data.filter((d) => Number(d.reseller_id) === Number(rid));
  assert.equal(mine.length, 1, 'no second copy was parked');
});

test('a draft needs an account and at least one line', async () => {
  const desk = await signIn('orderdesk');
  const rid = await newReseller();
  assert.equal((await req(desk, 'POST', '/api/order-drafts', { lines: [{ sku: 'X', qty: 1 }] })).status, 400);
  assert.equal((await req(desk, 'POST', '/api/order-drafts', { reseller_id: rid, lines: [] })).status, 400);
});

test('drafts are the order desk\'s — nobody else gets in', async () => {
  const owner = await signIn('admin');
  const rid = await newReseller();
  const d = await req(owner, 'POST', '/api/order-drafts', { reseller_id: rid, lines: [{ sku: 'X', qty: 1 }] });

  for (const role of ['cashier', 'warehouse', 'office', 'employee']) {
    const who = await signIn(role);
    assert.equal((await req(who, 'GET', '/api/order-drafts')).status, 403, `${role} must not list drafts`);
    assert.equal((await req(who, 'POST', '/api/order-drafts', { reseller_id: rid, lines: [{ sku: 'X', qty: 1 }] })).status, 403);
    assert.equal((await req(who, 'DELETE', `/api/order-drafts/${d.data.id}`)).status, 403);
  }
});

test('the Drafts button and save/reopen are wired into the chat-order screen', async () => {
  const fs = await import('node:fs');
  const url = await import('node:url');
  const path = await import('node:path');
  const here = path.dirname(url.fileURLToPath(import.meta.url));
  const src = fs.readFileSync(path.join(here, '..', 'public/app.js'), 'utf8');
  assert.match(src, /id="rs_drafts"/, 'a Drafts button by the filter');
  assert.match(src, /function openDraftsList/, 'that opens the list');
  assert.match(src, /function reopenDraft/, 'reopening a parked basket');
  assert.match(src, /async function saveDraft/, 'and the right button saves one');
});
