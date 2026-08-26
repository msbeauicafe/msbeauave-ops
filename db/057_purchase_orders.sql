-- ============================================================================
-- MS BEAU AVE — the purchase order, and receiving against it
--
-- Everything in this system so far has been the company selling. This is the
-- company buying: a sheet sent to a supplier saying what is wanted and how
-- much of it, and — this is the part that makes it more than a printout —
-- something a delivery can later be checked against.
--
-- The paper carries no prices. It is a request, not a contract: what a case
-- costs is settled between the office and the supplier and appears when the
-- goods are received, which is where this system has always put cost. So a
-- purchase order line is a product, a quantity and a unit, and nothing else.
--
-- Receiving stays exactly where it was. receive_stock does the work it has
-- always done — batch, expiry, cost, the 70/20/10 split — and the only thing
-- added is a note against the line of how many of the ordered quantity that
-- delivery accounted for. A line can be received more than once, because a
-- supplier sends ninety-six and then the other ninety-six a fortnight later,
-- and the sheet has a box for exactly that: COMPLETED, LACKINGS, RECORDED.
-- ============================================================================

create table if not exists suppliers (
  id          bigint generated always as identity primary key,
  name        text not null,
  brand_name  text,
  tin         text,
  address     text,
  contact     text,
  active      boolean not null default true,
  created_at  timestamptz not null default now()
);
create unique index if not exists suppliers_by_name on suppliers (lower(name));

create table if not exists purchase_orders (
  id          bigint generated always as identity primary key,
  po_no       text   not null unique,
  supplier_id bigint not null references suppliers (id),
  ordered_on  date   not null default (now() at time zone 'Asia/Manila')::date,
  status      text   not null default 'open'
              check (status in ('open', 'part', 'closed', 'cancelled')),
  note        text,
  raised_by   text   not null default current_actor(),
  at          timestamptz not null default now()
);
create index if not exists purchase_orders_by_supplier on purchase_orders (supplier_id);

create table if not exists purchase_order_lines (
  id       bigint generated always as identity primary key,
  po_id    bigint not null references purchase_orders (id) on delete cascade,
  sku      text   not null references products (sku),
  qty      int    not null check (qty > 0),
  unit     text   not null default 'PCS',
  received int    not null default 0 check (received >= 0)
);
create index if not exists purchase_order_lines_by_po on purchase_order_lines (po_id);

alter table suppliers            enable row level security;
alter table purchase_orders      enable row level security;
alter table purchase_order_lines enable row level security;

-- Buying is the stockroom's business and the owner's. It is not a reseller's,
-- and what this company pays its suppliers is not on a reseller's portal.
do $$
declare t text;
begin
  foreach t in array array['suppliers', 'purchase_orders', 'purchase_order_lines'] loop
    execute format('drop policy if exists stock_reads_%1$s on %1$s', t);
    execute format($f$create policy stock_reads_%1$s on %1$s for select
      using (current_role_name() in ('admin','warehouse','supervisor','office'))$f$, t);
  end loop;
end $$;

grant select on suppliers, purchase_orders, purchase_order_lines to app_client;

-- ---------------------------------------------------------------------------
-- The number: PVE26-08-013 — the house shape, the same one the sales invoice
-- uses. Year, month, and a count that starts again each month.
--
-- The advisory lock is held for the transaction and keyed on the month, so two
-- people raising a purchase order in the same minute cannot both read 012 and
-- both write 013. The unique index is the backstop; this is what stops it
-- being needed.
-- ---------------------------------------------------------------------------
create or replace function next_po_no() returns text
language plpgsql as $$
declare v_prefix text; v_next int;
begin
  v_prefix := 'PVE' || to_char(now() at time zone 'Asia/Manila', 'YY-MM') || '-';
  perform pg_advisory_xact_lock(hashtext(v_prefix));
  select coalesce(max(substring(po_no from '\d+$')::int), 0) + 1
    into v_next from purchase_orders where po_no like v_prefix || '%';
  return v_prefix || lpad(v_next::text, 3, '0');
end;
$$;

