// Every endpoint the app has.
//
// Handlers stay thin on purpose: they check nothing the database already
// checks, and they call the functions in db/002_rules.sql rather than writing
// to tables. If a rule looks like it is missing here, it is because it lives
// where it cannot be bypassed.
import crypto from 'node:crypto';
import sharp from 'sharp';
import { on, ok, fail, send, ANYONE, ADMIN, STOCK, TILL, STAFF, SUPER, CLOCKDEV,
  RESELLER, PERSON, NOTICEBOARD, OBSERVE, OWN_ACCOUNT, OWN_RECORD,
  ORDERDESK, ORDERWORK } from './router.js';
import { pool, queryAll } from './db.js';
import { today, daysAgo } from './day.js';
import { hashPassword, checkPassword, sessionCookie, clearedCookie, readSession, publicUser,
  shopperCookie, clearedShopper, readShopper } from './auth.js';

const int = (v) => (v == null ? null : Number(v));
const limit = (v, fallback = 200, max = 1000) => {
  const n = Math.floor(Number(v));
  return Number.isFinite(n) && n > 0 ? Math.min(n, max) : fallback;
};

// ---------------------------------------------------------------------------
// Signing in
// ---------------------------------------------------------------------------
on('POST', '/api/login', ANYONE, async ({ req, res, body }) => {
  const found = await pool.query(
    'select * from app_users where lower(username) = lower($1) and active',
    [body.username || '']);
  const user = found.rows[0];
  if (!user || !checkPassword(body.password || '', user.password_hash)) {
    return fail(res, 401, 'That username and password do not match.');
  }
  res.setHeader('Set-Cookie', sessionCookie(user, req));
  ok(res, { user: publicUser({
    username: user.username, name: user.display_name,
    role: user.role, resellerId: user.reseller_id,
  }) });
});

on('POST', '/api/logout', ANYONE, async ({ res }) => {
  res.setHeader('Set-Cookie', clearedCookie);
  ok(res, { done: true });
});

// Public on purpose: the page has to ask who it is before it can know, and a
// 401 on first paint is just noise in the console. Signed out is a fact.
on('GET', '/api/me', ANYONE, async ({ req, res }) => {
  const session = readSession(req);
  ok(res, { user: session ? publicUser(session) : null });
});

// ---------------------------------------------------------------------------
// The owner's dashboard — everything that needs a decision today
// ---------------------------------------------------------------------------
on('GET', '/api/dashboard', OBSERVE, async ({ db, res, user }) => {
  // Blocking is decided live off the invoices; this writes the flag and its
  // event so the account history records it. Opening the dashboard is the
  // daily sweep, since there is no scheduler in this build.
  //
  // Not for somebody who may look and not touch. Opening a screen is not a
  // reason to write to a reseller's account history, and the function refuses
  // an observer anyway — which turned the whole dashboard into an error rather
  // than the read-only view it was supposed to be.
  if (user.role === 'admin') await db.query('select refresh_blocks()');

  const [takings, waiting, reorder, ageing, overdue, exposure, shelf, restock, expired, variance] =
    await queryAll(db, [
      [`select count(*)::int as sales, coalesce(sum(total), 0) as total
          from orders where channel = 'shop' and status = 'fulfilled'
           and placed_at::date = current_date`],
      [`select count(*)::int as n from orders
         where channel = 'b2b' and status in ('placed','picking')`],
      ['select * from reorder_alerts order by short_by desc'],
      ['select * from ageing_stock order by days_left limit 25'],
      [`select i.id, i.due_on, r.name, (i.amount - i.paid - i.discount) as balance,
               (current_date - i.due_on)::int as days_late
          from invoices i join resellers r on r.id = i.reseller_id
         where i.status = 'open' and i.due_on < current_date
         order by i.due_on`],
      ['select * from ar_concentration where flagged'],
      ['select * from shelf_alerts order by on_shelf'],
      [`select t.*, p.name from restock_tasks t join products p on p.sku = t.sku
         where t.status = 'open' order by t.raised_at`],
      ['select * from expired_stock'],
      ['select * from cash_variance_watch'],
    ]);

  const everything = {
    takings: takings.rows[0],
    waitingOrders: waiting.rows[0].n,
    reorder: reorder.rows,
    ageing: ageing.rows,
    overdue: overdue.rows,
    exposure: exposure.rows,
    shelf: shelf.rows,
    restock: restock.rows,
    expired: expired.rows,
    cashVariance: variance.rows,
  };
  // What is left out for somebody who may look and not touch: the day's
  // takings, who owes us, how exposed we are to one of them, and which
  // cashier's drawer keeps coming up short. Those four are the owner's book,
  // not a management report — and the last is a person's honesty, which is not
  // something fifteen colleagues should read over breakfast.
  //
  // Taken out of the reply rather than hidden on the page. A figure removed in
  // the browser is a figure anybody can still read.
  ok(res, user.role === 'observer'
    ? { ...everything, takings: null, overdue: [], exposure: [], cashVariance: [] }
    : everything);
});

// ---------------------------------------------------------------------------
// Products and batches
// ---------------------------------------------------------------------------
on('GET', '/api/products', [...STAFF, 'observer'], async ({ db, res, query }) => {
  const term = `%${query.q || ''}%`;
  const r = await db.query(
    `select s.*, ph.has_photo from stock_summary s
       join product_has_photo ph on ph.sku = s.sku
      where s.sku ilike $1 or s.name ilike $1 or coalesce(s.brand, '') ilike $1
      order by s.name`, [term]);
  ok(res, r.rows);
});

on('POST', '/api/products', ['admin', 'datacoord'], async ({ db, res, body, user }) => {
  // A data coordinator adds the product; the owner prices it. So the three
  // selling-price columns are forced to nothing here rather than taken from
  // the form, and the product lands off the shelf until Pricelists gives it a
  // figure. The owner's own add keeps every field.
  const priced = user.role !== 'datacoord';
  await db.query(
    `insert into products (sku, name, brand, category, unit_cost, wholesale_price,
                           srp, retail_price, shelf_life_months, reseller_floor_months, shelf_min)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,coalesce($10,12),coalesce($11,0))`,
    [body.sku, body.name, body.brand || null, body.category || null,
     body.unit_cost || 0,
     priced ? (body.wholesale_price || 0) : 0,
     priced ? (body.srp || 0) : 0,
     priced ? (body.retail_price || 0) : 0,
     body.shelf_life_months || 24, int(body.reseller_floor_months), int(body.shelf_min)]);
  ok(res, { done: true });
});

on('PUT', '/api/products/:sku', ['admin', 'datacoord'], async ({ db, res, body, params, user }) => {
  // The selling prices are the owner's, so they are simply not among the
  // fields a data coordinator can change — a form that sends them anyway has
  // them ignored rather than refused.
  const allowed = ['name', 'brand', 'category', 'unit_cost',
    ...(user.role === 'datacoord' ? [] : ['wholesale_price', 'srp', 'retail_price']),
    'shelf_life_months', 'reseller_floor_months', 'shelf_min', 'active',
    'alloc_b2b', 'alloc_shop', 'alloc_reserve'];
  const sets = [];
  const values = [params.sku];
  for (const field of allowed) {
    if (field in body) { values.push(body[field]); sets.push(`${field} = $${values.length}`); }
  }
  if (!sets.length) return fail(res, 400, 'Nothing to change.');
  const r = await db.query(
    `update products set ${sets.join(', ')} where sku = $1`, values);
  if (!r.rowCount) return fail(res, 404, 'No product with that code.');
  ok(res, { done: true });
});

// A whole delivery note at once, in one transaction: either it all landed or
// none of it did. Half a delivery is the worst outcome, because the numbers
// look plausible and nobody goes looking.
on('POST', '/api/deliveries', STOCK, async ({ db, res, body }) => {
  if (!Array.isArray(body.lines) || !body.lines.length) {
    return fail(res, 400, 'That delivery note is empty.');
  }
  const r = await db.query('select receive_delivery($1::jsonb,$2) as result',
    [JSON.stringify(body.lines), body.branch_id ? Number(body.branch_id) : null]);
  ok(res, r.rows[0].result);
});

// A batch can sit at more than one shop, so this answers per shop. Without a
// branch it lists them all, which is what the Products screen wants.
on('GET', '/api/products/:sku/batches', [...STAFF, 'observer'], async ({ db, res, params, query }) => {
  const r = await db.query(
    `select * from batch_detail
      where sku = $1 and branch_visible(branch_id, $2)
      order by expiry, branch`,
    [params.sku, query.branch ? Number(query.branch) : null]);
  ok(res, r.rows);
});

// ---------------------------------------------------------------------------
// The whole catalogue at once
//
// A brand issues a price list, not thirty separate product changes, and typing
// thirty dialogs is how a price list ends up half applied. The parsing happens
// in the browser so mistakes are visible before anything is sent; what arrives
// here is already a checked list, and the database checks it again before it
// writes a single row.
// ---------------------------------------------------------------------------
on('POST', '/api/catalogue', ADMIN, async ({ db, res, body }) => {
  if (!Array.isArray(body.items) || !body.items.length) {
    return fail(res, 400, 'That price list is empty.');
  }
  const r = await db.query('select replace_catalogue($1::jsonb) as result',
    [JSON.stringify(body.items)]);
  ok(res, r.rows[0].result);
});

// Erasing the practice run. Kept apart from loading the catalogue on purpose:
// this is the one call with no way back, so it is asked for on its own.
on('POST', '/api/catalogue/erase', ADMIN, async ({ db, res, body }) => {
  const r = await db.query('select start_fresh($1, $2) as result',
    [body.confirm || '', body.resellers !== false]);
  ok(res, r.rows[0].result);
});

// ---------------------------------------------------------------------------
// Buying: suppliers, and the orders put to them
//
// Everything else in this file is the company selling. This is the company
// buying, which is the stockroom's business and the owner's — never a
// reseller's, and what this company pays its suppliers is not on a portal.
// ---------------------------------------------------------------------------
on('GET', '/api/suppliers', STOCK, async ({ db, res }) => {
  const r = await db.query(
    'select * from suppliers where active order by name');
  ok(res, r.rows);
});

on('POST', '/api/suppliers', STOCK, async ({ db, res, body }) => {
  const r = await db.query('select save_supplier($1,$2,$3,$4,$5,$6) as id',
    [body.id ? Number(body.id) : null, body.name, body.brand_name || null,
     body.tin || null, body.address || null, body.contact || null]);
  ok(res, { id: Number(r.rows[0].id) });
});

on('GET', '/api/purchase-orders', STOCK, async ({ db, res, query }) => {
  const r = await db.query(
    `select o.*, s.name as supplier, s.brand_name, s.tin, s.address, s.contact,
            (select count(*)::int from purchase_order_lines l where l.po_id = o.id) as lines,
            (select coalesce(sum(greatest(l.qty - l.received, 0)), 0)::int
               from purchase_order_lines l where l.po_id = o.id) as still_short
       from purchase_orders o
       join suppliers s on s.id = o.supplier_id
      where ($1 = '' or o.status = $1)
      order by o.at desc limit 100`, [query.status || '']);
  ok(res, r.rows);
});

on('GET', '/api/purchase-orders/:id', STOCK, async ({ db, res, params }) => {
  const [po, lines] = await queryAll(db, [
    [`select o.*, s.name as supplier, s.brand_name, s.tin, s.address, s.contact
        from purchase_orders o join suppliers s on s.id = o.supplier_id
       where o.id = $1`, [Number(params.id)]],
    [`select l.*, p.name, p.unit_type
        from purchase_order_lines l join products p on p.sku = l.sku
       where l.po_id = $1 order by l.id`, [Number(params.id)]],
  ]);
  if (!po.rows.length) return fail(res, 404, 'No such purchase order.');
  ok(res, { ...po.rows[0], lines: lines.rows });
});

on('POST', '/api/purchase-orders', STOCK, async ({ db, res, body }) => {
  const lines = (body.lines || [])
    .map((l) => ({ sku: l.sku, qty: Number(l.qty), unit: l.unit || 'PCS' }))
    .filter((l) => l.sku && l.qty > 0);
  if (!lines.length) return fail(res, 400, 'A purchase order needs at least one line.');
  const r = await db.query('select raise_purchase_order($1,$2::jsonb,$3,$4) as result',
    [Number(body.supplier_id), JSON.stringify(lines), body.note || null,
     body.ordered_on || null]);
  ok(res, r.rows[0].result);
});

on('POST', '/api/purchase-orders/:id/cancel', STOCK, async ({ db, res, params }) => {
  await db.query('select cancel_purchase_order($1)', [Number(params.id)]);
  ok(res, { cancelled: true });
});

// Receiving a line of one. The stock side is receive_stock, unchanged; what
// this adds is the note against the order of how much that delivery covered.
on('POST', '/api/purchase-orders/lines/:line/receive', STOCK, async ({ db, res, params, body }) => {
  const cost = body.unit_cost === '' || body.unit_cost == null ? null : Number(body.unit_cost);
  const r = await db.query('select receive_po_line($1,$2,$3,$4,$5,$6,$7) as result',
    [Number(params.line), body.batch_no, body.expiry, Number(body.qty), cost,
     body.method || 'bank', body.branch_id ? Number(body.branch_id) : null]);
  ok(res, r.rows[0].result);
});

// ---------------------------------------------------------------------------
// The receiving form: what actually came off the van
//
// The purchase order is what went out. This is what came back, written in
// boxes rather than units, with the courier, the shipping and the guard around
// it. The stock side is receive_stock underneath, once per product.
// ---------------------------------------------------------------------------
on('GET', '/api/receiving-forms', STOCK, async ({ db, res, query }) => {
  const r = await db.query(
    `select f.*, s.name as supplier, s.brand_name, o.po_no,
            (select count(distinct l.line_no)::int
               from receiving_form_lines l where l.rf_id = f.id) as products,
            (select coalesce(sum(l.qty), 0)::int
               from receiving_form_lines l where l.rf_id = f.id) as units
       from receiving_forms f
       join suppliers s on s.id = f.supplier_id
       left join purchase_orders o on o.id = f.po_id
      where ($1 = 0 or f.po_id = $1)
      order by f.at desc limit 100`, [Number(query.po_id) || 0]);
  ok(res, r.rows);
});

on('GET', '/api/receiving-forms/:id', STOCK, async ({ db, res, params }) => {
  const [form, lines] = await queryAll(db, [
    [`select f.*, s.name as supplier, s.brand_name, s.tin, s.address,
             s.contact as supplier_contact, o.po_no
        from receiving_forms f
        join suppliers s on s.id = f.supplier_id
        left join purchase_orders o on o.id = f.po_id
       where f.id = $1`, [Number(params.id)]],
    [`select l.*, p.name
        from receiving_form_lines l join products p on p.sku = l.sku
       where l.rf_id = $1 order by l.line_no, l.id`, [Number(params.id)]],
  ]);
  if (!form.rows.length) return fail(res, 404, 'No such receiving form.');
  ok(res, { ...form.rows[0], lines: lines.rows });
});

on('POST', '/api/receiving-forms', STOCK, async ({ db, res, body }) => {
  // One entry per product, each carrying the packings it arrived in. A packing
  // with no count is somebody halfway through typing, not a delivery.
  const lines = (body.lines || []).map((l) => ({
    sku: l.sku,
    unit: l.unit || 'PCS',
    batch_no: l.batch_no,
    expiry: l.expiry,
    unit_cost: l.unit_cost === '' || l.unit_cost == null ? null : String(l.unit_cost),
    po_line_id: l.po_line_id ? String(l.po_line_id) : null,
    packs: (l.packs || [])
      .map((p) => ({
        pack: p.pack || 'BOX',
        qty_per_box: Number(p.qty_per_box),
        boxes: Number(p.boxes) || 1,
      }))
      .filter((p) => p.qty_per_box > 0 && p.boxes > 0),
  })).filter((l) => l.sku && l.packs.length);
  if (!lines.length) return fail(res, 400, 'A receiving form needs at least one product.');

  const r = await db.query(
    'select record_receiving_form($1,$2::jsonb,$3::jsonb,$4::jsonb,$5,$6) as result',
    [body.supplier_id ? Number(body.supplier_id) : null,
     JSON.stringify(lines),
     JSON.stringify(body.courier || {}),
     JSON.stringify(body.foot || {}),
     body.po_id ? Number(body.po_id) : null,
     body.branch_id ? Number(body.branch_id) : null]);
  ok(res, r.rows[0].result);
});

on('POST', '/api/receive', STOCK, async ({ db, res, body }) => {
  // An empty cost box means "unchanged", not "free": null leaves the product's
  // existing cost alone, which is what receiving a repeat delivery should do.
  const cost = body.unit_cost === '' || body.unit_cost == null ? null : Number(body.unit_cost);
  const received = await db.query('select receive_stock($1,$2,$3,$4,$5,$6,$7) as id',
    [body.sku, body.batch_no, body.expiry, Number(body.qty), cost, body.method || 'bank',
     body.branch_id ? Number(body.branch_id) : null]);
  const batchId = Number(received.rows[0].id);
  const split = await db.query(
    `select pool, on_hand from stock where batch_id = $1
      and branch_id = branch_or_default($2) order by pool`,
    [batchId, body.branch_id ? Number(body.branch_id) : null]);
  ok(res, { batchId, allocation: split.rows });
});

// What arrived lately, and whether it can still be taken back. The list says
// why a delivery is stuck as well as that it is, so the reason is read rather
// than discovered by pressing a button that then refuses.
on('GET', '/api/receipts', STOCK, async ({ db, res, query }) => {
  const r = await db.query('select * from recent_receipts limit $1',
    [Math.min(Number(query.limit) || 25, 100)]);
  ok(res, r.rows);
});

// Undoing one. Admin only, and it insists on a reason, because deleting the
// receipt deletes the evidence it was ever entered — the reason is what is
// left behind.
on('POST', '/api/receipts/:id/undo', ADMIN, async ({ db, res, params, body }) => {
  if (!String(body.why || '').trim()) {
    return fail(res, 400, 'Say why this delivery is being undone.');
  }
  const r = await db.query('select reverse_receipt($1, $2) as result',
    [Number(params.id), String(body.why)]);
  ok(res, r.rows[0].result);
});

on('GET', '/api/reversals', STOCK, async ({ db, res }) => {
  const r = await db.query('select * from receipt_reversals order by at desc limit 25');
  ok(res, r.rows);
});

