// IT support: desktop support and hardware fixes.
//
// Anybody on staff writes a concern down once and follows the replies on it;
// the owner's sign-in is IT and sees the whole queue. What has to hold: you
// see your own tickets and nobody else's, only IT moves a ticket's status or
// reads the queue, and the roles left off — a reseller, the door tablet, the
// view-only sign-in — are refused past the router as well.
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
const db = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 4 });
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
  return (res.headers.getSetCookie?.()[0] ?? res.headers.get('set-cookie')).split(';')[0];
}

// The IT person: an admin whose sign-in is marked IT (db/182).
async function signInIT() {
  const cookie = await signIn('admin');
  const who = Buffer.from(cookie.split('=')[1].split('.')[0], 'base64url').toString();
  await db.query('update app_users set is_it = true where username = $1', [JSON.parse(who).username]);
  return cookie;
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

test('a staff member sends a concern, IT answers and resolves it, and the staff member sees it', async () => {
  const staff = await signIn('employee');
  const it = await signInIT();

  const sent = await POST(staff, '/api/it/tickets', {
    name: 'Jasmine', department: 'Office', category: 'hardware',
    issue: "Desktop won't turn on", urgency: 'high', details: 'Front counter PC, no lights.' });
  assert.equal(sent.status, 200, JSON.stringify(sent.data));
  const id = sent.data.id;

  const queue = await GET(it, '/api/it/queue?status=pending&urgency=high');
  const mine = queue.data.find((t) => t.id === id);
  assert.ok(mine, 'IT sees the new ticket in the pending, high queue');
  assert.equal(mine.category, 'hardware');
  assert.equal(mine.details, 'Front counter PC, no lights.');

  const waiting = await GET(it, '/api/it/waiting');
  assert.ok(waiting.data.waiting >= 1, 'and it counts towards the menu badge');

  assert.equal((await PUT(it, `/api/it/tickets/${id}/status`, { status: 'in_progress' })).status, 200);
  assert.equal((await POST(it, `/api/it/tickets/${id}/messages`,
    { body: 'On my way — check the power strip meanwhile.' })).status, 200);
  assert.equal((await PUT(it, `/api/it/tickets/${id}/status`, { status: 'resolved' })).status, 200);

  const back = (await GET(staff, '/api/it/mine')).data.find((t) => t.id === id);
  assert.equal(back.status, 'resolved');
  const last = back.messages.at(-1);
  assert.equal(last.from_it, true, 'the reply reads as IT\'s');
  assert.match(last.body, /power strip/);
  assert.equal(back.messages[0].body, "Desktop won't turn on\nFront counter PC, no lights.",
    'the concern and its details open the thread');
});

test('nobody sees, or writes on, somebody else\'s ticket', async () => {
  const a = await signIn('cashier');
  const b = await signIn('warehouse');
  const { id } = (await POST(a, '/api/it/tickets', { issue: 'Printer error', urgency: 'low', category: 'printer' })).data;

  assert.ok(!(await GET(b, '/api/it/mine')).data.some((t) => t.id === id), 'not in their list');
  const r = await POST(b, `/api/it/tickets/${id}/messages`, { body: 'not mine' });
  assert.notEqual(r.status, 200, 'and cannot reply on it');
});

test('only IT reads the queue or moves a status', async () => {
  const staff = await signIn('employee');
  const { id } = (await POST(staff, '/api/it/tickets', { issue: 'No internet', urgency: 'medium', category: 'network' })).data;
  assert.equal((await GET(staff, '/api/it/queue')).status, 403);
  assert.equal((await PUT(staff, `/api/it/tickets/${id}/status`, { status: 'resolved' })).status, 403);
  // Past the router too.
  await assert.rejects(asRole('employee', 'someone', 'select it_queue()'), /FORBIDDEN/);
  await assert.rejects(asRole('hr', 'someone', "select it_set_status($1,'resolved')", [id]), /FORBIDDEN/);
});

test('a reseller, the door tablet and view-only are not on IT support', async () => {
  for (const role of ['reseller', 'timekeeper', 'observer']) {
    await assert.rejects(asRole(role, 'someone', "select it_submit('x','','hardware','broken','low','')"),
      /FORBIDDEN/, `${role} refused past the router`);
    await assert.rejects(asRole(role, 'someone', 'select it_my_tickets()'), /FORBIDDEN/);
  }
});

test('IT support sits at the foot of every staff menu, and not on the others', () => {
  const menu = (role) => {
    const at = app.indexOf(`\n  ${role}: [`);
    return [...app.slice(at, app.indexOf('\n  ],', at)).matchAll(/\['([a-z]+)',/g)].map((m) => m[1]);
  };
  for (const role of ['admin', 'warehouse', 'cashier', 'supervisor', 'office', 'datacoord',
    'orderdesk', 'hr', 'employee']) {
    assert.equal(menu(role).at(-1), 'itsupport', `${role}: last on the menu`);
  }
  for (const role of ['observer', 'reseller']) {
    assert.ok(!menu(role).includes('itsupport'), `${role}: not on the menu`);
  }
});

test('the form\'s dropdowns: departments for everybody, the team for IT only', async () => {
  const staff = await signIn('employee');
  const it = await signInIT();
  const mine = (await GET(staff, '/api/it/choices')).data;
  assert.ok(Array.isArray(mine.departments));
  assert.deepEqual(mine.people, [], 'staff are not handed the team list');
  const its = (await GET(it, '/api/it/choices')).data;
  assert.ok(Array.isArray(its.people));
  await assert.rejects(asRole('employee', 'someone', 'select it_people()'), /FORBIDDEN/);
  const bad = await POST(staff, '/api/it/tickets', { issue: 'x', urgency: 'low', category: 'coffee' });
  assert.notEqual(bad.status, 200, 'a category that is not on the list is refused');
});

test('the Department dropdown is the company\'s own six departments', () => {
  assert.match(app,
    /const IT_DEPARTMENTS = \['Marketing', 'Ecommerce', 'Accounting', 'Admin', 'Warehouse', 'Other'\];/);
  assert.doesNotMatch(app, /IT_DEPARTMENTS = \[[^\]]*'Shop'/, 'there is no Shop department');
});

test('IT is one admin, not every admin', async () => {
  const it = await signInIT();
  const other = await signIn('admin');
  assert.equal((await GET(it, '/api/it/whoami')).data.it, true);
  assert.equal((await GET(other, '/api/it/whoami')).data.it, false);

  // Refused by the database, which the app reports in plain words.
  const q = await GET(other, '/api/it/queue');
  assert.notEqual(q.status, 200, 'another admin does not get the queue');
  assert.match(q.data.error, /does not allow/);
  assert.notEqual((await GET(other, '/api/it/waiting')).status, 200);
  const { id } = (await POST(other, '/api/it/tickets',
    { issue: 'Monitor flickers', urgency: 'low', category: 'hardware' })).data;
  assert.ok(id, 'but files concerns like everybody else');
  assert.notEqual((await PUT(other, `/api/it/tickets/${id}/status`, { status: 'resolved' })).status, 200);
  assert.deepEqual((await GET(other, '/api/it/choices')).data.people, []);

  assert.ok((await GET(it, '/api/it/queue')).data.some((t) => t.id === id), 'it reaches IT');
  // Past the router: admin alone is not enough.
  await assert.rejects(asRole('admin', 'not-it-anybody', 'select it_queue()'), /FORBIDDEN/);
});

test('for every admin, IT support goes to the top of the menu; only IT gets the dashboard', () => {
  assert.match(app, /if \(user\.role === 'admin'\) \{\s*\n\s*tabs = \[\.\.\.tabs\.filter\(\(\[id\]\) => id === 'itsupport'\)/);
  assert.match(app, /const isIT = user\.it === true;/);
});

test("IT's hardware masterlist: intake, no duplicate tags or serials, assigning, IT's alone", async () => {
  const it = await signInIT();
  const tag = `MSBA-LAP-${process.pid}${seq++}`;
  const serial = `SN-${process.pid}-${Date.now()}`;

  const added = await POST(it, '/api/it/assets', {
    kind: 'laptop', tag: tag.toLowerCase(), brand: 'Lenovo', model: 'ThinkPad E14',
    serial_no: serial, supplier: 'Octagon', po_ref: 'PO-0912', condition: ['brand_new', 'sealed'],
  });
  assert.equal(added.status, 200, JSON.stringify(added.data));
  let row = (await GET(it, '/api/it/assets')).data.find((a) => a.id === added.data.id);
  assert.equal(row.tag, tag, 'the tag is kept in capitals however it was typed');
  assert.equal(row.status, 'storage', 'a new unit starts in storage');
  assert.deepEqual(row.condition, ['brand_new', 'sealed']);

  assert.notEqual((await POST(it, '/api/it/assets', { kind: 'laptop', tag, brand: 'Dell' })).status, 200,
    'one tag, one unit');
  assert.notEqual((await POST(it, '/api/it/assets',
    { kind: 'laptop', tag: `${tag}-B`, brand: 'Dell', serial_no: serial })).status, 200,
    'two units never share a serial number');
  assert.notEqual((await POST(it, '/api/it/assets',
    { kind: 'laptop', tag: `${tag}-C`, brand: 'Dell', condition: ['aaaaa'] })).status, 200,
    'a condition off the checklist is refused');

  assert.notEqual((await PUT(it, `/api/it/assets/${added.data.id}`, { status: 'assigned' })).status, 200,
    'assigned means assigned to somebody');
  const assigned = await PUT(it, `/api/it/assets/${added.data.id}`, {
    status: 'assigned', assigned_to: 'Maria Santos', department: 'Accounting',
    deployed_on: '2026-10-12', notes: 'Accounting system and Epson drivers',
  });
  assert.equal(assigned.status, 200, JSON.stringify(assigned.data));
  row = (await GET(it, '/api/it/assets')).data.find((a) => a.id === added.data.id);
  assert.equal(row.assigned_to, 'Maria Santos');
  assert.equal(row.department, 'Accounting');

  await PUT(it, `/api/it/assets/${added.data.id}`, { status: 'storage', notes: 'Back from Maria' });
  row = (await GET(it, '/api/it/assets')).data.find((a) => a.id === added.data.id);
  assert.equal(row.assigned_to, null, 'back in storage, nobody has it');
  assert.equal(row.notes, 'Back from Maria');

  const other = await signIn('admin');
  assert.notEqual((await GET(other, '/api/it/assets')).status, 200, 'another admin does not get it');
  assert.notEqual((await POST(other, '/api/it/assets', { kind: 'laptop', tag: 'X', brand: 'Y' })).status, 200);
  await assert.rejects(asRole('admin', 'not-it-anybody', 'select it_assets_all()'), /FORBIDDEN/);
  await assert.rejects(asRole('admin', 'not-it-anybody', 'select * from it_assets'), /permission denied/);
});

test('Hardware assets is a third view for IT only', () => {
  assert.match(app, /const views = isIT \? \[\['dash', 'IT Dashboard'\], \['file', 'File Concern'\], \['assets', 'Hardware assets'\]\]/);
  assert.match(app, /: \[\['file', 'File Concern'\], \['mine', 'My requests'\]\]/, 'everybody else is unchanged');
});

test("an asset's receipt and photos: attached, shown, served, removed — IT's alone", async () => {
  const it = await signInIT();
  const { id } = (await POST(it, '/api/it/assets',
    { kind: 'monitor', tag: `MSBA-MON-${process.pid}${seq++}`, brand: 'Dell' })).data;
  // A 2×2 PNG.
  const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFklEQVR4nGP8z8DAwMDAxMDAwMDAAAANHQEDasKb6QAAAABJRU5ErkJggg==';

  const receipt = await POST(it, `/api/it/assets/${id}/files`, { kind: 'receipt', dataUrl: png });
  assert.equal(receipt.status, 200, JSON.stringify(receipt.data));
  assert.equal((await POST(it, `/api/it/assets/${id}/files`, { kind: 'photo', dataUrl: png })).status, 200);
  assert.notEqual((await POST(it, `/api/it/assets/${id}/files`,
    { kind: 'photo', dataUrl: 'data:application/pdf;base64,JVBERi0=' })).status, 200, 'images only');

  const row = (await GET(it, '/api/it/assets')).data.find((a) => a.id === id);
  assert.deepEqual(row.files.map((f) => f.kind).sort(), ['photo', 'receipt']);

  const file = await fetch(`${base}/api/it/asset-files/${receipt.data.id}`, { headers: { Cookie: it } });
  assert.equal(file.status, 200);
  assert.equal(file.headers.get('content-type'), 'image/jpeg', 'kept as a shrunk JPEG');

  const other = await signIn('admin');
  const peek = await fetch(`${base}/api/it/asset-files/${receipt.data.id}`, { headers: { Cookie: other } });
  assert.notEqual(peek.status, 200, 'another admin cannot open it');
  assert.notEqual((await POST(other, `/api/it/assets/${id}/files`, { kind: 'photo', dataUrl: png })).status, 200);
  await assert.rejects(asRole('admin', 'not-it-anybody', 'select * from it_asset_files'), /permission denied/);

  assert.equal((await request(it, 'DELETE', `/api/it/asset-files/${receipt.data.id}`)).status, 200);
  const after = (await GET(it, '/api/it/assets')).data.find((a) => a.id === id);
  assert.deepEqual(after.files.map((f) => f.kind), ['photo']);
});

test("Hardware assets has its own zoomable viewer, not the app-wide lightbox", () => {
  assert.match(app, /function itZoom\(src, cap\)/);
  assert.match(app, /data-itzoom="\/api\/it\/asset-files\/\$\{f\.id\}"/);
  assert.doesNotMatch(app, /data-zoom="\/api\/it\//, 'the shared lightbox is left alone');
});

test('intake asks for specs and description, not a PO; Supplier is Supplier / store', async () => {
  assert.match(app, /<label for="as_supplier">Supplier \/ store<\/label>/);
  assert.match(app, /<label for="as_specs">Specs and description<\/label>/);
  assert.doesNotMatch(app, /id="as_po"/, 'the purchase order box is gone');

  const it = await signInIT();
  const { id } = (await POST(it, '/api/it/assets', {
    kind: 'desktop', tag: `MSBA-DESK-${process.pid}${seq++}`, brand: 'Asus',
    model: 'AIO M3402WFA', supplier: 'PC Express', specs: 'Ryzen 5 7520U, 8GB RAM, 512GB SSD',
  })).data;
  const row = (await GET(it, '/api/it/assets')).data.find((a) => a.id === id);
  assert.equal(row.specs, 'Ryzen 5 7520U, 8GB RAM, 512GB SSD');
});

// Employee accountability forms (db/195): saved whole, a masterlist unit on a
// line reads as the employee's until it is marked returned, a unit can be out
// on one form at a time, and only IT reads or writes them.
test('accountability forms: lines follow the masterlist, returns free the unit, IT\'s alone', async () => {
  const it = await signInIT();
  const tag = `MSBA-DESK-${process.pid}${seq++}`;
  const { id: assetId } = (await POST(it, '/api/it/assets', { kind: 'desktop', tag, brand: 'Asus', model: 'AIO A3402' })).data;
  const emp = unique('Charmaine');
  const form = {
    employee: emp, employee_no: 'MS-00030', department: 'Marketing', superior: 'Jhazmine', released_by: 'Sonny',
    form_date: '2026-10-16',
    items: [
      { asset_id: assetId, qty: 1, equipment: 'AIO PC', serial_no: 'P84', issued_on: '2026-10-16' },
      { qty: 1, equipment: 'Calculator', model_no: 'JLX-837R', issued_on: '2026-07-01' },
      { equipment: '' },
    ],
  };
  const saved = await POST(it, '/api/it/accountability', form);
  assert.equal(saved.status, 200, JSON.stringify(saved.data));
  let mine = (await GET(it, '/api/it/accountability')).data.find((f) => f.id === saved.data.id);
  assert.equal(mine.items.length, 2, 'a blank line is left off');
  assert.equal(mine.items[0].asset_tag, tag);
  let unit = (await GET(it, '/api/it/assets')).data.find((a) => a.id === assetId);
  assert.equal(unit.status, 'assigned');
  assert.equal(unit.assigned_to, emp);

  // The same unit cannot go out on a second form while it is out.
  const twice = await POST(it, '/api/it/accountability', { employee: unique('Other'),
    items: [{ asset_id: assetId, equipment: 'AIO PC', issued_on: '2026-10-16' }] });
  assert.notEqual(twice.status, 200, 'a unit is out on one form at a time');
  // A return before its issue date is refused, in words.
  const early = await POST(it, '/api/it/accountability', { ...form, id: saved.data.id,
    items: [{ equipment: 'Mouse', issued_on: '2026-10-10', returned_on: '2026-10-01' }] });
  assert.notEqual(early.status, 200);
  assert.match(JSON.stringify(early.data), /returned before it was issued/);

  // Marked returned: back into storage.
  await POST(it, '/api/it/accountability', { ...form, id: saved.data.id, items: [
    { asset_id: assetId, qty: 1, equipment: 'AIO PC', issued_on: '2026-10-16', returned_on: '2026-10-20', return_note: 'Good' },
  ] });
  unit = (await GET(it, '/api/it/assets')).data.find((a) => a.id === assetId);
  assert.equal(unit.status, 'storage');
  mine = (await GET(it, '/api/it/accountability')).data.find((f) => f.id === saved.data.id);
  assert.equal(mine.items[0].returned_on.slice(0, 10), '2026-10-20');

  // Out again, then the form deleted: the unit goes back into storage.
  await POST(it, '/api/it/accountability', { ...form, id: saved.data.id,
    items: [{ asset_id: assetId, equipment: 'AIO PC', issued_on: '2026-10-21' }] });
  assert.equal((await GET(it, '/api/it/assets')).data.find((a) => a.id === assetId).status, 'assigned');
  assert.equal((await request(it, 'DELETE', `/api/it/accountability/${saved.data.id}`)).status, 200);
  assert.equal((await GET(it, '/api/it/assets')).data.find((a) => a.id === assetId).status, 'storage');

  const other = await signIn('admin');
  assert.notEqual((await GET(other, '/api/it/accountability')).status, 200, 'another admin does not get it');
  assert.notEqual((await POST(other, '/api/it/accountability', { employee: 'X' })).status, 200);
  await assert.rejects(asRole('admin', 'not-it-anybody', 'select it_acc_all()'), /FORBIDDEN/);
  await assert.rejects(asRole('admin', 'not-it-anybody', 'select * from it_accountability'), /permission denied/);
});

test('Hardware assets has its Accountability forms, downloaded as a Word file', () => {
  assert.match(app, /data-asview="acc"[^>]*>📝 Accountability forms<\/button>/);
  assert.match(app, /function itAccDocx\(f, logo\)/);
  assert.match(app, /application\/vnd\.openxmlformats-officedocument\.wordprocessingml\.document/);
  assert.match(app, /a\.download = `Accountability form - /);
  // The shop's own logo file and type: Poppins for the form, Georgia for its title.
  assert.match(app, /fetch\('\/logo\.png'\)/);
  assert.match(app, /name: 'word\/media\/logo\.png'/);
  assert.match(app, /w:ascii="Poppins"/);
});
