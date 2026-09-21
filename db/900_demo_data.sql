-- ============================================================================
-- MS BEAU AVE — demo data
--
-- Optional. Load this to get a shop that already has a history: two months of
-- counter sales, wholesale orders at every stage, one account past due and
-- blocked, batches near expiry, and shelves that need refilling.
--
-- Everything is built by calling the engine's own functions rather than
-- inserting rows, so the pool splits, the pick order, the invoices and the
-- ledger all reconcile exactly as they would in real use.
--
-- Safe to run against any Postgres with db/001..003 applied. It does nothing
-- if products already exist.
-- ============================================================================
do $demo$
declare
  batch_seq int := 1000;
  p         record;
  extra     record;
  d         int;
  lines     jsonb;
  v_order   bigint;
  day       timestamptz;
  stamp     text;
  receipts  int := 0;
  total_    numeric;
  ids       jsonb := '{}'::jsonb;
  r         record;
  inv       record;
  keep      int := 2;
  leave     int;
  shelf_row record;
  move_qty  int;
begin
  if exists (select 1 from products) then
    raise notice 'there are already products here — leaving the data alone';
    return;
  end if;

  perform set_config('app.role', 'admin', true);
  perform set_config('app.actor', 'demo', true);

  -- Historical rows carry their real dates, so the append-only journal has to
  -- accept back-dating for the length of this transaction only.
  alter table movements disable trigger movements_immutable;

  -- -------------------------------------------------------------------------
  -- The catalogue
  -- -------------------------------------------------------------------------
  insert into products (sku, name, brand, category, unit_cost, wholesale_price,
                        srp, retail_price, shelf_life_months, shelf_min)
  values
    ('SER-001','Radiance Vitamin C Serum 30ml','Beau Glow','Serums',210,380,650,690,24,6),
    ('SER-002','Retinoid Night Active Serum 30ml','Aurea Lab','Serums',295,520,890,950,18,4),
    ('SER-003','Niacinamide Clarifying Serum 30ml','Beau Glow','Serums',185,340,580,620,24,6),
    ('SER-004','Hyaluronic Hydra Boost Serum 30ml','Luna Derm','Serums',225,410,700,740,24,5),
    ('SER-005','Peptide Firming Serum 30ml','Aurea Lab','Serums',340,610,1050,1120,18,3),
    ('SER-006','Centella Calming Ampoule 30ml','Isla Naturals','Serums',195,355,610,650,24,4),
    ('CRM-001','Photoprotectant Day Cream 50ml','Luna Derm','Creams',240,430,740,780,24,5),
    ('CRM-002','Barrier Repair Night Cream 50ml','Luna Derm','Creams',265,470,810,850,24,4),
    ('CRM-003','Brightening Underarm Cream 30ml','Rosa Botanica','Creams',120,225,390,420,24,8),
    ('CRM-004','Ceramide Moisture Gel 50ml','Isla Naturals','Creams',175,320,550,590,24,5),
    ('CRM-005','Anti-Melasma Spot Cream 15ml','Aurea Lab','Creams',280,500,860,900,18,3),
    ('CRM-006','Rice Water Sleeping Mask 60ml','Isla Naturals','Creams',160,295,510,545,24,6),
    ('LIP-001','Rose Tint Lip & Cheek 6ml','Rosa Botanica','Lip',85,165,290,310,30,10),
    ('LIP-002','Velvet Matte Lipstick — Dusty Pink','Rosa Botanica','Lip',110,210,360,390,36,10),
    ('LIP-003','Hydrating Lip Sleeping Mask 8g','Beau Glow','Lip',95,180,310,330,30,8),
    ('LIP-004','Peptide Lip Serum 5ml','Aurea Lab','Lip',140,260,450,480,24,6),
    ('LIP-005','Tinted Lip Balm SPF15 4g','Luna Derm','Lip',75,145,250,270,30,12),
    ('SOP-001','Micro-Exfoliating Beauty Soap 120g','Beau Glow','Soaps',55,110,190,205,36,20),
    ('SOP-002','Clarifying Kojic Soap 120g','Beau Glow','Soaps',60,120,210,225,36,20),
    ('SOP-003','Brightening Papaya Soap 120g','Rosa Botanica','Soaps',48,95,165,180,36,24),
    ('SOP-004','Charcoal Detox Soap 120g','Isla Naturals','Soaps',52,105,180,195,36,18),
    ('SOP-005','Goat Milk Gentle Soap 120g','Isla Naturals','Soaps',58,115,200,215,36,16),
    ('SOP-006','Sulfur Acne Bar 100g','Aurea Lab','Soaps',65,130,225,240,30,12),
    ('TON-001','Peeling Toner / Keratolytic 120ml','Aurea Lab','Toners',190,350,600,640,18,5),
    ('TON-002','Rose Hydrating Toner 200ml','Rosa Botanica','Toners',135,250,430,460,24,8),
    ('TON-003','BHA Pore Clarifying Toner 150ml','Beau Glow','Toners',165,305,525,560,18,6),
    ('TON-004','Green Tea Balancing Toner 200ml','Isla Naturals','Toners',125,235,405,435,24,8),
    ('SUN-001','Daily Shield Sunscreen SPF50 50ml','Luna Derm','Sunscreen',235,425,730,770,24,8),
    ('SUN-002','Tinted Mineral Sunscreen SPF40 40ml','Beau Glow','Sunscreen',260,470,810,860,24,5),
    ('SUN-003','Sunscreen Stick SPF50 15g','Rosa Botanica','Sunscreen',195,360,620,660,24,6);

  -- -------------------------------------------------------------------------
  -- Deliveries. One big batch each, plus a few chosen to exercise the
  -- six-month warning and the twelve-month floor resellers hold us to.
  -- -------------------------------------------------------------------------
  perform set_config('app.role', 'warehouse', true);
  perform set_config('app.actor', 'demo-warehouse', true);

  for p in select sku, shelf_life_months from products order by sku loop
    batch_seq := batch_seq + 1;
    perform receive_stock(p.sku, 'B' || batch_seq,
      (current_date + make_interval(months => least(p.shelf_life_months, 22)))::date, 400);
  end loop;

  for extra in
    select * from (values
      ('SER-001', 4, 60), ('SER-001', 14, 180),   -- one near expiry, one mid-life
      ('SER-002', 10, 90),                        -- under the floor: shop only
      ('SER-004', 5, 40),
      ('CRM-001', 11, 120),
      ('CRM-003', 3, 50),                         -- going off soon
      ('LIP-002', 15, 200),
      ('SOP-001', 9, 240),
      ('TON-001', 5, 70),                         -- an active, expiry-sensitive
      ('SUN-001', 13, 150)
    ) as t(sku, months, qty)
  loop
    batch_seq := batch_seq + 1;
    perform receive_stock(extra.sku, 'B' || batch_seq,
      (current_date + make_interval(months => extra.months))::date, extra.qty);
  end loop;

  -- Receiving lands whole in shop, and shop is what a reseller's order draws
  -- from too — nothing further to move for the wholesale history below.
  -- A small slice still goes to reserve, so there is something on the books
  -- to demonstrate the owner-only release with.
  for shelf_row in select s.batch_id, s.on_hand from stock s where s.pool = 'shop' loop
    move_qty := floor(shelf_row.on_hand * 0.1)::int;
    if move_qty > 0 then
      perform move_stock(shelf_row.batch_id, 'shop', 'reserve', move_qty, 'rebalanced');
    end if;
  end loop;

  -- -------------------------------------------------------------------------
  -- Reseller accounts
  -- -------------------------------------------------------------------------
  perform set_config('app.role', 'admin', true);
  perform set_config('app.actor', 'demo', true);

  for r in
    select * from (values
      ('Bella Skin Manila',      'orders@bellaskin.ph',     3, 500000, 45, true),
      ('Cebu Glow Distributors', 'buyer@cebuglow.ph',       2, 150000, 30, true),
      ('Davao Beauty Hub',       'admin@davaobeauty.ph',    2, 120000, 30, true),
      ('Iloilo Radiance Store',  'hello@iloiloradiance.ph', 1, 0,      0,  true),
      ('Baguio Beaute Corner',   'apply@baguiobeaute.ph',   1, 0,      0,  false)
    ) as t(name, email, tier, climit, days, approve)
  loop
    ids := ids || jsonb_build_object(r.name,
      create_reseller(r.name, null, r.email, r.tier, r.climit, r.days));
    perform attach_document((ids ->> r.name)::bigint, 'business licence',
      lower(replace(r.name, ' ', '-')) || '-dti.pdf');
    perform attach_document((ids ->> r.name)::bigint, 'tax paper',
      lower(replace(r.name, ' ', '-')) || '-bir2303.pdf');
    if r.approve then
      perform approve_reseller((ids ->> r.name)::bigint);
    else
      -- Left pending on purpose, so there is an application to review.
      update reseller_documents set verified = false
       where reseller_id = (ids ->> r.name)::bigint;
    end if;
  end loop;

  -- -------------------------------------------------------------------------
  -- Reorder points. SER-001 is the worked example: 10 a day, 15 at worst,
  -- a 60-day wait and 75 at worst → buffer 525, reorder at 1,125.
  -- -------------------------------------------------------------------------
  perform set_config('app.role', 'warehouse', true);
  for r in
    select * from (values
      ('SER-001',10,15,60,75), ('SER-002',4,7,60,80), ('SER-003',6,10,45,60),
      ('CRM-001',5,9,50,70),   ('CRM-003',8,14,40,55), ('LIP-002',12,20,35,50),
      ('SOP-001',25,40,30,45), ('SOP-002',18,30,30,45), ('TON-001',5,9,60,80),
      ('SUN-001',7,12,45,65)
    ) as t(sku, avg_d, max_d, avg_l, max_l)
  loop
    perform set_reorder_point(r.sku, r.avg_d, r.max_d, r.avg_l, r.max_l);
  end loop;

  -- -------------------------------------------------------------------------
  -- Two months of counter sales, so the reports and the demand figures have
  -- something real behind them.
  -- -------------------------------------------------------------------------
  perform set_config('app.role', 'cashier', true);
  perform set_config('app.actor', 'cashier', true);

  for d in reverse 60..1 loop
    day := now() - make_interval(days => d);
    continue when extract(dow from day) = 0;              -- closed on Sundays

    select jsonb_agg(jsonb_build_object('sku', sku, 'qty', greatest(1, rate - (d % 2))))
      into lines
      from (select sku, rate, row_number() over () as pos from (values
              ('SOP-001',3), ('SOP-002',2), ('LIP-002',2), ('LIP-001',2),
              ('SER-001',1), ('CRM-003',2), ('TON-002',1), ('SUN-001',1)
            ) as t(sku, rate)) s
     where (d + pos) % 2 = 0;
    continue when lines is null;

    v_order := place_order('shop', lines);
    perform fulfil_order(v_order);
    select total into total_ from orders where id = v_order;

    receipts := receipts + 1;
    stamp := to_char(day, 'YYYYMMDD');
    insert into sales (order_id, receipt_no, method, total, tendered, change_due, cashier, at)
    values (v_order, 'OR-' || stamp || '-' || lpad(receipts::text, 5, '0'),
            (array['cash','cash','gcash','card'])[(d % 4) + 1], total_, total_, 0, 'cashier', day);
    update orders set placed_at = day, placed_by = 'cashier' where id = v_order;
    update movements set at = day
     where batch_id in (select batch_id from order_lines where order_id = v_order)
       and reason = 'sold' and at > now() - interval '1 minute';
  end loop;

  -- -------------------------------------------------------------------------
  -- Wholesale history
  -- -------------------------------------------------------------------------
  perform set_config('app.role', 'admin', true);
  perform set_config('app.actor', 'demo', true);

  -- A key account, paid on time, delivered.
  v_order := place_order('b2b',
    '[{"sku":"SER-001","qty":60},{"sku":"SOP-001","qty":150},{"sku":"CRM-001","qty":40}]'::jsonb,
    (ids ->> 'Bella Skin Manila')::bigint);
  update orders set placed_at = now() - interval '50 days' where id = v_order;
  update invoices set issued_on = current_date - 50, due_on = current_date - 5
   where order_id = v_order;
  select * into inv from invoices where order_id = v_order;
  perform record_payment(inv.id, inv.amount, current_date - 20);
  perform set_config('app.role', 'warehouse', true);
  perform fulfil_order(v_order);
  perform mark_delivered(v_order);
  perform set_config('app.role', 'admin', true);

  -- Out with the courier now.
  v_order := place_order('b2b',
    '[{"sku":"LIP-002","qty":80},{"sku":"SUN-001","qty":40}]'::jsonb,
    (ids ->> 'Bella Skin Manila')::bigint);
  update orders set placed_at = now() - interval '12 days' where id = v_order;
  update invoices set issued_on = current_date - 12, due_on = current_date + 33
   where order_id = v_order;
  perform set_config('app.role', 'warehouse', true);
  perform fulfil_order(v_order);
  perform set_config('app.role', 'admin', true);

  -- Settled inside ten days, so the 2% came off by itself.
  v_order := place_order('b2b',
    '[{"sku":"SOP-002","qty":120},{"sku":"TON-002","qty":50}]'::jsonb,
    (ids ->> 'Cebu Glow Distributors')::bigint);
  update orders set placed_at = now() - interval '40 days' where id = v_order;
  update invoices set issued_on = current_date - 40, due_on = current_date - 10
   where order_id = v_order;
  select * into inv from invoices where order_id = v_order;
  perform record_payment(inv.id, round(inv.amount * 0.98, 2), current_date - 34);
  perform set_config('app.role', 'warehouse', true);
  perform fulfil_order(v_order);
  perform mark_delivered(v_order);
  perform set_config('app.role', 'admin', true);

  -- Sixty days on thirty-day terms: past due, so the system stops them.
  v_order := place_order('b2b',
    '[{"sku":"SER-003","qty":45},{"sku":"CRM-003","qty":90}]'::jsonb,
    (ids ->> 'Davao Beauty Hub')::bigint);
  update orders set placed_at = now() - interval '60 days' where id = v_order;
  update invoices set issued_on = current_date - 60, due_on = current_date - 30
   where order_id = v_order;
  perform set_config('app.role', 'warehouse', true);
  perform fulfil_order(v_order);
  perform mark_delivered(v_order);
  perform set_config('app.role', 'admin', true);

  -- Prepaid, paid, then sent.
  v_order := place_order('b2b',
    '[{"sku":"SOP-003","qty":60},{"sku":"LIP-005","qty":40}]'::jsonb,
    (ids ->> 'Iloilo Radiance Store')::bigint);
  update orders set placed_at = now() - interval '8 days' where id = v_order;
  select * into inv from invoices where order_id = v_order;
  perform record_payment(inv.id, inv.amount, current_date - 8);
  perform set_config('app.role', 'warehouse', true);
  perform fulfil_order(v_order);
  perform set_config('app.role', 'admin', true);

  -- One still waiting to be picked.
  perform place_order('b2b',
    '[{"sku":"SER-004","qty":30},{"sku":"SOP-004","qty":100}]'::jsonb,
    (ids ->> 'Cebu Glow Distributors')::bigint);

  perform refresh_blocks();

  -- -------------------------------------------------------------------------
  -- Run one shelf down to nothing, so there is a real restock task waiting.
  -- Most of it goes back to the wholesale pool, then an ordinary sale takes
  -- the last two and the system raises the task itself.
  -- -------------------------------------------------------------------------
  perform set_config('app.role', 'warehouse', true);
  leave := keep;
  for shelf_row in
    select s.batch_id, (s.on_hand - s.committed)::int as free
      from batches b join stock s on s.batch_id = b.id
     where b.sku = 'LIP-003' and s.pool = 'shop'
       and b.expiry > current_date and s.on_hand - s.committed > 0
     order by b.expiry
  loop
    move_qty := greatest(0, shelf_row.free - leave);
    leave := greatest(0, leave - shelf_row.free);
    if move_qty > 0 then
      perform move_stock(shelf_row.batch_id, 'shop', 'b2b', move_qty, 'rebalanced');
    end if;
  end loop;

  perform set_config('app.role', 'cashier', true);
  perform set_config('app.actor', 'cashier', true);
  perform sell(jsonb_build_array(jsonb_build_object('sku', 'LIP-003', 'qty', keep)), 'cash', 1000);

  -- -------------------------------------------------------------------------
  -- Sign-ins. Every one of these has the password "msbeauave" — change them
  -- before this is used for anything real. The digests are scrypt, computed
  -- outside the database; nothing here can turn them back into a password.
  -- -------------------------------------------------------------------------
  perform set_config('app.role', 'admin', true);
  insert into app_users (username, display_name, password_hash, role, reseller_id) values
    ('admin', 'Ms Beau (Owner)',
     'scrypt$4/gCfvSy1+TImrCdM5MP5g==$BtFW39PSMINSZ8kivAmOqbKmsz+cFzn3gvvwPiFB5Qk=',
     'admin', null),
    ('warehouse', 'Warehouse Staff',
     'scrypt$/OFy01OlXZDDu3l1Ee+wkg==$0+VTeLyROu3MkcxYheOKGNpVTl+bIqQ/kIypmd5zlTQ=',
     'warehouse', null),
    ('cashier', 'Shop Cashier',
     'scrypt$789DuC/A7OGRHCe1tIEnAA==$1Z18jQxpasAd1o+sEIcp/MTcZ4wtoL00PejyGuIJn1Q=',
     'cashier', null),
    ('reseller', 'Cebu Glow Distributors',
     'scrypt$pjT+VRUdwoTu18tqqxTZAw==$E1lD6sF7zT1gdMQgfqbtMLbdvECGebvLOCOJU6q8xUU=',
     'reseller', (ids ->> 'Cebu Glow Distributors')::bigint),
    ('blocked', 'Davao Beauty Hub',
     'scrypt$yoZ00jKLUBzPw8vh/IaWIA==$fGsUwOO6PNTFCQiAVx1dD8ojKKEcSiwgv7iHkdTAKTY=',
     'reseller', (ids ->> 'Davao Beauty Hub')::bigint);

  perform classify_abc(90);
  alter table movements enable trigger movements_immutable;

  raise notice 'demo data loaded: 30 products, 5 reseller accounts, % counter sales', receipts;
end;
$demo$;