// ---------------------------------------------------------------------------
// Moving stock about
// ---------------------------------------------------------------------------
on('POST', '/api/move', STOCK, async ({ db, res, body }) => {
  await db.query('select move_stock($1,$2,$3,$4,$5,$6)',
    [Number(body.batchId), body.from, body.to, Number(body.qty), 'transfer',
     body.branch_id ? Number(body.branch_id) : null]);
  ok(res, { done: true });
});

on('GET', '/api/branch-stock', [...STAFF, 'observer'], async ({ db, res, query }) => {
  const r = await db.query(
    `select * from branch_stock
      where branch_visible(branch_id, $1)
        and ($2 = '' or name ilike '%' || $2 || '%' or sku ilike '%' || $2 || '%')`,
    [query.branch ? Number(query.branch) : null, query.q || '']);
  ok(res, r.rows);
});

on('GET', '/api/takings-by-branch', SUPER, async ({ db, res, query }) => {
  const r = await db.query(
    `select * from takings_by_branch
      where business_date between $1 and $2
        and branch_visible(branch_id, null) limit 400`,
    [query.from || today(),
     query.to || today()]);
  ok(res, r.rows);
});

// Sending stock to another shop. The pool does not change — what was on the
// shelf here is on the shelf there.
on('POST', '/api/transfer', STOCK, async ({ db, res, body }) => {
  await db.query('select transfer_stock($1,$2,$3,$4,$5)',
    [Number(body.batchId), body.pool || 'shop', Number(body.from_branch),
     Number(body.to_branch), Number(body.qty)]);
  ok(res, { done: true });
});

on('GET', '/api/expired', [...STOCK, 'observer'], async ({ db, res }) => {
  const r = await db.query('select * from expired_stock order by expiry');
  ok(res, r.rows);
});

on('POST', '/api/expired/write-off', STOCK, async ({ db, res, body }) => {
  const r = await db.query('select write_off_expired($1,$2) as units',
    [body.batchId == null ? null : Number(body.batchId),
     body.branch_id ? Number(body.branch_id) : null]);
  ok(res, { units: Number(r.rows[0].units) });
});

on('POST', '/api/stock-count', STOCK, async ({ db, res, body }) => {
  const r = await db.query('select to_jsonb(record_stock_count($1,$2,$3)) as row',
    [body.sku, Number(body.counted), body.branch_id ? Number(body.branch_id) : null]);
  ok(res, r.rows[0].row);
});

on('GET', '/api/stock-counts', [...STOCK, 'observer'], async ({ db, res }) => {
  const r = await db.query(
    `select c.*, p.name from stock_counts c join products p on p.sku = c.sku
      order by c.at desc limit 50`);
  ok(res, r.rows);
});

on('GET', '/api/restock', [...STAFF, 'observer'], async ({ db, res }) => {
  const r = await db.query(
    `select t.*, p.name from restock_tasks t join products p on p.sku = t.sku
      order by (t.status = 'open') desc, t.raised_at desc limit 100`);
  ok(res, r.rows);
});

on('POST', '/api/restock', STAFF, async ({ db, res, body }) => {
  const r = await db.query('select raise_restock($1,$2) as id', [body.sku, body.note || null]);
  ok(res, { id: Number(r.rows[0].id) });
});

on('POST', '/api/restock/:id/done', STOCK, async ({ db, res, params }) => {
  await db.query('select close_restock($1)', [Number(params.id)]);
  ok(res, { done: true });
});

// ---------------------------------------------------------------------------
// Wholesale orders
// ---------------------------------------------------------------------------
on('GET', '/api/orders', [...ORDERWORK, 'observer'], async ({ db, res, query }) => {
  const status = query.status || '';
  const r = await db.query(
    `select * from order_board
      where channel = 'b2b'
        and ($1 = ''
             or ($1 = 'delivered' and delivered_at is not null)
             or ($1 <> 'delivered' and status = $1
                 and ($1 <> 'fulfilled' or delivered_at is null)))
      order by placed_at desc limit 200`, [status]);
  ok(res, r.rows);
});

on('GET', '/api/orders/:id', [...ORDERWORK, 'observer'], async ({ db, res, params }) => {
  const id = Number(params.id);
  const [order, lines] = await queryAll(db, [
    ['select * from order_board where id = $1', [id]],
    [`select l.id, l.sku, coalesce(l.description, p.name) as name, l.description,
             l.qty, l.unit_price, l.price_code, p.unit_type,
             b.batch_no, b.expiry
        from order_lines l
        join products p on p.sku = l.sku
        join batches b on b.id = l.batch_id
       where l.order_id = $1
       order by b.expiry, b.id`, [id]],
  ]);
  if (!order.rows.length) return fail(res, 404, 'No such order.');
  ok(res, { ...order.rows[0], lines: lines.rows });
});

for (const [path, fn, done] of [
  ['picking', 'start_picking', 'Picking started.'],
  ['dispatch', 'fulfil_order', 'Dispatched — stock is out of the building.'],
  ['deliver', 'mark_delivered', 'Marked delivered.'],
  ['cancel', 'cancel_order', 'Cancelled — the stock is back on sale.'],
]) {
  on('POST', `/api/orders/:id/${path}`, ORDERWORK, async ({ db, res, params }) => {
    await db.query(`select ${fn}($1)`, [Number(params.id)]);
    ok(res, { done: true, message: done });
  });
}

// ---------------------------------------------------------------------------
// Resellers and their credit
// ---------------------------------------------------------------------------
on('GET', '/api/resellers', [...OBSERVE, 'orderdesk'], async ({ db, res }) => {
  const r = await db.query(
    `select r.*, amount_outstanding(r.id) as owed, has_overdue(r.id) as overdue,
            reseller_credit_balance(r.id) as credit,
            (select max(o.placed_at) from orders o where o.reseller_id = r.id) as last_order_at,
            (select extract(epoch from ph.updated_at)::bigint
               from reseller_photos ph where ph.reseller_id = r.id) as photo_at,
            (select count(*)::int from invoices i
              where i.reseller_id = r.id and i.status = 'paid'
                and i.settled_on <= i.due_on) as paid_on_time,
            (select count(*)::int from reseller_events e
              where e.reseller_id = r.id and e.kind = 'paid_late'
                and e.at > now() - interval '90 days') as late_this_quarter,
            -- The newest invoice still open. Invoice ids climb, so the largest
            -- is the most recent, which is what puts the account somebody has
            -- just invoiced at the top of the list rather than wherever the
            -- alphabet happens to leave them.
            (select max(i.id) from invoices i
              where i.reseller_id = r.id and i.status = 'open') as newest_open
       from resellers r
      order by newest_open desc nulls last, r.name`);
  ok(res, r.rows);
});

on('POST', '/api/resellers', ADMIN, async ({ db, res, body }) => {
  const r = await db.query('select create_reseller($1,$2,$3,$4,$5,$6) as id',
    [body.name, body.contact || null, body.email || null,
     body.tier || 1, body.credit_limit || 0, body.terms_days || 0]);
  ok(res, { id: Number(r.rows[0].id) });
});

on('GET', '/api/resellers/:id', [...OBSERVE, 'orderdesk'], async ({ db, res, params }) => {
  const id = Number(params.id);
  const [account, invoices, events, documents, credits, files] = await queryAll(db, [
    [`select r.*, amount_outstanding(r.id) as owed, has_overdue(r.id) as overdue,
             reseller_credit_balance(r.id) as credit,
             (select max(o.placed_at) from orders o where o.reseller_id = r.id) as last_order_at,
             (select extract(epoch from ph.updated_at)::bigint
                from reseller_photos ph where ph.reseller_id = r.id) as photo_at
        from resellers r where r.id = $1`, [id]],
    [`select i.*, (i.amount - i.paid - i.discount) as balance,
             (i.status = 'open' and i.due_on < current_date) as overdue
        from invoices i where i.reseller_id = $1 order by i.issued_on desc`, [id]],
    ['select * from reseller_events where reseller_id = $1 order by at desc limit 50', [id]],
    ['select * from reseller_documents where reseller_id = $1 order by uploaded_at desc', [id]],
    ['select * from reseller_credits where reseller_id = $1 order by at desc limit 20', [id]],
    [`select id, category, label, uploaded_by, uploaded_at
        from reseller_files where reseller_id = $1 order by uploaded_at desc`, [id]],
  ]);
  if (!account.rows.length) return fail(res, 404, 'No such account.');
  ok(res, { ...account.rows[0], invoices: invoices.rows,
            events: events.rows, documents: documents.rows, credits: credits.rows,
            files: files.rows });
});

on('POST', '/api/resellers/:id/approve', ADMIN, async ({ db, res, params }) => {
  await db.query('select approve_reseller($1)', [Number(params.id)]);
  ok(res, { done: true });
});

// Who the account is for tax. One route for all five, because they are one
// block on one form and are read off one certificate.
// A shop's own picture on their card. Shrunk once here, and to a square,
// because the card is a square — cropping happens once, on the way in, where
// it can be done attentively, rather than every time a browser is handed the
// wrong shape. Everything after this is a read, and the reason a read stays
// cheap.
on('POST', '/api/resellers/:id/photo', ADMIN, async ({ db, res, params, body }) => {
  const match = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/.exec(body.dataUrl || '');
  if (!match) return fail(res, 400, 'That file is not a JPEG, PNG or WebP image.');
  const uploaded = Buffer.from(match[2], 'base64');
  if (uploaded.length > 900_000) return fail(res, 400, 'That picture is too large.');

  const bytes = await sharp(uploaded)
    .rotate()
    .resize({ width: 240, height: 240, fit: 'cover', position: 'attention',
              withoutEnlargement: true })
    .jpeg({ quality: 82 })
    .toBuffer();

  await db.query('select set_reseller_photo($1,$2,$3)',
    [Number(params.id), 'image/jpeg', bytes]);
  ok(res, { saved: true });
});

on('DELETE', '/api/resellers/:id/photo', ADMIN, async ({ db, res, params }) => {
  await db.query('select clear_reseller_photo($1)', [Number(params.id)]);
  ok(res, { cleared: true });
});

// Removing the account itself. Refused for one with any trading history — the
// database says so, in a message the account's name is folded into — and 409
// carries that straight back to the button that asked.
on('DELETE', '/api/resellers/:id', ADMIN, async ({ db, res, params }) => {
  try {
    await db.query('select remove_reseller($1)', [Number(params.id)]);
    ok(res, { removed: true });
  } catch (e) {
    if (/REMOVE_BLOCKED|no such account/i.test(e.message)) {
      return fail(res, 409, e.message.replace(/^REMOVE_BLOCKED:\s*/, ''));
    }
    throw e;
  }
});

// Bytes rather than JSON, written straight to the socket. A caller that names
// the version gets a year, because the address only changes when the picture
// does; one that does not gets a minute, so a replaced picture is noticed.
on('GET', '/api/resellers/:id/photo', [...STAFF, 'orderdesk'], async ({ db, res, params, query }) => {
  const r = await db.query(
    'select mime, bytes, updated_at from reseller_photos where reseller_id = $1',
    [Number(params.id)]);
  const photo = r.rows[0];
  if (!photo) return fail(res, 404, 'No photograph.');
  const versioned = query.v != null && query.v !== '';
  res.writeHead(200, {
    'Content-Type': photo.mime,
    'Content-Length': photo.bytes.length,
    'Cache-Control': versioned
      ? 'private, max-age=31536000, immutable'
      : 'private, max-age=60',
    ETag: `"r${params.id}-${new Date(photo.updated_at).getTime()}"`,
  });
  res.end(photo.bytes);
});

// Where the reseller is reached: their Facebook name and the links across
// Facebook and the marketplaces. Any may be left blank.
on('PUT', '/api/resellers/:id/socials', ADMIN, async ({ db, res, params, body }) => {
  await db.query('select set_reseller_socials($1,$2,$3,$4,$5,$6)',
    [Number(params.id), body.fb_name || null, body.fb_link || null,
     body.shopee_link || null, body.tiktok_link || null, body.lazada_link || null]);
  ok(res, { saved: true });
});

on('POST', '/api/resellers/:id/tax', ADMIN, async ({ db, res, params, body }) => {
  await db.query('select set_reseller_tax($1,$2,$3,$4,$5,$6)',
    [Number(params.id), body.tax_type || null, body.trade_name || null,
     body.taxpayer_name || null, body.tin || null, body.business_address || null]);
  ok(res, { done: true });
});

// Whether this account buys to send on to somebody else. One does; the rest
// do not, and a Drop ship box on every order is a field sixty accounts have to
// ignore and one has to remember.
on('POST', '/api/resellers/:id/dropship', ADMIN, async ({ db, res, params, body }) => {
  await db.query('select set_reseller_drop_ship($1,$2,$3)',
    [Number(params.id), body.on === true, body.to || null]);
  ok(res, { on: body.on === true, to: body.to || null });
});

on('POST', '/api/resellers/:id/terms', ADMIN, async ({ db, res, params, body }) => {
  await db.query('select set_terms($1,$2,$3,$4)',
    [Number(params.id), Number(body.tier), Number(body.credit_limit), Number(body.terms_days)]);
  ok(res, { done: true });
});

// The account's own details — its name and how to reach it. Editable now, and
// the change goes on the record with the actor who made it.
on('POST', '/api/resellers/:id/details', ADMIN, async ({ db, res, params, body }) => {
  try {
    await db.query('select edit_reseller($1,$2,$3,$4,$5,$6,$7,$8,$9)',
      [Number(params.id), body.name || '', body.contact || null, body.email || null,
       body.chat_link || null, body.full_name || null, body.birthday || null,
       body.real_address || null, body.contact_number || null]);
    ok(res, { done: true });
  } catch (e) {
    if (/needs a name|no such account/i.test(e.message)) return fail(res, 400, e.message.replace(/^.*:\s*/, ''));
    throw e;
  }
});

// Files on an account: papers (BIR, permits) and proofs of a bank transfer.
// Kept full-shape and legible — a certificate cropped to a square proves
// nothing — but shrunk once here so a phone photograph is not stored whole.
on('POST', '/api/resellers/:id/files', ADMIN, async ({ db, res, params, body }) => {
  const match = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/.exec(body.dataUrl || '');
  if (!match) return fail(res, 400, 'That file is not a JPEG, PNG or WebP image.');
  const category = body.category === 'payment_proof' ? 'payment_proof' : 'document';
  const uploaded = Buffer.from(match[2], 'base64');
  if (uploaded.length > 6_000_000) return fail(res, 400, 'That image is too large.');

  const bytes = await sharp(uploaded)
    .rotate()
    .resize({ width: 1500, height: 1500, fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: 80 })
    .toBuffer();

  const r = await db.query('select add_reseller_file($1,$2,$3,$4,$5) as id',
    [Number(params.id), category, body.label || null, 'image/jpeg', bytes]);
  ok(res, { id: Number(r.rows[0].id) });
});

// One file's bytes, written straight to the socket.
on('GET', '/api/reseller-files/:fileId', ADMIN, async ({ db, res, params }) => {
  const r = await db.query('select mime, bytes, uploaded_at from reseller_files where id = $1',
    [Number(params.fileId)]);
  const f = r.rows[0];
  if (!f) return fail(res, 404, 'No such file.');
  res.writeHead(200, {
    'Content-Type': f.mime,
    'Content-Length': f.bytes.length,
    'Cache-Control': 'private, max-age=31536000, immutable',
    ETag: `"f${params.fileId}-${new Date(f.uploaded_at).getTime()}"`,
  });
  res.end(f.bytes);
});

on('DELETE', '/api/reseller-files/:fileId', ADMIN, async ({ db, res, params }) => {
  try {
    await db.query('select remove_reseller_file($1)', [Number(params.fileId)]);
    ok(res, { cleared: true });
  } catch (e) {
    if (/no such file/i.test(e.message)) return fail(res, 404, e.message.replace(/^.*:\s*/, ''));
    throw e;
  }
});

// The ladder: what each tier is worth, and who is not standing on their rung.
on('GET', '/api/reseller-tiers', OBSERVE, async ({ db, res }) => {
  const [ladder, adrift] = await queryAll(db, [
    ['select * from reseller_tiers order by tier', []],
    ['select * from resellers_off_ladder', []],
  ]);
  ok(res, { ladder: ladder.rows, offLadder: adrift.rows });
});

// Promoting an account. Naming the rung is the whole instruction — the limit
// and the days come from the ladder, so they cannot be mistyped one at a time.
on('POST', '/api/resellers/:id/tier', ADMIN, async ({ db, res, params, body }) => {
  const tier = Number(body.tier);
  if (![1, 2, 3].includes(tier)) return fail(res, 400, 'The ladder has tiers 1, 2 and 3.');
  await db.query('select set_tier($1,$2)', [Number(params.id), tier]);
  ok(res, { done: true });
});

// Editing a rung. Every account still standing on it moves with it; the ones
// given terms of their own stay where they were put.
on('PUT', '/api/reseller-tiers/:tier', ADMIN, async ({ db, res, params, body }) => {
  const tier = Number(params.tier);
  if (![1, 2, 3].includes(tier)) return fail(res, 400, 'The ladder has tiers 1, 2 and 3.');
  const limit = Number(body.credit_limit);
  const days = Number(body.terms_days);
  if (!(limit >= 0) || !(days >= 0)) {
    return fail(res, 400, 'A limit and a number of days, neither below zero.');
  }
  if (tier === 1 && (limit > 0 || days > 0)) {
    return fail(res, 400,
      'Tier 1 is the floor: it pays before dispatch, so it carries no credit and no days.');
  }
  const r = await db.query('select set_tier_ladder($1,$2,$3) as moved', [tier, limit, days]);
  ok(res, { moved: Number(r.rows[0].moved) });
});

on('POST', '/api/resellers/:id/override', ADMIN, async ({ db, res, params, body }) => {
  if (!body.note) return fail(res, 400, 'An override needs a reason — it goes on the record.');
  await db.query('select override_block($1,$2)', [Number(params.id), body.note]);
  ok(res, { done: true });
});

on('POST', '/api/resellers/:id/documents', ORDERDESK, async ({ db, res, params, body }) => {
  await db.query('select attach_document($1,$2,$3)',
    [Number(params.id), body.kind, body.reference]);
  ok(res, { done: true });
});

on('POST', '/api/invoices/:id/payment', ADMIN, async ({ db, res, params, body }) => {
  await db.query('select record_payment($1,$2,$3)',
    [Number(params.id), Number(body.amount),
     body.paid_on || today()]);
  ok(res, { done: true });
});

