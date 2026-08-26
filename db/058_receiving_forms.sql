-- ============================================================================
-- MS BEAU AVE — the receiving form
--
-- The purchase order is what went out to the supplier. This is what came back:
-- the paper the stockroom fills in while the delivery is still on the floor,
-- before anybody signs for it.
--
-- It is written for what is actually in front of the person holding it — boxes,
-- not units. A delivery of fifty-seven bottles does not arrive as fifty-seven
-- bottles; it arrives as three boxes of sixteen and one plastic of nine, and
-- somebody counts the boxes, not the bottles. So a line here is a packing:
-- how many to a box, how many boxes. A product can have several, and they add
-- up to what that product's delivery came to.
--
-- Around the table is everything the paper needs and the system never had a
-- place for: who drove it, what he was driving, what the shipping cost and how
-- it was settled, the guard who was on the gate, and the time it came through.
-- None of that changes stock. All of it is what you want six weeks later when
-- a case is short and nobody remembers the day.
--
-- The stock side is receive_stock, unchanged, once per product — the batch,
-- the expiry, the cost, the 70/20/10 split — and where the form is answering a
-- purchase order, receive_po_line so the order ticks itself off too.
-- ============================================================================

create table if not exists receiving_forms (
  id            bigint generated always as identity primary key,
  rf_no         text   not null unique,
  po_id         bigint references purchase_orders (id),
  supplier_id   bigint not null references suppliers (id),
  received_on   date   not null default (now() at time zone 'Asia/Manila')::date,
  received_at   text,                 -- the time on the gate, as written
  driver_name   text,
  plate_no      text,
  pickup        text,
  contact       text,
  shipping_fee  numeric(12,2) not null default 0 check (shipping_fee >= 0),
  shipping_mop  text,
  total_boxes   int,
  others        text,
  guard_on_duty text,
  checked_by    text,
  approved_by   text,
  recorded_by   text   not null default current_actor(),
  at            timestamptz not null default now()
);
create index if not exists receiving_forms_by_po       on receiving_forms (po_id);
create index if not exists receiving_forms_by_supplier on receiving_forms (supplier_id);

-- One row is one packing of one product: 3 boxes of 16, or 1 plastic of 9.
-- Rows sharing a line_no are the same product on the paper and were received
-- into stock together, as one batch.
create table if not exists receiving_form_lines (
  id          bigint generated always as identity primary key,
  rf_id       bigint not null references receiving_forms (id) on delete cascade,
  line_no     int    not null,
  sku         text   not null references products (sku),
  unit        text   not null default 'PCS',
  pack        text   not null default 'BOX',
  qty_per_box int    not null check (qty_per_box > 0),
  boxes       int    not null check (boxes > 0),
  qty         int    generated always as (qty_per_box * boxes) stored,
  po_line_id  bigint references purchase_order_lines (id),
  batch_no    text
);
create index if not exists receiving_form_lines_by_rf on receiving_form_lines (rf_id);

alter table receiving_forms      enable row level security;
alter table receiving_form_lines enable row level security;

do $$
declare t text;
begin
  foreach t in array array['receiving_forms', 'receiving_form_lines'] loop
    execute format('drop policy if exists stock_reads_%1$s on %1$s', t);
    execute format($f$create policy stock_reads_%1$s on %1$s for select
      using (current_role_name() in ('admin','warehouse','supervisor','office'))$f$, t);
  end loop;
end $$;

grant select on receiving_forms, receiving_form_lines to app_client;

-- The paper has a UNIT column, and the person filling it in should not have to
-- remember whether a thing is sold in bottles or sachets. Appended to the end
-- of the view, which is the only place create-or-replace allows a column to go
-- and the only way to keep the grants that hang off it.
create or replace view stock_summary as
select p.sku, p.name, p.brand, p.category, p.unit_cost, p.wholesale_price,
       p.srp, p.retail_price, p.shelf_life_months, p.reseller_floor_months,
       p.shelf_min, p.abc_class, p.active,
       coalesce(p.alloc_b2b, 0.70)     as alloc_b2b,
       coalesce(p.alloc_shop, 0.20)    as alloc_shop,
       coalesce(p.alloc_reserve, 0.10) as alloc_reserve,
       coalesce(sum(s.on_hand - s.committed) filter (where s.pool = 'b2b'), 0)::int     as free_b2b,
       coalesce(sum(s.on_hand - s.committed) filter (where s.pool = 'shop'), 0)::int    as free_shop,
       coalesce(sum(s.on_hand - s.committed) filter (where s.pool = 'reserve'), 0)::int as free_reserve,
       coalesce(sum(s.committed) filter (where s.pool = 'b2b'), 0)::int                 as committed_b2b,
       coalesce(sum(s.on_hand), 0)::int                                                 as total_on_hand,
       (coalesce(sum(s.on_hand), 0) * p.unit_cost)::numeric(12,2)                       as value_at_cost,
       p.unit_type
  from products p
  left join batches b on b.sku = p.sku and b.expiry > current_date
  left join stock s on s.batch_id = b.id
 group by p.sku;

