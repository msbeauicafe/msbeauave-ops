-- ============================================================================
-- MS BEAU AVE — stock, sales and money, per branch
--
-- The other half. The foundations gave people an address; this gives it to the
-- shelves, and it is the half that can go quietly wrong.
--
-- The engine's promise is that a unit is never committed twice. That promise
-- lives in one place — the picking loop, which walks a product's batches
-- oldest-first and takes what is free. Add a second shop and every path that
-- touches a shelf has to say which shelf, or the arithmetic still balances
-- while describing the wrong building.
--
-- The shape of the change is one column. A stock row was "this batch, in this
-- pool"; it is now "this batch, in this pool, at this branch". Everything else
-- follows from that, and nine functions write to stock, so all nine change
-- together. Leaving one keyed on (batch, pool) would not fail — it would find
-- two rows where it expected one and update whichever came first.
--
-- A batch is still one manufacturer's lot with one expiry. It can now sit at
-- more than one shop, which is what makes a transfer a movement of quantity
-- rather than a rewriting of history.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- The column, and the constraint that makes it mean something
-- ---------------------------------------------------------------------------
alter table stock add column branch_id bigint references branches (id);
update stock set branch_id = (select id from branches order by id limit 1);
alter table stock alter column branch_id set not null;

alter table stock drop constraint stock_batch_id_pool_key;
alter table stock add constraint stock_one_row_per_pool_per_branch
  unique (batch_id, pool, branch_id);
create index stock_by_branch on stock (branch_id, pool);

-- Where a movement happened. A transfer between shops is two movements, out of
-- one and into the other, rather than a single row with two addresses: that way
-- the journal at each branch reads as its own story.
alter table movements add column branch_id bigint references branches (id);
-- The journal refuses to be rewritten, which is what it is for. Filling in a
-- column that did not exist when those rows were written is the one case that
-- has to step around it, and only for as long as the backfill takes.
alter table movements disable trigger movements_immutable;
update movements set branch_id = (select id from branches order by id limit 1);
alter table movements enable trigger movements_immutable;

-- Which till rang it, which shop it came out of.
alter table orders add column branch_id bigint references branches (id);
update orders set branch_id = (select id from branches order by id limit 1);
alter table orders alter column branch_id set not null;
create index orders_by_branch on orders (branch_id, placed_at);

alter table cash_counts add column branch_id bigint references branches (id);
update cash_counts set branch_id = (select id from branches order by id limit 1);

alter table stock_counts add column branch_id bigint references branches (id);
update stock_counts set branch_id = (select id from branches order by id limit 1);

-- The shop somebody is standing in. Falls back to the only one open, which is
-- what every call means until there are two.
create or replace function default_branch() returns bigint
language sql stable as $$
  select id from branches where active order by id limit 1;
$$;

-- ---------------------------------------------------------------------------
-- Receiving, into a named shop
-- ---------------------------------------------------------------------------
create or replace function receive_stock(
  p_sku      text,
  p_batch_no text,
  p_expiry   date,
  p_qty      int,
  p_unit_cost numeric default null,
  p_method   text default 'bank',
  p_branch   bigint default null
) returns bigint
language plpgsql security definer as $$
declare
  v_batch  bigint;
  v_pools  text[]    := array['b2b','shop','reserve'];
  v_share  numeric[];
  v_whole  int[];
  v_frac   numeric[];
  v_spare  int;
  i        int;
  v_pick   int;
  v_cost   numeric(12,2);
  v_name   text;
  v_branch bigint;