// The same money, said properly: five rows against ONE invoice, each with the
// bank it came through and that bank's own reference. The account-level
// confirm applies oldest-first and cannot be told which bill is meant; this is
// for when somebody is looking at a particular bill and knows.
on('POST', '/api/invoices/:id/payments', ORDERDESK, async ({ db, res, params, body }) => {
  const rows = (body.payments || [])
    .map((p) => ({
      amount: String(p.amount ?? '').trim(),
      paid_on: p.paid_on || null,
      method: p.method || null,
      details: p.details || null,
      reference_no: p.reference_no || null,
    }))
    .filter((p) => Number(p.amount) > 0);
  if (!rows.length) {
    return fail(res, 400, 'Fill in at least one row — how much actually landed?');
  }
  const r = await db.query('select record_invoice_payments($1,$2::jsonb) as result',
    [Number(params.id), JSON.stringify(rows)]);
  ok(res, r.rows[0].result);
});

// One payment against the account, not one invoice. Settles what is open,
// oldest first, and returns exactly where the money went — which invoice got
// how much, and how much (if any) is left over as credit — so the answer to
// "did that cover it" is read off the reply rather than worked out by hand.
on('POST', '/api/resellers/:id/payment', ADMIN, async ({ db, res, params, body }) => {
  const amount = Number(body.amount);
  if (!(amount > 0)) return fail(res, 400, 'A payment must be more than zero.');
  const r = await db.query('select pay_reseller_account($1,$2,$3) as result',
    [Number(params.id), amount, body.paid_on || today()]);
  ok(res, r.rows[0].result);
});

// The catalogue a reseller orders from, read by whoever is placing the order
// on their behalf — the FB-chat flow, where the conversation and the order
// happen in different places and someone here has to bridge them.
// The price codes an order line may be given, in the order they are read off
// the paper: each base followed by the adjustments of it.
on('GET', '/api/price-codes', ORDERDESK, async ({ db, res }) => {
  const r = await db.query(
    `select code, base_code, adjust,
            exists (select 1 from product_prices pp
                     where pp.code = coalesce(c.base_code, c.code)) as priced
       from price_codes c where active order by sort, code`);
  ok(res, r.rows);
});

// Setting one. The price list is nine figures per product rather than
// seventeen, because the other eight codes are one of those nine adjusted.
on('POST', '/api/products/:sku/price', ADMIN, async ({ db, res, params, body }) => {
  const price = Number(body.price);
  if (!(price >= 0)) return fail(res, 400, 'What price?');
  if (!body.code) return fail(res, 400, 'Which code?');
  await db.query('select set_price($1, $2, $3)', [params.sku, body.code, price]);
  ok(res, { sku: params.sku, code: body.code, price });
});

// What an adjusting code does to its base, in pesos per unit. Signed: the
// owner types what they mean and reads it back on a real invoice.
on('POST', '/api/price-codes/:code/adjustment', ADMIN, async ({ db, res, params, body }) => {
  const adjust = Number(body.adjust);
  if (!Number.isFinite(adjust)) return fail(res, 400, 'How much, in pesos?');
  await db.query('select set_code_adjustment($1, $2)', [params.code, adjust]);
  ok(res, { code: params.code, adjust });
});

// What a product's prices are under every code that carries a list.
on('GET', '/api/products/:sku/prices', ADMIN, async ({ db, res, params }) => {
  const r = await db.query(
    `select c.code, pp.price
       from price_codes c
       left join product_prices pp on pp.sku = $1 and pp.code = c.code
      where c.base_code is null and c.active
      order by c.sort, c.code`, [params.sku]);
  ok(res, r.rows);
});

// Saved chat-order drafts — a basket parked to finish later. The desk's own.
// A draft is the person's own, nobody else's — everyone at the desk parks
// their own baskets and sees only those. Scoped to current_actor() so one
// order-taker's half-finished order never shows up in another's list.
on('GET', '/api/order-drafts', ORDERDESK, async ({ db, res }) => {
  const r = await db.query(
    `select d.id, d.reseller_id, r.name as reseller, d.saved_by, d.updated_at,
            jsonb_array_length(d.lines) as items
       from order_drafts d join resellers r on r.id = d.reseller_id
      where d.saved_by = current_actor()
      order by d.updated_at desc limit 100`);
  ok(res, r.rows);
});

on('GET', '/api/order-drafts/:id', ORDERDESK, async ({ db, res, params }) => {
  const r = await db.query(
    `select d.id, d.reseller_id, r.name as reseller, d.lines, d.saved_by, d.updated_at
       from order_drafts d join resellers r on r.id = d.reseller_id
      where d.id = $1 and d.saved_by = current_actor()`,
    [Number(params.id)]);
  if (!r.rows.length) return fail(res, 404, 'No such draft.');
  ok(res, r.rows[0]);
});

on('POST', '/api/order-drafts', ORDERDESK, async ({ db, res, body }) => {
  if (!body.reseller_id) return fail(res, 400, 'Which account is this draft for?');
  const lines = Array.isArray(body.lines) ? body.lines : [];
  if (!lines.length) return fail(res, 400, 'A draft needs at least one line.');
  const r = await db.query(
    'insert into order_drafts (reseller_id, lines) values ($1, $2::jsonb) returning id',
    [Number(body.reseller_id), JSON.stringify(lines)]);
  ok(res, { id: Number(r.rows[0].id) });
});

// Editing a parked basket updates that one draft rather than spawning another,
// so one order keeps one draft. A different order — a fresh basket — is a new
// draft, saved on its own.
on('PUT', '/api/order-drafts/:id', ORDERDESK, async ({ db, res, params, body }) => {
  const lines = Array.isArray(body.lines) ? body.lines : [];
  if (!lines.length) return fail(res, 400, 'A draft needs at least one line.');
  const r = await db.query(
    `update order_drafts set lines = $2::jsonb, updated_at = now()
      where id = $1 and saved_by = current_actor() returning id`,
    [Number(params.id), JSON.stringify(lines)]);
  if (!r.rows.length) return fail(res, 404, 'No such draft.');
  ok(res, { id: Number(r.rows[0].id) });
});

on('DELETE', '/api/order-drafts/:id', ORDERDESK, async ({ db, res, params }) => {
  await db.query('delete from order_drafts where id = $1 and saved_by = current_actor()',
    [Number(params.id)]);
  ok(res, { done: true });
});

// Who this order is being sent on to. Refused unless the account is set up
// for it, so a stray field on a form cannot quietly put a third party's name
// on somebody else's invoice.
on('POST', '/api/orders/:id/dropship', ['admin', 'office', 'orderdesk'], async ({ db, res, params, body }) => {
  try {
    const r = await db.query('select set_order_drop_ship($1,$2) as who',
      [Number(params.id), body.to || null]);
    ok(res, { drop_ship: r.rows[0].who });
  } catch (e) {
    if (/DROP_SHIP_OFF/.test(e.message)) {
      return fail(res, 400, e.message.replace('DROP_SHIP_OFF: ', ''));
    }
    throw e;
  }
});

// Correcting a product's code. The code is the product's name in every
// conversation that matters — the purchase order, the packing list, the
// supplier's email — so a typo in one is a product nobody can find.
on('POST', '/api/products/:sku/code', ADMIN, async ({ db, res, params, body }) => {
  if (!body.code) return fail(res, 400, 'What code?');
  try {
    const r = await db.query('select rename_sku($1,$2) as sku', [params.sku, body.code]);
    ok(res, { was: params.sku, sku: r.rows[0].sku });
  } catch (e) {
    if (/DUPLICATE_SKU/.test(e.message)) {
      return fail(res, 400, e.message.replace('DUPLICATE_SKU: ', ''));
    }
    throw e;
  }
});

// The price list, whole: every product against every price code that carries
// one. Read as a sheet rather than a product at a time, because that is how
// the office reads it — down a column, comparing what a Regional pays against
// what a Sub-Reseller does, on one screen instead of opening sixty cards.
on('GET', '/api/pricelist', ADMIN, async ({ db, res }) => {
  const [codes, rows] = await queryAll(db, [
    [`select code from price_codes
       where base_code is null and active order by sort, code`],
    [`select p.sku, p.name, p.brand, p.unit_type, p.retail_price, p.active,
             coalesce(jsonb_object_agg(pp.code, pp.price)
                      filter (where pp.code is not null), '{}'::jsonb) as prices
        from products p
        left join product_prices pp on pp.sku = p.sku
       group by p.sku
       order by coalesce(p.brand, ''), p.name`],
  ]);
  ok(res, { codes: codes.rows.map((c) => c.code), products: rows.rows });
});

on('GET', '/api/wholesale/catalog', ORDERDESK, async ({ db, res }) => {
  const r = await db.query('select * from b2b_catalog order by name');
  ok(res, r.rows);
});

// Same order a reseller could place for themselves, placed for them —
// place_order already lets an admin name any reseller, and already raises
// the invoice the moment the order lands. Nothing here is new; only that
// somebody besides the reseller can reach it.
on('POST', '/api/resellers/:id/orders', ORDERDESK, async ({ db, res, params, body }) => {
  const lines = (body.lines || []).map((l) => ({
    sku: l.sku, qty: Number(l.qty), code: l.code || null }));
  if (!lines.length) return fail(res, 400, 'The order is empty.');
  const r = await db.query('select place_order($1,$2,$3,$4) as id',
    ['b2b', JSON.stringify(lines), Number(params.id),
     body.branch_id ? Number(body.branch_id) : null]);
  const orderId = Number(r.rows[0].id);
  // Set straight away rather than left for a second trip: the order form is
  // offered the moment this returns, and a form printed without the name on
  // it is a form somebody writes on by hand.
  if (body.drop_ship) {
    await db.query('select set_order_drop_ship($1,$2)', [orderId, body.drop_ship])
      .catch(() => {});   // an account not set up for it simply does not get one
  }
  // The numbers were stamped a moment ago by the trigger, and the screen puts
  // them straight onto the documents it offers next, so they come back with
  // the order rather than costing a second fetch.
  const [numbers, invoice] = await queryAll(db, [
    ['select co_no, pl_no from orders where id = $1', [orderId]],
    ['select * from invoices where order_id = $1', [orderId]],
  ]);
  ok(res, {
    orderId,
    co_no: numbers.rows[0]?.co_no || null,
    pl_no: numbers.rows[0]?.pl_no || null,
    drop_ship: body.drop_ship || null,
    invoice: invoice.rows[0] || null,
  });
});

// Same ledger as /payment above, plus the one thing that route never gave a
// bank-transferred payment: an OR. Same 'OR-YYYYMMDD-NNNNN' series the till
// hands a walk-in customer at the counter.
on('POST', '/api/resellers/:id/receipt', ADMIN, async ({ db, res, params, body }) => {
  const amount = Number(body.amount);
  if (!(amount > 0)) return fail(res, 400, 'A payment must be more than zero.');
  const r = await db.query('select issue_reseller_receipt($1,$2,$3,$4,$5,$6) as result',
    [Number(params.id), amount, body.paid_on || today(),
     body.method || null, body.details || null, body.reference_no || null]);
  ok(res, r.rows[0].result);
});

// Confirming a partial payment. The money is recorded and applied, oldest
// invoice first; no number is put on it. Several transfers can be confirmed in
// one request, because a reseller settling in instalments sends them together
// as often as not, and each carries its own bank and reference.
on('POST', '/api/resellers/:id/confirm', ORDERDESK, async ({ db, res, params, body }) => {
  const rows = (Array.isArray(body.payments) ? body.payments : [body])
    .map((r) => ({ ...r, amount: Number(r.amount) }))
    .filter((r) => r.amount > 0);
  if (!rows.length) return fail(res, 400, 'A payment must be more than zero.');

  const done = [];
  for (const r of rows) {
    const out = await db.query('select confirm_reseller_payment($1,$2,$3,$4,$5,$6) as result',
      [Number(params.id), r.amount, r.paid_on || today(),
       r.method || null, r.details || 'MS Beau Ave Enterprises OPC',
       r.reference_no || null]);
    done.push({ ...out.rows[0].result, amount: r.amount });
  }
  const pending = await db.query('select receipt_pending($1) as p', [Number(params.id)]);
  ok(res, { confirmed: done, pending: pending.rows[0].p });
});

// What has been confirmed and not yet receipted, so the screen can say what an
// OR would cover before anybody asks for one.
on('GET', '/api/resellers/:id/pending-receipt', ORDERDESK, async ({ db, res, params }) => {
  const r = await db.query('select receipt_pending($1) as p', [Number(params.id)]);
  ok(res, r.rows[0].p);
});

// Issuing, as its own act: one number over everything waiting.
on('POST', '/api/resellers/:id/issue-or', ORDERDESK, async ({ db, res, params }) => {
  const r = await db.query('select issue_reseller_receipt_now($1) as result', [Number(params.id)]);
  ok(res, r.rows[0].result);
});

on('GET', '/api/resellers/:id/receipts', ORDERDESK, async ({ db, res, params }) => {
  const r = await db.query(
    `select id, receipt_no, amount, credited, paid_on, issued_by, at
       from reseller_receipts where reseller_id = $1 order by at desc limit 50`,
    [Number(params.id)]);
  ok(res, r.rows);
});

// What this account has paid before, newest first — the invoice carries a
// PAYMENT DETAILS block and it is filled from the ledger rather than from
// memory. A payment made through issue_reseller_receipt has an OR number to
// quote; one recorded before that existed has none, and says so by being blank
// rather than by inventing a reference.
// What this account has actually sent, bank by bank. Narrowed to one order
// when the caller says which — an invoice's PAYMENT DETAILS is the breakdown
// of how THAT invoice was paid, and money sent for a different bill printed
// underneath it is worse than a blank slot. Unnarrowed it is the account's
// last dozen, which is what the profile wants.
on('GET', '/api/resellers/:id/payments', ORDERDESK, async ({ db, res, params, query }) => {
  const order = Number(query.order_id) || 0;
  // Newest first for the account's recent activity; oldest first for one
  // invoice, because its five slots are read as the order the money came in,
  // the way they were written on the pad.
  const r = await db.query(
    `select p.id, p.amount, p.paid_on, p.method, p.payer_details, p.reference_no,
            i.order_id, p.invoice_id
       from payments p
       join invoices i on i.id = p.invoice_id
      where i.reseller_id = $1
        and ($2 = 0 or i.order_id = $2)
      order by p.paid_on ${order ? 'asc' : 'desc'}, p.id ${order ? 'asc' : 'desc'}
      limit ${order ? 50 : 12}`,
    [Number(params.id), order]);
  ok(res, r.rows);
});

on('GET', '/api/receipts/:receipt_no', ADMIN, async ({ db, res, params }) => {
  const r = await db.query(
    `select rr.*, r.name as reseller
       from reseller_receipts rr join resellers r on r.id = rr.reseller_id
      where rr.receipt_no = $1`,
    [params.receipt_no]);
  if (!r.rows[0]) return fail(res, 404, 'No such receipt.');
  ok(res, r.rows[0]);
});

// ---------------------------------------------------------------------------
// The till
// ---------------------------------------------------------------------------
on('GET', '/api/till/products', TILL, async ({ db, res, query }) => {
  const term = `%${query.q || ''}%`;
  // What is on the shelf of the shop that is selling — not the business total.
  // A till showing another branch's stock would take an order it cannot fill.
  const r = await db.query(
    `select c.sku, c.name, c.brand, c.category, c.retail_price,
            c.price_now, c.percent_off, c.promo_headline, ph.has_photo,
            coalesce((select sum(s.on_hand - s.committed)
                        from stock s join batches b on b.id = s.batch_id
                       where b.sku = c.sku and s.pool = 'shop'
                         and b.expiry > current_date
                         and branch_visible(s.branch_id, $2)), 0)::int
              as on_shelf
       from shop_catalog c
       join product_has_photo ph on ph.sku = c.sku
      where c.sku ilike $1 or c.name ilike $1 or coalesce(c.brand, '') ilike $1
      order by c.name limit 60`,
    [term, query.branch ? Number(query.branch) : null]);
  ok(res, r.rows);
});

on('POST', '/api/till/sell', TILL, async ({ db, res, body }) => {
  const lines = (body.lines || []).map((l) => ({ sku: l.sku, qty: Number(l.qty) }));
  if (!lines.length) return fail(res, 400, 'The basket is empty.');
  const r = await db.query('select sell($1,$2,$3,$4) as receipt',
    [JSON.stringify(lines), body.method, body.tendered == null ? null : Number(body.tendered),
     body.branch_id ? Number(body.branch_id) : null]);
  ok(res, r.rows[0].receipt);
});

on('GET', '/api/till/receipts', TILL, async ({ db, res }) => {
  const r = await db.query(
    'select receipt_no, total, method, at, cashier from sales order by at desc limit 50');
  ok(res, r.rows);
});

on('GET', '/api/till/receipts/:no', TILL, async ({ db, res, params }) => {
  const sale = await db.query('select * from sales where receipt_no = $1', [params.no]);
  if (!sale.rows.length) return fail(res, 404, 'No receipt with that number.');
  const lines = await db.query(
    `select l.sku, p.name, l.qty, l.unit_price, l.batch_id, b.batch_no,
            l.qty - coalesce((select sum(r.qty) from returns r
                               where r.order_id = l.order_id and r.sku = l.sku
                                 and r.batch_id = l.batch_id
                                 and r.status in ('pending','approved')), 0) as returnable
       from order_lines l
       join products p on p.sku = l.sku
       join batches b on b.id = l.batch_id
      where l.order_id = $1 order by l.id`, [sale.rows[0].order_id]);
  ok(res, { ...sale.rows[0], lines: lines.rows });
});

on('GET', '/api/till/shelf-batches/:sku', TILL, async ({ db, res, params }) => {
  const r = await db.query(
    `select b.id as batch_id, b.batch_no, b.expiry, (s.on_hand - s.committed)::int as free
       from batches b join stock s on s.batch_id = b.id
      where b.sku = $1 and s.pool = 'shop' and s.on_hand - s.committed > 0
      order by b.expiry`, [params.sku]);
  ok(res, r.rows);
});

on('POST', '/api/till/returns', TILL, async ({ db, res, body }) => {
  const r = await db.query('select raise_return($1,$2,$3,$4,$5) as id',
    [body.receipt_no, body.sku, Number(body.batchId), Number(body.qty), body.reason]);
  ok(res, { id: Number(r.rows[0].id) });
});