create or replace function save_supplier(
  p_id bigint, p_name text, p_brand text, p_tin text, p_address text, p_contact text
) returns bigint
language plpgsql security definer as $$
declare v_id bigint;
begin
  perform require_role('admin', 'warehouse', 'office');
  if length(btrim(coalesce(p_name, ''))) = 0 then
    raise exception 'A supplier needs a name.';
  end if;

  if p_id is null then
    insert into suppliers (name, brand_name, tin, address, contact)
    values (btrim(p_name), nullif(btrim(coalesce(p_brand, '')), ''),
            nullif(btrim(coalesce(p_tin, '')), ''),
            nullif(btrim(coalesce(p_address, '')), ''),
            nullif(btrim(coalesce(p_contact, '')), ''))
    returning id into v_id;
  else
    update suppliers
       set name = btrim(p_name),
           brand_name = nullif(btrim(coalesce(p_brand, '')), ''),
           tin        = nullif(btrim(coalesce(p_tin, '')), ''),
           address    = nullif(btrim(coalesce(p_address, '')), ''),
           contact    = nullif(btrim(coalesce(p_contact, '')), '')
     where id = p_id returning id into v_id;
    if v_id is null then raise exception 'There is no supplier with that number.'; end if;
  end if;
  return v_id;
end;
$$;

create or replace function raise_purchase_order(
  p_supplier bigint, p_lines jsonb, p_note text default null,
  p_ordered_on date default null
) returns jsonb
language plpgsql security definer as $$
declare v_po bigint; v_no text; line record;
begin
  perform require_role('admin', 'warehouse', 'office');
  if jsonb_array_length(coalesce(p_lines, '[]'::jsonb)) = 0 then
    raise exception 'A purchase order needs at least one line.';
  end if;
  if not exists (select 1 from suppliers where id = p_supplier and active) then
    raise exception 'There is no supplier with that number.';
  end if;

  v_no := next_po_no();
  insert into purchase_orders (po_no, supplier_id, note, ordered_on)
  values (v_no, p_supplier, nullif(btrim(coalesce(p_note, '')), ''),
          coalesce(p_ordered_on, (now() at time zone 'Asia/Manila')::date))
  returning id into v_po;

  for line in
    select l ->> 'sku' as sku, (l ->> 'qty')::int as qty,
           coalesce(nullif(btrim(coalesce(l ->> 'unit', '')), ''), 'PCS') as unit
      from jsonb_array_elements(p_lines) l
  loop
    if line.qty is null or line.qty <= 0 then
      raise exception 'How many of % are being ordered?', line.sku;
    end if;
    if not exists (select 1 from products where sku = line.sku) then
      raise exception 'There is no product with the code %.', line.sku;
    end if;
    insert into purchase_order_lines (po_id, sku, qty, unit)
    values (v_po, line.sku, line.qty, line.unit);
  end loop;

  return jsonb_build_object('id', v_po, 'po_no', v_no);
end;
$$;

-- ---------------------------------------------------------------------------
-- Receiving against a line
--
-- receive_stock does the receiving, exactly as it always has. This records
-- how much of the ordered quantity that delivery accounted for, and moves the
-- order's own state along: part-delivered while anything is short, closed when
-- nothing is.
--
-- Over-delivery is allowed and recorded rather than refused. A supplier who
-- sends a hundred against an order for ninety-six has sent a hundred, and a
-- system that insists otherwise is a system somebody works around.
-- ---------------------------------------------------------------------------
create or replace function receive_po_line(
  p_line bigint, p_batch_no text, p_expiry date, p_qty int,
  p_unit_cost numeric default null, p_method text default 'bank',
  p_branch bigint default null
) returns jsonb
language plpgsql security definer as $$
declare v_line purchase_order_lines%rowtype; v_batch bigint; v_short int;
begin
  perform require_role('admin', 'warehouse', 'office');
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

create or replace function cancel_purchase_order(p_po bigint) returns void
language plpgsql security definer as $$
begin
  perform require_role('admin', 'warehouse', 'office');
  update purchase_orders set status = 'cancelled'
   where id = p_po and status in ('open', 'part');
  if not found then
    raise exception 'That purchase order is already closed or cancelled.';
  end if;
end;
$$;

alter function next_po_no()                                          set search_path = public, extensions;
alter function save_supplier(bigint, text, text, text, text, text)   set search_path = public, extensions;
alter function raise_purchase_order(bigint, jsonb, text, date)       set search_path = public, extensions;
alter function receive_po_line(bigint, text, date, int, numeric, text, bigint)
  set search_path = public, extensions;
alter function cancel_purchase_order(bigint)                         set search_path = public, extensions;

grant execute on function save_supplier(bigint, text, text, text, text, text)  to app_client;
grant execute on function raise_purchase_order(bigint, jsonb, text, date)      to app_client;
grant execute on function receive_po_line(bigint, text, date, int, numeric, text, bigint) to app_client;
grant execute on function cancel_purchase_order(bigint)                        to app_client;