begin
  perform require_role('admin','warehouse');
  if p_qty <= 0 then
    raise exception 'received quantity must be more than zero';
  end if;
  if p_expiry <= current_date then
    raise exception 'that batch is already expired on arrival (% )', p_expiry;
  end if;
  if p_unit_cost is not null and p_unit_cost < 0 then
    raise exception 'a unit cost cannot be negative';
  end if;

  v_branch := branch_or_default(p_branch);
  if not exists (select 1 from branches where id = v_branch and active) then
    raise exception 'That branch is not open.';
  end if;

  select name, unit_cost into v_name, v_cost
    from products where sku = p_sku and active;
  if not found then
    raise exception 'no active product with code %', p_sku;
  end if;

  -- A batch number is one lot from the maker. The same lot arriving at a second
  -- shop is the same batch, not a new one, so its expiry cannot disagree with
  -- itself.
  select id into v_batch from batches where sku = p_sku and batch_no = p_batch_no;
  if found then
    if (select expiry from batches where id = v_batch) <> p_expiry then
      raise exception 'Batch % of % is already recorded expiring %, not %.',
        p_batch_no, v_name, (select expiry from batches where id = v_batch), p_expiry;
    end if;
    update batches set qty_received = qty_received + p_qty where id = v_batch;
  else
    insert into batches (sku, batch_no, expiry, qty_received)
    values (p_sku, p_batch_no, p_expiry, p_qty)
    returning id into v_batch;
  end if;

  select array_agg(share order by ord) into v_share
    from (select share, row_number() over () as ord from allocation_for(p_sku)) s;

  v_whole := array[floor(p_qty * v_share[1])::int,
                   floor(p_qty * v_share[2])::int,
                   floor(p_qty * v_share[3])::int];
  v_frac  := array[p_qty * v_share[1] - v_whole[1],
                   p_qty * v_share[2] - v_whole[2],
                   p_qty * v_share[3] - v_whole[3]];
  v_spare := p_qty - (v_whole[1] + v_whole[2] + v_whole[3]);

  while v_spare > 0 loop
    v_pick := 1;
    for i in 2..3 loop
      if v_frac[i] > v_frac[v_pick] then v_pick := i; end if;
    end loop;
    v_whole[v_pick] := v_whole[v_pick] + 1;
    v_frac[v_pick]  := -1;
    v_spare := v_spare - 1;
  end loop;

  for i in 1..3 loop
    if v_whole[i] > 0 then
      insert into stock (batch_id, pool, branch_id, on_hand)
      values (v_batch, v_pools[i], v_branch, v_whole[i])
      on conflict (batch_id, pool, branch_id)
        do update set on_hand = stock.on_hand + excluded.on_hand;
      insert into movements (batch_id, to_pool, qty, reason, branch_id)
      values (v_batch, v_pools[i], v_whole[i], 'received', v_branch);
    end if;
  end loop;

  if p_unit_cost is not null then
    v_cost := p_unit_cost;
    update products set unit_cost = p_unit_cost where sku = p_sku;
  end if;

  if coalesce(v_cost, 0) > 0 then
    insert into expenses (kind, description, amount, method, spent_on, source, batch_id)
    values ('stock',
            format('%s × %s (lot %s)', p_qty, v_name, p_batch_no),
            round(v_cost * p_qty, 2), p_method,
            (now() at time zone 'Asia/Manila')::date, 'receiving', v_batch);
  end if;

  return v_batch;
end;
$$;

-- ---------------------------------------------------------------------------
-- Moving stock: between pools at one shop, and between shops
-- ---------------------------------------------------------------------------
create or replace function move_stock(
  p_batch bigint, p_from text, p_to text, p_qty int, p_reason text default 'transfer',
  p_branch bigint default null
) returns void
language plpgsql security definer as $$
declare s stock%rowtype; v_branch bigint;
begin
  if p_from = 'reserve' then
    perform require_role('admin');
  else
    perform require_role('admin','warehouse');
  end if;
  if p_qty <= 0 then raise exception 'quantity must be more than zero'; end if;
  if p_from = p_to then raise exception 'those are the same pool'; end if;

  v_branch := branch_or_default(p_branch);

  select * into s from stock
   where batch_id = p_batch and pool = p_from and branch_id = v_branch for update;
  if not found or s.on_hand - s.committed < p_qty then
    raise exception 'NOT_ENOUGH_STOCK: that batch has fewer than % free unit(s) in %',
      p_qty, p_from using errcode = 'P0002';
  end if;

  update stock set on_hand = on_hand - p_qty
   where batch_id = p_batch and pool = p_from and branch_id = v_branch;
  insert into stock (batch_id, pool, branch_id, on_hand)
  values (p_batch, p_to, v_branch, p_qty)
  on conflict (batch_id, pool, branch_id) do update
    set on_hand = stock.on_hand + excluded.on_hand;

  insert into movements (batch_id, from_pool, to_pool, qty, reason, branch_id)
  values (p_batch, p_from, p_to, p_qty,
          case when p_from = 'reserve' then 'reserve released' else p_reason end,
          v_branch);