on('GET', '/api/till/returns', TILL, async ({ db, res }) => {
  const r = await db.query(
    `select r.*, p.name from returns r join products p on p.sku = r.sku
      order by (r.status = 'pending') desc, r.raised_at desc limit 100`);
  ok(res, r.rows);
});

on('POST', '/api/till/shrinkage', TILL, async ({ db, res, body, user }) => {
  await db.query('select log_shrinkage($1,$2,$3,$4,$5,$6)',
    [body.sku, Number(body.batchId), Number(body.qty), body.reason, user.username,
     body.branch_id ? Number(body.branch_id) : null]);
  ok(res, { done: true });
});

on('POST', '/api/till/close-day', TILL, async ({ db, res, body }) => {
  const r = await db.query('select close_day($1) as result', [Number(body.declared)]);
  ok(res, r.rows[0].result);
});

on('GET', '/api/till/close-day', TILL, async ({ db, res }) => {
  const r = await db.query('select * from my_cash_counts order by business_date desc limit 30');
  ok(res, r.rows);
});

// ---------------------------------------------------------------------------
// Returns queue (the owner decides)
// ---------------------------------------------------------------------------
on('GET', '/api/returns', OBSERVE, async ({ db, res }) => {
  const r = await db.query(
    `select r.*, p.name, b.batch_no
       from returns r
       join products p on p.sku = r.sku
       join batches b on b.id = r.batch_id
      order by (r.status = 'pending') desc, r.raised_at desc limit 100`);
  ok(res, r.rows);
});

on('POST', '/api/returns/:id/decide', ADMIN, async ({ db, res, params, body }) => {
  await db.query('select decide_return($1,$2,$3)',
    [Number(params.id), !!body.approve, body.outcome || 'restock']);
  ok(res, { done: true });
});

// ---------------------------------------------------------------------------
// Reorder points
// ---------------------------------------------------------------------------
on('GET', '/api/reorder', [...STOCK, 'observer'], async ({ db, res }) => {
  const r = await db.query(
    `select p.sku, p.name, p.abc_class,
            r.avg_daily, r.max_daily, r.avg_lead_days, r.max_lead_days,
            r.months_cover, r.safety_stock, r.reorder_at, r.reviewed_at,
            a.in_stock, a.short_by, a.suggested_order
       from products p
       left join reorder_points r on r.sku = p.sku
       left join reorder_alerts a on a.sku = p.sku
      where p.active order by p.name`);
  ok(res, r.rows);
});

on('POST', '/api/reorder/:sku', STOCK, async ({ db, res, params, body }) => {
  const r = await db.query(
    'select to_jsonb(set_reorder_point($1,$2,$3,$4,$5,$6)) as row',
    [params.sku, Number(body.avg_daily), Number(body.max_daily),
     Number(body.avg_lead), Number(body.max_lead), Number(body.months_cover) || 3]);
  ok(res, r.rows[0].row);
});

on('POST', '/api/reorder/:sku/recalc', STOCK, async ({ db, res, params }) => {
  const r = await db.query('select to_jsonb(recalc_demand($1)) as row', [params.sku]);
  ok(res, r.rows[0].row);
});

// ---------------------------------------------------------------------------
// Reports
// ---------------------------------------------------------------------------
on('GET', '/api/reports/sales', OBSERVE, async ({ db, res, query }) => {
  const from = query.from || '1970-01-01';
  const to = query.to || '2999-12-31';
  const [channel, product, daily] = await queryAll(db, [
    [`select channel, sum(orders)::int as orders, sum(revenue) as revenue
        from sales_by_channel where day between $1 and $2 group by channel`, [from, to]],
    [`select l.sku, p.name, sum(l.qty)::int as units, sum(l.qty * l.unit_price) as revenue
        from order_lines l
        join orders o on o.id = l.order_id
        join products p on p.sku = l.sku
       where o.status = 'fulfilled' and o.placed_at::date between $1 and $2
       group by l.sku, p.name order by revenue desc limit 50`, [from, to]],
    [`select day, channel, revenue from sales_by_channel
       where day between $1 and $2 order by day`, [from, to]],
  ]);
  ok(res, { byChannel: channel.rows, byProduct: product.rows, byDay: daily.rows });
});

on('GET', '/api/reports/valuation', OBSERVE, async ({ db, res }) => {
  const r = await db.query(
    `select sku, name, unit_cost, total_on_hand as units, value_at_cost
       from stock_summary order by value_at_cost desc`);
  ok(res, r.rows);
});

on('GET', '/api/reports/ageing', OBSERVE, async ({ db, res }) => {
  const r = await db.query('select * from ageing_stock order by days_left');
  ok(res, r.rows);
});

on('GET', '/api/reports/receivables', ADMIN, async ({ db, res }) => {
  const [ageing, concentration, credit] = await queryAll(db, [
    ['select * from ar_ageing order by total_owed desc'],
    ['select * from ar_concentration order by share desc'],
    // ar_ageing only lists a reseller by way of an open invoice, so an
    // account sitting purely in credit — nothing owed, nothing overdue — was
    // invisible to this report even though the shop is holding their money.
    ['select * from ar_credit_holders'],
  ]);
  ok(res, { ageing: ageing.rows, concentration: concentration.rows, credit: credit.rows });
});

on('GET', '/api/reports/journal', STOCK, async ({ db, res, query }) => {
  const r = await db.query(
    `select * from movement_journal
      where ($1 = '' or sku ilike $2 or name ilike $2 or reason ilike $2)
      order by at desc limit $3`,
    [query.q || '', `%${query.q || ''}%`, limit(query.limit)]);
  ok(res, r.rows);
});

// ---------------------------------------------------------------------------
// Sign-ins (owner only)
// ---------------------------------------------------------------------------
on('GET', '/api/users', ADMIN, async ({ db, res }) => {
  const r = await db.query(
    `select u.id, u.username, u.display_name, u.role, u.active, u.reseller_id,
            r.name as reseller, u.branch_id, b.name as branch
       from app_users u
       left join resellers r on r.id = u.reseller_id
       left join branches b on b.id = u.branch_id
      order by u.username`);
  ok(res, r.rows);
});

// Renaming a sign-in. Deliberately separate from the password: correcting
// somebody's name is not the same as letting them back in.
on('PUT', '/api/users/:id', ADMIN, async ({ db, res, params, body }) => {
  await db.query('select rename_login($1,$2,$3)',
    [Number(params.id), body.username || '', body.display_name || null]);
  ok(res, { saved: true });
});

// Ending every session a sign-in has open, from anywhere. This is how the
// tablet by the door gets signed out: there is no button on it, on purpose, so
// the owner does it from here.
// Moving somebody between roles. The database refuses to demote the last
// owner and refuses to move a portal sign-in in or out of the portal; both
// come back as a plain sentence rather than a server error, because both are
// things the owner is allowed to try and needs to be told about.
on('POST', '/api/users/:id/role', ADMIN, async ({ db, res, params, body }) => {
  const r = await db.query('select set_login_role($1,$2) as who',
    [Number(params.id), String(body.role || '')]);
  ok(res, { who: r.rows[0].who, role: body.role });
});

on('POST', '/api/users/:id/sign-out-everywhere', ADMIN, async ({ db, res, params }) => {
  const r = await db.query('select sign_out_everywhere($1) as who', [Number(params.id)]);
  ok(res, { signedOut: r.rows[0].who });
});

// Tying a sign-in to a shop. Null unties it, which is right for an owner and
// for anyone who genuinely covers both.
on('POST', '/api/users/:id/branch', ADMIN, async ({ db, res, params, body }) => {
  await db.query('select set_login_branch($1,$2)',
    [Number(params.id), body.branch_id ? Number(body.branch_id) : null]);
  ok(res, { done: true });
});

on('POST', '/api/users', ADMIN, async ({ db, res, body }) => {
  if (!body.username || !body.password) {
    return fail(res, 400, 'A username and password are both needed.');
  }
  if (String(body.password).length < 8) {
    return fail(res, 400, 'Use at least 8 characters for the password.');
  }
  const r = await db.query('select create_login($1,$2,$3,$4,$5) as id',
    [body.username, body.display_name || body.username, hashPassword(body.password),
     body.role, body.reseller_id == null ? null : Number(body.reseller_id)]);
  ok(res, { id: Number(r.rows[0].id) });
});

on('POST', '/api/users/:id/active', ADMIN, async ({ db, res, params, body }) => {
  await db.query('select set_login_active($1,$2)', [Number(params.id), !!body.active]);
  ok(res, { done: true });
});

// Switching off is the usual answer and keeps the row. This is for the
// accounts that should never have existed: duplicates, tests, typos.
on('DELETE', '/api/users/:id', ADMIN, async ({ db, res, params }) => {
  const r = await db.query('select remove_login($1) as username', [Number(params.id)]);
  ok(res, { removed: r.rows[0].username });
});

on('POST', '/api/users/:id/password', ADMIN, async ({ db, res, params, body }) => {
  if (String(body.password || '').length < 8) {
    return fail(res, 400, 'Use at least 8 characters for the password.');
  }
  await db.query('select set_login_password($1,$2)',
    [Number(params.id), hashPassword(body.password)]);
  ok(res, { done: true });
});

// ---------------------------------------------------------------------------
// The reseller's own portal
// ---------------------------------------------------------------------------
on('GET', '/api/portal/catalog', RESELLER, async ({ db, res }) => {
  const r = await db.query('select * from b2b_catalog order by name');
  ok(res, r.rows);
});

on('POST', '/api/portal/orders', RESELLER, async ({ db, res, body, user }) => {
  // Prices always come from the catalogue, never from the browser.
  const lines = (body.lines || []).map((l) => ({ sku: l.sku, qty: Number(l.qty) }));
  if (!lines.length) return fail(res, 400, 'Your order is empty.');
  const r = await db.query('select place_order($1,$2,$3,$4) as id',
    ['b2b', JSON.stringify(lines), user.resellerId,
     body.branch_id ? Number(body.branch_id) : null]);
  const orderId = Number(r.rows[0].id);
  // Set straight away rather than left for a second trip: the order form is
  // offered the moment this returns, and a form printed without the name on
  // it is a form somebody writes on by hand.
  if (body.drop_ship) {
    await db.query('select set_order_drop_ship($1,$2)', [orderId, body.drop_ship])
      .catch(() => {});   // an account not set up for it simply does not get one
  }
  // The numbers were stamped a moment ago by the trigger, and the screen puts
  // them straight onto the documents it offers next, so they come back with
  // the order rather than costing a second fetch.
  const [numbers, invoice] = await queryAll(db, [
    ['select co_no, pl_no from orders where id = $1', [orderId]],
    ['select * from invoices where order_id = $1', [orderId]],
  ]);
  ok(res, {
    orderId,
    co_no: numbers.rows[0]?.co_no || null,
    pl_no: numbers.rows[0]?.pl_no || null,
    drop_ship: body.drop_ship || null,
    invoice: invoice.rows[0] || null,
  });
});

// Correcting an invoice rather than cancelling the order and starting again.
//
// Prices, shipping and Others — the money. Quantities and which products are
// the order's, and stock is held against those; see revise_invoice for why
// this refuses to touch them.
on('POST', '/api/orders/:id/invoice', ['admin', 'office', 'orderdesk'], async ({ db, res, params, body }) => {
  const lines = (body.lines || [])
    .map((l) => ({ id: Number(l.id), price: Number(l.price) }))
    .filter((l) => l.id && Number.isFinite(l.price) && l.price >= 0);
  const money = (v) => (v == null || v === '' ? null : Number(v));
  const shipping = money(body.shipping);
  const others = money(body.others);
  if ([shipping, others].some((v) => v != null && (!Number.isFinite(v) || v < 0))) {
    return fail(res, 400, 'Shipping and Others have to be nothing or more.');
  }
  try {
    const r = await db.query('select revise_invoice($1,$2,$3,$4) as result',
      [Number(params.id), JSON.stringify(lines), shipping, others]);
    ok(res, r.rows[0].result);
  } catch (e) {
    // The one refusal worth saying plainly rather than as a server error.
    if (/REVISED_BELOW_PAID/.test(e.message)) {
      return fail(res, 400, e.message.replace('REVISED_BELOW_PAID: ', ''));
    }
    throw e;
  }
});

// What a line is called on the paper. Not what it is — the sku still says
// that — so this moves no stock and touches no money.
on('POST', '/api/orders/:id/descriptions', ['admin', 'office', 'orderdesk'], async ({ db, res, params, body }) => {
  const lines = (body.lines || [])
    .map((l) => ({ id: Number(l.id), description: String(l.description ?? '') }))
    .filter((l) => l.id);
  if (!lines.length) return fail(res, 400, 'Nothing to name.');
  try {
    const r = await db.query('select set_line_notes($1,$2) as result',
      [Number(params.id), JSON.stringify(lines)]);
    ok(res, r.rows[0].result);
  } catch (e) {
    if (/^ALREADY_GONE: /.test(e.message)) {
      return fail(res, 400, e.message.replace('ALREADY_GONE: ', ''));
    }
    throw e;
  }
});

// The customer order and packing list numbers, typed. Both at once: they are
// two columns of one row and lining a series back up means moving both.
on('POST', '/api/orders/:id/numbers', ['admin', 'office', 'orderdesk'], async ({ db, res, params, body }) => {
  const said = (v) => (v == null ? null : String(v));
  try {
    const r = await db.query('select set_order_no($1,$2,$3) as result',
      [Number(params.id), said(body.co_no), said(body.pl_no)]);
    ok(res, r.rows[0].result);
  } catch (e) {
    const plain = /^(NOT_WHOLESALE|NO_DOC_NO|DUPLICATE_DOC_NO): /;
    if (plain.test(e.message)) return fail(res, 400, e.message.replace(plain, ''));
    throw e;
  }
});

// The invoice number, typed rather than handed out. The counter reads the
// highest number in the month, so what is written here is what the next one
// carries on from.
on('POST', '/api/orders/:id/invoice-no', ['admin', 'office', 'orderdesk'], async ({ db, res, params, body }) => {
  try {
    const r = await db.query('select set_invoice_no($1,$2) as result',
      [Number(params.id), String(body.si_no ?? '')]);
    ok(res, r.rows[0].result);
  } catch (e) {
    const plain = /^(NO_DOC_NO|NO_INVOICE|DUPLICATE_DOC_NO): /;
    if (plain.test(e.message)) return fail(res, 400, e.message.replace(plain, ''));
    throw e;
  }
});

// What actually goes in the box. The packing list is the sheet the checker
// works from, so a short pick or a last-minute addition is corrected there and
// the stock, the order and the invoice all move with it. The body carries the
// whole picture — every product going out and how many — not a list of
// changes, because that is what the sheet itself says.
on('POST', '/api/orders/:id/lines', ['admin', 'office', 'orderdesk'], async ({ db, res, params, body }) => {
  const lines = (body.lines || [])
    .map((l) => ({ sku: String(l.sku || '').trim(), qty: Number(l.qty) }))
    .filter((l) => l.sku && Number.isFinite(l.qty) && l.qty >= 0);
  if (!lines.length) return fail(res, 400, 'The sheet has nothing on it.');
  try {
    const r = await db.query('select revise_order($1,$2) as result',
      [Number(params.id), JSON.stringify(lines)]);
    ok(res, r.rows[0].result);
  } catch (e) {
    // The refusals somebody typing on the sheet can act on, said plainly.
    const plain = /^(ALREADY_GONE|NOTHING_LEFT|NO_SUCH_PRODUCT|NOT_ENOUGH_STOCK|REVISED_BELOW_PAID): /;
    if (plain.test(e.message)) return fail(res, 400, e.message.replace(plain, ''));
    throw e;
  }
});

on('GET', '/api/portal/orders', RESELLER, async ({ db, res }) => {
  const r = await db.query(
    `select o.id, o.status, o.total, o.placed_at, o.delivered_at,
            o.co_no, o.pl_no, i.si_no,
            i.id as invoice_id, i.status as invoice_status, i.due_on,
            (i.amount - i.paid - i.discount) as balance,
            coalesce(jsonb_agg(jsonb_build_object('sku', l.sku, 'qty', l.qty,
                     'unit_price', l.unit_price) order by l.id)
                     filter (where l.id is not null), '[]'::jsonb) as lines
       from orders o
       left join invoices i on i.order_id = o.id
       left join order_lines l on l.order_id = o.id
      group by o.id, i.id
      order by o.placed_at desc limit 100`);
  ok(res, r.rows);
});

on('POST', '/api/portal/orders/:id/cancel', RESELLER, async ({ db, res, params }) => {
  await db.query('select cancel_order($1)', [Number(params.id)]);
  ok(res, { done: true });
});

on('GET', '/api/portal/account', RESELLER, async ({ db, res, user }) => {
  const account = await db.query('select * from resellers where id = $1', [user.resellerId]);
  if (!account.rows.length) return fail(res, 404, 'No account linked to this sign-in.');
  const invoices = await db.query(
    `select i.*, (i.amount - i.paid - i.discount) as balance,
            (i.status = 'open' and i.due_on < current_date) as overdue
       from invoices i order by i.issued_on desc limit 100`);

  const open = invoices.rows.filter((i) => i.status === 'open');
  const late = open.filter((i) => i.overdue);
  const owed = open.reduce((sum, i) => sum + Number(i.balance), 0);
  const toClear = late.reduce((sum, i) => sum + Number(i.balance), 0);
  const account0 = account.rows[0];

  ok(res, {
    account: account0,
    invoices: invoices.rows,
    owed,
    creditLimit: Number(account0.credit_limit),
    blocked: account0.blocked || late.length > 0,
    // Said plainly so it can be acted on without a phone call. The amount is
    // added by whoever shows this, so it is never stated twice.
    reason: late.length
      ? `${late.length} invoice${late.length > 1 ? 's are' : ' is'} past due.`
      : (account0.blocked
          ? `Ordering is on hold: ${account0.blocked_reason || 'please contact MS BEAU AVE'}.`
          : null),
    toClear,
  });
});

// ---------------------------------------------------------------------------
// The workspace — the team's feed and its task board
//
// One GET for the whole tab: the feed, the board and the list of people a task
// can be given to always render together, and three round trips to draw one
// screen is three chances for it to arrive half-built.
// ---------------------------------------------------------------------------
on('GET', '/api/workspace', [...STAFF, 'observer'], async ({ db, res }) => {
  const [feed, board, team] = await queryAll(db, [
    ['select * from team_feed limit 50', []],
    ['select * from task_board', []],
    [`select username, display_name, role from app_users
       where active and role in ('admin','warehouse','cashier')
       order by display_name`, []],
  ]);
  ok(res, { feed: feed.rows, tasks: board.rows, team: team.rows });
});

