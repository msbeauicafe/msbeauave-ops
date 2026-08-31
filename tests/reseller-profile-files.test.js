// An account's details are editable, on the record, and it carries the actual
// papers and bank-transfer proofs — not a typed-in file name.
//
// Three things are checked: editing the name/contact/email writes a
// details_changed event stamped with who did it and what changed; a document
// and a payment proof can be uploaded, listed, served and removed; and none of
// it is open to anyone but the owner.
import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import sharp from 'sharp';
import { hashPassword } from '../lib/auth.js';
import { server } from '../scripts/dev.js';
import { pool } from '../lib/db.js';

const db = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 4 });
let base;
// A real image, made by sharp itself so sharp can certainly read it back.
let IMG;
test.before(async () => {
  await new Promise((d) => server.listen(0, d));
  base = `http://127.0.0.1:${server.address().port}`;
  const jpeg = await sharp({ create: { width: 8, height: 8, channels: 3, background: { r: 200, g: 120, b: 160 } } })
    .jpeg().toBuffer();
  IMG = 'data:image/jpeg;base64,' + jpeg.toString('base64');
});
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
  const cookie = (r.headers.getSetCookie?.()[0] ?? r.headers.get('set-cookie')).split(';')[0];
  return Object.assign(cookie, { username: u });
}
const newReseller = async () =>
  (await db.query(`insert into resellers (name, status) values ($1,'active') returning id`, [uniq('RS')])).rows[0].id;

test('an account name and details can be edited, and the history says who did it', async () => {
  const admin = await signIn('admin');
  const id = await newReseller();

  const saved = await req(admin, 'POST', `/api/resellers/${id}/details`,
    { name: 'MARY JANE LOMIBAO', contact: '0917 000 1234', email: 'mary@example.ph' });
  assert.equal(saved.status, 200, JSON.stringify(saved.data));

  const r = (await req(admin, 'GET', `/api/resellers/${id}`)).data;
  assert.equal(r.name, 'MARY JANE LOMIBAO', 'the new name stuck');
  assert.equal(r.contact, '0917 000 1234');
  assert.equal(r.email, 'mary@example.ph');

  const ev = r.events.find((e) => e.kind === 'details_changed');
  assert.ok(ev, 'the edit is on the record');
  assert.equal(ev.actor, admin.username, 'stamped with who did it');
  assert.equal(ev.detail.to.name, 'MARY JANE LOMIBAO', 'and what it became');
});

test('an account still needs a name', async () => {
  const admin = await signIn('admin');
  const id = await newReseller();
  const bad = await req(admin, 'POST', `/api/resellers/${id}/details`, { name: '   ' });
  assert.equal(bad.status, 400);
  assert.match(bad.data.error, /needs a name/i);
});

test('a paper and a bank proof can be uploaded, listed, served and removed', async () => {
  const admin = await signIn('admin');
  const id = await newReseller();

  const doc = await req(admin, 'POST', `/api/resellers/${id}/files`,
    { dataUrl: IMG, category: 'document', label: 'BIR 2303' });
  assert.equal(doc.status, 200, JSON.stringify(doc.data));
  const proof = await req(admin, 'POST', `/api/resellers/${id}/files`,
    { dataUrl: IMG, category: 'payment_proof', label: 'BDO transfer 8/31' });
  assert.equal(proof.status, 200);

  const r = (await req(admin, 'GET', `/api/resellers/${id}`)).data;
  const paper = r.files.find((f) => Number(f.id) === doc.data.id);
  assert.ok(paper, 'the paper is on the account');
  assert.equal(paper.category, 'document');
  assert.equal(paper.label, 'BIR 2303');
  assert.equal(paper.uploaded_by, admin.username, 'stamped with who uploaded it');
  assert.ok(r.files.some((f) => f.category === 'payment_proof'), 'and the proof too');

  // The bytes come back as an image, not JSON.
  const img = await fetch(`${base}/api/reseller-files/${doc.data.id}`, { headers: { Cookie: admin } });
  assert.equal(img.status, 200);
  assert.match(img.headers.get('content-type'), /^image\//);

  const gone = await req(admin, 'DELETE', `/api/reseller-files/${doc.data.id}`);
  assert.equal(gone.status, 200);
  const after = (await req(admin, 'GET', `/api/resellers/${id}`)).data;
  assert.ok(!after.files.some((f) => Number(f.id) === doc.data.id), 'removed from the record');
});

test('a non-image, and an oversized category, are refused', async () => {
  const admin = await signIn('admin');
  const id = await newReseller();
  const notImg = await req(admin, 'POST', `/api/resellers/${id}/files`,
    { dataUrl: 'data:text/plain;base64,aGVsbG8=', category: 'document' });
  assert.equal(notImg.status, 400);
  // An unknown category falls back to 'document' rather than erroring — still an image required.
  const ok2 = await req(admin, 'POST', `/api/resellers/${id}/files`,
    { dataUrl: IMG, category: 'whatever' });
  assert.equal(ok2.status, 200);
  const r = (await req(admin, 'GET', `/api/resellers/${id}`)).data;
  assert.ok(r.files.every((f) => ['document', 'payment_proof'].includes(f.category)));
});

test('editing details and managing files is the owner\'s alone', async () => {
  const admin = await signIn('admin');
  const id = await newReseller();
  const doc = await req(admin, 'POST', `/api/resellers/${id}/files`, { dataUrl: IMG, category: 'document' });

  for (const role of ['cashier', 'orderdesk', 'warehouse', 'employee']) {
    const who = await signIn(role);
    assert.equal((await req(who, 'POST', `/api/resellers/${id}/details`, { name: 'X' })).status, 403,
      `${role} must not edit details`);
    assert.equal((await req(who, 'POST', `/api/resellers/${id}/files`, { dataUrl: IMG, category: 'document' })).status, 403,
      `${role} must not upload files`);
    const img = await fetch(`${base}/api/reseller-files/${doc.data.id}`, { headers: { Cookie: who } });
    assert.equal(img.status, 403, `${role} must not read the files`);
    assert.equal((await req(who, 'DELETE', `/api/reseller-files/${doc.data.id}`)).status, 403,
      `${role} must not delete files`);
  }
});
