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

test('the Department dropdown is the company\'s own departments, Sales among them', () => {
  assert.match(app,
    /const IT_DEPARTMENTS = \['Marketing', 'Sales', 'Ecommerce', 'Accounting', 'Admin', 'Warehouse', 'IT', 'Other'\];/);
  assert.doesNotMatch(app, /IT_DEPARTMENTS = \[[^\]]*'Shop'/, 'there is no Shop department');
});

test('IT is one admin, not every admin', async () => {
  const it = await signInIT();
  const other = await signIn('admin');
  assert.equal((await GET(it, '/api/it/whoami')).data.it, true);
  assert.equal((await GET(other, '/api/it/whoami')).data.it, false);

  // Every admin may look at the queue, view only (db/205); answering and
  // moving tickets stay IT's.
  const q = await GET(other, '/api/it/queue');
  assert.equal(q.status, 200, 'another admin may look at the queue');
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
  assert.equal((await GET(other, '/api/it/assets')).status, 200, 'another admin may look (db/205)');
  assert.notEqual((await POST(other, '/api/it/assets', { kind: 'laptop', tag: 'X', brand: 'Y' })).status, 200);
  await assert.rejects(asRole('admin', 'not-it-anybody', 'select it_assets_all()'), /FORBIDDEN/);
  await assert.rejects(asRole('admin', 'not-it-anybody', 'select * from it_assets'), /permission denied/);
});

test('Hardware assets is a third view for IT only', () => {
  assert.match(app, /const views = isIT \? \[\['dash', 'IT Dashboard'\], \['file', 'File Concern'\], \['assets', 'Asset inventory masterlist'\]\]/);
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
  assert.equal(peek.status, 200, 'another admin may look at it (db/205)');
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
  assert.equal((await GET(other, '/api/it/accountability')).status, 200, 'another admin may look (db/205)');
  assert.notEqual((await POST(other, '/api/it/accountability', { employee: 'X' })).status, 200);
  await assert.rejects(asRole('admin', 'not-it-anybody', 'select it_acc_all()'), /FORBIDDEN/);
  await assert.rejects(asRole('admin', 'not-it-anybody', 'select * from it_accountability'), /permission denied/);
});