-- ---------------------------------------------------------------------------
-- The number: RFC26-08-009. Same shape and same lock as the purchase order.
-- ---------------------------------------------------------------------------
create or replace function next_rf_no() returns text
language plpgsql as $$
declare v_prefix text; v_next int;
begin
  v_prefix := 'RFC' || to_char(now() at time zone 'Asia/Manila', 'YY-MM') || '-';
  perform pg_advisory_xact_lock(hashtext(v_prefix));
  select coalesce(max(substring(rf_no from '\d+$')::int), 0) + 1
    into v_next from receiving_forms where rf_no like v_prefix || '%';
  return v_prefix || lpad(v_next::text, 3, '0');
end;
$$;

-- ---------------------------------------------------------------------------
-- Recording a delivery
--
-- p_lines is one entry per product, each carrying the packings it arrived in:
--
--   [{ "sku": "MB-001", "unit": "PCS", "po_line_id": 12,
--      "batch_no": "L2408", "expiry": "2027-06-30", "unit_cost": 210,
--      "packs": [{ "pack": "BOX", "qty_per_box": 16, "boxes": 3 },
--                { "pack": "PLASTIC", "qty_per_box": 9, "boxes": 1 }] }]
--
-- The packings are counted first and the total is what goes into stock, once,
-- as one batch — because that is what it is. Fifty-seven bottles of one lot are
-- fifty-seven bottles of one lot however they were boxed for the van.
--
-- Everything happens in this one transaction, so a delivery that fails on its
-- fourth product leaves no form and no stock behind, and can simply be entered
-- again once the fourth product's expiry has been read off the carton properly.
-- ---------------------------------------------------------------------------
create or replace function record_receiving_form(
  p_supplier bigint,
  p_lines    jsonb,
  p_courier  jsonb default '{}'::jsonb,
  p_foot     jsonb default '{}'::jsonb,
  p_po       bigint default null,
  p_branch   bigint default null
) returns jsonb
language plpgsql security definer as $$
declare
  v_rf bigint; v_no text; v_n int := 0; v_units int := 0; v_boxes int := 0;
  line record; pk record; v_qty int; v_packs int; v_supplier bigint;
