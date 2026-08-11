// Every endpoint the app has.
//
// Handlers stay thin on purpose: they check nothing the database already
// checks, and they call the functions in db/002_rules.sql rather than writing
// to tables. If a rule looks like it is missing here, it is because it lives
// where it cannot be bypassed.
import { on, ok, fail, send, ANYONE, ADMIN, STOCK, TILL, STAFF, RESELLER } from './router.js';
import { pool, queryAll } from './db.js';
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
on('GET', '/api/dashboard', ADMIN, async ({ db, res }) => {
  // Blocking is decided live off the invoices; this writes the flag and its
  // event so the account history records it. Opening the dashboard is the
  // daily sweep, since there is no scheduler in this build.
  await db.query('select refresh_blocks()');

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

  ok(res, {
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
  });
});

// ---------------------------------------------------------------------------
// Products and batches
// ---------------------------------------------------------------------------
on('GET', '/api/products', STAFF, async ({ db, res, query }) => {
  const term = `%${query.q || ''}%`;
  const r = await db.query(
    `select s.*, ph.has_photo from stock_summary s
       join product_has_photo ph on ph.sku = s.sku
      where s.sku ilike $1 or s.name ilike $1 or coalesce(s.brand, '') ilike $1
      order by s.name`, [term]);
  ok(res, r.rows);
});

on('POST', '/api/products', ADMIN, async ({ db, res, body }) => {
  await db.query(
    `insert into products (sku, name, brand, category, unit_cost, wholesale_price,
                           srp, retail_price, shelf_life_months, reseller_floor_months, shelf_min)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,coalesce($10,12),coalesce($11,0))`,
    [body.sku, body.name, body.brand || null, body.category || null,
     body.unit_cost || 0, body.wholesale_price || 0, body.srp || 0, body.retail_price || 0,
     body.shelf_life_months || 24, int(body.reseller_floor_months), int(body.shelf_min)]);
  ok(res, { done: true });
});