test('Hardware assets has its Accountability forms, downloaded as a Word file', () => {
  assert.match(app, /data-asview="acc"[^>]*>📝 Accountability forms<\/button>/);
  // Hardware assets, then Company property, then Accountability forms.
  assert.match(app, /🗂️ Hardware assets<\/button>\s*<button[^>]*data-asview="prop"[^>]*>🏢 Company property<\/button>\s*<button[^>]*data-asview="acc"/);
  // Hardware assets, then Company property, then Accountability forms.
  assert.match(app, /🗂️ Hardware assets<\/button>\s*<button[^>]*data-asview="prop"[^>]*>🏢 Company property<\/button>\s*<button[^>]*data-asview="acc"/);
  assert.match(app, /function itAccDocx\(f, logo\)/);
  assert.match(app, /application\/vnd\.openxmlformats-officedocument\.wordprocessingml\.document/);
  assert.match(app, /a\.download = `Accountability form - /);
  // The shop's own logo file and type: Poppins for the form, Georgia for its title.
  assert.match(app, /fetch\('\/logo\.png'\)/);
  assert.match(app, /name: 'word\/media\/logo\.png'/);
  assert.match(app, /w:ascii="Poppins"/);
});

// Company property (db/196): devices, appliances and furniture by room and
// person; rooms are picked from a list IT can add to, and every move is kept.
test('company property: by room and person, moves kept, rooms picked, IT\'s alone', async () => {
  const it = await signInIT();
  let data = (await GET(it, '/api/it/property')).data;
  for (const room of ['Warehouse 1st floor', 'Hallway 1st floor', 'Pantry', 'Accounting 2nd floor',
    'Head office 2nd floor', 'HR 2nd floor', '2nd floor warehouse stair', '2nd floor warehouse lobby']) {
    assert.ok(data.locations.some((l) => l.name === room), room);
  }
  const pantry = data.locations.find((l) => l.name === 'Pantry').id;
  const hr = data.locations.find((l) => l.name === 'HR 2nd floor').id;
  const tag = `MSBA-FUR-${process.pid}${seq++}`;
  const added = await POST(it, '/api/it/property', { category: 'furniture', tag: tag.toLowerCase(), item: 'Office chair',
    location_id: pantry, assigned_to: 'Angel' });
  assert.equal(added.status, 200, JSON.stringify(added.data));
  assert.notEqual((await POST(it, '/api/it/property', { category: 'furniture', tag, item: 'Chair' })).status, 200,
    'one tag, one item');
  assert.notEqual((await POST(it, '/api/it/property', { category: 'furniture', tag: `${tag}X`, item: 'Chair',
    location_id: 999999999 })).status, 200, 'a location is one from the list');

  await POST(it, '/api/it/property', { id: added.data.id, category: 'furniture', tag, item: 'Office chair',
    location_id: hr, assigned_to: 'Maria', condition: 'repair', move_note: 'New hire' });
  data = (await GET(it, '/api/it/property')).data;
  const row = data.items.find((x) => x.id === added.data.id);
  assert.equal(row.tag, tag.toUpperCase());
  assert.equal(row.location, 'HR 2nd floor');
  assert.equal(row.moves.length, 2, 'added, then moved');
  assert.equal(row.moves[0].from_location, 'Pantry');
  assert.equal(row.moves[0].to_person, 'Maria');
  assert.equal(row.moves[0].note, 'New hire');

  const room = `Conference ${process.pid}${seq++}`;
  assert.equal((await POST(it, '/api/it/property-locations', { name: room })).status, 200);
  assert.ok((await GET(it, '/api/it/property')).data.locations.some((l) => l.name === room));

  assert.equal((await request(it, 'DELETE', `/api/it/property/${added.data.id}`)).status, 200);
  const other = await signIn('admin');
  assert.equal((await GET(other, '/api/it/property')).status, 200, 'another admin may look (db/205)');
  assert.notEqual((await POST(other, '/api/it/property-locations', { name: 'X' })).status, 200);
  await assert.rejects(asRole('admin', 'not-it-anybody', 'select it_property_all()'), /FORBIDDEN/);
  await assert.rejects(asRole('admin', 'not-it-anybody', 'select * from it_property'), /permission denied/);
});

test('Hardware assets has a Company property tab', () => {
  assert.match(app, /data-asview="prop"[^>]*>🏢 Company property<\/button>/);
});

// Office supplies (db/197) is a fourth kind of company property, and both the
// Masterlist and Company property list what each employee holds.
test('office supplies are company property; both registers show what each employee holds', async () => {
  const it = await signInIT();
  const tag = `MSBA-SUP-${process.pid}${seq++}`;
  const r = await POST(it, '/api/it/property', { category: 'supplies', tag, item: 'Stapler', assigned_to: 'Charmaine' });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal((await GET(it, '/api/it/property')).data.items.find((x) => x.id === r.data.id).category, 'supplies');
  assert.notEqual((await POST(it, '/api/it/property', { category: 'snacks', tag: `${tag}X`, item: 'Chips' })).status, 200);
  assert.match(app, /supplies: \['Office supplies', 'SUP', '✂️'\]/);
  assert.match(app, /'Paper shredder'/);
  assert.match(app, /<h3>Assigned to employees<\/h3>/);
  assert.match(app, /<h3>By employee<\/h3>/);
  // Employees are at two branches: each person's branch, from their Team record.
  const people = await GET(it, '/api/it/people-branches');
  assert.equal(people.status, 200);
  assert.ok(Array.isArray(people.data));
  assert.equal((await GET(await signIn('admin'), '/api/it/people-branches')).status, 200, 'any admin may look (db/205)');
  assert.match(app, /🏬 \$\{esc\(b\)\}/);
});

test('every IT support tab opens on its own rose overview card', () => {
  for (const t of ["'IT SUPPORT OVERVIEW'", "'ASSET INVENTORY MASTERLIST OVERVIEW'", "'ACCOUNTABILITY OVERVIEW'", "'COMPANY PROPERTY OVERVIEW'"]) {
    assert.ok(app.includes(t), t);
  }
  const css = fs.readFileSync(path.join(here, '..', 'public/styles.css'), 'utf8');
  // The Masterlist's card sits on top, above Intake & unboxing.
  assert.match(app, /\$\{asSwitch\('list'\)\}\s*<div id="as_counts"><\/div>\s*<div class="panel">\s*<div class="itsteps">/);
  assert.match(css, /\.itov-card \{ background: linear-gradient\(135deg, var\(--rose-deep\), var\(--rose-primary\)\);/);
});

// Company property's photos (db/198): filed by room, and by item when IT
// says which; served and removed by IT alone.
test("a room's photos: attached, of an item or the room, served, removed — IT's alone", async () => {
  const it = await signInIT();
  const { locations } = (await GET(it, '/api/it/property')).data;
  const pantry = locations.find((l) => l.name === 'Pantry').id;
  const { id: itemId } = (await POST(it, '/api/it/property', { category: 'appliance',
    tag: `MSBA-APP-${process.pid}${seq++}`, item: 'Water cooler', location_id: pantry })).data;
  const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  const up = await POST(it, `/api/it/property-locations/${pantry}/files`, { dataUrl: png, property_id: itemId, caption: 'Front' });
  assert.equal(up.status, 200, JSON.stringify(up.data));
  assert.notEqual((await POST(it, `/api/it/property-locations/${pantry}/files`, { dataUrl: 'data:text/plain;base64,aGk=' })).status, 200);
  const files = (await GET(it, `/api/it/property-locations/${pantry}/files`)).data;
  const mine = files.find((f) => f.id === up.data.id);
  assert.equal(mine.item, 'Water cooler');
  assert.equal(mine.caption, 'Front');
  const got = await fetch(`${base}/api/it/property-files/${up.data.id}`, { headers: { Cookie: it } });
  assert.equal(got.status, 200);
  assert.equal(got.headers.get('content-type'), 'image/jpeg');
  const other = await signIn('admin');
  assert.equal((await fetch(`${base}/api/it/property-files/${up.data.id}`, { headers: { Cookie: other } })).status, 200, 'viewable (db/205)');
  assert.notEqual((await POST(other, `/api/it/property-locations/${pantry}/files`, { dataUrl: png })).status, 200);
  await assert.rejects(asRole('admin', 'not-it-anybody', 'select * from it_property_files'), /permission denied/);
  // Every photo has a name (db/199): typed, or the item's own; renamed later.
  assert.notEqual((await POST(it, `/api/it/property-locations/${pantry}/files`, { dataUrl: png })).status, 200,
    'a photo of the whole room is named');
  const byItem = await POST(it, `/api/it/property-locations/${pantry}/files`, { dataUrl: png, property_id: itemId });
  assert.equal((await GET(it, `/api/it/property-locations/${pantry}/files`)).data.find((f) => f.id === byItem.data.id).caption,
    'Water cooler', 'named after its item');
  assert.equal((await PUT(it, `/api/it/property-files/${byItem.data.id}`, { name: 'Fire alarm' })).status, 200);
  assert.equal((await GET(it, `/api/it/property-locations/${pantry}/files`)).data.find((f) => f.id === byItem.data.id).caption,
    'Fire alarm');
  assert.notEqual((await PUT(it, `/api/it/property-files/${byItem.data.id}`, { name: ' ' })).status, 200);
  assert.notEqual((await PUT(other, `/api/it/property-files/${byItem.data.id}`, { name: 'X' })).status, 200);
  assert.equal((await request(it, 'DELETE', `/api/it/property-files/${up.data.id}`)).status, 200);
  assert.ok(!(await GET(it, `/api/it/property-locations/${pantry}/files`)).data.some((f) => f.id === up.data.id));
  assert.match(app, /data-itzoom="\/api\/it\/property-files\/\$\{f\.id\}"/, 'zoomable in the IT viewer');
});

test("a room's photo can be tracked as an item there, so the room counts it", () => {
  assert.match(app, /<option value="new">＋ A new item in this room<\/option>/);
  assert.match(app, /const propTrack = async \(name, kind, loc\) =>/);
  assert.match(app, /data-prtrack="\$\{f\.id\}">＋ Track as an item<\/button>/);
});

test('Assigned to employees has its own ＋ Assign a unit, and the masterlist says where a stored unit went', () => {
  assert.match(app, /<button class="btn" id="as_assign" type="button">＋ Assign a unit<\/button>/);
  assert.match(app, /const assignUnit = \(\) =>/);
  assert.match(app, /set the last filter to Every status to see it/);
});

test("an employee's card lists everything they hold — units and company property — one compact line each", () => {
  assert.match(app, /const holdCard = \(name, units, items, opens\) =>/);
  assert.match(app, /holdCards\(assets, props, 'units'\)/);
  assert.match(app, /holdCards\(assets, props, 'props'\)/);
  const css = fs.readFileSync(path.join(here, '..', 'public/styles.css'), 'utf8');
  assert.match(css, /\.hold-line \{[^}]*font-size: \.78rem;/);
});

// Unit checks (db/200): IT checks a unit from time to time — its health then
// and a note — and the masterlist shows when, and colours the row.
test('a unit check: health and last-checked date kept, history kept, IT\'s alone', async () => {
  const it = await signInIT();
  const { id } = (await POST(it, '/api/it/assets', { kind: 'laptop', tag: `MSBA-LAP-${process.pid}${seq++}`, brand: 'Lenovo' })).data;
  let row = (await GET(it, '/api/it/assets')).data.find((a) => a.id === id);
  assert.equal(row.health, 'good');
  assert.equal(row.last_checked_at, null);
  assert.equal((await POST(it, `/api/it/assets/${id}/check`, { health: 'replace', note: 'Battery swelling' })).status, 200);
  row = (await GET(it, '/api/it/assets')).data.find((a) => a.id === id);
  assert.equal(row.health, 'replace');
  assert.ok(row.last_checked_at);
  assert.equal(row.checks[0].note, 'Battery swelling');
  assert.notEqual((await POST(it, `/api/it/assets/${id}/check`, { health: 'broken-ish' })).status, 200);
  const other = await signIn('admin');
  assert.notEqual((await POST(other, `/api/it/assets/${id}/check`, { health: 'good' })).status, 200);
  await assert.rejects(asRole('admin', 'not-it-anybody', 'select * from it_asset_checks'), /permission denied/);
  assert.match(app, /#as_list tr:has|<span class="hl-\$\{h\}"><\/span>/);
});

test('a refresh keeps IT support on the tab it was on, Hardware assets\' own tab too', () => {
  assert.match(app, /itKeep\('itView', v\);/);
  assert.match(app, /itKeep\('itAssetsView', k\);/);
  assert.match(app, /let view = views\.some\(\(\[k\]\) => k === itKept\('itView'\)\)/);
});

test('the masterlist takes an iPhone and an iMac as their own types (db/201)', async () => {
  const it = await signInIT();
  for (const [kind, pre] of [['iphone', 'IPH'], ['imac', 'IMAC']]) {
    const r = await POST(it, '/api/it/assets', { kind, tag: `MSBA-${pre}-${process.pid}${seq++}`, brand: 'Apple' });
    assert.equal(r.status, 200, JSON.stringify(r.data));
  }
  assert.match(app, /imac: \['iMac', 'IMAC'\]/);
  assert.match(app, /iphone: \['iPhone', 'IPH'\]/);
});

test('the accountability form downloads as one page', () => {
  // Fewer blank lines, a smaller logo, tighter spacing and margins: the
  // whole form, signatures and address included, fits a single A4 sheet.
  assert.match(app, /while \(items\.length < 10\)/, 'at least ten equipment lines');
  assert.match(app, /const cy = 777240;/);
  assert.match(app, /w:top="600" w:right="1000" w:bottom="500" w:left="1000"/);
});

test('company property takes desktops and laptops as kinds of their own (db/202)', async () => {
  const it = await signInIT();
  for (const [category, pre] of [['desktop', 'DSK'], ['laptop', 'LPT']]) {
    const r = await POST(it, '/api/it/property', { category, tag: `MSBA-${pre}-${process.pid}${seq++}`, item: 'PC' });
    assert.equal(r.status, 200, JSON.stringify(r.data));
  }
  assert.match(app, /desktop: \['Desktop', 'DSK', '🖥️'\], laptop: \['Laptop', 'LPT', '💻'\]/);
});

test('company property takes the masterlist hardware types, printers first (db/208)', async () => {
  const it = await signInIT();
  for (const [category, pre] of [['printer', 'PRT'], ['monitor', 'MNT'], ['smartphone', 'SPH'], ['iphone', 'IPN'], ['peripheral', 'PRP']]) {
    const r = await POST(it, '/api/it/property', { category, tag: `MSBA-${pre}-${process.pid}${seq++}`, item: 'Unit' });
    assert.equal(r.status, 200, JSON.stringify(r.data));
  }
  assert.match(app, /printer: \['Printer', 'PRT', '🖨️'\]/);
  assert.match(app, /const IT_PROP_ML = \{ desktop: \['desktop', 'imac'\], laptop: \['laptop'\], printer: \['printer'\],/);
});

test("the masterlist takes every one of Company property's kinds (db/209)", async () => {
  const it = await signInIT();
  for (const [kind, pre] of [['device', 'DVC'], ['appliance', 'APL'], ['furniture', 'FRN'], ['supplies', 'OFS']]) {
    const r = await POST(it, '/api/it/assets', { kind, tag: `MSBA-${pre}-${process.pid}${seq++}`, brand: 'Any' });
    assert.equal(r.status, 200, JSON.stringify(r.data));
  }
  assert.match(app, /device: \['Device', 'DVC'\], appliance: \['Appliance', 'APL'\], furniture: \['Furniture', 'FRN'\],/);
  assert.match(app, /device: \['device'\], appliance: \['appliance'\], furniture: \['furniture'\], supplies: \['supplies'\] \};/);
});

test("a viewer reads a room's items without opening them", () => {
  assert.match(app, /\$\{itViewer\n\s*\/\/ A viewer reads the room's items; only IT opens one to change it\.\n\s*\? '<div class="hold-row">' : `<button type="button" class="hold-row" data-roomitem="\$\{x\.id\}">`\}/);
});

test("a viewer opens a Company property item read-only", () => {
  assert.match(app, /if \(itViewer\) \$\$\('input, select, textarea', v\)\.forEach\(\(f\) => \{ f\.disabled = true; \}\);/);
  assert.match(app, /\$\{item && !itViewer \? `<div><label for="prf_move">/);
});