begin
  perform require_role('admin', 'warehouse');
  if jsonb_array_length(coalesce(p_lines, '[]'::jsonb)) = 0 then
    raise exception 'A receiving form needs at least one product.';
  end if;

  -- Answering a purchase order settles who the supplier is; the form cannot
  -- disagree with the order it is answering.
  v_supplier := p_supplier;
  if p_po is not null then
    select supplier_id into v_supplier from purchase_orders where id = p_po;
    if not found then raise exception 'There is no such purchase order.'; end if;
  end if;
  if not exists (select 1 from suppliers where id = v_supplier) then
    raise exception 'Who was this delivered by? Pick a supplier.';
  end if;

  v_no := next_rf_no();
  insert into receiving_forms (
    rf_no, po_id, supplier_id, received_on, received_at, driver_name, plate_no,
    pickup, contact, shipping_fee, shipping_mop, others, guard_on_duty,
    checked_by, approved_by)
  values (
    v_no, p_po, v_supplier,
    coalesce(nullif(btrim(coalesce(p_foot ->> 'received_on', '')), '')::date,
             (now() at time zone 'Asia/Manila')::date),
    nullif(btrim(coalesce(p_courier ->> 'received_at',   '')), ''),
    nullif(btrim(coalesce(p_courier ->> 'driver_name',   '')), ''),
    nullif(btrim(coalesce(p_courier ->> 'plate_no',      '')), ''),
    nullif(btrim(coalesce(p_courier ->> 'pickup',        '')), ''),
    nullif(btrim(coalesce(p_courier ->> 'contact',       '')), ''),
    coalesce(nullif(btrim(coalesce(p_courier ->> 'shipping_fee', '')), '')::numeric, 0),
    nullif(btrim(coalesce(p_courier ->> 'shipping_mop',  '')), ''),
    nullif(btrim(coalesce(p_foot    ->> 'others',        '')), ''),
    nullif(btrim(coalesce(p_foot    ->> 'guard_on_duty', '')), ''),
    nullif(btrim(coalesce(p_foot    ->> 'checked_by',    '')), ''),
    nullif(btrim(coalesce(p_foot    ->> 'approved_by',   '')), ''))
  returning id into v_rf;

  for line in
    select l ->> 'sku' as sku,
           coalesce(nullif(btrim(coalesce(l ->> 'unit', '')), ''), 'PCS') as unit,
           nullif(btrim(coalesce(l ->> 'batch_no', '')), '') as batch_no,
           nullif(btrim(coalesce(l ->> 'expiry', '')), '')::date as expiry,
           nullif(btrim(coalesce(l ->> 'unit_cost', '')), '')::numeric as unit_cost,
           nullif(btrim(coalesce(l ->> 'po_line_id', '')), '')::bigint as po_line_id,
           coalesce(l -> 'packs', '[]'::jsonb) as packs
      from jsonb_array_elements(p_lines) l
  loop
    v_n := v_n + 1;
    if jsonb_array_length(line.packs) = 0 then
      raise exception 'Line %: how did % arrive — how many to a box, and how many boxes?',
        v_n, line.sku;
    end if;
    if line.batch_no is null then
      raise exception 'Line %: what batch number is on the carton?', v_n;
    end if;
    if line.expiry is null then
      raise exception 'Line %: what expiry is on the carton?', v_n;
    end if;

    v_qty := 0; v_packs := 0;
    for pk in
      select coalesce(nullif(btrim(coalesce(p ->> 'pack', '')), ''), 'BOX') as pack,
             (p ->> 'qty_per_box')::int as per,
             coalesce((p ->> 'boxes')::int, 1) as boxes
        from jsonb_array_elements(line.packs) p
    loop
      if pk.per is null or pk.per <= 0 or pk.boxes <= 0 then
        raise exception 'Line %: a packing of % by % is not a count of anything.',
          v_n, pk.boxes, pk.per;
      end if;
      insert into receiving_form_lines (
        rf_id, line_no, sku, unit, pack, qty_per_box, boxes, po_line_id, batch_no)
      values (v_rf, v_n, line.sku, line.unit, pk.pack, pk.per, pk.boxes,
              line.po_line_id, line.batch_no);
      v_qty   := v_qty + pk.per * pk.boxes;
      v_packs := v_packs + pk.boxes;
    end loop;

    -- Into stock once, as the one lot it is. Where the form answers a purchase
    -- order, through receive_po_line so the order ticks itself off as well.
    if line.po_line_id is not null then
      perform receive_po_line(line.po_line_id, line.batch_no, line.expiry, v_qty,
                              line.unit_cost, 'bank', p_branch);
    else
      perform receive_stock(line.sku, line.batch_no, line.expiry, v_qty,
                            line.unit_cost, 'bank', p_branch);
    end if;

    v_units := v_units + v_qty;
    v_boxes := v_boxes + v_packs;
  end loop;

  -- The box count is the one number on this paper somebody checks against the
  -- van without opening anything, so it is written by hand if it was written,
  -- and counted from the packings if it was not.
  update receiving_forms
     set total_boxes = coalesce(nullif(btrim(coalesce(p_foot ->> 'total_boxes', '')), '')::int,
                                v_boxes)
   where id = v_rf;

  return jsonb_build_object('id', v_rf, 'rf_no', v_no,
                            'lines', v_n, 'units', v_units, 'boxes', v_boxes);
end;
$$;

-- receive_po_line was written to admit the office, but the receiving underneath
-- it has always been the stockroom's alone. Asking for a role it will be
-- refused two calls later is a worse error than refusing it here.
create or replace function receive_po_line(
  p_line bigint, p_batch_no text, p_expiry date, p_qty int,
  p_unit_cost numeric default null, p_method text default 'bank',
  p_branch bigint default null
) returns jsonb
language plpgsql security definer as $$
declare v_line purchase_order_lines%rowtype; v_batch bigint; v_short int;
begin
  perform require_role('admin', 'warehouse');
  select * into v_line from purchase_order_lines where id = p_line;
  if not found then raise exception 'There is no such line on any purchase order.'; end if;
  if p_qty is null or p_qty <= 0 then raise exception 'How many arrived?'; end if;

  v_batch := receive_stock(v_line.sku, p_batch_no, p_expiry, p_qty,
                           p_unit_cost, p_method, p_branch);

  update purchase_order_lines set received = received + p_qty
   where id = p_line returning * into v_line;

  select coalesce(sum(greatest(qty - received, 0)), 0) into v_short
    from purchase_order_lines where po_id = v_line.po_id;

  update purchase_orders
     set status = case when v_short = 0 then 'closed' else 'part' end
   where id = v_line.po_id and status in ('open', 'part');

  return jsonb_build_object('batch_id', v_batch, 'received', v_line.received,
                            'ordered', v_line.qty, 'still_short', v_short);
end;
$$;

alter function next_rf_no() set search_path = public, extensions;
alter function record_receiving_form(bigint, jsonb, jsonb, jsonb, bigint, bigint)
  set search_path = public, extensions;
alter function receive_po_line(bigint, text, date, int, numeric, text, bigint)
  set search_path = public, extensions;

grant execute on function record_receiving_form(bigint, jsonb, jsonb, jsonb, bigint, bigint)
  to app_client;