on('POST', '/api/workspace/posts', STAFF, async ({ db, res, body }) => {
  const r = await db.query('select post_update($1) as id', [body.body || '']);
  ok(res, { id: Number(r.rows[0].id) });
});

on('POST', '/api/workspace/tasks', STAFF, async ({ db, res, body }) => {
  const r = await db.query('select add_task($1,$2,$3,$4,$5) as id', [
    body.title || '', body.assignee || null, body.due || null,
    body.priority || 'normal', body.detail || null,
  ]);
  ok(res, { id: Number(r.rows[0].id) });
});

on('POST', '/api/workspace/tasks/:id/status', STAFF, async ({ db, res, params, body }) => {
  await db.query('select move_task($1,$2)', [Number(params.id), body.status]);
  ok(res, { moved: true });
});

// ---------------------------------------------------------------------------
// Product photographs
//
// The GET is deliberately open: this is the picture a customer sees in the
// shop, and the storefront fetches it without signing in. It is also the one
// endpoint that answers with something other than JSON, so it writes the
// response itself rather than staging it — there is no transaction to wait for
// on the way out, because it reads through the pool rather than as a user.
// ---------------------------------------------------------------------------
on('GET', '/api/products/:sku/photo', ANYONE, async ({ req, res, params }) => {
  const r = await pool.query(
    'select mime, bytes, updated_at from product_photos where sku = $1', [params.sku]);
  const photo = r.rows[0];
  if (!photo) {
    res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
    return res.end(JSON.stringify({ error: 'That product has no photograph.' }));
  }

  // The tag changes whenever the photo does, so a browser that already has it
  // asks once and is told nothing has changed, rather than pulling it again on
  // every catalogue render.
  const tag = `"${params.sku}-${new Date(photo.updated_at).getTime()}"`;
  if (req.headers['if-none-match'] === tag) {
    res.writeHead(304, { ETag: tag });
    return res.end();
  }

  res.writeHead(200, {
    'Content-Type': photo.mime,
    'Content-Length': photo.bytes.length,
    'Cache-Control': 'public, max-age=60, stale-while-revalidate=86400',
    ETag: tag,
  });
  res.end(photo.bytes);
});

on('POST', '/api/products/:sku/photo', ADMIN, async ({ db, res, params, body }) => {
  if (!body.dataUrl) {
    await db.query('select clear_product_photo($1)', [params.sku]);
    return ok(res, { photo: null });
  }

  const match = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/.exec(body.dataUrl);
  if (!match) return fail(res, 400, 'That file is not a JPEG, PNG or WebP image.');

  const bytes = Buffer.from(match[2], 'base64');
  if (bytes.length > 900_000) {
    return fail(res, 400, 'That picture is too large. Try one under 900 KB.');
  }

  await db.query('select set_product_photo($1,$2,$3)', [params.sku, match[1], bytes]);
  ok(res, { photo: 'saved' });
});

// ---------------------------------------------------------------------------
// The shop window
//
// Open to anyone, and narrow on purpose: these two go through functions that
// name exactly what a shopper may see, rather than reading the tables through
// a policy hole that would be easy to widen by accident later.
// ---------------------------------------------------------------------------
on('GET', '/api/shop/catalog', ANYONE, async ({ res, query }) => {
  const r = await pool.query('select * from public_catalog($1)', [query.q || '']);
  ok(res, r.rows);
});

on('GET', '/api/shop/categories', ANYONE, async ({ res }) => {
  const r = await pool.query('select * from public_categories()');
  ok(res, r.rows);
});

// ---------------------------------------------------------------------------
// Shoppers — joining, signing in, and who am I
//
// Open routes, because a customer holds no role in this system. Everything
// they can reach goes through a function that answers about one account.
// ---------------------------------------------------------------------------
on('POST', '/api/shop/join', ANYONE, async ({ req, res, body }) => {
  const name = String(body.name || '').trim();
  const phone = String(body.phone || '').trim();
  const password = String(body.password || '');
  if (name.length < 2) return fail(res, 400, 'Please give us a name to call you by.');
  if (password.length < 6) return fail(res, 400, 'Pick a password of at least six characters.');

  const r = await pool.query('select join_shop($1,$2,$3) as id',
    [name, phone, hashPassword(password)]);
  const id = r.rows[0].id;
  res.setHeader('Set-Cookie', shopperCookie({ id, name }, req));

  // Read the account back rather than assuming a new one: joining also claims
  // a counter-registered account, and telling somebody they have no points
  // when the shop has been adding them all along is its own small insult.
  const mine = await pool.query('select * from shop_customer($1)', [id]);
  const me = mine.rows[0];
  ok(res, { customer: { name: me.name, points: me.points, tier: me.tier } });
});

on('POST', '/api/shop/login', ANYONE, async ({ req, res, body }) => {
  const r = await pool.query('select * from shop_login($1)', [String(body.phone || '')]);
  const found = r.rows[0];
  // The same answer either way: which numbers are registered is not something
  // a stranger should be able to work out by trying them.
  if (!found || !checkPassword(String(body.password || ''), found.password_hash)) {
    return fail(res, 401, 'That number and password do not match.');
  }
  res.setHeader('Set-Cookie', shopperCookie(found, req));
  ok(res, { customer: { name: found.name, points: found.points, tier: found.tier } });
});

on('POST', '/api/shop/logout', ANYONE, async ({ res }) => {
  res.setHeader('Set-Cookie', clearedShopper);
  ok(res, { done: true });
});

on('GET', '/api/shop/me', ANYONE, async ({ req, res }) => {
  const session = readShopper(req);
  if (!session) return ok(res, { customer: null });

  const r = await pool.query('select * from shop_customer($1)', [session.cid]);
  const customer = r.rows[0];
  if (!customer) {
    // Switched off since the cookie was issued.
    res.setHeader('Set-Cookie', clearedShopper);
    return ok(res, { customer: null });
  }

  // Releasing lapsed holds before counting, so the page never shows someone a
  // reservation the shelf has already taken back.
  await pool.query('select expire_pickups()');
  const counts = await pool.query(
    `select count(*) filter (where status = 'reserved')  as to_collect,
            count(*) filter (where status = 'collected') as collected,
            count(*) filter (where status = 'cancelled') as cancelled
       from my_pickups($1)`, [session.cid]);
  const c = counts.rows[0];

  ok(res, {
    customer: {
      name: customer.name, phone: customer.phone, points: customer.points,
      tier: customer.tier, pointsToNext: customer.points_to_next, joinedAt: customer.joined_at,
    },
    purchases: {
      toCollect: Number(c.to_collect),
      collected: Number(c.collected),
      cancelled: Number(c.cancelled),
    },
    vouchers: 0,
  });
});

// ---------------------------------------------------------------------------
// The basket, and what becomes of it
//
// A shopper holds no database role, so every one of these goes through a
// function that takes the customer id from the signed cookie rather than from
// anything the browser sent in a body.
// ---------------------------------------------------------------------------
const shopper = (req, res) => {
  const session = readShopper(req);
  if (!session) {
    fail(res, 401, 'Please sign in first.');
    return null;
  }
  return session;
};

on('POST', '/api/shop/reserve', ANYONE, async ({ req, res, body }) => {
  const session = shopper(req, res);
  if (!session) return;

  const lines = (body.lines || [])
    .map((l) => ({ sku: String(l.sku), qty: Math.floor(Number(l.qty)) }))
    .filter((l) => l.sku && l.qty > 0);
  if (!lines.length) return fail(res, 400, 'Your basket is empty.');

  const r = await pool.query('select * from reserve_for_pickup($1,$2)',
    [session.cid, JSON.stringify(lines)]);
  ok(res, r.rows[0]);
});

on('GET', '/api/shop/purchases', ANYONE, async ({ req, res }) => {
  const session = shopper(req, res);
  if (!session) return;
  await pool.query('select expire_pickups()');
  const r = await pool.query('select * from my_pickups($1)', [session.cid]);
  ok(res, r.rows);
});

on('POST', '/api/shop/purchases/:id/cancel', ANYONE, async ({ req, res, params }) => {
  const session = shopper(req, res);
  if (!session) return;
  await pool.query('select cancel_pickup($1,$2)', [Number(params.id), session.cid]);
  ok(res, { cancelled: true });
});

// ---------------------------------------------------------------------------
// The counter's side of a reservation
// ---------------------------------------------------------------------------
on('GET', '/api/pickups', [...TILL, 'observer'], async ({ db, res }) => {
  await db.query('select expire_pickups()');
  const r = await db.query('select * from pickups_waiting');
  ok(res, r.rows);
});

on('POST', '/api/pickups/:code/collect', TILL, async ({ db, res, params, body }) => {
  const r = await db.query('select collect_pickup($1,$2) as receipt',
    [params.code, body.method || 'cash']);
  ok(res, r.rows[0].receipt);
});

on('POST', '/api/pickups/:id/cancel', TILL, async ({ db, res, params }) => {
  await db.query('select cancel_pickup($1)', [Number(params.id)]);
  ok(res, { cancelled: true });
});

// ---------------------------------------------------------------------------
// Promotions
// ---------------------------------------------------------------------------
on('GET', '/api/promos', [...STAFF, 'observer'], async ({ db, res }) => {
  const [live, all, candidates] = await queryAll(db, [
    ['select * from live_promos order by percent_off desc', []],
    [`select p.*, pr.name as product, pr.retail_price, pr.srp,
             (current_date between p.starts_on and p.ends_on and not p.ended_early) as running
        from promos p join products pr on pr.sku = p.sku
       order by p.created_at desc limit 60`, []],
    ['select * from promo_candidates limit 30', []],
  ]);
  ok(res, { live: live.rows, all: all.rows, candidates: candidates.rows });
});

on('POST', '/api/promos', ADMIN, async ({ db, res, body }) => {
  const r = await db.query('select start_promo($1,$2,$3,$4,$5,$6,$7) as id', [
    body.sku, body.headline || '', Number(body.percent), body.ends,
    body.kind || 'flash', body.starts || null, body.batch_id || null,
  ]);
  ok(res, { id: Number(r.rows[0].id) });
});

on('POST', '/api/promos/:id/end', ADMIN, async ({ db, res, params }) => {
  await db.query('select end_promo($1)', [Number(params.id)]);
  ok(res, { ended: true });
});

on('GET', '/api/shop/promos', ANYONE, async ({ res }) => {
  const r = await pool.query('select * from public_promos()');
  ok(res, r.rows);
});

// ---------------------------------------------------------------------------
// The team
//
// Everybody on staff sees who they work with. Only the owner sees phone
// numbers, private notes and hours worked — so the columns are picked here
// rather than sent and hidden in the browser, where hiding is decoration.
// ---------------------------------------------------------------------------
// has_pin says only whether one exists, never what it is — the clock screen
// needs it to show who cannot punch in yet.
// Today's arrival and departure are on this list because the board at the door
// is where somebody checks them. They say nothing a person standing at that
// door does not already know about their own morning, and the days before
// today stay where they were — in the back office, with the owner.
const TEAM_PUBLIC = ['id', 'name', 'position', 'here', 'on_shift', 'since',
                     'has_photo', 'signs_in_as', 'has_pin', 'branch_id', 'branch',
                     'today_in', 'today_out', 'photo_at', 'has_finger'];

on('GET', '/api/team', [...CLOCKDEV, 'observer'], async ({ db, res, user }) => {
  const rows = (await db.query('select * from team')).rows;
  if (user.role !== 'admin') {
    return ok(res, {
      team: rows.map((r) => Object.fromEntries(
        TEAM_PUBLIC.map((k) => [k, r[k]]))),
      shifts: [],
      logins: [],
    });
  }

  const [shifts, logins, fingers] = await queryAll(db, [
    ['select * from shifts_recent limit 60', []],
    [`select u.id, u.username, u.display_name, u.role
        from app_users u
       where u.active and u.role <> 'reseller'
         and not exists (select 1 from employees e where e.user_id = u.id)
       order by u.display_name`, []],
    // How many fingers each person has enrolled. Counts only — a template is
    // not something to put on a page.
    ['select employee_id, fingers from team_fingers where fingers > 0', []],
  ]);
  const enrolled = new Map(fingers.rows.map((f) => [String(f.employee_id), f.fingers]));
  ok(res, {
    team: rows.map((r) => ({ ...r, fingers: enrolled.get(String(r.id)) || 0 })),
    shifts: shifts.rows,
    logins: logins.rows,
  });
});

on('POST', '/api/team', ADMIN, async ({ db, res, body }) => {
  const r = await db.query('select add_employee($1,$2,$3,$4,$5,$6,$7) as id', [
    body.name || '', body.position || '', body.phone || null,
    body.user_id || null, body.started || null, body.note || null,
    body.branch_id ? Number(body.branch_id) : null,
  ]);
  ok(res, { id: Number(r.rows[0].id) });
});

on('PUT', '/api/team/:id', ADMIN, async ({ db, res, params, body }) => {
  await db.query('select update_employee($1,$2,$3,$4,$5,$6)', [
    Number(params.id), body.name || '', body.position || '',
    body.phone || null, body.user_id || null, body.note || null,
  ]);
  ok(res, { saved: true });
});

// Deleting a person is for rows that should never have existed. Anybody who
// actually worked a shift is refused and pointed at "They have left", which
// dates the departure and keeps the hours.
on('DELETE', '/api/team/:id', ADMIN, async ({ db, res, params }) => {
  const r = await db.query('select remove_employee($1) as name', [Number(params.id)]);
  ok(res, { removed: r.rows[0].name });
});

on('POST', '/api/team/:id/left', ADMIN, async ({ db, res, params, body }) => {
  await db.query('select end_employment($1,$2)', [Number(params.id), body.on || null]);
  ok(res, { done: true });
});

on('POST', '/api/team/:id/clock', TILL, async ({ db, res, params, body }) => {
  const id = Number(params.id);
  if (body.direction === 'out') {
    const r = await db.query('select clock_out($1) as worked', [id]);
    return ok(res, { worked: r.rows[0].worked });
  }
  await db.query('select clock_in($1)', [id]);
  ok(res, { on: true });
});

// ---------------------------------------------------------------------------
// Branches
//
// Everybody on staff can see the list, because the clock by the door has to
// know which shop it is standing in. Only the owner changes it.
// ---------------------------------------------------------------------------
// A sign-in tied to one shop is only shown that shop. Every branch picker in
// the app hides itself when there is nothing to choose between, so this is
// what makes a tied cashier's screens stop asking a question they have no
// business answering.
on('GET', '/api/branches', [...CLOCKDEV, 'observer'], async ({ db, res, user }) => {
  const r = await db.query(
    'select * from branch_list where $1::bigint is null or id = $1',
    [user.branchId ?? null]);
  ok(res, r.rows);
});

on('POST', '/api/branches', ADMIN, async ({ db, res, body }) => {
  const r = await db.query('select add_branch($1,$2,$3,$4) as id',
    [body.name || '', body.address || null, body.phone || null, body.opens || null]);
  ok(res, { id: Number(r.rows[0].id) });
});

on('PUT', '/api/branches/:id', ADMIN, async ({ db, res, params, body }) => {
  await db.query('select update_branch($1,$2,$3,$4,$5)',
    [Number(params.id), body.name || '', body.address || null,
     body.phone || null, body.opens || null]);
  ok(res, { saved: true });
});

on('POST', '/api/branches/:id/close', ADMIN, async ({ db, res, params, body }) => {
  await db.query(body.reopen ? 'select reopen_branch($1)' : 'select close_branch($1)',
    [Number(params.id)]);
  ok(res, { done: true });
});

on('POST', '/api/team/:id/branch', ADMIN, async ({ db, res, params, body }) => {
  await db.query('select move_employee($1,$2)',
    [Number(params.id), Number(body.branch_id)]);
  ok(res, { moved: true });
});

// ---------------------------------------------------------------------------
// The time clock
//
// One shared device by the door, signed in once. Each person picks themselves
// and types their PIN — the PIN exists so that one person cannot clock in
// another, which is the only thing an attendance record really has to defend
// against. The device's own sign-in is what says the tap happened at the shop.
// ---------------------------------------------------------------------------
// Clocking on by PIN alone.
//
// Forty-eight faces at one shop is a long scroll to find yourself, and the
// person doing it is usually late. The PIN is enough on its own: its keyed
// fingerprint is uniquely indexed, so at most one person can hold it, and the
// hash is still checked afterwards — the fingerprint says who, the hash says
// whether.
//
// A branch may be given, and the door screens give one. It narrows the search
// to the people who work at that door, so a PIN that belongs to somebody at the
// other shop simply is not found here.
on('POST', '/api/clock/by-pin', CLOCKDEV, async ({ db, res, body }) => {
  const pin = String(body.pin || '');
  if (!/^\d{4,8}$/.test(pin)) return fail(res, 400, 'A PIN is 4 to 8 digits.');

  const found = await db.query(
    `select id, name, pin_hash from employees
      where pin_fp = $1 and ended_on is null
        and ($2::bigint is null or branch_id = $2)`,
    [pinFingerprint(pin), body.branch_id ? Number(body.branch_id) : null]);
  const person = found.rows[0];

  // The same answer whether the PIN belongs to nobody or the hash disagrees: a
  // screen by the door should not be a way to find out which PINs exist.
  if (!person || !checkPassword(pin, person.pin_hash)) {
    return fail(res, 400, 'That PIN does not match anybody here.');
  }

  return finishOrAskForFinger(db, res, person, body);
});

// How long somebody has, after typing their PIN, to get their finger onto the
// glass. Long enough to find the reader on a strange door; short enough that a
// window left open by somebody who wandered off is gone before the next person
// reaches the screen.
const TICKET_SECONDS = 90;