// IT viewers (db/203): an admin the owner names may look at IT support — the
// queue, the masterlist, company property, accountability forms, photos —
// and may change none of it; IT itself is unchanged.
test('an IT viewer reads everything IT sees and can write nothing', async () => {
  const it = await signInIT();
  const viewer = await signIn('admin');
  const who = Buffer.from(viewer.split('=')[1].split('.')[0], 'base64url').toString();
  const viewerName = JSON.parse(who).username;
  await db.query('update app_users set it_view = true where username = $1', [viewerName]);

  const { id: assetId } = (await POST(it, '/api/it/assets', { kind: 'laptop', tag: `MSBA-LAP-${process.pid}${seq++}`, brand: 'Dell' })).data;
  assert.deepEqual((await GET(viewer, '/api/it/whoami')).data, { it: false, view: true });
  assert.deepEqual((await GET(it, '/api/it/whoami')).data, { it: true, view: true });
  for (const p of ['/api/it/queue', '/api/it/assets', '/api/it/property', '/api/it/accountability', '/api/it/people-branches']) {
    assert.equal((await GET(viewer, p)).status, 200, p);
  }
  assert.ok((await GET(viewer, '/api/it/assets')).data.some((a) => a.id === assetId));

  // Nothing a viewer sends writes.
  assert.notEqual((await POST(viewer, '/api/it/assets', { kind: 'laptop', tag: `MSBA-LAP-V${seq++}`, brand: 'X' })).status, 200);
  assert.notEqual((await PUT(viewer, `/api/it/assets/${assetId}`, { status: 'retired' })).status, 200);
  assert.notEqual((await POST(viewer, `/api/it/assets/${assetId}/check`, { health: 'defective' })).status, 200);
  assert.notEqual((await POST(viewer, '/api/it/property', { category: 'device', tag: `MSBA-DEV-V${seq++}`, item: 'X' })).status, 200);
  assert.notEqual((await POST(viewer, '/api/it/accountability', { employee: 'X' })).status, 200);
  assert.notEqual((await POST(viewer, '/api/it/property-locations', { name: 'X' })).status, 200);
  assert.equal((await GET(it, '/api/it/assets')).data.find((a) => a.id === assetId).status, 'storage', 'untouched');

  // Past the router: a viewer outside a read-only transaction is refused,
  // inside one may read.
  await assert.rejects(asRole('admin', viewerName, 'select it_assets_all()'), /FORBIDDEN/);
  await assert.rejects(asRole('admin', viewerName, "select it_asset_check($1, '{}'::jsonb)", [assetId]), /FORBIDDEN/);
  const client = await db.connect();
  try {
    await client.query('begin');
    await client.query("select set_config('app.role','admin',true), set_config('app.actor',$1,true)", [viewerName]);
    await client.query('set local role app_client');
    await client.query('set transaction read only');
    assert.ok((await client.query('select it_assets_all() as a')).rows[0].a);
  } finally {
    await client.query('rollback').catch(() => {});
    client.release();
  }
  assert.match(app, /const itViewer = !isIT && user\.itView === true;/);
});

