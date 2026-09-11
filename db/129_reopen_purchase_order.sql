-- ============================================================================
-- MS BEAU AVE — un-cancelling a purchase order
--
-- cancel_purchase_order only ever went one way. A Committed / Cancelled pair
-- on the order form needs both directions to mean anything: Cancelled asks
-- why and cancels, same as before; Committed, on an order that is currently
-- cancelled, puts it back to open. cancel_reason clears on the way back —
-- if it is cancelled again, that is a fresh reason, not the old one.
-- ============================================================================

create or replace function reopen_purchase_order(p_po bigint) returns void
language plpgsql security definer as $$
begin
  perform require_role('admin', 'warehouse', 'datacoord', 'office');
  update purchase_orders set status = 'open', cancel_reason = null
   where id = p_po and status = 'cancelled';
  if not found then
    raise exception 'That purchase order is not cancelled.';
  end if;
end;
$$;

alter function reopen_purchase_order(bigint) set search_path = public, extensions;
grant execute on function reopen_purchase_order(bigint) to app_client;