on('PUT', '/api/products/:sku', ADMIN, async ({ db, res, body, params }) => {
  const allowed = ['name', 'brand', 'category', 'unit_cost', 'wholesale_price', 'srp',
    'retail_price', 'shelf_life_months', 'reseller_floor_months', 'shelf_min', 'active',
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

on('GET', '/api/products/:sku/batches', STAFF, async ({ db, res, params }) => {
  const r = await db.query(
    'select * from batch_detail where sku = $1 order by expiry', [params.sku]);
  ok(res, r.rows);
});

on('POST', '/api/receive', STOCK, async ({ db, res, body }) => {
  const received = await db.query('select receive_stock($1,$2,$3,$4) as id',
    [body.sku, body.batch_no, body.expiry, Number(body.qty)]);
  const batchId = Number(received.rows[0].id);
  const split = await db.query(
    'select pool, on_hand from stock where batch_id = $1 order by pool', [batchId]);
  ok(res, { batchId, allocation: split.rows });
});

// ---------------------------------------------------------------------------
// Moving stock about
// ---------------------------------------------------------------------------
on('POST', '/api/move', STOCK, async ({ db, res, body }) => {
  await db.query('select move_stock($1,$2,$3,$4)',
    [Number(body.batchId), body.from, body.to, Number(body.qty)]);
  ok(res, { done: true });
});

on('GET', '/api/expired', STOCK, async ({ db, res }) => {
  const r = await db.query('select * from expired_stock order by expiry');
  ok(res, r.rows);
});

on('POST', '/api/expired/write-off', STOCK, async ({ db, res, body }) => {
  const r = await db.query('select write_off_expired($1) as units',
    [body.batchId == null ? null : Number(body.batchId)]);
  ok(res, { units: Number(r.rows[0].units) });
});

on('POST', '/api/stock-count', STOCK, async ({ db, res, body }) => {
  const r = await db.query('select to_jsonb(record_stock_count($1,$2)) as row',
    [body.sku, Number(body.counted)]);
  ok(res, r.rows[0].row);
});

on('GET', '/api/stock-counts', STOCK, async ({ db, res }) => {
  const r = await db.query(
    `select c.*, p.name from stock_counts c join products p on p.sku = c.sku
      order by c.at desc limit 50`);
  ok(res, r.rows);
});

on('GET', '/api/restock', STAFF, async ({ db, res }) => {
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
on('GET', '/api/orders', STOCK, async ({ db, res, query }) => {
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

on('GET', '/api/orders/:id', STOCK, async ({ db, res, params }) => {
  const id = Number(params.id);
  const [order, lines] = await queryAll(db, [
    ['select * from order_board where id = $1', [id]],
    [`select l.sku, p.name, l.qty, l.unit_price, b.batch_no, b.expiry
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
  on('POST', `/api/orders/:id/${path}`, STOCK, async ({ db, res, params }) => {
    await db.query(`select ${fn}($1)`, [Number(params.id)]);
    ok(res, { done: true, message: done });
  });
}

// ---------------------------------------------------------------------------
// Resellers and their credit
// ---------------------------------------------------------------------------
on('GET', '/api/resellers', ADMIN, async ({ db, res }) => {
  const r = await db.query(
    `select r.*, amount_outstanding(r.id) as owed, has_overdue(r.id) as overdue,
            (select count(*)::int from invoices i
              where i.reseller_id = r.id and i.status = 'paid'
                and i.settled_on <= i.due_on) as paid_on_time,
            (select count(*)::int from reseller_events e
              where e.reseller_id = r.id and e.kind = 'paid_late'
                and e.at > now() - interval '90 days') as late_this_quarter
       from resellers r order by r.name`);
  ok(res, r.rows);
});

on('POST', '/api/resellers', ADMIN, async ({ db, res, body }) => {
  const r = await db.query('select create_reseller($1,$2,$3,$4,$5,$6) as id',
    [body.name, body.contact || null, body.email || null,
     body.tier || 1, body.credit_limit || 0, body.terms_days || 0]);
  ok(res, { id: Number(r.rows[0].id) });
});

on('GET', '/api/resellers/:id', ADMIN, async ({ db, res, params }) => {
  const id = Number(params.id);
  const [account, invoices, events, documents] = await queryAll(db, [
    [`select r.*, amount_outstanding(r.id) as owed, has_overdue(r.id) as overdue
        from resellers r where r.id = $1`, [id]],
    [`select i.*, (i.amount - i.paid - i.discount) as balance,
             (i.status = 'open' and i.due_on < current_date) as overdue
        from invoices i where i.reseller_id = $1 order by i.issued_on desc`, [id]],
    ['select * from reseller_events where reseller_id = $1 order by at desc limit 50', [id]],
    ['select * from reseller_documents where reseller_id = $1 order by uploaded_at desc', [id]],
  ]);
  if (!account.rows.length) return fail(res, 404, 'No such account.');
  ok(res, { ...account.rows[0], invoices: invoices.rows,
            events: events.rows, documents: documents.rows });
});

on('POST', '/api/resellers/:id/approve', ADMIN, async ({ db, res, params }) => {
  await db.query('select approve_reseller($1)', [Number(params.id)]);
  ok(res, { done: true });
});

on('POST', '/api/resellers/:id/terms', ADMIN, async ({ db, res, params, body }) => {
  await db.query('select set_terms($1,$2,$3,$4)',
    [Number(params.id), Number(body.tier), Number(body.credit_limit), Number(body.terms_days)]);
  ok(res, { done: true });
});

on('POST', '/api/resellers/:id/override', ADMIN, async ({ db, res, params, body }) => {
  if (!body.note) return fail(res, 400, 'An override needs a reason — it goes on the record.');
  await db.query('select override_block($1,$2)', [Number(params.id), body.note]);
  ok(res, { done: true });
});

on('POST', '/api/resellers/:id/documents', ADMIN, async ({ db, res, params, body }) => {
  await db.query('select attach_document($1,$2,$3)',
    [Number(params.id), body.kind, body.reference]);
  ok(res, { done: true });
});

on('POST', '/api/invoices/:id/payment', ADMIN, async ({ db, res, params, body }) => {
  await db.query('select record_payment($1,$2,$3)',
    [Number(params.id), Number(body.amount),
     body.paid_on || new Date().toISOString().slice(0, 10)]);
  ok(res, { done: true });
});

// ---------------------------------------------------------------------------
// The till
// ---------------------------------------------------------------------------
on('GET', '/api/till/products', TILL, async ({ db, res, query }) => {
  const term = `%${query.q || ''}%`;
  const r = await db.query(
    `select c.*, ph.has_photo from shop_catalog c
       join product_has_photo ph on ph.sku = c.sku
      where c.sku ilike $1 or c.name ilike $1 or coalesce(c.brand, '') ilike $1
      order by c.name limit 60`, [term]);
  ok(res, r.rows);
});

on('POST', '/api/till/sell', TILL, async ({ db, res, body }) => {
  const lines = (body.lines || []).map((l) => ({ sku: l.sku, qty: Number(l.qty) }));
  if (!lines.length) return fail(res, 400, 'The basket is empty.');
  const r = await db.query('select sell($1,$2,$3) as receipt',
    [JSON.stringify(lines), body.method, body.tendered == null ? null : Number(body.tendered)]);
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
  await db.query('select log_shrinkage($1,$2,$3,$4,$5)',
    [body.sku, Number(body.batchId), Number(body.qty), body.reason, user.username]);
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
on('GET', '/api/returns', ADMIN, async ({ db, res }) => {
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
on('GET', '/api/reorder', STOCK, async ({ db, res }) => {
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
on('GET', '/api/reports/sales', ADMIN, async ({ db, res, query }) => {
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

on('GET', '/api/reports/valuation', ADMIN, async ({ db, res }) => {
  const r = await db.query(
    `select sku, name, unit_cost, total_on_hand as units, value_at_cost
       from stock_summary order by value_at_cost desc`);
  ok(res, r.rows);
});

on('GET', '/api/reports/ageing', ADMIN, async ({ db, res }) => {
  const r = await db.query('select * from ageing_stock order by days_left');
  ok(res, r.rows);
});

on('GET', '/api/reports/receivables', ADMIN, async ({ db, res }) => {
  const [ageing, concentration] = await queryAll(db, [
    ['select * from ar_ageing order by total_owed desc'],
    ['select * from ar_concentration order by share desc'],
  ]);
  ok(res, { ageing: ageing.rows, concentration: concentration.rows });
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
    `select u.id, u.username, u.display_name, u.role, u.active, u.reseller_id, r.name as reseller
       from app_users u left join resellers r on r.id = u.reseller_id order by u.username`);
  ok(res, r.rows);
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
  const r = await db.query('select place_order($1,$2,$3) as id',
    ['b2b', JSON.stringify(lines), user.resellerId]);
  const orderId = Number(r.rows[0].id);
  const invoice = await db.query('select * from invoices where order_id = $1', [orderId]);
  ok(res, { orderId, invoice: invoice.rows[0] || null });
});

on('GET', '/api/portal/orders', RESELLER, async ({ db, res }) => {
  const r = await db.query(
    `select o.id, o.status, o.total, o.placed_at, o.delivered_at,
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
on('GET', '/api/workspace', STAFF, async ({ db, res }) => {
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
on('GET', '/api/pickups', TILL, async ({ db, res }) => {
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
on('GET', '/api/promos', STAFF, async ({ db, res }) => {
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
const TEAM_PUBLIC = ['id', 'name', 'position', 'here', 'on_shift', 'since',
                     'has_photo', 'signs_in_as'];

on('GET', '/api/team', STAFF, async ({ db, res, user }) => {
  const rows = (await db.query('select * from team')).rows;
  if (user.role !== 'admin') {
    return ok(res, {
      team: rows.map((r) => Object.fromEntries(
        TEAM_PUBLIC.map((k) => [k, r[k]]))),
      shifts: [],
      logins: [],
    });
  }

  const [shifts, logins] = await queryAll(db, [
    ['select * from shifts_recent limit 60', []],
    [`select u.id, u.username, u.display_name, u.role
        from app_users u
       where u.active and u.role <> 'reseller'
         and not exists (select 1 from employees e where e.user_id = u.id)
       order by u.display_name`, []],
  ]);
  ok(res, { team: rows, shifts: shifts.rows, logins: logins.rows });
});

on('POST', '/api/team', ADMIN, async ({ db, res, body }) => {
  const r = await db.query('select add_employee($1,$2,$3,$4,$5,$6) as id', [
    body.name || '', body.position || '', body.phone || null,
    body.user_id || null, body.started || null, body.note || null,
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

on('POST', '/api/team/:id/photo', ADMIN, async ({ db, res, params, body }) => {
  const match = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/.exec(body.dataUrl || '');
  if (!match) return fail(res, 400, 'That file is not a JPEG, PNG or WebP image.');
  const bytes = Buffer.from(match[2], 'base64');
  if (bytes.length > 900_000) return fail(res, 400, 'That picture is too large.');
  await db.query('select set_employee_photo($1,$2,$3)', [Number(params.id), match[1], bytes]);
  ok(res, { saved: true });
});

// Written straight to the socket rather than staged like every other reply:
// it is bytes, not JSON, and being a read there is no commit worth waiting for.
on('GET', '/api/team/:id/photo', STAFF, async ({ db, res, params }) => {
  const r = await db.query(
    'select mime, bytes, updated_at from employee_photos where employee_id = $1',
    [Number(params.id)]);
  const photo = r.rows[0];
  if (!photo) return fail(res, 404, 'No photograph.');
  res.writeHead(200, {
    'Content-Type': photo.mime,
    'Content-Length': photo.bytes.length,
    'Cache-Control': 'private, max-age=60',
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
on('GET', '/api/customers', ADMIN, async ({ db, res, query }) => {
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

on('GET', '/api/customers/:id', ADMIN, async ({ db, res, params }) => {
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

on('POST', '/api/sales/:receipt/customer', TILL, async ({ db, res, params, body }) => {
  const r = await db.query('select attribute_sale($1,$2) as points',
    [params.receipt, Number(body.customer_id)]);
  ok(res, { points: Number(r.rows[0].points) });
});