test('an HR sign-in marked as a viewer reads IT support too; an unmarked one does not (db/204)', async () => {
  const hr = await signIn('hr');
  const name = JSON.parse(Buffer.from(hr.split('=')[1].split('.')[0], 'base64url').toString()).username;
  assert.notEqual((await GET(hr, '/api/it/assets')).status, 200, 'not until marked');
  await db.query('update app_users set it_view = true where username = $1', [name]);
  assert.deepEqual((await GET(hr, '/api/it/whoami')).data, { it: false, view: true });
  for (const p of ['/api/it/queue', '/api/it/assets', '/api/it/property', '/api/it/accountability']) {
    assert.equal((await GET(hr, p)).status, 200, p);
  }
  assert.notEqual((await POST(hr, '/api/it/property', { category: 'device', tag: `MSBA-DEV-H${seq++}`, item: 'X' })).status, 200);
  await assert.rejects(asRole('hr', name, 'select it_assets_all()'), /FORBIDDEN/);
});

test("Company property's Desktop and Laptop also list the masterlist's computers", () => {
  assert.match(app, /const IT_PROP_ML = \{ desktop: \['desktop', 'imac'\], laptop: \['laptop'\],/);
  assert.match(app, /const PR_ML_KINDS = IT_PROP_ML;/);
  // Every kind lists the masterlist's units too, each under its own kind.
  assert.match(app, /const ml = \(!pf\.cat \|\| PR_ML_KINDS\[pf\.cat\]\) && !pf\.cond/);
  assert.match(app, /<td>\$\{IT_PROP_CATS\[mlCat\(a\)\]\[2\]\}/);
  assert.match(app, /data-mlopen="\$\{a\.id\}"/);
});

test('a masterlist unit sits on a floor, and Company property finds it there (db/206)', async () => {
  const it = await signInIT();
  const hr = (await GET(it, '/api/it/property')).data.locations.find((l) => l.name === 'HR 2nd floor').id;
  const { id } = (await POST(it, '/api/it/assets', { kind: 'desktop', tag: `MSBA-DESK-${process.pid}${seq++}`, brand: 'Asus' })).data;
  assert.equal((await PUT(it, `/api/it/assets/${id}/location`, { location_id: hr })).status, 200);
  const row = (await GET(it, '/api/it/assets')).data.find((a) => a.id === id);
  assert.equal(row.location, 'HR 2nd floor');
  assert.notEqual((await PUT(it, `/api/it/assets/${id}/location`, { location_id: 999999999 })).status, 200);
  assert.notEqual((await PUT(await signIn('admin'), `/api/it/assets/${id}/location`, { location_id: null })).status, 200,
    'a viewer cannot move it');
  assert.match(app, /<label for="asd_loc">Location \(floor \/ room\)<\/label>/);
});

test("a room's window can place a masterlist unit in it", () => {
  assert.match(app, /<button class="btn" type="button" id="prr_place">📍 Place here<\/button>/);
  assert.match(app, /await PUT\(`\/api\/it\/assets\/\$\{id\}\/location`, \{ location_id: loc\.id \}\);/);
});

test("a room's gallery shows its masterlist computers' photos, and takes new ones for them", () => {
  assert.match(app, /<figure class="pr-mlphoto"><img src="\/api\/it\/asset-files\/\$\{f\.id\}"/);
  assert.match(app, /await POST\(`\/api\/it\/assets\/\$\{track\.slice\(3\)\}\/files`, \{ kind: 'photo'/);
});

test('the Asset inventory masterlist also lists Company property, marked so', () => {
  assert.match(app, /<optgroup label="🏢 Company property">/);
  assert.match(app, /\.map\(\(x\) => \(\{ \.\.\.x, _prop: true \}\)\);/);
  assert.match(app, /data-asprop="\$\{a\.id\}">Open<\/button>/);
});

test("Company property's Desktops and Laptops count the masterlist's computers in their number", () => {
  assert.match(app, /const total = qtyOf\(live\.filter\(\(x\) => x\.category === k\)\) \+ more;/);
});

test("the masterlist's units show an icon and Company property under their category, like property rows", () => {
  assert.match(app, /\$\{IT_UNIT_ICON\[a\.kind\] \|\| '🖥️'\} \$\{esc\(\(IT_KINDS\[a\.kind\] \|\| \[a\.kind\]\)\[0\]\)\}\n\s*<div class="dim">🏢 Company property<\/div>/);
  assert.doesNotMatch(app, /<div class="dim">🗂️ Asset inventory<\/div>/, 'every row reads Company property under its category');
});

test('the masterlist takes a printer as its own type (db/207)', async () => {
  const it = await signInIT();
  const r = await POST(it, '/api/it/assets', { kind: 'printer', tag: `MSBA-PRN-${process.pid}${seq++}`, brand: 'Epson' });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.match(app, /printer: \['Printer', 'PRN'\]/);
});

test("a room's photos carry their item's condition, and a masterlist photo its unit's health", () => {
  // Every tracked photo, Good included; every masterlist photo, Working well included.
  assert.match(app, /return x \? `<span>\$\{tag\(\.\.\.\(IT_PROP_COND\[x\.condition\]/);
  assert.match(app, /<span>\$\{tag\(\.\.\.\(IT_HEALTH\[a\.health \|\| 'good'\]/);
});

test("Company property's masterlist rows: Location is just the room, Condition is the unit's condition", () => {
  const at = app.indexOf('const mlRows = ml.map((a) => `<tr class="pr-mlrow">');
  const row = app.slice(at, app.indexOf(".join('');", at));
  assert.doesNotMatch(row, /from the masterlist/);
  assert.doesNotMatch(row, /IT_ASSET_STATUS/, 'no Assigned to employee under Condition');
  assert.match(row, /a\.health && a\.health !== 'good' \? \(IT_HEALTH\[a\.health\] \|\| \[a\.health, 'grey'\]\) : \['Good', 'green'\]/);
});