// The PIN has named somebody. Whether that is the end of it depends on what
// they have to confirm with and on what the door in front of them has.
//
// A person with a fingerprint on file is sent to the glass: the PIN said who
// and what they meant, and the finger says they are actually standing there.
// A person with no fingerprint has always had the PIN as the whole of their
// credential, and sending them to a scanner they can never satisfy would just
// lock them out of their own shift.
//
// `scanner` is the door's report on its own hardware, and it is the only thing
// that knows. A screen whose agent is not answering says false and clocks on
// the PIN alone — otherwise a broken reader at six in the morning is a queue
// at the door with nothing anybody can do about it.
async function finishOrAskForFinger(db, res, person, body) {
  const hasFinger = body.scanner === true && (await db.query(
    'select employee_has_finger($1) as yes', [person.id])).rows[0].yes;

  if (!hasFinger) {
    // 'pin' rather than nothing: this route is only reachable by typing one,
    // so it is the place that can say so without being told by the browser.
    const done = await db.query("select clock_toggle($1,'pin') as result", [person.id]);
    return ok(res, done.rows[0].result);
  }

  // No ticket goes back. Under the old order the screen held one and spent it
  // with a PIN; now the finger is what spends the window, and it is matched at
  // the door against templates the door already holds. A bearer token handed
  // to a screen that has nothing to do with it is a credential loose in the
  // world for no reason. The row still carries a hash because the column is
  // unique and that is what makes two windows two rows.
  const r = await db.query('select * from open_clock_confirmation($1,$2,$3,$4)',
    [person.id, body.branch_id ? Number(body.branch_id) : null,
     tokenHash(inviteToken()), TICKET_SECONDS]);
  ok(res, { action: 'confirm', name: r.rows[0].name, seconds: TICKET_SECONDS });
}

on('POST', '/api/clock', CLOCKDEV, async ({ db, res, body }) => {
  const id = Number(body.employeeId);
  const pin = String(body.pin || '');
  if (!id || !pin) return fail(res, 400, 'Pick your name and type your PIN.');

  const r = await db.query(
    'select pin_hash, name from employees where id = $1 and ended_on is null', [id]);
  const person = r.rows[0];

  if (!person) return fail(res, 400, 'That person is not on the team.');
  if (!person.pin_hash) {
    return fail(res, 400, `${person.name} has no PIN yet. Ask the owner to set one.`);
  }
  // The same answer whether the PIN is wrong or the person cannot clock on:
  // a shared device should not be a way to learn things about colleagues.
  if (!checkPassword(pin, person.pin_hash)) return fail(res, 400, 'That PIN does not match.');

  return finishOrAskForFinger(db, res, { id, name: person.name }, body);
});

on('POST', '/api/team/:id/pin', ADMIN, async ({ db, res, params, body }) => {
  const pin = String(body.pin || '');
  if (!/^\d{4,8}$/.test(pin)) return fail(res, 400, 'A PIN is 4 to 8 digits.');
  await db.query('select set_employee_pin($1,$2,$3)',
    [Number(params.id), hashPassword(pin), pinFingerprint(pin)]);
  ok(res, { saved: true });
});

// Taking a PIN back. For somebody who does not work a shift, and for somebody
// who has gone — a leaver with a PIN can still open the clock.
on('DELETE', '/api/team/:id/pin', ADMIN, async ({ db, res, params }) => {
  await db.query('select clear_employee_pin($1)', [Number(params.id)]);
  ok(res, { done: true });
});

// ---------------------------------------------------------------------------
// Fingerprints
//
// The scanner is a camera for fingers. Everything that makes a fingerprint
// useful — turning an image into a template, matching one against a shop's
// worth of people — happens in the manufacturer's library on the machine at
// the door. These endpoints are the master copy and the gate: enrolling is
// owner-only, a door is handed its own shop's templates and nobody else's,
// and a door that claims to have recognised somebody has that claim checked.
// ---------------------------------------------------------------------------
on('POST', '/api/team/:id/finger', ADMIN, async ({ db, res, params, body }) => {
  const finger = Number(body.finger ?? 1);
  if (!Number.isInteger(finger) || finger < 0 || finger > 9) {
    return fail(res, 400, 'A finger is numbered 0 to 9.');
  }
  let template;
  try {
    template = Buffer.from(String(body.template || ''), 'base64');
  } catch { template = null; }
  if (!template || template.length === 0) {
    return fail(res, 400, 'That scan produced nothing. Try again.');
  }
  await db.query('select enrol_finger($1,$2,$3,$4)',
    [Number(params.id), finger, template,
     body.quality == null ? null : Number(body.quality)]);
  ok(res, { enrolled: true });
});

on('DELETE', '/api/team/:id/fingers', ADMIN, async ({ db, res, params }) => {
  const r = await db.query('select clear_fingers($1) as gone', [Number(params.id)]);
  ok(res, { removed: Number(r.rows[0].gone) });
});

// What one door may hold. The branch is the whole security story here, so it
// is required rather than defaulted: a door with no shop gets nothing.
on('GET', '/api/clock/fingers', CLOCKDEV, async ({ db, res, query, user }) => {
  const branch = query.shop ? Number(query.shop) : user.branchId;
  if (!branch) return fail(res, 400, 'A door belongs to one shop. Say which.');
  const r = await db.query(
    'select employee_id, name, finger, template from fingers_for_branch($1)', [branch]);
  ok(res, {
    branch,
    people: r.rows.map((f) => ({
      id: Number(f.employee_id), name: f.name, finger: f.finger,
      template: f.template.toString('base64'),
    })),
  });
});

// The door has matched somebody — and now that means something.
//
// Under the old order this opened a window and asked for a PIN. It is the
// other way round: the PIN opened the window, and this is the finger closing
// it. So a match is no longer the beginning of anything. It either lands on a
// window somebody deliberately opened seconds ago, or it records nothing.
//
// That is what makes a hand resting on the glass harmless, and what makes a
// second press harmless too — the window is single-use, so pressing again to
// check the first press worked cannot clock anybody back out.
//
// The program at the door is not changed by any of this and nobody copies a
// file onto a shop PC. It sends who it recognised, exactly as it always has,
// and hands the answer to the screen.
on('POST', '/api/clock/by-finger', CLOCKDEV, async ({ db, res, body, user }) => {
  const id = Number(body.employeeId || body.employee_id);
  const branch = body.branch_id ? Number(body.branch_id) : user.branchId;
  if (!id) return fail(res, 400, 'Which person did the door recognise?');

  try {
    await db.query('select confirm_clock_by_finger($1,$2)', [id, branch || null]);
  } catch (e) {
    if (e.code === 'P0009') return fail(res, 400, e.message);
    throw e;
  }

  // Still 'finger': two things were used either way, and the finger is the one
  // that says the person was really standing there. Every scanner clocking
  // carries both, so a second name for it would divide nothing.
  const done = await db.query("select clock_toggle($1,'finger') as result", [id]);
  ok(res, done.rows[0].result);
});

// Issue PINs in bulk, for handing out on paper.
//
// The PIN is returned here and nowhere else, ever: only its hash is kept, so
// there is no screen anywhere that can be made to show it again. A lost slip
// means a new PIN, which is the correct trade — a system that can tell you
// somebody's PIN can tell anybody.
//
// One shop at a time, when asked.
//
// Reissuing is destructive — it takes away a PIN somebody has already learned
// — and "everybody" is far too blunt when one shop has never been given theirs
// and the other has spent the week clocking on with them. Without a shop here,
// the only way to hand Beauty Obsession Avenue their PINs was to reset MS Beau
// Ave's at the same moment, in the middle of a working evening.
//
// Hashing is deliberately slow, so this works in bites and the browser asks
// again until nobody is left. Sixty at once would sit on the request long
// enough to be killed halfway, with half the team holding PINs nobody printed.
on('POST', '/api/team/pins', ADMIN, async ({ db, res, body }) => {
  const everyone = body.everyone === true;
  // Where the last bite got to. Issuing to everybody cannot lean on "who has
  // no PIN yet" to know what is left — after the first bite they all have one
  // — so the walk is by id, and the caller hands back where it stopped. Without
  // this, reissuing for sixty people silently did the same twenty every time.
  const after = Number(body.after) || 0;
  const branch = body.branch === undefined || body.branch === null || body.branch === ''
    ? null : Number(body.branch);
  if (branch !== null && !Number.isInteger(branch)) {
    return fail(res, 400, 'That is not a shop.');
  }
  // The shop goes into every count below as well as the walk. A "12 to go"
  // that counted the other shop would keep the browser asking for bites that
  // come back empty, and stop only when it ran out of people it may not touch.
  const only = branch === null ? '' : 'and branch_id = $2';
  const args = branch === null ? [after] : [after, branch];
  const people = await db.query(
    `select id, name, position from employees
      where ended_on is null and id > $1 ${everyone ? '' : 'and pin_hash is null'} ${only}
      order by id limit 20`, args);

  // Across sixty people, two random four-digit PINs colliding is the expected
  // outcome rather than bad luck. The taken ones are read first and drawn
  // around, because the whole request is one transaction: letting the unique
  // index reject a PIN would abort everything issued before it.
  const taken = new Set((await db.query(
    `select pin_fp from employees where pin_fp is not null and ended_on is null`))
    .rows.map((r) => r.pin_fp));

  const issued = [];
  for (const person of people.rows) {
    let pin = null;
    for (let attempt = 0; attempt < 500 && pin === null; attempt++) {
      const candidate = freshPin();
      if (!taken.has(pinFingerprint(candidate))) pin = candidate;
    }
    if (pin === null) {
      return fail(res, 400,
        'Almost every four-digit PIN is in use. Retire some old ones first.');
    }
    taken.add(pinFingerprint(pin));
    await db.query('select set_employee_pin($1,$2,$3)',
      [person.id, hashPassword(pin), pinFingerprint(pin)]);
    issued.push({ ...person, pin });
  }

  const mark = people.rows.length ? Number(people.rows[people.rows.length - 1].id) : after;
  const rest = branch === null ? [mark] : [mark, branch];
  const left = await db.query(
    `select count(*)::int as n from employees
      where ended_on is null and id > $1 ${everyone ? '' : 'and pin_hash is null'} ${only}`,
    rest);
  ok(res, { issued, remaining: left.rows[0].n, after: mark });
});

// A keyed fingerprint: the same PIN always gives the same value, so the unique
// index can tell two people apart, while the value itself gives nothing away
// to anybody without the key.
const pinFingerprint = (pin) =>
  crypto.createHmac('sha256', process.env.SESSION_SECRET || 'dev').update(pin).digest('hex');

// Four digits, minus the ones people would guess first. A PIN only has to stop
// a colleague, but 1234 does not even do that.
const WEAK = new Set(['0000', '1111', '2222', '3333', '4444', '5555', '6666',
  '7777', '8888', '9999', '1234', '4321', '2580', '0123', '1212', '6969']);
function freshPin() {
  for (;;) {
    const pin = String(crypto.randomInt(0, 10000)).padStart(4, '0');
    if (!WEAK.has(pin)) return pin;
  }
}

// Hours for whatever period gets paid, rather than only this week.
on('GET', '/api/team/hours', OBSERVE, async ({ db, res, query }) => {
  const to = query.to || today();
  const from = query.from || to;
  const branch = query.branch ? Number(query.branch) : null;
  const r = await db.query('select * from hours_worked($1,$2,$3)', [from, to, branch]);
  ok(res, { from, to, people: r.rows });
});

// The shift log, over a range rather than the most recent handful.
on('GET', '/api/team/shifts', OBSERVE, async ({ db, res, query }) => {
  const to = query.to || today();
  const from = query.from || to;
  const r = await db.query(
    `select s.id, s.employee_id, e.name, e.position, s.business_date,
            s.started_at, s.ended_at, s.started_by, s.ended_by,
            coalesce(s.ended_at, now()) - s.started_at as worked
       from shifts s join employees e on e.id = s.employee_id
      where s.business_date between $1 and $2
        and ($3::bigint is null or s.employee_id = $3)
      order by s.started_at desc
      limit 2000`,
    [from, to, query.employee ? Number(query.employee) : null]);
  ok(res, r.rows);
});

on('POST', '/api/team/bulk', ADMIN, async ({ db, res, body }) => {
  if (!Array.isArray(body.people) || !body.people.length) {
    return fail(res, 400, 'That list is empty.');
  }
  const r = await db.query('select add_employees($1::jsonb,$2) as result',
    [JSON.stringify(body.people), body.branch_id ? Number(body.branch_id) : null]);
  ok(res, r.rows[0].result);
});

on('POST', '/api/team/:id/photo', ADMIN, async ({ db, res, params, body }) => {
  const match = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/.exec(body.dataUrl || '');
  if (!match) return fail(res, 400, 'That file is not a JPEG, PNG or WebP image.');
  const uploaded = Buffer.from(match[2], 'base64');
  if (uploaded.length > 900_000) return fail(res, 400, 'That picture is too large.');

  // A face on the door board renders at under 70px, and the biggest it ever
  // appears anywhere else is a 158px matching grid — nothing needs the phone
  // photo's original resolution, only a likeness. Shrinking it once here is
  // what makes "cache this for a year" (below, and in employee_photos) cheap
  // to keep serving, rather than a year spent caching a file nobody asked to
  // be that large.
  const bytes = await sharp(uploaded)
    .rotate()
    .resize({ width: 320, height: 320, fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: 82 })
    .toBuffer();

  await db.query('select set_employee_photo($1,$2,$3)', [Number(params.id), 'image/jpeg', bytes]);
  ok(res, { saved: true });
});

// Written straight to the socket rather than staged like every other reply:
// it is bytes, not JSON, and being a read there is no commit worth waiting for.
//
// The door screen may fetch these, which is why this is CLOCKDEV rather than
// STAFF. The clock is a wall of faces — that is how somebody finds themselves
// on it without reading — and a timekeeper sign-in that can list the team by
// name and position but not show a single face rendered every card as a broken
// image. The photograph gives away nothing the list beside it does not: both
// say who works at this door, to a screen standing at that door.
on('GET', '/api/team/:id/photo', [...CLOCKDEV, 'observer'], async ({ db, res, params, query }) => {
  const r = await db.query(
    'select mime, bytes, updated_at from employee_photos where employee_id = $1',
    [Number(params.id)]);
  const photo = r.rows[0];
  if (!photo) return fail(res, 404, 'No photograph.');
  // A minute's cache is right for an address that never changes: the picture
  // could be replaced at any moment and the board should notice. It is wrong
  // for a screen at a door, which redraws every twenty seconds and so pulls
  // every face on the wall down again every minute, all day — enough requests
  // through one agent that some of them lose, and a face that loses is a blank
  // circle with nothing to say why.
  //
  // So a caller that names the version gets a year. The address only changes
  // when the photograph does, which is the condition that makes it safe.
  const versioned = query.v != null && query.v !== '';
  res.writeHead(200, {
    'Content-Type': photo.mime,
    'Content-Length': photo.bytes.length,
    'Cache-Control': versioned
      ? 'private, max-age=31536000, immutable'
      : 'private, max-age=60',
    ETag: `"e${params.id}-${new Date(photo.updated_at).getTime()}"`,
  });
  res.end(photo.bytes);
});

// ---------------------------------------------------------------------------
// Customers
//
// The counter needs to find somebody and register somebody; the owner needs
// the whole picture. Both go through functions that take an id, never a phone
// number the browser chose to send.
// ---------------------------------------------------------------------------
on('GET', '/api/customers', OBSERVE, async ({ db, res, query }) => {
  const rows = (await db.query('select * from crm_customers')).rows;
  const term = String(query.q || '').trim().toLowerCase();
  const list = term
    ? rows.filter((c) => c.name.toLowerCase().includes(term)
        || (c.phone || '').replace(/\D/g, '').includes(term.replace(/\D/g, '')))
    : rows;

  ok(res, {
    customers: list,
    counts: {
      all: rows.length,
      active: rows.filter((c) => c.standing === 'active').length,
      slipping: rows.filter((c) => c.standing === 'slipping').length,
      lapsed: rows.filter((c) => c.standing === 'lapsed').length,
      unclaimed: rows.filter((c) => !c.claimed).length,
    },
    // What the shop is holding in points, if anyone ever spends them.
    points: rows.reduce((sum, c) => sum + Number(c.points), 0),
  });
});

// Registered before /api/customers/:id, because the router takes the first
// pattern that matches and "find" would otherwise be read as an id.
on('GET', '/api/customers/find', TILL, async ({ db, res, query }) => {
  if (!String(query.q || '').trim()) return ok(res, []);
  const r = await db.query('select * from find_customer($1)', [query.q]);
  ok(res, r.rows);
});

on('GET', '/api/customers/:id', OBSERVE, async ({ db, res, params }) => {
  const r = await db.query('select * from customer_detail($1)', [Number(params.id)]);
  if (!r.rows.length) return fail(res, 404, 'That customer is not on the list.');
  ok(res, r.rows[0]);
});

on('POST', '/api/customers', TILL, async ({ db, res, body }) => {
  const r = await db.query('select register_customer($1,$2,$3) as id',
    [body.name || '', body.phone || '', body.note || null]);
  ok(res, { id: Number(r.rows[0].id) });
});

on('PUT', '/api/customers/:id/note', TILL, async ({ db, res, params, body }) => {
  await db.query('select set_customer_note($1,$2)', [Number(params.id), body.note || null]);
  ok(res, { saved: true });
});

// Where the customer is reached: their Facebook name and the links to find
// them across Facebook and the marketplaces. Any may be left blank.
on('PUT', '/api/customers/:id/socials', TILL, async ({ db, res, params, body }) => {
  await db.query('select set_customer_socials($1,$2,$3,$4,$5,$6)',
    [Number(params.id), body.fb_name || null, body.fb_link || null,
     body.shopee_link || null, body.tiktok_link || null, body.lazada_link || null]);
  ok(res, { saved: true });
});

on('POST', '/api/sales/:receipt/customer', TILL, async ({ db, res, params, body }) => {
  const r = await db.query('select attribute_sale($1,$2) as points',
    [params.receipt, Number(body.customer_id)]);
  ok(res, { points: Number(r.rows[0].points) });
});

// ---------------------------------------------------------------------------
// The money
//
// Owner only, all of it. A cashier sees their own drawer at close of day and
// nothing beyond it.
// ---------------------------------------------------------------------------
on('GET', '/api/finance', ADMIN, async ({ db, res, query }) => {
  const to = query.to || today();
  const from = query.from
    || daysAgo(29);

  const [summary, expenses] = await queryAll(db, [
    ['select finance_summary($1,$2) as figures', [from, to]],
    [`select * from expenses_recent where spent_on between $1 and $2`, [from, to]],
  ]);
  // `entries`, not `expenses`: the summary already has an `expenses` object of
  // totals, and spreading a list over it would silently blank the figures.
  ok(res, { from, to, ...summary.rows[0].figures, entries: expenses.rows });
});