end;
$$;

-- Sending stock to another shop. The pool does not change — what was on the
-- shelf here is on the shelf there — and it lands as two movements so each
-- branch's journal reads as its own account of the day.
create or replace function transfer_stock(
  p_batch bigint, p_pool text, p_from_branch bigint, p_to_branch bigint, p_qty int
) returns void
language plpgsql security definer as $$
declare s stock%rowtype; v_from text; v_to text;
begin
  perform require_role('admin','warehouse');
  if p_qty <= 0 then raise exception 'quantity must be more than zero'; end if;
  if p_from_branch = p_to_branch then
    raise exception 'That is the same branch.';
  end if;

  select name into v_from from branches where id = p_from_branch;
  if not found then raise exception 'No such branch to send from.'; end if;
  select name into v_to from branches where id = p_to_branch and active;
  if not found then raise exception 'That branch is not open.'; end if;

  select * into s from stock
   where batch_id = p_batch and pool = p_pool and branch_id = p_from_branch for update;
  if not found or s.on_hand - s.committed < p_qty then
    raise exception 'NOT_ENOUGH_STOCK: % has fewer than % free unit(s) of that batch in %',
      v_from, p_qty, p_pool using errcode = 'P0002';
  end if;

  update stock set on_hand = on_hand - p_qty
   where batch_id = p_batch and pool = p_pool and branch_id = p_from_branch;
  insert into stock (batch_id, pool, branch_id, on_hand)
  values (p_batch, p_pool, p_to_branch, p_qty)
  on conflict (batch_id, pool, branch_id) do update
    set on_hand = stock.on_hand + excluded.on_hand;

  insert into movements (batch_id, from_pool, qty, reason, branch_id)
  values (p_batch, p_pool, p_qty, 'sent to ' || v_to, p_from_branch);
  insert into movements (batch_id, to_pool, qty, reason, branch_id)
  values (p_batch, p_pool, p_qty, 'came from ' || v_from, p_to_branch);
end;
$$;

-- ---------------------------------------------------------------------------
-- Placing an order — the picking loop, now looking at one shop's shelves
-- ---------------------------------------------------------------------------
create or replace function place_order(
  p_channel text, p_lines jsonb, p_reseller bigint default null,
  p_branch bigint default null
) returns bigint
language plpgsql security definer as $$
declare
  v_pool     text;
  v_order    bigint;
  line       record;
  row_       record;
  v_wanted   int;
  v_take     int;
  v_price    numeric(12,2);
  v_cost     numeric(12,2);
  v_subtotal numeric(12,2) := 0;
  v_cutoff   date;
  v_branch   bigint;
