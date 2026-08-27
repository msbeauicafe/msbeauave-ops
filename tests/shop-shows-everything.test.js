// The shop window shows the whole shop.
//
// public_catalog stopped at 200 rows, and sorted what is on a shelf first.
// The catalogue passed 200 in-stock products some time ago, so from then on
// every product with nothing on the shelf was invisible in the storefront —
// 667 of 867 on the day this was found. Nothing said so. The page simply
// ended, and a customer scrolling to the bottom had no way to tell she had
// been shown a quarter of the shop.
//
// It surfaced sideways: somebody uploaded a photograph of the 250ml lotion,
// went to the shop to admire it, saw no such product, and concluded the
// upload had failed. It had not. A silent truncation reads as a broken
// feature somewhere else entirely, which is what makes it worth a test.
import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { server } from '../scripts/dev.js';
import { pool } from '../lib/db.js';

const db = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 4 });
let base;

test.before(async () => {
  await new Promise((done) => server.listen(0, done));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(async () => {
  await db.query("delete from products where brand = 'SHELFLESS TEST'");
  await new Promise((done) => server.close(done));
  await pool.end();
  await db.end();
});

// Comfortably past the old ceiling, so the truncation shows even in a database
// that already holds a few products of its own.
const MANY = 260;

test.before(async () => {
  await db.query("delete from products where brand = 'SHELFLESS TEST'");
  // Active, priced, and with no batch behind them — so every one of these is a
  // real product of the shop with nothing on the shelf, which is exactly the
  // kind that used to fall off the end.
  await db.query(`
    insert into products (sku, name, brand, category, retail_price, active)
    select 'ZZ-SHELFLESS-' || lpad(i::text, 4, '0'),
           'Zzz Shelfless Test Product ' || lpad(i::text, 4, '0'),
           'SHELFLESS TEST', 'Testing', 99, true
      from generate_series(1, $1) as i`, [MANY]);
});

const catalogue = async (term = '') => {
  const res = await fetch(`${base}/api/shop/catalog${term ? `?q=${encodeURIComponent(term)}` : ''}`);
  assert.equal(res.status, 200, 'the shop catalogue is open to anyone');
  return res.json();
};

test('a product with nothing on the shelf still reaches the shop window', async () => {
  const rows = await catalogue();
  const mine = rows.filter((p) => p.sku.startsWith('ZZ-SHELFLESS-'));
  assert.equal(mine.length, MANY,
    `${MANY} shelfless products were put in and ${mine.length} came back — `
    + 'the catalogue is being truncated, and a customer cannot tell');
});

test('the last product alphabetically is not the one that gets dropped', async () => {
  const rows = await catalogue();
  const last = `ZZ-SHELFLESS-${String(MANY).padStart(4, '0')}`;
  assert.ok(rows.some((p) => p.sku === last),
    `${last} sorts last of all and is the first casualty of any limit`);
});

test('what is on the shelf still comes first', async () => {
  const rows = await catalogue();
  const firstOut = rows.findIndex((p) => !p.in_stock);
  if (firstOut === -1) return;   // nothing out of stock in this database
  const lateIn = rows.slice(firstOut).find((p) => p.in_stock);
  assert.equal(lateIn, undefined,
    `${lateIn?.sku} is in stock but sits below a sold-out product — `
    + 'the shop should lead with what can be bought today');
});

test('searching still finds a product that has nothing on the shelf', async () => {
  const rows = await catalogue('Zzz Shelfless Test Product 0257');
  assert.equal(rows.length, 1, 'one product matches that name exactly');
  assert.equal(rows[0].in_stock, false);
});
