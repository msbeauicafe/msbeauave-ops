-- ============================================================================
-- MS BEAU AVE — a cancelled order says why
--
-- cancel_purchase_order used to take nothing but the order's own number, and
-- the pending list dropped a cancelled order the moment it happened — the
-- same as it never existed. Now cancelling asks why, the way voiding an
-- expense already does, and the order stays visible with that reason
-- against it instead of quietly disappearing.
-- ============================================================================

alter table purchase_orders add column if not exists cancel_reason text;

-- Cancelling asked for no reason until now, and a handful of orders were
-- already cancelled under that rule. They keep their place on the list
-- rather than being made to look unexplained.
update purchase_orders set cancel_reason = 'Cancelled before a reason was required.'
 where status = 'cancelled' and cancel_reason is null;

alter table purchase_orders drop constraint if exists po_cancelled_says_why;
alter table purchase_orders add constraint po_cancelled_says_why
  check (status <> 'cancelled' or cancel_reason is not null);

drop function if exists cancel_purchase_order(bigint);

create or replace function cancel_purchase_order(p_po bigint, p_reason text) returns void
language plpgsql security definer as $$
begin
  -- 'datacoord' sits here because 073_data_coordinator.sql widened the old
  -- one-argument version to it; dropping and recreating the function would
  -- otherwise quietly lose that grant.
  perform require_role('admin', 'warehouse', 'datacoord', 'office');
  if length(btrim(coalesce(p_reason, ''))) = 0 then
    raise exception 'Why is this order being cancelled?';
  end if;
  update purchase_orders set status = 'cancelled', cancel_reason = btrim(p_reason)
   where id = p_po and status in ('open', 'part');
  if not found then
    raise exception 'That purchase order is already closed or cancelled.';
  end if;
end;
$$;

alter function cancel_purchase_order(bigint, text) set search_path = public, extensions;
grant execute on function cancel_purchase_order(bigint, text) to app_client;