begin
  if p_channel = 'b2b' then
    perform require_role('admin','reseller');
    if current_role_name() = 'reseller'
       and p_reseller is distinct from current_reseller() then
      raise exception 'FORBIDDEN: an account may only order for itself'
        using errcode = '42501';
    end if;
    v_pool := 'b2b';
    perform check_can_order(p_reseller, (
      select coalesce(sum((l ->> 'qty')::int
             * (select wholesale_price from products where sku = l ->> 'sku')), 0)
        from jsonb_array_elements(p_lines) l));
  elsif p_channel = 'shop' then
    perform require_role('admin','cashier');
    v_pool := 'shop';
  else
    raise exception 'unknown channel %', p_channel;
  end if;

  v_branch := branch_or_default(p_branch);
  if not exists (select 1 from branches where id = v_branch and active) then
    raise exception 'That branch is not open.';
  end if;

  insert into orders (channel, reseller_id, branch_id)
  values (p_channel, p_reseller, v_branch)
  returning id into v_order;

  for line in
    select l ->> 'sku' as sku, (l ->> 'qty')::int as qty
      from jsonb_array_elements(p_lines) l
     order by l ->> 'sku'
  loop
    if line.qty is null or line.qty <= 0 then
      raise exception 'quantity must be more than zero for %', line.sku;
    end if;

    if not exists (select 1 from products where sku = line.sku and active) then
      raise exception 'no active product with code %', line.sku;
    end if;
    v_price := effective_price(line.sku, p_channel);
    select unit_cost into v_cost from products where sku = line.sku;

    v_cutoff := earliest_usable_expiry(v_pool, line.sku);
    v_wanted := line.qty;

    -- Oldest first, and only from the shelves of the shop being served.
    for row_ in
      select s.id, s.on_hand, s.committed, s.batch_id
        from stock s
        join batches b on b.id = s.batch_id
       where s.pool = v_pool and s.branch_id = v_branch
         and b.sku = line.sku and b.expiry > v_cutoff
       order by b.expiry, b.id
         for update of s
    loop
      exit when v_wanted <= 0;
      v_take := least(row_.on_hand - row_.committed, v_wanted);
      if v_take > 0 then
        update stock set committed = committed + v_take where id = row_.id;
        insert into order_lines (order_id, sku, batch_id, qty, unit_price, unit_cost)
        values (v_order, line.sku, row_.batch_id, v_take, v_price, v_cost);
        v_wanted := v_wanted - v_take;
      end if;
    end loop;

    if v_wanted > 0 then
      raise exception 'NOT_ENOUGH_STOCK: % is short % unit(s)', line.sku, v_wanted
        using errcode = 'P0002';
    end if;

    v_subtotal := v_subtotal + v_price * line.qty;
  end loop;

  update orders set subtotal = v_subtotal, total = v_subtotal where id = v_order;

  if p_channel = 'b2b' then
    perform raise_invoice(v_order);
  end if;
  return v_order;
end;
$$;

-- ---------------------------------------------------------------------------
-- Everything downstream of an order takes the branch from the order itself.
-- Nobody passes it twice, so nobody can pass it differently.
-- ---------------------------------------------------------------------------
create or replace function fulfil_order(p_order bigint) returns void
language plpgsql security definer as $$
declare o orders%rowtype; line record; v_pool text;
begin
  perform require_role('admin','warehouse','cashier');
  select * into o from orders where id = p_order for update;
  if not found then raise exception 'no such order (%)', p_order; end if;
  if o.status not in ('placed','picking') then
    raise exception 'that order is already %', o.status;
  end if;
  if o.channel = 'b2b' then perform check_can_ship(p_order); end if;

  v_pool := o.channel;
  for line in
    select batch_id, sum(qty) as qty from order_lines
     where order_id = p_order group by batch_id order by batch_id
  loop
    update stock set on_hand = on_hand - line.qty, committed = committed - line.qty
     where batch_id = line.batch_id and pool = v_pool and branch_id = o.branch_id;
    insert into movements (batch_id, from_pool, qty, reason, branch_id)
    values (line.batch_id, v_pool, line.qty,
            case when o.channel = 'b2b' then 'shipped' else 'sold' end, o.branch_id);
  end loop;

  update orders set status = 'fulfilled' where id = p_order;
end;
$$;

create or replace function cancel_order(p_order bigint) returns void
language plpgsql security definer as $$
declare o orders%rowtype; line record;
begin
  perform require_role('admin','warehouse','cashier','reseller');
  select * into o from orders where id = p_order for update;
  if not found then raise exception 'no such order (%)', p_order; end if;
  if current_role_name() = 'reseller' and o.reseller_id is distinct from current_reseller() then
    raise exception 'FORBIDDEN: that is not your order' using errcode = '42501';
  end if;
  if o.status not in ('placed','picking') then
    raise exception 'that order is already % and cannot be cancelled', o.status;
  end if;

  for line in
    select batch_id, sum(qty) as qty from order_lines
     where order_id = p_order group by batch_id order by batch_id
  loop
    update stock set committed = committed - line.qty
     where batch_id = line.batch_id and pool = o.channel and branch_id = o.branch_id;
  end loop;

  update orders set status = 'cancelled' where id = p_order;
  update invoices set status = 'void'
   where order_id = p_order and status = 'open' and paid = 0;
end;
$$;

