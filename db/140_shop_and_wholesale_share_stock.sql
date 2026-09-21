-- ============================================================================
-- MS BEAU AVE — the till and a reseller now sell off the same shelf
--
-- 139 stopped receiving from splitting a delivery across wholesale, shop and
-- reserve automatically — everything landed in shop, and wholesale stayed at
-- zero until somebody moved stock there on purpose. In practice nobody was
-- doing that: a fresh delivery reads as unavailable to every reseller until
-- a second, manual step happens, and that step was never part of how this
-- shop actually works.
--
-- So shop and wholesale are now one pool, not two. A till sale and a
-- reseller's chat order draw from and compete for the same units, first
-- come first served — the same row, locked the same way, so neither can
-- oversell it. What used to be true only in the b2b pool (available to
-- resellers, protected from the counter) is no longer true of anything by
-- default; reserve is untouched and still needs an owner's release.
--
-- This touches every place that assumed a wholesale order's stock sat in a
-- pool named 'b2b' just because the order's channel is 'b2b':
--   - place_order: both channels now pick from 'shop'; the reseller-floor
--     expiry cutoff is kept, but now keyed off the channel directly rather
--     than a pool that no longer says which channel is buying.
--   - fulfil_order, cancel_order, revise_order: all committed/decremented
--     against 'shop' instead of assuming pool = channel.
--   - b2b_catalog (what a reseller's own catalogue shows as available):
--     reads 'shop' stock now, the same shelf the till sees.
--
-- Each function is taken from its live definition rather than retyped from
-- an old migration, orderdesk's widened role list included — a plain
-- create-or-replace here would otherwise quietly narrow who can call it,
-- the same mistake 073 and 070 exist to avoid repeating.
--
-- free_b2b / committed_b2b (the Product list's "Wholesale" column) still
-- read pool = 'b2b' specifically and will now normally show 0 — that is
-- accurate, not broken: nothing is held there by default any more. Left
-- alone here; worth a follow-up if that reads as confusing rather than
-- correct.
-- ============================================================================

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
    perform require_role('admin', 'orderdesk','reseller');
    if current_role_name() = 'reseller'
       and p_reseller is distinct from current_reseller() then
      raise exception 'FORBIDDEN: an account may only order for itself'
        using errcode = '42501';
    end if;
    v_pool := 'shop';
    perform check_can_order(p_reseller, (
      select coalesce(sum((l ->> 'qty')::int * coalesce(
               price_for(l ->> 'sku', nullif(btrim(coalesce(l ->> 'code', '')), '')),
               (select wholesale_price from products where sku = l ->> 'sku'))), 0)
        from jsonb_array_elements(p_lines) l));
  elsif p_channel = 'shop' then
    perform require_role('admin', 'orderdesk','cashier');
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
    select l ->> 'sku' as sku, (l ->> 'qty')::int as qty,
           nullif(btrim(coalesce(l ->> 'code', '')), '') as code
      from jsonb_array_elements(p_lines) l
     order by l ->> 'sku'
  loop
    if line.qty is null or line.qty <= 0 then
      raise exception 'quantity must be more than zero for %', line.sku;
    end if;

    if not exists (select 1 from products where sku = line.sku and active) then
      raise exception 'no active product with code %', line.sku;
    end if;
    if line.code is null then
      v_price := effective_price(line.sku, p_channel);
    else
      v_price := price_for(line.sku, line.code);
      if v_price is null then
        raise exception 'PRICE_NOT_SET: % has no price under %.', line.sku, line.code;
      end if;
    end if;
    select unit_cost into v_cost from products where sku = line.sku;

    -- The reseller floor is a rule about who is buying, not about which
    -- physical pool the stock now sits in — keyed on the channel directly.
    v_cutoff := earliest_usable_expiry(p_channel, line.sku);
    v_wanted := line.qty;

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
        insert into order_lines (order_id, sku, batch_id, qty, unit_price,
                                 unit_cost, price_code)
        values (v_order, line.sku, row_.batch_id, v_take, v_price, v_cost,
                line.code);
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

create or replace function fulfil_order(p_order bigint) returns void
language plpgsql security definer as $$
declare o orders%rowtype; line record; v_pool text;
begin
  perform require_role('admin', 'orderdesk','warehouse','cashier');
  select * into o from orders where id = p_order for update;
  if not found then raise exception 'no such order (%)', p_order; end if;
  if o.status not in ('placed','picking') then
    raise exception 'that order is already %', o.status;
  end if;
  if o.channel = 'b2b' then perform check_can_ship(p_order); end if;

  v_pool := 'shop';
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
  perform require_role('admin', 'orderdesk','warehouse','cashier','reseller');
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
     where batch_id = line.batch_id and pool = 'shop' and branch_id = o.branch_id;
  end loop;

  update orders set status = 'cancelled' where id = p_order;
  update invoices set status = 'void'
   where order_id = p_order and status = 'open' and paid = 0;
end;
$$;

create or replace function revise_order(p_order bigint, p_lines jsonb)
returns jsonb language plpgsql security definer as $$
declare
  o        orders%rowtype;
  v_inv    invoices%rowtype;
  want     record;
  row_     record;
  v_left   int;
  v_take   int;
  v_price  numeric(12,2);
  v_code   text;
  v_cost   numeric(12,2);
  v_cutoff date;
  v_sub    numeric(12,2);
  v_total  numeric(12,2);
  v_settled numeric(12,2);
begin
  perform require_role('admin', 'orderdesk', 'office');

  select * into o from orders where id = p_order for update;
  if o.id is null then raise exception 'No such order.'; end if;

  if o.status not in ('placed', 'picking') then
    raise exception 'ALREADY_GONE: that order is % — the stock has left the building, so the packing list cannot change it.', o.status;
  end if;

  select * into v_inv from invoices where order_id = p_order for update;
  if v_inv.id is not null and v_inv.status = 'void' then
    raise exception 'That invoice was voided. Raise a new one rather than editing it.';
  end if;

  if coalesce((select sum(greatest((x ->> 'qty')::int, 0))
                 from jsonb_array_elements(coalesce(p_lines, '[]'::jsonb)) x), 0) <= 0 then
    raise exception 'NOTHING_LEFT: an order with nothing in it is a cancellation. Cancel it on the order itself.';
  end if;

  for want in
    with asked as (
      select btrim(x ->> 'sku') as sku,
             sum(greatest(coalesce((x ->> 'qty')::int, 0), 0))::int as qty
        from jsonb_array_elements(coalesce(p_lines, '[]'::jsonb)) x
       where btrim(coalesce(x ->> 'sku', '')) <> ''
       group by 1
    ),
    held as (
      select sku, sum(qty)::int as qty
        from order_lines where order_id = p_order group by 1
    )
    select coalesce(a.sku, h.sku)  as sku,
           coalesce(a.qty, 0)::int as wanted,
           coalesce(h.qty, 0)::int as picked
      from asked a
      full join held h on h.sku = a.sku
     order by 1
  loop
    continue when want.wanted = want.picked;

    if want.wanted < want.picked then
      v_left := want.picked - want.wanted;
      for row_ in
        select l.id, l.qty, l.batch_id
          from order_lines l
          join batches b on b.id = l.batch_id
         where l.order_id = p_order and l.sku = want.sku
         order by b.expiry desc, b.id desc
           for update of l
      loop
        exit when v_left <= 0;
        v_take := least(row_.qty, v_left);
        update stock set committed = committed - v_take
         where batch_id = row_.batch_id and pool = 'shop'
           and branch_id = o.branch_id;
        if v_take = row_.qty then
          delete from order_lines where id = row_.id;
        else
          update order_lines set qty = qty - v_take where id = row_.id;
        end if;
        v_left := v_left - v_take;
      end loop;
      continue;
    end if;

    if not exists (select 1 from products where sku = want.sku and active) then
      raise exception 'NO_SUCH_PRODUCT: there is no product with code %.', want.sku;
    end if;

    select unit_price, price_code into v_price, v_code
      from order_lines where order_id = p_order and sku = want.sku limit 1;
    if v_price is null then
      v_price := effective_price(want.sku, o.channel);
      v_code  := null;
    end if;
    select unit_cost into v_cost from products where sku = want.sku;

    v_cutoff := earliest_usable_expiry(o.channel, want.sku);
    v_left   := want.wanted - want.picked;

    for row_ in
      select s.id, s.on_hand, s.committed, s.batch_id
        from stock s
        join batches b on b.id = s.batch_id
       where s.pool = 'shop' and s.branch_id = o.branch_id
         and b.sku = want.sku and b.expiry > v_cutoff
       order by b.expiry, b.id
         for update of s
    loop
      exit when v_left <= 0;
      v_take := least(row_.on_hand - row_.committed, v_left);
      if v_take > 0 then
        update stock set committed = committed + v_take where id = row_.id;
        update order_lines set qty = qty + v_take
         where order_id = p_order and sku = want.sku and batch_id = row_.batch_id;
        if not found then
          insert into order_lines (order_id, sku, batch_id, qty, unit_price,
                                   unit_cost, price_code)
          values (p_order, want.sku, row_.batch_id, v_take, v_price, v_cost, v_code);
        end if;
        v_left := v_left - v_take;
      end if;
    end loop;

    if v_left > 0 then
      raise exception 'NOT_ENOUGH_STOCK: % is short % unit(s) of what the sheet asks for.',
        want.sku, v_left using errcode = 'P0002';
    end if;
  end loop;

  select coalesce(sum(qty * unit_price), 0) into v_sub
    from order_lines where order_id = p_order;
  v_total := v_sub + o.shipping + o.others;

  update orders set subtotal = v_sub, total = v_total where id = p_order;

  if v_inv.id is not null then
    v_settled := v_inv.paid + v_inv.discount;
    if v_total < v_settled then
      raise exception 'REVISED_BELOW_PAID: that comes to %, and % has already been settled against this invoice.',
        to_char(v_total, 'FM999,999,990.00'), to_char(v_settled, 'FM999,999,990.00');
    end if;
    update invoices
       set amount = v_total,
           status = case when v_total <= v_settled then 'paid' else 'open' end,
           settled_on = case when v_total <= v_settled
                             then coalesce(settled_on, current_date) end
     where id = v_inv.id;
  end if;

  return jsonb_build_object(
    'order_id', p_order, 'invoice_id', v_inv.id, 'si_no', v_inv.si_no,
    'pl_no', o.pl_no, 'subtotal', v_sub, 'total', v_total);
end $$;

alter function place_order(text, jsonb, bigint, bigint) set search_path = public, extensions;
alter function fulfil_order(bigint) set search_path = public, extensions;
alter function cancel_order(bigint) set search_path = public, extensions;
alter function revise_order(bigint, jsonb) set search_path = public, extensions;

create or replace view b2b_catalog as
select p.sku, p.name, p.brand, p.category, p.wholesale_price, p.srp,
       coalesce(sum(s.on_hand - s.committed), 0)::int as available,
       p.unit_type,
       (select coalesce(jsonb_object_agg(c.code, pp.price + c.adjust), '{}'::jsonb)
          from price_codes c
          join product_prices pp
            on pp.sku = p.sku
           and pp.code = coalesce(c.base_code, c.code)
         where c.active
           and (c.base_code is null or c.adjust <> 0)) as prices
  from products p
  left join batches b
    on b.sku = p.sku
   and b.expiry > (current_date + make_interval(months => p.reseller_floor_months))::date
  left join stock s on s.batch_id = b.id and s.pool = 'shop'
 where p.active
 group by p.sku, p.name, p.brand, p.category, p.wholesale_price, p.srp, p.unit_type;

grant select on b2b_catalog to app_client;
