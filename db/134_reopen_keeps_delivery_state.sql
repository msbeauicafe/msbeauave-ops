-- ============================================================================
-- MS BEAU AVE — reopening does not forget what already arrived
--
-- reopen_purchase_order always put a cancelled order straight back to 'open',
-- whether or not anything had ever been received against its lines. 'open' is
-- also the one status revise_purchase_order will touch — it deletes every
-- line and reinserts fresh ones from whatever is on the form, which does not
-- carry `received`/`lackings` along. Reopen a partly-delivered order, save
-- any small edit, and the delivery this order already has on file quietly
-- disappears from the line while the batch and the stock it created stay put
-- — the two records fall out of step.
--
-- The fix is not to block reopening; it is to land it on the status a
-- partly-delivered order is already supposed to carry, the same one
-- receive_po_line itself would set: 'open' only if nothing has arrived yet,
-- 'part' if some has and some is still short, 'closed' if all of it has.
-- ============================================================================

create or replace function reopen_purchase_order(p_po bigint) returns void
language plpgsql security definer as $$
declare v_received int; v_short int;
begin
  perform require_role('admin', 'warehouse', 'datacoord', 'office');

  select coalesce(sum(received), 0), coalesce(sum(greatest(qty - received, 0)), 0)
    into v_received, v_short
    from purchase_order_lines where po_id = p_po;

  update purchase_orders
     set status = case
                     when v_received = 0 then 'open'
                     when v_short = 0 then 'closed'
                     else 'part'
                   end,
         cancel_reason = null
   where id = p_po and status = 'cancelled';
  if not found then
    raise exception 'That purchase order is not cancelled.';
  end if;
end;
$$;

alter function reopen_purchase_order(bigint) set search_path = public, extensions;