-- ---------------------------------------------------------------------------
-- The till, at the shop it is standing in
-- ---------------------------------------------------------------------------
create or replace function sell(
  p_lines jsonb, p_method text, p_tendered numeric default null,
  p_branch bigint default null
) returns jsonb
language plpgsql security definer as $$
declare
  v_order  bigint;
  v_total  numeric(12,2);
  v_change numeric(12,2);
  v_receipt text;
  v_sku    text;
  v_left   int;
  v_min    int;
  v_branch bigint;
begin
  perform require_role('admin','cashier');
  if p_method not in ('cash','gcash','card') then
    raise exception 'payment must be cash, gcash or card';
  end if;

  v_branch := branch_or_default(p_branch);
  v_order := place_order('shop', p_lines, null, v_branch);
  perform fulfil_order(v_order);
  select total into v_total from orders where id = v_order;

  if p_method = 'cash' then
    if p_tendered is null or p_tendered < v_total then
      raise exception 'SHORT_PAYMENT: % handed over for a % sale',
        coalesce(p_tendered, 0)::numeric(12,2), v_total using errcode = 'P0006';
    end if;
    v_change := p_tendered - v_total;
  else
    p_tendered := v_total;
    v_change := 0;
  end if;

  v_receipt := 'OR-' || to_char(now() at time zone 'Asia/Manila', 'YYYYMMDD')
               || '-' || lpad(nextval('receipt_counter')::text, 5, '0');
  insert into sales (order_id, receipt_no, method, total, tendered, change_due)
  values (v_order, v_receipt, p_method, v_total, p_tendered, v_change);

  -- A thin shelf is a fact about one shop, so the count that raises the task
  -- only looks at the shop that just sold.
  for v_sku in select distinct l ->> 'sku' from jsonb_array_elements(p_lines) l loop
    select coalesce(sum(s.on_hand - s.committed), 0)::int, max(p.shelf_min)
      into v_left, v_min
      from products p
      left join batches b on b.sku = p.sku and b.expiry > current_date
      left join stock s on s.batch_id = b.id and s.pool = 'shop'
                       and s.branch_id = v_branch
     where p.sku = v_sku group by p.sku;
    if v_left <= coalesce(v_min, 0) then
      perform raise_restock(v_sku,
        format('shelf down to %s after receipt %s', v_left, v_receipt));
    end if;
  end loop;

  return jsonb_build_object(
    'receipt_no', v_receipt, 'order_id', v_order, 'total', v_total,
    'method', p_method, 'tendered', p_tendered, 'change', v_change,
    'cashier', current_actor(), 'at', now(),
    'branch', (select name from branches where id = v_branch),
    'lines', (select jsonb_agg(jsonb_build_object(
                'sku', ol.sku, 'name', p.name, 'qty', ol.qty,
                'unit_price', ol.unit_price, 'batch_no', b.batch_no) order by ol.id)
                from order_lines ol
                join products p on p.sku = ol.sku
                join batches b on b.id = ol.batch_id
               where ol.order_id = v_order));
end;
$$;

-- ---------------------------------------------------------------------------
-- The edges: testers, breakages, returns, expiry, counts
-- ---------------------------------------------------------------------------
create or replace function log_shrinkage(
  p_sku text, p_batch bigint, p_qty int, p_reason text, p_signed_by text,
  p_branch bigint default null
) returns void
language plpgsql security definer as $$
declare s stock%rowtype; v_branch bigint;
begin
  perform require_role('admin','cashier');
  if p_reason not in ('tester','damaged') then
    raise exception 'reason must be tester or damaged';
  end if;

  v_branch := branch_or_default(p_branch);
  select * into s from stock
   where batch_id = p_batch and pool = 'shop' and branch_id = v_branch for update;
  if not found or s.on_hand - s.committed < p_qty then
    raise exception 'NOT_ENOUGH_STOCK: fewer than % free unit(s) on the shelf', p_qty
      using errcode = 'P0002';
  end if;

  update stock set on_hand = on_hand - p_qty
   where batch_id = p_batch and pool = 'shop' and branch_id = v_branch;
  insert into movements (batch_id, from_pool, qty, reason, branch_id)
  values (p_batch, 'shop', p_qty, p_reason, v_branch);
  insert into shrinkage (sku, batch_id, qty, reason, signed_by)
  values (p_sku, p_batch, p_qty, p_reason, p_signed_by);
