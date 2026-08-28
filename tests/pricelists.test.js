// The price list, whole.
//
// Every product down the page and every price code across it. The office
// reads a price list down a column — what a Regional pays against what a
// Sub-Reseller does — and until this screen the only way to see that was to
// open one product card at a time, eight hundred times.
//
// It is read-only on purpose. A price is changed on the product it belongs
// to, where the change is deliberate and lands on one thing; a grid of eight
// hundred editable boxes is a place to make a mistake nobody notices for a
// month.
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

async function signIn(role) {
  const username = unique(role);
  await db.query(
    `insert into app_users (username, display_name, password_hash, role)
     values ($1,$1,$2,$3)`, [username, hashPassword('secret123'), role]);
  const res = await fetch(`${base}/api/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password: 'secret123' }),
  });
  assert.equal(res.status, 200);
  const raw = res.headers.getSetCookie?.()[0] ?? res.headers.get('set-cookie');
  return raw.split(';')[0];
}

test('Pricelists sits directly under Finance, and only for the owner', () => {
  const at = app.indexOf('  admin: [');
  const admin = app.slice(at, app.indexOf('\n  ],', at));
  const entries = [...admin.matchAll(/\['([a-z]+)',\s*'[^']*',\s*'([^']+)'\]/g)]
    .map((m) => m[2]);
  const fin = entries.indexOf('Finance');
  assert.ok(fin >= 0, 'the owner has a Finance menu');
  assert.equal(entries[fin + 1], 'Pricelists', 'and Pricelists is the next one down');

  // A cashier has Finance too and no business reading what a dealer pays.
  const cashierAt = app.indexOf('  cashier: [');
  const cashier = app.slice(cashierAt, app.indexOf('\n  ],', cashierAt));
  assert.ok(!cashier.includes("'Pricelists'"), 'a cashier does not get the price list');
});

test('the whole list comes back in one request, codes and all', async () => {
  const admin = await signIn('admin');
  const sku = unique('SKU');
  const made = await POST(admin, '/api/products', {
    sku, name: `Test ${sku}`, brand: 'Beau Glow', category: 'Serums',
    unit_cost: 100, wholesale_price: 250, srp: 400, retail_price: 450,
    shelf_life_months: 24,
  });
  assert.equal(made.status, 200, JSON.stringify(made.data));
  await POST(admin, `/api/products/${sku}/price`, { code: 'RD', price: 168 });

  const r = await GET(admin, '/api/pricelist');
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.ok(Array.isArray(r.data.codes) && r.data.codes.length >= 5,
    'the columns come with the rows, so the screen does not guess them');
  assert.ok(r.data.codes.includes('SUB RD'), 'Sub-Reseller is one of them');

  const mine = r.data.products.find((p) => p.sku === sku);
  assert.ok(mine, 'the product is on the list');
  assert.equal(Number(mine.prices.RD), 168, 'with the price that was set');
  assert.equal(mine.prices['SUB RD'], undefined,
    'and no invented figure where none is set');
});

test('a cashier cannot read the price list', async () => {
  const till = await signIn('cashier');
  const r = await GET(till, '/api/pricelist');
  assert.ok(r.status === 403 || r.status === 401,
    `a cashier got ${r.status} rather than being turned away`);
});

test('a price that is not set reads as missing, not as nothing owed', () => {
  const at = app.indexOf('SCREENS.pricelists = async');
  assert.ok(at > 0, 'there is a Pricelists screen');
  const screen = app.slice(at, app.indexOf('\n};', at));
  assert.match(screen, /p\.prices\[c\] == null[\s\S]{0,80}class="over">—/,
    'an unset price is a dash in the danger colour, never a blank cell that '
    + 'reads as a zero');
  assert.match(screen, /prices not set|price\$\{/,
    'the screen counts what is missing, because that is the thing to act on');
  // The search box and the gaps filter are inputs; the price cells must not
  // be. Read-only means no editing of figures, not a screen with no controls.
  const cells = screen.slice(screen.indexOf('...data.codes.map('),
                             screen.indexOf("{ head: 'Retail'"));
  assert.ok(!/<input|data-price|contenteditable/.test(cells),
    'the grid is read-only — a price is changed on the product it belongs to, '
    + 'where the change is deliberate and lands on one thing');
});

// VIP, STOCKIST and EXEC carry no prices at all. Showing them as three columns
// of dashes would have added some 2,700 blanks to the "not set" count — and
// that count exists to say what somebody has to go and fill in, so burying the
// real handful under phantom gaps makes it worse than no count.
test('a code nobody prices under is not in use, not a column of gaps', () => {
  const at = app.indexOf('SCREENS.pricelists = async');
  const screen = app.slice(at, app.indexOf('\n};', at));
  assert.match(screen, /const inUse = \(\) => data\.codes\.filter/,
    'the screen works out which codes carry a price at all');
  assert.match(screen, /const codes = inUse\(\);/,
    'and draws only those columns');
  assert.match(screen, /not in use/,
    'the unused ones are named, so nobody thinks the code has gone missing');
  assert.ok(!/data\.codes\.reduce/.test(screen),
    'the missing count is over the codes in use, not over every code there is');
});
