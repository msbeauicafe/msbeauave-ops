-- A reseller's order from the portal used to raise its invoice the moment it
-- was placed (db/157 kept that for the portal alone), so it landed straight
-- on Customer order's Invoice tab. The owner wants it on Pending customer
-- order first, like every other order: placed and holding its stock, and
-- invoiced only when the office presses Invoice there. place_order is the
-- same as db/157's in every other line; only the reseller's on-the-spot
-- raise_invoice is gone.

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

  -- No invoice here for anybody, a reseller on the portal included: the
  -- order waits on Pending customer order, and the invoice is raised when
  -- the office presses Invoice there (commit_order).

  return v_order;
end;
$$;
alter function place_order(text, jsonb, bigint, bigint) set search_path = public, extensions;