end;
$$;

-- A return goes back to the shelf it came off, which the order remembers.
create or replace function decide_return(
  p_id bigint, p_approve boolean, p_outcome text default 'restock') returns void
language plpgsql security definer as $$
declare r returns%rowtype; v_branch bigint;
begin
  perform require_role('admin');
  select * into r from returns where id = p_id for update;
  if not found then raise exception 'no such return (%)', p_id; end if;
  if r.status <> 'pending' then raise exception 'that return is already %', r.status; end if;

  if not p_approve then
    update returns set status = 'rejected', decided_by = current_actor(), decided_at = now()
     where id = p_id;
    return;
  end if;

  if p_outcome not in ('restock','damaged','tester') then
    raise exception 'outcome must be restock, damaged or tester';
  end if;

  if p_outcome = 'restock' then
    select coalesce(o.branch_id, default_branch()) into v_branch
      from returns rr left join orders o on o.id = rr.order_id where rr.id = p_id;

    insert into stock (batch_id, pool, branch_id, on_hand)
    values (r.batch_id, 'shop', v_branch, r.qty)
    on conflict (batch_id, pool, branch_id) do update
      set on_hand = stock.on_hand + excluded.on_hand;
    insert into movements (batch_id, to_pool, qty, reason, branch_id)
    values (r.batch_id, 'shop', r.qty, 'returned to shelf', v_branch);
  else
    insert into shrinkage (sku, batch_id, qty, reason, signed_by)
    values (r.sku, r.batch_id, r.qty, p_outcome, current_actor());
  end if;

  update returns set status = 'approved', outcome = p_outcome,
                     decided_by = current_actor(), decided_at = now()
   where id = p_id;
end;
$$;

-- Already row-by-row, so it was never ambiguous; it only needed to say where
-- each write-off happened, and to be able to sweep one shop at a time.
create or replace function write_off_expired(
  p_batch bigint default null, p_branch bigint default null) returns int
language plpgsql security definer as $$
declare r record; v_units int := 0;
begin
  perform require_role('admin','warehouse');
  for r in
    select s.id, s.batch_id, s.pool, s.branch_id, s.on_hand - s.committed as qty
      from stock s join batches b on b.id = s.batch_id
     where b.expiry <= current_date and s.on_hand - s.committed > 0
       and (p_batch is null or s.batch_id = p_batch)
       and (p_branch is null or s.branch_id = p_branch)
       for update of s
  loop
    update stock set on_hand = on_hand - r.qty where id = r.id;
    insert into movements (batch_id, from_pool, qty, reason, branch_id)
    values (r.batch_id, r.pool, r.qty, 'expired', r.branch_id);
    v_units := v_units + r.qty;
  end loop;
  return v_units;
end;
$$;

-- Counting a shelf is counting one shop's shelf. Counting them all together
-- and calling the difference a variance would be arithmetic about nowhere.
create or replace function record_stock_count(
  p_sku text, p_counted int, p_branch bigint default null) returns stock_counts
language plpgsql security definer as $$
declare v_system int; v_branch bigint; out_ stock_counts;
begin
  perform require_role('admin','warehouse');
  v_branch := branch_or_default(p_branch);

  select coalesce(sum(s.on_hand), 0)::int into v_system
    from batches b join stock s on s.batch_id = b.id
   where b.sku = p_sku and s.branch_id = v_branch;

  insert into stock_counts (sku, counted, on_system, variance, branch_id)
  values (p_sku, p_counted, v_system, p_counted - v_system, v_branch)
  returning * into out_;
  return out_;
end;
$$;