on('POST', '/api/expenses', ADMIN, async ({ db, res, body }) => {
  const r = await db.query('select record_expense($1,$2,$3,$4,$5) as id', [
    body.kind || 'other', body.description || '', Number(body.amount),
    body.on || null, body.method || 'cash',
  ]);
  ok(res, { id: Number(r.rows[0].id) });
});

on('POST', '/api/expenses/:id/void', ADMIN, async ({ db, res, params, body }) => {
  await db.query('select void_expense($1,$2)', [Number(params.id), body.reason || '']);
  ok(res, { voided: true });
});

// ---------------------------------------------------------------------------
// Human resources
//
// Two audiences, and the difference between them is the whole point.
//
// HR is Adona, and she is the only one. Her half takes ids freely — she is
// meant to be looking at other people, that is the job — and every function
// behind it asks require_role('admin') in the database.
//
// The other half belongs to whoever is signed in. Not one of those routes
// takes a person as a parameter, because a parameter is a number in a request
// and a request is written by the browser. The database works out who is
// asking from the session and answers about them. The only id any of them
// accepts is a leave request being withdrawn, and the function checks it
// belongs to the asker before touching it.
// ---------------------------------------------------------------------------
on('GET', '/api/hr', OBSERVE, async ({ db, res, user }) => {
  const [people, leave, pipeline, notices, reviews] = await queryAll(db, [
    ['select * from hr_people'],
    ['select * from hr_leave limit 200'],
    ['select * from applications order by updated_at desc limit 200'],
    ['select * from announcements where not withdrawn order by posted_at desc limit 50'],
    [`select a.*, e.name from appraisals a join employees e on e.id = a.employee_id
       order by a.created_at desc limit 100`],
  ]);
  const here = people.rows.filter((p) => p.here);
  const payroll = here.reduce((sum, p) => sum + Number(p.salary || 0), 0);
  // The salary column and the payroll total, gone before the reply is built.
  // The database refuses an observer employment_details outright, so this is
  // belt to that braces — hr_people is a view and runs with its owner's
  // rights, which is exactly the shape of thing that leaks a column nobody
  // meant to send.
  const watching = user.role === 'observer';
  const strip = (p) => { const { salary, pay_period, ...rest } = p; return rest; };
  ok(res, {
    people: watching ? people.rows.map(strip) : people.rows,
    leave: leave.rows,
    pipeline: pipeline.rows,
    announcements: notices.rows,
    appraisals: reviews.rows,
    figures: {
      headcount: here.length,
      unpaid: watching ? null : here.filter((p) => p.salary == null).length,
      pending_leave: leave.rows.filter((l) => l.status === 'pending').length,
      hiring: pipeline.rows.filter(
        (a) => !['hired', 'rejected'].includes(a.pipeline_stage)).length,
      payroll_monthly: watching ? null : payroll,
    },
  });
});

// One person, everything about them, including the days they worked.
//
// HR's question about somebody is never one thing: it is their record and
// their hours and their leave and their reviews, and answering it used to mean
// four screens and a lot of scrolling. This is the row they clicked, opened.
//
// Somebody who may look and not touch is on it — they see everybody's record
// already on the HR screen — with pay taken out of the reply the same way and
// for the same reason: hr_people is a view running with its owner's rights,
// which is exactly the shape of thing that hands over a column nobody meant to
// send.
on('GET', '/api/hr/people/:id', OBSERVE, async ({ db, res, params, query, user }) => {
  const id = Number(params.id);
  if (!id) return fail(res, 400, 'Which person?');
  const from = query.from || daysAgo(29);
  const to = query.to || today();

  const [who, leave, reviews, shifts] = await queryAll(db, [
    ['select * from hr_people where id = $1', [id]],
    ['select * from hr_leave where employee_id = $1 order by start_date desc limit 50', [id]],
    [`select * from appraisals where employee_id = $1
       order by created_at desc limit 20`, [id]],
    [`select business_date, started_at, ended_at, started_by, ended_by,
             started_how, ended_how, note,
             coalesce(ended_at, now()) - started_at as worked
        from shifts
       where employee_id = $1 and business_date between $2 and $3
       order by started_at desc`, [id, from, to]],
  ]);

  const person = who.rows[0];
  if (!person) return fail(res, 404, 'No such person.');

  const days = new Set(shifts.rows.map((s) => String(s.business_date))).size;
  const seconds = shifts.rows.reduce((n, s) => {
    const end = s.ended_at ? new Date(s.ended_at) : new Date();
    return n + (end - new Date(s.started_at)) / 1000;
  }, 0);

  const watching = user.role === 'observer';
  const { salary, pay_period, ...rest } = person;
  ok(res, {
    person: watching ? rest : person,
    leave: leave.rows,
    appraisals: reviews.rows,
    shifts: shifts.rows,
    from,
    to,
    figures: {
      days_present: days,
      hours: Math.round((seconds / 3600) * 100) / 100,
      still_on: shifts.rows.some((s) => !s.ended_at),
    },
  });
});

on('POST', '/api/hr/people/:id/employment', ADMIN, async ({ db, res, params, body }) => {
  await db.query('select set_employment($1,$2,$3,$4,$5)', [
    Number(params.id), body.department || null,
    body.salary === '' || body.salary == null ? null : Number(body.salary),
    body.pay_period || 'monthly',
    body.leave_entitlement == null ? 5 : Number(body.leave_entitlement),
  ]);
  ok(res, { saved: true });
});

on('POST', '/api/hr/leave/:id', ADMIN, async ({ db, res, params, body }) => {
  await db.query('select decide_leave($1,$2)', [Number(params.id), body.status || '']);
  ok(res, { decided: true });
});

on('POST', '/api/hr/pipeline', ADMIN, async ({ db, res, body }) => {
  const r = await db.query('select add_application($1,$2,$3,$4,$5,$6) as id', [
    body.candidate_name || '', body.target_role || '',
    body.branch_id ? Number(body.branch_id) : null,
    body.phone || null, body.email || null, body.notes || null,
  ]);
  ok(res, { id: Number(r.rows[0].id) });
});

on('POST', '/api/hr/pipeline/:id', ADMIN, async ({ db, res, params, body }) => {
  await db.query('select move_application($1,$2,$3)',
    [Number(params.id), body.pipeline_stage || '', body.notes || null]);
  ok(res, { moved: true });
});

on('POST', '/api/hr/appraisals', ADMIN, async ({ db, res, body }) => {
  const r = await db.query('select add_appraisal($1,$2,$3,$4,$5) as id', [
    Number(body.employee_id), body.period || '', Number(body.rating),
    body.strengths || null, body.improvements || null,
  ]);
  ok(res, { id: Number(r.rows[0].id) });
});

on('POST', '/api/hr/announcements', ADMIN, async ({ db, res, body }) => {
  const r = await db.query('select post_announcement($1,$2) as id',
    [body.title || '', body.body || '']);
  ok(res, { id: Number(r.rows[0].id) });
});

on('DELETE', '/api/hr/announcements/:id', ADMIN, async ({ db, res, params }) => {
  await db.query('select withdraw_announcement($1)', [Number(params.id)]);
  ok(res, { withdrawn: true });
});

// ---------------------------------------------------------------------------
// The portal — one person, about themselves
// ---------------------------------------------------------------------------
// Reading is on the longer list; writing is not. A view-only manager works here
// too — same door, same leave allowance, same reviews — and their own record is
// not the company they may not change. Asking for leave still is.
on('GET', '/api/my', OWN_RECORD, async ({ db, res }) => {
  const [profile, leave, reviews, hours, notices] = await queryAll(db, [
    ['select * from my_profile()'],
    ['select * from my_leave()'],
    ['select * from my_appraisals()'],
    ['select * from my_hours()'],
    ['select * from noticeboard()'],
  ]);
  ok(res, {
    profile: profile.rows[0] ?? null,
    leave: leave.rows,
    appraisals: reviews.rows,
    hours: hours.rows,
    announcements: notices.rows,
  });
});

on('POST', '/api/my/leave', PERSON, async ({ db, res, body }) => {
  const r = await db.query('select request_leave($1,$2,$3,$4) as id', [
    body.leave_type || '', body.start_date || null, body.end_date || null,
    body.reason || null,
  ]);
  ok(res, { id: Number(r.rows[0].id) });
});

on('DELETE', '/api/my/leave/:id', PERSON, async ({ db, res, params }) => {
  await db.query('select withdraw_leave($1)', [Number(params.id)]);
  ok(res, { withdrawn: true });
});

// Their own face, and no route to anybody else's. The id is not in the path:
// the database is asked who is signed in and the photograph is looked up from
// that, so there is no number to change.
on('GET', '/api/my/photo', OWN_RECORD, async ({ db, res }) => {
  // Through a function, not a select. An employee sign-in has no policy on
  // employee_photos — that is the design, not an oversight — so reading the
  // table directly here returned nothing at all, and the workspace drew a
  // broken image on a record that correctly said it had a photograph.
  const r = await db.query('select * from my_photo()');
  const photo = r.rows[0];
  if (!photo) return fail(res, 404, 'No photograph.');
  res.writeHead(200, {
    'Content-Type': photo.mime,
    'Content-Length': photo.bytes.length,
    'Cache-Control': 'private, max-age=60',
  });
  res.end(photo.bytes);
});

// Changing your own password.
//
// Everybody was handed a password on a printed sheet. Until now the only way to
// replace it was to ask an owner, which means telling an owner the new one.
//
// The current password is required, and that is the point of the route rather
// than a formality: a phone left face-up on a counter is a signed-in session,
// and without this anybody passing could lock its owner out of their own
// record. It is checked against the stored hash rather than anything the
// browser sent, in the same transaction as the write.
//
// There is no id anywhere in this, in the path or the body. The database is
// asked who is signed in and changes that row, so there is nothing to alter
// into somebody else's account.
on('POST', '/api/my/password', OWN_ACCOUNT, async ({ db, res, body }) => {
  const current = String(body.current ?? '');
  const next = String(body.password ?? '');
  if (!current) return fail(res, 400, 'Type the password you use now.');
  if (next.length < 8) return fail(res, 400, 'Use at least 8 characters for the new password.');
  if (next === current) return fail(res, 400, 'That is the password you already have.');

  const stored = (await db.query('select my_password_hash() as hash')).rows[0]?.hash;
  if (!checkPassword(current, stored)) {
    return fail(res, 403, 'That is not the password you use now.');
  }
  await db.query('select change_my_password($1)', [hashPassword(next)]);
  // Deliberately no new cookie and no signing out. The session is signed over
  // who somebody is, not what their password is, so the phone in their hand
  // stays signed in — which is what somebody standing in a stockroom changing
  // their password on their break expects.
  ok(res, { changed: true });
});

on('GET', '/api/noticeboard', NOTICEBOARD, async ({ db, res }) => {
  ok(res, { announcements: (await db.query('select * from noticeboard()')).rows });
});

// ---------------------------------------------------------------------------
// Attendance
//
// The door's question is "who is here now". HR's is "who came in on Tuesday,
// and who did not come at all" — and the second is answered by the people
// missing from the shift table, so the reply always carries everybody on the
// team, present or not. A day with nobody's name on it would be a day HR
// cannot check.
// ---------------------------------------------------------------------------
on('GET', '/api/hr/attendance', OBSERVE, async ({ db, res, query }) => {
  const on_ = query.on || today();
  const branch = query.branch ? Number(query.branch) : null;
  const [sheet, detail, shops] = await queryAll(db, [
    ['select * from attendance_on($1,$2)', [on_, branch]],
    ['select * from attendance_detail($1,$2)', [on_, branch]],
    ['select id, name from branches where active order by name', []],
  ]);
  const rows = sheet.rows;
  const came = rows.filter((r) => r.first_in);
  ok(res, {
    on: on_,
    branch,
    branches: shops.rows,
    people: rows,
    stretches: detail.rows,
    figures: {
      onbooks: rows.length,
      present: came.length,
      absent: rows.length - came.length,
      still_on: rows.filter((r) => r.still_on).length,
    },
  });
});

// The fortnight before a payday: days present, stretches, hours. Absence is
// carried here too, because a week with nothing in it is the thing being
// looked for.
on('GET', '/api/hr/attendance/summary', OBSERVE, async ({ db, res, query }) => {
  const to = query.to || today();
  const from = query.from || daysAgo(13);
  const branch = query.branch ? Number(query.branch) : null;
  const r = await db.query('select * from attendance_summary($1,$2,$3)', [from, to, branch]);
  ok(res, { from, to, branch, people: r.rows });
});

// ---------------------------------------------------------------------------
// Resellers signing themselves up
//
// Three steps, and the middle one is a person here saying yes. Applying is
// open, because a shop that finds us on a Sunday needs somewhere to leave
// their details. Being approved is not, because wholesale prices are the whole
// reason a reseller account exists and open registration would hand our cost
// structure to anybody who filled in a form.
//
// The first and last steps take no sign-in, so they run on the pool rather
// than through asUser — the same way signing in does. Every rule they need
// lives inside the functions they call, which is the only place it can live
// when the caller is a stranger.
// ---------------------------------------------------------------------------

// The token goes to the shop; only its hash is ever written down. A backup of
// the invites table, or a glance at a database, must not be enough to take
// over an account that has not been claimed yet.
const inviteToken = () => crypto.randomBytes(24).toString('base64url');
const tokenHash = (t) => crypto.createHash('sha256').update(String(t)).digest('hex');

on('POST', '/api/reseller/apply', ANYONE, async ({ res, body }) => {
  try {
    await pool.query('select apply_as_reseller($1,$2,$3,$4,$5,$6) as id', [
      body.business_name || '', body.contact_name || '', body.phone || null,
      body.email || null, body.address || null, body.note || null,
    ]);
  } catch (e) {
    // A validation message is worth showing; anything else is not. A form on
    // the open internet should never explain the shape of the database behind
    // it.
    return fail(res, 400, /^[A-Z][^:]*\.$/.test(e.message)
      ? e.message : 'That could not be sent. Please check the details and try again.');
  }
  // The same answer whether this is new or a repeat of last Tuesday. Telling
  // somebody they have already applied tells a stranger who our resellers are.
  ok(res, { received: true });
});

on('GET', '/api/reseller/applications', ADMIN, async ({ db, res }) => {
  const rows = (await db.query('select * from reseller_signups')).rows;
  ok(res, {
    applications: rows,
    waiting: rows.filter((r) => r.status === 'pending').length,
    unclaimed: rows.filter((r) => r.status === 'approved' && !r.claimed_at).length,
  });
});

on('POST', '/api/reseller/applications/:id/approve', ADMIN,
  async ({ db, res, params, body }) => {
    const token = inviteToken();
    const r = await db.query('select approve_reseller_application($1,$2,$3,$4,$5,$6) as id', [
      Number(params.id), tokenHash(token),
      body.tier == null ? 1 : Number(body.tier),
      body.credit_limit == null ? 0 : Number(body.credit_limit),
      body.terms_days == null ? 0 : Number(body.terms_days),
      body.days_valid == null ? 14 : Number(body.days_valid),
    ]);
    // Handed back exactly once, here. It is not stored anywhere it could be
    // read again, so whoever approves has to pass it on now.
    ok(res, { reseller_id: Number(r.rows[0].id), link: `/join/?t=${token}` });
  });

on('POST', '/api/reseller/applications/:id/decline', ADMIN, async ({ db, res, params, body }) => {
  await db.query('select decline_reseller_application($1,$2)',
    [Number(params.id), body.why || null]);
  ok(res, { declined: true });
});

on('POST', '/api/resellers/:id/invite', ADMIN, async ({ db, res, params, body }) => {
  const token = inviteToken();
  await db.query('select reissue_reseller_invite($1,$2,$3)', [
    Number(params.id), tokenHash(token),
    body.days_valid == null ? 14 : Number(body.days_valid),
  ]);
  ok(res, { link: `/join/?t=${token}` });
});

// What the join page asks before showing a form, so somebody following a dead
// link is told so rather than filling one in for nothing.
on('GET', '/api/reseller/invite', ANYONE, async ({ res, query }) => {
  const r = await pool.query('select * from reseller_invite_for($1)',
    [tokenHash(query.t || '')]);
  const found = r.rows[0];
  if (!found) return fail(res, 404, 'That link is not valid any more.');
  ok(res, { business: found.business, expires_at: found.expires_at });
});

on('POST', '/api/reseller/invite/claim', ANYONE, async ({ res, body }) => {
  if (String(body.password || '').length < 8) {
    return fail(res, 400, 'Use at least eight characters for the password.');
  }
  try {
    await pool.query('select claim_reseller_invite($1,$2,$3) as id', [
      tokenHash(body.t || ''), body.username || '', hashPassword(body.password),
    ]);
  } catch (e) {
    return fail(res, 400, /^[A-Z][^:]*[.!]$/.test(e.message)
      ? e.message : 'That could not be completed. Ask us for a new link.');
  }
  ok(res, { done: true });
});

// ===========================================================================
// Books — the accounting foundation (a separate /books app on the same deploy)
//
// The company's own book, so every route is the owner's alone. Phase 1: the
// chart of accounts, double-entry journal postings, and the trial balance and
// statements that fall out of them.
// ===========================================================================
on('GET', '/api/books/accounts', ADMIN, async ({ db, res }) => {
  const r = await db.query(
    'select code, title, type, normal_side, active, is_cash from coa_accounts order by type, code, title');
  ok(res, r.rows);
});

on('POST', '/api/books/accounts', ADMIN, async ({ db, res, body }) => {
  try {
    const r = await db.query('select save_account($1,$2,$3,$4) as code',
      [body.code || null, body.title || '', body.type || '', body.normal_side || 'debit']);
    ok(res, { code: r.rows[0].code });
  } catch (e) { throw e; }
});

// The journal: what has been posted, newest first, each with its lines.
on('GET', '/api/books/journal', ADMIN, async ({ db, res }) => {
  const r = await db.query(
    `select e.id, e.entry_no, e.entry_date, e.memo, e.posted_by,
            coalesce(jsonb_agg(jsonb_build_object(
              'account', l.account, 'title', a.title,
              'debit', l.debit, 'credit', l.credit, 'memo', l.memo) order by l.id), '[]') as lines,
            coalesce(sum(l.debit),0) as total
       from journal_entries e
       join journal_lines l on l.entry_id = e.id
       join coa_accounts a on a.code = l.account
      group by e.id
      order by e.entry_date desc, e.id desc
      limit 200`);
  ok(res, r.rows);
});

