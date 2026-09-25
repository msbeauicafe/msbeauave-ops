-- Setting a stalled order aside on Draft left its stock committed the whole
-- time it sat there — 141 did that on purpose, so a Draft order could not
-- quietly sell out from under itself. In practice the owner wants the
-- opposite: Draft is for an order that is not going anywhere soon, so its
-- reserved stock should go back to what Internal Inventory Report counts
-- as available, the same way cancelling one already does. Restoring it
-- re-commits the same batches; if another order has since taken that stock,
-- restoring is refused rather than left half-done.

create or replace function park_order(p_order bigint) returns void
language plpgsql security definer as $$
declare o orders%rowtype; line record;
begin
  perform require_role('admin', 'orderdesk', 'warehouse');
  select * into o from orders where id = p_order for update;
  if not found then raise exception 'no such order (%)', p_order; end if;
  if o.status not in ('placed', 'picking') then
    raise exception 'that order is already % and cannot be parked', o.status;
  end if;
  if o.parked_at is not null then
    raise exception 'that order is already on Draft';
  end if;

  for line in
    select batch_id, sum(qty) as qty from order_lines
     where order_id = p_order group by batch_id order by batch_id
  loop
    update stock set committed = committed - line.qty
     where batch_id = line.batch_id and pool = 'shop' and branch_id = o.branch_id;
  end loop;

  update orders set parked_at = now() where id = p_order;
end;
$$;
alter function park_order(bigint) set search_path = public, extensions;

create or replace function unpark_order(p_order bigint) returns void
language plpgsql security definer as $$
declare o orders%rowtype; line record; v_have int;
begin
  perform require_role('admin', 'orderdesk', 'warehouse');
  select * into o from orders where id = p_order for update;
  if not found then raise exception 'no such order (%)', p_order; end if;
  if o.parked_at is null then
    raise exception 'that order is not on Draft';
  end if;

  for line in
    select batch_id, sku, sum(qty) as qty from order_lines
     where order_id = p_order group by batch_id, sku order by batch_id
  loop
    select on_hand - committed into v_have from stock
     where batch_id = line.batch_id and pool = 'shop' and branch_id = o.branch_id
       for update;
    if coalesce(v_have, 0) < line.qty then
      raise exception 'NOT_ENOUGH_STOCK: % is short % unit(s)',
        line.sku, line.qty - coalesce(v_have, 0)
        using errcode = 'P0002';
    end if;
    update stock set committed = committed + line.qty
     where batch_id = line.batch_id and pool = 'shop' and branch_id = o.branch_id;
  end loop;

  update orders set parked_at = null where id = p_order;
end;
$$;
alter function unpark_order(bigint) set search_path = public, extensions;