-- ---------------------------------------------------------------------------
-- Reading, per shop
--
-- The totals that were true before are still true: they are the whole
-- business, summed across every branch, which is what an owner wants from a
-- catalogue screen. What is new is being able to ask the same question of one
-- shop.
-- ---------------------------------------------------------------------------
create or replace view branch_stock as
select br.id as branch_id, br.name as branch, p.sku, p.name, p.category,
       coalesce(sum(s.on_hand) filter (where s.pool = 'b2b'), 0)::int as b2b,
       coalesce(sum(s.on_hand) filter (where s.pool = 'shop'), 0)::int as shop,
       coalesce(sum(s.on_hand) filter (where s.pool = 'reserve'), 0)::int as reserve,
       coalesce(sum(s.on_hand - s.committed) filter (where s.pool = 'b2b'), 0)::int as free_b2b,
       coalesce(sum(s.on_hand - s.committed) filter (where s.pool = 'shop'), 0)::int as free_shop,
       coalesce(sum(s.on_hand - s.committed) filter (where s.pool = 'reserve'), 0)::int
         as free_reserve,
       coalesce(sum(s.on_hand), 0)::int as total
  from branches br
  cross join products p
  left join batches b on b.sku = p.sku and b.expiry > current_date
  left join stock s on s.batch_id = b.id and s.branch_id = br.id
 where p.active and br.active
 group by br.id, br.name, p.sku, p.name, p.category
having coalesce(sum(s.on_hand), 0) > 0
 order by br.name, p.name;

-- A batch can now be in two places, so its detail says where. The columns it
-- already had keep their names and order — a view cannot rename one in place,
-- and every screen reading it would break if it could.
create or replace view batch_detail as
select b.id as batch_id, b.sku, p.name, b.batch_no, b.expiry, b.qty_received, b.received_at,
       (b.expiry - current_date)                       as days_left,
       b.expiry <= current_date                        as expired,
       b.expiry > current_date
         and b.expiry <= current_date + 180            as ageing,
       b.expiry <= (current_date
         + make_interval(months => p.reseller_floor_months))::date as below_reseller_floor,
       coalesce(sum(s.on_hand - s.committed) filter (where s.pool = 'b2b'), 0)::int     as free_b2b,
       coalesce(sum(s.on_hand - s.committed) filter (where s.pool = 'shop'), 0)::int    as free_shop,
       coalesce(sum(s.on_hand - s.committed) filter (where s.pool = 'reserve'), 0)::int as free_reserve,
       s.branch_id, br.name as branch
  from batches b
  join products p on p.sku = b.sku
  left join stock s on s.batch_id = b.id
  left join branches br on br.id = s.branch_id
 group by b.id, b.sku, p.name, p.reseller_floor_months, s.branch_id, br.name;

-- Takings, split by shop.
create or replace view takings_by_branch as
select br.id as branch_id, br.name as branch,
       (s.at at time zone 'Asia/Manila')::date as business_date,
       count(*)::int as sales,
       coalesce(sum(s.total), 0) as revenue
  from sales s
  join orders o on o.id = s.order_id
  join branches br on br.id = o.branch_id
 group by br.id, br.name, (s.at at time zone 'Asia/Manila')::date
 order by business_date desc, br.name;

grant select on branch_stock, takings_by_branch to app_client;

-- ---------------------------------------------------------------------------
-- Access
-- ---------------------------------------------------------------------------
drop function if exists receive_stock(text, text, date, int, numeric, text);
drop function if exists move_stock(bigint, text, text, int, text);
drop function if exists place_order(text, jsonb, bigint);
drop function if exists sell(jsonb, text, numeric);
drop function if exists log_shrinkage(text, bigint, int, text, text);
drop function if exists write_off_expired(bigint);
drop function if exists record_stock_count(text, int);

do $grants$
declare f text;
begin
  foreach f in array array[
    'receive_stock(text, text, date, int, numeric, text, bigint)',
    'move_stock(bigint, text, text, int, text, bigint)',
    'transfer_stock(bigint, text, bigint, bigint, int)',
    'place_order(text, jsonb, bigint, bigint)',
    'sell(jsonb, text, numeric, bigint)',
    'fulfil_order(bigint)',
    'cancel_order(bigint)',
    'log_shrinkage(text, bigint, int, text, text, bigint)',
    'decide_return(bigint, boolean, text)',
    'write_off_expired(bigint, bigint)',
    'record_stock_count(text, int, bigint)',
    'default_branch()'
  ] loop
    execute format('alter function %s set search_path = public, extensions', f);
    execute format('revoke all on function %s from public', f);
    execute format('grant execute on function %s to app_client', f);
  end loop;
end
$grants$;
