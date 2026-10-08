// The shop's category chips leave out a category with no name.
//
// A product saved with a blank category put an empty chip beside "All" in the
// storefront. The product itself still belongs in the shop; only the chip goes.
import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { server } from '../scripts/dev.js';
import { pool } from '../lib/db.js';

const db = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 2 });
let base;

const clear = () => db.query("delete from products where brand = 'BLANK CAT TEST'");

test.before(async () => {
  await clear();
  await db.query(`
    insert into products (sku, name, brand, category, retail_price, active) values
      ('ZZ-BLANKCAT-1', 'Zzz Blank Category One', 'BLANK CAT TEST', '',    99, true),
      ('ZZ-BLANKCAT-2', 'Zzz Blank Category Two', 'BLANK CAT TEST', '   ', 99, true)`);
  await new Promise((done) => server.listen(0, done));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(async () => {
  await clear();
  await new Promise((done) => server.close(done));
  await pool.end();
  await db.end();
});

test('no chip is drawn for a blank category', async () => {
  const res = await fetch(`${base}/api/shop/categories`);
  assert.equal(res.status, 200);
  const blank = (await res.json()).filter((c) => !String(c.category ?? '').trim());
  assert.deepEqual(blank, [], 'a category with no name has no chip');
});

test('a product with a blank category is still in the shop', async () => {
  const res = await fetch(`${base}/api/shop/catalog?q=Zzz%20Blank%20Category`);
  const rows = await res.json();
  assert.equal(rows.length, 2, 'both products are shown under All');
});