// Posting one entry. The lines must balance; the database enforces it and the
// one refusal worth reading is passed back plainly.
on('POST', '/api/books/journal', ADMIN, async ({ db, res, body }) => {
  const lines = (body.lines || [])
    .map((l) => ({
      account: String(l.account || ''),
      debit: Number(l.debit) || 0,
      credit: Number(l.credit) || 0,
      memo: l.memo || null,
    }))
    .filter((l) => l.account && (l.debit > 0 || l.credit > 0));
  if (lines.length < 2) return fail(res, 400, 'A posting is at least two lines.');
  try {
    const r = await db.query('select post_journal($1,$2,$3::jsonb) as id',
      [body.entry_date || today(), body.memo || '', JSON.stringify(lines)]);
    ok(res, { id: Number(r.rows[0].id) });
  } catch (e) {
    if (/BOOKS_DONT_BALANCE/.test(e.message)) {
      return fail(res, 400, e.message.replace('BOOKS_DONT_BALANCE: ', ''));
    }
    throw e;
  }
});

on('GET', '/api/books/trial-balance', ADMIN, async ({ db, res }) => {
  const r = await db.query(
    `select code, title, type, normal_side, debits, credits, balance
       from trial_balance where debits <> 0 or credits <> 0
      order by type, code`);
  const totals = r.rows.reduce((t, a) => ({
    debits: t.debits + Number(a.debits), credits: t.credits + Number(a.credits),
  }), { debits: 0, credits: 0 });
  ok(res, { rows: r.rows, totals });
});

// One account's ledger, oldest first with a running balance.
on('GET', '/api/books/ledger/:code', ADMIN, async ({ db, res, params }) => {
  const r = await db.query(
    `select entry_no, entry_date, memo, debit, credit, running
       from account_ledger where account = $1 order by entry_date, entry_id limit 500`,
    [params.code]);
  ok(res, r.rows);
});

// The two statements, straight off the trial balance grouped by account type.
// Income statement: revenue less expense. Balance sheet: assets against
// liabilities and equity, with the period's profit carried into equity.
on('GET', '/api/books/statements', ADMIN, async ({ db, res }) => {
  const r = await db.query('select type, normal_side, title, code, balance from trial_balance');
  const by = (t) => r.rows.filter((a) => a.type === t && Number(a.balance) !== 0);
  const sum = (rows) => rows.reduce((s, a) => s + Number(a.balance), 0);
  const revenue = sum(by('Revenue')) - sum(by('Contra Revenue'));
  const expense = sum(by('Expense')) + sum(by('Expenses')) - sum(by('Contra Expense'));
  const assets = sum(by('Asset')) - sum(by('Contra Asset'));
  const liabilities = sum(by('Liability'));
  const equity = sum(by('Equity')) + sum(by('Common'));
  const profit = revenue - expense;
  ok(res, {
    income: {
      revenue: by('Revenue'), expense: by('Expense').concat(by('Expenses')),
      total_revenue: revenue, total_expense: expense, profit,
    },
    balance: {
      assets: by('Asset'), liabilities: by('Liability'), equity: by('Equity').concat(by('Common')),
      total_assets: assets, total_liabilities: liabilities,
      total_equity: equity + profit, profit,
    },
  });
});

// ===========================================================================
// Books — Phase 2: payables & expenses
//
// Suppliers, the bills they raise (a payable), payments against those bills,
// and expenses paid on the spot. Each of the three acts posts a balanced
// journal entry through the same functions the database keeps to itself, so
// the trial balance and statements pick them up with nothing else to do.
// The owner's alone, like the rest of the books.
// ===========================================================================
on('GET', '/api/books/vendors', ADMIN, async ({ db, res }) => {
  const r = await db.query(
    'select id, name, notes, active from book_vendors where active order by name');
  ok(res, r.rows);
});

on('POST', '/api/books/vendors', ADMIN, async ({ db, res, body }) => {
  try {
    const r = await db.query('select save_vendor($1,$2,$3) as id',
      [body.id || null, body.name || '', body.notes || null]);
    ok(res, { id: Number(r.rows[0].id) });
  } catch (e) {
    if (/needs a name|no such supplier|already/i.test(e.message)) {
      return fail(res, 400, e.message.replace(/^.*:\s*/, ''));
    }
    throw e;
  }
});

// Every bill with what is owed on it, newest first; the open ones lead.
on('GET', '/api/books/bills', ADMIN, async ({ db, res }) => {
  const r = await db.query(
    `select id, bill_no, vendor_id, vendor, reference, bill_date, due_date, memo,
            amount, paid, balance, status
       from bill_status
      order by (status = 'paid'), due_date nulls last, bill_date desc, id desc
      limit 300`);
  ok(res, r.rows);
});

on('POST', '/api/books/bills', ADMIN, async ({ db, res, body }) => {
  const lines = (body.lines || [])
    .map((l) => ({ account: String(l.account || ''), amount: Number(l.amount) || 0, memo: l.memo || null }))
    .filter((l) => l.account && l.amount > 0);
  if (!lines.length) return fail(res, 400, 'A bill needs at least one line.');
  try {
    const r = await db.query('select record_bill($1,$2,$3,$4,$5,$6::jsonb) as id',
      [body.vendor_id || null, body.bill_date || today(), body.due_date || null,
       body.reference || null, body.memo || null, JSON.stringify(lines)]);
    ok(res, { id: Number(r.rows[0].id) });
  } catch (e) {
    if (/BOOKS_DONT_BALANCE/.test(e.message)) return fail(res, 400, e.message.replace('BOOKS_DONT_BALANCE: ', ''));
    if (/supplier|at least one line|for nothing|Accounts Payable|not in the chart/i.test(e.message)) {
      return fail(res, 400, e.message.replace(/^.*:\s*/, ''));
    }
    throw e;
  }
});

on('POST', '/api/books/bills/:id/pay', ADMIN, async ({ db, res, params, body }) => {
  try {
    const r = await db.query('select pay_bill($1,$2,$3,$4,$5,$6,$7) as id',
      [params.id, body.pay_date || today(), body.paid_from || '', Number(body.amount) || 0, body.memo || null,
       body.method || 'cash', body.reference || null]);
    ok(res, { id: Number(r.rows[0].id) });
  } catch (e) {
    if (/BOOKS_DONT_BALANCE/.test(e.message)) return fail(res, 400, e.message.replace('BOOKS_DONT_BALANCE: ', ''));
    if (/no such bill|more than nothing|still owed|cash account/i.test(e.message)) {
      return fail(res, 400, e.message.replace(/^.*:\s*/, ''));
    }
    throw e;
  }
});

// What is owed, gathered up: a total, a total that is overdue as of today, and
// the same per supplier — the head of the Payables screen.
on('GET', '/api/books/payables', ADMIN, async ({ db, res }) => {
  const r = await db.query(
    `select vendor, balance,
            (due_date is not null and due_date < current_date) as overdue
       from bill_status where status <> 'paid'`);
  let open = 0, overdue = 0;
  const byVendor = {};
  for (const b of r.rows) {
    const bal = Number(b.balance);
    open += bal;
    if (b.overdue) overdue += bal;
    const v = (byVendor[b.vendor] ||= { vendor: b.vendor, open: 0, overdue: 0 });
    v.open += bal; if (b.overdue) v.overdue += bal;
  }
  ok(res, {
    total_open: open, total_overdue: overdue,
    vendors: Object.values(byVendor).sort((a, b) => b.open - a.open),
  });
});

// Expenses paid on the spot — the postings the Expenses screen makes and lists.
on('GET', '/api/books/expenses', ADMIN, async ({ db, res }) => {
  const r = await db.query(
    `select e.id, e.entry_no, e.entry_date, e.memo,
            coalesce(jsonb_agg(jsonb_build_object(
              'account', l.account, 'title', a.title, 'debit', l.debit, 'credit', l.credit)
              order by l.id) filter (where l.debit > 0), '[]') as lines,
            coalesce(sum(l.debit), 0) as total
       from journal_entries e
       join journal_lines l on l.entry_id = e.id
       join coa_accounts a on a.code = l.account
      where e.source = 'expense'
      group by e.id
      order by e.entry_date desc, e.id desc
      limit 100`);
  ok(res, r.rows);
});

on('POST', '/api/books/expenses', ADMIN, async ({ db, res, body }) => {
  const lines = (body.lines || [])
    .map((l) => ({ account: String(l.account || ''), amount: Number(l.amount) || 0, memo: l.memo || null }))
    .filter((l) => l.account && l.amount > 0);
  if (!lines.length) return fail(res, 400, 'An expense needs at least one line.');
  try {
    const r = await db.query('select record_expense($1,$2,$3,$4::jsonb,$5,$6) as id',
      [body.pay_date || today(), body.paid_from || '', body.memo || null, JSON.stringify(lines),
       body.method || 'cash', body.reference || null]);
    ok(res, { id: Number(r.rows[0].id) });
  } catch (e) {
    if (/BOOKS_DONT_BALANCE/.test(e.message)) return fail(res, 400, e.message.replace('BOOKS_DONT_BALANCE: ', ''));
    if (/at least one line|for nothing|cash account|not in the chart/i.test(e.message)) {
      return fail(res, 400, e.message.replace(/^.*:\s*/, ''));
    }
    throw e;
  }
});

// ===========================================================================
// Books — Phase 3: cash & disbursements
//
// The cash position across the accounts marked as cash, movements between and
// through them, transfers, and the register of disbursement vouchers.
// ===========================================================================

// The cash position: each cash account with its balance, the total, and the
// recent movements that touched a cash account (money in and out).
on('GET', '/api/books/cash', ADMIN, async ({ db, res }) => {
  const accts = await db.query(
    `select tb.code, tb.title, tb.balance
       from trial_balance tb join coa_accounts a on a.code = tb.code
      where a.is_cash order by tb.title`);
  const total = accts.rows.reduce((s, a) => s + Number(a.balance), 0);
  const moves = await db.query(
    `select e.id, e.entry_no, e.entry_date, e.memo, e.source,
            l.account, a.title, l.debit, l.credit
       from journal_lines l
       join coa_accounts a on a.code = l.account
       join journal_entries e on e.id = l.entry_id
      where a.is_cash
      order by e.entry_date desc, e.id desc, l.id desc
      limit 60`);
  ok(res, { accounts: accts.rows, total, movements: moves.rows });
});

// Marking an account as cash, or not.
on('POST', '/api/books/cash/mark', ADMIN, async ({ db, res, body }) => {
  try {
    await db.query('select set_cash_account($1,$2)', [body.code || '', body.is_cash !== false]);
    ok(res, { done: true });
  } catch (e) {
    if (/no such account/i.test(e.message)) return fail(res, 400, e.message.replace(/^.*:\s*/, ''));
    throw e;
  }
});

// Moving cash between two cash accounts.
on('POST', '/api/books/transfer', ADMIN, async ({ db, res, body }) => {
  try {
    const r = await db.query('select transfer_cash($1,$2,$3,$4,$5) as id',
      [body.from || '', body.to || '', body.xfer_date || today(), Number(body.amount) || 0, body.memo || null]);
    ok(res, { id: Number(r.rows[0].id) });
  } catch (e) {
    if (/BOOKS_DONT_BALANCE/.test(e.message)) return fail(res, 400, e.message.replace('BOOKS_DONT_BALANCE: ', ''));
    if (/different accounts|more than nothing|cash account/i.test(e.message)) {
      return fail(res, 400, e.message.replace(/^.*:\s*/, ''));
    }
    throw e;
  }
});

// The register of disbursement vouchers — bill payments and expenses alike.
on('GET', '/api/books/disbursements', ADMIN, async ({ db, res }) => {
  const r = await db.query(
    `select voucher_no, kind, paid_on, payee, method, reference, amount,
            paid_from, paid_from_title, memo, bill_no
       from cash_disbursements order by paid_on desc, voucher_no desc limit 300`);
  ok(res, r.rows);
});

// ===========================================================================
// Books — Phase 4: reports
//
// Read-only period reports over the postings already made — a payables aging,
// a cash-flow summary, and an income statement for a chosen period against the
// one before it. Nothing new is stored; every figure is derived from the
// journal, so a report can never disagree with the books. Owner-only.
// ===========================================================================

// The first of the month, as a sensible default 'from' for a period report.
const monthStart = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`; };
const ymd = (s, fallback) => (/^\d{4}-\d{2}-\d{2}$/.test(String(s || '')) ? String(s) : fallback);
const shiftDay = (s, delta) => { const d = new Date(s + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + delta); return d.toISOString().slice(0, 10); };

// Payables aging: every open bill bucketed by how far past due it is, per
// supplier and in total. Undated bills age from their bill date.
on('GET', '/api/books/reports/aging', ADMIN, async ({ db, res }) => {
  const r = await db.query(
    `select vendor, balance,
       case when coalesce(due_date, bill_date) >= current_date then 'notdue'
            when current_date - coalesce(due_date, bill_date) <= 30 then 'd30'
            when current_date - coalesce(due_date, bill_date) <= 60 then 'd60'
            when current_date - coalesce(due_date, bill_date) <= 90 then 'd90'
            else 'over' end as bucket
       from bill_status where status <> 'paid'`);
  const byV = {};
  const totals = { notdue: 0, d30: 0, d60: 0, d90: 0, over: 0, total: 0 };
  for (const row of r.rows) {
    const bal = Number(row.balance);
    const v = (byV[row.vendor] ||= { vendor: row.vendor, notdue: 0, d30: 0, d60: 0, d90: 0, over: 0, total: 0 });
    v[row.bucket] += bal; v.total += bal;
    totals[row.bucket] += bal; totals.total += bal;
  }
  ok(res, { vendors: Object.values(byV).sort((a, b) => b.total - a.total), totals });
});

// Cash flow for a period: opening cash, what came in and what went out (each
// broken down by the account on the other side of the posting), and the closing
// cash that falls out. In and out are the debits and credits on cash accounts.
on('GET', '/api/books/reports/cashflow', ADMIN, async ({ db, res, query }) => {
  const to = ymd(query.to, today());
  const from = ymd(query.from, monthStart());
  const opening = (await db.query(
    `select coalesce(sum(l.debit - l.credit), 0) as bal
       from journal_lines l join coa_accounts a on a.code = l.account
       join journal_entries e on e.id = l.entry_id
      where a.is_cash and e.entry_date < $1`, [from])).rows[0].bal;
  const flow = (await db.query(
    `select coalesce(sum(l.debit), 0) as inn, coalesce(sum(l.credit), 0) as out
       from journal_lines l join coa_accounts a on a.code = l.account
       join journal_entries e on e.id = l.entry_id
      where a.is_cash and e.entry_date between $1 and $2`, [from, to])).rows[0];
  const inflows = (await db.query(
    `select a.title, sum(l.credit) as amount
       from journal_lines l join coa_accounts a on a.code = l.account
       join journal_entries e on e.id = l.entry_id
      where l.credit > 0 and not a.is_cash and e.entry_date between $1 and $2
        and e.id in (select l2.entry_id from journal_lines l2 join coa_accounts a2 on a2.code = l2.account
                      where a2.is_cash and l2.debit > 0)
      group by a.title order by amount desc`, [from, to])).rows;
  const outflows = (await db.query(
    `select a.title, sum(l.debit) as amount
       from journal_lines l join coa_accounts a on a.code = l.account
       join journal_entries e on e.id = l.entry_id
      where l.debit > 0 and not a.is_cash and e.entry_date between $1 and $2
        and e.id in (select l2.entry_id from journal_lines l2 join coa_accounts a2 on a2.code = l2.account
                      where a2.is_cash and l2.credit > 0)
      group by a.title order by amount desc`, [from, to])).rows;
  const open = Number(opening), tin = Number(flow.inn), tout = Number(flow.out);
  ok(res, { from, to, opening: open, inflows, outflows,
            total_in: tin, total_out: tout, net: tin - tout, closing: open + tin - tout });
});

// An income statement for a chosen period, with the period before it (same
// length, ending the day before this one starts) beside it for comparison.
on('GET', '/api/books/reports/income', ADMIN, async ({ db, res, query }) => {
  const to = ymd(query.to, today());
  const from = ymd(query.from, monthStart());
  const rowsIn = async (f, t) => (await db.query(
    `select a.type, a.title, a.code,
       case when a.normal_side = 'debit' then sum(l.debit - l.credit) else sum(l.credit - l.debit) end as balance
       from journal_lines l join coa_accounts a on a.code = l.account
       join journal_entries e on e.id = l.entry_id
      where e.entry_date between $1 and $2
        and a.type in ('Revenue', 'Contra Revenue', 'Expense', 'Contra Expense')
      group by a.type, a.title, a.code`, [f, t])).rows.filter((x) => Number(x.balance) !== 0);
  const tallies = (rows) => {
    const by = (t) => rows.filter((x) => x.type === t);
    const sum = (rs) => rs.reduce((s, x) => s + Number(x.balance), 0);
    const revenue = sum(by('Revenue')) - sum(by('Contra Revenue'));
    const expense = sum(by('Expense')) - sum(by('Contra Expense'));
    return { revenue: by('Revenue'), expense: by('Expense'),
             total_revenue: revenue, total_expense: expense, profit: revenue - expense };
  };
  const span = Math.round((Date.parse(to) - Date.parse(from)) / 86400000);
  const priorTo = shiftDay(from, -1);
  const priorFrom = shiftDay(priorTo, -span);
  const period = tallies(await rowsIn(from, to));
  const prior = tallies(await rowsIn(priorFrom, priorTo));
  ok(res, { from, to, period,
            prior: { from: priorFrom, to: priorTo, total_revenue: prior.total_revenue,
                     total_expense: prior.total_expense, profit: prior.profit } });
});

// ===========================================================================
// Books — Phase 5: auto-posting
//
// The day's real trading, read out of the selling side and posted to the
// ledger. GET reports what is waiting; POST runs the sweep. Both are
// owner-only, additive, and idempotent — see db/077_books_autopost.sql.
// ===========================================================================
on('GET', '/api/books/sync', ADMIN, async ({ db, res }) => {
  const r = await db.query('select books_pending() as p');
  ok(res, r.rows[0].p);
});

on('POST', '/api/books/sync', ADMIN, async ({ db, res }) => {
  const r = await db.query('select sync_books() as p');
  ok(res, r.rows[0].p);
});

// Value the stockroom: bring the Inventory book value to the actual stock on
// hand at cost, the difference to shrinkage (or back through clearing).
on('POST', '/api/books/value-inventory', ADMIN, async ({ db, res }) => {
  const r = await db.query('select value_inventory() as p');
  ok(res, r.rows[0].p);
});
